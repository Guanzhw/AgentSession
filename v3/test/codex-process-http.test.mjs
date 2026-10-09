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
const id = '99999999-9999-4999-8999-999999999999';
const fixture = path.join(repo, 'v3', 'fixtures', 'codex-process', 'sessions', '2026', '09', '27',
  `rollout-2026-09-27T03-00-00-${id}.jsonl`);
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');

async function freePort() {
  return freeFetchSafePort();
}

test('Codex direct terminal calls preserve recorded process phases and Reader source anchors',
  { timeout: 45_000 }, async t => {
    const originalHash = await hash(fixture);
    const root = await mkdtemp(path.join(repo, 'tmp', 'v3-codex-process-'));
    const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']
      .map(name => [name, path.join(root, name)]));
    await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
    const sessionDir = path.join(dirs.codex, 'sessions', '2026', '09', '27');
    await mkdir(sessionDir, { recursive: true });
    const copied = path.join(sessionDir, path.basename(fixture));
    await copyFile(fixture, copied);
    t.after(async () => {
      assert.equal(await hash(copied), originalHash, 'provider-owned transcript remains read-only');
      assert.equal(await hash(fixture), originalHash, 'the public fixture remains unchanged');
      assert.equal(path.dirname(path.resolve(root)), path.resolve(repo, 'tmp'));
      assert.ok(path.basename(root).startsWith('v3-codex-process-'));
      await rm(root, { recursive: true, force: true });
    });

    const port = await freePort();
    const child = spawn(binary, ['serve', '--port', String(port), '--codex-dir', dirs.codex,
      '--opencode-db', path.join(root, 'missing-opencode.db'), '--claude-dir', dirs.claude,
      '--pi-dir', dirs.pi, '--dsh-dir', dirs.dsh, '--meta-dir', dirs.meta,
      '--index-dir', dirs.index, '--cache-dir', dirs.cache],
    { cwd: repo, windowsHide: true, stdio: 'ignore' });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill();
        await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]);
      }
    });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error('isolated Axum process exited before readiness');
      try { if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok) {
        ready = true; break;
      } } catch { /* source indexing is still starting */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'isolated Axum process became ready');

    const protocolResponse = await fetch(`${base}/api/v3/protocol/codex/${id}?version=3`);
    assert.equal(protocolResponse.status, 200);
    const protocol = await protocolResponse.json();
    const v2Response = await fetch(`${base}/api/v3/protocol/codex/${id}?version=2`);
    assert.equal(v2Response.status, 200);
    const v2 = await v2Response.json();
    const steps = protocol.events.filter(event => event.execution);
    assert.deepEqual(steps.map(event => [event.sourceOrder.record, event.execution.id,
      event.execution.kind, event.execution.phase, event.execution.handle]), [
      [1, 'command', 'process', 'started', '97155'],
      [2, 'command', 'process', 'yielded', '97155'],
      [3, 'command', 'process', 'polled', '97155'],
      [4, 'command', 'process', 'yielded', '97155'],
      [5, 'command', 'process', 'input', '97155'],
      [6, 'command', 'process', 'yielded', '97155'],
      [7, 'command', 'process', 'interruption-requested', '97155'],
      [8, 'command', 'process', 'completed', '97155'],
    ]);
    assert.equal(steps[0].execution.label, 'npm run build');
    assert.deepEqual(steps.map(event => event.readerEvent?.messageId),
      ['command', 'command', 'poll', 'poll', 'input', 'input', 'stop', 'stop']);
    assert.ok(steps.every(event => event.readerEvent?.segment === 'tool'));
    assert.equal(steps.some(event => event.execution.phase === 'cancelled'), false);
    assert.equal(protocol.coverage.execution.state, 'observed');
    assert.deepEqual(v2.events.filter(event => event.execution).map(event => event.execution),
      steps.map(event => event.execution));
    const runtime = await (await fetch(`${base}/api/v3/runtime/codex/${id}/events?category=tool&limit=50`)).json();
    assert.deepEqual(runtime.events.filter(event => event.execution).map(event => event.id),
      steps.map(event => event.id));
    assert.deepEqual(runtime.events.filter(event => event.execution).map(event => event.execution),
      steps.map(event => event.execution));
  });
