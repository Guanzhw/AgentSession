import test from 'node:test';
import assert from 'node:assert/strict';
import { requestUsageExpectation, verifyRequestUsage, verifyUsageCaptureAgainstSourceBytes } from '../scripts/v3-verify-request-usage.mjs';
const rows = [ { type: 'session_meta', payload: { id: 's' } }, { type: 'token_usage_record', payload: { session_id: 's', thread_id: 's', turn_id: 't', response_id: 'r', usage: { input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 1, total_tokens: 15 }, turn_token_usage: { total_tokens: 150 } } } ];
const encode = value => Buffer.from(value.map(JSON.stringify).join('\n'));
const expected = requestUsageExpectation('codex', encode(rows), 2);
const projection = { sessionRef: expected.sessionRef, turnId: 't', scope: 'request', tokens: expected.tokens, provenance: { sourceId: 'r' } };
test('canonical request uses exclusive components and retains separate cumulative snapshot', () => {
  assert.deepEqual(expected.tokens, { input: 5, cacheRead: 3, cacheWrite: 2, output: 4, reasoning: 1, total: 15 });
  assert.equal(expected.snapshots.turnCumulative.total_tokens, 150);
  assert.equal(verifyRequestUsage(expected, [projection]).ok, true);
});
test('wrong owner, duplicate request, cumulative substitution and cache change fail', () => {
  for (const altered of [ { ...projection, sessionRef: { provider: 'codex', sessionId: 'other' } }, { ...projection, scope: 'session' }, { ...projection, tokens: { ...projection.tokens, total: 150 } }, { ...projection, tokens: { ...projection.tokens, cacheRead: 4 } } ]) assert.equal(verifyRequestUsage(expected, [altered]).ok, false);
  assert.equal(verifyRequestUsage(expected, [projection, projection]).ok, false);
  assert.throws(() => requestUsageExpectation('codex', encode([...rows, rows[1]]), 2), /unique/);
});
test('DSH missing cache write remains missing and ambiguous settlement slot fails', () => {
  const dsh = [{ type: 'session', id: 's', version: 3, isSeeded: false }, { type: 'assistant/message', seq: 2, surfaceOp: 'append', data: { turn: 1, step: 1, usage: { inputTokens: 3, outputTokens: 4, reasoningTokens: 2, cacheReadTokens: 5, totalTokens: 12 } } }];
  const fact = requestUsageExpectation('deepseek-harness', encode(dsh), 2);
  assert.deepEqual(fact.missing, ['cacheWrite']);
  assert.equal(Object.hasOwn(fact.tokens, 'cacheWrite'), false);
  assert.throws(() => requestUsageExpectation('deepseek-harness', encode([...dsh, dsh[1]]), 2), /ambiguous/);
  dsh[0].isSeeded = true;
  assert.throws(() => requestUsageExpectation('deepseek-harness', encode(dsh), 2), /Unseeded/);
});
test('private usage capture expectation must match the raw source', () => {
  const capture = { captures: [{ provider: 'codex', expected, projected: [projection] }] };
  assert.equal(verifyUsageCaptureAgainstSourceBytes(capture, new Map([['codex', encode(rows)]]))[0].recordedComponents, 6);
  const forged = structuredClone(capture);
  forged.captures[0].expected.tokens.cacheRead = 99;
  assert.throws(() => verifyUsageCaptureAgainstSourceBytes(forged, new Map([['codex', encode(rows)]])), /raw source/);
});
