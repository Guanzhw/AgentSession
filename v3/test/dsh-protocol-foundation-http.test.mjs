import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { decodeSourceBytes } from '../../scripts/v3-source-ledger.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const provider = 'deepseek-harness';
const rootId = 'dsh-v3-s2-root';
const alphaId = 'dsh-v3-s2-alpha';
const betaId = 'dsh-v3-s2-beta';
const fixtureRoot = path.join(repo, 'v3', 'fixtures', provider, 'sessions', 's2-synthetic');
const legacyFixture = path.join(repo, 'test', 'fixtures', 'dsh-rc8-fresh-round-trip.jsonl');
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const sessionRef = sessionId => ({ provider, sessionId });

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = await response.json();
  assert.equal(response.status, 200, `${url}: ${JSON.stringify(body)}`);
  return body;
}

// All generated or modified sources live under this test's ignored tmp directory.
// The hash ledger also checks the checked-in originals, including on a RED exit.
async function setup(t, prepare = async () => {}) {
  assert.ok(existsSync(binary), `Build ${binary} before running this test`);
  await mkdir(path.join(repo, 'tmp'), { recursive: true });
  const state = await mkdtemp(path.join(repo, 'tmp', 'v3-dsh-foundation-http-'));
  const ledger = new Map();
  let child;
  t.after(async () => {
    try {
      if (child) {
        child.kill();
        if (child.exitCode === null && child.signalCode === null) await once(child, 'close');
      }
      for (const [file, before] of ledger) assert.equal(sha(file), before, `Source changed: ${file}`);
    } finally {
      const resolvedState = path.resolve(state);
      const resolvedTmp = path.resolve(repo, 'tmp');
      assert.equal(path.dirname(resolvedState), resolvedTmp, 'Cleanup target must remain inside repository tmp');
      assert.ok(path.basename(resolvedState).startsWith('v3-dsh-foundation-http-'),
        'Cleanup target must retain this test prefix');
      await rm(resolvedState, { recursive: true, force: true });
    }
  });
  const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']
    .map(name => [name, path.join(state, name)]));
  for (const dir of Object.values(dirs)) await mkdir(dir);
  const sourcePath = (id, name = 'session.v3.jsonl.zstd') => path.join(dirs.dsh, 'sessions', id, name);
  const put = async (id, name, bytes) => {
    const destination = sourcePath(id, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    ledger.set(destination, sha(destination));
    return destination;
  };
  for (const id of [rootId, alphaId, betaId]) {
    const original = path.join(fixtureRoot, id, 'session.v3.jsonl.zstd');
    ledger.set(original, sha(original));
    const destination = sourcePath(id);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(original, destination);
    ledger.set(destination, sha(destination));
  }
  await prepare({ put, ledger });
  const port = await freeFetchSafePort();
  child = spawn(binary, ['serve', '--port', String(port),
    '--codex-dir', dirs.codex, '--claude-dir', dirs.claude, '--pi-dir', dirs.pi,
    '--dsh-dir', dirs.dsh, '--opencode-db', path.join(state, 'missing-opencode.db'),
    '--meta-dir', dirs.meta, '--index-dir', dirs.index, '--cache-dir', dirs.cache],
  { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  const started = performance.now();
  let lastProbe = 'not attempted';
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      const response = await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return base;
      lastProbe = `HTTP ${response.status}`;
    } catch (error) {
      lastProbe = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Isolated DSH HTTP server did not start after ${Math.round(performance.now() - started)}ms; ` +
    `exitCode=${child.exitCode}, signalCode=${child.signalCode}; last probe: ${lastProbe}; ` +
    `stderr: ${stderr.trim() || '(none)'}`);
}

const documentUrl = (base, id, version) => `${base}/api/v3/protocol/${provider}/${id}?version=${version}`;
const readerUrl = (base, id) => `${base}/api/v3/reader/${provider}/${id}/bootstrap`;

async function sameSourceFacts(base, id) {
  const reader = await json(readerUrl(base, id));
  const v2 = await json(documentUrl(base, id, 2));
  const v3 = await json(documentUrl(base, id, 3));
  for (const [version, document] of [[2, v2], [3, v3]]) {
    assert.equal(document.version, version);
    assert.equal(document.validation.ok, true);
    assert.equal(document.completeness, 'partial');
    assert.deepEqual(document.session, sessionRef(id));
    assert.equal(document.revision, reader.revision);
  }
  for (const key of ['session', 'revision', 'events', 'tasks', 'agentRuns', 'relationships',
    'contextArtifacts', 'branches']) assert.deepEqual(v3[key], v2[key], `v3 changed ${key}`);
  assert.deepEqual(v3.upgrade, { fromVersion: 2, strategy: 'v2-to-v3', preservesV2Facts: true });
  const events = [];
  let cursor;
  do {
    const query = new URLSearchParams({ limit: '200', ...(cursor ? { cursor } : {}) });
    const page = await json(`${base}/api/v3/runtime/${provider}/${id}/events?${query}`);
    assert.equal(page.revision, v2.revision);
    events.push(...page.events);
    assert.notEqual(page.nextCursor, cursor, 'Event pagination must advance');
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(v2.events, events, 'Document must preserve the existing source event stream');
  return { reader, v2, v3 };
}

test('DSH root v2/v3 foundation preserves all 29 source events and same-source facts',
  { timeout: 60_000 }, async t => {
    const base = await setup(t);
    const { v2 } = await sameSourceFacts(base, rootId);
    assert.equal(v2.events.length, 29);
    assert.deepEqual(v2.events.map(event => event.id), ['event:dsh:header',
      ...Array.from({ length: 28 }, (_, seq) => `event:dsh:${seq}`)]);
    assert.deepEqual(v2.events.map(event => event.sourceOrder.record),
      Array.from({ length: 29 }, (_, index) => index));
    assert.deepEqual(v2.events[0].provenance,
      { fidelity: 'recorded', sourceType: 'dsh.session.header', sourceId: rootId });
    assert.deepEqual(v2.relationships, []);
  });

test('DSH child foundations preserve eight events and only the recorded header parent',
  { timeout: 60_000 }, async t => {
    const base = await setup(t);
    for (const id of [alphaId, betaId]) {
      const { v2, v3 } = await sameSourceFacts(base, id);
      assert.equal(v2.events.length, 8);
      assert.equal(v2.events.at(-1).id, 'event:dsh:6');
      assert.equal(v2.relationships.length, 1);
      const relation = v2.relationships[0];
      assert.equal(relation.kind, 'parent');
      assert.deepEqual(relation.from, sessionRef(rootId));
      assert.deepEqual(relation.to, sessionRef(id));
      assert.equal(relation.evidence.eventId, 'event:dsh:header');
      assert.deepEqual(relation.evidence.provenance,
        { fidelity: 'recorded', sourceType: 'dsh.session.header', sourceId: id });
      assert.deepEqual(v2.tasks, []);
      assert.deepEqual(v2.agentRuns, []);
      assert.deepEqual(v3.coordination, []);
      assert.equal(v3.coverage.coordination.state, 'not-observed');
    }
  });

test('DSH preserves team and workflow events while only native team tasks populate Work',
  { timeout: 60_000 }, async t => {
    const base = await setup(t);
    const { v3 } = await sameSourceFacts(base, rootId);
    for (const [kind, count] of [['team.task', 4], ['team.message.queued', 4],
      ['team.message.delivered', 4], ['tool-workflow.agent-start', 2], ['tool-workflow.agent-end', 2]]) {
      assert.equal(v3.events.filter(event => event.kind === kind).length, count, kind);
    }
    for (const key of ['agentRuns', 'goals', 'actors',
      'contextVersions', 'contextTransformations', 'usageRecords']) assert.deepEqual(v3[key], [], key);
    assert.equal(v3.coverage.usage.state, 'not-observed');
    for (const domain of ['agentRuns', 'execution', 'context']) {
      assert.equal(v3.coverage[domain]?.state, 'unknown', `${domain} is not yet projected`);
      assert.ok(v3.coverage[domain].details.length > 0, `${domain} needs an explanation`);
    }
  });

test('DSH foundation uses the current v0/v3 source selection for every projection',
  { timeout: 60_000 }, async t => {
    const legacyId = 'dsh-foundation-legacy';
    const base = await setup(t, async ({ put, ledger }) => {
      ledger.set(legacyFixture, sha(legacyFixture));
      const legacy = id => readFileSync(legacyFixture, 'utf8')
        .replaceAll('{{sessionId}}', id).replaceAll('{{cwd}}', 'C:');
      await put(legacyId, 'session.jsonl.zstd', zstdCompressSync(legacy(legacyId)));
      // Both generations use Zstd: mixed raw/Zstd is intentionally ambiguous today.
      await put(rootId, 'session.jsonl.zstd', zstdCompressSync(legacy(rootId)));
    });
    const legacy = await sameSourceFacts(base, legacyId);
    assert.ok(legacy.v2.events.length > 29, 'Standalone legacy source must remain readable');
    assert.ok(legacy.reader.segments.flatMap(page => page.items).some(item => item.preview === 'DONE'));
    assert.equal(legacy.v3.coverage.usage.state, 'observed');
    assert.ok(legacy.v3.usageRecords.every(row => row.modelProvider === 'deepseek-official'));
    // rc8 settlements omit cacheWriteTokens and totalTokens; their total is not fully recorded.
    assert.deepEqual(legacy.v3.usageRecords.map(row => ({ eventId: row.eventId,
      turnId: row.turnId, model: row.model, tokens: row.tokens })), [
      { eventId: 'event:dsh:55', turnId: '1', model: 'deepseek-v4-flash',
        tokens: { input: 122, cacheRead: 7680, cacheWrite: null,
          output: 68, reasoning: 17, total: null } },
      { eventId: 'event:dsh:91', turnId: '1', model: 'deepseek-v4-flash',
        tokens: { input: 97, cacheRead: 7808, cacheWrite: null,
          output: 3, reasoning: 23, total: null } },
    ]);
    const selected = await sameSourceFacts(base, rootId);
    assert.equal(selected.v2.events.length, 29, 'Highest supported stored generation wins');
    assert.equal(selected.v2.events.at(-1).id, 'event:dsh:27');
    assert.ok(selected.reader.segments.flatMap(page => page.items)
      .some(item => item.event.messageId === 'root-user'));
    assert.equal(selected.v2.events.some(event => event.readerEvent?.messageId === 'assistant:91'), false);
  });

test('DSH malformed source cannot produce a validated foundation',
  { timeout: 60_000 }, async t => {
    const id = 'dsh-foundation-bad-sequence';
    const base = await setup(t, async ({ put }) => {
      const rows = [
        { type: 'session', version: 3, id, createdAt: 100, isSeeded: false },
        { type: 'turn/start', seq: 0, time: 101, data: { turn: 1 } },
        { type: 'turn/end', seq: 2, time: 102, data: { turn: 1, reason: { kind: 'completed' } } },
      ];
      await put(id, 'session.v3.jsonl', rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    });
    for (const version of [2, 3]) {
      const response = await fetch(documentUrl(base, id, version));
      const body = await response.json();
      // Source parse failures currently use source_error; protocol-boundary
      // normalization may instead classify this as protocol_invalid.
      assert.ok([500, 422].includes(response.status), JSON.stringify(body));
      assert.ok(['source_error', 'protocol_invalid'].includes(body.error?.code), JSON.stringify(body));
      assert.match(body.error.message, /non-contiguous DSH seq/);
      assert.notEqual(body.validation?.ok, true);
    }
  });

 test('DSH latest team task revisions become bounded source-anchored Work', { timeout: 60_000 }, async t => {
  const base = await setup(t);
  const { v3 } = await sameSourceFacts(base, rootId);
  assert.equal(v3.tasks.length, 2);
  assert.deepEqual(v3.tasks.map(task => [task.id, task.kind, task.status, task.evidence.eventId]), [
    ['team:beta', 'team-task', 'completed', 'event:dsh:18'],
    ['team:alpha', 'team-task', 'completed', 'event:dsh:20'],
  ]);
  assert.ok(v3.tasks.every(task => task.timeCreated === null));
  assert.deepEqual(v3.agentRuns, []);
  assert.equal(v3.coverage.tasks.state, 'observed');
  assert.equal(v3.coverage.work.state, 'observed');
  const endpoint = `${base}/api/v3/runtime/${provider}/${rootId}/work`;
  const first = await json(`${endpoint}?limit=1`);
  const second = await json(`${endpoint}?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`);
  assert.deepEqual(first.domainCoverage, v3.coverage.work);
  assert.deepEqual(second.domainCoverage, v3.coverage.work);
  assert.equal(first.revision, v3.revision);
  assert.equal(second.revision, v3.revision);
  assert.equal(first.scannedEntries, 1);
  assert.equal(second.scannedEntries, 1);
  assert.equal(second.nextCursor, null);
  assert.deepEqual([...first.entries, ...second.entries].map(row => row.id), ['team:beta', 'team:alpha']);
  for (const row of [...first.entries, ...second.entries]) {
    assert.equal(row.type, 'task');
    assert.equal(row.status, 'completed');
    assert.equal(row.evidence.provenance.sourceType, 'dsh.session-event:team/task');
    assert.equal(row.evidence.provenance.fidelity, 'recorded');
    assert.ok(v3.events.some(event => event.id === row.evidence.eventId));
  }
  const mismatch = await fetch(`${endpoint}?limit=1&status=completed&cursor=${encodeURIComponent(first.nextCursor)}`);
  assert.equal(mismatch.status, 400);
});


test('DSH pending team task preserves unknown status instead of inventing completion', { timeout: 60_000 }, async t => {
  const id = 'dsh-work-pending';
  const base = await setup(t, async ({ put }) => {
    const rows = [
      { type: 'session', version: 3, id, createdAt: 100, isSeeded: false },
      { type: 'team/task', seq: 0, time: 101, data: { version: 2, teamId: id,
        task: { id: 'pending', revision: 1, subject: 'Pending recorded task', status: 'pending', ownerId: id } } },
    ];
    await put(id, 'session.v3.jsonl', rows.map(JSON.stringify).join('\n') + '\n');
  });
  const { v3 } = await sameSourceFacts(base, id);
  assert.equal(v3.tasks.length, 1);
  assert.equal(v3.tasks[0].status, 'unknown');
  assert.equal(v3.tasks[0].timeCreated, null);
  assert.equal(v3.tasks[0].evidence.eventId, 'event:dsh:0');
  assert.deepEqual(v3.agentRuns, []);
});

test('DSH v3 publishes a source-owned request with missing cache write kept unknown',
  { timeout: 60_000 }, async t => {
    const id = 'dsh-usage-recorded';
    const base = await setup(t, async ({ put }) => {
      const rows = [
        { type: 'session', version: 3, id, createdAt: 100, isSeeded: false },
        { type: 'assistant/message', seq: 0, time: 101, surfaceOp: 'append',
          data: { turn: 1, step: 1, message: { id: 'response-1', role: 'assistant',
            source: { kind: 'model', model: 'deepseek-v4' },
            content: [{ type: 'text', text: 'Recorded answer' }] },
          usage: { inputTokens: 3, outputTokens: 4, reasoningTokens: 1,
            cacheReadTokens: 5, totalTokens: 12 } } },
      ];
      await put(id, 'session.v3.jsonl', rows.map(JSON.stringify).join('\n') + '\n');
    });
    const { v3 } = await sameSourceFacts(base, id);
    assert.deepEqual(v3.usageRecords, [{
      id: `usage:dsh:${id}:0`, scope: 'request', sessionRef: sessionRef(id),
      timestamp: 101, model: 'deepseek-v4', runId: null, eventId: 'event:dsh:0',
      turnId: '1', tokens: { input: 3, cacheRead: 5, cacheWrite: null,
        output: 3, reasoning: 1, total: 12 }, contextOriginSlices: [],
      provenance: { fidelity: 'recorded',
        sourceType: 'dsh.session-event:assistant/message:usage', sourceId: '0' },
    }]);
    assert.equal(v3.coverage.usage.state, 'observed');
    const listed = await json(`${base}/api/v3/sessions?provider=${provider}`);
    assert.equal(listed.find(row => row.session.sessionId === id)?.tokenCount, 12);
  });

test('DSH recorded model provider stays with the selected model source and usage settlement',
  { timeout: 60_000 }, async t => {
    const id = 'dsh-provider-recorded';
    const sample = { inputTokens: 3, outputTokens: 4, reasoningTokens: 1,
      cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 7 };
    const settlement = (seq, step, source, extra = {}) => ({ type: 'assistant/message',
      seq, time: 101 + seq, surfaceOp: 'append', data: { turn: 1, step,
        message: { id: `response-${seq}`, role: 'assistant', source,
          content: [{ type: 'text', text: 'Recorded answer' }] }, usage: sample, ...extra } });
    const base = await setup(t, async ({ put }) => {
      const rows = [{ type: 'session', version: 3, id, createdAt: 100, isSeeded: false },
        { type: 'assistant/attempt', seq: 0, time: 101, data: { turn: 1, step: 1,
          source: { kind: 'model', model: 'attempt-model', provider: 'attempt-vendor' },
          stream: [{ type: 'usage', usage: sample }] } },
        settlement(1, 1, { kind: 'model', model: 'settled-model', provider: 'settled-vendor' }),
        settlement(2, 2, { kind: 'model', model: 'unknown-provider-model' },
          { source: { kind: 'model', model: 'other-model', provider: 'other-vendor' } }),
      ];
      await put(id, 'session.v3.jsonl', rows.map(JSON.stringify).join('\n') + '\n');
    });
    const { v3 } = await sameSourceFacts(base, id);
    assert.deepEqual(v3.usageRecords.map(record => [record.model, record.modelProvider ?? null,
      record.provenance.sourceId, record.tokens.total]), [
      ['settled-model', 'settled-vendor', '1', 7],
      ['unknown-provider-model', null, '2', 7],
    ]);
  });

test('DSH recorded Reader coordination appears in v3 Runtime with exact source anchors',
  { timeout: 60_000 }, async t => {
    const base = await setup(t);
    const { reader, v3 } = await sameSourceFacts(base, rootId);
    const raw = decodeSourceBytes(readFileSync(path.join(fixtureRoot, rootId,
      'session.v3.jsonl.zstd'))).records.map(({ value }) => value);
    const expected = raw.filter(row => [
      'team/message/queued', 'team/message/delivered',
      'tool-workflow/agent-start', 'tool-workflow/agent-end',
    ].includes(row.type));
    assert.equal(expected.length, 12);
    assert.deepEqual(expected.map(row => row.seq),
      [8, 9, 10, 11, 12, 13, 15, 16, 17, 19, 21, 22]);
    const relations = [];
    let cursor = reader.relations.firstCursor;
    while (cursor) {
      const page = await json(`${readerUrl(base, rootId).replace('/bootstrap', '/relations')}`
        + `?cursor=${encodeURIComponent(cursor)}`);
      assert.equal(page.revision, reader.revision);
      relations.push(...page.entries.filter(entry => entry.type === 'coordination')
        .map(entry => entry.observation));
      cursor = page.nextCursor;
    }
    assert.equal(relations.length, expected.length);
    const endpoint = `${base}/api/v3/runtime/${provider}/${rootId}/coordination`;
    const runtime = await json(`${endpoint}?limit=200`);
    assert.equal(runtime.revision, v3.revision);
    assert.deepEqual(runtime.domainCoverage, v3.coverage.coordination);
    assert.equal(runtime.nextCursor, null);
    assert.equal(runtime.scannedEntries, expected.length);
    assert.equal(v3.coverage.coordination.state, 'observed');
    assert.equal(v3.agentRuns.length, 0, 'Workflow correlation is not AgentRun identity');
    assert.deepEqual(v3.coordination.map(fact => fact.id),
      expected.map(row => `coordination:event:dsh:${row.seq}`));
    assert.deepEqual(runtime.entries.map(entry => entry.sourceOrder.record),
      expected.map(row => row.seq + 1));
    assert.deepEqual(v3.coordination.map(fact => [fact.kind, fact.state,
      fact.correlationId, fact.fromSessionRef?.sessionId, fact.toSessionRef?.sessionId]), [
      ['message', 'requested', 'mail-alpha-initial', rootId, alphaId],
      ['mailbox-delivery', 'delivered', 'mail-alpha-initial', rootId, alphaId],
      ['spawn', 'started', 'parallel-inspection:1', rootId, alphaId],
      ['message', 'requested', 'mail-beta-initial', rootId, betaId],
      ['mailbox-delivery', 'delivered', 'mail-beta-initial', rootId, betaId],
      ['spawn', 'started', 'parallel-inspection:2', rootId, betaId],
      ['message', 'requested', 'mail-alpha-followup', rootId, alphaId],
      ['mailbox-delivery', 'delivered', 'mail-alpha-followup', rootId, alphaId],
      ['spawn', 'completed', 'parallel-inspection:2', rootId, betaId],
      ['spawn', 'completed', 'parallel-inspection:1', rootId, alphaId],
      ['message', 'requested', 'mail-alpha-return', alphaId, rootId],
      ['mailbox-delivery', 'delivered', 'mail-alpha-return', alphaId, rootId],
    ]);
    for (const [index, row] of expected.entries()) {
      const relation = relations[index];
      const fact = v3.coordination[index];
      const entry = runtime.entries[index];
      const source = { fidelity: 'recorded',
        sourceType: `dsh.session-event:${row.type}`, sourceId: String(row.seq) };
      assert.equal(entry.type, 'coordination');
      assert.deepEqual(entry.fact, fact);
      assert.equal(entry.kind, relation.kind);
      assert.deepEqual([fact.kind, fact.state, fact.correlationId],
        [relation.kind, relation.state, relation.correlationId]);
      assert.deepEqual(fact.evidence,
        { eventId: `event:dsh:${row.seq}`, provenance: source });
      assert.deepEqual(relation.provenance,
        source);
      assert.deepEqual(fact.readerEvent ?? null, relation.readerEvent ?? null);
      assert.deepEqual([fact.fromActorPath, fact.toActorPath],
        [relation.fromActorPath ?? null, relation.toActorPath ?? null]);
      assert.deepEqual([fact.fromSessionRef, fact.toSessionRef],
        [relation.fromSessionRef, relation.toSessionRef]);
      assert.ok(v3.events.some(event => event.id === fact.evidence.eventId
        && event.provenance.sourceId === source.sourceId));
    }
  });

test('DSH workflow start without an end stays started in Runtime Coordination',
  { timeout: 60_000 }, async t => {
    const id = 'dsh-coordination-open';
    const childId = 'dsh-coordination-child';
    const base = await setup(t, async ({ put }) => {
      const rows = [
        { type: 'session', version: 3, id, createdAt: 100, isSeeded: false },
        { type: 'tool-workflow/agent-start', seq: 0, time: 101,
          data: { runId: 'inspection', seq: 1, childId } },
      ];
      await put(id, 'session.v3.jsonl', rows.map(JSON.stringify).join('\n') + '\n');
    });
    const { reader, v3 } = await sameSourceFacts(base, id);
    const page = await json(`${readerUrl(base, id).replace('/bootstrap', '/relations')}`
      + `?cursor=${encodeURIComponent(reader.relations.firstCursor)}`);
    const relation = page.entries.find(entry => entry.type === 'coordination').observation;
    const runtime = await json(`${base}/api/v3/runtime/${provider}/${id}/coordination?limit=10`);
    assert.deepEqual(v3.agentRuns, []);
    assert.deepEqual(v3.coordination.map(fact => [fact.kind, fact.state,
      fact.correlationId, fact.fromSessionRef, fact.toSessionRef,
      fact.evidence.eventId]), [[
      'spawn', 'started', 'inspection:1', sessionRef(id), sessionRef(childId), 'event:dsh:0',
    ]]);
    assert.equal(v3.coverage.coordination.state, 'observed');
    assert.equal(relation.state, 'started');
    assert.deepEqual(runtime.entries.map(entry => entry.fact), v3.coordination);
  });

test('DSH v3 folds attempts into settlements and keeps retry slots as distinct requests',
  { timeout: 60_000 }, async t => {
    const id = 'dsh-usage-retry';
    const usage = (input, output) => ({ inputTokens: input, outputTokens: output,
      cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: input + output });
    const message = (seq, time, step, tokens) => ({ type: 'assistant/message', seq, time,
      surfaceOp: 'append', data: { turn: 1, step, message: { id: `response-${seq}`,
        role: 'assistant', source: { kind: 'model', model: 'deepseek-v4' },
        content: [{ type: 'text', text: `Answer ${seq}` }] }, usage: tokens } });
    const base = await setup(t, async ({ put }) => {
      const rows = [
        { type: 'session', version: 3, id, createdAt: 100, isSeeded: false },
        { type: 'assistant/attempt', seq: 0, time: 101, data: { turn: 1, step: 1,
          stream: [{ type: 'usage', usage: usage(1, 2) }] } },
        message(1, 102, 1, usage(3, 4)),
        { type: 'llm/retry-started', seq: 2, time: 103, data: { turn: 1, step: 1, retry: 1 } },
        { type: 'assistant/attempt', seq: 3, time: 104, data: { turn: 1, step: 1,
          stream: [{ type: 'usage', usage: usage(5, 6) }] } },
        message(4, 105, 1, usage(7, 8)),
        message(5, 106, 2, { ...usage(1, 2), totalTokens: 999 }),
        message(6, 107, 3, usage(0, 0)),
      ];
      await put(id, 'session.v3.jsonl', rows.map(JSON.stringify).join('\n') + '\n');
    });
    const { v3 } = await sameSourceFacts(base, id);
    assert.deepEqual(v3.usageRecords.map(row => [row.id, row.eventId, row.turnId,
      row.tokens.total, row.provenance.sourceId]), [
      [`usage:dsh:${id}:1`, 'event:dsh:1', '1', 7, '1'],
      [`usage:dsh:${id}:4`, 'event:dsh:4', '1', 15, '4'],
      [`usage:dsh:${id}:6`, 'event:dsh:6', '1', 0, '6'],
    ]);
    assert.equal(v3.coverage.usage.state, 'observed');
    assert.ok(v3.validation.warnings.some(row => row.code === 'invalid_dsh_request_usage'
      && row.event_id === 'event:dsh:5'));
    const listed = await json(`${base}/api/v3/sessions?provider=${provider}`);
    assert.equal(listed.find(row => row.session.sessionId === id)?.tokenCount, 22);
  });

const frozenRoot = process.env.AGENTSESSION_V3_DSH_FROZEN_ROOT || path.join(repo, 'tmp', 'v3-corpus', provider);
test('frozen DSH v3 request usage matches every independently decoded settlement',
  { skip: !existsSync(frozenRoot), timeout: 60_000 }, async t => {
    const file = readdirSync(frozenRoot, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name === 'session.v3.jsonl.zstd')
      .map(entry => path.join(entry.parentPath, entry.name))[0];
    assert.ok(file, 'frozen v3 source is required');
    const before = sha(file);
    const rows = decodeSourceBytes(readFileSync(file)).records.map(({ value }) => value);
    const id = rows[0].id;
    const settlements = rows.filter(row => row.type === 'assistant/message' && row.data?.usage);
    assert.equal(settlements.length, 508, 'frozen source settlement count');
    const slots = new Set(settlements.map(row => `${row.data.turn}:${row.data.step}`));
    assert.equal(slots.size, settlements.length, 'this frozen source has unambiguous slots');
    assert.equal(rows.filter(row => row.type === 'assistant/attempt'
      || row.type === 'llm/retry-started').length, 0);
    const expected = settlements.map(row => {
      const raw = row.data.usage;
      assert.equal(raw.totalTokens,
        raw.inputTokens + raw.cacheReadTokens + raw.outputTokens);
      return { id: `usage:dsh:${id}:${row.seq}`, sourceId: String(row.seq),
        eventId: `event:dsh:${row.seq}`, turnId: String(row.data.turn),
        timestamp: row.time, model: row.data.message.source.model,
        modelProvider: row.data.message.source.provider,
        tokens: { input: raw.inputTokens, cacheRead: raw.cacheReadTokens,
          cacheWrite: null, output: raw.outputTokens - raw.reasoningTokens,
          reasoning: raw.reasoningTokens, total: raw.totalTokens } };
    });
    const base = await setup(t, async ({ put, ledger }) => {
      ledger.set(file, before);
      await put(id, path.basename(file), readFileSync(file));
    });
    const v3 = await json(documentUrl(base, id, 3));
    assert.equal(v3.validation.ok, true);
    assert.equal(v3.coverage.usage.state, 'observed');
    assert.deepEqual(v3.usageRecords.map(row => ({ id: row.id,
      sourceId: row.provenance.sourceId, eventId: row.eventId,
      turnId: row.turnId, timestamp: row.timestamp, model: row.model,
      modelProvider: row.modelProvider,
      tokens: row.tokens })), expected);
    const expectedTotal = expected.reduce((total, row) => total + row.tokens.total, 0);
    assert.equal(expectedTotal, 102197093);
    const listed = await json(`${base}/api/v3/sessions?provider=${provider}`);
    assert.equal(listed.find(row => row.session.sessionId === id)?.tokenCount, expectedTotal);
    assert.equal(sha(file), before);
  });

test('frozen DSH Work agrees with raw latest task records and leaves sources unchanged',
  { skip: !existsSync(frozenRoot), timeout: 60_000 }, async t => {
    const files = readdirSync(frozenRoot, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && /^session(?:\.v3)?\.jsonl\.zstd$/.test(entry.name))
      .map(entry => path.join(entry.parentPath, entry.name));
    assert.ok(files.length > 0);
    const ids = new Map();
    const base = await setup(t, async ({ put, ledger }) => {
      for (const file of files) {
        ledger.set(file, sha(file));
        const id = path.basename(path.dirname(file));
        await put(id, path.basename(file), readFileSync(file));
        if (!ids.has(id) || file.endsWith('session.v3.jsonl.zstd')) ids.set(id, file);
      }
    });
    for (const [id, file] of ids) {
      const latest = new Map();
      for (const row of zstdDecompressSync(readFileSync(file)).toString().trim().split('\n').map(JSON.parse)) {
        if (row.type === 'team/task') latest.set(`team:${row.data.task.id}`, row);
      }
      const { v3 } = await sameSourceFacts(base, id);
      assert.equal(v3.tasks.length, latest.size);
      assert.deepEqual(v3.agentRuns, []);
      for (const task of v3.tasks) {
        const row = latest.get(task.id);
        assert.equal(task.evidence.eventId, `event:dsh:${row.seq}`);
        assert.equal(task.status, row.data.task.status === 'completed' ? 'completed' : 'unknown');
      }
      const work = await json(`${base}/api/v3/runtime/${provider}/${id}/work?limit=200`);
      assert.equal(work.revision, v3.revision);
      assert.deepEqual(work.domainCoverage, v3.coverage.work);
      assert.equal(work.entries.length, latest.size);
      assert.equal(work.nextCursor, null);
    }
  });
