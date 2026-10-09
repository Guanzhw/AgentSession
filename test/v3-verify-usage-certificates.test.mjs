import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { verifyCertificateBundle } from '../scripts/v3-verify-usage-certificates.mjs';

const fixtureDir = fileURLToPath(new URL('./fixtures/v3-usage-certificates/', import.meta.url));
const verifierPath = fileURLToPath(new URL('../scripts/v3-verify-usage-certificates.mjs', import.meta.url));
const bundle = JSON.parse(await readFile(join(fixtureDir, 'certificates.json'), 'utf8'));

async function loadSources(sourceEntries = bundle.sources) {
  return new Map(await Promise.all(sourceEntries.map(async source => [
    source.id,
    await readFile(join(fixtureDir, source.path)),
  ])));
}

function certificateFor(source, line) {
  return bundle.certificates.find(certificate => certificate.source === source && certificate.line === line);
}

function classifyAltered(certificate, changes) {
  const altered = structuredClone(certificate);
  changes(altered);
  return verifyCertificateBundle({ ...structuredClone(bundle), certificates: [altered] }, sourceBytes)
    .certificates[0].classification;
}

const sourceBytes = await loadSources();

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function rawLine(bytes, lineNumber) {
  let line = 1;
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index < bytes.length && bytes[index] !== 0x0a) continue;
    if (line === lineNumber) return bytes.subarray(start, index);
    line += 1;
    start = index + 1;
  }
  return null;
}

function classifyWithChangedSources(certificate, changedSources, selectedLine = certificate.line) {
  const alteredBundle = structuredClone(bundle);
  const bytesBySource = new Map(sourceBytes);
  for (const [sourceId, changedBytes] of changedSources) {
    const sourceMeta = alteredBundle.sources.find(source => source.id === sourceId);
    sourceMeta.sourceSha256 = sha256(changedBytes);
    bytesBySource.set(sourceId, changedBytes);
  }
  const alteredCertificate = structuredClone(certificate);
  alteredBundle.certificates = [alteredCertificate];
  alteredCertificate.line = selectedLine;
  const selectedBytes = bytesBySource.get(alteredCertificate.source);
  alteredCertificate.sourceSha256 = alteredBundle.sources.find(source => source.id === alteredCertificate.source).sourceSha256;
  alteredCertificate.rawHash = sha256(rawLine(selectedBytes, selectedLine));
  for (const ref of alteredCertificate.witnessRefs) {
    const refBytes = bytesBySource.get(ref.source);
    const refMeta = alteredBundle.sources.find(source => source.id === ref.source);
    ref.sourceSha256 = refMeta.sourceSha256;
    ref.rawHash = sha256(rawLine(refBytes, ref.line));
  }
  return verifyCertificateBundle(alteredBundle, bytesBySource)
    .certificates[0].classification;
}

function classifyWithChangedSource(certificate, sourceId, changedBytes, selectedLine = certificate.line) {
  return classifyWithChangedSources(certificate, new Map([[sourceId, changedBytes]]), selectedLine);
}

function classifyWithAdditionalSource(certificate, sourceId, row) {
  const bytes = Buffer.from(`${JSON.stringify(row)}\n`);
  const expandedBundle = structuredClone(bundle);
  expandedBundle.sources.push({ id: sourceId, path: `${sourceId}.jsonl`, sourceSha256: sha256(bytes) });
  expandedBundle.certificates = [structuredClone(certificate)];
  return verifyCertificateBundle(expandedBundle, new Map(sourceBytes).set(sourceId, bytes))
    .certificates[0].classification;
}

async function makeCliHarness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentsession-usage-certificate-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const source of bundle.sources) await writeFile(join(directory, source.path), sourceBytes.get(source.id));
  const bundlePath = join(directory, 'certificates.json');
  const writeBundle = value => writeFile(bundlePath, `${JSON.stringify(value, null, 2)}\n`);
  const run = path => spawnSync(process.execPath, [verifierPath, path], { encoding: 'utf8' });
  return { directory, bundlePath, writeBundle, run };
}

