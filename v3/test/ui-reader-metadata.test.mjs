import { onCleanup, temporaryDirectory } from '../../test/helpers/fixture-cleanup.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const uiDir = path.join(repo, 'v3', 'ui');
const browserName = process.platform === 'win32'
  ? 'agent-browser-win32-x64.exe' : `agent-browser-${process.platform}-${process.arch}`;
const browserExe = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
  (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', browserName))
    .find(existsSync);
const skip = !existsSync(path.join(uiDir, 'node_modules', 'vite'))
  ? 'Install the locked v3 UI dependencies.'
  : !browserExe || !existsSync(browserExe) ? 'agent-browser is required for browser QA.' : false;

const session = { provider: 'codex', sessionId: 'reply-metadata-fixture' };
const revision = 'reply-metadata-revision';
const recorded = (sourceType, sourceId) => ({ fidelity: 'recorded', sourceType, sourceId });
const tokenVector = (values) => ({ input: null, cacheRead: null, cacheWrite: null,
  output: null, reasoning: null, total: null, ...values });

// Controlled normalized Reader contract fixture, not an observation about any provider.
export const readerMetadataCases = [
  { messageId: 'user-request', role: 'user', body: 'Fixture question with no reply metadata.',
    replyMetadata: null },
  { messageId: 'known-usage-reply', role: 'assistant', body: 'Known usage reply body with [a preserved reference](https://example.com/reference).',
    replyMetadata: { model: '<model>& "quoted"</model>', modelProvider: 'fixture-provider',
      modelProvenance: recorded('fixture_model_record', 'model-row-1'),
      requestUsage: { recordId: 'request-row-1',
        tokens: tokenVector({ input: 10, cacheRead: 0, cacheWrite: 0 }),
        provenance: recorded('fixture_request_record', 'request-row-1') } } },
  { messageId: 'model-only-reply', role: 'assistant', body: 'Model-only DSH-shaped reply body.',
    replyMetadata: { model: 'deepseek-v4-flash-vision-exp', modelProvider: 'deepseek-harness',
      modelProvenance: recorded('fixture_message_header', 'header-row-2'), requestUsage: null } },
  { messageId: 'adjacent-request-reply', role: 'assistant', body: 'Adjacent reply with a separate request record.',
    replyMetadata: { model: 'gpt-4.1-mini', modelProvider: 'openai',
      modelProvenance: recorded('fixture_model_record', 'model-row-3'),
      requestUsage: { recordId: 'request-row-3',
        tokens: tokenVector({ input: 7, output: 3 }),
        provenance: recorded('fixture_request_record', 'request-row-3') } } },
  { messageId: 'unknown-reply', role: 'assistant', body: 'Reply whose metadata is all unknown.',
    replyMetadata: { model: null, modelProvider: null, modelProvenance: null, requestUsage: null } },
].map((item, ordinal) => ({ ...item, ordinal,
  event: { ...session, messageId: item.messageId, segment: 'message' }, owner: null,
  timestamp: null, preview: item.body, totalChars: item.body.length, toolName: null,
  ownerMessageId: null, presentationPhase: item.role === 'assistant' ? 'final_answer' : null,
  processId: null, processCount: null, contentRevisions: {} }));

export function readerMetadataBootstrap(mode = 'replies', forChild = false) {
  const target = forChild ? { provider: 'codex', sessionId: 'reply-metadata-child' } : session;
  const processItems = [];
  const append = (messageId, role, body, replyMetadata, segment = 'message', owner = null, processId = null) => {
    processItems.push({ event: { ...target, messageId, segment }, ordinal: processItems.length,
      role, preview: body, totalChars: body.length, timestamp: null, owner,
      toolName: role === 'tool' ? 'fixture-tool' : null, ownerMessageId: owner?.messageId ?? null,
      presentationPhase: processId !== null ? 'commentary' : role === 'assistant' ? 'final_answer' : null,
      processId, processCount: processId !== null ? 6 : null, replyMetadata, contentRevisions: {} });
  };
  if (mode !== 'opening') append('process-request', 'user', 'Read the controlled process.', null);
  append('process-owner-a', 'assistant', mode === 'opening' ? 'Opening process reply.' : '', readerMetadataCases[1].replyMetadata, 'message', null, 1);
  const ownerA = processItems.at(-1).event;
  append('process-thought-a', 'assistant', 'Process reasoning stays collapsed.', null, 'thinking', ownerA, 1);
  append('process-tool-a', 'tool', 'Process tool output stays collapsed.', null, 'tool', ownerA, 1);
  append('process-owner-b', 'assistant', '', readerMetadataCases[2].replyMetadata, 'message', null, 1);
  const ownerB = processItems.at(-1).event;
  append('process-tool-b', 'tool', 'Second process tool output.', null, 'tool', ownerB, 1);
  append('process-unknown-owner', 'assistant', '', readerMetadataCases[4].replyMetadata, 'message', null, 1);
  append('process-final', 'assistant', 'The process final reply stays readable.', readerMetadataCases[3].replyMetadata);
  const title = 'Reply metadata controlled fixture';
  const items = mode === 'replies' || ((mode === 'child' || mode === 'child-return') && !forChild) ? readerMetadataCases : processItems;
  const summary = { session: target, title, directory: '/fixture', createdAt: 1, updatedAt: 2,
    messageCount: items.length, tokenCount: null, parent: null };
  const toc = { entries: items.map(item => ({ event: item.event, ordinal: item.ordinal,
    owner: item.owner, role: item.role, label: item.preview, processId: item.processId, processCount: item.processCount })),
  previousCursor: null, nextCursor: null };
  return { session: summary, revision, totalItems: items.length,
    segments: [{ id: 'fixture-segment', pageId: 'fixture-page', startOrdinal: 0,
      items, ownerContext: null, previousCursor: null, nextCursor: null }],
    toc, relations: { taskCount: 0, observationCount: 0,
      firstCursor: (mode === 'child' || mode === 'child-return') && !forChild ? 'child-placement' : null } };
}

// Exported so the root agent can extract and serve this fixture without running this test/browser harness.
export async function readerMetadataHarness(t, mode = 'replies', options = {}) {
  const { build } = createRequire(path.join(uiDir, 'package.json'))('vite');
  const buildDir = await temporaryDirectory(t, path.join(os.tmpdir(), 'agentsession-v3-reader-metadata-'));
  await build({ root: uiDir, configFile: path.join(uiDir, 'vite.config.ts'),
    build: { outDir: buildDir, emptyOutDir: true }, logLevel: 'error' });
  const requests = [];
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    if (url.pathname.startsWith('/api/')) requests.push(url.pathname + url.search);
    const json = body => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/providers') return json([{ id: 'codex', available: true }]);
    if (url.pathname === `/api/v3/reader/codex/${session.sessionId}/bootstrap`) return json(readerMetadataBootstrap(mode));
    if (url.pathname === '/api/v3/reader/codex/reply-metadata-child/bootstrap') return json(readerMetadataBootstrap('process', true));
    const placement = { child: { provider: 'codex', sessionId: 'reply-metadata-child' },
      afterEvent: readerMetadataCases[1].event, sourceEventId: 'fixture-child-placement', diagnostic: null };
    if (url.pathname === `/api/v3/reader/codex/${session.sessionId}/relations`) {
      const count = requests.filter(path => path.startsWith(url.pathname + '?')).length;
      await options.beforeParentRelations?.(count);
      const preceding = mode === 'child-return' ? ['earlier-child-a', 'earlier-child-b'].map(sessionId => ({
        child: { provider: 'codex', sessionId }, afterEvent: readerMetadataCases[0].event,
        sourceEventId: `fixture-${sessionId}`, diagnostic: null })) : [];
      return json({ session, revision, entries: [], nextCursor: null, childPlacements: [...preceding, placement] });
    }
    if (url.pathname === `/api/v3/reader/codex/${session.sessionId}/child-location`) return json({ session, revision,
      placement, location: { session, revision, event: placement.afterEvent, ordinal: 1, owner: null,
        pageCursor: 'fixture-page', tocCursor: 'fixture-toc' }, diagnostic: null });
    if (url.pathname === `/api/v3/reader/codex/${session.sessionId}/locate`) {
      const item = readerMetadataBootstrap(mode).segments[0].items.find(item =>
        item.event.messageId === url.searchParams.get('messageId') && item.event.segment === url.searchParams.get('segment'));
      if (item) return json({ session, revision, event: item.event, ordinal: item.ordinal,
        owner: item.owner, pageCursor: 'fixture-page', tocCursor: 'fixture-toc' });
    }
    if (url.pathname === `/api/v3/reader/codex/${session.sessionId}/toc`) return json({ session, revision,
      toc: readerMetadataBootstrap(mode).toc });
    if (url.pathname === `/api/v3/reader/codex/${session.sessionId}/executions`) {
      const count = requests.filter(path => path.startsWith(url.pathname + '?')).length;
      await options.beforeParentExecution?.(count);
      return json({ session, revision, coverage: 'partial', events: [],
        nextCursor: mode === 'child-return' && !url.searchParams.has('cursor') ? 'fixture-execution-next' : null,
        scannedEvents: mode === 'child-return' ? 1024 : 0 });
    }
    if (url.pathname === `/api/v3/runtime/codex/${session.sessionId}/events`) {
      const count = requests.filter(path => path.startsWith(url.pathname + '?')).length;
      await options.beforeParentExecution?.(count);
      return json({ session, revision, coverage: 'partial', events: [],
        nextCursor: mode === 'child-return' ? 'fixture-execution-next' : null,
        scannedEvents: mode === 'child-return' ? 1024 : 0 });
    }
    if (url.pathname === `/api/v3/meta/codex/${session.sessionId}`) return json({
      provider: 'codex', sessionId: session.sessionId, customTitle: null, starred: false,
      deleted: false, permanent: false, timeStarred: null, timeDeleted: null, timeRenamed: null,
    });
    if (url.pathname === `/api/v3/resume/codex/${session.sessionId}`) return json({
      allowTerminalLaunch: false, available: false, diagnostic: null, command: null,
    });
    if (url.pathname.startsWith('/api/')) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { code: 'not_found' } }));
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
  onCleanup(t, async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  const serverRef = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address())));

  return { origin: `http://127.0.0.1:${serverRef.port}`, buildDir, requests };
}

