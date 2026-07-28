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
import { getSessionAnalysisAction } from "../dist/src/analysis.js";
import claudeCode from "../dist/src/providers/claude-code/adapter.js";
import codex from "../dist/src/providers/codex/adapter.js";
import copilot from "../dist/src/providers/copilot/adapter.js";
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
      { timestamp: "2026-07-20T00:00:00.000Z", type: "session_meta", payload: { id: "parent" } },
      token("2026-07-20T00:00:01.000Z", 10),
      token("2026-07-20T00:00:02.000Z", 20),
      token("2026-07-20T00:00:03.000Z", 30)
    ];
    const child = [
      { timestamp: "2026-07-20T01:00:00.000Z", type: "session_meta", payload: { id: "child", parent_thread_id: "parent" } },
      token("2026-07-20T01:00:01.000Z", 20),
      token("2026-07-20T01:00:02.000Z", 30),
      { timestamp: "2026-07-20T01:00:03.000Z", type: "event_msg", payload: { type: "agent_message", message: "child-owned output" } },
      token("2026-07-20T01:00:04.000Z", 40)
    ];
    const parentFile = path.join(sessions, "rollout-parent.jsonl");
    writeJsonLines(parentFile, parent);
    writeJsonLines(path.join(sessions, "rollout-child.jsonl"), child);
    initConfig(["--codex-dir", root]);
    await sleep(1050);

    assert.equal(codex.getSession("child")?.tokenCount, 40);
    const day = codex.getTokenStats(30).find((item) => item.day === "2026-07-20");
    assert.deepEqual(day && { total: day.totalTokens, events: day.messageCount }, { total: 100, events: 4 });

    // Parent changes affect the child's ownership decision. Keep the parent
    // total unchanged while breaking the copied sequence to prove that the
    // composite parent signature invalidates the child's cached daily bucket.
    writeJsonLines(parentFile, [parent[0], parent[1], parent[3], parent[2]]);
    await sleep(1050);
    const afterParentChange = codex.getTokenStats(30).find((item) => item.day === "2026-07-20");
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
      timestamp: "2026-07-26T16:30:00.000Z",
      data: { sessionId: "copilot-canonical", copilotVersion: "1.0.75", contextTier: "default" }
    },
    {
      type: "system.message",
      id: "copilot-system",
      timestamp: "2026-07-26T16:30:01.000Z",
      data: { content: "copilot-hidden-system-marker" }
    },
    {
      type: "user.message",
      id: "copilot-user",
      timestamp: "2026-07-26T16:30:02.000Z",
      data: { content: marker, transformedContent: "copilot-transformed-marker" }
    },
    {
      type: "assistant.message",
      id: "copilot-parent-tool-turn",
      timestamp: "2026-07-26T16:30:03.000Z",
      data: { turnId: "0", content: "I will delegate this check.", model: "fixture-model", outputTokens: 20, reasoningOpaque: "copilot-opaque-reasoning-marker" }
    },
    {
      type: "tool.execution_start",
      id: "copilot-task-start",
      timestamp: "2026-07-26T16:30:04.000Z",
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
      timestamp: "2026-07-26T16:30:05.000Z",
      data: { toolCallId: "copilot-agent-call", agentName: "explore", agentDisplayName: "Explore Agent" }
    },
    {
      type: "system.message",
      id: "copilot-child-system",
      agentId: "copilot-agent-call",
      timestamp: "2026-07-26T16:30:06.000Z",
      data: { content: "copilot-child-hidden-system-marker" }
    },
    {
      type: "user.message",
      id: "copilot-child-user",
      agentId: "copilot-agent-call",
      timestamp: "2026-07-26T16:30:07.000Z",
      data: { content: "Copilot child visible marker", transformedContent: "copilot-child-transformed-marker" }
    },
    {
      type: "assistant.message",
      id: "copilot-child-assistant",
      agentId: "copilot-agent-call",
      timestamp: "2026-07-26T16:30:08.000Z",
      data: { turnId: "0", parentToolCallId: "copilot-agent-call", content: "Child result is ready.", model: "fixture-model", outputTokens: 8, encryptedContent: "copilot-encrypted-marker" }
    },
    {
      type: "subagent.completed",
      id: "copilot-agent-complete",
      agentId: "copilot-agent-call",
      timestamp: "2026-07-26T16:30:09.000Z",
      data: { toolCallId: "copilot-agent-call", agentName: "explore", agentDisplayName: "Explore Agent" }
    },
    {
      type: "tool.execution_complete",
      id: "copilot-task-complete",
      timestamp: "2026-07-26T16:30:10.000Z",
      data: { turnId: "0", toolCallId: "copilot-agent-call", success: true, result: { content: "Child result is ready.", detailedContent: "copilot-detailed-marker" } }
    },
    {
      type: "assistant.message",
      id: "copilot-parent-final",
      timestamp: "2026-07-26T16:30:11.000Z",
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
    "2026-07-26T16:30:00.000Z", "2026-07-26T16:30:11.000Z"
  );
  const insert = db.prepare("INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("copilot-canonical", 0, null, 100, 20, 50, 10, 5, "2026-07-26T16:30:03.000Z");
  insert.run("copilot-canonical", 0, "copilot-agent-call", 20, 8, 0, 0, 0, "2026-07-26T16:30:08.000Z");
  insert.run("copilot-canonical", 1, null, 30, 4, 0, 0, 0, "2026-07-26T16:30:11.000Z");
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
    assert.equal(copilot.getSessionFlow("copilot-canonical")?.summary?.subagents, 1);
    assert.equal(copilot.getTrace("copilot-canonical")?.summary?.totalSteps, 2);
    assert.equal(copilot.getSystemPrompts("copilot-canonical")?.mode, "copilot-resolved");
    assert.match(JSON.stringify(copilot.getRuntimeEnvironment("copilot-canonical")), /AGENTS\.md/);
    const day = copilot.getTokenStats(30).find((item) => item.day === "2026-07-26");
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
    assert.equal(gemini.lifecycle, "legacy");
    assert.equal(gemini.resumeCommand, undefined);
    assert.equal(action, null);

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
