import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BINARY || process.env.AGENTSESSION_V3_BIN ||
  path.join(repo, 'v3/target/debug', process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const id = 'reader-content-snapshot';
const otherId = 'reader-content-other';
const body = 'BODY-START 🧭 阅读 ' + 'b'.repeat(3200) + ' BODY-END';
const input = JSON.stringify({ command: 'INPUT-START ' + 'i'.repeat(3300) + ' INPUT-END' });
const output = 'OUTPUT-START ' + 'o'.repeat(3400) + ' OUTPUT-END';
const hash = text => createHash('sha256').update(text).digest('hex');
const message = (messageId, text) => ({ type: 'response_item', payload: {
  type: 'message', id: messageId, role: 'assistant', content: [{ type: 'output_text', text }] } });
function records(sessionId = id, { toolInput = input, toolOutput = output, text = body, shifted = false } = {}) {
  return [{ type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/snapshot' } },
    ...(shifted ? [message('inserted-before', 'New event before the original canonical events.')] : []),
    message('snapshot-body', text),
    { type: 'response_item', payload: { type: 'function_call', call_id: 'snapshot-tool', name: 'read_source', arguments: toolInput } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'snapshot-tool', output: toolOutput } }];
}
const serialize = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
async function harness(t, { text = body, cacheDir } = {}) {
  assert.ok(existsSync(binary), `Build the native backend at ${binary}`);
  const scratch = path.join(repo, 'tmp/reader-content-snapshot');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'http-'));
  const sourceRoot = path.join(root, 'codex');
  const file = path.join(sourceRoot, 'sessions/2026/10/10/rollout-snapshot.jsonl');
  const otherFile = path.join(path.dirname(file), 'rollout-other.jsonl');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, serialize(records(id, { text })));
  await writeFile(otherFile, serialize(records(otherId, { text: 'OTHER BODY', toolInput: '{"command":"OTHER INPUT"}', toolOutput: 'OTHER OUTPUT' })));
  const otherDigest = hash(await readFile(otherFile));
  for (const name of ['meta', 'index', 'cache', 'claude', 'pi', 'dsh']) await mkdir(path.join(root, name));
  cacheDir ??= path.join(root, 'cache');
  await writeFile(path.join(root, 'config.json'), '{}\n');
  const port = await freeFetchSafePort();
  const child = spawn(binary, ['--config', path.join(root, 'config.json'), 'serve', '--port', String(port),
    '--codex-dir', sourceRoot, '--opencode-db', path.join(root, 'absent.db'),
    '--claude-dir', path.join(root, 'claude'), '--pi-dir', path.join(root, 'pi'), '--dsh-dir', path.join(root, 'dsh'),
    '--meta-dir', path.join(root, 'meta'), '--index-dir', path.join(root, 'index'), '--cache-dir', cacheDir],
  { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
    await writeFile(path.join(scratch, `native-${path.basename(root)}.log`), logs);
    assert.equal(hash(await readFile(otherFile)), otherDigest, 'Viewer requests preserve the unmodified task-owned source');
    await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Backend exited: ${logs}`);
    try { if ((await fetch(`${origin}/api/providers`)).ok) return { origin, file, otherFile, cacheDir }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Backend startup timed out: ${logs}`);
}
const get = async url => { const response = await fetch(url); return { status: response.status, body: await response.json() }; };
const route = (origin, sessionId = id) => `${origin}/api/v3/reader/codex/${sessionId}`;
async function bootstrap(origin, sessionId = id) {
  const result = await get(`${route(origin, sessionId)}/bootstrap`);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
const items = snapshot => snapshot.segments.flatMap(segment => segment.items);
const fieldItems = snapshot => [
  [items(snapshot).find(item => item.event.messageId === 'snapshot-body'), 'body', body],
  [items(snapshot).find(item => item.event.messageId === 'snapshot-tool'), 'toolInput', input],
  [items(snapshot).find(item => item.event.messageId === 'snapshot-tool'), 'toolOutput', output],
];
function contentUrl(origin, snapshot, item, field, { token = item.contentRevisions[field], sessionId = id, offset = 0 } = {}) {
  const query = new URLSearchParams({ revision: snapshot.revision, messageId: item.event.messageId,
    segment: item.event.segment, field, offset: String(offset), maxChars: '700' });
  if (token !== null) query.set('contentRevision', token);
  return `${route(origin, sessionId)}/content?${query}`;
}
async function exactContent(origin, snapshot, item, field, expected) {
  assert.equal(item.contentRevisions[field], hash(expected), `${field} token hashes the full normalized UTF-8 field`);
  let offset = 0, text = '', pages = 0;
  do {
    const result = await get(contentUrl(origin, snapshot, item, field, { offset }));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.text, expected.slice(offset, offset + 700));
    text += result.body.text;
    pages++;
    offset = result.body.nextOffset;
  } while (offset !== null && offset !== undefined);
  assert.ok(pages > 1, `${field} exercises bounded continuation`);
  assert.equal(text, expected);
}
async function sourceChanged(url) {
  const result = await get(url);
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error.code, 'source_changed');
}

