import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureReaderAnchor, initReaderProcesses, loadReaderProcess } from '../src/static/app/reader-process.js';

function processFixture(t) {
  const listeners = new Map();
  const events = [];
  const attributes = new Map();
  const document = { activeElement: null };
  const pane = { dataset: {}, isConnected: true, querySelectorAll: () => [target] };
  const summary = { focus() { document.activeElement = this; } };
  const loadedTarget = { id: 'tool-source', closest: (selector) => selector === '[data-reader-pane]' ? pane : chunk };
  let target = { id: 'tool-source', closest: (selector) => selector === '[data-reader-pane]' ? pane : chunk };
  const buttonAttributes = new Map();
  const button = {
    dataset: { loadingLabel: 'Loading', retryLabel: 'Retry', loadError: 'Load failed' },
    textContent: 'Load 20 tools', disabled: false,
    setAttribute: (name, value) => buttonAttributes.set(name, value),
    removeAttribute: (name) => buttonAttributes.delete(name),
    closest: (selector) => selector === '[data-reader-process-load]' ? button : chunk
  };
  const status = { textContent: '' };
  const chunk = {
    dataset: { readerProcessState: 'unloaded', readerProcessUrl: '/api/fixture/session/root/reader/process?messageId=message&firstPartId=first&lastPartId=last' },
    isConnected: true,
    closest: () => pane,
    querySelector: (selector) => selector === '[data-reader-process-load]' ? button
      : selector === '[data-reader-process-status]' ? status : summary,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    set innerHTML(html) { this.loadedHTML = html; target = loadedTarget; },
    dispatchEvent: (event) => events.push(event)
  };
  const workbench = { addEventListener: (name, listener) => listeners.set(name, listener) };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ ok: true, html: '<details><summary>Tool</summary></details>' }) }));
  for (const [name, value] of Object.entries({ document, CSS: { escape: (value) => value } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
  }
  return { pane, chunk, button, status, summary, loadedTarget, document, attributes, buttonAttributes, events, listeners, workbench };
}

test('manual and source/search anchor requests share one pending process chunk', async (t) => {
  const h = processFixture(t);
  let resolveResponse;
  globalThis.fetch.mock.mockImplementation(() => new Promise((resolve) => { resolveResponse = resolve; }));
  const manual = loadReaderProcess(h.chunk);
  const source = ensureReaderAnchor(h.pane, 'tool-source');
  const search = ensureReaderAnchor(h.pane, 'tool-source');
  assert.equal(globalThis.fetch.mock.callCount(), 1);
  assert.equal(h.chunk.dataset.readerProcessState, 'loading');
  assert.equal(h.buttonAttributes.get('aria-disabled'), 'true');
  assert.equal(h.button.disabled, false, 'The loading control remains focusable until replacement');
  assert.equal(h.attributes.get('aria-busy'), 'true');
  resolveResponse({ ok: true, json: async () => ({ ok: true, html: '<details><summary>Tool</summary></details>' }) });
  assert.deepEqual(await Promise.all([manual, source, search]), [h.chunk, h.loadedTarget, h.loadedTarget]);
  assert.equal(h.chunk.dataset.readerProcessState, 'loaded');
  assert.equal(h.attributes.has('aria-busy'), false);
  assert.equal(h.buttonAttributes.has('aria-disabled'), false);
  assert.deepEqual(h.events.map((event) => event.type), ['session-reader:process-loaded']);
  assert.equal(h.events[0].detail.pane, h.pane);
  assert.equal(await loadReaderProcess(h.chunk), h.chunk);
  assert.equal(globalThis.fetch.mock.callCount(), 1, 'Already loaded chunks do not request again');
});

test('network failure remains retryable and retains its distinct error', async (t) => {
  const h = processFixture(t);
  const networkError = new TypeError('Network unavailable');
  globalThis.fetch.mock.mockImplementationOnce(async () => { throw networkError; });
  await assert.rejects(ensureReaderAnchor(h.pane, 'tool-source'), (error) => error === networkError && error.code === undefined);
  assert.equal(h.chunk.dataset.readerProcessState, 'error');
  assert.equal(h.button.textContent, 'Retry');
  assert.equal(h.button.disabled, false);
  assert.equal(h.status.textContent, 'Load failed');
  assert.equal(await ensureReaderAnchor(h.pane, 'tool-source'), h.loadedTarget);
  assert.equal(globalThis.fetch.mock.callCount(), 2);
});

test('a missing source chunk preserves the server diagnostic', async (t) => {
  const h = processFixture(t);
  globalThis.fetch.mock.mockImplementationOnce(async () => ({ ok: false, status: 404,
    json: async () => ({ ok: false, code: 'process_not_found', error: 'Recorded tool range unavailable' }) }));
  await assert.rejects(ensureReaderAnchor(h.pane, 'tool-source'), { code: 'process_not_found' });
  assert.equal(h.chunk.loadedHTML, undefined);
  assert.equal(h.chunk.dataset.readerProcessState, 'error');
});

test('a detached pane discards the process response and can retry when restored', async (t) => {
  const h = processFixture(t);
  let resolveResponse;
  globalThis.fetch.mock.mockImplementationOnce(() => new Promise((resolve) => { resolveResponse = resolve; }));
  const pending = ensureReaderAnchor(h.pane, 'tool-source');
  h.pane.isConnected = false;
  h.chunk.isConnected = false;
  resolveResponse({ ok: true, json: async () => ({ ok: true, html: '<details>Late response</details>' }) });
  assert.equal(await pending, null);
  assert.equal(h.chunk.loadedHTML, undefined);
  assert.equal(h.chunk.dataset.readerProcessState, 'unloaded');
  assert.equal(h.button.textContent, 'Load 20 tools');
  assert.equal(h.button.disabled, false);
  assert.equal(h.attributes.has('aria-busy'), false);
  assert.deepEqual(h.events, []);
  h.pane.isConnected = true;
  h.chunk.isConnected = true;
  assert.equal(await ensureReaderAnchor(h.pane, 'tool-source'), h.loadedTarget);
});

test('opening a folded process loads only its first chunk', async (t) => {
  const h = processFixture(t);
  initReaderProcesses(h.workbench);
  const second = { dataset: { readerProcessState: 'unloaded' } };
  const group = { open: true, matches: () => true, querySelectorAll: () => [h.chunk, second] };
  h.listeners.get('toggle')({ target: group });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(globalThis.fetch.mock.callCount(), 1);
  assert.equal(h.chunk.dataset.readerProcessState, 'loaded');
  assert.equal(second.dataset.readerProcessState, 'unloaded');
  h.listeners.get('toggle')({ target: group });
  assert.equal(globalThis.fetch.mock.callCount(), 1);
});

test('manual process loading preserves a newer focus selection', async (t) => {
  const h = processFixture(t);
  let resolveResponse;
  globalThis.fetch.mock.mockImplementationOnce(() => new Promise((resolve) => { resolveResponse = resolve; }));
  initReaderProcesses(h.workbench);
  h.document.activeElement = h.button;
  h.listeners.get('click')({ target: h.button });
  const newerTarget = { id: 'newer-source' };
  h.document.activeElement = newerTarget;
  resolveResponse({ ok: true, json: async () => ({ ok: true, html: '<details><summary>Tool</summary></details>' }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.document.activeElement, newerTarget);
});

test('a focused load button transfers focus to its replacement summary', async (t) => {
  const h = processFixture(t);
  h.document.activeElement = h.button;
  await loadReaderProcess(h.chunk);
  assert.equal(h.document.activeElement, h.summary);
});
