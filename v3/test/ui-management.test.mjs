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
const sessionId = 'managed-session';
const binaryName = process.platform === 'win32'
  ? 'agent-browser-win32-x64.exe' : `agent-browser-${process.platform}-${process.arch}`;
const browserExe = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
  (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', binaryName))
    .find(existsSync);
const skip = !existsSync(path.join(uiDir, 'node_modules', 'vite'))
  ? 'Install the locked v3 UI dependencies.'
  : !browserExe || !existsSync(browserExe) ? 'agent-browser is required for browser QA.' : false;

function summary(title = 'Original title') {
  return { session: { provider: 'codex', sessionId }, title, directory: '/fixture',
    createdAt: 1, updatedAt: 1, messageCount: 1, tokenCount: null, parent: null };
}

function bootstrap(title) {
  const event = { provider: 'codex', sessionId, messageId: 'assistant', segment: 'message' };
  const item = { event, ordinal: 0, owner: null, role: 'assistant', timestamp: null,
    preview: 'The recorded response.', totalChars: 22, toolName: null, ownerMessageId: null, replyMetadata: null };
  return { session: summary(title), revision: 'managed-revision', totalItems: 1,
    segments: [{ id: 'segment-0', pageId: 'page-0', startOrdinal: 0, items: [item],
      ownerContext: null, previousCursor: null, nextCursor: null }],
    toc: { entries: [{ event, ordinal: 0, owner: null, label: item.preview }],
      previousCursor: null, nextCursor: null },
    relations: { taskCount: 0, observationCount: 0, firstCursor: null } };
}

async function freePort() {
  return freeFetchSafePort();
}

async function harness(t) {
  const { build } = createRequire(path.join(uiDir, 'package.json'))('vite');
  const buildDir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-ui-manage-'));
  await build({ root: uiDir, configFile: path.join(uiDir, 'vite.config.ts'),
    build: { outDir: buildDir, emptyOutDir: true }, logLevel: 'error' });
  const meta = { provider: 'codex', sessionId, customTitle: null, starred: false,
    deleted: false, permanent: false, timeStarred: null, timeDeleted: null,
    timeRenamed: null };
  const writes = [];
  let bootstrapRequests = 0;
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    const json = (body, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/providers') return json([{ id: 'codex', available: true, manageable: true }]);
    if (url.pathname === '/api/v3/sessions') return json(meta.deleted || meta.permanent ? [] : [summary(meta.customTitle || undefined)]);
    if (url.pathname === '/api/v3/library/sessions') {
      const rows = meta.deleted || meta.permanent ? [] : [summary(meta.customTitle || undefined)];
      return json({ families: rows.map(session => ({ session, matched: true, matchingCount: 1,
        childCount: 0, totalChildCount: 0, familyRootId: session.session.sessionId,
        familyUpdated: session.updatedAt, parentBoundary: null })), total: rows.length,
        matchingSessions: rows.length, sourceDiagnostics: [], nextCursor: null });
    }
    if (url.pathname === '/api/v3/meta') return json([meta]);
    if (url.pathname === '/api/v3/trash') return json(meta.deleted && !meta.permanent ? [meta] : []);
    if (url.pathname === `/api/v3/meta/codex/${sessionId}`) return json(meta);
    if (url.pathname === `/api/v3/reader/codex/${sessionId}/bootstrap`) {
      bootstrapRequests++;
      return json(bootstrap(meta.customTitle || 'Original title'));
    }
    const action = url.pathname.match(/^\/api\/codex\/session\/managed-session\/(star|rename|delete|restore|permanent-delete)$/);
    if (request.method === 'POST' && action) {
      let body = '';
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body);
      writes.push({ action: action[1], body: parsed, contentType: request.headers['content-type'] });
      if (action[1] === 'star') meta.starred = !meta.starred;
      if (action[1] === 'rename') meta.customTitle = parsed.title;
      if (action[1] === 'delete') meta.deleted = true;
      if (action[1] === 'restore') meta.deleted = false;
      if (action[1] === 'permanent-delete') { meta.deleted = true; meta.permanent = true; }
      return json(meta);
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
    await new Promise(resolve => server.close(resolve));
    await rm(buildDir, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${port}`, writes,
    get bootstrapRequests() { return bootstrapRequests; } };
}

async function browser(t, url) {
  const session = `agentsession-v3-manage-${process.pid}-${Date.now()}`;
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

test('Reader manages a Viewer star, custom title, and reversible exclusion',
  { skip, timeout: 60_000 }, async t => {
    const app = await harness(t);
    const command = await browser(t, `${app.origin}/sessions`);
    await waitFor(command, `document.querySelector('.session-row')`);
    await command('click', '.session-row');
    await waitFor(command, `document.querySelector('.reader-layout')`);
    await waitFor(command, `document.querySelector('.reader-star:not([disabled])')`);
    await command('click', '.reader-star');
    await waitFor(command, `document.querySelector('.reader-star')?.textContent.includes('Starred')`);
    await command('click', '.reader-rename');
    await command('fill', '.reader-rename-input', 'The saved title');
    await command('click', '.reader-rename-save');
    await waitFor(command, `document.querySelector('#reader-title')?.textContent === 'The saved title'`);
    await waitFor(command, `document.title.includes('The saved title')`);
    assert.equal(app.bootstrapRequests, 1,
      'Renaming metadata updates the tab title without rebuilding the Reader source projection');
    await command('click', '.reader-back-link');
    await waitFor(command, `document.querySelector('.session-row strong')?.textContent === 'The saved title'`);
    await command('click', '.session-row');
    await waitFor(command, `document.querySelector('#reader-title')?.textContent === 'The saved title'`);
    await command('reload');
    await waitFor(command, `document.querySelector('#reader-title')?.textContent === 'The saved title'`);
    await command('click', '.reader-delete');
    await waitFor(command, `location.pathname === '/sessions' && document.querySelector('.empty-state')`);
    await command('click', '[data-library-view="trash"]');
    await waitFor(command, `document.querySelector('.trash-row')`);
    await command('click', '.trash-restore');
    await waitFor(command, `!document.querySelector('.trash-row')`);
    await command('click', '[data-library-view="sessions"]');
    await waitFor(command, `document.querySelector('.session-row')`);
    await command('click', '.session-row');
    await waitFor(command, `document.querySelector('.reader-delete:not([disabled])')`);
    await command('click', '.reader-delete');
    await waitFor(command, `location.pathname === '/sessions'`);
    await command('click', '[data-library-view="trash"]');
    await waitFor(command, `document.querySelector('.trash-row')`);
    if (process.env.AGENTSESSION_V3_MANAGEMENT_SCREENSHOT) {
      await command('screenshot', process.env.AGENTSESSION_V3_MANAGEMENT_SCREENSHOT);
    }
    await command('click', '.trash-permanent');
    await waitFor(command, `!document.querySelector('.trash-row')`);
    assert.deepEqual(app.writes.map(write => write.action),
      ['star', 'rename', 'delete', 'restore', 'delete', 'permanent-delete']);
    assert.equal(app.writes[1].body.title, 'The saved title');
    assert.ok(app.writes.every(write => write.contentType?.startsWith('application/json')));
  });
