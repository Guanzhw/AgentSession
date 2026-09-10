import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import test from "node:test";

import {
  DSH_KNOWN_EVENT_TYPES,
  DshSessionParseError,
  dshGenerationFromPath,
  dshInheritedEventCount,
  dshNativeUsageRecords,
  dshRecordsToMessages,
  dshStoredSystemPrompt,
  extractDshMeta,
  parseDshSession
} from "../dist/src/providers/deepseek-harness/parser.js";
import { discoverSessionFiles } from "../dist/src/providers/deepseek-harness/adapter.js";
import { DSH_COMPATIBILITY_SNAPSHOT } from "../dist/src/providers/deepseek-harness/compatibility.js";
import { buildDshSessionProtocol } from "../dist/src/providers/deepseek-harness/protocol.js";

function header(id, overrides = {}) {
  return { type: "session", version: 3, id, createdAt: 1000, isSeeded: false, delegationDepth: 0, ...overrides };
}

function event(type, seq, data, extra = {}) {
  return { type, seq, time: 1000 + seq, data, ...extra };
}

function writeJsonl(filePath, records) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function writeFrames(filePath, records) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, Buffer.concat(records.map((record) => zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`)))));
}

function user(seq, text, extra = {}) {
  return event("user/message", seq, { id: `user-${seq}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] }, { surfaceOp: "append", ...extra });
}

