import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = value => createHash('sha256').update(value).digest('hex');
const idHash = value => typeof value === 'string' && value.length ? sha(value) : null;
const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const formats = new Set(['agentsession-v3-codex-usage-checkpoint/v2',
  'agentsession-v3-codex-usage-checkpoint/v3']);

function vector(value) {
  return Object.fromEntries(fields.map(field => {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, field))
      return [field, { state: 'missing' }];
    const number = value[field];
    if (!Number.isSafeInteger(number) || number < 0) return [field, { state: 'invalid' }];
    return [field, { state: number === 0 ? 'zero' : 'positive', value: number }];
  }));
}

const signature = value => fields.map(field => {
  const slot = value[field];
  return slot.state === 'missing' ? 'm' : slot.state === 'invalid' ? 'i' : String(slot.value);
}).join('|');

function selectionCategories(file) {
  const count = file.counts;
  const child = Boolean(file.child?.parentHash);
  const categories = [];
  if (count.legacy > 0 && count.canonical === 0)
    categories.push(child ? 'legacy-only-child' : 'legacy-only-root');
  if (count.legacy > 0 && count.canonical > 0)
    categories.push(child ? 'mixed-child' : 'mixed-root');
  if (count.pairedLegacy > count.canonical && count.canonical > 0)
    categories.push('duplicate-pair-excess');
  const fieldsReport = file.fields ?? {};
  if (Object.values(fieldsReport).some(kind => Object.values(kind).some(field =>
    (field.missing ?? 0) > 0 || (field.zero ?? 0) > 0)))
    categories.push('missing-or-zero-field');
  if (child && !file.child.firstNewTaskLine && count.canonical > 0)
    categories.push('boundary-unknown');
  if ((file.sessionMetaHashes?.length ?? 0) > 1 ||
      (count.conflictingSessionMetaIds ?? 0) > 0)
    categories.push('metadata-transition');
  return categories;
}

export function selectCohort(census, options = {}) {
  const perCategory = options.perCategory ?? 2;
  const maxFiles = options.maxFiles ?? 24;
  const maxFileBytes = options.maxFileBytes ?? 64 * 1024 * 1024;
  for (const [name, value] of Object.entries({ perCategory, maxFiles, maxFileBytes })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  }
  const byCategory = new Map();
  for (const file of census.files) {
    if (!file || file.bytes > maxFileBytes) continue;
    for (const category of selectionCategories(file)) {
      const group = byCategory.get(category) ?? [];
      group.push(file.index);
      byCategory.set(category, group);
    }
  }
  const selected = new Set();
  for (const category of ['legacy-only-root', 'legacy-only-child', 'mixed-root',
    'mixed-child', 'duplicate-pair-excess', 'missing-or-zero-field',
    'boundary-unknown', 'metadata-transition']) {
    for (const index of (byCategory.get(category) ?? []).slice(0, perCategory)) {
      if (selected.size < maxFiles) selected.add(index);
    }
  }
  return [...selected].sort((a, b) => a - b).map(index =>
    ({ index, categories: selectionCategories(census.files[index]) }));
}

function taskEnvelope(record) {
  if (record.type !== 'response_item' || record.payload?.type !== 'agent_message') return false;
  const first = Array.isArray(record.payload.content)
    ? record.payload.content.find(item => typeof item?.text === 'string')?.text : null;
  return typeof first === 'string' && /^Message Type:\s*NEW_TASK\b/i.test(first.trimStart());
}

