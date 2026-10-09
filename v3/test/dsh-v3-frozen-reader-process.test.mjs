import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const id = 'session-a9f5b448-9851-4872-a266-fdc3381a5061';
const dshDir = path.join(repo, 'tmp', 'v3-corpus', 'deepseek-harness');
const source = path.join(dshDir, 'sessions', '--D-WorkSpace-OpenSession--', id, 'session.v3.jsonl.zstd');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');

function agentBrowserBinary() {
  const override = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN;
  if (override && existsSync(override)) return override;
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
    child.once('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(output)));
    child.once('error', reject);
  });
}

async function freePort() {
  return freeFetchSafePort();
}

test('frozen DSH tool and reasoning turns form a bounded Reader process',
  { timeout: 120_000, skip: !existsSync(source) || !existsSync(binary) }, async t => {
    const sourceHash = createHash('sha256').update(readFileSync(source)).digest('hex');
    const state = await mkdtemp(path.join(repo, 'tmp', 'v3-dsh-reader-process-'));
    const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'meta', 'index', 'cache']
      .map(name => [name, path.join(state, name)]));
    await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
    const port = await freePort();
    const child = spawn(binary, ['serve', '--port', String(port),
      '--codex-dir', dirs.codex, '--opencode-db', path.join(state, 'absent.db'),
      '--claude-dir', dirs.claude, '--pi-dir', dirs.pi, '--dsh-dir', dshDir,
      '--meta-dir', dirs.meta, '--index-dir', dirs.index, '--cache-dir', dirs.cache],
    { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    t.after(async () => {
      if (child.exitCode === null) {
        child.kill();
        await once(child, 'close');
      }
      assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), sourceHash);
      await rm(state, { recursive: true, force: true });
    });
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error('isolated server exited');
      try {
        if ((await fetch(`${origin}/api/providers`, { signal: AbortSignal.timeout(500) })).ok) {
          ready = true;
          break;
        }
      } catch { /* Source indexing may still be running. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready);
    const response = await fetch(`${origin}/api/v3/reader/deepseek-harness/${id}/bootstrap`);
    assert.equal(response.status, 200);
    const bootstrap = await response.json();
    const first = bootstrap.segments[0].items;
    const emptyAssistant = first.filter(item => item.role === 'assistant' &&
      item.event.segment === 'message' && item.totalChars === 0);
    assert.ok(emptyAssistant.length >= 5, 'Frozen opening contains several tool-only assistant turns');
    assert.ok(emptyAssistant.every(item => item.processId !== null),
      `Tool-only assistant turns belong to a collapsed process: ${JSON.stringify(emptyAssistant.map(item =>
        [item.ordinal, item.event.messageId, item.processId]))}; first items ${JSON.stringify(first.slice(0, 8).map(item =>
        [item.ordinal, item.event.segment, item.role, item.owner?.messageId, item.processId]))}; ${stderr}`);
    const owner = emptyAssistant[0];
    const owned = first.filter(item => item.owner?.messageId === owner.event.messageId);
    assert.ok(owned.some(item => item.event.segment === 'thinking'));
    assert.ok(owned.some(item => item.event.segment === 'tool'));
    assert.ok(owned.every(item => item.processId === owner.processId),
      'Recorded reasoning and tools stay with their assistant owner');
    let cursor = bootstrap.segments[0].nextCursor;
    let firstReply = first.find(item => item.role === 'assistant' && item.event.segment === 'message' && item.totalChars > 0);
    let pages = 1;
    while (!firstReply && cursor) {
      const pageResponse = await fetch(`${origin}/api/v3/reader/deepseek-harness/${id}/segments?cursor=${encodeURIComponent(cursor)}`);
      assert.equal(pageResponse.status, 200);
      const page = (await pageResponse.json()).page;
      firstReply = page.items.find(item => item.role === 'assistant' && item.event.segment === 'message' && item.totalChars > 0);
      cursor = page.nextCursor;
      pages++;
      assert.ok(pages < 12, 'Readable reply should be reachable with bounded continuation');
    }
    assert.ok(firstReply, 'The frozen session contains a readable reply');
    assert.equal(firstReply.processId, null, 'Readable reply remains visible outside process disclosure');
    assert.equal(pages, 2, 'One bounded continuation reaches the first readable reply');
    assert.equal(bootstrap.toc.entries[0].role, 'user', 'The outline identifies the request');
    assert.equal(bootstrap.toc.entries[1].processCount, 45,
      'The outline carries the recorded opening process count');
    assert.equal(bootstrap.toc.entries.find(entry => entry.ordinal === firstReply.ordinal)?.role,
      'assistant', 'The outline identifies the readable reply');
    assert.ok(bootstrap.toc.nextCursor, 'The opening outline page has a bounded continuation');
    const continuationResponse = await fetch(`${origin}/api/v3/reader/deepseek-harness/${id}/toc?cursor=${encodeURIComponent(bootstrap.toc.nextCursor)}`);
    assert.equal(continuationResponse.status, 200);
    const continuationPage = (await continuationResponse.json()).toc;
    assert.ok(continuationPage.entries.length > 0 && continuationPage.entries.length <= 64,
      'Outline continuation returns one bounded source page');
    const firstAppendedEntry = continuationPage.entries.find(entry =>
      !bootstrap.toc.entries.some(opening => opening.event.messageId === entry.event.messageId &&
        opening.event.segment === entry.event.segment));
    assert.ok(firstAppendedEntry, 'The next outline page adds a new source event');
    const firstAppendedHref = '#event?' + new URLSearchParams({
      messageId: firstAppendedEntry.event.messageId, segment: firstAppendedEntry.event.segment,
    });

    await t.test('browser shows one collapsed work disclosure and the first readable reply',
      { skip: !agentBrowserBinary() && 'agent-browser unavailable' }, async () => {
        const session = `v3-dsh-reader-${process.pid}-${Date.now()}`;
        const command = (...args) => browserCommand(agentBrowserBinary(), session, ...args);
        t.after(async () => { try { await command('close'); } catch { /* Browser cleanup. */ } });
        await command('open');
        await command('set', 'viewport', '1440', '900');
        await command('eval', `window.location.href = ${JSON.stringify(`${origin}/deepseek-harness/session/${id}`)}`);
        let view;
        for (let attempt = 0; attempt < 80; attempt++) {
          view = JSON.parse(await command('eval', `(() => {
            const transcript = document.querySelector('.transcript');
            const process = transcript?.querySelector('details.reader-process');
            const reply = transcript?.querySelector(':scope > .turn-block > article.assistant-card .event-body');
            return { loaded: [...document.querySelectorAll('.reader-page-controls span')].map(node => node.textContent),
              error: document.querySelector('.reader-main .content-error')?.textContent ?? '',
              hash: window.location.hash,
              processOpen: process?.open ?? null, processCount: process?.getAttribute('data-reader-process-count') ?? null,
              emptyCards: [...(transcript?.querySelectorAll(':scope > .turn-block > article.assistant-card .empty-body') ?? [])].length,
              replyTop: reply?.getBoundingClientRect().top ?? null };
          })()`));
          if (view.replyTop !== null) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(view.processOpen, false, 'Recorded work starts collapsed');
        assert.ok(Number(view.processCount) >= 32, 'The opening work is one disclosure');
        assert.equal(view.emptyCards, 0, 'No empty assistant cards appear in the reading path');
        assert.ok(view.replyTop !== null && view.replyTop < 900,
          `First readable reply is visible at 1440x900: ${JSON.stringify(view)}`);
        const folded = JSON.parse(await command('eval', `(() => {
          const opening = document.querySelector('.reader-outline .outline-turn');
          return { expanded: opening?.querySelector('.outline-turn-toggle')?.getAttribute('aria-expanded'),
            hidden: opening?.querySelector('.outline-children')?.hidden,
            visibleReplies: [...(opening?.querySelectorAll('.outline-children a') ?? [])]
              .filter(link => link.getClientRects().length > 0).length,
            visibleReasoning: [...document.querySelectorAll('.transcript .thinking-card')]
              .filter(card => !card.closest('details:not([open])') && card.checkVisibility()).length,
            messageDetails: document.querySelectorAll('.event-card .source-details').length };
        })()`));
        assert.deepEqual(folded, { expanded: 'false', hidden: true, visibleReplies: 0,
          visibleReasoning: 0, messageDetails: 0 },
        'Requests start folded, recorded reasoning stays inside closed work, and raw message details are removed');
        assert.equal(await command('eval', 'Boolean(document.querySelector(".outline-work-option"))'), 'false',
          'The readable outline contains messages and context checkpoints');
        assert.equal(await command('eval', 'document.querySelector(".outline-turn-toggle")?.getAttribute("aria-expanded")'),
          '"false"', 'The request group starts folded');
        await command('click', '.outline-turn-toggle');
        assert.equal(await command('eval', 'document.querySelector(".outline-turn-toggle")?.getAttribute("aria-expanded")'),
          '"true"', 'The request toggle explicitly reveals its reply and work entries');
        const outline = JSON.parse(await command('eval', `(() => {
          const nav = document.querySelector('.reader-outline nav');
          const opening = nav?.querySelector('.outline-turn');
          const process = opening?.querySelector('details.outline-process');
          const visibleLinks = [...(nav?.querySelectorAll('a') ?? [])]
            .filter(link => link.getClientRects().length > 0)
            .map(link => link.textContent.trim());
          const openingVisibleLinks = [...(opening?.querySelectorAll(':scope > .outline-children > a') ?? [])]
            .filter(link => link.getClientRects().length > 0)
            .map(link => ({ label: link.textContent.trim(), href: link.getAttribute('href') }));
          return { requests: nav?.querySelectorAll('.outline-turn').length ?? 0,
            processes: nav?.querySelectorAll('details.outline-process').length ?? 0,
            openingProcesses: opening?.querySelectorAll('details.outline-process').length ?? 0,
            processOpen: process?.open ?? null,
            processSteps: process?.querySelectorAll('a').length ?? 0,
            processLabel: process?.querySelector('summary')?.textContent.trim() ?? '',
            visibleLinks, openingVisibleLinks };
        })()`));
        assert.ok(outline.requests >= 1, 'The outline groups entries under requests');
        assert.equal(outline.openingProcesses, 0, 'Execution work stays in the transcript');
        assert.equal(outline.processSteps, 0, 'Tool and reasoning steps do not create outline entries');
        const firstReplyHref = '#event?' + new URLSearchParams({
          messageId: firstReply.event.messageId, segment: firstReply.event.segment,
        });
        assert.ok(outline.openingVisibleLinks.some(link => link.href === firstReplyHref),
          `The first reply is visible under its request after the work entry: ${JSON.stringify(outline)}`);
        const thought = owned.find(item => item.event.segment === 'thinking');
        await command('eval', `document.querySelector('.transcript details.reader-process > summary').click()`);
        await command('eval', `(() => {
          const reasoning = [...document.querySelectorAll('.transcript .thinking-card')].find(card =>
            card.dataset.messageId === ${JSON.stringify(thought.event.messageId)} && card.dataset.segment === 'thinking');
          const details = reasoning?.closest('.attached-reasoning > details');
          if (details && !details.open) details.querySelector(':scope > summary').click();
        })()`);
        assert.equal(await command('eval', `Boolean([...document.querySelectorAll('.transcript .thinking-card')]
          .some(card => !card.closest('details:not([open])') && card.checkVisibility()))`), 'true',
        'Manually expanding execution work reveals its recorded reasoning');
        await command('eval', `document.querySelector('.transcript details.reader-process > summary').click()`);
        assert.equal(await command('eval', `Boolean([...document.querySelectorAll('.transcript .thinking-card')]
          .some(card => !card.closest('details:not([open])') && card.checkVisibility()))`), 'false',
        'Collapsing execution work hides its recorded reasoning again');
        const thoughtHref = '#event?' + new URLSearchParams({
          messageId: thought.event.messageId, segment: thought.event.segment,
        });
        await command('eval', `location.hash = ${JSON.stringify(thoughtHref)}`);
        let revealed = false;
        for (let attempt = 0; attempt < 80; attempt++) {
          revealed = (await command('eval', `Boolean(location.hash === ${JSON.stringify(thoughtHref)} &&
            [...document.querySelectorAll('.transcript details.reader-process[open] article.thinking-card')].some(card =>
              card.dataset.messageId === ${JSON.stringify(thought.event.messageId)} &&
              card.dataset.segment === 'thinking' && !card.closest('details:not([open])') && card.checkVisibility()))`)) === 'true';
          if (revealed) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(revealed, 'Direct source navigation opens the recorded reasoning inside its disclosure');
        assert.equal(await command('eval', `Boolean([...document.querySelectorAll('.reader-outline a[href]')]
          .find(link => link.getAttribute('href') === ${JSON.stringify(thoughtHref)})?.getClientRects().length)`),
        'false', 'Reasoning remains absent from the outline after direct source navigation');
        await command('click', '.outline-turn-toggle');
        assert.equal(await command('eval', 'document.querySelector(".outline-turn .outline-children")?.hidden'),
          'true', 'The request toggle collapses its children again');
        await command('eval', `location.hash = ${JSON.stringify(firstReplyHref)}`);
        let targetGroupOpened = false;
        for (let attempt = 0; attempt < 80; attempt++) {
          targetGroupOpened = (await command('eval', `Boolean(document.querySelector('.outline-turn-toggle')
            ?.getAttribute('aria-expanded') === 'true' && !document.querySelector('.outline-turn .outline-children')?.hidden)`)) === 'true';
          if (targetGroupOpened) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(targetGroupOpened, 'Direct reply navigation expands its matching request group');
        assert.equal(await command('eval', `Boolean([...document.querySelectorAll('.reader-outline a[href]')]
          .find(link => link.getAttribute('href') === ${JSON.stringify(firstReplyHref)})?.getClientRects().length)`),
        'true', 'The canonical reply outline link is visible after direct navigation');
        await command('select', 'select[aria-label="Language"]', '简体中文');
        const headings = JSON.parse(await command('eval', `(() => [...document.querySelectorAll(
          '.reader-outline .outline-copy > span')]
          .map(node => node.textContent.trim()))()`));
        assert.ok(headings.includes('助手') && headings.includes('推理'),
          `Switching language updates the mounted outline headings: ${JSON.stringify(headings)}`);
        await command('eval', `document.querySelector('.reader-outline .outline-more')?.click()`);
        let continuation;
        for (let attempt = 0; attempt < 80; attempt++) {
          continuation = JSON.parse(await command('eval', `(() => {
            const nav = document.querySelector('.reader-outline nav');
            const request = nav?.querySelector('.outline-request');
            const oldReply = [...(nav?.querySelectorAll('a[href]') ?? [])]
              .some(link => link.getAttribute('href') === ${JSON.stringify(firstReplyHref)});
            const appended = [...(nav?.querySelectorAll('a[href]') ?? [])]
              .some(link => link.getAttribute('href') === ${JSON.stringify(firstAppendedHref)});
            return { requestHref: request?.getAttribute('href') ?? null, oldReply, appended,
              anchors: nav?.querySelectorAll('a[href]').length ?? 0 };
          })()`));
          if (continuation.appended) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const requestHref = '#event?' + new URLSearchParams({
          messageId: bootstrap.toc.entries[0].event.messageId,
          segment: bootstrap.toc.entries[0].event.segment,
        });
        assert.equal(continuation.requestHref, requestHref,
          'The original request anchor remains after the bounded outline continuation');
        assert.equal(continuation.oldReply, true, 'The original readable reply anchor remains');
        assert.equal(continuation.appended, true, 'The continuation appends its new source event anchor');
        assert.ok(continuation.anchors > 0, 'The Reader retains source-linked outline entries');
      });
  });
