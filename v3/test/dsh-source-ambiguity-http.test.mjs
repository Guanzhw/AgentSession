import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const provider = 'deepseek-harness';
const mixedCode = 'dsh_mixed_source_encodings';
const duplicateCode = 'dsh_duplicate_source_generation';
const source = (id, text = `${id} searchable question`) => [
  { type: 'session', version: 3, id, createdAt: 1, isSeeded: false },
  { type: 'user/message', seq: 0, time: 2, surfaceOp: 'append',
    data: { id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text }] } },
].map(row => JSON.stringify(row)).join('\n') + '\n';

test('DSH ambiguity publishes unavailable rows, clears old FTS and restores only resolved sources',
  { timeout: 40_000 }, async t => {
    const tmp = path.join(repo, 'tmp');
    await mkdir(tmp, { recursive: true });
    const work = await mkdtemp(path.join(tmp, 'dsh-source-ambiguity-'));
    const dsh = path.join(work, 'dsh');
    const sessions = path.join(dsh, 'sessions');
    const index = path.join(work, 'index');
    for (const id of ['healthy', 'mixed', 'duplicate']) {
      await mkdir(path.join(sessions, id), { recursive: true });
      await writeFile(path.join(sessions, id, 'session.v3.jsonl'), source(id));
    }
    const port = await freeFetchSafePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(binary, ['serve', '--port', String(port), '--disable-terminal-launch',
      '--codex-dir', path.join(work, 'codex'), '--opencode-db', path.join(work, 'missing.db'),
      '--claude-dir', path.join(work, 'claude'), '--pi-dir', path.join(work, 'pi'),
      '--dsh-dir', dsh, '--meta-dir', path.join(work, 'meta'), '--index-dir', index,
      '--cache-dir', path.join(work, 'cache')],
    { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill();
        await closed;
      }
      await rm(work, { recursive: true, force: true });
    });
    const json = async route => {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
      return response.json();
    };
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) assert.fail(stderr);
      try { if ((await fetch(`${base}/api/providers`)).ok) { ready = true; break; } } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, stderr);
    const list = () => json(`/api/v3/sessions?provider=${provider}`);
    const search = () => json(`/api/v3/search?provider=${provider}&fields=user&q=searchable`);
    assert.equal((await list()).length, 3);
    assert.equal((await search()).matches.length, 3);
    const compressed = path.join(sessions, 'mixed', 'session.v4.jsonl.zstd');
    await writeFile(compressed, zstdCompressSync('unreadable newest generation\n'));
    const duplicateDir = path.join(sessions, 'copy', 'duplicate');
    await mkdir(duplicateDir, { recursive: true });
    const duplicate = path.join(duplicateDir, 'session.v3.jsonl');
    await writeFile(duplicate, source('duplicate', 'second copy'));
    const rows = await list();
    assert.equal(rows.length, 3);
    for (const [id, code] of [['mixed', mixedCode], ['duplicate', duplicateCode]]) {
      const row = rows.find(row => row.session.sessionId === id);
      assert.equal(row.diagnostic, code);
      for (const key of ['directory', 'createdAt', 'updatedAt', 'tokenCount']) assert.equal(row[key], null);
      assert.equal(row.messageCount, 0);
      const response = await fetch(`${base}/api/v3/reader/${provider}/${id}/bootstrap`);
      assert.equal(response.status, 500, await response.clone().text());
      assert.equal((await response.clone().json()).error.code, 'source_error');
      assert.match(await response.text(), /mixed raw\/Zstandard|duplicate DSH generation/);
    }
    assert.equal((await fetch(`${base}/api/v3/reader/${provider}/healthy/bootstrap`)).status, 200);
    const diagnostics = [
      { code: duplicateCode, affectedSessions: 1 }, { code: mixedCode, affectedSessions: 1 },
    ];
    const statuses = await json('/api/providers');
    assert.deepEqual(statuses.find(row => row.id === provider).storageDiagnostic.sourceDiagnostics, diagnostics);
    const library = await json(`/api/v3/library/sessions?provider=${provider}&limit=20`);
    assert.equal(library.families.length, 3);
    assert.match(library.sourceDiagnostics.find(row => row.provider === provider).message, /ambiguous source generations/);
    const found = await search();
    assert.deepEqual(found.matches.map(row => row.session.sessionId), ['healthy']);
    assert.equal(found.diagnostics.find(row => row.provider === provider).status, 'partial');
    assert.deepEqual(found.diagnostics.find(row => row.provider === provider).sourceDiagnostics, diagnostics);
    const stats = await json(`/api/v3/stats/${provider}`);
    assert.equal(stats.overview.excludedSourceSessionCount, 2);
    assert.equal(stats.usageCoverage, 'partial');
    assert.deepEqual(stats.sessions.map(row => row.session.sessionId), ['healthy']);
    assert.deepEqual(stats.sourceDiagnostics, diagnostics);
    const dbFile = path.join(index, (await readdir(index)).find(name => name.endsWith('.sqlite')));
    const catalog = () => {
      const db = new DatabaseSync(dbFile, { readOnly: true });
      try {
        return db.prepare('SELECT session_id, signature, summary_json FROM catalog_entry WHERE provider=? ORDER BY session_id')
          .all(provider).map(row => ({ ...row, summary: JSON.parse(row.summary_json) }));
      } finally { db.close(); }
    };
    const before = catalog();
    const older = path.join(sessions, 'mixed', 'session.jsonl');
    await writeFile(older, '{"type":"session","version":0,"id":"mixed","createdAt":1}\n');
    await list();
    const withOlder = catalog();
    assert.notEqual(withOlder.find(row => row.session_id === 'mixed').signature,
      before.find(row => row.session_id === 'mixed').signature, 'all ambiguity candidates bind the signature');
    const force = await fetch(`${base}/api/reindex`, { method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(force.status, 200, await force.clone().text());
    assert.equal((await force.json()).results.find(row => row.provider === provider).status, 'rebuilt');
    assert.deepEqual(catalog(), withOlder, 'forced capture preserves diagnostic signature and snapshot revision');
    assert.deepEqual(await list(), rows);
    assert.deepEqual((await search()).matches.map(row => row.session.sessionId), ['healthy']);
    await unlink(older);
    await unlink(compressed);
    await unlink(duplicate);
    assert.ok((await list()).every(row => row.diagnostic === undefined));
    assert.equal((await search()).matches.length, 3);
    assert.equal((await json(`/api/v3/stats/${provider}`)).overview.excludedSourceSessionCount, 0);
    for (const id of ['mixed', 'duplicate']) {
      assert.equal((await fetch(`${base}/api/v3/reader/${provider}/${id}/bootstrap`)).status, 200);
    }
    assert.equal((await json('/api/providers')).find(row => row.id === provider).storageDiagnostic, null);
  });
