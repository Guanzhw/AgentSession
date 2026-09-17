import test from "node:test";
import assert from "node:assert/strict";
import { resolveLibraryTitle } from "../dist/src/session-title.js";
import { renderSessionsPage } from "../dist/src/views/sessions.js";

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
