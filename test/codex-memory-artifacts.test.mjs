import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsession-codex-memory-'));
process.env.AGENTSESSION_META_PATH = path.join(temp, 'meta.db');
const { initConfig } = await import('../dist/src/config.js');
initConfig(['--config', path.join(temp, 'config.json')]);
const { closeMetaDb } = await import('../dist/src/meta.js');
const { readCodexMemoryMetadata, readCodexMemoryContent } = await import('../dist/src/providers/codex/memory.js');
const { finalizeSessionProtocol } = await import('../dist/src/providers/shared/session-protocol.js');
const { upgradeSessionProtocolV2 } = await import('../dist/src/providers/shared/session-protocol-v3.js');
const { clearProtocolRuntimeCache, getRuntimeProtocolSnapshots } = await import('../dist/src/protocol-runtime.js');

test.after(() => { closeMetaDb(); fs.rmSync(temp, { recursive: true, force: true }); });

function fixture(t, { jobs = true, wal = false, insert = true } = {}) {
  const directory = fs.mkdtempSync(path.join(temp, 'memory-'));
  const file = path.join(directory, 'memories_1.sqlite');
  const db = new DatabaseSync(file);
  if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.exec(`CREATE TABLE stage1_outputs (
    thread_id TEXT PRIMARY KEY, source_updated_at INTEGER NOT NULL, raw_memory TEXT NOT NULL,
    rollout_summary TEXT NOT NULL, generated_at INTEGER NOT NULL
  ); PRAGMA user_version=987;`);
  if (jobs) db.exec(`CREATE TABLE jobs (
    kind TEXT, job_key TEXT, status TEXT, input_watermark INTEGER, started_at INTEGER,
    finished_at INTEGER, worker_id TEXT, ownership_token TEXT, PRIMARY KEY(kind, job_key)
  )`);
  if (insert) {
    db.prepare('INSERT INTO stage1_outputs VALUES (?, ?, ?, ?, ?)').run('root', 1789565411, '# Saved memory\n汉字 <script> &', 'Summary body', 1789621884);
    if (jobs) db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('memory_stage1', 'root', 'done', 1789565411, 1789621842, 1789621884, 'not-a-session-id', 'private-lock-token');
  }
  t.after(() => db.close());
  return { directory, file, db };
}

test('stage1 metadata records exact source, versions and matching production without retaining bodies', (t) => {
  const { directory, file, db } = fixture(t);
  const before = fs.readFileSync(file);
  const first = readCodexMemoryMetadata(directory, 'root');
  assert.equal(first.sourceState.state, 'available');
  assert.equal(first.sourceState.code, null);
  assert.equal(first.sourceState.sourcePath, file);
  assert.deepEqual(first.artifacts.map(item => item.kind), ['memory', 'summary']);
  const artifact = first.artifacts[0];
  assert.equal(artifact.title, null);
  assert.equal(artifact.scope, 'session');
  assert.equal(artifact.origin, 'provider-generated');
  assert.equal(artifact.contentAccess, 'full');
  assert.equal(artifact.lineageId, 'codex:stage1:root:raw_memory');
  assert.deepEqual(artifact.sourceSessionIds, ['root']);
  assert.equal(artifact.producerRunId, null);
  assert.equal(artifact.timeCreated, 1789621884000);
  assert.equal(artifact.contentSourceTime, 1789565411000);
  assert.deepEqual(artifact.productionEvidence, {
    provenance: { fidelity: 'recorded', sourceType: 'codex.memories.jobs', sourceId: 'memory_stage1:root' },
    startedAt: 1789621842000, completedAt: 1789621884000, inputUpdatedAt: 1789565411000
  });
  const body = '# Saved memory\n汉字 <script> &';
  assert.equal(artifact.hash, createHash('sha256').update(body).digest('hex'));
  assert.ok(artifact.id.includes(':1789565411:1789621884:'));
  assert.doesNotMatch(JSON.stringify(first), /Saved memory|Summary body|private-lock-token|not-a-session-id/);
  assert.equal(readCodexMemoryMetadata(directory, 'root'), first, 'unchanged DB/WAL reuses metadata only');
  assert.deepEqual(readCodexMemoryContent(directory, 'root', artifact.id), { status: 'readable', artifactId: artifact.id, content: body, format: 'markdown' });
  assert.deepEqual(fs.readFileSync(file), before, 'reads preserve provider database bytes');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 987, 'required columns, not user_version, select the schema');
  assert.equal(readCodexMemoryMetadata(directory, 'missing').sourceState.state, 'available');
  assert.deepEqual(readCodexMemoryMetadata(directory, 'missing').artifacts, []);
  assert.deepEqual(readCodexMemoryContent(directory, 'other', artifact.id), { status: 'not-found' });
  assert.deepEqual(readCodexMemoryContent(directory, 'root', 'unknown-artifact'), { status: 'not-found' });
});

