import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const uiDir = path.join(repo, 'v3', 'ui');
const rootId = 'pane-root';
const childId = 'pane-child';
const marker = { [rootId]: 'ROOT-LATE-MARKER', [childId]: 'CHILD-LATE-MARKER' };
const body = { [rootId]: 'r'.repeat(1700) + marker[rootId],
  [childId]: 'c'.repeat(1700) + marker[childId] };
const browserName = process.platform === 'win32'
  ? 'agent-browser-win32-x64.exe' : `agent-browser-${process.platform}-${process.arch}`;
const browserExe = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
  (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', browserName))
    .find(existsSync);
const skip = !existsSync(path.join(uiDir, 'node_modules', 'vite'))
  ? 'Install the locked v3 UI dependencies.'
  : !browserExe || !existsSync(browserExe) ? 'agent-browser is required for browser QA.' : false;
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');

const ref = (id, name) => ({ provider: 'codex', sessionId: id, messageId: name, segment: 'message' });
const session = id => ({ provider: 'codex', sessionId: id });
const summary = id => ({ session: session(id), title: id, directory: '/public-fixture',
  createdAt: 1, updatedAt: 1, messageCount: 2, tokenCount: null,
  parent: id === childId ? session(rootId) : null });
const item = (id, name, ordinal) => {
  const text = name === 'tail' ? body[id] : id === rootId ? 'Root dispatch' : 'Child first answer';
  return { event: ref(id, name), ordinal, owner: null, role: 'assistant', timestamp: null,
    preview: text.slice(0, 120), totalChars: text.length, toolName: null, ownerMessageId: null, replyMetadata: null };
};
const segment = (id, tail = false) => ({ id: tail ? 'segment-tail' : 'segment-first',
  pageId: `${id}-${tail ? 'tail' : 'first'}`, startOrdinal: tail ? 1 : 0,
  items: [item(id, tail ? 'tail' : 'start', tail ? 1 : 0)], ownerContext: null,
  previousCursor: tail ? 'first' : null, nextCursor: tail ? null : 'tail' });
const toc = (id, tail = false) => ({ entries: [{ event: ref(id, tail ? 'tail' : 'start'),
  ordinal: tail ? 1 : 0, owner: null, label: tail ? marker[id] : 'Start' }],
  previousCursor: tail ? 'first' : null, nextCursor: tail ? null : 'tail' });
const bootstrap = id => ({ session: summary(id), revision: `revision-${id}`, totalItems: 2,
  segments: [segment(id)], toc: toc(id), relations: id === rootId
    ? { taskCount: 0, observationCount: 1, firstCursor: 'relations' }
    : { taskCount: 0, observationCount: 0, firstCursor: null } });

async function freePort() {
  return freeFetchSafePort();
}

async function harness(t, options = {}) {
  const { build } = createRequire(path.join(uiDir, 'package.json'))('vite');
  const buildDir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-pane-ui-'));
  await build({ root: uiDir, configFile: path.join(uiDir, 'vite.config.ts'),
    build: { outDir: buildDir, emptyOutDir: true }, logLevel: 'error' });
  const searches = [];
  let sourceRevision = 0;
  const revision = id => `revision-${id}${sourceRevision ? `-${sourceRevision}` : ''}`;
  const bootstraps = [];
  const contents = [];
  const delayedSearchResponses = [];
  const releaseDelayedSearch = () => {
    for (const release of delayedSearchResponses.splice(0)) release();
  };
  let delayedSearchDelivered = false;
  let delayLocate = false;
  let releaseDelayedLocate;
  let executionRequests = 0;
  let relationRequests = 0;
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    const json = (value, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === '/api/providers') return json([{ id: 'codex', available: true }]);
    if (url.pathname === `/api/v3/runtime/codex/${rootId}/events` &&
        (options.executionRevision || options.executionFailOnce || options.executionContinuation || options.beforeRootExecution)) {
      executionRequests++;
      await options.beforeRootExecution?.(executionRequests);
      if (options.executionFailOnce && executionRequests === 1) {
        return json({ error: { code: 'unavailable', message: 'temporary source read failure' } }, 503);
      }
      return json({ session: session(rootId), revision: options.executionRevision || `revision-${rootId}`,
        coverage: 'partial', events: options.executionRevision ? [{ id: 'changed-execution', sequence: 0,
          sourceOrder: { record: 0, ordinal: 0 }, timestamp: null,
          category: 'execution', kind: 'yielded',
          provenance: { fidelity: 'recorded', sourceType: 'public-fixture', sourceId: '1' },
          readerEvent: ref(rootId, 'start'),
          execution: { id: 'changed-execution', kind: 'process', phase: 'yielded',
            handle: 'public-process', toolName: 'shell' } }] : [], nextCursor: options.beforeRootExecution || (options.executionContinuation && executionRequests === 1) ? 'remaining-execution' : null, scannedEvents: 1 });
    }
    const route = url.pathname.match(/^\/api\/v3\/reader\/codex\/(pane-root|pane-child)\/(bootstrap|relations|child-location|search|locate|segments|toc|content)$/);
    if (route) {
      const [, id, kind] = route;
      if (kind === 'bootstrap') { bootstraps.push(id); const value = bootstrap(id);
        if (options.noCollaboration) value.relations = { taskCount: 0, observationCount: 0, firstCursor: null };
        if (id === rootId && options.tallRoot) {
          value.segments[0].items[0].preview = 'Root opening paragraph.\n\n'.repeat(80);
          value.segments[0].items[0].totalChars = value.segments[0].items[0].preview.length;
        }
        if (id === childId && options.tallChild) {
          value.segments[0].items[0].preview = 'Child opening paragraph.\n\n'.repeat(80);
          value.segments[0].items[0].totalChars = value.segments[0].items[0].preview.length;
        }
        return json({ ...value, revision: revision(id) }); }
      if (kind === 'child-location') return json({ session: session(id), revision: revision(id),
        placement: { child: session(childId), afterEvent: ref(rootId, options.childOnTail ? 'tail' : 'start'), sourceEventId: 'event:child', diagnostic: null },
        location: { session: session(id), revision: revision(id), event: ref(id, options.childOnTail ? 'tail' : 'start'),
          ordinal: options.childOnTail ? 1 : 0, owner: null, pageCursor: options.childOnTail ? 'tail' : 'first', tocCursor: 'first' }, diagnostic: null });
      if (kind === 'relations') {
        if (id === rootId) { relationRequests++; await options.beforeRootRelations?.(relationRequests); }
        return json({ session: session(id), revision: revision(id),
        entries: [{ type: 'coordination', observation: { kind: 'spawn', state: 'started',
          correlationId: 'child', eventId: 'event:child', fromSessionRef: session(rootId),
          toSessionRef: session(childId), provenance: { fidelity: 'recorded',
            sourceType: 'public-fixture', sourceId: '1' } } }],
        childPlacements: [{ child: session(childId), afterEvent: ref(rootId, options.childOnTail ? 'tail' : 'start'),
          sourceEventId: 'event:child', diagnostic: null }], nextCursor: null });
      }
      if (kind === 'search') {
        const q = url.searchParams.get('q') || '';
        searches.push({ id, q });
        if (q === 'OLD-QUERY' || (options.continuation && url.searchParams.get('cursor') === 'more')) {
          delayedSearchResponses.push(() => {
            json({ session: session(id), revision: revision(id), scope: 'owned',
              coverage: 'complete-owned-content', matches: [{ event: ref(id, 'start'),
                owner: null, ordinal: 0, field: 'body', offset: 0, matchLength: 3,
                excerpt: q === 'OLD-QUERY' ? 'OLD-QUERY stale result' : marker[id] + ' second result', excerptStart: 0, totalChars: 20 }],
              nextCursor: null });
            delayedSearchDelivered = true;
          });
          return;
        }
        const hit = q.toLocaleLowerCase() === marker[id].toLocaleLowerCase();
        return json({ session: session(id), revision: revision(id),
          scope: 'owned', coverage: 'complete-owned-content', matches: hit ? [{
            event: ref(id, 'tail'), owner: null, ordinal: 1, field: 'body', offset: 1700,
            matchLength: marker[id].length, excerpt: marker[id], excerptStart: 1700,
            totalChars: body[id].length,
          }] : [], nextCursor: options.continuation && hit ? 'more' : null });
      }
      if (kind === 'locate') {
        const send = () => json({ session: session(id), revision: revision(id),
          event: ref(id, url.searchParams.get('messageId')), ordinal: 1, owner: null,
          pageCursor: 'tail', tocCursor: 'tail' });
        if (delayLocate) {
          delayLocate = false;
          releaseDelayedLocate = send;
          return;
        }
        return send();
      }
      if (kind === 'segments') return json({ session: session(id), revision: revision(id),
        page: segment(id, url.searchParams.get('cursor') === 'tail') });
      if (kind === 'toc') return json({ session: session(id), revision: revision(id),
        toc: toc(id, url.searchParams.get('cursor') === 'tail') });
      if (kind === 'content') {
        const offset = Number(url.searchParams.get('offset'));
        const maxChars = Number(url.searchParams.get('maxChars'));
        contents.push({ id, offset, field: url.searchParams.get('field') });
        if (id === childId) await options.beforeChildContent?.(contents.filter(row => row.id === childId).length);
        if (id === rootId) await options.beforeRootContent?.(contents.filter(row => row.id === rootId && row.offset === 1700).length);
        const sourceText = url.searchParams.get('messageId') === 'start'
          ? id === rootId && options.tallRoot ? 'Root opening paragraph.\n\n'.repeat(80)
            : id === childId && options.tallChild ? 'Child opening paragraph.\n\n'.repeat(80)
              : item(id, 'start', 0).preview
          : body[id];
        const text = sourceText.slice(offset, offset + maxChars);
        const nextOffset = offset + text.length < sourceText.length ? offset + text.length : null;
        return json({ text, offset, totalChars: sourceText.length, nextOffset,
          truncated: nextOffset !== null });
      }
    }
    if (/^\/api\/v3\/resume\/codex\//.test(url.pathname)) {
      return json(options.resumeInfo ?? { allowTerminalLaunch: false, available: false, diagnostic: null, command: null });
    }
    if (/^\/api\/v3\/meta\/codex\//.test(url.pathname)) return json(null);
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
    releaseDelayedSearch?.();
    releaseDelayedLocate?.();
    await new Promise(resolve => server.close(resolve));
    await rm(buildDir, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${port}`, searches, contents, bootstraps,
    get executionRequests() { return executionRequests; },
    changeSourceRevision: () => { sourceRevision++; },
    releaseDelayedSearch: () => releaseDelayedSearch?.(),
    delayNextLocate: () => { delayLocate = true; },
    releaseDelayedLocate: () => { releaseDelayedLocate?.(); releaseDelayedLocate = undefined; },
    get locatePending() { return Boolean(releaseDelayedLocate); },
    get delayedSearchDelivered() { return delayedSearchDelivered; } };
}

async function browser(t, url, launchArgs = []) {
  const name = `agentsession-v3-pane-${process.pid}-${Date.now()}`;
  const command = (...args) => new Promise((resolve, reject) => {
    const child = spawn(browserExe, ['--session', name, ...args],
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

  t.after(async () => { try { await command('close'); } catch { /* Already closed. */ } });
  await command('open', url, ...launchArgs);
  await waitFor(command, `document.querySelector('.reader-find-toggle')`);
  await command('click', '.reader-find-toggle');
  await waitFor(command, `!document.querySelector('#reader-search').hidden`);
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

for (const scope of ['session', 'child']) {
  for (const activation of ['keyboard', 'mouse']) {
    test(`${scope} search ${activation} activation moves focus to the match and Tab continues to the next reading control`,
      { skip, timeout: 60_000 }, async t => {
        const app = await harness(t, { tallRoot: true, tallChild: true });
        const command = await browser(t, `${app.origin}/codex/session/${rootId}`);
        await command('set', 'viewport', '1280', '900');
        if (scope === 'child') {
          await waitFor(command, `document.querySelector('.inline-child-toggle')`);
          await command('click', '.inline-child-toggle');
        }
        const id = scope === 'child' ? childId : rootId;
        const search = `.pane-search[data-scope="${scope}"]`;
        await waitFor(command, `document.querySelector('${search} input')`);
        await command('fill', `${search} input`, marker[id]);
        await command('click', `${search} button[type="submit"]`);
        await waitFor(command, `document.querySelector('${search} .pane-search-result')`);
        if (activation === 'keyboard') {
          await command('focus', `${search} .pane-search-result`);
          await command('press', 'Enter');
        } else await command('click', `${search} .pane-search-result`);
        const pane = scope === 'child' ? '.inline-child-reader' : '.reader-main';
        await waitFor(command, `document.querySelector('${pane} .search-reveal mark')?.textContent === '${marker[id]}'`);
        const focused = JSON.parse(await command('eval', `(() => {
          const mark = document.querySelector('${pane} .search-reveal mark');
          const region = mark.closest('.search-reveal');
          const rect = mark.getBoundingClientRect();
          return { matchFocused: document.activeElement === region,
            ownerMessageId: region.closest('article.event-card').dataset.messageId,
            ownerSegment: region.closest('article.event-card').dataset.segment,
            top: rect.top, bottom: rect.bottom, height: innerHeight, y: scrollY };
        })()`));
        t.diagnostic(`${scope}/${activation}: ${JSON.stringify(focused)}`);
        assert.equal(focused.matchFocused, true, 'activation focuses the matched reading region');
        assert.equal(focused.ownerMessageId, 'tail', 'focus belongs to the exact matched message');
        assert.equal(focused.ownerSegment, 'message', 'focus belongs to the exact matched content segment');
        assert.ok(focused.top >= 0 && focused.bottom <= focused.height, 'the matched text is visible');
        const nextControl = scope === 'child'
          ? '.reader-main > .transcript > .turn-block > article[data-message-id="tail"] .event-footer .read-more'
          : '.reader-outline nav a';
        await waitFor(command, `document.querySelector('${nextControl}') && !document.querySelector('${nextControl}').disabled`);
        await command('press', 'Tab');
        await waitFor(command, `(() => { const rect = document.activeElement.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= innerHeight; })()`);
        const next = JSON.parse(await command('eval', `(() => {
          const rect = document.activeElement.getBoundingClientRect();
          return { controlFocused: document.activeElement === document.querySelector('${nextControl}'),
            controlTag: document.activeElement.tagName, controlClass: document.activeElement.className,
            top: rect.top, bottom: rect.bottom, height: innerHeight, y: scrollY };
        })()`));
        t.diagnostic(`${scope}/${activation} Tab: ${JSON.stringify(next)}`);
        assert.equal(next.controlFocused, true, 'Tab proceeds to the next reading control after the matched region');
        assert.ok(next.top >= 0 && next.bottom <= next.height, 'the next keyboard control is visible');
      });
  }
}

test('Reader keeps unavailable resume diagnostics in Session details without an inactive primary action',
  { skip, timeout: 60_000 }, async t => {
    const diagnostic = 'Resume requires an absolute existing directory';
    const app = await harness(t, { noCollaboration: true,
      resumeInfo: { allowTerminalLaunch: true, available: false, diagnostic, command: null } });
    const command = await browser(t, `${app.origin}/codex/session/${rootId}`);
    await command('press', 'Escape');
    assert.equal(await command('eval', `document.querySelector('.reader-session-details').open`), 'false');
    assert.equal(await command('eval', `document.body.innerText.includes(${JSON.stringify(diagnostic)})`), 'false',
      'Unavailable capability diagnostics stay out of the initial reading flow');
    assert.equal(await command('eval', `[...document.querySelectorAll('.reader-actions button')]
      .some(button => button.textContent.includes('Resume'))`), 'false',
    'An unavailable resume command adds no inactive primary button');
    await command('click', '.reader-session-details summary');
    await waitFor(command, `document.querySelector('.reader-session-details').innerText.includes(${JSON.stringify(diagnostic)})`);
    assert.equal(await command('eval', `document.body.innerText.includes(${JSON.stringify(diagnostic)})`), 'true',
      'Opening Session details exposes the actionable source diagnostic');
    await command('click', '.reader-session-details summary');
    assert.equal(await command('eval', `document.body.innerText.includes(${JSON.stringify(diagnostic)})`), 'false');
  });

test('Reader rejects execution facts from a different source revision',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t, { executionRevision: 'revision-changed', noCollaboration: true });
    const command = await browser(t, `${app.origin}/codex/session/${rootId}`);
    assert.equal(Number(await command('get', 'count', '.collaboration-launcher')), 0,
      'execution diagnostics remain reachable without collaboration');
    await command('click', '.reader-session-details summary');
    await waitFor(command, `document.querySelector('.reader-execution-details')`);
    await command('click', '.reader-execution-details summary');
    await waitFor(command, `document.querySelector('.reader-execution-details .content-error')`);
    const diagnostic = await command('eval',
      `document.querySelector('.reader-execution-details .content-error')?.textContent`);
    assert.match(diagnostic, /revision changed/i);
    assert.equal(await command('eval',
      `Boolean(document.querySelector('[data-phase="yielded"]'))`), 'false');
  });

test('Reader can retry its first execution-facts read after a transient failure',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t, { executionFailOnce: true, noCollaboration: true });
    const command = await browser(t, `${app.origin}/codex/session/${rootId}`);
    assert.equal(Number(await command('get', 'count', '.collaboration-launcher')), 0,
      'execution diagnostics remain reachable without collaboration');
    await command('click', '.reader-session-details summary');
    await waitFor(command, `document.querySelector('.reader-execution-details')`);
    await command('click', '.reader-execution-details summary');
    await waitFor(command, `document.querySelector('.reader-execution-details .content-error')`);
    await command('click', '.reader-execution-details button');
    await waitFor(command, `!document.querySelector('.reader-execution-details .content-error')`);
    assert.equal(app.executionRequests, 2);
  });

test('Reader continues execution records through Session details without collaboration',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t, { executionContinuation: true, noCollaboration: true });
    const command = await browser(t, `${app.origin}/codex/session/${rootId}`);
    assert.equal(Number(await command('get', 'count', '.collaboration-launcher')), 0);
    await command('click', '.reader-session-details summary');
    await waitFor(command, `document.querySelector('.reader-execution-details')`);
    await command('click', '.reader-execution-details summary');
    await command('click', '.reader-execution-details button');
    await waitFor(command, `!document.querySelector('.reader-execution-details')`);
    assert.equal(app.executionRequests, 2, 'the recorded continuation is fetched exactly once');
  });

test('a delayed old pane query cannot replace the current search results',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t);
    const command = await browser(t, `${app.origin}/codex/session/${rootId}`);
    await waitFor(command, `document.querySelector('.pane-search[data-scope="session"]')`);
    const input = '.pane-search[data-scope="session"] input[type="search"]';
    const submit = '.pane-search[data-scope="session"] button[type="submit"]';
    await command('fill', input, 'OLD-QUERY');
    await command('click', submit);
    await waitFor(command, `document.querySelector('.pane-search-state')?.textContent.includes('Searching')`);
    await command('fill', input, marker[rootId]);
    await command('click', submit);
    await waitFor(command, `document.querySelector('.pane-search-result')?.textContent.includes('${marker[rootId]}')`);
    assert.deepEqual(app.searches.map(entry => entry.q), ['OLD-QUERY', marker[rootId]]);
    app.releaseDelayedSearch();
    assert.equal(app.delayedSearchDelivered, true);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await command('eval', `document.querySelector('.pane-search-result')?.textContent.includes('${marker[rootId]}')`), 'true');
    assert.equal(await command('eval', `document.querySelector('.pane-search-result')?.textContent.includes('OLD-QUERY')`), 'false');
  });

test('changing a pane query cancels navigation from an old selected result',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t);
    const command = await browser(t, `${app.origin}/codex/session/${rootId}`);
    await waitFor(command, `document.querySelector('.pane-search[data-scope="session"]')`);
    const input = '.pane-search[data-scope="session"] input[type="search"]';
    await command('fill', input, marker[rootId]);
    await command('click', '.pane-search[data-scope="session"] button[type="submit"]');
    await waitFor(command, `document.querySelector('.pane-search[data-scope="session"] .pane-search-result')`);
    app.delayNextLocate();
    await command('click', '.pane-search[data-scope="session"] .pane-search-result');
    await waitFor(command, `document.querySelector('.reader-main')`);
    assert.equal(app.locatePending, true, 'Selected result waits for the source location');
    await command('fill', input, 'NEW-QUERY');
    app.releaseDelayedLocate();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await command('eval', 'location.hash'), '""', 'The old result does not rewrite the Reader URL');
    assert.equal(await command('eval', `Boolean(document.querySelector('.reader-main .search-reveal'))`), 'false');
    assert.equal(app.contents.filter(row => row.offset === 1700).length, 0,
      'The cancelled result does not request its matched content window');
  });

test('root and child pane search reveal complete unloaded content in their own histories',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t);
    const command = await browser(t, `${app.origin}/codex/session/${rootId}`);
    await waitFor(command, `document.querySelector('.pane-search[data-scope="session"]')`);
    await command('fill', '.pane-search[data-scope="session"] input[type="search"]', marker[rootId]);
    await command('click', '.pane-search[data-scope="session"] button[type="submit"]');
    await waitFor(command, `document.querySelector('.pane-search[data-scope="session"] .pane-search-result')`);
    await command('click', '.pane-search[data-scope="session"] .pane-search-result');
    await waitFor(command, `document.querySelector('.reader-main .search-reveal mark')?.textContent === '${marker[rootId]}'`);
    assert.deepEqual(app.searches[0], { id: rootId, q: marker[rootId] });
    assert.deepEqual(app.contents.find(row => row.id === rootId && row.offset === 1700), { id: rootId, offset: 1700, field: 'body' });

    await command('back');
    await waitFor(command, `document.querySelector('.inline-child-toggle')`);
    await command('click', '.inline-child-toggle');
    await waitFor(command, `document.querySelector('.pane-search[data-scope="child"]')`);
    const childHash = await command('eval', 'location.hash');
    await command('back');
    await waitFor(command, `!document.querySelector('.inline-child-reader')`);
    assert.equal(await command('eval', `document.activeElement?.classList.contains('inline-child-toggle')`), 'true',
      'Back restores focus to the child insertion control without remounting the Reader');
    await command('forward');
    await waitFor(command, `document.querySelector('.pane-search[data-scope="child"]')`);
    await command('fill', '.pane-search[data-scope="child"] input[type="search"]', marker[childId]);
    await command('eval', `document.querySelector('.pane-search[data-scope="child"] button[type="submit"]').click()`);
    await waitFor(command, `document.querySelector('.pane-search[data-scope="child"] .pane-search-result')`);
    await command('eval', `document.querySelector('.pane-search[data-scope="child"] .pane-search-result').click()`);
    await waitFor(command, `document.querySelector('.inline-child-reader .search-reveal mark')?.textContent === '${marker[childId]}'`);
    assert.deepEqual(app.searches[1], { id: childId, q: marker[childId] });
    assert.deepEqual(app.contents.find(row => row.id === childId && row.offset === 1700), { id: childId, offset: 1700, field: 'body' });
    const selectedHash = await command('eval', 'location.hash');
    assert.notEqual(selectedHash, childHash, 'The selected child match has a restorable history entry');
    assert.equal(await command('eval', `new URLSearchParams(location.hash.slice(7)).get('path')`),
      JSON.stringify(new URLSearchParams(JSON.parse(childHash).slice(7)).get('path')),
      'Selecting a child match preserves the parent Reader lineage');
    assert.equal(await command('eval', `new URLSearchParams(location.hash.slice(7)).get('messageId')`), '"tail"');
    assert.equal(await command('eval', `new URLSearchParams(location.hash.slice(7)).get('offset')`), '"1700"');
    assert.equal(await command('get', 'value', '.pane-search[data-scope="session"] input[type="search"]'), marker[rootId]);
    if (process.env.AGENTSESSION_V3_PANE_SCREENSHOT) {
      await command('screenshot', process.env.AGENTSESSION_V3_PANE_SCREENSHOT);
    }
    await command('click', '.inline-child-collapse');
    await waitFor(command, `!document.querySelector('.inline-child-reader')`);
    assert.equal(await command('eval', `document.activeElement?.classList.contains('inline-child-toggle')`), 'true');
  });

test('child source Back and Forward preserve each pane search after a fresh Reader mount',
  { skip, timeout: 90_000 }, async t => {
    const app = await harness(t, { childOnTail: true });
    const command = await browser(t, `${app.origin}/codex/session/${rootId}`);
    const rootInput = '.pane-search[data-scope="session"] input';
    const childInput = '.pane-search[data-scope="child"] input';
    await waitFor(command, `document.querySelector('${rootInput}')`);
    await command('fill', rootInput, marker[rootId]);
    await command('click', '.pane-search[data-scope="session"] button[type="submit"]');
    await waitFor(command, `document.querySelector('.pane-search[data-scope="session"] .pane-search-result')`);
    await command('click', '.pane-search[data-scope="session"] .pane-search-result');
    await waitFor(command, `document.querySelector('.reader-main .search-reveal mark')?.textContent === '${marker[rootId]}'`);
    await command('click', '.inline-child-toggle');
    await waitFor(command, `document.querySelector('${childInput}')`);
    await command('fill', childInput, marker[childId]);
    await command('eval', `document.querySelector('.pane-search[data-scope="child"] button[type="submit"]').click()`);
    await waitFor(command, `document.querySelector('.pane-search[data-scope="child"] .pane-search-result')`);
    await command('eval', `document.querySelector('.pane-search[data-scope="child"] .pane-search-result').click()`);
    await waitFor(command, `document.querySelector('.inline-child-reader .search-reveal mark')?.textContent === '${marker[childId]}'`);
    const parentHash = await command('eval', 'location.hash');
    await command('eval', `document.querySelector('.inline-child-heading-actions a').click()`);
    await waitFor(command, `location.pathname.endsWith('/${childId}') && document.querySelector('${rootInput}')`);
    assert.equal(await command('get', 'value', rootInput), '', 'Canonical child source has its own root search scope');
    await command('back');
    await waitFor(command, `location.pathname.endsWith('/${rootId}') && document.querySelector('${childInput}')`);
    // Reload proves recovery from history state without a live Reader or BFCache.
    const beforeReload = app.bootstraps.filter(id => id === rootId).length;
    await command('reload');
    await waitFor(command, `document.querySelector('${childInput}')`);
    assert.ok(app.bootstraps.filter(id => id === rootId).length > beforeReload);
    async function assertRestored() {
      assert.equal(await command('eval', 'location.hash'), parentHash);
      assert.equal(await command('get', 'value', rootInput), marker[rootId]);
      assert.equal(await command('get', 'value', childInput), marker[childId]);
      await waitFor(command, `document.querySelector('.pane-search[data-scope="session"] .pane-search-result')?.textContent.includes('${marker[rootId]}')`);
      await waitFor(command, `document.querySelector('.pane-search[data-scope="child"] .pane-search-result')?.textContent.includes('${marker[childId]}')`);
      await waitFor(command, `document.querySelector('.inline-child-reader .search-reveal mark')?.textContent === '${marker[childId]}'`);
      await waitFor(command, `document.querySelector('.reader-main > .transcript .search-reveal mark')?.textContent === '${marker[rootId]}'`);
    }
    await assertRestored();
    await command('forward');
    await waitFor(command, `location.pathname.endsWith('/${childId}') && document.querySelector('${rootInput}')`);
    await command('back');
    await waitFor(command, `location.pathname.endsWith('/${rootId}') && document.querySelector('${childInput}')`);
    await assertRestored();
    await command('click', '.inline-child-collapse');
    await waitFor(command, `!document.querySelector('.inline-child-reader')`);
    await command('click', '.inline-child-toggle');
    await waitFor(command, `document.querySelector('${childInput}')`);
    assert.equal(await command('get', 'value', childInput), marker[childId]);
    assert.deepEqual(app.searches, [{ id: rootId, q: marker[rootId] }, { id: childId, q: marker[childId] }],
      'Restoration retains results without reissuing searches');
  });

for (const movedAway of [false, true]) {
  test(`initial saved root search waits for layout owners and ${movedAway ? 'preserves a moved reading position' : 'keeps insertion focus visible'}`,
  { skip, timeout: 60_000 }, async t => {
    let releaseRelations;
    let releaseExecution;
    let relationsHeld = false;
    let executionHeld = false;
    let rootContentHeld = false;
    let releaseRootContent;
    const rootContentGate = new Promise(resolve => { releaseRootContent = resolve; });
    const relationGate = new Promise(resolve => { releaseRelations = resolve; });
    const executionGate = new Promise(resolve => { releaseExecution = resolve; });
    t.after(() => { releaseRelations(); releaseExecution(); releaseRootContent(); });
    const app = await harness(t, { childOnTail: true, tallChild: movedAway, beforeRootRelations: count => {
      if (count === 2) { relationsHeld = true; return relationGate; }
    }, beforeRootExecution: count => {
      if (count === 2) { executionHeld = true; return executionGate; }
    }, beforeRootContent: count => {
      if (count === 2) { rootContentHeld = true; return rootContentGate; }
    } });
    const command = await browser(t, `${app.origin}/codex/session/${rootId}`,
      ['--args', '--disable-features=BackForwardCache']);
    await command('set', 'viewport', '1440', '900');
    await waitFor(command, `document.querySelector('.pane-search[data-scope="session"] input')`);
    await command('fill', '.pane-search[data-scope="session"] input', marker[rootId]);
    await command('click', '.pane-search[data-scope="session"] button[type="submit"]');
    await waitFor(command, `document.querySelector('.pane-search-result')`);
    await command('click', '.pane-search-result');
    await waitFor(command, `document.querySelector('.reader-main .search-reveal mark')`);
    await command('click', '.inline-child-toggle');
    await waitFor(command, `document.querySelector('.inline-child-heading-actions a')`);
    await command('eval', `document.querySelector('.inline-child-heading-actions a').click()`);
    await waitFor(command, `location.pathname.endsWith('/${childId}') && document.querySelector('#reader-title')`);
    await command('back');
    await waitFor(command, `location.pathname.endsWith('/${rootId}') && document.querySelector('.inline-child-reader article')`);
    assert.equal(relationsHeld, true);
    assert.equal(executionHeld, true);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(app.contents.filter(row => row.id === rootId && row.offset === 1700).length, 1,
      'Saved root search waits for the actual onMount layout promises');
    releaseRelations();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(app.contents.filter(row => row.id === rootId && row.offset === 1700).length, 1,
      'Saved root search also waits for initial execution controls');
    releaseExecution();
    await waitFor(command, `document.activeElement?.classList.contains('inline-child-toggle')`);
    for (let attempt = 0; attempt < 50 && !rootContentHeld; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(rootContentHeld, true, 'Selected root content is held until after insertion focus settles');
    if (movedAway) {
      await command('eval', "window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })");
      assert.equal(await command('eval', `document.activeElement?.classList.contains('inline-child-toggle')`), 'true');
      assert.equal(await command('eval', `document.querySelector('.inline-child-toggle').getBoundingClientRect().bottom < 0`), 'true');
    }
    releaseRootContent();
    await waitFor(command, `document.querySelector('.reader-main > .transcript .search-reveal mark') && document.activeElement?.classList.contains('inline-child-toggle')`);
    assert.equal(app.contents.filter(row => row.id === rootId && row.offset === 1700).length, 2);
    const rect = JSON.parse(await command('eval', `(() => {
      const rect = document.querySelector('.inline-child-toggle').getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, viewport: innerHeight };
    })()`));
    if (movedAway) assert.ok(rect.bottom < 0, 'Restoration respects a moved reading position despite retained keyboard focus: ' + JSON.stringify(rect));
    else assert.ok(rect.top >= -1 && rect.bottom <= rect.viewport + 1, 'Insertion focus remains visible after saved root content restores: ' + JSON.stringify(rect));
  });
}

test('a late restored child search keeps the parent insertion focus visible',
  { skip, timeout: 60_000 }, async t => {
    let releaseContent;
    let held = false;
    const gate = new Promise(resolve => { releaseContent = resolve; });
    t.after(() => releaseContent());
    const app = await harness(t, { tallChild: true, beforeChildContent: count => {
      if (count === 2) { held = true; return gate; }
    } });
    const command = await browser(t, `${app.origin}/codex/session/${rootId}`,
      ['--args', '--disable-features=BackForwardCache']);
    await command('set', 'viewport', '1440', '900');
    await waitFor(command, `document.querySelector('.inline-child-toggle')`);
    await command('click', '.inline-child-toggle');
    await waitFor(command, `document.querySelector('.pane-search[data-scope="child"] input')`);
    await command('fill', '.pane-search[data-scope="child"] input', marker[childId]);
    await command('eval', `document.querySelector('.pane-search[data-scope="child"] button[type="submit"]').click()`);
    await waitFor(command, `document.querySelector('.pane-search[data-scope="child"] .pane-search-result')`);
    await command('eval', `document.querySelector('.pane-search[data-scope="child"] .pane-search-result').click()`);
    await waitFor(command, `document.querySelector('.inline-child-reader .search-reveal mark')`);
    await command('eval', `document.querySelector('.inline-child-heading-actions a').click()`);
    await waitFor(command, `location.pathname.endsWith('/${childId}') && document.querySelector('#reader-title')`);
    await command('back');
    await waitFor(command, `location.pathname.endsWith('/${rootId}') && document.activeElement?.classList.contains('inline-child-toggle')`);
    assert.equal(held, true);
    releaseContent();
    await waitFor(command, `document.querySelector('.inline-child-reader .search-reveal mark')`);
    const focus = JSON.parse(await command('eval', `(() => {
      const rect = document.querySelector('.inline-child-toggle').getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, viewport: innerHeight,
        focused: document.activeElement?.classList.contains('inline-child-toggle') };
    })()`));
    assert.equal(focus.focused, true);
    assert.ok(focus.top >= -1 && focus.bottom <= focus.viewport + 1,
      'Late restored content preserves visible insertion focus: ' + JSON.stringify(focus));
  });

for (const continuation of [false, true]) {
  test(`an interrupted ${continuation ? 'continued' : 'initial'} pane search resumes after a fresh Reader mount`,
    { skip, timeout: 60_000 }, async t => {
      const app = await harness(t, { continuation });
      const command = await browser(t, `${app.origin}/codex/session/${rootId}`,
        ['--args', '--disable-features=BackForwardCache']);
      const rootInput = '.pane-search[data-scope="session"] input';
      const q = continuation ? marker[rootId] : 'OLD-QUERY';
      await waitFor(command, `document.querySelector('${rootInput}')`);
      await command('fill', rootInput, q);
      await command('click', '.pane-search[data-scope="session"] button[type="submit"]');
      if (continuation) {
        await waitFor(command, `document.querySelector('.pane-search-more')`);
        await command('click', '.pane-search-more');
      }
      await waitFor(command, `document.querySelector('.pane-search-state')?.textContent.includes('Searching')`);
      await command('click', '.inline-child-toggle');
      await waitFor(command, `document.querySelector('.inline-child-heading-actions a')`);
      await command('eval', `document.querySelector('.inline-child-heading-actions a').click()`);
      await waitFor(command, `location.pathname.endsWith('/${childId}') && document.querySelector('#reader-title')`);
      await command('back');
      await waitFor(command, `location.pathname.endsWith('/${rootId}') && document.querySelector('.inline-child-reader')`);
      assert.equal(await command('get', 'value', rootInput), q);
      assert.equal(await command('eval', `document.querySelector('.pane-search[data-scope="session"]').textContent.includes('No matches')`), 'false');
      assert.equal(await command('eval', `document.querySelector('.pane-search-state')?.textContent.includes('Searching')`), 'true',
        'Returning search remains pending until its bounded source request completes');
      if (continuation) assert.equal(await command('eval', `document.querySelectorAll('.pane-search[data-scope="session"] .pane-search-result').length`), '1');
      assert.equal(app.searches.length, continuation ? 3 : 2, 'The interrupted bounded search is reissued');
      app.releaseDelayedSearch();
      await waitFor(command, `!document.querySelector('.pane-search-state')?.textContent.includes('Searching') && document.querySelector('.pane-search-result')`);
      assert.equal(await command('eval', `document.querySelectorAll('.pane-search[data-scope="session"] .pane-search-result').length`), continuation ? '2' : '1');
    });
}

test('restored pane search preserves its term and diagnoses a changed source revision',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t);
    const command = await browser(t, `${app.origin}/codex/session/${rootId}`);
    const input = '.pane-search[data-scope="session"] input';
    await waitFor(command, `document.querySelector('${input}')`);
    await command('fill', input, marker[rootId]);
    await command('click', '.pane-search[data-scope="session"] button[type="submit"]');
    await waitFor(command, `document.querySelector('.pane-search-result')`);
    app.changeSourceRevision();
    await command('reload');
    await waitFor(command, `document.querySelector('.pane-search .content-error')`);
    assert.equal(await command('get', 'value', input), marker[rootId]);
    assert.match(await command('eval', `document.querySelector('.pane-search .content-error').textContent`), /source changed/i);
    assert.equal(await command('eval', `Boolean(document.querySelector('.pane-search-result'))`), 'false');
    assert.equal(await command('eval', `Boolean(document.querySelector('.search-reveal'))`), 'false');
    await command('click', '.pane-search[data-scope="session"] button[type="submit"]');
    await waitFor(command, `document.querySelector('.pane-search-result')`);
    assert.equal(await command('eval', `Boolean(document.querySelector('.pane-search .content-error'))`), 'false');
  });

test('real Axum Reader searches and opens a late Codex body from its own source',
  { skip, timeout: 60_000 }, async t => {
    assert.ok(existsSync(binary), `Build the current 3.0 binary at ${binary}`);
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-pane-real-'));
    const source = path.join(scratch, 'codex');
    const sessionDir = path.join(source, 'sessions', '2026', '09', '27');
    await mkdir(sessionDir, { recursive: true });
    const id = 'pane-search-real';
    const lateMarker = 'REAL-AXUM-LATE-MARKER';
    const toolMarker = 'REAL-TOOL-OUTPUT-MARKER';
    const lines = [{ type: 'session_meta', payload: { id } },
      ...Array.from({ length: 71 }, (_, ordinal) => ({ type: 'response_item',
        payload: { type: 'message', id: `message-${ordinal}`, role: 'assistant',
          content: [{ type: 'output_text', text: ordinal === 70
            ? `${'preview '.repeat(220)}${lateMarker}` : `Public answer ${ordinal}` }] } })),
      { type: 'response_item', payload: { type: 'function_call', call_id: 'public-call',
        name: 'public_tool', arguments: '{"mode":"read"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'public-call',
        output: `${'tool '.repeat(360)}${toolMarker}` } }];
    await writeFile(path.join(sessionDir, 'rollout-pane.jsonl'), lines.map(row => JSON.stringify(row)).join('\n') + '\n');
    const port = await freePort();
    const server = spawn(binary, ['serve', '--port', String(port), '--codex-dir', source,
      '--opencode-db', path.join(scratch, 'absent.db'), '--claude-dir', path.join(scratch, 'claude'),
      '--pi-dir', path.join(scratch, 'pi'), '--dsh-dir', path.join(scratch, 'dsh'),
      '--meta-dir', path.join(scratch, 'meta'), '--index-dir', path.join(scratch, 'index'),
      '--cache-dir', path.join(scratch, 'cache')],
    { cwd: scratch, windowsHide: true, stdio: 'ignore' });
    t.after(async () => {
      server.kill();
      if (server.exitCode === null) await once(server, 'close');
      const physical = await realpath(scratch);
      assert.equal(path.dirname(physical).toLowerCase(), (await realpath(os.tmpdir())).toLowerCase());
      await rm(physical, { recursive: true, force: true });
    });
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${origin}/api/v3/reader/codex/${id}/bootstrap`)).ok) { ready = true; break; } }
      catch { /* The local listener may still be starting. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'The public-source Axum Reader starts');
    const command = await browser(t, `${origin}/codex/session/${id}`);
    await waitFor(command, `document.querySelector('.pane-search[data-scope="session"]')`);
    await command('fill', '.pane-search[data-scope="session"] input[type="search"]', lateMarker);
    await command('eval', `document.querySelector('.pane-search[data-scope="session"] button[type="submit"]').click()`);
    await waitFor(command, `document.querySelector('.pane-search[data-scope="session"] .pane-search-result')`);
    await command('eval', `document.querySelector('.pane-search[data-scope="session"] .pane-search-result').click()`);
    await waitFor(command, `document.querySelector('.reader-main .search-reveal mark')?.textContent === '${lateMarker}'`);
    assert.equal(await command('eval', `document.querySelector('.reader-main .search-reveal')?.dataset.field === 'body'`), 'true');
    assert.equal(await command('eval', `document.querySelector('.reader-main .search-reveal p')?.textContent.includes('character 1761')`), 'true');
    await command('fill', '.pane-search[data-scope="session"] input[type="search"]', toolMarker);
    await command('eval', `document.querySelector('.pane-search[data-scope="session"] button[type="submit"]').click()`);
    await waitFor(command, `document.querySelector('.pane-search[data-scope="session"] .pane-search-result')?.textContent.includes('${toolMarker}')`);
    await command('eval', `document.querySelector('.pane-search[data-scope="session"] .pane-search-result').click()`);
    await waitFor(command, `document.querySelector('.reader-main .search-reveal[data-field="toolOutput"] mark')?.textContent === '${toolMarker}'`);
  });
