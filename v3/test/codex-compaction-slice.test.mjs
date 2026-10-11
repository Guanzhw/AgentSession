import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const id = '55555555-5555-4555-8555-555555555555';
const fixtureRoot = path.join(repo, 'v3', 'fixtures', 'codex-compaction');
const fixture = path.join(fixtureRoot, 'sessions', '2026', '09', '26',
  `rollout-2026-09-26T00-00-00-${id}.jsonl`);
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
function agentBrowserBinary() {
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
const browser = agentBrowserBinary();
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');

async function freePort() {
  return freeFetchSafePort();
}

async function serve(t) {
  assert.ok(existsSync(binary), `Build ${binary} before this test`);
  await mkdir(path.join(repo, 'tmp'), { recursive: true });
  const work = await mkdtemp(path.join(repo, 'tmp', 'v3-codex-compaction-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  for (const name of ['meta', 'index', 'cache', 'claude', 'pi', 'dsh'])
    await mkdir(path.join(work, name));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const args = ['serve', '--port', String(port), '--codex-dir', fixtureRoot,
    '--opencode-db', path.join(work, 'opencode.db'), '--claude-dir', path.join(work, 'claude'),
    '--pi-dir', path.join(work, 'pi'), '--dsh-dir', path.join(work, 'dsh'),
    '--meta-dir', path.join(work, 'meta'), '--index-dir', path.join(work, 'index'),
    '--cache-dir', path.join(work, 'cache')];
  const child = spawn(binary, args, { cwd: repo, windowsHide: true, stdio: 'ignore' });
  t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'close'); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Axum exited before readiness');
    try { if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok) return base; }
    catch { /* Startup is in progress. */ }
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

test('Axum exposes one Codex compaction checkpoint with bounded recorded content and exact source anchor',
  { timeout: 60_000 }, async t => {
    const before = sha(fixture);
    const base = await serve(t);
    const prefix = `${base}/api/v3/reader/codex/${id}`;
    const bootstrap = await (await fetch(`${prefix}/bootstrap`)).json();
    const checkpoints = bootstrap.toc.entries.filter(entry => entry.event.segment === 'context');
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].ordinal, 2);
    assert.equal(checkpoints[0].event.messageId, 'compaction-3');
    const checkpoint = bootstrap.segments[0].items.find(item => item.event.segment === 'context');
    assert.equal(checkpoint.role, 'context');
    const events = await (await fetch(`${base}/api/v3/runtime/codex/${id}/events?category=context`)).json();
    const compact = events.events.find(event => event.kind === 'context.compaction');
    assert.equal(compact.sourceOrder.record, 3);
    assert.deepEqual(compact.readerEvent, checkpoints[0].event);
    const location = await (await fetch(`${prefix}/locate?${new URLSearchParams({
      revision: bootstrap.revision, messageId: compact.readerEvent.messageId, segment: 'context',
    })}`)).json();
    assert.equal(location.ordinal, 2);
    let text = ''; let offset = 0;
    while (true) {
      const page = await (await fetch(`${prefix}/content?${new URLSearchParams({
        revision: bootstrap.revision, messageId: 'compaction-3', segment: 'context',
        field: 'body', offset: String(offset), maxChars: '37',
      })}`)).json();
      text += page.text;
      if (page.nextOffset === null) break;
      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
    }
    assert.match(text, /Recorded summary ends\./);
    assert.match(text, /First retained request\./);
    assert.match(text, /Last retained answer\./);
    assert.doesNotMatch(text, /secret-ciphertext/);
    assert.equal(sha(fixture), before);
  });

test('browser Runtime compact source returns through its filtered Events view and Reader anchor',
  { skip: !browser ? 'agent-browser executable unavailable' : false, timeout: 90_000 }, async t => {
    const base = await serve(t);
    const session = `v3-codex-compact-${process.pid}-${Date.now()}`;
    t.after(async () => { try { await command(session, 'close'); } catch { /* Already closed. */ } });
    await command(session, 'open', `${base}/codex/session/${id}`);
    await until(session, `document.querySelectorAll('.reader-outline a').length > 0`);
    await command(session, 'eval', `document.querySelectorAll('.outline-turn-toggle[aria-expanded="false"]').forEach(button => button.click())`);
    assert.match(await command(session, 'get', 'text', '.reader-outline'), /Context checkpoint/);
    await command(session, 'click', '.reader-outline a:first-child');
    await until(session, `location.hash.startsWith('#event?')`);
    const priorHash = new URL(await command(session, 'get', 'url')).hash;
    await command(session, 'click', 'button.runtime-tab');
    await until(session, `document.querySelectorAll('.runtime-event').length > 0`);
    await command(session, 'fill', '.runtime-category', 'context');
    await command(session, 'click', '.runtime-filters button');
    await until(session, `document.querySelector('.runtime-event strong')?.textContent === 'context.compaction'`);
    const runtimeHash = new URL(await command(session, 'get', 'url')).hash;
    assert.match(runtimeHash, /^#runtime\?/);
    await command(session, 'click', '.runtime-event a');
    await until(session, `document.querySelector('.transcript') && location.hash.includes('compaction-3')`);
    assert.match(await command(session, 'get', 'text', '.event-card[id*="636f6d70616374696f6e2d33"]'), /Recorded compaction summary/);
    await command(session, 'eval', 'history.back()');
    await until(session, `location.hash === ${JSON.stringify(runtimeHash)} &&
      document.querySelector('.runtime-category')?.value === 'context' &&
      document.querySelector('.runtime-event strong')?.textContent === 'context.compaction'`);
    await command(session, 'eval', 'history.back()');
    await until(session, `location.hash === ${JSON.stringify(priorHash)} && document.querySelector('.transcript')`);
    await command(session, 'eval', 'history.forward()');
    await until(session, `location.hash === ${JSON.stringify(runtimeHash)} &&
      document.querySelector('.runtime-category')?.value === 'context'`);
  });
