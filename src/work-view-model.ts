import type { SessionProtocolV3 } from "./providers/shared/session-protocol-v3.js";
import type {
  ContextProjection,
  CoordinationProjection,
  ExecutionProjection,
  WorkProjection
} from "./protocol-runtime-v3.js";

const VISIBLE_TASK_LIMIT = 5;
const VISIBLE_GRAPH_NODE_LIMIT = 9;

export interface WorkGraphNode {
  id: string;
  kind: "goal" | "task";
  label: string | null;
  state: string;
}

export interface WorkGraphEdge {
  from: string;
  to: string;
  kind: string;
  count: number;
  async: boolean;
  evidence: { kind: "goal" | "task" | "actor" | "coordination"; id: string }[];
}

export interface GoalTaskGraph {
  nodes: WorkGraphNode[];
  edges: WorkGraphEdge[];
  knownTotal: number;
  omitted: number;
  omittedEdges: number;
  unlinkedTasks: number;
  incomplete: boolean;
}

export interface CollaborationGraphNode {
  id: string;
  kind: "actor" | "team";
  label: string | null;
  state: string | null;
  teamId: string | null;
}

export interface CollaborationGraphEdge extends WorkGraphEdge {
  kinds: { kind: string; count: number }[];
}

export interface CollaborationGraph {
  nodes: CollaborationGraphNode[];
  edges: CollaborationGraphEdge[];
  knownTotal: number;
  omitted: number;
  omittedEdges: number;
  unplacedObservations: number;
  incomplete: boolean;
}

export interface WorkOverviewTask {
  id: string;
  task: WorkProjection["tasks"][number]["task"];
  runs: ExecutionProjection["runs"][number]["run"][];
  owner: string | null;
  elapsedMs: number | null;
  latestActivity: number | null;
}

export interface WorkOverviewContext {
  transformationKind: string | null;
  resultVersionRecorded: boolean;
  resultArtifactRecorded: boolean;
  tokensAfter: number | null;
  retainedSummary: string | null;
  hasResult: boolean;
  resultOrderUncertain: boolean;
  memoryCount: number;
  experienceCount: number;
  userInfoCount: number;
}

export interface WorkOverviewModel {
  goal: WorkProjection["goals"][number]["goal"] | null;
  tasks: WorkOverviewTask[];
  visibleTasks: WorkOverviewTask[];
  remainingTasks: WorkOverviewTask[];
  completedTasks: number;
  taskTotal: number;
  evidenceIncomplete: boolean;
  context: WorkOverviewContext;
  goalTaskGraph: GoalTaskGraph;
  collaborationGraph: CollaborationGraph;
}

