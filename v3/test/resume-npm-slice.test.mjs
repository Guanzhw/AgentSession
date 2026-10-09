import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '../..');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug/agentsession-v3.exe');
const windows = { skip: process.platform !== 'win32', timeout: 60_000 };
const layouts = [
  ['claude-code', 'claude', '@anthropic-ai/claude-code', 'bin/claude.exe'],
  ['opencode', 'opencode', '@opencode/cli', './bin/opencode.exe'],
  ['pi', 'pi', '@earendil-works/pi-coding-agent', 'dist/cli.js'],
];
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(repo, 'tmp/v3-resume-npm-'));
  const prefix = path.join(root, 'npm prefix');
  const cwd = path.join(root, 'project space Ω');
  const marker = path.join(root, 'launched.json');
  const sentinel = path.join(root, 'shim-ran.txt');
  const id = options.id || 'npm-resume-source';
  let child;
  t.after(async () => {
    if (child?.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill(); await closed;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  });
  for (const name of ['codex', 'claude/projects/project', 'pi/sessions/project', 'dsh'])
    await mkdir(path.join(root, name), { recursive: true });
  await mkdir(prefix); await mkdir(cwd);
  const piSource = path.join(root, 'pi/sessions/project/current.jsonl');
  await writeFile(piSource, JSON.stringify({ type: 'session', version: 3, id, cwd,
    timestamp: '2026-09-27T00:00:00.000Z' }) + '\n');
  const claudeSource = path.join(root, 'claude/projects/project', `${id}.jsonl`);
  await writeFile(claudeSource, JSON.stringify({ type: 'user', uuid: 'user', cwd,
    timestamp: '2026-09-27T00:00:00.000Z', message: { content: 'Resume evidence' } }) + '\n');
  const opencodeSource = path.join(root, 'opencode.db');
  const db = new DatabaseSync(opencodeSource);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT,
    directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER);`);
  db.prepare('INSERT INTO session VALUES (?,NULL,?,?,1,2,NULL)').run(id, 'Resume', cwd);
  db.close();
  const sources = [piSource, claudeSource, opencodeSource];
  const before = await Promise.all(sources.map(hash));
  const packages = {};
  for (const [provider, command, name, bin] of layouts) {
    const directory = path.join(prefix, 'node_modules', name);
    const entry = path.join(directory, bin);
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, bin: { [command]: bin } }));
    await writeFile(path.join(prefix, `${command}.cmd`), `@echo SHIM_RAN > "${sentinel}"\r\n`);
    if (bin.endsWith('.exe')) await copyFile(process.execPath, entry);
    else await writeFile(entry, `require('fs').writeFileSync(process.env.AGENTSESSION_RESUME_TEST_MARKER,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),pid:process.pid}));`);
    packages[provider] = { directory, entry, command, name, bin };
  }
  if (!options.noNode) await copyFile(process.execPath, path.join(prefix, 'node.exe'));
  const where = path.join(process.env.SystemRoot, 'System32/where.exe');
  const pwsh = spawnSync(where, ['pwsh.exe'], { encoding: 'utf8', windowsHide: true }).stdout.trim().split(/\r?\n/)[0];
  assert.ok(pwsh, 'PowerShell 7 is required for the Windows launch fixture');
  const config = { resumeShell: { executable: pwsh, args: ['-NoLogo', '-NoProfile'] } };
  const f = { root, prefix, cwd, marker, sentinel, id, packages, config,
    assertSources: async () => assert.deepEqual(await Promise.all(sources.map(hash)), before) };
  await options.prepare?.(f);
  const configPath = path.join(root, 'config.json'); await writeFile(configPath, JSON.stringify(config));
  const port = await freeFetchSafePort();
  const args = ['serve', '--config', configPath, '--port', String(port)];
  for (const [flag, relative] of [['codex-dir', 'codex'], ['claude-dir', 'claude'],
    ['pi-dir', 'pi'], ['dsh-dir', 'dsh'], ['opencode-db', 'opencode.db'],
    ['meta-dir', 'meta'], ['index-dir', 'index'], ['cache-dir', 'cache']]) args.push(`--${flag}`, path.join(root, relative));
  const env = { ...process.env, AGENTSESSION_RESUME_TEST_MARKER: marker };
  if (!options.installed) {
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    env.PATH = [prefix, path.join(process.env.SystemRoot, 'System32'), path.dirname(pwsh)].join(path.delimiter);
  }
  child = spawn(binary, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  f.base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error(stderr);
    try { if ((await fetch(f.base + '/api/providers')).ok) return f; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(stderr || 'server did not start');
}
const url = (f, provider) => `${f.base}/api/v3/resume/${provider}/${encodeURIComponent(f.id)}`;
const info = async (f, provider) => {
  const response = await fetch(url(f, provider)); assert.equal(response.status, 200);
  return response.json();
};
const launch = (f, provider) => fetch(url(f, provider), { method: 'POST',
  headers: { origin: f.base, 'content-type': 'application/json' }, body: '{}' });

test('provider defaults resolve the three observed npm package layouts without running shims', windows, async t => {
  const f = await fixture(t);
  for (const [provider] of layouts) {
    const result = await info(f, provider);
    assert.equal(result.available, true, result.diagnostic);
    const pkg = f.packages[provider];
    assert.equal(path.normalize(result.command.resolvedExecutable), provider === 'pi' ? path.join(f.prefix, 'node.exe') : pkg.entry);
    const args = result.command.args;
    if (provider === 'pi') args[0] = path.normalize(args[0]);
    assert.deepEqual(args, provider === 'pi' ? [pkg.entry, '--session', f.id]
      : [provider === 'claude-code' ? '--resume' : '--session', f.id]);
  }
  await assert.rejects(access(f.sentinel)); await f.assertSources();
});

test('npm Node entry launches an actual descendant with literal source ID and cwd', windows, async t => {
  // Pi's header owns this canonical ID; its filename is independent of that ID.
  const hostile = 'npm quote" & echo INJECTION_PROBE & rem " %USERNAME% ; Ω';
  const f = await fixture(t);
  const source = path.join(f.root, 'pi/sessions/project/current.jsonl');
  const header = JSON.parse(await readFile(source, 'utf8'));
  header.id = hostile;
  await writeFile(source, JSON.stringify(header) + '\n');
  f.id = hostile;
  const sourceHash = await hash(source);
  const response = await launch(f, 'pi'); assert.equal(response.status, 200, await response.text());
  let result;
  for (let i = 0; i < 50; i++) {
    try { result = JSON.parse(await readFile(f.marker, 'utf8')); break; } catch { /* descendant */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(result, 'actual descendant writes evidence');
  assert.deepEqual(result.args, ['--session', hostile]); assert.equal(result.cwd, f.cwd);
  assert.ok(result.pid > 0); assert.equal(await hash(source), sourceHash);
  await assert.rejects(access(f.sentinel));
});

test('npm resolver rejects invalid manifests and package-escaping entries', windows, async t => {
  const f = await fixture(t);
  const pkg = f.packages.pi;
  const manifest = path.join(pkg.directory, 'package.json');
  const outside = path.join(f.root, 'outside'); await mkdir(outside);
  await writeFile(path.join(outside, 'cli.js'), 'throw Error("must not execute")');
  await symlink(outside, path.join(pkg.directory, 'linked'), 'junction');
  await writeFile(path.join(pkg.directory, 'dist/cli.cmd'), `@echo SHIM_RAN > "${f.sentinel}"\r\n`);
  for (const [body, expected] of [
    ['{broken', /manifest|JSON/i],
    [JSON.stringify({ name: 'wrong-package', bin: { pi: pkg.bin } }), /package.*name|name.*package/i],
    [JSON.stringify({ name: pkg.name, bin: { other: pkg.bin } }), /bin/i],
    [JSON.stringify({ name: pkg.name, bin: { pi: '../outside.js' } }), /outside|relative|escape/i],
    [JSON.stringify({ name: pkg.name, bin: { pi: process.execPath } }), /outside|relative|absolute/i],
    [JSON.stringify({ name: pkg.name, bin: { pi: 'linked/cli.js' } }), /outside|escape/i],
    [JSON.stringify({ name: pkg.name, bin: { pi: 'dist/missing.js' } }), /missing|not found|entry/i],
    [JSON.stringify({ name: pkg.name, bin: { pi: 'dist/cli.cmd' } }), /unsupported|entry/i],
  ]) {
    await writeFile(manifest, body);
    const result = await info(f, 'pi'); assert.equal(result.available, false); assert.match(result.diagnostic, expected);
    assert.equal((await launch(f, 'pi')).status, 409);
  }
  await assert.rejects(access(f.marker)); await assert.rejects(access(f.sentinel)); await f.assertSources();
});

test('npm JavaScript entry requires a direct Node executable', windows, async t => {
  const f = await fixture(t, { noNode: true });
  const result = await info(f, 'pi'); assert.equal(result.available, false); assert.match(result.diagnostic, /node/i);
  assert.equal((await launch(f, 'pi')).status, 409);
  await assert.rejects(access(f.marker)); await f.assertSources();
});

test('explicit commands and disable take precedence without rewriting configured npm shims', windows, async t => {
  const f = await fixture(t, { prepare: async f => {
    for (const pkg of Object.values(f.packages))
      await writeFile(path.join(pkg.directory, 'package.json'), '{invalid-unused-manifest');
    f.config.resumeCommands = {
      pi: { executable: path.join(f.prefix, 'pi.cmd'), args: ['--session', '{sessionId}'], cwd: f.cwd },
      'claude-code': false,
      opencode: { executable: process.execPath, args: ['--version'], cwd: f.cwd },
    };
  } });
  const pi = await info(f, 'pi'); assert.equal(pi.available, false); assert.match(pi.diagnostic, /batch|script|\.cmd/i);
  assert.equal((await launch(f, 'pi')).status, 409);
  const claude = await info(f, 'claude-code'); assert.equal(claude.available, false); assert.match(claude.diagnostic, /disabled/i);
  const opencode = await info(f, 'opencode'); assert.equal(opencode.available, true, opencode.diagnostic);
  assert.equal(opencode.command.resolvedExecutable, process.execPath); assert.deepEqual(opencode.command.args, ['--version']);
  await assert.rejects(access(f.sentinel)); await f.assertSources();
});

test('installed npm defaults resolve to each installed package manifest entry without launching', {
  ...windows, skip: process.platform !== 'win32' || !process.env.AGENTSESSION_V3_VERIFY_INSTALLED_RESUME,
}, async t => {
  const f = await fixture(t, { installed: true });
  const where = path.join(process.env.SystemRoot, 'System32/where.exe');
  for (const [provider, command, name] of layouts) {
    const shim = spawnSync(where, [`${command}.cmd`], { encoding: 'utf8', windowsHide: true }).stdout.trim().split(/\r?\n/)[0];
    assert.ok(shim, `installed ${command}.cmd is required`);
    const directory = path.join(path.dirname(shim), 'node_modules', name);
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    assert.equal(manifest.name, name);
    const result = await info(f, provider);
    assert.equal(result.available, true, result.diagnostic);
    const entry = path.join(directory, manifest.bin[command]);
    assert.equal(path.normalize(provider === 'pi' ? result.command.args[0] : result.command.resolvedExecutable), entry);
    assert.equal(path.extname(result.command.resolvedExecutable).toLowerCase(), '.exe');
    console.log(`${name}@${manifest.version}: ${result.command.resolvedExecutable}${provider === 'pi' ? ` + ${entry}` : ''}`);
  }
  await assert.rejects(access(f.marker)); await assert.rejects(access(f.sentinel)); await f.assertSources();
});
