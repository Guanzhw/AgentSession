import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(new URL('../ui/package.json', import.meta.url));
const { createServer } = require('vite');

test('Reader execution pages use the revision-bound Reader route while Runtime Events keep their route', async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../ui/', import.meta.url)),
    server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  const originalFetch = globalThis.fetch;
  const requests = [];
  try {
    const { getReaderExecutionEvents, getRuntimeEvents } = await server.ssrLoadModule('/src/lib/api.ts');
    const page = { session: { provider: 'codex', sessionId: 'reader/session' }, revision: 'source revision',
      coverage: 'partial', events: [], nextCursor: null, scannedEvents: 0 };
    globalThis.fetch = async (input, options) => {
      requests.push({ url: String(input), options });
      return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    assert.deepEqual(await getReaderExecutionEvents('codex', 'reader/session', 'source revision'), page);
    assert.deepEqual(await getReaderExecutionEvents('codex', 'reader/session', 'source revision', {
      cursor: 'next/page', limit: 37,
    }), page);
    assert.deepEqual(await getRuntimeEvents('codex', 'reader/session', { category: 'tool', limit: 25 }), page);

    assert.deepEqual(requests.map(({ url }) => {
      const parsed = new URL(url, 'http://localhost');
      return [parsed.pathname, parsed.searchParams.get('revision'), parsed.searchParams.get('limit'),
        parsed.searchParams.get('cursor'), parsed.searchParams.get('category')];
    }), [
      ['/api/v3/reader/codex/reader%2Fsession/executions', 'source revision', '200', null, null],
      ['/api/v3/reader/codex/reader%2Fsession/executions', 'source revision', '37', 'next/page', null],
      ['/api/v3/runtime/codex/reader%2Fsession/events', null, '25', null, 'tool'],
    ]);
    assert.ok(requests.every(({ options }) => options.cache === 'no-store'));
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
});
