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
const browserName = process.platform === 'win32' ? 'agent-browser-win32-x64.exe'
  : `agent-browser-${process.platform}-${process.arch}`;
const browser = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
  (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', browserName))
    .find(existsSync);
const sessionId = '44444444-4444-4444-8444-444444444444';
const fixture = path.join(repo, 'v3', 'fixtures', 'codex', 'sessions', '2026', '09', '26',
  `rollout-2026-09-26T00-00-00-${sessionId}.jsonl`);
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

async function freePort() {
  return freeFetchSafePort();
}

async function command(name, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(browser, ['--session', name, ...args], { cwd: repo, windowsHide: true });
    let output = '';
    let error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`browser ${args.join(' ')} timed out`)); }, 15_000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.once('error', cause => { clearTimeout(timer); reject(cause); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code) reject(new Error(error || output));
      else resolve(output.trim());
    });
  });
}

async function waitFor(name, expression) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await command(name, 'eval', `Boolean(${expression})`)).includes('true')) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${expression}`);
}

test('Runtime lenses render bounded summary, graph and domain facts with coverage and cursor errors',
  { skip: !existsSync(binary) || !browser ? 'Build v3 and install agent-browser' : false, timeout: 90_000 },
  async t => {
    const sourceHash = sha256(fixture);
    const work = await mkdtemp(path.join(os.tmpdir(), 'v3-ui-projections-'));
    t.after(() => rm(work, { recursive: true, force: true }));
    for (const name of ['meta', 'index', 'cache', 'claude', 'pi']) await mkdir(path.join(work, name));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(binary, ['serve', '--port', String(port), '--codex-dir', path.join(repo, 'v3', 'fixtures', 'codex'),
      '--opencode-db', path.join(work, 'opencode.db'), '--claude-dir', path.join(work, 'claude'),
      '--pi-dir', path.join(work, 'pi'), '--dsh-dir', path.join(repo, 'v3', 'fixtures', 'deepseek-harness'),
      '--meta-dir', path.join(work, 'meta'), '--index-dir', path.join(work, 'index'),
      '--cache-dir', path.join(work, 'cache')], { cwd: repo, windowsHide: true, stdio: 'ignore' });
    t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'close'); });
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok) break; }
      catch { /* Waiting for Axum. */ }
      if (attempt === 99) throw new Error('Axum did not start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const summary = await (await fetch(`${base}/api/v3/runtime/codex/${sessionId}/summary`)).json();
    const name = `v3-projections-${process.pid}-${Date.now()}`;
    t.after(async () => { try { await command(name, 'close'); } catch { /* Browser closed. */ } });
    await command(name, 'open', `${base}/codex/session/${sessionId}`);
    await waitFor(name, `document.querySelector('#reader-title')`);
    await command(name, 'click', 'button.runtime-tab');
    await waitFor(name, `document.querySelector('.runtime-lenses')`);
    assert.equal(Number(await command(name, 'get', 'count', '.runtime-lenses button')), 7);
    await command(name, 'click', '.runtime-lens-summary');
    await waitFor(name, `document.querySelector('.runtime-summary-counts')`);
    assert.match(await command(name, 'get', 'text', '.runtime-summary'), /partial/i);
    assert.match(await command(name, 'get', 'text', '.runtime-summary'), /work/i);
    await command(name, 'click', '.runtime-lens-sessions');
    await waitFor(name, `document.querySelector('.runtime-graph-node')`);
    assert.match(await command(name, 'get', 'text', '.runtime-sessions'), /recorded|derived/i);
    for (const lens of ['execution', 'coordination', 'context']) {
      await command(name, 'click', `.runtime-lens-${lens}`);
      await waitFor(name, `document.querySelector('.runtime-domain-${lens} .runtime-domain-coverage')`);
      assert.match(await command(name, 'get', 'text', `.runtime-domain-${lens}`), /observed|unknown|not observed/i);
      if (lens === 'execution') {
        assert.ok(Number(await command(name, 'get', 'count', '.runtime-domain-execution .runtime-domain-entry')) > 0);
        assert.match(await command(name, 'get', 'text', '.runtime-domain-execution .runtime-domain-entry'), /Provenance: recorded/);
      }
    }
    const coordinationPage = {
      session: { provider: 'codex', sessionId }, revision: summary.revision, coverage: 'partial',
      domainCoverage: { state: 'observed', details: 'Recorded coordination facts.' },
      entries: [{ type: 'coordination', kind: 'message.sent', sourceOrder: { record: 4, ordinal: 1 },
        fact: { id: 'fact-1', kind: 'message.sent', state: 'delivered', correlationId: 'task-1',
          fromActorPath: '/root', toActorPath: '/root/worker',
          evidence: { eventId: 'event-1', provenance: { fidelity: 'recorded', sourceType: 'jsonl', sourceId: '4' } } } }],
      nextCursor: 'page2', scannedEntries: 1,
    };
    await command(name, 'eval', `window.__runtimeOriginalFetch=window.fetch.bind(window);
      window.fetch=(input,init)=>String(input).includes('/coordination?') ?
        (String(input).includes('cursor=') ? new Response(JSON.stringify({error:{code:'invalid_cursor',message:'stale cursor'}}),
          {status:400,headers:{'content-type':'application/json'}}) :
        new Response(${JSON.stringify(JSON.stringify(coordinationPage))},{status:200,headers:{'content-type':'application/json'}})) : window.__runtimeOriginalFetch(input,init)`);
    await command(name, 'click', '.runtime-lens-coordination');
    await waitFor(name, `document.querySelector('.runtime-domain-coordination .runtime-domain-entry')`);
    assert.match(await command(name, 'get', 'text', '.runtime-domain-coordination .runtime-domain-entry'), /root\/worker/);
    assert.match(await command(name, 'get', 'text', '.runtime-domain-coordination .runtime-domain-entry'), /Provenance: recorded/);
    await command(name, 'click', '.runtime-domain-coordination .runtime-pagination button');
    await waitFor(name, `document.querySelector('.runtime-domain-coordination [role="alert"]')?.textContent.includes('Cursor is stale')`);
    assert.match(await command(name, 'get', 'text', '.runtime-domain-coordination [role="alert"]'), /stale cursor/);
    await command(name, 'eval', `window.fetch=(input,init)=>String(input).includes('/context?') ?
        new Response(JSON.stringify({error:{code:'protocol_invalid',message:'invalid source'}}),
          {status:422,headers:{'content-type':'application/json'}}) : window.__runtimeOriginalFetch(input,init)`);
    await command(name, 'click', '.runtime-lens-context');
    await command(name, 'click', '.runtime-domain-context .runtime-filters button');
    await waitFor(name, `document.querySelector('.runtime-domain-context [role="alert"]')?.textContent.includes('Invalid protocol')`);
    await command(name, 'eval', `window.fetch=(input,init)=>String(input).endsWith('/summary') ?
      new Response(${JSON.stringify(JSON.stringify({ ...summary, revision: 'changed' }))},
        {status:200,headers:{'content-type':'application/json'}}) : window.__runtimeOriginalFetch(input,init)`);
    await command(name, 'click', '.runtime-lens-summary');
    await waitFor(name, `document.querySelector('.runtime-summary [role="alert"]')?.textContent.includes('Source revision changed')`);
    assert.equal(Number(await command(name, 'get', 'count', '.runtime-summary-counts')), 0);
    assert.equal(sha256(fixture), sourceHash, 'Runtime UI only reads provider-owned source');
  });
