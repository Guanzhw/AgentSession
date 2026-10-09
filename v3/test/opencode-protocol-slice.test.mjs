import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');

async function setup(t, version) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'as-opencode-events-'));
  const children = [];
  t.after(async () => {
    for (const child of children) child.kill();
    await Promise.all(children.map(child => child.exitCode === null ? once(child, 'close') : null));
    await rm(root, { recursive: true, force: true });
  });
  const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']
    .map(name => [name, path.join(root, name)]));
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
  const file = path.join(root, 'opencode.db');
  const db = new DatabaseSync(file);
  if (version === 'v2') {
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT,
      fork_boundary TEXT, title TEXT, slug TEXT, directory TEXT, time_created INTEGER,
      time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
      tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT);
      INSERT INTO session_v2 VALUES ('root',NULL,NULL,NULL,'Root','root','/synthetic',1,1,NULL,0,0,0,0,0),
        ('fork',NULL,'root','{}','Fork','fork','/synthetic',1,1,NULL,0,0,0,0,0);`);
    const add = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
    add.run('u', 'root', 'user', 1, 1, 1, JSON.stringify({ text: 'SECRET_USER' }));
    add.run('a', 'root', 'assistant', 2, 2, 2, JSON.stringify({ content: [
      { type: 'reasoning', text: 'SECRET_REASONING' },
      { type: 'text', text: 'SECRET_ANSWER' },
      { type: 'tool', name: 'read', state: { status: 'completed', input: {}, content: [] } },
    ] }));
    add.run('c', 'root', 'compaction', 3, 3, 3, JSON.stringify({ summary: 'SECRET_SUMMARY' }));
    add.run('msg_parent_4', 'fork', 'assistant', 4, 4, 4, JSON.stringify({ content: [
      { type: 'text', text: 'SECRET_INHERITED' }] }));
    add.run('f', 'fork', 'user', 5, 5, 5, JSON.stringify({ text: 'SECRET_FORK' }));
  } else {
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT,
      directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT,
        time_created INTEGER);
      INSERT INTO session VALUES ('legacy',NULL,'Legacy','/synthetic',1,1,NULL);
      INSERT INTO message VALUES ('m','legacy','{"role":"user","time":{"created":1}}',1);
      INSERT INTO part VALUES ('p','m','legacy','{"type":"text","text":"SECRET_LEGACY"}',1),
        ('tool','m','legacy','{"type":"tool","tool":"read","state":{"status":"error","error":"SECRET_ERROR"}}',2);`);
  }
  db.close();
  const args = ['--opencode-db', file, '--codex-dir', dirs.codex, '--claude-dir', dirs.claude,
    '--pi-dir', dirs.pi, '--dsh-dir', dirs.dsh, '--meta-dir', dirs.meta,
    '--index-dir', dirs.index, '--cache-dir', dirs.cache];
  return { file, args, children };
}

async function serve(f) {
  const port = await freeFetchSafePort();
  const child = spawn(binary, ['serve', '--port', String(port), ...f.args],
    { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data.toString(); });
  f.children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/providers')).ok) return base; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`server did not start: ${stderr.slice(0, 500)}`);
}

async function allEvents(base, session, limit = 2) {
  const events = [];
  let cursor;
  let revision;
  do {
    const url = new URL(`/api/v3/runtime/opencode/${session}/events`, base);
    url.searchParams.set('limit', String(limit));
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.coverage, 'partial');
    if (revision) assert.equal(page.revision, revision);
    revision = page.revision;
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  return { events, revision };
}

test('OpenCode v1/v2 source events page completely with native IDs and verified Reader refs',
  { timeout: 40_000 }, async t => {
    for (const version of ['v1', 'v2']) {
      const f = await setup(t, version);
      const before = sha(f.file);
      const base = await serve(f);
      const { events, revision } = await allEvents(base, version === 'v1' ? 'legacy' : 'root');
      assert.ok(revision);
      assert.deepEqual(events.map(event => event.sequence), events.map((_, i) => i + 1));
      assert.ok(events.every(event => event.provenance.sourceType.startsWith('opencode.')));
      assert.ok(events.every(event => event.provenance.sourceId));
      assert.ok(events.some(event => event.readerEvent?.messageId ===
        (version === 'v1' ? 'm:p' : 'a:content:2')));
      assert.equal(JSON.stringify(events).includes('SECRET_'), false);
      if (version === 'v1') assert.equal(events.find(event => event.provenance.sourceId === 'tool').kind, 'tool.error');
      if (version === 'v2') {
        assert.equal(events.find(event => event.readerEvent?.messageId === 'a:content:2').kind, 'tool.completed');
        assert.deepEqual([...new Set(events.map(event => event.sourceOrder.record))], [1, 2, 3]);
        const fork = await allEvents(base, 'fork');
        assert.ok(fork.events.every(event => event.provenance.sourceId !== 'msg_parent_4'));
        assert.ok(fork.events.every(event => !event.readerEvent ||
          event.readerEvent.sessionId === 'fork'));
      }
      assert.equal(sha(f.file), before);
    }
  });

