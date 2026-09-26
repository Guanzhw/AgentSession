import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-mcp-"));
process.env.AGENTSESSION_META_PATH = path.join(temp, "meta.db");

const { initConfig, parseArgs, validateUserConfig } = await import("../dist/src/config.js");
initConfig([]);
const { closeDb } = await import("../dist/src/db.js");
const { closeIndexDb, findIndexedSessionMetadata, upsertIndex } = await import("../dist/src/index-db.js");
const { closeMetaDb, getMetaDb, getExcludedIds, permanentDelete, softDelete } = await import("../dist/src/meta.js");
const { createSessionHistoryService, SessionHistoryError } = await import("../dist/src/session-history.js");
const { createOpenCodeSqliteAdapter } = await import("../dist/src/providers/opencode/sqlite-adapter.js");
const { searchNormalizedMessages } = await import("../dist/src/providers/shared/file-adapter-helpers.js");
const { createSessionHistoryMcpServer } = await import("../packages/agentsession-mcp/dist/session-history-server.js");
const {
  AUTO_UPDATE_PACKAGE,
  createAutoUpdateLauncher,
  getInstallConfigPath,
  installIntoTarget,
  parseInstallerCommand
} = await import("../packages/agentsession-mcp/dist/installer.js");
const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
const { StdioClientTransport } = await import("@modelcontextprotocol/client/stdio");

