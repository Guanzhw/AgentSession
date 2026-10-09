import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const browserName = process.platform === 'win32' ? 'agent-browser-win32-x64.exe'
  : `agent-browser-${process.platform}-${process.arch}`;
const browser = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
  (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', browserName))
    .find(existsSync);
const source = path.join(repo, 'test/fixtures/pi-current.jsonl');
const sessionId = '019f7b00-0000-7000-8000-000000000001';
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');

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

test('Pi Runtime Context joins one result and opens its recorded Reader summary',
  { skip: !existsSync(binary) || !browser ? 'Build v3 and install agent-browser' : false, timeout: 90_000 },
  async t => {
    const sourceHash = sha(source);
    await mkdir(path.join(repo, 'tmp'), { recursive: true });
    const state = await mkdtemp(path.join(repo, 'tmp/v3-pi-context-ui-'));
    t.after(async () => {
      assert.equal(sha(source), sourceHash);
      assert.equal(sha(path.join(state, 'pi/sessions/project', `${sessionId}.jsonl`)), sourceHash);
      await rm(state, { recursive: true, force: true });
    });
    const piFile = path.join(state, 'pi/sessions/project', `${sessionId}.jsonl`);
    await mkdir(path.dirname(piFile), { recursive: true });
    await copyFile(source, piFile);
    for (const name of ['codex', 'claude', 'dsh', 'meta', 'index', 'cache'])
      await mkdir(path.join(state, name));
    const port = await freeFetchSafePort();
    const base = `http://127.0.0.1:${port}`;
    const args = ['serve', '--port', String(port), '--pi-dir', path.join(state, 'pi'),
      '--opencode-db', path.join(state, 'missing.db')];
    for (const name of ['codex', 'claude', 'dsh', 'meta', 'index', 'cache'])
      args.push(`--${name}-dir`, path.join(state, name));
    const server = spawn(binary, args, { cwd: repo, windowsHide: true, stdio: 'ignore' });
    t.after(async () => { server.kill(); if (server.exitCode === null) await once(server, 'close'); });
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok) break; }
      catch { /* Waiting for isolated Axum process. */ }
      if (attempt === 99) throw new Error('Axum did not start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const name = `v3-pi-context-${process.pid}-${Date.now()}`;
    t.after(async () => { try { await command(name, 'close'); } catch { /* Browser closed. */ } });
    await command(name, 'open', `${base}/pi/session/${sessionId}`);
    await waitFor(name, `document.querySelector('#reader-title')`);
    await command(name, 'click', 'button.runtime-tab');
    await waitFor(name, `document.querySelector('.runtime-lenses')`);
    await command(name, 'click', '.runtime-lens-context');
    await waitFor(name, `document.querySelector('.runtime-domain-context .runtime-domain-entry')`);
    assert.equal(Number(await command(name, 'get', 'count', '.runtime-domain-context .runtime-domain-entry')), 1);
    const card = await command(name, 'get', 'text', '.runtime-domain-context .runtime-domain-entry');
    assert.match(card, /Compaction result/);
    assert.match(card, /Retained from source entry user0002/);
    assert.doesNotMatch(card, /Earlier Pi work was compacted/);
    await command(name, 'click', '.runtime-domain-context .runtime-domain-entry a[href^="#event?"]');
    await waitFor(name, `document.querySelector('.runtime-domain-context') === null`);
    assert.match(await command(name, 'get', 'text', 'body'), /Earlier Pi work was compacted/);
  });
