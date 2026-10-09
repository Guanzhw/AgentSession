#!/usr/bin/env node
// Compare frozen source-derived search expectations with captured MCP output.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORMAT = 'agentsession-v3-source-golden-comparison/v2';
const EXPECTED_FORMAT = 'agentsession-v3-source-search-expected/v1';
const EXPECTED_SUMMARY_FORMAT = 'agentsession-v3-source-search-golden-summary/v1';
const OBSERVED_FORMAT = 'agentsession-v3-source-golden-observed/v1';
const PRIOR_FORMAT = 'agentsession-v3-search-nine-observation/v1';
const MANIFEST_FORMAT = 'agentsession-v3-performance-input/v1';
const LABELS = [
  'codex-user-assistant', 'chinese-one', 'chinese-two', 'literal-percent',
  'multi-term', 'common-one', 'no-hit', 'metadata-title-directory', 'tool-name'
];
const METADATA_INDEX = 7;
const CONTENT_INDICES = LABELS.map((_, index) => index).filter(index => index !== METADATA_INDEX);
const HASH_RE = /^[0-9a-f]{64}$/;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
  : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
    : JSON.stringify(value);

function requireShape(condition, code) {
  if (!condition) throw new Error(code);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isHash(value) {
  return typeof value === 'string' && HASH_RE.test(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) && canonicalJson(Object.keys(value).sort()) === canonicalJson(keys.slice().sort());
}

function diagnosticsFromExpected(diagnostics) {
  requireShape(Array.isArray(diagnostics), 'InvalidExpectedDiagnostics');
  const values = diagnostics.map(item => {
    requireShape(isRecord(item) && typeof item.provider === 'string'
      && typeof item.status === 'string', 'InvalidExpectedDiagnostics');
    return `${item.provider}:${item.status}`;
  }).sort();
  requireShape(new Set(values).size === values.length, 'DuplicateExpectedDiagnostic');
  return values;
}

function diagnosticsFromObserved(diagnostics, code) {
  requireShape(Array.isArray(diagnostics)
    && diagnostics.every(item => typeof item === 'string' && /^[a-z-]+:(ok|partial|unavailable|invalid)$/.test(item)), code);
  const values = diagnostics.slice().sort();
  requireShape(new Set(values).size === values.length, code);
  return values;
}

function expectedRowsByIndex({ manifest, expected, expectedSummary, observedPrivate, observedPublic, frozenObservation }) {
  requireShape(manifest?.format === MANIFEST_FORMAT && Array.isArray(manifest.queries)
    && manifest.queries.length === LABELS.length && isRecord(manifest.codexStat)
    && isHash(manifest.codexStat.statManifestSha256), 'InvalidManifest');
  requireShape(expected?.format === EXPECTED_FORMAT && Array.isArray(expected.queries)
    && expected.queries.length === LABELS.length && isRecord(expected.coverage)
    && expected.coverage.status === 'partial' && expected.coverage.unresolvedCodexGroups === 2
    && expected.coverage.directCodexPairs === 1, 'InvalidExpectedGolden');
  requireShape(expectedSummary?.format === EXPECTED_SUMMARY_FORMAT
    && Array.isArray(expectedSummary.rows) && expectedSummary.rows.length === LABELS.length
    && isRecord(expectedSummary.coverage) && expectedSummary.coverage.status === 'partial'
    && expectedSummary.coverage.unresolvedCodexGroups === 2
    && expectedSummary.coverage.directCodexPairs === 1
    && typeof expectedSummary.sourceHashesUnchanged === 'boolean', 'InvalidExpectedSummary');
  requireShape(Array.isArray(observedPrivate) && observedPrivate.length === LABELS.length,
    'InvalidObservedPrivate');
  requireShape(observedPublic?.format === OBSERVED_FORMAT && Array.isArray(observedPublic.rows)
    && observedPublic.rows.length === LABELS.length && isHash(observedPublic.binarySha256)
    && typeof observedPublic.sourceStatsUnchanged === 'boolean', 'InvalidObservedSummary');
  requireShape(frozenObservation?.format === PRIOR_FORMAT && isHash(frozenObservation.binarySha256)
    && isHash(frozenObservation.codexStatManifestSha256) && frozenObservation.v2TrialStatus === 'ok'
    && Array.isArray(frozenObservation.rows) && frozenObservation.rows.length === LABELS.length,
  'InvalidFrozenObservation');

  const rows = [];
  for (let index = 0; index < LABELS.length; index++) {
    const label = LABELS[index];
    const query = manifest.queries[index];
    const gold = expected.queries[index];
    const sourceSummary = expectedSummary.rows[index];
    const capturedSummary = observedPublic.rows[index];
    const frozenRow = frozenObservation.rows[index];
    const actual = observedPrivate[index];

    requireShape(isRecord(query) && query.label === label && typeof query.query === 'string'
      && isHash(query.querySha256) && sha256(query.query) === query.querySha256 && query.limit === 20,
    'InvalidManifestQuery');
    requireShape(isRecord(gold) && gold.label === label && isHash(gold.querySha256)
      && typeof gold.coverage === 'string' && Number.isInteger(gold.count) && gold.count >= 0,
    'InvalidExpectedQuery');
    requireShape(isRecord(sourceSummary) && sourceSummary.label === label
      && typeof sourceSummary.coverage === 'string' && Number.isInteger(sourceSummary.count)
      && sourceSummary.count >= 0 && Array.isArray(sourceSummary.diagnostics), 'InvalidExpectedSummaryRow');
    requireShape(isRecord(capturedSummary) && capturedSummary.label === label
      && isHash(capturedSummary.querySha256) && Number.isInteger(capturedSummary.count)
      && capturedSummary.count >= 0 && Number.isInteger(capturedSummary.pages)
      && capturedSummary.pages > 0 && isHash(capturedSummary.orderedSemanticSha256),
    'InvalidObservedSummaryRow');
    requireShape(isRecord(frozenRow) && frozenRow.label === label && isHash(frozenRow.querySha256)
      && Number.isInteger(frozenRow.count) && frozenRow.count >= 0 && Number.isInteger(frozenRow.pages)
      && frozenRow.pages > 0 && Array.isArray(frozenRow.diagnostics), 'InvalidFrozenObservationRow');
    requireShape(Array.isArray(actual) && actual.every(isRecord), 'InvalidObservedQueryRows');

    const expectedDiagnostics = diagnosticsFromExpected(gold.diagnostics);
    const observedDiagnostics = diagnosticsFromObserved(capturedSummary.diagnostics, 'InvalidObservedDiagnostics');
    const sourceDiagnostics = diagnosticsFromObserved(sourceSummary.diagnostics, 'InvalidExpectedSummaryDiagnostics');
    const frozenDiagnostics = diagnosticsFromObserved(frozenRow.diagnostics, 'InvalidFrozenDiagnostics');
    const identityEqual = gold.querySha256 === query.querySha256
      && capturedSummary.querySha256 === query.querySha256
      && frozenRow.querySha256 === query.querySha256;
    const diagnosticsEqual = canonicalJson(expectedDiagnostics) === canonicalJson(observedDiagnostics)
      && canonicalJson(expectedDiagnostics) === canonicalJson(sourceDiagnostics)
      && canonicalJson(expectedDiagnostics) === canonicalJson(frozenDiagnostics);
    const observedDigest = sha256(canonicalJson(actual));
    const countEqual = gold.count === actual.length && capturedSummary.count === actual.length
      && sourceSummary.count === gold.count && frozenRow.count === gold.count;
    const base = { label, querySha256: query.querySha256, coverage: gold.coverage,
      expectedCount: gold.count, observedCount: actual.length, queryIdentityEqual: identityEqual,
      diagnosticsEqual, countEqual, observedSummaryHashValid: capturedSummary.orderedSemanticSha256 === observedDigest };

    if (index === METADATA_INDEX) {
      requireShape(gold.coverage === 'partial-unresolved-metadata'
        && Array.isArray(gold.knownMatches) && Array.isArray(gold.unknownMatches)
        && gold.knownMatches.length === 477 && gold.unknownMatches.length === 2
        && isHash(gold.knownOrderedSemanticSha256) && Number.isInteger(sourceSummary.unresolvedMetadataMatches),
      'InvalidMetadataGolden');
      requireShape(sourceSummary.coverage === gold.coverage
        && sourceSummary.unresolvedMetadataMatches === 2
        && sourceSummary.knownOrderedSemanticSha256 === gold.knownOrderedSemanticSha256
        && sha256(canonicalJson(gold.knownMatches)) === gold.knownOrderedSemanticSha256,
      'InvalidMetadataSummaryRow');
      requireShape(gold.count === gold.knownMatches.length + gold.unknownMatches.length,
        'InvalidMetadataGoldenCount');

      const unresolvedById = new Map();
      for (const match of gold.unknownMatches) {
        requireShape(isRecord(match) && isRecord(match.session) && match.session.provider === 'codex'
          && typeof match.session.sessionId === 'string' && match.session.sessionId.length > 0
          && ['title', 'directory'].includes(match.matchField)
          && (typeof match.title === 'string' || match.title === null)
          && (typeof match.directory === 'string' || match.directory === null), 'InvalidUnresolvedMetadataGolden');
        const key = match.session.sessionId;
        requireShape(!unresolvedById.has(key), 'DuplicateUnresolvedMetadataId');
        unresolvedById.set(key, match);
      }

      const unknownObserved = [];
      const knownObserved = [];
      const seenIds = new Set();
      for (const match of actual) {
        requireShape(hasExactKeys(match, ['directory', 'event', 'matchField', 'matchRole', 'session',
          'snippet', 'title', 'untrustedContent', 'updatedAt'])
          && hasExactKeys(match.session, ['provider', 'sessionId'])
          && isRecord(match.session) && typeof match.session.provider === 'string'
          && typeof match.session.sessionId === 'string' && match.session.sessionId.length > 0
          && ['title', 'directory'].includes(match.matchField)
          && (typeof match.title === 'string' || match.title === null)
          && (typeof match.directory === 'string' || match.directory === null)
          && typeof match.snippet === 'string' && match.event === null && match.matchRole === null
          && typeof match.untrustedContent === 'boolean'
          && typeof match.updatedAt === 'number' && Number.isFinite(match.updatedAt),
        'InvalidMetadataObservedRow');
        const id = `${match.session.provider}\0${match.session.sessionId}`;
        requireShape(!seenIds.has(id), 'DuplicateMetadataSession');
        seenIds.add(id);
        if (match.session.provider === 'codex' && unresolvedById.has(match.session.sessionId)) {
          unknownObserved.push(match);
        } else {
          knownObserved.push(match);
        }
      }

      const unresolvedProjection = matches => matches.map(match => ({
        session: { provider: match.session.provider, sessionId: match.session.sessionId },
        matchField: match.matchField,
        title: match.title,
        directory: match.directory
      }));
      const expectedUnknown = gold.unknownMatches.map(match => ({
        session: { provider: match.session.provider, sessionId: match.session.sessionId },
        matchField: match.matchField,
        title: match.title,
        directory: match.directory
      }));
      const metadataKnownRowsEqual = knownObserved.length === 477
        && canonicalJson(knownObserved) === canonicalJson(gold.knownMatches)
        && sha256(canonicalJson(knownObserved)) === gold.knownOrderedSemanticSha256;
      const unresolvedSourceFieldsEqual = unknownObserved.length === 2
        && canonicalJson(unresolvedProjection(unknownObserved)) === canonicalJson(expectedUnknown)
        && unknownObserved.every(match => match.event === null && match.matchRole === null);
      rows.push({ ...base, metadataKnownRows: knownObserved.length, unresolvedIds: unknownObserved.length,
        metadataKnownOrderedEqual: metadataKnownRowsEqual, unresolvedSourceFieldsEqual,
        knownRowTimestampsVerified: true, unresolvedTimestampVerified: false,
        unresolvedFullSourceHashVerified: false });
    } else {
      requireShape(CONTENT_INDICES.includes(index) && gold.coverage === 'partial-unresolved-content'
        && Array.isArray(gold.matches) && gold.matches.length === gold.count
        && isHash(gold.orderedSemanticSha256) && isHash(gold.firstPageSemanticSha256)
        && sha256(canonicalJson(gold.matches)) === gold.orderedSemanticSha256
        && sha256(canonicalJson(gold.matches.slice(0, query.limit))) === gold.firstPageSemanticSha256,
      'InvalidContentGolden');
      requireShape(sourceSummary.coverage === gold.coverage
        && sourceSummary.orderedSemanticSha256 === gold.orderedSemanticSha256,
      'InvalidContentSummaryRow');
      rows.push({ ...base, orderedSemanticEqual: canonicalJson(actual) === canonicalJson(gold.matches) });
    }
  }

  return rows;
}

export function compareV3SearchGolden(input) {
  const rows = expectedRowsByIndex(input);
  const { expected, expectedSummary, observedPublic, frozenObservation, chronology } = input;
  requireShape(isRecord(chronology) && chronology.inputPathsDistinct === true
    && chronology.expectedMtimeMs < chronology.observedPrivateMtimeMs
    && chronology.expectedSummaryMtimeMs < chronology.observedPrivateMtimeMs
    && chronology.observedPublicMtimeMs >= chronology.observedPrivateMtimeMs,
  'ChronologyNotEstablished');

  const binaryMatchesFrozenSummary = observedPublic.binarySha256 === frozenObservation.binarySha256;
  const sourceStats = {
    expectedSourceHashesUnchanged: expectedSummary.sourceHashesUnchanged,
    capturedSourceStatsUnchanged: observedPublic.sourceStatsUnchanged,
    codexStatManifestSha256: input.manifest.codexStat.statManifestSha256,
    codexStatManifestMatchesFrozenObservation: input.manifest.codexStat.statManifestSha256
      === frozenObservation.codexStatManifestSha256
  };
  const sourceStatsMatch = sourceStats.expectedSourceHashesUnchanged === true
    && sourceStats.capturedSourceStatsUnchanged === true
    && sourceStats.codexStatManifestMatchesFrozenObservation === true;
  const passed = binaryMatchesFrozenSummary && sourceStatsMatch && rows.every(row => row.queryIdentityEqual
    && row.diagnosticsEqual && row.countEqual && row.observedSummaryHashValid
    && (row.metadataKnownOrderedEqual === undefined || row.metadataKnownOrderedEqual)
    && (row.unresolvedSourceFieldsEqual === undefined || row.unresolvedSourceFieldsEqual)
    && (row.orderedSemanticEqual === undefined || row.orderedSemanticEqual));

  return {
    format: FORMAT,
    status: passed ? 'passed' : 'mismatch',
    binarySha256: observedPublic.binarySha256,
    binaryMatchesFrozenObservation: binaryMatchesFrozenSummary,
    sourceStats,
    chronology: {
      status: 'filesystem-order-and-source-summary-consistent',
      expectedAndSummaryPrecedeCapture: true,
      expectedIsDistinctFromObserved: true,
      evidence: 'The expected artifact and its source-derived public summary are separate files, both earlier than the captured private result; the summary reproduces the expected rows, while expected, captured, and frozen query hashes match the manifest.',
      limit: 'Filesystem timestamps and matching summaries cannot prove that an artifact was never replaced or backdated after capture.'
    },
    rows,
    metadataLimits: {
      sourceKnownOrderedRowsCompared: 477,
      sourceKnownRowsComparedExactly: true,
      unresolvedIdsComparedOnSourceFields: 2,
      unresolvedTimestampVerified: false,
      unresolvedFullSourceHashVerified: false
    }
  };
}

function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const accepted = new Set(['--manifest', '--expected', '--expected-summary', '--observed-private',
    '--observed-public', '--frozen-observation', '--output']);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    requireShape(accepted.has(key) && typeof value === 'string' && value.length > 0
      && !Object.hasOwn(options, key), 'InvalidArguments');
    options[key] = value;
  }
  requireShape([...accepted].every(key => typeof options[key] === 'string'), 'InvalidArguments');
  return Object.fromEntries(Object.entries(options).map(([key, value]) => [key.slice(2).replaceAll('-', ''), value]));
}

