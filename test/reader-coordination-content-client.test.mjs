import assert from 'node:assert/strict';
import test from 'node:test';
import { loadReaderCoordinationContent } from '../src/static/app/session-reader.js';
import { __I18N__ } from '../src/static/app/i18n.js';

test('exchange loading, failure, retry and stale states have browser translations', () => {
  for (const locale of ['en', 'zh']) {
    for (const suffix of ['loading', 'failed', 'retry', 'changed', 'unavailable']) {
      const key = `detail.reader_coordination_content_${suffix}`;
      assert.ok(__I18N__[locale][key]);
      assert.notEqual(__I18N__[locale][key], key);
    }
  }
});

function fixture(t) {
  class Element {
    constructor() { this.dataset = {}; this.children = []; this.attributes = new Map(); this.html = []; }
    append(child) { child.parent = this; this.children.push(child); }
    replaceChildren() { this.children = []; this.html = []; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
    setAttribute(key, value) { this.attributes.set(key, value); }
    removeAttribute(key) { this.attributes.delete(key); }
    querySelector(selector) {
      const key = selector.slice(6, -1).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return this.children.find((child) => key in child.dataset) || null;
    }
    insertAdjacentHTML(_position, html) {
      this.html.push(html);
      const offset = html.match(/data-reader-coordination-content-more data-next-offset="(\d+)"/)?.[1];
      if (offset) {
        const button = new Element();
        button.dataset.readerCoordinationContentMore = '';
        button.dataset.nextOffset = offset;
        this.append(button);
      }
    }
  }
  const panel = new Element();
  panel.dataset.readerCoordinationContentPanel = '';
  const disclosure = new Element();
  disclosure.dataset.readerCoordinationContentUrl = '/api/fixture/session/root/reader/coordination/exact%3A2/content';
  disclosure.append(panel);
  const requests = [];
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement() { return new Element(); } } });
  t.after(() => originalDocument ? Object.defineProperty(globalThis, 'document', originalDocument) : delete globalThis.document);
  t.mock.method(globalThis, 'fetch', async (url) => { requests.push(url); return { ok: true, json: async () => ({ ok: true, revision: 'revision-1', html: '<p>Exact original result</p>' }) }; });
  t.mock.method(console, 'error', () => {});
  const ft = (key) => key;
  return { disclosure, panel, requests, ft };
}

test('an exchange opens once, coalesces duplicate reads and retains the loaded body', async (t) => {
  const f = fixture(t);
  let resolve;
  globalThis.fetch.mock.mockImplementationOnce((url) => {
    f.requests.push(url);
    return new Promise((done) => { resolve = done; });
  });
  assert.equal(f.requests.length, 0);
  const first = loadReaderCoordinationContent(f.disclosure, { ft: f.ft });
  const simultaneous = loadReaderCoordinationContent(f.disclosure, { ft: f.ft });
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0], /exact%3A2\/content\?offset=0$/);
  assert.equal(f.disclosure.attributes.get('aria-busy'), 'true');
  resolve({ ok: true, json: async () => ({ ok: true, revision: 'revision-1', html: '<p>First return</p>' }) });
  assert.deepEqual(await Promise.all([first, simultaneous]), [true, true]);
  assert.equal(f.disclosure.attributes.has('aria-busy'), false);
  assert.equal(f.disclosure.dataset.readerCoordinationContentLoaded, 'true');
  assert.deepEqual(f.panel.html, ['<p>First return</p>']);
  await loadReaderCoordinationContent(f.disclosure, { ft: f.ft });
  assert.equal(f.requests.length, 1, 'Reopening retains the already-read exchange');
});

test('continuation sends the original revision and a stale response offers a full reload', async (t) => {
  const f = fixture(t);
  globalThis.fetch.mock.mockImplementationOnce(async (url) => {
    f.requests.push(url);
    return { ok: true, json: async () => ({ ok: true, revision: 'revision-original', html: '<p>First chunk</p><button data-reader-coordination-content-more data-next-offset="6000">More</button>' }) };
  });
  await loadReaderCoordinationContent(f.disclosure, { ft: f.ft });
  globalThis.fetch.mock.mockImplementationOnce(async (url) => {
    f.requests.push(url);
    return { ok: false, status: 409, json: async () => ({ ok: false, code: 'stale_content', error: 'Changed' }) };
  });
  assert.equal(await loadReaderCoordinationContent(f.disclosure, { offset: 6000, ft: f.ft }), false);
  assert.match(f.requests[1], /offset=6000&revision=revision-original$/);
  assert.equal(f.panel.querySelector('[data-reader-coordination-content-more]'), null);
  const state = f.panel.querySelector('[data-reader-coordination-content-state]');
  assert.equal(state.children[0].textContent, 'detail.reader_coordination_content_changed');
  assert.equal(state.children[1].dataset.nextOffset, '0');
  assert.match(f.panel.html.join(''), /First chunk/);
  assert.equal(await loadReaderCoordinationContent(f.disclosure, { reload: true, ft: f.ft }), true);
  assert.deepEqual(f.panel.html, ['<p>Exact original result</p>']);
});

test('a failed initial read leaves a retry instead of a loaded empty exchange', async (t) => {
  const f = fixture(t);
  globalThis.fetch.mock.mockImplementationOnce(async () => { throw new Error('Network failed'); });
  assert.equal(await loadReaderCoordinationContent(f.disclosure, { ft: f.ft }), false);
  assert.notEqual(f.disclosure.dataset.readerCoordinationContentLoaded, 'true');
  const state = f.panel.querySelector('[data-reader-coordination-content-state]');
  assert.equal(state.children[0].textContent, 'detail.reader_coordination_content_failed');
  assert.equal(state.children[1].dataset.nextOffset, '0');
  assert.equal(await loadReaderCoordinationContent(f.disclosure, { reload: true, ft: f.ft }), true);
});

test('a removed observation is explained locally without retrying a nonexistent source', async (t) => {
  const f = fixture(t);
  globalThis.fetch.mock.mockImplementationOnce(async () => ({
    ok: false, status: 404,
    json: async () => ({ ok: false, code: 'observation_not_found', error: 'Missing exchange' })
  }));
  assert.equal(await loadReaderCoordinationContent(f.disclosure, { ft: f.ft }), false);
  const state = f.panel.querySelector('[data-reader-coordination-content-state]');
  assert.equal(state.children[0].textContent, 'detail.reader_coordination_content_unavailable');
  assert.equal(state.children.length, 1, 'Unavailable source has no network retry action');
});
