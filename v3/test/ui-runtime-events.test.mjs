import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
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
const sessionId = '44444444-4444-4444-8444-444444444444';
const fixture = path.join(repo, 'v3', 'fixtures', 'codex', 'sessions', '2026', '09', '26',
  `rollout-2026-09-26T00-00-00-${sessionId}.jsonl`);
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

test('real Axum Reader opens bounded partial Runtime events and returns to exact source',
  { skip: !existsSync(binary) || !browser ? 'Build the v3 binary and install agent-browser' : false, timeout: 90_000 },
  async t => {
    const before = sha256(fixture);
    await mkdir(path.join(repo, 'tmp'), { recursive: true });
    const work = await mkdtemp(path.join(repo, 'tmp', 'v3-ui-runtime-'));
    t.after(() => rm(work, { recursive: true, force: true }));
    for (const name of ['meta', 'index', 'cache', 'claude', 'pi']) await mkdir(path.join(work, name));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const args = ['serve', '--port', String(port), '--codex-dir', path.join(repo, 'v3', 'fixtures', 'codex'),
      '--opencode-db', path.join(work, 'opencode.db'), '--claude-dir', path.join(work, 'claude'),
      '--pi-dir', path.join(work, 'pi'), '--dsh-dir', path.join(repo, 'v3', 'fixtures', 'deepseek-harness'),
      '--meta-dir', path.join(work, 'meta'), '--index-dir', path.join(work, 'index'),
      '--cache-dir', path.join(work, 'cache')];
    const child = spawn(binary, args, { cwd: repo, windowsHide: true, stdio: 'ignore' });
    t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'close'); });
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok) break; }
      catch { /* Axum is starting. */ }
      if (attempt === 99) throw new Error('Axum did not start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const page = await (await fetch(`${base}/api/v3/runtime/codex/${sessionId}/events`)).json();
    assert.equal(page.coverage, 'partial');
    assert.equal(page.events.find(event => event.kind === 'tool.call')?.readerEvent?.messageId, 'tool-call-1');
    const name = `v3-runtime-${process.pid}-${Date.now()}`;
    t.after(async () => { try { await browserCommand(name, 'close'); } catch { /* Already closed. */ } });
    await browserCommand(name, 'open', `${base}/codex/session/${sessionId}`);
    await waitFor(name, `document.querySelector('#reader-title')`, 'Reader');
    assert.equal(Number(await browserCommand(name, 'get', 'count', 'button.runtime-tab')), 1,
      'the Reader must offer Runtime only after the real bootstrap resolves');
    await browserCommand(name, 'click', 'button.runtime-tab');
    await waitFor(name, `document.querySelectorAll('.runtime-event').length > 0`, 'Runtime event page');
    assert.equal(Number(await browserCommand(name, 'get', 'count', '.runtime-event')), page.events.length);
    assert.equal(Number(await browserCommand(name, 'get', 'count', '.runtime-event a')),
      page.events.filter(event => event.readerEvent).length, 'events without Reader references have no source link');
    assert.match(await browserCommand(name, 'get', 'text', '.runtime-coverage'), /partial/i);
    assert.match(await browserCommand(name, 'get', 'text', '.runtime-event'), /recorded/);
    await browserCommand(name, 'fill', '.runtime-category', 'tool');
    await browserCommand(name, 'fill', '.runtime-kind', 'tool.call');
    await browserCommand(name, 'click', '.runtime-filters button');
    await waitFor(name, `document.querySelectorAll('.runtime-event').length === 1`, 'exact filtered event');
    assert.match(await browserCommand(name, 'get', 'text', '.runtime-event'), /tool.call/);
    await browserCommand(name, 'click', '.runtime-event a');
    await waitFor(name, `document.querySelector('.transcript') && location.hash.includes('tool-call-1')`,
      'source anchor in Conversation');

    // Inject transport failures only after exercising the real Axum route and source jump.
    const respond = (status, code, message) => browserCommand(name, 'eval',
      `window.fetch = async (input, init) => String(input).includes('/api/v3/runtime/') ? new Response(JSON.stringify({error:{code:${JSON.stringify(code)},message:${JSON.stringify(message)}}}),{status:${status},headers:{'content-type':'application/json'}}) : window.__realFetch(input,init)`);
    await browserCommand(name, 'eval', 'window.__realFetch = window.fetch.bind(window)');
    await browserCommand(name, 'click', 'button.runtime-tab');
    await waitFor(name, `document.querySelectorAll('.runtime-event').length > 0`, 'reopened Runtime page');
    for (const [status, code, label] of [
      [422, 'protocol_invalid', 'Invalid protocol evidence'],
      [503, 'protocol_unavailable', 'Runtime events unavailable'],
      [500, 'source_error', 'Runtime request failed'],
    ]) {
      await respond(status, code, `${code} from test transport`);
      await browserCommand(name, 'click', '.runtime-filters button');
      await waitFor(name, `document.querySelector('.runtime-state strong')?.textContent === ${JSON.stringify(label)}`,
        label);
    }
    const emptyPage = { ...page, events: [], nextCursor: 'invalid-next-cursor', scannedEvents: 2 };
    await browserCommand(name, 'eval',
      `window.fetch = async (input, init) => String(input).includes('/api/v3/runtime/') ?
        (String(input).includes('cursor=') ? new Response(JSON.stringify({error:{code:'invalid_cursor',message:'stale cursor'}}),{status:400,headers:{'content-type':'application/json'}}) :
        new Response(${JSON.stringify(JSON.stringify(emptyPage))},{status:200,headers:{'content-type':'application/json'}})) : window.__realFetch(input,init)`);
    await browserCommand(name, 'click', '.runtime-filters button');
    await waitFor(name, `document.querySelector('.runtime-state strong')?.textContent === 'No matching events on this page'`,
      'empty continuation page');
    await browserCommand(name, 'click', '.runtime-pagination button');
    await waitFor(name, `document.querySelector('.runtime-state strong')?.textContent === 'Event cursor is stale or invalid'`,
      'stale cursor state');
    await browserCommand(name, 'eval',
      `window.fetch = async (input, init) => String(input).includes('/api/v3/runtime/') ?
        new Response(${JSON.stringify(JSON.stringify({ ...page, revision: 'changed-revision' }))},{status:200,headers:{'content-type':'application/json'}}) : window.__realFetch(input,init)`);
    await browserCommand(name, 'click', '.runtime-filters button');
    await waitFor(name, `document.querySelector('.runtime-state strong')?.textContent === 'Source revision changed'`,
      'revision mismatch');
    assert.equal(Number(await browserCommand(name, 'get', 'count', '.runtime-event a')), 0,
      'revision mismatch must prevent source navigation');

    const first = { ...page, events: [page.events[0]], nextCursor: 'next-page', scannedEvents: 1 };
    const second = { ...page, events: [page.events.find(event => event.kind === 'tool.call')],
      nextCursor: null, scannedEvents: 1 };
    await browserCommand(name, 'eval',
      `window.fetch = async (input, init) => String(input).includes('/api/v3/runtime/') ?
        new Response(String(input).includes('cursor=') ? ${JSON.stringify(JSON.stringify(second))} : ${JSON.stringify(JSON.stringify(first))},
          {status:200,headers:{'content-type':'application/json'}}) : window.__realFetch(input,init)`);
    await browserCommand(name, 'click', '.runtime-filters button');
    await waitFor(name, `document.querySelectorAll('.runtime-event').length === 1`, 'first bounded page');
    assert.match(await browserCommand(name, 'get', 'text', '.runtime-event'), /session\.meta/);
    await browserCommand(name, 'click', '.runtime-pagination button');
    await waitFor(name, `document.querySelector('.runtime-event strong')?.textContent === 'tool.call'`,
      'replacement page');
    assert.equal(Number(await browserCommand(name, 'get', 'count', '.runtime-event')), 1,
      'next page replaces the current bounded page');

    await browserCommand(name, 'eval',
      `window.__raceCalls=0; window.fetch=(input,init)=>{
        if(!String(input).includes('/api/v3/runtime/')) return window.__realFetch(input,init);
        if(++window.__raceCalls===1) return new Promise(resolve=>{window.__releaseRuntime=()=>resolve(new Response(${JSON.stringify(JSON.stringify(first))},{status:200,headers:{'content-type':'application/json'}}))});
        return window.__realFetch(input,init);
      }`);
    await browserCommand(name, 'fill', '.runtime-category', 'message');
    await browserCommand(name, 'click', '.runtime-filters button');
    await browserCommand(name, 'fill', '.runtime-category', 'tool');
    await browserCommand(name, 'click', '.runtime-filters button');
    await waitFor(name, `document.querySelectorAll('.runtime-event').length === 2`, 'newer filter response');
    await browserCommand(name, 'eval', 'window.__releaseRuntime()');
    assert.equal(Number(await browserCommand(name, 'get', 'count', '.runtime-event')), 2,
      'an older request cannot overwrite a changed filter');

    await browserCommand(name, 'eval',
      `window.fetch=(input,init)=> String(input).includes('/api/v3/runtime/') ?
        new Promise(resolve=>{window.__releaseSessionRuntime=()=>resolve(new Response(${JSON.stringify(JSON.stringify(first))},{status:200,headers:{'content-type':'application/json'}}))}) : window.__realFetch(input,init)`);
    await browserCommand(name, 'click', '.runtime-filters button');
    await browserCommand(name, 'eval', `document.querySelector('.reader-back-link').click()`);
    await waitFor(name, `document.querySelector('a[href="/deepseek-harness/session/dsh-v3-s2-root"]')`,
      'Library after leaving a pending Runtime request');
    await browserCommand(name, 'focus', 'a[href="/deepseek-harness/session/dsh-v3-s2-root"]');
    await browserCommand(name, 'press', 'Enter');
    await waitFor(name, `location.pathname.includes('/deepseek-harness/session/dsh-v3-s2-root') && document.querySelector('#reader-title')`,
      'different session Reader');
    await browserCommand(name, 'eval', 'window.__releaseSessionRuntime()');
    assert.equal(Number(await browserCommand(name, 'get', 'count', '.runtime-event')), 0,
      'an old session response cannot appear in the changed session');
    assert.equal(sha256(fixture), before, 'Runtime reads must preserve the provider source');
  });
