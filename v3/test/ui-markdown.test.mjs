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
const sessionId = 'markdown-reader';
const markdown = [
  '# Safe heading',
  '',
  '- First item',
  '- Second item',
  '',
  'Intro ' + 'x'.repeat(1240),
  '',
  '```ts',
  'const literal = "<script>alert(1)</script>";',
  '```',
  '',
  '| Name | Result |',
  '| --- | --- |',
  '| Reader | complete |',
  '',
  '[Safe link](https://example.com/docs) and [unsafe link](javascript:alert(1)).',
  '',
  '<img src=x onerror=alert(1)>',
  '',
  'The final marker remains visible: MARKDOWN_END.',
].join('\n');
const toolOutput = '# Tool output stays literal\n- not a Reader list';

function agentBrowserBinary() {
  const override = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN;
  if (override && existsSync(override)) return override;
  const name = process.platform === 'win32' ? 'agent-browser-win32-x64.exe'
    : `agent-browser-${process.platform}-${process.arch}`;
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(entry, 'node_modules', 'agent-browser', 'bin', name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const agentBrowserExe = agentBrowserBinary();
const skipReason = !existsSync(path.join(uiDir, 'node_modules', 'vite'))
  ? 'Install locked v3/ui dependencies.'
  : !agentBrowserExe ? 'The agent-browser CLI is required for browser QA.' : false;

async function freePort() {
  return freeFetchSafePort();
}

async function harness(t) {
  const { build } = createRequire(path.join(uiDir, 'package.json'))('vite');
  const buildDir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-markdown-'));
  await build({ root: uiDir, configFile: path.join(uiDir, 'vite.config.ts'),
    build: { outDir: buildDir, emptyOutDir: true }, logLevel: 'error' });
  const reference = (messageId, segment) => ({ provider: 'codex', sessionId, messageId, segment });
  const items = [
    { event: reference('assistant-markdown', 'message'), ordinal: 0, owner: null,
      role: 'assistant', timestamp: null, preview: markdown.slice(0, 240),
      totalChars: markdown.length, toolName: null, ownerMessageId: null, replyMetadata: null, contentRevisions: {} },
    { event: reference('tool-plain', 'tool'), ordinal: 1, owner: null,
      role: 'tool', timestamp: null, preview: 'read: ' + toolOutput.slice(0, 20),
      totalChars: toolOutput.length, toolName: 'read', ownerMessageId: null, replyMetadata: null, contentRevisions: {} },
  ];
  const summary = { session: { provider: 'codex', sessionId }, title: 'Markdown Reader',
    directory: null, createdAt: null, updatedAt: null, messageCount: 2,
    tokenCount: null, parent: null };
  const bootstrap = { session: summary, revision: 'markdown-revision', totalItems: 2,
    segments: [{ id: 'segment-0', pageId: 'page-0', startOrdinal: 0, items,
      ownerContext: null, previousCursor: null, nextCursor: null }],
    toc: { entries: items.map(item => ({ event: item.event, ordinal: item.ordinal,
      owner: item.owner, label: item.preview })), previousCursor: null, nextCursor: null },
    relations: { taskCount: 0, observationCount: 0, firstCursor: null } };
  const requests = [];
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    const json = (body, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/providers') return json([{ id: 'codex', available: true }]);
    if (url.pathname === `/api/v3/reader/codex/${sessionId}/bootstrap`) return json(bootstrap);
    if (url.pathname === `/api/v3/reader/codex/${sessionId}/content`) {
      const field = url.searchParams.get('field');
      const offset = Number(url.searchParams.get('offset'));
      const maxChars = Number(url.searchParams.get('maxChars'));
      const source = field === 'body' ? markdown : field === 'toolOutput' ? toolOutput : '';
      requests.push({ field, offset });
      if (!source || !Number.isInteger(offset) || !Number.isInteger(maxChars)) {
        return json({ error: { code: 'invalid_request' } }, 400);
      }
      const text = source.slice(offset, offset + maxChars);
      const nextOffset = offset + text.length < source.length ? offset + text.length : null;
      return json({ text, offset, totalChars: source.length, nextOffset, truncated: nextOffset !== null });
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
  return { origin: `http://127.0.0.1:${port}`, requests };
}

async function browser(t, url) {
  const session = `agentsession-v3-markdown-${process.pid}-${Date.now()}`;
  const command = (...args) => new Promise((resolve, reject) => {
    const child = spawn(agentBrowserExe, ['--session', session, ...args],
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

test('Reader safely renders Markdown through continuation while tool output remains plain',
  { skip: skipReason || false, timeout: 60_000 }, async t => {
    const app = await harness(t);
    const command = await browser(t, `${app.origin}/codex/session/${sessionId}`);
    await waitFor(command, `document.querySelector('.assistant-card .event-body')`);
    assert.equal(Number(await command('get', 'count', '.assistant-card .event-body h1')), 1);
    assert.equal(Number(await command('get', 'count', '.assistant-card .event-body li')), 2);
    await waitFor(command, `document.querySelector('.assistant-card .event-body')?.textContent.length > 1000 &&
      document.querySelector('.assistant-card button.read-more:not([disabled])')`);
    assert.deepEqual(app.requests.filter(request => request.field === 'body').map(request => request.offset), [0],
      'the Reader automatically loads the initial source page');
    await command('click', '.assistant-card button.read-more');
    await waitFor(command, `document.querySelector('.assistant-card .event-body')?.textContent.includes('MARKDOWN_END') &&
      !document.querySelector('.assistant-card button.read-more')`);
    assert.equal(Number(await command('get', 'count', '.assistant-card .event-body pre code')), 1);
    assert.equal(Number(await command('get', 'count', '.assistant-card .event-body table tbody tr')), 1);
    assert.equal(Number(await command('get', 'count', '.assistant-card .event-body a[href="https://example.com/docs"]')), 1);
    assert.equal(Number(await command('get', 'count', '.assistant-card .event-body a[href^="javascript:"]')), 0);
    assert.equal(Number(await command('get', 'count', '.assistant-card .event-body img')), 0);
    assert.equal(Number(await command('get', 'count', '.assistant-card .event-body script')), 0);
    const text = await command('get', 'text', '.assistant-card .event-body');
    assert.match(text, /<img src=x onerror=alert\(1\)>/);
    assert.match(text, /MARKDOWN_END/);
    await command('click', '.tool-card .tool-disclosure > summary');
    await command('click', '.tool-card details.tool-field:nth-child(2) summary');
    await waitFor(command, `document.querySelector('.tool-card details.tool-field:nth-child(2) .event-body')?.textContent === ${JSON.stringify(toolOutput)} &&
      !document.querySelector('.tool-card details.tool-field:nth-child(2) button.read-more')`);
    assert.equal(Number(await command('get', 'count', '.tool-card .event-body h1')), 0);
    assert.deepEqual(app.requests.filter(request => request.field === 'body').map(request => request.offset), [0, 1400]);
    if (process.env.AGENTSESSION_V3_MARKDOWN_SCREENSHOT) {
      await command('eval', 'window.scrollTo(0, 0)');
      await command('screenshot', process.env.AGENTSESSION_V3_MARKDOWN_SCREENSHOT);
    }
  });
