import assert from 'node:assert/strict';
import test from 'node:test';
import { reasoningBlock, toolCallBlock } from '../dist/src/views/components.js';
import { setLocale } from '../dist/src/i18n.js';
import { loadFoldedContent, loadProgressiveContent } from '../src/static/app/session-workbench.js';

test('folded fields preserve anchors and identities without serializing their initial bodies', (t) => {
  setLocale('en');
  t.mock.method(JSON, 'stringify', () => { throw new Error('Folded input must not be serialized'); });
  const html = toolCallBlock('run', { payload: 'hidden input' }, { result: 'hidden output' }, 'completed', '1s', 'tool:1', 'inherited-context');
  assert.match(html, /id="part-tool-1" data-part-id="tool:1"/);
  assert.match(html, /tool-name">run<\/span>/);
  assert.match(html, /tool-duration">1s<\/span>/);
  assert.equal((html.match(/data-next-offset="0"/g) || []).length, 2);
  assert.equal((html.match(/data-load-initial/g) || []).length, 2);
  assert.equal((html.match(/data-content-scope="inherited-context"/g) || []).length, 4);
  assert.equal((html.match(/<div\b/g) || []).length, 3, 'one panel and one existing container per field');
  assert.match(html, /class="progressive" data-content-field="input" data-progressive-part-id="tool:1"/);
  assert.match(html, /class="progressive" data-content-field="output" data-progressive-part-id="tool:1"/);
  assert.doesNotMatch(html, /data-progressive-status/);
  assert.doesNotMatch(html, /hidden input|hidden output/);
});

test('short and long folded reasoning and tool fields use the same first-page contract', () => {
  for (const text of ['short body', 'long body\n'.repeat(1800)]) {
    const reasoning = reasoningBlock(text, '2s', 'thought:1');
    assert.match(reasoning, /id="part-thought-1"/);
    assert.match(reasoning, /data-progressive-field="reasoning"/);
    assert.match(reasoning, /data-next-offset="0"/);
    assert.match(reasoning, /class="reasoning-body markdown progressive" data-content-field="reasoning"/);
    assert.equal((reasoning.match(/<div\b/g) || []).length, 1, 'reasoning reuses its existing body container');
    assert.doesNotMatch(reasoning, /short body|long body/);
    const tool = toolCallBlock('run', text, text, 'completed', '', 'tool:1');
    assert.equal((tool.match(/data-load-initial/g) || []).length, 2);
    assert.doesNotMatch(tool, /short body|long body/);
  }
});

test('empty folded fields stay empty and fields without canonical anchors retain direct rendering', () => {
  for (const empty of ['', null, undefined]) {
    assert.doesNotMatch(toolCallBlock('run', empty, empty, 'completed', '', 'tool:1'), /data-load-initial|progressive-more/);
    assert.doesNotMatch(reasoningBlock(empty, '', 'reason:1'), /data-load-initial|progressive-more/);
  }
  for (const value of [0, false, {}, []]) {
    assert.equal((toolCallBlock('run', value, value, 'completed', '', 'tool:1').match(/data-load-initial/g) || []).length, 2);
  }
  assert.match(reasoningBlock('direct reasoning'), /<p>direct reasoning<\/p>/);
  assert.match(toolCallBlock('run', 'direct input', 'direct output', 'completed', '', ''), /<pre>direct output<\/pre>/);
});

test('folded field controls carry localized loading, retry and continuation labels', () => {
  setLocale('zh');
  const html = reasoningBlock('hidden', '', 'reason:1');
  assert.match(html, />加载内容<\/button>/);
  assert.match(html, /data-loading-label="正在加载内容…"/);
  assert.match(html, /data-retry-label="重试加载"/);
  assert.match(html, /data-more-label="显示更多"/);
  assert.doesNotMatch(html, /data-progressive-status/, 'initial fields have no empty status node');
  setLocale('en');
});

function clientField(t, { field = 'output', session = 'child', scope = 'owned', owner = null } = {}) {
  const events = [];
  const inserts = [];
  let status = null;
  const pane = { dataset: { readerProvider: 'codex', readerSession: session }, isConnected: true };
  const workbench = {
    dataset: { provider: 'codex', sessionId: 'root' },
    dispatchEvent(event) { events.push(event); }
  };
  const container = {
    querySelector(selector) { assert.equal(selector, '[data-progressive-status]'); return status; },
    insertBefore(chunk, before) { assert.equal(before, button); inserts.push(chunk); },
    append(node) { assert.equal(status, null, 'only one error status may be present'); status = node; }
  };
  const details = owner || {
    open: true,
    matches(selector) { assert.equal(selector, 'details.tool-call, details.reasoning-block'); return true; },
    querySelectorAll(selector) {
      assert.equal(selector, '.progressive-more[data-load-initial]');
      return 'loadInitial' in button.dataset && button.isConnected ? [button] : [];
    }
  };
  const attributes = new Map();
  const button = {
    dataset: { partId: 'part:1', field, nextOffset: '0', contentScope: scope, loadInitial: '',
      loadingLabel: 'Loading content…', retryLabel: 'Retry loading', moreLabel: 'Show more', loadError: 'Unable to load content' },
    textContent: 'Load content', disabled: false, isConnected: true,
    closest(selector) {
      if (selector === '.progressive') return container;
      if (selector === '.session-workbench') return workbench;
      if (selector === '[data-reader-pane]') return pane;
      if (selector === 'details') return details;
      throw new Error(`Unexpected selector: ${selector}`);
    },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    remove() { this.isConnected = false; }
  };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
    if (originalCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', originalCustomEvent);
    else delete globalThis.CustomEvent;
  });
  globalThis.document = { createElement: (tagName) => ({
    tagName, className: '', innerHTML: '', textContent: '', dataset: {}, attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    remove() { if (status === this) status = null; }
  }) };
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; Object.assign(this, options); } };
  return { button, details, pane, get status() { return status; }, inserts, events, attributes };
}

