import assert from "node:assert/strict";
import test from "node:test";

import { buildCodexSessionProtocol, buildCodexSessionProtocolV3, codexProtocolChildFactsFromRecords, codexTurnEventId } from "../dist/src/providers/codex/protocol.js";
import { classifyCodexRecordProvenance } from "../dist/src/providers/codex/parser.js";
import { finalizeSessionProtocolV3, validateSessionProtocolV3, coordinationObservation } from "../dist/src/providers/shared/session-protocol-v3.js";

const session = (id, parentId = null) => ({
  id, provider: "codex", parentId, title: id, directory: null,
  timeCreated: 1, timeUpdated: 2, messageCount: 0, tokenCount: null, metadata: { agentPath: id === "child" ? "/root/worker" : "/root" }
});

const terminal = (ordinal, turnId, completedAt) => ({
  type: "event_msg", ordinal, timestamp: "2026-09-10T14:00:00.000Z",
  payload: { type: "task_complete", turn_id: turnId, completed_at: completedAt }
});

test("Codex coordination joins interleaved outputs by exact call identity and recorded order", () => {
  const call = (id, name = "spawn_agent") => ({ type: "response_item", payload: {
    type: "function_call", call_id: id, name, namespace: "multi_agent_v1", arguments: "{}"
  } });
  const output = (id, value, type = "function_call_output") => ({ type: "response_item", payload: {
    type, call_id: id, output: value
  } });
  const records = [
    call("requested"), call("started"), call("closed", "close_agent"),
    output("unrelated", "{}"), output("started", "{}", "custom_tool_call_output"),
    output("closed", '{"success":true}'), output("closed", '{"success":false}'),
    call("id-only"), { type: "response_item", payload: { type: "function_call_output", id: "id-only", output: "{}" } },
    call("different-call-id"), { type: "response_item", payload: { type: "function_call_output", id: "different-call-id", call_id: "another-call", output: "{}" } }
  ];
  const input = { session: session("root"), messages: [], records, children: [] };
  const protocol = buildCodexSessionProtocolV3(input, buildCodexSessionProtocol(input));
  assert.deepEqual(protocol.coordination.map(item => [item.correlationId, item.state]), [
    ["requested", "requested"], ["started", "started"], ["closed", "completed"],
    ["id-only", "started"], ["different-call-id", "requested"]
  ]);
});

