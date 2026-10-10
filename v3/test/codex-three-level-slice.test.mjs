import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const fixtureRoot = path.join(repo, 'v3', 'fixtures', 'codex-three-level');
const sourceFiles = [
  'rollout-2026-09-27T00-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl',
  'rollout-2026-09-27T00-01-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl',
  'rollout-2026-09-27T00-02-00-cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl',
].map(name => path.join(fixtureRoot, 'sessions', '2026', '09', '27', name));
const ids = {
  root: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  child: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  grandchild: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const actorPaths = {
  child: '/root/public-child-agent',
  grandchild: '/root/public-child-agent/public-grandchild-agent',
};
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const longBody = 'grandchild-long-content '.repeat(120) + 'GRANDCHILD-END-OF-CONTENT';
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const ref = sessionId => ({ provider: 'codex', sessionId });
const event = (sessionId, messageId, segment = 'tool') => ({ ...ref(sessionId), messageId, segment });

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
const skipBrowser = agentBrowserExe ? false
  : 'The agent-browser CLI is required; the test does not install it or download a browser.';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function freePort() {
  return freeFetchSafePort();
}

async function safeRemoveScratch(scratch) {
  const tmpRoot = await realpath(path.join(repo, 'tmp'));
  const resolved = await realpath(scratch);
  assert.equal(path.dirname(resolved), tmpRoot, 'Scratch cleanup must stay directly under the repository tmp directory');
  assert.match(path.basename(resolved), /^v3-codex-three-level-/,
    'Scratch cleanup must target only this test-created corpus');
  await rm(resolved, { recursive: true, force: true });
}

async function isolatedCorpus(t, lateAnchors = false, lateRelations = false) {
  await mkdir(path.join(repo, 'tmp'), { recursive: true });
  const scratch = await mkdtemp(path.join(repo, 'tmp', 'v3-codex-three-level-'));
  const codexDir = path.join(scratch, 'codex');
  const sourceHashes = sourceFiles.map(sha256);
  await cp(path.join(fixtureRoot, 'sessions'), path.join(codexDir, 'sessions'), { recursive: true });
  const copiedFiles = sourceFiles.map(file => path.join(codexDir, path.relative(fixtureRoot, file)));
  if (lateRelations) {
    for (const [index, callId] of [[0, 'SPAWN_ITEM'], [1, 'GRANDCHILD_SPAWN_ITEM']]) {
      const rows = (await readFile(copiedFiles[index], 'utf8')).trimEnd().split('\n');
      const anchor = rows.findIndex(line => line.includes(`"call_id":"${callId}"`) && line.includes('"function_call"'));
      const padding = Array.from({ length: 80 }, (_, ordinal) => JSON.stringify({
        timestamp: '2026-09-27T00:00:02.000Z', type: 'response_item',
        payload: { type: 'function_call', call_id: `unrelated-${ordinal}`, name: 'spawn_agent',
          namespace: 'collaboration', arguments: JSON.stringify({ task_name: `unresolved-${ordinal}`, message: 'Unrelated work.' }) },
      }));
      rows.splice(anchor, 0, ...padding);
      await writeFile(copiedFiles[index], rows.join('\n') + '\n');
    }
  }
  if (lateAnchors) {
    for (const [index, callId] of [[0, 'SPAWN_ITEM'], [1, 'GRANDCHILD_SPAWN_ITEM']]) {
      const rows = (await readFile(copiedFiles[index], 'utf8')).trimEnd().split('\n');
      const anchor = rows.findIndex(line => line.includes(`"call_id":"${callId}"`) && line.includes('"function_call"'));
      assert.ok(anchor > 0, `The public ${callId} call must be present`);
      const padding = Array.from({ length: 40 }, (_, ordinal) => JSON.stringify({
        timestamp: '2026-09-27T00:00:02.000Z', type: 'event_msg',
        payload: { type: 'agent_message', id: `before-${callId}-${ordinal}`,
          message: `Public history before ${callId}: ${ordinal}` },
      }));
      rows.splice(anchor, 0, ...padding);
      await writeFile(copiedFiles[index], rows.join('\n') + '\n');
    }
  }
  const copiedHashes = copiedFiles.map(sha256);
  t.after(async () => {
    try {
      assert.deepEqual(sourceFiles.map(sha256), sourceHashes,
        'The real Web process must leave the public fixture bytes unchanged');
      assert.deepEqual(copiedFiles.map(sha256), copiedHashes,
        'The real Web process must leave its isolated provider-source copies unchanged');
    } finally {
      await safeRemoveScratch(scratch);
    }
  });
  return { scratch, codexDir, copiedFiles, copiedHashes };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill();
  await closed;
}

async function startServer(t, scratch, codexDir) {
  assert.ok(existsSync(binary), `Build the AgentSession 3.0 binary at ${binary}`);
  for (const name of ['meta', 'index', 'cache', 'claude', 'pi', 'dsh']) {
    await mkdir(path.join(scratch, name), { recursive: true });
  }
  const port = await freePort();
  const child = spawn(binary, ['serve', '--port', String(port),
    '--codex-dir', codexDir,
    '--opencode-db', path.join(scratch, 'opencode.db'),
    '--claude-dir', path.join(scratch, 'claude'),
    '--pi-dir', path.join(scratch, 'pi'),
    '--dsh-dir', path.join(scratch, 'dsh'),
    '--meta-dir', path.join(scratch, 'meta'),
    '--index-dir', path.join(scratch, 'index'),
    '--cache-dir', path.join(scratch, 'cache')], {
    cwd: repo,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let processOutput = '';
  child.stdout.on('data', chunk => { processOutput += chunk.toString(); });
  child.stderr.on('data', chunk => { processOutput += chunk.toString(); });
  let browserCleanup;
  t.after(async () => {
    try {
      try { await browserCleanup?.(); } finally { await stopProcess(child); }
    } finally {
      assert.ok(child.exitCode !== null || child.signalCode !== null,
        'The isolated Axum process must stop before scratch cleanup');
    }
  });

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${origin}/api/providers`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch { /* Axum may still be starting. */ }
    await sleep(100);
  }
  assert.ok(ready, `The isolated Axum server did not become ready: ${processOutput}`);
  return {
    origin,
    setBrowserCleanup(cleanup) { browserCleanup = cleanup; },
  };
}

async function getJson(url, message) {
  const response = await fetch(url);
  const body = await response.json();
  assert.equal(response.status, 200, `${message}: ${JSON.stringify(body)}`);
  return body;
}

async function readerItems(base, bootstrap) {
  const items = [...bootstrap.segments.flatMap(page => page.items)];
  let cursor = bootstrap.segments.at(-1)?.nextCursor;
  const seen = new Set();
  while (cursor) {
    assert.ok(!seen.has(cursor), 'Reader segment cursor must advance');
    seen.add(cursor);
    const page = await getJson(`${base}/segments?cursor=${encodeURIComponent(cursor)}`, 'Reader continuation');
    assert.equal(page.revision, bootstrap.revision);
    items.push(...page.page.items);
    cursor = page.page.nextCursor;
    assert.ok(items.length < 100, 'The public fixture Reader continuation must terminate');
  }
  return items;
}

async function relationPages(base, bootstrap) {
  const entries = [];
  const placements = [];
  let cursor = bootstrap.relations?.firstCursor ?? null;
  const seen = new Set();
  while (cursor) {
    assert.ok(!seen.has(cursor), 'Relation cursor must advance');
    seen.add(cursor);
    const page = await getJson(`${base}/relations?cursor=${encodeURIComponent(cursor)}`, 'Reader relation page');
    assert.deepEqual(page.session, ref(bootstrap.session.session.sessionId));
    assert.equal(page.revision, bootstrap.revision);
    entries.push(...page.entries);
    placements.push(...(page.childPlacements ?? []));
    cursor = page.nextCursor;
  }
  return { entries, placements };
}

async function allContent(base, bootstrap, items) {
  const content = new Map();
  const pageCounts = new Map();
  for (const item of items) {
    if (item.event.segment !== 'message' || item.role === 'tool') continue;
    const parts = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const query = new URLSearchParams({
        revision: bootstrap.revision,
        messageId: item.event.messageId,
        segment: item.event.segment,
        field: 'body',
        offset: String(offset),
        maxChars: '1000',
      });
      const page = await getJson(`${base}/content?${query}`, `Content ${item.event.messageId}`);
      assert.equal(page.offset, offset);
      parts.push(page.text);
      pages++;
      if (page.nextOffset === null) break;
      assert.ok(page.nextOffset > offset, 'Content continuation must advance');
      offset = page.nextOffset;
      assert.ok(pages < 10, `Content continuation must terminate for ${item.event.messageId}`);
    }
    content.set(item.event.messageId, parts.join(''));
    pageCounts.set(item.event.messageId, pages);
  }
  return { content, pageCounts };
}

function startBrowser(harness, url) {
  const session = `agentsession-v3-three-level-${process.pid}-${Date.now()}`;
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
    try { await command('close'); } catch { /* Browser cleanup is best effort after a test failure. */ }
  });
  return (async () => {
    await command('open');
    await command('eval', `window.location.href = ${JSON.stringify(url)}`);
    return command;
  })();
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

test('public three-level Codex history exposes exact canonical child placements and complete HTTP slices',
  { timeout: 90_000 }, async t => {
    const corpus = await isolatedCorpus(t);
    const harness = await startServer(t, corpus.scratch, corpus.codexDir);
    const readers = new Map();
    const relationResults = new Map();
    for (const sessionId of Object.values(ids)) {
      const base = `${harness.origin}/api/v3/reader/codex/${sessionId}`;
      const bootstrap = await getJson(`${base}/bootstrap`, `Reader bootstrap ${sessionId}`);
      assert.deepEqual(bootstrap.session.session, ref(sessionId));
      const items = await readerItems(base, bootstrap);
      const relationResult = await relationPages(base, bootstrap);
      const bodyResult = await allContent(base, bootstrap, items);
      readers.set(sessionId, { bootstrap, items, ...bodyResult });
      relationResults.set(sessionId, relationResult);
    }

    const grandchildReader = readers.get(ids.grandchild);
    for (const [sessionId, messageIds] of [
      [ids.root, ['root-request', 'root-before-spawn', 'root-after-spawn']],
      [ids.child, ['child-request', 'child-before-spawn', 'child-after-spawn']],
      [ids.grandchild, ['grandchild-request', 'grandchild-first', 'grandchild-step-30', 'grandchild-long']],
    ]) {
      const reader = readers.get(sessionId);
      const recordedIds = new Set(reader.items.map(item => item.event.messageId));
      for (const messageId of messageIds) {
        assert.ok(recordedIds.has(messageId), `${sessionId} Reader includes owned event ${messageId}`);
        assert.ok(reader.content.has(messageId), `${sessionId} content endpoint serves ${messageId}`);
      }
    }
    assert.equal(grandchildReader.items.length, 33,
      'The grandchild Reader crosses its 32-event first-page boundary');
    assert.equal(grandchildReader.content.get('grandchild-long'), longBody,
      'The grandchild long body is returned completely through content continuation');
    assert.ok(grandchildReader.pageCounts.get('grandchild-long') >= 2,
      'The long grandchild body requires more than one bounded content response');

    const startedObservation = (sessionId, correlationId) =>
      relationResults.get(sessionId).entries.find(entry => entry.type === 'coordination' &&
        entry.observation.kind === 'spawn' && entry.observation.state === 'started' &&
        entry.observation.correlationId === correlationId)?.observation ?? null;
    const actualEvidence = {
      started: [
        startedObservation(ids.root, 'SPAWN_ITEM'),
        startedObservation(ids.child, 'GRANDCHILD_SPAWN_ITEM'),
      ].map(observation => observation && ({
        eventId: observation.eventId,
        toActorPath: observation.toActorPath,
        toSessionRef: observation.toSessionRef,
        readerEvent: observation.readerEvent,
      })),
      placements: [
        ...relationResults.get(ids.root).placements,
        ...relationResults.get(ids.child).placements,
      ],
    };
    assert.deepEqual(actualEvidence, {
      started: [
        { eventId: 'event:codex:5', toActorPath: actorPaths.child, toSessionRef: ref(ids.child),
          readerEvent: event(ids.root, 'SPAWN_ITEM') },
        { eventId: 'event:codex:5', toActorPath: actorPaths.grandchild, toSessionRef: ref(ids.grandchild),
          readerEvent: event(ids.child, 'GRANDCHILD_SPAWN_ITEM') },
      ],
      placements: [
        { child: ref(ids.child), afterEvent: event(ids.root, 'SPAWN_ITEM'), sourceEventId: 'event:codex:5', diagnostic: null },
        { child: ref(ids.grandchild), afterEvent: event(ids.child, 'GRANDCHILD_SPAWN_ITEM'), sourceEventId: 'event:codex:5', diagnostic: null },
      ],
    }, 'Each function_call_output task_name must resolve to one canonical child, source placement, and spawn tool anchor');
  });

test('canonical child locator returns a late verified placement without relation traversal and rejects stale revisions',
  { timeout: 90_000 }, async t => {
    const corpus = await isolatedCorpus(t, true, true);
    // A recorded request names a real grandchild, but its canonical parent is
    // still the child. This must not create a direct root insertion control.
    const forged = [
      { type: 'function_call', call_id: 'WRONG_PARENT', name: 'spawn_agent',
        namespace: 'collaboration', arguments: '{}' },
      { type: 'function_call_output', call_id: 'WRONG_PARENT',
        output: JSON.stringify({ task_name: actorPaths.grandchild, agent_id: ids.grandchild }) },
    ].map(payload => JSON.stringify({ timestamp: '2026-09-27T00:01:00.000Z', type: 'response_item', payload }));
    forged.splice(1, 0, JSON.stringify({ timestamp: '2026-09-27T00:01:00.000Z', type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'SubAgentActivity', kind: 'started',
        id: 'WRONG_PARENT', agent_thread_id: ids.grandchild } } }));
    await writeFile(corpus.copiedFiles[0], (await readFile(corpus.copiedFiles[0], 'utf8')) + forged.join('\n') + '\n');
    corpus.copiedHashes[0] = sha256(corpus.copiedFiles[0]);
    const harness = await startServer(t, corpus.scratch, corpus.codexDir);
    const base = `${harness.origin}/api/v3/reader/codex/${ids.root}`;
    const bootstrap = await getJson(`${base}/bootstrap`, 'late child bootstrap');
    const first = await getJson(`${base}/relations?cursor=${encodeURIComponent(bootstrap.relations.firstCursor)}`, 'first relations');
    assert.ok(first.nextCursor);
    assert.ok(!first.childPlacements.some(row => row.child.sessionId === ids.child));
    const allRelations = await relationPages(base, bootstrap);
    const wrongParent = allRelations.entries.find(row => row.type === 'coordination' &&
      row.observation.correlationId === 'WRONG_PARENT' && row.observation.toActorPath === actorPaths.grandchild);
    assert.ok(wrongParent, 'The forged coordination actually reaches normalized relations');
    assert.equal(wrongParent.observation.toSessionRef ?? null, null,
      'The provider refuses the recorded grandchild ID whose canonical parent is different');
    const query = new URLSearchParams({ revision: bootstrap.revision, childProvider: 'codex', childSessionId: ids.child });
    const located = await getJson(`${base}/child-location?${query}`, 'canonical child location');
    assert.deepEqual(located.placement.child, ref(ids.child));
    assert.deepEqual(located.placement.afterEvent, event(ids.root, 'SPAWN_ITEM'));
    assert.deepEqual(located.location.event, located.placement.afterEvent);
    assert.ok(located.location.ordinal >= 80);
    for (const childId of [ids.grandchild, 'missing-child']) {
      query.set('childSessionId', childId);
      const missing = await getJson(`${base}/child-location?${query}`, 'missing or wrong-parent placement');
      assert.equal(missing.placement, null);
      assert.equal(missing.location, null);
      assert.equal(missing.diagnostic, 'child_placement_unavailable');
    }
    query.set('childSessionId', ids.child);
    query.set('revision', 'stale-revision');
    assert.equal((await fetch(`${base}/child-location?${query}`)).status, 409);
    query.set('revision', bootstrap.revision);
    await writeFile(corpus.copiedFiles[0], (await readFile(corpus.copiedFiles[0], 'utf8')) + JSON.stringify({
      timestamp: '2026-09-27T00:02:00.000Z', type: 'event_msg',
      payload: { type: 'agent_message', id: 'after-publication', message: 'Recorded source changed.' },
    }) + '\n');
    corpus.copiedHashes[0] = sha256(corpus.copiedFiles[0]);
    assert.equal((await fetch(`${base}/child-location?${query}`)).status, 409,
      'A real source append after publication rejects the previously valid revision');
  });

test('deep child restoration does not drain unrelated relation pages',
  { skip: skipBrowser, timeout: 120_000 }, async t => {
    const corpus = await isolatedCorpus(t, true, true);
    const harness = await startServer(t, corpus.scratch, corpus.codexDir);
    const hash = '#child?' + new URLSearchParams({ provider: 'codex', sessionId: ids.grandchild,
      path: JSON.stringify([ref(ids.child), ref(ids.grandchild)]) });
    const command = await startBrowser(harness, `${harness.origin}/codex/session/${ids.root}${hash}`);
    const nestedPane = `section.inline-child-reader[aria-label="Child session ${ids.grandchild}"]`;
    await waitForBrowser(command, `document.querySelector('${nestedPane}')`, 'late grandchild');
    for (const id of [ids.root, ids.child]) {
      const calls = JSON.parse(await command('eval', `performance.getEntriesByType('resource')
        .filter(row => new URL(row.name).pathname === '/api/v3/reader/codex/${id}/relations').length`));
      assert.ok(calls <= 1, `Restoring ${id} should fetch at most its initial relation page, got ${calls}`);
    }
    await command('reload');
    await waitForBrowser(command, `document.querySelector('${nestedPane}')`, 'late grandchild after reload');
    assert.equal(Number(await command('get', 'count', '.inline-child-reader')), 2);
    const pathHash = path => '#child?' + new URLSearchParams({ provider: 'codex', sessionId: path.at(-1).sessionId,
      path: JSON.stringify(path) });
    const errorText = 'The recorded child insertion point is unavailable.';
    for (const missingPath of [[ref('missing-root-child')], [ref(ids.child), ref('missing-nested-child')]]) {
      await command('eval', `location.hash = ${JSON.stringify(pathHash(missingPath))}`);
      await waitForBrowser(command, `document.body.textContent.includes(${JSON.stringify(errorText)})`, 'missing child diagnostic');
      await command('eval', `location.hash = ${JSON.stringify(hash)}`);
      await waitForBrowser(command, `document.querySelector('${nestedPane}') && !document.body.textContent.includes(${JSON.stringify(errorText)})`,
        'valid child restoration clears the previous diagnostic');
    }
    assert.equal((await command('errors')).trim(), '');
  });

test('real browser expands a three-level Codex chain once at each spawn, continues history, and restores focus and Back state',
  { skip: skipBrowser, timeout: 120_000 }, async t => {
    const corpus = await isolatedCorpus(t);
    const harness = await startServer(t, corpus.scratch, corpus.codexDir);
    const rootHref = `/codex/session/${ids.root}`;
    const command = await startBrowser(harness, `${harness.origin}${rootHref}`);
    await waitForBrowser(command, `window.location.pathname === '${rootHref}' && document.querySelector('.reader-heading h1')`,
      'the real Codex root Reader');

    const rootButtonId = `child-toggle-${Buffer.from(`codex\0${ids.child}`).toString('hex')}`;
    const childButtonId = `child-toggle-${Buffer.from(`codex\0${ids.grandchild}`).toString('hex')}`;
    const rootToggle = `#${rootButtonId}`;
    const childToggle = `#${childButtonId}`;
    const clickToggle = selector => command('eval', `(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      if (!button) throw new Error('The inline child toggle is not present.');
      button.click();
      return true;
    })()`);
    await waitForBrowser(command, `document.querySelector('${rootToggle}')`,
      'the root child placement immediately after SPAWN_ITEM / tool');
    const rootAnchor = JSON.parse(await command('eval', `(() => {
      const button = document.querySelector('${rootToggle}');
      const placement = button?.closest('.inline-child-placement');
      const turn = placement?.closest('.turn-block');
      const card = turn?.querySelector('article.tool-card');
      return { source: card ? card.dataset.messageId + ' / ' + card.dataset.segment : null,
        follows: Boolean(card && placement && (card.compareDocumentPosition(placement) & Node.DOCUMENT_POSITION_FOLLOWING)),
        count: document.querySelectorAll('#${rootButtonId}').length };
    })()`));
    assert.deepEqual(rootAnchor, { source: 'SPAWN_ITEM / tool', follows: true, count: 1 },
      'The root child mounts once after the exact recorded spawn tool event');
    await command('click', rootToggle);
    const childPane = `section.inline-child-reader[aria-label="Child session ${ids.child}"]`;
    await waitForBrowser(command, `document.querySelector('${childPane}')`, 'the expanded child history');
    assert.equal(Number(await command('get', 'count', childPane)), 1, 'The canonical child mounts once');

    await waitForBrowser(command, `document.querySelector('${childPane} ${childToggle}')`,
      'the nested child placement immediately after GRANDCHILD_SPAWN_ITEM / tool');
    const nestedAnchor = JSON.parse(await command('eval', `(() => {
      const pane = document.querySelector('${childPane}');
      const button = pane?.querySelector('${childToggle}');
      const placement = button?.closest('.inline-child-placement');
      const card = [...pane.querySelectorAll('article.tool-card')]
        .find(article => article.dataset.messageId + ' / ' + article.dataset.segment === 'GRANDCHILD_SPAWN_ITEM / tool');
      const nextEvent = [...pane.querySelectorAll('.event-card')].find(candidate =>
        card && (card.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING));
      return { source: card ? card.dataset.messageId + ' / ' + card.dataset.segment : null,
        follows: Boolean(card && placement && (card.compareDocumentPosition(placement) & Node.DOCUMENT_POSITION_FOLLOWING)),
        beforeNext: !nextEvent || Boolean(placement && (placement.compareDocumentPosition(nextEvent) & Node.DOCUMENT_POSITION_FOLLOWING)),
        count: pane?.querySelectorAll('${childToggle}').length || 0 };
    })()`));
    assert.deepEqual(nestedAnchor, { source: 'GRANDCHILD_SPAWN_ITEM / tool', follows: true, beforeNext: true, count: 1 },
      'The grandchild has one insertion control after its own recorded spawn tool event');
    // The headless selector click can land on the sticky top bar for inline controls.
    await clickToggle(childToggle);

    const grandchildPane = `section.inline-child-reader[aria-label="Child session ${ids.grandchild}"]`;
    await waitForBrowser(command,
      `document.querySelector('${grandchildPane}') && document.querySelectorAll('.inline-child-reader').length === 2`,
      'the nested grandchild pane with only one mount per child');
    assert.equal(Number(await command('get', 'count', grandchildPane)), 1);
    await waitForBrowser(command, `document.querySelector('${grandchildPane} .inline-child-next')`,
      'the grandchild event continuation control');
    assert.match(await command('get', 'text', grandchildPane), /32 of 33 events loaded/);
    await command('click', `${grandchildPane} .inline-child-next`);
    await waitForBrowser(command, `document.querySelector('${grandchildPane}')?.textContent.includes('33 of 33 events loaded')`,
      'the complete grandchild event continuation');

    const longCard = `(() => [...document.querySelector('${grandchildPane}').querySelectorAll('.event-card')]
      .find(card => card.dataset.messageId + ' / ' + card.dataset.segment === 'grandchild-long / message'))()`;
    for (let page = 0; page < 5; page++) {
      const current = JSON.parse(await command('eval', `(() => { const card = ${longCard}; return {
        complete: card?.querySelector('.event-body')?.textContent.includes('GRANDCHILD-END-OF-CONTENT') || false,
        progress: card?.querySelector('.content-progress')?.textContent || '' } })()`));
      if (current.complete) break;
      await command('eval', `(() => { const card = ${longCard}; card?.querySelector('.event-footer .read-more')?.click(); return true })()`);
      await waitForBrowser(command,
        `${longCard}?.querySelector('.content-progress')?.textContent !== ${JSON.stringify(current.progress)} || ${longCard}?.querySelector('.event-body')?.textContent.includes('GRANDCHILD-END-OF-CONTENT')`,
        'the next long grandchild content page');
    }
    const grandchildBody = await command('eval', `${longCard}?.querySelector('.event-body')?.textContent || ''`);
    assert.ok(grandchildBody.includes('GRANDCHILD-END-OF-CONTENT'), 'The final grandchild body is fully readable');
    assert.equal(Number(await command('get', 'count', `${grandchildPane} .event-card`)), 33);

    await command('back');
    await waitForBrowser(command,
      `document.querySelectorAll('.inline-child-reader').length === 1 && document.querySelector('${childToggle}')`,
      'Back returning to the child at the nested insertion point');
    assert.equal(JSON.parse(await command('eval', 'document.activeElement?.id')), childButtonId,
      'Back restores focus to the grandchild insertion control');
    await command('forward');
    await waitForBrowser(command, `document.querySelectorAll('.inline-child-reader').length === 2`,
      'Forward restoring the grandchild inline pane');

    // The headless selector click is not dispatched for this restored insertion control.
    await clickToggle(childToggle);
    await waitForBrowser(command, `document.querySelectorAll('.inline-child-reader').length === 1`,
      'collapsing only the grandchild pane');
    assert.equal(JSON.parse(await command('eval', 'document.activeElement?.id')), childButtonId,
      'Nested collapse restores focus to its parent insertion control');
    await clickToggle(childToggle);
    await waitForBrowser(command, `document.querySelectorAll('.inline-child-reader').length === 2`,
      're-expanding the same grandchild once');
    assert.equal(Number(await command('get', 'count', grandchildPane)), 1);
    await command('click', rootToggle);
    await waitForBrowser(command, `document.querySelectorAll('.inline-child-reader').length === 0`,
      'collapsing the root child and its nested pane');
    assert.equal(JSON.parse(await command('eval', 'document.activeElement?.id')), rootButtonId,
      'Outer collapse restores focus to the root insertion control');
    assert.equal((await command('errors')).trim(), '', 'The real browser reports no uncaught page errors');
  });

test('deep child URL restores late root and nested spawn anchors after refresh and Back',
  { skip: skipBrowser, timeout: 120_000 }, async t => {
    const corpus = await isolatedCorpus(t, true);
    const harness = await startServer(t, corpus.scratch, corpus.codexDir);
    for (const sessionId of [ids.root, ids.child]) {
      const base = `${harness.origin}/api/v3/reader/codex/${sessionId}`;
      const bootstrap = await getJson(`${base}/bootstrap`, 'late anchor bootstrap');
      const relations = await relationPages(base, bootstrap);
      assert.equal(relations.placements.length, 1, 'The late fixture retains its canonical child placement');
      const location = await getJson(`${base}/locate?${new URLSearchParams({
        revision: bootstrap.revision,
        messageId: relations.placements[0].afterEvent.messageId,
        segment: relations.placements[0].afterEvent.segment,
      })}`, 'late anchor location');
      assert.ok(location.ordinal >= 32, 'The insertion anchor is beyond the first Reader page');
      const anchorPage = await getJson(`${base}/segments?cursor=${encodeURIComponent(location.pageCursor)}`, 'late anchor page');
      assert.ok(anchorPage.page.items.some(item => JSON.stringify(item.event) === JSON.stringify(relations.placements[0].afterEvent)),
        'The located page contains the exact placement event');
    }
    const rootHref = `/codex/session/${ids.root}`;
    const pathHash = path => '#child?' + new URLSearchParams({
      provider: 'codex', sessionId: path.at(-1).sessionId, path: JSON.stringify(path),
    });
    const nestedHash = pathHash([ref(ids.child), ref(ids.grandchild)]);
    const command = await startBrowser(harness, `${harness.origin}${rootHref}${nestedHash}`);
    const rootToggle = `#child-toggle-${Buffer.from(`codex\0${ids.child}`).toString('hex')}`;
    const nestedToggle = `#child-toggle-${Buffer.from(`codex\0${ids.grandchild}`).toString('hex')}`;
    const nestedPane = `section.inline-child-reader[aria-label="Child session ${ids.grandchild}"]`;
    try {
      await waitForBrowser(command, `document.querySelector('${nestedPane}')`,
        'a direct deep link through both late spawn anchors');
    } catch (error) {
      const state = await command('eval', `JSON.stringify({ hash: location.hash,
        toggles: [...document.querySelectorAll('.inline-child-toggle')].map(el => el.textContent),
        panes: [...document.querySelectorAll('.inline-child-reader')].map(el => el.getAttribute('aria-label')),
        errors: [...document.querySelectorAll('.content-error')].map(el => el.textContent),
        loaded: document.querySelector('.reader-actions')?.textContent,
        cards: [...document.querySelectorAll('article.event-card')].map(article => article.dataset.messageId + ' / ' + article.dataset.segment).slice(-8),
        collaborationGraphNodes: [...document.querySelectorAll('.collaboration-child-node')]
          .map(node => node.textContent.trim()),
        requests: performance.getEntriesByType('resource').map(row => row.name).filter(name => name.includes('/reader/')).slice(-12),
        body: document.body.textContent.slice(-500) })`);
      throw new Error(`${error.message}; state=${state}`);
    }
    assert.equal(Number(await command('get', 'count', rootToggle)), 1);
    assert.equal(Number(await command('get', 'count', nestedToggle)), 1);
    await command('eval', 'window.location.reload()');
    await waitForBrowser(command, `document.querySelector('${nestedPane}')`,
      'deep child history after refresh');
    await command('eval', `document.querySelector('${nestedToggle}').click()`);
    await waitForBrowser(command, `!document.querySelector('${nestedPane}')`,
      'nested child collapsed at its late spawn');
    await command('back');
    await waitForBrowser(command, `document.querySelector('${nestedPane}')`,
      'Back restoring the nested late child');
    const marker = 'GRANDCHILD-END-OF-CONTENT';
    const search = `${nestedPane} .pane-search[data-scope="child"]`;
    await command('fill', `${search} input[type="search"]`, marker);
    await command('eval', `document.querySelector('${search} button[type="submit"]').click()`);
    await waitForBrowser(command, `document.querySelector('${search} .pane-search-result')`,
      'the selected late grandchild content hit');
    await command('eval', `document.querySelector('${search} .pane-search-result').click()`);
    await waitForBrowser(command, `document.querySelector('${nestedPane} .search-reveal mark')?.textContent === '${marker}'`,
      'the selected grandchild match in its source pane');
    assert.match(JSON.parse(await command('eval', 'location.hash')), /offset=\d+.*matchLength=\d+/,
      'The child location records the selected content span');
    await command('eval', 'window.location.reload()');
    await waitForBrowser(command, `document.querySelector('${nestedPane} .search-reveal mark')?.textContent === '${marker}'`,
      'the selected late child hit after refresh');
    await command('back');
    await waitForBrowser(command, `document.querySelector('${nestedPane}') && !document.querySelector('${nestedPane} .search-reveal')`,
      'Back restoring the child path before the search selection');
    await command('forward');
    await waitForBrowser(command, `document.querySelector('${nestedPane} .search-reveal mark')?.textContent === '${marker}'`,
      'Forward restoring the selected late child hit');
    const childPane = `section.inline-child-reader[aria-label="Child session ${ids.child}"]`;
    const ancestorSearch = `${childPane} > .pane-search[data-scope="child"]`;
    const ancestorMarker = 'Public history before GRANDCHILD_SPAWN_ITEM: 39';
    await command('fill', `${ancestorSearch} input[type="search"]`, ancestorMarker);
    await command('eval', `document.querySelector('${ancestorSearch} button[type="submit"]').click()`);
    await waitForBrowser(command, `document.querySelector('${ancestorSearch} .pane-search-result')`,
      'a hit in the parent pane while the grandchild stays expanded');
    await command('eval', `document.querySelector('${ancestorSearch} .pane-search-result').click()`);
    const ancestorReveal = `${childPane} > .inline-child-transcript .search-reveal mark`;
    await waitForBrowser(command, `document.querySelector('${ancestorReveal}')?.textContent === '${ancestorMarker}'`,
      'the parent-pane hit');
    assert.match(JSON.parse(await command('eval', 'location.hash')),
      new RegExp(`searchSessionId=${ids.child}.*messageId=before-GRANDCHILD_SPAWN_ITEM-39`),
      'The selected event retains its own pane identity in the deep child URL');
    await command('eval', 'window.location.reload()');
    await waitForBrowser(command, `document.querySelector('${nestedPane}') && document.querySelector('${ancestorReveal}')?.textContent === '${ancestorMarker}'`,
      'the parent-pane hit and nested child after refresh');
    const loadedRefs = JSON.parse(await command('eval', `(() => {
      const pane = document.querySelector('${childPane}');
      return [...pane.querySelectorAll('.event-card')].filter(card => card.closest('.inline-child-reader') === pane)
        .map(card => card.dataset.messageId + ' / ' + card.dataset.segment);
    })()`));
    assert.equal(new Set(loadedRefs).size, loadedRefs.length,
      'Concurrent nested-anchor and ancestor-search restoration mounts each event once');
    const browserErrors = (await command('errors')).trim();
    assert.equal(browserErrors, '', `Browser errors after deep child restoration: ${browserErrors}\n${browserErrors ? await command('errors', '--json') : ''}`);
  });
