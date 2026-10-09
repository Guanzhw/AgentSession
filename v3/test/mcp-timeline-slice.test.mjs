import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const dshRoot = path.join(repo, 'v3', 'fixtures', 'deepseek-harness');
const codexCollaborationRoot = path.join(repo, 'v3', 'fixtures', 'codex-collaboration');
const codexCollaborationSource = path.join(codexCollaborationRoot, 'sessions', '2026', '09', '27',
  'rollout-2026-09-27T00-00-00-99999999-9999-4999-8999-999999999999.jsonl');
const codexCollaborationHash = createHash('sha256').update(readFileSync(codexCollaborationSource)).digest('hex');
const codexSource = path.join(repo, 'v3', 'fixtures', 'codex', 'sessions', '2026', '09', '26',
  'rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const rootId = 'dsh-v3-s2-root';
const dshRef = sessionId => ({ provider: 'deepseek-harness', sessionId });
const codexRef = { provider: 'codex', sessionId: '44444444-4444-4444-8444-444444444444' };
const sourceFiles = [rootId, 'dsh-v3-s2-alpha', 'dsh-v3-s2-beta'].map(id =>
  path.join(dshRoot, 'sessions', 's2-synthetic', id, 'session.v3.jsonl.zstd'));
const sourceHashes = sourceFiles.map(file => createHash('sha256').update(readFileSync(file)).digest('hex'));

async function setup(t, { copyDsh = false, codex = false } = {}) {
  assert.ok(existsSync(binary), `Build the Rust binary at ${binary}`);
  const dir = await mkdtemp(path.join(repo, 'tmp', 'v3-mcp-timeline-'));
  t.after(async () => {
    try {
      assert.deepEqual(sourceFiles.map(file => createHash('sha256').update(readFileSync(file)).digest('hex')),
        sourceHashes, 'MCP must leave public DSH source bytes unchanged');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  for (const name of ['codex', 'claude', 'pi', 'meta', 'index', 'cache']) {
    await mkdir(path.join(dir, name));
  }
  const configuredDshRoot = copyDsh ? path.join(dir, 'dsh') : dshRoot;
  if (copyDsh) await cp(dshRoot, configuredDshRoot, { recursive: true });
  if (codex) {
    const destination = path.join(dir, 'codex', 'sessions', '2026', '09', '26', path.basename(codexSource));
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(codexSource, destination);
    await appendFile(destination, `${JSON.stringify({ timestamp: '2026-09-26T00:00:06.000Z', ordinal: 7,
      type: 'response_item', payload: { type: 'reasoning', id: 'reasoning-1',
        summary: [{ type: 'summary_text', text: 'PRIVATE-THINKING-MARKER' }] } })}\n`);
  }
  return { dir, args: [
    '--codex-dir', path.join(dir, 'codex'), '--opencode-db', path.join(dir, 'opencode.db'),
    '--claude-dir', path.join(dir, 'claude'), '--pi-dir', path.join(dir, 'pi'),
    '--dsh-dir', configuredDshRoot, '--meta-dir', path.join(dir, 'meta'),
    '--index-dir', path.join(dir, 'index'), '--cache-dir', path.join(dir, 'cache'),
  ] };
}

async function connect(t, args, era = 'legacy') {
  const client = new Client({ name: 'agentsession-v3-timeline-test', version: '1.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  await client.connect(new StdioClientTransport({ command: binary, args: ['mcp', ...args],
    cwd: repo, stderr: 'pipe' }));
  t.after(async () => { await client.close(); });
  return client;
}

async function timeline(client, arguments_) {
  return client.callTool({ name: 'session_timeline', arguments: arguments_ });
}

for (const era of ['legacy', 'modern']) {
  test(`session_timeline rejects a cursor after its Codex source is deleted over ${era} MCP`,
    { timeout: 30_000 }, async t => {
      const { dir, args } = await setup(t, { codex: true });
      const client = await connect(t, args, era);
      const request = { session: codexRef, limit: 1 };
      const first = await timeline(client, request);
      assert.notEqual(first.isError, true, first.content?.[0]?.text);
      const cursor = first.structuredContent.result.nextCursor;
      assert.ok(cursor, 'Source has another page before deletion');
      const source = path.join(dir, 'codex', 'sessions', '2026', '09', '26',
        path.basename(codexSource));
      await rm(source);
      const stale = await timeline(client, { ...request, cursor });
      assert.equal(stale.isError, true);
      assert.match(stale.content[0].text, /^source_changed:/,
        'Removing the source invalidates an otherwise matching continuation');

      const fresh = await timeline(client, request);
      assert.equal(fresh.isError, true);
      assert.match(fresh.content[0].text, /^session_not_found:/);
      const session = await client.callTool({ name: 'session_get',
        arguments: { session: codexRef } });
      assert.equal(session.isError, true);
      assert.match(session.content[0].text, /^session_not_found:/);
      for (const changed of [
        { cursor: 'invalid-cursor' },
        { cursor, roles: ['user'] },
        { cursor, session: { ...codexRef, sessionId: 'missing-other-session' } },
      ]) {
        const invalid = await timeline(client, { ...request, ...changed });
        assert.equal(invalid.isError, true);
        assert.match(invalid.content[0].text, /^invalid_cursor:/);
      }
      const { args: otherArgs } = await setup(t);
      const otherClient = await connect(t, otherArgs, era);
      const wrongScope = await timeline(otherClient, { ...request, cursor });
      assert.equal(wrongScope.isError, true);
      assert.match(wrongScope.content[0].text, /^invalid_cursor:/);
    });
}

for (const era of ['legacy', 'modern']) {
  test(`session_timeline previews 240 UTF-16 source units before truncation ellipsis over ${era} MCP`,
    { timeout: 30_000 }, async t => {
      const { dir, args } = await setup(t, { copyDsh: true });
      const source = path.join(dir, 'dsh', 'sessions', 's2-synthetic', rootId,
        'session.v3.jsonl.zstd');
      const exact = `${'p'.repeat(239)}t`;
      const bodies = [exact, `${exact}after-preview`];
      const rows = bodies.map((body, index) => ({ type: 'assistant/message', seq: 28 + index,
        time: 1_780_000_000_029 + index, surfaceOp: 'append',
        data: { turn: 2, step: 2, message: {
          id: `root-prefix-${index}`, role: 'assistant',
          source: { kind: 'model', provider: 'synthetic', model: 'fixture-only' },
          content: [{ type: 'text', text: body }],
        } } }));
      await appendFile(source, zstdCompressSync(Buffer.from(
        `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)));
      const client = await connect(t, args, era);
      const response = await timeline(client, { session: dshRef(rootId),
        segments: ['message'], limit: 200 });
      assert.notEqual(response.isError, true, response.content?.[0]?.text);
      const events = response.structuredContent.result.events;
      assert.equal(events.find(row => row.event.messageId === 'root-prefix-0').preview, exact);
      const truncated = events.find(row => row.event.messageId === 'root-prefix-1');
      assert.equal(truncated.preview, `${exact}…`, 'The 240th source unit remains before ellipsis');
      assert.equal(truncated.preview.length, 241);
      const opened = await client.callTool({ name: 'session_get_event',
        arguments: { event: truncated.event, maxChars: 512 } });
      assert.notEqual(opened.isError, true);
      assert.equal(opened.structuredContent.result.content.text, bodies[1]);
    });
}

for (const era of ['legacy', 'modern']) {
  test(`session_timeline pages public DSH source and protects tool payload over ${era} stdio MCP`,
    { timeout: 30_000 }, async t => {
      const { args } = await setup(t);
      const client = await connect(t, args, era);
      const request = { session: dshRef(rootId), limit: 2 };
      const pages = [];
      let cursor;
      do {
        const response = await timeline(client, { ...request, ...(cursor ? { cursor } : {}) });
        assert.notEqual(response.isError, true);
        assert.equal(response.structuredContent.untrustedContent, true);
        const result = response.structuredContent.result;
        assert.equal(result.untrustedContent, true);
        assert.equal(result.truncated, result.nextCursor !== null);
        assert.ok(result.events.length <= 2);
        assert.ok(result.events.every(row => row.untrustedContent === true && row.preview.length <= 241));
        pages.push(result);
        cursor = result.nextCursor;
      } while (cursor);
      assert.deepEqual(pages.map(page => page.events.length), [2, 2, 1]);
      const events = pages.flatMap(page => page.events);
      assert.deepEqual(events.map(row => [row.event.messageId, row.event.segment]), [
        ['root-user', 'message'], ['root-dispatch', 'message'],
        ['root-continues', 'message'], ['root-check', 'tool'], ['root-final', 'message'],
      ]);
      assert.ok(events.every(row => row.event.provider === 'deepseek-harness' &&
        row.event.sessionId === rootId));
      assert.equal(events[3].toolName, 'read_marker');
      assert.equal(events[3].status, 'completed');
      assert.equal(events[3].preview, 'read_marker (completed)');
      assert.doesNotMatch(JSON.stringify(events[3]), /SYNTHETIC-MARKER-OK|\/synthetic\/marker\.txt/);
      const detail = await client.callTool({ name: 'session_get_event',
        arguments: { event: events[3].event } });
      assert.notEqual(detail.isError, true);
      assert.equal(detail.structuredContent.result.status, events[3].status,
        'Tool detail must retain the status shown in the timeline');

      const toolName = await timeline(client, { session: dshRef(rootId),
        segments: ['tool'], toolNames: ['read_marker'], query: 'read_marker' });
      assert.notEqual(toolName.isError, true);
      assert.deepEqual(toolName.structuredContent.result.events.map(row => row.event.messageId), ['root-check']);
      const outputQuery = await timeline(client, { session: dshRef(rootId), query: 'SYNTHETIC-MARKER-OK' });
      assert.notEqual(outputQuery.isError, true);
      assert.deepEqual(outputQuery.structuredContent.result.events, [], 'Tool output is not searchable');
      const inputQuery = await timeline(client, { session: dshRef(rootId), query: '/synthetic/marker.txt' });
      assert.notEqual(inputQuery.isError, true);
      assert.deepEqual(inputQuery.structuredContent.result.events, [], 'Tool input is not searchable');
      const roleFilter = await timeline(client, { session: dshRef(rootId), roles: ['user'] });
      assert.deepEqual(roleFilter.structuredContent.result.events.map(row => row.event.messageId), ['root-user']);
      const statusFilter = await timeline(client, { session: dshRef(rootId), statuses: ['error'] });
      assert.deepEqual(statusFilter.structuredContent.result.events, []);
      const completed = await timeline(client, { session: dshRef(rootId), statuses: ['completed'] });
      assert.deepEqual(completed.structuredContent.result.events.map(row => row.event.messageId), ['root-check']);
      const messageQuery = await timeline(client, { session: dshRef(rootId),
        segments: ['message'], query: 'returned facts' });
      assert.deepEqual(messageQuery.structuredContent.result.events.map(row => row.event.messageId), ['root-final']);

      const changedFilter = await timeline(client, { ...request, cursor: pages[0].nextCursor,
        roles: ['assistant'] });
      assert.equal(changedFilter.isError, true, 'Cursor must bind to effective filters');
      const changedSession = await timeline(client, { ...request, cursor: pages[0].nextCursor,
        session: dshRef('dsh-v3-s2-alpha') });
      assert.equal(changedSession.isError, true, 'Cursor must bind to canonical session');
      const invalid = await timeline(client, { ...request, cursor: 'invalid-cursor' });
      assert.equal(invalid.isError, true);
      const tooLarge = await timeline(client, { ...request, limit: 201 });
      assert.notEqual(tooLarge.isError, true);
      assert.equal(tooLarge.structuredContent.result.events.length, 5,
        'valid oversized limit is capped to the timeline hard maximum');
      const resized = await timeline(client, { ...request, limit: 3, cursor: pages[0].nextCursor });
      assert.notEqual(resized.isError, true, 'Page size is not part of cursor identity');
      assert.deepEqual(resized.structuredContent.result.events.map(row => row.event.messageId),
        ['root-continues', 'root-check', 'root-final']);

      const { args: otherArgs } = await setup(t);
      const otherClient = await connect(t, otherArgs);
      const wrongScope = await timeline(otherClient, { ...request, cursor: pages[0].nextCursor });
      assert.equal(wrongScope.isError, true, 'Cursor must bind to configured source scope');
    });
}

test('session_timeline requires explicit thinking selection and rejects changed source revision',
  { timeout: 30_000 }, async t => {
    const { dir, args } = await setup(t, { copyDsh: true, codex: true });
    const client = await connect(t, args);
    const defaultCodex = await timeline(client, { session: codexRef });
    assert.notEqual(defaultCodex.isError, true);
    assert.ok(defaultCodex.structuredContent.result.events.every(row => row.event.segment !== 'thinking'));
    assert.doesNotMatch(JSON.stringify(defaultCodex.structuredContent), /PRIVATE-THINKING-MARKER/);
    const thinkingQuery = await timeline(client, { session: codexRef, query: 'PRIVATE-THINKING-MARKER' });
    assert.deepEqual(thinkingQuery.structuredContent.result.events, []);
    const optedIn = await timeline(client, { session: codexRef, segments: ['thinking'] });
    assert.notEqual(optedIn.isError, true);
    assert.deepEqual(optedIn.structuredContent.result.events.map(row => row.event.messageId), ['reasoning-1']);
    assert.match(optedIn.structuredContent.result.events[0].preview, /PRIVATE-THINKING-MARKER/);
    const tool = defaultCodex.structuredContent.result.events.find(row => row.event.segment === 'tool');
    assert.ok(tool);
    assert.equal(tool.status, 'unknown', 'Codex source has no recorded tool-result status');
    const toolDetail = await client.callTool({ name: 'session_get_event',
      arguments: { event: tool.event } });
    assert.equal(toolDetail.structuredContent.result.status, tool.status);
    assert.doesNotMatch(JSON.stringify(tool), /ok|synthetic\/example\.txt/);

    const first = await timeline(client, { session: dshRef(rootId), limit: 2 });
    assert.notEqual(first.isError, true);
    const cursor = first.structuredContent.result.nextCursor;
    assert.ok(cursor);
    const source = path.join(dir, 'dsh', 'sessions', 's2-synthetic', rootId, 'session.v3.jsonl.zstd');
    const blankAssistant = { type: 'assistant/message', seq: 28, time: 1_780_000_000_029,
      surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'root-blank',
        role: 'assistant', source: { kind: 'model', provider: 'synthetic', model: 'fixture-only' },
        content: [{ type: 'text', text: '  ' }] } } };
    await appendFile(source, zstdCompressSync(Buffer.from(`${JSON.stringify(blankAssistant)}\n`)));
    const stale = await timeline(client, { session: dshRef(rootId), limit: 2, cursor });
    assert.equal(stale.isError, true, 'Cursor must reject a changed source revision');
    const refreshed = await timeline(client, { session: dshRef(rootId) });
    assert.notEqual(refreshed.isError, true);
    assert.deepEqual(refreshed.structuredContent.result.events.map(row => row.event.messageId),
      ['root-user', 'root-dispatch', 'root-continues', 'root-check', 'root-final'],
      'Whitespace-only assistant content does not create a message segment');
    const errorCall = { type: 'tool/call', seq: 29, time: 1_780_000_000_030,
      data: { turn: 2, step: 1, callId: 'root-error-check', name: 'read_error_marker',
        arguments: { path: '/private/error-marker.txt' } } };
    const errorResult = { type: 'tool/result', seq: 30, time: 1_780_000_000_031,
      surfaceOp: 'append', data: { turn: 2, step: 1, message: {
        id: 'root-error-result', role: 'user', source: { kind: 'tool', callId: 'root-error-check' },
        content: [{ type: 'tool-result', toolCallId: 'root-error-check',
          content: [{ type: 'text', text: 'PRIVATE-ERROR-OUTPUT' }], isError: true }],
      } } };
    await appendFile(source, zstdCompressSync(Buffer.from(`${JSON.stringify(errorCall)}\n${JSON.stringify(errorResult)}\n`)));
    const errors = await timeline(client, { session: dshRef(rootId), statuses: ['error'] });
    assert.notEqual(errors.isError, true);
    assert.deepEqual(errors.structuredContent.result.events.map(row => row.event.messageId), ['root-error-check']);
    assert.equal(errors.structuredContent.result.events[0].preview, 'read_error_marker (error)');
    assert.doesNotMatch(JSON.stringify(errors.structuredContent), /PRIVATE-ERROR-OUTPUT|private\/error-marker\.txt/);
    const toolNames = ['read_marker', 'read_error_marker',
      ...Array.from({ length: 48 }, (_, index) => `unused-${index}-${'x'.repeat(180)}`)];
    const firstTool = await timeline(client, { session: dshRef(rootId), toolNames, limit: 1 });
    assert.notEqual(firstTool.isError, true);
    assert.ok(firstTool.structuredContent.result.nextCursor.length <= 4000);
    const lastTool = await timeline(client, { session: dshRef(rootId), toolNames, limit: 1,
      cursor: firstTool.structuredContent.result.nextCursor });
    assert.notEqual(lastTool.isError, true);
    assert.deepEqual(lastTool.structuredContent.result.events.map(row => row.event.messageId),
      ['root-error-check']);
  });

test('session_timeline assistant filter includes a recorded Codex agent reply by exact MCP event ref',
  { timeout: 30_000 }, async t => {
    const { args } = await setup(t);
    args[args.indexOf('--codex-dir') + 1] = codexCollaborationRoot;
    t.after(() => assert.equal(createHash('sha256').update(readFileSync(codexCollaborationSource)).digest('hex'),
      codexCollaborationHash, 'MCP must leave the public Codex collaboration fixture unchanged'));
    const client = await connect(t, args);
    const search = await client.callTool({ name: 'session_search', arguments: {
      query: 'actionable issue', providers: ['codex'], fields: ['assistant'],
    } });
    assert.notEqual(search.isError, true, search.content?.[0]?.text);
    assert.deepEqual(search.structuredContent.result.matches.map(row => row.event), [{ provider: 'codex',
      sessionId: '99999999-9999-4999-8999-999999999999', messageId: 'agent-result', segment: 'message' }]);
    const [match] = search.structuredContent.result.matches;
    assert.equal(match.matchRole, 'agent');

    const page = await timeline(client, { session: {
      provider: match.event.provider, sessionId: match.event.sessionId,
    }, roles: ['assistant'], query: 'actionable issue' });
    assert.notEqual(page.isError, true, page.content?.[0]?.text);
    const [row] = page.structuredContent.result.events;
    assert.deepEqual(row.event, match.event, 'timeline should preserve the canonical search event ref');
    assert.equal(row.role, 'agent', 'assistant filtering must preserve the recorded agent role');

    const detail = await client.callTool({ name: 'session_get_event', arguments: { event: row.event } });
    assert.notEqual(detail.isError, true, detail.content?.[0]?.text);
    assert.deepEqual(detail.structuredContent.result.event, match.event);
    assert.equal(detail.structuredContent.result.role, 'agent');
    assert.match(detail.structuredContent.result.content.text, /actionable issue/);
  });

test('session_timeline defaults to 50 and caps explicit pages at the configured size',
  { timeout: 30_000 }, async t => {
    const { dir, args } = await setup(t, { copyDsh: true });
    const source = path.join(dir, 'dsh', 'sessions', 's2-synthetic', rootId, 'session.v3.jsonl.zstd');
    const rows = Array.from({ length: 200 }, (_, index) => {
      const seq = 28 + index;
      return { type: 'assistant/message', seq, time: 1_780_000_000_000 + seq + 1,
        surfaceOp: 'append', data: { turn: 2, step: 1, message: {
          id: `extra-${index}`, role: 'assistant',
          source: { kind: 'model', provider: 'synthetic', model: 'fixture-only' },
          content: [{ type: 'text', text: `Extra source message ${index}` }],
        } } };
    });
    await appendFile(source, zstdCompressSync(Buffer.from(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`)));
    const client = await connect(t, args);
    const defaultPage = await timeline(client, { session: dshRef(rootId) });
    assert.notEqual(defaultPage.isError, true);
    assert.equal(defaultPage.structuredContent.result.events.length, 50);
    assert.equal(defaultPage.structuredContent.result.truncated, true);
    const maximum = await timeline(client, { session: dshRef(rootId), limit: 200 });
    assert.notEqual(maximum.isError, true);
    assert.equal(maximum.structuredContent.result.events.length, 50);
    assert.deepEqual(maximum.structuredContent.result.events.slice(0, 5).map(row => row.event.messageId),
      ['root-user', 'root-dispatch', 'root-continues', 'root-check', 'root-final']);
    const pages = [maximum.structuredContent.result];
    let cursor = pages[0].nextCursor;
    while (cursor) {
      const response = await timeline(client, { session: dshRef(rootId), limit: 200, cursor });
      assert.notEqual(response.isError, true);
      pages.push(response.structuredContent.result);
      cursor = response.structuredContent.result.nextCursor;
    }
    assert.deepEqual(pages.map(page => page.events.length), [50, 50, 50, 50, 5]);
    assert.deepEqual(pages.at(-1).events.map(row => row.event.messageId),
      ['extra-195', 'extra-196', 'extra-197', 'extra-198', 'extra-199']);
  });
