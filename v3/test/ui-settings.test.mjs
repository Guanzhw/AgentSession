import { onCleanup, temporaryDirectory } from '../../test/helpers/fixture-cleanup.mjs';
import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  const dir = await temporaryDirectory(t, path.join(os.tmpdir(), 'v3-ui-settings-'));
  const session = `v3-settings-${process.pid}`;
  const secondSession = `${session}-second`;
  await mkdir(path.join(dir, 'pi/sessions/project'), { recursive: true });
  const source = path.join(dir, 'pi/sessions/project/session.jsonl');
  const body = [
    { type: 'session', version: 3, id: 'settings-ui', cwd: dir, timestamp: '2026-09-27T00:00:00.000Z' },
    { type: 'message', id: 'user', parentId: null, message: { role: 'user', content: 'Settings browser verification' } },
  ].map(JSON.stringify).join('\n') + '\n';
  await writeFile(source, body);
  const config = path.join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ resumeCommands: { pi: false }, dbPath: path.join(dir, 'configured-opencode.db') }));
  const port = await freeFetchSafePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(binary, ['serve', '--port', String(port), '--config', config,
    '--pi-dir', path.join(dir, 'pi'), '--codex-dir', path.join(dir, 'codex'),
    '--claude-dir', path.join(dir, 'claude'), '--dsh-dir', path.join(dir, 'dsh'),
    '--opencode-db', path.join(dir, 'opencode.db'), '--meta-dir', path.join(dir, 'meta'),
    '--index-dir', path.join(dir, 'index'), '--cache-dir', path.join(dir, 'cache')],
  { windowsHide: true, stdio: 'ignore' });
  onCleanup(t, async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'close');
      child.kill();
      await done;
    }
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/settings')).ok) break; } catch {}
    if (i === 99) throw new Error('Web server unavailable');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  onCleanup(t, () => command(session, 'close').catch(() => {}));
  onCleanup(t, () => command(secondSession, 'close').catch(() => {}));
  await command(session, 'open', base + '/settings#source-opencode');
  await command(session, 'set', 'viewport', '1440', '1000');
  await command(session, 'snapshot', '-i');
  await waitForText(session, 'Current source path');
  assert.equal(JSON.parse(await command(session, 'eval', `document.activeElement.id`)), 'source-opencode',
    'the native Settings deep link focuses its specific source after async loading');
  assert.equal(await command(session, 'eval', `document.querySelector('#source-heading-opencode').getBoundingClientRect().top >= document.querySelector('.topbar').getBoundingClientRect().bottom`), 'true',
    'the native source destination heading remains visible below the fixed app header');
  assert.equal(await command(session, 'eval', `document.querySelector('#source-opencode').getBoundingClientRect().top - 5 >= document.querySelector('.topbar').getBoundingClientRect().bottom`), 'true',
    'the native source destination reveals its complete focus outline');
  assert.equal(await command(session, 'get', 'text', '[data-source-path="opencode"]'), path.join(dir, 'opencode.db'),
    'source guidance shows the effective startup CLI path rather than the lower-priority config value');
  const sourceGuidance = await command(session, 'get', 'text', '#source-opencode');
  assert.match(sourceGuidance, /dbPath/);
  assert.match(sourceGuidance, /--opencode-db/);
  assert.match(sourceGuidance, /AGENTSESSION_DB_PATH/);
  assert.match(sourceGuidance, /Restart the Viewer/);
  assert.equal(await command(session, 'get', 'text', '[data-source-path="pi"]'), path.join(dir, 'pi'));
  const journeyScreenshots = process.env.AGENTSESSION_V3_JOURNEY_SCREENSHOT_DIR;
  if (journeyScreenshots) {
    await mkdir(journeyScreenshots, { recursive: true });
    await command(session, 'screenshot', path.join(journeyScreenshots, 'native-source-settings-focus-en.png'));
    await command(session, 'eval', `(() => { const select = document.querySelector('.language-select'); select.value = 'zh'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitForText(session, '重启 Viewer');
    await command(session, 'eval', `document.querySelector('#source-opencode').focus()`);
    await command(session, 'screenshot', path.join(journeyScreenshots, 'native-source-settings-focus-zh.png'));
    await command(session, 'eval', `(() => { const select = document.querySelector('.language-select'); select.value = 'en'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitForText(session, 'Restart the Viewer');
  }
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
  const preview = await (await fetch(base + '/api/v3/resume/pi/settings-ui')).json();
  assert.equal(preview.command.executable, process.execPath);
  assert.deepEqual(preview.command.args, ['settings-ui']);
  assert.equal(preview.command.cwd, dir);
  assert.equal(preview.allowTerminalLaunch, true);
  assert.equal(preview.available, process.platform === 'win32');
  assert.equal(preview.diagnostic, process.platform === 'win32' ? null
    : 'Terminal launching is currently supported on Windows only');
  await command(session, 'open', base + '/pi/session/settings-ui');
  if (preview.available) {
    await waitForText(session, 'Resume in terminal');
  } else {
    await command(session, 'click', '.reader-session-details > summary');
    await waitForText(session, preview.diagnostic);
  }
  const state = JSON.parse(await command(session, 'eval', `(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Resume in terminal'));
    return { present: Boolean(button), enabled: button?.disabled === false };
  })()`));
  assert.deepEqual(state, { present: preview.available, enabled: preview.available },
    'Reader resume action must reflect the saved command and the host platform capability');
  await command(session, 'open', base + '/settings');
  await command(session, 'snapshot', '-i');
  await command(session, 'fill', '#resume-commands', '{');
  await command(session, 'click', 'button[type=submit]');
  await waitForText(session, 'Invalid JSON');
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).resumeCommands, commands);
  assert.equal(await readFile(source, 'utf8'), body);
  assert.equal(await command(session, 'errors'), '');
});
