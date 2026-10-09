import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCohort } from '../scripts/v3-codex-usage-cohort.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const row = (type, payload) => JSON.stringify({ type, payload }) + '\n';
const canonical = (id, usage, total, owner = {}) => row('token_usage_record',
  { response_id: id, usage, thread_token_usage: total, ...owner });
const legacy = (usage, total) => row('event_msg',
  { type: 'token_count', info: { last_token_usage: usage, total_token_usage: total } });
const task = row('response_item', { type: 'agent_message', content: [{ type: 'text',
  text: 'Message Type: NEW_TASK\nSECRET_TRANSCRIPT_BODY' }] });

async function fixture(t, definitions) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-cohort-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [];
  const censusFiles = [];
  for (const [index, entry] of definitions.entries()) {
    const bytes = Buffer.from(entry.body);
    const name = `${index}.jsonl`;
    await writeFile(path.join(root, name), bytes);
    files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
    censusFiles.push({ index, sha256: hash(bytes), bytes: bytes.length,
      counts: { canonical: entry.canonical ?? 0, legacy: entry.legacy ?? 0,
        pairedLegacy: entry.paired ?? 0 },
      fields: entry.fields ?? {},
      child: { parentHash: entry.child ? hash('parent') : null,
        firstNewTaskLine: entry.boundary ?? null },
      sessionMetaHashes: entry.transitions ? [hash('a'), hash('b')] : [hash('a')] });
  }
  const manifest = path.join(root, 'manifest.json');
  const census = path.join(root, 'census.json');
  const checkpoint = path.join(root, 'cohort.json');
  const manifestBytes = Buffer.from(JSON.stringify({ root, files }));
  await writeFile(manifest, manifestBytes);
  await writeFile(census, JSON.stringify({ format: 'agentsession-v3-codex-usage-checkpoint/v2',
    manifestSha256: hash(manifestBytes), files: censusFiles }));
  return { root, manifest, census, checkpoint, files };
}

test('bounded selection covers roots, children, excess pairs, missing/zero, unknown boundary, and transitions', async t => {
  const empty = row('session_meta', { id: 'a' }) + legacy({ total_tokens: 1 }, { total_tokens: 1 });
  const definitions = [
    { body: empty, legacy: 1 },
    { body: row('session_meta', { id: 'child', parent_thread_id: 'parent' }) + task
      + legacy({ total_tokens: 1 }, { total_tokens: 1 }), legacy: 1, child: true, boundary: 2 },
    { body: empty + canonical('x', { total_tokens: 1 }, { total_tokens: 1 }), canonical: 1, legacy: 1 },
    { body: row('session_meta', { id: 'child', parent_thread_id: 'parent' }) + task
      + legacy({ total_tokens: 1 }, { total_tokens: 1 })
      + canonical('x', { total_tokens: 1 }, { total_tokens: 1 }),
      canonical: 1, legacy: 1, child: true, boundary: 2 },
    { body: empty + canonical('x', { total_tokens: 1 }, { total_tokens: 1 }), canonical: 1, legacy: 2, paired: 2 },
    { body: empty + canonical('x', { input_tokens: 0 }, {}), canonical: 1, legacy: 1,
      fields: { canonical: { total_tokens: { missing: 1 }, input_tokens: { zero: 1 } } } },
    { body: empty + canonical('x', { total_tokens: 1 }, {}, { thread_id: 'child', session_id: 'parent' }), canonical: 1, legacy: 1, child: true },
    { body: empty + row('session_meta', { id: 'b' }), legacy: 1, transitions: true },
  ];
  const f = await fixture(t, definitions);
  const result = await runCohort(f.manifest, f.census, f.checkpoint, { perCategory: 1, chunkBytes: 3 });
  assert.deepEqual(result.selection.map(x => x.index), definitions.map((_, index) => index));
  assert.equal(result.files.length, 8);
  assert.deepEqual(result.progress, { scannedFiles: 8, reusedFiles: 0 });
  const resumed = await runCohort(f.manifest, f.census, f.checkpoint, { perCategory: 1, chunkBytes: 5 });
  assert.deepEqual(resumed.progress, { scannedFiles: 0, reusedFiles: 8 });
  assert.equal(JSON.stringify(result).includes('SECRET_TRANSCRIPT_BODY'), false);
});

