import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const piId = '019f8a00-0000-7000-8000-000000000001';
const codexId = '44444444-4444-4444-8444-444444444444';
const digest = async value => createHash('sha256').update(value).digest('hex');
const fileDigest = async file => digest(await readFile(file));

async function setup(t, extraPiCount = 0) {
  const dir = await mkdtemp(path.join(repo, 'tmp', 'v3-http08-batch-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    assert.ok(path.resolve(dir).startsWith(path.resolve(repo, 'tmp') + path.sep));
    await rm(dir, { recursive: true, force: true });
  });

  for (const name of ['pi/sessions/project', 'codex/sessions/2026/09/26', 'claude', 'dsh', 'meta', 'index', 'cache'])
    await mkdir(path.join(dir, name), { recursive: true });
  const piSource = path.join(dir, 'pi', 'sessions', 'project', `current_${piId}.jsonl`);
  const codexSource = path.join(dir, 'codex', 'sessions', '2026', '09', '26',
    'rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl');
  await copyFile(path.join(repo, 'test', 'fixtures', 'pi-v3-current.jsonl'), piSource);
  const piFixture = await readFile(piSource, 'utf8');
  const extraPiIds = [];
  const extraPiSources = [];
  for (let index = 2; index < extraPiCount + 2; index++) {
    const id = `019f8a00-0000-7000-8000-${index.toString(16).padStart(12, '0')}`;
    const source = path.join(dir, 'pi', 'sessions', 'project', `current_${id}.jsonl`);
    await writeFile(source, piFixture.replaceAll(piId, id));
    extraPiIds.push(id);
    extraPiSources.push(source);
  }
  await copyFile(path.join(repo, 'v3', 'fixtures', 'codex', 'sessions', '2026', '09', '26',
    'rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl'), codexSource);
  const sourceHashes = { pi: await fileDigest(piSource), codex: await fileDigest(codexSource) };

  const seed = path.join(dir, 'seed.db');
  const db = new DatabaseSync(seed);
  db.exec(`CREATE TABLE session_meta (provider TEXT NOT NULL DEFAULT 'opencode', session_id TEXT NOT NULL,
    custom_title TEXT, starred INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, permanent INTEGER DEFAULT 0,
    time_starred INTEGER, time_deleted INTEGER, time_renamed INTEGER, PRIMARY KEY(provider,session_id));
    CREATE TABLE v1_index (session_id TEXT PRIMARY KEY, marker TEXT);`);
  const insert = db.prepare(`INSERT INTO session_meta(provider,session_id,custom_title,starred,deleted,permanent)
    VALUES (?,?,?,?,?,?)`);
  insert.run('pi', piId, 'Pi seed title', 0, 0, 0);
  insert.run('codex', codexId, 'Codex seed title', 0, 0, 0);
  insert.run('codex', piId, 'Same ID, other provider', 1, 0, 0);
  insert.run('openclaw', piId, 'Retired provider row', 1, 0, 0);
  db.prepare('INSERT INTO v1_index VALUES (?,?)').run(piId, 'preserve-v1-row');
  db.close();

  const legacyMeta = path.join(dir, 'meta', 'meta.db');
  await copyFile(seed, legacyMeta);
  const legacyMetaHash = await fileDigest(legacyMeta);
  const port = await freeFetchSafePort();
  const args = ['serve', '--port', String(port), '--pi-dir', path.join(dir, 'pi'),
    '--codex-dir', path.join(dir, 'codex'), '--claude-dir', path.join(dir, 'claude'),
    '--opencode-db', path.join(dir, 'opencode.db'), '--dsh-dir', path.join(dir, 'dsh'),
    '--meta-dir', path.join(dir, 'meta'), '--index-dir', path.join(dir, 'index'),
    '--cache-dir', path.join(dir, 'cache')];
  child = spawn(binary, args, { cwd: repo, windowsHide: true, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${base}/api/providers`)).ok) {
        assert.equal((await fetch(`${base}/api/v3/sessions?provider=pi`)).status, 200);
        assert.equal((await fetch(`${base}/api/v3/sessions?provider=codex`)).status, 200);
        const catalogs = (await readdir(path.join(dir, 'index'))).filter(name => name.endsWith('.sqlite'));
        assert.equal(catalogs.length, 1);
        const metadata = path.join(dir, 'meta', 'scopes', catalogs[0].slice(0, -'.sqlite'.length), 'meta.db');
        await mkdir(path.dirname(metadata), { recursive: true });
        await copyFile(seed, metadata);
        return { base, dir, metadata, legacyMeta, legacyMetaHash, piSource, codexSource,
          sourceHashes, extraPiIds, extraPiSources };
      }
    } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Web server did not start');
}

function snapshot(metadata) {
  const db = new DatabaseSync(metadata, { readOnly: true });
  const row = db.prepare(`SELECT custom_title,starred,deleted,permanent FROM session_meta
    WHERE provider=? AND session_id=?`);
  const result = {
    pi: row.get('pi', piId),
    codex: row.get('codex', codexId),
    sameIdOtherProvider: row.get('codex', piId),
    retired: row.get('openclaw', piId),
    v1Index: db.prepare('SELECT marker FROM v1_index WHERE session_id=?').get(piId),
  };
  db.close();
  return result;
}

async function sessionState(base, provider, id) {
  const response = await fetch(`${base}/api/v3/sessions?provider=${provider}`);
  assert.equal(response.status, 200);
  const sessions = await response.json();
  const row = sessions.find(item => item.session.sessionId === id);
  const metadata = await (await fetch(`${base}/api/v3/meta?provider=${provider}`)).json();
  const meta = metadata.find(item => item.sessionId === id);
  return {
    visible: Boolean(row),
    title: row?.title ?? null,
    metadata: meta ? {
      customTitle: meta.customTitle,
      starred: meta.starred,
      deleted: meta.deleted,
      permanent: meta.permanent,
    } : null,
  };
}

test('HTTP-08 cross-provider batch writes only scoped Viewer metadata', { timeout: 90_000 }, async t => {
  const { base, metadata, legacyMeta, legacyMetaHash, piSource, codexSource, sourceHashes } = await setup(t);
  const before = snapshot(metadata);
  const items = [
    { provider: 'pi', id: piId },
    { provider: 'codex', id: codexId },
    { provider: 'openclaw', id: piId },
  ];
  const post = (body, headers = {}) => fetch(`${base}/api/sessions/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, ...headers },
    body: JSON.stringify(body),
  });

  const invalidAction = await post({ action: 'invalid', items });
  assert.equal(invalidAction.status, 400,
    'fixed 2.0 cross-provider batch route must exist and validate the action');
  assert.deepEqual(await invalidAction.json(), { ok: false, error: 'Invalid action' });
  const httpBefore = { pi: await sessionState(base, 'pi', piId), codex: await sessionState(base, 'codex', codexId) };
  const rejectedBefore = snapshot(metadata);
  assert.equal((await post({ action: 'star', items }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post({ action: 'star', items }, { 'content-type': 'text/plain' })).status, 415);
  assert.deepEqual(snapshot(metadata), rejectedBefore);

  const laterProviderFailure = await post({ action: 'delete', items: [
    { provider: 'pi', id: piId }, { provider: 'codex', id: 'missing-source' },
  ] });
  assert.equal(laterProviderFailure.status, 404);
  assert.equal(snapshot(metadata).pi.deleted, 1, 'completed provider groups remain committed');
  assert.deepEqual(snapshot(metadata).codex, rejectedBefore.codex);
  assert.equal((await post({ action: 'restore', items: [{ provider: 'pi', id: piId }] })).status, 200);

  const repeated = Array.from({ length: 101 }, () => ({ provider: 'pi', id: piId }));
  const repeatedResponse = await post({ action: 'star', items: repeated });
  assert.equal(repeatedResponse.status, 200, 'legacy global batch accepts more than 100 items, including repeated IDs');
  assert.deepEqual(await repeatedResponse.json(), { ok: true, affected: 101, skipped: 0 });
  assert.equal(snapshot(metadata).pi.starred, 1);

  const actions = ['star', 'star', 'unstar', 'delete', 'restore', 'delete', 'permanent-delete'];
  const observations = [];
  for (const action of actions) {
    const response = await post({ action, items });
    assert.equal(response.status, 200, `cross-provider ${action} route must exist`);
    const body = await response.json();
    assert.deepEqual(body, { ok: true, affected: 2, skipped: 1 });
    observations.push({
      action,
      response: body,
      http: {
        pi: await sessionState(base, 'pi', piId),
        codex: await sessionState(base, 'codex', codexId),
      },
      sqlite: snapshot(metadata),
    });
  }

  assert.equal(observations[0].sqlite.pi.starred, 1);
  assert.equal(observations[0].sqlite.codex.starred, 1);
  assert.equal(observations[1].sqlite.pi.starred, 1, 'batch star is idempotent');
  assert.equal(observations[1].sqlite.codex.starred, 1, 'Codex batch star is idempotent');
  assert.equal(observations[2].sqlite.pi.starred, 0);
  assert.equal(observations[2].sqlite.codex.starred, 0);
  assert.equal(observations[3].http.pi.visible, false);
  assert.equal(observations[3].http.codex.visible, false);
  assert.equal(observations[4].http.pi.visible, true);
  assert.equal(observations[4].http.codex.visible, true);
  assert.equal(observations.at(-1).sqlite.pi.deleted, 1);
  assert.equal(observations.at(-1).sqlite.pi.permanent, 1);
  assert.equal(observations.at(-1).sqlite.codex.deleted, 1);
  assert.equal(observations.at(-1).sqlite.codex.permanent, 1);
  assert.deepEqual(observations.at(-1).sqlite.sameIdOtherProvider, before.sameIdOtherProvider);
  assert.deepEqual(observations.at(-1).sqlite.retired, before.retired);
  assert.deepEqual(observations.at(-1).sqlite.v1Index, before.v1Index);
  assert.deepEqual({ pi: await fileDigest(piSource), codex: await fileDigest(codexSource) }, sourceHashes);
  assert.equal(await fileDigest(legacyMeta), legacyMetaHash);

  if (process.env.AGENTSESSION_HTTP08_EVIDENCE_PATH) {
    const binaryHash = await fileDigest(binary);
    const report = {
      acceptance: 'HTTP-08',
      fixedV2Commit: '50a32e7c5b3fdaa1d335771da80d6c919d4ab536',
      testedBinary: { build: process.env.AGENTSESSION_V3_BIN ? 'selected binary' : 'local debug verification',
        sha256: binaryHash },
      baselinePortableBinary: { sha256: '9ecca39ce193c841ee2e0ce658995066098b31300be5baceb7140e2bb85029c0', crossProviderBatchStatus: 422 },
      sources: sourceHashes,
      sessionKeyDigests: {
        pi: await digest(`pi\0${piId}`),
        codex: await digest(`codex\0${codexId}`),
        sameIdOtherProvider: await digest(`codex\0${piId}`),
      },
      httpBefore,
      metadataBefore: before,
      actions: observations,
      metadataAfter: observations.at(-1).sqlite,
      providerSourceHashesUnchanged: true,
      legacyMetadataHashUnchanged: true,
      rejectedWrites: { hostileOrigin: 403, nonJson: 415, metadataUnchanged: true },
    };
    await writeFile(process.env.AGENTSESSION_HTTP08_EVIDENCE_PATH, `${JSON.stringify(report, null, 2)}\n`);
  }
});

