import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { renderSessionReaderPane } = await import("../dist/src/views/session.js");
const { setLocale } = await import("../dist/src/i18n.js");
const { renderArtifactEvidenceActivity, renderArtifactEvidenceCoverage } = await import("../dist/src/views/reader-artifacts.js");

const provenance = { fidelity: "recorded", sourceType: "codex.memory_stage1", sourceId: "job-1" };
const artifacts = [
  { id: "memory:source:1", sessionId: "source", kind: "memory", scope: "user", origin: "provider-generated", contentAccess: "full", title: null, summary: null, sourcePath: "memories.sqlite", producerRunId: null, sourceSessionIds: ["source"], hash: "a".repeat(64), redacted: false, provenance, timeCreated: 1_700_000_010_000, contentSourceTime: 1_700_000_000_000, productionEvidence: { provenance, startedAt: 1_700_000_001_000, completedAt: 1_700_000_010_000, inputUpdatedAt: 1_700_000_000_000 }, metadata: { contentLength: 12 } },
  { id: "summary:source:1", sessionId: "source", kind: "summary", scope: "session", origin: "provider-generated", contentAccess: "full", title: null, summary: null, sourcePath: "memories.sqlite", producerRunId: null, sourceSessionIds: ["source"], hash: "b".repeat(64), redacted: false, provenance, timeCreated: 1_700_000_010_000, contentSourceTime: 1_700_000_000_000, productionEvidence: null, metadata: { contentLength: 0 } }
];

test("saved-output grid tracks keep long request sources inside their own scroller", () => {
  const css = readFileSync(new URL("../src/static/style.css", import.meta.url), "utf8");
  for (const selector of ["reader-artifact-lineage", "reader-artifact-branches"]) {
    assert.match(css, new RegExp(`\\.${selector} \\{[^}]*grid-template-columns: minmax\\(0, 1fr\\)`));
  }
});

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

test('later consolidation is advertised per artifact and leaves its records unloaded', () => {
  const saved = artifacts.map((artifact) => artifact.kind === 'summary' ? { ...artifact, evidenceAccess: 'on-demand' } : artifact);
  const common = { session: { id: 'child', title: 'Child' }, provider: 'fixture', contextArtifacts: saved, canReadContextArtifacts: true };
  assert.doesNotMatch(renderSessionReaderPane(common), /data-artifact-evidence /);
  const html = renderSessionReaderPane({ ...common, canReadContextArtifactEvidence: true });
  assert.equal((html.match(/data-artifact-evidence /g) || []).length, 1);
  assert.match(html, /Later consolidation/);
  assert.match(html, /data-artifact-evidence data-context-artifact-id="summary:source:1" data-search-exclude/);
  assert.doesNotMatch(html, /data-artifact-activity-id|data-artifact-record-id/);
  assert.equal((html.match(/data-load-initial/g) || []).length, 2, 'summary expansion loads only saved bodies');
});

test('followup rendering retains request semantics, derived binding and unavailable generation history', (context) => {
  const activity = { id: 'activity', sessionId: 'generation<script>', turnId: 'turn', timeCreated: 1700000001000, provenance, historyAvailability: 'unavailable',
    binding: { sourcePath: 'C:\\memories\\summaries\\source.md', fileHash: 'hash', checkedAt: 1700000900000, sourceSessionId: 'source', sourceUpdatedAt: 1700000000000, provenance: { fidelity: 'derived', sourceType: 'fixture.match' } },
    records: [
      { id: 'read', kind: 'read-request', targetPath: 'C:\\memories\\summaries\\source.md', timeCreated: 1700000002000, provenance, contentLength: 9000 },
      { id: 'patch', kind: 'modification-request', targetPath: '/memories/MEMORY.md', timeCreated: 1700000003000, provenance, contentLength: 14000 }
    ] };
  const html = renderArtifactEvidenceActivity(activity, 'summary-version');
  assert.match(html, /Request to read/);
  assert.match(html, /Request to modify/);
  assert.match(html, />source\.md<\/code>/);
  assert.match(html, /<small title="Recorded source"><time datetime="2023-11-14T22:13:22.000Z">/);
  assert.match(html, /<small title="Recorded source"><time datetime="2023-11-14T22:13:23.000Z">/);
  assert.match(html, /<p class="reader-artifact-followup-path"><code>C:\\memories\\summaries\\source\.md<\/code>/);
  assert.match(html, /currently matches this summary/);
  assert.match(html, /full generating history is unavailable/);
  assert.match(html, /Modification outcomes are not recorded/);
  assert.match(html, /derived \/ fixture.match/);
  assert.doesNotMatch(html, /href=|<script>|successful|data-message-id|data-part-id/);
  assert.equal((html.match(/data-load-initial/g) || []).length, 2);
  const coverage = { from: 1700000000000, to: 1700003600000, scannedRecords: 12, readBytes: 5000, complete: false, issues: ['summary-file-missing'] };
  assert.match(renderArtifactEvidenceCoverage(coverage), /summary file is no longer available/);
  setLocale('zh');
  context.after(() => setLocale('en'));
  assert.match(renderArtifactEvidenceActivity(activity, 'summary-version'), /请求读取|请求修改/);
  assert.match(renderArtifactEvidenceCoverage(coverage), /摘要文件已不可用/);
});
