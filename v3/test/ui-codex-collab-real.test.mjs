import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const provider = 'codex';
const fixtureDirectory = path.join(repo, 'v3', 'fixtures', 'codex-collaboration',
  'sessions', '2026', '09', '27');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');

function findAgentBrowser() {
  const override = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN;
  if (override && existsSync(override)) return override;
  const binaryName = process.platform === 'win32'
    ? 'agent-browser-win32-x64.exe'
    : `agent-browser-${process.platform}-${process.arch}`;
  return (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', binaryName))
    .find(existsSync);
}

const agentBrowserExe = findAgentBrowser();
const skipReason = !agentBrowserExe || !existsSync(agentBrowserExe)
  ? 'The agent-browser CLI is required for the real Reader browser test.'
  : false;

const expectedRows = [
  { kind: 'spawn', state: 'requested', sourceId: '2',
    sourceType: 'codex.response_item:function_call', messageId: 'spawn-1', segment: 'tool' },
  { kind: 'spawn', state: 'started', sourceId: '4',
    sourceType: 'codex.response_item:function_call_output', messageId: 'spawn-1', segment: 'tool' },
  { kind: 'wait', state: 'waiting', sourceId: '5',
    sourceType: 'codex.response_item:function_call', messageId: 'wait-1', segment: 'tool' },
  { kind: 'wait', state: 'timed_out', sourceId: '6',
    sourceType: 'codex.response_item:function_call_output', messageId: 'wait-1', segment: 'tool' },
  { kind: 'result', state: 'completed', sourceId: '7',
    sourceType: 'codex.response_item:agent_message:FINAL_ANSWER', messageId: 'agent-result', segment: 'message' },
];

const expectedResult = '  The review found one actionable issue.\n';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function loadPublicFixture() {
  const names = (await readdir(fixtureDirectory)).filter(name => name.endsWith('.jsonl'));
  assert.equal(names.length, 1, 'The public collaboration fixture directory has one transcript');
  const file = path.join(fixtureDirectory, names[0]);
  const bytes = await readFile(file);
  const firstLine = bytes.toString('utf8').split(/\r?\n/, 1)[0];
  const header = JSON.parse(firstLine);
  assert.equal(header.type, 'session_meta');
  assert.equal(typeof header.payload?.id, 'string');
  return { file, bytes, sessionId: header.payload.id, hash: sha256(bytes) };
}

async function freePort() {
  return freeFetchSafePort();
}

function browserCommand(session) {
  return (...args) => new Promise((resolve, reject) => {
    const child = spawn(agentBrowserExe, ['--session', session, ...args], {
      cwd: repo,
      windowsHide: true,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
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
}

async function waitFor(command, expression, description) {
  const deadline = Date.now() + 10_000;
  let last = '';
  while (Date.now() < deadline) {
    last = await command('eval', `Boolean(${expression})`);
    if (last.includes('true')) return;
    await sleep(80);
  }
  throw new Error(`Timed out waiting for ${description}. Last browser result: ${last}`);
}

function stableAnchor(sessionId, messageId, segment) {
  const key = JSON.stringify([provider, sessionId, messageId, segment]);
  return `event-${Buffer.from(key, 'utf8').toString('hex')}`;
}

test('real Axum Reader preserves Codex source facts and graph dispatch-return navigation',
  { skip: skipReason || false, timeout: 120_000 }, async t => {
    assert.ok(existsSync(binary), `Build the current v3 debug binary at ${binary}`);
    const fixture = await loadPublicFixture();
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-codex-collab-real-'));
    const codexDirectory = path.join(scratch, 'codex');
    const sessionDirectory = path.join(codexDirectory, 'sessions', '2026', '09', '27');
    await mkdir(sessionDirectory, { recursive: true });
    for (const name of ['meta', 'index', 'cache', 'claude', 'pi', 'dsh']) {
      await mkdir(path.join(scratch, name));
    }
    const copiedFixture = path.join(sessionDirectory, path.basename(fixture.file));
    await copyFile(fixture.file, copiedFixture);
    assert.equal(sha256(await readFile(copiedFixture)), fixture.hash,
      'The isolated source copy matches the public fixture SHA');

    const port = await freePort();
    const server = spawn(binary, ['serve', '--port', String(port), '--codex-dir', codexDirectory,
      '--opencode-db', path.join(scratch, 'opencode.db'), '--claude-dir', path.join(scratch, 'claude'),
      '--pi-dir', path.join(scratch, 'pi'), '--dsh-dir', path.join(scratch, 'dsh'),
      '--meta-dir', path.join(scratch, 'meta'), '--index-dir', path.join(scratch, 'index'),
      '--cache-dir', path.join(scratch, 'cache')], {
      cwd: scratch,
      windowsHide: true,
      stdio: 'ignore',
    });
    let command;
    t.after(async () => {
      try { if (command) await command('close'); } catch { /* Browser may already be closed. */ }
      if (server.exitCode === null) {
        const closed = once(server, 'close');
        server.kill();
        await closed;
      }
      try {
        assert.equal(sha256(await readFile(fixture.file)), fixture.hash,
          'The public source fixture remains byte-for-byte unchanged');
        assert.equal(sha256(await readFile(copiedFixture)), fixture.hash,
          'The server leaves its isolated source copy unchanged');
      } finally {
        const physical = await realpath(scratch);
        assert.equal(path.dirname(physical).toLowerCase(), (await realpath(os.tmpdir())).toLowerCase());
        await rm(physical, { recursive: true, force: true });
      }
    });

    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(`${origin}/api/providers`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { ready = true; break; }
      } catch { /* The isolated Axum server may still be starting. */ }
      await sleep(100);
    }
    assert.equal(ready, true, 'The public-source Axum Reader starts');

    const reader = `${origin}/api/v3/reader/${provider}/${encodeURIComponent(fixture.sessionId)}`;
    const bootstrapResponse = await fetch(`${reader}/bootstrap`);
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = await bootstrapResponse.json();
    assert.equal(bootstrap.relations.observationCount, 5);
    assert.ok(bootstrap.relations.firstCursor);

    const relationsResponse = await fetch(`${reader}/relations?cursor=${encodeURIComponent(bootstrap.relations.firstCursor)}`);
    assert.equal(relationsResponse.status, 200);
    const relations = await relationsResponse.json();
    assert.equal(relations.entries.length, 5);
    const actualRows = relations.entries.map(entry => {
      assert.equal(entry.type, 'coordination');
      const observation = entry.observation;
      assert.equal(observation.provenance.fidelity, 'recorded');
      assert.ok(observation.readerEvent, `${observation.eventId} has a Reader event reference`);
      return {
        kind: observation.kind,
        state: observation.state,
        eventId: observation.eventId,
        sourceType: observation.provenance.sourceType,
        sourceId: observation.provenance.sourceId,
        readerEvent: {
          provider: observation.readerEvent.provider,
          sessionId: observation.readerEvent.sessionId,
          messageId: observation.readerEvent.messageId,
          segment: observation.readerEvent.segment,
        },
      };
    });
    const expectedApiRows = expectedRows.map(row => ({
      kind: row.kind,
      state: row.state,
      eventId: `event:codex:${row.sourceId}`,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      readerEvent: {
        provider,
        sessionId: fixture.sessionId,
        messageId: row.messageId,
        segment: row.segment,
      },
    }));
    assert.deepEqual(actualRows, expectedApiRows,
      'Spawn, wait, and result rows preserve recorded provenance and their exact Reader source');
    const returned = relations.entries.find(entry => entry.observation.kind === 'result').observation;
    assert.equal(returned.fromActorPath, '/root/reviewer', 'The result preserves its recorded sender');
    assert.equal(returned.toActorPath, '/root', 'The result preserves its recorded recipient');
    const dispatch = relations.entries.find(entry => entry.observation.kind === 'spawn' &&
      entry.observation.state === 'requested').observation;
    assert.equal(dispatch.correlationId, returned.correlationId,
      'The gutter endpoints come from the same recorded handoff');

    const sessionUrl = `/${provider}/session/${encodeURIComponent(fixture.sessionId)}`;
    const sessionBrowser = `agentsession-v3-codex-collab-real-${process.pid}-${Date.now()}`;
    command = browserCommand(sessionBrowser);
    await command('open', `${origin}${sessionUrl}`);
    await waitFor(command, `Boolean(document.querySelector('.agent-card'))`,
      'the real Codex Reader');
    await waitFor(command, `Boolean(document.querySelector('.collaboration-launcher:not([hidden])'))`,
      'the default collapsed collaboration overview');
    assert.equal(await command('eval', `getComputedStyle(document.querySelector('.collaboration-launcher')).position === 'fixed'`),
      'false', 'The collaboration overview launcher stays in the conversation flow');
    assert.equal(await command('eval', `Boolean(document.querySelector('#collaboration-panel:not([hidden])'))`),
      'false', 'The collaboration overview starts collapsed');
    await command('click', '.collaboration-launcher');
    await waitFor(command, `Boolean(document.querySelector('.collaboration-child-node'))`,
      'the real Codex collaboration graph');

    const resultAnchor = stableAnchor(fixture.sessionId, 'agent-result', 'message');
    await waitFor(command,
      `document.getElementById(${JSON.stringify(resultAnchor)})?.matches('.agent-card')`,
      'the distinct recorded agent result card');
    await waitFor(command,
      `document.querySelector(${JSON.stringify(`#${resultAnchor} .event-header strong`)})?.textContent.trim() === 'reviewer'`,
      'the recorded result identity from loaded relation facts');
    assert.equal(Number(await command('get', 'count', '.assistant-card')), 1,
      'The parent assistant reply remains a separate Reader card');
    assert.equal(await command('get', 'text', `#${resultAnchor} .event-header strong`), 'reviewer',
      'The result card names the recorded sender');
    assert.equal(await command('get', 'text', `#${resultAnchor} .agent-recipient`), '→ Main assistant',
      'The result card names the recorded recipient');
    assert.equal(JSON.parse(await command('eval',
      `document.querySelector(${JSON.stringify(`#${resultAnchor} .event-header strong`)})?.title`)), '/root/reviewer',
    'The readable sender retains its canonical recorded actor path');
    assert.match(await command('get', 'text', `#${resultAnchor} .event-body`),
      /The review found one actionable issue\./,
      'The Reader renders the agent result content');
    assert.equal(Number(await command('get', 'count', '.event-card .source-details')), 0,
      'Raw Message details are removed from every Reader event card');
    assert.equal(await command('eval', `Boolean([...document.querySelectorAll('.collaboration-summary')]
      .some(node => getComputedStyle(node).position === 'fixed'))`), 'false',
    'Collaboration stays in the conversation flow');
    assert.equal(await command('eval', 'document.querySelectorAll(".collaboration-selected-details").length'), '0',
      'The graph starts with handoff details collapsed');
    await command('click', '.collaboration-child-node');
    const technical = JSON.parse(await command('eval', `(() => {
      const details = document.querySelector('.collaboration-source-details');
      const tags = details?.querySelector('.collaboration-request-tags');
      return { open: details?.open, label: details?.querySelector(':scope > summary')?.textContent.trim(),
        tagsInside: Boolean(tags),
        visibleTags: Number(Boolean(tags && !tags.closest('details:not([open])') && tags.checkVisibility())) };
    })()`));
    assert.deepEqual(technical, { open: false, label: 'Technical details', tagsInside: true, visibleTags: 0 },
      'Launch parameters and raw coordination history stay inside collapsed technical details');
    await command('click', '.collaboration-source-details > summary');
    assert.equal(await command('eval', 'document.querySelector(".collaboration-source-details")?.open'), 'true',
      'Recorded collaboration technical details remain available on demand');
    await command('click', '.collaboration-source-details > summary');
    await waitFor(command, `Boolean(document.querySelector('.transcript .dispatch-point'))`,
      'the recorded dispatch and return gutter');
    const gutter = JSON.parse(await command('eval', `(() => {
      const host = document.querySelector('.transcript');
      const dispatch = host.querySelector('.dispatch-point');
      const returned = host.querySelector('.return-point');
      const sourceCard = document.getElementById(${JSON.stringify(stableAnchor(fixture.sessionId, 'spawn-1', 'tool'))});
      const resultCard = document.getElementById(${JSON.stringify(resultAnchor)});
      const visibleAnchor = card => {
        let anchor = card;
        for (let parent = card.parentElement; parent && parent !== host; parent = parent.parentElement) {
          if (parent instanceof HTMLDetailsElement && !parent.open) anchor = parent.querySelector(':scope > summary');
        }
        return anchor.getBoundingClientRect();
      };
      const source = visibleAnchor(sourceCard); const result = visibleAnchor(resultCard);
      const pointBounds = point => (point.closest('.collaboration-gutter-group')
        ?.querySelector(':scope > summary') ?? point).getBoundingClientRect();
      const dispatchBounds = pointBounds(dispatch); const returnBounds = pointBounds(returned);
      return { dispatchHref: dispatch.getAttribute('href'), returnHref: returned.getAttribute('href'),
        connector: host.querySelector('path[data-collaboration-connector]')?.getAttribute('data-collaboration-connector'),
        path: host.querySelector('path[data-collaboration-connector]')?.getAttribute('d'),
        dispatchY: dispatchBounds.top + dispatchBounds.height / 2, returnY: returnBounds.top + returnBounds.height / 2,
        sourceY: source.top + 18, resultY: result.top + 18,
        gutterRight: Math.max(dispatchBounds.right, returnBounds.right),
        contentLeft: Math.min(sourceCard.getBoundingClientRect().left || source.left, result.left) };
    })()`));
    assert.equal(gutter.dispatchHref, `${sessionUrl}#event?messageId=agent-result&segment=message`,
      'The dispatch point jumps to the exact recorded return');
    assert.equal(gutter.returnHref, `${sessionUrl}#event?messageId=spawn-1&segment=tool`,
      'The return point jumps to the exact canonical dispatch');
    assert.equal(gutter.connector, dispatch.correlationId);
    assert.match(gutter.path, /^M .+ H .+ Q .+ V .+ Q .+ H /, 'The visible handoff has a continuous connector');
    assert.ok(Math.abs(gutter.dispatchY - gutter.sourceY) < 2 && Math.abs(gutter.returnY - gutter.resultY) < 2,
      `Gutter endpoints align with their source cards or collapsed process summary: ${JSON.stringify(gutter)}`);
    assert.ok(gutter.gutterRight < gutter.contentLeft, 'The handoff connector stays in the transcript left gutter');

    assert.equal(await command('eval', 'document.querySelector(".outline-turn-toggle")?.getAttribute("aria-expanded")'),
      '"false"', 'The recorded request starts with its children folded');
    await command('eval', 'window.scrollTo({ top: 0, behavior: "instant" })');
    await command('click', '.reader-find-toggle');
    await command('fill', '.pane-search[data-scope="session"] input[type="search"]', 'actionable issue');
    await command('click', '.pane-search[data-scope="session"] button[type="submit"]');
    await waitFor(command, `document.querySelectorAll('.pane-search-result').length === 1`,
      'the exact agent result search match');
    await command('click', '.pane-search-result');
    await waitFor(command, `document.querySelector('.outline-turn-toggle')?.getAttribute('aria-expanded') === 'true'`,
      'search navigation opening the matching request group');
    assert.equal(await command('eval', 'document.querySelector(".outline-turn .outline-children")?.hidden'), 'false',
      'The matching reply entries become visible after session search navigation');
    assert.equal(await command('eval', `Boolean([...document.querySelectorAll('.reader-outline a[href]')]
      .find(link => link.getAttribute('href') === '#event?messageId=agent-result&segment=message')?.getClientRects().length)`),
    'true', 'Search opens the exact returned-result outline link');

    for (const [selector, messageId, segment] of [
      ['.collaboration-handoff-actions button', 'spawn-1', 'tool'],
      ['.collaboration-return button', 'agent-result', 'message'],
    ]) {
      if (await command('eval', `Boolean(document.querySelector('.collaboration-selected-details'))`) === 'false') {
        await command('click', '.collaboration-launcher');
        await command('click', '.collaboration-child-node');
      }
      const expectedHash = `#event?${new URLSearchParams({ messageId, segment })}`;
      await command('eval', `document.querySelector(${JSON.stringify(selector)}).click()`);
      await waitFor(command, `location.hash === ${JSON.stringify(expectedHash)}`,
        `graph navigation to the recorded ${segment} event`);
      const anchor = stableAnchor(fixture.sessionId, messageId, segment);
      const cardClass = segment === 'tool' ? '.tool-card' : '.agent-card';
      await waitFor(command,
        `document.getElementById(${JSON.stringify(anchor)})?.matches(${JSON.stringify(cardClass)})`,
        'the exact graph source card');
      const cardSource = JSON.parse(await command('eval',
        `(() => { const article = document.getElementById(${JSON.stringify(anchor)}); return article ? article.dataset.messageId + ' / ' + article.dataset.segment : null; })()`));
      assert.equal(cardSource, `${messageId} / ${segment}`,
        'The graph action lands on its exact recorded Reader card');
    }

    const result = expectedRows.at(-1);
    const contentQuery = new URLSearchParams({
      revision: bootstrap.revision,
      messageId: result.messageId,
      segment: result.segment,
      field: 'body',
      offset: '0',
      maxChars: '1000',
    });
    const contentResponse = await fetch(`${reader}/content?${contentQuery}`);
    assert.equal(contentResponse.status, 200, 'The complete recorded result is retrievable');
    const content = await contentResponse.json();
    assert.equal(content.text, expectedResult);
    assert.equal(content.totalChars, expectedResult.length);
    assert.equal(content.nextOffset, null);
    assert.equal(content.truncated, false);
  });
