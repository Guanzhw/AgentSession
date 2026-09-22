import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { initSessionReader } from '../src/static/app/session-reader.js';
import { readerPaneAnchor } from '../src/static/app/reader-pane-dom.js';
import { __I18N__ } from '../src/static/app/i18n.js';
import { createReaderLocation, parseReaderLocation } from '../src/static/app/reader-location.js';

test('unplaced inline history has browser-localized position labels', () => {
  assert.equal(__I18N__.en['detail.reader_inline_unplaced'], 'No recorded position');
  assert.equal(__I18N__.zh['detail.reader_inline_unplaced'], '未记录发生位置');
  assert.equal(__I18N__.en['detail.reader_history_path'], 'History path');
  assert.equal(__I18N__.zh['detail.reader_return_to'], '返回 {title}');
});

function readerHarness(t, initialHref = '/fixture/session/root?view=history#root-source', initialEvents = [], {
  narrow = false, collaboration = false, nativePanel = false, dock = false, panelStorage = new Map(), browserSnapshot = null, initialRootSession = null, markup = null, ft
} = {}) {
  const location = new URL(initialHref, 'http://localhost');
  const navigations = [];
  location.assign = (href) => navigations.push({ type: 'assign', href: new URL(href, location).href });
  location.reload = () => navigations.push({ type: 'reload', href: location.href });
  const frames = [];
  const requests = [];
  const panes = new Map();
  const eventResponses = new Map(initialEvents);
  const inheritedResponses = [];
  const processResponses = [];
  const paneResponses = new Map();
  let document;
  let window;
  const browserEntries = browserSnapshot?.entries?.map((entry) => ({ ...entry })) || [{ href: location.href, state: null }];
  let browserIndex = browserSnapshot?.index ?? 0;
  let pendingTraversal = Promise.resolve();

  class Element {
    constructor(dataset = {}, id = '') {
      this.dataset = dataset;
      this.id = id;
      this.children = [];
      this.listeners = new Map();
      this.attributes = new Map();
      this.classList = { add() {}, remove() {} };
    }
    append(...children) { children.forEach((child) => { child.parentElement = this; this.children.push(child); }); }
    after(child) {
      child.parentElement = this.parentElement;
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(this) + 1, 0, child);
    }
    replaceChildren(...children) { this.children = []; children.forEach((child) => this.append(child)); }
    contains(target) { return target === this || this.children.some((child) => child.contains(target)); }
    matches(selector) {
      if (selector.includes(', ')) return selector.split(', ').some((part) => this.matches(part));
      if (selector === '*') return true;
      if (selector === '[id]') return Boolean(this.id);
      if (selector === 'details') return this.tagName === 'DETAILS';
      if (selector === '.reader-branch-body, .reader-branch, li, p') return Boolean(this.className === 'reader-branch-body' || this.className === 'reader-branch' || this.tagName === 'LI' || this.tagName === 'P');
      if (selector === 'a[href]') return Boolean(this.href);
      if (selector === ".session-toc a[href^='#']") return this.href?.startsWith('#') && Boolean(this.parentElement?.closest('.session-toc'));
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      if (selector.startsWith('.')) return this.className === selector.slice(1);
      return selector.split(', ').some((part) => {
        const attributes = [...part.matchAll(/\[data-([\w-]+)(?:="([^"]*)")?\]/g)];
        return attributes.length > 0 && attributes.every(([, name, value]) => {
          const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
          return key in this.dataset && (value === undefined || this.dataset[key] === value);
        });
      });
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [
        ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)
      ]);
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    setAttribute(name, value) { this.attributes.set(name, value); if (name === 'href') this.href = value; }
    getAttribute(name) { return name === 'href' ? (this.attributes.get(name) ?? this.href) : this.attributes.get(name); }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    remove() {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      this.parentElement = null;
    }
    addEventListener(name, callback) {
      const listeners = this.listeners.get(name) || [];
      listeners.push(callback);
      this.listeners.set(name, listeners);
    }
    async dispatchEvent(event) {
      for (const callback of this.listeners.get(event.type) || []) await callback(event);
    }
    focus() { document.activeElement = this; }
    scrollIntoView() { window.scrollY = 50; }
    get isConnected() { return workbench.contains(this); }
    get childNodes() { return this.children; }
    get firstElementChild() { return this.children[0] || null; }
    get lastElementChild() { return this.children.at(-1) || null; }
    set innerHTML(html) {
      if (html.startsWith('pane:')) {
        this.replaceChildren(panes.get(html.slice('pane:'.length)));
      } else if (html.startsWith('inherited:')) {
        const message = new Element({ partId: 'parent-message:text', contentScope: 'inherited-context' }, 'parent-message');
        const known = new Element();
        known.setAttribute('aria-labelledby', 'parent-message unknown-source');
        const source = new Element();
        source.setAttribute('href', '#parent-message');
        message.append(known, source);
        this.replaceChildren(message);
      } else {
        this.replaceChildren(new Element({ readerEventEvidence: '', readerEventId: html.slice('event:'.length) }));
      }
    }
  }

  const makePane = (session) => {
    const pane = new Element({ readerPane: '', readerProvider: 'fixture', readerSession: session, readerTitle: session });
    pane.append(new Element({}, `${session}-source`));
    if (collaboration) {
      pane.append(new Element({ readerCollaboration: '' }, `${session}-collaboration`));
      pane.append(new Element({ readerCollaborationToggle: '' }));
    }
    if (nativePanel) {
      const overview = new Element({ readerCollaborationOverview: '' }, `${session}-overview`);
      overview.tagName = 'DETAILS';
      const panel = new Element({ readerCollaboration: '' });
      panel.append(new Element({ readerCollaborationClose: '' }));
      overview.append(panel);
      pane.append(overview);
    }
    panes.set(session, pane);
    return pane;
  };
  const root = makePane('root');
  const child = makePane('child');
  const host = new Element({ readerHost: '' });
  const documentRootSession = initialRootSession || location.pathname.split('/').at(-1);
  host.append(panes.get(documentRootSession));
  const back = new Element({ readerBack: '' });
  const status = new Element({ readerStatus: '' });
  const workbench = new Element({ provider: 'fixture', sessionId: documentRootSession });
  const currentTitle = new Element({ readerCurrentTitle: '' }, 'H1');
  currentTitle.textContent = 'Root document title';
  currentTitle.hidden = true;
  const swaps = [];
  const anchorReveals = [];
  workbench.addEventListener('session-reader:swapped', (event) => swaps.push(event.detail));
  workbench.addEventListener('session-reader:anchor-revealed', (event) => anchorReveals.push(event.detail));
  workbench.append(currentTitle);
  if (nativePanel) {
    const actions = new Element();
    actions.className = 'session-actions';
    const toggle = new Element({ readerCollaborationToggle: '' });
    toggle.className = 'reader-header-collaboration';
    actions.append(toggle);
    workbench.append(actions);
  }
  workbench.append(host);
  workbench.append(back);
  workbench.append(status);
  document = {
    activeElement: null,
    querySelector: () => workbench,
    getElementById: (id) => host.querySelector(`#${id}`),
    createElement: () => new Element()
  };
  window = new Element();
  const media = new Element();
  media.matches = narrow;
  const dockMedia = new Element();
  dockMedia.matches = dock;
  Object.assign(window, {
    scrollX: 0,
    scrollY: 0,
    scrollTo({ top, left }) { this.scrollY = top; this.scrollX = left; },
    setTimeout() {},
    matchMedia: (query) => query.includes('min-width: 1820px') ? dockMedia : media
  });
  const traverse = (offset) => {
    browserIndex += offset;
    const entry = browserEntries[browserIndex];
    assert.ok(entry, 'Browser navigation must select an existing history entry');
    location.href = entry.href;
    pendingTraversal = window.dispatchEvent({ type: 'popstate', state: entry.state });
  };
  const globals = {
    document, window, location,
    history: {
      get state() { return browserEntries[browserIndex].state; },
      pushState(state, _title, href) {
        location.href = new URL(href, location.href).href;
        browserEntries.splice(browserIndex + 1);
        browserEntries.push({ href: location.href, state });
        browserIndex += 1;
      },
      replaceState(state, _title, href) {
        location.href = new URL(href, location.href).href;
        browserEntries[browserIndex] = { href: location.href, state };
      },
      back() { traverse(-1); },
      forward() { traverse(1); }
    },
    HTMLElement: Element,
    HTMLAnchorElement: Element,
    CSS: { escape: (value) => value },
    CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    requestAnimationFrame: (callback) => frames.push(callback),
    localStorage: {
      getItem: (key) => panelStorage.get(key) ?? null,
      setItem: (key, value) => panelStorage.set(key, value)
    },
    fetch: async (url) => {
      requests.push(url);
      if (url.includes('/reader/process?')) {
        const data = await processResponses.shift();
        if (data instanceof Error) throw data;
        return { ok: data.ok, status: data.ok ? 200 : 404, json: async () => data };
      }
      if (url.includes('/inherited-context?')) {
        const data = await inheritedResponses.shift();
        return { ok: true, json: async () => data };
      }
      const match = url.match(/\/session\/([^/]+)\/reader(?:\/event\/(.+))?$/);
      assert.ok(match, `Unexpected request: ${url}`);
      const data = match[2]
        ? eventResponses.get(decodeURIComponent(match[2]))
        : paneResponses.get(decodeURIComponent(match[1])) || { ok: true, html: `pane:${decodeURIComponent(match[1])}` };
      assert.ok(data, `No response for ${url}`);
      return { ok: true, json: async () => data };
    }
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
  }
  const makeElement = (dataset, id) => new Element(dataset, id);
  const addRecordedChild = (parent = root, session = 'child', href = `/fixture/session/${session}`) => {
    const link = makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: session });
    link.href = href;
    parent.append(link);
    return link;
  };
  const initialMarkup = markup?.({ root, child, makePane, makeElement, addRecordedChild, processResponses });
  const reader = initSessionReader({ ft });
  const click = async (target) => {
    const event = { type: 'click', target, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    await workbench.dispatchEvent(event);
    // The existing document-level ToC controller only handles unclaimed clicks.
    if (!event.defaultPrevented && target.matches(".session-toc a[href^='#']")) {
      globals.history.pushState(null, '', target.getAttribute('href'));
      document.getElementById(target.getAttribute('href').slice(1))?.scrollIntoView();
    }
  };
  const flush = async () => {
    await pendingTraversal;
    await new Promise((resolve) => setImmediate(resolve));
    while (frames.length) frames.shift()();
  };
  return {
    reader, root, child, back, status, currentTitle, location, window, document, requests, makePane, flush, eventResponses, inheritedResponses, processResponses, paneResponses, swaps, anchorReveals,
    makeElement, addRecordedChild, navigations, initialMarkup, panelStorage,
    click,
    async resize(isNarrow) { media.matches = isNarrow; await media.dispatchEvent({ type: 'change' }); },
    async resizeDock(isDock) { dockMedia.matches = isDock; await dockMedia.dispatchEvent({ type: 'change' }); },
    browserBack: async () => { traverse(-1); await flush(); },
    browserForward: async () => { traverse(1); await flush(); },
    async nativeFragment(href) {
      // A native same-document navigation creates a null-state browser entry,
      // emits popstate, and performs fragment scrolling while replay may await.
      globals.history.pushState(null, '', href);
      pendingTraversal = window.dispatchEvent({ type: 'popstate', state: null });
      document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
      await flush();
    },
    href: () => location.pathname + location.search + location.hash,
    cached: (session) => reader.cache.get(`fixture\0${session}`),
    historyState: () => browserEntries[browserIndex].state,
    workbenchSession: () => workbench.dataset.sessionId,
    snapshot: () => ({ entries: browserEntries.map((entry) => ({ ...entry })), index: browserIndex }),
    async pop(href) {
      location.href = new URL(href, location.href).href;
      const index = browserEntries.findLastIndex((entry) => entry.href === location.href);
      if (index >= 0) browserIndex = index;
      else browserEntries[browserIndex] = { href: location.href, state: null };
      await window.dispatchEvent({ type: 'popstate', state: browserEntries[browserIndex].state });
      await flush();
    },
    async source(session, eventId, nativeTarget = null) {
      eventResponses.set(eventId, { ok: true, evidence: { eventId }, nativeTarget, html: `event:${eventId}` });
      const link = new Element({ readerEventSource: '', readerProvider: 'fixture', readerSession: session, readerEventId: eventId });
      link.href = `/fixture/session/${session}?readerEvent=${encodeURIComponent(eventId)}`;
      host.querySelector('[data-reader-pane]').append(link);
      await workbench.dispatchEvent({ type: 'click', target: link, button: 0, preventDefault() {} });
      await flush();
    }
  };
}

