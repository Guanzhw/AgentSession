// Public synthetic DSH v3 source. No user transcript or real team data is used.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

const root = fileURLToPath(new URL('.', import.meta.url));
const rootId = 'dsh-v3-s2-root';
const alphaId = 'dsh-v3-s2-alpha';
const betaId = 'dsh-v3-s2-beta';
const baseTime = 1_780_000_000_000;
const block = text => [{ type: 'text', text }];
const event = (seq, type, data, extra = {}) => ({ type, seq, time: baseTime + seq + 1, data, ...extra });
const header = (id, extra = {}) => ({ type: 'session', version: 3, id, createdAt: baseTime,
  cwd: '/synthetic/dsh-s2', isSeeded: false, delegationDepth: 0, agentPreset: 'standard', ...extra });
const user = (seq, id, text) => event(seq, 'user/message',
  { id, role: 'user', source: { kind: 'user' }, content: block(text) }, { surfaceOp: 'append' });
const assistant = (seq, id, text, turn = 1) => event(seq, 'assistant/message',
  { turn, step: 1, message: { id, role: 'assistant', source: { kind: 'model',
    provider: 'synthetic', model: 'fixture-only' }, content: block(text) } }, { surfaceOp: 'append' });
const teamTask = (seq, id, ownerId, status, revision) => event(seq, 'team/task',
  { version: 2, teamId: rootId, task: { id, revision, subject: `Inspect synthetic ${id}`,
    description: `Read synthetic ${id} input and report back`, status, ownerId,
    blockedBy: [], writeScopes: [] } });
const queued = (seq, id, senderId, targetId, text) => event(seq, 'team/message/queued',
  { version: 2, teamId: rootId, message: { id, senderId, senderName: senderId === rootId ? 'lead' : 'worker',
    targetId, delivery: 'quiet', content: Array.isArray(text) ? text.map(part => ({ type: 'text', text: part })) : block(text) } });
const delivered = (seq, id, targetId) => event(seq, 'team/message/delivered',
  { version: 2, teamId: rootId, messageId: id, targetId });

const parent = [
  header(rootId),
  event(0, 'turn/start', { turn: 1 }),
  user(1, 'root-user', 'Inspect the synthetic alpha and beta inputs.'),
  event(2, 'step/start', { turn: 1, step: 1 }),
  assistant(3, 'root-dispatch', 'I will assign one synthetic input to each worker.'),
  event(4, 'team/member', { version: 2, teamId: rootId, member: { id: alphaId, name: 'alpha',
    description: 'Synthetic alpha worker', provider: 'subagent', context: 'fresh', phase: 'active' } }),
  event(5, 'team/member', { version: 2, teamId: rootId, member: { id: betaId, name: 'beta',
    description: 'Synthetic beta worker', provider: 'subagent', context: 'fresh', phase: 'active' } }),
  teamTask(6, 'alpha', alphaId, 'in_progress', 1),
  teamTask(7, 'beta', betaId, 'in_progress', 1),
  queued(8, 'mail-alpha-initial', rootId, alphaId, 'Inspect synthetic alpha.'),
  delivered(9, 'mail-alpha-initial', alphaId),
  event(10, 'tool-workflow/agent-start', { runId: 'parallel-inspection', seq: 1, label: 'alpha', childId: alphaId }),
  queued(11, 'mail-beta-initial', rootId, betaId, 'Inspect synthetic beta.'),
  delivered(12, 'mail-beta-initial', betaId),
  event(13, 'tool-workflow/agent-start', { runId: 'parallel-inspection', seq: 2, label: 'beta', childId: betaId }),
  assistant(14, 'root-continues', 'The main conversation continues while both synthetic workers run.'),
  queued(15, 'mail-alpha-followup', rootId, alphaId,
    ['Also check the alpha ending marker. ' + 'alpha context '.repeat(10),
      'Follow-up details '.repeat(5) + 'FINAL-ALPHA-FOLLOWUP-MARKER']),
  delivered(16, 'mail-alpha-followup', alphaId),
  event(17, 'tool-workflow/agent-end', { runId: 'parallel-inspection', seq: 2, outcome: 'completed' }),
  teamTask(18, 'beta', betaId, 'completed', 2),
  event(19, 'tool-workflow/agent-end', { runId: 'parallel-inspection', seq: 1, outcome: 'completed' }),
  teamTask(20, 'alpha', alphaId, 'completed', 2),
  queued(21, 'mail-alpha-return', alphaId, rootId, 'Alpha check complete; ending marker observed.'),
  delivered(22, 'mail-alpha-return', rootId),
  event(23, 'tool/call', { turn: 1, step: 1, callId: 'root-check', name: 'read_marker',
    arguments: { path: '/synthetic/marker.txt' } }),
  event(24, 'tool/result', { turn: 1, step: 1, message: { id: 'root-tool-result', role: 'user',
    source: { kind: 'tool', callId: 'root-check' }, content: [{ type: 'tool-result', toolCallId: 'root-check',
      content: block('SYNTHETIC-MARKER-OK'), isError: false }] } }, { surfaceOp: 'append' }),
  assistant(25, 'root-final', 'Both synthetic reports are recorded. Alpha confirmed its ending marker; beta completed its independent check. The parent now has the returned facts. END-OF-SYNTHETIC-DSH-ROOT'),
  event(26, 'step/end', { turn: 1, step: 1 }),
  event(27, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
];

function child(id, label, answer) {
  return [
    header(id, { parentSession: rootId, origin: 'subagent', delegationDepth: 1 }),
    event(0, 'subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'subagent', label }),
    event(1, 'turn/start', { turn: 1 }),
    user(2, `${label}-user`, `Inspect synthetic ${label}.`),
    event(3, 'step/start', { turn: 1, step: 1 }),
    assistant(4, `${label}-answer`, answer),
    event(5, 'step/end', { turn: 1, step: 1 }),
    event(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
}

const sessions = [
  [rootId, parent],
  [alphaId, child(alphaId, 'alpha', 'Synthetic alpha result. The ending marker is ALPHA-END.')],
  [betaId, child(betaId, 'beta', 'Synthetic beta result. The ending marker is BETA-END.')],
];

for (const [id, records] of sessions) {
  const destination = path.join(root, 'sessions', 's2-synthetic', id, 'session.v3.jsonl.zstd');
  await mkdir(path.dirname(destination), { recursive: true });
  // Separate frames deliberately span record boundaries; concatenation is valid Zstd.
  const midpoint = Math.ceil(records.length / 2);
  const frames = [records.slice(0, midpoint), records.slice(midpoint)]
    .map(part => zstdCompressSync(Buffer.from(`${part.map(record => JSON.stringify(record)).join('\n')}\n`)));
  await writeFile(destination, Buffer.concat(frames));
}
