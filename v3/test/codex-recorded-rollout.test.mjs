import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const id = '11111111-1111-4111-8111-111111111111';
const healthyId = '22222222-2222-4222-8222-222222222222';
const unrelatedId = '33333333-3333-4333-8333-333333333333';
const session = { provider: 'codex', sessionId: id };
const row = (type, payload, second = 0) => JSON.stringify({ type, payload,
  timestamp: `2026-10-09T00:00:${String(second).padStart(2, '0')}.000Z` }) + '\n';
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');

function transcript(label, tokens, sessionId = id) {
  return row('session_meta', { id: sessionId, cwd: `/synthetic/${label}` }) +
    row('event_msg', { type: 'user_message', message: `${label} selected question` }, 1) +
    row('response_item', { type: 'message', id: `${label}-reply`, role: 'assistant',
      content: [{ type: 'output_text', text: `${label} complete answer` }] }, 2) +
    row('token_usage_record', { thread_id: sessionId, response_id: `${label}-request`,
      usage: { input_tokens: tokens, output_tokens: 2, total_tokens: tokens + 2 } }, 3);
}

async function fixture(t, { directPair = false, mapping = true } = {}) {
  assert.ok(existsSync(binary), `Build the native binary at ${binary} or set AGENTSESSION_V3_BIN`);
  const work = await mkdtemp(path.join(repo, 'tmp/v3-recorded-rollout-'));
  const codex = path.join(work, 'codex');
  const sources = path.join(codex, 'sessions');
  await mkdir(sources, { recursive: true });
  const first = path.join(sources, 'rollout-first.jsonl');
  const later = path.join(sources, 'rollout-later.jsonl');
  const healthy = path.join(sources, 'rollout-healthy.jsonl');
  const prefix = transcript('First', 10);
  await writeFile(first, directPair ? prefix +
    row('event_msg', { type: 'task_started', turn_id: 'aborted' }, 4) +
    row('event_msg', { type: 'turn_aborted', turn_id: 'aborted' }, 5) : prefix);
  await writeFile(later, directPair
    ? row('session_meta', { id, cwd: '/synthetic/First', history_base: {
      thread_id: id, end_ordinal_exclusive: 4, end_byte_offset: Buffer.byteLength(prefix),
    } }, 6) + row('event_msg', { type: 'user_message', message: 'Later selected question' }, 7) +
      row('token_usage_record', { thread_id: id, response_id: 'Later-request',
        usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 } }, 8)
    : transcript('Later', 20));
  await writeFile(healthy, transcript('Healthy', 30, healthyId));
  const titleFile = path.join(codex, 'session_index.jsonl');
  await writeFile(titleFile, JSON.stringify({ id,
    thread_name: 'Recorded native title', updated_at: '2026-10-09T01:00:00Z' }) + '\n');
  const preserved = await Promise.all([first, later, healthy, titleFile].map(async file => [file, await hash(file)]));
  const state = path.join(codex, 'state_5.sqlite');
  const db = new DatabaseSync(state);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)');
  if (mapping) insert.run(id, first);
  insert.run(unrelatedId, first);
  db.close();
  let expectedDbHash = await hash(state);
  const setMapping = async (threadId, sourcePath) => {
    const writer = new DatabaseSync(state);
    try { writer.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET rollout_path=excluded.rollout_path').run(threadId, sourcePath); }
    finally { writer.close(); }
    expectedDbHash = await hash(state);
  };
  const args = suffix => ['--codex-dir', codex, '--opencode-db', path.join(work, 'missing.db'),
    '--claude-dir', path.join(work, 'claude'), '--pi-dir', path.join(work, 'pi'),
    '--dsh-dir', path.join(work, 'dsh'), '--meta-dir', path.join(work, `meta-${suffix}`),
    '--index-dir', path.join(work, `index-${suffix}`), '--cache-dir', path.join(work, `cache-${suffix}`)];
  const port = await freeFetchSafePort();
  const child = spawn(binary, ['serve', '--port', String(port), ...args('web')],
    { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-5000); });
  const client = new Client({ name: 'recorded-rollout-test', version: '1.0.0' });
  t.after(async () => {
    try {
      await client.close();
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close'); child.kill(); await closed;
      }
      for (const [file, before] of preserved) assert.equal(await hash(file), before, `${file} remains read-only`);
      assert.equal(await hash(state), expectedDbHash, 'Transport reads leave native SQLite bytes unchanged');
    } finally {
      assert.equal(path.dirname(path.resolve(work)), path.resolve(repo, 'tmp'));
      await rm(work, { recursive: true, force: true });
    }
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    if (child.exitCode !== null || attempt === 150) throw new Error(`Recorded-rollout server failed: ${stderr}`);
    try { if ((await fetch(base + '/api/providers', { signal: AbortSignal.timeout(500) })).ok) break; }
    catch { /* Startup. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await client.connect(new StdioClientTransport({ command: binary, args: ['mcp', ...args('mcp')], cwd: repo, stderr: 'pipe' }));
  const response = route => fetch(base + route);
  const get = async route => {
    const result = await response(route);
    const body = await result.text();
    assert.equal(result.status, 200, `${route}: ${body}`);
    return JSON.parse(body);
  };
  const callRaw = (name, arguments_) => client.callTool({ name, arguments: arguments_ });
  const call = async (name, arguments_) => {
    const result = await callRaw(name, arguments_);
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    return result.structuredContent.result;
  };
  return { first, later, healthy, setMapping, get, response, call, callRaw };
}

const readerRoute = `/api/v3/reader/codex/${id}`;
const statsRoute = '/api/v3/stats/codex?days=custom&from=2026-10-01&to=2026-10-31';
const contentRoute = (event, revision) => `${readerRoute}/content?${new URLSearchParams({
  messageId: event.messageId, segment: event.segment, field: 'body', offset: '0', maxChars: '100', revision,
})}`;

test('recorded rollout authority refreshes HTTP and stdio MCP caches without transcript mutation',
  { timeout: 60_000 }, async t => {
    const { get, response, call, callRaw, setMapping, later, healthy } = await fixture(t);
    const list = await get('/api/v3/sessions?provider=codex');
    const selected = list.find(row => row.session.sessionId === id);
    assert.equal(selected.title, 'Recorded native title');
    assert.equal(selected.diagnostic, undefined);
    assert.equal(selected.directory, '/synthetic/First');
    const bootstrap = await get(`${readerRoute}/bootstrap`);
    assert.match(JSON.stringify(bootstrap), /First selected question/);
    assert.doesNotMatch(JSON.stringify(bootstrap), /Later selected question/);
    const firstReply = bootstrap.segments.flatMap(segment => segment.items)
      .find(item => item.event.messageId === 'First-reply').event;
    assert.equal((await get(contentRoute(firstReply, bootstrap.revision))).text, 'First complete answer');
    const protocol = await get(`/api/v3/protocol/codex/${id}?version=3`);
    assert.deepEqual(protocol.usageRecords.map(record => record.provenance.sourceId), ['First-request']);
    assert.equal((await get(statsRoute)).overview.knownTokenCount, 44);
    assert.equal((await call('session_get', { session })).title, 'Recorded native title');
    const timeline = await call('session_timeline', { session, limit: 1 });
    assert.equal(timeline.events[0].preview, 'First selected question');
    assert.ok(timeline.nextCursor);
    const firstDetail = await call('session_get_event', { event: firstReply, revision: bootstrap.revision });
    assert.equal(firstDetail.content.text, 'First complete answer');
    const library = await get('/api/v3/library/sessions?provider=codex&limit=1');
    assert.ok(library.nextCursor);

    await setMapping(unrelatedId, healthy);
    assert.equal((await get(`${readerRoute}/bootstrap`)).revision, bootstrap.revision,
      'An unrelated native row does not churn this session revision');
    assert.equal((await call('session_timeline', { session, limit: 1, cursor: timeline.nextCursor })).events[0].preview,
      'First complete answer', 'Unrelated row changes retain the session continuation');
    assert.equal((await call('session_get_event', { event: firstReply, revision: bootstrap.revision })).revision,
      firstDetail.revision);

    await setMapping(id, later);
    const refreshedList = await get('/api/v3/sessions?provider=codex');
    assert.equal(refreshedList.find(row => row.session.sessionId === id).directory, '/synthetic/Later');
    const refreshed = await get(`${readerRoute}/bootstrap`);
    assert.notEqual(refreshed.revision, bootstrap.revision);
    assert.match(JSON.stringify(refreshed), /Later selected question/);
    assert.doesNotMatch(JSON.stringify(refreshed), /First selected question/);
    const laterReply = refreshed.segments.flatMap(segment => segment.items)
      .find(item => item.event.messageId === 'Later-reply').event;
    assert.equal((await get(contentRoute(laterReply, refreshed.revision))).text, 'Later complete answer');
    assert.equal((await response(contentRoute(firstReply, bootstrap.revision))).status, 409);
    assert.equal((await response(`/api/v3/library/sessions?provider=codex&limit=1&cursor=${encodeURIComponent(library.nextCursor)}`)).status, 409);
    assert.deepEqual((await get(`/api/v3/protocol/codex/${id}?version=3`)).usageRecords
      .map(record => record.provenance.sourceId), ['Later-request']);
    assert.equal((await get(statsRoute)).overview.knownTokenCount, 54);
    const search = await get('/api/v3/search?provider=codex&fields=user&q=First%20selected');
    assert.equal(search.matches.length, 0);
    const newTimeline = await call('session_timeline', { session, limit: 2 });
    assert.deepEqual(newTimeline.events.map(event => event.preview), ['Later selected question', 'Later complete answer']);
    assert.equal((await call('session_get', { session })).directory, '/synthetic/Later');
    for (const [name, args] of [
      ['session_timeline', { session, limit: 1, cursor: timeline.nextCursor }],
      ['session_get_event', { event: firstReply, revision: bootstrap.revision }],
    ]) {
      const stale = await callRaw(name, args);
      assert.equal(stale.isError, true);
      assert.match(stale.content[0].text, /^source_changed:/);
    }
    assert.equal((await call('session_get_event', { event: laterReply, revision: refreshed.revision })).content.text,
      'Later complete answer');
  });

test('missing or header-mismatched native rollout mapping keeps same-ID history unavailable',
  { timeout: 60_000 }, async t => {
    const { get, response, callRaw, setMapping, healthy } = await fixture(t, { mapping: false });
    for (const mapping of ['absent', 'mismatched']) {
      if (mapping === 'mismatched') await setMapping(id, healthy);
      const list = await get('/api/v3/sessions?provider=codex');
      assert.equal(list.find(row => row.session.sessionId === id).diagnostic,
        'codex_multiple_source_files_unmerged',
        `${mapping} mapping preserves the existing collision diagnostic`);
      const unavailable = await response(`${readerRoute}/bootstrap`);
      assert.equal(unavailable.status, 503, `${mapping}: ${await unavailable.text()}`);
      const protocol = await response(`/api/v3/protocol/codex/${id}?version=3`);
      assert.equal(protocol.status, 503);
      const timeline = await callRaw('session_timeline', { session });
      assert.equal(timeline.isError, true);
      const stats = await get(statsRoute);
      assert.deepEqual(stats.sessions.map(row => row.session.sessionId), [healthyId]);
      assert.equal(stats.overview.excludedSourceSessionCount, 1);
    }
  });

test('explicit history_base source pair retains precedence over native rollout selection',
  { timeout: 60_000 }, async t => {
    const { get, call, setMapping, later } = await fixture(t, { directPair: true });
    const bootstrap = await get(`${readerRoute}/bootstrap`);
    assert.match(JSON.stringify(bootstrap), /First selected question/);
    assert.match(JSON.stringify(bootstrap), /Later selected question/);
    const protocol = await get(`/api/v3/protocol/codex/${id}?version=3`);
    assert.deepEqual(protocol.usageRecords.map(record => record.provenance.sourceId), ['First-request', 'Later-request']);
    assert.equal((await get(statsRoute)).overview.knownTokenCount, 66);
    assert.deepEqual((await call('session_timeline', { session })).events.map(event => event.preview),
      ['First selected question', 'First complete answer', 'Later selected question']);
    await setMapping(id, later);
    assert.equal((await get(`${readerRoute}/bootstrap`)).revision, bootstrap.revision,
      'An explicit recorded source pair owns its revision regardless of the native selected file');
  });