test("Codex binds repeated follow-ups to exact tool events and keeps child completions distinct", () => {
  const parentRecords = [
    { type: "session_meta", payload: { id: "root" } },
    { type: "event_msg", payload: { type: "user_message", message: "parent request" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "parent answer" }] } },
    terminal(900, "parent-turn", 1789051000)
  ];
  const followup = (callId) => ({
    type: "response_item", ordinal: callId, payload: {
      type: "function_call", call_id: callId, name: "followup_task", namespace: "collaboration",
      arguments: JSON.stringify({ target: "worker", message: `follow-up ${callId}` })
    }
  });
  parentRecords.push(followup("call_yF7NacFLdY8grlhmTTxruqIA"), followup("call_55etxKa2ggN5inuc64r0WD6J"));
  const childRawRecords = [
    { type: "session_meta", payload: { id: "child", parent_thread_id: "root" } },
    { type: "session_meta", payload: { id: "root" } },
    parentRecords[1], parentRecords[2], parentRecords[3],
    terminal(948, "child-turn-1", 1789051433),
    terminal(1079, "child-turn-2", 1789051675)
  ];
  const childProvenance = classifyCodexRecordProvenance(childRawRecords, parentRecords);
  const childRecords = childRawRecords.filter((record) => childProvenance.get(record) === "session");
  assert.equal(childRecords.includes(childRawRecords[4]), false, "copied parent terminal is outside child ownership");

  const child = session("child", "root");
  const childBase = buildCodexSessionProtocol({ session: child, messages: [], records: childRecords, children: [] });
  const childProtocol = buildCodexSessionProtocolV3({ session: child, messages: [], records: childRecords, children: [] }, childBase);
  assert.deepEqual(childProtocol.events.filter((event) => event.id.includes("event:turn:task_complete:")).map((event) => event.id), [
    "event:turn:task_complete:948", "event:turn:task_complete:1079"
  ]);
  const childRun = {
    id: "child", sessionId: "root", taskId: "task-child", status: "completed", mode: "subagent",
    agent: "/root/worker", model: null, childSessionId: "child", timeStart: 1, timeEnd: 2,
    provenance: { fidelity: "derived", sourceType: "fixture.child", sourceId: "child" }
  };
  const base = buildCodexSessionProtocol({
    session: session("root"),
    messages: [
      { id: "call_yF7NacFLdY8grlhmTTxruqIA", sessionId: "root", role: "tool", content: "", thinking: null, toolName: "followup_task", toolInput: {}, toolOutput: null, timestamp: 1, tokens: null, metadata: { callId: "call_yF7NacFLdY8grlhmTTxruqIA" } },
      { id: "call_55etxKa2ggN5inuc64r0WD6J", sessionId: "root", role: "tool", content: "", thinking: null, toolName: "followup_task", toolInput: {}, toolOutput: null, timestamp: 2, tokens: null, metadata: { callId: "call_55etxKa2ggN5inuc64r0WD6J" } }
    ],
    records: parentRecords,
    children: [{ session: child, facts: codexProtocolChildFactsFromRecords(childRecords) }]
  });
  base.tasks.push({ id: "task-child", sessionId: "root", kind: "subagent-task", status: "completed", title: "worker", toolCallId: "spawn-call", correlationId: "spawn-call", agentPath: "/root/worker", timeCreated: 1, timeUpdated: 2, timeCompleted: 2, provenance: { fidelity: "recorded", sourceType: "fixture.task", sourceId: "spawn-call" } });
  base.agentRuns.push(childRun);

  const protocol = buildCodexSessionProtocolV3({
    session: session("root"), messages: [], records: parentRecords,
    children: [{ session: child, facts: codexProtocolChildFactsFromRecords(childRecords) }]
  }, base);
  const followups = protocol.coordination.filter((item) => item.kind === "follow-up");
  assert.deepEqual(followups.map((item) => item.eventId), [
    "event:call_yF7NacFLdY8grlhmTTxruqIA",
    "event:call_55etxKa2ggN5inuc64r0WD6J"
  ]);
  assert.deepEqual(followups.map((item) => [item.taskId, item.runId]), [
    ["task-child", "child"], ["task-child", "child"]
  ]);
  const completions = protocol.coordination.filter((item) => item.kind === "child-turn-completed");
  assert.deepEqual(completions.map((item) => item.sourceEventRef.eventId), [
    "event:turn:task_complete:948", "event:turn:task_complete:1079"
  ]);
  assert.deepEqual(completions.map((item) => item.timestamp), [1789051433000, 1789051675000]);
  assert.deepEqual(completions.map((item) => [item.taskId, item.runId]), [
    ["task-child", "child"], ["task-child", "child"]
  ]);
  assert.equal(completions.some((item) => item.sourceEventRef.eventId.includes(":900")), false);
  assert.equal(protocol.coordination.some((item) => item.kind === "result-delivery"), false);
  assert.equal(completions[0].sourceEventRef.session.sessionId, "child");
  assert.equal(codexTurnEventId({ type: "task_complete", record: childRecords.at(-2), recordIndex: childRecords.length - 2 }), "event:turn:task_complete:948");
});

test("v3 coordination source-event references validate local dangling IDs and cross-session shape", () => {
  const observation = coordinationObservation({
    id: "coord:test", sessionId: "root", kind: "child-turn-completed", state: "completed", timestamp: 1,
    fromSessionRef: { provider: "codex", sessionId: "root" },
    sourceEventRef: { session: { provider: "codex", sessionId: "root" }, eventId: "event:missing" },
    provenance: { fidelity: "recorded", sourceType: "fixture", sourceId: "x" }
  });
  const protocol = {
    sessionId: "root", version: 3, session: { ref: { provider: "codex", sessionId: "root" }, state: "completed", origin: null, timeCreated: 1, timeUpdated: 2, cwd: null, harness: null, terminalOutcome: null, forkSeedBoundary: null, inheritedEventCount: null, provenance: { fidelity: "recorded", sourceType: "fixture" } }, events: [], relationships: [], tasks: [], agentRuns: [], contextArtifacts: [],
    branches: [], revision: null, goals: [], actors: [], coordination: [observation], contextVersions: [], contextTransformations: [], usageRecords: [],
    coverage: { work: { state: "unknown" }, execution: { state: "unknown" }, coordination: { state: "observed" }, context: { state: "unknown" }, usage: { state: "unknown" } }
  };
  const validation = validateSessionProtocolV3(protocol);
  assert.equal(validation.errors.some((error) => error.code === "COORDINATION_SOURCE_EVENT_DANGLING"), true);
  const finalized = finalizeSessionProtocolV3({ ...protocol, coordination: [] }, { freeze: false });
  assert.equal(finalized.version, 3);

  const malformed = {
    ...protocol,
    coordination: [{
      ...observation,
      id: "coord:malformed",
      fromSessionRef: { provider: "codex", sessionId: "child" },
      sourceEventRef: { session: null, eventId: "event:missing" }
    }]
  };
  assert.doesNotThrow(() => validateSessionProtocolV3(malformed));
  const malformedValidation = validateSessionProtocolV3(malformed);
  assert.equal(malformedValidation.errors.some((error) => error.code === "COORDINATION_SOURCE_EVENT_REF_INVALID"), true);
  const ownerMismatch = validateSessionProtocolV3({
    ...protocol,
    coordination: [{
      ...observation,
      id: "coord:owner-mismatch-raw",
      fromSessionRef: { provider: "codex", sessionId: "child" },
      sourceEventRef: { session: { provider: "codex", sessionId: "other-child" }, eventId: "event:complete" }
    }]
  });
  assert.equal(ownerMismatch.errors.some((error) => error.code === "COORDINATION_SOURCE_EVENT_OWNER_MISMATCH"), true);
  assert.throws(() => coordinationObservation({
    ...observation,
    id: "coord:owner-mismatch",
    fromSessionRef: { provider: "codex", sessionId: "child" },
    sourceEventRef: { session: { provider: "codex", sessionId: "other-child" }, eventId: "event:complete" }
  }), /source event must belong/);
  assert.throws(() => coordinationObservation({
    ...observation,
    id: "coord:missing-source",
    fromSessionRef: { provider: "codex", sessionId: "child" },
    sourceEventRef: null
  }), /requires its owning source event/);
});