function pathIdentity(filePath) {
  const resolved = realpathSync.native(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function validatePathSeparation(files) {
  const identities = new Map();
  for (const [name, filePath] of Object.entries(files).filter(([name]) => name !== 'output')) {
    const identity = pathIdentity(filePath);
    requireShape(!identities.has(identity), 'InputFilesMustBeDistinct');
    identities.set(identity, name);
  }
  const outputPath = path.resolve(files.output);
  let outputIdentity = outputPath;
  try { outputIdentity = pathIdentity(outputPath); }
  catch {
    try { outputIdentity = path.join(realpathSync.native(path.dirname(outputPath)), path.basename(outputPath)); }
    catch { /* The later write will surface a missing output parent. */ }
  }
  if (process.platform === 'win32') outputIdentity = outputIdentity.toLowerCase();
  requireShape(!identities.has(outputIdentity), 'OutputMustBeDistinctFromInputs');
}

function readJson(filePath, code) {
  try { return JSON.parse(readFileSync(filePath, 'utf8')); }
  catch { throw new Error(code); }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('Usage: node scripts/v3-compare-search-v3-golden.mjs --manifest <private-json> --expected <private-json> --expected-summary <public-json> --observed-private <private-json> --observed-public <public-json> --frozen-observation <public-json> --output <public-json>');
    return;
  }
  const fileOptions = { manifest: options.manifest, expected: options.expected,
    expectedSummary: options.expectedsummary, observedPrivate: options.observedprivate,
    observedPublic: options.observedpublic, frozenObservation: options.frozenobservation,
    output: options.output };
  validatePathSeparation(fileOptions);
  const files = Object.fromEntries(Object.entries(fileOptions).filter(([key]) => key !== 'output'));
  const input = {
    manifest: readJson(files.manifest, 'InvalidManifestJson'),
    expected: readJson(files.expected, 'InvalidExpectedJson'),
    expectedSummary: readJson(files.expectedSummary, 'InvalidExpectedSummaryJson'),
    observedPrivate: readJson(files.observedPrivate, 'InvalidObservedPrivateJson'),
    observedPublic: readJson(files.observedPublic, 'InvalidObservedPublicJson'),
    frozenObservation: readJson(files.frozenObservation, 'InvalidFrozenObservationJson')
  };
  const expectedStat = statSync(files.expected);
  const expectedSummaryStat = statSync(files.expectedSummary);
  const observedPrivateStat = statSync(files.observedPrivate);
  const observedPublicStat = statSync(files.observedPublic);
  const inputWithChronology = { ...input, chronology: {
    inputPathsDistinct: true,
    expectedMtimeMs: expectedStat.mtimeMs,
    expectedSummaryMtimeMs: expectedSummaryStat.mtimeMs,
    observedPrivateMtimeMs: observedPrivateStat.mtimeMs,
    observedPublicMtimeMs: observedPublicStat.mtimeMs
  } };
  const report = compareV3SearchGolden(inputWithChronology);
  writeFileSync(fileOptions.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  if (!report.status || report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = typeof error?.message === 'string' && /^[A-Za-z][A-Za-z0-9]+$/.test(error.message)
      ? error.message : 'ComparisonFailed';
    console.error(`Comparison failed: ${code}`);
    process.exitCode = 1;
  });
}
