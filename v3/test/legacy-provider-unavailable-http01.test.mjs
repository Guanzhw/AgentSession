import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const v3Binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');

function hash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function freePort() {
  return freeFetchSafePort();
}

async function waitForApi(child, base, label, stderr) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(label + ' exited before HTTP readiness: ' + stderr());
    }
    try {
      const response = await fetch(base + '/api/providers', {
        signal: AbortSignal.timeout(500)
      });
      if (response.ok) return;
    } catch {
      // The loopback server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(label + ' did not become ready: ' + stderr());
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill();
  await closed;
}

async function jsonGet(base, route) {
  const response = await fetch(base + route);
  return { status: response.status, body: await response.json() };
}

test('HTTP-01 unavailable provider list reports the missing source explicitly',
  { timeout: 60_000 }, async t => {
    const scratch = path.join(repo, 'tmp');
    await mkdir(scratch, { recursive: true });
    const work = await mkdtemp(path.join(scratch, 'v3-provider-unavailable-http01-'));
    const dirs = Object.fromEntries([
      'claude', 'pi', 'dsh', 'meta-v3', 'index-v3', 'cache-v3'
    ].map(name => [name, path.join(work, name)]));
    await Promise.all(Object.values(dirs).map(dir => mkdir(dir, { recursive: true })));

    const codexRoot = path.join(work, 'codex-missing');
    const codexSessions = path.join(codexRoot, 'sessions');
    const opencodeDb = path.join(work, 'opencode.db');
    const db = new DatabaseSync(opencodeDb);
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT,
      fork_boundary TEXT, title TEXT, slug TEXT, directory TEXT, time_created INTEGER,
      time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
      tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT);`);
    db.close();
    const sourceHash = hash(opencodeDb);

    const v3Port = await freePort();
    const v3 = spawn(v3Binary, [
      'serve', '--port', String(v3Port), '--opencode-db', opencodeDb,
      '--codex-dir', codexRoot, '--claude-dir', dirs.claude, '--pi-dir', dirs.pi,
      '--dsh-dir', dirs.dsh, '--meta-dir', dirs['meta-v3'],
      '--index-dir', dirs['index-v3'], '--cache-dir', dirs['cache-v3']
    ], { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let v3Stderr = '';
    v3.stderr.on('data', data => { v3Stderr += data.toString(); });
    const v3Base = `http://127.0.0.1:${v3Port}`;

    t.after(async () => {
      try {
        await stop(v3);
        assert.equal(hash(opencodeDb), sourceHash, 'provider-owned OpenCode database stays unchanged');
        assert.equal(existsSync(codexRoot), false, 'the missing Codex source root stays missing');
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    });

    await waitForApi(v3, v3Base, '3.0 Viewer', () => v3Stderr);

    const v3Unavailable = await jsonGet(v3Base, '/api/codex/sessions');
    const expected = {
      ok: false,
      error: 'Provider not detected',
      provider: 'codex',
      name: 'Codex CLI',
      dataPath: codexSessions
    };
    assert.equal(v3Unavailable.status, 503, JSON.stringify(v3Unavailable.body));
    assert.deepEqual(v3Unavailable.body, expected);

    const v3Unknown = await jsonGet(v3Base, '/api/unknown-provider/sessions');
    assert.equal(v3Unknown.status, 404);

    const v3Global = await jsonGet(v3Base, '/api/sessions?provider=codex');
    assert.equal(v3Global.status, 200);
    assert.deepEqual(v3Global.body.sessions, []);
    assert.equal(v3Global.body.total, 0);
  });
