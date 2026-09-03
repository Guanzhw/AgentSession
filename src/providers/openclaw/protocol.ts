import type { RawSession } from "../interface.js";
import {
  capabilityDescriptor,
  finalizeSessionProtocol,
  protocolRevision,
  sessionEvent,
  sessionRelationship,
  type SessionBranch,
  type SessionProtocol
} from "../shared/session-protocol.js";
import { activeOpenClawRecords, type OpenClawRecord } from "./parser.js";

type Child = { session: RawSession; records: OpenClawRecord[] };

export const openClawProtocolCapabilities = {
  sessionEvents: capabilityDescriptor("full", "recorded", "Active path is read from the provider transcript (current SQLite transcript_events or legacy JSONL)"),
  sessionRelationships: capabilityDescriptor("full", "recorded", "session_nodes parent/spawn/fork columns and in-file parentId"),
  tasks: capabilityDescriptor("none", "derived", "Both current SQLite and legacy builders always emit an empty tasks array; no verified task mapping"),
  agentRuns: capabilityDescriptor("none", "derived", "Both current SQLite and legacy builders always emit an empty agentRuns array; no verified agent-run mapping"),
  contextArtifacts: capabilityDescriptor("none", "derived"),
  branches: capabilityDescriptor("full", "recorded", "In-file/in-window parentId branch topology")
};

/**
 * Extra recorded relationships from the current SQLite session_nodes shape.
 * Legacy JSONL sessions derive lineage from the sessions.json registry.
 */
export interface OpenClawSqliteLineageFacts {
  /** session_key this session was forked from (recorded fork_source_session_key). */
  forkedFromSessionKey?: string | null;
}

/** Protocol projection for a current-SQLite session (window-based records). */
export function buildOpenClawSqliteSessionProtocol(
  session: RawSession,
  records: OpenClawRecord[],
  children: Child[],
  revision: string | number,
  facts: OpenClawSqliteLineageFacts = {}
): SessionProtocol {
  const sessionId = String(session.id);
  const active = activeOpenClawRecords(records);
  const events: ReturnType<typeof sessionEvent>[] = [sessionEvent({
    id: `session.started:${sessionId}`, sessionId, timestamp: session.timeCreated || null,
    kind: "session.started", phase: "started",
    provenance: { fidelity: "recorded", sourceType: "openclaw.sqlite.session_nodes", sourceId: sessionId }
  })];
  for (const record of active) {
    const id = String(record.id);
    const message = record.message || {};
    events.push(sessionEvent({
      id: `record:${id}`, sessionId, timestamp: eventTime(record), kind: eventKind(record),
      phase: eventKind(record).endsWith("called") ? "started" : eventKind(record).endsWith("failed") ? "failed" : "updated",
      turnId: message.role ? id : null,
      provenance: { fidelity: "recorded", sourceType: `openclaw.sqlite.transcript_events.${String(record.type || "record")}`, sourceId: id },
      providerData: { parentId: record.parentId || null, role: message.role || null }
    }));
  }
  // Session Protocol relationships are built ONLY from the recorded fields:
  // parent_session_key yields a `parent` edge (child -> parent), spawned_by
  // yields a `spawned` edge (spawner -> child). When both fields name the
  // same session the fact is duplicated and a single relationship is emitted;
  // the `parent` edge wins because parent_session_key is the structural
  // parent field (consistent with RawSession.parentId precedence). The
  // conflated RawSession.parentId is never used as evidence here, and no
  // relationship is fabricated when a field is absent.
  const relationships: ReturnType<typeof sessionRelationship>[] = [];
  const pushEdge = (edge: ReturnType<typeof sessionRelationship>) => relationships.push(edge);
  const metadataParent = (childSession: RawSession): string | null => {
    const value = childSession.metadata?.parentSessionKey;
    return typeof value === "string" && value ? value : null;
  };
  const metadataSpawned = (childSession: RawSession): string | null => {
    const value = childSession.metadata?.spawnedBy;
    return typeof value === "string" && value ? value : null;
  };
  for (const child of children) {
    const childId = String(child.session.id);
    if (childId === sessionId) continue;
    const parent = metadataParent(child.session);
    const spawned = metadataSpawned(child.session);
    if (parent === sessionId && spawned === sessionId) {
      pushEdge(sessionRelationship({
        type: "parent", fromSessionId: childId, toSessionId: sessionId,
        timestamp: child.session.timeCreated || null,
        provenance: { fidelity: "recorded", sourceType: "openclaw.sqlite.session_nodes.parent_session_key", sourceId: childId }
      }));
      continue;
    }
    if (parent === sessionId) {
      pushEdge(sessionRelationship({
        type: "parent", fromSessionId: childId, toSessionId: sessionId,
        timestamp: child.session.timeCreated || null,
        provenance: { fidelity: "recorded", sourceType: "openclaw.sqlite.session_nodes.parent_session_key", sourceId: childId }
      }));
    }
    if (spawned === sessionId) {
      pushEdge(sessionRelationship({
        type: "spawned", fromSessionId: sessionId, toSessionId: childId,
        timestamp: child.session.timeCreated || null,
        provenance: { fidelity: "recorded", sourceType: "openclaw.sqlite.session_nodes.spawned_by", sourceId: childId }
      }));
    }
  }
  const ownParent = metadataParent(session);
  const ownSpawned = metadataSpawned(session);
  if (ownParent && ownParent !== sessionId && ownSpawned && ownSpawned === ownParent) {
    pushEdge(sessionRelationship({
      type: "parent", fromSessionId: sessionId, toSessionId: ownParent,
      timestamp: session.timeCreated || null,
      provenance: { fidelity: "recorded", sourceType: "openclaw.sqlite.session_nodes.parent_session_key", sourceId: sessionId }
    }));
  } else {
    if (ownParent && ownParent !== sessionId) {
      pushEdge(sessionRelationship({
        type: "parent", fromSessionId: sessionId, toSessionId: ownParent,
        timestamp: session.timeCreated || null,
        provenance: { fidelity: "recorded", sourceType: "openclaw.sqlite.session_nodes.parent_session_key", sourceId: sessionId }
      }));
    }
    if (ownSpawned && ownSpawned !== sessionId) {
      pushEdge(sessionRelationship({
        type: "spawned", fromSessionId: ownSpawned, toSessionId: sessionId,
        timestamp: session.timeCreated || null,
        provenance: { fidelity: "recorded", sourceType: "openclaw.sqlite.session_nodes.spawned_by", sourceId: sessionId }
      }));
    }
  }
  if (facts.forkedFromSessionKey && String(facts.forkedFromSessionKey) !== sessionId) {
    pushEdge(sessionRelationship({
      type: "forked", fromSessionId: String(facts.forkedFromSessionKey), toSessionId: sessionId,
      timestamp: session.timeCreated || null,
      provenance: { fidelity: "recorded", sourceType: "openclaw.sqlite.session_nodes.fork_source", sourceId: sessionId }
    }));
  }
  return finalizeSessionProtocol({
    sessionId, events, relationships, tasks: [], agentRuns: [], contextArtifacts: [],
    branches: branchProjection(records, active)
  }, { provider: "openclaw", session, capabilities: openClawProtocolCapabilities, revision: protocolRevision(revision) });
}

