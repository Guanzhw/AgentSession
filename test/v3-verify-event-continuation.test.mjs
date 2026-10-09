import test from 'node:test';
import assert from 'node:assert/strict';
import { eventSourceExpectation, verifyEventContinuation, verifyCaptureAgainstSourceBytes } from '../scripts/v3-verify-event-continuation.mjs';

const bytes = Buffer.from(JSON.stringify({ type: 'session_meta', payload: { id: 'session' } }) + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', id: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first尾段' }] } }));
const expected = eventSourceExpectation('codex', bytes, 2);
const locator = { sourceSha256: expected.sourceSha256, line: expected.line, path: expected.path, recordSha256: expected.recordSha256 };
const requests = [0, 5].map(offset => ({ event: expected.event, offset, maxChars: 5 }));
const good = ['first', '尾段'].map((text, index) => ({ request: requests[index], result: { event: expected.event, role: 'assistant', content: { text, offset: index * 5, totalChars: 7, nextOffset: index ? null : 5, truncated: !index }, continuation: index ? null : requests[1] } }));

test('complete ordered source-mapped continuation passes', () => assert.equal(verifyEventContinuation(expected, good, locator).ok, true));
test('wrong owner and source line fail independently of body equality', () => {
  const wrong = structuredClone(good); wrong[0].result.event.sessionId = 'other';
  assert.equal(verifyEventContinuation(expected, wrong, locator).ok, false);
  assert.equal(verifyEventContinuation(expected, good, { ...locator, line: 1 }).ok, false);
});
test('omitted repeated and same-length changed tail fail', () => {
  assert.equal(verifyEventContinuation(expected, good.slice(0, 1), locator).ok, false);
  assert.equal(verifyEventContinuation(expected, [...good, good[1]], locator).ok, false);
  const wrong = structuredClone(good); wrong[1].result.content.text = '改字';
  assert.equal(verifyEventContinuation(expected, wrong, locator).ok, false);
});
test('multiple text blocks cannot masquerade as an exact one-string mapping', () => {
  assert.throws(() => eventSourceExpectation('codex', Buffer.from(bytes.toString().replace('"text":"first尾段"', '"text":"first尾段"},{"type":"output_text","text":"extra"')), 2), /single-string/);
});

test('DSH maps only the recorded appended text block and preserves its canonical ID', () => {
  const source = Buffer.from([
    { type: 'session', version: 3, id: 'dsh-session' },
    { type: 'assistant/message', seq: 7, surfaceOp: 'append', data: { message: { id: 'dsh-message', role: 'assistant', content: [{ type: 'reasoning', text: 'private thought' }, { type: 'text', text: 'reply' }] } } },
  ].map(JSON.stringify).join('\n'));
  const result = eventSourceExpectation('deepseek-harness', source, 2);
  assert.equal(result.path, '/data/message/content/1/text');
  assert.equal(result.fact.codeUnits, 5);
  assert.deepEqual(result.event, { provider: 'deepseek-harness', sessionId: 'dsh-session', messageId: 'dsh-message', segment: 'message' });
  assert.throws(() => eventSourceExpectation('deepseek-harness', Buffer.from(source.toString().replace('"append"', '"replace"')), 2), /appended/);
});

test('private capture expectations must independently match the raw source', () => {
  const capture = { output: [{ provider: 'codex', expected, locator, pages: good }] };
  assert.equal(verifyCaptureAgainstSourceBytes(capture, new Map([['codex', bytes]]))[0].codeUnits, 7);
  const forged = structuredClone(capture);
  forged.output[0].expected.fact.sha256 = '0'.repeat(64);
  assert.throws(() => verifyCaptureAgainstSourceBytes(forged, new Map([['codex', bytes]])), /raw source/);
});
