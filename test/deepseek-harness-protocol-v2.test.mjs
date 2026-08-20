import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { DSH_COMPATIBILITY_SNAPSHOT } from "../dist/src/providers/deepseek-harness/compatibility.js";
import {
  dshRecordsToMessages,
  extractDshMeta,
  parseDshSession
} from "../dist/src/providers/deepseek-harness/parser.js";
import { buildDshSessionProtocol } from "../dist/src/providers/deepseek-harness/protocol.js";

function sessionHeader(id, overrides = {}) {
  return {
    type: "session",
    version: 0,
    id,
    createdAt: 1000,
    cwd: "D:\\WorkSpace\\dsh-protocol-fixture",
    delegationDepth: 2,
    seedLength: 0,
    agentPreset: "team-worker",
    ...overrides
  };
}

function records(header, specs) {
  return [header, ...specs.map((spec, index) => ({
    type: spec.type,
    seq: index,
    time: 1001 + index,
    data: spec.data || {},
    ...(spec.surfaceOp ? { surfaceOp: spec.surfaceOp } : {})
  }))];
}

test("DSH rc.8 protocol v2 maps recorded control/team facts without message projection", () => {
  const parentId = "dsh-v2-parent";
  const childId = "dsh-v2-member";
  const parentRecords = records(sessionHeader(parentId), [
    { type: "session/end-seed", data: { seedLength: 0 } },
    { type: "request/header", data: { reason: "initial", header: { system: "stored", config: { provider: "deepseek", model: "deepseek-v4-pro" } } } },
    { type: "request/context", data: { provider: "deepseek", model: "deepseek-v4-pro", contextWindow: 1000000 } },
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "tool/call", data: { turn: 1, step: 1, callId: "call-1", name: "read" } },
    { type: "tool/result", data: { turn: 1, step: 1, message: { source: { kind: "tool", callId: "call-1" }, content: [{ type: "tool-result", toolCallId: "call-1", isError: false }] } } },
    { type: "compaction/start", data: { compactionId: "compact-1", turn: 1 } },
    { type: "compaction/summary", data: { compactionId: "compact-1", summary: [{ type: "text", text: "recorded summary" }] } },
    { type: "compaction/end", data: { compactionId: "compact-1", turn: 1 } },
    { type: "agent/inbox/spliced", data: { operation: "claim", messageIds: ["user-1"] } },
    { type: "team/member", data: { version: 1, teamId: parentId, member: { id: childId, name: "worker", description: "worker", provider: "subagent", context: "fresh", phase: "active" } } },
    { type: "team/task", data: { version: 1, teamId: parentId, task: { id: "task-1", revision: 3, subject: "Inspect", description: "Inspect files", status: "in_progress", ownerId: childId, blockedBy: ["task-0"], writeScopes: ["src"] } } },
    { type: "team/message/queued", data: { version: 1, teamId: parentId, message: { id: "team-message-1", senderId: parentId, senderName: "lead", targetId: childId, delivery: "quiet", content: [{ type: "text", text: "do not project" }] } } },
    { type: "team/message/delivered", data: { version: 1, teamId: parentId, messageId: "team-message-1", targetId: childId } },
    { type: "step/end", data: { turn: 1, step: 1 } },
    { type: "assistant/message", data: { turn: 1, step: 1, message: { id: "assistant-1", source: { provider: "deepseek", model: "deepseek-v4-pro" }, content: [{ type: "text", text: "done" }] }, usage: { inputTokens: 100, outputTokens: 30, reasoningTokens: 10, cacheReadTokens: 5 } } },
    { type: "turn/end", data: { turn: 1, reason: { kind: "interrupted" } } }
  ]);
  const childRecords = records(sessionHeader(childId, { parentSession: parentId, origin: "subagent", delegationDepth: 3 }), [
    { type: "subagent/descriptor", data: { version: 2, mode: "one-shot", provider: "subagent", label: "worker" } },
    { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } }
  ]);
  const parent = extractDshMeta(parentRecords);
  const child = extractDshMeta(childRecords);
  const protocol = buildDshSessionProtocol({
    session: parent,
    records: parentRecords,
    messages: dshRecordsToMessages(parentRecords, parentId),
    children: [{ session: child, records: childRecords, messages: dshRecordsToMessages(childRecords, childId) }]
  });

  assert.equal(protocol.version, 2);
  assert.equal(protocol.revision?.value, DSH_COMPATIBILITY_SNAPSHOT.tag);
  assert.equal(protocol.session?.state, "cancelled");
  assert.equal(protocol.session?.harness, "team-worker");
  assert.equal(protocol.session?.forkSeedBoundary, 0);
  assert.equal(protocol.session?.inheritedEventCount, 0);
  assert.equal(protocol.completeness, "partial", "recorded dependency on an unavailable task is surfaced as partial evidence");
  assert.equal(protocol.validation?.ok, true);
  assert.ok(protocol.validation?.warnings.some((warning) => warning.code === "TASK_DEPENDENCY_DANGLING"));
  assert.equal(protocol.events[0]?.providerData?.delegationDepth, 2);
  assert.equal(protocol.events[0]?.providerData?.agentPreset, "team-worker");

  const event = (kind) => protocol.events.find((candidate) => candidate.kind === kind);
  assert.equal(event("session.end-seed")?.category, "session");
  assert.equal(event("request.header")?.category, "model");
  assert.equal(event("request.context")?.category, "model");
  assert.equal(event("tool.call")?.normalizedKind, "tool.called");
  assert.equal(event("context.compaction")?.category, "context");
  assert.equal(event("control.inbox.spliced")?.category, "control");
  assert.equal(event("team.member")?.category, "team");
  assert.equal(event("team.task")?.category, "team");
  assert.equal(event("team.message.queued")?.category, "team");
  assert.equal(event("team.message.delivered")?.category, "team");
  const assistantEvent = protocol.events.find((candidate) => candidate.providerData?.eventType === "assistant/message");
  assert.deepEqual(assistantEvent?.providerData?.usage, { input: 100, output: 20, reasoning: 10, total: 135, cache: { read: 5, write: 0 } });
  const turnEndEvent = protocol.events.find((candidate) => candidate.providerData?.eventType === "turn/end");
  assert.equal(turnEndEvent?.providerData?.reasonKind, "interrupted");

  const task = protocol.tasks.find((candidate) => candidate.id === "team:task-1");
  assert.equal(task?.revision, 3);
  assert.equal(task?.owner, childId);
  assert.deepEqual(task?.dependencies, ["team:task-0"]);
  const memberRun = protocol.agentRuns.find((candidate) => candidate.id === `team-member:${childId}`);
  assert.equal(memberRun?.childSessionId, childId);
  assert.ok(protocol.relationships.some((relation) => relation.toSessionId === childId && relation.provenance.sourceType === "dsh.session-event:team/member"));
  assert.equal(protocol.events.some((candidate) => JSON.stringify(candidate).includes("do not project")), false);
});