function eventTime(record: OpenClawRecord): number | null {
  const value = record.message?.timestamp ?? record.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function branchProjection(records: OpenClawRecord[], active: OpenClawRecord[]): SessionBranch[] {
  const events = records.filter((record) => record.type !== "session" && typeof record.id === "string");
  if (!events.length) return [];
  const ids = new Set(events.map((record) => String(record.id)));
  const parents = new Set(events.map((record) => record.parentId).filter((id): id is string => typeof id === "string"));
  const leaves = events.filter((record) => !parents.has(String(record.id)));
  const activeLast = active.at(-1);
  const activeHead = activeLast?.id ? String(activeLast.id) : null;
  return leaves.map((head) => ({
    id: `branch:${String(head.id)}`,
    parentBranchId: null,
    forkEventId: typeof head.parentId === "string" && ids.has(head.parentId) ? head.parentId : null,
    headEventId: String(head.id),
    selected: String(head.id) === activeHead,
    provenance: { fidelity: "recorded", sourceType: "openclaw.record.parentId", sourceId: String(head.id) }
  }));
}

function eventKind(record: OpenClawRecord) {
  const message = record.message || {};
  if (record.type === "message") {
    if (message.role === "user") return "message.user";
    if (message.role === "assistant") return "message.assistant";
    if (message.role === "toolResult") return message.isError ? "tool.failed" : "tool.completed";
  }
  if (record.type === "toolCall" || record.type === "tool_call") return "tool.called";
  return `control.${String(record.type || "record")}`;
}

/** Protocol projection that keeps OpenClaw's selected active path separate from all branches. */
export function buildOpenClawSessionProtocol(
  session: RawSession,
  records: OpenClawRecord[],
  children: Child[],
  revision: string | number
): SessionProtocol {
  const sessionId = String(session.id);
  const active = activeOpenClawRecords(records);
  const events: ReturnType<typeof sessionEvent>[] = [sessionEvent({
    id: `session.started:${sessionId}`, sessionId, timestamp: session.timeCreated || null,
    kind: "session.started", phase: "started",
    provenance: { fidelity: "recorded", sourceType: "openclaw.session", sourceId: sessionId }
  })];
  for (const record of active) {
    const id = String(record.id);
    const message = record.message || {};
    events.push(sessionEvent({
      id: `record:${id}`, sessionId, timestamp: eventTime(record), kind: eventKind(record),
      phase: eventKind(record).endsWith("called") ? "started" : eventKind(record).endsWith("failed") ? "failed" : "updated",
      turnId: message.role ? id : null,
      provenance: { fidelity: "recorded", sourceType: `openclaw.${String(record.type || "record")}`, sourceId: id },
      providerData: { parentId: record.parentId || null, role: message.role || null }
    }));
  }
  const relationships: ReturnType<typeof sessionRelationship>[] = [];
  for (const child of children) {
    const childId = String(child.session.id);
    if (!child.session.parentId || String(child.session.parentId) !== sessionId) continue;
    relationships.push(sessionRelationship({
      type: "spawned", fromSessionId: sessionId, toSessionId: childId,
      timestamp: child.session.timeCreated || null,
      provenance: { fidelity: "recorded", sourceType: "openclaw.registry.spawnedBy", sourceId: childId }
    }));
  }
  if (session.parentId) {
    relationships.push(sessionRelationship({
      type: "parent", fromSessionId: sessionId, toSessionId: String(session.parentId),
      timestamp: session.timeCreated || null,
      provenance: { fidelity: "recorded", sourceType: "openclaw.registry.spawnedBy", sourceId: sessionId }
    }));
  }
  return finalizeSessionProtocol({
    sessionId, events, relationships, tasks: [], agentRuns: [], contextArtifacts: [],
    branches: branchProjection(records, active)
  }, { provider: "openclaw", session, capabilities: openClawProtocolCapabilities, revision: protocolRevision(revision) });
}
