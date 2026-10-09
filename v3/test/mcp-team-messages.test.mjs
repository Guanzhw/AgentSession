import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const fixture = path.join(repo, 'v3', 'fixtures', 'deepseek-harness');
const source = path.join(fixture, 'sessions', 's2-synthetic', 'dsh-v3-s2-root', 'session.v3.jsonl.zstd');
const sourceHash = createHash('sha256').update(readFileSync(source)).digest('hex');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const session = { provider: 'deepseek-harness', sessionId: 'dsh-v3-s2-root' };

async function start(t, dshRoot = fixture, era = 'legacy') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-team-mcp-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), sourceHash);
  });
  for (const name of ['codex', 'claude', 'pi', 'meta', 'index', 'cache']) {
    await mkdir(path.join(dir, name));
  }
  const client = new Client({ name: 'agentsession-team-test', version: '1.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  const args = ['mcp', '--codex-dir', path.join(dir, 'codex'), '--opencode-db', path.join(dir, 'opencode.db'),
    '--claude-dir', path.join(dir, 'claude'), '--pi-dir', path.join(dir, 'pi'), '--dsh-dir', dshRoot,
    '--meta-dir', path.join(dir, 'meta'), '--index-dir', path.join(dir, 'index'),
    '--cache-dir', path.join(dir, 'cache')];
  await client.connect(new StdioClientTransport({ command: binary, args, cwd: repo, stderr: 'pipe' }));
  t.after(async () => client.close());
  return { client, dir };
}

const call = (client, args) => client.callTool({ name: 'session_team_messages', arguments: args });
const result = response => {
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  assert.equal(response.structuredContent.untrustedContent, true);
  assert.ok(response.content[0].text.length < 200);
  return response.structuredContent.result;
};
const error = (response, code) => {
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, new RegExp(`^${code}:`));
};

for (const era of ['legacy', 'modern']) test(`native MCP lists owned queued messages and reads exact-revision UTF-16 pages over ${era} stdio`,
  { timeout: 30_000 }, async t => {
    const { client } = await start(t, fixture, era);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 7);
    const tool = tools.tools.find(row => row.name === 'session_team_messages');
    assert.ok(tool);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.deepEqual(tool.inputSchema.required, ['action']);
    const validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
    const messageRef = { ...session, sourceId: '15', messageId: 'mail-alpha-followup' };
    assert.equal(validate({ action: 'list' }).valid, false);
    assert.equal(validate({ action: 'read' }).valid, false);
    assert.equal(validate({ action: 'list', session }).valid, true);
    assert.equal(validate({ action: 'read', message: messageRef, revision: 'revision' }).valid, true);
    assert.equal(validate({ action: 'list', session, message: messageRef }).valid, false);
    assert.equal(validate({ action: 'read', message: messageRef, revision: 'revision', session }).valid, false);

    let cursor;
    const messages = [];
    let revision;
    do {
      const page = result(await call(client, { action: 'list', session, limit: 1, ...(cursor ? { cursor } : {}) }));
      assert.equal(page.session.sessionId, session.sessionId);
      assert.ok(page.messages.length <= 1);
      revision ??= page.revision;
      assert.equal(page.revision, revision);
      messages.push(...page.messages);
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(messages.map(row => row.message.messageId),
      ['mail-alpha-initial', 'mail-beta-initial', 'mail-alpha-followup', 'mail-alpha-return']);
    assert.deepEqual(messages.map(row => row.message.sourceId), ['8', '11', '15', '21']);
    assert.ok(messages.every(row => row.provenance.sourceType === 'dsh.session-event:team/message/queued'));
    assert.ok(messages.every(row => !JSON.stringify(row).includes('FINAL-ALPHA-FOLLOWUP-MARKER')));
    assert.equal(messages[0].fromParticipant.name, 'lead');
    assert.equal(messages[0].toParticipant.name, 'alpha');
    assert.deepEqual(messages[2].readArguments, {
      action: 'read', message: messages[2].message, revision,
    });

    const message = messages[2].message;
    let args = { ...messages[2].readArguments, maxChars: 5 };
    let text = '';
    do {
      const page = result(await call(client, args));
      assert.equal(page.message.messageId, message.messageId);
      assert.equal(page.revision, revision);
      assert.equal(page.content.offset, args.offset ?? 0);
      assert.equal(page.content.truncated, page.continuation !== null);
      text += page.content.text;
      args = page.continuation;
    } while (args);
    assert.match(text, /FINAL-ALPHA-FOLLOWUP-MARKER/);
    assert.ok(text.length > 100);

    const alpha = result(await call(client, { action: 'list', session: { ...session, sessionId: 'dsh-v3-s2-alpha' } }));
    error(await call(client, { action: 'read', message: { ...message, sessionId: 'dsh-v3-s2-alpha' }, revision: alpha.revision }), 'event_not_found');
    error(await call(client, { action: 'read', message: { ...message, messageId: 'wrong' }, revision }), 'event_not_found');
    error(await call(client, { action: 'read', message: { ...message, sourceId: '16' }, revision }), 'event_not_found');
    error(await call(client, { action: 'read', message, revision: 'stale' }), 'source_changed');
    error(await call(client, { action: 'list', session: { provider: 'codex', sessionId: 'anything' } }), 'content_unavailable');
    error(await call(client, { action: 'list', session: { provider: 'missing', sessionId: 'anything' } }), 'provider_unavailable');
    error(await call(client, { action: 'list', session: { ...session, sessionId: 'missing' } }), 'session_not_found');
    error(await call(client, { action: 'list', session, cursor: '{"wrong":true}' }), 'invalid_cursor');
    error(await call(client, { action: 'read', message, revision, cursor: 'extra' }), 'invalid_input');
  });

