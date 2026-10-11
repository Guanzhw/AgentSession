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
const provider = 'opencode';
const sessionId = 'opening-reply-back-fixture';
const revision = 'opening-reply-back-revision';
const replyText = 'A readable opening reply from the next Reader page.';
const session = { provider, sessionId };

function agentBrowserBinary() {
  const override = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN;
  if (override && existsSync(override)) return override;
  const binaryName = process.platform === 'win32'
    ? 'agent-browser-win32-x64.exe'
    : `agent-browser-${process.platform}-${process.arch}`;
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(entry, 'node_modules', 'agent-browser', 'bin', binaryName);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const agentBrowserExe = agentBrowserBinary();
const skipReason = !existsSync(path.join(uiDir, 'node_modules', 'vite'))
  ? 'Install the locked v3/ui dependencies before running the Reader browser regression.'
  : !agentBrowserExe
    ? 'The agent-browser CLI is required; the test does not install it or download a browser.'
    : false;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function event(messageId, segment = 'message') {
  return { provider, sessionId, messageId, segment };
}

function readerItem(ordinal, options = {}) {
  const itemEvent = event(options.messageId || `process-item-${ordinal}`, options.segment || 'tool');
  return {
    event: itemEvent,
    ordinal,
    owner: options.owner ?? null,
    role: options.role || 'tool',
    timestamp: null,
    preview: options.preview || `Recorded process step ${ordinal}.`,
    totalChars: options.totalChars ?? 0,
    toolName: options.role === 'tool' || !options.role ? 'read' : null,
    presentationPhase: options.presentationPhase ?? null,
    processId: options.processId ?? null,
    processCount: options.processCount ?? null,
    replyMetadata: null,
    contentRevisions: {},
  };
}

const openingAssistant = readerItem(0, {
  messageId: 'opening-process-assistant',
  segment: 'message',
  role: 'assistant',
  preview: '',
  totalChars: 0,
  processId: 7,
  processCount: 101,
});
const firstItems = [openingAssistant, ...Array.from({ length: 31 }, (_, index) =>
  readerItem(index + 1, { owner: openingAssistant.event, processId: 7, processCount: 101,
    messageId: `process-tool-${index + 1}` }))];
const openingReply = readerItem(32, {
  messageId: 'opening-reply',
  segment: 'message',
  role: 'assistant',
  preview: replyText,
  totalChars: replyText.length,
  presentationPhase: 'final_answer',
});
const nextItems = [openingReply, ...Array.from({ length: 31 }, (_, index) =>
  readerItem(index + 33, { messageId: `later-item-${index + 33}`, segment: 'message', role: 'user',
    preview: `Later recorded item ${index + 33}.` }))];

function tocEntry(item) {
  return { event: item.event, ordinal: item.ordinal, owner: item.owner, role: item.role,
    label: item.preview || `Recorded event ${item.ordinal + 1}`,
    processId: item.processId, processCount: item.processCount };
}

const firstPage = {
  id: 'segment-opening',
  pageId: 'page-opening',
  startOrdinal: 0,
  items: firstItems,
  ownerContext: null,
  previousCursor: null,
  nextCursor: 'opening-reply-page',
};
const nextPage = {
  id: 'segment-opening-reply',
  pageId: 'page-opening-reply',
  startOrdinal: 32,
  items: nextItems,
  ownerContext: null,
  previousCursor: 'opening-page',
  nextCursor: 'page-64',
};
const toc = { entries: firstItems.map(tocEntry), previousCursor: null, nextCursor: 'toc-page-32' };
const bootstrap = {
  session: {
    session,
    title: 'OpenCode opening reply fixture',
    directory: '/public/fixture/opencode',
    createdAt: 1_790_000_000_000,
    updatedAt: 1_790_000_001_000,
    messageCount: 101,
    tokenCount: null,
    parent: null,
  },
  revision,
  totalItems: 101,
  segments: [firstPage],
  toc,
};
const targetItems = Array.from({ length: 32 }, (_, index) => readerItem(64 + index, {
  role: 'assistant', segment: 'message', messageId: `target-reply-${64 + index}`,
  preview: `Selected public reply ${64 + index}.`, totalChars: 25,
}));
const targetPage = { id: 'segment-64', pageId: 'page-64', startOrdinal: 64,
  items: targetItems, ownerContext: null, previousCursor: 'opening-reply-page', nextCursor: 'page-96' };
const tailPage = { id: 'segment-96', pageId: 'page-96', startOrdinal: 96,
  items: Array.from({ length: 5 }, (_, index) => readerItem(96 + index, {
    role: 'user', segment: 'message', messageId: `tail-${96 + index}`,
    preview: `Recorded tail ${96 + index}.`,
  })), ownerContext: null, previousCursor: 'page-64', nextCursor: null };
const targetToc = { entries: targetItems.map(tocEntry), previousCursor: 'opening-toc', nextCursor: null };
const middleToc = { entries: nextItems.map(tocEntry), previousCursor: 'toc-page-32', nextCursor: 'toc-64' };
const runtimeEvent = {
  id: 'runtime-tool-event',
  sequence: 1,
  sourceOrder: { record: 12, ordinal: 0 },
  timestamp: null,
  category: 'tool',
  kind: 'tool.call',
  provenance: { fidelity: 'recorded', sourceType: 'opencode.tool', sourceId: '12' },
  readerEvent: firstItems[10].event,
};

async function startHarness(t, holdDiscovery = false, rejectReaderOnce = false, targetAware = false, holdTocHydration = false, libraryGates = false) {
  const requireFromUi = createRequire(path.join(uiDir, 'package.json'));
  const { build } = requireFromUi('vite');
  const buildDir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-opening-back-'));
  await build({ root: uiDir, configFile: path.join(uiDir, 'vite.config.ts'),
    build: { outDir: buildDir, emptyOutDir: true }, logLevel: 'error' });

  let openingPageRequests = 0;
  let discoveryRequests = 0;
  let readerRequests = 0;
  const navigationRequests = { locate: 0, segments: 0, toc: 0 };
  const tocRequests = [];
  let releaseTocHydration;
  let targetedBootstrapRequests = 0;
  let discoveryPending = false;
  let bootstrapWhileDiscoveryPending = false;
  let releaseDiscovery;
  let discoveryTimer;
  const familyRequests = [];
  const discoveryReleases = [];
  const familyReleases = [];
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    const json = (body, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };

    if (url.pathname === '/api/providers') {
      discoveryRequests++;
      if (libraryGates) {
        discoveryReleases.push((status = 200) => json(status === 200
          ? [{ id: provider, available: true }]
          : { error: { code: 'discovery_unavailable', message: 'Controlled discovery failure.' } }, status));
        return;
      }
      if (rejectReaderOnce && discoveryRequests > 1) {
        json({ error: { code: 'discovery_unavailable', message: 'Provider discovery is temporarily unavailable.' } }, 503);
        return;
      }
      if (holdDiscovery) {
        discoveryPending = true;
        releaseDiscovery = () => {
          releaseDiscovery = undefined;
          clearTimeout(discoveryTimer);
          discoveryPending = false;
          json([{ id: provider, available: true }]);
        };
        discoveryTimer = setTimeout(releaseDiscovery, 750);
      } else {
        json([{ id: provider, available: true }]);
      }
      return;
    }
    if (url.pathname === '/api/v3/library/sessions' && libraryGates) {
      familyRequests.push(Object.fromEntries(url.searchParams));
      familyReleases.push((status = 200, page) => json(status === 200 ? page ?? {
        families: [{ session: bootstrap.session, matched: true, matchingCount: 1,
          childCount: 0, totalChildCount: 0, familyRootId: sessionId,
          familyUpdated: bootstrap.session.updatedAt, parentBoundary: null }],
        total: 1, matchingSessions: 1, sourceDiagnostics: [], nextCursor: null,
      } : { error: { code: 'source_error', message: 'Controlled family failure.' } }, status));
      return;
    }
    if (url.pathname === `/api/v3/reader/${provider}/${sessionId}/bootstrap`) {
      readerRequests++;
      if (rejectReaderOnce && readerRequests === 1) {
        json({ error: { code: 'source_error', message: 'The first Reader load failed.' } }, 500);
        return;
      }
      bootstrapWhileDiscoveryPending = discoveryPending;
      releaseDiscovery?.();
      if (targetAware && url.search && (!url.searchParams.get('messageId') || !url.searchParams.get('segment'))) {
        json({ error: { code: 'invalid_input', message: 'bootstrap target requires messageId and segment' } }, 400);
        return;
      }
      if (targetAware && url.searchParams.get('messageId') === 'target-reply-70' && url.searchParams.get('segment') === 'message') {
        targetedBootstrapRequests++;
        json({ ...bootstrap, segments: [firstPage, targetPage], toc: targetToc, openingToc: toc,
          targetLocation: { session, revision, event: targetItems[6].event, ordinal: 70,
            owner: null, pageCursor: 'page-64', tocCursor: 'toc-64' } });
        return;
      }
      json(bootstrap);
      return;
    }
    if (url.pathname === `/api/v3/reader/${provider}/${sessionId}/segments`) {
      navigationRequests.segments++;
      const cursor = url.searchParams.get('cursor');
      const page = { 'opening-page': firstPage, 'opening-reply-page': nextPage,
        'page-64': targetPage, 'page-96': tailPage }[cursor];
      if (!page) {
        json({ error: { code: 'not_found', message: 'The synthetic segment cursor is unknown.' } }, 404);
        return;
      }
      if (cursor === 'opening-reply-page') openingPageRequests++;
      json({ session, revision, page });
      return;
    }
    if (url.pathname === `/api/v3/reader/${provider}/${sessionId}/locate`) {
      navigationRequests.locate++;
      const target = [...firstItems, ...targetItems].find(item => item.event.messageId === url.searchParams.get('messageId')
        && item.event.segment === url.searchParams.get('segment'));
      if (!target || url.searchParams.get('revision') !== revision) {
        json({ error: { code: 'not_found', message: 'The synthetic event is unknown.' } }, 404);
        return;
      }
      json({ session, revision, event: target.event, ordinal: target.ordinal, owner: target.owner,
        pageCursor: target.ordinal < 32 ? 'opening-page' : 'page-64',
        tocCursor: target.ordinal < 32 ? 'opening-toc' : 'toc-64' });
      return;
    }
    if (url.pathname === `/api/v3/reader/${provider}/${sessionId}/toc`) {
      navigationRequests.toc++;
      const cursor = url.searchParams.get('cursor');
      const limit = Number(url.searchParams.get('limit'));
      tocRequests.push({ cursor, limit });
      const page = cursor === 'toc-page-32' ? middleToc : cursor === 'toc-64' ? targetToc : toc;
      if (holdTocHydration && cursor === 'toc-page-32' && limit === 512) {
        releaseTocHydration = () => json({ session, revision, toc: page });
        return;
      }
      json({ session, revision, toc: page });
      return;
    }
    if (url.pathname === `/api/v3/reader/${provider}/${sessionId}/executions`) {
      json({ session, revision, coverage: 'partial', events: [], nextCursor: null, scannedEvents: 0 });
      return;
    }
    if (url.pathname === `/api/v3/runtime/${provider}/${sessionId}/events`) {
      const executionOnly = url.searchParams.get('executionOnly') === 'true';
      json({ session, revision, coverage: 'partial', events: executionOnly ? [] : [runtimeEvent],
        nextCursor: null, scannedEvents: executionOnly ? 0 : 1 });
      return;
    }
    if (url.pathname === `/api/v3/resume/${provider}/${sessionId}`) {
      json({ allowTerminalLaunch: false, available: false, diagnostic: null, command: null });
      return;
    }
    if (url.pathname === `/api/v3/meta/${provider}/${sessionId}`) {
      json(null);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      json({ error: { code: 'not_found', message: 'Mock endpoint not found.' } }, 404);
      return;
    }

    const asset = url.pathname.startsWith('/assets/')
      ? path.resolve(buildDir, `.${url.pathname}`) : path.join(buildDir, 'index.html');
    if (!asset.startsWith(buildDir + path.sep) && asset !== path.join(buildDir, 'index.html')) {
      response.writeHead(400).end();
      return;
    }
    if (!existsSync(asset)) {
      response.writeHead(404).end();
      return;
    }
    const contentType = asset.endsWith('.html') ? 'text/html; charset=utf-8'
      : asset.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : asset.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
    response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
    response.end(readFileSync(asset));
  });

  const port = await freeFetchSafePort();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  t.after(async () => {
    clearTimeout(discoveryTimer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(buildDir, { recursive: true, force: true });
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    get openingPageRequests() { return openingPageRequests; },
    get discoveryRequests() { return discoveryRequests; },
    get bootstrapWhileDiscoveryPending() { return bootstrapWhileDiscoveryPending; },
    get targetedBootstrapRequests() { return targetedBootstrapRequests; },
    navigationRequests,
    tocRequests,
    familyRequests,
    discoveryReleases,
    familyReleases,
    releaseTocHydration: () => releaseTocHydration(),
  };
}

async function browserCommand(name, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(agentBrowserExe, ['--session', name, ...args], {
      cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`agent-browser ${args.join(' ')} timed out`)); }, 15_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', cause => { clearTimeout(timeout); reject(cause); });
    child.once('exit', code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`agent-browser ${args.join(' ')} failed (${code}): ${stderr || stdout}`));
      else resolve(stdout.trim());
    });
  });
}

