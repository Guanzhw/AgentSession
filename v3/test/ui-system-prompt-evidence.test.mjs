import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const uiDir = path.join(repo, 'v3', 'ui');
const sessionId = 'prompt-evidence-ui-session';
const browserName = process.platform === 'win32'
  ? 'agent-browser-win32-x64.exe' : `agent-browser-${process.platform}-${process.arch}`;
const browserExe = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
  (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', browserName))
    .find(existsSync);
const skip = !existsSync(path.join(uiDir, 'node_modules', 'vite'))
  ? 'Install the locked v3 UI dependencies.'
  : !browserExe || !existsSync(browserExe) ? 'The existing agent-browser binary is required for browser QA.' : false;

const ref = { provider: 'codex', sessionId };
const event = { ...ref, messageId: 'assistant-1', segment: 'message' };
const bootstrap = {
  session: { session: ref, title: 'Prompt evidence fixture', directory: '/fixture/project',
    createdAt: 1, updatedAt: 1, messageCount: 1, tokenCount: null, parent: null },
  revision: 'prompt-ui-revision', totalItems: 1,
  segments: [{ id: 'segment-1', pageId: 'page-1', startOrdinal: 0,
    items: [{ event, ordinal: 0, owner: null, role: 'assistant', timestamp: 1,
      preview: 'Reader content', totalChars: 14, toolName: null, ownerMessageId: null, replyMetadata: null,
      contentRevisions: {} }],
    ownerContext: null, previousCursor: null, nextCursor: null }],
  toc: { entries: [{ event, ordinal: 0, owner: null, label: 'Reader content' }],
    previousCursor: null, nextCursor: null },
  relations: { taskCount: 0, observationCount: 0, firstCursor: null },
};

const longRecorded = 'Recorded prompt body ' + 'x'.repeat(4_200) + '<img src=x onerror="window.__promptInjected=true">RECORDED-TAIL';
const evidence = {
  sessionId,
  mode: 'codex-recorded-and-current-local',
  hiddenPromptStored: true,
  selectedAgent: null,
  firstUserMessage: null,
  note: 'Recorded text and current files have different provenance; current files may differ from the historical runtime.',
  sections: [
    { title: 'Stored System Prompt', note: 'Prompt text persisted with this session.', items: [
      { kind: 'system-prompt', title: 'Base instructions', preview: 'Recorded prompt body', content: longRecorded,
        source: 'session_meta.base_instructions', sourcePath: null,
        sourceMetadata: { model: 'fixture-model', sourceField: 'session_meta.base_instructions' },
        provenance: 'recorded', resolution: 'resolved', time: 1 },
    ] },
    { title: 'Current Local Instructions', note: 'Currently resolvable local files; historical use is not proven.', items: [
      { kind: 'instruction', title: 'AGENTS.md', preview: 'Current local rules',
        content: '<img src=x onerror="window.__promptInjected=true">Current local rules',
        source: '/fixture/project/AGENTS.md', sourcePath: '/fixture/project/AGENTS.md',
        sourceMetadata: null, provenance: 'current-local', resolution: 'resolved', time: 2 },
    ] },
  ],
  diagnostics: [
    { code: 'hidden_prompt_unavailable',
      message: 'Provider-hidden or unrecorded prompt text cannot be recovered from local session data.', source: null },
    { code: 'instruction_unreadable', message: 'A local instruction source could not be read.',
      source: '/fixture/project/CLAUDE.md' },
    { code: 'instruction_unreadable', message: 'A second recorded resolution attempt failed.',
      source: '/fixture/project/CLAUDE.md' },
  ],
};

async function freePort() {
  for (let attempt = 0; attempt < 64; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 40_000);
    const server = createNetServer();
    try {
      await new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      return port;
    } catch (cause) {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      if (cause?.code !== 'EADDRINUSE') throw cause;
    }
  }
  throw new Error('Could not find a free browser test port between 20000 and 59999.');
}