function classify(rows, markers, child) {
  const canon = rows.filter(row => row.kind === 'canonical');
  const legacy = rows.filter(row => row.kind === 'legacy');
  const metaIds = new Set(markers.filter(marker => marker.kind === 'session-meta')
    .map(marker => marker.sessionHash).filter(Boolean));
  const transition = metaIds.size > 1;
  const repeatedResponses = new Map();
  for (const row of canon) if (row.responseHash) {
    const group = repeatedResponses.get(row.responseHash) ?? [];
    group.push(row);
    repeatedResponses.set(row.responseHash, group);
  }
  const exact = row => canon.filter(other => other.requestSignature === row.requestSignature
    && other.cumulativeSignature === row.cumulativeSignature);
  return rows.map(row => {
    let reason;
    let outcome = 'unresolved';
    let matchingCanonicalLines = [];
    if (row.kind === 'canonical') {
      if (fields.every(field => row.request[field].state === 'missing'))
        reason = 'request-usage-absent';
      else if (fields.some(field => row.request[field].state === 'invalid'))
        reason = 'invalid-request-usage';
      else if ((repeatedResponses.get(row.responseHash)?.length ?? 0) > 1)
        reason = 'repeated-response-id';
      else if (child && row.boundary === 'unknown') reason = 'boundary-unknown';
      else if (child && row.boundary === 'before-task') reason = 'before-task-owner-unresolved';
      else if (transition) reason = 'metadata-transition';
      else if (row.owner.threadIdHash && row.owner.threadIdHash === row.activeSessionHash) {
        reason = 'explicit-thread-candidate'; outcome = 'candidate';
      } else if (row.owner.threadIdHash) reason = 'thread-header-divergence';
      else if (row.owner.sessionIdHash && row.owner.sessionIdHash === row.activeSessionHash) {
        reason = 'explicit-session-candidate'; outcome = 'candidate';
      } else reason = 'missing-or-divergent-owner';
    } else {
      const matches = exact(row);
      matchingCanonicalLines = matches.map(other => other.line);
      const sameRequest = canon.filter(other => other.requestSignature === row.requestSignature);
      if (fields.every(field => row.request[field].state === 'missing'))
        reason = 'request-usage-absent';
      else if (fields.some(field => row.request[field].state === 'invalid'))
        reason = 'invalid-request-usage';
      else if (matches.length && matches.every(other => other.line > row.line))
        reason = 'earlier-legacy';
      else if (child && row.boundary === 'unknown') reason = 'boundary-unknown';
      else if (child && row.boundary === 'before-task') reason = 'before-task-owner-unresolved';
      else if (transition) reason = 'metadata-transition';
      else if (sameRequest.length && !matches.length) reason = 'cumulative-divergence';
      else if (matches.length > 1) reason = 'multiple-matching-canonical';
      else if (matches.length === 1) {
        const siblings = legacy.filter(other => other.requestSignature === row.requestSignature
          && other.cumulativeSignature === row.cumulativeSignature);
        if (siblings.length > 1) reason = 'duplicate-pair-excess';
        else { reason = 'mirror-candidate'; outcome = 'candidate'; }
      } else reason = 'legacy-only-or-unmatched';
    }
    return { line: row.line, kind: row.kind, outcome, reason, matchingCanonicalLines };
  });
}

