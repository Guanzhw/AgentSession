import assert from 'node:assert/strict';
import test from 'node:test';
import { loadProgressiveContent, selectVisibleSearchHit } from '../src/static/app/session-workbench.js';

test('search selection uses source occurrence identity only for plain rendered fields', () => {
  const hits = [{ id: 'first' }, { id: 'second' }, { id: 'third' }];
  assert.equal(selectVisibleSearchHit({ format: 'plain', matchIndex: 1 }, hits), hits[1]);
  assert.equal(selectVisibleSearchHit({ format: 'markdown', matchIndex: 1 }, hits), null, 'Markdown source syntax is not a rendered ordinal guarantee');
  assert.equal(selectVisibleSearchHit({ format: 'plain', matchIndex: 4 }, hits), null);
});

test('shared progressive request releases a detached cached pane for retry', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let finishResponse;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    return new Promise((resolve) => { finishResponse = resolve; });
  };
  const pane = { dataset: { readerProvider: 'fixture', readerSession: 'child' }, isConnected: true };
  let activePane = pane;
  const workbench = { dataset: { provider: 'fixture', sessionId: 'parent' }, querySelector: () => activePane };
  const attributes = new Map();
  const button = {
    dataset: { partId: 'child-tool', field: 'output', nextOffset: '3000' },
    disabled: false,
    isConnected: true,
    closest(selector) {
      if (selector === '.progressive') return { querySelector: () => null };
      if (selector === '.session-workbench') return workbench;
      if (selector === '[data-reader-pane]') return pane;
      throw new Error(`Unexpected selector ${selector}`);
    },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.get(name) ?? null; }
  };
  const manual = loadProgressiveContent(button);
  const search = loadProgressiveContent(button, { dispatch: false });
  assert.equal(calls, 1, 'manual and search share one in-flight continuation');
  assert.equal(button.disabled, true);
  assert.equal(attributes.get('aria-busy'), 'true');
  button.isConnected = false;
  activePane = null;
  finishResponse({ ok: true, json: async () => ({ ok: true, html: '<pre>late content</pre>', nextOffset: 6000 }) });
  await Promise.all([manual, search]);
  assert.equal(button.disabled, false, 'Back must restore a usable Show more button');
  assert.equal(attributes.has('aria-busy'), false);
  assert.equal(button.dataset.nextOffset, '3000', 'discarded response does not advance the content cursor');

  // The cached pane can retry after returning; detach again before completion
  // to keep this state test independent of browser rendering implementation.
  button.isConnected = true;
  activePane = pane;
  const retry = loadProgressiveContent(button);
  assert.equal(calls, 2);
  button.isConnected = false;
  activePane = null;
  finishResponse({ ok: true, json: async () => ({ ok: true, html: '<pre>retried content</pre>', nextOffset: 6000 }) });
  await retry;
  assert.equal(button.disabled, false);
});

test('progressive content commits to a connected inline child even when it is not the root pane', async (t) => {
  const originalDocument = globalThis.document;
  const originalCustomEvent = globalThis.CustomEvent;
  t.after(() => {
    if (originalDocument) globalThis.document = originalDocument;
    else delete globalThis.document;
    if (originalCustomEvent) globalThis.CustomEvent = originalCustomEvent;
    else delete globalThis.CustomEvent;
  });
  const child = { dataset: { readerProvider: 'fixture', readerSession: 'child' }, isConnected: true };
  const inserted = [];
  const container = { querySelector: () => null, insertBefore(chunk, before) { inserted.push({ chunk, before }); } };
  const workbench = {
    dataset: { provider: 'fixture', sessionId: 'root' },
    querySelector: () => ({ dataset: { readerProvider: 'fixture', readerSession: 'root' } }),
    dispatchEvent() {}
  };
  const button = {
    dataset: { partId: 'child-tool', field: 'output', nextOffset: '0' },
    disabled: false,
    isConnected: true,
    closest(selector) {
      if (selector === '.progressive') return container;
      if (selector === '.session-workbench') return workbench;
      if (selector === '[data-reader-pane]') return child;
      throw new Error(`Unexpected selector ${selector}`);
    },
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return null; },
    remove() { this.isConnected = false; }
  };
  globalThis.document = { createElement: () => ({ className: '', set innerHTML(value) {
    this.firstElementChild = { tagName: 'P', innerHTML: value, tabIndex: -1 };
  } }) };
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; Object.assign(this, options); } };
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, html: '<p>child output</p>', nextOffset: null }) });
  const result = await loadProgressiveContent(button);
  assert.equal(result.provider, 'fixture');
  assert.equal(result.sessionId, 'child');
  assert.equal(inserted.length, 1, 'The connected child owns the response despite the root pane being different');
});
