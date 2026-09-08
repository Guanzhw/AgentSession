import assert from "node:assert/strict";
import test from "node:test";

import { extractDshMeta } from "../dist/src/providers/deepseek-harness/parser.js";
import { buildDshSessionProtocol, buildDshSessionProtocolV3 } from "../dist/src/providers/deepseek-harness/protocol.js";
import { finalizeSessionProtocolV3 } from "../dist/src/providers/shared/session-protocol-v3.js";

function header(id, overrides = {}) {
  return {
    type: "session", version: 2, id, createdAt: 1000,
    cwd: "D:\\WorkSpace\\dsh-v3-fixture", isSeeded: true, delegationDepth: 1,
    agentPreset: "standard", ...overrides
  };
}

function event(type, seq, data, extra = {}) {
  return { type, seq, time: 1001 + seq, data, ...extra };
}

function childRecords(id = "child-1") {
  return [
    header(id, { isSeeded: false, delegationDepth: 2, origin: "subagent" }),
    event("subagent/descriptor", 0, { version: 3, mode: "one-shot", provider: "subagent", label: "worker" }),
    event("turn/end", 1, { turn: 1, reason: { kind: "completed" } })
  ];
}

function fixture() {
  const sessionId = "dsh-v3-root";
  const child = childRecords();
  const records = [
    header(sessionId),
    event("session/end-seed", 0, { inherited: true }),
    event("goal/change", 1, {
      kind: "goal/change", version: 1, operation: "create",
      goal: { id: "goal-1", revision: 1, objective: "Inspect", phase: "active", maxGoalRounds: 3 },
      roundsStarted: 0, createdAt: 1001, updatedAt: 1001
    }),
    event("goal/change", 2, {
      kind: "goal/change", version: 1, operation: "block",
      goal: { id: "goal-1", revision: 2, objective: "Inspect", phase: "blocked", maxGoalRounds: 3, blockedReason: { code: "wait", message: "Waiting" } },
      roundsStarted: 0, createdAt: 1001, updatedAt: 1002
    }),
    event("team/member", 3, { version: 2, teamId: sessionId, member: { id: "child-1", name: "worker", description: "Worker", provider: "subagent", context: "fresh", phase: "active" } }),
    event("team/task", 4, { version: 2, teamId: sessionId, task: { id: "task-1", revision: 4, subject: "Inspect files", description: "Read source", status: "in_progress", ownerId: "child-1", blockedBy: ["task-0"], writeScopes: ["src", "test"] } }),
    event("team/message/queued", 5, { version: 2, teamId: sessionId, message: { id: "message-1", senderId: sessionId, senderName: "lead", targetId: "child-1", delivery: "quiet", content: [{ type: "text", text: "Inspect" }] } }),
    event("team/message/delivered", 6, { version: 2, teamId: sessionId, messageId: "message-1", targetId: "child-1" }),
    event("tool-workflow/agent-start", 7, { runId: "workflow-1", seq: 1, label: "worker", childId: "child-1" }),
    event("tool-workflow/agent-end", 8, { runId: "workflow-1", seq: 1, outcome: "completed" }),
    event("compaction/start", 9, { compactionId: "compact-1", turn: 1 }),
    event("compaction/summary", 10, { compactionId: "compact-1", turn: 1, summary: [{ type: "text", text: "Summary" }], shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [1, 2], shadowedTokenCount: 12, provider: "deepseek", model: "model-1" }),
    event("compaction/end", 11, { compactionId: "compact-1", turn: 1 }),
    event("request/context", 12, { provider: "deepseek", model: "model-1", contextWindow: 128000 }),
    event("assistant/attempt", 13, { turn: 1, step: 1, stream: [{ type: "usage", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } }] }),
    event("assistant/message", 14, { turn: 1, step: 1, message: { id: "assistant-1", role: "assistant", source: { kind: "model", model: "model-1" }, content: [{ type: "text", text: "Done" }] }, usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 0 } }, { surfaceOp: "append" }),
    event("llm/retry-started", 15, { turn: 1, step: 1, retry: 1 }),
    event("assistant/attempt", 16, { turn: 1, step: 1, stream: [{ type: "usage", usage: { inputTokens: 4, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }] })
  ];
  const session = extractDshMeta(records, sessionId);
  const childSession = extractDshMeta(child, "child-1");
  const input = { session, records, messages: [], children: [{ session: childSession, records: child, messages: [] }] };
  return { input, base: buildDshSessionProtocol(input) };
}

function finalizedFixture() {
  const { input, base } = fixture();
  return { input, base, v3: finalizeSessionProtocolV3(buildDshSessionProtocolV3(input, base)) };
}

