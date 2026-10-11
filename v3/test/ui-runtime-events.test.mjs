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

async function screenshot(name, filename, full = false) {
  const directory = process.env.AGENTSESSION_V3_JOURNEY_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await browserCommand(name, 'screenshot', ...(full ? ['--full'] : []), path.join(directory, filename));
}

test('real Axum Reader opens bounded partial Runtime events and returns to exact source',
  { skip: !existsSync(binary) || !browser ? 'Build the v3 binary and install agent-browser' : false, timeout: 120_000 },
  async t => {
    const before = sha256(fixture);
    await mkdir(path.join(repo, 'tmp'), { recursive: true });
    const work = await mkdtemp(path.join(repo, 'tmp', 'v3-ui-runtime-'));
    t.after(() => rm(work, { recursive: true, force: true }));
    for (const name of ['meta', 'index', 'cache', 'claude', 'pi']) await mkdir(path.join(work, name));
    const sourceRoot = path.join(work, 'codex');
    const source = path.join(sourceRoot, 'sessions', '2026', '09', '26', path.basename(fixture));
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, readFileSync(fixture, 'utf8') + '{"type":');
    const sourceHash = sha256(source);
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const args = ['serve', '--port', String(port), '--codex-dir', sourceRoot,
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
    const reader = await (await fetch(`${base}/api/v3/reader/codex/${sessionId}/bootstrap`)).json();
    assert.notEqual(page.revision, reader.revision, 'Runtime hashes the full static unfinished tail while Reader captures complete records');
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
    await browserCommand(name, 'eval', `window.__runtimeLocateRequests=[];
      window.__runtimeNavigationFetch=window.fetch.bind(window);
      window.fetch=(input,init)=>{if(String(input).includes('/locate?')) window.__runtimeLocateRequests.push(String(input));
        return window.__runtimeNavigationFetch(input,init)}`);
    await browserCommand(name, 'click', '.runtime-event a');
    await waitFor(name, `document.querySelector('.transcript') && location.hash.includes('tool-call-1')`,
      'source anchor in Conversation');
    assert.equal(await browserCommand(name, 'eval',
      `window.__runtimeLocateRequests.some(url => new URL(url, location.origin).searchParams.get('sourceRevision') === ${JSON.stringify(page.revision)})`),
    'true', 'the source jump passes the Runtime strict revision to the owning Reader locate boundary');
    await browserCommand(name, 'back');
    await waitFor(name, `document.querySelector('.runtime-category')?.value === 'tool' &&
      document.querySelector('.runtime-kind')?.value === 'tool.call' &&
      document.querySelectorAll('.runtime-event').length === 1`, 'applied Events filters after source Back');
    assert.equal(await browserCommand(name, 'eval', `location.hash.startsWith('#runtime?')`), 'true',
      'entering Technical details directly from Conversation creates a returnable Runtime entry');
    await screenshot(name, 'runtime-events-filtered-back.png');
    await browserCommand(name, 'forward');
    await waitFor(name, `document.querySelector('.transcript') && location.hash.includes('tool-call-1')`,
      'the exact source event after Forward');
    assert.equal(await browserCommand(name, 'eval',
      `new URLSearchParams(location.hash.slice(7)).get('sourceRevision') === ${JSON.stringify(page.revision)}`),
    'true', 'Forward retains the strict source revision');
    await browserCommand(name, 'back');
    await waitFor(name, `document.querySelector('.runtime-kind')?.value === 'tool.call' &&
      document.querySelectorAll('.runtime-event').length === 1`, 'Runtime before transport failure checks');

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
      [409, 'source_changed', 'Source revision changed'],
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
    const toolEvent = page.events.find(event => event.kind === 'tool.call');
    const second = { ...page, events: Array.from({ length: 18 }, (_, index) => ({ ...toolEvent, id: `page-two-${index}` })),
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
    assert.equal(Number(await browserCommand(name, 'get', 'count', '.runtime-event')), second.events.length,
      'next page replaces the current bounded page');

    await browserCommand(name, 'eval', `document.querySelectorAll('.runtime-event')[10].scrollIntoView({block:'center'});
      window.__runtimeReturnScroll = window.scrollY`);
    assert.equal(await browserCommand(name, 'eval', 'window.__runtimeReturnScroll > 300'), 'true',
      'the bounded second page provides real scroll context');
    await browserCommand(name, 'eval', `document.querySelectorAll('.runtime-event')[10].querySelector('a').click()`);
    await waitFor(name, `document.querySelector('.transcript') && location.hash.includes('tool-call-1')`,
      'source event from bounded second page');
    await browserCommand(name, 'back');
    await waitFor(name, `document.querySelectorAll('.runtime-event').length === ${second.events.length} &&
      document.querySelector('.runtime-kind')?.value === 'tool.call' &&
      Math.abs(window.scrollY - window.__runtimeReturnScroll) <= 2`, 'second page, filters and scroll restored after Back');
    assert.equal(await browserCommand(name, 'eval',
      `history.state.agentSessionRuntime.events.cursor === 'next-page'`), 'true',
    'restoration saves the request cursor for this page rather than its next cursor');

    await browserCommand(name, 'eval', `document.querySelectorAll('.runtime-event')[10].querySelector('a').click()`);
    await waitFor(name, `document.querySelector('.transcript')`, 'source before changed restored revision');
    await browserCommand(name, 'eval',
      `window.fetch = async (input,init) => String(input).includes('/api/v3/runtime/') ?
        new Response(${JSON.stringify(JSON.stringify({ ...second, revision: 'changed-restored-revision' }))},
          {status:200,headers:{'content-type':'application/json'}}) : window.__realFetch(input,init)`);
    await browserCommand(name, 'back');
    await waitFor(name, `document.querySelector('.runtime-state strong')?.textContent === 'Source revision changed'`,
      'restoration compares the page with the saved source revision');
    assert.equal(Number(await browserCommand(name, 'get', 'count', '.runtime-event a')), 0);
    await browserCommand(name, 'eval',
      `window.fetch = async (input,init) => String(input).includes('/api/v3/runtime/') ?
        new Response(String(input).includes('cursor=') ? ${JSON.stringify(JSON.stringify(second))} : ${JSON.stringify(JSON.stringify(first))},
          {status:200,headers:{'content-type':'application/json'}}) : window.__realFetch(input,init)`);
    await browserCommand(name, 'click', '.runtime-filters button');
    await waitFor(name, `document.querySelector('.runtime-pagination button')`, 'first page after test revision repair');
    await browserCommand(name, 'click', '.runtime-pagination button');
    await waitFor(name, `document.querySelectorAll('.runtime-event').length === ${second.events.length}`, 'second page after test revision repair');

    await browserCommand(name, 'eval', `document.querySelectorAll('.runtime-event')[10].querySelector('a').click()`);
    await waitFor(name, `document.querySelector('.transcript')`, 'source before invalid restored cursor');
    await browserCommand(name, 'eval',
      `window.fetch = async (input,init) => String(input).includes('/api/v3/runtime/') && String(input).includes('cursor=') ?
        new Response(JSON.stringify({error:{code:'invalid_cursor',message:'restored cursor expired'}}),
          {status:400,headers:{'content-type':'application/json'}}) : window.__realFetch(input,init)`);
    await browserCommand(name, 'back');
    await waitFor(name, `document.querySelector('.runtime-state strong')?.textContent === 'Event cursor is stale or invalid'`,
      'restoration preserves the invalid cursor diagnostic');
    assert.equal(Number(await browserCommand(name, 'get', 'count', '.runtime-event a')), 0,
      'an invalid restored cursor cannot silently show a fresh first page');

    await browserCommand(name, 'eval',
      `window.fetch = async (input, init) => String(input).includes('/api/v3/runtime/') ?
        new Response(String(input).includes('cursor=') ? ${JSON.stringify(JSON.stringify({ ...second, revision: 'changed-continuation' }))} : ${JSON.stringify(JSON.stringify(first))},
          {status:200,headers:{'content-type':'application/json'}}) : window.__realFetch(input,init)`);
    await browserCommand(name, 'click', '.runtime-filters button');
    await waitFor(name, `document.querySelector('.runtime-event strong')?.textContent === 'session.meta'`, 'first page before changed continuation');
    await browserCommand(name, 'click', '.runtime-pagination button');
    await waitFor(name, `document.querySelector('.runtime-state strong')?.textContent === 'Source revision changed'`, 'changed Runtime continuation');
    assert.equal(Number(await browserCommand(name, 'get', 'count', '.runtime-event a')), 0);

    await browserCommand(name, 'eval',
      `window.__raceCalls=0; window.fetch=(input,init)=>{
        if(!String(input).includes('/api/v3/runtime/')) return window.__realFetch(input,init);
        if(++window.__raceCalls===1) return new Promise(resolve=>{window.__releaseRuntime=()=>resolve(new Response(${JSON.stringify(JSON.stringify(first))},{status:200,headers:{'content-type':'application/json'}}))});
        return window.__realFetch(input,init);
      }`);
    await browserCommand(name, 'fill', '.runtime-kind', '');
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
    // Fresh cross-domain source jumps must not resolve changed facts into the opened Reader snapshot.
    const baselineSource = readFileSync(fixture, 'utf8') + '{"type":';
    async function assertChangedSourceJump(sourceText, targetId, marker) {
      await writeFile(source, baselineSource);
      await browserCommand(name, 'open', `${base}/codex/session/${sessionId}`);
      await waitFor(name, `location.pathname.includes('/codex/session/${sessionId}') && document.querySelector('#reader-title')`, 'fresh Reader before source change');
      await browserCommand(name, 'eval', `const {agentSessionRuntime,...freshReaderHistory}=history.state??{};
        history.replaceState(freshReaderHistory,'',location.href)`);
      const conversationHash = JSON.parse(await browserCommand(name, 'eval', 'location.hash'));
      await writeFile(source, sourceText);
      const updated = await (await fetch(`${base}/api/v3/runtime/codex/${sessionId}/events`)).json();
      assert.notEqual(updated.revision, page.revision);
      assert.ok(updated.events.some(event => event.readerEvent?.messageId === targetId));
      await browserCommand(name, 'click', 'button.runtime-tab');
      const targetSelector = `.runtime-event a[href*="${targetId}"]`;
      await waitFor(name, `document.querySelector(${JSON.stringify(targetSelector)})`, 'strict Runtime event from changed source');
      await browserCommand(name, 'click', targetSelector);
      await waitFor(name, `document.querySelector('.reader-main .content-error')?.textContent.includes('Refresh this session') &&
        document.querySelector('.conversation-tab[aria-current="page"]') && !location.hash.startsWith('#runtime?')`,
      'explicit cross-domain source change in a Conversation entry');
      assert.equal(await browserCommand(name, 'eval', `location.hash.includes(${JSON.stringify(targetId)})`), 'false',
        'a changed Runtime fact cannot become a successful Reader source anchor');
      assert.equal(JSON.parse(await browserCommand(name, 'eval', 'location.hash')), conversationHash,
        'a failed source jump returns to the previous Conversation URL');
      assert.equal(await browserCommand(name, 'eval', `document.querySelector('.transcript').textContent.includes(${JSON.stringify(marker)})`), 'false');
      if (targetId === 'after-open-event') {
        await screenshot(name, 'runtime-source-changed-conversation.png');
        await browserCommand(name, 'eval', `(() => { const languageSelect=document.querySelector('.language-select');
          languageSelect.value='zh'; languageSelect.dispatchEvent(new Event('change',{bubbles:true})); })()`);
        await waitFor(name, `document.documentElement.lang === 'zh-CN' &&
          document.querySelector('.conversation-tab[aria-current="page"]')?.textContent === '对话'`, 'Chinese Conversation labels');
        await screenshot(name, 'runtime-source-changed-conversation-zh.png');
        assert.equal(await browserCommand(name, 'eval', `document.querySelector('.reader-actions').checkVisibility()`), 'true',
          'Chinese source failure retains visible Conversation actions');
        assert.equal(await browserCommand(name, 'eval', `document.querySelector('.reader-main .content-error').checkVisibility()`), 'true',
          'Chinese source failure retains a visible error');
        assert.equal(await browserCommand(name, 'get', 'text', '.reader-main .content-error'),
          '已记录来源发生变化。请刷新会话后再打开此事件。', 'the recorded source change remains readable in Chinese');
        assert.equal(JSON.parse(await browserCommand(name, 'eval', 'location.hash')), conversationHash,
          'language switching preserves the failed-source Conversation URL');
        await browserCommand(name, 'eval', `(() => { const languageSelect=document.querySelector('.language-select');
          languageSelect.value='en'; languageSelect.dispatchEvent(new Event('change',{bubbles:true})); })()`);
        await waitFor(name, `document.documentElement.lang === 'en' &&
          document.querySelector('.conversation-tab[aria-current="page"]')?.textContent === 'Conversation'`, 'English Conversation labels');
        assert.equal(await browserCommand(name, 'get', 'text', '.reader-main .content-error'),
          'The recorded source changed. Refresh this session before opening this event.',
          'the source diagnostic remains readable after switching back to English');
      }
      await browserCommand(name, 'click', 'button.runtime-tab');
      await waitFor(name, `location.hash.startsWith('#runtime?') &&
        document.querySelector('.runtime-tab[aria-current="page"]') && document.querySelector('.runtime-event a')`,
      'Technical details after the failed source jump');
      await browserCommand(name, 'click', 'button.conversation-tab');
      await waitFor(name, `location.hash === ${JSON.stringify(conversationHash)} &&
        document.querySelector('.conversation-tab[aria-current="page"]')`, 'Conversation tab preserves its prior URL after failure');
      await browserCommand(name, 'eval', 'window.__beforeFailedSourceReload=true; location.reload()');
      await waitFor(name, `!window.__beforeFailedSourceReload && location.hash === ${JSON.stringify(conversationHash)} &&
        document.querySelector('.conversation-tab[aria-current="page"]') && document.querySelector('#reader-title')`,
      'reloading the failed-source Conversation entry keeps its tab and URL');
      await browserCommand(name, 'back');
      await waitFor(name, `location.hash.startsWith('#runtime?') &&
        document.querySelector('.runtime-tab[aria-current="page"]') && document.querySelector('.runtime-event a')`,
      'Back after reload restores the intervening Technical details entry');
      await browserCommand(name, 'back');
      await waitFor(name, `location.hash === ${JSON.stringify(conversationHash)} &&
        document.querySelector('.conversation-tab[aria-current="page"]')`, 'Back restores the failed-source Conversation entry');
    }
    await assertChangedSourceJump(readFileSync(fixture, 'utf8') + JSON.stringify({ type: 'response_item',
      payload: { type: 'message', id: 'after-open-event', role: 'assistant',
        content: [{ type: 'output_text', text: 'AFTER_OPEN_EVENT_MARKER' }] } }) + '\n',
    'after-open-event', 'AFTER_OPEN_EVENT_MARKER');
    await assertChangedSourceJump(baselineSource.replace('Hello 🙂 from the Rust slice. Continue to the complete ending.',
      'SAME_ID_REWRITTEN_MARKER'), 'assistant-1', 'SAME_ID_REWRITTEN_MARKER');
    await writeFile(source, baselineSource);

    await browserCommand(name, 'open', `${base}/codex/session/${sessionId}`);
    await waitFor(name, `document.querySelector('#reader-title') && document.querySelector('.conversation-tab[aria-current="page"]')`,
      'fresh Conversation before a pending locate');
    await browserCommand(name, 'eval', `const {agentSessionRuntime,...freshPendingHistory}=history.state??{};
      history.replaceState(freshPendingHistory,'',location.href)`);
    const pendingConversationHash = JSON.parse(await browserCommand(name, 'eval', 'location.hash'));
    await browserCommand(name, 'click', 'button.runtime-tab');
    await waitFor(name, `document.querySelector('.runtime-event a[href*="tool-call-1"]')`, 'source link before a pending locate');
    await browserCommand(name, 'eval', `window.__beforePendingLocateFetch=window.fetch.bind(window);
      window.fetch=(input,init)=>String(input).includes('/locate?') ?
        new Promise(resolve=>{window.__releasePendingLocate=()=>resolve(new Response(JSON.stringify({error:{code:'source_changed',message:'delayed source changed'}}),
          {status:409,headers:{'content-type':'application/json'}}))}).finally(()=>{window.__pendingLocateSettled=true}) :
        window.__beforePendingLocateFetch(input,init)`);
    await browserCommand(name, 'click', '.runtime-event a[href*="tool-call-1"]');
    await waitFor(name, `window.__releasePendingLocate && location.hash.startsWith('#runtime?') &&
      document.querySelector('.conversation-tab[aria-current="page"]')`, 'pending locate before its source entry resolves');
    await browserCommand(name, 'click', 'button.runtime-tab');
    await waitFor(name, `location.hash.startsWith('#runtime?') && document.querySelector('.runtime-tab[aria-current="page"]') &&
      document.querySelector('.runtime-event a')`, 'Technical details cancels the pending locate');
    await browserCommand(name, 'eval', 'window.fetch=window.__beforePendingLocateFetch; window.__releasePendingLocate()');
    await waitFor(name, `window.__pendingLocateSettled && location.hash.startsWith('#runtime?') &&
      document.querySelector('.runtime-tab[aria-current="page"]') && document.querySelector('.runtime-event a')`,
      'the cancelled locate response keeps the Technical details entry');
    await browserCommand(name, 'click', 'button.conversation-tab');
    await waitFor(name, `location.hash === ${JSON.stringify(pendingConversationHash)} &&
      document.querySelector('.conversation-tab[aria-current="page"]') && !document.querySelector('.reader-main .content-error')`,
      'the cancelled locate cannot replace the prior Conversation hash or add its error');
    await browserCommand(name, 'eval', 'window.__beforePendingLocateReload=true; location.reload()');
    await waitFor(name, `!window.__beforePendingLocateReload && location.hash === ${JSON.stringify(pendingConversationHash)} &&
      document.querySelector('.conversation-tab[aria-current="page"]') && document.querySelector('#reader-title')`,
      'reload after a cancelled locate keeps the Conversation tab');
    await browserCommand(name, 'back');
    await waitFor(name, `location.hash.startsWith('#runtime?') && document.querySelector('.runtime-tab[aria-current="page"]') &&
      document.querySelector('.runtime-event a')`, 'Back after a cancelled locate restores Technical details');

    assert.equal(sha256(source), sourceHash, 'the task-owned unfinished tail remains unchanged');
    assert.equal(sha256(fixture), before, 'Runtime reads must preserve the provider source');
  });

test('real Axum Events second page restores native cursor, filters and scroll after source Back',
  { skip: !existsSync(binary) || !browser ? 'Build the v3 binary and install agent-browser' : false, timeout: 90_000 },
  async t => {
    const before = sha256(fixture);
    await mkdir(path.join(repo, 'tmp'), { recursive: true });
    const work = await mkdtemp(path.join(repo, 'tmp', 'v3-ui-runtime-pagination-'));
    t.after(() => rm(work, { recursive: true, force: true }));
    for (const name of ['meta', 'index', 'cache', 'claude', 'pi', 'dsh']) await mkdir(path.join(work, name));
    const sourceRoot = path.join(work, 'codex');
    const source = path.join(sourceRoot, 'sessions', '2026', '09', '26', path.basename(fixture));
    await mkdir(path.dirname(source), { recursive: true });
    const calls = Array.from({ length: 65 }, (_, index) => {
      const id = `pagination-call-${String(index + 1).padStart(3, '0')}`;
      return [
        { timestamp: '2026-09-26T00:01:00.000Z', type: 'response_item', payload: {
          type: 'function_call', id, call_id: id, name: 'Read', arguments: JSON.stringify({ path: `/synthetic/${id}.txt` }) } },
        { timestamp: '2026-09-26T00:01:01.000Z', type: 'response_item', payload: {
          type: 'function_call_output', id: `${id}-output`, call_id: id, output: `Recorded result for ${id}` } },
      ];
    }).flat();
    await writeFile(source, readFileSync(fixture, 'utf8') + calls.map(JSON.stringify).join('\n') + '\n');
    const sourceHash = sha256(source);
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(binary, ['serve', '--port', String(port), '--codex-dir', sourceRoot,
      '--opencode-db', path.join(work, 'opencode.db'), '--claude-dir', path.join(work, 'claude'),
      '--pi-dir', path.join(work, 'pi'), '--dsh-dir', path.join(work, 'dsh'),
      '--meta-dir', path.join(work, 'meta'), '--index-dir', path.join(work, 'index'),
      '--cache-dir', path.join(work, 'cache'), '--disable-terminal-launch'],
    { cwd: repo, windowsHide: true, stdio: 'ignore' });
    t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'close'); });
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok) break; }
      catch { /* Axum is starting. */ }
      if (attempt === 99) throw new Error('Axum did not start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const query = new URLSearchParams({ category: 'tool', kind: 'tool.call', limit: '25' });
    const first = await (await fetch(`${base}/api/v3/runtime/codex/${sessionId}/events?${query}`)).json();
    assert.equal(first.events.length, 25);
    assert.ok(first.nextCursor, 'the actual native source yields a second bounded page');
    query.set('cursor', first.nextCursor);
    const second = await (await fetch(`${base}/api/v3/runtime/codex/${sessionId}/events?${query}`)).json();
    assert.equal(second.events.length, 25);
    const target = second.events[11].readerEvent;
    assert.ok(target, 'the second native page records an exact Reader source');
    const name = `v3-runtime-pagination-${process.pid}-${Date.now()}`;
    t.after(async () => { try { await browserCommand(name, 'close'); } catch { /* Already closed. */ } });
    await browserCommand(name, 'open', `${base}/codex/session/${sessionId}`);
    await waitFor(name, `document.querySelector('#reader-title')`, 'native pagination Reader');
    await browserCommand(name, 'click', '.runtime-tab');
    await waitFor(name, `document.querySelector('.runtime-category')`, 'Events filters');
    await browserCommand(name, 'fill', '.runtime-category', 'tool');
    await browserCommand(name, 'fill', '.runtime-kind', 'tool.call');
    await browserCommand(name, 'click', '.runtime-filters button');
    await waitFor(name, `document.querySelectorAll('.runtime-event').length === 25 &&
      document.querySelector('.runtime-event a')?.getAttribute('href').includes('tool-call-1')`, 'native filtered first page');
    await screenshot(name, 'runtime-native-events-filtered.png');
    await browserCommand(name, 'click', '.runtime-pagination button');
    const targetSelector = `.runtime-event a[href*="messageId=${target.messageId}"]`;
    await waitFor(name, `document.querySelectorAll('.runtime-event').length === 25 &&
      document.querySelector(${JSON.stringify(targetSelector)})`, 'native bounded second page');
    await browserCommand(name, 'eval', `document.querySelector(${JSON.stringify(targetSelector)}).scrollIntoView({block:'center'});
      window.__nativeRuntimeScroll=scrollY`);
    assert.equal(await browserCommand(name, 'eval', 'window.__nativeRuntimeScroll > 300'), 'true');
    await browserCommand(name, 'eval', `document.querySelector(${JSON.stringify(targetSelector)}).click()`);
    await waitFor(name, `document.querySelector('.conversation-tab[aria-current="page"]') &&
      location.hash.includes(${JSON.stringify(target.messageId)})`, 'exact native second-page source');
    await browserCommand(name, 'back');
    await waitFor(name, `document.querySelectorAll('.runtime-event').length === 25 &&
      document.querySelector(${JSON.stringify(targetSelector)}) &&
      document.querySelector('.runtime-category')?.value === 'tool' &&
      document.querySelector('.runtime-kind')?.value === 'tool.call' &&
      Math.abs(scrollY-window.__nativeRuntimeScroll) <= 2`, 'native second page, applied filters and scroll after Back');
    assert.equal(await browserCommand(name, 'eval',
      `history.state.agentSessionRuntime.events.cursor === ${JSON.stringify(first.nextCursor)}`), 'true');
    await screenshot(name, 'runtime-native-second-page-back.png');
    await screenshot(name, 'runtime-native-second-page-back-full.png', true);
    await browserCommand(name, 'forward');
    await waitFor(name, `document.querySelector('.conversation-tab[aria-current="page"]') &&
      location.hash.includes(${JSON.stringify(target.messageId)})`, 'exact native source after Forward');
    assert.equal((await browserCommand(name, 'errors')).trim(), '');
    assert.equal(sha256(source), sourceHash, 'native pagination leaves the task-owned source unchanged');
    assert.equal(sha256(fixture), before, 'native pagination leaves the public provider fixture unchanged');
  });
