import assert from "node:assert/strict";
import test from "node:test";

import { buildCodexSessionProtocol, buildCodexSessionProtocolV3 } from "../dist/src/providers/codex/protocol.js";
import { finalizeSessionProtocol, protocolRevision } from "../dist/src/providers/shared/session-protocol.js";
import { finalizeSessionProtocolV3 } from "../dist/src/providers/shared/session-protocol-v3.js";
import { clearProtocolRuntimeCache, getRuntimeProtocolV3 } from "../dist/src/protocol-runtime.js";

const ts = (value) => `2026-08-31T${value}:00.000Z`;

const rawSession = (id, parentId = null, metadata = null, timeCreated = 1000, timeUpdated = 1100) => ({
  id,
  provider: "codex",
  parentId,
  title: id,
  directory: "D:\\WorkSpace",
  timeCreated,
  timeUpdated,
  messageCount: 1,
  tokenCount: null,
  metadata
});

function buildFixture() {
  const records = [
    { type: "session_meta", timestamp: ts("10:00:00"), ordinal: 0, payload: { session_id: "root", cwd: "D:\\WorkSpace", thread_source: "user" } },
    // Recorded user suspension of the session goal: last update is paused.
    { type: "event_msg", timestamp: ts("10:00:10"), ordinal: 10, payload: { type: "thread_goal_updated", threadId: "root", goal: { threadId: "root", objective: "Implement the v3 mapping.", status: "active", createdAt: 10, updatedAt: 11 } } },
    { type: "event_msg", timestamp: ts("10:00:12"), ordinal: 11, payload: { type: "thread_goal_updated", threadId: "root", goal: { threadId: "root", objective: "Implement the v3 mapping.", status: "paused", createdAt: 10, updatedAt: 12 } } },
    { type: "event_msg", timestamp: ts("10:00:05"), ordinal: 5, payload: { type: "thread_settings_applied", thread_settings: { model: "gpt-5.6-sol" } } },
    // Recorded context window chain: w0 -> w1 -> w2.
    { type: "compacted", timestamp: ts("10:05:00"), ordinal: 20, payload: { message: "", replacement_history: [{ type: "message", id: "msg-1" }], window_number: 1, window_id: "w1", previous_window_id: "w0", first_window_id: "w0" } },
    { type: "compacted", timestamp: ts("10:06:00"), ordinal: 21, payload: { message: "", replacement_history: [{ type: "message", id: "msg-2" }], window_number: 2, window_id: "w2", previous_window_id: "w1", first_window_id: "w0" } },
    // Recorded collaboration tool calls.
    { type: "response_item", timestamp: ts("10:07:00"), ordinal: 100, payload: { type: "function_call", id: "fc-1", call_id: "call-1", name: "spawn_agent", namespace: "collaboration", arguments: JSON.stringify({ task_name: "reviewer", fork_turns: "none", model: "gpt-5.6-sol" }), internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } } },
    { type: "response_item", timestamp: ts("10:07:01"), ordinal: 101, payload: { type: "function_call_output", id: "fco-1", call_id: "call-1", output: '{"task_name":"/root/reviewer"}' } },
    { type: "response_item", timestamp: ts("10:08:00"), ordinal: 102, payload: { type: "function_call", id: "fc-2", call_id: "call-2", name: "followup_task", namespace: "collaboration", arguments: JSON.stringify({ target: "reviewer", message: "encrypted" }) } },
    { type: "response_item", timestamp: ts("10:08:10"), ordinal: 103, payload: { type: "function_call", id: "fc-3", call_id: "call-3", name: "send_message", namespace: "collaboration", arguments: JSON.stringify({ target: "reviewer", message: "encrypted" }) } },
    { type: "response_item", timestamp: ts("10:08:20"), ordinal: 104, payload: { type: "function_call", id: "fc-4", call_id: "call-4", name: "wait_agent", namespace: "collaboration", arguments: JSON.stringify({ timeout_ms: 1000 }) } },
    { type: "response_item", timestamp: ts("10:08:30"), ordinal: 105, payload: { type: "function_call", id: "fc-5", call_id: "call-5", name: "interrupt_agent", namespace: "collaboration", arguments: JSON.stringify({ target: "reviewer" }) } },
    // Mailbox query: not a coordination fact.
    { type: "response_item", timestamp: ts("10:08:40"), ordinal: 106, payload: { type: "function_call", id: "fc-6", call_id: "call-6", name: "list_agents", namespace: "collaboration", arguments: "{}" } },
    // Recorded result delivery from the child agent.
    { type: "response_item", timestamp: ts("10:09:00"), ordinal: 200, payload: { type: "agent_message", id: "amsg-1", author: "/root/reviewer", recipient: "/root", content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/reviewer\nPayload:\nDone." }] } },
    // The session's own FINAL_ANSWER is not result delivery.
    { type: "response_item", timestamp: ts("10:09:10"), ordinal: 201, payload: { type: "agent_message", id: "amsg-2", author: "/root", recipient: "/root", content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nTask name: /root\nPayload:\nSelf summary." }] } },
    // Recorded request usage (two requests).
    { type: "event_msg", timestamp: ts("10:10:00"), ordinal: 300, payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 30, cache_write_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } } } },
    { type: "event_msg", timestamp: ts("10:11:00"), ordinal: 400, payload: { type: "token_count", info: { last_token_usage: { input_tokens: 200, cached_input_tokens: 50, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 10, total_tokens: 240 } } } },
    // Compaction-window reset marker: components zero, total is the context size.
    { type: "event_msg", timestamp: ts("10:12:00"), ordinal: 503, payload: { type: "token_count", info: { last_token_usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 26210 } } } },
    // Same-named tools outside the collaboration namespace are not coordination.
    { type: "response_item", timestamp: ts("10:13:00"), ordinal: 500, payload: { type: "custom_tool_call", id: "fc-9", call_id: "call-9", name: "wait", arguments: JSON.stringify({ cell_id: "65", yield_time_ms: 60000, max_tokens: 14000 }) } },
    { type: "response_item", timestamp: ts("10:13:01"), ordinal: 501, payload: { type: "function_call", id: "fc-11", call_id: "call-11", name: "exec", arguments: "{}" } },
    // A spawn without any recorded launch acknowledgement stays requested.
    { type: "response_item", timestamp: ts("10:14:00"), ordinal: 502, payload: { type: "function_call", id: "fc-10", call_id: "call-10", name: "spawn_agent", namespace: "collaboration", arguments: JSON.stringify({ task_name: "fresher" }) } }
  ];
  const session = rawSession("root", null, null, 1000, 1000);
  const child = rawSession("child-1", "root", { agentPath: "/root/reviewer", agentNickname: "reviewer" }, 1070, 1080);
  return {
    input: {
      session,
      messages: [],
      records,
      children: [{ session: child, messages: [], records: [] }]
    },
    session,
    child
  };
}

