import type {
  EventProvenance,
  ProtocolDiagnostic,
  ProtocolEntityRef,
  ProtocolValidation,
  SessionProtocol,
  SessionRef,
  SessionRelationship
} from "./session-protocol.js";
import { validateSessionProtocol } from "./session-protocol.js";

/**
 * Session Protocol v3's typed work-graph foundation. The v2 facts remain
 * first-class fields on this shape; the new domains are additive and optional.
 * Providers can adopt v3 incrementally through upgradeSessionProtocolV2().
 */

export type ProtocolCoverageState = "observed" | "not-observed" | "unknown" | "unsupported";

export interface ProtocolDomainCoverage {
  state: ProtocolCoverageState;
  details?: string | null;
}

export interface ProtocolCoverage {
  work: ProtocolDomainCoverage;
  execution: ProtocolDomainCoverage;
  coordination: ProtocolDomainCoverage;
  context: ProtocolDomainCoverage;
  usage: ProtocolDomainCoverage;
}

export type GoalStatus = "unknown" | "queued" | "active" | "blocked" | "completed" | "failed" | "cancelled";

export interface Goal {
  id: string;
  sessionId: string;
  title: string | null;
  description?: string | null;
  status: GoalStatus;
  taskIds: string[];
  parentGoalId?: string | null;
  ownerActorId?: string | null;
  timeCreated: number | null;
  timeUpdated: number | null;
  timeCompleted?: number | null;
  provenance: EventProvenance;
}

export type ActorKind = "human" | "agent" | "team" | "system" | "unknown";

/** Actor identity is deliberately independent from a session or execution. */
export interface Actor {
  id: string;
  kind: ActorKind;
  name: string | null;
  providerActorId?: string | null;
  teamId?: string | null;
  memberActorIds?: string[];
  runIds?: string[];
  sessionRef?: SessionRef | null;
  provenance: EventProvenance;
}

export type CoordinationKind =
  | "spawn"
  | "delegate"
  | "follow-up"
  | "message"
  | "mailbox-delivery"
  | "wait"
  | "interrupt"
  | "handoff"
  | "result-delivery"
  | "result-acknowledgement";

export type CoordinationState = "requested" | "started" | "delivered" | "acknowledged" | "completed" | "failed" | "cancelled" | "unknown";

export interface CoordinationObservation {
  id: string;
  sessionId: string;
  kind: CoordinationKind;
  state?: CoordinationState;
  timestamp: number | null;
  senderActorId?: string | null;
  recipientActorId?: string | null;
  fromSessionRef?: SessionRef | null;
  toSessionRef?: SessionRef | null;
  relationshipType?: SessionRelationship["type"] | null;
  taskId?: string | null;
  runId?: string | null;
  eventId?: string | null;
  turnId?: string | null;
  correlationId?: string | null;
  provenance: EventProvenance;
}

export type ContextTransformationKind = "compaction" | "merge" | "load" | "reinjection" | "memory" | "experience" | "dream" | "other";

export interface ContextVersion {
  id: string;
  sessionId: string;
  sequence?: number | null;
  parentVersionIds: string[];
  artifactIds: string[];
  createdAt: number | null;
  provenance: EventProvenance;
}

export interface ContextTransformation {
  id: string;
  sessionId: string;
  kind: ContextTransformationKind;
  sourceVersionIds: string[];
  resultVersionId?: string | null;
  sourceArtifactIds: string[];
  resultArtifactIds: string[];
  eventId?: string | null;
  runId?: string | null;
  turnId?: string | null;
  timestamp: number | null;
  provenance: EventProvenance;
}

export type UsageScope = "request";

export interface UsageTokenComponents {
  input?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  output?: number | null;
  reasoning?: number | null;
  total?: number | null;
}

export type ContextOrigin = "direct" | "inherited" | "shared";
export type ContextOriginComponent = "input" | "cacheRead" | "cacheWrite";

/** A request may contain multiple origins for each input/cache component. */
export interface ContextOriginSlice {
  component: ContextOriginComponent;
  origin: ContextOrigin;
  tokens: number;
  sourceSessionRefs?: SessionRef[];
}

export interface UsageRecord {
  /** Stable provider usage/request identity, never a generated array index. */
  id: string;
  scope: UsageScope;
  sessionRef: SessionRef;
  timestamp: number | null;
  model: string | null;
  runId?: string | null;
  eventId?: string | null;
  turnId?: string | null;
  tokens: UsageTokenComponents;
  contextOriginSlices?: ContextOriginSlice[];
  provenance: EventProvenance;
}

export interface ProtocolUpgradeMetadata {
  fromVersion: 2;
  strategy: "v2-to-v3";
  /** v2 facts are copied, not replaced or reinterpreted in place. */
  preservesV2Facts: true;
}