function addDeferredProcess({ makeElement }, pane, anchor = 'deferred-tool') {
  const chunk = makeElement({ readerProcessChunk: '', readerProcessState: 'unloaded',
    readerProcessUrl: `/api/fixture/session/${pane.dataset.readerSession}/reader/process?messageId=message&firstPartId=tool&lastPartId=tool` });
  const placeholder = makeElement({ readerProcessAnchor: '', partId: 'tool' }, anchor);
  const button = makeElement({ readerProcessLoad: '', loadingLabel: 'Loading', retryLabel: 'Retry', loadError: 'Load failed' });
  button.textContent = 'Load tool';
  chunk.append(placeholder, button, makeElement({ readerProcessStatus: '' }));
  const target = makeElement({ partId: 'tool' }, anchor);
  const label = makeElement();
  label.setAttribute('aria-controls', `${anchor} ${pane.dataset.readerSession}-source`);
  const link = makeElement();
  link.href = `#${pane.dataset.readerSession}-source`;
  target.append(label, link);
  Object.defineProperty(chunk, 'innerHTML', { set(html) {
    assert.equal(html, 'process:tool');
    chunk.replaceChildren(target);
  } });
  pane.append(chunk);
  return { chunk, target, label, link };
}

test('an initial raw process hash materializes its source before revealing it', async (t) => {
  const h = readerHarness(t, '/fixture/session/root#deferred-tool', [], { markup(h) {
    h.processResponses.push({ ok: true, html: 'process:tool' });
    return addDeferredProcess(h, h.root);
  } });
  await h.flush();
  assert.equal(h.initialMarkup.chunk.dataset.readerProcessState, 'loaded');
  assert.equal(h.document.activeElement, h.initialMarkup.target);
  assert.equal(h.location.hash, '#deferred-tool');
  assert.equal(h.anchorReveals.at(-1).target, h.initialMarkup.target);
  assert.equal(h.historyState().readerEntry, 0, 'Reload does not create a new reading location');
});

test('native same-document fragments keep their targets and distinct Back/Forward reading positions', async (t) => {
  const h = readerHarness(t, '/fixture/session/root?view=history');
  const targets = ['native-A', 'native-B'].map((id) => h.makeElement({}, id));
  h.root.append(...targets);
  h.window.scrollY = 800;
  h.root.children[0].focus();

  await h.nativeFragment('#native-A');
  assert.equal(h.window.scrollY, 50, 'The target remains revealed after asynchronous location replay');
  assert.equal(h.document.activeElement, targets[0]);
  assert.equal(h.snapshot().entries.length, 2, 'Claiming a native entry adds no browser entry');
  h.window.scrollY = 1700;
  await h.nativeFragment('#native-B');
  assert.equal(h.window.scrollY, 50);
  assert.equal(h.document.activeElement, targets[1]);
  h.window.scrollY = 2800;

  await h.browserBack();
  assert.equal(h.location.hash, '#native-A');
  assert.equal(h.window.scrollY, 1700);
  assert.equal(h.document.activeElement, targets[0]);
  await h.browserBack();
  assert.equal(h.location.hash, '');
  assert.equal(h.window.scrollY, 800);
  assert.equal(h.document.activeElement, h.root.children[0]);
  await h.browserForward();
  assert.equal(h.window.scrollY, 1700);
  assert.equal(h.document.activeElement, targets[0]);
  await h.browserForward();
  assert.equal(h.window.scrollY, 2800);
  assert.equal(h.document.activeElement, targets[1]);
  assert.equal(new Set(h.snapshot().entries.map((entry) => entry.state.readerEntry)).size, 3);
  assert.equal(h.swaps.length, 0);
});

test('an older unmanaged browser entry keeps its identity after a later history branch', async (t) => {
  const rootHref = 'http://localhost/fixture/session/root#root-source';
  const olderHref = 'http://localhost/fixture/session/root#older-source';
  const h = readerHarness(t, rootHref, [], { browserSnapshot: {
    entries: [{ href: olderHref, state: null }, { href: rootHref, state: { readerEntry: 0 } }], index: 1
  } });
  const older = h.makeElement({}, 'older-source');
  h.root.append(older);
  await h.flush();
  h.window.scrollY = 700;
  await h.source('root', 'first-source');
  await h.browserBack();
  await h.browserBack();
  assert.equal(h.href(), '/fixture/session/root#older-source');
  assert.equal(h.document.activeElement, older);
  assert.equal(h.window.scrollY, 50);
  const olderEntry = h.historyState().readerEntry;
  h.window.scrollY = 320;

  await h.browserForward();
  assert.equal(h.window.scrollY, 700);
  await h.source('root', 'new-branch');
  assert.notEqual(h.historyState().readerEntry, olderEntry, 'Entry IDs describe identity, not browser order');
  await h.browserBack();
  await h.browserBack();
  assert.equal(h.historyState().readerEntry, olderEntry);
  assert.equal(h.document.activeElement, older);
  assert.equal(h.window.scrollY, 320, 'Branching must retain this still-reachable earlier entry');
  assert.equal(h.snapshot().entries.length, 3);
});

test('a native root fragment returns to the managed inline reading position on Back', async (t) => {
  const h = readerHarness(t, '/fixture/session/root?view=history');
  const milestone = h.makeElement({ readerMilestone: '' }, 'child-milestone');
  const open = h.addRecordedChild(milestone);
  const target = h.makeElement({}, 'native-root-target');
  h.root.append(milestone, target);
  h.window.scrollY = 730;
  open.focus();
  await h.click(open);
  const rootSource = h.makeElement({ readerSource: '' });
  rootSource.href = '#root-source';
  h.root.append(rootSource);
  await h.click(rootSource);
  h.window.scrollY = 2100;
  h.child.children[0].focus();
  h.child.dataset.searchQuery = 'child result';
  h.child.children[0].open = true;

  await h.nativeFragment('#native-root-target');
  assert.equal(h.window.scrollY, 50, 'Closing the inline stack must not restore its opener over the new target');
  assert.equal(h.document.activeElement, target);
  assert.deepEqual(h.reader.getInlinePanes(), []);
  h.window.scrollY = 2900;
  await h.browserBack();
  assert.deepEqual(h.reader.getInlinePanes(), [h.child]);
  assert.equal(h.window.scrollY, 2100);
  assert.equal(h.document.activeElement, h.child.children[0]);
  assert.equal(h.child.dataset.searchQuery, 'child result');
  assert.equal(h.child.children[0].open, true);
  await h.browserForward();
  assert.deepEqual(h.reader.getInlinePanes(), []);
  assert.equal(h.window.scrollY, 2900);
  assert.equal(h.document.activeElement, target);
});

test('a native deferred fragment is registered before replay and cannot override later navigation', async (t) => {
  const h = readerHarness(t, '/fixture/session/root');
  const process = addDeferredProcess(h, h.root);
  h.window.scrollY = 820;
  h.root.children[0].focus();
  let resolveProcess;
  h.processResponses.push(new Promise((resolve) => { resolveProcess = resolve; }));
  const pending = h.nativeFragment('#deferred-tool');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(process.chunk.dataset.readerProcessState, 'loading');
  assert.notEqual(h.historyState()?.readerEntry, 0);
  assert.ok(Number.isInteger(h.historyState()?.readerEntry), 'The browser entry is claimed before source loading completes');
  await h.browserBack();
  assert.equal(h.window.scrollY, 820);
  await h.nativeFragment('#root-source');
  h.window.scrollY = 1900;
  resolveProcess({ ok: true, html: 'process:tool' });
  await pending;
  assert.equal(h.location.hash, '#root-source');
  assert.equal(h.document.activeElement, h.root.children[0]);
  assert.equal(h.window.scrollY, 1900);
  assert.equal(h.anchorReveals.at(-1).target, h.root.children[0]);
});

test('a deferred source response preserves a newer same-pane navigation', async (t) => {
  const h = readerHarness(t);
  await h.flush();
  const process = addDeferredProcess(h, h.root);
  let resolveProcess;
  h.processResponses.push(new Promise((resolve) => { resolveProcess = resolve; }));
  const source = h.makeElement({ readerSource: '' });
  source.href = '#deferred-tool';
  h.root.append(source);
  const pending = h.click(source);
  const newer = h.makeElement({ readerSource: '' });
  newer.href = '#root-source';
  h.root.append(newer);
  await h.click(newer);
  const newerHref = h.href();
  resolveProcess({ ok: true, html: 'process:tool' });
  await pending;
  assert.equal(process.chunk.dataset.readerProcessState, 'loaded', 'Useful content may finish without taking navigation ownership');
  assert.equal(h.document.activeElement, h.root.children[0]);
  assert.equal(h.href(), newerHref);
  assert.equal(h.anchorReveals.at(-1).target, h.root.children[0]);
});

