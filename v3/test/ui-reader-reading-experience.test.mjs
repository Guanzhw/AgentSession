import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const uiDir = path.join(repo, 'v3/ui');
const binaryName = process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3';
const frozenBinary = path.join(repo, 'tmp/v3-usability-20261004/native-after12', binaryName);
const binary = process.env.AGENTSESSION_V3_BINARY || (existsSync(frozenBinary)
  ? frozenBinary : path.join(repo, 'v3/target/debug', binaryName));
const browserName = process.platform === 'win32' ? 'agent-browser-win32-x64.exe'
  : `agent-browser-${process.platform}-${process.arch}`;
const browserBinary = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN || (process.env.PATH || '')
  .split(path.delimiter).map(entry => path.join(entry, 'node_modules/agent-browser/bin', browserName)).find(existsSync);
const skip = !existsSync(binary) ? 'Set AGENTSESSION_V3_BINARY to a built native backend.'
  : !existsSync(path.join(uiDir, 'node_modules/vite')) ? 'Install the locked UI dependencies.'
    : !browserBinary ? 'agent-browser is required.' : false;
const sessionId = 'reader-feedback-acceptance';
const shortBody = 'A short answer should be readable immediately. '.repeat(6).padEnd(283, 'x') + ' SHORT-ANSWER-COMPLETE';
const longBody = Array.from({ length: 50 }, (_, i) =>
  `Paragraph ${i + 1} explains the source-backed reading experience with enough context to follow the whole argument.`).join('\n\n') + '\n\nLONG-ANSWER-COMPLETE';
