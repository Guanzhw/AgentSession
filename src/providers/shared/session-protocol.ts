import type { Message, RawSession } from "../interface.js";

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

/** Canonical identity used at protocol graph and query boundaries. */
export interface SessionRef {
  provider: string;
  sessionId: string;
}

export type ProtocolEntityRef =
  | { kind: "session"; ref: SessionRef }
  | { kind: "event" | "task" | "run" | "artifact" | "branch"; id: string };

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
  | "contextArtifacts"
  | "branches";

export type EventCategory =
  | "session"
  | "message"
  | "model"
  | "reasoning"
  | "tool"
  | "task"
  | "run"
  | "context"
  | "control"
  | "team"
  | "unknown";

export type SessionState =
  | "unknown"
  | "queued"
  | "running"
  | "waiting_input"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface ProtocolRevision {
  value: string;
  source: "provider" | "derived";
}

export interface SessionDescriptor {
  ref: SessionRef;
  state: SessionState;
  origin: string | null;
  timeCreated: number | null;
  timeUpdated: number | null;
  cwd: string | null;
  harness: string | null;
  terminalOutcome: string | null;
  forkSeedBoundary: number | null;
  inheritedEventCount: number | null;
  provenance: EventProvenance;
}

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
  /** Normalized v2 category; omitted by legacy provider builders. */
  category?: EventCategory;
  /** Stable common kind while `kind` remains the provider-compatible value. */
  normalizedKind?: string;
  phase?: "started" | "updated" | "completed" | "failed";
  turnId?: string | null;
  /** Session-local work anchors populated when provider evidence can bind them. */
  taskId?: string | null;
  runId?: string | null;
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
  | "scheduled-run-of"
  | "handed-off";

