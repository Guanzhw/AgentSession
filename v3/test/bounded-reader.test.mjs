import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm, appendFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug', process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const sessionId = 'bounded-public-session';
function source(extra = '', count = 100) {
  const records = [{ type: 'session_meta', payload: { id: sessionId } }];
  for (let i = 0; i < count; i++) {
    records.push(i === 32
      ? { type: 'response_item', payload: { type: 'function_call', call_id: 'tool-32', name: 'exec_command', arguments: '{"cmd":"git status --short"}' } }
      : { type: 'response_item', payload: { type: 'message', id: `message-${i}`, role: 'assistant', content: [{ type: 'output_text', text: `Public event ${i}. ${extra}` }] } });
  }
  if (count > 32) records.push({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'tool-32',
    output: 'Chunk ID: public\nWall time: 1.0 seconds\nProcess running with session ID 97155\nOutput:\n' } });
  return records.map(row => JSON.stringify(row)).join('\n') + '\n';
}
async function start(t, dir, count = 100) {
  const sessionDir = path.join(dir, 'source', 'sessions', '2026', '09', '27');
  await mkdir(sessionDir, { recursive: true });
  const file = path.join(sessionDir, 'rollout-public.jsonl');
  await writeFile(file, source('', count));
  const port = await freeFetchSafePort();
  const child = spawn(binary, ['serve', '--port', String(port), '--codex-dir', path.join(dir, 'source'),
    '--opencode-db', path.join(dir, 'absent.db'), '--claude-dir', path.join(dir, 'claude'), '--pi-dir', path.join(dir, 'pi'),
    '--dsh-dir', path.join(dir, 'dsh'), '--meta-dir', path.join(dir, 'meta'), '--index-dir', path.join(dir, 'index'), '--cache-dir', path.join(dir, 'cache')],
    { cwd: repo, windowsHide: true, stdio: 'ignore' });
  t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'close'); });
  const base = `http://127.0.0.1:${port}/api/v3/reader/codex/${sessionId}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { if ((await fetch(`${base}/bootstrap`)).ok) return { base, file }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Reader did not start');
}
const get = async url => {
  const response = await fetch(url);
  return { status: response.status, body: response.headers.get('content-type')?.includes('application/json')
    ? await response.json() : await response.text() };
};
test('bounded Reader traverses source order, locates late events and rejects invalid/stale/scope cursors', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(path.join(repo, 'tmp/v3-bounded-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const left = await start(t, path.join(dir, 'left'));
  const initial = (await get(`${left.base}/bootstrap`)).body;
  assert.equal(initial.totalItems, 100);
  assert.equal(initial.segments[0].items.length, 32);
  assert.equal(initial.toc.entries.length, 64);
  const events = [...initial.segments[0].items];
  let cursor = initial.segments[0].nextCursor;
  while (cursor) {
    const response = await get(`${left.base}/segments?cursor=${encodeURIComponent(cursor)}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.revision, initial.revision);
    const page = response.body.page;
    assert.ok(page.items.length <= 32);
    if (page.startOrdinal === 32) {
      assert.equal(page.items[0].owner.messageId, 'message-31');
      assert.equal(page.ownerContext.event.messageId, 'message-31');
    }
    events.push(...page.items); cursor = page.nextCursor;
  }
  assert.deepEqual(events.map(item => item.ordinal), Array.from({ length: 100 }, (_, i) => i));
  assert.deepEqual(events.map(item => item.event.messageId), Array.from({ length: 100 }, (_, i) => i === 32 ? 'tool-32' : `message-${i}`));
  const nextToc = (await get(`${left.base}/toc?cursor=${encodeURIComponent(initial.toc.nextCursor)}`)).body.toc;
  assert.deepEqual([...initial.toc.entries, ...nextToc.entries].map(item => item.ordinal), Array.from({ length: 100 }, (_, i) => i));
  const locateUrl = `${left.base}/locate?revision=${initial.revision}&edge=end`;
  const location = (await get(locateUrl)).body;
  assert.equal(location.event.messageId, 'message-99');
  const late = (await get(`${left.base}/segments?cursor=${encodeURIComponent(location.pageCursor)}`)).body.page;
  assert.equal(late.startOrdinal, 96);
  assert.equal(late.items.at(-1).event.messageId, 'message-99');
  const exact = (await get(`${left.base}/locate?revision=${initial.revision}&messageId=tool-32&segment=tool`)).body;
  assert.equal(exact.owner.messageId, 'message-31');
  for (const invalid of ['broken', initial.toc.nextCursor]) {
    const response = await get(`${left.base}/segments?cursor=${encodeURIComponent(invalid)}`);
    assert.equal(response.status, 400); assert.equal(response.body.error.code, 'invalid_cursor');
  }
  for (const changed of [
    { version: 9 }, { projection: 11 }, { position: 1 }, { position: 128 },
    { session: { provider: 'codex', sessionId: 'other' } },
  ]) {
    const token = JSON.stringify({ ...JSON.parse(initial.segments[0].nextCursor), ...changed });
    const response = await get(`${left.base}/segments?cursor=${encodeURIComponent(token)}`);
    assert.equal(response.status, 400); assert.equal(response.body.error.code, 'invalid_cursor');
  }
  assert.equal((await get(`${left.base}/locate?revision=${initial.revision}&messageId=missing&segment=message`)).status, 404);
  const right = await start(t, path.join(dir, 'right'));
  assert.equal((await get(`${right.base}/segments?cursor=${encodeURIComponent(initial.segments[0].nextCursor)}`)).body.error.code, 'invalid_cursor');
  const executionsUrl = `${left.base}/executions?${new URLSearchParams({ revision: initial.revision, limit: '1' })}`;
  const executions = await get(executionsUrl);
  assert.equal(executions.status, 200);
  assert.equal(executions.body.revision, initial.revision);
  assert.ok(executions.body.events.length > 0);
  for (const params of [{ limit: '0' }, { limit: '201' }, { cursor: 'broken' }, { unknown: 'true' }]) {
    const rejected = await get(`${left.base}/executions?${new URLSearchParams({ revision: initial.revision, ...params })}`);
    assert.equal(rejected.status, 400);
  }
  assert.equal((await get(`${left.base}/executions`)).status, 400);
  await writeFile(left.file, source('changed'));
  for (const url of [locateUrl, `${left.base}/segments?cursor=${encodeURIComponent(initial.segments[0].nextCursor)}`, `${left.base}/toc?cursor=${encodeURIComponent(initial.toc.nextCursor)}`]) {
    const response = await get(url);
    assert.equal(response.status, 200);
    assert.equal(response.body.revision, initial.revision, 'navigation retains the opened generation before bootstrap refresh');
  }
  assert.deepEqual((await get(executionsUrl)).body, executions.body);
  const rewritten = (await get(`${left.base}/bootstrap`)).body;
  assert.notEqual(rewritten.revision, initial.revision);
  for (const url of [locateUrl, `${left.base}/segments?cursor=${encodeURIComponent(initial.segments[0].nextCursor)}`, executionsUrl]) {
    const response = await get(url);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'source_changed');
  }
  await appendFile(left.file, '\n');
  assert.equal((await get(`${left.base}/segments?cursor=${encodeURIComponent(rewritten.segments[0].nextCursor)}`)).status, 200);
  await unlink(left.file);
  const missing = await get(`${left.base}/segments?cursor=${encodeURIComponent(rewritten.segments[0].nextCursor)}`);
  assert.equal(missing.status, 200, 'published navigation remains readable after source removal');
  assert.equal((await get(`${left.base}/bootstrap`)).status, 404, 'fresh opening still checks source availability');
});