const tailMarker = 'TAIL-DESTINATION-UNIQUE';
const toolInput = JSON.stringify({ command: 'INPUT-START ' + 'x'.repeat(1700) + ' INPUT-COMPLETE' });
const toolOutput = 'OUTPUT-START ' + 'y'.repeat(1700) + ' OUTPUT-COMPLETE';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function harness(t) {
  const scratch = path.join(repo, 'tmp/v3-reader-feedback-20261009/tests');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'browser-'));
  const sourceRoot = path.join(root, 'codex');
  const sourceFile = path.join(sourceRoot, 'sessions/2026/10/09/rollout-reader-feedback.jsonl');
  await mkdir(path.dirname(sourceFile), { recursive: true });
  for (const dir of ['meta', 'index', 'cache', 'claude', 'pi', 'dsh']) await mkdir(path.join(root, dir));
  const rows = [{ timestamp: '2026-10-09T00:00:00.000Z', type: 'session_meta',
    payload: { id: sessionId, cwd: '/workspace/reader-feedback', cli_version: '0.1.0' } }];
  for (let i = 0; i < 240; i++) {
    rows.push({ timestamp: new Date(Date.UTC(2026, 9, 9, 0, 0, i + 1)).toISOString(),
      type: 'response_item', payload: { type: 'message', role: i % 2 ? 'assistant' : 'user', id: `message-${i}`,
        ...(i % 2 ? {} : { internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } }),
        content: [{ type: i % 2 ? 'output_text' : 'input_text', text: i === 1 ? shortBody
          : i === 3 ? longBody : i === 239 ? tailMarker : `Reader turn ${i}: continue the discussion.` }] } });
    if (i === 3) {
      rows.push({ timestamp: '2026-10-09T00:00:04.100Z', type: 'response_item', payload: {
        type: 'function_call', call_id: 'reader-tool', name: 'read_source', arguments: toolInput } });
      rows.push({ timestamp: '2026-10-09T00:00:04.200Z', type: 'response_item', payload: {
        type: 'function_call_output', call_id: 'reader-tool', output: toolOutput } });
    }
    if (i === 5) rows.push({ timestamp: '2026-10-09T00:00:06.100Z', type: 'compacted',
      payload: { message: 'Synthetic recorded compaction checkpoint', replacement_history: [] } });
  }
  await writeFile(sourceFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const digest = createHash('sha256').update(await readFile(sourceFile)).digest('hex');
  let expectedDigest = digest;
  await writeFile(path.join(root, 'config.json'), '{}\n');
  const backendPort = await freeFetchSafePort();
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const child = spawn(binary, ['--config', path.join(root, 'config.json'), 'serve', '--port', String(backendPort),
    '--codex-dir', sourceRoot, '--opencode-db', path.join(root, 'opencode.db'),
    '--claude-dir', path.join(root, 'claude'), '--pi-dir', path.join(root, 'pi'), '--dsh-dir', path.join(root, 'dsh'),
    '--meta-dir', path.join(root, 'meta'), '--index-dir', path.join(root, 'index'), '--cache-dir', path.join(root, 'cache')],
  { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', value => { logs += value; });
  child.stderr.on('data', value => { logs += value; });
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    await writeFile(path.join(scratch, `native-${process.pid}.log`), logs);
    assert.equal(createHash('sha256').update(await readFile(sourceFile)).digest('hex'), expectedDigest,
      'Reader UI, content loads, pagination and search leave provider source bytes unchanged');
    await rm(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 30_000;
  while (true) {
    if (child.exitCode !== null) throw new Error(`Backend exited: ${logs}`);
    try { if ((await fetch(`${backendOrigin}/api/providers`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`Backend startup timed out: ${logs}`);
    await delay(100);
  }
  const bootstrap = await (await fetch(`${backendOrigin}/api/v3/reader/codex/${sessionId}/bootstrap`)).json();
  assert.ok(bootstrap.segments.at(-1).nextCursor, 'real fixture spans multiple bounded Reader pages');
  t.diagnostic(`source SHA-256 ${digest}; backend ${binary}; initial items ${bootstrap.segments.flatMap(s => s.items).length}`);
  const buildDir = path.join(root, 'ui');
  const { build } = createRequire(path.join(uiDir, 'package.json'))('vite');
  await build({ root: uiDir, configFile: path.join(uiDir, 'vite.config.ts'),
    build: { outDir: buildDir, emptyOutDir: true }, logLevel: 'error' });
  const contentRequests = [];
  const bootstrapRequests = [];
  server = createServer(async (request, response) => {
    if (request.url.startsWith('/api/')) {
      const requestUrl = new URL(request.url, backendOrigin);
      if (requestUrl.pathname.endsWith('/bootstrap')) bootstrapRequests.push(requestUrl.pathname);
      if (requestUrl.pathname.endsWith('/content')) contentRequests.push({
        field: requestUrl.searchParams.get('field'), offset: Number(requestUrl.searchParams.get('offset')),
        contentRevision: requestUrl.searchParams.get('contentRevision') });
      try {
        const result = await fetch(backendOrigin + request.url);
        response.writeHead(result.status, { 'content-type': result.headers.get('content-type') || 'application/json' });
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch (error) { response.writeHead(502).end(String(error)); }
      return;
    }
    const url = new URL(request.url, backendOrigin);
    const asset = url.pathname.startsWith('/assets/') ? path.resolve(buildDir, `.${url.pathname}`) : path.join(buildDir, 'index.html');
    if (!asset.startsWith(buildDir + path.sep) || !existsSync(asset)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': asset.endsWith('.html') ? 'text/html' : asset.endsWith('.js') ? 'text/javascript' : 'text/css' });
    response.end(readFileSync(asset));
  });
  const port = await freeFetchSafePort();
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${port}/codex/session/${sessionId}`, contentRequests, bootstrapRequests,
    appendSource: async () => {
      const row = { timestamp: '2026-10-09T00:05:00.000Z', type: 'response_item', payload: {
        type: 'message', id: 'appended-live-message', role: 'assistant',
        content: [{ type: 'output_text', text: 'New live reply appended after the Reader opened.' }] } };
      await appendFile(sourceFile, JSON.stringify(row) + '\n');
      expectedDigest = createHash('sha256').update(await readFile(sourceFile)).digest('hex');
      assert.notEqual(expectedDigest, digest, 'test-owned append changes the provider revision');
    } };
}

async function browser(t, url) {
  const session = `reader-feedback-${process.pid}-${Date.now()}`;
  const command = (...args) => new Promise((resolve, reject) => {
    const child = spawn(browserBinary, ['--session', session, ...args], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Browser ${args[0]} timed out`)); }, 20_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout)); });
  });
  t.after(async () => { try { await command('close'); } catch {} });
  await command('open', url);
  await command('set', 'viewport', '1280', '800');
  await waitFor(command, `document.querySelectorAll('article.event-card').length > 3`);
  return command;
}
async function waitFor(command, expression) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await command('eval', `Boolean(${expression})`)).includes('true')) return;
    await delay(75);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}
