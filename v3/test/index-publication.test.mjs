import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const fixture = path.join(repo, 'v3', 'fixtures', 'codex');
const filename = 'rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl';

async function start(t, args) {
  const client = new Client({ name: 'index-publication-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: binary, args, cwd: repo, stderr: 'pipe' }));
  t.after(() => client.close());
  return client;
}

test('durable catalog invalidates body-only rewrite across MCP processes', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-index-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache'])
    await mkdir(path.join(root, name));
  await cp(fixture, path.join(root, 'codex'), { recursive: true });
  const copied = path.join(root, 'codex', 'sessions', '2026', '09', '26', filename);
  const original = await readFile(copied, 'utf8');
  const otherId = '55555555-5555-4555-8555-555555555555';
  await writeFile(path.join(path.dirname(copied), filename.replaceAll(
    '44444444-4444-4444-8444-444444444444', otherId)), original.replaceAll(
    '44444444-4444-4444-8444-444444444444', otherId));
  const args = ['mcp', '--codex-dir', path.join(root, 'codex'), '--opencode-db', path.join(root, 'opencode.db'),
    '--claude-dir', path.join(root, 'claude'), '--pi-dir', path.join(root, 'pi'),
    '--dsh-dir', path.join(root, 'dsh'), '--meta-dir', path.join(root, 'meta'),
    '--index-dir', path.join(root, 'index'), '--cache-dir', path.join(root, 'cache')];
  const query = { level: 'sessions', providers: ['codex'], limit: 1 };
  const firstClient = await start(t, args);
  const first = await firstClient.callTool({ name: 'session_browse', arguments: query });
  assert.notEqual(first.isError, true, first.content?.[0]?.text);
  const cursor = first.structuredContent.result.nextCursor;
  assert.ok(cursor);
  assert.ok((await readdir(path.join(root, 'index'))).some(name => name.endsWith('.sqlite')),
    'catalog survives process exit in the isolated derived index directory');
  const secondClient = await start(t, args);
  const unchanged = await secondClient.callTool({ name: 'session_browse', arguments: { ...query, cursor } });
  assert.notEqual(unchanged.isError, true, unchanged.content?.[0]?.text);
  await writeFile(copied, original.replace('Hello 🙂 from the Rust slice.',
    'Howdy 🙂 from the Rust slice.'));
  const current = await secondClient.callTool({ name: 'session_browse', arguments: query });
  assert.deepEqual(current.structuredContent.result.sessions,
    first.structuredContent.result.sessions, 'a body-only change keeps the visible summary');
  const stale = await secondClient.callTool({ name: 'session_browse', arguments: { ...query, cursor } });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /^source_changed: /);
});

test('valid JSONL shortening withdraws search text and invalidates cursors across restart', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-shortening-'));
  const clients = [];
  const original = await readFile(path.join(fixture, 'sessions', '2026', '09', '26', filename), 'utf8');
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    assert.equal(await readFile(path.join(fixture, 'sessions', '2026', '09', '26', filename), 'utf8'), original);
    await rm(root, { recursive: true, force: true });
  });
  for (const name of ['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache'])
    await mkdir(path.join(root, name));
  await cp(fixture, path.join(root, 'codex'), { recursive: true });
  const copied = path.join(root, 'codex', 'sessions', '2026', '09', '26', filename);
  const otherId = '55555555-5555-4555-8555-555555555555';
  await writeFile(path.join(path.dirname(copied), filename.replaceAll(
    '44444444-4444-4444-8444-444444444444', otherId)), original.replaceAll(
    '44444444-4444-4444-8444-444444444444', otherId));
  const removed = { timestamp: '2026-09-26T00:00:06.000Z', type: 'response_item', payload: {
    type: 'message', role: 'assistant', id: 'removed-tail',
    content: [{ type: 'output_text', text: 'shorteningwithdrawalmarker' }],
  } };
  await writeFile(copied, original.trimEnd() + '\n' + JSON.stringify(removed) + '\n');
  const args = ['mcp', '--codex-dir', path.join(root, 'codex'), '--opencode-db', path.join(root, 'opencode.db'),
    '--claude-dir', path.join(root, 'claude'), '--pi-dir', path.join(root, 'pi'),
    '--dsh-dir', path.join(root, 'dsh'), '--meta-dir', path.join(root, 'meta'),
    '--index-dir', path.join(root, 'index'), '--cache-dir', path.join(root, 'cache')];
  const connect = async () => {
    const client = new Client({ name: 'index-shortening-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: binary, args, cwd: repo, stderr: 'pipe' }));
    clients.push(client);
    return client;
  };
  const call = async (client, name, input) => {
    const response = await client.callTool({ name, arguments: input });
    assert.notEqual(response.isError, true, response.content?.[0]?.text);
    return response.structuredContent.result;
  };
  const browse = { level: 'sessions', providers: ['codex'], limit: 1 };
  const retained = { query: 'Hello', providers: ['codex'], fields: ['assistant'], limit: 1 };
  const withdrawn = { ...retained, query: 'shorteningwithdrawalmarker', limit: 100 };
  const first = await connect();
  const oldBrowse = await call(first, 'session_browse', browse);
  const oldSearch = await call(first, 'session_search', retained);
  assert.ok(oldBrowse.nextCursor);
  assert.ok(oldSearch.nextCursor);
  assert.deepEqual((await call(first, 'session_search', withdrawn)).matches.map(row => row.event.messageId), ['removed-tail']);
  const observer = await connect();
  await writeFile(copied, original.trimEnd().split('\n').slice(0, 4).join('\n') + '\n');
  const verify = async client => {
    const rows = await call(client, 'session_browse', { ...browse, limit: 100 });
    assert.deepEqual(rows.sessions.map(row => row.session.sessionId).sort(), [
      '44444444-4444-4444-8444-444444444444', otherId,
    ]);
    assert.deepEqual((await call(client, 'session_search', withdrawn)).matches, []);
    assert.equal((await call(client, 'session_search', { ...retained, limit: 100 })).matches.length, 2);
    for (const [name, input, cursor] of [
      ['session_browse', browse, oldBrowse.nextCursor],
      ['session_search', retained, oldSearch.nextCursor],
    ]) {
      const stale = await client.callTool({ name, arguments: { ...input, cursor } });
      assert.equal(stale.isError, true);
      assert.match(stale.content[0].text, /^source_changed: /);
    }
  };
  await verify(observer);
  await first.close();
  await observer.close();
  await verify(await connect());
});
