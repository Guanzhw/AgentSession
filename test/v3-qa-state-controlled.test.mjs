import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rename, rm, symlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { assertMetadataTransition, assertPreservedDatabase, qualifyWatcher, isolatedEnvironment, inspectDatabase } from '../scripts/v3-qa-state-controlled.mjs';
import { createCallEvidence } from '../scripts/v3-bench-call-evidence.mjs';

async function ownedTempDirectory(prefix, root = os.tmpdir()) {
  // OS temp roots can use aliases (/var on macOS, short names on Windows).
  return realpathSync.native(await mkdtemp(path.join(root, prefix)));
}

const row = (provider = 'codex', session_id = 'one') => ({ provider, session_id, custom_title: 'old', starred: 0,
  deleted: 0, permanent: 0, time_starred: null, time_deleted: null, time_renamed: null });
const snapshot = (rows) => ({ schemaObjects: [{ type: 'table', name: 'session_meta', sql: 'CREATE TABLE session_meta' }],
  tables: [{ name: 'session_meta', rowCount: rows.length, schemaSha256: 'meta', rowsSha256: 'changing' },
    { name: 'v1_index', rowCount: 1, schemaSha256: 'index', rowsSha256: 'preserved' }],
  metadataRows: rows, quickCheck: 'ok' });
const mutation = { provider: 'codex', id: 'one', action: 'rename', title: 'new', startedAtMs: 100, completedAtMs: 200 };
const original = () => snapshot([row(), row('hermes', 'retired')]);
const renamed = () => snapshot([{ ...row(), custom_title: 'new', time_renamed: 150 }, row('hermes', 'retired')]);

