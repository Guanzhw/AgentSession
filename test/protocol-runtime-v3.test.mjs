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
  assert.deepEqual(execution.usage, {
    requestCount: 1, complete: true, input: 10, cacheRead: 2, cacheWrite: 0, output: 3, reasoning: 0, total: 15,
    origins: {
      complete: false,
      inspectedRecords: 1,
      recordsTruncated: false,
      slicesTruncated: false,
      input: { total: 10, classified: { direct: 0, inherited: 4, shared: 0 }, unclassified: 6, complete: false },
      cacheRead: { total: 2, classified: { direct: 0, inherited: 0, shared: 0 }, unclassified: 2, complete: false },
      cacheWrite: { total: 0, classified: { direct: 0, inherited: 0, shared: 0 }, unclassified: 0, complete: true }
    }
  });
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
  assert.deepEqual(projectExecution(notObserved).usage, {
    requestCount: 0, complete: true, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0,
    origins: {
      complete: true,
      inspectedRecords: 0,
      recordsTruncated: false,
      slicesTruncated: false,
      input: { total: 0, classified: { direct: 0, inherited: 0, shared: 0 }, unclassified: 0, complete: true },
      cacheRead: { total: 0, classified: { direct: 0, inherited: 0, shared: 0 }, unclassified: 0, complete: true },
      cacheWrite: { total: 0, classified: { direct: 0, inherited: 0, shared: 0 }, unclassified: 0, complete: true }
    }
  });
  const unsupported = structuredClone(upgraded);
  unsupported.coverage.usage = { state: "unsupported", details: null };
  const unsupportedUsage = projectExecution(unsupported).usage;
  assert.equal(unsupportedUsage.complete, false);
  assert.equal(unsupportedUsage.input, null);
  assert.equal(unsupportedUsage.origins.input.total, null);
  assert.equal(unsupportedUsage.origins.input.unclassified, null);
  assert.equal(unsupportedUsage.origins.input.complete, false);
  assert.equal(unsupportedUsage.origins.complete, false);
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
  assert.deepEqual(knownEmpty.usage, {
    requestCount: 0, complete: true, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0,
    origins: {
      complete: true,
      inspectedRecords: 0,
      recordsTruncated: false,
      slicesTruncated: false,
      input: { total: 0, classified: { direct: 0, inherited: 0, shared: 0 }, unclassified: 0, complete: true },
      cacheRead: { total: 0, classified: { direct: 0, inherited: 0, shared: 0 }, unclassified: 0, complete: true },
      cacheWrite: { total: 0, classified: { direct: 0, inherited: 0, shared: 0 }, unclassified: 0, complete: true }
    }
  });
});

test("execution origin accounting partitions exact full slices across records and origins", () => {
  const protocol = structuredClone(v3Fixture());
  protocol.actors = [];
  protocol.agentRuns = [];
  protocol.usageRecords = [
    {
      id: "request-a", scope: "request", sessionRef: protocol.session.ref, runId: null,
      tokens: { input: 10, cacheRead: 3, cacheWrite: 2, output: 1, reasoning: 0, total: 16 },
      contextOriginSlices: [
        { component: "input", origin: "direct", tokens: 2 },
        { component: "input", origin: "inherited", tokens: 3, sourceSessionRefs: [{ provider: "fixture", sessionId: "parent" }] },
        { component: "input", origin: "shared", tokens: 5, sourceSessionRefs: [{ provider: "fixture", sessionId: "shared" }] },
        { component: "cacheRead", origin: "inherited", tokens: 1 },
        { component: "cacheRead", origin: "shared", tokens: 2 },
        { component: "cacheWrite", origin: "direct", tokens: 2 }
      ], provenance
    },
    {
      id: "request-b", scope: "request", sessionRef: protocol.session.ref, runId: null,
      tokens: { input: 7, cacheRead: 1, cacheWrite: 0, output: 0, reasoning: 0, total: 8 },
      contextOriginSlices: [
        { component: "input", origin: "direct", tokens: 7 },
        { component: "cacheRead", origin: "direct", tokens: 1 }
      ], provenance
    }
  ];
  const usage = projectExecution(protocol).usage;
  assert.equal(usage.requestCount, 2);
  assert.equal(usage.complete, true);
  assert.deepEqual(usage.origins.input, { total: 17, classified: { direct: 9, inherited: 3, shared: 5 }, unclassified: 0, complete: true });
  assert.deepEqual(usage.origins.cacheRead, { total: 4, classified: { direct: 1, inherited: 1, shared: 2 }, unclassified: 0, complete: true });
  assert.deepEqual(usage.origins.cacheWrite, { total: 2, classified: { direct: 2, inherited: 0, shared: 0 }, unclassified: 0, complete: true });
  assert.equal(usage.origins.complete, true);
  assert.equal(usage.origins.inspectedRecords, 2);
  assert.equal(usage.origins.recordsTruncated, false);
  assert.equal(usage.origins.slicesTruncated, false);
  // Public usage records still omit the raw origin slices.
  assert.equal("contextOriginSlices" in projectExecution(protocol).usageRecords[0].usage, false);
});

