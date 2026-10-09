import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const id = '88888888-8888-4888-8888-888888888888';
const fixture = path.join(repo, 'v3', 'fixtures', 'codex-execution', 'sessions', '2026', '09', '27',
  `rollout-2026-09-27T01-00-00-${id}.jsonl`);
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function freePort() {
  return freeFetchSafePort();
}

async function serve(t, expectedHash, sourceSpec = null) {
  const temporary = await mkdtemp(path.join(repo, 'tmp', 'v3-codex-execution-'));
  const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']
    .map(name => [name, path.join(temporary, name)]));
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
  const sessionDir = path.join(dirs.codex, 'sessions', '2026', '09', '27');
  await mkdir(sessionDir, { recursive: true });
  const source = path.join(sessionDir, sourceSpec
    ? `rollout-2026-09-27T02-00-00-${sourceSpec.id}.jsonl`
    : path.basename(fixture));
  if (sourceSpec) await writeFile(source, sourceSpec.text);
  else await copyFile(fixture, source);
  t.after(async () => {
    assert.equal(await sha256(source), expectedHash, 'the copied provider transcript stays read-only');
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(repo, 'tmp'));
    assert.ok(path.basename(temporary).startsWith('v3-codex-execution-'));
    await rm(temporary, { recursive: true, force: true });
  });

  const port = await freePort();
  const args = ['serve', '--port', String(port), '--codex-dir', dirs.codex,
    '--opencode-db', path.join(temporary, 'missing-opencode.db'), '--claude-dir', dirs.claude,
    '--pi-dir', dirs.pi, '--dsh-dir', dirs.dsh, '--meta-dir', dirs.meta,
    '--index-dir', dirs.index, '--cache-dir', dirs.cache];
  const child = spawn(binary, args, { cwd: repo, windowsHide: true, stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error('isolated Axum Reader exited before readiness');
    try {
      if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok)
        return { base, source };
    } catch { /* Axum is indexing this copied source. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('isolated Axum Reader did not become ready');
}

test('Codex HTTP keeps interleaved handles, overlapping waits, reuse, failures, and interruption requests distinct',
  { timeout: 45_000 }, async t => {
    const sessionId = '77777777-7777-4777-8777-777777777777';
    const running = handle => `Script running with cell ID ${handle}\nWall time 1 seconds\nOutput:\n`;
    const terminal = phase => `Script ${phase}\nWall time 1 seconds\nOutput:\n`;
    const row = (index, type, payload) => JSON.stringify({
      timestamp: new Date(Date.UTC(2026, 8, 27, 2, 0, index)).toISOString(), type, payload,
    });
    const call = (index, id, name, handle = null, terminate = false) => row(index, 'response_item', {
      type: name === 'exec' ? 'custom_tool_call' : 'function_call', call_id: id, name,
      ...(name === 'wait' ? { arguments: JSON.stringify({ cell_id: handle, terminate }) } : { input: 'opaque wrapper' }),
    });
    const output = (index, id, name, text) => row(index, 'response_item', {
      type: name === 'exec' ? 'custom_tool_call_output' : 'function_call_output', call_id: id, output: text,
    });
    const rows = [
      row(0, 'session_meta', { id: sessionId, cwd: '/synthetic/execution' }),
      call(1, 'a', 'exec'), output(2, 'a', 'exec', running('65')),
      call(3, 'b', 'exec'), output(4, 'b', 'exec', running('69')),
      call(5, 'a1', 'wait', '65'), call(6, 'a2', 'wait', '65'),
      call(7, 'b1', 'wait', '69'),
      output(8, 'a1', 'wait', running('65')),
      output(9, 'b1', 'wait', terminal('failed')),
      output(10, 'a2', 'wait', terminal('completed')),
      call(11, 'c', 'exec'), output(12, 'c', 'exec', running('65')),
      call(13, 'c1', 'wait', '65', true), output(14, 'c1', 'wait', terminal('completed')),
      call(15, 'missing', 'exec'),
    ];
    const text = `${rows.join('\n')}\n`;
    const hash = createHash('sha256').update(text).digest('hex');
    const { base } = await serve(t, hash, { id: sessionId, text });
    const v2 = await (await fetch(`${base}/api/v3/protocol/codex/${sessionId}?version=2`)).json();
    const v3 = await (await fetch(`${base}/api/v3/protocol/codex/${sessionId}?version=3`)).json();
    const steps = v3.events.filter(event => event.execution);
    assert.deepEqual(steps.map(event => [event.sourceOrder.record, event.execution.id,
      event.execution.phase, event.execution.handle]), [
      [1, 'a', 'started', '65'], [2, 'a', 'yielded', '65'],
      [3, 'b', 'started', '69'], [4, 'b', 'yielded', '69'],
      [5, 'a', 'polled', '65'], [6, 'a', 'polled', '65'], [7, 'b', 'polled', '69'],
      [8, 'a', 'yielded', '65'], [9, 'b', 'failed', '69'], [10, 'a', 'completed', '65'],
      [11, 'c', 'started', '65'], [12, 'c', 'yielded', '65'],
      [13, 'c', 'interruption-requested', '65'], [14, 'c', 'completed', '65'],
    ]);
    assert.deepEqual(v2.events.filter(event => event.execution).map(event => event.execution),
      steps.map(event => event.execution));
    assert.equal(v3.coverage.execution.state, 'observed');
    assert.ok(steps.every(event => event.readerEvent?.segment === 'tool'));
    assert.deepEqual(steps.map(event => event.readerEvent.messageId),
      ['a', 'a', 'b', 'b', 'a1', 'a2', 'b1', 'a1', 'b1', 'a2', 'c', 'c', 'c1', 'c1']);
    assert.equal(steps.some(event => event.execution.phase === 'cancelled'), false);
    const runtime = await (await fetch(`${base}/api/v3/runtime/codex/${sessionId}/events?category=tool&limit=50`)).json();
    assert.deepEqual(runtime.events.filter(event => event.execution).map(event => event.id),
      steps.map(event => event.id));
  });
test('Codex outer exec and wait expose four source-anchored execution phases without nested inference',
  { timeout: 45_000 }, async t => {
    const originalHash = await sha256(fixture);
    t.after(async () => {
      assert.equal(await sha256(fixture), originalHash, 'the public fixture stays unchanged');
    });
    const { base } = await serve(t, originalHash);
    const prefix = `${base}/api/v3/reader/codex/${id}`;
    const bootstrapResponse = await fetch(`${prefix}/bootstrap`);
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = await bootstrapResponse.json();
    const owned = bootstrap.segments.flatMap(segment => segment.items);
    assert.ok(owned.some(item => item.event.messageId === 'outer-1' && item.event.segment === 'tool'));
    assert.ok(owned.some(item => item.event.messageId === 'wait-1' && item.event.segment === 'tool'));

    const v2Response = await fetch(`${base}/api/v3/protocol/codex/${id}?version=2`);
    const v3Response = await fetch(`${base}/api/v3/protocol/codex/${id}?version=3`);
    assert.equal(v2Response.status, 200);
    assert.equal(v3Response.status, 200);
    const v2 = await v2Response.json();
    const v3 = await v3Response.json();
    assert.equal(v3.revision, bootstrap.revision);
    const execution = v3.events.filter(event => event.execution);
    assert.deepEqual(execution.map(event => [event.sourceOrder.record,
      event.execution.id, event.execution.kind, event.execution.phase,
      event.execution.handle, event.execution.toolName]), [
      [2, 'outer-1', 'async-tool', 'started', '65', 'exec'],
      [3, 'outer-1', 'async-tool', 'yielded', '65', 'exec'],
      [5, 'outer-1', 'async-tool', 'polled', '65', 'wait'],
      [6, 'outer-1', 'async-tool', 'completed', '65', 'wait'],
    ]);
    assert.deepEqual(v2.events.filter(event => event.execution).map(event => event.execution),
      execution.map(event => event.execution), 'v2 and v3 retain one validated execution fact stream');
    assert.equal(v3.coverage.execution.state, 'observed');
    assert.deepEqual(execution.map(event => event.readerEvent?.messageId),
      ['outer-1', 'outer-1', 'wait-1', 'wait-1']);
    assert.ok(execution.every(event => event.readerEvent?.segment === 'tool'));
    assert.equal(execution.some(event => event.execution.handle === '777'), false,
      'a nested JavaScript/result value is not an outer execution handle');

    const runtimeResponse = await fetch(`${base}/api/v3/runtime/codex/${id}/events?category=tool&limit=20`);
    assert.equal(runtimeResponse.status, 200);
    const runtime = await runtimeResponse.json();
    assert.deepEqual(runtime.events.filter(event => event.execution).map(event => event.id),
      execution.map(event => event.id), 'Runtime exposes the same source events as Session Protocol');
  });
