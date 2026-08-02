import type { Message } from "../interface.js";

/**
 * Provider-neutral session protocol.
 *
 * Message stays the universal read/compatibility view of a conversation.
 * The protocol adds a second, structured surface over the same session:
 * typed events with stable ordering, explicit session relationships, tasks,
 * agent runs, and metadata-first context artifacts. Providers normalize
 * their native evidence into these shapes; consumers never branch on the
 * provider id.
 */

export type ProvenanceFidelity = "recorded" | "derived";

export interface EventProvenance {
  /** recorded = the provider's own data contains this fact; derived = the adapter reconstructed it from other evidence. */
  fidelity: ProvenanceFidelity;
  /** Provider-owned source shape, e.g. "codex.response_item" or "pi.entry". */
  sourceType: string;
  /** Optional source record/row/message identifier. */
  sourceId?: string | null;
}

export interface CapabilityDescriptor {
  /**
   * full  = the provider's own records carry this domain natively.
   * partial = the adapter exposes it, reconstructed from other evidence.
   * none  = not exposed by this provider.
   */
  support: "full" | "partial" | "none";
  provenance: ProvenanceFidelity;
  details?: string | null;
}

/** New capability domains declared through descriptors instead of booleans. */
export type ProtocolDomain =
  | "sessionEvents"
  | "sessionRelationships"
  | "tasks"
  | "agentRuns"
  | "contextArtifacts";

export type ProtocolCapabilities = Partial<Record<ProtocolDomain, CapabilityDescriptor>>;

/**
 * A single standardized event in a session. `sequence` is REQUIRED and is a
 * dense 1..n projection of the session's canonical SOURCE order: the order
 * the provider's records appear in (record index, then local ordinal within
 * the record). Provider timestamps never influence the sequence; they may be
 * absent, equal, or out of order without changing it.
 */
export interface SessionEventEnvelope {
  id: string;
  sessionId: string;
  sequence: number;
  timestamp: number | null;
  kind: string;
  phase?: "started" | "updated" | "completed" | "failed";
  turnId?: string | null;
  parentEventId?: string | null;
  correlationId?: string | null;
  provenance: EventProvenance;
  /** Present on events whose kind is "context.compaction". */
  compaction?: ContextCompactionEvent | null;
  providerData?: Record<string, unknown> | null;
}

export type SessionRelationshipType =
  | "parent"
  | "spawned"
  | "forked"
  | "continued"
  | "compacted-into"
  | "scheduled-run-of";

export interface SessionRelationship {
  type: SessionRelationshipType;
  fromSessionId: string;
  toSessionId: string;
  provenance: EventProvenance;
  timestamp?: number | null;
  /** Links this relationship to the spawning event/task when available. */
  correlationId?: string | null;
  details?: string | null;
}

export type ContextCompactionTrigger =
  | "manual"
  | "automatic"
  | "limit-recovery"
  | "unknown";

export type ContextCompactionStrategy = "summary" | "opaque" | "hybrid" | "unknown";

export interface ContextCompactionEvent {
  trigger: ContextCompactionTrigger;
  strategy: ContextCompactionStrategy;
  tokensBefore?: number | null;
  tokensAfter?: number | null;
  /** Provider-recorded plaintext summary. Never synthesized by the adapter. */
  summary?: string | null;
  retainedFromEventId?: string | null;
  /** When compaction continued the session in a new session record/file. */
  continuationSessionId?: string | null;
  reloadedContextRefs?: unknown[] | null;
}

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type ExecutionMode = "foreground" | "background" | "subagent" | "scheduled" | "team";

/**
 * A unit of work. Tasks are session-local and never carry run state or
 * execution mode; a Task may be executed zero or more times, each execution
 * is an AgentRun (which owns the execution mode).
 */
