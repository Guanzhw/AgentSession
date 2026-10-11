import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeTargets } from '../v3/npm/native/targets.mjs';
import { assertNativeArtifact } from './v3-native-artifact.mjs';
import { readPackageManifests, assertPublicPrerelease } from './v3-npm-package-contract.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templates = path.join(repo, 'v3', 'npm');
const bundleOptions = {
  'win32-x64': '--windows-bundle',
  'linux-x64': '--linux-bundle',
  'linux-arm64': '--linux-arm64-bundle',
  'darwin-arm64': '--macos-arm64-bundle',
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function parseArgs(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (key === '--public' && !options.has(key)) {
      options.set(key, true);
      index -= 1;
      continue;
    }
    const value = args[index + 1];
    if (!['--output-dir', ...Object.values(bundleOptions), '--source-ledger', '--source-commit'].includes(key)
      || !value || value.startsWith('--') || options.has(key)) {
      throw new Error('Usage: node scripts/v3-prepare-npm-candidate.mjs --output-dir <new-dir> [--windows-bundle <dir>] [--linux-bundle <dir>] [--linux-arm64-bundle <dir>] [--macos-arm64-bundle <dir>] [--source-ledger <file>] [--public --source-commit <40hex>]; supply at least one bundle');
    }
    options.set(key, key === '--source-commit' ? value : path.resolve(value));
  }
  if (!options.has('--output-dir')) throw new Error('Missing required --output-dir');
  const bundles = Object.fromEntries(Object.entries(bundleOptions)
    .filter(([, option]) => options.has(option)).map(([target, option]) => [target, options.get(option)]));
  if (Object.keys(bundles).length === 0) throw new Error('Supply at least one explicit native bundle');
  return {
    output: options.get('--output-dir'),
    bundles,
    ledger: options.get('--source-ledger'),
    public: options.has('--public'),
    sourceCommit: options.get('--source-commit'),
  };
}

