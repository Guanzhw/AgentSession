import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

// Explicit opt-in: AGENTSESSION_V3_THREE_LEVEL_MANIFEST names the private frozen
// manifest {root, chain:[{id,frozen,sha256,parentId?}, ...]} in parent-first order.
// AGENTSESSION_V3_BIN is the exact executable under acceptance. Optional
// AGENTSESSION_V3_BIN_SHA256 pins its expected digest. Source text and private
// paths never enter test output; only hashes/counts are retained in ignored tmp.
// This selected corpus has 326 child / 39 grandchild owned Reader events. It
// does not establish complete root history or an independent inherited oracle.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const manifestFile = process.env.AGENTSESSION_V3_THREE_LEVEL_MANIFEST;
const binary = process.env.AGENTSESSION_V3_BIN;
const browserName = process.platform === 'win32'
  ? 'agent-browser-win32-x64.exe' : `agent-browser-${process.platform}-${process.arch}`;
const browser = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
  (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', browserName))
    .find(existsSync);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const textHash = value => createHash('sha256').update(value).digest('hex');
async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

test('opt-in frozen three-level Reader preserves late search, complete child history and navigation',
  { skip: !manifestFile && 'Set AGENTSESSION_V3_THREE_LEVEL_MANIFEST and AGENTSESSION_V3_BIN to opt in',
    timeout: 900_000 }, async () => {
    let phase = 'validate-input';
    let server;
    let serverClosed;
    let browserUsed = false;
    let scratch;
    let manifest;
    let operation = 'setup';
    const report = { schemaVersion: 1, checks: [], passed: false };
    const session = `v3-three-real-${process.pid}-${Date.now()}`;
    async function command(...args) {
      operation = `browser:${args[0]}`;
      return new Promise((resolve, reject) => {
        const child = spawn(browser, ['--session', session, ...args],
          { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const timeout = setTimeout(() => { child.kill(); reject(new Error('browser_timeout')); }, 45_000);
        child.stdout.on('data', bytes => { output += bytes; });
        child.stderr.resume();
        child.once('error', () => { clearTimeout(timeout); reject(new Error('browser_start_failed')); });
        child.once('exit', code => {
          clearTimeout(timeout);
          code === 0 ? resolve(output.trim()) : reject(new Error('browser_command_failed'));
        });
      });
    }
    const evaluate = async expression => JSON.parse(await command('eval', '-b',
      Buffer.from(expression).toString('base64')));
    async function waitFor(expression, label, timeout = 120_000) {
      operation = `wait:${label}`;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await evaluate(`Boolean(${expression})`)) return;
        operation = `wait:${label}`;
        await sleep(150);
      }
      throw new Error(label);
    }
    try {
      assert.ok(binary && existsSync(binary), 'exact binary required');
      assert.ok(browser && existsSync(browser), 'installed agent-browser required');
      manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
      assert.equal(manifest.chain.length, 3);
      const ids = manifest.chain.map(row => row.id);
      assert.equal(new Set(ids).size, 3);
      assert.equal(manifest.chain[1].parentId, ids[0]);
      assert.equal(manifest.chain[2].parentId, ids[1]);
      report.binarySha256 = await fileHash(binary);
      if (process.env.AGENTSESSION_V3_BIN_SHA256)
        assert.equal(report.binarySha256, process.env.AGENTSESSION_V3_BIN_SHA256);
      report.manifestSha256 = await fileHash(manifestFile);
      report.sourceBefore = await Promise.all(manifest.chain.map(row => fileHash(row.frozen)));
      assert.deepEqual(report.sourceBefore, manifest.chain.map(row => row.sha256));

      await mkdir(path.join(repo, 'tmp'), { recursive: true });
      scratch = await mkdtemp(path.join(repo, 'tmp', 'v3-three-level-real-'));
      const dirs = Object.fromEntries(['meta', 'index', 'cache', 'claude', 'pi', 'dsh']
        .map(name => [name, path.join(scratch, name)]));
      await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
      const config = path.join(scratch, 'config.json');
      await writeFile(config, '{}\n');
      const port = await freeFetchSafePort();
      const origin = `http://127.0.0.1:${port}`;
      server = spawn(binary, ['--config', config, 'serve', '--port', String(port),
        '--codex-dir', manifest.root, '--opencode-db', path.join(scratch, 'absent.db'),
        '--claude-dir', dirs.claude, '--pi-dir', dirs.pi, '--dsh-dir', dirs.dsh,
        '--meta-dir', dirs.meta, '--index-dir', dirs.index, '--cache-dir', dirs.cache,
        '--disable-terminal-launch'], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let spawnFailed = false;
      serverClosed = new Promise(resolve => {
        server.once('error', () => { spawnFailed = true; resolve(); });
        server.once('close', resolve);
      });
      // Provider errors may contain paths or transcript fragments: consume them
      // without copying raw process output into public test diagnostics.
      server.stdout.resume(); server.stderr.resume();
      phase = 'server-start';
      let ready = false;
      for (let attempt = 0; attempt < 600; attempt++) {
        assert.ok(!spawnFailed && server.exitCode === null, 'owned server exited');
        try { ready = (await fetch(origin + '/api/providers', { signal: AbortSignal.timeout(1000) })).ok; }
        catch { /* The owned service is still starting. */ }
        if (ready) break;
        await sleep(100);
      }
      assert.ok(ready, 'owned server readiness');
      async function json(route) {
        const response = await fetch(origin + route, { signal: AbortSignal.timeout(180_000) });
        assert.equal(response.status, 200, 'read-only API status');
        return response.json();
      }
      const endpoint = (level, action) => `/api/v3/reader/codex/${encodeURIComponent(ids[level])}/${action}`;
      phase = 'source-content-oracle';
      const rows = (await readFile(manifest.chain[2].frozen, 'utf8')).trim().split('\n').map(JSON.parse);
      const messages = rows.filter(row => row.type === 'response_item' &&
        row.payload?.type === 'message' && row.payload.role === 'assistant')
        .map(row => ({ id: row.payload.id,
          body: row.payload.content.map(block => block.text || '').join('\n') }))
        .filter(row => row.body);
      assert.ok(messages.length > 0, 'raw assistant messages');
      const target = messages.at(-1);
      const query = target.body.split('\n').map(line => line.trim()).filter(line => line.length >= 24)
        .at(-1)?.slice(0, 64);
      assert.ok(query, 'source-backed literal search term');
      const grandchild = await json(endpoint(2, 'bootstrap'));
      const child = await json(endpoint(1, 'bootstrap'));
      assert.equal(grandchild.totalItems, 39);
      assert.equal(child.totalItems, 326);
      assert.ok(!grandchild.segments.flatMap(segment => segment.items)
        .some(item => item.event.messageId === target.id), 'target is outside bootstrap page');
      report.content = [];
      for (const message of messages) {
        let offset = 0;
        const parts = [];
        let pages = 0;
        for (;;) {
          const params = new URLSearchParams({ revision: grandchild.revision, messageId: message.id,
            segment: 'message', field: 'body', offset: String(offset), maxChars: '97' });
          const page = await json(endpoint(2, 'content') + '?' + params);
          parts.push(page.text); pages++;
          if (page.nextOffset === null) break;
          assert.ok(page.nextOffset > offset && pages < 1000, 'bounded progressing content');
          offset = page.nextOffset;
        }
        assert.equal(textHash(parts.join('')), textHash(message.body), 'raw assistant body hash');
        report.content.push({ chars: message.body.length, pages, sha256: textHash(message.body) });
      }
      const searchPage = await json(endpoint(2, 'search') + '?' + new URLSearchParams({
        q: query, revision: grandchild.revision, limit: '25',
      }));
      report.searchOracle = { matches: searchPage.matches.length,
        targetFound: searchPage.matches.some(match => match.event.messageId === target.id &&
          match.field === 'body') };
      assert.ok(report.searchOracle.targetFound, 'late source search oracle');
      const pane = level => `section.inline-child-reader[aria-label="Child session ${ids[level]}"]`;
      const toggle = level => '#child-toggle-' + Buffer.from('codex\0' + ids[level]).toString('hex');
      const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
      const ownedCards = level => `[...${q(pane(level))}.querySelectorAll('article.event-card')]
        .filter(card => card.closest('.inline-child-reader') === ${q(pane(level))})`;
      async function click(selector) {
        await waitFor(`${q(selector)} && !${q(selector)}.disabled`, 'control_ready');
        await command('snapshot', '-i');
        await command('click', selector);
      }
      async function owners() {
        assert.ok(await evaluate(`document.querySelector('.reader-context .context-source > code')
          ?.textContent.trim() === ${JSON.stringify(ids[0])} &&
          location.pathname === ${JSON.stringify('/codex/session/' + ids[0])}`), 'root owner retained');
        assert.equal(await evaluate("document.querySelectorAll('.inline-child-reader').length"), 2);
        for (const level of [1, 2]) {
          assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(pane(level))}).length`), 1);
          assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(toggle(level))}).length`), 1);
        }
      }
      const fragment = '#child?' + new URLSearchParams({ provider: 'codex', sessionId: ids[2],
        path: JSON.stringify(ids.slice(1).map(sessionId => ({ provider: 'codex', sessionId }))) });
      phase = 'initial-nested-panes';
      browserUsed = true;
      await command('open', origin + '/codex/session/' + encodeURIComponent(ids[0]) + fragment);
      await command('set', 'viewport', '1440', '900');
      await waitFor(q(pane(2)), 'grandchild_ready', 240_000);
      await owners();
      assert.equal(await evaluate(`${ownedCards(2)}.length`), 32);
      report.initialVisibility = await evaluate(`({
        paneHiddenByDetails: Boolean(${q(pane(2))}?.closest('details:not([open])')),
        searchHiddenByDetails: Boolean(${q(pane(2) + ' > .pane-search button[type="submit"]')}?.closest('details:not([open])')),
        paneRects: ${q(pane(2))}?.getClientRects().length ?? 0
      })`);
      assert.equal(report.initialVisibility.paneHiddenByDetails, false, 'grandchild pane visible');
      assert.equal(report.initialVisibility.searchHiddenByDetails, false, 'grandchild search visible');
      assert.ok(report.initialVisibility.paneRects > 0, 'grandchild pane has layout');
      assert.ok(await evaluate(`!${ownedCards(2)}.some(card =>
        card.dataset.messageId + ' / ' + card.dataset.segment ===
        ${JSON.stringify(target.id + ' / message')})`), 'late target not mounted before search');
      phase = 'unloaded-late-search';
      const search = pane(2) + ' > .pane-search';
      await command('snapshot', '-i');
      await command('fill', search + ' input', query);
      await command('press', 'Enter');
      await waitFor(q(search + ' .pane-search-result'), 'source_search_result');
      await click(search + ' .pane-search-result');
      const correctHit = `${q(pane(2) + ' .search-reveal')}?.closest('article.event-card')?.dataset.messageId === ${JSON.stringify(target.id)}
        && ${q(pane(2) + ' .search-reveal')}?.closest('article.event-card')?.dataset.segment === 'message'
        && ${q(pane(2) + ' .search-reveal mark')}?.textContent === ${JSON.stringify(query)}`;
      await waitFor(correctHit, 'precise_late_source_hit');
      await owners();
      report.checks.push('unloaded-grandchild-search');
      phase = 'reload-back-forward';
      await command('reload'); await waitFor(correctHit, 'reload_hit', 240_000); await owners();
      await command('back'); await waitFor(`${q(pane(2))} && !${q(pane(2) + ' .search-reveal')}`, 'back_hit');
      await owners();
      await command('forward'); await waitFor(correctHit, 'forward_hit'); await owners();
      report.checks.push('reload-back-forward-owner');
      phase = 'collapse-focus-scroll';
      await evaluate(`${q(toggle(2))}.scrollIntoView({block:'center',behavior:'instant'}); true`);
      const beforeTop = await evaluate(`${q(toggle(2))}.getBoundingClientRect().top`);
      await click(toggle(2)); await waitFor(`!${q(pane(2))}`, 'collapsed_grandchild');
      assert.ok(await evaluate(`document.activeElement.id === ${JSON.stringify(toggle(2).slice(1))}`));
      const afterTop = await evaluate(`${q(toggle(2))}.getBoundingClientRect().top`);
      assert.ok(Math.abs(beforeTop - afterTop) < 2, 'collapse insertion position restored');
      report.collapseDeltaPx = Math.abs(beforeTop - afterTop);
      await command('back'); await waitFor(q(pane(2)), 'back_collapse'); await owners();
      await command('forward'); await waitFor(`!${q(pane(2))}`, 'forward_collapse');
      await click(toggle(2)); await waitFor(q(pane(2)), 'reexpanded_grandchild'); await owners();
      phase = 'complete-owned-history';
      for (const [level, total] of [[2, 39], [1, 326]]) {
        for (let page = 0; page < 30; page++) {
          const next = pane(level) + ' > .inline-child-next';
          if (!await evaluate(`Boolean(${q(next)})`)) break;
          const before = await evaluate(`${ownedCards(level)}.length`);
          await click(next);
          await waitFor(`${ownedCards(level)}.length > ${before}`, 'child_page_progress');
        }
        assert.equal(await evaluate(`${ownedCards(level)}.length`), total, 'complete owned event count');
        assert.ok(await evaluate(`!${q(pane(level) + ' > .inline-child-next')}`));
      }
      await owners();
      report.checks.push('unique-panes-complete-39-326', 'collapse-focus-position');
      assert.equal((await command('errors')).trim(), '', 'browser uncaught errors');
      report.passed = true;
    } catch (error) {
      // Avoid assertion diffs, parser errors or browser errors exposing private
      // source text/paths. Operation names and failure classes are fixed locally.
      report.failure = { phase, operation, code: error?.code ||
        (error?.message === 'browser_timeout' ? 'browser_timeout' : 'check_failed') };
      throw new Error(`three-level acceptance failed at ${phase} (${operation})`);
    } finally {
      if (browserUsed) await command('close').catch(() => { report.browserCloseFailed = true; });
      if (server && server.exitCode === null && server.signalCode === null) server.kill();
      if (serverClosed) await serverClosed;
      if (manifest?.chain && report.sourceBefore) {
        try {
          report.sourceAfter = await Promise.all(manifest.chain.map(row => fileHash(row.frozen)));
          report.sourceUnchanged = JSON.stringify(report.sourceAfter) === JSON.stringify(report.sourceBefore);
        } catch { report.sourceUnchanged = false; }
      }
      report.passed = report.passed && report.sourceUnchanged === true && !report.browserCloseFailed;
      if (scratch) await writeFile(path.join(scratch, 'evidence.json'), JSON.stringify(report, null, 2) + '\n');
      assert.notEqual(report.sourceUnchanged, false, 'frozen source hashes changed');
      assert.ok(!report.browserCloseFailed, 'owned browser cleanup');
    }
  });
