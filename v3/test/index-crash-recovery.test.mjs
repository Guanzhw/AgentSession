import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const fixture = path.join(repo, 'v3', 'fixtures', 'codex');
const fixtureFile = path.join(fixture, 'sessions', '2026', '09', '26',
  'rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl');
const binary = process.env.AGENTSESSION_V3_CRASH_BIN || path.join(repo, 'v3', 'target-crash-test',
  'debug', process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const marker = 'AGENTSESSION_V3_TEST_BEFORE_CATALOG_COMMIT provider=codex';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function published(indexDir) {
  const dbFile = path.join(indexDir, (await readdir(indexDir)).find(name => name.endsWith('.sqlite')));
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const revision = db.prepare("SELECT revision FROM catalog_state WHERE provider='codex'").get().revision;
    const entries = db.prepare("SELECT session_id, signature, summary_json FROM catalog_entry WHERE provider='codex' ORDER BY session_id").all();
    const docs = db.prepare("SELECT session_id, field, position, text FROM search_doc WHERE provider='codex' ORDER BY session_id, field, position").all();
    const ftsCount = term => db.prepare(`SELECT count(*) AS n FROM search_doc_fts
      JOIN search_doc d ON d.rowid=search_doc_fts.rowid
      WHERE d.provider='codex' AND search_doc_fts MATCH ?`).get(term).n;
    return { revision, entries, docs, oldFts: ftsCount('hello'), newFts: ftsCount('howdy'),
      quickCheck: db.prepare('PRAGMA quick_check').get().quick_check };
  } finally {
    db.close();
  }
}

async function startWeb(args, env = {}) {
  const port = await freeFetchSafePort();
  const child = spawn(binary, ['serve', '--port', String(port), ...args], {
    cwd: repo, windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { output.stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { output.stderr += chunk.toString(); });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, `Web exited during startup: ${output.stderr}`);
    try {
      if ((await fetch(`${origin}/api/providers`, { signal: AbortSignal.timeout(1000) })).ok)
        return { child, origin, output };
    } catch { /* Startup can take several seconds. */ }
    await pause(100);
  }
  child.kill();
  throw new Error(`Web startup timed out: ${output.stderr}`);
}

async function connectMcp(args, name) {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: binary,
    args: ['mcp', ...args], cwd: repo, stderr: 'pipe' }));
  return client;
}

async function webSearch(origin, term) {
  const url = new URL('/api/v3/search', origin);
  url.search = new URLSearchParams({ q: term, provider: 'codex', fields: 'assistant' }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.matches;
}

async function mcpSearch(client, term) {
  const response = await client.callTool({ name: 'session_search', arguments: {
    query: term, providers: ['codex'], fields: ['assistant'],
  } });
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  return response.structuredContent.result.matches;
}

async function waitForMarker(process, pending) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process.output.stderr.includes(marker)) return;
    assert.equal(process.child.exitCode, null, `Crash child exited before marker: ${process.output.stderr}`);
    assert.equal(pending.done, false, 'Refresh finished before the crash-phase marker');
    await pause(25);
  }
  assert.fail(`Crash-phase marker not emitted: ${process.output.stderr}`);
}