test("execution origin accounting reports partial slices with a known unclassified remainder", () => {
  const protocol = structuredClone(v3Fixture());
  protocol.actors = [];
  protocol.agentRuns = [];
  protocol.usageRecords = [
    {
      id: "request-partial", scope: "request", sessionRef: protocol.session.ref, runId: null,
      tokens: { input: 10, cacheRead: 8, cacheWrite: 0, output: 0, reasoning: 0, total: 18 },
      contextOriginSlices: [
        { component: "input", origin: "direct", tokens: 4 },
        { component: "cacheRead", origin: "inherited", tokens: 5 }
      ], provenance
    }
  ];
  const origins = projectExecution(protocol).usage.origins;
  assert.deepEqual(origins.input, { total: 10, classified: { direct: 4, inherited: 0, shared: 0 }, unclassified: 6, complete: false });
  assert.deepEqual(origins.cacheRead, { total: 8, classified: { direct: 0, inherited: 5, shared: 0 }, unclassified: 3, complete: false });
  assert.deepEqual(origins.cacheWrite, { total: 0, classified: { direct: 0, inherited: 0, shared: 0 }, unclassified: 0, complete: true });
  assert.equal(origins.complete, false);
});

test("execution origin accounting treats origin-less records as recorded-zero lower bounds (Codex-like)", () => {
  const protocol = structuredClone(v3Fixture());
  protocol.actors = [];
  protocol.agentRuns = [];
  protocol.usageRecords = [
    {
      id: "request-plain", scope: "request", sessionRef: protocol.session.ref, runId: null,
      tokens: { input: 100, cacheRead: 25, cacheWrite: 0, output: 10, reasoning: 0, total: 135 },
      contextOriginSlices: [], provenance
    },
    {
      id: "request-no-slices-field", scope: "request", sessionRef: protocol.session.ref, runId: null,
      tokens: { input: 3, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 3 }, provenance
    }
  ];
  const origins = projectExecution(protocol).usage.origins;
  assert.deepEqual(origins.input, { total: 103, classified: { direct: 0, inherited: 0, shared: 0 }, unclassified: 103, complete: false });
  assert.deepEqual(origins.cacheRead, { total: 25, classified: { direct: 0, inherited: 0, shared: 0 }, unclassified: 25, complete: false });
  assert.deepEqual(origins.cacheWrite, { total: 0, classified: { direct: 0, inherited: 0, shared: 0 }, unclassified: 0, complete: true });
  assert.equal(origins.complete, false);
});

test("execution origin accounting keeps missing components unknown and incomplete", () => {
  const protocol = structuredClone(v3Fixture());
  protocol.actors = [];
  protocol.agentRuns = [];
  protocol.usageRecords = [
    {
      id: "request-null", scope: "request", sessionRef: protocol.session.ref, runId: null,
      tokens: { input: 10, cacheRead: null, output: 5, total: 15 },
      contextOriginSlices: [{ component: "input", origin: "direct", tokens: 10 }], provenance
    }
  ];
  const origins = projectExecution(protocol).usage.origins;
  assert.deepEqual(origins.input, { total: 10, classified: { direct: 10, inherited: 0, shared: 0 }, unclassified: 0, complete: true });
  assert.equal(origins.cacheRead.total, null);
  assert.equal(origins.cacheRead.unclassified, null);
  assert.equal(origins.cacheRead.complete, false);
  assert.equal(origins.complete, false);
});

test("execution origin accounting reflects requests omitted by the global maxItems bound", () => {
  const protocol = structuredClone(v3Fixture());
  protocol.actors = Array.from({ length: 100 }, (_, index) => ({ id: `actor-${index}`, kind: "agent", name: `a${index}`, provenance }));
  protocol.agentRuns = [];
  protocol.usageRecords = [
    {
      id: "request-hidden", scope: "request", sessionRef: protocol.session.ref, runId: null,
      tokens: { input: 5, output: 1, total: 6 },
      contextOriginSlices: [{ component: "input", origin: "direct", tokens: 5 }], provenance
    }
  ];
  const allConsumed = projectExecution(protocol, { maxItems: 100 });
  assert.equal(allConsumed.usage.requestCount, 0);
  assert.equal(allConsumed.usage.origins.recordsTruncated, true);
  assert.equal(allConsumed.usage.origins.input.total, null);
  assert.equal(allConsumed.usage.origins.input.unclassified, null);
  assert.equal(allConsumed.usage.origins.complete, false);
  assert.equal(allConsumed.truncated, true);

  const partiallyConsumed = structuredClone(protocol);
  partiallyConsumed.usageRecords.push({
    id: "request-hidden-2", scope: "request", sessionRef: protocol.session.ref, runId: null,
    tokens: { input: 3, output: 0, total: 3 },
    contextOriginSlices: [{ component: "input", origin: "shared", tokens: 3 }], provenance
  });
  const projected = projectExecution(partiallyConsumed, { maxItems: 101 });
  assert.equal(projected.usage.requestCount, 1);
  assert.equal(projected.usage.origins.recordsTruncated, true);
  assert.equal(projected.usage.origins.input.total, 5);
  assert.equal(projected.usage.origins.input.unclassified, null);
  assert.equal(projected.usage.origins.input.complete, false);
  assert.equal(projected.usage.origins.complete, false);
});

test("execution origin accounting bounds the slice scan of a single oversized record", () => {
  const protocol = structuredClone(v3Fixture());
  protocol.actors = [];
  protocol.agentRuns = [];
  protocol.usageRecords = [
    {
      id: "request-big", scope: "request", sessionRef: protocol.session.ref, runId: null,
      tokens: { input: 10000, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 10000 },
      contextOriginSlices: Array.from({ length: 1000 }, () => ({ component: "input", origin: "direct", tokens: 10 })), provenance
    }
  ];
  const origins = projectExecution(protocol, { maxItems: 100 }).usage.origins;
  assert.equal(origins.slicesTruncated, true);
  assert.equal(origins.recordsTruncated, false);
  assert.equal(origins.inspectedRecords, 1);
  assert.equal(origins.input.classified.direct, 1000);
  assert.equal(origins.input.unclassified, null);
  assert.equal(origins.input.complete, false);
  assert.equal(origins.complete, false);
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