test("DSH native v3 folds recorded goals, team facts, mailbox lifecycle, and workflow identity", () => {
  const { base, v3 } = finalizedFixture();
  assert.equal(v3.version, 3);
  assert.equal(v3.validation?.ok, true);
  assert.deepEqual(Object.fromEntries(Object.entries(v3.coverage).map(([key, value]) => [key, value.state])), {
    work: "observed", execution: "observed", coordination: "observed", context: "observed", usage: "observed"
  });
  const parent = v3.actors.find((value) => value.id === "actor:dsh:session:dsh-v3-root");
  assert.deepEqual(parent?.provenance, { fidelity: "recorded", sourceType: "dsh.session.header", sourceId: "dsh-v3-root" });
  assert.deepEqual(v3.events.map((value) => value.providerData?.eventType), base.events.map((value) => value.providerData?.eventType));

  const goal = v3.goals.find((value) => value.id === "goal:goal-1");
  assert.equal(goal?.status, "blocked");
  assert.equal(goal?.description, "Inspect");
  assert.equal(goal?.provenance.fidelity, "recorded");
  const blockedEvent = v3.events.filter((value) => value.providerData?.eventType === "goal/change")[1];
  assert.equal(blockedEvent?.providerData?.sourceSequence, 2000);
  assert.equal(blockedEvent?.providerData?.revision, 2);
  assert.deepEqual(blockedEvent?.providerData?.blockedReason, { code: "wait", message: "Waiting" });

  const member = v3.actors.find((value) => value.providerActorId === "child-1");
  const team = v3.actors.find((value) => value.kind === "team" && value.providerActorId === "dsh-v3-root");
  assert.equal(member?.sessionRef?.sessionId, "child-1");
  assert.equal(member?.teamId, team?.id);
  assert.ok(team?.memberActorIds?.includes(member?.id));

  const task = v3.tasks.find((value) => value.id === "team:task-1");
  assert.equal(task?.owner, "child-1");
  assert.deepEqual(task?.dependencies, ["team:task-0"]);
  assert.deepEqual(task?.metadata?.writeScopes, ["src", "test"]);

  const queued = v3.coordination.find((value) => value.correlationId === "message-1" && value.kind === "message");
  const delivered = v3.coordination.find((value) => value.correlationId === "message-1" && value.kind === "mailbox-delivery");
  assert.equal(queued?.state, "requested");
  assert.equal(delivered?.state, "delivered");
  assert.equal(queued?.senderActorId, delivered?.senderActorId);
  assert.equal(delivered?.recipientActorId, member?.id);
  assert.equal(queued?.eventId, "event:dsh:5");
  assert.equal(delivered?.eventId, "event:dsh:6");

  const workflow = v3.coordination.filter((value) => value.correlationId === "workflow-1:1");
  assert.deepEqual(workflow.map((value) => [value.kind, value.state, value.taskId, value.runId, value.toSessionRef?.sessionId]), [
    ["spawn", "started", "workflow:workflow-1:1", null, "child-1"],
    ["spawn", "completed", "workflow:workflow-1:1", null, "child-1"]
  ]);
});

test("DSH native v3 emits compaction transformations only for readable summaries and preserves seed evidence", () => {
  const { input, v3 } = finalizedFixture();
  assert.equal(v3.session?.inheritedEventCount, 0);
  assert.equal(v3.session?.forkSeedBoundary, 0);
  assert.equal(v3.contextTransformations.length, 1);
  assert.equal(v3.contextTransformations[0].kind, "compaction");
  assert.equal(v3.contextTransformations[0].eventId, "event:dsh:10");
  assert.equal(v3.contextVersions[0].artifactIds.length, 1);
  assert.equal(v3.events.find((value) => value.providerData?.eventType === "compaction/start")?.compaction ?? null, null);
  assert.equal(v3.contextArtifacts.some((value) => ["memory", "experience", "user-info"].includes(value.kind)), false);
  assert.equal(v3.coverage.context.state, "observed");

  const noSummary = input.records.map((value) => value.type === "compaction/summary" ? { ...value, data: { ...value.data, summary: [] } } : value);
  const noSummaryInput = { ...input, records: noSummary, session: extractDshMeta(noSummary, input.session.id) };
  const noSummaryBase = buildDshSessionProtocol(noSummaryInput);
  const noSummaryV3 = finalizeSessionProtocolV3(buildDshSessionProtocolV3(noSummaryInput, noSummaryBase));
  assert.deepEqual(noSummaryV3.contextTransformations, []);
  assert.equal(noSummaryV3.coverage.context.state, "observed");
  assert.equal(noSummaryV3.validation?.ok, true);
  assert.equal(noSummaryV3.validation?.errors.some((error) => error.code === "COVERAGE_ENTITY_CONTRADICTION"), false);
});

