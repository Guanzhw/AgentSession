import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const browser = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN || (process.env.PATH || '').split(path.delimiter)
  .map(dir => path.join(dir, 'node_modules/agent-browser/bin', process.platform === 'win32'
    ? 'agent-browser-win32-x64.exe' : `agent-browser-${process.platform}-${process.arch}`)).find(existsSync);
const sha = value => createHash('sha256').update(value).digest('hex');

async function command(session, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(browser, ['--session', session, ...args], { cwd: repo, windowsHide: true });
    let output = ''; let error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Browser command ${args[0]} timed out`)); }, 15_000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy();
      if (code) reject(new Error(error || output)); else resolve(output.trim());
    });
  });
}

async function waitFor(session, expression) {
  let actual;
  for (let i = 0; i < 60; i++) {
    actual = await command(session, 'eval', `Boolean(${expression})`);
    if (actual === 'true') return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`Browser condition did not become true: ${expression}; ${actual}`);
}

test('real pricing Settings and Stats preserve vendor identity, missing evidence and provider selection', {
  skip: !browser ? 'agent-browser is required' : false, timeout: 240_000,
}, async t => {
  const root = await mkdtemp(path.join(repo, 'tmp/v3-ui-pricing-'));
  const evidence = process.env.AGENTSESSION_V3_UI_PRICING_REPORT_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  const session = `v3-pricing-${process.pid}`;
  const staleSession = `${session}-stale`;
  const observations = { binary, binarySha256: sha(await readFile(binary)), fixtureKind: 'constructed provider-owned SQLite/JSONL shapes; actual Rust HTTP and Chromium UI', completed: false, checks: [], sourceHashes: {}, uiSourceHashes: {}, pid: null, port: null };
  for (const file of ['StatsPage.svelte', 'SettingsPage.svelte', 'api.ts', 'i18n.ts']) {
    observations.uiSourceHashes[file] = sha(await readFile(path.join(repo, 'v3/ui/src/lib', file)));
  }
  observations.uiSourceHashes['styles.css'] = sha(await readFile(path.join(repo, 'v3/ui/src/styles.css')));
  let child;
  t.after(async () => {
    observations.browserErrors = {};
    for (const id of [session, staleSession]) {
      observations.browserErrors[id] = await command(id, 'errors').catch(cause => String(cause));
      await command(id, 'close').catch(() => {});
    }
    if (child?.exitCode === null && child.signalCode === null) { const done = once(child, 'close'); child.kill(); await done; }
    observations.childClosed = !child || child.exitCode !== null || child.signalCode !== null;
    for (const source of Object.keys(observations.sourceHashes)) {
      assert.equal(sha(await readFile(source)), observations.sourceHashes[source], 'provider source must remain unchanged');
    }
    if (evidence) await writeFile(path.join(evidence, `browser-${observations.binarySha256.slice(0, 12)}-${process.pid}.json`), JSON.stringify(observations, null, 2));
    assert.equal(path.dirname(root), path.join(repo, 'tmp'));
    await rm(root, { recursive: true, force: true });
  });
  const timestamp = new Date().toISOString();
  observations.fixtureTimestamp = timestamp;
  const dbPath = path.join(root, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT,
    fork_boundary TEXT, title TEXT, slug TEXT, directory TEXT, time_created INTEGER,
    time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
    tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
    time_created INTEGER, time_updated INTEGER, data TEXT);
    INSERT INTO session_v2 VALUES ('pricing',NULL,NULL,NULL,'Pricing fixture','pricing','/fixture',1,2,NULL,0,0,0,0,0);`);
  const add = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
  const complete = { input: 1_000_000, output: 2_000_000, reasoning: 300_000,
    cache: { read: 100_000, write: 200_000 } };
  for (const [i, vendor, model, tokens] of [
    [1, 'vendor', 'priced', complete], [2, 'other-vendor', 'priced', complete],
    [3, 'vendor', 'absent', { cache: { read: 100 } }], [4, 'vendor', 'unpriced', complete],
  ]) add.run(`a${i}`, 'pricing', 'assistant', i, Date.parse(timestamp), Date.parse(timestamp),
    JSON.stringify({ modelID: model, providerID: vendor, content: [], tokens }));
  db.close();
  await mkdir(path.join(root, 'pi/sessions/fixture'), { recursive: true });
  const piSource = path.join(root, 'pi/sessions/fixture/pricing.jsonl');
  await writeFile(piSource, [
    { type: 'session', version: 3, id: 'pricing', timestamp, cwd: '/fixture' },
    ...['vendor', undefined].map((provider, i) => ({ type: 'message', id: `a${i}`, parentId: i ? 'a0' : null, timestamp,
      message: { role: 'assistant', provider, model: 'priced', api: 'openai-completions',
        content: [{ type: 'text', text: 'Pricing fixture reply' }], stopReason: 'stop', timestamp: Date.parse(timestamp),
        usage: { input: 1_000_000, output: 2_300_000, reasoning: 300_000,
          cacheRead: 100_000, cacheWrite: 200_000, totalTokens: 3_600_000 } } })),
  ].map(JSON.stringify).join('\n') + '\n');
  for (const source of [dbPath, piSource]) observations.sourceHashes[source] = sha(await readFile(source));
  const config = path.join(root, 'config.json');
  await writeFile(config, JSON.stringify({ resumeCommands: { pi: false } }));
  const port = await freeFetchSafePort();
  const base = `http://127.0.0.1:${port}`;
  child = spawn(binary, ['serve', '--port', String(port), '--config', config,
    '--opencode-db', dbPath, ...['pi', 'codex', 'claude', 'dsh', 'meta', 'index', 'cache'].flatMap(name =>
      [`--${name}-dir`, path.join(root, name)])], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  observations.pid = child.pid; observations.port = port;
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(stderr);
    try { if ((await fetch(base + '/api/settings')).ok) break; } catch {}
    if (i === 99) throw new Error('Pricing server unavailable: ' + stderr);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const get = async url => { const response = await fetch(base + url); assert.equal(response.status, 200); return response.json(); };
  if (evidence) {
    const html = await (await fetch(base + '/')).text();
    observations.embeddedAssets = [];
    for (const [, asset] of html.matchAll(/(?:src|href)="(\/assets\/[^" ]+\.(?:css|js))"/g)) {
      const bytes = Buffer.from(await (await fetch(base + asset)).arrayBuffer());
      const built = path.join(repo, 'v3/ui/dist', asset.slice(1));
      const entry = { asset, servedSha256: sha(bytes), builtSha256: existsSync(built) ? sha(await readFile(built)) : null };
      if (entry.builtSha256) assert.equal(entry.servedSha256, entry.builtSha256, 'release embeds the current built UI asset');
      observations.embeddedAssets.push(entry);
    }
    assert.ok(observations.embeddedAssets.some(asset => asset.asset.endsWith('.css')));
  }
  const evaluate = async expression => JSON.parse(await command(session, 'eval', expression));
  await command(session, 'set', 'viewport', '1440', '1000');
  await command(session, 'open', base + '/settings');
  await waitFor(session, "document.querySelector('#token-pricing')");
  await command(session, 'snapshot', '-i');
  await command(staleSession, 'open', base + '/settings');
  await waitFor(staleSession, "document.querySelector('#resume-commands')");
  const rates = { currency: 'USD', inputPerMillion: 2, outputPerMillion: 4,
    reasoningPerMillion: 6, cacheReadPerMillion: .5, cacheWritePerMillion: 1,
    sourceLabel: 'User fixture rate card', sourceUrl: 'http://example.com/pricing', asOf: '2026-09-30' };
  const pricing = { 'vendor/priced': rates, 'other-vendor/priced': { ...rates, inputPerMillion: 20 },
    'vendor/absent': { currency: 'USD', inputPerMillion: 2, outputPerMillion: 4 } };
  await command(session, 'fill', '#token-pricing', JSON.stringify(pricing));
  await command(session, 'press', 'Tab'); await command(session, 'press', 'Enter');
  await waitFor(session, "document.querySelector('#token-pricing').closest('form').textContent.includes('Token pricing saved')");
  assert.deepEqual((await get('/api/settings')).runtime.tokenPricing, pricing);
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).tokenPricing, pricing);
  observations.checks.push('valid pricing saved by keyboard to runtime and disk');
  const saved = await readFile(config, 'utf8');
  for (const [invalid, expectedError] of [['{', 'Invalid JSON. Check the token pricing.'],
    [JSON.stringify({ 'vendor/priced': { ...rates, inputPerMillion: -1 } }), 'inputPerMillion: must be a finite non-negative number']]) {
    await command(session, 'fill', '#token-pricing', invalid);
    await command(session, 'eval', "document.querySelector('#token-pricing').closest('form').requestSubmit()");
    await waitFor(session, `document.querySelector('#token-pricing').closest('form').querySelector('[role=alert]')?.textContent.includes(${JSON.stringify(expectedError)})`);
    assert.equal(await readFile(config, 'utf8'), saved, 'invalid editor input must preserve saved disk contents');
    assert.deepEqual((await get('/api/settings')).runtime.tokenPricing, pricing);
    observations.checks.push({ invalidInput: invalid, visibleError: await command(session, 'get', 'text', '#token-pricing + button + p') });
  }
  await command(staleSession, 'fill', '#resume-commands', JSON.stringify({ pi: false, codex: false }));
  await command(staleSession, 'eval', "document.querySelector('#resume-commands').closest('form').requestSubmit()");
  await waitFor(staleSession, "document.body.textContent.includes('Resume settings saved')");
  assert.deepEqual((await get('/api/settings')).runtime.tokenPricing, pricing);
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).tokenPricing, pricing);
  observations.checks.push('stale tab resume edit preserves new token pricing');

  await command(session, 'open', base + '/opencode/stats');
  await waitFor(session, "document.querySelector('.stats-cost') && !document.querySelector('.stats-status')");
  assert.equal(await command(session, 'eval', "document.querySelector('.statistics-details').open"), 'false');
  await command(session, 'select', 'select[aria-label="Date range"]', '7');
  await waitFor(session, "document.querySelector('.stats-cost') && !document.querySelector('.stats-status')");
  await command(session, 'click', '.statistics-details > summary');
  await command(session, 'snapshot', '-i');
  // Observe the app's actual fetch and export URL, rather than manufacture a filtered API request.
  await command(session, 'eval', "window.pricingFetches=[]; window.pricingFetch=window.fetch; window.fetch=(...args)=>{window.pricingFetches.push(String(args[0]));return window.pricingFetch(...args)}");
  const modelSelect = 'select[aria-label="Request model"]';
  const ensureCostVisible = async () => {
    if (!await evaluate("document.querySelector('.statistics-details').open")) {
      await command(session, 'click', '.statistics-details > summary');
      observations.detailsReopenCount = (observations.detailsReopenCount ?? 0) + 1;
    }
    assert.equal(await command(session, 'is', 'visible', '.stats-cost'), 'true');
  };
  const choose = async (vendor, model) => {
    await command(session, 'select', modelSelect, JSON.stringify([vendor, model]));
    await waitFor(session, `!document.querySelector('.stats-status') && window.pricingFetches.length > 0
      && new URL(window.pricingFetches.at(-1),location.origin).searchParams.get('model')===${JSON.stringify(model)}
      && new URL(window.pricingFetches.at(-1),location.origin).searchParams.get('modelProvider')===${JSON.stringify(vendor ?? '')}`);
    await ensureCostVisible();
  };
  await choose('vendor', 'priced');
  const url = await evaluate('window.pricingFetches.at(-1)');
  assert.equal(new URL(url, base).searchParams.get('modelProvider'), 'vendor');
  assert.equal(new URL(url, base).searchParams.get('model'), 'priced');
  const report = await get(url);
  assert.ok(Math.abs(report.costEstimate.totalCost - 12.05) < 1e-12);
  assert.deepEqual(report.costEstimate.omittedDimensions, []);
  assert.deepEqual(Object.fromEntries(Object.entries(report.costEstimate.breakdown).map(([key, item]) => [key, item.tokens])),
    { input: 1_000_000, output: 2_000_000, reasoning: 300_000, cacheRead: 100_000, cacheWrite: 200_000 });
  const costBody = await command(session, 'get', 'text', '.stats-cost');
  assert.match(costBody, /USD 12\.0500/); assert.match(costBody, /User fixture rate card/); assert.match(costBody, /As of 2026-09-30/);
  assert.deepEqual(await evaluate("Object.fromEntries(Array.from(document.querySelectorAll('.stats-cost tbody tr')).map(row=>{const cells=Array.from(row.cells).map(cell=>cell.textContent.trim());return [cells[0],cells.slice(1)]}))"),
    { Input: ['1,000,000', 'USD 2.0000'], Output: ['2,000,000', 'USD 8.0000'],
      Reasoning: ['300,000', 'USD 1.8000'], 'Cache read': ['100,000', 'USD 0.0500'], 'Cache write': ['200,000', 'USD 0.2000'] });
  assert.deepEqual(await evaluate("(()=>{const a=document.querySelector('.stats-cost a');return {href:a.getAttribute('href'),target:a.target,rel:a.rel}})()"),
    { href: rates.sourceUrl, target: '_blank', rel: 'noopener noreferrer' });
  observations.checks.push({ exactModelCost: report.costEstimate, actualAppRequest: url });
  await choose('other-vendor', 'priced');
  await waitFor(session, "document.querySelector('.stats-cost').textContent.includes('USD 30.0500')");
  observations.checks.push('same model from different recorded vendor uses different exact price key');
  await choose('vendor', 'absent');
  await waitFor(session, "document.querySelector('.stats-cost').textContent.includes('No priced token dimensions are recorded')");
  assert.match(await command(session, 'get', 'text', '.stats-cost'), /Dimensions omitted.*Input, Output, Reasoning, Cache read, Cache write/s);
  assert.deepEqual((await get(await evaluate('window.pricingFetches.at(-1)'))).costEstimate.breakdown, {});
  observations.checks.push('null estimate and omitted missing evidence/rates shown without zero total');
  await choose('vendor', 'unpriced');
  await waitFor(session, "document.querySelector('.stats-cost').textContent.includes('No pricing is configured')");
  await choose('vendor', 'priced');
  await command(session, 'click', '.harness-trigger');
  await command(session, 'find', 'label', 'Pi', 'click');
  await waitFor(session, "new URL(location.href).searchParams.get('providers')==='opencode,pi' && !document.querySelector('.stats-status')");
  assert.equal(await evaluate("document.querySelector('.harness-trigger').getAttribute('aria-expanded')"), 'true');
  await command(session, 'find', 'label', 'OpenCode', 'click');
  await command(session, 'click', '.harness-options button:last-child');
  await waitFor(session, "new URL(location.href).searchParams.get('providers')==='pi' && !document.querySelector('.stats-status')");
  const detailsStayedOpen = await evaluate("document.querySelector('.statistics-details').open");
  await ensureCostVisible();
  assert.equal(await evaluate("document.querySelector('.statistics-details').open"), true);
  const selection = await evaluate("({value:document.querySelector('select[aria-label=\"Request model\"]').value,url:window.pricingFetches.at(-1),exportUrl:document.querySelector('.stats-downloads a').getAttribute('href'),cost:document.querySelector('.stats-cost').textContent})");
  assert.equal(selection.value, '', 'Provider switch resets the displayed model despite the same pair existing in the new provider');
  assert.equal(new URL(selection.url, base).searchParams.has('model'), false);
  assert.equal(new URL(selection.exportUrl, base).searchParams.has('model'), false);
  assert.equal(new URL(selection.url, base).searchParams.get('providers'), 'pi');
  assert.equal(new URL(selection.exportUrl, base).searchParams.get('providers'), 'pi');
  assert.equal(new URL(selection.url, base).searchParams.get('days'), '7');
  assert.equal(new URL(selection.exportUrl, base).searchParams.get('days'), '7');
  assert.equal(await command(session, 'get', 'value', 'select[aria-label="Date range"]'), '7');
  assert.match(selection.cost, /Select one recorded model provider and model/);
  observations.checks.push({ twoProviderReset: selection, detailsStayedOpen });
  await choose(null, 'priced');
  await waitFor(session, "document.querySelector('.stats-cost').textContent.includes('The model provider is not recorded')");
  assert.equal(new URL(await evaluate('window.pricingFetches.at(-1)'), base).searchParams.get('modelProvider'), '');
  observations.checks.push('unknown recorded vendor is distinct from unconfigured pricing and all models');
  await choose('vendor', 'priced');
  await waitFor(session, "document.querySelector('.stats-cost').textContent.includes('USD 12.0500')");

  for (const surface of ['stats', 'settings']) {
    if (surface === 'settings') { await command(session, 'open', base + '/settings'); await waitFor(session, "document.querySelector('#token-pricing')"); }
    for (const language of ['en', 'zh']) {
      await command(session, 'select', '.language-select', language);
      await waitFor(session, `document.documentElement.lang === '${language === 'zh' ? 'zh-CN' : 'en'}'`);
      for (const theme of ['light', 'dark']) {
        await command(session, 'select', '.theme-select', theme);
        await waitFor(session, `document.documentElement.dataset.theme === '${theme}'`);
        const layout = await evaluate("({viewport:innerWidth,width:document.documentElement.scrollWidth,controls:Array.from(document.querySelectorAll('.stats-toolbar select, .settings-panel textarea')).map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width}}),cost:document.querySelector('.stats-cost')?.textContent,pricing:document.querySelector('#settings-pricing-heading')?.textContent})");
        assert.ok(layout.width <= layout.viewport, `${surface} ${language} ${theme} fits the desktop viewport`);
        assert.ok(layout.controls.every(rect => rect.left >= 0 && rect.right <= layout.viewport && rect.width > 0));
        if (surface === 'stats') {
          assert.equal(await command(session, 'get', 'text', '.statistics-details > summary'),
            language === 'zh' ? '统计详情' : 'Statistics details');
          assert.equal(await command(session, 'is', 'visible', '.stats-cost'), 'true');
          assert.ok(layout.cost.includes(language === 'zh' ? '费用估算' : 'Cost estimate'));
          assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.stats-cost th')).map(cell=>cell.textContent.trim())"),
            language === 'zh' ? ['维度', 'Token 数', '金额'] : ['Dimension', 'Tokens', 'Amount']);
          assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.stats-cost tbody tr')).map(row=>row.cells[0].textContent.trim()).sort()"),
            (language === 'zh' ? ['输入', '输出', '推理', '缓存读取', '缓存写入'] : ['Input', 'Output', 'Reasoning', 'Cache read', 'Cache write']).sort());
        }
        if (surface === 'settings') assert.equal(layout.pricing, language === 'zh' ? 'Token 定价' : 'Token pricing');
        const audit = JSON.parse(await command(session, 'a11y', '--json'));
        observations.checks.push({ surface, language, theme, layout, accessibilityViolations: audit.data.violations,
          harnessFilterStyles: await evaluate("Array.from(document.querySelectorAll('.harness-trigger')).map(button=>({selector:'.harness-trigger',foreground:getComputedStyle(button).color,background:getComputedStyle(button).backgroundColor}))") });
        assert.deepEqual(audit.data.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target.join(',')) })), [], `${surface} ${language} ${theme} accessibility`);
        if (evidence) await command(session, 'screenshot', path.join(evidence, `${observations.binarySha256.slice(0, 12)}-${surface}-${language}-${theme}.png`), '--full');
      }
    }
  }
  await command(session, 'eval', "document.querySelector('#token-pricing').focus()");
  await command(session, 'press', 'Tab');
  assert.equal(await evaluate("document.activeElement===document.querySelector('#token-pricing').closest('form').querySelector('button')"), true);
  for (const id of [session, staleSession]) assert.equal(await command(id, 'errors'), '', 'actual browser page errors');
  observations.checks.push('pricing keyboard focus and zero browser page errors');
  observations.completed = true;
});
