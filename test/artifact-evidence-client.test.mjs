import assert from 'node:assert/strict';
import test from 'node:test';
import { initArtifactEvidence, loadArtifactEvidence } from '../src/static/app/artifact-evidence.js';

function fixture(t) {
  const markup = new Map();
  const events = new Map();
  const activityNodes = [];
  const button = { hidden: false, disabled: false, textContent: '', closest: () => details };
  const from = { value: '', disabled: false };
  const to = { value: '', disabled: false };
  const submit = { disabled: false };
  const status = { textContent: '', children: [], append(...nodes) { this.children.push(...nodes); } };
  const coverage = { innerHTML: '' };
  const lineage = { hidden: true };
  const form = { querySelectorAll: () => [from, to, submit], elements: { namedItem: (name) => name === 'from' ? from : to }, matches: () => true, closest: () => details };
  const activities = {
    get childElementCount() { return activityNodes.length; },
    querySelectorAll: () => activityNodes,
    append(activity) { activityNodes.push(activity); },
    replaceChildren() { activityNodes.length = 0; }
  };
  const workbench = { dataset: { provider: 'root-provider', sessionId: 'root' }, addEventListener(name, callback) { events.set(name, callback); } };
  const pane = { dataset: { readerProvider: 'fixture', readerSession: 'child' }, isConnected: true };
  const nodes = { '[data-artifact-evidence-load]': button, '[data-artifact-evidence-status]': status, '[data-artifact-evidence-range]': form, '[data-artifact-evidence-activities]': activities, '[data-artifact-evidence-lineage]': lineage, '[data-artifact-evidence-coverage]': coverage };
  const attributes = new Map();
  const details = {
    dataset: { contextArtifactId: 'summary-version', loadingLabel: 'Checking', loadLabel: 'Check', moreLabel: 'More', retryLabel: 'Retry', errorLabel: 'Unable to check', invalidLabel: 'Check range again', emptyLabel: 'None in checked records', staleLabel: 'Evidence changed', refreshLabel: 'Refresh history' },
    open: true, isConnected: true,
    querySelector: (selector) => nodes[selector],
    closest: (selector) => selector === '[data-reader-pane]' ? pane : workbench,
    matches: (selector) => selector === '[data-artifact-evidence]',
    setAttribute: (key, value) => attributes.set(key, value), removeAttribute: (key) => attributes.delete(key)
  };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  });
  globalThis.document = { createElement(tag) {
    if (tag === 'template') return { content: null, set innerHTML(value) { this.content = { querySelectorAll: () => markup.get(value) }; } };
    return { tagName: tag, href: '', textContent: '' };
  } };
  function activity(id, recordIds) {
    const records = recordIds.map((recordId) => ({ dataset: { artifactRecordId: recordId }, open: false }));
    return { dataset: { artifactActivityId: id }, records,
      querySelector: () => ({ querySelectorAll: () => records, append: (record) => records.push(record) }),
      querySelectorAll: () => records };
  }
  function html(name, entries) { markup.set(name, entries); return name; }
  function page(name, { nextCursor = null, from: fromTime = 1700000000000, to: toTime = 1700003600000 } = {}) {
    return { ok: true, status: 200, json: async () => ({ ok: true, html: name, coverageHtml: 'Checked range', nextCursor,
      coverage: { from: fromTime, to: toTime, complete: nextCursor === null, scannedRecords: 15, readBytes: 9000, issues: [] } }) };
  }
  return { details, button, form, from, to, status, coverage, lineage, activities, activityNodes, workbench, pane, events, attributes, html, activity, page };
}

