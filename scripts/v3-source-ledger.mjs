import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { zstdDecompressSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const bodyFields = ['content', 'summary', 'output', 'arguments', 'input', 'message', 'reasoning_content'];
const ownerFields = ['id', 'message_id', 'call_id', 'callId', 'thread_id', 'session_id', 'turn_id', 'root_turn_id', 'response_id', 'turn', 'step', 'role', 'author', 'recipient'];

// Node's Zstd decoder can accept an unfinished frame without throwing. Check
// the physical frame terminator before trusting its consumed-byte result.
function completeFrameLength(bytes) {
  const need = end => { if (end > bytes.length) throw new Error('Truncated Zstd frame'); };
  need(5);
  const flags = bytes[4];
  const single = Boolean(flags & 0x20);
  const dictionarySize = [0, 1, 2, 4][flags & 3];
  const contentSize = [single ? 1 : 0, 2, 4, 8][flags >>> 6];
  let offset = 5 + (single ? 0 : 1) + dictionarySize + contentSize;
  need(offset);
  for (;;) {
    need(offset + 3);
    const block = bytes.readUIntLE(offset, 3);
    const kind = (block >>> 1) & 3;
    if (kind === 3) throw new Error('Reserved Zstd block type');
    offset += 3 + (kind === 1 ? 1 : block >>> 3);
    need(offset);
    if (block & 1) break;
  }
  offset += flags & 4 ? 4 : 0;
  need(offset);
  return offset;
}

// This is a raw storage ledger, independent of Viewer/provider parsers. It does
// not infer turn ownership, deduplicate usage, or select visible history.
export function decodeSourceBytes(bytes) {
  const chunks = [];
  let frames = 0;
  let remaining = bytes;
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0xfd2fb528) {
    while (remaining.length) {
      if (remaining.length < 4 || remaining.readUInt32LE(0) !== 0xfd2fb528) throw new Error('Invalid Zstd frame boundary');
      const frameLength = completeFrameLength(remaining);
      const decoded = zstdDecompressSync(remaining, { info: true });
      const consumed = decoded.engine.bytesWritten;
      if (!Number.isSafeInteger(consumed) || consumed <= 0 || consumed > remaining.length) throw new Error('Invalid Zstd consumed byte count');
      if (consumed !== frameLength) throw new Error('Zstd frame consumption differs');
      chunks.push(decoded.buffer);
      remaining = remaining.subarray(consumed);
      frames++;
    }
  } else chunks.push(bytes);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const records = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      records.push({ line: index + 1, value });
    } catch { throw new Error(`Invalid source record at line ${index + 1}`); }
  }
  return { frames, records };
}

function stringFacts(value, path, result) {
  if (typeof value === 'string') {
    result.push({ path, utf8Bytes: Buffer.byteLength(value), codeUnits: value.length, sha256: hash(value) });
  } else if (Array.isArray(value)) value.forEach((item, index) => stringFacts(item, `${path}/${index}`, result));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) stringFacts(item, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, result);
  }
}

export function sourceLedger(provider, bytes) {
  if (!['codex', 'deepseek-harness'].includes(provider)) throw new Error('Unsupported source provider');
  const decoded = decodeSourceBytes(bytes);
  const records = decoded.records.map(({ line, value }) => {
    const payload = provider === 'codex' ? value.payload : value.data;
    const root = provider === 'codex' ? '/payload' : '/data';
    const body = [];
    const ownership = {};
    const usage = {};
    if (payload && typeof payload === 'object') {
      for (const key of bodyFields) if (Object.hasOwn(payload, key)) stringFacts(payload[key], `${root}/${key}`, body);
      for (const key of ownerFields) if (Object.hasOwn(payload, key)) {
        // Strings may identify private sessions; retain exact equality as a digest.
        ownership[key] = typeof payload[key] === 'string' ? { sha256: hash(payload[key]) } : payload[key];
      }
      for (const key of ['usage', 'turn_token_usage', 'thread_token_usage']) {
        if (Object.hasOwn(payload, key)) usage[key] = payload[key];
      }
      if (value.type === 'event_msg' && payload.type === 'token_count') {
        for (const key of ['last_token_usage', 'total_token_usage']) {
          if (payload.info && Object.hasOwn(payload.info, key)) usage[key] = payload.info[key];
        }
      }
    }
    return {
      line, type: value.type, subtype: provider === 'codex' ? payload?.type ?? null : null,
      sequence: provider === 'codex' ? value.ordinal ?? null : value.seq ?? null,
      sha256: hash(JSON.stringify(value)), body, ownership, usage,
      // Preserve the recorded compressed range representation; no expansion is inferred.
      sourceEventSeqs: value.sourceEventSeqs ?? null,
    };
  });
  return { format: 'agentsession-v3-raw-source-ledger/v1', provider, sourceSha256: hash(bytes), frames: decoded.frames, records };
}

// A consumer supplies chunks for ONE exact source string, in continuation order.
// The source locator and selection remain explicit responsibilities of the caller.
export function verifyBodyContinuation(fact, chunks) {
  const body = chunks.join('');
  return fact.utf8Bytes === Buffer.byteLength(body) && fact.codeUnits === body.length && fact.sha256 === hash(body);
}

async function main(args) {
  if (args.length !== 2) throw new Error('Expected manifest path and private output path');
  const manifest = JSON.parse(await readFile(args[0], 'utf8'));
  const targets = [ ['codex', 'long-team-compaction'], ['deepseek-harness', 'native-v3-packed-compaction'] ];
  const ledgers = [];
  for (const [provider, role] of targets) {
    const file = manifest.files.find(item => item.provider === provider && item.role === role);
    if (!file?.snapshotPath) throw new Error('Frozen source missing');
    ledgers.push({ role, ...sourceLedger(provider, await readFile(file.snapshotPath)) });
  }
  await writeFile(args[1], JSON.stringify({ ledgers }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(ledgers.map(item => ({ provider: item.provider, frames: item.frames, records: item.records.length,
    bodyStrings: item.records.reduce((n, record) => n + record.body.length, 0),
    usageRecords: item.records.filter(record => Object.keys(record.usage).length).length }))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => { console.error('Source ledger capture failed; check input and new output paths'); process.exitCode = 1; });
}
