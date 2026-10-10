import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ui = fileURLToPath(new URL('../ui/', import.meta.url));
const require = createRequire(new URL('../ui/package.json', import.meta.url));
const { createServer } = require('vite');
const event = (messageId, segment = 'message', sessionId = 'parent') => ({ provider: 'codex', sessionId, messageId, segment });
const relation = (kind, state, correlationId, readerEvent, extra = {}) => ({ type: 'coordination', observation: {
  kind, state, correlationId, readerEvent, eventId: `${correlationId}-${state}`,
  fromSessionRef: null, toSessionRef: null,
  provenance: { fidelity: 'recorded', sourceType: 'fixture', sourceId: state }, ...extra,
} });

test('transcript collaboration names exact returned actors and pairs canonical dispatches', async () => {
  const server = await createServer({ root: ui, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  try {
    const { readerCollaborationIdentity, transcriptHandoffs, layoutTranscriptHandoffs, collaborationEventKey } =
      await server.ssrLoadModule('/src/lib/transcript-collaboration.ts');
    const dispatch = event('spawn', 'tool');
    const returned = event('answer');
    const otherReturn = event('other');
    const entries = [
      relation('spawn', 'requested', 'call-a', dispatch, { fromActorPath: '/root' }),
      relation('spawn', 'started', 'call-a', dispatch, { fromActorPath: '/root', toActorPath: '/root/reviewer' }),
      relation('result', 'completed', 'call-a', returned, { fromActorPath: '/root/reviewer', toActorPath: '/root' }),
      relation('result', 'completed', 'call-b', otherReturn, { fromActorPath: '/root/other', toActorPath: '/root' }),
    ];
    assert.deepEqual(readerCollaborationIdentity(entries, returned), {
      from: '/root/reviewer', to: '/root', fromSession: null, toSession: null,
      fromKey: 'actor\0codex\0parent\0/root/reviewer', toKey: 'actor\0codex\0parent\0/root',
    });
    assert.equal(readerCollaborationIdentity(entries, event('answer', 'message', 'different')), null);
    assert.equal(readerCollaborationIdentity(entries, event('missing')), null);
    const handoffs = transcriptHandoffs(entries, { provider: 'codex', sessionId: 'parent' });
    assert.equal(handoffs.length, 2);
    assert.deepEqual(handoffs[0].dispatch, dispatch);
    assert.deepEqual(handoffs[0].returned, returned);
    assert.equal(handoffs[1].dispatch, null, 'missing dispatch stays missing');
    const points = new Map([[collaborationEventKey(dispatch), 20], [collaborationEventKey(returned), 120], [collaborationEventKey(otherReturn), 160]]);
    const layout = layoutTranscriptHandoffs(handoffs, points);
    const paired = layout.find(item => item.correlationId === 'call-a');
    const returnOnly = layout.find(item => item.correlationId === 'call-b');
    assert.equal(paired.dispatchY, 20);
    assert.equal(paired.returnY, 120);
    assert.notEqual(paired.lane, returnOnly.lane, 'an unloaded earlier dispatch keeps its separate incoming lane');
    assert.equal(returnOnly.dispatchY, null);
    const participant = { id: 'member', kind: 'member', name: 'Recorded reviewer', provenance: entries[0].observation.provenance };
    assert.equal(readerCollaborationIdentity([relation('result', 'completed', 'x', returned, { fromParticipant: participant, fromActorPath: '/root/reviewer' })], returned).from, participant.name);
    assert.equal(readerCollaborationIdentity([relation('result', 'completed', 'x', returned)], returned).from, null);
    const repeated = transcriptHandoffs([...entries, relation('result', 'completed', 'call-a', event('second-answer'), {
      eventId: 'second-return', fromActorPath: '/root/reviewer', toActorPath: '/root',
    })], { provider: 'codex', sessionId: 'parent' });
    assert.equal(repeated.filter(item => item.correlationId === 'call-a').length, 2, 'a follow-up return remains a separate recorded endpoint');
    const { default: Gutter } = await server.ssrLoadModule('/src/lib/TranscriptCollaboration.svelte');
    const { render } = await server.ssrLoadModule('svelte/server');
    assert.doesNotThrow(() => render(Gutter, { props: { entries, provider: 'codex', sessionId: 'parent' } }));
  } finally { await server.close(); }
});

test('unloaded and unrecorded returns reserve independent lanes and retain exact endpoint evidence', async () => {
  const server = await createServer({ root: ui, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  try {
    const { transcriptHandoffs, layoutTranscriptHandoffs, collaborationEventKey, transcriptEndpointGroups } = await server.ssrLoadModule('/src/lib/transcript-collaboration.ts');
    const entries = [
      relation('spawn', 'started', 'a', event('a-dispatch', 'tool'), { toActorPath: '/root/a' }),
      relation('spawn', 'started', 'b', event('b-dispatch', 'tool'), { toActorPath: '/root/b' }),
      relation('spawn', 'started', 'c', event('c-dispatch', 'tool'), { toActorPath: '/root/c' }),
      relation('result', 'completed', 'a', event('a-return'), { fromActorPath: '/root/a' }),
      relation('result', 'completed', 'c', event('c-return'), { fromActorPath: '/root/c' }),
    ];
    const handoffs = transcriptHandoffs(entries, { provider: 'codex', sessionId: 'parent' });
    const points = new Map([['a-dispatch', 10], ['b-dispatch', 20], ['c-dispatch', 40], ['c-return', 90]].map(([id, y]) => [collaborationEventKey(event(id, id.endsWith('dispatch') ? 'tool' : 'message')), y]));
    const layout = layoutTranscriptHandoffs(handoffs, points);
    assert.deepEqual(layout.map(item => item.lane), [0, 1, 2], 'both open spans overlap the later completed handoff');
    assert.equal(layout[0].returnY, null, 'a recorded return outside the loaded page has no invented position');
    assert.equal(layout[1].returned, null, 'an unrecorded return stays missing');
    const groups = transcriptEndpointGroups(layout);
    assert.equal(groups.find(group => group.y === 10).choices[0].event.messageId, 'a-return', 'known unloaded result keeps canonical navigation');
    assert.equal(groups.find(group => group.y === 20).choices[0].event, null, 'pending dispatch has a named marker without an arbitrary jump');
    assert.equal(groups.find(group => group.y === 90).choices[0].event.messageId, 'c-dispatch');
    points.set(collaborationEventKey(event('a-return')), 30);
    const finished = layoutTranscriptHandoffs(handoffs, points);
    assert.deepEqual(finished.map(item => item.lane), [0, 1, 0], 'an exact visible return permits reuse while pending b still owns its lane');
  } finally { await server.close(); }
});

test('recorded canonical agent identity shares stable appearance across dispatch, result, correlations and page order', async () => {
  const server = await createServer({ root: ui, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  try {
    const { transcriptHandoffs, readerCollaborationIdentity, agentAppearance, actorLabel } = await server.ssrLoadModule('/src/lib/transcript-collaboration.ts');
    const child = { provider: 'codex', sessionId: 'child-a' };
    const dispatch = event('a-dispatch', 'tool');
    const returned = event('a-return');
    const entries = [
      relation('spawn', 'requested', 'a', dispatch),
      relation('spawn', 'started', 'a', event('a-started', 'tool'), { toActorPath: '/root/reviewer', toSessionRef: child }),
      relation('result', 'completed', 'a', returned, { fromActorPath: '/root/reviewer' }),
      relation('spawn', 'started', 'followup', event('followup', 'tool'), { toActorPath: '/root/reviewer', toSessionRef: child }),
      relation('spawn', 'started', 'b', event('b-dispatch', 'tool'), { toActorPath: '/root/auditor' }),
      relation('spawn', 'started', 'unknown', event('unknown', 'tool'), { messageExcerpt: 'I am reviewer' }),
      relation('result', 'completed', 'unrelated', event('unrelated-return'), { fromActorPath: '/root/reviewer', fromSessionRef: { provider: 'codex', sessionId: 'different-child' } }),
    ];
    const handoffs = transcriptHandoffs(entries, { provider: 'codex', sessionId: 'parent' });
    const reviewer = handoffs.find(item => item.correlationId === 'a');
    assert.equal(reviewer.agentKey, handoffs.find(item => item.correlationId === 'followup').agentKey);
    assert.equal(readerCollaborationIdentity(entries, dispatch).to, '/root/reviewer', 'exact-correlation started evidence labels the recorded request');
    assert.equal(readerCollaborationIdentity(entries, dispatch).toKey, reviewer.agentKey);
    assert.equal(readerCollaborationIdentity(entries, returned).fromKey, reviewer.agentKey);
    const unrelated = handoffs.find(item => item.correlationId === 'unrelated');
    assert.equal(unrelated.dispatch, null, 'matching display names do not pair unrelated correlations');
    assert.notEqual(unrelated.agentKey, reviewer.agentKey, 'different canonical children retain different identities despite an equal actor label');
    const appearance = agentAppearance(reviewer.agentKey);
    const auditor = agentAppearance(handoffs.find(item => item.correlationId === 'b').agentKey);
    assert.notEqual(appearance.color, auditor.color);
    assert.notEqual(appearance.icon, auditor.icon);
    assert.deepEqual(agentAppearance(transcriptHandoffs([...entries].reverse(), { provider: 'codex', sessionId: 'parent' }).find(item => item.correlationId === 'a').agentKey), appearance);
    assert.equal(handoffs.find(item => item.correlationId === 'unknown').agent, null, 'reply prose never supplies a missing actor');
    assert.equal(actorLabel('/root/reviewer'), 'reviewer');
    assert.equal(actorLabel('Recorded reviewer'), 'Recorded reviewer');
    assert.equal(actorLabel(null), null);
  } finally { await server.close(); }
});

test('overlapping handoffs use separate gutter lanes and reuse lanes after return', async () => {
  const server = await createServer({ root: ui, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  try {
    const { transcriptHandoffs, layoutTranscriptHandoffs, collaborationEventKey, transcriptEndpointGroups } = await server.ssrLoadModule('/src/lib/transcript-collaboration.ts');
    const entries = ['a', 'b', 'c'].flatMap(id => [relation('spawn', 'started', id, event(`${id}-dispatch`, 'tool')), relation('result', 'completed', id, event(`${id}-return`))]);
    const points = new Map([['a-dispatch', 10], ['a-return', 100], ['b-dispatch', 20], ['b-return', 200], ['c-dispatch', 120], ['c-return', 180]].map(([id, y]) => [collaborationEventKey(event(id, id.endsWith('dispatch') ? 'tool' : 'message')), y]));
    const layout = layoutTranscriptHandoffs(transcriptHandoffs(entries, { provider: 'codex', sessionId: 'parent' }), points);
    assert.deepEqual(layout.map(item => item.lane), [0, 1, 0]);
    const shared = transcriptEndpointGroups(layout.map(item => ({ ...item, dispatchY: 10 })));
    assert.equal(shared.find(group => group.y === 10).choices.length, 3);
    assert.deepEqual(shared.find(group => group.y === 10).choices.map(choice => choice.event.messageId), ['a-return', 'b-return', 'c-return']);
    assert.equal(shared.length, 4, 'one dispatch hub retains all three independent return controls');
  } finally { await server.close(); }
});

test('one dispatch shares its lane across repeated returns and reserves unloaded continuation', async () => {
  const server = await createServer({ root: ui, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  try {
    const { transcriptHandoffs, layoutTranscriptHandoffs, collaborationEventKey, transcriptEndpointGroups } = await server.ssrLoadModule('/src/lib/transcript-collaboration.ts');
    const entries = [
      relation('spawn', 'requested', 'review', event('review-dispatch', 'tool')),
      relation('spawn', 'started', 'review', event('review-started', 'tool'), { toActorPath: '/root/reviewer' }),
      ...['first', 'second', 'third'].map(id => relation('result', 'completed', 'review', event(id), { eventId: `return-${id}`, fromActorPath: '/root/reviewer' })),
      relation('spawn', 'started', 'other', event('other-dispatch', 'tool'), { toActorPath: '/root/other' }),
      relation('result', 'completed', 'other', event('other-return'), { fromActorPath: '/root/other' }),
      relation('spawn', 'started', 'later', event('later-dispatch', 'tool')),
      relation('result', 'completed', 'later', event('later-return')),
    ];
    const points = new Map([['review-dispatch', 10], ['first', 50], ['second', 100], ['other-dispatch', 20], ['other-return', 80], ['later-dispatch', 120], ['later-return', 140]].map(([id, y]) => [collaborationEventKey(event(id, id.endsWith('dispatch') ? 'tool' : 'message')), y]));
    const handoffs = transcriptHandoffs(entries, { provider: 'codex', sessionId: 'parent' });
    const layout = layoutTranscriptHandoffs(handoffs, points);
    const repeated = layout.filter(item => item.correlationId === 'review');
    assert.deepEqual(repeated.map(item => item.lane), [0, 0, 0], 'all returns share their recorded dispatch lane');
    assert.equal(layout.find(item => item.correlationId === 'other').lane, 1, 'an independent overlapping dispatch keeps another lane');
    assert.equal(layout.find(item => item.correlationId === 'later').lane, 1, 'unloaded review return reserves its lane beyond visible results');
    const dispatchHub = transcriptEndpointGroups(layout).find(group => group.y === 10);
    assert.deepEqual(dispatchHub.choices.map(choice => choice.event.messageId), ['first', 'second', 'third'], 'every canonical return remains navigable');
    assert.equal(new Set(dispatchHub.choices.map(choice => choice.agentKey)).size, 1);
    points.set(collaborationEventKey(event('third')), 110);
    assert.equal(layoutTranscriptHandoffs(handoffs, points).find(item => item.correlationId === 'later').lane, 0, 'the exact final visible return permits lane reuse');
  } finally { await server.close(); }
});
