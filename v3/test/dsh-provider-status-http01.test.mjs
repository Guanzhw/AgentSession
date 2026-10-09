import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const v3Binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const sqliteHeader = Buffer.from('SQLite format 3\0');

async function freePort() {
  return freeFetchSafePort();
}

async function startServer(command, args, env) {
  const port = await freePort();
  const child = spawn(command, [...args, '--port', String(port)], {
    cwd: repo, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const origin = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close');
    child.kill();
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 2_000))]);
  };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${origin}/api/providers`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { origin, child, stop };
    } catch { /* server starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await stop();
  throw new Error(`Provider service did not start: ${stderr}`);
}

async function getJson(origin, pathname) {
  const response = await fetch(new URL(pathname, origin));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function sourceSnapshot(root) {
  const files = [];
  async function visit(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const childRelative = path.join(relative, entry.name);
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(child, childRelative);
      } else if (entry.isFile()) {
        const contents = await readFile(child);
        files.push([childRelative, createHash('sha256').update(contents).digest('hex')]);
      }
    }
  }
  await visit(root);
  return Object.fromEntries(files.sort(([left], [right]) => left.localeCompare(right)));
}

function unsupportedSqliteDiagnostic(filePath) {
  return {
    backend: 'sqlite',
    status: 'unsupported',
    path: filePath,
    detectedSchema: null,
    expectedSchema: 17,
    message: `Legacy DeepSeek Harness SQLite persistence was detected at ${filePath}, but AgentSession does not inspect or migrate that database. The current reader supports JSONL; schema 17 remains documented for existing stores.`
  };
}

async function makeScenario(root, name) {
  const work = path.join(root, name);
  const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta-v3',
    'index-v3', 'cache-v3'].map(key => [key, path.join(work, key)]));
  await Promise.all(Object.values(dirs).map(directory => mkdir(directory, { recursive: true })));
  const sqlitePath = path.join(dirs.dsh, 'sessions.sqlite');
  const tracked = [];
  if (name === 'bad-marker') {
    await writeFile(sqlitePath, 'not an SQLite database');
    tracked.push(sqlitePath);
  } else if (name === 'sqlite-only' || name === 'jsonl-and-sqlite') {
    await writeFile(sqlitePath, Buffer.concat([sqliteHeader, Buffer.from('opaque database bytes')]));
    tracked.push(sqlitePath);
  }
  if (name === 'jsonl-and-sqlite') {
    const jsonlPath = path.join(dirs.dsh, 'sessions', 'project', 'jsonl-only-id', 'session.v3.jsonl');
    await mkdir(path.dirname(jsonlPath), { recursive: true });
    await writeFile(jsonlPath, [
      { type: 'session', version: 3, id: 'jsonl-only-id', createdAt: 1000, isSeeded: false, delegationDepth: 0 },
      { type: 'user/message', seq: 0, time: 2000, surfaceOp: 'append',
        data: { id: 'user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'recorded JSONL session' }] } }
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    tracked.push(jsonlPath);
  }
  const dbPath = path.join(work, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT,
    fork_boundary TEXT, title TEXT, directory TEXT, time_created INTEGER,
    time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
    tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
    time_created INTEGER, time_updated INTEGER, data TEXT);`);
  db.close();
  const args = ['--opencode-db', dbPath, '--codex-dir', dirs.codex, '--claude-dir', dirs.claude,
    '--pi-dir', dirs.pi, '--dsh-dir', dirs.dsh];
  const v3Env = { ...process.env, CODEX_HOME: dirs.codex, PI_CODING_AGENT_DIR: dirs.pi,
    CLAUDE_CONFIG_DIR: dirs.claude, DSH_HOME: dirs.dsh };
  delete v3Env.AGENTSESSION_CONFIG;
  const v3Args = ['serve', ...args, '--meta-dir', dirs['meta-v3'], '--index-dir', dirs['index-v3'],
    '--cache-dir', dirs['cache-v3']];
  return { dshRoot: dirs.dsh, v3Args, v3Env, tracked };
}

test('HTTP-01 DSH status detects SQLite markers and reads only supported JSONL sessions',
  { timeout: 120_000 }, async t => {
    const scratch = path.join(repo, 'tmp');
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(path.join(scratch, 'v3-dsh-provider-status-http01-'));
    t.after(async () => {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(scratch));
      assert.ok(path.basename(root).startsWith('v3-dsh-provider-status-http01-'));
      await rm(root, { recursive: true, force: true });
    });

    for (const [name, expectedAvailable, hasJsonl] of [
      ['empty', false, false],
      ['sqlite-only', true, false],
      ['bad-marker', false, false],
      ['jsonl-and-sqlite', true, true]
    ]) {
      await t.test(name, async () => {
        const scenario = await makeScenario(root, name);
        const before = await sourceSnapshot(scenario.dshRoot);
        let v3;
        try {
          v3 = await startServer(v3Binary, scenario.v3Args, scenario.v3Env);
          const v3Providers = await getJson(v3.origin, '/api/providers');
          const v3Dsh = v3Providers.find(row => row.id === 'deepseek-harness');
          assert.ok(v3Dsh, '3.0 DSH provider descriptor');
          assert.equal(v3Dsh.available, expectedAvailable);

          const expectedDiagnostic = name === 'sqlite-only' || name === 'jsonl-and-sqlite'
            ? unsupportedSqliteDiagnostic(path.join(scenario.dshRoot, 'sessions.sqlite'))
            : null;
          assert.deepEqual(v3Dsh.storageDiagnostic, expectedDiagnostic);
          if (expectedDiagnostic) {
            assert.deepEqual(Object.keys(v3Dsh.storageDiagnostic).sort(),
              ['backend', 'detectedSchema', 'expectedSchema', 'message', 'path', 'status']);
          }

          if (expectedAvailable) {
            const [globalSessions, v3Sessions] = await Promise.all([
              getJson(v3.origin, '/api/sessions?provider=deepseek-harness'),
              getJson(v3.origin, '/api/deepseek-harness/sessions')
            ]);
            for (const sessions of [globalSessions, v3Sessions]) {
              assert.equal(sessions.total, hasJsonl ? 1 : 0);
              assert.equal(sessions.sessions.length, hasJsonl ? 1 : 0);
            }
            if (hasJsonl) {
              assert.ok(JSON.stringify(v3Sessions).includes('jsonl-only-id'));
              assert.ok(JSON.stringify(globalSessions).includes('jsonl-only-id'));
            }
          }
        } finally {
          await v3?.stop();
        }
        assert.deepEqual(await sourceSnapshot(scenario.dshRoot), before,
          'provider source files are unchanged and no provider files were added');
        assert.deepEqual(Object.keys(before).sort(), scenario.tracked.map(file =>
          path.relative(scenario.dshRoot, file)).sort());
      });
    }
  });
