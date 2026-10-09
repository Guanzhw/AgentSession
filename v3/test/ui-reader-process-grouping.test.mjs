import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(new URL('../ui/package.json', import.meta.url));
const { createServer } = require('vite');
const item = (ordinal, segment, processId = null, processCount = null, role = 'assistant') => ({
  ordinal, processId, processCount, role,
  event: { provider: 'codex', sessionId: 'parent', messageId: String(ordinal), segment },
  preview: segment, totalChars: segment.length, owner: null,
});
const display = item => ({ item, key: String(item.ordinal), anchor: String(item.ordinal) });

test('adjacent hidden work shares one disclosure without merging replies, checkpoints or pagination gaps', async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../ui/', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  try {
    const { groupReaderItems, groupReaderProcesses } = await server.ssrLoadModule('/src/lib/reader-presentation.ts');
    const group = items => groupReaderProcesses(groupReaderItems(items, display));
    const units = group([
      item(0, 'thinking'), item(1, 'tool', 1, 2, 'tool'), item(2, 'tool', 1, 2, 'tool'),
      item(3, 'thinking'), item(4, 'thinking'), item(5, 'message', null, null, 'agent'),
      item(6, 'thinking'), item(7, 'context'), item(8, 'thinking'), item(10, 'thinking'),
    ]);
    assert.deepEqual(units.map(unit => unit.count), [5, 1, 1, 1, 1, 1]);
    assert.equal(units[0].totalCount, 5, 'process count counted once alongside standalone thoughts');
    assert.equal(units[1].blocks[0].main.item.role, 'agent');
    assert.equal(units[3].blocks[0].main.item.event.segment, 'context');
    const paged = group([item(0, 'tool', 0, 4, 'tool'), item(1, 'tool', 0, 4, 'tool')]);
    assert.equal(paged[0].count, 2);
    assert.equal(paged[0].totalCount, 4, 'full recorded process count survives partially loaded page');
  } finally { await server.close(); }
});
