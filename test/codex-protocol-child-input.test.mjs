import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initConfig } from "../dist/src/config.js";
import { classifyCodexRecordProvenance, extractMeta, parseSession, recordsToMessages } from "../dist/src/providers/codex/parser.js";
import { buildCodexSessionProtocol, buildCodexSessionProtocolV3, codexProtocolChildFactsFromRecords } from "../dist/src/providers/codex/protocol.js";
import { readCodexMemoryMetadata } from "../dist/src/providers/codex/memory.js";
import { finalizeSessionProtocol } from "../dist/src/providers/shared/session-protocol.js";
import { finalizeSessionProtocolV3 } from "../dist/src/providers/shared/session-protocol-v3.js";

const row = (type, payload, second) => ({
  type, payload, timestamp: new Date(Date.UTC(2026, 8, 19) + second * 1000).toISOString()
});
const usage = (total, second) => row("event_msg", {
  type: "token_count", info: { last_token_usage: { input_tokens: total - 1, output_tokens: 1, total_tokens: total } }
}, second);

test("Codex indexed child metadata preserves full v2/v3 output without recomputing owned child payloads", async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-codex-child-input-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const sessions = path.join(temp, "sessions");
  mkdirSync(sessions);
  const writeRollout = (id, records) => {
    const file = path.join(sessions, `${id}.jsonl`);
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    return parseSession(file);
  };
  const parentRows = [
    row("session_meta", { id: "root", agent_path: "/root", thread_source: "user" }, 0),
    row("turn_context", { model: "parent-model" }, 1),
    row("event_msg", { type: "user_message", message: "parent-only request" }, 2),
    row("event_msg", { type: "agent_message", message: "parent-only result" }, 3),
    usage(100, 4),
    usage(200, 5),
    row("event_msg", { type: "task_complete", turn_id: "parent-turn" }, 6),
    ...["task", "legacy"].flatMap((id, index) => [
      row("response_item", {
        type: "function_call", name: "spawn_agent", namespace: "collaboration", call_id: `spawn-${id}`,
        arguments: JSON.stringify({ task_name: id })
      }, 7 + index * 2),
      row("response_item", {
        type: "function_call_output", call_id: `spawn-${id}`, output: JSON.stringify({ task_name: `/root/${id}` })
      }, 8 + index * 2)
    ])
  ];
  const rootRecords = writeRollout("root", parentRows);
  const childRecordsById = new Map();
  for (const [index, id] of ["task", "legacy", "fork"].entries()) {
    const second = 20 + index * 10;
    const header = id === "fork"
      ? { id, forked_from_id: "root" }
      : { id, parent_thread_id: "root", agent_path: `/root/${id}`, agent_nickname: id, thread_source: "subagent" };
    childRecordsById.set(id, writeRollout(id, [
      row("session_meta", header, second),
      ...parentRows.map((record) => row(record.type, record.payload, second + 0.5)),
      ...(id === "task" ? [row("response_item", {
        type: "agent_message", id: "task-envelope",
        content: [{ type: "output_text", text: "Message Type: NEW_TASK\nTask name: /root/task" }]
      }, second + 1)] : []),
      row("turn_context", { model: `${id}-model` }, second + 2),
      row("event_msg", { type: "user_message", message: `${id}-owned request` }, second + 3),
      row("event_msg", { type: "agent_message", message: `${id}-owned result` }, second + 4),
      usage(7, second + 5),
      row("response_item", {
        type: "agent_message", id: `${id}-final`, author: `/root/${id}`, recipient: "/root",
        content: [{ type: "output_text", text: `Message Type: FINAL_ANSWER\n${id}-owned result` }]
      }, second + 6),
      row("event_msg", { type: "task_complete", turn_id: `${id}-turn` }, second + 7)
    ]));
  }
  initConfig(["--codex-dir", temp]);
  const { default: codex } = await import("../dist/src/providers/codex/adapter.js?protocol-child-input-test");
  const actual = codex.getSessionProtocolSnapshots("root");
  const children = [...childRecordsById].sort(([left], [right]) => left.localeCompare(right)).map(([id, records]) => {
    const indexed = extractMeta(records, id, recordsToMessages(records, id));
    const resolved = codex.getSession(id);
    const messages = codex.getMessages(id);
    assert.deepEqual(messages, recordsToMessages(records, id, rootRecords));
    assert.equal(messages.some((message) => message.content.includes("parent-only")), false);
    assert.deepEqual(messages.filter((message) => message.role === "user").map((message) => message.content), [
      ...(id === "task" ? ["Message Type: NEW_TASK Task name: /root/task"] : []),
      `${id}-owned request`
    ]);
    assert.equal(resolved.tokenCount, 7);
    assert.equal(messages.reduce((total, message) => total + (message.tokens?.total || 0), 0), 7);
    assert.equal(codex.getSessionMetrics(id).totals.directTotalTokens, 7);
    if (id !== "task") {
      assert.equal(indexed.tokenCount, 307, "the indexed legacy/fork payload still includes copied usage until ownership is resolved");
      assert.ok(indexed.messageCount > resolved.messageCount);
    }
    const provenance = classifyCodexRecordProvenance(records, rootRecords);
    const facts = codexProtocolChildFactsFromRecords(records.filter((record) => provenance.get(record) === "session"));
    assert.equal(facts.model, `${id}-model`, "inherited root model is not a child fact");
    assert.deepEqual(facts.completedTurns.map((turn) => turn.turnId), [`${id}-turn`]);
    assert.equal(facts.hasTaskEnvelope, id === "task");
    return { indexed, resolved, facts };
  });
  const input = {
    session: codex.getSession("root"), messages: codex.getMessages("root"), records: rootRecords,
    memory: readCodexMemoryMetadata(temp, "root"),
    children: children.map(({ resolved, facts }) => ({ session: resolved, facts }))
  };
  const snapshots = (protocolInput) => {
    const v2 = finalizeSessionProtocol(buildCodexSessionProtocol(protocolInput), {
      provider: "codex", session: input.session, capabilities: codex.protocolCapabilities, revision: actual.v2.revision
    });
    return { v2, v3: finalizeSessionProtocolV3(buildCodexSessionProtocolV3(protocolInput, v2)) };
  };
  const resolvedSnapshots = snapshots(input);
  assert.deepEqual(snapshots({
    ...input, children: children.map(({ indexed, facts }) => ({ session: indexed, facts }))
  }), resolvedSnapshots, "complete finalized v2/v3 snapshots consume only stable indexed metadata and owned facts");
  assert.deepEqual(actual, resolvedSnapshots, "the adapter preserves the former parent-resolved protocol input semantics");
  assert.deepEqual(codex.getSessionReaderSnapshot("root").getProtocolSnapshots(), resolvedSnapshots,
    "request-scoped reader capture uses the same child reduction");
  assert.equal(actual.v2.relationships.find((edge) => edge.toSessionId === "fork")?.type, "forked");
  assert.equal(actual.v2.agentRuns.some((run) => run.childSessionId === "fork"), false);
  assert.deepEqual(actual.v3.coordination.filter((event) => event.kind === "child-turn-completed")
    .map((event) => event.turnId).sort(), ["fork-turn", "legacy-turn", "task-turn"]);
  assert.equal(actual.v2.validation.ok, true);
  assert.equal(actual.v3.validation.ok, true);
});

