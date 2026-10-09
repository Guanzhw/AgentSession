import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = path.resolve(import.meta.dirname, '../..');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const fixture = path.join(repo, 'v3', 'fixtures', 'codex');
const sessionId = '44444444-4444-4444-8444-444444444444';
const testChildren = new WeakMap();
const testClients = new WeakMap();

async function setup(t) {
  assert.ok(existsSync(binary), `Build ${binary} first`);
  const dir = await mkdtemp(path.join(tmpdir(), 'agentsession-v3-cli-'));
  const children = [];
  const clients = [];
  testChildren.set(t, children);
  testClients.set(t, clients);
  t.after(async () => {
    for (const client of clients) await client.close();
    const closed = children.map(child => child.exitCode === null && child.signalCode === null
      ? once(child, 'close') : Promise.resolve());
    for (const child of children) child.kill();
    await Promise.all(closed);
    await rm(dir, { recursive: true, force: true });
  });
  for (const name of ['home', 'roaming', 'config', 'data', 'codex', 'claude', 'pi', 'dsh', 'other']) {
    await mkdir(path.join(dir, name));
  }
  const env = {
    ...process.env,
    HOME: path.join(dir, 'home'), USERPROFILE: path.join(dir, 'home'),
    APPDATA: path.join(dir, 'roaming'), LOCALAPPDATA: path.join(dir, 'data'),
    XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_DATA_HOME: path.join(dir, 'data'),
    CODEX_HOME: path.join(dir, 'codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    PI_CODING_AGENT_DIR: path.join(dir, 'pi'), DSH_HOME: path.join(dir, 'dsh'),
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith('AGENTSESSION_')) delete env[key];
  }
  return { dir, env };
}

async function freePort() {
  return freeFetchSafePort();
}

