import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const provider = 'claude-code';
const rootId = '11111111-2222-4333-8444-555555555555';
const publicClaudeFixture = path.join(repo, 'test', 'fixtures', 'claude-current-v259-synthetic.jsonl');
const event = (sessionId, messageId, segment) => ({ provider, sessionId, messageId, segment });
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const row = value => JSON.stringify(value);
const browserName = process.platform === 'win32' ? 'agent-browser-win32-x64.exe'
  : `agent-browser-${process.platform}-${process.arch}`;
const agentBrowser = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
  (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', browserName)).find(existsSync);
const browserSkip = !agentBrowser ? 'The existing agent-browser CLI binary is required.' : false;

async function fixture() {
  const dir = await mkdtemp(path.join(repo, 'tmp', 'v3-claude-slice-'));
  for (const name of ['claude/projects/project-a', 'claude/transcripts', 'codex', 'pi', 'dsh', 'meta', 'index', 'cache']) {
    await mkdir(path.join(dir, name), { recursive: true });
  }
  const current = path.join(dir, 'claude', 'projects', 'project-a', `${rootId}.jsonl`);
  const currentReference = path.join(dir, 'claude', 'projects', 'project-a', 'current-reference.jsonl');
  const old = path.join(dir, 'claude', 'transcripts', 'legacy-id.jsonl');
  await copyFile(publicClaudeFixture, currentReference);
  await copyFile(path.join(repo, 'test', 'fixtures', 'claude-legacy.jsonl'), old);
  const stamp = '2026-09-27T00:00:00.000Z';
  const usage = { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 4,
    cache_creation_input_tokens: 5 };
  const toolOutput = 'tool output ' + '🙂'.repeat(150);
  const rows = [
    { type: 'system', subtype: 'compact_boundary', uuid: 'compact-1', timestamp: stamp,
      compactMetadata: { trigger: 'auto', preTokens: 123 } },
    { type: 'user', uuid: 'user-1', timestamp: stamp, cwd: '/synthetic/work',
      message: { content: [{ type: 'text', text: 'Investigate source evidence' }] } },
    { type: 'assistant', uuid: 'assistant-thinking', timestamp: stamp,
      message: { id: 'response-1', usage, content: [{ type: 'thinking', thinking: 'Recorded thought' }] } },
    { type: 'assistant', uuid: 'assistant-tool', timestamp: stamp,
      message: { id: 'response-1', usage, content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'example' } }] } },
    { type: 'user', uuid: 'user-tool-result', timestamp: stamp,
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: toolOutput }] } },
    { type: 'assistant', uuid: 'assistant-answer', timestamp: stamp,
      message: { id: 'response-1', usage, content: [{ type: 'text', text: 'Source confirmed.' }] } },
    { type: 'user', uuid: 'task-done', timestamp: stamp, message: { content:
      '<task-notification><task-id>task-1</task-id><tool-use-id>tool-1</tool-use-id><status>completed</status><summary>Child returned</summary></task-notification>' } },
    { type: 'user', uuid: 'task-without-status', timestamp: stamp, message: { content:
      '<task-notification><task-id>task-1</task-id><summary>Waiting for an update</summary></task-notification>' } },
  ];
  await writeFile(current, rows.map(row).join('\n') + '\n');
  const child = path.join(dir, 'claude', 'projects', 'project-a', rootId, 'subagents', 'agent-child-a.jsonl');
  await mkdir(path.dirname(child), { recursive: true });
  const childRows = [
    { type: 'user', uuid: 'child-user', timestamp: stamp, isSidechain: true,
      agentId: 'child-a', sessionId: rootId,
      message: { content: [{ type: 'text', text: 'Check the file' }] } },
    { type: 'user', uuid: 'child-notification', timestamp: stamp, isSidechain: true,
      agentId: 'child-a', sessionId: rootId,
      message: { content: '<task-notification><task-id>child-task</task-id><summary>Child notification returned</summary></task-notification>' } },
  ];
  await writeFile(child, childRows.map(row).join('\n') + '\n');
  const args = [
    '--claude-dir', path.join(dir, 'claude'), '--codex-dir', path.join(dir, 'codex'),
    '--opencode-db', path.join(dir, 'opencode.db'), '--pi-dir', path.join(dir, 'pi'),
    '--dsh-dir', path.join(dir, 'dsh'), '--meta-dir', path.join(dir, 'meta'),
    '--index-dir', path.join(dir, 'index'), '--cache-dir', path.join(dir, 'cache'),
  ];
  return { dir, args, current, currentReference, old, child,
    cleanup: () => rm(dir, { recursive: true, force: true }),
    hashes: [current, currentReference, old, child].map(digest), toolOutput };
}

