import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const uiDir = path.join(repo, 'v3', 'ui');
const localeTimestamp = Date.parse('2026-09-28T12:34:00.000Z');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const browserName = process.platform === 'win32'
  ? 'agent-browser-win32-x64.exe' : `agent-browser-${process.platform}-${process.arch}`;
const browserExe = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
  (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', browserName))
    .find(existsSync);
const skip = !existsSync(path.join(uiDir, 'node_modules', 'vite'))
  ? 'Install the locked v3 UI dependencies.'
  : !browserExe || !existsSync(browserExe) ? 'agent-browser is required for browser QA.' : false;

async function freePort() {
  return freeFetchSafePort();
}

async function harness(t) {
  const { build } = createRequire(path.join(uiDir, 'package.json'))('vite');
  const buildDir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-locale-ui-'));
  await build({ root: uiDir, configFile: path.join(uiDir, 'vite.config.ts'),
    build: { outDir: buildDir, emptyOutDir: true }, logLevel: 'error' });
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    const json = value => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    };
    const session = { provider: 'codex', sessionId: 'locale-root' };
    const summary = { session, title: 'Provider-owned title', directory: '/locale-fixture',
      createdAt: localeTimestamp, updatedAt: localeTimestamp, messageCount: 1, tokenCount: null, parent: null };
    if (url.pathname === '/api/providers') return json([{ id: 'codex', available: true }]);
    if (url.pathname === '/api/v3/library/sessions') return json({ families: [{ session: summary,
      matched: true, matchingCount: 1, childCount: 0, totalChildCount: 0,
      familyRootId: 'locale-root', familyUpdated: localeTimestamp, parentBoundary: null }],
      total: 1, matchingSessions: 1, sourceDiagnostics: [], nextCursor: null });
    if (url.pathname === '/api/settings') return json({ configFile: { path: '/locale/config.json', loaded: false },
      startup: { port: 3456, sources: {}, state: {} }, runtimeEditable: [],
      runtime: { projectPaths: {}, resumeCommands: {}, resumeShell: null } });
    if (url.pathname === '/api/v3/reader/codex/locale-root/bootstrap') {
      const event = { provider: 'codex', sessionId: 'locale-root', messageId: 'message-1', segment: 'message' };
      const item = { event, ordinal: 0, owner: null, role: 'assistant', timestamp: localeTimestamp,
        preview: 'Provider-owned body', totalChars: 19, toolName: null, ownerMessageId: null, replyMetadata: null,
        contentRevisions: {} };
      return json({ session: summary, revision: 'locale-revision', totalItems: 1,
        segments: [{ id: 'segment-0', pageId: 'page-0', startOrdinal: 0,
          items: [item], ownerContext: null, previousCursor: null, nextCursor: null }],
        toc: { entries: [{ event, ordinal: 0, owner: null, label: item.preview }],
          previousCursor: null, nextCursor: null },
        relations: { taskCount: 0, observationCount: 0, firstCursor: null } });
    }
    if (url.pathname === '/api/v3/reader/codex/locale-root/relations')
      return json({ session, revision: 'locale-revision', entries: [], childPlacements: [], nextCursor: null });
    if (url.pathname === '/api/v3/reader/codex/locale-root/executions')
      return json({ session, revision: 'locale-revision', coverage: 'partial', events: [], nextCursor: null, scannedEvents: 0 });
    if (url.pathname.startsWith('/api/v3/runtime/codex/locale-root/'))
      return json({ session, revision: 'locale-revision', coverage: 'partial', events: [], nextCursor: null, scannedEvents: 0 });
    if (url.pathname.startsWith('/api/v3/resume/codex/'))
      return json({ allowTerminalLaunch: false, available: false, diagnostic: null, command: null });
    if (url.pathname.startsWith('/api/v3/meta/codex/')) return json(null);
    if (url.pathname.startsWith('/api/')) { response.writeHead(404).end(); return; }
    const asset = url.pathname.startsWith('/assets/')
      ? path.resolve(buildDir, `.${url.pathname}`) : path.join(buildDir, 'index.html');
    if (!asset.startsWith(buildDir + path.sep) && asset !== path.join(buildDir, 'index.html')) {
      response.writeHead(400).end(); return;
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
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(buildDir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${port}`;
}

async function browser(t, url) {
  const name = `agentsession-v3-locale-${process.pid}-${Date.now()}`;
  const command = (...args) => new Promise((resolve, reject) => {
    const child = spawn(browserExe, ['--session', name, ...args],
      { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`agent-browser ${args[0]} timed out`)); }, 15_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout));
    });
  });
  t.after(async () => { try { await command('close'); } catch { /* Browser already closed. */ } });
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

test('English and Chinese UI selection persists through reload and browser navigation',
  { skip, timeout: 90_000 }, async t => {
    const origin = await harness(t);
    const command = await browser(t, `${origin}/sessions`);
    await waitFor(command, `document.querySelector('.library-heading h1')`);
    assert.equal(Number(await command('get', 'count', '.language-select')), 1);
    await command('select', '.language-select', 'en');
    await waitFor(command, `document.documentElement.lang === 'en'`);
    await command('click', '.session-row');
    await waitFor(command, `document.querySelector('.reader-layout')`);
    assert.equal(await command('get', 'value', '.language-select'), 'en');
    assert.ok((await command('get', 'text', 'body')).includes('Provider-owned title'));
    await waitFor(command, `document.querySelector('.reader-byline span:nth-child(3)')?.textContent.includes(new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(${localeTimestamp})))`);
    await waitFor(command, `document.querySelector('.event-card time')?.textContent === new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(${localeTimestamp}))`);
    await command('select', '.language-select', 'zh');
    await waitFor(command, `document.documentElement.lang === 'zh-CN'`);
    await waitFor(command, `document.querySelector('.reader-byline span:nth-child(3)')?.textContent.includes(new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(${localeTimestamp})))`);
    await waitFor(command, `document.querySelector('.event-card time')?.textContent === new Intl.DateTimeFormat('zh-CN', { hour: 'numeric', minute: '2-digit' }).format(new Date(${localeTimestamp}))`);
    assert.equal(await command('get', 'text', '.conversation-tab'), '对话');
    assert.equal(await command('get', 'text', '.settings-nav-link[href="/settings"]'), '设置');
    await command('click', '.runtime-tab');
    await waitFor(command, `document.querySelector('.runtime-lenses')`);
    assert.ok((await command('get', 'text', '.runtime-lenses')).includes('上下文'));
    await command('click', 'a[href="/settings"]');
    await waitFor(command, `document.querySelector('.settings-panel')`);
    assert.equal(await command('get', 'text', 'h1'), '设置');
    await command('eval', 'history.back()');
    await waitFor(command, `document.querySelector('.reader-layout')`);
    assert.equal(await command('get', 'value', '.language-select'), 'zh');
    await command('eval', 'history.forward()');
    await waitFor(command, `document.querySelector('.settings-panel')`);
    assert.equal(await command('get', 'text', 'h1'), '设置');
    await command('eval', 'location.reload()');
    await waitFor(command, `document.querySelector('.settings-panel')`);
    assert.equal(await command('get', 'value', '.language-select'), 'zh');
    assert.equal(JSON.parse(await command('eval', 'document.documentElement.lang')), 'zh-CN');
    await command('click', 'a[href="/stats"]');
    await waitFor(command, `document.querySelector('.stats-page')`);
    assert.equal(await command('get', 'text', 'h1'), 'Token 统计');
    assert.equal(Number(await command('get', 'count', '.stats-toolbar select[aria-label="日期范围"]')), 1);
    await command('select', '.language-select', 'en');
    await waitFor(command, `document.documentElement.lang === 'en'`);
    assert.equal(await command('get', 'text', 'h1'), 'Token statistics');
  });

test('embedded Axum Web serves the selected language on a real provider page',
  { skip: skip || !existsSync(binary) ? 'Build the v3 Rust app and install agent-browser.' : false,
    timeout: 90_000 }, async t => {
    const codexFixture = path.join(repo, 'v3', 'fixtures', 'codex', 'sessions', '2026', '09', '26',
      'rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl');
    const sourceHash = createHash('sha256').update(readFileSync(codexFixture)).digest('hex');
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-locale-axum-'));
    const piSessionDir = path.join(stateDir, 'pi', 'sessions', 'locale-project');
    await mkdir(piSessionDir, { recursive: true });
    await writeFile(path.join(piSessionDir, 'locale.jsonl'), [
      { type: 'session', version: 3, id: 'locale-real', cwd: '/locale-fixture',
        timestamp: '2026-09-28T00:00:00.000Z' },
      { type: 'message', id: 'user', parentId: null,
        message: { role: 'user', content: 'Provider-owned browser evidence' } },
      { type: 'message', id: 'assistant', parentId: 'user',
        message: { role: 'assistant', content: [{ type: 'text', text: 'PI_SHORT_REPLY' }] } },
    ].map(JSON.stringify).join('\n') + '\n');
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(binary, ['serve', '--port', String(port),
      '--codex-dir', path.join(repo, 'v3', 'fixtures', 'codex'),
      '--claude-dir', path.join(stateDir, 'claude'),
      '--pi-dir', path.join(stateDir, 'pi'),
      '--dsh-dir', path.join(stateDir, 'dsh'),
      '--opencode-db', path.join(stateDir, 'opencode.db'),
      '--meta-dir', path.join(stateDir, 'meta'),
      '--index-dir', path.join(stateDir, 'index'),
      '--cache-dir', path.join(stateDir, 'cache')],
    { cwd: repo, windowsHide: true, stdio: 'ignore' });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const done = once(child, 'close'); child.kill(); await done;
      }
      await rm(stateDir, { recursive: true, force: true });
    });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(origin + '/api/providers')).ok; } catch { /* Starting. */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'The embedded Web server starts');
    const command = await browser(t, origin + '/sessions');
    await waitFor(command, `document.querySelector('.library-heading h1')`);
    await command('select', '.language-select', 'zh');
    await waitFor(command, `document.documentElement.lang === 'zh-CN'`);
    assert.equal(await command('get', 'text', '.library-heading h1'), '会话');
    await command('open', origin + '/pi/session/locale-real');
    await waitFor(command, `document.querySelector('.reader-layout')`);
    assert.equal(await command('get', 'text', '.conversation-tab'), '对话');
    assert.equal(await command('get', 'text', '.runtime-tab'), '技术详情');
    await command('select', '.language-select', 'en');
    await command('set', 'viewport', '1260', '566');
    await waitFor(command, `document.querySelectorAll('.event-card').length === 2`);
    assert.equal(Number(await command('get', 'count', '.reader-process')), 0);
    assert.equal(Number(await command('get', 'count', '.collaboration-summary')), 0);
    assert.equal(Number(await command('get', 'count', '.pane-search')), 1);
    assert.equal(Number(await command('get', 'count', '.prompt-evidence-panel')), 0);
    await command('click', '.reader-session-details summary');
    await waitFor(command, `document.querySelector('.prompt-evidence-panel')`);
    await command('click', '.reader-session-details summary');
    assert.equal(JSON.parse(await command('eval', `document.querySelector('#reader-search').hidden`)), true,
      'Optional search starts collapsed for the short exchange');
    const replyBottom = Number(await command('eval',
      `document.querySelectorAll('.event-card')[1].getBoundingClientRect().bottom`));
    t.diagnostic(await command('eval', `JSON.stringify({scrollY, header:document.querySelector('.reader-heading')?.getBoundingClientRect().toJSON(), detailsOpen:document.querySelector('.reader-session-details').open, cards:[...document.querySelectorAll('.event-card')].map(card=>({rect:card.getBoundingClientRect().toJSON(),body:card.querySelector('.event-body')?.getBoundingClientRect().toJSON(),text:card.innerText}))})`));
    assert.ok(replyBottom <= 566, `A simple Pi reply must be visible without scrolling; bottom=${replyBottom}`);
    for (const selectedLanguage of ['en', 'zh']) {
      await command('select', '.language-select', selectedLanguage);
      await waitFor(command, `document.documentElement.lang === '${selectedLanguage === 'zh' ? 'zh-CN' : 'en'}'`);
      for (const theme of ['light', 'dark']) {
        await command('select', '.theme-select', theme);
        await waitFor(command, `document.documentElement.dataset.theme === '${theme}'`);
        const bottom = Number(await command('eval',
          `document.querySelectorAll('.event-card')[1].getBoundingClientRect().bottom`));
        assert.ok(bottom <= 566, `${selectedLanguage}/${theme} Pi reply is visible; bottom=${bottom}`);
      }
    }
    await command('focus', '.reader-find-toggle');
    await command('press', 'Control+Shift+f');
    await waitFor(command, `!document.querySelector('#reader-search').hidden`);
    assert.equal(JSON.parse(await command('eval',
      `document.activeElement === document.querySelector('.pane-search input')`)), true,
    'Search remains keyboard reachable after the exchange');
    await command('press', 'Escape');
    assert.equal(JSON.parse(await command('eval', `document.querySelector('#reader-search').hidden`)), true,
      'Escape collapses session search');
    assert.equal(JSON.parse(await command('eval', `document.activeElement === document.querySelector('.reader-find-toggle')`)), true,
      'Closing search returns keyboard focus to its disclosure');
    assert.equal(await command('errors'), '');
    assert.equal(createHash('sha256').update(readFileSync(codexFixture)).digest('hex'), sourceHash,
      'The provider-owned fixture remains unchanged');
  });
