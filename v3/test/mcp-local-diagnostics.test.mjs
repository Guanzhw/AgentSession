import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '../..');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const session = { provider: 'deepseek-harness', sessionId: 'dsh-v3-s2-root' };
const sentinel = 'PRIVATE_REQUEST_AND_RECORD_SENTINEL';

async function setup(t) {
  const root = await mkdtemp(path.join(repo, 'tmp/mcp-local-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  for (const name of ['codex', 'claude', 'pi', 'meta', 'index', 'cache']) {
    await mkdir(path.join(root, name));
  }
  await cp(path.join(repo, 'v3/fixtures/deepseek-harness'), path.join(root, 'dsh'),
    { recursive: true });
  return root;
}

async function connect(t, root) {
  const args = ['mcp', '--codex-dir', path.join(root, 'codex'),
    '--opencode-db', path.join(root, 'opencode.db'), '--claude-dir', path.join(root, 'claude'),
    '--pi-dir', path.join(root, 'pi'), '--dsh-dir', path.join(root, 'dsh'),
    '--meta-dir', path.join(root, 'meta'), '--index-dir', path.join(root, 'index'),
    '--cache-dir', path.join(root, 'cache')];
  const child = spawn(binary, args, { cwd: repo, windowsHide: true, stdio: 'pipe' });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const stdout = [];
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    stdout.push(line);
    let message;
    try { message = JSON.parse(line); } catch { return; }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  let id = 0;
  const request = (method, params) => new Promise(resolve => {
    const next = ++id;
    pending.set(next, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`);
  });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'mcp-local-diagnostics-test', version: '1.0.0' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    call: (name, arguments_) => request('tools/call', { name, arguments: arguments_ }),
    async finish() {
      child.stdin.end();
      const [code] = await closed;
      assert.equal(code, 0, stderr);
      for (const line of stdout) assert.equal(JSON.parse(line).jsonrpc, '2.0', line);
      assert.equal(stdout.length, id, 'stdout contains only the requested JSON-RPC responses');
      assert.doesNotMatch(stderr, new RegExp(sentinel));
      return stderr.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    },
  };
}

function assertWire(response, text) {
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent, undefined);
  assert.deepEqual(response.result.content, [{ type: 'text', text }]);
}

test('MCP JSON parse diagnostics retain category and file position without source records or changing wire errors',
  { timeout: 30_000 }, async t => {
    const root = await setup(t);
    const source = path.join(root, 'dsh/sessions/s2-synthetic', session.sessionId, 'session.v3.jsonl.zstd');
    const malformed = `{"type":"${sentinel}", invalid}`;
    await writeFile(source, zstdCompressSync(Buffer.from(`\n${malformed}\n`)));
    const client = await connect(t, root);
    assertWire(await client.call('session_get', { session }),
      'provider_error: Could not read provider source.');
    const logs = await client.finish();
    assert.ok(logs.some(log => log.tool === 'session_get' && log.stage === 'source_parse'
      && log.path === source && log.cause === 'invalid JSON syntax'
      && log.line === 2 && log.column === malformed.indexOf('invalid') + 1), JSON.stringify(logs));
  });

test('MCP compressed source failures expose their safe decoding category',
  { timeout: 30_000 }, async t => {
    const root = await setup(t);
    const source = path.join(root, 'dsh/sessions/s2-synthetic', session.sessionId, 'session.v3.jsonl.zstd');
    await writeFile(source, `invalid compressed frame ${sentinel}`);
    const client = await connect(t, root);
    assertWire(await client.call('session_get', { session }),
      'provider_error: Could not read provider source.');
    const logs = await client.finish();
    assert.ok(logs.some(log => log.tool === 'session_get' && log.stage === 'source_parse'
      && log.path === source && log.cause === 'invalid Zstandard frame magic'), JSON.stringify(logs));
  });

test('MCP provider validation failures never interpolate unknown source event types',
  { timeout: 30_000 }, async t => {
    const root = await setup(t);
    const source = path.join(root, 'dsh/sessions/s2-synthetic', session.sessionId, 'session.v3.jsonl.zstd');
    const rows = zstdDecompressSync(await readFile(source)).toString().trimEnd().split('\n').map(JSON.parse);
    rows[1].type = sentinel;
    await writeFile(source, zstdCompressSync(Buffer.from(`${rows.map(JSON.stringify).join('\n')}\n`)));
    const client = await connect(t, root);
    assertWire(await client.call('session_get', { session }),
      'provider_error: Could not read provider source.');
    const logs = await client.finish();
    assert.ok(logs.some(log => log.tool === 'session_get' && log.stage === 'source_parse'
      && log.path === source && log.cause === 'invalid DSH source structure'
      && log.line === undefined && log.column === undefined), JSON.stringify(logs));
  });

test('MCP Pi JSON diagnostics retain their file line across the provider boundary',
  { timeout: 30_000 }, async t => {
    const root = await setup(t);
    const sessions = path.join(root, 'pi/sessions');
    await mkdir(sessions);
    const source = path.join(sessions, 'parse-session.jsonl');
    const malformed = `{"payload":"${sentinel}", invalid}`;
    await writeFile(source, `${JSON.stringify({ type: 'session', id: 'parse-session', version: 3 })}\n`
      + `${malformed}\n`);
    const client = await connect(t, root);
    assertWire(await client.call('session_get', { session: { provider: 'pi', sessionId: 'parse-session' } }),
      'provider_error: Could not read provider source.');
    const logs = await client.finish();
    assert.ok(logs.some(log => log.tool === 'session_get' && log.stage === 'source_parse'
      && log.path === source && log.cause === 'invalid JSON syntax'
      && log.line === 2 && log.column === malformed.indexOf('invalid') + 1), JSON.stringify(logs));
  });

test('MCP derived directory I/O failures retain the OS cause on stderr only',
  { timeout: 30_000 }, async t => {
    const root = await setup(t);
    const index = path.join(root, 'index');
    await rm(index, { recursive: true });
    await writeFile(index, 'task-owned directory obstruction');
    const client = await connect(t, root);
    assertWire(await client.call('session_browse', { level: 'sessions', title: sentinel,
      providers: ['deepseek-harness'] }),
    'provider_error: Could not read provider source.');
    const logs = await client.finish();
    assert.ok(logs.some(log => log.tool === 'session_browse' && log.stage === 'source_io'
      && log.path === index && typeof log.cause === 'string' && log.cause.length > 0),
    JSON.stringify(logs));
  });

test('MCP corrupt derived SQLite retains its cause on stderr with the frozen index error',
  { timeout: 30_000 }, async t => {
    const root = await setup(t);
    const client = await connect(t, root);
    const args = { level: 'sessions', title: 'synthetic', providers: ['deepseek-harness'] };
    const healthy = await client.call('session_browse', args);
    assert.notEqual(healthy.result.isError, true, JSON.stringify(healthy));
    const databases = (await readdir(path.join(root, 'index'))).filter(name => name.endsWith('.sqlite'));
    assert.equal(databases.length, 1);
    await writeFile(path.join(root, 'index', databases[0]), 'task-owned invalid SQLite');
    assertWire(await client.call('session_browse', { ...args, title: sentinel }),
      'index_error: Could not read the derived index.');
    const logs = await client.finish();
    assert.ok(logs.some(log => log.tool === 'session_browse' && log.stage === 'storage'
      && /not a database/i.test(log.cause)), JSON.stringify(logs));
  });
