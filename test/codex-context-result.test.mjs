import assert from "node:assert/strict";
import test from "node:test";

import {
  codexCompactionEventId,
  codexCompactionEvents,
  buildCodexSessionProtocol
} from "../dist/src/providers/codex/protocol.js";
import { normalizeCodexContextChangeResult } from "../dist/src/providers/codex/context-result.js";
import { classifyCodexRecordProvenance } from "../dist/src/providers/codex/parser.js";

function compactionRecords({ summary = "", replacement = [], guardian = [] } = {}) {
  return [
    {
      type: "compacted",
      timestamp: "2026-09-14T10:00:00.000Z",
      payload: { message: summary, replacement_history: replacement, guardian_history: guardian }
    },
    {
      type: "event_msg",
      timestamp: "2026-09-14T10:00:00.000Z",
      payload: { type: "context_compacted" }
    }
  ];
}

test("Codex context result uses one canonical source-order checkpoint for paired records", () => {
  const records = Array.from({ length: 416 }, () => ({ type: "turn_context" }));
  records.push(...compactionRecords({ replacement: [{ type: "message", role: "user", content: [{ type: "text", text: "keep me" }] }] }));
  const logical = codexCompactionEvents(records);
  assert.equal(logical.length, 1);
  assert.equal(logical[0].records.length, 2);
  assert.equal(codexCompactionEventId(logical[0]), "event:compaction:416");

  const result = normalizeCodexContextChangeResult(records, "event:compaction:416");
  assert.ok(result);
  assert.equal(result.checkpointId, "event:compaction:416");
  assert.equal(result.source.sourceId, null, "no provider payload id is invented");
  assert.equal(result.source.sourceOrdinal, 416);
  assert.equal(result.source.sourceOrdinalProvenance, "source-order/derived");
  assert.equal(result.source.sourceType, "codex.compacted+codex.event_msg");
  assert.deepEqual(result.groups.map((group) => group.label), ["replacement", "guardian"]);
  assert.equal(result.groups[0].entries[0].content, "keep me");
  assert.equal(result.groups[0].entries[0].kind, "message");
  assert.equal(result.groups[0].entries[0].role, "user");
  assert.deepEqual(result.groups[0].entries[0].attachments, []);
  assert.deepEqual(result.groups[1].entries, [], "an explicitly recorded empty group remains visible");
});

test("Codex context result retains structured tool data beside omitted encrypted content", () => {
  const entry = {
    type: "function_call_output",
    role: "tool",
    output: {
      stdout: "visible stdout",
      result: { filePath: "D:/work/file.ts", custom: 7, name: "result-name", id: "result-id" },
      encrypted_content: "ciphertext"
    },
    arguments: { command: "git status", options: { verbose: true } }
  };
  const result = normalizeCodexContextChangeResult(
    compactionRecords({ replacement: [entry] }),
    "event:compaction:0"
  );
  assert.ok(result);
  const normalized = result.groups[0].entries[0];
  assert.equal(normalized.kind, "tool");
  assert.equal(normalized.role, "tool");
  assert.equal(normalized.content.includes("visible stdout"), true);
  assert.equal(normalized.content.includes("D:/work/file.ts"), true);
  assert.equal(normalized.content.includes("result-name"), true);
  assert.equal(normalized.content.includes("result-id"), true);
  assert.equal(normalized.content.includes("git status"), true);
  assert.equal(normalized.content.includes("ciphertext"), false);
  assert.deepEqual(normalized.omittedEncryptedFieldPaths, ["replacement_history[0].output.encrypted_content"]);
  assert.deepEqual(normalized.attachments, []);
});

test("Codex context result records input images as metadata-only attachments", () => {
  const result = normalizeCodexContextChangeResult(
    compactionRecords({
      guardian: [{
        type: "custom_tool_call_output",
        output: [
          { type: "input_text", text: "before image" },
          { type: "input_image", image_url: "data:image/png;base64,secret", detail: "high" },
          { type: "output_text", text: "after image" }
        ]
      }]
    }),
    "event:compaction:0"
  );
  assert.ok(result);
  const entry = result.groups[1].entries[0];
  assert.equal(entry.content, "before image\nafter image");
  assert.equal(entry.fields.some((field) => field.value.includes("data:image")), false);
  assert.deepEqual(entry.attachments, [{
    kind: "image",
    sourcePath: "guardian_history[0].output[1]",
    contentAccess: "metadata-only"
  }]);
});

test("Codex context result excludes typed summary metadata but retains summary text", () => {
  const result = normalizeCodexContextChangeResult(
    compactionRecords({ replacement: [{ type: "reasoning", summary: [{ type: "summary_text", text: "recorded reasoning" }] }] }),
    "event:compaction:0"
  );
  assert.ok(result);
  const content = result.groups[0].entries[0].content;
  assert.equal(content, "recorded reasoning");
  assert.equal(content.includes("summary_text"), false);
});

