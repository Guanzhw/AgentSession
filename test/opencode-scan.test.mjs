import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { closeDb, getDb, listSessions } from '../dist/src/db.js';
import { createOpenCodeSqliteAdapter } from '../dist/src/providers/opencode/sqlite-adapter.js';

function fixture(t, withMessages = true) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agentsession-opencode-scan-'));
  const dbPath = path.join(directory, 'opencode.db');
  t.after(() => {
    closeDb(dbPath);
    rmSync(directory, { recursive: true, force: true });
  });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE session (
      id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT, title TEXT, slug TEXT,
      directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
      summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER
    )`);
    const insert = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)');
    const sessions = [
      ['root', null], ['child', 'root'], ['grandchild', 'child'], ['orphan', 'missing-parent'],
      ['archived-root', null], ['archived-child', 'root']
    ];
    for (const [index, [id, parentId]] of sessions.entries()) {
      insert.run(id, parentId, 'project', id === 'grandchild' ? '' : id, `slug-${id}`, '/workspace',
        100 + index, 200 + index, id.startsWith('archived') ? 300 : null);
    }
    if (withMessages) {
      db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)');
      const insertMessage = db.prepare('INSERT INTO message VALUES (?, ?, ?)');
      insertMessage.run('root-user', 'root', JSON.stringify({ role: 'user' }));
      insertMessage.run('root-assistant', 'root', JSON.stringify({ role: 'assistant', tokens: { total: 15 } }));
      insertMessage.run('child-assistant', 'child', JSON.stringify({ role: 'assistant', tokens: {
        input: 4, output: 5, reasoning: 1, cache: { read: 2, write: 3 }
      } }));
    }
  } finally {
    db.close();
  }
  return {
    dbPath,
    adapter: createOpenCodeSqliteAdapter({ id: 'opencode', name: 'OpenCode fixture', defaultDataPath: () => dbPath })
  };
}

test('OpenCode scan indexes canonical descendants and preserves root-list and source semantics', async (t) => {
  const { dbPath, adapter } = fixture(t);
  const before = createHash('sha256').update(readFileSync(dbPath)).digest('hex');
  const scanned = [];
  for await (const session of adapter.scan()) scanned.push(session);
  assert.deepEqual(scanned.map(({ id, parentId }) => [id, parentId]), [
    ['orphan', 'missing-parent'], ['grandchild', 'child'], ['child', 'root'], ['root', null]
  ]);
  assert.equal(new Set(scanned.map(({ id }) => id)).size, scanned.length);
  for (const session of scanned) {
    const readable = adapter.getSession(session.id);
    assert.equal(readable.id, session.id);
    assert.equal(readable.parent_id, session.parentId);
    assert.equal(session.provider, 'opencode');
    assert.equal(session.directory, '/workspace');
    assert.equal(session.messageCount, readable.message_count);
    assert.equal(session.tokenCount, readable.token_count);
  }
  assert.deepEqual(scanned.map(({ id, messageCount, tokenCount }) => [id, messageCount, tokenCount]), [
    ['orphan', 0, null], ['grandchild', 0, null], ['child', 1, 15], ['root', 2, 15]
  ]);
  assert.equal(scanned.find(({ id }) => id === 'grandchild').title, 'slug-grandchild');
  const roots = listSessions(50, 0, '', '', dbPath);
  assert.deepEqual(roots.sessions.map(({ id }) => id), ['root']);
  assert.equal(roots.total, 1);
  closeDb(dbPath);
  assert.equal(createHash('sha256').update(readFileSync(dbPath)).digest('hex'), before);
});

test('OpenCode scan retains available session metadata when the message table is absent', async (t) => {
  const { adapter } = fixture(t, false);
  const scanned = [];
  for await (const session of adapter.scan()) scanned.push(session);
  assert.equal(scanned.length, 4);
  assert.ok(scanned.every(({ messageCount, tokenCount }) => messageCount === 0 && tokenCount === null));
  assert.equal(scanned.find(({ id }) => id === 'child').parentId, 'root');
});

test('OpenCode live Library snapshot reads session metadata without message or usage queries', (t) => {
  const { adapter, dbPath } = fixture(t);
  const db = getDb(dbPath);
  const prepare = db.prepare;
  const queries = [];
  db.prepare = function (sql, ...args) {
    queries.push(sql);
    return prepare.call(this, sql, ...args);
  };
  let sessions;
  try {
    sessions = adapter.getLibrarySessions();
  } finally {
    db.prepare = prepare;
  }
  assert.equal(queries.length, 1);
  assert.match(queries[0], /FROM session WHERE time_archived IS NULL/);
  assert.doesNotMatch(queries[0], /message|token|json_|SUM\(/i);
  assert.deepEqual(sessions.map(({ id, parentId }) => [id, parentId]), [
    ['orphan', 'missing-parent'], ['grandchild', 'child'], ['child', 'root'], ['root', null]
  ]);
  assert.deepEqual(Object.keys(sessions[0]).sort(), ['directory', 'id', 'parentId', 'provider', 'timeCreated', 'timeUpdated', 'title']);
});
