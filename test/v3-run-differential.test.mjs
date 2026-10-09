import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../', import.meta.url));
const tmp = path.join(repo, 'tmp');
const runner = path.join(repo, 'scripts', 'v3-run-differential.mjs');
const digest = (value) => createHash('sha256').update(value).digest('hex');

async function freePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function fixture(t, v3Body = 'SYNTHETIC_SAME', withMcp = false) {
  const dir = await mkdtemp(path.join(tmp, 'v3-run-test-'));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(dir)), await realpath(tmp));
    await rm(dir, { recursive: true, force: true });
  });
  const server = path.join(dir, 'server.mjs');
  const mcpServer = path.join(dir, 'mcp-server.mjs');
  const corpusRoot = path.join(dir, 'corpus');
  await mkdir(corpusRoot);
  const manifest = path.join(corpusRoot, 'manifest.json');
  const sourceFile = path.join(corpusRoot, 'sample.jsonl');
  const capturePlan = path.join(dir, 'capture-plan.json');
  const policy = path.join(dir, 'policy.json');
  const configPath = path.join(dir, 'config.json');
  const report = path.join(dir, 'report.json');
  await writeFile(server, `import { createServer } from 'node:http';\nconst port = Number(process.argv[2]);\ncreateServer((request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(request.url === '/api/providers' ? { ready: true } : { body: process.env.SYNTHETIC_BODY, role: 'assistant', cursor: 'end' })); }).listen(port, '127.0.0.1');\n`);
  const sourceContent = '{"synthetic":true}\n';
  await writeFile(sourceFile, sourceContent);
  const manifestContent = JSON.stringify({ files: [{ snapshotPath: sourceFile, snapshotSha256: digest(sourceContent) }] }) + '\n';
  await writeFile(manifest, manifestContent);
  if (withMcp) await writeFile(mcpServer, `import { McpServer } from '@modelcontextprotocol/server';\nimport { serveStdio } from '@modelcontextprotocol/server/stdio';\nimport { z } from 'zod';\nconst server = new McpServer({ name: 'synthetic-runner-test', version: '1.0.0' });\nserver.registerTool('sample', { inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: 'SYNTHETIC_MCP_RESULT' }], structuredContent: { result: { canonicalId: 'synthetic-id' } } }));\nserveStdio(() => server);\n`);
  await writeFile(capturePlan, JSON.stringify({ format: 'agentsession-v3-capture-plan/v1', cases: [
    { id: 'synthetic-http', kind: 'http', path: '/case', body: 'json' },
    ...(withMcp ? [{ id: 'synthetic-mcp', kind: 'mcp-call', name: 'sample', arguments: {} }] : []),
  ] }));
  await writeFile(policy, JSON.stringify({ format: 'agentsession-v3-volatile-policy/v1', cases: [] }));
  const sourceStateEnv = { CORPUS: '${CORPUS_ROOT}', META: '${META_DIR}', INDEX: '${INDEX_DIR}', CACHE: '${CACHE_DIR}' };
  const side = (label, port, body) => ({
    port,
    state: Object.fromEntries(['metaDir', 'indexDir', 'cacheDir'].map((key) => [key, path.join(dir, label, key)])),
    web: {
      command: process.execPath, args: [server, '${PORT}'], cwd: repo,
      env: { SYNTHETIC_BODY: body, ...sourceStateEnv },
    },
    ...(withMcp ? { mcp: { command: process.execPath, args: ['mcp-server.mjs'], cwd: dir, env: sourceStateEnv } } : {}),
  });
  const v2Port = await freePort();
  let v3Port = await freePort();
  while (v3Port === v2Port) v3Port = await freePort();
  const config = {
    format: 'agentsession-v3-differential-plan/v1',
    corpus: { root: corpusRoot, manifest, manifestSha256: digest(manifestContent) },
    capturePlan, volatilePolicy: policy,
    sides: { v2: side('v2', v2Port, 'SYNTHETIC_SAME'), v3: side('v3', v3Port, v3Body) },
  };
  await writeFile(configPath, JSON.stringify(config));
  return { dir, config, configPath, report, manifest, sourceFile };
}

function run(f) {
  return spawnSync(process.execPath, [runner, '--config', f.configPath, '--report', f.report], { cwd: repo, encoding: 'utf8', timeout: 30000 });
}

test('starts two isolated Web processes and reports an exact match without private bodies', async (t) => {
  const f = await fixture(t);
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Differential match; 0 differences.\n');
  const report = JSON.parse(await readFile(f.report, 'utf8'));
  assert.equal(report.status, 'match');
  assert.equal(report.comparison.exitCode, 0);
  assert.equal(report.snapshots.v2.sha256, report.snapshots.v3.sha256);
  assert.doesNotMatch(JSON.stringify(report) + result.stdout + result.stderr, /SYNTHETIC_SAME/);
});

test('detects semantic body differences and leaves private evidence under tmp', async (t) => {
  const f = await fixture(t, 'PRIVATE_SYNTHETIC_CHANGED');
  const result = run(f);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(await readFile(f.report, 'utf8'));
  assert.equal(report.status, 'different');
  assert.equal(report.comparison.differenceCount, 1);
  assert.notEqual(report.snapshots.v2.sha256, report.snapshots.v3.sha256);
  assert.doesNotMatch(JSON.stringify(report) + result.stdout + result.stderr, /PRIVATE_SYNTHETIC_CHANGED/);
});

test('starts each side\'s stdio MCP command for the same tool case', async (t) => {
  const f = await fixture(t, 'SYNTHETIC_SAME', true);
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(f.report, 'utf8'));
  assert.equal(report.status, 'match');
  assert.equal(JSON.parse(await readFile(path.join(f.dir, 'v2-snapshot.private.json'), 'utf8')).cases.length, 2);
});

test('rejects shared state and a changed corpus manifest before starting either process', async (t) => {
  const f = await fixture(t);
  f.config.sides.v3.state.metaDir = f.config.sides.v2.state.metaDir;
  await writeFile(f.configPath, JSON.stringify(f.config));
  let result = run(f);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /State directories must be separate/);
  assert.equal(JSON.parse(await readFile(f.report, 'utf8')).status, 'error');

  const g = await fixture(t);
  await writeFile(g.manifest, '{"frozen":"changed"}\n');
  result = run(g);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Corpus manifest SHA-256 mismatch/);
});

test('rejects a changed source file even when the corpus manifest itself is unchanged', async (t) => {
  const f = await fixture(t);
  await writeFile(f.sourceFile, '{"synthetic":false}\n');
  const result = run(f);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Frozen corpus source changed/);
});

test('rejects an occupied port instead of capturing another service', async (t) => {
  const f = await fixture(t);
  const holder = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${f.config.sides.v2.port}, '127.0.0.1')`], { stdio: 'ignore', windowsHide: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const result = run(f);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /v2 port is already occupied/);
  } finally {
    holder.kill();
    await once(holder, 'close');
  }
});

test('rejects process specs that omit the shared corpus or place state inside it', async (t) => {
  const f = await fixture(t);
  delete f.config.sides.v3.web.env.CORPUS;
  await writeFile(f.configPath, JSON.stringify(f.config));
  let result = run(f);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must reference shared corpus/);

  const g = await fixture(t);
  g.config.sides.v3.state.cacheDir = path.join(g.config.corpus.root, 'cache');
  await writeFile(g.configPath, JSON.stringify(g.config));
  result = run(g);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /outside the frozen corpus root/);
  await assert.rejects(stat(g.config.sides.v3.state.cacheDir), { code: 'ENOENT' });
});
