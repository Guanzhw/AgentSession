import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeTargets } from '../v3/npm/native/targets.mjs';
import { assertNativeArtifact } from './v3-native-artifact.mjs';
import { readPackageManifests, tarballName, assertPublicPrerelease } from './v3-npm-package-contract.mjs';

const names = ['native', 'viewer', 'mcp'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`npm CLI unavailable at: ${candidates.join(', ')}`);
  return found;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000,
    maxBuffer: 2_000_000 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}\n${result.stdout}`);
  }
  return result.stdout;
}

async function normalizeModes(root, packageName, relative = '') {
  await chmod(path.join(root, relative), 0o755);
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Package template contains a symlink: ${packageName}/${child}`);
    if (entry.isDirectory()) {
      await normalizeModes(root, packageName, child);
    } else if (entry.isFile()) {
      const executable = packageName === 'native' && Object.entries(nativeTargets)
        .some(([target, pin]) => target !== 'win32-x64' && child === `bin/${target}/${pin.executable}`)
        || packageName === 'viewer' && child === 'bin/agentsession.mjs'
        || packageName === 'mcp' && child === 'bin/agentsession-mcp.mjs';
      await chmod(path.join(root, child), executable ? 0o755 : 0o644);
    } else {
      throw new Error(`Package template contains a non-file entry: ${packageName}/${child}`);
    }
  }
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--stage-dir') {
    throw new Error('Usage: node scripts/v3-pack-npm-candidate.mjs --stage-dir <prepared-directory>');
  }
  const stage = path.resolve(process.argv[3]);
  const provenance = JSON.parse(await readFile(path.join(stage, 'native', 'provenance.json'), 'utf8'));
  const manifests = await readPackageManifests(stage);
  if (provenance.schemaVersion !== 1 || provenance.version !== manifests.native.version) {
    throw new Error('Prepared package version differs from native provenance');
  }
  if (Object.values(manifests).some(manifest => manifest.private !== true)) {
    assertPublicPrerelease(manifests, provenance);
  }
  const tarballs = names.map(name => tarballName(manifests[name]));
  const platforms = Object.keys(provenance.platforms);
  if (!platforms.length) throw new Error('Prepared candidate contains no native target');
  const payloadTargets = await readdir(path.join(stage, 'native', 'bin'));
  if (payloadTargets.length !== platforms.length || payloadTargets.some(target => !platforms.includes(target))) {
    throw new Error('Prepared native payload targets differ from pinned provenance');
  }
  if (!['linux', 'darwin'].includes(process.platform)
    && !(process.platform === 'win32' && platforms.every(target => target === 'win32-x64'))) {
    throw new Error('Pack candidates containing Unix executables on Linux/WSL ext4 or macOS to preserve executable mode.');
  }
  for (const platform of platforms) {
    const pin = nativeTargets[platform];
    if (!pin) throw new Error(`Unsupported prepared native target: ${platform}`);
    const binary = path.join(stage, 'native', 'bin', platform, pin.executable);
    const entries = await readdir(path.dirname(binary));
    if (entries.length !== 1 || entries[0] !== pin.executable) {
      throw new Error(`Prepared ${platform} payload contains an unpinned file`);
    }
    const bytes = await readFile(binary);
    assertNativeArtifact(bytes, platform);
    if (hash(bytes) !== provenance.platforms[platform].nativeBinarySha256) {
      throw new Error(`Prepared ${platform} binary differs from pinned provenance`);
    }
  }
  for (const tarball of tarballs) {
    try { await lstat(path.join(stage, tarball)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`Refusing to replace existing tarball: ${tarball}`);
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-npm-pack-'));
  try {
    for (const name of names) {
      await cp(path.join(stage, name), path.join(scratch, name), { recursive: true });
      await normalizeModes(path.join(scratch, name), name);
    }
    for (const platform of platforms.filter(target => target !== 'win32-x64')) {
      const executable = path.join(scratch, 'native', 'bin', platform, nativeTargets[platform].executable);
      assert.ok(((await stat(executable)).mode & 0o111) !== 0,
        `${platform} pack source must have an executable mode`);
    }
    const npm = npmCli();
    for (const name of names) {
      run(process.execPath, [npm, 'pack', '--offline', '--ignore-scripts',
        '--pack-destination', scratch, path.join(scratch, name)]);
    }
    const archiveListing = run('tar', ['-tvzf', tarballs[0]], scratch);
    for (const platform of platforms.filter(target => target !== 'win32-x64')) {
      const binaryRow = archiveListing.split(/\r?\n/)
        .find(row => row.endsWith(`package/bin/${platform}/${nativeTargets[platform].executable}`));
      if (!binaryRow || !/^-rwx/.test(binaryRow)) {
        throw new Error(`Packed ${platform} executable lacks executable mode: ${binaryRow ?? 'missing'}`);
      }
    }
    for (const tarball of tarballs) {
      await copyFile(path.join(scratch, tarball), path.join(stage, tarball));
      process.stdout.write(`${tarball}  ${hash(await readFile(path.join(stage, tarball)))}\n`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
