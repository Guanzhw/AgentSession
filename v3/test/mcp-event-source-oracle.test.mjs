import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const sessionId = 'a1111111-1111-4111-8111-111111111111';
const sourceName = `rollout-2026-09-28T00-00-00-${sessionId}.jsonl`;
const hash = value => createHash('sha256').update(value).digest('hex');
const frozenManifest = path.join(repo, 'tmp', 'v3-corpus', 'manifest.private.json');

async function fixture(t) {
  assert.ok(existsSync(binary), `Build the Rust binary at ${binary}`);
  const root = await mkdtemp(path.join(repo, 'tmp', 'v3-mcp-event-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']
    .map(name => [name, path.join(root, name)]));
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
  const source = path.join(dirs.codex, 'sessions', '2026', '09', '28', sourceName);
  await mkdir(path.dirname(source), { recursive: true });
  const records = [
    { type: 'session_meta', payload: { id: sessionId, cwd: '/public/example' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'multi-block',
      content: [
        { type: 'output_text', text: 'First 🙂 block. ' },
        { type: 'output_text', text: 'Second block '.repeat(35) + '尾段' },
      ] } },
    { type: 'response_item', payload: { type: 'reasoning', id: 'reasoning-block',
      summary: [{ type: 'summary_text', text: 'Private reasoning sample. '.repeat(5) }] } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'long-tool',
      name: 'exec_command', arguments: '{"cmd":"public example"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'long-tool',
      output: 'tool 🙂 payload\n'.repeat(240) + '工具末尾' } },
  ];
  await writeFile(source, records.map(JSON.stringify).join('\n') + '\n');
  const sourceBytes = readFileSync(source);
  const sourceSha256 = hash(sourceBytes);
  const raw = sourceBytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  const assistant = raw[1].payload;
  const toolCall = raw[3].payload;
  const toolResult = raw[4].payload;
  assert.equal(raw[0].payload.id, sessionId);
  assert.equal(assistant.content.length, 2);
  assert.equal(toolCall.call_id, toolResult.call_id);
  return {
    args: ['--codex-dir', dirs.codex, '--opencode-db', path.join(root, 'opencode.db'),
      '--claude-dir', dirs.claude, '--pi-dir', dirs.pi, '--dsh-dir', dirs.dsh,
      '--meta-dir', dirs.meta, '--index-dir', dirs.index, '--cache-dir', dirs.cache],
    source, sourceSha256,
    assistantBody: assistant.content.map(block => block.text).join(''),
    thinkingBody: raw[2].payload.summary.map(block => block.text).join(''),
    toolInput: toolCall.arguments, toolOutput: toolResult.output,
  };
}

async function readPages(client, event, field, expected, initialOptions = {}, maxChars = 37) {
  let request = { event, offset: 0, maxChars, ...initialOptions };
  let offset = 0;
  let body = '';
  let pages = 0;
  let revision;
  while (request) {
    const response = await client.callTool({ name: 'session_get_event', arguments: request });
    assert.notEqual(response.isError, true, response.content?.[0]?.text);
    assert.equal(response.structuredContent.untrustedContent, true);
    const result = response.structuredContent.result;
    assert.ok(typeof result.revision === 'string' && result.revision.length > 0);
    revision ??= result.revision;
    assert.equal(result.revision, revision);
    assert.deepEqual(result.event, event);
    assert.equal(result.role, event.segment === 'tool' ? 'tool' : 'assistant');
    assert.equal(result.untrustedContent, true);
    const content = result[field];
    assert.equal(content.untrustedContent, true);
    assert.equal(content.offset, offset);
    assert.equal(content.totalChars, expected.length);
    assert.ok(content.text.length > 0 && content.text.length <= request.maxChars);
    body += content.text;
    offset += content.text.length;
    const next = field === 'content' ? result.continuation : result.continuations.toolOutput;
    assert.equal(content.nextOffset, next?.offset ?? null);
    assert.equal(content.truncated, Boolean(next));
    if (next) {
      assert.deepEqual(next.event, event);
      assert.equal(next.revision, revision);
      assert.equal(next.maxChars, request.maxChars);
      assert.deepEqual(next.includeToolOutput, request.includeToolOutput);
      assert.deepEqual(next.includeThinking, request.includeThinking);
      assert.equal(next.offset, offset);
    }
    request = next;
    assert.ok(++pages < 200, 'continuation must terminate');
  }
  assert.equal(offset, expected.length, 'UTF-16 length matches raw source');
  assert.equal(hash(body), hash(expected), 'ordered complete body matches raw source SHA-256');
  return pages;
}

