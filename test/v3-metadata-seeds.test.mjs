import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { buildMetadataSeeds } from '../scripts/v3-build-metadata-seeds.mjs';

const BASE_SCHEMA = `
  CREATE TABLE session_meta (
    provider TEXT NOT NULL, session_id TEXT NOT NULL, custom_title TEXT,
    starred INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, permanent INTEGER DEFAULT 0,
    time_starred INTEGER, time_deleted INTEGER, time_renamed INTEGER,
    PRIMARY KEY (provider, session_id)
  );
  CREATE TABLE session_index (provider TEXT NOT NULL, id TEXT NOT NULL, title TEXT);
`;

async function fixture(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'v3-meta-seed-'));
  try {
    const source = path.join(dir, 'captured.db');
    const manifest = path.join(dir, 'manifest.private.json');
    const outputDir = path.join(dir, 'tmp', 'seeds');
    const db = new DatabaseSync(source);
    db.exec(BASE_SCHEMA);
    db.prepare('INSERT INTO session_meta (provider, session_id, custom_title, starred) VALUES (?, ?, ?, ?)')
      .run('codex', 'original-user-id', 'Original title', 1);
    db.prepare('INSERT INTO session_index (provider, id, title) VALUES (?, ?, ?)')
      .run('hermes', 'old-index-id', 'Retired index');
    db.close();
    const targets = [
      ['opencode', 'long'], ['claude-code', 'available-live'], ['pi', 'available-live'],
      ['codex', 'long-team-compaction'], ['codex', 'compact-team-shorter'],
      ['deepseek-harness', 'native-v3-packed-compaction'],
      ['deepseek-harness', 'recorded-subagent-descriptor'],
    ].map(([provider, role]) => ({ provider, role, sessionId: `${provider}-${role}` }));
    await writeFile(manifest, JSON.stringify({ captureTargets: targets }));
    return await run({ source, manifest, outputDir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('metadata seeds preserve the captured DB while separating functional and migration states', async () => {
  await fixture(async ({ source, manifest, outputDir }) => {
    const originalHash = sha256(await readFile(source));
    const result = await buildMetadataSeeds({ source, manifest, outputDir });
    assert.deepEqual(result.files.map(file => path.basename(file)), [
      'functional-before.db', 'functional-after-restore.db',
      'migration-before.db', 'migration-after-restore.db',
    ]);
    assert.equal(sha256(await readFile(source)), originalHash);
    for (const file of result.files) {
      const db = new DatabaseSync(file, { readOnly: true });
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all().map(row => row.name);
      assert.equal(tables.includes('session_meta'), true);
      assert.equal(tables.includes('session_index'), file.includes('migration-'));
      assert.equal(db.prepare("SELECT custom_title FROM session_meta WHERE provider='codex' AND session_id='original-user-id'").get().custom_title, 'Original title');
      assert.equal(db.prepare("SELECT starred FROM session_meta WHERE provider='opencode' AND session_id='opencode-long'").get().starred, 1);
      assert.equal(db.prepare("SELECT custom_title FROM session_meta WHERE provider='opencode' AND session_id='opencode-long'").get().custom_title, 'V3 controlled title');
      assert.equal(db.prepare("SELECT permanent FROM session_meta WHERE provider='deepseek-harness' AND session_id='deepseek-harness-recorded-subagent-descriptor'").get().permanent, 1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM session_meta WHERE provider IN ('openclaw', 'hermes')").get().n, 2);
      assert.equal(db.prepare("SELECT count(*) AS n FROM session_meta WHERE session_id='v3-meta-provider-key-check'").get().n, 2);
      if (file.includes('migration-')) {
        assert.equal(db.prepare("SELECT title FROM session_index WHERE provider='hermes' AND id='old-index-id'").get().title, 'Retired index');
      }
      const hidden = db.prepare("SELECT deleted, permanent, time_deleted FROM session_meta WHERE provider='codex' AND session_id='codex-compact-team-shorter'").get();
      if (file.includes('after-restore')) {
        assert.deepEqual([hidden.deleted, hidden.permanent, hidden.time_deleted], [0, 0, null]);
      } else {
        assert.deepEqual([hidden.deleted, hidden.permanent], [1, 0]);
        assert.equal(typeof hidden.time_deleted, 'number');
      }
      db.close();
    }
  });
});

test('metadata seed generation refuses existing output and malformed target roles', async () => {
  await fixture(async ({ source, manifest, outputDir }) => {
    await buildMetadataSeeds({ source, manifest, outputDir });
    await assert.rejects(buildMetadataSeeds({ source, manifest, outputDir }), /already exists/);
  });
  await fixture(async ({ source, manifest, outputDir }) => {
    const value = JSON.parse(await readFile(manifest, 'utf8'));
    value.captureTargets.pop();
    await writeFile(manifest, JSON.stringify(value));
    await assert.rejects(buildMetadataSeeds({ source, manifest, outputDir }), /target/);
  });
});
