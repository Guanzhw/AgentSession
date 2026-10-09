import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const rows = values => values.map(value => JSON.stringify(value)).join('\n') + '\n';

async function setup(t) {
  const dir = await mkdtemp(path.join(repo, 'tmp/v3-target-bootstrap-'));
  let child;
  t.after(async () => {
    if (child) { child.kill(); if (child.exitCode === null && child.signalCode === null) await once(child, 'close'); }
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(path.join(dir, 'codex/sessions'), { recursive: true });
  const source = path.join(dir, 'codex/sessions/root.jsonl');
  const records = [
    { type: 'session_meta', payload: { id: 'root' } },
    { type: 'response_item', payload: { type: 'message', id: 'owner', role: 'assistant',
      content: [{ type: 'output_text', text: 'Opening owner reply.' }] } },
    ...Array.from({ length: 75 }, (_, n) => ({ type: 'response_item', payload: {
      type: 'function_call', call_id: `tool-${n}`, name: 'read', arguments: JSON.stringify({ public: n }),
    } })),
  ];
  await writeFile(source, rows(records));
  await mkdir(path.join(dir, 'pi/sessions/project'), { recursive: true });
  await writeFile(path.join(dir, 'pi/sessions/project/fallback.jsonl'), rows([
    { type: 'session', version: 3, id: 'fallback', cwd: '/public/fixture', timestamp: '2026-09-27T00:00:00Z' },
    ...Array.from({ length: 75 }, (_, n) => ({ type: 'message', id: `reply-${n}`, parentId: n ? `reply-${n - 1}` : null,
      timestamp: '2026-09-27T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: `Public reply ${n}.` }] } })),
  ]));
  const port = await freeFetchSafePort();
  await writeFile(path.join(dir, 'config.json'), '{}');
  let diagnostics = '';
  child = spawn(binary, ['serve', '--port', String(port), '--disable-terminal-launch',
    '--opencode-db', path.join(dir, 'absent.db'),
    ...['codex', 'pi', 'claude', 'dsh', 'meta', 'index', 'cache'].flatMap(name => [`--${name}-dir`, path.join(dir, name)])],
  { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, AGENTSESSION_CONFIG: path.join(dir, 'config.json') } });
  child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  for (let n = 0; n < 150; n++) {
    try { if ((await fetch(base + '/api/providers')).ok) return { base, source, records }; } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Owned target-bootstrap server did not start: ' + diagnostics);
}
const get = async url => { const response = await fetch(url); return { status: response.status, body: await response.json() }; };

test('target bootstrap returns bounded opening and selected pages with canonical owner and one revision', { timeout: 45000 }, async t => {
  const { base } = await setup(t);
  for (const [provider, id, messageId, segment] of [['codex', 'root', 'tool-70', 'tool'], ['pi', 'fallback', 'reply-70', 'message']]) {
    const root = `${base}/api/v3/reader/${provider}/${id}`;
    const opening = await get(root + '/bootstrap');
    assert.equal(opening.status, 200);
    assert.equal(opening.body.segments.length, 1);
    assert.equal(opening.body.segments[0].startOrdinal, 0);
    assert.equal('targetLocation' in opening.body, false);
    assert.equal('openingToc' in opening.body, false);
    const targeted = await get(root + '/bootstrap?' + new URLSearchParams({ messageId, segment, revision: opening.body.revision }));
    assert.equal(targeted.status, 200);
    const body = targeted.body;
    assert.equal(body.revision, opening.body.revision);
    assert.equal(body.targetLocation.revision, body.revision);
    assert.deepEqual(body.targetLocation.session, { provider, sessionId: id });
    assert.deepEqual(body.targetLocation.event, { provider, sessionId: id, messageId, segment });
    assert.deepEqual(body.segments.map(page => page.startOrdinal), [0, 64]);
    assert.ok(body.segments.every(page => page.items.length <= 32));
    assert.ok(body.toc.entries.length <= 64 && body.openingToc.entries.length <= 64);
    assert.equal(body.toc.entries[0].ordinal, 64);
    assert.equal(body.openingToc.entries[0].ordinal, 0);
    assert.ok(body.segments[1].items.some(item => item.event.messageId === messageId));
    if (provider === 'codex') {
      assert.equal(body.targetLocation.owner.messageId, 'owner');
      assert.equal(body.segments[1].ownerContext.event.messageId, 'owner');
    }
    const continuation = await get(root + '/segments?' + new URLSearchParams({ cursor: body.targetLocation.pageCursor }));
    assert.equal(continuation.body.revision, body.revision);
    assert.deepEqual(continuation.body.page, body.segments[1]);
    const inOpening = await get(root + '/bootstrap?' + new URLSearchParams({ messageId: provider === 'codex' ? 'owner' : 'reply-0', segment: 'message' }));
    assert.equal(inOpening.status, 200);
    assert.equal(inOpening.body.segments.length, 1, 'Opening target does not duplicate a page');
  }
});

test('target bootstrap rejects incomplete, invalid, absent and stale targets explicitly', { timeout: 45000 }, async t => {
  const { base, source, records } = await setup(t);
  const root = `${base}/api/v3/reader/codex/root`;
  const opening = (await get(root + '/bootstrap')).body;
  for (const params of [{ messageId: 'tool-70' }, { segment: 'tool' }, { revision: opening.revision },
    { messageId: '', segment: 'tool' }, { messageId: 'tool-70', segment: '' },
    { messageId: 'tool-70', segment: 'tool', revision: '' }, { messageId: '\0', segment: 'tool' },
    { messageId: 'x'.repeat(4097), segment: 'tool' }, { messageId: 'tool-70', segment: 'x'.repeat(65) },
    { messageId: 'tool-70', segment: 'tool', revision: 'x'.repeat(257) }]) {
    assert.equal((await get(root + '/bootstrap?' + new URLSearchParams(params))).status, 400, JSON.stringify(params));
  }
  assert.equal((await fetch(root + '/bootstrap?messageId=tool-70&segment=tool&edge=end')).status, 400);
  assert.equal((await get(root + '/bootstrap?messageId=absent&segment=message')).status, 404);
  await writeFile(source, rows([...records, { type: 'response_item', payload: { type: 'message', id: 'fresh', role: 'assistant', content: [{ type: 'output_text', text: 'Fresh source.' }] } }]));
  const stale = await get(root + '/bootstrap?' + new URLSearchParams({ messageId: 'tool-70', segment: 'tool', revision: opening.revision }));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'source_changed');
  const fresh = await get(root + '/bootstrap?messageId=tool-70&segment=tool');
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.body.revision, opening.revision);
  assert.equal(fresh.body.targetLocation.revision, fresh.body.revision);
});
