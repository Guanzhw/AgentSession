import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";

const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-mcp-"));
process.env.OPENSESSIONVIEWER_META_PATH = path.join(temp, "meta.db");

const { initConfig, parseArgs, validateUserConfig } = await import("../dist/src/config.js");
initConfig([]);
const { createSessionHistoryService, SessionHistoryError } = await import("../dist/src/session-history.js");
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
  assert.deepEqual(search.matches.map((match) => match.session.sessionId), ["root", "content"]);
  assert.equal(search.matches[0].matchField, "title");
  assert.equal(search.matches.some((match) => match.session.sessionId === "hidden"), false);

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

  const response = await client.callTool({ name: "session_search", arguments: { query: "Needle" } });
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent.result.matches.length, 2);
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