test("DSH native v3 folds exactly one usage per retry slot and keeps origin attribution unknown", () => {
  const { v3 } = finalizedFixture();
  assert.deepEqual(v3.usageRecords.map((value) => value.eventId), ["event:dsh:14", "event:dsh:16"]);
  assert.deepEqual(v3.usageRecords.map((value) => value.tokens), [
    { input: 2, cacheRead: 1, cacheWrite: 0, output: 3, reasoning: 0, total: 6 },
    { input: 4, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0, total: 9 }
  ]);
  assert.equal(v3.usageRecords[0].model, "model-1");
  assert.deepEqual(v3.usageRecords.flatMap((value) => value.contextOriginSlices || []), []);
  assert.equal(v3.coverage.usage.state, "observed");
  assert.equal(v3.events.find((value) => value.providerData?.eventType === "request/context")?.providerData?.contextWindow, 128000);
});

test("DSH native v3 keeps unbound workflow evidence explicit", () => {
  const { input } = fixture();
  const records = input.records
    .filter((value) => !["team/member", "team/task"].includes(value.type))
    .map((value) => value.type === "tool-workflow/agent-start" ? { ...value, data: { ...value.data, childId: "missing-child" } } : value)
    .filter((value) => value.type !== "tool-workflow/agent-end");
  const value = { ...input, records, session: extractDshMeta(records, input.session.id), children: [] };
  const base = buildDshSessionProtocol(value);
  const v3 = finalizeSessionProtocolV3(buildDshSessionProtocolV3(value, base));
  const workflow = v3.coordination.find((entry) => entry.correlationId === "workflow-1:1");
  assert.equal(workflow?.toSessionRef, null);
  assert.equal(workflow?.runId, null);
  assert.equal(workflow?.provenance.fidelity, "recorded");
  assert.equal(v3.validation?.ok, true);
});

test("DSH native v3 keeps a recorded goal clear as an event tombstone", () => {
  const { input } = fixture();
  const records = [...input.records, event("goal/change", 17, { kind: "goal/change", version: 1, operation: "clear", cleared: { id: "goal-1", revision: 3 }, clearedAt: 1017 })];
  const value = { ...input, records, session: extractDshMeta(records, input.session.id) };
  const base = buildDshSessionProtocol(value);
  const v3 = finalizeSessionProtocolV3(buildDshSessionProtocolV3(value, base));
  assert.equal(v3.goals.some((value) => value.id === "goal:goal-1"), false);
  const clear = v3.events.filter((value) => value.providerData?.eventType === "goal/change").at(-1);
  assert.equal(clear?.providerData?.sourceSequence, 17000);
  assert.equal(clear?.providerData?.goalId, "goal-1");
  assert.equal(clear?.providerData?.revision, 3);
  assert.equal(clear?.providerData?.clearedAt, 1017);
});

test("DSH native v3 follows the released single-current-goal fold", () => {
  const { input } = fixture();
  const records = [
    input.records[0],
    event("goal/change", 1, {
      kind: "goal/change", version: 1, operation: "create",
      goal: { id: "goal-a", revision: 1, objective: "A", phase: "active", maxGoalRounds: 2 },
      roundsStarted: 0, createdAt: 1001, updatedAt: 1001
    }),
    event("goal/change", 2, {
      kind: "goal/change", version: 1, operation: "complete",
      goal: { id: "goal-a", revision: 2, objective: "A", phase: "complete", maxGoalRounds: 2 },
      roundsStarted: 0, createdAt: 1001, updatedAt: 1002
    }),
    event("goal/change", 3, {
      kind: "goal/change", version: 1, operation: "create",
      goal: { id: "goal-b", revision: 1, objective: "B", phase: "active", maxGoalRounds: 2 },
      roundsStarted: 0, createdAt: 1003, updatedAt: 1003
    })
  ];
  const value = { ...input, records, session: extractDshMeta(records, input.session.id), children: [] };
  const base = buildDshSessionProtocol(value);
  const v3 = finalizeSessionProtocolV3(buildDshSessionProtocolV3(value, base));
  assert.deepEqual(v3.goals.map((goal) => [goal.id, goal.description]), [["goal:goal-b", "B"]]);

  const cleared = [...records, event("goal/change", 4, {
    kind: "goal/change", version: 1, operation: "clear",
    cleared: { id: "goal-b", revision: 2 }, clearedAt: 1004
  })];
  const clearedValue = { ...value, records: cleared, session: extractDshMeta(cleared, input.session.id) };
  const clearedBase = buildDshSessionProtocol(clearedValue);
  const clearedV3 = finalizeSessionProtocolV3(buildDshSessionProtocolV3(clearedValue, clearedBase));
  assert.deepEqual(clearedV3.goals, []);
  assert.equal(clearedV3.events.at(-1)?.providerData?.eventType, "goal/change");
});

