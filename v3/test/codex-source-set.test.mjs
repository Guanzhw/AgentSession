import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug', process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const id = '11111111-1111-4111-8111-111111111111';
const row = (type, payload, second) => JSON.stringify({ type, payload, timestamp: `2026-09-29T00:00:${String(second).padStart(2, '0')}.000Z` }) + '\n';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const tmpRoot = path.resolve(repo, 'tmp');

const privateOracle = {
  sourceSha256: [
    '22df7d750f193647a7f21cdbe3e736c5cc9f1b892b5d598af3db27c9d13cf33a',
    '514b8a4405e9cf1848d878242caf864ca2d64425369240ead9b3a30f2389cb4f',
  ],
  responseIdsSha256: '30f8bd0114bcba463d818b3b09a225fb6e3920693e97522ad8d72d36c225ccc7',
  rawResponseTokenVectorsSha256: 'a2bc8efa874219af524af0ef92a78e1e0758ba5790a6cfcecac965acd30cbe47',
  responseTokenVectorsSha256: '26b7fdac817cab1c2b95b759d1d161b73d96e15942230a790e52c7ea8b4bd68a',
  rawTokenTotals: { input: 25_407_854, cacheRead: 23_630_336, cacheWrite: 0,
    output: 139_615, reasoning: 43_527, total: 25_547_469 },
  // Protocol buckets subtract cached input from input and reasoning from output.
  tokenTotals: { input: 1_777_518, cacheRead: 23_630_336, cacheWrite: 0,
    output: 96_088, reasoning: 43_527, total: 25_547_469 },
  days: [
    { day: '2026-09-11', requests: 109, observations: 111, total: 13_059_740,
      input: 479_430, output: 42_848, reasoning: 22_646, cacheRead: 12_514_816, cacheWrite: 0 },
    { day: '2026-09-12', requests: 55, observations: 58, total: 6_695_212,
      input: 798_347, output: 26_744, reasoning: 10_793, cacheRead: 5_859_328, cacheWrite: 0 },
    { day: '2026-09-15', requests: 22, observations: 23, total: 3_904_492,
      input: 202_919, output: 10_954, reasoning: 8_443, cacheRead: 3_682_176, cacheWrite: 0 },
    { day: '2026-09-19', requests: 20, observations: 22, total: 1_888_025,
      input: 296_822, output: 15_542, reasoning: 1_645, cacheRead: 1_574_016, cacheWrite: 0 },
  ],
};

function eventKey(event) {
  return JSON.stringify([event.provider, event.sessionId, event.messageId, event.segment]);
}

function isSameEventRef(left, right) {
  return ['provider', 'sessionId', 'messageId', 'segment'].every(field => left?.[field] === right?.[field]);
}

function parseCsvRow(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quoted && character === '"' && line[index + 1] === '"') {
      cell += '"';
      index++;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      cells.push(cell);
      cell = '';
    } else {
      cell += character;
    }
  }
  assert.equal(quoted, false, 'Stats CSV row has balanced quotes');
  cells.push(cell);
  return cells;
}

async function removeTempTree(target) {
  const resolved = path.resolve(target);
  const relative = path.relative(tmpRoot, resolved);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    'Temporary cleanup target must remain within the repository tmp directory');
  await rm(resolved, { recursive: true, force: true });
}

async function publicSources(root) {
  root = path.join(root, 'sessions');
  await mkdir(root, { recursive: true });
  const prefix = row('session_meta', { id, cwd: '/source-set' }, 0) +
    row('event_msg', { type: 'user_message', message: 'First selected question' }, 1) +
    row('token_usage_record', { thread_id: id, response_id: 'first-request', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }, 2);
  await writeFile(path.join(root, 'rollout-first.jsonl'), prefix +
    row('event_msg', { type: 'task_started', turn_id: 'aborted' }, 3) +
    row('event_msg', { type: 'user_message', message: 'Excluded aborted question' }, 4) +
    row('event_msg', { type: 'turn_aborted', turn_id: 'aborted' }, 5));
  await writeFile(path.join(root, 'rollout-later.jsonl'), row('session_meta', { id, cwd: '/source-set', history_base: {
    thread_id: id, end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(prefix),
  } }, 6) + row('event_msg', { type: 'user_message', message: 'Later selected question' }, 7) +
    row('token_usage_record', { thread_id: id, response_id: 'later-request', usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 } }, 8));
}

async function files(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(file));
    else if (entry.name.endsWith('.jsonl')) result.push(file);
  }
  return result.sort();
}

