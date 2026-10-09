import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const id = '44444444-4444-4444-8444-444444444444';
const fixture = path.join(repo, 'v3', 'fixtures', 'codex', 'sessions', '2026', '09', '26',
  `rollout-2026-09-26T00-00-00-${id}.jsonl`);

function sessionCopyPath(codexDir, sourceFixture) {
  const parts = path.relative(path.join(repo, 'v3', 'fixtures'), sourceFixture).split(path.sep);
  const sessionsIndex = parts.lastIndexOf('sessions');
  return path.join(codexDir, ...parts.slice(sessionsIndex));
}

async function freePort() {
  return freeFetchSafePort();
}

async function setup(t) {
  await mkdir(path.join(repo, 'tmp'), { recursive: true });
  const work = await mkdtemp(path.join(repo, 'tmp', 'v3-projections-http-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const codexDir = path.join(work, 'codex');
  await mkdir(codexDir);
  const source = sessionCopyPath(codexDir, fixture);
  await mkdir(path.dirname(source), { recursive: true });
  for (const name of ['meta', 'index', 'cache', 'claude', 'pi'])
    await mkdir(path.join(work, name));
  const header = readFileSync(fixture, 'utf8').split('\n')[0];
  const rows = [
    { type: 'response_item', payload: { type: 'agent_message', id: 'assignment',
      content: [{ type: 'text', text: 'Message Type: NEW_TASK\nTask name: worker' }] } },
    ...Array.from({ length: 12 }, (_, index) => ({ type: 'event_msg', payload: {
      type: 'task_started', turn_id: `turn-${index}`, started_at: index + 1,
    } })),
  ];
  await writeFile(source, [header, ...rows.map(row => JSON.stringify(row))].join('\n') + '\n');
  const hash = () => createHash('sha256').update(readFileSync(source)).digest('hex');
  const port = await freePort();
  const child = spawn(binary, ['serve', '--port', String(port), '--codex-dir', codexDir,
    '--opencode-db', path.join(work, 'opencode.db'), '--claude-dir', path.join(work, 'claude'),
    '--pi-dir', path.join(work, 'pi'), '--dsh-dir', path.join(work, 'missing-dsh'),
    '--meta-dir', path.join(work, 'meta'), '--index-dir', path.join(work, 'index'),
    '--cache-dir', path.join(work, 'cache')], { cwd: repo, windowsHide: true, stdio: 'ignore' });
  t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'close'); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok)
      return { base, source, hash }; }
    catch { /* Axum is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Axum did not start');
}

async function setupCopiedFixture(t, name, sessionId, sourceFixture) {
  await mkdir(path.join(repo, 'tmp'), { recursive: true });
  const work = await mkdtemp(path.join(repo, 'tmp', `v3-${name}-http-`));
  t.after(() => rm(work, { recursive: true, force: true }));
  const codexDir = path.join(work, 'codex');
  await mkdir(codexDir);
  for (const dir of ['meta', 'index', 'cache', 'claude', 'pi'])
    await mkdir(path.join(work, dir));
  const source = sessionCopyPath(codexDir, sourceFixture);
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, readFileSync(sourceFixture));
  const hash = () => createHash('sha256').update(readFileSync(source)).digest('hex');
  const port = await freePort();
  const child = spawn(binary, ['serve', '--port', String(port), '--codex-dir', codexDir,
    '--opencode-db', path.join(work, 'opencode.db'), '--claude-dir', path.join(work, 'claude'),
    '--pi-dir', path.join(work, 'pi'), '--dsh-dir', path.join(work, 'missing-dsh'),
    '--meta-dir', path.join(work, 'meta'), '--index-dir', path.join(work, 'index'),
    '--cache-dir', path.join(work, 'cache')], { cwd: repo, windowsHide: true, stdio: 'ignore' });
  t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'close'); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok)
      return { base, source, hash, sessionId }; }
    catch { /* Axum is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Axum did not start');
}

const url = (base, name, query = {}) => {
  const result = new URL(`/api/v3/runtime/codex/${id}/${name}`, base);
  for (const [key, value] of Object.entries(query)) result.searchParams.set(key, String(value));
  return result;
};

const fixtureUrl = (base, sessionId, name, query = {}) => {
  const result = new URL(`/api/v3/runtime/codex/${sessionId}/${name}`, base);
  for (const [key, value] of Object.entries(query)) result.searchParams.set(key, String(value));
  return result;
};

test('Runtime summary and graph project separate recorded tasks and runs with bounded topology',
  { timeout: 30_000 }, async t => {
    const { base, hash, source } = await setup(t);
    const before = hash();
    const protocol = await (await fetch(`${base}/api/v3/protocol/codex/${id}?version=3`)).json();
    const summaryResponse = await fetch(url(base, 'summary'));
    assert.equal(summaryResponse.status, 200);
    const summary = await summaryResponse.json();
    assert.equal(summary.revision, protocol.revision);
    assert.deepEqual(summary.session, protocol.session);
    assert.equal(summary.completeness, 'partial');
    assert.equal(summary.validation.ok, true);
    assert.equal(summary.counts.tasks, protocol.tasks.length);
    assert.equal(summary.counts.agentRuns, protocol.agentRuns.length);
    assert.equal(summary.counts.events, protocol.events.length);
    assert.equal(summary.coverage.work.state, 'observed');
    assert.equal(summary.coverage.context.state, protocol.coverage.context.state);

    const graphResponse = await fetch(url(base, 'graph', { maxNodes: 3 }));
    assert.equal(graphResponse.status, 200);
    const graph = await graphResponse.json();
    assert.equal(graph.revision, protocol.revision);
    assert.equal(graph.nodes.length, 3);
    assert.equal(graph.truncated, true);
    assert.equal(graph.nodes[0].kind, 'session');
    assert.ok(graph.nodes.some(node => node.kind === 'task'));
    assert.ok(graph.nodes.some(node => node.kind === 'run'));
    assert.ok(graph.nodes.some(node => node.kind === 'run' && Number.isFinite(node.timeStart)));
    assert.ok(graph.nodes.every(node => node.kind !== 'run' || node.provenance?.fidelity === 'recorded'));
    assert.ok(graph.edges.every(edge => graph.nodes.some(node => node.id === edge.from)
      && graph.nodes.some(node => node.id === edge.to)));
    assert.equal((await fetch(url(base, 'graph', { maxNodes: 0 }))).status, 400);
    assert.equal((await fetch(url(base, 'graph', { maxNodes: 201 }))).status, 400);
    assert.equal(hash(), before, 'native source remains byte-identical');

    await writeFile(source, readFileSync(source, 'utf8') + JSON.stringify({ type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'later', started_at: 200 } }) + '\n');
    const changed = await (await fetch(url(base, 'summary'))).json();
    assert.notEqual(changed.revision, summary.revision);
    assert.equal(changed.counts.agentRuns, summary.counts.agentRuns + 1);
  });

test('malformed provider evidence makes summary and graph explicitly invalid',
  { timeout: 30_000 }, async t => {
    const { base, source, hash } = await setup(t);
    const lines = readFileSync(source, 'utf8').trimEnd().split('\n');
    lines.splice(1, 0, '{not-json}');
    await writeFile(source, lines.join('\n') + '\n');
    const before = hash();
    for (const name of ['summary', 'graph', 'execution', 'coordination', 'context']) {
      const response = await fetch(url(base, name));
      assert.equal(response.status, 422);
      assert.equal((await response.json()).error.code, 'protocol_invalid');
    }
    assert.equal(hash(), before);
  });

test('domain pages expose frozen Codex execution, coordination, and context evidence',
  { timeout: 45_000 }, async t => {
    const specs = [
      ['execution', '88888888-8888-4888-8888-888888888888',
        path.join(repo, 'v3', 'fixtures', 'codex-execution', 'sessions', '2026', '09', '27',
          'rollout-2026-09-27T01-00-00-88888888-8888-4888-8888-888888888888.jsonl'),
        'executionEvent'],
      ['coordination', '99999999-9999-4999-8999-999999999999',
        path.join(repo, 'v3', 'fixtures', 'codex-collaboration', 'sessions', '2026', '09', '27',
          'rollout-2026-09-27T00-00-00-99999999-9999-4999-8999-999999999999.jsonl'),
        'coordination'],
      ['context', '55555555-5555-4555-8555-555555555555',
        path.join(repo, 'v3', 'fixtures', 'codex-compaction', 'sessions', '2026', '09', '26',
          'rollout-2026-09-26T00-00-00-55555555-5555-4555-8555-555555555555.jsonl'),
        'contextObservation'],
    ];
    for (const [domain, sessionId, sourceFixture, expectedType] of specs) {
      const { base, hash } = await setupCopiedFixture(t, domain, sessionId, sourceFixture);
      const before = hash();
      const protocol = await (await fetch(`${base}/api/v3/protocol/codex/${sessionId}?version=3`)).json();
      const facts = [];
      let cursor;
      do {
        const response = await fetch(fixtureUrl(base, sessionId, domain,
          { limit: 2, ...(cursor ? { cursor } : {}) }));
        assert.equal(response.status, 200, domain);
        const page = await response.json();
        assert.equal(page.revision, protocol.revision);
        assert.equal(page.domainCoverage.state, protocol.coverage[domain].state);
        assert.ok(page.entries.length <= 2);
        facts.push(...page.entries);
        cursor = page.nextCursor;
      } while (cursor);
      assert.ok(facts.some(entry => entry.type === expectedType), domain);
      assert.ok(facts.every(entry => entry.fact.evidence?.provenance?.fidelity === 'recorded'
        || entry.fact.provenance?.fidelity === 'recorded'), domain);
      assert.equal(hash(), before, `${domain} source stayed read-only`);
    }
  });

test('graph retains recorded parent topology without claiming an unverified source resolves',
  { timeout: 30_000 }, async t => {
    const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const sourceFixture = path.join(repo, 'v3', 'fixtures', 'codex-three-level', 'sessions',
      '2026', '09', '27', `rollout-2026-09-27T00-01-00-${sessionId}.jsonl`);
    const { base, hash } = await setupCopiedFixture(t, 'graph-parent', sessionId, sourceFixture);
    const before = hash();
    const protocol = await (await fetch(`${base}/api/v3/protocol/codex/${sessionId}?version=3`)).json();
    assert.equal(protocol.relationships.length, 1);
    const response = await fetch(fixtureUrl(base, sessionId, 'graph', { maxNodes: 50 }));
    assert.equal(response.status, 200);
    const graph = await response.json();
    assert.equal(graph.revision, protocol.revision);
    const relation = protocol.relationships[0];
    const edge = graph.edges.find(item => item.type === relation.kind);
    assert.ok(edge);
    assert.equal(edge.provenance.fidelity, 'recorded');
    assert.equal(graph.nodes.find(node => node.id === edge.from)?.session.sessionId,
      relation.from.sessionId);
    assert.equal(graph.nodes.find(node => node.id === edge.to)?.session.sessionId,
      relation.to.sessionId);
    assert.equal(graph.nodes.find(node => node.id === edge.from)?.resolution, 'unverified');
    assert.equal(hash(), before);
  });

test('execution, coordination, and context pages keep recorded facts and revision-bound cursors',
  { timeout: 30_000 }, async t => {
    const { base, source } = await setup(t);
    const protocol = await (await fetch(`${base}/api/v3/protocol/codex/${id}?version=3`)).json();
    const firstResponse = await fetch(url(base, 'execution', { limit: 2 }));
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.equal(first.revision, protocol.revision);
    assert.equal(first.domainCoverage.state, protocol.coverage.execution.state);
    assert.equal(first.entries.length, 2);
    assert.ok(first.entries.every(entry => entry.type === 'agentRun'));
    assert.ok(first.entries.every(entry => entry.fact.evidence.provenance.fidelity === 'recorded'));
    assert.ok(first.nextCursor);
    const second = await (await fetch(url(base, 'execution', { limit: 2,
      cursor: first.nextCursor }))).json();
    assert.equal(second.entries.length, 2);
    assert.notEqual(second.entries[0].fact.id, first.entries[0].fact.id);
    const changedFilter = await fetch(url(base, 'execution', { limit: 2,
      kind: 'session-turn', cursor: first.nextCursor }));
    assert.equal(changedFilter.status, 400);
    assert.equal((await changedFilter.json()).error.code, 'invalid_cursor');
    for (const domain of ['coordination', 'context']) {
      const response = await fetch(url(base, domain));
      assert.equal(response.status, 200);
      const page = await response.json();
      assert.equal(page.revision, protocol.revision);
      assert.equal(page.domainCoverage.state, protocol.coverage[domain].state);
      assert.deepEqual(page.entries, []);
      assert.equal(page.nextCursor, null);
    }
    for (const domain of ['execution', 'coordination', 'context']) {
      assert.equal((await fetch(url(base, domain, { limit: 0 }))).status, 400);
      assert.equal((await fetch(url(base, domain, { limit: 201 }))).status, 400);
    }
    await writeFile(source, readFileSync(source, 'utf8') + JSON.stringify({ type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'later', started_at: 200 } }) + '\n');
    const stale = await fetch(url(base, 'execution', { limit: 2, cursor: first.nextCursor }));
    assert.equal(stale.status, 400);
    assert.equal((await stale.json()).error.code, 'invalid_cursor');
  });
