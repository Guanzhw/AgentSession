import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ui = fileURLToPath(new URL('../ui/', import.meta.url));
const require = createRequire(new URL('../ui/package.json', import.meta.url));
const { createServer } = require('vite');

test('collaboration graph groups recorded senders and keeps handoff details progressive', async () => {
  const server = await createServer({ root: ui, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  try {
    const { default: Timeline } = await server.ssrLoadModule('/src/lib/CollaborationTimeline.svelte');
    const { render } = await server.ssrLoadModule('svelte/server');
    const session = { provider: 'codex', sessionId: 'canonical-child' };
    const observation = (kind, state, correlationId, extra = {}) => ({ type: 'coordination', observation: {
      kind, state, correlationId, eventId: `${correlationId}-${state}`, fromSessionRef: null, toSessionRef: null,
      provenance: { fidelity: 'recorded', sourceType: 'fixture', sourceId: state }, ...extra,
    } });
    const entries = [
      observation('spawn', 'requested', 'launch-a', { fromActorPath: '/root', launchRequest: { model: 'requested-model', reasoningEffort: 'max', forkTurns: 'none' } }),
      observation('spawn', 'started', 'launch-a', { fromActorPath: '/root', toActorPath: '/root/reviewer', toSessionRef: session }),
      observation('spawn', 'requested', 'launch-b', { fromActorPath: '/root' }),
      observation('spawn', 'failed', 'launch-b'),
      observation('result', 'completed', 'launch-a', { fromActorPath: '/root/reviewer', toActorPath: '/root', readerEvent: { provider: 'codex', sessionId: 'parent', messageId: 'answer-a', segment: 'message' } }),
    ];
    const full = render(Timeline, { props: { entries, complete: true, session: { provider: 'codex', sessionId: 'parent' } } }).body;
    assert.equal((full.match(/data-collaboration-handoff=/g) || []).length, 2);
    assert.doesNotMatch(full, /Requested model|requested-model|Fresh context requested|Requested reasoning/);
    assert.match(full, /Completed/);
    assert.match(full, /Failed/);
    assert.match(full, /Main assistant/);
    assert.equal((full.match(/class="collaboration-parent /g) || []).length, 1, 'one recorded sender connects both children');
    assert.match(full, /aria-expanded="false"/);
    assert.match(full, /viewBox="0 0 5 5"/);
    assert.match(full, /reviewer/);
    assert.doesNotMatch(full, /collaboration-source-details|Jump to return/);
    assert.doesNotMatch(full, /Actual model|Inherited 0|encrypted task/);
    const compact = render(Timeline, { props: { entries, compact: true, complete: false } }).body;
    assert.doesNotMatch(compact, /Source details|launch-a-requested/);
    assert.match(compact, /Partial collaboration history/);
    const many = render(Timeline, { props: { entries: Array.from({ length: 8 }, (_, i) => observation('spawn', 'requested', `launch-${i}`, { toActorPath: `/root/agent-${i}` })), compact: true } }).body;
    assert.equal((many.match(/data-collaboration-handoff=/g) || []).length, 3);
    const nested = render(Timeline, { props: { session: { provider: 'codex', sessionId: 'parent' }, entries: [
      observation('spawn', 'requested', 'nested', { fromActorPath: '/root/reviewer', toActorPath: '/root/reviewer/checker' }),
    ] } }).body;
    assert.match(nested, /title="\/root\/reviewer"/);
    assert.doesNotMatch(nested, /Main assistant/, 'nested delegation keeps its recorded sender instead of introducing a root');
    const unknown = render(Timeline, { props: { entries: [observation('spawn', 'requested', 'missing')] } }).body;
    assert.match(unknown, /Unknown agent/);
    assert.doesNotMatch(unknown, /Main assistant/);
  } finally {
    await server.close();
  }
});
