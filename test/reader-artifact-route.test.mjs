import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(os.tmpdir(), 'agentsession-artifact-route-'));
process.env.AGENTSESSION_META_PATH = path.join(directory, 'meta.db');
const { initConfig } = await import('../dist/src/config.js');
initConfig(['--config', path.join(directory, 'config.json')]);
const { closeMetaDb } = await import('../dist/src/meta.js');
const { registerSessionDetail } = await import('../dist/src/routes/session-detail.js');
const { renderProgressiveContent } = await import('../dist/src/views/components.js');
test.after(() => { closeMetaDb(); rmSync(directory, { recursive: true, force: true }); });

function contentRoute(adapter, suffix = 'content') {
  const routes = [];
  registerSessionDetail({ get(pattern, handler) { routes.push({ pattern, handler }); } }, {
    appConfig: { port: 0, projectPaths: {}, resumeCommands: {}, allowTerminalLaunch: false },
    providerMap: new Map([[adapter.id, adapter]]), providerInfo: []
  });
  return async (query, provider = adapter.id, sessionId = 'input-session') => {
    const pathname = `/api/${provider}/session/${encodeURIComponent(sessionId)}/${suffix}`;
    const route = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.test(pathname));
    const response = { status: 0, body: '', writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    await route.handler({ url: `${pathname}?${new URLSearchParams(query)}` }, response, pathname.match(route.pattern));
    return { status: response.status, body: JSON.parse(response.body) };
  };
}

test('saved artifact content reads all version-bound pages without preparing any transcript', async () => {
  const content = `# Saved memory\n\n${'A retained paragraph with 中文 and an emoji 🧭.\n\n'.repeat(310)}Final retained line.\n<script>alert(1)</script>`;
  const calls = [];
  const noTranscript = () => { throw new Error('Artifact body must not read transcript, family, or protocol'); };
  const request = contentRoute({
    id: 'codex', getSession: noTranscript, getMessages: noTranscript, getSessionTree: noTranscript,
    getSessionProtocolSnapshots: noTranscript, getSessionReaderSnapshot: noTranscript,
    getContextArtifactContent(sessionId, artifactId) {
      calls.push({ sessionId, artifactId });
      return { status: 'readable', artifactId, content, format: 'markdown' };
    }
  });
  let offset = 0;
  let pages = 0;
  do {
    const response = await request({ scope: 'context-artifact', artifact: 'versioned:artifact', field: 'content', offset: String(offset) });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      ok: true, scope: 'context-artifact', provider: 'codex', sessionId: 'input-session',
      artifactId: 'versioned:artifact', field: 'content', ...renderProgressiveContent(content, 'markdown', offset, 6000)
    });
    assert.doesNotMatch(response.body.html, /<script\b/);
    if (response.body.nextOffset !== null) assert.ok(response.body.nextOffset > offset);
    offset = response.body.nextOffset;
    pages++;
  } while (offset !== null);
  assert.ok(pages > 1);
  assert.equal(calls.length, pages);
  assert.ok(calls.every(call => call.sessionId === 'input-session' && call.artifactId === 'versioned:artifact'));
});

test('artifact continuation reports replaced versions, unavailable sources, absent IDs and recorded-empty bodies', async () => {
  const sourceState = { state: 'invalid', code: 'read-failed', sourcePath: 'memory.sqlite',
    provenance: { fidelity: 'recorded', sourceType: 'fixture.memory', sourceId: null } };
  let result = { status: 'readable', artifactId: 'old', content: 'Original content', format: 'plain' };
  const request = contentRoute({ id: 'codex', getContextArtifactContent: () => result });
  const query = { scope: 'context-artifact', artifact: 'old', field: 'content', offset: '0' };
  assert.equal((await request(query)).status, 200);
  result = { status: 'stale' };
  const stale = await request({ ...query, offset: '6000' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'artifact_stale');
  assert.equal(stale.body.html, undefined, 'a new body must not continue an old page');
  result = { status: 'unavailable', sourceState };
  const unavailable = await request(query);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.body.sourceState, sourceState);
  result = { status: 'not-found' };
  assert.equal((await request(query)).status, 404);
  result = { status: 'readable', artifactId: 'empty', content: '', format: 'markdown' };
  const empty = await request({ ...query, artifact: 'empty' });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.totalLength, 0);
  assert.equal(empty.body.nextOffset, null);
});

test('artifact content validates HTTP identity and continuation fields before calling the provider', async () => {
  let calls = 0;
  const request = contentRoute({ id: 'codex', getContextArtifactContent() { calls++; return { status: 'not-found' }; } });
  const query = { scope: 'context-artifact', artifact: 'artifact', field: 'content', offset: '0' };
  for (const change of [{ artifact: '' }, { artifact: 'x'.repeat(2049) }, { field: 'text' }, { offset: '-1' }, { offset: '1.5' }, { offset: 'NaN' }]) {
    assert.equal((await request({ ...query, ...change })).status, 400);
  }
  assert.equal((await request(query, 'not-installed')).status, 404);
  assert.equal(calls, 0);
  assert.equal((await contentRoute({ id: 'fixture' })(query)).status, 404);
});

