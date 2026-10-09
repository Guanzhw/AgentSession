import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import * as crash from '../scripts/v3-qa-index-crash-current.mjs';
import { controlledEnvironment, validateInputLedger, snapshotCatalog } from '../scripts/v3-qa-index-crash-current.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const root = path.join(repo, 'tmp/v3-performance/formal-resume-20261001T1901/crash');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function owned(t) {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(root));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('crash child environment clears inherited AgentSession defaults and binds a shadow profile', () => {
  const home = 'unchanged-home';
  const env = controlledEnvironment({ PATH: 'fixture-path', HOME: home, CODEX_HOME: 'unchanged-codex',
    AGENTSESSION_META_PATH: 'original-db', agentsession_config: 'original-config',
    AGENTSESSION_V3_TEST_PAUSE_BEFORE_CATALOG_COMMIT: 'unexpected', PORT: '3456' }, 'X:/owned/run');
  assert.equal(env.AGENTSESSION_META_PATH, undefined);
  assert.equal(env.agentsession_config, undefined);
  assert.equal(env.AGENTSESSION_V3_TEST_PAUSE_BEFORE_CATALOG_COMMIT, undefined);
  assert.equal(env.PORT, undefined);
  assert.equal(env.APPDATA, path.join('X:/owned/run', 'shadow/Roaming'));
  assert.equal(env.LOCALAPPDATA, path.join('X:/owned/run', 'shadow/Local'));
  assert.equal(env.USERPROFILE, path.join('X:/owned/run', 'shadow/Home'));
  assert.equal(env.HOME, home);
  assert.equal(env.CODEX_HOME, 'unchanged-codex');
});

test('input ledger rejects copied Rust drift before a crash service can be started', async t => {
  const dir = await owned(t);
  const original = path.join(dir, 'original'), copy = path.join(dir, 'copy');
  await mkdir(original); await mkdir(copy);
  const bytes = Buffer.from('frozen production owner');
  await writeFile(path.join(original, 'index.rs'), bytes);
  await writeFile(path.join(copy, 'index.rs'), bytes);
  const entries = [{ path: 'index.rs', sizeBytes: bytes.length, sha256: sha(bytes) }];
  assert.equal(validateInputLedger(original, copy, entries).length, 1);
  await writeFile(path.join(copy, 'index.rs'), 'changed owner');
  assert.throws(() => validateInputLedger(original, copy, entries), /Production input drift/);
});

test('catalog snapshot distinguishes transaction rollback from a partial search publication', async t => {
  const dir = await owned(t), dbFile = path.join(dir, 'scope.sqlite');
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(`CREATE TABLE catalog_state(provider TEXT, revision INTEGER);
      INSERT INTO catalog_state VALUES('codex',1);
      CREATE TABLE catalog_entry(provider TEXT,session_id TEXT,signature TEXT,summary_json TEXT);
      INSERT INTO catalog_entry VALUES('codex','id','sig','{}');
      CREATE TABLE search_doc(provider TEXT,session_id TEXT,field TEXT,position INTEGER,text TEXT);
      INSERT INTO search_doc VALUES('codex','id','assistant',0,'hello');
      CREATE VIRTUAL TABLE search_doc_fts USING fts5(text);
      INSERT INTO search_doc_fts(rowid,text) VALUES(1,'hello');`);
    const before = snapshotCatalog(dir);
    assert.equal(before.oldFts, 1); assert.equal(before.newFts, 0); assert.equal(before.quickCheck, 'ok');
    db.exec("BEGIN; UPDATE catalog_state SET revision=2; UPDATE search_doc SET text='howdy'; UPDATE search_doc_fts SET text='howdy';");
    assert.deepEqual(snapshotCatalog(dir), before);
    db.exec('ROLLBACK');
    assert.deepEqual(snapshotCatalog(dir), before);
    db.exec('DELETE FROM search_doc_fts');
    assert.notDeepEqual(snapshotCatalog(dir), before);
  } finally { db.close(); }
});

