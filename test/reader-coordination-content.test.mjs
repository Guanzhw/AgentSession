import assert from 'node:assert/strict';
import test from 'node:test';
import { registerReaderCoordinationRoutes, readerCoordinationDocumentContent } from '../dist/src/routes/reader-coordination.js';
import { renderReaderCoordinationItem, renderReaderCoordinationContentPage } from '../dist/src/views/reader-coordination.js';
import { deriveReaderCoordinationPage } from '../dist/src/reader-coordination.js';
import { setLocale } from '../dist/src/i18n.js';

let fixtureIndex = 0;
function fixture() {
  const provider = `fixture-${++fixtureIndex}`;
  const observations = ['spawn', 'follow-up', 'result-delivery', 'follow-up', 'result-delivery'].map((kind, index) => ({
    id: `exchange:${index}`, sessionId: 'root', kind, state: 'unknown', timestamp: index,
    senderActorId: 'main', recipientActorId: 'worker', runId: 'run', taskId: null,
    eventId: null, sourceEventRef: null, turnId: null,
    provenance: { fidelity: 'recorded', sourceType: 'fixture', sourceId: `source:${index}` }
  }));
  const protocol = {
    version: 3, sessionId: 'root', session: { ref: { provider, sessionId: 'root' } },
    actors: [{ id: 'main', name: 'Main Agent' }, { id: 'worker', name: 'Reviewer', runIds: ['run'] }],
    coordination: observations, events: [], tasks: [], relationships: [],
    agentRuns: [{ id: 'run', kind: 'subagent' }]
  };
  const texts = new Map(observations.map((item, index) => [item.id, `Exact exchange ${index}`]));
  const contentReads = [];
  const messageReads = [];
  const sessionReads = [];
  const protocolReads = [];
  const adapter = {
    id: provider,
    getSession(sessionId) { sessionReads.push(sessionId); return sessionId === 'root' ? { id: sessionId } : null; },
    getSessionProtocolV3(sessionId) { protocolReads.push(sessionId); return protocol; },
    getMessages(sessionId) { messageReads.push(sessionId); return []; },
    getReaderCoordinationContent(sessionId, observation) {
      assert.equal(sessionId, 'root');
      assert.equal(observations.find((item) => item.id === observation.id), observation);
      contentReads.push(observation.id);
      return texts.has(observation.id) ? { text: texts.get(observation.id), format: 'markdown' } : null;
    }
  };
  const routes = [];
  registerReaderCoordinationRoutes({ get(pattern, handler) { routes.push({ pattern, handler }); } }, { providerMap: new Map([[provider, adapter]]) });
  const request = async (id, query = '') => {
    const path = `/api/${provider}/session/root/reader/coordination/${encodeURIComponent(id)}/content`;
    const route = routes.find((candidate) => candidate.pattern.test(path));
    const response = { status: 0, body: '', writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    await route.handler({ url: `${path}${query}` }, response, path.match(route.pattern));
    return { status: response.status, data: JSON.parse(response.body) };
  };
  return { provider, observations, protocol, texts, adapter, request, contentReads, messageReads, sessionReads, protocolReads };
}

test('two follow-ups and two returns keep their individual bodies on one task', async () => {
  const f = fixture();
  for (const [index, observation] of f.observations.entries()) {
    const result = await f.request(observation.id);
    assert.equal(result.status, 200);
    assert.equal(result.data.observationId, observation.id);
    assert.match(result.data.html, new RegExp(`Exact exchange ${index}`));
    assert.equal(result.data.nextOffset, null);
    assert.equal(result.data.available, true);
    assert.doesNotMatch(result.data.html, new RegExp(`Exact exchange ${(index + 1) % 5}`));
  }
  assert.deepEqual(f.contentReads, f.observations.map((item) => item.id));
  assert.deepEqual(f.messageReads, [], 'Provider-resolved content does not pre-read child documents');
});

test('exchange continuation preserves a non-BMP character at its page boundary', async () => {
  const f = fixture();
  const text = `A${'😀'.repeat(6500)}`;
  f.texts.set('exchange:2', text);
  let current = await f.request('exchange:2');
  assert.equal(current.data.nextOffset, 5999);
  const revision = current.data.revision;
  let rendered = '';
  while (true) {
    rendered += current.data.html;
    assert.equal(Buffer.from(current.data.html, 'utf8').toString('utf8'), current.data.html);
    if (current.data.nextOffset === null) break;
    current = await f.request('exchange:2', `?offset=${current.data.nextOffset}&revision=${revision}`);
    assert.equal(current.status, 200);
  }
  assert.equal([...rendered.matchAll(/😀/gu)].length, 6500);
});

test('long exchange continuation keeps all text and rejects changed versions', async () => {
  const f = fixture();
  f.texts.set('exchange:2', `${'A'.repeat(6500)}\n\n${'B'.repeat(6500)}\n\nFinal marker`);
  const first = await f.request('exchange:2');
  assert.equal(first.data.nextOffset, 6000, 'an oversized paragraph uses a bounded structural page');
  assert.equal(first.data.continuation, null);
  assert.equal(first.data.totalLength, f.texts.get('exchange:2').length);
  let current = first;
  const chunks = [first.data.html];
  let sourceOffset = 0;
  let reconstructed = '';
  while (current.data.nextOffset !== null) {
    reconstructed += f.texts.get('exchange:2').slice(sourceOffset, current.data.nextOffset);
    sourceOffset = current.data.nextOffset;
    current = await f.request('exchange:2', `?offset=${current.data.nextOffset}&revision=${first.data.revision}`);
    assert.equal(current.status, 200);
    assert.equal(current.data.revision, first.data.revision);
    if (sourceOffset === 6000) assert.equal(current.data.continuation?.kind, 'paragraph');
    chunks.push(current.data.html);
  }
  reconstructed += f.texts.get('exchange:2').slice(sourceOffset);
  assert.equal(reconstructed, f.texts.get('exchange:2'));
  assert.match(chunks.at(-1), /Final marker/);
  const missingRevision = await f.request('exchange:2', `?offset=${first.data.nextOffset}`);
  assert.equal(missingRevision.status, 400);
  f.texts.set('exchange:2', 'Updated return');
  const changed = await f.request('exchange:2', `?offset=${first.data.nextOffset}&revision=${first.data.revision}`);
  assert.equal(changed.status, 409);
  assert.equal(changed.data.code, 'stale_content');
  assert.doesNotMatch(JSON.stringify(changed.data), /Updated return/);
  f.texts.delete('exchange:2');
  const removed = await f.request('exchange:2', `?offset=${first.data.nextOffset}&revision=${first.data.revision}`);
  assert.equal(removed.status, 409);
  assert.equal(removed.data.code, 'stale_content');
});

test('fenced exchange pages carry explicit continuation metadata and bounded escaped HTML', async () => {
  const f = fixture();
  const code = 'const value = `<script>`;\n'.repeat(2200);
  const source = `\`\`\`ts\n${code}\`\`\`\n\nafter`;
  f.texts.set('exchange:2', source);
  const pages = [];
  let offset = 0;
  let revision = '';
  do {
    const response = await f.request('exchange:2', offset ? `?offset=${offset}&revision=${revision}` : '');
    assert.equal(response.status, 200);
    const page = response.data;
    revision = page.revision;
    pages.push(page);
    assert.ok(page.html.length < 80000, 'one page does not render the whole long field');
    offset = page.nextOffset;
  } while (offset !== null);
  assert.ok(pages.some((page) => page.continuation?.kind === 'fence'));
  const fragments = pages.flatMap((page) => [...page.html.matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map((match) => match[1]));
  const decoded = fragments.join('').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.equal(decoded, code.trimEnd());
  assert.ok(pages.every((page) => !page.html.includes('<script>')));
  assert.match(pages.at(-1).html, /after/);
});

test('unavailable exchange bodies stay explicit and arbitrary observations do not reach the adapter', async () => {
  const f = fixture();
  f.texts.delete('exchange:2');
  const unavailable = await f.request('exchange:2');
  assert.equal(unavailable.status, 200);
  assert.equal(unavailable.data.available, false);
  assert.match(unavailable.data.html, /data-reader-coordination-content-unavailable/);
  assert.equal(unavailable.data.totalLength, null);
  const missing = await f.request('wrong');
  assert.equal(missing.status, 404);
  assert.equal(missing.data.code, 'observation_not_found');
  assert.deepEqual(f.contentReads, ['exchange:2']);
  const invalid = await f.request('exchange:2', '?offset=-1');
  assert.equal(invalid.status, 400);
  f.observations[2].sourceEventRef = { session: { provider: f.provider, sessionId: 'missing-child' }, eventId: 'event:completion' };
  const missingChild = await f.request('exchange:2');
  assert.equal(missingChild.status, 200);
  assert.equal(missingChild.data.available, false);
  assert.ok(f.sessionReads.every((id) => id === 'root'), 'A provider-declared unavailable body does not query the child session');
  assert.ok(f.protocolReads.every((id) => id === 'root'), 'A missing child completion body does not prepare another protocol or child family');
  assert.deepEqual(f.messageReads, []);
});

test('an adapter without a content hook reads only the exact normalized source message', async () => {
  const f = fixture();
  delete f.adapter.getReaderCoordinationContent;
  f.observations[2].eventId = 'source-event';
  f.protocol.events.push({
    id: 'source-event', sessionId: 'root', sequence: 2, timestamp: 2,
    kind: 'message.assistant', normalizedKind: 'message.assistant', category: 'message',
    messageId: 'exact', partId: 'exact:text', toolCallId: null,
    provenance: f.observations[2].provenance
  });
  f.adapter.getMessages = (sessionId) => {
    f.messageReads.push(sessionId);
    return [
      { id: 'exact', role: 'assistant', content: 'Exact original body' },
      { id: 'later', role: 'assistant', content: 'Do not substitute this latest body' }
    ];
  };
  const response = await f.request('exchange:2');
  assert.equal(response.status, 200);
  assert.equal(response.data.available, true);
  assert.match(response.data.html, /Exact original body/);
  assert.doesNotMatch(response.data.html, /Do not substitute/);
  assert.deepEqual(f.messageReads, ['root']);
});

test('a source revision changed during the selected read cannot pair new text with the old observation', async () => {
  const f = fixture();
  let revision = 1;
  f.adapter.getReaderCoordinationContentRevision = () => String(revision);
  f.adapter.getReaderCoordinationContent = () => {
    revision += 1;
    return { text: 'Rewritten source body', format: 'markdown' };
  };
  const response = await f.request('exchange:2');
  assert.equal(response.status, 409);
  assert.equal(response.data.code, 'stale_content');
  assert.doesNotMatch(JSON.stringify(response.data), /Rewritten source body/);
});

test('unrelated provider index activity does not invalidate a stable exchange source', async () => {
  const f = fixture();
  let indexRevision = 1;
  f.adapter.getProtocolRevision = () => indexRevision++;
  f.adapter.getReaderCoordinationContentRevision = () => 'same-selected-source';
  const response = await f.request('exchange:2');
  assert.equal(response.status, 200);
  assert.match(response.data.html, /Exact exchange 2/);
  assert.deepEqual(f.contentReads, ['exchange:2']);
});

test('removing the observation invalidates an existing continuation before reading another body', async () => {
  const f = fixture();
  f.texts.set('exchange:2', 'Long original body '.repeat(500));
  const first = await f.request('exchange:2');
  assert.equal(first.status, 200);
  assert.ok(first.data.nextOffset > 0);
  f.protocol.coordination = f.protocol.coordination.filter((item) => item.id !== 'exchange:2');
  const removed = await f.request('exchange:2', `?offset=${first.data.nextOffset}&revision=${first.data.revision}`);
  assert.equal(removed.status, 409);
  assert.equal(removed.data.code, 'stale_content');
  const reload = await f.request('exchange:2');
  assert.equal(reload.status, 404);
  assert.equal(reload.data.code, 'observation_not_found');
  assert.deepEqual(f.contentReads, ['exchange:2']);
});

test('exact normalized text fallback never selects a latest answer or interprets tool input', () => {
  const document = {
    messages: [{ id: 'first', data: {} }, { id: 'latest', data: {} }, { id: 'tool', data: {} }],
    partsByMessage: new Map([
      ['first', [{ id: 'first:text', data: { type: 'text', text: 'First return' } }]],
      ['latest', [{ id: 'latest:text', data: { type: 'text', text: 'Latest return' } }]],
      ['tool', [{ id: 'tool:call', data: { type: 'tool', state: { input: { message: 'Do not guess' } } } }]]
    ])
  };
  assert.equal(readerCoordinationDocumentContent(document, { partId: 'first:text' }).text, 'First return');
  assert.equal(readerCoordinationDocumentContent(document, { partId: 'missing' }), null);
  assert.equal(readerCoordinationDocumentContent(document, { partId: 'tool:call' }), null);
  document.partsByMessage.get('first').push({ id: 'first:tail', data: { type: 'text', text: 'Rest of the same return' } });
  assert.equal(readerCoordinationDocumentContent(document, { messageId: 'first' }).text, 'First return\n\nRest of the same return');
  assert.equal(readerCoordinationDocumentContent(document, { partId: 'first:text' }).text, 'First return');
  document.partsByMessage.get('first')[0].contentScope = 'inherited-context';
  assert.equal(readerCoordinationDocumentContent(document, { partId: 'first:text' }), null);
});

test('channel markup is body-free, uses one localized row shape and retains actor direction on continuation', () => {
  setLocale('zh');
  const f = fixture();
  const page = deriveReaderCoordinationPage(f.protocol, { provider: f.provider, sessionId: 'root', runId: 'run' });
  assert.equal(page.ok, true);
  const item = page.items[1];
  assert.equal(item.senderName, 'Main Agent');
  assert.equal(item.recipientName, 'Reviewer');
  const markup = renderReaderCoordinationItem(item, f.provider, 'root');
  assert.match(markup, /Main Agent → Reviewer/);
  assert.match(markup, /data-reader-coordination-content-url=/);
  assert.doesNotMatch(markup, /<details[^>]+ open|Exact exchange|>follow-up<|conversation\.channel_/);
  assert.deepEqual(f.contentReads, []);
  const finished = renderReaderCoordinationItem({ ...item, kind: 'child-turn-completed', state: 'completed' }, f.provider, 'root');
  assert.match(finished, /任务完成/);
  assert.doesNotMatch(finished, /class="agent-channel-state"/);
  const failed = renderReaderCoordinationItem({ ...item, kind: 'child-turn-completed', state: 'failed' }, f.provider, 'root');
  assert.match(failed, /class="agent-channel-state"/);
  const escaped = renderReaderCoordinationContentPage({ text: '<script>unsafe()</script>', format: 'plain' }, 0);
  assert.doesNotMatch(escaped.html, /<script>/);
  assert.match(escaped.html, /&lt;script&gt;/);
  setLocale('en');
});

test('source action opens exact event details without repeating a disclosure', () => {
  setLocale('en');
  const f = fixture();
  const page = deriveReaderCoordinationPage(f.protocol, { provider: f.provider, sessionId: 'root', runId: 'run' });
  const base = page.items[1];
  const callMarkup = renderReaderCoordinationItem({
    ...base,
    eventId: 'event:call',
    sourceEventRef: { session: { provider: f.provider, sessionId: 'root' }, eventId: 'event:call' }
  }, f.provider, 'root');
  assert.match(callMarkup, /<div class="reader-coordination-content-actions"><a[^>]*>View event details<\/a><\/div>/);
  assert.match(callMarkup, /data-reader-event-id="event:call"/);
  assert.equal((callMarkup.match(/data-reader-event-source/g) || []).length, 1);
  assert.doesNotMatch(callMarkup, /reader-coordination-technical/);

  const eventMarkup = renderReaderCoordinationItem({
    ...base,
    eventId: 'event:message',
    sourceEventRef: { session: { provider: f.provider, sessionId: 'root' }, eventId: 'event:message' }
  }, f.provider, 'root');
  assert.match(eventMarkup, /<div class="reader-coordination-content-actions"><a[^>]*>View event details<\/a><\/div>/);
  setLocale('en');
});
