import assert from 'node:assert/strict';
import test from 'node:test';
import { renderSessionReaderPane, renderReaderProcessChunk } from '../dist/src/views/session.js';
import { registerSessionDetail } from '../dist/src/routes/session-detail.js';
import { buildMessageSessionTree } from '../dist/src/providers/shared/message-session.js';

function fixture(count = 43) {
  const session = { id: 'root', provider: 'fixture', title: 'Process fixture', timeCreated: 1, timeUpdated: 100 };
  const messages = [
    { id: 'answer', sessionId: 'root', role: 'assistant', content: 'Visible answer', timestamp: 1 },
    ...Array.from({ length: count }, (_, index) => ({
      id: `tool-${index}`, sessionId: 'root', role: 'tool', toolName: 'exec',
      thinking: `Reasoning ${index}`, toolInput: { command: `command ${index}` },
      toolOutput: index === count - 1 ? `${'payload '.repeat(1000)}last-page needle` : `Output ${index}`,
      metadata: index === 8 ? { status: 'error' } : {}, timestamp: index + 2
    }))
  ];
  const tree = buildMessageSessionTree(session, messages);
  return { session, messages, tree };
}

function readChunks(html) {
  return [...html.matchAll(/<div data-reader-process-chunk[^>]*data-reader-message-id="([^"]+)"[^>]*data-reader-first-part-id="([^"]+)"[^>]*data-reader-last-part-id="([^"]+)"[^>]*data-reader-process-count="([^"]+)"/g)]
    .map(([, messageId, firstPartId, lastPartId, count]) => ({ messageId, firstPartId, lastPartId, count: Number(count) }));
}

