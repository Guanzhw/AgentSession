import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const uiDir = path.join(repo, 'v3', 'ui');
const ids = ['search-one', 'search-two'];
const browserName = process.platform === 'win32'
  ? 'agent-browser-win32-x64.exe' : `agent-browser-${process.platform}-${process.arch}`;
const browserExe = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
  (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', browserName))
    .find(existsSync);
const skip = !existsSync(path.join(uiDir, 'node_modules', 'vite'))
  ? 'Install the locked v3 UI dependencies.'
  : !browserExe || !existsSync(browserExe) ? 'agent-browser is required for browser QA.' : false;

function summary(sessionId) {
  return { session: { provider: 'codex', sessionId }, title: `Unrelated ${sessionId}`,
    directory: '/fixture', createdAt: 1, updatedAt: 1, messageCount: 1,
    tokenCount: null, parent: null };
}

function reference(sessionId) {
  return { provider: 'codex', sessionId, messageId: `late-${sessionId}`, segment: 'message' };
}

function bootstrap(sessionId) {
  const event = reference(sessionId);
  const item = { event, ordinal: 0, owner: null, role: 'assistant', timestamp: null,
    preview: `A recorded finding in ${sessionId}`, totalChars: 31,
    toolName: null, ownerMessageId: null, replyMetadata: null };
  const toc = { entries: [{ event, ordinal: 0, owner: null, label: item.preview }],
    previousCursor: null, nextCursor: null };
  return { session: summary(sessionId), revision: `revision-${sessionId}`, totalItems: 1,
    segments: [{ id: 'segment-0', pageId: 'page-0', startOrdinal: 0,
      items: [item], ownerContext: null, previousCursor: null, nextCursor: null }],
    toc, relations: { taskCount: 0, observationCount: 0, firstCursor: null } };
}

async function freePort() {
  return freeFetchSafePort();
}

async function harness(t, multipleProviders = false) {
  const { build } = createRequire(path.join(uiDir, 'package.json'))('vite');
  const buildDir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-ui-search-'));
  await build({ root: uiDir, configFile: path.join(uiDir, 'vite.config.ts'),
    build: { outDir: buildDir, emptyOutDir: true }, logLevel: 'error' });
  const searches = [];
  const fixtureIds = multipleProviders ? ['search-one', 'pi-one', 'claude-one', 'search-two'] : ids;
  const providerFor = sessionId => sessionId === 'pi-one' ? 'pi'
    : sessionId === 'claude-one' ? 'claude-code' : 'codex';
  const state = { deleted: new Set(), permanent: new Set(), titles: new Map(), searchRevision: 0,
    delayCursorSearches: false, delayNextFreshSearch: false, completedSearches: 0,
    failNextSearch: false,
    partialSearchCoverage: false, partialFamilyCoverage: false, familySourceDiagnostics: null };
  let nextSearchHold = null;
  const pendingSearchHolds = new Set();
  function holdNextSearch() {
    assert.equal(nextSearchHold, null, 'The previous search hold must have entered its request');
    let entered;
    let finish;
    const started = new Promise(resolve => { entered = resolve; });
    const waiting = new Promise(resolve => { finish = resolve; });
    const hold = { started, waiting, entered, release() {
      finish();
      pendingSearchHolds.delete(hold);
    } };
    nextSearchHold = hold;
    pendingSearchHolds.add(hold);
    return hold;
  }
  const currentTitle = sessionId => state.titles.get(sessionId) || summary(sessionId).title;
  const currentSummary = sessionId => ({ ...summary(sessionId), title: currentTitle(sessionId) });
  const currentMeta = sessionId => ({ provider: 'codex', sessionId,
    customTitle: state.titles.get(sessionId) || null, starred: false,
    deleted: state.deleted.has(sessionId), permanent: state.permanent.has(sessionId),
    timeStarred: null, timeDeleted: null, timeRenamed: null });
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    const json = (body, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/providers') return json((multipleProviders ? ['codex', 'pi', 'claude-code'] : ['codex'])
      .map(id => ({ id, available: true })));
    if (url.pathname === '/api/v3/sessions') return json(ids
      .filter(sessionId => !state.deleted.has(sessionId) && !state.permanent.has(sessionId)).map(currentSummary));
    if (url.pathname === '/api/v3/library/sessions') {
      const search = (url.searchParams.get('search') || '').toLowerCase();
      const rows = (state.partialFamilyCoverage ? [] : ids)
        .filter(sessionId => !state.deleted.has(sessionId) && !state.permanent.has(sessionId))
        .map(currentSummary).filter(session => !search || [session.title, session.session.sessionId,
          session.directory || '', session.session.provider].some(value => value.toLowerCase().includes(search)));
      return json({ families: rows.map(session => ({ session, matched: true, matchingCount: 1,
        childCount: 0, totalChildCount: 0, familyRootId: session.session.sessionId,
        familyUpdated: session.updatedAt, parentBoundary: null })), total: rows.length,
        matchingSessions: rows.length, sourceDiagnostics: state.partialFamilyCoverage
          ? state.familySourceDiagnostics ?? [{ provider: 'codex', message: 'Codex source identity is unreadable in one or more files; session history is unavailable.' }]
          : [], nextCursor: null });
    }
    if (url.pathname === '/api/v3/trash') return json([...state.deleted]
      .filter(sessionId => providerFor(sessionId) === url.searchParams.get('provider'))
      .filter(sessionId => !state.permanent.has(sessionId)).map(currentMeta));
    if (url.pathname === '/api/v3/search') {
      searches.push(Object.fromEntries(url.searchParams));
      if (process.env.AGENTSESSION_V3_CONTENT_SEARCH_LOG) appendFileSync(process.env.AGENTSESSION_V3_CONTENT_SEARCH_LOG,
        JSON.stringify({ kind: 'content-search-request', number: searches.length,
          query: searches.at(-1), timestamp: Date.now() }) + '\n');
      const cursor = url.searchParams.get('cursor');
      if (nextSearchHold) {
        const hold = nextSearchHold;
        nextSearchHold = null;
        hold.entered();
        await hold.waiting;
      }
      if (cursor && state.delayCursorSearches) await new Promise(resolve => setTimeout(resolve, 4_000));
      if (!cursor && state.delayNextFreshSearch) {
        state.delayNextFreshSearch = false;
        await new Promise(resolve => setTimeout(resolve, 1_500));
      }
      if (state.failNextSearch) {
        state.failNextSearch = false;
        state.completedSearches++;
        return json({ error: { code: 'source_error', message: 'The search could not finish.' } }, 503);
      }
      const cursorOffset = cursor === `page-two-${state.searchRevision}` ? 1
        : cursor?.match(new RegExp(`^page-(\\d+)-${state.searchRevision}$`))?.[1];
      if (cursor && cursorOffset === undefined) {
        state.completedSearches++;
        return json({ error: { code: 'source_changed' } }, 409);
      }
      const query = (url.searchParams.get('q') || '').toLocaleLowerCase();
      const selectedProviders = url.searchParams.get('provider')?.split(',');
      const matches = state.partialSearchCoverage ? [] : fixtureIds.filter(sessionId => !state.deleted.has(sessionId)
        && (!selectedProviders || selectedProviders.includes(providerFor(sessionId)))).flatMap(sessionId => {
        const title = currentTitle(sessionId);
        const snippet = `The recorded term appears in ${sessionId}`;
        const titleMatch = title.toLocaleLowerCase().includes(query);
        if (!titleMatch && !snippet.toLocaleLowerCase().includes(query)) return [];
        return [{ session: { provider: providerFor(sessionId), sessionId },
          event: { ...reference(sessionId), provider: providerFor(sessionId) },
          matchField: titleMatch ? 'title' : 'message', matchRole: titleMatch ? null : 'assistant',
          snippet: titleMatch ? title : snippet, title, directory: '/fixture', updatedAt: 1,
          untrustedContent: true }];
      });
      const offset = cursor ? Number(cursorOffset) : 0;
      const page = matches.slice(offset, offset + 1);
      state.completedSearches++;
      return json({ matches: page, diagnostics: state.partialSearchCoverage
        ? [{ provider: 'codex', status: 'partial', sourceDiagnostics: [
          { code: 'codex_multiple_source_files_unmerged', affectedSessions: 2 },
        ] }]
        : [{ provider: 'codex', status: 'ok' }],
        nextCursor: offset + 1 < matches.length
          ? offset === 0 ? `page-two-${state.searchRevision}` : `page-${offset + 1}-${state.searchRevision}` : null,
        truncated: offset + 1 < matches.length, untrustedContent: true });
    }
    const meta = url.pathname.match(/^\/api\/v3\/meta\/codex\/(search-one|search-two)$/);
    if (meta) return json(currentMeta(meta[1]));
    const mutation = url.pathname.match(/^\/api\/codex\/session\/(search-one|search-two)\/(rename|delete|restore|permanent-delete)$/);
    if (request.method === 'POST' && mutation) {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body || '{}');
      if (mutation[2] === 'delete') state.deleted.add(mutation[1]);
      else if (mutation[2] === 'restore') state.deleted.delete(mutation[1]);
      else if (mutation[2] === 'permanent-delete') {
        state.deleted.add(mutation[1]);
        state.permanent.add(mutation[1]);
      } else state.titles.set(mutation[1], payload.title);
      state.searchRevision++;
      return json(currentMeta(mutation[1]));
    }
    const reader = url.pathname.match(/^\/api\/v3\/reader\/codex\/(search-one|search-two)\/(bootstrap|locate|toc)$/);
    if (reader) {
      const [, sessionId, kind] = reader;
      const data = bootstrap(sessionId);
      data.session.title = currentTitle(sessionId);
      if (kind === 'bootstrap') return json(data);
      if (kind === 'toc') return json({ session: data.session.session,
        revision: data.revision, toc: data.toc });
      return json({ session: data.session.session, revision: data.revision,
        event: reference(sessionId), ordinal: 0, owner: null,
        pageCursor: 'first', tocCursor: 'first' });
    }
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
    response.end(readFileSync(asset));
  });
  const port = await freePort();
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  t.after(async () => {
    for (const hold of pendingSearchHolds) hold.release();
    await new Promise(resolve => server.close(resolve));
    await rm(buildDir, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${port}`, searches, state, holdNextSearch };
}

async function browser(t, url) {
  const session = `agentsession-v3-search-${process.pid}-${Date.now()}`;
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
      if (process.env.AGENTSESSION_V3_CONTENT_SEARCH_LOG) appendFileSync(process.env.AGENTSESSION_V3_CONTENT_SEARCH_LOG,
        JSON.stringify({ session, args, code, stdout, stderr }) + '\n');
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout));
    });
  });
  t.after(async () => { try { await command('close'); } catch { /* Browser already closed. */ } });
  await command('open', url);
  await command('set', 'viewport', '1440', '900');
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

async function waitForSearchCount(app, count) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (app.searches.length >= count) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} search requests`);
}

async function waitForCompletedSearchCount(app, count) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (app.state.completedSearches >= count) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} completed search requests`);
}

test('content search distinguishes first-page waiting from completed results and an empty search',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t);
    const command = await browser(t, `${app.origin}/sessions`);
    await waitFor(command, `document.querySelector('.session-table')`);
    await command('click', '[data-search-mode="content"]');
    await command('fill', 'input[type="search"]', 'recorded term');
    const firstSearch = app.holdNextSearch();
    await command('click', '.search-submit');
    await firstSearch.started;
    await waitFor(command, `document.querySelector('.search-loading[role="status"]')`);
    assert.match(await command('get', 'text', '.search-loading'), /Searching recorded content/);
    assert.equal(await command('eval', `document.querySelector('.search-results')?.getAttribute('aria-busy')`), '"true"');
    assert.equal(await command('eval', `Boolean(document.querySelector('.compact-empty'))`), 'false');
    firstSearch.release();
    await waitFor(command, `document.querySelectorAll('.search-result').length === 1 && !document.querySelector('.search-loading')`);
    assert.equal(await command('eval', `document.querySelector('.search-results')?.getAttribute('aria-busy')`), '"false"');

    await command('select', '.language-select', 'zh');
    await command('fill', 'input[type="search"]', 'absent recorded phrase');
    const emptySearch = app.holdNextSearch();
    await command('click', '.search-submit');
    await emptySearch.started;
    await waitFor(command, `document.querySelector('.search-loading[role="status"]')`);
    assert.match(await command('get', 'text', '.search-loading'), /正在搜索已记录内容/);
    assert.equal(await command('eval', `Boolean(document.querySelector('.compact-empty'))`), 'false');
    emptySearch.release();
    await waitFor(command, `document.querySelector('.compact-empty h2')?.textContent === '没有匹配结果'`);
    assert.equal(await command('eval', `Boolean(document.querySelector('.search-loading'))`), 'false');
    assert.equal(await command('eval', `Boolean(document.querySelector('[aria-busy="true"]'))`), 'false');
    assert.equal(await command('eval', `Boolean(document.querySelector('.search-error'))`), 'false');
  });

test('content search preserves already loaded results during paginated waiting',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t);
    const command = await browser(t, `${app.origin}/sessions/search?q=recorded+term`);
    await waitFor(command, `document.querySelectorAll('.search-result').length === 1`);
    const firstHref = await command('eval', `document.querySelector('.search-result a')?.getAttribute('href')`);
    const nextPage = app.holdNextSearch();
    await command('click', '.search-more');
    await nextPage.started;
    await waitFor(command, `document.querySelector('.search-loading[role="status"]')`);
    assert.equal(await command('eval', `document.querySelectorAll('.search-result').length`), '1');
    assert.equal(await command('eval', `document.querySelector('.search-result a')?.getAttribute('href')`), firstHref);
    assert.equal(await command('eval', `document.querySelector('.search-results')?.getAttribute('aria-busy')`), '"true"');
    assert.equal(await command('eval', `document.querySelector('.search-more')?.disabled`), 'true');
    nextPage.release();
    await waitFor(command, `document.querySelectorAll('.search-result').length === 2 && !document.querySelector('.search-loading')`);
    assert.equal(await command('eval', `document.querySelector('.search-results')?.getAttribute('aria-busy')`), '"false"');
    assert.equal(app.searches[1].cursor, 'page-two-0');
  });

test('content search failure clears waiting without claiming no matches and can retry',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t);
    const command = await browser(t, `${app.origin}/sessions`);
    await waitFor(command, `document.querySelector('.session-table')`);
    await command('click', '[data-search-mode="content"]');
    await command('fill', 'input[type="search"]', 'recorded term');
    const failedSearch = app.holdNextSearch();
    app.state.failNextSearch = true;
    await command('click', '.search-submit');
    await failedSearch.started;
    await waitFor(command, `document.querySelector('.search-loading[role="status"]')`);
    failedSearch.release();
    await waitFor(command, `document.querySelector('.search-error') && !document.querySelector('.search-loading')`);
    assert.match(await command('get', 'text', '.search-error'), /The search could not finish/);
    assert.equal(await command('eval', `Boolean(document.querySelector('.compact-empty'))`), 'false');
    assert.equal(await command('eval', `Boolean(document.querySelector('[aria-busy="true"]'))`), 'false');
    assert.equal(await command('eval', `document.querySelector('.search-submit')?.disabled`), 'false');
    await command('click', '.search-submit');
    await waitFor(command, `document.querySelectorAll('.search-result').length === 1 && !document.querySelector('.search-error')`);
    assert.equal(app.searches[1].q, 'recorded term');

    const firstHref = await command('eval', `document.querySelector('.search-result a')?.getAttribute('href')`);
    const failedNextPage = app.holdNextSearch();
    app.state.failNextSearch = true;
    await command('click', '.search-more');
    await failedNextPage.started;
    await waitFor(command, `document.querySelector('.search-loading[role="status"]')`);
    assert.equal(await command('eval', `document.querySelectorAll('.search-result').length`), '1');
    assert.equal(await command('eval', `document.querySelector('.search-result a')?.getAttribute('href')`), firstHref);
    failedNextPage.release();
    await waitFor(command, `document.querySelector('.search-error') && !document.querySelector('.search-loading')`);
    assert.equal(await command('eval', `document.querySelectorAll('.search-result').length`), '1');
    assert.equal(await command('eval', `document.querySelector('.search-result a')?.getAttribute('href')`), firstHref);
    assert.equal(await command('eval', `document.querySelector('.search-results')?.getAttribute('aria-busy')`), '"false"');
    assert.equal(await command('eval', `Boolean(document.querySelector('.compact-empty'))`), 'false');
  });

test('public content-search URLs preserve repeated provider scopes, paging, reload and Reader Back',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t, true);
    const command = await browser(t, `${app.origin}/sessions/search?q=recorded+term&provider=codex,pi&provider=codex`);
    await waitFor(command, `document.querySelector('[data-search-mode="content"][aria-pressed="true"]')`);
    await waitFor(command, `document.querySelectorAll('.search-result').length === 1`);
    assert.equal(await command('get', 'value', 'input[type="search"]'), 'recorded term');
    assert.equal(app.searches[0].provider, 'codex,pi');
    assert.equal(app.searches[0].limit, '20');
    assert.equal(app.searches[0].offset, undefined);
    assert.equal(await command('get', 'value', '[data-content-provider]'), 'codex,pi');
    assert.match(await command('get', 'text', '[data-content-provider] option:checked'), /Codex.*Pi/);
    await command('click', '.search-more');
    await waitFor(command, `document.querySelectorAll('.search-result').length === 2`);
    assert.equal(app.searches[1].provider, 'codex,pi');
    assert.equal(app.searches[1].cursor, 'page-two-0');
    assert.match(await command('get', 'text', '.search-result:last-child'), /pi-one/);
    assert.doesNotMatch(await command('get', 'text', '.search-results'), /claude-one/);
    await command('click', '.search-more');
    await waitFor(command, `document.querySelectorAll('.search-result').length === 3 && !document.querySelector('.search-more')`);
    assert.equal(app.searches[2].provider, 'codex,pi');
    assert.equal(app.searches[2].cursor, 'page-2-0');
    assert.match(await command('get', 'text', '.search-result:last-child'), /search-two/);
    await command('click', '.search-result:first-child a');
    await waitFor(command, `document.querySelector('.reader-layout')`);
    await command('reload');
    await waitFor(command, `document.querySelector('.reader-layout')`);
    await command('back');
    await waitFor(command, `document.querySelectorAll('.search-result').length === 3 &&
      document.activeElement?.getAttribute('href')?.includes('search-one')`);
    assert.equal(await command('get', 'value', '[data-content-provider]'), 'codex,pi');
    assert.equal(await command('get', 'value', 'input[type="search"]'), 'recorded term');
    assert.equal(app.searches.length, 6);
    assert.deepEqual(app.searches.slice(3).map(row => row.provider), ['codex,pi', 'codex,pi', 'codex,pi']);
    await command('reload');
    await waitFor(command, `document.querySelector('.search-result')`);
    assert.equal(app.searches.at(-1).q, 'recorded term');
    assert.equal(app.searches.at(-1).provider, 'codex,pi');
    await command('select', '[data-content-provider]', 'pi');
    await waitFor(command, `document.querySelectorAll('.search-result').length === 1 &&
      document.querySelector('.search-result')?.textContent.includes('pi-one')`);
    assert.equal(app.searches.at(-1).provider, 'pi');
    assert.equal(app.searches.at(-1).cursor, undefined, 'scope changes start a fresh search');
  });

test('provider content-search path overrides query scopes and an empty URL opens content mode',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t, true);
    const command = await browser(t, `${app.origin}/codex/search?q=recorded+term&provider=pi`);
    await waitFor(command, `document.querySelector('.search-result')`);
    assert.equal(app.searches[0].provider, 'codex');
    assert.equal(await command('get', 'value', '[data-content-provider]'), 'codex');
    await command('click', '.search-more');
    await waitFor(command, `document.querySelectorAll('.search-result').length === 2`);
    assert.equal(app.searches[1].provider, 'codex');
    assert.match(await command('get', 'text', '.search-result:last-child'), /search-two/);
    await command('open', `${app.origin}/pi/search`);
    await waitFor(command, `document.querySelector('[data-search-mode="content"][aria-pressed="true"]')`);
    assert.equal(await command('get', 'value', 'input[type="search"]'), '');
    assert.equal(await command('get', 'value', '[data-content-provider]'), 'pi');
    assert.equal(app.searches.length, 2, 'an empty deep link does not submit a query');
    await command('fill', 'input[type="search"]', 'recorded term');
    await command('click', '.search-submit');
    await waitFor(command, `document.querySelector('.search-result')?.textContent.includes('pi-one')`);
    assert.equal(app.searches.at(-1).provider, 'pi');
  });

test('legacy content-search offsets explicitly migrate to cursor paging and reject invalid offsets',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t);
    const command = await browser(t, `${app.origin}/sessions/search?q=recorded+term&offset=30`);
    await waitFor(command, `document.querySelector('.search-result')`);
    assert.match(await command('get', 'text', '[data-search-offset-notice]'), /first result.*Load more/);
    assert.equal(app.searches[0].offset, undefined);
    assert.equal(app.searches[0].cursor, undefined);
    await command('select', '.language-select', 'zh');
    assert.match(await command('get', 'text', '[data-search-offset-notice]'), /首个结果.*加载更多/);
    for (const offset of ['-1', 'abc', '100001']) {
      await command('open', `${app.origin}/sessions/search?q=recorded+term&offset=${offset}`);
      await waitFor(command, `document.querySelector('[data-search-offset-error]')`);
      assert.equal(app.searches.length, 1, 'invalid offsets do not silently submit a first-page search');
    }
    await command('click', '.search-submit');
    await waitFor(command, `document.querySelector('.search-result')`);
    assert.equal(app.searches.length, 2, 'an explicit new submission starts current cursor search');
    assert.equal(await command('eval', `new URL(location.href).searchParams.has('offset')`), 'false');
  });

test('a content-search scope change rejects an older continuation response',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t, true);
    const command = await browser(t, `${app.origin}/sessions/search?q=recorded+term&provider=codex,pi`);
    await waitFor(command, `document.querySelector('.search-result')`);
    app.state.delayCursorSearches = true;
    await command('click', '.search-more');
    await waitForSearchCount(app, 2);
    await command('select', '[data-content-provider]', 'pi');
    await waitFor(command, `document.querySelectorAll('.search-result').length === 1 &&
      document.querySelector('.search-result')?.textContent.includes('pi-one')`);
    await waitForCompletedSearchCount(app, 3);
    assert.equal(app.searches.at(-1).provider, 'pi');
    assert.equal(app.searches.at(-1).cursor, undefined);
    assert.equal(await command('eval', `document.querySelectorAll('.search-result').length`), '1');
    assert.match(await command('get', 'text', '.search-result'), /pi-one/);
  });

test('Library searches recorded content, pages hits, and opens an exact Reader event',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t);
    const command = await browser(t, `${app.origin}/sessions`);
    await waitFor(command, `document.querySelector('.session-table')`);
    await command('click', '[data-search-mode="content"]');
    await command('fill', 'input[type="search"]', 'recorded term');
    await command('click', '.search-submit');
    await waitFor(command, `document.querySelectorAll('.search-result').length === 1`);
    assert.match(await command('get', 'text', '.search-result'), /recorded term/);
    assert.equal(app.searches[0].q, 'recorded term');
    await command('click', '.search-more');
    await waitFor(command, `document.querySelectorAll('.search-result').length === 2`);
    assert.equal(app.searches[1].cursor, 'page-two-0');
    if (process.env.AGENTSESSION_V3_SEARCH_SCREENSHOT) {
      await command('screenshot', process.env.AGENTSESSION_V3_SEARCH_SCREENSHOT);
    }
    await command('click', '.search-result:first-child a');
    await waitFor(command, `location.hash.includes('late-search-one')`);
    await waitFor(command, `document.querySelector('.reader-layout')`);
    assert.match(await command('get', 'text', '.reader-layout'), /recorded finding in search-one/);
    await command('back');
    await waitFor(command, `document.querySelectorAll('.search-result').length === 2`);
    assert.match(await command('get', 'value', 'input[type="search"]'), /recorded term/);
    assert.equal(app.searches.length, 2, 'ordinary Back keeps the committed search page');

    // Keep a pagination response in flight while the matching session is deleted.
    app.state.delayCursorSearches = true;
    await command('click', '.search-submit');
    await waitFor(command, `document.querySelectorAll('.search-result').length === 1`);
    await waitForSearchCount(app, 3);
    await command('click', '.search-more');
    await waitForSearchCount(app, 4);
    await command('click', '.search-result:first-child a');
    await waitFor(command, `document.querySelector('.reader-delete:not([disabled])')`);
    await command('eval', `document.documentElement.style.scrollBehavior = 'auto'; document.querySelector('.reader-delete').scrollIntoView({ block: 'center' })`);
    await command('click', '.reader-delete');
    await waitFor(command, `location.pathname === '/sessions' && document.querySelectorAll('.search-result').length === 1 && document.querySelector('.search-result')?.textContent.includes('search-two') && !document.querySelector('.search-more')`);
    assert.equal(app.searches[4].q, 'recorded term');
    assert.equal(app.searches[4].cursor, undefined, 'deletion starts a fresh first page');
    await waitForCompletedSearchCount(app, 5);
    assert.equal(await command('eval', `Boolean(document.querySelector('.search-error'))`), 'false',
      'the delayed stale cursor error does not replace refreshed results');

    await command('fill', 'input[type="search"]', 'Unrelated search-two');
    await command('click', '.search-submit');
    await waitFor(command, `document.querySelectorAll('.search-result').length === 1 && document.querySelector('.search-result')?.textContent.includes('Unrelated search-two')`);
    await command('eval', `document.documentElement.style.minHeight = '1800px'; window.scrollTo({ top: 320, behavior: 'instant' })`);
    await waitFor(command, `window.scrollY === 320`);
    await command('click', '.search-result a');
    await waitFor(command, `document.querySelector('.reader-layout')`);
    await waitFor(command, `document.querySelector('.reader-rename:not([disabled])')`);
    await command('eval', `document.documentElement.style.scrollBehavior = 'auto'; document.querySelector('.reader-rename').scrollIntoView({ block: 'center' })`);
    await command('click', '.reader-rename');
    await command('fill', '.reader-rename-input', 'Renamed away');
    const renamedSearch = app.holdNextSearch();
    await command('click', '.reader-rename-save');
    await waitFor(command, `document.querySelector('#reader-title')?.textContent === 'Renamed away'`);
    await waitFor(command, `document.title.includes('Renamed away')`);
    await waitForSearchCount(app, 7);
    await command('click', '.reader-back-link');
    await waitFor(command, `location.pathname === '/sessions' && document.querySelector('.library-layout')`);
    await waitFor(command, `window.scrollY === 320`);
    await waitFor(command, `document.querySelector('.search-loading[role="status"]')`);
    assert.equal(app.searches.length, 7, 'Back during rename refresh keeps the pending query');
    renamedSearch.release();
    await waitFor(command, `location.pathname === '/sessions' && document.querySelector('.compact-empty h2')?.textContent === 'No matches'`);
    assert.equal(app.searches.at(-1).q, 'Unrelated search-two');
    assert.equal(app.searches.at(-1).cursor, undefined, 'rename refreshes from the first page');
    assert.equal(app.searches.length, 7, 'Back after rename does not submit the query again');
    await waitForCompletedSearchCount(app, 7);
    await waitFor(command, `window.scrollY === 320`);
    await command('back');
    await waitFor(command, `document.querySelector('.reader-layout')`);
    await command('click', '.reader-back-link');
    await waitFor(command, `location.pathname === '/sessions' && document.querySelector('.compact-empty h2')?.textContent === 'No matches'`);
    assert.equal(app.searches.length, 7, 'Back preserves the completed empty search');
  });

test('content search reports partial source coverage in English and Chinese when no matches are known',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t);
    app.state.partialSearchCoverage = true;
    const command = await browser(t, `${app.origin}/sessions`);
    await waitFor(command, `document.querySelector('.session-table')`);
    await command('click', '[data-search-mode="content"]');
    await command('fill', 'input[type="search"]', 'not present in the available source');
    await command('click', '.search-submit');
    await waitFor(command, `document.querySelector('.source-diagnostic') &&
      document.querySelector('.compact-empty h2')?.textContent === 'No recorded matches in available sources'`);

    const englishWarning = await command('get', 'text', '.source-diagnostic');
    assert.match(englishWarning, /Some sources could not be searched/);
    assert.match(englishWarning, /History unavailable: multiple Codex source files/);
    assert.doesNotMatch(await command('get', 'text', '.compact-empty h2'), /^No matches$/);

    await command('select', '.language-select', 'zh');
    await waitFor(command, `document.documentElement.lang === 'zh-CN'`);
    const chineseWarning = await command('get', 'text', '.source-diagnostic');
    assert.match(chineseWarning, /部分来源无法搜索/);
    assert.match(chineseWarning, /历史记录暂不可用：同一 Codex 会话有多个源文件/);
    assert.equal(await command('get', 'text', '.compact-empty h2'), '可用来源中没有已记录的匹配结果');
  });

test('session list does not claim an empty archive when source coverage is partial',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t);
    app.state.partialFamilyCoverage = true;
    app.state.familySourceDiagnostics = [
      { provider: 'codex', message: 'Codex source identity is unreadable in one or more files; session history is unavailable.' },
      { provider: 'codex', message: 'History unavailable: multiple Codex source files' },
    ];
    const command = await browser(t, `${app.origin}/sessions`);
    await waitFor(command, `document.querySelector('.library-source-note') &&
      document.querySelector('.compact-empty h2')?.textContent === 'No recorded sessions in available sources'`);
    assert.equal(await command('eval', `document.querySelector('.library-source-note').open`), 'false',
      'source issues start folded while the empty-state coverage stays explicit');
    assert.equal(Number(await command('get', 'count', '.library-source-note p')), 2,
      'separate source issues from one provider render without losing a diagnostic');
    await command('click', '.library-source-note > summary');
    assert.match(await command('get', 'text', '.library-source-note'), /multiple Codex source files/);
    assert.doesNotMatch(await command('get', 'text', '.compact-empty h2'), /^No sessions yet$/);
    await command('select', '.language-select', 'zh');
    await waitFor(command, `document.documentElement.lang === 'zh-CN'`);
    assert.equal(await command('get', 'text', '.compact-empty h2'), '可用来源中没有已记录的会话');
    assert.match(await command('get', 'text', '.library-source-note'), /部分 Codex 源文件的会话身份无法读取/);

    await command('fill', 'input[type="search"]', 'missing');
    await waitFor(command, `document.querySelector('.compact-empty h2')?.textContent === '可用来源中没有已记录的匹配结果'`);
    assert.doesNotMatch(await command('get', 'text', '.compact-empty h2'), /^没有匹配结果$/);
  });

test('Trash restore refreshes the committed content query',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t);
    app.state.deleted.add('search-one');
    app.state.searchRevision++;
    const command = await browser(t, `${app.origin}/sessions`);
    await waitFor(command, `document.querySelector('.session-table')`);
    await command('click', '[data-search-mode="content"]');
    await command('fill', 'input[type="search"]', 'Unrelated search-one');
    await command('click', '.search-submit');
    await waitFor(command, `document.querySelector('.compact-empty h2')?.textContent === 'No matches'`);

    await command('click', '[data-library-view="trash"]');
    await waitFor(command, `document.querySelector('.trash-row')`);
    await command('click', '.trash-restore');
    await waitFor(command, `!document.querySelector('.trash-row')`);
    await command('click', '[data-library-view="sessions"]');
    await waitFor(command, `document.querySelectorAll('.search-result').length === 1 && document.querySelector('.search-result')?.textContent.includes('Unrelated search-one')`);
    assert.equal(app.searches.length, 2);
    assert.equal(app.searches[1].q, 'Unrelated search-one');
    assert.equal(app.searches[1].cursor, undefined);
  });

test('Reader reload restores submitted content search results on browser Back',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t);
    const command = await browser(t, `${app.origin}/sessions`);
    await waitFor(command, `document.querySelector('.session-table')`);
    await command('click', '[data-search-mode="content"]');
    await command('fill', 'input[type="search"]', 'recorded term');
    await command('click', '.search-submit');
    await waitFor(command, `document.querySelectorAll('.search-result').length === 1`);

    await command('click', '.search-result a');
    await waitFor(command, `document.querySelector('.reader-layout')`);
    await command('reload');
    await waitFor(command, `document.querySelector('.reader-layout')`);
    await command('back');

    await waitFor(command, `document.querySelectorAll('.search-result').length === 1 && document.querySelector('.search-result')?.textContent.includes('recorded term')`);
    assert.equal(await command('get', 'value', 'input[type="search"]'), 'recorded term');
    assert.equal(app.searches.length, 2, 'restoration reruns one committed first-page search');
    assert.equal(app.searches[1].q, 'recorded term');
    assert.equal(app.searches[1].cursor, undefined);
  });

test('Reader Back keeps partial results and returns focus to search after continuation failure',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t);
    const command = await browser(t, `${app.origin}/sessions/search?q=recorded+term`);
    await waitFor(command, `document.querySelectorAll('.search-result').length === 1`);
    await command('click', '.search-more');
    await waitFor(command, `document.querySelectorAll('.search-result').length === 2`);

    const targetHref = await command('eval',
      `document.querySelector('.search-result:last-child a')?.getAttribute('href')`);
    assert.match(targetHref, /search-two#event\?messageId=late-search-two/);
    await command('focus', '.search-result:last-child a');
    await command('press', 'Enter');
    await waitFor(command, `location.hash.includes('late-search-two') && document.querySelector('.reader-layout')`);
    await command('reload');
    await waitFor(command, `document.querySelector('.reader-layout')`);

    const firstRestorePage = app.holdNextSearch();
    await command('back');
    await firstRestorePage.started;
    const failedContinuation = app.holdNextSearch();
    firstRestorePage.release();
    await failedContinuation.started;
    app.state.failNextSearch = true;
    failedContinuation.release();

    await waitForCompletedSearchCount(app, 4);
    await waitFor(command, `document.querySelector('.search-error') && !document.querySelector('.search-loading')
      && document.querySelectorAll('.search-result').length === 1`);
    const restored = JSON.parse(await command('eval', `(() => ({
      activeIsSearch: document.activeElement === document.querySelector('input[type="search"]'),
      activeTag: document.activeElement?.tagName,
      query: document.querySelector('input[type="search"]')?.value,
      hrefs: [...document.querySelectorAll('.search-result a[href]')]
        .map(link => link.getAttribute('href')),
      error: document.querySelector('.search-error')?.textContent.trim(),
      noMatches: Boolean(document.querySelector('.compact-empty')),
      busy: document.querySelector('.search-results')?.getAttribute('aria-busy'),
    }))()`));

    assert.equal(restored.query, 'recorded term');
    assert.equal(restored.hrefs.length, 1, 'the successful first page remains visible');
    assert.doesNotMatch(restored.hrefs[0], /search-two/, 'the departed second-page target is not falsely present');
    assert.match(restored.error || '', /The search could not finish/);
    assert.equal(restored.noMatches, false, 'partial results are not shown as an empty search');
    assert.equal(restored.busy, 'false');
    assert.equal(restored.activeIsSearch, true,
      `When the target page fails, focus falls back to the query instead of remaining on ${restored.activeTag}`);
    assert.equal(app.searches.length, 4);
    assert.deepEqual(app.searches.slice(2).map(row => row.cursor), [undefined, 'page-two-0']);
  });

for (const heldScopeChange of [false, true]) {
  test(`Back restores an older committed content search after ${heldScopeChange ? 'a held provider-scope change' : 'a completed empty query'}`,
    { skip, timeout: 60_000 }, async t => {
      const app = await harness(t, true);
      const command = await browser(t, `${app.origin}/sessions/search?q=recorded+term&provider=codex`);
      await waitFor(command, `document.querySelector('.search-result')?.textContent.includes('search-one')`);
      await command('click', '.search-result a');
      await waitFor(command, `document.querySelector('.reader-layout')`);
      await command('click', '.reader-back-link');
      await waitFor(command, `document.querySelector('.search-result')?.textContent.includes('search-one')`);
      assert.equal(app.searches.length, 1, 'same-query Back keeps the committed result');

      const newerSearch = heldScopeChange ? app.holdNextSearch() : null;
      if (heldScopeChange) {
        await command('select', '[data-content-provider]', 'pi');
        await newerSearch.started;
      } else {
        await command('fill', 'input[type="search"]', 'absent recorded phrase');
        await command('click', '.search-submit');
        await waitFor(command, `document.querySelector('.compact-empty h2')?.textContent === 'No matches'`);
      }
      assert.equal(app.searches.length, 2);
      await command('back');
      await waitFor(command, `document.querySelector('.reader-layout')`);
      await command('back');
      await waitForSearchCount(app, 3);
      await waitFor(command, `document.querySelector('.search-result')?.textContent.includes('search-one')`);
      assert.equal(await command('get', 'value', 'input[type="search"]'), 'recorded term');
      assert.equal(await command('get', 'value', '[data-content-provider]'), 'codex');
      assert.deepEqual(app.searches.at(-1), { q: 'recorded term', limit: '20', provider: 'codex' });
      if (newerSearch) {
        newerSearch.release();
        await waitForCompletedSearchCount(app, 3);
        assert.match(await command('get', 'text', '.search-result'), /search-one/);
        assert.doesNotMatch(await command('get', 'text', '.search-result'), /pi-one/,
          'the held response cannot replace the restored provider scope');
      }
      assert.equal(app.searches.length, 3);
    });
}

test('Search modes keep their own drafts while a Viewer mutation refreshes committed content',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t);
    const command = await browser(t, `${app.origin}/sessions`);
    await waitFor(command, `document.querySelector('.session-table')`);
    await command('click', '[data-search-mode="content"]');
    await command('fill', 'input[type="search"]', 'recorded term');
    await command('click', '.search-submit');
    await waitFor(command, `document.querySelectorAll('.search-result').length === 1`);
    await command('click', '[data-search-mode="sessions"]');
    await command('fill', 'input[type="search"]', 'search-one');
    await waitFor(command, `document.querySelectorAll('.session-row').length === 1`);
    await command('click', '.session-row');
    await waitFor(command, `document.querySelector('.reader-delete:not([disabled])')`);
    await command('click', '.reader-delete');
    await waitFor(command, `location.pathname === '/sessions' && document.querySelector('.library-layout')`);
    await command('click', '[data-search-mode="content"]');
    await waitFor(command, `document.querySelectorAll('.search-result').length === 1 && document.querySelector('.search-result')?.textContent.includes('search-two')`);
    assert.equal(await command('get', 'value', 'input[type="search"]'), 'recorded term');
    assert.equal(app.searches.length, 2, 'mutation reruns the committed content query once');
    assert.equal(app.searches[1].q, 'recorded term');
  });
