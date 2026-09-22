import test from 'node:test';
import assert from 'node:assert/strict';
import { readerRailIntersectsBand, readerRailTrackSegments } from '../src/static/app/reader-member-rails.js';

test('paired rail edges remain drawable when their endpoints straddle the viewport band', () => {
  assert.equal(readerRailIntersectsBand(20, 980, 300, 700), true);
  assert.equal(readerRailIntersectsBand(980, 20, 300, 700), true);
  assert.equal(readerRailIntersectsBand(20, 299, 300, 700), false);
  assert.equal(readerRailIntersectsBand(701, 980, 300, 700), false);
  assert.equal(readerRailIntersectsBand(300, 700, 300, 700), true);
});

test('a member rail continues as unknown after its last recorded observation', () => {
  assert.deepEqual(readerRailTrackSegments(100, 120, 500, 900), {
    solid: null,
    unknown: [500, 900]
  });
  assert.deepEqual(readerRailTrackSegments(100, 120, 100, 900), {
    solid: [100, 148],
    unknown: [148, 900]
  });
  assert.equal(readerRailTrackSegments(950, 980, 500, 900), null);
});
