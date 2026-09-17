import assert from 'node:assert/strict';
import test from 'node:test';
import { renderReaderActivity } from '../dist/src/views/reader-activity.js';
import { setLocale } from '../dist/src/i18n.js';

const start = Date.parse('2026-09-10T15:30:00.000Z');
const windowMs = 600000;
function fixture() {
  return {
    provider: 'fixture', sessionId: 'root/session', parentLaneId: 'parent:fixture:root/session', windowMs,
    range: { start, end: start + windowMs }, extent: { start, end: start + 300000 },
    lanes: [
      { id: 'parent:fixture:root/session', name: null, childSession: null,
        span: { start: start + 27073, end: start + 27073 }, points: [
          { id: 'main:text', kind: 'parent-text', timestamp: start + 27073,
            source: { provider: 'fixture', sessionId: 'root/session', anchor: 'part-main-text' },
            excerpt: '<script>alert("prose")</script> & still readable' }
        ] },
      { id: 'child:fixture:child/a', name: 'Reviewer <img src=x onerror="bad()">',
        childSession: { provider: 'fixture', sessionId: 'child/a' },
        span: { start: start - 60000, end: start + 205037 }, points: [
          { id: 'child-complete', kind: 'child-turn-completed', timestamp: start + 204000,
            source: { provider: 'fixture', sessionId: 'child/a', eventId: 'event:turn:task_complete:104' } },
          { id: 'parent-receipt', kind: 'result-delivery', timestamp: start + 205037,
            source: { provider: 'fixture', sessionId: 'root/session', eventId: 'event:result:receipt&1', anchor: 'milestone-receipt' } }
        ] }
    ],
    coverage: { textParts: 1, observations: 7, ordinaryMessages: 5, untimedTextParts: 0,
      untimedObservations: 0, unassignedObservations: 0, missingSourceObservations: 0,
      totalLanes: 2, windowLanes: 2, windowPoints: 3, returnedLanes: 2, returnedPoints: 3 },
    offset: 0, nextOffset: null, revision: 'a'.repeat(64), anchor: { id: 'parent-receipt', timestamp: start + 205037, state: 'located' }
  };
}

test('activity records keep exact main and external-child source owners and escaped text', () => {
  const view = fixture();
  const original = JSON.stringify(view);
  const html = renderReaderActivity(view);
  assert.match(html, /href="\/fixture\/session\/root%2Fsession#part-main-text"/);
  assert.match(html, /href="\/fixture\/session\/child%2Fa\?readerEvent=event%3Aturn%3Atask_complete%3A104"/);
  assert.match(html, /href="\/fixture\/session\/root%2Fsession#milestone-receipt"/);
  assert.match(html, /data-reader-anchor="milestone-receipt"/);
  assert.match(html, /data-point-id="child-complete"/);
  assert.match(html, /data-point-id="parent-receipt"/);
  assert.equal((html.match(/<li data-reader-activity-point /g) || []).length, 3);
  assert.match(html, /&lt;script&gt;alert\(&quot;prose&quot;\)&lt;\/script&gt; &amp; still readable/);
  assert.match(html, /Reviewer &lt;img src=x onerror=&quot;bad\(\)&quot;&gt;/);
  assert.doesNotMatch(html, /<script|<img/);
  assert.equal(JSON.stringify(view), original);
});

test('activity window exposes exact clocks, selected record, bounded coverage and continuation identity', () => {
  const view = fixture();
  view.offset = 100;
  view.nextOffset = 200;
  view.coverage.windowPoints = 203;
  view.coverage.returnedPoints = 100;
  view.coverage.returnedLanes = 1;
  const lane = view.lanes[1];
  lane.points.unshift(...Array.from({ length: 98 }, (_, index) => ({
    id: `followup-${index}`, kind: 'follow-up', timestamp: start + index * 1000,
    source: { provider: 'fixture', sessionId: 'root/session', eventId: `event:followup-${index}` }
  })));
  view.lanes = [lane];
  const html = renderReaderActivity(view);
  assert.match(html, /data-reader-activity-selected="parent-receipt"/);
  assert.match(html, /datetime="2026-09-10T15:33:24.000Z"/);
  assert.match(html, /datetime="2026-09-10T15:33:25.037Z"/);
  assert.match(html, /15:30–15:40 UTC/);
  assert.match(html, /This page: 100 of 203 records, 1 of 2 lanes/);
  assert.match(html, /5 ordinary messages remain in process details/);
  assert.match(html, new RegExp(`data-reader-activity-page="200" data-reader-activity-from="${start}" data-reader-activity-revision="${view.revision}"`));
  assert.match(html, /First page of this window/);
  assert.match(html, /data-reader-activity-selection aria-live="polite"/);
});

test('empty and untimed histories retain explicit coverage instead of a fabricated time axis', () => {
  const view = fixture();
  view.range = null;
  view.extent = null;
  view.lanes = [];
  view.anchor = null;
  Object.assign(view.coverage, { textParts: 2, untimedTextParts: 2, untimedObservations: 3,
    unassignedObservations: 1, missingSourceObservations: 2, windowLanes: 0, windowPoints: 0, returnedLanes: 0, returnedPoints: 0 });
  const html = renderReaderActivity(view);
  assert.match(html, /No timed activity was recorded/);
  assert.match(html, /5 untimed, 1 unassigned, 2 missing a source/);
  assert.doesNotMatch(html, /data-reader-activity-window|data-reader-activity-point|1970/);
});

test('an empty selected window and an untimed anchor remain distinguishable', () => {
  const view = fixture();
  view.lanes = [];
  view.anchor = { id: 'untimed', timestamp: null, state: 'untimed' };
  Object.assign(view.coverage, { untimedObservations: 1, windowLanes: 0, windowPoints: 0, returnedLanes: 0, returnedPoints: 0 });
  const html = renderReaderActivity(view);
  assert.match(html, /No recorded activity in this window/);
  assert.match(html, /This record has no timestamp/);
  assert.match(html, /data-reader-activity-window/);
  assert.doesNotMatch(html, /No timed activity was recorded/);
});

test('activity captions and coverage render in Chinese without untranslated keys', (t) => {
  setLocale('zh');
  t.after(() => setLocale('en'));
  const view = fixture();
  view.lanes[1].points.push({
    id: 'parent-wait', kind: 'wait', timestamp: start + 206000,
    source: { provider: 'fixture', sessionId: 'root/session', eventId: 'event:wait' }
  });
  view.coverage.observations += 1;
  view.coverage.windowPoints += 1;
  view.coverage.returnedPoints += 1;
  const html = renderReaderActivity(view);
  assert.match(html, /同期活动/);
  assert.match(html, /主会话/);
  assert.match(html, /记录覆盖范围/);
  assert.match(html, /等待/);
  assert.doesNotMatch(html, /detail\.activity_|conversation\.channel_/);
});
