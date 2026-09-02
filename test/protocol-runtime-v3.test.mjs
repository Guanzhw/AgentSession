import assert from "node:assert/strict";
import test from "node:test";

import {
  projectContext,
  projectCoordination,
  projectExecution,
  projectWork,
  ProtocolProjectionError
} from "../dist/src/protocol-runtime-v3.js";
import { upgradeSessionProtocolV2 } from "../dist/src/providers/shared/session-protocol-v3.js";

const provenance = { fidelity: "recorded", sourceType: "fixture" };

function v3Fixture() {
  const session = {
    ref: { provider: "fixture", sessionId: "root" }, state: "completed", origin: "fixture",
    timeCreated: 1, timeUpdated: 2, cwd: null, harness: "fixture", terminalOutcome: "completed",
    forkSeedBoundary: null, inheritedEventCount: null, provenance
  };
  return {
    version: 3, sessionId: "root", session, events: [], relationships: [], branches: [],
    tasks: [{ id: "task-1", sessionId: "root", kind: "task", status: "completed", title: "Inspect", dependencies: ["task-0"], runIds: ["run-1"], timeCreated: 1, timeUpdated: 2, timeCompleted: 2, metadata: { secret: "private" }, provenance }],
    agentRuns: [{ id: "run-1", sessionId: "root", taskId: "task-1", status: "completed", mode: "foreground", agent: "worker", model: "model", childSessionId: "child", timeStart: 1, timeEnd: 2, metadata: { secret: "private" }, provenance }],
    contextArtifacts: [{ id: "artifact-1", sessionId: "root", kind: "summary", scope: "session", origin: "provider-generated", contentAccess: "metadata-only", title: "Summary", summary: null, sourcePath: null, producerRunId: null, sourceSessionIds: [], hash: null, redacted: true, timeCreated: 2, metadata: { secret: "private" }, provenance }],
    goals: [{ id: "goal-1", sessionId: "root", title: "Goal", status: "active", taskIds: ["task-1"], timeCreated: 1, timeUpdated: 2, provenance }],
    actors: [{ id: "actor-1", kind: "agent", name: "worker", runIds: ["run-1"], provenance }],
    coordination: [{ id: "coord-1", sessionId: "root", kind: "message", state: "delivered", timestamp: 2, provenance }],
    contextVersions: [{ id: "version-1", sessionId: "root", parentVersionIds: [], artifactIds: ["artifact-1"], createdAt: 2, provenance }],
    contextTransformations: [{ id: "transform-1", sessionId: "root", kind: "compaction", sourceVersionIds: [], resultVersionId: "version-1", sourceArtifactIds: [], resultArtifactIds: [], timestamp: 2, provenance }],
    usageRecords: [{ id: "request-1", scope: "request", sessionRef: session.ref, runId: "run-1", timestamp: 2, model: "model", tokens: { input: 10, cacheRead: 2, cacheWrite: 0, output: 3, reasoning: 0, total: 15 }, contextOriginSlices: [{ component: "input", origin: "inherited", tokens: 4, sourceSessionRefs: [{ provider: "fixture", sessionId: "parent" }] }], provenance }],
    coverage: {
      work: { state: "observed", details: null }, execution: { state: "observed", details: null }, coordination: { state: "observed", details: null }, context: { state: "observed", details: null }, usage: { state: "observed", details: null }
    }
  };
}

test("v3 projections are typed, canonical, and bounded", () => {
  const protocol = v3Fixture();
  const work = projectWork(protocol, { maxItems: 2 });
  assert.equal(work.version, 3);
  assert.deepEqual(work.focus, { provider: "fixture", sessionId: "root" });
  assert.equal(work.coverage.state, "observed");
  assert.equal(work.goals[0].ref.id, "goal-1");
  assert.equal("metadata" in work.tasks[0].task, false);
  assert.ok(work.truncated);
  assert.ok(work.goals.length + work.tasks.length + work.dependencies.length + work.memberships.length + work.taskRuns.length <= 2);

  const execution = projectExecution(protocol);
  assert.deepEqual(execution.runs[0].childSession, { provider: "fixture", sessionId: "child" });
  assert.deepEqual(execution.usage, { requestCount: 1, complete: true, input: 10, cacheRead: 2, cacheWrite: 0, output: 3, reasoning: 0, total: 15 });
  assert.deepEqual(execution.usageCoverage, protocol.coverage.usage);
  assert.equal(execution.usageRecords[0].ref.id, "request-1");
  assert.equal("metadata" in execution.runs[0].run, false);

  const coordination = projectCoordination(protocol);
  assert.equal(coordination.observations[0].observation.kind, "message");
  assert.equal(coordination.lineage.length, 0);

  const context = projectContext(protocol);
  assert.equal(context.transformations[0].transformation.resultVersionId, "version-1");
  assert.equal("metadata" in context.artifacts[0].artifact, false);
  assert.deepEqual(context.origins[0].usage, { kind: "usage", id: "request-1" });
  assert.deepEqual(context.originSources[0].sourceSession, { provider: "fixture", sessionId: "parent" });
  assert.deepEqual(context.usageCoverage, protocol.coverage.usage);
});

