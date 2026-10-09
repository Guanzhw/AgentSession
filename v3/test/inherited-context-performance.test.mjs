import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '../..');
const fixture = path.join(repo, 'v3/fixtures/codex-inherited/sessions/2026/09/27/rollout-public-child.jsonl');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const childId = 'codex-inherited-public-child';
const parentId = 'codex-inherited-absent-parent';
const inheritedCounts = [51, 1001, 10001];
const pageSize = 40;
const contentPageSize = 2048;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function sourceRows(bytes) {
  return bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
}

function inheritedBody(row) {
  return row.payload.content.map(part => part.text ?? '').join('');
}

function generatedSource(original, targetCount) {
  const rows = sourceRows(original);
  const boundary = rows.findIndex(row => row.payload?.id === 'task-boundary');
  assert.ok(boundary > 0, 'the public child has an explicit owned task boundary');
  assert.equal(rows.filter(row => row.type === 'response_item' && row.payload?.type === 'agent_message').length,
    1, 'the fixture has one recorded task boundary');
  const added = targetCount - 51;
  assert.ok(added >= 0);
  const inserts = Array.from({ length: added }, (_, index) => ({
    timestamp: '2026-09-27T00:00:05.450Z',
    type: 'response_item',
    payload: {
      id: `perf-dev-${index}`,
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: `Inherited performance context ${index}: ${'p'.repeat(72)}` }],
    },
  }));
  const generated = [...rows.slice(0, boundary), ...inserts, ...rows.slice(boundary)];
  return { bytes: Buffer.from(generated.map(row => JSON.stringify(row)).join('\n') + '\n'), inserts };
}

async function freePort() {
  return freeFetchSafePort();
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify({ url, body }));
  return body;
}

