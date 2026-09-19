import assert from 'node:assert/strict';
import test from 'node:test';
import { initReaderRelations } from '../src/static/app/reader-relations.js';

function relationHarness(t, entries, { narrow = false, selected = '', enabled = true } = {}) {
  class Element {
    constructor(dataset = {}, tagName = 'div') {
      this.dataset = dataset;
      this.tagName = tagName;
      this.children = [];
      this.listeners = new Map();
      this.attributes = new Map();
      this.classes = new Set();
      this.classList = { toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name) };
      this.style = { setProperty(name, value) { this[name] = value; } };
    }
    append(child) { child.parentElement = this; this.children.push(child); }
    replaceChildren(...children) { this.children = []; children.forEach((child) => this.append(child)); }
    remove() {
      if (!this.parentElement) return;
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      this.parentElement = null;
    }
    contains(child) { return child === this || this.children.some((entry) => entry.contains(child)); }
    matches(selector) {
      if (selector === 'option[value=""]') return this.tagName === 'option' && this.value === '';
      if (selector.startsWith('.')) return this.classes.has(selector.slice(1));
      const attribute = selector.match(/\[data-([a-z-]+)\]/)?.[1];
      return attribute ? attribute.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) in this.dataset : false;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    focus(options) { this.focusOptions = options; }
    addEventListener(type, callback) { this.listeners.set(type, [...this.listeners.get(type) || [], callback]); }
    dispatchEvent(event) { (this.listeners.get(event.type) || []).forEach((listener) => listener(event)); }
    get options() { return this.children; }
  }

  const makeSection = (items, selection = '') => {
    const pane = new Element({ readerPane: '' });
    const section = new Element({ readerRelations: '' });
    const select = new Element({ readerLaneSelect: '' }, 'select');
    const lanes = [...new Set(items.map((item) => item.lane))];
    for (const lane of [...(lanes.length <= 6 ? [''] : []), ...lanes]) {
      const option = new Element({}, 'option');
      option.value = lane;
      select.append(option);
    }
    select.value = selection || (lanes.length > 6 ? lanes[0] : '');
    section.append(select);
    const milestones = items.map(({ lane, kind, sequence, run = '' }) => {
      const milestone = new Element({ readerMilestone: '', readerLane: lane, readerKind: kind, readerSequence: String(sequence), readerRun: run });
      const body = new Element();
      body.classes.add('reader-milestone-body');
      const button = new Element({ readerLaneFocus: '' }, 'button');
      button.value = lane;
      body.append(button);
      milestone.append(body);
      section.append(milestone);
      return { milestone, body, button };
    });
    pane.append(section);
    const overview = new Element({ readerCollaborationOverview: '' }, 'details');
    overview.open = false;
    const activityDisclosure = new Element({ readerActivityDisclosure: '' }, 'details');
    activityDisclosure.open = false;
    overview.append(activityDisclosure);
    for (const lane of lanes) {
      const detail = new Element({ readerBranch: '', readerBranchKey: lane, readerTaskLane: lane }, 'details');
      detail.open = false;
      overview.append(detail);
    }
    const close = new Element({ readerCollaborationClose: '' }, 'button');
    overview.append(close);
    const summary = new Element({}, 'summary');
    summary.classes.add('reader-collaboration-overview-summary');
    overview.append(summary);
    pane.append(overview);
    return { pane, section, select, milestones, overview, close, summary, activityDisclosure };
  };
  const original = makeSection(entries, selected);
  const workbench = new Element();
  if (enabled) workbench.append(original.pane);
  const toggle = new Element({ readerCollaborationToggle: '' }, 'button');
  toggle.setAttribute('aria-expanded', 'false');
  workbench.append(toggle);
  const window = new Element();
  const media = new Element();
  media.matches = narrow;
  window.matchMedia = () => media;
  const observers = [];
  const frames = new Map();
  let frameId = 0;
  const globals = {
    document: { querySelector: () => workbench },
    window,
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
      observe(target) { this.targets.add(target); }
      unobserve(target) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
    }
  };
  for (const [key, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  initReaderRelations();
  const flush = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } };
  return {
    ...original, workbench, window, media, frames, observers, toggle, makeSection, flush, Element,
    selectLane(lane) { original.select.value = lane; workbench.dispatchEvent({ type: 'change', target: original.select }); flush(); },
    selectPaneLane(pane, lane) { pane.select.value = lane; workbench.dispatchEvent({ type: 'change', target: pane.select }); flush(); },
    resize(value) { media.matches = value; media.dispatchEvent({ type: 'change' }); flush(); },
    swap(pane) {
      workbench.dispatchEvent({ type: 'session-reader:before-swap' });
      workbench.replaceChildren(pane.pane || pane.section);
      workbench.dispatchEvent({ type: 'session-reader:swapped' });
      flush();
    },
    inlineOpen(pane) {
      workbench.append(pane.pane || pane.section);
      workbench.dispatchEvent({ type: 'session-reader:inline-opened', detail: { pane: pane.pane || pane.section } });
      flush();
    },
    inlineClose(pane) {
      const target = pane.pane || pane.section;
      target.remove();
      workbench.dispatchEvent({ type: 'session-reader:inline-closed', detail: { pane: target } });
      flush();
    }
  };
}