test('raw rows retain byte offsets and distinguish missing, zero, child IDs, and unknown boundary', async t => {
  const usage = { input_tokens: 0, total_tokens: 5 };
  const body = row('session_meta', { id: 'child', parent_thread_id: 'parent' })
    + canonical('r', usage, { total_tokens: 5 }, { thread_id: 'child', session_id: 'parent' })
    + task + legacy(usage, { total_tokens: 5 });
  const f = await fixture(t, [{ body, canonical: 1, legacy: 1, child: true, boundary: 3,
    fields: { canonical: { input_tokens: { zero: 1 } } } }]);
  const result = await runCohort(f.manifest, f.census, f.checkpoint, { chunkBytes: 2 });
  const file = result.files[0];
  assert.equal(file.rows[0].offset, Buffer.byteLength(row('session_meta', { id: 'child', parent_thread_id: 'parent' })));
  assert.equal(file.rows[0].byteLength, Buffer.byteLength(canonical('r', usage,
    { total_tokens: 5 }, { thread_id: 'child', session_id: 'parent' })) - 1);
  assert.equal(file.rows[0].request.input_tokens.value, 0);
  assert.equal(file.rows[0].request.output_tokens.state, 'missing');
  assert.equal(file.rows[0].boundary, 'before-task');
  assert.equal(file.rows[0].owner.threadIdHash, hash('child'));
  assert.equal(file.rows[0].owner.sessionIdHash, hash('parent'));
  assert.equal(file.rows[1].boundary, 'after-task');
  assert.equal(file.markers.some(marker => marker.kind === 'new-task'), true);
  assert.equal(file.candidates[0].outcome, 'unresolved');
});

test('multiple identical legacies and cumulative divergence stay unresolved without one-to-one pairing', async t => {
  const u = { total_tokens: 7 };
  const total = { total_tokens: 70 };
  const body = row('session_meta', { id: 'root' })
    + canonical('r', u, total, { thread_id: 'root' })
    + legacy(u, total) + legacy(u, total)
    + legacy(u, { total_tokens: 71 });
  const f = await fixture(t, [{ body, canonical: 1, legacy: 3, paired: 2 }]);
  const file = (await runCohort(f.manifest, f.census, f.checkpoint)).files[0];
  assert.deepEqual(file.candidates.slice(1).map(row => row.reason),
    ['duplicate-pair-excess', 'duplicate-pair-excess', 'cumulative-divergence']);
  assert.ok(file.candidates.every(row => row.outcome !== 'owned'));
});

test('earlier legacy and metadata transition remain visible, with explicit unresolved reasons', async t => {
  const u = { total_tokens: 2 };
  const body = row('session_meta', { id: 'first' }) + legacy(u, { total_tokens: 2 })
    + row('session_meta', { id: 'second' })
    + canonical('r', u, { total_tokens: 2 }, { thread_id: 'second' });
  const f = await fixture(t, [{ body, canonical: 1, legacy: 1, transitions: true }]);
  const file = (await runCohort(f.manifest, f.census, f.checkpoint)).files[0];
  assert.equal(file.candidates[0].reason, 'earlier-legacy');
  assert.equal(file.markers.filter(marker => marker.kind === 'session-meta').length, 2);
  assert.equal(file.candidates[1].reason, 'metadata-transition');
});

