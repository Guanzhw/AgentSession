import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sourceStat } from '../scripts/v3-bench-matched.mjs';
import { buildCommonSearchCohort, copiedMtimeMatches } from '../scripts/v3-build-common-search-cohort.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tmp');
const sha = value => createHash('sha256').update(value).digest('hex');
const inside = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

async function removeFixtureSafely(directory) {
  const absoluteTmp = path.resolve(tmp);
  const absoluteDirectory = path.resolve(directory);
  const tmpInfo = await lstat(absoluteTmp);
  const directoryInfo = await lstat(absoluteDirectory);
  if (tmpInfo.isSymbolicLink() || !tmpInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
      !inside(absoluteTmp, absoluteDirectory)) {
    throw new Error('Refusing to recursively clean a fixture outside tmp/ or through a symbolic link');
  }
  const realTmp = await realpath(absoluteTmp);
  const realDirectory = await realpath(absoluteDirectory);
  if (!inside(realTmp, realDirectory)) throw new Error('Refusing to clean a fixture outside the real tmp/ directory');
  await rm(absoluteDirectory, { recursive: true, force: false });
}

async function fixture(t) {
  await mkdir(tmp, { recursive: true });
  const directory = await mkdtemp(path.join(tmp, 'v3-common-search-cohort-test-'));
  t.after(() => removeFixtureSafely(directory));

  const sourceRoot = path.join(directory, 'codex-source');
  const files = [
    ['sessions/2026/09/one.jsonl', '{"type":"session_meta","payload":{"id":"one"}}\n'],
    ['sessions/2026/09/two.jsonl', '{"type":"session_meta","payload":{"id":"two"}}\n'],
    ['sessions/2026/10/three.jsonl', '{"type":"session_meta","payload":{"id":"three"}}\n'],
  ];
  const sources = [];
  for (let index = 0; index < files.length; index++) {
    const [relative, contents] = files[index];
    const sourcePath = path.join(sourceRoot, ...relative.split('/'));
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, contents);
    const fixedTime = new Date(Date.UTC(2026, 0, index + 1, 12));
    await utimes(sourcePath, fixedTime, fixedTime);
    const info = await stat(sourcePath);
    sources.push({ path: sourcePath, relative, bytes: info.size, sha256: sha(contents), mtimeMs: info.mtimeMs });
  }

  const stats = sourceStat(sourceRoot, true);
  const report = {
    format: 'agentsession-v3-search-source-verification/v1',
    verification: { status: 'source-verified' },
    providerStats: { codex: stats },
    codexSources: sources.map(({ path: sourcePath, bytes, sha256 }) => ({ path: sourcePath, bytes, sha256 })),
    codexAgentHits: [{ sourcePath: sources[0].path, sourceSha256: sources[0].sha256 }],
    duplicateMetadata: [{ provider: 'codex', candidates: [sources[0], sources[1]].map(source => ({
      path: source.path, source: { bytes: source.bytes, sha256: source.sha256 },
    })) }],
  };
  const manifest = {
    format: 'agentsession-v3-performance-input/v1',
    codexRoot: sourceRoot,
    providerRoots: {
      codex: { cliFlag: '--codex-dir', path: sourceRoot },
      opencode: { cliFlag: '--opencode-db', path: 'frozen-opencode.db' },
    },
    codexStat: stats,
    baselineSha: 'baseline-frozen',
    queries: [{ label: 'common', query: 'a', querySha256: sha('a'), providers: ['codex'], fields: ['user'], limit: 20 }],
    updatedBeforeUnixMs: 123,
    repetitions: 5,
    pairedOrder: ['v2', 'v3'],
    cacheLabel: 'frozen-cache-state',
  };
  const reportPath = path.join(directory, 'source-verification.private.json');
  const manifestPath = path.join(directory, 'manifest.private.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, sourceRoot, sources, report, reportPath, manifest, manifestPath,
    outputDir: path.join(directory, 'cohort-output') };
}