const entries = [
  { lane: 'child:implementation', kind: 'spawn', sequence: 45, run: 'run:one' },
  { lane: 'child:review', kind: 'delegate', sequence: 60, run: 'run:review' },
  { lane: 'child:implementation', kind: 'follow-up', sequence: 70, run: 'run:one' },
  { lane: 'child:implementation', kind: 'result-delivery', sequence: 136, run: 'run:one' },
  { lane: 'child:implementation', kind: 'follow-up', sequence: 140, run: 'run:two' },
  { lane: 'child:implementation', kind: 'result-delivery', sequence: 144, run: 'run:two' }
];

test('opening collaboration prioritizes task reading and loads the activity view only on demand', async (t) => {
  const h = relationHarness(t, entries);
  const host = new h.Element({ readerActivityHost: '/reader/activity', loadingLabel: 'Loading', errorLabel: 'Failed' });
  const status = new h.Element({ readerActivityStatus: '' });
  const content = new h.Element({ readerActivityView: '' });
  const retry = new h.Element({ readerActivityRetry: '' });
  for (const child of [status, content, retry]) host.append(child);
  h.activityDisclosure.append(host);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(url);
    return { ok: true, json: async () => ({ html: '' }) };
  });
  h.workbench.dispatchEvent({ type: 'click', target: h.toggle });
  assert.equal(h.overview.open, true);
  assert.equal(h.activityDisclosure.open, false);
  assert.equal(requests.length, 0);
  h.activityDisclosure.open = true;
  h.workbench.dispatchEvent({ type: 'toggle', target: h.activityDisclosure });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, ['/reader/activity?']);
  assert.equal(status.hidden, true);
  h.activityDisclosure.open = false;
  h.workbench.dispatchEvent({ type: 'toggle', target: h.activityDisclosure });
  h.activityDisclosure.open = true;
  h.workbench.dispatchEvent({ type: 'toggle', target: h.activityDisclosure });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
});

test('loaded process milestones receive the current task emphasis without changing nested panes', (t) => {
  const h = relationHarness(t, entries);
  h.selectLane('child:implementation');
  const old = h.milestones[0].milestone;
  old.remove();
  const replacement = h.makeSection([{ lane: 'child:implementation', kind: 'message', sequence: 46 }]).milestones[0];
  h.section.append(replacement.milestone);
  const child = h.makeSection([{ lane: 'child:review', kind: 'message', sequence: 1 }]);
  h.section.append(child.pane);
  h.workbench.dispatchEvent({ type: 'session-reader:process-loaded', detail: { pane: h.pane } });
  h.flush();
  assert.equal(h.select.value, 'child:implementation');
  assert.equal(replacement.milestone.classes.has('reader-milestone-focused'), true);
  assert.equal(replacement.button.attributes.get('aria-pressed'), 'true');
  assert.equal(replacement.milestone.style['--reader-lane-color'], 'var(--accent-color)');
  assert.equal(child.milestones[0].milestone.dataset.readerLaneIndex, undefined);
  h.selectLane('child:review');
  assert.equal(replacement.milestone.classes.has('reader-milestone-focused'), false);
  assert.equal(replacement.button.attributes.get('aria-pressed'), 'false');
});

