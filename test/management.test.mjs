import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-management-"));
process.env.AGENTSESSION_META_PATH = path.join(temp, "meta.db");

const { initConfig } = await import("../dist/src/config.js");
initConfig([]);

const { closeDb, listSessionProjects } = await import("../dist/src/db.js");
const {
  closeIndexDb,
  getIndexedSessionProjects,
  getIndexedSessions,
  upsertIndex
} = await import("../dist/src/index-db.js");
const {
  batchAction,
  closeMetaDb,
  getAllMeta,
  getDeletedIds,
  getExcludedIds,
  permanentDelete,
  renameSession
} = await import("../dist/src/meta.js");
const { createSessionCatalog } = await import("../dist/src/session-queries.js");
const { getAllProviders } = await import("../dist/src/providers/index.js");
const { EMPTY_PROJECT_FILTER } = await import("../dist/src/project-filter.js");
const { renderSessionsPage } = await import("../dist/src/views/sessions.js");
const { registerMutations } = await import("../dist/src/routes/mutations.js");

function mutationResponse() {
  return {
    statusCode: 0,
    body: "",
    writeHead(status) { this.statusCode = status; return this; },
    end(chunk = "") { this.body += String(chunk); return this; }
  };
}

function createProviderDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT);
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      parent_id TEXT,
      slug TEXT,
      title TEXT,
      directory TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      time_archived INTEGER
    );
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
  `);
  db.prepare("INSERT INTO project (id, name, worktree) VALUES (?, ?, ?)").run("p1", "Project One", "/p1");
  db.prepare("INSERT INTO project (id, name, worktree) VALUES (?, ?, ?)").run("p2", "Project Two", "/p2");
  const insert = db.prepare(`
    INSERT INTO session (
      id, project_id, parent_id, slug, title, directory, time_created, time_updated,
      summary_additions, summary_deletions, summary_files, time_archived
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, 0, 0, NULL)
  `);
  const now = Date.now();
  insert.run("a", "p1", "a", "Zulu work", "/p1", now - 5000, now - 1000);
  insert.run("b", "p1", "b", "Alpha work", "/p1", now - 4000, now - 2000);
  insert.run("c", "p2", "c", "Custom original", "/p2", now - 3000, now - 3000);
  insert.run("d", "p2", "d", "Middle work", "/p2", now - 2000, now - 4000);
  insert.run("e", "p2", "e", "Beta work", "/p2", now - 1000, now - 5000);
  db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run("message-a", "a", JSON.stringify({ role: "user", time: { created: now - 4900 } }));
  db.prepare("INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)").run("part-a", "message-a", "a", JSON.stringify({ type: "text", text: "catalog needle" }));
  db.close();
}

test("viewer metadata filters and manages SQLite and indexed providers without touching source data", async () => {
  const dbPath = path.join(temp, "provider.db");
  createProviderDb(dbPath);

  try {
    renameSession("codex", "b", "Renamed project");
    renameSession("codex", "c", "Custom work");
    assert.equal(batchAction("codex", ["b", "c"], "star"), 2);
    assert.equal(batchAction("codex", ["c"], "unstar"), 1);
    assert.equal(batchAction("codex", ["d"], "delete"), 1);
    assert.equal(batchAction("codex", ["d"], "restore"), 1);
    assert.equal(batchAction("codex", ["d"], "delete"), 1);
    permanentDelete("codex", "excluded-missing-source");

    const metaMap = getAllMeta("codex");
    const excludedIds = getExcludedIds("codex");
    assert.deepEqual(getDeletedIds("codex"), ["d"]);
    assert.equal(excludedIds.has("d"), true);
    assert.equal(excludedIds.has("excluded-missing-source"), true);

    const sqliteCatalog = createSessionCatalog({
      capabilities: { openCodeStatsStore: true },
      getDataPath() { return dbPath; }
    }, "codex", { metaMap, excludedIds });

    const customMatch = sqliteCatalog.list({
      limit: 1,
      offset: 0,
      query: "renamed",
      range: "week",
      project: "p1",
      starredOnly: true,
    });
    assert.equal(customMatch.total, 1);
    assert.deepEqual(customMatch.sessions.map((session) => session.id), ["b"]);
    assert.equal(customMatch.sessions[0].message_count, 0);
    assert.equal(customMatch.sessions[0].token_count, null);

    const titlePage = sqliteCatalog.list({
      limit: 2,
      offset: 1,
      sort: "title-asc"
    });
    assert.equal(titlePage.total, 4);
    assert.deepEqual(titlePage.sessions.map((session) => session.id), ["c", "b"]);

    assert.deepEqual(
      listSessionProjects("renamed", "week", dbPath, excludedIds, undefined, new Map([["b", "Renamed project"], ["c", "Custom work"]]))
        .map((project) => ({ id: project.id, count: project.count })),
      [{ id: "p1", count: 1 }]
    );

    const providerDb = new DatabaseSync(dbPath);
    providerDb.prepare(`
      INSERT INTO session (
        id, project_id, parent_id, slug, title, directory, time_created, time_updated,
        summary_additions, summary_deletions, summary_files, time_archived
      ) VALUES (?, NULL, NULL, ?, ?, '', ?, ?, 0, 0, 0, NULL)
    `).run("no-project", "no-project", "No project", Date.now(), Date.now());
    providerDb.close();
    const sqliteUnknownProject = sqliteCatalog.list({
      limit: 10,
      offset: 0,
      project: EMPTY_PROJECT_FILTER
    });
    assert.equal(sqliteUnknownProject.total, 1);
    assert.deepEqual(sqliteUnknownProject.sessions.map((session) => session.id), ["no-project"]);

    const indexedRows = [
      { id: "a", provider: "codex", parentId: null, title: "Zulu work", directory: "/p1", timeCreated: 1, timeUpdated: 500, messageCount: 1, tokenCount: 10 },
      { id: "b", provider: "codex", parentId: null, title: "Alpha work", directory: "/p1", timeCreated: 2, timeUpdated: 400, messageCount: 2, tokenCount: 20 },
      { id: "c", provider: "codex", parentId: null, title: "Custom original", directory: "/p2", timeCreated: 3, timeUpdated: 300, messageCount: 3, tokenCount: 30 },
      { id: "d", provider: "codex", parentId: null, title: "Middle work", directory: "/p2", timeCreated: 4, timeUpdated: 200, messageCount: 4, tokenCount: 40 },
      { id: "e", provider: "codex", parentId: null, title: "Beta work", directory: "/p2", timeCreated: 5, timeUpdated: 100, messageCount: 5, tokenCount: 50 },
      { id: "child-b", provider: "codex", parentId: "b", title: "Child work", directory: "/p1", timeCreated: 6, timeUpdated: 450, messageCount: 1, tokenCount: 5 }
    ];
    upsertIndex("codex", indexedRows);

    const indexedCatalog = createSessionCatalog({
      capabilities: {},
      getSession(id) { return indexedRows.find((session) => session.id === id) || null; },
      searchMessages() { return [{ sessionId: "b" }]; }
    }, "codex", { metaMap, excludedIds });

    const indexedCustomMatch = indexedCatalog.list({
      limit: 1,
      offset: 0,
      query: "renamed",
      project: "/p1",
      starredOnly: true,
    });
    assert.equal(indexedCustomMatch.total, 1);
    assert.deepEqual(indexedCustomMatch.sessions.map((session) => session.id), ["b"]);

    const indexedTitlePage = indexedCatalog.list({
      limit: 2,
      offset: 1,
      sort: "title-asc"
    });
    assert.equal(indexedTitlePage.total, 4);
    assert.deepEqual(indexedTitlePage.sessions.map((session) => session.id), ["c", "b"]);
    assert.deepEqual(
      getIndexedSessions("codex", 10, 0, "", "", "", "updated-desc", ["child-b"]).sessions.map((session) => session.id),
      ["child-b"]
    );

    assert.deepEqual(
      getIndexedSessionProjects("codex", "", "renamed", undefined, excludedIds, new Map([["b", "Renamed project"], ["c", "Custom work"]]))
        .map((project) => ({ id: project.id, count: project.count })),
      [{ id: "/p1", count: 1 }]
    );

    upsertIndex("codex", [{
      id: "no-project",
      provider: "codex",
      parentId: null,
      title: "No project",
      directory: null,
      timeCreated: 6,
      timeUpdated: 600,
      messageCount: 1,
      tokenCount: 1
    }]);
    const indexedUnknownProject = indexedCatalog.list({
      limit: 10,
      offset: 0,
      project: EMPTY_PROJECT_FILTER
    });
    assert.equal(indexedUnknownProject.total, 1);
    assert.deepEqual(indexedUnknownProject.sessions.map((session) => session.id), ["no-project"]);

    const projectFilterHtml = renderSessionsPage({
      project: EMPTY_PROJECT_FILTER,
      projectOptions: [{ id: "", label: "Unknown project", worktree: "Unknown project", count: 1 }],
      provider: "codex",
      providerAvailable: true,
      manageable: true,
      providers: []
    });
    assert.match(projectFilterHtml, /<option value="">All projects<\/option>/);
    assert.match(projectFilterHtml, new RegExp(`<option value="${EMPTY_PROJECT_FILTER}" selected[^>]*>Unknown project \\(1\\)<\\/option>`));

    const trash = getIndexedSessions("codex", 10, 0, "", "", "", "updated-desc", getDeletedIds("codex"));
    assert.deepEqual(trash.sessions.map((session) => session.id), ["d"]);

    const sqliteCatalogPage = sqliteCatalog.list({ limit: 1, offset: 0, query: "renamed", project: "p1", starredOnly: true });
    assert.deepEqual(sqliteCatalogPage.sessions.map((session) => session.id), ["b"]);
    assert.equal(sqliteCatalogPage.sessions[0].title, "Renamed project");
    assert.deepEqual(sqliteCatalog.projects({ query: "renamed" }).map((project) => project.id), ["p1"]);
    assert.deepEqual(sqliteCatalog.byIds(["d"]).map((session) => session.id), ["d"]);
    assert.deepEqual(sqliteCatalog.contentSearch({ query: "needle", limit: 10, offset: 0 }).sessions.map((session) => session.id), ["a"]);
    assert.deepEqual(sqliteCatalog.overview({ starredOnly: true }), { totalSessions: 1, totalMessages: 0, totalTokens: 0 });

    const indexedCatalogPage = indexedCatalog.list({ limit: 1, offset: 0, query: "renamed", project: "/p1", starredOnly: true });
    assert.deepEqual(indexedCatalogPage.sessions.map((session) => session.id), ["b"]);
    assert.equal(indexedCatalogPage.sessions[0].title, "Renamed project");
    assert.deepEqual(indexedCatalog.projects({ query: "renamed" }).map((project) => project.id), ["/p1"]);
    assert.deepEqual(indexedCatalog.byIds(["d"]).map((session) => session.id), ["d"]);
    assert.deepEqual(indexedCatalog.contentSearch({ query: "needle", limit: 10, offset: 0 }).sessions.map((session) => session.id), ["b"]);
    assert.deepEqual(indexedCatalog.overview({ starredOnly: true }), { totalSessions: 1, totalMessages: 2, totalTokens: 20 });

    const providers = new Map(getAllProviders().map((provider) => [provider.id, provider]));
    for (const id of ["claude-code", "codex", "pi", "deepseek-harness"]) {
      assert.equal(providers.get(id)?.capabilities?.localManagement, true, id);
    }
  } finally {
    closeDb(dbPath);
    closeIndexDb();
    closeMetaDb();
    rmSync(temp, { recursive: true, force: true });
  }
});

test("all metadata and reindex mutations require same-origin loopback JSON", async () => {
  const posts = [];
  registerMutations({ post(pattern, handler) { posts.push({ pattern, handler }); }, get() {} }, {
    appConfig: { metaDir: temp, allowTerminalLaunch: false },
    providerMap: new Map(),
    availableProviders: []
  });
  const untrusted = { headers: { host: "127.0.0.1:3456", "content-type": "application/x-www-form-urlencoded", origin: "https://attacker.example" }, socket: { remoteAddress: "127.0.0.1" } };
  const cases = [
    [posts.find((entry) => entry.pattern instanceof RegExp && entry.pattern.source.includes("permanent-delete") && entry.pattern.source.includes("[a-z]")), ["", "opencode", "session-1", "star"]],
    [posts.find((entry) => entry.pattern === "/api/batch"), undefined],
    [posts.find((entry) => entry.pattern instanceof RegExp && entry.pattern.source.endsWith("batch$")), ["", "opencode"]],
    [posts.find((entry) => entry.pattern === "/api/reindex"), undefined]
  ];
  for (const [entry, match] of cases) {
    assert.ok(entry);
    const response = mutationResponse();
    await entry.handler(untrusted, response, match);
    assert.equal(response.statusCode, 403);
  }
  assert.equal(posts.some((entry) => entry.pattern instanceof RegExp && entry.pattern.source.includes("/api\\/session\\/")), false, "legacy unprefixed mutation route is removed");
});
