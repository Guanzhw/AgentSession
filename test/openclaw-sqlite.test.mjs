import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { initConfig } from "../dist/src/config.js";
import { getResumeCommand } from "../dist/src/resume.js";
import openclaw from "../dist/src/providers/openclaw/adapter.js";
import { buildOpenClawSessionProtocol, buildOpenClawSqliteSessionProtocol } from "../dist/src/providers/openclaw/protocol.js";
import { openClawSqliteDailyTokenStats } from "../dist/src/providers/openclaw/sqlite-store.js";

const schemaSql = readFileSync(
  path.join("test", "fixtures", "openclaw-agent-schema-v19.sql"),
  "utf8"
);

const recentFixtureEpoch = (() => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  date.setUTCHours(12, 0, 0, 0);
  return date.getTime();
})();
const fixtureTime = (seconds = 0) => new Date(recentFixtureEpoch + seconds * 1_000).toISOString();

function eventRecord(id, parentId, message, seconds = 0) {
  return JSON.stringify({
    type: "message",
    id,
    parentId: parentId ?? null,
    timestamp: fixtureTime(seconds),
    message
  });
}

function writeJsonLines(filePath, records) {
  writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

async function collect(scan) {
  const values = [];
  for await (const value of scan) values.push(value);
  return values;
}

function createAgentDatabase(
  dbPath,
  {
    entryValid = 1,
    parentSessionKey = null,
    spawnedBy = null,
    forkSource = null,
    archivedAt = null,
    displayName = "Main session",
    label = null,
    status = "done",
    model = "deepseek-v4-flash",
    modelProvider = "deepseek",
    previousWindow = null,
    previousWindowReason = null,
    secondWindow = false,
    key = "agent:main:main",
    windowId = "win-main-1",
    previousWindowId = "win-main-0",
    agentId = "main"
  } = {}
) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(schemaSql);
  const now = Date.now();
  db.prepare(`
    INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
    VALUES ('primary', 'agent', 19, ?, '2026.8.2', ?, ?)
  `).run(agentId, now, now);
  db.prepare(`
    INSERT INTO session_nodes (
      session_key, current_session_id, entry_json, entry_valid, updated_at, status,
      created_at, parent_session_key, spawned_by, fork_source_session_key,
      fork_source_session_id, fork_source_entry_id, label, display_name, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    key, windowId, JSON.stringify({ sessionKey: key, sessionId: windowId, displayName }), entryValid,
    now + 60_000, status, now, parentSessionKey, spawnedBy,
    forkSource?.sessionKey ?? null, forkSource?.sessionId ?? null, forkSource?.entryId ?? null,
    label, displayName, archivedAt
  );
  db.prepare(`
    INSERT INTO session_windows (
      session_id, session_key, previous_session_id, reason, session_scope, created_at,
      updated_at, transcript_updated_at, started_at, ended_at, status, model_provider, model
    ) VALUES (?, ?, ?, ?, 'conversation', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    windowId, key, previousWindow, previousWindowReason, now, now + 60_000, now + 60_000,
    now, now + 30_000, status, modelProvider, model
  );
  if (secondWindow) {
    db.prepare(`
      INSERT INTO session_windows (
        session_id, session_key, previous_session_id, reason, session_scope, created_at,
        updated_at, transcript_updated_at, started_at, ended_at, status, model_provider, model
      ) VALUES (?, ?, NULL, 'initial', 'conversation', ?, ?, ?, ?, ?, 'done', ?, ?)
    `).run(previousWindowId, key, now - 120_000, now - 60_000, now - 60_000, now - 60_000, now - 90_000, modelProvider, model);
  }
  const events = [
    JSON.stringify({ type: "session", version: 3, id: windowId, timestamp: fixtureTime(), cwd: "/workspace/main" }),
    eventRecord("u1", null, { role: "user", content: "SQLite marker user", timestamp: recentFixtureEpoch + 1_000 }, 1),
    // Abandoned branch: same parent as the active path but not referenced later.
    eventRecord("a-abandoned", "u1", { role: "assistant", content: [{ type: "text", text: "abandoned" }], timestamp: recentFixtureEpoch + 2_000 }, 2),
    eventRecord("a1", "u1", {
      role: "assistant",
      model,
      provider: modelProvider,
      content: [
        { type: "thinking", thinking: "inspect sqlite" },
        { type: "toolCall", id: "call1", name: "read", arguments: { path: "package.json" } }
      ],
      usage: { input: 15, output: 10, reasoningTokens: 3, cacheRead: 5, totalTokens: 30 },
      timestamp: recentFixtureEpoch + 3_000
    }, 3),
    eventRecord("r1", "a1", {
      role: "toolResult",
      toolCallId: "call1",
      toolName: "read",
      content: [{ type: "text", text: "sqlite fixture output" }],
      isError: false,
      timestamp: recentFixtureEpoch + 4_000
    }, 4),
    eventRecord("a2", "r1", {
      role: "assistant",
      model,
      provider: modelProvider,
      content: [{ type: "text", text: "SQLite ready" }],
      usage: { input: 5, output: 2, totalTokens: 7 },
      timestamp: recentFixtureEpoch + 5_000
    }, 5)
  ];
  for (const [index, event] of events.entries()) {
    db.prepare("INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)")
      .run(windowId, index, event, recentFixtureEpoch + index * 1_000);
    const parsed = JSON.parse(event);
    if (parsed.type === "message") {
      db.prepare("INSERT INTO transcript_event_identities (session_id, event_id, seq, event_type, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(windowId, parsed.id, index, parsed.type, parsed.parentId ?? null, recentFixtureEpoch + index * 1_000);
    }
  }
  db.prepare(`
    INSERT INTO session_transcript_index_state (session_id, indexed_seq, leaf_event_id, needs_rebuild, active_event_count, active_message_count, updated_at)
    VALUES (?, ?, ?, 0, ?, ?, ?)
  `).run(windowId, events.length - 1, "a2", events.length, 4, now + 60_000);
  db.close();
}

function createChildAgentDatabase(dbPath, key, parentKey, workspace) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(schemaSql);
  const now = Date.now();
  const windowId = "win-child-1";
  db.prepare(`
    INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
    VALUES ('primary', 'agent', 19, 'worker', '2026.8.2', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO session_nodes (
      session_key, current_session_id, entry_json, entry_valid, updated_at, status, created_at,
      parent_session_key, spawned_by, display_name
    ) VALUES (?, ?, ?, 1, ?, 'done', ?, ?, ?, ?)
  `).run(key, windowId, JSON.stringify({ sessionKey: key, sessionId: windowId }), now + 60_000, now, parentKey, parentKey, "Child session");
  db.prepare(`
    INSERT INTO session_windows (
      session_id, session_key, previous_session_id, reason, session_scope, created_at,
      updated_at, transcript_updated_at, started_at, ended_at, status, model_provider, model
    ) VALUES (?, ?, NULL, NULL, 'conversation', ?, ?, ?, ?, ?, 'done', 'deepseek', 'deepseek-v4-flash')
  `).run(windowId, key, now, now + 60_000, now + 60_000, now, now + 30_000);
  db.prepare("INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 0, ?, ?)")
    .run(windowId, JSON.stringify({ type: "session", version: 3, id: windowId, timestamp: fixtureTime(6), cwd: workspace }), recentFixtureEpoch + 6_000);
  db.prepare("INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 1, ?, ?)")
    .run(windowId, eventRecord("cu1", null, { role: "user", content: "child task", timestamp: recentFixtureEpoch + 6_000 }, 6), recentFixtureEpoch + 6_000);
  db.prepare("INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 2, ?, ?)")
    .run(windowId, eventRecord("ca1", "cu1", { role: "assistant", content: [{ type: "text", text: "child result" }], timestamp: recentFixtureEpoch + 7_000 }, 7), recentFixtureEpoch + 7_000);
  db.close();
}

test("OpenClaw current SQLite: canonical lookup, active path, tools, reasoning, usage", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsession-openclaw-sqlite-"));
  try {
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    createAgentDatabase(path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"));
    initConfig(["--openclaw-dir", root]);

    const scanned = await collect(openclaw.scan());
    assert.equal(scanned.length, 1);
    assert.equal(scanned[0].id, "agent:main:main");
    assert.equal(scanned[0].title, "Main session");
    assert.equal(scanned[0].messageCount, 4);
    assert.equal(scanned[0].tokenCount, 37);
    assert.equal(scanned[0].parentId, null);
    assert.equal(scanned[0].directory, "/workspace/main");
    assert.equal(scanned[0].metadata.storage, "sqlite");
    assert.equal(scanned[0].metadata.currentSessionId, "win-main-1");
    assert.equal(scanned[0].metadata.model, "deepseek-v4-flash");
    assert.equal(scanned[0].metadata.modelProvider, "deepseek");

    // Legacy window id still resolves to the canonical session key exactly once.
    assert.equal(openclaw.getSession("win-main-1")?.id, "agent:main:main");
    assert.equal(openclaw.getMessages("win-main-1").length, 4);

    const messages = openclaw.getMessages("agent:main:main");
    assert.equal(messages.some((message) => message.content === "abandoned"), false);
    const call = messages.find((message) => message.id === "call1");
    assert.equal(call?.toolName, "read");
    assert.equal(call?.toolOutput, "sqlite fixture output");
    assert.equal(call?.metadata.status, "completed");
    const assistant = messages.find((message) => message.id === "a1");
    assert.equal(assistant?.thinking, "inspect sqlite");
    assert.deepEqual(assistant?.tokens, {
      input: 15,
      output: 7,
      reasoning: 3,
      total: 30,
      cache: { read: 5, write: 0 }
    });

    assert.ok(openclaw.getTokenStats(30).some(day => day.totalTokens === 37 && day.reasoningTokens === 3 && day.cacheReadTokens === 5));
    assert.equal(openclaw.searchMessages("SQLite marker user")[0]?.sessionId, "agent:main:main");
    assert.ok(openclaw.getRuntimeEnvironment("agent:main:main")?.extensions.length >= 0);
    assert.deepEqual(
      getResumeCommand(openclaw, "agent:main:main", workspace, {}).args.slice(-2),
      ["--session", "agent:main:main"]
    );
    const exported = openclaw.exportSession("agent:main:main");
    assert.equal(exported?.session.id, "agent:main:main");
    assert.equal(exported?.records.length, 6);

    const sqliteDaily = openClawSqliteDailyTokenStats(
      [{ session: scanned[0], records: exported.records, messages: messages }],
      30
    );
    assert.ok(sqliteDaily.some(day => day.totalTokens === 37));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw current SQLite: recorded parent/spawn/fork lineage", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsession-openclaw-sqlite-"));
  try {
    createAgentDatabase(path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"));
    createChildAgentDatabase(
      path.join(root, "agents", "worker", "agent", "openclaw-agent.sqlite"),
      "agent:worker:child",
      "agent:main:main",
      "/workspace/child"
    );
    initConfig(["--openclaw-dir", root]);

    const parent = openclaw.getSession("agent:main:main");
    const child = openclaw.getSession("agent:worker:child");
    assert.equal(child?.parentId, "agent:main:main");
    const tree = JSON.stringify(openclaw.getSessionTree("agent:main:main"));
    assert.match(tree, /agent:worker:child/);
    const protocol = openclaw.getSessionProtocol("agent:main:main");
    assert.equal(protocol?.validation.ok, true);
    // The child records parent_session_key === spawned_by === the parent key:
    // semantically identical facts deduplicate to a single parent edge
    // (structural-parent precedence), never to both or to a fabricated one.
    const childEdges = protocol?.relationships.filter(relationship =>
      relationship.toSessionId === "agent:worker:child" || relationship.fromSessionId === "agent:worker:child"
    ) || [];
    assert.equal(childEdges.length, 1);
    assert.equal(childEdges[0].type, "parent");
    assert.equal(childEdges[0].fromSessionId, "agent:worker:child");
    assert.equal(childEdges[0].toSessionId, "agent:main:main");
    assert.equal(childEdges[0].provenance.sourceType, "openclaw.sqlite.session_nodes.parent_session_key");
    assert.equal(protocol?.relationships.some(relationship =>
      relationship.type === "spawned" && relationship.toSessionId === "agent:worker:child"
    ), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw current SQLite: forked-from and window lineage are recorded facts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsession-openclaw-fork-"));
  try {
    createAgentDatabase(path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"), {
      forkSource: { sessionKey: "agent:main:original", sessionId: "win-original", entryId: "e1" },
      displayName: "Forked session",
      previousWindow: "win-main-0",
      previousWindowReason: "reset",
      secondWindow: true
    });
    initConfig(["--openclaw-dir", root]);
    const session = openclaw.getSession("agent:main:main");
    assert.deepEqual(session?.metadata.forkSource, {
      sessionKey: "agent:main:original",
      sessionId: "win-original",
      entryId: "e1"
    });
    const lineage = session?.metadata.windowLineage;
    assert.equal(Array.isArray(lineage), true);
    assert.ok(lineage.some(window => window.sessionId === "win-main-1" && window.previousSessionId === "win-main-0" && window.reason === "reset"));
    assert.ok(lineage.some(window => window.sessionId === "win-main-0" && window.reason === "initial"));
    const protocol = buildOpenClawSqliteSessionProtocol(
      session,
      [],
      [],
      1,
      { forkedFromSessionKey: "agent:main:original" }
    );
    assert.equal(protocol.validation.ok, true);
    assert.ok(protocol.relationships.some(relationship => relationship.type === "forked" && relationship.fromSessionId === "agent:main:original"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw current SQLite: SQLite + JSONL dedup, legacy-only fallback", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsession-openclaw-mixed-"));
  try {
    createAgentDatabase(path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"));
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    // Covered legacy file: same window id as the SQLite current window.
    writeJsonLines(path.join(sessionsDir, "win-main-1.jsonl"), [
      { type: "session", version: 2, id: "win-main-1", timestamp: fixtureTime(), cwd: "/workspace" },
      { type: "message", id: "lu1", parentId: null, timestamp: fixtureTime(1), message: { role: "user", content: "legacy duplicate" } }
    ]);
    // Uncovered legacy session: agent key not present in SQLite.
    writeJsonLines(path.join(sessionsDir, "win-legacy-only.jsonl"), [
      { type: "session", version: 2, id: "win-legacy-only", timestamp: fixtureTime(2), cwd: "/workspace" },
      { type: "message", id: "ll1", parentId: null, timestamp: fixtureTime(3), message: { role: "user", content: "legacy only marker" } }
    ]);
    // Legacy child whose registry spawnedBy names the SQLite session key:
    // cross-store lineage must resolve to the canonical session, not break.
    writeJsonLines(path.join(sessionsDir, "win-legacy-child.jsonl"), [
      { type: "session", version: 2, id: "win-legacy-child", timestamp: fixtureTime(4), cwd: "/workspace" },
      { type: "message", id: "lc1", parentId: null, timestamp: fixtureTime(5), message: { role: "user", content: "legacy child marker" } }
    ]);
    writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:main": { sessionId: "win-main-1", displayName: "legacy duplicate title" },
        "agent:main:legacy": { sessionId: "win-legacy-only", displayName: "Legacy only session" },
        "agent:main:child": { sessionId: "win-legacy-child", spawnedBy: "agent:main:main" }
      })
    );
    initConfig(["--openclaw-dir", root]);

    const scanned = await collect(openclaw.scan());
    assert.equal(scanned.filter(session => session.id === "agent:main:main").length, 1);
    assert.equal(scanned.filter(session => session.id === "win-main-1").length, 0);
    assert.equal(scanned.some(session => session.id === "win-legacy-only"), true);
    assert.equal(scanned.find(session => session.id === "agent:main:main")?.title, "Main session");
    assert.equal(scanned.find(session => session.id === "win-legacy-only")?.title, "Legacy only session");
    assert.equal(openclaw.searchMessages("legacy duplicate").length, 0);
    assert.equal(openclaw.searchMessages("legacy only marker")[0]?.sessionId, "win-legacy-only");
    // The legacy child now links to the canonical SQLite parent.
    assert.equal(openclaw.getSession("win-legacy-child")?.parentId, "agent:main:main");
    assert.match(JSON.stringify(openclaw.getSessionTree("agent:main:main")), /win-legacy-child/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw current SQLite: legacy-only and unsupported SQLite diagnostics stay truthful", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsession-openclaw-diagnostics-"));
  try {
    // Agent with no SQLite at all: pure legacy JSONL.
    const legacyDir = path.join(root, "agents", "legacy-agent", "sessions");
    mkdirSync(legacyDir, { recursive: true });
    writeJsonLines(path.join(legacyDir, "legacy-session.jsonl"), [
      { type: "session", version: 2, id: "legacy-session", timestamp: fixtureTime(), cwd: "/workspace" },
      { type: "message", id: "m1", parentId: null, timestamp: fixtureTime(1), message: { role: "user", content: "legacy marker" } }
    ]);
    // Agent with a future-schema SQLite (unsupported; not silently treated as empty).
    const futureDir = path.join(root, "agents", "future-agent", "agent");
    mkdirSync(futureDir, { recursive: true });
    const db = new DatabaseSync(path.join(futureDir, "openclaw-agent.sqlite"));
    db.exec(schemaSql);
    db.prepare(`
      INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
      VALUES ('primary', 'agent', 20, 'future-agent', '2026.9.0', 1, 1)
    `).run();
    db.exec("PRAGMA user_version = 20");
    db.close();
    // Agent with a corrupt SQLite file.
    const corruptDir = path.join(root, "agents", "corrupt-agent", "agent");
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(path.join(corruptDir, "openclaw-agent.sqlite"), "this is not sqlite");
    // Agent whose SQLite predates the session flip (memory-only schema, no session tables).
    const memoryDir = path.join(root, "agents", "memory-agent", "agent");
    mkdirSync(memoryDir, { recursive: true });
    const memoryDb = new DatabaseSync(path.join(memoryDir, "openclaw-agent.sqlite"));
    memoryDb.exec(`
      CREATE TABLE schema_meta (meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL, agent_id TEXT, app_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
      INSERT INTO schema_meta VALUES ('primary', 'agent', 1, 'memory-agent', '2026.7.1-2', 1, 1);
      CREATE TABLE cache_entries (scope TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT, blob BLOB, expires_at INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (scope, key)) STRICT;
      PRAGMA user_version = 1;
    `);
    memoryDb.close();

    initConfig(["--openclaw-dir", root]);
    const scanned = await collect(openclaw.scan());
    assert.deepEqual(scanned.map(session => session.id), ["legacy-session"]);
    const diagnostic = openclaw.getStorageDiagnostic?.() || null;
    const states = diagnostic?.states || [];
    const legacyState = states.find(state => state.agentId === "legacy-agent");
    assert.equal(legacyState?.status, "legacy-only");
    const futureState = states.find(state => state.agentId === "future-agent");
    assert.equal(futureState?.status, "unsupported");
    assert.equal(futureState?.schemaVersion, 20);
    const corruptState = states.find(state => state.agentId === "corrupt-agent");
    assert.equal(corruptState?.status, "unreadable");
    const memoryState = states.find(state => state.agentId === "memory-agent");
    assert.equal(memoryState?.status, "legacy-only");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw current SQLite: read-only open never mutates provider storage", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsession-openclaw-readonly-"));
  try {
    const dbPath = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
    createAgentDatabase(dbPath);
    const before = readFileSync(dbPath);
    const walBefore = existsOrNull(`${dbPath}-wal`);
    initConfig(["--openclaw-dir", root]);
    await collect(openclaw.scan());
    openclaw.getMessages("agent:main:main");
    openclaw.getSessionProtocol("agent:main:main");
    openclaw.getTokenStats(30);
    openclaw.searchMessages("SQLite marker user");
    const after = readFileSync(dbPath);
    assert.deepEqual(after, before);
    assert.equal(existsOrNull(`${dbPath}-wal`), walBefore);
    // A direct write attempt against the same path must fail: the adapter
    // storage contract is read-only, and the fixture DB must stay untouched.
    const probe = new DatabaseSync(dbPath, { readOnly: true });
    assert.throws(() => probe.exec("DELETE FROM session_nodes"));
    probe.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw current SQLite: old window generation dedups and resolves by window id", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsession-openclaw-oldgen-"));
  try {
    createAgentDatabase(path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"), {
      secondWindow: true,
      previousWindowReason: "rollover",
      displayName: "Rolled session"
    });
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    // Legacy JSONL for the OLD recorded generation: covered, never listed,
    // but MUST stay resolvable by that window id.
    writeJsonLines(path.join(sessionsDir, "win-main-0.jsonl"), [
      { type: "session", version: 2, id: "win-main-0", timestamp: fixtureTime(), cwd: "/workspace" },
      { type: "message", id: "og1", parentId: null, timestamp: fixtureTime(1), message: { role: "user", content: "older generation marker" } }
    ]);
    // Legacy JSONL for a generation never recorded in SQLite: stays readable.
    writeJsonLines(path.join(sessionsDir, "win-main-9.jsonl"), [
      { type: "session", version: 2, id: "win-main-9", timestamp: fixtureTime(2), cwd: "/workspace" },
      { type: "message", id: "ug1", parentId: null, timestamp: fixtureTime(3), message: { role: "user", content: "uncovered archive marker" } }
    ]);
    writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:main": { sessionId: "win-main-1", displayName: "rollover duplicate" },
        "agent:main:old": { sessionId: "win-main-0", displayName: "old generation" },
        "agent:main:archived": { sessionId: "win-main-9", displayName: "Uncovered archive" }
      })
    );
    initConfig(["--openclaw-dir", root]);

    const scanned = await collect(openclaw.scan());
    assert.deepEqual(scanned.map(session => session.id).sort(), ["agent:main:main", "win-main-9"]);
    assert.equal(scanned.find(session => session.id === "agent:main:main")?.title, "Rolled session");
    // The old window id resolves to the canonical session exactly once.
    assert.equal(openclaw.getSession("win-main-0")?.id, "agent:main:main");
    assert.equal(openclaw.getMessages("win-main-0").length, 4);
    assert.equal(openclaw.exportSession("win-main-0")?.session.id, "agent:main:main");
    // The covered old generation is not exposed separately.
    assert.equal(openclaw.searchMessages("older generation marker").length, 0);
    assert.equal(openclaw.searchMessages("uncovered archive marker")[0]?.sessionId, "win-main-9");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function sqliteSession(id, metadata = {}) {
  return {
    id,
    provider: "openclaw",
    parentId: metadata.parentSessionKey || metadata.spawnedBy || null,
    title: id,
    directory: null,
    timeCreated: 1_000,
    timeUpdated: 1_000,
    messageCount: 0,
    tokenCount: 0,
    metadata: { agentId: "main", sessionKey: id, storage: "sqlite", ...metadata }
  };
}

