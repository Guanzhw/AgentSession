import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { zstdCompressSync } from "node:zlib";
import { readCodexSessionSnapshot } from "../dist/src/providers/codex/parser.js";
import { createSessionFileStore, sessionFileSignature } from "../dist/src/providers/shared/file-adapter-helpers.js";

test("Codex snapshot payloads remain indexed and coherent through append, eviction and refresh", (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-codex-snapshot-cache-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const first = path.join(temp, "first.jsonl");
  const second = path.join(temp, "second.jsonl");
  const original = { id: "first", text: "x".repeat(70000) };
  const appended = { id: "later", text: "appended while being read" };
  writeFileSync(first, JSON.stringify(original) + "\n");
  writeFileSync(second, '{"id":"second","text":"other"}\n');
  const descriptor = [{ sessionId: "first", filePath: first }, { sessionId: "second", filePath: second }];
  const read = fs.readSync;
  let changed = false;
  t.mock.method(fs, "readSync", (...args) => {
    const length = read(...args);
    if (!changed && length) {
      changed = true;
      fs.appendFileSync(first, JSON.stringify(appended) + "\n");
    }
    return length;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const errors = [];
  const store = createSessionFileStore({
    discoverFiles: () => descriptor,
    refreshIntervalMs: 60000,
    maxCachedSourceBytes: 1,
    readEntry({ filePath }) {
      const { records, snapshot } = readCodexSessionSnapshot(filePath);
      return {
        session: { id: records[0].id, count: records.length },
        records,
        messages: records.map((record) => record.text),
        payloadSnapshot: {
          signature: sessionFileSignature(filePath, snapshot), sourceBytes: snapshot.size,
          read() {
            const { records } = readCodexSessionSnapshot(filePath, snapshot);
            return { records, messages: records.map((record) => record.text) };
          }
        }
      };
    },
    onError(file, error) { errors.push(error.message); }
  });
  const entries = store.list();
  assert.deepEqual(entries.map((entry) => entry.session.id), ["first", "second"]);
  assert.deepEqual(errors, []);
  assert.equal(entries[0].session.count, 1);
  assert.deepEqual(entries[0].records, [original], "evicted body reconstructs the same snapshot after append");
  store.refresh(true);
  const current = store.get("first");
  assert.equal(current.session.count, 2);
  assert.deepEqual(current.records, [original, appended]);
  assert.deepEqual(entries[0].records, [original], "an older immutable snapshot keeps its original body");
  assert.deepEqual(current.records, [original, appended]);
  store.get("second").records;
  assert.deepEqual(entries[0].records, [original], "an old snapshot cannot poison the path cache after the current body is evicted");
  assert.deepEqual(current.records, [original, appended]);
});

test("Codex scan, search and parent ownership survive eviction and a disappearing rollout", async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-codex-eviction-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const sessions = path.join(temp, "sessions");
  mkdirSync(sessions);
  const writeRollout = (name, records) => {
    const file = path.join(sessions, `${name}.jsonl`);
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    return file;
  };
  const row = (type, payload) => ({ type, payload, timestamp: "2026-09-15T00:00:00.000Z" });
  const parentFile = writeRollout("a-parent-alias", [
    row("session_meta", { id: "parent" }),
    row("event_msg", { type: "user_message", message: "Parent request" })
  ]);
  // Whitespace keeps the fixture's parsed body small while its actual source
  // weight exercises the production 64 MiB cache budget and oversized entry.
  const padding = Buffer.alloc(64 * 1024, 32);
  padding[padding.length - 1] = 10;
  const descriptor = openSync(parentFile, "a");
  try {
    for (let index = 0; index < 1025; index++) writeSync(descriptor, padding);
  } finally {
    closeSync(descriptor);
  }
  writeRollout("b-child-alias", [
    row("session_meta", { id: "child", parent_thread_id: "parent" }),
    row("event_msg", { type: "user_message", message: "Inherited parent request" }),
    row("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 100, total_tokens: 100 } } }),
    row("response_item", { type: "agent_message", content: [{ type: "output_text", text: "Message Type: NEW_TASK\nTask name: worker" }] }),
    row("event_msg", { type: "agent_message", message: "ownedneedle child result" }),
    row("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } }),
    row("compacted", { summary: "Owned compaction", tokens_before: 30 })
  ]);
  writeRollout("c-other-alias", [
    row("session_meta", { id: "other" }),
    row("event_msg", { type: "user_message", message: "ownedneedle other request" })
  ]);
  const before = statSync(parentFile);
  const { initConfig } = await import("../dist/src/config.js");
  initConfig(["--codex-dir", temp]);
  const { default: codex } = await import("../dist/src/providers/codex/adapter.js?payload-cache-test");

  const scanned = [];
  for await (const session of codex.scan()) scanned.push(session);
  assert.deepEqual(scanned.map((session) => session.id), ["parent", "child", "other"]);
  assert.equal(scanned.find((session) => session.id === "child").tokenCount, 7);
  assert.equal(codex.getSession("a-parent-alias").id, "parent");
  assert.deepEqual(codex.searchMessages("ownedneedle").map((result) => result.sessionId), ["child", "other"]);
  assert.equal(codex.getMessages("child").some((message) => message.content.startsWith("Inherited")), false);
  const protocol = codex.getSessionProtocol("child");
  assert.ok(protocol);
  assert.equal(protocol.events.filter((event) => event.kind === "context.compaction").length, 1);
  assert.equal(codex.getSession("child").tokenCount, 7);
  const after = statSync(parentFile);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);

  // Resolving the child refreshes its parent/index after a later root has
  // appended. The scan's held later-root snapshot must remain readable.
  const activeScan = codex.scan();
  assert.equal((await activeScan.next()).value.id, "parent");
  fs.appendFileSync(path.join(sessions, "c-other-alias.jsonl"), JSON.stringify(
    row("event_msg", { type: "agent_message", message: "later active reply" })
  ) + "\n");
  const clock = t.mock.method(Date, "now", () => Date.parse("2099-01-01T00:00:00.000Z"));
  try {
    assert.equal((await activeScan.next()).value.id, "child");
    assert.equal((await activeScan.next()).value.id, "other", "refresh must not discard a healthy held snapshot");
    assert.equal((await activeScan.next()).done, true);
    assert.equal(codex.getMessages("other").some((message) => message.content === "later active reply"), true);
  } finally {
    clock.mock.restore();
  }

  const warnings = t.mock.method(console, "warn", () => {});
  const scan = codex.scan();
  assert.equal((await scan.next()).value.id, "parent");
  const missingFile = path.join(sessions, "b-child-alias.jsonl");
  rmSync(missingFile);
  assert.equal((await scan.next()).value.id, "other");
  assert.equal((await scan.next()).done, true);
  assert.equal(warnings.mock.calls.length, 1);
  assert.match(warnings.mock.calls[0].arguments[0], /Skipping unreadable Codex session during scan/);
  assert.equal(warnings.mock.calls[0].arguments[1], missingFile);
});

test("Codex protocol snapshot pair prepares only once from an evicting family", async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-codex-protocol-family-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const sessions = path.join(temp, "sessions");
  mkdirSync(sessions);
  const row = (type, payload) => ({
    type,
    payload,
    timestamp: "2026-09-15T00:00:00.000Z"
  });
  const writeRollout = (name, records) => {
    const file = path.join(sessions, `${name}.jsonl`);
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    return file;
  };

  // The oversized root is intentionally above the production payload budget.
  // Padding is whitespace, so this exercises eviction without allocating a
  // correspondingly large parsed record or message.
  writeRollout("00-parent", [
    row("session_meta", { id: "parent" }),
    row("event_msg", { type: "user_message", message: "parent" })
  ]);
  const rootFile = writeRollout("01-root", [
    row("session_meta", { id: "root", parent_thread_id: "parent" }),
    row("event_msg", { type: "user_message", message: "root" }),
    row("event_msg", { type: "agent_message", message: "root answer" })
  ]);
  const descriptor = openSync(rootFile, "a");
  try {
    const padding = Buffer.alloc(64 * 1024, 32);
    padding[padding.length - 1] = 10;
    for (let index = 0; index < 1025; index++) writeSync(descriptor, padding);
  } finally {
    closeSync(descriptor);
  }
  writeRollout("02-child", [
    row("session_meta", { id: "child", parent_thread_id: "root", agent_path: "worker" }),
    row("response_item", {
      type: "agent_message",
      content: [{ type: "output_text", text: "Message Type: NEW_TASK\nTask name: worker" }]
    }),
    row("event_msg", { type: "agent_message", message: "child answer" }),
    row("response_item", {
      type: "agent_message",
      id: "child-final",
      author: "worker",
      recipient: "/root",
      content: [{ type: "output_text", text: "Message Type: FINAL_ANSWER\nchild answer" }]
    }),
    row("event_msg", { type: "task_complete", turn_id: "child-turn", completed_at: 1789430400 })
  ]);
  writeRollout("03-sibling", [
    row("session_meta", { id: "sibling", parent_thread_id: "root", agent_path: "reviewer", model: "gpt-sibling" }),
    row("event_msg", { type: "agent_message", message: "sibling answer" })
  ]);
  writeRollout("04-grandchild", [
    row("session_meta", { id: "grandchild", parent_thread_id: "child", agent_path: "nested" }),
    row("event_msg", { type: "agent_message", message: "grandchild answer" })
  ]);

  const { initConfig } = await import("../dist/src/config.js");
  initConfig(["--codex-dir", temp]);
  const fsModule = fs;
  const originalOpenSync = fsModule.openSync;
  const openCounts = new Map();
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.method(fsModule, "openSync", (...args) => {
    const fd = originalOpenSync(...args);
    const filePath = path.resolve(String(args[0]));
    openCounts.set(filePath, (openCounts.get(filePath) || 0) + 1);
    return fd;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { default: codex } = await import("../dist/src/providers/codex/adapter.js?protocol-family-test");

  const originalFreeze = Object.freeze;
  const finalizedVersions = [];
  t.mock.method(Object, "freeze", (value) => {
    if (value?.sessionId === "root" && value?.validation && value?.version) finalizedVersions.push(value.version);
    return originalFreeze(value);
  });
  const pair = codex.getSessionProtocolSnapshots("01-root");
  assert.deepEqual(finalizedVersions, [2, 3], "the pair finalizes one base and one native v3 snapshot");
  const protocol = pair.v3;
  assert.ok(protocol);
  assert.equal(pair.v2.sessionId, "root");
  assert.deepEqual(protocol.revision, pair.v2.revision);
  assert.ok(Object.isFrozen(pair.v2));
  assert.ok(Object.isFrozen(protocol));
  const childRelationships = protocol.relationships
    .filter((relationship) => relationship.fromSessionId === "root")
    .map((relationship) => relationship.toSessionId);
  assert.deepEqual(childRelationships, ["child", "sibling"]);
  assert.equal(protocol.relationships.some((relationship) => relationship.toSessionId === "grandchild"), false);
  assert.equal(protocol.agentRuns.find((run) => run.childSessionId === "sibling")?.model, "gpt-sibling");
  const childCompletion = protocol.coordination.find((observation) => observation.kind === "child-turn-completed");
  assert.equal(childCompletion?.sourceEventRef?.eventId, "event:turn:task_complete:3");

  const opened = (name) => openCounts.get(path.resolve(sessions, `${name}.jsonl`)) || 0;
  // Initial indexing reads each discovered file once. The protocol request may
  // reread the evicted root and its parent, but never loads the grandchild and
  // never amplifies parent reads through the descendant family.
  assert.ok(opened("01-root") <= 2);
  assert.ok(opened("00-parent") <= 2);
  assert.ok(opened("02-child") <= 2);
  assert.ok(opened("03-sibling") <= 2);
  assert.equal(opened("04-grandchild"), 1);
  assert.deepEqual(pair.v2, codex.getSessionProtocol("root"));
  assert.deepEqual(pair.v3, codex.getSessionProtocolV3("root"));
  assert.equal(codex.getSessionProtocolSnapshots("missing"), null);

  const failure = Object.assign(new Error("Rollout became unreadable"), { code: "EACCES" });
  t.mock.method(fsModule, "openSync", (...args) => {
    if (path.resolve(String(args[0])) === path.resolve(rootFile)) throw failure;
    return originalOpenSync(...args);
  });
  syncBuiltinESMExports();
  assert.throws(() => codex.getSessionProtocolSnapshots("root"), (error) => error === failure);
});

test("Codex protocol snapshot pair preserves ownership and the captured revision while rollouts grow", async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-codex-protocol-pair-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const sessions = path.join(temp, "sessions");
  mkdirSync(sessions);
  const row = (type, payload) => ({ type, payload, timestamp: "2026-09-15T00:00:00.000Z" });
  const token = (total) => row("event_msg", {
    type: "token_count", info: { last_token_usage: { input_tokens: total, total_tokens: total } }
  });
  const writeRollout = (name, records) => {
    const file = path.join(sessions, `${name}.jsonl`);
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    return file;
  };
  writeRollout("parent-alias", [row("session_meta", { id: "parent" }), token(500)]);
  const rootFile = writeRollout("root-alias", [
    row("session_meta", { id: "root", parent_thread_id: "parent" }),
    row("event_msg", { type: "user_message", message: "Inherited parent request" }),
    token(500),
    row("response_item", { type: "agent_message", content: [{ type: "output_text", text: "Message Type: NEW_TASK\nTask name: worker" }] }),
    row("event_msg", { type: "user_message", message: "Owned request" }),
    token(7),
    row("compacted", { summary: "Owned context" })
  ]);
  const childFile = writeRollout("child-alias", [
    row("session_meta", { id: "child", parent_thread_id: "root", agent_path: "worker" }),
    row("event_msg", { type: "task_started", turn_id: "child-turn" })
  ]);
  const before = [rootFile, childFile].map((file) => statSync(file));
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { initConfig } = await import("../dist/src/config.js");
  initConfig(["--codex-dir", temp]);
  const { default: codex } = await import("../dist/src/providers/codex/adapter.js?protocol-pair-growth-test");
  const original = codex.getSessionProtocolSnapshots("root-alias");
  assert.deepEqual(original.v3.usageRecords.map((record) => record.tokens.total), [7]);
  assert.equal(original.v2.events.filter((event) => event.kind === "context.compaction").length, 1);
  assert.deepEqual(original.v2, codex.getSessionProtocol("root"));
  assert.deepEqual(original.v3, codex.getSessionProtocolV3("root"));
  for (let index = 0; index < before.length; index++) {
    const after = statSync([rootFile, childFile][index]);
    assert.equal(after.size, before[index].size);
    assert.equal(after.mtimeMs, before[index].mtimeMs);
  }

  // Append after v2 finalization, before v3 reads the prepared input. Crossing
  // the index refresh interval cannot relabel or expand the held snapshot.
  const freeze = Object.freeze;
  let appended = false;
  const freezeMock = t.mock.method(Object, "freeze", (value) => {
    if (!appended && value?.version === 2 && value?.sessionId === "root" && value?.validation) {
      appended = true;
      fs.appendFileSync(rootFile, JSON.stringify(token(11)) + "\n");
      fs.appendFileSync(childFile, JSON.stringify(row("event_msg", { type: "task_complete", turn_id: "child-turn" })) + "\n");
      now += 2000;
    }
    return freeze(value);
  });
  const held = codex.getSessionProtocolSnapshots("root");
  freezeMock.mock.restore();
  assert.equal(appended, true);
  assert.deepEqual(held, original);
  const current = codex.getSessionProtocolSnapshots("root-alias");
  assert.notDeepEqual(current.v2.revision, original.v2.revision);
  assert.deepEqual(current.v2.revision, current.v3.revision);
  assert.deepEqual(current.v3.usageRecords.map((record) => record.tokens.total), [7, 11]);
  assert.equal(original.v3.coordination.some((item) => item.kind === "child-turn-completed"), false);
  assert.equal(current.v3.coordination.some((item) => item.kind === "child-turn-completed"), true);
  assert.deepEqual(held, original, "later preparation leaves already returned facts unchanged");

  writeRollout("new-child-alias", [row("session_meta", { id: "new-child", parent_thread_id: "root" })]);
  now += 2000;
  const expanded = codex.getSessionProtocolSnapshots("root");
  assert.notDeepEqual(expanded.v2.revision, current.v2.revision);
  assert.equal(expanded.v2.relationships.some((item) => item.toSessionId === "new-child"), true);
  assert.equal(expanded.v3.relationships.some((item) => item.toSessionId === "new-child"), true);
  rmSync(rootFile);
  now += 2000;
  assert.equal(codex.getSessionProtocolSnapshots("root"), null);
  assert.equal(codex.getSessionProtocolSnapshots("root-alias"), null);
});

test("Codex scan reuses indexed summaries and invalidates legacy children when their parent changes", async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-codex-scan-summary-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const { initConfig } = await import("../dist/src/config.js");
  const row = (type, payload) => ({ type, payload, timestamp: "2026-09-15T00:00:00.000Z" });
  const usage = (total) => row("event_msg", {
    type: "token_count", info: { last_token_usage: { input_tokens: total, total_tokens: total } }
  });

  for (const compressed of [false, true]) {
    const codexDir = path.join(temp, compressed ? "compressed" : "plain");
    const sessions = path.join(codexDir, "sessions");
    mkdirSync(sessions, { recursive: true });
    const suffix = compressed ? ".jsonl.zst" : ".jsonl";
    const parentFile = path.join(sessions, `00-parent-alias${suffix}`);
    const childFile = path.join(sessions, `01-child-alias${suffix}`);
    const writeRollout = (filePath, records) => {
      const source = Buffer.from(records.map(JSON.stringify).join("\n") + "\n");
      writeFileSync(filePath, compressed ? zstdCompressSync(source) : source);
    };
    const parentMeta = row("session_meta", { id: "parent" });
    const childRecords = [
      row("session_meta", { id: "child", parent_thread_id: "00-parent-alias" }),
      usage(1), usage(2),
      row("event_msg", { type: "agent_message", message: "owned answer" }),
      usage(3)
    ];
    writeRollout(parentFile, [parentMeta, usage(1), usage(2)]);
    writeRollout(childFile, childRecords);

    initConfig(["--codex-dir", codexDir]);
    let now = Date.now();
    const clock = t.mock.method(Date, "now", () => now);
    const reads = new Map();
    const readMethod = compressed ? "readFileSync" : "openSync";
    const originalRead = fs[readMethod];
    const reader = t.mock.method(fs, readMethod, (...args) => {
      const filePath = path.resolve(String(args[0]));
      reads.set(filePath, (reads.get(filePath) || 0) + 1);
      return originalRead(...args);
    });
    syncBuiltinESMExports();
    const { default: codex } = await import(`../dist/src/providers/codex/adapter.js?scan-summary-${compressed}`);
    const scan = async () => {
      const found = [];
      for await (const session of codex.scan()) found.push(session);
      return found;
    };
    try {
      const initialSources = codex.getSearchIndexSources();
      assert.deepEqual(initialSources.map((source) => source.sessionId), ["parent", "child"]);
      assert.equal(JSON.parse(initialSources[1].revision)[1], "parent",
        "the child revision uses the resolved canonical parent identity");
      const initial = await scan();
      assert.deepEqual(initial.map((session) => session.id), ["parent", "child"]);
      assert.equal(initial[1].tokenCount, 3);
      assert.equal(initial[1].parentId, "00-parent-alias");
      const initialReads = new Map(reads);
      const repeated = await scan();
      assert.strictEqual(repeated[0], initial[0], "parent summary comes from indexing");
      assert.strictEqual(repeated[1], initial[1], "legacy child summary is reused");
      assert.deepEqual(reads, initialReads, "unchanged scan does not reread rollouts");
      assert.deepEqual(codex.getSearchIndexSources(), initialSources);
      assert.deepEqual(reads, initialReads, "source enumeration does not reload message bodies");

      writeRollout(parentFile, [parentMeta, usage(1)]);
      const held = await scan();
      assert.equal(held[1].tokenCount, 3, "the indexed parent stays coherent within its refresh window");
      assert.deepEqual(codex.getSearchIndexSources(), initialSources);
      now += 2000;
      const revised = await scan();
      assert.equal(revised[1].tokenCount, 6, "parent rewrite changes child token ownership");
      assert.notStrictEqual(revised[1], initial[1]);
      assert.deepEqual(revised[1].libraryEvidence, initial[1].libraryEvidence);
      assert.deepEqual(revised[1], {
        ...codex.getSession("child"), libraryEvidence: revised[1].libraryEvidence
      });
      const revisedSources = codex.getSearchIndexSources();
      assert.notEqual(revisedSources[0].revision, initialSources[0].revision);
      assert.notEqual(revisedSources[1].revision, initialSources[1].revision,
        "the child search revision includes its parent source revision");

      writeRollout(childFile, [...childRecords, usage(4)]);
      now += 2000;
      const appended = await scan();
      assert.equal(appended[1].tokenCount, 10, "child rewrite invalidates its own summary");
      assert.notStrictEqual(appended[1], revised[1]);
      const appendedSources = codex.getSearchIndexSources();
      assert.equal(appendedSources[0].revision, revisedSources[0].revision);
      assert.notEqual(appendedSources[1].revision, revisedSources[1].revision);

      rmSync(childFile);
      now += 2000;
      assert.deepEqual((await scan()).map((session) => session.id), ["parent"]);
      assert.deepEqual(codex.getSearchIndexSources().map((source) => source.sessionId), ["parent"]);
    } finally {
      reader.mock.restore();
      clock.mock.restore();
      syncBuiltinESMExports();
    }
  }
});