test('HTTP-08 global batch accepts more than 100 distinct source-backed sessions',
  { timeout: 90_000 }, async t => {
    const { base, piSource, extraPiIds, extraPiSources } = await setup(t, 100);
    const sources = [piSource, ...extraPiSources];
    const hashes = await Promise.all(sources.map(fileDigest));
    const ids = [piId, ...extraPiIds];
    const response = await fetch(`${base}/api/sessions/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ action: 'star', items: ids.map(id => ({ provider: 'pi', id })) }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, affected: 101, skipped: 0 });
    const rows = await (await fetch(`${base}/api/v3/meta?provider=pi`)).json();
    assert.equal(rows.filter(row => ids.includes(row.sessionId) && row.starred).length, 101);
    assert.deepEqual(await Promise.all(sources.map(fileDigest)), hashes);

    const post = (action, batchIds) => fetch(`${base}/api/sessions/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ action, items: batchIds.map(id => ({ provider: 'pi', id })) }),
    });
    assert.equal((await post('unstar', ids)).status, 200);
    assert.equal((await post('star', [...ids.slice(0, 100), 'missing-source'])).status, 404);
    const partial = await (await fetch(`${base}/api/v3/meta?provider=pi`)).json();
    assert.equal(partial.filter(row => ids.includes(row.sessionId) && row.starred).length, 100,
      'the completed first chunk remains committed when the second chunk fails preflight');
    assert.equal(partial.find(row => row.sessionId === ids[100]).starred, false);
    const retry = await post('star', ids);
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { ok: true, affected: 101, skipped: 0 });
    const afterRetry = await (await fetch(`${base}/api/v3/meta?provider=pi`)).json();
    for (const row of partial.filter(row => row.starred)) {
      assert.equal(afterRetry.find(item => item.sessionId === row.sessionId).timeStarred, row.timeStarred,
        'retry preserves timestamps in the previously committed chunk');
    }
    assert.deepEqual(await Promise.all(sources.map(fileDigest)), hashes);
  });
