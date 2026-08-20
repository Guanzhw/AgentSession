import assert from "node:assert/strict";
import test from "node:test";

import {
  finalizeSessionProtocol,
  protocolRevision,
  validateSessionProtocol
} from "../dist/src/providers/shared/session-protocol.js";

const provenance = (fidelity = "recorded", sourceType = "fixture") => ({
  fidelity,
  sourceType,
  sourceId: null
});

const baseProtocol = {
  sessionId: "root",
  events: [
    { id: "e1", sessionId: "root", sequence: 99, timestamp: 100, kind: "message.user", provenance: provenance("derived") },
    { id: "e2", sessionId: "root", sequence: 100, timestamp: 110, kind: "tool.call", correlationId: "task-1", provenance: provenance() },
    { id: "e3", sessionId: "root", sequence: 101, timestamp: 120, kind: "schedule.change", provenance: provenance() }
  ],
  relationships: [{
    type: "spawned",
    fromSessionId: "root",
    toSessionId: "child",
    provenance: provenance()
  }],
  tasks: [{
    id: "task-1",
    sessionId: "root",
    kind: "subagent-task",
    status: "running",
    title: "Inspect",
    timeCreated: 100,
    timeUpdated: 100,
    timeCompleted: null,
    provenance: provenance(),
    scheduleId: "schedule-1",
    deadline: 200,
    revision: 2,
    correlationId: "task-1"
  }],
  agentRuns: [{
    id: "run-1",
    sessionId: "root",
    taskId: "task-1",
    status: "running",
    mode: "subagent",
    agent: "worker",
    model: "model",
    childSessionId: "child",
    timeStart: 100,
    timeEnd: null,
    attempt: 1,
    triggerEventId: "e2",
    provenance: provenance("derived")
  }],
  contextArtifacts: [{
    id: "artifact-1",
    sessionId: "root",
    kind: "memory",
    scope: "session",
    origin: "provider-generated",
    contentAccess: "metadata-only",
    title: "Context",
    summary: null,
    sourcePath: null,
    producerRunId: "run-1",
    sourceSessionIds: ["root"],
    hash: null,
    redacted: true,
    provenance: provenance(),
    timeCreated: 100,
    consumerRunIds: ["run-1", "run-1"],
    citationEventIds: ["e2"]
  }],
  branches: [{
    id: "main",
    parentBranchId: null,
    forkEventId: null,
    headEventId: "e3",
    selected: true,
    provenance: provenance()
  }]
};

test("finalizeSessionProtocol creates canonical v2 identity, categories, refs, and diagnostics", () => {
  const protocol = finalizeSessionProtocol(baseProtocol, {
    provider: "fixture",
    revision: protocolRevision("rev-1"),
    session: {
      id: "root",
      provider: "codex",
      parentId: null,
      title: "Root",
      directory: "D:\\WorkSpace",
      timeCreated: 100,
      timeUpdated: 120,
      messageCount: 2,
      tokenCount: 10,
      metadata: { origin: "user", harness: "fixture" }
    },
    capabilities: {
      sessionEvents: { support: "partial", provenance: "derived" },
      sessionRelationships: { support: "partial", provenance: "derived" },
      tasks: { support: "partial", provenance: "derived" },
      agentRuns: { support: "partial", provenance: "derived" },
      contextArtifacts: { support: "partial", provenance: "derived" }
    }
  });

  assert.equal(protocol.version, 2);
  assert.deepEqual(protocol.session.ref, { provider: "fixture", sessionId: "root" });
  assert.equal(protocol.session.state, "unknown");
  assert.equal(protocol.events.map((event) => event.sequence).join(","), "1,2,3");
  assert.equal(protocol.events[0].category, "message");
  assert.equal(protocol.events[1].normalizedKind, "tool.called");
  assert.equal(protocol.events[2].category, "control");
  assert.equal(protocol.events[1].taskId, "task-1");
  assert.equal(protocol.events[1].runId, "run-1");
  assert.deepEqual(protocol.relationships[0].fromRef, { provider: "fixture", sessionId: "root" });
  assert.deepEqual(protocol.relationships[0].toRef, { provider: "fixture", sessionId: "child" });
  assert.deepEqual(protocol.tasks[0].runIds, ["run-1"]);
  assert.equal(protocol.tasks[0].triggerEventId, "e2");
  assert.equal(protocol.agentRuns[0].triggerEventId, "e2");
  assert.deepEqual(protocol.contextArtifacts[0].consumerRunIds, ["run-1"]);
  assert.equal(protocol.validation.ok, true);
  assert.equal(protocol.completeness, "complete");
  assert.equal(protocol.revision.value, "rev-1");
  assert.equal(Object.isFrozen(protocol), true);
  assert.equal(Object.isFrozen(protocol.events[0]), true);
});