test('a native event waits for its process and respects newer source navigation', async (t) => {
  const h = readerHarness(t);
  await h.flush();
  const process = addDeferredProcess(h, h.root);
  let resolveProcess;
  h.processResponses.push(new Promise((resolve) => { resolveProcess = resolve; }));
  const pending = h.source('root', 'tool-event', { partId: 'tool', anchor: 'deferred-tool' });
  await h.flush();
  assert.equal(process.chunk.dataset.readerProcessState, 'loading');
  const newer = h.makeElement({ readerSource: '' });
  newer.href = '#root-source';
  h.root.append(newer);
  await h.click(newer);
  resolveProcess({ ok: true, html: 'process:tool' });
  await pending;
  assert.equal(h.document.activeElement, h.root.children[0]);
  assert.equal(h.location.hash, '#root-source');
  assert.equal(h.location.searchParams.has('readerEvent'), false);
  assert.equal(h.root.querySelector('[data-reader-event-evidence]'), null);
});

test('closing a child while its deferred source loads preserves the parent location', async (t) => {
  const h = readerHarness(t);
  h.addRecordedChild();
  const process = addDeferredProcess(h, h.child);
  await h.reader.openPane('fixture', 'child');
  let resolveProcess;
  h.processResponses.push(new Promise((resolve) => { resolveProcess = resolve; }));
  const source = h.makeElement({ readerSource: '' });
  source.href = '#deferred-tool';
  h.child.append(source);
  const pending = h.click(source);
  await h.child.parentElement.querySelector('[data-reader-inline-close]').dispatchEvent({ type: 'click', preventDefault() {} });
  const parentHref = h.href();
  const parentFocus = h.document.activeElement;
  resolveProcess({ ok: true, html: 'process:tool' });
  await pending;
  assert.equal(process.chunk.dataset.readerProcessState, 'unloaded');
  assert.equal(h.href(), parentHref);
  assert.equal(h.document.activeElement, parentFocus);
  assert.deepEqual(h.reader.getInlinePanes(), []);
});

test('a late child process scopes its IDs and references to existing pane anchors', async (t) => {
  const h = readerHarness(t);
  h.addRecordedChild();
  const process = addDeferredProcess(h, h.child);
  await h.reader.openPane('fixture', 'child');
  h.processResponses.push({ ok: true, html: 'process:tool' });
  await h.source('child', 'tool-event', { partId: 'tool', anchor: 'deferred-tool' });
  const existing = readerPaneAnchor(h.child, 'child-source');
  assert.equal(readerPaneAnchor(h.child, 'deferred-tool'), process.target);
  assert.notEqual(process.target.id, 'deferred-tool');
  assert.equal(process.label.getAttribute('aria-controls'), `${process.target.id} ${existing.id}`);
  assert.equal(decodeURIComponent(process.link.href.slice(1)), existing.id);
  assert.equal(parseReaderLocation(h.location).source.hash, '#deferred-tool');
  assert.equal(h.document.activeElement, process.target);
  await h.child.parentElement.querySelector('[data-reader-inline-close]').dispatchEvent({ type: 'click', preventDefault() {} });
  assert.equal(process.target.id, 'deferred-tool');
  assert.equal(process.label.getAttribute('aria-controls'), 'deferred-tool child-source');
  assert.equal(process.link.href, '#child-source');
});

test('deferred source navigation distinguishes network failure from missing source', async (t) => {
  const h = readerHarness(t, undefined, [], { ft: (key) => key });
  const process = addDeferredProcess(h, h.root);
  const source = h.makeElement({ readerSource: '' });
  source.href = '#deferred-tool';
  h.root.append(source);
  h.processResponses.push(new TypeError('Network unavailable'));
  await h.click(source);
  assert.equal(h.status.children[0].textContent, 'detail.reader_event_failed');
  assert.equal(process.chunk.dataset.readerProcessState, 'error');
  h.processResponses.push({ ok: false, code: 'process_not_found', error: 'No recorded tool range' });
  await h.click(source);
  assert.equal(h.status.children[0].textContent, 'detail.reader_source_missing');
  h.processResponses.push({ ok: true, html: 'process:tool' });
  await h.click(source);
  assert.equal(h.document.activeElement, process.target);
});

test('inline child Back/Forward restores the root URL, scroll, focus, and reading state', async (t) => {
  const h = readerHarness(t);
  const rootHref = h.href();
  const childHref = '/fixture/session/child';
  h.addRecordedChild(h.root, 'child', childHref);
  h.root.dataset.searchQuery = 'owned result';
  h.root.children[0].open = true;
  await h.reader.openPane('fixture', 'child', { href: childHref });
  await h.flush();
  await h.browserBack();
  h.window.scrollY = 1300;
  h.root.children[0].focus();
  await h.browserForward();
  assert.equal(h.cached('child').href, childHref);
  assert.equal(h.reader.getActivePane(), h.root);
  assert.deepEqual(h.reader.getInlinePanes(), [h.child]);
  assert.equal(parseReaderLocation(h.location).source.pathname, '/fixture/session/child');
  await h.back.dispatchEvent({ type: 'click' });
  await h.flush();
  assert.equal(h.reader.getActivePane(), h.root);
  assert.equal(h.href(), rootHref);
  assert.equal(h.window.scrollY, 1300);
  assert.equal(h.document.activeElement, h.root.children[0]);
  assert.equal(h.root.dataset.searchQuery, 'owned result');
  assert.equal(h.root.children[0].open, true);
  assert.deepEqual(h.navigations, []);
  assert.deepEqual(h.swaps, []);
});

test('event deep links rebuild scalar evidence on reload without adding a Back entry', async (t) => {
  const eventId = 'event:run/completed:1';
  const href = `/fixture/session/root?readerEvent=${encodeURIComponent(eventId)}#reader-event-event-run-completed-1`;
  const h = readerHarness(t, href, [[eventId, { ok: true, evidence: { eventId }, html: `event:${eventId}` }]]);
  await h.flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.href(), href);
  assert.equal(h.document.activeElement.dataset.readerEventId, eventId);
  assert.equal(h.back.disabled, true);
});

test('browser traversal to a different event owner reloads its canonical document', async (t) => {
  const h = readerHarness(t);
  const eventId = 'event:child/completed:2';
  const href = `/fixture/session/child?readerEvent=${encodeURIComponent(eventId)}#reader-event-event-child-completed-2`;
  h.eventResponses.set(eventId, { ok: true, evidence: { eventId }, html: `event:${eventId}` });
  await h.pop(href);
  assert.equal(h.reader.getActivePane(), h.root);
  assert.equal(h.href(), href);
  assert.deepEqual(h.navigations, [{ type: 'reload', href: `http://localhost${href}` }]);
  assert.deepEqual(h.requests, [], 'The current document never fetches another owner after traversal');
});

test('an unrelated session opens its canonical document without changing the reader owner', async (t) => {
  const h = readerHarness(t);
  const rootHref = h.href();
  const siblingHref = '/fixture/session/sibling?view=events#sibling-source';
  const opened = await h.reader.openPane('fixture', 'sibling', { href: siblingHref });
  assert.equal(opened, false);
  assert.equal(h.reader.getActivePane(), h.root);
  assert.equal(h.workbenchSession(), 'root');
  assert.equal(h.href(), rootHref);
  assert.deepEqual(h.navigations, [{ type: 'assign', href: `http://localhost${siblingHref}` }]);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.reader.getInlinePanes(), []);
});

test('scalar event sources keep the exact event query and anchor for reload in the same or child pane', async (t) => {
  const h = readerHarness(t);
  h.addRecordedChild();
  for (const [session, eventId] of [['root', 'event:run/completed:1'], ['child', 'event:delivery:2']]) {
    await h.source(session, eventId);
    assert.equal(h.location.pathname, '/fixture/session/root');
    const source = parseReaderLocation(h.location)?.source || h.location;
    assert.equal(source.pathname, `/fixture/session/${session}`);
    assert.equal(source.searchParams.get('readerEvent'), eventId);
    assert.equal(source.hash, `#reader-event-${eventId.replace(/[^A-Za-z0-9_-]/g, '-')}`);
    assert.equal(h.document.activeElement.dataset.readerEventId, eventId);
  }
});

test('inline scalar and native event sources encode the child owner under the root URL', async (t) => {
  const h = readerHarness(t);
  const open = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
  open.href = '/fixture/session/child';
  h.root.append(open);
  await h.click(open);

  const scalarId = 'event:inline/scalar:1';
  h.eventResponses.set(scalarId, { ok: true, evidence: { eventId: scalarId }, html: `event:${scalarId}` });
  const scalar = h.makeElement({ readerEventSource: '', readerProvider: 'fixture', readerSession: 'child', readerEventId: scalarId });
  scalar.href = `/fixture/session/child?readerEvent=${encodeURIComponent(scalarId)}`;
  h.child.append(scalar);
  await h.click(scalar);
  assert.equal(h.location.pathname, '/fixture/session/root');
  assert.equal(h.location.searchParams.has('readerEvent'), false);
  assert.equal(parseReaderLocation(h.location).source.pathname, '/fixture/session/child');
  assert.equal(parseReaderLocation(h.location).source.searchParams.get('readerEvent'), scalarId);
  assert.equal(h.reader.getActivePane(), h.root);
  assert.deepEqual(h.reader.getInlinePanes(), [h.child]);

  h.child.children[0].dataset.partId = 'tool:native';
  const nativeId = 'event:inline/native:2';
  h.eventResponses.set(nativeId, { ok: true, evidence: { eventId: nativeId }, nativeTarget: { partId: 'tool:native', anchor: 'child-source' }, html: `event:${nativeId}` });
  const native = h.makeElement({ readerEventSource: '', readerProvider: 'fixture', readerSession: 'child', readerEventId: nativeId });
  native.href = `/fixture/session/child?readerEvent=${encodeURIComponent(nativeId)}`;
  h.child.append(native);
  await h.click(native);
  assert.equal(h.location.pathname, '/fixture/session/root');
  assert.equal(parseReaderLocation(h.location).source.searchParams.get('readerEvent'), null);
  assert.equal(parseReaderLocation(h.location).source.hash, '#child-source');
  assert.equal(h.location.hash, '');
  assert.equal(h.document.activeElement.parentElement, h.child);
});