function finalizedPair() {
  const { input, session } = buildFixture();
  const base = finalizeSessionProtocol(buildCodexSessionProtocol(input), {
    provider: "codex",
    session,
    revision: protocolRevision("fixture")
  });
  const v3 = finalizeSessionProtocolV3(buildCodexSessionProtocolV3(input, base));
  return { base, v3, session, child: null };
}

test("Codex v3 mapping validates with zero errors and preserves v2 facts", () => {
  const { base, v3 } = finalizedPair();
  assert.equal(v3.validation?.ok, true);
  assert.deepEqual(v3.validation?.errors, []);
  assert.equal(v3.version, 3);
  assert.equal(v3.tasks.length, base.tasks.length);
  assert.equal(v3.agentRuns.length, base.agentRuns.length);
  assert.equal(v3.events.length, base.events.length);
  assert.equal(v3.contextArtifacts.length, base.contextArtifacts.length);
  assert.equal(v3.upgrade, undefined);
});
test("Codex v3 maps recorded goals with honest paused handling", () => {
  const { v3 } = finalizedPair();
  assert.equal(v3.goals.length, 1);
  const goalValue = v3.goals[0];
  assert.equal(goalValue.id, "goal:root");
  assert.equal(goalValue.description, "Implement the v3 mapping.");
  // Last recorded status is paused, which has no protocol status: unknown.
  assert.equal(goalValue.status, "unknown");
  assert.equal(goalValue.timeCreated, 10000);
  assert.equal(goalValue.timeUpdated, 12000);
  assert.deepEqual(goalValue.taskIds, []);
  assert.equal(goalValue.provenance.sourceType, "codex.event_msg:thread_goal_updated");
});

