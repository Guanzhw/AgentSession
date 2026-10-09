import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runLedger } from '../scripts/v3-codex-usage-ledger.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const row = (type, payload) => JSON.stringify({ type, payload }) + '\n';
const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const usage = Object.fromEntries(fields.map((field, index) => [field, index]));

async function fixture(t, bodies) {
  const dir = path.resolve('tmp', `usage-ledger-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const root = path.join(dir, 'sources');
  await mkdir(root);
  const files = [];
  for (const [index, body] of bodies.entries()) {
    const bytes = Buffer.from(body);
    const name = `${index}.jsonl`;
    await writeFile(path.join(root, name), bytes);
    files.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
  }
  const manifest = path.join(dir, 'manifest.json');
  const output = path.join(dir, 'ledger.private.jsonl');
  await writeFile(manifest, JSON.stringify({ root, files }));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, root, manifest, output, files };
}

const entries = async output => (await readFile(output, 'utf8')).trimEnd().split('\n').map(JSON.parse);

test('streams every occurrence and boundary with exact source positions and six-field states', async t => {
  const meta = row('session_meta', { id: 'child', parent_thread_id: 'parent',
    source: { subagent: { thread_spawn: { call_id: 'call' } } } });
  const before = row('token_usage_record', { response_id: 'same', thread_id: 'child',
    session_id: 'parent', usage, thread_token_usage: { ...usage } });
  const task = row('response_item', { type: 'agent_message', id: 'task',
    content: [{ text: 'Message Type: NEW_TASK\nPRIVATE BODY' }] });
  const legacy = row('event_msg', { type: 'token_count', info: {
    last_token_usage: { ...usage, cached_input_tokens: null },
    total_token_usage: { total_tokens: 3 } } });
  const compact = row('event_msg', { type: 'context_compacted', turn_id: 'turn' });
  const final = row('token_usage_record', { response_id: 'same', usage: { total_tokens: 9 } }).trimEnd();
  const f = await fixture(t, [meta + before + task + legacy + compact + final,
    row('session_meta', { id: 'other' }) + row('event_msg', { type: 'token_count', info: {} })]);
  const result = await runLedger(f.manifest, f.output, { expectedFiles: 2, chunkBytes: 2 });
  assert.equal(result.files, 2);
  assert.equal(result.canonical, 2);
  assert.equal(result.legacy, 2);
  const records = await entries(f.output);
  assert.deepEqual(records.filter(x => x.type === 'usage').map(x => [x.file, x.line, x.kind]),
    [[0, 2, 'canonical'], [0, 4, 'legacy'], [0, 6, 'canonical'], [1, 2, 'legacy']]);
  const first = records.find(x => x.type === 'usage' && x.file === 0 && x.line === 2);
  assert.equal(first.offset, Buffer.byteLength(meta));
  assert.equal(first.byteLength, Buffer.byteLength(before) - 1);
  assert.equal(first.rawHash, sha(Buffer.from(before.trimEnd())));
  assert.equal(first.sourceSha256, f.files[0].sha256);
  assert.deepEqual(first.owner, { threadIdHash: sha('child'), sessionIdHash: sha('parent'),
    activeSessionHash: sha('child') });
  assert.equal(first.responseHash, sha('same'));
  assert.equal(first.request.input_tokens.value, 0);
  const second = records.find(x => x.type === 'usage' && x.file === 0 && x.line === 4);
  assert.equal(second.request.cached_input_tokens.state, 'invalid');
  assert.equal(second.request.cache_write_input_tokens.value, 2);
  assert.equal(second.cumulative.input_tokens.state, 'missing');
  assert.equal(second.responseHash, null);
  const last = records.find(x => x.type === 'usage' && x.file === 0 && x.line === 6);
  assert.equal(last.offset + last.byteLength, f.files[0].bytes);
  assert.equal(last.request.input_tokens.state, 'missing');
  assert.deepEqual(records.filter(x => x.type === 'boundary' && x.file === 0).map(x => x.kind),
    ['session-meta', 'new-task', 'context_compacted']);
  assert.equal(records.at(-1).type, 'complete');
  assert.equal(JSON.stringify(records).includes('PRIVATE BODY'), false);
  assert.equal(JSON.stringify(records).includes('"parent"'), false);
});

test('requires explicitly complete manifest count and rejects changed, short, and malformed sources', async t => {
  const good = row('session_meta', { id: 'a' }) + row('token_usage_record', { usage });
  const f = await fixture(t, [good, good]);
  await assert.rejects(runLedger(f.manifest, f.output, { expectedFiles: 1 }), /Manifest file count/);
  await assert.rejects(runLedger(f.manifest, f.output), /expectedFiles/);
  await writeFile(path.join(f.root, '1.jsonl'), good.slice(0, -5));
  await assert.rejects(runLedger(f.manifest, f.output, { expectedFiles: 2, chunkBytes: 3 }),
    /malformed JSON|Source hash mismatch/);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
  await writeFile(path.join(f.root, '1.jsonl'), good.replace('"a"', '"b"'));
  await assert.rejects(runLedger(f.manifest, f.output, { expectedFiles: 2 }), /Source hash mismatch/);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
  const validShort = row('session_meta', { id: 'a' });
  await writeFile(path.join(f.root, '1.jsonl'), validShort);
  await assert.rejects(runLedger(f.manifest, f.output, { expectedFiles: 2 }), /Source hash mismatch/);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
  const malformed = good + '{private-malformed-row}\n';
  await writeFile(path.join(f.root, '1.jsonl'), malformed);
  await writeFile(f.manifest, JSON.stringify({ root: f.root,
    files: [f.files[0], { ...f.files[1], bytes: Buffer.byteLength(malformed), sha256: sha(malformed) }] }));
  await assert.rejects(runLedger(f.manifest, f.output, { expectedFiles: 2 }),
    /file 1 line 3: malformed JSON/);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('rejects output aliases, duplicate sources, and oversized lines before publication', async t => {
  const content = row('token_usage_record', { usage });
  const f = await fixture(t, [content, content]);
  await assert.rejects(runLedger(f.manifest, path.join(f.root, '0.jsonl'), { expectedFiles: 2 }), /aliases an input/);
  assert.equal(await readFile(path.join(f.root, '0.jsonl'), 'utf8'), content);
  const alias = path.join(f.root, 'alias.jsonl');
  await link(path.join(f.root, '0.jsonl'), alias);
  const manifest = { root: f.root, files: [f.files[0], { ...f.files[0], path: 'alias.jsonl' }] };
  await writeFile(f.manifest, JSON.stringify(manifest));
  await assert.rejects(runLedger(f.manifest, f.output, { expectedFiles: 2 }), /Duplicate source/);
  await writeFile(f.manifest, JSON.stringify({ root: f.root, files: f.files }));
  await assert.rejects(runLedger(f.manifest, f.output, { expectedFiles: 2, maxLineBytes: 8 }), /line exceeds/);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('a stale temporary ledger remains untouched when exclusive creation fails', async t => {
  const f = await fixture(t, [row('token_usage_record', { usage })]);
  const temporary = `${f.output}.${process.pid}.tmp`;
  await writeFile(temporary, 'private-existing-ledger');
  await assert.rejects(runLedger(f.manifest, f.output, { expectedFiles: 1 }),
    { code: 'EEXIST' });
  assert.equal(await readFile(temporary, 'utf8'), 'private-existing-ledger');
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});