async function freePort() {
  return freeFetchSafePort();
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timer;
  const exited = once(child, 'exit').then(() => true);
  const timedOut = new Promise(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const result = await Promise.race([exited, timedOut]);
  clearTimeout(timer);
  return result;
}

async function stopReaderServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForChildExit(child, 3_000);
  child.kill();
  if (await exited) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' });
    await Promise.race([once(killer, 'exit'), new Promise(resolve => setTimeout(resolve, 5_000))]);
    if (await waitForChildExit(child, 3_000)) return;
  }
  throw new Error(`The isolated AgentSession server ${child.pid ?? '<unknown>'} did not exit during cleanup`);
}

async function startReaderServer(f) {
  const port = await freePort();
  const child = spawn(binary, ['serve', '--port', String(port), ...f.args],
    { cwd: repo, windowsHide: true, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok) {
        return { base, stop: () => stopReaderServer(child) };
      }
    }
    catch { /* The isolated service is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The isolated AgentSession 3.0 server did not start');
}

async function browserCommand(session, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(agentBrowser, ['--session', session, ...args], {
      cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeoutMs = args[0] === 'close' ? 4_000 : 15_000;
    const timer = setTimeout(() => { child.kill(); reject(new Error(`agent-browser ${args.join(' ')} timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', cause => { clearTimeout(timer); reject(cause); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code) reject(new Error(`agent-browser ${args.join(' ')} failed (${code}): ${stderr || stdout}`));
      else resolve(stdout.trim());
    });
  });
}

async function waitForBrowser(session, predicate, description, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await browserCommand(session, 'eval', `Boolean(${predicate})`);
    if (last.includes('true')) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}; last browser result: ${last}`);
}

test('Claude current, legacy and sidechain evidence reaches Web Reader', { timeout: 30_000 }, async t => {
  const f = await fixture();
  const publicFixtureHash = digest(publicClaudeFixture);
  const port = await freePort();
  const child = spawn(binary, ['serve', '--port', String(port), ...f.args],
    { cwd: repo, windowsHide: true, stdio: 'ignore' });
  t.after(async () => {
    try { await stopReaderServer(child); }
    finally { await f.cleanup(); }
  });
  const base = `http://127.0.0.1:${port}`;
  let providers;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${base}/api/providers`);
      if (response.ok) { providers = await response.json(); break; }
    } catch { /* Startup in progress. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(providers);
  assert.equal(providers.find(item => item.id === provider).available, true);
  const sessions = await (await fetch(`${base}/api/v3/sessions?provider=${provider}`)).json();
  assert.deepEqual(sessions.map(item => item.session.sessionId).sort(),
    ['child-a', 'current-reference', 'legacy-id', rootId].sort());
  assert.equal(sessions.find(item => item.session.sessionId === rootId).tokenCount, 14);
  assert.equal(sessions.find(item => item.session.sessionId === rootId).messageCount, 6,
    'Recorded thinking belongs to the following tool call, not an extra message');
  assert.deepEqual(sessions.find(item => item.session.sessionId === 'child-a').parent,
    { provider, sessionId: rootId });
  const response = await fetch(`${base}/api/v3/reader/${provider}/${rootId}/bootstrap`);
  assert.equal(response.status, 200);
  const bootstrap = await response.json();
  assert.ok(bootstrap.relations.firstCursor);
  const relationPage = await (await fetch(`${base}/api/v3/reader/${provider}/${rootId}/relations?cursor=${encodeURIComponent(bootstrap.relations.firstCursor)}`)).json();
  const tasks = relationPage.entries.filter(entry => entry.type === 'task').map(entry => entry.task);
  assert.deepEqual(tasks.map(task => [task.id, task.status, task.provenance.sourceId]), [
    ['task-1', 'completed', 'task-done'],
    ['task-1', 'unknown', 'task-without-status'],
  ]);
  assert.deepEqual(tasks.map(task => task.readerEvent), [
    event(rootId, 'task-done', 'tool'),
    event(rootId, 'task-without-status', 'tool'),
  ], 'Repeated task IDs retain the exact source notification Reader event');
  const sourceNotifications = readFileSync(f.current, 'utf8').trim().split(/\r?\n/)
    .map(JSON.parse)
    .filter(record => record.type === 'user' &&
      String(record.message?.content ?? record.content).startsWith('<task-notification>'));
  assert.deepEqual(tasks.map(task => task.provenance.sourceId), sourceNotifications.map(record => record.uuid));
  assert.deepEqual(tasks.map(task => task.readerEvent),
    sourceNotifications.map(record => event(rootId, record.uuid, 'tool')),
    'The public-source-derived relation refs follow the notification UUIDs in source order');
  const childBootstrap = await (await fetch(`${base}/api/v3/reader/${provider}/child-a/bootstrap`)).json();
  const childRelationPage = await (await fetch(`${base}/api/v3/reader/${provider}/child-a/relations?cursor=${encodeURIComponent(childBootstrap.relations.firstCursor)}`)).json();
  const childTasks = childRelationPage.entries.filter(entry => entry.type === 'task').map(entry => entry.task);
  const sourceChildNotifications = readFileSync(f.child, 'utf8').trim().split(/\r?\n/)
    .map(JSON.parse)
    .filter(record => record.type === 'user' &&
      String(record.message?.content ?? record.content).startsWith('<task-notification>'));
  assert.deepEqual(childTasks.map(task => task.readerEvent),
    sourceChildNotifications.map(record => event('child-a', record.uuid, 'tool')),
    'A child-session task notification retains its own canonical Reader reference');
  const items = bootstrap.segments.flatMap(segment => segment.items);
  assert.equal(items.find(item => item.event.messageId === 'task-done')?.preview, 'task_notification: Child returned');
  assert.equal(items.find(item => item.event.messageId === 'task-without-status')?.preview,
    'task_notification: Waiting for an update');
  assert.ok(items.some(item => item.event.messageId === 'compact-1' && item.role === 'context'
    && item.event.segment === 'context'));
  const thinkingItem = items.find(item => item.event.messageId === 'tool-1' && item.event.segment === 'thinking');
  assert.ok(thinkingItem);
  assert.deepEqual(thinkingItem.owner, event(rootId, 'tool-1', 'tool'),
    'Thinking must identify the tool message it belongs to');
  const callItem = items.find(item => item.event.messageId === 'tool-1' && item.event.segment === 'tool');
  assert.ok(callItem);
  assert.equal(callItem.owner, null);
  const resultItem = items.find(item => item.event.messageId === 'tool-result:tool-1' && item.event.segment === 'tool');
  assert.ok(resultItem);
  assert.equal(resultItem.ownerMessageId, 'tool-1');
  assert.deepEqual(resultItem.owner, event(rootId, 'tool-1', 'tool'));
  assert.equal((await fetch(`${base}/api/v3/reader/${provider}/missing/bootstrap`)).status, 404);
  const reference = await (await fetch(`${base}/api/v3/reader/${provider}/current-reference/bootstrap`)).json();
  assert.ok(reference.segments.flatMap(segment => segment.items)
    .some(item => item.event.messageId === 'compact-boundary-1' && item.role === 'context'
      && item.event.segment === 'context'));
  await writeFile(path.join(f.dir, 'claude', 'transcripts', 'corrupt.jsonl'), '{bad json}\n');
  const corrupt = await fetch(`${base}/api/v3/reader/${provider}/corrupt/bootstrap`);
  assert.equal(corrupt.status, 500);
  assert.equal((await corrupt.json()).error.code, 'source_error');
  assert.deepEqual([f.current, f.currentReference, f.old, f.child].map(digest), f.hashes);
  await appendFile(f.current, `${row({ type: 'assistant', uuid: 'later',
    timestamp: '2026-09-27T00:00:01.000Z', message: { content: [{ type: 'text', text: 'Later' }] } })}\n`);
  const stale = new URLSearchParams({ messageId: 'assistant-answer', segment: 'message',
    field: 'body', offset: '0', maxChars: '80', revision: bootstrap.revision });
  assert.equal((await fetch(`${base}/api/v3/reader/${provider}/${rootId}/content?${stale}`)).status, 409);
  assert.equal(digest(publicClaudeFixture), publicFixtureHash, 'The public Claude source fixture remains unchanged');
});

test('Claude child sidechain parent is anchored in same-revision protocol and Runtime graph',
  { timeout: 30_000 }, async t => {
    const f = await fixture();
    const server = await startReaderServer(f);
    t.after(async () => { try { await server.stop(); } finally { await f.cleanup(); } });
    const source = JSON.parse(readFileSync(f.child, 'utf8').split(/\r?\n/)[0]);
    assert.deepEqual([source.isSidechain, source.agentId, source.sessionId],
      [true, 'child-a', rootId]);
    const reader = await (await fetch(`${server.base}/api/v3/reader/${provider}/child-a/bootstrap`)).json();
    const v2 = await (await fetch(`${server.base}/api/v3/protocol/${provider}/child-a?version=2`)).json();
    const v3 = await (await fetch(`${server.base}/api/v3/protocol/${provider}/child-a?version=3`)).json();
    assert.equal(v3.validation.ok, true);
    assert.equal(v3.revision, reader.revision);
    assert.equal(v2.revision, v3.revision);
    assert.deepEqual(v2.relationships, v3.relationships);
    assert.deepEqual(v3.relationships.map(relation => [relation.kind, relation.from,
      relation.to, relation.evidence]), [[
      'parent', { provider, sessionId: rootId }, { provider, sessionId: 'child-a' },
      { eventId: 'event:claude:0', provenance: {
        fidelity: 'recorded', sourceType: 'claude.sidechain.sessionId', sourceId: source.uuid,
      } },
    ]]);
    assert.equal(v3.coverage.relationships.state, 'observed');
    assert.deepEqual(v3.tasks, []);
    assert.deepEqual(v3.agentRuns, []);
    const graph = await (await fetch(`${server.base}/api/v3/runtime/${provider}/child-a/graph?maxNodes=100`)).json();
    assert.equal(graph.revision, v3.revision);
    assert.ok(graph.edges.some(edge => edge.type === 'parent' && edge.provenance.sourceId === source.uuid));
    assert.ok(graph.nodes.some(node => node.kind === 'session' && node.session.sessionId === rootId));
    assert.deepEqual([f.current, f.currentReference, f.old, f.child].map(digest), f.hashes);
  });

test('Claude sidechain without a usable parent keeps relationship coverage unknown',
  { timeout: 30_000 }, async t => {
    const f = await fixture();
    const childRows = readFileSync(f.child, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    for (const record of childRows) record.sessionId = ' ';
    await writeFile(f.child, childRows.map(row).join('\n') + '\n');
    const server = await startReaderServer(f);
    t.after(async () => { try { await server.stop(); } finally { await f.cleanup(); } });
    const protocol = await (await fetch(`${server.base}/api/v3/protocol/${provider}/child-a?version=3`)).json();
    assert.equal(protocol.validation.ok, true);
    assert.deepEqual(protocol.relationships, []);
    assert.equal(protocol.coverage.relationships.state, 'unknown');
    assert.deepEqual(protocol.tasks, []);
    assert.deepEqual(protocol.agentRuns, []);
  });

test('Claude Runtime graph opens the canonical parent Reader and restores graph focus', {
  timeout: 90_000, skip: browserSkip,
}, async t => {
  const f = await fixture();
  const publicFixtureHash = digest(publicClaudeFixture);
  const sourceHashes = [...f.hashes];
  const session = `agentsession-v3-claude-task-${process.pid}-${Date.now()}`;
  let stopServer = async () => {};
  t.after(async () => {
    let cleanupFailure;
    try {
      assert.equal(digest(publicClaudeFixture), publicFixtureHash, 'The public Claude fixture remains unchanged');
      assert.deepEqual([f.current, f.currentReference, f.old, f.child].map(digest), sourceHashes,
        'The Reader leaves provider source files unchanged');
    } catch (cause) { cleanupFailure = cause; }
    try { await browserCommand(session, 'close'); } catch { /* The browser may already be closed. */ }
    try { await stopServer(); } catch (cause) { cleanupFailure ??= cause; }
    try { await f.cleanup(); } catch (cause) { cleanupFailure ??= cause; }
    if (cleanupFailure) throw cleanupFailure;
  });
  const server = await startReaderServer(f);
  const base = server.base;
  stopServer = server.stop;
  let phase = 'open the root Claude Reader';
  try {
    await browserCommand(session, 'open', `${base}/${provider}/session/${rootId}`);
    await browserCommand(session, 'set', 'viewport', '1280', '900');
    phase = 'wait for the root Reader';
    await waitForBrowser(session, "document.querySelector('#reader-title')", 'the Claude Reader');
    phase = 'open the session library';
    await browserCommand(session, 'click', 'a.reader-back-link');
    await waitForBrowser(session, `location.pathname === '/sessions' &&
      document.querySelector('#library-title')`, 'the session library');
    phase = 'expand the recorded Claude session family';
    await browserCommand(session, 'click', '.family-toggle');
    const childSessionLink = `a.family-child-row[href="/${provider}/session/child-a"]`;
    await waitForBrowser(session, `document.querySelector(${JSON.stringify(childSessionLink)})`,
      'the canonical Claude child-session link');
    phase = 'open the canonical child Reader';
    await browserCommand(session, 'click', childSessionLink);
    await waitForBrowser(session, `location.pathname === '/${provider}/session/child-a' &&
      document.querySelector('#reader-title')`, 'the canonical child Reader route');
    phase = 'open the child Runtime Sessions graph';
    await browserCommand(session, 'click', '.runtime-tab');
    await browserCommand(session, 'click', '.runtime-lens-sessions');
    const parentSelector = `.runtime-graph-node[data-session-id="${rootId}"] a`;
    await waitForBrowser(session, `document.querySelector(${JSON.stringify(parentSelector)})`,
      'the recorded Claude parent link');
    phase = 'open the canonical parent Reader from the child graph';
    await browserCommand(session, 'click', parentSelector);
    await waitForBrowser(session, `location.pathname === '/${provider}/session/${rootId}' &&
      document.querySelector('#reader-title')`, 'the canonical parent Reader');
    phase = 'restore the child Sessions lens and parent link focus';
    await browserCommand(session, 'back');
    await waitForBrowser(session, `location.pathname === '/${provider}/session/child-a' &&
      document.querySelector('.runtime-lens-sessions[aria-current="page"]') &&
      document.activeElement?.closest('.runtime-graph-node')?.getAttribute('data-session-id') === '${rootId}'`,
    'the child Sessions lens and focused parent link');
    phase = 'verify browser errors';
    assert.equal((await browserCommand(session, 'errors')).trim(), '');
  } catch (cause) {
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}\n${cause.stack ?? ''}` : String(cause);
    await writeFile(path.join(repo, 'tmp', `v3-claude-task-browser-${process.pid}.log`), `${phase}\n${detail}\n`);
    throw new Error(`Browser validation failed while trying to ${phase}: ${detail}`, { cause });
  }
});

test('Claude compact boundary opens from Reader outline and Runtime Context', {
  timeout: 60_000, skip: browserSkip,
}, async t => {
  const f = await fixture();
  const originalHash = digest(publicClaudeFixture);
  const sourceHashes = [...f.hashes];
  const server = await startReaderServer(f);
  const session = `agentsession-v3-claude-compact-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try { await browserCommand(session, 'close'); } catch { /* The browser may already be closed. */ }
    try { await server.stop(); } finally {
      assert.equal(digest(publicClaudeFixture), originalHash);
      assert.deepEqual([f.current, f.currentReference, f.old, f.child].map(digest), sourceHashes);
      await f.cleanup();
    }
  });
  await browserCommand(session, 'open', `${server.base}/${provider}/session/current-reference`);
  const outline = '.reader-outline a[href*="compact-boundary-1"]';
  await waitForBrowser(session, `document.querySelector(${JSON.stringify(outline)})`,
    'the Claude compact checkpoint in the Reader outline');
  assert.match(await browserCommand(session, 'get', 'text', outline), /Context checkpoint/);
  await browserCommand(session, 'click', outline);
  await waitForBrowser(session, `location.hash.includes('compact-boundary-1') &&
    document.querySelector('.event-card')?.textContent.includes('Recorded compact boundary (auto)')`,
  'the exact compact boundary Reader item');
  await browserCommand(session, 'focus', 'button.runtime-tab');
  await browserCommand(session, 'press', 'Enter');
  await browserCommand(session, 'focus', '.runtime-lens-context');
  await browserCommand(session, 'press', 'Enter');
  await waitForBrowser(session, `document.querySelector('.runtime-domain-context .runtime-domain-entry')`,
    'the Claude Context observation');
  assert.match(await browserCommand(session, 'get', 'text', '.runtime-domain-context'),
    /Recorded trigger.*auto.*Recorded tokens before compaction.*167189/s);
  await browserCommand(session, 'click', '.runtime-domain-context .runtime-domain-entry a[href^="#event?"]');
  await waitForBrowser(session, `location.hash.includes('compact-boundary-1') &&
    document.querySelector('.event-card')?.textContent.includes('Recorded compact boundary (auto)')`,
  'the Context link back to its Reader checkpoint');
  assert.equal((await browserCommand(session, 'errors')).trim(), '');
});

