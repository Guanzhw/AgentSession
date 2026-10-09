import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createOutput, main, mcpCall, runRepetition, stopChildren, summarizeSamples, validateInputs } from '../scripts/v3-bench-shared-state.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tmp');
const sha = value => createHash('sha256').update(value).digest('hex');

async function frozenFixture(dir) {
  const exe = path.join(dir, 'package.exe');
  await writeFile(exe, 'exact package bytes');
  const providerRoots = {};
  for (const name of ['opencode', 'claude-code', 'codex', 'pi', 'deepseek-harness']) {
    const source = path.join(dir, `source-${name}`);
    await mkdir(source);
    providerRoots[name] = { path: source };
  }
  await mkdir(path.join(providerRoots.codex.path, 'sessions'));
  const manifest = { format: 'agentsession-v3-performance-input/v1', repetitions: 5,
    providerRoots, codexRoot: providerRoots.codex.path, queries: [{ label: 'metadata-title-directory', query: 'OpenSession',
      querySha256: sha('OpenSession'), providers: Object.keys(providerRoots), fields: ['title', 'directory'], limit: 20 }] };
  return { exe, expectedSha256: sha('exact package bytes'), manifest, queryLabel: 'metadata-title-directory',
    outputDir: path.join(dir, 'fresh-output') };
}

