import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '../..');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const deliveryTmp = path.join(repo, 'tmp/v3-delivery/browser-open');
const codexFixture = path.join(repo, 'v3/fixtures/codex');
const codexFixtureSession = path.join(codexFixture, 'sessions/2026/09/26',
  'rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl');

const safePort = freeFetchSafePort;

async function fixtureHash() {
  return createHash('sha256').update(await readFile(codexFixtureSession)).digest('hex');
}

async function createRunDir() {
  await mkdir(deliveryTmp, { recursive: true });
  return mkdtemp(path.join(deliveryTmp, 'run-'));
}

async function removeRunDir(dir) {
  const base = path.resolve(deliveryTmp);
  const target = path.resolve(dir);
  const relative = path.relative(base, target);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative), `Refusing to remove a path outside ${base}: ${target}`);
  await rm(target, { recursive: true, force: true });
}

function sourceArgs(dir) {
  return ['--codex-dir', codexFixture,
    '--claude-dir', path.join(dir, 'sources/claude'),
    '--pi-dir', path.join(dir, 'sources/pi'),
    '--dsh-dir', path.join(dir, 'sources/dsh'),
    '--opencode-db', path.join(dir, 'sources/opencode/missing.db'),
    '--meta-dir', path.join(dir, 'state/meta'),
    '--index-dir', path.join(dir, 'state/index'),
    '--cache-dir', path.join(dir, 'state/cache')];
}

function isolatedEnv(dir) {
  const home = path.join(dir, 'home');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(dir, 'appdata'),
    LOCALAPPDATA: path.join(dir, 'localappdata'),
    XDG_CONFIG_HOME: path.join(dir, 'xdg-config'),
    XDG_DATA_HOME: path.join(dir, 'xdg-data'),
    TMP: path.join(dir, 'temp'),
    TEMP: path.join(dir, 'temp'),
  };
  for (const name of ['AGENTSESSION_CONFIG', 'AGENTSESSION_V3_META_DIR',
    'AGENTSESSION_CODEX_DIR', 'CODEX_HOME', 'AGENTSESSION_DB_PATH',
    'AGENTSESSION_CLAUDE_DIR', 'CLAUDE_CONFIG_DIR', 'AGENTSESSION_PI_DIR',
    'PI_CODING_AGENT_DIR', 'AGENTSESSION_DSH_DIR', 'DSH_HOME',
    'AGENTSESSION_V3_INDEX_DIR', 'AGENTSESSION_V3_CACHE_DIR', 'PORT']) {
    delete env[name];
  }
  return env;
}

async function startServer(t, dir, { open = false, pathValue, afterStop } = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'config.json'), JSON.stringify(open ? { open: true } : {}));
  const port = await safePort();
  const env = isolatedEnv(dir);
  if (pathValue !== undefined) env.PATH = pathValue;
  const child = spawn(binary, ['serve', '--disable-terminal-launch',
    '--config', path.join(dir, 'config.json'),
    '--port', String(port), ...sourceArgs(dir)], {
    cwd: dir,
    env,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      let timeout;
      try {
        await Promise.race([closed, new Promise(resolve => { timeout = setTimeout(resolve, 5_000); })]);
      } finally {
        clearTimeout(timeout);
      }
    }
    assert.ok(child.exitCode !== null || child.signalCode !== null,
      `AgentSession process ${child.pid} did not close after termination.`);
    await assert.rejects(fetch(origin + '/api/settings', { signal: AbortSignal.timeout(1_000) }),
      'the test server listener should close with its child process');
  };
  t.after(async () => {
    await stop();
    await afterStop?.();
  });

  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`AgentSession exited before serving (${child.exitCode ?? child.signalCode}): ${stderr}`);
    }
    try {
      const response = await fetch(origin + '/api/settings');
      if (response.ok) return { child, origin, stderr: () => stderr, stop };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`AgentSession did not start on ${origin}: ${stderr}`);
}

test('default-off config starts the isolated Viewer',
  { timeout: 30_000 }, async t => {
    const before = await fixtureHash();
    const dir = await createRunDir();
    const server = await startServer(t, dir, { afterStop: async () => {
      await removeRunDir(dir);
      assert.equal(await fixtureHash(), before, 'the published fixture must remain unchanged');
    } });
    assert.equal((await fetch(server.origin + '/api/settings')).status, 200);
    assert.doesNotMatch(server.stderr(), /Could not open the Viewer/);
  });

test('serve exposes --open and config.open parses in the isolated migration command',
  { timeout: 20_000 }, async t => {
    const before = await fixtureHash();
    const dir = await createRunDir();
    t.after(async () => {
      await removeRunDir(dir);
      assert.equal(await fixtureHash(), before, 'the published fixture must remain unchanged');
    });

    const help = spawnSync(binary, ['serve', '--open', '--help'], {
      cwd: dir, env: isolatedEnv(dir), encoding: 'utf8', windowsHide: true, timeout: 5_000,
    });

    const config = path.join(dir, 'config.json');
    await writeFile(config, JSON.stringify({ open: true }));
    const migrationSource = path.join(dir, 'missing-meta.db');
    const result = spawnSync(binary, ['--config', config, 'migrate-meta', '--from', migrationSource,
      ...sourceArgs(dir)], {
      cwd: dir,
      env: isolatedEnv(dir),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    assert.notEqual(result.error?.code, 'ETIMEDOUT', 'config parsing must complete promptly');
    const cliFlagAccepted = help.status === 0 && /--open\b/.test(help.stdout);
    const configAccepted = !/open: unsupported key/.test(result.stderr)
      && result.status !== 0
      && /missing-meta\.db|No such file|cannot open/i.test(result.stderr);
    assert.ok(cliFlagAccepted && configAccepted,
      `serve --open help status=${help.status}, stdout=${help.stdout}, stderr=${help.stderr}; `
      + `config open migration status=${result.status}, stdout=${result.stdout}, stderr=${result.stderr}`);
  });

test('a missing Unix browser launcher is diagnosed while the Viewer keeps serving', {
  timeout: 30_000,
  skip: process.platform === 'win32'
    ? 'Windows launcher lookup includes system directories and cannot be safely shadowed by PATH.'
    : false,
}, async t => {
  const before = await fixtureHash();
  const dir = await createRunDir();
  const server = await startServer(t, dir, {
    open: true,
    pathValue: path.join(dir, 'missing-path'),
    afterStop: async () => {
      await removeRunDir(dir);
      assert.equal(await fixtureHash(), before, 'the published fixture must remain unchanged');
    },
  });
  assert.equal((await fetch(server.origin + '/api/settings')).status, 200);
  for (let attempt = 0; attempt < 30 && !/Could not open the Viewer/.test(server.stderr()); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(server.stderr(), /Could not open the Viewer in the default browser/);
});