test('source-only delivery evidence opens at its inline milestone and preserves Back', async (t) => {
  const h = readerHarness(t);
  const marker = h.makeElement({ readerMilestone: '', readerEventId: 'return:1' }, 'milestone-return-1');
  const later = h.makeElement({}, 'later-prose');
  h.root.append(marker);
  h.root.append(later);
  h.window.scrollY = 940;
  marker.focus();
  await h.source('root', 'return:1');
  const evidence = h.document.activeElement;
  assert.equal(h.root.children[h.root.children.indexOf(marker) + 1], evidence);
  assert.ok(h.root.children.indexOf(evidence) < h.root.children.indexOf(later));
  await h.browserBack();
  assert.equal(h.window.scrollY, 940);
  assert.equal(h.document.activeElement, marker);
});

test('native event parts replace any earlier scalar event query with their readable anchor', async (t) => {
  const h = readerHarness(t);
  await h.source('root', 'event:completion:1');
  h.root.children[0].dataset.partId = 'tool:follow-up';
  await h.source('root', 'event:tool:2', { partId: 'tool:follow-up', anchor: 'root-source' });
  assert.equal(h.location.searchParams.get('readerEvent'), null);
  assert.equal(h.location.searchParams.get('view'), 'history');
  assert.equal(h.location.hash, '#root-source');
  assert.equal(h.document.activeElement, h.root.children[0]);
});

test('same-pane source jumps preserve distinct origins through browser and in-app Back', async (t) => {
  const h = readerHarness(t);
  const rootHref = h.href();
  h.window.scrollY = 1300;
  h.root.children[0].focus();
  h.root.dataset.searchQuery = 'owned result';
  h.root.children[0].open = true;
  await h.source('root', 'event:completion:1');
  const sourceHref = h.href();
  const firstEvidence = h.document.activeElement;
  h.window.scrollY = 2400;
  await h.source('root', 'event:completion:2');
  assert.equal(h.reader.cache.size, 1, 'Each session retains one pane DOM');
  assert.equal(h.back.disabled, false);
  await h.back.dispatchEvent({ type: 'click' });
  await h.flush();
  assert.equal(h.href(), sourceHref);
  assert.equal(h.window.scrollY, 2400);
  assert.equal(h.document.activeElement, firstEvidence);
  await h.browserBack();
  assert.equal(h.href(), rootHref);
  assert.equal(h.window.scrollY, 1300);
  assert.equal(h.document.activeElement, h.root.children[0]);
  assert.equal(h.root.dataset.searchQuery, 'owned result');
  assert.equal(h.root.children[0].open, true);
  await h.browserForward();
  assert.equal(h.href(), sourceHref);
  assert.equal(h.window.scrollY, 2400);
  assert.equal(h.document.activeElement, firstEvidence);
  assert.equal(h.swaps.length, 0, 'Same-pane history must not reset pane search or collaboration disclosures');
});

test('plain same-pane source anchors retain one-action Back to the prior reading position', async (t) => {
  const h = readerHarness(t);
  const rootHref = h.href();
  const target = h.makeElement({}, 'tool-source');
  const link = h.makeElement({ readerSource: '', readerProvider: 'fixture', readerSession: 'root', readerAnchor: target.id });
  link.href = '/fixture/session/root#tool-source';
  h.root.append(target);
  h.root.append(link);
  h.window.scrollY = 1800;
  link.focus();
  await h.click(link);
  assert.equal(h.location.hash, '#tool-source');
  assert.equal(h.document.activeElement, target);
  assert.equal(h.back.disabled, false);
  await h.back.dispatchEvent({ type: 'click' });
  await h.flush();
  assert.equal(h.href(), rootHref);
  assert.equal(h.window.scrollY, 1800);
  assert.equal(h.document.activeElement, link);
});

test('a newer same-pane source selection cancels a pending child navigation', async (t) => {
  const h = readerHarness(t);
  h.addRecordedChild();
  let resolveChild;
  h.paneResponses.set('child', new Promise((resolve) => { resolveChild = resolve; }));
  const pending = h.reader.openPane('fixture', 'child');
  const link = h.makeElement({ readerSource: '', readerProvider: 'fixture', readerSession: 'root', readerAnchor: 'root-source' });
  link.href = '/fixture/session/root#root-source';
  h.root.append(link);
  await h.click(link);
  resolveChild({ ok: true, html: 'pane:child' });
  await pending;
  await h.flush();
  assert.equal(h.reader.getActivePane(), h.root);
  assert.equal(h.href(), '/fixture/session/root?view=history#root-source');
  assert.equal(h.document.activeElement, h.root.children[0]);
});

test('ordinary child links mount complete history inline and preserve the parent pane', async (t) => {
  const h = readerHarness(t);
  const link = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
  link.href = '/fixture/session/child';
  h.root.append(link);
  h.window.scrollY = 880;
  link.focus();
  await h.click(link);
  await h.flush();
  assert.equal(h.reader.getActivePane(), h.root);
  assert.deepEqual(h.reader.getInlinePanes(), [h.child]);
  assert.equal(h.child.parentElement.className, 'reader-inline-pane');
  assert.equal(h.child.parentElement.querySelector('.reader-inline-pane-title').textContent, 'child');
  const scopedChildSource = h.child.querySelector('[data-reader-canonical-anchor="child-source"]');
  assert.equal(scopedChildSource.dataset.readerCanonicalAnchor, 'child-source');
  assert.equal(scopedChildSource.id, `reader-scope-${encodeURIComponent('fixture\0child')}--child-source`);
  assert.equal(h.location.pathname, '/fixture/session/root');
  assert.equal(h.location.searchParams.get('view'), 'history');
  assert.equal(h.location.hash, '');
  assert.equal(parseReaderLocation(h.location).source.href, 'http://localhost/fixture/session/child');
  const close = h.child.parentElement.querySelector('[data-reader-inline-close]');
  await close.dispatchEvent({ type: 'click', preventDefault() {} });
  await h.flush();
  assert.deepEqual(h.reader.getInlinePanes(), []);
  assert.equal(h.reader.getActivePane(), h.root);
  assert.equal(h.window.scrollY, 880);
  assert.equal(h.document.activeElement, link);
  await h.browserBack();
  assert.deepEqual(h.reader.getInlinePanes(), [h.child], 'Back reopens the prior inline state');
  await h.browserForward();
  assert.deepEqual(h.reader.getInlinePanes(), [], 'Forward returns to the explicit close state');
});

test('collaboration child links mount after their canonical transcript milestone and restore the opener', async (t) => {
  const h = readerHarness(t);
  const transcript = h.makeElement({ readerTranscript: '' });
  const milestone = h.makeElement({ readerMilestone: '' }, 'child-milestone');
  const milestoneBody = h.makeElement();
  milestoneBody.className = 'reader-milestone-body';
  const milestoneLink = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
  milestoneLink.href = '/fixture/session/child#child-source';
  milestoneBody.append(milestoneLink);
  milestone.append(milestoneBody);
  const trailing = h.makeElement({}, 'trailing-prose');
  transcript.append(milestone, trailing);
  const overview = h.makeElement({ readerCollaborationOverview: '' });
  overview.tagName = 'DETAILS';
  overview.open = true;
  const branch = h.makeElement({}, 'child-branch');
  branch.className = 'reader-branch';
  branch.tagName = 'DETAILS';
  branch.open = true;
  const branchBody = h.makeElement({});
  branchBody.className = 'reader-branch-body';
  const opener = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
  opener.href = '/fixture/session/child';
  branchBody.append(opener);
  branch.append(branchBody);
  overview.append(branch);
  h.root.append(transcript, overview);
  h.window.scrollY = 640;
  opener.focus();

  await h.click(opener);
  await h.flush();

  const wrapper = h.child.parentElement;
  assert.equal(wrapper.className, 'reader-inline-pane');
  assert.equal(wrapper.parentElement, milestoneBody, 'The child belongs to the matching task card');
  assert.equal(wrapper.dataset.readerInlineAttached, 'true');
  assert.equal(milestoneBody.children[1], wrapper, 'The child follows the card action directly');
  assert.equal(transcript.children[1], trailing, 'Existing prose order remains intact');
  assert.equal(wrapper.querySelector('.reader-inline-pane-title'), null, 'The task card already identifies its child');
  assert.equal(wrapper.querySelector('.reader-ancestor-path'), null, 'First-level attached history needs no duplicate breadcrumb');
  assert.equal(opener.getAttribute('aria-expanded'), 'true');
  assert.equal(overview.open, false, 'Opening the child closes the collaboration overview');
  assert.equal(h.document.activeElement, h.child, 'The opened history is revealed in the main reading flow');

  const close = wrapper.querySelector('[data-reader-inline-close]');
  await close.dispatchEvent({ type: 'click', preventDefault() {} });
  await h.flush();
  assert.equal(overview.open, true, 'Closing the child restores the collaboration opener');
  assert.equal(branch.open, true, 'Both nested disclosures are visible again');
  assert.equal(h.window.scrollY, 640);
  assert.equal(h.document.activeElement, opener, 'Closing the child restores opener focus');
  assert.equal(opener.getAttribute('aria-expanded'), 'false');
});

test('the task-card opener toggles its attached child without changing its standalone link', async (t) => {
  const h = readerHarness(t);
  const milestone = h.makeElement({ readerMilestone: '' });
  const body = h.makeElement();
  body.className = 'reader-milestone-body';
  const opener = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
  opener.href = '/fixture/session/child';
  body.append(opener);
  milestone.append(body);
  h.root.append(milestone);
  opener.focus();

  await h.click(opener);
  await h.flush();
  const wrapper = h.child.parentElement;
  assert.equal(wrapper.parentElement, body);
  assert.equal(wrapper.querySelector('.reader-inline-pane-standalone').href, '/fixture/session/child');
  assert.equal(opener.getAttribute('aria-expanded'), 'true');

  await h.click(opener);
  await h.flush();
  assert.deepEqual(h.reader.getInlinePanes(), []);
  assert.equal(body.children.length, 1);
  assert.equal(opener.getAttribute('aria-expanded'), 'false');
  assert.equal(h.document.activeElement, opener);
});

test('browser Back reopens saved focus ancestors before restoring the collaboration opener', async (t) => {
  const h = readerHarness(t);
  const overview = h.makeElement({ readerCollaborationOverview: '' });
  overview.tagName = 'DETAILS';
  overview.open = true;
  const branch = h.makeElement({}, 'child-branch');
  branch.className = 'reader-branch';
  branch.tagName = 'DETAILS';
  branch.open = true;
  const body = h.makeElement({});
  body.className = 'reader-branch-body';
  const opener = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' }, 'child-opener');
  opener.href = '/fixture/session/child';
  body.append(opener);
  branch.append(body);
  overview.append(branch);
  h.root.append(overview);
  h.window.scrollY = 640;
  opener.focus();

  await h.click(opener);
  await h.flush();
  assert.equal(overview.open, false, 'opening the child closes the collaboration overview');

  branch.open = false;
  await h.browserBack();

  assert.equal(h.window.scrollY, 640);
  assert.equal(h.document.activeElement, opener, 'Back restores the exact saved opener focus');
  assert.equal(overview.open, true, 'Back reopens the saved overview ancestor');
  assert.equal(branch.open, true, 'Back reopens nested disclosure ancestors');
});

