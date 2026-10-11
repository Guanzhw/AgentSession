import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readPackageManifests, releaseIdentity } from './v3-npm-package-contract.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const ref = process.argv[2];
const root = JSON.parse(await readFile(path.join(repo, 'package.json')));
const templates = await readPackageManifests(path.join(repo, 'v3/npm'));
const cargo = await readFile(path.join(repo, 'v3/Cargo.toml'), 'utf8');
const cargoVersion = cargo.match(/\[workspace\.package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/)?.[1];
assert.equal(root.version, templates.native.version, 'Root and npm versions must match');
assert.equal(root.version, cargoVersion, 'Root and Cargo versions must match');
const identity = releaseIdentity(root.version);
assert.equal(ref, identity.tag, 'Release ref must be the exact version tag');
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const commit = git(['rev-parse', 'HEAD']);
assert.equal(git(['rev-parse', '--verify', `refs/tags/${ref}^{commit}`]), commit,
  'Checked out source must be the exact release tag commit');
if (process.argv[3] === '--remote') {
  const refs = git(['ls-remote', '--exit-code', 'origin', `refs/tags/${ref}`, `refs/tags/${ref}^{}`])
    .split(/\r?\n/).map(line => line.split(/\s+/));
  const remoteCommit = refs.find(([, name]) => name.endsWith('^{}'))?.[0] ?? refs[0]?.[0];
  assert.equal(remoteCommit, commit, 'Remote release tag moved away from the validated source commit');
}
const timestamp = git(['show', '-s', '--format=%ct', commit]);
process.stdout.write(`version=${root.version}\ncommit=${commit}\ntimestamp=${timestamp}\n`);
