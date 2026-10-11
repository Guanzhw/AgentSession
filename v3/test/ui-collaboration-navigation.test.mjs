import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const ui = path.join(repo, 'v3/ui');
const browserName = process.platform === 'win32' ? 'agent-browser-win32-x64.exe'
  : `agent-browser-${process.platform}-${process.arch}`;
const browserExe = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN || (process.env.PATH || '')
  .split(path.delimiter).map(dir => path.join(dir, 'node_modules/agent-browser/bin', browserName)).find(existsSync);
const skip = !existsSync(path.join(ui, 'node_modules/vite')) ? 'Install locked UI dependencies.'
  : !browserExe || !existsSync(browserExe) ? 'agent-browser is required.' : false;
const root = 'timeline-root', child = 'timeline-child', grandchild = 'timeline-grandchild';
const session = sessionId => ({ provider: 'codex', sessionId });
const event = (sessionId, messageId) => ({ ...session(sessionId), messageId, segment: 'message' });
const revision = id => `revision-${id}`;
const rows = id => ['request', 'dispatch', 'returned', 'message'].map((name, ordinal) => {
  const preview = `${id} ${name} recorded content`;
  return { event: event(id, name), ordinal, owner: null, role: ordinal === 0 ? 'user' : 'assistant',
    timestamp: null, preview, totalChars: preview.length, toolName: null, replyMetadata: null,
    presentationPhase: null, processId: null, processCount: null, contentRevisions: {} };
});
const nextChild = id => id === root ? child : id === child ? grandchild : null;
const placement = id => nextChild(id) ? [{ child: session(nextChild(id)), afterEvent: event(id, 'dispatch'),
  sourceEventId: `${id}-started`, diagnostic: null }] : [];
function relations(id) {
  if (!nextChild(id)) return [];
  const observation = (kind, state, extra = {}) => ({ type: 'coordination', observation: {
    kind, state, eventId: `${id}-${kind}-${state}`, correlationId: `${id}-spawn`,
    fromSessionRef: session(id), toSessionRef: null, fromActorPath: `/root/${id}`, toActorPath: `/root/${nextChild(id)}`,
    readerEvent: event(id, 'dispatch'), provenance: { fidelity: 'recorded', sourceType: 'fixture', sourceId: state },
    ...extra,
  } });
  return [observation('spawn', 'requested'), observation('spawn', 'started', { toSessionRef: session(nextChild(id)) }),
    observation('result', 'completed', { fromSessionRef: session(nextChild(id)), toSessionRef: session(id), readerEvent: event(id, 'returned') }),
    observation('message', 'queued', { correlationId: `${id}-message`, messageExcerpt: 'A recorded agent message.',
      messageExcerptTruncated: false, readerEvent: event(id, 'message') })];
}
function locate(id, name) {
  const item = rows(id).find(row => row.event.messageId === name);
  return item ? { session: session(id), revision: revision(id), event: item.event, ordinal: item.ordinal,
    owner: null, pageCursor: `${id}-page`, tocCursor: `${id}-toc` } : null;
}
function bootstrap(id, target) {
  const items = rows(id);
  const toc = { entries: items.map(item => ({ event: item.event, ordinal: item.ordinal, owner: item.owner,
    role: item.role, label: item.preview, processId: item.processId, processCount: item.processCount })),
    previousCursor: null, nextCursor: null };
  return { session: { session: session(id), title: id, directory: '/public/timeline-navigation',
    createdAt: null, updatedAt: null, messageCount: items.length, tokenCount: null,
    parent: id === root ? null : session(id === child ? root : child) }, revision: revision(id), totalItems: items.length,
    segments: [{ id: `${id}-segment`, pageId: `${id}-page`, startOrdinal: 0, items, ownerContext: null, previousCursor: null, nextCursor: null }],
    toc, openingToc: toc, ...(target ? { targetLocation: locate(id, target) } : {}),
    relations: { taskCount: 0, observationCount: relations(id).length, firstCursor: nextChild(id) ? `${id}-relations` : null } };
}

