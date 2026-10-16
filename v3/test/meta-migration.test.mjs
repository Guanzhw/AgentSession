import { onCleanup, temporaryDirectory } from '../../test/helpers/fixture-cleanup.mjs';
import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = path.resolve(import.meta.dirname, '../..');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const fixture = path.join(repo, 'test', 'fixtures', 'v3-source-scope');
const id = '11111111-1111-4111-8111-111111111111';
const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex');

function paths(dir, side) {
  return ['--codex-dir', path.join(fixture, side), '--opencode-db', path.join(dir, 'missing.db'),
    '--claude-dir', path.join(dir, 'claude'), '--pi-dir', path.join(dir, 'pi'),
    '--dsh-dir', path.join(dir, 'dsh'), '--meta-dir', path.join(dir, 'meta'),
    '--index-dir', path.join(dir, 'index'), '--cache-dir', path.join(dir, 'cache')];
}

function cli(args) {
  return spawnSync(binary, args, { cwd: repo, encoding: 'utf8', windowsHide: true });
}

async function freePort() {
  return freeFetchSafePort();
}

async function serve(t, args) {
  const port = await freePort();
  const child = spawn(binary, ['serve', '--port', String(port), ...args],
    { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  onCleanup(t, async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      let timer;
      try {
        await Promise.race([closed, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('metadata test server failed to stop')), 3000);
        })]);
      } finally {
        clearTimeout(timer);
      }
    }
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${await new Response(child.stderr).text()}`);
    try { if ((await fetch(`${base}/api/providers`)).ok) return base; }
    catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server failed to start');
}

test('explicit metadata import preserves the 2.0 database and isolates 3.0 scopes',
  { timeout: 45_000 }, async t => {
    assert.ok(existsSync(binary), `Build ${binary} first`);
    const dir = await temporaryDirectory(t, path.join(os.tmpdir(), 'v3-meta-migration-'));
    await mkdir(path.join(dir, 'meta'), { recursive: true });
    const old = path.join(dir, 'meta', 'meta.db');
    const db = new DatabaseSync(old);
    try {
      db.exec(`CREATE TABLE session_meta (provider TEXT NOT NULL DEFAULT 'opencode',
        session_id TEXT NOT NULL, custom_title TEXT, starred INTEGER DEFAULT 0,
        deleted INTEGER DEFAULT 0, permanent INTEGER DEFAULT 0, time_starred INTEGER,
        time_deleted INTEGER, time_renamed INTEGER, PRIMARY KEY(provider,session_id));
        CREATE TABLE session_index (provider TEXT NOT NULL, id TEXT NOT NULL, title TEXT);`);
      db.prepare('INSERT INTO session_meta(provider,session_id,custom_title,starred,deleted,time_deleted) VALUES (?,?,?,?,?,?)')
        .run('codex', id, 'Migrated title', 1, 1, 123456789);
      db.prepare('INSERT INTO session_meta(provider,session_id,custom_title) VALUES (?,?,?)')
        .run('hermes', id, 'Retired row');
      db.prepare('INSERT INTO session_index VALUES (?,?,?)').run('hermes', id, 'Retired index');
    } finally {
      db.close();
    }
    const before = await sha(old);
    const left = paths(dir, 'left');
    const right = paths(dir, 'right');
    const leftWeb = await serve(t, left);
    const rightWeb = await serve(t, right);
    const list = base => fetch(`${base}/api/v3/sessions?provider=codex`).then(response => response.json());
    assert.equal((await list(leftWeb)).find(row => row.session.sessionId === id)?.title, 'shared session question');
    assert.equal((await list(rightWeb)).find(row => row.session.sessionId === id)?.title, 'shared session question');

    const migration = cli(['migrate-meta', '--from', old, ...left]);
    assert.equal(migration.status, 0, migration.stderr);
    const target = path.join(dir, 'meta', 'scopes', migration.stdout.trim(), 'meta.db');
    assert.ok(existsSync(target));
    assert.equal((await list(leftWeb)).some(row => row.session.sessionId === id), false);
    assert.equal((await list(rightWeb)).find(row => row.session.sessionId === id)?.title, 'shared session question');
    const meta = await (await fetch(`${leftWeb}/api/v3/meta?provider=codex`)).json();
    assert.deepEqual([meta.find(row => row.sessionId === id)?.customTitle,
      meta.find(row => row.sessionId === id)?.starred,
      meta.find(row => row.sessionId === id)?.deleted], ['Migrated title', true, true]);
    const copied = new DatabaseSync(target, { readOnly: true });
    try {
      assert.equal(copied.prepare("SELECT custom_title FROM session_meta WHERE provider='hermes'").get().custom_title,
        'Retired row');
      assert.equal(copied.prepare("SELECT title FROM session_index WHERE provider='hermes'").get().title,
        'Retired index');
    } finally {
      copied.close();
    }
    const client = new Client({ name: 'migration-test', version: '1' });
    onCleanup(t, () => client.close());
    await client.connect(new StdioClientTransport({ command: binary,
      args: ['mcp', ...left], cwd: repo, stderr: 'pipe' }));
    const result = await client.callTool({ name: 'session_get', arguments: {
      session: { provider: 'codex', sessionId: id },
    } });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.result.session.sessionId, id);
    assert.equal(await sha(old), before);

    const changed = await fetch(`${leftWeb}/api/codex/session/${id}/rename`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: leftWeb },
      body: JSON.stringify({ title: 'Local 3.0 title' }),
    });
    assert.equal(changed.status, 200);
    const targetHash = await sha(target);
    const repeated = cli(['migrate-meta', '--from', old, ...left]);
    assert.notEqual(repeated.status, 0);
    assert.match(repeated.stderr, /already exists/i);
    assert.equal(await sha(target), targetHash);
    assert.equal((await fetch(`${leftWeb}/api/v3/meta?provider=codex`).then(response => response.json()))
      .find(row => row.sessionId === id)?.customTitle, 'Local 3.0 title');
    assert.deepEqual(await readdir(path.dirname(target)), ['meta.db']);
    assert.equal(await sha(old), before);
    const rightMigration = cli(['migrate-meta', '--from', old, ...right]);
    assert.equal(rightMigration.status, 0, rightMigration.stderr);
    assert.notEqual(rightMigration.stdout.trim(), migration.stdout.trim());
    assert.equal((await list(rightWeb)).some(row => row.session.sessionId === id), false);
    assert.equal(await sha(old), before);
  });

test('metadata import rejects an incompatible source without publishing a target', async t => {
  const dir = await temporaryDirectory(t, path.join(os.tmpdir(), 'v3-meta-invalid-'));
  const old = path.join(dir, 'old.db');
  const db = new DatabaseSync(old);
  try {
    db.exec('CREATE TABLE session_meta (session_id TEXT PRIMARY KEY, starred INTEGER)');
  } finally {
    db.close();
  }
  const before = await sha(old);
  const result = cli(['migrate-meta', '--from', old, ...paths(dir, 'left')]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /schema is incompatible/i);
  assert.equal(await sha(old), before);
  assert.equal(existsSync(path.join(dir, 'meta', 'scopes')), false);
});

test('metadata import includes committed WAL rows while leaving the live source bytes intact', async t => {
  const dir = await temporaryDirectory(t, path.join(os.tmpdir(), 'v3-meta-wal-'));
  const old = path.join(dir, 'old.db');
  const source = new DatabaseSync(old);
  onCleanup(t, () => source.close());
  source.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session_meta (provider TEXT NOT NULL, session_id TEXT NOT NULL,
      custom_title TEXT, starred INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0,
      permanent INTEGER DEFAULT 0, time_starred INTEGER, time_deleted INTEGER,
      time_renamed INTEGER, PRIMARY KEY(provider,session_id));`);
  source.prepare('INSERT INTO session_meta(provider,session_id,custom_title) VALUES (?,?,?)')
    .run('codex', id, 'WAL title');
  const mainHash = await sha(old);
  const walHash = await sha(`${old}-wal`);
  const result = cli(['migrate-meta', '--from', old, ...paths(dir, 'left')]);
  assert.equal(result.status, 0, result.stderr);
  const target = path.join(dir, 'meta', 'scopes', result.stdout.trim(), 'meta.db');
  const imported = new DatabaseSync(target, { readOnly: true });
  try {
    assert.equal(imported.prepare('SELECT custom_title FROM session_meta WHERE provider=? AND session_id=?')
      .get('codex', id).custom_title, 'WAL title');
  } finally {
    imported.close();
  }
  assert.equal(await sha(old), mainHash);
  assert.equal(await sha(`${old}-wal`), walHash);
  assert.deepEqual(await readdir(path.dirname(target)), ['meta.db']);
});
