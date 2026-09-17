import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

function row(type, payload, seconds = 0) {
  return {
    timestamp: new Date(Date.UTC(2026, 8, 17) + seconds * 1000).toISOString(),
    type,
    payload
  };
}

function taskEnvelope(id, parentId, seconds, tokens) {
  return [
    row("session_meta", { id, session_id: id, parent_thread_id: parentId }, seconds),
    row("response_item", {
      id: `${id}-inherited`,
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: `${id} inherited context` }]
    }, seconds + 0.5),
    row("compacted", { summary: "inherited parent compaction" }, seconds + 0.6),
    row("response_item", {
      id: `${id}-task`,
      type: "agent_message",
      content: [{ type: "output_text", text: `Message Type: NEW_TASK\nTask name: ${id}` }]
    }, seconds + 1),
    row("event_msg", { type: "agent_message", message: `${id} result` }, seconds + 2),
    row("event_msg", {
      type: "token_count",
      info: { last_token_usage: { input_tokens: tokens - 2, output_tokens: 2, total_tokens: tokens } }
    }, seconds + 3)
  ];
}

test("Codex task envelopes skip parent bodies while preserving projections and legacy provenance", async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-codex-parent-provenance-"));
  const sessions = path.join(temp, "sessions");
  mkdirSync(sessions, { recursive: true });
  t.after(() => rmSync(temp, { recursive: true, force: true }));

  const writeRollout = (name, records) => {
    const filePath = path.join(sessions, `${name}.jsonl`);
    writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    return filePath;
  };

  const rootRecords = [
    row("session_meta", { id: "root", session_id: "root" }),
    row("event_msg", { type: "user_message", message: "root request" }, 1),
    row("event_msg", { type: "agent_message", message: "root result" }, 2),
    row("event_msg", {
      type: "token_count",
      info: { last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }
    }, 3)
  ];
  const rootFile = writeRollout("00-root", rootRecords);

  // Keep the parsed body tiny while making the source extent larger than the
  // production payload budget. Spaces are ignored by the JSONL parser.
  const paddingFd = openSync(rootFile, "a");
  try {
    const padding = Buffer.alloc(64 * 1024, 32);
    padding[padding.length - 1] = 10;
    for (let index = 0; index < 1025; index += 1) writeSync(paddingFd, padding);
  } finally {
    closeSync(paddingFd);
  }
  const rootBytes = statSync(rootFile).size;
  assert.ok(rootBytes > 64 * 1024 * 1024);

  for (let index = 0; index < 4; index += 1) {
    writeRollout(`child-${index + 1}`, taskEnvelope(`child-${index + 1}`, "root", 10 + index * 10, 4));
  }

  const { initConfig } = await import("../dist/src/config.js");
  initConfig(["--codex-dir", temp]);
  const openCounts = new Map();
  const originalOpenSync = fs.openSync;
  t.mock.method(fs, "openSync", (...args) => {
    const descriptor = originalOpenSync(...args);
    const filePath = path.resolve(String(args[0]));
    openCounts.set(filePath, (openCounts.get(filePath) || 0) + 1);
    return descriptor;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const { default: codex } = await import("../dist/src/providers/codex/adapter.js?parent-provenance-test");
  const scanned = [];
  for await (const session of codex.scan()) scanned.push(session);
  assert.deepEqual(scanned.map((session) => session.id), ["root", "child-1", "child-2", "child-3", "child-4"]);

  const opened = (filePath) => openCounts.get(path.resolve(filePath)) || 0;
  // Initial indexing may evict the oversized root once; task-envelope child
  // resolution must not reload it once per child to classify copied context.
  assert.ok(opened(rootFile) <= 2, `task envelopes should not amplify root reads, got ${opened(rootFile)}`);

  // The boundary is recorded in the child body, so reader/protocol/metrics
  // projections must preserve the parent identity without reading its body.
  openCounts.clear();
  const inherited = codex.getInheritedContext("child-1");
  assert.equal(inherited.sourceSession.sessionId, "root");
  assert.ok(inherited.messages.length > 0);
  assert.equal(opened(rootFile), 0);
  codex.getOwnedReaderProjection("child-1");
  assert.equal(codex.getSessionProtocol("child-1").contextArtifacts.length, 0,
    "local child provenance still excludes inherited raw events without loading the parent");
  assert.equal(codex.getSessionProtocolV3("child-1").contextArtifacts.length, 0);
  codex.getSessionMetrics("child-1");
  codex.getSessionTree("child-1");
  assert.equal(opened(rootFile), 0);

  const child = codex.getSession("child-1");
  assert.equal(child.parentId, "root");
  assert.equal(child.tokenCount, 4);
  assert.equal(codex.getMessages("child-1").some((message) => message.content.includes("root result")), false);

  openCounts.clear();
  const tree = codex.getSessionTree("root");
  const container = codex.getSessionContainer("root");
  assert.ok(opened(rootFile) <= 2, "family and protocol construction do not reread the root per child");
  const metrics = codex.getSessionMetrics("root");
  assert.equal(tree.session.id, "root");
  assert.match(JSON.stringify(tree), /child-1/);
  assert.match(JSON.stringify(container), /child-4/);
  assert.equal(metrics.totals.directTotalTokens, 12);
  assert.equal(metrics.totals.totalTokens, 28);

  const { codexNeedsParentRecordsForProvenance, classifyCodexRecordProvenance,
    recordsToMessages, recordsToInheritedMessages, extractMeta } = await import(
    "../dist/src/providers/codex/parser.js?parent-provenance-test"
  );
  const taskRecords = taskEnvelope("task", "root", 0, 4);
  assert.equal(codexNeedsParentRecordsForProvenance(taskRecords), false);
  const withParent = recordsToMessages(taskRecords, "task", rootRecords);
  const withoutParent = recordsToMessages(taskRecords, "task");
  assert.deepEqual(withoutParent, withParent, "all normalized content, source IDs and usage remain identical");
  assert.deepEqual(extractMeta(taskRecords, "task", withoutParent),
    extractMeta(taskRecords, "task", withParent, rootRecords));
  assert.deepEqual(recordsToInheritedMessages(taskRecords, "task"),
    recordsToInheritedMessages(taskRecords, "task", rootRecords));
  assert.equal(codexNeedsParentRecordsForProvenance([
    row("session_meta", { id: "user-message", parent_thread_id: "root" }),
    row("response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Please explain the string NEW_TASK marker." }]
    })
  ]), true);

  const legacyRecords = [
    row("session_meta", { id: "legacy", parent_thread_id: "legacy-parent" }),
    row("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 1, total_tokens: 1 } } }, 1),
    row("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 2, total_tokens: 2 } } }, 2),
    row("event_msg", { type: "agent_message", message: "owned result" }, 3),
    row("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 3, total_tokens: 3 } } }, 4)
  ];
  const legacyParent = [
    row("session_meta", { id: "legacy-parent" }),
    row("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 1, total_tokens: 1 } } }, 1),
    row("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 2, total_tokens: 2 } } }, 2)
  ];
  assert.equal(codexNeedsParentRecordsForProvenance(legacyRecords), true);
  const provenance = classifyCodexRecordProvenance(legacyRecords, legacyParent);
  assert.equal(provenance.get(legacyRecords[1]), "inherited-parent-context");
  assert.equal(provenance.get(legacyRecords[2]), "inherited-parent-context");
  assert.equal(provenance.get(legacyRecords[3]), "session");
  writeRollout("legacy-parent", legacyParent);
  writeRollout("legacy", legacyRecords);
  const nextRefresh = Date.now() + 2000;
  t.mock.method(Date, "now", () => nextRefresh);
  const expectedLegacyMessages = recordsToMessages(legacyRecords, "legacy", legacyParent);
  assert.deepEqual(codex.getMessages("legacy"), expectedLegacyMessages,
    "legacy adapter resolution still loads the declared parent for copied usage");
  assert.equal(codex.getSession("legacy").tokenCount, 3);
});
