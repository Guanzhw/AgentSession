import assert from "node:assert/strict";
import test from "node:test";

import { buildCodexSessionProtocol, buildCodexSessionProtocolV3 } from "../dist/src/providers/codex/protocol.js";
import {
  finalizeSessionProtocol,
  validateSessionProtocol
} from "../dist/src/providers/shared/session-protocol.js";
import { finalizeSessionProtocolV3 } from "../dist/src/providers/shared/session-protocol-v3.js";

const at = (second) => `2026-09-02T11:44:${String(second).padStart(2, "0")}.000Z`;
const call = (type, id, name, args = undefined, namespace = undefined, second = 0) => ({
  type: "response_item",
  timestamp: at(second),
  payload: {
    type,
    call_id: id,
    name,
    ...(args === undefined ? {} : { arguments: JSON.stringify(args) }),
    ...(namespace === undefined ? {} : { namespace })
  }
});
const output = (type, id, value, second = 0) => ({
  type: "response_item",
  timestamp: at(second),
  payload: { type, call_id: id, output: value }
});
const running = (handle, seconds = "31.0") => `Script running with cell ID ${handle}\nWall time ${seconds} seconds\nOutput:\n`;
const completed = (seconds = "25.6") => `Script completed\nWall time ${seconds} seconds\nOutput:\n`;
const failed = (seconds = "0.0") => `Script failed\nWall time ${seconds} seconds\nOutput:\nScript error:\nboom`;
// Native exec_command/write_stdin headers observed in Codex Desktop 0.142.0.
const processRunning = (handle) => `Chunk ID: 884062\nWall time: 10.0015 seconds\nProcess running with session ID ${handle}\nOriginal token count: 0\nOutput:\n`;
const processExited = (code) => `Chunk ID: 272c54\nWall time: 0.0000 seconds\nProcess exited with code ${code}\nOriginal token count: 3\nOutput:\nfull output`;

function protocolPairFor(records) {
  const session = {
    id: "root",
    provider: "codex",
    parentId: null,
    title: "Execution fixture",
    directory: "D:\\WorkSpace",
    timeCreated: 1,
    timeUpdated: 2,
    messageCount: 0,
    tokenCount: null,
    metadata: null
  };
  const input = { session, messages: [], records, children: [] };
  const v2 = finalizeSessionProtocol(buildCodexSessionProtocol(input), {
    provider: "codex",
    session,
    revision: "execution-fixture"
  });
  return { v2, v3: finalizeSessionProtocolV3(buildCodexSessionProtocolV3(input, v2)) };
}

function protocolFor(records) {
  return protocolPairFor(records).v2;
}

test("Codex maps exact exec/wait headers into interleaved source-ordered executions and permits terminal handle reuse", () => {
  const records = [
    call("custom_tool_call", "exec-a", "exec", undefined, undefined, 0),
    output("custom_tool_call_output", "exec-a", [
      { type: "input_text", text: running("65") },
      { type: "input_text", text: '{"session_id":97092}' }
    ], 1),
    call("custom_tool_call", "exec-b", "exec", undefined, undefined, 2),
    output("custom_tool_call_output", "exec-b", [{ type: "input_text", text: running("69") }], 3),
    call("function_call", "wait-a-1", "wait", { cell_id: "65", yield_time_ms: 60_000 }, undefined, 4),
    output("function_call_output", "wait-a-1", running("65", "60.0"), 5),
    call("function_call", "collab-wait", "wait", { cell_id: "69" }, "collaboration", 6),
    output("function_call_output", "collab-wait", completed(), 7),
    call("function_call", "wait-b", "wait", { cell_id: "69" }, undefined, 8),
    output("function_call_output", "wait-b", JSON.stringify([
      { type: "input_text", text: completed("26.6") },
      { type: "input_text", text: "full recorded output" }
    ]), 9),
    call("function_call", "wait-a-2", "wait", { cell_id: "65" }, undefined, 10),
    output("function_call_output", "wait-a-2", completed(), 11),
    call("custom_tool_call", "exec-c", "exec", undefined, undefined, 12),
    output("custom_tool_call_output", "exec-c", [{ type: "input_text", text: running("65") }], 13)
  ];
  const { v2: protocol, v3 } = protocolPairFor(records);
  const events = protocol.events.filter((event) => event.execution);

  assert.deepEqual(events.map((event) => [event.execution.id, event.execution.phase, event.execution.handle]), [
    ["exec-a", "started", "65"],
    ["exec-a", "yielded", "65"],
    ["exec-b", "started", "69"],
    ["exec-b", "yielded", "69"],
    ["exec-a", "polled", "65"],
    ["exec-a", "yielded", "65"],
    ["exec-b", "polled", "69"],
    ["exec-b", "completed", "69"],
    ["exec-a", "polled", "65"],
    ["exec-a", "completed", "65"],
    ["exec-c", "started", "65"],
    ["exec-c", "yielded", "65"]
  ]);
  assert.equal(events.some((event) => event.toolCallId === "collab-wait"), false);
  assert.equal(events.at(-1).execution.id, "exec-c", "a terminal event releases a reused numeric handle for a new occurrence");
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.equal(protocol.validation.ok, true);
  assert.equal(v3.validation.ok, true);
  assert.equal(new Set(protocol.events.map((event) => event.id)).size, protocol.events.length);
  assert.deepEqual(
    v3.events.filter((event) => event.execution).map((event) => event.id),
    events.map((event) => event.id),
    "v3 preserves the finalized v2 execution events without reinterpretation"
  );
});