test('browser Back restores a collaboration source link after it opens recorded child history', async (t) => {
  const h = readerHarness(t);
  h.addRecordedChild();
  const overview = h.makeElement({ readerCollaborationOverview: '' });
  overview.tagName = 'DETAILS';
  overview.open = true;
  const team = h.makeElement();
  team.tagName = 'DETAILS';
  team.open = true;
  const source = h.makeElement({
    readerSource: '', readerProvider: 'fixture', readerSession: 'child', readerAnchor: 'child-source'
  }, 'team-history-child');
  source.href = '/fixture/session/child#child-source';
  team.append(source);
  overview.append(team);
  h.root.append(overview);
  h.window.scrollY = 720;
  source.focus();

  await h.click(source);
  await h.flush();
  assert.deepEqual(h.reader.getInlinePanes(), [h.child]);
  assert.equal(overview.open, false, 'Opening the child closes the collaboration overview');

  await h.browserBack();

  assert.equal(h.window.scrollY, 720);
  assert.equal(h.document.activeElement, source, 'Back restores the source link instead of the removed child pane');
  assert.equal(overview.open, true, 'Back reopens the collaboration overview containing the source link');
  assert.equal(team.open, true, 'Back reopens the nested team details containing the source link');
});

test('inline close restores the collaboration source that launched recorded child history', async (t) => {
  const h = readerHarness(t);
  h.addRecordedChild();
  const overview = h.makeElement({ readerCollaborationOverview: '' });
  overview.tagName = 'DETAILS';
  overview.open = true;
  const team = h.makeElement();
  team.tagName = 'DETAILS';
  team.open = true;
  const source = h.makeElement({
    readerSource: '', readerProvider: 'fixture', readerSession: 'child', readerAnchor: 'child-source'
  }, 'team-history-child');
  source.href = '/fixture/session/child#child-source';
  team.append(source);
  overview.append(team);
  h.root.append(overview);
  h.window.scrollY = 720;
  source.focus();

  await h.click(source);
  await h.flush();
  assert.deepEqual(h.reader.getInlinePanes(), [h.child]);
  assert.equal(overview.open, false, 'Opening the child closes the collaboration overview');

  team.open = false;
  await h.child.parentElement.querySelector('[data-reader-inline-close]').dispatchEvent({ type: 'click', preventDefault() {} });
  await h.flush();

  assert.deepEqual(h.reader.getInlinePanes(), []);
  assert.equal(h.window.scrollY, 720);
  assert.equal(h.document.activeElement, source, 'Close restores the initiating Team history link, not the generic child opener');
  assert.equal(overview.open, true, 'Close reopens the collaboration overview containing the Team detail');
  assert.equal(team.open, true, 'Close reopens the Team detail containing the source link');
});

test('source reveal keeps an open collaboration overview while exposing prose', async (t) => {
  const h = readerHarness(t);
  const overview = h.makeElement({ readerCollaborationOverview: '' });
  overview.tagName = 'DETAILS';
  overview.open = true;
  const source = h.makeElement({ readerSource: '', readerProvider: 'fixture', readerSession: 'root', readerAnchor: 'root-source' });
  source.href = '/fixture/session/root#root-source';
  overview.append(source);
  h.root.append(overview);

  await h.click(source);

  assert.equal(overview.open, true, 'locating the source preserves the panel state');
  assert.equal(h.document.activeElement.id, 'root-source');
});

test('an unplaced collaboration child is appended at the conversation layout end', async (t) => {
  const h = readerHarness(t);
  const transcript = h.makeElement({ readerTranscript: '' });
  const layout = h.makeElement({ conversationLayout: '' });
  const threadColumn = h.makeElement({}, 'conversation-thread-col');
  const existing = h.makeElement({}, 'existing-prose');
  threadColumn.append(existing);
  layout.append(threadColumn);
  transcript.append(layout);
  const overview = h.makeElement({ readerCollaborationOverview: '' });
  const branch = h.makeElement({}, 'unplaced-branch');
  branch.className = 'reader-branch-body';
  const opener = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
  opener.href = '/fixture/session/child';
  branch.append(opener);
  overview.append(branch);
  h.root.append(transcript, overview);

  await h.click(opener);
  await h.flush();

  assert.equal(layout.children[0], threadColumn);
  assert.equal(layout.children[1], h.child.parentElement, 'Unplaced history follows the main conversation layout');
  assert.equal(h.child.parentElement.parentElement, layout);
});

test('a recorded child ToC control without a milestone opens inline at the transcript end', async (t) => {
  const h = readerHarness(t);
  const transcript = h.makeElement({ readerTranscript: '' });
  const layout = h.makeElement({ conversationLayout: '' });
  const prose = h.makeElement({}, 'last-prose');
  layout.append(prose);
  transcript.append(layout);
  const toc = h.makeElement();
  toc.className = 'session-toc';
  const open = h.addRecordedChild(toc);
  h.root.append(transcript, toc);
  h.root.dataset.searchQuery = 'root reading';
  h.window.scrollY = 1180;
  open.focus();

  await h.click(open);
  await h.flush();

  assert.equal(h.reader.getActivePane(), h.root);
  assert.deepEqual(h.reader.getInlinePanes(), [h.child]);
  assert.deepEqual(layout.children, [prose, h.child.parentElement]);
  assert.equal(h.location.pathname, '/fixture/session/root');
  assert.equal(parseReaderLocation(h.location).source.pathname, '/fixture/session/child');
  assert.equal(h.child.parentElement.querySelector('.reader-inline-pane-placement').textContent, 'No recorded position');
  assert.equal(h.root.dataset.searchQuery, 'root reading');
  assert.deepEqual(h.navigations, []);
  await h.child.parentElement.querySelector('[data-reader-inline-close]').dispatchEvent({ type: 'click', preventDefault() {} });
  await h.flush();
  assert.equal(h.window.scrollY, 1180);
  assert.equal(h.document.activeElement, open);
});

test('reload keeps canonical collaboration origins for child insertion and close restoration', async (t) => {
  const addCollaborationMarkup = (h) => {
    const transcript = h.makeElement({ readerTranscript: '' });
    const layout = h.makeElement({ conversationLayout: '' });
    const threadColumn = h.makeElement({}, 'conversation-thread-col');
    const milestone = h.makeElement({ readerMilestone: '' }, 'canonical-milestone');
    const milestoneLink = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
    milestoneLink.href = '/fixture/session/child#child-source';
    milestone.append(milestoneLink);
    threadColumn.append(milestone);
    layout.append(threadColumn);
    transcript.append(layout);

    const overview = h.makeElement({ readerCollaborationOverview: '' });
    overview.tagName = 'DETAILS';
    const branch = h.makeElement({ readerBranch: '', readerBranchProvider: 'fixture', readerBranchSession: 'child' });
    branch.tagName = 'DETAILS';
    branch.className = 'reader-branch';
    const branchBody = h.makeElement({}, 'branch-body');
    branchBody.className = 'reader-branch-body';
    const opener = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
    opener.href = '/fixture/session/child';
    branchBody.append(opener);
    branch.append(branchBody);
    overview.append(branch);
    h.root.append(transcript, overview);
    return { layout, threadColumn, milestone, overview, branch, opener };
  };

  const first = readerHarness(t);
  const firstMarkup = addCollaborationMarkup(first);
  first.window.scrollY = 1440;
  firstMarkup.opener.focus();
  await first.click(firstMarkup.opener);
  await first.flush();
  const snapshot = first.snapshot();
  const serialized = snapshot.entries.at(-1).state.readerInline[0];
  assert.match(serialized.originAnchor, /^anchor:/);
  assert.match(serialized.originReturnAnchor, /^branch:/);

  const reloaded = readerHarness(t, snapshot.entries.at(-1).href, [], {
    browserSnapshot: snapshot, initialRootSession: 'root', markup: addCollaborationMarkup
  });
  const reloadedMarkup = reloaded.initialMarkup;
  await reloaded.flush();
  assert.equal(reloadedMarkup.threadColumn.children[1], reloaded.child.parentElement, 'Reload uses the canonical milestone anchor');

  const close = reloaded.child.parentElement.querySelector('[data-reader-inline-close]');
  await close.dispatchEvent({ type: 'click', preventDefault() {} });
  await reloaded.flush();
  assert.equal(reloadedMarkup.overview.open, true);
  assert.equal(reloadedMarkup.branch.open, true);
  assert.equal(reloaded.window.scrollY, 1440);
  assert.equal(reloaded.document.activeElement, reloadedMarkup.opener);
});

test('reload state restores inline children when the document root matches its serialized owner', async (t) => {
  const eventId = 'event:reload-child:1';
  const event = { ok: true, evidence: { eventId }, html: `event:${eventId}` };
  const first = readerHarness(t, undefined, [[eventId, event]]);
  const open = first.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
  open.href = '/fixture/session/child';
  first.root.append(open);
  first.window.scrollY = 1540;
  first.root.children[0].focus();
  await first.click(open);
  const source = first.makeElement({ readerEventSource: '', readerProvider: 'fixture', readerSession: 'child', readerEventId: eventId });
  source.href = `/fixture/session/child?readerEvent=${encodeURIComponent(eventId)}`;
  first.child.append(source);
  await first.click(source);
  const snapshot = first.snapshot();
  assert.equal(snapshot.entries.at(-1).state.readerInlineRoot.session, 'root');

  const reloaded = readerHarness(t, snapshot.entries[1].href, [[eventId, event]], {
    browserSnapshot: { entries: snapshot.entries, index: 1 }, initialRootSession: 'root',
    markup: ({ addRecordedChild }) => addRecordedChild()
  });
  await reloaded.flush();
  assert.equal(reloaded.reader.getActivePane(), reloaded.root, 'Reload keeps the document root owner');
  assert.deepEqual(reloaded.reader.getInlinePanes(), [reloaded.child], 'Reload reapplies the serialized child stack');
  await reloaded.browserBack();
  assert.deepEqual(reloaded.reader.getInlinePanes(), []);
  assert.equal(reloaded.window.scrollY, 1540, 'Back after reload restores the serialized root position');
  assert.equal(reloaded.document.activeElement, reloaded.root.children[0]);
});

