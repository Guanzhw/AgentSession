import assert from 'node:assert/strict';
import test from 'node:test';
import { renderSessionReaderPane, renderReaderProcessChunk } from '../dist/src/views/session.js';
import { buildMessageSessionTree } from '../dist/src/providers/shared/message-session.js';
import { buildPartsFromProviderMessages } from '../dist/src/session-queries.js';

const session = { id: 'root', provider: 'fixture', title: 'Ordinary exchange fixture' };
const lane = { id: 'worker', name: 'Worker', childSession: null, runIds: ['work'] };

function milestone(id, partId, side = 'before', kind = 'message', messageId = 'answer') {
  return { id, laneId: lane.id, kind, eventId: `event-${id}`, sequence: 1, timestamp: 1000, runId: 'work',
    sourceEventRef: { session: { provider: 'fixture', sessionId: 'root' }, eventId: `event-${id}` },
    position: { messageId, partId, side } };
}

function fixture(count = 43) {
  const messages = [{ id: 'answer', sessionId: 'root', role: 'assistant', content: 'Visible answer', timestamp: 1 },
    ...Array.from({ length: count }, (_, index) => ({
      id: `tool-${index}`, sessionId: 'root', role: 'tool', toolName: 'send_message',
      thinking: `Reasoning ${index}`, toolInput: { message: `Complete exchange ${index}` },
      toolOutput: `Recorded reply ${index}`, timestamp: index + 2,
      metadata: index === 8 ? { status: 'error' } : {}
    }))];
  const sessionTree = buildMessageSessionTree(session, messages);
  const readerRelations = { lanes: [lane], unplaced: [], milestones: messages.slice(1).flatMap((message) => [
    milestone(`${message.id}-before`, `${message.id}:tool`),
    milestone(`${message.id}-after`, `${message.id}:tool`, 'after')
  ]) };
  return { session, provider: 'fixture', sessionTree, readerRelations, messages };
}

function chunks(html) {
  return [...html.matchAll(/<div data-reader-process-chunk[^>]*data-reader-message-id="([^"]+)"[^>]*data-reader-first-part-id="([^"]+)"[^>]*data-reader-last-part-id="([^"]+)"[^>]*data-reader-process-count="([^"]+)"/g)]
    .map(([, messageId, firstPartId, lastPartId, count]) => ({ messageId, firstPartId, lastPartId, count: Number(count) }));
}

function processOwners(html, id) {
  const end = html.indexOf(`id="${id}"`);
  assert.ok(end >= 0, `${id} exists`);
  const stack = [];
  for (const match of html.slice(0, end).matchAll(/<details\b[^>]*>|<\/details>/g)) {
    if (match[0] === '</details>') stack.pop();
    else stack.push(match[0]);
  }
  return stack.filter((tag) => /data-reader-execution(?:\s|=)|data-conversation-process(?:\s|=)/.test(tag));
}

const sourceIds = (html) => [...html.matchAll(/\bid="((?:part|milestone)-[^"]+)"/g)].map((match) => match[1]);

