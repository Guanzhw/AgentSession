import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');

async function freePort() {
  return freeFetchSafePort();
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill();
  await closed;
}

async function setup(t, version) {
  await mkdir(path.join(repo, 'tmp'), { recursive: true });
  const root = await mkdtemp(path.join(repo, 'tmp', 'v3-opencode-foundation-'));
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(stopChild));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(repo, 'tmp'));
    assert.ok(path.basename(root).startsWith('v3-opencode-foundation-'));
    await rm(root, { recursive: true, force: true });
  });
  const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']
    .map(name => [name, path.join(root, name)]));
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
  const file = path.join(root, 'opencode.db');
  const db = new DatabaseSync(file);
  if (version === 'v2') {
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT,
      fork_boundary TEXT, title TEXT, slug TEXT, directory TEXT, time_created INTEGER,
      time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
      tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT);
      INSERT INTO session_v2 VALUES ('root',NULL,NULL,NULL,'Root','root','/synthetic',1,1,NULL,0,0,0,0,0),
        ('child','root',NULL,NULL,'Child','child','/synthetic',1,1,NULL,0,0,0,0,0),
        ('orphan','missing-parent',NULL,NULL,'Orphan','orphan','/synthetic',1,1,NULL,0,0,0,0,0),
        ('fork',NULL,'root','{}','Fork','fork','/synthetic',1,1,NULL,0,0,0,0,0);`);
    const add = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
    add.run('u', 'root', 'user', 1, 1, 1, JSON.stringify({ text: 'SECRET_USER' }));
    add.run('a', 'root', 'assistant', 2, 2, 2, JSON.stringify({ content: [
      { type: 'reasoning', text: 'SECRET_REASONING' },
      { type: 'text', text: 'SECRET_ANSWER' },
      { type: 'tool', name: 'read', state: { status: 'completed', input: {}, content: [] } },
    ] }));
    add.run('c', 'root', 'compaction', 3, 3, 3, JSON.stringify({ summary: 'SECRET_SUMMARY' }));
    add.run('msg_parent_4', 'fork', 'assistant', 4, 4, 4, JSON.stringify({ content: [
      { type: 'text', text: 'SECRET_INHERITED' }] }));
    add.run('f', 'fork', 'user', 5, 5, 5, JSON.stringify({ text: 'SECRET_FORK' }));
  } else {
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT,
      directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT,
        time_created INTEGER);
      INSERT INTO session VALUES ('legacy',NULL,'Legacy','/synthetic',1,1,NULL),
        ('legacy-orphan','missing-parent','Legacy orphan','/synthetic',1,1,NULL);
      INSERT INTO message VALUES ('m','legacy','{"role":"user","time":{"created":1}}',1);
      INSERT INTO part VALUES ('p','m','legacy','{"type":"text","text":"SECRET_LEGACY"}',1),
        ('tool','m','legacy','{"type":"tool","tool":"read","state":{"status":"error","error":"SECRET_ERROR"}}',2);`);
  }
  db.close();
  const args = ['--opencode-db', file, '--codex-dir', dirs.codex, '--claude-dir', dirs.claude,
    '--pi-dir', dirs.pi, '--dsh-dir', dirs.dsh, '--meta-dir', dirs.meta,
    '--index-dir', dirs.index, '--cache-dir', dirs.cache];
  return { file, args, children };
}

async function serve(f) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await freePort();
    const child = spawn(binary, ['serve', '--port', String(port), ...f.args],
      { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data.toString(); });
    f.children.push(child);
    const base = `http://127.0.0.1:${port}`;
    let badPort = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + '/api/providers')).ok) return base;
      } catch (error) {
        if (error?.cause?.message === 'bad port') {
          badPort = true;
          break;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (badPort) {
      await stopChild(child);
      if (attempt < 4) continue;
    }
    assert.fail(`server did not start: ${stderr.slice(0, 500)}`);
  }
}

async function allEvents(base, session, limit = 2) {
  const events = [];
  let cursor;
  let revision;
  do {
    const url = new URL(`/api/v3/runtime/opencode/${session}/events`, base);
    url.searchParams.set('limit', String(limit));
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.coverage, 'partial');
    if (revision) assert.equal(page.revision, revision);
    revision = page.revision;
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  return { events, revision };
}

