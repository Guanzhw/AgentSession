import type {
  AgentRun,
  ContextArtifact,
  ProtocolEntityRef,
  SessionProtocol,
  SessionRef,
  SessionRelationship,
  Task
} from "./providers/shared/session-protocol.js";
import type {
  Actor,
  ContextOriginSlice,
  ContextTransformation,
  ContextVersion,
  CoordinationObservation,
  Goal,
  ProtocolCoverage,
  ProtocolDomainCoverage,
  SessionProtocolV3,
  UsageRecord
} from "./providers/shared/session-protocol-v3.js";

export const DEFAULT_V3_MAX_ITEMS = 100;
export const MAX_V3_MAX_ITEMS = 300;

export class ProtocolProjectionError extends Error {
  readonly code = "invalid_input" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProtocolProjectionError";
  }
}

export interface ProjectionOptions {
  maxItems?: number | string | null;
}

export interface ProjectionBase {
  version: 3;
  focus: SessionRef;
  coverage: ProtocolDomainCoverage;
  completeness: "complete" | "partial" | "invalid";
  diagnostics: NonNullable<SessionProtocolV3["validation"]>["warnings"];
  truncated: boolean;
  maxItems: number;
}

export interface EntityRef {
  ref: ProtocolEntityRef;
}

type PublicGoal = Omit<Goal, "taskIds">;
type PublicTask = Omit<Task, "dependencies" | "runIds" | "metadata">;
type PublicActor = Omit<Actor, "memberActorIds" | "runIds">;
type PublicRun = Omit<AgentRun, "metadata">;
type PublicUsage = Omit<UsageRecord, "contextOriginSlices">;
type PublicVersion = Omit<ContextVersion, "parentVersionIds" | "artifactIds">;
type PublicTransformation = Omit<ContextTransformation, "sourceVersionIds" | "resultArtifactIds" | "sourceArtifactIds">;
type PublicArtifact = Omit<ContextArtifact, "consumerRunIds" | "citationEventIds" | "inheritedFromArtifactIds" | "sourceSessionIds" | "metadata">;

export interface WorkTask extends EntityRef {
  task: PublicTask;
}

export interface WorkGoal extends EntityRef {
  goal: PublicGoal;
}

export interface WorkDependency {
  from: ProtocolEntityRef;
  to: ProtocolEntityRef;
  provenance: Task["provenance"];
}

export interface WorkGoalTask {
  goal: ProtocolEntityRef;
  task: ProtocolEntityRef;
  provenance: Goal["provenance"];
}

export interface WorkTaskRun {
  task: ProtocolEntityRef;
  run: ProtocolEntityRef;
  provenance: Task["provenance"];
}

export interface WorkProjection extends ProjectionBase {
  domain: "work";
  goals: WorkGoal[];
  tasks: WorkTask[];
  dependencies: WorkDependency[];
  memberships: WorkGoalTask[];
  taskRuns: WorkTaskRun[];
}

export interface ExecutionActor extends EntityRef {
  actor: PublicActor;
}

export interface ExecutionRun extends EntityRef {
  run: PublicRun;
  task: ProtocolEntityRef | null;
  childSession: SessionRef | null;
}

export interface UsageAggregate {
  requestCount: number;
  complete: boolean;
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
  total: number | null;
}

export interface ExecutionUsage extends EntityRef {
  usage: PublicUsage;
}

export interface ExecutionActorMember {
  team: ProtocolEntityRef;
  member: ProtocolEntityRef;
  provenance: Actor["provenance"];
}

export interface ExecutionActorRun {
  actor: ProtocolEntityRef;
  run: ProtocolEntityRef;
  provenance: Actor["provenance"];
}

export interface ExecutionProjection extends ProjectionBase {
  domain: "execution";
  usageCoverage: ProtocolDomainCoverage;
  actors: ExecutionActor[];
  runs: ExecutionRun[];
  usageRecords: ExecutionUsage[];
  actorMembers: ExecutionActorMember[];
  actorRuns: ExecutionActorRun[];
  usage: UsageAggregate;
}