test("Codex v3 maps actors: parent recipient path, child agent path, envelope paths", () => {
  const { v3 } = finalizedPair();
  const parent = v3.actors.find((value) => value.id === "actor:root");
  assert.ok(parent);
  assert.equal(parent.providerActorId, "/root");
  assert.equal(parent.sessionRef?.sessionId, "root");
  const child = v3.actors.find((value) => value.id === "actor:child-1");
  assert.ok(child);
  assert.equal(child.providerActorId, "/root/reviewer");
  assert.deepEqual(child.runIds, ["child-1"]);
  assert.equal(child.sessionRef?.sessionId, "child-1");
});

test("Codex v3 maps the recorded collaboration family and skips mailbox queries", () => {
  const { v3 } = finalizedPair();
  const kinds = v3.coordination.map((value) => value.kind);
  assert.deepEqual([...kinds].sort(), ["follow-up", "interrupt", "message", "result-delivery", "spawn", "spawn", "wait"].sort());
  assert.equal(v3.coordination.filter((value) => value.kind === "spawn").length, 2);
  const spawn = v3.coordination.find((value) => value.kind === "spawn");
  assert.equal(spawn?.state, "started");
  assert.equal(spawn?.toSessionRef?.sessionId, "child-1");
  assert.equal(spawn?.taskId, "call-1");
  assert.equal(spawn?.runId, "child-1");
  assert.equal(spawn?.turnId, "turn-1");
  assert.equal(spawn?.relationshipType, "spawned");
  assert.equal(spawn?.senderActorId, "actor:root");
  assert.equal(spawn?.recipientActorId, "actor:child-1");
  const followUp = v3.coordination.find((value) => value.kind === "follow-up");
  assert.equal(followUp?.taskId, "call-1");
  assert.equal(followUp?.recipientActorId, "actor:child-1");
  const interrupt = v3.coordination.find((value) => value.kind === "interrupt");
  assert.equal(interrupt?.taskId, "call-1");
  assert.equal(interrupt?.state, "unknown");
  const wait = v3.coordination.find((value) => value.kind === "wait");
  assert.equal(wait?.taskId, null);
  // Only the collaboration-namespaced wait_agent maps; cell `wait` and `exec`
  // outside the namespace never produce observations.
  assert.equal(v3.coordination.filter((value) => value.kind === "wait").length, 1);
  assert.ok(!v3.coordination.some((value) => value.correlationId === "call-9" || value.correlationId === "call-11"));
  const delivery = v3.coordination.find((value) => value.kind === "result-delivery");
  assert.equal(delivery?.state, "delivered");
  assert.equal(delivery?.fromSessionRef?.sessionId, "child-1");
  assert.equal(delivery?.senderActorId, "actor:child-1");
  assert.equal(delivery?.correlationId, "amsg-1");
  assert.equal(v3.coordination.filter((value) => value.kind === "result-delivery").length, 1);
  assert.ok(!v3.coordination.some((value) => value.id.includes("list_agents")));
  const requested = v3.coordination.find((value) => value.kind === "spawn" && value.state === "requested");
  assert.ok(requested, "spawn without recorded acknowledgement stays requested");
  assert.equal(requested.taskId, "call-10");
  assert.equal(requested.toSessionRef, null);
});

test("Codex v3 skips window-reset usage markers with all-zero components", () => {
  const { v3 } = finalizedPair();
  assert.equal(v3.usageRecords.length, 2);
  assert.ok(!v3.usageRecords.some((value) => value.id.endsWith(":503")));
  assert.ok(v3.validation?.ok);
});

