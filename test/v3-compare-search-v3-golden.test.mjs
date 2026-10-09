import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareV3SearchGolden, validatePathSeparation } from '../scripts/v3-compare-search-v3-golden.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
  : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
    : JSON.stringify(value);

function fixture() {
  const labels = ['codex-user-assistant', 'chinese-one', 'chinese-two', 'literal-percent',
    'multi-term', 'common-one', 'no-hit', 'metadata-title-directory', 'tool-name'];
  const binarySha256 = 'a'.repeat(64);
  const codexStatManifestSha256 = 'b'.repeat(64);
  const manifest = { format: 'agentsession-v3-performance-input/v1',
    codexStat: { statManifestSha256: codexStatManifestSha256 },
    queries: labels.map((label, index) => {
      const query = `synthetic query ${index}`;
      return { label, query, querySha256: sha256(query), limit: 20 };
    }) };
  const expectedQueries = [];
  const sourceRows = [];
  const observedPrivate = [];
  const observedRows = [];
  const frozenRows = [];

  for (let index = 0; index < labels.length; index++) {
    const label = labels[index];
    const querySha256 = manifest.queries[index].querySha256;
    const diagnostics = index < 7 ? [{ provider: 'codex', status: 'partial' }]
      : ['claude-code', 'codex', 'deepseek-harness', 'opencode', 'pi'].map(provider => ({
        provider, status: provider === 'codex' ? 'partial' : 'ok'
      }));
    const publicDiagnostics = diagnostics.map(item => `${item.provider}:${item.status}`).sort();

    if (index === 7) {
      const knownMatches = Array.from({ length: 477 }, (_, row) => ({
        session: { provider: 'codex', sessionId: `known-${String(row).padStart(3, '0')}` },
        event: null,
        matchField: row % 2 ? 'title' : 'directory',
        matchRole: null,
        snippet: `source-backed-${row}`,
        title: `title-${row}`,
        directory: `directory-${row}`,
        updatedAt: 1000 + row,
        untrustedContent: true
      }));
      const unknownMatches = ['unknown-a', 'unknown-b'].map((sessionId, row) => ({
        session: { provider: 'codex', sessionId },
        matchField: 'directory',
        title: `unresolved-title-${row}`,
        directory: `unresolved-directory-${row}`
      }));
      const observedMetadata = [
        ...structuredClone(knownMatches),
        ...unknownMatches.map((match, row) => ({ ...match, event: null, matchRole: null,
          snippet: `capture-${row}`, updatedAt: 9000 + row, untrustedContent: true }))
      ];
      const knownOrderedSemanticSha256 = sha256(canonicalJson(knownMatches));
      expectedQueries.push({ label, querySha256, coverage: 'partial-unresolved-metadata', count: 479,
        knownOrderedSemanticSha256, diagnostics, knownMatches, unknownMatches });
      sourceRows.push({ label, coverage: 'partial-unresolved-metadata', count: 479,
        orderedSemanticSha256: null, knownOrderedSemanticSha256, unresolvedMetadataMatches: 2,
        diagnostics: publicDiagnostics, querySha256 });
      observedPrivate.push(observedMetadata);
      observedRows.push({ label, querySha256, count: 479, pages: 24,
        orderedSemanticSha256: sha256(canonicalJson(observedMetadata)), diagnostics: publicDiagnostics });
      frozenRows.push({ label, querySha256, count: 479, pages: 24, diagnostics: publicDiagnostics });
      continue;
    }

    const matches = index === 6 ? [] : [{
      session: { provider: 'codex', sessionId: `content-${index}` },
      event: { messageId: `event-${index}`, sessionId: `content-${index}` },
      snippet: `semantic-row-${index}`
    }];
    const orderedSemanticSha256 = sha256(canonicalJson(matches));
    const firstPageSemanticSha256 = orderedSemanticSha256;
    const coverage = 'partial-unresolved-content';
    expectedQueries.push({ label, querySha256, coverage, count: matches.length,
      orderedSemanticSha256, firstPageSemanticSha256, diagnostics, matches });
    sourceRows.push({ label, querySha256, coverage, count: matches.length,
      orderedSemanticSha256, knownOrderedSemanticSha256: null, unresolvedMetadataMatches: 0,
      diagnostics: publicDiagnostics });
    observedPrivate.push(structuredClone(matches));
    observedRows.push({ label, querySha256, count: matches.length, pages: 1,
      orderedSemanticSha256, diagnostics: publicDiagnostics });
    frozenRows.push({ label, querySha256, count: matches.length, pages: 1, diagnostics: publicDiagnostics });
  }

  return {
    manifest,
    expected: { format: 'agentsession-v3-source-search-expected/v1',
      coverage: { status: 'partial', unresolvedCodexGroups: 2, directCodexPairs: 1 }, queries: expectedQueries },
    expectedSummary: { format: 'agentsession-v3-source-search-golden-summary/v1',
      coverage: { status: 'partial', unresolvedCodexGroups: 2, directCodexPairs: 1 },
      sourceHashesUnchanged: true, rows: sourceRows },
    observedPrivate,
    observedPublic: { format: 'agentsession-v3-source-golden-observed/v1', binarySha256,
      sourceStatsUnchanged: true, rows: observedRows },
    frozenObservation: { format: 'agentsession-v3-search-nine-observation/v1', binarySha256,
      codexStatManifestSha256, v2TrialStatus: 'ok', rows: frozenRows },
    chronology: { inputPathsDistinct: true, expectedMtimeMs: 10,
      expectedSummaryMtimeMs: 11, observedPrivateMtimeMs: 20, observedPublicMtimeMs: 21 }
  };
}

