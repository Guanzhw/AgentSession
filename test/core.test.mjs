import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { closeDb, getTokenStats } from "../dist/src/db.js";
import { buildCodeAgentSessionTree } from "../dist/src/providers/codeagent/session-tree.js";
import { enrichCodeAgentSession } from "../dist/src/providers/codeagent/schema.js";
import { buildOpenCodeSessionTree } from "../dist/src/providers/opencode/session-tree.js";
import {
  extractSessionMeta,
  parseTranscript,
  recordsToMessages
} from "../dist/src/providers/claude-code/parser.js";
import { getResumeCommand, resolveProjectDirectory } from "../dist/src/resume.js";
import { parseArgs } from "../dist/src/config.js";

const fixture = (name) => path.join(process.cwd(), "test", "fixtures", name);

test("Claude current transcripts preserve tools, thinking, titles, and cache tokens", () => {
  const records = parseTranscript(fixture("claude-current.jsonl"));
  const meta = extractSessionMeta(records, "session-current");
  const messages = recordsToMessages(records, "session-current");

  assert.equal(meta.title, "Inspect the current Claude transcript");
  assert.equal(meta.directory, "D:\\WorkSpace\\OpenSession");
  assert.equal(meta.tokenCount, 44);
  assert.equal(messages.find((message) => message.toolName === "Read")?.thinking, "I should inspect the files.");
  assert.equal(messages.find((message) => message.metadata?.toolUseId === "tool-1")?.content, "OpenSessionViewer");
  assert.deepEqual(messages.find((message) => message.toolName === "Read")?.tokens, {
    input: 10,
    output: 5,
    reasoning: 0,
    cache: { read: 20, write: 3 },
    total: 38
  });
});

test("Claude legacy transcripts derive a useful title", () => {
  const records = parseTranscript(fixture("claude-legacy.jsonl"));
  const meta = extractSessionMeta(records, "legacy");
  assert.equal(meta.title, "Legacy first prompt");
  assert.equal(meta.tokenCount, 3);
});

test("OpenCode token stats include child sessions exactly once", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-token-"));
  const dbPath = path.join(temp, "sessions.db");
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        time_archived INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        data TEXT
      );
    `);
    db.prepare("INSERT INTO session (id, parent_id, time_archived) VALUES (?, ?, NULL)").run("root", null);
    db.prepare("INSERT INTO session (id, parent_id, time_archived) VALUES (?, ?, NULL)").run("child", "root");
    const created = Date.now() - 1000;
    const insert = db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)");
    insert.run("m1", "root", JSON.stringify({
      role: "assistant",
      time: { created },
      tokens: { input: 2, output: 1, reasoning: 1, cache: { read: 3, write: 0 }, total: 7 }
    }));
    insert.run("m2", "child", JSON.stringify({
      role: "assistant",
      time: { created },
      tokens: { input: 4, output: 2, reasoning: 0, cache: { read: 5, write: 1 }, total: 12 }
    }));
    db.close();

    const rows = getTokenStats(30, dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total_tokens, 19);
    assert.equal(rows[0].cache_read_tokens, 8);
    assert.equal(rows[0].cache_write_tokens, 1);
  } finally {
    closeDb(dbPath);
  }
});

test("CodeAgent and OpenCode use provider-owned session metric readers", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-provider-metrics-"));
  const dbPath = path.join(temp, "sessions.db");
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        title TEXT,
        slug TEXT,
        directory TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        time_archived INTEGER,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_reasoning INTEGER,
        tokens_cache_read INTEGER,
        tokens_cache_write INTEGER,
        cost REAL
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        data TEXT
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        session_id TEXT,
        data TEXT
      );
    `);
    db.prepare(`
      INSERT INTO session (
        id, parent_id, title, time_created, time_updated, time_archived,
        tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
        tokens_cache_write, cost
      ) VALUES (?, NULL, ?, 1000, 2000, NULL, 100, 50, 25, 10, 5, 9.5)
    `).run("root", "Provider metrics");
    db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run(
      "assistant",
      "root",
      JSON.stringify({
        role: "assistant",
        time: { created: 1100 },
        cost: 1.25,
        tokens: {
          input: 7,
          output: 3,
          reasoning: 2,
          cache: { read: 4, write: 1 }
        }
      })
    );
    db.close();

    const codeAgent = buildCodeAgentSessionTree("root", dbPath);
    assert.deepEqual({
      input: codeAgent.metrics.inputTokens,
      output: codeAgent.metrics.outputTokens,
      reasoning: codeAgent.metrics.reasoningTokens,
      cacheRead: codeAgent.metrics.cacheReadTokens,
      cacheWrite: codeAgent.metrics.cacheWriteTokens,
      cost: codeAgent.metrics.cost
    }, {
      input: 7,
      output: 3,
      reasoning: 2,
      cacheRead: 4,
      cacheWrite: 1,
      cost: 1.25
    });

    const openCode = buildOpenCodeSessionTree("root", dbPath);
    assert.equal(openCode.metrics.inputTokens, 100);
    assert.equal(openCode.metrics.outputTokens, 50);
    assert.equal(openCode.metrics.cost, 9.5);
  } finally {
    closeDb(dbPath);
  }
});

test("CodeAgent derives session identity and totals from assistant messages", () => {
  const session = enrichCodeAgentSession(
    { id: "session", agent: null, model: null, cost: 0 },
    [
      {
        id: "assistant",
        data: JSON.stringify({
          role: "assistant",
          agent: "build",
          providerID: "w3",
          modelID: "MiniMax-M2.5",
          cost: 0.75,
          tokens: {
            input: 11,
            output: 4,
            reasoning: 2,
            cache: { read: 6, write: 1 }
          }
        })
      }
    ]
  );

  assert.equal(session.agent, "build");
  assert.equal(session.model, "w3/MiniMax-M2.5");
  assert.equal(session.tokens_input, 11);
  assert.equal(session.tokens_cache_read, 6);
  assert.equal(session.cost, 0.75);
});

test("resume commands use structured placeholders and validated directories", () => {
  const cwd = resolveProjectDirectory(process.cwd());
  assert.ok(cwd);
  const command = getResumeCommand("codeagent", "session id", cwd, {
    codeagent: {
      executable: process.execPath,
      args: ["--version", "{sessionId}", "{projectPath}"]
    }
  });

  assert.equal(command.available, true);
  assert.deepEqual(command.args, ["--version", "session id", cwd]);
  assert.match(command.display, /"session id"/);
  assert.equal(resolveProjectDirectory("relative/path"), null);
  assert.equal(getResumeCommand("codeagent", "id", "relative/path", {}), null);

  const fixedExecutable = getResumeCommand("codeagent", "node", cwd, {
    codeagent: { executable: "{sessionId}", args: [] }
  });
  assert.equal(fixedExecutable.executable, "{sessionId}");
  assert.equal(fixedExecutable.available, false);
});

test("terminal launch requires the explicit startup flag", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-config-"));
  const configPath = path.join(temp, "config.json");
  writeFileSync(configPath, JSON.stringify({ allowTerminalLaunch: true }));

  assert.equal(parseArgs(["--config", configPath]).allowTerminalLaunch, false);
  assert.equal(parseArgs(["--config", configPath, "--allow-terminal-launch"]).allowTerminalLaunch, true);
});
