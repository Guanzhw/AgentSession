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
const childId = 'codex-inherited-ui-child';
const rootId = 'codex-inherited-ui-root';
const parentId = 'codex-inherited-ui-parent';
const dshSeededId = 'dsh-seeded-no-parent-ui';
const dshUnseededId = 'dsh-unseeded-ui';
const revision = 'codex-inherited-ui-revision';
const readerRevision = 'codex-complete-record-prefix-revision';
const longBody = 'Inherited long field ' + 'x'.repeat(2_250) + ' END_OF_INHERITED_UI_FIELD';

function agentBrowserBinary() {
  const override = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN;
  if (override && existsSync(override)) return override;
  const binaryName = process.platform === 'win32'
    ? 'agent-browser-win32-x64.exe'
    : 'agent-browser-' + process.platform + '-' + process.arch;
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(entry, 'node_modules', 'agent-browser', 'bin', binaryName);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const agentBrowserExe = agentBrowserBinary();
const skipReason = !existsSync(path.join(uiDir, 'node_modules', 'vite'))
  ? 'Install the locked v3/ui dependencies before running the Reader browser test.'
  : !agentBrowserExe
    ? 'The agent-browser CLI is required; the test does not install it or download a browser.'
    : false;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function freePort() {
  return freeFetchSafePort();
}

function readerBootstrap(sessionId, provider = 'codex') {
  const parent = provider === 'codex' && sessionId === childId ? { provider: 'codex', sessionId: parentId } : null;
  const event = { provider, sessionId, messageId: 'duplicate', segment: 'message' };
  const item = { event, ordinal: 0, owner: null, role: 'user', timestamp: null,
    preview: 'Owned child conversation stays in the Reader.', totalChars: 45, toolName: null, replyMetadata: null,
    contentRevisions: {} };
  return {
    session: { session: { provider, sessionId }, title: sessionId === childId ? 'Codex child fixture'
      : sessionId === dshSeededId ? 'DSH seeded fixture'
        : sessionId === dshUnseededId ? 'DSH unseeded fixture' : 'Codex root fixture',
      directory: '/public/codex-fixture', createdAt: null, updatedAt: null,
      messageCount: 1, tokenCount: null, parent },
    revision: readerRevision,
    totalItems: 1,
    segments: [{ id: 'segment-0', pageId: 'page-0', startOrdinal: 0, items: [item],
      ownerContext: null, previousCursor: null, nextCursor: null }],
    toc: { entries: [{ event, ordinal: 0, owner: null, label: item.preview }], previousCursor: null, nextCursor: null },
    ...(sessionId === rootId ? { relations: { taskCount: 0, observationCount: 1, firstCursor: 'root-relations' } } : {}),
  };
}

function inheritedItems(start, end) {
  return Array.from({ length: end - start }, (_, index) => {
    const ordinal = start + index;
    const isLong = ordinal === 44 || ordinal === 46;
    return {
      ordinal,
      messageId: ordinal === 5 || ordinal === 44 || ordinal === 45 ? 'duplicate'
        : ordinal === 46 ? 'source-change' : 'inherited-' + ordinal,
      segment: 'message',
      role: 'system',
      preview: ordinal === 44 ? 'Inherited context for repeated id (row 44).'
        : ordinal === 45 ? 'Inherited context for repeated id (row 45).'
          : ordinal === 46 ? 'A source revision error is tested for this row.'
            : 'Inherited developer context ' + ordinal,
      totalChars: isLong ? (ordinal === 44 ? longBody.length : 2_300) : 40,
      timestamp: null,
      toolName: null,
    };
  });
}

async function startHarness(t, { changedNextRevision = false, changedContentRevision = false, wrongSource = false } = {}) {
  const requireFromUi = createRequire(path.join(uiDir, 'package.json'));
  const { build } = requireFromUi('vite');
  const buildDir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-inherited-context-'));
  await build({ root: uiDir, configFile: path.join(uiDir, 'vite.config.ts'),
    build: { outDir: buildDir, emptyOutDir: true }, logLevel: 'error' });

  const listRequests = [];
  const contentRequests = [];
  let invalidCursorOnce = !changedNextRevision;
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url || '/', 'http://' + (request.headers.host || '127.0.0.1'));
    const json = (body, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/providers') {
      json([{ id: 'codex', available: true }, { id: 'deepseek-harness', available: true }]);
      return;
    }
    const bootstrapMatch = url.pathname.match(/^\/api\/v3\/reader\/([^/]+)\/([^/]+)\/bootstrap$/);
    if (bootstrapMatch) {
      json(readerBootstrap(decodeURIComponent(bootstrapMatch[2]), decodeURIComponent(bootstrapMatch[1])));
      return;
    }
    if (/^\/api\/v3\/resume\/(codex|deepseek-harness)\//.test(url.pathname)) {
      json({ allowTerminalLaunch: false, available: false, diagnostic: null, command: null });
      return;
    }
    if (url.pathname.startsWith('/api/v3/meta/codex/') || url.pathname.startsWith('/api/v3/meta/deepseek-harness/')) {
      json(null);
      return;
    }
    if (url.pathname === '/api/v3/reader/codex/' + rootId + '/relations') {
      json({ session: { provider: 'codex', sessionId: rootId }, revision: readerRevision,
        entries: [], childPlacements: [{ child: { provider: 'codex', sessionId: childId },
          afterEvent: { provider: 'codex', sessionId: rootId, messageId: 'duplicate', segment: 'message' },
          sourceEventId: 'mock-spawn', diagnostic: null }], nextCursor: null });
      return;
    }
    const listMatch = url.pathname.match(/^\/api\/v3\/reader\/([^/]+)\/([^/]+)\/inherited-context$/);
    if (listMatch) {
      const provider = decodeURIComponent(listMatch[1]);
      const sessionId = decodeURIComponent(listMatch[2]);
      const cursor = url.searchParams.get('cursor');
      listRequests.push({ provider, sessionId, limit: url.searchParams.get('limit'), cursor });
      if (provider === 'deepseek-harness' && sessionId === dshUnseededId) {
        response.writeHead(204).end();
        return;
      }
      if (provider === 'deepseek-harness' && sessionId === dshSeededId) {
        json({ session: { provider, sessionId }, revision, scope: 'inherited-context',
          sourceSession: null, totalItems: 1, items: [{ ordinal: 0, messageId: 'dsh-prefix', segment: 'message',
            role: 'user', preview: 'DSH_INHERITED_WITHOUT_PARENT', totalChars: 29, timestamp: null, toolName: null }],
          nextCursor: null });
        return;
      }
      if (provider !== 'codex' || sessionId !== childId) {
        json({ error: { code: 'not_found', message: 'This child has no inherited context.' } }, 404);
        return;
      }
      if (cursor === 'page-40' && invalidCursorOnce) {
        invalidCursorOnce = false;
        json({ error: { code: 'invalid_cursor', message: 'The inherited context cursor is invalid.' } }, 400);
        return;
      }
      const items = cursor === 'page-40' ? inheritedItems(40, 51) : inheritedItems(0, 40);
      json({ session: { provider, sessionId },
        revision: changedNextRevision && cursor ? 'changed-inherited-revision' : revision, scope: 'inherited-context',
        sourceSession: { provider: 'codex', sessionId: wrongSource ? 'different-parent' : parentId }, totalItems: 51, items,
        nextCursor: cursor === 'page-40' ? null : 'page-40' });
      return;
    }
    const contentMatch = url.pathname.match(/^\/api\/v3\/reader\/codex\/([^/]+)\/inherited-context\/content$/);
    if (contentMatch) {
      const ordinal = Number(url.searchParams.get('ordinal'));
      const offset = Number(url.searchParams.get('offset'));
      const maxChars = Number(url.searchParams.get('maxChars'));
      const messageId = url.searchParams.get('messageId');
      contentRequests.push({ sessionId: decodeURIComponent(contentMatch[1]), ordinal, messageId,
        segment: url.searchParams.get('segment'), field: url.searchParams.get('field'), offset, maxChars,
        revision: url.searchParams.get('revision') });
      if (url.searchParams.get('revision') !== revision || ordinal === 46) {
        json({ error: { code: 'source_changed', message: 'The inherited source revision changed.' } }, 409);
        return;
      }
      if (url.searchParams.get('field') !== 'body' || messageId !== 'duplicate' ||
        !Number.isInteger(ordinal) || !Number.isInteger(offset) || !Number.isInteger(maxChars)) {
        json({ error: { code: 'invalid_request', message: 'The inherited content request is invalid.' } }, 400);
        return;
      }
      const textSource = ordinal === 44 ? longBody : 'This is the content for repeated message row 45.';
      const text = textSource.slice(offset, offset + maxChars);
      const nextOffset = offset + text.length < textSource.length ? offset + text.length : null;
      json({ revision: changedContentRevision ? 'changed-content-revision' : revision, text, offset, totalChars: textSource.length, nextOffset, truncated: nextOffset !== null });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      json({ error: { code: 'not_found', message: 'Mock endpoint not found.' } }, 404);
      return;
    }
    const asset = url.pathname === '/' || !url.pathname.startsWith('/assets/')
      ? path.join(buildDir, 'index.html')
      : path.resolve(buildDir, '.' + url.pathname);
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

  const port = await freePort();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(() => resolve()));
    await rm(buildDir, { recursive: true, force: true });
  });
  return { origin: 'http://127.0.0.1:' + port, listRequests, contentRequests };
}

