import { onCleanup, temporaryDirectory } from '../../test/helpers/fixture-cleanup.mjs';
import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, readFileSync, statSync, truncateSync, utimesSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

async function fixture(t, schema) {
  const dir = await temporaryDirectory(t, path.join(os.tmpdir(), 'agentsession-v3-opencode-'));
  for (const name of ['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']) {
    await mkdir(path.join(dir, name));
  }
  const file = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  try {
    if (schema === 'v2') {
      db.exec(`CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT,
        title TEXT, slug TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER,
        time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
        tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER
      ); CREATE TABLE session_message (
        id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
        time_created INTEGER, time_updated INTEGER, data TEXT
      ); CREATE TABLE session_pending (id TEXT, session_id TEXT, data TEXT);
      INSERT INTO session_v2 VALUES
        ('root',NULL,NULL,NULL,'Root','root','/synthetic',1,5,NULL,10,5,2,3,1),
        ('child','root',NULL,NULL,'Child','child','/synthetic',2,5,NULL,0,0,0,0,0),
        ('fork',NULL,'root','{}','Fork','fork','/synthetic',3,5,NULL,0,0,0,0,0),
        ('archived',NULL,NULL,NULL,'Archived','archived','/synthetic',4,5,5,0,0,0,0,0);
      INSERT INTO session_pending VALUES ('pending','root','{"text":"NOT_ADMITTED"}');`);
      const add = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
      add.run('user', 'root', 'user', 1, 100, 100, JSON.stringify({ text: 'First user' }));
      const assistant = { tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
        content: [{ type: 'reasoning', text: 'Inspect first' }, { type: 'text', text: 'Answer body' },
          { type: 'tool', id: 'call', name: 'read', state: { status: 'completed',
            input: { file: 'a' }, content: [{ type: 'text', text: 'result '.repeat(80) }] } }] };
      add.run('assistant', 'root', 'assistant', 2, 1, 1, JSON.stringify(assistant));
      add.run('compact', 'root', 'compaction', 3, 2, 2,
        JSON.stringify({ status: 'completed', summary: 'Saved summary' }));
      add.run('msg_forkevent_2', 'fork', 'assistant', 2, 1, 1, JSON.stringify(assistant));
      add.run('fork-own', 'fork', 'user', 6, 6, 6, JSON.stringify({ text: 'Fork owned' }));
    } else if (schema === 'v1') {
      db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT,
        directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT,
          time_created INTEGER);
        INSERT INTO session VALUES ('legacy',NULL,'Legacy','/synthetic',1,2,NULL);
        INSERT INTO message VALUES ('legacy-user','legacy','{"role":"user","time":{"created":1}}',1);
        INSERT INTO part VALUES ('legacy-part','legacy-user','legacy','{"type":"text","text":"Legacy body"}',1);`);
    } else {
      db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY)');
    }
  } finally {
    db.close();
  }
  const args = ['--opencode-db', file, '--codex-dir', path.join(dir, 'codex'),
    '--claude-dir', path.join(dir, 'claude'), '--pi-dir', path.join(dir, 'pi'),
    '--dsh-dir', path.join(dir, 'dsh'), '--meta-dir', path.join(dir, 'meta'),
    '--index-dir', path.join(dir, 'index'), '--cache-dir', path.join(dir, 'cache')];
  return { file, args };
}

async function serve(t, args) {
  const port = await freeFetchSafePort();
  const child = spawn(binary, ['serve', '--port', String(port), ...args],
    { cwd: repo, windowsHide: true, stdio: 'ignore' });
  onCleanup(t, async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(base + '/api/providers')).ok) return base; } catch { /* Startup. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('v3 server did not start');
}

test('OpenCode v2 Reader preserves source order, ownership, parent and fork identity',
  { timeout: 30_000 }, async t => {
    const f = await fixture(t, 'v2');
    const before = hash(f.file);
    const base = await serve(t, f.args);
    const providers = await (await fetch(base + '/api/providers')).json();
    assert.equal(providers.find(row => row.id === 'opencode').available, true);
    const sessions = await (await fetch(base + '/api/v3/sessions?provider=opencode')).json();
    assert.deepEqual(sessions.map(row => row.session.sessionId).sort(), ['child', 'fork', 'root']);
    assert.deepEqual(sessions.find(row => row.session.sessionId === 'child').parent,
      { provider: 'opencode', sessionId: 'root' });
    assert.equal(sessions.find(row => row.session.sessionId === 'fork').parent, null);
    assert.equal(sessions.find(row => row.session.sessionId === 'root').tokenCount, 21);
    const root = await (await fetch(base + '/api/v3/reader/opencode/root/bootstrap')).json();
    const items = root.segments.flatMap(segment => segment.items);
    assert.deepEqual(items.slice(0, 4).map(item => [item.event.messageId, item.event.segment]),
      [['user', 'message'], ['assistant:content:0', 'thinking'],
        ['assistant:content:1', 'message'], ['assistant:content:2', 'tool']]);
    assert.ok(items.some(item => item.event.messageId === 'compact'));
    assert.equal(JSON.stringify(root).includes('NOT_ADMITTED'), false);
    const fork = await (await fetch(base + '/api/v3/reader/opencode/fork/bootstrap')).json();
    assert.deepEqual(fork.segments.flatMap(segment => segment.items).map(item => item.event.messageId),
      ['fork-own']);
    assert.equal(fork.relations.observationCount, 1);
    const relations = await (await fetch(`${base}/api/v3/reader/opencode/fork/relations?cursor=${encodeURIComponent(fork.relations.firstCursor)}`)).json();
    assert.deepEqual(relations.entries[0].observation.fromSessionRef,
      { provider: 'opencode', sessionId: 'root' });
    assert.equal(hash(f.file), before);
  });

test('OpenCode v1 and unsupported schemas are selected from the source file',
  { timeout: 30_000 }, async t => {
    const legacy = await fixture(t, 'v1');
    const base = await serve(t, legacy.args);
    const read = await fetch(base + '/api/v3/reader/opencode/legacy/bootstrap');
    assert.equal(read.status, 200);
    assert.match(JSON.stringify(await read.json()), /Legacy body/);
    const invalid = await fixture(t, 'unsupported');
    const invalidBase = await serve(t, invalid.args);
    const providers = await (await fetch(invalidBase + '/api/providers')).json();
    const opencode = providers.find(row => row.id === 'opencode');
    assert.equal(opencode.available, false);
    assert.equal(opencode.storageDiagnostic.schema, 'unsupported');
    assert.match(opencode.storageDiagnostic.note, /schema/i);
  });

test('OpenCode v2 full tool and reasoning content requires explicit MCP opt-in',
  { timeout: 30_000 }, async t => {
    const f = await fixture(t, 'v2');
    const before = hash(f.file);
    const client = new Client({ name: 'opencode-slice', version: '1.0.0' });
    onCleanup(t, () => client.close());
    await client.connect(new StdioClientTransport({ command: binary,
      args: ['mcp', ...f.args], cwd: repo, stderr: 'pipe' }));
    const get = await client.callTool({ name: 'session_get', arguments: {
      session: { provider: 'opencode', sessionId: 'root' },
    } });
    assert.notEqual(get.isError, true);
    assert.deepEqual(get.structuredContent.result.children.map(row => row.session.sessionId), ['child']);
    const event = (messageId, segment) => ({ provider: 'opencode', sessionId: 'root',
      messageId, segment });
    const thinking = event('assistant:content:0', 'thinking');
    const denied = await client.callTool({ name: 'session_get_event', arguments: { event: thinking } });
    assert.equal(denied.isError, true);
    const allowed = await client.callTool({ name: 'session_get_event', arguments: {
      event: thinking, includeThinking: true,
    } });
    assert.equal(allowed.structuredContent.result.content.text, 'Inspect first');
    const tool = event('assistant:content:2', 'tool');
    const unexpanded = await client.callTool({ name: 'session_get_event', arguments: { event: tool } });
    assert.equal(unexpanded.structuredContent.result.toolOutput, null);
    let offset = 0;
    let output = '';
    do {
      const read = await client.callTool({ name: 'session_get_event', arguments: {
        event: tool, includeToolOutput: true, offset, maxChars: 80,
      } });
      assert.notEqual(read.isError, true);
      const page = read.structuredContent.result.toolOutput;
      output += page.text;
      offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(output, 'result '.repeat(80));
    assert.equal(hash(f.file), before);
  });

test('OpenCode v2 WAL updates become visible and invalidate an older Reader revision',
  { timeout: 30_000 }, async t => {
    const f = await fixture(t, 'v2');
    const db = new DatabaseSync(f.file);
    onCleanup(t, () => db.close());
    db.exec('PRAGMA journal_mode=WAL');
    const base = await serve(t, f.args);
    const old = await (await fetch(base + '/api/v3/reader/opencode/root/bootstrap')).json();
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run(
      'late', 'root', 'user', 7, 7, 7, JSON.stringify({ text: 'WAL visible' }));
    const fresh = await (await fetch(base + '/api/v3/reader/opencode/root/bootstrap')).json();
    assert.notEqual(fresh.revision, old.revision);
    assert.ok(fresh.segments.flatMap(segment => segment.items)
      .some(item => item.event.messageId === 'late' && item.preview === 'WAL visible'));
    const query = new URLSearchParams({ messageId: 'user', segment: 'message', field: 'body',
      offset: '0', maxChars: '80', revision: old.revision });
    const stale = await fetch(`${base}/api/v3/reader/opencode/root/content?${query}`);
    assert.equal(stale.status, 409);
  });

test('OpenCode Reader revision detects a same-metadata rollback-journal commit',
  { timeout: 30_000 }, async t => {
    const f = await fixture(t, 'v2');
    const base = await serve(t, f.args);
    utimesSync(f.file, 1700000000, 1700000000);
    const before = statSync(f.file, { bigint: true });
    const old = await (await fetch(base + '/api/v3/reader/opencode/root/bootstrap')).json();
    const db = new DatabaseSync(f.file);
    try {
      db.prepare('UPDATE session_message SET data=? WHERE id=?')
        .run(JSON.stringify({ text: 'Other user' }), 'user');
    } finally {
      db.close();
    }
    utimesSync(f.file, 1700000000, 1700000000);
    const after = statSync(f.file, { bigint: true });
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(after.birthtimeNs, before.birthtimeNs);
    const fresh = await (await fetch(base + '/api/v3/reader/opencode/root/bootstrap')).json();
    assert.notEqual(fresh.revision, old.revision);
    assert.ok(fresh.segments.flatMap(segment => segment.items)
      .some(item => item.event.messageId === 'user' && item.preview === 'Other user'));
  });

test('OpenCode Reader revision detects a same-metadata WAL commit',
  { timeout: 30_000 }, async t => {
    const f = await fixture(t, 'v2');
    const db = new DatabaseSync(f.file);
    onCleanup(t, () => db.close());
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    db.prepare('UPDATE session_message SET data=? WHERE id=?')
      .run(JSON.stringify({ text: 'First pass' }), 'user');
    const wal = `${f.file}-wal`;
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    truncateSync(wal, statSync(wal).size + pageSize + 24);
    utimesSync(wal, 1700000000, 1700000000);
    const before = statSync(wal, { bigint: true });
    const beforeDb = statSync(f.file, { bigint: true });
    const beforeDbHash = hash(f.file);
    const shm = `${f.file}-shm`;
    const beforeShmHeader = readFileSync(shm).subarray(0, 96);
    const base = await serve(t, f.args);
    const old = await (await fetch(base + '/api/v3/reader/opencode/root/bootstrap')).json();
    assert.equal(old.revision.length, 64);
    db.prepare('UPDATE session_message SET data=? WHERE id=?')
      .run(JSON.stringify({ text: 'Other user' }), 'user');
    utimesSync(wal, 1700000000, 1700000000);
    const after = statSync(wal, { bigint: true });
    const afterDb = statSync(f.file, { bigint: true });
    const afterDbHash = hash(f.file);
    const afterShmHeader = readFileSync(shm).subarray(0, 96);
    const fresh = await (await fetch(base + '/api/v3/reader/opencode/root/bootstrap')).json();
    assert.equal(afterDbHash, beforeDbHash, 'WAL commit leaves the main database untouched');
    assert.equal(afterDb.size, beforeDb.size);
    assert.equal(afterDb.mtimeNs, beforeDb.mtimeNs);
    assert.equal(afterDb.birthtimeNs, beforeDb.birthtimeNs);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(after.birthtimeNs, before.birthtimeNs);
    assert.notDeepEqual(afterShmHeader, beforeShmHeader, 'committed WAL-index header changes');
    assert.notEqual(fresh.revision, old.revision);
    assert.ok(fresh.segments.flatMap(segment => segment.items)
      .some(item => item.event.messageId === 'user' && item.preview === 'Other user'));
  });

test('OpenCode Reader opens a copied WAL database before a WAL-index sidecar exists',
  { timeout: 30_000 }, async t => {
    const f = await fixture(t, 'v2');
    const copy = `${f.file}.copy`;
    const db = new DatabaseSync(f.file);
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
      db.prepare('UPDATE session_message SET data=? WHERE id=?')
        .run(JSON.stringify({ text: 'WAL copy' }), 'user');
      copyFileSync(f.file, copy);
      copyFileSync(`${f.file}-wal`, `${copy}-wal`);
    } finally {
      db.close();
    }
    const args = [...f.args];
    args[args.indexOf('--opencode-db') + 1] = copy;
    const base = await serve(t, args);
    const response = await fetch(base + '/api/v3/reader/opencode/root/bootstrap');
    assert.equal(response.status, 200);
    const reader = await response.json();
    assert.ok(reader.segments.flatMap(segment => segment.items)
      .some(item => item.event.messageId === 'user' && item.preview === 'WAL copy'));
  });

test('frozen private OpenCode v2 copy remains byte-identical across Web and MCP reads',
  { timeout: 45_000, skip: !process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST }, async t => {
    const manifest = JSON.parse(readFileSync(process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST));
    const database = manifest.database;
    const target = manifest.captureTargets.find(row => row.provider === 'opencode');
    assert.equal(hash(database.snapshotPath), database.snapshotSha256);
    const f = await fixture(t, 'unsupported');
    const args = [...f.args];
    args[args.indexOf('--opencode-db') + 1] = database.snapshotPath;
    const base = await serve(t, args);
    const sessions = await (await fetch(base + '/api/v3/sessions?provider=opencode')).json();
    assert.equal(sessions.length, database.knownFacts.sessions);
    const reader = await fetch(`${base}/api/v3/reader/opencode/${target.sessionId}/bootstrap`);
    assert.equal(reader.status, 200);
    assert.ok((await reader.json()).totalItems > 0);
    const client = new Client({ name: 'opencode-private-slice', version: '1.0.0' });
    onCleanup(t, () => client.close());
    await client.connect(new StdioClientTransport({ command: binary,
      args: ['mcp', ...args], cwd: repo, stderr: 'pipe' }));
    const get = await client.callTool({ name: 'session_get', arguments: {
      session: { provider: 'opencode', sessionId: target.sessionId },
    } });
    assert.notEqual(get.isError, true);
    assert.ok(get.structuredContent.result.messageCount > 0);
    assert.equal(hash(database.snapshotPath), database.snapshotSha256);
  });
