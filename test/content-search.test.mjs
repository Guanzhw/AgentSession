import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const { closeDb, searchMessages } = await import("../dist/src/db.js");
const { createSessionCatalog, getSearchResults, searchAcrossProviderCatalogs, toApiSessionShape } = await import("../dist/src/session-queries.js");
const { renderSessionsPage } = await import("../dist/src/views/sessions.js");
const { renderSessionReaderPane } = await import("../dist/src/views/session.js");
const { sessionCard } = await import("../dist/src/views/components.js");
const { parseSessionNavigationContext } = await import("../dist/src/navigation-context.js");
const { buildMessageSessionTree } = await import("../dist/src/providers/shared/message-session.js");
const { searchNormalizedMessages } = await import("../dist/src/providers/shared/file-adapter-helpers.js");
const { createSnippet } = await import("../dist/src/providers/shared/parser.js");
const { createOpenCodeSqliteAdapter } = await import("../dist/src/providers/opencode/sqlite-adapter.js");

test("shared content search includes distant AND terms in bounded source-order excerpts", () => {
  const content = `Opening Alpha marker.${"x".repeat(220)} closing OMEGA marker.`;
  const [match] = searchNormalizedMessages([{
    session: { id: "canonical-session" },
    messages: [{ id: "canonical-message", sessionId: "canonical-session", role: "user", content, thinking: null, timestamp: 42 }]
  }], "omega alpha");

  assert.equal(match.sessionId, "canonical-session");
  assert.equal(match.messageId, "canonical-message");
  assert.match(match.snippet, /Alpha/);
  assert.match(match.snippet, /OMEGA/);
  assert.ok(match.snippet.indexOf("Alpha") < match.snippet.indexOf("OMEGA"));
  assert.match(match.snippet, /…/);
  assert.doesNotMatch(match.snippet, /x{80}/);
  assert.ok(match.snippet.length <= 160);

  const impossible = createSnippet(`${"a".repeat(90)} gap ${"b".repeat(90)}`, `${"a".repeat(90)} ${"b".repeat(90)}`);
  assert.ok(impossible.length <= 160);
  assert.ok(impossible.endsWith("…"));
  assert.ok(impossible.includes("a".repeat(90)));
  assert.equal(impossible.includes("b".repeat(90)), false);
  assert.equal(createSnippet("before red blue after", "red blue"), "before red blue after");
  const oversizedExactPhrase = `${"a".repeat(90)} ${"b".repeat(90)}`;
  const clippedExactPhrase = createSnippet(oversizedExactPhrase, oversizedExactPhrase);
  assert.ok(clippedExactPhrase.length <= 160);
  assert.ok(clippedExactPhrase.endsWith("…"));

  const overbudgetExactQuery = `alpha ${"x".repeat(120)} omega`;
  const overbudgetExactText = `alpha decoy ${"p".repeat(40)}${overbudgetExactQuery} tail`;
  const overbudgetExactSnippet = createSnippet(overbudgetExactText, overbudgetExactQuery);
  assert.ok(overbudgetExactSnippet.includes(overbudgetExactQuery));
  assert.doesNotMatch(overbudgetExactSnippet, /alpha decoy/);
  assert.match(overbudgetExactSnippet, /alpha/);
  assert.ok(overbudgetExactSnippet.includes("x".repeat(120)));
  assert.match(overbudgetExactSnippet, /omega/);
  assert.ok(overbudgetExactSnippet.indexOf("alpha") < overbudgetExactSnippet.indexOf("omega"));
  assert.ok(overbudgetExactSnippet.length <= 160);
});

