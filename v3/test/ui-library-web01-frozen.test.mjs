import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Opt in when the native service is running against the ignored frozen corpus.
// The test reads the service and corpus without starting or stopping it.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const enabled = process.env.AGENTSESSION_WEB01_FROZEN === '1';
const v3Base = process.env.AGENTSESSION_WEB01_V3_BASE_URL || 'http://127.0.0.1:3467';
const corpusDir = path.resolve(process.env.AGENTSESSION_WEB01_CORPUS || path.join(repo, 'tmp', 'v3-corpus'));
const browserName = process.platform === 'win32'
  ? 'agent-browser-win32-x64.exe' : `agent-browser-${process.platform}-${process.arch}`;
const browserBinary = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
  (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', browserName))
    .find(existsSync);
const skip = !enabled ? 'Set AGENTSESSION_WEB01_FROZEN=1 to run against the native service and frozen corpus.'
  : !browserBinary || !existsSync(browserBinary) ? 'agent-browser is required for frozen browser acceptance.'
    : !existsSync(path.join(corpusDir, 'manifest.private.json')) ? 'The opt-in frozen corpus manifest is missing.' : false;

const activeProviders = ['claude-code', 'codex', 'deepseek-harness', 'opencode', 'pi'];

function normalized(value) {
  return String(value ?? '').trim().replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase('en-US');
}

function identity(row) {
  return `${row.provider}\u0000${row.sessionId}`;
}

function familyIdentity(family) {
  return [family.session.session.provider, family.session.session.sessionId];
}

function privateIdentityDigest(identities) {
  return createHash('sha256').update(JSON.stringify(identities)).digest('hex');
}

function assertPrivateIdentitySequence(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label} count`);
  assert.equal(privateIdentityDigest(actual), privateIdentityDigest(expected), label);
}

function sortedIdentities(identities) {
  return identities.slice().sort((left, right) => {
    const leftKey = JSON.stringify(left);
    const rightKey = JSON.stringify(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function offsetRoots(data) {
  return data.sessions.map(row => ({
    provider: row.provider,
    sessionId: row.id,
    title: row.title,
    directory: row.directory,
    href: row.href,
  }));
}

function v3Roots(data) {
  return data.families.map(family => ({
    provider: family.session.session.provider,
    sessionId: family.session.session.sessionId,
    title: family.session.title,
    directory: family.session.directory,
  }));
}

function duplicateGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.provider, normalized(row.title), normalized(row.directory)]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].filter(group => group.length >= 2);
}

function duplicateKey(row) {
  return JSON.stringify([row.provider, normalized(row.title), normalized(row.directory)]);
}

function requestJson(base, route) {
  return fetch(new URL(route, base), { signal: AbortSignal.timeout(30_000) }).then(async response => {
    assert.equal(response.status, 200, `${new URL(route, base).pathname} returns HTTP 200`);
    return response.json();
  });
}

async function paginatedOffsetLibraryFamilies(origin) {
  const sessions = [];
  let total, matchingSessions;
  while (true) {
    const params = new URLSearchParams({ limit: '100', offset: String(sessions.length), sort: 'title-asc' });
    const page = await requestJson(origin, `/api/library/sessions?${params}`);
    total ??= page.total;
    matchingSessions ??= page.matchingSessions;
    assert.equal(page.total, total, 'native offset pagination retains the root total');
    assert.equal(page.matchingSessions, matchingSessions);
    assert.equal(page.offset, sessions.length);
    assert.equal(page.sessions.length, Math.min(100, total - sessions.length));
    sessions.push(...page.sessions);
    if (!page.hasMore) break;
    assert.ok(sessions.length < total, 'native offset pagination advances toward the final root');
  }
  assert.equal(sessions.length, total, 'native offset traversal reaches every root');
  assert.equal(new Set(sessions.map(row => `${row.provider}:${row.id}`)).size, total);
  return { sessions, total, matchingSessions };
}

async function paginatedLibraryFamilies(origin, filters) {
  const pageSize = 40;
  const families = [];
  const seenCursors = new Set();
  let cursor = null;
  let pageCount = 0;
  let total = null;
  let matchingSessions = null;

  while (true) {
    const params = new URLSearchParams({ limit: String(pageSize) });
    for (const [name, value] of Object.entries(filters)) {
      if (value) params.set(name, value);
    }
    if (cursor) params.set('cursor', cursor);
    const page = await requestJson(origin, `/api/v3/library/sessions?${params}`);
    if (total === null) {
      total = page.total;
      matchingSessions = page.matchingSessions;
    }
    assert.equal(page.total, total, 'direct API pagination keeps one family total');
    assert.equal(page.matchingSessions, matchingSessions,
      'direct API pagination keeps one matching-session total');
    assert.ok(Array.isArray(page.families), 'direct API page contains family rows');
    assert.equal(page.families.length, Math.min(pageSize, total - families.length),
      'direct API page contains the expected number of remaining families');
    families.push(...page.families);
    pageCount++;

    if (!page.nextCursor) break;
    assert.ok(!seenCursors.has(page.nextCursor), 'direct API pagination advances its cursor');
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
    assert.ok(pageCount < Math.ceil(total / pageSize),
      'direct API pagination finishes within the frozen family count');
  }

  assert.equal(families.length, total, 'direct API cursor traversal reaches every family');
  assert.ok(pageCount > 1, 'the frozen Library requires at least one later family page');
  const identities = families.map(familyIdentity);
  assert.equal(new Set(identities.map(JSON.stringify)).size, identities.length,
    'direct API pagination returns each canonical family identity once');
  return { families, identities, pageCount, total, matchingSessions };
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function frozenFiles(manifest) {
  const files = manifest.files.map(file => {
    const providerRoot = manifest.providerRoots[file.provider].path;
    const relativePath = path.win32.relative(providerRoot, file.snapshotPath);
    assert.ok(relativePath && relativePath !== '..' && !relativePath.startsWith('..\\'),
      `the frozen snapshot for ${file.provider} is inside its provider root`);
    return {
      label: `${file.provider}/${relativePath}`,
      path: path.join(corpusDir, file.provider, ...relativePath.split(/[\\/]/)),
      bytes: file.snapshotBytes,
      sha256: file.snapshotSha256,
    };
  });
  files.push({
    label: 'opencode/opencode.db',
    path: path.join(corpusDir, 'opencode', 'opencode.db'),
    bytes: manifest.database.snapshotBytes,
    sha256: manifest.database.snapshotSha256,
  });
  return files;
}

async function assertFrozenCorpus(files, boundary) {
  for (const file of files) {
    assert.equal((await stat(file.path)).size, file.bytes,
      `${boundary}: frozen source byte count remains unchanged for ${file.label}`);
    assert.equal(await sha256(file.path), file.sha256,
      `${boundary}: frozen source digest remains unchanged for ${file.label}`);
  }
}

async function frozenBodySearchTarget(manifest, roots, origin) {
  const messages = [];
  for (const file of manifest.files.filter(entry => entry.provider === 'codex')) {
    const relativePath = path.win32.relative(manifest.providerRoots[file.provider].path, file.snapshotPath);
    const snapshotPath = path.join(corpusDir, file.provider, ...relativePath.split(/[\\/]/));
    const lines = (await readFile(snapshotPath, 'utf8')).split(/\r?\n/);
    const sourceReferences = new Map();
    const seenCursors = new Set();
    let cursor = null;
    do {
      const params = new URLSearchParams({ category: 'message', limit: '200' });
      if (cursor) params.set('cursor', cursor);
      const page = await requestJson(origin,
        `/api/v3/runtime/codex/${encodeURIComponent(file.sessionId)}/events?${params}`);
      for (const event of page.events) {
        if (event.readerEvent?.segment === 'message') {
          sourceReferences.set(event.provenance.sourceId, event.readerEvent);
        }
      }
      cursor = page.nextCursor;
      if (cursor) {
        assert.ok(!seenCursors.has(cursor), 'the raw source-reference traversal advances');
        seenCursors.add(cursor);
      }
    } while (cursor);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      if (!lines[lineIndex]) continue;
      const record = JSON.parse(lines[lineIndex]);
      const event = sourceReferences.get(String(lineIndex));
      if (!event) continue;
      const payload = record.payload;
      let role, text;
      if (record.type === 'response_item' && payload?.type === 'message' &&
          ['user', 'assistant'].includes(payload.role)) {
        role = payload.role;
        text = (payload.content || [])
          .filter(part => part?.type === 'input_text' || part?.type === 'output_text')
          .map(part => part.text || '').join('\n');
      } else if (record.type === 'event_msg' &&
          ['user_message', 'agent_message'].includes(payload?.type)) {
        role = payload.type === 'user_message' ? 'user' : 'assistant';
        text = payload.message;
      } else continue;
      if (!text.trim()) continue;
      assert.equal(event.provider, file.provider);
      assert.equal(event.sessionId, file.sessionId);
      messages.push({ provider: file.provider, sessionId: file.sessionId, role,
        messageId: event.messageId, segment: event.segment, text, lineIndex, lineCount: lines.length });
    }
  }

  const rootByIdentity = new Map(roots.map(row => [identity(row), row]));
  const occurrences = new Map();
  for (const message of messages) {
    const termsInMessage = new Set([...message.text.matchAll(/[\p{L}]{7,}/gu)]
      .map(match => match[0].toLocaleLowerCase('en-US')));
    for (const term of termsInMessage) {
      const matchingMessages = occurrences.get(term) ?? [];
      matchingMessages.push(message);
      occurrences.set(term, matchingMessages);
    }
  }

  const candidates = [];
  for (const [term, matchingMessages] of occurrences) {
    if (matchingMessages.length !== 1) continue;
    const message = matchingMessages[0];
    if (message.lineIndex < message.lineCount / 2) continue;
    const root = rootByIdentity.get(identity(message));
    if (!root || [root.title, root.directory].some(value =>
      String(value ?? '').toLocaleLowerCase('en-US').includes(term))) continue;
    candidates.push({ term, message });
  }
  candidates.sort((left, right) => right.message.lineIndex - left.message.lineIndex ||
    right.term.length - left.term.length);

  for (const candidate of candidates.slice(0, 40)) {
    const searchUrl = new URL('/api/v3/search', origin);
    searchUrl.searchParams.set('q', candidate.term);
    searchUrl.searchParams.set('limit', '20');
    const search = await requestJson(origin, `${searchUrl.pathname}${searchUrl.search}`);
    const match = search.matches.find(item => item.matchField === 'message' &&
      item.matchRole === candidate.message.role && item.session.provider === candidate.message.provider &&
      item.session.sessionId === candidate.message.sessionId &&
      (!candidate.message.messageId || item.event?.messageId === candidate.message.messageId) &&
      item.event?.segment === candidate.message.segment);
    if (!match) continue;

    const readerPath = `/api/v3/reader/${encodeURIComponent(candidate.message.provider)}/` +
      `${encodeURIComponent(candidate.message.sessionId)}`;
    const bootstrap = await requestJson(origin, `${readerPath}/bootstrap`);
    let body = '', offset = 0;
    while (true) {
      const params = new URLSearchParams({ revision: bootstrap.revision,
        messageId: match.event.messageId, segment: match.event.segment,
        field: 'body', offset: String(offset), maxChars: '8192' });
      const content = await requestJson(origin, `${readerPath}/content?${params}`);
      assert.equal(content.offset, offset);
      assert.equal(content.totalChars, candidate.message.text.length);
      body += content.text;
      if (content.nextOffset === null) break;
      assert.ok(content.nextOffset > offset && content.nextOffset <= content.totalChars);
      offset = content.nextOffset;
    }
    assert.equal(body, candidate.message.text,
      'the selected search EventRef resolves to the complete independent raw message');
    const locateUrl = new URL(`${readerPath}/locate`, origin);
    locateUrl.search = new URLSearchParams({ revision: bootstrap.revision,
      messageId: match.event.messageId, segment: match.event.segment });
    const location = await requestJson(origin, `${locateUrl.pathname}${locateUrl.search}`);
    const sameEvent = item => item?.provider === match.event.provider &&
      item?.sessionId === match.event.sessionId && item?.messageId === match.event.messageId &&
      item?.segment === match.event.segment;
    assert.ok(location.ordinal > 0, 'the source-backed content hit resolves to a later Reader event');
    assert.ok(sameEvent(location.event), 'Reader locate preserves the exact content-search event');
    assert.equal(location.owner, null, 'the matched root message has no synthetic owner');
    return { term: candidate.term, message: candidate.message, match, location };
  }

  assert.fail('The frozen Codex source has no title-absent late message term with an exact Reader event.');
}

function stableReaderAnchor(event) {
  return 'event-' + Buffer.from(JSON.stringify([
    event.provider, event.sessionId, event.messageId, event.segment,
  ]), 'utf8').toString('hex');
}

function browserSession(t, url) {
  const session = `agentsession-v3-web01-${process.pid}-${Date.now()}`;
  const command = (...args) => new Promise((resolve, reject) => {
    const child = spawn(browserBinary, ['--session', session, ...args],
      { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`agent-browser ${args[0]} timed out`));
    }, 20_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout));
    });
  });
  t.after(async () => { try { await command('close'); } catch { /* Already closed. */ } });
  return (async () => {
    await command('open', url);
    await command('set', 'viewport', '1440', '900');
    return command;
  })();
}

async function waitFor(command, expression, label) {
  const deadline = Date.now() + 15_000;
  let last = '';
  while (Date.now() < deadline) {
    last = await command('eval', `Boolean(${expression})`);
    if (last.includes('true')) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}; last result: ${last}`);
}