test('a copied child location rebuilds the recorded child without browser history state', async (t) => {
  const markup = ({ addRecordedChild }) => ({ open: addRecordedChild() });
  const first = readerHarness(t, undefined, [], { markup });
  await first.click(first.initialMarkup.open);
  const copiedHref = first.location.href;
  assert.equal(parseReaderLocation(copiedHref).source.pathname, '/fixture/session/child');
  const copied = readerHarness(t, copiedHref, [], { markup });
  await copied.flush();
  assert.equal(copied.reader.getActivePane(), copied.root);
  assert.deepEqual(copied.reader.getInlinePanes(), [copied.child]);
  assert.equal(copied.document.activeElement, copied.child);
  assert.equal(copied.location.pathname, '/fixture/session/root');
  assert.deepEqual(copied.requests, ['/api/fixture/session/child/reader']);
  assert.equal(copied.snapshot().entries.length, 1, 'Restoring a copied location adds no history entry');
  assert.deepEqual(copied.navigations, []);
  const ancestorReturn = copied.child.parentElement.querySelector('[data-reader-ancestor-return]');
  await ancestorReturn.dispatchEvent({ type: 'click' });
  await copied.flush();
  assert.deepEqual(copied.reader.getInlinePanes(), []);
  assert.equal(copied.document.activeElement, copied.initialMarkup.open);
  assert.equal(copied.window.scrollY, 50, 'Without a saved position, return reveals the recorded opener');
});

test('copied grandchild native and scalar sources rebuild their recorded ancestor path', async (t) => {
  for (const kind of ['native', 'scalar']) await t.test(kind, async (t) => {
    const eventId = 'event:grandchild/completed:1';
    const event = { ok: true, evidence: { eventId }, html: `event:${eventId}` };
    const markup = ({ root, child, makePane, makeElement, addRecordedChild }) => {
      const grandchild = makePane('grandchild');
      const openChild = addRecordedChild();
      const openGrandchild = addRecordedChild(child, 'grandchild');
      const sourceLinks = [root, child, grandchild].map((pane) => {
        pane.children[0].id = 'shared-source';
        const source = makeElement({ readerSource: '' });
        source.href = '#shared-source';
        pane.append(source);
        return source;
      });
      const scalar = makeElement({ readerEventSource: '', readerProvider: 'fixture', readerSession: 'grandchild', readerEventId: eventId });
      scalar.href = `/fixture/session/grandchild?readerEvent=${encodeURIComponent(eventId)}`;
      grandchild.append(scalar);
      return { grandchild, openChild, openGrandchild, sourceLinks, scalar };
    };
    const first = readerHarness(t, undefined, [[eventId, event]], { markup });
    await first.click(first.initialMarkup.openChild);
    await first.click(first.initialMarkup.openGrandchild);
    await first.click(kind === 'native' ? first.initialMarkup.sourceLinks[2] : first.initialMarkup.scalar);
    const copiedHref = first.location.href;
    const locator = parseReaderLocation(copiedHref);
    assert.equal(locator.source.pathname, '/fixture/session/grandchild');
    assert.deepEqual(locator.ancestors.map((ancestor) => ancestor.session), ['child']);

    const copied = readerHarness(t, copiedHref, [[eventId, event]], { markup });
    await copied.flush();
    const { grandchild, sourceLinks } = copied.initialMarkup;
    assert.equal(copied.reader.getActivePane(), copied.root);
    assert.deepEqual(copied.reader.getInlinePanes(), [copied.child, grandchild]);
    assert.equal(copied.location.pathname, '/fixture/session/root');
    assert.equal(copied.location.hash, '', 'The native source fragment belongs inside the locator');
    assert.equal(copied.document.activeElement.closest('[data-reader-pane]'), grandchild);
    assert.equal(kind === 'native' ? copied.document.activeElement.dataset.readerCanonicalAnchor
      : copied.document.activeElement.dataset.readerEventId, kind === 'native' ? 'shared-source' : eventId);
    const ids = copied.document.querySelector().querySelectorAll('[id]').map((element) => element.id);
    assert.equal(new Set(ids).size, ids.length, 'All mounted panes have unique DOM IDs');
    assert.deepEqual(sourceLinks.map((link) => new URL(link.getAttribute('href'), copied.location).pathname), [
      '/fixture/session/root', '/fixture/session/child', '/fixture/session/grandchild'
    ], 'Source links keep canonical owner URLs for opening separately');
    assert.ok(sourceLinks.every((link) => new URL(link.getAttribute('href'), copied.location).hash === '#shared-source'));
    assert.deepEqual(copied.requests, [
      '/api/fixture/session/child/reader', '/api/fixture/session/grandchild/reader',
      ...(kind === 'scalar' ? [`/api/fixture/session/grandchild/reader/event/${encodeURIComponent(eventId)}`] : [])
    ]);
    assert.equal(copied.snapshot().entries.length, 1);
    assert.deepEqual(copied.navigations, []);
  });
});

test('a missing recorded control falls back to the canonical source document', async (t) => {
  const source = 'http://localhost/fixture/session/child?readerEvent=event%3Amissing#recorded-source';
  const href = createReaderLocation('http://localhost/fixture/session/root?view=history', source);
  const h = readerHarness(t, href);
  await h.flush();
  assert.equal(h.reader.getActivePane(), h.root);
  assert.deepEqual(h.reader.getInlinePanes(), []);
  assert.deepEqual(h.requests, [], 'An unrecorded relation never triggers a pane or event fetch');
  assert.deepEqual(h.navigations, [{ type: 'assign', href: source }]);
});

test('a missing recorded grandchild control stops reconstruction at its verified parent', async (t) => {
  const source = 'http://localhost/fixture/session/grandchild#recorded-source';
  const href = createReaderLocation('http://localhost/fixture/session/root', source, ['/fixture/session/child']);
  const h = readerHarness(t, href, [], { markup: ({ addRecordedChild }) => addRecordedChild() });
  await h.flush();
  assert.deepEqual(h.requests, ['/api/fixture/session/child/reader']);
  assert.deepEqual(h.reader.getInlinePanes(), [h.child]);
  assert.deepEqual(h.navigations, [{ type: 'assign', href: source }]);
});

test('invalid or external reader locators do not fetch panes or navigate', async (t) => {
  for (const source of [
    'https://example.com/fixture/session/child',
    'http://user@localhost/fixture/session/child',
    '/fixture/session/child%',
    '/fixture/session/child?readerSource=%2Ffixture%2Fsession%2Fgrandchild'
  ]) await t.test(source, async (t) => {
    const url = new URL('http://localhost/fixture/session/root');
    url.searchParams.set('readerSource', source);
    const h = readerHarness(t, url.href, [], { markup: ({ addRecordedChild }) => addRecordedChild() });
    await h.flush();
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.navigations, []);
    assert.deepEqual(h.reader.getInlinePanes(), []);
    assert.equal(h.reader.getActivePane(), h.root);
    assert.equal(h.status.dataset.readerStatus, 'error');
  });
});

test('Back from a standalone child document reloads the earlier root document', async (t) => {
  const rootHref = 'http://localhost/fixture/session/root?view=history#root-source';
  const childHref = 'http://localhost/fixture/session/child';
  const reloaded = readerHarness(t, childHref, [], {
    browserSnapshot: {
      entries: [{ href: rootHref, state: null }, { href: childHref, state: null }], index: 1
    }
  });
  await reloaded.flush();
  await reloaded.browserBack();
  assert.equal(reloaded.workbenchSession(), 'child');
  assert.equal(reloaded.reader.getActivePane(), reloaded.child);
  assert.deepEqual(reloaded.navigations, [{ type: 'reload', href: rootHref }]);
  assert.deepEqual(reloaded.requests, []);
});

test('nested inline children relocate cached panes and scoped source links stay in their child', async (t) => {
  const h = readerHarness(t);
  const first = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
  first.href = '/fixture/session/child';
  h.root.append(first);
  await h.click(first);
  const nested = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'grandchild' });
  nested.href = '/fixture/session/grandchild';
  h.child.append(nested);
  const grandchild = h.makePane('grandchild');
  h.paneResponses.set('grandchild', { ok: true, html: 'pane:grandchild' });
  await h.click(nested);
  await h.flush();
  assert.deepEqual(h.reader.getInlinePanes(), [h.child, grandchild]);
  assert.notEqual(h.child.querySelector('[data-reader-canonical-anchor="child-source"]'), grandchild.querySelector('[data-reader-canonical-anchor="grandchild-source"]'));
  const source = h.makeElement({ readerSource: '', readerProvider: 'fixture', readerSession: 'child', readerAnchor: 'child-source' });
  source.href = '/fixture/session/child#child-source';
  h.child.append(source);
  await h.click(source);
  assert.equal(h.reader.getActivePane(), h.root);
  assert.equal(h.document.activeElement.dataset.readerCanonicalAnchor, 'child-source');
  assert.equal(h.document.activeElement.parentElement, h.child);
});

test('ancestor paths close descendants and restore each opener without losing retained history', async (t) => {
  const h = readerHarness(t, undefined, [], { narrow: true });
  const openChild = h.addRecordedChild();
  h.window.scrollY = 240;
  openChild.focus();
  await h.click(openChild);
  await h.flush();
  const openGrandchild = h.addRecordedChild(h.child, 'grandchild');
  const grandchild = h.makePane('grandchild');
  const retainedTool = h.makeElement({});
  retainedTool.tagName = 'DETAILS';
  retainedTool.open = true;
  h.child.append(retainedTool);
  h.window.scrollY = 860;
  openGrandchild.focus();
  await h.click(openGrandchild);
  await h.flush();

  const path = grandchild.parentElement.querySelector('.reader-ancestor-path');
  const returns = path.querySelectorAll('[data-reader-ancestor-return]');
  assert.equal(path.getAttribute('aria-label'), 'History path');
  assert.deepEqual(returns.map((button) => button.textContent), ['root', 'child']);
  assert.equal(path.lastElementChild.getAttribute('aria-current'), 'location');
  assert.equal(path.lastElementChild.textContent, 'grandchild');
  await returns[1].dispatchEvent({ type: 'click' });
  await h.flush();
  assert.deepEqual(h.reader.getInlinePanes(), [h.child]);
  assert.equal(h.document.activeElement, openGrandchild);
  assert.equal(h.window.scrollY, 860);
  assert.equal(retainedTool.open, true);
  assert.equal(h.location.pathname, '/fixture/session/root');

  await h.browserBack();
  assert.deepEqual(h.reader.getInlinePanes(), [h.child, grandchild]);
  const rootReturn = grandchild.parentElement.querySelector('[data-reader-ancestor-return]');
  await rootReturn.dispatchEvent({ type: 'click' });
  await h.flush();
  assert.deepEqual(h.reader.getInlinePanes(), []);
  assert.equal(h.document.activeElement, openChild);
  assert.equal(h.window.scrollY, 240);
  await h.browserBack();
  assert.deepEqual(h.reader.getInlinePanes(), [h.child, grandchild]);
  assert.equal(retainedTool.open, true);
  await h.browserForward();
  assert.deepEqual(h.reader.getInlinePanes(), []);
  assert.deepEqual(h.requests, ['/api/fixture/session/child/reader', '/api/fixture/session/grandchild/reader']);
});

