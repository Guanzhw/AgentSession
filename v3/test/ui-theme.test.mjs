import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const uiDir = path.join(repo, 'v3', 'ui');
const rootId = 'theme-root';
const childId = 'theme-child';
const themeKey = 'agentsession-v3-theme';
const browserName = process.platform === 'win32'
  ? 'agent-browser-win32-x64.exe' : `agent-browser-${process.platform}-${process.arch}`;
const browserExe = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
  (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', browserName))
    .find(existsSync);
const skip = !existsSync(path.join(uiDir, 'node_modules', 'vite'))
  ? 'Install the locked v3 UI dependencies.'
  : !browserExe || !existsSync(browserExe) ? 'agent-browser is required for browser QA.' : false;

const session = id => ({ provider: 'codex', sessionId: id });
const event = (id, messageId) => ({ provider: 'codex', sessionId: id, messageId, segment: 'message' });
const summary = id => ({ session: session(id), title: id, directory: '/theme-fixture',
  createdAt: 1, updatedAt: 1, messageCount: 1, tokenCount: null,
  parent: id === childId ? session(rootId) : null });
const bootstrap = id => {
  const item = { event: event(id, 'message-1'), ordinal: 0, owner: null, role: 'assistant',
    timestamp: Date.UTC(2026, 8, 28, 12, 34), preview: 'Theme fixture conversation.', totalChars: 27,
    toolName: null, ownerMessageId: null, replyMetadata: null };
  return { session: summary(id), revision: `revision-${id}`, totalItems: 1,
    segments: [{ id: 'segment-0', pageId: `page-${id}-0`, startOrdinal: 0,
      items: [item], ownerContext: null, previousCursor: null, nextCursor: null }],
    toc: { entries: [{ event: item.event, ordinal: 0, owner: null, label: item.preview }],
      previousCursor: null, nextCursor: null },
    relations: id === rootId ? { taskCount: 0, observationCount: 1, firstCursor: 'relations-0' }
      : { taskCount: 0, observationCount: 0, firstCursor: null } };
};

async function freePort() {
  return freeFetchSafePort();
}

async function harness(t) {
  const { build } = createRequire(path.join(uiDir, 'package.json'))('vite');
  const buildDir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-theme-ui-'));
  await build({ root: uiDir, configFile: path.join(uiDir, 'vite.config.ts'),
    build: { outDir: buildDir, emptyOutDir: true }, logLevel: 'error' });
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    const json = value => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === '/api/providers') return json([{ id: 'codex', available: true }]);
    if (url.pathname === '/api/v3/sessions') return json([summary(rootId)]);
    if (url.pathname === '/api/v3/library/sessions') {
      const session = summary(rootId);
      return json({ families: [{ session, matched: true, matchingCount: 1, childCount: 0,
        totalChildCount: 0, familyRootId: rootId, familyUpdated: session.updatedAt,
        parentBoundary: null }], total: 1, matchingSessions: 1,
        sourceDiagnostics: [], nextCursor: null });
    }
    if (url.pathname === '/api/settings') return json({ configFile: { path: '/theme/config.json', loaded: false },
      startup: { port: 3456, sources: {}, state: {} }, runtimeEditable: [],
      runtime: { projectPaths: {}, resumeCommands: {}, resumeShell: null } });
    const readerRoute = url.pathname.match(/^\/api\/v3\/reader\/codex\/(theme-root|theme-child)\/(bootstrap|relations)$/);
    if (readerRoute) {
      const [, id, kind] = readerRoute;
      if (kind === 'bootstrap') return json(bootstrap(id));
      return json({ session: session(id), revision: `revision-${id}`, entries: [],
        childPlacements: id === rootId ? [{ child: session(childId), afterEvent: event(rootId, 'message-1'),
          sourceEventId: 'event:theme:child', diagnostic: null }] : [], nextCursor: null });
    }
    const runtimeRoute = url.pathname.match(/^\/api\/v3\/runtime\/codex\/(theme-root|theme-child)\/events$/);
    if (runtimeRoute) {
      const [, id] = runtimeRoute;
      return json({ session: session(id), revision: `revision-${id}`, coverage: 'partial',
        events: [], nextCursor: null, scannedEvents: 0 });
    }
    if (url.pathname.startsWith('/api/v3/resume/codex/')) {
      return json({ allowTerminalLaunch: false, available: false, diagnostic: null, command: null });
    }
    if (url.pathname.startsWith('/api/v3/meta/codex/')) return json(null);
    if (url.pathname.startsWith('/api/')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'not_found' } }));
      return;
    }
    const asset = url.pathname.startsWith('/assets/')
      ? path.resolve(buildDir, `.${url.pathname}`) : path.join(buildDir, 'index.html');
    if (!asset.startsWith(buildDir + path.sep) && asset !== path.join(buildDir, 'index.html')) {
      response.writeHead(400).end();
      return;
    }
    if (!existsSync(asset)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': asset.endsWith('.html') ? 'text/html; charset=utf-8'
      : asset.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : asset.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream' });
    response.end(readFileSync(asset));
  });
  const port = await freePort();
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(buildDir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${port}`;
}

async function browser(t, url) {
  const name = `agentsession-v3-theme-${process.pid}-${Date.now()}`;
  const command = (...args) => new Promise((resolve, reject) => {
    const child = spawn(browserExe, ['--session', name, ...args],
      { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`agent-browser ${args[0]} timed out`)); }, 15_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout));
    });
  });
  t.after(async () => { try { await command('close'); } catch { /* The browser is already closed. */ } });
  await command('open', url);
  return command;
}

async function waitFor(command, expression) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if ((await command('eval', `Boolean(${expression})`)).includes('true')) return;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function evaluate(command, expression) {
  return JSON.parse(await command('eval', expression));
}

async function contrastRatio(command, foregroundSelector, backgroundSelector) {
  return evaluate(command, `(() => {
    const luminance = value => {
      const channels = value.match(/[\\d.]+/g).slice(0, 3).map(Number).map(channel => {
        const normalized = channel / 255;
        return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
      });
      return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    };
    const foreground = getComputedStyle(document.querySelector(${JSON.stringify(foregroundSelector)})).color;
    const background = getComputedStyle(document.querySelector(${JSON.stringify(backgroundSelector)})).backgroundColor;
    const [lighter, darker] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
    return (lighter + .05) / (darker + .05);
  })()`);
}

test('theme preference follows system, persists explicit choice, and reaches every Reader surface',
  { skip, timeout: 90_000 }, async t => {
    const origin = await harness(t);
    const command = await browser(t, `${origin}/sessions`);
    await waitFor(command, `document.querySelector('.library-heading h1')`);
    assert.equal(Number(await command('get', 'count', '.theme-select')), 1,
      'The shared shell exposes the theme preference on the Library');

    await command('set', 'media', 'dark');
    await waitFor(command, `window.matchMedia('(prefers-color-scheme: dark)').matches`);
    const system = await evaluate(command, `(() => ({
      value: document.querySelector('.theme-select').value,
      theme: document.documentElement.dataset.theme,
      stored: localStorage.getItem('${themeKey}'),
      canvas: getComputedStyle(document.body).backgroundColor,
    }))()`);
    assert.deepEqual(system, { value: 'system', theme: 'system', stored: null,
      canvas: 'rgb(20, 26, 22)' }, 'System mode follows the dark OS preference without storing a default');
    await command('set', 'media', 'light');
    await waitFor(command, `!window.matchMedia('(prefers-color-scheme: dark)').matches`);
    assert.equal(await evaluate(command, 'document.documentElement.dataset.theme'), 'system');
    assert.equal(await evaluate(command, 'getComputedStyle(document.body).backgroundColor'), 'rgb(238, 241, 237)',
      'System mode follows an OS preference change without reloading');
    await command('set', 'media', 'dark');
    await waitFor(command, `window.matchMedia('(prefers-color-scheme: dark)').matches`);

    await command('select', '.theme-select', 'dark');
    await waitFor(command, `document.documentElement.dataset.theme === 'dark'`);
    assert.equal(await evaluate(command, `localStorage.getItem('${themeKey}')`), 'dark');
    await command('select', '.theme-select', 'system');
    await waitFor(command, `document.documentElement.dataset.theme === 'system'`);
    assert.equal(await evaluate(command, `localStorage.getItem('${themeKey}')`), 'system',
      'An explicitly selected System preference is persisted');
    await command('eval', 'location.reload()');
    await waitFor(command, `document.querySelector('.library-heading h1')`);
    assert.equal(await command('get', 'value', '.theme-select'), 'system',
      'Reload restores an explicit System preference');
    assert.equal(await evaluate(command, 'getComputedStyle(document.body).backgroundColor'), 'rgb(20, 26, 22)');

    await command('select', '.theme-select', 'light');
    await waitFor(command, `document.documentElement.dataset.theme === 'light'`);
    assert.equal(await evaluate(command, `localStorage.getItem('${themeKey}')`), 'light');
    assert.equal(await evaluate(command, 'getComputedStyle(document.body).backgroundColor'), 'rgb(238, 241, 237)');
    assert.ok(await contrastRatio(command, '.library-heading h1', 'body') >= 4.5,
      'Library heading meets normal-text contrast in Light mode');
    await command('eval', 'location.reload()');
    await waitFor(command, `document.querySelector('.library-heading h1')`);
    assert.equal(await command('get', 'value', '.theme-select'), 'light', 'Reload restores the explicit choice');

    await command('select', '.theme-select', 'dark');
    await waitFor(command, `document.documentElement.dataset.theme === 'dark'`);
    await command('focus', '.brand');
    await command('press', 'Tab');
    assert.equal(await evaluate(command, `document.activeElement?.getAttribute('href')`), '/stats',
      'Tab reaches the statistics navigation');
    await command('press', 'Tab');
    assert.equal(await evaluate(command, `document.activeElement?.getAttribute('href')`), '/settings',
      'Tab reaches the settings navigation');
    await command('press', 'Tab');
    const focus = await evaluate(command, `(() => ({
      themeFocused: document.activeElement === document.querySelector('.theme-select'),
      outline: getComputedStyle(document.activeElement).outlineStyle,
    }))()`);
    assert.equal(focus.themeFocused, true, 'Tab reaches the shared theme control');
    assert.notEqual(focus.outline, 'none', 'Keyboard focus remains visible');

    await command('click', '.session-row');
    await waitFor(command, `document.querySelector('.pane-search[data-scope="session"]')`);
    assert.equal(await command('get', 'value', '.theme-select'), 'dark', 'The Reader keeps the shell preference');
    assert.equal(await evaluate(command, 'getComputedStyle(document.querySelector(".event-card")).backgroundColor'),
      'rgba(0, 0, 0, 0)', 'Reader cards share the canvas surface');
    assert.equal(await evaluate(command, 'getComputedStyle(document.body).backgroundColor'),
      'rgb(20, 26, 22)', 'The Reader canvas uses the dark palette');
    assert.ok(await contrastRatio(command, '.event-body', 'body') >= 4.5,
      'Reader text meets normal-text contrast in Dark mode');

    await command('click', '.runtime-tab');
    await waitFor(command, `document.querySelector('.runtime-state')`);
    assert.equal(await evaluate(command, 'getComputedStyle(document.querySelector(".runtime-state")).backgroundColor'),
      'rgb(29, 37, 32)', 'Runtime surfaces use the dark palette');
    await command('click', '.conversation-tab');
    await waitFor(command, `document.querySelector('.inline-child-toggle')`);
    await command('focus', '.inline-child-toggle');
    await command('press', 'Enter');
    await waitFor(command, `document.querySelector('.inline-child-reader')`);
    assert.equal(await evaluate(command, 'getComputedStyle(document.querySelector(".inline-child-reader")).backgroundColor'),
      'rgb(32, 42, 35)', 'Inline child panes use the dark palette');

    await command('click', 'a[href="/settings"]');
    await waitFor(command, `document.querySelector('.settings-panel')`);
    assert.equal(await command('get', 'value', '.theme-select'), 'dark', 'Settings keeps the shell preference');
    assert.equal(await evaluate(command, 'getComputedStyle(document.querySelector(".settings-panel")).backgroundColor'),
      'rgb(29, 37, 32)', 'Settings surfaces use the dark palette');
    await command('set', 'media', 'light', 'reduced-motion');
    await waitFor(command, `window.matchMedia('(prefers-reduced-motion: reduce)').matches`);
    assert.equal(await evaluate(command, 'getComputedStyle(document.documentElement).scrollBehavior'), 'auto',
      'Reduced motion disables smooth scrolling');
    assert.equal(await evaluate(command, `localStorage.getItem('${themeKey}')`), 'dark');
    assert.equal(await command('errors'), '');
  });

test('Library and Reader landmarks and text pass bilingual light and dark accessibility audits',
  { skip, timeout: 90_000 }, async t => {
    const origin = await harness(t);
    const command = await browser(t, `${origin}/sessions`);
    await waitFor(command, `document.querySelector('.session-row')`);
    for (const [surface, selector] of [['Library', '.session-row'], ['Reader', '.event-card time']]) {
      await waitFor(command, `document.querySelector('${selector}')`);
      for (const [language, htmlLanguage] of [['en', 'en'], ['zh', 'zh-CN']]) {
        await command('select', '.language-select', language);
        await waitFor(command, `document.documentElement.lang === '${htmlLanguage}'`);
        for (const theme of ['light', 'dark']) {
          await command('select', '.theme-select', theme);
          await waitFor(command, `document.documentElement.dataset.theme === '${theme}'`);
          const audit = JSON.parse(await command('a11y', '--json'));
          assert.deepEqual(audit.data.violations.map(({ id, nodes }) => ({
            id, targets: nodes.map(({ target }) => target.join(',')),
          })), [], `${htmlLanguage} ${theme} ${surface} has no automated accessibility violations`);
        }
      }
      if (surface === 'Library') await command('click', '.session-row');
    }
  });