export interface CoordinationLineage {
  from: SessionRef;
  to: SessionRef;
  type: SessionRelationship["type"];
  timestamp: number | null;
  provenance: SessionRelationship["provenance"];
}

export interface CoordinationObservationProjection extends EntityRef {
  observation: CoordinationObservation;
}

export interface CoordinationProjection extends ProjectionBase {
  domain: "coordination";
  observations: CoordinationObservationProjection[];
  lineage: CoordinationLineage[];
}

export interface ContextArtifactProjection extends EntityRef {
  artifact: PublicArtifact;
}

export interface ContextVersionProjection extends EntityRef {
  version: PublicVersion;
}

export interface ContextTransformationProjection extends EntityRef {
  transformation: PublicTransformation;
}

export interface ContextOriginProjection {
  usage: ProtocolEntityRef;
  component: ContextOriginSlice["component"];
  origin: ContextOriginSlice["origin"];
  tokens: number;
}

export interface ContextOriginSource {
  usage: ProtocolEntityRef;
  component: ContextOriginSlice["component"];
  origin: ContextOriginSlice["origin"];
  tokens: number;
  sourceSession: SessionRef;
}

export interface ContextVersionParent {
  version: ProtocolEntityRef;
  parent: ProtocolEntityRef;
  provenance: ContextVersion["provenance"];
}

export interface ContextVersionArtifact {
  version: ProtocolEntityRef;
  artifact: ProtocolEntityRef;
  provenance: ContextVersion["provenance"];
}

export interface ContextTransformationVersion {
  transformation: ProtocolEntityRef;
  version: ProtocolEntityRef;
  role: "source" | "result";
  provenance: ContextTransformation["provenance"];
}

export interface ContextTransformationArtifact {
  transformation: ProtocolEntityRef;
  artifact: ProtocolEntityRef;
  role: "source" | "result";
  provenance: ContextTransformation["provenance"];
}

export interface ContextArtifactSession {
  artifact: ProtocolEntityRef;
  sourceSession: SessionRef;
  provenance: ContextArtifact["provenance"];
}

export interface ContextArtifactRun {
  artifact: ProtocolEntityRef;
  run: ProtocolEntityRef;
  role: "producer" | "consumer";
  provenance: ContextArtifact["provenance"];
}

export interface ContextArtifactEvent {
  artifact: ProtocolEntityRef;
  event: ProtocolEntityRef;
  role: "producer" | "citation";
  provenance: ContextArtifact["provenance"];
}

export interface ContextArtifactInheritance {
  artifact: ProtocolEntityRef;
  parentArtifact: ProtocolEntityRef;
  provenance: ContextArtifact["provenance"];
}

export interface ContextProjection extends ProjectionBase {
  domain: "context";
  usageCoverage: ProtocolDomainCoverage;
  artifacts: ContextArtifactProjection[];
  versions: ContextVersionProjection[];
  transformations: ContextTransformationProjection[];
  origins: ContextOriginProjection[];
  originSources: ContextOriginSource[];
  versionParents: ContextVersionParent[];
  versionArtifacts: ContextVersionArtifact[];
  transformationVersions: ContextTransformationVersion[];
  transformationArtifacts: ContextTransformationArtifact[];
  artifactSessions: ContextArtifactSession[];
  artifactRuns: ContextArtifactRun[];
  artifactEvents: ContextArtifactEvent[];
  artifactInheritance: ContextArtifactInheritance[];
}

type Collectable = { truncated: boolean; count: number };

function limit(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_V3_MAX_ITEMS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_V3_MAX_ITEMS) {
    throw new ProtocolProjectionError(`maxItems must be an integer between 1 and ${MAX_V3_MAX_ITEMS}.`);
  }
  return parsed;
}

function focusOf(protocol: SessionProtocolV3): SessionRef {
  if (!protocol.session?.ref?.provider || !protocol.session.ref.sessionId) {
    throw new ProtocolProjectionError("Session Protocol v3 is missing its canonical focus reference.");
  }
  return protocol.session.ref;
}

