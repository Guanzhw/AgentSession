import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-search-index-"));
process.env.AGENTSESSION_META_PATH = path.join(temp, "meta.db");
const { initConfig } = await import("../dist/src/config.js");
initConfig([]);
const { closeIndexDb } = await import("../dist/src/index-db.js");
const { closeSearchDb, findSearchDocuments, getSearchIndexRevision, refreshSearchIndex } = await import("../dist/src/search-index.js");
const { createSessionHistoryService } = await import("../dist/src/session-history.js");

test("derived search index tracks source revisions and preserves exact text and tool facets", (t) => {
  t.after(() => {
    closeSearchDb();
    closeIndexDb();
    rmSync(temp, { recursive: true, force: true });
  });
  const session = {
    id: "canonical-1", provider: "codex", parentId: null, title: "First", directory: "/work",
    timeCreated: 1, timeUpdated: 20, messageCount: 4, tokenCount: 12
  };
  let revision = "a";
  let reads = 0;
  let present = true;
  let messages = [
    { id: "user-1", sessionId: session.id, role: "user", content: "Codex handles 中文检索 and alpha beta Äpfel 🙂ab", toolName: null, timestamp: 2 },
    { id: "assistant-1", sessionId: session.id, role: "assistant", content: "The percent % and underscore _ are literal", toolName: null, timestamp: 3 },
    { id: "assistant-nul", sessionId: session.id, role: "assistant", content: "prefix\u0000needle after NUL", toolName: null, timestamp: 3 },
    { id: "tool-1", sessionId: session.id, role: "tool", content: "SECRET PAYLOAD", toolName: "ReadFile", timestamp: 4 }
  ];
  const provider = {
    id: "codex",
    getSearchIndexSources: () => present ? [{ sessionId: session.id, revision }] : [],
    getSession: (id) => present && id === session.id ? session : null,
    getMessages: () => { reads += 1; return messages; }
  };

  assert.deepEqual(refreshSearchIndex(provider), { sources: 1, changed: 1 });
  assert.equal(reads, 1);
  assert.deepEqual(refreshSearchIndex(provider), { sources: 1, changed: 0 });
  assert.equal(reads, 1);
  const find = (query, fields = ["user", "assistant", "toolName"]) =>
    [...findSearchDocuments("codex", query, fields)];
  assert.deepEqual(find("CODEX alpha").map(hit => hit.messageId), ["user-1"]);
  assert.deepEqual(find("中文").map(hit => hit.messageId), ["user-1"]);
  assert.deepEqual(find("文检").map(hit => hit.messageId), ["user-1"], "two-character CJK substring remains complete");
  assert.deepEqual(find("äPF").map(hit => hit.messageId), ["user-1"], "Unicode case folding retains substring candidates");
  assert.deepEqual(find("🙂ab").map(hit => hit.messageId), ["user-1"], "astral code points retain substring matches");
  assert.deepEqual(find("\uD83D").map(hit => hit.messageId), ["user-1"], "a UTF-16 half-surrogate retains JavaScript substring semantics");
  assert.deepEqual(find("alpha missing"), [], "all whitespace terms must match");
  assert.deepEqual(find("unfindable"), []);
  assert.deepEqual(find("%_").map(hit => hit.messageId), []);
  assert.deepEqual(find("%", ["assistant"]).map(hit => hit.messageId), ["assistant-1"]);
  assert.deepEqual(find("percent %", ["assistant"]).map(hit => hit.messageId), ["assistant-1"]);
  assert.deepEqual(find("Read", ["toolName"]).map(hit => hit.messageId), ["tool-1"]);
  assert.deepEqual(find("needle", ["assistant"]).map(hit => hit.messageId), ["assistant-nul"]);
  assert.deepEqual(find("prefix\u0000needle", ["assistant"]).map(hit => hit.messageId), ["assistant-nul"]);
  assert.deepEqual(find("SECRET").map(hit => hit.messageId), []);
  const service = createSessionHistoryService({ dependencies: {
    getAvailableProviders: () => [provider], getAllProviders: () => [provider]
  } });
  const toolSearch = service.search({ query: "Read", fields: ["toolName"] });
  assert.equal(toolSearch.diagnostics[0].status, "ok");
  assert.deepEqual(toolSearch.matches.map(hit => hit.event), [
    { provider: "codex", sessionId: "canonical-1", messageId: "tool-1", segment: "tool" }
  ]);
  assert.equal(service.getEvent({ event: toolSearch.matches[0].event }).toolName, "ReadFile");
  assert.deepEqual(service.search({ query: "Read" }).matches, []);
  assert.deepEqual(service.search({ query: "Codex", fields: ["user"] }).matches.map(hit => hit.event.messageId), ["user-1"]);

  const beforeChange = getSearchIndexRevision();
  revision = "b";
  messages = [{ id: "user-2", sessionId: session.id, role: "user", content: "Replacement result", toolName: null, timestamp: 5 }];
  assert.deepEqual(refreshSearchIndex(provider), { sources: 1, changed: 1 });
  const afterChange = getSearchIndexRevision();
  assert.notEqual(afterChange, beforeChange);
  closeSearchDb();
  assert.equal(getSearchIndexRevision().split(":")[0], afterChange.split(":")[0],
    "the source update keeps its durable generation across connections");
  assert.deepEqual(find("Codex"), []);
  assert.deepEqual(find("Replacement").map(hit => hit.messageId), ["user-2"]);
  present = false;
  assert.deepEqual(refreshSearchIndex(provider), { sources: 0, changed: 1 });
  assert.deepEqual(find("Replacement"), []);
});
