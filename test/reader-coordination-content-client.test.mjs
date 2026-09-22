import assert from 'node:assert/strict';
import test from 'node:test';
import { loadReaderCoordinationContent } from '../src/static/app/session-reader.js';
import { mergeProgressiveSurface } from '../src/static/app/session-workbench.js';
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
    constructor(tagName = 'DIV') { this.tagName = tagName; this.dataset = {}; this.children = []; this.attributes = new Map(); this.html = []; }
    append(...children) { children.forEach((child) => { child.parent = this; this.children.push(child); }); }
    replaceChildren() { this.children = []; this.html = []; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
    setAttribute(key, value) { this.attributes.set(key, value); }
    removeAttribute(key) { this.attributes.delete(key); }
    get firstElementChild() { return this.children[0] || null; }
    get lastElementChild() { return this.children.at(-1) || null; }
    get childNodes() { return this.children; }
    querySelector(selector) {
      if (selector === 'code') return this.children.find((child) => child.tagName === 'CODE') || null;
      if (/^[a-z]+$/i.test(selector)) return this.children.find((child) => child.tagName === selector.toUpperCase()) || null;
      const key = selector.slice(6, -1).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return this.children.find((child) => key in child.dataset) || null;
    }
    matches(selector) { return selector.toUpperCase() === this.tagName; }
    get classList() { return { contains: (name) => this.className?.split(' ').includes(name) || false }; }
    set innerHTML(html) { this.replaceChildren(); parsePage(this, html); }
    insertAdjacentHTML(_position, html) {
      this.html.push(html);
      parsePage(this, html);
    }
  }
  const parsePage = (parent, html) => {
    if (html.includes('data-reader-coordination-content-chunk')) {
      const chunk = new Element();
      chunk.dataset.readerCoordinationContentChunk = '';
      const plain = html.match(/<pre>([\s\S]*?)<\/pre>/)?.[1];
      if (plain !== undefined) {
        const surface = new Element('PRE');
        surface.append({ textContent: plain.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') });
        chunk.append(surface);
      }
      parent.append(chunk);
    }
    const offset = html.match(/data-reader-coordination-content-more data-next-offset="(\d+)"/)?.[1];
    if (offset) {
      const button = new Element('BUTTON');
      button.dataset.readerCoordinationContentMore = '';
      button.dataset.nextOffset = offset;
      parent.append(button);
    }
  };
  const panel = new Element();
  panel.dataset.readerCoordinationContentPanel = '';
  const disclosure = new Element();
  disclosure.dataset.readerCoordinationContentUrl = '/api/fixture/session/root/reader/coordination/exact%3A2/content';
  disclosure.append(panel);
  const requests = [];
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement() { return new Element(); },
    createTextNode(textContent) { return { textContent }; }
  } });
  t.after(() => originalDocument ? Object.defineProperty(globalThis, 'document', originalDocument) : delete globalThis.document);
  t.mock.method(globalThis, 'fetch', async (url) => { requests.push(url); return { ok: true, json: async () => ({ ok: true, revision: 'revision-1', html: '<p>Exact original result</p>' }) }; });
  t.mock.method(console, 'error', () => {});
  const ft = (key) => key;
  return { disclosure, panel, requests, ft, Element };
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

test('exchange plain continuation extends one escaped source surface', async (t) => {
  const f = fixture(t);
  globalThis.fetch.mock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({
    ok: true, available: true, revision: 'revision-1', continuation: null,
    html: '<div class="reader-coordination-content" data-reader-coordination-content-chunk><pre>first\n</pre></div><button data-reader-coordination-content-more data-next-offset="6000">More</button>'
  }) }));
  await loadReaderCoordinationContent(f.disclosure, { ft: f.ft });
  globalThis.fetch.mock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({
    ok: true, available: true, revision: 'revision-1', continuation: null,
    html: '<div class="reader-coordination-content" data-reader-coordination-content-chunk><pre>second &lt;x&gt;</pre></div>'
  }) }));
  assert.equal(await loadReaderCoordinationContent(f.disclosure, { offset: 6000, ft: f.ft }), true);
  const chunks = f.panel.children.filter((child) => 'readerCoordinationContentChunk' in child.dataset);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].firstElementChild.tagName, 'PRE');
  assert.equal(chunks[0].firstElementChild.childNodes.map((node) => node.textContent).join(''), 'first\nsecond <x>');
  assert.equal(f.panel.querySelector('[data-reader-coordination-content-more]'), null);
});

test('a mismatched exchange continuation retains its original retry control', async (t) => {
  const f = fixture(t);
  globalThis.fetch.mock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({
    ok: true, available: true, revision: 'revision-1',
    html: '<div data-reader-coordination-content-chunk><pre>first</pre></div><button data-reader-coordination-content-more data-next-offset="6000">More</button>'
  }) }));
  await loadReaderCoordinationContent(f.disclosure, { ft: f.ft });
  globalThis.fetch.mock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({
    ok: true, available: true, revision: 'revision-1', continuation: { kind: 'fence' },
    html: '<div data-reader-coordination-content-chunk><pre>wrong surface</pre></div>'
  }) }));
  assert.equal(await loadReaderCoordinationContent(f.disclosure, { offset: 6000, ft: f.ft }), false);
  const more = f.panel.querySelector('[data-reader-coordination-content-more]');
  assert.equal(more.disabled, false);
  assert.equal(f.panel.querySelector('[data-reader-coordination-content-chunk]').firstElementChild.childNodes[0].textContent, 'first');
});

