import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { decodeSourceBytes } from '../../scripts/v3-source-ledger.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const dshRoot = path.join(repo, 'tmp', 'v3-corpus', 'deepseek-harness');
const id = '18a1f7f5-78d3-4e64-96d8-8e50b54d7f56';
const source = path.join(dshRoot, 'sessions', '--D-WorkSpace-OpenSession--', id, 'session.jsonl.zstd');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const hash = () => createHash('sha256').update(readFileSync(source)).digest('hex');

async function freePort() {
  return freeFetchSafePort();
}

async function fetchJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url}: ${response.status}`);
  return response.json();
}

test('frozen DSH v0 reaches Web Reader and stdio MCP search without source writes',
  { timeout: 30_000, skip: !existsSync(source) || !existsSync(binary) }, async t => {
    const sourceHash = hash();
    const state = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-dsh-v0-'));
    for (const name of ['codex', 'claude', 'pi', 'meta', 'index', 'cache']) {
      await mkdir(path.join(state, name));
    }
    const args = [
      '--codex-dir', path.join(state, 'codex'),
      '--opencode-db', path.join(state, 'opencode.db'),
      '--claude-dir', path.join(state, 'claude'),
      '--pi-dir', path.join(state, 'pi'),
      '--dsh-dir', dshRoot,
      '--meta-dir', path.join(state, 'meta'),
      '--index-dir', path.join(state, 'index'),
      '--cache-dir', path.join(state, 'cache'),
    ];
    const port = await freePort();
    const child = spawn(binary, ['serve', '--port', String(port), ...args],
      { cwd: repo, windowsHide: true, stdio: 'ignore' });
    let client;
    t.after(async () => {
      try {
        await client?.close();
        child.kill();
        if (child.exitCode === null) await once(child, 'close');
        assert.equal(hash(), sourceHash, 'Frozen DSH source bytes remain unchanged');
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
      } catch { /* Indexing may still be running. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Frozen DSH Web process becomes ready');

    const sessions = await fetchJson(`${origin}/api/v3/sessions?provider=deepseek-harness`);
    assert.equal(sessions.length, 2);
    const legacy = sessions.find(row => row.session.sessionId === id);
    assert.ok(legacy);
    assert.equal(legacy.title, 'Check parent-only marker visibility');
    assert.equal(legacy.directory, 'D:\\WorkSpace\\OpenSession');
    assert.equal(legacy.updatedAt, 1788176072133);
    const raw = decodeSourceBytes(readFileSync(source)).records.map(row => row.value);
    const owned = raw.filter(row => row.type === 'assistant/message'
      && row.seq >= raw[0].seedLength && row.data?.usage);
    assert.equal(owned.length, 1);
    const settlement = owned[0];
    const usage = settlement.data.usage;
    const knownSubset = usage.inputTokens + usage.cacheReadTokens + usage.outputTokens;
    assert.equal(knownSubset, 13362, 'Every recorded category is preserved');
    assert.equal(usage.cacheWriteTokens, undefined);
    assert.equal(usage.totalTokens, undefined);
    assert.equal(legacy.tokenCount, null, 'The absent independent cache-write category prevents a complete total');
    const protocol = await fetchJson(`${origin}/api/v3/protocol/deepseek-harness/${id}?version=3`);
    assert.equal(protocol.coverage.usage.state, 'observed');
    assert.deepEqual(protocol.usageRecords.map(row => ({ id: row.id, eventId: row.eventId,
      timestamp: row.timestamp, model: row.model, tokens: row.tokens })), [{
      id: `usage:dsh:${id}:${settlement.seq}`,
      eventId: `event:dsh:${settlement.seq}`,
      timestamp: settlement.time,
      model: settlement.data.message.source.model,
      tokens: { input: usage.inputTokens, cacheRead: usage.cacheReadTokens,
        cacheWrite: null, output: usage.outputTokens - usage.reasoningTokens,
        reasoning: usage.reasoningTokens, total: null },
    }]);
    const reader = await fetchJson(`${origin}/api/v3/reader/deepseek-harness/${id}/bootstrap`);
    assert.equal(reader.session.messageCount, 2);
    const items = reader.segments.flatMap(page => page.items);
    assert.deepEqual(items.filter(item => item.event.segment === 'message').map(item => item.role),
      ['user', 'assistant']);
    assert.ok(!items.some(item => item.toolName === 'read'));

    const title = await fetchJson(`${origin}/api/v3/search?q=parent-only%20marker%20visibility&provider=deepseek-harness&fields=title`);
    assert.ok(title.matches.some(row => row.session?.sessionId === id));
    const tools = await fetchJson(`${origin}/api/v3/search?q=read&provider=deepseek-harness&fields=toolName`);
    assert.ok(!tools.matches.some(row => row.session?.sessionId === id));

    client = new Client({ name: 'agentsession-v3-frozen-dsh-v0', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: binary,
      args: ['mcp', ...args], cwd: repo, stderr: 'pipe' }));
    const result = await client.callTool({ name: 'session_search', arguments: {
      query: 'read', providers: ['deepseek-harness'], fields: ['toolName'],
    } });
    assert.notEqual(result.isError, true);
    assert.ok(!result.structuredContent.result.matches.some(row => row.session?.sessionId === id));
  });
