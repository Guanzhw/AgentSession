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
const provider = 'codex';
const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const childSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const finalAnswer = `The delegated inspection is complete. ${'Recorded agent result. '.repeat(18)}`.trimEnd();

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
  ? 'Install the locked v3/ui dependencies before running the Reader browser test.'
  : !agentBrowserExe
    ? 'The agent-browser CLI is required; the test does not install it or download a browser.'
    : false;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function freePort() {
  return freeFetchSafePort();
}

function fixture(withChild = false) {
  const event = messageId => ({ provider, sessionId, messageId, segment: 'message' });
  const toolEvent = messageId => ({ provider, sessionId, messageId, segment: 'tool' });
  const items = [
    { event: event('user-1'), ordinal: 0, owner: null, role: 'user', timestamp: null,
      preview: 'Inspect this code with a delegated agent.', totalChars: 40, toolName: null, replyMetadata: null, contentRevisions: {} },
    { event: event('spawn-request'), ordinal: 1, owner: null, role: 'assistant', timestamp: null,
      preview: 'I am starting a focused child inspection.', totalChars: 40, toolName: null, replyMetadata: null, contentRevisions: {} },
    { event: toolEvent('spawn:delegate:1'), ordinal: 2, owner: event('spawn-request'), role: 'tool', timestamp: null,
      preview: 'Started a delegated inspection.', totalChars: 31, toolName: 'spawn_agent', replyMetadata: null, contentRevisions: {} },
    { event: toolEvent('wait:foreground:1'), ordinal: 3, owner: event('spawn-request'), role: 'tool', timestamp: null,
      preview: 'No child result in this wait window.', totalChars: 36, toolName: 'wait_agent', replyMetadata: null, contentRevisions: {} },
    { event: event('agent-final'), ordinal: 4, owner: null, role: 'agent', timestamp: null,
      preview: finalAnswer.slice(0, 84), totalChars: finalAnswer.length, toolName: null, replyMetadata: null, contentRevisions: {} },
  ];
  return {
    event,
    bootstrap: {
      session: { session: { provider, sessionId }, title: 'Codex collaboration fixture',
        directory: '/public/codex-fixture', createdAt: 1_790_000_000_000,
        updatedAt: 1_790_000_000_000, messageCount: items.length, tokenCount: null, parent: null },
      revision: 'codex-collaboration-revision',
      totalItems: items.length,
      segments: [{ id: 'segment-0', pageId: 'page-0', startOrdinal: 0, items,
        ownerContext: null, previousCursor: null, nextCursor: null }],
      toc: { entries: items.map(item => ({ event: item.event, ordinal: item.ordinal,
        owner: null, label: item.preview })), previousCursor: null, nextCursor: null },
      relations: { taskCount: 0, observationCount: 5, firstCursor: 'codex-relations-0' },
    },
    relations: [
      { type: 'coordination', observation: {
        kind: 'spawn', state: 'requested', correlationId: 'spawn:delegate:1', eventId: 'event-spawn-request',
        fromSessionRef: { provider, sessionId }, toSessionRef: null,
        fromActorPath: '/root', toActorPath: null, readerEvent: toolEvent('spawn:delegate:1'),
        provenance: { fidelity: 'recorded', sourceType: 'codex.response_item:function_call', sourceId: '11' },
      } },
      { type: 'coordination', observation: {
        kind: 'spawn', state: 'started', correlationId: 'spawn:delegate:1', eventId: 'event-spawn-1',
        fromSessionRef: { provider, sessionId }, toSessionRef: withChild ? { provider, sessionId: childSessionId } : null,
        fromActorPath: '/root', toActorPath: '/root/inspector', readerEvent: toolEvent('spawn:delegate:1'),
        provenance: { fidelity: 'recorded', sourceType: 'codex.response_item:function_call_output', sourceId: '12' },
      } },
      { type: 'coordination', observation: {
        kind: 'wait', state: 'waiting', correlationId: 'wait:foreground:1', eventId: 'event-wait-call',
        fromSessionRef: { provider, sessionId }, toSessionRef: null, fromActorPath: '/root', toActorPath: null, readerEvent: toolEvent('wait:foreground:1'),
        provenance: { fidelity: 'recorded', sourceType: 'codex.response_item:function_call', sourceId: '17' },
      } },
      { type: 'coordination', observation: {
        kind: 'wait', state: 'timed_out', correlationId: 'wait:foreground:1', eventId: 'event-wait-timeout',
        fromSessionRef: { provider, sessionId }, toSessionRef: null, fromActorPath: '/root', toActorPath: null, readerEvent: toolEvent('wait:foreground:1'),
        provenance: { fidelity: 'recorded', sourceType: 'codex.response_item:function_call_output', sourceId: '18' },
      } },
      { type: 'coordination', observation: {
        kind: 'result', state: 'completed', correlationId: 'spawn:delegate:1', eventId: 'event-result-1',
        fromSessionRef: null, toSessionRef: { provider, sessionId },
        fromActorPath: '/root/inspector', toActorPath: '/root', readerEvent: event('agent-final'),
        provenance: { fidelity: 'recorded', sourceType: 'codex.response_item:agent_message:FINAL_ANSWER', sourceId: '21' },
      } },
    ],
  };
}

