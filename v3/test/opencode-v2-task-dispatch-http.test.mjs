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

function assertCapability(actual, expected, message) {
  const { details, ...shape } = actual;
  assert.deepEqual(shape, expected, message);
  if (expected.support !== 'none')
    assert.ok(typeof details === 'string' && details.length > 0,
      message || 'supported capability includes source detail');
}

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const fixturePath = path.join(repo, 'v3', 'fixtures', 'opencode', 'v2-task-parts.json');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

test('OpenCode v2 task dispatch anchors only a verified canonical child', { timeout: 60_000 }, async t => {
  const fixtureHash = hash(fixturePath);
  const parts = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.deepEqual(parts.map(part => part.id),
    ['call-exact', 'call-no-parent', 'call-error', 'call-other', 'call-parent']);
  const root = await mkdtemp(path.join(repo, 'tmp', 'v3-opencode-v2-task-'));
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
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT,
    fork_boundary TEXT, title TEXT, slug TEXT, directory TEXT, time_created INTEGER,
    time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
    tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
    time_created INTEGER, time_updated INTEGER, data TEXT);`);
  const addSession = db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  addSession.run('oc-v2-root', null, null, null, 'Root', 'root', '/synthetic', 100, 500, null, 0, 0, 0, 0, 0);
  addSession.run('oc-v2-child', 'oc-v2-root', null, null, 'Child', 'child', '/synthetic', 301, 500, null, 0, 0, 0, 0, 0);
  addSession.run('oc-v2-child-2', 'oc-v2-root', null, null, 'Second child', 'second', '/synthetic', 315, 500, null, 0, 0, 0, 0, 0);
  addSession.run('oc-v2-other', 'different-root', null, null, 'Other', 'other', '/synthetic', 305, 500, null, 0, 0, 0, 0, 0);
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run('m-v2', 'oc-v2-root', 'assistant',
    1, 300, 350, JSON.stringify({ content: parts }));
  db.close();
  const dbHash = hash(dbPath);
  const port = await freeFetchSafePort();
  process = spawn(binary, ['serve', '--port', String(port), '--opencode-db', dbPath,
    '--codex-dir', dirs.codex, '--claude-dir', dirs.claude, '--pi-dir', dirs.pi,
    '--dsh-dir', dirs.dsh, '--meta-dir', dirs.meta, '--index-dir', dirs.index,
    '--cache-dir', dirs.cache], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const providers = await get('/api/providers');
  assertCapability(providers.find(provider => provider.id === 'opencode').protocolCapabilities.tasks,
    { support: 'partial', provenance: 'recorded' });
  const doc = await get('/api/v3/protocol/opencode/oc-v2-root?version=3');
  assert.equal(doc.validation.ok, true);
  assert.deepEqual(doc.tasks.map(task => task.id),
    ['task:m-v2:content:0', 'task:m-v2:content:1', 'task:m-v2:content:2',
      'task:m-v2:content:3', 'task:m-v2:content:4']);
  assert.ok(doc.tasks.every(task => task.status === 'unknown'));
  assert.deepEqual(doc.coordination.map(item => [item.kind, item.state, item.toSessionRef?.sessionId || null]), [
    ['spawn', 'started', 'oc-v2-child'], ['spawn', 'started', 'oc-v2-child-2'],
    ['delegate', 'requested', null],
    ['delegate', 'requested', null], ['delegate', 'requested', null],
  ]);
  assert.deepEqual(doc.coordination.map(item => item.correlationId),
    ['call-exact', 'call-no-parent', 'call-error', 'call-other', 'call-parent']);
  const spawned = doc.relationships.filter(relation => relation.kind === 'spawned');
  assert.equal(spawned.length, 2);
  assert.deepEqual(spawned[0].to, { provider: 'opencode', sessionId: 'oc-v2-child' });
  assert.deepEqual(spawned[1].to, { provider: 'opencode', sessionId: 'oc-v2-child-2' });
  assert.equal(spawned[0].evidence.eventId, 'event:opencode:v2:m-v2:content:0');
  assert.deepEqual(spawned[0].evidence.provenance, {
    fidelity: 'recorded', sourceType: 'opencode.session_message.content.tool+session_v2.parent_id',
    sourceId: 'm-v2',
  });
  assert.deepEqual(doc.agentRuns, []);
  const bootstrap = await get('/api/v3/reader/opencode/oc-v2-root/bootstrap');
  const relations = await get(`/api/v3/reader/opencode/oc-v2-root/relations?cursor=${encodeURIComponent(bootstrap.relations.firstCursor)}`);
  assert.equal(relations.entries[0].observation.provenance.sourceId, 'm-v2');
  assert.deepEqual(relations.childPlacements.map(item => item.child.sessionId),
    ['oc-v2-child', 'oc-v2-child-2']);
  assert.deepEqual(relations.childPlacements[0].afterEvent, {
    provider: 'opencode', sessionId: 'oc-v2-root', messageId: 'm-v2:content:0', segment: 'tool',
  });
  assert.deepEqual(relations.childPlacements[1].afterEvent, {
    provider: 'opencode', sessionId: 'oc-v2-root', messageId: 'm-v2:content:1', segment: 'tool',
  });
  const graph = await get('/api/v3/runtime/opencode/oc-v2-root/graph?maxNodes=20');
  assert.equal(graph.edges.filter(edge => edge.type === 'spawned').length, 2);
  assert.equal(hash(dbPath), dbHash);
  assert.equal(hash(fixturePath), fixtureHash);
});
