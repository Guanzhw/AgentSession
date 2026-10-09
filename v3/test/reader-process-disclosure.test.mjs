import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const id = '88888888-8888-4888-8888-888888888888';
const fixture = path.join(repo, 'v3', 'fixtures', 'codex-reader-process', 'sessions', '2026', '09', '27',
  `rollout-2026-09-27T04-00-00-${id}.jsonl`);
const executionFixture = path.join(repo, 'v3', 'fixtures', 'codex-process', 'sessions', '2026', '09', '27',
  'rollout-2026-09-27T03-00-00-99999999-9999-4999-8999-999999999999.jsonl');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');

function agentBrowserBinary() {
  const name = process.platform === 'win32' ? 'agent-browser-win32-x64.exe' :
    `agent-browser-${process.platform}-${process.arch}`;
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(entry, 'node_modules', 'agent-browser', 'bin', name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function browserCommand(binary, session, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--session', session, ...args],
      { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else reject(new Error(`agent-browser ${args[0]} failed: ${output}`));
    });
    child.once('error', reject);
  });
}

async function freePort() {
  return freeFetchSafePort();
}

test('Reader projects recorded phases and complete process runs across pages', { timeout: 60_000 }, async t => {
  const original = createHash('sha256').update(await readFile(fixture)).digest('hex');
  const root = await mkdtemp(path.join(repo, 'tmp', 'v3-reader-process-'));
  const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']
    .map(name => [name, path.join(root, name)]));
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
  const sessionDir = path.join(dirs.codex, 'sessions', '2026', '09', '27');
  await mkdir(sessionDir, { recursive: true });
  const copied = path.join(sessionDir, path.basename(fixture));
  await copyFile(fixture, copied);
  const executionHash = createHash('sha256').update(await readFile(executionFixture)).digest('hex');
  const copiedExecution = path.join(sessionDir, path.basename(executionFixture));
  await copyFile(executionFixture, copiedExecution);
  t.after(async () => {
    assert.equal(createHash('sha256').update(await readFile(fixture)).digest('hex'), original);
    assert.equal(createHash('sha256').update(await readFile(copied)).digest('hex'), original);
    assert.equal(createHash('sha256').update(await readFile(executionFixture)).digest('hex'), executionHash);
    assert.equal(createHash('sha256').update(await readFile(copiedExecution)).digest('hex'), executionHash);
    await rm(root, { recursive: true, force: true });
  });
  const port = await freePort();
  const child = spawn(binary, ['serve', '--port', String(port), '--codex-dir', dirs.codex,
    '--opencode-db', path.join(root, 'missing.db'), '--claude-dir', dirs.claude,
    '--pi-dir', dirs.pi, '--dsh-dir', dirs.dsh, '--meta-dir', dirs.meta,
    '--index-dir', dirs.index, '--cache-dir', dirs.cache], { cwd: repo, windowsHide: true, stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error('isolated server exited');
    try { if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } }
    catch { /* Indexing. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready);
  const bootstrap = await (await fetch(`${base}/api/v3/reader/codex/${id}/bootstrap`)).json();
  assert.equal(bootstrap.segments[0].items.length, 32);
  const next = await (await fetch(`${base}/api/v3/reader/codex/${id}/segments?cursor=${encodeURIComponent(bootstrap.segments[0].nextCursor)}`)).json();
  const items = [...bootstrap.segments[0].items, ...next.page.items];
  const byId = new Map(items.map(item => [item.event.messageId, item]));
  assert.equal(byId.get('c1').presentationPhase, 'commentary');
  assert.equal(byId.get('r1').event.segment, 'thinking');
  assert.equal(byId.get('r1').processId, byId.get('c1').processId);
  assert.equal(byId.get('f1').presentationPhase, 'final_answer');
  assert.equal(byId.get('unknown').presentationPhase, null);
  assert.equal(byId.get('tail').processId, null, 'unfinished commentary stays outside disclosure');
  assert.equal(byId.get('c1').processId, byId.get('t30').processId, 'one process crosses page boundary');
  assert.equal(byId.get('c1').processCount, 33, 'the complete sequence supplies the count on page one');
  assert.equal(byId.get('t30').processCount, 33);
  assert.notEqual(byId.get('c1').processId, null);
  assert.equal(byId.get('f1').processId, null);
  assert.equal(byId.get('unknown').processId, null);
  assert.equal(byId.get('last-tool').processId, byId.get('step-4').processId,
    'trailing tool joins the five process messages');
  assert.equal(byId.get('progress').processId, null, 'readable progress remains outside disclosure');
  assert.equal(new Set(items.map(item => `${item.event.messageId}/${item.event.segment}`)).size, items.length);
  const reasoning = await (await fetch(`${base}/api/v3/reader/codex/${id}/content?revision=${encodeURIComponent(bootstrap.revision)}&messageId=r1&segment=thinking&field=body&offset=0&maxChars=200`)).json();
  assert.equal(reasoning.text, 'Recorded thought for first process');
  assert.equal(bootstrap.toc.entries.find(entry => entry.event.messageId === 't30').processId, byId.get('c1').processId);
  assert.equal(bootstrap.toc.entries.find(entry => entry.event.messageId === 'c1').processCount, 33,
    'The outline carries the full process count across Reader pages');
  const location = await (await fetch(`${base}/api/v3/reader/codex/${id}/locate?revision=${encodeURIComponent(bootstrap.revision)}&messageId=t30&segment=tool`)).json();
  assert.equal(location.event.messageId, 't30');
  assert.equal(location.ordinal, byId.get('t30').ordinal);
  const returned = await (await fetch(`${base}/api/v3/reader/codex/99999999-9999-4999-8999-999999999999/bootstrap`)).json();
  const returnTool = returned.segments[0].items.find(item => item.event.messageId === 'stop');
  assert.equal(returnTool.processId, null, 'recorded execution return remains a visible boundary');

  await t.test('browser folds process and opens the original source anchor',
    { skip: !agentBrowserBinary() && 'agent-browser unavailable' }, async () => {
      const session = `v3-web03-${process.pid}-${Date.now()}`;
      const command = (...args) => browserCommand(agentBrowserBinary(), session, ...args);
      t.after(async () => { try { await command('close'); } catch { /* Browser cleanup. */ } });
      await command('open');
      await command('eval', `window.location.href = ${JSON.stringify(`${base}/codex/session/${id}`)}`);
      for (let attempt = 0; attempt < 80; attempt++) {
        if ((await command('eval', `Boolean(document.querySelector('details.reader-process'))`)).includes('true')) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const initial = JSON.parse(await command('eval', `(() => {
        const process = document.querySelector('details.reader-process');
        return { count: process?.getAttribute('data-reader-process-count'), open: process?.open,
          visible: document.querySelector('[aria-label="Session transcript"]')?.innerText ?? '' };
      })()`));
      assert.equal(initial.count, '33');
      assert.equal(initial.open, false);
      assert.ok(!initial.visible.includes('Working through recorded steps'));
      await command('eval', `document.querySelector('.reader-page-controls button:last-child')?.click()`);
      for (let attempt = 0; attempt < 80; attempt++) {
        if ((await command('eval', `document.querySelector('details.reader-process')?.getAttribute('data-reader-process-loaded-count')`)).includes('33')) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const expanded = JSON.parse(await command('eval', `(() => {
        const processes = [...document.querySelectorAll('details.reader-process')];
        return { counts: processes.map(node => node.getAttribute('data-reader-process-count')),
          visible: document.querySelector('[aria-label="Session transcript"]')?.innerText ?? '' };
      })()`));
      assert.deepEqual(expanded.counts, ['33', '1', '6']);
      assert.ok(expanded.visible.includes('Unknown phase remains visible'));
      assert.ok(expanded.visible.includes('Unfinished commentary remains visible'));
      assert.ok(expanded.visible.includes('Readable progress before tools'));
      const anchors = JSON.parse(await command('eval', `(() => {
        const codes = [...document.querySelectorAll('[aria-label="Session transcript"] article.event-card')]
          .map(article => article.dataset.messageId + ' / ' + article.dataset.segment);
        return { reasoning: codes.filter(value => value === 'r1 / thinking').length,
          tool: codes.filter(value => value === 't30 / tool').length };
      })()`));
      assert.deepEqual(anchors, { reasoning: 1, tool: 1 });
      await command('eval', `window.location.hash = '#event?messageId=t30&segment=tool'`);
      for (let attempt = 0; attempt < 80; attempt++) {
        if ((await command('eval', `Boolean([...document.querySelectorAll('details.reader-process')].some(node => node.open))`)).includes('true')) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const linked = JSON.parse(await command('eval', `(() => {
        const target = document.querySelector('article[data-message-id="t30"][data-segment="tool"]');
        return { open: target?.closest('details.reader-process')?.open ?? false,
          source: target?.dataset.messageId === 't30' && target?.dataset.segment === 'tool' };
      })()`));
      assert.equal(linked.open, true);
      assert.equal(linked.source, true);
      await command('eval', `document.querySelector('details.reader-process').open = false`);
      await command('click', '.reader-find-toggle');
      await command('fill', '.pane-search[data-scope="session"] input[type="search"]', 't30 result');
      let submitReady = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        submitReady = (await command('eval', `Boolean(document.querySelector('.pane-search[data-scope="session"] button[type="submit"]:not(:disabled)'))`)).includes('true');
        if (submitReady) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(submitReady, 'filled process query enables session search');
      await command('eval', `document.querySelector('.pane-search[data-scope="session"] button[type="submit"]')?.click()`);
      let searchSnapshot;
      for (let attempt = 0; attempt < 160; attempt++) {
        searchSnapshot = JSON.parse(await command('eval', `(() => {
          const pane = document.querySelector('.pane-search[data-scope="session"]');
          const result = pane?.querySelector('.pane-search-result');
          const snapshot = {
            route: location.pathname + location.hash,
            input: pane?.querySelector('input[type="search"]')?.value ?? null,
            status: pane?.querySelector('.pane-search-state')?.textContent.trim() ?? null,
            error: pane?.querySelector('.content-error')?.textContent.trim() ?? null,
            resultCount: pane?.querySelectorAll('.pane-search-result').length ?? 0,
            submitDisabled: pane?.querySelector('button[type="submit"]')?.disabled ?? null,
            readerMounted: Boolean(document.querySelector('.reader-layout')),
            clicked: Boolean(result)
          };
          result?.click();
          return snapshot;
        })()`));
        if (searchSnapshot.clicked) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(searchSnapshot?.clicked, true,
        `Recorded process result must appear before opening it: ${JSON.stringify(searchSnapshot)}`);
      for (let attempt = 0; attempt < 80; attempt++) {
        if ((await command('eval', `Boolean(document.querySelector('details.reader-process')?.open && document.querySelector('.search-reveal'))`)).includes('true')) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const search = JSON.parse(await command('eval', `(() => ({
        open: document.querySelector('details.reader-process')?.open ?? false,
        source: document.querySelector('article[data-message-id="t30"][data-segment="tool"] .search-reveal') !== null
      }))()`));
      assert.equal(search.open, true, `Search did not open the recorded process: ${JSON.stringify({ searchSnapshot, search })}`);
      assert.equal(search.source, true, `Search did not reveal the source: ${JSON.stringify({ searchSnapshot, search })}`);
    });
});
