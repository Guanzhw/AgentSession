import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { deriveOpenCodeToolMatches } from '../scripts/v3-tool-name-opencode-oracle.mjs';

test('OpenCode tool oracle reads owned v2 source rows, first hit and canonical part ID', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tool-oracle-'));
  const file = path.join(dir, 'source.db');
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, slug TEXT, directory TEXT, time_updated INTEGER, time_archived INTEGER, fork_session_id TEXT)');
    db.exec('CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT)');
    const session = db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?)');
    session.run('owned', 'Original title', 'slug', '/project', 90, null, 'parent');
    session.run('archived', 'Archived', null, '/project', 80, 5, null);
    session.run('future', 'Future', null, '/project', 110, null, null);
    const message = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)');
    const parts = content => JSON.stringify({ content });
    message.run('copied_1', 'owned', 'assistant', 1, parts([{ type: 'tool', name: 'read' }]));
    message.run('first', 'owned', 'assistant', 2, parts([{ type: 'text', text: 'ignore' }, { type: 'tool', name: 'Read_File' }]));
    message.run('later', 'owned', 'assistant', 3, parts([{ type: 'tool', name: 'read' }]));
    message.run('archive', 'archived', 'assistant', 1, parts([{ type: 'tool', name: 'read' }]));
    message.run('future-hit', 'future', 'assistant', 1, parts([{ type: 'tool', name: 'read' }]));
  } finally { db.close(); }
  try {
    assert.deepEqual(deriveOpenCodeToolMatches(file, 'read', 100), [{
      session: { provider: 'opencode', sessionId: 'owned' },
      event: { provider: 'opencode', sessionId: 'owned', messageId: 'first:content:1', segment: 'tool' },
      matchField: 'toolName', matchRole: 'tool', snippet: 'Read_File', title: 'Original title',
      directory: '/project', updatedAt: 90, untrustedContent: true
    }]);
  } finally { await rm(dir, { recursive: true }); }
});
