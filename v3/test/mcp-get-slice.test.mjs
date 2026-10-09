import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const dshRoot = path.join(repo, 'v3', 'fixtures', 'deepseek-harness');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const provider = 'deepseek-harness';
const ids = { root: 'dsh-v3-s2-root', alpha: 'dsh-v3-s2-alpha', beta: 'dsh-v3-s2-beta' };
const ref = sessionId => ({ provider, sessionId });
const sourceFiles = Object.values(ids).map(id => path.join(dshRoot, 'sessions', 's2-synthetic', id,
  'session.v3.jsonl.zstd'));
const sourceHashes = sourceFiles.map(file => createHash('sha256').update(readFileSync(file)).digest('hex'));
const codexFixtures = [
  { directory: 'codex-collaboration', id: '99999999-9999-4999-8999-999999999999',
    assistantCount: 2, userCount: 1 },
  { directory: 'codex-compaction', id: '55555555-5555-4555-8555-555555555555',
    assistantCount: 2, userCount: 2 },
];

async function setup(t, copyDsh = false) {
  assert.ok(existsSync(binary), `Build the Rust binary at ${binary}`);
  const dir = await mkdtemp(path.join(repo, 'tmp', 'v3-mcp-get-'));
  t.after(async () => {
    try {
      assert.deepEqual(sourceFiles.map(file => createHash('sha256').update(readFileSync(file)).digest('hex')),
        sourceHashes, 'MCP must leave provider source bytes unchanged');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  for (const name of ['codex', 'claude', 'pi', 'meta', 'index', 'cache']) {
    await mkdir(path.join(dir, name));
  }
  const configuredDshRoot = copyDsh ? path.join(dir, 'dsh') : dshRoot;
  if (copyDsh) await cp(dshRoot, configuredDshRoot, { recursive: true });
  return { dir, args: [
    '--codex-dir', path.join(dir, 'codex'),
    '--opencode-db', path.join(dir, 'opencode.db'),
    '--claude-dir', path.join(dir, 'claude'),
    '--pi-dir', path.join(dir, 'pi'),
    '--dsh-dir', configuredDshRoot,
    '--meta-dir', path.join(dir, 'meta'),
    '--index-dir', path.join(dir, 'index'),
    '--cache-dir', path.join(dir, 'cache'),
  ] };
}

for (const era of ['legacy', 'modern']) {
  test(`session_get reads canonical public DSH facts over ${era} stdio MCP`,
    { timeout: 30_000 }, async t => {
      const { args } = await setup(t);
      const client = new Client({ name: 'agentsession-v3-get-test', version: '1.0.0' },
        era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
      const transport = new StdioClientTransport({ command: binary, args: ['mcp', ...args],
        cwd: repo, stderr: 'pipe' });
      await client.connect(transport);
      t.after(async () => { await client.close(); });
      const get = arguments_ => client.callTool({ name: 'session_get', arguments: arguments_ });

      const firstResponse = await get({ session: ref(ids.root), childLimit: 1 });
      assert.notEqual(firstResponse.isError, true);
      assert.equal(firstResponse.structuredContent.untrustedContent, true);
      const first = firstResponse.structuredContent.result;
      assert.deepEqual(first.session, ref(ids.root));
      assert.equal(first.parent, null);
      assert.equal(first.messageCount, 5);
      assert.deepEqual(first.roleCounts, { user: 1, assistant: 3, system: 0, tool: 1 });
      assert.deepEqual(first.toolNames.map(row => row.count), [1]);
      assert.equal(first.toolNamesTruncated, false);
      assert.deepEqual(first.firstMessage.event, { ...ref(ids.root), messageId: 'root-user', segment: 'message' });
      assert.deepEqual(first.lastMessage.event, { ...ref(ids.root), messageId: 'root-final', segment: 'message' });
      assert.equal(first.firstMessage.untrustedContent, true);
      assert.equal(first.lastMessage.untrustedContent, true);
      assert.equal(first.children.length, 1);
      assert.deepEqual(first.children[0].parent, ref(ids.root));
      assert.equal(first.childrenTruncated, true);
      assert.ok(first.childrenNextCursor);

      const nextResponse = await get({ session: ref(ids.root), childLimit: 1,
        childCursor: first.childrenNextCursor });
      assert.notEqual(nextResponse.isError, true);
      const next = nextResponse.structuredContent.result;
      assert.equal(next.children.length, 1);
      assert.deepEqual(next.children[0].parent, ref(ids.root));
      assert.deepEqual([first.children[0].session.sessionId, next.children[0].session.sessionId].sort(),
        [ids.alpha, ids.beta].sort());
      assert.equal(next.childrenNextCursor, null);
      assert.equal(next.childrenTruncated, false);

      const resized = await get({ session: ref(ids.root), childLimit: 100,
        childCursor: first.childrenNextCursor });
      assert.notEqual(resized.isError, true, 'Page size is not part of cursor identity');
      assert.deepEqual(resized.structuredContent.result.children.map(row => row.session.sessionId),
        [next.children[0].session.sessionId]);

      const all = await get({ session: ref(ids.root) });
      assert.notEqual(all.isError, true);
      assert.equal(all.structuredContent.result.children.length, 2);
      assert.equal(all.structuredContent.result.childrenNextCursor, null);
      assert.equal(all.structuredContent.result.childrenTruncated, false);

      const wrongParent = await get({ session: ref(ids.alpha),
        childCursor: first.childrenNextCursor });
      assert.equal(wrongParent.isError, true, 'Cursor must bind to its parent');
      const invalid = await get({ session: ref(ids.root), childCursor: 'invalid-cursor' });
      assert.equal(invalid.isError, true);
      const tooLarge = await get({ session: ref(ids.root), childLimit: 101 });
      assert.equal(tooLarge.isError, true);

      const { args: otherArgs } = await setup(t);
      const otherClient = new Client({ name: 'agentsession-v3-get-other-scope', version: '1.0.0' });
      await otherClient.connect(new StdioClientTransport({ command: binary,
        args: ['mcp', ...otherArgs], cwd: repo, stderr: 'pipe' }));
      t.after(async () => { await otherClient.close(); });
      const wrongScope = await otherClient.callTool({ name: 'session_get', arguments: {
        session: ref(ids.root), childCursor: first.childrenNextCursor,
      } });
      assert.equal(wrongScope.isError, true, 'Cursor must bind to configured source scope');
    });
}

test('session_get counts Codex agent replies and omits context checkpoints from message roles',
  { timeout: 30_000 }, async t => {
    for (const fixture of codexFixtures) {
      const { args } = await setup(t);
      const root = path.join(repo, 'v3', 'fixtures', fixture.directory);
      args[args.indexOf('--codex-dir') + 1] = root;
      const source = path.join(root, 'sessions', '2026', '09', fixture.directory === 'codex-collaboration' ? '27' : '26',
        `rollout-2026-09-${fixture.directory === 'codex-collaboration' ? '27' : '26'}T00-00-00-${fixture.id}.jsonl`);
      const before = createHash('sha256').update(readFileSync(source)).digest('hex');
      t.after(() => assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), before));
      const client = new Client({ name: 'agentsession-v3-get-codex-roles', version: '1.0.0' });
      await client.connect(new StdioClientTransport({ command: binary,
        args: ['mcp', ...args], cwd: repo, stderr: 'pipe' }));
      t.after(async () => client.close());
      const response = await client.callTool({ name: 'session_get', arguments: {
        session: { provider: 'codex', sessionId: fixture.id },
      } });
      assert.notEqual(response.isError, true, response.content?.[0]?.text);
      const counts = response.structuredContent.result.roleCounts;
      assert.deepEqual(Object.keys(counts).sort(), ['assistant', 'system', 'tool', 'user']);
      assert.equal(counts.user, fixture.userCount);
      assert.equal(counts.assistant, fixture.assistantCount);
    }
  });

test('session_get child cursor rejects a changed ordered source candidate set',
  { timeout: 30_000 }, async t => {
    const { dir, args } = await setup(t, true);
    const client = new Client({ name: 'agentsession-v3-get-revision', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: binary,
      args: ['mcp', ...args], cwd: repo, stderr: 'pipe' }));
    t.after(async () => { await client.close(); });
    const first = await client.callTool({ name: 'session_get', arguments: {
      session: ref(ids.root), childLimit: 1,
    } });
    assert.notEqual(first.isError, true);
    const cursor = first.structuredContent.result.childrenNextCursor;
    assert.ok(cursor);
    const removedId = [ids.alpha, ids.beta].find(id =>
      id !== first.structuredContent.result.children[0].session.sessionId);
    await rm(path.join(dir, 'dsh', 'sessions', 's2-synthetic', removedId,
      'session.v3.jsonl.zstd'));
    const stale = await client.callTool({ name: 'session_get', arguments: {
      session: ref(ids.root), childCursor: cursor,
    } });
    assert.equal(stale.isError, true, 'Cursor must reject a changed child source candidate set');
    assert.match(stale.content[0].text, /^source_changed: /);
  });

test('session_get previews 240 UTF-16 source units before truncation ellipsis',
  { timeout: 30_000 }, async t => {
    const { dir, args } = await setup(t, true);
    const source = path.join(dir, 'dsh', 'sessions', 's2-synthetic', ids.root,
      'session.v3.jsonl.zstd');
    const body = `${'🙂'.repeat(130)}${'A'.repeat(200)}`;
    const extra = { type: 'assistant/message', seq: 28, time: 1_780_000_000_029,
      surfaceOp: 'append', data: { turn: 2, step: 2, message: {
        id: 'root-emoji-last', role: 'assistant',
        source: { kind: 'model', provider: 'synthetic', model: 'fixture-only' },
        content: [{ type: 'text', text: body }],
      } } };
    await appendFile(source, zstdCompressSync(Buffer.from(`${JSON.stringify(extra)}\n`)));
    const client = new Client({ name: 'agentsession-v3-preview-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: binary,
      args: ['mcp', ...args], cwd: repo, stderr: 'pipe' }));
    t.after(async () => { await client.close(); });
    const response = await client.callTool({ name: 'session_get', arguments: {
      session: ref(ids.root),
    } });
    assert.notEqual(response.isError, true);
    const { firstMessage, lastMessage } = response.structuredContent.result;
    assert.equal(firstMessage.event.messageId, 'root-user');
    assert.equal(lastMessage.event.messageId, 'root-emoji-last');
    assert.equal(lastMessage.preview, `${'🙂'.repeat(120)}…`);
    assert.equal(lastMessage.preview.length, 241);
  });

