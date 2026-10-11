import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { readPackageManifests, tarballName, assertPublicPrerelease } from './v3-npm-package-contract.mjs';

if (process.argv.length !== 4 || process.argv[2] !== '--stage-dir') {
  throw new Error('Usage: node scripts/v3-publish-prerelease.mjs --stage-dir <public-prepared-directory>');
}
const stage = path.resolve(process.argv[3]);
const manifests = await readPackageManifests(stage);
const provenance = JSON.parse(await readFile(path.join(stage, 'native/provenance.json')));
assertPublicPrerelease(manifests, provenance);
if (process.env.AGENTSESSION_RELEASE_COMMIT !== provenance.sourceCommit) {
  throw new Error('Publication source commit differs from the release workflow commit');
}
const registry = 'https://registry.npmjs.org';
const npm = (args, cwd) => spawnSync('npm', args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 2_000_000 });
function registryValue(spec, field) {
  const result = npm(['view', spec, field, '--json', '--registry', registry]);
  if (result.status === 0) return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  let error;
  try { error = JSON.parse(result.stdout); } catch { /* npm reports other failures verbatim below. */ }
  if (error?.error?.code === 'E404') return null;
  throw new Error(`npm view ${spec} ${field} failed: ${result.stderr}\n${result.stdout}`);
}
const latestBefore = Object.fromEntries(Object.values(manifests).map(manifest =>
  [manifest.name, registryValue(manifest.name, 'dist-tags.latest')]));
for (const manifest of Object.values(manifests)) {
  const tarball = path.join(stage, tarballName(manifest));
  const integrity = `sha512-${createHash('sha512').update(await readFile(tarball)).digest('base64')}`;
  const spec = `${manifest.name}@${manifest.version}`;
  const existing = registryValue(spec, 'dist.integrity');
  if (existing !== null) {
    if (existing !== integrity) throw new Error(`Existing immutable npm version differs from release tarball: ${spec}`);
    process.stdout.write(`Verified already published ${spec}\n`);
  } else {
    const result = npm(['publish', tarball, '--access', 'public', '--provenance', '--tag', 'next', '--registry', registry]);
    if (result.status !== 0) throw new Error(`npm publish ${spec} failed: ${result.stderr}\n${result.stdout}`);
    process.stdout.write(result.stdout);
    const deadline = Date.now() + 15 * 60_000;
    let visible;
    do {
      visible = registryValue(spec, 'dist.integrity');
      if (visible !== null) break;
      await setTimeout(15_000);
    } while (Date.now() < deadline);
    if (visible !== integrity) throw new Error(`Published npm integrity is missing or differs: ${spec}`);
  }
  const latestAfter = registryValue(spec, 'dist-tags.latest');
  if (latestAfter !== latestBefore[manifest.name]) {
    throw new Error(`npm latest changed during prerelease publication: ${manifest.name}`);
  }
  if (registryValue(spec, 'dist-tags.next') !== manifest.version) {
    throw new Error(`npm next does not identify the verified prerelease: ${manifest.name}`);
  }
}
