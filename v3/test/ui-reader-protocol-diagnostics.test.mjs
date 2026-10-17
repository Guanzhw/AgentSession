import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(new URL('../ui/package.json', import.meta.url));
const { createServer } = require('vite');

test('Reader execution API retains bounded protocol diagnostics with unknown codes', async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../ui/', import.meta.url)),
    server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
  const originalFetch = globalThis.fetch;
  try {
    const { getReaderExecutionEvents, ApiRequestError } = await server.ssrLoadModule('/src/lib/api.ts');
    const diagnostics = [{ code: 'duplicate_event_id', event_id: 'event-1' },
      { code: 'future_provider_diagnostic', event_id: null }];
    globalThis.fetch = async () => new Response(JSON.stringify({ error: {
      code: 'protocol_invalid', message: 'protocol evidence is invalid', diagnostics, diagnosticsTruncated: true,
    } }), { status: 422 });
    await assert.rejects(getReaderExecutionEvents('codex', 'session', 'revision'), error => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.code, 'protocol_invalid');
      assert.deepEqual(error.diagnostics, diagnostics);
      assert.equal(error.diagnosticsTruncated, true);
      return true;
    });
    globalThis.fetch = async () => new Response(JSON.stringify({ error: {
      code: 'source_changed', message: 'source changed',
    } }), { status: 409 });
    await assert.rejects(getReaderExecutionEvents('codex', 'session', 'revision'), error => {
      assert.deepEqual(error.diagnostics, []);
      assert.equal(error.diagnosticsTruncated, false);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
});

test('known protocol and DSH source diagnostics have bilingual labels and unknown codes stay visible', async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../ui/', import.meta.url)),
    server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
  try {
    const { diagnosticText } = await server.ssrLoadModule('/src/lib/i18n.ts');
    assert.equal(diagnosticText('en', 'duplicate_event_id'), 'Recorded event IDs are duplicated.');
    assert.equal(diagnosticText('zh', 'duplicate_event_id'), '已记录的事件 ID 重复。');
    assert.equal(diagnosticText('en', 'malformed_source_record'), 'A recorded source entry could not be parsed.');
    assert.equal(diagnosticText('zh', 'malformed_source_record'), '一条已记录的来源条目无法解析。');
    for (const code of ['dsh_mixed_source_encodings', 'dsh_duplicate_source_generation']) {
      assert.notEqual(diagnosticText('en', code), code);
      assert.notEqual(diagnosticText('zh', code), diagnosticText('en', code));
    }
    assert.equal(diagnosticText('zh', 'future_provider_diagnostic'), 'future_provider_diagnostic');
  } finally {
    await server.close();
  }
});

test('library source diagnosis renders for root, child and unresolved-parent rows', async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../ui/', import.meta.url)),
    server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
  try {
    const { language } = await server.ssrLoadModule('/src/lib/i18n.ts');
    const { default: Library } = await server.ssrLoadModule('/src/lib/LibraryPage.svelte');
    const { render } = await server.ssrLoadModule('svelte/server');
    const summary = (id, diagnostic, parent = null) => ({
      session: { provider: 'deepseek-harness', sessionId: id }, title: id, directory: null,
      createdAt: null, updatedAt: null, messageCount: 0, tokenCount: null, parent, diagnostic,
    });
    const node = (session, parentBoundary = null, childCount = 0) => ({ session, parentBoundary,
      starred: false, matched: true, matchingCount: 1, childCount, totalChildCount: childCount,
      familyRootId: session.session.sessionId, familyUpdated: null });
    const root = node(summary('root', 'dsh_mixed_source_encodings'), null, 1);
    const child = node(summary('child', 'dsh_duplicate_source_generation', root.session.session));
    const unlinked = node(summary('orphan', 'dsh_duplicate_source_generation',
      { provider: 'deepseek-harness', sessionId: 'unavailable' }), 'missing-parent');
    const props = { families: [root, unlinked], familyTotal: 2, matchingSessions: 3,
      childrenByParent: { 'deepseek-harness/root': [child] },
      expandedFamilies: ['deepseek-harness/root'],
      providers: [{ id: 'deepseek-harness', available: true, manageable: true }] };
    language.set('en');
    const english = render(Library, { props }).body;
    assert.match(english, /History unavailable: mixed DSH source encodings/);
    assert.equal(english.match(/History unavailable: duplicate DSH source generations/g)?.length, 2);
    language.set('zh');
    const chinese = render(Library, { props }).body;
    assert.match(chinese, /历史记录暂不可用：DSH 来源编码混用/);
    assert.equal(chinese.match(/历史记录暂不可用：DSH 同代来源重复/g)?.length, 2);
  } finally {
    await server.close();
  }
});