function childCompletions(protocol, sessionId) {
  return protocol.v3.coordination.filter((event) => event.kind === "child-turn-completed"
    && event.fromSessionRef?.sessionId === sessionId);
}

test("Codex indexed child facts survive payload eviction and retain captured versions through append and replacement", async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-codex-indexed-facts-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const sessions = path.join(temp, "sessions");
  mkdirSync(sessions);
  const writeRollout = (name, records) => {
    const file = path.join(sessions, `${name}.jsonl`);
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    return file;
  };
  const parentRows = [
    row("session_meta", { id: "root" }, 0),
    row("turn_context", { model: "parent-model" }, 1),
    row("event_msg", { type: "user_message", message: "parent request" }, 2),
    row("event_msg", { type: "task_complete", turn_id: "parent-turn" }, 3)
  ];
  const rootFile = writeRollout("a-root", parentRows);
  const task = row("response_item", {
    type: "agent_message", id: "child-task",
    content: [{ type: "output_text", text: "Message Type: NEW_TASK\nTask name: /root/child" }]
  }, 5);
  const childHeader = row("session_meta", { id: "child", parent_thread_id: "root", agent_path: "/root/child" }, 4);
  const childFile = writeRollout("b-child", [
    childHeader, ...parentRows, task,
    row("turn_context", { model: "child-model" }, 6),
    row("event_msg", { type: "task_complete", turn_id: "child-turn" }, 7)
  ]);
  const evictionFile = writeRollout("z-eviction", [row("session_meta", { id: "eviction" }, 0)]);
  // The final indexed source evicts root and child from the real 64 MiB budget
  // while whitespace keeps its parsed body small.
  const padding = Buffer.alloc(64 * 1024, 32);
  padding[padding.length - 1] = 10;
  const descriptor = fs.openSync(evictionFile, "a");
  try {
    for (let index = 0; index < 1025; index++) fs.writeSync(descriptor, padding);
  } finally {
    fs.closeSync(descriptor);
  }
  const opens = new Map();
  const open = fs.openSync;
  t.mock.method(fs, "openSync", (...args) => {
    const file = path.resolve(String(args[0]));
    opens.set(file, (opens.get(file) || 0) + 1);
    return open(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  initConfig(["--codex-dir", temp]);
  const { default: codex } = await import("../dist/src/providers/codex/adapter.js?indexed-child-facts-eviction");
  codex.getStatsRevision();
  assert.equal(opens.get(childFile), 1);
  const held = codex.getSessionReaderSnapshot("root");
  assert.equal(opens.get(rootFile), 2, "the oversized final source evicted the indexed root payload");
  const original = held.getProtocolSnapshots();
  assert.deepEqual(childCompletions(original, "child").map((event) => event.turnId), ["child-turn"]);
  assert.equal(original.v2.agentRuns.find((run) => run.childSessionId === "child")?.model, "child-model");
  assert.deepEqual(codex.getSessionProtocolSnapshots("root"), original);
  assert.equal(opens.get(childFile), 1, "Reader and standalone protocols consume indexed facts without reloading the evicted child");

  fs.appendFileSync(childFile, JSON.stringify(row("event_msg", {
    type: "task_complete", turn_id: "appended-turn"
  }, 8)) + "\n");
  const appended = codex.getSessionReaderSnapshot("root").getProtocolSnapshots();
  assert.deepEqual(childCompletions(appended, "child").map((event) => event.turnId), ["child-turn", "appended-turn"]);
  assert.notDeepEqual(appended.v2.revision, original.v2.revision);
  assert.deepEqual(held.getProtocolSnapshots(), original, "a held capture retains the facts of its old child index entry");

  writeRollout("b-child", [
    childHeader, ...parentRows, task,
    row("turn_context", { model: "replacement-model" }, 9),
    row("event_msg", { type: "task_complete", turn_id: "replacement-turn" }, 10)
  ]);
  const replacement = codex.getSessionReaderSnapshot("root").getProtocolSnapshots();
  assert.deepEqual(childCompletions(replacement, "child").map((event) => event.turnId), ["replacement-turn"]);
  assert.equal(replacement.v2.agentRuns.find((run) => run.childSessionId === "child")?.model, "replacement-model");
  assert.deepEqual(held.getProtocolSnapshots(), original);
});

test("Codex legacy and fork child facts still follow the captured parent evidence when its copied prefix grows", async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-codex-parent-dependent-facts-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const sessions = path.join(temp, "sessions");
  mkdirSync(sessions);
  const writeRollout = (id, records) => {
    const file = path.join(sessions, `${id}.jsonl`);
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    return file;
  };
  const parentRows = [
    row("session_meta", { id: "root" }, 0),
    row("turn_context", { model: "parent-model" }, 1),
    row("event_msg", { type: "user_message", message: "parent request" }, 2)
  ];
  const rootFile = writeRollout("root", parentRows);
  const laterParentTurn = row("event_msg", { type: "task_complete", turn_id: "later-parent-turn" }, 3);
  for (const id of ["legacy", "fork"]) {
    writeRollout(id, [
      row("session_meta", id === "fork" ? { id, forked_from_id: "root" }
        : { id, parent_thread_id: "root", agent_path: "/root/legacy" }, 4),
      ...parentRows, laterParentTurn,
      row("turn_context", { model: `${id}-model` }, 5),
      row("event_msg", { type: "task_complete", turn_id: `${id}-turn` }, 6)
    ]);
  }
  initConfig(["--codex-dir", temp]);
  const { default: codex } = await import("../dist/src/providers/codex/adapter.js?parent-dependent-indexed-child-facts");
  const held = codex.getSessionReaderSnapshot("root");
  const original = held.getProtocolSnapshots();
  for (const id of ["legacy", "fork"]) {
    assert.deepEqual(childCompletions(original, id).map((event) => event.turnId), ["later-parent-turn", `${id}-turn`]);
  }
  fs.appendFileSync(rootFile, JSON.stringify(laterParentTurn) + "\n");
  const current = codex.getSessionReaderSnapshot("root").getProtocolSnapshots();
  for (const id of ["legacy", "fork"]) {
    const completion = childCompletions(current, id);
    assert.deepEqual(completion.map((event) => event.turnId), [`${id}-turn`], "the newly proven parent lifecycle is excluded from child facts");
    assert.equal(completion[0].sourceEventRef.eventId, "event:turn:task_complete:2", "source indices follow the current ownership-filtered child records");
  }
  assert.deepEqual(held.getProtocolSnapshots(), original, "unchanged child records are classified against each capture's own parent records");
});
