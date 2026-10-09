import test from 'node:test';
import assert from 'node:assert/strict';
import { dshTimelineSourceFacts, verifyDshTimeline } from '../scripts/v3-verify-dsh-timeline.mjs';
const source = [
  { type: 'session', version: 3, id: 's', isSeeded: false },
  { type: 'user/message', time: 10, surfaceOp: 'append', data: { id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }] } },
  { type: 'tool/call', time: 11, data: { callId: 'tool' } },
  { type: 'assistant/message', time: 12, surfaceOp: 'append', data: { message: { id: 'a', content: [{ type: 'text', text: 'reply' }] } } },
  { type: 'tool/result', time: 15, surfaceOp: 'append', data: { message: { content: [{ type: 'tool-result', toolCallId: 'tool' }] } } },
];
const encode = rows => Buffer.from(rows.map(JSON.stringify).join('\n'));
const facts = dshTimelineSourceFacts(encode(source));
const rows = [...facts.events].sort((a,b) => a.timestamp - b.timestamp);
test('first recorded tool-call time controls order with exact source membership and endpoints', () => {
  assert.equal(facts.events.length, 3);
  assert.equal(rows.find(row => row.role === 'tool').timestamp, 11);
  assert.equal(rows.at(-1).event.messageId, 'a');
  assert.equal(verifyDshTimeline(facts, rows).ok, true);
});
test('embedded assistant tool-call time wins over its later explicit call and result records', () => {
  const embedded = [
    source[0], source[1],
    { type: 'assistant/message', time: 11, surfaceOp: 'append', data: { message: { id: 'a', content: [
      { type: 'text', text: 'reply' },
      { type: 'tool-call', id: 'embedded', name: 'read', arguments: { path: 'source.txt' } },
    ] } } },
    { type: 'tool/call', time: 12, data: { callId: 'embedded', name: 'read', arguments: { path: 'source.txt' } } },
    { type: 'tool/result', time: 15, surfaceOp: 'append', data: { message: { content: [
      { type: 'tool-result', toolCallId: 'embedded' },
    ] } } },
  ];
  const embeddedFacts = dshTimelineSourceFacts(encode(embedded));
  const tool = embeddedFacts.events.find(row => row.role === 'tool');
  assert.equal(tool.timestamp, 11);
  assert.equal(tool.line, 3);
  assert.equal(embeddedFacts.events.filter(row => row.timestamp === 11).length, 2,
    'the assistant message and embedded call share the recorded timestamp');
  assert.equal(verifyDshTimeline(embeddedFacts,
    [...embeddedFacts.events].sort((a, b) => a.timestamp - b.timestamp)).ok, true);
});
test('assistant/tool omission, duplicate, wrong ref/role/time, and reversed time fail', () => {
  const assistantIndex = rows.findIndex(row => row.role === 'assistant');
  const toolIndex = rows.findIndex(row => row.role === 'tool');
  assert.notEqual(assistantIndex, -1);
  assert.notEqual(toolIndex, -1);
  for (const index of [assistantIndex, toolIndex]) {
    assert.equal(verifyDshTimeline(facts, rows.filter((_, rowIndex) => rowIndex !== index)).ok, false,
      `omitting the ${rows[index].role} event fails`);
  }

  const duplicate = [rows[0], rows[1], rows[1]];
  assert.equal(verifyDshTimeline(facts, duplicate).ok, false, 'a duplicate reference fails');

  const wrongRef = structuredClone(rows);
  wrongRef[assistantIndex].event.messageId = 'different-message';
  assert.equal(verifyDshTimeline(facts, wrongRef).ok, false, 'a wrong message reference fails');

  const wrongOwner = structuredClone(rows);
  wrongOwner[assistantIndex].event.sessionId = 'other-session';
  assert.equal(verifyDshTimeline(facts, wrongOwner).ok, false, 'a wrong canonical session owner fails');

  const wrongRole = structuredClone(rows);
  wrongRole[toolIndex].role = 'assistant';
  assert.equal(verifyDshTimeline(facts, wrongRole).ok, false, 'a wrong role fails');

  const wrongTimestamp = structuredClone(rows);
  wrongTimestamp[assistantIndex].timestamp++;
  assert.equal(verifyDshTimeline(facts, wrongTimestamp).ok, false, 'a wrong source timestamp fails');

  const reversed = structuredClone(rows);
  [reversed[assistantIndex], reversed[assistantIndex - 1]] =
    [reversed[assistantIndex - 1], reversed[assistantIndex]];
  assert.equal(verifyDshTimeline(facts, reversed).ok, false, 'reversed strict timestamp order fails');
});
test('equal-timestamp ties remain unasserted and ambiguous result settlement fails', () => {
  const tied = structuredClone(source); tied[3].time = 10;
  const expected = dshTimelineSourceFacts(encode(tied));
  assert.equal(expected.first, null);
  const ordered = [...expected.events].sort((a,b) => a.timestamp - b.timestamp);
  assert.equal(verifyDshTimeline(expected, [ordered[1], ordered[0], ordered[2]]).ok, true);
  assert.throws(() => dshTimelineSourceFacts(encode([...source, source[4]])), /ambiguous/);
});
