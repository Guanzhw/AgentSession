import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { compareSourceGoldRow } from '../scripts/v3-bench-source-gold.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const query = { label: 'synthetic', query: 'needle', querySha256: sha('needle') };
const known = [{ session: { provider: 'codex', sessionId: 'known' }, title: 'found' }];
const unknownA = { session: { provider: 'codex', sessionId: 'a' }, title: 'A', directory: 'root',
  matchField: 'title', event: null, matchRole: null, updatedAt: 1 };
const unknownB = { session: { provider: 'codex', sessionId: 'b' }, title: 'B', directory: 'root',
  matchField: 'directory', event: null, matchRole: null, updatedAt: 2 };
const diagnostics = [{ provider: 'codex', status: 'partial' }];

test('source gold checks complete ordered content and first page', () => {
  const expected = { ...query, count: 1, coverage: 'partial-unresolved-content', matches: known,
    firstPageSemanticSha256: 'page', diagnostics };
  const row = { matches: known, pages: [{ semanticHash: 'page' }], diagnostics: ['codex:partial'] };
  assert.equal(compareSourceGoldRow(row, expected, query).passed, true);
  assert.equal(compareSourceGoldRow({ ...row, pages: [{ semanticHash: 'changed' }] }, expected, query).passed, false);
  assert.equal(compareSourceGoldRow({ ...row, diagnostics: ['codex:ok'] }, expected, query).passed, false);
});

test('metadata gold checks known order and distinct source-proven unknown fields', () => {
  const secondKnown = { session: { provider: 'pi', sessionId: 'known-2' }, title: 'next' };
  const expected = { ...query, count: 4, coverage: 'partial-unresolved-metadata',
    knownMatches: [known[0], secondKnown], unknownMatches: [unknownA, unknownB], diagnostics };
  const row = { matches: [known[0], { ...unknownA, updatedAt: 999 }, secondKnown,
    { ...unknownB, updatedAt: 1000 }], pages: [], diagnostics: ['codex:partial'] };
  const comparison = compareSourceGoldRow(row, expected, query);
  assert.equal(comparison.passed, true);
  assert.equal(comparison.unknownTimestampUnverified, true);
  assert.equal(compareSourceGoldRow({ ...row, matches: [secondKnown, ...row.matches.slice(0, 2), unknownB] },
    expected, query).passed, false);
  assert.equal(compareSourceGoldRow({ ...row, matches: [known[0], unknownA, secondKnown, unknownA] },
    expected, query).passed, false);
  assert.equal(compareSourceGoldRow({ ...row, matches: [known[0], unknownA, secondKnown,
    { ...unknownB, directory: 'different' }] }, expected, query).passed, false);
});