function createFixture() {
  let catalogVersion = 1;
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
      { id: "m-empty", sessionId: "root", role: "assistant", content: " \n\t ", thinking: null, toolName: null, toolInput: null, toolOutput: null, timestamp: 25, tokens: null, metadata: null },
      { id: "m3", sessionId: "root", role: "tool", content: "tool output must stay opt-in", thinking: null, toolName: "Read", toolInput: { path: "secret.txt" }, toolOutput: "tool output must stay opt-in", timestamp: 30, tokens: null, metadata: { status: "error" } }
    ]],
    ["content", [
      { id: "m4", sessionId: "content", role: "assistant", content: "Needle appears only in content", thinking: null, toolName: null, toolInput: null, toolOutput: null, timestamp: 40, tokens: null, metadata: null }
    ]],
    ["content-z", [
      { id: "m5", sessionId: "content-z", role: "assistant", content: "Needle appears in tied content", thinking: null, toolName: null, toolInput: null, toolOutput: null, timestamp: 40, tokens: null, metadata: null }
    ]],
    ["child", []],
    ["hidden", [
      { id: "hidden-1", sessionId: "hidden", role: "user", content: "Needle in a viewer-excluded session", thinking: null, toolName: null, toolInput: null, toolOutput: null, timestamp: 50, tokens: null, metadata: null }
    ]]
  ]);
  const searchMessageCalls = { count: 0 };
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
    searchMessages: (query) => {
      searchMessageCalls.count += 1;
      return query.toLowerCase().includes("needle")
        ? [
          { sessionId: "root", messageId: "m1", role: "user", snippet: "Needle in a user message", timestamp: 10 },
          { sessionId: "content", messageId: "m4", role: "assistant", snippet: "Needle appears only in content", timestamp: 40 },
          { sessionId: "content-z", messageId: "m5", role: "assistant", snippet: "Needle appears in tied content", timestamp: 40 },
          { sessionId: "hidden", messageId: "hidden-1", role: "user", snippet: "hidden Needle", timestamp: 50 }
        ]
        : [];
    }
  };
  const findIndexedSessionMetadata = (_provider, query) => [...sessions.values()]
    .filter((session) => `${session.title} ${session.directory}`.toLowerCase().includes(query.toLowerCase()));
  const getIndexedSessionChildren = (_provider, parentId) => parentId === "root" ? [sessions.get("child")] : [];
  const indexedSessions = ({ providers, directory, title, parent, updatedAfter, updatedBefore, limit, offset }) => [...sessions.values()]
    .filter((session) => providers.includes(session.provider))
    .filter((session) => directory === undefined || session.directory === directory)
    .filter((session) => title === undefined || session.title.toLowerCase().includes(title.toLowerCase()))
    .filter((session) => parent === undefined || (parent === null ? session.parentId === null : session.parentId === parent.sessionId && session.provider === parent.provider))
    .filter((session) => updatedAfter === undefined || session.timeUpdated >= updatedAfter)
    .filter((session) => updatedBefore === undefined || session.timeUpdated <= updatedBefore)
    .sort((left, right) => right.timeUpdated - left.timeUpdated || right.timeCreated - left.timeCreated || left.id.localeCompare(right.id))
    .slice(offset, offset + limit);
  const indexedProjects = ({ providers, directory, updatedAfter, updatedBefore, limit, offset }) => {
    const counts = new Map();
    for (const session of sessions.values()) {
      if (!providers.includes(session.provider) || updatedAfter !== undefined && session.timeUpdated < updatedAfter
        || updatedBefore !== undefined && session.timeUpdated > updatedBefore) continue;
      const key = `${session.provider}\0${session.directory}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts].map(([key, indexedCount]) => {
      const [provider, directory] = key.split("\0");
      return { provider, directory, indexedCount };
    }).filter((project) => directory === undefined || project.directory === directory)
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.directory.localeCompare(right.directory))
      .slice(offset, offset + limit);
  };
  const service = createSessionHistoryService({
    dependencies: {
      getAvailableProviders: () => [adapter],
      getAllProviders: () => [adapter],
      indexProvider: async (provider) => {
        let count = 0;
        for await (const _session of provider.scan()) count += 1;
        return count;
      },
      findIndexedSessionMetadata,
      getIndexedSessionChildren,
      browseIndexedSessions: indexedSessions,
      browseIndexedProjects: indexedProjects,
      getIndexedCatalogRevision: () => String(catalogVersion)
    }
  });
  return { service, searchMessageCalls, advanceCatalogRevision: () => { catalogVersion += 1; } };
}

test("session-history service keeps retrieval bounded, canonical, and read-only", async () => {
  const { service } = createFixture();
  const diagnostics = await service.refreshIndex();
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].provider, "codex");
  assert.equal(diagnostics[0].status, "ok");
  assert.equal(typeof diagnostics[0].durationMs, "number");
});

test("session_browse navigates provider, project, and session metadata with canonical parent filters", () => {
  const { service } = createFixture();
  const providers = service.browse({ level: "providers" });
  assert.deepEqual(providers.providers, [{ provider: "codex", available: true }]);
  assert.equal(providers.nextCursor, null);

  const projects = service.browse({ level: "projects", limit: 2 });
  assert.deepEqual(projects.projects.map((project) => project.directory), ["/secret", "/work/content"]);
  assert.ok(projects.nextCursor);
  const nextProjects = service.browse({ level: "projects", limit: 2, cursor: projects.nextCursor });
  assert.deepEqual(nextProjects.projects.map((project) => project.directory), ["/work/content-z", "/work/root"]);
  assert.equal(nextProjects.projects.at(-1).indexedCount, 2);
  assert.equal(nextProjects.nextCursor, null);

  const first = service.browse({ level: "sessions", title: "Needle", parent: null, limit: 1 });
  assert.deepEqual(first.sessions.map((session) => session.session.sessionId), ["hidden"]);
  assert.ok(first.nextCursor);
  const second = service.browse({ level: "sessions", title: "Needle", parent: null, limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.sessions.map((session) => session.session.sessionId), ["root"]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    service.browse({ level: "sessions", parent: { provider: "codex", sessionId: "root" } }).sessions.map((session) => session.session.sessionId),
    ["child"]
  );
  assert.throws(
    () => service.browse({ level: "projects", title: "Needle" }),
    (error) => error instanceof SessionHistoryError && error.code === "invalid_input"
  );
  assert.throws(
    () => service.browse({ level: "sessions", title: "Needle", cursor: projects.nextCursor }),
    (error) => error instanceof SessionHistoryError && error.code === "invalid_cursor"
  );
});

test("session_browse skips stale indexed rows without hiding later provider sessions", () => {
  const live = { id: "live", provider: "codex", parentId: null, title: "Live", directory: "/work", timeCreated: 1, timeUpdated: 10, messageCount: 1, tokenCount: null };
  const adapter = { id: "codex", name: "Codex", icon: "", detect: () => true, getDataPath: () => null,
    async *scan() { yield live; }, getSession: (id) => id === "live" ? live : null,
    getMessages: () => [], getTokenStats: () => [], searchMessages: () => [] };
  const indexed = [{ id: "stale", provider: "codex" }, { id: "live", provider: "codex" }];
  const service = createSessionHistoryService({ dependencies: {
    getAvailableProviders: () => [adapter], getAllProviders: () => [adapter],
    browseIndexedSessions: ({ limit, offset }) => indexed.slice(offset, offset + limit),
    browseIndexedProjects: () => [], getIndexedSessionChildren: () => [], findIndexedSessionMetadata: () => [],
    getIndexedCatalogRevision: () => "1"
  } });
  const first = service.browse({ level: "sessions", limit: 1 });
  assert.deepEqual(first.sessions, []);
  assert.ok(first.nextCursor);
  const second = service.browse({ level: "sessions", limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.sessions.map((session) => session.session.sessionId), ["live"]);
  assert.equal(second.nextCursor, null);
});

test("session_browse rejects a continuation after the index revision changes", () => {
  const { service, advanceCatalogRevision } = createFixture();
  const first = service.browse({ level: "sessions", limit: 1 });
  assert.ok(first.nextCursor);
  advanceCatalogRevision();
  assert.throws(
    () => service.browse({ level: "sessions", limit: 1, cursor: first.nextCursor }),
    (error) => error instanceof SessionHistoryError && error.code === "invalid_cursor"
  );
});

test("session-history service searches, pages events, exposes every provider-stored session, and requires explicit sensitive-content opt-in", () => {
  const { service, searchMessageCalls } = createFixture();
  const search = service.search({ query: "Needle" });
  assert.deepEqual(search.matches.map((match) => match.session.sessionId), ["hidden", "root", "content", "content-z"]);
  assert.equal(search.matches[0].matchField, "title");
  assert.equal(search.matches.some((match) => match.session.sessionId === "hidden"), true);
  const callsBeforeMetadataSearch = searchMessageCalls.count;
  assert.deepEqual(service.search({ query: "Needle", fields: ["title"] }).matches.map((match) => match.session.sessionId), ["hidden", "root"]);
  assert.deepEqual(service.search({ query: "Needle", fields: ["title", "directory"] }).matches.map((match) => match.session.sessionId), ["hidden", "root"]);
  assert.equal(searchMessageCalls.count, callsBeforeMetadataSearch, "metadata-only searches must not read provider message history");
  assert.deepEqual(service.search({ query: "Needle", fields: ["user"] }).matches.map((match) => match.session.sessionId), ["hidden", "root"]);
  assert.deepEqual(service.search({ query: "Needle", fields: ["user"] }).matches.map((match) => match.matchRole), ["user", "user"]);
  assert.deepEqual(service.search({ query: "Needle", fields: ["assistant"] }).matches.map((match) => match.session.sessionId), ["content", "content-z"]);
  assert.deepEqual(service.search({ query: "Needle", fields: ["assistant"] }).matches.map((match) => match.matchRole), ["assistant", "assistant"]);
  assert.deepEqual(service.search({ query: "Child", fields: ["title"], lineage: "children" }).matches.map((match) => match.session.sessionId), ["child"]);
  assert.deepEqual(service.search({ query: "Needle", fields: ["title"], lineage: "children" }).matches, []);

  const firstSearchPage = service.search({ query: "Needle", limit: 2 });
  assert.deepEqual(firstSearchPage.matches.map((match) => match.session.sessionId), ["hidden", "root"]);
  assert.ok(firstSearchPage.nextCursor);
  assert.equal(firstSearchPage.truncated, true);
  const secondSearchPage = service.search({ query: "Needle", limit: 2, cursor: firstSearchPage.nextCursor });
  assert.deepEqual(secondSearchPage.matches.map((match) => match.session.sessionId), ["content", "content-z"]);
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
  assert.equal(overview.firstMessage.event.messageId, "m1");
  assert.equal(overview.firstMessage.preview, "Needle in a user message");
  assert.equal(overview.lastMessage.event.messageId, "m2");
  assert.equal(overview.lastMessage.preview, "I will inspect it");
  assert.deepEqual(overview.children.map((child) => child.session.sessionId), ["child"]);
  assert.deepEqual(overview.roleCounts, { user: 1, assistant: 2, system: 0, tool: 1 });
  assert.deepEqual(overview.toolNames, [{ toolName: "Read", count: 1 }]);
  assert.equal(overview.toolNamesTruncated, false);

  const timeline = service.timeline({ session: { provider: "codex", sessionId: "root" }, limit: 2 });
  assert.deepEqual(timeline.events.map((event) => event.event.segment), ["message", "message"]);
  assert.ok(timeline.nextCursor);
  const next = service.timeline({ session: { provider: "codex", sessionId: "root" }, limit: 2, cursor: timeline.nextCursor });
  assert.deepEqual(next.events.map((event) => event.event.segment), ["tool"]);
  assert.equal(
    service.timeline({ session: { provider: "codex", sessionId: "root" }, segments: ["message"] }).events
      .some((event) => event.event.messageId === "m-empty"),
    false
  );
  assert.throws(
    () => service.getEvent({ event: { provider: "codex", sessionId: "root", messageId: "m-empty", segment: "message" } }),
    (error) => error instanceof SessionHistoryError && error.code === "event_not_found"
  );
  assert.throws(
    () => service.timeline({ session: { provider: "codex", sessionId: "root" }, segments: ["thinking"], cursor: timeline.nextCursor }),
    (error) => error instanceof SessionHistoryError && error.code === "invalid_cursor"
  );

  const thinking = service.timeline({ session: { provider: "codex", sessionId: "root" }, segments: ["thinking"] });
  assert.equal(thinking.events.length, 1);
  assert.deepEqual(service.timeline({ session: { provider: "codex", sessionId: "root" }, query: "Needle" }).events.map((event) => event.event.messageId), ["m1"]);
  assert.deepEqual(service.timeline({ session: { provider: "codex", sessionId: "root" }, query: "Read" }).events.map((event) => event.event.messageId), ["m3"]);
  assert.deepEqual(service.timeline({ session: { provider: "codex", sessionId: "root" }, query: "secret.txt" }).events, []);
  assert.deepEqual(service.timeline({ session: { provider: "codex", sessionId: "root" }, segments: ["thinking"], query: "bounded" }).events.map((event) => event.event.messageId), ["m2"]);
  const context = service.getContext({ event: next.events[0].event, before: 1, after: 1 });
  assert.equal(context.target.segment, "tool");
  assert.equal(context.events.length, 2);
  assert.equal(context.events.some((event) => event.event.segment === "thinking"), false);
  const thinkingContext = service.getContext({ event: next.events[0].event, before: 2, after: 1, includeThinking: true });
  assert.equal(thinkingContext.events.some((event) => event.preview === "Need a bounded plan"), true);
  assert.throws(
    () => service.getContext({ event: thinking.events[0].event }),
    (error) => error instanceof SessionHistoryError && error.code === "thinking_opt_in_required"
  );

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
  assert.equal(toolOutput.toolOutput.totalChars, 28);
  assert.deepEqual(toolOutput.continuations.toolOutput, {
    event: { provider: "codex", sessionId: "root", messageId: "m3", segment: "tool" },
    includeToolOutput: true,
    offset: 8,
    maxChars: 8
  });

  const hiddenOverview = service.get({ session: { provider: "codex", sessionId: "hidden" } });
  assert.equal(hiddenOverview.session.sessionId, "hidden");
  assert.equal(hiddenOverview.messageCount, 1);
  assert.deepEqual(hiddenOverview.children, []);
});

test("session_search pages beyond 100 candidates with duplicate messages, cross-provider order, filters, and cursor identity", () => {
  const codexSessions = Array.from({ length: 145 }, (_, index) => ({
    id: `s${String(index).padStart(3, "0")}`, provider: "codex", title: index < 105 ? `Needle title ${index}` : `Other ${index}`,
    directory: index % 2 ? "/work/odd" : "/work/even", timeCreated: index,
    timeUpdated: 1000 + index, messageCount: 1, tokenCount: 0
  }));
  const piSessions = Array.from({ length: 5 }, (_, index) => ({
    id: `p${index}`, provider: "pi", title: `Needle Pi ${index}`, directory: "/work/even",
    timeCreated: index, timeUpdated: 1200 + index, messageCount: 0, tokenCount: 0
  }));
  const makeAdapter = (id, sessions) => {
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const messageHits = id === "codex" ? [
      ...Array.from({ length: 115 }, (_, index) => ({
        sessionId: "s000", messageId: `repeat-${index}`, role: "assistant", snippet: "Needle repeated", timestamp: index
      })),
      ...codexSessions.slice(105).map((session) => ({
        sessionId: session.id, messageId: `m-${session.id}`, role: "user", snippet: "Needle message", timestamp: 1
      }))
    ] : [];
    return {
      id, name: id, detect: () => true, getDataPath: () => null,
      async *scan() { yield* sessions; },
      getSession: (sessionId) => byId.get(sessionId) || null,
      getMessages: () => [], getTokenStats: () => [],
      searchMessages: (_query, limit = 20, offset = 0) => messageHits.slice(offset, offset + limit)
    };
  };
  const adapters = [makeAdapter("codex", codexSessions), makeAdapter("pi", piSessions)];
  const indexed = new Map([["codex", codexSessions.slice(0, 105)], ["pi", piSessions]]);
  const service = createSessionHistoryService({
    dependencies: {
      getAvailableProviders: () => adapters,
      getAllProviders: () => adapters,
      findIndexedSessionMetadata: (provider, _query, limit, _after, _before, offset = 0) =>
        (indexed.get(provider) || []).slice(offset, offset + limit),
      getIndexedSessionChildren: () => []
    }
  });
  const ids = [];
  let cursor;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const page = service.search({ query: "Needle", providers: ["codex", "pi"], limit: 13, ...(cursor ? { cursor } : {}) });
    assert.deepEqual(page.diagnostics.map((item) => item.status), ["ok", "ok"]);
    ids.push(...page.matches.map((match) => `${match.session.provider}/${match.session.sessionId}`));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  assert.equal(cursor, null);
  assert.equal(ids.length, 150);
  assert.equal(new Set(ids).size, 150);
  assert.deepEqual(ids.slice(0, 5), ["pi/p4", "pi/p3", "pi/p2", "pi/p1", "pi/p0"]);
  assert.equal(ids.at(-1), "codex/s105");

  const even = service.search({ query: "Needle", directory: "/work/even", updatedAfter: 1100, limit: 100 });
  assert.equal(even.matches.every((match) => match.directory === "/work/even" && match.updatedAt >= 1100), true);
  assert.equal(even.matches.some((match) => match.session.provider === "pi"), true);
  const first = service.search({ query: "Needle", providers: ["codex"], limit: 1 });
  assert.throws(
    () => service.search({ query: "Needle", providers: ["pi"], limit: 1, cursor: first.nextCursor }),
    (error) => error instanceof SessionHistoryError && error.code === "invalid_cursor"
  );
});

test("session_search streams file matches once per request and retains the first message hit", () => {
  const sessions = [
    { id: "title", title: "Needle title", directory: "/work/a", timeUpdated: 300 },
    { id: "repeated", title: "Other", directory: "/work/a", timeUpdated: 200 },
    { id: "late", title: "Other", directory: "/work/a", timeUpdated: 100 }
  ];
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const counts = { scans: 0, yielded: 0, getSession: new Map(), batches: 0 };
  const adapter = {
    id: "codex", name: "Codex", detect: () => true, getDataPath: () => null,
    async *scan() { yield* sessions; },
    getSession(id) {
      counts.getSession.set(id, (counts.getSession.get(id) || 0) + 1);
      return byId.get(id) || null;
    },
    getMessages: () => [], getTokenStats: () => [],
    searchMessages() { counts.batches += 1; throw new Error("streaming provider should not page"); },
    *iterateSearchMessages() {
      counts.scans += 1;
      for (const session of [byId.get("title"), byId.get("repeated"), byId.get("late")]) {
        const size = session.id === "repeated" ? 115 : 1;
        for (let index = 0; index < size; index += 1) {
          counts.yielded += 1;
          yield { session, match: {
            sessionId: session.id, messageId: `${session.id}-${index}`, role: "user",
            snippet: `Needle ${session.id} ${index}`, timestamp: index
          } };
        }
      }
    }
  };
  const service = createSessionHistoryService({ dependencies: {
    getAvailableProviders: () => [adapter], getAllProviders: () => [adapter],
    findIndexedSessionMetadata: (_provider, _query, _limit, _after, _before, offset) =>
      offset ? [] : [byId.get("title")],
    getIndexedSessionChildren: () => []
  } });
  const first = service.search({ query: "Needle", providers: ["codex"], limit: 1 });
  const second = service.search({ query: "Needle", providers: ["codex"], limit: 1, cursor: first.nextCursor });
  const third = service.search({ query: "Needle", providers: ["codex"], limit: 1, cursor: second.nextCursor });
  assert.deepEqual([first, second, third].flatMap((page) => page.matches.map((match) => match.session.sessionId)),
    ["title", "repeated", "late"]);
  assert.deepEqual(second.matches[0].event, {
    provider: "codex", sessionId: "repeated", messageId: "repeated-0", segment: "message"
  });
  assert.equal(second.matches[0].snippet, "Needle repeated 0");
  assert.equal(third.nextCursor, null);
  assert.equal(counts.scans, 3);
  assert.equal(counts.yielded, 351);
  assert.equal(counts.batches, 0);
  assert.equal(counts.getSession.get("title"), 3);
  assert.equal(counts.getSession.has("repeated"), false);
  assert.equal(counts.getSession.has("late"), false);
});

test("session_search caches metadata and repeated batched hits within a request", () => {
  const session = { id: "same", title: "Needle title", directory: "/work", timeUpdated: 100 };
  let reads = 0;
  const adapter = {
    id: "codex", name: "Codex", detect: () => true, getDataPath: () => null,
    async *scan() { yield session; },
    getSession() { reads += 1; return session; },
    getMessages: () => [], getTokenStats: () => [],
    searchMessages: (_query, limit, offset) => offset >= 105 ? []
      : Array.from({ length: Math.min(limit, 105 - offset) }, (_, index) => ({
          sessionId: "same", messageId: `m${offset + index}`, snippet: "Needle", role: "user", timestamp: 1
        }))
  };
  const service = createSessionHistoryService({ dependencies: {
    getAvailableProviders: () => [adapter], getAllProviders: () => [adapter],
    findIndexedSessionMetadata: (_provider, _query, _limit, _after, _before, offset) => offset ? [] : [session],
    getIndexedSessionChildren: () => []
  } });
  assert.equal(service.search({ query: "Needle", providers: ["codex"] }).matches[0].matchField, "title");
  assert.equal(reads, 1);
});

test("indexed metadata search returns batches after the first 100", () => {
  const sessions = Array.from({ length: 125 }, (_, index) => ({
    id: `indexed-${index}`, title: `Needle ${index}`, directory: "/work/indexed", parentId: null,
    timeCreated: index, timeUpdated: index + 1, messageCount: 0, tokenCount: 0
  }));
  upsertIndex("codex", sessions);
  const first = findIndexedSessionMetadata("codex", "Needle", 100);
  const second = findIndexedSessionMetadata("codex", "Needle", 100, undefined, undefined, 100);
  assert.equal(first.length, 100);
  assert.equal(second.length, 25);
  assert.equal(new Set([...first, ...second].map((session) => session.id)).size, 125);
  closeIndexDb();
});

test("file-backed normalized message search offsets after filtering", () => {
  const entries = [{ session: { id: "one" }, messages: [
    { id: "system", role: "system", content: "Needle" },
    ...Array.from({ length: 105 }, (_, index) => ({ id: `m${index}`, role: "assistant", content: "Needle" }))
  ] }];
  assert.deepEqual(
    searchNormalizedMessages(entries, "Needle", 10, 100).map((result) => result.messageId),
    ["m100", "m101", "m102", "m103", "m104"]
  );
  assert.deepEqual(searchNormalizedMessages(entries, "Needle", 10, 105), []);
});

test("session-history ignores viewer hidden/permanent-excluded metadata; provider local storage is authoritative", () => {
  const { service } = createFixture();
  getMetaDb();
  softDelete("codex", "hidden");
  permanentDelete("codex", "hidden");
  assert.ok(getExcludedIds("codex").has("hidden"), "fixture session must actually be viewer-excluded");

  const search = service.search({ query: "Needle" });
  assert.equal(search.matches.some((match) => match.session.sessionId === "hidden"), true);

  const overview = service.get({ session: { provider: "codex", sessionId: "hidden" } });
  assert.equal(overview.session.sessionId, "hidden");
  assert.equal(overview.messageCount, 1);

  const eventRef = { provider: "codex", sessionId: "hidden", messageId: "hidden-1", segment: "message" };
  const timeline = service.timeline({ session: { provider: "codex", sessionId: "hidden" } });
  assert.deepEqual(timeline.events.map((event) => event.event), [eventRef]);
  assert.equal(service.getEvent({ event: eventRef }).content.text, "Needle in a viewer-excluded session");
  const context = service.getContext({ event: eventRef, before: 1, after: 1 });
  assert.deepEqual(context.target, eventRef);
  assert.deepEqual(context.events.map((event) => event.event), [eventRef]);
});

test("session-history default search diagnoses unavailable registered providers", () => {
  const unavailable = {
    id: "pi",
    name: "Fixture Pi",
    icon: "",
    detect: () => false,
    getDataPath: () => null,
    async *scan() {},
    getSession: () => null,
    getMessages: () => [],
    getTokenStats: () => [],
    searchMessages: () => []
  };
  const diagnosticService = createSessionHistoryService({
    dependencies: {
      getAvailableProviders: () => [],
      getAllProviders: () => [unavailable],
      findIndexedSessionMetadata: () => [],
      getIndexedSessionChildren: () => []
    }
  });
  assert.deepEqual(diagnosticService.search({ query: "Needle" }).diagnostics, [
    { provider: "pi", status: "unavailable" }
  ]);
});

test("session_get returns null previews when a session has no visible messages", () => {
  const { service } = createFixture();
  const overview = service.get({ session: { provider: "codex", sessionId: "child" } });
  assert.equal(overview.messageCount, 0);
  assert.equal(overview.firstMessage, null);
  assert.equal(overview.lastMessage, null);
});

test("session_get pages every indexed direct child through the MCP cursor", async (t) => {
  const parent = {
    id: "many-children-root", title: "Root", directory: "/work/many-children", parentId: null,
    timeCreated: 1, timeUpdated: 2000, messageCount: 0, tokenCount: 0
  };
  const children = Array.from({ length: 172 }, (_, index) => ({
    id: `many-children-${String(index).padStart(3, "0")}`, title: `Child ${index}`,
    directory: parent.directory, parentId: parent.id, timeCreated: index + 2,
    timeUpdated: 1000 - index, messageCount: 0, tokenCount: 0
  }));
  upsertIndex("codex", [parent, ...children]);
  t.after(closeIndexDb);
  const sessions = new Map([parent, ...children].map((session) => [session.id, session]));
  const adapter = {
    id: "codex", name: "Codex", detect: () => true, getDataPath: () => null,
    async *scan() { yield* sessions.values(); },
    getSession: (id) => sessions.get(id) || null,
    getMessages: () => [], getTokenStats: () => [], searchMessages: () => []
  };
  const service = createSessionHistoryService({ dependencies: {
    getAvailableProviders: () => [adapter], getAllProviders: () => [adapter]
  } });
  const server = createSessionHistoryMcpServer(service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agentsession-mcp-child-pages", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const getTool = (await client.listTools()).tools.find((tool) => tool.name === "session_get");
  assert.ok(getTool.inputSchema.properties.childCursor);
  assert.equal(getTool.inputSchema.properties.childLimit.maximum, 100);
  const session = { provider: "codex", sessionId: parent.id };
  const observed = [];
  const pageSizes = [];
  let childCursor;
  let firstCursor;
  do {
    const response = await client.callTool({ name: "session_get", arguments: { session, ...(childCursor ? { childCursor } : {}) } });
    assert.equal(response.isError, undefined);
    const result = response.structuredContent.result;
    pageSizes.push(result.children.length);
    observed.push(...result.children.map((child) => child.session.sessionId));
    assert.equal(result.childrenTruncated, result.childrenNextCursor !== null);
    assert.equal(response.content[0].text.includes("more indexed candidates"), result.childrenTruncated);
    childCursor = result.childrenNextCursor;
    firstCursor ||= childCursor;
  } while (childCursor);
  assert.deepEqual(pageSizes, [50, 50, 50, 22]);
  assert.deepEqual(observed, children.map((child) => child.id));

  const largerPage = await client.callTool({ name: "session_get", arguments: { session, childLimit: 100 } });
  assert.equal(largerPage.structuredContent.result.children.length, 100);
  assert.equal(largerPage.structuredContent.result.childrenTruncated, true);
  const wrongParent = await client.callTool({ name: "session_get", arguments: {
    session: { provider: "codex", sessionId: children[0].id }, childCursor: firstCursor
  } });
  assert.equal(wrongParent.isError, true);
  assert.match(wrongParent.content[0].text, /cursor is invalid for this request/);
  const invalid = await client.callTool({ name: "session_get", arguments: { session, childLimit: 101 } });
  assert.equal(invalid.isError, true);
});

test("session_get skips stale indexed children while advancing by index position", () => {
  const parent = { id: "parent", provider: "opencode", parentId: null, title: "Parent", timeUpdated: 10 };
  const first = { id: "first", provider: "opencode", parentId: parent.id, title: "Current first", timeUpdated: 9 };
  const moved = { id: "moved", provider: "opencode", parentId: "another-parent", title: "Moved", timeUpdated: 7 };
  const second = { id: "second", provider: "opencode", parent_id: parent.id, title: "Current second", timeUpdated: 5 };
  const source = new Map([parent, first, moved, second].map((session) => [session.id, session]));
  const indexed = [
    { ...first, title: "Outdated first" },
    { id: "missing", parentId: parent.id },
    { ...moved, parentId: parent.id },
    { id: "wrong-id", parentId: parent.id },
    second
  ];
  const checkedChildren = [];
  const adapter = {
    id: "opencode", name: "OpenCode", detect: () => true, getDataPath: () => null,
    async *scan() { yield* source.values(); },
    getSession(id) {
      if (id !== parent.id) checkedChildren.push(id);
      return id === "wrong-id" ? { ...second, id: "different-id" } : source.get(id) || null;
    },
    getMessages: () => [], getTokenStats: () => [], searchMessages: () => []
  };
  const service = createSessionHistoryService({ dependencies: {
    getAvailableProviders: () => [adapter], getAllProviders: () => [adapter],
    getIndexedSessionChildren: (_provider, _parentId, limit, offset) => indexed.slice(offset, offset + limit)
  } });
  const session = { provider: "opencode", sessionId: parent.id };
  const pages = [];
  let childCursor;
  do {
    const previousChecks = checkedChildren.length;
    const page = service.get({ session, childLimit: 2, ...(childCursor ? { childCursor } : {}) });
    assert.ok(checkedChildren.length - previousChecks <= 2);
    pages.push(page);
    childCursor = page.childrenNextCursor;
  } while (childCursor);
  assert.deepEqual(pages.map((page) => page.children.map((child) => child.session.sessionId)),
    [["first"], [], ["second"]]);
  assert.equal(pages[0].children[0].title, "Current first");
  assert.deepEqual(pages[2].children[0].parent, session);
  assert.deepEqual(pages.map((page) => page.childrenTruncated), [true, true, false]);
  assert.deepEqual(checkedChildren, ["first", "missing", "moved", "wrong-id", "second"]);
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

  const adapter = createOpenCodeSqliteAdapter({
    id: "opencode",
    name: "Fixture OpenCode",
    defaultDataPath: () => dbPath
  });
  const service = createSessionHistoryService({
    dependencies: {
      getAvailableProviders: () => [adapter],
      getAllProviders: () => [adapter],
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

test("OpenCode SQLite message search continues after 100 duplicate session hits", () => {
  const dbPath = path.join(temp, "opencode-search-duplicates.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT, title TEXT, slug TEXT,
      directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
  `);
  const putSession = db.prepare("INSERT INTO session VALUES (?, NULL, 'project', 'Other', 'other', '/work', 1, ?, NULL)");
  const putMessage = db.prepare("INSERT INTO message VALUES (?, ?, ?)");
  const putPart = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)");
  for (const [id, updated] of [["repeated", 200], ["late", 100]]) {
    putSession.run(id, updated);
    putMessage.run(`msg-${id}`, id, JSON.stringify({ role: "user", time: { created: updated } }));
  }
  for (let index = 0; index < 105; index += 1) {
    putPart.run(`part-${String(index).padStart(3, "0")}`, "msg-repeated", "repeated", JSON.stringify({ type: "text", text: "Needle repeated" }));
  }
  putPart.run("part-late", "msg-late", "late", JSON.stringify({ type: "text", text: "Needle late" }));
  db.close();
  const adapter = createOpenCodeSqliteAdapter({ id: "opencode", name: "OpenCode", defaultDataPath: () => dbPath });
  assert.equal(adapter.searchMessages("Needle", 100, 0).length, 100);
  assert.equal(adapter.searchMessages("Needle", 100, 100).length, 6);
  const service = createSessionHistoryService({ dependencies: {
    getAvailableProviders: () => [adapter], getAllProviders: () => [adapter],
    findIndexedSessionMetadata: () => [], getIndexedSessionChildren: () => []
  } });
  assert.deepEqual(service.search({ query: "Needle" }).matches.map((match) => match.session.sessionId), ["repeated", "late"]);
  closeDb(dbPath);
});

