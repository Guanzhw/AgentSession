#!/usr/bin/env node

// Build a private Codex search cohort by excluding independently verified
// whole source files. Provider-owned transcripts are only read.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceStat } from './v3-bench-matched.mjs';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpRoot = path.join(scriptRoot, 'tmp');
const defaultManifest = path.join(scriptRoot, 'tmp/v3-performance/manifest.private.json');
const defaultSourceReport = path.join(scriptRoot,
  'tmp/v3-performance/source-search-agent-v3-20260927-a/source-verification.private.json');
const shaPattern = /^[0-9a-f]{64}$/;
const copiedMtimeToleranceMs = 1;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
  : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const pathKey = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
const lexicalOrder = (left, right) => left < right ? -1 : left > right ? 1 : 0;

// Node's utimes converts timestamps through floating-point seconds; NTFS can
// therefore report a sub-millisecond rounding delta after an otherwise exact copy.
export function copiedMtimeMatches(sourceMtimeMs, destinationMtimeMs) {
  return Math.abs(destinationMtimeMs - sourceMtimeMs) < copiedMtimeToleranceMs;
}

function parseArgs(argv) {
  const options = { manifestPath: defaultManifest, sourceReportPath: defaultSourceReport };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag === '--help') return { help: true };
    const key = { '--manifest': 'manifestPath', '--source-report': 'sourceReportPath', '--output-dir': 'outputDir' }[flag];
    if (!key || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error(`Invalid or incomplete option: ${flag}`);
    }
    options[key] = argv[index + 1];
  }
  if (!options.outputDir) throw new Error('--output-dir is required');
  return options;
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function requireObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value;
}

function requireSourcePath(value, base, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`Invalid ${label} path`);
  const fullPath = path.resolve(value);
  if (path.normalize(value) !== value || !inside(base, fullPath)) {
    throw new Error(`Invalid ${label} path`);
  }
  if (!/\.jsonl$/i.test(fullPath)) throw new Error(`Invalid ${label} path extension`);
  return fullPath;
}

async function scanCodexFiles(sourceBase) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => lexicalOrder(left.name, right.name));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) throw new Error('Codex source tree contains a symbolic link');
      if (info.isDirectory()) {
        await walk(fullPath);
      } else if (info.isFile()) {
        if (/\.jsonl\.zst$/i.test(entry.name)) throw new Error('Compressed Codex source is not a JSONL cohort input');
        if (/\.jsonl$/i.test(entry.name)) {
          files.push({ fullPath, relativePath: path.relative(sourceBase, fullPath).replaceAll('\\', '/'), info });
        }
      } else {
        throw new Error('Codex source tree contains an unsupported filesystem entry');
      }
    }
  }
  const sourceInfo = await lstat(sourceBase);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) throw new Error('Codex sessions path is not a real directory');
  await walk(sourceBase);
  return files;
}

