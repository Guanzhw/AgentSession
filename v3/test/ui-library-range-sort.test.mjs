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
const browserName = process.platform === 'win32'
  ? 'agent-browser-win32-x64.exe' : `agent-browser-${process.platform}-${process.arch}`;
const browserExe = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
  (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', browserName))
    .find(existsSync);
const skip = !existsSync(path.join(uiDir, 'node_modules', 'vite'))
  ? 'Install the locked v3 UI dependencies.'
  : !browserExe || !existsSync(browserExe) ? 'agent-browser is required for browser QA.' : false;

const provider = 'codex';
const rangeValues = ['', 'today', 'week', 'month'];
const sortValues = ['updated-desc', 'updated-asc', 'title-asc', 'title-desc'];
const day = 24 * 60 * 60 * 1000;
const now = Date.now();
const todayStart = new Date(now);
todayStart.setHours(0, 0, 0, 0);
const timestamps = {
  today: Math.min(now - 1_000, todayStart.getTime() + 60_000),
  week: now - 3 * day,
  month: now - 14 * day,
  older: now - 45 * day,
};

function summary(sessionId, title, updatedAt, parent = null) {
  return { session: { provider, sessionId }, title, directory: '/workspace/range-sort',
    createdAt: updatedAt, updatedAt, messageCount: 2, tokenCount: 10, parent };
}

const rootSummaries = [
  summary('range-zulu-today', 'Zulu today', timestamps.today),
  summary('range-mango-week', 'Mango week', timestamps.week),
  summary('range-alpha-month', 'Alpha month', timestamps.month),
  summary('range-bravo-older', 'Bravo older', timestamps.older),
];
const childSummaries = [
  summary('child-zulu-today', 'Zulu child today', timestamps.today,
    { provider, sessionId: 'range-zulu-today' }),
  summary('child-mango-week', 'Mango child week', timestamps.week,
    { provider, sessionId: 'range-zulu-today' }),
  summary('child-alpha-month', 'Alpha child month', timestamps.month,
    { provider, sessionId: 'range-zulu-today' }),
  summary('child-bravo-older', 'Bravo child older', timestamps.older,
    { provider, sessionId: 'range-zulu-today' }),
];

function node(session, { childCount = 0, familyUpdated = session.updatedAt } = {}) {
  return { session, matched: true, matchingCount: 1, childCount, totalChildCount: childCount,
    familyRootId: session.parent?.sessionId || session.session.sessionId,
    familyUpdated, parentBoundary: null };
}

const providers = [
  { id: 'codex', available: true },
  { id: 'claude-code', available: false },
  { id: 'opencode', available: false },
  { id: 'pi', available: false },
  { id: 'deepseek-harness', available: false },
];
const rangeRootId = 'range-zulu-today';
const rootById = new Map(rootSummaries.map(row => [row.session.sessionId, row]));

function inRange(summaryRow, range) {
  const updatedAt = summaryRow.updatedAt;
  if (range === 'today') return updatedAt >= todayStart.getTime();
  if (range === 'week') return updatedAt >= now - 7 * day;
  if (range === 'month') return updatedAt >= now - 30 * day;
  return true;
}

function order(rows, sort = 'updated-desc') {
  return [...rows].sort((left, right) => {
    if (sort === 'title-asc') return left.title.localeCompare(right.title);
    if (sort === 'title-desc') return right.title.localeCompare(left.title);
    if (sort === 'updated-asc') return left.updatedAt - right.updatedAt;
    return right.updatedAt - left.updatedAt;
  });
}

function rootNode(summaryRow, range) {
  const matchingChildren = summaryRow.session.sessionId === rangeRootId
    ? childSummaries.filter(child => inRange(child, range)).length : 0;
  return node(summaryRow, { childCount: matchingChildren,
    familyUpdated: summaryRow.updatedAt });
}

async function freePort() {
  return freeFetchSafePort();
}

async function harness(t) {
  const { build } = createRequire(path.join(uiDir, 'package.json'))('vite');
  const buildDir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-ui-library-range-sort-'));
  await build({ root: uiDir, configFile: path.join(uiDir, 'vite.config.ts'),
    build: { outDir: buildDir, emptyOutDir: true }, logLevel: 'error' });

  const libraryRequests = [];
  const childRequests = [];
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    const json = (body, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };

    if (url.pathname === '/api/providers') return json(providers);
    if (url.pathname === '/api/v3/library/sessions') {
      const filters = Object.fromEntries(url.searchParams);
      libraryRequests.push(filters);
      const families = order(rootSummaries.filter(row => inRange(row, filters.range)), filters.sort)
        .map(row => rootNode(row, filters.range));
      return json({ families, total: families.length,
        matchingSessions: families.length + childSummaries.filter(row => inRange(row, filters.range)).length,
        sourceDiagnostics: [], nextCursor: null });
    }
    if (url.pathname === '/api/v3/library/children') {
      const filters = Object.fromEntries(url.searchParams);
      childRequests.push(filters);
      const children = filters.parentId === rangeRootId
        ? order(childSummaries.filter(row => inRange(row, filters.range)), filters.sort).map(row => node(row))
        : [];
      return json({ parent: rootNode(rootById.get(filters.parentId), filters.range),
        children, total: children.length, nextCursor: null });
    }
    const reader = url.pathname.match(/^\/api\/v3\/reader\/([^/]+)\/([^/]+)\/bootstrap$/);
    if (reader) {
      const sessionId = decodeURIComponent(reader[2]);
      const session = [...rootSummaries, ...childSummaries]
        .find(row => row.session.sessionId === sessionId);
      if (!session || reader[1] !== provider) return json({ error: { code: 'not_found' } }, 404);
      return json({ session, revision: 'range-sort-reader', totalItems: 0, segments: [],
        toc: { entries: [], previousCursor: null, nextCursor: null }, relations: null });
    }
    if (url.pathname.startsWith('/api/v3/runtime/')) return json({
      session: { provider, sessionId: 'range-zulu-today' }, revision: 'range-sort-reader',
      coverage: 'partial', events: [], nextCursor: null, scannedEvents: 0,
    });
    if (url.pathname.startsWith('/api/v3/meta/')) return json(null);
    if (url.pathname.startsWith('/api/v3/resume/')) return json({
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
  const port = await freePort();
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(buildDir, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${port}`, libraryRequests, childRequests };
}

async function browser(t, url) {
  const session = `agentsession-v3-library-range-sort-${process.pid}-${Date.now()}`;
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

async function waitForRequest(requests, start, predicate, description) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (requests.slice(start).some(predicate)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}; observed ${JSON.stringify(requests.slice(start))}`);
}

function pathsFor(ids) {
  return ids.map(id => `/${provider}/session/${id}`);
}

async function waitForPaths(command, selector, expected) {
  const expectedJson = JSON.stringify(expected);
  await waitFor(command, `JSON.stringify([...document.querySelectorAll(${JSON.stringify(selector)})]
    .map(row => row.getAttribute('href'))) === ${JSON.stringify(expectedJson)}`);
}

function filtersMatch(request, range, sort) {
  return (request.range ?? '') === range && (request.sort || 'updated-desc') === sort;
}

async function selectControl(command, requiredValues, value) {
  const actual = await command('eval', `(() => {
    const required = ${JSON.stringify(requiredValues)};
    const select = [...document.querySelectorAll('select')].find(control =>
      required.every(value => [...control.options].some(option => option.value === value)));
    if (!select) return 'missing';
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
  assert.equal(JSON.parse(actual), value, `select the Library control value ${JSON.stringify(value)}`);
}

async function ensureChildRequest(command, app, start, range, sort) {
  const matches = request => filtersMatch(request, range, sort);
  if (!app.childRequests.slice(start).some(matches)) {
    const toggle = `button[data-family-toggle="${provider}/${rangeRootId}"]`;
    const state = JSON.parse(await command('eval',
      `document.querySelector(${JSON.stringify(toggle)})?.getAttribute('aria-expanded') || 'missing'`));
    assert.notEqual(state, 'missing', 'the varied parent family remains visible and expandable');
    if (state === 'true') {
      await command('click', toggle);
      await waitFor(command,
        `document.querySelector(${JSON.stringify(toggle)})?.getAttribute('aria-expanded') === 'false'`);
    }
    await command('click', toggle);
  }
  await waitForRequest(app.childRequests, start, matches,
    `a /children request with range=${JSON.stringify(range)} and sort=${sort}`);
}

test('Library range and sort filters update root and child pages and survive Reader Back and reload',
  { skip, timeout: 120_000 }, async t => {
    const app = await harness(t);
    const command = await browser(t, `${app.origin}/sessions`);
    await waitFor(command, `document.querySelector('.session-table')`);
    await command('eval', `(() => {
      const select = document.querySelector('.language-select');
      if (select && select.value !== 'en') {
        select.value = 'en';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
    await waitFor(command, `document.querySelector('.language-select')?.value === 'en'`);

    const controls = JSON.parse(await command('eval', `(() => {
      const find = required => [...document.querySelectorAll('select')].find(control =>
        required.every(value => [...control.options].some(option => option.value === value)));
      const describe = control => control ? [...control.options].map(option => ({
        value: option.value, label: option.textContent.trim(),
      })) : null;
      return {
        range: describe(find(${JSON.stringify(rangeValues)})),
        sort: describe(find(${JSON.stringify(sortValues)})),
      };
    })()`));

    assert.deepEqual(controls.range, [
      { value: '', label: 'All' },
      { value: 'today', label: 'Today' },
      { value: 'week', label: 'This Week' },
      { value: 'month', label: 'This Month' },
    ], 'Library exposes the 2.0 time-range choices');
    assert.deepEqual(controls.sort, [
      { value: 'updated-desc', label: 'Newest updated' },
      { value: 'updated-asc', label: 'Oldest updated' },
      { value: 'title-asc', label: 'Title A-Z' },
      { value: 'title-desc', label: 'Title Z-A' },
    ], 'Library exposes the 2.0 sort choices');

    const rootOrders = {
      '': ['range-zulu-today', 'range-mango-week', 'range-alpha-month', 'range-bravo-older'],
      today: ['range-zulu-today'],
      week: ['range-zulu-today', 'range-mango-week'],
      month: ['range-zulu-today', 'range-mango-week', 'range-alpha-month'],
    };
    const childOrders = {
      '': ['child-zulu-today', 'child-mango-week', 'child-alpha-month', 'child-bravo-older'],
      today: ['child-zulu-today'],
      week: ['child-zulu-today', 'child-mango-week'],
      month: ['child-zulu-today', 'child-mango-week', 'child-alpha-month'],
    };

    for (const range of ['today', 'week', 'month', '']) {
      const libraryStart = app.libraryRequests.length;
      const childrenStart = app.childRequests.length;
      await selectControl(command, rangeValues, range);
      await waitForPaths(command, '.session-row', pathsFor(rootOrders[range]));
      await waitForRequest(app.libraryRequests, libraryStart,
        request => (request.range ?? '') === range,
        `a /sessions request with range=${JSON.stringify(range)}`);
      await ensureChildRequest(command, app, childrenStart, range, 'updated-desc');
      await waitForPaths(command, '.family-child-row', pathsFor(childOrders[range]));
      assert.equal(JSON.parse(await command('eval',
        `document.querySelectorAll('.family-children .search-error').length`)), 0,
      'a successful child page does not display a load failure');
      const rootRequest = app.libraryRequests.slice(libraryStart).find(request => (request.range ?? '') === range);
      const childRequest = app.childRequests.slice(childrenStart).find(request => filtersMatch(request, range, 'updated-desc'));
      assert.ok(rootRequest, `range ${JSON.stringify(range)} reached /api/v3/library/sessions`);
      assert.ok(childRequest, `range ${JSON.stringify(range)} reached /api/v3/library/children`);
    }

    const sortOrders = {
      'updated-asc': ['range-bravo-older', 'range-alpha-month', 'range-mango-week', 'range-zulu-today'],
      'title-asc': ['range-alpha-month', 'range-bravo-older', 'range-mango-week', 'range-zulu-today'],
      'title-desc': ['range-zulu-today', 'range-mango-week', 'range-bravo-older', 'range-alpha-month'],
      'updated-desc': ['range-zulu-today', 'range-mango-week', 'range-alpha-month', 'range-bravo-older'],
    };
    const childSortOrders = {
      'updated-asc': ['child-bravo-older', 'child-alpha-month', 'child-mango-week', 'child-zulu-today'],
      'title-asc': ['child-alpha-month', 'child-bravo-older', 'child-mango-week', 'child-zulu-today'],
      'title-desc': ['child-zulu-today', 'child-mango-week', 'child-bravo-older', 'child-alpha-month'],
      'updated-desc': ['child-zulu-today', 'child-mango-week', 'child-alpha-month', 'child-bravo-older'],
    };

    for (const sort of ['updated-asc', 'title-asc', 'title-desc', 'updated-desc']) {
      const libraryStart = app.libraryRequests.length;
      const childrenStart = app.childRequests.length;
      await selectControl(command, sortValues, sort);
      await waitForPaths(command, '.session-row', pathsFor(sortOrders[sort]));
      await waitForRequest(app.libraryRequests, libraryStart,
        request => request.sort === sort && (request.range ?? '') === '',
        `a /sessions request with sort=${sort}`);
      await ensureChildRequest(command, app, childrenStart, '', sort);
      await waitForPaths(command, '.family-child-row', pathsFor(childSortOrders[sort]));
      assert.ok(app.libraryRequests.slice(libraryStart)
        .some(request => request.sort === sort && (request.range ?? '') === ''),
      `sort ${sort} reached /api/v3/library/sessions`);
      assert.ok(app.childRequests.slice(childrenStart)
        .some(request => request.sort === sort && (request.range ?? '') === ''),
      `sort ${sort} reached /api/v3/library/children`);
    }

    await selectControl(command, rangeValues, 'week');
    await waitForPaths(command, '.session-row', pathsFor(['range-zulu-today', 'range-mango-week']));
    const finalChildrenStart = app.childRequests.length;
    await selectControl(command, sortValues, 'title-asc');
    await waitForPaths(command, '.session-row', pathsFor(['range-mango-week', 'range-zulu-today']));
    await waitForRequest(app.childRequests, finalChildrenStart,
      request => request.range === 'week' && request.sort === 'title-asc',
      'the combined range and sort state reached /children');
    await waitForPaths(command, '.family-child-row',
      pathsFor(['child-mango-week', 'child-zulu-today']));

    await command('eval', `(() => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, 420); })()`);
    await waitFor(command, 'window.scrollY === 420');
    await command('eval', `document.querySelector('a[href="/codex/session/range-mango-week"]').click()`);
    await waitFor(command, `document.querySelector('#reader-title')?.textContent.trim() === 'Mango week'`);
    await command('back');
    await waitForPaths(command, '.session-row', pathsFor(['range-mango-week', 'range-zulu-today']));
    await waitFor(command, `Math.abs(window.scrollY - 420) <= 10`);
    assert.equal(JSON.parse(await command('eval', `(() => {
      const required = ${JSON.stringify(rangeValues)};
      return [...document.querySelectorAll('select')].find(control =>
        required.every(value => [...control.options].some(option => option.value === value)))?.value;
    })()`)), 'week', 'Reader Back restores the selected time range');
    assert.equal(JSON.parse(await command('eval', `(() => {
      const required = ${JSON.stringify(sortValues)};
      return [...document.querySelectorAll('select')].find(control =>
        required.every(value => [...control.options].some(option => option.value === value)))?.value;
    })()`)), 'title-asc', 'Reader Back restores the selected sort order');

    const reloadChildrenStart = app.childRequests.length;
    await command('reload');
    await waitForPaths(command, '.session-row', pathsFor(['range-mango-week', 'range-zulu-today']));
    await waitForRequest(app.childRequests, reloadChildrenStart,
      request => request.range === 'week' && request.sort === 'title-asc',
      'reload restores the range and sort on /children');
    await waitForPaths(command, '.family-child-row',
      pathsFor(['child-mango-week', 'child-zulu-today']));
    assert.equal(JSON.parse(await command('eval', `(() => {
      const required = ${JSON.stringify(rangeValues)};
      return [...document.querySelectorAll('select')].find(control =>
        required.every(value => [...control.options].some(option => option.value === value)))?.value;
    })()`)), 'week', 'Library reload restores the selected time range');
    assert.equal(JSON.parse(await command('eval', `(() => {
      const required = ${JSON.stringify(sortValues)};
      return [...document.querySelectorAll('select')].find(control =>
        required.every(value => [...control.options].some(option => option.value === value)))?.value;
    })()`)), 'title-asc', 'Library reload restores the selected sort order');
  });
