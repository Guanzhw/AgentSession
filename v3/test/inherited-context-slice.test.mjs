import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const fixture = path.join(repo, 'v3', 'fixtures', 'codex-inherited', 'sessions', '2026', '09', '27',
  'rollout-public-child.jsonl');
const privateManifest = path.join(repo, 'tmp', 'v3-inherited-real-20260927', 'manifest.private.json');
const childId = 'codex-inherited-public-child';
const foreignChildId = 'codex-inherited-public-foreign';
const parentId = 'codex-inherited-absent-parent';
const sharedMessageId = 'shared-body';
const longMessageId = 'dev-44';
const longBody = `Inherited developer context 44 ${'z'.repeat(13_000)} END_OF_PUBLIC_INHERITED_CONTEXT`;

async function digest(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function freePort() {
  return freeFetchSafePort();
}

async function allFiles(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await allFiles(file));
    else if (entry.isFile()) found.push(file);
  }
  return found;
}

async function startAxum(t, sources) {
  assert.ok(existsSync(binary), `Build the S2 Rust binary at ${binary}`);
  const temp = await mkdtemp(path.join(repo, 'tmp', 'v3-inherited-context-'));
  const codexDir = path.join(temp, 'codex');
  const directories = Object.fromEntries(['claude', 'pi', 'dsh', 'meta', 'index', 'cache']
    .map(name => [name, path.join(temp, name)]));
  await Promise.all([mkdir(codexDir), ...Object.values(directories).map(directory => mkdir(directory))]);
  const sessionDir = path.join(codexDir, 'sessions', '2026', '09', '27');
  await mkdir(sessionDir, { recursive: true });
  const copies = new Map();
  for (const source of sources) {
    const destination = path.join(sessionDir, source.fileName ?? source.name);
    if (source.sessionId) {
      const rows = (await readFile(source.file, 'utf8')).trimEnd().split('\n').map(JSON.parse);
      rows[0].payload.id = source.sessionId;
      rows[0].payload.session_id = source.sessionId;
      await writeFile(destination, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    } else {
      await copyFile(source.file, destination);
    }
    copies.set(source.name, destination);
  }
  t.after(async () => {
    const resolvedTemp = path.resolve(temp);
    const resolvedTmp = path.resolve(repo, 'tmp');
    assert.equal(path.dirname(resolvedTemp), resolvedTmp, 'Cleanup target remains under repository tmp');
    assert.ok(path.basename(resolvedTemp).startsWith('v3-inherited-context-'));
    await rm(resolvedTemp, { recursive: true, force: true });
  });

  const port = await freePort();
  const args = ['serve', '--port', String(port), '--codex-dir', codexDir,
    '--opencode-db', path.join(temp, 'missing-opencode.db'), '--claude-dir', directories.claude,
    '--pi-dir', directories.pi, '--dsh-dir', directories.dsh, '--meta-dir', directories.meta,
    '--index-dir', directories.index, '--cache-dir', directories.cache];
  const child = spawn(binary, args, { cwd: repo, windowsHide: true, stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
  });

  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error('Isolated Axum Reader exited before readiness');
    try {
      if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok) {
        return { base, codexDir, copies };
      }
    } catch { /* Axum is starting and indexing the copied source. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Isolated Axum Reader did not become ready');
}

function inheritedUrl(base, id, query = {}) {
  const url = new URL(`/api/v3/reader/codex/${id}/inherited-context`, base);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

function inheritedContentUrl(base, id, revision, ordinal, messageId, segment, field, offset = 0, maxChars = 2048) {
  const query = new URLSearchParams({ revision, ordinal: String(ordinal), messageId, segment, field,
    offset: String(offset), maxChars: String(maxChars) });
  return `${base}/api/v3/reader/codex/${id}/inherited-context/content?${query}`;
}

function ownedContentUrl(base, id, revision, messageId, segment, field, offset = 0, maxChars = 2048) {
  const query = new URLSearchParams({ revision, messageId, segment, field,
    offset: String(offset), maxChars: String(maxChars) });
  return `${base}/api/v3/reader/codex/${id}/content?${query}`;
}

async function json(response) {
  return response.json();
}

test('Codex inherited Reader pages preserve child ownership, scoped continuation, and source revisions',
  { timeout: 60_000 }, async t => {
    const fixtureDigest = await digest(fixture);
    t.after(async () => {
      assert.equal(await digest(fixture), fixtureDigest, 'the checked-in public fixture remains unchanged');
    });
    const harness = await startAxum(t, [
      { file: fixture, name: 'child.jsonl', fileName: path.basename(fixture) },
      { file: fixture, name: 'foreign-child.jsonl', fileName: 'rollout-public-foreign.jsonl',
        sessionId: foreignChildId },
    ]);
    assert.equal(await digest(harness.copies.get('child.jsonl')), fixtureDigest,
      'isolated child source begins as a byte-identical fixture copy');
    const sourceNames = (await readdir(path.join(harness.codexDir, 'sessions', '2026', '09', '27'))).sort();
    assert.deepEqual(sourceNames, ['rollout-public-child.jsonl', 'rollout-public-foreign.jsonl'],
      'the parent transcript is absent from the isolated provider root');

    const bootstrapResponse = await fetch(`${harness.base}/api/v3/reader/codex/${childId}/bootstrap`);
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = await json(bootstrapResponse);
    assert.equal(bootstrap.totalItems, 2, 'inherited prefix does not enter the owned Reader projection');
    assert.equal(bootstrap.toc.entries.length, 2, 'inherited prefix does not enter the owned ToC');
    const ownedItems = bootstrap.segments.flatMap(segment => segment.items);
    const ownedCollision = ownedItems.find(item => item.event.messageId === sharedMessageId);
    assert.ok(ownedCollision, 'owned copy of the colliding message ID remains in bootstrap');
    assert.equal(ownedCollision.event.segment, 'message');
    assert.doesNotMatch(JSON.stringify(bootstrap), /Inherited developer context|Inherited reasoning/);
    assert.doesNotMatch(JSON.stringify(bootstrap.toc), /Inherited developer context|Inherited reasoning/);

    const firstResponse = await fetch(inheritedUrl(harness.base, childId, { limit: 40 }));
    assert.equal(firstResponse.status, 200, 'the inherited-context Reader route is registered');
    const first = await json(firstResponse);
    assert.deepEqual(first.session, { provider: 'codex', sessionId: childId });
    assert.equal(first.scope, 'inherited-context');
    assert.deepEqual(first.sourceSession, { provider: 'codex', sessionId: parentId });
    assert.equal(first.revision, bootstrap.revision);
    assert.equal(first.totalItems, 51);
    assert.equal(first.items.length, 40);
    assert.ok(first.nextCursor, 'the first inherited page continues');
    assert.ok(first.items.every(item => Number.isInteger(item.ordinal)
      && typeof item.messageId === 'string' && typeof item.segment === 'string'),
    'each inherited row has an identity scoped by its list response and source position');

    const secondResponse = await fetch(inheritedUrl(harness.base, childId,
      { limit: 40, cursor: first.nextCursor }));
    assert.equal(secondResponse.status, 200);
    const second = await json(secondResponse);
    assert.equal(second.scope, 'inherited-context');
    assert.equal(second.revision, first.revision);
    assert.equal(second.totalItems, 51);
    assert.equal(second.items.length, 11);
    assert.equal(second.nextCursor, null);
    const inheritedItems = [...first.items, ...second.items];
    assert.equal(inheritedItems.length, 51);
    assert.deepEqual(inheritedItems.map(item => item.ordinal), Array.from({ length: 51 }, (_, index) => index));
    assert.equal(inheritedItems.some(item => item.messageId === 'inherited-user'), false,
      'the legacy user_message is superseded by the recorded user.text copy of the same turn');
    assert.equal(inheritedItems.filter(item => item.messageId === 'recorded-inherited-user').length, 1);

    const inheritedTool = inheritedItems.find(item => item.messageId === 'tool-call-inherited');
    const expectedToolOutput = `Inherited tool output ${'o'.repeat(3_500)}`;
    assert.ok(inheritedTool, 'the inherited tool call remains addressable from the bounded list');
    assert.equal(inheritedTool.totalChars, expectedToolOutput.length,
      'tool output length is reported in the inherited content field');
    let toolOffset = 0;
    let toolText = '';
    for (let pageNumber = 0; ; pageNumber += 1) {
      const response = await fetch(inheritedContentUrl(harness.base, childId, first.revision,
        inheritedTool.ordinal, inheritedTool.messageId, inheritedTool.segment, 'toolOutput', toolOffset, 1024));
      assert.equal(response.status, 200);
      const page = await json(response);
      assert.equal(page.revision, first.revision);
      assert.equal(page.offset, toolOffset);
      assert.equal(page.totalChars, expectedToolOutput.length);
      toolText += page.text;
      if (page.nextOffset === null) {
        assert.equal(page.truncated, false);
        break;
      }
      assert.equal(page.truncated, true);
      assert.ok(page.nextOffset > toolOffset);
      toolOffset = page.nextOffset;
      assert.ok(pageNumber < 4, 'tool output continuation is bounded');
    }
    assert.equal(toolText, expectedToolOutput,
      'tool output pages reassemble the exact inherited field');

    const inheritedCollision = inheritedItems.find(item => item.messageId === sharedMessageId);
    assert.ok(inheritedCollision, 'inherited copy of the same source message ID remains separately addressable');
    const secondInheritedCollision = inheritedItems.find(item =>
      item.messageId === sharedMessageId && item.ordinal !== inheritedCollision.ordinal);
    assert.ok(secondInheritedCollision,
      'two distinct inherited rows can share a recorded message ID and segment');
    assert.equal(inheritedCollision.segment, ownedCollision.event.segment);
    assert.equal(secondInheritedCollision.segment, inheritedCollision.segment);
    assert.notEqual(inheritedCollision.ordinal, ownedCollision.ordinal,
      'the inherited list ordinal is distinct from the owned Reader ordinal');
    const inheritedCollisionResponse = await fetch(inheritedContentUrl(harness.base, childId,
      first.revision, inheritedCollision.ordinal, sharedMessageId, inheritedCollision.segment, 'body', 0, 100));
    assert.equal(inheritedCollisionResponse.status, 200);
    assert.equal((await json(inheritedCollisionResponse)).text, 'Inherited body for shared ID.');
    const secondInheritedResponse = await fetch(inheritedContentUrl(harness.base, childId,
      first.revision, secondInheritedCollision.ordinal, sharedMessageId,
      secondInheritedCollision.segment, 'body', 0, 100));
    assert.equal(secondInheritedResponse.status, 200);
    assert.equal((await json(secondInheritedResponse)).text, 'Inherited developer context 1');
    const unscopedContent = new URL(inheritedContentUrl(harness.base, childId,
      first.revision, secondInheritedCollision.ordinal, sharedMessageId,
      secondInheritedCollision.segment, 'body', 0, 100));
    unscopedContent.searchParams.delete('ordinal');
    assert.equal((await fetch(unscopedContent)).status, 400,
      'inherited content requires a list ordinal to distinguish duplicate native IDs');
    const mismatchedIdentity = await fetch(inheritedContentUrl(harness.base, childId,
      first.revision, secondInheritedCollision.ordinal, 'another-id',
      secondInheritedCollision.segment, 'body', 0, 100));
    assert.equal(mismatchedIdentity.status, 404,
      'a content ordinal cannot be combined with a different native message ID');
    const ownedCollisionResponse = await fetch(ownedContentUrl(harness.base, childId,
      bootstrap.revision, sharedMessageId, ownedCollision.event.segment, 'body', 0, 100));
    assert.equal(ownedCollisionResponse.status, 200);
    assert.equal((await json(ownedCollisionResponse)).text, 'Owned body for shared ID.');

    const longItem = inheritedItems.find(item => item.messageId === longMessageId);
    assert.ok(longItem);
    let offset = 0;
    let text = '';
    for (let pageNumber = 0; ; pageNumber += 1) {
      const response = await fetch(inheritedContentUrl(harness.base, childId, first.revision,
        longItem.ordinal, longItem.messageId, longItem.segment, 'body', offset, 2048));
      assert.equal(response.status, 200);
      const page = await json(response);
      assert.equal(page.revision, first.revision);
      assert.equal(page.offset, offset);
      assert.equal(page.totalChars, longBody.length);
      text += page.text;
      if (page.nextOffset === null) {
        assert.equal(page.truncated, false);
        break;
      }
      assert.equal(page.truncated, true);
      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
      assert.ok(pageNumber < 12, 'long inherited field continuation is bounded');
    }
    assert.equal(text, longBody, 'continuation returns the exact long inherited field through its final character');
    assert.ok(text.endsWith('END_OF_PUBLIC_INHERITED_CONTEXT'));

    for (const [url, message] of [
      [inheritedUrl(harness.base, childId, { limit: 20, cursor: first.nextCursor }),
        'cursor is bound to page size'],
      [inheritedUrl(harness.base, foreignChildId, { limit: 40, cursor: first.nextCursor }),
        'cursor is bound to child session'],
    ]) {
      const response = await fetch(url);
      assert.equal(response.status, 400, message);
      assert.equal((await json(response)).error.code, 'invalid_cursor');
    }
    const otherScope = await startAxum(t, [{ file: fixture, name: 'child.jsonl' }]);
    const crossScope = await fetch(inheritedUrl(otherScope.base, childId,
      { limit: 40, cursor: first.nextCursor }));
    assert.equal(crossScope.status, 400, 'cursor is bound to Codex source scope');
    assert.equal((await json(crossScope)).error.code, 'invalid_cursor');

    await writeFile(harness.copies.get('child.jsonl'), `${await readFile(harness.copies.get('child.jsonl'), 'utf8')}\n`);
    const stale = await fetch(inheritedUrl(harness.base, childId, { limit: 40, cursor: first.nextCursor }));
    assert.equal(stale.status, 409, 'a source revision change rejects an inherited cursor');
    assert.equal((await json(stale)).error.code, 'source_changed');
  });

const runPrivateHook = process.env.AGENTSESSION_V3_RUN_PRIVATE_INHERITED === '1';
test('opt-in selected Codex source retains private inherited and owned counts without transcript output',
  { skip: runPrivateHook ? false : 'Set AGENTSESSION_V3_RUN_PRIVATE_INHERITED=1 to opt in', timeout: 30_000 },
  async t => {
    assert.ok(existsSync(privateManifest), 'the frozen-source manifest is available');
    const manifestDigest = await digest(privateManifest);
    const manifest = JSON.parse(await readFile(privateManifest, 'utf8'));
    const root = path.resolve(repo, manifest.root);
    let candidates;
    try {
      candidates = (await allFiles(root)).filter(file => path.extname(file) === '.jsonl');
    } catch {
      assert.fail('the selected frozen-source root is readable');
    }
    const matches = [];
    for (const file of candidates) {
      let sourceHash;
      try {
        sourceHash = await digest(file);
      } catch {
        assert.fail('the selected frozen transcript is readable');
      }
      if (sourceHash === manifest.sha256) matches.push(file);
    }
    assert.equal(matches.length, 1, 'manifest checksum resolves exactly one frozen transcript');
    const sourceFile = matches[0];
    const sourceDigest = manifest.sha256;
    const harness = await startAxum(t, [{ file: sourceFile, name: 'private-child.jsonl' }]);
    assert.equal((await readdir(harness.codexDir)).length, 1,
      'the isolated provider root contains only the selected child transcript');

    const bootstrapResponse = await fetch(`${harness.base}/api/v3/reader/codex/${manifest.sessionId}/bootstrap`);
    assert.equal(bootstrapResponse.status, 200, 'the selected child Reader bootstrap is available');
    const bootstrap = await json(bootstrapResponse);
    assert.equal(bootstrap.totalItems, 31, 'owned Reader count matches the fixed 2.0 oracle');
    assert.equal(bootstrap.toc.entries.length, 31, 'owned ToC excludes inherited records');
    const listResponse = await fetch(inheritedUrl(harness.base, manifest.sessionId, { limit: 40 }));
    assert.equal(listResponse.status, 200, 'the inherited-context Reader route is available');
    const list = await json(listResponse);
    assert.equal(list.scope, 'inherited-context');
    assert.ok(list.sourceSession?.sessionId === manifest.parentId,
      'the returned parent reference matches recorded child metadata');
    assert.equal(list.revision, bootstrap.revision);
    assert.equal(list.totalItems, 7, 'inherited Reader count matches the fixed 2.0 oracle');
    assert.equal(list.items.length, 7);
    assert.equal(list.nextCursor, null);
    assert.ok(await digest(sourceFile) === sourceDigest, 'selected frozen transcript remains unchanged');
    assert.ok(await digest(privateManifest) === manifestDigest, 'frozen-source manifest remains unchanged');
  });