async function validateOutputPath(outputDir) {
  const checkout = await realpath(scriptRoot);
  const tmp = path.resolve(tmpRoot);
  const output = path.resolve(outputDir);
  if (!inside(tmp, output)) throw new Error('Output must be inside this checkout tmp/');

  const tmpInfo = await lstat(tmp);
  if (tmpInfo.isSymbolicLink() || !tmpInfo.isDirectory()) throw new Error('tmp/ must be a real directory');
  const realTmp = await realpath(tmp);
  if (!inside(checkout, realTmp)) throw new Error('tmp/ resolves outside checkout');

  const relative = path.relative(tmp, output);
  const pieces = relative.split(path.sep);
  let current = tmp;
  for (let index = 0; index < pieces.length; index++) {
    current = path.join(current, pieces[index]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Output path contains a symbolic link');
      if (index === pieces.length - 1) throw new Error('Output directory already exists; choose a fresh run ID');
      if (!info.isDirectory()) throw new Error('Output parent path is not a directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (index !== pieces.length - 1) throw new Error('Output parent directory does not exist');
    }
  }
  const parent = await realpath(path.dirname(output));
  if (!inside(realTmp, parent)) throw new Error('Output parent resolves outside tmp/');
  try {
    execFileSync('git', ['-C', checkout, 'check-ignore', '--quiet', '--no-index', '--', output], { stdio: 'ignore' });
  } catch {
    throw new Error('Output directory must be ignored by Git');
  }
  return output;
}

function validateReportShape(report) {
  if (report?.format !== 'agentsession-v3-search-source-verification/v1' ||
      report?.verification?.status !== 'source-verified' ||
      !Array.isArray(report.codexSources) || !Array.isArray(report.codexAgentHits) ||
      !Array.isArray(report.duplicateMetadata)) {
    throw new Error('Independent source report is incomplete or unverified');
  }
}

function collectionSignature(records) {
  const canonical = records.map(({ relativePath, bytes, sha256: contentSha }) => [relativePath, bytes, contentSha])
    .sort((left, right) => lexicalOrder(left[0], right[0]));
  return sha256(JSON.stringify(canonical));
}

async function collectExclusions(report, sourceBase, inventory) {
  const excluded = new Map();
  const add = (sourcePath, label, assertedSource) => {
    const fullPath = requireSourcePath(sourcePath, sourceBase, label);
    const record = inventory.get(pathKey(fullPath));
    if (!record) throw new Error(`${label} path was not reported in the independent source inventory`);
    if (assertedSource) {
      const asserted = requireObject(assertedSource, `${label} source facts are missing`);
      if (asserted.bytes !== record.bytes || asserted.sha256 !== record.sha256) {
        throw new Error(`${label} source facts differ from the independent inventory`);
      }
    }
    excluded.set(pathKey(fullPath), record);
  };

  for (const hit of report.codexAgentHits) {
    requireObject(hit, 'Independent source report contains an invalid Codex hit');
    const record = inventory.get(pathKey(requireSourcePath(hit.sourcePath, sourceBase, 'Codex hit')));
    if (!record) throw new Error('Codex hit path was not reported in the independent source inventory');
    if (hit.sourceSha256 !== record.sha256) throw new Error('Codex hit source hash differs from the independent inventory');
    add(hit.sourcePath, 'Codex hit');
  }
  for (const duplicate of report.duplicateMetadata) {
    requireObject(duplicate, 'Independent source report contains invalid duplicate metadata');
    if (duplicate.provider !== 'codex' || !Array.isArray(duplicate.candidates) || duplicate.candidates.length === 0) {
      throw new Error('Independent source report duplicate metadata is incomplete');
    }
    for (const candidate of duplicate.candidates) {
      requireObject(candidate, 'Independent source report contains an invalid duplicate candidate');
      add(candidate.path, 'Duplicate candidate', candidate.source);
    }
  }
  return excluded;
}

export async function buildCommonSearchCohort({ manifestPath, sourceReportPath, outputDir }) {
  if (![manifestPath, sourceReportPath, outputDir].every(value => typeof value === 'string' && value.length > 0)) {
    throw new Error('Manifest, source report, and output directory are required');
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const report = JSON.parse(await readFile(sourceReportPath, 'utf8'));
  requireObject(manifest, 'Performance manifest is invalid');
  if (manifest.format !== 'agentsession-v3-performance-input/v1') {
    throw new Error('Performance manifest format is unsupported');
  }
  requireObject(manifest.providerRoots, 'Performance manifest provider roots are invalid');
  requireObject(manifest.providerRoots.codex, 'Performance manifest Codex root is missing');
  validateReportShape(report);

  const sourceRoot = path.resolve(manifest.codexRoot || '');
  const providerCodexRoot = path.resolve(manifest.providerRoots.codex.path || '');
  if (!manifest.codexRoot || !manifest.providerRoots.codex.path || sourceRoot !== providerCodexRoot) {
    throw new Error('Codex source root differs between manifest fields');
  }
  const sourceBase = path.join(sourceRoot, 'sessions');
  const sourceRootInfo = await lstat(sourceRoot);
  if (sourceRootInfo.isSymbolicLink() || !sourceRootInfo.isDirectory()) throw new Error('Codex source root is not a real directory');
  const sourceBaseInfo = await lstat(sourceBase);
  if (sourceBaseInfo.isSymbolicLink() || !sourceBaseInfo.isDirectory()) throw new Error('Codex sessions path is not a real directory');
  const output = await validateOutputPath(outputDir);
  if (inside(sourceRoot, output) || inside(output, sourceRoot) || pathKey(sourceRoot) === pathKey(output)) {
    throw new Error('Output directory overlaps the Codex source root');
  }

  const originalStat = sourceStat(sourceRoot, true);
  if (canonicalJson(originalStat) !== canonicalJson(manifest.codexStat) ||
      canonicalJson(originalStat) !== canonicalJson(report.providerStats?.codex)) {
    throw new Error('Codex source stat differs from the frozen manifest or independent report');
  }

  const files = await scanCodexFiles(sourceBase);
  if (files.length !== originalStat.fileCount) throw new Error('Codex source inventory contains unreported file types');
  const actualFiles = new Map(files.map(file => [pathKey(file.fullPath), file]));
  const inventory = new Map();
  for (const entry of report.codexSources) {
    requireObject(entry, 'Independent source report contains an invalid Codex source record');
    const fullPath = requireSourcePath(entry.path, sourceBase, 'Codex source inventory');
    const key = pathKey(fullPath);
    if (inventory.has(key) || !actualFiles.has(key)) throw new Error('Independent source inventory path is duplicate or unreported');
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !shaPattern.test(entry.sha256 || '')) {
      throw new Error('Independent source inventory facts are invalid');
    }
    inventory.set(key, { path: fullPath, relativePath: actualFiles.get(key).relativePath,
      bytes: entry.bytes, sha256: entry.sha256 });
  }
  if (inventory.size !== actualFiles.size || [...actualFiles.keys()].some(key => !inventory.has(key))) {
    throw new Error('Independent source inventory is incomplete');
  }

  const excluded = await collectExclusions(report, sourceBase, inventory);
  const records = [];
  for (const [key, file] of actualFiles) {
    const record = inventory.get(key);
    const info = await stat(file.fullPath);
    if (info.size !== record.bytes) throw new Error('Codex source byte count differs from the independent report');
    const actualSha = await hashFile(file.fullPath);
    if (actualSha !== record.sha256) throw new Error('Codex source SHA-256 differs from the independent report');
    const afterHash = await stat(file.fullPath);
    if (afterHash.size !== info.size || afterHash.mtimeMs !== info.mtimeMs) {
      throw new Error('Codex source changed while its independent hash was checked');
    }
    records.push({ ...record, sourcePath: file.fullPath, sourceMtimeMs: info.mtimeMs,
      sourceAtimeMs: info.atimeMs, excluded: excluded.has(key) });
  }

  await mkdir(output, { recursive: false });
  const outputBase = path.join(output, 'sessions');
  const kept = records.filter(record => !record.excluded);
  for (const record of kept) {
    const destination = path.join(outputBase, ...record.relativePath.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(record.sourcePath, destination, constants.COPYFILE_EXCL);
    await utimes(destination, record.sourceAtimeMs / 1000, record.sourceMtimeMs / 1000);
    const destinationInfo = await stat(destination);
    const destinationSha = await hashFile(destination);
    if (destinationInfo.size !== record.bytes || destinationSha !== record.sha256 ||
        !copiedMtimeMatches(record.sourceMtimeMs, destinationInfo.mtimeMs)) {
      throw new Error('Copied Codex source failed byte, SHA-256, or mtime verification');
    }
    const sourceAfterCopy = await stat(record.sourcePath);
    if (sourceAfterCopy.size !== record.bytes || sourceAfterCopy.mtimeMs !== record.sourceMtimeMs) {
      throw new Error('Codex source changed during cohort copy');
    }
  }

  const copiedStat = sourceStat(output, true);
  if (copiedStat.fileCount !== kept.length || copiedStat.totalBytes !== kept.reduce((sum, record) => sum + record.bytes, 0)) {
    throw new Error('Copied Codex cohort inventory is incomplete');
  }
  const outputManifest = structuredClone(manifest);
  outputManifest.codexRoot = output;
  outputManifest.providerRoots.codex.path = output;
  outputManifest.codexStat = copiedStat;

  const copiedBytes = kept.reduce((sum, record) => sum + record.bytes, 0);
  const excludedRecords = records.filter(record => record.excluded);
  const excludedBytes = excludedRecords.reduce((sum, record) => sum + record.bytes, 0);
  const summary = {
    format: 'agentsession-v3-common-search-cohort-summary/v1',
    sourceCount: records.length,
    sourceBytes: records.reduce((sum, record) => sum + record.bytes, 0),
    sourceSetSha256: collectionSignature(records),
    excludedCount: excludedRecords.length,
    excludedBytes,
    excludedSetSha256: collectionSignature(excludedRecords),
    copiedCount: kept.length,
    copiedBytes,
    copiedSetSha256: collectionSignature(kept),
  };
  await writeFile(path.join(output, 'manifest.private.json'), `${JSON.stringify(outputManifest, null, 2)}\n`, { flag: 'wx' });
  await writeFile(path.join(output, 'summary.public.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/v3-build-common-search-cohort.mjs [--manifest PATH] [--source-report PATH] --output-dir PATH');
    return;
  }
  const summary = await buildCommonSearchCohort(options);
  console.log(JSON.stringify({ copiedCount: summary.copiedCount, copiedBytes: summary.copiedBytes,
    excludedCount: summary.excludedCount, excludedBytes: summary.excludedBytes,
    copiedSetSha256: summary.copiedSetSha256 }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
