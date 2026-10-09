import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '../..');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');

async function freePort() {
  return freeFetchSafePort();
}

test('2.0 projectPaths for active providers survive settings saves and restart',
  { timeout: 30_000 }, async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-project-paths-'));
    const config = path.join(dir, 'config.json');
    const mapped = path.join(dir, 'mapped-project');
    await mkdir(mapped);
    const initial = {
      resumeCommands: { pi: false },
      projectPaths: Object.fromEntries(
        ['opencode', 'claude-code', 'codex', 'pi', 'deepseek-harness']
          .map(provider => [provider, { [`opaque-${provider}`]: mapped }])),
    };
    await writeFile(config, JSON.stringify(initial));
    let child;
    const stop = async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill();
        await closed;
      }
    };
    t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
    const start = async () => {
      const port = await freePort();
      child = spawn(binary, ['serve', '--config', config, '--port', String(port),
        '--codex-dir', path.join(dir, 'codex'), '--claude-dir', path.join(dir, 'claude'),
        '--pi-dir', path.join(dir, 'pi'), '--dsh-dir', path.join(dir, 'dsh'),
        '--opencode-db', path.join(dir, 'missing.db'), '--meta-dir', path.join(dir, 'meta'),
        '--index-dir', path.join(dir, 'index'), '--cache-dir', path.join(dir, 'cache')],
      { cwd: dir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      const origin = `http://127.0.0.1:${port}`;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error(`3.0 rejected a 2.0 projectPaths config: ${stderr}`);
        try { if ((await fetch(origin + '/api/settings')).ok) return origin; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`Settings server did not start: ${stderr}`);
    };
    let origin = await start();
    const get = () => fetch(origin + '/api/settings').then(response => response.json());
    const post = value => fetch(origin + '/api/settings', { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(value) });
    assert.ok((await get()).runtimeEditable.includes('projectPaths'));
    assert.deepEqual((await get()).runtime.projectPaths, initial.projectPaths);
    const changed = { ...initial.projectPaths, 'claude-code': { 'opaque-claude-code': mapped,
      'another-opaque-key': mapped } };
    const saved = await post({ projectPaths: changed });
    assert.equal(saved.status, 200, await saved.text());
    assert.deepEqual((await get()).runtime.projectPaths, changed);
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).projectPaths, changed);
    for (const invalid of [
      { retired: { key: mapped } },
      { codex: { key: 'relative/path' } },
      { codex: { '': mapped } },
      { codex: { key: '' } },
      { codex: [] },
    ]) {
      const response = await post({ projectPaths: invalid });
      assert.equal(response.status, 400, JSON.stringify(invalid));
      assert.equal((await response.json()).error.code, 'invalid_settings');
      assert.deepEqual((await get()).runtime.projectPaths, changed);
      assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).projectPaths, changed);
    }
    await stop();
    origin = await start();
    assert.deepEqual((await get()).runtime.projectPaths, changed);
  });

test('invalid projectPaths fail startup with the owning config error', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-project-paths-invalid-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const config = path.join(dir, 'config.json');
  for (const [projectPaths, diagnostic] of [
    [{ codex: { opaque: 'relative/path' } }, /projectPaths.*absolute path/],
    [{ retired: { opaque: dir } }, /projectPaths.*unsupported provider retired/],
  ]) {
    const body = JSON.stringify({ projectPaths });
    await writeFile(config, body);
    const result = spawnSync(binary, ['serve', '--config', config],
      { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, diagnostic);
    assert.equal(await readFile(config, 'utf8'), body);
  }
});