export interface Task {
  id: string;
  sessionId: string;
  /** Provider-owned kind, e.g. "subagent-task", "delegate", "task". */
  kind: string;
  status: TaskStatus;
  title: string | null;
  parentTaskId?: string | null;
  /** Native spawn tool call id when the task was launched through a tool. */
  toolCallId?: string | null;
  /** Native task/agent identifier shown in the transcript (e.g. Codex task name). */
  agentPath?: string | null;
  correlationId?: string | null;
  /** Task ids this task depends on; empty when the source records none. */
  dependencies?: string[];
  /** Named assignee when the source records one (e.g. an agent identity). */
  assignee?: string | null;
  timeCreated: number | null;
  timeUpdated: number | null;
  timeCompleted: number | null;
  provenance: EventProvenance;
  metadata?: Record<string, unknown> | null;
}

/** One execution of a task (or of an agent) with its own session when detached. */
export interface AgentRun {
  id: string;
  sessionId: string;
  taskId: string | null;
  status: TaskStatus;
  mode: ExecutionMode;
  agent: string | null;
  model: string | null;
  /** Canonical session id of a detached child session, when one exists. */
  childSessionId: string | null;
  timeStart: number | null;
  timeEnd: number | null;
  provenance: EventProvenance;
  metadata?: Record<string, unknown> | null;
}

export type ContextArtifactKind = "memory" | "instruction" | "skill" | "rule" | "summary";
export type ContextArtifactScope = "session" | "agent" | "project" | "user" | "organization";
export type ContextArtifactOrigin = "user-authored" | "agent-generated" | "provider-generated";
export type ContentAccess = "full" | "summary" | "metadata-only" | "unavailable";

/**
 * Metadata-first context artifact.
 *
 * Raw content is never carried here: `summary` defaults to null and is only
 * ever a short non-sensitive note. Compaction-derived artifacts must be
 * kind "summary", scope "session", origin "provider-generated", content
 * access "metadata-only", with `sourceSessionIds` set and no plaintext.
 * Lifecycle observations (memory.generated, memory.consolidated,
 * context.loaded, context.reinjected, context.cited) are event kinds, not
 * artifact fields, and are emitted only when provider evidence supports them.
 */
