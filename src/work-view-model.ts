import type { SessionProtocolV3 } from "./providers/shared/session-protocol-v3.js";
import type {
  ContextProjection,
  ExecutionProjection,
  WorkProjection
} from "./protocol-runtime-v3.js";

const VISIBLE_TASK_LIMIT = 5;

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
  context: ContextProjection;
}): WorkOverviewModel {
  const { protocol, work, execution, context } = input;
  const goalEntry = work.goals.find((entry) => !entry.goal.parentGoalId) || work.goals[0] || null;
  const goal = goalEntry?.goal || null;
  const taskRuns = new Map<string, ExecutionProjection["runs"][number]["run"][]>();
  for (const relation of work.taskRuns) {
    const run = execution.runs.find((entry) => entityId(entry.ref) === entityId(relation.run))?.run;
    if (!run) continue;
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