test('process SSR retains all canonical anchors and exposes bounded exact source chunks', () => {
  const { session, tree } = fixture();
  const html = renderSessionReaderPane({ session, sessionTree: tree, provider: 'fixture' });
  assert.match(html, /Visible answer/);
  assert.match(html, /data-reader-execution-count="43" data-reader-process-group/);
  assert.match(html, /1 failed or interrupted/);
  assert.doesNotMatch(html, /class="tool-call|class="reasoning-block|data-load-initial|Output 0|Reasoning 0/);
  const chunks = readChunks(html);
  assert.deepEqual(chunks.map(({ count }) => count), [20, 20, 3]);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(html, /id="msg-answer"/);
  for (let index = 0; index < 43; index += 1) {
    assert.ok(html.includes(`id="part-tool-${index}-tool" data-part-id="tool-${index}:tool" data-reader-process-anchor`));
    assert.ok(html.includes(`id="part-tool-${index}-reasoning" data-part-id="tool-${index}:reasoning" data-reader-process-anchor`));
  }
  // A late source can load directly; no preceding fragment needs rendering.
  const last = renderReaderProcessChunk({ sessionTree: tree, ...chunks[2] });
  assert.equal(last.count, 3);
  assert.match(last.html, /data-progressive-part-id="tool-42:tool" data-progressive-field="output"/);
  assert.match(last.html, /data-progressive-part-id="tool-42:reasoning" data-progressive-field="reasoning"/);
  assert.ok(last.html.indexOf('id="part-tool-40-reasoning"') < last.html.indexOf('id="part-tool-40-tool"'));
  assert.doesNotMatch(last.html, /tool-39:|reader-pane|data-reader-process-anchor|last-page needle/);
  const loaded = chunks.map((chunk) => renderReaderProcessChunk({ sessionTree: tree, ...chunk }).html).join('');
  assert.equal((loaded.match(/class="tool-call /g) || []).length, 43);
  assert.equal((loaded.match(/class="reasoning-block"/g) || []).length, 43);
});

test('process chunks stop at milestones and retain child and task-tool navigation', () => {
  const { session, tree } = fixture(5);
  const childPart = tree.messages[0].parts.find((part) => part.id === 'tool-2:tool');
  const child = { provider: 'fixture', sessionId: 'child', title: 'Child', available: true, parentPartId: childPart.id, link: 'explicit', detached: false };
  const readerRelations = {
    lanes: [{ id: 'lane', name: 'Child', childSession: { provider: 'fixture', sessionId: 'child' }, runIds: [] }],
    unplaced: [], milestones: [{ id: 'returned', laneId: 'lane', kind: 'result-delivery', eventId: 'returned', sequence: 4, timestamp: 4, runId: null,
      sourceEventRef: { session: { provider: 'fixture', sessionId: 'root' }, eventId: 'returned' },
      position: { messageId: 'answer', partId: 'tool-1:tool', side: 'after' } }]
  };
  const ownedReader = { rootTree: tree, children: [child] };
  const input = { session, ownedReader, readerRelations, provider: 'fixture' };
  const html = renderSessionReaderPane(input);
  const chunks = readChunks(html);
  assert.deepEqual(chunks.map(({ firstPartId, lastPartId }) => [firstPartId, lastPartId]), [
    ['tool-0:tool', 'tool-1:tool'], ['tool-3:tool', 'tool-4:tool']
  ]);
  assert.match(html, /id="milestone-returned"/);
  assert.match(html, /data-reader-open[^>]+data-reader-session="child"/);
  assert.match(html, /id="part-tool-2-tool" data-part-id="tool-2:tool"/);
  assert.doesNotMatch(html, /id="part-tool-2-tool"[^>]*data-reader-process-anchor/);
  assert.equal(renderReaderProcessChunk({ ...input, messageId: 'answer', firstPartId: 'tool-0:tool', lastPartId: 'tool-4:tool' }), null);
  // Task tools can own cards even when there is no available child session.
  tree.messages[0].parts.find((part) => part.id === 'tool-4:tool').data.tool = 'task';
  const taskHtml = renderSessionReaderPane({ session, sessionTree: tree, provider: 'fixture' });
  assert.doesNotMatch(taskHtml, /id="part-tool-4-tool"[^>]*data-reader-process-anchor/);
});

test('existing partial process ranges survive appended tools without taking their reasoning', () => {
  const { session, messages, tree } = fixture();
  const oldReference = { messageId: 'answer', firstPartId: 'tool-40:tool', lastPartId: 'tool-42:tool' };
  const original = renderReaderProcessChunk({ sessionTree: tree, ...oldReference });
  messages.push({
    id: 'tool-43', sessionId: 'root', role: 'tool', toolName: 'exec',
    thinking: 'New reasoning after the old range', toolOutput: 'New output', timestamp: 45
  });
  const grown = buildMessageSessionTree(session, messages);
  const retained = renderReaderProcessChunk({ sessionTree: grown, ...oldReference });
  assert.deepEqual(retained, original, 'the old URL retains its exact tools and reasoning');
  assert.equal(retained.count, 3);
  assert.doesNotMatch(retained.html, /tool-43:|part-tool-43/);
  const current = renderReaderProcessChunk({ sessionTree: grown, ...oldReference, lastPartId: 'tool-43:tool' });
  assert.equal(current.count, 4);
  assert.equal((current.html.match(/data-progressive-part-id="tool-42:reasoning"/g) || []).length, 1);
  assert.equal((current.html.match(/data-progressive-part-id="tool-43:reasoning"/g) || []).length, 1);
  assert.ok(current.html.indexOf('id="part-tool-42-tool"') < current.html.indexOf('id="part-tool-43-reasoning"'));
  assert.ok(current.html.indexOf('id="part-tool-43-reasoning"') < current.html.indexOf('id="part-tool-43-tool"'));
  assert.equal(renderReaderProcessChunk({ sessionTree: grown, ...oldReference, firstPartId: 'tool-41:tool' }), null, 'the start must remain a stable chunk head');
  assert.equal(renderReaderProcessChunk({ sessionTree: grown, ...oldReference, lastPartId: 'tool-39:tool' }), null);
  assert.equal(renderReaderProcessChunk({ sessionTree: grown, ...oldReference, firstPartId: 'tool-20:tool' }), null, 'a range cannot cross the 20-tool bound');
});

test('process route validates canonical ranges and preserves full search plus field continuation', async () => {
  const { session, messages, tree } = fixture();
  let ownedTree = tree;
  let ownedReads = 0;
  const provider = {
    id: 'fixture', getSession: (id) => id === session.id ? session : null,
    getMessages: () => messages,
    getOwnedReaderProjection() { ownedReads += 1; return { rootTree: ownedTree, children: [] }; },
    getSessionTree() { throw new Error('legacy family tree must not be loaded'); },
    getSessionMetrics() { throw new Error('metrics must not be loaded'); },
    getInheritedContext() { throw new Error('inherited context must not be loaded'); }
  };
  const routes = [];
  registerSessionDetail({ get(pattern, handler) { routes.push({ pattern, handler }); } }, {
    appConfig: { port: 0, projectPaths: {}, resumeCommands: {}, allowTerminalLaunch: false },
    providerMap: new Map([['fixture', provider]]), providerInfo: []
  });
  const request = async (path, query = '', sessionId = 'root') => {
    const pathname = `/api/fixture/session/${sessionId}/${path}`;
    const route = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.test(pathname));
    assert.ok(route);
    const response = { statusCode: 0, body: '', writeHead(status) { this.statusCode = status; }, end(body = '') { this.body += body; } };
    await route.handler({ url: `${pathname}?${query}` }, response, route.pattern.exec(pathname));
    return { status: response.statusCode, data: JSON.parse(response.body) };
  };
  const reference = { messageId: 'answer', firstPartId: 'tool-40:tool', lastPartId: 'tool-42:tool' };
  const result = await request('reader/process', new URLSearchParams(reference));
  assert.equal(result.status, 200);
  assert.equal(result.data.count, 3);
  for (const [key, value] of Object.entries(reference)) assert.equal(result.data[key], value);
  assert.equal(result.data.provider, 'fixture');
  assert.equal(result.data.sessionId, 'root');
  assert.doesNotMatch(result.data.html, /data-reader-pane|Visible answer|tool-39:/);
  assert.equal(ownedReads, 1);
  assert.equal((await request('reader/process')).data.code, 'invalid_input');
  assert.equal((await request('reader/process', new URLSearchParams(reference), 'missing')).data.code, 'process_not_found');
  for (const invalid of [
    { ...reference, messageId: 'other' },
    { ...reference, firstPartId: 'tool-0:tool' },
    { ...reference, firstPartId: 'tool-41:tool' },
    { ...reference, lastPartId: 'tool-39:tool' }
  ]) {
    assert.equal((await request('reader/process', new URLSearchParams(invalid))).data.code, 'process_not_found');
  }
  const search = await request('search', 'q=needle');
  assert.equal(search.data.coverage, 'complete-owned-content');
  assert.equal(search.data.total, 1);
  assert.equal(search.data.matches[0].partId, 'tool-42:tool');
  let offset = 0;
  let full = '';
  do {
    const page = await request('content', new URLSearchParams({ part: 'tool-42:tool', field: 'output', offset: String(offset) }));
    assert.equal(page.status, 200);
    full += page.data.html;
    offset = page.data.nextOffset;
  } while (offset !== null);
  assert.match(full, /last-page needle/);

  messages.push({ id: 'tool-43', sessionId: 'root', role: 'tool', toolName: 'exec', thinking: 'New reasoning', toolOutput: 'New output', timestamp: 45 });
  ownedTree = buildMessageSessionTree(session, messages);
  const afterAppend = await request('reader/process', new URLSearchParams(reference));
  assert.equal(afterAppend.status, 200);
  assert.deepEqual(afterAppend.data, result.data, 'an active append preserves the already-issued canonical response range');

  provider.getSessionProtocol = () => { throw new Error('recorded protocol is unreadable'); };
  provider.getInheritedContext = () => null;
  const readable = await request('reader');
  assert.equal(readable.status, 200);
  assert.doesNotMatch(readable.data.html, /data-reader-process-chunk/);
  assert.match(readable.data.html, /class="tool-call/);
  assert.match(readable.data.html, /data-progressive-part-id="tool-42:tool"/);
});
