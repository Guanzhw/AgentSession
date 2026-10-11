import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const { createServer } = createRequire(new URL('../ui/package.json', import.meta.url))('vite');

test('Runtime history preserves the bounded investigation and other Reader history fields', async t => {
  const server = await createServer({ root: fileURLToPath(new URL('../ui/', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', logLevel: 'error' });
  t.after(() => server.close());
  const { readRuntimeHistory, saveRuntimeHistory, runtimeHash, runtimeLensFromHash, runtimeSourceHash } =
    await server.ssrLoadModule('/src/lib/runtime-history.ts');
  const originalWindow = globalThis.window;
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  const readerSearch = { query: 'recorded work', selectedIndex: 2 };
  globalThis.window = {
    location: { pathname: '/codex/session/current', search: '', hash: '#runtime?lens=events' },
    history: {
      state: { agentSessionReaderSearch: readerSearch, library: { query: 'saved query' } },
      replaceState(state, _unused, href) {
        this.state = structuredClone(state);
        globalThis.window.location.hash = new URL(href, 'http://127.0.0.1').hash;
      },
    },
  };
  const investigation = {
    provider: 'codex', sessionId: 'current', lens: 'events', scrollY: 1400,
    events: { category: 'tool', kind: 'tool.call', cursor: 'request-for-page-two', revision: 'strict-revision' },
    domains: {}, focusNodeId: null,
  };
  saveRuntimeHistory(investigation);
  assert.deepEqual(readRuntimeHistory('codex', 'current'), investigation);
  assert.equal(readRuntimeHistory('pi', 'current'), null, 'a different provider cannot inherit a Runtime snapshot');
  assert.equal(readRuntimeHistory('codex', 'other'), null, 'a related session cannot inherit its parent snapshot');
  assert.deepEqual(window.history.state.agentSessionReaderSearch, readerSearch);
  assert.deepEqual(window.history.state.library, { query: 'saved query' });
  assert.equal(window.location.hash, '#runtime?lens=events');
  for (const lens of ['events', 'work', 'summary', 'sessions', 'execution', 'coordination', 'context']) {
    window.location.hash = runtimeHash(lens, 'related node 中文');
    assert.equal(runtimeLensFromHash(), lens);
  }
  assert.equal(new URLSearchParams(runtimeHash('sessions', 'related node 中文').slice(9)).get('node'),
    'related node 中文');
  const event = { provider: 'codex', sessionId: 'current', messageId: 'tool ?#&🙂', segment: 'message' };
  const source = new URLSearchParams(runtimeSourceHash(event, 'strict revision ?#&').slice(7));
  assert.equal(source.get('messageId'), event.messageId);
  assert.equal(source.get('segment'), event.segment);
  assert.equal(source.get('sourceRevision'), 'strict revision ?#&',
    'ordinary and modified source links carry the same strict source revision');
});
