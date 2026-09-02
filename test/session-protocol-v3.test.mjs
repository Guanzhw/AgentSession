import assert from "node:assert/strict";
import test from "node:test";

import {
  actor,
  contextTransformation,
  finalizeSessionProtocolV3,
  goal,
  protocolDomainCoverage,
  protocolCoverage,
  upgradeSessionProtocolV2,
  usageRecord,
  validateSessionProtocolV3
} from "../dist/src/providers/shared/session-protocol-v3.js";
import { contextArtifact } from "../dist/src/providers/shared/session-protocol.js";

const recorded = (sourceType, sourceId = null) => ({ fidelity: "recorded", sourceType, sourceId });
const derived = (sourceType, sourceId = null) => ({ fidelity: "derived", sourceType, sourceId });

function v2Fixture() {
  return {
    version: 2,
    sessionId: "s-root",
    session: {
      ref: { provider: "fixture", sessionId: "s-root" },
      state: "completed",
      origin: "fixture",
      timeCreated: 100,
      timeUpdated: 200,
      cwd: null,
      harness: "fixture",
      terminalOutcome: "completed",
      forkSeedBoundary: null,
      inheritedEventCount: null,
      provenance: derived("fixture.session", "s-root")
    },
    events: [{
      id: "event-compact",
      sessionId: "s-root",
      sequence: 1,
      timestamp: 150,
      kind: "context.compaction",
      category: "context",
      provenance: recorded("fixture.compaction", "event-compact"),
      compaction: {
        trigger: "automatic",
        strategy: "summary",
        tokensBefore: 100,
        tokensAfter: 20,
        summary: null,
        retainedFromEventId: null,
        continuationSessionId: null,
        reloadedContextRefs: null
      }
    }],
    relationships: [{
      type: "spawned",
      fromSessionId: "s-root",
      toSessionId: "s-child",
      fromRef: { provider: "fixture", sessionId: "s-root" },
      toRef: { provider: "fixture", sessionId: "s-child" },
      provenance: recorded("fixture.relationship", "rel-1"),
      timestamp: 120,
      correlationId: null,
      details: null,
      triggerEventId: null,
      taskId: "task-1",
      runId: "run-1"
    }],
    tasks: [{
      id: "task-1", sessionId: "s-root", kind: "subagent-task", status: "completed", title: "child", parentTaskId: null,
      toolCallId: null, agentPath: null, correlationId: null, dependencies: [], assignee: null, owner: null,
      requestEventId: null, triggerEventId: null, scheduleId: null, deadline: null, runIds: ["run-1"], revision: null,
      outcome: "completed", failureReason: null, cancellationReason: null, timeCreated: 110, timeUpdated: 180,
      timeCompleted: 180, provenance: derived("fixture.task", "task-1")
    }],
    agentRuns: [{
      id: "run-1", sessionId: "s-root", taskId: "task-1", status: "completed", mode: "subagent", agent: "worker",
      model: "fixture-model", childSessionId: "s-child", parentRunId: null, triggerEventId: null, scheduleId: null,
      attempt: 1, outcome: "completed", failureReason: null, cancellationReason: null, timeStart: 120, timeEnd: 180,
      provenance: derived("fixture.run", "run-1")
    }],
    contextArtifacts: [{
      id: "artifact-1", sessionId: "s-root", kind: "summary", scope: "session", origin: "provider-generated",
      contentAccess: "metadata-only", title: "summary", summary: null, sourcePath: null, producerRunId: null,
      producerEventId: null, consumerRunIds: [], citationEventIds: [], inheritedFromArtifactIds: [], version: null,
      lineageId: null, sourceSessionIds: ["s-root"], hash: null, redacted: true, provenance: recorded("fixture.artifact", "artifact-1"),
      timeCreated: 150
    }],
    branches: []
  };
}

function v3Fixture() {
  return {
    ...v2Fixture(),
    version: 3,
    goals: [],
    actors: [],
    coordination: [],
    contextVersions: [],
    contextTransformations: [],
    usageRecords: [],
    coverage: protocolCoverage()
  };
}

