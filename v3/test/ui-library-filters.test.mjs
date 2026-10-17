import { onCleanup, temporaryDirectory } from '../../test/helpers/fixture-cleanup.mjs';
import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const uiDir = path.join(repo, 'v3', 'ui');
const browserName = process.platform === 'win32'
  ? 'agent-browser-win32-x64.exe' : `agent-browser-${process.platform}-${process.arch}`;
const browserExe = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
  (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', browserName))
    .find(existsSync);
const skip = !existsSync(path.join(uiDir, 'node_modules', 'vite'))
  ? 'Install the locked v3 UI dependencies.'
  : !browserExe || !existsSync(browserExe) ? 'agent-browser is required for browser QA.' : false;

const providers = [
  { id: 'codex', available: true },
  { id: 'claude-code', available: true },
  { id: 'opencode', available: false, storageDiagnostic: {
    schema: 'unreadable', path: '/synthetic/opencode.db',
    note: 'SQLite database header is invalid.'
  } },
  { id: 'pi', available: false },
  { id: 'deepseek-harness', available: false },
];
const projects = ['/workspace/alpha', '/workspace/beta'];

function summary(provider, sessionId, directory, parent = null) {
  return { session: { provider, sessionId }, title: sessionId.replaceAll('-', ' '), directory,
    createdAt: 1, updatedAt: 1, messageCount: 1, tokenCount: null, parent };
}

function node(session, { childCount = 0, boundary = null, starred = false } = {}) {
  return { session, starred, matched: true, matchingCount: 1, childCount,
    totalChildCount: childCount, familyRootId: session.session.sessionId,
    familyUpdated: session.updatedAt, parentBoundary: boundary };
}

const roots = [
  node(summary('codex', 'codex-alpha-root', projects[0]), { childCount: 2 }),
  node(summary('claude-code', 'claude-alpha-root', projects[0])),
  node(summary('codex', 'codex-beta-root', projects[1]), { starred: true }),
  node(summary('claude-code', 'claude-beta-root', projects[1])),
];
const alphaChildren = [1, 2].map(index => node(summary('codex', `codex-alpha-child-${index}`, projects[0],
  { provider: 'codex', sessionId: 'codex-alpha-root' }), { starred: index === 2 }));

async function freePort() {
  return freeFetchSafePort();
}

async function harness(t, { opencodeInitiallyAvailable = false, collisionRow = false } = {}) {
  const { build } = createRequire(path.join(uiDir, 'package.json'))('vite');
  const buildDir = await temporaryDirectory(t, path.join(os.tmpdir(), 'agentsession-v3-ui-library-filters-'));
  await build({ root: uiDir, configFile: path.join(uiDir, 'vite.config.ts'),
    build: { outDir: buildDir, emptyOutDir: true }, logLevel: 'error' });
  const providerRows = providers.map(row => ({ ...row }));
  if (opencodeInitiallyAvailable) {
    const opencode = providerRows.find(row => row.id === 'opencode');
    opencode.available = true;
    opencode.storageDiagnostic = null;
  }
  const providerRequests = [];
  const sourceState = { failLoadMore: true, genericRetryFailure: false };
  const libraryRequests = [];
  const childRequests = [];
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    const json = (body, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/providers') {
      providerRequests.push(url.pathname);
      return json(providerRows);
    }
    if (url.pathname === '/api/v3/library/sessions') {
      const filters = Object.fromEntries(url.searchParams);
      libraryRequests.push(filters);
      if (filters.provider === 'codex' && filters.search === 'paged-failure') {
        if (!filters.cursor && sourceState.genericRetryFailure) {
          return json({ error: { code: 'request_failed', message: 'Local transport failed.' } }, 503);
        }
        if (filters.cursor && sourceState.failLoadMore) {
          return json({ error: { code: 'source_error',
            message: 'Codex source changed while loading more families.' } }, 500);
        }
        const start = filters.cursor ? 40 : 0;
        const count = filters.cursor ? 1 : 40;
        const families = Array.from({ length: count }, (_, index) =>
          node(summary('codex', `codex-paged-${start + index}`, projects[0])));
        return json({ families, total: 41, matchingSessions: 41, sourceDiagnostics: [],
          nextCursor: filters.cursor ? null : 'codex-page-2' });
      }
      if (filters.provider && !providerRows.some(row => row.id === filters.provider && row.available)) {
        return json({ error: { code: 'provider_unavailable',
          message: 'The selected provider is unavailable.' } }, 503);
      }
      if (filters.provider === 'claude-code' && filters.search === 'beta') {
        return json({ error: { code: 'source_error',
          message: 'Invalid transcript record at claude-session.jsonl:1.' } }, 500);
      }
      const normalizedProject = value => value.toLowerCase().replaceAll('\\', '/').replace(/\/$/, '');
      const search = (filters.search || '').toLowerCase();
      const candidates = collisionRow ? [...roots, node({
        ...summary('codex', 'codex-collided', projects[0]),
        diagnostic: 'codex_multiple_source_files_unmerged', messageCount: 0,
      })] : roots;
      const families = candidates.filter(row => {
        const session = row.session;
        return (!filters.provider || session.session.provider === filters.provider)
          && (!filters.project || normalizedProject(session.directory) === normalizedProject(filters.project))
          && (filters.starredOnly !== 'true' || row.starred || session.session.sessionId === 'codex-alpha-root')
          && (!search || [session.title, session.directory, session.session.sessionId]
            .some(value => value.toLowerCase().includes(search)));
      }).map(row => filters.starredOnly === 'true' && row.session.session.sessionId === 'codex-alpha-root'
        ? { ...row, childCount: 1, matched: false } : row);
      return json({ families, total: families.length, matchingSessions: families.length,
        sourceDiagnostics: [], nextCursor: null });
    }
    if (url.pathname === '/api/v3/library/children') {
      const filters = Object.fromEntries(url.searchParams);
      childRequests.push(filters);
      const rows = filters.parentId === 'codex-alpha-root' ? alphaChildren : [];
      const normalizedProject = value => value.toLowerCase().replaceAll('\\', '/').replace(/\/$/, '');
      const filtered = rows.filter(row => row.session.session.provider === filters.provider
        && (filters.starredOnly !== 'true' || row.starred)
        && (!filters.project || normalizedProject(row.session.directory) === normalizedProject(filters.project))
        && (!(filters.search || '') || row.session.title.toLowerCase().includes(filters.search.toLowerCase())));
      const page = filters.cursor ? filtered.slice(1) : filtered.slice(0, 1);
      return json({ parent: roots[0], children: page, total: filtered.length,
        nextCursor: !filters.cursor && filtered.length > 1 ? 'alpha-children-page-2' : null });
    }
    if (url.pathname === '/api/v3/search') return json({ matches: [], diagnostics: [], nextCursor: null,
      truncated: false });
    if (url.pathname === '/api/settings') return json({
      configFile: { path: '/fixture/config.json', loaded: true },
      startup: { port: 3457, sources: { codexDir: '/fixture/codex', dbPath: '/synthetic/opencode.db',
        claudeDir: '/fixture/claude', piDir: '/fixture/pi', dshDir: '/fixture/dsh' }, state: {} },
      runtimeEditable: ['resumeCommands', 'resumeShell', 'projectPaths', 'tokenPricing'],
      runtime: { resumeCommands: {}, resumeShell: null, projectPaths: {}, tokenPricing: {} },
    });
    const reader = url.pathname.match(/^\/api\/v3\/reader\/codex\/codex-alpha-root\/bootstrap$/);
    if (reader) return json({ session: roots[0].session, revision: 'public-filter-reader', totalItems: 0,
      segments: [], toc: { entries: [], previousCursor: null, nextCursor: null }, relations: null });
    if (url.pathname === '/api/v3/reader/codex/codex-alpha-root/executions') return json({
      session: { provider: 'codex', sessionId: 'codex-alpha-root' }, revision: 'public-filter-reader',
      coverage: 'partial', events: [], nextCursor: null, scannedEvents: 0,
    });
    if (url.pathname === '/api/v3/runtime/codex/codex-alpha-root/events') return json({
      session: { provider: 'codex', sessionId: 'codex-alpha-root' }, revision: 'public-filter-reader',
      coverage: 'partial', events: [], nextCursor: null, scannedEvents: 0,
    });
    if (url.pathname === '/api/v3/meta/codex/codex-alpha-root') return json(null);
    if (url.pathname === '/api/v3/resume/codex/codex-alpha-root') return json({
      allowTerminalLaunch: false, available: false, diagnostic: 'Resume unavailable', command: null,
    });
    if (url.pathname.startsWith('/api/')) return json({ error: { code: 'not_found' } }, 404);
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
    const contents = readFileSync(asset);
    response.end(asset.endsWith('index.html')
      ? contents.toString().replace('</head>', '<style>body{min-height:2200px!important}</style></head>')
      : contents);
  });
  onCleanup(t, async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  const port = await freePort();
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${port}`, libraryRequests, childRequests,
    providerRows, providerRequests, sourceState };
}

async function browser(t, url) {
  const session = `agentsession-v3-library-filters-${process.pid}-${Date.now()}`;
  const command = (...args) => new Promise((resolve, reject) => {
    const child = spawn(browserExe, ['--session', session, ...args],
      { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`agent-browser ${args[0]} timed out`)); }, 15_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout));
    });
  });
  onCleanup(t, () => command('close'));
  await command('open', url);
  await command('set', 'viewport', '1280', '900');
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

async function screenshot(command, name) {
  const dir = process.env.AGENTSESSION_V3_JOURNEY_SCREENSHOT_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await command('screenshot', path.join(dir, name));
}

test('Library visibly marks a Codex source collision without showing a zero message count',
  { skip, timeout: 30_000 }, async t => {
    const app = await harness(t, { collisionRow: true });
    const command = await browser(t, `${app.origin}/sessions`);
    await waitFor(command, `document.querySelector('a[href="/codex/session/codex-collided"] .source-diagnostic')`);
    const row = JSON.parse(await command('eval', `(() => {
      const row = document.querySelector('a[href="/codex/session/codex-collided"]');
      return { warning: row.querySelector('.source-diagnostic')?.textContent,
        count: row.querySelector('.message-count')?.textContent };
    })()`));
    assert.match(row.warning, /multiple Codex source files/);
    assert.equal(row.count, '—');
  });

test('Library filters two providers and two projects through family and child pages',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t);
    const command = await browser(t, `${app.origin}/sessions`);
    await waitFor(command, `document.querySelector('.session-table')`);

    const providerOptions = JSON.parse(await command('eval',
      `[...document.querySelector('[data-library-provider]').options].map(option => ({ value: option.value, label: option.textContent.trim() }))`));
    assert.deepEqual(providerOptions.map(option => option.value),
      ['', 'codex', 'claude-code', 'opencode', 'pi', 'deepseek-harness']);
    assert.match(providerOptions.find(option => option.value === 'opencode').label, /unavailable/i);

    await command('eval', `(() => { const select = document.querySelector('[data-library-provider]'); select.value = 'codex'; select.dispatchEvent(new Event('change', { bubbles: true })); const project = document.querySelector('[data-library-project]'); project.value = '${projects[0]}'; project.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(command, `document.querySelectorAll('.session-row').length === 1 && document.querySelector('.session-row')?.textContent.includes('codex alpha root')`);
    const filtered = app.libraryRequests.at(-1);
    assert.equal(filtered.provider, 'codex');
    assert.equal(filtered.project, projects[0]);
    assert.equal(filtered.search, undefined);

    await command('click', 'button[data-family-toggle="codex/codex-alpha-root"]');
    await waitFor(command, `document.querySelectorAll('.family-child-row').length === 1`);
    await command('click', 'button[data-family-more="codex/codex-alpha-root"]');
    await waitFor(command, `document.querySelectorAll('.family-child-row').length === 2`);
    assert.equal(new Set(JSON.parse(await command('eval',
      `[...document.querySelectorAll('.family-child-row')].map(row => row.getAttribute('href'))`))).size, 2);
    assert.deepEqual(app.childRequests.map(({ provider, parentId, project, search, cursor }) =>
      ({ provider, parentId, project, search, cursor })), [
      { provider: 'codex', parentId: 'codex-alpha-root', project: projects[0], search: undefined, cursor: undefined },
      { provider: 'codex', parentId: 'codex-alpha-root', project: projects[0], search: undefined, cursor: 'alpha-children-page-2' },
    ]);

    await command('eval', `(() => { const project = document.querySelector('[data-library-project]'); project.value = '${projects[1]}'; project.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(command, `document.querySelectorAll('.session-row').length === 1 && document.querySelector('.session-row')?.textContent.includes('codex beta root')`);
    assert.equal(app.libraryRequests.at(-1).provider, 'codex');
    assert.equal(app.libraryRequests.at(-1).project, projects[1]);

    await command('eval', `(() => { const select = document.querySelector('[data-library-provider]'); select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(command, `document.querySelectorAll('.session-row').length === 2`);
    assert.deepEqual(new Set(JSON.parse(await command('eval',
      `[...document.querySelectorAll('.session-row')].map(row => row.getAttribute('href'))`))),
    new Set(['/codex/session/codex-beta-root', '/claude-code/session/claude-beta-root']));
    assert.equal(app.libraryRequests.at(-1).project, projects[1]);
    assert.equal(app.libraryRequests.at(-1).provider, undefined);

    await command('fill', 'input[type="search"]', 'beta');
    await waitFor(command, `document.querySelectorAll('.session-row').length === 2`);

    await command('eval', `(() => { const select = document.querySelector('[data-library-provider]'); select.value = 'opencode'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(command, `document.querySelector('.library-source-note')?.textContent.includes('SQLite database header is invalid')`);
    assert.equal(await command('eval', `document.querySelector('.library-source-note').open`), 'false',
      'source issues start folded');
    await command('eval', `window.scrollTo({ top: 0, behavior: 'instant' })`);
    await command('click', '.library-source-note > summary');
    const unavailableDiagnostic = await command('get', 'text', '.library-source-note');
    assert.match(unavailableDiagnostic, /OpenCode/,
      'an unavailable selected source diagnostic identifies its provider');
    assert.match(unavailableDiagnostic, /SQLite database header is invalid/i,
      'filtering to an unavailable provider retains its earlier source-specific diagnostic');
    assert.equal(Number(await command('get', 'count', '.session-row')), 0,
      'an unavailable provider does not leave rows from the previous filter visible');
    assert.equal(await command('get', 'value', '[data-library-provider]'), 'opencode');
    assert.equal(await command('get', 'value', '[data-library-project]'), projects[1]);
    assert.equal(await command('get', 'value', 'input[type="search"]'), 'beta');
    assert.deepEqual((( { provider, project, search }) => ({ provider, project, search }))(app.libraryRequests.at(-1)),
      { provider: 'opencode', project: projects[1], search: 'beta' });

    await command('eval', `(() => { const select = document.querySelector('[data-library-provider]'); select.value = 'claude-code'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(command, `document.querySelector('.library-source-note')?.textContent.includes('Invalid transcript record')`);
    await command('eval', `window.scrollTo({ top: 0, behavior: 'instant' })`);
    await command('click', '.library-source-note > summary');
    const diagnostic = await command('get', 'text', '.library-source-note');
    assert.match(diagnostic, /Claude Code/,
      'a selected source failure identifies the provider that failed');
    assert.match(diagnostic, /Invalid transcript record at claude-session\.jsonl:1/,
      'a selected source failure retains the source diagnostic');
    assert.equal(Number(await command('get', 'count', '.session-row')), 0,
      'an invalid provider source does not leave rows from the previous filter visible');
    assert.equal(await command('get', 'value', '[data-library-provider]'), 'claude-code');
    assert.equal(await command('get', 'value', '[data-library-project]'), projects[1]);
    assert.equal(await command('get', 'value', 'input[type="search"]'), 'beta');
    assert.deepEqual((( { provider, project, search }) => ({ provider, project, search }))(app.libraryRequests.at(-1)),
      { provider: 'claude-code', project: projects[1], search: 'beta' });

    await command('fill', 'input[type="search"]', '');
    await waitFor(command, `document.querySelectorAll('.session-row').length === 1`);

    await command('eval', `(() => { const select = document.querySelector('[data-library-provider]'); select.value = 'codex'; select.dispatchEvent(new Event('change', { bubbles: true })); const project = document.querySelector('[data-library-project]'); project.value = '${projects[0]}'; project.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(command, `document.querySelectorAll('.session-row').length === 1 && document.querySelector('.session-row')?.textContent.includes('codex alpha root')`);
    await command('fill', 'input[type="search"]', 'codex alpha');
    await waitFor(command, `document.querySelectorAll('.family-child-row').length === 1`);
    await command('click', 'button[data-family-more="codex/codex-alpha-root"]');
    await waitFor(command, `document.querySelectorAll('.family-child-row').length === 2`);
    await command('eval', `document.body.style.minHeight = '2200px'; document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, 420)`);
    await waitFor(command, `window.scrollY === 420`);
    await command('eval', `document.querySelector('a[href="/codex/session/codex-alpha-root"]').click()`);
    await waitFor(command, `document.querySelector('#reader-title')?.textContent.trim() === 'codex alpha root'`);
    await command('back');
    await waitFor(command, `document.querySelectorAll('.family-child-row').length === 2`);
    await waitFor(command, `Math.abs(window.scrollY - 420) <= 10`);
    const restoredScroll = Number(await command('eval', 'window.scrollY'));
    assert.ok(Math.abs(restoredScroll - 420) <= 10,
      `Reader reload restores Library scroll position; observed ${restoredScroll}`);
    const savedScroll = Number(await command('eval', 'window.history.state?.agentSessionLibrary?.scroll'));
    assert.ok(Math.abs(savedScroll - 420) <= 10,
      `Reader reload keeps the Library history scroll position; saved ${savedScroll}`);
    assert.equal(await command('get', 'value', '[data-library-provider]'), 'codex');
    assert.equal(await command('get', 'value', '[data-library-project]'), projects[0]);
    assert.equal(await command('get', 'value', 'input[type="search"]'), 'codex alpha');
    await command('forward');
    await waitFor(command, `document.querySelector('#reader-title')?.textContent.trim() === 'codex alpha root'`);
    await command('reload');
    await waitFor(command, `document.querySelector('#reader-title')?.textContent.trim() === 'codex alpha root'`);
    await command('back');
    await waitFor(command, `document.querySelectorAll('.family-child-row').length === 2`);
    try {
      await waitFor(command, `Math.abs(window.scrollY - 420) <= 10`);
    } catch (error) {
      const state = await command('eval', `JSON.stringify({
        scrollY: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        bodyMinHeight: getComputedStyle(document.body).minHeight,
        savedScroll: window.history.state?.agentSessionLibrary?.scroll,
        href: window.location.href
      })`);
      throw new Error(`${error.message}; ${state}`);
    }
    const reloadedScroll = Number(await command('eval', 'window.scrollY'));
    assert.ok(Math.abs(reloadedScroll - 420) <= 10,
      `Reader reload restores Library scroll position; observed ${reloadedScroll}`);
    assert.equal(await command('get', 'value', '[data-library-provider]'), 'codex');
    assert.equal(await command('get', 'value', '[data-library-project]'), projects[0]);
    assert.equal(await command('get', 'value', 'input[type="search"]'), 'codex alpha');

    await command('click', '[data-search-mode="content"]');
    assert.match(await command('get', 'text', '.filter-scope-note'), /all providers and projects/i);
    await command('fill', 'input[type="search"]', 'needle');
    await command('click', '.search-submit');
    await waitFor(command, `document.querySelector('.search-results, .empty-state')`);
  });

test('Library clears a failed selected-provider page and retries with the same filters',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t);
    const command = await browser(t, `${app.origin}/sessions`);
    await waitFor(command, `document.querySelector('.session-table')`);

    await command('eval', `(() => { const select = document.querySelector('[data-library-provider]'); select.value = 'codex'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(command, `document.querySelectorAll('.session-row').length === 2`);
    await command('eval', `(() => { const field = document.querySelector('[data-library-project]'); field.value = '${projects[0]}'; field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(command, `document.querySelectorAll('.session-row').length === 1`);
    await command('fill', 'input[type="search"]', 'paged-failure');
    await waitFor(command, `document.querySelectorAll('.session-row').length === 40`);
    assert.match(await command('get', 'text', '.family-more'), /Load more families \(40 of 41\)/);

    await command('click', '.family-more');
    await waitFor(command, `document.querySelector('.library-source-note')?.textContent.includes('Codex source changed')`);
    assert.equal(await command('eval', `document.querySelector('.library-source-note').open`), 'false',
      'source issues start folded');
    await command('eval', `window.scrollTo({ top: 0, behavior: 'instant' })`);
    await command('click', '.library-source-note > summary');
    assert.match(await command('get', 'text', '.library-source-note'), /Codex source changed/);
    assert.equal(Number(await command('get', 'count', '.session-row')), 0,
      'a failed same-filter page clears previously loaded families');
    assert.equal(await command('get', 'text', '.archive-count strong'), '0',
      'the family count is cleared with the stale rows');
    assert.match(await command('get', 'text', '.family-more'), /Reload families/,
      'the source diagnostic leaves a retry action available');
    assert.equal(await command('get', 'value', '[data-library-provider]'), 'codex');
    assert.equal(await command('get', 'value', '[data-library-project]'), projects[0]);
    assert.equal(await command('get', 'value', 'input[type="search"]'), 'paged-failure');
    assert.deepEqual((( { provider, project, search }) => ({ provider, project, search }))(app.libraryRequests.at(-1)),
      { provider: 'codex', project: projects[0], search: 'paged-failure' });

    app.sourceState.failLoadMore = false;
    app.sourceState.genericRetryFailure = true;
    await command('click', '.family-more');
    await waitFor(command, `document.querySelector('.search-error')?.textContent.includes('Local transport failed')`);
    assert.equal(Number(await command('get', 'count', '.library-source-note')), 0,
      'a generic retry failure does not retain an obsolete selected-source diagnosis');
    app.sourceState.genericRetryFailure = false;
    await command('click', '.family-more');
    await waitFor(command, `document.querySelectorAll('.session-row').length === 40`);
    assert.equal(Number(await command('get', 'count', '.session-row')), 40,
      'retry reloads the first page for the retained filter identity');
    assert.equal(await command('get', 'value', '[data-library-provider]'), 'codex');
    assert.equal(await command('get', 'value', '[data-library-project]'), projects[0]);
    assert.equal(await command('get', 'value', 'input[type="search"]'), 'paged-failure');
  });

test('Library refreshes provider diagnostics when a source becomes unavailable',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t, { opencodeInitiallyAvailable: true });
    const command = await browser(t, `${app.origin}/sessions`);
    await waitFor(command, `document.querySelector('.session-table')`);
    await command('fill', 'input[type="search"]', 'beta');
    await waitFor(command, `document.querySelectorAll('.session-row').length === 2`);

    const opencode = app.providerRows.find(row => row.id === 'opencode');
    assert.equal(opencode.available, true);
    opencode.available = false;
    opencode.storageDiagnostic = {
      schema: 'unreadable', path: '/synthetic/opencode.db',
      note: 'OpenCode source became unreadable after startup.'
    };
    await command('eval', `(() => { const select = document.querySelector('[data-library-provider]'); select.value = 'opencode'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(command, `document.querySelector('.library-source-note')?.textContent.includes('OpenCode source became unreadable after startup')`);
    assert.equal(await command('eval', `document.querySelector('.library-source-note').open`), 'false',
      'source issues start folded');
    await command('eval', `window.scrollTo({ top: 0, behavior: 'instant' })`);
    await command('click', '.library-source-note > summary');

    const diagnostic = await command('get', 'text', '.library-source-note');
    assert.match(diagnostic, /OpenCode source became unreadable after startup/,
      'the diagnostic comes from the current provider status after the source fails');
    assert.ok(app.providerRequests.length >= 2,
      'the UI refreshes provider status after the selected source returns provider_unavailable');
    assert.equal(Number(await command('get', 'count', '.session-row')), 0,
      'the newly unavailable source does not leave prior provider rows visible');
    assert.equal(await command('get', 'value', '[data-library-provider]'), 'opencode');
    assert.equal(await command('get', 'value', 'input[type="search"]'), 'beta');
    assert.deepEqual((( { provider, search }) => ({ provider, search }))(app.libraryRequests.at(-1)),
      { provider: 'opencode', search: 'beta' });
  });

test('Starred filtering preserves core family context and combines with Library filters',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t);
    const command = await browser(t, `${app.origin}/sessions`);
    await waitFor(command, `document.querySelector('[data-library-star="codex/codex-beta-root"][data-starred="true"]')`);
    await command('eval', `(() => {
      for (const [selector, value] of [['[data-library-provider]', 'codex'], ['[data-library-range]', 'month'], ['[data-library-sort]', 'title-desc']]) {
        const field = document.querySelector(selector); field.value = value; field.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const project = document.querySelector('[data-library-project]'); project.value = '${projects[0]}'; project.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(command, `document.querySelectorAll('.session-row').length === 1`);
    await command('click', '[data-library-starred]');
    await waitFor(command, `document.querySelector('[data-library-starred]')?.checked && document.querySelector('[data-family-toggle]')?.textContent.includes('1 children')`);
    assert.deepEqual((( { provider, project, range, sort, starredOnly }) => ({ provider, project, range, sort, starredOnly }))(app.libraryRequests.at(-1)),
      { provider: 'codex', project: projects[0], range: 'month', sort: 'title-desc', starredOnly: 'true' });
    assert.equal(await command('get', 'attr', '[data-library-star="codex/codex-alpha-root"]', 'data-starred'), 'false',
      'a contextual parent keeps its own actual unstarred state');
    await command('click', '[data-family-toggle="codex/codex-alpha-root"]');
    await waitFor(command, `document.querySelector('[data-library-star="codex/codex-alpha-child-2"][data-starred="true"]')`);
    assert.equal(await command('get', 'count', '.family-child-row'), '1');
    assert.deepEqual((( { provider, project, range, sort, starredOnly }) => ({ provider, project, range, sort, starredOnly }))(app.childRequests.at(-1)),
      { provider: 'codex', project: projects[0], range: 'month', sort: 'title-desc', starredOnly: 'true' });
    await screenshot(command, 'library-starred-family-en.png');
    await command('click', '.session-row');
    await waitFor(command, `document.querySelector('.reader-layout')`);
    await command('eval', 'history.back()');
    await waitFor(command, `document.querySelector('[data-library-starred]')?.checked && document.querySelector('.family-child-row')`);
    assert.equal(await command('get', 'value', '[data-library-sort]'), 'title-desc');
    await command('eval', `(() => { const select = document.querySelector('.language-select'); select.value = 'zh'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(command, `document.querySelector('.library-starred-filter')?.textContent.includes('仅显示加星会话')`);
    assert.equal(await command('get', 'attr', '[data-library-star="codex/codex-alpha-child-2"]', 'aria-label'), '已加星');
    await screenshot(command, 'library-starred-family-zh.png');
  });

test('Source issues open the exact Settings source and retain documented startup guidance',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t);
    const command = await browser(t, `${app.origin}/sessions`);
    await waitFor(command, `document.querySelector('[data-library-provider]')`);
    await command('eval', `(() => { const select = document.querySelector('[data-library-provider]'); select.value = 'opencode'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(command, `document.querySelector('[data-source-settings="opencode"]')`);
    await command('click', '.library-source-note > summary');
    assert.equal(await command('get', 'attr', '[data-source-settings="opencode"]', 'href'), '/settings#source-opencode');
    await command('click', '[data-source-settings="opencode"]');
    await waitFor(command, `location.hash === '#source-opencode' && document.activeElement.id === 'source-opencode'`);
    const guidance = await command('get', 'text', '#source-opencode');
    assert.match(guidance, /\/synthetic\/opencode\.db/);
    assert.match(guidance, /dbPath/);
    assert.match(guidance, /--opencode-db/);
    assert.match(guidance, /AGENTSESSION_DB_PATH/);
    assert.match(guidance, /\/fixture\/config\.json/);
    assert.match(guidance, /higher-priority overrides/);
    assert.match(guidance, /Restart the Viewer/);
    assert.match(await command('get', 'text', '[aria-labelledby="settings-sources-heading"]'), /CLI options take precedence over environment variables, then configuration fields/);
    assert.equal(await command('eval', `getComputedStyle(document.activeElement).outlineStyle !== 'none'`), 'true');
    assert.equal(await command('eval', `document.querySelector('#source-heading-opencode').getBoundingClientRect().top >= document.querySelector('.topbar').getBoundingClientRect().bottom`), 'true',
      'the focused source heading remains visible below the fixed app header');
    assert.equal(await command('eval', `document.querySelector('#source-opencode').getBoundingClientRect().top - 5 >= document.querySelector('.topbar').getBoundingClientRect().bottom`), 'true',
      'the source focus outline is fully visible below the fixed app header');
    await screenshot(command, 'source-settings-focus-en.png');
    await command('reload');
    await waitFor(command, `document.activeElement.id === 'source-opencode'`);
    assert.equal(await command('eval', `document.querySelector('#source-heading-opencode').getBoundingClientRect().top >= document.querySelector('.topbar').getBoundingClientRect().bottom`), 'true',
      'reloading a source deep link keeps its heading visible');
    await command('eval', `(() => { const select = document.querySelector('.language-select'); select.value = 'zh'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(command, `document.querySelector('#source-opencode')?.textContent.includes('重启 Viewer')`);
    await screenshot(command, 'source-settings-focus-zh.png');
    t.diagnostic(`Chinese language switch geometry: ${await command('eval', `({ articleTop: document.querySelector('#source-opencode').getBoundingClientRect().top, headingTop: document.querySelector('#source-heading-opencode').getBoundingClientRect().top, headerBottom: document.querySelector('.topbar').getBoundingClientRect().bottom, focus: document.activeElement.id })`)}`);
    await command('reload');
    await waitFor(command, `document.activeElement.id === 'source-opencode' && document.querySelector('#source-opencode')?.textContent.includes('重启 Viewer')`);
    assert.equal(await command('eval', `document.querySelector('#source-opencode').getBoundingClientRect().top - 5 >= document.querySelector('.topbar').getBoundingClientRect().bottom`), 'true',
      'a Chinese source deep link also reveals its complete focus outline');
    await screenshot(command, 'source-settings-focus-zh-reload.png');
    t.diagnostic(`Chinese deep-link reload geometry: ${await command('eval', `({ articleTop: document.querySelector('#source-opencode').getBoundingClientRect().top, headingTop: document.querySelector('#source-heading-opencode').getBoundingClientRect().top, headerBottom: document.querySelector('.topbar').getBoundingClientRect().bottom, focus: document.activeElement.id })`)}`);
    await command('eval', 'history.back()');
    await waitFor(command, `document.querySelector('[data-library-provider]')?.value === 'opencode'`);
  });
