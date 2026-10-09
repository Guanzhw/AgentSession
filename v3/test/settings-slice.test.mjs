import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '../..');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');

async function freePort() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const server = createServer();
    const port = 20000 + Math.floor(Math.random() * 40000);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
    } catch (error) {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') continue;
      throw error;
    }
    await new Promise(resolve => server.close(resolve));
    return port;
  }
  throw new Error('Could not select a free Fetch-compatible loopback port');
}

async function settingsServer(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentsession-v3-settings-boundary-'));
  const config = path.join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ resumeCommands: { pi: false } }));
  const port = await freePort();
  const child = spawn(binary, ['serve', '--config', config, '--port', String(port),
    '--codex-dir', path.join(dir, 'codex'), '--claude-dir', path.join(dir, 'claude'),
    '--pi-dir', path.join(dir, 'pi'), '--dsh-dir', path.join(dir, 'dsh'),
    '--opencode-db', path.join(dir, 'opencode.db'), '--meta-dir', path.join(dir, 'meta'),
    '--index-dir', path.join(dir, 'index'), '--cache-dir', path.join(dir, 'cache')],
  { cwd: dir, windowsHide: true, stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'close'); child.kill(); await done; }
    await rm(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Settings process exited');
    try { if ((await fetch(origin + '/api/settings')).ok) break; } catch {}
    if (i === 99) throw new Error('Settings process did not start');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { dir, config, child, get: () => fetch(origin + '/api/settings').then(r => r.json()),
    post: body => fetch(origin + '/api/settings', { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }) };
}

test('abandoned temporary sibling does not prevent later settings saves', { timeout: 30_000 }, async t => {
  const f = await settingsServer(t);
  const abandoned = path.join(f.dir, `config.${f.child.pid}.tmp`);
  await writeFile(abandoned, 'abandoned prior attempt');
  assert.equal((await f.post({ resumeShell: null })).status, 200);
  assert.equal((await f.post({ resumeCommands: {} })).status, 200);
  assert.equal(await readFile(abandoned, 'utf8'), 'abandoned prior attempt');
  assert.deepEqual((await readdir(f.dir)).filter(name => name.endsWith('.tmp')), [path.basename(abandoned)]);
});

test('settings save validates the full merged configuration after external edits', { timeout: 30_000 }, async t => {
  const f = await settingsServer(t);
  const before = await f.get();
  for (const external of [{ port: 'bad' }, { codexDir: 8 }, { unsupported: true },
    { resumeShell: { executable: '' } }, { projectPaths: { codex: { opaque: 'relative/path' } } }]) {
    const body = JSON.stringify({ resumeCommands: { pi: false }, ...external });
    await writeFile(f.config, body);
    const result = await f.post({ resumeCommands: {} });
    assert.equal(result.status, 500, JSON.stringify(external));
    assert.equal((await result.json()).error.code, 'settings_save_failed');
    assert.equal(await readFile(f.config, 'utf8'), body);
    assert.deepEqual(await f.get(), before);
    assert.deepEqual((await readdir(f.dir)).filter(name => name.endsWith('.tmp')), []);
  }
  await writeFile(f.config, JSON.stringify({ port: 9000, resumeShell: { executable: 'external-shell', args: [] } }));
  const saved = await f.post({ resumeCommands: {} });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).runtime.resumeShell.executable, 'external-shell');
  assert.equal(JSON.parse(await readFile(f.config, 'utf8')).port, 9000);
});

