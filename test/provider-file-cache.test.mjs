import assert from "node:assert/strict";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync
} from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initConfig } from "../dist/src/config.js";
import { getResumeCommand } from "../dist/src/resume.js";
import claudeCode from "../dist/src/providers/claude-code/adapter.js";
import codex from "../dist/src/providers/codex/adapter.js";
import pi from "../dist/src/providers/pi/adapter.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const recentFixtureEpoch = (() => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  date.setUTCHours(12, 0, 0, 0);
  return date.getTime();
})();
const recentFixtureTime = (seconds = 0) => new Date(recentFixtureEpoch + seconds * 1_000).toISOString();
const recentFixtureDay = (seconds = 0) => recentFixtureTime(seconds).slice(0, 10);

function normalizeMtime(filePath) {
  const stat = statSync(filePath);
  const normalized = new Date(Math.floor(stat.mtimeMs));
  utimesSync(filePath, stat.atime, normalized);
}

function replaceWithSameSignature(filePath) {
  const before = statSync(filePath);
  writeFileSync(filePath, "!".repeat(before.size));
  utimesSync(filePath, before.atime, before.mtime);
  const after = statSync(filePath);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
}

async function collect(scan) {
  const values = [];
  for await (const value of scan) values.push(value);
  return values;
}

function writeJsonLines(filePath, records) {
  writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function recentPiFixture(content) {
  const fixtureEpoch = Date.parse("2026-07-19T01:00:00.000Z");
  const offset = recentFixtureEpoch - fixtureEpoch;
  return `${content.trimEnd().split("\n").map((line) => {
    const record = JSON.parse(line);
    if (typeof record.timestamp === "string") {
      record.timestamp = new Date(Date.parse(record.timestamp) + offset).toISOString();
    }
    if (typeof record.message?.timestamp === "number") {
      record.message.timestamp += offset;
    }
    return JSON.stringify(record);
  }).join("\n")}\n`;
}

function claudeRecords({ sessionId, marker, outputTokens = 7, sidechain = null }) {
  const timestamp = recentFixtureTime();
  return [
    {
      type: "system",
      uuid: `${sessionId}-system`,
      timestamp,
      cwd: "D:\\WorkSpace\\OpenSession",
      ...(sidechain || {})
    },
    {
      type: "user",
      uuid: `${sessionId}-user`,
      timestamp,
      message: { content: marker },
      ...(sidechain || {})
    },
    {
      type: "assistant",
      uuid: `${sessionId}-assistant`,
      timestamp: recentFixtureTime(1),
      message: {
        content: [{ type: "text", text: `${marker} reply` }],
        usage: { input_tokens: 3, output_tokens: outputTokens }
      },
      ...(sidechain || {})
    }
  ];
}

test("Claude file cache preserves canonical subagent families and refreshes changed transcripts", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-claude-cache-"));
  try {
    const project = path.join(root, "projects", "encoded-project");
    const subagents = path.join(project, "root-canonical", "subagents");
    mkdirSync(subagents, { recursive: true });
    const rootFile = path.join(project, "root-canonical.jsonl");
    const childFile = path.join(subagents, "agent-child-alias.jsonl");
    writeJsonLines(rootFile, claudeRecords({ sessionId: "root-canonical", marker: "root cached marker" }));
    writeJsonLines(childFile, claudeRecords({
      sessionId: "child-canonical",
      marker: "child cached marker",
      sidechain: { isSidechain: true, agentId: "child-canonical", sessionId: "root-canonical" }
    }));
    normalizeMtime(rootFile);
    normalizeMtime(childFile);
    initConfig(["--claude-dir", root]);

    const scanned = await collect(claudeCode.scan());
    assert.deepEqual(scanned.map((session) => session.id).sort(), ["child-canonical", "root-canonical"]);
    assert.equal(claudeCode.getSession("child-alias")?.id, "child-canonical");
    assert.equal(claudeCode.getSession("child-canonical")?.parentId, "root-canonical");
    assert.equal(claudeCode.getMessages("child-alias")[0]?.sessionId, "child-canonical");

    replaceWithSameSignature(rootFile);
    replaceWithSameSignature(childFile);
    await sleep(1050);
    assert.match(claudeCode.getMessages("root-canonical")[0]?.content || "", /root cached marker/);
    assert.equal(claudeCode.searchMessages("child cached marker")[0]?.sessionId, "child-canonical");
    assert.ok(claudeCode.getTokenStats(30).some((day) => day.outputTokens >= 14));
    assert.match(JSON.stringify(claudeCode.getSessionTree("root-canonical")), /child-canonical/);
    assert.ok(claudeCode.getSystemPrompts("root-canonical"));
    assert.equal(claudeCode.getSessionMetrics("root-canonical")?.totals.steps, 1);

    const partialSystemRecord = claudeRecords({
      sessionId: "root-canonical",
      marker: "partial write must not replace cache"
    })[0];
    writeFileSync(rootFile, `${JSON.stringify(partialSystemRecord)}\n{"type":"user","message":`);
    await sleep(1050);
    assert.match(claudeCode.getMessages("root-canonical")[0]?.content || "", /root cached marker/);

    writeJsonLines(rootFile, claudeRecords({
      sessionId: "root-canonical",
      marker: "root refreshed marker with a different size",
      outputTokens: 19
    }));
    await sleep(1050);
    assert.match(claudeCode.getMessages("root-canonical")[0]?.content || "", /root refreshed marker/);
    assert.equal(claudeCode.searchMessages("root refreshed marker")[0]?.sessionId, "root-canonical");
    assert.ok(claudeCode.getTokenStats(30).some((day) => day.outputTokens >= 26));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function codexRecords(marker) {
  return [
    {
      timestamp: "2026-07-12T01:30:00.000Z",
      type: "session_meta",
      payload: { id: "codex-canonical", cwd: "D:\\WorkSpace\\OpenSession" }
    },
    {
      timestamp: "2026-07-12T01:30:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: marker }
    },
    {
      timestamp: "2026-07-12T01:30:02.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "read_file",
        call_id: "read-1",
        input: { path: "README.md" }
      }
    },
    {
      timestamp: "2026-07-12T01:30:03.000Z",
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "read-1", output: `${marker} output` }
    },
    {
      timestamp: "2026-07-12T01:30:04.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `${marker} reply` }]
      }
    }
  ];
}

