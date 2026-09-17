import assert from 'node:assert/strict';
import test from 'node:test';
import { groupActivityPoints, initReaderActivity, loadReaderActivity } from '../src/static/app/reader-activity.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const response = (html) => ({ ok: true, json: async () => ({ html }) });

function loadingHarness(t) {
  const attributes = new Map();
  const status = { hidden: true, textContent: '' };
  const retry = { hidden: true };
  const content = {
    innerHTML: '',
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    querySelector: () => null
  };
  const events = [];
  const host = {
    dataset: { readerActivityHost: '/api/fixture/session/root/reader/activity', loadingLabel: 'Loading', errorLabel: 'Failed' },
    querySelector: (selector) => ({
      '[data-reader-activity-status]': status,
      '[data-reader-activity-view]': content,
      '[data-reader-activity-retry]': retry
    })[selector] || null,
    dispatchEvent: (event) => events.push(event)
  };
  const overview = { querySelector: (selector) => selector === '[data-reader-activity-host]' ? host : null };
  host.closest = (selector) => selector === '[data-reader-collaboration-overview]' ? overview : null;
  retry.closest = (selector) => ({ '[data-reader-activity-host]': host, '[data-reader-activity-retry]': retry })[selector] || null;
  const listeners = new Map();
  const workbench = { addEventListener: (type, listener) => listeners.set(type, listener) };
  const requests = [];
  const globals = {
    fetch(url, options) {
      const pending = deferred();
      requests.push({ url, options, ...pending });
      return pending.promise;
    },
    CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    document: { querySelector: () => workbench },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  return { overview, host, status, retry, content, attributes, events, requests, listeners };
}

test('close completion and receipt points retain distinct records through geometric grouping', () => {
  const points = [
    { id: 'dispatch', position: 0 },
    { id: 'child-complete', position: 34, source: 'child/event:complete' },
    { id: 'parent-receipt', position: 34.172833, source: 'parent/event:receipt' },
    { id: 'follow-up', position: 80 }
  ];
  const snapshot = JSON.stringify(points);
  const groups = groupActivityPoints(points, 360);
  assert.deepEqual(groups.map((group) => group.points.map((point) => point.id)), [
    ['dispatch'], ['child-complete', 'parent-receipt'], ['follow-up']
  ]);
  assert.deepEqual(groups.flatMap((group) => group.points), points);
  assert.equal(groups[1].points[0], points[1]);
  assert.equal(groups[1].points[1].source, 'parent/event:receipt');
  assert.equal(JSON.stringify(points), snapshot);
});

test('resizing only regroups geometry and preserves every event in input order', () => {
  const points = Array.from({ length: 30 }, (_, index) => ({ id: `event-${index}`, position: index * 3 }));
  for (const width of [180, 360, 1080]) {
    const groups = groupActivityPoints(points, width);
    assert.deepEqual(groups.flatMap((group) => group.points.map((point) => point.id)), points.map((point) => point.id));
    for (const group of groups) {
      const positions = group.points.map((point) => point.position / 100 * width);
      assert.ok(group.x >= Math.min(...positions) && group.x <= Math.max(...positions));
    }
  }
  assert.deepEqual(groupActivityPoints([], 360), []);
});

test('a selected close-event cluster exposes every record and its distinct source in the caption', async (t) => {
  const h = loadingHarness(t);
  const buttons = [];
  const caption = { replaceChildren(list) { this.list = list; } };
  const sources = ['/fixture/session/child?readerEvent=complete', '/fixture/session/root?readerEvent=receipt'];
  const records = ['child-complete', 'parent-receipt'].map((id, index) => ({
    dataset: { pointId: id, pointX: String(34 + index * .172833),
      pointKind: index ? 'result-delivery' : 'child-turn-completed', pointLabel: id },
    source: sources[index],
    cloneNode(deep) {
      assert.equal(deep, true);
      return { dataset: { ...this.dataset }, source: this.source };
    }
  }));
  const track = {
    clientWidth: 360, contains: () => false,
    querySelectorAll: () => [...buttons],
    append(button) { buttons.push(button); }
  };
  const lane = { querySelector: (selector) => ({
    '[data-reader-activity-track]': track,
    '[data-reader-activity-records]': { children: records },
    '.reader-activity-lane-name': { textContent: 'Reviewer' }
  })[selector] };
  const root = {
    dataset: { readerActivitySelected: 'child-complete', readerActivityClusterLabel: '{count} nearby records' },
    querySelectorAll: (selector) => selector === '[data-reader-activity-lane]' ? [lane] : buttons,
    querySelector: () => caption
  };
  document.createElement = () => ({
    dataset: {}, style: {}, attributes: new Map(), children: [],
    setAttribute(name, value) { this.attributes.set(name, value); },
    append(child) { this.children.push(child); },
    remove() { buttons.splice(buttons.indexOf(this), 1); }
  });
  h.content.querySelector = () => root;
  const load = loadReaderActivity(h.overview);
  h.requests[0].resolve(response('server activity markup'));
  await load;
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].textContent, '2');
  assert.equal(buttons[0].attributes.get('aria-pressed'), 'true');
  assert.match(buttons[0].attributes.get('aria-label'), /2 nearby records/);
  assert.deepEqual(caption.list.children.map((record) => record.dataset.pointId), ['child-complete', 'parent-receipt']);
  assert.deepEqual(caption.list.children.map((record) => record.source), sources);
  assert.notEqual(caption.list.children[0], records[0]);
});

