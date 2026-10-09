import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { decodeSourceBytes } from './v3-source-ledger.mjs';

// Bounded evidence rule: require an explicitly owned canonical Codex response,
// or one unambiguous DSH settlement slot in an unseeded v3 session. Ambiguous
// snapshots are not folded using the implementation under examination.
export function requestUsageExpectation(provider, bytes, line) {
  const rows = decodeSourceBytes(bytes).records;
  const header = rows[0]?.value;
  const record = rows.find(row => row.line === line)?.value;
  let sessionId, sourceId, turnId, raw, tokens, snapshots, missing;
  if (provider === 'codex') {
    const p = record?.payload;
    sessionId = header?.payload?.id;
    if (header?.type !== 'session_meta' || record?.type !== 'token_usage_record' || !sessionId ||
        p.session_id !== sessionId || p.thread_id !== sessionId || !p.response_id || !p.turn_id) throw new Error('Explicit request ownership missing');
    const matching = rows.filter(({value:r}) => r.type === 'token_usage_record' && r.payload?.response_id === p.response_id);
    if (matching.length !== 1) throw new Error('Canonical response is not unique');
    sourceId = p.response_id; turnId = p.turn_id; raw = p.usage;
    for (const key of ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']) {
      if (!Number.isSafeInteger(raw?.[key]) || raw[key] < 0) throw new Error('Request component missing');
    }
    if (raw.input_tokens < raw.cached_input_tokens + raw.cache_write_input_tokens || raw.output_tokens < raw.reasoning_output_tokens || raw.total_tokens !== raw.input_tokens + raw.output_tokens) throw new Error('Request component arithmetic differs');
    tokens = { input: raw.input_tokens - raw.cached_input_tokens - raw.cache_write_input_tokens,
      cacheRead: raw.cached_input_tokens, cacheWrite: raw.cache_write_input_tokens,
      output: raw.output_tokens - raw.reasoning_output_tokens, reasoning: raw.reasoning_output_tokens, total: raw.total_tokens };
    snapshots = { request: raw, turnCumulative: p.turn_token_usage ?? null, threadCumulative: p.thread_token_usage ?? null };
    missing = [];
  } else if (provider === 'deepseek-harness') {
    if (header?.type !== 'session' || header.version !== 3 || header.isSeeded !== false || record?.type !== 'assistant/message' || record.surfaceOp !== 'append') throw new Error('Unseeded settlement ownership missing');
    const d = record.data;
    if (!Number.isSafeInteger(d?.turn) || !Number.isSafeInteger(d?.step)) throw new Error('Settlement slot missing');
    const matching = rows.filter(({value:r}) => ['assistant/message', 'assistant/attempt'].includes(r.type) && r.data?.turn === d.turn && r.data?.step === d.step);
    if (matching.length !== 1) throw new Error('Settlement slot is ambiguous');
    sessionId = header.id; sourceId = String(record.seq); turnId = String(d.turn); raw = d.usage;
    for (const key of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'totalTokens']) {
      if (!Number.isSafeInteger(raw?.[key]) || raw[key] < 0) throw new Error('Request component missing');
    }
    if (raw.outputTokens < raw.reasoningTokens) throw new Error('Reasoning subset differs');
    tokens = { input: raw.inputTokens, cacheRead: raw.cacheReadTokens, output: raw.outputTokens - raw.reasoningTokens, reasoning: raw.reasoningTokens, total: raw.totalTokens };
    missing = Object.hasOwn(raw, 'cacheWriteTokens') ? [] : ['cacheWrite'];
    if (!missing.length) tokens.cacheWrite = raw.cacheWriteTokens;
    snapshots = { settlement: raw, slot: { turn: d.turn, step: d.step } };
  } else throw new Error('Unsupported provider');
  return { provider, sourceSha256: createHash('sha256').update(bytes).digest('hex'), line,
    sessionRef: { provider, sessionId }, sourceId, turnId, scope: 'request', tokens, snapshots, missing,
    rule: provider === 'codex' ? 'one canonical response_id; cumulative and legacy snapshots are not additional requests' : 'one settlement in one unseeded turn/step slot; repeated slots require separate adjudication' };
}

export function verifyRequestUsage(expected, usageRecords) {
  const selected = usageRecords.filter(row => row.provenance?.sourceId === expected.sourceId);
  if (selected.length !== 1) return { ok: false, reason: 'request missing or duplicated' };
  const row = selected[0];
  if (!isDeepStrictEqual(row.sessionRef, expected.sessionRef) || row.turnId !== expected.turnId || row.scope !== 'request') return { ok: false, reason: 'request owner or scope differs' };
  for (const [key, value] of Object.entries(expected.tokens)) {
    if (row.tokens?.[key] !== value) return { ok: false, reason: 'recorded request components differ' };
  }
  return { ok: true, recordedComponents: Object.keys(expected.tokens).length, missingComponents: expected.missing };
}

export function verifyUsageCaptureAgainstSourceBytes(capture, sourceBytesByProvider) {
  if (!Array.isArray(capture?.captures) || !capture.captures.length) throw new Error('Usage capture is missing');
  const seen = new Set();
  const summary = [];
  for (const item of capture.captures) {
    const provider = item?.provider;
    if (seen.has(provider) || !sourceBytesByProvider.has(provider)) throw new Error('Usage provider is invalid');
    seen.add(provider);
    const expected = requestUsageExpectation(provider, sourceBytesByProvider.get(provider), item.expected?.line);
    if (!isDeepStrictEqual(item.expected, expected)) throw new Error('Captured usage expectation differs from raw source');
    const result = verifyRequestUsage(expected, item.projected);
    if (!result.ok) throw new Error(`Usage projection differs: ${result.reason}`);
    summary.push({ provider, recordedComponents: result.recordedComponents, missingComponents: result.missingComponents });
  }
  return summary;
}

async function main(args) {
  if (args.length !== 2) throw new Error('Expected frozen manifest and private capture paths');
  const manifest = JSON.parse(await readFile(args[0], 'utf8'));
  const captureBytes = await readFile(args[1]);
  const capture = JSON.parse(captureBytes);
  const roles = new Map([['codex', 'long-team-compaction'], ['deepseek-harness', 'native-v3-packed-compaction']]);
  const sources = new Map();
  for (const [provider, role] of roles) {
    const file = manifest.files?.find(item => item.provider === provider && item.role === role);
    if (!file?.snapshotPath || !/^[0-9a-f]{64}$/.test(file.snapshotSha256)) throw new Error('Frozen source entry is missing');
    const bytes = await readFile(file.snapshotPath);
    if (createHash('sha256').update(bytes).digest('hex') !== file.snapshotSha256) throw new Error('Frozen source hash differs');
    sources.set(provider, bytes);
  }
  const summary = verifyUsageCaptureAgainstSourceBytes(capture, sources);
  if (summary.length !== roles.size || summary.some(item => !roles.has(item.provider))) throw new Error('Frozen usage coverage is incomplete');
  console.log(JSON.stringify({ passed: true, captureSha256: createHash('sha256').update(captureBytes).digest('hex'), summary }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => { console.error('Frozen usage verification failed'); process.exitCode = 1; });
}
