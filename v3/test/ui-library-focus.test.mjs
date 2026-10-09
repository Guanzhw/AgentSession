import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binaryName = process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3';
const appBinary = process.env.AGENTSESSION_V3_BINARY || path.join(repo, 'v3', 'target', 'debug', binaryName);
const browserName = process.platform === 'win32'
  ? 'agent-browser-win32-x64.exe' : `agent-browser-${process.platform}-${process.arch}`;
const browserBinary = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
  (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', browserName))
    .find(existsSync);
const skip = !existsSync(appBinary) ? 'Build v3/ui and the agentsession-v3 debug binary first.'
  : !browserBinary || !existsSync(browserBinary) ? 'agent-browser is required for browser QA.' : false;

const provider = 'codex';
const sessionId = 'focus-v3-library-return';
const query = 'research-workflow';
const canonicalPath = `/${provider}/session/${sessionId}`;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForHttp(url, child, logs) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Axum server exited early: ${logs.stderr || logs.stdout}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch { /* The loopback listener is still starting. */ }
    await delay(100);
  }
  throw new Error(`Axum server did not become ready: ${logs.stderr || logs.stdout}`);
}

async function axumHarness(t) {
  const tempRoot = await mkdtemp(path.join(repo, 'tmp', 'v3-library-focus-'));
  const sourceRoot = path.join(tempRoot, 'codex');
  const sourceFile = path.join(sourceRoot, 'sessions', '2026', '09', '28',
    'rollout-2026-09-28T00-00-00-88888888-8888-4888-8888-888888888888.jsonl');
  await mkdir(path.dirname(sourceFile), { recursive: true });
  for (const directory of ['meta', 'index', 'cache', 'claude', 'pi', 'dsh']) {
    await mkdir(path.join(tempRoot, directory), { recursive: true });
  }
  const source = [
    { timestamp: '2026-09-28T00:00:00.000Z', ordinal: 0, type: 'session_meta',
      payload: { id: sessionId, cwd: '/workspace/research-workflow', cli_version: '0.1.0' } },
    { timestamp: '2026-09-28T00:00:01.000Z', ordinal: 1, type: 'response_item',
      payload: { type: 'message', role: 'user', id: 'request-1',
        content: [{ type: 'input_text', text: 'Please review the research-workflow acceptance contract.' }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } },
    { timestamp: '2026-09-28T00:00:02.000Z', ordinal: 2, type: 'response_item',
      payload: { type: 'message', role: 'assistant', id: 'reply-1',
        content: [{ type: 'output_text', text: 'The research-workflow plan is ready for review.' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(sourceFile, source, 'utf8');
  const sourceDigest = createHash('sha256').update(await readFile(sourceFile)).digest('hex');

  const port = await freeFetchSafePort();
  const origin = `http://127.0.0.1:${port}`;
  const configFile = path.join(tempRoot, 'config.json');
  await writeFile(configFile, '{}\n', 'utf8');
  const args = [
    '--config', configFile, 'serve', '--port', String(port), '--codex-dir', sourceRoot,
    '--opencode-db', path.join(tempRoot, 'opencode.db'), '--claude-dir', path.join(tempRoot, 'claude'),
    '--pi-dir', path.join(tempRoot, 'pi'), '--dsh-dir', path.join(tempRoot, 'dsh'),
    '--meta-dir', path.join(tempRoot, 'meta'), '--index-dir', path.join(tempRoot, 'index'),
    '--cache-dir', path.join(tempRoot, 'cache'),
  ];
  const child = spawn(appBinary, args, { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { logs.stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { logs.stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await new Promise(resolve => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', resolve);
    });
    await rm(tempRoot, { recursive: true, force: true });
  });

  const providersResponse = await waitForHttp(`${origin}/api/providers`, child, logs);
  const activeProviders = await providersResponse.json();
  assert.ok(activeProviders.some(row => row.id === provider && row.available),
    'the isolated Axum service reads the synthetic Codex source');
  const searchResponse = await fetch(`${origin}/api/v3/search?${new URLSearchParams({ q: query })}`);
  assert.equal(searchResponse.status, 200);
  const searchPage = await searchResponse.json();
  assert.ok(searchPage.matches.some(match => match.session.provider === provider
    && match.session.sessionId === sessionId), 'Axum search returns the canonical synthetic session');

  return { origin, child, logs, sourceFile, sourceDigest };
}

async function browserSession(t, url) {
  const session = `agentsession-v3-library-focus-${process.pid}-${Date.now()}`;
  const command = (...args) => new Promise((resolve, reject) => {
    const child = spawn(browserBinary, ['--session', session, ...args],
      { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`agent-browser ${args[0]} timed out`)); }, 20_000);
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
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if ((await command('eval', `Boolean(${expression})`)).includes('true')) return;
    await delay(75);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function enablePageScroll(command) {
  await command('eval', `(() => { document.documentElement.style.minHeight = '2200px';
    document.body.style.minHeight = '2200px'; document.documentElement.style.scrollBehavior = 'auto'; })()`);
}

async function tabToResult(command, expectedPath) {
  for (let index = 0; index < 8; index++) {
    const activePath = JSON.parse(await command('eval',
      `document.activeElement instanceof HTMLAnchorElement ? new URL(document.activeElement.href).pathname : ''`));
    if (activePath === expectedPath) return;
    await command('press', 'Tab');
  }
  throw new Error(`Tab navigation did not reach ${expectedPath}`);
}

for (const width of [1088, 1280]) {
  test(`Desktop ${width}px Library and Reader retain visible keyboard navigation without horizontal scrolling`,
    { skip, timeout: 120_000 }, async t => {
      const app = await axumHarness(t);
      const command = await browserSession(t, `${app.origin}/sessions`);
      await command('set', 'viewport', String(width), '1244');
      await waitFor(command, `document.querySelector('[data-search-mode="content"]')`);
      await command('click', '[data-search-mode="content"]');
      await command('fill', 'input[type="search"]', query);
      await command('press', 'Enter');
      await waitFor(command, `document.querySelector('.search-results a[href^="${canonicalPath}"]')`);

      async function assertDesktop(stage) {
        const geometry = JSON.parse(await command('eval', `(() => {
          const active = document.activeElement;
          const rect = active?.getBoundingClientRect();
          return { viewport: innerWidth, clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth, scrollX,
            focused: rect ? { left: rect.left, right: rect.right } : null };
        })()`));
        t.diagnostic(`${stage}: ${JSON.stringify(geometry)}`);
        assert.ok(geometry.scrollWidth <= geometry.clientWidth,
          `${stage}: the document fits the desktop content viewport: ${JSON.stringify(geometry)}`);
        assert.equal(geometry.scrollX, 0, `${stage}: keyboard navigation preserves horizontal position`);
        if (geometry.focused) assert.ok(geometry.focused.left >= 0
          && geometry.focused.right <= geometry.clientWidth,
        `${stage}: the focused control remains fully visible: ${JSON.stringify(geometry)}`);
      }

      await command('focus', '.search-submit');
      await command('press', 'Tab');
      await tabToResult(command, canonicalPath);
      const departedHref = JSON.parse(await command('eval', 'document.activeElement.getAttribute("href")'));
      await assertDesktop('Library result');
      await command('press', 'Enter');
      await waitFor(command, `document.querySelector('#reader-title')?.textContent.trim()`);
      const openingHash = JSON.parse(await command('eval', 'location.hash'));
      await assertDesktop('Reader opening');
      await command('click', '.outline-turn-toggle[aria-expanded="false"]');
      await command('focus', '.reader-outline a[href="#event?messageId=reply-1&segment=message"]');
      await command('press', 'Enter');
      await waitFor(command, `location.hash === '#event?messageId=reply-1&segment=message'`);
      await assertDesktop('Assistant outline Enter');
      await command('back');
      await waitFor(command, `location.hash === ${JSON.stringify(openingHash)}`);
      await assertDesktop('Reader Back');
      await command('back');
      await waitFor(command, `location.pathname === '/sessions'
        && document.querySelector('input[type="search"]')?.value === '${query}'
        && document.activeElement?.getAttribute('href') === ${JSON.stringify(departedHref)}`);
      await assertDesktop('Library Back');
      const sourceDigestAfter = createHash('sha256').update(await readFile(app.sourceFile)).digest('hex');
      assert.equal(sourceDigestAfter, app.sourceDigest, 'desktop navigation leaves the provider source unchanged');
    });
}

test('Library search restores its departed result link after Reader locate, reload, and Back',
  { skip, timeout: 120_000 }, async t => {
    const app = await axumHarness(t);
    const command = await browserSession(t, `${app.origin}/sessions`);
    await waitFor(command, `document.querySelector('[data-search-mode="content"]')`);
    await command('click', '[data-search-mode="content"]');
    await command('eval', `(() => { const select = document.querySelector('[data-content-provider]');
      select.value = '${provider}'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await command('fill', 'input[type="search"]', query);
    await command('press', 'Enter');
    await waitFor(command, `document.querySelector('.search-results a[href^="${canonicalPath}"]')`);

    await waitFor(command, `document.querySelector('.search-submit') && !document.querySelector('.search-submit').disabled`);
    await command('focus', '.search-submit');
    await command('press', 'Tab');
    await tabToResult(command, canonicalPath);
    await enablePageScroll(command);
    await command('scroll', 'down', '360');
    const scrollBefore = JSON.parse(await command('eval', `(() => ({ scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight, bodyHeight: document.body.offsetHeight,
      viewport: document.documentElement.clientHeight }))()`));
    assert.ok(scrollBefore.scrollY > 0,
      `Keyboard focus places the result at a non-zero Library scroll position; observed ${JSON.stringify(scrollBefore)}`);
    await command('press', 'Enter');
    await waitFor(command, `document.querySelector('#reader-title')?.textContent.trim()`);
    const departedScroll = JSON.parse(await command('eval',
      `history.state?.agentSessionLibrary?.scroll`));
    assert.ok(departedScroll > 0, 'Opening the focused result saves the departed Library scroll position');

    const departedLibrary = JSON.parse(await command('eval',
      `history.state?.agentSessionLibrary`));
    await command('focus', 'a.reader-back-link');
    await command('press', 'Enter');
    await waitFor(command, `document.querySelector('#library-title')?.textContent.trim() === 'Sessions'`);
    await waitFor(command, `document.querySelector('.search-results a[href^="${canonicalPath}"]')`);
    await waitFor(command, `document.querySelector('input[type="search"]')?.value === '${query}'`);
    await waitFor(command, `Math.abs(window.scrollY - ${departedScroll}) <= 10`);
    const pageReturn = JSON.parse(await command('eval', `(() => ({
      path: location.pathname,
      activeHref: document.activeElement instanceof HTMLAnchorElement
        ? document.activeElement.getAttribute('href') : null,
      query: document.querySelector('input[type="search"]')?.value,
      provider: document.querySelector('[data-content-provider]')?.value,
      scroll: window.scrollY,
    }))()`));
    assert.equal(pageReturn.path, '/sessions');
    assert.equal(pageReturn.query, query);
    assert.equal(pageReturn.provider, provider);
    assert.equal(pageReturn.activeHref, departedLibrary.focusTarget.href,
      'Keyboard activation of All sessions restores focus to the exact departed search result');
    assert.ok(Math.abs(pageReturn.scroll - departedLibrary.scroll) <= 10,
      `All sessions restores its saved Library position ${departedLibrary.scroll}; observed ${pageReturn.scroll}`);

    await command('press', 'Enter');
    await waitFor(command, `document.querySelector('#reader-title')?.textContent.trim()`);
    const reloadDepartedLibrary = JSON.parse(await command('eval',
      `history.state?.agentSessionLibrary`));
    await command('focus', '.reader-outline a[href="#event?messageId=request-1&segment=message"]');
    await command('press', 'Enter');
    await waitFor(command, `location.hash === '#event?messageId=request-1&segment=message'`);
    assert.notEqual(JSON.parse(await command('eval', 'location.hash')),
      '#event?messageId=reply-1&segment=message', 'the reply locate must change the current canonical hash');
    await command('click', '.outline-turn-toggle[aria-expanded="false"]');
    await command('focus', '.reader-outline a[href="#event?messageId=reply-1&segment=message"]');
    await command('press', 'Enter');
    await waitFor(command, `location.hash === '#event?messageId=reply-1&segment=message'`);
    assert.deepEqual(JSON.parse(await command('eval', 'history.state?.agentSessionLibrary')),
      reloadDepartedLibrary, 'the completed in-session locate preserves the departed Library state');
    await command('reload');
    await waitFor(command, `document.querySelector('#reader-title')?.textContent.trim()`);
    await enablePageScroll(command);
    await command('focus', 'a.reader-back-link');
    await command('press', 'Enter');
    await waitFor(command, `document.querySelector('#library-title')?.textContent.trim() === 'Sessions'
      && document.querySelector('input[type="search"]')?.value === '${query}'`);
    await waitFor(command, `!document.querySelector('.search-loading')
      && (document.querySelector('.search-results') || document.querySelector('.empty-state.compact-empty')
        || document.querySelector('.search-error') || document.querySelector('.source-diagnostic'))`);
    await waitFor(command, `Math.abs(window.scrollY - ${reloadDepartedLibrary.scroll}) <= 10`);
    const reloadPageReturn = JSON.parse(await command('eval', `(() => ({
      activeHref: document.activeElement instanceof HTMLAnchorElement
        ? document.activeElement.getAttribute('href') : null,
      query: document.querySelector('input[type="search"]')?.value,
      provider: document.querySelector('[data-content-provider]')?.value,
      resultHrefs: [...document.querySelectorAll('.search-results a[href]')]
        .map(link => link.getAttribute('href')),
      scroll: window.scrollY,
    }))()`));
    assert.ok(reloadPageReturn.resultHrefs.includes(reloadDepartedLibrary.focusTarget.href),
      `Returning after Reader reload reruns the submitted search; observed ${JSON.stringify(reloadPageReturn)}`);
    assert.equal(reloadPageReturn.query, query);
    assert.equal(reloadPageReturn.provider, provider,
      'All sessions after an in-session locate and Reader reload restores the provider scope');
    assert.equal(reloadPageReturn.activeHref, reloadDepartedLibrary.focusTarget.href,
      'All sessions after Reader reload restores the exact departed result focus');
    assert.ok(Math.abs(reloadPageReturn.scroll - reloadDepartedLibrary.scroll) <= 10,
      `All sessions after Reader reload restores its saved position ${reloadDepartedLibrary.scroll}; observed ${reloadPageReturn.scroll}`);
    await command('press', 'Enter');
    await waitFor(command, `document.querySelector('#reader-title')?.textContent.trim()`);
    await command('reload');
    await waitFor(command, `document.querySelector('#reader-title')?.textContent.trim()`);
    await enablePageScroll(command);

    await command('back');
    await waitFor(command, `document.querySelector('.search-results a[href^="${canonicalPath}"]')`);
    await waitFor(command, `document.querySelector('input[type="search"]')?.value === '${query}'`);
    await waitFor(command, `Math.abs(window.scrollY - ${departedScroll}) <= 10`);
    const restored = JSON.parse(await command('eval', `(() => ({
      path: location.pathname,
      scroll: window.scrollY,
      activeHref: document.activeElement instanceof HTMLAnchorElement
        ? document.activeElement.getAttribute('href') : null,
      query: document.querySelector('input[type="search"]')?.value,
      provider: document.querySelector('[data-content-provider]')?.value,
    }))()`));
    assert.equal(restored.path, '/sessions');
    assert.equal(restored.query, query);
    assert.equal(restored.provider, provider);
    assert.ok(Math.abs(restored.scroll - departedScroll) <= 10,
      `Library returns to its saved scroll position ${departedScroll}; observed ${restored.scroll}`);
    assert.ok(restored.activeHref?.startsWith(canonicalPath),
      `Back restores focus to the departed canonical result link; observed ${restored.activeHref}`);

    await command('forward');
    await waitFor(command, `document.querySelector('#reader-title')?.textContent.trim()`);
    await command('back');
    await waitFor(command, `document.querySelector('.search-results a[href^="${canonicalPath}"]')`);
    await waitFor(command, `document.activeElement instanceof HTMLAnchorElement
      && new URL(document.activeElement.href).pathname === '${canonicalPath}'`);

    await command('forward');
    await waitFor(command, `document.querySelector('#reader-title')?.textContent.trim()`);
    await command('network', 'route', '**/api/v3/search*', '--body',
      JSON.stringify({ matches: [], diagnostics: [], nextCursor: null, truncated: false }));
    await command('reload');
    await waitFor(command, `document.querySelector('#reader-title')?.textContent.trim()`);
    await enablePageScroll(command);
    await command('back');
    await waitFor(command, `location.pathname === '/sessions' && !document.querySelector('.search-loading')`);
    await waitFor(command, `document.querySelector('input[type="search"]')?.value === '${query}'`);
    const fallback = JSON.parse(await command('eval', `(() => ({
      activeIsQuery: document.activeElement === document.querySelector('input[type="search"]'),
      activeTag: document.activeElement?.tagName,
    }))()`));
    assert.equal(fallback.activeIsQuery, true,
      `When the departed result is absent, focus returns to the query control; observed ${fallback.activeTag}`);

    const sourceDigestAfter = createHash('sha256').update(await readFile(app.sourceFile)).digest('hex');
    assert.equal(sourceDigestAfter, app.sourceDigest, 'browser navigation leaves the provider source unchanged');
  });