test("cross-provider content pages keep source identity and stable provider order", () => {
  const calls = [];
  const catalogs = ["codex", "pi"].map((provider) => ({
    provider,
    messageSearch({ query, limit, offset }) {
      calls.push({ provider, query, limit, offset });
      const sessions = [1, 2, 3].map((n) => ({ id: `shared-${n}`, searchMatch: { messageId: `${provider}-${n}` } }));
      return { sessions: sessions.slice(offset, offset + limit), hasMore: offset + limit < sessions.length, total: sessions.length };
    }
  }));
  const first = searchAcrossProviderCatalogs(catalogs, "needle", 2, 0);
  const second = searchAcrossProviderCatalogs(catalogs, "needle", 2, 2);
  const third = searchAcrossProviderCatalogs(catalogs, "needle", 2, 4);
  assert.deepEqual([first, second, third].flatMap((page) => page.sessions.map(({ provider, id }) => `${provider}:${id}`)), [
    "codex:shared-1", "pi:shared-1", "codex:shared-2", "pi:shared-2", "codex:shared-3", "pi:shared-3"
  ]);
  assert.equal(first.total, null);
  assert.equal(third.total, 6);
  assert.equal(third.hasMore, false);
  assert.ok(calls.every(({ query, offset }) => query === "needle" && offset === 0));
});