test("Codex file cache exposes shared Agent Loop metrics and prompt evidence", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-codex-cache-"));
  try {
    const sessions = path.join(root, "sessions", "2026", "07", "12");
    mkdirSync(sessions, { recursive: true });
    const sessionFile = path.join(sessions, "rollout-2026-07-12T01-30-00-000Z_019f7b00-0000-7000-8000-000000000010.jsonl");
    writeJsonLines(sessionFile, codexRecords("codex cached marker"));
    normalizeMtime(sessionFile);
    initConfig(["--codex-dir", root]);

    const scanned = await collect(codex.scan());
    assert.deepEqual(scanned.map((session) => session.id), ["codex-canonical"]);
    assert.equal(codex.searchMessages("codex cached marker")[0]?.sessionId, "codex-canonical");
    assert.equal(codex.getSessionMetrics("codex-canonical")?.totals.steps, 1);
    const prompts = codex.getSystemPrompts("codex-canonical");
    assert.equal(prompts?.mode, "codex-resolved");
    assert.match(JSON.stringify(prompts), /codex cached marker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex token stats exclude parent usage copied by a legacy fork without NEW_TASK", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-codex-parent-usage-"));
  try {
    const sessions = path.join(root, "sessions", "2026", "07", "20");
    mkdirSync(sessions, { recursive: true });
    const token = (timestamp, total) => ({
      timestamp,
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total } } }
    });
    const parent = [
      { timestamp: recentFixtureTime(), type: "session_meta", payload: { id: "parent" } },
      token(recentFixtureTime(1), 10),
      token(recentFixtureTime(2), 20),
      token(recentFixtureTime(3), 30)
    ];
    const child = [
      { timestamp: recentFixtureTime(30), type: "session_meta", payload: { id: "child", parent_thread_id: "parent" } },
      token(recentFixtureTime(31), 20),
      token(recentFixtureTime(32), 30),
      { timestamp: recentFixtureTime(33), type: "event_msg", payload: { type: "agent_message", message: "child-owned output" } },
      token(recentFixtureTime(34), 40)
    ];
    const parentFile = path.join(sessions, "rollout-parent.jsonl");
    writeJsonLines(parentFile, parent);
    writeJsonLines(path.join(sessions, "rollout-child.jsonl"), child);
    initConfig(["--codex-dir", root]);
    await sleep(1050);

    assert.equal(codex.getSession("child")?.tokenCount, 40);
    const day = codex.getTokenStats(30).find((item) => item.day === recentFixtureDay());
    assert.deepEqual(day && { total: day.totalTokens, events: day.messageCount }, { total: 100, events: 4 });

    // Parent changes affect the child's ownership decision. Keep the parent
    // total unchanged while breaking the copied sequence to prove that the
    // composite parent signature invalidates the child's cached daily bucket.
    writeJsonLines(parentFile, [parent[0], parent[1], parent[3], parent[2]]);
    await sleep(1050);
    const afterParentChange = codex.getTokenStats(30).find((item) => item.day === recentFixtureDay());
    assert.deepEqual(
      afterParentChange && { total: afterParentChange.totalTokens, events: afterParentChange.messageCount },
      { total: 150, events: 6 }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex token stats reuse one parent snapshot across many children", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-codex-token-parent-group-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions", "2026", "07", "20");
  mkdirSync(sessions, { recursive: true });
  const row = (type, payload, seconds = 0) => ({ type, payload, timestamp: recentFixtureTime(seconds) });
  const token = (total, seconds) => row("event_msg", {
    type: "token_count",
    info: { last_token_usage: { input_tokens: total, output_tokens: 0, total_tokens: total } }
  }, seconds);
  const writeRollout = (name, records) => {
    const filePath = path.join(sessions, `${name}.jsonl`);
    writeJsonLines(filePath, records);
    return filePath;
  };

  const parentFile = writeRollout("00-root", [
    row("session_meta", { id: "root" }),
    token(10, 1)
  ]);
  const paddingFd = openSync(parentFile, "a");
  try {
    const padding = Buffer.alloc(64 * 1024, 32);
    padding[padding.length - 1] = 10;
    for (let index = 0; index < 1025; index += 1) writeSync(paddingFd, padding);
  } finally {
    closeSync(paddingFd);
  }
  const childFiles = [];
  for (let index = 0; index < 4; index += 1) {
    childFiles.push(writeRollout(`child-${index}`, [
      row("session_meta", { id: `child-${index}`, parent_thread_id: "root" }),
      token(5, 10 + index)
    ]));
  }

  initConfig(["--codex-dir", root]);
  const openCounts = new Map();
  const originalOpenSync = fs.openSync;
  t.mock.method(fs, "openSync", (...args) => {
    const descriptor = originalOpenSync(...args);
    const filePath = path.resolve(String(args[0]));
    openCounts.set(filePath, (openCounts.get(filePath) || 0) + 1);
    return descriptor;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  const { default: isolatedCodex } = await import("../dist/src/providers/codex/adapter.js?token-parent-group-test");
  const stats = isolatedCodex.getTokenStats(30);
  const day = stats.find((item) => item.day === recentFixtureDay());
  assert.deepEqual(day && { total: day.totalTokens, events: day.messageCount }, { total: 30, events: 5 });

  const opened = (filePath) => openCounts.get(path.resolve(filePath)) || 0;
  assert.ok(opened(parentFile) <= 2, `parent should be read once during token aggregation after initial indexing, got ${opened(parentFile)}`);
  for (const childFile of childFiles) {
    assert.ok(opened(childFile) <= 2, `child should not be reread more than once, got ${opened(childFile)}`);
  }
});

