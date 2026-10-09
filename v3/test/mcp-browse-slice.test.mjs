import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const codexFile = path.join(repo, 'v3', 'fixtures', 'codex', 'sessions', '2026', '09', '26',
  'rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl');
const codexParentConsensusRoot = path.join(repo, 'v3', 'fixtures', 'codex-parent-consensus');
const codexParentConsensusSources = [
  'rollout-2026-09-29T00-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl',
  'rollout-2026-09-29T00-01-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-a.jsonl',
  'rollout-2026-09-29T00-02-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-b.jsonl',
].map(name => path.join(codexParentConsensusRoot, 'sessions', '2026', '09', '29', name));
const codexParentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codexChildId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const codexOtherParentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const dshRoot = path.join(repo, 'v3', 'fixtures', 'deepseek-harness');
const dshIds = ['dsh-v3-s2-root', 'dsh-v3-s2-alpha', 'dsh-v3-s2-beta'];
const sources = [codexFile, ...codexParentConsensusSources, ...dshIds.map(id => path.join(dshRoot, 'sessions', 's2-synthetic', id,
  'session.v3.jsonl.zstd'))];
const hashes = sources.map(file => createHash('sha256').update(readFileSync(file)).digest('hex'));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-browse-'));
  t.after(async () => {
    try { assert.deepEqual(sources.map(hash), hashes, 'provider source files must remain unchanged'); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
  for (const name of ['codex', 'claude', 'pi', 'meta', 'index', 'cache']) await mkdir(path.join(dir, name));
  await cp(path.join(repo, 'v3', 'fixtures', 'codex'), path.join(dir, 'codex'), { recursive: true });
  await cp(dshRoot, path.join(dir, 'dsh'), { recursive: true });
  const args = ['mcp', '--codex-dir', path.join(dir, 'codex'), '--opencode-db', path.join(dir, 'opencode.db'),
    '--claude-dir', path.join(dir, 'claude'), '--pi-dir', path.join(dir, 'pi'),
    '--dsh-dir', path.join(dir, 'dsh'), '--meta-dir', path.join(dir, 'meta'),
    '--index-dir', path.join(dir, 'index'), '--cache-dir', path.join(dir, 'cache')];
  return { dir, args };
}

async function setupCodexParentConsensus(t) {
  const state = await setup(t);
  await rm(path.join(state.dir, 'codex', 'sessions'), { recursive: true, force: true });
  await cp(path.join(codexParentConsensusRoot, 'sessions'), path.join(state.dir, 'codex', 'sessions'),
    { recursive: true });
  return state;
}

async function connect(t, args, modern) {
  const client = new Client({ name: 'agentsession-v3-browse-test', version: '1.0.0' },
    modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  await client.connect(new StdioClientTransport({ command: binary, args, cwd: repo, stderr: 'pipe' }));
  t.after(async () => client.close());
  return client;
}

test('MCP browse retains a collided Codex ID while session_get refuses fragment history',
  { timeout: 30_000 }, async t => {
    const { dir, args } = await setup(t);
    const id = '44444444-4444-4444-8444-444444444444';
    const duplicate = path.join(dir, 'codex', 'sessions', '2026', '09', '26', `rollout-2026-09-26T00-01-00-${id}.jsonl`);
    await writeFile(duplicate, JSON.stringify({ type: 'session_meta', timestamp: '2026-09-26T00:01:00.000Z',
      payload: { id, cwd: '/synthetic/v3-slice' } }) + '\n');
    const client = await connect(t, args, false);
    const browse = await client.callTool({ name: 'session_browse', arguments: {
      level: 'sessions', providers: ['codex'], limit: 20 } });
    assert.notEqual(browse.isError, true, browse.content?.[0]?.text);
    const collision = browse.structuredContent.result.sessions.find(row => row.session.sessionId === id);
    assert.equal(collision?.diagnostic, 'codex_multiple_source_files_unmerged');
    assert.equal(browse.structuredContent.result.diagnostics.find(row => row.provider === 'codex')?.status,
      'partial');
    assert.deepEqual(browse.structuredContent.result.diagnostics.find(row => row.provider === 'codex')?.sourceDiagnostics,
      [{ code: 'codex_multiple_source_files_unmerged', affectedSessions: 1 }]);
    const get = await client.callTool({ name: 'session_get', arguments: {
      session: { provider: 'codex', sessionId: id } } });
    assert.equal(get.isError, true);
    assert.match(JSON.stringify(get), /codex_multiple_source_files_unmerged/);
    const search = await client.callTool({ name: 'session_search', arguments: {
      query: 'synthetic', providers: ['codex'], fields: ['user'] } });
    assert.notEqual(search.isError, true, search.content?.[0]?.text);
    const result = search.structuredContent.result;
    assert.deepEqual(result.matches, []);
    assert.equal(result.diagnostics.find(row => row.provider === 'codex')?.status, 'partial');
    assert.deepEqual(result.diagnostics.find(row => row.provider === 'codex')?.sourceDiagnostics,
      [{ code: 'codex_multiple_source_files_unmerged', affectedSessions: 1 }]);
  });

test('MCP browse exposes only the consensus canonical parent for a collided Codex ID',
  { timeout: 30_000 }, async t => {
    const { args } = await setupCodexParentConsensus(t);
    const client = await connect(t, args, false);
    const all = await client.callTool({ name: 'session_browse', arguments: {
      level: 'sessions', providers: ['codex'], limit: 20 } });
    assert.notEqual(all.isError, true, all.content?.[0]?.text);
    const collision = all.structuredContent.result.sessions.find(row => row.session.sessionId === codexChildId);
    assert.equal(collision?.diagnostic, 'codex_multiple_source_files_unmerged');
    assert.deepEqual(collision?.parent, { provider: 'codex', sessionId: codexParentId });
    assert.equal(collision?.tokenCount, null);
    assert.equal(collision?.messageCount, 0);

    const children = await client.callTool({ name: 'session_browse', arguments: {
      level: 'sessions', providers: ['codex'], parent: { provider: 'codex', sessionId: codexParentId }, limit: 20 } });
    assert.notEqual(children.isError, true, children.content?.[0]?.text);
    assert.deepEqual(children.structuredContent.result.sessions.map(row => row.session.sessionId), [codexChildId]);
    const get = await client.callTool({ name: 'session_get', arguments: {
      session: { provider: 'codex', sessionId: codexChildId } } });
    assert.equal(get.isError, true);
    assert.match(JSON.stringify(get), /codex_multiple_source_files_unmerged/);
  });

test('MCP browse withholds a collided Codex parent when source headers disagree',
  { timeout: 30_000 }, async t => {
    const { dir, args } = await setupCodexParentConsensus(t);
    const [_, , secondSource] = codexParentConsensusSources;
    const copiedSecondSource = path.join(dir, 'codex', 'sessions', '2026', '09', '29', path.basename(secondSource));
    const secondHeader = JSON.parse((await readFile(copiedSecondSource, 'utf8')).split(/\r?\n/)[0]);
    secondHeader.payload.forked_from_id = codexOtherParentId;
    await writeFile(copiedSecondSource, `${JSON.stringify(secondHeader)}\n${(await readFile(copiedSecondSource, 'utf8')).split(/\r?\n/).slice(1).filter(Boolean).join('\n')}\n`);
    const client = await connect(t, args, false);
    const all = await client.callTool({ name: 'session_browse', arguments: {
      level: 'sessions', providers: ['codex'], limit: 20 } });
    assert.notEqual(all.isError, true, all.content?.[0]?.text);
    const collision = all.structuredContent.result.sessions.find(row => row.session.sessionId === codexChildId);
    assert.equal(collision?.diagnostic, 'codex_multiple_source_files_unmerged');
    assert.equal(collision?.parent, null);
    assert.equal(collision?.tokenCount, null);
    const originalParent = await client.callTool({ name: 'session_browse', arguments: {
      level: 'sessions', providers: ['codex'], parent: { provider: 'codex', sessionId: codexParentId }, limit: 20 } });
    assert.deepEqual(originalParent.structuredContent.result.sessions.map(row => row.session.sessionId), []);
    const disagreementParent = await client.callTool({ name: 'session_browse', arguments: {
      level: 'sessions', providers: ['codex'], parent: { provider: 'codex', sessionId: codexOtherParentId }, limit: 20 } });
    assert.deepEqual(disagreementParent.structuredContent.result.sessions.map(row => row.session.sessionId), []);
  });

test('MCP browse reports an incomplete Codex inventory with no known session rows',
  { timeout: 30_000 }, async t => {
    const { dir, args } = await setup(t);
    const source = path.join(dir, 'codex', 'sessions', '2026', '09', '26',
      'rollout-2026-09-26T00-00-00-unknown.jsonl');
    await rm(path.join(dir, 'codex', 'sessions'), { recursive: true });
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, '{invalid header}\n');
    const client = await connect(t, args, false);
    for (const level of ['providers', 'sessions']) {
      const response = await client.callTool({ name: 'session_browse', arguments: {
        level, providers: ['codex'] } });
      assert.notEqual(response.isError, true);
      const result = response.structuredContent.result;
      assert.equal(result.diagnostics.find(row => row.provider === 'codex')?.status, 'partial');
      assert.deepEqual(result.diagnostics.find(row => row.provider === 'codex')?.sourceDiagnostics,
        [{ code: 'codex_source_inventory_incomplete', affectedSources: 1 }]);
      if (level === 'sessions') assert.deepEqual(result.sessions, []);
    }
  });

for (const modern of [false, true]) test(`session_browse traverses public sources via ${modern ? '2026-07-28' : 'legacy'} stdio`,
  { timeout: 30_000 }, async t => {
    const { args } = await setup(t);
    const client = await connect(t, args, modern);
    const browse = async arguments_ => {
      const response = await client.callTool({ name: 'session_browse', arguments: arguments_ });
      assert.notEqual(response.isError, true, response.content?.[0]?.text);
      assert.equal(response.structuredContent.untrustedContent, true);
      return response.structuredContent.result;
    };
    const providers = await browse({ level: 'providers' });
    assert.equal(providers.level, 'providers');
    assert.equal(providers.providers.length, 5);
    assert.equal(providers.providers.find(row => row.provider === 'codex').available, true);
    assert.equal(providers.providers.find(row => row.provider === 'deepseek-harness').available, true);
    assert.equal(providers.providers.find(row => row.provider === 'opencode').available, false);
    const projects = await browse({ level: 'projects', providers: ['codex', 'deepseek-harness'], limit: 1 });
    assert.equal(projects.projects.length, 1);
    assert.equal(projects.projects[0].provider, 'codex');
    assert.equal(projects.projects[0].directory, '/synthetic/v3-slice');
    assert.ok(projects.nextCursor);
    const second = await browse({ level: 'projects', providers: ['codex', 'deepseek-harness'], limit: 1,
      cursor: projects.nextCursor });
    assert.equal(second.projects[0].provider, 'deepseek-harness');
    assert.equal(second.projects[0].indexedCount, 3);
    assert.equal(second.nextCursor, null);
    const roots = await browse({ level: 'sessions', providers: ['deepseek-harness'], parent: null });
    assert.deepEqual(roots.sessions.map(row => row.session.sessionId), ['dsh-v3-s2-root']);
    const parent = { provider: 'deepseek-harness', sessionId: 'dsh-v3-s2-root' };
    const first = await browse({ level: 'sessions', providers: ['deepseek-harness'], parent, limit: 1 });
    assert.equal(first.sessions.length, 1);
    assert.deepEqual(first.sessions[0].parent, parent);
    assert.ok(first.nextCursor);
    const next = await browse({ level: 'sessions', providers: ['deepseek-harness'], parent,
      limit: 1, cursor: first.nextCursor });
    assert.deepEqual([first.sessions[0].session.sessionId, next.sessions[0].session.sessionId].sort(),
      ['dsh-v3-s2-alpha', 'dsh-v3-s2-beta']);
    assert.equal(next.nextCursor, null);
    const resized = await browse({ level: 'sessions', providers: ['deepseek-harness'], parent,
      limit: 100, cursor: first.nextCursor });
    assert.deepEqual(resized.sessions.map(row => row.session.sessionId),
      next.sessions.map(row => row.session.sessionId), 'page size does not define cursor identity');
    const codex = await browse({ level: 'sessions', providers: ['codex'], directory: '/synthetic/v3-slice' });
    assert.deepEqual(codex.sessions.map(row => row.session), [{ provider: 'codex',
      sessionId: '44444444-4444-4444-8444-444444444444' }]);
    const title = await browse({ level: 'sessions', providers: ['codex'], title: codex.sessions[0].title,
      updatedAfter: codex.sessions[0].updatedAt, updatedBefore: codex.sessions[0].updatedAt });
    assert.deepEqual(title.sessions.map(row => row.session), codex.sessions.map(row => row.session));
    const outside = await browse({ level: 'sessions', providers: ['codex'],
      updatedAfter: codex.sessions[0].updatedAt + 1 });
    assert.deepEqual(outside.sessions, []);
    const wrongDirectory = await browse({ level: 'projects', providers: ['codex'], directory: '/not-recorded' });
    assert.deepEqual(wrongDirectory.projects, []);
    const wrongFilter = await client.callTool({ name: 'session_browse', arguments: { level: 'sessions',
      providers: ['deepseek-harness'], parent: null, cursor: first.nextCursor } });
    assert.equal(wrongFilter.isError, true);
    const invalid = await client.callTool({ name: 'session_browse', arguments: { level: 'sessions', cursor: 'bad' } });
    assert.equal(invalid.isError, true);
    const unsupported = await client.callTool({ name: 'session_browse', arguments: { level: 'projects', title: 'x' } });
    assert.equal(unsupported.isError, true);
    const tooLarge = await client.callTool({ name: 'session_browse', arguments: { level: 'sessions', limit: 101 } });
    assert.notEqual(tooLarge.isError, true);
    assert.ok(tooLarge.structuredContent.result.sessions.length <= 100,
      'valid oversized browse limit is capped to its hard maximum');
  });

for (const modern of [false, true]) test(`session_browse normalizes absolute Windows and WSL project paths via ${modern ? '2026-07-28' : 'legacy'} stdio`,
  { timeout: 30_000 }, async t => {
    const { dir, args } = await setup(t);
    const copiedSessions = path.join(dir, 'codex', 'sessions');
    await rm(copiedSessions, { recursive: true, force: true });
    const publicLines = readFileSync(codexFile, 'utf8').trimEnd().split(/\r?\n/);
    const fixtures = [
      ['10101010-1010-4010-8010-101010101010', 'D:\\'],
      ['20202020-2020-4020-8020-202020202020', 'D:\\Work\\Project'],
      ['30303030-3030-4030-8030-303030303030', '/mnt/d/Work/Project'],
    ];
    for (const [sessionId, cwd] of fixtures) {
      const lines = [...publicLines];
      const header = JSON.parse(lines[0]);
      header.payload.id = sessionId;
      header.payload.cwd = cwd;
      lines[0] = JSON.stringify(header);
      const sessionFile = path.join(copiedSessions, '2026', '09', '26',
        `rollout-2026-09-26T00-00-00-${sessionId}.jsonl`);
      await mkdir(path.dirname(sessionFile), { recursive: true });
      await writeFile(sessionFile, `${lines.join('\n')}\n`);
    }

    const client = await connect(t, args, modern);
    const browse = async arguments_ => {
      const response = await client.callTool({ name: 'session_browse', arguments: arguments_ });
      assert.notEqual(response.isError, true, response.content?.[0]?.text);
      return response.structuredContent.result;
    };
    const projects = [];
    let cursor;
    do {
      const page = await browse({ level: 'projects', providers: ['codex'], limit: 1,
        ...(cursor ? { cursor } : {}) });
      assert.equal(page.projects.length, 1);
      projects.push(page.projects[0]);
      cursor = page.nextCursor;
    } while (cursor);

    assert.deepEqual(projects.map(({ directory, indexedCount }) => ({ directory, indexedCount })), [
      { directory: 'd:/', indexedCount: 1 },
      { directory: 'd:/work/project', indexedCount: 2 },
    ]);
    for (const project of projects) {
      const roundTrip = await browse({ level: 'sessions', providers: ['codex'], directory: project.directory });
      assert.equal(roundTrip.sessions.length, project.indexedCount,
        `returned project directory should select ${project.directory}`);
    }
    const driveRelative = await browse({ level: 'sessions', providers: ['codex'], directory: 'D:' });
    assert.deepEqual(driveRelative.sessions, [], 'drive-relative D: must stay distinct from the D:/ root');
    const driveRoot = await browse({ level: 'sessions', providers: ['codex'], directory: 'D:\\' });
    assert.deepEqual(driveRoot.sessions.map(row => row.session.sessionId), [fixtures[0][0]]);
  });

test('session_browse cursor rejects source revision changes and source scope changes',
  { timeout: 30_000 }, async t => {
    const { dir, args } = await setup(t);
    const client = await connect(t, args, false);
    const query = { level: 'sessions', providers: ['deepseek-harness'], limit: 1 };
    const first = await client.callTool({ name: 'session_browse', arguments: query });
    assert.notEqual(first.isError, true, first.content?.[0]?.text);
    const cursor = first.structuredContent.result.nextCursor;
    assert.ok(cursor);
    const other = await setup(t);
    const otherClient = await connect(t, other.args, false);
    const crossScope = await otherClient.callTool({ name: 'session_browse', arguments: { ...query, cursor } });
    assert.equal(crossScope.isError, true);
    await rm(path.join(dir, 'dsh', 'sessions', 's2-synthetic', 'dsh-v3-s2-root', 'session.v3.jsonl.zstd'));
    const stale = await client.callTool({ name: 'session_browse', arguments: { ...query, cursor } });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /^source_changed: /);
  });

for (const modern of [false, true]) test(`session_browse validates UTF-16 lengths at the native MCP boundary (${modern ? 'modern' : 'legacy'})`,
  { timeout: 30_000 }, async t => {
    const { args } = await setup(t);
    const client = await connect(t, args, modern);
    const browse = arguments_ => client.callTool({ name: 'session_browse', arguments: arguments_ });
    const accepted = [
      ['200 Chinese title units', { title: '中'.repeat(200) }],
      ['500 Chinese title units', { title: '中'.repeat(500) }],
      ['500 mixed supplementary title units', { title: '😀'.repeat(250) }],
      ['trimmed 500 Chinese title units', { title: `  ${'中'.repeat(500)}  ` }],
      ['2000 Chinese directory units', { directory: `/${'中'.repeat(2000)}` }],
      ['4000 mixed supplementary directory units', { directory: `/${'😀'.repeat(1999)}a` }],
      ['1000 Chinese parent session ID units', { parent: { provider: 'codex', sessionId: '中'.repeat(1000) } }],
      ['1000 supplementary parent session ID units', { parent: { provider: 'codex', sessionId: '😀'.repeat(500) } }],
    ];
    for (const [label, filters] of accepted) {
      const response = await browse({ level: 'sessions', providers: ['codex'], ...filters });
      assert.notEqual(response.isError, true, `${label} should fit its UTF-16 limit: ${response.content?.[0]?.text}`);
    }

    const rejected = [
      ['501 Chinese title units', { title: '中'.repeat(501) }],
      ['501 mixed supplementary title units', { title: `${'😀'.repeat(250)}x` }],
      ['4001 mixed supplementary directory units', { directory: `/${'😀'.repeat(2000)}` }],
      ['1001 Chinese parent session ID units', { parent: { provider: 'codex', sessionId: '中'.repeat(1001) } }],
      ['1001 mixed supplementary parent session ID units', { parent: { provider: 'codex', sessionId: `${'😀'.repeat(500)}x` } }],
    ];
    for (const [label, filters] of rejected) {
      const response = await browse({ level: 'sessions', providers: ['codex'], ...filters });
      assert.equal(response.isError, true, `${label} should exceed its UTF-16 limit`);
    }
  });

test('session_browse traverses every current Codex page when a real source root is selected',
  { timeout: 180_000, skip: !process.env.AGENTSESSION_V3_REAL_CODEX_DIR }, async t => {
    const { args } = await setup(t);
    args[args.indexOf('--codex-dir') + 1] = process.env.AGENTSESSION_V3_REAL_CODEX_DIR;
    const client = await connect(t, args, false);
    const ids = new Set();
    let cursor;
    let pages = 0;
    do {
      const response = await client.callTool({ name: 'session_browse', arguments: {
        level: 'sessions', providers: ['codex'], limit: 100,
        ...(cursor ? { cursor } : {}),
      } });
      assert.notEqual(response.isError, true, `page ${pages}: ${response.content?.[0]?.text}`);
      const page = response.structuredContent.result;
      assert.ok(page.sessions.length <= 100);
      for (const row of page.sessions) {
        assert.equal(row.session.provider, 'codex');
        assert.ok(!ids.has(row.session.sessionId), `duplicate canonical ID: ${row.session.sessionId}`);
        ids.add(row.session.sessionId);
      }
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    assert.ok(ids.size > 0);
    t.diagnostic(`current Codex source: ${ids.size} sessions across ${pages} pages`);
  });

test('session_browse traverses frozen real Codex and DSH sources when selected',
  { timeout: 120_000, skip: !process.env.AGENTSESSION_V3_REAL_MANIFEST }, async t => {
    const manifest = JSON.parse(readFileSync(process.env.AGENTSESSION_V3_REAL_MANIFEST, 'utf8'));
    const frozenSources = manifest.files.filter(row => ['codex', 'deepseek-harness'].includes(row.provider));
    const before = frozenSources.map(row => hash(row.snapshotPath));
    assert.deepEqual(before, frozenSources.map(row => row.snapshotSha256), 'frozen source hashes match manifest');
    t.after(() => assert.deepEqual(frozenSources.map(row => hash(row.snapshotPath)), before,
      'MCP must leave frozen provider source bytes unchanged'));
    const { args } = await setup(t);
    args[args.indexOf('--codex-dir') + 1] = manifest.providerRoots.codex.path;
    args[args.indexOf('--dsh-dir') + 1] = manifest.providerRoots['deepseek-harness'].path;
    const client = await connect(t, args, false);
    for (const provider of ['codex', 'deepseek-harness']) {
      const ids = new Set();
      let cursor;
      let pages = 0;
      do {
        const response = await client.callTool({ name: 'session_browse', arguments: {
          level: 'sessions', providers: [provider], limit: 1, ...(cursor ? { cursor } : {}),
        } });
        assert.notEqual(response.isError, true, response.content?.[0]?.text);
        const page = response.structuredContent.result;
        for (const row of page.sessions) {
          assert.equal(row.session.provider, provider);
          assert.ok(!ids.has(row.session.sessionId));
          ids.add(row.session.sessionId);
        }
        cursor = page.nextCursor;
        pages++;
      } while (cursor);
      assert.ok(ids.size > 0, `${provider} has readable frozen source`);
      t.diagnostic(`frozen ${provider}: ${ids.size} sessions across ${pages} pages`);
    }
  });

test('session_browse detects a body-only rewrite with unchanged catalog summary',
  { timeout: 30_000 }, async t => {
    const { dir, args } = await setup(t);
    const copied = path.join(dir, 'codex', 'sessions', '2026', '09', '26', path.basename(codexFile));
    const original = await readFile(copied, 'utf8');
    const otherId = '55555555-5555-4555-8555-555555555555';
    const second = original.replaceAll('44444444-4444-4444-8444-444444444444', otherId);
    await writeFile(path.join(path.dirname(copied), path.basename(copied).replaceAll(
      '44444444-4444-4444-8444-444444444444', otherId)), second);
    const client = await connect(t, args, false);
    const query = { level: 'sessions', providers: ['codex'], limit: 1 };
    const first = await client.callTool({ name: 'session_browse', arguments: query });
    assert.notEqual(first.isError, true);
    const cursor = first.structuredContent.result.nextCursor;
    assert.ok(cursor);
    await writeFile(copied, original.replace('Hello 🙂 from the Rust slice.',
      'Howdy 🙂 from the Rust slice.'));
    const sameSummary = await client.callTool({ name: 'session_browse', arguments: query });
    assert.deepEqual(sameSummary.structuredContent.result.sessions,
      first.structuredContent.result.sessions, 'rewrite keeps indexed summary unchanged');
    const stale = await client.callTool({ name: 'session_browse', arguments: { ...query, cursor } });
    assert.equal(stale.isError, true, 'source revision should invalidate the old cursor');
    assert.match(stale.content[0].text, /^source_changed: /);
  });
