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

function assertCapability(actual, expected, message) {
  const { details, ...shape } = actual;
  assert.deepEqual(shape, expected, message);
  if (expected.support !== 'none')
    assert.ok(typeof details === 'string' && details.length > 0,
      message || 'supported capability includes source detail');
}

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const fixture = name => path.join(repo, 'test/fixtures', name);
const frozen = path.join(repo, 'tmp/v3-corpus/claude-code/projects/D--WorkSpace-OpenSession',
  '5bd5ca2d-5614-4873-9023-f34f4b3c432e.jsonl');
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const rowsOf = text => text.split('\n').map((line, index) => ({ line: line.trim(), index }))
  .filter(row => row.line).map(row => ({ record: JSON.parse(row.line), index: row.index }));

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = await response.json();
  assert.equal(response.status, 200, `${url}: ${JSON.stringify(body)}`);
  return body;
}

async function setup(t, original, transform = text => text) {
  assert.ok(existsSync(binary), `Build ${binary}`);
  await mkdir(path.join(repo, 'tmp'), { recursive: true });
  const state = await mkdtemp(path.join(repo, 'tmp/v3-claude-foundation-'));
  const originalHash = sha(original);
  const text = transform(readFileSync(original, 'utf8'));
  const id = original === frozen ? path.basename(original, '.jsonl') : 'source-session';
  const source = path.join(state, 'claude/transcripts', `${id}.jsonl`);
  let child;
  let sourceHash;
  t.after(async () => {
    try {
      if (child) {
        child.kill();
        if (child.exitCode === null && child.signalCode === null) await once(child, 'close');
      }
      assert.equal(sha(original), originalHash, 'Original Claude source must remain read-only');
      if (sourceHash) assert.equal(sha(source), sourceHash, 'Copied source must remain read-only');
    } finally {
      const resolved = path.resolve(state);
      assert.equal(path.dirname(resolved), path.resolve(repo, 'tmp'));
      assert.ok(path.basename(resolved).startsWith('v3-claude-foundation-'));
      await rm(resolved, { recursive: true, force: true });
    }
  });
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, text);
  sourceHash = sha(source);
  const port = await freeFetchSafePort();
  const args = ['serve', '--port', String(port), '--claude-dir', path.join(state, 'claude'),
    '--opencode-db', path.join(state, 'missing.db')];
  for (const name of ['codex', 'pi', 'dsh', 'meta', 'index', 'cache']) {
    const dir = path.join(state, name);
    await mkdir(dir);
    args.push(`--${name}-dir`, dir);
  }
  child = spawn(binary, args, { cwd: repo, windowsHide: true, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok)
        return { base, id, source, text };
    } catch { /* Isolated server startup. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Claude foundation HTTP server did not start');
}

async function foundation({ base, id, text }) {
  const reader = await json(`${base}/api/v3/reader/claude-code/${id}/bootstrap`);
  const v2 = await json(`${base}/api/v3/protocol/claude-code/${id}?version=2`);
  const v3 = await json(`${base}/api/v3/protocol/claude-code/${id}?version=3`);
  for (const [version, document] of [[2, v2], [3, v3]]) {
    assert.equal(document.version, version);
    assert.equal(document.validation.ok, true);
    assert.equal(document.completeness, 'partial');
    assert.deepEqual(document.session, { provider: 'claude-code', sessionId: id });
    assert.equal(document.revision, reader.revision);
  }
  for (const key of ['session', 'revision', 'events', 'relationships', 'tasks', 'agentRuns',
    'contextArtifacts', 'branches']) assert.deepEqual(v2[key], v3[key], key);
  assert.deepEqual(v3.upgrade, { fromVersion: 2, strategy: 'v2-to-v3', preservesV2Facts: true });
  const rows = rowsOf(text);
  const compactBoundaries = rows.filter(({record}) => record.type === 'system'
    && record.subtype === 'compact_boundary');
  const recordedSidechain = rows.find(({record}) => record.isSidechain === true &&
    typeof record.sessionId === 'string' && record.sessionId.trim() &&
    record.sessionId !== id && (record.uuid || record.id));
  const expected = rows.map(({record,index}) => [index, 0,
    `claude.${record.type}${record.subtype ? ':' + record.subtype : ''}`,
    record.uuid || record.id || null, record.uuid || record.id ? 'recorded' : 'derived']);
  assert.deepEqual(v2.events.map(event => [event.sourceOrder.record, event.sourceOrder.ordinal,
    event.provenance.sourceType, event.provenance.sourceId, event.provenance.fidelity]), expected);
  const pages = [];
  let cursor;
  do {
    const query = new URLSearchParams({ limit: '2', ...(cursor ? { cursor } : {}) });
    const page = await json(`${base}/api/v3/runtime/claude-code/${id}/events?${query}`);
    assert.equal(page.revision, v2.revision);
    assert.notEqual(page.nextCursor, cursor);
    pages.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(pages, v2.events);
  for (const key of ['tasks', 'agentRuns', 'contextArtifacts', 'branches', 'goals', 'actors',
    'coordination', 'contextVersions', 'contextTransformations']) assert.deepEqual(v3[key], [], key);
  for (const domain of ['relationships', 'tasks', 'agentRuns', 'branches', 'context', 'work', 'execution', 'coordination', 'usage'])
    if (domain !== 'usage') assert.equal(v3.coverage[domain]?.state,
      domain === 'relationships' && recordedSidechain || domain === 'context' && compactBoundaries.length
        ? 'observed' : 'unknown', domain);
  assert.equal(v3.coverage.usage.state,
    rows.some(({record}) => record.type === 'assistant' && (record.message?.usage || record.usage))
      ? 'observed' : 'not-observed');
  const work = await json(`${base}/api/v3/runtime/claude-code/${id}/work`);
  assert.equal(work.revision, v2.revision);
  assert.deepEqual(work.entries, []);
  const providers = await json(`${base}/api/providers`);
  const capabilities = providers.find(provider => provider.id === 'claude-code').protocolCapabilities;
  assertCapability(capabilities.sessionEvents, { support: 'partial', provenance: 'mixed' });
  assertCapability(capabilities.sessionRelationships, { support: 'partial', provenance: 'recorded' });
  for (const domain of ['tasks', 'agentRuns', 'contextArtifacts', 'branches'])
    assertCapability(capabilities[domain], { support: 'none', provenance: 'unknown' });
  return { reader, v2, v3, rows };
}

for (const name of ['claude-current.jsonl', 'claude-legacy.jsonl', 'claude-current-v259-synthetic.jsonl'])
  test(`Claude ${name} foundation preserves source rows and v2/v3 facts`, { timeout: 60_000 }, async t => {
    const f = await setup(t, fixture(name));
    const {v3} = await foundation(f);
    assert.deepEqual(v3.relationships, []);
  });

test('Claude compact boundary is a Reader checkpoint and source-backed Context observation',
  { timeout: 60_000 }, async t => {
    const original = fixture('claude-current-v259-synthetic.jsonl');
    const before = sha(original);
    const f = await setup(t, original);
    const ref = { provider: 'claude-code', sessionId: f.id,
      messageId: 'compact-boundary-1', segment: 'context' };
    const reader = await json(`${f.base}/api/v3/reader/claude-code/${f.id}/bootstrap`);
    assert.deepEqual(reader.segments[0].items[0].event, ref);
    assert.equal(reader.segments[0].items[0].role, 'context');
    assert.deepEqual(reader.toc.entries[0].event, ref);
    const v2 = await json(`${f.base}/api/v3/protocol/claude-code/${f.id}?version=2`);
    assert.deepEqual(v2.events[0].readerEvent, ref);
    const v3 = await json(`${f.base}/api/v3/protocol/claude-code/${f.id}?version=3`);
    assert.deepEqual(v3.contextVersions, []);
    assert.deepEqual(v3.contextTransformations, []);
    const context = await json(`${f.base}/api/v3/runtime/claude-code/${f.id}/context`);
    assert.equal(context.entries.length, 1);
    assert.equal(context.entries[0].type, 'contextObservation');
    assert.equal(context.entries[0].fact.kind, 'compaction-boundary');
    assert.equal(context.entries[0].fact.summaryAvailable, false);
    assert.equal(context.entries[0].fact.trigger, 'auto');
    assert.equal(context.entries[0].fact.preCompactTokens, 167189);
    assert.deepEqual(context.entries[0].fact.readerEvent, ref);
    assert.equal(sha(original), before);
  });

test('Claude v259 public source yields a recorded request usage fact without changing its bytes',
  { timeout: 60_000 }, async t => {
    const original = fixture('claude-current-v259-synthetic.jsonl');
    const expectedSourceSha256 = '6d1beea9dc7eac022ff3aa50324ad8cd2251ec4230261496d70ffb4ba54d385e';
    assert.equal(sha(original), expectedSourceSha256);
    const f = await setup(t, original);
    assert.equal(sha(f.source), expectedSourceSha256);

    const sourceRecord = rowsOf(f.text).find(({record}) => record.type === 'assistant');
    assert.ok(sourceRecord);
    const v3 = await json(`${f.base}/api/v3/protocol/claude-code/${f.id}?version=3`);
    const assistantEvent = v3.events.find(event => event.kind === 'message.assistant'
      && event.provenance.sourceId === sourceRecord.record.uuid);
    assert.ok(assistantEvent, 'Request usage must point to its active assistant event');
    assert.deepEqual(v3.usageRecords, [{
      id: 'usage:source-session:response:response-1',
      scope: 'request',
      sessionRef: { provider: 'claude-code', sessionId: 'source-session' },
      timestamp: Date.parse(sourceRecord.record.timestamp),
      model: sourceRecord.record.message.model,
      runId: null,
      eventId: assistantEvent.id,
      turnId: null,
      tokens: {
        input: 100,
        cacheRead: 20,
        cacheWrite: 7,
        // This source records inclusive output_tokens, with no reasoning breakdown.
        output: null,
        reasoning: null,
        total: null,
      },
      contextOriginSlices: [],
      provenance: {
        fidelity: 'recorded',
        sourceType: 'claude.transcript:assistant.usage',
        sourceId: sourceRecord.record.uuid,
      },
    }]);
    assert.equal(v3.coverage.usage.state, 'observed');
    assert.equal(sha(original), expectedSourceSha256);
    assert.equal(sha(f.source), expectedSourceSha256);
  });

test('Claude request usage deduplicates responses, keeps token components, and omits pending rows',
  { timeout: 60_000 }, async t => {
    const f = await setup(t, fixture('claude-current-v259-synthetic.jsonl'), text => {
      const records = rowsOf(text).map(({record}) => record);
      const assistant = records.find(record => record.type === 'assistant');
      const copy = () => structuredClone(assistant);
      const pending = copy();
      pending.uuid = 'assistant-pending';
      pending.message.usage = { input_tokens: 0, output_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      pending.message.content = [];

      const response = copy();
      response.uuid = 'assistant-response-first';
      response.message.usage.reasoning_tokens = 3;
      response.message.usage.total_tokens = 999;
      const fragment = copy();
      fragment.uuid = 'assistant-response-fragment';
      fragment.message.usage.reasoning_tokens = 3;
      fragment.message.usage.total_tokens = 999;

      const legacy = copy();
      legacy.uuid = 'legacy-assistant';
      delete legacy.message.id;
      legacy.message.usage = { input_tokens: 5, output_tokens: 8, reasoning_tokens: 3 };
      const legacyFragment = structuredClone(legacy);
      legacyFragment.uuid = 'legacy-fragment';
      const legacyAfterUser = structuredClone(legacy);
      legacyAfterUser.uuid = 'legacy-after-user';
      legacyAfterUser.message.usage.total_tokens = 13;

      const zero = copy();
      zero.uuid = 'zero-response';
      zero.message.id = 'response-zero';
      zero.message.usage = { input_tokens: 0, output_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      zero.message.content = [];

      const noAnchor = copy();
      delete noAnchor.uuid;
      noAnchor.message.id = 'response-no-anchor';
      noAnchor.message.usage = { input_tokens: 1, output_tokens: 2 };
      noAnchor.message.content = [{ type: 'text', text: 'Recorded without a source row ID' }];

      const derived = copy();
      delete derived.uuid;
      delete derived.id;
      delete derived.message.id;
      derived.message.usage = { input_tokens: 2, output_tokens: 1 };
      derived.message.content = [];

      const userBreak = { type: 'user', uuid: 'fallback-reset', message: { content: 'new request' } };
      const nonAssistant = records.filter(record => record.type !== 'assistant');
      return '\n' + [...nonAssistant, pending, response, fragment, legacy, legacyFragment,
        userBreak, legacyAfterUser, zero, noAnchor, derived].map(record => JSON.stringify(record)).join('\n') + '\n';
    });
    const v3 = await json(`${f.base}/api/v3/protocol/claude-code/${f.id}?version=3`);
    assert.equal(v3.validation.ok, true);
    assert.deepEqual(v3.usageRecords.map(record => record.id), [
      'usage:source-session:response:response-1',
      'usage:source-session:response:legacy-assistant',
      'usage:source-session:response:legacy-after-user',
      'usage:source-session:response:response-no-anchor',
      'usage:source-session:response:record:12',
    ]);

    const response = v3.usageRecords[0];
    assert.deepEqual(response.tokens, {
      input: 100, cacheRead: 20, cacheWrite: 7, output: 7, reasoning: 3, total: null,
    });
    assert.equal(response.provenance.sourceId, 'assistant-response-first');
    assert.equal(response.eventId, v3.events.find(event =>
      event.provenance.sourceId === 'assistant-response-first').id);
    assert.equal(v3.usageRecords[1].eventId, v3.events.find(event =>
      event.provenance.sourceId === 'legacy-assistant').id);
    assert.equal(v3.usageRecords[2].tokens.total, 13);
    assert.equal(v3.usageRecords[3].eventId, null);
    assert.equal(v3.usageRecords[3].provenance.fidelity, 'recorded');
    assert.equal(v3.usageRecords[4].eventId, null);
    assert.equal(v3.usageRecords[4].provenance.fidelity, 'derived');
    assert.equal(v3.usageRecords[4].provenance.sourceId, 'event:claude:12');
    assert.equal(v3.usageRecords.some(record => record.id.endsWith(':response-zero')), false);
    assert.equal(v3.coverage.usage.state, 'observed');
  });

for (const includeRecordedUsage of [false, true]) {
  test(`Claude completely missing usage ${includeRecordedUsage ? 'does not hide mixed recorded usage' : 'stays unknown without fabricated requests'}`,
    { timeout: 60_000 }, async t => {
      const f = await setup(t, fixture('claude-current-v259-synthetic.jsonl'), () => {
        const assistant = (uuid, responseId) => ({ type: 'assistant', uuid,
          message: { id: responseId, content: [{ type: 'text', text: uuid }] } });
        const records = [assistant('usage-absent-before', 'shared-response')];
        if (includeRecordedUsage) {
          const recorded = assistant('usage-recorded', 'shared-response');
          recorded.message.usage = { input_tokens: 10, output_tokens: 4 };
          records.push(recorded);
        }
        records.push(assistant('usage-absent-after', 'unrecorded-response'));
        return records.map(record => JSON.stringify(record)).join('\n') + '\n';
      });
      const summaries = await json(`${f.base}/api/v3/sessions?provider=claude-code`);
      const summary = summaries.find(item => item.session.sessionId === f.id);
      assert.ok(summary, 'Missing usage must not hide the conversation');
      assert.equal(summary.tokenCount, includeRecordedUsage ? 14 : null);
      const v3 = await json(`${f.base}/api/v3/protocol/claude-code/${f.id}?version=3`);
      assert.equal(v3.validation.ok, true);
      assert.equal(v3.coverage.usage.state, includeRecordedUsage ? 'observed' : 'not-observed');
      assert.deepEqual(v3.usageRecords.map(record => record.provenance.sourceId),
        includeRecordedUsage ? ['usage-recorded'] : [],
        'Absent usage contributes no request and cannot claim a later recorded response');
      if (includeRecordedUsage) {
        assert.deepEqual(v3.usageRecords[0].tokens, {
          // Inclusive output has no recorded reasoning breakdown in this source.
          input: 10, cacheRead: null, cacheWrite: null, output: null, reasoning: null, total: null,
        });
      }
      const reader = await json(`${f.base}/api/v3/reader/claude-code/${f.id}/bootstrap`);
      const readableIds = reader.segments.flatMap(page => page.items.map(item => item.event.messageId));
      for (const id of ['usage-absent-before', 'usage-absent-after']) assert.ok(readableIds.includes(id),
        `The reply without usage remains readable: ${id}`);
    });
}

test('Claude summary and Protocol select final responses and distinct legacy components',
  { timeout: 60_000 }, async t => {
    const f = await setup(t, fixture('claude-current-v259-synthetic.jsonl'), () => {
      const assistant = (uuid, responseId, input, output, content = []) => ({
        type: 'assistant', uuid, message: { ...(responseId ? { id: responseId } : {}),
          content, usage: { input_tokens: input, output_tokens: output } },
      });
      return [
        assistant('pending', 'final-response', 0, 0),
        assistant('final', 'final-response', 10, 4),
        assistant('final-fragment', 'final-response', 10, 4),
        assistant('legacy-first', null, 8, 2),
        assistant('legacy-fragment', null, 8, 2),
        assistant('legacy-distinct', null, 7, 3),
        { type: 'user', uuid: 'reset', message: { content: 'Next request' } },
        assistant('legacy-after-user', null, 7, 3),
        assistant('pending-only', 'pending-response', 0, 0),
      ].map(record => JSON.stringify(record)).join('\n') + '\n';
    });
    const summaries = await json(`${f.base}/api/v3/sessions?provider=claude-code`);
    assert.equal(summaries.find(item => item.session.sessionId === f.id)?.tokenCount, 44);
    const v3 = await json(`${f.base}/api/v3/protocol/claude-code/${f.id}?version=3`);
    assert.equal(v3.validation.ok, true);
    assert.deepEqual(v3.usageRecords.map(record => record.id), [
      'usage:source-session:response:final-response',
      'usage:source-session:response:legacy-first',
      'usage:source-session:response:legacy-distinct',
      'usage:source-session:response:legacy-after-user',
    ]);
    assert.ok(v3.usageRecords.every(record => record.tokens.total === null),
      'Summary sums recorded components while Protocol retains an unrecorded total as unknown');
    assert.equal(v3.usageRecords[0].provenance.sourceId, 'final');
  });

test('Claude duplicate usage keeps the first owned anchor and upgrades an unowned fragment',
  { timeout: 60_000 }, async t => {
    const f = await setup(t, fixture('claude-current-v259-synthetic.jsonl'), () => {
      const assistant = uuid => ({ type: 'assistant', ...(uuid ? { uuid } : {}),
        message: { id: 'anchored-response', content: [],
          usage: { input_tokens: 10, output_tokens: 4 } } });
      return [assistant(null), assistant('owned-fragment'), assistant('later-fragment')]
        .map(record => JSON.stringify(record)).join('\n') + '\n';
    });
    const summaries = await json(`${f.base}/api/v3/sessions?provider=claude-code`);
    assert.equal(summaries.find(item => item.session.sessionId === f.id)?.tokenCount, 14);
    const v3 = await json(`${f.base}/api/v3/protocol/claude-code/${f.id}?version=3`);
    assert.equal(v3.validation.ok, true);
    assert.equal(v3.usageRecords.length, 1);
    assert.equal(v3.usageRecords[0].provenance.sourceId, 'owned-fragment');
    assert.equal(v3.usageRecords[0].eventId,
      v3.events.find(event => event.provenance.sourceId === 'owned-fragment').id);
  });

test('Claude sidechain and task-like records remain events without invented AgentRuns', { timeout: 60_000 }, async t => {
  const f = await setup(t, fixture('claude-current.jsonl'), text => {
    const records = rowsOf(text).map(row => row.record);
    records[1].isSidechain = true;
    records[1].agentId = 'source-session';
    records[1].sessionId = 'recorded-parent';
    records.push({ type: 'user', uuid: 'task-notification', message: { content:
      '<task-notification><task-id>task-1</task-id><status>completed</status><summary>Child returned</summary></task-notification>' } });
    return '\n' + records.map(record => JSON.stringify(record)).join('\n') + '\n';
  });
  const {v3} = await foundation(f);
  assert.deepEqual(v3.relationships.map(relation => [relation.kind, relation.from.sessionId,
    relation.to.sessionId, relation.evidence.eventId, relation.evidence.provenance.sourceId]),
  [['parent', 'recorded-parent', f.id, 'event:claude:2', v3.events[1].provenance.sourceId]]);
  assert.equal(v3.events[0].sourceOrder.record, 1);
});

test('Claude malformed native record is invalid rather than validation.ok', { timeout: 60_000 }, async t => {
  const f = await setup(t, fixture('claude-current.jsonl'), text => text + JSON.stringify({uuid: 'bad'}) + '\n');
  for (const version of [2,3]) {
    const response = await fetch(`${f.base}/api/v3/protocol/claude-code/${f.id}?version=${version}`);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, 'protocol_invalid');
  }
});

test('frozen Claude foundation retains 26 source rows and read-only SHA', {
  timeout: 60_000, skip: !existsSync(frozen) ? 'Frozen private Claude source unavailable' : false,
}, async t => {
  assert.equal(sha(frozen), 'ee5e4cca0777b45ef7e97306139ad53022233a95e364ca314734890d14190734');
  const f = await setup(t, frozen);
  const {v3,rows} = await foundation(f);
  assert.equal(rows.length, 26);
  assert.equal(v3.events.length, 26);
  const usageRows = rows.filter(({record}) => record.type === 'assistant'
    && (record.message?.usage || record.usage));
  assert.equal(usageRows.length, 5);
  assert.equal(usageRows.filter(({record}) =>
    record.message.id === '13d0c51f-5c90-43cd-95f5-e85e9df630fb').length, 2,
  'The provider recorded the same response usage on two assistant fragments');
  const firstResponse = usageRows[0].record;
  assert.equal(v3.usageRecords.length, 1, 'Three all-zero records are pending, not request totals');
  assert.deepEqual(v3.usageRecords[0].tokens, {
    // Frozen raw usage has output_tokens:13 but no reasoning subset field.
    input: 30_804, cacheRead: 0, cacheWrite: 0, output: null, reasoning: null, total: null,
  });
  assert.equal(v3.usageRecords[0].id,
    `usage:${path.basename(frozen, '.jsonl')}:response:${firstResponse.message.id}`);
  assert.equal(v3.usageRecords[0].provenance.sourceId, firstResponse.uuid);
  assert.equal(v3.usageRecords[0].eventId, v3.events.find(event =>
    event.provenance.sourceId === firstResponse.uuid).id);
  assert.equal(v3.coverage.usage.state, 'observed');
});