test('abrupt exit before catalog commit preserves old revision and recovers across Web and two MCP processes',
  { timeout: 120_000, skip: !process.env.AGENTSESSION_V3_CRASH_BIN_SHA256 &&
    'Requires an isolated crash-test-hook binary and its SHA-256' }, async t => {
    const expectedBinaryHash = process.env.AGENTSESSION_V3_CRASH_BIN_SHA256;
    assert.ok(expectedBinaryHash, 'Set AGENTSESSION_V3_CRASH_BIN_SHA256 for the isolated instrumented build');
    assert.equal(hash(readFileSync(binary)), expectedBinaryHash.toLowerCase(),
      'The exercised binary must match the recorded instrumented build');
    const originalHash = hash(readFileSync(fixtureFile));
    const tmpRoot = path.join(repo, 'tmp');
    await mkdir(tmpRoot, { recursive: true });
    const scratch = await mkdtemp(path.join(tmpRoot, 'v3-index-crash-'));
    const processes = [];
    const clients = [];
    let crash;
    t.after(async () => {
      await Promise.all(clients.map(client => client.close()));
      for (const child of processes) {
        if (child.exitCode === null && child.signalCode === null) {
          const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
        }
      }
      if (crash) {
        await writeFile(path.join(scratch, 'crash.stderr.log'), crash.output.stderr);
        await writeFile(path.join(scratch, 'crash.stdout.log'), crash.output.stdout);
      }
      assert.equal(hash(readFileSync(fixtureFile)), originalHash, 'original provider fixture is unchanged');
      if (process.env.AGENTSESSION_V3_CRASH_KEEP_EVIDENCE !== '1') {
        assert.equal(path.dirname(await realpath(scratch)), await realpath(tmpRoot));
        assert.match(path.basename(scratch), /^v3-index-crash-/);
        await rm(scratch, { recursive: true, force: true });
      } else {
        process.stderr.write(`Crash test evidence: ${scratch}\n`);
      }
    });
    for (const name of ['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache'])
      await mkdir(path.join(scratch, name));
    await cp(fixture, path.join(scratch, 'codex'), { recursive: true });
    const copied = path.join(scratch, 'codex', 'sessions', '2026', '09', '26', path.basename(fixtureFile));
    const original = await readFile(copied, 'utf8');
    const secondId = '55555555-5555-4555-8555-555555555555';
    await writeFile(path.join(path.dirname(copied), path.basename(copied).replaceAll(
      '44444444-4444-4444-8444-444444444444', secondId)), original.replaceAll(
      '44444444-4444-4444-8444-444444444444', secondId));
    const args = ['--codex-dir', path.join(scratch, 'codex'),
      '--opencode-db', path.join(scratch, 'opencode.db'),
      '--claude-dir', path.join(scratch, 'claude'), '--pi-dir', path.join(scratch, 'pi'),
      '--dsh-dir', path.join(scratch, 'dsh'), '--meta-dir', path.join(scratch, 'meta'),
      '--index-dir', path.join(scratch, 'index'), '--cache-dir', path.join(scratch, 'cache')];
    const web = await startWeb(args); processes.push(web.child);
    const mcpA = await connectMcp(args, 'crash-recovery-a'); clients.push(mcpA);
    const mcpB = await connectMcp(args, 'crash-recovery-b'); clients.push(mcpB);
    const browse = { level: 'sessions', providers: ['codex'], limit: 1 };
    const first = await mcpA.callTool({ name: 'session_browse', arguments: browse });
    assert.notEqual(first.isError, true, first.content?.[0]?.text);
    const oldCursor = first.structuredContent.result.nextCursor;
    assert.ok(oldCursor, 'two copied sessions produce a browse cursor');
    assert.equal((await webSearch(web.origin, 'hello')).length, 2);
    assert.equal((await mcpSearch(mcpB, 'hello')).length, 2);
    const before = await published(path.join(scratch, 'index'));
    assert.equal(before.entries.length, 2);
    assert.equal(before.oldFts, 2);
    assert.equal(before.newFts, 0);
    assert.equal(before.quickCheck, 'ok');
    await writeFile(copied, original.replace('Hello 🙂 from the Rust slice.',
      'Howdy 🙂 from the Rust slice.'));
    const changedHash = hash(readFileSync(copied));
    crash = await startWeb(args, { AGENTSESSION_V3_TEST_PAUSE_BEFORE_CATALOG_COMMIT: 'codex' });
    processes.push(crash.child);
    const pending = { done: false };
    const refresh = webSearch(crash.origin, 'howdy').then(
      () => { pending.done = true; }, () => { pending.done = true; });
    await waitForMarker(crash, pending);
    const hot = await published(path.join(scratch, 'index'));
    assert.deepEqual(hot, before, 'readers see the old complete publication during the write transaction');
    const closed = once(crash.child, 'close');
    assert.equal(crash.child.kill('SIGKILL'), true);
    await closed;
    await refresh;
    const recovered = await published(path.join(scratch, 'index'));
    assert.deepEqual(recovered, before, 'crash rolls back catalog, search, FTS and revision together');
    assert.equal(recovered.quickCheck, 'ok');
    const results = await Promise.all([
      webSearch(web.origin, 'howdy'), mcpSearch(mcpA, 'howdy'), mcpSearch(mcpB, 'howdy'),
      mcpA.callTool({ name: 'session_browse', arguments: { ...browse, cursor: oldCursor } }),
    ]);
    for (const matches of results.slice(0, 3)) assert.equal(matches.length, 1);
    assert.equal(results[3].isError, true);
    assert.match(results[3].content[0].text, /^source_changed: /);
    assert.deepEqual((await webSearch(web.origin, 'hello')).map(row => row.session.sessionId),
      [secondId], 'only the unchanged session retains the old search term');
    const after = await published(path.join(scratch, 'index'));
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.oldFts, 1);
    assert.equal(after.newFts, 1);
    assert.equal(after.quickCheck, 'ok');
    assert.equal(hash(readFileSync(copied)), changedHash, 'refresh does not mutate copied provider source');
    await writeFile(path.join(scratch, 'evidence.json'), JSON.stringify({
      binary, binarySha256: expectedBinaryHash, originalFixtureSha256: originalHash,
      changedCopySha256: changedHash, beforeRevision: before.revision, afterRevision: after.revision,
      crashPhaseMarker: marker, hotQuickCheck: hot.quickCheck, recoveredQuickCheck: recovered.quickCheck,
    }, null, 2));
  });