test("child completion source refs are owned and finalization preserves separate delivery facts", () => {
  const childRef = { provider: "codex", sessionId: "child" };
  const completion = coordinationObservation({
    id: "coord:child-turn-completed:child:948", sessionId: "root", kind: "child-turn-completed", state: "completed", timestamp: 10,
    fromSessionRef: childRef, sourceEventRef: { session: childRef, eventId: "event:turn:task_complete:948" },
    provenance: { fidelity: "recorded", sourceType: "fixture.child", sourceId: "948" }
  });
  const delivery = coordinationObservation({
    id: "coord:result-delivery:answer", sessionId: "root", kind: "result-delivery", state: "delivered", timestamp: 11,
    fromSessionRef: childRef, toSessionRef: { provider: "codex", sessionId: "root" },
    provenance: { fidelity: "recorded", sourceType: "fixture.delivery", sourceId: "answer" }
  });
  const protocol = {
    sessionId: "root", version: 3, session: { ref: { provider: "codex", sessionId: "root" }, state: "completed", origin: null, timeCreated: 1, timeUpdated: 2, cwd: null, harness: null, terminalOutcome: null, forkSeedBoundary: null, inheritedEventCount: null, provenance: { fidelity: "recorded", sourceType: "fixture" } }, events: [], relationships: [], tasks: [], agentRuns: [], contextArtifacts: [],
    branches: [], revision: null, goals: [], actors: [], coordination: [completion, delivery], contextVersions: [], contextTransformations: [], usageRecords: [],
    coverage: { work: { state: "unknown" }, execution: { state: "unknown" }, coordination: { state: "observed" }, context: { state: "unknown" }, usage: { state: "unknown" } }
  };
  const finalized = finalizeSessionProtocolV3(protocol, { freeze: false });
  assert.equal(finalized.validation.errors.length, 0);
  assert.deepEqual(finalized.coordination.map((item) => item.kind), ["child-turn-completed", "result-delivery"]);
  assert.equal(finalized.coordination[0].sourceEventRef.session.sessionId, "child");
  assert.equal(finalized.coordination[1].sourceEventRef, null);
});

test("FINAL_ANSWER delivery receives an exact bounded recorded event anchor", () => {
  const finalText = "Message Type: FINAL_ANSWER\nanswer from worker";
  const records = [
    { type: "session_meta", payload: { id: "root", agent_path: "/root" } },
    { type: "response_item", payload: {
      type: "agent_message", id: "final-envelope-1", author: "/root/worker", recipient: "/root",
      content: [{ type: "text", text: finalText }]
    } }
  ];
  const input = {
    session: session("root"),
    messages: [],
    records,
    children: [{ session: session("child", "root"), facts: codexProtocolChildFactsFromRecords([{ type: "session_meta", payload: { id: "child" } }]) }]
  };
  const base = buildCodexSessionProtocol(input);
  const protocol = buildCodexSessionProtocolV3(input, base);
  const delivery = protocol.coordination.find((item) => item.kind === "result-delivery");
  assert.ok(delivery);
  assert.equal(delivery.eventId, "event:result:final-envelope-1");
  assert.ok(protocol.events.some((event) => event.id === delivery.eventId && event.provenance.sourceType === "codex.response_item:agent_message:FINAL_ANSWER"));
  assert.equal(protocol.coordination.some((item) => item.kind === "child-turn-completed"), false);
});
