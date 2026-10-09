import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { frozenFourProviderTimelineFacts, jsonlTimelineFacts, openCodeV2TimelineFacts,
  verifyFourProviderTimeline } from '../scripts/v3-four-provider-timeline-oracle.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const manifestPath = path.join(repo, 'tmp', 'v3-corpus', 'manifest.private.json');
const jsonl = rows => Buffer.from(rows.map(JSON.stringify).join('\n'));
const asTimeline = facts => facts.required.map(({ event, role }) => ({ event, role }));

function openCodeFixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agentsession-source-oracle-'));
  const file = path.join(directory, 'source.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT);
    INSERT INTO session_v2 VALUES ('s');`);
  const insert = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)');
  insert.run('u', 's', 'user', 1, JSON.stringify({ text: 'prompt' }));
  insert.run('a', 's', 'assistant', 2, JSON.stringify({ content: [
    { type: 'text', text: 'reply' }, { type: 'tool', name: 'read', state: { status: 'completed' } },
  ] }));
  db.close();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return openCodeV2TimelineFacts(file, 's');
}

const claude = jsonlTimelineFacts('claude-code', jsonl([
  { type: 'user', sessionId: 's', uuid: 'u', message: { content: 'prompt' } },
  { type: 'assistant', sessionId: 's', uuid: 'a', message: { content: [
    { type: 'text', text: 'reply' }, { type: 'tool_use', id: 'call', name: 'Read' },
  ] } },
  { type: 'user', sessionId: 's', uuid: 'result', message: { content: [
    { type: 'tool_result', tool_use_id: 'call', content: 'done' },
  ] } },
]), 's');
const pi = jsonlTimelineFacts('pi', jsonl([
  { type: 'session', id: 's', version: 3 },
  { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'prompt' }] } },
  { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: [
    { type: 'text', text: 'reply' }, { type: 'toolCall', id: 'call', name: 'read' },
  ] } },
]), 's');
const codex = jsonlTimelineFacts('codex', jsonl([
  { type: 'session_meta', payload: { id: 's' } },
  { type: 'response_item', payload: { type: 'message', id: 'u', role: 'user',
    internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] },
    content: [{ type: 'input_text', text: 'prompt' }] } },
  { type: 'response_item', payload: { type: 'message', id: 'a', role: 'assistant',
    content: [{ type: 'output_text', text: 'reply' }] } },
  { type: 'response_item', payload: { type: 'function_call', call_id: 'call', name: 'read' } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call', output: 'done' } },
]), 's');

test('raw source determines canonical message and tool refs for all four providers', t => {
  const opencode = openCodeFixture(t);
  for (const facts of [opencode, claude, pi, codex]) {
    assert.ok(facts.required.some(row => row.role === 'user'));
    assert.ok(facts.required.some(row => row.role === 'assistant'));
    assert.ok(facts.required.some(row => row.role === 'tool'));
    assert.match(facts.sourceSha256, /^[0-9a-f]{64}$/);
    assert.equal(verifyFourProviderTimeline(facts, asTimeline(facts)).ok, true);
  }
  assert.deepEqual(opencode.required.map(row => row.event.messageId), ['u', 'a:content:0', 'a:content:1']);
  assert.deepEqual(claude.required.map(row => row.event.messageId), ['u', 'a:0', 'call', 'tool-result:call']);
  assert.deepEqual(pi.required.map(row => row.event.messageId), ['u', 'a', 'call']);
  assert.deepEqual(codex.required.map(row => row.event.messageId), ['u', 'a', 'call']);
});

test('verifier rejects missing assistant/tool, duplicates, wrong owner/segment/role, and source reversal', t => {
  for (const facts of [openCodeFixture(t), claude, pi, codex]) {
    const rows = asTimeline(facts);
    for (const role of ['assistant', 'tool']) {
      const index = rows.findIndex(row => row.role === role);
      assert.equal(verifyFourProviderTimeline(facts, rows.filter((_, i) => i !== index)).ok, false);
    }
    assert.equal(verifyFourProviderTimeline(facts, [...rows, rows[0]]).ok, false);
    const wrongOwner = structuredClone(rows); wrongOwner[0].event.sessionId = 'other';
    assert.equal(verifyFourProviderTimeline(facts, wrongOwner).ok, false);
    const wrongSegment = structuredClone(rows); wrongSegment[0].event.segment = 'tool';
    assert.equal(verifyFourProviderTimeline(facts, wrongSegment).ok, false);
    const wrongRole = structuredClone(rows); wrongRole[0].role = 'assistant';
    assert.equal(verifyFourProviderTimeline(facts, wrongRole).ok, false);
    const reversed = structuredClone(rows); [reversed[0], reversed[1]] = [reversed[1], reversed[0]];
    assert.equal(verifyFourProviderTimeline(facts, reversed).ok, false);
  }
});

test('Pi branch selection excludes inactive source messages', () => {
  const facts = jsonlTimelineFacts('pi', jsonl([
    { type: 'session', id: 's', version: 3 },
    { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'prompt' }] } },
    { type: 'message', id: 'abandoned', parentId: 'u', message: { role: 'assistant', content: [{ type: 'text', text: 'old' }] } },
    { type: 'message', id: 'current', parentId: 'u', message: { role: 'assistant', content: [{ type: 'text', text: 'new' }] } },
  ]), 's');
  assert.deepEqual(facts.required.map(row => row.event.messageId), ['u', 'current']);
});

test('Pi source inventory includes active readable checkpoints and displayed custom messages', () => {
  const facts = jsonlTimelineFacts('pi', jsonl([
    { type: 'session', id: 's', version: 3 },
    { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'prompt' }] } },
    { type: 'compaction', id: 'c', parentId: 'u', summary: 'checkpoint' },
    { type: 'branch_summary', id: 'b', parentId: 'c', summary: 'branch result' },
    { type: 'custom_message', id: 'visible', parentId: 'b', display: true, content: [{ type: 'text', text: 'notice' }] },
    { type: 'custom_message', id: 'hidden', parentId: 'visible', display: false, content: [{ type: 'text', text: 'private' }] },
    { type: 'message', id: 'a', parentId: 'hidden', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
  ]), 's');
  assert.equal(facts.coverage.membership, 'exact');
  assert.deepEqual(facts.required.map(row => [row.event.messageId, row.role]), [
    ['u', 'user'], ['c', 'system'], ['b', 'system'], ['visible', 'system'], ['a', 'assistant'],
  ]);
  assert.equal(verifyFourProviderTimeline(facts, asTimeline(facts)).ok, true);
  assert.equal(verifyFourProviderTimeline(facts,
    asTimeline(facts).filter(row => row.event.messageId !== 'c')).ok, false);
});

test('Claude task notification is disclosed as partial coverage rather than a user event', () => {
  const facts = jsonlTimelineFacts('claude-code', jsonl([
    { type: 'user', sessionId: 's', uuid: 'notification', message: { content: '<task-notification>done</task-notification>' } },
    { type: 'assistant', sessionId: 's', uuid: 'reply', message: { content: 'acknowledged' } },
  ]), 's');
  assert.deepEqual(facts.required.map(row => row.event.messageId), ['reply']);
  assert.equal(facts.coverage.membership, 'partial');
  assert.ok(facts.coverage.unknown.includes('task notification mapping'));
});

test('Codex final answers require an acknowledged recorded child and envelope', () => {
  const facts = jsonlTimelineFacts('codex', jsonl([
    { type: 'session_meta', payload: { id: 's', agent_path: '/root' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'spawn',
      name: 'spawn_agent', namespace: 'collaboration' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'spawn',
      output: JSON.stringify({ task_name: '/root/child' }) } },
    { type: 'response_item', payload: { type: 'agent_message', id: 'bound', author: '/root/child',
      recipient: '/root', content: [{ text: 'Message Type: FINAL_ANSWER\nTask name: /root/child\nSender: /root/child\nPayload:\ndone' }] } },
    { type: 'response_item', payload: { type: 'agent_message', id: 'unbound', author: '/root/other',
      recipient: '/root', content: [{ text: 'Message Type: FINAL_ANSWER\nTask name: /root/other\nSender: /root/other\nPayload:\nnot acknowledged' }] } },
  ]), 's');
  assert.deepEqual(facts.required.map(row => [row.event.messageId, row.role]), [
    ['spawn', 'tool'], ['bound', 'agent'],
  ]);
  assert.equal(facts.coverage.membership, 'partial');
  assert.ok(facts.coverage.unknown.includes('unbound final answer'));
});

test('frozen sources keep their recorded hashes and yield source-only inventories',
  { skip: !existsSync(manifestPath) && process.env.AGENTSESSION_V3_REAL_CORPUS_REQUIRED !== '1'
    ? 'requires ignored frozen corpus' : false, timeout: 120_000 }, () => {
    assert.ok(existsSync(manifestPath), 'frozen corpus required');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const provider of ['opencode', 'claude-code', 'codex', 'pi']) {
      const facts = frozenFourProviderTimelineFacts(manifest, provider);
      assert.ok(facts.required.length > 0, `${provider} source inventory exists`);
      assert.equal(verifyFourProviderTimeline(facts, asTimeline(facts)).ok, true);
      const source = provider === 'opencode' ? manifest.database : manifest.files.find(
        row => row.provider === provider && row.role !== 'compact-team-shorter');
      assert.equal(createHash('sha256').update(readFileSync(source.snapshotPath)).digest('hex'),
        source.snapshotSha256, `${provider} source bytes unchanged`);
      assert.equal(facts.sourceSha256, source.snapshotSha256);
    }
  });
