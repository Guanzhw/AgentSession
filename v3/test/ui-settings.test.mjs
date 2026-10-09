import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '../..');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug', process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const browser = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN || (process.env.PATH || '').split(path.delimiter)
  .map(dir => path.join(dir, 'node_modules/agent-browser/bin', process.platform === 'win32' ? 'agent-browser-win32-x64.exe' : `agent-browser-${process.platform}-${process.arch}`))
  .find(existsSync);
async function command(session, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(browser, ['--session', session, ...args], { cwd: repo, windowsHide: true });
    let output = ''; let error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Browser command ${session} ${args.join(' ')} timed out`)); }, 15_000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy();
      if (code) reject(new Error(error || output)); else resolve(output.trim());
    });
  });
}
async function waitForText(session, text) {
  let body = '';
  for (let i = 0; i < 30; i++) {
    body = await command(session, 'get', 'text', 'body');
    if (body.includes(text)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`Expected ${text}; page: ${body}`);
}
test('real Settings saves resume overrides and Reader reflects the saved capability', {
  skip: !browser ? 'agent-browser is required' : false, timeout: 90_000,
}, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'v3-ui-settings-'));
  const session = `v3-settings-${process.pid}`;
  const secondSession = `${session}-second`;
  let child;
  t.after(async () => {
    await command(session, 'close').catch(() => {});
    await command(secondSession, 'close').catch(() => {});
    if (child?.exitCode === null && child.signalCode === null) { const done = once(child, 'close'); child.kill(); await done; }
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(path.join(dir, 'pi/sessions/project'), { recursive: true });
  const source = path.join(dir, 'pi/sessions/project/session.jsonl');
  const body = [
    { type: 'session', version: 3, id: 'settings-ui', cwd: dir, timestamp: '2026-09-27T00:00:00.000Z' },
    { type: 'message', id: 'user', parentId: null, message: { role: 'user', content: 'Settings browser verification' } },
  ].map(JSON.stringify).join('\n') + '\n';
  await writeFile(source, body);
  const config = path.join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ resumeCommands: { pi: false } }));
  const port = await freeFetchSafePort();
  const base = `http://127.0.0.1:${port}`;
  child = spawn(binary, ['serve', '--port', String(port), '--config', config,
    '--pi-dir', path.join(dir, 'pi'), '--codex-dir', path.join(dir, 'codex'),
    '--claude-dir', path.join(dir, 'claude'), '--dsh-dir', path.join(dir, 'dsh'),
    '--opencode-db', path.join(dir, 'opencode.db'), '--meta-dir', path.join(dir, 'meta'),
    '--index-dir', path.join(dir, 'index'), '--cache-dir', path.join(dir, 'cache')],
  { windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/settings')).ok) break; } catch {}
    if (i === 99) throw new Error('Web server unavailable');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await command(session, 'open', base + '/settings');
  await command(session, 'snapshot', '-i');
  const controls = await command(session, 'eval', "Boolean(document.querySelector('#resume-commands'))");
  assert.ok(controls.includes('true'), 'Settings must expose the resume command editor');
  await command(secondSession, 'open', base + '/settings');
  await command(secondSession, 'snapshot', '-i');
  const commands = { pi: { executable: process.execPath, args: ['{sessionId}'], cwd: dir } };
  await command(session, 'fill', '#resume-commands', JSON.stringify(commands));
  await command(session, 'fill', '#resume-shell', 'null');
  await command(session, 'eval', "document.querySelector('form').requestSubmit()");
  await waitForText(session, 'Resume settings saved');
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).resumeCommands, commands);
  const shell = { executable: 'pwsh.exe', args: ['-NoLogo'] };
  await command(secondSession, 'fill', '#resume-shell', JSON.stringify(shell));
  await command(secondSession, 'press', 'Tab');
  await command(secondSession, 'press', 'Enter');
  await waitForText(secondSession, 'Resume settings saved');
  const afterBothTabs = await (await fetch(base + '/api/settings')).json();
  assert.deepEqual(afterBothTabs.runtime.resumeCommands, commands, 'A shell edit in a stale tab must preserve the other tab command change');
  assert.deepEqual(afterBothTabs.runtime.resumeShell, shell);
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).resumeCommands, commands);
  const projectPaths = { pi: { 'opaque-project-key': dir } };
  await command(session, 'fill', '#project-paths', JSON.stringify(projectPaths));
  await command(session, 'eval', "document.querySelector('#project-paths').closest('form').requestSubmit()");
  await waitForText(session, 'Project paths saved.');
  assert.deepEqual((await (await fetch(base + '/api/settings')).json()).runtime.projectPaths, projectPaths);
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).projectPaths, projectPaths);
  const screenshots = path.join(repo, 'tmp/v3-browser-qa');
  await mkdir(screenshots, { recursive: true });
  await command(session, 'set', 'viewport', '1440', '1000');
  await command(session, 'screenshot', path.join(screenshots, 'runtime-settings.png'), '--full');
  await command(session, 'open', base + '/pi/session/settings-ui');
  await waitForText(session, 'Resume in terminal');
  const preview = await (await fetch(base + '/api/v3/resume/pi/settings-ui')).json();
  assert.equal(preview.command.executable, process.execPath);
  const state = await command(session, 'eval', `JSON.stringify({ enabled: [...document.querySelectorAll('button')].find(b => b.textContent.includes('Resume in terminal'))?.disabled === false })`);
  if (preview.available) assert.ok(state.includes('true'));
  await command(session, 'open', base + '/settings');
  await command(session, 'snapshot', '-i');
  await command(session, 'fill', '#resume-commands', '{');
  await command(session, 'click', 'button[type=submit]');
  await waitForText(session, 'Invalid JSON');
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).resumeCommands, commands);
  assert.equal(await readFile(source, 'utf8'), body);
  assert.equal(await command(session, 'errors'), '');
});
