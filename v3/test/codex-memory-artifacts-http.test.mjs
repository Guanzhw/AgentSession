import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const raw = '# Saved memory\n汉字 <script> & ' + 'x'.repeat(5000) + ' END_OF_RECORDED_MEMORY';
const summary = 'Summary body END_OF_RECORDED_SUMMARY';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function agentBrowserBinary() {
  const name = process.platform === 'win32' ? 'agent-browser-win32-x64.exe'
    : `agent-browser-${process.platform}-${process.arch}`;
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(entry, 'node_modules', 'agent-browser', 'bin', name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
const browser = agentBrowserBinary();

async function command(session, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(browser, ['--session', session, ...args], { cwd: repo, windowsHide: true });
    let output = ''; let error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output.trim())
      : reject(new Error(`agent-browser ${args[0]}: ${error || output}`)));
  });
}

async function serve(t) {
  assert.ok(existsSync(binary), `Build ${binary} before this test`);
  await mkdir(path.join(repo, 'tmp'), { recursive: true });
  const work = await mkdtemp(path.join(repo, 'tmp', 'v3-codex-memory-'));
  const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']
    .map(name => [name, path.join(work, name)]));
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
  const sessions = path.join(dirs.codex, 'sessions', '2026', '09', '27');
  await mkdir(sessions, { recursive: true });
  const sessionPath = path.join(sessions, `rollout-2026-09-27T00-00-00-${id}.jsonl`);
  await writeFile(sessionPath, JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/synthetic' } }) + '\n');
  const dbPath = path.join(dirs.codex, 'memories_1.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE stage1_outputs (thread_id TEXT PRIMARY KEY, source_updated_at INTEGER NOT NULL,
    raw_memory TEXT NOT NULL, rollout_summary TEXT NOT NULL, generated_at INTEGER NOT NULL);
    CREATE TABLE jobs (kind TEXT, job_key TEXT, status TEXT, input_watermark INTEGER,
    started_at INTEGER, finished_at INTEGER, PRIMARY KEY (kind, job_key)); PRAGMA user_version=987`);
  db.prepare('INSERT INTO stage1_outputs VALUES (?, ?, ?, ?, ?)').run(id, 1789565411, raw, summary, 1789621884);
  db.prepare('INSERT INTO stage1_outputs VALUES (?, ?, ?, ?, ?)').run(other, 1, 'FOREIGN_SECRET', 'FOREIGN_SUMMARY', 2);
  db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?)').run('memory_stage1', id, 'done', 1789565411, 1789621842, 1789621884);
  const before = sha(readFileSync(dbPath));
  const port = await freeFetchSafePort();
  const child = spawn(binary, ['serve', '--port', String(port), '--codex-dir', dirs.codex,
    '--opencode-db', path.join(work, 'missing-opencode.db'), '--claude-dir', dirs.claude,
    '--pi-dir', dirs.pi, '--dsh-dir', dirs.dsh, '--meta-dir', dirs.meta,
    '--index-dir', dirs.index, '--cache-dir', dirs.cache], { cwd: repo, windowsHide: true, stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    db.close();
    const resolved = path.resolve(work);
    assert.equal(path.dirname(resolved), path.resolve(repo, 'tmp'));
    assert.ok(path.basename(resolved).startsWith('v3-codex-memory-'));
    await rm(resolved, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) throw new Error('Axum exited before readiness');
    try { if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok)
      return { base, db, dbPath, before, sessionPath }; } catch { /* Startup in progress. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Axum did not start');
}

test('Codex selected memory row has recorded metadata and bounded on-demand bodies',
  { timeout: 60_000 }, async t => {
    const { base, db, dbPath, before, sessionPath } = await serve(t);
    const route = `${base}/api/v3/reader/codex/${id}/artifacts`;
    const response = await fetch(route);
    assert.equal(response.status, 200);
    const listing = await response.json();
    assert.equal(listing.sourceState.state, 'available');
    assert.deepEqual(listing.artifacts.map(item => item.kind), ['memory', 'summary']);
    assert.doesNotMatch(JSON.stringify(listing), /Saved memory|Summary body|FOREIGN_SECRET/);
    const artifact = listing.artifacts[0];
    assert.equal(artifact.hash, sha(raw));
    assert.deepEqual(artifact.sourceSessionIds, [id]);
    assert.equal(artifact.provenance.sourceType, 'codex.memories.stage1_outputs');
    assert.equal(artifact.productionEvidence.completedAt, 1789621884000);
    const protocol = await (await fetch(`${base}/api/v3/protocol/codex/${id}?version=3`)).json();
    assert.deepEqual(protocol.contextArtifacts.map(item => item.id), listing.artifacts.map(item => item.id));
    assert.deepEqual(protocol.contextArtifactSourceState, listing.sourceState);
    const v2 = await (await fetch(`${base}/api/v3/protocol/codex/${id}?version=2`)).json();
    assert.deepEqual(v2.contextArtifactSourceState, listing.sourceState);
    let text = ''; let offset = 0;
    while (true) {
      const pageResponse = await fetch(`${route}/${encodeURIComponent(artifact.id)}/content?${new URLSearchParams({
        revision: listing.revision, offset: String(offset), maxChars: '37',
      })}`);
      assert.equal(pageResponse.status, 200);
      const page = await pageResponse.json();
      text += page.text;
      if (page.nextOffset === null) break;
      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
    }
    assert.equal(text, raw);
    assert.equal(sha(readFileSync(dbPath)), before);
    assert.ok(readFileSync(sessionPath).length > 0);
    db.prepare('UPDATE stage1_outputs SET raw_memory=? WHERE thread_id=?').run('UNRELATED_REPLACEMENT', other);
    const unrelated = await (await fetch(route)).json();
    assert.equal(unrelated.revision, listing.revision, 'unrelated memory rows do not change selected revision');
    db.prepare('UPDATE jobs SET status=? WHERE kind=? AND job_key=?').run('running', 'memory_stage1', id);
    const noProduction = await (await fetch(route)).json();
    assert.equal(noProduction.artifacts.length, 2);
    assert.equal(noProduction.artifacts[0].productionEvidence, null,
      'a mismatched job cannot claim memory production');
    assert.notEqual(noProduction.revision, listing.revision);
    db.prepare('UPDATE jobs SET status=? WHERE kind=? AND job_key=?').run('done', 'memory_stage1', id);
    db.prepare('UPDATE stage1_outputs SET raw_memory=? WHERE thread_id=?').run('replacement', id);
    const changed = await (await fetch(route)).json();
    assert.notEqual(changed.revision, listing.revision);
    assert.notEqual(changed.artifacts[0].id, artifact.id);
    assert.equal((await fetch(`${route}/${encodeURIComponent(artifact.id)}/content?${new URLSearchParams({
      revision: listing.revision, offset: '0', maxChars: '37',
    })}`)).status, 409);
    assert.equal((await fetch(`${route}/${encodeURIComponent(artifact.id)}/content?${new URLSearchParams({
      revision: changed.revision, offset: '0', maxChars: '37',
    })}`)).status, 409, 'old artifact ID is stale even under the current revision');
    const retained = await (await fetch(`${base}/api/v3/reader/codex/${other}/artifacts`)).json();
    assert.equal(retained.artifacts.length, 2,
      'a canonical memory row remains readable without a rollout transcript');
    assert.deepEqual(retained.artifacts[0].sourceSessionIds, [other]);
    assert.doesNotMatch(JSON.stringify(retained), /FOREIGN_SECRET/);
    const retainedContent = await (await fetch(`${base}/api/v3/reader/codex/${other}/artifacts/${encodeURIComponent(retained.artifacts[0].id)}/content?${new URLSearchParams({
      revision: retained.revision, offset: '0', maxChars: '40',
    })}`)).json();
    assert.equal(retainedContent.text, 'UNRELATED_REPLACEMENT');
    assert.equal((await fetch(`${route}/${encodeURIComponent(retained.artifacts[0].id)}/content?${new URLSearchParams({
      revision: changed.revision, offset: '0', maxChars: '40',
    })}`)).status, 404, 'a different canonical thread cannot read the retained row');
    db.prepare('UPDATE stage1_outputs SET generated_at=? WHERE thread_id=?').run(9007199254741, id);
    const unsafeTime = await (await fetch(route)).json();
    assert.equal(unsafeTime.sourceState.state, 'invalid');
    assert.equal(unsafeTime.sourceState.code, 'invalid-record');
    assert.deepEqual(unsafeTime.artifacts, []);
    db.exec('DROP TABLE stage1_outputs');
    const unsupported = await (await fetch(route)).json();
    assert.equal(unsupported.sourceState.state, 'invalid');
    assert.equal(unsupported.sourceState.code, 'unsupported-schema');
    assert.deepEqual(unsupported.artifacts, []);
  });

test('Codex job start time outside the JavaScript-safe millisecond range is omitted',
  { timeout: 60_000 }, async t => {
    const { base, db } = await serve(t);
    const unsafeSeconds = Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1;
    db.prepare('UPDATE jobs SET started_at=? WHERE kind=? AND job_key=?')
      .run(unsafeSeconds, 'memory_stage1', id);
    const listing = await (await fetch(`${base}/api/v3/reader/codex/${id}/artifacts`)).json();
    assert.equal(listing.artifacts[0].productionEvidence.startedAt, null);
  });

test('Codex stale memory IDs use the encoded canonical session ID prefix',
  { timeout: 60_000 }, async t => {
    const { base, db } = await serve(t);
    const sessionId = 'a:b';
    db.prepare('INSERT INTO stage1_outputs VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, 1, 'original memory', 'summary', 2);
    const route = `${base}/api/v3/reader/codex/${encodeURIComponent(sessionId)}/artifacts`;
    const original = await (await fetch(route)).json();
    const staleId = original.artifacts[0].id;
    assert.ok(staleId.startsWith('codex:stage1:a%3Ab:'), 'the artifact ID encodes the session colon');
    db.prepare('UPDATE stage1_outputs SET raw_memory=? WHERE thread_id=?')
      .run('replacement memory', sessionId);
    const current = await (await fetch(route)).json();
    const response = await fetch(`${route}/${encodeURIComponent(staleId)}/content?${new URLSearchParams({
      revision: current.revision, offset: '0', maxChars: '40',
    })}`);
    assert.equal(response.status, 409, 'an obsolete artifact ID for this session is a source conflict');
  });

test('Reader opens recorded memory and continues to the final source characters',
  { skip: !browser ? 'agent-browser executable unavailable' : false, timeout: 90_000 }, async t => {
    const { base } = await serve(t);
    const session = `v3-codex-memory-${process.pid}-${Date.now()}`;
    t.after(async () => { try { await command(session, 'close'); } catch { /* Already closed. */ } });
    await command(session, 'open', `${base}/codex/session/${id}`);
    await command(session, 'wait', '.reader-session-details > summary');
    await command(session, 'click', '.reader-session-details > summary');
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await command(session, 'eval', `Boolean(document.querySelector('.recorded-memory-actions button'))`)).includes('true')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.match(await command(session, 'get', 'text', '.recorded-memory'), /Saved memory|Rollout summary/);
    await command(session, 'click', '.recorded-memory-actions button:first-child');
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await command(session, 'eval', `Boolean(document.querySelector('.recorded-memory pre')?.textContent?.includes('Saved memory'))`)).includes('true')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.match(await command(session, 'get', 'text', '.recorded-memory'), /Production recorded/);
    assert.doesNotMatch(await command(session, 'get', 'text', '.recorded-memory pre'), /END_OF_RECORDED_MEMORY/);
    let completed = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      let state = 'loading';
      for (let poll = 0; poll < 50; poll++) {
        state = await command(session, 'eval', `(() => {
          if (document.querySelector('.recorded-memory pre')?.textContent?.includes('END_OF_RECORDED_MEMORY')) return 'done';
          const button = document.querySelector('.recorded-memory > button');
          return button && !button.disabled ? 'ready' : 'loading';
        })()`);
        if (state.includes('done') || state.includes('ready')) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (state.includes('done')) { completed = true; break; }
      assert.match(state, /ready/, 'recorded memory pagination becomes ready');
      await command(session, 'eval', `document.querySelector('.recorded-memory > button')?.scrollIntoView({ block: 'center' })`);
      await command(session, 'click', '.recorded-memory > button');
    }
    assert.ok(completed, 'recorded memory reaches the final source characters');
    assert.match(await command(session, 'get', 'text', '.recorded-memory pre'), /END_OF_RECORDED_MEMORY/);
  });
