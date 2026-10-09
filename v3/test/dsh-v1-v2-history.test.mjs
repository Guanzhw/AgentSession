import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// The envelopes, seed markers and v2 replacement follow the released 2.0
// parser fixtures in test/deepseek-harness*.test.mjs.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const provider = 'deepseek-harness';
const ref = sessionId => ({ provider, sessionId });
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');

function historicalRows(version, id) {
  const inherited = `INHERITED_V${version}_${id}`;
  const owned = `OWNED_V${version}_${id}`;
  const rows = [{ type: 'session', version, id, createdAt: 100,
    parentSession: 'recorded-missing-parent', delegationDepth: 1,
    ...(version === 1 ? { seedLength: 2 } : { isSeeded: true }) }];
  const push = (type, data, surfaceOp, sourceEventSeqs) => {
    const seq = rows.length - 1;
    rows.push({ type, seq, time: 101 + seq, data,
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
      ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }) });
  };
  push('user/message', { id: 'inherited-user', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: inherited }] }, 'append');
  push('assistant/message', { turn: 1, step: 1, message: { id: 'inherited-answer',
    role: 'assistant', source: { kind: 'model' },
    content: [{ type: 'text', text: 'INHERITED_ANSWER' }] },
  usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } }, 'append');
  push('session/end-seed', version === 2 ? { inherited: true } : {});
  push('user/message', { id: 'owned-user', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: owned }] }, 'append');
  push('assistant/message', { turn: 2, step: 1, message: { id: 'owned-answer',
    role: 'assistant', source: { kind: 'model' }, content: [
      { type: 'text', text: 'OWNED_ANSWER' },
      { type: 'tool-call', id: 'owned-call', name: 'read', arguments: '{"path":"owned.txt"}' },
    ] }, usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } }, 'append');
  const tool = text => ({ turn: 2, step: 1, message: { id: 'owned-result', role: 'tool',
    source: { kind: 'tool', callId: 'owned-call' }, content: [{ type: 'tool-result',
      toolCallId: 'owned-call', content: [{ type: 'text', text }] }] } });
  push('tool/result', tool('ORIGINAL_TOOL_OUTPUT'), 'append');
  if (version === 2) push('tool/result', tool('REWRITTEN_MODEL_COPY'),
    { op: 'replace', start: 5, end: 5 }, [5]);
  return rows;
}