test('public challenge certificates validate while preserving unresolved observations', () => {
  const result = verifyCertificateBundle(bundle, sourceBytes);
  assert.equal(result.verified, true);
  assert.equal(result.scope, 'public-challenge');
  assert.equal(result.identityScope, 'supplied-source-bundle');
  assert.equal(result.certificateCount, 8);
  assert.deepEqual(result.classifications, {
    'proved-request': 2,
    'proved-mirror': 2,
    'proved-parent-copy': 1,
    'proved-context-snapshot': 1,
    unresolved: 2,
  });
  assert.match(result.coverage, /not corpus-wide/);
});

test('equal token vectors with distinct response IDs remain separate proved requests', () => {
  const result = verifyCertificateBundle(bundle, sourceBytes);
  const first = result.certificates.find(item => item.source === 'mixed' && item.line === 3);
  const second = result.certificates.find(item => item.source === 'mixed' && item.line === 5);
  assert.equal(first.classification, 'proved-request');
  assert.equal(second.classification, 'proved-request');
});

test('a request without all six nonnegative usage fields cannot be proved unique', () => {
  const lines = sourceBytes.get('mixed').toString('utf8').split('\n');
  const row = JSON.parse(lines[2]);
  delete row.request.reasoning_output_tokens;
  lines[2] = JSON.stringify(row);
  assert.equal(classifyWithChangedSource(certificateFor('mixed', 3), 'mixed', Buffer.from(lines.join('\n'))), 'unresolved');
});

test('removing the explicit owner witness downgrades a mirror to unresolved', () => {
  assert.equal(classifyAltered(certificateFor('mixed', 4), certificate => {
    certificate.witnessRefs = certificate.witnessRefs.filter(ref => ref.role !== 'owner');
  }), 'unresolved');
});

test('a mirror with no explicit nonempty response identity stays unresolved', () => {
  const lines = sourceBytes.get('mixed').toString('utf8').split('\n');
  const canonical = JSON.parse(lines[2]);
  delete canonical.responseId;
  lines[2] = JSON.stringify(canonical);
  const certificate = structuredClone(certificateFor('mixed', 4));
  delete certificate.identityEvidence.responseId;
  assert.equal(classifyWithChangedSource(certificate, 'mixed', Buffer.from(lines.join('\n'))), 'unresolved');
});

test('any extra usage between mirror baseline, canonical request, and selected row stops proof', () => {
  const certificate = certificateFor('mixed', 4);
  const beforeCanonical = sourceBytes.get('mixed').toString('utf8').split('\n');
  beforeCanonical.splice(2, 0, JSON.stringify({ kind: 'usage', ownerId: 'mixed' }));
  const shiftedCertificate = structuredClone(certificate);
  shiftedCertificate.witnessRefs.find(ref => ref.role === 'canonical-request').line = 4;
  assert.equal(classifyWithChangedSource(shiftedCertificate, 'mixed', Buffer.from(beforeCanonical.join('\n')), 5), 'unresolved');

  const beforeSelected = sourceBytes.get('mixed').toString('utf8').split('\n');
  beforeSelected.splice(3, 0, JSON.stringify({ kind: 'legacy', ownerId: 'mixed' }));
  assert.equal(classifyWithChangedSource(certificate, 'mixed', Buffer.from(beforeSelected.join('\n')), 5), 'unresolved');
});

test('removing the unique content witness downgrades a parent copy to unresolved', () => {
  assert.equal(classifyAltered(certificateFor('child', 3), certificate => {
    certificate.witnessRefs = certificate.witnessRefs.filter(ref => ref.role !== 'child-content');
  }), 'unresolved');
});

test('removing the NEW_TASK boundary downgrades a parent copy to unresolved', () => {
  assert.equal(classifyAltered(certificateFor('child', 3), certificate => {
    certificate.witnessRefs = certificate.witnessRefs.filter(ref => ref.role !== 'dispatch-boundary');
  }), 'unresolved');
});