test('settings report effective startup selection and reject unsupported live writes', { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentsession-v3-settings-'));
  const port = await freePort();
  const selected = path.join(dir, 'config.json');
  const fileCodex = path.join(dir, 'file-codex');
  const envCodex = path.join(dir, 'env-codex');
  const cliCodex = path.join(dir, 'cli-codex');
  await Promise.all([fileCodex, envCodex, cliCodex].map(dir => mkdir(dir)));
  await writeFile(selected, JSON.stringify({ port: 1, codexDir: fileCodex }));
  const env = { ...process.env, AGENTSESSION_CONFIG: selected, AGENTSESSION_CODEX_DIR: envCodex };
  const child = spawn(binary, ['serve', '--port', String(port), '--codex-dir', cliCodex,
    '--meta-dir', path.join(dir, 'meta'), '--index-dir', path.join(dir, 'index'),
    '--cache-dir', path.join(dir, 'cache')],
  { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    const closed = child.exitCode === null && child.signalCode === null ? once(child, 'close') : Promise.resolve();
    child.kill();
    await closed;
    await rm(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`;
  let response;
  for (let retry = 0; retry < 100; retry++) {
    if (child.exitCode !== null) throw new Error(`v3 exited: ${stderr}`);
    try { response = await fetch(origin + '/api/settings'); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(response, stderr);
  assert.equal(response.status, 200);
  const settings = await response.json();
  assert.equal(settings.configFile.path, selected);
  assert.equal(settings.configFile.loaded, true);
  assert.equal(settings.startup.port, port);
  assert.equal(settings.startup.sources.codexDir, cliCodex);
  assert.equal(settings.startup.state.metaDir, path.join(dir, 'meta'));
  assert.deepEqual(settings.runtimeEditable, ['projectPaths', 'resumeCommands', 'resumeShell', 'tokenPricing']);
  assert.equal((await fetch(origin + '/settings')).status, 200);
  const mutation = await fetch(origin + '/api/settings', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ config: { projectPaths: {} } }),
  });
  assert.equal(mutation.status, 400);
  assert.deepEqual(JSON.parse(await readFile(selected, 'utf8')), { port: 1, codexDir: fileCodex });
});

test('resume settings save live, preserve startup config, and survive restart', { timeout: 45_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentsession-v3-settings-write-'));
  const config = path.join(dir, 'config.json');
  const pi = path.join(dir, 'pi', 'sessions', 'project');
  await mkdir(pi, { recursive: true });
  const source = path.join(pi, 'session.jsonl');
  const sourceBody = JSON.stringify({ type: 'session', version: 3, id: 'settings-session', cwd: dir,
    timestamp: '2026-09-27T00:00:00.000Z' }) + '\n';
  await writeFile(source, sourceBody);
  await writeFile(config, JSON.stringify({ port: 1, piDir: path.join(dir, 'pi'), resumeCommands: { pi: false } }));
  let child;
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'close'); child.kill(); await done;
    }
  };
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
  const start = async (disabled = false) => {
    const port = await freePort();
    child = spawn(binary, ['serve', '--config', config, '--port', String(port),
      ...(disabled ? ['--disable-terminal-launch'] : []),
      '--codex-dir', path.join(dir, 'codex'), '--claude-dir', path.join(dir, 'claude'),
      '--dsh-dir', path.join(dir, 'dsh'), '--opencode-db', path.join(dir, 'opencode.db'),
      '--meta-dir', path.join(dir, 'meta'), '--index-dir', path.join(dir, 'index'), '--cache-dir', path.join(dir, 'cache')],
    { cwd: dir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    const origin = `http://127.0.0.1:${port}`;
    let lastResponse = '';
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Settings process exited: ${stderr}`);
      try {
        const response = await fetch(origin + '/api/settings');
        if (response.ok) return origin;
        lastResponse = `${response.status}: ${(await response.text()).slice(0, 500)}`;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Settings process did not start on ${origin}; response=${lastResponse}; stderr=${stderr}`);
  };
  let origin = await start();
  const post = (body, headers = {}) => fetch(origin + '/api/settings', {
    method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const preview = () => fetch(origin + '/api/v3/resume/pi/settings-session').then(r => r.json());
  assert.equal((await preview()).command, null);
  const update = { resumeCommands: { pi: { executable: process.execPath, args: ['{sessionId}'], cwd: dir } },
    resumeShell: { executable: 'pwsh.exe', args: ['-NoLogo'] } };
  const runtime = { projectPaths: {}, tokenPricing: {}, ...update };
  const saved = await post(update);
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).runtime, runtime);
  assert.deepEqual((await (await fetch(origin + '/api/settings')).json()).runtime, runtime);
  assert.equal((await preview()).command.executable, process.execPath);
  assert.deepEqual((await preview()).command.args, ['settings-session']);
  const persisted = JSON.parse(await readFile(config, 'utf8'));
  assert.deepEqual(persisted, { port: 1, piDir: path.join(dir, 'pi'), ...update });
  for (const bad of [{ port: 9000 }, { allowTerminalLaunch: true },
    { resumeCommands: { retired: false } }, { resumeShell: { executable: '' } },
    { resumeCommands: { pi: { executable: process.execPath, args: [], extra: true } } }]) {
    const rejected = await post(bad);
    assert.equal(rejected.status, 400, JSON.stringify(bad));
    assert.equal((await rejected.json()).error.code, 'invalid_settings');
  }
  assert.equal((await post(update, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await fetch(origin + '/api/settings', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(update) })).status, 403);
  const foreignHost = await new Promise((resolve, reject) => {
    const req = request(origin + '/api/settings', { method: 'POST', headers: {
      host: 'untrusted.example', origin, 'content-type': 'application/json',
    } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end(JSON.stringify(update));
  });
  assert.equal(foreignHost, 403);
  assert.equal((await post(update, { 'content-type': 'text/plain' })).status, 415);
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), persisted);
  await writeFile(config, '{invalid');
  const failedSave = await post({ resumeCommands: { pi: false } });
  assert.equal(failedSave.status, 500);
  assert.equal((await failedSave.json()).error.code, 'settings_save_failed');
  assert.deepEqual((await (await fetch(origin + '/api/settings')).json()).runtime, runtime);
  assert.equal((await preview()).command.executable, process.execPath);
  assert.equal(await readFile(config, 'utf8'), '{invalid');
  await writeFile(config, JSON.stringify(persisted));
  await stop(); origin = await start(true);
  assert.deepEqual((await (await fetch(origin + '/api/settings')).json()).runtime, runtime);
  assert.equal((await preview()).allowTerminalLaunch, false);
  assert.equal((await post({ resumeCommands: { pi: false }, resumeShell: null })).status, 200);
  assert.equal((await preview()).allowTerminalLaunch, false);
  assert.equal(await readFile(source, 'utf8'), sourceBody);
});
