import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-mcp-"));
process.env.OPENSESSIONVIEWER_META_PATH = path.join(temp, "meta.db");

const { initConfig, parseArgs, validateUserConfig } = await import("../dist/src/config.js");
initConfig([]);
const { closeDb } = await import("../dist/src/db.js");
const { createSessionHistoryService, SessionHistoryError } = await import("../dist/src/session-history.js");
const { createSqliteSessionAdapter } = await import("../dist/src/providers/shared/sqlite-adapter.js");
const { createSessionHistoryMcpServer } = await import("../packages/agentsession-mcp/dist/session-history-server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

function createFixture() {
  const sessions = new Map([
    ["root", {
      id: "root", provider: "codex", parentId: null, title: "Needle title", directory: "/work/root",
      timeCreated: 1, timeUpdated: 100, messageCount: 3, tokenCount: 12
    }],
    ["content", {
      id: "content", provider: "codex", parentId: null, title: "Other", directory: "/work/content",
      timeCreated: 2, timeUpdated: 90, messageCount: 1, tokenCount: null
    }],
    ["content-z", {
      id: "content-z", provider: "codex", parentId: null, title: "Other Z", directory: "/work/content-z",
      timeCreated: 2, timeUpdated: 90, messageCount: 1, tokenCount: null
    }],
    ["child", {
      id: "child", provider: "codex", parentId: "root", title: "Child", directory: "/work/root",
      timeCreated: 3, timeUpdated: 95, messageCount: 1, tokenCount: null
    }],
    ["hidden", {
      id: "hidden", provider: "codex", parentId: null, title: "Needle hidden", directory: "/secret",
      timeCreated: 4, timeUpdated: 110, messageCount: 1, tokenCount: null
    }]
  ]);
  const messages = new Map([
    ["root", [
      { id: "m1", sessionId: "root", role: "user", content: "Needle in a user message", thinking: null, toolName: null, toolInput: null, toolOutput: null, timestamp: 10, tokens: null, metadata: null },
      { id: "m2", sessionId: "root", role: "assistant", content: "I will inspect it", thinking: "Need a bounded plan", toolName: null, toolInput: null, toolOutput: null, timestamp: 20, tokens: null, metadata: null },
      { id: "m3", sessionId: "root", role: "tool", content: "tool output must stay opt-in", thinking: null, toolName: "Read", toolInput: { path: "secret.txt" }, toolOutput: "tool output must stay opt-in", timestamp: 30, tokens: null, metadata: { status: "error" } }
    ]],
    ["content", [
      { id: "m4", sessionId: "content", role: "assistant", content: "Needle appears only in content", thinking: null, toolName: null, toolInput: null, toolOutput: null, timestamp: 40, tokens: null, metadata: null }
    ]],
    ["content-z", [
      { id: "m5", sessionId: "content-z", role: "assistant", content: "Needle appears in tied content", thinking: null, toolName: null, toolInput: null, toolOutput: null, timestamp: 40, tokens: null, metadata: null }
    ]],
    ["child", []],
    ["hidden", []]
  ]);
  const adapter = {
    id: "codex",
    name: "Fixture Codex",
    icon: "",
    detect: () => true,
    getDataPath: () => null,
    async *scan() { yield* sessions.values(); },
    getSession: (sessionId) => sessions.get(sessionId) || null,
    getMessages: (sessionId) => messages.get(sessionId) || [],
    getTokenStats: () => [],
    searchMessages: (query) => query.toLowerCase().includes("needle")
      ? [
          { sessionId: "content", messageId: "m4", role: "assistant", snippet: "Needle appears only in content", timestamp: 40 },
          { sessionId: "content-z", messageId: "m5", role: "assistant", snippet: "Needle appears in tied content", timestamp: 40 },
          { sessionId: "hidden", messageId: "hidden-1", role: "assistant", snippet: "hidden Needle", timestamp: 50 }
        ]
      : []
  };
  const findIndexedSessionMetadata = (_provider, query) => query.toLowerCase().includes("needle")
    ? [sessions.get("root"), sessions.get("hidden")]
    : [];
  const getIndexedSessionChildren = (_provider, parentId) => parentId === "root" ? [sessions.get("child")] : [];
  const service = createSessionHistoryService({
    dependencies: {
      getAvailableProviders: () => [adapter],
      getAllProviders: () => [adapter],
      getExcludedIds: () => new Set(["hidden"]),
      indexProvider: async (provider) => {
        let count = 0;
        for await (const _session of provider.scan()) count += 1;
        return count;
      },
      findIndexedSessionMetadata,
      getIndexedSessionChildren
    }
  });
  return { service };
}

test("session-history service keeps retrieval bounded, canonical, and read-only", async () => {
  const { service } = createFixture();
  const diagnostics = await service.refreshIndex();
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].provider, "codex");
  assert.equal(diagnostics[0].status, "ok");
  assert.equal(typeof diagnostics[0].durationMs, "number");
});