test('frozen Codex long tool output matches its paired source record',
  { timeout: 60_000, skip: !existsSync(frozenManifest) &&
    process.env.AGENTSESSION_V3_REAL_CORPUS_REQUIRED !== '1' }, async t => {
    assert.ok(existsSync(frozenManifest), 'The required frozen corpus manifest is missing');
    assert.ok(existsSync(binary), `Build the Rust binary at ${binary}`);
    const manifest = JSON.parse(readFileSync(frozenManifest, 'utf8'));
    const frozen = manifest.files.find(file => file.provider === 'codex' &&
      file.role === 'long-team-compaction');
    assert.ok(frozen?.snapshotPath && frozen.snapshotSha256);
    const sourceBytes = readFileSync(frozen.snapshotPath);
    assert.equal(hash(sourceBytes), frozen.snapshotSha256);
    const lines = sourceBytes.toString('utf8').split(/\r?\n/);
    const call = JSON.parse(lines[482]).payload;
    const output = JSON.parse(lines[484]).payload;
    assert.equal(call.type, 'function_call');
    assert.equal(output.type, 'function_call_output');
    assert.equal(call.call_id, output.call_id, 'source call owns this output');
    assert.equal(call.name, 'list_agents');
    assert.equal(output.output.length, 10_577);
    assert.equal(hash(output.output),
      '8018e48fc89ab3e07790a9de804e0da943a21e1679faab02f5936e7db730cd1a');
    const event = { provider: 'codex', sessionId: frozen.sessionId,
      messageId: call.call_id, segment: 'tool' };
    const state = await mkdtemp(path.join(repo, 'tmp', 'v3-mcp-frozen-tool-'));
    t.after(() => rm(state, { recursive: true, force: true }));
    const dirs = Object.fromEntries(['claude', 'pi', 'dsh', 'meta', 'index', 'cache']
      .map(name => [name, path.join(state, name)]));
    await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
    const args = ['mcp', '--codex-dir', manifest.providerRoots.codex.path,
      '--opencode-db', path.join(state, 'opencode.db'), '--claude-dir', dirs.claude,
      '--pi-dir', dirs.pi, '--dsh-dir', dirs.dsh, '--meta-dir', dirs.meta,
      '--index-dir', dirs.index, '--cache-dir', dirs.cache];
    const client = new Client({ name: 'agentsession-v3-frozen-tool-oracle', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: binary, args,
      cwd: repo, stderr: 'pipe' }));
    t.after(async () => client.close());
    const hidden = await client.callTool({ name: 'session_get_event', arguments: { event } });
    assert.notEqual(hidden.isError, true, hidden.content?.[0]?.text);
    assert.equal(hidden.structuredContent.result.toolName, call.name);
    assert.equal(hidden.structuredContent.result.toolOutput, null);
    const pages = await readPages(client, event, 'toolOutput', output.output,
      { includeToolOutput: true }, 521);
    assert.ok(pages > 1);
    assert.equal(hash(readFileSync(frozen.snapshotPath)), frozen.snapshotSha256,
      'frozen provider source revision is unchanged after MCP reads');
    t.diagnostic(`frozen source ${frozen.snapshotSha256}; tool ${pages} pages/${hash(output.output)}`);
  });