test('native queued-message cursors reject changed scope and source', { timeout: 30_000 }, async t => {
  const { client } = await start(t);
  const first = result(await call(client, { action: 'list', session, limit: 1 }));
  const local = await mkdtemp(path.join(os.tmpdir(), 'agentsession-team-source-'));
  t.after(async () => rm(local, { recursive: true, force: true }));
  await cp(fixture, local, { recursive: true });
  const { client: other } = await start(t, local);
  error(await call(other, { action: 'list', session, cursor: first.nextCursor }), 'invalid_cursor');
  error(await call(client, { action: 'list', session: { ...session, sessionId: 'dsh-v3-s2-alpha' }, cursor: first.nextCursor }), 'invalid_cursor');
  const copiedFirst = result(await call(other, { action: 'list', session, limit: 1 }));
  const copiedSource = path.join(local, 'sessions', 's2-synthetic', session.sessionId, 'session.v3.jsonl.zstd');
  const compressed = readFileSync(copiedSource);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const second = compressed.indexOf(magic, 4);
  assert.ok(second > 0, 'fixture has two independently compressed frames');
  const original = Buffer.concat([
    zstdDecompressSync(compressed.subarray(0, second)),
    zstdDecompressSync(compressed.subarray(second)),
  ]).toString('utf8');
  assert.match(original, /FINAL-ALPHA-FOLLOWUP-MARKER/);
  await writeFile(copiedSource, zstdCompressSync(Buffer.from(
    original.replace('FINAL-ALPHA-FOLLOWUP-MARKER', '😀FINAL-ALPHA-FOLLOWUP-MARKER'))));
  error(await call(other, { action: 'list', session, cursor: copiedFirst.nextCursor }), 'source_changed');
  const changed = result(await call(other, { action: 'list', session }));
  const message = changed.messages.find(row => row.message.messageId === 'mail-alpha-followup').message;
  let args = { action: 'read', message, revision: changed.revision, maxChars: 3 };
  let text = '';
  do {
    const page = result(await call(other, args));
    text += page.content.text;
    args = page.continuation;
  } while (args);
  assert.match(text, /😀FINAL-ALPHA-FOLLOWUP-MARKER/u);
  error(await call(other, { action: 'read', message, revision: copiedFirst.revision }), 'source_changed');
});
