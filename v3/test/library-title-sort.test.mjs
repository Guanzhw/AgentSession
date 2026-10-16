import { onCleanup, temporaryDirectory } from '../../test/helpers/fixture-cleanup.mjs';
import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug', process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');

test('family title sort matches server Intl base collation, subtree recency, visible renames, and child pages', { timeout: 30000 }, async t => {
  const root = await temporaryDirectory(t, path.join(os.tmpdir(), 'as-title-sort-'));
  const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache'].map(name => [name, path.join(root, name)]));
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
  const file = path.join(root, 'opencode.db');
  const samples = [['latin', 'Alpha', 10], ['chinese-b', '北京', 10], ['chinese-z', '中山', 10],
    ['accent-old', 'éclair', 10], ['accent-new', 'ECLAIR', 20], ['accent-family', 'e\u0301clair', 1],
    ['case-a', 'Same', 30], ['case-A', 'same', 30], ['punct', 'A-b', 10],
    ['number-2', 'Item 2', 10], ['number-10', 'Item 10', 10], ['renamed', 'Zulu', 10]];
  const rows = samples.map(([id, title, updated]) => ({ id, title, updated, parent: null }));
  rows.push(...samples.map(([id, title, updated]) => ({ id: `child-${id}`, title, updated, parent: 'latin' })));
  rows.push({ id: 'fresh-descendant', title: 'Fresh', updated: 100, parent: 'accent-family' });
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT,
      fork_boundary TEXT, title TEXT, slug TEXT, directory TEXT, time_created INTEGER,
      time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
      tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT);`);
    const insert = db.prepare('INSERT INTO session_v2 VALUES (?,?,NULL,NULL,?,?,?,1,?,NULL,NULL,NULL,NULL,NULL,NULL)');
    for (const row of rows) insert.run(row.id, row.parent, row.title, row.id, '/public/sort', row.updated);
  } finally {
    db.close();
  }
  const before = await digest(file);
  const port = await freeFetchSafePort();
  const child = spawn(binary, ['serve', '--port', String(port), '--opencode-db', file,
    '--codex-dir', dirs.codex, '--claude-dir', dirs.claude, '--pi-dir', dirs.pi,
    '--dsh-dir', dirs.dsh, '--meta-dir', dirs.meta, '--index-dir', dirs.index, '--cache-dir', dirs.cache],
  { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  onCleanup(t, async () => {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
    assert.equal(await digest(file), before, 'provider source remains unchanged');
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/providers')).ok) break; } catch { /* startup */ }
    if (i === 99) assert.fail(`server not ready: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const title = new Intl.Collator(undefined, { sensitivity: 'base' });
  const identity = new Intl.Collator();
  const expected = (parent, descending) => rows.filter(row => row.parent === parent).sort((a, b) => {
    const updated = row => Math.max(row.updated, ...rows.filter(child => child.parent === row.id).map(child => child.updated));
    return (descending ? -1 : 1) * title.compare(a.title, b.title) || updated(b) - updated(a) || identity.compare(a.id, b.id);
  }).map(row => row.id);
  const collect = async (parent, descending) => {
    const endpoint = parent ? 'children' : 'sessions';
    const field = parent ? 'children' : 'families';
    const params = new URLSearchParams({ provider: 'opencode', limit: '3', sort: descending ? 'title-desc' : 'title-asc' });
    if (parent) params.set('parentId', parent);
    const ids = [];
    do {
      const response = await fetch(`${base}/api/v3/library/${endpoint}?${params}`);
      assert.equal(response.status, 200);
      const page = await response.json();
      ids.push(...page[field].map(row => row.session.session.sessionId));
      if (!page.nextCursor) break;
      params.set('cursor', page.nextCursor);
    } while (true);
    assert.equal(new Set(ids).size, ids.length);
    return ids;
  };
  for (const parent of [null, 'latin']) for (const descending of [false, true])
    assert.deepEqual(await collect(parent, descending), expected(parent, descending), `${title.resolvedOptions().locale} ${parent || 'roots'} descending=${descending}`);
  for (const id of ['renamed', 'child-renamed']) {
    const response = await fetch(`${base}/api/opencode/session/${id}/rename`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ title: 'Aardvark' }) });
    assert.equal(response.status, 200);
    rows.find(row => row.id === id).title = 'Aardvark';
  }
  for (const parent of [null, 'latin']) for (const descending of [false, true])
    assert.deepEqual(await collect(parent, descending), expected(parent, descending), 'renamed visible title controls order');
});
