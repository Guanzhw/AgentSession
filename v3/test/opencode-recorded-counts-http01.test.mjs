import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const v3Binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

async function freePort() {
  return freeFetchSafePort();
}

async function ready(child, base, stderr) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null)
      assert.fail(`server exited: ${stderr()}`);
    try { if ((await fetch(base + '/api/providers')).ok) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`server did not become ready: ${stderr()}`);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill();
  await closed;
}

async function counts(base, route) {
  const response = await fetch(base + route);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.ok(body.sessions.length > 0, `empty session list: ${base}${route} ${JSON.stringify(body)}`);
  return Object.fromEntries(body.sessions.map(row => [row.id,
    [row.summary_files, row.summary_additions, row.summary_deletions]]));
}

test('HTTP-01 OpenCode recorded file-change counts survive normalized list persistence',
  { timeout: 60_000 }, async t => {
    await mkdir(path.join(repo, 'tmp'), { recursive: true });
    const work = await mkdtemp(path.join(repo, 'tmp', 'v3-opencode-counts-http01-'));
    const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh',
      'meta-v3', 'index-v3', 'cache-v3'].map(name => [name, path.join(work, name)]));
    await Promise.all(Object.values(dirs).map(dir => mkdir(dir, { recursive: true })));
    const source = path.join(work, 'opencode.db');
    const db = new DatabaseSync(source);
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT,
      title TEXT, slug TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER,
      time_archived INTEGER, summary_additions INTEGER, summary_deletions INTEGER,
      summary_files INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT,
        time_created INTEGER);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
        data TEXT, time_created INTEGER);`);
    const insert = db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    insert.run('recorded', null, 'project', 'Recorded', 'recorded', '/synthetic',
      100, 300, null, 12, 4, 3);
    insert.run('zero', null, 'project', 'Zero', 'zero', '/synthetic',
      100, 200, null, 0, 0, 0);
    insert.run('unknown', null, 'project', 'Unknown', 'unknown', '/synthetic',
      100, 100, null, null, null, null);
    db.close();
    const before = hash(source);
    t.diagnostic(`opencode_v1_source_sha256=${before}`);
    const v3Port = await freePort();
    const v3Base = `http://127.0.0.1:${v3Port}`;
    const common = ['--opencode-db', source, '--codex-dir', dirs.codex,
      '--claude-dir', dirs.claude, '--pi-dir', dirs.pi, '--dsh-dir', dirs.dsh];
    const v3Args = ['serve', '--port', String(v3Port), ...common,
      '--meta-dir', dirs['meta-v3'], '--index-dir', dirs['index-v3'],
      '--cache-dir', dirs['cache-v3']];
    const spawnV3 = () => spawn(v3Binary, v3Args,
      { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let v3 = spawnV3();
    let v3Error = '';
    v3.stderr.on('data', chunk => { v3Error += chunk; });
    t.after(async () => {
      await stop(v3);
      assert.equal(hash(source), before, 'provider-owned SQLite bytes stay unchanged');
      await rm(work, { recursive: true, force: true });
    });
    await ready(v3, v3Base, () => v3Error);
    const sourceRoute = '/api/opencode/sessions?limit=10';
    // Match the session table's recorded files/additions/deletions, including
    // explicit zero and unavailable source values.
    const expected = { recorded: [3, 12, 4], zero: [0, 0, 0],
      unknown: [null, null, null] };
    const globalRoute = '/api/sessions?provider=opencode&limit=10';
    for (const route of [sourceRoute, globalRoute]) {
      assert.deepEqual(await counts(v3Base, route), expected, `3.0 recorded counts: ${route}`);
    }
    await stop(v3);
    v3 = spawnV3();
    v3.stderr.on('data', chunk => { v3Error += chunk; });
    await ready(v3, v3Base, () => v3Error);
    for (const route of [sourceRoute, globalRoute]) {
      assert.deepEqual(await counts(v3Base, route), expected,
        `recorded counts persist through a fresh process and catalog reload: ${route}`);
    }
  });
