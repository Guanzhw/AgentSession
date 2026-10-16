import { onCleanup, temporaryDirectory } from '../../test/helpers/fixture-cleanup.mjs';
import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { appendFile, copyFile, cp, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const version = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8')).version;
const fixture = path.join(repo, 'v3', 'fixtures', 'codex');
const release = process.env.AGENTSESSION_V3_RELEASE_BIN || path.join(repo, 'v3', 'target', 'release',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const portablePackager = path.join(repo, 'scripts', 'v3-package-portable.mjs');
const sessionId = '44444444-4444-4444-8444-444444444444';
const assistantBody = 'Hello 🙂 from the Rust slice. Continue to the complete ending.';
const fixtureRelative = path.join('sessions', '2026', '09', '26',
  'rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl');
const fixtureFile = path.join(fixture, fixtureRelative);
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function filesUnder(root, prefix = '') {
  const rows = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, `Package must not contain symlinks: ${entry.name}`);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) rows.push(...await filesUnder(path.join(root, entry.name), relative));
    else {
      assert.equal(entry.isFile(), true, `Package entry must be a regular file: ${relative}`);
      rows.push(relative);
    }
  }
  return rows.sort();
}

function pathWithoutBuildTools() {
  const names = process.platform === 'win32'
    ? ['node.exe', 'node.cmd', 'cargo.exe', 'cargo.cmd']
    : ['node', 'nodejs', 'cargo'];
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean)
    .filter(directory => !names.some(name => existsSync(path.join(directory, name))))
    .join(path.delimiter);
}

function hasBuildToolOnPath(value) {
  const names = process.platform === 'win32'
    ? ['node.exe', 'node.cmd', 'cargo.exe', 'cargo.cmd']
    : ['node', 'nodejs', 'cargo'];
  return value.split(path.delimiter).filter(Boolean)
    .some(directory => names.some(name => existsSync(path.join(directory, name))));
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function childEnvironment(configFile, runtimeBin) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (['path', 'agentsession_config',
      'node_options', 'node_path'].includes(key.toLowerCase())) delete env[key];
  }
  return {
    ...env,
    PATH: [runtimeBin, pathWithoutBuildTools()].filter(Boolean).join(path.delimiter),
    AGENTSESSION_CONFIG: configFile,
    NODE_OPTIONS: '',
    NODE_PATH: '',
  };
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`Portable MCP child process ${pid} remained alive after client close`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill();
  await closed;
}

async function freePort() {
  return freeFetchSafePort();
}

async function setup(t) {
  const dir = await temporaryDirectory(t, path.join(tmpdir(), 'agentsession-v3-artifact-'));
  const physical = await realpath(dir);
  const physicalTemp = await realpath(tmpdir());
  assert.equal(path.dirname(physical).toLowerCase(), physicalTemp.toLowerCase());
  const binary = path.join(dir, path.basename(release));
  await copyFile(release, binary);
  for (const name of ['meta', 'index', 'cache', 'claude', 'pi', 'dsh', 'opencode']) {
    await mkdir(path.join(dir, name));
  }
  const args = [
    '--codex-dir', fixture,
    '--opencode-db', path.join(dir, 'opencode', 'opencode.db'),
    '--claude-dir', path.join(dir, 'claude'),
    '--pi-dir', path.join(dir, 'pi'),
    '--dsh-dir', path.join(dir, 'dsh'),
    '--meta-dir', path.join(dir, 'meta'),
    '--index-dir', path.join(dir, 'index'),
    '--cache-dir', path.join(dir, 'cache'),
  ];
  return { binary, dir, args };
}

