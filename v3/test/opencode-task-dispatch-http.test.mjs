import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const fixturePath = path.join(repo, 'test', 'fixtures', 'opencode-native-v3-synthetic.jsonl');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

test('OpenCode task dispatch anchors only the canonical recorded child', { timeout: 60_000 }, async t => {
  const sourceHash = hash(fixturePath);
  const records = readFileSync(fixturePath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const parts = records.filter(row => ['p-exact', 'p-missing', 'p-mismatch'].includes(row.id));
  assert.deepEqual(parts.map(row => row.id), ['p-exact', 'p-missing', 'p-mismatch']);
  await mkdir(path.join(repo, 'tmp'), { recursive: true });
  const root = await mkdtemp(path.join(repo, 'tmp', 'v3-opencode-dispatch-'));
  let process;
  t.after(async () => {
    process?.kill();
    if (process?.exitCode === null) await once(process, 'close');
    await rm(root, { recursive: true, force: true });
  });
  const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']
    .map(name => [name, path.join(root, name)]));
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
  const dbPath = path.join(root, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT,
    directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT,
    time_created INTEGER);`);
  const addSession = db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?)');
  addSession.run('oc-v3-root', null, 'Root', '/synthetic', 100, 500, null);
  addSession.run('oc-v3-child', 'oc-v3-root', 'Child', '/synthetic', 301, 500, null);
  addSession.run('oc-v3-other', 'different-root', 'Other', '/synthetic', 305, 500, null);
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m-tools', 'oc-v3-root',
    JSON.stringify({ role: 'assistant', time: { created: 300 } }), 300);
  const addPart = db.prepare('INSERT INTO part VALUES (?,?,?,?,?)');
  for (const part of parts) addPart.run(part.id, part.message_id, 'oc-v3-root', JSON.stringify(part),
    part.state.time.start);
  db.close();
  const dbHash = hash(dbPath);
  const port = await freeFetchSafePort();
  const args = ['serve', '--port', String(port), '--opencode-db', dbPath,
    '--codex-dir', dirs.codex, '--claude-dir', dirs.claude, '--pi-dir', dirs.pi,
    '--dsh-dir', dirs.dsh, '--meta-dir', dirs.meta, '--index-dir', dirs.index,
    '--cache-dir', dirs.cache];
  process = spawn(binary, args, { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  process.stderr.on('data', data => { stderr += data.toString(); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/providers')).ok) { ready = true; break; } } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, stderr.slice(0, 500));
  const get = async route => {
    const response = await fetch(base + route);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  const doc = await get('/api/v3/protocol/opencode/oc-v3-root?version=3');
  assert.equal(doc.validation.ok, true);
  assert.deepEqual(doc.tasks.map(task => task.id), ['task:p-exact', 'task:p-missing', 'task:p-mismatch']);
  assert.ok(doc.tasks.every(task => task.status === 'unknown'));
  assert.equal(doc.coverage.tasks.state, 'observed');
  assert.equal(doc.coverage.coordination.state, 'observed');
  assert.deepEqual(doc.coordination.map(item => [item.kind, item.state, item.toSessionRef?.sessionId || null]), [
    ['spawn', 'started', 'oc-v3-child'], ['delegate', 'requested', null],
    ['delegate', 'requested', null],
  ]);
  assert.deepEqual(doc.coordination.map(item => item.correlationId),
    ['call-exact', 'call-missing', 'call-mismatch']);
  const spawned = doc.relationships.filter(relation => relation.kind === 'spawned');
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].to, { provider: 'opencode', sessionId: 'oc-v3-child' });
  assert.equal(spawned[0].correlationId, 'call-exact');
  assert.equal(spawned[0].evidence.eventId, 'event:opencode:v1:part:p-exact');
  assert.deepEqual(spawned[0].evidence.provenance, {
    fidelity: 'recorded', sourceType: 'opencode.part.tool+session.parent_id', sourceId: 'p-exact',
  });
  assert.deepEqual(doc.agentRuns, []);
  const bootstrap = await get('/api/v3/reader/opencode/oc-v3-root/bootstrap');
  const relations = await get(`/api/v3/reader/opencode/oc-v3-root/relations?cursor=${encodeURIComponent(bootstrap.relations.firstCursor)}`);
  assert.deepEqual(relations.childPlacements.map(item => item.child.sessionId), ['oc-v3-child']);
  assert.deepEqual(relations.childPlacements[0].afterEvent, {
    provider: 'opencode', sessionId: 'oc-v3-root', messageId: 'm-tools:p-exact', segment: 'tool',
  });
  const graph = await get('/api/v3/runtime/opencode/oc-v3-root/graph?maxNodes=20');
  assert.equal(graph.edges.filter(edge => edge.type === 'spawned').length, 1);
  assert.equal(hash(dbPath), dbHash);
  assert.equal(hash(fixturePath), sourceHash);
});
