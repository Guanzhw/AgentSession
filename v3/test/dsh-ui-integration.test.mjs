import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const provider = 'deepseek-harness';
const ids = { root: 'dsh-v3-s2-root', alpha: 'dsh-v3-s2-alpha', beta: 'dsh-v3-s2-beta' };
const codexSessionId = '44444444-4444-4444-8444-444444444444';
const codexDir = path.join(repo, 'v3', 'fixtures', 'codex');
const dshDir = path.join(repo, 'v3', 'fixtures', 'deepseek-harness');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const sourceFiles = [
  path.join(codexDir, 'sessions', '2026', '09', '26',
    'rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl'),
  ...Object.values(ids).map(id => path.join(dshDir, 'sessions', 's2-synthetic', id, 'session.v3.jsonl.zstd')),
];
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

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
const skipReason = !agentBrowserExe
  ? 'The agent-browser CLI is required; the test does not install it or download a browser.'
  : false;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function freePort() {
  return freeFetchSafePort();
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill();
  await closed;
}

async function startServer(t, dshSource = dshDir) {
  assert.ok(existsSync(binary), `Build the S2 Rust binary at ${binary}`);
  const sourceHashes = sourceFiles.map(sha256);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-dsh-ui-'));
  let child;
  let browserCleanup;
  t.after(async () => {
    try {
      try { await browserCleanup?.(); } finally { await stopServer(child); }
      assert.deepEqual(sourceFiles.map(sha256), sourceHashes,
        'The real Web process must leave public Codex and DSH source files unchanged');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  const stateDirs = ['meta', 'index', 'cache', 'claude', 'pi'];
  await Promise.all(stateDirs.map(name => mkdir(path.join(tempDir, name), { recursive: true })));
  const args = [
    '--codex-dir', codexDir,
    '--opencode-db', path.join(tempDir, 'opencode.db'),
    '--claude-dir', path.join(tempDir, 'claude'),
    '--pi-dir', path.join(tempDir, 'pi'),
    '--dsh-dir', dshSource,
    '--meta-dir', path.join(tempDir, 'meta'),
    '--index-dir', path.join(tempDir, 'index'),
    '--cache-dir', path.join(tempDir, 'cache'),
  ];
  const port = await freePort();
  let processOutput = '';
  child = spawn(binary, ['serve', '--port', String(port), ...args], {
    cwd: repo,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { processOutput += chunk.toString(); });
  child.stderr.on('data', chunk => { processOutput += chunk.toString(); });

  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/providers`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch { /* The local server may still be starting. */ }
    await sleep(100);
  }
  assert.ok(ready, `The real Axum server did not become ready: ${processOutput}`);

  return {
    origin: `http://127.0.0.1:${port}`,
    setBrowserCleanup(cleanup) { browserCleanup = cleanup; },
  };
}

async function longAlphaCorpus(t, teamMessageText = null) {
  const fixtureRoot = path.join(repo, 'tmp');
  await mkdir(fixtureRoot, { recursive: true });
  const source = await mkdtemp(path.join(fixtureRoot, 'v3-inline-child-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  for (const id of [ids.root, ids.beta]) {
    const relative = path.join('sessions', 's2-synthetic', id, 'session.v3.jsonl.zstd');
    await mkdir(path.dirname(path.join(source, relative)), { recursive: true });
    await copyFile(path.join(dshDir, relative), path.join(source, relative));
  }
  const baseTime = 1_780_000_000_000;
  const row = (seq, type, data, extra = {}) => ({ type, seq, time: baseTime + seq + 1, data, ...extra });
  const text = value => [{ type: 'text', text: value }];
  const records = [
    { type: 'session', version: 3, id: ids.alpha, createdAt: baseTime, cwd: '/synthetic/dsh-s2',
      isSeeded: false, delegationDepth: 1, agentPreset: 'standard', parentSession: ids.root, origin: 'subagent' },
    row(0, 'subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'subagent', label: 'alpha' }),
    row(1, 'turn/start', { turn: 1 }),
    row(2, 'user/message', { id: 'alpha-user', role: 'user', source: { kind: 'user' }, content: text('Inspect synthetic alpha.') }, { surfaceOp: 'append' }),
    row(3, 'step/start', { turn: 1, step: 1 }),
  ];
  for (let index = 0; index < 40; index++) {
    records.push(row(index + 4, 'assistant/message', { turn: 1, step: 1,
      message: { id: `alpha-answer-${index}`, role: 'assistant', source: { kind: 'model', provider: 'synthetic', model: 'fixture-only' },
        content: text(index === 39 ? 'Synthetic alpha result. ALPHA-END.' : `Synthetic alpha continuation ${index}.`) } }, { surfaceOp: 'append' }));
  }
  records.push(row(44, 'step/end', { turn: 1, step: 1 }), row(45, 'turn/end', { turn: 1, reason: { kind: 'completed' } }));
  if (teamMessageText !== null) records.push(
    row(46, 'team/member', { version: 2, teamId: ids.root, member: { id: ids.root,
      name: 'lead', description: 'Synthetic lead', provider: 'subagent', context: 'fresh', phase: 'active' } }),
    row(47, 'team/message/queued', { version: 2, teamId: ids.root, message: {
      id: 'alpha-revision-mail', senderId: ids.alpha, senderName: 'alpha', targetId: ids.root,
      delivery: 'quiet', content: [{ type: 'text', text: teamMessageText }],
    } }),
  );
  const file = path.join(source, 'sessions', 's2-synthetic', ids.alpha, 'session.v3.jsonl.zstd');
  await mkdir(path.dirname(file), { recursive: true });
  async function writeRecords() {
    const midpoint = Math.ceil(records.length / 2);
    const frames = [records.slice(0, midpoint), records.slice(midpoint)]
      .map(part => zstdCompressSync(Buffer.from(part.map(value => JSON.stringify(value)).join('\n') + '\n')));
    await writeFile(file, Buffer.concat(frames));
  }
  await writeRecords();
  return { source, file, hash: sha256(file), async rewriteTeamMessage(text) {
    records.at(-1).data.message.content[0].text = text;
    await writeRecords();
  } };
}

async function startBrowser(harness, url) {
  const session = `agentsession-v3-dsh-ui-${process.pid}-${Date.now()}`;
  const command = (...args) => new Promise((resolve, reject) => {
    const child = spawn(agentBrowserExe, ['--session', session, ...args], {
      cwd: repo,
      windowsHide: true,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.destroy();
      child.stderr.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`agent-browser ${args.join(' ')} timed out after 15 seconds`));
    }, 15_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => finish(error));
    child.once('exit', code => {
      if (code !== 0) {
        finish(new Error(`agent-browser ${args.join(' ')} failed (${code}): ${stderr || stdout}`));
        return;
      }
      finish(undefined, stdout.trim());
    });
  });
  harness.setBrowserCleanup(async () => {
    try { await command('close'); } catch { /* The browser may already be closed after a failure. */ }
  });

  await command('open');
  await command('eval', `window.location.href = ${JSON.stringify(url)}`);
  return { command };
}

async function waitForBrowser(command, predicate, description, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await command('eval', `Boolean(${predicate})`);
    if (last.includes('true')) return;
    await sleep(75);
  }
  throw new Error(`Timed out waiting for ${description}. Last browser result: ${last}`);
}

test('public DSH relation source order gives an exact inline child insertion', async t => {
  const harness = await startServer(t);
  const base = `${harness.origin}/api/v3/reader/${provider}/${ids.root}`;
  const bootstrap = await (await fetch(`${base}/bootstrap`)).json();
  const page = await (await fetch(`${base}/relations?cursor=${encodeURIComponent(bootstrap.relations.firstCursor)}`)).json();
  const placement = page.childPlacements?.find(row => row.child.sessionId === ids.alpha);
  assert.deepEqual(placement, {
    child: { provider, sessionId: ids.alpha },
    afterEvent: { provider, sessionId: ids.root, messageId: 'root-dispatch', segment: 'message' },
    sourceEventId: 'event:dsh:8',
    diagnostic: null,
  });
  assert.equal(page.childPlacements.filter(row => row.child.sessionId === ids.alpha).length, 1);
});

test('public DSH sessions work through the real Axum Library and Reader',
  { skip: skipReason || false, timeout: 90_000 }, async t => {
    const harness = await startServer(t);
    const { command } = await startBrowser(harness, `${harness.origin}/sessions`);
    const codexHref = `/codex/session/${codexSessionId}`;
    const rootHref = `/${provider}/session/${ids.root}`;
    const alphaHref = `/${provider}/session/${ids.alpha}`;
    const betaHref = `/${provider}/session/${ids.beta}`;

    await command('wait', `a[href="${codexHref}"]`);
    await command('wait', `a[href="${rootHref}"]`);
    assert.equal(Number(await command('get', 'count', `a[href="${codexHref}"]`)), 1,
      'The Library shows the public Codex session');
    assert.equal(Number(await command('get', 'count', `a[href="${rootHref}"]`)), 1,
      'The Library shows the public DSH root session');
    assert.equal(Number(await command('get', 'count', '.session-row')), 2,
      'Only the public Codex and DSH roots occupy top-level Library rows');
    assert.equal(Number(await command('get', 'count', '.family-child-row')), 0,
      'The two DSH children stay inside the collapsed root family');
    await command('eval', `document.querySelector('button[data-family-toggle="${provider}/${ids.root}"]').click()`);
    await waitForBrowser(command, `document.querySelectorAll('.family-child-row').length === 2`,
      'both public DSH children inside the Library family');
    assert.equal(Number(await command('get', 'count', `.family-child-row[href="${alphaHref}"]`)), 1);
    assert.equal(Number(await command('get', 'count', `.family-child-row[href="${betaHref}"]`)), 1);

    await command('eval', `window.__agentsessionApiCalls = []; const originalFetch = window.fetch.bind(window); window.fetch = async (...args) => { const input = args[0]; const url = new URL(input instanceof Request ? input.url : String(input), window.location.href); const response = await originalFetch(...args); if (url.pathname.startsWith('/api/v3/reader/')) { let body = null; try { body = await response.clone().json(); } catch {} const session = body?.session?.session ?? body?.session ?? null; const entries = Array.isArray(body?.entries) ? body.entries : null; window.__agentsessionApiCalls.push({ path: url.pathname, status: response.status, session, revision: body?.revision ?? null, relationCounts: entries ? { tasks: entries.filter(entry => entry.type === 'task').length, coordination: entries.filter(entry => entry.type === 'coordination').length, total: entries.length } : null }); } return response; };`);

    await command('eval', `document.querySelector('a[href="${rootHref}"]').click()`);
    await waitForBrowser(command,
      `window.location.pathname === '${rootHref}' && document.querySelector('.reader-byline')?.textContent.includes('DeepSeek Harness')`,
      'the public DSH root Reader');
    assert.equal(await command('get', 'text', '.reader-session-details .session-details-content dl dd:nth-of-type(2) code'), ids.root,
      'The Reader keeps the canonical DSH root session ID');

    if (await command('eval', `Boolean(document.querySelector('.collaboration-launcher:not([hidden])'))`) === 'true') {
      await command('click', '.collaboration-launcher');
    }
    assert.doesNotMatch(await command('get', 'text', '#collaboration-panel'),
      /Collaboration sources|Inspect recorded tasks and handoffs|Load more recorded work/,
      'The Reader keeps the relationship graph without the source and inspection sections');
    await waitForBrowser(command,
      `document.querySelector('[data-member-id="${ids.alpha}"]') && document.querySelector('[data-member-id="${ids.beta}"]')`,
      'recorded alpha and beta participant choices');
    await command('click', `[data-member-id="${ids.alpha}"]`);
    await waitForBrowser(command,
      `document.querySelector('[data-event-id="event:dsh:8"].collaboration-exchange')?.textContent.includes('Inspect synthetic alpha.')`,
      'alpha queued-message excerpt');
    const longPreview = await command('get', 'text', '[data-event-id="event:dsh:15"].collaboration-exchange');
    assert.match(longPreview, /Message preview/);
    assert.match(longPreview, /Read full team message/);
    assert.doesNotMatch(longPreview, /FINAL-ALPHA-FOLLOWUP-MARKER/);
    await command('click', '[data-event-id="event:dsh:15"] .collaboration-message-more');
    await waitForBrowser(command,
      `document.querySelector('[data-event-id="event:dsh:15"] .collaboration-message-body')?.textContent.includes('FINAL-ALPHA-FOLLOWUP-MARKER')`,
      'full source-backed alpha team message');
    assert.match(await command('get', 'text', '[data-event-id="event:dsh:15"] .collaboration-message-body'),
      /Also check the alpha ending marker\.[\s\S]*FINAL-ALPHA-FOLLOWUP-MARKER/);
    assert.match(await command('get', 'text', '.collaboration-assignment'), /Latest recorded task state/);
    const alphaSequence = JSON.parse(await command('eval',
      `[...document.querySelectorAll('.collaboration-thread [data-source-seq]')].map(row => Number(row.dataset.sourceSeq))`));
    assert.deepEqual(alphaSequence, [...alphaSequence].sort((a, b) => a - b),
      'alpha exchanges preserve source order');
    assert.ok([8, 9, 15, 16, 21, 22].every(seq => alphaSequence.includes(seq)),
      'queued and delivered records stay distinct, including the return');
    assert.match(await command('get', 'text', '.collaboration-thread'),
      /Inspect synthetic alpha[\s\S]*Read synthetic alpha input and report back/);
    assert.ok(Number(await command('get', 'count', '.collaboration-thread .relation-unavailable-history')) > 0,
      'team-only records explain that no Reader message link was recorded');
    assert.match(await command('get', 'text', '.collaboration-thread .relation-unavailable-history'),
      /This recorded team event has no conversation-message link\./);
    await command('eval', `document.querySelector('[data-member-id="${ids.beta}"]').scrollIntoView({block:'center',behavior:'instant'})`);
    await command('click', `[data-member-id="${ids.beta}"]`);
    assert.match(await command('get', 'text', '.collaboration-thread'), /Inspect synthetic beta\./);
    assert.doesNotMatch(await command('get', 'text', '.collaboration-thread'),
      /Also check the alpha ending marker\./);
    await waitForBrowser(command,
      `document.querySelector('[data-collaboration-handoff="parallel-inspection:1"] .collaboration-child-node') && document.querySelector('[data-collaboration-handoff="parallel-inspection:2"] .collaboration-child-node')`,
      'both recorded child nodes in the relationship graph');
    for (const [name, href] of [['alpha', alphaHref], ['beta', betaHref]]) {
      await command('eval', `(() => {
        const node = [...document.querySelectorAll('.collaboration-child-node')].find(button =>
          button.querySelector('strong')?.textContent.trim() === ${JSON.stringify(name)});
        if (!node) throw new Error('Recorded child node was missing');
        node.click();
      })()`);
      await waitForBrowser(command, `Boolean(document.querySelector('.collaboration-timeline a[href="${href}"]'))`,
        `selected ${name} child source action`);
      assert.equal(Number(await command('get', 'count', `.collaboration-timeline a[href="${href}"]`)), 1,
        `The selected ${name} handoff exposes its canonical child-conversation link`);
      assert.equal(Number(await command('get', 'count', '.collaboration-timeline .collaboration-selected-details')), 1,
        'One selected agent owns the progressive handoff details');
    }
    const rootPath = `/api/v3/reader/${provider}/${ids.root}`;
    const rootCalls = JSON.parse(await command('eval', 'window.__agentsessionApiCalls'));
    const rootBootstrap = rootCalls.find(call => call.path === `${rootPath}/bootstrap` && call.status === 200);
    assert.ok(rootBootstrap, 'The browser loads the root through the DSH bootstrap route');
    assert.deepEqual(rootBootstrap.session, { provider, sessionId: ids.root });
    assert.ok(rootBootstrap.revision, 'The root Reader exposes its source revision in the bootstrap response');
    assert.equal(await command('get', 'text', '.reader-session-details .session-details-content dl dd:nth-of-type(3) code'),
      rootBootstrap.revision, 'The Session details retain the exact DSH root source revision');
    const rootRelations = rootCalls.find(call => call.path === `${rootPath}/relations` && call.status === 200);
    assert.ok(rootRelations, 'The Reader fetches the actual root /relations endpoint');
    assert.deepEqual(rootRelations.session, { provider, sessionId: ids.root },
      'The /relations response retains the canonical DSH root identity');
    assert.deepEqual(rootRelations.relationCounts, { tasks: 4, coordination: 12, total: 16 },
      'The browser receives the four tasks and twelve coordination observations from /relations');

    const workResponse = await fetch(`${harness.origin}/api/v3/runtime/${provider}/${ids.root}/work?limit=1`);
    assert.equal(workResponse.status, 200);
    const workPage = await workResponse.json();
    assert.deepEqual(workPage.entries.map(entry => [entry.id, entry.status, entry.evidence.eventId]),
      [['team:beta', 'completed', 'event:dsh:18']]);
    assert.ok(workPage.nextCursor, 'The bounded Work page continues to the second recorded task');
    await command('click', 'button.runtime-tab');
    await command('click', '.runtime-lenses button:nth-child(2)');
    await waitForBrowser(command, `document.querySelectorAll('.runtime-work-entry').length === 2`,
      'both source-backed DSH team tasks in Work');
    assert.match(await command('get', 'text', '.runtime-work .runtime-coverage'), /Work coverage: observed/);
    assert.match(await command('get', 'text', '.runtime-work-entries'),
      /Provenance: recorded · dsh\.session-event:team\/task #18[\s\S]*Provenance: recorded · dsh\.session-event:team\/task #20/);
    assert.equal(Number(await command('get', 'count', '.runtime-work-entry')), 2);
    await command('click', 'button.conversation-tab');

    const alphaToggle = `.inline-child-toggle[aria-expanded="false"]`;
    await waitForBrowser(command,
      `[...document.querySelectorAll('${alphaToggle}')].some(button => button.textContent.includes('${ids.alpha}'))`,
      'the source-anchored alpha child expansion');
    const anchor = JSON.parse(await command('eval', `(() => { const button = [...document.querySelectorAll('.inline-child-toggle')].find(node => node.textContent.includes('${ids.alpha}')); const owner = button?.closest('.turn-block')?.querySelector('article.event-card'); return { owner: owner ? owner.dataset.messageId + ' / ' + owner.dataset.segment : null, count: document.querySelectorAll('.inline-child-toggle').length }; })()`));
    assert.equal(anchor.owner, 'root-dispatch / message', 'The child appears at the recorded dispatch turn');
    assert.equal(anchor.count, 2, 'Each canonical child has one insertion control');
    const rootTitle = await command('get', 'text', '.reader-heading h1');
    const alphaToggleSelector = `.inline-child-toggle[id$="${Buffer.from(`${provider}\0${ids.alpha}`).toString('hex')}"]`;
    await command('click', alphaToggleSelector);
    await waitForBrowser(command,
      `document.querySelectorAll('.inline-child-reader').length === 1 && document.querySelector('.inline-child-reader')?.textContent.includes('ALPHA-END')`,
      'the complete alpha child at its inline source position');
    assert.equal(await command('get', 'text', '.reader-heading h1'), rootTitle, 'The parent title owns the root Reader');
    assert.equal(await command('get', 'text', '.reader-session-details .session-details-content dl dd:nth-of-type(2) code'), ids.root, 'The root session remains the owner');
    assert.equal(Number(await command('get', 'count', '.reader-action-links a[download]')), 0,
      'The Reader has no session download action after inline child expansion');
    assert.equal(Number(await command('get', 'count', '.reader-star')), 1,
      'Inline expansion does not mount a second metadata owner');
    assert.equal(Number(await command('get', 'count', `.inline-child-heading-actions a[href="${alphaHref}"]`)), 1,
      'The named child source action points to the canonical child URL');
    assert.equal(JSON.parse(await command('eval', `window.location.pathname`)), rootHref,
      'Inline expansion keeps the root URL');
    await command('back');
    await waitForBrowser(command, `document.querySelectorAll('.inline-child-reader').length === 0`,
      'Back restoring the parent Reader after inline expansion');
    assert.equal(JSON.parse(await command('eval', `document.activeElement?.id`)), `child-toggle-${Buffer.from(`${provider}\0${ids.alpha}`).toString('hex')}`,
      'Back restores focus to the parent insertion control');
    await command('forward');
    await waitForBrowser(command, `document.querySelectorAll('.inline-child-reader').length === 1`,
      'Forward restoring the inline child');
    const parentTopBeforeCollapse = Number(await command('eval',
      `document.querySelector('${alphaToggleSelector}')?.getBoundingClientRect().top`));
    await command('click', alphaToggleSelector);
    await waitForBrowser(command, `document.querySelectorAll('.inline-child-reader').length === 0`, 'child collapse');
    const parentTopAfterCollapse = Number(await command('eval',
      `document.querySelector('${alphaToggleSelector}')?.getBoundingClientRect().top`));
    assert.ok(Math.abs(parentTopAfterCollapse - parentTopBeforeCollapse) < 2,
      'Collapse preserves the parent insertion position in the viewport');
    assert.equal(JSON.parse(await command('eval', `document.activeElement?.id`)), `child-toggle-${Buffer.from(`${provider}\0${ids.alpha}`).toString('hex')}`,
      'Collapse restores focus to the parent insertion control');
    await command('click', alphaToggleSelector);
    await waitForBrowser(command, `document.querySelectorAll('.inline-child-reader').length === 1`, 'repeat expansion');
    assert.equal(Number(await command('get', 'count', '.inline-child-reader')), 1,
      'Repeat expansion mounts the same child once');
    await command('click', '.inline-child-collapse');
    await waitForBrowser(command, `document.querySelectorAll('.inline-child-reader').length === 0`, 'child pane collapse');

    if (process.env.AGENTSESSION_V3_DSH_UI_SCREENSHOT) {
      const screenshotPath = path.resolve(process.env.AGENTSESSION_V3_DSH_UI_SCREENSHOT);
      await mkdir(path.dirname(screenshotPath), { recursive: true });
      await command('set', 'viewport', '1440', '1000');
      await command('screenshot', screenshotPath);
    }

    await command('eval', `([...document.querySelectorAll('.collaboration-child-node')].find(button =>
      button.querySelector('strong')?.textContent.trim() === 'alpha')).click()`);
    await waitForBrowser(command, `Boolean(document.querySelector('.collaboration-timeline a[href="${alphaHref}"]'))`,
      'alpha child action after selecting its graph node');
    await command('click', `.collaboration-timeline a[href="${alphaHref}"]`);
    await waitForBrowser(command,
      `document.querySelector('.inline-child-reader')?.textContent.includes('ALPHA-END')`,
      'the timeline link opening the complete alpha child inline');
    assert.equal(JSON.parse(await command('eval', 'window.location.pathname')), rootHref,
      'The timeline action keeps the parent Reader route');
    const inlineCalls = JSON.parse(await command('eval', 'window.__agentsessionApiCalls'));
    const inlineBootstrap = inlineCalls.find(call => call.path === `/api/v3/reader/${provider}/${ids.alpha}/bootstrap` && call.status === 200);
    assert.ok(inlineBootstrap, 'The inline alpha child loads through its own bootstrap route');
    assert.deepEqual(inlineBootstrap.session, { provider, sessionId: ids.alpha });
    assert.ok(inlineBootstrap.revision, 'The inline alpha child retains its exact source revision');
    await command('focus', `.inline-child-heading-actions a[href="${alphaHref}"]`);
    await command('press', 'Enter');
    await waitForBrowser(command,
      `window.location.pathname === '${alphaHref}' && document.querySelector('.reader-session-details .session-details-content dl dd:nth-of-type(2) code')?.textContent.trim() === '${ids.alpha}'`,
      'the DSH alpha child Reader');
    const alphaResponse = await fetch(`${harness.origin}/api/v3/reader/${provider}/${ids.alpha}/bootstrap`);
    assert.equal(alphaResponse.status, 200);
    const alphaBootstrap = await alphaResponse.json();
    assert.deepEqual(alphaBootstrap.session.session, { provider, sessionId: ids.alpha });
    assert.ok(alphaBootstrap.revision, 'The alpha Reader source bootstrap has a revision');
    assert.equal(await command('get', 'text', '.reader-session-details .session-details-content dl dd:nth-of-type(3) code'),
      alphaBootstrap.revision, 'The Session details retain the exact DSH child source revision');

    await command('back');
    await waitForBrowser(command,
      `window.location.pathname === '${rootHref}' && document.querySelector('.reader-session-details .session-details-content dl dd:nth-of-type(2) code')?.textContent.trim() === '${ids.root}'`,
      'Back restoring the DSH root Reader');
    const finalEventRaw = await command('eval', `(() => { const card = [...document.querySelectorAll('article.event-card')].find(article => article.dataset.messageId + ' / ' + article.dataset.segment === 'root-final / message'); return { source: card ? card.dataset.messageId + ' / ' + card.dataset.segment : null, body: card?.querySelector('.event-body')?.textContent || null }; })()`);
    const finalEvent = JSON.parse(finalEventRaw);
    assert.equal(finalEvent.source, 'root-final / message', 'The root final event is rendered with its source identity');
    assert.match(finalEvent.body || '', /END-OF-SYNTHETIC-DSH-ROOT$/,
      'The Reader shows the source-backed ending of the final root response');

    const inlineChildAfterBack = Number(await command('get', 'count', '.inline-child-reader'));
    assert.ok(inlineChildAfterBack === 0 || inlineChildAfterBack === 1,
      `Back restores at most one inline child, found ${inlineChildAfterBack}`);
    if (inlineChildAfterBack === 0) {
      await waitForBrowser(command, `document.querySelector('${alphaToggleSelector}')`,
        'the restored root alpha insertion control');
      await command('click', alphaToggleSelector);
    }
    await waitForBrowser(command, `document.querySelectorAll('.inline-child-reader').length === 1`, 'inline child before refresh');
    await command('eval', 'window.location.reload()');
    await waitForBrowser(command,
      `window.location.pathname === '${rootHref}' && document.querySelectorAll('.inline-child-reader').length === 1`,
      'refresh restoring the root source and one inline child');

    const pageErrors = await command('errors');
    assert.equal(pageErrors.trim(), '', `The browser reported page errors: ${pageErrors}`);
    const consoleOutput = await command('console');
    assert.doesNotMatch(consoleOutput, /\b(error|uncaught|failed to load)\b/i,
      `The browser console reported an error: ${consoleOutput}`);
  });

test('inline alpha child paginates its own complete history without changing the root owner',
  { skip: skipReason || false, timeout: 90_000 }, async t => {
    const corpus = await longAlphaCorpus(t);
    t.diagnostic(`Synthetic long-alpha source SHA-256: ${corpus.hash}`);
    const harness = await startServer(t, corpus.source);
    const rootHref = `/${provider}/session/${ids.root}`;
    const { command } = await startBrowser(harness, `${harness.origin}${rootHref}`);
    await waitForBrowser(command, `[...document.querySelectorAll('.inline-child-toggle')].some(button => button.textContent.includes('${ids.alpha}'))`,
      'the long alpha child insertion');
    const toggle = `.inline-child-toggle[id$="${Buffer.from(`${provider}\0${ids.alpha}`).toString('hex')}"]`;
    await command('click', toggle);
    await waitForBrowser(command,
      `document.querySelector('.inline-child-reader')?.textContent.includes('32 of 41 events loaded') && document.querySelector('.inline-child-next')`,
      'the bounded first page of alpha history');
    assert.equal(Number(await command('get', 'count', '.inline-child-transcript .event-card')), 32);
    await command('fill', `input[aria-label="Find in child ${ids.alpha}"]`, 'ALPHA-END');
    await command('focus', '.inline-child-reader .pane-search form button[type="submit"]');
    await command('press', 'Enter');
    await waitForBrowser(command,
      `document.querySelector('.inline-child-reader .pane-search-state')?.textContent.includes('1 match in this child history') && document.querySelector('.inline-child-reader .pane-search-result')?.textContent.includes('ALPHA-END')`,
      'the child pane searches its full history before pagination');
    assert.equal(Number(await command('get', 'count', '.inline-child-reader .pane-search-result')), 1);
    await command('focus', '.inline-child-next');
    await command('press', 'Enter');
    await waitForBrowser(command,
      `document.querySelector('.inline-child-reader')?.textContent.includes('41 of 41 events loaded') && document.querySelector('.inline-child-reader')?.textContent.includes('ALPHA-END')`,
      'the complete alpha continuation through its final marker');
    assert.equal(Number(await command('get', 'count', '.inline-child-transcript .event-card')), 41);
    assert.equal(JSON.parse(await command('eval', 'window.location.pathname')), rootHref);
    assert.equal(await command('get', 'text', '.reader-session-details .session-details-content dl dd:nth-of-type(2) code'), ids.root);
    assert.equal(sha256(corpus.file), corpus.hash, 'The Web reader keeps the copied provider source read-only');
  });

test('team-message expansion follows the child source revision and ignores an older in-flight page',
  { skip: skipReason || false, timeout: 90_000 }, async t => {
    const teamBody = marker => 'Shared team-message context. '.repeat(12) + marker;
    const corpus = await longAlphaCorpus(t, teamBody('OLD-TEAM-BODY'));
    const harness = await startServer(t, corpus.source);
    const { command } = await startBrowser(harness, `${harness.origin}/${provider}/session/${ids.root}`);
    const toggle = `.inline-child-toggle[id$="${Buffer.from(`${provider}\0${ids.alpha}`).toString('hex')}"]`;
    const card = '[data-event-id="event:dsh:47"]';
    await waitForBrowser(command, `Boolean(document.querySelector('${toggle}'))`, 'alpha child insertion');
    if (await command('eval', `Boolean(document.querySelector('.collaboration-launcher:not([hidden])'))`) === 'true') {
      await command('click', '.collaboration-launcher');
    }
    await command('click', toggle);
    await waitForBrowser(command, `Boolean(document.querySelector('${card} .collaboration-message-more'))`,
      'alpha queued team-message card');
    await command('click', `${card} .collaboration-message-more`);
    await waitForBrowser(command, `document.querySelector('${card} .collaboration-message-body')?.textContent.includes('OLD-TEAM-BODY')`,
      'first source revision body');

    await command('click', '.inline-child-collapse');
    await waitForBrowser(command, `document.querySelectorAll('.inline-child-reader').length === 0`, 'child collapse');
    await corpus.rewriteTeamMessage(teamBody('NEW-TEAM-BODY'));
    assert.notEqual(sha256(corpus.file), corpus.hash, 'the test changed only its copied child source');
    await command('click', toggle);
    await waitForBrowser(command, `Boolean(document.querySelector('${card} .collaboration-message-more'))`,
      'fresh read action for the new source revision');
    assert.equal(Number(await command('get', 'count', `${card} .collaboration-message-body`)), 0,
      'the prior completed body is absent under the new revision');
    await command('eval', `window.__holdTeamPage = true; window.__releaseTeamPage = null;
      const originalTeamFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const input = args[0]; const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        const response = await originalTeamFetch(...args);
        if (window.__holdTeamPage && url.pathname.endsWith('/team-message/content'))
          return new Promise(resolve => { window.__releaseTeamPage = () => {
            resolve(response); setTimeout(() => { window.__releasedTeamPageSettled = true; }, 0);
          }; });
        return response;
      };`);
    await command('click', `${card} .collaboration-message-more`);
    await waitForBrowser(command, `typeof window.__releaseTeamPage === 'function'`, 'held old-revision content response');
    await command('click', '.inline-child-collapse');
    await waitForBrowser(command, `document.querySelectorAll('.inline-child-reader').length === 0`, 'child collapse during content load');
    await corpus.rewriteTeamMessage(teamBody('LATEST-TEAM-BODY'));
    await command('click', toggle);
    await waitForBrowser(command, `Boolean(document.querySelector('${card} .collaboration-message-more'))`,
      'fresh read action after another source revision');
    await command('eval', 'window.__holdTeamPage = false; window.__releaseTeamPage()');
    await waitForBrowser(command, 'window.__releasedTeamPageSettled === true', 'old-revision response to settle');
    assert.equal(Number(await command('get', 'count', `${card} .collaboration-message-body`)), 0,
      'the older in-flight page cannot paint into the current panel');
    await command('click', `${card} .collaboration-message-more`);
    await waitForBrowser(command, `document.querySelector('${card} .collaboration-message-body')?.textContent.includes('LATEST-TEAM-BODY')`,
      'latest source revision body');
    assert.doesNotMatch(await command('get', 'text', `${card} .collaboration-message-body`), /OLD-TEAM-BODY|NEW-TEAM-BODY/);
  });

test('real Axum search locates a DSH event and Viewer deletion updates the result',
  { skip: skipReason || false, timeout: 90_000 }, async t => {
    const harness = await startServer(t);
    const { command } = await startBrowser(harness, `${harness.origin}/sessions`);
    const rootHref = `/${provider}/session/${ids.root}`;
    await command('wait', '[data-search-mode="content"]');
    await command('click', '[data-search-mode="content"]');
    await command('fill', 'input[type="search"]', 'END-OF-SYNTHETIC-DSH-ROOT');
    await command('click', '.search-submit');
    await waitForBrowser(command,
      `document.querySelector('.search-result a')?.getAttribute('href')?.startsWith('${rootHref}#event?')`,
      'a source-backed search result with an exact Reader event link');
    const resultHref = await command('eval', `document.querySelector('.search-result a')?.getAttribute('href')`);
    assert.match(resultHref, /messageId=root-final/);
    await command('eval', `document.querySelector('.search-result a').scrollIntoView({ block: 'center', behavior: 'instant' })`);
    await command('click', '.search-result a');
    await waitForBrowser(command,
      `window.location.pathname === '${rootHref}' && [...document.querySelectorAll('article.event-card')].some(article => article.dataset.messageId + ' / ' + article.dataset.segment === 'root-final / message')`,
      'the recorded DSH final event');
    const finalBody = await command('eval', `(() => [...document.querySelectorAll('article.event-card')]
      .find(article => article.dataset.messageId + ' / ' + article.dataset.segment === 'root-final / message')
      ?.querySelector('.event-body')?.textContent || '')()`);
    assert.match(finalBody, /END-OF-SYNTHETIC-DSH-ROOT/);
    assert.equal(Number(await command('get', 'count', '.reader-action-links a[download]')), 0,
      'The Reader has no session download action at the final event');

    await command('click', '.reader-delete');
    await waitForBrowser(command,
      `window.location.pathname === '/sessions' && document.querySelector('[data-search-mode="content"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('input[type="search"]')?.value === 'END-OF-SYNTHETIC-DSH-ROOT' && document.querySelector('.search-results') === null && Boolean(document.querySelector('.empty-state h2'))`,
      'the deleted session disappearing from the retained content query');
    assert.ok(await command('eval', `Boolean(document.querySelector('.source-diagnostic[role="alert"]'))`),
      'the Library keeps its source-availability diagnostic');
    const hidden = await (await fetch(`${harness.origin}/api/v3/search?q=END-OF-SYNTHETIC-DSH-ROOT`)).json();
    assert.deepEqual(hidden.matches, []);
    assert.equal(hidden.diagnostics.find(row => row.provider === provider)?.status, 'ok');
    assert.ok(hidden.diagnostics.some(row => row.status === 'unavailable'),
      'the search response reports unavailable fixture providers');
    const source = await fetch(`${harness.origin}/api/v3/reader/${provider}/${ids.root}/bootstrap`);
    assert.equal(source.status, 200, 'Viewer deletion leaves provider source readable');

    await command('click', '[data-library-view="trash"]');
    await command('wait', '.trash-restore');
    await command('click', '.trash-restore');
    await waitForBrowser(command, `document.querySelector('.trash-row') === null`, 'the restored trash row to leave Trash');
    await command('click', '[data-library-view="sessions"]');
    await command('click', '.search-submit');
    await waitForBrowser(command,
      `document.querySelector('.search-result a')?.getAttribute('href')?.startsWith('${rootHref}#event?')`,
      'the restored session to reappear in content search');
    assert.equal((await command('errors')).trim(), '');
  });

test('public DSH Runtime Work shows recorded task coverage without fetching the full protocol',
  { skip: skipReason || false, timeout: 90_000 }, async t => {
    const harness = await startServer(t);
    const protocolResponse = await fetch(`${harness.origin}/api/v3/protocol/${provider}/${ids.root}?version=3`);
    assert.equal(protocolResponse.status, 200);
    const protocol = await protocolResponse.json();
    assert.equal(protocol.coverage.work.state, 'observed');
    assert.match(protocol.coverage.work.details, /recorded team tasks/i);
    const eventsResponse = await fetch(`${harness.origin}/api/v3/runtime/${provider}/${ids.root}/events?limit=100`);
    assert.equal(eventsResponse.status, 200);
    const events = await eventsResponse.json();
    assert.ok(events.events.some(event => event.kind === 'team.task'));
    assert.ok(events.events.some(event => event.kind === 'tool-workflow.agent-start'));
    const workResponse = await fetch(`${harness.origin}/api/v3/runtime/${provider}/${ids.root}/work`);
    assert.equal(workResponse.status, 200);
    const work = await workResponse.json();
    assert.deepEqual(work.entries.map(entry => [entry.id, entry.status, entry.evidence.eventId]), [
      ['team:beta', 'completed', 'event:dsh:18'],
      ['team:alpha', 'completed', 'event:dsh:20'],
    ]);
    assert.equal(work.coverage, 'partial');
    assert.deepEqual(work.domainCoverage, protocol.coverage.work,
      'The bounded Work page must carry its own source-aligned domain coverage');

    const { command } = await startBrowser(harness, `${harness.origin}/${provider}/session/${ids.root}`);
    await waitForBrowser(command, "document.querySelector('.reader-heading h1')", 'the DSH Reader');
    await command('click', 'button.runtime-tab');
    await command('click', '.runtime-lenses button:nth-child(2)');
    await waitForBrowser(command, "document.querySelector('.runtime-work .runtime-pagination')",
      'the DSH Work response');
    const workText = await command('get', 'text', '.runtime-work');
    assert.match(workText, /Work coverage: observed/i);
    assert.match(workText, /Latest recorded team tasks/i);
    assert.equal(Number(await command('get', 'count', '.runtime-work-entry')), 2);
    assert.doesNotMatch(workText, /No more recorded work matches these filters/i);
    const fullProtocolRequests = JSON.parse(await command('eval',
      `performance.getEntriesByType('resource').filter(entry => entry.name.includes('/api/v3/protocol/')).map(entry => entry.name)`));
    assert.deepEqual(fullProtocolRequests, [],
      'The bounded Work page must not download the full protocol event document for coverage');
    assert.equal((await command('errors')).trim(), '');
  });

test('public DSH Runtime Coordination names the recorded sender and recipient sessions',
  { skip: skipReason || false, timeout: 90_000 }, async t => {
    const harness = await startServer(t);
    const { command } = await startBrowser(harness, `${harness.origin}/${provider}/session/${ids.root}`);
    await waitForBrowser(command, "document.querySelector('.reader-heading h1')", 'the DSH Reader');
    await command('click', 'button.runtime-tab');
    await command('click', '.runtime-lens-coordination');
    await waitForBrowser(command,
      "document.querySelectorAll('.runtime-domain-coordination .runtime-domain-entry').length === 12",
      'the twelve recorded coordination facts');
    const text = await command('get', 'text', '.runtime-domain-coordination .runtime-domain-entries');
    assert.match(text, new RegExp(`${provider}/${ids.root} → ${provider}/${ids.alpha}`));
    assert.match(text, new RegExp(`${provider}/${ids.alpha} → ${provider}/${ids.root}`));
    assert.match(text, new RegExp(`${provider}/${ids.root} → ${provider}/${ids.beta}`));
    assert.doesNotMatch(text, /Unknown sender|Unknown recipient/);
    assert.equal((await command('errors')).trim(), '');
  });
