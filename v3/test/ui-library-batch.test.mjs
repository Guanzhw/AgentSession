import { onCleanup, temporaryDirectory } from '../../test/helpers/fixture-cleanup.mjs';
import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const uiDir = path.join(repo, 'v3', 'ui');
const binaryName = process.platform === 'win32'
  ? 'agent-browser-win32-x64.exe' : `agent-browser-${process.platform}-${process.arch}`;
const browserExe = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
  (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', binaryName))
    .find(existsSync);
const skip = !existsSync(path.join(uiDir, 'node_modules', 'vite'))
  ? 'Install the locked v3 UI dependencies.'
  : !browserExe || !existsSync(browserExe) ? 'agent-browser is required for browser QA.' : false;

function node(provider, id, parent = null, childCount = 0, boundary = null) {
  const session = { session: { provider, sessionId: id }, title: id, directory: '/project',
    createdAt: 1, updatedAt: 1, messageCount: 1, tokenCount: null, parent };
  return { session, matched: true, matchingCount: 1, childCount, totalChildCount: childCount,
    familyRootId: id, familyUpdated: 1, parentBoundary: boundary };
}

async function harness(t, { paged = false, diagnostics = false } = {}) {
  const { build } = createRequire(path.join(uiDir, 'package.json'))('vite');
  const buildDir = await temporaryDirectory(t, path.join(os.tmpdir(), 'agentsession-v3-ui-batch-'));
  await build({ root: uiDir, configFile: path.join(uiDir, 'vite.config.ts'),
    build: { outDir: buildDir, emptyOutDir: true }, logLevel: 'error' });
  const writes = [];
  const listRequests = [];
  const hidden = new Set();
  let rejectNext = false;
  const diagnosticRoot = node('codex', 'diagnostic-root');
  diagnosticRoot.session.diagnostic = 'codex_multiple_source_files_unmerged';
  const roots = [node('codex', 'root-a', null, diagnostics ? 2 : 1), node('claude-code', 'root-b'),
    node('pi', 'unmanaged'), node('codex', 'orphan', { provider: 'codex', sessionId: 'missing' }, 0, 'missing-parent'),
    ...(diagnostics ? [diagnosticRoot] : []),
    ...(paged ? Array.from({ length: 101 }, (_, index) => node('codex', `extra-${index}`)) : [])];
  const child = node('claude-code', 'child-a', { provider: 'codex', sessionId: 'root-a' });
  const diagnosticChild = node('codex', 'diagnostic-child', { provider: 'codex', sessionId: 'root-a' });
  diagnosticChild.session.diagnostic = 'codex_multiple_source_files_unmerged';
  const json = (response, body, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    if (url.pathname === '/api/providers') return json(response, [
      { id: 'codex', available: true, manageable: true },
      { id: 'claude-code', available: true, manageable: true },
      { id: 'pi', available: true, manageable: false },
    ]);
    if (url.pathname === '/api/v3/library/sessions') {
      listRequests.push(Object.fromEntries(url.searchParams));
      const search = url.searchParams.get('search') || '';
      const candidates = roots.filter(row => !hidden.has(`${row.session.session.provider}/${row.session.session.sessionId}`));
      const rows = candidates.filter(row => !search || row.session.title.includes(search));
      const offset = paged ? Number(url.searchParams.get('cursor') || 0) : 0;
      const page = paged ? rows.slice(offset, offset + 40) : rows;
      return json(response, { families: page, total: rows.length, matchingSessions: rows.length,
        sourceDiagnostics: [], nextCursor: paged && offset + 40 < rows.length ? String(offset + 40) : null });
    }
    if (url.pathname === '/api/v3/library/children') {
      const children = [child, ...(diagnostics ? [diagnosticChild] : [])]
        .filter(row => !hidden.has(`${row.session.session.provider}/${row.session.session.sessionId}`));
      return json(response, { parent: roots[0], children, total: children.length, nextCursor: null });
    }
    if (url.pathname === '/api/v3/search') {
      const query = url.searchParams.get('q') || '';
      const matches = roots.filter(row => row.session.title.includes(query)
        && !hidden.has(`${row.session.session.provider}/${row.session.session.sessionId}`))
        .map(row => ({ session: row.session.session, event: null, matchField: 'content',
          matchRole: 'user', snippet: row.session.title, title: row.session.title,
          directory: row.session.directory, updatedAt: 1, untrustedContent: true }));
      return json(response, { matches, diagnostics: [], nextCursor: null, truncated: false });
    }
    if (url.pathname === '/api/sessions/batch' && request.method === 'POST') {
      let body = '';
      for await (const part of request) body += part;
      const parsed = JSON.parse(body);
      writes.push({ ...parsed, contentType: request.headers['content-type'], origin: request.headers.origin });
      if (rejectNext) { rejectNext = false; return json(response, { error: { message: 'Saved metadata is unavailable.' } }, 503); }
      if (parsed.action === 'delete') for (const item of parsed.items) hidden.add(`${item.provider}/${item.id}`);
      return json(response, { ok: true, affected: parsed.items.length, skipped: 0 });
    }
    if (url.pathname.startsWith('/api/')) return json(response, { error: { code: 'not_found' } }, 404);
    const asset = url.pathname.startsWith('/assets/')
      ? path.resolve(buildDir, `.${url.pathname}`) : path.join(buildDir, 'index.html');
    if (!asset.startsWith(buildDir + path.sep) && asset !== path.join(buildDir, 'index.html')) {
      response.writeHead(400).end(); return;
    }
    if (!existsSync(asset)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': asset.endsWith('.html') ? 'text/html; charset=utf-8'
      : asset.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' });
    response.end(readFileSync(asset));
  });

  onCleanup(t, async () => {
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
  });
  const port = await freeFetchSafePort();
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${port}`, writes, listRequests,
    rejectOnce() { rejectNext = true; } };
}

async function browser(t, url) {
  const session = `agentsession-v3-batch-${process.pid}-${Date.now()}`;
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

test('diagnostic root and child remain visible but cannot enter a batch write',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t, { diagnostics: true });
    const command = await browser(t, `${app.origin}/sessions`);
    await waitFor(command, `document.querySelector('.session-row strong')`);
    await command('click', '[data-family-toggle="codex/root-a"]');
    await waitFor(command, `document.querySelector('[data-family-toggle="codex/root-a"]')?.getAttribute('aria-expanded') === 'true' &&
      document.querySelectorAll('.family-child-row').length === 2`);
    await command('click', '[data-library-manage]');
    assert.equal(await command('eval', `document.querySelector('[data-batch-select="codex/diagnostic-root"]')?.disabled`), 'true');
    assert.equal(await command('eval', `document.querySelector('[data-batch-select="codex/diagnostic-child"]')?.disabled`), 'true');
    await command('click', '[data-batch-select-all]');
    await waitFor(command, `document.querySelector('[data-batch-count]')?.textContent.includes('4')`);
    await command('click', '[data-batch-action="star"]');
    await waitFor(command, `document.querySelector('[data-batch-feedback]')?.textContent.includes('4')`);
    assert.equal(app.writes.length, 1);
    assert.equal(app.writes[0].items.length, 4);
    assert.ok(app.writes[0].items.every(item => !item.id.startsWith('diagnostic-')));
    assert.equal(await command('eval', `!!document.querySelector('[data-batch-select="codex/diagnostic-root"]')`), 'false',
      'management closes after a successful write');
    assert.equal(await command('eval', `!!document.querySelector('.source-diagnostic')`), 'true',
      'diagnostic history remains visibly represented in the refreshed Library');
  });

test('select all includes every loaded page without a client cap and a new page clears old selection',
  { skip, timeout: 90_000 }, async t => {
    const app = await harness(t, { paged: true });
    const command = await browser(t, `${app.origin}/sessions`);
    await waitFor(command, `document.querySelectorAll('.session-row').length === 39`);
    await command('click', '[data-library-manage]');
    await command('click', '[data-batch-select="codex/root-a"]');
    await command('click', '.family-more');
    await waitFor(command, `document.querySelectorAll('.session-row').length === 79 &&
      document.querySelector('[data-batch-count]')?.textContent.includes('0')`);
    await command('click', '.family-more');
    await waitFor(command, `document.querySelectorAll('.session-row').length === 104`);
    await command('click', '[data-batch-select-all]');
    await waitFor(command, `document.querySelector('[data-batch-count]')?.textContent.includes('104')`);
    await command('click', '[data-batch-action="star"]');
    await waitFor(command, `document.querySelector('[data-batch-feedback]')?.textContent.includes('104')`);
    assert.equal(app.writes[0].items.length, 104);
    assert.equal(new Set(app.writes[0].items.map(item => `${item.provider}/${item.id}`)).size, 104);
  });

test('global Library batch manages loaded canonical rows and confirms delete',
  { skip, timeout: 90_000 }, async t => {
    const app = await harness(t);
    const command = await browser(t, `${app.origin}/sessions`);
    await waitFor(command, `document.querySelectorAll('.session-row').length === 3`);
    await command('click', '[data-family-toggle="codex/root-a"]');
    await waitFor(command, `document.querySelector('.family-child-row')`);
    await command('click', '[data-library-manage]');
    await waitFor(command, `document.querySelectorAll('[data-batch-select]').length === 5`);
    if (process.env.AGENTSESSION_V3_BATCH_SCREENSHOT) {
      await command('screenshot', process.env.AGENTSESSION_V3_BATCH_SCREENSHOT);
    }
    await command('click', '[data-search-mode="content"]');
    await command('click', '[data-search-mode="sessions"]');
    assert.equal(JSON.parse(await command('eval', `document.querySelector('[data-library-manage]')?.getAttribute('aria-pressed')`)), 'false',
      'content search exits batch management');
    await command('click', '[data-library-manage]');
    await command('click', '[data-library-view="trash"]');
    await command('click', '[data-library-view="sessions"]');
    assert.equal(JSON.parse(await command('eval', `document.querySelector('[data-library-manage]')?.getAttribute('aria-pressed')`)), 'false',
      'trash exits batch management');
    await command('click', '[data-library-manage]');
    assert.equal(await command('eval', `document.querySelector('[data-batch-select="pi/unmanaged"]').disabled`), 'true');
    await command('click', '[data-batch-select-all]');
    await waitFor(command, `document.querySelector('[data-batch-count]')?.textContent.includes('4')`);
    await command('click', '[data-batch-action="star"]');
    await waitFor(command, `document.querySelector('[data-batch-feedback]')?.textContent.includes('4')`);
    assert.deepEqual(app.writes[0].items, [
      { provider: 'codex', id: 'root-a' }, { provider: 'claude-code', id: 'child-a' },
      { provider: 'claude-code', id: 'root-b' }, { provider: 'codex', id: 'orphan' },
    ]);
    assert.equal(app.writes[0].action, 'star');
    assert.match(app.writes[0].contentType, /^application\/json/);
    assert.equal(app.listRequests.at(-1).sort, 'updated-desc');

    await command('click', '[data-library-manage]');
    await command('click', '[data-batch-select="codex/root-a"]');
    await waitFor(command, `document.querySelector('[data-batch-count]')?.textContent.includes('1')`);
    await command('fill', 'form.list-toolbar input[type="search"]', 'root-b');
    await waitFor(command, `document.querySelectorAll('.session-row').length === 1 &&
      document.querySelector('[data-batch-count]')?.textContent.includes('0')`);
    await command('click', '[data-batch-select="claude-code/root-b"]');
    app.rejectOnce();
    await command('click', '[data-batch-action="unstar"]');
    await waitFor(command, `document.querySelector('[data-batch-error]')?.textContent.includes('Saved metadata is unavailable.')`);
    assert.equal(await command('eval', `document.querySelector('[data-batch-count]')?.textContent.includes('1')`), 'true');
    await command('click', '[data-batch-action="unstar"]');
    await waitFor(command, `document.querySelector('[data-batch-feedback]')?.textContent.includes('1')`);
    assert.equal(app.writes[2].action, 'unstar');
    assert.equal(app.listRequests.at(-1).search, 'root-b', 'success refreshes with the active query');
    await command('fill', 'form.list-toolbar input[type="search"]', '');
    await waitFor(command, `document.querySelectorAll('.session-row').length === 3`);
    await command('click', '[data-search-mode="content"]');
    await command('fill', 'form.list-toolbar input[type="search"]', 'root-b');
    await command('click', '.search-submit');
    await waitFor(command, `document.querySelector('.search-result strong')?.textContent === 'root-b'`);
    await command('click', '[data-search-mode="sessions"]');
    await waitFor(command, `document.querySelectorAll('.session-row').length === 3`);
    await command('click', '[data-library-manage]');
    await command('click', '[data-batch-select-all]');
    await command('click', '[data-batch-action="delete"]');
    await waitFor(command, `document.querySelector('[data-batch-confirm-delete]')`);
    assert.equal(app.writes.length, 3, 'opening confirmation does not write');
    await command('click', '[data-batch-action="delete"]');
    assert.equal(app.writes.length, 3, 'repeating Delete does not confirm it');
    await command('click', '[data-batch-dismiss-delete]');
    assert.equal(app.writes.length, 3, 'dismissal does not write');
    await command('click', '[data-batch-action="delete"]');
    await command('click', '[data-batch-confirm-delete]');
    await waitFor(command, `document.querySelector('[data-batch-feedback]')?.textContent.includes('4')`);
    assert.equal(app.writes[3].action, 'delete');
    await waitFor(command, `document.querySelectorAll('.session-row').length === 1 &&
      document.querySelector('.session-row')?.getAttribute('href') === '/pi/session/unmanaged'`);
    assert.equal(await command('get', 'text', '.session-row strong'), 'Untitled conversation',
      'a source identity used as a placeholder title stays separate from the canonical session link');
    await command('click', '[data-search-mode="content"]');
    await waitFor(command, `!document.querySelector('.search-result') &&
      document.querySelector('.list-footnote')?.textContent.includes('root-b')`);
  });
