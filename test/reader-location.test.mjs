import assert from 'node:assert/strict';
import test from 'node:test';
import { createReaderLocation, parseReaderLocation, stripReaderLocation } from '../src/static/app/reader-location.js';

const ROOT = 'http://localhost:3456/fixture/session/root';
const CHILD = 'http://localhost:3456/fixture/session/child';
const GRANDCHILD = 'http://localhost:3456/fixture/session/grandchild';

function locationFor(source, ancestors = [], pageHref = ROOT) {
  const page = new URL(pageHref);
  page.searchParams.set('readerSource', source);
  for (const ancestor of ancestors) page.searchParams.append('readerAncestor', ancestor);
  return page;
}

test('reader location round trips the root, child, and ordered nested ancestors', () => {
  for (const [source, ancestorHrefs] of [
    [ROOT, []],
    [CHILD, []],
    [GRANDCHILD, [CHILD]],
    [`${GRANDCHILD}-next`, [CHILD, GRANDCHILD]],
  ]) {
    const href = createReaderLocation(ROOT, source, ancestorHrefs);
    assert.ok(href.startsWith('/fixture/session/root?'));
    const parsed = parseReaderLocation(href, ROOT);
    assert.equal(parsed.source.href, source);
    assert.deepEqual(parsed.ancestors, ancestorHrefs.map((href) => ({
      provider: 'fixture', session: new URL(href).pathname.split('/').at(-1), href,
    })));
  }
});

test('reader location preserves native anchors, scalar event locators, and source query values', () => {
  for (const source of [
    `${CHILD}#message-3`,
    `${CHILD}?readerEvent=event%3A3`,
    `${CHILD}?view=history&tag=one&tag=two&query=a%2Bb%20c#message%3A3`,
  ]) {
    const parsed = parseReaderLocation(createReaderLocation(ROOT, source), ROOT);
    assert.equal(parsed.source.href, source);
    assert.deepEqual(parsed.ancestors, []);
  }
});

test('reader location resolves relative session URLs and decodes canonical identities', () => {
  const child = '/fixture/session/child%20one?view=history#message-2';
  const target = '/other/session/child%20one';
  const parsed = parseReaderLocation(locationFor(target, [child]), ROOT);
  assert.equal(parsed.source.href, `http://localhost:3456${target}`);
  assert.deepEqual(parsed.ancestors, [{
    provider: 'fixture', session: 'child one', href: `http://localhost:3456${child}`,
  }]);
  assert.equal(parseReaderLocation(createReaderLocation(ROOT, child), ROOT).source.pathname,
    '/fixture/session/child%20one');
});

test('reader location replaces prior locators and clears the outer event and hash', () => {
  const page = locationFor(CHILD, [], `${ROOT}?view=history&tag=one&tag=two&readerEvent=root-event#root-message`);
  const href = createReaderLocation(page, `${GRANDCHILD}#child-message`, [CHILD]);
  const result = new URL(href, ROOT);
  assert.equal(result.pathname, '/fixture/session/root');
  assert.equal(result.searchParams.get('view'), 'history');
  assert.deepEqual(result.searchParams.getAll('tag'), ['one', 'two']);
  assert.equal(result.searchParams.has('readerEvent'), false);
  assert.equal(result.hash, '');
  assert.deepEqual(result.searchParams.getAll('readerSource'), [`${GRANDCHILD}#child-message`]);
  assert.deepEqual(result.searchParams.getAll('readerAncestor'), [CHILD]);
  assert.equal(page.searchParams.get('readerSource'), CHILD);
  assert.equal(page.hash, '#root-message');
});

test('stripping a reader location returns a copy with only the reader path removed', () => {
  const original = locationFor(GRANDCHILD, [CHILD], `${ROOT}?view=history&readerEvent=event-1#message-2`);
  const result = stripReaderLocation(original);
  assert.notEqual(result, original);
  assert.equal(result.href, `${ROOT}?view=history&readerEvent=event-1#message-2`);
  assert.equal(original.searchParams.get('readerSource'), GRANDCHILD);
  assert.equal(original.searchParams.get('readerAncestor'), CHILD);
});