async function browserScrollDiagnostics(command) {
  return JSON.parse(await command('eval', `(() => {
    const root = document.documentElement;
    const body = document.body;
    const scrolling = document.scrollingElement;
    const main = document.querySelector('.library-main');
    const active = document.activeElement;
    const links = [...document.querySelectorAll('a.session-row, a.unlinked-child-row')];
    const search = document.querySelector('form.list-toolbar input[type="search"]');
    const provider = document.querySelector('[data-library-provider]');
    const project = document.querySelector('[data-library-project]');
    const range = document.querySelector('[data-library-range]');
    const sort = document.querySelector('[data-library-sort]');
    const metrics = element => element ? {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      overflowY: getComputedStyle(element).overflowY,
      minHeight: getComputedStyle(element).minHeight,
    } : null;
    return {
      routeKind: location.pathname === '/sessions' ? 'library'
        : /^\\/[^/]+\\/session\\/[^/]+$/.test(location.pathname) ? 'reader' : 'other',
      hasQuery: Boolean(location.search),
      hasHash: Boolean(location.hash),
      windowScrollY: window.scrollY,
      viewportHeight: window.innerHeight,
      scrollingTag: scrolling?.tagName ?? null,
      scrolling: metrics(scrolling),
      html: metrics(root),
      body: metrics(body),
      libraryMain: metrics(main),
      rootLinkCount: document.querySelectorAll('a.session-row').length,
      unresolvedLinkCount: document.querySelectorAll('a.unlinked-child-row').length,
      familyMorePresent: Boolean(document.querySelector('button.family-more')),
      activeTag: active?.tagName ?? null,
      activeClass: typeof active?.className === 'string' ? active.className : null,
      activeIsLibraryLink: active instanceof HTMLAnchorElement && links.includes(active),
      activeLibraryLinkIndex: links.indexOf(active),
      activeRootIndex: [...document.querySelectorAll('a.session-row')].indexOf(active),
      searchHasValue: Boolean(search?.value),
      providerSelected: Boolean(provider?.value),
      projectSelected: Boolean(project?.value),
      rangeIsAll: range?.value === '',
      sortIsTitleAscending: sort?.value === 'title-asc',
      inlineHtmlMinHeight: root.style.minHeight,
      inlineBodyMinHeight: body.style.minHeight,
      inlineScrollBehavior: root.style.scrollBehavior,
    };
  })()`));
}