test('lifecycle markers and repeated response IDs preserve uncertainty without bodies', async t => {
  const u = { total_tokens: 2 };
  const body = row('session_meta', { id: 'root' })
    + row('turn_context', { turn_id: 'turn', model: 'model', instructions: 'SECRET_TRANSCRIPT_BODY' })
    + row('event_msg', { type: 'task_started', turn_id: 'turn', text: 'SECRET_TRANSCRIPT_BODY' })
    + canonical('r', u, { total_tokens: 2 }, { thread_id: 'root' })
    + canonical('r', { total_tokens: 3 }, { total_tokens: 5 }, { thread_id: 'root' })
    + row('event_msg', { type: 'task_complete', turn_id: 'turn' });
  const f = await fixture(t, [{ body, canonical: 2, legacy: 0,
    fields: { canonical: { input_tokens: { missing: 2 } } } }]);
  const file = (await runCohort(f.manifest, f.census, f.checkpoint)).files[0];
  assert.deepEqual(file.candidates.map(candidate => candidate.reason),
    ['repeated-response-id', 'repeated-response-id']);
  assert.deepEqual(file.markers.map(marker => marker.kind),
    ['session-meta', 'turn-context', 'task_started', 'task_complete']);
  assert.equal(JSON.stringify(file).includes('SECRET_TRANSCRIPT_BODY'), false);
});

test('resume detects a changed source and does not expose transcript bodies', async t => {
  const body = row('session_meta', { id: 'root' })
    + row('response_item', { type: 'agent_message', content: [{ text: 'SECRET_TRANSCRIPT_BODY' }] })
    + legacy({ total_tokens: 1 }, { total_tokens: 1 });
  const f = await fixture(t, [{ body, legacy: 1 }]);
  const result = await runCohort(f.manifest, f.census, f.checkpoint, { chunkBytes: 1 });
  assert.equal(JSON.stringify(result).includes('SECRET_TRANSCRIPT_BODY'), false);
  assert.equal((await readFile(f.checkpoint, 'utf8')).includes('SECRET_TRANSCRIPT_BODY'), false);
  await writeFile(path.join(f.root, '0.jsonl'), body + ' ');
  await assert.rejects(runCohort(f.manifest, f.census, f.checkpoint), /Source hash mismatch/);
});

test('a later malformed file leaves the earlier completed file resumable', async t => {
  const good = row('session_meta', { id: 'root' })
    + legacy({ total_tokens: 1 }, { total_tokens: 1 });
  const bad = good + '{not-json}\n';
  const f = await fixture(t, [{ body: good, legacy: 1 }, { body: bad, legacy: 1 }]);
  await assert.rejects(runCohort(f.manifest, f.census, f.checkpoint,
    { perCategory: 2, chunkBytes: 1 }), /file 1 line 3: malformed JSON/);
  const checkpoint = JSON.parse(await readFile(f.checkpoint, 'utf8'));
  assert.equal(checkpoint.files[0].sha256, f.files[0].sha256);
  assert.equal(checkpoint.files[1], null);
});

test('final line without a newline has an exact byte span', async t => {
  const meta = row('session_meta', { id: 'root' });
  const final = legacy({ total_tokens: 1 }, { total_tokens: 1 }).trimEnd();
  const f = await fixture(t, [{ body: meta + final, legacy: 1 }]);
  const file = (await runCohort(f.manifest, f.census, f.checkpoint,
    { chunkBytes: 2 })).files[0];
  assert.equal(file.rows[0].offset, Buffer.byteLength(meta));
  assert.equal(file.rows[0].byteLength, Buffer.byteLength(final));
  assert.equal(file.rows[0].offset + file.rows[0].byteLength, file.bytes);
});

test('checkpoint cannot alias an unselected source file', async t => {
  const selected = row('session_meta', { id: 'root' })
    + legacy({ total_tokens: 1 }, { total_tokens: 1 });
  const unselected = row('session_meta', { id: 'other' });
  const f = await fixture(t, [{ body: selected, legacy: 1 },
    { body: unselected, legacy: 0 }]);
  const target = path.join(f.root, '1.jsonl');
  await assert.rejects(runCohort(f.manifest, f.census, target),
    /Cohort checkpoint aliases an input/);
  assert.equal(await readFile(target, 'utf8'), unselected);
});
