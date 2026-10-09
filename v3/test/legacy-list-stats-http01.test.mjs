import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const v3Binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const epoch = Date.parse('2026-09-28T00:00:00.000Z');
const codexId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const childId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const piId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const singlePointId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function timestamp(offsetMs) {
  return new Date(epoch + offsetMs).toISOString();
}

function jsonl(records) {
  return records.map(record => JSON.stringify(record)).join('\n') + '\n';
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function freePort() {
  return freeFetchSafePort();
}

async function waitForApi(child, base, label, stderr) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(label + ' exited before HTTP readiness: ' + stderr());
    }
    try {
      const response = await fetch(base + '/api/providers', {
        signal: AbortSignal.timeout(500)
      });
      if (response.ok) return;
    } catch {
      // The local server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(label + ' did not become ready: ' + stderr());
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill();
  await closed;
}

async function sessionStats(base, route, sessionId) {
  const response = await fetch(base + route);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const row = body.sessions.find(session => session.id === sessionId);
  assert.ok(row, 'legacy list returned canonical session ' + sessionId);
  assert.equal(row.stats.sessionId, sessionId);
  return row.stats;
}

test('HTTP-01 list stats preserve recorded Codex collaboration and Pi message spans',
  { timeout: 60_000 }, async t => {
    const scratch = path.join(repo, 'tmp');
    await mkdir(scratch, { recursive: true });
    const work = await mkdtemp(path.join(scratch, 'v3-legacy-list-stats-http01-'));
    const dirs = Object.fromEntries([
      'codex', 'pi', 'claude', 'dsh', 'meta-v3', 'index-v3', 'cache-v3'
    ].map(name => [name, path.join(work, name)]));
    await Promise.all(Object.values(dirs).map(dir => mkdir(dir, { recursive: true })));

    const codexSessions = path.join(dirs.codex, 'sessions', '2026', '09', '28');
    const piSessions = path.join(dirs.pi, 'sessions', 'synthetic');
    await Promise.all([
      mkdir(codexSessions, { recursive: true }),
      mkdir(piSessions, { recursive: true })
    ]);
    const codexSource = path.join(codexSessions,
      'rollout-2026-09-28T00-00-00-' + codexId + '.jsonl');
    const childSource = path.join(codexSessions,
      'rollout-2026-09-28T00-00-04-' + childId + '.jsonl');
    const singlePointSource = path.join(codexSessions,
      'rollout-2026-09-28T00-00-11-' + singlePointId + '.jsonl');
    const piSource = path.join(piSessions, 'current_' + piId + '.jsonl');
    const opencodeDb = path.join(work, 'opencode.db');

    const codexRecords = [
      { timestamp: timestamp(0), type: 'session_meta',
        payload: { id: codexId, cwd: '/synthetic/codex', agent_path: '/root' } },
      { timestamp: timestamp(1_000), type: 'response_item',
        payload: { type: 'message', role: 'user', id: 'user-before-spawn',
          content: [{ type: 'input_text', text: 'Inspect this synthetic change.' }],
          internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } },
      { timestamp: timestamp(2_000), type: 'response_item',
        payload: { type: 'function_call', id: 'spawn-call', call_id: 'spawn-call',
          name: 'spawn_agent', namespace: 'collaboration',
          arguments: JSON.stringify({ task_name: 'reviewer', message: 'Inspect the change.' }) } },
      { timestamp: timestamp(3_000), type: 'response_item',
        payload: { type: 'function_call_output', id: 'spawn-ack', call_id: 'spawn-call',
          output: JSON.stringify({ task_name: '/root/reviewer', agent_thread_id: childId }) } },
      { timestamp: timestamp(4_000), type: 'response_item',
        payload: { type: 'message', role: 'user', id: 'user-after-spawn',
          content: [{ type: 'input_text', text: 'While it runs, check this second point.' }],
          internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } },
      { timestamp: timestamp(8_000), type: 'response_item',
        payload: { type: 'agent_message', id: 'returned-review',
          author: '/root/reviewer', recipient: '/root',
          content: [{ type: 'input_text',
            text: 'Message Type: FINAL_ANSWER\nTask name: reviewer\nSender: /root/reviewer\nPayload:\nThe synthetic review is complete.' }] } },
      { timestamp: timestamp(2_000), type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'parent-turn',
          started_at: (epoch + 2_000) / 1_000 } },
      { timestamp: timestamp(10_000), type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'parent-turn',
          started_at: (epoch + 2_000) / 1_000,
          completed_at: (epoch + 10_000) / 1_000 } }
    ];
    const childRecords = [
      { timestamp: timestamp(4_000), type: 'session_meta',
        payload: { id: childId, parent_thread_id: codexId, agent_path: '/root/reviewer',
          thread_source: 'subagent' } },
      { timestamp: timestamp(5_000), type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'reviewer-turn',
          started_at: (epoch + 5_000) / 1_000 } },
      { timestamp: timestamp(7_000), type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'reviewer-turn',
          started_at: (epoch + 5_000) / 1_000,
          completed_at: (epoch + 7_000) / 1_000 } },
      { timestamp: timestamp(8_000), type: 'response_item',
        payload: { type: 'agent_message', id: 'child-final',
          content: [{ type: 'input_text',
            text: 'Message Type: FINAL_ANSWER\nTask name: reviewer\nSender: /root/reviewer\nPayload:\nFinished the assigned review.' }] } }
    ];
    const singlePointRecords = [
      { timestamp: timestamp(11_000), type: 'session_meta',
        payload: { id: singlePointId, cwd: '/synthetic/codex' } },
      { timestamp: timestamp(11_935), type: 'event_msg',
        payload: { type: 'user_message', message: 'One canonical request.' } },
      { timestamp: timestamp(12_000), type: 'response_item',
        payload: { type: 'message', role: 'user', id: 'single-canonical-user',
          content: [{ type: 'input_text', text: 'One canonical request.' }],
          internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } }
    ];
    const piRecords = [
      { type: 'session', version: 3, id: piId, timestamp: timestamp(0), cwd: '/synthetic/pi' },
      { type: 'model_change', id: 'configuration-only', timestamp: timestamp(1_000),
        provider: 'openai', modelId: 'synthetic-model' },
      { type: 'message', id: 'pi-user', parentId: null, timestamp: timestamp(2_000),
        message: { role: 'user', content: 'Synthetic Pi request' } },
      { type: 'message', id: 'pi-assistant', parentId: 'pi-user', timestamp: timestamp(7_000),
        message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic Pi reply' }] } },
      { type: 'session_info', id: 'late-config', name: 'Synthetic Pi session',
        timestamp: timestamp(120_000) }
    ];

    await Promise.all([
      writeFile(codexSource, jsonl(codexRecords)),
      writeFile(childSource, jsonl(childRecords)),
      writeFile(singlePointSource, jsonl(singlePointRecords)),
      writeFile(piSource, jsonl(piRecords))
    ]);
    const sourceFiles = [codexSource, childSource, singlePointSource, piSource];
    const sourceHashes = sourceFiles.map(sha256);

    const v3Port = await freePort();
    const v3 = spawn(v3Binary, [
      'serve', '--port', String(v3Port), '--opencode-db', opencodeDb,
      '--codex-dir', dirs.codex, '--claude-dir', dirs.claude, '--pi-dir', dirs.pi,
      '--dsh-dir', dirs.dsh, '--meta-dir', dirs['meta-v3'],
      '--index-dir', dirs['index-v3'], '--cache-dir', dirs['cache-v3']
    ], { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let v3Stderr = '';
    v3.stderr.on('data', data => { v3Stderr += data.toString(); });
    const v3Base = 'http://127.0.0.1:' + v3Port;

    t.after(async () => {
      await stop(v3);
      assert.deepEqual(sourceFiles.map(sha256), sourceHashes,
        'synthetic provider transcript bytes stay unchanged');
      await rm(work, { recursive: true, force: true });
    });

    await waitForApi(v3, v3Base, '3.0 Axum Viewer', () => v3Stderr);

    const v3Codex = await sessionStats(v3Base, '/api/codex/sessions?limit=50', codexId);
    const v3Pi = await sessionStats(v3Base, '/api/pi/sessions?limit=50', piId);
    const v3SinglePoint = await sessionStats(v3Base, '/api/codex/sessions?limit=50', singlePointId);

    await t.test('Codex parent messageCount excludes a returned agent envelope', () => {
      assert.equal(v3Codex.messageCount, 3,
        'two user messages and their separate spawn tool group');
    });

    await t.test('Codex spawn task, child completion, and session-turn run kinds stay distinct', () => {
      assert.deepEqual({
        taskCount: v3Codex.taskCount,
        agentRunCount: v3Codex.agentRunCount,
        subagentRunCount: v3Codex.subagentRunCount, activeStatuses: v3Codex.activeStatuses
      }, {
        taskCount: 1, agentRunCount: 1, subagentRunCount: 1, activeStatuses: []
      }, 'one spawn task and completed delegated child; session-turns are separate');
    });

    await t.test('Pi duration follows meaningful message events, not header/config timestamps', () => {
      assert.equal(v3Pi.durationMs, 5_000,
        'user at 2s and assistant at 7s; late configuration at 120s is excluded');
      assert.equal(v3Pi.durationSource, 'protocol');
    });

    await t.test('Codex list duration follows conversation events', () => {
      assert.equal(v3Codex.durationMs, 3_000,
        'parent conversation spans user messages at 1s and 4s; the agent envelope is excluded');
      assert.equal(v3Codex.durationSource, 'protocol');
    });

    await t.test('a lone canonical Codex message does not inherit the earlier native mirror duration', () => {
      assert.equal(v3SinglePoint.messageCount, 1);
      assert.equal(v3SinglePoint.durationMs, 1_000,
        'one canonical message has no protocol span; raw header-to-update spans 11s to 12s');
      assert.equal(v3SinglePoint.durationSource, 'raw');
    });
  });
