import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCensus } from '../scripts/v3-codex-usage-census.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const row = (type, payload, timestamp = '2026-09-28T00:00:00Z') =>
  JSON.stringify({ type, timestamp, payload }) + '\n';
const usage = { input_tokens: 4, cached_input_tokens: 0, output_tokens: 2, total_tokens: 6 };

async function fixture(t, sources) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-census-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [];
  for (const [index, content] of sources.entries()) {
    const name = `${index}.jsonl`;
    const bytes = Buffer.from(content);
    await writeFile(path.join(root, name), bytes);
    files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
  }
  const manifest = path.join(root, 'manifest.json');
  const checkpoint = path.join(root, 'checkpoint.json');
  await writeFile(manifest, JSON.stringify({ root, files }));
  return { root, manifest, checkpoint, files };
}

test('streaming chunks classify canonical, legacy mirrors, identity collisions, field absence, and child evidence', async t => {
  const secret = 'SECRET_TRANSCRIPT_BODY';
  const first = row('session_meta', { id: 'parent' })
    + row('token_usage_record', { response_id: 'same', session_id: 'parent', usage, thread_token_usage: { total_tokens: 6 } })
    + row('event_msg', { type: 'token_count', info: { last_token_usage: usage, total_token_usage: { total_tokens: 6 } } })
    + row('event_msg', { type: 'token_count', info: {} })
    + row('token_usage_record', { response_id: 'same', session_id: 'parent', usage: { ...usage, total_tokens: 0 } })
    + row('response_item', { type: 'function_call', name: 'spawn_agent', call_id: 'call-1', arguments: secret });
  const second = row('session_meta', { id: 'child', parent_thread_id: 'parent', agent_path: '/root/child' })
    + row('token_usage_record', { response_id: 'other', session_id: 'parent', usage: { input_tokens: 0 } })
    + row('response_item', { type: 'agent_message', id: 'call-1', content: [{ type: 'text', text: `Message Type: NEW_TASK\nTask name: /root/child\n${secret}` }] })
    + row('token_usage_record', { response_id: 'other', session_id: 'child', usage: { input_tokens: 0, total_tokens: 0 } });
  const f = await fixture(t, [first, second]);
  const before = await Promise.all(f.files.map(file => readFile(path.join(f.root, file.path))));
  const result = await runCensus(f.manifest, f.checkpoint, { chunkBytes: 7 });
  assert.equal(result.files.length, 2);
  assert.deepEqual(result.totals, { canonical: 4, legacy: 2, pairedLegacy: 1,
    ambiguousLegacyPairs: 0, unmatchedLegacy: 1,
    duplicateResponseIds: 2, conflictingResponseIds: 2, missingResponseIds: 0,
    threadHeaderDifferences: 0, sessionHeaderDifferences: 1,
    beforeTaskMarkerUsage: 1, atOrAfterTaskMarkerUsage: 1, noTaskMarkerUsage: 0,
    spawnCalls: 1,
    newTaskEnvelopes: 1, conflictingSessionMetaIds: 0, missingOwnerIds: 0 });
  assert.deepEqual(result.fields.canonical.total_tokens, { missing: 1, zero: 2, positive: 1, invalid: 0 });
  assert.deepEqual(result.fields.legacy.total_tokens, { missing: 1, zero: 0, positive: 1, invalid: 0 });
  assert.equal(result.files[1].child.parentHash, hash('parent'));
  assert.equal(result.files[0].sessionHash, result.files[1].child.parentHash);
  assert.equal(result.files[1].child.firstNewTaskLine, 3);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal((await readFile(f.checkpoint, 'utf8')).includes(secret), false);
  assert.deepEqual(await Promise.all(f.files.map(file => readFile(path.join(f.root, file.path)))), before);
});

test('child usage without a task marker remains boundary unknown', async t => {
  const child = row('session_meta', { id: 'child', parent_thread_id: 'parent' })
    + row('token_usage_record', { response_id: 'r', session_id: 'parent', thread_id: 'child', usage });
  const f = await fixture(t, [child]);
  const result = await runCensus(f.manifest, f.checkpoint);
  assert.equal(result.totals.threadHeaderDifferences, 0);
  assert.equal(result.totals.sessionHeaderDifferences, 1);
  assert.equal(result.totals.beforeTaskMarkerUsage, 0);
  assert.equal(result.totals.atOrAfterTaskMarkerUsage, 0);
  assert.equal(result.totals.noTaskMarkerUsage, 1);
});

test('matching bytes reuse a checkpoint; changed bytes invalidate it explicitly', async t => {
  const f = await fixture(t, [row('session_meta', { id: 'a' }) + row('token_usage_record', { response_id: 'r', usage })]);
  const initial = await runCensus(f.manifest, f.checkpoint, { chunkBytes: 3 });
  assert.deepEqual(initial.progress, { scannedFiles: 1, reusedFiles: 0 });
  const resumed = await runCensus(f.manifest, f.checkpoint, { chunkBytes: 3 });
  assert.deepEqual(resumed.progress, { scannedFiles: 0, reusedFiles: 1 });
  await writeFile(path.join(f.root, f.files[0].path), row('session_meta', { id: 'changed' }));
  await assert.rejects(runCensus(f.manifest, f.checkpoint, { chunkBytes: 3 }), /Source hash mismatch.*file 0/);
  const checkpoint = JSON.parse(await readFile(f.checkpoint, 'utf8'));
  assert.equal(checkpoint.files[0], null);
  const changed = await readFile(path.join(f.root, f.files[0].path));
  await writeFile(f.manifest, JSON.stringify({ root: f.root,
    files: [{ path: f.files[0].path, bytes: changed.length, sha256: hash(changed) }] }));
  const rescanned = await runCensus(f.manifest, f.checkpoint, { chunkBytes: 3 });
  assert.deepEqual(rescanned.progress, { scannedFiles: 1, reusedFiles: 0 });
});

