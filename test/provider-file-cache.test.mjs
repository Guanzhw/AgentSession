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
import { DatabaseSync } from "node:sqlite";

import { initConfig } from "../dist/src/config.js";
import { getResumeCommand } from "../dist/src/resume.js";
import claudeCode from "../dist/src/providers/claude-code/adapter.js";
import codex from "../dist/src/providers/codex/adapter.js";
import copilot from "../dist/src/providers/copilot/adapter.js";
import gemini from "../dist/src/providers/gemini/adapter.js";
import pi from "../dist/src/providers/pi/adapter.js";
import openclaw from "../dist/src/providers/openclaw/adapter.js";
import hermes from "../dist/src/providers/hermes/adapter.js";

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

function copilotRecords(marker) {
  return [
    {
      type: "session.start",
      id: "copilot-start",
      timestamp: recentFixtureTime(),
      data: { sessionId: "copilot-canonical", copilotVersion: "1.0.75", contextTier: "default" }
    },
    {
      type: "system.message",
      id: "copilot-system",
      timestamp: recentFixtureTime(1),
      data: { content: "copilot-hidden-system-marker" }
    },
    {
      type: "user.message",
      id: "copilot-user",
      timestamp: recentFixtureTime(2),
      data: { content: marker, transformedContent: "copilot-transformed-marker" }
    },
    {
      type: "assistant.message",
      id: "copilot-parent-tool-turn",
      timestamp: recentFixtureTime(3),
      data: { turnId: "0", content: "I will delegate this check.", model: "fixture-model", outputTokens: 20, reasoningOpaque: "copilot-opaque-reasoning-marker" }
    },
    {
      type: "tool.execution_start",
      id: "copilot-task-start",
      timestamp: recentFixtureTime(4),
      data: {
        turnId: "0",
        toolCallId: "copilot-agent-call",
        toolName: "task",
        arguments: { name: "explore", description: "Inspect the fixture", prompt: "Find the nested marker" }
      }
    },
    {
      type: "subagent.started",
      id: "copilot-agent-start",
      agentId: "copilot-agent-call",
      timestamp: recentFixtureTime(5),
      data: { toolCallId: "copilot-agent-call", agentName: "explore", agentDisplayName: "Explore Agent" }
    },
    {
      type: "system.message",
      id: "copilot-child-system",
      agentId: "copilot-agent-call",
      timestamp: recentFixtureTime(6),
      data: { content: "copilot-child-hidden-system-marker" }
    },
    {
      type: "user.message",
      id: "copilot-child-user",
      agentId: "copilot-agent-call",
      timestamp: recentFixtureTime(7),
      data: { content: "Copilot child visible marker", transformedContent: "copilot-child-transformed-marker" }
    },
    {
      type: "assistant.message",
      id: "copilot-child-assistant",
      agentId: "copilot-agent-call",
      timestamp: recentFixtureTime(8),
      data: { turnId: "0", parentToolCallId: "copilot-agent-call", content: "Child result is ready.", model: "fixture-model", outputTokens: 8, encryptedContent: "copilot-encrypted-marker" }
    },
    {
      type: "subagent.completed",
      id: "copilot-agent-complete",
      agentId: "copilot-agent-call",
      timestamp: recentFixtureTime(9),
      data: { toolCallId: "copilot-agent-call", agentName: "explore", agentDisplayName: "Explore Agent" }
    },
    {
      type: "tool.execution_complete",
      id: "copilot-task-complete",
      timestamp: recentFixtureTime(10),
      data: { turnId: "0", toolCallId: "copilot-agent-call", success: true, result: { content: "Child result is ready.", detailedContent: "copilot-detailed-marker" } }
    },
    {
      type: "assistant.message",
      id: "copilot-parent-final",
      timestamp: recentFixtureTime(11),
      data: { turnId: "1", content: "The parent answer is complete.", model: "fixture-model", outputTokens: 4 }
    }
  ];
}

