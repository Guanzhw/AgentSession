import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifySourceFacts } from '../scripts/v3-verify-source-facts.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/v3-verify-source-facts.mjs', import.meta.url));
const PROVIDERS = ['opencode', 'claude-code', 'codex', 'pi', 'deepseek-harness'];
const TARGETS = [
  ['opencode', 'long'],
  ['claude-code', 'available-live'],
  ['pi', 'available-live'],
  ['codex', 'long-team-compaction'],
  ['codex', 'compact-team-shorter'],
  ['deepseek-harness', 'native-v3-packed-compaction'],
  ['deepseek-harness', 'recorded-subagent-descriptor'],
].map(([provider, role], index) => ({ provider, role, sessionId: `PRIVATE_SESSION_ID_${index}` }));
const PROTOCOL_TARGETS = [
  { provider: 'pi', role: 'available-live', fact: 'compactionRecords', count: 0 },
  { provider: 'codex', role: 'long-team-compaction', fact: 'compactedRecords', count: 2 },
  { provider: 'deepseek-harness', role: 'native-v3-packed-compaction', fact: 'compactionStartRecords', count: 1 },
];

const snapshot = (cases) => ({ format: 'agentsession-v3-snapshot/v1', cases });
const targetFor = (provider, role) => TARGETS.find((target) => target.provider === provider && target.role === role);
const caseOf = (id, result) => ({ id, result });

function makeManifest() {
  return {
    schemaVersion: 1,
    providerRoots: Object.fromEntries(PROVIDERS.map((provider) => [provider, {
      cliFlag: `--${provider}`,
      path: `PRIVATE_ROOT_${provider}`,
    }])),
    captureTargets: TARGETS.map((target) => ({
      ...target,
      knownFacts: {
        records: 4,
        ...(target.provider === 'codex' ? { compactedRecords: target.role === 'long-team-compaction' ? 2 : 0 } : {}),
        ...(target.provider === 'pi' ? { compactionRecords: 0 } : {}),
        ...(target.provider === 'deepseek-harness' ? { compactionStartRecords: target.role === 'native-v3-packed-compaction' ? 1 : 0 } : {}),
      },
    })),
  };
}

function makeHttpDetails() {
  return snapshot([
    caseOf('http.providers', {
      kind: 'http', status: 200,
      body: PROVIDERS.map((id) => ({ id, available: true })),
    }),
    ...TARGETS.map((target) => caseOf(`http.detail.${target.provider}.${target.role}`, {
      kind: 'http', status: 200,
      body: { session: { provider: target.provider, id: target.sessionId }, privateBody: 'PRIVATE_HTTP_BODY' },
    })),
  ]);
}

function makeProtocol(target, factCount) {
  const events = Array.from({ length: factCount }, (_, index) => ({
      id: `compact-${index}`,
      sessionId: target.sessionId,
      kind: 'context.compaction',
      category: 'context',
      provenance: { fidelity: 'recorded' },
    }));
  return {
    kind: 'http', status: 200,
    body: {
      sessionId: target.sessionId,
      validation: { ok: true },
      protocol: {
        sessionId: target.sessionId,
        session: { ref: { provider: target.provider, sessionId: target.sessionId } },
        validation: { ok: true },
        events,
      },
    },
  };
}

function makeReaderProtocol() {
  const cases = [];
  for (const spec of PROTOCOL_TARGETS) {
    const target = targetFor(spec.provider, spec.role);
    cases.push(caseOf(`http.reader.${spec.provider}`, {
      kind: 'http', status: 200,
      body: { ok: true, provider: target.provider, sessionId: target.sessionId, html: 'PRIVATE_READER_BODY' },
    }));
    cases.push(caseOf(`http.protocol.${spec.provider}`, makeProtocol(target, spec.count)));
  }
  return snapshot(cases);
}

function mcpResponse(result) {
  return { response: { structuredContent: { result } } };
}

function makeMcp() {
  const cases = [
    caseOf('mcp.tools', mcpResponse({ tools: [{ name: 'session_browse' }] })),
    caseOf('mcp.providers', mcpResponse({
      providers: PROVIDERS.map((provider) => ({ provider, available: true })),
    })),
  ];
  for (const target of TARGETS) {
    cases.push(caseOf(`mcp.get.${target.provider}.${target.role}`, mcpResponse({
      session: { provider: target.provider, sessionId: target.sessionId },
      privateText: 'PRIVATE_MCP_BODY',
    })));
  }
  for (const provider of ['codex', 'deepseek-harness']) {
    const target = targetFor(provider, provider === 'codex' ? 'long-team-compaction' : 'native-v3-packed-compaction');
    cases.push(caseOf(`mcp.timeline.${provider}`, mcpResponse({
      events: [{ event: { provider, sessionId: target.sessionId, messageId: `PRIVATE_EVENT_${provider}`, segment: 'message' } }],
    })));
  }
  return snapshot(cases);
}

