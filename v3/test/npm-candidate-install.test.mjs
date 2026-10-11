import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { freeFetchSafePort } from './fetch-safe-port.mjs';
import { nativeTargets } from '../npm/native/targets.mjs';
import { readPackageManifests, tarballName } from '../../scripts/v3-npm-package-contract.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const manifests = await readPackageManifests(path.join(repo, 'v3/npm'));
const version = manifests.native.version;
const prepare = path.join(repo, 'scripts', 'v3-prepare-npm-candidate.mjs');
const pack = path.join(repo, 'scripts', 'v3-pack-npm-candidate.mjs');
const fixture = path.join(repo, 'v3', 'fixtures', 'codex', 'sessions', '2026', '09', '26',
  'rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl');
const sessionId = '44444444-4444-4444-8444-444444444444';
const body = 'Hello 🙂 from the Rust slice. Continue to the complete ending.';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const found = candidates.find(existsSync);
  assert.ok(found, `npm CLI unavailable at: ${candidates.join(', ')}`);
  return found;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd, env: options.env, encoding: 'utf8', timeout: 60_000,
    windowsHide: true, maxBuffer: 2_000_000,
  });
  assert.equal(result.status, 0,
    `${command} ${args.join(' ')} exited ${result.status}: ${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true });
    if (result.status !== 0 && child.exitCode === null) {
      throw new Error(`Could not stop test-owned Viewer process ${child.pid}: ${result.stderr}`);
    }
  } else {
    child.kill('SIGTERM');
  }
  await closed;
}

async function ready(origin, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Installed Viewer exited before readiness');
    try {
      const response = await fetch(`${origin}/api/providers`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch { /* Listener startup is asynchronous. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Installed Viewer did not become ready');
}

async function waitForExit(pid) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`Test-owned process ${pid} remained alive`);
}

test('selected local npm candidate installs and launches Web and native stdio MCP offline', {
  timeout: 120_000,
  skip: process.env.AGENTSESSION_V3_NPM_CANDIDATE !== '1'
    ? 'Set AGENTSESSION_V3_NPM_CANDIDATE=1 for the selected local artifact test' : false,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-npm-'));
  const physicalRoot = await realpath(root);
  const physicalTemp = await realpath(os.tmpdir());
  assert.equal(path.dirname(physicalRoot).toLowerCase(), physicalTemp.toLowerCase());
  const tarballDir = process.env.AGENTSESSION_V3_NPM_TARBALL_DIR;
  const windowsBundle = process.env.AGENTSESSION_V3_NPM_WINDOWS_BUNDLE;
  const linuxBundle = process.env.AGENTSESSION_V3_NPM_LINUX_BUNDLE;
  const linuxArm64Bundle = process.env.AGENTSESSION_V3_NPM_LINUX_ARM64_BUNDLE;
  const macosArm64Bundle = process.env.AGENTSESSION_V3_NPM_MACOS_ARM64_BUNDLE;
  const hostBundle = process.env.AGENTSESSION_V3_NPM_HOST_BUNDLE;
  const sourceLedger = process.env.AGENTSESSION_V3_NPM_SOURCE_LEDGER;
  const stage = tarballDir ? path.resolve(tarballDir) : path.join(root, 'candidate');
  const prefix = path.join(root, 'installed with spaces');
  const working = path.join(root, 'other working directory');
  const sources = path.join(root, 'sources');
  const state = path.join(root, 'state');
  let web;
  let client;
  t.after(async () => {
    if (client) await client.close();
    if (web) await stop(web);
    const physical = await realpath(root);
    assert.equal(path.dirname(physical).toLowerCase(), physicalTemp.toLowerCase());
    await rm(physical, { recursive: true, force: true });
  });

  const fixtureHash = digest(await readFile(fixture));
  assert.equal(fixtureHash, '17e3638a76197a60969f83849707bda886377c6d69cd8f5a78a6620f44f7dc12');
  if (!tarballDir) {
    const bundleOptions = {
      'win32-x64': ['--windows-bundle', windowsBundle],
      'linux-x64': ['--linux-bundle', linuxBundle],
      'linux-arm64': ['--linux-arm64-bundle', linuxArm64Bundle],
      'darwin-arm64': ['--macos-arm64-bundle', macosArm64Bundle],
    };
    if (hostBundle) bundleOptions[`${process.platform}-${process.arch}`][1] = hostBundle;
    const selected = Object.values(bundleOptions).filter(([, value]) => value);
    assert.ok(selected.length,
      'Set AGENTSESSION_V3_NPM_HOST_BUNDLE or explicit native platform bundle paths');
    const prepareArgs = [prepare, '--output-dir', stage, ...selected.flat()];
    if (sourceLedger) prepareArgs.push('--source-ledger', sourceLedger);
    run(process.execPath, prepareArgs, { cwd: repo });
  }
  await mkdir(working);
  const nativeStage = path.join(stage, 'native');
  const provenance = JSON.parse(await readFile(path.join(nativeStage, 'provenance.json'), 'utf8'));
  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.version, version);
  assert.ok(provenance.platforms[`${process.platform}-${process.arch}`], 'Candidate contains the real host payload');
  for (const platform of Object.keys(provenance.platforms)) {
    assert.match(provenance.platforms[platform].portableManifestSha256, /^[a-f0-9]{64}$/);
    assert.match(provenance.platforms[platform].nativeBinarySha256, /^[a-f0-9]{64}$/);
  }

  const npm = npmCli();
  const npmEnv = { ...process.env, npm_config_cache: path.join(root, 'npm-cache'),
    npm_config_update_notifier: 'false' };
  if (!tarballDir) {
    if (process.platform === 'win32' && Object.keys(provenance.platforms).some(target => target !== 'win32-x64')) {
      const distro = process.env.AGENTSESSION_V3_WSL_DISTRO ?? 'Ubuntu';
      const wslPath = windowsPath => run('wsl.exe', ['-d', distro, '--', 'wslpath', '-u',
        windowsPath.replaceAll('\\', '/')],
        { cwd: working }).trim();
      run('wsl.exe', ['-d', distro, '--', 'node', wslPath(pack), '--stage-dir', wslPath(stage)],
        { cwd: working });
    } else {
      run(process.execPath, [pack, '--stage-dir', stage], { cwd: working, env: npmEnv });
    }
  }
  const tarballs = Object.values(manifests).map(manifest => path.join(stage, tarballName(manifest)));
  for (const tarball of tarballs) assert.ok(existsSync(tarball), `Missing packed candidate: ${tarball}`);
  run(process.execPath, [npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--prefix', prefix, ...tarballs], { cwd: working, env: npmEnv });

  const installed = path.join(prefix, 'node_modules', '@acetamido');
  const native = path.join(installed, 'agentsession-native');
  for (const consumer of ['agentsession', 'agentsession-mcp']) {
    assert.equal(existsSync(path.join(installed, consumer, 'node_modules', '@acetamido', 'agentsession-native')),
      false, 'Both commands must resolve the one installed native payload');
  }
  const installedProvenance = JSON.parse(await readFile(path.join(native, 'provenance.json'), 'utf8'));
  assert.deepEqual(installedProvenance, provenance);
  const binary = path.join(native, 'bin', `${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
  assert.equal(digest(await readFile(binary)), provenance.platforms[`${process.platform}-${process.arch}`].nativeBinarySha256);
  if (process.platform !== 'win32') {
    const archive = run('tar', ['-tvzf', tarballs[0]], { cwd: working });
    const binaryRow = archive.split(/\r?\n/)
      .find(row => row.endsWith(`package/bin/${process.platform}-${process.arch}/agentsession-v3`));
    assert.match(binaryRow ?? '', /^-rwx/, 'Packed Unix executable retains executable mode');
    assert.ok(((await stat(binary)).mode & 0o111) !== 0,
      'Installed Unix executable retains executable mode');
  }
  const resolver = await import(pathToFileURL(path.join(native, 'binary.mjs')).href);
  assert.equal(await realpath(resolver.nativeBinary()), await realpath(binary));
  for (const target of Object.keys(nativeTargets)) {
    const [platform, arch] = target.split('-');
    if (provenance.platforms[target]) assert.equal(await realpath(resolver.nativeBinary(platform, arch)),
      await realpath(path.join(native, 'bin', target, nativeTargets[target].executable)));
    else assert.throws(() => resolver.nativeBinary(platform, arch), /missing for|unavailable for/);
  }
  assert.throws(() => resolver.nativeBinary('darwin', 'x64'), /unavailable for darwin-x64/);
  const viewer = path.join(installed, 'agentsession', 'bin', 'agentsession.mjs');
  const mcp = path.join(installed, 'agentsession-mcp', 'bin', 'agentsession-mcp.mjs');
  const viewerShim = path.join(prefix, 'node_modules', '.bin',
    process.platform === 'win32' ? 'agentsession.cmd' : 'agentsession');
  const mcpShim = path.join(prefix, 'node_modules', '.bin',
    process.platform === 'win32' ? 'agentsession-mcp.cmd' : 'agentsession-mcp');
  assert.ok(existsSync(viewerShim));
  assert.ok(existsSync(mcpShim));
  assert.equal(run(process.execPath, [viewer, '--version'], { cwd: working }), `agentsession-v3 ${version}`);
  assert.equal(run(process.execPath, [mcp, '--version'], { cwd: working }), `agentsession-v3 ${version}`);
  for (const args of [
    ['--help'], ['serve', '--help'], ['mcp', '--help'], ['migrate-meta', '--help'], ['help', 'migrate-meta'],
    ['--config', 'mcp', 'migrate-meta', '--help'],
    ['--config=mcp', 'migrate-meta', '--help'],
    ['migrate-meta', '--config', 'mcp', '--help'],
  ]) {
    assert.equal(run(process.execPath, [viewer, ...args], { cwd: working }),
      run(binary, args, { cwd: working }), `Installed routing: ${args.join(' ')}`);
  }
  for (const args of [['--codex-dir', 'mcp', '--help'], ['--config', 'mcp', '--help'],
    ['--config=mcp', '--help']]) {
    assert.equal(run(process.execPath, [viewer, ...args], { cwd: working }),
      run(binary, ['serve', ...args], { cwd: working }), `Option value remains a value: ${args.join(' ')}`);
  }
  const invalidPortArgs = ['--port', 'serve', '--help'];
  const invalidPort = spawnSync(process.execPath, [viewer, ...invalidPortArgs],
    { cwd: working, encoding: 'utf8', timeout: 5_000, windowsHide: true });
  const nativeInvalidPort = spawnSync(binary, ['serve', ...invalidPortArgs],
    { cwd: working, encoding: 'utf8', timeout: 5_000, windowsHide: true });
  assert.notEqual(nativeInvalidPort.status, 0);
  assert.equal(invalidPort.status, nativeInvalidPort.status);
  assert.equal(invalidPort.stderr, nativeInvalidPort.stderr, 'A command-shaped port value remains a native invalid value');
  const invalid = spawnSync(process.execPath, [viewer, '--unknown-candidate-option'],
    { cwd: working, encoding: 'utf8', timeout: 5_000, windowsHide: true });
  const nativeInvalid = spawnSync(binary, ['serve', '--unknown-candidate-option'],
    { cwd: working, encoding: 'utf8', timeout: 5_000, windowsHide: true });
  assert.notEqual(nativeInvalid.status, 0);
  assert.equal(invalid.status, nativeInvalid.status, 'Viewer command forwards the native exit code');
  if (process.platform === 'win32') {
    const invoke = shim => `& '${shim.replaceAll("'", "''")}' --version`;
    assert.equal(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', invoke(viewerShim)],
      { cwd: working }), `agentsession-v3 ${version}`);
    assert.equal(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', invoke(mcpShim)],
      { cwd: working }), `agentsession-v3 ${version}`);
  } else {
    assert.equal(run(viewerShim, ['--version'], { cwd: working }), `agentsession-v3 ${version}`);
    assert.equal(run(mcpShim, ['--version'], { cwd: working }), `agentsession-v3 ${version}`);
  }

  const codex = path.join(sources, 'codex');
  const copiedFixture = path.join(codex, 'sessions', '2026', '09', '26', path.basename(fixture));
  await mkdir(path.dirname(copiedFixture), { recursive: true });
  await copyFile(fixture, copiedFixture);
  for (const name of ['claude', 'pi', 'dsh', 'opencode']) await mkdir(path.join(sources, name));
  for (const name of ['meta', 'index', 'cache']) await mkdir(path.join(state, name), { recursive: true });
  const config = path.join(state, 'config.json');
  await writeFile(config, `${JSON.stringify({
    codexDir: codex,
    dbPath: path.join(sources, 'opencode', 'opencode.db'),
    claudeDir: path.join(sources, 'claude'),
    piDir: path.join(sources, 'pi'),
    dshDir: path.join(sources, 'dsh'),
    metaDir: path.join(state, 'meta'),
    indexDir: path.join(state, 'index'),
    cacheDir: path.join(state, 'cache'),
  })}\n`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('AGENTSESSION_') || key.toLowerCase() === 'path') delete env[key];
  }
  Object.assign(env, {
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    CODEX_HOME: path.join(root, 'codex-home'), XDG_CONFIG_HOME: path.join(root, 'xdg'),
    AGENTSESSION_CONFIG: config,
    PATH: '', NODE_OPTIONS: '', NODE_PATH: '',
  });
  for (const directory of [env.HOME, env.CODEX_HOME, env.XDG_CONFIG_HOME]) {
    await mkdir(directory);
  }
  const legacy = path.join(state, 'legacy-copy.db');
  const legacyDb = new DatabaseSync(legacy);
  legacyDb.exec(`CREATE TABLE session_meta (provider TEXT NOT NULL DEFAULT 'opencode',
    session_id TEXT NOT NULL, custom_title TEXT, starred INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0, permanent INTEGER DEFAULT 0, time_starred INTEGER,
    time_deleted INTEGER, time_renamed INTEGER, PRIMARY KEY(provider,session_id));`);
  legacyDb.prepare('INSERT INTO session_meta(provider,session_id,custom_title,starred) VALUES (?,?,?,?)')
    .run('codex', sessionId, 'Installed migration title', 1);
  legacyDb.close();
  const legacyHash = digest(await readFile(legacy));
  const scope = run(process.execPath, [viewer, 'migrate-meta', '--from', legacy, '--config', config],
    { cwd: working, env });
  assert.match(scope, /^[a-f0-9]{64}$/);
  assert.equal(digest(await readFile(legacy)), legacyHash);
  const target = path.join(state, 'meta', 'scopes', scope, 'meta.db');
  const targetHash = digest(await readFile(target));
  for (const globalConfig of [['--config', config], [`--config=${config}`]]) {
    const repeated = spawnSync(process.execPath,
      [viewer, ...globalConfig, 'migrate-meta', '--from', legacy],
      { cwd: working, env, encoding: 'utf8', timeout: 5_000, windowsHide: true });
    assert.notEqual(repeated.status, 0);
    assert.match(repeated.stderr, /already exists/);
    assert.equal(digest(await readFile(target)), targetHash);
    assert.equal(digest(await readFile(legacy)), legacyHash);
  }
  const port = await freeFetchSafePort();
  web = spawn(process.execPath, [viewer, '--config', config, '--port', String(port)],
    { cwd: working, env, stdio: 'ignore', windowsHide: true });
  const origin = `http://127.0.0.1:${port}`;
  await ready(origin, web);
  const settings = await (await fetch(`${origin}/api/settings`)).json();
  assert.equal(settings.startup.sources.codexDir, codex);
  assert.equal(settings.startup.state.metaDir, path.join(state, 'meta'));
  const importedMeta = await (await fetch(`${origin}/api/v3/meta?provider=codex`)).json();
  const importedRow = importedMeta.find(row => row.sessionId === sessionId);
  assert.equal(importedRow.customTitle, 'Installed migration title');
  assert.equal(importedRow.starred, true);
  const pageResponse = await fetch(`${origin}/sessions`);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  const assetPath = page.match(/(?:src|href)="(\/assets\/[^\"]+)"/)?.[1];
  assert.ok(assetPath, 'Installed Viewer HTML references an embedded frontend asset');
  const assetResponse = await fetch(`${origin}${assetPath}`);
  assert.equal(assetResponse.status, 200);
  assert.ok((await assetResponse.arrayBuffer()).byteLength > 0);
  const bootstrapResponse = await fetch(`${origin}/api/v3/reader/codex/${sessionId}/bootstrap`);
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  const query = new URLSearchParams({ messageId: 'assistant-1', segment: 'message', field: 'body',
    offset: '0', maxChars: '256', revision: bootstrap.revision });
  const contentResponse = await fetch(`${origin}/api/v3/reader/codex/${sessionId}/content?${query}`);
  assert.equal(contentResponse.status, 200);
  assert.equal((await contentResponse.json()).text, body);
  await stop(web);
  if (process.platform !== 'win32') {
    assert.equal(web.exitCode, 143, 'Viewer command forwards SIGTERM and reports its conventional exit status');
  }
  await waitForExit(web.pid);
  await assert.rejects(fetch(`${origin}/api/providers`, { signal: AbortSignal.timeout(500) }),
    'Installed Viewer port must close after its command exits');
  web = undefined;

  for (const args of [[], ['--config', config, 'serve'], [`--config=${config}`, 'serve']]) {
    const selectedPort = await freeFetchSafePort();
    const savedConfig = JSON.parse(await readFile(config, 'utf8'));
    await writeFile(config, `${JSON.stringify({ ...savedConfig, port: selectedPort })}\n`);
    web = spawn(process.execPath, [viewer, ...args],
      { cwd: working, env, stdio: 'ignore', windowsHide: true });
    const selectedOrigin = `http://127.0.0.1:${selectedPort}`;
    await ready(selectedOrigin, web);
    const rows = await (await fetch(`${selectedOrigin}/api/v3/meta?provider=codex`)).json();
    assert.equal(rows.find(row => row.sessionId === sessionId)?.customTitle, 'Installed migration title');
    await stop(web);
    await waitForExit(web.pid);
    web = undefined;
  }

  client = new Client({ name: 'agentsession-v3-npm-install-check', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [mcp, '--config', config], cwd: working, env, stderr: 'pipe' });
  await client.connect(transport);
  assert.ok(transport.pid);
  const mcpPid = transport.pid;
  const serverInfo = client.getServerVersion();
  assert.equal(serverInfo?.name, 'AgentSession-MCP');
  assert.equal(serverInfo?.version, version);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 7);
  assert.ok(tools.tools.some(tool => tool.name === 'session_get_event'));
  assert.ok(tools.tools.some(tool => tool.name === 'session_team_messages'));
  const event = await client.callTool({ name: 'session_get_event', arguments: {
    event: { provider: 'codex', sessionId, messageId: 'assistant-1', segment: 'message' },
    maxChars: 256,
  } });
  assert.notEqual(event.isError, true, event.content?.[0]?.text);
  assert.equal(event.structuredContent.result.content.text, body);
  await client.close();
  await waitForExit(mcpPid);
  client = undefined;
  client = new Client({ name: 'agentsession-v3-viewer-mcp-check', version: '1.0.0' });
  const explicitTransport = new StdioClientTransport({ command: process.execPath,
    args: [viewer, '--config', config, 'mcp'], cwd: working, env, stderr: 'pipe' });
  await client.connect(explicitTransport);
  assert.equal((await client.listTools()).tools.length, 7);
  const explicitPid = explicitTransport.pid;
  await client.close();
  await waitForExit(explicitPid);
  client = undefined;
  assert.equal(digest(await readFile(legacy)), legacyHash);
  assert.equal(digest(await readFile(copiedFixture)), fixtureHash);
  assert.equal(digest(await readFile(fixture)), fixtureHash);
});
