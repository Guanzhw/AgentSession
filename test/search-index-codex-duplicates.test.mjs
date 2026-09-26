import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("duplicate canonical Codex sources keep search continuation stable across an unchanged refresh", async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-search-codex-duplicates-"));
  const codexDir = path.join(temp, "codex");
  const sessionsDir = path.join(codexDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  process.env.AGENTSESSION_META_PATH = path.join(temp, "meta.db");
  const { initConfig } = await import("../dist/src/config.js");
  initConfig(["--codex-dir", codexDir]);
  const { closeIndexDb } = await import("../dist/src/index-db.js");
  const { closeSearchDb, getSearchIndexRevision } = await import("../dist/src/search-index.js");
  const { createSessionHistoryService } = await import("../dist/src/session-history.js");
  t.after(() => {
    closeSearchDb();
    closeIndexDb();
    rmSync(temp, { recursive: true, force: true });
  });
  const sourceBytes = new Map();
  for (const [filename, id, date, text] of [
    ["00-earlier.jsonl", "canonical-shared", "2026-09-13", "needle earlier copy"],
    ["01-selected.jsonl", "canonical-shared", "2026-09-15", "needle selected copy"],
    ["02-other.jsonl", "canonical-other", "2026-09-14", "needle other session"]
  ]) {
    const timestamp = `${date}T00:00:00.000Z`;
    const bytes = Buffer.from([
      { type: "session_meta", timestamp, payload: { id, cwd: "/work" } },
      { type: "event_msg", timestamp, payload: { type: "user_message", message: text } }
    ].map(JSON.stringify).join("\n") + "\n");
    const filePath = path.join(sessionsDir, filename);
    writeFileSync(filePath, bytes);
    sourceBytes.set(filePath, bytes);
  }
  let now = Date.parse("2026-09-26T00:00:00.000Z");
  t.mock.method(Date, "now", () => now);
  const { default: codex } = await import("../dist/src/providers/codex/adapter.js");
  const sources = codex.getSearchIndexSources();
  assert.deepEqual(sources.map(source => source.sessionId).sort(), ["canonical-other", "canonical-shared"]);
  assert.equal(codex.getMessages("canonical-shared")[0].content, "needle selected copy",
    "the duplicate fixture follows canonical getSession/getMessages selection");
  const service = createSessionHistoryService({ dependencies: {
    getAvailableProviders: () => [codex], getAllProviders: () => [codex]
  } });
  const input = { query: "needle", providers: ["codex"], fields: ["user"], limit: 1 };
  const first = service.search(input);
  assert.equal(first.diagnostics[0].status, "ok");
  assert.deepEqual(first.matches.map(match => match.session.sessionId), ["canonical-shared"]);
  assert.ok(first.nextCursor);
  assert.equal(service.getEvent({ event: first.matches[0].event }).content.text, "needle selected copy");
  const revision = getSearchIndexRevision();

  now += 2000;
  assert.deepEqual(codex.getSearchIndexSources(), sources);
  const second = service.search({ ...input, cursor: first.nextCursor });
  assert.equal(second.diagnostics[0].status, "ok");
  assert.deepEqual(second.matches.map(match => match.session.sessionId), ["canonical-other"]);
  assert.equal(second.nextCursor, null);
  assert.equal(getSearchIndexRevision(), revision, "unchanged duplicate files must not rewrite the index");
  for (const [filePath, bytes] of sourceBytes) {
    assert.deepEqual(readFileSync(filePath), bytes, "search leaves provider transcripts unchanged");
  }
});