test("Codex chains concurrent waits for one active handle in source order without parent cycles", () => {
  const events = protocolFor([
    call("custom_tool_call", "exec-shared", "exec", undefined, undefined, 0),
    output("custom_tool_call_output", "exec-shared", [{ type: "input_text", text: running("65") }], 1),
    call("function_call", "wait-first", "wait", { cell_id: "65" }, undefined, 2),
    call("function_call", "wait-second", "wait", { cell_id: "65" }, undefined, 3),
    output("function_call_output", "wait-first", running("65"), 4),
    output("function_call_output", "wait-second", completed(), 5)
  ]).events.filter((event) => event.execution);
  const byId = new Map(events.map((event) => [event.id, event]));

  assert.deepEqual(events.map((event) => event.execution.phase), ["started", "yielded", "polled", "polled", "yielded", "completed"]);
  for (const event of events) {
    const seen = new Set([event.id]);
    let parentId = event.parentEventId;
    while (parentId) {
      assert.equal(seen.has(parentId), false, `parent cycle at ${event.id}`);
      seen.add(parentId);
      parentId = byId.get(parentId)?.parentEventId || null;
    }
  }
});

test("Codex preserves missing returns, interruption requests, and recorded failures without inferring cancellation", () => {
  const records = [
    call("custom_tool_call", "exec-open", "exec", undefined, undefined, 0),
    output("custom_tool_call_output", "exec-open", [{ type: "input_text", text: running("24") }], 1),
    call("function_call", "stop-open", "wait", { cell_id: "24", terminate: true }, undefined, 2),
    output("function_call_output", "stop-open", completed(), 3),
    call("custom_tool_call", "exec-fail", "exec", undefined, undefined, 4),
    output("custom_tool_call_output", "exec-fail", [{ type: "input_text", text: running("25") }], 5),
    call("function_call", "wait-fail", "wait", { cell_id: "25" }, undefined, 6),
    output("function_call_output", "wait-fail", failed(), 7),
    call("custom_tool_call", "exec-missing", "exec", undefined, undefined, 8),
    output("custom_tool_call_output", "exec-missing", [{ type: "input_text", text: running("26") }], 9)
  ];
  const events = protocolFor(records).events.filter((event) => event.execution);
  const phases = events.map((event) => event.execution.phase);

  assert.deepEqual(phases, [
    "started", "yielded", "interruption-requested", "completed",
    "started", "yielded", "polled", "failed",
    "started", "yielded"
  ]);
  assert.equal(phases.includes("cancelled"), false, "a terminate request is not a recorded cancellation outcome");
  assert.equal(events.filter((event) => event.execution.id === "exec-missing").at(-1).execution.phase, "yielded");
});

test("Codex ignores forwarded or ambiguous nested output instead of parsing wrapper JavaScript or output order", () => {
  const protocol = protocolFor([
    call("custom_tool_call", "opaque", "exec", undefined, undefined, 0),
    output("custom_tool_call_output", "opaque", [
      { type: "input_text", text: completed() },
      { type: "input_text", text: running("404") },
      { type: "input_text", text: '{"session_id":25883,"output":"still running"}' }
    ], 1),
    call("function_call", "orphan-wait", "wait", { cell_id: "404" }, undefined, 2),
    output("function_call_output", "orphan-wait", completed(), 3),
    call("custom_tool_call", "not-header", "exec", undefined, undefined, 4),
    output("custom_tool_call_output", "not-header", [
      { type: "image", data: "fixture" }, { type: "input_text", text: running("405") }
    ], 5)
  ]);
  assert.deepEqual(protocol.events.filter((event) => event.execution), []);
});

test("Session Protocol rejects malformed tool execution details at the shared boundary", () => {
  const valid = protocolFor([
    call("custom_tool_call", "exec-valid", "exec", undefined, undefined, 0),
    output("custom_tool_call_output", "exec-valid", [{ type: "input_text", text: running("65") }], 1)
  ]);
  const eventIndex = valid.events.findIndex((event) => event.execution);
  const changed = (execution, toolCallId = valid.events[eventIndex].toolCallId) => ({
    ...valid,
    events: valid.events.map((event, index) => index === eventIndex ? { ...event, toolCallId, execution } : event)
  });
  const base = valid.events[eventIndex].execution;

  assert.equal(validateSessionProtocol(changed({ ...base, phase: "invented" })).errors.some((error) => error.code === "TOOL_EXECUTION_PHASE_INVALID"), true);
  assert.equal(validateSessionProtocol(changed({ ...base, handle: "" })).errors.some((error) => error.code === "TOOL_EXECUTION_HANDLE_INVALID"), true);
  assert.equal(validateSessionProtocol(changed(base, null)).errors.some((error) => error.code === "TOOL_EXECUTION_CALL_ID_INVALID"), true);
});

