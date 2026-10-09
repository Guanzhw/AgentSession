import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveV3SearchExpectations } from '../scripts/v3-verify-search-v3-golden.mjs';

const ref = id => ({ provider: 'codex', sessionId: id });
const match = (id, role, messageId, text) => ({
  session: ref(id), event: { ...ref(id), messageId, segment: 'message' },
  matchField: 'message', matchRole: role, snippet: text,
  title: id, directory: '/work', updatedAt: 10, untrustedContent: true
});
const queries = [
  { label: 'agent', querySha256: 'a'.repeat(64), fields: ['assistant'], providers: ['codex'], limit: 20 },
  { label: 'missing', querySha256: 'b'.repeat(64), fields: ['user', 'assistant'], providers: ['codex'], limit: 20 },
  { label: 'metadata', querySha256: 'c'.repeat(64), query: '/work', fields: ['title', 'directory'], providers: ['codex', 'opencode'], limit: 20 },
  { label: 'tool', querySha256: 'd'.repeat(64), fields: ['toolName'], providers: ['codex', 'opencode'], limit: 20 }
];
const manifest = { queries, updatedBeforeUnixMs: 100 };
const unique = { metadata: { provider: 'codex', sessionId: 'unique', title: 'unique', directory: '/work', updatedAt: 10 },
  projection: { complete: true, matches: { agent: match('unique', 'agent', 'recorded-result', 'agent result'),
    missing: null, tool: null } } };
const oldCollision = { metadata: { provider: 'codex', sessionId: 'collision', title: 'old fragment', directory: '/old', updatedAt: 20 },
  projection: { complete: true, matches: { agent: match('collision', 'assistant', 'old', 'old fragment'), missing: null, tool: null } } };
const direct = { metadata: { provider: 'codex', sessionId: 'direct', title: 'direct', directory: '/work', updatedAt: 11 },
  projection: { complete: true, matches: { agent: match('direct', 'agent', 'direct-result', 'direct result'), missing: null, tool: null } } };
const facts = {
  codexProjections: [unique, oldCollision,
    { metadata: { ...direct.metadata, title: 'old direct fragment' }, projection: { complete: true, matches: {} } },
    { metadata: { provider: 'codex', sessionId: 'unresolved', title: 'old unresolved fragment', directory: null, updatedAt: 13 }, projection: { complete: true, matches: {} } }],
  duplicateMetadata: [{ provider: 'codex', sessionId: 'collision' }, { provider: 'codex', sessionId: 'direct' },
    { provider: 'codex', sessionId: 'unresolved' }],
  metadata: [unique.metadata, oldCollision.metadata, { provider: 'opencode', sessionId: 'other',
    title: 'other', directory: '/work', updatedAt: 12 }],
  toolSources: { opencode: [], small: { hits: [] } }
};
const sourceSets = { direct: [direct], unresolved: [
  { sessionId: 'collision', directory: '/work' }, { sessionId: 'unresolved', directory: null }
] };

test('3.0 source expectations include agent replies, direct history and unresolved metadata', () => {
  const expected = deriveV3SearchExpectations(manifest, facts, sourceSets);
  assert.deepEqual(expected.coverage, { status: 'partial', unresolvedCodexGroups: 2, directCodexPairs: 1 });
  assert.deepEqual(expected.queries[0].matches.map(row => [row.session.sessionId, row.matchRole]),
    [['direct', 'agent'], ['unique', 'agent']]);
  assert.equal(expected.queries[1].count, 0);
  assert.equal(expected.queries[2].count, 4);
  assert.equal(expected.queries[2].coverage, 'partial-unresolved-metadata');
  assert.equal(expected.queries[2].unknownMatches.length, 1);
  assert.equal(expected.queries[2].unknownMatches[0].title, 'collision');
  assert.equal(Object.hasOwn(expected.queries[2].unknownMatches[0], 'updatedAt'), false);
  assert.ok(expected.queries[2].knownMatches.every(row => row.title !== 'old fragment'));
  assert.deepEqual(expected.queries[0].diagnostics, [{ provider: 'codex', status: 'partial' }]);
  assert.deepEqual(expected.queries[3].diagnostics, [
    { provider: 'codex', status: 'partial' }, { provider: 'opencode', status: 'ok' }
  ]);
  assert.ok(expected.queries.filter(row => row.coverage !== 'partial-unresolved-metadata')
    .every(row => /^[0-9a-f]{64}$/.test(row.orderedSemanticSha256)));
  assert.equal(Object.hasOwn(expected.queries[2], 'orderedSemanticSha256'), false);
});

test('3.0 source expectations reject missing source-set adjudication', () => {
  assert.throws(() => deriveV3SearchExpectations(manifest, facts, { direct: [], unresolved: [] }),
    /SourceSetCoverageMismatch/);
});