test("v2 upgrade retains facts and does not invent usage, coordination, goals, actors, or versions", () => {
  const source = v2Fixture();
  const upgraded = upgradeSessionProtocolV2(source);

  assert.equal(upgraded.version, 3);
  assert.deepEqual(upgraded.tasks, source.tasks);
  assert.deepEqual(upgraded.agentRuns, source.agentRuns);
  assert.deepEqual(upgraded.contextArtifacts, source.contextArtifacts);
  assert.deepEqual(upgraded.relationships, source.relationships);
  assert.equal(upgraded.goals.length, 0);
  assert.equal(upgraded.actors.length, 0);
  assert.equal(upgraded.contextVersions.length, 0);
  assert.equal(upgraded.usageRecords.length, 0);
  assert.equal(upgraded.coverage.usage.state, "unknown");
  assert.equal(upgraded.coordination.length, 0);
  assert.equal(upgraded.coverage.coordination.state, "unknown");
  assert.equal(upgraded.contextTransformations.length, 0);
  assert.equal(upgraded.coverage.context.state, "unknown");
  assert.equal(upgraded.upgrade.preservesV2Facts, true);
  assert.equal(upgraded.validation.ok, true);
  assert.equal(Object.isFrozen(source), false);
  source.events.push({ id: "later", sessionId: "s-root", sequence: 2, timestamp: null, kind: "message.user", provenance: derived("fixture.event") });
  assert.equal(Object.isFrozen(source.events), false);
  assert.equal(upgraded.events.length, 1);
  assert.equal(Object.isFrozen(upgraded.events), true);
});

test("v2 upgrade accepts explicit coverage without inferring it", () => {
  const upgraded = upgradeSessionProtocolV2(v2Fixture(), {
    coverage: {
      work: protocolDomainCoverage("observed"),
      execution: protocolDomainCoverage("observed"),
      context: protocolDomainCoverage("observed")
    }
  });
  assert.equal(upgraded.coverage.work.state, "observed");
  assert.equal(upgraded.validation.ok, true);
});

test("v2 upgrade rejects invalid source validation and preserves partial warnings", () => {
  const invalid = v2Fixture();
  invalid.validation = {
    ok: false,
    completeness: "invalid",
    errors: [{ code: "CAPABILITY_NONE_WITH_DATA", severity: "error", message: "invalid source" }],
    warnings: []
  };
  invalid.completeness = "invalid";
  assert.throws(() => upgradeSessionProtocolV2(invalid), /Cannot upgrade an invalid/);

  const partial = v2Fixture();
  partial.validation = {
    ok: true,
    completeness: "partial",
    errors: [],
    warnings: [{ code: "SOURCE_PARTIAL", severity: "warning", message: "source evidence is partial" }]
  };
  partial.completeness = "partial";
  const upgraded = upgradeSessionProtocolV2(partial);
  assert.equal(upgraded.completeness, "partial");
  assert.ok(upgraded.validation.warnings.some((value) => value.code === "SOURCE_PARTIAL"));

  const invalidAfterUpgrade = upgradeSessionProtocolV2(partial, {
    freeze: false,
    coverage: { coordination: protocolDomainCoverage("observed") }
  });
  assert.equal(invalidAfterUpgrade.validation.ok, false);
  assert.ok(invalidAfterUpgrade.validation.errors.some((item) => item.code === "COVERAGE_OBSERVED_EMPTY"));
  assert.equal(invalidAfterUpgrade.validation.completeness, "invalid");
  assert.equal(invalidAfterUpgrade.completeness, "invalid");
});

test("native v3 is valid without upgrade metadata", () => {
  const native = v3Fixture();
  native.coverage = protocolCoverage({
    work: protocolDomainCoverage("observed"),
    execution: protocolDomainCoverage("observed"),
    context: protocolDomainCoverage("observed")
  });
  const finalized = finalizeSessionProtocolV3(native);
  assert.equal(finalized.validation.ok, true);
  assert.equal(Object.isFrozen(finalized), true);
  assert.equal(finalized.upgrade, undefined);
  const missingCollections = v3Fixture();
  delete missingCollections.goals;
  assert.throws(() => finalizeSessionProtocolV3(missingCollections), TypeError);
});