function makePagination() {
  const captures = [
    { id: 'mcp.browse.opencode.all-roots', provider: 'opencode', rowsKey: 'sessions', pages: 4, rows: 78 },
    { id: 'mcp.timeline.all.codex', provider: 'codex', rowsKey: 'events', pages: 26, rows: 1260 },
    { id: 'mcp.timeline.all.deepseek-harness', provider: 'deepseek-harness', rowsKey: 'events', pages: 20, rows: 1000 },
  ];
  let globalRow = 0;
  return snapshot(captures.map((capture) => {
    let remaining = capture.rows;
    const pages = Array.from({ length: capture.pages }, (_, pageIndex) => {
      const count = Math.min(50, remaining);
      remaining -= count;
      const rows = Array.from({ length: count }, () => {
        const rowIndex = globalRow++;
        const ref = { provider: capture.provider, sessionId: capture.rowsKey === 'sessions'
          ? `PRIVATE_PAGE_SESSION_${rowIndex}`
          : targetFor(capture.provider, capture.provider === 'codex' ? 'long-team-compaction' : 'native-v3-packed-compaction').sessionId };
        if (capture.rowsKey === 'sessions') return { session: ref };
        return { event: { ...ref, messageId: `PRIVATE_PAGE_EVENT_${rowIndex}`, segment: 'message' } };
      });
      return {
        structuredContent: {
          result: {
            [capture.rowsKey]: rows,
            nextCursor: pageIndex === capture.pages - 1 ? null : `PRIVATE_CURSOR_${capture.id}_${pageIndex + 1}`,
            truncated: pageIndex !== capture.pages - 1,
          },
        },
      };
    });
    return caseOf(capture.id, { kind: 'mcp-paginate', pages });
  }));
}

function makeFixture(withPagination = false) {
  return {
    manifest: makeManifest(),
    httpDetails: makeHttpDetails(),
    readerProtocol: makeReaderProtocol(),
    mcp: makeMcp(),
    ...(withPagination ? {
      mcpPagination: makePagination(),
      opencodeRootIds: Array.from({ length: 78 }, (_, index) => `PRIVATE_PAGE_SESSION_${index}`),
      codexSourcePositions: new Map(Array.from({ length: 1260 }, (_, index) =>
        [`PRIVATE_PAGE_EVENT_${index + 78}`, index + 78])),
    } : {}),
  };
}

test('verifies the seven frozen canonical identities and recorded compaction evidence', () => {
  const result = verifySourceFacts(makeFixture());

  assert.equal(result.passed, true);
  assert.equal(result.issueCount, 0);
  assert.equal(result.counts.targets, 7);
  assert.equal(result.counts.protocolCases, 3);
});

test('rejects a wrong HTTP ID or MCP provider without exposing private identities', () => {
  const fixture = makeFixture();
  fixture.httpDetails.cases.find((item) => item.id === 'http.detail.codex.long-team-compaction').result.body.session.id = 'PRIVATE_WRONG_SESSION_ID';
  fixture.mcp.cases.find((item) => item.id === 'mcp.get.pi.available-live').result.response.structuredContent.result.session.provider = 'PRIVATE_WRONG_PROVIDER';
  fixture.mcp.cases.find((item) => item.id === 'mcp.get.claude-code.available-live').result.response.isError = true;

  const result = verifySourceFacts(fixture);
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => issue.label === 'HTTP detail codex/long-team-compaction' && issue.reason.includes('identity')));
  assert.ok(result.issues.some((issue) => issue.label === 'MCP get pi/available-live' && issue.reason.includes('identity')));
  assert.ok(result.issues.some((issue) => issue.label === 'MCP get claude-code/available-live' && issue.reason.includes('error')));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_WRONG_SESSION_ID|PRIVATE_WRONG_PROVIDER/);
});

test('rejects missing recorded compaction events and invalid protocol validation', () => {
  const fixture = makeFixture();
  const codex = fixture.readerProtocol.cases.find((item) => item.id === 'http.protocol.codex');
  codex.result.body.protocol.events = codex.result.body.protocol.events.slice(0, 1);
  const dsh = fixture.readerProtocol.cases.find((item) => item.id === 'http.protocol.deepseek-harness');
  dsh.result.body.validation.ok = false;

  const result = verifySourceFacts(fixture);
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => issue.reason.includes('recorded context.compaction count')));
  assert.ok(result.issues.some((issue) => issue.label === 'HTTP protocol deepseek-harness/native-v3-packed-compaction' && issue.reason.includes('validation')));
});