test('local relation focus keeps every recorded milestone and has no graph canvas', (t) => {
  const h = relationHarness(t, entries);
  h.flush();
  assert.equal(h.section.dataset.readerRelationActive, 'true');
  assert.equal(h.section.dataset.readerRelationVisibleLanes, 'child:implementation,child:review');
  assert.equal(h.section.querySelector('[data-reader-relation-canvas]'), null);
  assert.equal(h.section.querySelectorAll('[data-reader-milestone]').length, entries.length);
  assert.equal(h.section.style['--reader-relation-gutter'], '30px');
  assert.equal(h.window.listeners.has('scroll'), false);
});

test('lane selection emphasizes the chosen branch without hiding text or evidence', (t) => {
  const h = relationHarness(t, entries);
  h.flush();
  h.workbench.dispatchEvent({ type: 'click', target: h.milestones[1].body });
  h.flush();
  assert.equal(h.select.value, 'child:review');
  assert.equal(h.milestones[1].milestone.classes.has('reader-milestone-focused'), true);
  assert.equal(h.milestones[1].button.attributes.get('aria-pressed'), 'true');
  assert.equal(h.milestones[0].milestone.classes.has('reader-milestone-muted'), true);
  assert.equal(h.section.querySelectorAll('[data-reader-milestone]').length, entries.length);
  assert.equal(h.milestones.some(({ milestone }) => milestone.hidden), false);
});

test('resize and disclosure events coalesce to pane-local state', (t) => {
  const h = relationHarness(t, entries);
  h.flush();
  h.workbench.dispatchEvent({ type: 'toggle' });
  h.workbench.dispatchEvent({ type: 'session-reader:content-updated' });
  h.window.dispatchEvent({ type: 'resize' });
  h.observers[0].callback();
  assert.equal(h.frames.size, 1);
  h.flush();
  assert.equal(h.frames.size, 0);
  h.resize(true);
  assert.equal(h.select.value, 'child:implementation');
  assert.equal(h.select.options[0].disabled, true);
  assert.equal(h.section.style['--reader-relation-gutter'], '18px');
});

test('dense and narrow histories keep one focused lane while retaining all choices', (t) => {
  const h = relationHarness(t, entries, { narrow: true });
  h.flush();
  assert.equal(h.select.value, 'child:implementation');
  h.resize(false);
  const dense = h.makeSection(Array.from({ length: 9 }, (_, index) => ({ lane: `child:${index}`, kind: 'spawn', sequence: index })));
  h.swap(dense);
  assert.equal(dense.select.value, 'child:0');
  assert.equal(dense.select.options.length, 9);
  assert.equal(dense.select.querySelector('option[value=""]'), null);
  assert.equal(dense.section.querySelectorAll('[data-reader-milestone]').length, 9);
});

test('pane switches disconnect old state and restore cached pane lane selection', (t) => {
  const h = relationHarness(t, entries);
  h.flush();
  h.selectLane('child:review');
  h.workbench.dispatchEvent({ type: 'toggle' });
  h.workbench.dispatchEvent({ type: 'session-reader:before-swap' });
  assert.equal(h.frames.size, 0);
  assert.equal(h.observers[0].targets.size, 0);
  const child = h.makeSection([{ lane: 'grandchild', kind: 'spawn', sequence: 1 }]);
  h.swap(child);
  assert.equal(h.observers[0].targets.has(child.section), true);
  assert.equal(h.observers[0].targets.has(h.section), false);
  h.swap(h);
  assert.equal(h.select.value, 'child:review');
});

test('simultaneously mounted panes keep selectors and milestone focus isolated', (t) => {
  const h = relationHarness(t, entries);
  const child = h.makeSection([
    { lane: 'grandchild', kind: 'spawn', sequence: 1 },
    { lane: 'grandchild', kind: 'result-delivery', sequence: 2 }
  ]);
  h.inlineOpen(child);
  assert.equal(h.observers[0].targets.has(h.section), true);
  assert.equal(h.observers[0].targets.has(child.section), true);
  h.flush();
  h.selectLane('child:review');
  assert.equal(child.select.value, '');
  h.selectPaneLane(child, 'grandchild');
  assert.equal(child.select.value, 'grandchild');
  assert.equal(h.select.value, 'child:review');
  assert.equal(child.milestones[0].milestone.classes.has('reader-milestone-focused'), true);
  assert.equal(h.milestones[0].milestone.classes.has('reader-milestone-focused'), false);
  h.inlineClose(child);
  assert.equal(h.observers[0].targets.has(child.section), false);
  assert.equal(h.observers[0].targets.has(h.section), true);
});

