import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "agentsession-browse-index-"));
process.env.AGENTSESSION_META_PATH = path.join(temporaryDirectory, "meta.db");
const { initConfig } = await import("../dist/src/config.js");
initConfig([]);
const { browseIndexedProjects, browseIndexedSessions, closeIndexDb, findIndexedSessionMetadata, getIndexedCatalogRevision, upsertIndex } = await import("../dist/src/index-db.js");

test("MCP catalog SQL keeps provider, project, title, and lineage filters distinct", () => {
  const sessions = [
    { id: "root", provider: "codex", parentId: null, title: "Error%_report", directory: "/work/a", timeCreated: 1, timeUpdated: 30, messageCount: 2, tokenCount: 4 },
    { id: "child", provider: "codex", parentId: "root", title: "Child error", directory: "/work/a", timeCreated: 2, timeUpdated: 20, messageCount: 1, tokenCount: 2 },
    { id: "other", provider: "codex", parentId: null, title: "Error report", directory: "/work/b", timeCreated: 3, timeUpdated: 10, messageCount: 1, tokenCount: 2 }
  ];
  upsertIndex("codex", sessions);
  upsertIndex("pi", [{ id: "pi-root", provider: "pi", parentId: null, title: "Error%_report", directory: "/work/a", timeCreated: 4, timeUpdated: 40, messageCount: 1, tokenCount: 1 }]);

  const all = browseIndexedSessions({ providers: ["codex"], limit: 10, offset: 0 });
  assert.deepEqual(all.map((row) => row.id), ["root", "child", "other"]);
  assert.deepEqual(browseIndexedSessions({ providers: ["codex"], title: "%_", limit: 10, offset: 0 }).map((row) => row.id), ["root"]);
  assert.deepEqual(browseIndexedSessions({ providers: ["codex"], directory: "/work/a", parent: null, limit: 10, offset: 0 }).map((row) => row.id), ["root"]);
  assert.deepEqual(browseIndexedSessions({ providers: ["codex"], parent: { provider: "codex", sessionId: "root" }, limit: 10, offset: 0 }).map((row) => row.id), ["child"]);
  assert.deepEqual(browseIndexedSessions({ providers: ["codex"], updatedAfter: 25, limit: 10, offset: 0 }).map((row) => row.id), ["root"]);
  assert.deepEqual(browseIndexedProjects({ providers: ["codex", "pi"], limit: 10, offset: 0 }).map((row) => ({ ...row })), [
    { provider: "codex", directory: "/work/a", indexedCount: 2 },
    { provider: "codex", directory: "/work/b", indexedCount: 1 },
    { provider: "pi", directory: "/work/a", indexedCount: 1 }
  ]);
  upsertIndex("codex", [{ id: "unicode", provider: "codex", parentId: null, title: "ẞ feature", directory: "/work/c", timeCreated: 5, timeUpdated: 50, messageCount: 1, tokenCount: 1 }]);
  assert.deepEqual(browseIndexedSessions({ providers: ["codex"], title: "ß", limit: 10, offset: 0 }).map((row) => row.id), ["unicode"]);
  assert.deepEqual(findIndexedSessionMetadata("codex", "ß", 10, undefined, undefined, 0, ["title"]).map((row) => row.id), ["unicode"]);
  assert.deepEqual(findIndexedSessionMetadata("codex", "feature", 10, undefined, undefined, 0, ["directory"]).map((row) => row.id), []);
  upsertIndex("codex", [{ id: "directory-only", provider: "codex", parentId: null, title: "Folder search", directory: "/work/feature-folder", timeCreated: 6, timeUpdated: 55, messageCount: 1, tokenCount: 1 }]);
  assert.deepEqual(findIndexedSessionMetadata("codex", "feature", 10, undefined, undefined, 0, ["directory"]).map((row) => row.id), ["directory-only"]);
  upsertIndex("codex", [{ id: "unrecorded", provider: "codex", parentId: null, title: null, directory: null, timeCreated: 6, timeUpdated: 60, messageCount: 0, tokenCount: null }]);
  assert.deepEqual(browseIndexedSessions({ providers: ["codex"], directory: "", limit: 10, offset: 0 }).map((row) => row.id), ["unrecorded"]);
  assert.equal(browseIndexedProjects({ providers: ["codex"], directory: "", limit: 10, offset: 0 })[0].directory, "");
});

test("MCP browse cursor revision changes for local and external metadata DB writes", () => {
  const first = getIndexedCatalogRevision();
  upsertIndex("codex", [{ id: "revision", provider: "codex", parentId: null, title: "Revision", directory: "/work", timeCreated: 1, timeUpdated: 1, messageCount: 0, tokenCount: null }]);
  const local = getIndexedCatalogRevision();
  assert.notEqual(local, first);
  const otherConnection = new DatabaseSync(path.join(temporaryDirectory, "meta.db"));
  try {
    otherConnection.prepare("UPDATE session_index SET title = ? WHERE provider = ? AND id = ?").run("Updated revision", "codex", "revision");
  } finally {
    otherConnection.close();
  }
  assert.notEqual(getIndexedCatalogRevision(), local);
});

test.after(() => {
  closeIndexDb();
  assert.equal(path.dirname(path.resolve(temporaryDirectory)), path.resolve(os.tmpdir()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
});