test("Pi file cache preserves active-branch sessions and the last good transcript", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-pi-cache-"));
  try {
    const sessions = path.join(root, "sessions", "--D-WorkSpace-pi-fixture--");
    mkdirSync(sessions, { recursive: true });
    const sessionFile = path.join(sessions, "2026-07-19T01-00-00-000Z_019f7b00-0000-7000-8000-000000000001.jsonl");
    const fixture = recentPiFixture(readFileSync(path.join(process.cwd(), "test", "fixtures", "pi-current.jsonl"), "utf-8"));
    writeFileSync(sessionFile, fixture);
    normalizeMtime(sessionFile);
    initConfig(["--pi-dir", root]);

    const scanned = await collect(pi.scan());
    assert.deepEqual(scanned.map((session) => session.id), ["019f7b00-0000-7000-8000-000000000001"]);
    assert.equal(pi.getSession("019f7b00-0000-7000-8000-000000000001")?.title, "Pi provider fixture");
    assert.equal(pi.searchMessages("Pi provider fixture")[0]?.sessionId, "019f7b00-0000-7000-8000-000000000001");
    assert.equal(pi.getMessages("019f7b00-0000-7000-8000-000000000001").some((message) => message.content.includes("abandoned")), false);
    // Billed session total over ALL recorded entries: output 1+4+3+2=10,
    // cacheRead 0+3+2+1=6 (abandoned oldasst1 line included).
    assert.ok(pi.getTokenStats(30).some((day) => day.outputTokens === 10 && day.cacheReadTokens === 6));
    assert.match(JSON.stringify(pi.getSessionTree("019f7b00-0000-7000-8000-000000000001")), /call_read_1/);
    assert.ok(pi.getSessionMetrics("019f7b00-0000-7000-8000-000000000001")?.totals.steps);
    assert.equal(pi.getSystemPrompts("019f7b00-0000-7000-8000-000000000001")?.mode, "pi-resolved");

    const toolTail = [
      { type: "message", id: "asst-head", parentId: "asst0003", timestamp: recentFixtureTime(10), message: { role: "assistant", content: [{ type: "toolCall", id: "call-head", name: "read", arguments: {} }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } },
      { type: "message", id: "result-head", parentId: "asst-head", timestamp: recentFixtureTime(11), message: { role: "toolResult", toolCallId: "call-head", toolName: "read", content: "ok", isError: false } }
    ];
    const fixtureWithToolTail = `${fixture.trimEnd()}\n${toolTail.map((record) => JSON.stringify(record)).join("\n")}\n`;
    writeFileSync(sessionFile, fixtureWithToolTail);
    await sleep(1050);
    await collect(pi.scan());
    const v2 = pi.getSessionProtocol("019f7b00-0000-7000-8000-000000000001");
    const v3 = pi.getSessionProtocolV3("019f7b00-0000-7000-8000-000000000001");
    assert.equal(v2?.branches?.[0]?.headEventId, "event:call-head");
    assert.equal(v2?.events.some((event) => event.id === "event:call-head"), true);
    assert.equal(v2?.validation?.ok, true);
    assert.equal(v3?.branches?.[0]?.headEventId, "event:call-head");
    assert.equal(v3?.validation?.ok, true);

    writeFileSync(sessionFile, `${fixtureWithToolTail}{"type":"message","id":`);
    await sleep(1050);
    assert.equal(pi.getSession("019f7b00-0000-7000-8000-000000000001")?.title, "Pi provider fixture");

    writeFileSync(sessionFile, fixtureWithToolTail.replace(
      '"name":"Pi provider fixture"',
      '"name":"Pi provider refreshed fixture"'
    ));
    await sleep(1050);
    assert.equal(pi.getSession("019f7b00-0000-7000-8000-000000000001")?.title, "Pi provider refreshed fixture");
    assert.equal(pi.searchMessages("provider is ready")[0]?.sessionId, "019f7b00-0000-7000-8000-000000000001");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