async function waitForScrollPosition(command, expression, label) {
  try {
    await waitFor(command, expression, label);
  } catch {
    const diagnostics = await browserScrollDiagnostics(command);
    throw new Error(`Timed out waiting for ${label}; browser diagnostics: ${JSON.stringify(diagnostics)}`);
  }
}

async function browserLibraryIdentities(command) {
  return JSON.parse(await command('eval', `(() => {
    const read = selector => [...document.querySelectorAll(selector)].map(anchor => {
      const parts = new URL(anchor.href).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      return parts.length === 3 && parts[1] === 'session' ? [parts[0], parts[2]] : null;
    });
    return { roots: read('a.session-row'), unlinked: read('a.unlinked-child-row') };
  })()`));
}

async function waitForBrowserLibraryOrder(command, expected, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const actual = await browserLibraryIdentities(command);
    const valid = [...actual.roots, ...actual.unlinked].every(Array.isArray);
    if (valid && actual.roots.length === expected.roots.length &&
      actual.unlinked.length === expected.unlinked.length &&
      privateIdentityDigest(actual.roots) === privateIdentityDigest(expected.roots) &&
      privateIdentityDigest(actual.unlinked) === privateIdentityDigest(expected.unlinked)) return actual;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function loopbackOrigin(value, name) {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:', `${name} uses local HTTP`);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    `${name} must stay on loopback because the corpus is private`);
  return url.origin;
}

test('WEB-01 frozen five-provider Library keeps same-title canonical identity and Reader return state',
  { skip, timeout: 180_000 }, async t => {
    const originV3 = loopbackOrigin(v3Base, '3.0 base URL');
    const manifest = JSON.parse(await readFile(path.join(corpusDir, 'manifest.private.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 1, 'the private frozen corpus manifest is recognized');
    const frozen = await frozenFiles(manifest);
    await assertFrozenCorpus(frozen, 'before WEB-01');

    const [offsetData, v3Data] = await Promise.all([
      paginatedOffsetLibraryFamilies(originV3),
      paginatedLibraryFamilies(originV3, { sort: 'title-asc' }),
    ]);

    const rootsOffset = offsetRoots(offsetData);
    const rootsV3 = v3Roots(v3Data);
    assert.deepEqual([...new Set(rootsOffset.map(row => row.provider))].sort(), activeProviders,
      'the native offset Library covers all five active providers');
    assert.deepEqual([...new Set(rootsV3.map(row => row.provider))].sort(), activeProviders,
      'the frozen 3.0 Library covers all five active providers');
    assertPrivateIdentitySequence(sortedIdentities(rootsV3.map(row => [row.provider, row.sessionId])),
      sortedIdentities(rootsOffset.map(row => [row.provider, row.sessionId])),
      'native cursor and offset endpoints preserve the complete root identity set');
    assert.equal(v3Data.matchingSessions, offsetData.matchingSessions,
      'native cursor and offset endpoints report the same total including child sessions');

    const v3DuplicateGroups = new Map(duplicateGroups(rootsV3).map(group => [duplicateKey(group[0]), group]));
    const candidates = duplicateGroups(rootsOffset).filter(group => {
      const counterpart = v3DuplicateGroups.get(duplicateKey(group[0]));
      return counterpart &&
        JSON.stringify(counterpart.map(identity).sort()) === JSON.stringify(group.map(identity).sort());
    }).sort((left, right) => left[0].title.localeCompare(right[0].title, 'en-US') ||
      left[0].directory.localeCompare(right[0].directory, 'en-US'));
    assert.ok(candidates.length > 0, 'the frozen Library contains a same-title pair in one project');
    const duplicate = candidates[0].slice().sort((left, right) => identity(left).localeCompare(identity(right))).slice(0, 2);
    const expectedPaths = duplicate.map(row =>
      `/${encodeURIComponent(row.provider)}/session/${encodeURIComponent(row.sessionId)}`);
    for (const row of duplicate) {
      const offsetRow = rootsOffset.find(candidate => identity(candidate) === identity(row));
      const current = rootsV3.find(candidate => identity(candidate) === identity(row));
      assert.equal(offsetRow.title, row.title, 'the duplicate title agrees with the native offset API');
      assert.equal(current.title, row.title, 'the duplicate title is unchanged in 3.0');
      assert.equal(current.directory, row.directory, 'the duplicate remains in the same project');
      const href = new URL(offsetRow.href, originV3);
      assert.equal(href.origin, originV3, 'the native offset link stays on the selected service');
      assert.equal(href.pathname, expectedPaths[duplicate.indexOf(row)],
        'the native offset link retains the exact canonical provider/session path');
      assert.equal(href.searchParams.get('from'), '/sessions',
        'the native offset link retains the Library return location');
    }
    assert.equal(new Set(expectedPaths).size, 2, 'the same title belongs to two distinct canonical IDs');

    const filteredUrl = new URL('/api/v3/library/sessions', originV3);
    filteredUrl.search = new URLSearchParams({
      limit: '100',
      search: duplicate[0].title,
      provider: duplicate[0].provider,
      project: duplicate[0].directory,
      sort: 'title-asc',
    });
    const filteredData = await requestJson(originV3, `${filteredUrl.pathname}${filteredUrl.search}`);
    const filteredPaths = new Set(v3Roots(filteredData).map(row => `/${row.provider}/session/${row.sessionId}`));
    for (const expectedPath of expectedPaths) {
      assert.ok(filteredPaths.has(expectedPath),
        'the 3.0 filtered API returns each same-title canonical identity');
    }

    const command = await browserSession(t, `${originV3}/sessions`);
    const search = 'input[placeholder="Find by title, folder, or session ID"]';
    const providerFilter = 'select[aria-label="Provider filter"]';
    const projectFilter = 'input[aria-label="Project path filter"]';
    const rangeFilter = 'select[aria-label="Time range"]';
    const sortFilter = 'select[aria-label="Sort"]';
    await waitFor(command, `document.querySelector(${JSON.stringify(search)})`, 'Library search control');

    await command('select', sortFilter, 'title-asc');
    await waitFor(command, `performance.getEntriesByType('resource').some(entry => {
      try {
        const url = new URL(entry.name);
        return url.pathname === '/api/v3/library/sessions' &&
          url.searchParams.get('limit') === '40' && url.searchParams.get('sort') === 'title-asc' &&
          !url.searchParams.has('cursor');
      } catch { return false; }
    })`, 'title-sorted first Library page request');
    const paginationFilters = JSON.parse(await command('eval', `(() => ({
      search: document.querySelector(${JSON.stringify(search)})?.value.trim() ?? '',
      provider: document.querySelector(${JSON.stringify(providerFilter)})?.value ?? '',
      project: document.querySelector(${JSON.stringify(projectFilter)})?.value.trim() ?? '',
      range: document.querySelector(${JSON.stringify(rangeFilter)})?.value ?? '',
      sort: document.querySelector(${JSON.stringify(sortFilter)})?.value ?? '',
    }))()`));
    assert.equal(paginationFilters.search === '' && paginationFilters.provider === '' &&
      paginationFilters.project === '' && paginationFilters.range === '' &&
      paginationFilters.sort === 'title-asc', true,
    'the browser pagination check uses an empty Library filter set with title-ascending sort');

    const paginated = await paginatedLibraryFamilies(originV3, paginationFilters);
    const apiRootOrder = paginated.families.filter(family => !family.parentBoundary).map(familyIdentity);
    const apiUnlinkedOrder = paginated.families.filter(family => family.parentBoundary).map(familyIdentity);
    const firstPageGroups = {
      roots: paginated.families.slice(0, 40).filter(family => !family.parentBoundary).map(familyIdentity),
      unlinked: paginated.families.slice(0, 40).filter(family => family.parentBoundary).map(familyIdentity),
    };
    await waitForBrowserLibraryOrder(command, firstPageGroups, 'first visible Library page in API order');
    assert.equal(JSON.parse(await command('eval',
      `document.querySelectorAll('a.session-row, a.unlinked-child-row').length`)), 40,
    'the first visible Library page contains one complete API page');

    for (let pageNumber = 2; pageNumber <= paginated.pageCount; pageNumber++) {
      await waitFor(command, `document.querySelector('button.family-more')`,
        `visible Load more control before Library page ${pageNumber}`);
      const hasVisibleLoadMoreLabel = await command('eval',
        `document.querySelector('button.family-more')?.innerText.trim().toLocaleLowerCase('en-US').startsWith('load more families') === true`);
      assert.equal(hasVisibleLoadMoreLabel.includes('true'), true,
        'the next family page is reachable through the visible Library control');
      await command('click', 'button.family-more');
      const expectedFamilyCount = Math.min(paginated.total, pageNumber * 40);
      await waitFor(command,
        `document.querySelectorAll('a.session-row, a.unlinked-child-row').length === ${expectedFamilyCount}`,
        `visible Library page ${pageNumber} appends every family row`);
    }
    await waitFor(command, `!document.querySelector('button.family-more')`,
      'the visible Library pagination control disappears at the API end');

    const completeBrowserGroups = await waitForBrowserLibraryOrder(command,
      { roots: apiRootOrder, unlinked: apiUnlinkedOrder }, 'all paginated Library rows in API order');
    const browserIdentities = [...completeBrowserGroups.roots, ...completeBrowserGroups.unlinked];
    assertPrivateIdentitySequence(completeBrowserGroups.roots, apiRootOrder,
      'visible canonical root order matches the direct API order');
    assertPrivateIdentitySequence(completeBrowserGroups.unlinked, apiUnlinkedOrder,
      'visible unresolved-parent order matches the direct API order');
    assertPrivateIdentitySequence(sortedIdentities(browserIdentities),
      sortedIdentities(paginated.identities),
      'the complete visible Library identity set matches every direct API family');

    const paginationScroll = JSON.parse(await command('eval', `(() => {
      const scrolling = document.scrollingElement;
      const originalScrollBehavior = document.documentElement.style.scrollBehavior;
      document.documentElement.style.scrollBehavior = 'auto';
      if (scrolling) scrolling.scrollTop = 420;
      document.documentElement.style.scrollBehavior = originalScrollBehavior;
      const roots = [...document.querySelectorAll('a.session-row')];
      const index = roots.findIndex(link => {
        const rect = link.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= window.innerHeight;
      });
      if (index >= 0) roots[index].focus({ preventScroll: true });
      return {
        routeKind: location.pathname === '/sessions' ? 'library' : 'other',
        scrollY: window.scrollY,
        scrollHeight: scrolling?.scrollHeight ?? 0,
        viewportHeight: window.innerHeight,
        rootCount: roots.length,
        unresolvedLinkCount: document.querySelectorAll('a.unlinked-child-row').length,
        activeRootIndex: roots.indexOf(document.activeElement),
        activeIsRootLink: document.activeElement instanceof HTMLAnchorElement &&
          document.activeElement.classList.contains('session-row'),
      };
    })()`));
    console.log(`WEB-01 natural-list pre-navigation state ${JSON.stringify(await browserScrollDiagnostics(command))}`);
    console.log(`WEB-01 natural-list requested position ${JSON.stringify(paginationScroll)}`);
    assert.equal(paginationScroll.routeKind === 'library' &&
      paginationScroll.scrollHeight > paginationScroll.viewportHeight + 420, true,
    'the complete Library list provides natural document scrolling');
    assert.equal(Math.abs(paginationScroll.scrollY - 420) <= 2, true,
      'the fully paginated Library reaches a nonzero natural scroll position');
    assert.equal(paginationScroll.activeRootIndex >= 0 && paginationScroll.activeIsRootLink, true,
      'a visible canonical root receives keyboard focus at the natural scroll position');

    const paginationTargetPath = JSON.parse(await command('eval', `(() => {
      return document.activeElement instanceof HTMLAnchorElement
        ? document.activeElement.getAttribute('href') : null;
    })()`));
    assert.equal(typeof paginationTargetPath, 'string',
      'a canonical root remains keyboard reachable after the final Library page');
    await command('press', 'Enter');
    await waitFor(command, `location.pathname !== '/sessions' &&
      !!document.querySelector('#reader-title')`, 'Reader opened from the fully paginated Library');
    await command('back');
    await waitFor(command, `location.pathname === '/sessions' &&
      document.querySelectorAll('a.session-row, a.unlinked-child-row').length === ${paginated.total} &&
      !document.querySelector('button.family-more') &&
      document.querySelector(${JSON.stringify(sortFilter)})?.value === 'title-asc'`,
    'the complete title-sorted Library after Reader Back');
    const restoredPaginationFilters = JSON.parse(await command('eval', `(() => ({
      search: document.querySelector(${JSON.stringify(search)})?.value.trim() ?? '',
      provider: document.querySelector(${JSON.stringify(providerFilter)})?.value ?? '',
      project: document.querySelector(${JSON.stringify(projectFilter)})?.value.trim() ?? '',
      range: document.querySelector(${JSON.stringify(rangeFilter)})?.value ?? '',
      sort: document.querySelector(${JSON.stringify(sortFilter)})?.value ?? '',
    }))()`));
    assert.equal(Object.keys(paginationFilters).every(key =>
      restoredPaginationFilters[key] === paginationFilters[key]), true,
    'Reader Back restores every Library filter and sort value');
    const restoredBrowserGroups = await waitForBrowserLibraryOrder(command,
      { roots: apiRootOrder, unlinked: apiUnlinkedOrder }, 'complete paginated Library order after Reader Back');
    assertPrivateIdentitySequence(sortedIdentities([
      ...restoredBrowserGroups.roots, ...restoredBrowserGroups.unlinked,
    ]), sortedIdentities(paginated.identities),
    'Reader Back restores the complete canonical Library identity set');
    await waitForScrollPosition(command, 'Math.abs(window.scrollY - 420) <= 10',
      'natural full-list Library scroll after Reader Back');
    const restoredPaginationScroll = await browserScrollDiagnostics(command);
    console.log(`WEB-01 natural-list scroll after Reader Back ${JSON.stringify(restoredPaginationScroll)}`);
    assert.equal(restoredPaginationScroll.routeKind === 'library' &&
      Math.abs(restoredPaginationScroll.windowScrollY - 420) <= 10 &&
      restoredPaginationScroll.activeIsLibraryLink &&
      restoredPaginationScroll.activeRootIndex === paginationScroll.activeRootIndex, true,
    'Reader Back restores the natural scroll position and focused canonical root');

    await command('fill', search, duplicate[0].title);
    await command('select', providerFilter, duplicate[0].provider);
    await command('fill', projectFilter, duplicate[0].directory);
    await command('select', sortFilter, 'title-asc');
    const expectedSelectorChecks = expectedPaths.map(pathname =>
      `Boolean(document.querySelector('a[href^=${JSON.stringify(pathname)}]'))`).join(' && ');
    await waitFor(command, expectedSelectorChecks, 'both same-title canonical Library links');

    const visibleDuplicates = JSON.parse(await command('eval', `(() => {
      const expected = new Set(${JSON.stringify(expectedPaths)});
      return [...document.querySelectorAll('a[href]')].map(anchor => ({
        href: anchor.getAttribute('href'),
        path: new URL(anchor.href).pathname,
        text: anchor.innerText.trim(),
      })).filter(link => expected.has(link.path));
    })()`));
    assert.equal(visibleDuplicates.length, 2,
      'Library renders two independent links for the shared title');
    assert.equal(new Set(visibleDuplicates.map(link => link.path)).size, 2,
      'each visible title links to its own canonical session');
    assert.ok(visibleDuplicates.every(link => link.text.includes(duplicate[0].title)),
      'both independently linked rows visibly retain the shared title');

    const browserRequests = JSON.parse(await command('eval', `(() =>
      performance.getEntriesByType('resource')
        .map(entry => entry.name)
        .filter(name => name.includes('/api/v3/library/sessions'))
    )()`));
    const requestedFilters = browserRequests.map(name => new URL(name)).find(url =>
      url.searchParams.get('search') === duplicate[0].title &&
      url.searchParams.get('provider') === duplicate[0].provider &&
      normalized(url.searchParams.get('project')) === normalized(duplicate[0].directory) &&
      url.searchParams.get('sort') === 'title-asc');
    assert.ok(requestedFilters,
      'the real Library browser sends title, provider, project, and sort filters to the sessions API');

    const targetPath = expectedPaths[0];
    await command('focus', `a[href^="${targetPath}"]`);
    const duplicateFocus = JSON.parse(await command('eval', `(() => ({
      activePath: document.activeElement instanceof HTMLAnchorElement
        ? new URL(document.activeElement.href).pathname : null,
    }))()`));
    assert.equal(duplicateFocus.activePath === targetPath, true,
      'the chosen canonical result has keyboard focus before opening Reader');

    await command('press', 'Enter');
    await waitFor(command, `location.pathname === ${JSON.stringify(targetPath)} &&
      document.querySelector('#reader-title')?.textContent.trim() === ${JSON.stringify(duplicate[0].title)}`,
    'the chosen canonical Reader');
    await command('reload');
    await waitFor(command, `location.pathname === ${JSON.stringify(targetPath)} &&
      document.querySelector('#reader-title')?.textContent.trim() === ${JSON.stringify(duplicate[0].title)}`,
    'Reader after reload');
    await command('back');
    await waitFor(command, expectedSelectorChecks, 'same-title links after Reader Back');
    const restored = JSON.parse(await command('eval', `(() => ({
      path: location.pathname,
      activePath: document.activeElement instanceof HTMLAnchorElement
        ? new URL(document.activeElement.href).pathname : null,
      search: document.querySelector(${JSON.stringify(search)})?.value ?? null,
      provider: document.querySelector(${JSON.stringify(providerFilter)})?.value ?? null,
      project: document.querySelector(${JSON.stringify(projectFilter)})?.value ?? null,
      range: document.querySelector(${JSON.stringify(rangeFilter)})?.selectedOptions[0]?.textContent.trim() ?? null,
      sort: document.querySelector(${JSON.stringify(sortFilter)})?.value ?? null,
    }))()`));
    assert.equal(restored.path, '/sessions');
    assert.equal(restored.activePath === targetPath, true,
      'Reader Back restores focus to the exact departed canonical link');
    assert.equal(restored.search, duplicate[0].title, 'Reader Back restores the title search');
    assert.equal(restored.provider, duplicate[0].provider, 'Reader Back restores the provider filter');
    assert.equal(normalized(restored.project), normalized(duplicate[0].directory),
      'Reader Back restores the project filter');
    assert.equal(restored.range, 'All', 'Reader Back restores the unbounded time range');
    assert.equal(restored.sort, 'title-asc', 'Reader Back restores the sort order');

    const bodyTarget = await frozenBodySearchTarget(manifest, rootsV3, originV3);
    const bodyEvent = bodyTarget.match.event;
    const bodyPath = `/${encodeURIComponent(bodyEvent.provider)}/session/${encodeURIComponent(bodyEvent.sessionId)}`;
    const bodyAnchor = stableReaderAnchor(bodyEvent);
    const bodySearch = 'input[placeholder="Find a recorded message or decision"]';
    const targetLinkExpression = `Array.from(document.querySelectorAll('.search-result a')).some(anchor => {
      const targetUrl = new URL(anchor.href);
      const eventQuery = new URLSearchParams(targetUrl.hash.startsWith('#event?') ? targetUrl.hash.slice(7) : '');
      return targetUrl.pathname === ${JSON.stringify(bodyPath)} &&
        eventQuery.get('messageId') === ${JSON.stringify(bodyEvent.messageId)} &&
        eventQuery.get('segment') === ${JSON.stringify(bodyEvent.segment)};
    })`;
    await command('click', '[data-search-mode="content"]');
    await waitFor(command, `document.querySelector(${JSON.stringify(bodySearch)})`,
      'conversation-content search input');
    await command('fill', bodySearch, bodyTarget.term);
    await command('click', '.search-submit');
    await waitFor(command, targetLinkExpression,
      'the frozen source-backed search result with its canonical Reader event');
    const browserSearchRequest = JSON.parse(await command('eval', `(() =>
      performance.getEntriesByType('resource').map(entry => entry.name).some(name => {
        try {
          const url = new URL(name);
          return url.pathname === '/api/v3/search' && url.searchParams.get('q') === ${JSON.stringify(bodyTarget.term)};
        } catch { return false; }
      })
    )()`));
    assert.equal(browserSearchRequest, true,
      'the real Library browser sends the source-derived body term to the content-search API');

    const focusBodyResult = JSON.parse(await command('eval', `(() => {
      const anchor = [...document.querySelectorAll('.search-result a')].find(link => {
        const url = new URL(link.href);
        const eventQuery = new URLSearchParams(url.hash.startsWith('#event?') ? url.hash.slice(7) : '');
        return url.pathname === ${JSON.stringify(bodyPath)} &&
          eventQuery.get('messageId') === ${JSON.stringify(bodyEvent.messageId)} &&
          eventQuery.get('segment') === ${JSON.stringify(bodyEvent.segment)};
      });
      if (!anchor) return false;
      anchor.focus();
      return document.activeElement === anchor;
    })()`));
    assert.equal(focusBodyResult, true, 'the exact body-search result can receive keyboard focus');

    await command('press', 'Enter');
    const expectedReader = `location.pathname === ${JSON.stringify(bodyPath)} && (() => {
      const eventQuery = new URLSearchParams(location.hash.startsWith('#event?') ? location.hash.slice(7) : '');
      return eventQuery.get('messageId') === ${JSON.stringify(bodyEvent.messageId)} &&
        eventQuery.get('segment') === ${JSON.stringify(bodyEvent.segment)};
    })()`;
    await waitFor(command, expectedReader, 'Reader opened at the exact body-search event');
    const readerAnchorPresent = `(() => {
      const target = document.getElementById(${JSON.stringify(bodyAnchor)});
      const sourceReference = target ? target.dataset.messageId + ' / ' + target.dataset.segment : null;
      const rect = target?.getBoundingClientRect();
      return !!target && sourceReference === ${JSON.stringify(`${bodyEvent.messageId} / ${bodyEvent.segment}`)} &&
        rect.top < window.innerHeight && rect.bottom > 0;
    })()`;
    await waitFor(command, readerAnchorPresent, 'the exact source event card in Reader');
    await command('reload');
    await waitFor(command, expectedReader, 'Reader after reloading the body-search event');
    await waitFor(command, readerAnchorPresent, 'the source event anchor after Reader reload');
    await command('back');
    await waitFor(command, `${targetLinkExpression} &&
      document.querySelector('[data-search-mode="content"]')?.getAttribute('aria-pressed') === 'true' &&
      document.querySelector(${JSON.stringify(bodySearch)})?.value === ${JSON.stringify(bodyTarget.term)} &&
      [...document.querySelectorAll('.search-result a')].some(anchor => {
        const url = new URL(anchor.href);
        const eventQuery = new URLSearchParams(url.hash.startsWith('#event?') ? url.hash.slice(7) : '');
        return document.activeElement === anchor && url.pathname === ${JSON.stringify(bodyPath)} &&
          eventQuery.get('messageId') === ${JSON.stringify(bodyEvent.messageId)} &&
          eventQuery.get('segment') === ${JSON.stringify(bodyEvent.segment)};
      })`, 'body-search query, exact result, and focus after Reader Back');
    const restoredBodySearch = JSON.parse(await command('eval', `(() => ({
      path: location.pathname,
      queryRestored: document.querySelector(${JSON.stringify(bodySearch)})?.value === ${JSON.stringify(bodyTarget.term)},
      contentModeRestored: document.querySelector('[data-search-mode="content"]')?.getAttribute('aria-pressed') === 'true',
      resultRestored: ${targetLinkExpression},
      focusRestored: (() => {
        const anchor = document.activeElement;
        if (!(anchor instanceof HTMLAnchorElement)) return false;
        const url = new URL(anchor.href);
        const eventQuery = new URLSearchParams(url.hash.startsWith('#event?') ? url.hash.slice(7) : '');
        return url.pathname === ${JSON.stringify(bodyPath)} &&
          eventQuery.get('messageId') === ${JSON.stringify(bodyEvent.messageId)} &&
          eventQuery.get('segment') === ${JSON.stringify(bodyEvent.segment)};
      })(),
    }))()`));
    assert.ok(restoredBodySearch.path === '/sessions' && restoredBodySearch.queryRestored &&
      restoredBodySearch.contentModeRestored && restoredBodySearch.resultRestored &&
      restoredBodySearch.focusRestored,
    'Reader Back restores the body-search mode, query, canonical result, and focus');

    await command('close');
    await assertFrozenCorpus(frozen, 'after WEB-01');
  });