test('an older activity window cannot overwrite a newer selection or clear its busy state', async (t) => {
  const h = loadingHarness(t);
  const first = loadReaderActivity(h.overview, { from: '600000' });
  const second = loadReaderActivity(h.overview, { from: '1200000' });
  h.requests[0].resolve(response('old window'));
  await first;
  assert.equal(h.content.innerHTML, '');
  assert.equal(h.attributes.get('aria-busy'), 'true');
  assert.deepEqual(h.events, []);
  h.requests[1].resolve(response('new window'));
  await second;
  assert.equal(h.content.innerHTML, 'new window');
  assert.equal(h.host.dataset.activityQuery, 'from=1200000');
  assert.equal(h.attributes.has('aria-busy'), false);
  assert.deepEqual(h.events.map((event) => event.type), ['reader-activity:before-replace', 'reader-activity:loaded']);
});

test('late failure cannot replace a successful newer activity window', async (t) => {
  const h = loadingHarness(t);
  const first = loadReaderActivity(h.overview, { from: '600000' });
  const second = loadReaderActivity(h.overview, { from: '1200000' });
  h.requests[1].resolve(response('current'));
  await second;
  h.requests[0].reject(new Error('old network error'));
  await first;
  assert.equal(h.content.innerHTML, 'current');
  assert.equal(h.status.hidden, true);
  assert.equal(h.retry.hidden, true);
  assert.deepEqual(h.events.map((event) => event.type), ['reader-activity:before-replace', 'reader-activity:loaded']);
});

test('reopening shares an initial load and explicit retry restarts a stale page at its window', async (t) => {
  const h = loadingHarness(t);
  initReaderActivity();
  const first = loadReaderActivity(h.overview);
  await loadReaderActivity(h.overview);
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve(response('initial'));
  await first;
  const stale = loadReaderActivity(h.overview, { from: '1200000', offset: '100', revision: 'old' });
  h.requests[1].resolve({ ok: false, status: 409 });
  await stale;
  assert.equal(h.content.innerHTML, 'initial');
  assert.equal(h.retry.hidden, false);
  assert.match(h.status.textContent, /HTTP 409/);
  assert.equal(h.attributes.has('aria-busy'), false);
  h.listeners.get('click')({ target: h.retry });
  assert.equal(h.requests.length, 3);
  const url = new URL(h.requests[2].url, 'http://localhost');
  assert.equal(url.searchParams.get('from'), '1200000');
  assert.equal(url.searchParams.has('offset'), false);
  assert.equal(url.searchParams.has('revision'), false);
  h.requests[2].resolve(response('refreshed first page'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.content.innerHTML, 'refreshed first page');
  assert.equal(h.retry.hidden, true);
  assert.equal(h.status.hidden, true);
});
