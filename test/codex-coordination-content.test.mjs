import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initConfig } from "../dist/src/config.js";
import { codexCoordinationContentFromRecords } from "../dist/src/providers/codex/coordination-content.js";
import { classifyCodexRecordProvenance, extractMeta, recordsToMessages } from "../dist/src/providers/codex/parser.js";
import { buildCodexSessionProtocol, buildCodexSessionProtocolV3, codexProtocolChildFactsFromRecords } from "../dist/src/providers/codex/protocol.js";
import { finalizeSessionProtocol } from "../dist/src/providers/shared/session-protocol.js";
import { finalizeSessionProtocolV3 } from "../dist/src/providers/shared/session-protocol-v3.js";

const row = (type, payload) => ({ type, payload, timestamp: "2026-09-20T01:00:00.000Z" });
const rootHeader = row("session_meta", { id: "root", agent_path: "/root" });
const childHeader = row("session_meta", { id: "child", parent_thread_id: "root", agent_path: "/root/child" });
const taskEnvelope = row("response_item", {
  type: "agent_message", id: "task-envelope", author: "/root", recipient: "/root/child",
  content: [{ type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/child\nSender: /root\nPayload:\nAssigned work" }]
});

function owned(records, parentRecords = []) {
  const provenance = classifyCodexRecordProvenance(records, parentRecords);
  return records.filter((record) => provenance.get(record) === "session");
}

function protocolFor(records, childRecords) {
  const messages = recordsToMessages(records, "root");
  const session = extractMeta(records, "root", messages);
  const input = { session, records, messages, children: childRecords ? [{
    session: extractMeta(childRecords, "child"),
    facts: codexProtocolChildFactsFromRecords(owned(childRecords, records))
  }] : [] };
  const v2 = finalizeSessionProtocol(buildCodexSessionProtocol(input), { provider: "codex", session, revision: "content-fixture" });
  return finalizeSessionProtocolV3(buildCodexSessionProtocolV3(input, v2));
}

test("Codex collaboration content reads each exact assignment and follow-up message, preserving the complete text", () => {
  const longMessage = "Keep the original Markdown.\n\n" + "正文🙂\n".repeat(2200);
  const calls = [
    ["spawn_agent", "spawn", "Initial **assignment**", "function_call", "collaboration"],
    ["followup_task", "followup-1", "First follow-up", "function_call", "collaboration"],
    ["followup_task", "followup-2", longMessage, "custom_tool_call", "collaboration"],
    ["send_message", "message", "Peer message", "function_call", "collaboration"],
    ["send_input", "input", "Legacy input", "function_call", "multi_agent_v1"]
  ];
  const records = [rootHeader, ...calls.map(([name, call_id, message, type, namespace]) => row("response_item", {
    type, namespace, name, call_id, arguments: JSON.stringify({ target: "/root/child", task_name: "child", message })
  })), row("response_item", {
    type: "custom_tool_call", namespace: "collaboration", name: "send_message", input: { target: "/root/child", message: "Call without a provider id" }
  }), row("response_item", {
    type: "function_call", namespace: "collaboration", name: "followup_task", call_id: "without-message", arguments: "{}"
  }), row("response_item", {
    type: "function_call_output", call_id: "without-message", output: "Do not substitute the tool output"
  })];
  const protocol = protocolFor(records, [childHeader, taskEnvelope]);
  for (const [, callId, message] of calls) {
    const observation = protocol.coordination.find((item) => item.correlationId === callId);
    assert.deepEqual(codexCoordinationContentFromRecords(records, observation), { text: message, format: "markdown" });
  }
  const anonymous = protocol.coordination.find((item) => item.correlationId === "collab-6");
  assert.equal(codexCoordinationContentFromRecords(records, anonymous)?.text, "Call without a provider id");
  assert.equal(codexCoordinationContentFromRecords(records, protocol.coordination.find((item) => item.correlationId === "without-message")), null);
});

test("Codex communication content resolves recorded ids and protocol-order fallback indices", () => {
  const records = [rootHeader,
    row("inter_agent_communication", { id: "first", author: "/root", recipient: "/root/child", message: "First communication" }),
    row("inter_agent_communication", { author: "/root/child", recipient: "/root", message: "Second communication" }),
    row("inter_agent_communication", { id: "content-shape", author: "/root", recipient: "/root/child", content: "Current v153 fixture content" })
  ];
  const protocol = protocolFor(records);
  assert.deepEqual(protocol.coordination.map((item) => codexCoordinationContentFromRecords(records, item)?.text), [
    "First communication", "Second communication", "Current v153 fixture content"
  ]);
});

test("Codex collaboration messages stored as encrypted tokens remain unavailable without hiding prose about them", () => {
  // Sanitized shapes of the real root's spawn and follow-up messages: their
  // original strings equal the child's explicitly tagged encrypted_content.
  const tokens = [2937, 473].map((length) => {
    const bytes = Buffer.alloc(length, 0x5a);
    bytes[0] = 0x80;
    bytes.fill(0, 1, 9);
    return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  });
  assert.deepEqual(tokens.map((token) => token.length), [3916, 632]);
  const readable = [
    `This log contains an encrypted value: ${tokens[1]}\nKeep this explanation readable.`,
    "A".repeat(632),
    "gAAAA is the prefix being discussed."
  ];
  const messages = [...tokens, ...readable];
  const records = [rootHeader, ...messages.map((message, index) => row("response_item", {
    type: "function_call", namespace: "collaboration",
    name: index === 0 ? "spawn_agent" : "followup_task", call_id: `opaque-${index}`,
    arguments: JSON.stringify({ target: "/root/child", task_name: "child", message })
  }))];
  const protocol = protocolFor(records, [childHeader, taskEnvelope]);
  const content = messages.map((_, index) => codexCoordinationContentFromRecords(records,
    protocol.coordination.find((item) => item.correlationId === `opaque-${index}`)));
  assert.deepEqual(content.slice(0, 2), [null, null]);
  assert.deepEqual(content.slice(2).map((value) => value.text), readable);
});

test("Codex final-answer content uses each exact parent envelope and leaves encrypted bodies unavailable", () => {
  const envelope = (id, text, encrypted = false) => row("response_item", {
    type: "agent_message", ...(id ? { id } : {}), author: "/root/child", recipient: "/root",
    content: [{ type: "input_text", text }, ...(encrypted ? [{ type: "encrypted_content", encrypted_content: "opaque-body" }] : [])]
  });
  const firstBody = "First result.\n\n```text\nPayload:\nThis line belongs to the reply.\n```\n";
  const records = [rootHeader,
    envelope("result-1", `Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/child\nPayload:\n${firstBody}`),
    envelope(null, "Message Type: FINAL_ANSWER\nSecond result"),
    envelope(null, "Message Type: FINAL_ANSWER\nThird result"),
    envelope("encrypted", "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/child\nPayload:\n", true)
  ];
  const protocol = protocolFor(records, [childHeader, taskEnvelope]);
  const deliveries = protocol.coordination.filter((item) => item.kind === "result-delivery");
  assert.equal(deliveries[0].fromSessionRef.sessionId, "child");
  assert.deepEqual(deliveries.map((item) => codexCoordinationContentFromRecords(records, item)?.text ?? null), [
    firstBody, "Second result", "Third result", null
  ]);
  assert.equal(codexCoordinationContentFromRecords([rootHeader], deliveries[0]), null);
});

test("Codex child completion reads that lifecycle's last_agent_message with original or ownership-filtered source ids", () => {
  const records = [rootHeader, row("event_msg", { type: "task_complete", turn_id: "inherited", last_agent_message: "Parent reply" })];
  const childRecords = [childHeader, ...records, taskEnvelope,
    { ...row("event_msg", { type: "task_complete", turn_id: "child-first", last_agent_message: "First child reply" }), ordinal: 948 },
    row("event_msg", { type: "task_complete", turn_id: "child-second", last_agent_message: "Second child reply" }),
    row("event_msg", { type: "task_complete", turn_id: "child-missing" }),
    row("event_msg", { type: "agent_message", message: "A newer reply must not replace any completion" })
  ];
  const protocol = protocolFor(records, childRecords);
  const completions = protocol.coordination.filter((item) => item.kind === "child-turn-completed");
  assert.deepEqual(completions.map((item) => item.sourceEventRef.eventId), [
    "event:turn:task_complete:948", "event:turn:task_complete:2", "event:turn:task_complete:3"
  ]);
  assert.deepEqual(completions.map((item) => codexCoordinationContentFromRecords(owned(childRecords, records), item)?.text ?? null), [
    "First child reply", "Second child reply", null
  ]);
});

test("Codex child completion does not read a different turn that replaced the same source ordinal", () => {
  const records = [rootHeader];
  const completion = (turn_id, last_agent_message) => ({
    ...row("event_msg", { type: "task_complete", turn_id, last_agent_message }), ordinal: 948
  });
  const childRecords = [childHeader, taskEnvelope, completion("child-first", "Original child reply")];
  const replacementRecords = [childHeader, taskEnvelope, completion("child-replacement", "Replacement child reply")];
  const original = protocolFor(records, childRecords).coordination.find((item) => item.kind === "child-turn-completed");
  const replacement = protocolFor(records, replacementRecords).coordination.find((item) => item.kind === "child-turn-completed");
  assert.equal(original.sourceEventRef.eventId, replacement.sourceEventRef.eventId);
  assert.notEqual(original.turnId, replacement.turnId);
  assert.equal(codexCoordinationContentFromRecords(owned(childRecords, records), original)?.text, "Original child reply");
  assert.equal(codexCoordinationContentFromRecords(owned(replacementRecords, records), original), null);
  assert.equal(codexCoordinationContentFromRecords(owned(replacementRecords, records), replacement)?.text, "Replacement child reply");
  const withoutTurn = [childHeader, taskEnvelope, completion(null, "Original turn-less reply")];
  const originalWithoutTurn = protocolFor(records, withoutTurn).coordination.find((item) => item.kind === "child-turn-completed");
  assert.equal(originalWithoutTurn.turnId, null);
  assert.equal(codexCoordinationContentFromRecords(owned(withoutTurn, records), originalWithoutTurn)?.text, "Original turn-less reply");
  assert.equal(codexCoordinationContentFromRecords(owned(replacementRecords, records), originalWithoutTurn), null);
});

test("Codex adapter reads result delivery from the parent and each completion from its child source", async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-codex-coordination-content-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const sessions = path.join(temp, "sessions");
  mkdirSync(sessions);
  const records = [rootHeader,
    row("event_msg", { type: "user_message", message: "The original parent request" }),
    row("response_item", {
    type: "agent_message", id: "delivered", author: "/root/child", recipient: "/root",
    content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/child\nPayload:\nParent received this exact result" }]
  })];
  const childRecords = [childHeader, taskEnvelope,
    row("event_msg", { type: "task_complete", turn_id: "first", last_agent_message: "Child first result" }),
    row("event_msg", { type: "task_complete", turn_id: "second", last_agent_message: "Child second result" })
  ];
  const legacyRecords = [row("session_meta", { id: "legacy", parent_thread_id: "root", agent_path: "/root/legacy" }),
    ...records,
    row("turn_context", { model: "legacy-model" }),
    row("event_msg", { type: "task_complete", turn_id: "legacy-first", last_agent_message: "Legacy child result" })
  ];
  for (const [id, rows] of [["root", records], ["child", childRecords], ["legacy", legacyRecords]]) {
    writeFileSync(path.join(sessions, `${id}.jsonl`), rows.map((record) => JSON.stringify(record)).join("\n") + "\n");
  }
  initConfig(["--codex-dir", temp]);
  const { default: codex } = await import("../dist/src/providers/codex/adapter.js?reader-coordination-content");
  const protocol = codex.getSessionProtocolSnapshots("root").v3;
  const delivery = protocol.coordination.find((item) => item.kind === "result-delivery");
  const completions = protocol.coordination.filter((item) => item.kind === "child-turn-completed" && item.fromSessionRef.sessionId === "child");
  assert.equal(codex.getReaderCoordinationContent("root", delivery)?.text, "Parent received this exact result");
  assert.deepEqual(completions.map((item) => codex.getReaderCoordinationContent("root", item)?.text), ["Child first result", "Child second result"]);
  const legacyCompletion = protocol.coordination.find((item) => item.kind === "child-turn-completed" && item.fromSessionRef.sessionId === "legacy");
  assert.equal(codex.getReaderCoordinationContent("root", legacyCompletion)?.text, "Legacy child result");
});
