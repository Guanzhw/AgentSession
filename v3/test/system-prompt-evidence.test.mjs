import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const id = '44444444-4444-4444-8444-444444444444';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('system prompt API distinguishes recorded text, current local sources, and unavailable evidence', async t => {
  const root = await mkdtemp(path.join(repo, 'tmp', 'v3-prompt-evidence-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    await rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, 'workspace');
  const sessions = path.join(root, 'codex', 'sessions', '2026', '09', '26');
  await mkdir(workspace, { recursive: true });
  await mkdir(sessions, { recursive: true });
  const instruction = path.join(workspace, 'AGENTS.md');
  await writeFile(instruction, '# Local instruction\nUse focused tests.\n');
  const source = path.join(sessions, `rollout-2026-09-26T00-00-00-${id}.jsonl`);
  const rows = [
    { timestamp: '2026-09-26T00:00:00Z', type: 'session_meta', payload: {
      id, cwd: workspace, base_instructions: { text: 'Recorded base instruction.',
        provenance: { type: 'model', model: 'fixture-model' } } } },
    { timestamp: '2026-09-26T00:00:01Z', type: 'response_item', payload: {
      type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Recorded developer instruction.' }] } },
    { timestamp: '2026-09-26T00:00:02Z', type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] } },
  ];
  await writeFile(source, rows.map(JSON.stringify).join('\n') + '\n');
  const dshId = 'dsh-prompt-fixture';
  const dshSource = path.join(root, 'dsh', 'sessions', 'fixture', dshId, 'session.v3.jsonl');
  await mkdir(path.dirname(dshSource), { recursive: true });
  const dshMessage = (seq, text, surfaceOp, sourceEventSeqs) => ({
    type: 'system/message', seq, time: 1001 + seq, surfaceOp, sourceEventSeqs,
    data: { turn: 1, step: 1, message: { id: `system-${seq}`, role: 'system',
      source: { kind: 'plugin', plugin: 'fixture-system-prompt' },
      content: [{ type: 'text', text }] } },
  });
  await writeFile(dshSource, [
    { type: 'session', version: 3, id: dshId, createdAt: 1000, isSeeded: false, delegationDepth: 0 },
    dshMessage(0, 'Superseded system prompt.', 'append'),
    dshMessage(1, 'Active system prompt.', { op: 'replace', startSeq: 0, endSeq: 0 }, [0]),
  ].map(JSON.stringify).join('\n') + '\n');
  const originalHashes = new Map(await Promise.all([source, instruction, dshSource].map(async file =>
    [file, hash(await readFile(file))])));
  const port = await freeFetchSafePort();
  child = spawn(binary, ['serve', '--port', String(port), '--codex-dir', path.join(root, 'codex'),
    '--opencode-db', path.join(root, 'missing.db'), '--claude-dir', path.join(root, 'claude'),
    '--pi-dir', path.join(root, 'pi'), '--dsh-dir', path.join(root, 'dsh'),
    '--meta-dir', path.join(root, 'meta'), '--index-dir', path.join(root, 'index'),
    '--cache-dir', path.join(root, 'cache')], { cwd: repo, windowsHide: true, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/providers`)).ok) break; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const response = await fetch(`${base}/api/codex/session/${id}/system-prompts`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.sessionId, id);
  assert.equal(body.hiddenPromptStored, true);
  const items = body.sections.flatMap(section => section.items);
  assert.ok(items.some(item => item.provenance === 'recorded' &&
    item.content === 'Recorded developer instruction.' && item.source.includes(source)));
  assert.ok(items.some(item => item.content === 'Recorded base instruction.' &&
    item.sourceMetadata?.model === 'fixture-model'));
  assert.ok(items.some(item => item.provenance === 'current-local' &&
    item.content.includes('Use focused tests.') && item.sourcePath === instruction));
  assert.ok(body.diagnostics.some(item => item.code === 'hidden_prompt_unavailable'));
  const missing = await fetch(`${base}/api/codex/session/missing/system-prompts`);
  assert.equal(missing.status, 404);
  assert.equal((await fetch(`${base}/api/unknown/session/${id}/system-prompts`)).status, 404);
  assert.equal((await fetch(`${base}/api/opencode/session/${id}/system-prompts`)).status, 503);
  const dshResponse = await fetch(`${base}/api/deepseek-harness/session/${dshId}/system-prompts`);
  assert.equal(dshResponse.status, 200);
  const dsh = await dshResponse.json();
  const dshItems = dsh.sections.flatMap(section => section.items);
  assert.deepEqual(dshItems.filter(item => item.provenance === 'recorded').map(item => item.content),
    ['Active system prompt.']);
  assert.equal(dshItems.find(item => item.provenance === 'recorded').sourceMetadata.plugin,
    'fixture-system-prompt');
  assert.ok(dsh.diagnostics.some(item => item.code === 'session_directory_unavailable'));
  for (const [file, digest] of originalHashes) assert.equal(hash(await readFile(file)), digest);
});

test('frozen Codex prompt text and provenance match recorded source without mutation', async t => {
  const frozen = path.join(repo, 'tmp', 'v3-corpus', 'codex', 'sessions', '2026', '09', '26',
    'rollout-2026-09-26T02-27-27-01a0d9d2-83be-73b0-a0ec-7179e429d726.jsonl');
  if (!existsSync(frozen)) return t.skip('frozen private Codex source unavailable');
  const original = await readFile(frozen);
  const records = original.toString('utf8').trim().split('\n').map(JSON.parse);
  const header = records.find(row => row.type === 'session_meta' && row.payload?.base_instructions?.text);
  assert.ok(header, 'frozen source must carry recorded base instructions');
  const root = await mkdtemp(path.join(repo, 'tmp', 'v3-prompt-frozen-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      const closed = once(child, 'close'); child.kill();
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    await rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'codex', 'sessions', '2026', '09', '26', path.basename(frozen));
  await mkdir(path.dirname(source), { recursive: true });
  await copyFile(frozen, source);
  const port = await freeFetchSafePort();
  child = spawn(binary, ['serve', '--port', String(port), '--codex-dir', path.join(root, 'codex'),
    '--opencode-db', path.join(root, 'missing.db'), '--claude-dir', path.join(root, 'claude'),
    '--pi-dir', path.join(root, 'pi'), '--dsh-dir', path.join(root, 'dsh'),
    '--meta-dir', path.join(root, 'meta'), '--index-dir', path.join(root, 'index'),
    '--cache-dir', path.join(root, 'cache')], { cwd: repo, windowsHide: true, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}/api/codex/session/${header.payload.id}/system-prompts`;
  let response;
  for (let i = 0; i < 100; i++) {
    try { response = await fetch(url); if (response.ok) break; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(response?.status, 200);
  const body = await response.json();
  const items = body.sections.flatMap(section => section.items);
  const base = items.find(item => item.title === 'Recorded Codex base instructions');
  assert.equal(base.content, header.payload.base_instructions.text);
  assert.deepEqual(base.sourceMetadata, header.payload.base_instructions.provenance);
  assert.ok(base.source.includes(source));
  assert.equal(hash(await readFile(source)), hash(original));
  assert.equal(hash(await readFile(frozen)), hash(original));
});

test('frozen five-provider corpus exposes truthful prompt evidence or explicit unknowns', async t => {
  const corpus = path.join(repo, 'tmp', 'v3-corpus');
  const selected = [
    ['codex', 'codex/sessions/2026/09/26/rollout-2026-09-26T02-27-27-01a0d9d2-83be-73b0-a0ec-7179e429d726.jsonl'],
    ['claude-code', 'claude-code/projects/D--WorkSpace-OpenSession/5bd5ca2d-5614-4873-9023-f34f4b3c432e.jsonl'],
    ['pi', 'pi/sessions/--D--WorkSpace-OpenSession--/2026-07-19T13-31-30-839Z_019f7a93-2297-76db-827d-ee366e46482e.jsonl'],
    ['deepseek-harness', 'deepseek-harness/sessions/--D-WorkSpace-OpenSession--/session-a9f5b448-9851-4872-a266-fdc3381a5061/session.v3.jsonl.zstd'],
    ['opencode', 'opencode/opencode.db'],
  ];
  const dshV0Id = '18a1f7f5-78d3-4e64-96d8-8e50b54d7f56';
  const dshV0Relative = `deepseek-harness/sessions/--D-WorkSpace-OpenSession--/${dshV0Id}/session.jsonl.zstd`;
  if (selected.some(([, file]) => !existsSync(path.join(corpus, file))))
    return t.skip('frozen five-provider corpus unavailable');
  const root = await mkdtemp(path.join(repo, 'tmp', 'v3-prompt-corpus-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      const closed = once(child, 'close'); child.kill();
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    await rm(root, { recursive: true, force: true });
  });
  const digests = [];
  for (const [, relative] of selected) {
    const source = path.join(corpus, relative);
    const dest = path.join(root, relative);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(source, dest);
    digests.push([source, hash(await readFile(source))]);
  }
  if (existsSync(path.join(corpus, dshV0Relative))) {
    const source = path.join(corpus, dshV0Relative);
    const dest = path.join(root, dshV0Relative);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(source, dest);
    digests.push([source, hash(await readFile(source))]);
  }
  for (const suffix of ['-wal', '-shm']) {
    const source = path.join(corpus, 'opencode', `opencode.db${suffix}`);
    if (existsSync(source)) await copyFile(source, path.join(root, 'opencode', `opencode.db${suffix}`));
  }
  const port = await freeFetchSafePort();
  child = spawn(binary, ['serve', '--port', String(port), '--codex-dir', path.join(root, 'codex'),
    '--opencode-db', path.join(root, 'opencode', 'opencode.db'),
    '--claude-dir', path.join(root, 'claude-code'), '--pi-dir', path.join(root, 'pi'),
    '--dsh-dir', path.join(root, 'deepseek-harness'),
    '--meta-dir', path.join(root, 'meta'), '--index-dir', path.join(root, 'index'),
    '--cache-dir', path.join(root, 'cache')], { cwd: repo, windowsHide: true, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${base}/api/providers`)).ok) break; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  for (const [provider] of selected) {
    const sessions = await fetch(`${base}/api/v3/sessions?provider=${provider}`);
    assert.equal(sessions.status, 200, provider);
    const rows = await sessions.json();
    assert.ok(rows.length > 0, `${provider} must expose the selected frozen source`);
    const id = rows[0].session.sessionId;
    const response = await fetch(`${base}/api/${provider}/session/${encodeURIComponent(id)}/system-prompts`);
    assert.equal(response.status, 200, provider);
    const evidence = await response.json();
    assert.equal(evidence.sessionId, id, provider);
    assert.ok(evidence.diagnostics.some(item => item.code === 'hidden_prompt_unavailable'), provider);
    assert.ok(evidence.sections.every(section => section.items.every(item =>
      ['recorded', 'current-local'].includes(item.provenance))), provider);
  }
  if (existsSync(path.join(corpus, dshV0Relative))) {
    const response = await fetch(`${base}/api/deepseek-harness/session/${dshV0Id}/system-prompts`);
    assert.equal(response.status, 200, 'frozen DSH v0 prompt evidence');
    const evidence = await response.json();
    assert.equal(evidence.sessionId, dshV0Id);
    assert.equal(evidence.mode, 'deepseek-harness-recorded');
  }
  for (const [source, digest] of digests) assert.equal(hash(await readFile(source)), digest);
});