test("Codex v3 maps the recorded window chain into versions and transformations", () => {
  const { v3 } = finalizedPair();
  assert.deepEqual(
    v3.contextVersions.map((value) => ({ id: value.id, sequence: value.sequence, parents: value.parentVersionIds })),
    [
      { id: "w0", sequence: null, parents: [] },
      { id: "w1", sequence: 1, parents: ["w0"] },
      { id: "w2", sequence: 2, parents: ["w1"] }
    ]
  );
  assert.equal(v3.contextTransformations.length, 2);
  const first = v3.contextTransformations[0];
  assert.equal(first.kind, "compaction");
  assert.deepEqual(first.sourceVersionIds, ["w0"]);
  assert.equal(first.resultVersionId, "w1");
  assert.equal(first.eventId, "event:compaction:4");
  assert.deepEqual(first.resultArtifactIds, ["artifact:4"]);
  assert.deepEqual(v3.contextTransformations[1].resultArtifactIds, ["artifact:5"]);
});

test("Codex v3 normalizes recorded request usage to the component contract", () => {
  const { v3 } = finalizedPair();
  assert.equal(v3.usageRecords.length, 2);
  const firstUsage = v3.usageRecords[0];
  assert.equal(firstUsage.id, "usage:root:300");
  assert.equal(firstUsage.scope, "request");
  assert.equal(firstUsage.sessionRef.sessionId, "root");
  assert.deepEqual(firstUsage.tokens, { input: 60, cacheRead: 30, cacheWrite: 10, output: 15, reasoning: 5, total: 120 });
  assert.equal(firstUsage.model, "gpt-5.6-sol");
  assert.equal(firstUsage.provenance.fidelity, "derived");
  assert.equal(v3.usageRecords[1].tokens.total, 240);
  assert.equal(v3.usageRecords[1].tokens.input + v3.usageRecords[1].tokens.cacheRead + v3.usageRecords[1].tokens.cacheWrite + v3.usageRecords[1].tokens.output + v3.usageRecords[1].tokens.reasoning, 240);
});

test("Codex v3 coverage is observed per recorded domain and never inferred from zero", () => {
  const { v3 } = finalizedPair();
  for (const domain of ["work", "execution", "coordination", "context", "usage"]) {
    assert.equal(v3.coverage[domain].state, "observed", domain);
  }
  // A session without recorded coordination still reports not-observed, not unknown.
  const bareFixture = buildFixture();
  const bareRecords = bareFixture.input.records.filter((record) => (
    record.type === "session_meta"
    || (record.type === "event_msg" && ["thread_goal_updated", "thread_settings_applied", "token_count"].includes(record.payload?.type))
    || record.type === "compacted"
  ));
  const bareBase = finalizeSessionProtocol(buildCodexSessionProtocol({ ...bareFixture.input, records: bareRecords, children: [] }), {
    provider: "codex",
    session: bareFixture.session,
    revision: protocolRevision("fixture")
  });
  const bareV3 = finalizeSessionProtocolV3(buildCodexSessionProtocolV3({ ...bareFixture.input, records: bareRecords, children: [] }, bareBase));
  assert.equal(bareV3.validation?.ok, true);
  assert.equal(bareV3.coordination.length, 0);
  assert.equal(bareV3.coverage.coordination.state, "not-observed");
  assert.equal(bareV3.coverage.work.state, "observed");
  assert.equal(bareV3.coverage.usage.state, "observed");
});