test("DSH protocol preserves dangling workflow references without inventing a child session", () => {
  const parentId = "dsh-v2-dangling";
  const recordsValue = records(sessionHeader(parentId), [
    { type: "tool-workflow/agent-start", data: { runId: "workflow-1", seq: 0, label: "Missing", childId: "missing-child" } },
    { type: "tool-workflow/agent-end", data: { runId: "workflow-1", seq: 0, outcome: { kind: "completed" } } }
  ]);
  const session = extractDshMeta(recordsValue);
  const protocol = buildDshSessionProtocol({ session, records: recordsValue, messages: [], children: [] });
  const run = protocol.agentRuns.find((candidate) => candidate.childSessionId === "missing-child");
  assert.equal(run?.metadata?.childSessionAvailable, false);
  assert.equal(run?.metadata?.danglingChildSessionId, "missing-child");
  assert.equal(protocol.relationships.find((relation) => relation.toSessionId === "missing-child")?.details?.includes("not present"), true);
});

test("official rc.8 fresh-round-trip fixture parses packed rows into protocol v2", () => {
  const fixturePath = path.join(process.cwd(), DSH_COMPATIBILITY_SNAPSHOT.fixture.local);
  const recordsValue = parseDshSession(fixturePath);
  const session = extractDshMeta(recordsValue, "rc8-official-fixture");
  const messages = dshRecordsToMessages(recordsValue, session.id);
  const protocol = buildDshSessionProtocol({ session, records: recordsValue, messages, children: [] });

  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.fixture.source, "apps/web/tests/snapshots/fresh-round-trip/session.jsonl");
  assert.equal(protocol.version, 2);
  assert.equal(protocol.validation?.ok, true);
  assert.ok(recordsValue.some((record) => record.type === "assistant/chunk" && record.seq > 6), "packed reasoning/tool rows expand into source events");
  assert.ok(protocol.events.some((event) => event.providerData?.eventType === "assistant/message" && event.providerData?.usage));
  assert.ok(protocol.events.some((event) => event.normalizedKind === "tool.called"));
  assert.ok(messages.some((message) => message.role === "assistant" && message.tokens?.total > 0));
});
