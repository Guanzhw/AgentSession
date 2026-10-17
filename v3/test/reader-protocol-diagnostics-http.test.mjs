import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');

async function setup(t, invalidRecord, repetitions = 1) {
  const directory = await mkdtemp(path.join(repo, 'tmp/v3-reader-protocol-diagnostic-'));
  const id = '44444444-4444-4444-8444-444444444444';
  const sourceDirectory = path.join(directory, 'codex/sessions');
  await mkdir(sourceDirectory, { recursive: true });
  const file = path.join(sourceDirectory, `rollout-${id}.jsonl`);
  const original = [
    JSON.stringify({ type: 'session_meta', payload: { id } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Readable public fixture.' } }),
    ...Array(repetitions).fill(invalidRecord),
  ].join('\n') + '\n';
  await writeFile(file, original);
  const config = path.join(directory, 'config.json');
  await writeFile(config, '{}');
  let child;
  let base;
  let stderr = '';
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'close');
    }
  }
  t.after(async () => {
    await stop();
    assert.equal(await readFile(file, 'utf8'), original);
    await rm(directory, { recursive: true, force: true });
  });
  async function start() {
    const port = await freeFetchSafePort();
    const args = ['serve', '--port', String(port), '--config', config, '--disable-terminal-launch',
      '--codex-dir', path.join(directory, 'codex'), '--opencode-db', path.join(directory, 'missing.db'),
      ...['claude', 'pi', 'dsh', 'meta', 'index', 'cache'].flatMap(name => [`--${name}-dir`, path.join(directory, name)])];
    stderr = '';
    child = spawn(binary, args, { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', chunk => { stderr += chunk; });
    base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error(`Native server exited: ${stderr}`);
      try { if ((await fetch(`${base}/api/providers`)).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Native server did not start: ${stderr}`);
  }
  const json = async suffix => {
    const response = await fetch(`${base}${suffix}`);
    return { status: response.status, body: await response.json() };
  };
  await start();
  return { id, json, restart: async () => { await stop(); await start(); } };
}

for (const [label, record, expectedCode] of [
  ['validation', '{"payload":{"type":"message"}}', 'missing_provenance_source'],
  ['parse', '{not-json}', 'malformed_source_record'],
]) {
  test(`Reader preserves native ${label} diagnostics across warm reads and restart`, { timeout: 30_000 }, async t => {
    const f = await setup(t, record);
    const reader = `/api/v3/reader/codex/${f.id}`;
    const opened = await f.json(`${reader}/bootstrap`);
    assert.equal(opened.status, 200);
    assert.ok(opened.body.totalItems > 0);
    const executions = `${reader}/executions?revision=${encodeURIComponent(opened.body.revision)}&limit=20`;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 2) await f.restart();
      const result = await f.json(executions);
      assert.equal(result.status, 422);
      assert.equal(result.body.error.code, 'protocol_invalid');
      assert.ok(result.body.error.diagnostics.some(diagnostic => diagnostic.code === expectedCode));
      assert.equal(result.body.error.diagnosticsTruncated, false);
    }
    const runtime = await f.json(`/api/v3/runtime/codex/${f.id}/events?limit=20`);
    assert.equal(runtime.status, 422);
    assert.ok(runtime.body.error.diagnostics.some(diagnostic => diagnostic.code === expectedCode));
  });
}

test('Reader native invalid response bounds recorded diagnostics', { timeout: 30_000 }, async t => {
  const f = await setup(t, '{not-json}', 25);
  const reader = `/api/v3/reader/codex/${f.id}`;
  const opened = await f.json(`${reader}/bootstrap`);
  assert.equal(opened.status, 200);
  const result = await f.json(`${reader}/executions?revision=${encodeURIComponent(opened.body.revision)}`);
  assert.equal(result.status, 422);
  assert.equal(result.body.error.diagnostics.length, 20);
  assert.equal(result.body.error.diagnosticsTruncated, true);
  assert.ok(result.body.error.diagnostics.every(diagnostic => diagnostic.code === 'malformed_source_record'));
});