test("Codex v3 leaves ambiguous task-name matches unbound instead of guessing", () => {
  const records = [
    { type: "session_meta", timestamp: ts("10:00:00"), ordinal: 0, payload: { session_id: "root" } },
    { type: "response_item", timestamp: ts("10:01:00"), ordinal: 1, payload: { type: "function_call", id: "fc-a", call_id: "call-a", name: "spawn_agent", namespace: "collaboration", arguments: JSON.stringify({ task_name: "team-reviewer" }) } },
    { type: "response_item", timestamp: ts("10:01:01"), ordinal: 2, payload: { type: "function_call_output", id: "fco-a", call_id: "call-a", output: '{"task_name":"/root/team-reviewer"}' } },
    { type: "response_item", timestamp: ts("10:02:00"), ordinal: 3, payload: { type: "function_call", id: "fc-b", call_id: "call-b", name: "spawn_agent", namespace: "collaboration", arguments: JSON.stringify({ task_name: "ui-reviewer" }) } },
    { type: "response_item", timestamp: ts("10:02:01"), ordinal: 4, payload: { type: "function_call_output", id: "fco-b", call_id: "call-b", output: '{"task_name":"/root/ui-reviewer"}' } },
    { type: "response_item", timestamp: ts("10:03:00"), ordinal: 5, payload: { type: "function_call", id: "fc-f", call_id: "call-f", name: "followup_task", namespace: "collaboration", arguments: JSON.stringify({ target: "reviewer" }) } }
  ];
  const session = rawSession("root2", null, null, 1000, 1000);
  const children = [
    rawSession("child-a", "root2", { agentPath: "/root/team-reviewer" }, 1010, 1020),
    rawSession("child-b", "root2", { agentPath: "/root/ui-reviewer" }, 1030, 1040)
  ].map((child) => ({ session: child, messages: [], records: [] }));
  const input = { session, messages: [], records, children };
  const base = finalizeSessionProtocol(buildCodexSessionProtocol(input), { provider: "codex", session, revision: protocolRevision("fixture") });
  const v3 = finalizeSessionProtocolV3(buildCodexSessionProtocolV3(input, base));
  assert.equal(v3.validation?.ok, true);
  const followUp = v3.coordination.find((value) => value.kind === "follow-up");
  assert.equal(followUp?.taskId, null, "ambiguous suffix match must not guess a task");
  assert.equal(followUp?.toSessionRef, null);
});

test("Codex v3 parent actor provenance names session_meta when it records the path", () => {
  const { input, session } = buildFixture();
  input.records[0].payload.agent_path = "/root";
  const base = finalizeSessionProtocol(buildCodexSessionProtocol(input), { provider: "codex", session, revision: protocolRevision("fixture") });
  const v3 = finalizeSessionProtocolV3(buildCodexSessionProtocolV3(input, base));
  const parent = v3.actors.find((value) => value.id === "actor:root");
  assert.equal(parent?.provenance.sourceType, "codex.session_meta.agent_path");
  assert.equal(parent?.providerActorId, "/root");
});

test("Codex v3 context coverage is not-observed without any compacted evidence", () => {
  const bareFixture = buildFixture();
  const records = bareFixture.input.records.filter((record) => (
    record.type === "session_meta"
    || (record.type === "event_msg" && ["thread_goal_updated", "thread_settings_applied", "token_count"].includes(record.payload?.type))
  ));
  const base = finalizeSessionProtocol(buildCodexSessionProtocol({ ...bareFixture.input, records, children: [] }), {
    provider: "codex",
    session: bareFixture.session,
    revision: protocolRevision("fixture")
  });
  const v3 = finalizeSessionProtocolV3(buildCodexSessionProtocolV3({ ...bareFixture.input, records, children: [] }, base));
  assert.equal(v3.validation?.ok, true);
  assert.equal(v3.contextVersions.length, 0);
  assert.equal(v3.contextTransformations.length, 0);
  assert.equal(v3.contextArtifacts.length, 0);
  assert.equal(v3.coverage.context.state, "not-observed");
});

test("getRuntimeProtocolV3 uses the provider-native v3 snapshot when present", () => {
  clearProtocolRuntimeCache();
  let calls = 0;
  const native = finalizeSessionProtocolV3(buildCodexSessionProtocolV3(buildFixture().input, finalizeSessionProtocol(buildCodexSessionProtocol(buildFixture().input), { provider: "codex", session: buildFixture().session, revision: protocolRevision("fixture") })));
  const adapter = {
    id: "codex",
    getStatsRevision: () => revision,
    getSessionProtocolV3: (sessionId) => { calls += 1; return sessionId === "root" ? native : null; },
    getSessionProtocol: () => null,
    getSession: () => ({ id: "root" })
  };
  let revision = "r1";
  const resolved = getRuntimeProtocolV3(adapter, "root");
  assert.equal(resolved, native);
  assert.equal(calls, 1);
  // Cached on the second call for the same revision.
  getRuntimeProtocolV3(adapter, "root");
  assert.equal(calls, 1);
  // A changed revision rebuilds the native snapshot.
  revision = "r2";
  getRuntimeProtocolV3(adapter, "root");
  assert.equal(calls, 2);
  clearProtocolRuntimeCache();
});
