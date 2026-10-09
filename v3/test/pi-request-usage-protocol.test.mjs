import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const source = path.join(repo, 'test/fixtures/pi-v3-current.jsonl');
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');

async function start(t, transform = text => text) {
  const root = await mkdtemp(path.join(repo, 'tmp/v3-pi-usage-'));
  const sourceHash = sha(source);
  const dirs = Object.fromEntries(['pi', 'codex', 'claude', 'dsh', 'meta', 'index', 'cache']
    .map(name => [name, path.join(root, name)]));
  for (const dir of Object.values(dirs)) await mkdir(dir);
  const sessionDir = path.join(dirs.pi, 'sessions', 'fixture');
  await mkdir(sessionDir, { recursive: true });
  const copied = path.join(sessionDir, '019f8a00-0000-7000-8000-000000000001.jsonl');
  await writeFile(copied, transform(readFileSync(source, 'utf8')));
  const copyHash = sha(copied);
  const port = await freeFetchSafePort();
  const child = spawn(binary, ['serve', '--port', String(port), '--pi-dir', dirs.pi,
    '--codex-dir', dirs.codex, '--claude-dir', dirs.claude, '--dsh-dir', dirs.dsh,
    '--opencode-db', path.join(root, 'missing.db'), '--meta-dir', dirs.meta,
    '--index-dir', dirs.index, '--cache-dir', dirs.cache],
  { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    try {
      child.kill();
      if (child.exitCode === null && child.signalCode === null) await once(child, 'close');
      assert.equal(sha(source), sourceHash, 'Public source must remain read-only');
      assert.equal(sha(copied), copyHash, 'Provider copy must remain read-only');
    } finally {
      const resolved = path.resolve(root);
      assert.equal(path.dirname(resolved), path.resolve(repo, 'tmp'));
      assert.ok(path.basename(resolved).startsWith('v3-pi-usage-'));
      await rm(resolved, { recursive: true, force: true });
    }
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok)
        return base;
    } catch { /* Server startup. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Pi usage server did not start: ${stderr.slice(0, 500)}`);
}

test('Pi v3 records each owned assistant request once, excluding retained and summary usage',
  { timeout: 30_000 }, async t => {
    const base = await start(t);
    const id = '019f8a00-0000-7000-8000-000000000001';
    const response = await fetch(`${base}/api/v3/protocol/pi/${id}?version=3`);
    assert.equal(response.status, 200);
    const document = await response.json();
    assert.equal(document.validation.ok, true);
    const records = document.usageRecords;
    assert.deepEqual(records.map(record => record.provenance.sourceId),
      ['asst0001', 'asst0002', 'asst0003']);
    assert.deepEqual(records.map(record => record.tokens), [
      { input: 6, cacheRead: 3, cacheWrite: 2, output: 3, reasoning: 1, total: 15 },
      // asst0002/asst0003 omit reasoning; inclusive output cannot establish its exclusive part.
      { input: 5, cacheRead: 2, cacheWrite: 0, output: null, reasoning: null, total: 10 },
      { input: 2, cacheRead: 1, cacheWrite: 0, output: null, reasoning: null, total: 5 },
    ]);
    assert.deepEqual(records.map(record => record.id), [
      `usage:${id}:request:response:resp_1`,
      `usage:${id}:request:response:resp_2`,
      `usage:${id}:request:entry:asst0003`,
    ]);
    assert.equal(records[0].eventId, null, 'The abandoned request has no active Reader anchor');
    assert.equal(records[1].eventId, 'event:pi:11');
    for (const record of records) {
      assert.equal(record.scope, 'request');
      assert.deepEqual(record.sessionRef, { provider: 'pi', sessionId: id });
      assert.equal(record.model, 'deepseek-v4-pro');
      assert.equal(record.modelProvider, 'deepseek');
      assert.ok(Number.isInteger(record.timestamp));
      assert.equal(record.provenance.fidelity, 'recorded');
      assert.equal(record.provenance.sourceType, 'pi.entry:message.assistant.usage');
      if (record.eventId !== null)
        assert.ok(document.events.some(event => event.id === record.eventId));
    }
    assert.equal(document.coverage.usage.state, 'observed');
  });

test('Pi request usage prefers the active occurrence of a repeated response and skips pending zero usage',
  { timeout: 30_000 }, async t => {
    const base = await start(t, text => {
      const rows = text.trim().split('\n').map(line => JSON.parse(line));
      const active = rows.find(row => row.id === 'asst0002');
      const repeated = structuredClone(active);
      repeated.message.provider = 'inactive-recorded-provider';
      repeated.id = 'asst0002-inactive-copy';
      repeated.parentId = 'user0001';
      const pending = structuredClone(active);
      pending.id = 'asst-pending-zero';
      pending.parentId = 'user0001';
      delete pending.message.responseId;
      pending.message.stopReason = 'pending';
      pending.message.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        reasoning: 0, totalTokens: 0 };
      rows.splice(rows.indexOf(active), 0, repeated, pending);
      return rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    });
    const id = '019f8a00-0000-7000-8000-000000000001';
    const response = await fetch(`${base}/api/v3/protocol/pi/${id}?version=3`);
    assert.equal(response.status, 200);
    const document = await response.json();
    assert.deepEqual(document.usageRecords.map(record => record.provenance.sourceId),
      ['asst0001', 'asst0002', 'asst0003']);
    assert.equal(document.usageRecords[1].id, `usage:${id}:request:response:resp_2`);
    assert.equal(document.usageRecords[1].modelProvider, 'deepseek');
    assert.equal(document.coverage.usage.state, 'observed');
  });

test('Pi request usage keeps an inconsistent recorded total unknown',
  { timeout: 30_000 }, async t => {
    const base = await start(t, text => {
      const rows = text.trim().split('\n').map(line => JSON.parse(line));
      rows.find(row => row.id === 'asst0003').message.usage.totalTokens = 999;
      return rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    });
    const id = '019f8a00-0000-7000-8000-000000000001';
    const response = await fetch(`${base}/api/v3/protocol/pi/${id}?version=3`);
    assert.equal(response.status, 200);
    const document = await response.json();
    assert.equal(document.usageRecords.length, 3);
    assert.deepEqual(document.usageRecords[2].tokens,
      { input: 2, cacheRead: 1, cacheWrite: 0, output: null, reasoning: null, total: null });
  });

test('Pi usage keeps an absent recorded provider unknown even with a named model',
  { timeout: 30_000 }, async t => {
    const base = await start(t, text => {
      const rows = text.trim().split('\n').map(JSON.parse);
      delete rows.find(row => row.id === 'asst0003').message.provider;
      return rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    });
    const id = '019f8a00-0000-7000-8000-000000000001';
    const document = await (await fetch(`${base}/api/v3/protocol/pi/${id}?version=3`)).json();
    assert.equal(document.usageRecords[2].model, 'deepseek-v4-pro');
    assert.equal(document.usageRecords[2].modelProvider, undefined);
    assert.deepEqual(document.usageRecords.slice(0, 2).map(row => row.modelProvider),
      ['deepseek', 'deepseek']);
  });