test('inline scoping rewrites no-id local links, IDREFs, and the pane self-anchor', async (t) => {
  const h = readerHarness(t);
  h.child.id = 'session-messages';
  const local = h.makeElement();
  local.href = '#child-source';
  const label = h.makeElement();
  label.setAttribute('aria-controls', 'session-messages child-source');
  h.child.append(local, label);
  const open = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
  open.href = '/fixture/session/child';
  h.root.append(open);
  await h.click(open);
  const scoped = h.child.querySelector('[data-reader-canonical-anchor="child-source"]');
  assert.equal(decodeURIComponent(local.getAttribute('href').slice(1)), scoped.id);
  assert.equal(label.getAttribute('aria-controls'), `${h.child.id} ${scoped.id}`);
  assert.equal(readerPaneAnchor(h.child, 'session-messages'), h.child);
});

test('Back while an inline pane is loading prevents the stale response from mounting', async (t) => {
  const h = readerHarness(t);
  const link = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
  link.href = '/fixture/session/child';
  h.root.append(link);
  let resolveChild;
  h.paneResponses.set('child', new Promise((resolve) => { resolveChild = resolve; }));
  const pending = h.click(link);
  await h.browserBack();
  resolveChild({ ok: true, html: 'pane:child' });
  await pending;
  await h.flush();
  assert.deepEqual(h.reader.getInlinePanes(), []);
  assert.equal(h.reader.getActivePane(), h.root);
});

test('repeated pending opens of the same child retain the mounted pane after an older response arrives', async (t) => {
  const h = readerHarness(t);
  const opener = h.addRecordedChild();
  const stalePane = h.makePane('child-old-response');
  const currentPane = h.makePane('child-current-response');
  let resolveOlder;
  let resolveCurrent;
  h.paneResponses.set('child', new Promise((resolve) => { resolveOlder = resolve; }));
  const older = h.click(opener);
  h.paneResponses.set('child', new Promise((resolve) => { resolveCurrent = resolve; }));
  const current = h.click(opener);
  resolveCurrent({ ok: true, html: 'pane:child-current-response' });
  await current;
  await h.flush();
  assert.deepEqual(h.reader.getInlinePanes(), [currentPane]);
  assert.equal(h.cached('child').pane, currentPane);

  resolveOlder({ ok: true, html: 'pane:child-old-response' });
  await older;
  await h.flush();
  assert.deepEqual(h.reader.getInlinePanes(), [currentPane]);
  assert.equal(h.cached('child').pane, currentPane, 'The late response must not replace the mounted pane cache');
  assert.equal(stalePane.isConnected, false);
  const source = h.makeElement({ readerSource: '', readerProvider: 'fixture', readerSession: 'child', readerAnchor: 'child-current-response-source' });
  source.href = '/fixture/session/child#child-current-response-source';
  currentPane.append(source);
  await h.click(source);
  assert.equal(h.document.activeElement, currentPane.children[0], 'Subsequent source links resolve through the same mounted pane');
  assert.equal(parseReaderLocation(h.location).source.hash, '#child-current-response-source');
});

test('one cached child pane relocates when a second explicit origin opens it', async (t) => {
  const h = readerHarness(t);
  const makeOrigin = () => {
    const origin = h.makeElement();
    origin.tagName = 'P';
    const link = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
    link.href = '/fixture/session/child';
    origin.append(link);
    h.root.append(origin);
    return { origin, link };
  };
  const first = makeOrigin();
  const second = makeOrigin();
  await h.click(first.link);
  const firstPane = h.reader.getInlinePanes()[0];
  await h.browserBack();
  await h.browserForward();
  assert.ok(h.root.children.indexOf(firstPane.parentElement) > h.root.children.indexOf(first.origin), 'Forward restores a no-id origin marker');
  await h.click(second.link);
  assert.deepEqual(h.reader.getInlinePanes(), [firstPane]);
  assert.equal(firstPane.parentElement.parentElement, h.root);
  assert.ok(h.root.children.indexOf(firstPane.parentElement) > h.root.children.indexOf(second.origin));
});

test('closing an inline child after an event jump removes the child and nested state', async (t) => {
  const h = readerHarness(t);
  const open = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
  open.href = '/fixture/session/child';
  h.root.append(open);
  await h.click(open);
  const eventId = 'event:inline-close:1';
  h.eventResponses.set(eventId, { ok: true, evidence: { eventId }, html: `event:${eventId}` });
  const source = h.makeElement({ readerEventSource: '', readerProvider: 'fixture', readerSession: 'child', readerEventId: eventId });
  source.href = `/fixture/session/child?readerEvent=${encodeURIComponent(eventId)}`;
  h.child.append(source);
  await h.click(source);
  const close = h.child.parentElement.querySelector('[data-reader-inline-close]');
  await close.dispatchEvent({ type: 'click', preventDefault() {} });
  await h.flush();
  assert.deepEqual(h.reader.getInlinePanes(), []);
  assert.equal(h.reader.getActivePane(), h.root);
  assert.equal(h.window.scrollY, 0);
});

test('an ancestor open link never moves the mounted root into its own child pane', async (t) => {
  const h = readerHarness(t);
  const openChild = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
  openChild.href = '/fixture/session/child';
  h.root.append(openChild);
  await h.click(openChild);
  const openRoot = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'root' });
  openRoot.href = '/fixture/session/root';
  h.child.append(openRoot);
  await h.click(openRoot);
  assert.equal(h.reader.getActivePane(), h.root);
  assert.deepEqual(h.reader.getInlinePanes(), [h.child]);
  assert.equal(h.document.activeElement, h.root, 'An ancestor open action reveals the mounted parent pane');
});

test('a root source action cancels a pending inline child before it can commit', async (t) => {
  const h = readerHarness(t);
  const open = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
  open.href = '/fixture/session/child';
  h.root.append(open);
  let resolveChild;
  h.paneResponses.set('child', new Promise((resolve) => { resolveChild = resolve; }));
  const pending = h.click(open);
  const source = h.makeElement({ readerSource: '', readerProvider: 'fixture', readerSession: 'root', readerAnchor: 'root-source' });
  source.href = '/fixture/session/root#root-source';
  h.root.append(source);
  await h.click(source);
  resolveChild({ ok: true, html: 'pane:child' });
  await pending;
  await h.flush();
  assert.deepEqual(h.reader.getInlinePanes(), []);
  assert.equal(h.reader.getActivePane(), h.root);
  assert.equal(h.href(), '/fixture/session/root?view=history#root-source');
});

test('a child ToC reveal reports and mutates only the child pane', async (t) => {
  const h = readerHarness(t);
  const open = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
  open.href = '/fixture/session/child';
  h.root.append(open);
  h.window.scrollY = 730;
  open.focus();
  const toc = h.makeElement();
  toc.className = 'session-toc';
  const link = h.makeElement();
  link.setAttribute('href', '#child-source');
  link.href = 'http://localhost/fixture/session/child#child-source';
  toc.append(link);
  h.child.append(toc);
  await h.click(open);
  h.window.scrollY = 1800;
  await h.click(link);
  assert.equal(h.location.pathname, '/fixture/session/root');
  assert.equal(parseReaderLocation(h.location).source.pathname, '/fixture/session/child');
  assert.equal(parseReaderLocation(h.location).source.hash, '#child-source');
  assert.equal(new URL(link.getAttribute('href'), h.location).pathname, '/fixture/session/child',
    'The native source link retains its canonical owner for opening separately');
  assert.equal(h.document.activeElement.dataset.readerCanonicalAnchor, 'child-source');
  assert.equal(h.anchorReveals.at(-1).pane, h.child);
  await h.child.parentElement.querySelector('[data-reader-inline-close]').dispatchEvent({ type: 'click', preventDefault() {} });
  await h.flush();
  assert.equal(h.window.scrollY, 730, 'Close restores the parent origin, not the later child navigation position');
  assert.equal(h.document.activeElement, open);
});

test('root source navigation retains mounted child history across Back and Forward', async (t) => {
  const h = readerHarness(t);
  const open = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
  open.href = '/fixture/session/child';
  h.root.append(open);
  await h.click(open);
  const source = h.makeElement({ readerSource: '', readerProvider: 'fixture', readerSession: 'root', readerAnchor: 'root-source' });
  source.href = '/fixture/session/root#root-source';
  h.root.append(source);
  await h.click(source);
  assert.deepEqual(h.reader.getInlinePanes(), [h.child]);
  await h.browserBack();
  await h.browserForward();
  assert.deepEqual(h.reader.getInlinePanes(), [h.child]);
  assert.equal(h.document.activeElement, h.root.children[0]);
});

test('root event navigation cancels a pending inline child', async (t) => {
  const h = readerHarness(t);
  const open = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
  open.href = '/fixture/session/child';
  h.root.append(open);
  let resolveChild;
  h.paneResponses.set('child', new Promise((resolve) => { resolveChild = resolve; }));
  const pending = h.click(open);
  await h.source('root', 'root-event');
  resolveChild({ ok: true, html: 'pane:child' });
  await pending;
  assert.deepEqual(h.reader.getInlinePanes(), []);
});

test('unavailable native event source reports failure without throwing in its error handler', async (t) => {
  const h = readerHarness(t);
  const diagnostics = [];
  t.mock.method(console, 'error', (...args) => diagnostics.push(args));
  await h.source('root', 'missing-native', { partId: 'missing', anchor: 'missing' });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0][1].code, 'source_missing');
  assert.equal(h.reader.getActivePane(), h.root);
});