test('rename accepts only its target title and timestamp and preserves retired rows and other tables', () => {
  assertMetadataTransition(original(), renamed(), mutation);
});
test('metadata comparison rejects a changed retired row, even when totals agree', () => {
  const after = renamed(); after.metadataRows[1].custom_title = 'lost';
  assert.throws(() => assertMetadataTransition(original(), after, mutation), /non-target|unrelated/);
});
test('metadata comparison rejects unrelated flags on the target', () => {
  const after = renamed(); after.metadataRows[0].deleted = 1;
  assert.throws(() => assertMetadataTransition(original(), after, mutation), /target|expected/);
});
test('metadata comparison rejects timestamps outside the request window', () => {
  const after = renamed(); after.metadataRows[0].time_renamed = 201;
  assert.throws(() => assertMetadataTransition(original(), after, mutation), /timestamp|window/);
});
test('metadata comparison rejects changed legacy index rows and schema', () => {
  const changedIndex = renamed(); changedIndex.tables[1].rowsSha256 = 'different';
  assert.throws(() => assertMetadataTransition(original(), changedIndex, mutation), /table|index/);
  const changedSchema = renamed(); changedSchema.schemaObjects[0].sql = 'DROP TABLE';
  assert.throws(() => assertMetadataTransition(original(), changedSchema, mutation), /schema/);
});
test('idempotent batch star preserves an existing timestamp and unstar clears it', () => {
  const before = snapshot([{ ...row(), starred: 1, time_starred: 50 }]);
  assertMetadataTransition(before, structuredClone(before), { ...mutation, action: 'star' });
  const bad = structuredClone(before); bad.metadataRows[0].time_starred = 150;
  assert.throws(() => assertMetadataTransition(before, bad, { ...mutation, action: 'star' }), /target|timestamp|expected/);
  const after = snapshot([{ ...row(), starred: 0, time_starred: null }]);
  assertMetadataTransition(before, after, { ...mutation, action: 'unstar' });
});
test('new metadata row gets canonical defaults, and an unexpected inserted row is rejected', () => {
  const before = snapshot([row('hermes', 'retired')]);
  const inserted = { ...row(), custom_title: 'new', time_renamed: 150 };
  assertMetadataTransition(before, snapshot([inserted, row('hermes', 'retired')]), mutation);
  assert.throws(() => assertMetadataTransition(before, snapshot([inserted, row('hermes', 'retired'), row('pi', 'extra')]), mutation), /non-target|unrelated/);
});
test('delete, restore and permanent exclusion preserve all other target fields', () => {
  const before = snapshot([row()]);
  const deleted = snapshot([{ ...row(), deleted: 1, time_deleted: 150 }]);
  assertMetadataTransition(before, deleted, { ...mutation, action: 'delete' });
  assertMetadataTransition(deleted, before, { ...mutation, action: 'restore' });
  const permanent = snapshot([{ ...row(), deleted: 1, permanent: 1, time_deleted: 150 }]);
  assertMetadataTransition(deleted, permanent, { ...mutation, action: 'permanent-delete' });
});
test('read/reindex/restart preservation rejects semantic changes even with the same file count', () => {
  assertPreservedDatabase(original(), structuredClone(original()));
  assert.throws(() => assertPreservedDatabase(original(), renamed()), /metadata|preserv/);
  const bad = original(); bad.tables[1].rowsSha256 = 'changed';
  assert.throws(() => assertPreservedDatabase(original(), bad), /table|preserv/);
});
test('watcher qualification requires ready markers and a matching positive control', () => {
  const protectedRoot = path.resolve('shadow'); const control = path.join(protectedRoot, 'control.txt');
  const records = [{ kind: 'ready', root: protectedRoot }, { kind: 'change', path: control, changeType: 'Created' }];
  assert.equal(qualifyWatcher(records, { roots: [protectedRoot], controls: [control] }).status, 'passed');
  assert.throws(() => qualifyWatcher(records.slice(1), { roots: [protectedRoot], controls: [control] }), /ready/);
  assert.throws(() => qualifyWatcher(records.slice(0, 1), { roots: [protectedRoot], controls: [control] }), /positive control/);
});
test('watcher fails on overflow/error and changes to protected paths and reports no writer attribution', () => {
  const root = path.resolve('shadow'); const control = path.join(root, 'control.txt');
  const records = [{ kind: 'ready', root }, { kind: 'change', path: control, changeType: 'Created' }];
  assert.throws(() => qualifyWatcher([...records, { kind: 'error', message: 'buffer overflow' }], { roots: [root], controls: [control] }), /error|overflow/);
  assert.throws(() => qualifyWatcher([...records, { kind: 'change', path: path.join(root, 'agentsession/meta.db'), changeType: 'Changed' }], { roots: [root], controls: [control] }), /protected/);
  const result = qualifyWatcher(records, { roots: [root], controls: [control] });
  assert.equal(result.writerPidAvailable, false);
  assert.equal(result.continuousKernelWriteProof, false);
});
test('watcher qualification reports pre-control notifications separately and still rejects changes inside the measured window', () => {
  const root = path.resolve('shadow'), control = path.join(root, 'control-begin.txt');
  const records = [{ kind: 'ready', root }, { kind: 'change', path: path.join(root, 'prepared-directory'), changeType: 'Changed' },
    { kind: 'change', path: control, changeType: 'Changed' }, { kind: 'stopped' }];
  const spec = { roots: [root], controls: [control], windowStartSequence: 2 };
  const result = qualifyWatcher(records, spec);
  assert.equal(result.status, 'passed'); assert.equal(result.preWindowChanges.length, 1);
  assert.equal(result.windowStartSequence, 2); assert.equal(result.writerPidAvailable, false);
  assert.throws(() => qualifyWatcher([...records.slice(0, 3),
    { kind: 'change', path: path.join(root, 'meta.db'), changeType: 'Changed' }, { kind: 'stopped' }], spec), /protected/);
  assert.throws(() => qualifyWatcher(records, { ...spec, windowStartSequence: 3 }), /positive control|boundary/);
});
test('watcher rejects a protected file moved outside its root and a control moved into a protected path', () => {
  const root = path.resolve('shadow'); const control = path.join(root, 'control.txt');
  const records = [{ kind: 'ready', root }, { kind: 'change', path: control, changeType: 'Changed' }];
  assert.throws(() => qualifyWatcher([...records, { kind: 'change', oldPath: path.join(root, 'meta.db'),
    path: path.resolve('outside.db'), changeType: 'Renamed' }], { roots: [root], controls: [control] }), /protected/);
  assert.throws(() => qualifyWatcher([...records, { kind: 'change', oldPath: control,
    path: path.join(root, 'meta.db'), changeType: 'Renamed' }], { roots: [root], controls: [control] }), /protected/);
});
test('protected tree digest detects empty directory creation and rename', async () => {
  const { protectedTreeSnapshot } = await import('../scripts/v3-qa-state-controlled.mjs');
  const dir = await ownedTempDirectory('agentsession-state-tree-');
  try {
    const before = await protectedTreeSnapshot(dir);
    await mkdir(path.join(dir, 'empty'));
    const created = await protectedTreeSnapshot(dir);
    assert.notEqual(created.sha256, before.sha256);
    assert.equal(created.directories, 1); assert.equal(created.files, 0);
    await rename(path.join(dir, 'empty'), path.join(dir, 'renamed'));
    assert.notEqual((await protectedTreeSnapshot(dir)).sha256, created.sha256);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('owned temp roots normalize aliases while protected paths still reject redirects', async () => {
  const { protectedTreeSnapshot } = await import('../scripts/v3-qa-state-controlled.mjs');
  const dir = await ownedTempDirectory('agentsession-state-temp-alias-');
  try {
    const backing = path.join(dir, 'backing'), alias = path.join(dir, 'alias');
    await mkdir(backing);
    await symlink(backing, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const owned = await ownedTempDirectory('owned-', alias);
    assert.equal(path.dirname(owned), backing);
    assert.equal((await protectedTreeSnapshot(owned)).exists, true);
    await assert.rejects(protectedTreeSnapshot(alias), /link\/reparse path rejected/);
    await assert.rejects(protectedTreeSnapshot(path.join(alias, path.basename(owned))), /resolved path differs|link\/reparse/);
    await assert.rejects(protectedTreeSnapshot(dir), /source\/tree link rejected/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('complete database comparison includes SQLite autoincrement sequence state', async () => {
  const dir = await ownedTempDirectory('agentsession-state-sequence-');
  const source = path.join(dir, 'old.db'), inspection = path.join(dir, 'inspection');
  await mkdir(inspection);
  const db = new DatabaseSync(source);
  try {
    db.exec(`CREATE TABLE session_meta(provider TEXT,session_id TEXT,custom_title TEXT,starred INTEGER,deleted INTEGER,
      permanent INTEGER,time_starred INTEGER,time_deleted INTEGER,time_renamed INTEGER,PRIMARY KEY(provider,session_id));
      CREATE TABLE retired_index(id INTEGER PRIMARY KEY AUTOINCREMENT,payload TEXT);
      INSERT INTO retired_index(payload) VALUES ('retained');`);
    const before = await inspectDatabase(source, inspection, 'before');
    assert.ok(before.tables.some(table => table.name === 'sqlite_sequence'));
    db.exec("UPDATE sqlite_sequence SET seq=10 WHERE name='retired_index'");
    const after = await inspectDatabase(source, inspection, 'after');
    assert.throws(() => assertPreservedDatabase(before, after), /table|preserv/);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
test('HTTP transport failures retain exact request and SDK error before a phase can fail', async () => {
  const { requestRecorded } = await import('../scripts/v3-qa-state-controlled.mjs');
  const dir = await ownedTempDirectory('agentsession-state-http-');
  try {
    const evidence = createCallEvidence({ directory: path.join(dir, 'calls') });
    const failure = Object.assign(new Error('controlled request failure'), { code: 'ECONNRESET', data: { marker: 'error data' } });
    await assert.rejects(requestRecorded('http://127.0.0.1:1', '/api/reindex', {}, dir, 1, {
      evidence, fetchImpl: async () => { throw failure; },
    }), error => error === failure);
    assert.deepEqual({ ok: evidence.audit().ok, calls: evidence.audit().calls, pending: evidence.audit().pending },
      { ok: true, calls: 1, pending: 0 });
    const begin = JSON.parse(await readFile(path.join(dir, 'calls/000001.begin.private.json'), 'utf8'));
    const terminal = JSON.parse(await readFile(path.join(dir, 'calls/000001.terminal.private.json'), 'utf8'));
    assert.equal(begin.request.url, 'http://127.0.0.1:1/api/reindex');
    assert.equal(begin.request.body, '{}'); assert.equal(terminal.outcome, 'error');
    assert.equal(terminal.error.code, failure.code); assert.deepEqual(terminal.error.data, failure.data);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('child spawn errors remain observed while closure waits for the actual close event', async () => {
  const { observeOwnedChild } = await import('../scripts/v3-qa-state-controlled.mjs');
  const child = new EventEmitter(), record = {};
  const closed = observeOwnedChild(child, record);
  child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }));
  let resolved = false; closed.then(() => { resolved = true; });
  await Promise.resolve(); assert.equal(resolved, false);
  assert.equal(record.spawnError.code, 'ENOENT'); assert.equal(record.closed, undefined);
  child.emit('close', -2, null); await closed;
  assert.equal(record.closed, true); assert.equal(record.exitCode, -2);
});
test('MCP failed connection retains terminal error and the owned child actual close', async () => {
  const { exerciseMcp } = await import('../scripts/v3-qa-state-controlled.mjs');
  const dir = await ownedTempDirectory('agentsession-state-mcp-connect-');
  try {
    const evidence = createCallEvidence({ directory: path.join(dir, 'calls') }), report = { processes: [] };
    const plan = { exe: process.execPath, config: path.join(dir, 'unused.json'), sources: [], stateArgs: [],
      out: dir, env: isolatedEnvironment(dir) };
    await assert.rejects(exerciseMcp(plan, dir, report, evidence));
    assert.equal(evidence.audit().ok, true); assert.equal(evidence.audit().pending, 0);
    assert.equal(report.processes.length, 1); assert.equal(report.processes[0].closed, true);
    const terminal = JSON.parse(await readFile(path.join(dir, 'calls/000001.terminal.private.json'), 'utf8'));
    assert.equal(terminal.outcome, 'error'); assert.ok(terminal.error.message);
    assert.ok(report.processes[0].stderr.bytes > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('watcher stop timeout kills only its retained child, waits for close, and persists the original failure', async () => {
  const { startWatcher } = await import('../scripts/v3-qa-state-controlled.mjs');
  const dir = await ownedTempDirectory('agentsession-state-watcher-timeout-');
  let watcher;
  try {
    const code = `console.log(JSON.stringify({kind:'ready',root:process.argv[1]})); setInterval(()=>{},1000);`;
    watcher = await startWatcher(dir, [dir], isolatedEnvironment(dir), {
      command: process.execPath, args: ['-e', code, dir], stopTimeoutMs: 30, cleanupTimeoutMs: 1000,
    });
    const ownedPid = watcher.child.pid;
    await assert.rejects(watcher.stop(), /watcher close timeout/);
    const lifecycle = JSON.parse(await readFile(path.join(dir, 'watcher-lifecycle.public.json'), 'utf8'));
    const records = JSON.parse(await readFile(path.join(dir, 'watcher-events.private.json'), 'utf8'));
    assert.equal(lifecycle.pid, ownedPid); assert.equal(lifecycle.closed, true);
    assert.equal(lifecycle.stopFailure.message, 'watcher close timeout');
    assert.ok(records.some(record => record.kind === 'error' && record.message === 'watcher close timeout'));
    assert.ok(watcher.child.exitCode !== null || watcher.child.signalCode !== null);
    const beforeRetry = await readFile(path.join(dir, 'watcher-events.private.json'));
    await assert.rejects(watcher.stop(), /watcher close timeout/);
    assert.deepEqual(await readFile(path.join(dir, 'watcher-events.private.json')), beforeRetry);
  } finally {
    if (watcher && watcher.child.exitCode === null && watcher.child.signalCode === null) {
      const closed = new Promise(resolve => watcher.child.once('close', resolve)); watcher.child.kill(); await closed;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
test('observer profile writes stay outside the protected candidate shadow tree', async () => {
  const { startWatcher, protectedTreeSnapshot } = await import('../scripts/v3-qa-state-controlled.mjs');
  const dir = await ownedTempDirectory('agentsession-state-observer-isolation-');
  const protectedRoot = path.join(dir, 'shadow'); let watcher;
  try {
    for (const child of ['profile', 'roaming', 'local']) await mkdir(path.join(protectedRoot, child), { recursive: true });
    const before = await protectedTreeSnapshot(protectedRoot);
    const code = `const fs=require('node:fs'),path=require('node:path');
      const cache=path.join(process.env.USERPROFILE,'AppData/Local/Microsoft/PowerShell');
      fs.mkdirSync(cache,{recursive:true}); fs.writeFileSync(path.join(cache,'controlled-observer-cache'),'observer cache');
      console.log(JSON.stringify({kind:'observerEnvironment',userProfile:process.env.USERPROFILE}));
      console.log(JSON.stringify({kind:'ready',root:process.argv[1]}));
      setInterval(()=>{if(fs.existsSync(process.argv[2])){console.log(JSON.stringify({kind:'stopped'}));process.exit(0);}},10);`;
    watcher = await startWatcher(dir, [protectedRoot], isolatedEnvironment(dir), {
      command: process.execPath, args: ['-e', code, protectedRoot, path.join(dir, 'watcher-stop')],
    });
    assert.deepEqual(await protectedTreeSnapshot(protectedRoot), before);
    const observer = watcher.records.find(record => record.kind === 'observerEnvironment');
    assert.equal(observer.userProfile, path.join(dir, 'monitor/shadow/profile'));
    await watcher.stop();
  } finally {
    if (watcher) await watcher.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
test('child environment clears inherited AgentSession and provider overrides without assigning HOME', () => {
  const home = 'unchanged inherited HOME';
  const env = isolatedEnvironment(path.resolve('owned'), { HOME: home, CODEX_HOME: 'private', AGENTSESSION_META_PATH: 'default',
    agentsession_config: 'default-config', PORT: '3456', DSH_HOME: 'private', KEEP_THIS: 'keep' });
  assert.equal(env.HOME, home); assert.equal(env.KEEP_THIS, 'keep');
  for (const key of ['CODEX_HOME', 'AGENTSESSION_META_PATH', 'agentsession_config', 'PORT', 'DSH_HOME']) assert.equal(env[key], undefined);
  assert.equal(env.APPDATA, path.resolve('owned', 'shadow', 'roaming'));
  assert.equal(env.USERPROFILE, path.resolve('owned', 'shadow', 'profile'));
});

test('SQLite validation reads an inspection copy with committed WAL and preserves the input family', async () => {
  const dir = await ownedTempDirectory('agentsession-state-inspection-');
  const source = path.join(dir, 'old.db'), inspection = path.join(dir, 'inspection');
  await mkdir(inspection);
  const db = new DatabaseSync(source);
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE session_meta(provider TEXT,session_id TEXT,custom_title TEXT,starred INTEGER,deleted INTEGER,
        permanent INTEGER,time_starred INTEGER,time_deleted INTEGER,time_renamed INTEGER,PRIMARY KEY(provider,session_id));
      CREATE TABLE retired_index(id TEXT,payload BLOB,counter INTEGER);
      INSERT INTO session_meta VALUES ('hermes','retired','from committed WAL',1,0,0,123,NULL,NULL);
      INSERT INTO retired_index VALUES ('retired',X'0102',9007199254740993);`);
    const before = await Promise.all(['', '-wal', '-shm'].map(suffix => readFile(source + suffix)));
    const result = await inspectDatabase(source, inspection, 'snapshot-one');
    assert.equal(result.quickCheck, 'ok');
    assert.equal(result.metadataRows[0].custom_title, 'from committed WAL');
    assert.equal(result.tables.find(table => table.name === 'retired_index').rowCount, 1);
    assert.ok(result.bytes.find(row => row.suffix === '-wal').exists);
    const after = await Promise.all(['', '-wal', '-shm'].map(suffix => readFile(source + suffix)));
    after.forEach((bytes, index) => assert.deepEqual(bytes, before[index], 'protected input family changed'));
    await assert.rejects(inspectDatabase(source, inspection, 'snapshot-one'), /EEXIST/);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
test('real SQLite metadata rows normalize at inspection boundary before strict mutation comparison', async () => {
  const dir = await ownedTempDirectory('agentsession-state-row-shape-');
  const source = path.join(dir, 'old.db'), inspection = path.join(dir, 'inspection');
  await mkdir(inspection);
  const db = new DatabaseSync(source);
  try {
    db.exec(`CREATE TABLE session_meta(provider TEXT,session_id TEXT,custom_title TEXT,starred INTEGER,deleted INTEGER,
      permanent INTEGER,time_starred INTEGER,time_deleted INTEGER,time_renamed INTEGER,PRIMARY KEY(provider,session_id));
      INSERT INTO session_meta VALUES ('codex','one','old',0,0,0,NULL,NULL,NULL);`);
    const before = await inspectDatabase(source, inspection, 'before');
    db.exec("UPDATE session_meta SET custom_title='new',time_renamed=150 WHERE provider='codex' AND session_id='one'");
    const after = await inspectDatabase(source, inspection, 'after');
    assertMetadataTransition(before, after, mutation);
    assert.equal(Object.getPrototypeOf(after.metadataRows[0]), Object.prototype);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
