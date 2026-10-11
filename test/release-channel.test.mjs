import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import * as contract from '../scripts/v3-npm-package-contract.mjs';

const repo = path.resolve(import.meta.dirname, '..');

test('one validated version derives stable and prerelease publication identity', () => {
  assert.equal(typeof contract.releaseIdentity, 'function');
  assert.deepEqual(contract.releaseIdentity('3.0.0'), {
    version: '3.0.0', tag: 'v3.0.0', npmTag: 'latest', prerelease: false,
  });
  assert.deepEqual(contract.releaseIdentity('3.0.0-rc.4'), {
    version: '3.0.0-rc.4', tag: 'v3.0.0-rc.4', npmTag: 'next', prerelease: true,
  });
  for (const version of ['1.10.1', '3.0', 'v3.0.0', '3.0.0-', '3.0.0+local']) {
    assert.throws(() => contract.releaseIdentity(version), /AgentSession 3 release version/);
  }
});

test('release workflow validates stable tags and manual validation keeps publication conditional', async () => {
  const workflow = await readFile(path.join(repo, '.github/workflows/v3-prerelease.yml'), 'utf8');
  assert.match(workflow, /tags:\s*\n\s*- "v3\.\*"/);
  assert.match(workflow, /publish:\s*\n[\s\S]*?default: false\s*\n\s*type: boolean/);
  const publicationConditions = workflow.match(/if: github\.event_name == 'push' \|\| inputs\.publish/g) ?? [];
  assert.equal(publicationConditions.length, 2);
  assert.match(workflow, /needs: \[identity, native\]/);
});

test('exact release verifier accepts stable and RC identities and rejects tag or remote commit mismatch', async t => {
  const parent = path.join(repo, 'tmp/stable-readiness-20261011/release-surface/identity-contract');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'test-'));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(root)), await realpath(parent));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'scripts'));
  for (const script of ['v3-verify-prerelease.mjs', 'v3-npm-package-contract.mjs']) {
    await copyFile(path.join(repo, 'scripts', script), path.join(root, 'scripts', script));
  }
  await mkdir(path.join(root, 'v3/npm/native'), { recursive: true });
  await copyFile(path.join(repo, 'v3/npm/native/targets.mjs'), path.join(root, 'v3/npm/native/targets.mjs'));
  const templates = await contract.readPackageManifests(path.join(repo, 'v3/npm'));
  for (const name of ['viewer', 'mcp']) await mkdir(path.join(root, 'v3/npm', name));
  const mock = `import childProcess from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    import {pathToFileURL} from 'node:url';
    childProcess.execFileSync=(command,args)=>{
      if(command!=='git') throw new Error('Unexpected command');
      if(args[0]==='ls-remote') return process.env.FIXTURE_REMOTE+'\\trefs/tags/'+process.env.FIXTURE_TAG;
      if(args[0]==='show') return '1791648000';
      if(args[0]==='rev-parse') return 'a'.repeat(40);
      throw new Error('Unexpected git operation');
    };
    syncBuiltinESMExports();process.argv=[process.execPath,...process.argv.slice(1)];
    await import(pathToFileURL(process.argv[1]).href);`;
  for (const version of ['3.0.0', '3.0.0-rc.4']) {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ version }));
    await writeFile(path.join(root, 'v3/Cargo.toml'), `[workspace.package]\nversion = "${version}"\n`);
    for (const [name, template] of Object.entries(templates)) {
      await writeFile(path.join(root, 'v3/npm', name, 'package.json'), JSON.stringify({ ...template, version,
        ...(name !== 'native' ? { dependencies: { '@acetamido/agentsession-native': version } } : {}),
      }));
    }
    for (const [tag, remote, success, diagnostic] of [
      [`v${version}`, 'a'.repeat(40), true],
      ['v3.0.1', 'a'.repeat(40), false, /exact version tag/],
      [`v${version}`, 'b'.repeat(40), false, /Remote release tag moved/],
    ]) {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', mock,
        path.join(root, 'scripts/v3-verify-prerelease.mjs'), tag, '--remote'], {
        encoding: 'utf8', windowsHide: true, timeout: 10_000,
        env: { ...process.env, FIXTURE_REMOTE: remote, FIXTURE_TAG: tag },
      });
      assert.equal(result.status === 0, success, result.stderr);
      if (success) assert.match(result.stdout, new RegExp(`version=${version.replaceAll('.', '\\.')}\\ncommit=${'a'.repeat(40)}`));
      else assert.match(result.stderr, diagnostic);
    }
  }
});

async function githubFixture(t, version, existing) {
  const parent = path.join(repo, 'tmp/stable-readiness-20261011/release-surface/github-contract');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'test-'));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(root)), await realpath(parent));
    await rm(root, { recursive: true, force: true });
  });
  const assets = path.join(root, 'assets');
  await mkdir(assets);
  await writeFile(path.join(assets, 'SHA256SUMS'), 'fixture-checksum\n');
  const record = path.join(root, 'calls.json');
  const mock = `import childProcess from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    import {writeFileSync} from 'node:fs';
    import {pathToFileURL} from 'node:url';
    const calls=[]; let release=${JSON.stringify(existing ?? null)};
    childProcess.spawnSync=(command,args)=>{
      if(command!=='gh') throw new Error('Unexpected command');
      calls.push(args);writeFileSync(process.env.GH_CALL_RECORD,JSON.stringify(calls));
      if(args[0]==='api') return {status:0,stdout:JSON.stringify(args.includes('--slurp')?[[...(release?[release]:[])]]:release)};
      if(args[0]==='release'&&args[1]==='create') release={tag_name:args[2],prerelease:args.includes('--prerelease'),draft:true,assets:[]};
      return {status:0,stdout:''};
    };
    syncBuiltinESMExports();process.argv=[process.execPath,...process.argv.slice(1)];
    await import(pathToFileURL(process.argv[1]).href);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', mock,
    path.join(repo, 'scripts/v3-github-prerelease.mjs'), `v${version}`, assets, path.join(root, 'notes.md')], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
    env: { ...process.env, GITHUB_REPOSITORY: 'fixture/agentsession', GH_CALL_RECORD: record },
  });
  return { result, calls: JSON.parse(await readFile(record, 'utf8')) };
}

test('GitHub stable publication uses normal latest and prerelease retains its existing identity', async t => {
  for (const [version, prerelease] of [['3.0.0', false], ['3.0.0-rc.4', true]]) {
    const { result, calls } = await githubFixture(t, version);
    assert.equal(result.status, 0, result.stderr);
    const create = calls.find(args => args[0] === 'release' && args[1] === 'create');
    const edit = calls.find(args => args[0] === 'release' && args[1] === 'edit');
    assert.equal(create.includes('--prerelease'), prerelease);
    assert.ok(create.includes(prerelease ? '--latest=false' : '--latest'));
    assert.ok(edit.includes(prerelease ? '--prerelease' : '--prerelease=false'));
    assert.ok(edit.includes(prerelease ? '--latest=false' : '--latest'));
  }
});

test('GitHub rejects an existing release with the wrong channel before mutation', async t => {
  const { result, calls } = await githubFixture(t, '3.0.0', {
    tag_name: 'v3.0.0', prerelease: true, draft: false, assets: [],
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release channel differs/);
  assert.equal(calls.some(args => args[0] === 'release'), false);
});
