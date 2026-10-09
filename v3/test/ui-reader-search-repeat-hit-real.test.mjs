import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const id = '019e88a5-d073-7610-ab37-894618be2336';
const source = path.join(repo, 'tmp', 'v3-corpus', 'codex', 'sessions', '2026', '06', '02',
  `rollout-2026-06-02T22-03-53-${id}.jsonl`);
const expectedHash = '371da27459fe8ca90ee879ca61f57196edbcd51105dcd2d80ee2d1d0a62a5df1';
const query = 'Encrypted compaction content unavailable.';
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const browserName = process.platform === 'win32' ? 'agent-browser-win32-x64.exe' :
  `agent-browser-${process.platform}-${process.arch}`;
const browserBinary = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
  (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', browserName))
    .find(existsSync);
const skip = !existsSync(source) ? 'The frozen WEB-08 Codex transcript is unavailable.'
  : !browserBinary || !existsSync(browserBinary) ? 'agent-browser is required for browser QA.'
    : !existsSync(binary) ? 'Build the v3 server binary before browser QA.' : false;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function browserCommand(session, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(browserBinary, ['--session', session, ...args],
      { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    const timer = setTimeout(() => child.kill(), 20_000);
    child.once('exit', code => {
      clearTimeout(timer);
      code === 0 ? resolve(output.trim()) : reject(new Error(`agent-browser ${args[0]} failed: ${output}`));
    });
    child.once('error', reject);
  });
}

async function waitFor(command, expression, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    last = await command('eval', `Boolean(${expression})`);
    if (last.includes('true')) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}; last result: ${last}`);
}

async function selectedMark(command) {
  return JSON.parse(await command('eval', `(() => {
    const mark = document.querySelector('.search-reveal mark');
    const card = mark?.closest('article.event-card');
    const bounds = mark?.getBoundingClientRect();
    return { source: card ? card.dataset.messageId + ' / ' + card.dataset.segment : null,
      top: bounds?.top ?? null, bottom: bounds?.bottom ?? null, viewport: window.innerHeight,
      hash: window.location.hash,
      focusedMatch: document.activeElement === mark?.closest('.search-reveal') };
  })()`));
}

test('WEB-08 repeated search hit scrolls the selected mark into view after full context expansion',
  { skip, timeout: 180_000 }, async t => {
    const original = await readFile(source);
    assert.equal(hash(original), expectedHash, 'the test uses the frozen WEB-08 source');
    const root = await mkdtemp(path.join(repo, 'tmp', 'v3-repeat-search-hit-'));
    const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']
      .map(name => [name, path.join(root, name)]));
    await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
    const sessionDir = path.join(dirs.codex, 'sessions', '2026', '06', '02');
    await mkdir(sessionDir, { recursive: true });
    const copy = path.join(sessionDir, path.basename(source));
    await copyFile(source, copy);
    t.after(async () => {
      assert.equal(hash(await readFile(source)), hash(original), 'the frozen source remains unchanged');
      assert.equal(hash(await readFile(copy)), hash(original), 'the isolated server source remains unchanged');
      await rm(root, { recursive: true, force: true });
    });

    const port = await freeFetchSafePort();
    const server = spawn(binary, ['serve', '--port', String(port), '--codex-dir', dirs.codex,
      '--opencode-db', path.join(root, 'missing.db'), '--claude-dir', dirs.claude,
      '--pi-dir', dirs.pi, '--dsh-dir', dirs.dsh, '--meta-dir', dirs.meta,
      '--index-dir', dirs.index, '--cache-dir', dirs.cache],
    { cwd: repo, windowsHide: true, stdio: 'ignore' });
    t.after(async () => {
      if (server.exitCode === null && server.signalCode === null) {
        const closed = once(server, 'close');
        server.kill();
        await Promise.race([closed, sleep(3000)]);
      }
    });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (server.exitCode !== null) throw new Error('isolated server exited');
      try {
        if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok) {
          ready = true;
          break;
        }
      } catch { /* The isolated index may still be starting. */ }
      await sleep(100);
    }
    assert.ok(ready, 'the isolated server serves the copied Codex transcript');

    const browserSession = `v3-repeat-search-hit-${process.pid}-${Date.now()}`;
    const command = (...args) => browserCommand(browserSession, ...args);
    t.after(async () => { try { await command('close'); } catch { /* Browser cleanup. */ } });
    await command('open', `${base}/codex/session/${id}`);
    await command('set', 'viewport', '1440', '900');
    await waitFor(command, `document.querySelector('.pane-search[data-scope="session"]')`,
      'the session search controls');
    await command('click', '.reader-find-toggle');
    await waitFor(command, `!document.querySelector('#reader-search').hidden`, 'the opened session search');

    await command('fill', '.pane-search[data-scope="session"] input[type="search"]', query);
    await command('click', '.pane-search[data-scope="session"] form button[type="submit"]');
    await waitFor(command, `document.querySelector('.pane-search-results .pane-search-result')`,
      'the first matching search result');
    const firstResult = JSON.parse(await command('eval', `(() => ({
      label: document.querySelector('.pane-search-results .pane-search-result strong')?.textContent ?? '',
      count: document.querySelectorAll('.pane-search-results .pane-search-result').length
    }))()`));
    assert.equal(firstResult.count > 0, true);
    assert.match(firstResult.label, /event 408\s*·\s*character 46470/i);

    await command('eval', `document.querySelector('.pane-search-results .pane-search-result')?.focus()`);
    await command('press', 'Enter');
    await waitFor(command, `document.querySelector('.search-reveal[data-field="body"] mark') &&
      location.hash.includes('messageId=compaction-1252') && location.hash.includes('segment=context')`,
    'the fresh context search hit');
    const fresh = await selectedMark(command);
    assert.equal(fresh.source, 'compaction-1252 / context');
    assert.equal(fresh.focusedMatch, true, 'opening a hit focuses its matched reading region');
    assert.ok(fresh.top >= 0 && fresh.top < fresh.viewport,
      'a fresh partial-content hit remains visible after the event anchor is opened');

    const fullBodyLength = 46_510;
    assert.equal(JSON.parse(await command('eval', `Number(document.querySelector('.search-reveal mark')?.closest('article.event-card')
      ?.dataset.totalChars)`)),
      fullBodyLength, 'the frozen context checkpoint has the recorded long body');
    const more = `document.querySelector('.search-reveal mark')?.closest('article.event-card')?.querySelector('.event-footer .read-more')`;
    for (let attempt = 0; attempt < 80 && JSON.parse(await command('eval', `Boolean(${more})`)); attempt++) {
      await waitFor(command, `!(${more})?.disabled`, 'the next bounded content chunk');
      const previousRequests = Number(await command('eval', `performance.getEntriesByType('resource')
        .filter(entry => new URL(entry.name).pathname.endsWith('/content')).length`));
      await command('eval', `(${more})?.click()`);
      await waitFor(command, `performance.getEntriesByType('resource')
        .filter(entry => new URL(entry.name).pathname.endsWith('/content')).length > ${previousRequests}
        && !(${more})?.disabled`, 'the completed bounded content chunk', 15_000);
    }
    assert.equal(JSON.parse(await command('eval', `Boolean(${more})`)), false,
      'the context body is fully expanded before repeating search');
    assert.equal(Number(await command('eval', `document.querySelector('.search-reveal mark')?.closest('article.event-card')
      ?.querySelector(':scope > .event-body')?.textContent.length`)), fullBodyLength,
      'full context expansion retains every recorded character');

    await command('click', '.pane-search[data-scope="session"] form button[type="submit"]');
    await waitFor(command, `document.querySelector('.pane-search-results .pane-search-result') &&
      !document.querySelector('.pane-search-state[role="status"]')`, 'the repeated search results');
    await command('eval', `document.querySelector('.pane-search-results .pane-search-result')?.focus()`);
    const contentRequestsBefore = Number(await command('eval', `performance.getEntriesByType('resource')
      .filter(entry => new URL(entry.name).pathname.endsWith('/content')).length`));
    await command('press', 'Enter');
    await waitFor(command, `performance.getEntriesByType('resource').filter(entry =>
      new URL(entry.name).pathname.endsWith('/content')).length > ${contentRequestsBefore}`,
    'the repeated hit content request');
    await sleep(150);
    const repeated = await selectedMark(command);
    assert.equal(repeated.source, 'compaction-1252 / context');
    assert.equal(repeated.hash, fresh.hash, 'repeating the hit keeps the canonical event anchor');
    assert.equal(repeated.focusedMatch, true, 'repeating a hit focuses its matched reading region');
    assert.ok(repeated.top >= 0 && repeated.bottom <= repeated.viewport,
      `the repeated highlighted match should be in the viewport; mark top=${repeated.top}, bottom=${repeated.bottom}, viewport=${repeated.viewport}`);
    t.diagnostic(`Selected ${repeated.source}; first-hit mark y=${fresh.top.toFixed(1)}, repeated-hit mark y=${repeated.top.toFixed(1)}..${repeated.bottom.toFixed(1)} within ${repeated.viewport}px; content ${fullBodyLength}/${fullBodyLength}.`);
    assert.equal((await command('errors')).trim(), '', 'the isolated browser reports no page errors');
  });