test('Claude availability requires a readable source, including corrupt-only roots',
  { timeout: 30_000 }, async t => {
    const f = await fixture();
    const emptyRoot = path.join(f.dir, 'claude-empty');
    await mkdir(emptyRoot);
    const args = [...f.args];
    args[args.indexOf('--claude-dir') + 1] = emptyRoot;
    const port = await freePort();
    const child = spawn(binary, ['serve', '--port', String(port), ...args],
      { cwd: repo, windowsHide: true, stdio: 'ignore' });
    t.after(async () => {
      try { await stopReaderServer(child); }
      finally { await f.cleanup(); }
    });
    const base = `http://127.0.0.1:${port}`;
    let status;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(`${base}/api/providers`);
        if (response.ok) { status = await response.json(); break; }
      } catch { /* Startup in progress. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(status?.find(item => item.id === provider)?.available, false);
    const transcriptDir = path.join(emptyRoot, 'transcripts');
    await mkdir(transcriptDir);
    await writeFile(path.join(transcriptDir, 'broken.jsonl'), '{broken}\n');
    status = await (await fetch(`${base}/api/providers`)).json();
    const claudeStatus = status.find(item => item.id === provider);
    assert.equal(claudeStatus.available, false);
    assert.equal(claudeStatus.storageDiagnostic, null);
  });

for (const era of ['legacy', 'modern']) {
  test(`Claude recorded event content and sidechain are available over ${era} MCP`,
    { timeout: 30_000 }, async t => {
      const f = await fixture();
      const client = new Client({ name: 'claude-slice', version: '1.0.0' },
        era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
      t.after(async () => {
        try { await client.close(); } catch { /* The client may not have connected. */ }
        await f.cleanup();
      });
      await client.connect(new StdioClientTransport({ command: binary, args: ['mcp', ...f.args],
        cwd: repo, stderr: 'pipe' }));
      const get = await client.callTool({ name: 'session_get', arguments: {
        session: { provider, sessionId: rootId },
      } });
      assert.notEqual(get.isError, true);
      assert.deepEqual(get.structuredContent.result.children.map(item => item.session.sessionId), ['child-a']);
      const ref = event(rootId, 'tool-result:tool-1', 'tool');
      const unexpanded = await client.callTool({ name: 'session_get_event', arguments: { event: ref } });
      assert.equal(unexpanded.structuredContent.result.toolOutput, null);
      let offset = 0;
      let reassembled = '';
      do {
        const result = await client.callTool({ name: 'session_get_event', arguments: {
          event: ref, includeToolOutput: true, offset, maxChars: 80,
        } });
        assert.notEqual(result.isError, true);
        const page = result.structuredContent.result.toolOutput;
        reassembled += page.text;
        offset = page.nextOffset;
      } while (offset !== null);
      assert.equal(reassembled, f.toolOutput);
      const thinking = event(rootId, 'tool-1', 'thinking');
      const denied = await client.callTool({ name: 'session_get_event', arguments: { event: thinking } });
      assert.equal(denied.isError, true);
      const allowed = await client.callTool({ name: 'session_get_event', arguments: {
        event: thinking, includeThinking: true,
      } });
      assert.equal(allowed.structuredContent.result.content.text, 'Recorded thought');
      assert.deepEqual([f.current, f.currentReference, f.old, f.child].map(digest), f.hashes);
    });
}