const evaluate = async (command, expression) => JSON.parse(await command('eval', expression));

test('Reader reading experience on current UI and isolated native provider data', { skip, timeout: 180_000 }, async t => {
  const { url, contentRequests, bootstrapRequests, appendSource } = await harness(t);
  await t.test('scrolling continues the transcript, follows the outline and exposes context checkpoints', async t => {
    const command = await browser(t, url);
    const before = await evaluate(command, `document.querySelectorAll('.transcript article.event-card').length`);
    await command('eval', `document.querySelector('[data-reader-continuation]').scrollIntoView({block:'center',behavior:'instant'})`);
    const scroll = await evaluate(command, `({ y: scrollY, top: document.querySelector('.transcript article[data-message-id="message-28"]').getBoundingClientRect().top })`);
    await waitFor(command, `document.querySelectorAll('.transcript article.event-card').length > ${before}`);
    const continued = await evaluate(command, `({ y: scrollY, top: document.querySelector('.transcript article[data-message-id="message-28"]').getBoundingClientRect().top })`);
    t.diagnostic(`automatic continuation: ${JSON.stringify({ before: scroll, after: continued })}`);
    assert.ok(Math.abs(continued.top - scroll.top) < 4, 'automatic continuation preserves the visible message position');
    await command('eval', `document.querySelector('.transcript article[data-message-id="message-20"]').scrollIntoView({block:'start',behavior:'instant'})`);
    await waitFor(command, `document.querySelector('.reader-outline a[aria-current="location"]')?.getAttribute('href').includes('message-20')`);
    const state = await evaluate(command, `(() => {
      const current = document.querySelector('.reader-outline a[aria-current="location"]');
      const pane = document.querySelector('.reader-outline nav').getBoundingClientRect();
      const rect = current.getBoundingClientRect();
      const compact = document.querySelector('.reader-outline a.context-outline');
      return { progress: Number(document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')),
        currentVisible: rect.top >= pane.top && rect.bottom <= pane.bottom,
        compactHidden: compact?.closest('.outline-children')?.hidden,
        nonMessages: document.querySelectorAll('.reader-outline a[href*="segment=tool"], .reader-outline a[href*="segment=thinking"]').length,
        userLeft: document.querySelector('.user-card').getBoundingClientRect().left,
        assistantLeft: document.querySelector('.assistant-card').getBoundingClientRect().left };
    })()`);
    assert.ok(state.progress > 0 && state.progress < 100);
    assert.equal(state.currentVisible, true);
    assert.equal(state.compactHidden, false, 'context checkpoint is independent of folded request replies');
    assert.equal(state.nonMessages, 0);
    assert.ok(state.userLeft > state.assistantLeft, 'user messages align to the right of assistant replies');
  });
  await t.test('short answers are complete; long answers begin with readable paragraphs', async t => {
    const command = await browser(t, url);
    await waitFor(command, `document.querySelectorAll('.assistant-card .event-body')[0]?.textContent.includes('SHORT-ANSWER-COMPLETE')`);
    const content = await evaluate(command, `(() => {
      const cards = [...document.querySelectorAll('.assistant-card')];
      return { short: cards[0].querySelector('.event-body').textContent.trim(),
        shortActions: [...cards[0].querySelectorAll('.read-more')].filter(b => !b.disabled).map(b => b.textContent.trim()),
        long: cards[1].querySelector('.event-body').textContent,
        action: cards[1].querySelector('.read-more')?.textContent.trim(),
        sourcePanels: document.querySelectorAll('.event-card .source-details').length };
    })()`);
    assert.equal(content.short, shortBody);
    assert.deepEqual(content.shortActions, [], 'short answer needs no manual expansion');
    assert.ok(content.long.length >= 1200, `long preview has ${content.long.length} characters`);
    assert.ok(!content.long.includes('LONG-ANSWER-COMPLETE'), 'long answer remains bounded initially');
    assert.match(content.action, /^Show more(?:↓)?$/);
    assert.equal(content.sourcePanels, 0, 'reading cards contain no raw message-ID disclosure');
    const previewLength = content.long.length;
    await command('eval', `document.querySelectorAll('.assistant-card')[1].querySelector('.read-more').click()`);
    await waitFor(command, `document.querySelectorAll('.assistant-card')[1].querySelector('.event-body').textContent.length > ${previewLength}`);
    for (let part = 0; part < 5; part++) {
      const pending = await evaluate(command, `!!document.querySelectorAll('.assistant-card')[1].querySelector('.read-more')`);
      if (!pending) break;
      const length = await evaluate(command, `document.querySelectorAll('.assistant-card')[1].querySelector('.event-body').textContent.length`);
      await command('eval', `document.querySelectorAll('.assistant-card')[1].querySelector('.read-more').click()`);
      await waitFor(command, `document.querySelectorAll('.assistant-card')[1].querySelector('.event-body').textContent.length > ${length}`);
    }
    await waitFor(command, `document.querySelectorAll('.assistant-card')[1].querySelector('.event-body').textContent.includes('LONG-ANSWER-COMPLETE')`);
    assert.equal(await evaluate(command, `!!document.querySelectorAll('.assistant-card')[1].querySelector('.read-more')`), false);
  });
  await t.test('desktop conversation has two columns and collapsed session details', async t => {
    const command = await browser(t, url);
    for (const width of [1088, 1280]) {
      await command('set', 'viewport', String(width), '800');
      const geometry = await evaluate(command, `(() => {
        const main = document.querySelector('.reader-main').getBoundingClientRect();
        const outline = document.querySelector('.reader-outline').getBoundingClientRect();
        const details = document.querySelector('.reader-session-details');
        return { width: innerWidth, mainWidth: main.width, mainLeft: main.left, outlineLeft: outline.left,
          outlineWidth: outline.width, columns: getComputedStyle(document.querySelector('.reader-layout')).gridTemplateColumns.split(' ').length,
          overflow: document.documentElement.scrollWidth > innerWidth, context: !!document.querySelector('.reader-context'),
          strip: !!document.querySelector('.provider-strip, .local-indicator'), detailsExists: !!details, detailsOpen: details?.open,
          detailsText: details?.textContent, headingHeight: document.querySelector('.reader-heading').getBoundingClientRect().height };
      })()`);
      t.diagnostic(JSON.stringify(geometry));
      assert.equal(geometry.columns, 2);
      assert.equal(geometry.context, false);
      assert.equal(geometry.strip, false);
      assert.equal(geometry.overflow, false);
      assert.ok(geometry.mainWidth >= width * 0.62, 'conversation receives most desktop width');
      assert.ok(geometry.outlineLeft > geometry.mainLeft && geometry.outlineWidth >= 160);
      assert.equal(geometry.detailsExists, true);
      assert.equal(geometry.detailsOpen, false);
      assert.match(geometry.detailsText, new RegExp(sessionId));
      assert.match(geometry.detailsText, /\/workspace\/reader-feedback/);
      assert.ok(geometry.headingHeight < 260, 'header leaves room for reading');
    }
    await command('click', '.reader-session-details > summary');
    assert.equal(await evaluate(command, `document.querySelector('.reader-session-details').open`), true);
  });
  await t.test('opening and paginating tool fields after a live append retains the loaded Reader snapshot', async t => {
    const start = contentRequests.length;
    const command = await browser(t, url);
    await waitFor(command, `document.querySelector('article.tool-card details.tool-field')`);
    assert.deepEqual(contentRequests.slice(start).filter(row => row.field === 'toolInput' || row.field === 'toolOutput'), [],
      'closed tool fields do not fetch hidden payloads');
    const bootstraps = bootstrapRequests.length;
    await appendSource();
    for (const [index, field, expected] of [[1, 'toolInput', toolInput], [2, 'toolOutput', toolOutput]]) {
      const selector = `article.tool-card details.tool-field:nth-child(${index})`;
      await command('eval', `document.querySelector('${selector} summary').click()`);
      await waitFor(command, `document.querySelector('${selector} .event-body')?.textContent.length === 1400`);
      assert.equal(await evaluate(command, `document.querySelector('${selector} .event-body').textContent`), expected.slice(0, 1400));
      assert.equal(await evaluate(command, `[...document.querySelectorAll('${selector} button')].some(b => /^Load tool/.test(b.textContent.trim()))`), false,
        'opening the field is the content-loading action');
      const contentRevision = createHash('sha256').update(expected).digest('hex');
      assert.deepEqual(contentRequests.slice(start).filter(row => row.field === field), [{ field, offset: 0, contentRevision }]);
      await command('eval', `document.querySelector('${selector} summary').click(); document.querySelector('${selector} summary').click()`);
      assert.deepEqual(contentRequests.slice(start).filter(row => row.field === field), [{ field, offset: 0, contentRevision }], 'reopening retains already loaded content');
      await command('eval', `document.querySelector('${selector} button.read-more').click()`);
      await waitFor(command, `document.querySelector('${selector} .event-body')?.textContent.length === ${expected.length}`);
      assert.equal(await evaluate(command, `document.querySelector('${selector} .event-body').textContent`), expected);
      assert.deepEqual(contentRequests.slice(start).filter(row => row.field === field), [
        { field, offset: 0, contentRevision }, { field, offset: 1400, contentRevision },
      ], 'each bounded request carries the original field hash');
    }
    assert.equal(bootstrapRequests.length, bootstraps, 'field loads succeed without reloading the Reader');
  });
  await t.test('session search opens on demand and keyboard activation reaches exact destination', async t => {
    const command = await browser(t, url);
    assert.equal(await evaluate(command, `!!document.querySelector('.pane-search[data-scope="session"] input')?.getClientRects().length`), false);
    assert.equal(await evaluate(command, `(() => { const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
      document.dispatchEvent(event); return event.defaultPrevented; })()`), false, 'native Ctrl+F remains available');
    await command('press', 'Control+Shift+f');
    await waitFor(command, `document.activeElement === document.querySelector('.pane-search[data-scope="session"] input')`);
    await command('press', 'Escape');
    await waitFor(command, `!document.querySelector('.pane-search[data-scope="session"] input')?.getClientRects().length`);
    assert.equal(await evaluate(command, `document.activeElement === document.querySelector('.reader-find-toggle')`), true);
    await command('click', '.reader-find-toggle');
    await command('fill', '.pane-search[data-scope="session"] input', tailMarker);
    await command('click', '.pane-search[data-scope="session"] button[type="submit"]');
    await waitFor(command, `document.querySelector('.pane-search-result')`);
    await command('focus', '.pane-search-result');
    await command('press', 'Enter');
    await waitFor(command, `document.querySelector('.search-reveal mark')?.textContent === '${tailMarker}'`);
    const destination = await evaluate(command, `(() => {
      const mark = document.querySelector('.search-reveal mark'), region = mark.closest('.search-reveal'), rect = mark.getBoundingClientRect();
      return { focused: document.activeElement === region, top: rect.top, bottom: rect.bottom, height: innerHeight,
        owner: region.closest('.event-card').dataset.messageId };
    })()`);
    assert.equal(destination.focused, true);
    assert.ok(destination.top >= 0 && destination.bottom <= destination.height);
    assert.match(destination.owner, /message-239/);
    assert.equal(await evaluate(command, `(() => {
      const target = [...document.querySelectorAll('.reader-outline nav a')].find(a =>
        a.getAttribute('href')?.includes('messageId=message-239&segment=message'));
      return !!target?.getClientRects().length && !target.closest('.outline-children').hidden;
    })()`), true, 'an unloaded search destination is added to Contents and its replies expand');
  });
  await t.test('each request starts folded and its toggle preserves message navigation', async t => {
    const command = await browser(t, url);
    await waitFor(command, `document.querySelectorAll('.outline-turn-toggle').length > 1`);
    const initial = await evaluate(command, `(() => {
      const groups = [...document.querySelectorAll('.outline-turn.has-request')];
      return { count: groups.length, closed: groups.every(group =>
        group.querySelector('.outline-turn-toggle').getAttribute('aria-expanded') === 'false' &&
        group.querySelector('.outline-children').hidden),
        requestHref: groups[0].querySelector('.outline-request').getAttribute('href') };
    })()`);
    assert.ok(initial.count > 1);
    assert.equal(initial.closed, true, 'each user request has its replies hidden by default');
    await command('click', '.outline-turn-toggle');
    assert.equal(await evaluate(command, `document.querySelector('.outline-turn .outline-children').hidden`), false);
    await command('click', '.outline-turn-toggle');
    assert.equal(await evaluate(command, `document.querySelector('.outline-turn .outline-children').hidden`), true);
    await command('click', '.outline-request');
    await waitFor(command, `location.hash === ${JSON.stringify(initial.requestHref)}`);
  });
  await t.test('outline loads continuously and retains earlier anchors after a later destination', async t => {
    const command = await browser(t, url);
    const initial = await evaluate(command, `({ firstAnchor: document.querySelector('article.event-card').id,
      links: [...document.querySelectorAll('.reader-outline nav a')].map(a => a.getAttribute('href')) })`);
    assert.ok(initial.links.length > 0);
    const actions = await evaluate(command, `[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Load more messages').length`);
    assert.equal(actions, 1, 'one continuous message loading control');
    assert.equal(await evaluate(command, `[...document.querySelectorAll('.reader-main button, .toc-controls button')].some(b => /^(Previous|Next)( segment)?$/.test(b.textContent.trim()))`), false);
    await command('eval', `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Load more messages').click()`);
    await waitFor(command, `document.querySelectorAll('.reader-outline nav a').length > ${initial.links.length}`);
    const current = await evaluate(command, `[...document.querySelectorAll('.reader-outline nav a')].map(a => a.getAttribute('href'))`);
    for (const href of initial.links) assert.ok(current.includes(href), `earlier outline anchor retained: ${href}`);
    await command('eval', `document.querySelectorAll('.reader-outline nav a')[${initial.links.length}].click()`);
    await waitFor(command, `location.hash === ${JSON.stringify(current[initial.links.length])}`);
    const afterJump = await evaluate(command, `[...document.querySelectorAll('.reader-outline nav a')].map(a => a.getAttribute('href'))`);
    for (const href of initial.links) assert.ok(afterJump.includes(href), `earlier anchor survives later navigation: ${href}`);
    await command('eval', `document.querySelector('.reader-outline nav a').click()`);
    await waitFor(command, `location.hash === ${JSON.stringify(initial.links[0])}`);
    await waitFor(command, `document.getElementById(${JSON.stringify(initial.firstAnchor)})`);
  });
});
