import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repoRoot, 'scripts', 'v3-capture-contract.mjs');
const tmpRoot = path.join(repoRoot, 'tmp');

const mockMcpServer = `
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const scenario = process.argv[2];
const server = new McpServer({ name: 'synthetic-pagination-test', version: '1.0.0' });
server.registerTool('session_timeline', {
  inputSchema: z.object({
    session: z.object({ provider: z.string(), sessionId: z.string() }),
    cursor: z.string().optional(),
  }),
}, async ({ cursor }) => {
  const pageIndex = cursor === undefined ? 0 : Number(cursor.slice('SYNTHETIC_CURSOR_'.length));
  const nextCursor = scenario === 'complete'
    ? pageIndex < 2 ? 'SYNTHETIC_CURSOR_' + (pageIndex + 1) : null
    : scenario === 'repeat'
      ? 'PRIVATE_SYNTHETIC_CURSOR'
      : scenario === 'invalid'
        ? 'PRIVATE_SYNTHETIC_CURSOR'
        : 'SYNTHETIC_CURSOR_' + (pageIndex + 1);
  const result = {
    pageIndex,
    observedCursor: cursor ?? null,
    nextCursor,
    truncated: nextCursor !== null && scenario !== 'invalid',
  };
  return {
    content: [{ type: 'text', text: 'PRIVATE_SYNTHETIC_PAGE_CONTENT' }],
    structuredContent: { result },
  };
});
serveStdio(() => server);
`;

async function runMcpCapture({ scenario, maxPages = 10 }) {
  const directory = await mkdtemp(path.join(tmpRoot, 'v3-mcp-capture-test-'));
  try {
    const serverPath = path.join(directory, 'mock-mcp-server.mjs');
    const planPath = path.join(directory, 'plan.json');
    const outputPath = path.join(directory, 'snapshot.json');
    await writeFile(serverPath, mockMcpServer);
    await writeFile(planPath, JSON.stringify({
      format: 'agentsession-v3-capture-plan/v1',
      cases: [{
        id: 'synthetic-timeline',
        kind: 'mcp-paginate',
        name: 'session_timeline',
        arguments: { session: { provider: 'codex', sessionId: 'synthetic-session' } },
        maxPages,
      }],
    }));
    const child = spawn(process.execPath, [script,
      '--plan', planPath,
      '--output', outputPath,
      '--mcp-command', process.execPath,
      '--mcp-arg', serverPath,
      '--mcp-arg', scenario,
    ], { cwd: repoRoot, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const [exitCode] = await once(child, 'close');
    const snapshot = exitCode === 0 ? JSON.parse(await readFile(outputPath, 'utf8')) : null;
    if (exitCode !== 0) await assert.rejects(readFile(outputPath), { code: 'ENOENT' });
    return { exitCode, stdout, stderr, snapshot };
  } finally {
    const physicalTmp = await realpath(tmpRoot);
    const physicalDirectory = await realpath(directory);
    assert.equal(path.dirname(physicalDirectory), physicalTmp);
    await rm(physicalDirectory, { recursive: true, force: true });
  }
}

test('invalid private JSON response reports a digest without printing its body', async () => {
  const privateBody = 'PRIVATE_SYNTHETIC_BODY secret=example';
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(privateBody);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const directory = await mkdtemp(path.join(tmpRoot, 'v3-capture-test-'));
  try {
    const planPath = path.join(directory, 'plan.json');
    const outputPath = path.join(directory, 'snapshot.json');
    await writeFile(planPath, JSON.stringify({
      format: 'agentsession-v3-capture-plan/v1',
      cases: [{ id: 'invalid-response', kind: 'http', path: '/private', body: 'json' }],
    }));
    const child = spawn(process.execPath, [script,
      '--plan', planPath,
      '--output', outputPath,
      '--base-url', `http://127.0.0.1:${server.address().port}`,
    ], { cwd: repoRoot, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const [exitCode] = await once(child, 'close');

    assert.equal(exitCode, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /returned invalid JSON \(status 200, \d+ bytes, body sha256:[0-9a-f]{12}\)/);
    assert.doesNotMatch(stderr, /PRIVATE_SYNTHETIC_BODY|secret=example/);
    await assert.rejects(readFile(outputPath), { code: 'ENOENT' });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const physicalTmp = await realpath(tmpRoot);
    const physicalDirectory = await realpath(directory);
    assert.equal(path.dirname(physicalDirectory), physicalTmp);
    await rm(physicalDirectory, { recursive: true, force: true });
  }
});

test('MCP pagination captures pages through the final cursor', async () => {
  const result = await runMcpCapture({ scenario: 'complete' });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^Captured 1 cases to /);
  assert.equal(result.stderr, '');
  const pages = result.snapshot.cases[0].result.pages.map((page) => page.structuredContent.result);
  assert.deepEqual(pages.map((page) => page.pageIndex), [0, 1, 2]);
  assert.deepEqual(pages.map((page) => page.observedCursor), [null, 'SYNTHETIC_CURSOR_1', 'SYNTHETIC_CURSOR_2']);
  assert.deepEqual(pages.map((page) => page.truncated), [true, true, false]);
});

test('MCP pagination fails safely when a server repeats its cursor', async () => {
  const result = await runMcpCapture({ scenario: 'repeat' });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /repeated a cursor at index 1/);
  assert.doesNotMatch(result.stderr, /PRIVATE_SYNTHETIC_CURSOR|PRIVATE_SYNTHETIC_PAGE_CONTENT/);
});

test('MCP pagination fails safely after maxPages without exposing page data or cursor', async () => {
  const result = await runMcpCapture({ scenario: 'limit', maxPages: 2 });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /exceeded maxPages 2/);
  assert.doesNotMatch(result.stderr, /SYNTHETIC_CURSOR|PRIVATE_SYNTHETIC_PAGE_CONTENT/);
});

test('MCP pagination reports malformed pages without printing private response content', async () => {
  const result = await runMcpCapture({ scenario: 'invalid' });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /returned an invalid page at index 0/);
  assert.doesNotMatch(result.stderr, /PRIVATE_SYNTHETIC_CURSOR|PRIVATE_SYNTHETIC_PAGE_CONTENT/);
});