function finiteTimestamp(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function elapsed(start: unknown, end: unknown): number | null {
  const started = finiteTimestamp(start);
  const finished = finiteTimestamp(end);
  return started !== null && finished !== null && finished >= started ? finished - started : null;
}

function maxTimestamp(values: unknown[]): number | null {
  const timestamps = values.map(finiteTimestamp).filter((value): value is number => value !== null);
  return timestamps.length ? Math.max(...timestamps) : null;
}

function entityId(ref: { id?: string } | { ref?: { sessionId?: string } } | null | undefined): string | null {
  if (!ref) return null;
  if (typeof (ref as { id?: unknown }).id === "string") return (ref as { id: string }).id;
  return (ref as { ref?: { sessionId?: string } }).ref?.sessionId || null;
}

function resultArtifactId(context: ContextProjection, transformationId: string): string | null {
  const relation = context.transformationArtifacts.find((candidate) => (
    candidate.role === "result"
    && entityId(candidate.transformation) === transformationId
  ));
  return entityId(relation?.artifact) || null;
}

function projectionEntityId(ref: { id?: string } | { ref?: { sessionId?: string } } | null | undefined): string | null {
  return entityId(ref);
}

function goalTaskGraph(work: WorkProjection): GoalTaskGraph {
  const taskEntries = work.tasks;
  const taskIds = new Set(taskEntries.map((entry) => entry.task.id));
  const goalEntries = work.goals;
  const goalIds = new Set(goalEntries.map((entry) => entry.goal.id));
  const nodes: WorkGraphNode[] = [
    ...goalEntries.map(({ goal }) => ({ id: goal.id, kind: "goal" as const, label: goal.title || goal.description || null, state: goal.status })),
    ...taskEntries.map(({ task }) => ({ id: task.id, kind: "task" as const, label: task.title || task.agentPath || null, state: task.status }))
  ];
  const allEdges: WorkGraphEdge[] = [];
  for (const relation of work.memberships) {
    const relationGoalId = projectionEntityId(relation.goal);
    const taskId = projectionEntityId(relation.task);
    if (relationGoalId && goalIds.has(relationGoalId) && taskId && taskIds.has(taskId)) {
      allEdges.push({ from: relationGoalId, to: taskId, kind: "membership", count: 1, async: false, evidence: [{ kind: "goal", id: relationGoalId }, { kind: "task", id: taskId }] });
    }
  }
  for (const relation of work.dependencies) {
    const from = projectionEntityId(relation.from);
    const to = projectionEntityId(relation.to);
    if (from && to && taskIds.has(from) && taskIds.has(to)) {
      allEdges.push({ from, to, kind: "dependency", count: 1, async: false, evidence: [{ kind: "task", id: from }, { kind: "task", id: to }] });
    }
  }
  const visibleNodes = nodes.slice(0, VISIBLE_GRAPH_NODE_LIMIT);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const edges = allEdges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  return {
    nodes: visibleNodes,
    edges,
    knownTotal: nodes.length,
    omitted: Math.max(0, nodes.length - visibleNodes.length),
    omittedEdges: allEdges.length - edges.length,
    unlinkedTasks: taskEntries.filter(({ task }) => !allEdges.some((edge) => edge.kind === "membership" && edge.to === task.id)).length,
    incomplete: work.truncated || work.completeness !== "complete"
  };
}

function collaborationGraph(execution: ExecutionProjection, coordination: CoordinationProjection): CollaborationGraph {
  const allNodes: CollaborationGraphNode[] = execution.actors.map(({ actor }) => ({
    id: actor.id,
    kind: actor.kind === "team" ? "team" : "actor",
    label: actor.name || null,
    state: null,
    teamId: actor.teamId || null
  }));
  const actorIds = new Set(allNodes.map((node) => node.id));
  const runModes = new Map(execution.runs.map(({ ref, run }) => [projectionEntityId(ref), run.mode]));
  const allEdges: CollaborationGraphEdge[] = [];
  for (const relation of execution.actorMembers) {
    const teamId = projectionEntityId(relation.team);
    const memberId = projectionEntityId(relation.member);
    if (teamId && memberId && actorIds.has(teamId) && actorIds.has(memberId)) {
      allEdges.push({ from: teamId, to: memberId, kind: "member", count: 1, async: false, evidence: [{ kind: "actor", id: teamId }, { kind: "actor", id: memberId }], kinds: [{ kind: "member", count: 1 }] });
    }
  }
  const observationEdges = new Map<string, CollaborationGraphEdge>();
  let unplacedObservations = 0;
  for (const entry of coordination.observations) {
    const observation = entry.observation;
    const from = observation.senderActorId || null;
    const to = observation.recipientActorId || null;
    if (!from || !to || !actorIds.has(from) || !actorIds.has(to)) {
      unplacedObservations++;
      continue;
    }
    const key = `${from}\u0000${to}`;
    const asyncRecorded = observation.runId != null
      && (runModes.get(observation.runId) === "background" || runModes.get(observation.runId) === "scheduled");
    const edge = observationEdges.get(key) || { from, to, kind: "observation", count: 0, async: true, evidence: [], kinds: [] };
    edge.count++;
    edge.async = edge.async && asyncRecorded;
    edge.evidence.push({ kind: "coordination", id: observation.id });
    const kind = observation.kind || "unknown";
    const kindEntry = edge.kinds.find((candidate) => candidate.kind === kind);
    if (kindEntry) kindEntry.count++;
    else edge.kinds.push({ kind, count: 1 });
    observationEdges.set(key, edge);
  }
  allEdges.push(...observationEdges.values());
  const visibleNodes = allNodes.slice(0, VISIBLE_GRAPH_NODE_LIMIT);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const edges = allEdges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  return {
    nodes: visibleNodes,
    edges,
    knownTotal: allNodes.length,
    omitted: Math.max(0, allNodes.length - visibleNodes.length),
    omittedEdges: allEdges.length - edges.length,
    unplacedObservations,
    incomplete: coordination.truncated || coordination.completeness !== "complete"
  };
}

type ContextResultCandidate = {
  transformation: ContextProjection["transformations"][number] | null;
  version: ContextProjection["versions"][number] | null;
  timestamp: number | null;
  sequence: number | null;
  sequenceDomain: "context-version" | "event" | null;
};

function contextVersionIsAncestor(
  parentsByVersion: Map<string, string[]>,
  ancestorId: string | null,
  descendantId: string | null
): boolean {
  if (!ancestorId || !descendantId || ancestorId === descendantId) return false;
  const visited = new Set<string>();
  const pending = [descendantId];
  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const parentId of parentsByVersion.get(current) || []) {
      if (parentId === ancestorId) return true;
      pending.push(parentId);
    }
  }
  return false;
}