export interface SessionProtocolV3 extends Omit<SessionProtocol, "version" | "validation" | "completeness"> {
  version: 3;
  goals: Goal[];
  actors: Actor[];
  coordination: CoordinationObservation[];
  contextVersions: ContextVersion[];
  contextTransformations: ContextTransformation[];
  usageRecords: UsageRecord[];
  coverage: ProtocolCoverage;
  upgrade?: ProtocolUpgradeMetadata;
  validation?: ProtocolValidation;
  completeness?: "complete" | "partial" | "invalid";
}

export interface FinalizeSessionProtocolV3Options {
  freeze?: boolean;
}

const GOAL_STATUSES = new Set<GoalStatus>(["unknown", "queued", "active", "blocked", "completed", "failed", "cancelled"]);
const ACTOR_KINDS = new Set<ActorKind>(["human", "agent", "team", "system", "unknown"]);
const COORDINATION_KINDS = new Set<CoordinationKind>([
  "spawn", "delegate", "follow-up", "message", "mailbox-delivery", "wait", "interrupt",
  "handoff", "result-delivery", "result-acknowledgement"
]);
const COORDINATION_STATES = new Set<CoordinationState>([
  "requested", "started", "delivered", "acknowledged", "completed", "failed", "cancelled", "unknown"
]);
const TRANSFORMATION_KINDS = new Set<ContextTransformationKind>([
  "compaction", "merge", "load", "reinjection", "memory", "experience", "dream", "other"
]);
const USAGE_SCOPES = new Set<UsageScope>(["request"]);
const COVERAGE_STATES = new Set<ProtocolCoverageState>(["observed", "not-observed", "unknown", "unsupported"]);
const ORIGINS = new Set<ContextOrigin>(["direct", "inherited", "shared"]);
const ORIGIN_COMPONENTS = new Set<ContextOriginComponent>(["input", "cacheRead", "cacheWrite"]);
const TOKEN_COMPONENTS = new Set(["input", "cacheRead", "cacheWrite", "output", "reasoning", "total"]);
const RELATIONSHIP_TYPES = new Set<SessionRelationship["type"]>([
  "parent", "spawned", "forked", "continued", "compacted-into", "scheduled-run-of", "handed-off"
]);

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return value;
}

function list(values: readonly string[] | null | undefined): string[] {
  return [...new Set((values || []).map(nonEmpty).filter((value): value is string => value !== null))];
}

function optionalId(value: unknown): string | null {
  return nonEmpty(value);
}

function provenance(value: EventProvenance): EventProvenance {
  if (!value || (value.fidelity !== "recorded" && value.fidelity !== "derived") || !nonEmpty(value.sourceType)) {
    throw new TypeError("Protocol v3 facts require valid provenance");
  }
  return { ...value };
}

function ref(value: SessionRef | null | undefined): SessionRef | null {
  if (!value) return null;
  const provider = nonEmpty(value.provider);
  const sessionId = nonEmpty(value.sessionId);
  if (!provider || !sessionId) throw new TypeError("SessionRef requires provider and sessionId");
  return { provider, sessionId };
}

export function protocolDomainCoverage(state: ProtocolCoverageState, details: string | null = null): ProtocolDomainCoverage {
  if (!COVERAGE_STATES.has(state)) throw new TypeError(`Invalid protocol coverage state: ${String(state)}`);
  return { state, details };
}

export function protocolCoverage(fields: Partial<ProtocolCoverage> = {}): ProtocolCoverage {
  const value = (domain: keyof ProtocolCoverage): ProtocolDomainCoverage => fields[domain]
    ? protocolDomainCoverage(fields[domain]!.state, fields[domain]!.details ?? null)
    : protocolDomainCoverage("unknown");
  return { work: value("work"), execution: value("execution"), coordination: value("coordination"), context: value("context"), usage: value("usage") };
}

export function goal(fields: Goal): Goal {
  const id = nonEmpty(fields.id);
  const sessionId = nonEmpty(fields.sessionId);
  if (!id || !sessionId) throw new TypeError("Goal requires id and sessionId");
  if (!GOAL_STATUSES.has(fields.status)) throw new TypeError(`Invalid goal status: ${String(fields.status)}`);
  return { ...fields, id, sessionId, title: fields.title ?? null, description: fields.description ?? null, taskIds: list(fields.taskIds), parentGoalId: optionalId(fields.parentGoalId), ownerActorId: optionalId(fields.ownerActorId), timeCreated: finiteOrNull(fields.timeCreated), timeUpdated: finiteOrNull(fields.timeUpdated), timeCompleted: finiteOrNull(fields.timeCompleted), provenance: provenance(fields.provenance) };
}