test('artifact evidence pages use the exact artifact and bounded selector without preparing history', async () => {
  const calls = [];
  const noTranscript = () => { throw new Error('Evidence must not load transcript or protocol'); };
  const coverage = { from: 1700000000000, to: 1700003600000, scannedRecords: 45, readBytes: 8200, complete: false, issues: ['metadata-budget'] };
  const provenance = { fidelity: 'recorded', sourceType: 'fixture.log', sourceId: 'r1' };
  const activity = { id: 'activity-one', sessionId: 'generation', turnId: 'turn', timeCreated: coverage.from + 1000, provenance, historyAvailability: 'unavailable',
    binding: { sourcePath: 'C:\\memories\\summary.md', fileHash: 'abc', checkedAt: coverage.to, sourceSessionId: 'input-session', sourceUpdatedAt: coverage.from, provenance: { fidelity: 'derived', sourceType: 'fixture.file-match' } },
    records: [{ id: 'record-one', kind: 'modification-request', targetPath: '/memories/MEMORY.md', timeCreated: coverage.from + 2000, provenance, contentLength: 30000 }] };
  const page = { status: 'page', artifactId: 'summary-version', revision: 'evidence-r1', coverage, activities: [activity], nextCursor: 'next-page' };
  const request = contentRoute({ id: 'codex', getSession: noTranscript, getMessages: noTranscript, getSessionReaderSnapshot: noTranscript, getSessionProtocol: noTranscript,
    getContextArtifactContent: noTranscript,
    getContextArtifactEvidence(sessionId, artifactId, selector) { calls.push({ sessionId, artifactId, selector }); return page; }
  }, 'artifact-evidence');
  const result = await request({ artifact: 'summary-version', from: String(coverage.from), to: String(coverage.to) });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.activities, [activity]);
  assert.equal(result.body.revision, 'evidence-r1');
  assert.match(result.body.html, /Request to modify/);
  assert.match(result.body.html, /data-content-scope="artifact-evidence"/);
  assert.match(result.body.coverageHtml, /has not been fully checked/);
  assert.deepEqual(calls[0], { sessionId: 'input-session', artifactId: 'summary-version', selector: { mode: 'page', from: coverage.from, to: coverage.to } });
  await request({ artifact: 'summary-version', cursor: 'next-page' });
  assert.deepEqual(calls[1].selector, { mode: 'page', cursor: 'next-page' });
});

test('artifact evidence validates HTTP selectors and preserves explicit failure states', async () => {
  let calls = 0;
  let result = { status: 'invalid' };
  const request = contentRoute({ id: 'fixture', getContextArtifactEvidence() { calls++; return result; } }, 'artifact-evidence');
  const query = { artifact: 'summary-version' };
  for (const change of [{ artifact: '' }, { artifact: 'x'.repeat(2049) }, { cursor: '' }, { cursor: 'x'.repeat(16385) }, { from: '' }, { to: 'NaN' }, { from: '-1' }, { from: '1.5' }, { from: '2', to: '1' }, { cursor: 'next', from: '1' }]) {
    assert.equal((await request({ ...query, ...change })).status, 400);
  }
  assert.equal(calls, 0);
  assert.equal((await request(query)).body.code, 'evidence_invalid');
  result = { status: 'stale' };
  assert.equal((await request(query)).status, 409);
  result = { status: 'not-found' };
  assert.equal((await request(query)).status, 404);
  result = { status: 'unavailable', sourceState: { state: 'invalid', code: 'unsupported-schema', sourcePath: 'logs.sqlite', provenance: { fidelity: 'recorded', sourceType: 'fixture.logs' } } };
  const unavailable = await request(query);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.body.sourceState, result.sourceState);
  assert.equal((await contentRoute({ id: 'fixture' }, 'artifact-evidence')(query)).status, 404);
});

test('retained evidence commands page as plain text with their own version-bound record selector', async () => {
  const content = `${'A long request with 中文 🧭\n'.repeat(500)}<script>private()</script>`;
  const calls = [];
  let result = { status: 'content', artifactId: 'summary-version', recordId: 'record-version', content };
  const request = contentRoute({ id: 'fixture', getContextArtifactEvidence(sessionId, artifactId, selector) { calls.push({ sessionId, artifactId, selector }); return result; } });
  const query = { scope: 'artifact-evidence', artifact: 'summary-version', record: 'record-version', field: 'content' };
  let offset = 0;
  do {
    const response = await request({ ...query, offset: String(offset) });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, scope: 'artifact-evidence', provider: 'fixture', sessionId: 'input-session', artifactId: 'summary-version', recordId: 'record-version', field: 'content', ...renderProgressiveContent(content, 'plain', offset, 6000) });
    assert.doesNotMatch(response.body.html, /<script>/);
    offset = response.body.nextOffset;
  } while (offset !== null);
  assert.ok(calls.length > 1);
  assert.ok(calls.every(({ selector }) => selector.mode === 'content' && selector.recordId === 'record-version'));
  const priorCalls = calls.length;
  for (const change of [{ record: '' }, { record: 'x'.repeat(16385) }, { offset: '-1' }]) assert.equal((await request({ ...query, ...change })).status, 400);
  assert.equal(calls.length, priorCalls);
  result = { status: 'stale' };
  assert.equal((await request({ ...query, offset: '6000' })).status, 409);
});
