import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

function assertCapability(actual, expected, message) {
  const { details, ...shape } = actual;
  assert.deepEqual(shape, expected, message);
  if (expected.support !== 'none')
    assert.ok(typeof details === 'string' && details.length > 0,
      message || 'supported capability includes source detail');
}

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const codexId = '44444444-4444-4444-8444-444444444444';
const dshRootId = 'dsh-v3-s2-root';
const codexFixtureRoot = path.join(repo, 'v3', 'fixtures', 'codex');
const codexFixture = path.join(codexFixtureRoot, 'sessions', '2026', '09', '26',
  `rollout-2026-09-26T00-00-00-${codexId}.jsonl`);
const dshFixtureRoot = path.join(repo, 'v3', 'fixtures', 'deepseek-harness');
const dshSources = ['root', 'alpha', 'beta'].map(name => path.join(dshFixtureRoot, 'sessions',
  's2-synthetic', `dsh-v3-s2-${name}`, 'session.v3.jsonl.zstd'));
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

async function freePort() {
  return freeFetchSafePort();
}

async function setup(t) {
  assert.ok(existsSync(binary), `Build the v3 Web binary at ${binary}`);
  await mkdir(path.join(repo, 'tmp'), { recursive: true });
  const dir = await mkdtemp(path.join(repo, 'tmp', 'v3-protocol-events-http-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const claudeDir = path.join(dir, 'claude');
  const claudeTranscript = path.join(claudeDir, 'transcripts', 'legacy-id.jsonl');
  const piDir = path.join(dir, 'pi');
  const piTranscript = path.join(piDir, 'sessions', 'project', 'current.jsonl');
  const metaDir = path.join(dir, 'meta');
  const indexDir = path.join(dir, 'index');
  const cacheDir = path.join(dir, 'cache');
  const opencodeDb = path.join(dir, 'opencode.db');
  const alternateCodexDir = path.join(dir, 'codex-alternate-scope');
  const alternateCodexFixture = path.join(alternateCodexDir, 'sessions', '2026', '09', '26',
    path.basename(codexFixture));

  await Promise.all([
    mkdir(path.dirname(claudeTranscript), { recursive: true }),
    mkdir(path.dirname(piTranscript), { recursive: true }),
    mkdir(metaDir), mkdir(indexDir), mkdir(cacheDir),
    mkdir(path.dirname(alternateCodexFixture), { recursive: true }),
  ]);
  await Promise.all([
    copyFile(path.join(repo, 'test', 'fixtures', 'claude-legacy.jsonl'), claudeTranscript),
    copyFile(path.join(repo, 'test', 'fixtures', 'pi-current.jsonl'), piTranscript),
    copyFile(codexFixture, alternateCodexFixture),
  ]);

  const db = new DatabaseSync(opencodeDb);
  db.exec(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT,
    title TEXT, slug TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER,
    time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
    tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER
  ); CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
    time_created INTEGER, time_updated INTEGER, data TEXT
  );`);
  db.close();

  const args = [
    '--codex-dir', codexFixtureRoot,
    '--opencode-db', opencodeDb,
    '--claude-dir', claudeDir,
    '--pi-dir', piDir,
    '--dsh-dir', dshFixtureRoot,
    '--meta-dir', metaDir,
    '--index-dir', indexDir,
    '--cache-dir', cacheDir,
  ];
  const alternateArgs = args.map((value, index) => index === 1 ? alternateCodexDir : value);
  const sourcePaths = [codexFixture, ...dshSources, claudeTranscript, piTranscript,
    opencodeDb, alternateCodexFixture];
  return { args, alternateArgs, sourcePaths, dir };
}

async function serve(t, args) {
  const port = await freePort();
  const child = spawn(binary, ['serve', '--port', String(port), ...args],
    { cwd: repo, windowsHide: true, stdio: 'ignore' });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null) await once(child, 'close');
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error('v3 Web process exited before readiness');
    try {
      const response = await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return base;
    } catch { /* The process may still be starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('v3 Web process did not become ready');
}

const eventsUrl = (base, provider, sessionId, query = {}) => {
  const url = new URL(`/api/v3/runtime/${provider}/${sessionId}/events`, base);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
};

test('retired published session APIs provide explicit versioned migration diagnostics',
  { timeout: 60_000 }, async t => {
    const f = await setup(t);
    const before = f.sourcePaths.map(sha256);
    const base = await serve(t, f.args);
    const families = [
      ['reader', `reader/codex/${codexId}/bootstrap`],
      ['reader/coordination?taskId=recorded-task&cursor=old-cursor', `runtime/codex/${codexId}/coordination`],
      ['reader/event/old-event', `runtime/codex/${codexId}/events`],
      ['inherited-context?offset=30', `reader/codex/${codexId}/inherited-context`],
      ['context-result?checkpoint=old-checkpoint&offset=1', `runtime/codex/${codexId}/context`],
      ['search?query=source&offset=30', `reader/codex/${codexId}/search`],
      ['protocol', `protocol/codex/${codexId}`],
      ...['summary', 'events', 'graph', 'work', 'execution', 'coordination', 'context']
        .map(domain => [`runtime/${domain}?cursor=old-cursor`, `runtime/codex/${codexId}/${domain}`]),
    ];
    for (const [old, replacement] of families) {
      const response = await fetch(`${base}/api/codex/session/${codexId}/${old}`, { redirect: 'manual' });
      assert.equal(response.status, 410, old);
      assert.equal(response.headers.get('location'), null, 'JSON clients receive a diagnostic, not a redirect');
      const body = await response.json();
      assert.equal(body.error.code, 'http_contract_migrated');
      assert.deepEqual(body.session, { provider: 'codex', sessionId: codexId });
      assert.equal(body.migration.api, `/api/v3/${replacement}`);
      assert.equal(body.migration.page, `/codex/session/${codexId}`);
      assert.equal(body.migration.restartFromFreshRevision, true);
    }
    for (const suffix of ['unknown-route', 'runtime/unknown', 'reader/unknown']) {
      assert.equal((await fetch(`${base}/api/codex/session/${codexId}/${suffix}`)).status, 404);
    }
    assert.equal((await fetch(`${base}/api/hermes/session/old/protocol`)).status, 404);
    const encoded = await fetch(`${base}/api/codex/session/id%20with%2Fslash%25/protocol`);
    assert.equal(encoded.status, 410);
    const body = await encoded.json();
    assert.equal(body.session.sessionId, 'id with/slash%');
    assert.equal(body.migration.api, '/api/v3/protocol/codex/id%20with%2Fslash%25');
    for (const selector of ['phase', 'taskId', 'runId', 'correlationId']) {
      assert.equal((await fetch(eventsUrl(base, 'codex', codexId, { [selector]: 'old' }))).status, 400);
    }
    assert.equal((await fetch(`${base}/api/v3/runtime/codex/${codexId}/graph?depth=2`)).status, 400);
    assert.equal((await fetch(`${base}/api/v3/runtime/codex/${codexId}/work?maxItems=100`)).status, 400);
    assert.equal((await fetch(`${base}/api/v3/protocol/codex/${codexId}`)).status, 200);
    assert.deepEqual(f.sourcePaths.map(sha256), before);
  });

test('public content-search page URLs serve the native UI and reject retired providers',
  { timeout: 60_000 }, async t => {
    const f = await setup(t);
    const base = await serve(t, f.args);
    for (const page of ['/sessions/search?q=recorded', '/codex/search?q=recorded', '/pi/search?q=recorded']) {
      const response = await fetch(base + page);
      assert.equal(response.status, 200, page);
      assert.match(response.headers.get('content-type'), /text\/html/);
      assert.match(await response.text(), /<div id="app">/);
    }
    assert.equal((await fetch(base + '/hermes/search?q=recorded')).status, 404);
  });

test('native cross-provider content search preserves comma scope through complete continuation',
  { timeout: 60_000 }, async t => {
    const f = await setup(t);
    const before = f.sourcePaths.map(sha256);
    const base = await serve(t, f.args);
    const scope = ['codex', 'deepseek-harness'];
    async function collect(provider) {
      const matches = [];
      let cursor;
      do {
        const url = new URL('/api/v3/search', base);
        url.searchParams.set('q', 'a');
        url.searchParams.set('provider', provider);
        url.searchParams.set('limit', '1');
        if (cursor) url.searchParams.set('cursor', cursor);
        const response = await fetch(url);
        assert.equal(response.status, 200, provider);
        const page = await response.json();
        assert.ok(page.matches.length <= 1);
        assert.ok(page.matches.every(match => scope.includes(match.session.provider)));
        matches.push(...page.matches);
        cursor = page.nextCursor;
        assert.ok(matches.length < 100, 'the bounded public fixtures must terminate');
      } while (cursor);
      return matches;
    }
    const combined = await collect(scope.join(','));
    const expected = (await Promise.all(scope.map(collect))).flat();
    assert.ok(expected.some(match => match.session.provider === 'codex'));
    assert.ok(expected.some(match => match.session.provider === 'deepseek-harness'));
    const key = match => JSON.stringify([match.session, match.event, match.matchField, match.snippet]);
    assert.deepEqual(combined.map(key).sort(), expected.map(key).sort());
    assert.equal(new Set(combined.map(key)).size, combined.length);
    assert.deepEqual(f.sourcePaths.map(sha256), before);
  });

test('public Codex and DSH protocol event pages reach Axum with bounded filters and read-only sources',
  { timeout: 60_000 }, async t => {
    const f = await setup(t);
    const before = f.sourcePaths.map(sha256);
    const base = await serve(t, f.args);

    const providers = await (await fetch(`${base}/api/providers`)).json();
    for (const provider of ['codex', 'deepseek-harness', 'claude-code', 'pi', 'opencode']) {
      const status = providers.find(row => row.id === provider);
      assert.equal(status?.available, true,
        `${provider} fixture must be available so protocol unavailability is distinct`);
      assertCapability(status.protocolCapabilities.sessionEvents,
        { support: 'partial', provenance: provider === 'claude-code' ? 'mixed' : 'recorded' },
        `${provider} must advertise the native event route's actual coverage`);
    }

    const codexResponse = await fetch(eventsUrl(base, 'codex', codexId));
    assert.equal(codexResponse.status, 200);
    const codex = await codexResponse.json();
    assert.deepEqual(codex.session, { provider: 'codex', sessionId: codexId });
    assert.equal(codex.coverage, 'partial');
    assert.ok(typeof codex.revision === 'string' && codex.revision.length > 0);
    assert.deepEqual(codex.events.map(event => event.sourceOrder.record), [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(codex.events.map(event => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
    assert.ok(codex.events.every(event => event.provenance.fidelity === 'recorded'
      && event.provenance.sourceType.startsWith('codex.')));
    const codexJson = JSON.stringify(codex);
    for (const payload of [
      'Injected background context, not an owned user request.',
      'Show the complete response and its tool.',
      '/synthetic/example.txt',
      '{"ok":true}',
    ]) assert.equal(codexJson.includes(payload), false, `protocol metadata must not expose ${payload}`);

    const firstToolsResponse = await fetch(eventsUrl(base, 'codex', codexId,
      { category: 'tool', limit: 1 }));
    assert.equal(firstToolsResponse.status, 200);
    const firstTools = await firstToolsResponse.json();
    assert.equal(firstTools.events.length, 1);
    assert.equal(firstTools.events[0].kind, 'tool.call');
    assert.ok(firstTools.nextCursor);
    const secondToolsResponse = await fetch(eventsUrl(base, 'codex', codexId,
      { category: 'tool', limit: 1, cursor: firstTools.nextCursor }));
    assert.equal(secondToolsResponse.status, 200);
    const secondTools = await secondToolsResponse.json();
    assert.equal(secondTools.events[0].kind, 'tool.result');
    assert.ok(secondTools.nextCursor, 'continuation must scan the trailing usage record');
    const afterTools = await fetch(eventsUrl(base, 'codex', codexId,
      { category: 'tool', limit: 1, cursor: secondTools.nextCursor }));
    assert.equal(afterTools.status, 200);
    const afterToolsPage = await afterTools.json();
    assert.deepEqual(afterToolsPage.events, []);
    assert.equal(afterToolsPage.nextCursor, null);

    const changedFilter = await fetch(eventsUrl(base, 'codex', codexId,
      { category: 'message', limit: 1, cursor: firstTools.nextCursor }));
    assert.equal(changedFilter.status, 400);
    assert.equal((await changedFilter.json()).error.code, 'invalid_cursor');
    const badCursor = await fetch(eventsUrl(base, 'codex', codexId,
      { cursor: 'not-a-cursor' }));
    assert.equal(badCursor.status, 400);
    assert.equal((await badCursor.json()).error.code, 'invalid_cursor');
    const badLimit = await fetch(eventsUrl(base, 'codex', codexId, { limit: 0 }));
    assert.equal(badLimit.status, 400);
    assert.equal((await badLimit.json()).error.code, 'invalid_request');
    assert.equal((await fetch(eventsUrl(base, 'codex', codexId, { limit: 'invalid' }))).status, 400);
    assert.equal((await fetch(eventsUrl(base, 'codex', codexId, { extra: 'unsupported' }))).status, 400);

    const missing = await fetch(eventsUrl(base, 'codex', 'missing-session'));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'session_not_found');

    const claudeResponse = await fetch(eventsUrl(base, 'claude-code', 'legacy-id'));
    assert.equal(claudeResponse.status, 200);
    const claude = await claudeResponse.json();
    assert.deepEqual(claude.session, { provider: 'claude-code', sessionId: 'legacy-id' });
    assert.equal(claude.coverage, 'partial');
    assert.ok(claude.events.length > 0);
    assert.ok(claude.events.every(event => event.provenance.fidelity === 'recorded'
      && event.provenance.sourceType.startsWith('claude.')));
    assert.equal(JSON.stringify(claude).includes('Legacy first prompt'), false);
    const missingClaude = await fetch(eventsUrl(base, 'claude-code', 'missing-session'));
    assert.equal(missingClaude.status, 404);
    assert.equal((await missingClaude.json()).error.code, 'session_not_found');

    const dshResponse = await fetch(eventsUrl(base, 'deepseek-harness', dshRootId));
    assert.equal(dshResponse.status, 200);
    const dsh = await dshResponse.json();
    assert.deepEqual(dsh.session, { provider: 'deepseek-harness', sessionId: dshRootId });
    assert.equal(dsh.coverage, 'partial');
    assert.ok(dsh.events.length > 0);
    assert.ok(dsh.events.every(event => event.provenance.fidelity === 'recorded'
      && event.provenance.sourceType.startsWith('dsh.')));
    const dshJson = JSON.stringify(dsh);
    assert.equal(dshJson.includes('SYNTHETIC-MARKER-OK'), false);
    assert.equal(dshJson.includes('END-OF-SYNTHETIC-DSH-ROOT'), false);
    assert.deepEqual(dsh.events.map(event => event.sourceOrder.record),
      [...dsh.events.map(event => event.sourceOrder.record)].sort((a, b) => a - b));
    assert.ok(dsh.events.some(event => event.kind === 'team.message.queued'));
    const queuedResponse = await fetch(eventsUrl(base, 'deepseek-harness', dshRootId,
      { category: 'coordination', kind: 'team.message.queued', limit: 1 }));
    assert.equal(queuedResponse.status, 200);
    const queued = await queuedResponse.json();
    assert.equal(queued.events.length, 1);
    assert.equal(queued.events[0].kind, 'team.message.queued');
    assert.ok(queued.nextCursor);
    const queuedContinuation = await fetch(eventsUrl(base, 'deepseek-harness', dshRootId,
      { category: 'coordination', kind: 'team.message.queued', limit: 1, cursor: queued.nextCursor }));
    assert.equal(queuedContinuation.status, 200);
    assert.equal((await queuedContinuation.json()).events[0].kind, 'team.message.queued');

    const otherScopeBase = await serve(t, f.alternateArgs);
    const foreignScopeCursor = await fetch(eventsUrl(otherScopeBase, 'codex', codexId,
      { category: 'tool', limit: 1, cursor: firstTools.nextCursor }));
    assert.equal(foreignScopeCursor.status, 400);
    assert.equal((await foreignScopeCursor.json()).error.code, 'invalid_cursor');

    assert.deepEqual(f.sourcePaths.map(sha256), before,
      'HTTP protocol reads must leave every Codex, DSH, and unsupported-provider source byte-identical');
  });

test('Codex protocol event stream reports an invalid interior source record',
  { timeout: 30_000 }, async t => {
    const f = await setup(t);
    const copiedCodex = f.sourcePaths.at(-1);
    const rows = readFileSync(copiedCodex, 'utf8').trimEnd().split('\n');
    rows.splice(1, 0, '{not-json}');
    await writeFile(copiedCodex, `${rows.join('\n')}\n`);
    const before = sha256(copiedCodex);
    const base = await serve(t, f.alternateArgs);
    const response = await fetch(eventsUrl(base, 'codex', codexId));
    assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'protocol_invalid');
  assert.equal(sha256(copiedCodex), before);
});

test('protocol capability declarations match event, document, and Work surfaces for five providers',
  { timeout: 60_000 }, async t => {
    const f = await setup(t);

    // Use a temporary Codex copy with recorded facts for every currently
    // implemented observation domain. The public fixture remains untouched.
    const codexRoot = path.join(f.dir, 'codex-capabilities');
    const codexPath = path.join(codexRoot, 'sessions', '2026', '09', '26',
      path.basename(codexFixture));
    await mkdir(path.dirname(codexPath), { recursive: true });
    const codexRows = readFileSync(codexFixture, 'utf8').trimEnd().split('\n')
      .map(line => JSON.parse(line));
    codexRows[0].payload.source = { subagent: { thread_spawn: {
      parent_thread_id: 'capability-parent', call_id: 'capability-spawn',
    } } };
    codexRows.push(
      { timestamp: '2026-09-26T00:00:07.000Z', ordinal: 7, type: 'response_item', payload: {
        type: 'agent_message', id: 'capability-task', content: [{ type: 'text',
          text: 'Message Type: NEW_TASK\nTask name: capability worker' }],
      } },
      { timestamp: '2026-09-26T00:00:08.000Z', ordinal: 8, type: 'event_msg', payload: {
        type: 'task_started', turn_id: 'capability-turn', started_at: 100,
      } },
      { timestamp: '2026-09-26T00:00:09.000Z', ordinal: 9, type: 'event_msg', payload: {
        type: 'task_complete', turn_id: 'capability-turn', started_at: 100, completed_at: 110,
      } },
    );
    await writeFile(codexPath, `${codexRows.map(row => JSON.stringify(row)).join('\n')}\n`);
    f.args[f.args.indexOf('--codex-dir') + 1] = codexRoot;

    // The existing OpenCode setup creates a valid empty v2 database. Add one
    // native session so its event capability is checked against real output.
    const opencodeDb = f.sourcePaths.at(-2);
    const db = new DatabaseSync(opencodeDb);
    db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'opencode-capability', null, null, null, 'Capability', 'capability', '/synthetic',
      1, 2, null, 0, 0, 0, 0, 0,
    );
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run(
      'opencode-user', 'opencode-capability', 'user', 1, 1, 1,
      JSON.stringify({ text: 'OpenCode capability fixture' }),
    );
    db.close();

    const beforeSources = [...f.sourcePaths, codexPath].map(sha256);
    const base = await serve(t, f.args);
    const providers = await (await fetch(`${base}/api/providers`)).json();
    const fixtures = [
      { id: 'opencode', session: 'opencode-capability', sourcePrefix: 'opencode.' },
      { id: 'claude-code', session: 'legacy-id', sourcePrefix: 'claude.' },
      { id: 'codex', session: codexId, sourcePrefix: 'codex.' },
      { id: 'pi', session: '019f7b00-0000-7000-8000-000000000001', sourcePrefix: 'pi.' },
      { id: 'deepseek-harness', session: 'dsh-v3-s2-alpha', sourcePrefix: 'dsh.' },
    ];
    const unknown = { support: 'none', provenance: 'unknown' };
    const partialRecorded = { support: 'partial', provenance: 'recorded' };
    const partialMixed = { support: 'partial', provenance: 'mixed' };

    for (const fixture of fixtures) {
      const status = providers.find(provider => provider.id === fixture.id);
      assert.equal(status?.available, true, `${fixture.id} public fixture must be available`);
      assertCapability(status.protocolCapabilities.sessionEvents, fixture.id === 'claude-code' ? partialMixed : partialRecorded,
        `${fixture.id} advertises the native event stream it actually returns`);

      const eventsResponse = await fetch(eventsUrl(base, fixture.id, fixture.session));
      assert.equal(eventsResponse.status, 200, `${fixture.id} native events must be readable`);
      const events = await eventsResponse.json();
      assert.ok(events.events.length > 0, `${fixture.id} fixture has native events`);
      assert.equal(events.coverage, 'partial');
      assert.ok(events.events.every(event => event.provenance.fidelity === 'recorded'
        && event.provenance.sourceType.startsWith(fixture.sourcePrefix)),
      `${fixture.id} event capability is backed by provider-owned provenance`);

      const documentResponse = await fetch(new URL(
        `/api/v3/protocol/${fixture.id}/${fixture.session}?version=3`, base));
      const workResponse = await fetch(new URL(
        `/api/v3/runtime/${fixture.id}/${fixture.session}/work`, base));
      if (fixture.id === 'deepseek-harness' || fixture.id === 'pi' || fixture.id === 'claude-code' || fixture.id === 'opencode') {
        const hasParent = fixture.id === 'deepseek-harness' || fixture.id === 'pi';
        const supportsRecordedRelationships = ['deepseek-harness', 'opencode', 'claude-code']
          .includes(fixture.id);
        assertCapability(status.protocolCapabilities.sessionRelationships,
          fixture.id === 'pi' ? { support: 'partial', provenance: 'derived' }
            : supportsRecordedRelationships ? { support: 'partial', provenance: 'recorded' } : unknown);
        for (const domain of ['tasks', 'agentRuns', 'contextArtifacts', 'branches']) {
          if ((fixture.id === 'deepseek-harness' || fixture.id === 'opencode') && domain === 'tasks') {
            assertCapability(status.protocolCapabilities[domain], { support: 'partial', provenance: 'recorded' });
            continue;
          }
          if (fixture.id === 'pi' && domain === 'branches') {
            assertCapability(status.protocolCapabilities[domain], { support: 'partial', provenance: 'derived' });
            continue;
          }
          assertCapability(status.protocolCapabilities[domain], unknown);
        }
        assert.equal(documentResponse.status, 200);
        assert.equal(workResponse.status, 200);
        const document = await documentResponse.json();
        const work = await workResponse.json();
        assert.equal(document.validation.ok, true);
        assert.equal(document.completeness, 'partial');
        assert.equal(document.relationships.length, hasParent ? 1 : 0);
        if (hasParent) {
          assert.equal(document.relationships[0].kind, 'parent');
          assert.equal(document.relationships[0].evidence.provenance.fidelity,
            fixture.id === 'pi' ? 'derived' : 'recorded');
        }
        assert.equal(document.coverage.relationships.state,
          hasParent ? 'observed' : fixture.id === 'opencode' ? 'not-observed' : 'unknown');
        assert.equal(document.coverage.work.state, 'unknown');
        assert.deepEqual(document.tasks, []);
        assert.deepEqual(document.agentRuns, []);
        assert.deepEqual(work.entries, []);
        assert.equal(work.revision, document.revision);
        assert.equal(work.coverage, 'partial');
        continue;
      }
      for (const [domain, expected] of Object.entries({
        sessionRelationships: partialMixed,
        tasks: partialRecorded,
        agentRuns: partialRecorded,
        contextArtifacts: partialRecorded,
        branches: unknown,
      })) {
        assertCapability(status.protocolCapabilities[domain], expected,
          `Codex ${domain} capability must describe its provider adapter`);
      }
      assert.equal(documentResponse.status, 200);
      assert.equal(workResponse.status, 200);
      const document = await documentResponse.json();
      const work = await workResponse.json();
      assert.equal(document.validation.ok, true);
      assert.ok(document.events.length > 0);
      assert.ok(document.events.every(event => event.provenance.fidelity === 'recorded'
        && event.provenance.sourceType.startsWith('codex.')));
      assert.ok(document.relationships.length > 0);
      assert.ok(document.tasks.length > 0);
      assert.ok(document.agentRuns.length > 0);
      assert.equal(document.coverage.relationships.state, 'observed');
      assert.equal(document.coverage.tasks.state, 'observed');
      assert.equal(document.coverage.agentRuns.state, 'observed');
      assert.equal(document.contextArtifacts.length, 0);
      assert.equal(document.branches.length, 0);
      assert.equal(document.relationships[0].evidence.provenance.fidelity, 'recorded');
      assert.ok(document.tasks.every(task => task.evidence.provenance.fidelity === 'recorded'));
      assert.ok(document.agentRuns.every(run => run.evidence.provenance.fidelity === 'recorded'));
      assert.ok(work.entries.some(entry => entry.type === 'task'));
      assert.ok(work.entries.some(entry => entry.type === 'agentRun'));
      assert.ok(work.entries.every(entry => entry.evidence.provenance.fidelity === 'recorded'
        && entry.evidence.provenance.sourceType.startsWith('codex.')));
    }

    assert.deepEqual([...f.sourcePaths, codexPath].map(sha256), beforeSources,
      'provider-owned public fixtures remain byte-identical');
  });