test("v2 upgrade keeps new projection domains explicit and does not invent facts", () => {
  const source = {
    version: 2, sessionId: "root", session: v3Fixture().session, events: [], relationships: [],
    tasks: [], agentRuns: [], contextArtifacts: [], branches: []
  };
  const upgraded = upgradeSessionProtocolV2(source);
  assert.equal(projectCoordination(upgraded).observations.length, 0);
  assert.equal(projectContext(upgraded).transformations.length, 0);
  assert.equal(projectExecution(upgraded).usageRecords.length, 0);
  assert.equal(projectWork(upgraded).coverage.state, "unknown");
  assert.equal(projectExecution(upgraded).usage.complete, false);
  assert.equal(projectExecution(upgraded).usage.input, null);
  const notObserved = structuredClone(upgraded);
  notObserved.coverage.usage = { state: "not-observed", details: null };
  assert.deepEqual(projectExecution(notObserved).usage, { requestCount: 0, complete: true, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 });
  const unsupported = structuredClone(upgraded);
  unsupported.coverage.usage = { state: "unsupported", details: null };
  assert.equal(projectExecution(unsupported).usage.complete, false);
  assert.equal(projectExecution(unsupported).usage.input, null);
});

test("v3 projections reject invalid bounds and missing canonical focus", () => {
  assert.throws(() => projectWork(v3Fixture(), { maxItems: 0 }), ProtocolProjectionError);
  const invalid = v3Fixture();
  delete invalid.session;
  assert.throws(() => projectContext(invalid), /canonical focus reference/);
});

test("execution usage remains explicitly incomplete when totals or records are omitted by the bound", () => {
  const protocol = v3Fixture();
  protocol.usageRecords[0].tokens.total = null;
  const missingTotal = projectExecution(protocol);
  assert.equal(missingTotal.usage.total, null);
  assert.equal(missingTotal.usage.complete, false);

  const missingComponent = structuredClone(v3Fixture());
  missingComponent.usageRecords[0].tokens.cacheRead = null;
  const partial = projectExecution(missingComponent);
  assert.equal(partial.usage.cacheRead, null);
  assert.equal(partial.usage.input, 10);
  assert.equal(partial.usage.total, 15);
  assert.equal(partial.usage.complete, false);

  const actorLimited = structuredClone(v3Fixture());
  actorLimited.actors.push({ id: "actor-2", kind: "agent", name: "other", provenance });
  const limited = projectExecution(actorLimited, { maxItems: 1 });
  assert.equal(limited.usage.requestCount, 0);
  assert.equal(limited.usage.complete, false);
  assert.equal(limited.truncated, true);

  actorLimited.usageRecords = [];
  actorLimited.coverage.usage = { state: "not-observed", details: null };
  const knownEmpty = projectExecution(actorLimited, { maxItems: 1 });
  assert.equal(knownEmpty.truncated, true);
  assert.deepEqual(knownEmpty.usage, { requestCount: 0, complete: true, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 });
});

test("context projection reports truncation when bounded usage inspection misses later origins", () => {
  const protocol = structuredClone(v3Fixture());
  protocol.contextArtifacts = [];
  protocol.contextVersions = [];
  protocol.contextTransformations = [];
  protocol.usageRecords = Array.from({ length: 301 }, (_, index) => ({
    id: `request-${index}`, scope: "request", sessionRef: protocol.session.ref,
    tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 1 },
    contextOriginSlices: index === 300 ? [{ component: "input", origin: "shared", tokens: 1 }] : [], provenance
  }));
  const first = projectContext({ ...protocol, usageRecords: [protocol.usageRecords[0]] }, { maxItems: 1 });
  assert.equal(first.origins.length, 0);
  const available = projectContext({ ...protocol, usageRecords: [protocol.usageRecords[300]] }, { maxItems: 1 });
  assert.equal(available.origins.length, 1);
  const projection = projectContext(protocol, { maxItems: 300 });
  assert.equal(projection.origins.length, 0);
  assert.equal(projection.truncated, true);
});