test('requires all five providers to be available in each captured provider list', () => {
  const fixture = makeFixture();
  fixture.httpDetails.cases.find((item) => item.id === 'http.providers').result.body[2].available = false;

  const result = verifySourceFacts(fixture);
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => issue.label === 'HTTP providers codex' && issue.reason === 'provider is unavailable'));
});

test('validates full-cursor page state, expected totals, and unique canonical references', () => {
  const fixture = makeFixture(true);
  const result = verifySourceFacts(fixture);

  assert.equal(result.passed, true);
  assert.equal(result.counts.paginationPages, 50);
  assert.equal(result.counts.paginationRows, 2338);

  const codex = fixture.mcpPagination.cases.find((item) => item.id === 'mcp.timeline.all.codex');
  codex.result.pages[0].structuredContent.result.truncated = false;
  const cursorResult = verifySourceFacts(fixture);
  assert.ok(cursorResult.issues.some((issue) => issue.reason === 'cursor and truncated state disagree'));

  const repeated = makeFixture(true);
  const page = repeated.mcpPagination.cases.find((item) => item.id === 'mcp.timeline.all.deepseek-harness').result.pages[0];
  page.structuredContent.result.events[1].event = { ...page.structuredContent.result.events[0].event };
  const duplicateResult = verifySourceFacts(repeated);
  assert.ok(duplicateResult.issues.some((issue) => issue.reason === 'canonical source reference repeats'));

  const wrongSession = makeFixture(true);
  wrongSession.mcpPagination.cases.find((item) => item.id === 'mcp.timeline.all.codex')
    .result.pages[0].structuredContent.result.events[0].event.sessionId = 'PRIVATE_WRONG_SESSION';
  const wrongSessionResult = verifySourceFacts(wrongSession);
  assert.ok(wrongSessionResult.issues.some((issue) => issue.reason === 'canonical source reference is invalid'));
  assert.doesNotMatch(JSON.stringify(wrongSessionResult), /PRIVATE_WRONG_SESSION/);

  const wrongOrder = makeFixture(true);
  const roots = wrongOrder.mcpPagination.cases.find((item) => item.id === 'mcp.browse.opencode.all-roots')
    .result.pages[0].structuredContent.result.sessions;
  [roots[0], roots[1]] = [roots[1], roots[0]];
  const wrongOrderResult = verifySourceFacts(wrongOrder);
  assert.ok(wrongOrderResult.issues.some((issue) => issue.reason === 'ordered canonical refs differ from source SQLite'));

  const wrongTimelineOrder = makeFixture(true);
  const timeline = wrongTimelineOrder.mcpPagination.cases.find((item) => item.id === 'mcp.timeline.all.codex')
    .result.pages[0].structuredContent.result.events;
  [timeline[0], timeline[1]] = [timeline[1], timeline[0]];
  const wrongTimelineResult = verifySourceFacts(wrongTimelineOrder);
  assert.ok(wrongTimelineResult.issues.some((issue) => issue.reason === 'event reference is missing from or out of order in source JSONL'));
});

test('CLI exits nonzero on corrupted snapshots and keeps private values out of its report', async () => {
  const fixture = makeFixture();
  fixture.mcp.cases.find((item) => item.id === 'mcp.get.opencode.long').result.response.structuredContent.result.session.sessionId = 'PRIVATE_CLI_SESSION_ID';
  const directory = await mkdtemp(join(tmpdir(), 'agentsession-v3-source-facts-'));
  try {
    const inputs = [
      ['manifest', fixture.manifest],
      ['http-details', fixture.httpDetails],
      ['reader-protocol', fixture.readerProtocol],
      ['mcp', fixture.mcp],
    ];
    const paths = new Map();
    await Promise.all(inputs.map(async ([name, value]) => {
      const path = join(directory, `${name}.json`);
      paths.set(name, path);
      await writeFile(path, JSON.stringify(value), 'utf8');
    }));
    const child = spawnSync(process.execPath, [
      SCRIPT,
      '--manifest', paths.get('manifest'),
      '--http-details', paths.get('http-details'),
      '--reader-protocol', paths.get('reader-protocol'),
      '--mcp', paths.get('mcp'),
    ], { encoding: 'utf8' });

    assert.equal(child.status, 1);
    assert.match(child.stdout, /FAIL source-facts checks=/);
    assert.doesNotMatch(child.stdout + child.stderr, /PRIVATE_CLI_SESSION_ID|PRIVATE_MCP_BODY|PRIVATE_EVENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