test("session-history service searches, pages events, honors exclusions, and requires explicit sensitive-content opt-in", () => {
  const { service } = createFixture();
  const search = service.search({ query: "Needle" });
  assert.deepEqual(search.matches.map((match) => match.session.sessionId), ["root", "content", "content-z"]);
  assert.equal(search.matches[0].matchField, "title");
  assert.equal(search.matches.some((match) => match.session.sessionId === "hidden"), false);

  const firstSearchPage = service.search({ query: "Needle", limit: 2 });
  assert.deepEqual(firstSearchPage.matches.map((match) => match.session.sessionId), ["root", "content"]);
  assert.ok(firstSearchPage.nextCursor);
  assert.equal(firstSearchPage.truncated, true);
  const secondSearchPage = service.search({ query: "Needle", limit: 2, cursor: firstSearchPage.nextCursor });
  assert.deepEqual(secondSearchPage.matches.map((match) => match.session.sessionId), ["content-z"]);
  assert.equal(secondSearchPage.nextCursor, null);
  assert.equal(secondSearchPage.truncated, false);
  assert.deepEqual(
    service.search({ query: "Needle", directory: "/work/content" }).matches.map((match) => match.session.sessionId),
    ["content"]
  );
  assert.throws(
    () => service.search({ query: "Needle", directory: "/work/root", cursor: firstSearchPage.nextCursor }),
    (error) => error instanceof SessionHistoryError && error.code === "invalid_cursor"
  );

  const overview = service.get({ session: { provider: "codex", sessionId: "root" } });
  assert.equal(overview.session.sessionId, "root");
  assert.deepEqual(overview.children.map((child) => child.session.sessionId), ["child"]);

  const timeline = service.timeline({ session: { provider: "codex", sessionId: "root" }, limit: 2 });
  assert.deepEqual(timeline.events.map((event) => event.event.segment), ["message", "message"]);
  assert.ok(timeline.nextCursor);
  const next = service.timeline({ session: { provider: "codex", sessionId: "root" }, limit: 2, cursor: timeline.nextCursor });
  assert.deepEqual(next.events.map((event) => event.event.segment), ["tool"]);
  assert.throws(
    () => service.timeline({ session: { provider: "codex", sessionId: "root" }, segments: ["thinking"], cursor: timeline.nextCursor }),
    (error) => error instanceof SessionHistoryError && error.code === "invalid_cursor"
  );

  const thinking = service.timeline({ session: { provider: "codex", sessionId: "root" }, segments: ["thinking"] });
  assert.equal(thinking.events.length, 1);
  const context = service.getContext({ event: next.events[0].event, before: 1, after: 1 });
  assert.equal(context.target.segment, "tool");
  assert.equal(context.events.length, 2);

  assert.throws(
    () => service.getEvent({ event: { provider: "codex", sessionId: "root", messageId: "m2", segment: "thinking" } }),
    (error) => error instanceof SessionHistoryError && error.code === "thinking_opt_in_required"
  );
  const tool = service.getEvent({ event: { provider: "codex", sessionId: "root", messageId: "m3", segment: "tool" } });
  assert.equal(tool.status, "error");
  assert.equal(tool.toolInput, null);
  assert.equal(tool.toolOutput, null);
  const toolOutput = service.getEvent({
    event: { provider: "codex", sessionId: "root", messageId: "m3", segment: "tool" },
    includeToolOutput: true,
    maxChars: 8
  });
  assert.equal(toolOutput.toolOutput.text, "tool out");
  assert.equal(toolOutput.toolOutput.nextOffset, 8);

  assert.throws(
    () => service.get({ session: { provider: "codex", sessionId: "hidden" } }),
    (error) => error instanceof SessionHistoryError && error.code === "session_not_found"
  );
});