async function scan(file, chunkBytes, maxRows) {
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const rows = [];
  const markers = [];
  let pending = Buffer.alloc(0);
  let byteCount = 0;
  let offset = 0;
  let line = 0;
  let activeSessionHash = null;
  let child = false;
  let taskLine = null;
  const consume = (bytes, newline) => {
    line++;
    const start = offset;
    offset += bytes.length + (newline ? 1 : 0);
    const position = { line, offset: start, byteLength: bytes.length };
    if (!bytes.length || bytes.every(byte => byte === 32 || byte === 13 || byte === 9)) return;
    let record;
    try {
      record = JSON.parse(decoder.decode(bytes));
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error();
    } catch { throw new Error(`file ${file.index} line ${line}: malformed JSON`); }
    const payload = record.payload;
    if (record.type === 'session_meta') {
      activeSessionHash = idHash(payload?.id) ?? idHash(payload?.session_id);
      const parentHash = idHash(payload?.parent_thread_id)
        ?? idHash(payload?.source?.subagent?.thread_spawn?.parent_thread_id);
      if (parentHash) child = true;
      markers.push({ kind: 'session-meta', ...position, sessionHash: activeSessionHash,
        parentHash, forkHash: idHash(payload?.forked_from_id),
        agentPathHash: idHash(payload?.agent_path),
        spawnCallHash: idHash(payload?.source?.subagent?.thread_spawn?.call_id) });
    }
    if (record.type === 'response_item' && payload?.type === 'function_call'
        && payload.name === 'spawn_agent')
      markers.push({ kind: 'spawn-call', ...position, callHash: idHash(payload.call_id) });
    if (taskEnvelope(record)) {
      taskLine ??= line;
      markers.push({ kind: 'new-task', ...position, messageHash: idHash(payload.id) });
    }
    if (record.type === 'event_msg' && payload?.type === 'thread_settings_applied')
      markers.push({ kind: 'settings-applied', ...position,
        modelHash: idHash(payload.thread_settings?.model) });
    if (record.type === 'turn_context')
      markers.push({ kind: 'turn-context', ...position,
        modelHash: idHash(payload?.model), turnHash: idHash(payload?.turn_id) });
    if (record.type === 'event_msg' && ['task_started', 'task_complete',
      'turn_aborted', 'context_compacted'].includes(payload?.type))
      markers.push({ kind: payload.type, ...position,
        turnHash: idHash(payload.turn_id) });
    if (record.type === 'compacted')
      markers.push({ kind: 'compacted', ...position });
    const canonical = record.type === 'token_usage_record';
    const legacy = record.type === 'event_msg' && payload?.type === 'token_count';
    if (!canonical && !legacy) return;
    if (rows.length >= maxRows) throw new Error(`file ${file.index}: evidence row limit ${maxRows} exceeded`);
    const request = vector(canonical ? payload?.usage : payload?.info?.last_token_usage);
    const cumulative = vector(canonical ? payload?.thread_token_usage : payload?.info?.total_token_usage);
    rows.push({ kind: canonical ? 'canonical' : 'legacy', ...position,
      activeSessionHash, responseHash: idHash(payload?.response_id ?? payload?.info?.response_id),
      turnHash: idHash(payload?.turn_id),
      owner: canonical ? { threadIdHash: idHash(payload?.thread_id),
        sessionIdHash: idHash(payload?.session_id) } : null,
      request, cumulative, requestSignature: signature(request),
      cumulativeSignature: signature(cumulative) });
  };
  for await (const chunk of createReadStream(file.absolute, { highWaterMark: chunkBytes })) {
    hash.update(chunk);
    byteCount += chunk.length;
    let cursor = 0;
    for (;;) {
      const newline = chunk.indexOf(10, cursor);
      if (newline < 0) break;
      const piece = chunk.subarray(cursor, newline);
      if (pending.length + piece.length > 16 * 1024 * 1024)
        throw new Error(`file ${file.index} line ${line + 1}: line exceeds 16 MiB`);
      consume(pending.length ? Buffer.concat([pending, piece]) : piece, true);
      pending = Buffer.alloc(0);
      cursor = newline + 1;
    }
    const rest = chunk.subarray(cursor);
    if (pending.length + rest.length > 16 * 1024 * 1024)
      throw new Error(`file ${file.index} line ${line + 1}: line exceeds 16 MiB`);
    pending = pending.length ? Buffer.concat([pending, rest]) : Buffer.from(rest);
  }
  if (pending.length) {
    consume(pending, false);
  }
  const actualHash = hash.digest('hex');
  if (actualHash !== file.sha256 || byteCount !== file.bytes)
    throw new Error(`Source hash mismatch for file ${file.index}`);
  for (const row of rows) row.boundary = !child ? 'root'
    : !taskLine ? 'unknown' : row.line < taskLine ? 'before-task' : 'after-task';
  return { index: file.index, sha256: actualHash, bytes: byteCount, lines: line,
    child, firstNewTaskLine: taskLine, rows, markers, candidates: classify(rows, markers, child) };
}