test('OpenCode WAL-only change invalidates an event cursor', { timeout: 30_000 }, async t => {
  const f = await setup(t, 'v2');
  const db = new DatabaseSync(f.file);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    const base = await serve(f);
    const url = new URL('/api/v3/runtime/opencode/root/events?limit=1', base);
    const first = await (await fetch(url)).json();
    assert.ok(first.nextCursor);
    const mainBefore = sha(f.file);
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run(
      'late', 'root', 'user', 4, 4, 4, JSON.stringify({ text: 'SECRET_LATE' }));
    url.searchParams.set('cursor', first.nextCursor);
    const stale = await fetch(url);
    assert.equal(stale.status, 400);
    assert.equal((await stale.json()).error.code, 'invalid_cursor');
    assert.equal(sha(f.file), mainBefore);
  } finally {
    db.close();
  }
});

test('OpenCode invalid source record reports a diagnostic without its payload',
  { timeout: 30_000 }, async t => {
    const f = await setup(t, 'v2');
    const db = new DatabaseSync(f.file);
    db.prepare('UPDATE session_message SET data=? WHERE id=?').run('SECRET_BAD_JSON', 'a');
    db.close();
    const base = await serve(f);
    const response = await fetch(new URL('/api/v3/runtime/opencode/root/events', base));
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.match(body, /source_error/);
    assert.equal(body.includes('SECRET_BAD_JSON'), false);
  });

test('frozen OpenCode v2 source streams all native rows without changing DB or WAL',
  { timeout: 60_000, skip: !process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST }, async t => {
    const manifest = JSON.parse(readFileSync(process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST));
    const database = manifest.database.snapshotPath;
    const wal = `${database}-wal`;
    const before = [database, wal].map(file => {
      try { return sha(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    });
    assert.equal(before[0], manifest.database.snapshotSha256);
    const target = manifest.captureTargets.find(row => row.provider === 'opencode');
    const f = await setup(t, 'v2');
    f.args[f.args.indexOf('--opencode-db') + 1] = database;
    const base = await serve(f);
    const { events, revision } = await allEvents(base, target.sessionId, 100);
    const sourceDb = new DatabaseSync(database, { readOnly: true });
    const expectedTools = sourceDb.prepare(`SELECT m.id, m.seq, m.data FROM session_message m
      JOIN session_v2 s ON s.id=m.session_id WHERE m.session_id=? AND
      (s.fork_session_id IS NULL OR substr(m.id,-length(CAST(m.seq AS TEXT))-1) != '_' || m.seq)
      ORDER BY m.seq, m.id`).all(target.sessionId).flatMap(row => {
        const content = JSON.parse(row.data).content;
        return Array.isArray(content) ? content.flatMap((part, index) => part.type === 'tool' ? [{
          id: `event:opencode:v2:${row.id}:content:${index}`,
          kind: ['pending', 'running', 'completed', 'error'].includes(part.state?.status)
            ? `tool.${part.state.status}` : 'tool',
        }] : []) : [];
      });
    sourceDb.close();
    assert.ok(expectedTools.length > 0);
    assert.deepEqual(events.filter(event => event.category === 'tool').map(event =>
      ({ id: event.id, kind: event.kind })), expectedTools);
    const nativeIds = new Set(events.map(event => event.provenance.sourceId));
    assert.equal(nativeIds.size, target.knownFacts.selectedMessageRows);
    assert.deepEqual(events.map(event => event.sequence), events.map((_, i) => i + 1));
    assert.ok(events.every(event => event.sourceOrder.record >= 0));
    assert.ok(events.some(event => event.readerEvent));
    const reader = await (await fetch(new URL(
      `/api/v3/reader/opencode/${target.sessionId}/bootstrap`, base))).json();
    assert.equal(revision, reader.revision);
    const after = [database, wal].map(file => {
      try { return sha(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    });
    assert.deepEqual(after, before);
  });

 test('OpenCode tool state remains unknown unless recorded and malformed state is diagnosed',
  { timeout: 30_000 }, async t => {
    const f = await setup(t, 'v2');
    const db = new DatabaseSync(f.file);
    const states = [{ status: 'pending' }, { status: 'running' }, { status: 'error' }, {}, { status: 'future' }];
    db.prepare('UPDATE session_message SET data=? WHERE id=?').run(JSON.stringify({
      content: states.map(state => ({ type: 'tool', name: 'read', state })) }), 'a');
    db.close();
    const base = await serve(f);
    const { events } = await allEvents(base, 'root');
    assert.deepEqual(events.filter(event => event.category === 'tool').map(event => event.kind),
      ['tool.pending', 'tool.running', 'tool.error', 'tool', 'tool']);
    const corrupt = new DatabaseSync(f.file);
    corrupt.prepare('UPDATE session_message SET data=? WHERE id=?').run(JSON.stringify({
      content: [{ type: 'tool', name: 'read', state: { status: { secret: 'SECRET_BAD' } } }] }), 'a');
    corrupt.close();
    const response = await fetch(`${base}/api/v3/runtime/opencode/root/events`);
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.match(body, /source_error/);
    assert.equal(body.includes('SECRET_BAD'), false);
  });
