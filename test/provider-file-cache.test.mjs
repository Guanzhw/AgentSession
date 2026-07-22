import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initConfig } from "../dist/src/config.js";
import { getSessionAnalysisAction } from "../dist/src/analysis.js";
import claudeCode from "../dist/src/providers/claude-code/adapter.js";
import codex from "../dist/src/providers/codex/adapter.js";
import gemini from "../dist/src/providers/gemini/adapter.js";
import pi from "../dist/src/providers/pi/adapter.js";

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
    assert.equal(claudeCode.getTrace("root-canonical")?.summary?.totalSteps, 1);

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

test("Codex file cache exposes shared Agent Loop trace and prompt evidence", async () => {
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
    assert.equal(codex.getTrace("codex-canonical")?.summary?.totalSteps, 1);
    const prompts = codex.getSystemPrompts("codex-canonical");
    assert.equal(prompts?.mode, "codex-resolved");
    assert.match(JSON.stringify(prompts), /codex cached marker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function geminiRecord(marker, output = 5) {
  return {
    sessionId: "gemini-canonical",
    projectHash: "gemini-fixture-project",
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
      },
      {
        id: "gem-info",
        type: "info",
        text: "Gemini provider diagnostic marker",
        timestamp: "2026-07-12T02:00:01.000Z"
      }
    ]
  };
}

test("Gemini file cache skips corrupt files, reuses parsed data, and refreshes changed transcripts", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-gemini-cache-"));
  try {
    const chats = path.join(root, "tmp", "project", "chats");
    const project = path.join(root, "analysis-project");
    const configPath = path.join(root, "agentsession.json");
    mkdirSync(chats, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      analysis: {
        providers: {
          gemini: {
            projectPaths: {
              "gemini-fixture-project": project
            }
          }
        }
      }
    }));
    const sessionFile = path.join(chats, "gemini-alias.json");
    writeFileSync(sessionFile, JSON.stringify(geminiRecord("gemini cached marker")));
    writeFileSync(path.join(chats, "corrupt.json"), "{not-json");
    normalizeMtime(sessionFile);
    initConfig(["--gemini-dir", root, "--config", configPath]);

    const scanned = await collect(gemini.scan());
    assert.deepEqual(scanned.map((session) => session.id), ["gemini-canonical"]);
    assert.equal(gemini.getSession("gemini-alias")?.id, "gemini-canonical");
    assert.equal(gemini.getSession("gemini-canonical")?.directory, realpathSync(project));
    assert.deepEqual(gemini.getSession("gemini-canonical")?.metadata, {
      projectKey: "gemini-fixture-project",
      projectDirectorySource: "configured"
    });

    replaceWithSameSignature(sessionFile);
    await sleep(1050);
    assert.match(gemini.getMessages("gemini-canonical")[0]?.content || "", /gemini cached marker/);
    assert.equal(gemini.searchMessages("gemini cached marker")[0]?.sessionId, "gemini-canonical");
    assert.deepEqual(gemini.searchMessages("Gemini provider diagnostic marker"), []);
    assert.ok(gemini.getTokenStats(30).some((day) => day.outputTokens === 5));
    assert.match(JSON.stringify(gemini.getSessionTree("gemini-canonical")), /gemini cached marker/);
    assert.equal(gemini.getTrace("gemini-canonical")?.summary?.totalSteps, 1);
    assert.equal(gemini.getSystemPrompts("gemini-canonical")?.mode, "gemini-resolved");
    assert.equal(gemini.getRuntimeEnvironment("gemini-canonical")?.sessionId, "gemini-canonical");
    const action = getSessionAnalysisAction(
      gemini,
      "gemini-canonical",
      gemini.getSession("gemini-canonical")?.directory,
      { enabled: true, providers: { gemini: { command: { executable: process.execPath, args: ["--version"] } } } }
    );
    assert.equal(action?.projectPath, realpathSync(project));

    writeFileSync(sessionFile, JSON.stringify(geminiRecord("gemini refreshed marker with a different size", 17)));
    await sleep(1050);
    assert.match(gemini.getMessages("gemini-canonical")[0]?.content || "", /gemini refreshed marker/);
    assert.equal(gemini.searchMessages("gemini refreshed marker")[0]?.sessionId, "gemini-canonical");
    assert.ok(gemini.getTokenStats(30).some((day) => day.outputTokens === 17));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi file cache preserves active-branch sessions and the last good transcript", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-pi-cache-"));
  try {
    const sessions = path.join(root, "sessions", "--D-WorkSpace-pi-fixture--");
    mkdirSync(sessions, { recursive: true });
    const sessionFile = path.join(sessions, "2026-07-19T01-00-00-000Z_019f7b00-0000-7000-8000-000000000001.jsonl");
    const fixture = readFileSync(path.join(process.cwd(), "test", "fixtures", "pi-current.jsonl"), "utf-8");
    writeFileSync(sessionFile, fixture);
    normalizeMtime(sessionFile);
    initConfig(["--pi-dir", root]);

    const scanned = await collect(pi.scan());
    assert.deepEqual(scanned.map((session) => session.id), ["019f7b00-0000-7000-8000-000000000001"]);
    assert.equal(pi.getSession("019f7b00-0000-7000-8000-000000000001")?.title, "Pi provider fixture");
    assert.equal(pi.searchMessages("Pi provider fixture")[0]?.sessionId, "019f7b00-0000-7000-8000-000000000001");
    assert.equal(pi.getMessages("019f7b00-0000-7000-8000-000000000001").some((message) => message.content.includes("abandoned")), false);
    assert.ok(pi.getTokenStats(30).some((day) => day.outputTokens === 9 && day.cacheReadTokens === 6));
    assert.match(JSON.stringify(pi.getSessionTree("019f7b00-0000-7000-8000-000000000001")), /call_read_1/);
    assert.ok(pi.getTrace("019f7b00-0000-7000-8000-000000000001")?.summary?.totalSteps);
    assert.equal(pi.getSystemPrompts("019f7b00-0000-7000-8000-000000000001")?.mode, "pi-resolved");

    writeFileSync(sessionFile, `${fixture}{"type":"message","id":`);
    await sleep(1050);
    assert.equal(pi.getSession("019f7b00-0000-7000-8000-000000000001")?.title, "Pi provider fixture");

    writeFileSync(sessionFile, fixture.replace(
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
