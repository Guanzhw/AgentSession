import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { derivePublicSearchMatches, verifyPublicSearchMatches } from '../scripts/v3-public-search-oracle.mjs';

const source = JSON.parse(await readFile(new URL('./fixtures/v3-search-oracle/source.json', import.meta.url), 'utf8'));
const expected = JSON.parse(await readFile(new URL('./fixtures/v3-search-oracle/expected.json', import.meta.url), 'utf8'));
const verify = matches => verifyPublicSearchMatches(source, expected, matches);

test('handwritten source expectations cover priority, first hit, tie order, AND, NUL and emoji', () => {
  assert.deepEqual(derivePublicSearchMatches(source), expected.matches);
  assert.equal(verify(structuredClone(expected.matches)).passed, true);
  assert.deepEqual(expected.matches.map(row => row.session.sessionId), ['alpha', 'beta', 'gamma']);
  assert.equal(expected.matches[0].event, null);
  assert.equal(expected.matches[1].event.messageId, 'beta-first');
  assert.equal(expected.matches[2].snippet, 'Alpha\0middle 🙂 OMEGA');
  assert.equal(verify(expected.matches).privateGoldenVerified, false);
});

test('rejects deletion of a complete matching session', () => {
  assert.equal(verify(expected.matches.slice(0, -1)).passed, false);
});

test('rejects swapping equal-time rows', () => {
  const rows = structuredClone(expected.matches);
  [rows[1], rows[2]] = [rows[2], rows[1]];
  assert.equal(verify(rows).passed, false);
});

test('rejects snippet mutation including NUL loss', () => {
  const rows = structuredClone(expected.matches);
  rows[2].snippet = rows[2].snippet.replace('\0', '');
  assert.equal(verify(rows).passed, false);
});

test('rejects later same-session hit and source drift', () => {
  const rows = structuredClone(expected.matches);
  rows[1].event.messageId = 'beta-second';
  assert.equal(verify(rows).passed, false);
  const changed = structuredClone(source);
  changed.sessions[0].messages[0].text = 'missing terms';
  assert.throws(() => verifyPublicSearchMatches(changed, expected, expected.matches), /expectation disagree/);
});
