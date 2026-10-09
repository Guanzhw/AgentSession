import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = value => createHash('sha256').update(value).digest('hex');
const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const fieldCounts = () => Object.fromEntries(fields.map(field =>
  [field, { missing: 0, zero: 0, positive: 0, invalid: 0 }]));
const counts = () => ({ canonical: 0, legacy: 0, pairedLegacy: 0, ambiguousLegacyPairs: 0,
  unmatchedLegacy: 0,
  duplicateResponseIds: 0, conflictingResponseIds: 0, missingResponseIds: 0,
  missingOwnerIds: 0,
  threadHeaderDifferences: 0, sessionHeaderDifferences: 0,
  beforeTaskMarkerUsage: 0, atOrAfterTaskMarkerUsage: 0, noTaskMarkerUsage: 0,
  spawnCalls: 0, newTaskEnvelopes: 0, conflictingSessionMetaIds: 0 });
const nonempty = value => typeof value === 'string' && value.length ? value : null;

function addFields(target, usage) {
  for (const field of fields) {
    const value = usage?.[field];
    const category = !usage || !Object.hasOwn(usage, field) ? 'missing'
      : !Number.isSafeInteger(value) || value < 0 ? 'invalid'
        : value === 0 ? 'zero' : 'positive';
    target[field][category]++;
  }
}

function newTask(record) {
  if (record.type !== 'response_item' || record.payload?.type !== 'agent_message') return false;
  const content = record.payload.content;
  const first = Array.isArray(content) ? content.find(item => typeof item?.text === 'string')?.text : null;
  return typeof first === 'string' && /^Message Type:\s*NEW_TASK\b/i.test(first.trimStart());
}