test('preflight accepts frozen Web-compatible query scopes and exact package bytes', async () => {
  await mkdir(tmp, { recursive: true });
  const dir = await mkdtemp(path.join(tmp, 'v3-shared-schema-'));
  try {
    const fixture = await frozenFixture(dir);
    assert.equal(validateInputs(fixture).label, fixture.queryLabel);
    fixture.manifest.queries[0].providers = ['codex'];
    fixture.manifest.queries[0].fields = ['user', 'assistant'];
    assert.equal(validateInputs(fixture).providers[0], 'codex');
    await writeFile(fixture.exe, 'changed package bytes');
    assert.throws(() => validateInputs(fixture), /hash mismatch/);
    await writeFile(fixture.exe, 'exact package bytes');
    fixture.manifest.queries[0].providers.pop();
    assert.throws(() => validateInputs(fixture), /query mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('entrypoint records frozen-source preflight failure before spawning services', async () => {
  await mkdir(tmp, { recursive: true });
  const dir = await mkdtemp(path.join(tmp, 'v3-shared-entrypoint-'));
  try {
    const fixture = await frozenFixture(dir);
    fixture.manifest.codexStat = { fileCount: 99 };
    const manifestFile = path.join(dir, 'manifest.private.json');
    await writeFile(manifestFile, JSON.stringify(fixture.manifest));
    await assert.rejects(main(['--exe', fixture.exe, '--sha256', fixture.expectedSha256,
      '--manifest', manifestFile, '--output-dir', fixture.outputDir]), /Frozen Codex stat manifest changed/);
    const ledger = JSON.parse(await readFile(path.join(fixture.outputDir, 'ledger.private.json'), 'utf8'));
    assert.deepEqual(ledger.repetitions, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('output preflight excludes source trees, existing evidence, and linked paths', async () => {
  await mkdir(tmp, { recursive: true });
  const dir = await mkdtemp(path.join(tmp, 'v3-shared-safety-'));
  try {
    const fixture = await frozenFixture(dir);
    assert.throws(() => validateInputs({ ...fixture, outputDir: path.join(fixture.manifest.codexRoot, 'derived') }), /separate/);
    await mkdir(fixture.outputDir);
    assert.throws(() => validateInputs(fixture), /already exists/);
    await rm(fixture.outputDir, { recursive: true });
    const link = path.join(dir, 'linked-output');
    await symlink(fixture.manifest.codexRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => createOutput(path.join(link, 'derived')), /link/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('resource summary only qualifies same-time observations of all three service PIDs', () => {
  const summary = summarizeSamples([
    { processes: [{ pid: 10, rssBytes: 100, peakRssBytes: 120, cpuMs: 5 },
      { pid: 11, rssBytes: 200, peakRssBytes: 220, cpuMs: 8 }] },
    { processes: [{ pid: 10, rssBytes: 120, peakRssBytes: 120, cpuMs: 7 },
      { pid: 11, rssBytes: 220, peakRssBytes: 220, cpuMs: 9 },
      { pid: 12, rssBytes: 300, peakRssBytes: 300, cpuMs: 4 }] },
  ], [10, 11, 12]);
  assert.equal(summary.completeThreePidSamples, 1);
  assert.equal(summary.peakSameTimeRssBytes, 640);
  assert.equal(summary.perProcess[10].lastCpuMs, 7);
});

test('cleanup terminates and observes an owned child even after a failed phase', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
  const closed = once(child, 'close');
  assert.equal(await stopChildren([{ child, closed }]), true);
  await closed;
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('captures the failed MCP browse continuation response and cursor before throwing', async () => {
  const args = { level: 'sessions', parent: null, limit: 100, cursor: 'retained-page-2-cursor' };
  const response = { isError: true, content: [{ type: 'text', text: '{"error":"provider_error"}' }] };
  const captured = [];
  const session = { client: { async callTool(request) {
    assert.deepEqual(request, { name: 'session_browse', arguments: args });
    return response;
  } }, capture: entry => captured.push(entry) };
  await assert.rejects(mcpCall(session, 'session_browse', args, 1000), /session_browse failed/);
  assert.equal(captured.length, 1, 'the original machine failure must survive the generic assertion');
  assert.deepEqual(captured[0].args, args);
  assert.deepEqual(captured[0].response, response);
  assert.equal(captured[0].tool, 'session_browse');
});

test('captures MCP SDK error data before propagating the original rejection', async () => {
  const failure = Object.assign(new Error('transport response rejected'), { code: -32000, data: { error: 'provider_error' } });
  const captured = [];
  const args = { cursor: 'failed-continuation' };
  const session = { client: { async callTool() { throw failure; } }, capture: entry => captured.push(entry) };
  await assert.rejects(mcpCall(session, 'session_browse', args, 1000), error => error === failure);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].args, args);
  assert.deepEqual(captured[0].error, { name: 'Error', message: failure.message, code: -32000, data: failure.data });
  assert.equal(captured[0].response, undefined);
});

test('retains the original MCP rejection when recording its evidence also fails', async () => {
  const failure = new Error('transport response rejected');
  const captureFailure = new Error('evidence disk full');
  const session = { client: { async callTool() { throw failure; } }, capture() { throw captureFailure; } };
  await assert.rejects(mcpCall(session, 'session_browse', { cursor: 'failed-continuation' }, 1000), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, failure);
    assert.deepEqual(error.errors, [failure, captureFailure]);
    return true;
  });
});


test('shared mcpCall persists its real error response and cursor before the success assertion', async t => {
  const { createCallEvidence } = await import('../scripts/v3-bench-call-evidence.mjs');
  const dir = await mkdtemp(path.join(tmp, 'v3-shared-file-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const evidence = createCallEvidence({ directory: path.join(dir, 'raw') });
  const args = { level: 'sessions', cursor: 'persisted-cursor' };
  const response = { isError: true, content: [{ type: 'text', text: 'provider_error: Could not read provider source.' }] };
  await assert.rejects(mcpCall({ name: 'mcp-b', evidence, phase: 'restart', client: { async callTool() { return response; } } },
    'session_browse', args, 1000), /session_browse failed/);
  assert.equal(evidence.audit().calls, 1);
  assert.equal(evidence.audit().ok, true);
  const request = JSON.parse(await readFile(path.join(dir, 'raw', '000001.begin.private.json'), 'utf8'));
  const terminal = JSON.parse(await readFile(path.join(dir, 'raw', '000001.terminal.private.json'), 'utf8'));
  assert.deepEqual(request.request.args, args);
  assert.deepEqual(terminal.response, response);
});

test('MCP startup rejection before PID observation preserves the original error promptly', async () => {
  const { connectOwnedMcp } = await import('../scripts/v3-bench-shared-state.mjs');
  const failure = Object.assign(new Error('owned executable spawn rejected'), { code: 'ENOENT' });
  const service = { transport: { pid: null }, client: { async connect() { throw failure; } } };
  const started = performance.now();
  await assert.rejects(connectOwnedMcp(service, 1000), error => error === failure);
  assert.ok(performance.now() - started < 500, 'An observed spawn rejection must not wait for the PID deadline');
});

test('timed out MCP startup observes its late rejection and closes the owned child', async t => {
  const { connectOwnedMcp } = await import('../scripts/v3-bench-shared-state.mjs');
  assert.equal(typeof connectOwnedMcp, 'function');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
  const failure = Object.assign(new Error('late SDK connect rejection'), { code: 'REQUEST_TIMEOUT' });
  const publishedAt = performance.now() + 100;
  const service = { name: 'startup-test', transport: { get pid() { return performance.now() >= publishedAt ? child.pid : null; }, _process: child },
    client: { connect() { return new Promise((_, reject) => setTimeout(() => reject(failure), 80)); }, async close() {} } };
  t.after(() => stopChildren([service]));
  await assert.rejects(connectOwnedMcp(service, 20), error => error.code === 'BENCH_TIMEOUT');
  assert.equal(await stopChildren([service]), true);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('missing search or browse cursor is detected before any continuation is dispatched', async () => {
  const { settleCalls } = await import('../scripts/v3-bench-call-evidence.mjs');
  const source = await readFile(path.join(root, 'scripts/v3-bench-shared-state.mjs'), 'utf8');
  // Exercise the private phase's actual dispatch block without starting provider services.
  const start = source.indexOf('      for (const [i, result] of first.slice(0, 3).entries())');
  const end = source.indexOf('      const searchNext =', start);
  assert.ok(start >= 0 && end > start);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction('settleCalls', 'first', 'webSearch', 'mcpCall', 'origin', 'query', 'options', 'httpContext', 'mcp', 'searchArgs', source.slice(start, end));
  for (const missing of [1, 4]) {
    const first = Array.from({ length: 5 }, (_, i) => ({ nextCursor: i === missing ? null : `cursor-${i}` }));
    let dispatched = 0;
    const call = async () => { dispatched++; return {}; };
    await assert.rejects(run(settleCalls, first, call, call, 'http://127.0.0.1:1', {}, { timeoutMs: 1000 },
      () => ({}), [{}, {}], {}), /continuation missing/);
    assert.equal(dispatched, 0);
  }
});

test('Web OS spawn rejection preserves typed failure, cleanup, and repetition record', async t => {
  await mkdir(tmp, { recursive: true });
  const dir = await mkdtemp(path.join(tmp, 'v3-shared-spawn-error-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = await frozenFixture(dir);
  const record = await runRepetition(1, { exe: path.join(dir, 'missing-owned-executable'), timeoutMs: 1000, sampleMs: 100 },
    fixture.manifest, fixture.manifest.queries[0], dir);
  assert.equal(record.status, 'failed');
  assert.equal(record.finalExits.find(item => item.name === 'web').spawnError.code, 'ENOENT');
  assert.equal(record.processesClosed, true);
  assert.equal(record.evidenceAudit.ok, true);
  assert.equal(record.evidenceAudit.pending, 0);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'rep-1/record.private.json'), 'utf8')).status, 'failed');
});
