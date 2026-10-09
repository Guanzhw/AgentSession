import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug', process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const rootId = 'reader-search-root';
const childId = 'reader-search-child';
const records = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const message = (id, text) => ({ type: 'response_item', payload: { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }] } });
const rootSource = suffix => records([
  { type: 'session_meta', payload: { id: rootId } },
  ...Array.from({ length: 75 }, (_, n) => message(`message-${n}`, n === 70
    ? `${'preview-only '.repeat(30)}needle NEEDLE needle; foo bar; İx 🙂needle ${suffix}`
    : `Public event ${n}.`)),
  { type: 'response_item', payload: { type: 'function_call', call_id: 'tool-call', name: 'public_tool', arguments: '{"key":"tool needle"}' } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'tool-call', output: 'output needle' } },
]);
const childSource = () => records([
  { type: 'session_meta', payload: { id: childId, parent_thread_id: rootId } },
  message('child-message', 'child-only needle'),
]);

async function start(t, dir, suffix = '') {
  const sourceDir = path.join(dir, 'source');
  const sessionDir = path.join(sourceDir, 'sessions', '2026', '09', '27');
  await mkdir(sessionDir, { recursive: true });
  const rootFile = path.join(sessionDir, 'rollout-root.jsonl');
  await writeFile(rootFile, rootSource(suffix));
  await writeFile(path.join(sessionDir, 'rollout-child.jsonl'), childSource());
  await writeFile(path.join(sessionDir, 'rollout-owned.jsonl'),
    await readFile(path.join(repo, 'v3/fixtures/codex-owned-search.jsonl')));
  const port = await freeFetchSafePort();
  const process = spawn(binary, ['serve', '--port', String(port), '--codex-dir', sourceDir,
    '--opencode-db', path.join(dir, 'absent.db'), '--claude-dir', path.join(dir, 'claude'), '--pi-dir', path.join(dir, 'pi'),
    '--dsh-dir', path.join(dir, 'dsh'), '--meta-dir', path.join(dir, 'meta'), '--index-dir', path.join(dir, 'index'), '--cache-dir', path.join(dir, 'cache')],
  { cwd: repo, windowsHide: true, stdio: 'ignore' });
  t.after(async () => { process.kill(); if (process.exitCode === null) await once(process, 'close'); });
  const root = `http://127.0.0.1:${port}/api/v3/reader/codex/${rootId}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { if ((await fetch(`${root}/bootstrap`)).ok) return {
      root, child: root.replace(rootId, childId),
      owned: root.replace(rootId, '55555555-5555-4555-8555-555555555555'), rootFile,
    }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Reader did not start');
}

async function get(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}
const search = (base, revision, q, extra = {}) => {
  const params = new URLSearchParams({ q, revision, limit: '2', ...extra });
  return get(`${base}/search?${params}`);
};

test('pane search finds every literal owned-content occurrence beyond preview and across fields', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(path.join(repo, 'tmp/v3-reader-search-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { root, child, owned } = await start(t, dir);
  const revision = (await get(`${root}/bootstrap`)).body.revision;
  const first = await search(root, revision, 'needle');
  assert.equal(first.status, 200);
  assert.equal(first.body.scope, 'owned');
  assert.equal(first.body.coverage, 'complete-owned-content');
  assert.equal(first.body.matches.length, 2);
  assert.deepEqual(first.body.matches.map(hit => hit.event.messageId), ['message-70', 'message-70']);
  assert.deepEqual(first.body.matches.map(hit => hit.offset), [390, 397]);
  assert.ok(first.body.matches[0].ordinal > 32);
  assert.ok(first.body.matches[0].excerpt.length < 250);
  assert.equal(first.body.matches[0].field, 'body');
  assert.equal(first.body.matches[0].totalChars, 433);
  const second = await search(root, revision, 'needle', { cursor: first.body.nextCursor });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.matches.map(hit => hit.event.messageId), ['message-70', 'message-70']);
  const third = await search(root, revision, 'needle', { cursor: second.body.nextCursor });
  assert.equal(third.status, 200);
  assert.deepEqual(third.body.matches.map(hit => [hit.field, hit.event.segment]), [['toolInput', 'tool'], ['toolOutput', 'tool']]);
  assert.deepEqual(third.body.matches.map(hit => hit.owner.messageId), ['message-74', 'message-74']);
  assert.equal(third.body.nextCursor, null);
  assert.equal((await search(root, revision, 'foo bar')).body.matches.length, 1);
  assert.equal((await search(root, revision, 'foo needle')).body.matches.length, 0);
  assert.equal((await search(root, revision, 'preview-only '.repeat(25))).body.matches.length, 1);
  assert.equal((await search(root, revision, 'child-only')).body.matches.length, 0);
  const childRevision = (await get(`${child}/bootstrap`)).body.revision;
  const childHits = (await search(child, childRevision, 'needle')).body.matches;
  assert.deepEqual(childHits.map(hit => hit.event.sessionId), [childId]);
  assert.equal((await search(child, childRevision, 'preview-only')).body.matches.length, 0);
  const ownedRevision = (await get(`${owned}/bootstrap`)).body.revision;
  assert.equal((await search(owned, ownedRevision, 'Inherited')).body.matches.length, 0);
  assert.deepEqual((await search(owned, ownedRevision, 'Owned reply')).body.matches.map(hit => hit.event.messageId), ['owned-reply']);
});

test('pane search uses original UTF-16 coordinates and rejects invalid, stale and foreign cursors', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(path.join(repo, 'tmp/v3-reader-search-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const left = await start(t, path.join(dir, 'left'));
  const right = await start(t, path.join(dir, 'right'));
  const revision = (await get(`${left.root}/bootstrap`)).body.revision;
  const first = (await search(left.root, revision, 'needle')).body;
  const unicode = (await search(left.root, revision, 'x')).body.matches[0];
  assert.equal(unicode.offset, 422); // İ lowercases to two scalars, but x follows one UTF-16 unit in source.
  const expanded = (await search(left.root, revision, 'İx')).body.matches[0];
  assert.equal(expanded.offset, 421);
  assert.equal(expanded.matchLength, 2);
  const astral = (await search(left.root, revision, '🙂needle')).body.matches[0];
  assert.equal(astral.offset, 424);
  assert.equal(astral.matchLength, 8);
  const page = await get(`${left.root}/content?${new URLSearchParams({ revision, messageId: astral.event.messageId,
    segment: astral.event.segment, field: astral.field, offset: String(astral.offset), maxChars: String(astral.matchLength) })}`);
  assert.equal(page.body.text, '🙂needle');
  for (const [q, extra] of [['other', { cursor: first.nextCursor }], ['needle', { cursor: 'broken' }],
    ['', {}], ['q'.repeat(501), {}], ['needle', { limit: '0' }], ['needle', { limit: '101' }]]) {
    const result = await search(left.root, revision, q, extra);
    assert.equal(result.status, 400);
  }
  const rightRevision = (await get(`${right.root}/bootstrap`)).body.revision;
  assert.equal((await search(right.root, rightRevision, 'needle', { cursor: first.nextCursor })).body.error.code, 'invalid_cursor');
  const childRevision = (await get(`${left.child}/bootstrap`)).body.revision;
  assert.equal((await search(left.child, childRevision, 'needle', { cursor: first.nextCursor })).body.error.code, 'invalid_cursor');
  await writeFile(left.rootFile, rootSource('changed'));
  assert.equal((await search(left.root, revision, 'needle')).body.error.code, 'source_changed');
  assert.equal((await search(left.root, revision, 'needle', { cursor: first.nextCursor })).body.error.code, 'source_changed');
});