async function harness(t) {
  const require = createRequire(path.join(ui, 'package.json'));
  const { build } = require('vite');
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-timeline-navigation-'));
  await build({ root: ui, configFile: path.join(ui, 'vite.config.ts'),
    build: { outDir, emptyOutDir: true }, logLevel: 'error' });
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push(url.pathname + url.search);
    const json = (body, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (url.pathname === '/api/providers') return json([{ id: 'codex', available: true }]);
    const match = url.pathname.match(/^\/api\/v3\/(reader|runtime|meta|resume)\/codex\/([^/]+)(?:\/([^/]+))?$/);
    if (match) {
      const [, domain, id, action] = match;
      if (![root, child, grandchild].includes(id)) return json({ error: { code: 'not_found', message: 'Unknown session.' } }, 404);
      if (domain === 'meta') return json(null);
      if (domain === 'resume') return json({ allowTerminalLaunch: false, available: false, diagnostic: null, command: null });
      if (domain === 'runtime') return json({ session: session(id), revision: revision(id), coverage: 'partial',
        events: [], nextCursor: null, scannedEvents: 0 });
      if (action === 'bootstrap') return json(bootstrap(id, url.searchParams.get('messageId')));
      if (action === 'relations') return json({ session: session(id), revision: revision(id),
        entries: relations(id), childPlacements: placement(id), nextCursor: null });
      if (action === 'locate') {
        const location = locate(id, url.searchParams.get('messageId'));
        return location && url.searchParams.get('revision') === revision(id) ? json(location)
          : json({ error: { code: 'not_found', message: 'No event in this session.' } }, 404);
      }
      if (action === 'child-location') {
        const found = placement(id).find(row => row.child.sessionId === url.searchParams.get('childSessionId'));
        return found ? json({ session: session(id), revision: revision(id), placement: found,
          location: locate(id, 'dispatch'), diagnostic: null }) : json({ error: { code: 'not_found', message: 'No direct child.' } }, 404);
      }
    }
    if (url.pathname.startsWith('/api/')) return json({ error: { code: 'not_found', message: 'No fixture route.' } }, 404);
    const asset = url.pathname.startsWith('/assets/') ? path.join(outDir, url.pathname) : path.join(outDir, 'index.html');
    if (!existsSync(asset)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': asset.endsWith('.js') ? 'text/javascript' : asset.endsWith('.css') ? 'text/css' : 'text/html' });
    response.end(readFileSync(asset));
  });
  const port = await freeFetchSafePort();
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(outDir, { recursive: true, force: true }); });
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}
async function browser(t, url) {
  const name = `timeline-navigation-${process.pid}-${Date.now()}`;
  const command = (...args) => new Promise((resolve, reject) => {
    const process = spawn(browserExe, ['--session', name, ...args], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    process.stdout.on('data', chunk => { stdout += chunk; }); process.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => { process.kill(); reject(new Error(`Browser ${args[0]} timed out`)); }, 20_000);
    process.once('error', error => { clearTimeout(timeout); reject(error); });
    process.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout)); });
  });
  t.after(async () => { try { await command('close'); } catch {} });
  await command('open', url); await command('set', 'viewport', '1280', '900');
  await wait(command, `document.querySelector('.inline-child-toggle')`, 'root child placement');
  return command;
}
async function wait(command, expression, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await command('eval', `Boolean(${expression})`)).includes('true')) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const evaluate = async (command, expression) => JSON.parse(await command('eval', expression));
async function openChildTimeline(command) {
  await command('click', '.inline-child-toggle');
  await wait(command, `document.querySelector('.inline-child-reader .inline-child-toggle')`, 'grandchild placement');
  await command('click', '.collaboration-launcher');
  await wait(command, `document.querySelector('.collaboration-handoff[data-collaboration-handoff="${child}-spawn"]')`, 'child timeline');
  await command('click', `.collaboration-handoff[data-collaboration-handoff="${child}-spawn"] .collaboration-child-node`);
}

test('child collaboration timeline preserves nested paths and canonical event navigation', { skip, timeout: 180_000 }, async t => {
  const app = await harness(t);
  await t.test('opening a grandchild preserves both inline ancestors', async t => {
    const command = await browser(t, `${app.origin}/codex/session/${root}`);
    await openChildTimeline(command);
    assert.equal(await evaluate(command, `Boolean(document.querySelector('.collaboration-timeline .collaboration-handoff'))`), true,
      'the recorded child remains visible in the collaboration graph');
    assert.equal(await evaluate(command, `document.querySelector('.collaboration-handoff-actions a').getAttribute('href')`),
      `/codex/session/${grandchild}`, 'the visible child action retains a canonical link');
    await command('click', `.collaboration-handoff[data-collaboration-handoff="${child}-spawn"] .collaboration-handoff-actions a`);
    const actual = await evaluate(command, `JSON.parse(new URLSearchParams(location.hash.slice(7)).get('path'))`);
    assert.deepEqual(actual, [session(child), session(grandchild)], 'grandchild navigation retains the direct child ancestor');
    await wait(command, `document.querySelectorAll('.inline-child-reader').length === 2`, 'nested child reader');
    assert.deepEqual(await evaluate(command, `[...document.querySelectorAll('.inline-child-heading code')].map(el => el.textContent)`),
      [child, grandchild]);
  });
  for (const [name, selector] of [['dispatch', '.collaboration-handoff-actions button'], ['returned', '.collaboration-return button'], ['message', '.collaboration-messages button']]) {
    await t.test(`child ${name} opens its canonical session event and Back restores the pane`, async t => {
      const command = await browser(t, `${app.origin}/codex/session/${root}`);
      await openChildTimeline(command);
      if (name === 'message') await command('click', '.collaboration-message-disclosure summary');
      const before = app.requests.length;
      await command('click', `.collaboration-timeline ${selector}`);
      await wait(command, `document.querySelector('#reader-title')?.textContent === '${child}'`, 'canonical child Reader');
      assert.equal(await evaluate(command, 'location.pathname'), `/codex/session/${child}`, 'the child owns this event');
      const query = await evaluate(command, `Object.fromEntries(new URLSearchParams(location.hash.slice(7)))`);
      assert.deepEqual(query, { messageId: name, segment: 'message' });
      assert.equal(app.requests.slice(before).some(request => request.startsWith(`/api/v3/reader/codex/${root}/locate?`)), false,
        'a foreign source event never uses the root locate endpoint');
      await command('back');
      await wait(command, `location.pathname.endsWith('/${root}') && document.querySelector('.inline-child-reader')`, 'Back restores the root and inline child');
      assert.deepEqual(await evaluate(command, `JSON.parse(new URLSearchParams(location.hash.slice(7)).get('path'))`), [session(child)]);
    });
  }
});