for (const era of ['legacy', 'modern']) {
  test(`session_get_event continuation rejects a rewritten ${era} Codex source`,
    { timeout: 30_000 }, async t => {
      const sample = await fixture(t);
      const client = new Client({ name: 'agentsession-v3-event-revision', version: '1.0.0' },
        era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
      await client.connect(new StdioClientTransport({ command: binary,
        args: ['mcp', ...sample.args], cwd: repo, stderr: 'pipe' }));
      t.after(async () => client.close());
      const event = { provider: 'codex', sessionId, messageId: 'multi-block', segment: 'message' };
      const first = await client.callTool({ name: 'session_get_event', arguments: {
        event, maxChars: 8,
      } });
      assert.notEqual(first.isError, true, first.content?.[0]?.text);
      const { revision, continuation } = first.structuredContent.result;
      assert.ok(typeof revision === 'string' && revision.length > 0);
      assert.equal(continuation.revision, revision);
      const source = readFileSync(sample.source, 'utf8');
      await writeFile(sample.source, source.replace('First 🙂 block.', 'Changed 🙂 text.'));
      const stale = await client.callTool({ name: 'session_get_event', arguments: continuation });
      assert.equal(stale.isError, true);
      assert.match(stale.content[0].text, /^source_changed: /);
      const direct = await client.callTool({ name: 'session_get_event', arguments: {
        event, offset: continuation.offset, maxChars: continuation.maxChars,
      } });
      assert.notEqual(direct.isError, true, direct.content?.[0]?.text);
      assert.notEqual(direct.structuredContent.result.revision, revision);
    });

  test(`source-backed multi-block and long tool event over ${era} stdio MCP`,
    { timeout: 30_000 }, async t => {
      const sample = await fixture(t);
      const client = new Client({ name: 'agentsession-v3-event-source-oracle', version: '1.0.0' },
        era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
      await client.connect(new StdioClientTransport({ command: binary,
        args: ['mcp', ...sample.args], cwd: repo, stderr: 'pipe' }));
      t.after(async () => client.close());
      const message = { provider: 'codex', sessionId, messageId: 'multi-block', segment: 'message' };
      const tool = { provider: 'codex', sessionId, messageId: 'long-tool', segment: 'tool' };
      const thinking = { provider: 'codex', sessionId,
        messageId: 'reasoning-block', segment: 'thinking' };

      const messagePages = await readPages(client, message, 'content', sample.assistantBody);
      assert.ok(messagePages > 1);
      const denied = await client.callTool({ name: 'session_get_event', arguments: { event: thinking } });
      assert.equal(denied.isError, true);
      assert.match(denied.content[0].text, /^thinking_opt_in_required: /);
      const allowed = await client.callTool({ name: 'session_get_event', arguments: {
        event: thinking, includeThinking: true,
      } });
      assert.notEqual(allowed.isError, true);
      assert.equal(allowed.structuredContent.result.content.text, sample.thinkingBody);
      const thinkingPages = await readPages(client, thinking, 'content', sample.thinkingBody,
        { includeThinking: true }, 19);
      assert.ok(thinkingPages > 1);

      const hidden = await client.callTool({ name: 'session_get_event', arguments: { event: tool } });
      assert.notEqual(hidden.isError, true);
      assert.equal(hidden.structuredContent.result.toolInput, null);
      assert.equal(hidden.structuredContent.result.toolOutput, null);
      const inputOnly = await client.callTool({ name: 'session_get_event', arguments: {
        event: tool, includeToolInput: true,
      } });
      assert.equal(inputOnly.structuredContent.result.toolInput.text, sample.toolInput);
      assert.equal(inputOnly.structuredContent.result.toolOutput, null);
      const toolPages = await readPages(client, tool, 'toolOutput', sample.toolOutput,
        { includeToolOutput: true });
      assert.ok(toolPages > 1);
      assert.equal(hash(readFileSync(sample.source)), sample.sourceSha256,
        'provider source revision is unchanged after all stdio reads');
      t.diagnostic(`source ${sample.sourceSha256}; message ${messagePages} pages/${hash(sample.assistantBody)}; ` +
        `tool ${toolPages} pages/${hash(sample.toolOutput)}`);
    });
}