test('frozen private Claude source retains recorded facts through Web and MCP',
  { timeout: 30_000, skip: !process.env.AGENTSESSION_V3_CLAUDE_PRIVATE_MANIFEST }, async t => {
    const manifest = JSON.parse(readFileSync(process.env.AGENTSESSION_V3_CLAUDE_PRIVATE_MANIFEST));
    const source = manifest.files.find(file => file.provider === provider);
    assert.ok(source);
    assert.equal(digest(source.snapshotPath), source.snapshotSha256);
    const records = readFileSync(source.snapshotPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length, source.knownFacts.records);
    assert.equal(records.filter(record => record.type === 'system' &&
      record.subtype === 'compact_boundary').length, source.knownFacts.compactBoundaryRecords);
    const dir = await mkdtemp(path.join(repo, 'tmp', 'v3-claude-real-check-'));
    t.after(async () => { await rm(dir, { recursive: true, force: true }); });
    for (const name of ['codex', 'pi', 'dsh', 'meta', 'index', 'cache']) {
      await mkdir(path.join(dir, name));
    }
    const args = [
      '--claude-dir', manifest.providerRoots[provider].path,
      '--codex-dir', path.join(dir, 'codex'), '--opencode-db', path.join(dir, 'opencode.db'),
      '--pi-dir', path.join(dir, 'pi'), '--dsh-dir', path.join(dir, 'dsh'),
      '--meta-dir', path.join(dir, 'meta'), '--index-dir', path.join(dir, 'index'),
      '--cache-dir', path.join(dir, 'cache'),
    ];
    const port = await freePort();
    const child = spawn(binary, ['serve', '--port', String(port), ...args],
      { cwd: repo, windowsHide: true, stdio: 'ignore' });
    t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'close'); });
    const base = `http://127.0.0.1:${port}`;
    let status;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(`${base}/api/providers`);
        if (response.ok) { status = await response.json(); break; }
      } catch { /* Startup in progress. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(status?.find(item => item.id === provider)?.available, true);
    const bootstrapResponse = await fetch(`${base}/api/v3/reader/${provider}/${source.sessionId}/bootstrap`);
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = await bootstrapResponse.json();
    assert.ok(bootstrap.session.messageCount > 0);
    assert.equal(bootstrap.session.session.sessionId === source.sessionId, true);
    assert.ok(bootstrap.segments.flatMap(segment => segment.items).length > 0);
    const client = new Client({ name: 'claude-private-check', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: binary, args: ['mcp', ...args],
      cwd: repo, stderr: 'pipe' }));
    t.after(async () => { await client.close(); });
    const result = await client.callTool({ name: 'session_get', arguments: {
      session: { provider, sessionId: source.sessionId },
    } });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.result.messageCount, bootstrap.session.messageCount);
    assert.equal(digest(source.snapshotPath), source.snapshotSha256);
  });
