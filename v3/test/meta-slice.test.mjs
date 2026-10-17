import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const id = '019f8a00-0000-7000-8000-000000000001';
const otherId = '019f8a00-0000-7000-8000-000000000002';
const missingRestore = 'metadata-only-restore';
const missingPermanent = 'metadata-only-permanent';
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');

async function setup(t) {
  const dir = await mkdtemp(path.join(repo, 'tmp', 'v3-meta-slice-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    await rm(dir, { recursive: true, force: true });
  });
  for (const name of ['pi/sessions/project', 'codex', 'claude', 'dsh', 'meta', 'index', 'cache'])
    await mkdir(path.join(dir, name), { recursive: true });
  const source = path.join(dir, 'pi', 'sessions', 'project', `current_${id}.jsonl`);
  await copyFile(path.join(repo, 'test', 'fixtures', 'pi-v3-current.jsonl'), source);
  const originalSourceHash = await digest(source);
  const otherSource = path.join(dir, 'pi', 'sessions', 'project', `current_${otherId}.jsonl`);
  await writeFile(otherSource, (await readFile(source, 'utf8')).replaceAll(id, otherId));
  const otherSourceHash = await digest(otherSource);
  const seed = path.join(dir, 'seed.db');
  const db = new DatabaseSync(seed);
  db.exec(`CREATE TABLE session_meta (provider TEXT NOT NULL DEFAULT 'opencode', session_id TEXT NOT NULL,
    custom_title TEXT, starred INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, permanent INTEGER DEFAULT 0,
    time_starred INTEGER, time_deleted INTEGER, time_renamed INTEGER, PRIMARY KEY(provider,session_id));
    CREATE TABLE v1_index (session_id TEXT PRIMARY KEY, marker TEXT);`);
  db.prepare('INSERT INTO session_meta(provider,session_id,custom_title,starred) VALUES (?,?,?,?)')
    .run('pi', id, 'Seed title', 1);
  db.prepare('INSERT INTO session_meta(provider,session_id,custom_title) VALUES (?,?,?)')
    .run('openclaw', id, 'Retired row');
  db.prepare('INSERT INTO session_meta(provider,session_id,deleted) VALUES (?,?,1)')
    .run('pi', missingRestore);
  db.prepare('INSERT INTO session_meta(provider,session_id,deleted) VALUES (?,?,1)')
    .run('pi', missingPermanent);
  db.prepare('INSERT INTO v1_index VALUES (?,?)').run(id, 'preserve');
  db.close();
  const preservedLegacy = path.join(dir, 'meta', 'meta.db');
  await copyFile(seed, preservedLegacy);
  const port = await freeFetchSafePort();
  const args = ['serve', '--port', String(port), '--pi-dir', path.join(dir, 'pi'),
    '--codex-dir', path.join(dir, 'codex'), '--claude-dir', path.join(dir, 'claude'),
    '--opencode-db', path.join(dir, 'opencode.db'), '--dsh-dir', path.join(dir, 'dsh'),
    '--meta-dir', path.join(dir, 'meta'), '--index-dir', path.join(dir, 'index'),
    '--cache-dir', path.join(dir, 'cache')];
  child = spawn(binary, args, { cwd: repo, windowsHide: true, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/providers`)).ok) {
      assert.equal((await fetch(`${base}/api/v3/sessions?provider=pi`)).status, 200);
      const catalogs = (await readdir(path.join(dir, 'index'))).filter(name => name.endsWith('.sqlite'));
      assert.equal(catalogs.length, 1, 'a source-backed catalog identifies the active scope');
      const metadata = path.join(dir, 'meta', 'scopes', catalogs[0].slice(0, -'.sqlite'.length), 'meta.db');
      await mkdir(path.dirname(metadata), { recursive: true });
      await copyFile(seed, metadata);
      return { base, metadata, preservedLegacy, source,
        originalSourceHash, otherSource, otherSourceHash, args: args.slice(3) };
    } }
    catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Web server did not start');
}

async function mutate(base, action, body = {}, headers = {}) {
  return fetch(`${base}/api/pi/session/${id}/${action}`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });
}

async function mutateId(base, sessionId, action) {
  return fetch(`${base}/api/pi/session/${sessionId}/${action}`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: base }, body: '{}' });
}

function batchIds(base, ids, action) {
  return fetch(`${base}/api/pi/batch`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ ids, action }) });
}

function metadataRows(metadata) {
  const db = new DatabaseSync(metadata, { readOnly: true });
  try { return db.prepare('SELECT * FROM session_meta ORDER BY provider,session_id').all(); }
  finally { db.close(); }
}

test('batch preflight rejects all writes for duplicate, missing, or permanently excluded targets',
  { timeout: 30_000 }, async t => {
    const { base, metadata } = await setup(t);
    const before = metadataRows(metadata);
    assert.equal((await batchIds(base, [id, id], 'delete')).status, 400);
    assert.equal((await batchIds(base, [id, 'missing-source'], 'delete')).status, 404);
    assert.deepEqual(metadataRows(metadata), before);
    assert.equal((await mutate(base, 'delete')).status, 200);
    assert.equal((await mutateId(base, otherId, 'permanent-delete')).status, 200);
    const excluded = metadataRows(metadata);
    assert.equal((await batchIds(base, [id, otherId], 'restore')).status, 400);
    assert.equal((await mutateId(base, otherId, 'restore')).status, 400);
    assert.deepEqual(metadataRows(metadata), excluded);
    assert.equal((await batchIds(base, [missingRestore], 'restore')).status, 200);
    assert.equal((await batchIds(base, [missingPermanent], 'permanent-delete')).status, 200);
  });

test('batch keeps star transactions, non-star partial commits, and timestamp idempotence on retry',
  { timeout: 30_000 }, async t => {
    const { base, metadata } = await setup(t);
    const db = new DatabaseSync(metadata);
    const rejectSecond = () => db.exec(`CREATE TRIGGER reject_second BEFORE UPDATE ON session_meta
      WHEN NEW.provider='pi' AND NEW.session_id='${otherId}'
      BEGIN SELECT RAISE(ABORT,'owned test rejection'); END;`);
    try {
      const before = metadataRows(metadata);
      rejectSecond();
      assert.equal((await batchIds(base, [id, otherId], 'unstar')).status, 500);
      assert.deepEqual(metadataRows(metadata), before, 'star/unstar chunk is a single transaction');
      assert.equal((await batchIds(base, [id, otherId], 'delete')).status, 500);
      assert.equal(metadataRows(metadata).find(row => row.provider === 'pi' && row.session_id === id).deleted, 1,
        'a completed non-star item remains committed when a later item fails');
      assert.ok(!metadataRows(metadata).some(row => row.session_id === otherId), 'the failed item rolls back');
      db.exec('DROP TRIGGER reject_second');
      assert.equal((await batchIds(base, [id, otherId], 'delete')).status, 200);
      assert.equal((await batchIds(base, [id, otherId], 'restore')).status, 200);
      assert.equal((await batchIds(base, [id, otherId], 'star')).status, 200);
      const starred = metadataRows(metadata);
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal((await batchIds(base, [id, otherId], 'star')).status, 200);
      assert.deepEqual(metadataRows(metadata), starred, 'repeated batch star preserves time_starred');
      assert.equal((await batchIds(base, [id, otherId], 'unstar')).status, 200);
      const unstarred = metadataRows(metadata);
      assert.equal((await batchIds(base, [id, otherId], 'unstar')).status, 200);
      assert.deepEqual(metadataRows(metadata), unstarred);
      assert.equal((await mutate(base, 'star')).status, 200);
      assert.equal(metadataRows(metadata).find(row => row.provider === 'pi' && row.session_id === id).starred, 1);
      assert.equal((await mutate(base, 'star')).status, 200);
      assert.equal(metadataRows(metadata).find(row => row.provider === 'pi' && row.session_id === id).starred, 0,
        'single-item star still toggles');
      assert.equal((await batchIds(base, [id, otherId], 'permanent-delete')).status, 200);
      const permanent = metadataRows(metadata);
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal((await batchIds(base, [id, otherId], 'permanent-delete')).status, 200);
      assert.deepEqual(metadataRows(metadata), permanent, 'permanent-delete preserves existing time_deleted');
    } finally { db.close(); }
  });

test('batch surfaces a metadata lock failure and succeeds after the lock is released',
  { timeout: 30_000 }, async t => {
    const { base, metadata } = await setup(t);
    const before = metadataRows(metadata);
    const reader = new DatabaseSync(metadata);
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM session_meta').get();
    try {
      const response = await batchIds(base, [id, otherId], 'delete');
      assert.equal(response.status, 500);
      assert.match((await response.json()).error.message, /locked/i);
    } finally { reader.exec('COMMIT'); reader.close(); }
    assert.deepEqual(metadataRows(metadata), before, 'a failed locked transaction rolls back');
    assert.equal((await batchIds(base, [id, otherId], 'delete')).status, 200);
    assert.equal(metadataRows(metadata).filter(row => row.provider === 'pi' && row.deleted).length, 4);
  });

test('batch uses its completed source preflight when a later source disappears during writes',
  { timeout: 30_000 }, async t => {
    const { base, metadata, otherSource } = await setup(t);
    const original = await readFile(otherSource);
    const reader = new DatabaseSync(metadata);
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM session_meta').get();
    const pending = fetch(`${base}/api/pi/batch`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ ids: [id, otherId], action: 'delete' }) });
    try {
      let journalFound = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        try { await access(`${metadata}-journal`); journalFound = true; break; }
        catch { await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      assert.ok(journalFound, 'the first metadata transaction reached its write after all source preflight');
      await rm(otherSource);
    } finally {
      reader.exec('COMMIT');
      reader.close();
    }
    try {
      const response = await pending;
      assert.equal(response.status, 200, 'metadata writes reuse successful source preflight');
      assert.deepEqual(await response.json(), { ok: true, affected: 2 });
      const db = new DatabaseSync(metadata, { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT count(*) AS count FROM session_meta WHERE provider=? AND deleted=1 AND session_id IN (?,?)')
          .get('pi', id, otherId).count, 2);
      } finally { db.close(); }
    } finally { await writeFile(otherSource, original); }
  });

test('Viewer metadata survives isolated seed, enforces local JSON writes, and excludes only Viewer',
  { timeout: 30_000 }, async t => {
    const { base, metadata, preservedLegacy, source, originalSourceHash, otherSource, otherSourceHash, args } = await setup(t);
    const legacyHash = await digest(preservedLegacy);
    const providerStatuses = await (await fetch(`${base}/api/providers`)).json();
    assert.deepEqual(providerStatuses.map(row => [row.id, row.manageable]).sort(),
      ['opencode', 'claude-code', 'codex', 'pi', 'deepseek-harness']
        .map(provider => [provider, true]).sort());
    const list = () => fetch(`${base}/api/v3/sessions?provider=pi`).then(response => response.json());
    assert.equal((await list()).find(row => row.session.sessionId === id)?.title, 'Seed title');
    const metaList = await (await fetch(`${base}/api/v3/meta?provider=pi`)).json();
    assert.equal(metaList.find(row => row.sessionId === id)?.starred, true);
    assert.ok(!metaList.some(row => row.provider === 'openclaw'));
    const seedHash = await digest(metadata);
    const reindex = await fetch(`${base}/api/reindex`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: base }, body: '{}' });
    assert.equal(reindex.status, 200);
    const rebuilt = await reindex.json();
    assert.equal(rebuilt.results.find(row => row.provider === 'pi').status, 'rebuilt');
    assert.equal(await digest(metadata), seedHash);
    assert.equal((await list()).find(row => row.session.sessionId === id)?.title, 'Seed title');
    assert.equal((await mutate(base, 'star')).status, 200);
    assert.equal((await mutate(base, 'rename', { title: 'New title' })).status, 200);
    assert.equal((await list()).find(row => row.session.sessionId === id)?.title, 'New title');
    const reader = await (await fetch(`${base}/api/v3/reader/pi/${id}/bootstrap`)).json();
    assert.equal(reader.session.title, 'New title');
    const titleSearch = await (await fetch(`${base}/api/v3/search?q=New%20title&provider=pi&fields=title`)).json();
    assert.equal(titleSearch.matches.find(row => row.session.sessionId === id)?.title, 'New title');
    const firstSearchPage = await (await fetch(`${base}/api/v3/search?q=reader&provider=pi&limit=1`)).json();
    assert.equal(firstSearchPage.matches.length, 1);
    assert.ok(firstSearchPage.nextCursor);
    assert.equal((await mutate(base, 'delete')).status, 200);
    assert.ok(!(await list()).some(row => row.session.sessionId === id));
    const visiblePage = await (await fetch(`${base}/api/v3/search?q=reader&provider=pi&limit=1`)).json();
    assert.deepEqual(visiblePage.matches.map(row => row.session.sessionId), [otherId]);
    assert.equal(visiblePage.nextCursor, null);
    const staleSearch = await fetch(`${base}/api/v3/search?q=reader&provider=pi&limit=1&cursor=${encodeURIComponent(firstSearchPage.nextCursor)}`);
    assert.equal(staleSearch.status, 409);
    assert.equal((await mutate(base, 'restore')).status, 200);
    assert.ok((await list()).some(row => row.session.sessionId === id));
    const batch = (action, headers = {}) => fetch(`${base}/api/pi/batch`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, ...headers },
      body: JSON.stringify({ ids: [id], action }) });
    assert.equal((await batch('star')).status, 200);
    assert.equal((await batch('star')).status, 200);
    assert.equal((await batch('unstar')).status, 200);
    const beforeRejected = await digest(metadata);
    assert.equal((await mutateId(base, 'not-a-source-id', 'delete')).status, 404);
    assert.equal((await mutate(base, 'delete', {}, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await mutate(base, 'delete', {}, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await batch('delete', { origin: 'http://evil.example' })).status, 403);
    assert.equal((await fetch(`${base}/api/reindex`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' })).status, 403);
    assert.equal(await digest(metadata), beforeRejected);
    assert.equal((await mutate(base, 'permanent-delete')).status, 200);
    assert.ok(!(await list()).some(row => row.session.sessionId === id));
    assert.equal((await mutateId(base, missingRestore, 'restore')).status, 200);
    assert.equal((await mutateId(base, missingPermanent, 'permanent-delete')).status, 200);
    const search = await fetch(`${base}/api/v3/search?q=PI&provider=pi`);
    assert.equal(search.status, 200);
    const webSearch = await search.json();
    assert.equal(webSearch.diagnostics.find(item => item.provider === 'pi').status, 'ok');
    assert.ok(!webSearch.matches.some(row => row.session.sessionId === id));
    const client = new Client({ name: 'meta-slice', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: binary, args: ['mcp', ...args],
      cwd: repo, stderr: 'pipe' }));
    const history = await client.callTool({ name: 'session_get', arguments: {
      session: { provider: 'pi', sessionId: id },
    } });
    assert.notEqual(history.isError, true);
    assert.equal(history.structuredContent.result.session.sessionId, id);
    const machineSearch = await client.callTool({ name: 'session_search', arguments: {
      query: 'reader', providers: ['pi'], limit: 10,
    } });
    assert.notEqual(machineSearch.isError, true);
    assert.ok(machineSearch.structuredContent.result.matches.some(row => row.session.sessionId === id));
    await client.close();
    const priorMetadataHash = await digest(metadata);
    const originalOtherBytes = await readFile(otherSource);
    await writeFile(otherSource, 'not-json\n');
    try {
      const failedReindex = await fetch(`${base}/api/reindex`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: base }, body: '{}' });
      assert.equal(failedReindex.status, 500);
      const failure = await failedReindex.json();
      assert.equal(failure.ok, false);
      assert.equal(failure.results.find(row => row.provider === 'pi').status, 'error');
      assert.match(failure.results.find(row => row.provider === 'pi').diagnostic, /invalid|parse|JSON/i);
      assert.equal(await digest(metadata), priorMetadataHash);
    } finally {
      await writeFile(otherSource, originalOtherBytes);
    }
    const db = new DatabaseSync(metadata, { readOnly: true });
    assert.deepEqual({ ...db.prepare('SELECT custom_title,starred,deleted,permanent FROM session_meta WHERE provider=? AND session_id=?')
      .get('pi', id) }, { custom_title: 'New title', starred: 0, deleted: 1, permanent: 1 });
    assert.equal(db.prepare('SELECT custom_title FROM session_meta WHERE provider=? AND session_id=?')
      .get('openclaw', id).custom_title, 'Retired row');
    assert.equal(db.prepare('SELECT marker FROM v1_index WHERE session_id=?').get(id).marker, 'preserve');
    assert.equal(db.prepare('SELECT deleted FROM session_meta WHERE provider=? AND session_id=?')
      .get('pi', missingRestore).deleted, 0);
    assert.equal(db.prepare('SELECT permanent FROM session_meta WHERE provider=? AND session_id=?')
      .get('pi', missingPermanent).permanent, 1);
    db.close();
    assert.equal(await digest(source), originalSourceHash);
    assert.equal(await digest(otherSource), otherSourceHash);
    assert.equal(await digest(preservedLegacy), legacyHash, 'the unscoped 2.0 metadata file is preserved');
    const legacy = new DatabaseSync(metadata);
    legacy.exec('DROP TABLE session_meta; CREATE TABLE session_meta (session_id TEXT PRIMARY KEY, starred INTEGER);');
    legacy.close();
    const incompatibleHash = await digest(metadata);
    const incompatible = await fetch(`${base}/api/v3/sessions?provider=pi`);
    assert.equal(incompatible.status, 500);
    assert.match((await incompatible.json()).error.message, /schema is incompatible/);
    assert.equal(await digest(metadata), incompatibleHash);
  });
