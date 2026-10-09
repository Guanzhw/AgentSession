import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const fixtureRoot = fileURLToPath(new URL('../fixtures/deepseek-harness/sessions/s2-synthetic/', import.meta.url));
const ids = ['dsh-v3-s2-root', 'dsh-v3-s2-alpha', 'dsh-v3-s2-beta'];
const sourceHashes = [
  'ff0e1515e0faac0b0e0a44515afcd484896fae748d9164931b0cde981782880f',
  '4d139be50bd2121c454b92176e689fac3ba901347d3b06106b6c49a15924a51e',
  'c38d044b4e05a264ac02082cce4e209fac6da7503468ae48bfd7b7a5a4db9e96',
];
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function source(id) {
  const bytes = readFileSync(path.join(fixtureRoot, id, 'session.v3.jsonl.zstd'));
  const starts = [];
  for (let offset = 0; offset <= bytes.length - magic.length; offset++) {
    if (bytes.subarray(offset, offset + magic.length).equals(magic)) starts.push(offset);
  }
  assert.equal(starts[0], 0);
  assert.equal(starts.length, 2, 'each source must contain two independent Zstd frames');
  const frames = starts.map((start, index) => zstdDecompressSync(bytes.subarray(start, starts[index + 1] ?? bytes.length)));
  const rows = frames.flatMap(frame => frame.toString('utf8').trimEnd().split('\n').map(JSON.parse));
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].version, 3);
  assert.equal(rows[0].isSeeded, false);
  assert.deepEqual(rows.slice(1).map(row => row.seq), Array.from({ length: rows.length - 1 }, (_, index) => index));
  return rows;
}

test('public DSH S2 fixture has canonical, independently decodable multi-frame sources', () => {
  assert.deepEqual(ids.map(id => createHash('sha256').update(readFileSync(path.join(fixtureRoot, id,
    'session.v3.jsonl.zstd'))).digest('hex')), sourceHashes);
  const [parent, alpha, beta] = ids.map(source);
  assert.equal(parent.length, 29);
  const followup = parent.find(row => row.seq === 15).data.message.content;
  assert.equal(followup.length, 2);
  assert.ok(followup.map(block => block.text).join('\n\n').length > 240);
  assert.match(followup[1].text, /FINAL-ALPHA-FOLLOWUP-MARKER$/);
  assert.equal(alpha.length, 8);
  assert.equal(beta.length, 8);
  assert.deepEqual([alpha[0].parentSession, beta[0].parentSession], [ids[0], ids[0]]);
  assert.deepEqual([alpha[0].origin, beta[0].origin], ['subagent', 'subagent']);
  assert.deepEqual([alpha[0].delegationDepth, beta[0].delegationDepth], [1, 1]);
});

test('public DSH S2 source records define concurrent assignments, follow-up, return, and final body', () => {
  const parent = source(ids[0]);
  const at = seq => parent[seq + 1];
  assert.deepEqual([4, 5].map(seq => at(seq).data.member.id), ids.slice(1));
  assert.deepEqual([6, 7, 18, 20].map(seq => [at(seq).data.task.id, at(seq).data.task.revision, at(seq).data.task.status]), [
    ['alpha', 1, 'in_progress'], ['beta', 1, 'in_progress'],
    ['beta', 2, 'completed'], ['alpha', 2, 'completed'],
  ]);
  assert.deepEqual([8, 11, 15, 21].map(seq => [at(seq).data.message.id,
    at(seq).data.message.senderId, at(seq).data.message.targetId]), [
    ['mail-alpha-initial', ids[0], ids[1]],
    ['mail-beta-initial', ids[0], ids[2]],
    ['mail-alpha-followup', ids[0], ids[1]],
    ['mail-alpha-return', ids[1], ids[0]],
  ]);
  assert.deepEqual([9, 12, 16, 22].map(seq => [at(seq).data.messageId, at(seq).data.targetId]), [
    ['mail-alpha-initial', ids[1]], ['mail-beta-initial', ids[2]],
    ['mail-alpha-followup', ids[1]], ['mail-alpha-return', ids[0]],
  ]);
  assert.deepEqual([10, 13, 17, 19].map(seq => [at(seq).type, at(seq).data.runId,
    at(seq).data.seq, at(seq).data.childId ?? null, at(seq).data.outcome ?? null]), [
    ['tool-workflow/agent-start', 'parallel-inspection', 1, ids[1], null],
    ['tool-workflow/agent-start', 'parallel-inspection', 2, ids[2], null],
    ['tool-workflow/agent-end', 'parallel-inspection', 2, null, 'completed'],
    ['tool-workflow/agent-end', 'parallel-inspection', 1, null, 'completed'],
  ]);
  assert.equal(at(14).data.message.id, 'root-continues');
  assert.deepEqual([at(23).type, at(23).data.callId, at(24).type,
    at(24).data.message.content[0].toolCallId], ['tool/call', 'root-check', 'tool/result', 'root-check']);
  assert.equal(at(25).data.message.id, 'root-final');
  assert.match(at(25).data.message.content[0].text, /END-OF-SYNTHETIC-DSH-ROOT$/);
  assert.deepEqual(ids.slice(1).map(id => source(id)[5].data.message.id), ['alpha-answer', 'beta-answer']);
});
