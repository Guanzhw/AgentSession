import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoot = path.join(repo, 'v3', 'fixtures', 'codex-three-level');
const sourceDir = path.join(sourceRoot, 'sessions', '2026', '09', '27');
const sourceFiles = [
  'rollout-2026-09-27T00-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl',
  'rollout-2026-09-27T00-01-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl',
  'rollout-2026-09-27T00-02-00-cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl',
].map(name => path.join(sourceDir, name));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const rootId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const childId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ref = sessionId => ({ provider: 'codex', sessionId });
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');

async function freePort() {
  return freeFetchSafePort();
}

async function startWeb(args, port) {
  const child = spawn(binary, ['serve', '--port', String(port), ...args],
    { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { output += chunk.toString(); });
  }
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(`${origin}/api/providers`, { signal: AbortSignal.timeout(1000) })).ok) {
        return { child, origin };
      }
    } catch { /* Startup can take several seconds. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`Web process did not start: ${output.slice(0, 1000)}`);
}

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const body = await response.json();
  assert.equal(response.status, 200, `${url}: ${JSON.stringify(body)}`);
  return body;
}

test('two Web readers and two stdio MCP processes share a source scope during cold publication',
  { timeout: 120_000 }, async t => {
    assert.ok(existsSync(binary), `Build the AgentSession 3.0 binary at ${binary}`);
    const hashes = sourceFiles.map(sha);
    const tmpRoot = path.join(repo, 'tmp');
    await mkdir(tmpRoot, { recursive: true });
    const scratch = await mkdtemp(path.join(tmpRoot, 'v3-reader-multiprocess-'));
    const processes = [];
    const clients = [];
    t.after(async () => {
      for (const client of clients) await client.close();
      for (const process of processes) {
        if (process.exitCode === null && process.signalCode === null) {
          const closed = once(process, 'close');
          process.kill();
          await closed;
        }
      }
      try {
        assert.deepEqual(sourceFiles.map(sha), hashes, 'provider source bytes must remain unchanged');
      } finally {
        assert.equal(path.dirname(await realpath(scratch)), await realpath(tmpRoot));
        assert.match(path.basename(scratch), /^v3-reader-multiprocess-/);
        await rm(scratch, { recursive: true, force: true });
      }
    });
    for (const name of ['meta', 'index', 'cache', 'claude', 'pi', 'dsh']) {
      await mkdir(path.join(scratch, name));
    }
    const args = [
      '--codex-dir', sourceRoot,
      '--opencode-db', path.join(scratch, 'absent.db'),
      '--claude-dir', path.join(scratch, 'claude'),
      '--pi-dir', path.join(scratch, 'pi'),
      '--dsh-dir', path.join(scratch, 'dsh'),
      '--meta-dir', path.join(scratch, 'meta'),
      '--index-dir', path.join(scratch, 'index'),
      '--cache-dir', path.join(scratch, 'cache'),
    ];
    const firstPort = await freePort();
    let secondPort = await freePort();
    while (secondPort === firstPort) secondPort = await freePort();
    const web = await Promise.all([firstPort, secondPort].map(async port => {
      const server = await startWeb(args, port);
      processes.push(server.child);
      return server.origin;
    }));
    await Promise.all(['legacy', 'modern'].map(async era => {
      const client = new Client({ name: `agentsession-v3-multiprocess-${era}`, version: '1.0.0' },
        era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
      const transport = new StdioClientTransport({ command: binary, args: ['mcp', ...args],
        cwd: repo, stderr: 'pipe' });
      await client.connect(transport);
      clients.push(client);
    }));

    const bases = web.map(origin => `${origin}/api/v3/reader/codex/${rootId}`);
    const [left, right, legacyGet, modernGet] = await Promise.all([
      json(`${bases[0]}/bootstrap`),
      json(`${bases[1]}/bootstrap`),
      clients[0].callTool({ name: 'session_get', arguments: { session: ref(rootId) } }),
      clients[1].callTool({ name: 'session_get', arguments: { session: ref(rootId) } }),
    ]);
    assert.equal(left.revision, right.revision);
    assert.deepEqual(left.session.session, ref(rootId));
    assert.deepEqual(right.session.session, ref(rootId));
    for (const result of [legacyGet, modernGet]) {
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.structuredContent.result.session, ref(rootId));
      assert.deepEqual(result.structuredContent.result.children.map(row => row.session), [ref(childId)]);
    }
    const relations = await Promise.all(bases.map(async (base, index) => {
      const cursor = [left, right][index].relations.firstCursor;
      return json(`${base}/relations?cursor=${encodeURIComponent(cursor)}`);
    }));
    for (const page of relations) {
      assert.deepEqual(page.childPlacements.map(row => row.child), [ref(childId)]);
      assert.equal(page.childPlacements[0].sourceEventId, 'event:codex:5');
    }
    assert.deepEqual(relations[0].childPlacements, relations[1].childPlacements);

    const cacheDir = path.join(scratch, 'cache');
    const dbPath = path.join(cacheDir, (await readdir(cacheDir)).find(name => name.endsWith('.sqlite')));
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
      assert.equal(db.prepare('SELECT count(*) AS n FROM reader_session WHERE provider=? AND session_id=?')
        .get('codex', rootId).n, 1);
    } finally {
      db.close();
    }
  });
