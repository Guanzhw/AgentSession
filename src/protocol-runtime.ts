import type { ProviderAdapter } from "./providers/interface.js";
import {
  finalizeSessionProtocol,
  type EventCategory,
  type ProtocolCapabilities,
  type ProtocolDiagnostic,
  type SessionEventEnvelope,
  type SessionProtocol,
  type SessionRef
} from "./providers/shared/session-protocol.js";

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 200;
const DEFAULT_GRAPH_NODES = 100;
const MAX_GRAPH_NODES = 300;
const MAX_GRAPH_DEPTH = 3;
const MAX_CACHE_ENTRIES = 256;

interface CachedProtocol {
  revision: string;
  protocol: SessionProtocol;
}

const protocolCache = new Map<string, CachedProtocol>();

export class ProtocolRuntimeError extends Error {
  constructor(
    public readonly code: "session_not_found" | "protocol_unavailable" | "invalid_input",
    message: string
  ) {
    super(message);
    this.name = "ProtocolRuntimeError";
  }
}

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ProtocolRuntimeError("invalid_input", `${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function sessionRevision(adapter: ProviderAdapter, session: Record<string, unknown>): string {
  let providerRevision = "";
  try {
    const value = adapter.getStatsRevision?.();
    providerRevision = value === undefined ? "" : String(value);
  } catch {
    // A revision is an optimization, never a reason to make the source unreadable.
  }
  return [
    providerRevision,
    String(session.timeUpdated ?? session.time_updated ?? ""),
    String(session.messageCount ?? session.message_count ?? ""),
    String(session.tokenCount ?? session.token_count ?? "")
  ].join("|");
}

function touchCache(key: string, value: CachedProtocol): void {
  protocolCache.delete(key);
  protocolCache.set(key, value);
  while (protocolCache.size > MAX_CACHE_ENTRIES) {
    const oldest = protocolCache.keys().next().value;
    if (oldest === undefined) break;
    protocolCache.delete(oldest);
  }
}

export function clearProtocolRuntimeCache(): void {
  protocolCache.clear();
}

/**
 * Resolve one immutable, validated protocol snapshot. Provider access remains
 * authoritative; the cache only avoids repeating a build for an unchanged
 * provider-owned session revision.
 */
export function getRuntimeProtocol(
  adapter: ProviderAdapter,
  sessionId: string,
  knownSession?: Record<string, unknown> | null
): SessionProtocol {
  const session = knownSession === undefined
    ? adapter.getSession(sessionId) as Record<string, unknown> | null
    : knownSession;
  if (!session || String(session.id || "") !== sessionId) {
    throw new ProtocolRuntimeError("session_not_found", "No provider-stored session matches this reference.");
  }
  if (typeof adapter.getSessionProtocol !== "function") {
    throw new ProtocolRuntimeError("protocol_unavailable", "This provider does not expose a session protocol.");
  }

  const revision = sessionRevision(adapter, session);
  const key = `${adapter.id}\u0000${sessionId}`;
  const cached = protocolCache.get(key);
  if (cached?.revision === revision) {
    touchCache(key, cached);
    return cached.protocol;
  }

  const source = adapter.getSessionProtocol(sessionId);
  if (!source) {
    throw new ProtocolRuntimeError("session_not_found", "No provider-stored protocol matches this session.");
  }
  let protocol: SessionProtocol;
  if (
    source.version === 2
    && source.session
    && source.validation
    && source.completeness
    && Object.isFrozen(source)
  ) {
    protocol = source;
  } else {
    protocol = finalizeSessionProtocol(source, {
      provider: adapter.id,
      session,
      capabilities: adapter.protocolCapabilities,
      revision
    });
  }
  touchCache(key, { revision, protocol });
  return protocol;
}

function capabilityState(capabilities: ProtocolCapabilities | undefined, domain: keyof ProtocolCapabilities) {
  return capabilities?.[domain] || { support: "none" as const, provenance: "derived" as const, details: null };
}

export function summarizeRuntimeProtocol(
  protocol: SessionProtocol,
  capabilities?: ProtocolCapabilities
) {
  const categories: Partial<Record<EventCategory, number>> = {};
  for (const event of protocol.events) {
    const category = event.category || "unknown";
    categories[category] = Number(categories[category] || 0) + 1;
  }
  const activeStates = new Set(["queued", "running", "waiting_input", "blocked"]);
  return {
    version: protocol.version || 1,
    session: protocol.session || null,
    completeness: protocol.completeness || "partial",
    validation: protocol.validation || null,
    counts: {
      events: protocol.events.length,
      relationships: protocol.relationships.length,
      tasks: protocol.tasks.length,
      agentRuns: protocol.agentRuns.length,
      contextArtifacts: protocol.contextArtifacts.length,
      branches: protocol.branches?.length || 0,
      compactions: protocol.events.filter((event) => event.kind === "context.compaction" || event.normalizedKind === "context.compacted").length,
      activeTasks: protocol.tasks.filter((task) => activeStates.has(task.status)).length,
      activeRuns: protocol.agentRuns.filter((run) => activeStates.has(run.status)).length
    },
    categories,
    capabilities: {
      events: capabilityState(capabilities, "sessionEvents"),
      relationships: capabilityState(capabilities, "sessionRelationships"),
      tasks: capabilityState(capabilities, "tasks"),
      runs: capabilityState(capabilities, "agentRuns"),
      context: capabilityState(capabilities, "contextArtifacts"),
      branches: capabilityState(capabilities, "branches")
    },
    latestStructuralEvent: [...protocol.events].reverse().find((event) => (
      event.category !== "message" && event.category !== "reasoning"
    )) || null
  };
}

interface RuntimeEventQuery {
  cursor?: string | null;
  limit?: number | string | null;
  categories?: string[];
  kinds?: string[];
  phases?: string[];
  taskId?: string | null;
  runId?: string | null;
  correlationId?: string | null;
}

function eventFingerprint(query: RuntimeEventQuery): string {
  return JSON.stringify({
    categories: [...(query.categories || [])].sort(),
    kinds: [...(query.kinds || [])].sort(),
    phases: [...(query.phases || [])].sort(),
    taskId: query.taskId || null,
    runId: query.runId || null,
    correlationId: query.correlationId || null
  });
}

function encodeCursor(offset: number, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ offset, fingerprint }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null | undefined, fingerprint: string): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Number.isSafeInteger(value?.offset) || value.offset < 0 || value.fingerprint !== fingerprint) throw new Error("invalid");
    return value.offset;
  } catch {
    throw new ProtocolRuntimeError("invalid_input", "cursor is invalid or does not match the event filters.");
  }
}

export function publicEvent(event: SessionEventEnvelope) {
  return {
    id: event.id,
    sessionId: event.sessionId,
    sequence: event.sequence,
    timestamp: event.timestamp,
    kind: event.kind,
    normalizedKind: event.normalizedKind || event.kind,
    category: event.category || "unknown",
    phase: event.phase || null,
    turnId: event.turnId || null,
    taskId: event.taskId || null,
    runId: event.runId || null,
    parentEventId: event.parentEventId || null,
    correlationId: event.correlationId || null,
    compaction: event.compaction || null,
    provenance: event.provenance
  };
}

export function queryRuntimeEvents(protocol: SessionProtocol, query: RuntimeEventQuery = {}) {
  const allowedCategories = new Set(query.categories || []);
  const allowedKinds = new Set(query.kinds || []);
  const allowedPhases = new Set(query.phases || []);
  const fingerprint = eventFingerprint(query);
  const offset = decodeCursor(query.cursor, fingerprint);
  const limit = clampInteger(query.limit, DEFAULT_EVENT_LIMIT, 1, MAX_EVENT_LIMIT, "limit");
  const filtered = protocol.events.filter((event) => (
    (!allowedCategories.size || allowedCategories.has(event.category || "unknown"))
    && (!allowedKinds.size || allowedKinds.has(event.normalizedKind || event.kind))
    && (!allowedPhases.size || allowedPhases.has(event.phase || ""))
    && (!query.taskId || event.taskId === query.taskId)
    && (!query.runId || event.runId === query.runId)
    && (!query.correlationId || event.correlationId === query.correlationId)
  ));
  const events = filtered.slice(offset, offset + limit).map(publicEvent);
  const nextOffset = offset + events.length;
  return {
    events,
    total: filtered.length,
    nextCursor: nextOffset < filtered.length ? encodeCursor(nextOffset, fingerprint) : null,
    truncated: nextOffset < filtered.length
  };
}

export interface RuntimeGraphNode {
  id: string;
  kind: "session" | "task" | "run" | "artifact" | "branch";
  label: string;
  status: string | null;
  session: SessionRef | null;
  resolution: "resolved" | "missing" | "unavailable";
  provenance: unknown;
  focus?: boolean;
}

export interface RuntimeGraphEdge {
  id: string;
  type: string;
  from: string;
  to: string;
  provenance: unknown;
  inferred: boolean;
}

function sessionNodeId(ref: SessionRef): string {
  return `session:${ref.provider}:${ref.sessionId}`;
}

function entityNodeId(kind: string, sessionId: string, id: string): string {
  return `${kind}:${sessionId}:${id}`;
}

function diagnostic(code: string, message: string): ProtocolDiagnostic {
  return { code, severity: "warning", message: message.slice(0, 240), entity: null, provenance: null };
}

export function buildRuntimeGraph(
  adapter: ProviderAdapter,
  root: SessionProtocol,
  options: { depth?: number | string | null; maxNodes?: number | string | null } = {}
) {
  const depth = clampInteger(options.depth, 1, 0, MAX_GRAPH_DEPTH, "depth");
  const maxNodes = clampInteger(options.maxNodes, DEFAULT_GRAPH_NODES, 10, MAX_GRAPH_NODES, "maxNodes");
  const nodes = new Map<string, RuntimeGraphNode>();
  const edges = new Map<string, RuntimeGraphEdge>();
  const diagnostics: ProtocolDiagnostic[] = [...(root.validation?.errors || []), ...(root.validation?.warnings || [])];
  const sessionCache = new Map<string, any>();
  let truncated = false;

  const storedSession = (ref: SessionRef) => {
    if (ref.provider !== adapter.id) return null;
    const key = `${ref.provider}\u0000${ref.sessionId}`;
    if (!sessionCache.has(key)) sessionCache.set(key, adapter.getSession(ref.sessionId));
    return sessionCache.get(key);
  };

  const addNode = (node: RuntimeGraphNode): boolean => {
    if (nodes.has(node.id)) return true;
    if (nodes.size >= maxNodes) {
      truncated = true;
      return false;
    }
    nodes.set(node.id, node);
    return true;
  };
  const addEdge = (edge: RuntimeGraphEdge): void => {
    if (nodes.has(edge.from) && nodes.has(edge.to)) edges.set(edge.id, edge);
  };

  const rootRef = root.session?.ref || { provider: adapter.id, sessionId: root.sessionId };
  addNode({
    id: sessionNodeId(rootRef), kind: "session", label: root.sessionId,
    status: root.session?.state || null, session: rootRef, resolution: "resolved",
    provenance: root.session?.provenance || null, focus: true
  });

  const seenSessions = new Set<string>();
  const queue: Array<{ protocol: SessionProtocol; level: number }> = [{ protocol: root, level: 0 }];
  while (queue.length && !truncated) {
    const current = queue.shift()!;
    const currentId = current.protocol.sessionId;
    if (seenSessions.has(currentId)) continue;
    seenSessions.add(currentId);

    for (const relation of current.protocol.relationships) {
      if (truncated) break;
      const fromRef = relation.fromRef || { provider: adapter.id, sessionId: relation.fromSessionId };
      const toRef = relation.toRef || { provider: adapter.id, sessionId: relation.toSessionId };
      for (const ref of [fromRef, toRef]) {
        const sameProvider = ref.provider === adapter.id;
        const stored = sameProvider ? storedSession(ref) : null;
        if (!addNode({
          id: sessionNodeId(ref), kind: "session", label: ref.sessionId, status: null,
          session: ref, resolution: stored ? "resolved" : sameProvider ? "missing" : "unavailable",
          provenance: relation.provenance
        })) break;
      }
      if (truncated) break;
      addEdge({
        id: `relationship:${relation.type}:${fromRef.provider}:${fromRef.sessionId}:${toRef.provider}:${toRef.sessionId}`,
        type: relation.type,
        from: sessionNodeId(fromRef),
        to: sessionNodeId(toRef),
        provenance: relation.provenance,
        inferred: relation.provenance.fidelity === "derived"
      });

      if (current.level >= depth) continue;
      for (const ref of [fromRef, toRef]) {
        if (ref.provider !== adapter.id || seenSessions.has(ref.sessionId) || !storedSession(ref)) continue;
        try {
          queue.push({ protocol: getRuntimeProtocol(adapter, ref.sessionId), level: current.level + 1 });
        } catch (error) {
          diagnostics.push(diagnostic("RELATED_PROTOCOL_UNAVAILABLE", error instanceof Error ? error.message : String(error)));
        }
      }
    }
  }

  const taskById = new Map(root.tasks.map((task) => [task.id, task]));
  for (const task of root.tasks) {
    if (truncated) break;
    const id = entityNodeId("task", root.sessionId, task.id);
    if (!addNode({ id, kind: "task", label: task.title || task.id, status: task.status, session: rootRef, resolution: "resolved", provenance: task.provenance })) break;
    for (const dependency of task.dependencies || []) {
      if (truncated) break;
      const dependencyId = entityNodeId("task", root.sessionId, dependency);
      const dependencyTask = taskById.get(dependency);
      if (!addNode({ id: dependencyId, kind: "task", label: dependencyTask?.title || dependency, status: dependencyTask?.status || null, session: rootRef, resolution: dependencyTask ? "resolved" : "missing", provenance: dependencyTask?.provenance || task.provenance })) break;
      addEdge({ id: `task-dependency:${task.id}:${dependency}`, type: "depends-on", from: id, to: dependencyId, provenance: task.provenance, inferred: false });
    }
  }
  for (const run of root.agentRuns) {
    if (truncated) break;
    const id = entityNodeId("run", root.sessionId, run.id);
    if (!addNode({ id, kind: "run", label: run.agent || run.id, status: run.status, session: rootRef, resolution: "resolved", provenance: run.provenance })) break;
    if (run.taskId) addEdge({ id: `task-run:${run.taskId}:${run.id}`, type: "executed-by", from: entityNodeId("task", root.sessionId, run.taskId), to: id, provenance: run.provenance, inferred: run.provenance.fidelity === "derived" });
    if (run.childSessionId) {
      const childRef = { provider: adapter.id, sessionId: run.childSessionId };
      if (!addNode({ id: sessionNodeId(childRef), kind: "session", label: run.childSessionId, status: null, session: childRef, resolution: storedSession(childRef) ? "resolved" : "missing", provenance: run.provenance })) break;
      addEdge({ id: `run-child:${run.id}:${run.childSessionId}`, type: "child-session", from: id, to: sessionNodeId(childRef), provenance: run.provenance, inferred: run.provenance.fidelity === "derived" });
    }
  }
  for (const artifact of root.contextArtifacts) {
    if (truncated) break;
    const id = entityNodeId("artifact", root.sessionId, artifact.id);
    if (!addNode({ id, kind: "artifact", label: artifact.title || artifact.kind, status: artifact.contentAccess, session: rootRef, resolution: "resolved", provenance: artifact.provenance })) break;
    if (artifact.producerRunId) addEdge({ id: `run-artifact:${artifact.producerRunId}:${artifact.id}`, type: "produced", from: entityNodeId("run", root.sessionId, artifact.producerRunId), to: id, provenance: artifact.provenance, inferred: artifact.provenance.fidelity === "derived" });
  }
  for (const branch of root.branches || []) {
    if (truncated) break;
    const id = entityNodeId("branch", root.sessionId, branch.id);
    if (!addNode({ id, kind: "branch", label: branch.id, status: branch.selected === null ? null : branch.selected ? "selected" : "alternate", session: rootRef, resolution: "resolved", provenance: branch.provenance })) break;
    if (branch.parentBranchId) addEdge({ id: `branch-parent:${branch.id}:${branch.parentBranchId}`, type: "branch-of", from: entityNodeId("branch", root.sessionId, branch.parentBranchId), to: id, provenance: branch.provenance, inferred: branch.provenance.fidelity === "derived" });
  }

  return {
    focus: rootRef,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    diagnostics: diagnostics.slice(0, 100),
    truncated,
    depth,
    maxNodes
  };
}
