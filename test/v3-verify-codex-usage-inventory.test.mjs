import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyInventory } from '../scripts/v3-verify-codex-usage-inventory.mjs';

async function fixture(t, paths) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'codex-inventory-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'frozen-codex');
  await mkdir(root);
  for (const relativePath of paths) {
    const absolute = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, 'public synthetic fixture\n');
  }
  const manifest = path.join(parent, 'manifest.json');
  return { root, manifest };
}

async function writeManifest(f, paths) {
  await writeFile(f.manifest, JSON.stringify({ root: f.root,
    files: paths.map(path => ({ path, bytes: 0, sha256: '0'.repeat(64) })) }));
}

test('reports a Codex source omitted from the manifest on a public synthetic tree', async t => {
  const f = await fixture(t, ['a.jsonl', 'nested/b.jsonl']);
  await writeManifest(f, ['a.jsonl']);

  const result = await verifyInventory(f.manifest);

  assert.equal(result.omittedFromManifest.count, 1);
  assert.equal(result.manifestOutsideInventory.count, 0);
  assert.equal(result.complete, false);
});

test('matches Codex regular-file, compressed-pair, and no-follow symlink eligibility', async t => {
  const f = await fixture(t, ['plain.jsonl', 'single.jsonl.zst', 'paired.jsonl',
    'paired.jsonl.zst', 'readme.txt']);
  await mkdir(path.join(f.root, 'directory.jsonl'));
  await writeFile(path.join(f.root, 'directory.jsonl.zst'), 'compressed fixture');

  const outside = path.join(path.dirname(f.root), 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'external.jsonl'), 'must not be traversed');
  let symlinksCreated = 0;
  for (const [target, linkPath, type] of [
    [path.join(f.root, 'plain.jsonl'), path.join(f.root, 'linked.jsonl'), 'file'],
    [outside, path.join(f.root, 'linked-directory'), process.platform === 'win32' ? 'junction' : 'dir'],
  ]) {
    try {
      await symlink(target, linkPath, type);
      symlinksCreated++;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS', 'EINVAL'].includes(error.code)) throw error;
    }
  }
  if (!symlinksCreated) t.diagnostic('host did not allow creation of a symlink fixture');

  const expected = ['plain.jsonl', 'single.jsonl.zst', 'paired.jsonl'];
  await writeManifest(f, expected);
  const result = await verifyInventory(f.manifest, { expectedFiles: expected.length });

  assert.equal(result.complete, true);
  assert.equal(result.rootRegularFiles, 6);
  assert.equal(result.rootJsonlFiles, 2);
  assert.equal(result.rootCompressedCandidates, 3);
  assert.equal(result.rootCompressedEligible, 1);
  assert.equal(result.rootCompressedSuppressed, 2);
  assert.equal(result.rootEligibleFiles, 3);
  assert.equal(result.rootSymlinksSkipped, symlinksCreated);
  assert.equal(JSON.stringify(result).includes(f.root), false);
  assert.equal(JSON.stringify(result).includes('must not be traversed'), false);
});

test('reports extra and duplicate manifest entries without exposing their paths', async t => {
  const f = await fixture(t, ['a.jsonl']);
  await writeManifest(f, ['a.jsonl', 'private-looking-name.jsonl', 'a.jsonl']);

  const result = await verifyInventory(f.manifest);
  const serialized = JSON.stringify(result);

  assert.equal(result.omittedFromManifest.count, 0);
  assert.equal(result.manifestOutsideInventory.count, 1);
  assert.equal(result.duplicateManifestEntries, 1);
  assert.equal(result.duplicateManifestPaths.count, 1);
  assert.equal(result.complete, false);
  assert.equal(serialized.includes('private-looking-name'), false);
  assert.equal(serialized.includes(f.root), false);
});