function relationshipFacts(protocol) {
  return (protocol.relationships || []).map(relationship => ({
    type: relationship.type,
    from: relationship.fromSessionId,
    to: relationship.toSessionId,
    sourceType: relationship.provenance.sourceType
  }));
}

test("OpenClaw SQLite protocol: parent/spawn come only from their own recorded field", () => {
  // Parent-only: parent_session_key without spawned_by => single parent edge.
  let protocol = buildOpenClawSqliteSessionProtocol(
    sqliteSession("agent:child", { parentSessionKey: "agent:parent" }), [], [], 1);
  assert.deepEqual(relationshipFacts(protocol), [{
    type: "parent", from: "agent:child", to: "agent:parent",
    sourceType: "openclaw.sqlite.session_nodes.parent_session_key"
  }]);

  // Spawned-only: spawned_by without parent_session_key => single spawned edge.
  protocol = buildOpenClawSqliteSessionProtocol(
    sqliteSession("agent:child", { spawnedBy: "agent:spawner" }), [], [], 1);
  assert.deepEqual(relationshipFacts(protocol), [{
    type: "spawned", from: "agent:spawner", to: "agent:child",
    sourceType: "openclaw.sqlite.session_nodes.spawned_by"
  }]);

  // Both present but different => both edges, each from its own field.
  protocol = buildOpenClawSqliteSessionProtocol(
    sqliteSession("agent:child", { parentSessionKey: "agent:parent", spawnedBy: "agent:spawner" }), [], [], 1);
  assert.deepEqual(relationshipFacts(protocol), [{
    type: "parent", from: "agent:child", to: "agent:parent",
    sourceType: "openclaw.sqlite.session_nodes.parent_session_key"
  }, {
    type: "spawned", from: "agent:spawner", to: "agent:child",
    sourceType: "openclaw.sqlite.session_nodes.spawned_by"
  }]);

  // Both present and identical => deduplicated to one parent edge (structural
  // precedence), not two edges and not a fabricated field.
  protocol = buildOpenClawSqliteSessionProtocol(
    sqliteSession("agent:child", { parentSessionKey: "agent:parent", spawnedBy: "agent:parent" }), [], [], 1);
  assert.deepEqual(relationshipFacts(protocol), [{
    type: "parent", from: "agent:child", to: "agent:parent",
    sourceType: "openclaw.sqlite.session_nodes.parent_session_key"
  }]);

  // Neither field recorded => no relationship fabricated from parentId.
  protocol = buildOpenClawSqliteSessionProtocol(
    sqliteSession("agent:child", {}, "agent:something"), [], [], 1);
  assert.deepEqual(relationshipFacts(protocol), []);
});

