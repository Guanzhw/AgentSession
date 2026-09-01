import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCodexSessionProtocol,
  codexCompactionEvents
} from "../dist/src/providers/codex/protocol.js";
import {
  classifyCodexRecordProvenance,
  recordsToMessages
} from "../dist/src/providers/codex/parser.js";

const session = (id, parentId = null) => ({
  id,
  provider: "codex",
  parentId,
  title: null,
  directory: null,
  timeCreated: 1000,
  timeUpdated: 5000,
  messageCount: 0,
  tokenCount: null,
  metadata: null
});

test("Codex joins paired compacted records into one recorded event and artifact", () => {
  const records = [
    { type: "session_meta", payload: { id: "root" }, timestamp: "2026-08-01T00:00:00.000Z" },
    {
      type: "compacted",
      timestamp: "2026-08-01T00:01:00.000Z",
      payload: { summary: "opaque summary", tokens_before: 900, first_kept_token_id: "tok-9" }
    },
    {
      type: "event_msg",
      timestamp: "2026-08-01T00:01:00.000Z",
      payload: { type: "context_compacted", tokens_after: 120, first_kept_token_id: "tok-9" }
    }
  ];
  const normalized = codexCompactionEvents(records);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].records.length, 2);

  const protocol = buildCodexSessionProtocol({
    session: session("root"),
    messages: [],
    records,
    children: []
  });
  const events = protocol.events.filter((event) => event.kind === "context.compaction");
  assert.equal(events.length, 1);
  assert.equal(events[0].compaction.tokensBefore, 900);
  assert.equal(events[0].compaction.tokensAfter, 120);
  assert.equal(events[0].provenance.fidelity, "recorded");
  assert.match(events[0].provenance.sourceType, /codex\.compacted/);
  assert.match(events[0].provenance.sourceType, /codex\.event_msg/);
  assert.equal(events[0].providerData.sourceRecordCount, 2);
  assert.equal(protocol.contextArtifacts.length, 1);
  assert.equal(protocol.contextArtifacts[0].provenance.fidelity, "recorded");
  assert.equal(protocol.contextArtifacts[0].metadata.sourceRecordCount, 2);
});

test("Codex keeps nearby compactions separate when their recorded ids differ", () => {
  const records = [
    { type: "compacted", timestamp: "2026-08-01T00:01:00.000Z", payload: { id: "compact-first" } },
    { type: "event_msg", timestamp: "2026-08-01T00:01:00.000Z", payload: { type: "context_compacted", id: "compact-second" } }
  ];
  assert.equal(codexCompactionEvents(records).length, 2);
});

test("Codex removes only strictly copied legacy parent records, preserving child-owned duplicate text", () => {
  const copiedUser = {
    timestamp: "2026-08-01T00:00:01.000Z",
    type: "event_msg",
    payload: { type: "user_message", message: "repeatable request" }
  };
  const copiedAssistant = {
    timestamp: "2026-08-01T00:00:02.000Z",
    type: "response_item",
    payload: { id: "parent-assistant", type: "message", role: "assistant", content: [{ type: "output_text", text: "parent answer" }], metadata: { timestamp: "2026-08-01T00:00:02.000Z" } }
  };
  const copiedReasoning = {
    timestamp: "2026-08-01T00:00:02.500Z",
    type: "response_item",
    payload: { id: "parent-reasoning", type: "reasoning", summary: [{ type: "summary_text", text: "parent reasoning" }] }
  };
  const copiedTool = {
    timestamp: "2026-08-01T00:00:03.000Z",
    type: "response_item",
    payload: { type: "function_call", call_id: "parent-tool", name: "read_file", arguments: "{}" }
  };
  const parentRecords = [
    { timestamp: "2026-08-01T00:00:00.000Z", type: "session_meta", payload: { id: "parent" } },
    copiedUser,
    copiedAssistant,
    copiedReasoning,
    copiedTool
  ];
  const childCopiedUser = { ...copiedUser, timestamp: "2026-08-02T10:00:01.000Z" };
  const childCopiedAssistant = {
    ...copiedAssistant,
    timestamp: "2026-08-02T10:00:02.000Z",
    payload: { ...copiedAssistant.payload, metadata: { timestamp: "2026-08-02T10:00:02.000Z" } }
  };
  const childCopiedReasoning = { ...copiedReasoning, timestamp: "2026-08-02T10:00:02.500Z" };
  const childCopiedTool = { ...copiedTool, timestamp: "2026-08-02T10:00:03.000Z" };
  const childRecords = [
    { timestamp: "2026-08-02T10:00:00.500Z", type: "session_meta", payload: { id: "child", parent_thread_id: "parent" } },
    { timestamp: "2026-08-02T10:00:00.501Z", type: "session_meta", payload: { id: "parent" } },
    childCopiedUser,
    childCopiedAssistant,
    childCopiedReasoning,
    childCopiedTool,
    { timestamp: "2026-08-02T10:00:04.000Z", type: "event_msg", payload: { type: "user_message", message: "repeatable request" } },
    { timestamp: "2026-08-02T10:00:05.000Z", type: "event_msg", payload: { type: "agent_reasoning", text: "child reasoning" } }
  ];
  const provenance = classifyCodexRecordProvenance(childRecords, parentRecords);
  assert.equal(provenance.get(childCopiedUser), "inherited-parent-context");
  assert.equal(provenance.get(childCopiedAssistant), "inherited-parent-context");
  assert.equal(provenance.get(childCopiedReasoning), "inherited-parent-context");
  assert.equal(provenance.get(childCopiedTool), "inherited-parent-context");

  const messages = recordsToMessages(childRecords, "child", parentRecords);
  assert.deepEqual(messages.map((message) => [message.role, message.content, message.thinking]), [
    ["user", "repeatable request", null],
    ["assistant", "", "child reasoning"]
  ]);
});

test("Codex does not treat a later matching parent subsequence as a copied prefix", () => {
  const matchingUser = { type: "event_msg", payload: { type: "user_message", message: "repeatable request" } };
  const matchingAssistant = { type: "event_msg", payload: { type: "agent_message", message: "repeatable answer" } };
  const parentRecords = [
    { type: "session_meta", payload: { id: "parent" } },
    { type: "event_msg", payload: { type: "task_started" } },
    matchingUser,
    matchingAssistant
  ];
  const childRecords = [
    { type: "session_meta", payload: { id: "child", parent_thread_id: "parent" } },
    { type: "session_meta", payload: { id: "parent" } },
    { ...matchingUser },
    { ...matchingAssistant }
  ];
  const provenance = classifyCodexRecordProvenance(childRecords, parentRecords);
  assert.equal(provenance.get(childRecords[2]), "session");
  assert.equal(provenance.get(childRecords[3]), "session");
});
