import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { decodeSourceBytes } from '../../scripts/v3-source-ledger.mjs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const fixtureRoot = path.join(repo, 'v3', 'fixtures', 'deepseek-harness-compaction');
const frozenRoot = path.join(repo, 'tmp', 'v3-corpus', 'deepseek-harness');
const frozenId = 'session-a9f5b448-9851-4872-a266-fdc3381a5061';
const frozenFile = path.join(frozenRoot, 'sessions', '--D-WorkSpace-OpenSession--', frozenId,
  'session.v3.jsonl.zstd');
const id = 'dsh-v3-compact';
const missingId = 'dsh-v3-no-summary';
const provider = 'deepseek-harness';
const fixture = name => path.join(fixtureRoot, 'sessions', 'public', name, 'session.v3.jsonl');
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
function browserBinary() {
  const override = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN;
  if (override && existsSync(override)) return override;
  const name = process.platform === 'win32' ? 'agent-browser-win32-x64.exe'
    : `agent-browser-${process.platform}-${process.arch}`;
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(entry, 'node_modules', 'agent-browser', 'bin', name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
const browser = browserBinary();

async function freePort() {
  return freeFetchSafePort();
}

async function setup(t) {
  assert.ok(existsSync(binary), `Build ${binary} before this test`);
  await mkdir(path.join(repo, 'tmp'), { recursive: true });
  const work = await mkdtemp(path.join(repo, 'tmp', 'v3-dsh-compact-'));
  const fixtureHashes = [id, missingId].map(name => sha(fixture(name)));
  const shutdown = [];
  let copiedSource;
  let copiedHash;
  t.after(async () => {
    try {
      for (const close of shutdown.reverse()) await close();
      if (copiedSource) assert.equal(sha(copiedSource), copiedHash,
        'Web and MCP leave the copied DSH source unchanged');
      assert.deepEqual([id, missingId].map(name => sha(fixture(name))), fixtureHashes,
        'The public DSH source bytes remain unchanged');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
  for (const name of ['meta', 'index', 'cache', 'codex', 'claude', 'pi'])
    await mkdir(path.join(work, name));
  const dsh = path.join(work, 'dsh');
  await cp(fixtureRoot, dsh, { recursive: true });
  const source = path.join(dsh, 'sessions', 'public', id, 'session.v3.jsonl');
  const rows = readFileSync(source, 'utf8').trimEnd().split('\n').map(JSON.parse);
  const summary = `Recorded DSH summary. ${'A preserved source fact. '.repeat(150)}END-OF-LONG-SUMMARY.`;
  rows[3].data.summary = [{ type: 'text', text: summary }];
  await writeFile(source, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  copiedSource = source;
  copiedHash = sha(source);
  const args = [
    '--codex-dir', path.join(work, 'codex'), '--opencode-db', path.join(work, 'opencode.db'),
    '--claude-dir', path.join(work, 'claude'), '--pi-dir', path.join(work, 'pi'),
    '--dsh-dir', dsh, '--meta-dir', path.join(work, 'meta'),
    '--index-dir', path.join(work, 'index'), '--cache-dir', path.join(work, 'cache'),
  ];
  return { work, args, summary, defer: close => shutdown.push(close) };
}

async function serve(args, defer) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(binary, ['serve', '--port', String(port), ...args],
    { cwd: repo, windowsHide: true, stdio: 'ignore' });
  defer(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Axum did not close before source verification')), 5000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Axum exited before readiness');
    try { if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok) return base; }
    catch { /* Startup in progress. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Axum did not start');
}

async function command(session, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(browser, ['--session', session, ...args], { cwd: repo, windowsHide: true });
    let output = ''; let error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output.trim())
      : reject(new Error(`agent-browser ${args[0]}: ${error || output}`)));
  });
}

async function until(session, expression) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await command(session, 'eval', `Boolean(${expression})`)).includes('true')) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Browser state did not appear: ${expression}`);
}

test('DSH summary is one canonical context event with Reader, content, and MCP continuation',
  { timeout: 60_000 }, async t => {
    const { args, summary, defer } = await setup(t);
    const base = await serve(args, defer);
    const prefix = `${base}/api/v3/reader/${provider}/${id}`;
    const bootstrap = await (await fetch(`${prefix}/bootstrap`)).json();
    assert.equal(bootstrap.session.messageCount, 2);
    const checkpoints = bootstrap.toc.entries.filter(entry => entry.event.segment === 'context');
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].ordinal, 1);
    const ref = { provider, sessionId: id, messageId: 'compaction:2', segment: 'context' };
    assert.deepEqual(checkpoints[0].event, ref);
    assert.deepEqual(bootstrap.segments[0].items.map(item => item.event.messageId),
      ['before', 'compaction:2', 'after']);
    const events = await (await fetch(`${base}/api/v3/runtime/${provider}/${id}/events?category=context`)).json();
    assert.deepEqual(events.events.map(event => [event.kind, event.readerEvent?.messageId ?? null]), [
      ['compaction.start', null], ['context.compaction', 'compaction:2'], ['compaction.end', null],
    ]);
    assert.equal(events.events[1].sourceOrder.record, 3);
    assert.deepEqual(events.events[1].readerEvent, ref);
    assert.deepEqual(events.events[1].provenance, {
      fidelity: 'recorded', sourceType: 'dsh.session-event:compaction/summary', sourceId: '2',
    });
    const location = await (await fetch(`${prefix}/locate?${new URLSearchParams({
      revision: bootstrap.revision, messageId: ref.messageId, segment: ref.segment,
    })}`)).json();
    assert.equal(location.ordinal, 1);
    let full = ''; let offset = 0;
    while (true) {
      const page = await (await fetch(`${prefix}/content?${new URLSearchParams({
        revision: bootstrap.revision, messageId: ref.messageId, segment: ref.segment,
        field: 'body', offset: String(offset), maxChars: '97',
      })}`)).json();
      full += page.text;
      if (page.nextOffset === null) break;
      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
    }
    assert.equal(full, summary);
    const context = await (await fetch(`${base}/api/v3/runtime/${provider}/${id}/context`)).json();
    assert.deepEqual(context.entries.map(entry => entry.type), ['contextResult', 'contextObservation']);
    const result = context.entries[0].fact;
    assert.equal(result.version.sequence, 4);
    assert.deepEqual(result.version.readerEvent, ref);
    assert.deepEqual(result.transformation.shadowedRange, { start: 0, end: 0 });
    assert.deepEqual(result.transformation.shadowedSeqs, [0]);
    assert.equal(result.transformation.shadowedTokenCount, 123);
    assert.deepEqual(result.transformation.sourceVersionIds, []);
    assert.deepEqual(result.version.parentVersionIds, []);
    assert.equal(context.entries[1].fact.summaryAvailable, true);
    assert.deepEqual(context.entries[1].fact.readerEvent, ref,
      'Runtime Context links directly to the recorded Reader summary');
    const v2 = await (await fetch(`${base}/api/v3/protocol/${provider}/${id}?version=2`)).json();
    const v3 = await (await fetch(`${base}/api/v3/protocol/${provider}/${id}?version=3`)).json();
    assert.equal(v2.validation.ok, true);
    assert.equal(v3.validation.ok, true);
    assert.deepEqual(v3.events, v2.events);
    assert.deepEqual(v3.contextTransformations[0], result.transformation);
    assert.deepEqual(v3.contextVersions[0], result.version);
    assert.equal(context.entries[1].fact.windowId, null);

    const missing = await (await fetch(`${base}/api/v3/reader/${provider}/${missingId}/bootstrap`)).json();
    assert.equal(missing.toc.entries.filter(entry => entry.event.segment === 'context').length, 0);
    const missingEvents = await (await fetch(`${base}/api/v3/runtime/${provider}/${missingId}/events?category=context`)).json();
    assert.equal(missingEvents.events.filter(event => event.readerEvent).length, 0);

    const client = new Client({ name: 'dsh-compaction-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: binary, args: ['mcp', ...args],
      cwd: repo, stderr: 'pipe' }));
    defer(async () => { await client.close(); });
    const timeline = await client.callTool({ name: 'session_timeline', arguments: {
      session: { provider, sessionId: id }, segments: ['context'],
    } });
    assert.notEqual(timeline.isError, true);
    assert.deepEqual(timeline.structuredContent.result.events.map(row => row.event), [ref]);
    let mcpText = ''; offset = 0;
    while (true) {
      const response = await client.callTool({ name: 'session_get_event', arguments: {
        event: ref, offset, maxChars: 97,
      } });
      assert.notEqual(response.isError, true);
      const page = response.structuredContent.result.content;
      mcpText += page.text;
      if (page.nextOffset === null) break;
      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
    }
    assert.equal(mcpText, summary);
  });

test('seeded DSH child continues a full inherited compaction summary without owning it',
  { timeout: 60_000 }, async t => {
    const { work, args, defer } = await setup(t);
    const childId = 'dsh-v3-seeded-compact';
    const inheritedSummary = `Retained 🙂 context. ${'Source-owned detail 🙂 '.repeat(160)}END-INHERITED.`;
    const rows = readFileSync(fixture(id), 'utf8').trimEnd().split('\n').map(JSON.parse);
    rows[0] = { ...rows[0], id: childId, isSeeded: true,
      parentSession: 'recorded-missing-parent', delegationDepth: 1 };
    rows[3].data.summary = [{ type: 'text', text: inheritedSummary }];
    rows[5].seq = 5;
    rows.splice(5, 0, { type: 'session/end-seed', seq: 4, time: 1780000000004,
      data: { inherited: true } });
    const source = path.join(work, 'dsh', 'sessions', 'public', childId, 'session.v3.jsonl');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
    const sourceHash = sha(source);
    defer(async () => assert.equal(sha(source), sourceHash, 'seeded source remains unchanged'));

    const base = await serve(args, defer);
    const prefix = `${base}/api/v3/reader/${provider}/${childId}`;
    const owned = await (await fetch(`${prefix}/bootstrap`)).json();
    assert.deepEqual(owned.segments.flatMap(page => page.items).map(item => item.event.messageId),
      ['after'], 'the inherited summary stays outside owned Reader history');
    const inheritedResponse = await fetch(`${prefix}/inherited-context?limit=40`);
    assert.equal(inheritedResponse.status, 200);
    const inherited = await inheritedResponse.json();
    const checkpoints = inherited.items.filter(item => item.segment === 'context');
    assert.equal(checkpoints.length, 1);
    const checkpoint = checkpoints[0];
    assert.equal(checkpoint.messageId, 'compaction:2');
    assert.equal(checkpoint.totalChars, inheritedSummary.length);
    let text = '';
    let offset = 0;
    do {
      const response = await fetch(`${prefix}/inherited-context/content?${new URLSearchParams({
        revision: inherited.revision, ordinal: String(checkpoint.ordinal),
        messageId: checkpoint.messageId, segment: checkpoint.segment, field: 'body',
        offset: String(offset), maxChars: '97',
      })}`);
      const page = await response.json();
      assert.equal(response.status, 200, JSON.stringify(page));
      assert.equal(page.offset, offset);
      text += page.text;
      offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(text, inheritedSummary);
  });

test('DSH context outline opens the summary at its source position',
  { skip: !browser ? 'agent-browser executable unavailable' : false, timeout: 90_000 }, async t => {
    const { args, defer } = await setup(t);
    const base = await serve(args, defer);
    const session = `v3-dsh-compact-${process.pid}-${Date.now()}`;
    defer(async () => { try { await command(session, 'close'); } catch { /* Already closed. */ } });
    await command(session, 'open', `${base}/${provider}/session/${id}`);
    await until(session, `document.querySelector('.reader-outline a')`);
    await command(session, 'eval', `document.querySelectorAll('.outline-turn-toggle[aria-expanded="false"]').forEach(button => button.click())`);
    await until(session, `document.querySelector('.reader-outline a[href*="compaction%3A2"]')`);
    const outline = '.reader-outline a[href*="compaction%3A2"]';
    assert.match(await command(session, 'get', 'text', outline), /Context checkpoint/);
    await command(session, 'click', outline);
    await until(session, `location.hash.includes('compaction%3A2') && document.querySelector('.event-card[id*="636f6d70616374696f6e3a32"]')`);
    assert.match(await command(session, 'get', 'text', '.event-card[id*="636f6d70616374696f6e3a32"]'),
      /Recorded DSH summary/);
    await command(session, 'click', 'button.runtime-tab');
    await command(session, 'click', '.runtime-lens-context');
    await until(session, `document.querySelector('.runtime-domain-context .runtime-domain-entry')`);
    const contextLink = '.runtime-domain-context .runtime-domain-entry a[href^="#event?"]';
    assert.equal(Number(await command(session, 'get', 'count', contextLink)), 2);
    assert.match(await command(session, 'get', 'text', '.runtime-domain-context'),
      /Recorded shadowed range 0–0.*123 recorded shadowed tokens/s);
    await command(session, 'click', contextLink);
    await until(session, `location.hash.includes('compaction%3A2') && document.querySelector('.event-card[id*="636f6d70616374696f6e3a32"]')`);
    assert.match(await command(session, 'get', 'text', '.event-card[id*="636f6d70616374696f6e3a32"]'),
      /Recorded DSH summary/);
    assert.equal((await command(session, 'errors')).trim(), '');
  });

test('frozen DSH compaction rows retain three exact Web Reader anchors and bounded content',
  { skip: !existsSync(frozenFile), timeout: 60_000 }, async t => {
    const sourceHash = sha(frozenFile);
    await mkdir(path.join(repo, 'tmp'), { recursive: true });
    const work = await mkdtemp(path.join(repo, 'tmp', 'v3-dsh-real-compact-'));
    const shutdown = [];
    t.after(async () => {
      try {
        for (const close of shutdown.reverse()) await close();
        assert.equal(sha(frozenFile), sourceHash, 'The frozen provider source remains byte-identical');
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    });
    for (const name of ['meta', 'index', 'cache', 'codex', 'claude', 'pi'])
      await mkdir(path.join(work, name));
    const args = [
      '--codex-dir', path.join(work, 'codex'), '--opencode-db', path.join(work, 'opencode.db'),
      '--claude-dir', path.join(work, 'claude'), '--pi-dir', path.join(work, 'pi'),
      '--dsh-dir', frozenRoot, '--meta-dir', path.join(work, 'meta'),
      '--index-dir', path.join(work, 'index'), '--cache-dir', path.join(work, 'cache'),
    ];
    const base = await serve(args, close => shutdown.push(close));
    const prefix = `${base}/api/v3/reader/${provider}/${frozenId}`;
    const bootstrap = await (await fetch(`${prefix}/bootstrap`)).json();
    const contextEvents = [];
    let cursor;
    do {
      const query = new URLSearchParams({ category: 'context', limit: '200',
        ...(cursor ? { cursor } : {}) });
      const response = await fetch(`${base}/api/v3/runtime/${provider}/${frozenId}/events?${query}`);
      assert.equal(response.status, 200);
      const page = await response.json();
      contextEvents.push(...page.events);
      cursor = page.nextCursor;
    } while (cursor);
    const summaries = contextEvents.filter(event => event.kind === 'context.compaction');
    assert.deepEqual(summaries.map(event => event.provenance.sourceId), ['1373', '2226', '2503']);
    const sourceFacts = decodeSourceBytes(readFileSync(frozenFile)).records
      .map(({ value }) => value).filter(row => row.type === 'compaction/summary');
    const context = await (await fetch(`${base}/api/v3/runtime/${provider}/${frozenId}/context`)).json();
    assert.equal(context.entries.filter(entry => entry.type === 'contextResult').length, sourceFacts.length);
    for (const row of sourceFacts) {
      const entry = context.entries.find(entry => entry.type === 'contextResult'
        && entry.fact.transformation.provenance.sourceId === String(row.seq));
      assert.ok(entry, `Recorded compaction ${row.seq} must have a Context result`);
      assert.deepEqual(entry.fact.transformation.shadowedRange, row.data.shadowedRange);
      assert.deepEqual(entry.fact.transformation.shadowedSeqs, row.data.shadowedSeqs);
      assert.equal(entry.fact.transformation.shadowedTokenCount, row.data.shadowedTokenCount);
    }
    for (const event of summaries) {
      const ref = event.readerEvent;
      assert.equal(ref.segment, 'context');
      assert.equal(ref.messageId, `compaction:${event.provenance.sourceId}`);
      const location = await (await fetch(`${prefix}/locate?${new URLSearchParams({
        revision: bootstrap.revision, messageId: ref.messageId, segment: ref.segment,
      })}`)).json();
      assert.ok(Number.isInteger(location.ordinal));
      let offset = 0; let text = '';
      while (true) {
        const page = await (await fetch(`${prefix}/content?${new URLSearchParams({
          revision: bootstrap.revision, messageId: ref.messageId, segment: ref.segment,
          field: 'body', offset: String(offset), maxChars: '512',
        })}`)).json();
        text += page.text;
        if (page.nextOffset === null) {
          assert.equal(text.length, page.totalChars);
          break;
        }
        assert.ok(page.nextOffset > offset);
        offset = page.nextOffset;
      }
    }
  });
