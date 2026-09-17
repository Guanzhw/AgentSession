import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsession-reader-snapshot-'));
process.env.AGENTSESSION_META_PATH = path.join(temp, 'meta.db');
const { initConfig } = await import('../dist/src/config.js');
initConfig(['--config', path.join(temp, 'config.json')]);
const { closeMetaDb } = await import('../dist/src/meta.js');
const { closeIndexDb } = await import('../dist/src/index-db.js');
const { createSessionFileStore, sessionFileSignature } = await import('../dist/src/providers/shared/file-adapter-helpers.js');
const { readCodexSessionSnapshot } = await import('../dist/src/providers/codex/parser.js');
const { buildMessageSessionTree } = await import('../dist/src/providers/shared/message-session.js');
const { finalizeSessionProtocol } = await import('../dist/src/providers/shared/session-protocol.js');
const { upgradeSessionProtocolV2 } = await import('../dist/src/providers/shared/session-protocol-v3.js');
const { clearProtocolRuntimeCache, getRuntimeProtocolSnapshots } = await import('../dist/src/protocol-runtime.js');
const { getSessionDocument } = await import('../dist/src/session-queries.js');
const { registerSessionDetail } = await import('../dist/src/routes/session-detail.js');
test.after(() => {
  closeMetaDb();
  closeIndexDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
test.beforeEach(() => clearProtocolRuntimeCache());

test('store capture refreshes once and retains one root payload through eviction and later append', () => {
  const dir = fs.mkdtempSync(path.join(temp, 'store-'));
  const files = ['root', 'child'].map(id => ({ sessionId: id, filePath: path.join(dir, `${id}.jsonl`) }));
  fs.writeFileSync(files[0].filePath, '{"id":"root","text":"original"}\n');
  fs.writeFileSync(files[1].filePath, '{"id":"child","parentId":"root","text":"child original"}\n');
  let discoveries = 0;
  const reads = new Map();
  const readPayload = (file, expected) => {
    reads.set(file, (reads.get(file) || 0) + 1);
    const { records, snapshot } = readCodexSessionSnapshot(file, expected);
    return { records, messages: records.map(record => record.text), snapshot };
  };
  const store = createSessionFileStore({
    discoverFiles() { discoveries++; return files; },
    maxCachedSourceBytes: 1,
    readEntry({ filePath }) {
      const payload = readPayload(filePath);
      return { session: payload.records[0], ...payload, payloadSnapshot: {
        signature: sessionFileSignature(filePath, payload.snapshot), sourceBytes: payload.snapshot.size,
        read: () => readPayload(filePath, payload.snapshot)
      } };
    }
  });
  const captured = store.captureSession('root');
  assert.equal(discoveries, 1);
  assert.equal(reads.get(files[0].filePath), 1, 'later children must not force a second read of the captured root');
  assert.deepEqual(captured.messages, ['original']);
  assert.deepEqual(captured.children.map(entry => entry.session.id), ['child']);
  fs.appendFileSync(files[0].filePath, '{"id":"later","text":"appended"}\n');
  fs.appendFileSync(files[1].filePath, '{"id":"later-child","text":"child appended"}\n');
  const next = store.captureSession('root');
  assert.equal(discoveries, 2);
  assert.equal(next.revision, captured.revision + 1);
  assert.deepEqual(next.messages, ['original', 'appended']);
  assert.deepEqual(captured.messages, ['original']);
  const before = reads.get(files[1].filePath);
  const child = captured.readPayload(captured.children[0]);
  assert.equal(reads.get(files[1].filePath), before + 1, 'obsolete records/messages are read together once');
  assert.deepEqual(child.messages, ['child original']);
  assert.equal(discoveries, 2, 'held payload reads do not refresh');
  assert.equal(store.captureSession('missing'), null);
});

const row = (type, payload) => ({ type, payload, timestamp: '2026-09-17T00:00:00.000Z' });
const writeRollout = (directory, name, records) => {
  const file = path.join(directory, `${name}.jsonl`);
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  return file;
};

test('Codex Reader snapshot preserves full legacy output with one oversized root read and coherent growth', async (t) => {
  const directory = fs.mkdtempSync(path.join(temp, 'codex-'));
  const sessions = path.join(directory, 'sessions');
  fs.mkdirSync(sessions);
  const rootFile = writeRollout(sessions, 'a-root', [
    row('session_meta', { id: 'root' }),
    row('event_msg', { type: 'user_message', message: 'Original root request' }),
    row('event_msg', { type: 'agent_message', message: 'Original root reply' })
  ]);
  const padding = Buffer.alloc(64 * 1024, 32);
  padding[padding.length - 1] = 10;
  const descriptor = fs.openSync(rootFile, 'a');
  try { for (let i = 0; i < 1025; i++) fs.writeSync(descriptor, padding); }
  finally { fs.closeSync(descriptor); }
  const childFile = writeRollout(sessions, 'b-child', [
    row('session_meta', { id: 'child', parent_thread_id: 'root', agent_path: 'worker' }),
    row('event_msg', { type: 'user_message', message: 'Inherited request' }),
    row('response_item', { type: 'agent_message', content: [{ type: 'output_text', text: 'Message Type: NEW_TASK\nTask name: worker' }] }),
    row('event_msg', { type: 'agent_message', message: 'Owned child reply' })
  ]);
  initConfig(['--config', path.join(temp, 'config.json'), '--codex-dir', directory]);
  const open = fs.openSync;
  let rootReads = 0;
  t.mock.method(fs, 'openSync', (...args) => {
    if (path.resolve(String(args[0])) === rootFile) rootReads++;
    return open(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { default: codex } = await import('../dist/src/providers/codex/adapter.js?reader-snapshot-test');
  const captured = codex.getSessionReaderSnapshot('root');
  assert.equal(rootReads, 1);
  const pair = captured.getProtocolSnapshots();
  const evidence = { tasks: pair.v3.tasks, agentRuns: pair.v3.agentRuns, relationships: pair.v3.relationships };
  const owned = captured.getOwnedReaderProjection(evidence);
  assert.equal(rootReads, 1, 'lazy protocol and owned reader reuse the captured root');
  assert.deepEqual(captured.session, codex.getSession('root'));
  assert.deepEqual(captured.messages, codex.getMessages('root'));
  assert.deepEqual(captured.inheritedContext, codex.getInheritedContext('root'));
  assert.deepEqual(pair, codex.getSessionProtocolSnapshots('root'));
  assert.deepEqual(owned, codex.getOwnedReaderProjection('root', evidence));
  const child = codex.getSessionReaderSnapshot('child');
  assert.deepEqual(child.messages, codex.getMessages('child'));
  assert.deepEqual(child.inheritedContext, codex.getInheritedContext('child'));
  assert.equal(child.messages.some(message => message.content === 'Inherited request'), false);
  assert.ok(child.inheritedContext.messages.some(message => message.content === 'Inherited request'));

  const held = codex.getSessionReaderSnapshot('root');
  fs.appendFileSync(rootFile, JSON.stringify(row('event_msg', { type: 'agent_message', message: 'Appended root reply' })) + '\n');
  fs.appendFileSync(childFile, JSON.stringify(row('event_msg', { type: 'task_complete', turn_id: 'child-turn' })) + '\n');
  const next = codex.getSessionReaderSnapshot('root');
  const oldPair = held.getProtocolSnapshots();
  const newPair = next.getProtocolSnapshots();
  assert.deepEqual(oldPair, pair, 'a held request retains its original root and child extents after another capture');
  assert.equal(held.messages.some(message => message.content === 'Appended root reply'), false);
  assert.equal(next.messages.some(message => message.content === 'Appended root reply'), true);
  assert.ok(next.revision > held.revision);
  assert.equal(oldPair.v3.coordination.some(item => item.kind === 'child-turn-completed'), false);
  assert.equal(newPair.v3.coordination.some(item => item.kind === 'child-turn-completed'), true);
  assert.equal(codex.getSessionReaderSnapshot('missing'), null);
});

function fixture() {
  const session = { id: 'root', provider: 'fixture', parentId: null, title: 'Snapshot fixture', directory: null,
    timeCreated: 1, timeUpdated: 2, messageCount: 2, tokenCount: null };
  const messages = [
    { id: 'user', sessionId: 'root', role: 'user', content: 'Complete user request', timestamp: 1 },
    { id: 'reply', sessionId: 'root', role: 'assistant', content: 'Complete original reply', timestamp: 2 }
  ];
  const v2 = finalizeSessionProtocol({ sessionId: session.id, events: [], relationships: [], tasks: [], agentRuns: [], contextArtifacts: [] },
    { provider: 'fixture', session, revision: 'captured' });
  const pair = { v2, v3: upgradeSessionProtocolV2(v2) };
  const owned = { rootTree: buildMessageSessionTree(session, messages), children: [] };
  return { session, messages, pair, owned, captured: {
    session, messages, revision: 'captured', inheritedContext: null,
    getProtocolSnapshots: () => pair, getOwnedReaderProjection: () => owned
  } };
}

test('paired runtime uses captured revision and caches finalized facts without retaining its loader', () => {
  const { session, pair, captured } = fixture();
  const adapter = { id: 'fixture', getSession() { throw new Error('already captured'); }, getStatsRevision() { throw new Error('must not refresh'); } };
  let builds = 0;
  captured.getProtocolSnapshots = () => { builds++; return pair; };
  assert.equal(getRuntimeProtocolSnapshots(adapter, 'root', session, captured), pair);
  captured.getProtocolSnapshots = () => { throw new Error('loader must not be cached'); };
  assert.deepEqual(getRuntimeProtocolSnapshots(adapter, 'root', session, captured), pair);
  assert.equal(builds, 1);
  assert.throws(() => getRuntimeProtocolSnapshots(adapter, 'other', session, captured), { code: 'session_not_found' });
  assert.throws(() => getRuntimeProtocolSnapshots(adapter, 'root', session, {
    revision: 'changed', getProtocolSnapshots: () => ({ v2: { ...pair.v2, sessionId: 'other' }, v3: pair.v3 })
  }), { code: 'protocol_invalid' });
});

function routesFor(provider) {
  const routes = [];
  registerSessionDetail({ get(pattern, handler) { routes.push({ pattern, handler }); } }, {
    appConfig: { port: 0, projectPaths: {}, resumeCommands: {}, allowTerminalLaunch: false },
    providerMap: new Map([[provider.id, provider]]), providerInfo: []
  });
  return async (surface, id = 'root') => {
    if (surface === 'html') {
      const route = routes.find(({ pattern }) => pattern === '/:provider/session/:id');
      return route.handler({ url: `/${provider.id}/session/${id}` }, {}, { provider: provider.id, id });
    }
    const url = `/api/${provider.id}/session/${id}/reader`;
    const route = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.test(url));
    const response = { status: 0, body: '', writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    await route.handler({ url }, response, route.pattern.exec(url));
    return { status: response.status, ...JSON.parse(response.body) };
  };
}

test('HTML and pane consume the captured source, retaining the complete legacy rendering', async () => {
  const { session, messages, captured, pair, owned } = fixture();
  const legacy = { id: 'fixture', name: 'Fixture', icon: '',
    getSession: () => session, getMessages: () => messages, getStatsRevision: () => 'captured',
    getSessionProtocol: () => pair.v2, getSessionProtocolSnapshots: () => pair,
    getOwnedReaderProjection: () => owned, getInheritedContext: () => null };
  const oldRequest = routesFor(legacy);
  const oldHtml = await oldRequest('html');
  const oldPane = await oldRequest('pane');
  clearProtocolRuntimeCache();
  let captures = 0;
  const noRead = () => { throw new Error('Reader already captured this source'); };
  const request = routesFor({ ...legacy, getSession: noRead, getMessages: noRead, getStatsRevision: noRead,
    getSessionProtocolSnapshots: noRead, getOwnedReaderProjection: noRead, getInheritedContext: noRead,
    getSessionReaderSnapshot() { captures++; return captured; } });
  const html = await request('html');
  const pane = await request('pane');
  assert.equal(html.status, 200);
  assert.equal(pane.status, 200);
  assert.equal(html.body, oldHtml.body);
  assert.equal(pane.html, oldPane.html);
  assert.equal(captures, 2);
  assert.match(pane.html, /Complete user request/);
  assert.match(pane.html, /Complete original reply/);
  assert.deepEqual(getSessionDocument(legacy, 'fixture', 'root', captured), getSessionDocument(legacy, 'fixture', 'root'));
});

test('Reader snapshot failures retain readable prose and explicit protocol diagnostics', async () => {
  const { captured } = fixture();
  captured.getProtocolSnapshots = () => { throw new TypeError('invalid recorded protocol'); };
  const noRead = () => { throw new Error('unexpected legacy read'); };
  const request = routesFor({ id: 'fixture', name: 'Fixture', icon: '',
    getSession: noRead, getMessages: noRead, getStatsRevision: noRead,
    getSessionProtocol: noRead, getSessionReaderSnapshot: () => captured });
  const html = await request('html');
  const pane = await request('pane');
  assert.equal(html.status, 200);
  assert.match(html.body, /Complete original reply/);
  assert.ok(html.body.includes('protocol_invalid'), 'the existing Runtime diagnostic retains its explicit failure code');
  assert.ok(html.body.includes('Runtime protocol is unavailable for this session.'), 'the existing Runtime failure notice stays visible');
  assert.equal(pane.status, 200);
  assert.match(pane.html, /Complete original reply/);
});

test('missing and canonically mismatched snapshots remain not found without fallback reads', async () => {
  const { captured } = fixture();
  const noRead = () => { throw new Error('unexpected fallback'); };
  const request = routesFor({ id: 'fixture', name: 'Fixture', icon: '', getSession: noRead, getMessages: noRead,
    getSessionReaderSnapshot: id => id === 'missing' ? null : captured });
  for (const surface of ['html', 'pane']) {
    assert.equal((await request(surface, 'missing')).status, 404);
    assert.equal((await request(surface, 'other')).status, 404);
  }
});