test('nested panes do not inherit parent task selection or close focus', (t) => {
  const h = relationHarness(t, entries);
  const child = h.makeSection([{ lane: 'child:review', kind: 'spawn', sequence: 1 }]);
  h.pane.append(child.pane);
  h.workbench.dispatchEvent({ type: 'session-reader:inline-opened', detail: { pane: child.pane } });
  h.selectPaneLane(child, 'child:review');
  h.selectLane('child:implementation');
  assert.equal(child.overview.querySelector('[data-reader-branch]').dataset.readerTaskSelected, 'true');
  h.workbench.dispatchEvent({ type: 'click', target: h.milestones[1].button });
  h.workbench.dispatchEvent({ type: 'click', target: h.close });
  assert.equal(h.overview.open, false);
  assert.deepEqual(h.milestones[1].button.focusOptions, { preventScroll: true });
  assert.equal(h.toggle.focusOptions, undefined);
});

test('milestone focus opens the owning collaboration detail and the header trigger closes without changing scroll', (t) => {
  const h = relationHarness(t, entries);
  h.flush();
  h.workbench.dispatchEvent({ type: 'click', target: h.milestones[1].button });
  h.flush();
  assert.equal(h.overview.open, true);
  assert.equal(h.overview.children.find((detail) => detail.dataset.readerTaskLane === 'child:review').open, true);
  h.workbench.dispatchEvent({ type: 'click', target: h.toggle, preventDefault() {}, stopPropagation() {} });
  assert.equal(h.overview.open, false);
  assert.equal(h.toggle.attributes.get('aria-expanded'), 'false');
});