function diagnosticsOf(protocol: SessionProtocolV3) {
  return [
    ...(protocol.validation?.errors || []),
    ...(protocol.validation?.warnings || [])
  ].slice(0, 100);
}

function base(protocol: SessionProtocolV3, domain: keyof ProtocolCoverage, maxItems: number): ProjectionBase {
  return {
    version: 3,
    focus: focusOf(protocol),
    coverage: protocol.coverage[domain],
    completeness: protocol.completeness || "partial",
    diagnostics: diagnosticsOf(protocol),
    truncated: false,
    maxItems
  };
}

function entityRef(kind: ProtocolEntityRef["kind"], id: string): ProtocolEntityRef {
  // Entity ids are session-local protocol ids. The projection's canonical
  // focus carries the owning provider/session reference; do not invent a
  // second identity by prefixing provider data into the fact id.
  return { kind, id } as ProtocolEntityRef;
}

function collect<T>(values: readonly T[], maxItems: number, state: Collectable, visit: (value: T) => void): void {
  for (let index = 0; index < values.length; index += 1) {
    if (state.count >= maxItems) {
      state.truncated = true;
      return;
    }
    state.count += 1;
    visit(values[index]);
  }
}

function taskRef(task: Task): ProtocolEntityRef {
  return entityRef("task", task.id);
}

function runRef(run: AgentRun): ProtocolEntityRef {
  return entityRef("run", run.id);
}

function artifactRef(artifact: ContextArtifact): ProtocolEntityRef {
  return entityRef("artifact", artifact.id);
}

function publicGoal(goal: Goal): PublicGoal {
  const { taskIds: _taskIds, ...value } = goal;
  return value;
}

function publicTask(task: Task): PublicTask {
  const { metadata: _metadata, dependencies: _dependencies, runIds: _runIds, ...value } = task;
  return value;
}

function publicRun(run: AgentRun): PublicRun {
  const { metadata: _metadata, ...value } = run;
  return value;
}

function publicActor(actor: Actor): PublicActor {
  const { memberActorIds: _memberActorIds, runIds: _runIds, ...value } = actor;
  return value;
}

function publicUsage(usage: UsageRecord): PublicUsage {
  const { contextOriginSlices: _contextOriginSlices, ...value } = usage;
  return value;
}

function publicVersion(version: ContextVersion): PublicVersion {
  const { parentVersionIds: _parentVersionIds, artifactIds: _artifactIds, ...value } = version;
  return value;
}

function publicTransformation(transformation: ContextTransformation): PublicTransformation {
  const { sourceVersionIds: _sourceVersionIds, sourceArtifactIds: _sourceArtifactIds, resultArtifactIds: _resultArtifactIds, ...value } = transformation;
  return value;
}

function publicArtifact(artifact: ContextArtifact): PublicArtifact {
  const { consumerRunIds: _consumerRunIds, citationEventIds: _citationEventIds, inheritedFromArtifactIds: _inheritedFromArtifactIds, sourceSessionIds: _sourceSessionIds, metadata: _metadata, ...value } = artifact;
  return value;
}

function sumUsage(records: readonly UsageRecord[], complete: boolean, coverage: ProtocolDomainCoverage): UsageAggregate {
  const hasNoObservedUsage = records.length === 0 && coverage.state !== "not-observed";
  const aggregate: UsageAggregate = {
    requestCount: records.length,
    complete: complete && !hasNoObservedUsage,
    input: hasNoObservedUsage ? null : 0,
    cacheRead: hasNoObservedUsage ? null : 0,
    cacheWrite: hasNoObservedUsage ? null : 0,
    output: hasNoObservedUsage ? null : 0,
    reasoning: hasNoObservedUsage ? null : 0,
    total: hasNoObservedUsage ? null : 0
  };
  if (records.length > 0 && coverage.state !== "observed") aggregate.complete = false;
  let hasAuthoritativeTotal = true;
  const component = (name: "input" | "cacheRead" | "cacheWrite" | "output" | "reasoning"): number | null => {
    if (hasNoObservedUsage) return null;
    if (records.length === 0) return 0;
    if (records.some((record) => record.tokens[name] == null)) return null;
    return records.reduce((sum, record) => sum + (record.tokens[name] || 0), 0);
  };
  aggregate.input = component("input");
  aggregate.cacheRead = component("cacheRead");
  aggregate.cacheWrite = component("cacheWrite");
  aggregate.output = component("output");
  aggregate.reasoning = component("reasoning");
  for (const record of records) {
    if (record.tokens.total == null) hasAuthoritativeTotal = false;
    else aggregate.total = (aggregate.total || 0) + record.tokens.total;
  }
  if (!hasAuthoritativeTotal) aggregate.total = null;
  if (!hasAuthoritativeTotal || [aggregate.input, aggregate.cacheRead, aggregate.cacheWrite, aggregate.output, aggregate.reasoning].some((value) => value === null)) {
    aggregate.complete = false;
  }
  return aggregate;
}

