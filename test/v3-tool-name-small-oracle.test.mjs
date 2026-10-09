import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeToolNames, piToolNames, dshToolHit } from '../scripts/v3-tool-name-small-oracle.mjs';

test('Claude source tool names include call and result shapes, but not body mentions', () => {
  const names = claudeToolNames([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'please read' }, { type: 'tool_use', id: 'call', name: 'Read' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call' }] } },
    { type: 'tool_use', name: 'write' },
    { type: 'tool_result', tool_name: 'read_file' }
  ]);
  assert.deepEqual(names, ['Read', 'tool_result', 'write', 'read_file']);
});

test('Pi tool names follow the selected branch and include orphan results and bash', () => {
  const names = piToolNames([
    { type: 'session', version: 3, id: 'pi' },
    { type: 'message', id: 'a', parentId: null, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'one', name: 'read' }] } },
    { type: 'message', id: 'b', parentId: null, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'two', name: 'write' }] } },
    { type: 'message', id: 'c', parentId: 'b', message: { role: 'toolResult', toolName: 'fetch' } },
    { type: 'message', id: 'd', parentId: 'c', message: { role: 'bashExecution' } }
  ]);
  assert.deepEqual(names, ['write', 'fetch', 'bash']);
});

test('DSH selects owned durable assistant call and derives the full search hit', () => {
  const result = dshToolHit([
    { type: 'session', id: 'session-1', version: 3, cwd: 'D:/project', createdAt: 100, isSeeded: true },
    { type: 'assistant/message', seq: 1, surfaceOp: 'append', time: 110, data: { message: { content: [{ type: 'tool-call', id: 'inherited', name: 'read' }] } } },
    { type: 'session/end-seed', seq: 2, data: { inherited: true } },
    { type: 'session/title', seq: 3, time: 120, data: { title: '  Session title  ' } },
    { type: 'assistant/message', seq: 4, surfaceOp: 'append', time: 130, data: { message: { content: [{ type: 'tool-call', id: 'owned', name: 'read' }] } } },
    { type: 'tool/call', seq: 5, time: 131, data: { callId: 'owned', name: 'read' } }
  ]);
  assert.equal(result.first.seq, 4);
  assert.deepEqual(result.hit, {
    session: { provider: 'deepseek-harness', sessionId: 'session-1' },
    event: { provider: 'deepseek-harness', sessionId: 'session-1', messageId: 'owned', segment: 'tool' },
    matchField: 'toolName', matchRole: 'tool', snippet: 'read', title: 'Session title',
    directory: 'D:/project', updatedAt: 131, untrustedContent: true
  });
  assert.equal(dshToolHit([
    { type: 'session', id: 'session-1', version: 3, createdAt: 100, isSeeded: false },
    { type: 'assistant/message', seq: 1, time: 110, data: { message: { content: [{ type: 'tool-call', id: 'call', name: 'write' }] } } }
  ]).hit, null);
});
