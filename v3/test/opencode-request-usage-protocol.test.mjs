import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const optionalSha = file => existsSync(file) ? sha(file) : null;

function assistant(tokens, model, content = []) {
  return { ...(model ? { model: { id: model, providerID: 'fixture-provider' } } : {}),
    ...(tokens === undefined ? {} : { tokens }), content };
}

const richTokens = { input: 12, output: 4, reasoning: 3, cache: { read: 5, write: 2 }, total: 26 };
const mismatchTokens = { input: 5, output: 1, reasoning: 1, cache: { read: 2, write: 1 }, total: 50 };
const cacheOnlyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 9 } };
const zeroTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 0 };

async function seedFixture(root, schema) {
  const fixture = path.join(root, `public-opencode-${schema}.db`);
  const db = new DatabaseSync(fixture);
  if (schema === 'v1') {
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT,
      directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
      INSERT INTO session VALUES ('v1-root',NULL,'V1 root','/synthetic',1,500,NULL),
        ('v1-empty',NULL,'V1 empty','/synthetic',1,500,NULL);`);
    const addMessage = db.prepare('INSERT INTO message VALUES (?,?,?,?)');
    const addPart = db.prepare('INSERT INTO part VALUES (?,?,?,?,?)');
    const add = (id, role, created, tokens, extra = {}, parts = []) => {
      addMessage.run(id, 'v1-root', JSON.stringify({ role, time: { created }, ...extra,
        ...(tokens === undefined ? {} : { tokens }) }), created);
      for (let index = 0; index < parts.length; index++) {
        addPart.run(`${id}-part-${index}`, id, 'v1-root', JSON.stringify(parts[index]), created + index);
      }
    };
    add('v1-user', 'user', 100, richTokens, { text: 'User token fields are not requests.' }, [
      { type: 'text', text: 'Question' },
    ]);
    add('v1-owned', 'assistant', 200, richTokens, { modelID: 'model-v1', finish: 'stop' }, [
      { type: 'reasoning', text: 'Reasoning remains part of the request usage.' },
      { type: 'text', text: 'Answer' },
      { type: 'tool', tool: 'read', state: { status: 'completed', input: {}, output: 'read' } },
    ]);
    add('v1-mismatch', 'assistant', 300, mismatchTokens, { modelID: 'model-v1' }, [
      { type: 'text', text: 'Mismatched total' },
    ]);
    add('v1-cache-only', 'assistant', 400, cacheOnlyTokens, {}, [
      { type: 'text', text: 'One message with several parts still has one request.' },
      { type: 'reasoning', text: 'Another part does not duplicate its request.' },
    ]);
    add('v1-zero-error', 'assistant', 500, zeroTokens, { finish: 'error' }, [
      { type: 'text', text: 'No recorded tokens.' },
    ]);
    add('v1-total-only', 'assistant', 600, { total: 77 }, {}, [
      { type: 'text', text: 'A session total is not a request.' },
    ]);
    add('v1-no-usage', 'assistant', 700, undefined, {}, [
      { type: 'text', text: 'Usage is missing.' },
    ]);
  } else {
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT,
      fork_boundary TEXT, title TEXT, slug TEXT, directory TEXT, time_created INTEGER,
      time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
      tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
        time_created INTEGER, time_updated INTEGER, data TEXT);
      INSERT INTO session_v2 VALUES ('v2-root',NULL,NULL,NULL,'V2 root','v2-root','/synthetic',1,500,NULL,10000,5000,2000,3000,1000),
        ('v2-fork',NULL,'v2-root','{}','V2 fork','v2-fork','/synthetic',2,500,NULL,10000,5000,2000,3000,1000),
        ('v2-empty',NULL,NULL,NULL,'V2 empty','v2-empty','/synthetic',3,500,NULL,0,0,0,0,0);`);
    const addMessage = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
    const add = (id, sessionId, type, seq, data, time = seq * 100) => {
      addMessage.run(id, sessionId, type, seq, time, time, JSON.stringify(data));
    };
    add('v2-user', 'v2-root', 'user', 1, { text: 'User token fields are not requests.', tokens: richTokens });
    add('v2-owned', 'v2-root', 'assistant', 2,
      assistant(richTokens, 'model-v2', [
        { type: 'reasoning', text: 'Reasoning remains part of request usage.' },
        { type: 'text', text: 'Answer' },
        { type: 'tool', id: 'call', name: 'read', state: { status: 'completed', input: {}, content: [] } },
      ]));
    add('v2-mismatch', 'v2-root', 'assistant', 3, assistant(mismatchTokens, 'model-v2'));
    add('v2-cache-only', 'v2-root', 'assistant', 4, assistant(cacheOnlyTokens, 'model-v2'));
    add('v2-zero-error', 'v2-root', 'assistant', 5, assistant(zeroTokens, 'model-v2'));
    add('v2-total-only', 'v2-root', 'assistant', 6, assistant({ total: 77 }, 'model-v2'));
    add('v2-no-usage', 'v2-root', 'assistant', 7, assistant(undefined, 'model-v2'));
    add('msg_forkevent_2', 'v2-fork', 'assistant', 2, assistant(richTokens, 'model-v2'));
    add('fork-user', 'v2-fork', 'user', 6, { text: 'Fork-owned user request.' });
    add('fork-owned', 'v2-fork', 'assistant', 7, assistant(
      { input: 3, output: 2, reasoning: 0, cache: { read: 1, write: 0 }, total: 6 }, 'model-fork'));
  }
  db.close();
  const source = path.join(root, 'opencode.db');
  await copyFile(fixture, source);
  return source;
}

