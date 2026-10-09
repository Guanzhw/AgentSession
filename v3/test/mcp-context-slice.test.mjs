import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const fixture = path.join(repo, 'v3', 'fixtures');
const dsh = path.join(fixture, 'deepseek-harness');
const codex = path.join(fixture, 'codex');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const sourceFiles = ['dsh-v3-s2-root', 'dsh-v3-s2-alpha', 'dsh-v3-s2-beta'].map(id =>
  path.join(dsh, 'sessions', 's2-synthetic', id, 'session.v3.jsonl.zstd'));
const sourceHashes = sourceFiles.map(file => createHash('sha256').update(readFileSync(file)).digest('hex'));
const root = { provider: 'deepseek-harness', sessionId: 'dsh-v3-s2-root' };
const codexRef = { provider: 'codex', sessionId: '44444444-4444-4444-8444-444444444444' };

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-context-'));
  t.after(async () => {
    try {
      assert.deepEqual(sourceFiles.map(file => createHash('sha256').update(readFileSync(file)).digest('hex')),
        sourceHashes, 'provider source bytes remain unchanged');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  for (const name of ['codex', 'claude', 'pi', 'meta', 'index', 'cache']) await mkdir(path.join(dir, name));
  await cp(codex, path.join(dir, 'codex'), { recursive: true });
  const args = ['mcp', '--codex-dir', path.join(dir, 'codex'), '--opencode-db', path.join(dir, 'opencode.db'),
    '--claude-dir', path.join(dir, 'claude'), '--pi-dir', path.join(dir, 'pi'), '--dsh-dir', dsh,
    '--meta-dir', path.join(dir, 'meta'), '--index-dir', path.join(dir, 'index'),
    '--cache-dir', path.join(dir, 'cache')];
  return { dir, args };
}

async function connect(t, args, era) {
  const client = new Client({ name: 'agentsession-v3-context-test', version: '1.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  await client.connect(new StdioClientTransport({ command: binary, args, cwd: repo, stderr: 'pipe' }));
  t.after(async () => client.close());
  return client;
}

for (const era of ['legacy', 'modern']) {
  test(`session_get_context returns bounded source-order neighbors over ${era} stdio`,
    { timeout: 30_000 }, async t => {
      const { args } = await setup(t);
      const client = await connect(t, args, era);
      const event = { ...root, messageId: 'root-check', segment: 'tool' };
      const response = await client.callTool({ name: 'session_get_context', arguments: {
        event, before: 2, after: 1,
      } });
      assert.notEqual(response.isError, true, response.content?.[0]?.text);
      assert.equal(response.structuredContent.untrustedContent, true);
      const result = response.structuredContent.result;
      assert.deepEqual(result.target, event);
      assert.equal(result.untrustedContent, true);
      assert.deepEqual(result.events.map(row => row.event.messageId),
        ['root-dispatch', 'root-continues', 'root-check', 'root-final']);
      assert.ok(result.events.every(row => row.preview.length <= 241 && row.untrustedContent === true));
      assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC-MARKER-OK|\/synthetic\/marker\.txt/,
        'context must not disclose tool input or output');
      const zero = await client.callTool({ name: 'session_get_context', arguments: {
        event, before: 0, after: 0,
      } });
      assert.deepEqual(zero.structuredContent.result.events.map(row => row.event.messageId), ['root-check']);
      const missing = await client.callTool({ name: 'session_get_context', arguments: {
        event: { ...event, messageId: 'absent' },
      } });
      assert.equal(missing.isError, true);
      assert.match(missing.content[0].text, /^event_not_found: /);
      const tooWide = await client.callTool({ name: 'session_get_context', arguments: {
        event, before: 21,
      } });
      assert.notEqual(tooWide.isError, true);
      assert.deepEqual(tooWide.structuredContent.result.events.map(row => row.event.messageId),
        ['root-user', 'root-dispatch', 'root-continues', 'root-check', 'root-final'],
        'valid oversized context window is capped to the hard maximum');
    });
}

test('session_get_context requires thinking opt-in and filters nearby thinking by default',
  { timeout: 30_000 }, async t => {
    const { dir, args } = await setup(t);
    const source = path.join(dir, 'codex', 'sessions', '2026', '09', '26',
      'rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl');
    await appendFile(source, `${JSON.stringify({ timestamp: '2026-09-26T00:00:06.000Z', ordinal: 7,
      type: 'response_item', payload: { type: 'reasoning', id: 'reasoning-1',
        summary: [{ type: 'summary_text', text: 'PRIVATE-CONTEXT-THINKING' }] } })}\n`);
    const client = await connect(t, args, 'legacy');
    const thinking = { ...codexRef, messageId: 'reasoning-1', segment: 'thinking' };
    const denied = await client.callTool({ name: 'session_get_context', arguments: { event: thinking } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /^thinking_opt_in_required: /);
    const opted = await client.callTool({ name: 'session_get_context', arguments: {
      event: thinking, includeThinking: true, before: 0, after: 0,
    } });
    assert.notEqual(opted.isError, true, opted.content?.[0]?.text);
    assert.deepEqual(opted.structuredContent.result.events.map(row => row.event), [thinking]);
    assert.match(opted.structuredContent.result.events[0].preview, /PRIVATE-CONTEXT-THINKING/);
    const prior = { ...codexRef, messageId: 'tool-call-1', segment: 'tool' };
    const defaultContext = await client.callTool({ name: 'session_get_context', arguments: {
      event: prior, before: 0, after: 20,
    } });
    assert.notEqual(defaultContext.isError, true, defaultContext.content?.[0]?.text);
    assert.doesNotMatch(JSON.stringify(defaultContext.structuredContent), /PRIVATE-CONTEXT-THINKING/);
  });
