import { createHash } from 'node:crypto';
import path from 'node:path';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true });

function records(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.at(-1) !== 10) return null;
  let text;
  try { text = decoder.decode(bytes); } catch { return null; }
  const lines = text.split('\n');
  lines.pop();
  try {
    const parsed = lines.map(line => JSON.parse(line));
    return parsed.every(value => value && typeof value === 'object' && !Array.isArray(value))
      ? parsed : null;
  } catch { return null; }
}

function header(rows) {
  const first = rows?.[0];
  return first?.type === 'session_meta' && typeof first.payload?.id === 'string'
    && first.payload.id.length > 0
    ? first.payload : null;
}

function root(payload) {
  return payload.parent_thread_id == null && payload.forked_from_id == null
    && payload.source?.subagent == null;
}

function compactionLink(first, later, prefixRecords) {
  const earlier = first.slice(0, prefixRecords).filter(row => row.type === 'compacted').at(-1)?.payload;
  const continuation = later.find(row => row.type === 'compacted')?.payload;
  return !earlier?.window_id || !continuation
    || continuation.previous_window_id === earlier.window_id
      && continuation.first_window_id === earlier.first_window_id;
}

function directPair(entries, id) {
  for (const laterIndex of [0, 1]) {
    const firstIndex = 1 - laterIndex;
    const first = entries[firstIndex];
    const later = entries[laterIndex];
    const base = later.header.history_base;
    if (first.header.history_base || !root(first.header) || !root(later.header)
      || base?.thread_id !== id) continue;
    const cutoff = base.end_byte_offset;
    const prefixRecords = base.end_ordinal_exclusive;
    if (!Number.isSafeInteger(cutoff) || !Number.isSafeInteger(prefixRecords)
      || cutoff <= 0 || cutoff >= first.bytes.length || prefixRecords <= 0
      || first.bytes[cutoff - 1] !== 10) continue;
    const prefix = first.bytes.subarray(0, cutoff);
    if (prefix.reduce((count, byte) => count + Number(byte === 10), 0) !== prefixRecords) continue;
    const suffix = first.rows.slice(prefixRecords);
    if (!suffix.length || suffix[0]?.type !== 'event_msg'
      || suffix[0]?.payload?.type !== 'task_started'
      || suffix.at(-1)?.type !== 'event_msg'
      || suffix.at(-1)?.payload?.type !== 'turn_aborted'
      || suffix.some(row => row.type === 'token_usage_record'
        || row.type === 'event_msg' && row.payload?.type === 'token_count')
      || !compactionLink(first.rows, later.rows, prefixRecords)) continue;
    return {
      status: 'direct-pair',
      sessionId: id,
      activeBytes: Buffer.concat([prefix, later.bytes]),
      excludedRecords: suffix.length,
      sourceSha256: [sha256(first.bytes), sha256(later.bytes)],
      prefixRecords
    };
  }
  return null;
}

/**
 * A source-only classifier for the bounded Codex direct history-base shape.
 * The caller supplies bytes from frozen provider files; no product parser,
 * index, or MCP result participates in selecting history.
 */
export function classifyCodexSearchSources(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error('NoSourceCandidates');
  const entries = candidates.map(candidate => {
    if (typeof candidate?.path !== 'string' || path.extname(candidate.path) !== '.jsonl') {
      throw new Error('UnsupportedSourcePath');
    }
    const rows = records(candidate.bytes);
    const meta = header(rows);
    if (!rows || !meta) throw new Error('UnreadableCanonicalSource');
    return { path: candidate.path, bytes: candidate.bytes, rows, header: meta };
  });
  const id = entries[0].header.id;
  if (entries.some(entry => entry.header.id !== id)) throw new Error('MixedCanonicalSourceIds');
  if (entries.length === 1) {
    return { status: 'single', sessionId: id, activeBytes: entries[0].bytes,
      sourceSha256: [sha256(entries[0].bytes)] };
  }
  if (entries.length === 2) {
    const pair = directPair(entries, id);
    if (pair) return pair;
  }
  const directories = entries.map(entry => entry.header.cwd ?? entry.header.workdir ?? null);
  const directory = directories[0] && directories.every(value => value === directories[0])
    ? directories[0] : null;
  return { status: 'unresolved', sessionId: id, directory,
    sourceSha256: entries.map(entry => sha256(entry.bytes)) };
}
