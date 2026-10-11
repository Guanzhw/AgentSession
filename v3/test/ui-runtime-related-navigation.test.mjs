import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const source = path.join(repo, 'v3', 'fixtures', 'codex-three-level', 'sessions', '2026', '09', '27');
const ids = {
  root: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  child: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
const piIds = {
  parent: '019f8900-0000-7000-8000-000000000000',
  child: '019f8a00-0000-7000-8000-000000000001',
};
const piFixture = path.join(repo, 'test', 'fixtures', 'pi-v3-current.jsonl');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const browserName = process.platform === 'win32' ? 'agent-browser-win32-x64.exe'
  : `agent-browser-${process.platform}-${process.arch}`;
const browser = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
  (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', browserName)).find(existsSync);
const skip = !existsSync(binary) || !browser ? 'Build v3 and install agent-browser' : false;
const fixtureFiles = Object.values(ids).map(id => path.join(source,
  `rollout-2026-09-27T${id === ids.root ? '00-00-00' : '00-01-00'}-${id}.jsonl`));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

async function freePort() {
  return freeFetchSafePort();
}

async function startApp(t, sessionIds, includePiFamily = false) {
  const originalHashes = fixtureFiles.map(hash);
  const originalPiHash = hash(piFixture);
  const work = await mkdtemp(path.join(os.tmpdir(), 'v3-runtime-navigation-'));
  const codex = path.join(work, 'codex');
  const destination = path.join(codex, 'sessions', '2026', '09', '27');
  await mkdir(destination, { recursive: true });
  for (const id of sessionIds) await cp(fixtureFiles.find(file => file.endsWith(`${id}.jsonl`)),
    path.join(destination, path.basename(fixtureFiles.find(file => file.endsWith(`${id}.jsonl`)))));
  for (const name of ['meta', 'index', 'cache', 'claude', 'pi']) await mkdir(path.join(work, name));
  if (includePiFamily) {
    const piSessions = path.join(work, 'pi', 'sessions', 'project');
    await mkdir(piSessions, { recursive: true });
    await cp(piFixture, path.join(piSessions, `${piIds.child}.jsonl`));
    const parentRows = [
      { type: 'session', version: 3, id: piIds.parent, timestamp: '2026-08-28T00:00:00Z' },
      { type: 'message', id: 'parent-user', parentId: null, timestamp: '2026-08-28T00:00:01Z',
        message: { role: 'user', content: 'Parent Pi prompt' } },
      { type: 'message', id: 'parent-assistant', parentId: 'parent-user', timestamp: '2026-08-28T00:00:02Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Parent Pi reply' }] } },
    ];
    await writeFile(path.join(piSessions, `${piIds.parent}.jsonl`), parentRows.map(JSON.stringify).join('\n') + '\n');
  }
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const app = spawn(binary, ['serve', '--port', String(port), '--codex-dir', codex,
    '--opencode-db', path.join(work, 'opencode.db'), '--claude-dir', path.join(work, 'claude'),
    '--pi-dir', path.join(work, 'pi'), '--dsh-dir', path.join(work, 'missing-dsh'),
    '--meta-dir', path.join(work, 'meta'), '--index-dir', path.join(work, 'index'),
    '--cache-dir', path.join(work, 'cache')], { cwd: repo, windowsHide: true, stdio: 'ignore' });
  t.after(async () => {
    app.kill();
    if (app.exitCode === null) await once(app, 'close');
    assert.deepEqual(fixtureFiles.map(hash), originalHashes, 'Public provider sources remain unchanged');
    assert.equal(hash(piFixture), originalPiHash, 'Public Pi source remains unchanged');
    await rm(work, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/api/providers`, { signal: AbortSignal.timeout(500) })).ok) return origin; }
    catch { /* Axum is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Axum did not start');
}

async function command(name, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(browser, ['--session', name, ...args], { cwd: repo, windowsHide: true });
    let output = '';
    let error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`agent-browser ${args.join(' ')} timed out`)); }, 15_000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.once('error', cause => { clearTimeout(timer); reject(cause); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code) reject(new Error(`agent-browser ${args.join(' ')}: ${error || output}`));
      else resolve(output.trim());
    });
  });
}

async function waitFor(name, expression, description) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if ((await command(name, 'eval', `Boolean(${expression})`)).includes('true')) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function openBrowser(t, origin, provider, sessionId) {
  const name = `v3-related-${process.pid}-${Date.now()}`;
  t.after(async () => { try { await command(name, 'close'); } catch { /* Already closed. */ } });
  await command(name, 'open', `${origin}/${provider}/session/${sessionId}`);
  await waitFor(name, `document.querySelector('#reader-title')`, 'Reader');
  await command(name, 'click', '.runtime-tab');
  await command(name, 'click', '.runtime-lens-sessions');
  await waitFor(name, `document.querySelector('.runtime-graph-node')`, 'relationship graph');
  return name;
}

test('related Runtime session opens canonical Reader and Back restores Sessions lens and link focus',
  { skip, timeout: 90_000 }, async t => {
    const origin = await startApp(t, Object.values(ids));
    const graph = await (await fetch(`${origin}/api/v3/runtime/codex/${ids.child}/graph?maxNodes=100`)).json();
    assert.ok(graph.nodes.some(node => node.kind === 'session' && node.session.sessionId === ids.root),
      'The public child graph records the canonical parent session');
    const name = await openBrowser(t, origin, 'codex', ids.child);
    const selector = `.runtime-graph-node[data-session-id="${ids.root}"] a`;
    await waitFor(name, `document.querySelector(${JSON.stringify(selector)})`, 'parent session link');
    assert.equal(JSON.parse(await command(name, 'eval', `document.querySelector(${JSON.stringify(selector)}).getAttribute('href')`)),
      `/codex/session/${ids.root}`);
    await command(name, 'click', selector);
    await waitFor(name, `location.pathname === '/codex/session/${ids.root}' && document.querySelector('#reader-title')`,
      'parent Reader');
    await command(name, 'back');
    await waitFor(name, `location.pathname === '/codex/session/${ids.child}' &&
      document.querySelector('.runtime-lens-sessions[aria-current="page"]') &&
      document.activeElement?.closest('.runtime-graph-node')?.getAttribute('data-session-id') === '${ids.root}'`,
      'originating Runtime Sessions lens and related link focus');
    if (process.env.AGENTSESSION_V3_JOURNEY_SCREENSHOT_DIR) {
      await mkdir(process.env.AGENTSESSION_V3_JOURNEY_SCREENSHOT_DIR, { recursive: true });
      await command(name, 'screenshot', path.join(process.env.AGENTSESSION_V3_JOURNEY_SCREENSHOT_DIR,
        'runtime-sessions-related-back.png'));
    }
    await command(name, 'click', '.runtime-lenses button:first-child');
    await waitFor(name, `document.querySelector('.runtime-events a[href^="#event?"]')`,
      'source event link');
    await command(name, 'click', '.runtime-events a[href^="#event?"]');
    await waitFor(name, `location.hash.startsWith('#event?') &&
      document.querySelector('.conversation-tab[aria-current="page"]')`, 'source conversation');
    await command(name, 'back');
    await waitFor(name, `location.pathname === '/codex/session/${ids.child}' &&
      document.querySelector('.runtime-lenses button:first-child[aria-current="page"]') &&
      document.querySelector('.runtime-events a[href^="#event?"]')`,
      'the Events lens that opened the source after event Back');
    await command(name, 'forward');
    await waitFor(name, `location.hash.startsWith('#event?') &&
      document.querySelector('.conversation-tab[aria-current="page"]') &&
      document.querySelector('.reader-actions')`, 'source conversation after event Forward');
    assert.equal((await command(name, 'errors')).trim(), '');
  });

test('unverified missing related session stays navigable and Reader reports the missing target',
  { skip, timeout: 90_000 }, async t => {
    const origin = await startApp(t, [ids.child]);
    const graph = await (await fetch(`${origin}/api/v3/runtime/codex/${ids.child}/graph?maxNodes=100`)).json();
    assert.ok(graph.nodes.some(node => node.kind === 'session' && node.session.sessionId === ids.root &&
      node.resolution === 'unverified'), 'The copied child records an unverified canonical parent reference');
    const name = await openBrowser(t, origin, 'codex', ids.child);
    const selector = `.runtime-graph-node[data-session-id="${ids.root}"]`;
    await waitFor(name, `document.querySelector(${JSON.stringify(selector)})`, 'unverified parent node');
    assert.match(await command(name, 'get', 'text', selector), /Related session is unverified/);
    assert.equal(JSON.parse(await command(name, 'eval', `document.querySelector(${JSON.stringify(selector + ' a')})?.getAttribute('href')`)),
      `/codex/session/${ids.root}`);
    await command(name, 'click', `${selector} a`);
    await waitFor(name, `location.pathname === '/codex/session/${ids.root}' && document.querySelector('.error-state[role="alert"]')`,
      'missing Reader diagnostic');
    assert.equal(await command(name, 'get', 'text', '.error-state h1'), 'Session not found');
    assert.equal(await command(name, 'eval', `document.querySelector('.error-state details').open`), 'false');
    assert.doesNotMatch(await command(name, 'get', 'text', '.error-state'), /Check the local service/);
    assert.equal(await command(name, 'eval', `document.querySelector('.error-state a').getAttribute('href')`), '"/sessions"');
    await command(name, 'select', '.language-select', 'zh');
    await waitFor(name, `document.querySelector('.error-state h1')?.textContent === '未找到会话'`, 'Chinese missing-session guidance');
    assert.match(await command(name, 'get', 'text', '.error-state'), /当前来源中没有此会话/);
    assert.doesNotMatch(await command(name, 'get', 'text', '.error-state'), /请检查本地服务/);
    if (process.env.AGENTSESSION_V3_JOURNEY_SCREENSHOT_DIR) {
      await mkdir(process.env.AGENTSESSION_V3_JOURNEY_SCREENSHOT_DIR, { recursive: true });
      await command(name, 'screenshot', path.join(process.env.AGENTSESSION_V3_JOURNEY_SCREENSHOT_DIR,
        'runtime-missing-parent-zh.png'));
    }
    await command(name, 'back');
    await waitFor(name, `location.pathname === '/codex/session/${ids.child}' &&
      document.querySelector('.runtime-lens-sessions[aria-current="page"]')`, 'originating Sessions lens');
    await command(name, 'forward');
    await waitFor(name, `document.querySelector('.error-state h1')?.textContent === '未找到会话'`, 'missing-session Forward');
    await command(name, 'click', '.error-state a[href="/sessions"]');
    await waitFor(name, `location.pathname === '/sessions' &&
      document.querySelector('.unlinked-child-row[href="/codex/session/${ids.child}"]')`, 'return to the available child session');
  });

test('Pi header parent link opens the parent Reader and Back restores Sessions focus',
  { skip, timeout: 90_000 }, async t => {
    const origin = await startApp(t, [], true);
    const graph = await (await fetch(`${origin}/api/v3/runtime/pi/${piIds.child}/graph?maxNodes=100`)).json();
    assert.ok(graph.edges.some(edge => edge.type === 'parent' && edge.inferred));
    const name = await openBrowser(t, origin, 'pi', piIds.child);
    const selector = `.runtime-graph-node[data-session-id="${piIds.parent}"] a`;
    await waitFor(name, `document.querySelector(${JSON.stringify(selector)})`, 'Pi parent link');
    await command(name, 'click', selector);
    await waitFor(name, `location.pathname === '/pi/session/${piIds.parent}' &&
      document.querySelector('#reader-title')`, 'Pi parent Reader');
    await command(name, 'back');
    await waitFor(name, `location.pathname === '/pi/session/${piIds.child}' &&
      document.querySelector('.runtime-lens-sessions[aria-current="page"]') &&
      document.activeElement?.closest('.runtime-graph-node')?.getAttribute('data-session-id') === '${piIds.parent}'`,
    'Pi child Sessions lens and parent link focus');
    assert.equal((await command(name, 'errors')).trim(), '');
  });
