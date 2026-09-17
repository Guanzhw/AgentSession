import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-library-live-"));
process.env.AGENTSESSION_META_PATH = path.join(temp, "meta.db");
const { initConfig } = await import("../dist/src/config.js");
initConfig([]);
const { closeDb } = await import("../dist/src/db.js");
const { closeIndexDb, upsertIndex, getCrossProviderSessions } = await import("../dist/src/index-db.js");
const { closeMetaDb } = await import("../dist/src/meta.js");
const { registerSessions } = await import("../dist/src/routes/sessions.js");
const { createOpenCodeSqliteAdapter } = await import("../dist/src/providers/opencode/sqlite-adapter.js");
const sourcePath = path.join(temp, "source.db");
const source = new DatabaseSync(sourcePath);
source.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE session (
    id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, slug TEXT, directory TEXT,
    time_created INTEGER, time_updated INTEGER, time_archived INTEGER
  );
  INSERT INTO session VALUES ('root', NULL, 'Source title', 'root', '/project', 100, 200, NULL);
  INSERT INTO session VALUES ('child', 'root', 'Initial child', 'child', '/project', 101, 201, NULL);
`);
test.after(() => {
  closeDb(sourcePath);
  source.close();
  closeIndexDb();
  closeMetaDb();
  rmSync(temp, { recursive: true, force: true });
});

function response() {
  return { status: 0, body: "", writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
}

test("Library routes see live SQLite inserts, renames and archives without reindexing or scanning file providers", async () => {
  upsertIndex("opencode", [
    { id: "root", parentId: null, title: "Stale title", directory: "/project", timeCreated: 100, timeUpdated: 200, messageCount: 0, tokenCount: null },
    { id: "removed", parentId: null, title: "Removed source", directory: "/project", timeCreated: 100, timeUpdated: 200, messageCount: 0, tokenCount: null }
  ]);
  const adapter = createOpenCodeSqliteAdapter({ id: "opencode", name: "OpenCode", defaultDataPath: () => sourcePath });
  const snapshot = adapter.getLibrarySessions;
  let snapshots = 0;
  adapter.getLibrarySessions = () => { snapshots += 1; return snapshot(); };
  adapter.scan = () => { throw new Error("Library must not invoke scan"); };
  const fileAdapter = { id: "pi", scan() { throw new Error("file provider scan invoked"); } };
  const routes = [];
  registerSessions({ get(pattern, handler) { routes.push({ pattern, handler }); } }, {
    appConfig: {}, providerMap: new Map([["opencode", adapter], ["pi", fileAdapter]]),
    providerInfo: [{ id: "opencode", name: "OpenCode", available: true }, { id: "pi", name: "Pi", available: true }]
  });
  async function jsonRoute(route, url) {
    const res = response();
    await routes.find((entry) => entry.pattern === route).handler({ url }, res);
    assert.equal(res.status, 200);
    return JSON.parse(res.body);
  }

  const initial = await jsonRoute("/api/library/sessions", "/api/library/sessions");
  assert.deepEqual(initial.sessions.map((session) => session.id), ["root"]);
  assert.equal(initial.sessions[0].title, "Source title");
  assert.deepEqual(Object.keys(initial.sessions[0]).sort(), ["directory", "html", "id", "provider", "time_updated", "title"]);
  assert.equal(snapshots, 1);

  source.exec(`UPDATE session SET title = 'Renamed child' WHERE id = 'child';
    INSERT INTO session VALUES ('new-child', 'root', 'New child', 'new-child', '/project', 102, 202, NULL);`);
  const children = await jsonRoute("/api/library/children", "/api/library/children?parentProvider=opencode&parentId=root&provider=opencode");
  assert.equal(children.total, 2);
  assert.match(children.html, /Renamed child/);
  assert.match(children.html, /New child/);

  const beforePage = snapshots;
  const page = await routes.find((entry) => entry.pattern === "/sessions").handler({ url: "/sessions?provider=opencode" });
  assert.equal(page.status, 200);
  assert.equal(snapshots, beforePage + 1, "family list and project facets share one live snapshot");
  const beforeFlat = snapshots;
  await jsonRoute("/api/sessions", "/api/sessions?provider=opencode");
  assert.equal(snapshots, beforeFlat, "legacy flat API does not obtain live Library metadata");

  source.exec("UPDATE session SET time_archived = 300 WHERE id = 'root'");
  const withoutParent = await jsonRoute("/api/library/sessions", "/api/library/sessions?provider=opencode");
  assert.deepEqual(new Set(withoutParent.sessions.map((session) => session.id)), new Set(["child", "new-child"]), "children stay reachable when their recorded parent is archived");
  source.exec("UPDATE session SET time_archived = 300");
  assert.equal((await jsonRoute("/api/library/sessions", "/api/library/sessions?provider=opencode")).total, 0);
  assert.deepEqual(new Set(getCrossProviderSessions({ providers: ["opencode"] }).sessions.map((session) => session.id)), new Set(["root", "removed"]), "live reads do not replace or mutate the startup index");
});
