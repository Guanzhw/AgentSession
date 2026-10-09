import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const sessionId = '44444444-4444-4444-8444-444444444444';
const original = path.join(repo, 'v3', 'fixtures', 'codex', 'sessions', '2026', '09', '26',
  `rollout-2026-09-26T00-00-00-${sessionId}.jsonl`);
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
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
async function freePort() {
  return freeFetchSafePort();
}
async function browserCommand(name, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(browser, ['--session', name, ...args], { cwd: repo, windowsHide: true });
    let output = '';
    let error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`agent-browser ${args.join(' ')} timed out`)); }, 15_000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.once('error', cause => { clearTimeout(timer); reject(cause); });
    child.once('exit', code => {
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      if (code !== 0) reject(new Error(`agent-browser ${args.join(' ')}: ${error || output}`));
      else resolve(output.trim());
    });
  });
}
async function waitFor(name, expression, label) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await browserCommand(name, 'eval', `Boolean(${expression})`)).includes('true')) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function waitForText(name, selector, expected) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await browserCommand(name, 'get', 'text', selector)) === expected) return; }
    catch { /* The next state is still rendering. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

test('real Axum Work view shows observed runs and exact evidence with revision-safe paging',
  { skip: !existsSync(binary) || !browser ? 'Build the v3 binary and install agent-browser' : false, timeout: 90_000 },
  async t => {
    const originalHash = sha256(original);
    const work = await mkdtemp(path.join(os.tmpdir(), 'v3-ui-work-'));
    t.after(() => rm(work, { recursive: true, force: true }));
    const sourceRoot = path.join(work, 'codex');
    const source = path.join(sourceRoot, 'sessions', '2026', '09', '26', path.basename(original));
    await mkdir(path.dirname(source), { recursive: true });
    for (const name of ['meta', 'index', 'cache', 'claude', 'pi']) await mkdir(path.join(work, name));
    const lifecycle = (type, turnId, startedAt, completedAt, error) => JSON.stringify({
      type: 'event_msg', payload: { type, turn_id: turnId, started_at: startedAt,
        ...(completedAt === undefined ? {} : { completed_at: completedAt }),
        ...(error ? { error: { message: 'recorded failure' } } : {}) },
    });
    await writeFile(source, readFileSync(original, 'utf8').trimEnd() + '\n' + [
      lifecycle('task_started', 'finished', 1000), lifecycle('task_complete', 'finished', 1000, 2000),
      lifecycle('task_started', 'failed', 3000), lifecycle('task_complete', 'failed', 3000, 4000, true),
    ].join('\n') + '\n');
    const sourceHash = sha256(source);
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(binary, ['serve', '--port', String(port), '--codex-dir', sourceRoot,
      '--opencode-db', path.join(work, 'opencode.db'), '--claude-dir', path.join(work, 'claude'),
      '--pi-dir', path.join(work, 'pi'), '--dsh-dir', path.join(work, 'missing-dsh'),
      '--meta-dir', path.join(work, 'meta'), '--index-dir', path.join(work, 'index'),
      '--cache-dir', path.join(work, 'cache')], { cwd: repo, windowsHide: true, stdio: 'ignore' });
    t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'close'); });
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok) break; }
      catch { /* Axum is starting. */ }
      if (attempt === 99) throw new Error('Axum did not start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const first = await (await fetch(`${base}/api/v3/runtime/codex/${sessionId}/work?limit=1`)).json();
    assert.equal(first.coverage, 'partial');
    assert.ok(first.nextCursor);
    const name = `v3-work-${process.pid}-${Date.now()}`;
    t.after(async () => { try { await browserCommand(name, 'close'); } catch { /* Already closed. */ } });
    await browserCommand(name, 'open', `${base}/codex/session/${sessionId}`);
    await waitFor(name, `document.querySelector('#reader-title')`, 'Reader');
    await browserCommand(name, 'click', 'button.runtime-tab');
    await browserCommand(name, 'click', '.runtime-lenses button:nth-child(2)');
    await waitFor(name, `document.querySelectorAll('.runtime-work-entry').length >= 2`, 'Work entries');
    assert.match(await browserCommand(name, 'get', 'text', '.runtime-work'), /Work coverage: observed/i);
    assert.match(await browserCommand(name, 'get', 'text', '.runtime-work'), /completed/i);
    assert.match(await browserCommand(name, 'get', 'text', '.runtime-work'), /failed/i);
    assert.match(await browserCommand(name, 'get', 'text', '.runtime-work'), /Provenance: recorded/i);
    assert.equal(Number(await browserCommand(name, 'get', 'count', '.runtime-work-entry > a')), 0,
      'lifecycle facts without Reader references cannot offer a conversation jump');
    await browserCommand(name, 'click', '.runtime-evidence-links a');
    await waitFor(name, `document.querySelector('.runtime-evidence-detail')`, 'exact evidence detail');
    assert.match(await browserCommand(name, 'get', 'text', '.runtime-evidence-detail'), /Recorded event/);
    await browserCommand(name, 'fill', '.runtime-work-status', 'failed');
    await browserCommand(name, 'click', '.runtime-work .runtime-filters button');
    await waitFor(name, `document.querySelectorAll('.runtime-work-entry').length >= 1 && !document.querySelector('.runtime-work-entry')?.textContent.includes('completed')`, 'failed filter');
    assert.match(await browserCommand(name, 'get', 'text', '.runtime-work-entry'), /failed/);

    await browserCommand(name, 'eval', 'window.__realFetch = window.fetch.bind(window)');
    await browserCommand(name, 'eval',
      `window.fetch=(input,init)=>String(input).includes('/work?') ? new Response(JSON.stringify({error:{code:'invalid_cursor',message:'stale cursor'}}),{status:400,headers:{'content-type':'application/json'}}) : window.__realFetch(input,init)`);
    await browserCommand(name, 'click', '.runtime-work .runtime-filters button');
    await waitForText(name, '.runtime-work .runtime-state strong', 'Work request failed');
    assert.equal(await browserCommand(name, 'get', 'text', '.runtime-work .runtime-state strong'), 'Work request failed');
    assert.equal(await browserCommand(name, 'get', 'text', '.runtime-work .runtime-coverage strong'), 'Work coverage unavailable');
    const empty = { ...first, entries: [], nextCursor: 'stale-next', scannedEntries: 3 };
    await browserCommand(name, 'eval',
      `window.fetch=(input,init)=>String(input).includes('/work?') ?
        (String(input).includes('cursor=') ? new Response(JSON.stringify({error:{code:'invalid_cursor',message:'stale cursor'}}),{status:400,headers:{'content-type':'application/json'}}) :
        new Response(${JSON.stringify(JSON.stringify(empty))},{status:200,headers:{'content-type':'application/json'}})) : window.__realFetch(input,init)`);
    await browserCommand(name, 'click', '.runtime-work .runtime-filters button');
    await waitForText(name, '.runtime-work .runtime-state strong', 'No matching work on this page');
    assert.equal(await browserCommand(name, 'get', 'text', '.runtime-work .runtime-state strong'), 'No matching work on this page');
    await browserCommand(name, 'click', '.runtime-work .runtime-pagination button');
    await waitForText(name, '.runtime-work .runtime-state strong', 'Work cursor is stale or invalid');
    assert.equal(await browserCommand(name, 'get', 'text', '.runtime-work .runtime-state strong'), 'Work cursor is stale or invalid');
    assert.equal(await browserCommand(name, 'get', 'text', '.runtime-work .runtime-coverage strong'), 'Work coverage unavailable');
    await browserCommand(name, 'eval',
      `window.fetch=(input,init)=>String(input).includes('/work?') ? new Response(${JSON.stringify(JSON.stringify({ ...first, revision: 'stale' }))},{status:200,headers:{'content-type':'application/json'}}) : window.__realFetch(input,init)`);
    await browserCommand(name, 'click', '.runtime-work .runtime-filters button');
    await waitForText(name, '.runtime-work .runtime-state strong', 'Source revision changed');
    assert.equal(await browserCommand(name, 'get', 'text', '.runtime-work .runtime-state strong'), 'Source revision changed');
    assert.equal(await browserCommand(name, 'get', 'text', '.runtime-work .runtime-coverage strong'), 'Work coverage unavailable');
    assert.equal(Number(await browserCommand(name, 'get', 'count', '.runtime-work-entry a')), 0);
    assert.equal(sha256(source), sourceHash);
    assert.equal(sha256(original), originalHash);
  });
