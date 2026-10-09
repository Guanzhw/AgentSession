import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, lstat, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sha = value => createHash('sha256').update(value).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;
const ledgerFormat = 'agentsession-v3-codex-raw-usage-ledger/v1';
const proofFormat = 'agentsession-v3-codex-source-inventory-proof/v1';
const dispositionFormat = 'agentsession-v3-codex-usage-dispositions/v1';
const outputRoot = path.resolve(fileURLToPath(new URL('../tmp/', import.meta.url)));
const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'total_tokens'];

async function fileDigest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function* records(filename) {
  const stream = createReadStream(filename, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let row = 0;
  try {
    for await (const line of lines) {
      row++;
      let record;
      try { record = JSON.parse(line); }
      catch { throw new Error(`ledger row ${row}: invalid JSON`); }
      if (!record || typeof record !== 'object' || Array.isArray(record))
        throw new Error(`ledger row ${row}: invalid record`);
      yield record;
    }
  } finally { lines.close(); stream.destroy(); }
}

function pathSetDigest(paths) {
  const hash = createHash('sha256').update('agentsession-codex-path-set/v1\0');
  for (const value of [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))))
    hash.update(value).update('\0');
  return hash.digest('hex');
}

const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;

async function identity(name) {
  const absolute = path.resolve(name);
  try {
    const resolved = await realpath(absolute);
    const metadata = await stat(absolute, { bigint: true });
    return { path: pathKey(resolved), inode: metadata.ino === 0n ? null
      : `${metadata.dev}:${metadata.ino}` };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = await realpath(path.dirname(absolute));
    return { path: pathKey(path.join(parent, path.basename(absolute))), inode: null };
  }
}

const aliases = (a, b) => a.path === b.path
  || Boolean(a.inode && b.inode && a.inode === b.inode);

