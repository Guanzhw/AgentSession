import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { nativeBinary } from '../npm/native/binary.mjs';
import { readPackageManifests, tarballName } from '../../scripts/v3-npm-package-contract.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const manifests = await readPackageManifests(path.join(repo, 'v3/npm'));
const version = manifests.native.version;
const expected = ['win32-x64', 'linux-x64', 'linux-arm64', 'darwin-arm64'];
const targets = () => import('../npm/native/targets.mjs');
const bundle = process.env.AGENTSESSION_V3_NPM_HOST_BUNDLE;
const host = `${process.platform}-${process.arch}`;
const flags = { 'win32-x64':'--windows-bundle', 'linux-x64':'--linux-bundle',
  'linux-arm64':'--linux-arm64-bundle', 'darwin-arm64':'--macos-arm64-bundle' };

test('native target mapping declares exactly the four delivery pairs', async () => {
  const { nativeTargets } = await targets();
  assert.deepEqual(Object.keys(nativeTargets), expected);
  for (const target of expected) assert.equal(nativeTargets[target].executable,
    target === 'win32-x64' ? 'agentsession-v3.exe' : 'agentsession-v3');
});

test('native resolver distinguishes absent ARM64 payloads from unsupported pairs', () => {
  assert.throws(() => nativeBinary('linux', 'arm64'), /missing for linux-arm64/);
  assert.throws(() => nativeBinary('darwin', 'arm64'), /missing for darwin-arm64/);
  assert.throws(() => nativeBinary('darwin', 'x64'), /unavailable for darwin-x64/);
  assert.throws(() => nativeBinary('win32', 'arm64'), /unavailable for win32-arm64/);
});

test('native package includes its target map and declares supported OS and CPU axes', async () => {
  const manifest = JSON.parse(await readFile(path.join(repo, 'v3/npm/native/package.json')));
  assert.ok(manifest.files.includes('targets.mjs'));
  assert.deepEqual(manifest.os, ['win32', 'linux', 'darwin']);
  assert.deepEqual(manifest.cpu, ['x64', 'arm64']);
});

test('artifact header fixtures identify exact PE, ELF and Mach-O architecture without execution', async () => {
  const { assertNativeArtifact } = await import('../../scripts/v3-native-artifact.mjs');
  // These in-memory format headers are parser fixtures, never deployable binaries.
  const pe = Buffer.alloc(96);pe.write('MZ');pe.writeUInt32LE(64,60);pe.write('PE\0\0',64);pe.writeUInt16LE(0x8664,68);
  const elf = machine => { const b=Buffer.alloc(64);b.set([0x7f,69,76,70,2,1,1]);b.writeUInt16LE(3,16);b.writeUInt16LE(machine,18);return b; };
  const macho=Buffer.alloc(32);macho.writeUInt32LE(0xfeedfacf);macho.writeUInt32LE(0x0100000c,4);macho.writeUInt32LE(2,12);
  assert.doesNotThrow(() => assertNativeArtifact(pe,'win32-x64'));
  assert.doesNotThrow(() => assertNativeArtifact(elf(62),'linux-x64'));
  assert.doesNotThrow(() => assertNativeArtifact(elf(183),'linux-arm64'));
  assert.doesNotThrow(() => assertNativeArtifact(macho,'darwin-arm64'));
  assert.throws(() => assertNativeArtifact(elf(62),'linux-arm64'), /incompatible.*linux-arm64/);
  assert.throws(() => assertNativeArtifact(pe,'linux-x64'), /incompatible.*linux-x64/);
  assert.throws(() => assertNativeArtifact(macho,'win32-x64'), /incompatible.*win32-x64/);
  assert.throws(() => assertNativeArtifact(Buffer.alloc(0),'darwin-arm64'), /incompatible.*darwin-arm64/);
});

test('an explicitly supplied real host bundle stages alone with pinned payload and available metadata',
  {skip:!bundle?'Set AGENTSESSION_V3_NPM_HOST_BUNDLE to a real selected portable bundle':false},async t=>{
    const parent=path.join(repo,'tmp/v3-delivery/npm-four-targets-20261001/fixtures');
    await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,'stage-'));
    t.after(()=>rm(root,{recursive:true,force:true}));
    const result=spawnSync(process.execPath,[path.join(repo,'scripts/v3-prepare-npm-candidate.mjs'),
      '--output-dir',path.join(root,'candidate'),flags[host],bundle],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);
    const provenance=JSON.parse(await readFile(path.join(root,'candidate/native/provenance.json')));
    assert.deepEqual(Object.keys(provenance.platforms),[host]);
    const binary=(await targets()).nativeTargets[host].executable;
    const actual=await readFile(path.join(root,'candidate/native/bin',host,binary));
    assert.equal(createHash('sha256').update(actual).digest('hex'),provenance.platforms[host].nativeBinarySha256);
    for(const name of ['native','viewer','mcp']){
      const manifest=JSON.parse(await readFile(path.join(root,'candidate',name,'package.json')));
      assert.deepEqual(manifest.os,[process.platform]);assert.deepEqual(manifest.cpu,[process.arch]);
    }
  });

test('supplied ARM64 bundle with missing executable fails explicitly without publishing output',async t=>{
  const parent=path.join(repo,'tmp/v3-delivery/npm-four-targets-20261001/fixtures');await mkdir(parent,{recursive:true});
  const root=await mkdtemp(path.join(parent,'absent-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const target of ['linux-arm64','darwin-arm64']){
    // Metadata-only absence fixture: no executable is created or represented as usable.
    const source=path.join(root,target);await mkdir(source);
    const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
    const entry={path:'agentsession-v3',sizeBytes:0,sha256:sha(Buffer.alloc(0))};
    const manifest=JSON.stringify({version,platform:target,executable:entry.path,files:[entry]});
    await writeFile(path.join(source,'manifest.json'),manifest);
    await writeFile(path.join(source,'SHA256SUMS'),`${entry.sha256}  ${entry.path}\n${sha(manifest)}  manifest.json\n`);
    const candidate=path.join(root,target+'-candidate');
    const result=spawnSync(process.execPath,[path.join(repo,'scripts/v3-prepare-npm-candidate.mjs'),
      '--output-dir',candidate,flags[target],source],{encoding:'utf8',windowsHide:true});
    assert.notEqual(result.status,0);assert.match(result.stderr,/ENOENT.*agentsession-v3/);
    await assert.rejects(readFile(path.join(candidate,'native/provenance.json')),{code:'ENOENT'});
  }
});

test('a real Windows-only candidate packs offline on its native host without WSL',
  {skip:process.platform!=='win32'||!bundle?'Requires a real Windows host bundle':false},async t=>{
    const parent=path.join(repo,'tmp/v3-delivery/npm-four-targets-20261001/fixtures');await mkdir(parent,{recursive:true});
    const root=await mkdtemp(path.join(parent,'windows-pack-'));t.after(()=>rm(root,{recursive:true,force:true}));
    const stage=path.join(root,'candidate');
    const prepared=spawnSync(process.execPath,[path.join(repo,'scripts/v3-prepare-npm-candidate.mjs'),
      '--output-dir',stage,'--windows-bundle',bundle],{encoding:'utf8',windowsHide:true});
    assert.equal(prepared.status,0,prepared.stderr);
    const packed=spawnSync(process.execPath,[path.join(repo,'scripts/v3-pack-npm-candidate.mjs'),
      '--stage-dir',stage],{encoding:'utf8',windowsHide:true});
    assert.equal(packed.status,0,packed.stderr);
    assert.ok((await readFile(path.join(stage,tarballName(manifests.native)))).length>0);
  });