export function actor(fields: Actor): Actor {
  const id = nonEmpty(fields.id);
  if (!id) throw new TypeError("Actor requires id");
  if (!ACTOR_KINDS.has(fields.kind)) throw new TypeError(`Invalid actor kind: ${String(fields.kind)}`);
  return { ...fields, id, name: fields.name ?? null, providerActorId: optionalId(fields.providerActorId), teamId: optionalId(fields.teamId), memberActorIds: list(fields.memberActorIds), runIds: list(fields.runIds), sessionRef: ref(fields.sessionRef), provenance: provenance(fields.provenance) };
}

export function coordinationObservation(fields: CoordinationObservation): CoordinationObservation {
  const id = nonEmpty(fields.id);
  const sessionId = nonEmpty(fields.sessionId);
  if (!id || !sessionId) throw new TypeError("Coordination observation requires id and sessionId");
  if (!COORDINATION_KINDS.has(fields.kind)) throw new TypeError(`Invalid coordination kind: ${String(fields.kind)}`);
  if (fields.state !== undefined && !COORDINATION_STATES.has(fields.state)) throw new TypeError(`Invalid coordination state: ${String(fields.state)}`);
  return { ...fields, id, sessionId, state: fields.state ?? "unknown", timestamp: finiteOrNull(fields.timestamp), senderActorId: optionalId(fields.senderActorId), recipientActorId: optionalId(fields.recipientActorId), fromSessionRef: ref(fields.fromSessionRef), toSessionRef: ref(fields.toSessionRef), relationshipType: fields.relationshipType ?? null, taskId: optionalId(fields.taskId), runId: optionalId(fields.runId), eventId: optionalId(fields.eventId), turnId: optionalId(fields.turnId), correlationId: optionalId(fields.correlationId), provenance: provenance(fields.provenance) };
}

export function contextVersion(fields: ContextVersion): ContextVersion {
  const id = nonEmpty(fields.id);
  const sessionId = nonEmpty(fields.sessionId);
  if (!id || !sessionId) throw new TypeError("ContextVersion requires id and sessionId");
  return { ...fields, id, sessionId, sequence: finiteOrNull(fields.sequence), parentVersionIds: list(fields.parentVersionIds), artifactIds: list(fields.artifactIds), createdAt: finiteOrNull(fields.createdAt), provenance: provenance(fields.provenance) };
}

export function contextTransformation(fields: ContextTransformation): ContextTransformation {
  const id = nonEmpty(fields.id);
  const sessionId = nonEmpty(fields.sessionId);
  if (!id || !sessionId) throw new TypeError("ContextTransformation requires id and sessionId");
  if (!TRANSFORMATION_KINDS.has(fields.kind)) throw new TypeError(`Invalid context transformation kind: ${String(fields.kind)}`);
  const resultArtifactIds = list(fields.resultArtifactIds);
  const resultVersionId = optionalId(fields.resultVersionId);
  if (!resultVersionId && resultArtifactIds.length === 0) throw new TypeError("ContextTransformation requires an observed result version or artifact");
  return { ...fields, id, sessionId, sourceVersionIds: list(fields.sourceVersionIds), resultVersionId, sourceArtifactIds: list(fields.sourceArtifactIds), resultArtifactIds, eventId: optionalId(fields.eventId), runId: optionalId(fields.runId), turnId: optionalId(fields.turnId), timestamp: finiteOrNull(fields.timestamp), provenance: provenance(fields.provenance) };
}

export function usageRecord(fields: UsageRecord): UsageRecord {
  const id = nonEmpty(fields.id);
  if (!id) throw new TypeError("UsageRecord requires a stable id");
  if (!USAGE_SCOPES.has(fields.scope)) throw new TypeError(`Invalid usage scope: ${String(fields.scope)}`);
  const sessionRef = ref(fields.sessionRef);
  if (!sessionRef) throw new TypeError("UsageRecord requires an owning sessionRef");
  return { ...fields, id, sessionRef, timestamp: finiteOrNull(fields.timestamp), model: optionalId(fields.model), runId: optionalId(fields.runId), eventId: optionalId(fields.eventId), turnId: optionalId(fields.turnId), tokens: { ...fields.tokens }, contextOriginSlices: (fields.contextOriginSlices || []).map((slice) => ({ ...slice, sourceSessionRefs: (slice.sourceSessionRefs || []).map((sourceRef) => ref(sourceRef)!) })), provenance: provenance(fields.provenance) };
}