test("OpenClaw SQLite protocol: edge type follows each child's recorded field", () => {
  const children = [
    // Parent-only child.
    { session: sqliteSession("agent:p1", { parentSessionKey: "agent:p" }), records: [] },
    // Spawned-only child.
    { session: sqliteSession("agent:s1", { spawnedBy: "agent:p" }), records: [] },
    // Both different: the parent edge belongs to this session's protocol
    // (from ps1 to p); the spawned edge belongs to the spawner's protocol.
    { session: sqliteSession("agent:ps1", { parentSessionKey: "agent:p", spawnedBy: "agent:spawner" }), records: [] },
    // Unknown parent/spawner: must produce no edges against the queried session.
    { session: sqliteSession("agent:other", { parentSessionKey: "agent:x", spawnedBy: "agent:y" }), records: [] },
    // No lineage at all.
    { session: sqliteSession("agent:none"), records: [] }
  ];
  const protocol = buildOpenClawSqliteSessionProtocol(sqliteSession("agent:p"), [], children, 1);
  const facts = relationshipFacts(protocol);
  assert.deepEqual(facts, [
    { type: "parent", from: "agent:p1", to: "agent:p", sourceType: "openclaw.sqlite.session_nodes.parent_session_key" },
    { type: "spawned", from: "agent:p", to: "agent:s1", sourceType: "openclaw.sqlite.session_nodes.spawned_by" },
    { type: "parent", from: "agent:ps1", to: "agent:p", sourceType: "openclaw.sqlite.session_nodes.parent_session_key" }
  ]);
});

