import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const FIXED_TIME = 1790417752133;
const TARGET_ROLES = [
  ['opencode', 'long'],
  ['claude-code', 'available-live'],
  ['pi', 'available-live'],
  ['codex', 'long-team-compaction'],
  ['codex', 'compact-team-shorter'],
  ['deepseek-harness', 'native-v3-packed-compaction'],
  ['deepseek-harness', 'recorded-subagent-descriptor'],
];
const COLUMNS = [
  'provider', 'session_id', 'custom_title', 'starred', 'deleted', 'permanent',
  'time_starred', 'time_deleted', 'time_renamed',
];

function requireTargets(manifest) {
  if (!Array.isArray(manifest?.captureTargets) || manifest.captureTargets.length !== TARGET_ROLES.length) {
    throw new Error('private manifest target set is incomplete');
  }
  const expected = new Set(TARGET_ROLES.map(([provider, role]) => `${provider}\0${role}`));
  const found = new Map();
  for (const target of manifest.captureTargets) {
    const key = `${target?.provider}\0${target?.role}`;
    if (!expected.has(key) || found.has(key) || typeof target.sessionId !== 'string' || !target.sessionId) {
      throw new Error('private manifest target is invalid');
    }
    found.set(key, target.sessionId);
  }
  return found;
}

function openCapturedMetadata(source) {
  const db = new DatabaseSync(source, { readOnly: true });
  const rows = db.prepare('PRAGMA table_info(session_meta)').all();
  const names = rows.map(row => row.name);
  if (COLUMNS.some(name => !names.includes(name))) {
    db.close();
    throw new Error('captured metadata schema is incompatible');
  }
  return db;
}

function initializeFunctional(source, destination) {
  const captured = openCapturedMetadata(source);
  try {
    const schema = captured.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='session_meta'").get().sql;
    const rows = captured.prepare(`SELECT ${COLUMNS.join(', ')} FROM session_meta`).all();
    const db = new DatabaseSync(destination);
    try {
      db.exec(schema);
      const insert = db.prepare(`INSERT INTO session_meta (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`);
      for (const row of rows) insert.run(...COLUMNS.map(column => row[column]));
    } finally {
      db.close();
    }
  } finally {
    captured.close();
  }
}

function addControlledStates(file, targets) {
  const db = new DatabaseSync(file);
  try {
    const exists = db.prepare('SELECT 1 FROM session_meta WHERE provider = ? AND session_id = ?');
    const insert = db.prepare(`INSERT INTO session_meta (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`);
    function add(provider, sessionId, { title = null, starred = 0, deleted = 0, permanent = 0 } = {}) {
      if (exists.get(provider, sessionId)) throw new Error('controlled metadata key overlaps captured user data');
      insert.run(
        provider, sessionId, title, starred, deleted, permanent,
        starred ? FIXED_TIME : null, deleted ? FIXED_TIME : null, title ? FIXED_TIME : null,
      );
    }

    db.exec('BEGIN');
    try {
      for (const [provider, role] of TARGET_ROLES) {
        const sessionId = targets.get(`${provider}\0${role}`);
        const flags = provider === 'opencode' && role === 'long'
          ? { title: 'V3 controlled title', starred: 1 }
          : provider === 'codex' && role === 'compact-team-shorter'
            ? { deleted: 1 }
            : provider === 'deepseek-harness' && role === 'recorded-subagent-descriptor'
              ? { deleted: 1, permanent: 1 }
              : {};
        add(provider, sessionId, flags);
      }
      add('openclaw', 'v3-retired-openclaw-row', { title: 'Retired metadata retained' });
      add('hermes', 'v3-retired-hermes-row', { starred: 1 });
      add('opencode', 'v3-meta-provider-key-check', { title: 'OpenCode key' });
      add('codex', 'v3-meta-provider-key-check', { title: 'Codex key' });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

function restoreControlledSoftDelete(file, targetId) {
  const db = new DatabaseSync(file);
  try {
    const result = db.prepare(`UPDATE session_meta SET deleted = 0, time_deleted = NULL
      WHERE provider = 'codex' AND session_id = ? AND deleted = 1 AND permanent = 0`).run(targetId);
    if (result.changes !== 1) throw new Error('controlled restore state is missing');
  } finally {
    db.close();
  }
}

export async function buildMetadataSeeds({ source, manifest, outputDir }) {
  const targets = requireTargets(JSON.parse(await readFile(manifest, 'utf8')));
  const sourcePath = path.resolve(source);
  const outputPath = path.resolve(outputDir);
  if (sourcePath === outputPath || sourcePath.startsWith(`${outputPath}${path.sep}`)) {
    throw new Error('captured metadata source must be outside the output directory');
  }
  if (await stat(outputPath).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))) {
    throw new Error('metadata seed output directory already exists');
  }
  for (const suffix of ['-wal', '-shm']) {
    if (await stat(`${sourcePath}${suffix}`).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))) {
      throw new Error('captured metadata source has an active SQLite sidecar');
    }
  }
  const sourceBytes = await readFile(sourcePath);
  const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  const captured = openCapturedMetadata(sourcePath);
  captured.close();
  await mkdir(outputPath, { recursive: true });
  const files = [
    path.join(outputPath, 'functional-before.db'),
    path.join(outputPath, 'functional-after-restore.db'),
    path.join(outputPath, 'migration-before.db'),
    path.join(outputPath, 'migration-after-restore.db'),
  ];
  initializeFunctional(sourcePath, files[0]);
  addControlledStates(files[0], targets);
  await copyFile(files[0], files[1]);
  restoreControlledSoftDelete(files[1], targets.get('codex\0compact-team-shorter'));
  await copyFile(sourcePath, files[2]);
  addControlledStates(files[2], targets);
  await copyFile(files[2], files[3]);
  restoreControlledSoftDelete(files[3], targets.get('codex\0compact-team-shorter'));
  const afterHash = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
  if (afterHash !== sourceHash) throw new Error('captured metadata source changed during seed generation');
  return { files, sourceHash };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== '--source-db' || args[2] !== '--manifest' || args[4] !== '--output-dir') {
    throw new Error('usage: node scripts/v3-build-metadata-seeds.mjs --source-db PATH --manifest PATH --output-dir PATH');
  }
  const tmpRoot = path.resolve('tmp');
  const outputDir = path.resolve(args[5]);
  if (!outputDir.startsWith(`${tmpRoot}${path.sep}`)) throw new Error('output must be inside ignored tmp/');
  const result = await buildMetadataSeeds({ source: args[1], manifest: args[3], outputDir });
  console.log(`Created ${result.files.length} private metadata seeds; source sha256=${result.sourceHash.slice(0, 12)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
