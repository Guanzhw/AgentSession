import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const dsh = path.join(repo, 'v3', 'fixtures', 'deepseek-harness');
const sources = ['dsh-v3-s2-root', 'dsh-v3-s2-alpha', 'dsh-v3-s2-beta'].map(id =>
  path.join(dsh, 'sessions', 's2-synthetic', id, 'session.v3.jsonl.zstd'));
const sourceHashes = sources.map(file => createHash('sha256').update(readFileSync(file)).digest('hex'));
const session = { provider: 'deepseek-harness', sessionId: 'dsh-v3-s2-root' };

for (const era of ['legacy', 'modern']) test(`native MCP tools keep ${era} text summaries bounded`,
  { timeout: 30_000 }, async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-mcp-output-'));
    t.after(async () => {
      try {
        assert.deepEqual(sources.map(file => createHash('sha256').update(readFileSync(file)).digest('hex')),
          sourceHashes, 'provider source files remain read-only');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
    for (const name of ['codex', 'claude', 'pi', 'meta', 'index', 'cache']) {
      await mkdir(path.join(dir, name));
    }
    const args = ['mcp', '--codex-dir', path.join(dir, 'codex'),
      '--opencode-db', path.join(dir, 'opencode.db'), '--claude-dir', path.join(dir, 'claude'),
      '--pi-dir', path.join(dir, 'pi'), '--dsh-dir', dsh,
      '--meta-dir', path.join(dir, 'meta'), '--index-dir', path.join(dir, 'index'),
      '--cache-dir', path.join(dir, 'cache')];
    const client = new Client({ name: 'agentsession-v3-output-contract', version: '1.0.0' },
      era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
    await client.connect(new StdioClientTransport({ command: binary, args, cwd: repo, stderr: 'pipe' }));
    t.after(async () => client.close());
    assert.equal(client.getServerVersion()?.name, 'AgentSession-MCP');
    assert.equal(client.getServerVersion()?.version, '3.0.0');

    const calls = [
      ['session_browse', { level: 'providers' }],
      ['session_search', { query: 'synthetic', providers: ['deepseek-harness'], fields: ['title'] }],
      ['session_get', { session }],
      ['session_timeline', { session }],
      ['session_get_context', { event: { ...session, messageId: 'root-check', segment: 'tool' } }],
      ['session_get_event', { event: { ...session, messageId: 'root-user', segment: 'message' } }],
      ['session_team_messages', { action: 'list', session }],
    ];
    for (const [name, arguments_] of calls) {
      const response = await client.callTool({ name, arguments: arguments_ });
      assert.notEqual(response.isError, true, `${name}: ${response.content?.[0]?.text}`);
      assert.equal(response.structuredContent.untrustedContent, true, name);
      assert.ok(response.structuredContent.result, name);
      assert.equal(response.content.length, 1, name);
      assert.equal(response.content[0].type, 'text', name);
      assert.ok(response.content[0].text.length <= 200,
        `${name} text fallback duplicates the structured JSON (${response.content[0].text.length} chars)`);
    }
  });