test("v3 public entities omit nested relation arrays and bound flattened relations", () => {
  const protocol = v3Fixture();
  protocol.goals[0].taskIds = Array.from({ length: 1000 }, (_, index) => `task-${index}`);
  protocol.tasks[0].dependencies = Array.from({ length: 1000 }, (_, index) => `dependency-${index}`);
  protocol.tasks[0].runIds = Array.from({ length: 1000 }, (_, index) => `run-${index}`);
  protocol.actors[0].memberActorIds = Array.from({ length: 1000 }, (_, index) => `actor-${index}`);
  protocol.actors[0].runIds = Array.from({ length: 1000 }, (_, index) => `run-${index}`);
  protocol.usageRecords[0].contextOriginSlices = Array.from({ length: 1000 }, () => ({ component: "input", origin: "shared", tokens: 1, sourceSessionRefs: [{ provider: "fixture", sessionId: "source" }] }));
  protocol.contextVersions[0].parentVersionIds = Array.from({ length: 1000 }, (_, index) => `version-${index}`);
  protocol.contextVersions[0].artifactIds = Array.from({ length: 1000 }, (_, index) => `artifact-${index}`);
  protocol.contextTransformations[0].sourceVersionIds = Array.from({ length: 1000 }, (_, index) => `version-${index}`);
  protocol.contextTransformations[0].sourceArtifactIds = Array.from({ length: 1000 }, (_, index) => `artifact-${index}`);
  protocol.contextTransformations[0].resultArtifactIds = Array.from({ length: 1000 }, (_, index) => `artifact-result-${index}`);
  protocol.contextArtifacts[0].sourceSessionIds = Array.from({ length: 1000 }, (_, index) => `source-${index}`);
  protocol.contextArtifacts[0].consumerRunIds = Array.from({ length: 1000 }, (_, index) => `run-${index}`);
  protocol.contextArtifacts[0].citationEventIds = Array.from({ length: 1000 }, (_, index) => `event-${index}`);
  protocol.contextArtifacts[0].inheritedFromArtifactIds = Array.from({ length: 1000 }, (_, index) => `artifact-parent-${index}`);

  const workProjection = projectWork(protocol, { maxItems: 40 });
  const executionProjection = projectExecution(protocol, { maxItems: 40 });
  const executionUsageProjection = projectExecution({ ...protocol, actors: [], agentRuns: [] }, { maxItems: 40 });
  const contextProjection = projectContext(protocol, { maxItems: 40 });
  const contextVersionProjection = projectContext({ ...protocol, contextArtifacts: [] }, { maxItems: 40 });
  const contextTransformationProjection = projectContext({ ...protocol, contextArtifacts: [], contextVersions: [] }, { maxItems: 40 });
  const projections = [workProjection, executionProjection, executionUsageProjection, contextProjection, contextVersionProjection, contextTransformationProjection];
  for (const projection of projections) {
    if (projection !== executionUsageProjection) assert.ok(projection.truncated);
  }
  assert.ok(workProjection.memberships.length + workProjection.dependencies.length + workProjection.taskRuns.length <= 40);
  assert.ok(executionProjection.actorMembers.length + executionProjection.actorRuns.length <= 40);
  assert.ok(contextProjection.origins.length + contextProjection.originSources.length
    + contextProjection.versionParents.length + contextProjection.versionArtifacts.length
    + contextProjection.transformationVersions.length + contextProjection.transformationArtifacts.length
    + contextProjection.artifactSessions.length + contextProjection.artifactRuns.length
    + contextProjection.artifactEvents.length + contextProjection.artifactInheritance.length <= 40);
  assert.equal("dependencies" in workProjection.tasks[0].task, false);
  assert.equal("runIds" in workProjection.tasks[0].task, false);
  assert.equal("memberActorIds" in executionProjection.actors[0].actor, false);
  assert.equal("contextOriginSlices" in executionUsageProjection.usageRecords[0].usage, false);
  assert.equal("parentVersionIds" in contextVersionProjection.versions[0].version, false);
  assert.equal("sourceVersionIds" in contextTransformationProjection.transformations[0].transformation, false);
  assert.equal("sourceSessionIds" in contextProjection.artifacts[0].artifact, false);
  assert.ok(contextProjection.originSources.length <= 40);
});
