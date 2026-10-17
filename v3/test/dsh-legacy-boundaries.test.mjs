import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const fixture = path.join(repo, 'test', 'fixtures', 'dsh-rc8-fresh-round-trip.jsonl');
const provider = 'deepseek-harness';

async function freePort() {
  return freeFetchSafePort();
}

async function json(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url}: ${response.status}`);
  return response.json();
}

test('rc.8 Reader/search and healthy inventory survive torn tails and mixed encoding',
  { timeout: 30_000, skip: !existsSync(binary) }, async t => {
    const state = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-dsh-boundaries-'));
    const dsh = path.join(state, 'dsh');
    const sessions = path.join(dsh, 'sessions');
    for (const name of ['codex', 'claude', 'pi', 'meta', 'index', 'cache',
      path.join('dsh', 'sessions', 'rc8-public'),
      path.join('dsh', 'sessions', 'healthy'),
      path.join('dsh', 'sessions', 'torn-v3'),
      path.join('dsh', 'sessions', 'mixed')]) {
      await mkdir(path.join(state, name), { recursive: true });
    }
    const rc8 = readFileSync(fixture, 'utf8').replaceAll('{{sessionId}}', 'rc8-public')
      .replaceAll('{{cwd}}', 'C:');
    await writeFile(path.join(sessions, 'rc8-public', 'session.jsonl'), `${rc8}{"type":`);
    const v3 = id => `${JSON.stringify({ type: 'session', version: 3, id, createdAt: 1,
      isSeeded: false })}\n${JSON.stringify({ type: 'user/message', seq: 0, time: 2,
      surfaceOp: 'append', data: { id: 'u', source: { kind: 'user' },
        content: [{ type: 'text', text: 'healthy source' }] } })}\n`;
    await writeFile(path.join(sessions, 'healthy', 'session.v3.jsonl'), v3('healthy'));
    const complete = zstdCompressSync(v3('torn-v3'));
    const final = zstdCompressSync('uncommitted\n');
    await writeFile(path.join(sessions, 'torn-v3', 'session.v3.jsonl.zstd'),
      Buffer.concat([complete, final.subarray(0, final.length - 2)]));
    await writeFile(path.join(sessions, 'mixed', 'session.jsonl'),
      `${JSON.stringify({ type: 'session', version: 0, id: 'mixed', createdAt: 1 })}\n`);
    await writeFile(path.join(sessions, 'mixed', 'session.v3.jsonl.zstd'),
      zstdCompressSync(v3('mixed')));
    const args = ['--codex-dir', path.join(state, 'codex'),
      '--opencode-db', path.join(state, 'opencode.db'),
      '--claude-dir', path.join(state, 'claude'), '--pi-dir', path.join(state, 'pi'),
      '--dsh-dir', dsh, '--meta-dir', path.join(state, 'meta'),
      '--index-dir', path.join(state, 'index'), '--cache-dir', path.join(state, 'cache')];
    const port = await freePort();
    const child = spawn(binary, ['serve', '--port', String(port), ...args],
      { cwd: repo, windowsHide: true, stdio: 'ignore' });
    let client;
    t.after(async () => {
      try {
        await client?.close();
        child.kill();
        if (child.exitCode === null) await once(child, 'close');
      } finally {
        await rm(state, { recursive: true, force: true });
      }
    });
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`${origin}/api/providers`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { ready = true; break; }
      } catch { /* The source catalog may still be publishing. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready);
    const listed = await json(`${origin}/api/v3/sessions?provider=${provider}`);
    assert.deepEqual(listed.map(row => row.session.sessionId).sort(), ['healthy', 'mixed', 'rc8-public', 'torn-v3']);
    assert.equal(listed.find(row => row.session.sessionId === 'mixed')?.diagnostic,
      'dsh_mixed_source_encodings');
    const rc8Reader = await json(`${origin}/api/v3/reader/${provider}/rc8-public/bootstrap`);
    assert.equal(rc8Reader.session.messageCount, 5);
    assert.ok(rc8Reader.segments.flatMap(page => page.items).some(item =>
      item.event.messageId === 'assistant:91' && item.preview === 'DONE'));
    const resultText = await json(`${origin}/api/v3/reader/${provider}/rc8-public/content?${new URLSearchParams({
      messageId: 'tool-result:57:0', segment: 'tool', field: 'toolOutput', offset: '0',
      maxChars: '100', revision: rc8Reader.revision,
    })}`);
    assert.equal(resultText.text, 'WEB_E2E_OK\n');
    const namedToolText = await json(`${origin}/api/v3/reader/${provider}/rc8-public/content?${new URLSearchParams({
      messageId: 'call_00_BYXlxjFaalMg95YVqEeF2495', segment: 'tool', field: 'toolOutput',
      offset: '0', maxChars: '100', revision: rc8Reader.revision,
    })}`);
    assert.equal(namedToolText.text, 'WEB_E2E_OK\n');
    const tornReader = await json(`${origin}/api/v3/reader/${provider}/torn-v3/bootstrap`);
    assert.equal(tornReader.session.messageCount, 1);
    const ambiguous = await fetch(`${origin}/api/v3/reader/${provider}/mixed/bootstrap`);
    assert.notEqual(ambiguous.status, 200, 'The mixed source has a direct diagnostic');
    const search = await json(`${origin}/api/v3/search?q=bash&provider=${provider}&fields=toolName`);
    assert.ok(search.matches.some(row => row.session?.sessionId === 'rc8-public'
      && row.event?.messageId === 'call_00_BYXlxjFaalMg95YVqEeF2495'));
    const tornSearch = await json(`${origin}/api/v3/search?q=healthy%20source&provider=${provider}&fields=user`);
    assert.ok(tornSearch.matches.some(row => row.session?.sessionId === 'torn-v3'));

    client = new Client({ name: 'agentsession-v3-dsh-boundary-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: binary,
      args: ['mcp', ...args], cwd: repo, stderr: 'pipe' }));
    const get = await client.callTool({ name: 'session_get', arguments: {
      session: { provider, sessionId: 'rc8-public' },
    } });
    assert.notEqual(get.isError, true);
    assert.equal(get.structuredContent.result.messageCount, 5);
    assert.equal(get.structuredContent.result.firstMessage.event.messageId, 'user:1');
    assert.equal(get.structuredContent.result.lastMessage.event.messageId, 'assistant:91');
    const toolResult = await client.callTool({ name: 'session_get_event', arguments: {
      event: { provider, sessionId: 'rc8-public', messageId: 'tool-result:57:0', segment: 'tool' },
      includeToolOutput: true, offset: 0, maxChars: 100,
    } });
    assert.notEqual(toolResult.isError, true);
    assert.equal(toolResult.structuredContent.result.toolOutput.text, 'WEB_E2E_OK\n');
    const namedTool = await client.callTool({ name: 'session_get_event', arguments: {
      event: { provider, sessionId: 'rc8-public',
        messageId: 'call_00_BYXlxjFaalMg95YVqEeF2495', segment: 'tool' },
      includeToolOutput: true, offset: 0, maxChars: 100,
    } });
    assert.notEqual(namedTool.isError, true);
    assert.equal(namedTool.structuredContent.result.status, 'completed');
    assert.equal(namedTool.structuredContent.result.toolOutput.text, 'WEB_E2E_OK\n');
    const completedBash = await client.callTool({ name: 'session_timeline', arguments: {
      session: { provider, sessionId: 'rc8-public' }, segments: ['tool'],
      toolNames: ['bash'], statuses: ['completed'],
    } });
    assert.notEqual(completedBash.isError, true);
    assert.deepEqual(completedBash.structuredContent.result.events.map(row => row.event.messageId),
      ['call_00_BYXlxjFaalMg95YVqEeF2495']);
    const result = await client.callTool({ name: 'session_search', arguments: {
      query: 'bash', providers: [provider], fields: ['toolName'],
    } });
    assert.notEqual(result.isError, true);
    assert.ok(result.structuredContent.result.matches.some(row =>
      row.session?.sessionId === 'rc8-public'));
  });