test('whole shadow profile inventory detects new scoped state and equal-length content changes', async t => {
  const dir = await owned(t), shadow = path.join(dir, 'shadow');
  await mkdir(path.join(shadow, 'Roaming/agentsession-v3/scopes/controlled'), { recursive: true });
  await mkdir(path.join(shadow, 'Local'), { recursive: true });
  await mkdir(path.join(shadow, 'Home'), { recursive: true });
  const scope = path.join(shadow, 'Roaming/agentsession-v3/scopes/controlled/meta.db');
  await writeFile(scope, 'original');
  const before = crash.shadowInventory(dir);
  assert.ok(before.some(row => row.path === 'Roaming/agentsession-v3/scopes/controlled/meta.db' && row.type === 'file'));
  await writeFile(scope, 'mutated!');
  assert.notDeepEqual(crash.shadowInventory(dir), before);
  await writeFile(scope, 'original');
  await mkdir(path.join(shadow, 'Home/unexpected'));
  assert.notDeepEqual(crash.shadowInventory(dir), before);
});

test('recovery requires the independently known canonical session and assistant message', () => {
  const valid = [{ session: { provider: 'codex', sessionId: '44444444-4444-4444-8444-444444444444' },
    event: { provider: 'codex', sessionId: '44444444-4444-4444-8444-444444444444', messageId: 'assistant-1', segment: 'message' },
    matchField: 'message', matchRole: 'assistant' }];
  assert.doesNotThrow(() => crash.assertRecoveredMatches(valid));
  for (const change of [row => { row.session.sessionId = '55555555-5555-4555-8555-555555555555'; },
    row => { row.event.messageId = 'user-1'; }, row => { row.event.sessionId = 'other-session'; }]) {
    const wrong = structuredClone(valid); change(wrong[0]);
    assert.throws(() => crash.assertRecoveredMatches(wrong));
  }
});

function fakeOwnedService(onKill = () => {}) {
  let resolveClosed;
  const service = { name: 'test-owned-child', exit: null, closed: new Promise(resolve => { resolveClosed = resolve; }) };
  service.child = { pid: 123, exitCode: null, signalCode: null, kill(signal) {
    onKill(); service.child.signalCode = signal; service.exit = { code: null, signal }; resolveClosed(service.exit); return true;
  } };
  return service;
}

test('MCP rejection before a PID is ready is handled and its owned child is closed', async () => {
  const original = Object.assign(new Error('connect rejected before pid'), { code: 'CONTROLLED_EARLY_FAILURE' });
  const service = fakeOwnedService(), transport = { _process: service.child, pid: null, async close() {} };
  let clientClosed = false, registered = 0;
  const client = { connect() { return Promise.reject(original); }, async close() { clientClosed = true; } };
  await assert.rejects(crash.connectOwnedMcp(client, transport, () => { registered++; return service; }, 100), error => error === original);
  assert.equal(registered, 1); assert.equal(clientClosed, true); assert.notEqual(service.exit, null);
});

test('cleanup joins the in-flight crash request even when client closure fails', async () => {
  let releaseRequest, requestSettled = false;
  const request = new Promise(resolve => { releaseRequest = () => { requestSettled = true; resolve({ outcome: 'error', error: { code: 'ECONNRESET' } }); }; });
  const service = fakeOwnedService(releaseRequest);
  service.client = { async close() { throw new Error('controlled close failure'); } };
  const cleanup = await crash.cleanupCrashServices([service], [request]);
  assert.equal(requestSettled, true);
  assert.notEqual(service.exit, null);
  assert.equal(cleanup.errors.length, 1);
  assert.deepEqual(cleanup.requestTerminals, [{ outcome: 'error', error: { code: 'ECONNRESET' } }]);
});

test('preflight fixture oracle accepts the public Unicode character and rejects damaged text', async () => {
  const fixture = await readFile(path.join(repo, 'v3/fixtures/codex/sessions/2026/09/26/rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl'));
  assert.doesNotThrow(() => crash.validatePublicFixtureOracle(fixture));
  const damaged = Buffer.from(fixture.toString('utf8').replace('Hello \u{1F642}', 'Hello ??'));
  assert.throws(() => crash.validatePublicFixtureOracle(damaged), { code: 'ERR_ASSERTION' });
});

test('crash refresh uses a supported Web search limit so the request can reach the hook', () => {
  const url = crash.webSearchUrl('http://127.0.0.1:29920', 'howdy');
  assert.equal(url.searchParams.get('limit'), '100');
  assert.equal(url.searchParams.get('provider'), 'codex');
  assert.equal(url.searchParams.get('fields'), 'assistant');
  const continued = crash.webSearchUrl('http://127.0.0.1:29920', 'hello', 1, 'opaque+/=cursor');
  assert.equal(continued.searchParams.get('limit'), '1');
  assert.equal(continued.searchParams.get('cursor'), 'opaque+/=cursor');
});
