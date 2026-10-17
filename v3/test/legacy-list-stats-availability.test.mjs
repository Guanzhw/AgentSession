import { onCleanup, temporaryDirectory } from '../../test/helpers/fixture-cleanup.mjs';
import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

test('list HTTP 200 exposes failed protocol stats and preserves summary provenance',
  { timeout: 30_000 }, async t => {
    const scratch = path.join(repo, 'tmp');
    await mkdir(scratch, { recursive: true });
    const root = await temporaryDirectory(t, path.join(scratch, 'v3-list-stats-availability-'));
    const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']
      .map(name => [name, path.join(root, name)]));
    await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
    const dbPath = path.join(root, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT,
        fork_boundary TEXT, title TEXT, slug TEXT, directory TEXT, time_created INTEGER,
        time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
        tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
        time_created INTEGER, time_updated INTEGER, data TEXT);
        INSERT INTO session_v2 VALUES
        ('broken',NULL,NULL,NULL,'Malformed payload','broken','/fixture',100,300,NULL,7,3,0,0,0),
        ('healthy',NULL,NULL,NULL,'Healthy payload','healthy','/fixture',100,300,NULL,7,3,0,0,0);`);
      const add = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
      // The Reader accepts the recorded tool; protocol validation rejects its non-string status.
      add.run('broken-tool', 'broken', 'assistant', 1, 100, 100,
        JSON.stringify({ content: [{ type: 'tool', id: 'broken-call', name: 'read',
          state: { status: 42, input: {}, content: [] } }] }));
      add.run('healthy-user', 'healthy', 'user', 1, 100, 100, JSON.stringify({ text: 'Question' }));
      add.run('healthy-answer', 'healthy', 'assistant', 2, 300, 300,
        JSON.stringify({ content: [{ type: 'text', text: 'Answer' }] }));
    } finally {
      db.close();
    }
    const before = hash(dbPath);
    onCleanup(t, () => assert.equal(hash(dbPath), before, 'Viewer preserves the provider source'));
    const port = await freeFetchSafePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(binary, ['serve', '--port', String(port), '--opencode-db', dbPath,
      '--codex-dir', dirs.codex, '--claude-dir', dirs.claude, '--pi-dir', dirs.pi,
      '--dsh-dir', dirs.dsh, '--meta-dir', dirs.meta, '--index-dir', dirs.index,
      '--cache-dir', dirs.cache, '--disable-terminal-launch'],
    { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data.toString(); });
    onCleanup(t, async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill();
        await closed;
      }
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(base + '/api/providers')).ok) break; } catch { /* startup */ }
      if (attempt === 99) assert.fail(`server not ready: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (const route of ['/api/sessions?provider=opencode', '/api/opencode/sessions']) {
      const response = await fetch(base + route);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      const broken = body.sessions.find(row => row.id === 'broken');
      assert.ok(broken, 'the summary catalog remains readable');
      assert.equal(broken.stats.availability, 'unavailable');
      assert.equal(broken.stats.protocol, false);
      assert.equal(broken.stats.diagnostic.code, 'source_error');
      assert.match(broken.stats.diagnostic.message, /Invalid OpenCode tool status/);
      assert.equal(broken.stats.diagnostic.retryable, false);
      for (const key of ['compactions', 'taskCount', 'agentRunCount', 'memoryCount']) {
        assert.equal(broken.stats[key], null, `${key} must remain unavailable`);
      }
      assert.equal(broken.stats.messageCount, 1, 'summary message count remains a summary fact');
      assert.equal(broken.stats.tokenCount, 10, 'summary tokens retain their existing meaning');
      assert.equal(broken.stats.durationMs, 200);
      assert.equal(broken.stats.durationSource, 'raw');
      const healthy = body.sessions.find(row => row.id === 'healthy');
      assert.equal(healthy.stats.availability, 'available');
      assert.equal(healthy.stats.protocol, true);
      assert.equal(healthy.stats.diagnostic, null);
    }
    assert.match(stderr,
      /legacy list stats: protocol unavailable for opencode\/broken: .*Invalid OpenCode tool status/,
      'the existing stderr diagnostic remains observable alongside the API diagnostic');
  });