test("DSH preserves absolute source-host cwd paths on every viewer platform", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-dsh-source-cwd-"));
  const filePath = path.join(root, "session.v3.jsonl");
  try {
    for (const cwd of ["D:\\WorkSpace\\dsh-fixture", "/home/user/project", "\\\\server\\share\\project"]) {
      writeJsonl(filePath, [header("foreign-source", { cwd })]);
      assert.equal(parseDshSession(filePath)[0].cwd, cwd);
    }
    for (const cwd of ["relative/project", "D:relative", "", 42]) {
      writeJsonl(filePath, [header("invalid-source", { cwd })]);
      assert.throws(() => parseDshSession(filePath), /Invalid session\.cwd/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function system(seq, text, extra = {}) {
  return event("system/message", seq, { turn: 1, step: 1, message: { id: `system-${seq}`, role: "system", source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" }, content: text === "" ? [] : [{ type: "text", text }] } }, { surfaceOp: "append", ...extra });
}

test("DSH v3 discovers the highest generation and reads raw and multi-frame Zstandard logs", () => {
  assert.equal(dshGenerationFromPath("session.v3.jsonl"), 3);
  assert.equal(dshGenerationFromPath("session.v3.jsonl.zstd"), 3);
  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-dsh-v3-storage-"));
  try {
    const sessionDir = path.join(root, "sessions", "project", "session-v3");
    const records = [header("session-v3"), event("turn/start", 0, { turn: 1 }), user(1, "hello")];
    writeJsonl(path.join(sessionDir, "session.v2.jsonl"), [{ ...records[0], version: 2, isSeeded: false }, records[1]]);
    const rawPath = path.join(sessionDir, "session.v3.jsonl");
    writeJsonl(rawPath, records);
    assert.deepEqual(discoverSessionFiles(root), [{ sessionId: "session-v3", filePath: rawPath }]);
    assert.equal(parseDshSession(rawPath)[0].version, 3);
    const zstdPath = path.join(root, "zstd", "session.v3.jsonl.zstd");
    writeFrames(zstdPath, records);
    assert.equal(parseDshSession(zstdPath).length, records.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DSH v3 preserves recorded usage for every assistant attempt", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-dsh-v3-usage-"));
  try {
    const file = path.join(root, "session.v3.jsonl");
    writeJsonl(file, [
      header("usage"),
      event("turn/start", 0, { turn: 1 }),
      event("step/start", 1, { turn: 1, step: 1 }),
      event("assistant/attempt", 2, { turn: 1, step: 1, stream: [{ type: "usage", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } }] }),
      event("llm/retry-started", 3, { turn: 1, step: 1, retry: 1 }),
      event("assistant/attempt", 4, { turn: 1, step: 1, stream: [{ type: "usage", usage: { inputTokens: 4, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }] })
    ]);
    const parsed = parseDshSession(file);
    assert.deepEqual(dshNativeUsageRecords(parsed).map((record) => record.seq), [2, 4]);
    assert.equal(extractDshMeta(parsed).tokenCount, 12);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DSH v3 validates envelope vocabulary, surface replacement, system prompt, and transcript separation", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-dsh-v3-validation-"));
  try {
    const file = path.join(root, "session.v3.jsonl");
    const records = [
      header("surface"),
      event("turn/start", 0, { turn: 1 }),
      event("step/start", 1, { turn: 1, step: 1 }),
      system(2, "SYSTEM_PROMPT"),
      user(3, "old"),
      event("assistant/message", 4, { turn: 1, step: 1, message: { id: "assistant-4", role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "answer" }] } }, { surfaceOp: "append" }),
      user(5, "final", { surfaceOp: { op: "replace", startSeq: 3, endSeq: 4 }, sourceEventSeqs: [3, 4] }),
      system(6, "", { surfaceOp: { op: "replace", startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] }),
      { ...event("future/ignorable", 7, { opaque: true }), ignorable: true },
      event("tool/ptc-dispatch-start", 8, { rootCallId: "r", parentCallId: "p", subCallId: "s", name: "read", arguments: {} })
    ];
    writeJsonl(file, records);
    const parsed = parseDshSession(file);
    assert.equal(parsed.length, records.length);
    const beforeClear = parseDshSession(file).filter((entry) => entry.seq === 6 ? false : true);
    assert.equal(dshStoredSystemPrompt(beforeClear)?.content, "SYSTEM_PROMPT");
    assert.equal(dshStoredSystemPrompt(parsed), null, "an empty current system head must not fall back to an older prompt");
    assert.deepEqual(dshRecordsToMessages(parsed, "surface").map((message) => message.content), ["old", "answer"]);
    assert.equal(DSH_KNOWN_EVENT_TYPES.has("tool/ptc-dispatch"), true);
    const protocol = buildDshSessionProtocol({ session: extractDshMeta(parsed, "surface"), records: parsed, messages: dshRecordsToMessages(parsed, "surface"), children: [] });
    assert.equal(protocol.events.find((entry) => entry.providerData?.eventType === "tool/ptc-dispatch-start")?.kind, "tool.ptc-dispatch.started");

    for (const [name, mutate, message] of [
      ["packed", (value) => [...value, { type: "text-chunks", seq0: 1, time0: 1001, data: { turn: 1, step: 1, index: 0, texts: ["x"], dt: [] } }], /Packed text-chunks/],
      ["retired-system", (value) => [...value, event("request/header", 9, { header: { system: "retired" } })], /retired header\.system/],
      ["system-payload", (value) => value.map((entry) => entry.seq === 2 ? { ...entry, data: { ...entry.data, extra: true } } : entry), /Invalid system\/message payload/],
      ["system-replacement-without-head", (value) => value.map((entry) => entry.seq === 2 ? user(2, "not a system head") : entry).map((entry) => entry.seq === 5 ? system(5, "late", { surfaceOp: { op: "replace", startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] }) : entry), /requires a protected first surface head/],
      ["v2-replacement-alias", (value) => value.map((entry) => entry.seq === 5 ? { ...entry, surfaceOp: { op: "replace", start: 3, end: 4 } } : entry), /surfaceOp/],
      ["assistant-provenance", (value) => value.map((entry) => entry.seq === 4 ? { ...entry, sourceEventSeqs: [1] } : entry), /assistant\/message/],
      ["compaction-system-head", (value) => [...value, event("compaction/prune", 9, { shadowedSeqs: [6] })], /cannot shadow the protected system head/],
      ["required-opaque", (value) => [...value, event("future/required", 9, {})], /Unsupported required/],
      ["predecessor", (value) => [...value, event("tool/code-dispatch", 9, {})], /Unsupported required/],
      ["catalog-payload", (value) => [...value, event("subagent/catalog", 9, { version: 0, childId: "child", childCreatedAt: -1, mode: "one-shot" })], /Invalid subagent\/catalog payload/],
      ["deliverables-payload", (value) => [...value, event("deliverables/presented", 9, { turn: 1, callId: "present", files: [{ path: "" }] })], /Invalid deliverables\/presented payload/]
    ]) {
      const invalid = path.join(root, name, "session.v3.jsonl");
      writeJsonl(invalid, mutate(records));
      assert.throws(() => parseDshSession(invalid), DshSessionParseError);
      assert.throws(() => parseDshSession(invalid), message);
    }

    const toolOriginal = event("tool/result", 5, {
      turn: 1, step: 1,
      message: {
        id: "tool-result-3", role: "user",
        content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "old" }], isError: false }],
        source: { kind: "tool", callId: "call-1" }
      }
    }, { surfaceOp: "append" });
    const toolBase = [header("tool-replacement"), event("turn/start", 0, { turn: 1 }), event("step/start", 1, { turn: 1, step: 1 }), system(2, "SYSTEM_PROMPT"), user(3, "tool user"), event("assistant/message", 4, { turn: 1, step: 1, message: { id: "tool-assistant-4", role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "tool answer" }] } }, { surfaceOp: "append" }), toolOriginal];
    const toolReplacement = event("tool/result", 6, {
      ...toolOriginal.data,
      message: { ...toolOriginal.data.message, content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "new" }], isError: false }] }
    }, { surfaceOp: { op: "replace", startSeq: 5, endSeq: 5 }, sourceEventSeqs: [5] });
    const toolTarget = { ...toolReplacement, data: { ...toolReplacement.data }, surfaceOp: { op: "replace", startSeq: 3, endSeq: 4 }, sourceEventSeqs: [3, 4] };
    const toolMetadata = { ...toolReplacement, data: { ...toolReplacement.data, message: { ...toolReplacement.data.message, source: { kind: "tool", callId: "call-2" } } } };
    for (const [name, replacement, message] of [
      ["tool-target", toolTarget, /tool\/result replacement target/],
      ["tool-metadata", toolMetadata, /only message\.content may change/]
    ]) {
      const invalid = path.join(root, name, "session.v3.jsonl");
      writeJsonl(invalid, [...toolBase, replacement]);
      assert.throws(() => parseDshSession(invalid), message);
    }
    const validTool = path.join(root, "tool-valid", "session.v3.jsonl");
    writeJsonl(validTool, [...toolBase, toolReplacement]);
    assert.equal(parseDshSession(validTool).length, 8);

    const validTailSystem = path.join(root, "system-tail-valid", "session.v3.jsonl");
    writeJsonl(validTailSystem, [
      header("system-tail-valid"),
      event("turn/start", 0, { turn: 1 }),
      event("step/start", 1, { turn: 1, step: 1 }),
      system(2, "SYSTEM_PROMPT"),
      user(3, "hello"),
      system(4, "tail"),
      system(5, "updated tail", { surfaceOp: { op: "replace", startSeq: 4, endSeq: 4 }, sourceEventSeqs: [4] })
    ]);
    assert.equal(parseDshSession(validTailSystem).length, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DSH v3 seeded inheritance and official fixture provenance remain explicit", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-dsh-v3-seed-"));
  try {
    const seeded = path.join(root, "seeded", "session.v3.jsonl");
    writeJsonl(seeded, [header("seeded", { isSeeded: true }), event("session/end-seed", 0, { inherited: true }), user(1, "own")]);
    const parsed = parseDshSession(seeded);
    assert.equal(dshInheritedEventCount(parsed), 0);
    assert.equal(extractDshMeta(parsed).metadata.isSeeded, true);
    assert.equal(extractDshMeta(parsed).metadata.seedLength, null, "v3 has no numeric seedLength field");
    const missing = path.join(root, "missing", "session.v3.jsonl");
    writeJsonl(missing, [header("missing", { isSeeded: true }), event("turn/start", 0, { turn: 1 })]);
    assert.throws(() => parseDshSession(missing), /lacks inherited end-seed/);
    const unseeded = path.join(root, "unseeded", "session.v3.jsonl");
    writeJsonl(unseeded, [header("unseeded"), event("session/end-seed", 0, { inherited: true })]);
    assert.throws(() => parseDshSession(unseeded), /Unseeded/);

    const fixturePath = path.join(process.cwd(), DSH_COMPATIBILITY_SNAPSHOT.fixture.local);
    const hash = createHash("sha256").update(readFileSync(fixturePath)).digest("hex");
    assert.equal(hash, DSH_COMPATIBILITY_SNAPSHOT.fixture.sha256);
    const official = parseDshSession(fixturePath, 3);
    assert.equal(official[0].version, 3);
    assert.equal(official.length, 200);
    assert.equal(DSH_COMPATIBILITY_SNAPSHOT.tag, "dsh-v0.1.5-alpha.2");
    assert.equal(DSH_COMPATIBILITY_SNAPSHOT.commit, "b2e3b2a0125854567a4a5fcba75782e42fe84901");
    assert.equal(DSH_COMPATIBILITY_SNAPSHOT.npm.current, "0.1.5-alpha.2");
    assert.equal(DSH_COMPATIBILITY_SNAPSHOT.sessionFormatVersion, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
