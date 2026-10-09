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
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const id = '99999999-9999-4999-8999-999999999999';
const fixture = path.join(repo, 'v3', 'fixtures', 'codex-collaboration', 'sessions',
  '2026', '09', '27', `rollout-2026-09-27T00-00-00-${id}.jsonl`);

async function freePort() {
  return freeFetchSafePort();
}

test('Codex collaboration is source anchored across Reader and v3 protocol HTTP',
  { timeout: 30_000 }, async t => {
    const work = await mkdtemp(path.join(repo, 'tmp', 'v3-codex-collab-'));
    t.after(() => rm(work, { recursive: true, force: true }));
    const codexDir = path.join(work, 'codex');
    const sessionDir = path.join(codexDir, 'sessions', '2026', '09', '27');
    await mkdir(sessionDir, { recursive: true });
    for (const name of ['meta', 'index', 'cache', 'claude', 'pi'])
      await mkdir(path.join(work, name));
    const source = path.join(sessionDir, path.basename(fixture));
    await writeFile(source, readFileSync(fixture));
    const hash = () => createHash('sha256').update(readFileSync(source)).digest('hex');
    const before = hash();
    const port = await freePort();
    const child = spawn(binary, ['serve', '--port', String(port), '--codex-dir', codexDir,
      '--opencode-db', path.join(work, 'opencode.db'), '--claude-dir', path.join(work, 'claude'),
      '--pi-dir', path.join(work, 'pi'), '--dsh-dir', path.join(work, 'missing-dsh'),
      '--meta-dir', path.join(work, 'meta'), '--index-dir', path.join(work, 'index'),
      '--cache-dir', path.join(work, 'cache')], { cwd: repo, windowsHide: true, stdio: 'ignore' });
    t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'close'); });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok; }
      catch { /* Axum is starting. */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Axum started');
    const prefix = `${base}/api/v3/reader/codex/${id}`;
    const bootstrap = await (await fetch(`${prefix}/bootstrap`)).json();
    assert.equal(bootstrap.relations.observationCount, 5);
    const relations = await (await fetch(`${prefix}/relations?cursor=${encodeURIComponent(bootstrap.relations.firstCursor)}`)).json();
    const ack = relations.entries.find(row => row.observation?.state === 'started');
    const result = relations.entries.find(row => row.observation?.state === 'completed');
    assert.equal(ack.observation.toActorPath, '/root/reviewer');
    assert.equal(ack.observation.toSessionRef, null);
    assert.equal(result.observation.fromActorPath, ack.observation.toActorPath);
    assert.equal(result.observation.fromSessionRef, null);
    assert.equal(result.observation.toSessionRef.sessionId, id);
    assert.equal(result.observation.eventId, 'event:codex:7');
    const wait = relations.entries.find(row => row.observation?.state === 'timed_out');
    assert.equal(wait.observation.kind, 'wait');
    assert.equal(wait.observation.eventId, 'event:codex:6');
    assert.equal(wait.observation.toActorPath, undefined);
    assert.equal(wait.observation.toSessionRef, null);
    for (const [source, callId] of [[2, 'spawn-1'], [4, 'spawn-1'], [5, 'wait-1'], [6, 'wait-1']]) {
      const row = relations.entries.find(entry => entry.observation?.eventId === `event:codex:${source}`);
      assert.equal(row.observation.readerEvent.messageId, callId);
      assert.equal(row.observation.readerEvent.segment, 'tool');
      const eventResponse = await fetch(`${base}/api/v3/runtime/codex/${id}/events/${encodeURIComponent(`event:codex:${source}`)}?revision=${encodeURIComponent(bootstrap.revision)}`);
      assert.equal(eventResponse.status, 200);
      assert.deepEqual((await eventResponse.json()).event.readerEvent, row.observation.readerEvent);
    }
    const event = result.observation.readerEvent;
    const content = await (await fetch(`${prefix}/content?${new URLSearchParams({
      revision: bootstrap.revision, messageId: event.messageId, segment: event.segment,
      field: 'body', offset: '0', maxChars: '1000',
    })}`)).json();
    assert.equal(content.text, '  The review found one actionable issue.\n');
    const search = await (await fetch(`${base}/api/v3/search?provider=codex&fields=assistant&q=actionable%20issue`)).json();
    assert.deepEqual(search.matches.map(row => row.event), [event],
      'Viewer search must retain the recorded agent reply under assistant content');
    assert.equal(search.matches[0].matchRole, 'agent');
    const v2 = await (await fetch(`${base}/api/v3/protocol/codex/${id}?version=2`)).json();
    const v3 = await (await fetch(`${base}/api/v3/protocol/codex/${id}?version=3`)).json();
    assert.equal(v3.coordination.length, 5);
    assert.equal(v3.coordination[4].evidence.eventId, 'event:codex:7');
    assert.equal(v3.coverage.coordination.state, 'observed');
    for (const key of ['session', 'revision', 'events', 'relationships', 'tasks', 'agentRuns',
      'contextArtifacts', 'branches']) assert.deepEqual(v3[key], v2[key]);
    assert.equal(hash(), before);
  });
