import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const id = '44444444-4444-4444-8444-444444444444';
const original = path.join(repo, 'v3', 'fixtures', 'codex', 'sessions', '2026', '09', '26',
  `rollout-2026-09-26T00-00-00-${id}.jsonl`);
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const lifecycle = (type, turn, startedAt, completedAt, error) => ({
  type: 'event_msg', payload: { type, turn_id: turn,
    ...(startedAt === undefined ? {} : { started_at: startedAt }),
    ...(completedAt === undefined ? {} : { completed_at: completedAt }),
    ...(error ? { error: { message: 'recorded failure' } } : {}) },
});

async function freePort() {
  return freeFetchSafePort();
}

async function setup(t, rows) {
  assert.ok(existsSync(binary), `Build ${binary}`);
  await mkdir(path.join(repo, 'tmp'), { recursive: true });
  const work = await mkdtemp(path.join(repo, 'tmp', 'v3-work-http-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const sourceRoot = path.join(work, 'codex');
  const source = path.join(sourceRoot, 'sessions', '2026', '09', '26', path.basename(original));
  await mkdir(path.dirname(source), { recursive: true });
  for (const name of ['meta', 'index', 'cache', 'claude', 'pi']) await mkdir(path.join(work, name));
  const header = readFileSync(original, 'utf8').split('\n')[0];
  await writeFile(source, [header, ...rows.map(row => JSON.stringify(row))].join('\n') + '\n');
  const port = await freePort();
  const child = spawn(binary, ['serve', '--port', String(port), '--codex-dir', sourceRoot,
    '--opencode-db', path.join(work, 'opencode.db'), '--claude-dir', path.join(work, 'claude'),
    '--pi-dir', path.join(work, 'pi'), '--dsh-dir', path.join(work, 'missing-dsh'),
    '--meta-dir', path.join(work, 'meta'), '--index-dir', path.join(work, 'index'),
    '--cache-dir', path.join(work, 'cache')], { cwd: repo, windowsHide: true, stdio: 'ignore' });
  t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'close'); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok) return { base, source, sourceRoot }; }
    catch { /* Axum is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Axum did not start');
}

const protocolUrl = (base, version) => `${base}/api/v3/protocol/codex/${id}?version=${version}`;
const workUrl = (base, query = {}) => {
  const url = new URL(`/api/v3/runtime/codex/${id}/work`, base);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return url;
};

test('Codex v2 base, same-source v3 upgrade, and bounded Work preserve native lifecycle evidence',
  { timeout: 60_000 }, async t => {
    const rows = [
      { type: 'response_item', payload: { type: 'agent_message', id: 'assignment',
        content: [{ type: 'text', text: 'Message Type: NEW_TASK\nTask name: worker' }] } },
      lifecycle('task_started', 'ok', 100), lifecycle('task_complete', 'ok', 100, 110),
      lifecycle('task_started', 'duplicate', 200), lifecycle('task_started', 'duplicate', 200),
      lifecycle('task_complete', 'duplicate', 200, 210),
      lifecycle('task_started', 'double-terminal', 300),
      lifecycle('task_complete', 'double-terminal', 300, 310),
      lifecycle('turn_aborted', 'double-terminal', 300, 311),
      lifecycle('task_complete', 'orphan', 350, 360),
      lifecycle('task_started', 'failed', 400), lifecycle('task_complete', 'failed', 400, 410, true),
      lifecycle('task_started', 'cancelled', 500), lifecycle('turn_aborted', 'cancelled', 500, 510),
      lifecycle('task_complete', 'missing-time', undefined, 600),
    ];
    const { base, source } = await setup(t, rows);
    const before = hash(source);
    const reader = await (await fetch(`${base}/api/v3/reader/codex/${id}/bootstrap`)).json();
    const v2Response = await fetch(protocolUrl(base, 2));
    assert.equal(v2Response.status, 200);
    const v2 = await v2Response.json();
    assert.equal(v2.version, 2);
    assert.equal(v2.completeness, 'partial');
    assert.equal(v2.validation.ok, true);
    assert.equal(v2.revision, reader.revision);
    assert.deepEqual(v2.session, { provider: 'codex', sessionId: id });
    assert.equal(v2.tasks[0].status, 'unknown', 'NEW_TASK is an assignment, not completion');
    const v3Response = await fetch(protocolUrl(base, 3));
    assert.equal(v3Response.status, 200);
    const v3 = await v3Response.json();
    assert.equal(v3.version, 3);
    assert.equal(v3.validation.ok, true);
    assert.equal(v3.coverage.work.state, 'observed');
    assert.match(v3.coverage.work.details, /Recorded work facts are partial; unprojected activity remains unknown/);
    assert.equal(v3.completeness, 'partial');
    assert.deepEqual(v3.upgrade, { fromVersion: 2, strategy: 'v2-to-v3', preservesV2Facts: true });
    for (const key of ['session', 'revision', 'events', 'relationships', 'tasks', 'agentRuns',
      'contextArtifacts', 'branches']) assert.deepEqual(v3[key], v2[key], `v3 changed ${key}`);
    for (const domain of ['execution', 'coordination', 'ownership'])
      assert.equal(v3.coverage[domain].state, 'unknown');
    assert.equal(v3.coverage.usage.state, 'not-observed',
      'the validated source has no recorded request usage');

    const entries = [];
    let cursor;
    do {
      const response = await fetch(workUrl(base, { limit: 2, ...(cursor ? { cursor } : {}) }));
      assert.equal(response.status, 200);
      const page = await response.json();
      assert.equal(page.revision, reader.revision);
      assert.equal(page.coverage, 'partial');
      assert.ok(page.entries.length <= 2);
      entries.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length);
    const runs = entries.filter(entry => entry.type === 'agentRun');
    const observations = entries.filter(entry => entry.type === 'lifecycle');
    assert.equal(runs.find(entry => entry.turnId === 'ok')?.status, 'completed');
    assert.equal(runs.find(entry => entry.turnId === 'duplicate')?.pairing, 'ambiguous-start');
    assert.equal(runs.find(entry => entry.turnId === 'double-terminal')?.pairing, 'ambiguous-terminal');
    assert.equal(runs.find(entry => entry.turnId === 'failed')?.status, 'failed');
    assert.equal(runs.find(entry => entry.turnId === 'cancelled')?.status, 'cancelled');
    assert.equal(observations.find(entry => entry.turnId === 'orphan')?.pairing, 'orphan-terminal');
    assert.equal(observations.find(entry => entry.turnId === 'missing-time')?.pairing, 'unidentifiable');
    const failureEvidenceId = runs.find(entry => entry.turnId === 'failed').evidence.eventId;
    const evidenceUrl = `${base}/api/v3/runtime/codex/${id}/events/${encodeURIComponent(failureEvidenceId)}`;
    const evidenceResponse = await fetch(evidenceUrl + '?' + new URLSearchParams({ revision: reader.revision }));
    assert.equal(evidenceResponse.status, 200);
    const evidence = await evidenceResponse.json();
    assert.equal(evidence.event.id, failureEvidenceId);
    assert.equal(evidence.revision, reader.revision);
    assert.equal((await fetch(evidenceUrl + '?revision=stale')).status, 409);
    assert.equal(hash(source), before, 'native source must remain byte-identical');

    const first = await (await fetch(workUrl(base, { limit: 1 }))).json();
    assert.ok(first.nextCursor);
    const changedFilter = await fetch(workUrl(base, { limit: 1, status: 'failed', cursor: first.nextCursor }));
    assert.equal(changedFilter.status, 400);
    assert.equal((await changedFilter.json()).error.code, 'invalid_cursor');
    const failed = await (await fetch(workUrl(base, { status: 'failed' }))).json();
    assert.ok(failed.entries.length > 0 && failed.entries.every(entry => entry.status === 'failed'));
    assert.equal((await fetch(workUrl(base, { limit: 0 }))).status, 400);
    assert.equal((await fetch(workUrl(base, { limit: 201 }))).status, 400);
    await writeFile(source, readFileSync(source, 'utf8') + JSON.stringify(lifecycle('task_started', 'later', 700)) + '\n');
    const stale = await fetch(workUrl(base, { limit: 1, cursor: first.nextCursor }));
    assert.equal(stale.status, 400);
    assert.equal((await stale.json()).error.code, 'invalid_cursor');
  });

test('malformed interior Codex record makes protocol and Work explicitly invalid',
  { timeout: 30_000 }, async t => {
    const { base, source } = await setup(t, [lifecycle('task_started', 'valid', 100)]);
    const lines = readFileSync(source, 'utf8').trimEnd().split('\n');
    lines.splice(1, 0, '{not-json}');
    await writeFile(source, lines.join('\n') + '\n');
    const before = hash(source);
    for (const url of [protocolUrl(base, 2), protocolUrl(base, 3), workUrl(base)]) {
      const response = await fetch(url);
      assert.equal(response.status, 422);
      assert.equal((await response.json()).error.code, 'protocol_invalid');
    }
    assert.equal(hash(source), before);
  });

test('Work defaults to 50, caps at 200, and binds cursors to source scope',
  { timeout: 60_000 }, async t => {
    const rows = Array.from({ length: 230 }, (_, index) => lifecycle('task_started', `turn-${index}`, index + 1));
    const left = await setup(t, rows);
    const first = await (await fetch(workUrl(left.base))).json();
    assert.equal(first.entries.length, 50);
    assert.ok(first.nextCursor);
    const wide = await (await fetch(workUrl(left.base, { limit: 200 }))).json();
    assert.equal(wide.entries.length, 200);
    const right = await setup(t, rows);
    const crossScope = await fetch(workUrl(right.base, { cursor: first.nextCursor }));
    assert.equal(crossScope.status, 400);
    assert.equal((await crossScope.json()).error.code, 'invalid_cursor');
  });