test("content search return links preserve query and page offset", () => {
  const html = renderSessionsPage({
    sessions: [{ id: "later", provider: "codex", title: "Later", time_updated: 1,
      searchMatch: { messageId: "message-2", snippet: "needle here" } }],
    total: null, hasMore: true, limit: 30, offset: 30, query: "needle",
    searchMode: "content", provider: "codex", providerAvailable: true
  });
  const cardAnchor = html.match(/<article id="(session-result-[a-f0-9]{16})"/)?.[1];
  assert.ok(cardAnchor);
  assert.ok(html.includes(`href="/codex/session/later?from=${encodeURIComponent(`/codex/search?q=needle&offset=30#${cardAnchor}`)}#msg-message-2"`));
  assert.match(html, /data-return-to="\/codex\/search\?q=needle&amp;offset=30"/);
  assert.deepEqual(parseSessionNavigationContext("/codex/search?q=needle&offset=30"), {
    href: "/codex/search?q=needle&offset=30", section: "sessions", day: null
  });
  assert.deepEqual(parseSessionNavigationContext("/sessions/search?q=needle&offset=30"), {
    href: "/sessions/search?q=needle&offset=30", section: "sessions", day: null
  });
});

test("file-provider content search pages beyond 500 duplicate message hits in original match order", () => {
  const matches = [
    ...Array.from({ length: 601 }, (_, i) => ({ sessionId: "first", messageId: `first-${i}`, role: "user", snippet: "needle first" })),
    { sessionId: "second", messageId: "second-1", role: "assistant", snippet: "needle second" },
    { sessionId: "third", messageId: "third-1", role: "user", snippet: "needle third" }
  ];
  const calls = [];
  const adapter = {
    capabilities: {},
    searchMessages(query, limit, offset) {
      calls.push({ query, limit, offset });
      return matches.slice(offset, offset + limit);
    },
    getSession(id) { return { id, title: id, time_updated: 100, directory: "/project" }; }
  };
  const catalog = createSessionCatalog(adapter, "codex", { metaMap: new Map(), excludedIds: new Set() });
  const first = catalog.contentSearch({ query: "needle", limit: 1, offset: 0 });
  const second = catalog.contentSearch({ query: "needle", limit: 1, offset: 1 });
  const third = catalog.contentSearch({ query: "needle", limit: 1, offset: 2 });

  assert.deepEqual([first, second, third].map((page) => page.sessions[0].id), ["first", "second", "third"]);
  assert.equal(first.total, null);
  assert.equal(second.hasMore, true);
  assert.equal(third.total, 3);
  assert.equal(third.hasMore, false);
  assert.equal(second.sessions[0].searchMatch.messageId, "second-1");
  assert.equal(toApiSessionShape(second.sessions[0]).searchMatch.snippet, "needle second");
  assert.ok(calls.some((call) => call.offset > 500));
  assert.ok(calls.every((call) => call.limit === 256));
});

test("file-provider content search streams one pass through duplicate hits", () => {
  let scans = 0;
  const adapter = {
    capabilities: {},
    *iterateSearchMessages() {
      scans += 1;
      for (let i = 0; i < 601; i += 1) {
        yield { session: { id: "first", title: "First", time_updated: 2 }, match: { sessionId: "first", messageId: `first-${i}`, role: "user", snippet: "needle first" } };
      }
      yield { session: { id: "second", title: "Second", time_updated: 1 }, match: { sessionId: "second", messageId: "second-1", role: "user", snippet: "needle second" } };
    },
    searchMessages() { throw new Error("streaming search must not restart at an offset"); },
    getSession() { throw new Error("streaming match already owns its session"); }
  };
  const catalog = createSessionCatalog(adapter, "codex", { metaMap: new Map(), excludedIds: new Set() });
  const page = catalog.messageSearch({ query: "needle", limit: 1, offset: 1 });
  assert.deepEqual(page.sessions.map((session) => session.id), ["second"]);
  assert.equal(page.total, 2);
  assert.equal(scans, 1);
});

test("search source message remains an anchor when the Reader groups its text under a response", () => {
  const session = { id: "sample", provider: "codex", title: "Sample", directory: "/work", timeCreated: 1, timeUpdated: 2 };
  const messages = [{ id: "msg-source", sessionId: "sample", role: "assistant", content: "needle", thinking: null, timestamp: 2 }];
  const tree = buildMessageSessionTree(session, messages);
  tree.messages[0].id = "rs-group";
  tree.messages[0].data.id = "rs-group";
  const html = renderSessionReaderPane({ session, sessionTree: tree, provider: "codex" });
  assert.match(html, /id="msg-source" class="session-event-anchor"/);
  assert.match(html, /id="part-msg-source-text"/);
});

test("OpenCode title hits stay first, content pages past 500 messages, and multi-term snippets stay bounded", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "agentsession-content-search-"));
  const dbPath = path.join(directory, "sessions.db");
  const db = new DatabaseSync(dbPath);
  const distantText = `Opening Alpha marker.${"x".repeat(220)} closing OMEGA marker.`;
  try {
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT);
      CREATE TABLE session (
        id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, title TEXT,
        directory TEXT, time_created INTEGER, time_updated INTEGER,
        summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
        time_archived INTEGER
      );
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
    `);
    const insertSession = db.prepare("INSERT INTO session VALUES (?, NULL, NULL, ?, ?, '/project', 1, ?, 0, 0, 0, NULL)");
    insertSession.run("title", "title", "needle title", 100);
    insertSession.run("first", "first", "other first", 300);
    insertSession.run("second", "second", "other second", 200);
    const insertMessage = db.prepare("INSERT INTO message VALUES (?, ?, ?)");
    const insertPart = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)");
    for (let i = 0; i < 601; i += 1) {
      const id = `first-${i}`;
      insertMessage.run(id, "first", JSON.stringify({ role: "user", time: { created: i } }));
      insertPart.run(`part-${i}`, id, "first", JSON.stringify({ type: "text", text: "needle first" }));
    }
    insertMessage.run("second-message", "second", JSON.stringify({ role: "assistant", time: { created: 1 } }));
    insertPart.run("second-part", "second-message", "second", JSON.stringify({ type: "text", text: 'needle <img src=x onerror="alert(1)">' }));
    insertMessage.run("distant-message", "second", JSON.stringify({ role: "user", time: { created: 2 } }));
    insertPart.run("distant-part", "distant-message", "second", JSON.stringify({ type: "text", text: distantText }));
    db.prepare("INSERT INTO session VALUES ('child', NULL, 'first', 'child', 'Child', '/project', 1, 150, 0, 0, 0, NULL)").run();
    insertMessage.run("child-message", "child", JSON.stringify({ role: "user", time: { created: 1 } }));
    insertPart.run("child-part", "child-message", "child", JSON.stringify({ type: "text", text: "childonly" }));
    db.prepare("INSERT INTO session VALUES ('archived', NULL, NULL, 'archived', 'Archived', '/project', 1, 140, 0, 0, 0, 123)").run();
    insertMessage.run("archived-message", "archived", JSON.stringify({ role: "user", time: { created: 1 } }));
    insertPart.run("archived-part", "archived-message", "archived", JSON.stringify({ type: "text", text: "archivedonly" }));
  } finally {
    db.close();
  }

  try {
    const sqliteMatch = searchMessages("omega alpha", 10, dbPath)[0];
    assert.equal(sqliteMatch.messageId, "distant-message");
    assert.equal(sqliteMatch.partId, "distant-part");
    assert.equal(sqliteMatch.text, distantText);
    assert.match(sqliteMatch.snippet, /Alpha/);
    assert.match(sqliteMatch.snippet, /OMEGA/);
    assert.ok(sqliteMatch.snippet.indexOf("Alpha") < sqliteMatch.snippet.indexOf("OMEGA"));
    assert.match(sqliteMatch.snippet, /…/);
    assert.doesNotMatch(sqliteMatch.snippet, /x{80}/);
    assert.ok(sqliteMatch.snippet.length <= 160);

    const openCodeAdapter = createOpenCodeSqliteAdapter({
      id: "opencode", name: "OpenCode", defaultDataPath: () => dbPath
    });
    const adapterMatch = openCodeAdapter.searchMessages("omega alpha", 10)[0];
    assert.equal(adapterMatch.messageId, "distant-message:distant-part");
    const sourceMessage = openCodeAdapter.getMessages("second").find(({ id }) => id === adapterMatch.messageId);
    assert.equal(sourceMessage.content, distantText);

    const pages = [0, 1, 2].map((offset) => getSearchResults("needle", 1, offset, dbPath, new Set(), new Map()));
    assert.deepEqual(pages.map((page) => page.sessions[0].id), ["title", "first", "second"]);
    assert.equal(pages[0].total, null);
    assert.equal(pages[1].hasMore, true);
    assert.equal(pages[2].total, 3);
    assert.equal(pages[2].hasMore, false);

    const catalog = createSessionCatalog({
      capabilities: { openCodeStatsStore: true },
      getDataPath: () => dbPath
    }, "opencode", { metaMap: new Map(), excludedIds: new Set() });
    const messagePage = catalog.messageSearch({ query: "needle", limit: 3, offset: 0 });
    assert.deepEqual(messagePage.sessions.map((session) => session.id), ["first", "second"]);
    assert.equal(messagePage.sessions.every((session) => Boolean(session.searchMatch?.messageId)), true);
    assert.deepEqual(catalog.messageSearch({ query: "childonly", limit: 3, offset: 0 }).sessions.map((session) => session.id), ["child"]);
    assert.deepEqual(catalog.messageSearch({ query: "archivedonly", limit: 3, offset: 0 }).sessions, []);
    const excludedCatalog = createSessionCatalog({
      capabilities: { openCodeStatsStore: true },
      getDataPath: () => dbPath
    }, "opencode", { metaMap: new Map(), excludedIds: new Set(["child"]) });
    assert.deepEqual(excludedCatalog.messageSearch({ query: "childonly", limit: 3, offset: 0 }).sessions, []);

    const card = sessionCard(pages[2].sessions[0], false, { provider: "opencode" });
    assert.match(card, /href="\/opencode\/session\/second#msg-second-message"/);
    assert.match(card, /needle &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.doesNotMatch(card, /<img src=x/);

    const html = renderSessionsPage({
      ...pages[1], query: "needle", searchMode: "content", provider: "opencode",
      offset: 1, limit: 1, providerAvailable: true
    });
    assert.match(html, /At least 3 sessions/);
    assert.match(html, /id="scroll-sentinel"[^>]*data-offset="2"[^>]*data-total=""/);
    assert.match(html, /data-mode="content"/);
  } finally {
    closeDb(dbPath);
    rmSync(directory, { recursive: true, force: true });
  }
});
