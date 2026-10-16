import { onCleanup, temporaryDirectory } from '../../test/helpers/fixture-cleanup.mjs';
import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '../..');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const sessionId = '11111111-1111-4111-8111-111111111111';

async function freePort() {
  return freeFetchSafePort();
}

function source(message, second) {
  return [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-09-25T00:00:00.000Z',
      payload: { id: sessionId, cwd: '/synthetic/codex' } }),
    JSON.stringify({ type: 'event_msg', timestamp: `2026-09-25T00:00:0${second}.000Z`,
      payload: { type: 'user_message', message } }),
  ].join('\n') + '\n';
}

async function hash(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

test('same-ID Codex sources stay browsable but cannot publish fragment history or usage',
  { timeout: 30_000 }, async t => {
    const dir = await temporaryDirectory(t, path.join(os.tmpdir(), 'v3-codex-collision-'));
    const codex = path.join(dir, 'codex');
    const sessions = path.join(codex, 'sessions', '2026', '09', '27');
    await mkdir(sessions, { recursive: true });
    const first = path.join(sessions, `rollout-2026-09-27T00-00-00-${sessionId}.jsonl`);
    const later = path.join(sessions, `rollout-2026-09-27T00-00-00-${sessionId}_window.jsonl`);
    await writeFile(first, source('First source question', 1));
    const healthyId = '22222222-2222-4222-8222-222222222222';
    const healthy = path.join(sessions, `rollout-2026-09-27T00-00-00-${healthyId}.jsonl`);
    await writeFile(healthy, source('Healthy source question', 3)
      .replaceAll(sessionId, healthyId).replace('/synthetic/codex', '/synthetic/healthy'));
    const firstHash = await hash(first);
    const healthyHash = await hash(healthy);
    const port = await freePort();
    const child = spawn(binary, ['serve', '--port', String(port), '--codex-dir', codex,
      '--opencode-db', path.join(dir, 'missing.db'), '--claude-dir', path.join(dir, 'claude'),
      '--pi-dir', path.join(dir, 'pi'), '--dsh-dir', path.join(dir, 'dsh'),
      '--meta-dir', path.join(dir, 'meta'), '--index-dir', path.join(dir, 'index'),
      '--cache-dir', path.join(dir, 'cache')],
    { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-5000); });
    onCleanup(t, async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close'); child.kill();
        await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]);
      }
    });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`v3 exited: ${stderr}`);
      try { if ((await fetch(`${base}/api/providers`)).ok) { ready = true; break; } }
      catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, stderr);
    assert.equal((await fetch(`${base}/api/v3/reader/codex/${sessionId}/bootstrap`)).status, 200);
    assert.equal((await fetch(`${base}/api/v3/stats/codex`)).status, 200);
    await writeFile(later, source('Later source question', 2));
    const laterHash = await hash(later);
    const list = await (await fetch(`${base}/api/v3/sessions?provider=codex`)).json();
    assert.equal(list.length, 2, JSON.stringify({ list, providers: await (await fetch(`${base}/api/providers`)).json(), stderr }));
    const collision = list.find(row => row.session.sessionId === sessionId);
    assert.equal(collision?.diagnostic, 'codex_multiple_source_files_unmerged');
    assert.equal(collision.directory, '/synthetic/codex');
    assert.equal(collision.tokenCount, null);
    assert.equal(list.find(row => row.session.sessionId === healthyId)?.title, 'Healthy source question');
    for (const route of [
      `/api/v3/reader/codex/${sessionId}/bootstrap`,
      `/api/v3/protocol/codex/${sessionId}?version=3`,
    ]) {
      const response = await fetch(`${base}${route}`);
      const body = await response.text();
      assert.equal(response.status, 503, `${route}: ${body}`);
      assert.match(body, /codex_multiple_source_files_unmerged/);
    }
    assert.equal((await fetch(`${base}/api/v3/reader/codex/${healthyId}/bootstrap`)).status, 200);
    const partial = await (await fetch(`${base}/api/v3/stats/codex`)).json();
    assert.deepEqual(partial.sessions.map(row => row.session.sessionId), [healthyId]);
    assert.equal(partial.overview.totalSessions, 1);
    assert.equal(partial.overview.excludedSourceSessionCount, 1);
    assert.equal(partial.usageCoverage, 'partial');
    assert.deepEqual(partial.sourceDiagnostics,
      [{ code: 'codex_multiple_source_files_unmerged', affectedSessions: 1 }]);
    const healthyStats = await (await fetch(`${base}/api/v3/stats/codex?directory=${encodeURIComponent('/synthetic/healthy')}`)).json();
    assert.equal(healthyStats.overview.excludedSourceSessionCount, 0);
    const collidedStats = await (await fetch(`${base}/api/v3/stats/codex?directory=${encodeURIComponent('/synthetic/codex')}`)).json();
    assert.equal(collidedStats.overview.totalSessions, 0);
    assert.equal(collidedStats.overview.excludedSourceSessionCount, 1);
    assert.deepEqual(await (await fetch(`${base}/api/v3/stats/codex/export.json`)).json(), partial);
    const partialCsv = await (await fetch(`${base}/api/v3/stats/codex/export.csv`)).text();
    assert.match(partialCsv, /Excluded Source Session Count,Source Diagnostic Codes/);
    assert.match(partialCsv, /codex_multiple_source_files_unmerged/);
    const filteredStatsQuery = new URLSearchParams({
      days: 'custom', from: '2026-09-01', to: '2026-09-01', model: 'model-absent',
    });
    const filteredStats = await (await fetch(`${base}/api/v3/stats/codex?${filteredStatsQuery}`)).json();
    assert.equal(filteredStats.overview.recordedRequestCount, 0);
    assert.equal(filteredStats.overview.excludedSourceSessionCount, 1);
    assert.equal(filteredStats.usageCoverage, 'partial');
    assert.deepEqual(await (await fetch(`${base}/api/v3/stats/codex/export.json?${filteredStatsQuery}`)).json(), filteredStats);
    const filteredCsv = await (await fetch(`${base}/api/v3/stats/codex/export.csv?${filteredStatsQuery}`)).text();
    assert.match(filteredCsv, /,1,"codex_multiple_source_files_unmerged: 1",false,/);
    const library = await (await fetch(`${base}/api/v3/library/sessions?provider=codex&limit=1`)).json();
    assert.equal(library.families.length, 1);
    assert.ok(library.total >= 2);
    assert.ok(library.nextCursor);
    const fullLibrary = await (await fetch(`${base}/api/v3/library/sessions?provider=codex&limit=20`)).json();
    assert.equal(fullLibrary.families.find(row => row.session.session.sessionId === sessionId)?.session.diagnostic,
      'codex_multiple_source_files_unmerged');
    const modified = await stat(later);
    const changed = source('Other source question', 2);
    assert.equal(Buffer.byteLength(changed), (await stat(later)).size);
    await writeFile(later, changed);
    await utimes(later, modified.atime, modified.mtime);
    assert.equal((await fetch(`${base}/api/v3/library/sessions?provider=codex&limit=1&cursor=${encodeURIComponent(library.nextCursor)}`)).status, 409);
    const search = async q => (await (await fetch(`${base}/api/v3/search?provider=codex&fields=user&q=${encodeURIComponent(q)}`)).json()).matches;
    assert.equal((await search('Later source question')).length, 0);
    assert.equal((await search('First source question')).length, 0);
    const collisionSearch = await (await fetch(`${base}/api/v3/search?provider=codex&fields=user&q=segment`)).json();
    assert.equal(collisionSearch.diagnostics.find(row => row.provider === 'codex')?.status, 'partial');
    assert.deepEqual(collisionSearch.diagnostics.find(row => row.provider === 'codex')?.sourceDiagnostics,
      [{ code: 'codex_multiple_source_files_unmerged', affectedSessions: 1 }]);
    assert.equal((await search('Healthy source question')).length, 1);
    await unlink(later);
    const restored = await (await fetch(`${base}/api/v3/sessions?provider=codex`)).json();
    assert.equal(restored.find(row => row.session.sessionId === sessionId)?.diagnostic, undefined);
    assert.equal((await fetch(`${base}/api/v3/reader/codex/${sessionId}/bootstrap`)).status, 200);
    assert.equal((await fetch(`${base}/api/v3/stats/codex`)).status, 200);
    assert.equal((await search('First source question')).length, 1);
    assert.deepEqual(await Promise.all([hash(first), hash(healthy)]), [firstHash, healthyHash]);
    assert.notEqual(laterHash, createHash('sha256').update(changed).digest('hex'));
    const firstStamp = await stat(first);
    const reassigned = source('First source question', 1).replaceAll(sessionId, healthyId);
    assert.equal(Buffer.byteLength(reassigned), firstStamp.size);
    await writeFile(first, reassigned);
    await utimes(first, firstStamp.atime, firstStamp.mtime);
    const reassignedList = await (await fetch(`${base}/api/v3/sessions?provider=codex`)).json();
    assert.equal(reassignedList.some(row => row.session.sessionId === sessionId), false);
    assert.equal(reassignedList.find(row => row.session.sessionId === healthyId)?.diagnostic,
      'codex_multiple_source_files_unmerged');
    const reassignedStats = await (await fetch(`${base}/api/v3/stats/codex`)).json();
    assert.equal(reassignedStats.overview.excludedSourceSessionCount, 1);
    await writeFile(first, '{invalid header}\n');
    const uncertain = await (await fetch(`${base}/api/v3/sessions?provider=codex`)).json();
    assert.equal(uncertain.length, 1);
    assert.equal(uncertain[0].session.sessionId, healthyId);
    assert.equal(uncertain[0].diagnostic, 'codex_source_inventory_incomplete');
    const uncertainSearch = await (await fetch(`${base}/api/v3/search?provider=codex&fields=user&q=Healthy`)).json();
    assert.deepEqual(uncertainSearch.diagnostics.find(row => row.provider === 'codex')?.sourceDiagnostics,
      [{ code: 'codex_source_inventory_incomplete', affectedSessions: 1 }]);
    assert.equal((await fetch(`${base}/api/v3/reader/codex/${healthyId}/bootstrap`)).status, 503);
    assert.equal((await fetch(`${base}/api/v3/stats/codex`)).status, 503);
    await unlink(healthy);
    assert.deepEqual(await (await fetch(`${base}/api/v3/sessions?provider=codex`)).json(), []);
    const providers = await (await fetch(`${base}/api/providers`)).json();
    assert.equal(providers.find(row => row.id === 'codex')?.storageDiagnostic?.code,
      'codex_source_inventory_incomplete');
    const noKnownSearch = await (await fetch(`${base}/api/v3/search?provider=codex&fields=user&q=Healthy`)).json();
    assert.deepEqual(noKnownSearch.diagnostics.find(row => row.provider === 'codex')?.sourceDiagnostics,
      [{ code: 'codex_source_inventory_incomplete', affectedSessions: 1 }]);
    assert.equal((await fetch(`${base}/api/v3/stats/codex`)).status, 503);
    for (const filter of ['?scope=root', `?directory=${encodeURIComponent('/synthetic/healthy')}`]) {
      const response = await fetch(`${base}/api/v3/stats/codex${filter}`);
      assert.equal(response.status, 503, `${filter}: ${await response.text()}`);
    }
  });
