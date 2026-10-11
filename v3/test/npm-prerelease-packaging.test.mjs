import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { readPackageManifests, tarballName } from '../../scripts/v3-npm-package-contract.mjs';
import { nativeTargets } from '../npm/native/targets.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const templates = await readPackageManifests(path.join(repo, 'v3/npm'));
const version = templates.native.version;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const flags = { 'win32-x64': '--windows-bundle', 'linux-x64': '--linux-bundle',
  'linux-arm64': '--linux-arm64-bundle', 'darwin-arm64': '--macos-arm64-bundle' };
const invoke = (script, args) => spawnSync(process.execPath, [path.join(repo, 'scripts', script), ...args],
  { encoding: 'utf8', windowsHide: true, timeout: 60_000 });

async function fixtureRoot(t) {
  const parent = path.join(repo, 'tmp/npm-prerelease-contract');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'test-'));
  t.after(async () => {
    const physical = await realpath(root);
    assert.equal(path.dirname(physical), await realpath(parent));
    await rm(physical, { recursive: true, force: true });
  });
  return root;
}

function header(target) {
  // Format/architecture fixtures exercise packaging contracts; never launch these bytes.
  if (target === 'win32-x64') {
    const bytes = Buffer.alloc(96); bytes.write('MZ'); bytes.writeUInt32LE(64, 60);
    bytes.write('PE\0\0', 64); bytes.writeUInt16LE(0x8664, 68); return bytes;
  }
  if (target.startsWith('linux-')) {
    const bytes = Buffer.alloc(64); bytes.set([0x7f, 69, 76, 70, 2, 1, 1]);
    bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(target === 'linux-x64' ? 62 : 183, 18); return bytes;
  }
  const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf);
  bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(2, 12); return bytes;
}

async function fixtureBundle(root, target, selectedVersion = version, bytes = header(target)) {
  const source = path.join(root, target); await mkdir(source);
  const executable = nativeTargets[target].executable;
  await writeFile(path.join(source, executable), bytes);
  const manifest = JSON.stringify({ version: selectedVersion, platform: target, executable,
    files: [{ path: executable, sizeBytes: bytes.length, sha256: sha(bytes) }] });
  await writeFile(path.join(source, 'manifest.json'), manifest);
  await writeFile(path.join(source, 'SHA256SUMS'), `${sha(bytes)}  ${executable}\n${sha(manifest)}  manifest.json\n`);
  await writeFile(path.join(source, 'release-source.json'), JSON.stringify({ schemaVersion: 1,
    version: selectedVersion, platform: target, sourceCommit: 'a'.repeat(40) }));
  return source;
}

test('public release stages all four verified payloads with exact version, dependency, and source pins', async t => {
  const root = await fixtureRoot(t);
  const bundles = [];
  for (const target of Object.keys(nativeTargets)) bundles.push(flags[target], await fixtureBundle(root, target));
  const stage = path.join(root, 'public');
  const sourceCommit = 'a'.repeat(40);
  const result = invoke('v3-prepare-npm-candidate.mjs', ['--output-dir', stage, '--public', '--source-commit', sourceCommit, ...bundles]);
  assert.equal(result.status, 0, result.stderr);
  const provenance = JSON.parse(await readFile(path.join(stage, 'native/provenance.json')));
  assert.equal(provenance.version, version); assert.equal(provenance.sourceCommit, sourceCommit);
  assert.deepEqual(Object.keys(provenance.platforms), Object.keys(nativeTargets));
  for (const target of Object.keys(nativeTargets)) {
    assert.equal(sha(await readFile(path.join(stage, 'native/bin', target, nativeTargets[target].executable))),
      provenance.platforms[target].nativeBinarySha256);
    assert.equal(provenance.platforms[target].releaseSourceSha256,
      sha(await readFile(path.join(root, target, 'release-source.json'))));
  }
  for (const name of ['native', 'viewer', 'mcp']) {
    const manifest = JSON.parse(await readFile(path.join(stage, name, 'package.json')));
    assert.equal(manifest.private, false); assert.equal(manifest.version, version);
    assert.equal(manifest.repository.url, 'git+https://github.com/Guanzhw/AgentSession.git');
    assert.deepEqual(manifest.publishConfig, { access: 'public', tag: version.includes('-') ? 'next' : 'latest', provenance: true });
    assert.equal(manifest.license, 'MIT');
    if (name !== 'native') assert.equal(manifest.dependencies['@acetamido/agentsession-native'], version);
    assert.ok((await readFile(path.join(stage, name, 'LICENSE'))).length > 0);
  }
  await writeFile(path.join(root, 'linux-arm64/release-source.json'), JSON.stringify({ schemaVersion: 1,
    version, platform: 'linux-arm64', sourceCommit: 'b'.repeat(40) }));
  const mixedSource = invoke('v3-prepare-npm-candidate.mjs', ['--output-dir', path.join(root, 'mixed-source'),
    '--public', '--source-commit', sourceCommit, ...bundles]);
  assert.notEqual(mixedSource.status, 0); assert.match(mixedSource.stderr, /release source differs/);
});