async function json(url) {
  const response = await fetch(url);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function verifyFoundation(base, id, expectedTaskEventIds = []) {
  const reader = await json(`${base}/api/v3/reader/opencode/${id}/bootstrap`);
  const v2 = await json(`${base}/api/v3/protocol/opencode/${id}?version=2`);
  const v3 = await json(`${base}/api/v3/protocol/opencode/${id}?version=3`);
  const stream = await allEvents(base, id, 200);
  for (const [version, doc] of [[2, v2], [3, v3]]) {
    assert.equal(doc.version, version);
    assert.equal(doc.validation.ok, true);
    assert.equal(doc.completeness, 'partial');
    assert.deepEqual(doc.session, { provider: 'opencode', sessionId: id });
    assert.equal(doc.revision, reader.revision);
    assert.equal(doc.revision, stream.revision);
    assert.deepEqual(doc.events, stream.events);
  }
  for (const key of ['session', 'revision', 'events', 'tasks', 'agentRuns', 'relationships',
    'contextArtifacts', 'branches']) assert.deepEqual(v3[key], v2[key], key);
  assert.deepEqual(v3.upgrade, { fromVersion: 2, strategy: 'v2-to-v3', preservesV2Facts: true });
  for (const key of ['agentRuns', 'goals', 'actors',
    'contextVersions', 'contextTransformations']) assert.deepEqual(v3[key], [], key);
  assert.equal(v3.tasks.length, expectedTaskEventIds.length);
  assert.equal(v3.coordination.length, expectedTaskEventIds.length);
  assert.ok(v3.tasks.every(task => task.status === 'unknown'));
  assert.ok(expectedTaskEventIds.every(eventId => v3.tasks.some(task => task.evidence.eventId === eventId)));
  assert.equal(v3.coverage.relationships?.state,
    v3.relationships.length ? 'observed' : 'not-observed');
  for (const domain of ['tasks', 'coordination', 'work']) {
    assert.equal(v3.coverage[domain]?.state, expectedTaskEventIds.length ? 'observed' : 'unknown', domain);
    assert.ok(v3.coverage[domain].details.length > 0);
  }
  for (const domain of ['agentRuns', 'branches', 'context',
    'execution', 'ownership']) {
    assert.equal(v3.coverage[domain]?.state, 'unknown', domain);
    assert.ok(v3.coverage[domain].details.length > 0);
  }
  assert.ok(['observed', 'not-observed'].includes(v3.coverage.usage?.state));
  assert.ok(v3.coverage.usage.details.length > 0);
  if (v3.coverage.usage.state === 'not-observed') assert.deepEqual(v3.usageRecords, []);
  else assert.ok(v3.usageRecords.length > 0);
  assert.ok(v3.events.every(event => event.provenance.fidelity === 'recorded'));
  return v3;
}

for (const version of ['v1', 'v2']) {
  test(`OpenCode ${version} foundation preserves Reader/events/v2/v3 identity and unknown domains`,
    { timeout: 60_000 }, async t => {
      const fixture = await setup(t, version);
      const before = sha(fixture.file);
      const base = await serve(fixture);
      const doc = await verifyFoundation(base, version === 'v1' ? 'legacy' : 'root');
      assert.equal(doc.events.length, version === 'v1' ? 3 : 6);
      assert.equal(JSON.stringify(doc).includes('SECRET_'), false);
      if (version === 'v1') {
        const orphan = await verifyFoundation(base, 'legacy-orphan');
        assert.equal(orphan.events.length, 1);
        assert.equal(orphan.relationships.length, 1);
        assert.equal(orphan.relationships[0].kind, 'parent');
        assert.equal(orphan.relationships[0].from.sessionId, 'missing-parent');
        assert.deepEqual(orphan.relationships[0].evidence, {
          eventId: 'event:opencode:v1:session:legacy-orphan',
          provenance: { fidelity: 'recorded', sourceType: 'opencode.session.parent_id',
            sourceId: 'legacy-orphan' },
        });
      }
      if (version === 'v2') {
        const fork = await verifyFoundation(base, 'fork');
        assert.equal(fork.events.length, 2);
        assert.equal(fork.events[1].provenance.sourceId, 'f');
        for (const [id, from, kind, sourceType] of [
          ['child', 'root', 'parent', 'opencode.session_v2.parent_id'],
          ['orphan', 'missing-parent', 'parent', 'opencode.session_v2.parent_id'],
          ['fork', 'root', 'forked', 'opencode.session_v2.fork_session_id'],
        ]) {
          const related = id === 'fork' ? fork : await verifyFoundation(base, id);
          assert.equal(related.relationships.length, 1);
          assert.deepEqual(related.relationships[0].from,
            { provider: 'opencode', sessionId: from });
          assert.deepEqual(related.relationships[0].to,
            { provider: 'opencode', sessionId: id });
          assert.equal(related.relationships[0].kind, kind);
          assert.deepEqual(related.relationships[0].evidence, {
            eventId: `event:opencode:v2:session:${id}`,
            provenance: { fidelity: 'recorded', sourceType, sourceId: id },
          });
          assert.deepEqual(related.tasks, []);
          assert.deepEqual(related.agentRuns, []);
          const graph = await json(`${base}/api/v3/runtime/opencode/${id}/graph?maxNodes=3`);
          assert.equal(graph.revision, related.revision);
          assert.equal(graph.edges.length, 1);
          assert.equal(graph.edges[0].type, kind);
          assert.equal(graph.edges[0].inferred, false);
          const parent = graph.nodes.find(node => node.session.sessionId === from);
          assert.equal(parent.resolution, 'unverified');
        }
      }
      assert.equal(sha(fixture.file), before);
    });
}

test('OpenCode protocol documents keep malformed source failure explicit', { timeout: 30_000 }, async t => {
  const fixture = await setup(t, 'v2');
  const db = new DatabaseSync(fixture.file);
  db.prepare('UPDATE session_message SET data=? WHERE id=?').run('SECRET_BAD_JSON', 'a');
  db.close();
  const before = sha(fixture.file);
  const base = await serve(fixture);
  for (const version of [2, 3]) {
    const response = await fetch(`${base}/api/v3/protocol/opencode/root?version=${version}`);
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.match(body, /source_error/);
    assert.equal(body.includes('SECRET_BAD_JSON'), false);
  }
  assert.equal(sha(fixture.file), before);
});

test('frozen real OpenCode foundation and all native task dispatches preserve source facts',
  { timeout: 120_000, skip: !process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST }, async t => {
    const manifest = JSON.parse(readFileSync(process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST));
    const fixture = await setup(t, 'v2');
    const source = manifest.database.snapshotPath;
    const before = [source, `${source}-wal`].map(file => {
      try { return sha(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    });
    assert.equal(before[0], manifest.database.snapshotSha256);
    fixture.args[1] = source;
    const base = await serve(fixture);
    const sourceDb = new DatabaseSync(source, { readOnly: true });
    t.after(() => sourceDb.close());
    for (const selected of manifest.captureTargets.filter(row => row.provider === 'opencode')) {
      const id = selected.sessionId;
      const rows = sourceDb.prepare(`SELECT m.id, m.type, m.data FROM session_message m
        JOIN session_v2 s ON s.id=m.session_id WHERE m.session_id=? AND
        (s.fork_session_id IS NULL OR substr(m.id,-length(CAST(m.seq AS TEXT))-1) != '_' || m.seq)
        ORDER BY m.seq, m.id`).all(id);
      const expectedTaskEventIds = rows.flatMap(row => row.type === 'assistant'
        ? JSON.parse(row.data).content.flatMap((part, index) =>
          part.type === 'tool' && part.name === 'task'
            ? [`event:opencode:v2:${row.id}:content:${index}`] : []) : []);
      const doc = await verifyFoundation(base, id, expectedTaskEventIds);
      const expectedDispatches = rows.flatMap(row => row.type === 'assistant'
        ? JSON.parse(row.data).content.flatMap((part, index) => {
          if (part.type !== 'tool' || part.name !== 'task') return [];
          const claimed = part.state?.metadata?.sessionId;
          const parent = typeof claimed === 'string'
            ? sourceDb.prepare('SELECT parent_id FROM session_v2 WHERE id=?').get(claimed)?.parent_id : null;
          const child = parent === id &&
            (part.state?.metadata?.parentSessionId === undefined ||
              part.state.metadata.parentSessionId === id) ? claimed : null;
          return [{ eventId: `event:opencode:v2:${row.id}:content:${index}`,
            readerId: `${row.id}:content:${index}`, child }];
        }) : []);
      assert.equal(doc.coordination.length, expectedDispatches.length);
      assert.ok(expectedDispatches.every(expected => {
        const fact = doc.coordination.find(item => item.evidence.eventId === expected.eventId);
        return fact && fact.toSessionRef?.sessionId === (expected.child || undefined) &&
          fact.kind === (expected.child ? 'spawn' : 'delegate');
      }));
      const expectedChildren = [...new Set(expectedDispatches.map(item => item.child).filter(Boolean))];
      assert.equal(doc.relationships.filter(item => item.kind === 'spawned').length, expectedChildren.length);
      const bootstrap = await json(`${base}/api/v3/reader/opencode/${encodeURIComponent(id)}/bootstrap`);
      const relations = await json(`${base}/api/v3/reader/opencode/${encodeURIComponent(id)}/relations?cursor=${encodeURIComponent(bootstrap.relations.firstCursor)}`);
      assert.equal(relations.childPlacements.length, expectedChildren.length);
      assert.ok(expectedChildren.every(child => {
        const source = expectedDispatches.find(item => item.child === child);
        return relations.childPlacements.some(item => item.child.sessionId === child &&
          item.afterEvent?.messageId === source.readerId && item.afterEvent?.segment === 'tool');
      }));
      const relation = sourceDb.prepare('SELECT parent_id, fork_session_id FROM session_v2 WHERE id=?')
        .get(id);
      assert.ok(rows.length > 0);
      assert.deepEqual(doc.events.map(event => event.id), [
        ...(relation.parent_id || relation.fork_session_id ? [`event:opencode:v2:session:${id}`] : []),
        ...rows.flatMap(row => [
          `event:opencode:v2:${row.id}`,
          ...(row.type === 'assistant' ? JSON.parse(row.data).content.map((_, index) =>
            `event:opencode:v2:${row.id}:content:${index}`) : []),
        ]),
      ]);
      t.diagnostic(`Frozen selected session: ${doc.events.length} events; same-revision Reader/v2/v3 verified`);
    }
    const nativeTaskRows = sourceDb.prepare(`SELECT m.session_id, m.id, m.data FROM session_message m
      JOIN session_v2 s ON s.id=m.session_id WHERE m.type='assistant' AND
      (s.fork_session_id IS NULL OR substr(m.id,-length(CAST(m.seq AS TEXT))-1) != '_' || m.seq)
      ORDER BY m.session_id, m.seq, m.id`).all();
    const parentByChild = sourceDb.prepare('SELECT parent_id FROM session_v2 WHERE id=?');
    const tasksByParent = new Map();
    let unclaimed = 0;
    for (const row of nativeTaskRows) {
      JSON.parse(row.data).content.forEach((part, index) => {
        if (part.type !== 'tool' || part.name !== 'task') return;
        const claimed = part.state?.metadata?.sessionId;
        if (typeof claimed !== 'string') unclaimed++;
        const recordedParent = typeof claimed === 'string'
          ? parentByChild.get(claimed)?.parent_id : null;
        const child = recordedParent === row.session_id &&
          (part.state?.metadata?.parentSessionId === undefined ||
            part.state.metadata.parentSessionId === row.session_id) ? claimed : null;
        const records = tasksByParent.get(row.session_id) || [];
        records.push({ eventId: `event:opencode:v2:${row.id}:content:${index}`,
          readerId: `${row.id}:content:${index}`, callId: part.id, child });
        tasksByParent.set(row.session_id, records);
      });
    }
    assert.equal(tasksByParent.size, 9);
    assert.equal([...tasksByParent.values()].reduce((sum, records) => sum + records.length, 0), 59);
    assert.equal([...tasksByParent.values()].reduce((sum, records) =>
      sum + records.filter(record => record.child).length, 0), 58);
    assert.equal(unclaimed, 1);
    for (const [parent, expected] of tasksByParent) {
      const route = encodeURIComponent(parent);
      const doc = await json(`${base}/api/v3/protocol/opencode/${route}?version=3`);
      assert.equal(doc.validation.ok, true);
      assert.equal(doc.tasks.length, expected.length);
      assert.equal(doc.coordination.length, expected.length);
      assert.deepEqual(doc.agentRuns, []);
      assert.ok(doc.tasks.every(task => task.status === 'unknown'));
      assert.ok(expected.every(record => {
        const task = doc.tasks.find(item => item.evidence.eventId === record.eventId);
        const dispatch = doc.coordination.find(item => item.evidence.eventId === record.eventId);
        return task && dispatch && dispatch.correlationId === record.callId &&
          dispatch.kind === (record.child ? 'spawn' : 'delegate') &&
          dispatch.toSessionRef?.sessionId === (record.child || undefined);
      }));
      const children = [...new Set(expected.map(record => record.child).filter(Boolean))];
      assert.equal(doc.relationships.filter(item => item.kind === 'spawned').length, children.length);
      assert.ok(children.every(child => doc.relationships.some(item =>
        item.kind === 'spawned' && item.to.sessionId === child && item.from.sessionId === parent)));
      const bootstrap = await json(`${base}/api/v3/reader/opencode/${route}/bootstrap`);
      assert.equal(bootstrap.revision, doc.revision);
      const relations = await json(`${base}/api/v3/reader/opencode/${route}/relations?cursor=${encodeURIComponent(bootstrap.relations.firstCursor)}`);
      assert.equal(relations.childPlacements.length, children.length);
      assert.ok(children.every(child => {
        const record = expected.find(item => item.child === child);
        return relations.childPlacements.some(item => item.child.sessionId === child &&
          item.afterEvent?.messageId === record.readerId && item.afterEvent?.segment === 'tool');
      }));
      const graph = await json(`${base}/api/v3/runtime/opencode/${route}/graph?maxNodes=100`);
      assert.equal(graph.edges.filter(edge => edge.type === 'spawned').length, children.length);
    }
    t.diagnostic('Frozen native V2 tasks: 59 requests across 9 parents; 58 canonical child placements, 1 unclaimed error');
    const related = sourceDb.prepare(`SELECT s.id, s.parent_id FROM session_v2 s
      WHERE s.parent_id IS NOT NULL AND EXISTS
        (SELECT 1 FROM session_message m WHERE m.session_id=s.id)
      ORDER BY s.time_updated DESC, s.id LIMIT 1`).get();
    if (related) {
      const relatedRows = sourceDb.prepare(`SELECT id, type, data FROM session_message
        WHERE session_id=? ORDER BY seq, id`).all(related.id);
      const relatedTasks = relatedRows.flatMap(row => row.type === 'assistant'
        ? JSON.parse(row.data).content.flatMap((part, index) =>
          part.type === 'tool' && part.name === 'task'
            ? [`event:opencode:v2:${row.id}:content:${index}`] : []) : []);
      const doc = await verifyFoundation(base, encodeURIComponent(related.id), relatedTasks);
      assert.equal(doc.relationships.length, 1);
      assert.equal(doc.relationships[0].kind, 'parent');
      assert.equal(doc.relationships[0].from.sessionId, related.parent_id);
      assert.equal(doc.relationships[0].evidence.provenance.sourceType,
        'opencode.session_v2.parent_id');
      const graph = await json(`${base}/api/v3/runtime/opencode/${encodeURIComponent(related.id)}/graph`);
      assert.equal(graph.edges.length, 1);
      assert.equal(graph.edges[0].type, 'parent');
      t.diagnostic('Frozen recorded OpenCode parent relationship reached protocol and graph');
    }
    assert.deepEqual([source, `${source}-wal`].map(file => {
      try { return sha(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }), before);
  });