export function projectWork(protocol: SessionProtocolV3, options: ProjectionOptions = {}): WorkProjection {
  const maxItems = limit(options.maxItems);
  const result = base(protocol, "work", maxItems) as WorkProjection;
  result.domain = "work";
  result.goals = [];
  result.tasks = [];
  result.dependencies = [];
  result.memberships = [];
  result.taskRuns = [];
  const state = { count: 0, truncated: false };
  collect(protocol.goals, maxItems, state, (goal) => result.goals.push({ goal: publicGoal(goal), ref: entityRef("goal", goal.id) }));
  collect(protocol.tasks, maxItems, state, (task) => result.tasks.push({ task: publicTask(task), ref: taskRef(task) }));
  for (let index = 0; index < result.goals.length; index += 1) {
    for (const taskId of protocol.goals[index].taskIds || []) {
      if (state.count >= maxItems) { state.truncated = true; break; }
      state.count += 1;
      result.memberships.push({ goal: result.goals[index].ref, task: entityRef("task", taskId), provenance: protocol.goals[index].provenance });
    }
    if (state.truncated) break;
  }
  for (let index = 0; index < result.tasks.length && !state.truncated; index += 1) {
    const task = protocol.tasks[index];
    for (const dependency of task.dependencies || []) {
      if (state.count >= maxItems) { state.truncated = true; break; }
      state.count += 1;
      result.dependencies.push({ from: result.tasks[index].ref, to: entityRef("task", dependency), provenance: task.provenance });
    }
    for (const runId of task.runIds || []) {
      if (state.count >= maxItems) { state.truncated = true; break; }
      state.count += 1;
      result.taskRuns.push({ task: result.tasks[index].ref, run: entityRef("run", runId), provenance: task.provenance });
    }
  }
  result.truncated = state.truncated;
  return result;
}

export function projectExecution(protocol: SessionProtocolV3, options: ProjectionOptions = {}): ExecutionProjection {
  const maxItems = limit(options.maxItems);
  const focus = focusOf(protocol);
  const result = base(protocol, "execution", maxItems) as ExecutionProjection;
  result.domain = "execution";
  result.usageCoverage = protocol.coverage.usage;
  result.actors = [];
  result.runs = [];
  result.usageRecords = [];
  result.actorMembers = [];
  result.actorRuns = [];
  const state = { count: 0, truncated: false };
  collect(protocol.actors, maxItems, state, (actor) => result.actors.push({ actor: publicActor(actor), ref: entityRef("actor", actor.id) }));
  collect(protocol.agentRuns, maxItems, state, (run) => result.runs.push({
    run: publicRun(run),
    ref: runRef(run),
    task: run.taskId ? entityRef("task", run.taskId) : null,
    childSession: run.childSessionId ? { provider: focus.provider, sessionId: run.childSessionId } : null
  }));
  for (let index = 0; index < result.actors.length && !state.truncated; index += 1) {
    const actor = protocol.actors[index];
    for (const memberId of actor.memberActorIds || []) {
      if (state.count >= maxItems) { state.truncated = true; break; }
      state.count += 1;
      result.actorMembers.push({ team: result.actors[index].ref, member: entityRef("actor", memberId), provenance: actor.provenance });
    }
    for (const runId of actor.runIds || []) {
      if (state.count >= maxItems) { state.truncated = true; break; }
      state.count += 1;
      result.actorRuns.push({ actor: result.actors[index].ref, run: entityRef("run", runId), provenance: actor.provenance });
    }
  }
  collect(protocol.usageRecords, maxItems, state, (usage) => result.usageRecords.push({ usage: publicUsage(usage), ref: entityRef("usage", usage.id) }));
  result.usage = sumUsage(
    result.usageRecords.map((value) => value.usage),
    result.usageRecords.length === protocol.usageRecords.length,
    protocol.coverage.usage
  );
  result.truncated = state.truncated;
  return result;
}

