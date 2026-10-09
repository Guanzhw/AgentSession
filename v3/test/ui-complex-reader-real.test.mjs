import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

// Opt in with the exact Windows release executable. This test owns its scratch
// source and server process; the fixed comparison services stay untouched.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const sourceDir = path.join(repo, 'v3', 'fixtures', 'deepseek-harness', 'sessions', 's2-synthetic');
const ids = { root: 'dsh-v3-s2-root', alpha: 'dsh-v3-s2-alpha', beta: 'dsh-v3-s2-beta' };
const provider = 'deepseek-harness';
const expectedExeHash = process.env.AGENTSESSION_COMPLEX_READER_SHA256;
const binary = process.env.AGENTSESSION_COMPLEX_READER_BIN;
const browserName = process.platform === 'win32'
  ? 'agent-browser-win32-x64.exe' : `agent-browser-${process.platform}-${process.arch}`;
const browserBinary = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
  (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', browserName))
    .find(existsSync);
const skip = process.env.AGENTSESSION_COMPLEX_READER_DSH !== '1'
  ? 'Set AGENTSESSION_COMPLEX_READER_DSH=1 to run the exact-package browser acceptance.'
  : !binary || !existsSync(binary) ? 'Set AGENTSESSION_COMPLEX_READER_BIN to the extracted release executable.'
    : !browserBinary || !existsSync(browserBinary) ? 'The installed agent-browser binary is required.' : false;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const sourceFile = id => path.join(sourceDir, id, 'session.v3.jsonl.zstd');

async function browserCommand(session, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(browserBinary, ['--session', session, ...args], {
      cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`agent-browser ${args[0]} timed out`));
    }, 20_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout));
    });
  });
}