async function source(h, id, version, encoding, rows = historicalRows(version, id)) {
  const file = path.join(h.state, 'dsh', 'sessions', 'public', id,
    `session.v${version}.jsonl${encoding === 'zstd' ? '.zstd' : ''}`);
  await mkdir(path.dirname(file), { recursive: true });
  const raw = Buffer.from(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  await writeFile(file, encoding === 'zstd' ? zstdCompressSync(raw) : raw);
  h.ledger.set(file, digest(file));
  return file;
}

async function harness(t) {
  assert.ok(existsSync(binary), `Build the shared debug binary: ${binary}`);
  await mkdir(path.join(repo, 'tmp'), { recursive: true });
  const state = await mkdtemp(path.join(repo, 'tmp', 'v3-dsh-historical-'));
  const ledger = new Map();
  const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']
    .map(name => [name, path.join(state, name)]));
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
  let child;
  let client;
  t.after(async () => {
    await client?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
  });
  t.after(async () => {
    try {
      const before = [];
      const after = [];
      for (const [file, hash] of ledger) {
        const relative = path.relative(state, file);
        const actual = digest(file);
        assert.equal(actual, hash, `Rust leaves ${file} source unchanged`);
        before.push(`${relative}:${hash}`);
        after.push(`${relative}:${actual}`);
      }
      const ledgerHash = entries => createHash('sha256').update(entries.sort().join('\n')).digest('hex');
      const beforeHash = ledgerHash(before);
      const afterHash = ledgerHash(after);
      assert.equal(afterHash, beforeHash);
      t.diagnostic(`${ledger.size} synthetic DSH sources SHA-256 ledger before/after: ${beforeHash} / ${afterHash}`);
    } finally {
      assert.equal(path.dirname(path.resolve(state)), path.resolve(repo, 'tmp'));
      await rm(state, { recursive: true, force: true });
    }
  });
  const args = ['--codex-dir', dirs.codex, '--opencode-db', path.join(state, 'opencode.db'),
    '--claude-dir', dirs.claude, '--pi-dir', dirs.pi, '--dsh-dir', dirs.dsh,
    '--meta-dir', dirs.meta, '--index-dir', dirs.index, '--cache-dir', dirs.cache];
  return { state, ledger, args, async start() {
    const port = await freeFetchSafePort();
    child = spawn(binary, ['serve', '--port', String(port), ...args],
      { cwd: repo, windowsHide: true, stdio: 'ignore' });
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) break;
      try {
        if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok)
          return base;
      } catch { /* Startup indexing is in progress. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Historical DSH Axum process did not become ready');
  }, async mcp() {
    client = new Client({ name: 'dsh-historical-acceptance', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: binary,
      args: ['mcp', ...args], cwd: repo, stderr: 'pipe' }));
    return client;
  } };
}

async function json(base, route, status = 200) {
  const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(10_000) });
  const body = await response.json();
  assert.equal(response.status, status, `${route}: ${JSON.stringify(body)}`);
  return body;
}

test('DSH v1/v2 raw and Zstd sources keep canonical inventory, owned Reader, inherited context, protocol and MCP identity',
  { timeout: 60_000 }, async t => {
    const h = await harness(t);
    const cases = [];
    for (const version of [1, 2]) for (const encoding of ['raw', 'zstd']) {
      const id = `historical-v${version}-${encoding}`;
      await source(h, id, version, encoding);
      cases.push({ id, version });
    }
    const selected = 'historical-selected';
    await source(h, selected, 1, 'raw');
    await source(h, selected, 2, 'raw');
    const base = await h.start();
    const listed = await json(base, `/api/v3/sessions?provider=${provider}`);
    assert.deepEqual(listed.map(row => row.session.sessionId).sort(),
      [...cases.map(row => row.id), selected].sort(), 'one canonical row per selected session');
    const mcp = await h.mcp();
    for (const { id, version } of [...cases, { id: selected, version: 2 }]) {
      const entry = listed.find(row => row.session.sessionId === id);
      assert.deepEqual(entry.parent, ref('recorded-missing-parent'));
      assert.equal(entry.tokenCount, 7, 'inherited request tokens do not accrue to the child');
      const reader = await json(base, `/api/v3/reader/${provider}/${id}/bootstrap`);
      const items = reader.segments.flatMap(page => page.items);
      assert.deepEqual(items.map(item => item.event.messageId),
        ['owned-user', 'owned-answer', 'owned-call'], 'replacement stays model-only');
      assert.equal(reader.totalItems, 3);
      assert.doesNotMatch(JSON.stringify(reader), /INHERITED_V|INHERITED_ANSWER|REWRITTEN_MODEL_COPY/);
      const inherited = await json(base,
        `/api/v3/reader/${provider}/${id}/inherited-context?limit=40`);
      assert.deepEqual(inherited.sourceSession, ref('recorded-missing-parent'));
      assert.deepEqual(inherited.items.map(item => item.messageId),
        ['inherited-user', 'inherited-answer']);
      const tool = await json(base, `/api/v3/reader/${provider}/${id}/content?${new URLSearchParams({
        messageId: 'owned-call', segment: 'tool', field: 'toolOutput', offset: '0',
        maxChars: '100', revision: reader.revision })}`);
      assert.equal(tool.text, 'ORIGINAL_TOOL_OUTPUT');
      const document = await json(base, `/api/v3/protocol/${provider}/${id}?version=2`);
      assert.equal(document.validation.ok, true);
      assert.deepEqual(document.session, ref(id));
      assert.equal(document.revision, reader.revision);
      assert.equal(document.events.filter(event => event.readerEvent?.messageId === 'owned-call').length, 1);
      if (version === 2) {
        const rewrite = document.events.find(event => event.id === 'event:dsh:6');
        assert.equal(rewrite?.kind, 'tool.result', 'the recorded rewrite survives protocol');
        assert.equal(rewrite.readerEvent, null, 'the rewrite does not create another Reader item');
      }
      const get = await mcp.callTool({ name: 'session_get', arguments: { session: ref(id) } });
      assert.notEqual(get.isError, true);
      assert.deepEqual(get.structuredContent.result.session, ref(id));
      assert.equal(get.structuredContent.result.messageCount, 3);
      const result = await mcp.callTool({ name: 'session_get_event', arguments: {
        event: { ...ref(id), messageId: 'owned-call', segment: 'tool' },
        includeToolOutput: true, offset: 0, maxChars: 100 } });
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.structuredContent.result.event,
        { ...ref(id), messageId: 'owned-call', segment: 'tool' });
      assert.equal(result.structuredContent.result.toolOutput.text, 'ORIGINAL_TOOL_OUTPUT');
    }
  });

test('selected malformed v1/v2 historical sources yield explicit errors instead of a lower-generation fallback',
  { timeout: 30_000 }, async t => {
    const h = await harness(t);
    const badSequence = 'historical-bad-sequence';
    const badRequired = 'historical-bad-required';
    const badRewrite = 'historical-bad-rewrite';
    const badProvenance = 'historical-bad-provenance';
    await source(h, badSequence, 1, 'zstd');
    await source(h, badRequired, 1, 'raw');
    await source(h, badRewrite, 1, 'raw');
    await source(h, badProvenance, 1, 'raw');
    const broken = historicalRows(2, badSequence);
    broken[1].seq = 4;
    await source(h, badSequence, 2, 'zstd', broken);
    const required = historicalRows(2, badRequired);
    required.splice(1, 0, { type: 'system/message', seq: 0, time: 101, data: {} });
    for (let index = 2; index < required.length; index++) required[index].seq += 1;
    await source(h, badRequired, 2, 'raw', required);
    const rewrite = historicalRows(2, badRewrite);
    rewrite.at(-1).data.message.source.callId = 'different-call';
    await source(h, badRewrite, 2, 'raw', rewrite);
    const provenance = historicalRows(2, badProvenance);
    provenance.at(-1).sourceEventSeqs = [5, 5];
    await source(h, badProvenance, 2, 'raw', provenance);
    const base = await h.start();
    for (const [id, pattern] of [[badSequence, /non-contiguous|expected 0.*got 4/i],
      [badRequired, /unsupported required/i],
      [badRewrite, /tool result replacement changes fields/i],
      [badProvenance, /sourceEventSeqs provenance/i]]) {
      for (const route of [`/api/v3/reader/${provider}/${id}/bootstrap`,
        `/api/v3/protocol/${provider}/${id}?version=2`]) {
        const response = await fetch(`${base}${route}`);
        const body = await response.json();
        assert.ok([422, 500].includes(response.status), `${route}: ${JSON.stringify(body)}`);
        assert.ok(['source_error', 'protocol_invalid'].includes(body.error?.code));
        assert.match(body.error.message.split(': ').at(-1), pattern,
          'diagnostic must describe the selected source failure, not echo its path');
        assert.notEqual(body.validation?.ok, true);
      }
    }
  });

test('v1 packed rows honor seedLength and v2 retry records a new owned request',
  { timeout: 30_000 }, async t => {
    const h = await harness(t);
    const packedId = 'historical-v1-packed';
    const packed = [
      { type: 'session', version: 1, id: packedId, createdAt: 100,
        parentSession: 'recorded-missing-parent', delegationDepth: 1, seedLength: 8 },
      { type: 'text-chunks', seq0: 0, time0: 101,
        data: { turn: 1, step: 1, index: 0, texts: ['seed ', 'text'], dt: [1] } },
      { type: 'reasoning-chunks', seq0: 2, time0: 103,
        data: { turn: 1, step: 1, index: 1, texts: ['seed ', 'reasoning'], dt: [1] } },
      { type: 'tool-call-chunks', seq0: 4, time0: 105,
        data: { turn: 1, step: 1, index: 2, id: 'seed-call', name: 'read',
          args: ['{"path":', '"seed.txt"}'], dt: [1] } },
      { type: 'assistant/message', seq: 6, time: 107, surfaceOp: 'append',
        sourceEventSeqs: [[0, 5]], data: { turn: 1, step: 1,
          message: { id: 'packed-answer', role: 'assistant', source: { kind: 'model' },
            content: [{ type: 'text', text: 'PACKED_ANSWER' }] } } },
      { type: 'user/message', seq: 7, time: 108, surfaceOp: 'append',
        data: { id: 'packed-inherited', source: { kind: 'user' },
          content: [{ type: 'text', text: 'PACKED_PREFIX' }] } },
      { type: 'session/end-seed', seq: 8, time: 109, data: {} },
      { type: 'user/message', seq: 9, time: 110, surfaceOp: 'append',
        data: { id: 'packed-owned', source: { kind: 'user' },
          content: [{ type: 'text', text: 'PACKED_OWNED' }] } },
    ];
    await source(h, packedId, 1, 'zstd', packed);
    const retryId = 'historical-v2-retry';
    const usage = (inputTokens, outputTokens) => ({ inputTokens, outputTokens,
      cacheReadTokens: 0, cacheWriteTokens: 0 });
    const retry = [
      { type: 'session', version: 2, id: retryId, createdAt: 200,
        isSeeded: false, delegationDepth: 0 },
      { type: 'assistant/attempt', seq: 0, time: 201,
        data: { turn: 1, step: 1, stream: [{ type: 'usage', usage: usage(1, 1) }] } },
      { type: 'assistant/message', seq: 1, time: 202, surfaceOp: 'append',
        data: { turn: 1, step: 1, message: { id: 'retry-answer',
          source: { kind: 'model' }, content: [{ type: 'text', text: 'SETTLED' }] },
        usage: usage(2, 2) } },
      { type: 'llm/retry-started', seq: 2, time: 203, data: { turn: 1, step: 1 } },
      { type: 'assistant/attempt', seq: 3, time: 204,
        data: { turn: 1, step: 1, stream: [{ type: 'usage', usage: usage(3, 3) }] } },
    ];
    await source(h, retryId, 2, 'raw', retry);
    const base = await h.start();
    const inventory = await json(base, `/api/v3/sessions?provider=${provider}`);
    assert.deepEqual(inventory.map(row => row.session.sessionId).sort(), [packedId, retryId]);
    const packedReader = await json(base,
      `/api/v3/reader/${provider}/${packedId}/bootstrap`);
    assert.deepEqual(packedReader.segments.flatMap(page => page.items)
      .map(item => item.event.messageId), ['packed-owned']);
    const inherited = await json(base,
      `/api/v3/reader/${provider}/${packedId}/inherited-context?limit=40`);
    assert.deepEqual(inherited.items.map(item => item.messageId),
      ['packed-answer', 'packed-inherited']);
    const retryReader = await json(base,
      `/api/v3/reader/${provider}/${retryId}/bootstrap`);
    assert.deepEqual(retryReader.segments.flatMap(page => page.items)
      .map(item => item.event.messageId), ['retry-answer']);
    const retryProtocol = await json(base,
      `/api/v3/protocol/${provider}/${retryId}?version=3`);
    assert.deepEqual(retryProtocol.usageRecords.map(row =>
      [row.eventId, row.tokens.total]), [['event:dsh:1', 4], ['event:dsh:3', 6]]);
    assert.equal(inventory.find(row => row.session.sessionId === retryId).tokenCount, 10);
  });
