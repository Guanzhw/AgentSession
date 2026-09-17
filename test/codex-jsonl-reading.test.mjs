import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { zstdCompressSync } from "node:zlib";
import { extractCodexSessionId, parseSession, readCodexSessionSnapshot } from "../dist/src/providers/codex/parser.js";

for (const compressed of [false, true]) {
  test(`Codex ${compressed ? "compressed" : "plain"} JSONL preserves records across UTF-8 and long-line boundaries`, (t) => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-codex-lines-"));
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const file = path.join(temp, `rollout-filename-alias.jsonl${compressed ? ".zst" : ""}`);
    const prefix = '\uFEFF{"type":"session_meta","payload":{"id":"canonical-id","text":"';
    // Split a four-byte UTF-8 character between the first two read chunks.
    const padding = "x".repeat(65535 - Buffer.byteLength(prefix));
    const first = `${prefix}${padding}😀中文"}}`;
    const longRecord = { type: "response_item", payload: { text: "界🙂".repeat(40000) } };
    const tail = Array.from({ length: 3000 }, (_, index) => ({ type: "tail", payload: { index, text: `后续 ${index}` } }));
    const source = [first, "  ", "{malformed", JSON.stringify(longRecord), ...tail.map(JSON.stringify)].join("\r\n");
    const bytes = compressed ? zstdCompressSync(Buffer.from(source)) : Buffer.from(source);
    writeFileSync(file, bytes);
    const warnings = t.mock.method(console, "warn", () => {});

    const records = parseSession(file);

    assert.equal(extractCodexSessionId(records, "filename-alias"), "canonical-id");
    assert.equal(records[0].payload.text, `${padding}😀中文`);
    assert.deepEqual(records[1], longRecord);
    assert.deepEqual(records.slice(2), tail);
    assert.equal(warnings.mock.calls.length, 1);
    assert.match(warnings.mock.calls[0].arguments[0], /Skipping malformed JSON line/);
    assert.deepEqual(readFileSync(file), bytes);
  });
}

function liveRollout(t, mutate) {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-codex-live-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const file = path.join(temp, "live.jsonl");
  const records = [
    { type: "session_meta", payload: { id: "old-id", text: "x".repeat(70000) } },
    { type: "event_msg", payload: { type: "user_message", message: "original request" } }
  ];
  const source = records.map(JSON.stringify).join("\n") + "\n";
  writeFileSync(file, source);
  const read = fs.readSync;
  let changed = false;
  t.mock.method(fs, "readSync", (...args) => {
    const length = read(...args);
    if (!changed && length) {
      changed = true;
      mutate(file, source);
    }
    return length;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { file, records, source };
}

test("Codex active append preserves a finite snapshot and verified evicted rereads", (t) => {
  const appended = { type: "event_msg", payload: { type: "agent_message", message: "later reply" } };
  const { file, records, source } = liveRollout(t, (file) => fs.appendFileSync(file, JSON.stringify(appended) + "\n"));
  const captured = readCodexSessionSnapshot(file);
  assert.deepEqual(captured.records, records, "the initial read stops at its original extent");
  assert.equal(captured.snapshot.size, Buffer.byteLength(source));
  assert.deepEqual(readCodexSessionSnapshot(file, captured.snapshot).records, records);
  assert.deepEqual(readCodexSessionSnapshot(file).records, [...records, appended]);

  writeFileSync(file, (source + JSON.stringify(appended) + "\n").replace("old-id", "new-id"));
  assert.throws(() => readCodexSessionSnapshot(file, captured.snapshot), /snapshot changed/);
});

test("Codex rejects a growing rewrite of bytes already consumed", (t) => {
  const { file } = liveRollout(t, (file, source) => writeFileSync(file, source.replace("old-id", "new-id") + '{"later":true}\n'));
  assert.throws(() => readCodexSessionSnapshot(file), /changed while reading/);
});

test("Codex reports truncation of the captured read extent", (t) => {
  const { file } = liveRollout(t, (file) => fs.truncateSync(file, 10));
  assert.throws(() => readCodexSessionSnapshot(file), /transcript truncated/);
});