test("validateSessionProtocol reports stable bounded identity, sequence, reference, and capability diagnostics", () => {
  const invalid = finalizeSessionProtocol({
    ...baseProtocol,
    events: [
      { ...baseProtocol.events[0], id: "duplicate", sequence: 1 },
      { ...baseProtocol.events[0], id: "duplicate", sequence: 2 }
    ],
    relationships: [{
      type: "parent",
      fromSessionId: "root",
      toSessionId: "root",
      provenance: provenance()
    }],
    tasks: [],
    agentRuns: [{ ...baseProtocol.agentRuns[0], taskId: "missing" }],
    contextArtifacts: []
  }, {
    provider: "fixture",
    freeze: false,
    capabilities: {
      sessionEvents: { support: "none", provenance: "derived" },
      sessionRelationships: { support: "none", provenance: "derived" },
      tasks: { support: "none", provenance: "derived" },
      agentRuns: { support: "partial", provenance: "derived" },
      contextArtifacts: { support: "none", provenance: "derived" }
    }
  });

  assert.equal(invalid.validation.ok, false);
  const codes = invalid.validation.errors.map((diagnostic) => diagnostic.code);
  assert.ok(codes.includes("EVENT_ID_DUPLICATE"));
  assert.ok(codes.includes("RELATION_SELF_EDGE"));
  assert.ok(codes.includes("CAPABILITY_NONE_WITH_DATA"));
  assert.ok(invalid.validation.warnings.some((diagnostic) => diagnostic.code === "RUN_TASK_DANGLING"));
  assert.ok(invalid.validation.errors.every((diagnostic) => diagnostic.message.length <= 240));
  assert.equal(invalid.completeness, "invalid");
});

test("validator rejects an unfinalized protocol and detects lineage cycles", () => {
  const result = validateSessionProtocol({
    sessionId: "root",
    events: [],
    relationships: [
      { type: "parent", fromSessionId: "root", toSessionId: "child", provenance: provenance() },
      { type: "parent", fromSessionId: "child", toSessionId: "root", provenance: provenance() }
    ],
    tasks: [],
    agentRuns: [],
    contextArtifacts: []
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((diagnostic) => diagnostic.code === "PROTOCOL_VERSION_REQUIRED"));
  assert.ok(result.errors.some((diagnostic) => diagnostic.code === "SESSION_DESCRIPTOR_MISSING"));
  assert.ok(result.errors.some((diagnostic) => diagnostic.code === "RELATION_CYCLE"));
  assert.equal(result.completeness, "invalid");
});

test("handoff remains collaboration lineage and never implies a spawned run", () => {
  const protocol = finalizeSessionProtocol({
    sessionId: "s1",
    events: [],
    relationships: [{
      type: "handed-off",
      fromSessionId: "s1",
      toSessionId: "s2",
      provenance: { fidelity: "recorded", sourceType: "fixture.handoff" }
    }],
    tasks: [],
    agentRuns: [],
    contextArtifacts: []
  }, {
    provider: "codex",
    session: { id: "s1" },
    capabilities: {
      sessionRelationships: { support: "full", provenance: "recorded" }
    }
  });

  assert.equal(protocol.validation.ok, true);
  assert.equal(protocol.relationships[0].type, "handed-off");
  assert.deepEqual(protocol.tasks, []);
  assert.deepEqual(protocol.agentRuns, []);
});

test("validator reports every dangling local entity anchor", () => {
  const protocol = finalizeSessionProtocol({
    ...baseProtocol,
    events: [{ ...baseProtocol.events[0], parentEventId: "missing-event", taskId: "missing-task", runId: "missing-run" }],
    relationships: [{ ...baseProtocol.relationships[0], triggerEventId: "missing-event", taskId: "missing-task", runId: "missing-run" }],
    tasks: [{ ...baseProtocol.tasks[0], parentTaskId: "missing-parent", dependencies: ["missing-dependency"], requestEventId: "missing-event", triggerEventId: "missing-event", runIds: ["missing-run"] }],
    agentRuns: [{ ...baseProtocol.agentRuns[0], taskId: "task-1", parentRunId: "missing-parent-run", triggerEventId: "missing-event" }],
    contextArtifacts: [{ ...baseProtocol.contextArtifacts[0], producerEventId: "missing-event", consumerRunIds: ["missing-run"], citationEventIds: ["missing-event"], inheritedFromArtifactIds: ["missing-artifact"] }],
    branches: [{ ...baseProtocol.branches[0], parentBranchId: "missing-branch", forkEventId: "missing-event", headEventId: "missing-event" }]
  }, { provider: "fixture", freeze: false });

  assert.equal(protocol.validation.ok, true);
  assert.equal(protocol.completeness, "partial");
  const codes = new Set(protocol.validation.warnings.map((item) => item.code));
  for (const code of [
    "EVENT_PARENT_DANGLING", "EVENT_TASK_DANGLING", "EVENT_RUN_DANGLING",
    "TASK_PARENT_DANGLING", "TASK_DEPENDENCY_DANGLING", "TASK_EVENT_DANGLING", "TASK_RUN_DANGLING",
    "RUN_PARENT_DANGLING", "RUN_EVENT_DANGLING", "RELATION_EVENT_DANGLING", "RELATION_TASK_DANGLING", "RELATION_RUN_DANGLING",
    "ARTIFACT_PRODUCER_EVENT_DANGLING", "ARTIFACT_CONSUMER_RUN_DANGLING", "ARTIFACT_CITATION_EVENT_DANGLING", "ARTIFACT_INHERITED_DANGLING",
    "BRANCH_PARENT_DANGLING", "BRANCH_EVENT_DANGLING"
  ]) assert.ok(codes.has(code), code);
});