test('reader location requires exactly one nonempty source', () => {
  assert.equal(parseReaderLocation(ROOT), null);
  assert.equal(parseReaderLocation(`${ROOT}?readerAncestor=${encodeURIComponent(CHILD)}`), null);
  assert.equal(parseReaderLocation(locationFor('')), null);
  const duplicate = locationFor(CHILD);
  duplicate.searchParams.append('readerSource', GRANDCHILD);
  assert.equal(parseReaderLocation(duplicate), null);
  assert.equal(parseReaderLocation(locationFor(GRANDCHILD, [''])), null);
});

test('reader location rejects external origins, credentials, and non-session paths', () => {
  for (const source of [
    'https://example.com/fixture/session/child',
    '//example.com/fixture/session/child',
    'http://localhost:3457/fixture/session/child',
    'http://user:password@localhost:3456/fixture/session/child',
    '/fixture/session/', '/fixture/session/child/', '/fixture/session/child/extra', '/fixture/child',
  ]) {
    assert.equal(parseReaderLocation(locationFor(source)), null, source);
    assert.equal(parseReaderLocation(locationFor(GRANDCHILD, [source])), null, `ancestor: ${source}`);
  }
  assert.equal(parseReaderLocation(locationFor(CHILD), 'https://example.com'), null);
  assert.equal(parseReaderLocation(locationFor(CHILD, [], 'http://user@localhost:3456/fixture/session/root')), null);
  assert.equal(parseReaderLocation(locationFor(CHILD, [], 'http://localhost:3456/')), null);
  assert.equal(parseReaderLocation('not a URL'), null);
});

test('reader location rejects malformed percent escapes at each URL boundary', () => {
  for (const source of [
    '/fixture/session/child%', '/fixture/session/%FF', '/fixture/session/%E0%A4%A',
    '/fixture/session/child?readerEvent=%ZZ', '/fixture/session/child#message%',
  ]) {
    assert.equal(parseReaderLocation(locationFor(source)), null, source);
    assert.equal(parseReaderLocation(locationFor(GRANDCHILD, [source])), null, `ancestor: ${source}`);
  }
  assert.equal(parseReaderLocation(`${ROOT}?readerSource=%FF`), null);
  assert.equal(parseReaderLocation(`${ROOT}?readerSource=%`), null);
  assert.equal(parseReaderLocation(locationFor(CHILD, [], `${ROOT}%`)), null);
});

test('reader location rejects recursive sources and ancestors', () => {
  for (const nested of [
    `${CHILD}?readerSource=${encodeURIComponent(GRANDCHILD)}`,
    `${CHILD}?readerAncestor=${encodeURIComponent(GRANDCHILD)}`,
    `${CHILD}?reader%53ource=${encodeURIComponent(GRANDCHILD)}`,
  ]) {
    assert.equal(parseReaderLocation(locationFor(nested)), null);
    assert.equal(parseReaderLocation(locationFor(GRANDCHILD, [nested])), null);
  }
});

test('reader location rejects root, target, and repeated ancestors by session identity', () => {
  for (const ancestors of [
    [ROOT], [GRANDCHILD], [CHILD, CHILD], [`${ROOT}?view=history#message-2`],
    [`${GRANDCHILD}?readerEvent=event-2`], [CHILD, '/fixture/session/%63hild#message-3'],
  ]) {
    assert.equal(parseReaderLocation(locationFor(GRANDCHILD, ancestors)), null, JSON.stringify(ancestors));
  }
  assert.equal(parseReaderLocation(locationFor(ROOT, [CHILD])), null);
  assert.equal(parseReaderLocation(locationFor(`${ROOT}?readerEvent=event-1`)).source.searchParams.get('readerEvent'), 'event-1');
});

test('reader location creation rejects invalid source chains without laundering their origins', () => {
  assert.throws(() => createReaderLocation(ROOT, 'https://example.com/fixture/session/child'), TypeError);
  assert.throws(() => createReaderLocation(ROOT, GRANDCHILD, [ROOT]), TypeError);
  assert.throws(() => createReaderLocation(ROOT, `${CHILD}?readerSource=${encodeURIComponent(GRANDCHILD)}`), TypeError);
});
