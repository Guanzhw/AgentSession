import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const fixtureRoot = path.join(repo, 'v3', 'fixtures', 'codex');
const fixtureFile = path.join(fixtureRoot, 'sessions', '2026', '09', '26',
  'rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl');
const sessionId = '44444444-4444-4444-8444-444444444444';
const assistantBody = 'Hello 🙂 from the Rust slice. Continue to the complete ending.';
const frozenV2McpTools = JSON.parse(readFileSync(path.join(repo, 'test', 'fixtures', 'v3-mcp-tools-v2.json'), 'utf8')).tools;
const frozenMcpTools = JSON.parse(readFileSync(path.join(repo, 'test', 'fixtures', 'v3-mcp-tools-v3.json'), 'utf8')).tools;
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const sha256 = value => createHash('sha256').update(value).digest('hex');

function assertMcpV2Compatibility(tools) {
  const legacyNames = frozenV2McpTools.map(tool => tool.name);
  assert.deepEqual(tools.map(tool => tool.name), [...legacyNames, 'session_team_messages']);

  const timeline = tools.find(tool => tool.name === 'session_timeline');
  assert.equal(timeline.inputSchema.properties.segments.maxItems, 4);
  assert.deepEqual(timeline.inputSchema.properties.segments.items.enum,
    [...frozenV2McpTools.find(tool => tool.name === 'session_timeline').inputSchema.properties.segments.items.enum,
      'context']);

  for (const name of ['session_get_context', 'session_get_event']) {
    const oldTool = frozenV2McpTools.find(tool => tool.name === name);
    const tool = tools.find(candidate => candidate.name === name);
    assert.deepEqual(tool.inputSchema.properties.event.properties.segment.enum,
      [...oldTool.inputSchema.properties.event.properties.segment.enum, 'context']);
  }

  const event = tools.find(tool => tool.name === 'session_get_event');
  assert.deepEqual(event.inputSchema.properties.revision, { minLength: 1, type: 'string' });
  assert.equal(event.inputSchema.required.includes('revision'), false);

  const restoredLegacySchema = structuredClone(tools.slice(0, 6));
  const restoredTimeline = restoredLegacySchema.find(tool => tool.name === 'session_timeline');
  restoredTimeline.inputSchema.properties.segments.maxItems = 3;
  restoredTimeline.inputSchema.properties.segments.items.enum.pop();
  for (const name of ['session_get_context', 'session_get_event']) {
    restoredLegacySchema.find(tool => tool.name === name)
      .inputSchema.properties.event.properties.segment.enum.pop();
  }
  delete restoredLegacySchema.find(tool => tool.name === 'session_get_event')
    .inputSchema.properties.revision;
  assert.deepEqual(restoredLegacySchema, frozenV2McpTools,
    'the five declared input extensions are the only differences from the actual v2 snapshot');
}

async function freePort() {
  return freeFetchSafePort();
}

