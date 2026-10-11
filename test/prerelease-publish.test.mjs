import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { packageNames, readPackageManifests, tarballName } from '../scripts/v3-npm-package-contract.mjs';
import { nativeTargets } from '../v3/npm/native/targets.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const templates = await readPackageManifests(path.join(repo, 'v3/npm'));
const publish = path.join(repo, 'scripts/v3-publish-prerelease.mjs');

async function registryFixture(t, { mismatch = false, firstPublication = false } = {}) {
  const parent = path.join(repo, 'tmp/prerelease-registry-contract');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'test-'));
  t.after(async () => {
    const physical = await realpath(root);
    assert.equal(path.dirname(physical), await realpath(parent));
    await rm(physical, { recursive: true, force: true });
  });
  const expected = {};
  for (const [name, original] of Object.entries(templates)) {
    const manifest = { ...original, private: false, license: 'MIT',
      repository: { type: 'git', url: 'git+https://github.com/Guanzhw/AgentSession.git' },
      publishConfig: { access: 'public', tag: 'next', provenance: true } };
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, 'package.json'), JSON.stringify(manifest));
    // Registry-response fixtures only: these bytes never reach npm or a network.
    const bytes = Buffer.from(`registry-integrity-fixture:${manifest.name}:${manifest.version}`);
    const archive = path.join(root, tarballName(manifest));
    await writeFile(archive, bytes);
    expected[manifest.name] = { spec: `${manifest.name}@${manifest.version}`, archive,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
  }
  await writeFile(path.join(root, 'native/provenance.json'), JSON.stringify({ schemaVersion: 1,
    version: templates.native.version, sourceCommit: 'a'.repeat(40),
    platforms: Object.fromEntries(Object.keys(nativeTargets).map(target => [target, { releaseSourceSha256: 'b'.repeat(64) }])) }));
  const fixture = { expected,
    published: firstPublication ? {} : { [packageNames.native]: mismatch ? 'sha512-other-bytes' : expected[packageNames.native].integrity },
    next: firstPublication ? {} : { [packageNames.native]: templates.native.version },
    latest: { [packageNames.native]: null, [packageNames.viewer]: '1.10.1', [packageNames.mcp]: '1.10.1' }, version: templates.native.version };
  const fixturePath = path.join(root, 'registry.json');
  await writeFile(fixturePath, JSON.stringify(fixture));
  const record = path.join(root, 'calls.json');
  const mock = `import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const fixture=JSON.parse(readFileSync(process.env.REGISTRY_FIXTURE));
    const calls=[];
    childProcess.spawnSync=(command,args)=>{
      if(command!=='npm') throw new Error('Unexpected mocked command '+command);
      calls.push(args); writeFileSync(process.env.REGISTRY_CALLS,JSON.stringify(calls));
      if(args[0]==='publish') {
        const name=Object.keys(fixture.expected).find(name=>fixture.expected[name].archive===args[1]);
        if(!name) throw new Error('Unexpected archive');
        fixture.published[name]=fixture.expected[name].integrity;
        const tag=args[args.indexOf('--tag')+1];
        if(tag==='next') fixture.next[name]=fixture.version;
        else fixture.latest[name]=fixture.version;
        writeFileSync(process.env.REGISTRY_FIXTURE,JSON.stringify(fixture));
        return {status:0,stdout:'published '+name+'\\n'};
      }
      const [operation,spec,field]=args;
      if(operation!=='view') throw new Error('Unexpected npm operation');
      const name=Object.keys(fixture.expected).find(name=>name===spec||fixture.expected[name].spec===spec);
      // npm view resolves a bare package through latest, even when requesting dist-tags.
      if(spec===name&&!fixture.latest[name]) return fixture.published[name]
        ? {status:0,stdout:''}
        : {status:1,stdout:JSON.stringify({error:{code:'E404'}}),stderr:'missing fixture package'};
      if(field==='dist-tags.latest') return {status:0,stdout:fixture.latest[name]?JSON.stringify(fixture.latest[name]):''};
      if(field==='dist-tags.next') return {status:0,stdout:JSON.stringify(fixture.next[name])};
      if(field==='dist.integrity'&&fixture.published[name]) return {status:0,stdout:JSON.stringify(fixture.published[name])};
      return {status:1,stdout:JSON.stringify({error:{code:'E404'}}),stderr:'missing fixture version'};
    };
    syncBuiltinESMExports();
    process.argv=[process.execPath,...process.argv.slice(1)];
    await import(pathToFileURL(process.argv[1]).href);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', mock, publish, '--stage-dir', root],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000, env: { ...process.env,
      AGENTSESSION_RELEASE_COMMIT: 'a'.repeat(40), REGISTRY_FIXTURE: fixturePath, REGISTRY_CALLS: record } });
  return { result, calls: JSON.parse(await readFile(record)), fixture: JSON.parse(await readFile(fixturePath)) };
}

test('partial prerelease rerun verifies immutable native integrity and publishes only missing wrappers to next', async t => {
  const { result, calls } = await registryFixture(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified already published @acetamido\/agentsession-native/);
  const publishes = calls.filter(args => args[0] === 'publish');
  assert.equal(publishes.length, 2);
  for (const args of publishes) {
    assert.ok(args.includes('--provenance')); assert.ok(args.includes('--access'));
    assert.equal(args[args.indexOf('--tag') + 1], 'next');
    assert.equal(args.includes('latest'), false);
  }
  assert.equal(calls.filter(args => args[2] === 'dist-tags.latest').length, 6,
    'Read existing latest for each package and verify it again after each publication');
});

test('existing npm version with different integrity fails before any further publication', async t => {
  const { result, calls } = await registryFixture(t, { mismatch: true });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Existing immutable npm version differs/);
  assert.equal(calls.some(args => args[0] === 'publish'), false);
});

test('first native publication verifies next without creating latest when only next exists', async t => {
  const { result, calls, fixture } = await registryFixture(t, { firstPublication: true });
  assert.equal(result.status, 0, result.stderr);
  const publishes = calls.filter(args => args[0] === 'publish');
  assert.equal(publishes.length, 3);
  for (const args of publishes) assert.equal(args[args.indexOf('--tag') + 1], 'next');
  assert.deepEqual(fixture.latest, {
    [packageNames.native]: null, [packageNames.viewer]: '1.10.1', [packageNames.mcp]: '1.10.1',
  });
  const nativeSpec = fixture.expected[packageNames.native].spec;
  assert.deepEqual(calls.filter(args => args[2] === 'dist-tags.latest' && args[1].startsWith(packageNames.native))
    .map(args => args[1]), [packageNames.native, nativeSpec]);
  assert.ok(calls.some(args => args[1] === nativeSpec && args[2] === 'dist-tags.next'));
  assert.equal(fixture.next[packageNames.native], templates.native.version);
  assert.equal(fixture.published[packageNames.native], fixture.expected[packageNames.native].integrity);
});