test("DSH native v3 rejects stale goal replay and reports the source sequence", () => {
  const { input } = fixture();
  const records = [
    input.records[0],
    event("goal/change", 1, {
      kind: "goal/change", version: 1, operation: "create",
      goal: { id: "goal-a", revision: 1, objective: "A", phase: "active", maxGoalRounds: 2 },
      roundsStarted: 0, createdAt: 1001, updatedAt: 1001
    }),
    event("goal/change", 2, {
      kind: "goal/change", version: 1, operation: "clear",
      cleared: { id: "goal-a", revision: 3 }, clearedAt: 1002
    })
  ];
  const value = { ...input, records, session: extractDshMeta(records, input.session.id), children: [] };
  const base = buildDshSessionProtocol(value);
  const v3 = finalizeSessionProtocolV3(buildDshSessionProtocolV3(value, base));
  assert.deepEqual(v3.goals, []);
  assert.equal(v3.coverage.work.state, "unknown");
  assert.match(v3.coverage.work.details, /source seq 2/);
  assert.equal(v3.events.at(-1)?.providerData?.revision, 3);
});

test("DSH native v3 rejects duplicate goal creation without hiding raw events", () => {
  const { input } = fixture();
  const create = event("goal/change", 1, {
    kind: "goal/change", version: 1, operation: "create",
    goal: { id: "goal-a", revision: 1, objective: "A", phase: "active", maxGoalRounds: 2 },
    roundsStarted: 0, createdAt: 1001, updatedAt: 1001
  });
  const records = [input.records[0], create, { ...create, seq: 2, time: 1002 }];
  const value = { ...input, records, session: extractDshMeta(records, input.session.id), children: [] };
  const base = buildDshSessionProtocol(value);
  const v3 = finalizeSessionProtocolV3(buildDshSessionProtocolV3(value, base));
  assert.deepEqual(v3.goals, []);
  assert.equal(v3.coverage.work.state, "unknown");
  assert.match(v3.coverage.work.details, /source seq 2/);
  assert.equal(v3.events.length, 2);
});

test("DSH native v3 keeps task-only Work coverage observed", () => {
  const { input } = fixture();
  const records = [
    input.records[0],
    event("team/task", 1, { version: 2, teamId: input.session.id, task: { id: "task-only", revision: 1, subject: "Task", description: "Task", status: "pending", blockedBy: [], writeScopes: [] } })
  ];
  const value = { ...input, records, session: extractDshMeta(records, input.session.id), children: [] };
  const base = buildDshSessionProtocol(value);
  const v3 = finalizeSessionProtocolV3(buildDshSessionProtocolV3(value, base));
  assert.deepEqual(v3.goals, []);
  assert.equal(base.tasks.length, 1);
  assert.equal(v3.coverage.work.state, "observed");
});

test("DSH native v3 retains zero-token legacy assistant settlements", () => {
  const { input } = fixture();
  const records = [
    header(input.session.id, { version: 1, isSeeded: false, seedLength: 0 }),
    event("assistant/message", 0, {
      turn: 1, step: 1,
      message: { id: "legacy-assistant", role: "assistant", source: { kind: "model", provider: "deepseek", model: "legacy" }, content: [] },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    })
  ];
  const value = { ...input, records, session: extractDshMeta(records, input.session.id), children: [] };
  const base = buildDshSessionProtocol(value);
  const v3 = finalizeSessionProtocolV3(buildDshSessionProtocolV3(value, base));
  assert.equal(v3.usageRecords.length, 1);
  assert.deepEqual(v3.usageRecords[0].tokens, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 });
});

test("DSH native v3 counts its root actor as observed execution evidence", () => {
  const { input } = fixture();
  const records = [input.records[0]];
  const value = { ...input, records, session: extractDshMeta(records, input.session.id), children: [] };
  const base = buildDshSessionProtocol(value);
  const v3 = finalizeSessionProtocolV3(buildDshSessionProtocolV3(value, base));
  assert.equal(v3.coverage.execution.state, "observed");
  assert.equal(v3.validation?.ok, true);
  assert.equal(v3.validation?.errors.some((error) => error.code === "COVERAGE_ENTITY_CONTRADICTION"), false);
});
