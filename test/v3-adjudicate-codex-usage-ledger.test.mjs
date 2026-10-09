import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdtemp, readFile, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runAdjudication } from '../scripts/v3-adjudicate-codex-usage-ledger.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const hash = text => sha(text);
const outputRoot = path.resolve(fileURLToPath(new URL('../tmp/', import.meta.url)));
const fixtureDirs = [];
after(async () => {
  for (const dir of fixtureDirs) {
    if (!dir.startsWith(outputRoot + path.sep)) throw new Error('fixture outside tmp');
    await rm(dir, { recursive: true, force: true });
  }
});
const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const vector = (state = 'zero') => Object.fromEntries(fields.map(field =>
  [field, state === 'missing' ? { state } : { state, value: 0 }]));

async function fixture(rows, options = {}) {
  await mkdir(outputRoot, { recursive: true });
  const dir = await mkdtemp(path.join(outputRoot, 'usage-adjudication-'));
  fixtureDirs.push(dir);
  const root = path.join(dir, 'frozen-codex');
  await mkdir(root);
  const files = Array.isArray(rows[0]) ? rows : [rows];
  const manifest = { root, files: files.map((_, index) =>
    ({ path: `file-${index}.jsonl`, bytes: 1000, sha256: hash(`source${index}`) })) };
  const manifestPath = path.join(dir, 'manifest.json');
  const manifestBytes = JSON.stringify(manifest);
  await writeFile(manifestPath, manifestBytes);
  const proof = { format: 'agentsession-v3-codex-source-inventory-proof/v1',
    status: 'complete', complete: true, scope: 'declared-root-only',
    rootLabel: 'frozen-codex', rootSha256: hash(root), manifestSha256: hash(manifestBytes),
    expectedManifestEntries: files.length, manifestEntries: files.length,
    manifestUniquePaths: files.length, duplicateManifestEntries: 0,
    rootEligibleFiles: files.length,
    omittedFromManifest: { count: 0 }, manifestOutsideInventory: { count: 0 } };
  const pathHash = createHash('sha256').update('agentsession-codex-path-set/v1\0');
  for (const entry of manifest.files) pathHash.update(entry.path).update('\0');
  const pathSet = pathHash.digest('hex');
  proof.rootPathSetSha256 = pathSet;
  proof.manifestPathSetSha256 = pathSet;
  const proofPath = path.join(dir, 'proof.json');
  await writeFile(proofPath, JSON.stringify({ ...proof, ...options.proof }));
  const positioned = files.map((fileRows, file) => fileRows.map((row, index) => ({
    file, sourceSha256: manifest.files[file].sha256, line: index + 1,
    offset: index * 20, byteLength: 10, rawHash: hash(`file${file}line${index}`), ...row })));
  const all = positioned.flat();
  const counts = { canonical: all.filter(row => row.kind === 'canonical').length,
    legacy: all.filter(row => row.kind === 'legacy').length,
    boundaries: all.filter(row => row.type === 'boundary').length };
  const ledgerRows = [
    { type: 'manifest', format: 'agentsession-v3-codex-raw-usage-ledger/v1',
      manifestSha256: hash(manifestBytes), expectedFiles: files.length },
    ...positioned.flatMap((fileRows, file) => [
      ...fileRows,
      { type: 'file-complete', file, sourceSha256: manifest.files[file].sha256,
        bytes: 1000, lines: fileRows.length,
        canonical: fileRows.filter(row => row.kind === 'canonical').length,
        legacy: fileRows.filter(row => row.kind === 'legacy').length,
        boundaries: fileRows.filter(row => row.type === 'boundary').length },
    ]),
    { type: 'complete', files: files.length, ...counts, manifestSha256: hash(manifestBytes),
      format: 'agentsession-v3-codex-raw-usage-ledger/v1' },
  ];
  const ledgerPath = path.join(dir, 'ledger.jsonl');
  const ledgerBytes = ledgerRows.map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(ledgerPath, ledgerBytes);
  const outputPath = path.join(dir, 'dispositions.private.jsonl');
  return { dir, files: files.length, ledgerRows, ledgerPath, outputPath, proofPath, manifestPath,
    expectedLedgerSha256: hash(ledgerBytes), counts };
}

const meta = sessionHash => ({ type: 'boundary', kind: 'session-meta', sessionHash });
const usage = (kind, responseHash, threadIdHash, activeSessionHash, extra = {}) => ({
  type: 'usage', kind, responseHash, turnHash: null,
  owner: { threadIdHash, sessionIdHash: hash('parent'), activeSessionHash },
  request: vector(), cumulative: vector('missing'), ...extra,
});

