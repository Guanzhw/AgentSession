import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("derived OpenCode search preserves the existing newest-message and part ordering", async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-search-opencode-order-"));
  process.env.AGENTSESSION_META_PATH = path.join(temp, "meta.db");
  const { initConfig } = await import("../dist/src/config.js");
  initConfig([]);
  const { closeDb } = await import("../dist/src/db.js");
  const { closeIndexDb } = await import("../dist/src/index-db.js");
  const { closeSearchDb, findSearchDocuments, refreshSearchIndex } = await import("../dist/src/search-index.js");
  const { createOpenCodeSqliteAdapter } = await import("../dist/src/providers/opencode/sqlite-adapter.js");
  const { createSnippet } = await import("../dist/src/providers/shared/parser.js");
  const { createSessionHistoryService } = await import("../dist/src/session-history.js");
  const dbPath = path.join(temp, "provider.db");
  t.after(() => {
    closeSearchDb();
    closeIndexDb();
    closeDb(dbPath);
    rmSync(temp, { recursive: true, force: true });
  });

  const setup = new DatabaseSync(dbPath);
  try {
    setup.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT,
        title TEXT, slug TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
      INSERT INTO session VALUES ('session', NULL, 'project', 'Other title', 'other', '/work', 1, 20, NULL);
    `);
    const putMessage = setup.prepare("INSERT INTO message VALUES (?, 'session', ?)");
    const putPart = setup.prepare("INSERT INTO part VALUES (?, ?, 'session', ?)");
    putMessage.run("old", JSON.stringify({ role: "user", time: { created: 2 } }));
    putMessage.run("new", JSON.stringify({ role: "user", time: { created: 3 } }));
    putPart.run("part-old", "old", JSON.stringify({ type: "text", text: "chronology old answer" }));
    putPart.run("part-new", "new", JSON.stringify({ type: "text", text: "chronology new answer" }));
    putPart.run("part-a", "new", JSON.stringify({ type: "text", text: "fragment first insertion" }));
    putPart.run("part-z", "new", JSON.stringify({ type: "text", text: "fragment last insertion" }));
  } finally {
    setup.close();
  }
  const sourceBefore = readFileSync(dbPath);
  const adapter = createOpenCodeSqliteAdapter({
    id: "opencode", name: "Fixture OpenCode", defaultDataPath: () => dbPath
  });
  const service = createSessionHistoryService({ dependencies: {
    getAvailableProviders: () => [adapter], getAllProviders: () => [adapter],
    findIndexedSessionMetadata: () => []
  } });
  refreshSearchIndex(adapter);

  for (const [query, expectedId] of [["chronology", "new:part-new"], ["fragment", "new:part-z"]]) {
    const baseline = adapter.searchMessages(query)[0];
    assert.equal(baseline.messageId, expectedId, "the baseline exercises descending message/part order");
    const indexed = [...findSearchDocuments("opencode", query, ["user"])][0];
    assert.equal(indexed.messageId, baseline.messageId, `${query}: indexed first event must match the baseline`);
    assert.equal(createSnippet(indexed.text, query), baseline.snippet, `${query}: indexed snippet must match the baseline`);
    const searched = service.search({ query, fields: ["user"] });
    assert.equal(searched.diagnostics[0].status, "ok");
    assert.deepEqual(searched.matches.map(match => ({ event: match.event, snippet: match.snippet })), [{
      event: { provider: "opencode", sessionId: "session", messageId: baseline.messageId, segment: "message" },
      snippet: baseline.snippet
    }]);
  }
  closeDb(dbPath);
  assert.deepEqual(readFileSync(dbPath), sourceBefore, "search leaves the provider database unchanged");
});