test('Reader TOC batching preserves complete entries and bounded canonical cursor navigation', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(path.join(repo, 'tmp/v3-batched-toc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { base, file } = await start(t, dir, 1300);
  const sourceHash = async () => createHash('sha256').update(await readFile(file)).digest('hex');
  const beforeHash = await sourceHash();
  const initial = (await get(`${base}/bootstrap`)).body;
  assert.equal(initial.totalItems, 1300);
  assert.equal(initial.toc.entries.length, 64, 'bootstrap retains its default bound');
  const tocUrl = (cursor, limit) => `${base}/toc?${new URLSearchParams({ cursor,
    ...(limit === undefined ? {} : { limit: String(limit) }) })}`;
  const ordinary = (await get(tocUrl(initial.toc.nextCursor))).body.toc;
  assert.equal(ordinary.entries.length, 64, 'omitting limit retains the existing page size');
  const explicitMinimum = await get(tocUrl(initial.toc.nextCursor, 64));
  assert.equal(explicitMinimum.status, 200);
  assert.deepEqual(explicitMinimum.body.toc, ordinary);
  const expected = [...initial.toc.entries];
  for (let cursor = initial.toc.nextCursor; cursor;) {
    const response = await get(tocUrl(cursor));
    assert.equal(response.status, 200);
    expected.push(...response.body.toc.entries);
    cursor = response.body.toc.nextCursor;
  }
  const actual = [...initial.toc.entries];
  let requests = 0;
  for (let cursor = initial.toc.nextCursor; cursor;) {
    const position = JSON.parse(cursor).position;
    const response = await get(tocUrl(cursor, 512));
    assert.equal(response.status, 200);
    assert.equal(response.body.revision, initial.revision);
    const page = response.body.toc;
    assert.equal(page.entries[0].ordinal, position);
    assert.ok(page.entries.length <= 512);
    assert.equal(JSON.parse(page.previousCursor).position, Math.max(0, position - 512));
    if (page.nextCursor) assert.equal(JSON.parse(page.nextCursor).position, position + 512);
    actual.push(...page.entries);
    cursor = page.nextCursor;
    requests++;
  }
  assert.equal(requests, 3);
  assert.deepEqual(actual, expected, 'batching retains every entry, source reference, label and process fact');
  assert.deepEqual(actual.map(entry => entry.ordinal), Array.from({ length: 1300 }, (_, i) => i));
  assert.deepEqual(actual.map(entry => entry.event.messageId), Array.from({ length: 1300 }, (_, i) => i === 32 ? 'tool-32' : `message-${i}`));
  for (const limit of [0, 63, 65, 513, 1024]) {
    const response = await get(tocUrl(initial.toc.nextCursor, limit));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'invalid_request');
  }
  assert.equal((await get(tocUrl('broken', 63))).body.error.code, 'invalid_request', 'limit is validated at the request boundary');
  assert.equal((await get(`${tocUrl(initial.toc.nextCursor, 512)}&unknown=true`)).status, 400);
  for (const position of [1, 1344]) {
    const cursor = JSON.stringify({ ...JSON.parse(initial.toc.nextCursor), position });
    assert.equal((await get(tocUrl(cursor, 512))).body.error.code, 'invalid_cursor');
  }
  const scoped = JSON.stringify({ ...JSON.parse(initial.toc.nextCursor), scope: 'different-source-scope' });
  assert.equal((await get(tocUrl(scoped, 512))).body.error.code, 'invalid_cursor');
  const target = (await get(`${base}/bootstrap?${new URLSearchParams({ messageId: 'message-1299', segment: 'message' })}`)).body;
  assert.equal(target.toc.entries.length, 20, 'targeted bootstrap retains its 64-entry page');
  assert.equal(target.toc.entries.at(-1).event.messageId, 'message-1299');
  assert.equal(target.toc.nextCursor, null);
  assert.equal(await sourceHash(), beforeHash, 'TOC reads preserve provider source bytes');
  await writeFile(file, source('rewritten', 1300));
  const rewritten = (await get(`${base}/bootstrap`)).body;
  assert.notEqual(rewritten.revision, initial.revision);
  assert.equal((await get(tocUrl(initial.toc.nextCursor, 512))).body.error.code, 'source_changed');
  await writeFile(file, source('', 0));
  const empty = (await get(`${base}/bootstrap`)).body;
  assert.equal(empty.totalItems, 0);
  assert.deepEqual(empty.toc.entries, []);
  assert.equal(empty.toc.nextCursor, null);
  assert.equal(empty.toc.previousCursor, null);
  const emptyCursor = JSON.stringify({ ...JSON.parse(initial.toc.nextCursor), revision: empty.revision, position: 0 });
  const emptyPage = await get(tocUrl(emptyCursor, 512));
  assert.equal(emptyPage.status, 200);
  assert.deepEqual(emptyPage.body.toc, empty.toc, 'the empty generation stays an empty bounded page');
});

