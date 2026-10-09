import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';

const repo = fileURLToPath(new URL('../', import.meta.url));
async function setup(t) {
  const module = await import('../scripts/v3-bench-call-evidence.mjs');
  await mkdir(path.join(repo, 'tmp'), { recursive: true });
  const root = await mkdtemp(path.join(repo, 'tmp', 'call-evidence-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = module.createCallEvidence({ directory: path.join(root, 'raw-calls') });
  return { ...module, evidence, root };
}
async function pair(root) {
  const dir = path.join(root, 'raw-calls');
  const names = await readdir(dir);
  const begin = JSON.parse(await readFile(path.join(dir, names.find(n => n.endsWith('.begin.private.json'))), 'utf8'));
  const terminal = JSON.parse(await readFile(path.join(dir, names.find(n => n.endsWith('.terminal.private.json'))), 'utf8'));
  return { begin, terminal };
}

test('MCP evidence is on disk before dispatch and preserves a successful raw result', async t => {
  const { evidence, root, callMcpRaw } = await setup(t);
  const args = { cursor: 'original-cursor' };
  const response = { content: [], structuredContent: { result: { matches: [{ session: { sessionId: 'real-result' } }] } } };
  const session = { name: 'mcp-b', pid: 123, client: { async callTool(request) {
    const names = await readdir(path.join(root, 'raw-calls'));
    assert.equal(names.filter(n => n.endsWith('.begin.private.json')).length, 1);
    assert.equal(names.filter(n => n.endsWith('.terminal.private.json')).length, 0);
    assert.deepEqual(request.arguments, args);
    return response;
  } } };
  assert.equal(await callMcpRaw(session, 'session_search', args, 1000, { evidence, phase: 'restart' }), response);
  const saved = await pair(root);
  assert.deepEqual(saved.begin.request.args, args);
  assert.equal(saved.begin.request.phase, 'restart');
  assert.equal(saved.begin.request.pid, 123);
  assert.deepEqual(saved.terminal.response, response);
  assert.equal(evidence.audit().ok, true);
});

test('tool error and expected stale cursor response are retained without a raw-call assertion', async t => {
  const { evidence, root, callMcpRaw } = await setup(t);
  const response = { isError: true, content: [{ type: 'text', text: 'source_changed: Source changed since this request.' }] };
  assert.equal(await callMcpRaw({ name: 'stale-check', client: { async callTool() { return response; } } },
    'session_browse', { cursor: 'stale-but-exact-cursor' }, 1000, { evidence, phase: 'stale-cursors' }), response);
  const saved = await pair(root);
  assert.equal(saved.begin.request.args.cursor, 'stale-but-exact-cursor');
  assert.deepEqual(saved.terminal.response, response);
  assert.equal(evidence.audit().calls, 1);
});

test('SDK rejection code and data survive actual evidence files', async t => {
  const { evidence, root, callMcpRaw } = await setup(t);
  const failure = Object.assign(new Error('rejected'), { code: -32000, data: { detail: 'source unavailable' } });
  await assert.rejects(callMcpRaw({ client: { async callTool() { throw failure; } } }, 'session_browse',
    { cursor: 'failed-cursor' }, 1000, { evidence, phase: 'restart' }), e => e === failure);
  const saved = await pair(root);
  assert.equal(saved.terminal.error.code, -32000);
  assert.deepEqual(saved.terminal.error.data, failure.data);
  assert.equal(evidence.audit().ok, true);
});

test('a timed out MCP call has a terminal record and retains its original cursor', async t => {
  const { evidence, root, callMcpRaw } = await setup(t);
  await assert.rejects(callMcpRaw({ client: { callTool() { return new Promise(() => {}); } } },
    'session_browse', { cursor: 'timeout-cursor' }, 20, { evidence, phase: 'restart' }), e => e.code === 'BENCH_TIMEOUT');
  const saved = await pair(root);
  assert.equal(saved.terminal.error.code, 'BENCH_TIMEOUT');
  assert.equal(saved.begin.request.args.cursor, 'timeout-cursor');
  assert.equal(evidence.audit().pending, 0);
});

test('HTTP non-JSON error text is saved before the caller tries to parse it', async t => {
  const { evidence, root, callHttpRaw } = await setup(t);
  const response = await callHttpRaw('http://127.0.0.1:1234/broken', {}, {
    evidence, phase: 'refresh', timeoutMs: 1000,
    fetchImpl: async () => new Response('upstream failed: not JSON', { status: 503 }),
  });
  assert.equal(response.status, 503);
  assert.throws(() => JSON.parse(response.text));
  const saved = await pair(root);
  assert.equal(saved.terminal.response.status, 503);
  assert.equal(saved.terminal.response.text, 'upstream failed: not JSON');
  assert.equal(evidence.audit().ok, true);
});

test('AggregateError causes are serialized to disk and evidence audit detects altered content', async t => {
  const { evidence, root, callMcpRaw } = await setup(t);
  const sdk = Object.assign(new Error('sdk failed'), { code: -32001, data: { source: 'frozen' } });
  const disk = Object.assign(new Error('capture failed'), { code: 'EACCES' });
  const aggregate = new AggregateError([sdk, disk], sdk.message, { cause: sdk });
  await assert.rejects(callMcpRaw({ client: { async callTool() { throw aggregate; } } }, 'session_search', {}, 1000,
    { evidence, phase: 'initial' }), e => e === aggregate);
  const saved = await pair(root);
  assert.equal(saved.terminal.error.cause.code, -32001);
  assert.equal(saved.terminal.error.errors[1].code, 'EACCES');
  assert.equal(evidence.audit().ok, true);
  const name = (await readdir(path.join(root, 'raw-calls'))).find(n => n.endsWith('.terminal.private.json'));
  await writeFile(path.join(root, 'raw-calls', name), JSON.stringify({ ...saved.terminal, outcome: 'altered' }));
  assert.equal(evidence.audit().ok, false);
  assert.ok(evidence.audit().issues.some(i => i.includes('hash')));
});

test('parallel failure waits for peer terminal evidence before propagating the first error', async t => {
  const { evidence, callMcpRaw, settleCalls } = await setup(t);
  const failure = new Error('first rejected');
  const fast = callMcpRaw({ client: { async callTool() { throw failure; } } }, 'session_search', {}, 1000, { evidence });
  const slow = callMcpRaw({ client: { async callTool() { await new Promise(r => setTimeout(r, 30)); return { content: [] }; } } },
    'session_browse', {}, 1000, { evidence });
  await assert.rejects(settleCalls([fast, slow]), e => e === failure);
  assert.equal(evidence.audit().pending, 0);
  assert.equal(evidence.audit().calls, 2);
});

test('SDK timeout wrapped by AggregateError is classified without losing its cause', async t => {
  const { classifyCallError, serializeError } = await setup(t);
  const { SdkError, SdkErrorCode } = await import('@modelcontextprotocol/client');
  const sdk = new SdkError(SdkErrorCode.RequestTimeout, 'SDK request expired', { timeout: 20 });
  const wrapped = new AggregateError([sdk, new Error('capture failed')], sdk.message, { cause: sdk });
  assert.equal(classifyCallError(wrapped), 'Timeout');
  assert.equal(serializeError(wrapped).cause.code, 'REQUEST_TIMEOUT');
});

test('startup with an unavailable child handle still has an exit snapshot', async t => {
  const { childExitSnapshot } = await setup(t);
  assert.deepEqual(childExitSnapshot({ name: 'mcp-b', child: null, transport: { pid: 456 } }),
    { name: 'mcp-b', pid: 456, code: null, signal: null, handleAvailable: false });
});

test('actual HTTP deadline is classified Timeout while its DOMException evidence stays intact', async t => {
  const { evidence, root, callHttpRaw, classifyCallError } = await setup(t);
  const server = createServer((_request, _response) => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let failure;
  try {
    await assert.rejects(callHttpRaw(`http://127.0.0.1:${server.address().port}/stall`, {},
      { evidence, timeoutMs: 100, phase: 'deadline' }), error => { failure = error; return classifyCallError(error) === 'Timeout'; });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  const saved = await pair(root);
  assert.equal(saved.terminal.error.name, failure.name);
  assert.equal(saved.terminal.error.code, failure.code);
  assert.equal(evidence.audit().ok, true);
  assert.equal(classifyCallError(new AggregateError([failure], failure.message, { cause: failure })), 'Timeout');
});