test('opening the task sidebar places keyboard focus inside and Escape returns to its trigger', (t) => {
  const h = relationHarness(t, entries);
  h.workbench.dispatchEvent({ type: 'click', target: h.toggle });
  assert.equal(h.overview.open, true);
  assert.deepEqual(h.close.focusOptions, { preventScroll: true });
  let prevented = false;
  let stopped = false;
  h.workbench.dispatchEvent({ type: 'keydown', target: h.close, key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(prevented, true);
  assert.equal(stopped, true, 'the global Escape handler must not blur the restored trigger');
  assert.equal(h.overview.open, false);
  assert.deepEqual(h.toggle.focusOptions, { preventScroll: true });

  h.workbench.dispatchEvent({ type: 'click', target: h.milestones[1].button });
  assert.equal(h.overview.open, true);
  h.workbench.dispatchEvent({ type: 'keydown', target: h.close, key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(h.milestones[1].button.focusOptions, { preventScroll: true });
});

test('native summary opens with keyboard focus and replaces the previous return target', (t) => {
  const h = relationHarness(t, entries);
  h.workbench.dispatchEvent({ type: 'click', target: h.toggle });
  h.workbench.dispatchEvent({ type: 'click', target: h.close });
  let prevented = false;
  h.workbench.dispatchEvent({ type: 'click', target: h.summary, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(h.overview.open, true);
  assert.deepEqual(h.close.focusOptions, { preventScroll: true });
  h.workbench.dispatchEvent({ type: 'keydown', target: h.close, key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(h.overview.open, false);
  assert.deepEqual(h.summary.focusOptions, { preventScroll: true });
});

test('task selection loads only its own preview, caches it and isolates late responses', async (t) => {
  const h = relationHarness(t, entries);
  const requests = [];
  t.mock.method(globalThis, 'fetch', (url) => new Promise((resolve) => requests.push({ url, resolve })));
  const previews = [];
  const buttons = [];
  for (const branch of h.overview.querySelectorAll('[data-reader-branch]')) {
    const key = branch.dataset.readerBranchKey;
    const button = new h.Element({ readerTaskSelect: key }, 'button');
    h.overview.append(button);
    buttons.push(button);
    const preview = new h.Element({ readerTaskPreview: '', readerProvider: 'fixture', readerSession: key, loadingLabel: 'Loading', errorLabel: 'Failed' });
    const status = new h.Element({ readerPreviewStatus: '' });
    const content = new h.Element({ readerPreviewContent: '' });
    const retry = new h.Element({ readerPreviewRetry: '' });
    preview.append(status); preview.append(content); preview.append(retry);
    branch.append(preview);
    previews.push({ preview, status, content, retry });
  }
  assert.equal(requests.length, 0);
  h.workbench.dispatchEvent({ type: 'click', target: h.toggle });
  h.workbench.dispatchEvent({ type: 'click', target: buttons[0] });
  assert.equal(requests.length, 1, 'duplicate selection reuses the pending request');
  assert.equal(requests[0].url, '/api/fixture/session/child%3Aimplementation/reader/preview');
  h.workbench.dispatchEvent({ type: 'click', target: buttons[1] });
  assert.equal(requests.length, 2);
  requests[1].resolve({ ok: true, json: async () => ({ html: '<p>Review reply</p>' }) });
  await new Promise(setImmediate);
  requests[0].resolve({ ok: true, json: async () => ({ html: '<p>Implementation reply</p>' }) });
  await new Promise(setImmediate);
  assert.equal(previews[0].content.innerHTML, '<p>Implementation reply</p>');
  assert.equal(previews[1].content.innerHTML, '<p>Review reply</p>');
  assert.equal(buttons[1].attributes.get('aria-pressed'), 'true');
  assert.equal(buttons[0].attributes.get('aria-pressed'), 'false');
  h.workbench.dispatchEvent({ type: 'click', target: buttons[0] });
  assert.equal(requests.length, 2, 'loaded preview stays cached in its pane');
  assert.equal(previews[0].status.hidden, true);
});

test('failed preview keeps a visible retry and nested task panels do not overlap', async (t) => {
  const h = relationHarness(t, entries);
  const branch = h.overview.querySelector('[data-reader-branch]');
  const preview = new h.Element({ readerTaskPreview: '', readerProvider: 'fixture', readerSession: 'child', loadingLabel: 'Loading', errorLabel: 'Failed' });
  const status = new h.Element({ readerPreviewStatus: '' });
  const content = new h.Element({ readerPreviewContent: '' });
  const retry = new h.Element({ readerPreviewRetry: '' });
  preview.append(status); preview.append(content); preview.append(retry); branch.append(preview);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? { ok: false, status: 404 } : { ok: true, json: async () => ({ html: '<p>Loaded</p>' }) });
  h.workbench.dispatchEvent({ type: 'click', target: h.toggle });
  await new Promise(setImmediate);
  assert.equal(status.textContent, 'Failed (HTTP 404)');
  assert.equal(retry.hidden, false);
  h.workbench.dispatchEvent({ type: 'click', target: retry });
  await new Promise(setImmediate);
  assert.equal(content.innerHTML, '<p>Loaded</p>');
  assert.equal(retry.hidden, true);
  const child = h.makeSection([{ lane: 'grandchild', kind: 'spawn', sequence: 1 }]);
  h.pane.append(child.pane);
  h.workbench.dispatchEvent({ type: 'session-reader:inline-opened', detail: { pane: child.pane } });
  h.workbench.dispatchEvent({ type: 'click', target: child.milestones[0].button });
  assert.equal(child.overview.open, true);
  assert.equal(h.overview.open, false);
});

test('native nested overview selection is exclusive and collapsed task is no longer pressed', (t) => {
  const h = relationHarness(t, entries);
  h.workbench.dispatchEvent({ type: 'click', target: h.toggle });
  const child = h.makeSection([{ lane: 'grandchild', kind: 'spawn', sequence: 1 }]);
  h.pane.append(child.pane);
  h.workbench.dispatchEvent({ type: 'session-reader:inline-opened', detail: { pane: child.pane } });
  child.overview.open = true;
  h.workbench.dispatchEvent({ type: 'toggle', target: child.overview });
  assert.equal(h.overview.open, false);
  const branch = child.overview.querySelector('[data-reader-branch]');
  assert.equal(branch.open, true);
  const button = new h.Element({ readerTaskSelect: branch.dataset.readerBranchKey }, 'button');
  button.setAttribute('aria-pressed', 'true');
  child.overview.append(button);
  branch.open = false;
  h.workbench.dispatchEvent({ type: 'toggle', target: branch });
  assert.equal(button.attributes.get('aria-pressed'), 'false');
});