function response(html, nextOffset = null) {
  return { ok: true, json: async () => ({ ok: true, html, nextOffset }) };
}

test('specific disclosure autoload, manual click and search share a request then continue exactly once', async (t) => {
  const fixture = clientField(t, { scope: 'inherited-context' });
  const pending = [];
  const urls = [];
  t.mock.method(globalThis, 'fetch', (url) => {
    urls.push(url);
    return new Promise((resolve) => pending.push(resolve));
  });
  const automatic = loadFoldedContent(fixture.details);
  const manual = loadProgressiveContent(fixture.button);
  fixture.button.dataset.searchRevealPending = 'true';
  const search = loadProgressiveContent(fixture.button, { dispatch: false });
  assert.equal(manual, search);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^\/api\/codex\/session\/child\/content\?/);
  const params = new URL(urls[0], 'http://localhost').searchParams;
  assert.equal(params.get('offset'), '0');
  assert.equal(params.get('scope'), 'inherited-context');
  assert.equal(fixture.button.textContent, 'Loading content…');
  assert.equal(fixture.attributes.get('aria-busy'), 'true');
  pending.shift()(response('<pre>first</pre>', 3000));
  await Promise.all([automatic, manual, search]);
  assert.equal(fixture.inserts.length, 1);
  assert.equal(fixture.events.length, 0, 'search-owned reveal does not restart itself');
  assert.equal(fixture.button.dataset.nextOffset, '3000');
  assert.equal(fixture.button.textContent, 'Show more');
  assert.equal('loadInitial' in fixture.button.dataset, false);
  delete fixture.button.dataset.searchRevealPending;
  await loadFoldedContent(fixture.details);
  assert.equal(urls.length, 1, 'reopening does not prefetch later pages');
  const continuation = loadProgressiveContent(fixture.button);
  assert.equal(new URL(urls[1], 'http://localhost').searchParams.get('offset'), '3000');
  pending.shift()(response('<pre>last</pre>'));
  await continuation;
  assert.equal(fixture.inserts.length, 2);
  assert.equal(fixture.button.isConnected, false);
  assert.equal(fixture.events[0].detail.pane, fixture.pane);
});

test('opening a process disclosure or closing a field does not load nested tool content', async (t) => {
  const fixture = clientField(t);
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected fetch'); });
  fixture.details.open = false;
  await loadFoldedContent(fixture.details);
  const process = { open: true, matches: () => false, querySelectorAll: () => [fixture.button] };
  await loadFoldedContent(process);
  const otherTool = { open: true, matches: () => true, querySelectorAll: () => [fixture.button] };
  await loadFoldedContent(otherTool);
  assert.equal(fetch.mock.callCount(), 0);
});

