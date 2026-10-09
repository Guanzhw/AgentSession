import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const codexId = '44444444-4444-4444-8444-444444444444';
const codexSource = path.join(repo, 'v3', 'fixtures', 'codex', 'sessions', '2026', '09', '26',
  `rollout-2026-09-26T00-00-00-${codexId}.jsonl`);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function serve(t) {
  const state = await mkdtemp(path.join(repo, 'tmp', 'v3-export-removed-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    await rm(state, { recursive: true, force: true });
  });
  for (const name of ['codex/sessions/2026/09/26', 'dsh', 'pi', 'claude', 'meta', 'index', 'cache'])
    await mkdir(path.join(state, name), { recursive: true });
  const sourceCopy = path.join(state, 'codex', 'sessions', '2026', '09', '26', `rollout-${codexId}.jsonl`);
  await copyFile(codexSource, sourceCopy);
  const sourceHash = sha256(await readFile(sourceCopy));
  const port = await freeFetchSafePort();
  child = spawn(binary, ['serve', '--port', String(port),
    '--codex-dir', path.join(state, 'codex'), '--dsh-dir', path.join(state, 'dsh'),
    '--pi-dir', path.join(state, 'pi'), '--claude-dir', path.join(state, 'claude'),
    '--opencode-db', path.join(state, 'missing-opencode.db'),
    '--meta-dir', path.join(state, 'meta'), '--index-dir', path.join(state, 'index'),
    '--cache-dir', path.join(state, 'cache')], { cwd: repo, windowsHide: true, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Web process exited before startup');
    try { if ((await fetch(`${base}/api/providers`)).ok) return { base, sourceCopy, sourceHash }; }
    catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Web process did not become ready');
}

test('3.0 removes session download routes while Reader and statistics exports remain usable',
  { timeout: 45_000 }, async t => {
    const { base, sourceCopy, sourceHash } = await serve(t);
    const oldUrl = `${base}/api/codex/session/${codexId}/export`;
    for (const suffix of ['', '?format=json', '?format=md', '?format=csv']) {
      const response = await fetch(`${oldUrl}${suffix}`);
      assert.equal(response.status, 410, suffix || 'default format');
      const body = await response.json();
      assert.equal(body.error.code, 'session_export_removed');
      assert.ok(!Object.hasOwn(body.error, 'replacement'));
      assert.ok(!Object.hasOwn(body.error, 'formats'));
    }
    const encodedId = 'session with + and 中文';
    const encoded = await fetch(`${base}/api/pi/session/${encodeURIComponent(encodedId)}/export`);
    assert.equal(encoded.status, 410);
    assert.equal((await encoded.json()).error.code, 'session_export_removed');

    for (const suffix of ['', '?format=json', '?format=md']) {
      const removed = await fetch(`${base}/api/v3/export/codex/${codexId}${suffix}`);
      assert.equal(removed.status, 404, `versioned export ${suffix}`);
    }
    const reader = await fetch(`${base}/api/v3/reader/codex/${codexId}/bootstrap`);
    assert.equal(reader.status, 200);
    assert.ok((await reader.json()).totalItems > 0);
    for (const format of ['json', 'csv']) {
      const stats = await fetch(`${base}/api/v3/stats/codex/export.${format}?days=30`);
      assert.equal(stats.status, 200, `statistics ${format} export`);
    }
    const unknownAction = await fetch(`${base}/api/codex/session/${codexId}/unknown`);
    assert.equal(unknownAction.status, 404);
    assert.equal(sha256(await readFile(sourceCopy)), sourceHash);
    assert.equal(sha256(await readFile(codexSource)), sourceHash);
  });
