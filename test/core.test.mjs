import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { closeDb, getTokenStats } from "../dist/src/db.js";
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
