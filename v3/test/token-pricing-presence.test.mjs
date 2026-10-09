import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const timestamp = '2026-09-19T00:00:00.000Z';
const unknown = { input: null, cacheRead: null, cacheWrite: null, output: null,
  reasoning: null, total: null };

async function setup(t, partialTotal = 14) {
  const root = await mkdtemp(path.join(repo, 'tmp/v3-token-presence-'));
  const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']
    .map(name => [name, path.join(root, name)]));
  for (const dir of Object.values(dirs)) await mkdir(dir);
  const dbPath = path.join(root, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT,
    fork_boundary TEXT, title TEXT, slug TEXT, directory TEXT, time_created INTEGER,
    time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
    tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
    time_created INTEGER, time_updated INTEGER, data TEXT);
    INSERT INTO session_v2 VALUES ('presence',NULL,NULL,NULL,'Presence','presence','/fixture',1,2,NULL,0,0,0,0,0);`);
  const add = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
  for (const [i, model, tokens] of [
    [1, 'absent', { cache: { read: 100 } }],
    [2, 'zero', { input: 0, output: 0, reasoning: 0, cache: { read: 100, write: 0 } }],
    [3, 'partial', { input: 100, cache: { read: 0 } }],
  ]) add.run(`a${i}`, 'presence', 'assistant', i, Date.parse(timestamp), Date.parse(timestamp),
    JSON.stringify({ modelID: model, providerID: 'vendor', content: [], tokens }));
  db.close();
  const config = path.join(root, 'config.json');
  await writeFile(config, JSON.stringify({ tokenPricing: Object.fromEntries(
    ['absent', 'zero', 'partial'].map(model => [`vendor/${model}`,
      { currency: 'USD', inputPerMillion: 2, outputPerMillion: 4 }])) }));
  const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  await mkdir(path.join(dirs.claude, 'transcripts'));
  await writeFile(path.join(dirs.claude, 'transcripts/presence.jsonl'), jsonl([
    { type: 'assistant', uuid: 'a', sessionId: 'presence', timestamp,
      message: { id: 'a', role: 'assistant', model: 'model', content: [{ type: 'text', text: 'reply' }],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: partialTotal } } },
    { type: 'assistant', uuid: 'b', sessionId: 'presence', timestamp,
      message: { id: 'b', role: 'assistant', model: 'model', content: [{ type: 'text', text: 'reply' }],
        usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0, reasoning_tokens: 0, total_tokens: 14 } } },
  ]));
  const piSession = path.join(dirs.pi, 'sessions/fixture'); await mkdir(piSession, { recursive: true });
  await writeFile(path.join(piSession, 'presence.jsonl'), jsonl([
    { type: 'session', version: 3, id: 'presence', timestamp, cwd: '/fixture' },
    ...[{ input: 10, output: 4, totalTokens: partialTotal },
      { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 14 },
      { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
      { input: 10, output: 4, reasoning: 0 }]
      .map((usage, i) => ({ type: 'message', id: `a${i}`, parentId: i ? 'a0' : null, timestamp,
        message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }],
          api: 'openai-completions', provider: 'vendor', model: 'model', usage,
          stopReason: 'stop', timestamp: Date.parse(timestamp) } })),
  ]));
  await mkdir(path.join(dirs.codex, 'sessions'));
  await writeFile(path.join(dirs.codex, 'sessions/presence.jsonl'), jsonl([
    { type: 'session_meta', timestamp, payload: { id: 'presence', cwd: '/fixture' } },
    ...[{ input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0,
        output_tokens: 4, reasoning_output_tokens: 0, total_tokens: 14 },
      { input_tokens: 10, output_tokens: 4 },
      { input_tokens: 10, cached_input_tokens: 3, output_tokens: 4,
        reasoning_output_tokens: 1, total_tokens: 14 }]
      .map((usage, i) => ({ type: 'token_usage_record', timestamp,
        payload: { thread_id: 'presence', response_id: `r${i}`, usage } })),
  ]));
  const legacy = (await readFile(path.join(repo, 'test/fixtures/dsh-rc8-fresh-round-trip.jsonl'), 'utf8'))
    .replaceAll('{{sessionId}}', 'presence').replaceAll('{{cwd}}', '/fixture')
    .trim().split('\n').map(JSON.parse);
  const settlements = legacy.filter(row => row.type === 'assistant/message' && row.data.usage);
  delete settlements[0].data.usage.reasoningTokens;
  settlements[0].data.usage.cacheWriteTokens = 0;
  settlements[1].data.usage.reasoningTokens = 0;
  const dshSession = path.join(dirs.dsh, 'sessions/fixture/presence');
  await mkdir(dshSession, { recursive: true });
  await writeFile(path.join(dshSession, 'session.jsonl.zstd'), zstdCompressSync(jsonl(legacy)));
  const port = await freeFetchSafePort();
  const child = spawn(binary, ['serve', '--port', String(port), '--config', config,
    '--opencode-db', dbPath, ...Object.entries(dirs).flatMap(([name, dir]) => [`--${name}-dir`, dir])],
  { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const close = once(child, 'close'); child.kill(); await close;
    }
    assert.equal(path.dirname(root), path.join(repo, 'tmp'));
    await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(stderr);
    try { if ((await fetch(origin + '/api/providers')).ok) return origin; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Startup failed: ${stderr}`);
}