async function checkedOutput(manifestPath, proofPath, ledgerPath, outputPath) {
  const output = path.resolve(outputPath);
  const parent = pathKey(await realpath(path.dirname(output)));
  const root = pathKey(outputRoot);
  if (parent !== root && !parent.startsWith(root + path.sep))
    throw new Error('private disposition output must be under ignored tmp/');
  const inputs = await Promise.all([manifestPath, proofPath, ledgerPath].map(identity));
  const temporary = `${output}.${process.pid}.tmp`;
  for (const target of [output, temporary]) {
    const candidate = await identity(target);
    if (inputs.some(source => aliases(source, candidate)))
      throw new Error('disposition output aliases an input');
  }
  try { await lstat(output); throw new Error('disposition output already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { output, temporary };
}

async function inputs(manifestPath, proofPath, ledgerPath, outputPath, options) {
  const expectedFiles = options.expectedFiles;
  if (!Number.isSafeInteger(expectedFiles) || expectedFiles < 1)
    throw new Error('explicit positive expectedFiles required');
  if (!digestPattern.test(options.expectedLedgerSha256 ?? ''))
    throw new Error('explicit ledger SHA-256 required');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const manifestSha256 = sha(manifestBytes);
  const proofBytes = await readFile(proofPath);
  const proof = JSON.parse(proofBytes.toString('utf8'));
  const inventoryProofSha256 = sha(proofBytes);
  if (!manifest || typeof manifest.root !== 'string' || !path.isAbsolute(manifest.root)
      || !Array.isArray(manifest.files) || manifest.files.length !== expectedFiles)
    throw new Error('manifest file count mismatch');
  const paths = [];
  for (const [index, file] of manifest.files.entries()) {
    if (typeof file?.path !== 'string' || !file.path.length || file.path.includes('\\')
        || file.path.startsWith('/') || /^[a-z]:/i.test(file.path)
        || file.path.split('/').some(part => !part || part === '.' || part === '..')
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0
        || !digestPattern.test(file.sha256 ?? ''))
      throw new Error(`invalid manifest entry ${index}`);
    paths.push(file.path);
  }
  const pathDigest = pathSetDigest(paths);
  if (proof?.format !== proofFormat || proof.status !== 'complete' || proof.complete !== true
      || proof.scope !== 'declared-root-only' || proof.rootLabel !== 'frozen-codex'
      || proof.rootSha256 !== sha(manifest.root) || proof.manifestSha256 !== manifestSha256
      || proof.manifestEntries !== expectedFiles || proof.manifestUniquePaths !== expectedFiles
      || proof.rootEligibleFiles !== expectedFiles || proof.duplicateManifestEntries !== 0
      || proof.omittedFromManifest?.count !== 0 || proof.manifestOutsideInventory?.count !== 0
      || proof.rootPathSetSha256 !== pathDigest || proof.manifestPathSetSha256 !== pathDigest
      || (proof.expectedManifestEntries !== null
        && proof.expectedManifestEntries !== expectedFiles))
    throw new Error('inventory proof does not bind the complete manifest');
  if (sha(path.resolve(manifest.root)) !== proof.rootSha256)
    throw new Error('inventory proof root mismatch');
  const output = await checkedOutput(manifestPath, proofPath, ledgerPath, outputPath);
  const actualLedgerSha256 = await fileDigest(ledgerPath);
  if (actualLedgerSha256 !== options.expectedLedgerSha256)
    throw new Error('ledger SHA-256 mismatch');
  return { manifest, manifestSha256, inventoryProofSha256,
    actualLedgerSha256, expectedFiles, ...output };
}

function checkVector(vector, location) {
  if (!vector || typeof vector !== 'object' || Array.isArray(vector))
    throw new Error(`${location}: invalid vector`);
  for (const field of fields) {
    const item = vector[field];
    if (!item || !['missing', 'invalid', 'zero', 'positive'].includes(item.state)
        || (['zero', 'positive'].includes(item.state)
          && (!Number.isSafeInteger(item.value) || item.value < 0
            || (item.state === 'zero') !== (item.value === 0)))
        || (['missing', 'invalid'].includes(item.state) && Object.hasOwn(item, 'value')))
      throw new Error(`${location}: invalid ${field} state`);
  }
}

function checkPosition(row, file, previous) {
  if (row.file !== file || row.sourceSha256 !== previous.sourceSha256
      || !Number.isSafeInteger(row.line) || row.line <= previous.line
      || !Number.isSafeInteger(row.offset) || row.offset <= previous.offset
      || row.offset < previous.end
      || !Number.isSafeInteger(row.byteLength) || row.byteLength < 0
      || row.offset + row.byteLength > previous.bytes || !digestPattern.test(row.rawHash ?? ''))
    throw new Error(`file ${file}: repeated or invalid occurrence position`);
  previous.line = row.line;
  previous.offset = row.offset;
  previous.end = row.offset + row.byteLength;
}

async function inspectLedger(filename, manifest, manifestSha256) {
  const responseCounts = new Map();
  const metadataFiles = new Map();
  let state = 'header';
  let file = 0;
  let previous;
  let fileCounts = { canonical: 0, legacy: 0, boundaries: 0 };
  const totals = { canonical: 0, legacy: 0, boundaries: 0 };
  for await (const row of records(filename)) {
    if (state === 'header') {
      if (row.type !== 'manifest' || row.format !== ledgerFormat
          || row.manifestSha256 !== manifestSha256 || row.expectedFiles !== manifest.files.length)
        throw new Error('ledger header does not bind manifest');
      state = 'file';
      previous = { sourceSha256: manifest.files[0].sha256,
      bytes: manifest.files[0].bytes, line: 0, offset: -1, end: 0 };
      continue;
    }
    if (state === 'done') throw new Error('ledger has records after complete');
    if (row.type === 'complete') {
      if (file !== manifest.files.length || row.files !== file || row.format !== ledgerFormat
          || row.manifestSha256 !== manifestSha256
          || ['canonical', 'legacy', 'boundaries'].some(key => row[key] !== totals[key]))
        throw new Error('ledger terminal count mismatch');
      state = 'done';
      continue;
    }
    if (file >= manifest.files.length) throw new Error('ledger has excess file records');
    if (row.type === 'file-complete') {
      if (row.file !== file || row.sourceSha256 !== previous.sourceSha256
          || row.bytes !== previous.bytes || !Number.isSafeInteger(row.lines)
          || row.lines < previous.line
          || ['canonical', 'legacy', 'boundaries'].some(key => row[key] !== fileCounts[key]))
        throw new Error(`file ${file}: file-complete mismatch`);
      file++;
      fileCounts = { canonical: 0, legacy: 0, boundaries: 0 };
      if (file < manifest.files.length) previous = {
        sourceSha256: manifest.files[file].sha256,
        bytes: manifest.files[file].bytes, line: 0, offset: -1, end: 0 };
      continue;
    }
    if (row.type !== 'usage' && row.type !== 'boundary')
      throw new Error(`file ${file}: unexpected ledger record`);
    checkPosition(row, file, previous);
    if (row.type === 'boundary') {
      fileCounts.boundaries++;
      totals.boundaries++;
      if (row.kind === 'session-meta' && row.sessionHash !== null) {
        if (!digestPattern.test(row.sessionHash ?? '')) throw new Error('invalid metadata hash');
        const files = metadataFiles.get(row.sessionHash) ?? new Set();
        files.add(file);
        metadataFiles.set(row.sessionHash, files);
      }
    } else {
      if (!['canonical', 'legacy'].includes(row.kind) || !row.owner
          || typeof row.owner !== 'object') throw new Error('invalid usage occurrence');
      for (const value of [row.responseHash, row.owner.threadIdHash,
        row.owner.sessionIdHash, row.owner.activeSessionHash]) {
        if (value !== null && !digestPattern.test(value ?? ''))
          throw new Error('invalid usage identity hash');
      }
      checkVector(row.request, 'request');
      checkVector(row.cumulative, 'cumulative');
      fileCounts[row.kind]++;
      totals[row.kind]++;
      if (row.responseHash)
        responseCounts.set(row.responseHash, (responseCounts.get(row.responseHash) ?? 0) + 1);
    }
  }
  if (state !== 'done') throw new Error('ledger lacks terminal complete record');
  return { responseCounts, metadataFiles, totals, filesCompleted: file };
}

function disposition(row, activeMetadata, evidence) {
  const reasons = [];
  if (!row.responseHash) reasons.push('missing-response-id');
  if (!row.owner.threadIdHash) reasons.push('missing-explicit-thread-id');
  if (!activeMetadata || row.owner.activeSessionHash !== activeMetadata)
    reasons.push('missing-supported-metadata-epoch');
  if (row.owner.threadIdHash && activeMetadata
      && row.owner.threadIdHash !== activeMetadata)
    reasons.push('thread-metadata-conflict');
  if (activeMetadata && (evidence.metadataFiles.get(activeMetadata)?.size ?? 0) > 1)
    reasons.push('metadata-identity-across-files');
  if (row.kind === 'canonical') {
    if (row.responseHash && evidence.responseCounts.get(row.responseHash) !== 1)
      reasons.push('duplicate-response-id');
  } else reasons.push('legacy-request-or-replay-unproved');
  return { type: 'disposition', file: row.file, sourceSha256: row.sourceSha256,
    line: row.line, offset: row.offset, byteLength: row.byteLength, rawHash: row.rawHash,
    kind: row.kind, status: reasons.length ? 'unresolved' : 'proved-request', reasons,
    responseHash: row.responseHash, turnHash: row.turnHash, owner: row.owner,
    request: row.request, cumulative: row.cumulative };
}

export async function runAdjudication(manifestPath, proofPath, ledgerPath, outputPath,
  options = {}) {
  const input = await inputs(manifestPath, proofPath, ledgerPath, outputPath, options);
  const evidence = await inspectLedger(ledgerPath, input.manifest, input.manifestSha256);
  const { output, temporary } = input;
  let handle;
  let created = false;
  const reasons = {};
  const byKind = { canonical: { proved: 0, unresolved: 0 },
    legacy: { proved: 0, unresolved: 0 } };
  const fieldStates = Object.fromEntries(['request', 'cumulative'].map(domain =>
    [domain, Object.fromEntries(fields.map(field => [field,
      { missing: 0, invalid: 0, zero: 0, positive: 0 }]))]));
  try {
    handle = await open(temporary, 'wx');
    created = true;
    await handle.writeFile(JSON.stringify({ type: 'manifest', format: dispositionFormat,
      manifestSha256: input.manifestSha256, inventoryPathSetSha256:
        pathSetDigest(input.manifest.files.map(file => file.path)),
      inventoryProofSha256: input.inventoryProofSha256,
      ledgerSha256: input.actualLedgerSha256, expectedFiles: input.expectedFiles }) + '\n');
    let activeMetadata = null;
    let file = 0;
    let occurrences = 0;
    for await (const row of records(ledgerPath)) {
      if (row.type === 'boundary' && row.kind === 'session-meta')
        activeMetadata = row.sessionHash;
      if (row.type === 'usage') {
        const item = disposition(row, activeMetadata, evidence);
        await handle.writeFile(JSON.stringify(item) + '\n');
        occurrences++;
        byKind[row.kind][item.status === 'proved-request' ? 'proved' : 'unresolved']++;
        for (const reason of item.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
        for (const domain of ['request', 'cumulative'])
          for (const field of fields) fieldStates[domain][field][row[domain][field].state]++;
      }
      if (row.type === 'file-complete') {
        file++;
        activeMetadata = null;
        await handle.writeFile(JSON.stringify({ type: 'file-complete', file: row.file,
          sourceSha256: row.sourceSha256, canonical: row.canonical,
          legacy: row.legacy }) + '\n');
      }
    }
    if (occurrences !== evidence.totals.canonical + evidence.totals.legacy
        || file !== evidence.filesCompleted)
      throw new Error('second pass occurrence count changed');
    if (await fileDigest(ledgerPath) !== input.actualLedgerSha256)
      throw new Error('ledger SHA-256 changed during adjudication');
    const summary = { type: 'complete', format: dispositionFormat,
      manifestSha256: input.manifestSha256,
      inventoryProofSha256: input.inventoryProofSha256,
      ledgerSha256: input.actualLedgerSha256,
      filesCompleted: file, occurrences, canonical: evidence.totals.canonical,
      legacy: evidence.totals.legacy, provedRequests: byKind.canonical.proved,
      unresolved: byKind.canonical.unresolved + byKind.legacy.unresolved,
      byKind, reasons, fieldStates };
    await handle.writeFile(JSON.stringify(summary) + '\n');
    await handle.sync();
    await handle.close();
    handle = null;
    await link(temporary, output);
    await unlink(temporary);
    return { ...summary, dispositionSha256: await fileDigest(output) };
  } catch (error) {
    if (handle) await handle.close();
    if (created) await unlink(temporary).catch(unlinkError => {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 8) {
    console.error('Usage: node scripts/v3-adjudicate-codex-usage-ledger.mjs <manifest.json> <inventory-proof.json> <ledger.jsonl> <tmp/dispositions.private.jsonl> <expected-files> <expected-ledger-sha256>');
    process.exitCode = 2;
  } else {
    runAdjudication(process.argv[2], process.argv[3], process.argv[4], process.argv[5],
      { expectedFiles: Number(process.argv[6]), expectedLedgerSha256: process.argv[7] })
      .then(value => process.stdout.write(JSON.stringify(value) + '\n'), error => {
        console.error(error.message); process.exitCode = 1;
      });
  }
}