test("v3 factories normalize optional domains and preserve multi-origin input/cache slices", () => {
  const g = goal({ id: " g ", sessionId: " s ", title: null, status: "active", taskIds: [" t ", "t"], timeCreated: 1, timeUpdated: 2, provenance: derived("goal") });
  const team = actor({ id: "team", kind: "team", name: "team", memberActorIds: ["worker", "worker"], runIds: ["run", "run"], provenance: recorded("team") });
  assert.deepEqual(g.taskIds, ["t"]);
  assert.equal(g.id, "g");
  assert.equal(g.sessionId, "s");
  assert.deepEqual(team.memberActorIds, ["worker"]);
  assert.deepEqual(team.runIds, ["run"]);
  assert.deepEqual(protocolDomainCoverage("unsupported"), { state: "unsupported", details: null });
  assert.equal(protocolCoverage().usage.state, "unknown");

  const usage = usageRecord({
    id: "provider-request-1", scope: "request", sessionRef: { provider: "fixture", sessionId: "s" },
    tokens: { input: 10, cacheRead: 3, output: 2, reasoning: 0, total: 15 },
    contextOriginSlices: [
      { component: "input", origin: "direct", tokens: 2 },
      { component: "input", origin: "inherited", tokens: 3, sourceSessionRefs: [{ provider: "fixture", sessionId: "parent" }] },
      { component: "input", origin: "shared", tokens: 5 },
      { component: "cacheRead", origin: "inherited", tokens: 1 },
      { component: "cacheRead", origin: "shared", tokens: 2 }
    ],
    provenance: recorded("fixture.request", "provider-request-1")
  });
  assert.equal(usage.contextOriginSlices.length, 5);
  for (const kind of ["experience", "user-info"]) {
    assert.equal(contextArtifact({
      id: `artifact-${kind}`, sessionId: "s", kind, scope: "user", origin: "provider-generated",
      contentAccess: "metadata-only", title: null, summary: null, sourcePath: null, producerRunId: null,
      sourceSessionIds: [], hash: null, redacted: true, provenance: recorded("fixture.artifact"), timeCreated: null
    }).kind, kind);
  }
});

test("v3 validator enforces canonical usage ownership, slice bounds, lineage, and coverage", () => {
  const base = upgradeSessionProtocolV2(v2Fixture(), { freeze: false });
  base.usageRecords = [usageRecord({
    id: "request-1", scope: "request", sessionRef: { provider: "fixture", sessionId: "s-root" }, runId: "run-1", eventId: "event-compact",
    tokens: { input: 4, output: 1, total: 5 },
    contextOriginSlices: [
      { component: "input", origin: "direct", tokens: 2 },
      { component: "input", origin: "inherited", tokens: 2 },
      { component: "input", origin: "shared", tokens: 1 }
    ],
    provenance: recorded("fixture.request", "request-1")
  })];
  base.coverage = { ...base.coverage, usage: protocolDomainCoverage("observed") };
  const invalid = validateSessionProtocolV3(base);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((item) => item.code === "USAGE_ORIGIN_EXCEEDS_COMPONENT"));

  const withForbidden = structuredClone(base);
  withForbidden.usageRecords[0].contextOriginSlices.push({ component: "output", origin: "direct", tokens: 1 });
  const forbiddenValidation = validateSessionProtocolV3(withForbidden);
  assert.ok(forbiddenValidation.errors.some((item) => item.code === "USAGE_ORIGIN_FORBIDDEN_COMPONENT"));

  const withBadCoverage = structuredClone(base);
  withBadCoverage.coverage.usage = protocolDomainCoverage("not-observed");
  const coverageValidation = validateSessionProtocolV3(withBadCoverage);
  assert.ok(coverageValidation.errors.some((item) => item.code === "COVERAGE_ENTITY_CONTRADICTION"));
});

test("usage totals include cache components and cache-only records require a sufficient total", () => {
  const base = upgradeSessionProtocolV2(v2Fixture(), { freeze: false });
  base.usageRecords = [usageRecord({
    id: "cache-request", scope: "request", sessionRef: { provider: "fixture", sessionId: "s-root" },
    tokens: { cacheRead: 3, cacheWrite: 2, total: 5 }, provenance: recorded("fixture.request", "cache-request")
  })];
  base.coverage = { ...base.coverage, usage: protocolDomainCoverage("observed") };
  assert.equal(validateSessionProtocolV3(base).ok, true);
  base.usageRecords[0].tokens.total = 4;
  assert.ok(validateSessionProtocolV3(base).errors.some((item) => item.code === "USAGE_TOTAL_BELOW_COMPONENTS"));

  const unknownToken = structuredClone(base);
  unknownToken.usageRecords[0].tokens.total = 5;
  unknownToken.usageRecords[0].tokens.future = 1;
  const unknownTokenValidation = validateSessionProtocolV3(unknownToken);
  assert.ok(unknownTokenValidation.errors.some((item) => item.code === "USAGE_TOKEN_KEY_UNKNOWN"));
  assert.throws(() => usageRecord({
    id: "turn-total", scope: "turn", sessionRef: { provider: "fixture", sessionId: "s-root" }, tokens: { total: 1 }, provenance: recorded("fixture.total")
  }), /Invalid usage scope/);
});