test('an earlier autoloaded input does not interrupt a search revealing later output pages', async (t) => {
  const fields = [];
  const details = { open: true, matches: () => true, querySelectorAll: () => fields.map((field) => field.button) };
  const input = clientField(t, { field: 'input', owner: details });
  const output = clientField(t, { field: 'output', owner: details });
  fields.push(input, output);
  const pending = new Map();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', (url) => {
    calls += 1;
    const params = new URL(url, 'http://localhost').searchParams;
    return new Promise((resolve) => pending.set(`${params.get('field')}:${params.get('offset')}`, resolve));
  });
  const automatic = loadFoldedContent(details);
  const targetFirst = loadProgressiveContent(output.button, { dispatch: false });
  assert.equal(calls, 2, 'the search joins the pending output request');
  pending.get('input:0')(response('<pre>input returned first</pre>'));
  await loadProgressiveContent(input.button, { dispatch: false });
  assert.equal(input.events.length, 0, 'sibling completion cannot emit the event that cancels the search reveal');
  assert.equal(output.button.disabled, true);
  pending.get('output:0')(response('<pre>early output</pre>', 3000));
  await targetFirst;
  const targetLast = loadProgressiveContent(output.button, { dispatch: false });
  pending.get('output:3000')(response('<pre>late search hit</pre>'));
  await Promise.all([targetLast, automatic]);
  assert.equal(calls, 3);
  assert.equal(output.events.length, 0);
  assert.deepEqual(output.inserts.map((chunk) => chunk.innerHTML), ['<pre>early output</pre>', '<pre>late search hit</pre>']);
});

test('a failed field stays visible and retries through the same loader', async (t) => {
  const fixture = clientField(t);
  assert.equal(fixture.status, null);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (calls === 1) throw new Error('network failure');
    return response('<pre>recovered</pre>');
  });
  const failed = await loadFoldedContent(fixture.details);
  assert.equal(failed[0].status, 'rejected');
  assert.equal(fixture.status.textContent, 'Unable to load content');
  assert.equal(fixture.status.getAttribute('role'), 'status');
  assert.equal(fixture.status.getAttribute('aria-live'), 'polite');
  assert.equal(fixture.button.textContent, 'Retry loading');
  assert.equal(fixture.button.disabled, false);
  assert.equal(fixture.button.dataset.nextOffset, '0');
  assert.equal('loadInitial' in fixture.button.dataset, true);
  const retry = loadProgressiveContent(fixture.button);
  assert.equal(fixture.status, null, 'retry removes the prior error node before awaiting the response');
  await retry;
  assert.equal(calls, 2);
  assert.equal(fixture.status, null, 'successful fields retain no empty status node');
  assert.equal(fixture.inserts.length, 1);
});

for (const failure of [false, true]) {
  test(`detached field ${failure ? 'failure' : 'success'} remains retryable when its cached pane returns`, async (t) => {
    const fixture = clientField(t);
    let resolve;
    let reject;
    t.mock.method(globalThis, 'fetch', () => new Promise((yes, no) => { resolve = yes; reject = no; }));
    const loading = loadProgressiveContent(fixture.button);
    fixture.pane.isConnected = false;
    fixture.button.isConnected = false;
    if (failure) {
      reject(new Error('detached failure'));
      await assert.rejects(loading, /detached failure/);
    } else {
      resolve(response('<pre>late child</pre>', 3000));
      assert.equal(await loading, null);
    }
    assert.equal(fixture.inserts.length, 0);
    assert.equal(fixture.button.disabled, false);
    assert.equal(fixture.attributes.has('aria-busy'), false);
    assert.equal(fixture.button.dataset.nextOffset, '0');
    fixture.pane.isConnected = true;
    fixture.button.isConnected = true;
    const retried = loadProgressiveContent(fixture.button);
    resolve(response('<pre>returned child</pre>'));
    await retried;
    assert.equal(fixture.inserts.length, 1);
    assert.equal(fixture.events[0].detail.session, 'child');
  });
}