test('Reader field snapshots survive append and ordinal changes, then reject replaced content', { timeout: 45_000 }, async t => {
  const h = await harness(t);
  const initial = await bootstrap(h.origin);
  const fields = fieldItems(initial);
  for (const [item, field, expected] of fields) {
    assert.ok(item, `published ${field} event exists`);
    assert.equal(item.contentRevisions[field], hash(expected));
  }
  await appendFile(h.file, serialize([message('appended-after-open', 'Live append after bootstrap.')]));
  for (const [item, field, expected] of fields) {
    await exactContent(h.origin, initial, item, field, expected);
    await sourceChanged(contentUrl(h.origin, initial, item, field, { token: null }));
  }
  const appended = await bootstrap(h.origin);
  assert.notEqual(appended.revision, initial.revision);
  for (const [item, field, expected] of fields) await exactContent(h.origin, initial, item, field, expected);

  await writeFile(h.file, serialize(records(id, { shifted: true })));
  const shifted = await bootstrap(h.origin);
  for (const [item, field, expected] of fields) {
    const fresh = items(shifted).find(candidate => candidate.event.messageId === item.event.messageId && candidate.event.segment === item.event.segment);
    assert.notEqual(fresh.ordinal, item.ordinal, 'fixture shifts ordinal while retaining canonical event identity');
    await exactContent(h.origin, initial, item, field, expected);
  }

  const tool = fields[1][0];
  for (const token of ['invalid-token', '0'.repeat(64), tool.contentRevisions.toolOutput]) {
    await sourceChanged(contentUrl(h.origin, initial, tool, 'toolInput', { token }));
  }
  await bootstrap(h.origin, otherId);
  for (const [item, field] of fields) await sourceChanged(contentUrl(h.origin, initial, item, field, { sessionId: otherId }));

  await writeFile(h.file, serialize(records(id, { shifted: true, toolInput: input + ' CHANGED' })));
  const replaced = await bootstrap(h.origin);
  const newTool = items(replaced).find(item => item.event.messageId === 'snapshot-tool');
  assert.equal(newTool.contentRevisions.toolInput, hash(input + ' CHANGED'));
  await sourceChanged(contentUrl(h.origin, initial, tool, 'toolInput'));
  await exactContent(h.origin, initial, tool, 'toolOutput', output);
  await exactContent(h.origin, initial, fields[0][0], 'body', body);

  // Only the latest published generation is retained; restoring identical bytes restores this field hash.
  await writeFile(h.file, serialize(records(id, { shifted: true, text: body + ' CHANGED' })));
  await bootstrap(h.origin);
  await sourceChanged(contentUrl(h.origin, initial, fields[0][0], 'body'));
  await exactContent(h.origin, initial, tool, 'toolInput', input);
  assert.equal(await readFile(h.file, 'utf8'), serialize(records(id, { shifted: true, text: body + ' CHANGED' })),
    'Reader publication and content requests preserve the exact test-authored source bytes');

  await unlink(h.file);
  await exactContent(h.origin, initial, tool, 'toolInput', input);
  await exactContent(h.origin, initial, tool, 'toolOutput', output);
  const strictMissing = await get(contentUrl(h.origin, initial, tool, 'toolOutput', { token: null }));
  assert.equal(strictMissing.status, 404, 'strict requests still resolve the live source');
  t.diagnostic('Deleted source remains readable through its latest published field snapshot; no historical generations are retained.');
});

test('Reader snapshots isolate the same canonical session across source scopes sharing a cache directory', { timeout: 45_000 }, async t => {
  const left = await harness(t);
  const initial = await bootstrap(left.origin);
  const item = fieldItems(initial)[0][0];
  const right = await harness(t, { text: 'Different source scope body.', cacheDir: left.cacheDir });
  await bootstrap(right.origin);
  await sourceChanged(contentUrl(right.origin, initial, item, 'body'));
  await exactContent(left.origin, initial, item, 'body', body);
});