test('stable public staging derives latest from isolated templates without publishing', async t => {
  const root = await fixtureRoot(t);
  const isolated = path.join(root, 'source');
  await mkdir(path.join(isolated, 'scripts'), { recursive: true });
  await cp(path.join(repo, 'v3/npm'), path.join(isolated, 'v3/npm'), { recursive: true });
  await copyFile(path.join(repo, 'LICENSE'), path.join(isolated, 'LICENSE'));
  for (const script of ['v3-prepare-npm-candidate.mjs', 'v3-native-artifact.mjs', 'v3-npm-package-contract.mjs']) {
    await copyFile(path.join(repo, 'scripts', script), path.join(isolated, 'scripts', script));
  }
  for (const [name, template] of Object.entries(templates)) {
    await writeFile(path.join(isolated, 'v3/npm', name, 'package.json'), JSON.stringify({ ...template,
      version: '3.0.0', ...(name !== 'native' ? { dependencies: { '@acetamido/agentsession-native': '3.0.0' } } : {}),
    }));
  }
  const bundles = [];
  for (const target of Object.keys(nativeTargets)) {
    bundles.push(flags[target], await fixtureBundle(root, target, '3.0.0'));
  }
  const env = { ...process.env };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN']) delete env[key];
  const stage = path.join(root, 'stable');
  const result = spawnSync(process.execPath, [path.join(isolated, 'scripts/v3-prepare-npm-candidate.mjs'),
    '--output-dir', stage, '--public', '--source-commit', 'a'.repeat(40), ...bundles], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000, env,
  });
  assert.equal(result.status, 0, result.stderr);
  const manifests = await readPackageManifests(stage);
  for (const manifest of Object.values(manifests)) {
    assert.equal(manifest.version, '3.0.0');
    assert.deepEqual(manifest.publishConfig, { access: 'public', tag: 'latest', provenance: true });
  }
  const provenance = JSON.parse(await readFile(path.join(stage, 'native/provenance.json')));
  assert.equal(provenance.version, '3.0.0');
  assert.equal(provenance.sourceCommit, 'a'.repeat(40));
  assert.deepEqual(Object.keys(provenance.platforms), Object.keys(nativeTargets));
});

test('public boundary refuses incomplete platforms and stale-version or wrong-architecture bundles', async t => {
  const root = await fixtureRoot(t);
  const windows = await fixtureBundle(root, 'win32-x64');
  const stage = path.join(root, 'incomplete');
  const incomplete = invoke('v3-prepare-npm-candidate.mjs', ['--output-dir', stage, '--public', '--source-commit', 'a'.repeat(40), '--windows-bundle', windows]);
  assert.notEqual(incomplete.status, 0); assert.match(incomplete.stderr, /all four native targets/);
  await assert.rejects(readFile(path.join(stage, 'native/package.json')), { code: 'ENOENT' });
  for (const [label, bundleVersion, bytes, diagnostic] of [
    ['old', '2.0.0', header('linux-arm64'), /unexpected identity/],
    ['architecture', version, header('linux-x64'), /incompatible.*linux-arm64/],
  ]) {
    const parent = path.join(root, label); await mkdir(parent);
    const source = await fixtureBundle(parent, 'linux-arm64', bundleVersion, bytes);
    const result = invoke('v3-prepare-npm-candidate.mjs', ['--output-dir', path.join(parent, 'stage'), '--linux-arm64-bundle', source]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, diagnostic);
  }
});