async function startBrowser(t, url) {
  const session = 'agentsession-v3-inherited-context-' + process.pid + '-' + Date.now();
  const command = (...args) => new Promise((resolve, reject) => {
    const child = spawn(agentBrowserExe, ['--session', session, ...args], {
      cwd: repo, windowsHide: true, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('agent-browser ' + args.join(' ') + ' timed out'));
    }, 15_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error('agent-browser ' + args.join(' ') + ' failed (' + code + '): ' + (stderr || stdout)));
      else resolve(stdout.trim());
    });
  });
  t.after(async () => { try { await command('close'); } catch { /* Browser may already be closed. */ } });
  await command('open');
  await command('eval', 'window.location.href = ' + JSON.stringify(url));
  return { command };
}

async function waitForBrowser(command, predicate, description) {
  const deadline = Date.now() + 10_000;
  let last = '';
  while (Date.now() < deadline) {
    last = await command('eval', 'Boolean(' + predicate + ')');
    if (last.includes('true')) return;
    await sleep(80);
  }
  throw new Error('Timed out waiting for ' + description + '. Last browser result: ' + last);
}

test('Codex child Reader keeps inherited context separate, bounded, continuable, and explicit about source errors',
  { skip: skipReason || false, timeout: 90_000 }, async t => {
    const harness = await startHarness(t);
    const { command } = await startBrowser(t, harness.origin + '/codex/session/' + childId);
    await waitForBrowser(command,
      "document.querySelector('#reader-title')?.textContent.trim() === 'Codex child fixture'",
      'the Codex child Reader');

    assert.equal(Number(await command('get', 'count', '.inherited-context')), 1,
      'A Codex child with a recorded parent has a separate inherited-context section');
    assert.equal(await command('eval', "document.querySelector('.inherited-context-details').open"), 'false',
      'The inherited-context list starts collapsed');
    assert.equal(harness.listRequests.length, 0, 'The bounded inherited list loads only when opened');
    assert.equal(Number(await command('get', 'count', '.reader-outline nav a')), 1,
      'The child outline contains only its owned event');

    await command('click', '.inherited-context-details > summary');
    await waitForBrowser(command,
      "document.querySelectorAll('.inherited-context-item').length === 40",
      'the first bounded inherited-context page');
    assert.equal(await command('eval', "document.querySelector('.inherited-context-details').open"), 'true',
      'Loading the first page preserves the user-opened context disclosure');
    assert.deepEqual(harness.listRequests[0], { provider: 'codex', sessionId: childId, limit: '40', cursor: null },
      'The UI requests at most 40 inherited rows for the canonical child ID');
    assert.match(await command('get', 'text', '.inherited-context-source'), new RegExp(parentId),
      'The section names its explicit parent source');
    assert.match(await command('get', 'text', '.inherited-context-count'), /40 of 51/);
    assert.equal(Number(await command('get', 'count', '.reader-outline nav a')), 1,
      'Inherited records do not enter the owned outline');
    assert.equal(await command('eval', "document.querySelector('.reader-main .transcript').textContent.includes('Inherited developer context')"), 'false',
      'Inherited records do not enter the owned transcript');
    assert.equal(await command('eval', "document.querySelectorAll('.inherited-context-item[id^=event-], .inherited-context-item a[href*=\"#event\"]').length"), '0',
      'Inherited rows create no owned event anchors or Reader event links');

    await command('click', '.inherited-context-next');
    await waitForBrowser(command,
      "document.querySelector('.inherited-context-error strong')?.textContent.includes('cursor is invalid')",
      'the invalid-cursor state');
    assert.equal(Number(await command('get', 'count', '.inherited-context-item')), 40,
      'A failed page keeps the already loaded inherited records visible');
    assert.equal(Number(await command('get', 'count', '.inherited-context-error button')), 1,
      'The cursor error offers an explicit restart');
    await command('click', '.inherited-context-error button');
    await waitForBrowser(command,
      "document.querySelectorAll('.inherited-context-item').length === 40 && !document.querySelector('.inherited-context-error')",
      'the first-page restart after an invalid cursor');
    assert.deepEqual(harness.listRequests.map(row => row.cursor), [null, 'page-40', null]);

    await command('click', '.inherited-context-next');
    await waitForBrowser(command,
      "document.querySelectorAll('.inherited-context-item').length === 51",
      'the second inherited-context page');
    assert.match(await command('get', 'text', '.inherited-context-count'), /51 of 51/);
    assert.equal(Number(await command('get', 'count', '.inherited-context-next')), 0,
      'The next-page control disappears at the end of the inherited list');

    const duplicateRow = '.inherited-context-item[data-ordinal="44"]';
    await command('click', duplicateRow + ' > .inherited-context-record > summary');
    await command('click', duplicateRow + ' button.read-more');
    const firstChunk = JSON.stringify(longBody.slice(0, 2048));
    const bodySelector = JSON.stringify(duplicateRow + ' .inherited-context-body');
    await waitForBrowser(command,
      'document.querySelector(' + bodySelector + ')?.textContent === ' + firstChunk,
      'the first bounded content page for the selected inherited row');
    await command('click', duplicateRow + ' button.read-more');
    await waitForBrowser(command,
      'document.querySelector(' + bodySelector + ')?.textContent === ' + JSON.stringify(longBody),
      'the complete inherited long field');
    assert.deepEqual(harness.contentRequests.map(row => [row.ordinal, row.messageId, row.offset, row.maxChars]),
      [[44, 'duplicate', 0, 2048], [44, 'duplicate', 2048, 2048]],
      'Content continuation carries the selected ordinal to disambiguate repeated inherited message IDs');
    assert.ok(harness.contentRequests.every(row => row.revision === revision),
      'Inherited content uses the strict list revision rather than the differing Reader revision');
    assert.ok(longBody.endsWith('END_OF_INHERITED_UI_FIELD'));

    const changedRow = '.inherited-context-item[data-ordinal="46"]';
    await command('click', changedRow + ' > .inherited-context-record > summary');
    await command('click', changedRow + ' button.read-more');
    await waitForBrowser(command,
      "document.querySelector('.inherited-context-error strong')?.textContent === 'Source revision changed'",
      'the source-revision error');
    assert.equal(Number(await command('get', 'count', '.inherited-context-error button')), 1,
      'The source-change error offers a session refresh');
    assert.equal(Number(await command('get', 'count', '.inherited-context-item')), 51,
      'A content revision failure leaves the already read list visible with an explicit error');

    await command('eval', 'window.location.href = ' + JSON.stringify(harness.origin + '/codex/session/' + rootId));
    await waitForBrowser(command,
      "document.querySelector('#reader-title')?.textContent.trim() === 'Codex root fixture'",
      'the Codex root Reader');
    assert.equal(Number(await command('get', 'count', '.inherited-context')), 0,
      'A Codex root does not show a child-only inherited-context section');
    assert.equal(harness.listRequests.length, 4,
      'Opening a Codex root does not call the inherited-context route');
    await waitForBrowser(command, "document.querySelector('.inline-child-toggle') !== null",
      'the inline child placement');
    await command('click', '.inline-child-toggle');
    await waitForBrowser(command,
      "document.querySelector('.inline-child-reader .inherited-context') !== null",
      'the inline Codex child Reader');
    assert.equal(harness.listRequests.length, 4,
      'The inline inherited list remains collapsed until opened');
    await command('click', '.inline-child-reader .inherited-context-details > summary');
    await waitForBrowser(command,
      "document.querySelectorAll('.inline-child-reader .inherited-context-item').length === 40",
      'the inline child inherited-context page');
    assert.equal(harness.listRequests.length, 5,
      'The inline child pane requests inherited context using the child session ID');
    assert.equal(harness.listRequests[4].sessionId, childId);

    await command('eval', 'window.location.href = ' + JSON.stringify(harness.origin + '/deepseek-harness/session/' + dshSeededId));
    await waitForBrowser(command,
      "document.querySelector('#reader-title')?.textContent.trim() === 'DSH seeded fixture' && document.querySelector('.inherited-context') !== null",
      'the seeded DSH Reader disclosure without a parent ID');
    assert.deepEqual(harness.listRequests[5], {
      provider: 'deepseek-harness', sessionId: dshSeededId, limit: '40', cursor: null,
    }, 'DSH probes one bounded inherited page to discover recorded seed context');
    assert.match(await command('get', 'text', '.inherited-context-source'), /no recorded source session ID/,
      'the disclosure explains that the source session identity is absent');
    await command('click', '.inherited-context-details > summary');
    await waitForBrowser(command,
      "document.querySelector('.inherited-context-item-preview')?.textContent.includes('DSH_INHERITED_WITHOUT_PARENT')",
      'the copied DSH prefix in the separate Reader section');

    await command('eval', 'window.location.href = ' + JSON.stringify(harness.origin + '/deepseek-harness/session/' + dshUnseededId));
    await waitForBrowser(command,
      "document.querySelector('#reader-title')?.textContent.trim() === 'DSH unseeded fixture'",
      'the unseeded DSH Reader');
    const discoveryDeadline = Date.now() + 10_000;
    while (harness.listRequests.length < 7 && Date.now() < discoveryDeadline) await sleep(40);
    assert.equal(harness.listRequests[6].sessionId, dshUnseededId,
      'The UI uses one bounded request to check whether a DSH prefix exists');
    assert.equal(Number(await command('get', 'count', '.inherited-context')), 0,
      'A DSH source without a copied prefix does not show an empty disclosure or error');
  });


