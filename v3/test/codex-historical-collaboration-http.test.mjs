import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug', process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const parent = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const realRoot = process.env.AGENTSESSION_CODEX_HISTORICAL_ROOT;
const expectations = realRoot ? JSON.parse(readFileSync(process.env.AGENTSESSION_CODEX_HISTORICAL_EXPECTATIONS, 'utf8')) : [{ id: parent, tasks: 8, runs: 3, errors: 4, starts: 2 }];

async function files(root) {
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...await files(full));
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

test('Historical Codex UUID dispatch and explicit child headers agree across real HTTP projections', { timeout: 180_000 }, async t => {
  const work = await mkdtemp(path.join(repo, 'tmp', 'v3-historical-codex-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const codexDir = realRoot || path.join(work, 'codex');
  if (!realRoot) await cp(path.join(repo, 'v3', 'fixtures', 'codex-historical'), codexDir, { recursive: true });
  for (const dir of ['meta', 'index', 'cache', 'claude', 'pi']) await mkdir(path.join(work, dir));
  const ids = new Set(expectations.flatMap(row => [row.id, ...(row.children || [])]));
  const sourceFiles = (await files(path.join(codexDir, 'sessions'))).filter(file => !realRoot || [...ids].some(id => path.basename(file).includes(id)));
  const before = sourceFiles.map(file => [file, hash(file)]);
  const port = await freeFetchSafePort();
  const child = spawn(binary, ['serve', '--port', String(port), '--codex-dir', codexDir, '--opencode-db', path.join(work, 'absent.db'), '--claude-dir', path.join(work, 'claude'), '--pi-dir', path.join(work, 'pi'), '--dsh-dir', path.join(work, 'absent-dsh'), '--meta-dir', path.join(work, 'meta'), '--index-dir', path.join(work, 'index'), '--cache-dir', path.join(work, 'cache')], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let startupOutput = '';
  child.stdout.on('data', chunk => { startupOutput += chunk; });
  child.stderr.on('data', chunk => { startupOutput += chunk; });
  t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'close'); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { ready = (await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready || child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'isolated DEBUG Axum ready: ' + startupOutput);
  async function json(url) { const response = await fetch(base + url); assert.equal(response.status, 200, url); return response.json(); }
  for (const expected of expectations) {
    const { id } = expected;
    const document = await json(`/api/v3/protocol/codex/${id}?version=3`);
    assert.equal(document.tasks.filter(task => task.kind === 'subagent-task').length, expected.tasks, `${id} recorded spawn tasks`);
    assert.equal(document.tasks.filter(task => task.status === 'failed').length, expected.errors, `${id} exact rejections`);
    const runs = document.agentRuns.filter(run => run.kind === 'subagent');
    assert.equal(runs.length, expected.runs, `${id} delegated run scope`);
    assert.equal(runs.filter(run => run.timeStart !== null).length, expected.starts, `${id} recorded acknowledgments`);
    assert.equal(new Set(runs.map(run => run.childSessionRef.sessionId)).size, runs.length);
    assert.equal(new Set(document.coordination.map(fact => fact.id)).size, document.coordination.length);
    const bootstrap = await json(`/api/v3/reader/codex/${id}/bootstrap`);
    assert.equal(document.revision, bootstrap.revision);
    const placements = [];
    for (let cursor = bootstrap.relations.firstCursor; cursor;) {
      const page = await json(`/api/v3/reader/codex/${id}/relations?cursor=${encodeURIComponent(cursor)}`);
      placements.push(...page.childPlacements);
      cursor = page.nextCursor;
    }
    const acknowledged = document.coordination.filter(fact => fact.kind === 'spawn' && fact.state === 'started' && fact.toSessionRef);
    assert.equal(placements.length, acknowledged.length, 'Reader places only verified recorded spawns');
    for (const placement of placements) {
      const ack = acknowledged.find(fact => fact.toSessionRef.sessionId === placement.child.sessionId);
      assert.equal(placement.sourceEventId, ack.evidence.eventId);
      assert.deepEqual(placement.afterEvent, ack.readerEvent);
      assert.equal(placement.diagnostic, null);
      const childBootstrap = await json(`/api/v3/reader/codex/${placement.child.sessionId}/bootstrap`);
      assert.equal(childBootstrap.session.session.sessionId, placement.child.sessionId);
    }

    for (const run of runs.filter(run => run.taskId === null)) {
      assert.equal(run.status, 'unknown'); assert.equal(run.pairing, 'unidentifiable');
      for (const key of ['turnId', 'timeStart', 'timeEnd', 'terminalEvidence']) assert.equal(run[key], null);
      const event = document.events.find(event => event.id === run.evidence.eventId);
      assert.equal(event.kind, 'codex.child_thread_declared');
      assert.equal(event.provenance.fidelity, 'derived');
      assert.equal(event.provenance.sourceId, run.evidence.provenance.sourceId);
      assert.ok(event.provenance.sourceId.includes(run.childSessionRef.sessionId));
      assert.equal(event.timestamp, null); assert.equal(event.readerEvent, null); assert.equal(event.execution, undefined);
    }
    for (const fact of document.coordination) {
      const event = document.events.find(event => event.id === fact.evidence.eventId);
      assert.ok(event, 'coordination evidence resolves to exact event');
      assert.deepEqual(event.readerEvent, fact.readerEvent);
      const detail = await json(`/api/v3/runtime/codex/${id}/events/${encodeURIComponent(event.id)}?revision=${document.revision}`);
      assert.deepEqual(detail.event, event, 'standalone stream and finalized bundle agree');
      assert.equal(fact.evidence.provenance.fidelity, 'recorded');
      if (fact.toActorPath) assert.ok(fact.toActorPath.startsWith('/'), 'UUIDs never become actor paths');
    }
    if (!realRoot) {
      const first = runs.find(run => run.taskId === 'spawn-a');
      assert.equal(first.evidence.eventId, 'event:codex:2');
      assert.equal(first.terminalEvidence.eventId, 'event:codex:10');
      assert.equal(first.timeEnd, Date.parse('2026-07-10T00:00:10Z'));
      const close = runs.find(run => run.taskId === 'spawn-b');
      assert.equal(close.status, 'completed'); assert.equal(close.timeEnd, null);
      assert.equal(close.terminalEvidence.eventId, 'event:codex:18');
      assert.ok(document.coordination.some(fact => fact.kind === 'input' && fact.state === 'submitted'));
      assert.equal(document.tasks.find(task => task.id === 'opaque-output').status, 'unknown');
      assert.equal(document.coordination.find(fact => fact.kind === 'spawn' && fact.correlationId === 'missing-child' && fact.state === 'started').toSessionRef ?? null, null);
    }
    console.log(JSON.stringify({ id, tasks: expected.tasks, runs: runs.length, errors: expected.errors, starts: expected.starts, revision: document.revision }));
  }
  assert.deepEqual(sourceFiles.map(file => [file, hash(file)]), before, 'selected provider source hashes preserved');
  console.log(JSON.stringify({ sourceFiles: before.length, sourceHashesPreserved: true }));
});