test("Codex direct terminal calls bind process handles and preserve poll, input, stop request and actual exit", () => {
  const { v2, v3 } = protocolPairFor([
    call("function_call", "command", "exec_command", { cmd: "npm run\n  build", yield_time_ms: 10000 }, undefined, 0),
    output("function_call_output", "command", processRunning(97155), 1),
    call("function_call", "poll", "write_stdin", { session_id: 97155, chars: "" }, undefined, 2),
    output("function_call_output", "poll", processRunning(97155), 3),
    call("function_call", "input", "write_stdin", { session_id: 97155, chars: "y\n" }, undefined, 4),
    output("function_call_output", "input", processRunning(97155), 5),
    call("function_call", "stop", "write_stdin", { session_id: 97155, chars: "\u0003" }, undefined, 6),
    output("function_call_output", "stop", processExited(0), 7)
  ]);
  const events = v2.events.filter((item) => item.execution);
  assert.deepEqual(events.map((item) => item.execution.phase), ["started", "yielded", "polled", "yielded", "input", "yielded", "interruption-requested", "completed"]);
  assert.equal(events[0].execution.label, "npm run build");
  assert.equal(events.every((item) => item.execution.kind === "process" && item.execution.handle === "97155" && item.execution.id === "command"), true);
  assert.deepEqual(events.map((item) => item.sequence), events.map((_, index) => index + 1));
  assert.deepEqual(events.map((item) => item.timestamp), events.map((_, index) => Date.parse(at(index))));
  assert.equal(events.at(-1).toolCallId, "stop");
  assert.equal(events.at(-1).execution.phase, "completed", "recorded exit 0 after Ctrl-C is not an inferred cancellation");
  assert.equal(v2.validation.ok, true);
  assert.equal(v3.validation.ok, true);
  assert.deepEqual(v3.events.filter((item) => item.execution).map((item) => item.execution), events.map((item) => item.execution));
});

test("Codex process occurrences stay distinct across interleaving, reuse and equal outer cell handles", () => {
  const events = protocolFor([
    call("function_call", "a", "exec_command", { cmd: "first" }, undefined, 0),
    output("function_call_output", "a", processRunning(65), 1),
    call("function_call", "b", "exec_command", { cmd: "second" }, undefined, 2),
    output("function_call_output", "b", processRunning(66), 3),
    call("custom_tool_call", "outer", "exec", undefined, undefined, 4),
    output("custom_tool_call_output", "outer", running("65"), 5),
    call("function_call", "wait-b", "write_stdin", { session_id: 66 }, undefined, 6),
    call("function_call", "wait-a", "write_stdin", { session_id: 65 }, undefined, 7),
    output("function_call_output", "wait-a", processExited(1), 8),
    output("function_call_output", "wait-b", processExited(0), 9),
    call("function_call", "c", "exec_command", { cmd: "third" }, undefined, 10),
    output("function_call_output", "c", processRunning(65), 11),
    call("function_call", "wait-outer", "wait", { cell_id: "65" }, undefined, 12),
    output("function_call_output", "wait-outer", completed(), 13)
  ]).events.filter((item) => item.execution);
  const steps = (id) => events.filter((item) => item.execution.id === id);
  assert.deepEqual(steps("a").map((item) => item.execution.phase), ["started", "yielded", "polled", "failed"]);
  assert.deepEqual(steps("b").map((item) => item.toolCallId), ["b", "b", "wait-b", "wait-b"]);
  assert.deepEqual(steps("c").map((item) => item.execution.phase), ["started", "yielded"]);
  assert.equal(steps("outer").every((item) => item.execution.kind === "async-tool"), true);
  assert.equal(steps("outer").at(-1).execution.phase, "completed");
  assert.deepEqual(events.map((item) => item.sequence), events.map((_, index) => index + 1));
});

test("Codex does not turn nested, synchronous or unmatched output into background process records", () => {
  const events = protocolFor([
    call("custom_tool_call", "nested", "exec"),
    output("custom_tool_call_output", "nested", [{ type: "text", text: completed() }, { type: "text", text: processRunning(10) }]),
    call("function_call", "synchronous", "exec_command", { cmd: "echo done" }),
    output("function_call_output", "synchronous", processExited(0) + processRunning(11)),
    call("function_call", "wrong-output", "exec_command", { cmd: "build" }),
    output("function_call_output", "another-id", processRunning(12)),
    call("function_call", "not-native", "exec_command", { cmd: "build" }, "some-other-tool"),
    output("function_call_output", "not-native", processRunning(13)),
    call("function_call", "orphan", "write_stdin", { session_id: 12 }),
    output("function_call_output", "orphan", processExited(0))
  ]).events.filter((item) => item.execution);
  assert.deepEqual(events, []);
});