test('missing/incompatible jobs retain bodies; status, input and completion mismatches remove only production evidence', (t) => {
  const missing = fixture(t, { jobs: false });
  assert.equal(readCodexMemoryMetadata(missing.directory, 'root').artifacts[0].productionEvidence, null);
  missing.db.exec('CREATE TABLE jobs (kind TEXT, job_key TEXT)');
  const incompatible = readCodexMemoryMetadata(missing.directory, 'root');
  assert.equal(incompatible.artifacts.length, 2);
  assert.equal(incompatible.artifacts[0].productionEvidence, null);
  assert.equal(readCodexMemoryContent(missing.directory, 'root', incompatible.artifacts[0].id).status, 'readable');
  const { directory, db } = fixture(t);
  const matching = readCodexMemoryMetadata(directory, 'root');
  for (const [column, value] of [['status', 'running'], ['input_watermark', 99], ['finished_at', 99], ['kind', 'memory_stage2']]) {
    db.prepare(`UPDATE jobs SET ${column}=?`).run(value);
    const mismatch = readCodexMemoryMetadata(directory, 'root');
    assert.equal(mismatch.artifacts.length, 2);
    assert.equal(mismatch.artifacts[0].id, matching.artifacts[0].id);
    assert.equal(mismatch.artifacts[0].productionEvidence, null, column);
    assert.notEqual(mismatch.revision, matching.revision);
    db.prepare("UPDATE jobs SET kind='memory_stage1', status='done', input_watermark=1789565411, finished_at=1789621884").run();
  }
});

test('WAL replacement invalidates only affected session facts and exact body versions, including empty content', (t) => {
  const { directory, db, file } = fixture(t, { wal: true });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const beforeDb = fs.readFileSync(file);
  const first = readCodexMemoryMetadata(directory, 'root');
  db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('memory_stage1', 'unrelated', 'done', 1, 2, 3, 'worker', 'token');
  assert.equal(readCodexMemoryMetadata(directory, 'root').revision, first.revision, 'unrelated job updates do not rebuild this protocol');
  db.prepare('UPDATE stage1_outputs SET raw_memory=?, generated_at=? WHERE thread_id=?').run('', 1789621885, 'root');
  const next = readCodexMemoryMetadata(directory, 'root');
  assert.notEqual(next.revision, first.revision);
  assert.notEqual(next.artifacts[0].id, first.artifacts[0].id);
  assert.equal(next.artifacts[0].productionEvidence, null);
  assert.equal(readCodexMemoryContent(directory, 'root', first.artifacts[0].id).status, 'stale');
  assert.deepEqual(readCodexMemoryContent(directory, 'root', next.artifacts[0].id), { status: 'readable', artifactId: next.artifacts[0].id, content: '', format: 'markdown' });
  assert.deepEqual(fs.readFileSync(file), beforeDb, 'the update exists in WAL, not the main DB signature alone');
  db.prepare('UPDATE stage1_outputs SET raw_memory=? WHERE thread_id=?').run('same-time replacement', 'root');
  const sameTime = readCodexMemoryMetadata(directory, 'root');
  assert.notEqual(sameTime.artifacts[0].id, next.artifacts[0].id, 'body hash distinguishes replacements with unchanged timestamps');
  assert.equal(readCodexMemoryContent(directory, 'root', next.artifacts[0].id).status, 'stale');
});

