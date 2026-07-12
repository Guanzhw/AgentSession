import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initConfig } from "../dist/src/config.js";
import claudeCode from "../dist/src/providers/claude-code/adapter.js";
import gemini from "../dist/src/providers/gemini/adapter.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function claudeRecords({ sessionId, marker, outputTokens = 7, sidechain = null }) {
  const timestamp = "2026-07-12T01:00:00.000Z";
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
      timestamp: "2026-07-12T01:00:01.000Z",
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

function geminiRecord(marker, output = 5) {
  return {
    sessionId: "gemini-canonical",
    startTime: "2026-07-12T02:00:00.000Z",
    lastUpdated: "2026-07-12T02:00:01.000Z",
    messages: [
      { id: "gem-user", type: "user", text: marker, timestamp: "2026-07-12T02:00:00.000Z" },
      {
        id: "gem-assistant",
        type: "gemini",
        text: `${marker} reply`,
        timestamp: "2026-07-12T02:00:01.000Z",
        tokenUsage: { input: 2, output, total: output + 2, thoughts: 1, cached: 1 }
      }
    ]
  };
}

test("Gemini file cache skips corrupt files, reuses parsed data, and refreshes changed transcripts", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-gemini-cache-"));
  try {
    const chats = path.join(root, "tmp", "project", "chats");
    mkdirSync(chats, { recursive: true });
    const sessionFile = path.join(chats, "gemini-alias.json");
    writeFileSync(sessionFile, JSON.stringify(geminiRecord("gemini cached marker")));
    writeFileSync(path.join(chats, "corrupt.json"), "{not-json");
    normalizeMtime(sessionFile);
    initConfig(["--gemini-dir", root]);

    const scanned = await collect(gemini.scan());
    assert.deepEqual(scanned.map((session) => session.id), ["gemini-canonical"]);
    assert.equal(gemini.getSession("gemini-alias")?.id, "gemini-canonical");

    replaceWithSameSignature(sessionFile);
    await sleep(1050);
    assert.match(gemini.getMessages("gemini-canonical")[0]?.content || "", /gemini cached marker/);
    assert.equal(gemini.searchMessages("gemini cached marker")[0]?.sessionId, "gemini-canonical");
    assert.ok(gemini.getTokenStats(30).some((day) => day.outputTokens === 5));
    assert.match(JSON.stringify(gemini.getSessionTree("gemini-canonical")), /gemini cached marker/);

    writeFileSync(sessionFile, JSON.stringify(geminiRecord("gemini refreshed marker with a different size", 17)));
    await sleep(1050);
    assert.match(gemini.getMessages("gemini-canonical")[0]?.content || "", /gemini refreshed marker/);
    assert.equal(gemini.searchMessages("gemini refreshed marker")[0]?.sessionId, "gemini-canonical");
    assert.ok(gemini.getTokenStats(30).some((day) => day.outputTokens === 17));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