async function startBrowser(t, url) {
  const name = `v3-opening-back-${process.pid}-${Date.now()}`;
  const command = (...args) => browserCommand(name, ...args);
  t.after(async () => { try { await command('close'); } catch { /* Browser may already be closed. */ } });
  await command('open', url);
  await command('set', 'viewport', '1440', '900');
  return command;
}

async function waitForBrowser(command, predicate, description) {
  const deadline = Date.now() + 10_000;
  let last = '';
  while (Date.now() < deadline) {
    last = await command('eval', `Boolean(${predicate})`);
    if (last.includes('true')) return;
    await sleep(75);
  }
  throw new Error(`Timed out waiting for ${description}. Last browser result: ${last}`);
}

async function waitForGate(predicate, description) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test('Library prefetch overlaps discovery while publication, failures and route ownership stay ordered',
  { skip: skipReason || false, timeout: 90_000 }, async t => {
    const harness = await startHarness(t, false, false, false, false, true);
    const command = await startBrowser(t, `${harness.origin}/sessions`);
    await waitForGate(() => harness.discoveryReleases.length === 1, 'controlled discovery request');
    await waitForGate(() => harness.familyRequests.length === 1, 'family request before discovery completes');
    assert.deepEqual(harness.familyRequests[0], { limit: '40', sort: 'updated-desc' });
    harness.familyReleases.shift()();
    await waitForBrowser(command, `document.querySelector('.loading-state')`, 'loading until discovery completes');
    assert.equal(await command('eval', `document.querySelector('.session-row') === null && !history.state?.agentSessionLibrary`), 'true');
    harness.discoveryReleases.shift()(503);
    await waitForBrowser(command, `document.querySelector('.error-state')?.textContent.includes('Controlled discovery failure.')`, 'discovery error');
    assert.equal(await command('eval', `!history.state?.agentSessionLibrary`), 'true');

    await command('click', '.error-state button');
    await waitForGate(() => harness.familyRequests.length === 2 && harness.discoveryReleases.length === 1, 'retry requests');
    harness.familyReleases.shift()(500);
    harness.discoveryReleases.shift()();
    await waitForBrowser(command, `document.querySelector('.search-error')?.textContent.includes('Controlled family failure.')`, 'Library-owned family error');
    assert.equal(await command('eval', `!document.querySelector('.error-state') && !document.querySelector('.session-row')`), 'true');

    await command('click', '.family-more');
    await waitForGate(() => harness.familyRequests.length === 3, 'family retry');
    harness.familyReleases.shift()();
    await waitForBrowser(command, `document.querySelectorAll('.session-row').length === 1`, 'single published family');
    assert.equal(harness.discoveryRequests, 2, 'successful discovery is reused on family retry');
    assert.equal(harness.familyRequests.length, 3, 'each opening consumes its initial family response once');

    await command('eval', `history.replaceState({ ...history.state,
      agentSessionLibrary: { ...history.state.agentSessionLibrary, familyCount: 80 } }, '', '/sessions'); location.reload()`);
    await waitForGate(() => harness.familyRequests.length === 4 && harness.discoveryReleases.length === 1, 'restored opening prefetch');
    const restoredPage = (start, nextCursor) => ({
      families: Array.from({ length: 40 }, (_, index) => ({
        session: { ...bootstrap.session, session: { provider, sessionId: `restored-${start + index}` } },
        matched: true, matchingCount: 1, childCount: 0, totalChildCount: 0,
        familyRootId: `restored-${start + index}`, familyUpdated: bootstrap.session.updatedAt, parentBoundary: null,
      })), total: 80, matchingSessions: 80, sourceDiagnostics: [], nextCursor,
    });
    harness.familyReleases.shift()(200, restoredPage(0, 'restored-page-40'));
    assert.equal(await command('eval', `document.querySelector('.session-row') === null`), 'true');
    harness.discoveryReleases.shift()();
    await waitForGate(() => harness.familyRequests.length === 5, 'restored cursor page');
    assert.deepEqual(harness.familyRequests[4], { limit: '40', cursor: 'restored-page-40', sort: 'updated-desc' });
    assert.equal(await command('eval', `document.querySelector('.session-row') === null && history.state.agentSessionLibrary.familyCount === 80`), 'true',
      'history restoration retains its requested count and publishes after all restored pages');
    harness.familyReleases.shift()(200, restoredPage(40, null));
    await waitForBrowser(command, `document.querySelectorAll('.session-row').length === 80`, 'all restored canonical rows');
    const restoredIds = JSON.parse(await command('eval', `[...document.querySelectorAll('.session-row')].map(row => row.getAttribute('href'))`));
    assert.deepEqual(restoredIds, Array.from({ length: 80 }, (_, index) => `/${provider}/session/restored-${index}`));

    await command('eval', `history.replaceState(null, '', '/sessions'); location.reload()`);
    await waitForGate(() => harness.familyRequests.length === 6 && harness.discoveryReleases.length === 1, 'fresh gated opening');
    await command('eval', `window.libraryUnhandledRejections = []; addEventListener('unhandledrejection', event => window.libraryUnhandledRejections.push(String(event.reason)))`);
    await command('eval', `history.pushState(null, '', '/${provider}/session/${sessionId}'); dispatchEvent(new PopStateEvent('popstate'))`);
    await waitForGate(() => harness.discoveryReleases.length === 2, 'Reader discovery request');
    harness.familyReleases.shift()(500);
    harness.discoveryReleases.shift()();
    harness.discoveryReleases.shift()();
    await waitForBrowser(command, `document.querySelector('.transcript')?.textContent.includes(${JSON.stringify(replyText)})`, 'Reader after stale Library response');
    assert.equal(await command('eval', `location.pathname === '/${provider}/session/${sessionId}' && !history.state?.agentSessionLibrary`), 'true',
      'stale prefetch does not publish Library history on the Reader route');
    assert.deepEqual(JSON.parse(await command('eval', `window.libraryUnhandledRejections`)), [],
      'an abandoned failed prefetch remains handled without affecting the Reader');

    await command('eval', `history.replaceState(null, '', '/sessions'); location.reload()`);
    await waitForGate(() => harness.familyRequests.length === 7 && harness.discoveryReleases.length === 1, 'Library refresh waiting for its prefetch');
    harness.discoveryReleases.shift()();
    await waitForBrowser(command, `performance.getEntriesByType('resource').some(entry => entry.name.endsWith('/api/providers'))`, 'completed provider discovery before route change');
    await command('eval', `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    assert.equal(await command('eval', `Boolean(document.querySelector('.loading-state'))`), 'true',
      'Library remains loading while refreshFamilies awaits its prefetched page after discovery');
    await command('eval', `history.pushState(null, '', '/${provider}/session/${sessionId}'); dispatchEvent(new PopStateEvent('popstate'))`);
    await waitForBrowser(command, `document.querySelector('.transcript')?.textContent.includes(${JSON.stringify(replyText)})`, 'Reader before abandoned successful family response');
    harness.familyReleases.shift()();
    await waitForBrowser(command, `performance.getEntriesByType('resource').some(entry => entry.name.includes('/api/v3/library/sessions'))`, 'abandoned family response completion');
    await command('eval', `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    assert.equal(await command('eval', `location.pathname === '/${provider}/session/${sessionId}' && !history.state?.agentSessionLibrary`), 'true',
      'a refresh awaiting its prefetched page loses publication ownership when the route changes');
  });

test('OpenCode opening reply remains readable after Runtime source navigation and Back',
  { skip: skipReason || false, timeout: 90_000 }, async t => {
    const harness = await startHarness(t);
    const command = await startBrowser(t, `${harness.origin}/${provider}/session/${sessionId}`);
    await waitForBrowser(command, `document.querySelector('#reader-title')`, 'the OpenCode Reader');
    await waitForBrowser(command,
      `document.querySelector('.transcript')?.textContent.includes(${JSON.stringify(replyText)}) &&
        document.querySelector('.transcript [data-message-id="later-item-63"]')`,
      'the preloaded readable opening reply on the initial 32-item bootstrap');
    assert.equal(harness.openingPageRequests, 1,
      'the first page leaves the opening assistant process-only, so the next page supplies the readable reply');

    await command('click', '.runtime-tab');
    await waitForBrowser(command, `document.querySelector('.runtime-events a[href^="#event?"]')`, 'Runtime Events source link');
    await command('click', '.runtime-events a[href^="#event?"]');
    await waitForBrowser(command,
      `location.hash.includes('messageId=process-tool-10') && document.querySelector('.conversation-tab[aria-current="page"]')`,
      'the Runtime event opened in Conversation');
    await command('back');
    await waitForBrowser(command,
      `location.hash === '' && document.querySelector('.conversation-tab[aria-current="page"]') &&
        !document.querySelector('.runtime-events')`,
      'the base Conversation view after browser Back');
    await waitForBrowser(command,
      `document.querySelector('.transcript')?.textContent.includes(${JSON.stringify(replyText)}) &&
        document.querySelector('.transcript [data-message-id="later-item-63"]')`,
      'the restored opening reply after browser Back');

    assert.equal(await command('eval',
      `document.querySelector('.transcript')?.textContent.includes(${JSON.stringify(replyText)})`),
    'true', 'Back to the base hash must retain the readable opening reply that was preloaded beyond bootstrap');
  });

test('direct Reader loading starts bootstrap while provider discovery is pending',
  { skip: skipReason || false, timeout: 90_000 }, async t => {
    const harness = await startHarness(t, true);
    const command = await startBrowser(t, `${harness.origin}/${provider}/session/${sessionId}`);
    await waitForBrowser(command,
      `document.querySelector('.transcript')?.textContent.includes(${JSON.stringify(replyText)})`,
      'the readable opening reply after independent initial requests');
    assert.equal(harness.bootstrapWhileDiscoveryPending, true,
      'provider discovery must not add its response latency before Reader data preparation starts');
  });

test('Reader retry retains successful provider discovery after a bootstrap failure',
  { skip: skipReason || false, timeout: 90_000 }, async t => {
    const harness = await startHarness(t, false, true);
    const command = await startBrowser(t, `${harness.origin}/${provider}/session/${sessionId}`);
    await waitForBrowser(command,
      `document.querySelector('.error-state')?.textContent.includes('The first Reader load failed.')`,
      'the explicit first Reader failure');
    await command('click', '.error-state button');
    await waitForBrowser(command,
      `document.querySelector('.transcript')?.textContent.includes(${JSON.stringify(replyText)})`,
      'the retried Reader without repeated discovery');
    assert.equal(harness.discoveryRequests, 1, 'a Reader failure must not discard already loaded provider discovery');
  });

test('initial canonical source fragment uses target bootstrap once and later hash/back keeps navigation behavior',
  { skip: skipReason || false, timeout: 90_000 }, async t => {
    const harness = await startHarness(t, false, false, true);
    const initialHash = '#event?messageId=target-reply-70&segment=message';
    const command = await startBrowser(t, `${harness.origin}/${provider}/session/${sessionId}${initialHash}`);
    const targetVisible = `(() => {
      const card = [...document.querySelectorAll('article.event-card')].find(article =>
        article.dataset.messageId + ' / ' + article.dataset.segment === 'target-reply-70 / message');
      const p = card?.querySelector('.event-body p');
      const rect = p?.getBoundingClientRect();
      return p?.textContent.includes('Selected public reply 70.') && rect.top >= 0 && rect.top < innerHeight;
    })()`;
    await waitForBrowser(command, targetVisible, 'the bootstrap-selected paragraph in the viewport');
    assert.equal(harness.targetedBootstrapRequests, 1);
    assert.deepEqual(harness.navigationRequests, { locate: 0, segments: 0, toc: 2 },
      'startup navigation uses the target bootstrap and automatically loads the remaining two TOC pages');
    assert.deepEqual(harness.tocRequests.map(request => request.limit), [512, 512],
      'continuous full-outline hydration uses bounded 512-entry requests');
    assert.equal(await command('eval', 'location.hash'), JSON.stringify(initialHash));
    assert.equal(await command('eval', `document.querySelector('.reader-outline')?.textContent.includes('Selected public reply 70.')`), 'true');
    assert.equal(await command('eval', `document.querySelector('.reader-page-controls:not(.reader-continue) button').disabled`), 'false');
    assert.equal(await command('eval', `document.querySelector('.transcript [data-message-id="target-reply-64"]') !== null && document.querySelector('.transcript [data-message-id="target-reply-95"]') !== null`), 'true',
      'the selected native page includes both canonical boundary events');
    await command('click', '.reader-page-controls:not(.reader-continue) > button');
    await waitForBrowser(command, `document.querySelector('.transcript')?.textContent.includes(${JSON.stringify(replyText)})`, 'the previously omitted middle segment');
    assert.equal(await command('eval', `document.querySelector('.transcript [data-message-id="opening-reply"]') !== null && document.querySelector('.transcript [data-message-id="target-reply-95"]') !== null`), 'true',
      'loading earlier messages retains the selected page and includes its preceding boundary');
    await command('click', '.reader-continue > button');
    await waitForBrowser(command, `document.querySelector('.transcript')?.textContent.includes('Recorded tail 100.')`, 'the final segment after the selected page');
    assert.equal(await command('eval', `document.querySelector('.transcript [data-message-id="opening-reply"]') !== null && document.querySelector('.transcript [data-message-id="tail-100"]') !== null && !document.querySelector('.reader-continue')`), 'true',
      'continuation retains the earlier boundary, reaches the final canonical event and removes the next-page control');
    await command('eval', `location.hash = '#event?messageId=process-tool-10&segment=tool'`);
    await waitForBrowser(command, `location.hash.includes('process-tool-10') && [...document.querySelectorAll('article.event-card')].some(article => article.dataset.messageId === 'process-tool-10' && article.dataset.segment === 'tool')`, 'later source navigation');
    await waitForBrowser(command, `document.querySelector('.reader-actions') && !document.querySelector('.content-error')`, 'later navigation completion');
    assert.ok(harness.navigationRequests.locate >= 1, 'a later source hash retains revision-bound locate');
    await command('back');
    await waitForBrowser(command, targetVisible, 'Back to the initial target paragraph');
    await command('eval', `history.pushState({}, '', location.pathname); dispatchEvent(new PopStateEvent('popstate'))`);
    await waitForBrowser(command, `location.hash === '' && document.querySelector('.transcript')?.textContent.includes(${JSON.stringify(replyText)})`, 'hash-clear opening reply');
    assert.equal(await command('eval', `document.querySelector('.transcript')?.textContent.includes('Selected public reply 70.')`), 'false');
    await waitForBrowser(command, `Math.abs(window.scrollY) <= 2`, 'hash-clear returns to the conversation start');
    const retainedTarget = '.reader-outline a[href="#event?messageId=target-reply-70&segment=message"]';
    assert.equal(await command('eval', `document.querySelector(${JSON.stringify(retainedTarget)})?.textContent.includes('Selected public reply 70.')`), 'true',
      'the session-wide outline retains the previously recorded canonical target');
    await command('click', retainedTarget);
    await waitForBrowser(command, `${targetVisible} && location.hash === ${JSON.stringify(initialHash)}`,
      'the retained outline link reopens the exact recorded target in the viewport');
  });

test('full-outline hydration uses 512 entries while an unseen canonical target keeps the default page size',
  { skip: skipReason || false, timeout: 90_000 }, async t => {
    const harness = await startHarness(t, false, false, false, true);
    const command = await startBrowser(t, `${harness.origin}/${provider}/session/${sessionId}`);
    await waitForBrowser(command,
      `document.querySelector('#reader-title') && document.querySelector('.reader-outline nav')?.getAttribute('aria-busy') === 'true'`,
      'the Reader with continuous outline hydration pending');
    assert.deepEqual(harness.tocRequests, [{ cursor: 'toc-page-32', limit: 512 }]);
    await command('eval', `location.hash = '#event?messageId=target-reply-70&segment=message'`);
    await waitForBrowser(command,
      `document.querySelector('.transcript [data-message-id="target-reply-70"]') && !document.querySelector('.content-error')`,
      'the unseen canonical target while full-outline hydration is pending');
    assert.ok(harness.tocRequests.some(request => request.cursor === 'toc-64' && request.limit === 64),
      'targeted outline lookup retains the bounded default 64-entry page');
    harness.releaseTocHydration();
    await waitForBrowser(command,
      `document.querySelector('.reader-outline nav')?.getAttribute('aria-busy') === 'false' && document.querySelector('.reader-outline a[href*="messageId=target-reply-95&"]')`,
      'the complete outline after continuous hydration resumes');
    assert.deepEqual(harness.tocRequests, [
      { cursor: 'toc-page-32', limit: 512 }, { cursor: 'toc-64', limit: 64 }, { cursor: 'toc-64', limit: 512 },
    ]);
  });

test('an explicitly empty initial source fragment preserves the invalid-target error',
  { skip: skipReason || false, timeout: 90_000 }, async t => {
    const harness = await startHarness(t, false, false, true);
    const command = await startBrowser(t, `${harness.origin}/${provider}/session/${sessionId}#event?`);
    await waitForBrowser(command, `document.querySelector('.error-state')?.textContent.includes('bootstrap target requires messageId and segment')`,
      'the explicit initial target error');
    assert.deepEqual(harness.navigationRequests, { locate: 0, segments: 0, toc: 0 });
  });