/** Finalize provider-owned v3 facts over an already-finalized v2-compatible base. */
export function finalizeSessionProtocolV3(
  protocol: SessionProtocolV3,
  options: FinalizeSessionProtocolV3Options = {}
): SessionProtocolV3 {
  const owned = structuredClone(protocol);
  const finalized: SessionProtocolV3 = {
    ...owned,
    version: 3,
    goals: owned.goals.map(goal),
    actors: owned.actors.map(actor),
    coordination: owned.coordination.map(coordinationObservation),
    contextVersions: owned.contextVersions.map(contextVersion),
    contextTransformations: owned.contextTransformations.map(contextTransformation),
    usageRecords: owned.usageRecords.map(usageRecord),
    coverage: protocolCoverage(owned.coverage),
    upgrade: owned.upgrade ? { ...owned.upgrade } : undefined
  };
  const validation = validateSessionProtocolV3(finalized);
  finalized.validation = validation;
  finalized.completeness = validation.completeness;
  if (options.freeze !== false) {
    freezeDeep(finalized);
  }
  return finalized;
}

function diagnostic(code: string, message: string, entity: ProtocolEntityRef | null = null, source: EventProvenance | null = null): ProtocolDiagnostic {
  return { code, severity: "error", message, entity, provenance: source };
}

function idSet<T extends { id: string }>(values: T[], name: string, errors: ProtocolDiagnostic[]): Set<string> {
  const ids = new Set<string>();
  const entityKind = name.toLowerCase() as Exclude<ProtocolEntityRef["kind"], "session">;
  for (const value of values) {
    if (!nonEmpty(value?.id)) {
      if (errors.length < 100) errors.push(diagnostic(`${name}_ID_MISSING`, `${name} id is required`));
      continue;
    }
    if (ids.has(value.id)) {
      if (errors.length < 100) errors.push(diagnostic(`${name}_ID_DUPLICATE`, `${name} id is not unique`, { kind: entityKind, id: value.id }));
      continue;
    }
    ids.add(value.id);
  }
  return ids;
}

function validRef(value: SessionRef | null | undefined): boolean {
  return Boolean(value && nonEmpty(value.provider) && nonEmpty(value.sessionId));
}

function validProvenance(value: EventProvenance | null | undefined): boolean {
  return Boolean(value
    && (value.fidelity === "recorded" || value.fidelity === "derived")
    && nonEmpty(value.sourceType));
}

