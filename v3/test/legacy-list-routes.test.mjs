import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

test('documented list routes preserve JSON paging and family facts',
  { timeout: 30_000 }, async t => {
    const scratch = path.join(repo, 'tmp');
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(path.join(scratch, 'v3-legacy-lists-'));
    const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']
      .map(name => [name, path.join(root, name)]));
    await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
    await mkdir(path.join(dirs.pi, 'sessions', 'project'), { recursive: true });
    const codexId = '22222222-3333-4444-8555-666666666666';
    const codexFolder = path.join(dirs.codex, 'sessions', '2026', '09', '27');
    await mkdir(codexFolder, { recursive: true });
    const codexSource = path.join(codexFolder, `rollout-2026-09-27T00-00-00-${codexId}.jsonl`);
    const codexRecords = [{ timestamp: '2026-09-27T00:00:00.000Z', type: 'session_meta',
      payload: { id: codexId, cwd: '/project/codex', cli_version: '0.153.0' } }];
    for (let i = 0; i < 300; i++) {
      codexRecords.push({ timestamp: new Date(Date.parse('2026-09-27T00:00:01Z') + i * 2000).toISOString(),
        type: 'response_item', payload: { type: 'message', role: 'user', id: `user-${i}`,
          content: [{ type: 'input_text', text: `Recorded request ${i}` }],
          internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } });
      codexRecords.push({ timestamp: new Date(Date.parse('2026-09-27T00:00:02Z') + i * 2000).toISOString(),
        type: 'response_item', payload: { type: 'message', role: 'assistant', id: `assistant-${i}`,
          content: [{ type: 'output_text', text: `Recorded response ${i}` }] } });
    }
    await writeFile(codexSource, codexRecords.map(JSON.stringify).join('\n') + '\n');
    const codexBefore = hash(codexSource);
    const memoryDbPath = path.join(dirs.codex, 'memories_1.sqlite');
    const emptyMemoryDb = new DatabaseSync(memoryDbPath);
    emptyMemoryDb.exec(`CREATE TABLE stage1_outputs (thread_id TEXT PRIMARY KEY,
      source_updated_at INTEGER NOT NULL, raw_memory TEXT NOT NULL,
      rollout_summary TEXT NOT NULL, generated_at INTEGER NOT NULL);`);
    emptyMemoryDb.close();
    const emptyMemoryHash = hash(memoryDbPath);
    const piId = '11111111-2222-4333-8444-555555555555';
    const piSource = path.join(dirs.pi, 'sessions', 'project', `current_${piId}.jsonl`);
    await writeFile(piSource, [
      { type: 'session', version: 3, id: piId, timestamp: '2026-09-27T00:00:00Z', cwd: '/project/pi' },
      { type: 'message', id: 'pi-user', parentId: null, timestamp: '2026-09-27T00:00:01Z',
        message: { role: 'user', content: 'Ping' } },
      { type: 'message', id: 'pi-answer', parentId: 'pi-user', timestamp: '2026-09-27T00:00:02Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Pong' }] } },
    ].map(JSON.stringify).join('\n') + '\n');
    const piBefore = hash(piSource);
    const dbPath = path.join(root, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT,
      fork_boundary TEXT, title TEXT, slug TEXT, directory TEXT, time_created INTEGER,
      time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
      tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT);`);
    const insert = db.prepare('INSERT INTO session_v2 VALUES (?,?,NULL,NULL,?,?,?, ?,?,NULL,NULL,NULL,NULL,NULL,NULL)');
    insert.run('root', null, 'Root family', 'root', '/project/a', 1, 100);
    insert.run('other', null, 'Other family', 'other', '/project/b', 2, 200);
    for (let i = 0; i < 23; i++) insert.run(`child-${String(i).padStart(2, '0')}`,
      'root', `Child ${i}`, `child-${i}`, '/project/a', 10 + i, 300 + i);
    const addMessage = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
    addMessage.run('root-user', 'root', 'user', 1, 10, 10,
      JSON.stringify({ text: 'Root body match' }));
    addMessage.run('other-user', 'other', 'user', 1, 20, 20,
      JSON.stringify({ text: 'Root sibling match' }));
    addMessage.run('root-tool', 'root', 'assistant', 2, 30, 30,
      JSON.stringify({ content: [{ type: 'tool', id: 'call', name: 'needletool',
        state: { status: 'completed', input: {}, content: [] } }] }));
    db.close();
    const before = hash(dbPath);
    const port = await freeFetchSafePort();
    const args = ['serve', '--port', String(port), '--opencode-db', dbPath,
      '--codex-dir', dirs.codex, '--claude-dir', dirs.claude, '--pi-dir', dirs.pi,
      '--dsh-dir', dirs.dsh, '--meta-dir', dirs.meta, '--index-dir', dirs.index, '--cache-dir', dirs.cache];
    const child = spawn(binary, args, { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data.toString(); });
    t.after(async () => {
      child.kill();
      if (child.exitCode === null) await once(child, 'close');
      assert.equal(hash(dbPath), before);
      assert.equal(hash(piSource), piBefore);
      assert.equal(hash(codexSource), codexBefore);
      await rm(root, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/api/providers')).ok) break; } catch { /* startup */ }
      if (i === 99) assert.fail(`server not ready: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const get = async url => {
      const response = await fetch(base + url);
      return { status: response.status, body: await response.json() };
    };

    const flat = await get('/api/sessions?provider=opencode&limit=2&offset=1');
    assert.equal(flat.status, 200);
    assert.equal(flat.body.total, 2);
    assert.equal(flat.body.offset, 1);
    assert.equal(flat.body.hasMore, false);
    assert.equal(flat.body.sessions.length, 1);
    assert.deepEqual(Object.keys(flat.body.sessions[0]).sort(),
      ['directory', 'href', 'id', 'provider', 'starred', 'stats', 'summary_additions',
        'summary_deletions', 'summary_files', 'time_updated', 'title'].sort());
    assert.equal(flat.body.sessions[0].stats.sessionId, flat.body.sessions[0].id);
    assert.equal(flat.body.sessions[0].summary_files, null);
    const both = await get('/api/sessions?provider=opencode&provider=pi&limit=1');
    assert.equal(both.status, 200);
    assert.equal(both.body.total, 3);
    assert.equal(both.body.sessions[0].provider, 'pi');
    assert.equal(both.body.sessions[0].stats.protocol, true);
    const scoped = await get('/api/opencode/sessions?limit=2');
    assert.equal(scoped.status, 200);
    assert.equal(scoped.body.total, 2);
    assert.equal(Object.hasOwn(scoped.body.sessions[0], 'html'), false);
    const scopedTitle = await get('/api/opencode/sessions?mode=content&q=Root');
    assert.equal(scopedTitle.status, 200);
    assert.deepEqual(scopedTitle.body.sessions.map(session => session.id), ['other', 'root']);
    assert.deepEqual(scopedTitle.body.sessions.map(session => session.searchMatch.messageId),
      ['other-user', 'root-user']);
    const scopedOffset = await get('/api/opencode/sessions?mode=content&q=Root&limit=1&offset=1');
    assert.deepEqual(scopedOffset.body.sessions.map(session => session.id), ['root']);
    const toolNameOnly = await get('/api/opencode/sessions?mode=content&q=needletool');
    assert.deepEqual(toolNameOnly.body.sessions, []);
    const scopedEmpty = await get('/api/opencode/sessions?mode=content&q=');
    assert.equal(scopedEmpty.body.total, 2);
    assert.equal((await get('/api/not-a-provider/sessions')).status, 404);
    const codexCold = await get('/api/codex/sessions?limit=1');
    const codexWarm = await get('/api/codex/sessions?limit=1');
    assert.equal(codexCold.body.sessions[0].stats.protocol, true);
    assert.ok(codexCold.body.sessions[0].stats.messageCount >= 300);
    assert.deepEqual(codexWarm.body.sessions[0].stats, codexCold.body.sessions[0].stats);
    const memoryDb = new DatabaseSync(memoryDbPath);
    memoryDb.prepare('INSERT INTO stage1_outputs VALUES (?, ?, ?, ?, ?)')
      .run(codexId, 1789565411, 'Synthetic memory', 'Synthetic summary', 1789621884);
    memoryDb.close();
    const memoryBefore = hash(memoryDbPath);
    assert.notEqual(memoryBefore, emptyMemoryHash);
    const codexAfterMemoryOnly = await get('/api/codex/sessions?limit=1');
    assert.equal(codexAfterMemoryOnly.body.sessions[0].stats.contextArtifactCount, 2);
    assert.equal(codexAfterMemoryOnly.body.sessions[0].stats.memoryCount, 1);
    assert.equal(hash(memoryDbPath), memoryBefore);
    assert.equal(hash(codexSource), codexBefore);
    const comma = await get('/api/sessions?provider=opencode,pi&limit=1');
    assert.equal(comma.body.total, both.body.total);
    const content = await get('/api/sessions?mode=content&provider=pi&q=Ping&limit=1&offset=0');
    assert.equal(content.status, 200);
    assert.equal(content.body.sessions.length, 1);
    assert.equal(content.body.sessions[0].provider, 'pi');
    assert.equal(content.body.sessions[0].searchMatch.messageId, 'pi-user');
    assert.equal((await get('/api/sessions?mode=content&q=Ping&offset=100001')).status, 400);

    const families = await get('/api/library/sessions?provider=opencode&limit=1&offset=1');
    assert.equal(families.status, 200);
    assert.equal(families.body.total, 2);
    assert.equal(families.body.matchingSessions, 25);
    assert.equal(families.body.offset, 1);
    assert.equal(families.body.hasMore, false);
    assert.equal(families.body.sessions.length, 1);
    assert.equal(Object.hasOwn(families.body.sessions[0], 'html'), false);
    assert.equal(families.body.sessions[0].id, 'other');
    assert.equal(families.body.sessions[0].familyRootId, 'other');
    assert.equal(families.body.sessions[0].childCount, 0);
    assert.equal(families.body.sessions[0].parent, null);
    const expandable = await get('/api/library/sessions?provider=opencode&limit=1');
    assert.equal(expandable.body.sessions[0].id, 'root');
    assert.equal(expandable.body.sessions[0].childCount, 23);
    assert.equal(expandable.body.sessions[0].totalChildCount, 23);
    assert.equal(expandable.body.sessions[0].matchingCount, 24);
    assert.equal(expandable.body.sessions[0].matched, true);
    assert.equal(expandable.body.sessions[0].familyRootId, 'root');
    assert.equal(expandable.body.sessions[0].familyUpdated, 322);
    assert.equal(expandable.body.sessions[0].parentBoundary, null);
    assert.equal(expandable.body.sessions[0].href, '/opencode/session/root?from=%2Fsessions');
    const filtered = await get('/api/library/sessions?provider=opencode&q=Child%2022');
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.matchingSessions, 1);
    assert.equal(filtered.body.total, 1);
    assert.equal((await get('/api/library/sessions?provider=opencode&q=child-22')).body.total, 0);
    assert.equal((await get('/api/library/sessions?provider=opencode&q=opencode')).body.total, 0);
    assert.equal((await get('/api/library/sessions?provider=opencode&q=%20Child%2022%20')).body.total, 0);
    const noProject = await get('/api/library/sessions?provider=opencode&project=%2Fproject%2Fmissing');
    assert.equal(noProject.body.total, 0);
    await t.test('family offsets above 100000 return an empty page', async () => {
      const result = await get('/api/library/sessions?provider=opencode&offset=100001');
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, {
        sessions: [], total: 2, offset: 100001, hasMore: false, matchingSessions: 25,
      });
    });

    const first = await get('/api/library/children?provider=opencode&parentProvider=opencode&parentId=root');
    assert.equal(first.status, 200);
    assert.equal(first.body.total, 23);
    assert.equal(first.body.shown, 20);
    assert.equal(first.body.nextOffset, 20);
    await t.test('all four documented list responses omit HTML and retain row links', async () => {
      for (const [label, response, rowsKey] of [
        ['/api/sessions', flat, 'sessions'],
        ['/api/:provider/sessions', scoped, 'sessions'],
        ['/api/library/sessions', families, 'sessions'],
        ['/api/library/children', first, 'children'],
      ]) {
        assert.equal(response.status, 200, `${label} responds successfully`);
        assert.equal(Object.hasOwn(response.body, 'html'), false, `${label} has no HTML fragment`);
        assert.ok(response.body[rowsKey].length > 0, `${label} provides rows for contract checks`);
        for (const row of response.body[rowsKey]) {
          assert.equal(Object.hasOwn(row, 'html'), false, `${label} rows have no HTML fragment`);
          assert.equal(typeof row.href, 'string', `${label} rows retain canonical links`);
        }
      }
    });
    assert.equal(Object.hasOwn(first.body, 'html'), false);
    assert.equal(first.body.children.length, 20);
    assert.deepEqual(first.body.children.map(row => row.id),
      Array.from({ length: 20 }, (_, i) => `child-${String(22 - i).padStart(2, '0')}`));
    assert.equal(first.body.children[0].provider, 'opencode');
    assert.equal(first.body.children[0].parent.sessionId, 'root');
    assert.equal(first.body.children[0].familyRootId, 'root');
    assert.equal(first.body.children[0].title, 'Child 22');
    assert.equal(first.body.children[0].directory, '/project/a');
    assert.equal(first.body.children[0].time_updated, 322);
    assert.equal(first.body.children[0].href, '/opencode/session/child-22?from=%2Fsessions');
    assert.equal(first.body.children[0].childCount, 0);
    assert.equal(first.body.children[0].matchingCount, 1);
    assert.equal(first.body.children[0].matched, true);
    assert.equal(first.body.children[0].totalChildCount, 0);
    assert.equal(Object.hasOwn(first.body.children[0], 'html'), false);
    await t.test('valid child offsets above 100000 return an empty page', async () => {
      const result = await get('/api/library/children?provider=opencode&parentProvider=opencode&parentId=root&offset=100001');
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, {
        children: [], total: 23, offset: 100001, shown: 0, nextOffset: null,
      });
    });
    const last = await get('/api/library/children?provider=opencode&parentProvider=opencode&parentId=root&offset=20');
    assert.equal(last.status, 200);
    assert.equal(last.body.shown, 3);
    assert.equal(last.body.nextOffset, null);
    assert.deepEqual(last.body.children.map(row => row.id), ['child-02', 'child-01', 'child-00']);
    assert.equal((await get('/api/library/children?parentProvider=opencode&parentId=missing')).status, 404);
    assert.equal((await get('/api/sessions?provider=opencode&limit=101')).body.sessions.length, 2);
    assert.equal((await get('/api/sessions?provider=opencode&limit=-1')).body.sessions.length, 1);
    assert.equal((await get('/api/sessions?provider=opencode&offset=-1&limit=1')).body.offset, 0);
    await t.test('ordinary list offsets beyond the content-search cap return an empty page', async () => {
      for (const route of [
        '/api/sessions?provider=opencode&offset=100001&limit=1',
        '/api/opencode/sessions?offset=100001&limit=1',
      ]) {
        const result = await get(route);
        assert.equal(result.status, 200);
        assert.deepEqual(result.body, { sessions: [], total: 2, offset: 100001, hasMore: false });
      }
    });
    await t.test('requested content mode validates offsets before empty-query list fallback', async () => {
      const invalid = await get('/api/opencode/sessions?mode=content&q=&offset=-1');
      assert.equal(invalid.status, 400);
      const valid = await get('/api/opencode/sessions?mode=content&q=&offset=0');
      assert.equal(valid.status, 200);
      assert.equal(valid.body.total, 2);
      assert.equal(valid.body.offset, 0);
    });

    const collidedId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const collisionFolder = path.join(dirs.codex, 'sessions', '2026', '09', '28');
    await mkdir(collisionFolder, { recursive: true });
    const collisionSources = ['00-00-00', '00-00-01'].map(time => path.join(collisionFolder,
      `rollout-2026-09-28T${time}-${collidedId}.jsonl`));
    for (const source of collisionSources) {
      await writeFile(source, JSON.stringify({ timestamp: '2026-09-28T00:00:00.000Z',
        type: 'session_meta', payload: { id: collidedId, cwd: '/project/collision' } }) + '\n');
    }

    await t.test('legacy list wrappers retain bounded collision diagnostics and mark affected rows', async () => {
      const expected = [{ provider: 'codex', status: 'partial', sourceDiagnostics: [
        { code: 'codex_multiple_source_files_unmerged', affectedSessions: 1 },
      ] }];
      const flat = await get('/api/codex/sessions?limit=100');
      assert.deepEqual(flat.body.diagnostics, expected);
      const affectedFlat = flat.body.sessions.find(row => row.id === collidedId);
      assert.equal(affectedFlat.diagnostic, 'codex_multiple_source_files_unmerged');
      assert.equal(affectedFlat.stats.messageCount, null);
      assert.equal(affectedFlat.stats.protocol, null);
      assert.equal(Object.hasOwn(affectedFlat, 'html'), false);

      const family = await get('/api/library/sessions?provider=codex&limit=100');
      assert.deepEqual(family.body.diagnostics, expected);
      assert.equal(family.body.sessions.find(row => row.id === collidedId)?.diagnostic,
        'codex_multiple_source_files_unmerged');
      assert.equal(Object.hasOwn(family.body.sessions.find(row => row.id === collidedId), 'html'), false);

      const children = await get(`/api/library/children?parentProvider=codex&parentId=${codexId}`);
      assert.deepEqual(children.body.diagnostics, expected);
      assert.equal(children.body.children.length, 0);

      const noMatches = await get('/api/sessions?mode=content&provider=codex&q=absent-from-every-source');
      assert.deepEqual(noMatches.body.diagnostics, expected);
      assert.equal(noMatches.body.sessions.length, 0);
      for (const response of [flat, family, children, noMatches]) {
        assert.equal(JSON.stringify(response.body).includes(dirs.codex), false,
          'diagnostics expose codes and counts without source paths');
      }
    });

    await rm(collisionSources[1]);
    const unresolved = path.join(collisionFolder,
      'rollout-2026-09-28T00-00-02-ffffffff-1111-4222-8333-444444444444.jsonl');
    await writeFile(unresolved, '{invalid header}\n');
    await t.test('legacy zero-row responses retain unresolved source diagnostics', async () => {
      const expected = [{ provider: 'codex', status: 'partial', sourceDiagnostics: [
        { code: 'codex_source_inventory_incomplete', affectedSources: 1 },
      ] }];
      const emptyList = await get('/api/codex/sessions?project=%2Fproject%2Fnot-present');
      assert.equal(emptyList.body.sessions.length, 0);
      assert.deepEqual(emptyList.body.diagnostics, expected);

      const emptyFamilies = await get('/api/library/sessions?provider=codex&q=not-a-known-session');
      assert.equal(emptyFamilies.body.sessions.length, 0);
      assert.deepEqual(emptyFamilies.body.diagnostics, expected);

      const emptyContent = await get('/api/sessions?mode=content&provider=codex&q=absent-from-every-source');
      assert.equal(emptyContent.body.sessions.length, 0);
      assert.deepEqual(emptyContent.body.diagnostics, expected);
      for (const response of [emptyList, emptyFamilies, emptyContent]) {
        assert.equal(JSON.stringify(response.body).includes(dirs.codex), false,
          'unresolved diagnostics do not reveal source paths');
      }
    });
  });