test('Runtime source jumps verify their own revision and the current Reader generation', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(path.join(repo, 'tmp/v3-reader-source-jump-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { base, file } = await start(t, dir);
  const runtime = base.replace('/reader/', '/runtime/');
  const runtimeRevision = async () => (await get(`${runtime}/events?limit=1`)).body.revision;
  await writeFile(file, source() + '{"type":');
  const opened = (await get(`${base}/bootstrap`)).body;
  const strict = await runtimeRevision();
  assert.notEqual(strict, opened.revision, 'an unfinished tail gives Runtime and Reader distinct valid revision identities');
  const jump = (revision, sourceRevision, messageId = 'message-31') =>
    `${base}/locate?${new URLSearchParams({ revision, sourceRevision, messageId, segment: 'message' })}`;
  const stable = await get(jump(opened.revision, strict));
  assert.equal(stable.status, 200);
  assert.equal(stable.body.event.messageId, 'message-31');
  assert.equal((await get(jump(opened.revision, 'different-runtime-revision'))).body.error.code, 'source_changed');

  await writeFile(file, source('rewritten content'));
  const rewrittenStrict = await runtimeRevision();
  assert.equal((await get(jump(opened.revision, strict))).body.error.code, 'source_changed');
  const staleReader = await get(jump(opened.revision, rewrittenStrict));
  assert.equal(staleReader.status, 409, 'the same canonical message ID must not open text from an older generation');
  assert.equal(staleReader.body.error.code, 'source_changed');
  const rewritten = (await get(`${base}/bootstrap`)).body;
  assert.equal((await get(jump(rewritten.revision, rewrittenStrict))).status, 200);

  await appendFile(file, JSON.stringify({ type: 'response_item', payload: {
    type: 'message', id: 'appended-runtime-message', role: 'assistant',
    content: [{ type: 'output_text', text: 'New Runtime source event.' }],
  } }) + '\n');
  const appendedStrict = await runtimeRevision();
  const absentFromSnapshot = await get(jump(rewritten.revision, appendedStrict, 'appended-runtime-message'));
  assert.equal(absentFromSnapshot.status, 409);
  assert.equal(absentFromSnapshot.body.error.code, 'source_changed');
  const appended = (await get(`${base}/bootstrap`)).body;
  assert.equal((await get(jump(appended.revision, appendedStrict, 'appended-runtime-message'))).status, 200);
});