test("AgentSession-MCP exposes hierarchical read-only tools over the MCP protocol", async (t) => {
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

  const mcpPackage = JSON.parse(readFileSync(path.join(
    process.cwd(), "packages", "agentsession-mcp", "package.json"
  ), "utf8"));
  assert.equal(client.getServerVersion()?.version, mcpPackage.version);

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "session_browse",
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
    "pi",
    "deepseek-harness"
  ]);
  assert.equal(
    searchTool.inputSchema.properties.providers.maxItems,
    searchTool.inputSchema.properties.providers.items.enum.length
  );
  assert.ok(searchTool.inputSchema.properties.directory);
  assert.ok(searchTool.inputSchema.properties.cursor);
  assert.ok(searchTool.inputSchema.properties.fields);
  assert.ok(searchTool.inputSchema.properties.lineage);
  assert.match(searchTool.description, /Viewer hidden, deleted, and excluded metadata is ignored/i);
  const browseTool = tools.tools.find((tool) => tool.name === "session_browse");
  assert.deepEqual(browseTool.inputSchema.properties.level.enum, ["providers", "projects", "sessions"]);
  const contextTool = tools.tools.find((tool) => tool.name === "session_get_context");
  assert.equal(contextTool.inputSchema.properties.includeThinking.type, "boolean");

  const browsedProviders = await client.callTool({ name: "session_browse", arguments: { level: "providers" } });
  assert.equal(browsedProviders.isError, undefined);
  assert.deepEqual(browsedProviders.structuredContent.result.providers, [{ provider: "codex", available: true }]);
  const browsedProjects = await client.callTool({ name: "session_browse", arguments: {
    level: "projects", providers: ["codex"], directory: "/work/root"
  } });
  assert.equal(browsedProjects.isError, undefined);
  assert.deepEqual(browsedProjects.structuredContent.result.projects, [
    { provider: "codex", directory: "/work/root", indexedCount: 2 }
  ]);
  const browsedSessions = await client.callTool({ name: "session_browse", arguments: {
    level: "sessions", providers: ["codex"], directory: browsedProjects.structuredContent.result.projects[0].directory, parent: null
  } });
  assert.equal(browsedSessions.isError, undefined);
  assert.deepEqual(browsedSessions.structuredContent.result.sessions.map((session) => session.session.sessionId), ["root"]);

  const browse = await client.callTool({ name: "session_browse", arguments: { level: "sessions", title: "Needle", parent: null, limit: 1 } });
  assert.equal(browse.isError, undefined);
  assert.deepEqual(browse.structuredContent.result.sessions.map((session) => session.session.sessionId), ["hidden"]);
  assert.ok(browse.structuredContent.result.nextCursor);
  const searchedUsers = await client.callTool({ name: "session_search", arguments: { query: "Needle", fields: ["user"] } });
  assert.equal(searchedUsers.isError, undefined);
  assert.deepEqual(searchedUsers.structuredContent.result.matches.map((match) => match.session.sessionId), ["hidden", "root"]);
  const searchedAssistant = await client.callTool({ name: "session_search", arguments: { query: "Needle", fields: ["assistant"] } });
  assert.equal(searchedAssistant.isError, undefined);
  assert.deepEqual(searchedAssistant.structuredContent.result.matches.map((match) => match.session.sessionId), ["content", "content-z"]);
  const searchedDirectory = await client.callTool({ name: "session_search", arguments: { query: "/work/root", fields: ["directory"] } });
  assert.equal(searchedDirectory.isError, undefined);
  assert.deepEqual(searchedDirectory.structuredContent.result.matches.map((match) => match.session.sessionId), ["root", "child"]);
  assert.ok(searchedDirectory.structuredContent.result.matches.every((match) => match.matchField === "directory" && match.matchRole === null));
  const sessionOverview = await client.callTool({ name: "session_get", arguments: { session: { provider: "codex", sessionId: "root" } } });
  assert.equal(sessionOverview.isError, undefined);
  assert.deepEqual(sessionOverview.structuredContent.result.roleCounts, { user: 1, assistant: 2, system: 0, tool: 1 });
  assert.deepEqual(sessionOverview.structuredContent.result.toolNames, [{ toolName: "Read", count: 1 }]);
  assert.equal(sessionOverview.structuredContent.result.toolNamesTruncated, false);
  const timelineQuery = await client.callTool({ name: "session_timeline", arguments: {
    session: { provider: "codex", sessionId: "root" }, query: "Read", segments: ["tool"]
  } });
  assert.deepEqual(timelineQuery.structuredContent.result.events.map((entry) => entry.event.messageId), ["m3"]);
  const response = await client.callTool({ name: "session_search", arguments: { query: "Needle" } });
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent.result.matches.length, 4);
  const event = { provider: "codex", sessionId: "root", messageId: "m2", segment: "message" };
  const context = await client.callTool({ name: "session_get_context", arguments: { event, after: 2 } });
  assert.equal(context.isError, undefined);
  assert.equal(context.structuredContent.result.events.some((item) => item.event.segment === "thinking"), false);
  assert.equal(JSON.stringify(context.structuredContent).includes("Need a bounded plan"), false);
  const optedContext = await client.callTool({ name: "session_get_context", arguments: { event, after: 2, includeThinking: true } });
  assert.equal(optedContext.structuredContent.result.events.some((item) => item.preview === "Need a bounded plan"), true);
  const rejectedThinking = await client.callTool({ name: "session_get_context", arguments: {
    event: { ...event, segment: "thinking" }
  } });
  assert.equal(rejectedThinking.isError, true);
  const invalid = await client.callTool({ name: "session_get", arguments: {
    session: { provider: "codex", sessionId: "root" },
    unexpected: true
  } });
  assert.equal(invalid.isError, true);
  for (const provider of ["openclaw", "hermes"]) {
    const retiredRef = await client.callTool({ name: "session_get", arguments: {
      session: { provider, sessionId: "legacy" }
    } });
    assert.equal(retiredRef.isError, true);
    const retiredSearch = await client.callTool({ name: "session_search", arguments: {
      query: "legacy", providers: [provider]
    } });
    assert.equal(retiredSearch.isError, true);
  }
});

