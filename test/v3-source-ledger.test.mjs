import test from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync } from 'node:zlib';
import { decodeSourceBytes, sourceLedger, verifyBodyContinuation } from '../scripts/v3-source-ledger.mjs';

const encode = rows => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');

test('source ledger reads every independent DSH Zstd frame and retains recorded ownership', () => {
  const frames = [encode([{ type: 'session', version: 3 }]), encode([{ type: 'assistant/message', seq: 1,
    data: { turn: 2, step: 3, message: { content: '完整正文' }, usage: { input_tokens: 7 } } }])];
  const ledger = sourceLedger('deepseek-harness', Buffer.concat(frames.map(frame => zstdCompressSync(frame))));
  assert.equal(ledger.frames, 2);
  assert.equal(ledger.records.length, 2);
  assert.deepEqual(ledger.records[1].ownership, { turn: 2, step: 3 });
  assert.deepEqual(ledger.records[1].usage, { usage: { input_tokens: 7 } });
  assert.equal(verifyBodyContinuation(ledger.records[1].body[0], ['完整', '正文']), true);
});

test('continuation rejects lost, repeated, reordered and changed final text including Unicode', () => {
  const ledger = sourceLedger('codex', encode([{ type: 'response_item', payload: {
    type: 'message', id: 'private-id', content: [{ text: '开始🙂结尾' }] } }]));
  const fact = ledger.records[0].body[0];
  assert.equal(verifyBodyContinuation(fact, ['开始', '🙂', '结尾']), true);
  for (const chunks of [['开始', '🙂'], ['开始', '🙂', '🙂', '结尾'], ['结尾', '🙂', '开始'], ['开始🙂结尾!']]) {
    assert.equal(verifyBodyContinuation(fact, chunks), false);
  }
  assert.equal(JSON.stringify(ledger).includes('private-id'), false);
  assert.equal(JSON.stringify(ledger).includes('开始'), false);
});

test('raw usage snapshots stay distinct from request increments and ownership is not inferred', () => {
  const ledger = sourceLedger('codex', encode([
    { type: 'token_usage_record', payload: { response_id: 'r', turn_id: 't', usage: { input_tokens: 4 }, turn_token_usage: { input_tokens: 10 } } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 4 }, total_token_usage: { input_tokens: 10 } } } },
  ]));
  assert.equal(ledger.records.length, 2);
  assert.deepEqual(ledger.records[1].ownership, {});
  assert.deepEqual(ledger.records[0].usage.usage, { input_tokens: 4 });
  assert.deepEqual(ledger.records[1].usage.total_token_usage, { input_tokens: 10 });
});

test('source decoder fails visibly for malformed JSON and truncated trailing Zstd frame', () => {
  assert.throws(() => decodeSourceBytes(Buffer.from('{broken}\n')), /line 1/);
  const frame = zstdCompressSync(encode([{ type: 'session' }]));
  assert.throws(() => decodeSourceBytes(Buffer.concat([frame, frame.subarray(0, 8)])));
});