test('ordinary exchanges share bounded lazy process chunks with exact anchors and no doubled counts', () => {
  const input = fixture();
  const message = input.sessionTree.messages[0];
  const nextTool = message.parts.findIndex((part) => part.id === 'tool-21:reasoning');
  message.parts.splice(nextTool, 0, { id: 'gap', messageId: message.id, sessionId: 'root', type: 'step-start',
    data: { type: 'step-start' }, childSessions: [] });
  input.readerRelations.milestones.push(milestone('gap-exchange', 'gap'),
    milestone('reasoning-before', 'tool-21:reasoning'), milestone('reasoning-after', 'tool-21:reasoning', 'after'));
  const original = JSON.stringify(input);
  const html = renderSessionReaderPane(input);
  const references = chunks(html);
  assert.deepEqual(references.map((chunk) => chunk.count), [20, 20, 3]);
  assert.equal((html.match(/data-reader-execution-count="43"/g) || []).length, 1);
  assert.equal((html.match(/1 failed or interrupted/g) || []).length, 1);
  assert.doesNotMatch(html, /Complete exchange 0|Recorded reply 0|Reasoning 0/);
  assert.ok(html.indexOf('Visible answer') < html.indexOf('data-reader-execution'));
  for (const item of input.readerRelations.milestones) {
    const owners = processOwners(html, `milestone-${item.id}`);
    assert.equal(owners.length, 1, item.id);
    assert.doesNotMatch(owners[0], /\sopen(?:\s|>)/);
    assert.equal((html.match(new RegExp(`id="milestone-${item.id}"`, 'g')) || []).length, 1);
    assert.ok(html.includes(`readerEvent=event-${item.id}`), 'source identity stays available before loading');
  }
  const loaded = references.map((reference) => renderReaderProcessChunk({ ...input, ...reference }));
  assert.deepEqual(loaded.map((chunk) => chunk.count), [20, 20, 3]);
  const loadedHtml = loaded.map((chunk) => chunk.html).join('');
  assert.deepEqual(sourceIds(loadedHtml), sourceIds(html).filter((id) => id !== 'part-answer-text'));
  assert.equal(new Set(sourceIds(loadedHtml)).size, sourceIds(loadedHtml).length);
  assert.equal((loadedHtml.match(/class="tool-call /g) || []).length, 43);
  assert.equal((loadedHtml.match(/class="reasoning-block"/g) || []).length, 43);
  assert.deepEqual(sourceIds(renderSessionReaderPane({ ...input, deferExecution: false })), sourceIds(html),
    'eager and lazy rendering preserve the same complete source-anchor order');
  assert.equal(JSON.stringify(input), original, 'rendering keeps complete source records unchanged');
});

test('mixed positions and every key collaboration kind remain visible on the reading spine', () => {
  const kinds = ['spawn', 'follow-up', 'result-delivery', 'mailbox-delivery', 'interrupt', 'resume', 'child-turn-completed'];
  const input = fixture(kinds.length);
  input.readerRelations.milestones.push(...kinds.map((kind, index) => milestone(`key-${index}`, `tool-${index}:tool`, 'before', kind)));
  const html = renderSessionReaderPane(input);
  for (const [index] of kinds.entries()) {
    assert.equal(processOwners(html, `milestone-key-${index}`).length, 0);
    assert.equal(processOwners(html, `milestone-tool-${index}-before`).length, 0, 'mixed ordinary marker shares the visible position');
    assert.equal(processOwners(html, `milestone-tool-${index}-after`).length, 1);
  }
  assert.equal(renderReaderProcessChunk({ ...input, messageId: 'answer', firstPartId: 'tool-0:tool', lastPartId: 'tool-1:tool' }), null,
    'a chunk cannot cross a key collaboration boundary');
});

test('message-level ordinary markers fold with commentary while key markers keep their position', () => {
  const messages = [
    { id: 'comment', sessionId: 'root', role: 'assistant', content: 'Progress prose', thinking: 'Progress reasoning', timestamp: 1,
      presentationPhase: 'commentary' },
    { id: 'tool', sessionId: 'root', role: 'tool', toolName: 'exec', toolOutput: 'Progress output', timestamp: 2 },
    { id: 'final', sessionId: 'root', role: 'assistant', content: 'Final prose', thinking: 'Final reasoning', timestamp: 3,
      presentationPhase: 'final' }
  ];
  const readerRelations = { lanes: [lane], unplaced: [], milestones: [
    milestone('message-before', null, 'before', 'message', 'comment'),
    milestone('message-after', null, 'after', 'message', 'comment'),
    milestone('final-delivery', null, 'before', 'result-delivery', 'final')
  ] };
  const sessionTree = buildMessageSessionTree(session, messages);
  const html = renderSessionReaderPane({ session, sessionTree, provider: 'fixture', readerRelations });
  assert.ok(processOwners(html, 'msg-comment').length > 0);
  assert.ok(processOwners(html, 'milestone-message-before').length > 0);
  assert.ok(processOwners(html, 'milestone-message-after').length > 0);
  assert.equal(processOwners(html, 'milestone-final-delivery').length, 0);
  assert.equal(processOwners(html, 'msg-final').length, 0);
  assert.ok(html.indexOf('id="milestone-message-before"') < html.indexOf('Progress prose'));
  assert.ok(html.indexOf('id="milestone-message-after"') < html.indexOf('id="milestone-final-delivery"'));
  assert.ok(html.indexOf('id="part-comment-reasoning"') < html.indexOf('id="msg-final"'));
  assert.ok(html.indexOf('id="part-final-reasoning"') > html.indexOf('id="msg-final"'));
});

test('ordinary markers do not join lazy ranges or reasoning across assistant messages', () => {
  const messages = ['first', 'second'].flatMap((id, index) => [
    { id, sessionId: 'root', role: 'assistant', content: '', thinking: `${id} reasoning`, timestamp: index * 2 + 1 },
    { id: `${id}-tool`, sessionId: 'root', role: 'tool', toolName: 'exec', toolOutput: `${id} output`, timestamp: index * 2 + 2 }
  ]);
  const sessionTree = buildMessageSessionTree(session, messages);
  const readerRelations = { lanes: [lane], unplaced: [], milestones: [
    milestone('first-exchange', 'first-tool:tool', 'before', 'message', 'first'),
    milestone('second-exchange', 'second-tool:tool', 'after', 'message', 'second')
  ] };
  const input = { session, sessionTree, provider: 'fixture', readerRelations };
  const references = chunks(renderSessionReaderPane(input));
  assert.deepEqual(references.map((chunk) => chunk.messageId), ['first', 'second']);
  const first = renderReaderProcessChunk({ ...input, ...references[0] });
  const second = renderReaderProcessChunk({ ...input, ...references[1] });
  assert.match(first.html, /part-first-reasoning/);
  assert.doesNotMatch(first.html, /part-second|milestone-second-exchange/);
  assert.match(second.html, /part-second-reasoning/);
  assert.doesNotMatch(second.html, /part-first|milestone-first-exchange/);
  assert.equal(renderReaderProcessChunk({ ...input, ...references[0], lastPartId: 'second-tool:tool' }), null);
});

test('raw and non-deferred rendering fold ordinary exchanges without hiding key milestones', () => {
  const input = fixture(2);
  input.readerRelations.milestones.push(milestone('delivery', 'tool-1:tool', 'after', 'result-delivery'));
  const raw = buildPartsFromProviderMessages(input.messages);
  for (const html of [
    renderSessionReaderPane({ ...input, deferExecution: false }),
    renderSessionReaderPane({ session, provider: 'fixture', ...raw, readerRelations: input.readerRelations })
  ]) {
    assert.doesNotMatch(html, /data-reader-process-chunk/);
    assert.ok(processOwners(html, 'milestone-tool-0-before').length > 0);
    assert.ok(processOwners(html, 'milestone-tool-0-after').length > 0);
    assert.equal(processOwners(html, 'milestone-delivery').length, 0);
    assert.equal(processOwners(html, 'milestone-tool-1-after').length, 0);
    assert.equal((html.match(/id="part-tool-0-reasoning"/g) || []).length, 1);
    assert.equal((html.match(/id="part-tool-1-reasoning"/g) || []).length, 1);
    assert.ok(html.indexOf('id="part-tool-0-reasoning"') < html.indexOf('id="milestone-tool-0-before"'));
    assert.ok(html.indexOf('id="milestone-tool-0-before"') < html.indexOf('id="part-tool-0-tool"'));
  }
});

test('issued lazy range keeps its original ending when later ordinary exchanges append', () => {
  const input = fixture(2);
  const reference = chunks(renderSessionReaderPane(input))[0];
  const before = renderReaderProcessChunk({ ...input, ...reference });
  const grown = fixture(3);
  const after = renderReaderProcessChunk({ ...grown, ...reference });
  assert.deepEqual(after, before);
  assert.doesNotMatch(after.html, /tool-2/);
});