test('removing the complete cumulative baseline downgrades a compact snapshot to unresolved', () => {
  assert.equal(classifyAltered(certificateFor('context', 4), certificate => {
    certificate.witnessRefs = certificate.witnessRefs.filter(ref => ref.role !== 'baseline');
  }), 'unresolved');
});

test('an intervening owner boundary downgrades a compact snapshot to unresolved', () => {
  const lines = sourceBytes.get('context').toString('utf8').split('\n');
  lines.splice(3, 0, JSON.stringify({ kind: 'owner', ownerId: 'other' }));
  assert.equal(classifyWithChangedSource(certificateFor('context', 4), 'context', Buffer.from(lines.join('\n')), 5), 'unresolved');
});

test('an intervening usage row with unknown owner interrupts a compact snapshot', () => {
  const lines = sourceBytes.get('context').toString('utf8').split('\n');
  lines.splice(3, 0, JSON.stringify({ kind: 'usage', ownerId: null }));
  assert.equal(classifyWithChangedSource(certificateFor('context', 4), 'context', Buffer.from(lines.join('\n')), 5), 'unresolved');
});

test('a matching NEW_TASK boundary elsewhere in the supplied bundle makes parent-copy unresolved', () => {
  const boundary = JSON.parse(sourceBytes.get('parent').toString('utf8').split('\n')[3]);
  assert.equal(classifyWithAdditionalSource(certificateFor('child', 3), 'boundary-shadow', boundary), 'unresolved');
});

test('matching content in another supplied source makes parent-copy unresolved', () => {
  const content = JSON.parse(sourceBytes.get('parent').toString('utf8').split('\n')[1]);
  assert.equal(classifyWithAdditionalSource(certificateFor('child', 3), 'content-shadow', content), 'unresolved');
});

test('an owner switch in the child chain makes parent-copy unresolved', () => {
  const lines = sourceBytes.get('child').toString('utf8').split('\n');
  lines.splice(2, 0, JSON.stringify({ kind: 'owner', ownerId: 'other-child' }));
  assert.equal(classifyWithChangedSource(certificateFor('child', 3), 'child', Buffer.from(lines.join('\n')), 4), 'unresolved');
});

test('an extra same-owner usage in the child chain makes parent-copy unresolved', () => {
  const lines = sourceBytes.get('child').toString('utf8').split('\n');
  lines.splice(2, 0, JSON.stringify({ kind: 'usage', ownerId: 'child' }));
  assert.equal(classifyWithChangedSource(certificateFor('child', 3), 'child', Buffer.from(lines.join('\n')), 4), 'unresolved');
});

test('extra parent usage or owner boundaries before NEW_TASK make parent-copy unresolved', () => {
  const certificate = certificateFor('child', 3);
  const extraUsage = sourceBytes.get('parent').toString('utf8').split('\n');
  extraUsage.splice(3, 0, JSON.stringify({ kind: 'usage', ownerId: 'parent' }));
  const shiftedBoundary = structuredClone(certificate);
  shiftedBoundary.witnessRefs.find(ref => ref.role === 'dispatch-boundary').line = 5;
  assert.equal(classifyWithChangedSources(shiftedBoundary, new Map([['parent', Buffer.from(extraUsage.join('\n'))]])), 'unresolved');

  const extraOwner = sourceBytes.get('parent').toString('utf8').split('\n');
  extraOwner.splice(2, 0, JSON.stringify({ kind: 'owner', ownerId: 'parent' }));
  const shiftedParentWitnesses = structuredClone(certificate);
  shiftedParentWitnesses.witnessRefs.find(ref => ref.role === 'parent-usage').line = 4;
  shiftedParentWitnesses.witnessRefs.find(ref => ref.role === 'dispatch-boundary').line = 5;
  assert.equal(classifyWithChangedSources(shiftedParentWitnesses, new Map([['parent', Buffer.from(extraOwner.join('\n'))]])), 'unresolved');
});

