import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureReaderSegmentAnchor } from '../src/static/app/reader-segments.js';

test('later message and deep part anchors load one owned fragment and retain canonical lookup', async (t) => {
  let loaded = false;
  const events = [];
  const target = { id: 'part-late-source', closest: () => pane };
  const button = { disabled: false, setAttribute() {}, removeAttribute() {} };
  const status = { textContent: '' };
  const segment = {
    dataset: {
      readerSegmentState: 'unloaded', readerSegmentIndex: '1',
      readerSegmentUrl: '/api/fixture/session/root/reader/segment?index=1&revision=123',
      readerSegmentAnchors: 'msg-late-source', readerSegmentLoading: 'Loading',
      readerSegmentFailed: 'Retry', readerSegmentChanged: 'Reload'
    },
    isConnected: true,
    closest: () => pane,
    querySelector: (selector) => selector === '[data-reader-segment-load]' ? button : status,
    setAttribute() {}, removeAttribute() {},
    classList: { remove() {} },
    set innerHTML(value) { assert.equal(value, '<article id="part-late-source"></article>'); loaded = true; },
    dispatchEvent: (event) => events.push(event)
  };
  const pane = {
    dataset: { readerProvider: 'fixture', readerSession: 'root' }, isConnected: true,
    querySelectorAll: (selector) => selector === '[data-reader-conversation-segment]' ? [segment]
      : loaded ? [target] : []
  };
  const originalCss = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { escape: (value) => value } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: null } });
  t.after(() => {
    if (originalCss) Object.defineProperty(globalThis, 'CSS', originalCss); else delete globalThis.CSS;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else delete globalThis.document;
  });
  t.mock.method(globalThis, 'fetch', async (url) => url.includes('segment-location')
    ? { ok: true, json: async () => ({ ok: true, index: 1 }) }
    : { ok: true, json: async () => ({ ok: true, index: 1, html: '<article id="part-late-source"></article>' }) });
  assert.equal(await ensureReaderSegmentAnchor(pane, 'part-late-source'), target);
  assert.equal(segment.dataset.readerSegmentState, 'loaded');
  assert.equal(events[0].type, 'session-reader:segment-loaded');
  assert.equal(await ensureReaderSegmentAnchor(pane, 'part-late-source'), target);
  assert.equal(globalThis.fetch.mock.callCount(), 2, 'locator and fragment are each requested once');
});
