import test from "node:test";
import assert from "node:assert/strict";
import { resolveLibraryTitle } from "../dist/src/session-title.js";
import { renderSessionsPage } from "../dist/src/views/sessions.js";
import { buildLibraryDiscriminators } from "../dist/src/views/library-disambiguation.js";

test("Library title keeps explicit viewer custom titles even when they resemble IDs", () => {
  const custom = "01a0576a-98e2-7c31-a265-6d98d5fbff12";
  assert.equal(resolveLibraryTitle({
    id: "session-1",
    title: "Provider title",
    custom_title: custom
  }, "Untitled"), custom);
});

test("Library title accepts a readable provider title and rejects opaque IDs", () => {
  assert.equal(resolveLibraryTitle({ id: "session-1", title: "Review runtime reader" }, "Untitled"), "Review runtime reader");
  assert.equal(resolveLibraryTitle({ id: "01a0576a-98e2-7c31-a265-6d98d5fbff12", title: "01a0576a-98e2-7c31-a265-6d98d5fbff12" }, "Untitled"), "Untitled · 01a0576a");
});

test("Library page loads its screen stylesheet and renders the bounded title fallback", () => {
  const html = renderSessionsPage({
    sessions: [{
      id: "01a0576a-98e2-7c31-a265-6d98d5fbff12",
      provider: "codex",
      title: "01a0576a-98e2-7c31-a265-6d98d5fbff12",
      directory: "D:\\WorkSpace\\OpenSession",
      time_updated: 1_700_000_000_000
    }],
    total: 1,
    provider: "codex",
    providerAvailable: true,
    providers: [{ id: "codex", name: "Codex", icon: "", available: true }]
  });
  assert.match(html, /href="\/static\/library\.css"/);
  assert.match(html, /Untitled · 01a0576a/);
  assert.doesNotMatch(html, /<h2 class="session-card-title">01a0576a-98e2-7c31-a265-6d98d5fbff12<\/h2>/);
});

test("Library keeps same-title sessions independent and adds exact collision discriminators", () => {
  const sessions = [
    { id: "aaaaaaaa-1111", provider: "codex", title: "Review", directory: "D:\\repo", time_updated: 1700000000000 },
    { id: "bbbbbbbb-2222", provider: "codex", title: "Review", directory: "D:/repo", time_updated: 1700000000000 }
  ];
  const discriminators = buildLibraryDiscriminators(sessions);
  assert.equal(discriminators.size, 2);
  assert.notEqual(discriminators.get(JSON.stringify(["codex", "aaaaaaaa-1111"])).idLabel,
    discriminators.get(JSON.stringify(["codex", "bbbbbbbb-2222"])).idLabel);

  const html = renderSessionsPage({
    sessions,
    total: 2,
    provider: "codex",
    providerAvailable: true,
    providers: [{ id: "codex", name: "Codex", available: true, manageable: true }]
  });
  assert.equal((html.match(/data-session-id="(?:aaaaaaaa-1111|bbbbbbbb-2222)"/g) || []).length, 2);
  assert.equal((html.match(/data-library-discriminator="true"/g) || []).length, 2);
  assert.match(html, /2023-11-14 22:13:20 UTC/);
  assert.equal((html.match(/2023-11-14 22:13:20 UTC/g) || []).length, 2);
  assert.match(html, /#aaaaaaaa/);
  assert.match(html, /#bbbbbbbb/);
});

test("Library collision excerpts come from distinct indexed user text and escape provider content", () => {
  const common = "Review the CodeFacts benchmark run and compare the result for ";
  const sessions = [
    { id: "aaaaaaaa-1111", provider: "codex", title: "Review", directory: "D:/repo", time_updated: 1700000000000,
      library_evidence: JSON.stringify(["Review", `${common}alpha <script> task`]) },
    { id: "bbbbbbbb-2222", provider: "codex", title: "Review", directory: "D:/repo", time_updated: 1700000001000,
      library_evidence: JSON.stringify(["Review", `${common}beta task`]) }
  ];
  const discriminators = buildLibraryDiscriminators(sessions);
  assert.match(discriminators.get(JSON.stringify(["codex", "aaaaaaaa-1111"])).excerpt, /alpha <script> task/);
  assert.match(discriminators.get(JSON.stringify(["codex", "bbbbbbbb-2222"])).excerpt, /beta task/);
  const html = renderSessionsPage({ sessions, total: 2, provider: "codex", providerAvailable: true,
    providers: [{ id: "codex", name: "Codex", available: true }] });
  assert.match(html, /alpha &lt;script&gt; task/);
  assert.doesNotMatch(html, /<script> task/);
});

test("Library collision excerpts identify a repeated task subgroup", () => {
  const shared = "Bounded evaluation instructions shared by every collision row";
  const sessions = [
    { id: "alpha-1", provider: "codex", title: "Evaluation", directory: "D:/repo", time_updated: 1,
      library_evidence: JSON.stringify([shared, "Inspect conversation turn boundaries"]) },
    { id: "alpha-2", provider: "codex", title: "Evaluation", directory: "D:/repo", time_updated: 2,
      library_evidence: JSON.stringify([shared, "Inspect conversation turn boundaries"]) },
    { id: "beta-1", provider: "codex", title: "Evaluation", directory: "D:/repo", time_updated: 3,
      library_evidence: JSON.stringify([shared, "Inspect session token accounting"]) }
  ];
  const discriminators = buildLibraryDiscriminators(sessions);
  assert.match(discriminators.get(JSON.stringify(["codex", "alpha-1"])).excerpt, /conversation turn boundaries/);
  assert.match(discriminators.get(JSON.stringify(["codex", "alpha-2"])).excerpt, /conversation turn boundaries/);
  assert.match(discriminators.get(JSON.stringify(["codex", "beta-1"])).excerpt, /session token accounting/);
  assert.doesNotMatch(discriminators.get(JSON.stringify(["codex", "alpha-1"])).excerpt, /shared by every/);
});

test("Library discriminators preserve search return links and family rows", () => {
  const html = renderSessionsPage({
    sessions: [{
      id: "search-session", provider: "codex", title: "Needle", directory: "D:\\repo", time_updated: 1700000000000
    }],
    total: 1,
    provider: "codex",
    providerAvailable: true,
    searchMode: "content",
    query: "needle",
    providers: [{ id: "codex", name: "Codex", available: true, manageable: true }]
  });
  assert.match(html, /href="\/codex\/session\/search-session\?from=%2Fcodex%2Fsearch%3Fq%3Dneedle"/);

  const familyHtml = renderSessionsPage({
    sessions: [{
      id: "family-root", provider: "codex", title: "Needle", directory: "D:\\repo", time_updated: 1700000000000,
      family: { familyUpdated: 1700000000000, childCount: 0, matched: true, parentBoundary: null }
    }],
    total: 1,
    provider: null,
    providers: [{ id: "codex", name: "Codex", available: true, manageable: true }],
    selectedProviders: ["codex"],
    global: true,
    familyMode: true
  });
  assert.match(familyHtml, /data-library-family/);
  assert.match(familyHtml, /href="\/codex\/session\/family-root\?from=%2Fsessions%3Fprovider%3Dcodex"/);
});
