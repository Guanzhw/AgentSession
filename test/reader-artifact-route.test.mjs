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

function contentRoute(adapter) {
  const routes = [];
  registerSessionDetail({ get(pattern, handler) { routes.push({ pattern, handler }); } }, {
    appConfig: { port: 0, projectPaths: {}, resumeCommands: {}, allowTerminalLaunch: false },
    providerMap: new Map([[adapter.id, adapter]]), providerInfo: []
  });
  return async (query, provider = adapter.id, sessionId = 'input-session') => {
    const pathname = `/api/${provider}/session/${encodeURIComponent(sessionId)}/content`;
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