async function setup(t) {
  assert.ok(existsSync(binary), `Build the S2 Rust binary at ${binary}`);
  const dir = await mkdtemp(path.join(repo, 'tmp', 'v3-slice-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  for (const name of ['meta', 'index', 'cache', 'opencode', 'claude', 'pi', 'dsh']) {
    await mkdir(path.join(dir, name));
  }
  const args = [
    '--codex-dir', fixtureRoot,
    '--opencode-db', path.join(dir, 'opencode', 'opencode.db'),
    '--claude-dir', path.join(dir, 'claude'),
    '--pi-dir', path.join(dir, 'pi'),
    '--dsh-dir', path.join(dir, 'dsh'),
    '--meta-dir', path.join(dir, 'meta'),
    '--index-dir', path.join(dir, 'index'),
    '--cache-dir', path.join(dir, 'cache'),
  ];
  return { dir, args, sourceSha256: sha256(readFileSync(fixtureFile)) };
}

async function awaitProviders(port, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('S2 Web binary exited before readiness');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/providers`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response.json();
    } catch { /* The process may still be starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('S2 Web binary did not become ready');
}

test('Codex source reaches Axum Reader with canonical refs and complete UTF-16 content', { timeout: 30_000 }, async t => {
  const setupResult = await setup(t);
  const port = await freePort();
  const child = spawn(binary, ['serve', '--port', String(port), ...setupResult.args],
    { cwd: repo, windowsHide: true, stdio: 'ignore' });
  t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'close'); });
  const providers = await awaitProviders(port, child);
  assert.deepEqual(providers.map(row => row.id), ['opencode', 'claude-code', 'codex', 'pi', 'deepseek-harness']);
  for (const provider of providers) {
    assert.deepEqual(Object.keys(provider).sort(), [
      'id', 'name', 'icon', 'available', 'manageable', 'storageDiagnostic', 'protocolCapabilities',
    ].sort());
  }
  assert.equal(providers.find(row => row.id === 'codex').available, true);

  const origin = `http://127.0.0.1:${port}`;
  const bootstrapResponse = await fetch(`${origin}/api/v3/reader/codex/${sessionId}/bootstrap`);
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  assert.deepEqual(bootstrap.session.session, { provider: 'codex', sessionId });
  assert.ok(typeof bootstrap.revision === 'string' && bootstrap.revision.length > 0);
  const items = bootstrap.segments.flatMap(segment => segment.items);
  assert.ok(items.some(item => item.event.messageId === 'user-1' && item.role === 'user'));
  assert.ok(!items.some(item => item.event.messageId === 'injected-1'),
    'Background context must not become an owned user request');
  assert.match(bootstrap.session.title, /^Show the complete response/);
  assert.ok(items.some(item => item.event.messageId === 'assistant-1' && item.role === 'assistant'));

  const parts = [];
  let offset = 0;
  for (;;) {
    const params = new URLSearchParams({ messageId: 'assistant-1', segment: 'message', field: 'body',
      offset: String(offset), maxChars: '8', revision: bootstrap.revision });
    const response = await fetch(`${origin}/api/v3/reader/codex/${sessionId}/content?${params}`);
    assert.equal(response.status, 200);
    const content = await response.json();
    assert.equal(content.offset, offset);
    assert.equal(content.totalChars, assistantBody.length);
    parts.push(content.text);
    if (content.nextOffset === null) {
      assert.equal(content.truncated, false);
      break;
    }
    assert.equal(content.truncated, true);
    assert.ok(content.nextOffset > offset);
    offset = content.nextOffset;
    assert.ok(parts.length < 30);
  }
  assert.equal(parts.join(''), assistantBody);
  const tool = items.find(item => item.role === 'tool' && item.event.messageId === 'tool-call-1');
  assert.ok(tool, 'The assistant tool call must retain its canonical call ID');
  assert.equal(tool.ownerMessageId, 'assistant-1');
  for (const [field, expected] of [
    ['toolInput', '{"path":"/synthetic/example.txt"}'],
    ['toolOutput', '{"ok":true}'],
  ]) {
    const params = new URLSearchParams({ messageId: tool.event.messageId, segment: 'tool',
      field, offset: '0', maxChars: '100', revision: bootstrap.revision });
    const response = await fetch(`${origin}/api/v3/reader/codex/${sessionId}/content?${params}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).text, expected);
  }
  const oversizedOffset = new URLSearchParams({ messageId: 'assistant-1', segment: 'message',
    field: 'body', offset: '9223372036854775808', maxChars: '1', revision: bootstrap.revision });
  const oversized = await fetch(`${origin}/api/v3/reader/codex/${sessionId}/content?${oversizedOffset}`);
  assert.equal(oversized.status, 400, 'An offset outside SQLite integer range is an invalid request');
  assert.equal((await oversized.json()).error.code, 'invalid_request');
  const missing = await fetch(`${origin}/api/v3/reader/codex/99999999-9999-4999-8999-999999999999/bootstrap`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'session_not_found');
  assert.equal(sha256(readFileSync(fixtureFile)), setupResult.sourceSha256);
});

for (const era of ['legacy', 'modern']) {
  test(`Codex source reaches ${era} native stdio MCP from the same core`, { timeout: 30_000 }, async t => {
    const setupResult = await setup(t);
    const client = new Client({ name: 'agentsession-v3-slice-test', version: '1.0.0' },
      era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
    const transport = new StdioClientTransport({ command: binary, args: ['mcp', ...setupResult.args],
      cwd: repo, stderr: 'pipe' });
    await client.connect(transport);
    t.after(async () => { await client.close(); });
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 7);
    assertMcpV2Compatibility(tools.tools);
    assert.deepEqual(tools.tools.slice(0, 6).map(tool => tool.name), [
      'session_browse', 'session_search', 'session_get', 'session_timeline', 'session_get_context', 'session_get_event',
    ]);
    assert.deepEqual(tools.tools.slice(0, 6).map(({ name, annotations, inputSchema, outputSchema }) =>
      ({ name, annotations, inputSchema, outputSchema })), frozenMcpTools);
    const result = await client.callTool({ name: 'session_get_event', arguments: {
      event: { provider: 'codex', sessionId, messageId: 'assistant-1', segment: 'message' }, maxChars: 8,
    } });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.result.content.text, 'Hello 🙂');
    assert.equal(result.structuredContent.result.content.offset, 0);
    assert.equal(result.structuredContent.result.content.totalChars, assistantBody.length);
    assert.equal(result.structuredContent.result.content.nextOffset, 8);
    assert.equal(result.structuredContent.result.content.truncated, true);
    assert.equal(result.structuredContent.result.content.untrustedContent, true);
    assert.ok(typeof result.structuredContent.result.revision === 'string');
    assert.deepEqual(result.structuredContent.result.continuation, {
      event: { provider: 'codex', sessionId, messageId: 'assistant-1', segment: 'message' },
      revision: result.structuredContent.result.revision, offset: 8, maxChars: 8,
    });
    const { revision: continuationRevision, ...v2Continuation } = result.structuredContent.result.continuation;
    assert.equal(continuationRevision, result.structuredContent.result.revision);
    assert.deepEqual(v2Continuation, {
      event: { provider: 'codex', sessionId, messageId: 'assistant-1', segment: 'message' },
      offset: 8, maxChars: 8,
    });
    const legacyContinuationResult = await client.callTool({
      name: 'session_get_event', arguments: v2Continuation,
    });
    assert.notEqual(legacyContinuationResult.isError, true);
    assert.equal(legacyContinuationResult.structuredContent.result.content.offset, 8);
    assert.equal(legacyContinuationResult.structuredContent.result.content.text, assistantBody.slice(8, 16));
    assert.equal(legacyContinuationResult.structuredContent.result.content.totalChars, assistantBody.length);
    const toolEvent = { provider: 'codex', sessionId, messageId: 'tool-call-1', segment: 'tool' };
    const toolDefault = await client.callTool({ name: 'session_get_event', arguments: { event: toolEvent } });
    assert.notEqual(toolDefault.isError, true);
    assert.equal(toolDefault.structuredContent.result.toolInput, null);
    assert.equal(toolDefault.structuredContent.result.toolOutput, null);
    const toolExpanded = await client.callTool({ name: 'session_get_event', arguments: {
      event: toolEvent, includeToolInput: true, includeToolOutput: true,
    } });
    assert.notEqual(toolExpanded.isError, true);
    assert.equal(toolExpanded.structuredContent.result.toolInput.text, '{"path":"/synthetic/example.txt"}');
    assert.equal(toolExpanded.structuredContent.result.toolOutput.text, '{"ok":true}');
    const absent = await client.callTool({ name: 'session_get_event', arguments: {
      event: { provider: 'codex', sessionId, messageId: 'absent-event', segment: 'message' },
    } });
    assert.equal(absent.isError, true);
    assert.equal(absent.structuredContent, undefined);
    assert.equal(sha256(readFileSync(fixtureFile)), setupResult.sourceSha256);
  });
}
