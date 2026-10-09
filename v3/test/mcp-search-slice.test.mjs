import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const dsh = path.join(repo, 'v3', 'fixtures', 'deepseek-harness');
const ids = ['dsh-v3-s2-root', 'dsh-v3-s2-alpha', 'dsh-v3-s2-beta'];
const sources = ids.map(id => path.join(dsh, 'sessions', 's2-synthetic', id, 'session.v3.jsonl.zstd'));
const hashes = sources.map(file => createHash('sha256').update(readFileSync(file)).digest('hex'));
const collaborationRoot = path.join(repo, 'v3', 'fixtures', 'codex-collaboration');
const collaborationId = '99999999-9999-4999-8999-999999999999';
const collaborationSource = path.join(collaborationRoot, 'sessions', '2026', '09', '27',
  `rollout-2026-09-27T00-00-00-${collaborationId}.jsonl`);
const collaborationHash = createHash('sha256').update(readFileSync(collaborationSource)).digest('hex');

async function connect(t, era, codexRoot) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-search-'));
  t.after(async () => {
    try {
      assert.deepEqual(sources.map(file => createHash('sha256').update(readFileSync(file)).digest('hex')),
        hashes, 'provider source bytes remain unchanged');
      assert.equal(createHash('sha256').update(readFileSync(collaborationSource)).digest('hex'),
        collaborationHash, 'recorded Codex collaboration bytes remain unchanged');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  for (const name of ['codex', 'claude', 'pi', 'meta', 'index', 'cache']) await mkdir(path.join(dir, name));
  const args = ['mcp', '--codex-dir', path.join(dir, 'codex'), '--opencode-db', path.join(dir, 'opencode.db'),
    '--claude-dir', path.join(dir, 'claude'), '--pi-dir', path.join(dir, 'pi'), '--dsh-dir', dsh,
    '--meta-dir', path.join(dir, 'meta'), '--index-dir', path.join(dir, 'index'),
    '--cache-dir', path.join(dir, 'cache')];
  if (codexRoot) args[args.indexOf('--codex-dir') + 1] = codexRoot;
  const client = new Client({ name: 'agentsession-v3-search-test', version: '1.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  await client.connect(new StdioClientTransport({ command: binary, args, cwd: repo, stderr: 'pipe' }));
  t.after(async () => client.close());
  return client;
}

async function search(client, arguments_) {
  const response = await client.callTool({ name: 'session_search', arguments: arguments_ });
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  assert.equal(response.structuredContent.untrustedContent, true);
  assert.equal(response.structuredContent.result.untrustedContent, true);
  return response.structuredContent.result;
}

for (const era of ['legacy', 'modern']) {
  test(`session_search finds the recorded Codex agent return over ${era} stdio`,
    { timeout: 30_000 }, async t => {
      const client = await connect(t, era, collaborationRoot);
      const result = await search(client, { query: 'actionable issue',
        providers: ['codex'], fields: ['assistant'] });
      assert.deepEqual(result.matches.map(row => row.event), [{ provider: 'codex',
        sessionId: collaborationId, messageId: 'agent-result', segment: 'message' }]);
      assert.equal(result.matches[0].matchRole, 'agent');
    });

  test(`session_search keeps the ${era} text fallback concise while retaining structured matches`,
    { timeout: 30_000 }, async t => {
      const client = await connect(t, era);
      const response = await client.callTool({ name: 'session_search', arguments: {
        query: 'synthetic', providers: ['deepseek-harness'], fields: ['title'], limit: 3,
      } });
      assert.notEqual(response.isError, true);
      assert.equal(response.structuredContent.result.matches.length, 3);
      assert.equal(response.content.length, 1);
      assert.equal(response.content[0].type, 'text');
      assert.match(response.content[0].text, /3/);
      assert.ok(response.content[0].text.length <= 200,
        'Text fallback should summarize the result, not duplicate structuredContent');
    });

  test(`session_search returns precise message and tool-name refs over ${era} stdio`,
    { timeout: 30_000 }, async t => {
      const client = await connect(t, era);
      const message = await search(client, { query: 'returned facts',
        providers: ['deepseek-harness'], fields: ['assistant'] });
      assert.deepEqual(message.matches.map(row => row.event), [{
        provider: 'deepseek-harness', sessionId: ids[0], messageId: 'root-final', segment: 'message',
      }]);
      assert.equal(message.matches[0].matchField, 'message');
      assert.equal(message.matches[0].matchRole, 'assistant');
      assert.match(message.matches[0].snippet, /returned facts/i);
      assert.ok(message.matches[0].snippet.length <= 240);
      const tool = await search(client, { query: 'read_marker',
        providers: ['deepseek-harness'], fields: ['toolName'] });
      assert.deepEqual(tool.matches.map(row => row.event), [{
        provider: 'deepseek-harness', sessionId: ids[0], messageId: 'root-check', segment: 'tool',
      }]);
      assert.equal(tool.matches[0].matchField, 'toolName');
      const defaultFields = await search(client, { query: 'read_marker', providers: ['deepseek-harness'] });
      assert.deepEqual(defaultFields.matches, [], 'tool names require explicit field selection');
      const payload = await search(client, { query: 'SYNTHETIC-MARKER-OK', providers: ['deepseek-harness'] });
      assert.deepEqual(payload.matches, [], 'tool payload is not a default search field');
    });

  test(`session_search pages all lineage-filtered matches over ${era} stdio`,
    { timeout: 30_000 }, async t => {
      const client = await connect(t, era);
      const base = { query: 'synthetic', providers: ['deepseek-harness'], fields: ['title'], limit: 1 };
      const rows = [];
      let cursor;
      do {
        const page = await search(client, { ...base, ...(cursor ? { cursor } : {}) });
        assert.ok(page.matches.length <= 1);
        assert.equal(page.truncated, page.nextCursor !== null);
        rows.push(...page.matches);
        cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(rows.map(row => row.session.sessionId).sort(), [...ids].sort());
      assert.equal(new Set(rows.map(row => row.session.sessionId)).size, 3);
      const roots = await search(client, { ...base, lineage: 'roots', limit: 100 });
      assert.deepEqual(roots.matches.map(row => row.session.sessionId), [ids[0]]);
      const children = await search(client, { ...base, lineage: 'children', limit: 100 });
      assert.deepEqual(children.matches.map(row => row.session.sessionId).sort(), ids.slice(1).sort());
      const first = await search(client, base);
      assert.ok(first.nextCursor);
      const changed = await client.callTool({ name: 'session_search', arguments: {
        ...base, fields: ['assistant'], cursor: first.nextCursor,
      } });
      assert.equal(changed.isError, true, 'cursor must bind to effective fields');
      const invalid = await client.callTool({ name: 'session_search', arguments: {
        ...base, cursor: 'bad',
      } });
      assert.equal(invalid.isError, true);
      const otherScope = await connect(t, era);
      const foreign = await otherScope.callTool({ name: 'session_search', arguments: {
        ...base, cursor: first.nextCursor,
      } });
      assert.equal(foreign.isError, true, 'cursor must bind to the configured source scope');
    });
}

test('indexed title search stays source-read-only and diagnoses later corrupt transcript',
  { timeout: 30_000 }, async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-search-metadata-'));
    t.after(async () => { await rm(dir, { recursive: true, force: true }); });
    for (const name of ['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']) {
      await mkdir(path.join(dir, name));
    }
    const file = path.join(dir, 'opencode.db');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT,
      title TEXT, slug TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER,
      time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
      tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER
    ); CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT
    ); INSERT INTO session_v2 VALUES
      ('metadata-only',NULL,NULL,NULL,'Metadata marker','slug','/synthetic',1,2,NULL,0,0,0,0,0),
      ('metadata-sibling',NULL,NULL,NULL,'Marker sibling','slug','/synthetic',1,2,NULL,0,0,0,0,0);
      INSERT INTO session_message VALUES ('message','metadata-only','assistant',1,1,1,
        '{"content":[{"type":"text","text":"ordinary body"}]}');`);
    db.close();
    const before = createHash('sha256').update(readFileSync(file)).digest('hex');
    const client = new Client({ name: 'agentsession-v3-search-metadata', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: binary, cwd: repo, stderr: 'pipe',
      args: ['mcp', '--opencode-db', file, '--codex-dir', path.join(dir, 'codex'),
        '--claude-dir', path.join(dir, 'claude'), '--pi-dir', path.join(dir, 'pi'),
        '--dsh-dir', path.join(dir, 'dsh'), '--meta-dir', path.join(dir, 'meta'),
        '--index-dir', path.join(dir, 'index'), '--cache-dir', path.join(dir, 'cache')],
    }));
    t.after(async () => client.close());
    const result = await search(client, { query: 'metadata marker', providers: ['opencode'],
      fields: ['title'] });
    assert.deepEqual(result.matches.map(row => row.session.sessionId), ['metadata-only']);
    assert.equal(result.diagnostics[0].status, 'ok');
    const content = await search(client, { query: 'metadata marker', providers: ['opencode'],
      fields: ['assistant'] });
    assert.deepEqual(content.matches, []);
    assert.equal(content.diagnostics[0].status, 'ok');
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), before);
    const first = await search(client, { query: 'marker', providers: ['opencode'],
      fields: ['title'], limit: 1 });
    assert.ok(first.nextCursor);
    const changed = new DatabaseSync(file);
    changed.prepare('UPDATE session_v2 SET title=? WHERE id=?')
      .run('Unrelated sibling', 'metadata-sibling');
    changed.close();
    const stale = await client.callTool({ name: 'session_search', arguments: {
      query: 'marker', providers: ['opencode'], fields: ['title'], limit: 1,
      cursor: first.nextCursor,
    } });
    assert.equal(stale.isError, true, 'cursor must reject a changed source revision');
    const corrupt = new DatabaseSync(file);
    corrupt.prepare('UPDATE session_message SET data=? WHERE id=?').run('{broken', 'message');
    corrupt.close();
    const diagnosed = await search(client, { query: 'metadata marker', providers: ['opencode'],
      fields: ['assistant'] });
    assert.equal(diagnosed.diagnostics[0].status, 'error',
      'invalid changed provider source must be explicit');
  });

test('frozen OpenCode and Codex content search reuses published documents without source writes',
  { timeout: 60_000, skip: !process.env.AGENTSESSION_V3_SEARCH_PRIVATE_MANIFEST }, async t => {
    const manifest = JSON.parse(readFileSync(process.env.AGENTSESSION_V3_SEARCH_PRIVATE_MANIFEST));
    const codexFiles = manifest.captureTargets.filter(row => row.provider === 'codex')
      .map(row => row.snapshotPath);
    const sourceFiles = [manifest.database.snapshotPath, ...codexFiles];
    const before = sourceFiles.map(file => createHash('sha256').update(readFileSync(file)).digest('hex'));
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-search-private-'));
    t.after(async () => { await rm(dir, { recursive: true, force: true }); });
    for (const name of ['claude', 'pi', 'dsh', 'meta', 'index', 'cache']) await mkdir(path.join(dir, name));
    const client = new Client({ name: 'agentsession-v3-search-private', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: binary, cwd: repo, stderr: 'pipe',
      args: ['mcp', '--opencode-db', manifest.database.snapshotPath,
        '--codex-dir', manifest.providerRoots.codex.path,
        '--claude-dir', path.join(dir, 'claude'), '--pi-dir', path.join(dir, 'pi'),
        '--dsh-dir', path.join(dir, 'dsh'), '--meta-dir', path.join(dir, 'meta'),
        '--index-dir', path.join(dir, 'index'), '--cache-dir', path.join(dir, 'cache')],
    }));
    t.after(async () => client.close());
    for (const provider of ['opencode', 'codex']) {
      const request = { query: 'the', providers: [provider], fields: ['user', 'assistant'], limit: 2 };
      const first = await search(client, request);
      const second = await search(client, request);
      assert.equal(first.diagnostics[0].status, 'ok', provider);
      assert.deepEqual(second.matches, first.matches, `${provider} repeated query reads published documents`);
      assert.ok(first.matches.every(row => row.event?.provider === provider));
    }
    assert.deepEqual(sourceFiles.map(file => createHash('sha256').update(readFileSync(file)).digest('hex')),
      before, 'frozen source bytes remain unchanged');
  });
