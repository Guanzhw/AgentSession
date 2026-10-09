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
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

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
const frozen = path.join(repo, 'tmp/v3-corpus/pi/sessions/--D--WorkSpace-OpenSession--',
  '2026-07-19T13-31-30-839Z_019f7a93-2297-76db-827d-ee366e46482e.jsonl');
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
  const state = await mkdtemp(path.join(repo, 'tmp/v3-pi-foundation-'));
  const originalHash = sha(original);
  const text = transform(readFileSync(original, 'utf8'));
  const id = rowsOf(text)[0].record.id;
  const source = path.join(state, 'pi/sessions/project', `${id}.jsonl`);
  let child;
  let sourceHash;
  t.after(async () => {
    try {
      if (child) {
        child.kill();
        if (child.exitCode === null && child.signalCode === null) await once(child, 'close');
      }
      assert.equal(sha(original), originalHash, 'Original Pi source must remain read-only');
      if (sourceHash) assert.equal(sha(source), sourceHash, 'Copied source must remain read-only');
    } finally {
      const resolved = path.resolve(state);
      assert.equal(path.dirname(resolved), path.resolve(repo, 'tmp'));
      assert.ok(path.basename(resolved).startsWith('v3-pi-foundation-'));
      await rm(resolved, { recursive: true, force: true });
    }
  });
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, text);
  sourceHash = sha(source);
  const port = await freeFetchSafePort();
  const args = ['serve', '--port', String(port), '--pi-dir', path.join(state, 'pi'),
    '--opencode-db', path.join(state, 'missing.db')];
  for (const name of ['codex', 'claude', 'dsh', 'meta', 'index', 'cache']) {
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
        return { base, id, source, text, mcpArgs: ['mcp', ...args.slice(3)] };
    } catch { /* Isolated server startup. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Pi foundation HTTP server did not start');
}

async function foundation({ base, id, text }) {
  const reader = await json(`${base}/api/v3/reader/pi/${id}/bootstrap`);
  const v2 = await json(`${base}/api/v3/protocol/pi/${id}?version=2`);
  const v3 = await json(`${base}/api/v3/protocol/pi/${id}?version=3`);
  for (const [version, document] of [[2, v2], [3, v3]]) {
    assert.equal(document.version, version);
    assert.equal(document.validation.ok, true);
    assert.equal(document.completeness, 'partial');
    assert.deepEqual(document.session, { provider: 'pi', sessionId: id });
    assert.equal(document.revision, reader.revision);
  }
  for (const key of ['session', 'revision', 'events', 'relationships', 'tasks', 'agentRuns',
    'contextArtifacts', 'branches']) assert.deepEqual(v2[key], v3[key], key);
  assert.deepEqual(v3.upgrade, { fromVersion: 2, strategy: 'v2-to-v3', preservesV2Facts: true });
  const rows = rowsOf(text);
  const expected = rows.flatMap(({ record, index }) => [[index, 0, `pi.${record.type}`, record.id ?? null],
    ...(record.type === 'message' && record.message.role === 'assistant'
      ? record.message.content.map((block, ordinal) =>
        [index, ordinal + 1, `pi.message.content.${block.type}`, record.id]) : [])]);
  assert.deepEqual(v2.events.map(event => [event.sourceOrder.record, event.sourceOrder.ordinal,
    event.provenance.sourceType, event.provenance.sourceId]), expected);
  assert.ok(v2.events.every(event => event.provenance.fidelity === 'recorded'));
  const pages = [];
  let cursor;
  do {
    const query = new URLSearchParams({ limit: '2', ...(cursor ? { cursor } : {}) });
    const page = await json(`${base}/api/v3/runtime/pi/${id}/events?${query}`);
    assert.equal(page.revision, v2.revision);
    assert.notEqual(page.nextCursor, cursor);
    pages.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(pages, v2.events);
  for (const key of ['tasks', 'agentRuns', 'contextArtifacts', 'goals', 'actors',
    'coordination']) assert.deepEqual(v3[key], [], key);
  for (const domain of ['tasks', 'agentRuns', 'work', 'execution', 'coordination'])
    assert.equal(v3.coverage[domain]?.state, 'unknown', domain);
  assert.ok(['observed', 'unknown'].includes(v3.coverage.branches?.state));
  assert.equal(v3.branches.filter(branch => branch.selected).length, 1);
  assert.equal(v3.coverage.usage?.state, v3.usageRecords.length ? 'observed' : 'not-observed');
  const work = await json(`${base}/api/v3/runtime/pi/${id}/work`);
  assert.equal(work.revision, v2.revision);
  assert.deepEqual(work.entries, []);
  const providers = await json(`${base}/api/providers`);
  const capabilities = providers.find(provider => provider.id === 'pi').protocolCapabilities;
  assertCapability(capabilities.sessionEvents, { support: 'partial', provenance: 'recorded' });
  assertCapability(capabilities.sessionRelationships, { support: 'partial', provenance: 'derived' });
  for (const domain of ['tasks', 'agentRuns', 'contextArtifacts'])
    assertCapability(capabilities[domain], { support: 'none', provenance: 'unknown' });
  assertCapability(capabilities.branches, { support: 'partial', provenance: 'derived' });
  return { reader, v2, v3, rows };
}

for (const [name, abandoned, parent] of [
  ['pi-v3-current.jsonl', 'asst0001', '019f8900-0000-7000-8000-000000000000'],
  ['pi-current.jsonl', 'oldasst1', '019f7a00-0000-7000-8000-000000000000'],
]) test(`Pi ${name} foundation keeps source rows, header anchors and in-file branch boundaries`,
  { timeout: 60_000 }, async t => {
    const f = await setup(t, fixture(name));
    const { v3 } = await foundation(f);
    assert.equal(v3.coverage.branches.state,
      name === 'pi-v3-current.jsonl' ? 'observed' : 'unknown');
    assert.equal(v3.relationships.length, 1);
    assert.equal(v3.relationships[0].kind, 'parent');
    assert.equal(v3.relationships[0].from.sessionId, parent);
    assert.equal(v3.coverage.relationships.state, 'observed');
    assert.equal(v3.events[0].id, 'event:pi:0');
    assert.deepEqual(v3.events[0].provenance, {
      fidelity: 'recorded', sourceType: 'pi.session', sourceId: f.id });
    assert.ok(v3.events.some(event => event.kind === 'context.compact'));
    const abandonedEvents = v3.events.filter(event => event.provenance.sourceId === abandoned);
    assert.ok(abandonedEvents.length > 0);
    assert.ok(abandonedEvents.every(event => event.readerEvent === null));
    assert.deepEqual(v3.contextVersions.map(version => version.provenance.sourceId),
      name === 'pi-v3-current.jsonl' ? ['branch1', 'compact1'] : ['compact1']);
    assert.deepEqual(v3.contextTransformations.map(item => item.resultVersionId),
      v3.contextVersions.map(version => version.id));
    assert.equal(v3.coverage.context.state, 'observed');
    const context = await json(`${f.base}/api/v3/runtime/pi/${f.id}/context?limit=1`);
    assert.equal(context.entries.length, 1);
    assert.equal(context.entries[0].type, 'contextResult');
    assert.equal(context.entries[0].fact.version.readerEvent.messageId,
      name === 'pi-v3-current.jsonl' ? 'branch1' : 'compact1');
    if (name === 'pi-v3-current.jsonl') {
      assert.ok(context.nextCursor);
      const next = await json(`${f.base}/api/v3/runtime/pi/${f.id}/context?limit=1&cursor=${encodeURIComponent(context.nextCursor)}`);
      assert.equal(next.entries[0].fact.transformation.retainedTailCount, 2);
      assert.equal(next.entries[0].fact.version.readerEvent.messageId, 'compact1');
    } else {
      assert.equal(context.nextCursor, null);
      assert.deepEqual(context.entries[0].fact.transformation.retainedFrom,
        { sourceId: 'user0002', eventId: 'event:pi:9' });
    }
  });

test('Pi header parentSession reaches protocol and Sessions graph as a derived link',
  { timeout: 60_000 }, async t => {
    const f = await setup(t, fixture('pi-v3-current.jsonl'));
    const parent = '019f8900-0000-7000-8000-000000000000';
    const protocol = await json(`${f.base}/api/v3/protocol/pi/${f.id}?version=3`);
    assert.deepEqual(protocol.relationships.map(relation => [relation.kind, relation.from,
      relation.to, relation.evidence]), [[
      'parent', { provider: 'pi', sessionId: parent }, { provider: 'pi', sessionId: f.id },
      { eventId: 'event:pi:0', provenance: {
        fidelity: 'derived', sourceType: 'pi.session.parentSession', sourceId: f.id,
      } },
    ]]);
    assert.equal(protocol.coverage.relationships.state, 'observed');
    const graph = await json(`${f.base}/api/v3/runtime/pi/${f.id}/graph`);
    const parentEdge = graph.edges.find(edge => edge.type === 'parent');
    assert.ok(parentEdge);
    assert.equal(parentEdge.inferred, true);
    assert.equal(graph.nodes.find(node => node.session.sessionId === parent)?.resolution, 'unverified');
  });

test('Pi v3 projects file-local active and abandoned branches with bounded graph nodes',
  { timeout: 60_000 }, async t => {
    const f = await setup(t, fixture('pi-v3-current.jsonl'));
    const protocol = await json(`${f.base}/api/v3/protocol/pi/${f.id}?version=3`);
    assert.deepEqual(protocol.branches.map(branch => [branch.id, branch.forkEntryId,
      branch.forkEventId, branch.headEntryId, branch.headEventId, branch.selected,
      branch.evidence.eventId, branch.evidence.provenance.fidelity]), [
      [`branch:pi:${f.id}:active`, 'user0001', 'event:pi:4', 'label0001',
        'event:pi:19', true, 'event:pi:19', 'derived'],
      [`branch:pi:${f.id}:abandoned:branch1`, 'user0001', 'event:pi:4',
        'hidden0001', 'event:pi:8', false, 'event:pi:9', 'recorded'],
    ]);
    assert.equal(protocol.coverage.branches.state, 'observed');
    assert.deepEqual(protocol.tasks, []);
    assert.deepEqual(protocol.agentRuns, []);
    assert.equal(protocol.relationships.length, 1, 'entry parentId stays file-local');
    const graph = await json(`${f.base}/api/v3/runtime/pi/${f.id}/graph?maxNodes=3`);
    assert.equal(graph.nodes.length, 3);
    assert.equal(graph.truncated, true);
    assert.deepEqual(graph.nodes.filter(node => node.kind === 'branch')
      .map(node => node.status), ['active', 'abandoned']);
    assert.equal(graph.domainCoverage.branches.state, 'observed');
    const summary = await json(`${f.base}/api/v3/runtime/pi/${f.id}/summary`);
    assert.equal(summary.counts.branches, 2);
  });

test('Pi branch_summary without a resolvable fromId preserves unknown branch coverage',
  { timeout: 60_000 }, async t => {
    const f = await setup(t, fixture('pi-v3-current.jsonl'), text =>
      rowsOf(text).map(({ record }) => {
        if (record.id === 'branch1') record.fromId = 'missing-entry';
        return JSON.stringify(record);
      }).join('\n') + '\n');
    const protocol = await json(`${f.base}/api/v3/protocol/pi/${f.id}?version=3`);
    assert.deepEqual(protocol.branches.map(branch => branch.selected), [true]);
    assert.equal(protocol.branches[0].forkEventId, null);
    assert.equal(protocol.coverage.branches.state, 'unknown');
    assert.deepEqual(protocol.tasks, []);
    assert.deepEqual(protocol.agentRuns, []);
    assert.equal(protocol.relationships.length, 1);
  });

for (const [sourceName, summaryId, label, remaining] of [
  ['pi-current.jsonl', 'compact1', 'whitespace', []],
  ['pi-current.jsonl', 'compact1', 'missing', []],
  ['pi-v3-current.jsonl', 'branch1', 'whitespace', ['compact1']],
  ['pi-v3-current.jsonl', 'branch1', 'missing', ['compact1']],
]) test(`Pi ${sourceName} ${label} ${summaryId} keeps raw evidence without a Reader or MCP message`,
  { timeout: 60_000 }, async t => {
    const f = await setup(t, fixture(sourceName), text => rowsOf(text).map(({ record }) => {
      if (record.id === summaryId) {
        if (label === 'whitespace') record.summary = '   ';
        else delete record.summary;
      }
      return JSON.stringify(record);
    }).join('\n') + '\n');
    const reader = await json(`${f.base}/api/v3/reader/pi/${f.id}/bootstrap`);
    for (const era of ['legacy', 'modern']) {
      const client = new Client({ name: 'pi-context-boundary-test', version: '1.0.0' },
        era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
      await client.connect(new StdioClientTransport({ command: binary, args: f.mcpArgs,
        cwd: repo, stderr: 'pipe' }));
      try {
        const response = await client.callTool({ name: 'session_timeline',
          arguments: { session: { provider: 'pi', sessionId: f.id }, limit: 200 } });
        assert.notEqual(response.isError, true, `${era} MCP timeline`);
        assert.ok(response.structuredContent.result.events
          .every(row => row.event.messageId !== summaryId), `${era} excludes empty summary`);
        assert.equal(response.structuredContent.result.nextCursor, null);
      } finally {
        await client.close();
      }
    }
    const protocol = await json(`${f.base}/api/v3/protocol/pi/${f.id}?version=3`);
    assert.deepEqual(protocol.contextVersions.map(version => version.provenance.sourceId), remaining);
    assert.deepEqual(protocol.contextTransformations.map(item => item.provenance.sourceId), remaining);
    assert.equal(protocol.coverage.context.state, remaining.length ? 'observed' : 'unknown');
    const raw = protocol.events.filter(event => event.provenance.sourceId === summaryId);
    assert.equal(raw.length, 1);
    assert.equal(raw[0].readerEvent, null);
    const page = await json(`${f.base}/api/v3/runtime/pi/${f.id}/context`);
    assert.deepEqual(page.entries.map(entry => entry.fact.transformation.provenance.sourceId), remaining);
    assert.equal(page.domainCoverage.state, remaining.length ? 'observed' : 'unknown');
    assert.ok(reader.segments.flatMap(segment => segment.items)
      .every(item => item.event.messageId !== summaryId));
    assert.ok(reader.toc.entries.every(entry => entry.event.messageId !== summaryId));
  });

test('Pi inactive compaction remains a source event without a structured result',
  { timeout: 60_000 }, async t => {
    const f = await setup(t, fixture('pi-current.jsonl'), text => {
      const rows = rowsOf(text).map(row => row.record);
      rows.splice(rows.length - 1, 0, {
        type: 'compaction', id: 'inactive-compact', parentId: 'user0001',
        timestamp: '2026-07-19T01:00:07.500Z', summary: 'Inactive branch summary.',
      });
      return rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    });
    const protocol = await json(`${f.base}/api/v3/protocol/pi/${f.id}?version=3`);
    assert.ok(protocol.events.some(event => event.provenance.sourceId === 'inactive-compact'));
    assert.ok(protocol.contextVersions.every(version => version.provenance.sourceId !== 'inactive-compact'));
    assert.equal(protocol.contextTransformations.length, 1);
  });

test('Pi opaque parent paths stay unknown and entry parentId never creates cross-session work',
  { timeout: 60_000 }, async t => {
    const f = await setup(t, fixture('pi-v3-current.jsonl'), text => {
      const records = rowsOf(text).map(row => row.record);
      records[0].parentSession = '/unavailable/opaque-parent.jsonl';
      return '\n' + records.map(record => JSON.stringify(record)).join('\n') + '\n';
    });
    const { v3 } = await foundation(f);
    assert.deepEqual(v3.relationships, []);
    assert.equal(v3.coverage.relationships.state, 'unknown');
    assert.equal(v3.events[0].sourceOrder.record, 1);
  });

test('Pi malformed native record remains invalid instead of a valid empty foundation',
  { timeout: 60_000 }, async t => {
    const f = await setup(t, fixture('pi-v3-current.jsonl'), text =>
      text + JSON.stringify({ id: 'bad-row' }) + '\n');
    for (const version of [2, 3]) {
      const response = await fetch(`${f.base}/api/v3/protocol/pi/${f.id}?version=${version}`);
      const body = await response.json();
      assert.equal(response.status, 422);
      assert.equal(body.error.code, 'protocol_invalid');
      assert.notEqual(body.validation?.ok, true);
    }
  });

test('frozen Pi foundation agrees with five original rows, six events and read-only SHA',
  { timeout: 60_000, skip: !existsSync(frozen) ? 'Frozen private Pi source unavailable' : false }, async t => {
    assert.equal(sha(frozen), 'c6db5c9c105be0961721fef7f0f8f1b5d2458933bc48fc13302fd768e0c42c29');
    const f = await setup(t, frozen);
    const { v3, rows } = await foundation(f);
    assert.equal(rows.length, 5);
    assert.equal(v3.events.length, 6);
    assert.deepEqual(v3.relationships, []);
    assert.equal(v3.coverage.relationships.state, 'not-observed');
    assert.deepEqual(v3.contextVersions, []);
    assert.deepEqual(v3.contextTransformations, []);
    assert.equal(v3.coverage.context.state, 'not-observed');
    const rawRequests = rows.filter(({ record }) => record.type === 'message'
      && record.message.role === 'assistant' && record.message.usage);
    assert.equal(v3.usageRecords.length, rawRequests.length);
    assert.deepEqual(v3.usageRecords.map(record => record.tokens.total),
      rawRequests.map(({ record }) => record.message.usage.totalTokens));
    assert.equal(v3.coverage.usage.state, 'observed');
  });
