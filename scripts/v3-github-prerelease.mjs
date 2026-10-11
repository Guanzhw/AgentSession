import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { releaseIdentity } from './v3-npm-package-contract.mjs';

if (process.argv.length !== 5) throw new Error('Usage: node scripts/v3-github-prerelease.mjs <tag> <assets-dir> <notes-file>');
const [tag, assetsArg, notes] = process.argv.slice(2);
const identity = releaseIdentity(tag.slice(1));
if (tag !== identity.tag) throw new Error('Release ref must be the exact version tag');
const assets = path.resolve(assetsArg);
const gh = args => {
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 2_000_000 });
  if (result.status !== 0) throw new Error(`gh ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
};
const repo = process.env.GITHUB_REPOSITORY;
const releases = JSON.parse(gh(['api', `repos/${repo}/releases`, '--paginate', '--slurp'])).flat();
let release = releases.find(value => value.tag_name === tag);
if (release && release.prerelease !== identity.prerelease) {
  throw new Error(`Existing ${tag} release channel differs from its version`);
}
if (!release) {
  gh(['release', 'create', tag, '--repo', repo, '--verify-tag', '--draft',
    ...(identity.prerelease ? ['--prerelease', '--latest=false'] : ['--latest']),
    '--title', `AgentSession ${tag.slice(1)}`, '--notes-file', notes]);
  release = JSON.parse(gh(['api', `repos/${repo}/releases/tags/${tag}`]));
}
const scratch = await mkdtemp(path.join(os.tmpdir(), 'agentsession-release-verify-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  for (const entry of await readdir(assets, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error(`Release asset must be a regular file: ${entry.name}`);
    const file = path.join(assets, entry.name);
    if (release.assets.some(asset => asset.name === entry.name)) {
      gh(['release', 'download', tag, '--repo', repo, '--pattern', entry.name, '--dir', scratch]);
      if (sha(await readFile(path.join(scratch, entry.name))) !== sha(await readFile(file))) {
        throw new Error(`Existing GitHub release asset differs: ${entry.name}`);
      }
      process.stdout.write(`Verified existing asset ${entry.name}\n`);
    } else {
      gh(['release', 'upload', tag, file, '--repo', repo]);
    }
  }
  if (release.draft) gh(['release', 'edit', tag, '--repo', repo, '--draft=false',
    ...(identity.prerelease ? ['--prerelease', '--latest=false'] : ['--prerelease=false', '--latest'])]);
} finally {
  const physical = await realpath(scratch);
  if (path.dirname(physical) !== await realpath(os.tmpdir())) throw new Error('Unexpected release verification temp path');
  await rm(physical, { recursive: true, force: true });
}