test("actors count under execution coverage and explicit coverage detects contradictions", () => {
  const base = upgradeSessionProtocolV2(v2Fixture(), { freeze: false });
  base.actors = [actor({ id: "agent-1", kind: "agent", name: "worker", provenance: recorded("fixture.actor", "agent-1") })];
  base.coverage = { ...base.coverage, execution: protocolDomainCoverage("not-observed") };
  const validation = validateSessionProtocolV3(base);
  assert.ok(validation.errors.some((item) => item.code === "COVERAGE_ENTITY_CONTRADICTION"));

  const invalidTeam = v3Fixture();
  invalidTeam.actors = [
    actor({ id: "human", kind: "human", name: "human", memberActorIds: ["agent"], provenance: recorded("fixture.actor", "human") }),
    actor({ id: "agent", kind: "agent", name: "agent", teamId: "human", provenance: recorded("fixture.actor", "agent") })
  ];
  invalidTeam.coverage = { ...invalidTeam.coverage, execution: protocolDomainCoverage("observed") };
  const teamValidation = validateSessionProtocolV3(invalidTeam);
  assert.ok(teamValidation.errors.some((item) => item.code === "ACTOR_MEMBERS_REQUIRE_TEAM"));
  assert.ok(teamValidation.errors.some((item) => item.code === "ACTOR_TEAM_KIND_INVALID"));
});

test("dream is a supported context transformation kind", () => {
  const value = contextTransformation({
    id: "dream-1", sessionId: "s", kind: "dream", sourceVersionIds: [], resultVersionId: null,
    sourceArtifactIds: [], resultArtifactIds: ["dream-artifact"], timestamp: null, provenance: recorded("fixture.dream", "dream-1")
  });
  assert.equal(value.kind, "dream");
  assert.throws(() => contextTransformation({
    id: "opaque-dream", sessionId: "s", kind: "dream", sourceVersionIds: [], resultVersionId: null,
    sourceArtifactIds: [], resultArtifactIds: [], timestamp: null, provenance: recorded("fixture.dream", "opaque-dream")
  }), /requires an observed result/);
});

test("v3 diagnostics remain bounded", () => {
  const base = upgradeSessionProtocolV2(v2Fixture(), { freeze: false });
  base.goals = Array.from({ length: 120 }, (_, index) => goal({
    id: `goal-${index}`, sessionId: "wrong-session", title: "goal", status: "active", taskIds: [], timeCreated: null, timeUpdated: null,
    provenance: derived("fixture.goal", `goal-${index}`)
  }));
  const validation = validateSessionProtocolV3(base);
  assert.ok(validation.errors.length <= 100);

  const duplicateIds = v3Fixture();
  duplicateIds.goals = Array.from({ length: 120 }, () => goal({
    id: "duplicate", sessionId: "s-root", title: "goal", status: "active", taskIds: [], timeCreated: null, timeUpdated: null,
    provenance: derived("fixture.goal", "duplicate")
  }));
  duplicateIds.coverage = { ...duplicateIds.coverage, work: protocolDomainCoverage("observed") };
  assert.equal(validateSessionProtocolV3(duplicateIds).errors.length, 100);
});

test("v3 validator rejects context lineage cycles and dangling local references", () => {
  const base = upgradeSessionProtocolV2(v2Fixture(), { freeze: false });
  base.contextVersions = [
    { id: "v1", sessionId: "s-root", parentVersionIds: ["v2"], artifactIds: [], createdAt: 1, provenance: derived("version", "v1") },
    { id: "v2", sessionId: "s-root", parentVersionIds: ["v1"], artifactIds: [], createdAt: 2, provenance: derived("version", "v2") }
  ];
  base.coverage = { ...base.coverage, context: protocolDomainCoverage("observed") };
  const validation = validateSessionProtocolV3(base);
  assert.ok(validation.errors.some((item) => item.code === "CONTEXT_LINEAGE_CYCLE"));

  const goalCycle = v3Fixture();
  goalCycle.goals = [
    goal({ id: "g1", sessionId: "s-root", title: "one", status: "active", taskIds: [], parentGoalId: "g2", timeCreated: null, timeUpdated: null, provenance: derived("goal", "g1") }),
    goal({ id: "g2", sessionId: "s-root", title: "two", status: "active", taskIds: [], parentGoalId: "g1", timeCreated: null, timeUpdated: null, provenance: derived("goal", "g2") })
  ];
  goalCycle.coverage = { ...goalCycle.coverage, work: protocolDomainCoverage("observed") };
  assert.ok(validateSessionProtocolV3(goalCycle).errors.some((item) => item.code === "GOAL_LINEAGE_CYCLE"));
});