async function port() {
  return freeFetchSafePort();
}

async function start(t, source, suffix) {
  const root = await mkdtemp(path.join(repo, 'tmp', `v3-opencode-usage-${suffix}-`));
  if (source === null) source = await seedFixture(root, suffix);
  const children = [];
  const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']
    .map(name => [name, path.join(root, name)]));
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
  const args = ['--opencode-db', source, '--codex-dir', dirs.codex, '--claude-dir', dirs.claude,
    '--pi-dir', dirs.pi, '--dsh-dir', dirs.dsh, '--meta-dir', dirs.meta,
    '--index-dir', dirs.index, '--cache-dir', dirs.cache];
  const before = [source, `${source}-wal`].map(optionalSha);
  const selectedPort = await port();
  const child = spawn(binary, ['serve', '--port', String(selectedPort), ...args],
    { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data.toString(); });
  children.push(child);
  t.after(async () => {
    for (const running of children) {
      if (running.exitCode !== null || running.signalCode !== null) continue;
      const closed = once(running, 'close');
      if (process.platform === 'win32' && running.pid !== undefined) {
        const killer = spawn('taskkill.exe', ['/PID', String(running.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' });
        await once(killer, 'close');
      } else {
        running.kill();
      }
      await closed;
    }
    assert.deepEqual([source, `${source}-wal`].map(optionalSha), before,
      'OpenCode source files must remain unchanged');
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(repo, 'tmp'));
    assert.ok(path.basename(resolved).startsWith(`v3-opencode-usage-${suffix}-`));
    await rm(resolved, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${selectedPort}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok)
        return { base, source };
    } catch { /* Server startup. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`OpenCode request usage server did not start: ${stderr.slice(0, 500)}`);
}

async function protocol(base, sessionId, version = 3) {
  const response = await fetch(`${base}/api/v3/protocol/opencode/${sessionId}?version=${version}`);
  const document = await response.json();
  assert.equal(response.status, 200, JSON.stringify(document));
  return document;
}

function nonnegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function expectedRecord({ schema, sessionId, messageId, timestamp, message }) {
  const tokens = message.tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return null;
  const input = nonnegativeInteger(tokens.input) ?? 0;
  const output = nonnegativeInteger(tokens.output) ?? 0;
  const reasoning = nonnegativeInteger(tokens.reasoning) ?? 0;
  const cacheRead = nonnegativeInteger(tokens.cache?.read);
  const cacheWrite = nonnegativeInteger(tokens.cache?.write);
  if (input === 0 && (cacheRead ?? 0) === 0 && (cacheWrite ?? 0) === 0 && output === 0 && reasoning === 0)
    return null;
  const sum = input + (cacheRead ?? 0) + (cacheWrite ?? 0) + output + reasoning;
  const rawTotal = nonnegativeInteger(tokens.total);
  const eventId = schema === 'v1' ? `event:opencode:v1:message:${messageId}`
    : `event:opencode:v2:${messageId}`;
  return {
    id: `usage:${sessionId}:message:${messageId}`,
    scope: 'request',
    sessionRef: { provider: 'opencode', sessionId },
    timestamp,
    model: typeof message.modelID === 'string' ? message.modelID
      : typeof message.model?.id === 'string' ? message.model.id : null,
    ...(typeof (schema === 'v1' ? message.providerID : message.providerID ?? message.model?.providerID) === 'string'
      ? { modelProvider: schema === 'v1' ? message.providerID : message.providerID ?? message.model.providerID } : {}),
    runId: null,
    eventId,
    turnId: messageId,
    tokens: { input, cacheRead, cacheWrite, output, reasoning, total: rawTotal === sum ? rawTotal : null },
    contextOriginSlices: [],
    provenance: { fidelity: 'recorded', sourceType: 'opencode.message.tokens', sourceId: messageId },
  };
}

test('OpenCode v1/v2 HTTP protocol records one owned assistant request with exact source semantics',
  { timeout: 60_000 }, async t => {
    const fixtures = [];
    for (const schema of ['v1', 'v2']) {
      fixtures.push({ schema, ...await start(t, null, schema) });
    }

    const v1 = fixtures.find(row => row.schema === 'v1');
    const v1Doc = await protocol(v1.base, 'v1-root');
    assert.equal(v1Doc.validation.ok, true);
    assert.deepEqual(v1Doc.usageRecords.map(row => row.id), [
      'usage:v1-root:message:v1-owned',
      'usage:v1-root:message:v1-mismatch',
      'usage:v1-root:message:v1-cache-only',
    ]);
    assert.deepEqual(v1Doc.usageRecords, [
      expectedRecord({ schema: 'v1', sessionId: 'v1-root', messageId: 'v1-owned', timestamp: 200,
        message: { ...assistant(richTokens, 'model-v1'), modelID: 'model-v1' } }),
      expectedRecord({ schema: 'v1', sessionId: 'v1-root', messageId: 'v1-mismatch', timestamp: 300,
        message: { ...assistant(mismatchTokens, 'model-v1'), modelID: 'model-v1' } }),
      expectedRecord({ schema: 'v1', sessionId: 'v1-root', messageId: 'v1-cache-only', timestamp: 400,
        message: { ...assistant(cacheOnlyTokens, undefined) } }),
    ]);
    assert.equal(v1Doc.coverage.usage.state, 'observed');
    assert.equal(v1Doc.coverage.usage.details,
      'one request record per canonical assistant message with nonzero tokens');
    assert.ok(v1Doc.usageRecords.every(record => v1Doc.events.some(event => event.id === record.eventId)));
    const v1Empty = await protocol(v1.base, 'v1-empty');
    assert.deepEqual(v1Empty.usageRecords, []);
    assert.equal(v1Empty.coverage.usage.state, 'not-observed');

    const v2 = fixtures.find(row => row.schema === 'v2');
    const v2Root = await protocol(v2.base, 'v2-root');
    const v2Fork = await protocol(v2.base, 'v2-fork');
    assert.equal(v2Root.validation.ok, true);
    assert.deepEqual(v2Root.usageRecords.map(row => row.id), [
      'usage:v2-root:message:v2-owned',
      'usage:v2-root:message:v2-mismatch',
      'usage:v2-root:message:v2-cache-only',
    ]);
    assert.deepEqual(v2Root.usageRecords, [
      expectedRecord({ schema: 'v2', sessionId: 'v2-root', messageId: 'v2-owned', timestamp: 200,
        message: assistant(richTokens, 'model-v2') }),
      expectedRecord({ schema: 'v2', sessionId: 'v2-root', messageId: 'v2-mismatch', timestamp: 300,
        message: assistant(mismatchTokens, 'model-v2') }),
      expectedRecord({ schema: 'v2', sessionId: 'v2-root', messageId: 'v2-cache-only', timestamp: 400,
        message: assistant(cacheOnlyTokens, 'model-v2') }),
    ]);
    assert.deepEqual(v2Fork.usageRecords.map(row => row.id), [
      'usage:v2-fork:message:fork-owned',
    ], 'the copied parent request is not owned by the fork');
    assert.deepEqual(v2Fork.usageRecords, [expectedRecord({ schema: 'v2', sessionId: 'v2-fork',
      messageId: 'fork-owned', timestamp: 700,
      message: assistant({ input: 3, output: 2, reasoning: 0, cache: { read: 1, write: 0 }, total: 6 },
        'model-fork') })]);
    assert.equal(v2Root.coverage.usage.state, 'observed');
    assert.ok(v2Root.usageRecords.every(record => v2Root.events.some(event => event.id === record.eventId)));
    const v2Empty = await protocol(v2.base, 'v2-empty');
    assert.deepEqual(v2Empty.usageRecords, []);
    assert.equal(v2Empty.coverage.usage.state, 'not-observed');

    const v2Document = await protocol(v2.base, 'v2-root', 2);
    for (const key of ['session', 'revision', 'events', 'tasks', 'agentRuns', 'relationships',
      'contextArtifacts', 'branches']) assert.deepEqual(v2Root[key], v2Document[key], key);
  });

function privateExpected(db, sessionId) {
  const rows = db.prepare(`SELECT m.id, m.type, m.time_created, m.data FROM session_message m
    JOIN session_v2 s ON s.id=m.session_id WHERE m.session_id=? AND
      (s.fork_session_id IS NULL OR substr(m.id,-length(CAST(m.seq AS TEXT))-1) != '_' || m.seq)
    ORDER BY m.seq, m.id`).all(sessionId);
  return rows.flatMap(row => {
    const message = JSON.parse(row.data);
    if (row.type !== 'assistant') return [];
    if (!message.tokens) return [];
    const expected = expectedRecord({ schema: 'v2', sessionId, messageId: row.id,
      timestamp: row.time_created, message });
    return expected ? [expected] : [];
  });
}

test('frozen OpenCode v2 request usage matches a read-only raw SQLite oracle',
  { timeout: 120_000, skip: !process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST }, async t => {
    const manifest = JSON.parse(readFileSync(process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST));
    const source = manifest.database.snapshotPath;
    const before = [source, `${source}-wal`].map(optionalSha);
    assert.equal(before[0], manifest.database.snapshotSha256);
    const { base } = await start(t, source, 'frozen');
    const db = new DatabaseSync(source, { readOnly: true });
    let dbOpen = true;
    t.after(() => { if (dbOpen) db.close(); });
    const targets = manifest.captureTargets.filter(row => row.provider === 'opencode');
    assert.ok(targets.length > 0, 'frozen manifest has an OpenCode capture target');
    let checkedRecords = 0;
    for (const target of targets) {
      const expected = privateExpected(db, target.sessionId);
      const document = await protocol(base, target.sessionId);
      assert.equal(document.validation.ok, true);
      assert.deepEqual(document.usageRecords, expected);
      assert.equal(document.coverage.usage.state, expected.length ? 'observed' : 'not-observed');
      assert.equal(new Set(document.usageRecords.map(record => record.id)).size, expected.length);
      for (const record of document.usageRecords) {
        assert.equal(record.scope, 'request');
        assert.deepEqual(record.sessionRef, { provider: 'opencode', sessionId: target.sessionId });
        assert.ok(document.events.some(event => event.id === record.eventId));
      }
      checkedRecords += expected.length;
    }
    db.close();
    dbOpen = false;
    assert.deepEqual([source, `${source}-wal`].map(optionalSha), before,
      'frozen OpenCode source hashes must remain unchanged');
    t.diagnostic(`Frozen OpenCode oracle checked ${targets.length} selected sessions and ${checkedRecords} recorded requests; source hashes unchanged.`);
  });