async function browser(t, url, launchArgs = []) {
  const browserSession = `agentsession-v3-reader-metadata-${process.pid}-${Date.now()}`;
  const command = (...args) => new Promise((resolve, reject) => {
    const child = spawn(browserExe, ['--session', browserSession, ...args],
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
  onCleanup(t, async () => { try { await command('close'); } catch { /* Browser already closed. */ } });
  await command('open', url, ...launchArgs);
  await command('set', 'viewport', '1440', '900');
  return command;
}

async function waitFor(command, expression) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (JSON.parse(await command('eval', `Boolean(${expression})`)) === true) return;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

function evalResult(output) {
  return JSON.parse(output);
}

test('Reader shows normalized reply metadata inline without inventing missing usage',
  { skip, timeout: 60_000 }, async t => {
    const app = await readerMetadataHarness(t);
    const command = await browser(t, `${app.origin}/codex/session/${session.sessionId}`);
    await waitFor(command, `document.querySelectorAll('.event-card').length === ${readerMetadataCases.length}`);
    const cards = evalResult(await command('eval', `Array.from(document.querySelectorAll('.event-card'), card => card.innerText)`));
    assert.equal(cards.length, readerMetadataCases.length);
    assert.equal(await command('eval', `document.querySelectorAll('[data-reply-metadata]').length`), '3',
      'metadata-free and all-unknown replies do not create empty metadata sections');

    // Existing reply/request content and their order remain intact around metadata.
    for (const item of readerMetadataCases) {
      const visibleBody = item.messageId === 'known-usage-reply'
        ? 'Known usage reply body with a preserved reference.' : item.body;
      assert.ok(cards[item.ordinal].includes(visibleBody), `missing body: ${item.messageId}`);
    }
    assert.ok(cards[0].includes('Fixture question with no reply metadata.'));
    assert.match(cards[1], /^Assistant\b/);
    assert.equal(await command('eval', `document.querySelector('.event-card a[href="https://example.com/reference"]')?.getAttribute('href')`),
      '"https://example.com/reference"', 'existing body links retain their destination');

    // Proven model and partial request usage are visible by default beside the reply.
    assert.match(cards[1], /Model\s*:?/i);
    assert.ok(cards[1].includes('<model>& "quoted"</model>'), 'model text is visible and escaped as text');
    assert.match(cards[1], /Input\s*:?\s*10\b/i, 'known input usage is visible');
    assert.match(cards[1], /Cache read\s*:?\s*0\b/i, 'recorded zero cache-read usage is visible');
    assert.match(cards[1], /Cache write\s*:?\s*0\b/i, 'recorded zero cache-write usage is visible');
    for (const dimension of ['Output', 'Reasoning', 'Total']) {
      assert.equal(new RegExp(`${dimension}\\s*:?[ \\u00a0]*0(?:\\D|$)`, 'i').test(cards[1]), false,
        `unknown ${dimension.toLowerCase()} usage is not zero`);
    }

    // Model-only metadata stays visible even though there is no request usage record.
    assert.match(cards[2], /Model\s*:?/i);
    assert.ok(cards[2].includes('deepseek-v4-flash-vision-exp'));
    assert.match(cards[2], /Model provider\s*:?/i);
    assert.ok(cards[2].includes('deepseek-harness'));
    assert.ok(cards[2].includes('Model-only DSH-shaped reply body.'));

    // Adjacent reply metadata remains attached to its own event, and unknowns are not zero.
    assert.ok(cards[3].includes('gpt-4.1-mini'));
    assert.match(cards[3], /Input\s*:?\s*7\b/i);
    assert.match(cards[3], /Output\s*:?\s*3\b/i);
    for (const value of ['deepseek-v4-flash-vision-exp', 'gpt-4.1-mini']) {
      assert.equal(cards[4].includes(value), false, `unknown reply unexpectedly displays ${value}`);
    }
    for (const dimension of ['Input', 'Output', 'Cache read', 'Cache write', 'Reasoning', 'Total']) {
      assert.equal(new RegExp(`${dimension}\\s*:?[ \\u00a0]*0(?:\\D|$)`, 'i').test(cards[4]), false,
        `unknown ${dimension.toLowerCase()} usage is not zero`);
    }
    assert.equal(await command('eval', `Boolean(document.querySelector('.event-card model, .event-card script'))`), 'false',
      'untrusted model strings stay escaped');
  });

for (const mode of ['process', 'opening', 'child']) {
  test(`Reader keeps each loaded ${mode} process reply's metadata attached to its owner`,
    { skip, timeout: 60_000 }, async t => {
      const app = await readerMetadataHarness(t, mode);
      const command = await browser(t, `${app.origin}/codex/session/${session.sessionId}`);
      if (mode === 'child') {
        await waitFor(command, `document.querySelector('.inline-child-toggle')`);
        await command('eval', `document.querySelector('.inline-child-toggle').click()`);
      }
      const scope = mode === 'child' ? '.inline-child-transcript' : '.transcript';
      await waitFor(command, `document.querySelector('${scope} .reader-process')`);
      const state = evalResult(await command('eval', `(() => {
        const transcript = document.querySelector('${scope}');
        const process = transcript.querySelector('.reader-process');
        const metadata = [...transcript.querySelectorAll('[data-reply-metadata]')];
        return { closed: !process.open, text: transcript.innerText,
          rows: metadata.map(node => ({ text: node.textContent, messageId: node.dataset.replyMessageId,
            inProcess: process.contains(node), visible: node.getClientRects().length > 0 })),
          metadataCount: metadata.length, processRows: process.querySelectorAll('[data-reply-metadata]').length,
          ownerCards: [...process.querySelectorAll('.assistant-card')].length };
      })()`));
      assert.equal(state.closed, true);
      assert.equal(state.metadataCount, 3, 'each known loaded reply is shown once, with unknown owners omitted');
      assert.equal(state.processRows, mode === 'opening' ? 1 : 2,
        'process-owner metadata stays within its collapsed execution disclosure');
      assert.equal(state.rows.filter(row => row.inProcess).length, state.processRows);
      assert.equal(state.rows.some(row => row.messageId === 'process-unknown-owner'), false,
        'all-unknown process metadata does not create an empty section');
      assert.equal(state.text.includes('Process reasoning stays collapsed.'), false);
      assert.equal(state.text.includes('Process tool output stays collapsed.'), false);
      assert.ok(state.text.includes('The process final reply stays readable.'));
      const ownerA = state.rows.find(row => row.messageId === 'process-owner-a');
      const ownerB = state.rows.find(row => row.messageId === 'process-owner-b');
      assert.ok(ownerA, 'first canonical owner retains its metadata');
      assert.ok(ownerB, 'second canonical owner retains its metadata');
      if (mode === 'opening') assert.equal(ownerA.inProcess, false,
        'the opening reply remains visible with its own metadata');
      else assert.equal(ownerA.inProcess, true);
      assert.equal(ownerB.inProcess, true);
      assert.match(ownerA.text, /Model\s*<model>& "quoted"<\/model>/);
      assert.match(ownerA.text, /Input\s*10\b/);
      assert.match(ownerA.text, /Cache read\s*0\b/);
      assert.match(ownerB.text, /Model\s*deepseek-v4-flash-vision-exp\b/);
      assert.match(ownerB.text, /Model provider\s*deepseek-harness\b/);
      assert.equal(/\b(?:Input|Output|Cache read|Cache write|Total)\s*\d/.test(ownerB.text), false,
        'model-only owner never inherits usage from another reply');
      const requestsBeforeLocate = app.requests.length;
      await command('click', `${scope} .reader-process summary`);
      await waitFor(command, `document.querySelector('${scope} .reader-process').open`);
      assert.equal(app.requests.length, requestsBeforeLocate, 'opening loaded process details makes no new request');
      const expanded = evalResult(await command('eval', `(() => {
        const process = document.querySelector('${scope} .reader-process');
        return [...process.querySelectorAll('[data-reply-metadata]')].map(node => ({
          text: node.innerText, messageId: node.dataset.replyMessageId,
          visible: node.getClientRects().length > 0, links: node.querySelectorAll('a').length }));
      })()`));
      assert.equal(expanded.length, state.processRows, 'each process owner has one metadata section after expansion');
      assert.ok(expanded.every(row => row.visible), 'process metadata is visible when its disclosure is open');
      assert.ok(expanded.every(row => row.links === 0), 'metadata remains attached to its event without adding navigation links');
      assert.ok(expanded.some(row => row.messageId === 'process-owner-b'), 'expanded process retains the canonical owner identity');
      const expandedOwnerA = expanded.find(row => row.messageId === 'process-owner-a');
      const expandedOwnerB = expanded.find(row => row.messageId === 'process-owner-b');
      if (mode !== 'opening') assert.ok(expandedOwnerA);
      assert.ok(expandedOwnerB);
      assert.match(expandedOwnerA?.text ?? ownerA.text, /Model\s*<model>& "quoted"<\/model>/);
      assert.match(expandedOwnerA?.text ?? ownerA.text, /Input\s*10\b/);
      assert.match(expandedOwnerA?.text ?? ownerA.text, /Cache read\s*0\b/);
      assert.match(expandedOwnerB.text, /Model\s*deepseek-v4-flash-vision-exp\b/);
      assert.match(expandedOwnerB.text, /Model provider\s*deepseek-harness\b/);
      assert.equal(await command('eval', `document.querySelectorAll('${scope} [data-reply-metadata]').length`), '3',
        'expanding the process does not duplicate metadata');
      assert.equal(await command('eval', `document.querySelector('${scope}').innerText.includes('Process reasoning stays collapsed.')`), 'false',
        'recorded reasoning keeps its own disclosure inside the open process');
      assert.equal(await command('eval', `Boolean(document.querySelector('${scope} model, ${scope} script'))`), 'false');
    });
}

test('Back from a child source reloads the parent and waits for preceding placements before restoring visible focus',
  { skip, timeout: 60_000 }, async t => {
    let releaseRelations;
    let releaseExecution;
    let relationsHeld = false;
    let executionHeld = false;
    const relationsGate = new Promise(resolve => { releaseRelations = resolve; });
    const executionGate = new Promise(resolve => { releaseExecution = resolve; });
    t.after(() => { releaseRelations(); releaseExecution(); });
    const app = await readerMetadataHarness(t, 'child-return', { beforeParentRelations: count => {
      if (count === 2) { relationsHeld = true; return relationsGate; }
    }, beforeParentExecution: count => {
      if (count === 2) { executionHeld = true; return executionGate; }
    } });
    const parentPath = `/codex/session/${session.sessionId}`;
    const childPath = '/codex/session/reply-metadata-child';
    const toggleId = 'child-toggle-' + Buffer.from('codex\0reply-metadata-child').toString('hex');
    // Exercise the reloaded-parent restoration path; BFCache keeps the original
    // loaded parent and would bypass the deliberately held second requests.
    const command = await browser(t, app.origin + parentPath,
      ['--args', '--disable-features=BackForwardCache']);
    await waitFor(command, `document.querySelectorAll('.transcript > .turn-block .inline-child-toggle').length === 3`);
    await command('focus', '#' + toggleId);
    await command('press', 'Enter');
    await waitFor(command, `document.querySelector('.inline-child-transcript article')`);
    await command('focus', `.inline-child-heading-actions a[href="${childPath}"]`);
    await command('press', 'Enter');
    await waitFor(command, `location.pathname === '${childPath}' && document.querySelector('#reader-title')`);
    await command('back');
    await waitFor(command, `location.pathname === '${parentPath}'
      && document.querySelector('.inline-child-transcript article') && document.getElementById('${toggleId}')`);
    assert.equal(relationsHeld, true, 'the restored parent starts with its initial relations request pending');
    assert.equal(executionHeld, true, 'the restored parent also starts with its execution controls pending');
    assert.equal(await command('eval', `document.querySelectorAll('.transcript > .turn-block .inline-child-toggle').length`), '1',
      'only the resolved target is inserted while preceding placements remain unloaded');
    assert.equal(await command('eval', `document.activeElement?.id === '${toggleId}'`), 'false',
      'final restored focus waits for the preceding placements to settle');
    releaseRelations();
    await waitFor(command, `document.querySelectorAll('.transcript > .turn-block .inline-child-toggle').length === 3`);
    assert.equal(await command('eval', `document.activeElement?.id === '${toggleId}'`), 'true',
      'the child return focus restores when preceding placements resolve; the pending empty execution page adds no controls');
    releaseExecution();
    await waitFor(command, `document.querySelectorAll('.transcript > .turn-block .inline-child-toggle').length === 3
      && document.activeElement?.id === '${toggleId}'`);
    assert.equal(await command('eval', `Boolean(document.querySelector('.reader-outline .outline-actions button'))`), 'true',
      'the Reader outline exposes its first keyboard control after the restored child toggle');
    const focus = evalResult(await command('eval', `(() => {
      const target = document.getElementById('${toggleId}');
      const rect = target.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, viewport: innerHeight,
        expanded: target.getAttribute('aria-expanded'), hash: location.hash };
    })()`));
    assert.equal(focus.expanded, 'true');
    assert.ok(focus.hash.startsWith('#child?') && focus.hash.includes('sessionId=reply-metadata-child'));
    // scrollIntoView uses integer scroll offsets while DOMRect retains subpixels.
    assert.ok(focus.top >= -1 && focus.bottom <= focus.viewport + 1,
      `restored child focus is visible after the earlier controls are inserted: ${JSON.stringify(focus)}`);
    await command('press', 'Tab');
    assert.equal(await command('eval', `document.activeElement === document.querySelector('.inline-child-heading-actions a')`), 'true',
      'Tab advances to the next child navigation control');
    assert.equal(await command('eval', `(() => { const rect = document.activeElement.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; })()`), 'true',
      'the next outline control remains visible');
  });