test('OpenCode pricing preserves source-absent dimensions and explicit zero separately', async t => {
  const origin = await setup(t);
  const protocol = await (await fetch(origin + '/api/v3/protocol/opencode/presence?version=3')).json();
  assert.equal(protocol.validation.ok, true);
  assert.equal(protocol.usageRecords.length, 3);
  assert.deepEqual(protocol.usageRecords[0].tokens, { ...unknown, cacheRead: 100 });
  assert.deepEqual(protocol.usageRecords[1].tokens,
    { input: 0, output: 0, reasoning: 0, cacheRead: 100, cacheWrite: 0, total: null });
  const stats = async model => (await (await fetch(origin +
    `/api/v3/stats/opencode?days=custom&from=2026-09-19&to=2026-09-19&model=${model}&modelProvider=vendor`)).json()).costEstimate;
  assert.deepEqual(await stats('absent'), { totalCost: null, currency: 'USD', sourceLabel: '',
    sourceUrl: '', asOf: '', breakdown: {},
    omittedDimensions: ['input', 'output', 'reasoning', 'cache-read', 'cache-write'] });
  assert.equal((await stats('zero')).totalCost, 0);
  const partial = await stats('partial');
  assert.ok(Math.abs(partial.totalCost - .0002) < 1e-12);
  assert.deepEqual(partial.omittedDimensions, ['output', 'reasoning', 'cache-write']);
});

for (const provider of ['claude-code', 'pi', 'codex']) {
  test(`${provider} does not price unrecorded cache or reasoning as zero`, async t => {
    const origin = await setup(t);
    const document = await (await fetch(origin + `/api/v3/protocol/${provider}/presence?version=3`)).json();
    assert.equal(document.validation.ok, true, JSON.stringify(document));
    assert.equal(document.usageRecords.length, { 'claude-code': 2, pi: 4, codex: 4 }[provider]);
    assert.deepEqual(document.usageRecords[0].tokens,
      { ...unknown, input: provider === 'codex' ? null : 10, total: 14 });
    assert.deepEqual(document.usageRecords[1].tokens,
      { input: 10, cacheRead: 0, cacheWrite: 0, output: 4, reasoning: 0, total: 14 });
    if (provider === 'codex') {
      assert.deepEqual(document.usageRecords[2].tokens,
        { ...unknown, total: 14 }, 'Inclusive input + output provide a total independently of their missing subsets');
    }
    if (provider === 'pi') {
      assert.deepEqual(document.usageRecords[2].tokens,
        { ...unknown, input: 10, cacheRead: 0, cacheWrite: 0, total: 14 });
      assert.deepEqual(document.usageRecords[3].tokens,
        { ...unknown, input: 10, output: 4, reasoning: 0 }, 'Missing independent cache categories prevent a derived total');
    }
  });
}

test('Codex native schema establishes an omitted cache-write field as zero', async t => {
  const origin = await setup(t);
  const document = await (await fetch(origin + '/api/v3/protocol/codex/presence?version=3')).json();
  assert.equal(document.validation.ok, true);
  assert.deepEqual(document.usageRecords[3].tokens,
    { input: 7, cacheRead: 3, cacheWrite: 0, output: 3, reasoning: 1, total: 14 });
});

test('DSH historical output requires its recorded reasoning subset', async t => {
  const origin = await setup(t);
  const document = await (await fetch(origin + '/api/v3/protocol/deepseek-harness/presence?version=3')).json();
  assert.equal(document.validation.ok, true, JSON.stringify(document));
  assert.equal(document.usageRecords.length, 2);
  assert.equal(document.usageRecords[0].tokens.reasoning, null);
  assert.equal(document.usageRecords[0].tokens.output, null);
  assert.equal(document.usageRecords[0].tokens.total, 7887,
    'Recorded inclusive output plus all independent categories still establish the total');
  assert.equal(document.usageRecords[1].tokens.reasoning, 0);
  assert.ok(document.usageRecords[1].tokens.output > 0);
  assert.equal(document.usageRecords[1].tokens.total, null,
    'A missing independent cache-write category prevents a complete derived total');
});

for (const provider of ['claude-code', 'pi']) {
  test(`${provider} retains a recorded total above known partial components`, async t => {
    const origin = await setup(t, 20);
    const document = await (await fetch(origin + `/api/v3/protocol/${provider}/presence?version=3`)).json();
    assert.equal(document.validation.ok, true);
    assert.deepEqual(document.usageRecords[0].tokens, { ...unknown, input: 10, total: 20 });
    const stats = await (await fetch(origin +
      `/api/v3/stats/${provider}?days=custom&from=2026-09-19&to=2026-09-19`)).json();
    // Other requests in this isolated fixture have known totals 14 (Claude) and 14+14 (Pi).
    assert.equal(stats.overview.knownTokenCount, provider === 'pi' ? 48 : 34);
    assert.equal(stats.overview.unknownTokenRequestCount, provider === 'pi' ? 1 : 0);
  });
}
