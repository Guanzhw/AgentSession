import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const format = 'agentsession-v3-codex-source-inventory-proof/v1';
const digest = value => createHash('sha256').update(value).digest('hex');
const comparePaths = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));

function pathSetDigest(paths) {
  const hash = createHash('sha256').update('agentsession-codex-path-set/v1\0');
  for (const value of [...paths].sort(comparePaths)) hash.update(value).update('\0');
  return hash.digest('hex');
}

function checkedManifestPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')
      || value.startsWith('/') || /^[a-z]:/i.test(value)) {
    throw new Error('invalid manifest path');
  }
  const segments = value.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('invalid manifest path');
  }
  return value;
}

async function declaredRoot(rootValue) {
  if (typeof rootValue !== 'string' || !path.isAbsolute(rootValue)) {
    throw new Error('manifest root must be absolute');
  }
  const declared = path.resolve(rootValue);
  let metadata;
  try {
    metadata = await lstat(declared);
  } catch {
    throw new Error('declared root is unavailable');
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('declared root must be a physical directory');
  }
  let canonical;
  try {
    canonical = await realpath(declared);
  } catch {
    throw new Error('declared root is unavailable');
  }
  if (path.basename(canonical).toLowerCase() !== 'frozen-codex') {
    throw new Error('declared root must be named frozen-codex');
  }
  return canonical;
}

async function enumerateProviderFiles(root) {
  const pending = [root];
  const jsonl = [];
  const compressed = [];
  let regularFileCount = 0;
  let symlinkCount = 0;

  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      throw new Error('unable to enumerate declared root');
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        symlinkCount++;
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      regularFileCount++;
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (relative.includes('\\')) throw new Error('unsupported path in declared root');
      if (relative.endsWith('.jsonl')) jsonl.push(relative);
      else if (relative.endsWith('.jsonl.zst')) compressed.push(relative);
    }
  }

  const eligibleCompressed = [];
  for (const relative of compressed) {
    const plainRelative = relative.slice(0, -4);
    const plainAbsolute = path.join(root, ...plainRelative.split('/'));
    let plainExists = false;
    try {
      await stat(plainAbsolute);
      plainExists = true;
    } catch {
      // Rust Path::exists also treats metadata errors as false.
    }
    if (!plainExists) eligibleCompressed.push(relative);
  }

  return {
    paths: [...jsonl, ...eligibleCompressed],
    regularFileCount,
    symlinkCount,
    jsonlCount: jsonl.length,
    compressedCandidateCount: compressed.length,
    eligibleCompressedCount: eligibleCompressed.length,
    suppressedCompressedCount: compressed.length - eligibleCompressed.length,
  };
}

/**
 * Compare the manifest's path set with regular files under its declared
 * `frozen-codex` root. This enumerates names and stats compressed siblings;
 * it does not open or hash source contents.
 */
export async function verifyInventory(manifestPath, options = {}) {
  let manifestBytes;
  let manifest;
  try {
    manifestBytes = await readFile(manifestPath);
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('unable to read a valid manifest');
  }
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.files)) {
    throw new Error('manifest files must be an array');
  }
  if (options.expectedFiles !== undefined
      && (!Number.isInteger(options.expectedFiles) || options.expectedFiles < 0)) {
    throw new Error('expected file count must be a non-negative integer');
  }

  const root = await declaredRoot(manifest.root);
  const manifestPaths = [];
  const occurrences = new Map();
  for (const entry of manifest.files) {
    const relative = checkedManifestPath(entry?.path);
    manifestPaths.push(relative);
    occurrences.set(relative, (occurrences.get(relative) ?? 0) + 1);
  }

  const inventory = await enumerateProviderFiles(root);
  const rootSet = new Set(inventory.paths);
  const manifestSet = new Set(manifestPaths);
  const omitted = [...rootSet].filter(relative => !manifestSet.has(relative));
  const outsideInventory = [...manifestSet].filter(relative => !rootSet.has(relative));
  const duplicatePaths = [...occurrences].filter(([, count]) => count > 1).map(([relative]) => relative);
  const duplicateEntries = manifestPaths.length - manifestSet.size;
  const expectedCountMatches = options.expectedFiles === undefined
    || manifestPaths.length === options.expectedFiles;
  const complete = omitted.length === 0 && outsideInventory.length === 0
    && duplicateEntries === 0 && expectedCountMatches;

  return {
    format,
    status: complete ? 'complete' : 'mismatch',
    scope: 'declared-root-only',
    rootLabel: 'frozen-codex',
    rootSha256: digest(root),
    manifestSha256: digest(manifestBytes),
    expectedManifestEntries: options.expectedFiles ?? null,
    manifestEntries: manifestPaths.length,
    manifestUniquePaths: manifestSet.size,
    duplicateManifestEntries: duplicateEntries,
    duplicateManifestPaths: { count: duplicatePaths.length, sha256: pathSetDigest(duplicatePaths) },
    rootRegularFiles: inventory.regularFileCount,
    rootSymlinksSkipped: inventory.symlinkCount,
    rootJsonlFiles: inventory.jsonlCount,
    rootCompressedCandidates: inventory.compressedCandidateCount,
    rootCompressedEligible: inventory.eligibleCompressedCount,
    rootCompressedSuppressed: inventory.suppressedCompressedCount,
    rootEligibleFiles: rootSet.size,
    manifestPathSetSha256: pathSetDigest(manifestSet),
    rootPathSetSha256: pathSetDigest(rootSet),
    omittedFromManifest: { count: omitted.length, sha256: pathSetDigest(omitted) },
    manifestOutsideInventory: { count: outsideInventory.length, sha256: pathSetDigest(outsideInventory) },
    complete,
  };
}

async function main() {
  if (process.argv.length !== 3) {
    process.stderr.write('Usage: node scripts/v3-verify-codex-usage-inventory.mjs <manifest.json>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await verifyInventory(process.argv[2], { expectedFiles: 840 });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.complete) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'inventory proof failed';
    process.stderr.write(`${JSON.stringify({ format, status: 'error', error: message })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
