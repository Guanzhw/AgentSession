import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, appendFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug', process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const sessionId = 'bounded-public-session';
function source(extra = '') {
  const records = [{ type: 'session_meta', payload: { id: sessionId } }];
  for (let i = 0; i < 100; i++) {
    records.push(i === 32
      ? { type: 'response_item', payload: { type: 'function_call', call_id: 'tool-32', name: 'public_tool', arguments: '{}' } }
      : { type: 'response_item', payload: { type: 'message', id: `message-${i}`, role: 'assistant', content: [{ type: 'output_text', text: `Public event ${i}. ${extra}` }] } });
  }
  return records.map(row => JSON.stringify(row)).join('\n') + '\n';
}
async function start(t, dir) {
  const sessionDir = path.join(dir, 'source', 'sessions', '2026', '09', '27');
  await mkdir(sessionDir, { recursive: true });
  const file = path.join(sessionDir, 'rollout-public.jsonl');
  await writeFile(file, source());
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
const get = async url => { const response = await fetch(url); return { status: response.status, body: await response.json() }; };
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
    { version: 9 }, { projection: 9 }, { position: 1 }, { position: 128 },
    { session: { provider: 'codex', sessionId: 'other' } },
  ]) {
    const token = JSON.stringify({ ...JSON.parse(initial.segments[0].nextCursor), ...changed });
    const response = await get(`${left.base}/segments?cursor=${encodeURIComponent(token)}`);
    assert.equal(response.status, 400); assert.equal(response.body.error.code, 'invalid_cursor');
  }
  assert.equal((await get(`${left.base}/locate?revision=${initial.revision}&messageId=missing&segment=message`)).status, 404);
  const right = await start(t, path.join(dir, 'right'));
  assert.equal((await get(`${right.base}/segments?cursor=${encodeURIComponent(initial.segments[0].nextCursor)}`)).body.error.code, 'invalid_cursor');
  await writeFile(left.file, source('changed'));
  for (const url of [locateUrl, `${left.base}/segments?cursor=${encodeURIComponent(initial.segments[0].nextCursor)}`, `${left.base}/toc?cursor=${encodeURIComponent(initial.toc.nextCursor)}`]) {
    const response = await get(url); assert.equal(response.status, 409); assert.equal(response.body.error.code, 'source_changed');
  }
  const rewritten = (await get(`${left.base}/bootstrap`)).body;
  await appendFile(left.file, '\n');
  assert.equal((await get(`${left.base}/segments?cursor=${encodeURIComponent(rewritten.segments[0].nextCursor)}`)).status, 409);
  await unlink(left.file);
  const missing = await get(`${left.base}/segments?cursor=${encodeURIComponent(rewritten.segments[0].nextCursor)}`);
  assert.equal(missing.status, 404); assert.equal(missing.body.error.code, 'session_not_found');
});
