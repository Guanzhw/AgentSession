import assert from "node:assert/strict";
import test from "node:test";

const { renderSessionReaderPane } = await import("../dist/src/views/session.js");
const { setLocale } = await import("../dist/src/i18n.js");

const provenance = { fidelity: "recorded", sourceType: "codex.memory_stage1", sourceId: "job-1" };
const artifacts = [
  { id: "memory:source:1", sessionId: "source", kind: "memory", scope: "user", origin: "provider-generated", contentAccess: "full", title: null, summary: null, sourcePath: "memories.sqlite", producerRunId: null, sourceSessionIds: ["source"], hash: "a".repeat(64), redacted: false, provenance, timeCreated: 1_700_000_010_000, contentSourceTime: 1_700_000_000_000, productionEvidence: { provenance, startedAt: 1_700_000_001_000, completedAt: 1_700_000_010_000, inputUpdatedAt: 1_700_000_000_000 }, metadata: { contentLength: 12 } },
  { id: "summary:source:1", sessionId: "source", kind: "summary", scope: "session", origin: "provider-generated", contentAccess: "full", title: null, summary: null, sourcePath: "memories.sqlite", producerRunId: null, sourceSessionIds: ["source"], hash: "b".repeat(64), redacted: false, provenance, timeCreated: 1_700_000_010_000, contentSourceTime: 1_700_000_000_000, productionEvidence: null, metadata: { contentLength: 0 } }
];

test("reader artifacts stay outside the transcript and preserve source versus generation evidence", () => {
  const html = renderSessionReaderPane({ session: { id: "source", title: "Source" }, provider: "fixture", contextArtifacts: artifacts, canReadContextArtifacts: true });
  assert.match(html, /Saved from this history/);
  assert.match(html, /href="#session-source" data-reader-artifact-current-source/);
  assert.match(html, /data-content-scope="context-artifact"/);
  assert.match(html, /data-context-artifact-id="memory:source:1"/);
  assert.equal((html.match(/data-load-initial/g) || []).length, 2, "both bodies load on demand, including recorded-empty content");
  assert.equal((html.match(/Generation history is unavailable/g) || []).length, 2, "a matching job does not provide its generating transcript");
  assert.match(html, /codex\.memory_stage1/);
  assert.doesNotMatch(html, /<div class="message-body/);
});

test("compact metadata summaries never enter the saved-output reader", () => {
  const compact = { ...artifacts[1], id: "compact:summary", contentAccess: "metadata-only", sourceSessionIds: ["other"] };
  const html = renderSessionReaderPane({ session: { id: "source", title: "Source" }, provider: "fixture", contextArtifacts: [...artifacts, compact], canReadContextArtifacts: true });
  assert.doesNotMatch(html, /compact:summary/);
  assert.match(html, /href="#session-source" data-reader-artifact-current-source/);
});

test("available empty storage has no disclosure while a failed store remains explicit and localized", (t) => {
  const common = { session: { id: "source", title: "Source" }, provider: "fixture", contextArtifacts: [], canReadContextArtifacts: true };
  assert.doesNotMatch(renderSessionReaderPane({ ...common, contextArtifactSourceState: { state: "available", code: null, sourcePath: "db", provenance } }), /data-reader-artifacts/);
  setLocale("zh");
  t.after(() => setLocale("en"));
  const html = renderSessionReaderPane({ ...common, contextArtifactSourceState: { state: "invalid", code: "invalid-record", sourcePath: "db", provenance } });
  assert.match(html, /从这段历史保存的内容/);
  assert.match(html, /invalid-record/);
});
