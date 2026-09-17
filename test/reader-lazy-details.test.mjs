import assert from 'node:assert/strict';
import test from 'node:test';
import { registerSessionDetail } from '../dist/src/routes/session-detail.js';
import { renderSessionMetricsPanel } from '../dist/src/views/session.js';

function fixture(messages) {
  const metrics = { totals: { messages: 3, steps: 1, toolCalls: 2, branches: 0,
    runtimeMs: 1234, cost: 0.25, directInputTokens: 7, directOutputTokens: 5,
    directReasoningTokens: 2, directCacheReadTokens: 11, directCacheWriteTokens: 0,
    directTotalTokens: 25, totalTokens: 25 }, tools: [{ name: 'run', count: 2 }] };
  const adapter = { id: 'fixture', name: 'Fixture', icon: '', capabilities: {},
    getSession(id) { return ['root', 'child'].includes(id) ? { id, parentId: id === 'child' ? 'root' : null, title: id } : null; },
    getMessages() { return messages.map(m => ({ sessionId: 'child', timestamp: 1, ...m })); },
    getSessionMetrics() { return metrics; }
  };
  const routes = [];
  registerSessionDetail({ get(pattern, handler) { routes.push({ pattern, handler }); } }, {
    appConfig: { port: 0, metaDir: '.', projectPaths: {}, resumeCommands: {} },
    providerMap: new Map([['fixture', adapter]]), providerInfo: []
  });
  return { metrics, async request(path) {
    const route = routes.find(r => r.pattern instanceof RegExp && r.pattern.test(path));
    assert.ok(route);
    const response = { status: 0, body: '', writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    await route.handler({ url: path }, response, path.match(route.pattern));
    assert.equal(response.status, 200);
    return JSON.parse(response.body);
  } };
}

test('lazy child preview retains latest owned assistant fallback and excludes user/tool text', async () => {
  const { request } = fixture([
    { id: 'old', role: 'assistant', content: 'Old reply' },
    { id: 'new', role: 'assistant', content: 'Latest reply' },
    { id: 'user', role: 'user', content: 'New instruction' },
    { id: 'tool', role: 'tool', toolName: 'run', content: 'Tool output' }
  ]);
  const data = await request('/api/fixture/session/root/reader/child/child');
  assert.deepEqual(data.preview, { partId: 'new:text', text: 'Latest reply', final: false });
  assert.equal(data.metrics.totals.directTotalTokens, 25);
});

test('lazy child preview prefers latest recorded final over newer commentary', async () => {
  const { request } = fixture([
    { id: 'first', role: 'assistant', content: 'First final', presentationPhase: 'final' },
    { id: 'last', role: 'assistant', content: 'Last final', presentationPhase: 'final' },
    { id: 'progress', role: 'assistant', content: 'New progress', presentationPhase: 'commentary' }
  ]);
  assert.deepEqual((await request('/api/fixture/session/root/reader/child/child')).preview,
    { partId: 'last:text', text: 'Last final', final: true });
});

test('lazy metrics uses the same localized complete renderer as the initial page', async () => {
  const { request, metrics } = fixture([]);
  const data = await request('/api/fixture/session/root/reader/work-metrics');
  assert.deepEqual(data.metrics, metrics);
  assert.equal(data.html, renderSessionMetricsPanel(metrics));
  assert.match(data.html, /\$0\.2500/);
  assert.doesNotMatch(data.html, /NaN/);
});
