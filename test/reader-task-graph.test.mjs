import assert from 'node:assert/strict';
import test from 'node:test';
import { renderReaderTaskGraph as renderGraph } from '../dist/src/views/reader-task-graph.js';
import { groupConversationCards } from '../dist/src/conversation-view-model.js';
import { setLocale } from '../dist/src/i18n.js';

const renderReaderTaskGraph = (cards, provider, sessionId, selectedKey) =>
  renderGraph(groupConversationCards(cards, provider, sessionId), provider, sessionId, selectedKey);

function card(index, overrides = {}) {
  return {
    id: `run:${index}`, name: `/root/worker_${index}`, responsibility: `Task ${index}`,
    state: 'completed', childSession: { provider: 'fixture', sessionId: `child-${index}` },
    bindings: { taskId: `task-${index}` },
    channel: [
      { id: `dispatch-${index}`, kind: 'spawn', senderActorId: 'coordinator', senderName: 'Coordinator', recipientActorId: `worker-${index}`, recipientName: `Worker ${index}` },
      { id: `return-${index}`, kind: 'result-delivery', senderActorId: `worker-${index}`, senderName: `Worker ${index}`, recipientActorId: 'coordinator', recipientName: 'Coordinator' }
    ], ...overrides
  };
}

test('task graph shows recorded direction and readable task names without loading any body', () => {
  setLocale('en');
  const html = renderReaderTaskGraph([card(1), card(2)], 'fixture', 'root', 'run:2');
  assert.equal((html.match(/data-reader-graph-origin=/g) || []).length, 1);
  assert.equal((html.match(/class="reader-task-graph-assignment"/g) || []).length, 2);
  assert.equal((html.match(/class="reader-task-graph-return"/g) || []).length, 2);
  assert.match(html, /<strong>Task 2<\/strong>/);
  assert.match(html, /data-reader-task-select="run:2"[^>]*aria-pressed="true"/);
  assert.doesNotMatch(html, /\/root\/worker_|data-reader-coordination-content-url/);
});

test('graph keeps each visual group small and opens the selected task group', () => {
  const html = renderReaderTaskGraph(Array.from({ length: 9 }, (_, index) => card(index)), 'fixture', 'root', 'run:5');
  const pages = [...html.matchAll(/data-reader-task-graph-page="(\d+)"[^>]*>/g)];
  assert.equal(pages.length, 3);
  assert.ok(pages[0][0].includes('hidden'));
  assert.ok(!pages[1][0].includes('hidden'));
  assert.ok(pages[2][0].includes('hidden'));
  assert.match(html, /data-reader-graph-page-label>2 \/ 3/);
  assert.equal((html.match(/class="reader-task-graph-node"/g) || []).length, 9);
});

test('repeated runs of the same child keep one graph node and retain both edge directions', () => {
  const assigned = card(1, { channel: [card(1).channel[0]] });
  const returned = card(2, { childSession: assigned.childSession, channel: [card(1).channel[1]] });
  const html = renderReaderTaskGraph([assigned, returned], 'fixture', 'root');
  assert.equal((html.match(/class="reader-task-graph-node"/g) || []).length, 1);
  assert.match(html, /reader-task-graph-assignment"/);
  assert.match(html, /reader-task-graph-return"/);
});

test('ordinary delivered team messages are not labeled as returned task results', () => {
  const message = { kind: 'mailbox-delivery', senderName: 'Worker 1', recipientName: 'Coordinator' };
  const html = renderReaderTaskGraph([card(1, { channel: [card(1).channel[0], message] })], 'fixture', 'root');
  assert.match(html, /class="reader-task-graph-assignment"/);
  assert.doesNotMatch(html, /class="reader-task-graph-return"/);
  assert.equal(renderReaderTaskGraph([card(1, { channel: [message] })], 'fixture', 'root'), '');
});

test('multiple runs of the same recorded task without a child share one selectable graph node', () => {
  const assigned = card(1, { childSession: null, channel: [card(1).channel[0]] });
  const returned = card(2, { childSession: null, bindings: assigned.bindings, channel: [card(1).channel[1]] });
  const html = renderReaderTaskGraph([assigned, returned], 'fixture', 'root');
  assert.equal((html.match(/class="reader-task-graph-node"/g) || []).length, 1);
  assert.match(html, /data-reader-task-select="run:1"/);
});

test('graph preserves distinct recorded coordinators when results go to another actor with the same name', () => {
  const task = card(1);
  task.channel[1].recipientActorId = 'review-coordinator';
  const html = renderReaderTaskGraph([task], 'fixture', 'root');
  assert.equal((html.match(/data-reader-graph-origin=/g) || []).length, 2);
  assert.match(html, /data-reader-graph-origin="coordinator"/);
  assert.match(html, /data-reader-graph-origin="review-coordinator"/);
  assert.match(html, /class="reader-task-graph-assignment"/);
  assert.match(html, /class="reader-task-graph-return"/);
});

test('later runs retain all recorded origins and paginate relationships without duplicating task nodes within a window', () => {
  const cards = Array.from({ length: 9 }, (_, index) => {
    const run = card(index, { childSession: { provider: 'fixture', sessionId: 'shared-child' } });
    run.channel[0].senderActorId = `coordinator-${index}`;
    run.channel[1].recipientActorId = `coordinator-${index}`;
    return run;
  });
  const html = renderReaderTaskGraph(cards, 'fixture', 'root');
  assert.equal((html.match(/data-reader-graph-origin=/g) || []).length, 9);
  assert.equal((html.match(/class="reader-task-graph-node"/g) || []).length, 3);
  assert.match(html, /data-reader-graph-origin="coordinator-8"/);
  assert.equal((html.match(/data-reader-task-graph-page=/g) || []).length, 3);
});

test('graph does not invent a result or merge unknown actors, and escapes provider labels', () => {
  setLocale('zh');
  assert.equal(renderReaderTaskGraph([card(1, { channel: [] })], 'fixture', 'root'), '');
  const unknown = (index) => card(index, {
    responsibility: '<script>unsafe</script>',
    channel: [{ id: `unknown-${index}`, kind: 'spawn', senderName: null, recipientName: null }]
  });
  const html = renderReaderTaskGraph([unknown(1), unknown(2)], 'fixture', 'root');
  assert.equal((html.match(/data-reader-graph-origin=/g) || []).length, 2);
  assert.doesNotMatch(html, /class="reader-task-graph-return"|<script>/);
  assert.match(html, /任务如何协作/);
  assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  setLocale('en');
});
