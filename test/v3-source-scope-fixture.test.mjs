import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('./fixtures/v3-source-scope/', import.meta.url));
const shared = '11111111-1111-4111-8111-111111111111';

function sessions(side) {
  const directory = path.join(root, side, 'sessions', '2026', '09', '26');
  return readdirSync(directory).map(name => {
    const file = path.join(directory, name);
    const raw = readFileSync(file, 'utf8');
    const records = raw.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(records[0].type, 'session_meta');
    const id = records[0].payload.id;
    const messages = records.filter(record => record.type === 'event_msg')
      .map(record => record.payload);
    return { id, raw, messages };
  });
}

test('source-scope corpus has one overlapping canonical ID with different source facts and one unique ID per root', () => {
  const left = sessions('left');
  const right = sessions('right');
  assert.equal(left.length, 2);
  assert.equal(right.length, 2);
  assert.deepEqual(left.map(item => item.id).sort(), [shared, '22222222-2222-4222-8222-222222222222'].sort());
  assert.deepEqual(right.map(item => item.id).sort(), [shared, '33333333-3333-4333-8333-333333333333'].sort());
  const l = left.find(item => item.id === shared);
  const r = right.find(item => item.id === shared);
  assert.deepEqual(l.messages.map(item => item.type), ['user_message', 'agent_message']);
  assert.deepEqual(r.messages.map(item => item.type), ['user_message', 'agent_message']);
  assert.equal(l.messages[1].message, 'left source answer');
  assert.equal(r.messages[1].message, 'right source answer');
  assert.notEqual(l.raw, r.raw);
});
