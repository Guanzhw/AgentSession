import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initConfig } from '../dist/src/config.js';
import { registerReaderCoordinationRoutes } from '../dist/src/routes/reader-coordination.js';

test('Codex exchange revisions ignore other sessions and freshly detect their source or required parent changing', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'agentsession-coordination-revision-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const sessions = path.join(temp, 'sessions');
  mkdirSync(sessions);
  const row = (type, payload) => ({ type, payload, timestamp: '2026-09-20T01:00:00.000Z' });
  const rootRecords = [row('session_meta', { id: 'root', agent_path: '/root' }),
    row('event_msg', { type: 'user_message', message: 'Parent request' })];
  const childRecords = [row('session_meta', { id: 'child', parent_thread_id: 'root', agent_path: '/root/child' }),
    row('response_item', { type: 'agent_message', id: 'task', author: '/root', recipient: '/root/child',
      content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/child\nSender: /root\nPayload:\nAssigned work' }] }),
    row('event_msg', { type: 'task_complete', turn_id: 'child-turn', last_agent_message: 'Stable child answer' })];
  const legacyRecords = [row('session_meta', { id: 'legacy', parent_thread_id: 'root', agent_path: '/root/legacy' }),
    ...rootRecords, row('turn_context', { model: 'legacy-model' }),
    row('event_msg', { type: 'task_complete', turn_id: 'legacy-turn', last_agent_message: 'Legacy answer' })];
  const unrelatedRecords = [row('session_meta', { id: 'unrelated', agent_path: '/unrelated' })];
  const write = (id, records) => writeFileSync(path.join(sessions, `${id}.jsonl`), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  for (const [id, records] of [['root', rootRecords], ['child', childRecords], ['legacy', legacyRecords], ['unrelated', unrelatedRecords]]) write(id, records);
  initConfig(['--codex-dir', temp]);
  const { default: codex } = await import('../dist/src/providers/codex/adapter.js?scoped-coordination-revision');
  const protocol = codex.getSessionProtocolSnapshots('root').v3;
  const child = protocol.coordination.find((item) => item.kind === 'child-turn-completed' && item.fromSessionRef.sessionId === 'child');
  const legacy = protocol.coordination.find((item) => item.kind === 'child-turn-completed' && item.fromSessionRef.sessionId === 'legacy');
  assert.ok(child);
  assert.ok(legacy);
  let afterContentRead = () => {};
  const adapter = {
    ...codex,
    getSessionProtocolV3(id) { assert.equal(id, 'root'); return protocol; },
    getReaderCoordinationContent(id, observation) {
      const content = codex.getReaderCoordinationContent(id, observation);
      afterContentRead();
      return content;
    }
  };
  const routes = [];
  registerReaderCoordinationRoutes({ get(pattern, handler) { routes.push({ pattern, handler }); } }, { providerMap: new Map([['codex', adapter]]) });
  const request = async (observation) => {
    const pathname = `/api/codex/session/root/reader/coordination/${encodeURIComponent(observation.id)}/content`;
    const route = routes.find((item) => item.pattern.test(pathname));
    const response = { status: 0, body: '', writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    await route.handler({ url: `${pathname}?offset=0` }, response, pathname.match(route.pattern));
    return { status: response.status, data: JSON.parse(response.body) };
  };

  const sourceRevision = codex.getReaderCoordinationContentRevision('root', child);
  const wideRevision = codex.getProtocolRevision('root');
  unrelatedRecords.push(row('event_msg', { type: 'user_message', message: 'Unrelated activity' }));
  write('unrelated', unrelatedRecords);
  assert.equal(codex.getReaderCoordinationContent('root', child).text, 'Stable child answer');
  assert.notEqual(codex.getProtocolRevision('root'), wideRevision, 'The unrelated update changes the broad index revision');
  assert.equal(codex.getReaderCoordinationContentRevision('root', child), sourceRevision);
  afterContentRead = () => {
    unrelatedRecords.push(row('event_msg', { type: 'user_message', message: 'Activity during another exchange read' }));
    write('unrelated', unrelatedRecords);
  };
  const unrelated = await request(child);
  assert.equal(unrelated.status, 200);
  assert.match(unrelated.data.html, /Stable child answer/);

  afterContentRead = () => {};
  childRecords[2].payload.last_agent_message = 'Updated child answer with a different length';
  write('child', childRecords);
  assert.notEqual(codex.getReaderCoordinationContentRevision('root', child), sourceRevision,
    'The selected signature changes immediately, without waiting for the global store refresh interval');
  assert.equal(codex.getReaderCoordinationContent('root', child).text, childRecords[2].payload.last_agent_message,
    'The hook captures a fresh source extent rather than reading the previously cached body');
  afterContentRead = () => {
    childRecords[2].payload.last_agent_message = 'Replaced while this exchange was being read';
    write('child', childRecords);
  };
  const changedSource = await request(child);
  assert.equal(changedSource.status, 409);
  assert.equal(changedSource.data.code, 'stale_content');

  afterContentRead = () => {};
  const modernBeforeParentChange = codex.getReaderCoordinationContentRevision('root', child);
  const legacyBeforeParentChange = codex.getReaderCoordinationContentRevision('root', legacy);
  rootRecords.push(row('event_msg', { type: 'user_message', message: 'Parent ownership evidence changed' }));
  write('root', rootRecords);
  assert.equal(codex.getReaderCoordinationContentRevision('root', child), modernBeforeParentChange,
    'A modern NEW_TASK boundary does not depend on parent content');
  assert.notEqual(codex.getReaderCoordinationContentRevision('root', legacy), legacyBeforeParentChange);
  afterContentRead = () => {
    rootRecords.push(row('event_msg', { type: 'user_message', message: 'Required parent changed during read' }));
    write('root', rootRecords);
  };
  const changedParent = await request(legacy);
  assert.equal(changedParent.status, 409);
  assert.equal(changedParent.data.code, 'stale_content');

  afterContentRead = () => unlinkSync(path.join(sessions, 'child.jsonl'));
  const removedSource = await request(child);
  assert.equal(removedSource.status, 409);
  assert.equal(removedSource.data.code, 'stale_content');
});