test('copied release binary serves embedded Reader assets and native MCP without a checkout cwd',
  { timeout: 40_000 }, async t => {
    const { binary, dir, args } = await setup(t);
    const port = await freePort();
    const server = spawn(binary, ['serve', '--port', String(port), ...args],
      { cwd: dir, windowsHide: true, stdio: 'ignore' });
    onCleanup(t, () => stopChild(server));
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error('Standalone binary exited before readiness');
      try {
        const response = await fetch(`${origin}/api/providers`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { ready = true; break; }
      } catch { /* The listener may not be ready yet. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'Standalone binary must start on loopback');

    for (const route of ['/sessions', '/codex/session/44444444-4444-4444-8444-444444444444']) {
      const response = await fetch(origin + route);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^text\/html/);
      const html = await response.text();
      assert.match(html, /AgentSession/i);
      const asset = html.match(/(?:src|href)="(\/assets\/[^\"]+)"/)?.[1];
      assert.ok(asset, 'Release HTML must reference an embedded built asset');
      const resource = await fetch(origin + asset);
      assert.equal(resource.status, 200);
      assert.match(resource.headers.get('content-type'), /^(?:text\/javascript|text\/css)/);
    }
    const missing = await fetch(origin + '/api/v3/does-not-exist');
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'not_found');

    const client = new Client({ name: 'agentsession-v3-standalone-check', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const transport = new StdioClientTransport({ command: binary, args: ['mcp', ...args],
      cwd: dir, stderr: 'pipe' });
    onCleanup(t, () => transport.close());
    onCleanup(t, () => client.close());
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 7);
});

test('portable packager rejects an executable that reports a different version',
  { timeout: 15_000 }, async t => {
    const scratch = await temporaryDirectory(t, path.join(tmpdir(), 'agentsession-v3-wrong-version-'));
    const physical = await realpath(scratch);
    const physicalTemp = await realpath(tmpdir());
    assert.equal(path.dirname(physical).toLowerCase(), physicalTemp.toLowerCase());
    const fakeRelease = path.join(scratch, process.platform === 'win32'
      ? 'agentsession-v3.exe' : 'agentsession-v3');
    await copyFile(process.execPath, fakeRelease);
    const outputDir = path.join(scratch, 'wrong-package');
    const packager = spawn(process.execPath,
      [portablePackager, '--release-bin', fakeRelease, '--output-dir', outputDir],
      { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    onCleanup(t, () => stopChild(packager));
    const stderr = [];
    packager.stderr.on('data', chunk => stderr.push(chunk));
    const [exitCode] = await once(packager, 'close');
    assert.notEqual(exitCode, 0);
    assert.match(Buffer.concat(stderr).toString(), /version does not match/);
    assert.equal(existsSync(outputDir), false, 'A mislabeled package must not be published');
  });

test('portable packager rejects a version-correct executable with a local build path',
  { timeout: 15_000 }, async t => {
    const scratch = await temporaryDirectory(t, path.join(tmpdir(), 'agentsession-v3-local-path-'));
    const physical = await realpath(scratch);
    const physicalTemp = await realpath(tmpdir());
    assert.equal(path.dirname(physical).toLowerCase(), physicalTemp.toLowerCase());
    for (const [name, buildHome] of [['current', homedir()], ['unicode', path.join(scratch, '测试')]]) {
      const variant = path.join(scratch, name);
      await mkdir(variant);
      const fakeRelease = path.join(variant, path.basename(release));
      await copyFile(release, fakeRelease);
      await appendFile(fakeRelease, `\n${buildHome}${path.sep}.cargo${path.sep}registry\n`);
      const outputDir = path.join(variant, 'rejected-package');
      const homeVariable = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
      const packager = spawn(process.execPath,
        [portablePackager, '--release-bin', fakeRelease, '--output-dir', outputDir],
        { cwd: repo, env: { ...process.env, [homeVariable]: buildHome }, windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'] });
      onCleanup(t, () => stopChild(packager));
      const stderr = [];
      packager.stderr.on('data', chunk => stderr.push(chunk));
      const [exitCode] = await once(packager, 'close');
      assert.notEqual(exitCode, 0);
      assert.match(Buffer.concat(stderr).toString(), /absolute local build path/);
      assert.equal(existsSync(outputDir), false);
    }
  });

test('portable release directory runs from a copied path with spaces using only its public fixture',
  { timeout: 90_000 }, async t => {
    assert.ok(existsSync(release), `Build the release executable at ${release}`);
    const sourceExecutableHash = sha256(await readFile(release));
    const sourceFixtureHash = sha256(await readFile(fixtureFile));
    const licenseFile = path.join(repo, 'LICENSE');
    const licenseHash = sha256(await readFile(licenseFile));
    const scratch = await temporaryDirectory(t, path.join(tmpdir(), 'agentsession-v3-portable-'));
    const realScratch = await realpath(scratch);
    const realTemp = await realpath(tmpdir());
    assert.equal(path.dirname(realScratch).toLowerCase(), realTemp.toLowerCase());
    const packageDir = path.join(realScratch, 'generated-package');
    const externalParent = path.join(realScratch, 'External Install With Spaces');
    const installDir = path.join(externalParent, 'AgentSession 3.0 Portable');
    const stateRoot = path.join(installDir, 'local state');
    const executableName = path.basename(release);
    const packagedExecutable = path.join(installDir, executableName);
    const packagedFixture = path.join(installDir, 'fixtures', 'codex');
    const configFile = path.join(stateRoot, 'config.json');
        const transports = [];
    const mcpPids = [];
    const expectedState = {
      meta: path.join(stateRoot, 'meta'),
      index: path.join(stateRoot, 'index'),
      cache: path.join(stateRoot, 'cache'),
    };
    onCleanup(t, async () => {
      const childPids = [...new Set([...mcpPids, ...transports.map(transport => transport.pid).filter(Boolean)])];
      for (const pid of childPids) await waitForProcessExit(pid);
      assert.equal(sha256(await readFile(fixtureFile)), sourceFixtureHash,
        'The repository public fixture must remain unchanged');
    });

    const packager = spawn(process.execPath,
      [portablePackager, '--release-bin', release, '--output-dir', packageDir],
      { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    onCleanup(t, () => stopChild(packager));
    const packageStdout = [];
    const packageStderr = [];
    packager.stdout.on('data', chunk => packageStdout.push(chunk));
    packager.stderr.on('data', chunk => packageStderr.push(chunk));
    const [packageExitCode] = await once(packager, 'close');
    assert.equal(packageExitCode, 0,
      `Portable packager failed:\n${Buffer.concat(packageStderr).toString()}\n${Buffer.concat(packageStdout).toString()}`);

    const packageFiles = await filesUnder(packageDir);
    assert.ok(packageFiles.includes(executableName), 'Bundle contains the release executable');
    assert.ok(packageFiles.includes('LICENSE'), 'Bundle contains the project license');
    assert.ok(packageFiles.includes('README.md'), 'Bundle contains launch instructions');
    assert.ok(packageFiles.includes('manifest.json'), 'Bundle contains a file manifest');
    assert.ok(packageFiles.includes('SHA256SUMS'), 'Bundle contains checksums');
    const fixturePathInPackage = `fixtures/codex/${fixtureRelative.split(path.sep).join('/')}`;
    assert.ok(packageFiles.includes(fixturePathInPackage), 'Bundle contains the public Codex sample');
    assert.deepEqual(packageFiles.filter(file => file.startsWith('fixtures/codex/')),
      [fixturePathInPackage], 'Bundle contains only the declared public source fixture');

    const manifest = JSON.parse(await readFile(path.join(packageDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.product, 'AgentSession');
    assert.equal(manifest.version, version);
    assert.equal(manifest.platform, `${process.platform}-${process.arch}`);
    assert.equal(manifest.executable, executableName);
    assert.deepEqual(manifest.fixture, {
      provider: 'codex', sessionId,
      path: `fixtures/codex/${fixtureRelative.split(path.sep).join('/')}`,
    });
    assert.ok(Array.isArray(manifest.files), 'Manifest lists packaged files');
    const manifestPaths = manifest.files.map(file => file.path).sort();
    const payloadFiles = packageFiles.filter(file => file !== 'manifest.json' && file !== 'SHA256SUMS');
    assert.deepEqual(manifestPaths, payloadFiles,
      'Manifest covers every payload file exactly once, with no generated metadata entries');
    for (const file of manifest.files) {
      assert.equal(typeof file.path, 'string');
      assert.equal(path.posix.normalize(file.path), file.path, 'Manifest paths are normalized relative paths');
      assert.equal(path.posix.isAbsolute(file.path), false);
      const packagePath = path.resolve(packageDir, ...file.path.split('/'));
      const relative = path.relative(packageDir, packagePath);
      assert.ok(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
        `Manifest path must stay inside the package: ${file.path}`);
      const bytes = await readFile(packagePath);
      assert.equal(file.sizeBytes, bytes.length, `Manifest size matches ${file.path}`);
      assert.equal(file.sha256, sha256(bytes), `Manifest hash matches ${file.path}`);
    }
    const sums = (await readFile(path.join(packageDir, 'SHA256SUMS'), 'utf8')).trim()
      .split(/\r?\n/).map(line => {
        const match = line.match(/^([a-f\d]{64})  (.+)$/i);
        assert.ok(match, `SHA256SUMS entry has a digest and relative path: ${line}`);
        return { sha256: match[1].toLowerCase(), path: match[2] };
      });
    const sumPaths = sums.map(row => row.path).sort();
    assert.deepEqual(sumPaths, [...payloadFiles, 'manifest.json'].sort(),
      'Checksum file covers payload and manifest files');
    for (const row of sums) {
      const checksumPath = path.resolve(packageDir, ...row.path.split('/'));
      const relative = path.relative(packageDir, checksumPath);
      assert.ok(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
        `Checksum path must stay inside the package: ${row.path}`);
      assert.equal(sha256(await readFile(checksumPath)), row.sha256, `Checksum matches ${row.path}`);
    }
    assert.equal(sha256(await readFile(path.join(packageDir, executableName))), sourceExecutableHash);
    assert.equal(sha256(await readFile(path.join(packageDir, 'LICENSE'))), licenseHash);
    assert.equal(sha256(await readFile(path.join(packageDir, fixturePathInPackage))), sourceFixtureHash);
    const readme = await readFile(path.join(packageDir, 'README.md'), 'utf8');
    assert.ok(readme.includes(executableName), 'README names the packaged executable');
    assert.match(readme, /install-mcp-host\.mjs/);
    assert.match(readme, /mcp\.agentsession-v3/);
    assert.match(readme, /mcp\.servers/);
    assert.equal(sha256(await readFile(path.join(packageDir, 'install-mcp-host.mjs'))),
      sha256(await readFile(path.join(repo, 'scripts', 'v3-install-mcp-host.mjs'))),
      'Portable package includes the tested MCP host installer');
    const launchLines = readme.split(/\r?\n/);
    assert.ok(launchLines.some(line => line.includes('serve') && /\$Exe|\$exe/.test(line)),
      'README shows the Web launch command');
    assert.ok(launchLines.some(line => line.includes('mcp') && /\$Exe|\$exe/.test(line)),
      'README shows the MCP launch command');
    for (const option of ['--config', '--codex-dir', '--opencode-db', '--claude-dir', '--pi-dir', '--dsh-dir',
      '--meta-dir', '--index-dir', '--cache-dir']) {
      assert.ok(readme.includes(option), `README explains isolated launch option ${option}`);
    }
    const readmeBlocks = [...readme.matchAll(/```(?:powershell|bash)\n([\s\S]*?)\n```/g)]
      .map(match => match[1]);
    assert.equal(readmeBlocks.length, 2, 'README has independent Web and MCP shell blocks');
    assert.match(readmeBlocks[0], /serve --port 3457/);
    assert.match(readmeBlocks[1], / mcp /);
    for (const block of readmeBlocks) {
      assert.ok(block.includes('--codex-dir') && block.includes('--cache-dir'),
        'Each command block defines its own source and state arguments');
    }

    await mkdir(externalParent);
    assert.match(installDir, / /, 'Installed path contains spaces');
    await cp(packageDir, installDir, { recursive: true, errorOnExist: true, force: false });
    const realInstall = await realpath(installDir);
    assert.equal(isWithin(repo, realInstall), false, 'Installed package is outside the checkout');
    assert.equal(isWithin(realTemp, realInstall), true,
      'Installed package is contained by this test-owned temp root');
    for (const relative of packageFiles) {
      assert.equal(sha256(await readFile(path.join(installDir, ...relative.split('/')))),
        sha256(await readFile(path.join(packageDir, ...relative.split('/')))),
        `External copy preserves package file ${relative}`);
    }
    for (const block of readmeBlocks) {
      const probe = `${block.slice(0, block.lastIndexOf('\n'))}\n${process.platform === 'win32'
        ? '& $Exe --version' : '"$exe" --version'}`;
      const command = process.platform === 'win32' ? 'powershell.exe' : 'bash';
      const arguments_ = process.platform === 'win32'
        ? ['-NoProfile', '-NonInteractive', '-Command', probe] : ['-c', probe];
      const result = spawnSync(command, arguments_, {
        cwd: installDir, encoding: 'utf8', timeout: 5_000, windowsHide: true,
      });
      assert.equal(result.status, 0, `README block cannot run in a fresh shell: ${result.stderr}`);
      assert.match(result.stdout, /agentsession-v3 3\.0\.0/);
    }

    const demoConfigFile = path.join(installDir, 'state', 'config.json');
    assert.deepEqual(JSON.parse(await readFile(demoConfigFile, 'utf8')), {},
      'The portable demo starts with an empty config before explicit host setup');
    const emptyConfigHost = path.join(stateRoot, 'empty-config-host', 'config.toml');
    const unsafeRegistration = spawnSync(process.execPath, [
      path.join(installDir, 'install-mcp-host.mjs'), '--target', 'codex',
      '--binary', packagedExecutable, '--host-config', emptyConfigHost,
      '--server-config', demoConfigFile,
    ], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
    assert.notEqual(unsafeRegistration.status, 0,
      'An empty config must not register a host that falls back to personal source paths');
    assert.equal(existsSync(emptyConfigHost), false);

    for (const directory of [stateRoot, ...Object.values(expectedState),
      path.join(stateRoot, 'claude'), path.join(stateRoot, 'pi'), path.join(stateRoot, 'dsh'),
      path.join(stateRoot, 'opencode')]) {
      await mkdir(directory, { recursive: true });
    }
    await writeFile(configFile, `${JSON.stringify({
      codexDir: packagedFixture,
      dbPath: path.join(stateRoot, 'opencode', 'opencode.db'),
      claudeDir: path.join(stateRoot, 'claude'),
      piDir: path.join(stateRoot, 'pi'),
      dshDir: path.join(stateRoot, 'dsh'),
      metaDir: expectedState.meta,
      indexDir: expectedState.index,
      cacheDir: expectedState.cache,
    })}\n`);
    const hostConfig = path.join(stateRoot, 'codex-host', 'config.toml');
    const installerResult = spawnSync(process.execPath, [
      path.join(installDir, 'install-mcp-host.mjs'), '--target', 'codex',
      '--binary', packagedExecutable, '--host-config', hostConfig,
      '--server-config', configFile,
    ], { encoding: 'utf8', timeout: 5_000, windowsHide: true,
      env: { ...process.env, HOME: stateRoot, USERPROFILE: stateRoot,
        CODEX_HOME: path.dirname(hostConfig), XDG_CONFIG_HOME: stateRoot,
        OPENCODE_CONFIG: path.join(stateRoot, 'opencode', 'host.json') } });
    assert.equal(installerResult.status, 0, installerResult.stderr);
    const installedHostConfig = await readFile(hostConfig, 'utf8');
    assert.match(installedHostConfig, /\[mcp_servers\.agentsession-v3\]/);
    assert.ok(installedHostConfig.includes(JSON.stringify(packagedExecutable)));
    assert.ok(installedHostConfig.includes(JSON.stringify(configFile)));
    const sourceArgs = [
      '--codex-dir', packagedFixture,
      '--opencode-db', path.join(stateRoot, 'opencode', 'opencode.db'),
      '--claude-dir', path.join(stateRoot, 'claude'),
      '--pi-dir', path.join(stateRoot, 'pi'),
      '--dsh-dir', path.join(stateRoot, 'dsh'),
      '--meta-dir', expectedState.meta,
      '--index-dir', expectedState.index,
      '--cache-dir', expectedState.cache,
    ];
    let runtimeBin;
    if (process.platform !== 'win32') {
      runtimeBin = path.join(stateRoot, 'runtime-bin');
      await mkdir(runtimeBin);
      for (const name of ['bash', 'mkdir']) {
        await symlink(`/bin/${name}`, path.join(runtimeBin, name));
      }
    }
    const env = childEnvironment(configFile, runtimeBin);
    assert.equal(hasBuildToolOnPath(env.PATH), false,
      'Portable runtime PATH retains platform directories but contains no Node or Cargo executable');

    const port = await freePort();
    const server = spawn(packagedExecutable,
      ['--config', configFile, 'serve', '--port', String(port), ...sourceArgs],
      { cwd: installDir, env, windowsHide: true, stdio: 'ignore' });
    onCleanup(t, () => stopChild(server));
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error('Portable Web process exited before readiness');
      try {
        const response = await fetch(`${origin}/api/providers`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { ready = true; break; }
      } catch { /* The listener may not be ready yet. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'Copied package starts its Web service with no checkout cwd');
    const settingsResponse = await fetch(`${origin}/api/settings`);
    assert.equal(settingsResponse.status, 200);
    const settings = await settingsResponse.json();
    assert.equal(settings.configFile.path, configFile);
    assert.equal(settings.configFile.loaded, true);
    assert.equal(settings.startup.sources.codexDir, packagedFixture);
    assert.equal(settings.startup.state.metaDir, expectedState.meta);
    assert.equal(settings.startup.state.indexDir, expectedState.index);
    assert.equal(settings.startup.state.cacheDir, expectedState.cache);

    const bootstrapResponse = await fetch(`${origin}/api/v3/reader/codex/${sessionId}/bootstrap`);
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = await bootstrapResponse.json();
    const query = new URLSearchParams({ messageId: 'assistant-1', segment: 'message', field: 'body',
      offset: '0', maxChars: '256', revision: bootstrap.revision });
    const readerContent = await fetch(`${origin}/api/v3/reader/codex/${sessionId}/content?${query}`);
    assert.equal(readerContent.status, 200);
    assert.equal((await readerContent.json()).text, assistantBody,
      'Web Reader returns the public sample body from the copied package fixture');

    await stopChild(server);
    assert.ok(server.exitCode !== null || server.signalCode !== null,
      'Portable Web process exits before MCP starts');

    const client = new Client({ name: 'agentsession-v3-portable-check', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const transport = new StdioClientTransport({ command: packagedExecutable,
      args: ['--config', configFile, 'mcp', ...sourceArgs], cwd: installDir, env, stderr: 'pipe' });
    transports.push(transport);
    onCleanup(t, () => transport.close());
    onCleanup(t, () => client.close());
    await client.connect(transport);
    assert.ok(transport.pid, 'MCP runs as a child of the copied executable');
    const mcpPid = transport.pid;
    mcpPids.push(mcpPid);
    const event = await client.callTool({ name: 'session_get_event', arguments: {
      event: { provider: 'codex', sessionId, messageId: 'assistant-1', segment: 'message' }, maxChars: 256,
    } });
    assert.notEqual(event.isError, true, event.content?.[0]?.text);
    assert.equal(event.structuredContent.result.content.text, assistantBody,
      'MCP returns the same public sample body from the copied package fixture');
    await client.close();
    await waitForProcessExit(mcpPid);

    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const shellArgs = process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-Command', readmeBlocks[1]]
      : ['-c', readmeBlocks[1]];
    const documentedClient = new Client({ name: 'agentsession-v3-readme-mcp', version: '1.0.0' });
    const documentedTransport = new StdioClientTransport({ command: shell,
      args: shellArgs, cwd: installDir, env, stderr: 'pipe' });
    transports.push(documentedTransport);
    onCleanup(t, () => documentedTransport.close());
    onCleanup(t, () => documentedClient.close());
    await documentedClient.connect(documentedTransport);
    assert.ok(documentedTransport.pid, 'The standalone README MCP block starts in a fresh shell');
    const documentedPid = documentedTransport.pid;
    mcpPids.push(documentedPid);
    const documentedEvent = await documentedClient.callTool({ name: 'session_get_event', arguments: {
      event: { provider: 'codex', sessionId, messageId: 'assistant-1', segment: 'message' },
      maxChars: 256,
    } });
    assert.notEqual(documentedEvent.isError, true, documentedEvent.content?.[0]?.text);
    assert.equal(documentedEvent.structuredContent.result.content.text, assistantBody);
    await documentedClient.close();
    await waitForProcessExit(documentedPid);
    assert.equal(sha256(await readFile(fixtureFile)), sourceFixtureHash,
      'Serving Web and MCP from the bundle does not mutate the repository fixture');
  });