test('ToC A to B then browser Back and in-app Back restore exact reading locations', async (t) => {
  const h = readerHarness(t);
  const originHref = h.href();
  const toc = h.makeElement();
  toc.className = 'session-toc';
  const links = ['toc-A', 'toc-B'].map((id) => {
    const target = h.makeElement({}, id);
    const link = h.makeElement();
    link.href = `#${id}`;
    h.root.append(target);
    toc.append(link);
    return link;
  });
  h.root.append(toc);
  h.window.scrollY = 700;
  h.root.children[0].focus();
  await h.click(links[0]);
  h.window.scrollY = 1400;
  await h.click(links[1]);
  h.window.scrollY = 2800;
  await h.browserBack();
  assert.equal(h.href(), '/fixture/session/root?view=history#toc-A');
  assert.equal(h.window.scrollY, 1400);
  assert.equal(h.document.activeElement.id, 'toc-A');
  assert.equal(h.back.disabled, false);
  await h.back.dispatchEvent({ type: 'click' });
  await h.flush();
  assert.equal(h.href(), originHref);
  assert.equal(h.window.scrollY, 700);
  assert.equal(h.document.activeElement, h.root.children[0]);
  assert.equal(h.back.disabled, true);
  assert.equal(h.swaps.length, 0);
});

test('narrow root collaboration expansion survives inline child navigation and Back', async (t) => {
  const h = readerHarness(t, undefined, [], { narrow: true, collaboration: true });
  h.addRecordedChild();
  const rootPanel = h.root.querySelector('[data-reader-collaboration]');
  const rootToggle = h.root.querySelector('[data-reader-collaboration-toggle]');
  assert.equal(rootPanel.hidden, true);
  await h.click(rootToggle);
  assert.equal(rootPanel.hidden, false);
  await h.reader.openPane('fixture', 'child');
  await h.flush();
  assert.equal(h.reader.getActivePane(), h.root);
  assert.equal(rootPanel.hidden, false);
  await h.back.dispatchEvent({ type: 'click' });
  await h.flush();
  assert.equal(rootPanel.hidden, false);
  assert.equal(rootToggle.getAttribute('aria-expanded'), 'true');
  await h.click(rootToggle);
  await h.reader.openPane('fixture', 'child');
  await h.browserBack();
  assert.equal(rootPanel.hidden, true);
  await h.resize(false);
  assert.equal(rootPanel.hidden, false, 'Wide layouts keep collaboration visible');
  await h.resize(true);
  assert.equal(rootPanel.hidden, true, 'Returning to narrow retains this pane selection');
});

test('native collaboration defaults to dock on wide desktop and edge overlay otherwise', async (t) => {
  const storage = new Map();
  const h = readerHarness(t, undefined, [], { nativePanel: true, dock: true, panelStorage: storage });
  const overview = h.root.querySelector('[data-reader-collaboration-overview]');
  const toggle = h.document.querySelector().querySelector('[data-reader-collaboration-toggle]');
  assert.equal(h.document.querySelector('.session-workbench').dataset.readerPanelMode, 'dock');
  assert.equal(overview.open, true);
  assert.equal(toggle.getAttribute('aria-controls'), overview.id);
  await h.resizeDock(false);
  assert.equal(h.document.querySelector('.session-workbench').dataset.readerPanelMode, 'overlay');
  assert.equal(overview.open, false, 'a smaller desktop uses the closed edge launcher by default');
  await h.click(toggle);
  assert.equal(storage.get('agentsession.reader.collaboration-panel.v1'), 'open');
  overview.open = true; // reader-relations owns the disclosure transition.
  await h.resizeDock(true);
  assert.equal(overview.open, true, 'an explicit open choice survives resize');
  await h.click(toggle);
  assert.equal(storage.get('agentsession.reader.collaboration-panel.v1'), 'closed');
  overview.open = false; // reader-relations owns the disclosure transition.
  await h.resizeDock(false);
  await h.resizeDock(true);
  assert.equal(overview.open, false, 'an explicit close choice is not undone by width changes');
});

test('native collaboration restores an explicit saved choice on a new page', (t) => {
  const storage = new Map([['agentsession.reader.collaboration-panel.v1', 'closed']]);
  const h = readerHarness(t, undefined, [], { nativePanel: true, dock: true, panelStorage: storage });
  assert.equal(h.root.querySelector('[data-reader-collaboration-overview]').open, false);
  assert.equal(h.document.querySelector().querySelector('[data-reader-collaboration-toggle]').getAttribute('aria-expanded'), 'false');
});

test('edge launcher follows the attached child panel and carries explicit choice through Back', async (t) => {
  const h = readerHarness(t, undefined, [], { nativePanel: true, dock: true });
  h.addRecordedChild();
  const rootOverview = h.root.querySelector('[data-reader-collaboration-overview]');
  const childOverview = h.child.querySelector('[data-reader-collaboration-overview]');
  const toggle = h.document.querySelector().querySelector('[data-reader-collaboration-toggle]');
  assert.equal(rootOverview.open, true);
  await h.reader.openPane('fixture', 'child');
  await h.flush();
  assert.equal(childOverview.dataset.readerPanelActive, 'true');
  assert.equal(rootOverview.dataset.readerPanelActive, undefined);
  assert.equal(toggle.getAttribute('aria-controls'), childOverview.id);
  await h.click(toggle);
  assert.equal(h.panelStorage.get('agentsession.reader.collaboration-panel.v1'), 'closed');
  childOverview.open = false; // reader-relations closes the selected child panel.
  await h.back.dispatchEvent({ type: 'click' });
  await h.flush();
  assert.equal(rootOverview.dataset.readerPanelActive, 'true');
  assert.equal(rootOverview.open, false, 'explicit close is not undone on Back');
  assert.equal(toggle.getAttribute('aria-controls'), rootOverview.id);
});

test('checkpoint result anchors reserve the checkpoint heading above the sticky top bar', () => {
  const css = readFileSync(new URL('../src/static/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.compaction-checkpoint-result\s*>\s*\.context-result-disclosure\[id\]\s*\{[^}]*scroll-margin-top:\s*calc\(var\(--session-anchor-offset\) \+ 3rem\)/s);
});

test('inline child identifies itself inside its wrapper while the root keeps its document shell', async (t) => {
  const h = readerHarness(t);
  h.addRecordedChild();
  assert.equal(h.currentTitle.hidden, true, 'root pane does not duplicate the document title');
  await h.reader.openPane('fixture', 'child');
  await h.flush();
  assert.equal(h.currentTitle.textContent, 'root');
  assert.equal(h.currentTitle.hidden, true);
  assert.equal(h.child.parentElement.querySelector('.reader-inline-pane-title').textContent, 'child');
  assert.equal(h.workbenchSession(), 'root');
  await h.browserBack();
  assert.equal(h.currentTitle.hidden, true);
});

test('inherited continuation appends in its own disclosure and a detached response stays retryable', async (t) => {
  const h = readerHarness(t);
  h.addRecordedChild();
  await h.reader.openPane('fixture', 'child');
  const disclosure = h.makeElement({ inheritedContext: '' });
  const messages = h.makeElement({ inheritedContextMessages: '', messageCount: '40' });
  const count = h.makeElement();
  count.className = 'inherited-context-count';
  const button = h.makeElement({ inheritedContextMore: '', nextOffset: '40' });
  disclosure.append(messages);
  disclosure.append(count);
  disclosure.append(button);
  h.child.append(disclosure);
  let resolvePage;
  h.inheritedResponses.push(new Promise((resolve) => { resolvePage = resolve; }));
  const pending = h.click(button);
  assert.equal(button.disabled, true);
  await h.child.parentElement.querySelector('[data-reader-inline-close]').dispatchEvent({ type: 'click', preventDefault() {} });
  await h.flush();
  assert.deepEqual(h.reader.getInlinePanes(), []);
  resolvePage({ ok: true, html: 'event:inherited-page', shown: 80, nextOffset: 80, label: '80 of 81' });
  await pending;
  assert.equal(button.disabled, false);
  assert.equal(button.hasAttribute('aria-busy'), false);
  assert.equal(button.dataset.nextOffset, '40');
  assert.equal(messages.children.length, 0);
  await h.browserBack();
  h.inheritedResponses.push({ ok: true, html: 'event:inherited-page', shown: 80, nextOffset: 80, label: '80 of 81' });
  await h.click(button);
  assert.equal(messages.children.length, 1);
  assert.equal(messages.dataset.messageCount, '80');
  assert.equal(count.textContent, '80 of 81');
  assert.equal(button.dataset.nextOffset, '80');
  h.inheritedResponses.push({ ok: true, html: 'event:inherited-last', shown: 81, nextOffset: null, label: '81 of 81' });
  await h.click(button);
  assert.equal(messages.children.length, 2);
  assert.equal(messages.dataset.messageCount, '81');
  assert.equal(count.textContent, '81 of 81');
  assert.equal(disclosure.contains(button), false);
  await h.child.parentElement.querySelector('[data-reader-inline-close]').dispatchEvent({ type: 'click', preventDefault() {} });
  await h.flush();
  await h.browserBack();
  assert.equal(h.reader.getActivePane(), h.root);
  assert.deepEqual(h.reader.getInlinePanes(), [h.child]);
  assert.equal(messages.children.length, 2, 'Returning preserves loaded inherited content');
  assert.deepEqual(h.requests.filter((url) => url.includes('/inherited-context?')), [
    '/api/fixture/session/child/inherited-context?offset=40',
    '/api/fixture/session/child/inherited-context?offset=40',
    '/api/fixture/session/child/inherited-context?offset=80'
  ]);
});

test('mounted inherited pages scope copied IDs and IDREFs to their inline pane without rewriting unknown references', async (t) => {
  const h = readerHarness(t);
  h.root.append(h.makeElement({}, 'parent-message'));
  h.addRecordedChild();
  await h.reader.openPane('fixture', 'child');
  const disclosure = h.makeElement({ inheritedContext: '' });
  const messages = h.makeElement({ inheritedContextMessages: '', messageCount: '40' });
  const button = h.makeElement({ inheritedContextMore: '', nextOffset: '40' });
  disclosure.append(messages, button);
  h.child.append(disclosure);
  h.inheritedResponses.push({ ok: true, html: 'inherited:page', shown: 41, nextOffset: null, label: '41 of 41' });
  await h.click(button);
  const message = messages.querySelector('[data-part-id="parent-message:text"]');
  const known = message.children[0];
  const source = message.children[1];
  const scoped = `reader-scope-${encodeURIComponent('fixture\0child')}--parent-message`;
  assert.equal(message.id, scoped);
  assert.equal(message.dataset.readerCanonicalAnchor, 'parent-message');
  assert.equal(known.getAttribute('aria-labelledby'), `${scoped} unknown-source`);
  assert.equal(decodeURIComponent(source.getAttribute('href').slice(1)), scoped);
  assert.equal(h.root.querySelector('#parent-message').id, 'parent-message');
  assert.equal(message.closest('[data-reader-pane]'), h.child);
});