test('copies the unreported remainder after excluding the deduplicated full-file union', async t => {
  const f = await fixture(t);
  const before = await Promise.all(f.sources.map(async source => ({
    contents: await readFile(source.path), info: await stat(source.path),
  })));

  const result = await buildCommonSearchCohort({ manifestPath: f.manifestPath,
    sourceReportPath: f.reportPath, outputDir: f.outputDir });

  assert.equal(result.copiedCount, 1);
  assert.equal(result.excludedCount, 2);
  assert.equal(result.copiedBytes, f.sources[2].bytes);
  assert.equal(result.excludedBytes, f.sources[0].bytes + f.sources[1].bytes);

  const copiedPath = path.join(f.outputDir, 'sessions/2026/10/three.jsonl');
  assert.deepEqual(await readFile(copiedPath), before[2].contents);
  assert.equal((await stat(copiedPath)).mtimeMs, before[2].info.mtimeMs);
  assert.equal(sha(await readFile(copiedPath)), f.sources[2].sha256);

  for (let index = 0; index < f.sources.length; index++) {
    assert.deepEqual(await readFile(f.sources[index].path), before[index].contents);
    assert.equal((await stat(f.sources[index].path)).mtimeMs, before[index].info.mtimeMs);
  }

  const actualManifest = JSON.parse(await readFile(path.join(f.outputDir, 'manifest.private.json'), 'utf8'));
  const expectedManifest = structuredClone(f.manifest);
  expectedManifest.codexRoot = f.outputDir;
  expectedManifest.providerRoots.codex.path = f.outputDir;
  expectedManifest.codexStat = sourceStat(f.outputDir, true);
  assert.deepEqual(actualManifest, expectedManifest);

  const summaryText = await readFile(path.join(f.outputDir, 'summary.public.json'), 'utf8');
  const summary = JSON.parse(summaryText);
  assert.equal(summary.copiedCount, 1);
  assert.equal(summary.copiedBytes, f.sources[2].bytes);
  assert.match(summary.copiedSetSha256, /^[0-9a-f]{64}$/);
  assert.match(summary.excludedSetSha256, /^[0-9a-f]{64}$/);
  assert.equal(summaryText.includes(f.sourceRoot), false);
  assert.equal(summaryText.includes(f.outputDir), false);
});

test('rejects an incomplete independent report before creating output', async t => {
  const f = await fixture(t);
  const incomplete = { ...f.report };
  delete incomplete.duplicateMetadata;
  await writeFile(f.reportPath, JSON.stringify(incomplete));

  await assert.rejects(buildCommonSearchCohort({ manifestPath: f.manifestPath,
    sourceReportPath: f.reportPath, outputDir: f.outputDir }), /incomplete/i);
  await assert.rejects(stat(f.outputDir), { code: 'ENOENT' });
});

test('rejects an excluded path that the independent file inventory does not report', async t => {
  const f = await fixture(t);
  const unreported = path.join(f.sourceRoot, 'sessions/2026/09/not-in-inventory.jsonl');
  f.report.codexAgentHits.push({ sourcePath: unreported, sourceSha256: sha('unreported') });
  await writeFile(f.reportPath, JSON.stringify(f.report));

  await assert.rejects(buildCommonSearchCohort({ manifestPath: f.manifestPath,
    sourceReportPath: f.reportPath, outputDir: f.outputDir }), /not reported/i);
  await assert.rejects(stat(f.outputDir), { code: 'ENOENT' });
});

test('rejects changed source bytes even when its path remains in the report', async t => {
  const f = await fixture(t);
  const changed = await readFile(f.sources[2].path);
  changed[0] = changed[0] === 0x7b ? 0x5b : 0x7b;
  await writeFile(f.sources[2].path, changed);
  const fixedTime = new Date(f.sources[2].mtimeMs);
  await utimes(f.sources[2].path, fixedTime, fixedTime);

  await assert.rejects(buildCommonSearchCohort({ manifestPath: f.manifestPath,
    sourceReportPath: f.reportPath, outputDir: f.outputDir }), /source.*(sha|byte)|report.*(sha|byte)/i);
  await assert.rejects(stat(f.outputDir), { code: 'ENOENT' });
});

test('rejects an existing or symbolic-link output root', async t => {
  const f = await fixture(t);
  await mkdir(f.outputDir);
  await writeFile(path.join(f.outputDir, 'keep.txt'), 'existing output');
  await assert.rejects(buildCommonSearchCohort({ manifestPath: f.manifestPath,
    sourceReportPath: f.reportPath, outputDir: f.outputDir }), /already exists/i);
  assert.equal(await readFile(path.join(f.outputDir, 'keep.txt'), 'utf8'), 'existing output');

  const linkPath = path.join(f.directory, 'output-link');
  try {
    await symlink(f.sourceRoot, linkPath, 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`Directory link creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(buildCommonSearchCohort({ manifestPath: f.manifestPath,
    sourceReportPath: f.reportPath, outputDir: linkPath }), /symbolic link/i);
});

test('accepts sub-millisecond copy timestamp rounding but rejects a full millisecond shift', () => {
  const sourceMtimeMs = 1_790_417_752_133.245;
  assert.equal(copiedMtimeMatches(sourceMtimeMs, sourceMtimeMs - 0.000244140625), true);
  assert.equal(copiedMtimeMatches(sourceMtimeMs, sourceMtimeMs + 0.999), true);
  assert.equal(copiedMtimeMatches(sourceMtimeMs, sourceMtimeMs - 1), false);
  assert.equal(copiedMtimeMatches(sourceMtimeMs, sourceMtimeMs + 1), false);
});
