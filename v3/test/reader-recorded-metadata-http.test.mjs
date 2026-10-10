import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const fixtures = {
  pi: path.join(repo, 'test/fixtures/pi-v3-current.jsonl'),
  dsh: path.join(repo, 'test/fixtures/dsh-alpha15-v3-preview-showcase.jsonl'),
};
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const rows = file => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200, `Expected HTTP 200, received ${response.status}`);
  return response.json();
}

async function setup(t, prepare = async () => {}) {
  assert.ok(existsSync(binary), 'Build the configured v3 binary before running this HTTP test');
  const originalHashes = Object.fromEntries(Object.entries(fixtures).map(([label, file]) => [label, sha(file)]));
  t.diagnostic(JSON.stringify({ binarySha256: sha(binary), fixtureSha256: originalHashes }));
  await mkdir(path.join(repo, 'tmp'), { recursive: true });
  const root = await mkdtemp(path.join(repo, 'tmp', 'v3-reader-recorded-metadata-'));
  const ledger = new Map(Object.values(fixtures).map(file => [file, sha(file)]));
  let child;
  t.after(async () => {
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, 'close');
      }
      for (const [file, hash] of ledger) assert.equal(sha(file), hash, 'Provider source bytes must remain unchanged');
    } finally {
      const resolved = path.resolve(root);
      assert.equal(path.dirname(resolved), path.resolve(repo, 'tmp'));
      assert.ok(path.basename(resolved).startsWith('v3-reader-recorded-metadata-'));
      await rm(resolved, { recursive: true, force: true });
    }
  });
  const dirs = Object.fromEntries(['pi', 'codex', 'claude', 'dsh', 'meta', 'index', 'cache']
    .map(name => [name, path.join(root, name)]));
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
  const piRows = rows(fixtures.pi);
  const dshRows = rows(fixtures.dsh);
  const piId = piRows[0].id;
  const dshId = dshRows[0].id;
  const piCopy = path.join(dirs.pi, 'sessions', 'fixture', `${piId}.jsonl`);
  const dshCopy = path.join(dirs.dsh, 'sessions', dshId, 'session.v3.jsonl.zstd');
  await Promise.all([mkdir(path.dirname(piCopy), { recursive: true }),
    mkdir(path.dirname(dshCopy), { recursive: true })]);
  await copyFile(fixtures.pi, piCopy);
  await writeFile(dshCopy, zstdCompressSync(readFileSync(fixtures.dsh)));
  ledger.set(piCopy, sha(piCopy));
  ledger.set(dshCopy, sha(dshCopy));
  const put = async (file, data) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
    ledger.set(file, sha(file));
  };
  const opencode = path.join(root, 'opencode.db');
  await prepare({ dirs, put, ledger, opencode });
  const port = await freeFetchSafePort();
  child = spawn(binary, ['serve', '--port', String(port), '--pi-dir', dirs.pi,
    '--codex-dir', dirs.codex, '--claude-dir', dirs.claude, '--dsh-dir', dirs.dsh,
    '--opencode-db', opencode, '--meta-dir', dirs.meta,
    '--index-dir', dirs.index, '--cache-dir', dirs.cache],
  { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      if ((await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(500) })).ok) {
        return { base, piId, piRows, dshId, dshRows, dirs };
      }
    } catch { /* The isolated server may still be indexing its public copies. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Isolated metadata HTTP server did not start: ${stderr.slice(0, 500)}`);
}

async function readerItems(base, provider, id) {
  const url = `${base}/api/v3/reader/${provider}/${encodeURIComponent(id)}`;
  const bootstrap = await json(`${url}/bootstrap`);
  const items = [...bootstrap.segments[0].items];
  let cursor = bootstrap.segments[0].nextCursor;
  while (cursor) {
    const response = await json(`${url}/segments?cursor=${encodeURIComponent(cursor)}`);
    assert.equal(response.revision, bootstrap.revision);
    items.push(...response.page.items);
    cursor = response.page.nextCursor;
  }
  return items;
}

test('Reader exposes Pi same-message model and proved request usage once without changing nullable dimensions',
  { timeout: 30_000 }, async t => {
    const { base, piId, piRows } = await setup(t);
    const document = await json(`${base}/api/v3/protocol/pi/${piId}?version=3`);
    assert.equal(document.validation.ok, true);
    assert.equal(document.usageRecords.length, 3, 'The public fixture has three proved requests, including an abandoned branch');
    const items = await readerItems(base, 'pi', piId);
    const primary = items.find(item => item.event.messageId === 'asst0002' && item.event.segment === 'message');
    assert.ok(primary, 'The active reply must be readable before checking its metadata');
    const request = document.usageRecords.find(record => record.provenance.sourceId === 'asst0002');
    assert.equal(request.eventId, 'event:pi:11', 'The request has the recorded active source owner');
    const source = piRows.find(row => row.id === 'asst0002').message;
    assert.ok(primary.replyMetadata, 'Reader lost model and request usage recorded on this exact assistant source message');
    assert.equal(primary.replyMetadata.model, source.responseModel ?? source.model);
    assert.equal(primary.replyMetadata.modelProvider, source.provider);
    assert.equal(primary.replyMetadata.modelProvenance.fidelity, 'recorded');
    assert.equal(primary.replyMetadata.modelProvenance.sourceId, 'asst0002');
    assert.deepEqual(primary.replyMetadata.requestUsage, {
      recordId: request.id, tokens: request.tokens, provenance: request.provenance,
    });
    assert.equal(primary.replyMetadata.requestUsage.tokens.cacheWrite, 0, 'An explicit zero remains zero');
    assert.equal(primary.replyMetadata.requestUsage.tokens.output, null, 'Unproved exclusive output remains missing');
    assert.equal(primary.replyMetadata.requestUsage.tokens.reasoning, null, 'Missing reasoning is not zero');
    const ownedIds = items.flatMap(item => item.replyMetadata?.requestUsage ? [item.replyMetadata.requestUsage.recordId] : []);
    assert.equal(new Set(ownedIds).size, ownedIds.length, 'Thinking, tools and text parts cannot repeat a request');
    assert.ok(!ownedIds.includes(document.usageRecords[0].id), 'The abandoned branch request cannot be attached to the active reply');
    for (const item of items.filter(item => item.role !== 'assistant' || item.event.segment !== 'message')) {
      assert.equal(item.replyMetadata, null, 'User, tool and context events do not own reply metadata');
    }
    const later = items.find(item => item.event.messageId === 'asst0003' && item.event.segment === 'message');
    assert.ok(later);
    const laterRequest = document.usageRecords.find(record => record.provenance.sourceId === 'asst0003');
    assert.equal(later.replyMetadata.requestUsage.recordId, laterRequest.id, 'A later reply after compaction owns its own request');
    assert.notEqual(later.replyMetadata.requestUsage.recordId, primary.replyMetadata.requestUsage.recordId);
    assert.deepEqual(ownedIds, [request.id, laterRequest.id],
      'Only active source messages own request usage; retained context and abandoned branches add none');
  });

for (const schema of ['v1', 'v2']) {
  test(`Reader gives OpenCode ${schema} request usage to the first text part and keeps model-only and partial facts`,
    { timeout: 30_000 }, async t => {
      const { base } = await setup(t, async ({ opencode, ledger }) => {
        const db = new DatabaseSync(opencode);
        const rich = { modelID: 'source-model', providerID: 'source-provider',
          tokens: { input: 12, output: 0, cache: { read: 5 } } };
        const parts = [{ type: 'reasoning', text: 'Recorded reasoning.' },
          { type: 'text', text: 'First text.' }, { type: 'text', text: 'Second text.' }];
        if (schema === 'v1') {
          db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT,
            directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
            CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
            CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
            INSERT INTO session VALUES ('metadata-root',NULL,'Root','/public',1,100,NULL);`);
          const message = db.prepare('INSERT INTO message VALUES (?,?,?,?)');
          const part = db.prepare('INSERT INTO part VALUES (?,?,?,?,?)');
          message.run('owned', 'metadata-root', JSON.stringify({ role: 'assistant', time: { created: 10 }, ...rich }), 10);
          parts.forEach((value, index) => part.run(`part-${index}`, 'owned', 'metadata-root', JSON.stringify(value), 10 + index));
          message.run('model-only', 'metadata-root', JSON.stringify({ role: 'assistant', time: { created: 20 }, modelID: 'only-model' }), 20);
          part.run('only-text', 'model-only', 'metadata-root', JSON.stringify({ type: 'text', text: 'No usage.' }), 20);
        } else {
          db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT,
            fork_boundary TEXT, title TEXT, slug TEXT, directory TEXT, time_created INTEGER,
            time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
            tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);
            CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
              time_created INTEGER, time_updated INTEGER, data TEXT);
            INSERT INTO session_v2 VALUES ('metadata-root',NULL,NULL,NULL,'Root','root','/public',1,100,NULL,1000,500,0,200,0);`);
          const message = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
          message.run('owned', 'metadata-root', 'assistant', 1, 10, 10, JSON.stringify({ ...rich, content: parts }));
          message.run('model-only', 'metadata-root', 'assistant', 2, 20, 20,
            JSON.stringify({ modelID: 'only-model', content: [{ type: 'text', text: 'No usage.' }] }));
          message.run('tool-only', 'metadata-root', 'assistant', 3, 22, 22,
            JSON.stringify({ ...rich, content: [{ type: 'tool', name: 'read',
              state: { input: { path: 'source.txt' }, status: 'completed', content: [{ type: 'text', text: 'Read.' }] } }] }));
          message.run('empty', 'metadata-root', 'assistant', 4, 23, 23,
            JSON.stringify({ ...rich, content: [] }));
          db.exec(`INSERT INTO session_v2 VALUES ('metadata-child','metadata-root','metadata-root',NULL,
            'Child','child','/public',21,100,NULL,1000,500,0,200,0);`);
          message.run('owned_1', 'metadata-child', 'assistant', 1, 10, 10,
            JSON.stringify({ ...rich, content: parts }));
          message.run('child-owned', 'metadata-child', 'assistant', 2, 21, 21,
            JSON.stringify({ modelID: 'child-model', content: [{ type: 'text', text: 'Own child reply.' }] }));
        }
        db.close();
        ledger.set(opencode, sha(opencode));
      });
      const protocol = await json(`${base}/api/v3/protocol/opencode/metadata-root?version=3`);
      assert.equal(protocol.validation.ok, true);
      assert.equal(protocol.usageRecords.length, schema === 'v2' ? 3 : 1);
      const items = await readerItems(base, 'opencode', 'metadata-root');
      const texts = items.filter(item => item.role === 'assistant' && item.event.segment === 'message');
      assert.equal(texts.length, schema === 'v2' ? 5 : 3, 'Existing text and empty mother-message projections stay readable');
      assert.ok(texts[0].replyMetadata, 'OpenCode mother-message facts must survive part projection');
      assert.equal(texts[0].replyMetadata.model, 'source-model');
      assert.equal(texts[0].replyMetadata.modelProvider, 'source-provider');
      assert.deepEqual(texts[0].replyMetadata.requestUsage,
        { recordId: protocol.usageRecords[0].id, tokens: protocol.usageRecords[0].tokens,
          provenance: protocol.usageRecords[0].provenance });
      assert.equal(texts[0].replyMetadata.requestUsage.tokens.output, 0);
      assert.equal(texts[0].replyMetadata.requestUsage.tokens.cacheWrite, null);
      assert.equal(texts[1].replyMetadata.model, 'source-model');
      assert.equal(texts[1].replyMetadata.requestUsage, null, 'A second text part cannot duplicate the mother request');
      assert.equal(texts[2].replyMetadata.model, 'only-model');
      assert.equal(texts[2].replyMetadata.requestUsage, null, 'Model-only facts bypass a usage gate');
      assert.equal(items.find(item => item.event.segment === 'thinking').replyMetadata, null);
      if (schema === 'v2') {
        for (const id of ['tool-only', 'empty']) {
          const owner = texts.find(item => item.event.messageId === id);
          const request = protocol.usageRecords.find(record => record.provenance.sourceId === id);
          assert.ok(owner, 'An existing empty mother-message is the primary owner without inventing a part');
          assert.deepEqual(owner.replyMetadata.requestUsage,
            { recordId: request.id, tokens: request.tokens, provenance: request.provenance });
        }
        assert.equal(items.find(item => item.event.segment === 'tool').replyMetadata, null);
        const childProtocol = await json(`${base}/api/v3/protocol/opencode/metadata-child?version=3`);
        assert.equal(childProtocol.validation.ok, true);
        assert.equal(childProtocol.usageRecords.length, 0, 'A fork copy is not an owned child request');
        const childItems = await readerItems(base, 'opencode', 'metadata-child');
        assert.equal(childItems.length, 1, 'The existing fork boundary excludes copied mother parts');
        assert.equal(childItems[0].replyMetadata.model, 'child-model');
        assert.equal(childItems[0].replyMetadata.requestUsage, null);
      }
    });
}

test('Reader gives Claude repeated response usage to one same-record primary text and isolates adjacent and child replies',
  { timeout: 30_000 }, async t => {
    const original = rows(path.join(repo, 'test/fixtures/claude-current-v259-synthetic.jsonl'));
    const source = original.find(row => row.type === 'assistant');
    const first = structuredClone(source);
    first.uuid = 'owned';
    first.message.content = [{ type: 'thinking', thinking: 'Source thinking.' },
      { type: 'text', text: 'Primary text.' }, { type: 'text', text: 'Second text.' }];
    const repeated = structuredClone(source);
    repeated.uuid = 'duplicate';
    repeated.message.content = [{ type: 'text', text: 'Repeated response part.' }];
    const adjacent = structuredClone(source);
    adjacent.uuid = 'adjacent';
    adjacent.message.id = 'response-adjacent';
    delete adjacent.message.model;
    adjacent.message.content = [{ type: 'text', text: 'Separate reply without model.' }];
    const child = structuredClone(source);
    child.uuid = 'child-owned';
    child.isSidechain = true;
    child.agentId = 'metadata-child';
    child.message.model = 'child-model';
    child.message.content = [{ type: 'text', text: 'Child reply with independent source.' }];
    const { base } = await setup(t, async ({ dirs, put }) => {
      await put(path.join(dirs.claude, 'transcripts', 'metadata-root.jsonl'),
        [first, repeated, adjacent].map(row => JSON.stringify(row)).join('\n') + '\n');
      await put(path.join(dirs.claude, 'transcripts', 'metadata-child.jsonl'), JSON.stringify(child) + '\n');
    });
    const protocol = await json(`${base}/api/v3/protocol/claude-code/metadata-root?version=3`);
    assert.equal(protocol.validation.ok, true);
    assert.equal(protocol.usageRecords.length, 2, 'A repeated response is selected once, independently of the adjacent response');
    const items = await readerItems(base, 'claude-code', 'metadata-root');
    const primary = items.find(item => item.event.messageId === 'owned:1' && item.event.segment === 'message');
    assert.ok(primary, 'The exact first nonempty text of the original assistant record is readable');
    assert.ok(primary.replyMetadata, 'Claude source metadata must be assigned during its own block projection');
    assert.equal(primary.replyMetadata.model, first.message.model);
    assert.equal(primary.replyMetadata.modelProvider, null);
    assert.equal(primary.replyMetadata.modelProvenance.sourceId, 'owned');
    const request = protocol.usageRecords.find(record => record.provenance.sourceId === 'owned');
    assert.deepEqual(primary.replyMetadata.requestUsage,
      { recordId: request.id, tokens: request.tokens, provenance: request.provenance });
    for (const id of ['owned:2', 'duplicate']) {
      const item = items.find(item => item.event.messageId === id && item.event.segment === 'message');
      assert.equal(item.replyMetadata.model, first.message.model);
      assert.equal(item.replyMetadata.requestUsage, null);
    }
    const next = items.find(item => item.event.messageId === 'adjacent' && item.event.segment === 'message');
    assert.equal(next.replyMetadata.model, null, 'The adjacent reply cannot inherit the previous model');
    assert.equal(next.replyMetadata.modelProvenance, null);
    assert.notEqual(next.replyMetadata.requestUsage.recordId, request.id);
    const childItems = await readerItems(base, 'claude-code', 'metadata-child');
    const childReply = childItems.find(item => item.event.messageId === 'child-owned');
    assert.equal(childReply.replyMetadata.model, 'child-model');
    assert.notEqual(childReply.replyMetadata.requestUsage.recordId, request.id,
      'Equal recorded response IDs in separate canonical sessions do not merge their requests');
  });

test('Reader keeps Codex request usage unattributed across child and context boundaries and rebuilds the old durable projection',
  { timeout: 30_000 }, async t => {
    const fixture = path.join(repo, 'test/fixtures/codex-current-v153.jsonl');
    const sourceRows = rows(fixture);
    const id = sourceRows[0].payload.id;
    const childId = 'metadata-child';
    const { base, dirs } = await setup(t, async ({ dirs, put, ledger }) => {
      ledger.set(fixture, sha(fixture));
      const dir = path.join(dirs.codex, 'sessions', '2026', '09', '03');
      const parentRows = [...sourceRows];
      parentRows.splice(10, 0, { timestamp: '2026-09-03T01:00:09.500Z', type: 'response_item',
        payload: { type: 'message', role: 'assistant', id: 'unattributed-reply',
          content: [{ type: 'output_text', text: 'A readable reply does not establish request ownership.' }] } });
      for (let index = 0; index < 40; index++) {
        parentRows.push({ type: 'response_item', payload: { type: 'message', role: 'assistant',
          id: `unattributed-page-${index}`, content: [{ type: 'output_text', text: `Own reply ${index}.` }] } });
      }
      await put(path.join(dir, 'rollout-parent.jsonl'), parentRows.map(row => JSON.stringify(row)).join('\n') + '\n');
      await put(path.join(dir, 'rollout-child.jsonl'), [
        { type: 'session_meta', payload: { id: childId, parent_thread_id: id } },
        { type: 'response_item', payload: { type: 'message', id: 'child-reply', role: 'assistant',
          content: [{ type: 'output_text', text: 'No recorded reply-owned model or usage.' }] } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
    });
    const protocol = await json(`${base}/api/v3/protocol/codex/${id}?version=3`);
    assert.equal(protocol.validation.ok, true);
    assert.equal(protocol.usageRecords.length, 1);
    assert.equal(protocol.usageRecords[0].eventId, null, 'The proved request has no source-backed reply owner');
    const initial = await readerItems(base, 'codex', id);
    const initialBootstrap = await json(`${base}/api/v3/reader/codex/${id}/bootstrap`);
    const retainedCursor = initialBootstrap.segments[0].nextCursor;
    assert.ok(retainedCursor, 'The source has a meaningful continuation cursor before cache replacement');
    const continuation = await json(`${base}/api/v3/reader/codex/${id}/segments?cursor=${encodeURIComponent(retainedCursor)}`);
    assert.ok(initial.some(item => item.role === 'assistant' || item.role === 'agent'));
    assert.ok(initial.some(item => item.event.segment === 'context'));
    assert.ok(initial.every(item => item.replyMetadata === null), 'Thread model settings and session usage cannot become reply facts');
    const childItems = await readerItems(base, 'codex', childId);
    assert.ok(childItems.every(item => item.replyMetadata === null), 'Child replies cannot inherit parent usage metadata');
    const caches = (await import('node:fs')).readdirSync(dirs.cache).filter(file => /^reader-.*\.sqlite$/.test(file));
    assert.equal(caches.length, 1);
    const db = new DatabaseSync(path.join(dirs.cache, caches[0]));
    const oldRows = db.prepare('SELECT ordinal,item_json FROM reader_item WHERE provider=? AND session_id=?').all('codex', id);
    const update = db.prepare('UPDATE reader_item SET item_json=? WHERE provider=? AND session_id=? AND ordinal=?');
    for (const row of oldRows) {
      const item = JSON.parse(row.item_json);
      delete item.replyMetadata;
      update.run(JSON.stringify(item), 'codex', id, row.ordinal);
    }
    db.prepare('UPDATE reader_session SET projection=4 WHERE provider=? AND session_id=?').run('codex', id);
    db.close();
    assert.deepEqual(await readerItems(base, 'codex', id), initial, 'An old cache with unchanged source must rebuild to the same normalized Reader facts');
    assert.deepEqual(await json(`${base}/api/v3/reader/codex/${id}/segments?cursor=${encodeURIComponent(retainedCursor)}`), continuation,
      'The cursor retains source revision and position because the new nullable DTO changes neither');
    const reopened = new DatabaseSync(path.join(dirs.cache, caches[0]));
    assert.equal(reopened.prepare('SELECT projection FROM reader_session WHERE provider=? AND session_id=?').get('codex', id).projection, 10);
    reopened.close();
  });

test('Reader keeps DSH recorded model facts visible when that message has no request usage',
  { timeout: 30_000 }, async t => {
    const { base, dshId, dshRows } = await setup(t);
    const document = await json(`${base}/api/v3/protocol/deepseek-harness/${dshId}?version=3`);
    assert.equal(document.validation.ok, true);
    assert.equal(document.usageRecords.length, 0, 'The actual preview fixture records model facts without usage');
    const items = await readerItems(base, 'deepseek-harness', dshId);
    const sourceReplies = dshRows.filter(row => row.type === 'assistant/message');
    assert.equal(sourceReplies.length, 30);
    const firstSource = sourceReplies[0];
    const first = items.find(item => item.event.messageId === firstSource.data.message.id && item.event.segment === 'message');
    assert.ok(first, 'The source-backed reply must be present before checking its model');
    assert.ok(first.replyMetadata, 'Reader lost the recorded model/provider from a DSH message without usage');
    for (const row of sourceReplies) {
      const item = items.find(item => item.event.messageId === row.data.message.id && item.event.segment === 'message');
      assert.equal(item.replyMetadata.model, row.data.message.source.model);
      assert.equal(item.replyMetadata.modelProvider, row.data.message.source.provider);
      assert.equal(item.replyMetadata.modelProvenance.fidelity, 'recorded');
      assert.equal(item.replyMetadata.modelProvenance.sourceId, String(row.seq));
      assert.equal(item.replyMetadata.requestUsage, null, 'Missing request usage cannot become an all-zero estimate');
    }
    for (const item of items.filter(item => item.role !== 'assistant' || item.event.segment !== 'message')) {
      assert.equal(item.replyMetadata, null);
    }
  });

test('Reader gives DSH usage only to the selected settlement source and preserves same-object model ownership',
  { timeout: 30_000 }, async t => {
    const id = 'metadata-settlement';
    const usage = { inputTokens: 3, outputTokens: 4, reasoningTokens: 1,
      cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 7 };
    const settlement = (seq, step, source, extra = {}) => ({ type: 'assistant/message', seq,
      time: 101 + seq, surfaceOp: 'append', data: { turn: 1, step,
        message: { id: `reply-${seq}`, role: 'assistant', source,
          content: [{ type: 'text', text: `Recorded answer ${seq}.` }] }, usage, ...extra } });
    const sourceRows = [{ type: 'session', version: 3, id, createdAt: 100, isSeeded: false },
      { type: 'assistant/attempt', seq: 0, time: 101, data: { turn: 1, step: 1,
        source: { kind: 'model', model: 'attempt-model', provider: 'attempt-vendor' },
        stream: [{ type: 'usage', usage }] } },
      settlement(1, 1, { kind: 'model', model: 'settled-model', provider: 'settled-vendor' }),
      settlement(2, 2, { kind: 'model', model: 'unknown-provider-model' },
        { source: { kind: 'model', model: 'other-model', provider: 'other-vendor' } }),
      { type: 'assistant/attempt', seq: 3, time: 104, data: { turn: 1, step: 3,
        source: { kind: 'model', model: 'unsettled-model', provider: 'unsettled-vendor' },
        stream: [{ type: 'usage', usage }] } },
    ];
    const { base } = await setup(t, async ({ dirs, put }) => {
      await put(path.join(dirs.dsh, 'sessions', id, 'session.v3.jsonl'),
        sourceRows.map(JSON.stringify).join('\n') + '\n');
    });
    const document = await json(`${base}/api/v3/protocol/deepseek-harness/${id}?version=3`);
    assert.equal(document.validation.ok, true);
    assert.deepEqual(document.usageRecords.map(record => record.provenance.sourceId), ['1', '2', '3']);
    const items = await readerItems(base, 'deepseek-harness', id);
    const replies = items.filter(item => item.role === 'assistant' && item.event.segment === 'message');
    assert.equal(replies.length, 2, 'An unreturned attempt does not manufacture a readable reply owner');
    for (const [index, reply] of replies.entries()) {
      const record = document.usageRecords[index];
      assert.ok(reply.replyMetadata, 'The exact selected settlement must retain its own model and request facts');
      assert.equal(reply.replyMetadata.model, sourceRows[index + 2].data.message.source.model);
      assert.deepEqual(reply.replyMetadata.requestUsage,
        { recordId: record.id, tokens: record.tokens, provenance: record.provenance });
    }
    assert.equal(replies[0].replyMetadata.modelProvider, 'settled-vendor');
    assert.equal(replies[1].replyMetadata.modelProvider, null, 'A provider from data.source cannot cross to message.source.model');
    assert.equal(new Set(replies.map(reply => reply.replyMetadata.requestUsage.recordId)).size, 2);
    assert.ok(items.every(item => item.replyMetadata?.requestUsage?.recordId !== document.usageRecords[2].id),
      'The unmatched attempt remains available only in the existing session usage projection');
  });

test('Reader leaves Claude thinking-only request usage on its source record instead of assigning the following text',
  { timeout: 30_000 }, async t => {
    const fixture = path.join(repo, 'test/fixtures/claude-current-v259-synthetic.jsonl');
    const source = rows(fixture).find(row => row.type === 'assistant');
    const thinking = structuredClone(source);
    thinking.uuid = 'thinking-only';
    thinking.message.id = 'response-thinking-only';
    thinking.message.model = 'thinking-model';
    thinking.message.content = [{ type: 'thinking', thinking: 'Recorded reasoning before a separate reply.' }];
    const text = structuredClone(source);
    text.uuid = 'separate-text';
    text.message.id = 'response-separate-text';
    delete text.message.model;
    delete text.message.usage;
    text.message.content = [{ type: 'text', text: 'A later source reply does not own the earlier request.' }];
    const { base } = await setup(t, async ({ dirs, put, ledger }) => {
      ledger.set(fixture, sha(fixture));
      await put(path.join(dirs.claude, 'transcripts', 'thinking-root.jsonl'),
        [thinking, text].map(JSON.stringify).join('\n') + '\n');
    });
    const document = await json(`${base}/api/v3/protocol/claude-code/thinking-root?version=3`);
    assert.equal(document.validation.ok, true);
    assert.equal(document.usageRecords.length, 1);
    assert.equal(document.usageRecords[0].provenance.sourceId, 'thinking-only');
    const items = await readerItems(base, 'claude-code', 'thinking-root');
    const reply = items.find(item => item.event.messageId === 'separate-text' && item.event.segment === 'message');
    assert.ok(reply);
    assert.equal(reply.replyMetadata, null, 'Existing reasoning placement cannot transfer a model or request from another raw record');
    assert.ok(items.every(item => item.replyMetadata?.requestUsage == null));
  });

test('Reader keeps DSH seeded replies outside owned usage and attaches each retry settlement only once',
  { timeout: 30_000 }, async t => {
    const id = 'metadata-seeded-retry';
    const usage = { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 7 };
    const message = (seq, model) => ({ type: 'assistant/message', seq, time: 101 + seq,
      surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: `reply-${seq}`, role: 'assistant',
        source: { kind: 'model', model, provider: 'recorded-vendor' },
        content: [{ type: 'text', text: `Recorded answer ${seq}.` }] }, usage } });
    const sourceRows = [{ type: 'session', version: 3, id, createdAt: 100, isSeeded: true },
      message(0, 'inherited-model'),
      { type: 'session/end-seed', seq: 1, time: 102, data: { inherited: true } },
      message(2, 'own-model'),
      { type: 'llm/retry-started', seq: 3, time: 104, data: { turn: 1, step: 1, retry: 1 } },
      message(4, 'retry-model')];
    const { base } = await setup(t, async ({ dirs, put }) => {
      await put(path.join(dirs.dsh, 'sessions', id, 'session.v3.jsonl'),
        sourceRows.map(JSON.stringify).join('\n') + '\n');
    });
    const document = await json(`${base}/api/v3/protocol/deepseek-harness/${id}?version=3`);
    assert.equal(document.validation.ok, true);
    assert.deepEqual(document.usageRecords.map(record => record.provenance.sourceId), ['2', '4']);
    const items = await readerItems(base, 'deepseek-harness', id);
    const replies = items.filter(item => item.role === 'assistant' && item.event.segment === 'message');
    assert.deepEqual(replies.map(item => item.event.messageId), ['reply-2', 'reply-4']);
    assert.ok(replies.every(item => item.replyMetadata), 'Each owned retry settlement must retain source facts');
    assert.deepEqual(replies.map(item => item.replyMetadata.model), ['own-model', 'retry-model']);
    assert.deepEqual(replies.map(item => item.replyMetadata.requestUsage.recordId), document.usageRecords.map(record => record.id));
  });