export interface ContextArtifact {
  id: string;
  sessionId: string;
  kind: ContextArtifactKind;
  scope: ContextArtifactScope;
  origin: ContextArtifactOrigin;
  contentAccess: ContentAccess;
  title: string | null;
  /** Short non-sensitive note. Never transcript or compaction text. */
  summary: string | null;
  sourcePath: string | null;
  /** AgentRun id that produced this artifact, when one exists. */
  producerRunId: string | null;
  /** Sessions whose content this artifact summarizes or derives from. */
  sourceSessionIds: string[];
  /** Content/identity hash when the source records or the adapter computes one. */
  hash: string | null;
  /** True when content was redacted or withheld on purpose. */
  redacted: boolean;
  provenance: EventProvenance;
  timeCreated: number | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Context-lifecycle observations are SessionEventEnvelope kinds, not artifact
 * fields. Emit them only when provider evidence actually supports the
 * observation (e.g. a recorded "memory generated" note); never derive them
 * from plain compaction.
 */
export type ContextLifecycleEventKind =
  | "memory.generated"
  | "memory.consolidated"
  | "context.loaded"
  | "context.reinjected"
  | "context.cited";

export const CONTEXT_LIFECYCLE_EVENT_KINDS: readonly ContextLifecycleEventKind[] = [
  "memory.generated",
  "memory.consolidated",
  "context.loaded",
  "context.reinjected",
  "context.cited"
];

export function isContextLifecycleEventKind(kind: unknown): kind is ContextLifecycleEventKind {
  return typeof kind === "string" && (CONTEXT_LIFECYCLE_EVENT_KINDS as readonly string[]).includes(kind);
}

export interface SessionProtocol {
  sessionId: string;
  events: SessionEventEnvelope[];
  relationships: SessionRelationship[];
  tasks: Task[];
  agentRuns: AgentRun[];
  contextArtifacts: ContextArtifact[];
}

const PROVENANCE_FIDELITIES = new Set<ProvenanceFidelity>(["recorded", "derived"]);
const RELATIONSHIP_TYPES = new Set<SessionRelationshipType>([
  "parent", "spawned", "forked", "continued", "compacted-into", "scheduled-run-of"
]);
const TASK_STATUSES = new Set<TaskStatus>([
  "queued", "running", "waiting_input", "blocked", "completed", "failed", "cancelled"
]);
const EXECUTION_MODES = new Set<ExecutionMode>([
  "foreground", "background", "subagent", "scheduled", "team"
]);
const ARTIFACT_KINDS = new Set<ContextArtifactKind>([
  "memory", "instruction", "skill", "rule", "summary"
]);
const ARTIFACT_SCOPES = new Set<ContextArtifactScope>([
  "session", "agent", "project", "user", "organization"
]);
const ARTIFACT_ORIGINS = new Set<ContextArtifactOrigin>([
  "user-authored", "agent-generated", "provider-generated"
]);
const CONTENT_ACCESSES = new Set<ContentAccess>([
  "full", "summary", "metadata-only", "unavailable"
]);

function assertProvenance(provenance: EventProvenance): EventProvenance {
  if (!provenance || !PROVENANCE_FIDELITIES.has(provenance.fidelity)) {
    throw new TypeError(`Invalid event provenance fidelity: ${String(provenance?.fidelity)}`);
  }
  if (typeof provenance.sourceType !== "string" || !provenance.sourceType) {
    throw new TypeError("Event provenance requires a sourceType");
  }
  return provenance;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Stable empty protocol surface. Unsupported adapters and empty sessions share this contract. */
export function emptySessionProtocol(sessionId: string): SessionProtocol {
  return {
    sessionId,
    events: [],
    relationships: [],
    tasks: [],
    agentRuns: [],
    contextArtifacts: []
  };
}

export function defaultCapabilityDescriptor(): CapabilityDescriptor {
  return { support: "none", provenance: "derived" };
}

export function capabilityDescriptor(
  support: CapabilityDescriptor["support"],
  provenance: ProvenanceFidelity,
  details?: string | null
): CapabilityDescriptor {
  if (support !== "full" && support !== "partial" && support !== "none") {
    throw new TypeError(`Invalid capability support level: ${String(support)}`);
  }
  if (!PROVENANCE_FIDELITIES.has(provenance)) {
    throw new TypeError(`Invalid capability provenance: ${String(provenance)}`);
  }
  return { support, provenance, details: details ?? null };
}

/**
 * Assign REQUIRED dense sequences (1..n) in the supplied canonical order.
 * The input array order IS the sequence order: timestamps are never read,
 * so missing, equal, or out-of-order timestamps cannot reorder events.
 */
export function assignEventSequences(events: readonly unknown[]): number[] {
  return events.map((_, index) => index + 1);
}

export function sequenceSessionEvents<T>(events: readonly T[]): Array<T & { sequence: number }> {
  return events.map((event, index) => ({ ...event, sequence: index + 1 }));
}

/**
 * Canonical source anchor for one event: the provider record index, then a
 * local ordinal for events produced by the same record (e.g. a compaction
 * record that also yields a lifecycle or message event). Kept in
 * `providerData.sourceSequence` as an additive, private anchor; the public
 * `sequence` field is the dense 1..n projection of this order.
 */
export function sourceSequence(recordIndex: number, ordinal = 0): number {
  return recordIndex * 1000 + ordinal;
}

function eventSourceSequence(event: SessionEventEnvelope): number {
  const value = event.providerData?.sourceSequence;
  return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/**
 * Order events by canonical provider source order (anchored via
 * `providerData.sourceSequence`) and assign dense 1..n sequences. Events
 * without an anchor (normalized messages that cannot map to a raw record)
 * keep their relative input order and are appended after all anchored events;
 * that deterministic fallback is documented per provider.
 */
export function sequenceEventsBySource(events: readonly SessionEventEnvelope[]): SessionEventEnvelope[] {
  const ordered = [...events].sort((left, right) => eventSourceSequence(left) - eventSourceSequence(right));
  return ordered.map((event, index) => ({ ...event, sequence: index + 1 }));
}

export function sessionEvent(
  fields: Omit<SessionEventEnvelope, "sequence"> & { sequence?: number }
): SessionEventEnvelope {
  return {
    sequence: fields.sequence ?? 0,
    ...fields,
    provenance: assertProvenance(fields.provenance)
  };
}

export function sessionRelationship(fields: SessionRelationship): SessionRelationship {
  if (!RELATIONSHIP_TYPES.has(fields.type)) {
    throw new TypeError(`Invalid session relationship type: ${String(fields.type)}`);
  }
  return {
    ...fields,
    timestamp: numberOrNull(fields.timestamp),
    correlationId: fields.correlationId ?? null,
    details: fields.details ?? null,
    provenance: assertProvenance(fields.provenance)
  };
}

export function sessionTask(fields: Task): Task {
  if (!TASK_STATUSES.has(fields.status)) {
    throw new TypeError(`Invalid task status: ${String(fields.status)}`);
  }
  return {
    ...fields,
    title: fields.title ?? null,
    dependencies: Array.isArray(fields.dependencies)
      ? [...new Set(fields.dependencies.filter((value) => typeof value === "string" && value))]
      : [],
    assignee: fields.assignee ?? null,
    timeCreated: numberOrNull(fields.timeCreated),
    timeUpdated: numberOrNull(fields.timeUpdated),
    timeCompleted: numberOrNull(fields.timeCompleted),
    provenance: assertProvenance(fields.provenance)
  };
}

export function agentRun(fields: AgentRun): AgentRun {
  if (!TASK_STATUSES.has(fields.status)) {
    throw new TypeError(`Invalid agent run status: ${String(fields.status)}`);
  }
  if (!EXECUTION_MODES.has(fields.mode)) {
    throw new TypeError(`Invalid execution mode: ${String(fields.mode)}`);
  }
  return {
    ...fields,
    taskId: fields.taskId ?? null,
    childSessionId: fields.childSessionId ?? null,
    timeStart: numberOrNull(fields.timeStart),
    timeEnd: numberOrNull(fields.timeEnd),
    provenance: assertProvenance(fields.provenance)
  };
}

/**
 * Metadata-first artifact factory: content is never attached here. Pass
 * `summary` only for a short non-sensitive note the provider explicitly
 * recorded as public metadata (never transcript text).
 */
export function contextArtifact(fields: ContextArtifact): ContextArtifact {
  if (!ARTIFACT_KINDS.has(fields.kind)) {
    throw new TypeError(`Invalid context artifact kind: ${String(fields.kind)}`);
  }
  if (!ARTIFACT_SCOPES.has(fields.scope)) {
    throw new TypeError(`Invalid context artifact scope: ${String(fields.scope)}`);
  }
  if (!ARTIFACT_ORIGINS.has(fields.origin)) {
    throw new TypeError(`Invalid context artifact origin: ${String(fields.origin)}`);
  }
  if (!CONTENT_ACCESSES.has(fields.contentAccess)) {
    throw new TypeError(`Invalid content access level: ${String(fields.contentAccess)}`);
  }
  return {
    ...fields,
    title: fields.title ?? null,
    summary: fields.summary ?? null,
    sourcePath: fields.sourcePath ?? null,
    producerRunId: fields.producerRunId ?? null,
    sourceSessionIds: Array.isArray(fields.sourceSessionIds)
      ? [...new Set(fields.sourceSessionIds.filter((value) => typeof value === "string" && value))]
      : [],
    hash: fields.hash ?? null,
    redacted: fields.redacted === true,
    timeCreated: numberOrNull(fields.timeCreated),
    provenance: assertProvenance(fields.provenance)
  };
}

/**
 * Compaction-derived artifact factory enforcing the reviewed shape: kind
 * "summary", scope "session", origin "provider-generated", content access
 * "metadata-only", no plaintext content, and `sourceSessionIds` required.
 * Lifecycle observations are never attached; emit context-lifecycle event
 * kinds only when provider evidence actually supports them.
 */
export function compactionSummaryArtifact(fields: {
  id: string;
  sessionId: string;
  sourceSessionIds: string[];
  provenance: EventProvenance;
  title?: string | null;
  sourcePath?: string | null;
  producerRunId?: string | null;
  timeCreated?: number | null;
  metadata?: Record<string, unknown> | null;
}): ContextArtifact {
  return contextArtifact({
    id: fields.id,
    sessionId: fields.sessionId,
    kind: "summary",
    scope: "session",
    origin: "provider-generated",
    contentAccess: "metadata-only",
    title: fields.title ?? null,
    summary: null,
    sourcePath: fields.sourcePath ?? null,
    producerRunId: fields.producerRunId ?? null,
    sourceSessionIds: fields.sourceSessionIds,
    hash: null,
    redacted: true,
    provenance: fields.provenance,
    timeCreated: fields.timeCreated ?? null,
    metadata: fields.metadata ?? null
  });
}

export function normalizeCompactionTrigger(value: unknown): ContextCompactionTrigger {
  const normalized = String(value || "").toLowerCase().replace(/[_\s-]+/g, "-");
  if (normalized === "manual" || normalized === "automatic" || normalized === "limit-recovery") {
    return normalized;
  }
  if (normalized === "auto" || normalized === "auto-compact") return "automatic";
  return "unknown";
}

export function normalizeCompactionStrategy(value: unknown): ContextCompactionStrategy {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "summary" || normalized === "opaque" || normalized === "hybrid") {
    return normalized;
  }
  return "unknown";
}

export function contextCompactionEvent(fields: ContextCompactionEvent): ContextCompactionEvent {
  return {
    trigger: normalizeCompactionTrigger(fields.trigger),
    strategy: normalizeCompactionStrategy(fields.strategy),
    tokensBefore: numberOrNull(fields.tokensBefore),
    tokensAfter: numberOrNull(fields.tokensAfter),
    summary: typeof fields.summary === "string" && fields.summary.trim() ? fields.summary : null,
    retainedFromEventId: fields.retainedFromEventId ?? null,
    continuationSessionId: fields.continuationSessionId ?? null,
    reloadedContextRefs: fields.reloadedContextRefs ?? null
  };
}

/**
 * Compaction envelope factory: builds a "context.compaction" event and keeps
 * the standardized payload in `compaction`.
 */
export function compactionEnvelope(
  fields: Omit<SessionEventEnvelope, "sequence" | "kind" | "compaction">,
  compaction: ContextCompactionEvent
): SessionEventEnvelope {
  const event = sessionEvent({ ...fields, kind: "context.compaction" });
  return {
    ...event,
    phase: event.phase ?? "completed",
    compaction: contextCompactionEvent(compaction)
  };
}

/**
 * Derive one envelope per normalized message. Fidelity is always "derived":
 * the provider's transcript is the source; the envelope is the adapter's
 * normalized view of it. Returns events in message order; providers anchor
 * them to their producing record via `sourceSequence` and project with
 * `sequenceEventsBySource` (see `messageAnchors` in each provider protocol).
 */
export function messageSessionEvents(
  messages: Message[],
  sessionId: string,
  sourceType: string
): SessionEventEnvelope[] {
  const events: SessionEventEnvelope[] = [];
  for (const message of messages) {
    const turnId = message.metadata?.turnId;
    const callId = message.metadata?.callId;
    events.push(sessionEvent({
      id: `event:${message.id}`,
      sessionId,
      sequence: 0,
      timestamp: numberOrNull(message.timestamp),
      kind: `message.${message.role}`,
      turnId: typeof turnId === "string" && turnId ? turnId : null,
      correlationId: typeof callId === "string" && callId ? callId : null,
      provenance: {
        fidelity: "derived",
        sourceType,
        sourceId: message.id || null
      }
    }));
  }
  return events;
}