function createCopilotStore(filePath, project) {
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, branch TEXT,
      summary TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE assistant_usage_events (
      session_id TEXT, turn_index INTEGER, agent_id TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_write_tokens INTEGER, reasoning_tokens INTEGER, created_at TEXT
    );
  `);
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "copilot-canonical", project, "fixture-repository", "main", "Catalog fallback title",
    recentFixtureTime(), recentFixtureTime(11)
  );
  const insert = db.prepare("INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("copilot-canonical", 0, null, 100, 20, 50, 10, 5, recentFixtureTime(3));
  insert.run("copilot-canonical", 0, "copilot-agent-call", 20, 8, 0, 0, 0, recentFixtureTime(8));
  insert.run("copilot-canonical", 1, null, 30, 4, 0, 0, 0, recentFixtureTime(11));
  db.close();
}

test("Copilot CLI embeds inline subagents, reads catalog telemetry, and excludes internal fields", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-copilot-cache-"));
  try {
    const project = path.join(root, "fixture-project");
    const sessionDir = path.join(root, "session-state", "copilot-alias");
    const corruptDir = path.join(root, "session-state", "corrupt");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(corruptDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "AGENTS.md"), "Fixture Copilot instruction");
    const eventsPath = path.join(sessionDir, "events.jsonl");
    writeJsonLines(eventsPath, copilotRecords("Copilot root visible marker"));
    writeFileSync(path.join(corruptDir, "events.jsonl"), "{not-json");
    createCopilotStore(path.join(root, "session-store.db"), project);
    normalizeMtime(eventsPath);
    initConfig(["--copilot-dir", root]);

    const scanned = await collect(copilot.scan());
    assert.deepEqual(scanned.map((session) => session.id), ["copilot-canonical"]);
    assert.equal(copilot.getSession("copilot-alias")?.directory, project);
    assert.equal(copilot.getSession("copilot-canonical")?.tokenCount, 182);
    assert.equal(copilot.getSession("copilot-canonical")?.metadata?.repository, "fixture-repository");

    const rootMessages = copilot.getMessages("copilot-canonical");
    assert.deepEqual(rootMessages.map((message) => message.role), ["user", "assistant", "tool", "tool", "assistant"]);
    assert.equal(rootMessages.some((message) => /copilot-(hidden-system|transformed|opaque|encrypted|detailed)-marker/.test(message.content)), false);
    assert.equal(rootMessages.find((message) => message.role === "assistant")?.tokens?.total, 120);
    assert.equal(copilot.searchMessages("Copilot child visible marker")[0]?.sessionId, "copilot-canonical");
    assert.deepEqual(copilot.searchMessages("copilot-hidden-system-marker"), []);

    const tree = copilot.getSessionTree("copilot-canonical");
    const task = tree.messages.flatMap((message) => message.parts).find((part) => part.tool === "task");
    assert.equal(task?.childSessions.length, 1);
    assert.equal(task?.childSessions[0]?.session?.title, "Explore Agent");
    assert.equal(task?.childSessions[0]?.session?.metadata?.embedded, true);
    assert.equal(tree.detachedChildren.length, 0);
    assert.match(JSON.stringify(tree), /Copilot child visible marker/);
    assert.doesNotMatch(JSON.stringify(tree), /copilot-(hidden-system|transformed|opaque|encrypted|detailed)-marker/);
    assert.equal(copilot.getTrace("copilot-canonical")?.summary?.totalSteps, 2);
    assert.equal(copilot.getSystemPrompts("copilot-canonical")?.mode, "copilot-resolved");
    assert.match(JSON.stringify(copilot.getRuntimeEnvironment("copilot-canonical")), /AGENTS\.md/);
    const day = copilot.getTokenStats(30).find((item) => item.day === recentFixtureDay());
    assert.deepEqual(day && {
      input: day.inputTokens,
      output: day.outputTokens,
      reasoning: day.reasoningTokens,
      cacheRead: day.cacheReadTokens,
      cacheWrite: day.cacheWriteTokens,
      total: day.totalTokens,
      messages: day.messageCount
    }, {
      input: 90,
      output: 27,
      reasoning: 5,
      cacheRead: 50,
      cacheWrite: 10,
      total: 182,
      messages: 3
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function geminiRecord(marker, output = 5) {
  return {
    sessionId: "gemini-canonical",
    projectHash: "gemini-fixture-project",
    startTime: recentFixtureTime(),
    lastUpdated: recentFixtureTime(1),
    messages: [
      { id: "gem-user", type: "user", text: marker, timestamp: recentFixtureTime() },
      {
        id: "gem-assistant",
        type: "gemini",
        text: `${marker} reply`,
        timestamp: recentFixtureTime(1),
        tokenUsage: { input: 2, output, total: output + 2, thoughts: 1, cached: 1 }
      },
      {
        id: "gem-info",
        type: "info",
        text: "Gemini provider diagnostic marker",
        timestamp: recentFixtureTime(1)
      }
    ]
  };
}

test("Gemini file cache skips corrupt files, reuses parsed data, and refreshes changed transcripts", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-gemini-cache-"));
  try {
    const chats = path.join(root, "tmp", "project", "chats");
    const project = path.join(root, "fixture-project");
    const configPath = path.join(root, "agentsession.json");
    mkdirSync(chats, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      projectPaths: {
        gemini: {
          "gemini-fixture-project": project
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
    assert.equal(gemini.lifecycle, "legacy");
    assert.equal(gemini.resumeCommand, undefined);

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
    const fixture = recentPiFixture(readFileSync(path.join(process.cwd(), "test", "fixtures", "pi-current.jsonl"), "utf-8"));
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

test("OpenClaw file cache preserves the active branch, tools, usage, and runtime evidence", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsession-openclaw-cache-"));
  try {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    const childSessionsDir = path.join(root, "agents", "worker", "sessions");
    const workspace = path.join(root, "workspace");
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(childSessionsDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "AGENTS.md"), "# OpenClaw instructions\n");
    const sessionId = "openclaw-fixture";
    const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);
    const records = [
      { type: "session", version: 2, id: sessionId, timestamp: recentFixtureTime(), cwd: workspace },
      { type: "message", id: "u1", parentId: null, timestamp: recentFixtureTime(), message: { role: "user", content: "OpenClaw marker" } },
      { type: "message", id: "a-abandoned", parentId: "u1", timestamp: recentFixtureTime(1), message: { role: "assistant", content: [{ type: "text", text: "abandoned" }] } },
      { type: "message", id: "a1", parentId: "u1", timestamp: recentFixtureTime(2), message: { role: "assistant", model: "deepseek-v4-flash", provider: "deepseek", content: [{ type: "thinking", thinking: "inspect" }, { type: "toolCall", id: "call1", name: "read", arguments: { path: "package.json" } }], usage: { input: 15, output: 10, reasoningTokens: 3, cacheRead: 5, totalTokens: 30 } } },
      { type: "message", id: "r1", parentId: "a1", timestamp: recentFixtureTime(3), message: { role: "toolResult", toolCallId: "call1", toolName: "read", content: [{ type: "text", text: "fixture output" }], isError: false } },
      { type: "message", id: "a2", parentId: "r1", timestamp: recentFixtureTime(4), message: { role: "assistant", content: [{ type: "text", text: "OpenClaw ready" }] } }
    ];
    writeJsonLines(filePath, records);
    writeFileSync(path.join(sessionsDir, "sessions.json"), JSON.stringify({ "agent:main:fixture": { sessionId, displayName: "OpenClaw cached fixture", updatedAt: Date.parse(recentFixtureTime(4)) } }));
    writeJsonLines(path.join(childSessionsDir, "openclaw-child.jsonl"), [
      { type: "session", version: 2, id: "openclaw-child", timestamp: recentFixtureTime(5), cwd: workspace },
      { type: "message", id: "cu1", parentId: null, timestamp: recentFixtureTime(5), message: { role: "user", content: "child task" } },
      { type: "message", id: "ca1", parentId: "cu1", timestamp: recentFixtureTime(6), message: { role: "assistant", content: [{ type: "text", text: "child result" }] } }
    ]);
    writeFileSync(path.join(childSessionsDir, "sessions.json"), JSON.stringify({ "agent:worker:fixture": { sessionId: "openclaw-child", spawnedBy: "agent:main:fixture" } }));
    initConfig(["--openclaw-dir", root]);

    assert.equal((await collect(openclaw.scan()))[0]?.title, "OpenClaw cached fixture");
    assert.equal(openclaw.getMessages(sessionId).some(message => message.content === "abandoned"), false);
    assert.equal(openclaw.getMessages(sessionId).find(message => message.id === "call1")?.toolOutput, "fixture output");
    assert.equal(openclaw.getSession("openclaw-child")?.parentId, sessionId);
    assert.match(JSON.stringify(openclaw.getSessionTree(sessionId)), /openclaw-child/);
    assert.deepEqual(
      getResumeCommand(openclaw, sessionId, workspace, {}).args.slice(-2),
      ["--session", "agent:main:fixture"]
    );
    assert.ok(openclaw.getTokenStats(30).some(day => day.totalTokens === 30 && day.reasoningTokens === 3));
    assert.ok(openclaw.getRuntimeEnvironment(sessionId)?.extensions.some(entry => entry.name === "AGENTS.md"));
    assert.equal(openclaw.getSystemPrompts(sessionId)?.mode, "openclaw-resolved");

    writeFileSync(path.join(sessionsDir, "sessions.json"), JSON.stringify({ "agent:main:fixture": { sessionId, displayName: "OpenClaw refreshed registry title", updatedAt: Date.parse(recentFixtureTime(5)) } }));
    await sleep(1050);
    assert.equal(openclaw.getSession(sessionId)?.title, "OpenClaw refreshed registry title");

    writeFileSync(filePath, `${readFileSync(filePath, "utf8")}{"type":"message","id":`);
    await sleep(1050);
    assert.equal(openclaw.getSession(sessionId)?.title, "OpenClaw refreshed registry title");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes snapshot store reads SQLite once per revision and separates delegation from compression", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsession-hermes-cache-"));
  try {
    const dbPath = path.join(root, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, source TEXT, model TEXT, model_config TEXT, system_prompt TEXT,
        parent_session_id TEXT, started_at REAL, ended_at REAL, end_reason TEXT, title TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
        cache_write_tokens INTEGER, reasoning_tokens INTEGER, cwd TEXT, billing_provider TEXT,
        archived INTEGER DEFAULT 0
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT,
        tool_calls TEXT, tool_name TEXT, effect_disposition TEXT, timestamp REAL,
        finish_reason TEXT, reasoning TEXT, reasoning_content TEXT, reasoning_details TEXT,
        platform_message_id TEXT, active INTEGER DEFAULT 1
      );
    `);
    const started = Math.floor(recentFixtureEpoch / 1000);
    // Real Hermes transitions: compression rotation ends the live session with
    // end_reason='compression' and creates a continuation whose
    // parent_session_id points back at it. The root chain compresses twice
    // (root -> root continuation -> chained root continuation); the delegate
    // compresses once (delegate -> delegate continuation). Timestamps are
    // monotonic: each continuation starts after its parent ended.
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "hermes-root", "cli", "deepseek-v4-flash", "{}", "Stored Hermes prompt", null,
      started, started + 5.5, "compression", "Hermes fixture", 40, 15, 10, 0, 5, root, "deepseek", 0
    );
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "hermes-compression", "cli", "deepseek-v4-flash", "{}", null, "hermes-root",
      started + 6, started + 7, "compression", null, 0, 0, 0, 0, 0, root, "deepseek", 0
    );
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "hermes-delegate", "delegate", "deepseek-v4-flash", JSON.stringify({ _delegate_from: "hermes-root" }), null, "hermes-root",
      started + 8, started + 9, "compression", null, 0, 0, 0, 0, 0, root, "deepseek", 0
    );
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "hermes-delegate-compression", "delegate", "deepseek-v4-flash", JSON.stringify({ _delegate_from: "hermes-root" }), null, "hermes-delegate",
      started + 10, started + 11, "stop", null, 0, 0, 0, 0, 0, root, "deepseek", 0
    );
    // Chained compression: the second continuation points at the first
    // segment, which itself continues the root session.
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "hermes-compression-2", "cli", "deepseek-v4-flash", "{}", null, "hermes-compression",
      started + 7.5, started + 8, "branched", null, 0, 0, 0, 0, 0, root, "deepseek", 0
    );
    // Non-compression branch: the parent row exists but ended with
    // end_reason='branched' (Hermes marks the origin of a /branch that way), so
    // this child is a branch, not a compression continuation.
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "hermes-branch-child", "cli", "deepseek-v4-flash", "{}", null, "hermes-compression-2",
      started + 9.5, started + 10, "stop", null, 0, 0, 0, 0, 0, root, "deepseek", 0
    );
    // Malformed lineage: the compression parent row is missing entirely.
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "hermes-orphan-compression", "cli", "deepseek-v4-flash", "{}", null, "hermes-missing",
      started + 12, started + 13, "stop", null, 0, 0, 0, 0, 0, root, "deepseek", 0
    );
    // Valid-looking self-cycle: the edge satisfies the classification rule
    // (the row exists and ends with compression), so traversal guards must
    // keep the session's own messages canonical without manufacturing a base.
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "hermes-self-cycle", "cli", "deepseek-v4-flash", "{}", null, "hermes-self-cycle",
      started + 13.5, started + 14, "compression", null, 0, 0, 0, 0, 0, root, "deepseek", 0
    );
    const insert = db.prepare("INSERT INTO messages (session_id, role, content, tool_calls, timestamp, finish_reason, reasoning, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)");
    insert.run("hermes-root", "user", "Hermes marker", null, started, null, null);
    insert.run("hermes-root", "assistant", "", JSON.stringify([{ id: "hcall", function: { name: "read_file", arguments: JSON.stringify({ path: "package.json" }) } }]), started + 1, "tool_calls", "inspect");
    db.prepare("INSERT INTO messages (session_id, role, content, tool_call_id, tool_name, timestamp, active) VALUES (?, 'tool', ?, ?, ?, ?, 1)").run("hermes-root", "Hermes tool output", "hcall", "read_file", started + 2);
    insert.run("hermes-root", "assistant", "Hermes ready", null, started + 3, "stop", null);
    // Delegate_task call whose tool output deliberately omits the child
    // session id: the source keeps no exact spawn reference, so the viewer
    // must attach by creation order and flag the link as inferred.
    insert.run("hermes-root", "assistant", "", JSON.stringify([{ id: "hdelegate", function: { name: "delegate_task", arguments: JSON.stringify({ task: "Summarize the workspace" }) } }]), started + 4, "tool_calls", null);
    db.prepare("INSERT INTO messages (session_id, role, content, tool_call_id, tool_name, timestamp, active) VALUES (?, 'tool', ?, ?, ?, ?, 1)").run("hermes-root", JSON.stringify({ task: "Summarize the workspace", status: "ok" }), "hdelegate", "delegate_task", started + 5);
    // Hermes stores whitespace-only reasoning_content for tool-call turns that
    // carried no visible reasoning; it must not render an empty Reasoning part.
    insert.run("hermes-root", "assistant", "Whitespace reasoning turn", null, started + 5.5, "stop", " ");
    insert.run("hermes-delegate", "user", "Delegate request", null, started + 8, null, null);
    insert.run("hermes-delegate", "assistant", "Delegate response text", null, started + 9, "stop", "  Deliberate: check the docs  ");
    // Compression segments carry real conversation state: the continuation
    // of the delegate (and of the root) must merge into its logical base.
    insert.run("hermes-compression", "user", "Root compression question", null, started + 6.2, null, null);
    insert.run("hermes-compression", "assistant", "Root compression reply", null, started + 6.8, "stop", "Root continuation deliberation");
    insert.run("hermes-compression-2", "user", "Root compression round two", null, started + 7.6, null, null);
    insert.run("hermes-compression-2", "assistant", "Root compression round two reply", null, started + 7.7, "stop", null);
    insert.run("hermes-branch-child", "user", "Branch question", null, started + 9.6, null, null);
    insert.run("hermes-branch-child", "assistant", "Branch reply", null, started + 9.8, "stop", null);
    insert.run("hermes-delegate-compression", "user", "Compressed delegate question", null, started + 10, null, null);
    insert.run("hermes-delegate-compression", "assistant", "Compressed delegate reply", null, started + 11, "stop", "  Continuation: verify  ");
    insert.run("hermes-orphan-compression", "user", "Orphan question", null, started + 12, null, null);
    insert.run("hermes-orphan-compression", "assistant", "Orphan reply", null, started + 13, "stop", null);
    insert.run("hermes-self-cycle", "user", "Self cycle question", null, started + 13.6, null, null);
    insert.run("hermes-self-cycle", "assistant", "Self cycle reply", null, started + 13.7, "stop", null);
    db.close();
    writeFileSync(path.join(root, "SOUL.md"), "# Hermes instructions\n");
    initConfig(["--hermes-dir", root]);

    const scanned = await collect(hermes.scan());
    // Every public scanned session exposes only validated compression lineage:
    // each compressionParentId is a string referencing an existing parent row
    // whose end_reason is 'compression'. Invalid candidates were normalized
    // to null when the store snapshot was built.
    for (const session of scanned) {
      const compressionParentId = session.metadata?.compressionParentId;
      if (compressionParentId == null) continue;
      assert.equal(typeof compressionParentId, "string");
      const parent = scanned.find(candidate => candidate.id === compressionParentId);
      assert.ok(parent, `compression parent ${compressionParentId} exists`);
      assert.equal(parent.metadata?.endReason, "compression");
    }
    assert.equal(scanned.find(session => session.id === "hermes-compression")?.parentId, null);
    assert.equal(scanned.find(session => session.id === "hermes-compression")?.metadata?.compressionParentId, "hermes-root");
    assert.equal(scanned.find(session => session.id === "hermes-delegate")?.parentId, "hermes-root");
    assert.equal(scanned.find(session => session.id === "hermes-delegate-compression")?.parentId, "hermes-root");
    assert.equal(scanned.find(session => session.id === "hermes-delegate-compression")?.metadata?.compressionParentId, "hermes-delegate");
    // A chained compression segment points at the previous segment, never at
    // the delegate; the canonical parentId stays the delegate spawn parent.
    assert.equal(scanned.find(session => session.id === "hermes-compression-2")?.parentId, null);
    assert.equal(scanned.find(session => session.id === "hermes-compression-2")?.metadata?.compressionParentId, "hermes-compression");
    // Malformed lineage: the compression parent row is missing, so the raw id
    // candidate is normalized to null and the session stays standalone.
    assert.equal(scanned.find(session => session.id === "hermes-orphan-compression")?.parentId, null);
    assert.equal(scanned.find(session => session.id === "hermes-orphan-compression")?.metadata?.compressionParentId, null);
    // Non-compression branch: the parent row exists but ended with
    // end_reason='branched', so the child is not compression lineage and
    // remains independently canonical.
    assert.equal(scanned.find(session => session.id === "hermes-branch-child")?.parentId, null);
    assert.equal(scanned.find(session => session.id === "hermes-branch-child")?.metadata?.compressionParentId, null);
    // A self-referencing edge passes the classification rule (the row exists
    // and ends with compression); traversal guards keep it canonical.
    assert.equal(scanned.find(session => session.id === "hermes-self-cycle")?.metadata?.compressionParentId, "hermes-self-cycle");
    assert.equal(hermes.getMessages("hermes-root").find(message => message.id === "hcall")?.toolOutput, "Hermes tool output");
    assert.ok(hermes.getTokenStats(30).some(day => day.totalTokens === 65 && day.reasoningTokens === 5));
    assert.equal(hermes.getSystemPrompts("hermes-root")?.hiddenPromptStored, true);
    assert.match(JSON.stringify(hermes.getSystemPrompts("hermes-root")), /Stored Hermes prompt/);
    assert.ok(hermes.getRuntimeEnvironment("hermes-root")?.extensions.some(entry => entry.name === "SOUL.md"));
    // Whitespace-only reasoning is treated as absent: no thinking on the
    // normalized message and no reasoning part in the tree, while the real
    // "inspect" reasoning on the read_file turn stays byte-for-byte.
    const rootMessages = hermes.getMessages("hermes-root");
    assert.equal(rootMessages.find(message => message.content === "Whitespace reasoning turn")?.thinking, null);
    const rootTree = hermes.getSessionTree("hermes-root");
    const rootReasoningParts = rootTree.messages.flatMap(message => message.parts).filter(part => part.type === "reasoning");
    // Root reasoning plus the reasoning carried by the root compression
    // continuation, merged chronologically into the logical base session.
    assert.equal(rootReasoningParts.length, 2);
    assert.equal(rootReasoningParts[0].data.text, "inspect");
    assert.ok(rootReasoningParts.some(part => part.data.text === "Root continuation deliberation"));
    // Compression content and chained-segment content merge into the base
    // session; nothing is dropped or detached. Merged assistant text stays in
    // chronological order across segments: root turns, then the first
    // continuation's reply, then the chained continuation's reply.
    assert.ok(rootTree.messages.some(message => message.parts.some(part => part.type === "text" && part.data.text === "Root compression reply")));
    assert.ok(rootTree.messages.some(message => message.parts.some(part => part.type === "text" && part.data.text === "Root compression round two reply")));
    assert.deepEqual(
      rootTree.messages
        .filter(message => message.role === "assistant" && message.parts.some(part => part.type === "text"))
        .map(message => message.parts.find(part => part.type === "text")?.data.text),
      ["Hermes ready", "Whitespace reasoning turn", "Root compression reply", "Root compression round two reply"]
    );
    // The delegate child keeps its real reasoning and content byte-for-byte
    // (including the surrounding whitespace Hermes stores with the text).
    const delegateAssistant = hermes.getMessages("hermes-delegate").find(message => message.role === "assistant");
    assert.equal(delegateAssistant?.thinking, "  Deliberate: check the docs  ");
    assert.equal(delegateAssistant?.content, "Delegate response text");
    // The delegate child attaches beneath the delegate_task tool. The tool
    // output carries no exact child session id, so the attachment is inferred
    // and flagged truthfully instead of claiming an explicit source link.
    const delegatePart = rootTree.messages
      .flatMap(message => message.parts)
      .find(part => part.type === "tool" && part.tool === "delegate_task");
    assert.ok(delegatePart, "delegate_task tool part exists");
    // One spawn per part: the delegate child attaches beneath the delegate
    // tool; the compression segments are lineage, not spawns, so they merge
    // into their logical base and nothing stays detached.
    assert.deepEqual(
      delegatePart.childSessions.map(child => child.session.id),
      ["hermes-delegate"]
    );
    assert.ok(delegatePart.inferredChildSessionIds.has("hermes-delegate"));
    assert.deepEqual(
      rootTree.detachedChildren.map(child => child.session.id),
      []
    );
    const delegateChild = delegatePart.childSessions.find(child => child.session.id === "hermes-delegate");
    const delegateChildAssistant = delegateChild.messages.find(message => message.role === "assistant" && message.parts.some(part => part.type === "text" && part.data.text === "Delegate response text"));
    assert.equal(delegateChildAssistant.parts.find(part => part.type === "reasoning")?.data.text, "  Deliberate: check the docs  ");
    assert.equal(delegateChildAssistant.parts.find(part => part.type === "text")?.data.text, "Delegate response text");
    // The delegate compression continuation merges into the delegate tree
    // after the original messages, preserving content and reasoning.
    assert.ok(delegateChild.messages.some(message => message.role === "user" && message.parts.some(part => part.type === "text" && part.data.text === "Compressed delegate question")));
    assert.deepEqual(
      delegateChild.messages
        .filter(message => message.role === "assistant")
        .map(message => message.parts.find(part => part.type === "text")?.data.text),
      ["Delegate response text", "Compressed delegate reply"]
    );
    const compressionDelegateTurn = delegateChild.messages.find(message => message.role === "assistant" && message.parts.some(part => part.type === "text" && part.data.text === "Compressed delegate reply"));
    assert.equal(compressionDelegateTurn.parts.find(part => part.type === "reasoning")?.data.text, "  Continuation: verify  ");
    // Subagent metrics cover exactly one subagent: the delegate. The
    // compression lineage is one logical session, so it counts no branch and
    // leaves nothing detached.
    assert.equal(rootTree.metrics.descendantCount, 1);
    assert.equal(rootTree.metrics.totalMessages, 13);
    assert.equal(hermes.getSessionMetrics("hermes-root")?.totals.branches, 1);
    assert.match(JSON.stringify(hermes.getSessionTree("hermes-root")), /hermes-delegate/);
    // Canonical per-segment access stays intact: raw sessions, messages, and
    // exports remain individually queryable, and the merged lineage view did
    // not mutate store entries.
    assert.equal(hermes.getSession("hermes-root")?.messageCount, 7);
    assert.equal(hermes.getSession("hermes-delegate")?.messageCount, 2);
    assert.equal(hermes.getSession("hermes-delegate-compression")?.messageCount, 2);
    assert.equal(hermes.getSession("hermes-compression")?.messageCount, 2);
    assert.equal(hermes.getSession("hermes-compression-2")?.messageCount, 2);
    assert.equal(hermes.getMessages("hermes-delegate-compression").find(message => message.content === "Compressed delegate reply")?.thinking, "  Continuation: verify  ");
    assert.equal(hermes.getMessages("hermes-compression").find(message => message.content === "Root compression reply")?.thinking, "Root continuation deliberation");
    const exportedSegment = hermes.exportSession("hermes-delegate-compression");
    assert.equal(exportedSegment?.session.id, "hermes-delegate-compression");
    assert.equal(exportedSegment?.messages.length, 2);
    // Asking for a compression segment resolves backward to its logical base
    // and returns the merged lineage view rooted at that base.
    const segmentTree = hermes.getSessionTree("hermes-delegate-compression");
    assert.equal(segmentTree.session.id, "hermes-delegate");
    assert.ok(segmentTree.messages.some(message => message.parts.some(part => part.type === "text" && part.data.text === "Delegate response text")));
    assert.ok(segmentTree.messages.some(message => message.parts.some(part => part.type === "text" && part.data.text === "Compressed delegate reply")));
    const rootCompressionTree = hermes.getSessionTree("hermes-compression");
    assert.equal(rootCompressionTree.session.id, "hermes-root");
    // Malformed lineage (missing compression parent): the bundle is preserved
    // rather than silently dropped, and its own lineage view keeps its
    // messages.
    assert.equal(hermes.getSession("hermes-orphan-compression")?.messageCount, 2);
    const orphanTree = hermes.getSessionTree("hermes-orphan-compression");
    assert.equal(orphanTree.session.id, "hermes-orphan-compression");
    assert.ok(orphanTree.messages.some(message => message.parts.some(part => part.type === "text" && part.data.text === "Orphan reply")));
    // Non-compression branch child: not merged as compression, not attached to
    // the root lineage, and independently canonical with its own messages.
    assert.equal(hermes.getSession("hermes-branch-child")?.messageCount, 2);
    const branchTree = hermes.getSessionTree("hermes-branch-child");
    assert.equal(branchTree.session.id, "hermes-branch-child");
    assert.ok(branchTree.messages.some(message => message.parts.some(part => part.type === "text" && part.data.text === "Branch reply")));
    assert.ok(!rootTree.messages.some(message => message.parts.some(part => part.type === "text" && part.data.text === "Branch reply")));
    // Valid-looking self-cycle: traversal guards keep the requested session's
    // own messages canonical instead of manufacturing a wrong base.
    assert.equal(hermes.getSession("hermes-self-cycle")?.messageCount, 2);
    const selfCycleTree = hermes.getSessionTree("hermes-self-cycle");
    assert.equal(selfCycleTree.session.id, "hermes-self-cycle");
    assert.ok(selfCycleTree.messages.some(message => message.parts.some(part => part.type === "text" && part.data.text === "Self cycle reply")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
