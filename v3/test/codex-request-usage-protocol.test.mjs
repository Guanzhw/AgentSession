import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { requestUsageExpectation, verifyRequestUsage } from '../../scripts/v3-verify-request-usage.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const publicFixture = path.join(repo, 'test/fixtures/codex-current-v153.jsonl');
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const time = offset => new Date(Date.UTC(2026, 8, 27, 0, 0, offset)).toISOString();
const row = (offset, type, payload) => ({ timestamp: time(offset), type, payload });
const meta = (id, parent) => row(0, 'session_meta', {
  id, cwd: '/public/codex-usage', ...(parent ? { parent_thread_id: parent } : {}),
});
const usage = (input, cacheRead, cacheWrite, output, reasoning) => ({
  input_tokens: input, cached_input_tokens: cacheRead, cache_write_input_tokens: cacheWrite,
  output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output,
});

async function serve(t, sessions) {
  const sourceHash = sha(publicFixture);
  const work = await mkdtemp(path.join(repo, 'tmp/v3-codex-usage-'));
  const dirs = Object.fromEntries(['codex', 'pi', 'claude', 'dsh', 'meta', 'index', 'cache']
    .map(name => [name, path.join(work, name)]));
  for (const dir of Object.values(dirs)) await mkdir(dir);
  const sessionDir = path.join(dirs.codex, 'sessions', '2026', '09', '27');
  await mkdir(sessionDir, { recursive: true });
  const copies = [];
  for (const [id, rows] of sessions) {
    const file = path.join(sessionDir, `rollout-2026-09-27T00-00-00-${id}.jsonl`);
    await writeFile(file, typeof rows === 'string' ? rows
      : rows.map(value => JSON.stringify(value)).join('\n') + '\n');
    copies.push([file, sha(file)]);
  }
  const port = await freeFetchSafePort();
  const child = spawn(binary, ['serve', '--port', String(port), '--codex-dir', dirs.codex,
    '--pi-dir', dirs.pi, '--claude-dir', dirs.claude, '--dsh-dir', dirs.dsh,
    '--opencode-db', path.join(work, 'missing.db'), '--meta-dir', dirs.meta,
    '--index-dir', dirs.index, '--cache-dir', dirs.cache],
  { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    try {
      child.kill();
      if (child.exitCode === null && child.signalCode === null) await once(child, 'close');
      assert.equal(sha(publicFixture), sourceHash);
      for (const [file, hash] of copies) assert.equal(sha(file), hash);
    } finally {
      const resolved = path.resolve(work);
      assert.equal(path.dirname(resolved), path.resolve(repo, 'tmp'));
      assert.ok(path.basename(resolved).startsWith('v3-codex-usage-'));
      await rm(resolved, { recursive: true, force: true });
    }
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok)
        return base;
    } catch { /* Server startup. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Codex usage server did not start: ${stderr.slice(0, 500)}`);
}

async function protocol(base, id) {
  const response = await fetch(`${base}/api/v3/protocol/codex/${id}?version=3`);
  assert.equal(response.status, 200, `HTTP ${response.status}`);
  const document = await response.json();
  assert.equal(document.validation.ok, true);
  return document;
}

test('Codex Library counts rendered turns and only proved request tokens',
  { timeout: 30_000 }, async t => {
    const id = '81111111-1111-4111-8111-111111111111';
    const first = usage(10, 0, 0, 2, 0);
    const second = usage(20, 0, 0, 5, 0);
    const user = (offset, name, text) => row(offset, 'response_item', {
      type: 'message', role: 'user', id: name,
      content: [{ type: 'input_text', text }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] },
    });
    const assistant = (offset, name, text) => row(offset, 'response_item', {
      type: 'message', role: 'assistant', id: name,
      content: [{ type: 'output_text', text }],
    });
    const rows = [meta(id), user(1, 'user-1', 'First request'),
      assistant(2, 'assistant-1', 'First reply'),
      row(3, 'response_item', { type: 'function_call', call_id: 'tool-1',
        name: 'Read', arguments: '{}' }),
      row(4, 'event_msg', { type: 'token_count',
        info: { last_token_usage: first, total_token_usage: first } }),
      user(5, 'user-2', 'Second request'), assistant(6, 'assistant-2', 'Second reply'),
      row(7, 'token_usage_record', { response_id: 'response-2', thread_id: id, usage: second,
        thread_token_usage: { total_tokens: 25 } })];
    const base = await serve(t, [[id, rows]]);
    const response = await fetch(`${base}/api/v3/sessions?provider=codex`);
    assert.equal(response.status, 200);
    const listed = await response.json();
    const summary = listed.find(item => item.session.sessionId === id);
    assert.equal(summary?.messageCount, 4);
    assert.equal(summary?.tokenCount, 25);
  });

test('Codex retains a request that records only its total tokens',
  { timeout: 30_000 }, async t => {
    const id = '82222222-2222-4222-8222-222222222222';
    const rows = [meta(id), row(1, 'token_usage_record', {
      response_id: 'total-only', thread_id: id, usage: { total_tokens: 47 },
    })];
    const base = await serve(t, [[id, rows]]);
    const listed = await (await fetch(`${base}/api/v3/sessions?provider=codex`)).json();
    assert.equal(listed.find(item => item.session.sessionId === id)?.tokenCount, 47);
    const document = await protocol(base, id);
    assert.equal(document.usageRecords.length, 1);
    assert.deepEqual(document.usageRecords[0].tokens,
      { input: null, cacheRead: null, cacheWrite: null, output: null,
        reasoning: null, total: 47 });
  });

test('Codex current v153 public source publishes its one recorded request',
  { timeout: 30_000 }, async t => {
    const id = 'codex-current';
    const document = await protocol(await serve(t, [[id, readFileSync(publicFixture, 'utf8')]]), id);
    assert.deepEqual(document.usageRecords.map(record => record.id), [`usage:${id}:response-1`]);
    assert.deepEqual(document.usageRecords[0].tokens,
      { input: 75, cacheRead: 20, cacheWrite: 5, output: 20, reasoning: 10, total: 130 });
    assert.equal(document.usageRecords[0].provenance.fidelity, 'derived');
    assert.equal(document.usageRecords[0].provenance.sourceType, 'codex.token_usage_record+turn_context');
    assert.equal(document.usageRecords[0].turnId, 'turn-1');
  });

test('Codex publishes owned legacy and modern request usage once with model provenance',
  { timeout: 30_000 }, async t => {
    const id = '71111111-1111-4111-8111-111111111111';
    const first = usage(100, 20, 5, 30, 10);
    const second = usage(40, 4, 0, 12, 2);
    const rows = [
      meta(id),
      row(1, 'event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-sol' } }),
      row(2, 'event_msg', { type: 'token_count', response_id: 'response-1',
        info: { last_token_usage: first, total_token_usage: first } }),
      row(3, 'token_usage_record', { response_id: 'response-1', thread_id: id,
        turn_id: 'turn-1', usage: first,
        turn_token_usage: first, thread_token_usage: first }),
      row(4, 'response_item', { type: 'message', role: 'assistant', id: 'assistant-1',
        content: [{ type: 'output_text', text: 'A recorded reply.' }] }),
      row(5, 'token_usage_record', { response_id: 'response-2', thread_id: id,
        turn_id: 'turn-2', usage: second,
        turn_token_usage: second, thread_token_usage: { total_tokens: 182 } }),
      row(6, 'token_usage_record', { response_id: 'response-2', thread_id: id,
        turn_id: 'turn-2', usage: second }),
      row(7, 'event_msg', { type: 'token_count', info: { last_token_usage: usage(0, 0, 0, 0, 0),
        total_token_usage: { total_tokens: 182 } } }),
    ];
    const document = await protocol(await serve(t, [[id, rows]]), id);
    assert.deepEqual(document.usageRecords.map(value => value.id),
      [`usage:${id}:response-1`, `usage:${id}:response-2`]);
    assert.deepEqual(document.usageRecords.map(value => value.tokens), [
      { input: 75, cacheRead: 20, cacheWrite: 5, output: 20, reasoning: 10, total: 130 },
      { input: 36, cacheRead: 4, cacheWrite: 0, output: 10, reasoning: 2, total: 52 },
    ]);
    assert.equal(document.coverage.usage.state, 'observed');
    for (const record of document.usageRecords) {
      assert.equal(record.scope, 'request');
      assert.deepEqual(record.sessionRef, { provider: 'codex', sessionId: id });
      assert.equal(record.model, 'gpt-6-sol');
      assert.equal(record.provenance.fidelity, 'derived');
      assert.ok(record.provenance.sourceType.endsWith('+thread_settings_applied'));
      assert.equal(record.eventId, null);
    }
    assert.equal(document.usageRecords[0].provenance.sourceId, 'response-1');
    assert.equal(document.usageRecords[1].turnId, 'turn-2');
  });

test('Codex foreign thread settings cannot replace the owned usage model selection',
  { timeout: 30_000 }, async t => {
    const id = '7b111111-1111-4111-8111-111111111111';
    const foreign = '7b222222-2222-4222-8222-222222222222';
    const selected = (offset, owner, model, provider) => row(offset, 'event_msg', {
      type: 'thread_settings_applied', ...(owner ? { thread_id: owner } : {}),
      thread_settings: { model, model_provider_id: provider },
    });
    const request = (offset, response) => row(offset, 'token_usage_record', {
      thread_id: id, response_id: response, usage: usage(10, 0, 0, 4, 0),
    });
    const rows = [meta(id),
      selected(1, id, 'owned-model', 'owned-vendor'), request(2, 'first'),
      selected(3, foreign, 'foreign-model', 'foreign-vendor'), request(4, 'after-foreign'),
      selected(5, null, 'legacy-model', 'legacy-vendor'), request(6, 'older-ownerless'),
      selected(7, id, 'new-owned-model', 'new-owned-vendor'), request(8, 'new-owned'),
    ];
    const base = await serve(t, [[id, rows]]);
    const document = await protocol(base, id);
    assert.deepEqual(document.usageRecords.map(record => [record.provenance.sourceId,
      record.model, record.modelProvider]), [
      ['first', 'owned-model', 'owned-vendor'],
      ['after-foreign', 'owned-model', 'owned-vendor'],
      ['older-ownerless', 'legacy-model', 'legacy-vendor'],
      ['new-owned', 'new-owned-model', 'new-owned-vendor'],
    ]);
    assert.ok(document.usageRecords.every(record => record.tokens.total === 14));
    const response = await fetch(`${base}/api/v3/stats/codex?modelProvider=owned-vendor&model=owned-model`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).overview.recordedRequestCount, 2);
  });

test('Codex recorded model provider follows owned selection and resets copied parent state',
  { timeout: 30_000 }, async t => {
    const parent = '7a111111-1111-4111-8111-111111111111';
    const child = '7a222222-2222-4222-8222-222222222222';
    const selected = (offset, model, provider) => row(offset, 'event_msg', {
      type: 'thread_settings_applied', thread_settings: { model,
        ...(provider ? { model_provider_id: provider } : {}) },
    });
    const request = (offset, response, owner) => row(offset, 'token_usage_record', {
      thread_id: owner, response_id: response, usage: usage(10, 0, 0, 2, 0),
    });
    const childMeta = meta(child, parent);
    childMeta.payload.model_provider = 'child-recorded-vendor';
    const rows = [childMeta, meta(parent), selected(1, 'parent-model', 'parent-recorded-vendor'),
      request(2, 'inherited', parent), childMeta,
      row(3, 'response_item', { type: 'agent_message', id: 'child-task',
        content: [{ type: 'output_text', text: 'Message Type: NEW_TASK\nTask name: /root/child\nSender: /root\nPayload:\nWork.' }] }),
      request(4, 'no-child-model', child),
      selected(5, 'child-model', 'recorded-vendor-A'), request(6, 'selected-A', child),
      selected(7, 'child-model', 'recorded-vendor-B'), request(8, 'selected-B', child),
      selected(9, 'model-without-provider'), request(10, 'unknown-provider', child),
    ];
    const document = await protocol(await serve(t, [[child, rows]]), child);
    assert.deepEqual(document.usageRecords.map(record => [record.provenance.sourceId,
      record.model ?? null, record.modelProvider ?? null]), [
      ['no-child-model', null, 'child-recorded-vendor'],
      ['selected-A', 'child-model', 'recorded-vendor-A'],
      ['selected-B', 'child-model', 'recorded-vendor-B'],
      ['unknown-provider', 'model-without-provider', null],
    ]);
    assert.ok(document.usageRecords.every(record => record.tokens.total === 12));
    assert.ok(document.usageRecords.every(record => record.sessionRef.sessionId === child));
  });

test('Codex excludes nonadjacent legacy usage mirrored by a recorded response and thread total',
  { timeout: 30_000 }, async t => {
    const id = '76666666-6666-4666-8666-666666666666';
    const request = usage(100, 20, 5, 30, 10);
    const secondThread = usage(200, 40, 10, 60, 20);
    const rows = [
      meta(id),
      row(1, 'token_usage_record', { response_id: 'response-1', thread_id: id, usage: request,
        thread_token_usage: request }),
      row(2, 'event_msg', { type: 'agent_message', message: 'First response completed.' }),
      row(3, 'event_msg', { type: 'token_count', info: {
        last_token_usage: request, total_token_usage: request } }),
      row(4, 'token_usage_record', { response_id: 'response-2', thread_id: id, usage: request,
        thread_token_usage: secondThread }),
      row(5, 'event_msg', { type: 'agent_message', message: 'Second response completed.' }),
      row(6, 'event_msg', { type: 'token_count', info: {
        last_token_usage: request, total_token_usage: secondThread } }),
    ];
    const document = await protocol(await serve(t, [[id, rows]]), id);
    assert.deepEqual(document.usageRecords.map(record => record.id),
      [`usage:${id}:response-1`, `usage:${id}:response-2`]);
    assert.deepEqual(document.usageRecords.map(record => record.tokens.total), [130, 130]);
    assert.equal(document.usageRecords.every(record =>
      record.provenance.sourceType === 'codex.token_usage_record'), true);
  });

test('Codex preserves every adjacent anonymous legacy usage occurrence',
  { timeout: 30_000 }, async t => {
    const id = '77777777-7777-4777-8777-777777777777';
    const request = usage(10, 0, 0, 2, 0);
    const token = offset => row(offset, 'event_msg', { type: 'token_count', info: {
      last_token_usage: request, total_token_usage: request } });
    const document = await protocol(await serve(t, [[id, [meta(id), token(1), token(2), token(3)]]]), id);
    assert.equal(document.usageRecords.length, 0);
    assert.deepEqual(document.usageObservations.map(value => value.tokens.total), [12, 12, 12]);
  });

test('Codex child request usage starts at its recorded NEW_TASK boundary',
  { timeout: 30_000 }, async t => {
    const parent = '72222222-2222-4222-8222-222222222222';
    const child = '73333333-3333-4333-8333-333333333333';
    const inherited = row(1, 'token_usage_record', { response_id: 'parent-response',
      usage: usage(12, 2, 0, 3, 1) });
    const own = row(4, 'token_usage_record', { response_id: 'child-response', thread_id: child,
      usage: usage(20, 4, 0, 5, 2) });
    const parentRows = [meta(parent), inherited];
    const childRows = [meta(child, parent), inherited,
      row(2, 'response_item', { type: 'agent_message', id: 'child-task',
        content: [{ type: 'output_text', text: 'Message Type: NEW_TASK\nTask name: /root/child\nSender: /root\nPayload:\nDo the work.' }] }),
      row(3, 'event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-luna' } }),
      own];
    const document = await protocol(await serve(t, [[parent, parentRows], [child, childRows]]), child);
    assert.deepEqual(document.usageRecords.map(value => value.id), [`usage:${child}:child-response`]);
    assert.equal(document.usageRecords[0].tokens.total, 25);
    assert.equal(document.usageRecords[0].model, 'gpt-6-luna');
  });

test('Codex legacy child retains every anonymous source occurrence without a NEW_TASK boundary',
  { timeout: 30_000 }, async t => {
    const parent = '74444444-4444-4444-8444-444444444444';
    const child = '75555555-5555-4555-8555-555555555555';
    const first = row(1, 'event_msg', { type: 'token_count',
      info: { last_token_usage: usage(10, 0, 0, 2, 0), total_token_usage: { total_tokens: 12 } } });
    const second = row(2, 'event_msg', { type: 'token_count',
      info: { last_token_usage: usage(20, 2, 0, 3, 0), total_token_usage: { total_tokens: 35 } } });
    const own = row(4, 'event_msg', { type: 'token_count',
      info: { last_token_usage: usage(30, 3, 0, 5, 1), total_token_usage: { total_tokens: 70 } } });
    const parentRows = [meta(parent), first, second];
    const childRows = [meta(child, parent), first, second,
      row(3, 'event_msg', { type: 'agent_message', message: 'Owned result.' }), own];
    const document = await protocol(await serve(t, [[parent, parentRows], [child, childRows]]), child);
    assert.equal(document.usageRecords.length, 0);
    assert.deepEqual(document.usageObservations.map(value => value.provenance.sourceId),
      ['1', '2', '4']);
    assert.deepEqual(document.usageObservations.map(value => value.tokens.total), [12, 23, 35]);
  });

test('Codex keeps independent child occurrences even when all usage vectors equal the parent',
  { timeout: 30_000 }, async t => {
    const parent = '74444444-4444-4444-8444-444444444445';
    const child = '75555555-5555-4555-8555-555555555556';
    const same = usage(10, 0, 0, 2, 0);
    const token = offset => row(offset, 'event_msg', { type: 'token_count', info: {
      last_token_usage: same, total_token_usage: same } });
    const document = await protocol(await serve(t, [
      [parent, [meta(parent), token(1), token(2)]],
      [child, [meta(child, parent), token(1), token(2)]],
    ]), child);
    assert.equal(document.usageRecords.length, 0);
    assert.deepEqual(document.usageObservations.map(value => value.provenance.sourceId), ['1', '2']);
    assert.deepEqual(document.usageObservations.map(value => value.tokens.total), [12, 12]);
  });

test('Codex leaves explicitly foreign canonical usage in raw events only',
  { timeout: 30_000 }, async t => {
    const parent = '74444444-4444-4444-8444-444444444446';
    const child = '75555555-5555-4555-8555-555555555557';
    const foreign = row(1, 'token_usage_record', {
      response_id: 'parent-response', thread_id: parent, usage: usage(10, 0, 0, 2, 0),
    });
    const own = row(2, 'token_usage_record', {
      response_id: 'child-response', thread_id: child, usage: usage(20, 0, 0, 5, 0),
    });
    const anonymous = row(3, 'event_msg', { type: 'token_count', info: {
      last_token_usage: usage(7, 0, 0, 1, 0), total_token_usage: { total_tokens: 8 },
    } });
    const document = await protocol(await serve(t, [
      [parent, [meta(parent), foreign]],
      [child, [meta(child, parent), foreign, own, anonymous]],
    ]), child);
    assert.ok(document.events.some(value => value.id === 'event:codex:1'));
    assert.deepEqual(document.usageRecords.map(value => value.provenance.sourceId),
      ['child-response']);
    assert.deepEqual(document.usageObservations.map(value => value.provenance.sourceId), ['3']);
  });

test('frozen real Codex request matches independently recorded source components',
  { skip: !process.env.AGENTSESSION_V3_REAL_MANIFEST, timeout: 120_000 }, async t => {
    const manifest = JSON.parse(readFileSync(process.env.AGENTSESSION_V3_REAL_MANIFEST, 'utf8'));
    const source = manifest.files.find(file => file.provider === 'codex'
      && file.role === 'long-team-compaction');
    assert.ok(source, 'Frozen Codex source is present');
    const before = sha(source.snapshotPath);
    assert.equal(before, source.snapshotSha256);
    const bytes = readFileSync(source.snapshotPath);
    const expected = requestUsageExpectation('codex', bytes, 9126);
    const document = await protocol(await serve(t, [[expected.sessionRef.sessionId, bytes.toString('utf8')]]),
      expected.sessionRef.sessionId);
    assert.deepEqual(verifyRequestUsage(expected, document.usageRecords),
      { ok: true, recordedComponents: 6, missingComponents: [] });
    assert.equal(document.usageRecords.filter(record =>
      record.provenance.sourceId === expected.sourceId).length, 1);
    assert.equal(sha(source.snapshotPath), before);
  });