function contextResultOrder(
  parentsByVersion: Map<string, string[]>,
  candidate: ContextResultCandidate,
  other: ContextResultCandidate
): number | null {
  const candidateVersionId = entityId(candidate.version?.ref);
  const otherVersionId = entityId(other.version?.ref);
  if (contextVersionIsAncestor(parentsByVersion, candidateVersionId, otherVersionId)) return -1;
  if (contextVersionIsAncestor(parentsByVersion, otherVersionId, candidateVersionId)) return 1;
  if (candidate.timestamp !== null && other.timestamp !== null && candidate.timestamp !== other.timestamp) {
    return candidate.timestamp - other.timestamp;
  }
  if (candidate.sequenceDomain && candidate.sequenceDomain === other.sequenceDomain
    && candidate.sequence !== null && other.sequence !== null && candidate.sequence !== other.sequence) {
    return candidate.sequence - other.sequence;
  }
  return candidate.sequenceDomain === other.sequenceDomain
    && candidate.sequence === other.sequence
    && candidate.timestamp === other.timestamp ? 0 : null;
}

function latestContextResult(context: ContextProjection, protocol: SessionProtocolV3) {
  const transformations = context.transformations;
  const versions = context.versions;
  const parentsByVersion = new Map<string, string[]>();
  for (const relation of context.versionParents) {
    const versionId = entityId(relation.version);
    const parentId = entityId(relation.parent);
    if (!versionId || !parentId) continue;
    const parents = parentsByVersion.get(versionId) || [];
    parents.push(parentId);
    parentsByVersion.set(versionId, parents);
  }
  const candidates: ContextResultCandidate[] = [];
  const linkedVersionIds = new Set<string>();
  const eventFor = (transformation: ContextProjection["transformations"][number]["transformation"]) => (
    transformation.eventId ? protocol.events.find((event) => event.id === transformation.eventId) : null
  );
  for (const entry of transformations) {
    const transformation = entry.transformation;
    const linkedVersion = transformation.resultVersionId
      ? versions.find((version) => entityId(version.ref) === transformation.resultVersionId) || null
      : null;
    if (linkedVersion) linkedVersionIds.add(transformation.resultVersionId!);
    const event = eventFor(transformation);
    candidates.push({
      transformation: entry,
      version: linkedVersion,
      timestamp: linkedVersion?.version.createdAt ?? transformation.timestamp ?? event?.timestamp ?? null,
      sequence: linkedVersion?.version.sequence ?? event?.sequence ?? null,
      sequenceDomain: linkedVersion?.version.sequence != null ? "context-version" : event?.sequence != null ? "event" : null
    });
  }
  for (const version of versions) {
    if (linkedVersionIds.has(entityId(version.ref) || "")) continue;
    candidates.push({
      transformation: null,
      version,
      timestamp: version.version.createdAt ?? null,
      sequence: version.version.sequence ?? null,
      sequenceDomain: version.version.sequence != null ? "context-version" : null
    });
  }
  if (!candidates.length) return { candidate: null, uncertain: false };
  const maxima = candidates.filter((candidate) => !candidates.some((other) => (
    other !== candidate && contextResultOrder(parentsByVersion, candidate, other) !== null && contextResultOrder(parentsByVersion, candidate, other)! < 0
  )));
  return {
    candidate: maxima.length === 1 ? maxima[0] : null,
    uncertain: maxima.length !== 1
  };
}

/**
 * Derive the bounded Work opening from finalized v3 facts and projections.
 * Projection arrays are already source-ordered and capped by the owning
 * projection builder; this model does not sort, widen, or infer provider data.
 */