function tokenValue(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function factCount(domain: keyof ProtocolCoverage, protocol: SessionProtocolV3): number {
  switch (domain) {
    case "work": return protocol.goals.length + protocol.tasks.length;
    case "execution": return protocol.agentRuns.length + protocol.actors.length;
    case "coordination": return protocol.coordination.length;
    case "context": return protocol.contextArtifacts.length + protocol.contextVersions.length + protocol.contextTransformations.length;
    case "usage": return protocol.usageRecords.length;
  }
}

function v2Facts(protocol: SessionProtocol): Omit<SessionProtocolV3, "version" | "goals" | "actors" | "coordination" | "contextVersions" | "contextTransformations" | "usageRecords" | "coverage" | "upgrade" | "validation" | "completeness"> {
  return {
    sessionId: protocol.sessionId,
    session: protocol.session,
    events: protocol.events,
    relationships: protocol.relationships,
    tasks: protocol.tasks,
    agentRuns: protocol.agentRuns,
    contextArtifacts: protocol.contextArtifacts,
    branches: protocol.branches,
    revision: protocol.revision
  };
}

/**
 * Provider-neutral upgrade boundary. Only explicit v2 entities are copied or
 * mapped: v2 facts remain v2 facts. New coordination and context domains are
 * empty unless explicit v3 evidence is supplied by a native builder.
 */
export function upgradeSessionProtocolV2(protocol: SessionProtocol, options: { coverage?: Partial<ProtocolCoverage>; freeze?: boolean } = {}): SessionProtocolV3 {
  if (protocol.version !== 2 || !protocol.session) throw new TypeError("v2-to-v3 upgrade requires a finalized Session Protocol v2 snapshot");
  if (protocol.validation?.ok === false || protocol.completeness === "invalid") {
    throw new TypeError("Cannot upgrade an invalid Session Protocol v2 snapshot");
  }
  const base = v2Facts(protocol);
  const finalized = finalizeSessionProtocolV3({
    ...base,
    version: 3,
    goals: [],
    actors: [],
    coordination: [],
    contextVersions: [],
    contextTransformations: [],
    usageRecords: [],
    coverage: protocolCoverage({
      work: protocolDomainCoverage("unknown"),
      execution: protocolDomainCoverage("unknown"),
      coordination: protocolDomainCoverage("unknown"),
      context: protocolDomainCoverage("unknown"),
      usage: protocolDomainCoverage("unknown"),
      ...(options.coverage || {})
    }),
    upgrade: { fromVersion: 2, strategy: "v2-to-v3", preservesV2Facts: true }
  }, { freeze: false });
  const sourceWarnings = protocol.validation?.warnings || [];
  if (sourceWarnings.length > 0) {
    const seen = new Set(finalized.validation!.warnings.map((value) => `${value.code}\u0000${value.message}`));
    const warnings = [...finalized.validation!.warnings];
    for (const warning of sourceWarnings) {
      const key = `${warning.code}\u0000${warning.message}`;
      if (!seen.has(key) && warnings.length < 100) {
        seen.add(key);
        warnings.push(structuredClone(warning));
      }
    }
    const completeness = finalized.validation!.errors.length > 0 ? "invalid" : "partial";
    finalized.validation = { ...finalized.validation!, completeness, warnings };
    finalized.completeness = completeness;
  }
  return options.freeze === false ? finalized : freezeDeep(finalized);
}

export function validateSessionProtocolV3(protocol: SessionProtocolV3): ProtocolValidation {
  const errors: ProtocolDiagnostic[] = [];
  const warnings: ProtocolDiagnostic[] = [];
  const error = (code: string, message: string, entity: ProtocolEntityRef | null = null, source: EventProvenance | null = null) => {
    if (errors.length < 100) errors.push(diagnostic(code, message, entity, source));
  };
  const provider = protocol.session?.ref.provider;
  const sessionId = protocol.session?.ref.sessionId || protocol.sessionId;

  if (protocol.version !== 3) error("PROTOCOL_V3_REQUIRED", "Session protocol must be finalized as version 3");
  if (protocol.upgrade && (protocol.upgrade.fromVersion !== 2 || protocol.upgrade.strategy !== "v2-to-v3" || protocol.upgrade.preservesV2Facts !== true)) error("V3_UPGRADE_BOUNDARY_INVALID", "Protocol v3 upgrade metadata is invalid");
  const v2: SessionProtocol = { sessionId: protocol.sessionId, version: 2, session: protocol.session, events: protocol.events, relationships: protocol.relationships, tasks: protocol.tasks, agentRuns: protocol.agentRuns, contextArtifacts: protocol.contextArtifacts, branches: protocol.branches, revision: protocol.revision };
  const baseValidation = validateSessionProtocol(v2);
  errors.push(...baseValidation.errors);
  warnings.push(...baseValidation.warnings);
  if (protocol.sessionId !== sessionId) error("SESSION_ID_MISMATCH", "Protocol v3 sessionId differs from its canonical descriptor");

  const taskIds = new Set(protocol.tasks.map((task) => task.id));
  const runIds = new Set(protocol.agentRuns.map((run) => run.id));
  const eventIds = new Set(protocol.events.map((event) => event.id));
  const artifactIds = new Set(protocol.contextArtifacts.map((artifact) => artifact.id));
  const goalIds = idSet(protocol.goals, "GOAL", errors);
  const actorIds = idSet(protocol.actors, "ACTOR", errors);
  const actorById = new Map(protocol.actors.map((value) => [value.id, value]));
  idSet(protocol.coordination, "COORDINATION", errors);
  const versionIds = idSet(protocol.contextVersions, "CONTEXT-VERSION", errors);
  idSet(protocol.contextTransformations, "CONTEXT-TRANSFORMATION", errors);
  idSet(protocol.usageRecords, "USAGE", errors);

  for (const goalValue of protocol.goals) {
    if (!validProvenance(goalValue.provenance)) error("GOAL_PROVENANCE_INVALID", "Goal provenance is invalid", { kind: "goal", id: goalValue.id });
    if (goalValue.sessionId !== sessionId) error("GOAL_SESSION_MISMATCH", "Goal sessionId differs from canonical session", { kind: "goal", id: goalValue.id }, goalValue.provenance);
    if (!GOAL_STATUSES.has(goalValue.status)) error("GOAL_STATUS_INVALID", "Goal status is invalid", { kind: "goal", id: goalValue.id }, goalValue.provenance);
    if (goalValue.parentGoalId && !goalIds.has(goalValue.parentGoalId)) error("GOAL_PARENT_DANGLING", "Goal parent is not present", { kind: "goal", id: goalValue.id }, goalValue.provenance);
    if (goalValue.ownerActorId && !actorIds.has(goalValue.ownerActorId)) error("GOAL_OWNER_DANGLING", "Goal owner actor is not present", { kind: "goal", id: goalValue.id }, goalValue.provenance);
    for (const taskId of goalValue.taskIds) if (!taskIds.has(taskId)) error("GOAL_TASK_DANGLING", "Goal task is not present", { kind: "goal", id: goalValue.id }, goalValue.provenance);
  }
  for (const actorValue of protocol.actors) {
    if (!validProvenance(actorValue.provenance)) error("ACTOR_PROVENANCE_INVALID", "Actor provenance is invalid", { kind: "actor", id: actorValue.id });
    if (!ACTOR_KINDS.has(actorValue.kind)) error("ACTOR_KIND_INVALID", "Actor kind is invalid", { kind: "actor", id: actorValue.id }, actorValue.provenance);
    if (actorValue.sessionRef && !validRef(actorValue.sessionRef)) error("ACTOR_SESSION_REF_INVALID", "Actor session reference is incomplete", { kind: "actor", id: actorValue.id }, actorValue.provenance);
    if (actorValue.teamId && !actorIds.has(actorValue.teamId)) error("ACTOR_TEAM_DANGLING", "Actor team is not present", { kind: "actor", id: actorValue.id }, actorValue.provenance);
    if (actorValue.teamId && actorValue.teamId === actorValue.id) error("ACTOR_SELF_TEAM", "Actor cannot be its own team", { kind: "actor", id: actorValue.id }, actorValue.provenance);
    if (actorValue.teamId && actorById.get(actorValue.teamId)?.kind !== "team") error("ACTOR_TEAM_KIND_INVALID", "Actor teamId must reference a team actor", { kind: "actor", id: actorValue.id }, actorValue.provenance);
    if ((actorValue.memberActorIds || []).length > 0 && actorValue.kind !== "team") error("ACTOR_MEMBERS_REQUIRE_TEAM", "Only team actors may list members", { kind: "actor", id: actorValue.id }, actorValue.provenance);
    for (const memberId of actorValue.memberActorIds || []) {
      if (!actorIds.has(memberId)) error("ACTOR_MEMBER_DANGLING", "Actor team member is not present", { kind: "actor", id: actorValue.id }, actorValue.provenance);
      if (memberId === actorValue.id) error("ACTOR_SELF_MEMBER", "Actor cannot be a member of itself", { kind: "actor", id: actorValue.id }, actorValue.provenance);
    }
    for (const runId of actorValue.runIds || []) if (!runIds.has(runId)) error("ACTOR_RUN_DANGLING", "Actor run is not present", { kind: "actor", id: actorValue.id }, actorValue.provenance);
  }
  for (const observation of protocol.coordination) {
    if (!validProvenance(observation.provenance)) error("COORDINATION_PROVENANCE_INVALID", "Coordination provenance is invalid", { kind: "coordination", id: observation.id });
    if (observation.sessionId !== sessionId) error("COORDINATION_SESSION_MISMATCH", "Coordination sessionId differs from canonical session", { kind: "coordination", id: observation.id }, observation.provenance);
    if (!COORDINATION_KINDS.has(observation.kind)) error("COORDINATION_KIND_INVALID", "Coordination kind is invalid", { kind: "coordination", id: observation.id }, observation.provenance);
    if (observation.state !== undefined && !COORDINATION_STATES.has(observation.state)) error("COORDINATION_STATE_INVALID", "Coordination state is invalid", { kind: "coordination", id: observation.id }, observation.provenance);
    if (observation.relationshipType && !RELATIONSHIP_TYPES.has(observation.relationshipType)) error("COORDINATION_RELATIONSHIP_INVALID", "Coordination relationship type is invalid", { kind: "coordination", id: observation.id }, observation.provenance);
    if (observation.senderActorId && !actorIds.has(observation.senderActorId)) error("COORDINATION_SENDER_DANGLING", "Coordination sender actor is not present", { kind: "coordination", id: observation.id }, observation.provenance);
    if (observation.recipientActorId && !actorIds.has(observation.recipientActorId)) error("COORDINATION_RECIPIENT_DANGLING", "Coordination recipient actor is not present", { kind: "coordination", id: observation.id }, observation.provenance);
    for (const sessionRef of [observation.fromSessionRef, observation.toSessionRef]) if (sessionRef && !validRef(sessionRef)) error("COORDINATION_SESSION_REF_INVALID", "Coordination session reference is incomplete", { kind: "coordination", id: observation.id }, observation.provenance);
    if (observation.taskId && !taskIds.has(observation.taskId)) error("COORDINATION_TASK_DANGLING", "Coordination task is not present", { kind: "coordination", id: observation.id }, observation.provenance);
    if (observation.runId && !runIds.has(observation.runId)) error("COORDINATION_RUN_DANGLING", "Coordination run is not present", { kind: "coordination", id: observation.id }, observation.provenance);
    if (observation.eventId && !eventIds.has(observation.eventId)) error("COORDINATION_EVENT_DANGLING", "Coordination event is not present", { kind: "coordination", id: observation.id }, observation.provenance);
  }
  for (const version of protocol.contextVersions) {
    if (!validProvenance(version.provenance)) error("CONTEXT_VERSION_PROVENANCE_INVALID", "Context version provenance is invalid", { kind: "context-version", id: version.id });
    if (version.sessionId !== sessionId) error("CONTEXT_VERSION_SESSION_MISMATCH", "Context version sessionId differs from canonical session", { kind: "context-version", id: version.id }, version.provenance);
    for (const parentId of version.parentVersionIds) if (!versionIds.has(parentId)) error("CONTEXT_PARENT_DANGLING", "Context version parent is not present", { kind: "context-version", id: version.id }, version.provenance);
    for (const artifactId of version.artifactIds) if (!artifactIds.has(artifactId)) error("CONTEXT_ARTIFACT_DANGLING", "Context version artifact is not present", { kind: "context-version", id: version.id }, version.provenance);
  }
  for (const transformation of protocol.contextTransformations) {
    if (!validProvenance(transformation.provenance)) error("CONTEXT_TRANSFORMATION_PROVENANCE_INVALID", "Context transformation provenance is invalid", { kind: "context-transformation", id: transformation.id });
    if (transformation.sessionId !== sessionId) error("CONTEXT_TRANSFORMATION_SESSION_MISMATCH", "Context transformation sessionId differs from canonical session", { kind: "context-transformation", id: transformation.id }, transformation.provenance);
    if (!TRANSFORMATION_KINDS.has(transformation.kind)) error("CONTEXT_TRANSFORMATION_KIND_INVALID", "Context transformation kind is invalid", { kind: "context-transformation", id: transformation.id }, transformation.provenance);
    for (const sourceId of transformation.sourceVersionIds) if (!versionIds.has(sourceId)) error("CONTEXT_SOURCE_DANGLING", "Context transformation source is not present", { kind: "context-transformation", id: transformation.id }, transformation.provenance);
    if (transformation.resultVersionId && !versionIds.has(transformation.resultVersionId)) error("CONTEXT_RESULT_DANGLING", "Context transformation result is not present", { kind: "context-transformation", id: transformation.id }, transformation.provenance);
    for (const artifactId of [...transformation.sourceArtifactIds, ...transformation.resultArtifactIds]) if (!artifactIds.has(artifactId)) error("CONTEXT_TRANSFORMATION_ARTIFACT_DANGLING", "Context transformation artifact is not present", { kind: "context-transformation", id: transformation.id }, transformation.provenance);
    if (!transformation.resultVersionId && transformation.resultArtifactIds.length === 0) error("CONTEXT_TRANSFORMATION_RESULT_MISSING", "Context transformation requires an observed result version or artifact", { kind: "context-transformation", id: transformation.id }, transformation.provenance);
    if (transformation.eventId && !eventIds.has(transformation.eventId)) error("CONTEXT_TRANSFORMATION_EVENT_DANGLING", "Context transformation event is not present", { kind: "context-transformation", id: transformation.id }, transformation.provenance);
    if (transformation.runId && !runIds.has(transformation.runId)) error("CONTEXT_TRANSFORMATION_RUN_DANGLING", "Context transformation run is not present", { kind: "context-transformation", id: transformation.id }, transformation.provenance);
  }
  for (const usage of protocol.usageRecords) {
    const usageRef = { kind: "usage", id: usage.id } as ProtocolEntityRef;
    if (!validProvenance(usage.provenance)) error("USAGE_PROVENANCE_INVALID", "Usage provenance is invalid", usageRef);
    if (!validRef(usage.sessionRef)) error("USAGE_SESSION_REF_INVALID", "Usage record requires a complete owning session reference", usageRef, usage.provenance);
    else if (usage.sessionRef.provider !== provider || usage.sessionRef.sessionId !== sessionId) error("USAGE_SESSION_REF_NOT_CANONICAL", "Usage record owner must be the canonical local session", usageRef, usage.provenance);
    if (!USAGE_SCOPES.has(usage.scope)) error("USAGE_SCOPE_INVALID", "Usage scope is invalid", usageRef, usage.provenance);
    if (usage.timestamp !== null && (typeof usage.timestamp !== "number" || !Number.isFinite(usage.timestamp))) error("USAGE_TIMESTAMP_INVALID", "Usage timestamp must be finite when present", usageRef, usage.provenance);
    if (usage.model !== null && !nonEmpty(usage.model)) error("USAGE_MODEL_INVALID", "Usage model must be non-empty when present", usageRef, usage.provenance);
    if (usage.runId && !runIds.has(usage.runId)) error("USAGE_RUN_DANGLING", "Usage run anchor is not present", usageRef, usage.provenance);
    if (usage.eventId && !eventIds.has(usage.eventId)) error("USAGE_EVENT_DANGLING", "Usage event anchor is not present", usageRef, usage.provenance);
    for (const anchor of [usage.runId, usage.eventId, usage.turnId]) if (anchor !== null && anchor !== undefined && !nonEmpty(anchor)) error("USAGE_ANCHOR_INVALID", "Usage anchors must be non-empty when present", usageRef, usage.provenance);
    for (const [key, value] of Object.entries(usage.tokens || {})) {
      if (!TOKEN_COMPONENTS.has(key)) error("USAGE_TOKEN_KEY_UNKNOWN", `Usage token component ${key} is unknown`, usageRef, usage.provenance);
      else if (value != null && !tokenValue(value)) error("USAGE_TOKEN_INVALID", `Usage token component ${key} must be a nonnegative integer`, usageRef, usage.provenance);
    }
    const totals = new Map<ContextOriginComponent, number>();
    for (const slice of usage.contextOriginSlices || []) {
      if (!ORIGIN_COMPONENTS.has(slice.component)) error("USAGE_ORIGIN_COMPONENT_INVALID", "Usage context origin component is invalid", usageRef, usage.provenance);
      if (!ORIGINS.has(slice.origin)) error("USAGE_ORIGIN_INVALID", "Usage context origin is invalid", usageRef, usage.provenance);
      if (!tokenValue(slice.tokens)) error("USAGE_ORIGIN_TOKENS_INVALID", "Usage context origin tokens must be a nonnegative integer", usageRef, usage.provenance);
      if ((slice as unknown as Record<string, unknown>).component === "output" || (slice as unknown as Record<string, unknown>).component === "reasoning") error("USAGE_ORIGIN_FORBIDDEN_COMPONENT", "Output and reasoning cannot have context-origin attribution", usageRef, usage.provenance);
      for (const sourceRef of slice.sourceSessionRefs || []) if (!validRef(sourceRef)) error("USAGE_ORIGIN_SOURCE_REF_INVALID", "Usage context origin source session reference is incomplete", usageRef, usage.provenance);
      if (ORIGIN_COMPONENTS.has(slice.component)) totals.set(slice.component, (totals.get(slice.component) || 0) + slice.tokens);
    }
    for (const component of ORIGIN_COMPONENTS) {
      const sum = totals.get(component) || 0;
      const bound = usage.tokens?.[component] ?? null;
      if (sum > 0 && (bound == null || sum > bound)) error("USAGE_ORIGIN_EXCEEDS_COMPONENT", `Context origin slices exceed ${component} tokens`, usageRef, usage.provenance);
    }
    const total = usage.tokens?.total;
    const input = usage.tokens?.input || 0;
    const output = usage.tokens?.output || 0;
    const reasoning = usage.tokens?.reasoning || 0;
    const cacheRead = usage.tokens?.cacheRead || 0;
    const cacheWrite = usage.tokens?.cacheWrite || 0;
    if (total != null && total < input + cacheRead + cacheWrite + output + reasoning) error("USAGE_TOTAL_BELOW_COMPONENTS", "Usage total is below all token components", usageRef, usage.provenance);
  }

  const lineage = new Map<string, string[]>();
  for (const version of protocol.contextVersions) lineage.set(version.id, version.parentVersionIds);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) { error("CONTEXT_LINEAGE_CYCLE", "Context version lineage contains a cycle", { kind: "context-version", id }); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const parent of lineage.get(id) || []) visit(parent);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of lineage.keys()) visit(id);

  const goalParents = new Map(protocol.goals.map((value) => [value.id, value.parentGoalId ? [value.parentGoalId] : []]));
  const goalVisiting = new Set<string>();
  const goalVisited = new Set<string>();
  const visitGoal = (id: string) => {
    if (goalVisiting.has(id)) { error("GOAL_LINEAGE_CYCLE", "Goal lineage contains a cycle", { kind: "goal", id }); return; }
    if (goalVisited.has(id)) return;
    goalVisiting.add(id);
    for (const parent of goalParents.get(id) || []) visitGoal(parent);
    goalVisiting.delete(id);
    goalVisited.add(id);
  };
  for (const id of goalParents.keys()) visitGoal(id);

  for (const domain of ["work", "execution", "coordination", "context", "usage"] as const) {
    const coverage = protocol.coverage?.[domain];
    if (!coverage || !COVERAGE_STATES.has(coverage.state)) { error("COVERAGE_INVALID", `Coverage for ${domain} is invalid`); continue; }
    const count = factCount(domain, protocol);
    if (coverage.state === "observed" && count === 0) error("COVERAGE_OBSERVED_EMPTY", `Coverage ${domain} is observed but has no facts`);
    if (coverage.state !== "observed" && coverage.state !== "unknown" && count > 0) error("COVERAGE_ENTITY_CONTRADICTION", `Coverage ${domain} is ${coverage.state} but has facts`);
  }
  return {
    ok: errors.length === 0,
    completeness: errors.length ? "invalid" : warnings.length ? "partial" : "complete",
    errors: errors.slice(0, 100),
    warnings: warnings.slice(0, 100)
  };
}
