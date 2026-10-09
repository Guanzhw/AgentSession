import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { artifactStat, runTrial, search } from '../scripts/v3-bench-matched.mjs';
import { createCallEvidence } from '../scripts/v3-bench-call-evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tmp');
const runner = path.join(root, 'scripts/v3-bench-matched.mjs');
const revision = execFileSync('git', ['-c', `safe.directory=${root}`, '-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const digest = (value) => createHash('sha256').update(value).digest('hex');
const canonicalJson = (value) => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
  : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const fakeMcp = `
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const arm = process.argv[2];
const scenario = process.argv[3];
const mismatch = scenario === 'mismatch';
if (scenario === 'env-check') {
  process.stderr.write('synthetic private child diagnostic');
  const directory = process.argv.at(-1);
  mkdirSync(directory, {recursive: true});
  writeFileSync(path.join(directory, 'child-env.private.json'), JSON.stringify(Object.fromEntries(
    ['AGENTSESSION_TEST_UNSAFE', 'agentsession_test_case', 'PORT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
      'AGENTSESSION_META_PATH', 'AGENTSESSION_CONFIG'].map(key => [key, process.env[key] ?? null]))));
}
let calls = 0;
const server = new McpServer({ name: 'matched-bench-test', version: '1.0.0' });
server.registerTool('session_search', { inputSchema: z.object({
  query: z.string(), providers: z.array(z.string()), fields: z.array(z.string()),
  limit: z.number(), updatedBefore: z.number(), cursor: z.string().optional()
}) }, ({ query, providers, cursor }) => {
  calls++;
  const page = cursor ? 2 : 1;
  const result = {
    matches: [{ session: { provider: providers[0], sessionId: query + '-' + page },
      matchField: 'title', matchRole: null,
      snippet: mismatch && arm === 'v3' && query === 'q3' ? 'altered'
        : scenario === 'stale-first' && calls === 1 ? 'stale' : query }],
    diagnostics: providers.map((provider) => ({ provider, status: 'ok' })),
    nextCursor: cursor ? null : 'synthetic-page-2', truncated: !cursor,
  };
  return { content: [{ type: 'text', text: 'private synthetic content' }], structuredContent: { result } };
});
serveStdio(() => server);
`;

test('artifact hash includes runtime modules behind an unchanged entrypoint', async () => {
  await mkdir(tmp, { recursive: true });
  const directory = await mkdtemp(path.join(tmp, 'v3-artifact-hash-test-'));
  try {
    await writeFile(path.join(directory, 'cli.js'), 'entry');
    await writeFile(path.join(directory, 'core.js'), 'old');
    const before = artifactStat([directory]);
    await writeFile(path.join(directory, 'core.js'), 'new');
    const after = artifactStat([directory]);
    assert.equal(before.fileCount, 2);
    assert.equal(after.fileCount, 2);
    assert.notEqual(before.sha256, after.sha256);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('changed runtime artifact is rejected before any benchmark attempt', async () => {
  await mkdir(tmp, { recursive: true });
  const directory = await mkdtemp(path.join(tmp, 'v3-artifact-preflight-test-'));
  try {
    const { manifestPath, armsPath, goldenPath } = await fixture(directory);
    await writeFile(path.join(directory, 'fake-mcp.mjs'), fakeMcp + '\n// changed after freeze\n');
    const output = path.join(directory, 'output');
    const child = spawn(process.execPath, [runner, '--manifest', manifestPath, '--arms', armsPath,
      '--golden', goldenPath, '--output-dir', output], { cwd: root, windowsHide: true });
    const [exitCode] = await once(child, 'close');
    assert.notEqual(exitCode, 0);
    await assert.rejects(stat(path.join(output, 'rep-1-v2')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('stale display artifact path cannot contradict the hashed runtime artifact', async () => {
  await mkdir(tmp, { recursive: true });
  const directory = await mkdtemp(path.join(tmp, 'v3-artifact-identity-test-'));
  try {
    const { manifestPath, armsPath, goldenPath } = await fixture(directory);
    const arms = JSON.parse(await readFile(armsPath, 'utf8'));
    const previousBinary = path.join(directory, 'previous-binary.mjs');
    await writeFile(previousBinary, fakeMcp);
    arms.v3.artifactPath = previousBinary;
    await writeFile(armsPath, JSON.stringify(arms));
    const output = path.join(directory, 'output');
    const child = spawn(process.execPath, [runner, '--manifest', manifestPath, '--arms', armsPath,
      '--golden', goldenPath, '--output-dir', output], { cwd: root, windowsHide: true });
    const [exitCode] = await once(child, 'close');
    assert.notEqual(exitCode, 0);
    await assert.rejects(stat(path.join(output, 'rep-1-v2')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function fixture(directory, scenario = 'match', driftGolden = false, verificationStatus = 'source-verified') {
  const roots = {};
  const providerStats = {};
  for (const name of ['opencode', 'claude-code', 'codex', 'pi', 'deepseek-harness']) {
    const source = path.join(directory, name);
    const file = name === 'opencode' ? source : path.join(source, name === 'codex' ? 'sessions/a.jsonl' : 'data.txt');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, name);
    roots[name] = { path: source };
    const info = await stat(file);
    const relative = name === 'opencode' ? 'opencode' : name === 'codex' ? 'a.jsonl' : 'data.txt';
    providerStats[name] = { fileCount: 1, totalBytes: info.size,
      statManifestSha256: digest(JSON.stringify([relative, info.size, info.mtimeMs])),
      ...(name === 'codex' ? {} : { contentManifestSha256: digest(`${relative}\0${digest(name)}\0`) }) };
  }
  const codexStat = providerStats.codex;
  const queries = Array.from({ length: 9 }, (_, i) => ({ label: `label-${i}`, query: `q${i}`,
    providers: ['codex'], fields: ['title'], limit: 20, querySha256: digest(`q${i}`) }));
  const manifest = { format: 'agentsession-v3-performance-input/v1', baselineSha: revision,
    codexRoot: roots.codex.path, providerRoots: roots, codexStat, updatedBeforeUnixMs: 100,
    repetitions: 5, pairedOrder: ['v2', 'v3', 'v3', 'v2', 'v2', 'v3', 'v3', 'v2', 'v2', 'v3'],
    cacheLabel: 'unknown', queries };
  const fakePath = path.join(directory, 'fake-mcp.mjs');
  await writeFile(fakePath, fakeMcp);
  const arm = (name) => ({ command: process.execPath, cwd: root, artifactPath: fakePath,
    artifactPaths: [fakePath], artifactSha256: artifactStat([fakePath]).sha256,
    revision,
    args: [fakePath, name, scenario,
      ...Object.keys(roots).map((key) => `{${key}}`),
      ...(name === 'v3' ? ['{metaDir}', '{indexDir}', '{cacheDir}'] : [])] });
  const manifestPath = path.join(directory, 'manifest.private.json');
  const armsPath = path.join(directory, 'arms.private.json');
  const goldenPath = path.join(directory, 'golden.private.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(armsPath, JSON.stringify({ v2: arm('v2'), v3: arm('v3') }));
  await writeFile(goldenPath, JSON.stringify({ format: 'agentsession-v3-search-golden/v1',
    verification: { status: verificationStatus, evidence: 'synthetic fixture defined in this test' },
    providerStats: driftGolden ? { ...providerStats, pi: { ...providerStats.pi, totalBytes: providerStats.pi.totalBytes + 1 } } : providerStats,
    queries: queries.map((query) => ({ label: query.label, querySha256: query.querySha256, count: 2,
      firstPageSemanticSha256: digest(canonicalJson([{ session: { provider: 'codex', sessionId: `${query.query}-1` },
        matchField: 'title', matchRole: null, snippet: query.query }])),
      orderedSemanticSha256: digest(canonicalJson([1, 2].map((page) => ({
        session: { provider: 'codex', sessionId: `${query.query}-${page}` },
        matchField: 'title', matchRole: null, snippet: query.query
      })))) })) }));
  return { manifestPath, armsPath, goldenPath };
}

async function runCase(scenario, driftGolden = false, verificationStatus = 'source-verified') {
  await mkdir(tmp, { recursive: true });
  const directory = await mkdtemp(path.join(tmp, 'v3-bench-test-'));
  try {
    const { manifestPath, armsPath, goldenPath } = await fixture(directory, scenario, driftGolden, verificationStatus);
    const output = path.join(directory, 'output');
    const child = spawn(process.execPath, [runner, '--manifest', manifestPath, '--arms', armsPath, '--golden', goldenPath,
      '--output-dir', output, '--timeout-ms', '10000'], { cwd: root, windowsHide: true });
    let stderr = '';
    let stdout = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    const [exitCode] = await once(child, 'close');
    const summary = JSON.parse(await readFile(path.join(output, 'summary.public.json'), 'utf8'));
    const ledger = JSON.parse(await readFile(path.join(output, 'ledger.private.json'), 'utf8'));
    assert.equal(ledger.records.length, 10);
    const firstV3 = JSON.parse(await readFile(path.join(output, 'rep-1-v3/record.private.json'), 'utf8'));
    assert.deepEqual(firstV3.command.args.slice(-3), ['meta', 'index', 'cache'].map(name =>
      path.join(output, 'rep-1-v3/state', name)));
    assert.equal(summary.metrics.v2.attempts.length, 5);
    assert.equal(summary.metrics.v3.attempts.length, 5);
    assert.deepEqual(summary.input.pairedOrder, ['v2', 'v3', 'v3', 'v2', 'v2', 'v3', 'v3', 'v2', 'v2', 'v3']);
    assert.equal(summary.artifactsUnchanged, true);
    assert.equal(summary.artifacts.v2.fileCount, 1);
    assert.equal(summary.metrics.v2.queries.length, 9);
    assert.equal(summary.metrics.v2.queries[0].count, 2);
    assert.equal(summary.metrics.v2.queries[0].samples.length, 5);
    assert.equal(summary.metrics.v2.attempts[0].processExits.length, 2);
    assert.equal(typeof summary.metrics.v2.attempts[0].processExits[0].code, 'number');
    assert.equal(JSON.stringify(summary).includes(directory), false);
    assert.equal(JSON.stringify(summary).includes('private synthetic content'), false);
    assert.equal(stdout.includes(directory), false);
    return { summary, exitCode, stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('direct trial applies the frozen top-level cutoff to every search', async () => {
  await mkdir(tmp, { recursive: true });
  const directory = await mkdtemp(path.join(tmp, 'v3-bench-direct-cutoff-test-'));
  try {
    const { manifestPath, armsPath } = await fixture(directory);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const arms = JSON.parse(await readFile(armsPath, 'utf8'));
    const outputDir = path.join(directory, 'output');
    await mkdir(outputDir);
    const record = await runTrial({ armName: 'v3', repetition: 1, manifest,
      arm: arms.v3, outputDir, timeoutMs: 10000 });
    assert.equal(record.status, 'ok', JSON.stringify(record.errors));
    assert.equal(record.queries.length, manifest.queries.length);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('configured search timeout reaches the MCP SDK request', async () => {
  let call;
  const client = { callTool: async (params, options) => {
    call = { params, options };
    return { structuredContent: { result: { matches: [],
      diagnostics: [{ provider: 'codex', status: 'ok' }], nextCursor: null, truncated: false } } };
  } };
  const result = await search(client, { query: 'q', providers: ['codex'], fields: ['title'],
    limit: 20, updatedBeforeUnixMs: 100 }, 120001);
  assert.equal(result.errorKind, undefined);
  assert.equal(call.params.arguments.updatedBefore, 100);
  assert.equal(call.options.timeout, 120001);
});

test('five alternating pairs traverse all pages and publish a sanitized summary', { timeout: 120000 }, async () => {
  const result = await runCase('match');
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.summary.searchParityPassed, true);
  assert.equal(result.summary.searchGoldenPassed, true);
  assert.equal(result.summary.searchSpeedupEligible, true);
});

test('changed snippet with identical canonical keys blocks search speedup eligibility', { timeout: 120000 }, async () => {
  const result = await runCase('mismatch');
  assert.equal(result.exitCode, 1, result.stderr);
  assert.equal(result.summary.searchParityPassed, false);
  assert.equal(result.summary.searchGoldenPassed, false);
  assert.equal(result.summary.searchSpeedupEligible, false);
});

test('a drifted non-Codex source signature blocks search speedup eligibility', { timeout: 120000 }, async () => {
  const result = await runCase('match', true);
  assert.equal(result.exitCode, 1, result.stderr);
  assert.equal(result.summary.searchParityPassed, true);
  assert.equal(result.summary.searchGoldenPassed, false);
  assert.equal(result.summary.searchSpeedupEligible, false);
});

test('a repeatable 2.0 candidate is ineligible without independent source verification', { timeout: 120000 }, async () => {
  const result = await runCase('match', false, 'candidate-unverified');
  assert.equal(result.exitCode, 1, result.stderr);
  assert.equal(result.summary.searchParityPassed, true);
  assert.equal(result.summary.searchGoldenPassed, false);
  assert.equal(result.summary.searchSpeedupEligible, false);
});

test('a stale first answer does not count as verified readiness', { timeout: 120000 }, async () => {
  const result = await runCase('stale-first');
  assert.equal(result.exitCode, 1, result.stderr);
  assert.equal(result.summary.searchGoldenPassed, false);
  assert.equal(result.summary.metrics.v2.attempts[0].freshAnswerReadyMs, null);
  assert.equal(result.summary.metrics.v2.attempts[0].restartAnswerReadyMs, null);
  assert.equal(result.summary.metrics.v2.startup['fresh-build'].p95Ms, null);
});


async function rawSearchFixture(t) {
  await mkdir(tmp, { recursive: true });
  const directory = await mkdtemp(path.join(tmp, 'v3-matched-raw-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rawDirectory = path.join(directory, 'raw-calls');
  const evidence = createCallEvidence({ directory: rawDirectory });
  const saved = async () => ({
    begin: JSON.parse(await readFile(path.join(rawDirectory, '000001.begin.private.json'), 'utf8')),
    terminal: JSON.parse(await readFile(path.join(rawDirectory, '000001.terminal.private.json'), 'utf8')),
  });
  const query = { query: 'q', providers: ['codex'], fields: ['title'], limit: 20, updatedBeforeUnixMs: 100 };
  return { evidence, saved, query };
}

test('matched search persists the tool error body and exact continuation cursor before validation', async t => {
  const { evidence, saved, query } = await rawSearchFixture(t);
  const response = { isError: true, content: [{ type: 'text', text: 'provider_error: private exact failure' }] };
  const result = await search({ async callTool() { return response; } }, query, 1000, 'exact-failed-cursor',
    { evidence, phase: 'restart', service: 'v3', pid: 123 });
  assert.equal(result.errorKind, 'InvalidResult');
  assert.equal(evidence.audit().calls, 1);
  const files = await saved();
  assert.equal(files.begin.request.args.cursor, 'exact-failed-cursor');
  assert.equal(files.begin.request.phase, 'restart');
  assert.equal(files.begin.request.service, 'v3');
  assert.equal(files.begin.request.pid, 123);
  assert.deepEqual(files.terminal.response, response);
  assert.equal(evidence.audit().ok, true);
});

test('matched search persists SDK code and data with its original cursor', async t => {
  const { evidence, saved, query } = await rawSearchFixture(t);
  const failure = Object.assign(new Error('provider rejected request'), { code: -32000, data: { provider: 'codex' } });
  const result = await search({ async callTool() { throw failure; } }, query, 1000, 'sdk-rejected-cursor',
    { evidence, phase: 'full-search', service: 'v2' });
  assert.equal(result.errorKind, 'Error');
  assert.equal(evidence.audit().calls, 1);
  const files = await saved();
  assert.equal(files.begin.request.args.cursor, 'sdk-rejected-cursor');
  assert.equal(files.terminal.error.code, -32000);
  assert.deepEqual(files.terminal.error.data, failure.data);
  assert.equal(evidence.audit().ok, true);
});

test('matched search timeout reaches a terminal evidence file with no pending calls', async t => {
  const { evidence, saved, query } = await rawSearchFixture(t);
  const result = await search({ callTool() { return new Promise(() => {}); } }, query, 20, 'timed-out-cursor',
    { evidence, phase: 'full-search', service: 'v3' });
  assert.equal(result.errorKind, 'timeout');
  assert.equal(evidence.audit().calls, 1);
  const files = await saved();
  assert.equal(files.begin.request.args.cursor, 'timed-out-cursor');
  assert.equal(files.terminal.error.code, 'BENCH_TIMEOUT');
  assert.equal(evidence.audit().pending, 0);
});

test('matched real child clears inherited AgentSession and PORT variables and uses a shadow profile', async t => {
  await mkdir(tmp, { recursive: true });
  const directory = await mkdtemp(path.join(tmp, 'v3-matched-child-env-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { manifestPath, armsPath } = await fixture(directory, 'env-check');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const arms = JSON.parse(await readFile(armsPath, 'utf8'));
  const outputDir = path.join(directory, 'output');
  await mkdir(outputDir);
  const keys = ['AGENTSESSION_TEST_UNSAFE', 'agentsession_test_case', 'PORT'];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = 'synthetic-must-not-reach-child';
  try {
    const record = await runTrial({ armName: 'v3', repetition: 1, manifest, arm: arms.v3, outputDir, timeoutMs: 10000 });
    assert.equal(record.status, 'ok', JSON.stringify(record.errors));
    const trial = path.join(outputDir, 'rep-1-v3');
    const observed = JSON.parse(await readFile(path.join(trial, 'state/cache/child-env.private.json'), 'utf8'));
    for (const key of keys) assert.equal(observed[key], null);
    for (const [key, folder] of [['APPDATA','Roaming'],['LOCALAPPDATA','Local'],['USERPROFILE','Home']]) {
      assert.equal(observed[key], path.join(trial, 'profile', folder));
    }
    assert.equal(observed.AGENTSESSION_META_PATH, path.join(trial, 'state/meta.db'));
    assert.equal(observed.AGENTSESSION_CONFIG, path.join(trial, 'config.json'));
    assert.equal(record.rawEvidence.ok, true);
    assert.equal(record.rawEvidence.pending, 0);
    assert.equal(record.rawEvidence.counts.mcp, 29);
    assert.equal(record.rawEvidence.counts['mcp-lifecycle'], 2);
    const names = await readdir(path.join(trial, 'raw-calls'));
    assert.equal(names.filter(name => name.endsWith('.begin.private.json')).length, 31);
    assert.equal(record.stderrArtifacts.length, 2);
    assert.deepEqual(record.stderrArtifacts.map(item => item.phase), ['fresh-build', 'unchanged-restart']);
    for (const artifact of record.stderrArtifacts) {
      const bytes = await readFile(path.join(trial, artifact.relativePath));
      assert.equal(bytes.includes(Buffer.from('synthetic private child diagnostic')), true);
      assert.equal(artifact.bytes, bytes.length);
      assert.equal(artifact.sha256, digest(bytes));
      assert.equal(path.isAbsolute(artifact.relativePath), false);
    }
  } finally {
    for (const key of keys) original[key] === undefined ? delete process.env[key] : process.env[key] = original[key];
  }
});