test("session_search cursor stays within MCP schema for a long directory and resumes over InMemoryTransport", async (t) => {
  const directory = `/work/${"x".repeat(1615)}`;
  const sessions = [
    { id: "newer", provider: "codex", title: "Needle newer", directory, timeCreated: 10, timeUpdated: 20 },
    { id: "older", provider: "codex", title: "Needle older", directory, timeCreated: 5, timeUpdated: 10 }
  ];
  const adapter = {
    id: "codex", name: "Codex", detect: () => true, getDataPath: () => null,
    async *scan() { yield* sessions; },
    getSession: (id) => sessions.find((session) => session.id === id) || null,
    getMessages: () => [], getTokenStats: () => [], searchMessages: () => []
  };
  const service = createSessionHistoryService({ dependencies: {
    getAvailableProviders: () => [adapter], getAllProviders: () => [adapter],
    findIndexedSessionMetadata: (_provider, _query, limit, _after, _before, offset = 0) => sessions.slice(offset, offset + limit),
    getIndexedSessionChildren: () => []
  } });
  const server = createSessionHistoryMcpServer(service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "long-directory-cursor-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });

  const first = await client.callTool({ name: "session_search", arguments: { query: "Needle", directory, limit: 1 } });
  assert.equal(first.isError, undefined);
  assert.deepEqual(first.structuredContent.result.matches.map((match) => match.session.sessionId), ["newer"]);
  const cursor = first.structuredContent.result.nextCursor;
  assert.ok(cursor);
  assert.ok(cursor.length < 4000, `cursor length ${cursor.length} must satisfy the MCP input schema`);
  const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(decoded.after).sort(), ["key", "rank", "updatedAt"]);
  assert.equal(decoded.fingerprint.length, 43);
  const second = await client.callTool({ name: "session_search", arguments: { query: "Needle", directory, limit: 1, cursor } });
  assert.equal(second.isError, undefined);
  assert.deepEqual(second.structuredContent.result.matches.map((match) => match.session.sessionId), ["older"]);
  assert.equal(second.structuredContent.result.nextCursor, null);
});