test('adjudicates only unique canonical response in its explicit metadata epoch', async () => {
  const owner = hash('owner');
  const input = await fixture([
    meta(owner),
    usage('canonical', hash('r1'), owner, owner),
    usage('canonical', hash('repeat'), owner, owner),
    usage('canonical', hash('repeat'), owner, owner),
    usage('canonical', hash('r2'), hash('other-thread'), owner),
    usage('legacy', null, null, owner, { request: vector('missing') }),
  ]);
  const result = await runAdjudication(input.manifestPath, input.proofPath,
    input.ledgerPath, input.outputPath, { expectedFiles: 1,
      expectedLedgerSha256: input.expectedLedgerSha256 });
  const lines = (await readFile(input.outputPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const dispositions = lines.filter(row => row.type === 'disposition');
  assert.equal(dispositions.length, 5);
  assert.deepEqual(dispositions.map(row => row.status),
    ['proved-request', 'unresolved', 'unresolved', 'unresolved', 'unresolved']);
  assert.ok(dispositions[1].reasons.includes('duplicate-response-id'));
  assert.ok(dispositions[3].reasons.includes('thread-metadata-conflict'));
  assert.ok(dispositions[4].reasons.includes('legacy-request-or-replay-unproved'));
  assert.equal(dispositions[0].owner.sessionIdHash, hash('parent'));
  assert.equal(dispositions[4].request.input_tokens.state, 'missing');
  assert.equal(result.occurrences, 5);
  assert.equal(result.provedRequests, 1);
  assert.equal(result.unresolved, 4);
  assert.equal(result.filesCompleted, 1);
  assert.ok(!JSON.stringify(result).includes(owner));
});

test('rejects changed inventory proof, ledger digest, and repeated position', async () => {
  const owner = hash('owner');
  const rows = [meta(owner), usage('canonical', hash('r'), owner, owner)];
  const badProof = await fixture(rows, { proof: { rootEligibleFiles: 2 } });
  await assert.rejects(runAdjudication(badProof.manifestPath, badProof.proofPath,
    badProof.ledgerPath, badProof.outputPath, { expectedFiles: 1,
      expectedLedgerSha256: badProof.expectedLedgerSha256 }), /inventory proof/i);
  const wrongDigest = await fixture(rows);
  await assert.rejects(runAdjudication(wrongDigest.manifestPath, wrongDigest.proofPath,
    wrongDigest.ledgerPath, wrongDigest.outputPath, { expectedFiles: 1,
      expectedLedgerSha256: hash('wrong') }), /ledger sha-256/i);
  const repeated = await fixture(rows);
  repeated.ledgerRows[2].line = 1;
  const bytes = repeated.ledgerRows.map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(repeated.ledgerPath, bytes);
  await assert.rejects(runAdjudication(repeated.manifestPath, repeated.proofPath,
    repeated.ledgerPath, repeated.outputPath, { expectedFiles: 1,
      expectedLedgerSha256: hash(bytes) }), /position|line/i);
});

test('shared metadata identity across files remains unresolved without an owner witness', async () => {
  const owner = hash('shared-owner');
  const input = await fixture([
    [meta(owner), usage('canonical', hash('first'), owner, owner)],
    [meta(owner), usage('canonical', hash('second'), owner, owner)],
  ]);
  const result = await runAdjudication(input.manifestPath, input.proofPath,
    input.ledgerPath, input.outputPath, { expectedFiles: 2,
      expectedLedgerSha256: input.expectedLedgerSha256 });
  const rows = (await readFile(input.outputPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(result.filesCompleted, 2);
  assert.equal(result.occurrences, 2);
  assert.equal(result.provedRequests, 0);
  assert.deepEqual(rows.filter(row => row.type === 'disposition').map(row => row.reasons),
    [['metadata-identity-across-files'], ['metadata-identity-across-files']]);
});

test('rejects private output outside ignored repository tmp', async () => {
  const owner = hash('owner');
  const input = await fixture([meta(owner), usage('canonical', hash('r'), owner, owner)]);
  const outside = path.join(path.dirname(outputRoot), 'dispositions-outside.private.jsonl');
  try {
    await assert.rejects(runAdjudication(input.manifestPath, input.proofPath,
      input.ledgerPath, outside, { expectedFiles: 1,
        expectedLedgerSha256: input.expectedLedgerSha256 }), /under ignored tmp/i);
  } finally {
    try { await unlink(outside); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
});

test('rejects existing output and hardlink aliases to every input', async () => {
  const owner = hash('owner');
  const input = await fixture([meta(owner), usage('canonical', hash('r'), owner, owner)]);
  const options = { expectedFiles: 1, expectedLedgerSha256: input.expectedLedgerSha256 };
  await writeFile(input.outputPath, 'existing private data');
  await assert.rejects(runAdjudication(input.manifestPath, input.proofPath,
    input.ledgerPath, input.outputPath, options), /already exists/i);
  for (const [index, source] of [input.manifestPath, input.proofPath,
    input.ledgerPath].entries()) {
    const alias = path.join(input.dir, `hardlink-${index}.private.jsonl`);
    await link(source, alias);
    await assert.rejects(runAdjudication(input.manifestPath, input.proofPath,
      input.ledgerPath, alias, options), /aliases an input/i);
  }
});

test('rejects symlink aliases to inputs when supported by the host', async t => {
  const owner = hash('owner');
  const input = await fixture([meta(owner), usage('canonical', hash('r'), owner, owner)]);
  const alias = path.join(input.dir, 'symlink.private.jsonl');
  try { await symlink(input.ledgerPath, alias, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('host does not allow symlink creation');
      return;
    }
    throw error;
  }
  await assert.rejects(runAdjudication(input.manifestPath, input.proofPath,
    input.ledgerPath, alias, { expectedFiles: 1,
      expectedLedgerSha256: input.expectedLedgerSha256 }), /aliases an input/i);
});

test('preserves a preexisting temporary disposition file', async () => {
  const owner = hash('owner');
  const input = await fixture([meta(owner), usage('canonical', hash('r'), owner, owner)]);
  const temporary = `${input.outputPath}.${process.pid}.tmp`;
  const existing = Buffer.from('preexisting private data\n');
  await writeFile(temporary, existing);
  await assert.rejects(runAdjudication(input.manifestPath, input.proofPath,
    input.ledgerPath, input.outputPath, { expectedFiles: 1,
      expectedLedgerSha256: input.expectedLedgerSha256 }), /EEXIST|already exists/i);
  assert.deepEqual(await readFile(temporary), existing);
});
