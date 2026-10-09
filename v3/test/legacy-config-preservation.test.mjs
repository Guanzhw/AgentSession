import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const evidenceRoot = path.join(repo, 'tmp/v3-delivery/legacy-config-preservation');
const fixture = path.join(repo, 'v3/fixtures/codex');
const sessionId = '44444444-4444-4444-8444-444444444444';
const fixtureFile = path.join(fixture, 'sessions/2026/09/26',
  `rollout-2026-09-26T00-00-00-${sessionId}.jsonl`);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function listenerOpen(port) {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function setup(t, name) {
  await mkdir(evidenceRoot, { recursive: true });
  const dir = await mkdtemp(path.join(evidenceRoot, `${name}-`));
  const config = path.join(dir, 'config.json');
  for (const relative of ['meta', 'index', 'cache', 'claude', 'pi', 'dsh',
    'user/roaming', 'user/local', 'user/home', 'user/temp']) {
    await mkdir(path.join(dir, relative), { recursive: true });
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('AGENTSESSION_') || ['PORT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
      'PI_CODING_AGENT_DIR', 'DSH_HOME'].includes(key)) delete env[key];
  }
  Object.assign(env, {
    APPDATA: path.join(dir, 'user/roaming'), LOCALAPPDATA: path.join(dir, 'user/local'),
    HOME: path.join(dir, 'user/home'), USERPROFILE: path.join(dir, 'user/home'),
    TEMP: path.join(dir, 'user/temp'), TMP: path.join(dir, 'user/temp'),
    AGENTSESSION_CONFIG: config,
  });
  const sourceArgs = ['--codex-dir', fixture, '--claude-dir', path.join(dir, 'claude'),
    '--pi-dir', path.join(dir, 'pi'), '--dsh-dir', path.join(dir, 'dsh'),
    '--opencode-db', path.join(dir, 'missing.db'), '--meta-dir', path.join(dir, 'meta'),
    '--index-dir', path.join(dir, 'index'), '--cache-dir', path.join(dir, 'cache')];
  const beforeSourceHash = sha(await readFile(fixtureFile));
  const children = [];
  async function stop(child) {
    const record = children.find(item => item.child === child);
    if (!record) return;
    if (!record.closed) {
      const done = once(child, 'close');
      child.kill();
      await Promise.race([done, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('scratch process did not close')), 5000);
        timer.unref();
      })]);
    }
    record.listenerClosed = !(await listenerOpen(record.port));
    record.pidAbsent = false;
    try { process.kill(child.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') record.pidAbsent = true; else throw error; }
    assert.ok(record.closed && record.listenerClosed && record.pidAbsent,
      'scratch process close event, absent PID, and closed listener are required');
  }
  t.after(async () => {
    try {
      for (const { child } of children) await stop(child);
      const afterSourceHash = sha(await readFile(fixtureFile));
      assert.equal(afterSourceHash, beforeSourceHash, 'public provider fixture remains read-only');
      const records = children.map(({ child, ...record }) => record);
      await writeFile(path.join(evidenceRoot, `${path.basename(dir)}.lifecycle.json`),
        JSON.stringify({ name, beforeSourceHash, afterSourceHash, children: records }, null, 2));
      t.diagnostic(JSON.stringify({ sourceUnchanged: true,
        children: records.map(({ pid, port, closed, pidAbsent, listenerClosed }) =>
          ({ pid, port, closed, pidAbsent, listenerClosed })) }));
    } finally {
      assert.ok(path.resolve(dir).startsWith(path.resolve(evidenceRoot) + path.sep));
      await rm(dir, { recursive: true, force: true });
    }
  });
  async function start({ disabled = true } = {}) {
    const port = await freeFetchSafePort();
    const child = spawn(binary, ['serve', '--config', config, '--port', String(port),
      ...(disabled ? ['--disable-terminal-launch'] : []), ...sourceArgs],
    { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const record = { child, pid: child.pid, port, closed: null, stderr: '' };
    children.push(record);
    child.stderr.on('data', chunk => { record.stderr += chunk; });
    child.once('close', (code, signal) => { record.closed = { code, signal }; });
    const base = `http://127.0.0.1:${port}`;
    for (let retry = 0; retry < 100; retry++) {
      if (record.closed) throw new Error(`Valid legacy configuration rejected: ${record.stderr.trim()}`);
      try {
        const response = await fetch(base + '/api/settings', { signal: AbortSignal.timeout(1000) });
        if (response.ok) return { base, child };
      } catch { /* The isolated listener is starting. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Isolated legacy config server did not start: ${record.stderr}`);
  }
  return { dir, config, env, sourceArgs, start, stop };
}

async function get(base, route) {
  const response = await fetch(base + route, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  return response.json();
}

async function post(base, route, value) {
  return fetch(base + route, { method: 'POST', headers: {
    origin: base, 'content-type': 'application/json',
  }, body: JSON.stringify(value), signal: AbortSignal.timeout(5000) });
}

test('valid 2.0 startup and resume fields survive an unrelated Settings edit and restart',
  { timeout: 30_000 }, async t => {
    // src/config.ts retains these file fields, accepts stdin="prompt" and empty
    // resumeShell; JSON launch permission is ignored in favor of process startup.
    const f = await setup(t, 'retention');
    const initial = {
      lang: 'zh', reindex: true, allowTerminalLaunch: false, open: false,
      resumeCommands: { codex: { executable: process.execPath, args: ['--version'],
        cwd: f.dir, stdin: 'prompt' } },
      resumeShell: {},
    };
    await writeFile(f.config, JSON.stringify(initial));
    let { base, child } = await f.start();
    const settings = await get(base, '/api/settings');
    assert.equal(settings.configFile.loaded, true);
    assert.equal(settings.runtime.resumeCommands.codex.executable, process.execPath);
    const bootstrap = await get(base, `/api/v3/reader/codex/${sessionId}/bootstrap`);
    assert.deepEqual(bootstrap.session.session, { provider: 'codex', sessionId });
    const params = new URLSearchParams({ messageId: 'assistant-1', segment: 'message',
      field: 'body', offset: '0', maxChars: '500', revision: bootstrap.revision });
    assert.equal((await get(base, `/api/v3/reader/codex/${sessionId}/content?${params}`)).text,
      'Hello 🙂 from the Rust slice. Continue to the complete ending.');
    const route = `/api/v3/resume/codex/${sessionId}`;
    const before = await get(base, route);
    assert.equal(before.allowTerminalLaunch, false);
    assert.equal((await post(base, route, {})).status, 403);
    const projectPaths = { codex: { 'legacy-retention': f.dir } };
    const saved = await post(base, '/api/settings', { projectPaths });
    assert.equal(saved.status, 200, await saved.text());
    assert.deepEqual((await get(base, '/api/settings')).runtime.projectPaths, projectPaths);
    assert.deepEqual(JSON.parse(await readFile(f.config, 'utf8')), { ...initial, projectPaths });
    const savedBytes = await readFile(f.config);
    await f.stop(child);
    ({ base, child } = await f.start());
    assert.deepEqual((await get(base, '/api/settings')).runtime.projectPaths, projectPaths);
    assert.deepEqual(await get(base, route), before);
    assert.equal((await post(base, route, {})).status, 403);
    assert.deepEqual(await readFile(f.config), savedBytes);
  });

test('legacy empty resumeShell has the same default-shell preview as null',
  { timeout: 20_000 }, async t => {
    // src/resume.ts isShellSpec({}) is false and resolvePowerShellLaunch falls
    // back to its default shell; stdin="prompt" is accepted but has no consumer.
    const f = await setup(t, 'default-shell');
    const initial = { resumeCommands: { codex: { executable: process.execPath,
      args: ['--version'], cwd: f.dir, stdin: 'prompt' } }, resumeShell: {} };
    await writeFile(f.config, JSON.stringify(initial));
    const { base } = await f.start();
    const route = `/api/v3/resume/codex/${sessionId}`;
    const empty = await get(base, route);
    const result = await post(base, '/api/settings', { resumeShell: null });
    assert.equal(result.status, 200, await result.text());
    assert.deepEqual(await get(base, route), empty);
    assert.deepEqual(JSON.parse(await readFile(f.config, 'utf8')),
      { ...initial, resumeShell: null });
    assert.equal((await post(base, route, {})).status, 403);
  });

test('saved JSON launch permission stays subordinate to process startup',
  { timeout: 20_000 }, async t => {
    const f = await setup(t, 'startup-launch-permission');
    const initial = { allowTerminalLaunch: false, open: false };
    await writeFile(f.config, JSON.stringify(initial));
    let { base, child } = await f.start({ disabled: false });
    const route = `/api/v3/resume/codex/${sessionId}`;
    assert.equal((await get(base, route)).allowTerminalLaunch, true);
    assert.equal((await get(base, '/api/settings')).startup.allowTerminalLaunch, true);
    await f.stop(child);
    ({ base, child } = await f.start());
    assert.equal((await get(base, route)).allowTerminalLaunch, false);
    assert.equal((await get(base, '/api/settings')).startup.allowTerminalLaunch, false);
    assert.equal((await post(base, route, {})).status, 403);
    assert.deepEqual(JSON.parse(await readFile(f.config, 'utf8')), initial);
  });

test('stdin other than the v2 prompt value and new unknown top-level keys remain rejected',
  { timeout: 20_000 }, async t => {
    // src/config.ts:256 rejects non-prompt stdin. The 3.0 selected-config owner
    // rejects unknown keys; accepting known legacy fields must retain that boundary.
    const f = await setup(t, 'invalid-boundary');
    for (const [config, diagnostic] of [
      [{ resumeCommands: { codex: { executable: process.execPath, args: [],
        stdin: 'file' } } }, /stdin/],
      [{ newUnknownConfigurationKey: true }, /unsupported key/],
    ]) {
      const bytes = JSON.stringify(config);
      await writeFile(f.config, bytes);
      const port = await freeFetchSafePort();
      const result = spawnSync(binary, ['serve', '--config', f.config,
        '--port', String(port), '--disable-terminal-launch', ...f.sourceArgs],
      { cwd: f.dir, env: f.env, windowsHide: true, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, diagnostic);
      assert.equal(await readFile(f.config, 'utf8'), bytes);
      assert.equal(await listenerOpen(port), false);
    }
  });
