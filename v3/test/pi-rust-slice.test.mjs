import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const provider = 'pi';
const currentId = '019f8a00-0000-7000-8000-000000000001';
const legacyId = '019f7b00-0000-7000-8000-000000000001';
const liveId = '019f7a93-2297-76db-827d-ee366e46482e';
const shortId = '22222222-3333-4444-8555-666666666666';
const longId = '11111111-2222-4333-8444-555555555555';
const longOutput = 'Pi output 🙂 '.repeat(100);
const event = (sessionId, messageId, segment) => ({ provider, sessionId, messageId, segment });
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');

async function fixture(t) {
  const dir = await mkdtemp(path.join(repo, 'tmp', 'v3-pi-slice-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  for (const name of ['pi/sessions/project', 'claude', 'codex', 'dsh', 'meta', 'index', 'cache']) {
    await mkdir(path.join(dir, name), { recursive: true });
  }
  const source = path.join(repo, 'test', 'fixtures');
  const current = path.join(dir, 'pi', 'sessions', 'project', `current_${currentId}.jsonl`);
  const legacy = path.join(dir, 'pi', 'sessions', 'project', `legacy_${legacyId}.jsonl`);
  const live = path.join(dir, 'pi', 'sessions', 'project', `live_${liveId}.jsonl`);
  await copyFile(path.join(source, 'pi-v3-current.jsonl'), current);
  await copyFile(path.join(source, 'pi-current.jsonl'), legacy);
  const frozen = path.join(repo, 'tmp', 'v3-corpus', 'pi', 'sessions', '--D--WorkSpace-OpenSession--',
    `2026-07-19T13-31-30-839Z_${liveId}.jsonl`);
  const liveAvailable = existsSync(frozen);
  if (liveAvailable) {
    await copyFile(frozen, live);
    assert.equal(digest(live), 'c6db5c9c105be0961721fef7f0f8f1b5d2458933bc48fc13302fd768e0c42c29');
  }
  const short = path.join(dir, 'pi', 'sessions', 'project', `short_${shortId}.jsonl`);
  await writeFile(short, [
    { type: 'session', version: 3, id: shortId, timestamp: '2026-09-27T00:00:00Z' },
    { type: 'message', id: 'short-user', parentId: null, timestamp: '2026-09-27T00:00:01Z',
      message: { role: 'user', content: 'Reply with PI_READY' } },
    { type: 'message', id: 'short-answer', parentId: 'short-user', timestamp: '2026-09-27T00:00:02Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'PI_READY' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const long = path.join(dir, 'pi', 'sessions', 'project', `long_${longId}.jsonl`);
  await writeFile(long, [
    { type: 'session', version: 3, id: longId, timestamp: '2026-09-27T00:00:00Z' },
    { type: 'message', id: 'long-user', parentId: null, timestamp: '2026-09-27T00:00:01Z',
      message: { role: 'user', content: 'Read a long result' } },
    { type: 'message', id: 'long-assistant', parentId: 'long-user', timestamp: '2026-09-27T00:00:02Z',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'long-call', name: 'read',
        arguments: { path: '/synthetic/long.txt' } }] } },
    { type: 'message', id: 'long-result', parentId: 'long-assistant', timestamp: '2026-09-27T00:00:03Z',
      message: { role: 'toolResult', toolCallId: 'long-call', content: [{ type: 'text', text: longOutput }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const args = [
    '--pi-dir', path.join(dir, 'pi'), '--codex-dir', path.join(dir, 'codex'),
    '--claude-dir', path.join(dir, 'claude'), '--opencode-db', path.join(dir, 'opencode.db'),
    '--dsh-dir', path.join(dir, 'dsh'), '--meta-dir', path.join(dir, 'meta'),
    '--index-dir', path.join(dir, 'index'), '--cache-dir', path.join(dir, 'cache'),
  ];
  const paths = liveAvailable ? [current, legacy, live, short] : [current, legacy, short];
  return { dir, args, paths, hashes: paths.map(digest), liveAvailable };
}

async function freePort() {
  return freeFetchSafePort();
}

async function web(t, args) {
  const port = await freePort();
  const child = spawn(binary, ['serve', '--port', String(port), ...args],
    { cwd: repo, windowsHide: true, stdio: 'ignore' });
  t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'close'); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${base}/api/providers`);
      if (response.ok) return { base, providers: await response.json() };
    } catch { /* Startup in progress. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Pi Web slice did not start');
}

test('Pi active branch, compact summaries, usage and simple turn reach Web Reader',
  { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    const { base, providers } = await web(t, f.args);
    assert.equal(providers.find(item => item.id === provider).available, true);
    const sessions = await (await fetch(`${base}/api/v3/sessions?provider=pi`)).json();
    assert.deepEqual(sessions.map(item => item.session.sessionId).sort(),
      [currentId, legacyId, shortId, longId, ...(f.liveAvailable ? [liveId] : [])].sort());
    assert.equal(sessions.find(item => item.session.sessionId === currentId).tokenCount, 60);
    assert.equal(sessions.find(item => item.session.sessionId === currentId).messageCount, 9);
    assert.equal(sessions.find(item => item.session.sessionId === currentId).parent?.sessionId,
      '019f8900-0000-7000-8000-000000000000');
    const response = await fetch(`${base}/api/v3/reader/pi/${currentId}/bootstrap`);
    assert.equal(response.status, 200);
    const bootstrap = await response.json();
    const items = bootstrap.segments.flatMap(segment => segment.items);
    assert.ok(items.some(item => item.event.messageId === 'branch1' && item.role === 'system'));
    assert.ok(items.some(item => item.event.messageId === 'compact1' && item.role === 'system'));
    assert.ok(items.some(item => item.event.messageId === 'asst0002' && item.event.segment === 'thinking'));
    assert.ok(items.some(item => item.event.messageId === 'custom0002' && item.role === 'system'));
    assert.ok(!items.some(item => ['asst0001', 'tool0001', 'custom0001', 'hidden0002'].includes(item.event.messageId)));
    const tool = items.find(item => item.event.messageId === 'call_read_2' && item.event.segment === 'tool');
    assert.equal(tool?.ownerMessageId, 'asst0002');
    const content = await fetch(`${base}/api/v3/reader/pi/${currentId}/content?` +
      new URLSearchParams({ messageId: 'compact1', segment: 'message', field: 'body',
        offset: '0', maxChars: '100', revision: bootstrap.revision }));
    assert.equal((await content.json()).text, 'Earlier Pi v3 work was compacted.');
    const shortReader = await (await fetch(`${base}/api/v3/reader/pi/${shortId}/bootstrap`)).json();
    const shortItems = shortReader.segments.flatMap(segment => segment.items);
    assert.deepEqual(shortItems.map(item => item.role), ['user', 'assistant']);
    assert.deepEqual(shortItems.map(item => item.preview),
      ['Reply with PI_READY', 'PI_READY']);
    if (f.liveAvailable) {
      const liveReader = await (await fetch(`${base}/api/v3/reader/pi/${liveId}/bootstrap`)).json();
      const liveItems = liveReader.segments.flatMap(segment => segment.items);
      assert.deepEqual(liveItems.map(item => item.preview),
        ['Reply with exactly WINDOWS_PI_READY.', 'WINDOWS_PI_READY']);
      assert.equal(liveReader.session.tokenCount, 4995);
    }
    await writeFile(path.join(f.dir, 'pi', 'sessions', 'project', 'bad.jsonl'),
      '{"type":"session","id":"bad"}\nnot-json{\n');
    const bad = await fetch(`${base}/api/v3/reader/pi/bad/bootstrap`);
    assert.equal(bad.status, 500);
    assert.equal((await bad.json()).error.code, 'source_error');
    assert.deepEqual(f.paths.map(digest), f.hashes);
  });

for (const era of ['legacy', 'modern']) {
  test(`Pi exact event, tool opt-in and long continuation reach ${era} stdio MCP`,
    { timeout: 30_000 }, async t => {
      const f = await fixture(t);
      const client = new Client({ name: 'pi-slice', version: '1.0.0' },
        era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
      await client.connect(new StdioClientTransport({ command: binary, args: ['mcp', ...f.args],
        cwd: repo, stderr: 'pipe' }));
      t.after(async () => { await client.close(); });
      const get = await client.callTool({ name: 'session_get', arguments: {
        session: { provider, sessionId: currentId },
      } });
      assert.notEqual(get.isError, true);
      assert.equal(get.structuredContent.result.session.sessionId, currentId);
      assert.equal(get.structuredContent.result.tokenCount, 60);
      const unexpandedThinking = await client.callTool({ name: 'session_get_event', arguments: {
        event: event(currentId, 'asst0002', 'thinking'),
      } });
      assert.equal(unexpandedThinking.isError, true);
      const thinking = await client.callTool({ name: 'session_get_event', arguments: {
        event: event(currentId, 'asst0002', 'thinking'), includeThinking: true,
      } });
      assert.equal(thinking.structuredContent.result.content.text, 'Gather evidence');
      const toolRef = event(currentId, 'call_read_2', 'tool');
      const hidden = await client.callTool({ name: 'session_get_event', arguments: { event: toolRef } });
      assert.equal(hidden.structuredContent.result.toolInput, null);
      assert.equal(hidden.structuredContent.result.toolOutput, null);
      const expanded = await client.callTool({ name: 'session_get_event', arguments: {
        event: toolRef, includeToolInput: true, includeToolOutput: true,
      } });
      assert.equal(expanded.structuredContent.result.toolInput.text, '{"path":"session-format.md"}');
      assert.equal(expanded.structuredContent.result.toolOutput.text,
        'Optional fields: usage, retainedTail, details, fromHook');
      let offset = 0;
      const parts = [];
      for (;;) {
        const page = await client.callTool({ name: 'session_get_event', arguments: {
          event: event(longId, 'long-call', 'tool'), includeToolOutput: true,
          offset, maxChars: 31,
        } });
        assert.notEqual(page.isError, true);
        const chunk = page.structuredContent.result.toolOutput;
        parts.push(chunk.text);
        if (chunk.nextOffset === null) break;
        assert.ok(chunk.nextOffset > offset);
        offset = chunk.nextOffset;
        assert.ok(parts.length < 100);
      }
      assert.equal(parts.join(''), longOutput);
      const absent = await client.callTool({ name: 'session_get_event', arguments: {
        event: event(currentId, 'asst0001', 'message'),
      } });
      assert.equal(absent.isError, true);
      assert.deepEqual(f.paths.map(digest), f.hashes);
    });
}