async function fileBytes(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${file}`);
  return readFile(file);
}

async function verifyBundle(root, platform, pin, version, sourceCommit) {
  const manifestBytes = await fileBytes(path.join(root, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  if (manifest.version !== version || manifest.platform !== platform || manifest.executable !== pin.executable
    || !Array.isArray(manifest.files)) {
    throw new Error(`${platform} portable manifest has an unexpected identity`);
  }
  const sums = (await fileBytes(path.join(root, 'SHA256SUMS'))).toString('utf8').trim().split(/\r?\n/);
  const checksumRows = new Map();
  for (const line of sums) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`${platform} portable SHA256SUMS has an invalid row`);
    if (checksumRows.has(match[2])) throw new Error(`${platform} portable SHA256SUMS repeats a path`);
    checksumRows.set(match[2], match[1]);
  }
  if (checksumRows.size !== manifest.files.length + 1
    || checksumRows.get('manifest.json') !== sha256(manifestBytes)) {
    throw new Error(`${platform} portable checksum list does not cover the manifest and payload`);
  }
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || entry.path.includes('\\')
      || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0
      || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`${platform} portable manifest contains an invalid payload entry`);
    }
    const normalized = entry.path.split('/');
    if (normalized.some(part => !part || part === '.' || part === '..')
      || path.posix.isAbsolute(entry.path) || path.win32.isAbsolute(entry.path)
      || checksumRows.get(entry.path) !== entry.sha256) {
      throw new Error(`${platform} portable manifest contains an invalid payload path or checksum`);
    }
    const bytes = await fileBytes(path.join(root, ...normalized));
    if (bytes.length !== entry.sizeBytes || sha256(bytes) !== entry.sha256) {
      throw new Error(`${platform} portable payload differs: ${entry.path}`);
    }
  }
  const binaryRow = manifest.files.find(entry => entry.path === pin.executable);
  if (!binaryRow) throw new Error(`${platform} portable manifest does not list its executable`);
  assertNativeArtifact(await fileBytes(path.join(root, pin.executable)), platform);
  const manifestSha256 = sha256(manifestBytes);
  let releaseSourceSha256;
  if (sourceCommit) {
    const sourceBytes = await fileBytes(path.join(root, 'release-source.json'));
    const source = JSON.parse(sourceBytes);
    if (source.schemaVersion !== 1 || source.version !== version || source.platform !== platform
      || source.sourceCommit !== sourceCommit) {
      throw new Error(`${platform} portable release source differs from the frozen release identity`);
    }
    releaseSourceSha256 = sha256(sourceBytes);
  }
  return { manifestSha256, binarySha256: binaryRow.sha256,
    ...(releaseSourceSha256 ? { releaseSourceSha256 } : {}),
    binaryPath: path.join(root, pin.executable) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifests = await readPackageManifests(templates);
  const version = manifests.native.version;
  if (options.public && (Object.keys(options.bundles).length !== Object.keys(nativeTargets).length
    || !/^[a-f0-9]{40}$/.test(options.sourceCommit ?? ''))) {
    throw new Error('Public prerelease requires all four native targets and a full source commit');
  }
  const sourceLedgerSha256 = options.ledger ? sha256(await fileBytes(options.ledger)) : undefined;
  const verified = {};
  for (const [platform, bundle] of Object.entries(options.bundles)) {
    verified[platform] = await verifyBundle(bundle, platform, nativeTargets[platform], version,
      options.public ? options.sourceCommit : undefined);
  }

  const provenance = {
    schemaVersion: 1,
    version,
    ...(sourceLedgerSha256 ? { sourceLedgerSha256 } : {}),
    ...(options.sourceCommit ? { sourceCommit: options.sourceCommit } : {}),
    note: 'Platform hashes identify the explicitly selected portable bundles; sourceCommit records the release workflow checkout when supplied.',
    platforms: Object.fromEntries(Object.entries(verified).map(([platform, value]) => [platform, {
      portableManifestSha256: value.manifestSha256,
      nativeBinarySha256: value.binarySha256,
      ...(value.releaseSourceSha256 ? { releaseSourceSha256: value.releaseSourceSha256 } : {}),
    }])),
  };
  if (options.public) {
    for (const manifest of Object.values(manifests)) {
      manifest.private = false;
      manifest.repository = { type: 'git', url: 'git+https://github.com/Guanzhw/AgentSession.git' };
      manifest.homepage = 'https://github.com/Guanzhw/AgentSession';
      manifest.publishConfig = { access: 'public', tag: 'next', provenance: true };
    }
    assertPublicPrerelease(manifests, provenance);
  }

  await mkdir(path.dirname(options.output), { recursive: true });
  const parent = await realpath(path.dirname(options.output));
  const final = path.join(parent, path.basename(options.output));
  try {
    await lstat(final);
    throw new Error(`Output path already exists: ${final}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const stage = await mkdtemp(path.join(parent, `.${path.basename(final)}.stage-`));
  try {
    for (const name of ['native', 'viewer', 'mcp']) {
      await cp(path.join(templates, name), path.join(stage, name), { recursive: true });
      await copyFile(path.join(repo, 'LICENSE'), path.join(stage, name, 'LICENSE'));
      const manifestPath = path.join(stage, name, 'package.json');
      const manifest = manifests[name];
      manifest.os = [...new Set(Object.keys(verified).map(target => target.split('-')[0]))];
      manifest.cpu = [...new Set(Object.keys(verified).map(target => target.split('-')[1]))];
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    for (const platform of Object.keys(verified)) {
      const target = path.join(stage, 'native', 'bin', platform, nativeTargets[platform].executable);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(verified[platform].binaryPath, target);
      if (platform !== 'win32-x64') await chmod(target, 0o755);
    }
    await writeFile(path.join(stage, 'native', 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
    await rename(stage, final);
    process.stdout.write(`${final}\n`);
  } catch (error) {
    const physical = await realpath(stage);
    if (path.dirname(physical) !== parent) throw new Error(`Refusing staging cleanup outside ${parent}`);
    await rm(physical, { recursive: true, force: true });
    throw error;
  }
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
