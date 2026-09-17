import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Router } from '../dist/src/router.js';
import { registerSessionDetail } from '../dist/src/routes/session-detail.js';
import { renderSessionReaderPane } from '../dist/src/views/session.js';
import { buildPartsFromProviderMessages } from '../dist/src/session-queries.js';
import { buildMessageSessionTree } from '../dist/src/providers/shared/message-session.js';
import { renderProgressiveContent } from '../dist/src/views/components.js';

test('folded fields read their exact first and final pages through the registered content route', async (t) => {
  const output = `output-start\n${'payload line\n'.repeat(720)}output-final needle`;
  const input = { payload: `input-start ${'i'.repeat(6200)} input-final` };
  const replacementTokens = "$` $& $' $$";
  const reasoning = `reason-start\n${'context '.repeat(730)}${replacementTokens} ${'tail '.repeat(100)}\n${'thought\n'.repeat(900)}reason-final needle`;
  const messages = [
    { id: 'assistant:1', sessionId: 'child', role: 'assistant', content: 'Readable answer', thinking: reasoning, timestamp: 1 },
    { id: 'tool:1', sessionId: 'child', role: 'tool', content: '', toolName: 'run', toolInput: input, toolOutput: output, timestamp: 2 },
    { id: 'short:1', sessionId: 'child', role: 'tool', content: '', toolName: 'check', toolInput: null, toolOutput: 'short output', timestamp: 3 },
    { id: 'empty:1', sessionId: 'child', role: 'tool', content: '', toolName: 'empty', toolInput: null, toolOutput: '', timestamp: 4 }
  ];
  const session = { id: 'child', provider: 'codex', parentId: 'root', title: 'Folded fixture', directory: '', timeCreated: 1, timeUpdated: 4, messageCount: messages.length };
  const inheritedMessage = { id: 'parent-message', sessionId: 'root', role: 'assistant', content: '', thinking: 'inherited reasoning', timestamp: 0 };
  const provider = {
    id: 'codex',
    getSession: (id) => id === 'child' ? session : null,
    getMessages: (id) => id === 'child' ? messages : [],
    getInheritedContext: (id) => id === 'child' ? { sourceSession: { provider: 'codex', sessionId: 'root' }, messages: [inheritedMessage] } : null
  };
  const document = buildPartsFromProviderMessages(messages);
  const html = renderSessionReaderPane({
    session, provider: 'codex', messages: document.messages, partsByMessage: document.partsByMessage,
    sessionTree: buildMessageSessionTree(session, messages)
  });
  assert.match(html, /Readable answer/);
  assert.match(html, /id="part-tool-1-tool" data-part-id="tool:1:tool"/);
  assert.match(html, /id="part-assistant-1-reasoning" data-part-id="assistant:1:reasoning"/);
  assert.doesNotMatch(html, /output-start|reason-start|input-start|short output/);
  assert.equal((html.match(/data-load-initial/g) || []).length, 4, 'reasoning, tool input, tool output and short output; empty fields make no requests');

  const router = new Router();
  registerSessionDetail(router, {
    appConfig: { port: 0, projectPaths: {}, resumeCommands: {}, allowTerminalLaunch: false },
    providerMap: new Map([['codex', provider]]), providerInfo: []
  });
  const server = createServer((req, res) => {
    void router.dispatch(req, res, new URL(req.url, 'http://localhost')).then((handled) => {
      if (!handled) res.writeHead(404).end();
    }).catch((error) => { res.destroy(error); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const content = async (part, field, offset, scope = 'owned') => {
    const params = new URLSearchParams({ part, field, offset: String(offset), scope });
    const response = await fetch(`${base}/api/codex/session/child/content?${params}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  for (const [part, field, value, format, limit] of [
    ['tool:1:tool', 'input', input, 'plain', 3000],
    ['tool:1:tool', 'output', output, 'auto', 3000],
    ['assistant:1:reasoning', 'reasoning', reasoning, 'markdown', 6000],
    ['short:1:tool', 'output', 'short output', 'auto', 3000],
    ['empty:1:tool', 'output', '', 'auto', 3000]
  ]) {
    let offset = 0;
    let chunks = 0;
    do {
      const page = await content(part, field, offset);
      const expected = renderProgressiveContent(value, format, offset, limit);
      assert.deepEqual(page, { ok: true, ...expected });
      if (field === 'reasoning' && offset === 0) {
        assert.ok(page.html.includes("$` $&amp; $' $$"), 'content endpoint preserves literal replacement tokens');
        assert.doesNotMatch(page.html, /data-reader-pane|id="tab-work"|id="tab-events"/);
        assert.equal((page.html.match(/<div\b/g) || []).length, (page.html.match(/<\/div>/g) || []).length);
      }
      if (page.nextOffset != null) assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
      chunks += 1;
    } while (offset != null);
    assert.equal(chunks > 1, field !== 'output' || part === 'tool:1:tool');
  }
  const inherited = await content('inherited-root-parent-message:reasoning', 'reasoning', 0, 'inherited-context');
  assert.match(inherited.html, /inherited reasoning/);
  assert.equal(inherited.nextOffset, null);

  const search = await fetch(`${base}/api/codex/session/child/search?q=needle`);
  assert.equal(search.status, 200);
  const matches = await search.json();
  assert.equal(matches.total, 2, 'full-source search sees unloaded final reasoning and output');
  assert.deepEqual(matches.matches.map(({ partId, field }) => [partId, field]), [
    ['assistant:1:reasoning', 'reasoning'], ['tool:1:tool', 'output']
  ]);
  assert.ok(matches.matches.every((match) => match.offset > 6000));
});