export function deriveWorkOverview(input: {
  protocol: SessionProtocolV3;
  work: WorkProjection;
  execution: ExecutionProjection;
  coordination: CoordinationProjection;
  context: ContextProjection;
}): WorkOverviewModel {
  const { protocol, work, execution, coordination, context } = input;
  const goalEntry = work.goals.find((entry) => !entry.goal.parentGoalId) || work.goals[0] || null;
  const goal = goalEntry?.goal || null;
  const taskRuns = new Map<string, ExecutionProjection["runs"][number]["run"][]>();
  for (const relation of work.taskRuns) {
    const run = execution.runs.find((entry) => entityId(entry.ref) === entityId(relation.run))?.run;
    // Session-owned turns remain visible in Execution, but are not task
    // executions and therefore must not affect task progress or elapsed time.
    if (!run || run.kind === "session-turn") continue;
    const taskId = entityId(relation.task);
    if (!taskId) continue;
    const runs = taskRuns.get(taskId) || [];
    runs.push(run);
    taskRuns.set(taskId, runs);
  }

  const tasks = work.tasks.map(({ task }) => {
    const runs = taskRuns.get(task.id) || [];
    const latestRun = runs.reduce((latest, candidate) => {
      const latestTime = maxTimestamp([latest?.timeEnd, latest?.timeStart]);
      const candidateTime = maxTimestamp([candidate.timeEnd, candidate.timeStart]);
      return candidateTime !== null && (latestTime === null || candidateTime >= latestTime) ? candidate : latest;
    }, null as ExecutionProjection["runs"][number]["run"] | null);
    const runElapsed = latestRun ? elapsed(latestRun.timeStart, latestRun.timeEnd) : null;
    const taskElapsed = elapsed(task.timeCreated, task.timeCompleted);
    return {
      id: task.id,
      task,
      runs,
      owner: task.owner || task.assignee || latestRun?.agent || null,
      elapsedMs: runElapsed ?? taskElapsed,
      latestActivity: maxTimestamp([
        task.timeUpdated,
        task.timeCompleted,
        ...runs.flatMap((run) => [run.timeStart, run.timeEnd])
      ])
    };
  });

  const latestResult = latestContextResult(context, protocol);
  const latestCandidate = latestResult.candidate;
  const latestTransformation = latestCandidate?.transformation || null;
  const latestVersion = latestCandidate?.version || null;
  const transformation = latestTransformation?.transformation || null;
  const transformationEvent = transformation?.eventId
    ? protocol.events.find((event) => event.id === transformation.eventId)
    : null;
  const versionArtifactRelation = latestVersion
    ? context.versionArtifacts.find((relation) => entityId(relation.version) === entityId(latestVersion.ref))
    : null;
  const artifactId = (latestTransformation
    ? resultArtifactId(context, entityId(latestTransformation.ref) || "")
    : null) || entityId(versionArtifactRelation?.artifact);
  const artifact = artifactId
    ? context.artifacts.find((entry) => entityId(entry.ref) === artifactId)?.artifact || null
    : null;
  const resultVersionRecorded = Boolean(latestVersion);
  const resultArtifactRecorded = Boolean(artifact);
  const retainedSummary = transformationEvent?.compaction?.summary || artifact?.summary || null;
  const tokensAfter = transformationEvent?.compaction?.tokensAfter == null
    ? null
    : Number.isFinite(Number(transformationEvent.compaction.tokensAfter))
      ? Number(transformationEvent.compaction.tokensAfter)
      : null;
  const contextArtifacts = context.artifacts.map((entry) => entry.artifact);

  return {
    goal,
    tasks,
    visibleTasks: tasks.slice(0, VISIBLE_TASK_LIMIT),
    remainingTasks: tasks.slice(VISIBLE_TASK_LIMIT),
    completedTasks: tasks.filter(({ task }) => task.status === "completed").length,
    taskTotal: tasks.length,
    evidenceIncomplete: work.truncated || work.completeness !== "complete",
    goalTaskGraph: goalTaskGraph(work),
    collaborationGraph: collaborationGraph(execution, coordination),
    context: {
      transformationKind: transformation?.kind || (latestVersion ? "version" : null),
      resultVersionRecorded,
      resultArtifactRecorded,
      tokensAfter,
      retainedSummary,
      hasResult: Boolean(latestCandidate),
      resultOrderUncertain: latestResult.uncertain,
      memoryCount: contextArtifacts.filter((artifactValue) => artifactValue.kind === "memory").length,
      experienceCount: contextArtifacts.filter((artifactValue) => artifactValue.kind === "experience").length,
      userInfoCount: contextArtifacts.filter((artifactValue) => artifactValue.kind === "user-info").length
    }
  };
}

export { VISIBLE_TASK_LIMIT };