test('malformed JSON reports exact source line and preserves earlier file progress', async t => {
  const f = await fixture(t, [row('session_meta', { id: 'ok' }), row('session_meta', { id: 'bad' }) + '{not-json}\n']);
  await assert.rejects(runCensus(f.manifest, f.checkpoint, { chunkBytes: 2 }), /file 1 line 2: malformed JSON/);
  const checkpoint = JSON.parse(await readFile(f.checkpoint, 'utf8'));
  assert.ok(checkpoint.files[0]);
  assert.equal(checkpoint.files[1], null);
});

test('checkpoint cannot overwrite a source path or a hard-link alias', async t => {
  const f = await fixture(t, [row('session_meta', { id: 'source' })]);
  const source = path.join(f.root, f.files[0].path);
  const before = await readFile(source);
  await assert.rejects(runCensus(f.manifest, source), /Checkpoint aliases source file 0/);
  assert.deepEqual(await readFile(source), before);
  const alias = path.join(f.root, 'alias.json');
  await link(source, alias);
  await assert.rejects(runCensus(f.manifest, alias), /Checkpoint aliases source file 0/);
  assert.deepEqual(await readFile(source), before);
  assert.deepEqual(await readFile(alias), before);
});

test('manifest rejects duplicate canonical paths before scanning or checkpointing', async t => {
  const f = await fixture(t, [row('session_meta', { id: 'source' })]);
  const source = path.join(f.root, f.files[0].path);
  const before = await readFile(source);
  await writeFile(f.manifest, JSON.stringify({ root: f.root, files: [f.files[0],
    { ...f.files[0], path: `./${f.files[0].path}` }] }));
  await assert.rejects(runCensus(f.manifest, f.checkpoint), /Duplicate source file 1 aliases file 0/);
  assert.deepEqual(await readFile(source), before);
  await assert.rejects(readFile(f.checkpoint), { code: 'ENOENT' });
});

test('missing explicit request owner remains missing beside the session header', async t => {
  const f = await fixture(t, [row('session_meta', { id: 'header' })
    + row('token_usage_record', { response_id: 'r', usage })]);
  const result = await runCensus(f.manifest, f.checkpoint);
  assert.equal(result.totals.missingOwnerIds, 1);
  assert.equal(result.files[0].sessionHash, hash('header'));
  const checkpoint = JSON.parse(await readFile(f.checkpoint, 'utf8'));
  assert.deepEqual(checkpoint.files[0].identities[0].owner,
    { sessionIdHash: null, threadIdHash: null });
});

test('an older checkpoint schema is recaptured before reporting new ownership fields', async t => {
  const f = await fixture(t, [row('session_meta', { id: 'header' })
    + row('token_usage_record', { response_id: 'r', usage })]);
  const initial = await runCensus(f.manifest, f.checkpoint);
  assert.equal(initial.totals.missingOwnerIds, 1);
  const previous = JSON.parse(await readFile(f.checkpoint, 'utf8'));
  previous.format = 'agentsession-v3-codex-usage-checkpoint/v1';
  delete previous.files[0].counts.missingOwnerIds;
  await writeFile(f.checkpoint, JSON.stringify(previous));
  const recaptured = await runCensus(f.manifest, f.checkpoint);
  assert.deepEqual(recaptured.progress, { scannedFiles: 1, reusedFiles: 0 });
  assert.equal(recaptured.totals.missingOwnerIds, 1);
});

test('checkpoint cannot overwrite the manifest path or a hard-link alias', async t => {
  const f = await fixture(t, [row('session_meta', { id: 'source' })]);
  const source = path.join(f.root, f.files[0].path);
  const sourceBefore = await readFile(source);
  const manifestBefore = await readFile(f.manifest);
  await assert.rejects(runCensus(f.manifest, f.manifest), /Checkpoint aliases manifest/);
  assert.deepEqual(await readFile(f.manifest), manifestBefore);
  assert.deepEqual(await readFile(source), sourceBefore);
  const alias = path.join(f.root, 'manifest-alias.json');
  await link(f.manifest, alias);
  await assert.rejects(runCensus(f.manifest, alias), /Checkpoint aliases manifest/);
  assert.deepEqual(await readFile(f.manifest), manifestBefore);
  assert.deepEqual(await readFile(alias), manifestBefore);
  assert.deepEqual(await readFile(source), sourceBefore);
  const temporaryAlias = `${f.checkpoint}.${process.pid}.tmp`;
  await link(f.manifest, temporaryAlias);
  await assert.rejects(runCensus(f.manifest, f.checkpoint), /Checkpoint aliases manifest/);
  assert.deepEqual(await readFile(f.manifest), manifestBefore);
  assert.deepEqual(await readFile(temporaryAlias), manifestBefore);
  assert.deepEqual(await readFile(source), sourceBefore);
});

test('stale temporary checkpoint fails explicitly without touching sources or manifest', async t => {
  const f = await fixture(t, [row('session_meta', { id: 'source' })]);
  const source = path.join(f.root, f.files[0].path);
  const sourceBefore = await readFile(source);
  const manifestBefore = await readFile(f.manifest);
  const temporary = `${f.checkpoint}.${process.pid}.tmp`;
  await writeFile(temporary, 'stale checkpoint');
  await assert.rejects(runCensus(f.manifest, f.checkpoint), /Checkpoint temporary file already exists/);
  assert.equal(await readFile(temporary, 'utf8'), 'stale checkpoint');
  assert.deepEqual(await readFile(source), sourceBefore);
  assert.deepEqual(await readFile(f.manifest), manifestBefore);
});