test('inherited pane rejects changed continuation revisions and exact source identity mismatches',
  { skip: skipReason || false, timeout: 90_000 }, async t => {
    const harness = await startHarness(t, { changedNextRevision: true });
    const { command } = await startBrowser(t, harness.origin + '/codex/session/' + childId);
    await waitForBrowser(command, "document.querySelector('.inherited-context-details')", 'child inherited disclosure');
    await command('click', '.inherited-context-details > summary');
    await waitForBrowser(command, "document.querySelectorAll('.inherited-context-item').length === 40", 'first inherited domain page');
    await command('click', '.inherited-context-next');
    await waitForBrowser(command, "document.querySelector('.inherited-context-error strong')?.textContent === 'Source revision changed'", 'changed inherited continuation');
    assert.equal(Number(await command('get', 'count', '.inherited-context-item')), 40,
      'a changed revision cannot append records to the established inherited generation');

    const identityHarness = await startHarness(t, { wrongSource: true });
    await command('eval', 'window.location.href = ' + JSON.stringify(identityHarness.origin + '/codex/session/' + childId));
    await waitForBrowser(command, "document.querySelector('.inherited-context-details')", 'fresh child inherited disclosure');
    await command('click', '.inherited-context-details > summary');
    await waitForBrowser(command, "document.querySelector('.inherited-context-error')?.textContent.includes('recorded session identity')", 'exact parent identity rejection');
    assert.equal(Number(await command('get', 'count', '.inherited-context-item')), 0);
  });