function processRecord(state, record, line) {
  const payload = record.payload;
  if (record.type === 'session_meta') {
    const id = nonempty(payload?.id) ?? nonempty(payload?.session_id);
    if (id) {
      const idHash = digest(id);
      if (!state.headerHash) state.headerHash = idHash;
      else if (idHash !== state.headerHash) state.counts.conflictingSessionMetaIds++;
      if (!state.sessionMetaHashes.includes(idHash)) state.sessionMetaHashes.push(idHash);
    }
    const parent = nonempty(payload?.parent_thread_id)
      ?? nonempty(payload?.source?.subagent?.thread_spawn?.parent_thread_id);
    if (parent && !state.child.parentHash) state.child.parentHash = digest(parent);
    const forked = nonempty(payload?.forked_from_id);
    if (forked && !state.child.forkedFromHash) state.child.forkedFromHash = digest(forked);
    const agent = nonempty(payload?.agent_path);
    if (agent && !state.child.agentPathHash) state.child.agentPathHash = digest(agent);
    const call = nonempty(payload?.source?.subagent?.thread_spawn?.call_id);
    if (call && !state.child.spawnCallHash) state.child.spawnCallHash = digest(call);
  }
  if (record.type === 'response_item' && payload?.type === 'function_call'
      && payload.name === 'spawn_agent') {
    state.counts.spawnCalls++;
    state.spawnCallHashes.push(nonempty(payload.call_id) ? digest(payload.call_id) : null);
  }
  if (newTask(record)) {
    state.counts.newTaskEnvelopes++;
    state.child.firstNewTaskLine ??= line;
    state.newTaskIdHashes.push(nonempty(payload.id) ? digest(payload.id) : null);
  }
  if (record.type === 'token_usage_record') {
    state.counts.canonical++;
    addFields(state.fields.canonical, payload?.usage);
    const responseId = nonempty(payload?.response_id);
    if (!responseId) state.counts.missingResponseIds++;
    const owner = {
      sessionIdHash: nonempty(payload?.session_id) ? digest(payload.session_id) : null,
      threadIdHash: nonempty(payload?.thread_id) ? digest(payload.thread_id) : null,
    };
    if (!owner.sessionIdHash && !owner.threadIdHash) state.counts.missingOwnerIds++;
    if (state.headerHash && owner.threadIdHash && owner.threadIdHash !== state.headerHash)
      state.counts.threadHeaderDifferences++;
    if (state.headerHash && owner.sessionIdHash && owner.sessionIdHash !== state.headerHash)
      state.counts.sessionHeaderDifferences++;
    const usageHash = digest(stableJson(payload?.usage ?? null));
    const threadHash = digest(stableJson(payload?.thread_token_usage ?? null));
    state.identities.push({ responseHash: responseId ? digest(responseId) : null,
      owner, usageHash, line });
    const signature = `${usageHash}:${threadHash}`;
    state.priorCanonical.set(signature, (state.priorCanonical.get(signature) ?? 0) + 1);
    state.usageLines.push(line);
  }
  if (record.type === 'event_msg' && payload?.type === 'token_count') {
    state.counts.legacy++;
    addFields(state.fields.legacy, payload.info?.last_token_usage);
    if (payload.info && Object.hasOwn(payload.info, 'last_token_usage')) {
      const signature = `${digest(stableJson(payload.info.last_token_usage ?? null))}`
        + `:${digest(stableJson(payload.info.total_token_usage ?? null))}`;
      const matches = state.priorCanonical.get(signature) ?? 0;
      if (matches) state.counts.pairedLegacy++;
      else state.counts.unmatchedLegacy++;
      if (matches > 1) state.counts.ambiguousLegacyPairs++;
    } else state.counts.unmatchedLegacy++;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function scan(file, chunkBytes) {
  const state = { counts: counts(), fields: { canonical: fieldCounts(), legacy: fieldCounts() },
    headerHash: null, sessionMetaHashes: [], child: { parentHash: null, forkedFromHash: null, agentPathHash: null,
      spawnCallHash: null, firstNewTaskLine: null }, identities: [],
    priorCanonical: new Map(), usageLines: [], spawnCallHashes: [], newTaskIdHashes: [] };
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = Buffer.alloc(0);
  let byteCount = 0;
  let line = 0;
  const consume = bytes => {
    line++;
    if (!bytes.length || bytes.every(byte => byte === 32 || byte === 13 || byte === 9)) return;
    let record;
    try {
      record = JSON.parse(decoder.decode(bytes));
      if (!record || Array.isArray(record) || typeof record !== 'object') throw new Error();
    } catch { throw new Error(`file ${file.index} line ${line}: malformed JSON`); }
    processRecord(state, record, line);
  };
  for await (const chunk of createReadStream(file.absolute, { highWaterMark: chunkBytes })) {
    hash.update(chunk);
    byteCount += chunk.length;
    let offset = 0;
    for (;;) {
      const newline = chunk.indexOf(10, offset);
      if (newline < 0) break;
      const piece = chunk.subarray(offset, newline);
      if (pending.length + piece.length > 16 * 1024 * 1024) throw new Error(`file ${file.index} line ${line + 1}: line exceeds 16 MiB`);
      consume(pending.length ? Buffer.concat([pending, piece]) : piece);
      pending = Buffer.alloc(0);
      offset = newline + 1;
    }
    const rest = chunk.subarray(offset);
    if (pending.length + rest.length > 16 * 1024 * 1024) throw new Error(`file ${file.index} line ${line + 1}: line exceeds 16 MiB`);
    pending = pending.length ? Buffer.concat([pending, rest]) : Buffer.from(rest);
  }
  if (pending.length) consume(pending);
  const actualHash = hash.digest('hex');
  if (actualHash !== file.sha256 || byteCount !== file.bytes)
    throw new Error(`Source hash mismatch for file ${file.index}`);
  if (state.child.parentHash) for (const usageLine of state.usageLines) {
    if (!state.child.firstNewTaskLine) state.counts.noTaskMarkerUsage++;
    else if (usageLine < state.child.firstNewTaskLine) state.counts.beforeTaskMarkerUsage++;
    else state.counts.atOrAfterTaskMarkerUsage++;
  }
  delete state.priorCanonical;
  delete state.usageLines;
  return { index: file.index, sha256: actualHash, bytes: byteCount, lines: line,
    counts: state.counts, fields: state.fields, sessionHash: state.headerHash,
    sessionMetaHashes: state.sessionMetaHashes, child: state.child,
    identities: state.identities, spawnCallHashes: state.spawnCallHashes,
    newTaskIdHashes: state.newTaskIdHashes };
}

async function exactHash(file, chunkBytes) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: chunkBytes })) {
    hash.update(chunk); bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

async function saveCheckpoint(file, checkpoint) {
  const temporary = `${file}.${process.pid}.tmp`;
  try { await writeFile(temporary, JSON.stringify(checkpoint) + '\n', { flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Checkpoint temporary file already exists');
    throw error;
  }
  await rename(temporary, file);
}

const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;

async function fileIdentity(file) {
  const absolute = path.resolve(file);
  try {
    const canonical = await realpath(absolute);
    const metadata = await stat(absolute, { bigint: true });
    return { canonical: pathKey(canonical),
      inode: metadata.ino === 0n ? null : `${metadata.dev}:${metadata.ino}` };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = await realpath(path.dirname(absolute));
    return { canonical: pathKey(path.join(parent, path.basename(absolute))), inode: null };
  }
}

function aliased(first, second) {
  return first.canonical === second.canonical
    || Boolean(first.inode && second.inode && first.inode === second.inode);
}

async function ensureDistinctSourcesAndCheckpoint(files, manifestIdentity, checkpointPath) {
  for (let index = 0; index < files.length; index++) {
    files[index].identity = await fileIdentity(files[index].absolute);
    for (let previous = 0; previous < index; previous++) {
      if (aliased(files[index].identity, files[previous].identity))
        throw new Error(`Duplicate source file ${index} aliases file ${previous}`);
    }
  }
  await ensureCheckpointSeparate(files, manifestIdentity, checkpointPath);
}

async function ensureCheckpointSeparate(files, manifestIdentity, checkpointPath) {
  const targets = [checkpointPath, `${checkpointPath}.${process.pid}.tmp`];
  for (const target of targets) {
    const identity = await fileIdentity(target);
    if (aliased(identity, manifestIdentity)) throw new Error('Checkpoint aliases manifest');
    for (const source of files) {
      if (aliased(identity, source.identity))
        throw new Error(`Checkpoint aliases source file ${source.index}`);
    }
  }
}

function report(checkpoint, progress) {
  const totals = counts();
  const fieldsReport = { canonical: fieldCounts(), legacy: fieldCounts() };
  const identities = new Map();
  const files = checkpoint.files.map(file => {
    for (const key of Object.keys(totals)) totals[key] += file.counts[key];
    for (const kind of ['canonical', 'legacy']) for (const field of fields)
      for (const category of ['missing', 'zero', 'positive', 'invalid'])
        fieldsReport[kind][field][category] += file.fields[kind][field][category];
    for (const identity of file.identities) {
      if (!identity.responseHash) continue;
      const group = identities.get(identity.responseHash) ?? [];
      group.push(identity);
      identities.set(identity.responseHash, group);
    }
    const { identities: _identities, ...publicFile } = file;
    return publicFile;
  });
  const collisions = [];
  for (const [responseHash, group] of identities) {
    if (group.length < 2) continue;
    totals.duplicateResponseIds += group.length - 1;
    const conflicting = new Set(group.map(row => `${row.owner.sessionIdHash}:${row.owner.threadIdHash}:${row.usageHash}`)).size > 1;
    if (conflicting) totals.conflictingResponseIds++;
    collisions.push({ responseHash, occurrences: group.length, conflicting });
  }
  collisions.sort((a, b) => a.responseHash.localeCompare(b.responseHash));
  return { format: 'agentsession-v3-codex-usage-census/v3', manifestSha256: checkpoint.manifestSha256,
    progress, files, totals, fields: fieldsReport, responseIdCollisions: collisions };
}

export async function runCensus(manifestPath, checkpointPath, options = {}) {
  const chunkBytes = options.chunkBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error('Invalid chunkBytes');
  const manifestBytes = await readFile(manifestPath);
  const manifestIdentity = await fileIdentity(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (!path.isAbsolute(manifest.root) || !Array.isArray(manifest.files))
    throw new Error('Manifest requires an absolute root and files array');
  const root = await realpath(manifest.root);
  const files = await Promise.all(manifest.files.map(async (entry, index) => {
    if (typeof entry.path !== 'string' || path.isAbsolute(entry.path)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`Invalid manifest file ${index}`);
    const absolute = await realpath(path.resolve(root, entry.path));
    if (!absolute.startsWith(root + path.sep)) throw new Error(`Source outside root at file ${index}`);
    return { index, absolute, bytes: entry.bytes, sha256: entry.sha256 };
  }));
  await ensureDistinctSourcesAndCheckpoint(files, manifestIdentity, checkpointPath);
  const manifestSha256 = digest(manifestBytes);
  let checkpoint;
  try { checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    checkpoint = null;
  }
  if (!checkpoint || checkpoint.format !== 'agentsession-v3-codex-usage-checkpoint/v3'
    || checkpoint.manifestSha256 !== manifestSha256 || checkpoint.files.length !== files.length)
    checkpoint = { format: 'agentsession-v3-codex-usage-checkpoint/v3', manifestSha256,
      files: Array(files.length).fill(null) };
  const progress = { scannedFiles: 0, reusedFiles: 0 };
  for (const file of files) {
    try {
      if (checkpoint.files[file.index]) {
        const actual = await exactHash(file.absolute, chunkBytes);
        if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes)
          throw new Error(`Source hash mismatch for file ${file.index}`);
        progress.reusedFiles++;
        continue;
      }
      checkpoint.files[file.index] = await scan(file, chunkBytes);
      await ensureCheckpointSeparate(files, manifestIdentity, checkpointPath);
      await saveCheckpoint(checkpointPath, checkpoint);
      progress.scannedFiles++;
    } catch (error) {
      checkpoint.files[file.index] = null;
      await ensureCheckpointSeparate(files, manifestIdentity, checkpointPath);
      await saveCheckpoint(checkpointPath, checkpoint);
      throw error;
    }
  }
  return report(checkpoint, progress);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4) {
    console.error('Usage: node scripts/v3-codex-usage-census.mjs <manifest.json> <checkpoint.json>');
    process.exitCode = 2;
  } else {
    runCensus(process.argv[2], process.argv[3]).then(value =>
      process.stdout.write(JSON.stringify(value) + '\n'), error => {
        console.error(error.message); process.exitCode = 1;
      });
  }
}