test("compiled stdio executable serves legacy and 2026-07-28 MCP without polluting stdout", async (t) => {
  const configPath = path.join(temp, "mcp-config.json");
  writeFileSync(configPath, JSON.stringify({ mcp: { searchLimit: 10, timelineLimit: 10, eventMaxChars: 1000, contextWindow: 2 } }));
  const executable = path.join(process.cwd(), "packages", "agentsession-mcp", "dist", "cli.js");
  const emptyProviderRoot = path.join(temp, "empty-providers");
  mkdirSync(emptyProviderRoot);
  const createTransport = () => new StdioClientTransport({
    command: process.execPath,
    args: [executable, "--config", configPath,
      "--opencode-db", path.join(emptyProviderRoot, "opencode.db"),
      "--claude-dir", path.join(emptyProviderRoot, "claude"),
      "--codex-dir", path.join(emptyProviderRoot, "codex"),
      "--pi-dir", path.join(emptyProviderRoot, "pi"),
      "--dsh-dir", path.join(emptyProviderRoot, "dsh")],
    env: { ...process.env, AGENTSESSION_META_PATH: path.join(temp, "stdio-meta.db") },
    stderr: "pipe"
  });

  const legacyClient = new Client({ name: "agentsession-mcp-legacy-stdio-test", version: "1.0.0" });
  await legacyClient.connect(createTransport());
  t.after(async () => legacyClient.close());
  assert.equal(legacyClient.getProtocolEra(), "legacy");
  const legacyTools = await legacyClient.listTools();
  assert.equal(legacyTools.tools.length, 6);

  const modernClient = new Client(
    { name: "agentsession-mcp-modern-stdio-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  await modernClient.connect(createTransport());
  t.after(async () => modernClient.close());
  assert.equal(modernClient.getProtocolEra(), "modern");
  const tools = await modernClient.listTools();
  assert.equal(tools.tools.length, 6);
  const search = await modernClient.callTool({ name: "session_search", arguments: { query: "does-not-exist" } });
  assert.equal(search.isError, undefined);
});

test("interactive installer writes user-scoped auto-updating MCP configurations", () => {
  const home = mkdtempSync(path.join(temp, "mcp-installer-"));
  const agentConfig = path.join(home, "agentsession.json");
  writeFileSync(agentConfig, JSON.stringify({ mcp: { searchLimit: 10 } }));
  const context = { home, cwd: home, env: {}, platform: "linux" };

  const codexPath = getInstallConfigPath("codex", context);
  mkdirSync(path.dirname(codexPath), { recursive: true });
  writeFileSync(codexPath, "[mcp_servers.other]\ncommand = \"other-server\"\n");

  for (const target of ["codex", "claude-code", "opencode"]) {
    const result = installIntoTarget(target, { ...context, configPath: agentConfig });
    assert.equal(result.status, "installed");
  }

  const codex = readFileSync(codexPath, "utf8");
  assert.match(codex, /\[mcp_servers\.other\]/);
  assert.match(codex, /\[mcp_servers\.agentsession\]/);
  assert.match(codex, new RegExp(AUTO_UPDATE_PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(codex, /--prefer-online/);
  assert.match(codex, /AGENTSESSION_CONFIG/);

  const claude = JSON.parse(readFileSync(getInstallConfigPath("claude-code", context), "utf8"));
  const opencode = JSON.parse(readFileSync(getInstallConfigPath("opencode", context), "utf8"));
  for (const config of [claude]) {
    assert.equal(config.mcpServers.agentsession.command, "npx");
    assert.ok(config.mcpServers.agentsession.args.includes(AUTO_UPDATE_PACKAGE));
    assert.equal(config.mcpServers.agentsession.env.AGENTSESSION_CONFIG, agentConfig);
  }
  assert.deepEqual(opencode.mcp.agentsession.command.slice(0, 2), ["npx", "--yes"]);
  assert.ok(opencode.mcp.agentsession.command.includes(AUTO_UPDATE_PACKAGE));
  assert.equal(opencode.mcp.agentsession.environment.AGENTSESSION_CONFIG, agentConfig);
});

test("installer recognizes a commented Codex table header before replacing it", () => {
  const home = mkdtempSync(path.join(temp, "mcp-installer-toml-"));
  const context = { home, cwd: home, env: {}, platform: "linux" };
  const codexPath = getInstallConfigPath("codex", context);
  mkdirSync(path.dirname(codexPath), { recursive: true });
  writeFileSync(codexPath, [
    "[mcp_servers.agentsession] # legacy entry",
    "command = \"legacy-mcp\"",
    "",
    "[mcp_servers.other] # preserve this entry",
    "command = \"other-mcp\"",
    ""
  ].join("\n"));

  assert.equal(installIntoTarget("codex", context).status, "needs-replace");
  assert.equal(installIntoTarget("codex", { ...context, replace: true }).status, "updated");
  const config = readFileSync(codexPath, "utf8");
  assert.equal([...config.matchAll(/\[mcp_servers\.agentsession\]/g)].length, 1);
  assert.match(config, /\[mcp_servers\.other\] # preserve this entry/);
});

test("installer parses an explicit update and uses a Windows-safe launcher", () => {
  assert.deepEqual(parseInstallerCommand(["update", "--target", "codex,opencode", "--yes"]), {
    action: "update",
    options: { targets: ["codex", "opencode"], yes: true }
  });
  assert.throws(() => parseInstallerCommand(["install", "--target", "copilot", "--yes"]), /Unsupported install target/);
  assert.deepEqual(createAutoUpdateLauncher(undefined, { platform: "win32" }), {
    command: "cmd.exe",
    args: [
      "/d",
      "/v:off",
      "/s",
      "/c",
      `npx.cmd --yes --prefer-online ${AUTO_UPDATE_PACKAGE}`
    ]
  });
});

test("compiled CLI configures a selected host without an interactive prompt", () => {
  const home = mkdtempSync(path.join(temp, "mcp-installer-cli-"));
  const agentConfig = path.join(home, "agentsession.json");
  const codexHome = path.join(home, "codex-home");
  writeFileSync(agentConfig, JSON.stringify({ mcp: { searchLimit: 10 } }));
  const executable = path.join(process.cwd(), "packages", "agentsession-mcp", "dist", "cli.js");
  const result = spawnSync(process.execPath, [
    executable,
    "install",
    "--target", "codex",
    "--config", agentConfig,
    "--yes"
  ], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: codexHome, HOME: home, USERPROFILE: home }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Codex: installed auto-updating MCP config/);
  const config = readFileSync(path.join(codexHome, "config.toml"), "utf8");
  assert.match(config, /AGENTSESSION_CONFIG/);
  assert.match(config, /--prefer-online/);
});

test("compiled MCP executable has MCP-specific help", () => {
  const executable = path.join(process.cwd(), "packages", "agentsession-mcp", "dist", "cli.js");
  const result = spawnSync(process.execPath, [executable, "--help"], {
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" }
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /AgentSession-MCP/);
  assert.match(result.stdout, /agentsession-mcp \[options\]/);
  assert.match(result.stdout, /agentsession-mcp install/);
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

test("AgentSession configuration ignores retired OpenSessionViewer variables", () => {
  const currentConfig = path.join(temp, "current-config.json");
  const legacyConfig = path.join(temp, "legacy-config.json");
  writeFileSync(currentConfig, JSON.stringify({ mcp: { searchLimit: 7 } }));
  writeFileSync(legacyConfig, JSON.stringify({ mcp: { searchLimit: 9 } }));
  const previousCurrent = process.env.AGENTSESSION_CONFIG;
  const previousLegacy = process.env.OPENSESSIONVIEWER_CONFIG;
  const previousMetaPath = process.env.AGENTSESSION_META_PATH;
  const previousAppData = process.env.APPDATA;
  process.env.AGENTSESSION_CONFIG = currentConfig;
  process.env.OPENSESSIONVIEWER_CONFIG = legacyConfig;
  delete process.env.AGENTSESSION_META_PATH;
  try {
    assert.equal(parseArgs([]).mcp.searchLimit, 7);
    delete process.env.AGENTSESSION_CONFIG;
    process.env.APPDATA = path.join(temp, "isolated-appdata");
    const ignoredLegacy = parseArgs([]);
    assert.equal(ignoredLegacy.mcp.searchLimit, 20);
    assert.match(ignoredLegacy.configPath, /agentsession[\\/]config\.json$/);
  } finally {
    if (previousCurrent === undefined) delete process.env.AGENTSESSION_CONFIG;
    else process.env.AGENTSESSION_CONFIG = previousCurrent;
    if (previousLegacy === undefined) delete process.env.OPENSESSIONVIEWER_CONFIG;
    else process.env.OPENSESSIONVIEWER_CONFIG = previousLegacy;
    if (previousMetaPath === undefined) delete process.env.AGENTSESSION_META_PATH;
    else process.env.AGENTSESSION_META_PATH = previousMetaPath;
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
  }
});

test("AgentSession metadata DB path also scopes the default configuration", () => {
  const metaPath = path.join(temp, "isolated-config", "viewer-meta.db");
  const previousConfig = process.env.AGENTSESSION_CONFIG;
  const previousMetaPath = process.env.AGENTSESSION_META_PATH;
  process.env.AGENTSESSION_META_PATH = metaPath;
  delete process.env.AGENTSESSION_CONFIG;
  try {
    const config = parseArgs([]);
    assert.equal(config.metaPath, metaPath);
    assert.equal(config.metaDir, path.dirname(metaPath));
    assert.equal(config.configPath, path.join(path.dirname(metaPath), "config.json"));
  } finally {
    if (previousConfig === undefined) delete process.env.AGENTSESSION_CONFIG;
    else process.env.AGENTSESSION_CONFIG = previousConfig;
    if (previousMetaPath === undefined) delete process.env.AGENTSESSION_META_PATH;
    else process.env.AGENTSESSION_META_PATH = previousMetaPath;
  }
});

test.after(() => {
  closeMetaDb();
  rmSync(temp, { recursive: true, force: true });
});
