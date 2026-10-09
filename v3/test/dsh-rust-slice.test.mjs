import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const dshRoot = path.join(repo, 'v3', 'fixtures', 'deepseek-harness');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const provider = 'deepseek-harness';
const ids = { root: 'dsh-v3-s2-root', alpha: 'dsh-v3-s2-alpha', beta: 'dsh-v3-s2-beta' };
const ref = sessionId => ({ provider, sessionId });
const event = (sessionId, messageId, segment = 'message') => ({ ...ref(sessionId), messageId, segment });
const finalBody = 'Both synthetic reports are recorded. Alpha confirmed its ending marker; beta completed its independent check. The parent now has the returned facts. END-OF-SYNTHETIC-DSH-ROOT';
const sourceFiles = Object.values(ids).map(id => path.join(dshRoot, 'sessions', 's2-synthetic', id, 'session.v3.jsonl.zstd'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function freePort() {
  return freeFetchSafePort();
}

async function setup(t, selectedDshRoot = dshRoot) {
  assert.ok(existsSync(binary), `Build the S2 Rust binary at ${binary}`);
  const before = sourceFiles.map(file => sha256(readFileSync(file)));
  const dir = await mkdtemp(path.join(repo, 'tmp', 'v3-dsh-slice-'));
  t.after(async () => {
    try {
      assert.deepEqual(sourceFiles.map(file => sha256(readFileSync(file))), before,
        'The Rust process must leave public provider source bytes unchanged');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  for (const name of ['meta', 'index', 'cache', 'codex', 'claude', 'pi']) {
    await mkdir(path.join(dir, name));
  }
  return [
    '--codex-dir', path.join(dir, 'codex'),
    '--opencode-db', path.join(dir, 'opencode.db'),
    '--claude-dir', path.join(dir, 'claude'),
    '--pi-dir', path.join(dir, 'pi'),
    '--dsh-dir', selectedDshRoot,
    '--meta-dir', path.join(dir, 'meta'),
    '--index-dir', path.join(dir, 'index'),
    '--cache-dir', path.join(dir, 'cache'),
  ];
}

function captureStderr(child) {
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  return () => stderr;
}

async function awaitProviders(port, child, stderr) {
  const started = performance.now();
  const deadline = Date.now() + 15_000;
  let lastProbe = 'not attempted';
  const failure = reason => new Error(`${reason} after ${Math.round(performance.now() - started)}ms; ` +
    `exitCode=${child.exitCode}, signalCode=${child.signalCode}; last probe: ${lastProbe}; ` +
    `stderr: ${stderr().trim() || '(none)'}`);
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw failure('S2 Web binary exited before readiness');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/providers`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response.json();
      lastProbe = `HTTP ${response.status}`;
    } catch (error) {
      lastProbe = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw failure('S2 Web binary did not become ready');
}

async function json(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

async function readerItems(base, bootstrap) {
  const items = [...bootstrap.segments.flatMap(page => page.items)];
  let cursor = bootstrap.segments.at(-1)?.nextCursor;
  while (cursor) {
    const page = await json(`${base}/segments?cursor=${encodeURIComponent(cursor)}`);
    assert.equal(page.status, 200);
    assert.equal(page.body.revision, bootstrap.revision);
    items.push(...page.body.page.items);
    cursor = page.body.page.nextCursor;
    assert.ok(items.length < 100, 'Fixture Reader pagination must terminate');
  }
  return items;
}

async function readerRelations(base, bootstrap) {
  assert.equal(bootstrap.relations.taskCount, 4);
  assert.equal(bootstrap.relations.observationCount, 12);
  assert.ok(typeof bootstrap.relations.firstCursor === 'string' && bootstrap.relations.firstCursor);
  const entries = [];
  const seen = new Set();
  let cursor = bootstrap.relations.firstCursor;
  while (cursor) {
    assert.ok(!seen.has(cursor), 'Relation cursor must advance');
    seen.add(cursor);
    const response = await json(`${base}/relations?cursor=${encodeURIComponent(cursor)}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.session, ref(ids.root));
    assert.equal(response.body.revision, bootstrap.revision);
    assert.ok(response.body.entries.length > 0 && response.body.entries.length <= 32);
    entries.push(...response.body.entries);
    cursor = response.body.nextCursor;
    assert.ok(entries.length <= 16, 'This public fixture has exactly 16 relation rows');
  }
  assert.equal(entries.length, bootstrap.relations.taskCount + bootstrap.relations.observationCount);
  return entries;
}

async function webBody(base, bootstrap, messageId) {
  const parts = [];
  let offset = 0;
  for (;;) {
    const query = new URLSearchParams({ messageId, segment: 'message', field: 'body',
      offset: String(offset), maxChars: '13', revision: bootstrap.revision });
    const response = await json(`${base}/content?${query}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.offset, offset);
    assert.equal(response.body.totalChars, finalBody.length);
    parts.push(response.body.text);
    if (response.body.nextOffset === null) break;
    assert.ok(response.body.nextOffset > offset);
    offset = response.body.nextOffset;
    assert.ok(parts.length < 30, 'Final content pagination must terminate');
  }
  return parts.join('');
}

test('public DSH multi-frame sources reach Axum Reader with source-backed collaboration',
  { timeout: 30_000 }, async t => {
    const args = await setup(t);
    const port = await freePort();
    const child = spawn(binary, ['serve', '--port', String(port), ...args],
      { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr = captureStderr(child);
    t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'close'); });
    const providers = await awaitProviders(port, child, stderr);
    assert.equal(providers.find(row => row.id === provider)?.available, true,
      'DSH adapter must discover the public two-frame v3 sources');

    const origin = `http://127.0.0.1:${port}`;
    const sessions = await json(`${origin}/api/v3/sessions?provider=${provider}`);
    assert.equal(sessions.status, 200);
    assert.deepEqual(sessions.body.map(row => row.session.sessionId).sort(), Object.values(ids).sort());
    assert.deepEqual(sessions.body.find(row => row.session.sessionId === ids.root).parent, null);
    for (const id of [ids.alpha, ids.beta]) {
      assert.deepEqual(sessions.body.find(row => row.session.sessionId === id).parent, ref(ids.root));
    }

    const rootBase = `${origin}/api/v3/reader/${provider}/${ids.root}`;
    const opened = await json(`${rootBase}/bootstrap`);
    assert.equal(opened.status, 200);
    const bootstrap = opened.body;
    assert.deepEqual(bootstrap.session.session, ref(ids.root));
    assert.ok(bootstrap.revision);
    const items = await readerItems(rootBase, bootstrap);
    assert.deepEqual(items.map(item => item.event.messageId),
      ['root-user', 'root-dispatch', 'root-continues', 'root-check', 'root-final']);
    assert.deepEqual(items.map(item => item.event.sessionId), Array(5).fill(ids.root));
    assert.deepEqual(items.map(item => item.event.segment),
      ['message', 'message', 'message', 'tool', 'message']);
    assert.equal(items.find(item => item.event.messageId === 'root-check')?.ownerMessageId,
      'root-continues');
    const location = await json(`${rootBase}/locate?${new URLSearchParams({
      revision: bootstrap.revision, messageId: 'root-final', segment: 'message' })}`);
    assert.equal(location.status, 200);
    assert.deepEqual(location.body.event, event(ids.root, 'root-final'));
    assert.equal(await webBody(rootBase, bootstrap, 'root-final'), finalBody);

    for (const [id, answer] of [[ids.alpha, 'alpha-answer'], [ids.beta, 'beta-answer']]) {
      const childOpen = await json(`${origin}/api/v3/reader/${provider}/${id}/bootstrap`);
      assert.equal(childOpen.status, 200);
      assert.deepEqual(childOpen.body.session.parent, ref(ids.root));
      assert.deepEqual((await readerItems(`${origin}/api/v3/reader/${provider}/${id}`, childOpen.body))
        .map(item => item.event.messageId), [`${id === ids.alpha ? 'alpha' : 'beta'}-user`, answer]);
    }

    // Bounded Reader relations carry existing protocol task/observation facts.
    const relations = await readerRelations(rootBase, bootstrap);
    const tasks = relations.filter(entry => entry.type === 'task').map(entry => entry.task);
    const coordination = relations.filter(entry => entry.type === 'coordination')
      .map(entry => entry.observation);
    assert.equal(tasks.length, bootstrap.relations.taskCount);
    assert.equal(coordination.length, bootstrap.relations.observationCount);
    assert.deepEqual(tasks.filter(task => task.kind === 'team-task')
      .map(task => [task.id, task.status, task.owner, task.provenance.sourceId]).sort(), [
      ['team:alpha', 'completed', ids.alpha, '20'],
      ['team:beta', 'completed', ids.beta, '18'],
    ]);
    const alpha = { id: ids.alpha, kind: 'member', name: 'alpha', description: 'Synthetic alpha worker',
      provenance: { fidelity: 'recorded', sourceType: 'dsh.session-event:team/member', sourceId: '4' } };
    const beta = { id: ids.beta, kind: 'member', name: 'beta', description: 'Synthetic beta worker',
      provenance: { fidelity: 'recorded', sourceType: 'dsh.session-event:team/member', sourceId: '5' } };
    assert.deepEqual(tasks.find(task => task.id === 'team:alpha'), {
      id: 'team:alpha', kind: 'team-task', status: 'completed', owner: ids.alpha,
      subject: 'Inspect synthetic alpha',
      description: 'Read synthetic alpha input and report back',
      ownerParticipant: alpha, provenance: { fidelity: 'recorded',
        sourceType: 'dsh.session-event:team/task', sourceId: '20' },
    });
    assert.deepEqual(tasks.find(task => task.id === 'team:beta')?.ownerParticipant, beta);
    const observation = (kind, correlationId, state) => coordination.find(row =>
      row.kind === kind && row.correlationId === correlationId && row.state === state);
    const queuedAlpha = observation('message', 'mail-alpha-initial', 'requested');
    assert.equal(queuedAlpha.messageExcerpt, 'Inspect synthetic alpha.');
    assert.deepEqual(queuedAlpha.toParticipant, alpha);
    assert.equal(queuedAlpha.fromParticipant?.name, 'lead');
    assert.equal(queuedAlpha.fromParticipant?.kind, 'sender');
    assert.equal(queuedAlpha.fromParticipant?.provenance.sourceId, '8');
    assert.equal(queuedAlpha.messageExcerptTruncated, false);
    assert.equal(observation('mailbox-delivery', 'mail-alpha-initial', 'delivered').messageExcerpt,
      undefined, 'delivery records do not invent a second message body');
    const followup = observation('message', 'mail-alpha-followup', 'requested');
    assert.ok(followup.messageExcerpt.startsWith('Also check the alpha ending marker.'));
    assert.equal([...followup.messageExcerpt].length, 240);
    assert.equal(followup.messageExcerptTruncated, true);
    assert.doesNotMatch(followup.messageExcerpt, /FINAL-ALPHA-FOLLOWUP-MARKER/);
    const teamContent = (session, sequence, messageId, offset, maxChars = 80,
      revision = bootstrap.revision) => json(`${origin}/api/v3/reader/${provider}/${session}/team-message/content?${new URLSearchParams({
        sequence: String(sequence), messageId, offset: String(offset), maxChars: String(maxChars), revision,
      })}`);
    const teamParts = [];
    let teamOffset = 0;
    do {
      const page = await teamContent(ids.root, 15, 'mail-alpha-followup', teamOffset);
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.equal(page.body.offset, teamOffset);
      teamParts.push(page.body.text);
      teamOffset = page.body.nextOffset;
    } while (teamOffset !== null);
    assert.equal(teamParts.join(''), 'Also check the alpha ending marker. ' + 'alpha context '.repeat(10) + '\n\n'
      + 'Follow-up details '.repeat(5) + 'FINAL-ALPHA-FOLLOWUP-MARKER');
    assert.equal((await teamContent(ids.root, 16, 'mail-alpha-followup', 0)).status, 404);
    assert.equal((await teamContent(ids.root, 15, 'mail-beta-initial', 0)).status, 404);
    const stale = await teamContent(ids.root, 15, 'mail-alpha-followup', 0, 80, 'stale-revision');
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'source_changed');
    const alphaRevision = (await json(`${origin}/api/v3/reader/${provider}/${ids.alpha}/bootstrap`)).body.revision;
    assert.equal((await teamContent(ids.alpha, 15, 'mail-alpha-followup', 0, 80, alphaRevision)).status, 404);
    assert.equal(observation('message', 'mail-alpha-return', 'requested').messageExcerpt,
      'Alpha check complete; ending marker observed.');
    for (const [kind, correlationId, state, seq, from, to] of [
      ['message', 'mail-alpha-initial', 'requested', 8, ids.root, ids.alpha],
      ['message', 'mail-beta-initial', 'requested', 11, ids.root, ids.beta],
      ['message', 'mail-alpha-followup', 'requested', 15, ids.root, ids.alpha],
      ['mailbox-delivery', 'mail-alpha-followup', 'delivered', 16, ids.root, ids.alpha],
      ['message', 'mail-alpha-return', 'requested', 21, ids.alpha, ids.root],
      ['mailbox-delivery', 'mail-alpha-return', 'delivered', 22, ids.alpha, ids.root],
      ['spawn', 'parallel-inspection:1', 'started', 10, ids.root, ids.alpha],
      ['spawn', 'parallel-inspection:2', 'started', 13, ids.root, ids.beta],
      ['spawn', 'parallel-inspection:2', 'completed', 17, ids.root, ids.beta],
      ['spawn', 'parallel-inspection:1', 'completed', 19, ids.root, ids.alpha],
    ]) {
      const row = observation(kind, correlationId, state);
      assert.ok(row, `${kind} ${correlationId} ${state}`);
      assert.equal(row.eventId, `event:dsh:${seq}`);
      assert.deepEqual(row.fromSessionRef, ref(from));
      assert.deepEqual(row.toSessionRef, ref(to));
      assert.deepEqual(row.provenance, { fidelity: 'recorded',
        sourceType: `dsh.session-event:${kind === 'spawn' ? 'tool-workflow/agent-' + (state === 'started' ? 'start' : 'end') : kind === 'message' ? 'team/message/queued' : 'team/message/delivered'}`,
        sourceId: String(seq) });
    }
  });

async function mcpBody(client, sessionId, messageId) {
  const target = event(sessionId, messageId);
  const parts = [];
  let offset = 0;
  for (;;) {
    const response = await client.callTool({ name: 'session_get_event', arguments: {
      event: target, offset, maxChars: 13,
    } });
    assert.notEqual(response.isError, true, `${sessionId}/${messageId} must be readable`);
    const result = response.structuredContent.result;
    assert.deepEqual(result.event, target);
    assert.equal(result.content.offset, offset);
    parts.push(result.content.text);
    if (result.continuation === null) break;
    assert.deepEqual(result.continuation.event, target);
    assert.ok(result.continuation.offset > offset);
    offset = result.continuation.offset;
    assert.ok(parts.length < 30, 'MCP content pagination must terminate');
  }
  return parts.join('');
}

test('seeded DSH v3 keeps inherited Reader context separate from owned MCP history',
  { timeout: 30_000 }, async t => {
    const dshDir = await mkdtemp(path.join(repo, 'tmp', 'v3-dsh-seeded-'));
    const id = 'dsh-seeded-v3-public';
    const parentId = 'dsh-recorded-missing-parent';
    const sourceDirectory = path.join(dshDir, 'sessions', 'synthetic', id);
    await mkdir(sourceDirectory, { recursive: true });
    const sourceFile = path.join(sourceDirectory, 'session.v3.jsonl');
    const usage = (inputTokens, outputTokens) => ({ inputTokens, outputTokens,
      cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: inputTokens + outputTokens });
    const rows = [
      { type: 'session', version: 3, id, createdAt: 100, parentSession: parentId,
        isSeeded: true, delegationDepth: 1 },
      { type: 'user/message', seq: 0, time: 101, surfaceOp: 'append',
        data: { id: 'inherited-user', source: { kind: 'user' },
          content: [{ type: 'text', text: 'PREFIX_ONLY' }] } },
      { type: 'assistant/message', seq: 1, time: 102, surfaceOp: 'append',
        data: { turn: 1, step: 1, message: { id: 'inherited-assistant', role: 'assistant',
          source: { kind: 'model', provider: 'deepseek', model: 'synthetic' },
          content: [{ type: 'text', text: 'PREFIX_REPLY' }] }, usage: usage(100, 50) } },
      { type: 'tool/call', seq: 2, time: 103, data: { callId: 'inherited-tool-call', name: 'read',
        arguments: { path: 'inherited.txt' } } },
      { type: 'session/end-seed', seq: 3, time: 103, data: { inherited: true } },
      { type: 'user/message', seq: 4, time: 104, surfaceOp: 'append',
        data: { id: 'owned-user', source: { kind: 'user' },
          content: [{ type: 'text', text: 'OWNED_REQUEST' }] } },
      { type: 'assistant/message', seq: 5, time: 105, surfaceOp: 'append',
        data: { turn: 2, step: 1, message: { id: 'owned-assistant', role: 'assistant',
          source: { kind: 'model', provider: 'deepseek', model: 'synthetic' },
          content: [{ type: 'text', text: 'OWNED_ANSWER' }] }, usage: usage(5, 2) } },
      { type: 'tool/result', seq: 6, time: 106, surfaceOp: 'append',
        data: { message: { id: 'owned-tool-result', source: { callId: 'inherited-tool-call' },
          content: [{ type: 'tool-result', toolCallId: 'inherited-tool-call',
            content: [{ type: 'text', text: 'OWNED_TOOL_RESULT' }] }] } } },
    ];
    await writeFile(sourceFile, `${rows.map(JSON.stringify).join('\n')}\n`, 'utf8');
    const sourceHash = sha256(readFileSync(sourceFile));
    t.after(async () => {
      assert.equal(sha256(readFileSync(sourceFile)), sourceHash,
        'the synthetic DSH source remains byte-for-byte unchanged');
      await rm(dshDir, { recursive: true, force: true });
    });

    const args = await setup(t, dshDir);
    const port = await freePort();
    const server = spawn(binary, ['serve', '--port', String(port), ...args],
      { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr = captureStderr(server);
    t.after(async () => { server.kill(); if (server.exitCode === null) await once(server, 'close'); });
    await awaitProviders(port, server, stderr);
    const origin = `http://127.0.0.1:${port}`;
    const listed = await json(`${origin}/api/v3/sessions?provider=${provider}`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const session = listed.body.find(row => row.session.sessionId === id);
    assert.ok(session, 'the seeded v3 source is indexed');
    assert.deepEqual(session.parent, ref(parentId));
    assert.equal(session.messageCount, 3);
    assert.equal(session.tokenCount, 7, 'inherited request usage is not assigned to the child');

    const readerBase = `${origin}/api/v3/reader/${provider}/${id}`;
    const opened = await json(`${readerBase}/bootstrap`);
    assert.equal(opened.status, 200);
    assert.equal(opened.body.totalItems, 3);
    assert.equal(opened.body.toc.entries.length, 3);
    const ownItems = await readerItems(readerBase, opened.body);
    assert.deepEqual(ownItems.map(item => item.event.messageId),
      ['owned-user', 'owned-assistant', 'inherited-tool-call']);
    assert.equal(ownItems[2].role, 'tool',
      'a result recorded after the seed boundary belongs to owned Reader history');
    assert.doesNotMatch(JSON.stringify(opened.body), /PREFIX_ONLY|PREFIX_REPLY/);

    const toolOutput = await json(`${readerBase}/content?${new URLSearchParams({
      messageId: 'inherited-tool-call', segment: 'tool', field: 'toolOutput', offset: '0',
      maxChars: '2048', revision: opened.body.revision })}`);
    assert.equal(toolOutput.status, 200, JSON.stringify(toolOutput.body));
    assert.equal(toolOutput.body.text, 'OWNED_TOOL_RESULT');

    const inherited = await json(`${origin}/api/v3/reader/${provider}/${id}/inherited-context?limit=40`);
    assert.equal(inherited.status, 200);
    assert.deepEqual(inherited.body.sourceSession, ref(parentId));
    assert.equal(inherited.body.scope, 'inherited-context');
    assert.equal(inherited.body.totalItems, 3);
    assert.deepEqual(inherited.body.items.map(item => item.messageId),
      ['inherited-user', 'inherited-assistant', 'inherited-tool-call']);
    assert.deepEqual(inherited.body.items.map(item => item.role), ['user', 'assistant', 'tool']);

    const search = async query => json(`${readerBase}/search?${new URLSearchParams({
      q: query, revision: opened.body.revision, limit: '25' })}`);
    assert.deepEqual((await search('PREFIX_ONLY')).body.matches, []);
    assert.deepEqual((await search('PREFIX_REPLY')).body.matches, []);
    assert.deepEqual((await search('OWNED_REQUEST')).body.matches.map(hit => hit.event.messageId), ['owned-user']);
    assert.deepEqual((await search('OWNED_ANSWER')).body.matches.map(hit => hit.event.messageId), ['owned-assistant']);
    assert.deepEqual((await search('OWNED_TOOL_RESULT')).body.matches.map(hit => hit.event.messageId), ['inherited-tool-call']);

    const client = new Client({ name: 'agentsession-v3-dsh-seeded-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: binary, args: ['mcp', ...args],
      cwd: repo, stderr: 'pipe' });
    await client.connect(transport);
    t.after(async () => { await client.close(); });
    const overview = await client.callTool({ name: 'session_get', arguments: { session: ref(id) } });
    assert.notEqual(overview.isError, true);
    assert.equal(overview.structuredContent.result.messageCount, 3);
    assert.deepEqual(overview.structuredContent.result.parent, ref(parentId));
    assert.deepEqual(overview.structuredContent.result.firstMessage.event, event(id, 'owned-user'));
    assert.deepEqual(overview.structuredContent.result.lastMessage.event, event(id, 'owned-assistant'));
    const timeline = await client.callTool({ name: 'session_timeline', arguments: { session: ref(id) } });
    assert.notEqual(timeline.isError, true);
    assert.deepEqual(timeline.structuredContent.result.events.map(row => row.event.messageId),
      ['owned-user', 'owned-assistant', 'inherited-tool-call']);
    assert.doesNotMatch(JSON.stringify({ overview, timeline }), /PREFIX_ONLY|PREFIX_REPLY/);
  });

test('seeded DSH v3 exposes copied Reader context without a recorded parent identity',
  { timeout: 30_000 }, async t => {
    const dshDir = await mkdtemp(path.join(repo, 'tmp', 'v3-dsh-no-parent-'));
    const id = 'dsh-seeded-v3-no-parent';
    const unseededId = 'dsh-unseeded-v3-no-prefix';
    const sourceDirectory = path.join(dshDir, 'sessions', 'synthetic', id);
    const unseededDirectory = path.join(dshDir, 'sessions', 'synthetic', unseededId);
    await mkdir(sourceDirectory, { recursive: true });
    await mkdir(unseededDirectory, { recursive: true });
    const sourceFile = path.join(sourceDirectory, 'session.v3.jsonl');
    const unseededSourceFile = path.join(unseededDirectory, 'session.v3.jsonl');
    const rows = [
      { type: 'session', version: 3, id, createdAt: 100, isSeeded: true, delegationDepth: 1 },
      { type: 'user/message', seq: 0, time: 101, surfaceOp: 'append',
        data: { id: 'inherited-user', source: { kind: 'user' },
          content: [{ type: 'text', text: 'NO_PARENT_PREFIX' }] } },
      { type: 'session/end-seed', seq: 1, time: 102, data: { inherited: true } },
      { type: 'user/message', seq: 2, time: 103, surfaceOp: 'append',
        data: { id: 'owned-user', source: { kind: 'user' },
          content: [{ type: 'text', text: 'NO_PARENT_OWNED' }] } },
    ];
    await writeFile(sourceFile, `${rows.map(JSON.stringify).join('\n')}\n`, 'utf8');
    const unseededRows = [
      { type: 'session', version: 3, id: unseededId, createdAt: 200, isSeeded: false },
      { type: 'user/message', seq: 0, time: 201, surfaceOp: 'append',
        data: { id: 'unseeded-user', source: { kind: 'user' },
          content: [{ type: 'text', text: 'UNSEEDED_OWNED' }] } },
    ];
    await writeFile(unseededSourceFile, `${unseededRows.map(JSON.stringify).join('\n')}\n`, 'utf8');
    const sourceHashes = new Map([sourceFile, unseededSourceFile]
      .map(file => [file, sha256(readFileSync(file))]));
    t.after(async () => {
      for (const [file, sourceHash] of sourceHashes) {
        assert.equal(sha256(readFileSync(file)), sourceHash,
          'the synthetic DSH source remains byte-for-byte unchanged');
      }
      await rm(dshDir, { recursive: true, force: true });
    });

    const args = await setup(t, dshDir);
    const port = await freePort();
    const server = spawn(binary, ['serve', '--port', String(port), ...args],
      { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr = captureStderr(server);
    t.after(async () => { server.kill(); if (server.exitCode === null) await once(server, 'close'); });
    await awaitProviders(port, server, stderr);
    const origin = `http://127.0.0.1:${port}`;
    const listed = await json(`${origin}/api/v3/sessions?provider=${provider}`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const session = listed.body.find(row => row.session.sessionId === id);
    assert.ok(session, 'the seeded source remains indexed without a parent ID');
    assert.equal(session.parent, null);

    const readerBase = `${origin}/api/v3/reader/${provider}/${id}`;
    const opened = await json(`${readerBase}/bootstrap`);
    assert.equal(opened.status, 200);
    assert.equal(opened.body.session.parent, null);
    assert.equal(opened.body.totalItems, 1);
    assert.deepEqual((await readerItems(readerBase, opened.body))
      .map(item => item.event.messageId), ['owned-user']);
    const inherited = await json(`${readerBase}/inherited-context?limit=40`);
    assert.equal(inherited.status, 200, JSON.stringify(inherited.body));
    assert.equal(inherited.body.sourceSession, null,
      'the copied prefix is available without fabricating a source session');
    assert.deepEqual(inherited.body.items.map(item => item.messageId), ['inherited-user']);

    const unseeded = await fetch(`${origin}/api/v3/reader/${provider}/${unseededId}/inherited-context?limit=40`);
    assert.equal(unseeded.status, 204,
      'absence of a copied prefix is explicit so the Reader can omit the disclosure');
    assert.equal(await unseeded.text(), '');
  });

for (const era of ['legacy', 'modern']) {
  test(`public DSH multi-frame sources reach ${era} native stdio MCP`, { timeout: 30_000 }, async t => {
    const args = await setup(t);
    const client = new Client({ name: 'agentsession-v3-dsh-s2-test', version: '1.0.0' },
      era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
    const transport = new StdioClientTransport({ command: binary, args: ['mcp', ...args],
      cwd: repo, stderr: 'pipe' });
    await client.connect(transport);
    t.after(async () => { await client.close(); });
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 7);
    assert.deepEqual(tools.tools.slice(0, 6).map(tool => tool.name), [
      'session_browse', 'session_search', 'session_get', 'session_timeline', 'session_get_context', 'session_get_event',
    ]);
    assert.equal(await mcpBody(client, ids.root, 'root-final'), finalBody);
    for (const [id, marker] of [[ids.alpha, 'ALPHA-END'], [ids.beta, 'BETA-END']]) {
      assert.match(await mcpBody(client, id, id === ids.alpha ? 'alpha-answer' : 'beta-answer'),
        new RegExp(`${marker}\\.$`));
    }
    const overview = await client.callTool({ name: 'session_get', arguments: { session: ref(ids.root) } });
    assert.notEqual(overview.isError, true);
    assert.deepEqual(overview.structuredContent.result.children.map(row => row.session.sessionId).sort(),
      [ids.alpha, ids.beta].sort());
    const timeline = await client.callTool({ name: 'session_timeline', arguments: { session: ref(ids.root) } });
    assert.notEqual(timeline.isError, true);
    assert.deepEqual(timeline.structuredContent.result.events.map(row => row.event.messageId),
      ['root-user', 'root-dispatch', 'root-continues', 'root-check', 'root-final']);
  });
}