test('missing, corrupt and unsupported artifact stores remain explicit; malformed records are not artifacts', (t) => {
  const directory = fs.mkdtempSync(path.join(temp, 'unavailable-'));
  const file = path.join(directory, 'memories_1.sqlite');
  assert.equal(readCodexMemoryMetadata(directory, 'root').sourceState.code, 'not-found');
  assert.equal(fs.existsSync(file), false, 'read-only lookup never creates a database');
  fs.writeFileSync(file, 'not sqlite');
  assert.equal(readCodexMemoryMetadata(directory, 'root').sourceState.code, 'read-failed');
  fs.unlinkSync(file);
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  db.exec('CREATE TABLE stage1_outputs (thread_id TEXT PRIMARY KEY)');
  assert.equal(readCodexMemoryMetadata(directory, 'root').sourceState.code, 'unsupported-schema');
  assert.equal(readCodexMemoryMetadata(directory, 'root').sourceState.state, 'invalid');
  const invalid = fixture(t);
  invalid.db.prepare('UPDATE stage1_outputs SET generated_at=?').run('not a time');
  const result = readCodexMemoryMetadata(invalid.directory, 'root');
  assert.equal(result.sourceState.state, 'invalid');
  assert.equal(result.sourceState.code, 'invalid-record');
  assert.deepEqual(result.artifacts, []);
});

test('transient read failures retry without requiring a file signature change', (t) => {
  const { directory } = fixture(t);
  const original = DatabaseSync.prototype.prepare;
  let fail = true;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (...args) {
    if (fail) { fail = false; throw new Error('transient read failure'); }
    return original.apply(this, args);
  });
  const first = readCodexMemoryMetadata(directory, 'root');
  assert.equal(first.sourceState.code, 'read-failed');
  const next = readCodexMemoryMetadata(directory, 'root');
  assert.equal(next.sourceState.state, 'available');
  assert.equal(next.artifacts.length, 2);
});