test('stdio MCP errors retain frozen identifiers without source paths',
  { timeout: 30_000 }, async t => {
    const { args } = await setup(t);
    const client = new Client({ name: 'agentsession-v3-error-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: binary,
      args: ['mcp', ...args], cwd: repo, stderr: 'pipe' }));
    t.after(async () => { await client.close(); });
    const cases = [
      ['invalid_cursor', 'session_get', { session: ref(ids.root), childCursor: 'invalid-cursor' }],
      ['session_not_found', 'session_get', { session: ref('absent-canonical-session') }],
      ['invalid_session_ref', 'session_get', { session: { provider, sessionId: '' } }],
      ['provider_unavailable', 'session_get', { session: { provider: 'opencode', sessionId: 'absent' } }],
      ['event_not_found', 'session_get_event', { event: {
        ...ref(ids.root), messageId: 'absent-event', segment: 'message',
      } }],
      ['invalid_event_ref', 'session_get_event', { event: {
        ...ref(ids.root), messageId: 'root-user', segment: 'invalid',
      } }],
      ['invalid_input', 'session_get_event', { event: {
        ...ref(ids.root), messageId: 'root-user', segment: 'message',
      }, maxChars: 0 }],
    ];
    for (const [code, name, arguments_] of cases) {
      const response = await client.callTool({ name, arguments: arguments_ });
      assert.equal(response.isError, true, `${name} must fail for ${code}`);
      assert.equal(response.structuredContent, undefined);
      assert.match(response.content[0].text, new RegExp(`^${code}: `));
      assert.doesNotMatch(response.content[0].text, /v3-mcp-get-|session\.v3\.jsonl\.zstd|[A-Z]:\\\\/i);
    }
  });

test('stdio MCP provider errors do not expose local source paths',
  { timeout: 30_000 }, async t => {
    const { dir, args } = await setup(t, true);
    const source = path.join(dir, 'dsh', 'sessions', 's2-synthetic', ids.root,
      'session.v3.jsonl.zstd');
    await writeFile(source, 'invalid compressed source');
    const client = new Client({ name: 'agentsession-v3-source-error-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: binary,
      args: ['mcp', ...args], cwd: repo, stderr: 'pipe' }));
    t.after(async () => { await client.close(); });
    const response = await client.callTool({ name: 'session_get', arguments: {
      session: ref(ids.root),
    } });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /^provider_error: /);
    assert.doesNotMatch(response.content[0].text, /v3-mcp-get-|session\.v3\.jsonl\.zstd/);
  });