async function exercise(t, sourceRoot, privateWitness, cleanupSourceRoot = false) {
  const work = await mkdtemp(path.join(repo, 'tmp/v3-source-set-http-'));
  const originals = await files(sourceRoot);
  const before = await Promise.all(originals.map(async file => sha(await readFile(file))));
  if (privateWitness) {
    assert.equal(originals.length, 2, 'The private opt-in directory contains exactly the retained source pair');
    assert.deepEqual(before, privateOracle.sourceSha256, 'The retained pair matches its frozen source hashes');
  }
  const selectedRoot = privateWitness ? path.join(work, 'codex') : sourceRoot;
  const selectedSources = privateWitness
    ? originals.map(file => path.join(selectedRoot, 'sessions', path.basename(file))) : originals;
  if (privateWitness) {
    await mkdir(path.join(selectedRoot, 'sessions'), { recursive: true });
    for (let index = 0; index < originals.length; index++) {
      await copyFile(originals[index], selectedSources[index]);
    }
    assert.deepEqual(await Promise.all(selectedSources.map(async file => sha(await readFile(file)))), before,
      'The isolated provider transcript roots contain exact witness copies');
  }
  const sessionId = JSON.parse((await readFile(originals[0], 'utf8')).split('\n')[0]).payload.id;
  const args = suffix => ['--codex-dir', selectedRoot, '--opencode-db', path.join(work, 'missing.db'),
    '--claude-dir', path.join(work, 'claude'), '--pi-dir', path.join(work, 'pi'), '--dsh-dir', path.join(work, 'dsh'),
    '--meta-dir', path.join(work, 'meta-' + suffix), '--index-dir', path.join(work, 'index-' + suffix), '--cache-dir', path.join(work, 'cache-' + suffix)];
  const port = await freeFetchSafePort();
  const process_ = spawn(binary, ['serve', '--port', String(port), ...args('web')], { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  process_.stderr.resume();
  const client = new Client({ name: 'source-set-verification', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    if (process_.exitCode === null) { const exit = once(process_, 'close'); process_.kill(); await exit; }
    try {
      assert.deepEqual(await Promise.all(originals.map(async file => sha(await readFile(file)))), before);
    } finally {
      await removeTempTree(work);
      if (cleanupSourceRoot) await removeTempTree(sourceRoot);
    }
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    if (process_.exitCode !== null || attempt === 200) throw new Error('Source-set server did not become ready');
    try { if ((await fetch(base + '/api/providers')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const get = async route => { const response = await fetch(base + route); assert.equal(response.status, 200, 'Source-set HTTP request failed'); return response.json(); };
  const list = await get('/api/v3/sessions?provider=codex');
  assert.equal(list.length, 1);
  assert.ok(list[0].session.sessionId === sessionId, 'Canonical source identity is retained');
  assert.equal(list[0].diagnostic, undefined);
  const providers = await get('/api/providers');
  assert.equal(providers.find(provider => provider.id === 'codex').storageDiagnostic, null);
  const protocol = await get(`/api/v3/protocol/codex/${sessionId}?version=3`);
  assert.equal(protocol.validation.ok, true);
  assert.equal(protocol.usageRecords.length, privateWitness ? 206 : 2);
  assert.equal(protocol.usageObservations.length, privateWitness ? 214 : 0);
  if (privateWitness) {
    const responseIds = protocol.usageRecords.map(record => record.provenance.sourceId);
    assert.equal(new Set(responseIds).size, 206, 'Canonical response IDs remain unique across the selected source set');
    assert.equal(sha(Buffer.from([...responseIds].sort().join('\n') + '\n')), privateOracle.responseIdsSha256,
      'Protocol publishes the independently derived exact response ID set');
    // The raw-source oracle retains provider fields. Codex protocol semantics map input/output
    // to exclusive buckets by subtracting cached input from input and reasoning from output.
    const tokenFields = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'total'];
    const vectors = protocol.usageRecords.map(record => [record.provenance.sourceId,
      ...tokenFields.map(field => record.tokens[field])]).sort((left, right) => left[0].localeCompare(right[0]));
    assert.equal(sha(Buffer.from(JSON.stringify(vectors))), privateOracle.responseTokenVectorsSha256,
      'Each canonical response retains its independently derived token vector');
    const totals = Object.fromEntries(tokenFields.map(field => [field,
      protocol.usageRecords.reduce((sum, record) => sum + (Number.isFinite(record.tokens[field]) ? record.tokens[field] : 0), 0)]));
    assert.deepEqual(totals, privateOracle.tokenTotals);
    assert.equal(protocol.validation.warnings.filter(diagnostic => diagnostic.code === 'codex_usage_payload_unavailable').length,
      1, 'The one unavailable legacy payload remains explicit');
  }
  const excluded = protocol.validation.warnings.filter(diagnostic => diagnostic.code === 'codex_history_base_excluded_record');
  assert.equal(excluded.length, privateWitness ? 8 : 3);
  const detail = await get(`/api/v3/runtime/codex/${sessionId}/events/${encodeURIComponent(excluded[0].event_id)}?revision=${encodeURIComponent(protocol.revision)}`);
  assert.equal(detail.event.kind, 'source.history_base_excluded');
  assert.ok(/#L\d+;bytes=\d+\.\.\d+$/.test(detail.event.provenance.sourceId),
    'History-base exclusion provenance retains its line and byte range');
  assert.ok(selectedSources.some(file => detail.event.provenance.sourceId.startsWith(file + '#L')));
  const bootstrap = await get(`/api/v3/reader/codex/${sessionId}/bootstrap`);
  assert.equal(bootstrap.revision, protocol.revision);
  assert.ok(bootstrap.session.session.provider === 'codex' && bootstrap.session.session.sessionId === sessionId,
    'Reader preserves the canonical provider and session identity');
  const readerItems = bootstrap.segments.flatMap(segment => segment.items);
  assert.ok(readerItems.length > 0 && bootstrap.totalItems >= readerItems.length,
    'Reader publishes a bounded first page under the selected source revision');
  if (!privateWitness) {
    assert.equal(bootstrap.totalItems, 2);
    assert.match(JSON.stringify(bootstrap), /First selected question/);
    assert.match(JSON.stringify(bootstrap), /Later selected question/);
    assert.doesNotMatch(JSON.stringify(bootstrap), /Excluded aborted question/);
  }
  const report = await get('/api/v3/stats/codex?days=custom&from=2026-09-01&to=2026-09-30');
  assert.equal(report.overview.recordedRequestCount, protocol.usageRecords.length);
  assert.equal(report.overview.unresolvedUsageObservationCount, protocol.usageObservations.length);
  assert.deepEqual(report.sourceDiagnostics, []);
  if (privateWitness) {
    const expectedDays = privateOracle.days.map(day => ({
      day: day.day,
      recordedRequestCount: day.requests,
      knownTokenCount: day.total,
      unknownTokenRequestCount: 0,
      unresolvedUsageObservationCount: day.observations,
      inputTokens: day.input,
      outputTokens: day.output,
      reasoningTokens: day.reasoning,
      cacheReadTokens: day.cacheRead,
      cacheWriteTokens: day.cacheWrite,
      totalTokens: day.total,
    }));
    assert.equal(report.overview.totalSessions, 1);
    assert.equal(report.overview.totalTokens, null, 'Full-source total remains unknown for this witness');
    assert.equal(report.overview.knownTokenCount, privateOracle.tokenTotals.total);
    assert.equal(report.overview.unknownTokenRequestCount, 0);
    const populatedDays = report.dailyUsage.filter(day =>
      day.recordedRequestCount > 0 || day.unresolvedUsageObservationCount > 0);
    assert.deepEqual(populatedDays.map(day => ({
      day: day.day,
      recordedRequestCount: day.recordedRequestCount,
      knownTokenCount: day.knownTokenCount,
      unknownTokenRequestCount: day.unknownTokenRequestCount,
      unresolvedUsageObservationCount: day.unresolvedUsageObservationCount,
      inputTokens: day.inputTokens,
      outputTokens: day.outputTokens,
      reasoningTokens: day.reasoningTokens,
      cacheReadTokens: day.cacheReadTokens,
      cacheWriteTokens: day.cacheWriteTokens,
      totalTokens: day.totalTokens,
    })), expectedDays, 'Stats JSON daily request and token totals match the raw-source oracle');
    assert.equal(report.dailyUsage.length, 30, 'The custom date range keeps its full UTC calendar');
    assert.ok(report.dailyUsage.filter(day => !day.recordedRequestCount && !day.unresolvedUsageObservationCount)
      .every(day => day.knownTokenCount === 0 && day.unknownTokenRequestCount === 0 &&
        day.inputTokens === null && day.outputTokens === null && day.reasoningTokens === null &&
        day.cacheReadTokens === null && day.cacheWriteTokens === null && day.totalTokens === null),
    'Calendar padding rows remain empty');
    const csvResponse = await fetch(`${base}/api/v3/stats/codex/export.csv?days=custom&from=2026-09-01&to=2026-09-30`);
    assert.equal(csvResponse.status, 200, 'Stats CSV export is available');
    const csv = (await csvResponse.text()).trimEnd().split(/\r?\n/);
    assert.match(csv[0], /^Provider,Composition Mode,Day \(UTC\),Total Tokens,Input Tokens,Output Tokens,Reasoning Tokens,Cache Read Tokens,Cache Write Tokens,Requests,/);
    const csvRows = csv.slice(1).map(parseCsvRow);
    const csvNumber = value => value === '' ? null : Number(value);
    assert.deepEqual(csvRows.map(row => ({
      day: row[2],
      totalTokens: csvNumber(row[3]),
      inputTokens: csvNumber(row[4]),
      outputTokens: csvNumber(row[5]),
      reasoningTokens: csvNumber(row[6]),
      cacheReadTokens: csvNumber(row[7]),
      cacheWriteTokens: csvNumber(row[8]),
      recordedRequestCount: Number(row[9]),
      knownTokenCount: Number(row[13]),
      unknownTokenRequestCount: Number(row[14]),
      unresolvedUsageObservationCount: Number(row[15]),
    })), report.dailyUsage.map(day => ({
      day: day.day,
      totalTokens: day.totalTokens,
      inputTokens: day.inputTokens,
      outputTokens: day.outputTokens,
      reasoningTokens: day.reasoningTokens,
      cacheReadTokens: day.cacheReadTokens,
      cacheWriteTokens: day.cacheWriteTokens,
      recordedRequestCount: day.recordedRequestCount,
      knownTokenCount: day.knownTokenCount,
      unknownTokenRequestCount: day.unknownTokenRequestCount,
      unresolvedUsageObservationCount: day.unresolvedUsageObservationCount,
    })), 'Stats CSV rows carry the same calendar and totals as JSON');
  }
  await client.connect(new StdioClientTransport({ command: binary, args: ['mcp', ...args('mcp')], cwd: repo, stderr: 'pipe' }));
  const call = async (name, arguments_) => { const response = await client.callTool({ name, arguments: arguments_ }); assert.notEqual(response.isError, true, `Source-set MCP ${name} failed`); return response.structuredContent.result; };
  const session = { provider: 'codex', sessionId };
  const summary = await call('session_get', { session });
  assert.ok(summary.session.provider === session.provider && summary.session.sessionId === session.sessionId, 'MCP canonical source identity is retained');
  assert.equal(summary.messageCount, list[0].messageCount);
  const timeline = await call('session_timeline', { session, limit: 2 });
  assert.equal(timeline.events.length, 2);
  assert.equal(timeline.truncated, timeline.nextCursor !== null);
  const timelinePages = [timeline];
  if (privateWitness) {
    assert.ok(timeline.nextCursor, 'The first MCP timeline page exposes a continuation cursor');
    const continuation = await call('session_timeline', { session, limit: 2, cursor: timeline.nextCursor });
    assert.equal(continuation.events.length, 2);
    assert.equal(continuation.truncated, continuation.nextCursor !== null);
    assert.notEqual(continuation.nextCursor, timeline.nextCursor);
    timelinePages.push(continuation);
    const timelineEvents = timelinePages.flatMap(page => page.events);
    const identities = timelineEvents.map(row => eventKey(row.event));
    assert.equal(new Set(identities).size, identities.length, 'MCP continuation advances without repeating event identities');
    assert.ok(timelineEvents.every(row => row.event.provider === session.provider &&
      row.event.sessionId === session.sessionId && row.event.messageId && row.event.segment),
    'Every MCP event reference retains the canonical session identity');
    const firstReaderMessage = readerItems.find(item => item.event.segment === 'message');
    assert.ok(firstReaderMessage && identities.includes(eventKey(firstReaderMessage.event)),
      'Reader and MCP refer to the same first selected message');
    for (const reference of [firstReaderMessage.event, timelinePages[1].events[0].event]) {
      const detail = await call('session_get_event', { event: reference, revision: protocol.revision });
      assert.ok(isSameEventRef(detail.event, reference),
        'MCP event detail resolves the exact Reader/timeline reference');
      assert.equal(detail.revision, protocol.revision);
    }
  }
  if (!privateWitness) {
    assert.deepEqual(timeline.events.map(event => event.preview), ['First selected question', 'Later selected question']);
    const search = await call('session_search', { providers: ['codex'], fields: ['user'], query: 'Excluded aborted question' });
    assert.equal(search.matches.length, 0);
  }
}

test('direct Codex source set agrees across Reader, Protocol, Stats and stdio MCP', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(path.join(repo, 'tmp/v3-source-set-public-'));
  await publicSources(root);
  await exercise(t, root, false, true);
});

test('retained private 373/422 source set agrees across Reader, Protocol, Stats and stdio MCP', {
  timeout: 180_000, skip: !process.env.AGENTSESSION_CODEX_SOURCE_SET_WITNESS_DIR,
}, async t => exercise(t, process.env.AGENTSESSION_CODEX_SOURCE_SET_WITNESS_DIR, true));
