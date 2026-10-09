import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sha = value => createHash('sha256').update(value).digest('hex');
const idHash = value => typeof value === 'string' && value.length ? sha(value) : null;
const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const outputRoot = path.resolve(fileURLToPath(new URL('../tmp/', import.meta.url)));

function vector(value) {
  return Object.fromEntries(fields.map(field => {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, field))
      return [field, { state: 'missing' }];
    const number = value[field];
    if (!Number.isSafeInteger(number) || number < 0) return [field, { state: 'invalid' }];
    return [field, { state: number === 0 ? 'zero' : 'positive', value: number }];
  }));
}

function newTask(record) {
  if (record.type !== 'response_item' || record.payload?.type !== 'agent_message') return false;
  const first = Array.isArray(record.payload.content)
    ? record.payload.content.find(item => typeof item?.text === 'string')?.text : null;
  return typeof first === 'string' && /^Message Type:\s*NEW_TASK\b/i.test(first.trimStart());
}

function classify(record, position, activeSessionHash) {
  const payload = record.payload;
  if (record.type === 'session_meta') return { type: 'boundary', kind: 'session-meta',
    ...position, sessionHash: idHash(payload?.id) ?? idHash(payload?.session_id),
    parentHash: idHash(payload?.parent_thread_id)
      ?? idHash(payload?.source?.subagent?.thread_spawn?.parent_thread_id),
    forkHash: idHash(payload?.forked_from_id), agentPathHash: idHash(payload?.agent_path),
    spawnCallHash: idHash(payload?.source?.subagent?.thread_spawn?.call_id) };
  if (record.type === 'response_item' && payload?.type === 'function_call'
      && payload.name === 'spawn_agent')
    return { type: 'boundary', kind: 'spawn-call', ...position,
      callHash: idHash(payload.call_id), activeSessionHash };
  if (newTask(record)) return { type: 'boundary', kind: 'new-task', ...position,
    messageHash: idHash(payload.id), activeSessionHash };
  if (record.type === 'turn_context') return { type: 'boundary', kind: 'turn-context',
    ...position, turnHash: idHash(payload?.turn_id), activeSessionHash };
  if (record.type === 'compacted') return { type: 'boundary', kind: 'compacted',
    ...position, activeSessionHash };
  if (record.type === 'event_msg' && ['task_started', 'task_complete',
    'turn_aborted', 'context_compacted', 'thread_settings_applied'].includes(payload?.type))
    return { type: 'boundary', kind: payload.type, ...position,
      turnHash: idHash(payload.turn_id), activeSessionHash };
  const canonical = record.type === 'token_usage_record';
  const legacy = record.type === 'event_msg' && payload?.type === 'token_count';
  if (!canonical && !legacy) return null;
  return { type: 'usage', kind: canonical ? 'canonical' : 'legacy', ...position,
    responseHash: idHash(payload?.response_id ?? payload?.info?.response_id),
    turnHash: idHash(payload?.turn_id),
    owner: { threadIdHash: idHash(payload?.thread_id),
      sessionIdHash: idHash(payload?.session_id), activeSessionHash },
    request: vector(canonical ? payload?.usage : payload?.info?.last_token_usage),
    cumulative: vector(canonical ? payload?.thread_token_usage : payload?.info?.total_token_usage) };
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

async function inputs(manifestPath, outputPath, expectedFiles) {
  if (!Number.isSafeInteger(expectedFiles) || expectedFiles < 1)
    throw new Error('An explicit positive expectedFiles count is required');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (typeof manifest.root !== 'string' || !path.isAbsolute(manifest.root)
      || !Array.isArray(manifest.files)
      || manifest.files.length !== expectedFiles)
    throw new Error('Manifest file count does not match expectedFiles');
  const root = await realpath(manifest.root);
  const files = [];
  const protectedIdentities = [await identity(manifestPath)];
  for (const [index, entry] of manifest.files.entries()) {
    if (typeof entry?.path !== 'string' || path.isAbsolute(entry.path)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
        || !/^[a-f0-9]{64}$/.test(entry.sha256))
      throw new Error(`Invalid manifest file ${index}`);
    const absolute = await realpath(path.resolve(root, entry.path));
    if (!absolute.startsWith(root + path.sep)) throw new Error(`Source outside root at file ${index}`);
    const sourceIdentity = await identity(absolute);
    if (protectedIdentities.some(other => aliases(other, sourceIdentity)))
      throw new Error(`Duplicate source file ${index}`);
    protectedIdentities.push(sourceIdentity);
    files.push({ index, absolute, bytes: entry.bytes, sha256: entry.sha256 });
  }
  const output = path.resolve(outputPath);
  const parent = await realpath(path.dirname(output));
  if (!(parent === outputRoot || parent.startsWith(outputRoot + path.sep)))
    throw new Error('Ledger output must be under ignored tmp/');
  const temporary = `${output}.${process.pid}.tmp`;
  for (const target of [output, temporary]) {
    const candidate = await identity(target);
    if (protectedIdentities.some(other => aliases(other, candidate)))
      throw new Error('Ledger output aliases an input');
  }
  try { await stat(output); throw new Error('Ledger output already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { files, output, temporary, manifestSha256: sha(manifestBytes) };
}

async function scan(file, handle, chunkBytes, maxLineBytes) {
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = [];
  let pendingBytes = 0;
  let bytesRead = 0;
  let offset = 0;
  let line = 0;
  let activeSessionHash = null;
  const counts = { canonical: 0, legacy: 0, boundaries: 0 };
  const consume = async (bytes, newline) => {
    line++;
    const position = { file: file.index, sourceSha256: file.sha256,
      line, offset, byteLength: bytes.length, rawHash: sha(bytes) };
    offset += bytes.length + (newline ? 1 : 0);
    if (!bytes.length || bytes.every(byte => byte === 32 || byte === 13 || byte === 9)) return;
    let record;
    try {
      record = JSON.parse(decoder.decode(bytes));
      if (!record || Array.isArray(record) || typeof record !== 'object') throw new Error();
    } catch { throw new Error(`file ${file.index} line ${line}: malformed JSON`); }
    const entry = classify(record, position, activeSessionHash);
    if (entry?.kind === 'session-meta') activeSessionHash = entry.sessionHash;
    if (!entry) return;
    if (entry.type === 'usage') counts[entry.kind]++;
    else counts.boundaries++;
    await handle.writeFile(JSON.stringify(entry) + '\n');
  };
  try {
    for await (const chunk of createReadStream(file.absolute, { highWaterMark: chunkBytes })) {
      hash.update(chunk);
      bytesRead += chunk.length;
      let cursor = 0;
      for (;;) {
        const newline = chunk.indexOf(10, cursor);
        if (newline < 0) break;
        const part = chunk.subarray(cursor, newline);
        if (pendingBytes + part.length > maxLineBytes)
          throw new Error(`file ${file.index} line ${line + 1}: line exceeds limit`);
        await consume(pendingBytes ? Buffer.concat([...pending, part], pendingBytes + part.length) : part, true);
        pending = [];
        pendingBytes = 0;
        cursor = newline + 1;
      }
      const rest = chunk.subarray(cursor);
      if (pendingBytes + rest.length > maxLineBytes)
        throw new Error(`file ${file.index} line ${line + 1}: line exceeds limit`);
      if (rest.length) { pending.push(rest); pendingBytes += rest.length; }
    }
  } catch (error) {
    if (error.code) throw new Error(`file ${file.index}: source read failed`);
    throw error;
  }
  if (pendingBytes) await consume(Buffer.concat(pending, pendingBytes), false);
  if (hash.digest('hex') !== file.sha256 || bytesRead !== file.bytes)
    throw new Error(`Source hash mismatch for file ${file.index}`);
  await handle.writeFile(JSON.stringify({ type: 'file-complete', file: file.index,
    sourceSha256: file.sha256, bytes: bytesRead, lines: line, ...counts }) + '\n');
  return counts;
}

export async function runLedger(manifestPath, outputPath, options = {}) {
  const chunkBytes = options.chunkBytes ?? 64 * 1024;
  const maxLineBytes = options.maxLineBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error('Invalid chunkBytes');
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new Error('Invalid maxLineBytes');
  const { files, output, temporary, manifestSha256 } = await inputs(
    manifestPath, outputPath, options.expectedFiles);
  let handle;
  let created = false;
  const totals = { files: files.length, canonical: 0, legacy: 0, boundaries: 0,
    manifestSha256, format: 'agentsession-v3-codex-raw-usage-ledger/v1' };
  try {
    handle = await open(temporary, 'wx');
    created = true;
    await handle.writeFile(JSON.stringify({ type: 'manifest', format: totals.format,
      manifestSha256, expectedFiles: files.length }) + '\n');
    for (const file of files) {
      const counts = await scan(file, handle, chunkBytes, maxLineBytes);
      for (const key of ['canonical', 'legacy', 'boundaries']) totals[key] += counts[key];
    }
    await handle.writeFile(JSON.stringify({ type: 'complete', ...totals }) + '\n');
    await handle.sync();
    await handle.close();
    handle = null;
    await link(temporary, output);
    await unlink(temporary);
    return totals;
  } catch (error) {
    if (handle) await handle.close();
    if (created) await unlink(temporary).catch(unlinkError => {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 5) {
    console.error('Usage: node scripts/v3-codex-usage-ledger.mjs <manifest.json> <tmp/ledger.private.jsonl> <expected-file-count>');
    process.exitCode = 2;
  } else {
    runLedger(process.argv[2], process.argv[3], { expectedFiles: Number(process.argv[4]) })
      .then(value => process.stdout.write(JSON.stringify(value) + '\n'), error => {
        console.error(error.message); process.exitCode = 1;
      });
  }
}