export interface SessionRelationship {
  type: SessionRelationshipType;
  fromSessionId: string;
  toSessionId: string;
  provenance: EventProvenance;
  timestamp?: number | null;
  /** Links this relationship to the spawning event/task when available. */
  correlationId?: string | null;
  details?: string | null;
  /** Canonical references populated by the v2 finalizer. */
  fromRef?: SessionRef;
  toRef?: SessionRef;
  triggerEventId?: string | null;
  taskId?: string | null;
  runId?: string | null;
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
  owner?: string | null;
  requestEventId?: string | null;
  triggerEventId?: string | null;
  scheduleId?: string | null;
  deadline?: number | null;
  runIds?: string[];
  revision?: number | null;
  outcome?: string | null;
  failureReason?: string | null;
  cancellationReason?: string | null;
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
  parentRunId?: string | null;
  triggerEventId?: string | null;
  scheduleId?: string | null;
  attempt?: number | null;
  outcome?: string | null;
  failureReason?: string | null;
  cancellationReason?: string | null;
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
  producerEventId?: string | null;
  consumerRunIds?: string[];
  citationEventIds?: string[];
  inheritedFromArtifactIds?: string[];
  version?: number | null;
  lineageId?: string | null;
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

export interface SessionBranch {
  id: string;
  parentBranchId: string | null;
  forkEventId: string | null;
  headEventId: string | null;
  selected: boolean | null;
  provenance: EventProvenance;
}

export type ProtocolDiagnosticSeverity = "error" | "warning";

export interface ProtocolDiagnostic {
  code: string;
  severity: ProtocolDiagnosticSeverity;
  message: string;
  entity?: ProtocolEntityRef | null;
  provenance?: EventProvenance | null;
}

export interface ProtocolValidation {
  ok: boolean;
  completeness: "complete" | "partial" | "invalid";
  errors: ProtocolDiagnostic[];
  warnings: ProtocolDiagnostic[];
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
  /** Builders may omit finalizer-owned v2 fields; every published snapshot includes them. */
  version?: 2;
  session?: SessionDescriptor;
  branches?: SessionBranch[];
  validation?: ProtocolValidation;
  completeness?: "complete" | "partial" | "invalid";
  revision?: ProtocolRevision;
}

const PROVENANCE_FIDELITIES = new Set<ProvenanceFidelity>(["recorded", "derived"]);
const RELATIONSHIP_TYPES = new Set<SessionRelationshipType>([
  "parent", "spawned", "forked", "continued", "compacted-into", "scheduled-run-of", "handed-off"
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

// ---------------------------------------------------------------------------
// Protocol v2 foundation
// ---------------------------------------------------------------------------

const EVENT_CATEGORIES = new Set<EventCategory>([
  "session", "message", "model", "reasoning", "tool", "task", "run",
  "context", "control", "team", "unknown"
]);

const SESSION_STATES = new Set<SessionState>([
  "unknown", "queued", "running", "waiting_input", "blocked", "completed",
  "failed", "cancelled", "interrupted"
]);

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metadataValue(session: Partial<RawSession> | null | undefined, ...keys: string[]): unknown {
  const metadata = session?.metadata && typeof session.metadata === "object" ? session.metadata : null;
  for (const key of keys) {
    const direct = (session as Record<string, unknown> | undefined)?.[key];
    if (direct !== undefined && direct !== null) return direct;
    const nested = metadata?.[key];
    if (nested !== undefined && nested !== null) return nested;
  }
  return null;
}

function finiteOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Map provider-compatible event names into the stable v2 category vocabulary. */
export function normalizeEventCategory(kind: unknown): EventCategory {
  const value = String(kind || "").toLowerCase();
  if (value.startsWith("message.") || value.startsWith("assistant.")) return "message";
  if (value.startsWith("model.") || value.startsWith("request.")) return "model";
  if (value.startsWith("reasoning.")) return "reasoning";
  if (value.startsWith("tool.")) return "tool";
  if (value.startsWith("task.")) return "task";
  if (value.startsWith("run.") || value.startsWith("subagent.")) return "run";
  if (value.startsWith("context.") || value.startsWith("compaction.")) return "context";
  if (value.startsWith("approval.") || value.startsWith("permission.")
    || value.startsWith("sandbox.") || value.startsWith("command.")
    || value.startsWith("control.") || value.startsWith("schedule.")) return "control";
  if (value.startsWith("team.")) return "team";
  if (value.startsWith("session.") || value.startsWith("turn.") || value.startsWith("step.")) return "session";
  return "unknown";
}

/** Map common legacy/provider names to the v2 normalized kind vocabulary. */
export function normalizeEventKind(kind: unknown): string {
  const value = String(kind || "").trim();
  switch (value) {
    case "tool.call": return "tool.called";
    case "tool.result": return "tool.completed";
    case "turn.started": return "session.started";
    case "turn.completed": return "session.ended";
    case "step.started": return "session.step.started";
    case "step.completed": return "session.step.completed";
    case "approval.requested":
    case "approval.decided": return "control.approval";
    default: return value || "unknown.event";
  }
}

function normalizedState(value: unknown): SessionState {
  const candidate = String(value || "").toLowerCase().replace(/[-\s]+/g, "_");
  if (candidate === "done" || candidate === "success" || candidate === "succeeded") return "completed";
  if (candidate === "error") return "failed";
  return SESSION_STATES.has(candidate as SessionState) ? candidate as SessionState : "unknown";
}

function descriptorFor(
  sessionId: string,
  options: FinalizeSessionProtocolOptions
): SessionDescriptor {
  const session = options.session;
  const metadata = session?.metadata && typeof session.metadata === "object" ? session.metadata : null;
  const provenance: EventProvenance = options.descriptor?.provenance || {
    fidelity: "derived",
    sourceType: "agentsession.session-descriptor",
    sourceId: sessionId
  };
  return {
    ref: { provider: options.provider, sessionId },
    state: options.descriptor?.state
      || normalizedState(metadataValue(session, "state", "status", "sessionState")),
    origin: options.descriptor?.origin
      ?? stringValue(metadataValue(session, "origin", "threadSource", "source")),
    timeCreated: options.descriptor?.timeCreated ?? finiteOrNull(session?.timeCreated),
    timeUpdated: options.descriptor?.timeUpdated ?? finiteOrNull(session?.timeUpdated),
    cwd: options.descriptor?.cwd ?? stringValue(session?.directory),
    harness: options.descriptor?.harness
      ?? stringValue(metadataValue(session, "harness", "agentPreset", "provider")),
    terminalOutcome: options.descriptor?.terminalOutcome
      ?? stringValue(metadataValue(session, "terminalOutcome", "endReason", "outcome")),
    forkSeedBoundary: options.descriptor?.forkSeedBoundary
      ?? finiteOrNull(metadataValue(session, "forkSeedBoundary", "seedLength")),
    inheritedEventCount: options.descriptor?.inheritedEventCount
      ?? finiteOrNull(metadataValue(session, "inheritedEventCount", "seedLength")),
    provenance
  };
}

export interface FinalizeSessionProtocolOptions {
  provider: string;
  session?: Partial<RawSession>;
  descriptor?: Partial<SessionDescriptor>;
  capabilities?: ProtocolCapabilities;
  revision?: ProtocolRevision | string | number;
  freeze?: boolean;
}

function entityRef(kind: ProtocolEntityRef["kind"], id: string): ProtocolEntityRef {
  return { kind, id } as ProtocolEntityRef;
}

function boundedDiagnostic(
  code: string,
  severity: ProtocolDiagnosticSeverity,
  message: string,
  entity?: ProtocolEntityRef | null,
  provenance?: EventProvenance | null
): ProtocolDiagnostic {
  const stableCode = String(code || "PROTOCOL_UNKNOWN").toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 80);
  const boundedMessage = String(message || "Protocol validation failure").replace(/\s+/g, " ").trim().slice(0, 240);
  return { code: stableCode, severity, message: boundedMessage, entity: entity ?? null, provenance: provenance ?? null };
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return value;
}

function relationKey(relation: SessionRelationship): string {
  return `${relation.type}\u0000${relation.fromSessionId}\u0000${relation.toSessionId}`;
}

/**
 * Validate a finalized v2 protocol without mutating it. The validator is
 * deliberately bounded: diagnostics contain stable codes and short messages,
 * never provider payloads or transcript text.
 */
export function validateSessionProtocol(
  protocol: SessionProtocol,
  capabilities?: ProtocolCapabilities
): ProtocolValidation {
  const errors: ProtocolDiagnostic[] = [];
  const warnings: ProtocolDiagnostic[] = [];
  const error = (code: string, message: string, entity?: ProtocolEntityRef | null, provenance?: EventProvenance | null) => {
    if (errors.length < 100) errors.push(boundedDiagnostic(code, "error", message, entity, provenance));
  };
  const warning = (code: string, message: string, entity?: ProtocolEntityRef | null, provenance?: EventProvenance | null) => {
    if (warnings.length < 100) warnings.push(boundedDiagnostic(code, "warning", message, entity, provenance));
  };

  if (protocol.version !== 2) error("PROTOCOL_VERSION_REQUIRED", "Session protocol must be finalized as version 2");
  const descriptor = protocol.session;
  if (!descriptor) {
    error("SESSION_DESCRIPTOR_MISSING", "Version 2 protocol requires a session descriptor");
  } else {
    if (!descriptor.ref.provider || !descriptor.ref.sessionId) {
      error("SESSION_REF_INVALID", "Session descriptor has an incomplete canonical reference", { kind: "session", ref: descriptor.ref });
    }
    if (descriptor.ref.sessionId !== protocol.sessionId) {
      error("SESSION_ID_MISMATCH", "Session descriptor and protocol sessionId differ", { kind: "session", ref: descriptor.ref });
    }
    if (!SESSION_STATES.has(descriptor.state)) error("SESSION_STATE_INVALID", "Session descriptor has an invalid state", { kind: "session", ref: descriptor.ref });
  }

  const eventIds = new Set<string>();
  const expectedSessionId = descriptor?.ref.sessionId || protocol.sessionId;
  for (let index = 0; index < (protocol.events || []).length; index += 1) {
    const event = protocol.events[index];
    const ref = entityRef("event", String(event?.id || index));
    if (!event?.id) error("EVENT_ID_MISSING", "Event id is required", ref, event?.provenance);
    else if (eventIds.has(event.id)) error("EVENT_ID_DUPLICATE", "Event id is not unique", ref, event.provenance);
    else eventIds.add(event.id);
    if (event?.sequence !== index + 1) error("EVENT_SEQUENCE_NOT_DENSE", "Event sequence must be dense and start at 1", ref, event?.provenance);
    if (event?.sessionId !== expectedSessionId) error("EVENT_SESSION_MISMATCH", "Event sessionId differs from canonical session", ref, event?.provenance);
    if (event?.category && !EVENT_CATEGORIES.has(event.category)) error("EVENT_CATEGORY_INVALID", "Event category is not in the v2 vocabulary", ref, event.provenance);
  }
  for (const event of protocol.events || []) {
    if (event.parentEventId && !eventIds.has(event.parentEventId)) warning("EVENT_PARENT_DANGLING", "Event parent is not present in this snapshot", entityRef("event", event.id), event.provenance);
  }

  const taskIds = new Set<string>();
  for (const task of protocol.tasks || []) {
    const ref = entityRef("task", String(task?.id || ""));
    if (!task?.id) error("TASK_ID_MISSING", "Task id is required", ref, task?.provenance);
    else if (taskIds.has(task.id)) error("TASK_ID_DUPLICATE", "Task id is not unique", ref, task.provenance);
    else taskIds.add(task.id);
    if (task?.sessionId !== expectedSessionId) error("TASK_SESSION_MISMATCH", "Task sessionId differs from canonical session", ref, task?.provenance);
    const rawTask = task as Task & Record<string, unknown>;
    if (rawTask.childSessionId !== undefined || rawTask.mode !== undefined) {
      error("TASK_RUN_FIELDS", "Task must not carry AgentRun fields", ref, task.provenance);
    }
  }

  for (const task of protocol.tasks || []) {
    const ref = entityRef("task", String(task.id || ""));
    if (task.parentTaskId && !taskIds.has(task.parentTaskId)) warning("TASK_PARENT_DANGLING", "Task parent is not present in this snapshot", ref, task.provenance);
    for (const dependency of task.dependencies || []) {
      if (!taskIds.has(dependency)) warning("TASK_DEPENDENCY_DANGLING", "Task dependency is not present in this snapshot", ref, task.provenance);
    }
    for (const eventId of [task.requestEventId, task.triggerEventId]) {
      if (eventId && !eventIds.has(eventId)) warning("TASK_EVENT_DANGLING", "Task event anchor is not present in this snapshot", ref, task.provenance);
    }
  }

  const runIds = new Set<string>();
  for (const run of protocol.agentRuns || []) {
    const ref = entityRef("run", String(run?.id || ""));
    if (!run?.id) error("RUN_ID_MISSING", "AgentRun id is required", ref, run?.provenance);
    else if (runIds.has(run.id)) error("RUN_ID_DUPLICATE", "AgentRun id is not unique", ref, run.provenance);
    else runIds.add(run.id);
    if (run?.sessionId !== expectedSessionId) error("RUN_SESSION_MISMATCH", "AgentRun sessionId differs from canonical session", ref, run?.provenance);
    if (run?.taskId && !taskIds.has(run.taskId)) warning("RUN_TASK_DANGLING", "AgentRun references a task not present in this snapshot", ref, run.provenance);
    if (run?.triggerEventId && !eventIds.has(run.triggerEventId)) warning("RUN_EVENT_DANGLING", "AgentRun trigger event is not present in this snapshot", ref, run.provenance);
    if (run?.attempt != null && (!Number.isInteger(run.attempt) || run.attempt < 1)) {
      error("RUN_ATTEMPT_INVALID", "AgentRun attempt must be a positive integer", ref, run.provenance);
    }
  }
  for (const run of protocol.agentRuns || []) {
    if (run.parentRunId && !runIds.has(run.parentRunId)) warning("RUN_PARENT_DANGLING", "AgentRun parent is not present in this snapshot", entityRef("run", run.id), run.provenance);
  }
  for (const task of protocol.tasks || []) {
    for (const runId of task.runIds || []) {
      if (!runIds.has(runId)) warning("TASK_RUN_DANGLING", "Task run is not present in this snapshot", entityRef("task", task.id), task.provenance);
    }
  }
  for (const event of protocol.events || []) {
    const ref = entityRef("event", event.id);
    if (event.taskId && !taskIds.has(event.taskId)) warning("EVENT_TASK_DANGLING", "Event task anchor is not present in this snapshot", ref, event.provenance);
    if (event.runId && !runIds.has(event.runId)) warning("EVENT_RUN_DANGLING", "Event run anchor is not present in this snapshot", ref, event.provenance);
  }

  const artifactIds = new Set<string>();
  for (const artifact of protocol.contextArtifacts || []) {
    const ref = entityRef("artifact", String(artifact?.id || ""));
    if (!artifact?.id) error("ARTIFACT_ID_MISSING", "Context artifact id is required", ref, artifact?.provenance);
    else if (artifactIds.has(artifact.id)) error("ARTIFACT_ID_DUPLICATE", "Context artifact id is not unique", ref, artifact.provenance);
    else artifactIds.add(artifact.id);
    if (artifact?.sessionId !== expectedSessionId) error("ARTIFACT_SESSION_MISMATCH", "Context artifact sessionId differs from canonical session", ref, artifact?.provenance);
    if (artifact?.producerRunId && !runIds.has(artifact.producerRunId)) warning("ARTIFACT_PRODUCER_DANGLING", "Context artifact producer run is not present in this snapshot", ref, artifact.provenance);
    if (artifact?.producerEventId && !eventIds.has(artifact.producerEventId)) warning("ARTIFACT_PRODUCER_EVENT_DANGLING", "Context artifact producer event is not present in this snapshot", ref, artifact.provenance);
    for (const runId of artifact?.consumerRunIds || []) {
      if (!runIds.has(runId)) warning("ARTIFACT_CONSUMER_RUN_DANGLING", "Context artifact consumer run is not present in this snapshot", ref, artifact.provenance);
    }
    for (const eventId of artifact?.citationEventIds || []) {
      if (!eventIds.has(eventId)) warning("ARTIFACT_CITATION_EVENT_DANGLING", "Context artifact citation event is not present in this snapshot", ref, artifact.provenance);
    }
  }
  for (const artifact of protocol.contextArtifacts || []) {
    for (const artifactId of artifact.inheritedFromArtifactIds || []) {
      if (!artifactIds.has(artifactId)) warning("ARTIFACT_INHERITED_DANGLING", "Inherited context artifact is not present in this snapshot", entityRef("artifact", artifact.id), artifact.provenance);
    }
  }

  const relationKeys = new Set<string>();
  const lineage = new Map<string, string[]>();
  for (const relation of protocol.relationships || []) {
    const from = relation?.fromRef;
    const to = relation?.toRef;
    const ref = from && to ? { kind: "session", ref: from } as ProtocolEntityRef : null;
    if (!relation?.fromSessionId || !relation?.toSessionId) {
      error("RELATION_ENDPOINT_MISSING", "Relationship requires source and target session ids", ref, relation?.provenance);
      continue;
    }
    if (relation.fromSessionId === relation.toSessionId) error("RELATION_SELF_EDGE", "Relationship cannot point a session to itself", ref, relation.provenance);
    if (relationKeys.has(relationKey(relation))) warning("RELATION_DUPLICATE", "Duplicate relationship edge", ref, relation.provenance);
    relationKeys.add(relationKey(relation));
    if (from && (from.provider !== descriptor?.ref.provider || from.sessionId !== relation.fromSessionId)) {
      error("RELATION_SOURCE_REF_MISMATCH", "Relationship source ref does not match source session id", ref, relation.provenance);
    }
    if (to && to.provider !== descriptor?.ref.provider && to.provider !== "") {
      warning("RELATION_TARGET_PROVIDER_DIFFERENT", "Relationship target belongs to another provider", ref, relation.provenance);
    }
    if (relation.triggerEventId && !eventIds.has(relation.triggerEventId)) warning("RELATION_EVENT_DANGLING", "Relationship trigger event is not present in this snapshot", ref, relation.provenance);
    if (relation.taskId && !taskIds.has(relation.taskId)) warning("RELATION_TASK_DANGLING", "Relationship task is not present in this snapshot", ref, relation.provenance);
    if (relation.runId && !runIds.has(relation.runId)) warning("RELATION_RUN_DANGLING", "Relationship run is not present in this snapshot", ref, relation.provenance);
    if (relation.type !== "scheduled-run-of") {
      const targets = lineage.get(relation.fromSessionId) || [];
      targets.push(relation.toSessionId);
      lineage.set(relation.fromSessionId, targets);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): void => {
    if (visiting.has(node)) {
      error("RELATION_CYCLE", "Session lineage contains a cycle", null);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const target of lineage.get(node) || []) visit(target);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of lineage.keys()) visit(node);

  const branchIds = new Set((protocol.branches || []).map((branch) => branch.id));
  const branchParents = new Map<string, string>();
  for (const branch of protocol.branches || []) {
    const ref = entityRef("branch", String(branch.id || ""));
    if (branch.parentBranchId && !branchIds.has(branch.parentBranchId)) warning("BRANCH_PARENT_DANGLING", "Branch parent is not present in this snapshot", ref, branch.provenance);
    if (branch.parentBranchId) branchParents.set(branch.id, branch.parentBranchId);
    for (const eventId of [branch.forkEventId, branch.headEventId]) {
      if (eventId && !eventIds.has(eventId)) warning("BRANCH_EVENT_DANGLING", "Branch event anchor is not present in this snapshot", ref, branch.provenance);
    }
  }
  for (const branch of protocol.branches || []) {
    const path = new Set<string>();
    let current: string | undefined = branch.id;
    while (current && branchParents.has(current)) {
      if (path.has(current)) {
        error("BRANCH_CYCLE", "Branch lineage contains a cycle", entityRef("branch", branch.id), branch.provenance);
        break;
      }
      path.add(current);
      current = branchParents.get(current);
    }
  }

  for (const event of protocol.events || []) {
    const continuation = event.compaction?.continuationSessionId;
    if (!continuation) continue;
    const linked = (protocol.relationships || []).some((relation) => (
      relation.type === "compacted-into"
      && relation.fromSessionId === expectedSessionId
      && relation.toSessionId === continuation
    ));
    if (!linked) warning("COMPACTION_CONTINUATION_UNLINKED", "Compaction continuation has no compacted-into relationship", entityRef("event", event.id), event.provenance);
  }

  const domainValues: Record<ProtocolDomain, unknown[]> = {
    sessionEvents: protocol.events || [],
    sessionRelationships: protocol.relationships || [],
    tasks: protocol.tasks || [],
    agentRuns: protocol.agentRuns || [],
    contextArtifacts: protocol.contextArtifacts || [],
    branches: protocol.branches || []
  };
  for (const domain of Object.keys(domainValues) as ProtocolDomain[]) {
    const descriptorForDomain = capabilities?.[domain];
    if (!descriptorForDomain) continue;
    const values = domainValues[domain];
    if (descriptorForDomain.support === "none" && values.length > 0) {
      error("CAPABILITY_NONE_WITH_DATA", `Capability ${domain} is none but the protocol contains data`);
    }
    if (descriptorForDomain.provenance === "recorded") {
      for (const value of values as Array<{ provenance?: EventProvenance }>) {
        if (value?.provenance?.fidelity === "derived") {
          error("CAPABILITY_RECORDED_MIXED", `Capability ${domain} claims recorded provenance but contains derived data`, null, value.provenance);
          break;
        }
      }
    }
  }

  const ok = errors.length === 0;
  return {
    ok,
    completeness: ok ? (warnings.length ? "partial" : "complete") : "invalid",
    errors,
    warnings
  };
}

/**
 * Convert a provider-local draft into an immutable v2 snapshot. The public
 * v2 JSON contract is a deliberate breaking change; allowing draft builders
 * to omit finalizer-owned fields is an internal construction convenience only.
 */
export function finalizeSessionProtocol(
  protocol: SessionProtocol,
  options: FinalizeSessionProtocolOptions
): SessionProtocol {
  const sessionId = String(protocol.sessionId || options.session?.id || "");
  const descriptor = descriptorFor(sessionId, options);
  const events = (protocol.events || []).map((event, index) => ({
    ...event,
    sequence: index + 1,
    category: event.category && EVENT_CATEGORIES.has(event.category)
      ? event.category
      : normalizeEventCategory(event.kind),
    normalizedKind: event.normalizedKind || normalizeEventKind(event.kind)
  }));
  const relationships = (protocol.relationships || []).map((relation) => ({
    ...relation,
    fromRef: relation.fromRef || { provider: options.provider, sessionId: relation.fromSessionId },
    toRef: relation.toRef || { provider: options.provider, sessionId: relation.toSessionId },
    triggerEventId: relation.triggerEventId ?? null,
    taskId: relation.taskId ?? null,
    runId: relation.runId ?? null
  }));
  const eventForCorrelation = (value: unknown): string | null => {
    const correlation = stringValue(value);
    if (!correlation) return null;
    return events.find((event) => event.correlationId === correlation)?.id || null;
  };
  const tasks = (protocol.tasks || []).map((task) => ({
    ...task,
    owner: task.owner ?? task.assignee ?? null,
    requestEventId: task.requestEventId ?? eventForCorrelation(task.toolCallId),
    triggerEventId: task.triggerEventId ?? eventForCorrelation(task.correlationId || task.toolCallId),
    scheduleId: task.scheduleId ?? null,
    deadline: task.deadline ?? null,
    runIds: task.runIds ? [...new Set(task.runIds)] : [],
    revision: task.revision ?? null,
    outcome: task.outcome ?? null,
    failureReason: task.failureReason ?? null,
    cancellationReason: task.cancellationReason ?? null
  }));
  const runs = (protocol.agentRuns || []).map((run) => ({
    ...run,
    parentRunId: run.parentRunId ?? null,
    triggerEventId: run.triggerEventId
      ?? (run.taskId ? tasks.find((task) => task.id === run.taskId)?.triggerEventId || null : null)
      ?? eventForCorrelation(run.id),
    scheduleId: run.scheduleId ?? null,
    attempt: run.attempt ?? null,
    outcome: run.outcome ?? null,
    failureReason: run.failureReason ?? null,
    cancellationReason: run.cancellationReason ?? null
  }));
  const taskByEvent = new Map<string, string>();
  for (const task of tasks) {
    for (const eventId of [task.requestEventId, task.triggerEventId]) {
      if (eventId && !taskByEvent.has(eventId)) taskByEvent.set(eventId, task.id);
    }
  }
  const runByEvent = new Map<string, string>();
  for (const run of runs) {
    if (run.triggerEventId && !runByEvent.has(run.triggerEventId)) runByEvent.set(run.triggerEventId, run.id);
  }
  const anchoredEvents = events.map((event) => ({
    ...event,
    taskId: event.taskId ?? taskByEvent.get(event.id) ?? null,
    runId: event.runId ?? runByEvent.get(event.id) ?? null
  }));
  const runsByTask = new Map<string, string[]>();
  for (const run of runs) {
    if (!run.taskId) continue;
    const ids = runsByTask.get(run.taskId) || [];
    ids.push(run.id);
    runsByTask.set(run.taskId, ids);
  }
  for (const task of tasks) {
    if (!task.runIds?.length && runsByTask.has(task.id)) task.runIds = [...new Set(runsByTask.get(task.id))];
  }
  const artifacts = (protocol.contextArtifacts || []).map((artifact) => ({
    ...artifact,
    producerEventId: artifact.producerEventId ?? null,
    consumerRunIds: artifact.consumerRunIds ? [...new Set(artifact.consumerRunIds)] : [],
    citationEventIds: artifact.citationEventIds ? [...new Set(artifact.citationEventIds)] : [],
    inheritedFromArtifactIds: artifact.inheritedFromArtifactIds ? [...new Set(artifact.inheritedFromArtifactIds)] : [],
    version: artifact.version ?? null,
    lineageId: artifact.lineageId ?? null
  }));
  const revision = typeof options.revision === "object"
    ? options.revision
    : options.revision === undefined
      ? undefined
      : { value: String(options.revision), source: "provider" as const };
  const finalized: SessionProtocol = {
    sessionId,
    version: 2,
    session: descriptor,
    events: anchoredEvents,
    relationships,
    tasks,
    agentRuns: runs,
    contextArtifacts: artifacts,
    branches: (protocol.branches || []).map((branch) => ({ ...branch })),
    revision
  };
  const validation = validateSessionProtocol(finalized, options.capabilities);
  finalized.validation = validation;
  finalized.completeness = validation.completeness;
  return options.freeze === false ? finalized : freezeDeep(finalized);
}

/** Normalize a provider revision into the explicit cache contract. */
export function protocolRevision(value: string | number, source: ProtocolRevision["source"] = "provider"): ProtocolRevision {
  return { value: String(value), source };
}