async function startServer(stops, pinnedBinary, scratch, label, sourceBytes) {
  const root = path.join(scratch, label);
  const codex = path.join(root, 'codex');
  const sourcePath = path.join(codex, 'sessions', '2026', '09', '27', 'rollout-public-child.jsonl');
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, sourceBytes);
  const sourceHash = sha256(sourceBytes);
  const port = await freePort();
  const child = spawn(pinnedBinary, ['serve', '--port', String(port), '--codex-dir', codex,
    '--opencode-db', path.join(root, 'missing.db'), '--claude-dir', path.join(root, 'claude'),
    '--pi-dir', path.join(root, 'pi'), '--dsh-dir', path.join(root, 'dsh'),
    '--meta-dir', path.join(root, 'meta'), '--index-dir', path.join(root, 'index'),
    '--cache-dir', path.join(root, 'cache')],
  { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      let timer;
      try {
        await Promise.race([closed, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Axum did not stop: ${child.pid}`)), 3000);
        })]);
      } finally {
        clearTimeout(timer);
      }
    }
  };
  stops.push(stop);
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) assert.fail(`Axum exited before readiness: ${stderr}`);
    try {
      if ((await fetch(base + '/api/providers', { signal: AbortSignal.timeout(500) })).ok) {
        return { base, child, sourcePath, sourceHash, stop };
      }
    } catch { /* The isolated server is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`Axum did not become ready: ${stderr}`);
}

function peakRssBytes(pid) {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
        `(Get-Process -Id ${pid}).PeakWorkingSet64`], { encoding: 'utf8', timeout: 10_000 });
      const value = Number(result.stdout.trim());
      return result.status === 0 && Number.isFinite(value) ? value : null;
    }
    if (process.platform === 'linux') {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const value = Number(/^VmHWM:\s+(\d+)\s+kB/m.exec(status)?.[1]);
      return Number.isFinite(value) ? value * 1024 : null;
    }
    return null;
  } catch {
    return null;
  }
}

test('public inherited-prefix paging preserves exact output and records scaling evidence',
  { timeout: 600_000 }, async t => {
    const original = await readFile(fixture);
    const fixtureHash = sha256(original);
    const scratch = await mkdtemp(path.join(repo, 'tmp', 'v3-inherited-perf-'));
    const resolvedTmp = path.resolve(repo, 'tmp');
    assert.equal(path.dirname(path.resolve(scratch)), resolvedTmp,
      'scratch cleanup stays directly within repository tmp');
    assert.ok(path.basename(scratch).startsWith('v3-inherited-perf-'));
    const stops = [];
    t.after(async () => {
      for (const stop of stops) await stop();
      await rm(scratch, { recursive: true, force: true });
      assert.equal(sha256(await readFile(fixture)), fixtureHash, 'public fixture remains unchanged');
    });
    const pinnedBinary = path.join(scratch, path.basename(binary));
    await copyFile(binary, pinnedBinary);
    const pinnedBinaryHash = sha256(await readFile(pinnedBinary));
    const baselineIds = [];
    for (const targetCount of inheritedCounts) {
      const { bytes, inserts } = generatedSource(original, targetCount);
      const server = await startServer(stops, pinnedBinary, scratch, `rows-${targetCount}`, bytes);
      const bootstrap = await getJson(`${server.base}/api/v3/reader/codex/${childId}/bootstrap`);
      assert.equal(bootstrap.totalItems, 2, 'inserted context stays outside the child Reader');
      assert.equal(bootstrap.toc.entries.length, 2);

      const all = [];
      const listLatencies = [];
      let cursor = null;
      const traversalStarted = performance.now();
      do {
        const query = new URLSearchParams({ limit: String(pageSize) });
        if (cursor) query.set('cursor', cursor);
        const started = performance.now();
        const page = await getJson(`${server.base}/api/v3/reader/codex/${childId}/inherited-context?${query}`);
        listLatencies.push(performance.now() - started);
        assert.equal(page.scope, 'inherited-context');
        assert.deepEqual(page.session, { provider: 'codex', sessionId: childId });
        assert.deepEqual(page.sourceSession, { provider: 'codex', sessionId: parentId });
        assert.equal(page.revision, bootstrap.revision);
        assert.equal(page.totalItems, targetCount);
        assert.ok(page.items.length > 0 && page.items.length <= pageSize);
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      const listTraversalMs = performance.now() - traversalStarted;
      assert.equal(all.length, targetCount);
      assert.deepEqual(all.map(item => item.ordinal), Array.from({ length: targetCount }, (_, index) => index));
      if (targetCount === 51) baselineIds.push(...all.map(item => [item.messageId, item.segment]));
      else assert.deepEqual(all.slice(0, 51).map(item => [item.messageId, item.segment]), baselineIds);
      for (let index = 0; index < inserts.length; index++) {
        const item = all[51 + index];
        assert.equal(item.messageId, `perf-dev-${index}`);
        assert.equal(item.segment, 'message');
        assert.equal(item.totalChars, inheritedBody(inserts[index]).length);
        assert.equal(item.preview, inheritedBody(inserts[index]));
      }

      const longItem = all.find(item => item.messageId === 'dev-44');
      const expectedLongBody = inheritedBody(sourceRows(original).find(row => row.payload?.id === 'dev-44'));
      assert.ok(longItem);
      assert.equal(longItem.totalChars, expectedLongBody.length);
      let offset = 0;
      let actualLongBody = '';
      const contentLatencies = [];
      const contentStarted = performance.now();
      for (;;) {
        const query = new URLSearchParams({ revision: bootstrap.revision,
          ordinal: String(longItem.ordinal), messageId: longItem.messageId,
          segment: longItem.segment, field: 'body', offset: String(offset),
          maxChars: String(contentPageSize) });
        const started = performance.now();
        const page = await getJson(`${server.base}/api/v3/reader/codex/${childId}/inherited-context/content?${query}`);
        contentLatencies.push(performance.now() - started);
        assert.equal(page.revision, bootstrap.revision);
        assert.equal(page.offset, offset);
        assert.equal(page.totalChars, expectedLongBody.length);
        actualLongBody += page.text;
        if (page.nextOffset === null) break;
        assert.ok(page.nextOffset > offset);
        offset = page.nextOffset;
      }
      assert.equal(actualLongBody, expectedLongBody);
      const contentTraversalMs = performance.now() - contentStarted;
      assert.equal(sha256(await readFile(server.sourcePath)), server.sourceHash,
        'the isolated provider source remains byte-identical');
      t.diagnostic(JSON.stringify({ targetCount, pages: listLatencies.length,
        sourceBytes: bytes.length, sourceSha256: server.sourceHash,
        list: { medianMs: percentile(listLatencies, 0.5), p95Ms: percentile(listLatencies, 0.95),
          traversalMs: listTraversalMs },
        content: { pages: contentLatencies.length, medianMs: percentile(contentLatencies, 0.5),
          p95Ms: percentile(contentLatencies, 0.95), traversalMs: contentTraversalMs },
        fullTraversalMs: listTraversalMs + contentTraversalMs,
        peakRssBytes: peakRssBytes(server.child.pid), pinnedBinarySha256: pinnedBinaryHash }));
      await server.stop();
    }
  });
