import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import test from 'node:test';
import { closeDb } from '../dist/src/db.js';
import { initConfig } from '../dist/src/config.js';
import adapter from '../dist/src/providers/opencode/adapter.js';
import { createOpenCodeV2Adapter } from '../dist/src/providers/opencode/v2-adapter.js';
import { inspectOpenCodeStorage, openCodeStorageRevision } from '../dist/src/providers/opencode/storage.js';
import { buildAgentLoop } from '../dist/src/providers/shared/agent-loop.js';
import { renderInheritedContextPage, renderSessionReaderPane } from '../dist/src/views/session.js';

// DDL matches the relevant columns reported by the user's v2.0.10 database.
// Payloads follow anomalyco/opencode v2.0.10 session-message.ts and sql.ts.
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentsession-v2-'));
  const file = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, fork_session_id TEXT,
    fork_boundary TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER,
    tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0, tokens_reasoning INTEGER DEFAULT 0,
    tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0,
    cost REAL DEFAULT 0, agent TEXT, model TEXT, idle_outcome TEXT
  ); CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
  ); CREATE TABLE session_pending (id TEXT, session_id TEXT, type TEXT, data TEXT);
  INSERT INTO session_pending VALUES ('pending', 'root', 'user', '{"text":"NOT_ADMITTED"}');`);
  const now = Date.now();
  const addSession = (id, parent = null, fork = null, archived = null) => db.prepare(`INSERT INTO session_v2
    (id,project_id,parent_id,fork_session_id,fork_boundary,slug,directory,title,time_created,time_updated,time_archived,
     tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,tokens_cache_write)
    VALUES (?,?,?,?,?,'slug','/workspace',?,?,?, ?,10,5,2,3,1)`).run(id, 'project', parent, fork, fork ? '{"type":"through","messageID":"assistant"}' : null, id, now, now, archived);
  addSession('root'); addSession('child', 'root'); addSession('fork', null, 'root'); addSession('archived', null, null, now);
  const add = (id, type, seq, data, time = now, session = 'root') => db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)')
    .run(id, session, type, seq, time, time, JSON.stringify(data));
  // Deliberately reverse timestamps: seq, not wall clock or IDs, orders history.
  add('user', 'user', 1, { text: 'Find the wireless channel', files: [], agents: [], skills: [] }, now + 100);
  add('assistant', 'assistant', 2, { agent: 'build', model: { id: 'model', providerID: 'provider' }, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } }, cost: 0.01,
    content: [{ type: 'reasoning', text: 'Inspect first' }, { type: 'text', text: 'Checking channel' },
      { type: 'tool', id: 'call', name: 'read', state: { status: 'completed', input: { file: 'a' }, content: [{ type: 'text', text: 'result' }], metadata: {} }, time: { created: now, completed: now + 5 } }] });
  add('compact', 'compaction', 3, { status: 'completed', reason: 'auto', summary: 'Saved summary', recent: 'Kept recent' });
  add('assistant2', 'assistant', 4, { content: [{ type: 'tool', id: 'running', name: 'bash', state: { status: 'running', input: {}, metadata: {} }, time: { created: now } }] });
  add('idle', 'idle', 5, { outcome: 'interrupted' });
  const v2 = createOpenCodeV2Adapter(() => file);
  t.after(() => { closeDb(file); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, db, v2, add, now };
}

test('v2 preserves message sequence, boundaries, live tools and read-only source', async t => {
  const { file, v2 } = fixture(t);
  const hash = () => createHash('sha256').update(readFileSync(file)).digest('hex');
  const before = hash();
  assert.equal(inspectOpenCodeStorage(file).schema, 'v2');
  const sessions = []; for await (const s of v2.scan()) sessions.push(s);
  assert.equal(sessions.length, 3);
  assert.equal(v2.getSession('root').tokenCount, 21);
  assert.equal(v2.getSession('root').messageCount, 3);
  const messages = v2.getMessages('root');
  assert.equal(messages[0].id, 'user');
  assert.equal(messages.filter(m => m.tokens).length, 1);
  assert.ok(!JSON.stringify(messages).includes('NOT_ADMITTED'));
  assert.equal(messages.find(m => m.toolName === 'read').toolOutput, 'result');
  const loop = buildAgentLoop(messages);
  assert.equal(loop.turns.filter(m => m.role === 'assistant').length, 2);
  const live = loop.turns.flatMap(m => m.events).find(e => e.tool === 'bash');
  assert.equal(live.status, 'running'); assert.equal(live.timeEnd, 0);
  assert.equal(v2.getTokenStats(1)[0].totalTokens, 21);
  assert.equal(v2.searchMessages('wireless')[0].messageId, 'user');
  assert.equal(v2.exportSession('root').sourceRecords.length, 5);
  const protocol = v2.getSessionProtocol('root');
  assert.equal(protocol.validation.ok, true, JSON.stringify(protocol.validation));
  assert.equal(protocol.events.find(e => e.kind === 'context.compaction').compaction.summary, 'Saved summary');
  assert.ok(protocol.relationships.some(r => r.type === 'spawned' && r.toSessionId === 'child'));
  assert.ok(v2.getSessionProtocol('fork').relationships.some(r => r.type === 'forked' && r.fromSessionId === 'root'));
  assert.equal(v2.getSession('fork').parentId, null);
  assert.ok(v2.getSessionTree('root')); assert.ok(v2.getSessionContainer('root'));
  assert.equal(v2.getSessionMetrics('root').totals.totalTokens, 21);
  closeDb(file); assert.equal(hash(), before);
});

test('fork copied prefix is disclosed separately and never double-counted as owned usage', t => {
  const { db, v2, add, now } = fixture(t);
  const data = JSON.parse(db.prepare("SELECT data FROM session_message WHERE id='assistant'").get().data);
  add('msg_forkevent_2', 'assistant', 2, data, now, 'fork');
  add('fork-own', 'user', 6, { text: 'fork-specific request' }, now, 'fork');
  assert.equal(v2.getMessages('fork').length, 1);
  assert.equal(v2.getSession('fork').messageCount, 1);
  assert.equal(v2.getInheritedContext('fork').sourceSession.sessionId, 'root');
  assert.equal(v2.getInheritedContext('fork').total, 4);
  assert.equal(v2.getTokenStats(1)[0].totalTokens, 21);
  assert.equal(v2.exportSession('fork').sourceRecords.length, 1);
  assert.ok(v2.searchMessages('channel').every(result => result.sessionId !== 'fork'));
});

test('fork inherited history remains available across Reader pages beyond 200 messages', t => {
  const { v2, add, now } = fixture(t);
  for (let index = 0; index < 205; index++) {
    const seq = index + 10;
    add(`msg_forkevent_${seq}`, 'user', seq, { text: `inherited ${index}` }, now, 'fork');
  }
  const inherited = v2.getInheritedContext('fork');
  assert.equal(inherited.total, 205);
  assert.equal(inherited.messages.length, 205);
  assert.equal(inherited.truncated, false);
  let offset = 0;
  let pages = 0;
  while (offset !== null) {
    const page = renderInheritedContextPage(inherited, 'opencode', offset);
    pages++;
    if (page.nextOffset === null) assert.match(page.html, /inherited 204/);
    offset = page.nextOffset;
  }
  assert.equal(pages, 6);
});

test('v2 Reader binds only source-identified owned children to subagent tools', t => {
  const { db, v2, add, now } = fixture(t);
  db.prepare(`INSERT INTO session_v2 (id,project_id,parent_id,slug,directory,title,time_created,time_updated)
    VALUES ('unmatched','project','root','slug','/workspace','Unmatched child',?,?)`).run(now, now);
  db.prepare(`INSERT INTO session_v2 (id,project_id,parent_id,slug,directory,title,time_created,time_updated)
    VALUES ('output-child','project','root','slug','/workspace','Output child',?,?)`).run(now, now);
  add('assistant3', 'assistant', 6, { content: [
    { type: 'tool', id: 'launch', name: 'task', state: { status: 'completed', input: {}, metadata: { sessionId: 'child' }, content: [{ type: 'text', text: 'Done' }] }, time: { created: now, completed: now } },
    { type: 'tool', id: 'output', name: 'task', state: { status: 'completed', input: {}, metadata: {}, content: [{ type: 'text', text: 'Done\ntask_id: output-child\n' }] }, time: { created: now, completed: now } },
    { type: 'tool', id: 'other', name: 'subagent', state: { status: 'completed', input: {}, metadata: { sessionId: 'archived' }, content: [{ type: 'text', text: 'Done' }] }, time: { created: now, completed: now } }
  ] });
  const projection = v2.getOwnedReaderProjection('root');
  const linked = projection.children.find(child => child.sessionId === 'child');
  assert.equal(linked.parentPartId, 'assistant3:content:0:tool');
  assert.equal(linked.link, 'explicit');
  assert.equal(linked.detached, false);
  assert.equal(projection.children.find(child => child.sessionId === 'output-child').parentPartId, 'assistant3:content:1:tool');
  const unmatched = projection.children.find(child => child.sessionId === 'unmatched');
  assert.equal(unmatched.parentPartId, null);
  assert.equal(unmatched.detached, true);
  const html = renderSessionReaderPane({ session: v2.getSession('root'), ownedReader: projection, provider: 'opencode' });
  assert.match(html, /data-parent-part-id="assistant3:content:0:tool"/);
  assert.match(html, /data-reader-child-session="child"/);
  assert.match(html, /data-reader-open data-reader-provider="opencode" data-reader-session="child"/);
});

test('v2 usage session count follows the selected days and excludes fork copies', t => {
  const { v2, add, now } = fixture(t);
  const yesterday = new Date(now); yesterday.setUTCHours(0, 0, 0, 0);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const usage = { content: [], tokens: { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } };
  add('child-usage', 'assistant', 1, usage, yesterday.getTime() + 3600000, 'child');
  add('msg_forkevent_2', 'assistant', 2, usage, now, 'fork');
  const today = new Date(now).toISOString().slice(0, 10);
  const priorDay = yesterday.toISOString().slice(0, 10);
  assert.equal(v2.getTokenSessionCount(2), 2);
  assert.equal(v2.getTokenSessionCount(2, today, today), 1);
  assert.equal(v2.getTokenSessionCount(2, priorDay, priorDay), 1);
  assert.equal(v2.getTokenSessionCount(2, today, priorDay), 0);
});

test('facade selects v2 over coexisting v1 and does not expose legacy-only methods', t => {
  const { file, db } = fixture(t);
  db.exec('CREATE TABLE session (id TEXT);');
  initConfig(['--opencode-db', file]);
  assert.equal(adapter.detect(), true);
  assert.equal(adapter.getStorageDiagnostic().schema, 'v2');
  assert.equal(adapter.capabilities.openCodeStatsStore, false);
  assert.equal(adapter.getSessionProtocolV3, undefined);
  assert.equal(adapter.getSystemPrompts, undefined);
  assert.equal(adapter.getSession('root').id, 'root');
});

test('missing, empty, unreadable and incomplete-v2 stores are diagnosed without creating a DB', t => {
  const { dir, db, file } = fixture(t);
  const missing = path.join(dir, 'absent.db');
  assert.equal(inspectOpenCodeStorage(missing).schema, 'missing');
  db.exec('DROP TABLE session_message');
  assert.equal(inspectOpenCodeStorage(file).schema, 'unsupported');
  initConfig(['--opencode-db', file]);
  assert.equal(adapter.detect(), false);
  assert.match(adapter.getUnavailableReason(), /session_message/);
  const emptyFile = path.join(dir, 'empty.db'); new DatabaseSync(emptyFile).close();
  assert.equal(inspectOpenCodeStorage(emptyFile).schema, 'unsupported');
  assert.equal(inspectOpenCodeStorage(dir).schema, 'unreadable');
});

test('WAL updates invalidate revisions and malformed messages are explicit errors', t => {
  const { file, db, v2, add } = fixture(t);
  db.exec('PRAGMA journal_mode=WAL');
  const before = openCodeStorageRevision(file);
  add('late', 'user', 6, { text: 'new row' });
  assert.notEqual(openCodeStorageRevision(file), before);
  assert.equal(v2.getMessages('root').at(-1).content, 'new row');
  db.prepare('UPDATE session_message SET data=? WHERE id=?').run('{broken', 'late');
  assert.throws(() => v2.getMessages('root'), /Invalid OpenCode v2 message JSON: late/);
});

async function server(fixtureData) {
  const { dir, file } = fixtureData;
  const pi = path.join(dir, 'pi'); mkdirSync(path.join(pi, 'sessions'), { recursive: true });
  const unavailable = path.join(dir, 'unavailable');
  const port = 39000 + Math.floor(Math.random() * 15000);
  const child = spawn(process.execPath, ['dist/bin/cli.js', '--opencode-db', file, '--pi-dir', pi,
    '--claude-dir', unavailable, '--codex-dir', unavailable, '--dsh-dir', unavailable,
    '--openclaw-dir', unavailable, '--hermes-dir', unavailable,
    '--port', String(port), '--disable-terminal-launch'], {
    env: { ...process.env, AGENTSESSION_META_PATH: path.join(dir, 'meta.db'), AGENTSESSION_CONFIG: path.join(dir, 'config.json') }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const stop = async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  };
  try {
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) assert.fail(output);
      try { const response = await fetch(`http://127.0.0.1:${port}/api/providers`); if (response.ok) return { base: `http://127.0.0.1:${port}`, providers: await response.json(), output: () => output, stop }; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(`Startup timeout: ${output}`);
  } catch (error) {
    await stop();
    throw error;
  }
}