test('private host candidate packs using the actual candidate version and retains private metadata', async t => {
  const root = await fixtureRoot(t);
  const source = await fixtureBundle(root, 'win32-x64');
  const stage = path.join(root, 'host');
  const prepared = invoke('v3-prepare-npm-candidate.mjs', ['--output-dir', stage, '--windows-bundle', source]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const manifests = await readPackageManifests(stage);
  for (const manifest of Object.values(manifests)) assert.equal(manifest.private, true);
  const packed = invoke('v3-pack-npm-candidate.mjs', ['--stage-dir', stage]);
  assert.equal(packed.status, 0, packed.stderr);
  for (const manifest of Object.values(manifests)) {
    const archive = path.join(stage, tarballName(manifest));
    assert.ok((await readFile(archive)).length > 0);
    const extracted = spawnSync('tar', ['-xOzf', path.basename(archive), 'package/package.json'], { cwd: stage, encoding: 'utf8', windowsHide: true });
    assert.equal(extracted.status, 0, extracted.stderr);
    assert.deepEqual(JSON.parse(extracted.stdout), manifest);
  }
});

test('packing refuses dependency tampering and payload changes after preparation', async t => {
  const root = await fixtureRoot(t);
  const source = await fixtureBundle(root, 'win32-x64');
  const stage = path.join(root, 'host');
  const prepared = invoke('v3-prepare-npm-candidate.mjs', ['--output-dir', stage, '--windows-bundle', source]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const viewerFile = path.join(stage, 'viewer/package.json');
  const viewer = JSON.parse(await readFile(viewerFile));
  await writeFile(viewerFile, JSON.stringify({ ...viewer, dependencies: { '@acetamido/agentsession-native': '2.0.0' } }));
  const dependency = invoke('v3-pack-npm-candidate.mjs', ['--stage-dir', stage]);
  assert.notEqual(dependency.status, 0); assert.match(dependency.stderr, /native dependency differs/);
  await writeFile(viewerFile, JSON.stringify(viewer));
  const bytes = header('win32-x64'); bytes[95] = 1;
  await writeFile(path.join(stage, 'native/bin/win32-x64/agentsession-v3.exe'), bytes);
  const payload = invoke('v3-pack-npm-candidate.mjs', ['--stage-dir', stage]);
  assert.notEqual(payload.status, 0); assert.match(payload.stderr, /differs from pinned provenance/);
  await assert.rejects(readFile(path.join(stage, tarballName(templates.native))), { code: 'ENOENT' });
});

test('Linux release archives stay byte-identical when filesystem timestamps change and retain executable mode',
  { skip: process.platform !== 'linux' ? 'Requires release aggregation host GNU tar and gzip' : false }, async t => {
    const root = await fixtureRoot(t);
    const source = await fixtureBundle(root, 'linux-x64');
    const binary = path.join(source, 'agentsession-v3');
    await chmod(binary, 0o755);
    const first = path.join(root, 'first.tar.gz');
    const second = path.join(root, 'second.tar.gz');
    const archived = invoke('v3-archive-prerelease.mjs', [source, first, '1791648000']);
    assert.equal(archived.status, 0, archived.stderr);
    for (const file of ['agentsession-v3', 'manifest.json', 'SHA256SUMS', 'release-source.json']) {
      await utimes(path.join(source, file), 1800000000, 1800000000);
    }
    const repeated = invoke('v3-archive-prerelease.mjs', [source, second, '1791648000']);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(sha(await readFile(first)), sha(await readFile(second)));
    const listed = spawnSync('tar', ['-tvzf', first], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout.split('\n').find(row => row.endsWith('./agentsession-v3')) ?? '', /^-rwx/);
    const overwrite = invoke('v3-archive-prerelease.mjs', [source, first, '1791648000']);
    assert.notEqual(overwrite.status, 0);
    assert.equal(sha(await readFile(first)), sha(await readFile(second)));
  });