export function projectCoordination(protocol: SessionProtocolV3, options: ProjectionOptions = {}): CoordinationProjection {
  const maxItems = limit(options.maxItems);
  const focus = focusOf(protocol);
  const result = base(protocol, "coordination", maxItems) as CoordinationProjection;
  result.domain = "coordination";
  result.observations = [];
  result.lineage = [];
  const state = { count: 0, truncated: false };
  collect(protocol.coordination, maxItems, state, (observation) => result.observations.push({ observation, ref: entityRef("coordination", observation.id) }));
  collect(protocol.relationships, maxItems, state, (relationship) => {
    const from = relationship.fromRef || { provider: focus.provider, sessionId: relationship.fromSessionId };
    const to = relationship.toRef || { provider: focus.provider, sessionId: relationship.toSessionId };
    result.lineage.push({ from, to, type: relationship.type, timestamp: relationship.timestamp ?? null, provenance: relationship.provenance });
  });
  result.truncated = state.truncated;
  return result;
}

export function projectContext(protocol: SessionProtocolV3, options: ProjectionOptions = {}): ContextProjection {
  const maxItems = limit(options.maxItems);
  const focus = focusOf(protocol);
  const result = base(protocol, "context", maxItems) as ContextProjection;
  result.domain = "context";
  result.usageCoverage = protocol.coverage.usage;
  result.artifacts = [];
  result.versions = [];
  result.transformations = [];
  result.origins = [];
  result.originSources = [];
  result.versionParents = [];
  result.versionArtifacts = [];
  result.transformationVersions = [];
  result.transformationArtifacts = [];
  result.artifactSessions = [];
  result.artifactRuns = [];
  result.artifactEvents = [];
  result.artifactInheritance = [];
  const state = { count: 0, truncated: false };
  collect(protocol.contextArtifacts, maxItems, state, (artifact) => result.artifacts.push({ artifact: publicArtifact(artifact), ref: artifactRef(artifact) }));
  collect(protocol.contextVersions, maxItems, state, (version) => result.versions.push({ version: publicVersion(version), ref: entityRef("context-version", version.id) }));
  collect(protocol.contextTransformations, maxItems, state, (transformation) => result.transformations.push({ transformation: publicTransformation(transformation), ref: entityRef("context-transformation", transformation.id) }));
  for (let index = 0; index < result.versions.length && !state.truncated; index += 1) {
    const version = protocol.contextVersions[index];
    for (const parentId of version.parentVersionIds || []) {
      if (state.count >= maxItems) { state.truncated = true; break; }
      state.count += 1;
      result.versionParents.push({ version: result.versions[index].ref, parent: entityRef("context-version", parentId), provenance: version.provenance });
    }
    for (const artifactId of version.artifactIds || []) {
      if (state.count >= maxItems) { state.truncated = true; break; }
      state.count += 1;
      result.versionArtifacts.push({ version: result.versions[index].ref, artifact: entityRef("artifact", artifactId), provenance: version.provenance });
    }
  }
  for (let index = 0; index < result.transformations.length && !state.truncated; index += 1) {
    const transformation = protocol.contextTransformations[index];
    for (const versionId of transformation.sourceVersionIds || []) {
      if (state.count >= maxItems) { state.truncated = true; break; }
      state.count += 1;
      result.transformationVersions.push({ transformation: result.transformations[index].ref, version: entityRef("context-version", versionId), role: "source", provenance: transformation.provenance });
    }
    if (transformation.resultVersionId && !state.truncated) {
      if (state.count >= maxItems) state.truncated = true;
      else {
        state.count += 1;
        result.transformationVersions.push({ transformation: result.transformations[index].ref, version: entityRef("context-version", transformation.resultVersionId), role: "result", provenance: transformation.provenance });
      }
    }
    for (const artifactId of transformation.sourceArtifactIds || []) {
      if (state.count >= maxItems) { state.truncated = true; break; }
      state.count += 1;
      result.transformationArtifacts.push({ transformation: result.transformations[index].ref, artifact: entityRef("artifact", artifactId), role: "source", provenance: transformation.provenance });
    }
    for (const artifactId of transformation.resultArtifactIds || []) {
      if (state.count >= maxItems) { state.truncated = true; break; }
      state.count += 1;
      result.transformationArtifacts.push({ transformation: result.transformations[index].ref, artifact: entityRef("artifact", artifactId), role: "result", provenance: transformation.provenance });
    }
  }
  for (let index = 0; index < result.artifacts.length && !state.truncated; index += 1) {
    const artifact = protocol.contextArtifacts[index];
    for (const sessionId of artifact.sourceSessionIds || []) {
      if (state.count >= maxItems) { state.truncated = true; break; }
      state.count += 1;
      result.artifactSessions.push({ artifact: result.artifacts[index].ref, sourceSession: { provider: focus.provider, sessionId }, provenance: artifact.provenance });
    }
    for (const runId of artifact.consumerRunIds || []) {
      if (state.count >= maxItems) { state.truncated = true; break; }
      state.count += 1;
      result.artifactRuns.push({ artifact: result.artifacts[index].ref, run: entityRef("run", runId), role: "consumer", provenance: artifact.provenance });
    }
    for (const eventId of artifact.citationEventIds || []) {
      if (state.count >= maxItems) { state.truncated = true; break; }
      state.count += 1;
      result.artifactEvents.push({ artifact: result.artifacts[index].ref, event: entityRef("event", eventId), role: "citation", provenance: artifact.provenance });
    }
    for (const parentId of artifact.inheritedFromArtifactIds || []) {
      if (state.count >= maxItems) { state.truncated = true; break; }
      state.count += 1;
      result.artifactInheritance.push({ artifact: result.artifacts[index].ref, parentArtifact: entityRef("artifact", parentId), provenance: artifact.provenance });
    }
  }
  let usageIndex = 0;
  let usageInspected = 0;
  for (; usageIndex < protocol.usageRecords.length && usageInspected < maxItems; usageIndex += 1) {
    const usage = protocol.usageRecords[usageIndex];
    usageInspected += 1;
    for (const slice of usage.contextOriginSlices || []) {
      if (state.count >= maxItems) { state.truncated = true; break; }
      state.count += 1;
      result.origins.push({
        usage: entityRef("usage", usage.id),
        component: slice.component,
        origin: slice.origin,
        tokens: slice.tokens
      });
      for (const sourceSession of slice.sourceSessionRefs || []) {
        if (state.count >= maxItems) { state.truncated = true; break; }
        state.count += 1;
        result.originSources.push({ usage: entityRef("usage", usage.id), component: slice.component, origin: slice.origin, tokens: slice.tokens, sourceSession });
      }
    }
    if (state.truncated) break;
  }
  if (usageIndex < protocol.usageRecords.length) state.truncated = true;
  result.truncated = state.truncated;
  return result;
}

export type V3Projection = WorkProjection | ExecutionProjection | CoordinationProjection | ContextProjection;

export function projectRuntimeDomain(protocol: SessionProtocolV3, domain: V3Projection["domain"], options: ProjectionOptions = {}): V3Projection {
  switch (domain) {
    case "work": return projectWork(protocol, options);
    case "execution": return projectExecution(protocol, options);
    case "coordination": return projectCoordination(protocol, options);
    case "context": return projectContext(protocol, options);
  }
}

export const buildWorkProjection = projectWork;
export const buildExecutionProjection = projectExecution;
export const buildCoordinationProjection = projectCoordination;
export const buildContextProjection = projectContext;