test("Codex context result excludes typed tool-output block labels", () => {
  const result = normalizeCodexContextChangeResult(
    compactionRecords({
      guardian: [{
        type: "custom_tool_call_output",
        output: [
          { type: "input_text", text: "first output" },
          { type: "output_text", text: "second output" }
        ]
      }]
    }),
    "event:compaction:0"
  );
  assert.ok(result);
  assert.equal(result.groups[1].entries[0].content, "first output\nsecond output");
  assert.equal(result.groups[1].entries[0].content.includes("input_text"), false);
  assert.equal(result.groups[1].entries[0].content.includes("output_text"), false);
});

test("Codex context result retains ordered 141-shape history and reports omitted encrypted fields", () => {
  const replacement = Array.from({ length: 9 }, (_, index) => ({
    type: "message",
    role: index % 2 ? "assistant" : "user",
    content: [{ type: "text", text: `replacement-${index}` }]
  }));
  const guardian = Array.from({ length: 132 }, (_, index) => ({
    type: "reasoning",
    text: `guardian-${index}`,
    ...(index < 39 ? { encrypted_content: `cipher-${index}`, nested: { encrypted_content: "cipher" } } : {})
  }));
  const records = compactionRecords({ replacement, guardian });
  const result = normalizeCodexContextChangeResult(records, "event:compaction:0");
  assert.ok(result);
  assert.deepEqual(result.groups.map((group) => [group.label, group.entries.length]), [
    ["replacement", 9],
    ["guardian", 132]
  ]);
  assert.equal(result.groups[1].entries[0].content, "guardian-0");
  assert.equal(result.groups[1].entries[39].content, "guardian-39");
  assert.equal(result.omitted.encryptedFieldCount, 78);
  assert.equal(result.groups[1].entries[0].omittedEncryptedFieldCount, 2);
  assert.equal(result.groups[1].entries[0].omittedEncryptedFieldPaths[0], "guardian_history[0].encrypted_content");
  assert.equal(JSON.stringify(result).includes("cipher-0"), false);
  assert.equal(JSON.stringify(result).includes("guardian_history"), true, "omitted paths retain source identity");
});

test("Codex context result preserves full summary and distinguishes recorded-empty from absent", () => {
  const summary = `  ${"full recorded summary ".repeat(40)}  `;
  const readable = normalizeCodexContextChangeResult(
    compactionRecords({ summary }),
    "event:compaction:0"
  );
  assert.ok(readable);
  assert.equal(readable.summary.availability, "readable");
  assert.equal(readable.summary.value, summary);

  const empty = normalizeCodexContextChangeResult(compactionRecords({ summary: "" }), "event:compaction:0");
  assert.ok(empty);
  assert.deepEqual(empty.summary, { value: "", availability: "recorded-empty" });

  const absentRecords = [
    { type: "compacted", timestamp: "2026-09-14T10:00:00.000Z", payload: { replacement_history: [] } }
  ];
  const absent = normalizeCodexContextChangeResult(absentRecords, "event:compaction:0");
  assert.ok(absent);
  assert.deepEqual(absent.summary, { value: null, availability: "not-recorded" });
  const nullSummary = normalizeCodexContextChangeResult(
    compactionRecords({ summary: null }),
    "event:compaction:0"
  );
  assert.ok(nullSummary);
  assert.deepEqual(nullSummary.summary, { value: null, availability: "not-recorded" });
  assert.equal(normalizeCodexContextChangeResult(absentRecords, "event:compaction:missing"), null);
});

test("context result follows Codex owned-record filtering and excludes copied parent context", () => {
  const parentRecords = [
    { type: "session_meta", payload: { id: "parent" } },
    { type: "event_msg", payload: { type: "user_message", message: "parent" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "answer" }] } },
    { type: "compacted", payload: { message: "parent compact" } }
  ];
  const childRecords = [
    { type: "session_meta", payload: { id: "child", parent_thread_id: "parent" } },
    { type: "session_meta", payload: { id: "parent" } },
    parentRecords[1],
    parentRecords[2],
    parentRecords[3],
    { type: "compacted", payload: { message: "child compact", replacement_history: [{ type: "message", text: "child retained" }] } }
  ];
  const provenance = classifyCodexRecordProvenance(childRecords, parentRecords);
  const owned = childRecords.filter((record) => provenance.get(record) === "session");
  assert.equal(owned.includes(childRecords[4]), false);
  const result = normalizeCodexContextChangeResult(owned, "event:compaction:1");
  assert.ok(result);
  assert.equal(result.summary.value, "child compact");
  assert.equal(result.groups[0].entries[0].content, "child retained");
});

test("context result is separate from metadata-only ordinary Codex protocol projections", () => {
  const records = compactionRecords({ replacement: [{ type: "message", content: [{ type: "text", text: "retained" }] }] });
  const protocol = buildCodexSessionProtocol({
    session: {
      id: "root", provider: "codex", parentId: null, title: "root", directory: null,
      timeCreated: 1, timeUpdated: 2, messageCount: 0, tokenCount: null, metadata: null
    },
    messages: [],
    records,
    children: []
  });
  assert.equal(protocol.contextArtifacts[0].contentAccess, "metadata-only");
  assert.equal(protocol.contextArtifacts[0].summary, null);
  assert.equal(protocol.contextArtifacts[0].metadata.sourceRecordCount, 2);
});
