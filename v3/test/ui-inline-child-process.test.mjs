import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { appendFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const fixture = path.join(repo, 'v3', 'fixtures', 'codex-three-level', 'sessions');
const rootId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const childId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const childFile = `rollout-2026-09-27T00-01-00-${childId}.jsonl`;
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const uiDir = path.join(repo, 'v3', 'ui');

function browserBinary() {
  if (process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN) return process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN;
  const name = process.platform === 'win32' ? 'agent-browser-win32-x64.exe'
    : `agent-browser-${process.platform}-${process.arch}`;
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(entry, 'node_modules', 'agent-browser', 'bin', name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function browserCommand(executable, session, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--session', session, ...args],
      { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`agent-browser ${args[0]} timed out: ${output}`)); }, 15_000);
    child.once('exit', code => {
      clearTimeout(timer);
      code === 0 ? resolve(output.trim()) : reject(new Error(output));
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

async function freePort() {
  return freeFetchSafePort();
}

async function waitFor(command, expression, label) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if ((await command('eval', expression)).includes('true')) return;
    await pause(100);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function presentation(scope, reasoning = 'child-process-reasoning / thinking', tool = 'CHILD_PROCESS_TOOL / tool') {
  return `(() => {
    const transcript = document.querySelector(${JSON.stringify(scope)});
    const processes = [...(transcript?.querySelectorAll('details.reader-process') ?? [])];
    const cards = [...(transcript?.querySelectorAll('article.event-card') ?? [])];
    const source = name => cards.filter(article => article.dataset.messageId + ' / ' + article.dataset.segment === name);
    return { count: processes.length, processCount: processes[0]?.getAttribute('data-reader-process-count'),
      collapsed: processes[0]?.open === false,
      emptyVisible: [...(transcript?.querySelectorAll('article.assistant-card .empty-body') ?? [])]
        .some(node => node.closest('details.reader-process')?.open !== false),
      replyVisible: transcript?.innerText.includes('Child process final reply') ?? false,
      unknownVisible: transcript?.innerText.includes('Child unknown phase stays visible') ?? false,
      reasoningSources: source(${JSON.stringify(reasoning)}).length,
      toolSources: source(${JSON.stringify(tool)}).length,
      reasoningAttached: source(${JSON.stringify(reasoning)})[0]?.closest('.attached-reasoning') !== null,
      toolAttached: source(${JSON.stringify(tool)})[0]?.closest('.attached-tools') !== null,
      ownershipBranches: transcript?.querySelectorAll('.tool-branch').length,
      ownershipBorders: [...(transcript?.querySelectorAll('.attached-tools, .tool-stack') ?? [])]
        .map(node => getComputedStyle(node).borderLeftStyle) };
  })()`;
}

test('inline child Reader groups normalized process work like its direct Reader',
  { timeout: 60_000, skip: !existsSync(binary) || !browserBinary() }, async t => {
    const originals = (await import('node:fs')).readdirSync(path.join(fixture, '2026', '09', '27'))
      .map(name => path.join(fixture, '2026', '09', '27', name));
    const hashes = originals.map(sha256);
    await mkdir(path.join(repo, 'tmp'), { recursive: true });
    const scratch = await mkdtemp(path.join(repo, 'tmp', 'v3-inline-child-process-'));
    const codex = path.join(scratch, 'codex');
    await cp(fixture, path.join(codex, 'sessions'), { recursive: true });
    const copiedChild = path.join(codex, 'sessions', '2026', '09', '27', childFile);
    const rows = (await readFile(copiedChild, 'utf8')).trimEnd().split('\n');
    const toolInput = JSON.stringify({ cmd: 'echo child process', detail: 'CHILD_PROCESS_INPUT '.repeat(180) });
    const toolOutput = 'CHILD_PROCESS_OUTPUT '.repeat(180);
    const record = (timestamp, payload) => JSON.stringify({ timestamp, type: 'response_item', payload });
    rows.push(
      record('2026-09-27T00:02:00.000Z', { type: 'message', id: 'child-process-request', role: 'user',
        content: [{ type: 'input_text', text: 'Check the child process.' }] }),
      record('2026-09-27T00:02:01.000Z', { type: 'message', id: 'child-process-empty', role: 'assistant',
        content: [], phase: 'commentary' }),
      record('2026-09-27T00:02:02.000Z', { type: 'reasoning', id: 'child-process-reasoning',
        summary: [{ type: 'summary_text', text: 'Child process recorded reasoning' }] }),
      record('2026-09-27T00:02:03.000Z', { type: 'function_call', call_id: 'CHILD_PROCESS_TOOL',
        name: 'exec_command', arguments: toolInput }),
      record('2026-09-27T00:02:04.000Z', { type: 'function_call_output', call_id: 'CHILD_PROCESS_TOOL',
        output: toolOutput }),
      record('2026-09-27T00:02:05.000Z', { type: 'message', id: 'child-process-final', role: 'assistant',
        content: [{ type: 'output_text', text: 'Child process final reply' }], phase: 'final_answer' }),
      record('2026-09-27T00:02:06.000Z', { type: 'message', id: 'child-process-unknown', role: 'assistant',
        content: [{ type: 'output_text', text: 'Child unknown phase stays visible' }], phase: 'future_phase' }),
    );
    await writeFile(copiedChild, rows.join('\n') + '\n');
    let copiedHash = sha256(copiedChild);
    const dirs = ['claude', 'pi', 'dsh', 'meta', 'index', 'cache'];
    await Promise.all(dirs.map(name => mkdir(path.join(scratch, name))));
    const port = await freePort();
    const server = spawn(binary, ['serve', '--port', String(port), '--codex-dir', codex,
      '--opencode-db', path.join(scratch, 'absent.db'), '--claude-dir', path.join(scratch, 'claude'),
      '--pi-dir', path.join(scratch, 'pi'), '--dsh-dir', path.join(scratch, 'dsh'),
      '--meta-dir', path.join(scratch, 'meta'), '--index-dir', path.join(scratch, 'index'),
      '--cache-dir', path.join(scratch, 'cache')], { cwd: repo, windowsHide: true, stdio: 'ignore' });
    const session = `v3-inline-process-${process.pid}-${Date.now()}`;
    const command = (...args) => browserCommand(browserBinary(), session, ...args);
    t.after(async () => {
      try { await command('close'); } catch { /* Browser may already be closed. */ }
      if (server.exitCode === null) { const closed = once(server, 'close'); server.kill(); await Promise.race([closed, pause(3000)]); }
      assert.deepEqual(originals.map(sha256), hashes);
      assert.equal(sha256(copiedChild), copiedHash);
      const resolved = await realpath(scratch);
      assert.equal(path.dirname(resolved), await realpath(path.join(repo, 'tmp')));
      await rm(resolved, { recursive: true, force: true });
    });
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${origin}/api/providers`, { signal: AbortSignal.timeout(500) })).ok) {
        ready = true; break;
      } } catch { /* Server is indexing. */ }
      await pause(100);
    }
    assert.ok(ready);
    const childReader = `${origin}/api/v3/reader/codex/${childId}/bootstrap`;
    const bootstrap = await (await fetch(childReader)).json();
    const data = bootstrap.segments[0].items;
    const empty = data.find(item => item.event.messageId === 'child-process-empty');
    assert.equal(empty, undefined, 'Codex normalization does not emit a source message with no body');
    assert.equal(typeof data.find(item => item.event.messageId === 'child-process-reasoning')?.processId, 'number',
      'The normalized reasoning carries a process ID');
    assert.equal(data.find(item => item.event.messageId === 'child-process-final')?.processId, null);
    assert.equal(data.find(item => item.event.messageId === 'child-process-unknown')?.processId, null);

    await command('open');
    await command('eval', `window.location.href = ${JSON.stringify(`${origin}/codex/session/${childId}`)}`);
    await waitFor(command, `Boolean(document.querySelector('.transcript details.reader-process'))`, 'direct process');
    const direct = JSON.parse(await command('eval', presentation('.transcript')));
    assert.equal(direct.collapsed, true);
    assert.equal(direct.emptyVisible, false);
    assert.equal(direct.replyVisible, true);
    assert.equal(direct.unknownVisible, true);
    assert.equal(direct.reasoningSources, 1);
    assert.equal(direct.toolSources, 1);

    await command('eval', `window.location.href = ${JSON.stringify(`${origin}/codex/session/${rootId}`)}`);
    await waitFor(command, `Boolean(document.querySelector('.inline-child-toggle'))`, 'child insertion point');
    await command('eval', `document.querySelector('.inline-child-toggle').click()`);
    await waitFor(command, `Boolean(document.querySelector('.inline-child-transcript article'))`, 'inline child');
    const inline = JSON.parse(await command('eval', presentation('.inline-child-transcript')));
    assert.equal(inline.count, direct.count, 'Direct and inline child have matching process groups');
    assert.equal(inline.processCount, direct.processCount);
    assert.equal(inline.collapsed, true);
    assert.equal(inline.emptyVisible, false);
    assert.equal(inline.replyVisible, true);
    assert.equal(inline.unknownVisible, true);
    assert.equal(inline.reasoningSources, 1, 'The original reasoning source card occurs once');
    assert.equal(inline.toolSources, 1, 'The original tool source card occurs once');

    await appendFile(copiedChild, record('2026-09-27T00:03:00.000Z', { type: 'message',
      id: 'child-process-appended-after-load', role: 'assistant',
      content: [{ type: 'output_text', text: 'Child record appended after the inline Reader loaded.' }] }) + '\n');
    copiedHash = sha256(copiedChild);
    assert.match(await readFile(copiedChild, 'utf8'), /child-process-appended-after-load/,
      'A task-owned child JSONL record was appended after the inline Reader loaded');
    const processGroup = '.inline-child-transcript details.reader-process';
    await command('click', `${processGroup} > summary`);
    await waitFor(command, `document.querySelector(${JSON.stringify(processGroup)})?.open === true`,
      'expand child process before opening its tool fields');
    const toolCard = '.inline-child-transcript article[data-message-id="CHILD_PROCESS_TOOL"]';
    await command('click', `${toolCard} .tool-disclosure > summary`);
    const inputField = `${toolCard} .tool-field:first-child`;
    const outputField = `${toolCard} .tool-field:last-child`;
    for (const [field, expected, selector] of [
      ['input', toolInput, inputField],
      ['output', toolOutput, outputField],
    ]) {
      await command('click', `${selector} > summary`);
      await waitFor(command, `document.querySelector(${JSON.stringify(`${selector} .event-body`)})?.textContent.length === 1400`,
        `${field} snapshot first page after append`);
      for (const length of [2800, expected.length]) {
        await command('click', `${selector} .read-more`);
        await waitFor(command, `document.querySelector(${JSON.stringify(`${selector} .event-body`)})?.textContent.length === ${length}`,
          `${field} snapshot continuation at ${length} characters`);
      }
      const actual = JSON.parse(await command('eval',
        `document.querySelector(${JSON.stringify(`${selector} .event-body`)})?.textContent`));
      assert.equal(actual, expected, `The complete ${field} remains readable from the published child snapshot`);
      assert.equal(await command('eval', `Boolean(document.querySelector(${JSON.stringify(`${selector} .read-more`)}))`), 'false',
        `The ${field} continuation ends at the complete snapshot`);
    }
    await command('click', `${processGroup} > summary`);
    await waitFor(command, `document.querySelector(${JSON.stringify(processGroup)})?.open === false`,
      'restore the collapsed child process after reading its tool fields');
    const source = JSON.parse(await command('eval', `(() => {
      const card = [...document.querySelectorAll('.inline-child-transcript article.event-card')].find(article =>
        article.dataset.messageId + ' / ' + article.dataset.segment === 'CHILD_PROCESS_TOOL / tool');
      return { anchor: card?.id ?? '', hidden: card?.closest('details.reader-process')?.open === false };
    })()`));
    assert.ok(source.anchor.startsWith('inline-'), 'The original tool keeps its inline source anchor');
    assert.equal(source.hidden, true);
  });

test('retained empty assistant, owned reasoning and tool stay inside the inline child process',
  { timeout: 60_000, skip: !existsSync(path.join(uiDir, 'node_modules', 'vite')) || !browserBinary() }, async t => {
    const { build } = createRequire(path.join(uiDir, 'package.json'))('vite');
    const buildDir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-inline-process-'));
    await build({ root: uiDir, configFile: path.join(uiDir, 'vite.config.ts'),
      build: { outDir: buildDir, emptyOutDir: true }, logLevel: 'error' });
    const parentId = 'inline-process-parent';
    const childId = 'inline-process-child';
    const session = id => ({ provider: 'codex', sessionId: id });
    const event = (id, messageId, segment = 'message') => ({ ...session(id), messageId, segment });
    const item = (id, messageId, segment, ordinal, role, preview, owner = null, processId = null) => ({
      event: event(id, messageId, segment), ordinal, role, preview, owner,
      timestamp: null, totalChars: preview.length, toolName: segment === 'tool' ? 'exec_command' : null,
      presentationPhase: processId === null ? (messageId === 'reply' ? 'final_answer' : null) : 'commentary',
      processId, processCount: processId === null ? null : 3, replyMetadata: null,
      contentRevisions: {},
    });
    const parent = [item(parentId, 'dispatch', 'message', 0, 'assistant', 'Parent dispatch')];
    const assistant = event(childId, 'empty');
    const child = [
      item(childId, 'request', 'message', 0, 'user', 'Child request'),
      item(childId, 'empty', 'message', 1, 'assistant', '', null, 1),
      item(childId, 'thought', 'thinking', 2, 'assistant', 'Recorded child thought', assistant, 1),
      item(childId, 'call', 'tool', 3, 'tool', 'Tool call', assistant, 1),
      item(childId, 'reply', 'message', 4, 'assistant', 'Child process final reply'),
      item(childId, 'unknown', 'message', 5, 'assistant', 'Child unknown phase stays visible'),
      item(childId, 'middle', 'message', 6, 'assistant', 'Middle child history'),
      item(childId, 'late', 'message', 7, 'assistant', 'Late child search marker'),
    ];
    const childPages = [child.slice(0, 4), child.slice(4, 6), child.slice(6, 7), child.slice(7)];
    const childPage = index => ({ id: `segment-${index + 1}`, pageId: `page-${childId}-${index + 1}`,
      startOrdinal: childPages.slice(0, index).reduce((total, page) => total + page.length, 0),
      items: childPages[index], ownerContext: null,
      previousCursor: index > 0 ? `p${index}` : null,
      nextCursor: index < childPages.length - 1 ? `p${index + 2}` : null });
    const summary = id => ({ session: session(id), title: id, directory: '/public/normalized-child',
      createdAt: 1, updatedAt: 1, messageCount: id === childId ? child.length : parent.length,
      tokenCount: null, parent: id === childId ? session(parentId) : null });
    const bootstrap = id => {
      const items = id === childId ? child : parent;
      return { session: summary(id), revision: `revision-${id}`, totalItems: items.length,
        segments: id === childId ? [childPage(0)] : [{ id: 'segment-0', pageId: `page-${id}-0`, startOrdinal: 0,
          items, ownerContext: null, previousCursor: null, nextCursor: null }],
        toc: { entries: items.map(row => ({ event: row.event, ordinal: row.ordinal, owner: row.owner,
          role: row.role, label: row.preview, processId: row.processId, processCount: row.processCount })),
          previousCursor: null, nextCursor: null },
        relations: { taskCount: 0, observationCount: id === parentId ? 1 : 0,
          firstCursor: id === parentId ? 'relations-0' : null } };
    };
    const childPageRequests = [];
    const server = createHttpServer((request, response) => {
      const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
      const json = value => { response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value)); };
      if (url.pathname === '/api/providers') return json([{ id: 'codex', available: true }]);
      if (url.pathname === '/api/v3/sessions') return json([summary(parentId)]);
      if (url.pathname === '/api/settings') return json({ configFile: { path: '/fixture/config.json', loaded: false },
        startup: { port: 3456, sources: {}, state: {} }, runtimeEditable: [],
        runtime: { projectPaths: {}, resumeCommands: {}, resumeShell: null } });
      const reader = url.pathname.match(/^\/api\/v3\/reader\/codex\/(inline-process-parent|inline-process-child)\/(bootstrap|relations|segments|search|locate|content)$/);
      if (reader) {
        const [, id, kind] = reader;
        if (kind === 'bootstrap') return json(bootstrap(id));
        if (kind === 'segments') {
          const cursor = url.searchParams.get('cursor');
          if (id === childId) childPageRequests.push(cursor);
          const index = Number(cursor?.slice(1)) - 1;
          return json({ session: session(id), revision: `revision-${id}`, page: childPage(index) });
        }
        if (kind === 'search') return json({ session: session(id), revision: `revision-${id}`,
          scope: 'owned', coverage: 'complete-owned-content', matches: [{ event: event(childId, 'late'),
            owner: null, ordinal: 7, field: 'body', offset: 0, matchLength: 4,
            excerpt: 'Late child search marker', excerptStart: 0, totalChars: 24 }], nextCursor: null });
        if (kind === 'locate') {
          if (id === parentId) return json({ session: session(id), revision: `revision-${id}`,
            event: event(parentId, 'dispatch'), ordinal: 0, owner: null,
            pageCursor: `page-${parentId}-0`, tocCursor: 'parent-toc' });
          return json({ session: session(id), revision: `revision-${id}`,
            event: event(childId, 'late'), ordinal: 7, owner: null, pageCursor: 'p4', tocCursor: 'p4' });
        }
        if (kind === 'content') return json({ text: 'Late child search marker', offset: 0,
          totalChars: 24, nextOffset: null, truncated: false });
        return json({ session: session(id), revision: `revision-${id}`, entries: [],
          childPlacements: id === parentId ? [{ child: session(childId), afterEvent: event(parentId, 'dispatch'),
            sourceEventId: 'event:fixture:child', diagnostic: null }] : [], nextCursor: null });
      }
      if (url.pathname.startsWith('/api/v3/runtime/')) return json({ session: session(childId),
        revision: `revision-${childId}`, coverage: 'partial', events: [], nextCursor: null, scannedEvents: 0 });
      if (url.pathname.startsWith('/api/v3/resume/')) return json({ allowTerminalLaunch: false,
        available: false, diagnostic: null, command: null });
      if (url.pathname.startsWith('/api/v3/meta/')) return json(null);
      if (url.pathname.startsWith('/api/')) { response.writeHead(404).end(); return; }
      const asset = url.pathname.startsWith('/assets/')
        ? path.resolve(buildDir, `.${url.pathname}`) : path.join(buildDir, 'index.html');
      if (!asset.startsWith(buildDir + path.sep) && asset !== path.join(buildDir, 'index.html')) {
        response.writeHead(400).end(); return;
      }
      if (!existsSync(asset)) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': asset.endsWith('.html') ? 'text/html'
        : asset.endsWith('.js') ? 'text/javascript' : asset.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
      response.end(readFileSync(asset));
    });
    const port = await freePort();
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    const browserSession = `v3-inline-empty-${process.pid}-${Date.now()}`;
    const command = (...args) => browserCommand(browserBinary(), browserSession, ...args);
    t.after(async () => {
      try { await command('close'); } catch { /* Browser may already be closed. */ }
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await rm(buildDir, { recursive: true, force: true });
    });
    const origin = `http://127.0.0.1:${port}`;
    await command('open', `${origin}/codex/session/${childId}`);
    await waitFor(command, `Boolean(document.querySelector('.transcript details.reader-process'))`, 'direct empty process');
    await waitFor(command, `document.querySelector('.transcript')?.innerText.includes('Child process final reply')`,
      'direct Reader preload');
    const direct = JSON.parse(await command('eval', presentation('.transcript', 'thought / thinking', 'call / tool')));
    assert.equal(direct.count, 1);
    assert.equal(direct.processCount, '3');
    assert.equal(direct.collapsed, true);
    assert.equal(direct.emptyVisible, false);
    assert.equal(direct.replyVisible, true);
    assert.equal(direct.unknownVisible, true);
    assert.equal(direct.reasoningSources, 1);
    await command('eval', `window.location.href = ${JSON.stringify(`${origin}/codex/session/${parentId}`)}`);
    await waitFor(command, `Boolean(document.querySelector('.inline-child-toggle'))`, 'mock child insertion point');
    const inlinePageStart = childPageRequests.length;
    await command('eval', `document.querySelector('.inline-child-toggle').click()`);
    await waitFor(command, `Boolean(document.querySelector('.inline-child-transcript article'))`, 'mock inline child');
    await waitFor(command, `document.querySelector('.inline-child-transcript')?.innerText.includes('Child process final reply')`,
      'inline Reader preload');
    assert.match(await command('get', 'text', '.inline-child-actions span'), /^6 of 8 /,
      'Only one bounded continuation is prefetched for a process-only opening');
    assert.deepEqual(childPageRequests.slice(inlinePageStart), ['p2']);
    const inline = JSON.parse(await command('eval', presentation('.inline-child-transcript', 'thought / thinking', 'call / tool')));
    assert.equal(inline.count, direct.count);
    assert.equal(inline.processCount, direct.processCount);
    assert.equal(inline.collapsed, true);
    assert.equal(inline.emptyVisible, false);
    assert.equal(inline.replyVisible, true);
    assert.equal(inline.unknownVisible, true);
    assert.equal(inline.reasoningSources, 1);
    assert.equal(inline.toolSources, 1);
    assert.equal(inline.reasoningAttached, true);
    for (const state of [direct, inline]) {
      assert.equal(state.toolAttached, true, 'normalized process tools retain their producing assistant group');
      assert.equal(state.ownershipBranches, 0, 'tool ownership has no duplicate decorative branch');
      assert.ok(state.ownershipBorders.length > 0, 'ownership styling is checked on actual attached tools');
      assert.ok(state.ownershipBorders.every(border => border === 'none'), 'indentation replaces the two ownership borders');
    }
    const accessibility = JSON.parse(await command('a11y', '--json'));
    assert.deepEqual(accessibility.data.violations.map(({ id, nodes }) => ({
      id, targets: nodes.map(({ target }) => target.join(',')),
    })), [], 'Expanded inline child has no automated accessibility violations');
    assert.deepEqual(accessibility.data.incomplete.filter(({ id }) => id === 'aria-prohibited-attr')
      .flatMap(({ nodes }) => nodes.map(({ target }) => target.join(','))), [],
    'Expanded inline child labels belong to semantic groups and regions');
    const source = JSON.parse(await command('eval', `(() => {
      const card = [...document.querySelectorAll('.inline-child-transcript article.event-card')].find(article =>
        article.dataset.messageId + ' / ' + article.dataset.segment === 'call / tool');
      return { anchor: card?.id ?? '', hidden: card?.closest('details.reader-process')?.open === false };
    })()`));
    assert.ok(source.anchor.startsWith('inline-'));
    assert.equal(source.hidden, true);
    await command('fill', '.pane-search[data-scope="child"] input[type="search"]', 'Late child');
    await command('eval', `document.querySelector('.pane-search[data-scope="child"] button[type="submit"]').click()`);
    await waitFor(command, `Boolean(document.querySelector('.pane-search[data-scope="child"] .pane-search-result'))`,
      'late child search result');
    await command('eval', `document.querySelector('.pane-search[data-scope="child"] .pane-search-result').click()`);
    await waitFor(command, `document.querySelector('.inline-child-transcript')?.innerText.includes('Late child search marker')`,
      'late child page');
    await waitFor(command, `document.querySelector('.inline-child-transcript')?.innerText.includes('Middle child history')`,
      'automatic continuation of the missing middle page after scrolling to the late search match');
    assert.match(await command('get', 'text', '.inline-child-actions span'), /^8 of 8 /);
    assert.deepEqual(childPageRequests.slice(inlinePageStart), ['p2', 'p4', 'p3'],
      'Search loads its bounded target page, then the visible continuation fills the earlier gap once');
    assert.equal(await command('eval', `Boolean(document.querySelector('.inline-child-next'))`), 'false',
      'Complete child history has no continuation request');
  });
