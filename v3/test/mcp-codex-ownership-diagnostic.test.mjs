import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = path.resolve(import.meta.dirname, '../..');
const fixture = path.join(repo, 'v3/fixtures/codex-owned-search.jsonl');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const sessionId = '55555555-5555-4555-8555-555555555555';
const event = { provider: 'codex', sessionId, messageId: 'owned-reply', segment: 'message' };

async function configFor(root, source, { duplicate = false } = {}) {
  const codex = path.join(root, 'codex');
  const sessions = path.join(codex, 'sessions', '2026', '09', '27');
  await Promise.all(['claude', 'pi', 'dsh', 'meta', 'index', 'cache'].map(name =>
    mkdir(path.join(root, name), { recursive: true })));
  await mkdir(sessions, { recursive: true });
  const filename = `rollout-2026-09-27T00-00-00-${sessionId}.jsonl`;
  await writeFile(path.join(sessions, filename), source);
  if (duplicate) await writeFile(path.join(sessions, `copy-${filename}`), source);
  return ['mcp', '--codex-dir', codex, '--opencode-db', path.join(root, 'opencode.db'),
    '--claude-dir', path.join(root, 'claude'), '--pi-dir', path.join(root, 'pi'),
    '--dsh-dir', path.join(root, 'dsh'), '--meta-dir', path.join(root, 'meta'),
    '--index-dir', path.join(root, 'index'), '--cache-dir', path.join(root, 'cache')];
}

async function connect(t, args) {
  const client = new Client({ name: 'agentsession-v3-codex-ownership-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: binary, args, cwd: repo, stderr: 'pipe' }));
  t.after(async () => client.close());
  return client;
}

test('Codex copied-parent boundary failure keeps its protocol diagnostic over native MCP stdio',
  { timeout: 60_000 }, async t => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-mcp06-ownership-'));
    t.after(async () => rm(work, { recursive: true, force: true }));
    const fixtureText = await readFile(fixture, 'utf8');
    const missingBoundary = fixtureText.split(/\r?\n/)
      .filter(line => !line.includes('"agent_message"')).join('\n');

    const healthyArgs = await configFor(path.join(work, 'healthy'), fixtureText);
    const healthy = await connect(t, healthyArgs);
    const accepted = await healthy.callTool({ name: 'session_get_context', arguments: { event } });
    assert.notEqual(accepted.isError, true, accepted.content?.[0]?.text);
    assert.equal(accepted.structuredContent.untrustedContent, true);
    assert.deepEqual(accepted.structuredContent.result.target, event);
    assert.ok(accepted.structuredContent.result.events.some(row => row.event.messageId === 'owned-reply'));
    assert.doesNotMatch(JSON.stringify(accepted.structuredContent), /Inherited 中 and 39% belong to parent/);

    const blockedArgs = await configFor(path.join(work, 'missing-boundary'), missingBoundary);
    const blockedClient = await connect(t, blockedArgs);
    const blocked = await blockedClient.callTool({ name: 'session_get_context', arguments: { event } });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /^protocol_error: /);
    assert.match(blocked.content[0].text,
      new RegExp(`child_ownership_boundary_unavailable: codex/${sessionId}`));
    assert.doesNotMatch(JSON.stringify(blocked), /Inherited 中 and 39% belong to parent|Owned reply says 中文/);

    const collisionArgs = await configFor(path.join(work, 'collision'), fixtureText, { duplicate: true });
    const collisionClient = await connect(t, collisionArgs);
    const collision = await collisionClient.callTool({ name: 'session_get_context', arguments: { event } });
    assert.equal(collision.isError, true);
    assert.match(collision.content[0].text, /^protocol_error: /);
    assert.match(collision.content[0].text,
      new RegExp(`codex_multiple_source_files_unmerged: codex/${sessionId}`));
  });