test('evidence loads only from its own disclosure and merges cursor pages without replacing expanded records', async (t) => {
  const ui = fixture(t);
  const firstActivity = ui.activity('generation-turn', ['read']);
  const first = ui.html('first', [firstActivity]);
  const second = ui.html('second', [ui.activity('generation-turn', ['read', 'patch']), ui.activity('another-turn', ['other'])]);
  const urls = [];
  const pending = [];
  t.mock.method(globalThis, 'fetch', (url) => { urls.push(url); return new Promise((resolve) => pending.push(resolve)); });
  initArtifactEvidence(ui.workbench);
  ui.events.get('toggle')({ target: { matches: () => false, open: true } });
  assert.equal(urls.length, 0, 'opening the saved summary must not inspect logs');
  const firstLoad = loadArtifactEvidence(ui.details);
  assert.equal(loadArtifactEvidence(ui.details), firstLoad, 'parallel clicks share one request');
  const firstUrl = new URL(urls[0], 'http://localhost');
  assert.equal(firstUrl.pathname, '/api/fixture/session/child/artifact-evidence');
  assert.equal(firstUrl.searchParams.get('artifact'), 'summary-version');
  assert.equal(firstUrl.searchParams.has('cursor'), false);
  assert.equal(ui.button.disabled, true);
  pending.shift()(ui.page(first, { nextCursor: 'cursor-two' }));
  await firstLoad;
  firstActivity.records[0].open = true;
  const nextLoad = loadArtifactEvidence(ui.details);
  assert.equal(new URL(urls[1], 'http://localhost').searchParams.get('cursor'), 'cursor-two');
  pending.shift()(ui.page(second));
  await nextLoad;
  assert.equal(ui.activityNodes.length, 2);
  assert.equal(ui.activityNodes[0], firstActivity);
  assert.equal(ui.activityNodes[0].records[0].open, true);
  assert.deepEqual(ui.activityNodes[0].records.map((record) => record.dataset.artifactRecordId), ['read', 'patch']);
  assert.equal(ui.button.hidden, true);
  assert.equal(ui.lineage.hidden, false);
  assert.equal(ui.status.textContent, '');
  await loadArtifactEvidence(ui.details);
  assert.equal(urls.length, 2, 'reopening completed evidence does not restart discovery');
});

test('failed continuation retries its cursor, while an expired cursor restarts the selected range', async (t) => {
  const ui = fixture(t);
  const first = ui.html('first', [ui.activity('turn', ['read'])]);
  const empty = ui.html('empty', []);
  const range = { from: 1700100000000, to: 1700103600000 };
  const urls = [];
  const responses = [ui.page(first, { ...range, nextCursor: 'saved-cursor' }), new Error('transport'),
    { ok: false, status: 400, json: async () => ({ ok: false, code: 'evidence_invalid' }) }, ui.page(empty, range)];
  t.mock.method(globalThis, 'fetch', async (url) => { urls.push(new URL(url, 'http://localhost')); const result = responses.shift(); if (result instanceof Error) throw result; return result; });
  await loadArtifactEvidence(ui.details, range);
  await loadArtifactEvidence(ui.details);
  assert.equal(ui.status.textContent, 'Unable to check');
  assert.equal(ui.button.disabled, false);
  await loadArtifactEvidence(ui.details);
  assert.equal(urls[1].searchParams.get('cursor'), 'saved-cursor');
  assert.equal(urls[2].searchParams.get('cursor'), 'saved-cursor');
  assert.equal(ui.status.textContent, 'Check range again');
  await loadArtifactEvidence(ui.details);
  assert.equal(urls[3].searchParams.has('cursor'), false);
  assert.equal(urls[3].searchParams.get('from'), String(range.from));
  assert.equal(urls[3].searchParams.get('to'), String(range.to));
  assert.equal(ui.activityNodes.length, 0, 'a new range result replaces prior evidence');
  assert.equal(ui.lineage.hidden, true);
  assert.equal(ui.status.textContent, 'None in checked records');
});

for (const responseKind of ['success', 'stale', 'failure']) {
  test(`a detached evidence ${responseKind} response leaves a retryable child disclosure`, async (t) => {
    const ui = fixture(t);
    const first = ui.html('first', [ui.activity('turn', ['read'])]);
    let finish;
    let fail;
    t.mock.method(globalThis, 'fetch', () => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    const pending = loadArtifactEvidence(ui.details);
    ui.pane.isConnected = false;
    if (responseKind === 'failure') fail(new Error('disconnected'));
    else finish(responseKind === 'stale' ? { ok: false, status: 409, json: async () => ({ ok: false, code: 'artifact_stale' }) } : ui.page(first));
    await pending;
    assert.equal(ui.activityNodes.length, 0);
    assert.equal(ui.button.disabled, false);
    assert.equal(ui.attributes.has('aria-busy'), false);
    ui.pane.isConnected = true;
    const retry = loadArtifactEvidence(ui.details);
    finish(ui.page(first));
    await retry;
    assert.equal(ui.activityNodes.length, 1);
  });
}

test('stale artifact evidence offers the owning child history and prevents mixed versions', async (t) => {
  const ui = fixture(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return { ok: false, status: 409, json: async () => ({ ok: false, code: 'artifact_stale' }) }; });
  await loadArtifactEvidence(ui.details);
  const refresh = ui.status.children.find((node) => typeof node === 'object');
  assert.equal(refresh.href, '/fixture/session/child');
  assert.equal(ui.status.textContent, 'Evidence changed');
  assert.equal(ui.button.hidden, true);
  assert.equal(ui.button.disabled, true);
  await loadArtifactEvidence(ui.details, { from: 1700000000000, to: 1700003600000 });
  assert.equal(calls, 1);
});