async function serve(t, cwd, env, args = [], options = {}) {
  const port = options.port || await freePort();
  const portArgs = options.fromConfig ? [] : ['--port', String(port)];
  const child = spawn(binary, ['serve', ...portArgs, ...args],
    { cwd, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  testChildren.get(t).push(child);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`v3 exited: ${stderr}`);
    try {
      const response = await fetch(`${origin}/api/providers`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return { origin, providers: await response.json() };
    } catch { /* Listener is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`v3 did not start: ${stderr}`);
}

function explicitPaths(dir) {
  return ['--codex-dir', fixture, '--opencode-db', path.join(dir, 'opencode.db'),
    '--claude-dir', path.join(dir, 'claude'), '--pi-dir', path.join(dir, 'pi'),
    '--dsh-dir', path.join(dir, 'dsh'), '--meta-dir', path.join(dir, 'meta'),
    '--index-dir', path.join(dir, 'index'), '--cache-dir', path.join(dir, 'cache')];
}

test('all existing explicit flags still select their sources and state outside checkout cwd',
  { timeout: 30_000 }, async t => {
    const { dir, env } = await setup(t);
    const source = readFileSync(path.join(fixture, 'sessions', '2026', '09', '26',
      `rollout-2026-09-26T00-00-00-${sessionId}.jsonl`));
    const { origin } = await serve(t, dir, env, explicitPaths(dir));
    const response = await fetch(`${origin}/api/v3/reader/codex/${sessionId}/bootstrap`);
    assert.equal(response.status, 200);
    assert.equal(readFileSync(path.join(fixture, 'sessions', '2026', '09', '26',
      `rollout-2026-09-26T00-00-00-${sessionId}.jsonl`)).compare(source), 0);
    assert.equal(existsSync(path.join(dir, 'meta', 'meta.db')), false);
    assert.equal(existsSync(path.join(dir, 'roaming', 'agentsession', 'meta.db')), false);
  });

test('default roots discover provider data while derived state stays under agentsession-v3',
  { timeout: 30_000 }, async t => {
    const { dir, env } = await setup(t);
    env.CODEX_HOME = fixture;
    const { origin } = await serve(t, dir, env);
    assert.equal((await fetch(`${origin}/api/v3/reader/codex/${sessionId}/bootstrap`)).status, 200);
    assert.equal((await fetch(`${origin}/api/v3/sessions?provider=codex`)).status, 200);
    const stateRoot = path.join(process.platform === 'win32' ? env.APPDATA : env.XDG_CONFIG_HOME,
      'agentsession-v3');
    assert.equal(existsSync(path.join(stateRoot, 'index')), true);
    assert.equal(existsSync(path.join(process.platform === 'win32' ? env.APPDATA : env.XDG_CONFIG_HOME,
      'agentsession', 'meta.db')), false);
  });

test('selected JSON, AgentSession env and CLI resolve in that order for source and port',
  { timeout: 30_000 }, async t => {
    const { dir, env } = await setup(t);
    const selected = path.join(dir, 'selected.json');
    const ignored = path.join(dir, 'ignored.json');
    await writeFile(selected, JSON.stringify({ codexDir: path.join(dir, 'other'), port: 1 }));
    await writeFile(ignored, JSON.stringify({ codexDir: path.join(dir, 'other') }));
    env.AGENTSESSION_CONFIG = ignored;
    env.AGENTSESSION_CODEX_DIR = fixture;
    env.PORT = '2';
    const { origin } = await serve(t, dir, env, ['--config', selected]);
    assert.equal((await fetch(`${origin}/api/v3/reader/codex/${sessionId}/bootstrap`)).status, 200);
    const second = await serve(t, dir, { ...env, AGENTSESSION_CODEX_DIR: path.join(dir, 'other') },
      ['--config', selected, '--codex-dir', fixture]);
    assert.equal((await fetch(`${second.origin}/api/v3/reader/codex/${sessionId}/bootstrap`)).status, 200);
    const envPort = await freePort();
    const third = await serve(t, dir, { ...env, PORT: String(envPort) },
      ['--config', selected], { port: envPort, fromConfig: true });
    assert.equal((await fetch(`${third.origin}/api/v3/reader/codex/${sessionId}/bootstrap`)).status, 200);
  });

test('selected JSON supplies source, state paths and HTTP port without CLI path flags',
  { timeout: 30_000 }, async t => {
    const { dir, env } = await setup(t);
    const port = await freePort();
    const config = path.join(dir, 'selected.json');
    const index = path.join(dir, 'configured-index');
    const meta = path.join(dir, 'configured-meta');
    const cache = path.join(dir, 'configured-cache');
    await writeFile(config, JSON.stringify({ codexDir: fixture, indexDir: index,
      metaDir: meta, cacheDir: cache, port }));
    const original = readFileSync(config);
    const { origin } = await serve(t, dir, env, ['--config', config], { port, fromConfig: true });
    assert.equal((await fetch(`${origin}/api/v3/reader/codex/${sessionId}/bootstrap`)).status, 200);
    assert.equal((await fetch(`${origin}/api/v3/sessions?provider=codex`)).status, 200);
    assert.equal(existsSync(index), true);
    assert.equal(readFileSync(config).compare(original), 0);
  });

test('unsupported keys, malformed JSON and invalid types fail with config diagnostics',
  { timeout: 30_000 }, async t => {
    const { dir, env } = await setup(t);
    for (const [body, fragment] of [
      ['{"unknownSetting":{}}', 'unknownSetting'],
      ['{"resumeCommands":{"pi":{"executable":"node","args":23}}}', 'resumeCommands'],
      ['{"resumeCommands":{"pi":{"executable":"","args":[]}}}', 'resume'],
      ['{"resumeShell":{"executable":""}}', 'resume'],
      ['{"codexDir":23}', 'codexDir'],
      ['{"port":70000}', 'port'],
      ['{"codexDir":', 'JSON'],
    ]) {
      const config = path.join(dir, 'invalid.json');
      await writeFile(config, body);
      const run = spawnSync(binary, ['serve', '--config', config, '--port', '0'],
        { cwd: dir, env, encoding: 'utf8', timeout: 5000, windowsHide: true });
      assert.notEqual(run.status, 0, body);
      assert.match(run.stderr, new RegExp(fragment, 'i'), body);
    }
  });

test('stdio MCP starts from non-checkout cwd using discovered paths',
  { timeout: 30_000 }, async t => {
    const { dir, env } = await setup(t);
    env.AGENTSESSION_CODEX_DIR = fixture;
    const client = new Client({ name: 'cli-config-slice', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: binary, args: ['mcp'],
      cwd: dir, env, stderr: 'pipe' });
    try { await client.connect(transport); }
    catch (error) { await transport.close(); throw error; }
    testClients.get(t).push(client);
    assert.equal((await client.listTools()).tools.length, 7);
  });