test("OpenCode SQLite search event references round-trip and session_get reports normalized message count", () => {
  const dbPath = path.join(temp, "opencode-search-events.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      project_id TEXT,
      title TEXT,
      slug TEXT,
      directory TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      time_archived INTEGER
    );
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
  `);
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("ses_sqlite", null, "project", "SQLite session", "sqlite-session", "D:\\Work\\sqlite", 10, 20, null);
  db.prepare("INSERT INTO message VALUES (?, ?, ?)")
    .run("msg_sqlite", "ses_sqlite", JSON.stringify({ role: "user", time: { created: 15 } }));
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)")
    .run("prt_sqlite", "msg_sqlite", "ses_sqlite", JSON.stringify({ type: "text", text: "Needle in SQLite" }));
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)")
    .run("prt_reasoning", "msg_sqlite", "ses_sqlite", JSON.stringify({ type: "reasoning", text: "PrivateReasoningNeedle" }));
  db.close();

  const adapter = createSqliteSessionAdapter({
    id: "opencode",
    name: "Fixture OpenCode",
    defaultDataPath: () => dbPath
  });
  const service = createSessionHistoryService({
    dependencies: {
      getAvailableProviders: () => [adapter],
      getAllProviders: () => [adapter],
      getExcludedIds: () => new Set(),
      findIndexedSessionMetadata: () => [],
      getIndexedSessionChildren: () => []
    }
  });

  const search = service.search({ query: "Needle" });
  assert.equal(search.matches.length, 1);
  assert.equal(service.search({ query: "Needle SQLite" }).matches.length, 1);
  assert.equal(service.search({ query: "Needle", directory: "/mnt/d/Work/sqlite" }).matches.length, 1);
  assert.equal(search.matches[0].event.messageId, "msg_sqlite:prt_sqlite");
  const event = service.getEvent({ event: search.matches[0].event });
  assert.equal(event.content.text, "Needle in SQLite");
  const overview = service.get({ session: { provider: "opencode", sessionId: "ses_sqlite" } });
  assert.equal(overview.messageCount, 1);
  assert.equal(service.search({ query: "PrivateReasoningNeedle" }).matches.length, 0);
  assert.equal(service.search({ query: "%" }).matches.length, 0);
  closeDb(dbPath);
});

test("AgentSession-MCP lists exactly five read-only tools over the MCP protocol", async (t) => {
  const { service } = createFixture();
  const server = createSessionHistoryMcpServer(service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agentsession-mcp-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "session_get",
    "session_get_context",
    "session_get_event",
    "session_search",
    "session_timeline"
  ]);
  assert.equal(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true), true);
  const searchTool = tools.tools.find((tool) => tool.name === "session_search");
  assert.deepEqual(searchTool.inputSchema.properties.providers.items.enum, [
    "opencode",
    "claude-code",
    "codex",
    "gemini"
  ]);
  assert.ok(searchTool.inputSchema.properties.directory);
  assert.ok(searchTool.inputSchema.properties.cursor);

  const response = await client.callTool({ name: "session_search", arguments: { query: "Needle" } });
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent.result.matches.length, 3);
  const invalid = await client.callTool({ name: "session_get", arguments: {
    session: { provider: "codex", sessionId: "root" },
    unexpected: true
  } });
  assert.equal(invalid.isError, true);
});

test("compiled stdio executable initializes without polluting MCP stdout", async (t) => {
  const configPath = path.join(temp, "mcp-config.json");
  writeFileSync(configPath, JSON.stringify({ mcp: { searchLimit: 10, timelineLimit: 10, eventMaxChars: 1000, contextWindow: 2 } }));
  const executable = path.join(process.cwd(), "packages", "agentsession-mcp", "dist", "cli.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [executable, "--config", configPath],
    stderr: "pipe"
  });
  const client = new Client({ name: "agentsession-mcp-stdio-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => client.close());
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 5);
  const search = await client.callTool({ name: "session_search", arguments: { query: "does-not-exist" } });
  assert.equal(search.isError, undefined);
});

test("compiled MCP executable has MCP-specific help", () => {
  const executable = path.join(process.cwd(), "packages", "agentsession-mcp", "dist", "cli.js");
  const result = spawnSync(process.execPath, [executable, "--help"], {
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" }
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /AgentSession-MCP/);
  assert.match(result.stdout, /Usage: agentsession-mcp \[options\]/);
  assert.equal(result.stderr, "");
});

test("MCP configuration rejects unsafe limits", () => {
  assert.deepEqual(validateUserConfig({
    mcp: { searchLimit: 0, timelineLimit: 201, eventMaxChars: 20001, contextWindow: "five" }
  }), [
    "mcp.searchLimit must be a positive integer no greater than 100.",
    "mcp.timelineLimit must be a positive integer no greater than 200.",
    "mcp.eventMaxChars must be a positive integer no greater than 20000.",
    "mcp.contextWindow must be a positive integer no greater than 20."
  ]);
});

test("AgentSession configuration names take precedence while legacy names remain supported", () => {
  const currentConfig = path.join(temp, "current-config.json");
  const legacyConfig = path.join(temp, "legacy-config.json");
  writeFileSync(currentConfig, JSON.stringify({ mcp: { searchLimit: 7 } }));
  writeFileSync(legacyConfig, JSON.stringify({ mcp: { searchLimit: 9 } }));
  const previousCurrent = process.env.AGENTSESSION_CONFIG;
  const previousLegacy = process.env.OPENSESSIONVIEWER_CONFIG;
  process.env.AGENTSESSION_CONFIG = currentConfig;
  process.env.OPENSESSIONVIEWER_CONFIG = legacyConfig;
  try {
    assert.equal(parseArgs([]).mcp.searchLimit, 7);
  } finally {
    if (previousCurrent === undefined) delete process.env.AGENTSESSION_CONFIG;
    else process.env.AGENTSESSION_CONFIG = previousCurrent;
    if (previousLegacy === undefined) delete process.env.OPENSESSIONVIEWER_CONFIG;
    else process.env.OPENSESSIONVIEWER_CONFIG = previousLegacy;
  }
});

test.after(() => rmSync(temp, { recursive: true, force: true }));