test('inherited content rejects a success response from a different revision',
  { skip: skipReason || false, timeout: 90_000 }, async t => {
    const harness = await startHarness(t, { changedContentRevision: true });
    const { command } = await startBrowser(t, harness.origin + '/codex/session/' + childId);
    await waitForBrowser(command, "document.querySelector('.inherited-context-details')", 'child inherited disclosure');
    await command('click', '.inherited-context-details > summary');
    await waitForBrowser(command, "document.querySelectorAll('.inherited-context-item').length === 40", 'first inherited domain page');
    await command('click', '.inherited-context-next');
    await waitForBrowser(command, "document.querySelector('.inherited-context-error button')", 'cursor restart');
    await command('click', '.inherited-context-error button');
    await waitForBrowser(command, "document.querySelectorAll('.inherited-context-item').length === 40 && !document.querySelector('.inherited-context-error')", 'restarted first page');
    await command('click', '.inherited-context-next');
    await waitForBrowser(command, "document.querySelectorAll('.inherited-context-item').length === 51", 'second inherited domain page');
    const row = '.inherited-context-item[data-ordinal="44"]';
    await command('click', row + ' > .inherited-context-record > summary');
    await command('click', row + ' button.read-more');
    await waitForBrowser(command, "document.querySelector('.inherited-context-error strong')?.textContent === 'Source revision changed'", 'changed inherited content revision');
    assert.equal(harness.contentRequests[0].revision, revision);
    assert.equal(await command('eval', 'document.querySelector(' + JSON.stringify(row + ' .inherited-context-body') + ').textContent.includes("END_OF_INHERITED_UI_FIELD")'), 'false');
  });
