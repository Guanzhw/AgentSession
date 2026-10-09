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
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const browserName = process.platform === 'win32' ? 'agent-browser-win32-x64.exe' :
  `agent-browser-${process.platform}-${process.arch}`;
const browserBinary = (process.env.PATH || '').split(path.delimiter)
  .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', browserName))
  .find(existsSync);
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

test('frozen Codex opening reply stays readable ahead of collapsed owned work',
  { skip: !existsSync(source) || !browserBinary || !existsSync(binary), timeout: 120_000 }, async t => {
    const original = await readFile(source);
    assert.equal(hash(original), expectedHash, 'the test uses the frozen WEB-03 source');
    const root = await mkdtemp(path.join(repo, 'tmp', 'v3-first-reply-'));
    const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']
      .map(name => [name, path.join(root, name)]));
    await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
    const sessionDir = path.join(dirs.codex, 'sessions', '2026', '06', '02');
    await mkdir(sessionDir, { recursive: true });
    const copy = path.join(sessionDir, path.basename(source));
    await copyFile(source, copy);
    t.after(async () => {
      assert.equal(hash(await readFile(source)), hash(original));
      assert.equal(hash(await readFile(copy)), hash(original));
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
      try { if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } }
      catch { /* Indexing. */ }
      await sleep(100);
    }
    assert.ok(ready);
    const bootstrap = await (await fetch(`${base}/api/v3/reader/codex/${id}/bootstrap`)).json();
    assert.equal(bootstrap.segments[0].items.length, 32);
    assert.equal(bootstrap.segments[0].items[0].event.messageId, 'msg-0');
    assert.equal(bootstrap.segments[0].items[0].processCount, 85);
    const second = await (await fetch(`${base}/api/v3/reader/codex/${id}/segments?cursor=${encodeURIComponent(bootstrap.segments[0].nextCursor)}`)).json();
    const third = await (await fetch(`${base}/api/v3/reader/codex/${id}/segments?cursor=${encodeURIComponent(second.page.nextCursor)}`)).json();
    const laterProcessItem = third.page.items.find(item => item.processId === 0 && item.ordinal >= 70);
    assert.ok(laterProcessItem);

    const session = `v3-first-reply-${process.pid}-${Date.now()}`;
    const command = (...args) => browserCommand(session, ...args);
    t.after(async () => { try { await command('close'); } catch { /* Browser cleanup. */ } });
    await command('open');
    await command('set', 'viewport', '1440', '900');
    await command('eval', `window.location.href = ${JSON.stringify(`${base}/codex/session/${id}`)}`);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await command('eval', `Boolean(document.querySelector('.transcript details.reader-process'))`)).includes('true')) break;
      await sleep(100);
    }
    const state = JSON.parse(await command('eval', `(() => {
      const transcript = document.querySelector('.transcript');
      const cards = [...(transcript?.querySelectorAll('article.event-card') ?? [])];
      const opening = cards.find(card => card.dataset.messageId + ' / ' + card.dataset.segment === 'msg-0 / message');
      const ownedTool = cards.find(card => card.dataset.messageId + ' / ' + card.dataset.segment === 'call_ntqg0tLujpU8dWy29BZsgF3h / tool');
      const process = transcript?.querySelector('details.reader-process');
      return { openingText: opening?.querySelector('.event-body')?.textContent ?? '',
        openingVisible: Boolean(opening && !opening.closest('details.reader-process')),
        bodyOnScreen: Boolean(opening && opening.querySelector('.event-body')?.getBoundingClientRect().top < window.innerHeight),
        openingCount: cards.filter(card => card.dataset.messageId + ' / ' + card.dataset.segment === 'msg-0 / message').length,
        processOpen: process?.open, processSummary: process?.querySelector('summary')?.textContent ?? '',
        toolUnderOpening: Boolean(ownedTool && opening?.closest('.turn-block')?.contains(ownedTool)),
        toolHidden: ownedTool?.closest('details.reader-process')?.open === false,
        firstSources: cards.slice(0, 5).map(card => card.dataset.messageId + ' / ' + card.dataset.segment),
        outlineOpeningVisible: Boolean(document.querySelector('.outline-children a[href="#event?messageId=msg-0&segment=message"]')),
        outlineProcess: document.querySelector('.outline-children details.outline-process summary')?.textContent ?? '' };
    })()`));
    assert.match(state.openingText, /^Got it\. I’ll treat this as the current project state/);
    assert.equal(state.openingVisible, true);
    assert.equal(state.bodyOnScreen, true, 'the first reply is readable in the opening desktop viewport');
    assert.equal(state.openingCount, 1, 'one source card and body');
    assert.equal(state.processOpen, false);
    assert.match(state.processSummary, /84 steps/);
    assert.equal(state.toolUnderOpening, true);
    assert.equal(state.toolHidden, true);
    assert.equal(state.outlineOpeningVisible, true);
    assert.match(state.outlineProcess, /63\/84/);
    await command('screenshot', path.join(repo, 'tmp', 'v3-first-reply-view.png'));
    assert.deepEqual(state.firstSources, ['msg-0 / message',
      'call_ntqg0tLujpU8dWy29BZsgF3h / tool',
      'call_blbgdKYjNN4ChxbQlNPhNzGZ / tool',
      'call_Ydiqk1QMTpAKqw8i68Z6LjJB / tool', 'msg-1 / message']);

    await command('eval', `document.querySelector('.transcript .reader-process > summary').focus()`);
    await command('press', 'Enter');
    assert.equal(await command('eval', `document.querySelector('.transcript .reader-process').open`), 'true');
    await command('press', 'Enter');
    assert.equal(await command('eval', `document.querySelector('.transcript .reader-process').open`), 'false');

    await command('eval', `window.location.hash = '#event?messageId=call_ntqg0tLujpU8dWy29BZsgF3h&segment=tool'`);
    for (let attempt = 0; attempt < 80; attempt++) {
      if ((await command('eval', `document.querySelector('.transcript .reader-process')?.open === true`)).includes('true')) break;
      await sleep(100);
    }
    assert.equal(await command('eval', `document.querySelector('.transcript .reader-process')?.open`), 'true');
    await command('eval', `document.querySelector('.transcript .reader-process').open = false;
      window.location.hash = '#event?messageId=msg-0&segment=message'`);
    for (let attempt = 0; attempt < 80; attempt++) {
      if ((await command('eval', `document.querySelector('.transcript .reader-process')?.open === false &&
        document.querySelector('.reader-page-controls button:last-child')?.disabled === false`)).includes('true')) break;
      await sleep(100);
    }
    assert.equal(await command('eval', `document.querySelector('.transcript .reader-process').open`), 'false');

    await command('eval', `document.querySelector('.reader-page-controls button:last-child').click()`);
    for (let attempt = 0; attempt < 80; attempt++) {
      if ((await command('eval', `document.querySelector('.transcript .reader-process')?.getAttribute('data-reader-process-loaded-count') === '63'`)).includes('true')) break;
      await sleep(100);
    }
    const continued = JSON.parse(await command('eval', `(() => {
      const transcript = document.querySelector('.transcript');
      const process = transcript?.querySelector('.reader-process');
      return { loaded: process?.getAttribute('data-reader-process-loaded-count'),
        total: process?.getAttribute('data-reader-process-count'),
        processes: [...(transcript?.querySelectorAll('.reader-process') ?? [])].map(node => [node.getAttribute('data-reader-process-loaded-count'), node.getAttribute('data-reader-process-count')]),
        range: document.querySelector('.reader-page-controls:last-of-type span')?.textContent ?? '',
        error: document.querySelector('.reader-page-controls + .content-error')?.textContent ?? '',
        openingCount: [...(transcript?.querySelectorAll('article.event-card') ?? [])].filter(card =>
          card.dataset.messageId + ' / ' + card.dataset.segment === 'msg-0 / message').length };
    })()`));
    assert.equal(continued.loaded, '63', JSON.stringify(continued));
    assert.equal(continued.total, '84');
    assert.equal(continued.openingCount, 1);

    const laterHash = `#event?messageId=${encodeURIComponent(laterProcessItem.event.messageId)}&segment=${encodeURIComponent(laterProcessItem.event.segment)}`;
    const laterCode = `${laterProcessItem.event.messageId} / ${laterProcessItem.event.segment}`;
    await command('eval', `window.location.hash = ${JSON.stringify(laterHash)}`);
    for (let attempt = 0; attempt < 80; attempt++) {
      if ((await command('eval', `document.querySelector('.reader-page-controls:last-of-type span')?.textContent?.includes('65–96') &&
        document.querySelector('.transcript .reader-process')?.open === true`)).includes('true')) break;
      await sleep(100);
    }
    const later = JSON.parse(await command('eval', `(() => {
      const transcript = document.querySelector('.transcript');
      const process = transcript?.querySelector('.reader-process');
      const codes = [...(transcript?.querySelectorAll('article.event-card') ?? [])]
        .map(article => article.dataset.messageId + ' / ' + article.dataset.segment);
      return { total: process?.getAttribute('data-reader-process-count'),
        loaded: process?.getAttribute('data-reader-process-loaded-count'),
        openingCount: codes.filter(value => value === 'msg-0 / message').length,
        targetCount: codes.filter(value => value === ${JSON.stringify(laterCode)}).length };
    })()`));
    assert.deepEqual(later, { total: '84', loaded: '21', openingCount: 0, targetCount: 1 });
  });
