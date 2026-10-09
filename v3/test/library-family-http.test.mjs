import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug', process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

test('library families preserve canonical boundaries, project aliases, and complete child cursor traversal', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'as-v3-library-'));
  const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache'].map(name => [name, path.join(root, name)]));
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
  const dbPath = path.join(root, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT,
    fork_boundary TEXT, title TEXT, slug TEXT, directory TEXT, time_created INTEGER,
    time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
    tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
    time_created INTEGER, time_updated INTEGER, data TEXT);`);
  const insert = db.prepare('INSERT INTO session_v2 VALUES (?,?,NULL,NULL,?,?,?, ?,?,NULL,NULL,NULL,NULL,NULL,NULL)');
  const add = (id, parent, directory, time) => insert.run(id, parent,
    id === 'root' ? 'An unrelated title' : id, id, directory, time, time);
  add('root', null, 'D:\\Project', 1);
  add('other', null, 'D:\\Project', 2);
  add('orphan', 'missing', 'D:\\Project', 3);
  for (let i = 0; i < 43; i++) add(`child-${String(i).padStart(2, '0')}`, 'root', '/mnt/d/Project', 10 + i);
  db.close();
  const before = hash(dbPath);
  const port = await freeFetchSafePort();
  const args = ['serve', '--port', String(port), '--opencode-db', dbPath,
    '--codex-dir', dirs.codex, '--claude-dir', dirs.claude, '--pi-dir', dirs.pi,
    '--dsh-dir', dirs.dsh, '--meta-dir', dirs.meta, '--index-dir', dirs.index, '--cache-dir', dirs.cache];
  const child = spawn(binary, args, { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data.toString(); });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null) await once(child, 'close');
    assert.equal(hash(dbPath), before);
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/providers')).ok) break; } catch { /* startup */ }
    if (i === 99) assert.fail(`server not ready: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const get = async url => { const response = await fetch(base + url); return { status: response.status, body: await response.json() }; };
  const first = await get('/api/v3/library/sessions?provider=opencode&project=d%3A%2Fproject&limit=1');
  assert.equal(first.status, 200);
  assert.equal(first.body.total, 3);
  assert.equal(first.body.families.length, 1);
  assert.equal(first.body.families[0].session.session.sessionId, 'root');
  assert.equal(first.body.families[0].childCount, 43);
  const second = await get('/api/v3/library/sessions?provider=opencode&project=d%3A%2Fproject&limit=1&cursor=' + encodeURIComponent(first.body.nextCursor));
  assert.equal(second.status, 200);
  assert.equal(second.body.families.length, 1);
  assert.notEqual(second.body.families[0].session.session.sessionId, 'root');
  assert.equal((await get('/api/v3/library/sessions?provider=opencode&search=other&cursor=' + encodeURIComponent(first.body.nextCursor))).status, 400);
  const rootRef = first.body.families[0].session.session;
  const seen = [];
  let cursor;
  let firstChildCursor;
  do {
    const url = '/api/v3/library/children?provider=opencode&parentId=root&limit=20' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const page = await get(url);
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.parent.session.session, rootRef);
    assert.ok(page.body.children.length <= 20);
    seen.push(...page.body.children.map(row => row.session.session.sessionId));
    cursor = page.body.nextCursor;
    firstChildCursor ??= cursor;
  } while (cursor);
  assert.equal(seen.length, 43);
  assert.equal(new Set(seen).size, 43);
  const searched = await get('/api/v3/library/sessions?provider=opencode&search=child-42');
  assert.equal(searched.body.total, 1);
  assert.equal(searched.body.matchingSessions, 1);
  assert.equal(searched.body.families[0].matched, false);
  assert.equal(searched.body.families[0].childCount, 1);
  const byId = await get('/api/v3/library/sessions?provider=opencode&search=root');
  assert.equal(byId.body.total, 1);
  assert.equal(byId.body.matchingSessions, 1);
  assert.equal(byId.body.families[0].matched, true);
  assert.equal((await get('/api/v3/library/children?provider=opencode&parentId=other&cursor=' + encodeURIComponent(firstChildCursor))).status, 400);
  const stale = JSON.parse(firstChildCursor);
  stale.revision = 'stale';
  assert.equal((await get('/api/v3/library/children?provider=opencode&parentId=root&cursor=' + encodeURIComponent(JSON.stringify(stale)))).status, 409);
  assert.equal((await get('/api/v3/library/children?provider=opencode&parentId=missing')).status, 404);
  const orphan = await get('/api/v3/library/sessions?provider=opencode&search=orphan');
  assert.equal(orphan.body.families[0].parentBoundary, 'missing-parent');
  assert.equal(orphan.body.families[0].session.parent.sessionId, 'missing');
  const bad = await get('/api/v3/library/children?provider=opencode&parentId=other&cursor=' + encodeURIComponent(first.body.nextCursor));
  assert.equal(bad.status, 400);
});
