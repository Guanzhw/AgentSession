import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readerRailEdgePriority, readerRailIntersectsBand, readerRailTrackSegments, readerRailSlots } from '../src/static/app/reader-member-rails.js';

test('paired rail edges remain drawable when their endpoints straddle the viewport band', () => {
  assert.equal(readerRailIntersectsBand(20, 980, 300, 700), true);
  assert.equal(readerRailIntersectsBand(980, 20, 300, 700), true);
  assert.equal(readerRailIntersectsBand(20, 299, 300, 700), false);
  assert.equal(readerRailIntersectsBand(701, 980, 300, 700), false);
  assert.equal(readerRailIntersectsBand(300, 700, 300, 700), true);
});

test('a member rail stops at its last recorded interaction', () => {
  assert.equal(readerRailTrackSegments(100, 120, 500, 900), null);
  assert.deepEqual(readerRailTrackSegments(100, 120, 100, 900), [100, 120]);
  assert.deepEqual(readerRailTrackSegments(100, 900, 500, 700), [500, 700]);
  assert.equal(readerRailTrackSegments(950, 980, 500, 900), null);
});

test('an actual viewport event outranks a long edge crossing from old history', () => {
  assert.equal(readerRailEdgePriority(500, 500, 300, 700), 0);
  assert.equal(readerRailEdgePriority(20, 980, 300, 700), 1);
  assert.ok(readerRailEdgePriority(100, 120, 300, 700) > 1);
});

test('nearby event priority changes membership without shifting retained lanes', () => {
  const first = readerRailSlots(['a', 'b', 'c', 'd']);
  assert.deepEqual([...first], [['a', 0], ['b', 1], ['c', 2], ['d', 3]]);
  const next = readerRailSlots(['e', 'b', 'c', 'd'], first);
  assert.deepEqual([...next], [['b', 1], ['c', 2], ['d', 3], ['e', 0]]);
  assert.deepEqual([...readerRailSlots(['b', 'e', 'c', 'd'], next)], [...next]);
});

test('a focused peer edge reserves both endpoints even at four-lane capacity', () => {
  const initial = readerRailSlots(['a', 'b', 'c', 'd']);
  const focused = readerRailSlots(['peer-sender', 'peer-receiver', 'b', 'c', 'd'], initial);
  assert.equal(focused.size, 4);
  assert.equal(focused.has('peer-sender'), true);
  assert.equal(focused.has('peer-receiver'), true);
  assert.equal(focused.get('b'), initial.get('b'));
  assert.equal(focused.get('c'), initial.get('c'));
});

test('rail card styling targets its own milestone body, not an attached child pane', () => {
  const css = readFileSync(new URL('../src/static/reader.css', import.meta.url), 'utf8');
  const railSection = css.slice(css.indexOf('/* Member rails are a narrow reading annotation'));
  assert.match(railSection, /\[data-reader-member-rails-shown\] > \.reader-milestone-body/);
  assert.doesNotMatch(railSection, /\[data-reader-member-rails-active="true"\] \[data-reader-member-rails-event\]/);
});
