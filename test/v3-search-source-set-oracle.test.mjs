import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyCodexSearchSources } from '../scripts/v3-search-source-set-oracle.mjs';
import { scanCodexFile } from '../scripts/v3-verify-search-golden.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const row = (type, payload, timestamp) => ({ type, payload, timestamp });
const bytes = rows => Buffer.from(rows.map(value => JSON.stringify(value) + '\n').join(''));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const firstRows = [
  row('session_meta', { id, cwd: '/work' }, '2026-09-27T00:00:00Z'),
  row('response_item', { type: 'message', role: 'assistant', id: 'answer-1',
    content: [{ type: 'output_text', text: 'earlier answer needle' }] }, '2026-09-27T00:00:01Z'),
  row('event_msg', { type: 'task_started' }, '2026-09-27T00:00:02Z'),
  row('event_msg', { type: 'turn_aborted' }, '2026-09-27T00:00:03Z')
];
const prefix = bytes(firstRows.slice(0, 2));
const first = bytes(firstRows);
const laterRows = [
  row('session_meta', { id, cwd: '/work', history_base: {
    thread_id: id, end_byte_offset: prefix.length, end_ordinal_exclusive: 2
  } }, '2026-09-27T00:00:04Z'),
  row('response_item', { type: 'message', role: 'assistant', id: 'answer-2',
    content: [{ type: 'output_text', text: 'later answer needle' }] }, '2026-09-27T00:00:05Z')
];
const later = bytes(laterRows);
const candidates = (a = first, b = later) => [
  { path: 'first.jsonl', bytes: a }, { path: 'later.jsonl', bytes: b }
];

test('independent source-set oracle selects only the declared direct prefix', async () => {
  const selected = classifyCodexSearchSources(candidates());
  assert.equal(selected.status, 'direct-pair');
  assert.equal(selected.sessionId, id);
  assert.equal(selected.excludedRecords, 2);
  assert.equal(selected.prefixRecords, 2);
  assert.deepEqual(selected.sourceSha256, [sha256(first), sha256(later)]);
  assert.deepEqual(selected.activeBytes, Buffer.concat([prefix, later]));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-search-source-set-'));
  try {
    const derived = path.join(directory, 'derived.jsonl');
    await writeFile(derived, selected.activeBytes);
    const facts = await scanCodexFile(derived, [
      { label: 'early', query: 'earlier answer', fields: ['assistant'] },
      { label: 'later', query: 'later answer', fields: ['assistant'] },
      { label: 'aborted', query: 'turn_aborted', fields: ['assistant'] }
    ]);
    assert.equal(facts.projection.matches.early.event.messageId, 'answer-1');
    assert.equal(facts.projection.matches.later.event.messageId, 'answer-2');
    assert.equal(facts.projection.matches.aborted, null);
  } finally { await rm(directory, { recursive: true }); }
});

test('unanchored, inherited, and usage-bearing pairs remain unresolved', () => {
  const noAnchor = bytes([{ ...laterRows[0], payload: { id, cwd: '/work' } }, laterRows[1]]);
  const inherited = bytes([{ ...laterRows[0], payload: {
    ...laterRows[0].payload, forked_from_id: 'parent'
  } }, laterRows[1]]);
  const emptyParent = bytes([{ ...laterRows[0], payload: {
    ...laterRows[0].payload, parent_thread_id: ''
  } }, laterRows[1]]);
  const withUsage = bytes([...firstRows.slice(0, 2), row('token_usage_record', {
    total_tokens: 1
  }, '2026-09-27T00:00:02Z'), firstRows.at(-1)]);
  for (const [a, b] of [[first, noAnchor], [first, inherited], [first, emptyParent], [withUsage, later]]) {
    const result = classifyCodexSearchSources(candidates(a, b));
    assert.equal(result.status, 'unresolved');
    assert.equal(result.directory, '/work');
    assert.equal(Object.hasOwn(result, 'activeBytes'), false);
  }
});

test('unsupported source identity fails instead of choosing a filename', () => {
  const wrong = bytes([{ ...laterRows[0], payload: { ...laterRows[0].payload, id: 'other' } }]);
  assert.throws(() => classifyCodexSearchSources(candidates(first, wrong)), /MixedCanonicalSourceIds/);
  assert.throws(() => classifyCodexSearchSources([{ path: 'only.jsonl', bytes: Buffer.from('broken') }]),
    /UnreadableCanonicalSource/);
});