async function waitFor(command, expression, label) {
  const deadline = Date.now() + 15_000;
  let last = '';
  while (Date.now() < deadline) {
    last = await command('eval', `Boolean(${expression})`);
    if (last.includes('true')) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}; last result: ${last}`);
}

async function writeLongAlpha(scratch) {
  const file = path.join(scratch, 'dsh', 'sessions', 's2-synthetic', ids.alpha, 'session.v3.jsonl.zstd');
  await mkdir(path.dirname(file), { recursive: true });
  const baseTime = 1_780_000_000_000;
  const row = (seq, type, data, extra = {}) => ({ type, seq, time: baseTime + seq + 1, data, ...extra });
  const text = value => [{ type: 'text', text: value }];
  const records = [
    { type: 'session', version: 3, id: ids.alpha, createdAt: baseTime, cwd: '/synthetic/dsh-s2',
      isSeeded: false, delegationDepth: 1, agentPreset: 'standard', parentSession: ids.root,
      origin: 'subagent' },
    row(0, 'subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'subagent', label: 'alpha' }),
    row(1, 'turn/start', { turn: 1 }),
    row(2, 'user/message', { id: 'alpha-user', role: 'user', source: { kind: 'user' },
      content: text('Inspect synthetic alpha.') }, { surfaceOp: 'append' }),
    row(3, 'step/start', { turn: 1, step: 1 }),
  ];
  for (let index = 0; index < 40; index++) {
    records.push(row(index + 4, 'assistant/message', { turn: 1, step: 1,
      message: { id: `alpha-answer-${index}`, role: 'assistant',
        source: { kind: 'model', provider: 'synthetic', model: 'fixture-only' },
        content: text(index === 39 ? 'Synthetic alpha result. ALPHA-END.'
          : `Synthetic alpha continuation ${index}.`) } }, { surfaceOp: 'append' }));
  }
  records.push(row(44, 'step/end', { turn: 1, step: 1 }),
    row(45, 'turn/end', { turn: 1, reason: { kind: 'completed' } }));
  const midpoint = Math.ceil(records.length / 2);
  const frames = [records.slice(0, midpoint), records.slice(midpoint)]
    .map(part => zstdCompressSync(Buffer.from(part.map(value => JSON.stringify(value)).join('\n') + '\n')));
  await writeFile(file, Buffer.concat(frames));
  return file;
}

test('exact-package DSH dispatch opens one owned child and completes its bounded history',
  { skip, timeout: 120_000 }, async t => {
    assert.match(expectedExeHash ?? '', /^[0-9a-f]{64}$/i,
      'AGENTSESSION_COMPLEX_READER_SHA256 must pin the expected release executable');
    assert.equal(sha256(binary), expectedExeHash.toLowerCase(), 'the browser runs the pinned Windows candidate');
    const sourceHashes = Object.values(ids).map(id => sha256(sourceFile(id)));
    assert.equal(sourceHashes[0], 'ff0e1515e0faac0b0e0a44515afcd484896fae748d9164931b0cde981782880f',
      'the parent dispatch comes from the published dual-frame source');
    await mkdir(path.join(repo, 'tmp'), { recursive: true });
    const scratch = await mkdtemp(path.join(repo, 'tmp', 'v3-complex-reader-'));
    const copies = [];
    let server;
    const browserSession = `agentsession-v3-complex-reader-${process.pid}-${Date.now()}`;
    const command = (...args) => browserCommand(browserSession, ...args);
    t.after(async () => {
      try { await command('close'); } catch { /* The test browser may already have closed. */ }
      if (server && server.exitCode === null && server.signalCode === null) {
        const closed = once(server, 'close');
        server.kill();
        await closed;
      }
      assert.deepEqual(Object.values(ids).map(id => sha256(sourceFile(id))), sourceHashes,
        'the public DSH transcripts stay byte-for-byte unchanged');
      assert.deepEqual(copies.map(({ file }) => sha256(file)), copies.map(({ hash }) => hash),
        'the exact package leaves its scratch provider sources unchanged');
      const resolved = await realpath(scratch);
      assert.equal(path.dirname(resolved).toLowerCase(), (await realpath(path.join(repo, 'tmp'))).toLowerCase());
      assert.match(path.basename(resolved), /^v3-complex-reader-/);
      await rm(resolved, { recursive: true, force: true });
    });

    const dsh = path.join(scratch, 'dsh');
    for (const id of [ids.root, ids.beta]) {
      const dest = path.join(dsh, 'sessions', 's2-synthetic', id, 'session.v3.jsonl.zstd');
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(sourceFile(id), dest);
      copies.push({ file: dest, hash: sha256(dest) });
    }
    const alpha = await writeLongAlpha(scratch);
    copies.push({ file: alpha, hash: sha256(alpha) });
    for (const name of ['meta', 'index', 'cache', 'claude', 'pi']) {
      await mkdir(path.join(scratch, name));
    }
    const port = await freeFetchSafePort();
    const origin = `http://127.0.0.1:${port}`;
    const args = ['serve', '--port', String(port), '--dsh-dir', dsh,
      '--opencode-db', path.join(scratch, 'missing-opencode.db'),
      '--codex-dir', path.join(scratch, 'missing-codex'),
      '--claude-dir', path.join(scratch, 'claude'), '--pi-dir', path.join(scratch, 'pi'),
      '--meta-dir', path.join(scratch, 'meta'), '--index-dir', path.join(scratch, 'index'),
      '--cache-dir', path.join(scratch, 'cache'), '--disable-terminal-launch'];
    server = spawn(binary, args, { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let processOutput = '';
    server.stdout.on('data', chunk => { processOutput += chunk.toString(); });
    server.stderr.on('data', chunk => { processOutput += chunk.toString(); });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) break;
      try {
        const response = await fetch(`${origin}/api/providers`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { ready = true; break; }
      } catch { /* The isolated package process may still be starting. */ }
      await sleep(100);
    }
    assert.ok(ready, `the pinned package starts its isolated Web process: ${processOutput}`);

    const rootPath = `/${provider}/session/${ids.root}`;
    const childPath = `/${provider}/session/${ids.alpha}`;
    const readerApi = `${origin}/api/v3/reader/${provider}/${ids.root}`;
    const bootstrap = await (await fetch(`${readerApi}/bootstrap`)).json();
    assert.equal(bootstrap.session.session.sessionId, ids.root);
    const relationPage = await (await fetch(`${readerApi}/relations?cursor=${encodeURIComponent(bootstrap.relations.firstCursor)}`)).json();
    const placement = relationPage.childPlacements.find(row => row.child.sessionId === ids.alpha);
    assert.deepEqual(placement?.afterEvent,
      { provider, sessionId: ids.root, messageId: 'root-dispatch', segment: 'message' },
      'the inline action belongs to the recorded parent dispatch');

    await command('open', `${origin}${rootPath}`);
    const toggle = `.inline-child-toggle[id$="${Buffer.from(`${provider}\0${ids.alpha}`).toString('hex')}"]`;
    await waitFor(command, `Boolean(document.querySelector(${JSON.stringify(toggle)}))`, 'source-backed child action');
    const action = JSON.parse(await command('eval', `(() => { const button = document.querySelector(${JSON.stringify(toggle)}); return {
      count: document.querySelectorAll(${JSON.stringify(toggle)}).length,
      owner: (() => { const article = button?.closest('.turn-block')?.querySelector('article.event-card'); return article ? article.dataset.messageId + ' / ' + article.dataset.segment : null; })()
    }; })()`));
    assert.deepEqual(action, { count: 1, owner: 'root-dispatch / message' });
    await command('click', toggle);
    await waitFor(command, `document.querySelector('.inline-child-reader')?.textContent.includes('32 of 41 events loaded')`,
      'the first bounded child page');
    assert.equal(Number(await command('get', 'count', '.inline-child-reader')), 1);
    assert.equal(Number(await command('get', 'count', `.inline-child-heading-actions a[href="${childPath}"]`)), 1,
      'the child action names its canonical source');
    assert.equal(await command('get', 'text', '.session-details-content dd:nth-of-type(2) code'), ids.root,
      'the root Reader keeps the parent owner');
    assert.equal(Number(await command('get', 'count', '.reader-star')), 1,
      'inline content does not mount a second metadata owner');
    await command('click', '.inline-child-next');
    await waitFor(command, `document.querySelector('.inline-child-reader')?.textContent.includes('41 of 41 events loaded') &&
      document.querySelector('.inline-child-transcript')?.textContent.includes('ALPHA-END')`,
      'the child continuation reaches the recorded final answer');
    assert.equal(Number(await command('get', 'count', '.inline-child-transcript .event-card')), 41);
    assert.equal(Number(await command('get', 'count', '.inline-child-next')), 0,
      'no child continuation remains after the exact end');
    assert.equal(Number(await command('get', 'count', '.inline-child-reader')), 1,
      'the canonical child is mounted once after pagination');
    assert.equal(JSON.parse(await command('eval', 'window.location.pathname')), rootPath);

    await command('eval', `document.querySelector(${JSON.stringify(toggle)}).scrollIntoView({block:'center',behavior:'instant'})`);
    const before = Number(await command('eval', `document.querySelector(${JSON.stringify(toggle)}).getBoundingClientRect().top`));
    await command('click', toggle);
    await waitFor(command, `document.querySelectorAll('.inline-child-reader').length === 0`, 'child collapse');
    const after = Number(await command('eval', `document.querySelector(${JSON.stringify(toggle)}).getBoundingClientRect().top`));
    assert.ok(Math.abs(after - before) < 2,
      `collapse restores the parent insertion position (${before} -> ${after})`);
    assert.equal(JSON.parse(await command('eval', 'document.activeElement?.id')),
      `child-toggle-${Buffer.from(`${provider}\0${ids.alpha}`).toString('hex')}`,
      'collapse returns keyboard focus to the exact parent action');
    assert.equal(await command('get', 'text', '.session-details-content dd:nth-of-type(2) code'), ids.root);
    assert.equal((await command('errors')).trim(), '', 'the browser reports no page errors');
    t.diagnostic(`Pinned exe SHA-256 ${expectedExeHash}; public root SHA-256 ${sourceHashes[0]}; copied alpha SHA-256 ${copies[2].hash}`);
  });
