import assert from 'node:assert/strict';
import test from 'node:test';
import { initSessionReader } from '../src/static/app/session-reader.js';
import { readerPaneAnchor } from '../src/static/app/reader-pane-dom.js';

function readerHarness(t, initialHref = '/fixture/session/root?view=history#root-source', initialEvents = [], {
  narrow = false, collaboration = false, browserSnapshot = null, initialRootSession = null
} = {}) {
  const location = new URL(initialHref, 'http://localhost');
  const frames = [];
  const requests = [];
  const panes = new Map();
  const eventResponses = new Map(initialEvents);
  const inheritedResponses = [];
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
      this.replaceChildren(html.startsWith('pane:')
        ? panes.get(html.slice('pane:'.length))
        : new Element({ readerEventEvidence: '', readerEventId: html.slice('event:'.length) }));
    }
  }

  const makePane = (session) => {
    const pane = new Element({ readerPane: '', readerProvider: 'fixture', readerSession: session, readerTitle: session });
    pane.append(new Element({}, `${session}-source`));
    if (collaboration) {
      pane.append(new Element({ readerCollaboration: '' }, `${session}-collaboration`));
      pane.append(new Element({ readerCollaborationToggle: '' }));
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
  const workbench = new Element({ provider: 'fixture', sessionId: documentRootSession });
  const currentTitle = new Element({ readerCurrentTitle: '' }, 'H1');
  currentTitle.textContent = 'Root document title';
  currentTitle.hidden = true;
  const swaps = [];
  const anchorReveals = [];
  workbench.addEventListener('session-reader:swapped', (event) => swaps.push(event.detail));
  workbench.addEventListener('session-reader:anchor-revealed', (event) => anchorReveals.push(event.detail));
  workbench.append(currentTitle);
  workbench.append(host);
  workbench.append(back);
  document = {
    activeElement: null,
    querySelector: () => workbench,
    getElementById: (id) => host.querySelector(`#${id}`),
    createElement: () => new Element()
  };
  window = new Element();
  const media = new Element();
  media.matches = narrow;
  Object.assign(window, {
    scrollX: 0,
    scrollY: 0,
    scrollTo({ top, left }) { this.scrollY = top; this.scrollX = left; },
    setTimeout() {},
    matchMedia: () => media
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
    fetch: async (url) => {
      requests.push(url);
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
  const reader = initSessionReader();
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
    reader, root, child, back, currentTitle, location, window, document, requests, makePane, flush, eventResponses, inheritedResponses, paneResponses, swaps, anchorReveals,
    makeElement: (dataset, id) => new Element(dataset, id),
    click,
    async resize(isNarrow) { media.matches = isNarrow; await media.dispatchEvent({ type: 'change' }); },
    browserBack: async () => { traverse(-1); await flush(); },
    browserForward: async () => { traverse(1); await flush(); },
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

test('reader browser Back/Forward then in-app Back restores the owning pane URL, scroll and focus', async (t) => {
  const h = readerHarness(t);
  const rootHref = h.href();
  const childHref = '/fixture/session/child?view=tools#child-source';
  await h.reader.openPane('fixture', 'child', { href: childHref });
  await h.flush();
  await h.browserBack();
  h.window.scrollY = 1300;
  h.root.children[0].focus();
  await h.browserForward();
  assert.equal(h.cached('root').href, rootHref);
  assert.equal(h.cached('child').href, childHref);
  await h.back.dispatchEvent({ type: 'click' });
  await h.flush();
  assert.equal(h.reader.getActivePane(), h.root);
  assert.equal(h.href(), rootHref);
  assert.equal(h.window.scrollY, 1300);
  assert.equal(h.document.activeElement, h.root.children[0]);
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

test('an uncached browser event destination loads its exact scalar evidence', async (t) => {
  const h = readerHarness(t);
  const eventId = 'event:child/completed:2';
  const href = `/fixture/session/child?readerEvent=${encodeURIComponent(eventId)}#reader-event-event-child-completed-2`;
  h.eventResponses.set(eventId, { ok: true, evidence: { eventId }, html: `event:${eventId}` });
  await h.pop(href);
  assert.equal(h.reader.getActivePane(), h.child);
  assert.equal(h.href(), href);
  assert.equal(h.document.activeElement.dataset.readerEventId, eventId);
  assert.equal(h.requests.length, 2, 'The target pane and exact event are loaded');
});

test('uncached browser navigation preserves the outgoing pane URL and records the selected query and hash', async (t) => {
  const h = readerHarness(t);
  const rootHref = h.href();
  const sibling = h.makePane('sibling');
  const siblingHref = '/fixture/session/sibling?view=events#sibling-source';
  await h.pop(siblingHref);
  assert.equal(h.reader.getActivePane(), sibling);
  assert.equal(h.cached('root').href, rootHref);
  assert.equal(h.cached('sibling').href, siblingHref);
  await h.pop('/fixture/session/root?view=work#root-source');
  await h.reader.openPane('fixture', 'child', { href: '/fixture/session/child' });
  await h.back.dispatchEvent({ type: 'click' });
  await h.flush();
  assert.equal(h.href(), '/fixture/session/root?view=work#root-source');
});

test('scalar event sources keep the exact event query and anchor for reload in the same or child pane', async (t) => {
  const h = readerHarness(t);
  for (const [session, eventId] of [['root', 'event:run/completed:1'], ['child', 'event:delivery:2']]) {
    await h.source(session, eventId);
    assert.equal(h.location.pathname, `/fixture/session/${session}`);
    assert.equal(h.location.searchParams.get('readerEvent'), eventId);
    assert.equal(h.location.hash, `#reader-event-${eventId.replace(/[^A-Za-z0-9_-]/g, '-')}`);
    assert.equal(h.document.activeElement.dataset.readerEventId, eventId);
  }
});

test('inline event source links keep the child owner URL for scalar and native evidence', async (t) => {
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
  assert.equal(h.location.pathname, '/fixture/session/child');
  assert.equal(h.location.searchParams.get('readerEvent'), scalarId);
  assert.equal(h.reader.getActivePane(), h.root);
  assert.deepEqual(h.reader.getInlinePanes(), [h.child]);

  h.child.children[0].dataset.partId = 'tool:native';
  const nativeId = 'event:inline/native:2';
  h.eventResponses.set(nativeId, { ok: true, evidence: { eventId: nativeId }, nativeTarget: { partId: 'tool:native', anchor: 'child-source' }, html: `event:${nativeId}` });
  const native = h.makeElement({ readerEventSource: '', readerProvider: 'fixture', readerSession: 'child', readerEventId: nativeId });
  native.href = `/fixture/session/child?readerEvent=${encodeURIComponent(nativeId)}`;
  h.child.append(native);
  await h.click(native);
  assert.equal(h.location.pathname, '/fixture/session/child');
  assert.equal(h.location.searchParams.get('readerEvent'), null);
  assert.equal(h.location.hash, '#child-source');
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
  assert.equal(h.href(), '/fixture/session/root#root-source');
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
  assert.equal(h.href(), '/fixture/session/root?view=history#root-source');
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
  const milestoneLink = h.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
  milestoneLink.href = '/fixture/session/child#child-source';
  milestone.append(milestoneLink);
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
  assert.equal(transcript.children[1], wrapper, 'The child follows the matching main-reading milestone');
  assert.equal(transcript.children[2], trailing, 'Existing prose order remains intact');
  assert.equal(overview.open, false, 'Opening the child closes the collaboration overview');
  assert.equal(h.document.activeElement, h.child, 'The opened history is revealed in the main reading flow');

  const close = wrapper.querySelector('[data-reader-inline-close]');
  await close.dispatchEvent({ type: 'click', preventDefault() {} });
  await h.flush();
  assert.equal(overview.open, true, 'Closing the child restores the collaboration opener');
  assert.equal(branch.open, true, 'Both nested disclosures are visible again');
  assert.equal(h.window.scrollY, 640);
  assert.equal(h.document.activeElement, opener, 'Closing the child restores opener focus');
});

test('source reveal closes an open collaboration overview before exposing prose', async (t) => {
  const h = readerHarness(t);
  const overview = h.makeElement({ readerCollaborationOverview: '' });
  overview.tagName = 'DETAILS';
  overview.open = true;
  const source = h.makeElement({ readerSource: '', readerProvider: 'fixture', readerSession: 'root', readerAnchor: 'root-source' });
  source.href = '/fixture/session/root#root-source';
  overview.append(source);
  h.root.append(overview);

  await h.click(source);

  assert.equal(overview.open, false);
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
    browserSnapshot: snapshot, initialRootSession: 'root'
  });
  const reloadedMarkup = addCollaborationMarkup(reloaded);
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
  await first.click(open);
  const source = first.makeElement({ readerEventSource: '', readerProvider: 'fixture', readerSession: 'child', readerEventId: eventId });
  source.href = `/fixture/session/child?readerEvent=${encodeURIComponent(eventId)}`;
  first.child.append(source);
  await first.click(source);
  const snapshot = first.snapshot();
  assert.equal(snapshot.entries.at(-1).state.readerInlineRoot.session, 'root');

  const reloaded = readerHarness(t, snapshot.entries[1].href, [[eventId, event]], {
    browserSnapshot: { entries: snapshot.entries, index: 1 }, initialRootSession: 'root'
  });
  await reloaded.flush();
  assert.equal(reloaded.reader.getActivePane(), reloaded.root, 'Reload keeps the document root owner');
  assert.deepEqual(reloaded.reader.getInlinePanes(), [reloaded.child], 'Reload reapplies the serialized child stack');
});

test('Back from a child document asks the browser to reload the missing serialized root', async (t) => {
  const eventId = 'event:reload-owner:1';
  const event = { ok: true, evidence: { eventId }, html: `event:${eventId}` };
  const first = readerHarness(t, undefined, [[eventId, event]]);
  const open = first.makeElement({ readerOpen: '', readerProvider: 'fixture', readerSession: 'child' });
  open.href = '/fixture/session/child';
  first.root.append(open);
  await first.click(open);
  const source = first.makeElement({ readerEventSource: '', readerProvider: 'fixture', readerSession: 'child', readerEventId: eventId });
  source.href = `/fixture/session/child?readerEvent=${encodeURIComponent(eventId)}`;
  first.child.append(source);
  await first.click(source);
  const snapshot = first.snapshot();
  const reloaded = readerHarness(t, first.location.href, [[eventId, event]], {
    browserSnapshot: snapshot, initialRootSession: 'child'
  });
  let reloads = 0;
  reloaded.location.reload = () => { reloads += 1; };
  await reloaded.flush();
  await reloaded.browserBack();
  assert.equal(reloaded.workbenchSession(), 'child');
  assert.equal(reloads, 1, 'A cross-document root restoration delegates to a full page reload');
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
  assert.equal(h.href(), '/fixture/session/root#root-source');
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
  assert.equal(h.location.pathname, '/fixture/session/child', 'Hash-only ToC links retain their pane owner in a real absolute href');
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

test('narrow collaboration expansion survives child navigation and Back per pane', async (t) => {
  const h = readerHarness(t, undefined, [], { narrow: true, collaboration: true });
  const rootPanel = h.root.querySelector('[data-reader-collaboration]');
  const rootToggle = h.root.querySelector('[data-reader-collaboration-toggle]');
  const childPanel = h.child.querySelector('[data-reader-collaboration]');
  assert.equal(rootPanel.hidden, true);
  await h.click(rootToggle);
  assert.equal(rootPanel.hidden, false);
  await h.reader.openPane('fixture', 'child');
  await h.flush();
  assert.equal(childPanel.hidden, true);
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

test('child pane updates the secondary pane label while the document owner title remains separate', async (t) => {
  const h = readerHarness(t);
  assert.equal(h.currentTitle.hidden, true, 'root pane does not duplicate the document title');
  await h.reader.openPane('fixture', 'child');
  await h.flush();
  assert.equal(h.currentTitle.textContent, 'child');
  assert.equal(h.currentTitle.hidden, false, 'child identity is shown in the secondary reader shell label');
  await h.browserBack();
  assert.equal(h.currentTitle.hidden, true);
});

test('inherited continuation appends in its own disclosure and a detached response stays retryable', async (t) => {
  const h = readerHarness(t);
  const disclosure = h.makeElement({ inheritedContext: '' });
  const messages = h.makeElement({ inheritedContextMessages: '', messageCount: '40' });
  const count = h.makeElement();
  count.className = 'inherited-context-count';
  const button = h.makeElement({ inheritedContextMore: '', nextOffset: '40' });
  disclosure.append(messages);
  disclosure.append(count);
  disclosure.append(button);
  h.root.append(disclosure);
  let resolvePage;
  h.inheritedResponses.push(new Promise((resolve) => { resolvePage = resolve; }));
  const pending = h.click(button);
  assert.equal(button.disabled, true);
  await h.reader.openPane('fixture', 'child');
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
  await h.reader.openPane('fixture', 'child');
  await h.browserBack();
  assert.equal(h.reader.getActivePane(), h.root);
  assert.equal(messages.children.length, 2, 'Returning preserves loaded inherited content');
  assert.deepEqual(h.requests.filter((url) => url.includes('/inherited-context?')), [
    '/api/fixture/session/root/inherited-context?offset=40',
    '/api/fixture/session/root/inherited-context?offset=40',
    '/api/fixture/session/root/inherited-context?offset=80'
  ]);
});
