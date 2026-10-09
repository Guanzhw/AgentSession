import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const pricing = { currency: ' usd ', inputPerMillion: 2, outputPerMillion: 4,
  reasoningPerMillion: 6, cacheReadPerMillion: 1, sourceLabel: 'User supplied fixture',
  sourceUrl: 'https://example.com/pricing', asOf: '2026-09-30' };

test('tokenPricing survives startup, settings saves and restart; live Stats uses exact vendor/model rates',
  { timeout: 40_000 }, async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-token-pricing-'));
    const config = path.join(dir, 'config.json');
    const dbPath = path.join(dir, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT,
      fork_boundary TEXT, title TEXT, slug TEXT, directory TEXT, time_created INTEGER,
      time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
      tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT);
      INSERT INTO session_v2 VALUES ('root',NULL,NULL,NULL,'Pricing fixture','root','/fixture',1,2,NULL,0,0,0,0,0);`);
    const add = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
    for (const [id, vendor, model, tokens] of [
      ['a', 'vendor', 'priced', { input: 1_000_000, output: 500_000, reasoning: 250_000, cache: { read: 100_000, write: 50_000 } }],
      ['b', 'different-vendor', 'priced', { input: 9_000_000, output: 9_000_000, reasoning: 0, cache: { read: 0, write: 0 } }],
      ['c', 'vendor', 'missing-cache', { input: 100, output: 20, reasoning: 0 }],
    ]) add.run(id, 'root', 'assistant', id.charCodeAt(0), 1789776000000, 1789776000000,
      JSON.stringify({ modelID: model, providerID: vendor, content: [], tokens }));
    db.close();
    const initial = { tokenPricing: { 'vendor/priced': pricing, 'vendor/missing-cache': pricing },
      projectPaths: { opencode: { opaque: dir } }, resumeCommands: { pi: false },
      mcp: { searchLimit: 17 } };
    await writeFile(config, JSON.stringify(initial));
    let child;
    const stop = async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close'); child.kill(); await closed;
      }
    };
    t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
    const start = async () => {
      const port = await freeFetchSafePort();
      child = spawn(binary, ['serve', '--config', config, '--port', String(port),
        '--opencode-db', dbPath, ...['codex', 'claude', 'pi', 'dsh'].flatMap(name =>
          [`--${name}-dir`, path.join(dir, name)]), ...['meta', 'index', 'cache'].flatMap(name =>
          [`--${name}-dir`, path.join(dir, name)])],
      { cwd: dir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
      const origin = `http://127.0.0.1:${port}`;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error(`3.0 rejected confirmed tokenPricing: ${stderr}`);
        try { if ((await fetch(origin + '/api/settings')).ok) return origin; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`Settings server did not start: ${stderr}`);
    };
    let origin = await start();
    const get = async url => {
      const response = await fetch(origin + url);
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    const post = value => fetch(origin + '/api/settings', { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(value) });
    assert.ok((await get('/api/settings')).runtimeEditable.includes('tokenPricing'));
    assert.deepEqual((await get('/api/settings')).runtime.tokenPricing, initial.tokenPricing);
    const stats = (model = 'priced', vendor = 'vendor') => get('/api/v3/stats/opencode?days=custom&from=2026-09-19&to=2026-09-19&model=' + model + '&modelProvider=' + vendor);
    assert.equal((await get('/api/v3/stats/opencode?days=custom&from=2026-09-19&to=2026-09-19')).costEstimate, null);
    assert.equal((await stats('priced', 'different-vendor')).costEstimate, null);
    assert.equal((await get('/api/v3/stats/opencode?days=custom&from=2026-09-19&to=2026-09-19&model=priced')).costEstimate, null);
    const estimate = (await stats()).costEstimate;
    assert.ok(Math.abs(estimate.breakdown.cacheRead.cost - .1) < 1e-12);
    estimate.breakdown.cacheRead.cost = .1;
    assert.deepEqual(estimate, { totalCost: 5.6, currency: 'USD', sourceLabel: pricing.sourceLabel,
      sourceUrl: pricing.sourceUrl, asOf: pricing.asOf, breakdown: {
        input: { tokens: 1_000_000, cost: 2 }, output: { tokens: 500_000, cost: 2 },
        reasoning: { tokens: 250_000, cost: 1.5 }, cacheRead: { tokens: 100_000, cost: .1 },
      }, omittedDimensions: ['cache-write'] });
    const missing = (await stats('missing-cache')).costEstimate;
    assert.deepEqual(missing.omittedDimensions, ['cache-read', 'cache-write']);
    assert.ok(Math.abs(missing.totalCost - .00028) < 1e-12);
    assert.ok(!('reasoning' in missing.breakdown), 'explicit zero is not a billable dimension');
    const changed = { 'vendor/priced': { ...pricing, inputPerMillion: 3,
      cacheWritePerMillion: 0, sourceUrl: 'HTTPS://例子.测试/定价 page?q=按量#费率' } };
    assert.equal((await post({ tokenPricing: changed })).status, 200);
    assert.equal((await stats()).costEstimate.totalCost, 6.6);
    assert.equal((await stats()).costEstimate.sourceUrl, changed['vendor/priced'].sourceUrl);
    assert.deepEqual((await stats()).costEstimate.breakdown.cacheWrite, { tokens: 50_000, cost: 0 });
    const noUsage = await get('/api/v3/stats/opencode?days=custom&from=2026-09-20&to=2026-09-20&model=priced&modelProvider=vendor');
    assert.equal(noUsage.costEstimate.totalCost, null);
    assert.deepEqual(noUsage.costEstimate.omittedDimensions, ['input', 'output', 'reasoning', 'cache-read', 'cache-write']);
    assert.equal((await post({ resumeCommands: { pi: false, codex: false } })).status, 200);
    const disk = await readFile(config, 'utf8');
    assert.deepEqual(JSON.parse(disk).projectPaths, initial.projectPaths);
    assert.deepEqual(JSON.parse(disk).mcp, initial.mcp);
    assert.deepEqual(JSON.parse(disk).tokenPricing, changed);
    for (const invalid of [null, [], { bad: pricing }, { '/priced': pricing },
      { 'vendor/priced': { ...pricing, currency: 'US' } },
      { 'vendor/priced': { ...pricing, inputPerMillion: -1 } },
      { 'vendor/priced': { ...pricing, outputPerMillion: '4' } },
      { 'vendor/priced': { ...pricing, reasoningPerMillion: null } },
      { 'vendor/priced': { ...pricing, cacheReadPerMillion: -1 } },
      { 'vendor/priced': { ...pricing, sourceLabel: 'x'.repeat(201) } },
      { 'vendor/priced': { ...pricing, sourceUrl: 'javascript:alert(1)' } },
      { 'vendor/priced': { ...pricing, asOf: '30-09-2026' } },
    ]) {
      const result = await post({ tokenPricing: invalid });
      assert.equal(result.status, 400, JSON.stringify(invalid));
      assert.equal((await result.json()).error.code, 'invalid_settings');
      assert.equal(await readFile(config, 'utf8'), disk);
      assert.deepEqual((await get('/api/settings')).runtime.tokenPricing, changed);
    }
    await stop(); origin = await start();
    assert.deepEqual((await get('/api/settings')).runtime.tokenPricing, changed);
    assert.equal((await stats()).costEstimate.totalCost, 6.6);
    assert.equal((await post({ tokenPricing: {} })).status, 200);
    assert.equal((await stats()).costEstimate, null);
  });

test('invalid tokenPricing startup identifies the owning field and leaves config untouched', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-token-pricing-invalid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'config.json');
  const body = JSON.stringify({ tokenPricing: { 'vendor/model': { ...pricing, inputPerMillion: null } } });
  await writeFile(config, body);
  const result = spawnSync(binary, ['serve', '--config', config], { cwd: dir,
    encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tokenPricing.*inputPerMillion/);
  assert.equal(await readFile(config, 'utf8'), body);
});