test('fenced exchange continuation joins code without joining the next independent block', (t) => {
  const { Element } = fixture(t);
  const markdown = () => {
    const body = new Element();
    body.className = 'tool-output-body markdown';
    return body;
  };
  const fenced = (text) => {
    const pre = new Element('PRE');
    const code = new Element('CODE');
    code.append({ textContent: text });
    pre.append(code);
    return pre;
  };
  const existing = markdown();
  existing.append(fenced('first\n'));
  const incoming = markdown();
  incoming.append(fenced('second'), fenced('independent'));
  assert.equal(mergeProgressiveSurface(existing, incoming, { kind: 'fence' }), true);
  assert.equal(existing.children.length, 2);
  assert.equal(existing.children[0].querySelector('code').childNodes.map((node) => node.textContent).join(''), 'first\nsecond');
  assert.equal(existing.children[1].querySelector('code').childNodes.map((node) => node.textContent).join(''), 'independent');
});

test('declared paragraph, table and nested-list continuations merge only their owning block', (t) => {
  const { Element } = fixture(t);
  const markdown = () => {
    const body = new Element();
    body.className = 'tool-output-body markdown';
    return body;
  };
  const paragraph = (text) => {
    const node = new Element('P');
    node.append({ textContent: text });
    return node;
  };
  const paragraphSurface = markdown();
  paragraphSurface.append(paragraph('first'));
  const paragraphIncoming = markdown();
  paragraphIncoming.append(paragraph('second'));
  mergeProgressiveSurface(paragraphSurface, paragraphIncoming, { kind: 'paragraph', separator: ' ' });
  assert.equal(paragraphSurface.children.length, 1);
  assert.equal(paragraphSurface.firstElementChild.childNodes.map((node) => node.textContent).join(''), 'first second');

  const table = (value) => {
    const node = new Element('TABLE');
    const body = new Element('TBODY');
    const row = new Element('TR');
    row.append({ textContent: value });
    body.append(row);
    node.append(body);
    return node;
  };
  const tableSurface = markdown();
  tableSurface.append(table('one'));
  const tableIncoming = markdown();
  tableIncoming.append(table('two'));
  mergeProgressiveSurface(tableSurface, tableIncoming, { kind: 'table' });
  assert.deepEqual(tableSurface.firstElementChild.querySelector('tbody').children.map((row) => row.children[0].textContent), ['one', 'two']);

  const list = (tag, value) => {
    const node = new Element(tag);
    const item = new Element('LI');
    item.append({ textContent: value });
    node.append(item);
    return node;
  };
  const listSurface = markdown();
  const root = list('UL', 'parent');
  root.lastElementChild.append(list('UL', 'child-one'));
  listSurface.append(root);
  const listIncoming = markdown();
  listIncoming.append(list('UL', 'child-two'));
  mergeProgressiveSurface(listSurface, listIncoming, { kind: 'list', depth: 1 });
  const nested = root.lastElementChild.children.find((child) => child.tagName === 'UL');
  assert.deepEqual(nested.children.map((item) => item.children[0].textContent), ['child-one', 'child-two']);
});

test('declared source continuation keeps one notice and releases the following Markdown block', (t) => {
  const { Element } = fixture(t);
  const markdown = () => {
    const body = new Element();
    body.className = 'tool-output-body markdown';
    return body;
  };
  const sourceBlock = (text) => {
    const block = new Element();
    block.className = 'markdown-source-block';
    const notice = new Element('SPAN');
    notice.className = 'markdown-source-note';
    notice.append({ textContent: 'Large Markdown block shown as source' });
    const pre = new Element('PRE');
    pre.append({ textContent: text });
    block.append(notice, pre);
    return block;
  };
  const surface = markdown();
  surface.append(sourceBlock('first'));
  const continuation = markdown();
  continuation.append(sourceBlock(' second'));
  assert.equal(mergeProgressiveSurface(surface, continuation, { kind: 'source' }), true);
  assert.equal(surface.children.filter((child) => child.classList.contains('markdown-source-block')).length, 1);
  assert.equal(surface.firstElementChild.querySelector('pre').childNodes.map((node) => node.textContent).join(''), 'first second');

  const resumed = markdown();
  const paragraph = new Element('P');
  paragraph.append({ textContent: 'Markdown resumed' });
  resumed.append(paragraph);
  assert.equal(mergeProgressiveSurface(surface, resumed, null), true);
  assert.equal(surface.children.length, 2);
  assert.equal(surface.lastElementChild.tagName, 'P');
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
