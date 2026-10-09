import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const fixtureRoot = path.join(repo, 'test', 'fixtures', 'v3-source-scope');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const sharedId = '11111111-1111-4111-8111-111111111111';

async function freePort() {
  return freeFetchSafePort();
}

async function start(children, sourceRoot, stateRoot, { createClaude = true } = {}) {
  assert.ok(existsSync(binary), `Build the S2 Rust binary at ${binary}`);
  for (const name of ['meta', 'index', 'cache', 'pi', 'dsh', 'opencode',
    ...(createClaude ? ['claude'] : [])]) {
    await mkdir(path.join(stateRoot, name), { recursive: true });
  }
  const port = await freePort();
  const child = spawn(binary, [
    'serve', '--port', String(port),
    '--codex-dir', sourceRoot,
    '--opencode-db', path.join(stateRoot, 'opencode', 'opencode.db'),
    '--claude-dir', path.join(stateRoot, 'claude'),
    '--pi-dir', path.join(stateRoot, 'pi'),
    '--dsh-dir', path.join(stateRoot, 'dsh'),
    '--meta-dir', path.join(stateRoot, 'meta'),
    '--index-dir', path.join(stateRoot, 'index'),
    '--cache-dir', path.join(stateRoot, 'cache'),
  ], { cwd: repo, windowsHide: true, stdio: 'ignore' });
  children.push(child);
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('3.0 server exited before readiness');
    try {
      const response = await fetch(`${origin}/api/providers`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return origin;
    } catch { /* Readiness is checked until the deadline. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('3.0 server did not become ready');
}

async function assistantBody(origin, id) {
  const bootstrapResponse = await fetch(`${origin}/api/v3/reader/codex/${id}/bootstrap`);
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  const assistant = bootstrap.segments.flatMap(segment => segment.items)
    .find(item => item.role === 'assistant');
  assert.ok(assistant, 'The canonical session must expose its assistant event');
  const params = new URLSearchParams({
    messageId: assistant.event.messageId, segment: assistant.event.segment,
    field: 'body', offset: '0', maxChars: '100', revision: bootstrap.revision,
  });
  const response = await fetch(`${origin}/api/v3/reader/codex/${id}/content?${params}`);
  assert.equal(response.status, 200);
  return { bootstrap, params, content: await response.json() };
}

async function stopChildren(children) {
  await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null)
    .map(child => {
      const closed = once(child, 'close');
      child.kill();
      return closed;
    }));
}

async function connectMcp(t, sourceRoot, stateRoot) {
  const client = new Client({ name: 'source-boundary-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: binary, cwd: repo, stderr: 'pipe', args: [
    'mcp', '--codex-dir', sourceRoot,
    '--opencode-db', path.join(stateRoot, 'opencode', 'opencode.db'),
    '--claude-dir', path.join(stateRoot, 'claude'),
    '--pi-dir', path.join(stateRoot, 'pi'),
    '--dsh-dir', path.join(stateRoot, 'dsh'),
    '--meta-dir', path.join(stateRoot, 'meta'),
    '--index-dir', path.join(stateRoot, 'index'),
    '--cache-dir', path.join(stateRoot, 'cache'),
  ] }));
  t.after(() => client.close());
  return client;
}

async function mcpSearch(client, query) {
  const response = await client.callTool({ name: 'session_search', arguments: {
    query, providers: ['codex'], fields: ['assistant'],
  } });
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  return response.structuredContent.result.matches;
}

test('same canonical ID resolves only within its configured source scope', { timeout: 30_000 }, async t => {
  const stateRoot = await mkdtemp(path.join(repo, 'tmp', 'v3-scope-'));
  const children = [];
  t.after(async () => {
    await stopChildren(children);
    await rm(stateRoot, { recursive: true, force: true });
  });
  const leftOrigin = await start(children, path.join(fixtureRoot, 'left'), stateRoot);
  const left = await assistantBody(leftOrigin, sharedId);
  assert.equal(left.content.text, 'left source answer');
  const rightOrigin = await start(children, path.join(fixtureRoot, 'right'), stateRoot);
  const right = await assistantBody(rightOrigin, sharedId);
  assert.equal(right.content.text, 'right source answer');
  assert.deepEqual(left.bootstrap.session.session, right.bootstrap.session.session);
  assert.notEqual(left.bootstrap.revision, right.bootstrap.revision);

  const leftMcp = await connectMcp(t, path.join(fixtureRoot, 'left'), stateRoot);
  const rightMcp = await connectMcp(t, path.join(fixtureRoot, 'right'), stateRoot);
  assert.deepEqual((await mcpSearch(leftMcp, 'left source answer')).map(row => row.session.sessionId), [sharedId]);
  assert.deepEqual(await mcpSearch(rightMcp, 'left source answer'), []);
  assert.deepEqual((await mcpSearch(rightMcp, 'right source answer')).map(row => row.session.sessionId), [sharedId]);
  assert.deepEqual(await mcpSearch(leftMcp, 'right source answer'), []);
  const query = { level: 'sessions', providers: ['codex'], limit: 1 };
  const leftFirst = await leftMcp.callTool({ name: 'session_browse', arguments: query });
  assert.notEqual(leftFirst.isError, true, leftFirst.content?.[0]?.text);
  const leftCursor = leftFirst.structuredContent.result.nextCursor;
  assert.ok(leftCursor, 'The left source has a second browse page');
  const crossed = await rightMcp.callTool({ name: 'session_browse', arguments: {
    ...query, cursor: leftCursor,
  } });
  assert.equal(crossed.isError, true, 'A cursor cannot move between concurrent source scopes');

  const rename = await fetch(`${leftOrigin}/api/codex/session/${sharedId}/rename`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: leftOrigin },
    body: JSON.stringify({ title: 'Only the left scope' }),
  });
  assert.equal(rename.status, 200);
  const rightMeta = await (await fetch(`${rightOrigin}/api/v3/meta/codex/${sharedId}`)).json();
  assert.equal(rightMeta, null, 'a shared metadata directory does not share Viewer state across sources');
  const hideRight = await fetch(`${rightOrigin}/api/codex/session/${sharedId}/delete`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: rightOrigin }, body: '{}',
  });
  assert.equal(hideRight.status, 200);
  const leftRows = await (await fetch(`${leftOrigin}/api/v3/sessions?provider=codex`)).json();
  const rightRows = await (await fetch(`${rightOrigin}/api/v3/sessions?provider=codex`)).json();
  assert.equal(leftRows.find(row => row.session.sessionId === sharedId)?.title, 'Only the left scope');
  assert.ok(!rightRows.some(row => row.session.sessionId === sharedId));
});

test('Viewer state survives a configured provider directory appearing between restarts',
  { timeout: 30_000 }, async t => {
    const stateRoot = await mkdtemp(path.join(repo, 'tmp', 'v3-scope-appears-'));
    const children = [];
    t.after(async () => {
      await stopChildren(children);
      await rm(stateRoot, { recursive: true, force: true });
    });
    const sourceRoot = path.join(fixtureRoot, 'left');
    const origin = await start(children, sourceRoot, stateRoot, { createClaude: false });
    const star = await fetch(`${origin}/api/codex/session/${sharedId}/star`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}',
    });
    assert.equal(star.status, 200);
    assert.equal((await star.json()).starred, true);
    const close = once(children[0], 'close');
    children[0].kill();
    await close;
    await mkdir(path.join(stateRoot, 'claude'));
    const restarted = await start(children, sourceRoot, stateRoot);
    const metadata = await fetch(`${restarted}/api/v3/meta/codex/${sharedId}`);
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json()).starred, true);
  });

test('old Reader revision rejects a changed source rather than returning stale content', { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(path.join(repo, 'tmp', 'v3-revision-'));
  const children = [];
  t.after(async () => {
    await stopChildren(children);
    await rm(dir, { recursive: true, force: true });
  });
  const sourceRoot = path.join(dir, 'source');
  await cp(path.join(fixtureRoot, 'left'), sourceRoot, { recursive: true });
  const origin = await start(children, sourceRoot, path.join(dir, 'state'));
  const initial = await assistantBody(origin, sharedId);
  assert.equal(initial.content.text, 'left source answer');
  const file = path.join(sourceRoot, 'sessions', '2026', '09', '26',
    'rollout-2026-09-26T00-00-00-11111111-1111-4111-8111-111111111111.jsonl');
  const original = readFileSync(file, 'utf8');
  await writeFile(file, original.replace('left source answer', 'left revised source answer'));
  const stale = await fetch(`${origin}/api/v3/reader/codex/${sharedId}/content?${initial.params}`);
  assert.equal(stale.status, 409);
  const error = await stale.json();
  assert.equal(error.error.code, 'source_changed');
});
