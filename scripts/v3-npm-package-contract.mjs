import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeTargets } from '../v3/npm/native/targets.mjs';

export const packageNames = {
  native: '@acetamido/agentsession-native',
  viewer: '@acetamido/agentsession',
  mcp: '@acetamido/agentsession-mcp',
};

export const tarballName = manifest => `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`;

export async function readPackageManifests(root) {
  const manifests = Object.fromEntries(await Promise.all(Object.keys(packageNames).map(async name =>
    [name, JSON.parse(await readFile(path.join(root, name, 'package.json'), 'utf8'))])));
  const version = manifests.native.version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
    throw new Error('Native package version must be a concrete release version');
  }
  for (const [name, manifest] of Object.entries(manifests)) {
    if (manifest.name !== packageNames[name] || manifest.version !== version
      || name !== 'native' && manifest.dependencies?.[packageNames.native] !== version) {
      throw new Error(`${name} package identity or native dependency differs from ${version}`);
    }
  }
  return manifests;
}

export function assertPublicPrerelease(manifests, provenance) {
  if (!manifests.native.version.startsWith('3.') || !manifests.native.version.includes('-')) {
    throw new Error('Public staging requires an AgentSession 3 prerelease version');
  }
  if (provenance.version !== manifests.native.version || !/^[a-f0-9]{40}$/.test(provenance.sourceCommit ?? '')
    || Object.keys(nativeTargets).some(target => !provenance.platforms[target])
    || Object.keys(provenance.platforms).length !== Object.keys(nativeTargets).length) {
    throw new Error('Public prerelease requires all four native targets and a full source commit');
  }
  for (const [name, manifest] of Object.entries(manifests)) {
    if (manifest.private !== false || manifest.license !== 'MIT'
      || manifest.repository?.url !== 'git+https://github.com/Guanzhw/AgentSession.git'
      || manifest.publishConfig?.access !== 'public' || manifest.publishConfig?.tag !== 'next'
      || manifest.publishConfig?.provenance !== true) {
      throw new Error(`${name} public prerelease metadata is incomplete`);
    }
  }
  for (const [target, pin] of Object.entries(provenance.platforms)) {
    if (!/^[a-f0-9]{64}$/.test(pin.releaseSourceSha256 ?? '')) {
      throw new Error(`${target} public prerelease must pin its release source sidecar`);
    }
  }
}