test('Codex captures saved metadata once, preserves original history/tokens/compact and keeps content independent of JSONL', async (t) => {
  const { directory, db } = fixture(t);
  fs.mkdirSync(path.join(directory, 'sessions'));
  const timestamp = '2026-09-17T00:00:00.000Z';
  const row = (type, payload) => ({ type, payload, timestamp });
  const records = [
    row('session_meta', { id: 'root' }),
    row('event_msg', { type: 'user_message', message: 'Original request' }),
    row('event_msg', { type: 'agent_message', message: 'Original reply' }),
    row('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }),
    row('compacted', { summary: 'Original compact' })
  ];
  fs.writeFileSync(path.join(directory, 'sessions', 'different-filename.jsonl'), records.map(item => JSON.stringify(item)).join('\n') + '\n');
  initConfig(['--config', path.join(temp, 'config.json'), '--codex-dir', directory]);
  const { default: codex } = await import('../dist/src/providers/codex/adapter.js?memory-fixture');
  const originalMessages = codex.getMessages('root');
  const originalStats = codex.getTokenStats();
  const originalStatsRevision = codex.getStatsRevision();
  const captured = codex.getSessionReaderSnapshot('root');
  const originalRevision = captured.revision;
  const originalMetadata = readCodexMemoryMetadata(directory, 'root');
  db.prepare('UPDATE stage1_outputs SET raw_memory=?').run('Replacement after capture');
  const pair = captured.getProtocolSnapshots();
  assert.deepEqual(pair.v2.contextArtifacts.filter(item => item.contentAccess === 'full').map(item => item.id), originalMetadata.artifacts.map(item => item.id));
  assert.deepEqual(pair.v3.contextArtifactSourceState, pair.v2.contextArtifactSourceState);
  assert.equal(pair.v2.contextArtifacts.length, 3, 'saved artifacts retain the recorded compact artifact');
  assert.equal(pair.v2.events.filter(item => item.kind === 'context.compaction').length, 1);
  assert.equal(pair.v2.validation.ok, true);
  assert.equal(pair.v3.validation.ok, true);
  assert.equal(pair.v2.revision.value, originalRevision);
  const next = codex.getSessionReaderSnapshot('root');
  assert.notEqual(next.revision, originalRevision);
  assert.equal(codex.getStatsRevision(), originalStatsRevision);
  assert.deepEqual(codex.getMessages('root'), originalMessages);
  assert.deepEqual(codex.getTokenStats(), originalStats);
  assert.deepEqual(next.messages, captured.messages);
  const nextPair = next.getProtocolSnapshots();
  assert.deepEqual(nextPair.v3.usageRecords, pair.v3.usageRecords);
  for (const field of ['events', 'relationships', 'tasks', 'agentRuns']) assert.deepEqual(nextPair.v2[field], pair.v2[field], field);
  const current = nextPair.v2.contextArtifacts.find(item => item.kind === 'memory');
  const open = fs.openSync;
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'openSync', (...args) => {
    assert.equal(String(args[0]).endsWith('.jsonl'), false, 'content accessor must not read JSONL');
    return open(...args);
  });
  t.mock.method(fs, 'readdirSync', (...args) => {
    assert.equal(String(args[0]).includes('sessions'), false, 'content accessor must not refresh session discovery');
    return readdir(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(codex.getContextArtifactContent('root', current.id).content, 'Replacement after capture');
  assert.equal(codex.getContextArtifactContent('root', originalMetadata.artifacts[0].id).status, 'stale');
  db.prepare('INSERT INTO stage1_outputs VALUES (?, ?, ?, ?, ?)').run('no-rollout', 1, 'retained memory', '', 2);
  const retained = readCodexMemoryMetadata(directory, 'no-rollout').artifacts[0];
  assert.equal(codex.getContextArtifactContent('no-rollout', retained.id).content, 'retained memory', 'stored canonical thread id is sufficient without a transcript');
});

test('source state and production fields survive finalized v2 and explicit v3 upgrade', (t) => {
  const { directory } = fixture(t);
  const memory = readCodexMemoryMetadata(directory, 'root');
  const v2 = finalizeSessionProtocol({ sessionId: 'root', events: [], relationships: [], tasks: [], agentRuns: [], contextArtifacts: memory.artifacts, contextArtifactSourceState: memory.sourceState }, { provider: 'codex' });
  const v3 = upgradeSessionProtocolV2(v2);
  assert.deepEqual(v3.contextArtifactSourceState, memory.sourceState);
  assert.deepEqual(v3.contextArtifacts[0].productionEvidence, memory.artifacts[0].productionEvidence);
  assert.equal(v3.contextArtifacts[0].contentSourceTime, memory.artifacts[0].contentSourceTime);
  assert.equal(v3.validation.ok, true);
});

test('a failed artifact store does not suppress compact or ordinary runtime facts', async (t) => {
  const { directory, db } = fixture(t);
  db.exec('DROP TABLE stage1_outputs');
  fs.mkdirSync(path.join(directory, 'sessions'));
  fs.writeFileSync(path.join(directory, 'sessions', 'root.jsonl'), [
    { type: 'session_meta', payload: { id: 'root' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Still readable' } },
    { type: 'compacted', payload: { summary: 'Still compacted' } }
  ].map(item => JSON.stringify({ ...item, timestamp: '2026-09-17T00:00:00Z' })).join('\n') + '\n');
  initConfig(['--config', path.join(temp, 'config.json'), '--codex-dir', directory]);
  const { default: codex } = await import('../dist/src/providers/codex/adapter.js?memory-unavailable');
  clearProtocolRuntimeCache();
  const pair = getRuntimeProtocolSnapshots(codex, 'root');
  assert.equal(pair.v2.contextArtifactSourceState.code, 'unsupported-schema');
  assert.equal(pair.v2.contextArtifacts.length, 1);
  assert.equal(pair.v3.validation.ok, true);
  assert.ok(codex.getMessages('root').some(item => item.content === 'Still readable'));
});