test('source golden comparison verifies content rows and metadata source fields while redacting rows', () => {
  const report = compareV3SearchGolden(fixture());

  assert.equal(report.status, 'passed');
  assert.equal(report.rows.length, 9);
  assert.equal(report.rows.filter(row => row.orderedSemanticEqual).length, 8);
  assert.equal(report.rows[7].metadataKnownRows, 477);
  assert.equal(report.rows[7].unresolvedIds, 2);
  assert.equal(report.rows[7].metadataKnownOrderedEqual, true);
  assert.equal(report.rows[7].unresolvedSourceFieldsEqual, true);
  assert.equal(report.rows[7].knownRowTimestampsVerified, true);
  assert.equal(report.rows[7].unresolvedTimestampVerified, false);
  assert.equal(report.rows[7].unresolvedFullSourceHashVerified, false);
  assert.doesNotMatch(JSON.stringify(report), /sessionId|semantic-row|source-backed|known-000/);
});

test('source golden comparison fails when a content result identity changes', () => {
  const input = fixture();
  input.observedPrivate[0][0].session.sessionId = 'wrong-session';
  input.observedPublic.rows[0].orderedSemanticSha256 = sha256(canonicalJson(input.observedPrivate[0]));

  const report = compareV3SearchGolden(input);

  assert.equal(report.status, 'mismatch');
  assert.equal(report.rows[0].orderedSemanticEqual, false);
});

test('source golden comparison checks full ordered metadata rows, including known timestamps', () => {
  const input = fixture();
  input.observedPrivate[7][0].updatedAt++;
  input.observedPublic.rows[7].orderedSemanticSha256 = sha256(canonicalJson(input.observedPrivate[7]));

  const report = compareV3SearchGolden(input);

  assert.equal(report.status, 'mismatch');
  assert.equal(report.rows[7].metadataKnownOrderedEqual, false);
});

test('source golden comparison reports binary, source-stat, query, and diagnostic mismatches', () => {
  const input = fixture();
  input.observedPublic.binarySha256 = 'c'.repeat(64);
  input.observedPublic.sourceStatsUnchanged = false;
  input.observedPublic.rows[1].querySha256 = 'd'.repeat(64);
  input.observedPublic.rows[2].diagnostics = ['codex:ok'];

  const report = compareV3SearchGolden(input);

  assert.equal(report.status, 'mismatch');
  assert.equal(report.binaryMatchesFrozenObservation, false);
  assert.equal(report.sourceStats.capturedSourceStatsUnchanged, false);
  assert.equal(report.rows[1].queryIdentityEqual, false);
  assert.equal(report.rows[2].diagnosticsEqual, false);
});

test('source golden comparison fails closed when chronology or artifact shape is invalid', () => {
  const chronologyInput = fixture();
  chronologyInput.chronology.expectedMtimeMs = 20;
  assert.throws(() => compareV3SearchGolden(chronologyInput), /ChronologyNotEstablished/);

  const malformedInput = fixture();
  malformedInput.observedPrivate[3] = {};
  assert.throws(() => compareV3SearchGolden(malformedInput), /InvalidObservedQueryRows/);
});

test('source golden command rejects aliased expected, observed, and output paths', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'v3-search-golden-'));
  try {
    const files = Object.fromEntries(['manifest', 'expected', 'expectedSummary', 'observedPrivate',
      'observedPublic', 'frozenObservation', 'output'].map(name => [name, path.join(directory, `${name}.json`)]));
    for (const [name, filePath] of Object.entries(files)) writeFileSync(filePath, name);

    assert.throws(() => validatePathSeparation({ ...files, observedPrivate: files.expected }),
      /InputFilesMustBeDistinct/);
    assert.throws(() => validatePathSeparation({ ...files, output: files.expected }),
      /OutputMustBeDistinctFromInputs/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