async function harness(t) {
  const { build } = createRequire(path.join(uiDir, 'package.json'))('vite');
  const buildDir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-ui-prompts-'));
  await build({ root: uiDir, configFile: path.join(uiDir, 'vite.config.ts'),
    build: { outDir: buildDir, emptyOutDir: true }, logLevel: 'error' });
  let promptRequests = 0;
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    const json = body => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/providers') return json([{ id: 'codex', available: true }]);
    if (url.pathname === `/api/v3/reader/codex/${sessionId}/bootstrap`) return json(bootstrap);
    if (url.pathname === `/api/v3/reader/codex/${sessionId}/executions`) {
      return json({ session: ref, revision: bootstrap.revision, coverage: 'partial',
        events: [], nextCursor: null, scannedEvents: 0 });
    }
    if (url.pathname === `/api/v3/runtime/codex/${sessionId}/events`) {
      return json({ session: ref, revision: bootstrap.revision, coverage: 'partial', events: [], nextCursor: null, scannedEvents: 0 });
    }
    if (url.pathname === `/api/v3/resume/codex/${sessionId}`) {
      return json({ allowTerminalLaunch: false, available: false, diagnostic: 'Resume unavailable', command: null });
    }
    if (url.pathname === `/api/v3/meta/codex/${sessionId}`) return json(null);
    if (url.pathname === `/api/codex/session/${sessionId}/system-prompts`) {
      promptRequests++;
      return json(evidence);
    }
    if (url.pathname.startsWith('/api/')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }));
      return;
    }
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
  return { origin: `http://127.0.0.1:${port}`, get promptRequests() { return promptRequests; } };
}

async function openBrowser(t, url) {
  const session = `agentsession-v3-prompts-${process.pid}-${Date.now()}`;
  const command = (...args) => new Promise((resolve, reject) => {
    const child = spawn(browserExe, ['--session', session, ...args], {
      cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`agent-browser ${args[0]} timed out`)); }, 15_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout));
    });
  });
  t.after(async () => { try { await command('close'); } catch { /* Browser may already be closed. */ } });
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

test('Reader reveals bounded source-backed prompt evidence on request', { skip, timeout: 60_000 }, async t => {
  const app = await harness(t);
  const browserPort = Number(new URL(app.origin).port);
  assert.ok(browserPort >= 20_000 && browserPort <= 59_999, 'The browser test port avoids browser-reserved low ports');
  const command = await openBrowser(t, `${app.origin}/codex/session/${sessionId}`);
  await waitFor(command, `document.querySelector('.reader-layout')`);
  await command('eval', 'window.__promptInjected = false');
  assert.equal(app.promptRequests, 0, 'The evidence API remains untouched while its disclosure is closed');
  await command('click', '.reader-session-details > summary');
  await waitFor(command, `document.querySelector('.prompt-evidence-toggle')`);
  assert.ok((await command('get', 'text', '.reader-main')).includes('AI instructions'));

  await command('click', '.prompt-evidence-toggle');
  await waitFor(command, `document.querySelector('.prompt-evidence-content')?.textContent.includes('Current local sources')`);
  assert.equal(app.promptRequests, 1, 'Opening the disclosure loads evidence once');

  const panelText = await command('get', 'text', '.prompt-evidence-content');
  assert.match(panelText, /Recorded with this session/);
  assert.match(panelText, /Current local sources/);
  assert.match(panelText, /session_meta\.base_instructions/);
  assert.match(panelText, /\/fixture\/project\/AGENTS\.md/);
  assert.match(panelText, /Provider-hidden or unrecorded prompt text cannot be recovered/);
  assert.equal(await command('eval', `document.querySelector('[data-code="instruction_unreadable"]') !== null`), 'true');
  assert.match(panelText, /Instruction Unreadable/);
  assert.match(panelText, /\/fixture\/project\/CLAUDE\.md/);
  assert.match(panelText, /A second recorded resolution attempt failed/);
  assert.equal(await command('get', 'count', '[data-code="instruction_unreadable"]'), '2');

  await command('click', '.prompt-evidence-item summary');
  await waitFor(command, `document.querySelector('.prompt-evidence-item')?.textContent.includes('Reveal next')`);
  assert.equal(await command('eval', `document.querySelector('.prompt-evidence-metadata').open === false`), 'true',
    'Source metadata stays behind its own disclosure');
  await command('click', '.prompt-evidence-metadata summary');
  await waitFor(command, `document.querySelector('.prompt-evidence-metadata')?.textContent.includes('fixture-model')`);
  assert.match(await command('get', 'text', '.prompt-evidence-metadata'), /fixture-model/);
  let itemText = await command('get', 'text', '.prompt-evidence-item');
  assert.match(itemText, /Recorded prompt body/);
  assert.doesNotMatch(itemText, /RECORDED-TAIL/);
  assert.match(itemText, /Reveal next/);
  await command('click', '.prompt-evidence-reveal');
  await waitFor(command, `document.querySelector('.prompt-evidence-item')?.textContent.includes('RECORDED-TAIL')`);
  itemText = await command('get', 'text', '.prompt-evidence-item');
  assert.match(itemText, /RECORDED-TAIL/);
  assert.equal(await command('eval', `document.querySelector('.prompt-evidence-panel img') === null && window.__promptInjected === false`), 'true',
    'Provider text must render as text rather than executable HTML');
});