test('unsupported OpenCode does not prevent another provider and HTTP server from starting', async t => {
  const f = fixture(t); f.db.exec('DROP TABLE session_message');
  const running = await server(f);
  try {
    assert.equal(running.providers.find(p => p.id === 'opencode').available, false);
    assert.equal(running.providers.find(p => p.id === 'pi').available, true);
    assert.match(running.output(), /Unsupported OpenCode schema/);
  } finally { await running.stop(); }
});

test('v2 server exposes readable API, HTML, runtime and JSON export', async t => {
  const f = fixture(t); const running = await server(f);
  try {
    assert.equal(running.providers.find(p => p.id === 'opencode').available, true);
    for (const route of ['/sessions', '/opencode/session/root', '/api/opencode/session/root', '/api/opencode/session/root/export?format=json', '/api/opencode/session/root/protocol', '/api/opencode/session/root/runtime/summary', '/api/opencode/session/root/runtime/context', '/opencode/stats']) {
      const response = await fetch(running.base + route);
      assert.equal(response.status, 200, `${route}: ${await response.text()}`);
    }
    assert.ok(!running.output().includes('no such table'));
    assert.match(running.output(), /3 sessions, 3 messages/);
    const stats = await fetch(running.base + '/api/opencode/stats/export.json').then(response => response.json());
    assert.equal(stats.overview.totalSessions, 1);
    assert.equal(stats.overview.avgTokensPerSession, 21);
  } finally { await running.stop(); }
});