async function startHarness(t, withChild = false, withoutCollaboration = false, taskOnly = false, emptyChild = false) {
  const requireFromUi = createRequire(path.join(uiDir, 'package.json'));
  const { build } = requireFromUi('vite');
  const buildDir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-codex-collab-'));
  await build({ root: uiDir, configFile: path.join(uiDir, 'vite.config.ts'),
    build: { outDir: buildDir, emptyOutDir: true }, logLevel: 'error' });

  const data = fixture(withChild);
  if (withoutCollaboration) {
    data.bootstrap.relations = { taskCount: 0, observationCount: 0, firstCursor: null };
    data.relations = [];
  }
  if (taskOnly) {
    data.bootstrap.relations = { taskCount: 1, observationCount: 0, firstCursor: 'codex-relations-0' };
    data.relations = [{ type: 'task', task: {
      id: 'recorded-task', kind: 'task_notification', status: 'completed',
      owner: 'spawn:delegate:1', ownerParticipant: null, subject: null,
      description: 'The recorded source inspection completed.',
      readerEvent: { provider, sessionId, messageId: 'spawn:delegate:1', segment: 'tool' },
      provenance: { fidelity: 'recorded', sourceType: 'task-notification', sourceId: 'notification-1' },
    } }];
  }
  const contentRequests = [];
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    const json = (body, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/providers') {
      json([{ id: provider, available: true }]);
      return;
    }
    if (url.pathname === `/api/v3/reader/${provider}/${sessionId}/bootstrap`) {
      json(data.bootstrap);
      return;
    }
    if (url.pathname === `/api/v3/reader/${provider}/${sessionId}/relations`) {
      json({ session: { provider, sessionId }, revision: data.bootstrap.revision,
        entries: data.relations, childPlacements: withChild ? [{
          child: { provider, sessionId: childSessionId },
          afterEvent: data.bootstrap.segments[0].items[2].event,
          sourceEventId: 'event-spawn-1', diagnostic: null,
        }] : [], nextCursor: null });
      return;
    }
    if (withChild && url.pathname === `/api/v3/reader/${provider}/${childSessionId}/bootstrap`) {
      json({ session: { session: { provider, sessionId: childSessionId }, title: 'Child inspection',
        directory: '/public/child', createdAt: null, updatedAt: null, messageCount: 1,
        tokenCount: null, parent: { provider, sessionId } },
      revision: 'child-collaboration-revision', totalItems: 1,
      segments: [{ id: 'child-segment', pageId: 'child-page', startOrdinal: 0,
        items: [{ event: { provider, sessionId: childSessionId, messageId: 'child-answer', segment: 'message' },
          ordinal: 0, owner: null, role: 'assistant', timestamp: null,
          preview: 'The child checked the source.', totalChars: 29, toolName: null, replyMetadata: null, contentRevisions: {} }],
        ownerContext: null, previousCursor: null, nextCursor: null }],
      toc: { entries: [], previousCursor: null, nextCursor: null },
      relations: { taskCount: 0, observationCount: emptyChild ? 0 : 1, firstCursor: emptyChild ? null : 'child-relations-0' } });
      return;
    }
    if (withChild && url.pathname === `/api/v3/reader/${provider}/${childSessionId}/relations`) {
      json({ session: { provider, sessionId: childSessionId }, revision: 'child-collaboration-revision',
        entries: emptyChild ? [] : [{ type: 'coordination', observation: { kind: 'result', state: 'completed',
          correlationId: 'child-source-result', eventId: 'child-result',
          fromSessionRef: { provider, sessionId: childSessionId }, toSessionRef: { provider, sessionId },
          fromActorPath: '/root/inspector', toActorPath: '/root', readerEvent: null,
          provenance: { fidelity: 'recorded', sourceType: 'public-child', sourceId: '1' } } }],
        childPlacements: [], nextCursor: null });
      return;
    }
    if (url.pathname === `/api/v3/reader/${provider}/${sessionId}/locate`) {
      const target = data.bootstrap.segments[0].items.find(item =>
        item.event.messageId === url.searchParams.get('messageId') && item.event.segment === url.searchParams.get('segment'));
      if (!target || url.searchParams.get('revision') !== data.bootstrap.revision) {
        json({ error: { code: 'not_found' } }, 404);
        return;
      }
      json({ session: { provider, sessionId }, revision: data.bootstrap.revision, event: target.event,
        ordinal: target.ordinal, owner: target.owner, pageCursor: 'page-0', tocCursor: 'toc-0' });
      return;
    }
    if (url.pathname === `/api/v3/reader/${provider}/${sessionId}/toc`) {
      json({ session: { provider, sessionId }, revision: data.bootstrap.revision, toc: data.bootstrap.toc });
      return;
    }
    if (url.pathname === `/api/v3/reader/${provider}/${sessionId}/content`) {
      const offset = Number(url.searchParams.get('offset'));
      const maxChars = Number(url.searchParams.get('maxChars'));
      contentRequests.push({ messageId: url.searchParams.get('messageId'), offset, maxChars });
      if (url.searchParams.get('messageId') !== 'agent-final' || !Number.isInteger(offset) || !Number.isInteger(maxChars)) {
        json({ error: { code: 'invalid_request' } }, 400);
        return;
      }
      const text = finalAnswer.slice(offset, offset + maxChars);
      const nextOffset = offset + text.length < finalAnswer.length ? offset + text.length : null;
      json({ text, offset, totalChars: finalAnswer.length, nextOffset, truncated: nextOffset !== null });
      return;
    }
    if (url.pathname === `/api/v3/resume/${provider}/${sessionId}`) {
      json({ allowTerminalLaunch: false, available: true, diagnostic: null, command: null });
      return;
    }
    if (url.pathname === `/api/v3/meta/${provider}/${sessionId}`) {
      json(null);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      json({ error: { code: 'not_found' } }, 404);
      return;
    }
    const asset = url.pathname === '/' || !url.pathname.startsWith('/assets/')
      ? path.join(buildDir, 'index.html')
      : path.resolve(buildDir, `.${url.pathname}`);
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
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(buildDir, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${port}`, contentRequests };
}

async function startBrowser(t, url) {
  const session = `agentsession-v3-codex-collab-${process.pid}-${Date.now()}`;
  const command = (...args) => new Promise((resolve, reject) => {
    const child = spawn(agentBrowserExe, ['--session', session, ...args], {
      cwd: repo, windowsHide: true, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`agent-browser ${args.join(' ')} timed out after 15 seconds`));
    }, 15_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`agent-browser ${args.join(' ')} failed (${code}): ${stderr || stdout}`));
      else resolve(stdout.trim());
    });
  });
  t.after(async () => { try { await command('close'); } catch { /* Browser may already be closed. */ } });
  await command('open');
  await command('eval', `window.location.href = ${JSON.stringify(url)}`);
  return { command };
}

async function waitForBrowser(command, predicate, description) {
  const deadline = Date.now() + 10_000;
  let last = '';
  while (Date.now() < deadline) {
    last = await command('eval', `Boolean(${predicate})`);
    if (last.includes('true')) return;
    await sleep(80);
  }
  throw new Error(`Timed out waiting for ${description}. Last browser result: ${last}`);
}

// Fixed dock/overlay geometry was retired by the inline collaboration Reader.
// Canonical navigation remains covered here and in ui-collaboration-navigation.test.mjs.

test('a recorded task without a participant remains readable and links to its source event',
  { skip: skipReason, timeout: 45_000 }, async t => {
    const app = await startHarness(t, false, false, true);
    const { command } = await startBrowser(t, `${app.origin}/codex/session/${sessionId}`);
    await waitForBrowser(command, `document.querySelector('.collaboration-launcher')`, 'task-only entry');
    await command('focus', '.collaboration-launcher');
    await command('press', 'Enter');
    await waitForBrowser(command,
      `document.querySelector('.collaboration-unassigned-tasks')?.textContent.includes('The recorded source inspection completed.')`,
      'recorded task summary without a participant');
    assert.match(await command('get', 'text', '.collaboration-unassigned-tasks'), /Latest recorded task state: completed/);
    assert.equal(Number(await command('get', 'count', '.collaboration-child-node')), 0,
      'A task notification alone does not invent a child handoff');
    assert.equal(await command('eval', `document.querySelector('.collaboration-unassigned-tasks details').open`), 'false');
    await command('select', '.language-select', 'zh');
    assert.match(await command('get', 'text', '.collaboration-unassigned-tasks'), /最近记录的任务状态.*已完成/s);
    await command('focus', '.collaboration-unassigned-tasks button');
    await command('press', 'Enter');
    await waitForBrowser(command, `location.hash === '#event?messageId=spawn%3Adelegate%3A1&segment=tool'`,
      'the canonical recorded task source');
  });

test('a session without collaboration keeps the full three-column Reader on wide desktop',
  { skip: skipReason, timeout: 45_000 }, async t => {
    const app = await startHarness(t, false, true);
    const { command } = await startBrowser(t, `${app.origin}/codex/session/${sessionId}`);
    await command('set', 'viewport', '1920', '900');
    await waitForBrowser(command, `document.querySelector('.reader-layout') && document.querySelector('.reader-main')`,
      'the Reader body');
    assert.equal(await command('eval', `document.querySelector('.reader-layout').classList.contains('collaboration-docked')`),
      'false', 'A missing collaboration panel must not reserve a dock column');
    assert.equal(await command('eval', `Boolean(document.querySelector('.collaboration-summary, .collaboration-launcher'))`),
      'false');
  });

test('an inline child with no recorded collaboration has an explicit localized empty state',
  { skip: skipReason, timeout: 45_000 }, async t => {
    const app = await startHarness(t, true, false, false, true);
    const { command } = await startBrowser(t, `${app.origin}/codex/session/${sessionId}`);
    await waitForBrowser(command, `document.querySelector('.collaboration-launcher')`, 'parent collaboration entry');
    await command('click', '.collaboration-launcher');
    await waitForBrowser(command, `document.querySelector('.inline-child-toggle')`, 'recorded child insertion');
    await command('eval', `document.querySelector('.inline-child-toggle').click()`);
    await waitForBrowser(command, `document.querySelector('.inline-child-reader') &&
      document.querySelector('.collaboration-empty')?.textContent === 'No recorded tasks or agent messages.'`,
      'an explicit empty child panel');
    assert.equal(Number(await command('get', 'count', '.collaboration-handoff')), 0,
      'The empty child panel does not retain parent handoffs');
    await command('select', '.language-select', 'zh');
    assert.equal(await command('get', 'text', '.collaboration-empty'), '没有已记录的任务或助手消息。');
    await command('eval', `document.querySelector('.inline-child-collapse').click()`);
    await waitForBrowser(command, `!document.querySelector('.collaboration-empty') &&
      document.querySelector('.collaboration-handoff[data-collaboration-handoff="spawn:delegate:1"]')`,
      'the restored parent facts');
  });

test('the collaboration panel follows the deepest open child and its recorded facts',
  { skip: skipReason, timeout: 60_000 }, async t => {
    const app = await startHarness(t, true);
    const { command } = await startBrowser(t, `${app.origin}/codex/session/${sessionId}`);
    await command('set', 'viewport', '1280', '900');
    await waitForBrowser(command, `document.querySelector('.collaboration-launcher')`,
      'the child fixture collaboration entry');
    await command('click', '.collaboration-launcher');
    await waitForBrowser(command, `document.querySelector('.collaboration-handoff[data-collaboration-handoff="spawn:delegate:1"]')`,
      'the root collaboration owner');
    await waitForBrowser(command, `document.querySelector('.inline-child-toggle')`,
      'the recorded child insertion point');
    await command('eval', `document.querySelector('.inline-child-toggle').click()`);
    await waitForBrowser(command, `document.querySelector('.inline-child-reader') &&
      document.querySelector('.collaboration-handoff[data-collaboration-handoff="child-source-result"]')`,
      'the child-owned panel after expanding its inline pane');
    assert.equal(Number(await command('get', 'count', '.collaboration-handoff[data-collaboration-handoff="spawn:delegate:1"]')), 0,
      'Root facts are not presented as child facts');
    await command('eval', `document.querySelector('.inline-child-collapse').click()`);
    await waitForBrowser(command, `!document.querySelector('.inline-child-reader') &&
      document.querySelector('.collaboration-handoff[data-collaboration-handoff="spawn:delegate:1"]')`,
      'the root-owned panel after collapsing the child');
    await command('back');
    await waitForBrowser(command, `document.querySelector('.inline-child-reader') &&
      document.querySelector('.collaboration-handoff[data-collaboration-handoff="child-source-result"]')`,
      'Back restores the child-owned panel');
    await command('forward');
    await waitForBrowser(command, `!document.querySelector('.inline-child-reader') &&
      document.querySelector('.collaboration-handoff[data-collaboration-handoff="spawn:delegate:1"]')`,
      'Forward restores the root-owned panel');
  });

test('Codex collaboration graph resolves dispatch and return while keeping agent answers distinct',
  { skip: skipReason || false, timeout: 60_000 }, async t => {
    const harness = await startHarness(t);
    const { command } = await startBrowser(t, `${harness.origin}/${provider}/session/${sessionId}`);
    await waitForBrowser(command,
      `document.querySelector('#reader-title')?.textContent.trim() === 'Codex collaboration fixture'`,
      'the Codex Reader');

    assert.equal(Number(await command('get', 'count', '.reader-main .turn-block')), 3,
      'The agent response stays separate from the parent assistant turn');
    assert.equal(Number(await command('get', 'count', '.agent-card')), 1,
      'The agent response has a distinct card');
    assert.equal(JSON.parse(await command('eval', `document.querySelector('.agent-card .event-header strong')?.title`)), '/root/inspector',
      'The friendly agent label retains its recorded actor path');
    await waitForBrowser(command, `document.querySelector('.agent-card .event-body')?.textContent === ${JSON.stringify(finalAnswer)}`,
      'the complete short agent answer');
    assert.equal(await command('get', 'text', '.agent-card .event-body'), finalAnswer,
      'The Reader loads the complete short agent answer');

    await waitForBrowser(command, `document.querySelector('.collaboration-launcher')`,
      'the recorded collaboration entry');
    await command('click', '.collaboration-launcher');
    await waitForBrowser(command, `document.querySelector('.collaboration-summary')`, 'recorded collaboration panel');
    assert.equal(await command('get', 'text', '.collaboration-parent strong'), 'Main assistant',
      'The graph names the recorded parent');
    assert.equal(await command('get', 'text', '.collaboration-child-node strong'), 'inspector',
      'The graph names the recorded delegate');
    assert.equal(JSON.parse(await command('eval', `document.querySelector('.collaboration-child-node strong')?.title`)),
      '/root/inspector', 'The graph retains the recorded delegate actor path');
    await command('click', '.collaboration-child-node');
    await waitForBrowser(command, `document.querySelector('.collaboration-selected-details')`,
      'the selected delegate actions');
    assert.equal(Number(await command('get', 'count', '.collaboration-handoff-actions a')), 0,
      'An actor path without a canonical child session does not create a child conversation link');
    await command('click', '.collaboration-handoff-actions button');
    await waitForBrowser(command,
      `location.hash === '#event?messageId=spawn%3Adelegate%3A1&segment=tool'`,
      'graph navigation to the exact dispatch tool');
    assert.equal(await command('eval', `Boolean(document.querySelector('.tool-card[data-message-id="spawn:delegate:1"][data-segment="tool"]'))`),
      'true', 'The dispatch action resolves its recorded tool card');
    await command('click', '.collaboration-launcher');
    await command('click', '.collaboration-child-node');
    await command('click', '.collaboration-return button');
    await waitForBrowser(command, `location.hash === '#event?messageId=agent-final&segment=message'`,
      'graph navigation to the exact returned agent message');

    await waitForBrowser(command,
      `document.querySelector('.agent-card .event-body')?.textContent === ${JSON.stringify(finalAnswer)}`,
      'the complete agent answer');
    assert.deepEqual(harness.contentRequests.map(({ messageId, offset }) => [messageId, offset]), [['agent-final', 0]],
      'The short answer requests content for the exact agent event');
  });
