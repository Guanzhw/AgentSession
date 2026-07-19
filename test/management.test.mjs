import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-management-"));
process.env.OPENSESSIONVIEWER_META_PATH = path.join(temp, "meta.db");

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
const { getIndexedListResults, getVisibleListResults } = await import("../dist/src/server.js");
const { getAllProviders } = await import("../dist/src/providers/index.js");
const { EMPTY_PROJECT_FILTER } = await import("../dist/src/project-filter.js");
const { renderSessionsPage } = await import("../dist/src/views/sessions.js");

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
  insert.run("c", "p2", "c", "Analysis original", "/p2", now - 3000, now - 3000);
  insert.run("d", "p2", "d", "Middle work", "/p2", now - 2000, now - 4000);
  insert.run("e", "p2", "e", "Beta work", "/p2", now - 1000, now - 5000);
  db.close();
}

test("viewer metadata filters and manages SQLite and indexed providers without touching source data", async () => {
  const dbPath = path.join(temp, "provider.db");
  createProviderDb(dbPath);

  try {
    renameSession("codex", "b", "Renamed analysis");
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

    const customMatch = getVisibleListResults({
      dbPath,
      metaMap,
      excludedIds,
      limit: 1,
      offset: 0,
      query: "renamed",
      range: "week",
      project: "p1",
      starredOnly: true,
      sessionKind: "analysis"
    });
    assert.equal(customMatch.total, 1);
    assert.deepEqual(customMatch.sessions.map((session) => session.id), ["b"]);

    const analysisOnly = getVisibleListResults({
      dbPath,
      metaMap,
      excludedIds,
      limit: 10,
      offset: 0,
      sessionKind: "analysis"
    });
    assert.deepEqual(analysisOnly.sessions.map((session) => session.id), ["b"]);

    const titlePage = getVisibleListResults({
      dbPath,
      metaMap,
      excludedIds,
      limit: 2,
      offset: 1,
      sort: "title-asc"
    });
    assert.equal(titlePage.total, 4);
    assert.deepEqual(titlePage.sessions.map((session) => session.id), ["c", "b"]);

    assert.deepEqual(
      listSessionProjects("renamed", "week", dbPath, excludedIds, undefined, "analysis", new Map([["b", "Renamed analysis"], ["c", "Custom work"]]))
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
    const sqliteUnknownProject = getVisibleListResults({
      dbPath,
      metaMap,
      excludedIds,
      limit: 10,
      offset: 0,
      project: EMPTY_PROJECT_FILTER
    });
    assert.equal(sqliteUnknownProject.total, 1);
    assert.deepEqual(sqliteUnknownProject.sessions.map((session) => session.id), ["no-project"]);

    const indexedRows = [
      { id: "a", provider: "codex", parentId: null, title: "Zulu work", directory: "/p1", timeCreated: 1, timeUpdated: 500, messageCount: 1, tokenCount: 10 },
      { id: "b", provider: "codex", parentId: null, title: "Alpha work", directory: "/p1", timeCreated: 2, timeUpdated: 400, messageCount: 2, tokenCount: 20 },
      { id: "c", provider: "codex", parentId: null, title: "Analysis original", directory: "/p2", timeCreated: 3, timeUpdated: 300, messageCount: 3, tokenCount: 30 },
      { id: "d", provider: "codex", parentId: null, title: "Middle work", directory: "/p2", timeCreated: 4, timeUpdated: 200, messageCount: 4, tokenCount: 40 },
      { id: "e", provider: "codex", parentId: null, title: "Beta work", directory: "/p2", timeCreated: 5, timeUpdated: 100, messageCount: 5, tokenCount: 50 },
      { id: "child-b", provider: "codex", parentId: "b", title: "Child work", directory: "/p1", timeCreated: 6, timeUpdated: 450, messageCount: 1, tokenCount: 5 }
    ];
    upsertIndex("codex", indexedRows);

    const indexedCustomMatch = getIndexedListResults({
      providerId: "codex",
      metaMap,
      excludedIds,
      limit: 1,
      offset: 0,
      query: "renamed",
      project: "/p1",
      includedIds: ["b"],
      sessionKind: "analysis"
    });
    assert.equal(indexedCustomMatch.total, 1);
    assert.deepEqual(indexedCustomMatch.sessions.map((session) => session.id), ["b"]);

    const indexedTitlePage = getIndexedListResults({
      providerId: "codex",
      metaMap,
      excludedIds,
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
      getIndexedSessionProjects("codex", "", "renamed", undefined, "analysis", excludedIds, new Map([["b", "Renamed analysis"], ["c", "Custom work"]]))
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
    const indexedUnknownProject = getIndexedListResults({
      providerId: "codex",
      metaMap,
      excludedIds,
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

    const providers = new Map(getAllProviders().map((provider) => [provider.id, provider]));
    for (const id of ["claude-code", "codex", "gemini", "pi"]) {
      assert.equal(providers.get(id)?.capabilities?.localManagement, true, id);
    }
  } finally {
    closeDb(dbPath);
    closeIndexDb();
    closeMetaDb();
    rmSync(temp, { recursive: true, force: true });
  }
});