test('an owner boundary between parent owner and content makes parent-copy unresolved', () => {
  const lines = sourceBytes.get('parent').toString('utf8').split('\n');
  lines.splice(1, 0, JSON.stringify({ kind: 'owner', ownerId: 'other-parent' }));
  const shiftedWitnesses = structuredClone(certificateFor('child', 3));
  shiftedWitnesses.witnessRefs.find(ref => ref.role === 'parent-content').line = 3;
  shiftedWitnesses.witnessRefs.find(ref => ref.role === 'parent-usage').line = 4;
  shiftedWitnesses.witnessRefs.find(ref => ref.role === 'dispatch-boundary').line = 5;
  assert.equal(classifyWithChangedSources(shiftedWitnesses, new Map([['parent', Buffer.from(lines.join('\n'))]])), 'unresolved');
});

test('a cumulative decrease from baseline blocks mirror proof and absent owners stay unknown', () => {
  const lines = sourceBytes.get('mixed').toString('utf8').split('\n');
  const baseline = JSON.parse(lines[1]);
  baseline.cumulative.input_tokens += 100;
  baseline.cumulative.total_tokens += 100;
  lines[1] = JSON.stringify(baseline);
  assert.equal(classifyWithChangedSource(certificateFor('mixed', 4), 'mixed', Buffer.from(lines.join('\n'))), 'unresolved');

  const result = verifyCertificateBundle(bundle, sourceBytes);
  assert.equal(result.certificates.find(item => item.source === 'mixed' && item.line === 11).classification, 'unresolved');
});

test('a matching owner and response in another source prevents a unique-request claim', () => {
  const duplicate = bundle.sources.find(source => source.id === 'mixed');
  const expandedBundle = structuredClone(bundle);
  expandedBundle.sources.push({ ...duplicate, id: 'duplicate-copy' });
  const expandedSources = new Map(sourceBytes);
  expandedSources.set('duplicate-copy', sourceBytes.get('mixed'));
  const result = verifyCertificateBundle(expandedBundle, expandedSources);
  assert.equal(result.certificates.find(item => item.source === 'mixed' && item.line === 3).classification, 'unresolved');
});

test('source hash and selected raw-line hash reject altered evidence', () => {
  const changedSource = Buffer.from(sourceBytes.get('mixed'));
  changedSource[0] ^= 1;
  assert.throws(() => verifyCertificateBundle(bundle, new Map(sourceBytes).set('mixed', changedSource)), /Source SHA-256/);

  const altered = structuredClone(bundle);
  altered.certificates[0].rawHash = '0'.repeat(64);
  assert.throws(() => verifyCertificateBundle(altered, sourceBytes), /rawHash/);
});

test('CLI failures report stable safe codes without source paths or row content', async t => {
  const harness = await makeCliHarness(t);
  const expectCode = async (code, value, path = harness.bundlePath) => {
    if (typeof value === 'string') await writeFile(path, value);
    else await harness.writeBundle(value);
    const result = harness.run(path);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), `Usage certificate verification failed: ${code}`);
    assert.doesNotMatch(result.stderr, /private-row-sentinel/);
    assert.doesNotMatch(result.stderr, new RegExp(harness.directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  };

  const unreadableSource = structuredClone(bundle);
  unreadableSource.sources[0].path = 'missing-private-row-sentinel.jsonl';
  await expectCode('SOURCE_READ_FAILED', unreadableSource);

  const sourceHashMismatch = structuredClone(bundle);
  sourceHashMismatch.sources[0].sourceSha256 = '0'.repeat(64);
  await expectCode('SOURCE_HASH_MISMATCH', sourceHashMismatch);

  const rawHashMismatch = structuredClone(bundle);
  rawHashMismatch.certificates[0].rawHash = '0'.repeat(64);
  await expectCode('RAW_HASH_MISMATCH', rawHashMismatch);

  await expectCode('BUNDLE_SCHEMA_INVALID', '{ malformed json');
  await expectCode('BUNDLE_READ_FAILED', undefined, join(harness.directory, 'missing-bundle.json'));
});