test("OpenClaw current SQLite: cross-agent coverage collision cannot hide another agent's legacy session", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsession-openclaw-crossagent-"));
  try {
    createAgentDatabase(path.join(root, "agents", "alpha", "agent", "openclaw-agent.sqlite"), {
      secondWindow: true,
      previousWindowId: "win-shared-old",
      key: "agent:alpha:main",
      windowId: "win-a-1",
      agentId: "alpha",
      displayName: "Alpha session"
    });
    // Beta is legacy-only but its file window id and registry sessionKey both
    // collide with alpha's recorded ids. Agent-scoped coverage means beta's
    // legacy session stays readable — it must not be hidden by alpha.
    const betaSessions = path.join(root, "agents", "beta", "sessions");
    mkdirSync(betaSessions, { recursive: true });
    writeJsonLines(path.join(betaSessions, "win-shared-old.jsonl"), [
      { type: "session", version: 2, id: "win-shared-old", timestamp: fixtureTime(2), cwd: "/workspace" },
      { type: "message", id: "bc1", parentId: null, timestamp: fixtureTime(3), message: { role: "user", content: "beta legacy marker" } }
    ]);
    writeFileSync(
      path.join(betaSessions, "sessions.json"),
      JSON.stringify({
        "agent:alpha:main": { sessionId: "win-shared-old", displayName: "Beta collision session" }
      })
    );
    initConfig(["--openclaw-dir", root]);

    const scanned = await collect(openclaw.scan());
    assert.deepEqual(scanned.map(session => session.id).sort(), ["agent:alpha:main", "win-shared-old"]);
    assert.equal(scanned.find(session => session.id === "win-shared-old")?.title, "Beta collision session");
    assert.equal(openclaw.searchMessages("beta legacy marker")[0]?.sessionId, "win-shared-old");
    assert.equal(openclaw.searchMessages("beta legacy marker")[0]?.snippet.includes("beta legacy marker"), true);
    // Bare lookup of the colliding id stays deterministic (SQLite canonical
    // first) and beta's own session remains reachable by its file id via scan
    // and search — never silently overwritten.
    assert.equal(openclaw.getSession("win-shared-old")?.id, "agent:alpha:main");
    assert.equal(openclaw.getSession("agent:alpha:main")?.title, "Alpha session");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw current SQLite: ambiguous window id between agents is deterministic and diagnosed", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsession-openclaw-ambiguous-"));
  try {
    createAgentDatabase(path.join(root, "agents", "alpha", "agent", "openclaw-agent.sqlite"), {
      key: "agent:alpha:main", windowId: "win-shared-1", agentId: "alpha", displayName: "Alpha shared"
    });
    createAgentDatabase(path.join(root, "agents", "gamma", "agent", "openclaw-agent.sqlite"), {
      key: "agent:gamma:main", windowId: "win-shared-1", agentId: "gamma", displayName: "Gamma shared"
    });
    initConfig(["--openclaw-dir", root]);

    const scanned = await collect(openclaw.scan());
    assert.deepEqual(scanned.map(session => session.id).sort(), ["agent:alpha:main", "agent:gamma:main"]);
    // Canonical keys are never ambiguous; the colliding window id resolves
    // deterministically to the first agent in sorted order (alpha), and the
    // collision is reported as an explicit diagnostic instead of silent
    // last-write-wins.
    assert.equal(openclaw.getSession("win-shared-1")?.id, "agent:alpha:main");
    assert.equal(openclaw.getSession("agent:gamma:main")?.title, "Gamma shared");
    const diagnostic = openclaw.getStorageDiagnostic();
    assert.deepEqual(diagnostic.aliasAmbiguities, [{ id: "win-shared-1", agents: ["alpha", "gamma"] }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw current SQLite: legacy-only agent add/remove refreshes diagnostics", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsession-openclaw-dynamic-"));
  try {
    createAgentDatabase(path.join(root, "agents", "alpha", "agent", "openclaw-agent.sqlite"));
    initConfig(["--openclaw-dir", root]);
    await collect(openclaw.scan());
    let states = openclaw.getStorageDiagnostic().states;
    assert.deepEqual(states.map(state => state.agentId), ["alpha"]);
    assert.equal(states[0].status, "current");

    // A legacy-only agent appears: diagnostics must not stay stale.
    const betaSessions = path.join(root, "agents", "beta", "sessions");
    mkdirSync(betaSessions, { recursive: true });
    writeJsonLines(path.join(betaSessions, "beta-session.jsonl"), [
      { type: "session", version: 2, id: "beta-session", timestamp: fixtureTime(), cwd: "/workspace" },
      { type: "message", id: "bm1", parentId: null, timestamp: fixtureTime(1), message: { role: "user", content: "beta marker" } }
    ]);
    states = openclaw.getStorageDiagnostic().states;
    assert.deepEqual(states.map(state => state.agentId), ["alpha", "beta"]);
    assert.equal(states.find(state => state.agentId === "beta")?.status, "legacy-only");

    // Removing it must also refresh, not keep a ghost diagnostic.
    rmSync(path.join(root, "agents", "beta"), { recursive: true, force: true });
    states = openclaw.getStorageDiagnostic().states;
    assert.deepEqual(states.map(state => state.agentId), ["alpha"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw current SQLite: column projection tolerates missing non-consumed columns", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsession-openclaw-columns-"));
  try {
    const dbPath = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
    createAgentDatabase(dbPath);
    const db = new DatabaseSync(dbPath);
    // Columns the reader never consumes (14..18 ladder differences) can be
    // absent without breaking the current read; selection is bounded to the
    // consumed set intersected with the discovered schema.
    db.exec(`
      ALTER TABLE session_nodes DROP COLUMN category;
      ALTER TABLE session_nodes DROP COLUMN icon;
      ALTER TABLE session_windows DROP COLUMN started_at;
      ALTER TABLE session_windows DROP COLUMN ended_at;
      ALTER TABLE session_windows DROP COLUMN parent_session_key;
      ALTER TABLE session_windows DROP COLUMN spawned_by;
      ALTER TABLE session_windows DROP COLUMN display_name;
    `);
    db.close();
    initConfig(["--openclaw-dir", root]);
    const scanned = await collect(openclaw.scan());
    assert.deepEqual(scanned.map(session => session.id), ["agent:main:main"]);
    assert.equal(scanned[0].title, "Main session");
    assert.equal(scanned[0].messageCount, 4);

    // A consumed column missing is still diagnosed as unsupported (never
    // silently read as empty or guessed).
    const dbPath2 = path.join(root, "agents", "main2", "agent", "openclaw-agent.sqlite");
    createAgentDatabase(dbPath2);
    const db2 = new DatabaseSync(dbPath2);
    db2.exec("ALTER TABLE session_windows DROP COLUMN transcript_updated_at");
    db2.close();
    initConfig(["--openclaw-dir", root]);
    const diagnostic = openclaw.getStorageDiagnostic();
    await collect(openclaw.scan());
    const state = diagnostic.states.find(state => state.agentId === "main2");
    assert.equal(state?.status, "unsupported");
    assert.match(state?.detail || "", /session_windows is missing column transcript_updated_at/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw current SQLite: ambiguous cross-agent registry key stays unresolved and diagnosed", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsession-openclaw-lineageamb-"));
  try {
    for (const agentId of ["alpha", "beta"]) {
      const sessionsDir = path.join(root, "agents", agentId, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      writeJsonLines(path.join(sessionsDir, `${agentId}-shared.jsonl`), [
        { type: "session", version: 2, id: `${agentId}-shared`, timestamp: fixtureTime(), cwd: "/workspace" },
        { type: "message", id: `${agentId}-m1`, parentId: null, timestamp: fixtureTime(1), message: { role: "user", content: `${agentId} shared marker` } }
      ]);
      writeFileSync(
        path.join(sessionsDir, "sessions.json"),
        JSON.stringify({ "agent:main:shared": { sessionId: `${agentId}-shared`, displayName: `${agentId} shared` } })
      );
    }
    // A child references the same canonical key from a third agent: the key
    // maps to two different file ids, so no parent is silently chosen.
    const zetaDir = path.join(root, "agents", "zeta", "sessions");
    mkdirSync(zetaDir, { recursive: true });
    writeJsonLines(path.join(zetaDir, "zeta-child.jsonl"), [
      { type: "session", version: 2, id: "zeta-child", timestamp: fixtureTime(2), cwd: "/workspace" },
      { type: "message", id: "zc1", parentId: null, timestamp: fixtureTime(3), message: { role: "user", content: "zeta child marker" } }
    ]);
    writeFileSync(
      path.join(zetaDir, "sessions.json"),
      JSON.stringify({ "agent:main:child": { sessionId: "zeta-child", spawnedBy: "agent:main:shared" } })
    );
    initConfig(["--openclaw-dir", root]);

    const scanned = await collect(openclaw.scan());
    assert.deepEqual(scanned.map(session => session.id).sort(), ["alpha-shared", "beta-shared", "zeta-child"]);
    assert.equal(openclaw.getSession("zeta-child")?.parentId, null);
    const diagnostic = openclaw.getStorageDiagnostic();
    assert.deepEqual(diagnostic.lineageAmbiguities, ["agent:main:shared"]);
    assert.match(diagnostic.note || "", /referenced parents stay unresolved/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw protocol: tasks/agentRuns are none — both builders always emit empty arrays", () => {
  // Capability contract: no verified delegation mapping exists in the current
  // SQLite agent schema or legacy JSONL, so both domains declare support
  // "none" instead of conditional partial projection.
  assert.equal(openclaw.protocolCapabilities.tasks.support, "none");
  assert.equal(openclaw.protocolCapabilities.agentRuns.support, "none");

  // Legacy builder (in-file records, registry lineage) also emits empty arrays.
  const legacySession = {
    id: "legacy:1", provider: "openclaw", parentId: null, title: null,
    directory: null, timeCreated: 1, timeUpdated: 2, messageCount: 1,
    tokenCount: null, metadata: null
  };
  const legacy = buildOpenClawSessionProtocol(
    legacySession,
    [{ type: "message", id: "m1", parentId: null, timestamp: 1, message: { role: "user", content: "x" } }],
    [], 1
  );
  assert.deepEqual(legacy.tasks, []);
  assert.deepEqual(legacy.agentRuns, []);

  // Current SQLite builder emits empty arrays even when lineage children exist.
  const sqlite = buildOpenClawSqliteSessionProtocol(
    sqliteSession("agent:p"), [],
    [{ session: sqliteSession("agent:child", { parentSessionKey: "agent:p" }), records: [] }],
    1
  );
  assert.deepEqual(sqlite.tasks, []);
  assert.deepEqual(sqlite.agentRuns, []);
});

function existsOrNull(filePath) {
  try {
    return readFileSync(filePath);
  } catch {
    return null;
  }
}