async function exactHash(absolute, chunkBytes) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(absolute, { highWaterMark: chunkBytes })) {
    hash.update(chunk); bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

async function identity(name) {
  const absolute = path.resolve(name);
  try {
    const resolved = await realpath(absolute);
    const value = await stat(absolute, { bigint: true });
    return { path: process.platform === 'win32' ? resolved.toLowerCase() : resolved,
      inode: value.ino === 0n ? null : `${value.dev}:${value.ino}` };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = await realpath(path.dirname(absolute));
    const resolved = path.join(parent, path.basename(absolute));
    return { path: process.platform === 'win32' ? resolved.toLowerCase() : resolved, inode: null };
  }
}

const aliases = (left, right) => left.path === right.path
  || Boolean(left.inode && right.inode && left.inode === right.inode);

async function save(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx' });
  await rename(temporary, file);
}

export async function runCohort(manifestPath, censusPath, checkpointPath, options = {}) {
  const chunkBytes = options.chunkBytes ?? 64 * 1024;
  const maxRows = options.maxRows ?? 5000;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error('Invalid chunkBytes');
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw new Error('Invalid maxRows');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const census = JSON.parse(await readFile(censusPath, 'utf8'));
  const manifestSha256 = sha(manifestBytes);
  if (!formats.has(census.format) || census.manifestSha256 !== manifestSha256
      || !Array.isArray(census.files) || !Array.isArray(manifest.files)
      || census.files.length !== manifest.files.length || !path.isAbsolute(manifest.root))
    throw new Error('Census checkpoint does not match manifest');
  const selection = selectCohort(census, options);
  if (!selection.length) throw new Error('No eligible cohort files');
  const root = await realpath(manifest.root);
  const files = await Promise.all(selection.map(async item => {
    const entry = manifest.files[item.index];
    const censusFile = census.files[item.index];
    if (typeof entry?.path !== 'string' || path.isAbsolute(entry.path)
        || !/^[a-f0-9]{64}$/.test(entry.sha256)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
        || entry.sha256 !== censusFile.sha256 || entry.bytes !== censusFile.bytes)
      throw new Error(`Invalid manifest/census file ${item.index}`);
    const absolute = await realpath(path.resolve(root, entry.path));
    if (!absolute.startsWith(root + path.sep)) throw new Error(`Source outside root at file ${item.index}`);
    return { index: item.index, absolute, bytes: entry.bytes, sha256: entry.sha256 };
  }));
  const sourcePaths = await Promise.all(manifest.files.map(async (entry, index) => {
    if (typeof entry?.path !== 'string' || path.isAbsolute(entry.path))
      throw new Error(`Invalid manifest file ${index}`);
    const absolute = await realpath(path.resolve(root, entry.path));
    if (!absolute.startsWith(root + path.sep))
      throw new Error(`Source outside root at file ${index}`);
    return absolute;
  }));
  const protectedPaths = await Promise.all([manifestPath, censusPath,
    ...sourcePaths].map(identity));
  for (const target of [checkpointPath, `${checkpointPath}.${process.pid}.tmp`]) {
    const candidate = await identity(target);
    if (protectedPaths.some(source => aliases(candidate, source)))
      throw new Error('Cohort checkpoint aliases an input');
  }
  const selectionHash = sha(JSON.stringify({ selection, maxRows }));
  let checkpoint;
  try { checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    checkpoint = null;
  }
  if (!checkpoint || checkpoint.format !== 'agentsession-v3-codex-usage-cohort/v3'
      || checkpoint.manifestSha256 !== manifestSha256
      || checkpoint.selectionHash !== selectionHash)
    checkpoint = { format: 'agentsession-v3-codex-usage-cohort/v3',
      manifestSha256, selectionHash, selection, files: Array(selection.length).fill(null) };
  const progress = { scannedFiles: 0, reusedFiles: 0 };
  for (const [position, file] of files.entries()) {
    if (checkpoint.files[position]) {
      const actual = await exactHash(file.absolute, chunkBytes);
      if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes)
        throw new Error(`Source hash mismatch for file ${file.index}`);
      progress.reusedFiles++;
      continue;
    }
    checkpoint.files[position] = await scan(file, chunkBytes, maxRows);
    await save(checkpointPath, checkpoint);
    progress.scannedFiles++;
  }
  return { ...checkpoint, progress };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 5) {
    console.error('Usage: node scripts/v3-codex-usage-cohort.mjs <manifest.json> <census-checkpoint.json> <cohort-checkpoint.json>');
    process.exitCode = 2;
  } else {
    runCohort(process.argv[2], process.argv[3], process.argv[4]).then(value =>
      process.stdout.write(JSON.stringify(value) + '\n'), error => {
        console.error(error.message); process.exitCode = 1;
      });
  }
}
