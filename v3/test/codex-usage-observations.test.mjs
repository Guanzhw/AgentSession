import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const fixtureDirectory = path.join(repo, 'v3', 'fixtures');
const mixedFixture = path.join(fixtureDirectory, 'codex-usage-observations-mixed.jsonl');
const legacyFixture = path.join(fixtureDirectory, 'codex-usage-observations-legacy-only.jsonl');
const mixedSession = '90111111-1111-4111-8111-111111111111';
const legacySession = '90222222-2222-4222-8222-222222222222';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function agentBrowserBinary() {
  const name = process.platform === 'win32' ? 'agent-browser-win32-x64.exe' :
    `agent-browser-${process.platform}-${process.arch}`;
  return process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
    (process.env.PATH || '').split(path.delimiter)
      .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', name))
      .find(existsSync);
}

async function browserCommand(binary, session, downloadDirectory, ...args) {
  const child = spawn(binary, ['--session', session, ...args], {
    cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_BROWSER_DOWNLOAD_PATH: downloadDirectory },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, output.slice(0, 1000));
  return output.trim();
}

async function serve(t, fixturePaths, options = {}) {
  assert.ok(existsSync(binary), 'build the v3 debug binary before this test');
  const fixtureHashes = fixturePaths.map(file => [file, sha(readFileSync(file))]);
  await mkdir(path.join(repo, 'tmp'), { recursive: true });
  const work = await mkdtemp(path.join(repo, 'tmp', 'v3-codex-usage-observation-'));
  const dirs = Object.fromEntries(['codex', 'pi', 'claude', 'dsh', 'meta', 'index', 'cache']
    .map(name => [name, path.join(work, name)]));
  await Promise.all(Object.values(dirs).map(directory => mkdir(directory)));
  const sessionDirectory = path.join(dirs.codex, 'sessions', '2026', '09', '29');
  await mkdir(sessionDirectory, { recursive: true });
  const copiedFiles = [];
  for (const fixturePath of fixturePaths) {
    const fixture = readFileSync(fixturePath, 'utf8');
    const first = JSON.parse(fixture.split(/\r?\n/, 1)[0]);
    const sessionId = first.payload.id;
    const destination = path.join(sessionDirectory,
      'rollout-2026-09-29T00-00-00-' + sessionId + '.jsonl');
    const source = options.dateOverride
      ? fixture.replaceAll('2026-09-29', options.dateOverride)
      : fixture;
    await writeFile(destination, source);
    copiedFiles.push([destination, sha(readFileSync(destination))]);
  }
  const port = await freeFetchSafePort();
  const args = ['serve', '--port', String(port),
    '--codex-dir', dirs.codex, '--pi-dir', dirs.pi, '--claude-dir', dirs.claude,
    '--dsh-dir', dirs.dsh, '--opencode-db', path.join(work, 'missing.db'),
    '--meta-dir', dirs.meta, '--index-dir', dirs.index, '--cache-dir', dirs.cache];
  const child = spawn(binary, args, {
    cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    try {
      child.kill();
      if (child.exitCode === null && child.signalCode === null) await once(child, 'close');
      for (const [file, digest] of fixtureHashes) assert.equal(sha(readFileSync(file)), digest);
      for (const [file, digest] of copiedFiles) assert.equal(sha(readFileSync(file)), digest);
    } finally {
      const resolved = path.resolve(work);
      assert.equal(path.dirname(resolved), path.resolve(repo, 'tmp'));
      assert.ok(path.basename(resolved).startsWith('v3-codex-usage-observation-'));
      await rm(resolved, { recursive: true, force: true });
    }
  });
  const base = 'http://127.0.0.1:' + port;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(base + '/api/providers', { signal: AbortSignal.timeout(500) })).ok)
        return { base, work };
    } catch { /* server startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('Codex usage-observation server did not start: ' + stderr.slice(0, 500));
}

async function getProtocol(base, sessionId) {
  const response = await fetch(base + '/api/v3/protocol/codex/' + sessionId + '?version=3');
  assert.equal(response.status, 200, 'HTTP ' + response.status);
  const document = await response.json();
  assert.equal(document.validation.ok, true);
  return document;
}

const statsQuery = new URLSearchParams({
  days: 'custom', from: '2026-09-29', to: '2026-09-29',
});
const statsUrl = (base, query = statsQuery) => base + '/api/v3/stats/codex?' + query;
const exportUrl = (base, query = statsQuery) => base + '/api/v3/stats/codex/export.csv?' + query;

function parseCsvRow(line) {
  return line.split(',').map(cell =>
    cell.startsWith('"') && cell.endsWith('"')
      ? cell.slice(1, -1).replaceAll('""', '"')
      : cell);
}

test('Codex separates unresolved legacy occurrences from proved requests',
  { timeout: 30_000 }, async t => {
    const f = await serve(t, [mixedFixture]);
    const document = await getProtocol(f.base, mixedSession);

    assert.deepEqual(document.usageRecords.map(record => record.provenance.sourceId),
      ['proved-response-a', 'proved-response-b']);
    assert.deepEqual(document.usageRecords.map(record => record.tokens.total), [130, 130]);
    assert.ok(Array.isArray(document.usageObservations),
      'v3 must publish unresolved usage occurrences separately from request records');
    const observations = document.usageObservations;
    assert.equal(observations.length, 4,
      'every anonymous source occurrence survives, including repeated equal snapshots');
    assert.equal(new Set(observations.map(item => item.id)).size, 4,
      'each unresolved source occurrence has its own identity');
    assert.deepEqual(observations.map(item => item.provenance.sourceType),
      Array(4).fill('codex.event_msg:token_count'));
    assert.deepEqual(observations.map(item => item.tokens.total), [130, 130, 130, 9]);
    assert.deepEqual(observations.map(item => item.cumulativeTokens?.total), [130, 130, 260, 9]);
    assert.ok(observations.every(item => item.provenance.fidelity === 'recorded'));
    assert.equal(document.coverage.usage.state, 'observed');

    const reportResponse = await fetch(statsUrl(f.base));
    assert.equal(reportResponse.status, 200, await reportResponse.clone().text());
    const report = await reportResponse.json();
    assert.equal(report.overview.recordedRequestCount, 2,
      'Stats totals continue to count only the proved response records');
    assert.equal(report.overview.unresolvedUsageObservationCount, 4);
    const session = report.sessions.find(row => row.session.sessionId === mixedSession);
    assert.equal(session.unresolvedUsageObservationCount, 4);
    assert.equal(report.dailyUsage[0].unresolvedUsageObservationCount, 4);
    const csvResponse = await fetch(exportUrl(f.base));
    const [header, values] = (await csvResponse.text()).trimEnd().split(/\r?\n/).map(parseCsvRow);
    const columns = Object.fromEntries(header.map((name, index) => [name, index]));
    assert.equal(values[columns['Unresolved Usage Observation Count']], '4');

    const endpoint = new URL('/api/v3/runtime/codex/' + mixedSession + '/execution', f.base);
    endpoint.searchParams.set('kind', 'unresolved-usage');
    endpoint.searchParams.set('limit', '2');
    const first = await (await fetch(endpoint)).json();
    assert.deepEqual(first.entries.map(entry => entry.fact.id), observations.slice(0, 2).map(item => item.id));
    assert.ok(first.nextCursor);
    endpoint.searchParams.set('cursor', first.nextCursor);
    const second = await (await fetch(endpoint)).json();
    assert.deepEqual(second.entries.map(entry => entry.fact.id), observations.slice(2).map(item => item.id));
    assert.equal(second.nextCursor, null);
    assert.ok([...first.entries, ...second.entries].every(entry =>
      entry.type === 'usageObservation' && Number.isInteger(entry.sourceOrder.record)));

    const listed = await (await fetch(f.base + '/api/v3/sessions?provider=codex')).json();
    assert.equal(listed.find(item => item.session.sessionId === mixedSession)?.tokenCount, 260);
  });

test('Stats JSON and CSV retain legacy consumption without claiming request identity',
  { timeout: 30_000 }, async t => {
    const f = await serve(t, [legacyFixture]);
    const listed = await (await fetch(f.base + '/api/v3/sessions?provider=codex')).json();
    assert.equal(listed.find(item => item.session.sessionId === legacySession)?.tokenCount, 9);
    const response = await fetch(statsUrl(f.base));
    assert.equal(response.status, 200, await response.clone().text());
    const report = await response.json();
    assert.equal(report.usageCoverage, 'partial');
    assert.equal(report.overview.unresolvedUsageObservationCount, 1);
    assert.equal(report.overview.recordedRequestCount, 0);
    assert.equal(report.overview.knownTokenCount, 9);
    assert.equal(report.overview.totalTokens, null);
    assert.equal(report.sessions.length, 1);
    assert.equal(report.sessions[0].recordedRequestCount, 0);
    assert.equal(report.sessions[0].tokenCount, null);
    assert.equal(report.dailyUsage.length, 1);
    assert.equal(report.dailyUsage[0].unresolvedUsageObservationCount, 1);
    assert.equal(report.dailyUsage[0].recordedRequestCount, 0);
    assert.equal(report.dailyUsage[0].totalTokens, 9);
    assert.equal(report.modelRanking[0].knownTokenCount, 9);
    assert.equal(report.sessions[0].unresolvedUsageObservationCount, 1);

    const drillQuery = new URLSearchParams(statsQuery);
    drillQuery.set('day', '2026-09-29');
    const drilled = await (await fetch(statsUrl(f.base, drillQuery))).json();
    assert.equal(drilled.dailyUsage[0].sessions.length, 1);
    assert.equal(drilled.dailyUsage[0].sessions[0].unresolvedUsageObservationCount, 1);

    for (const [label, filter] of [
      ['model', { model: 'synthetic-legacy-model' }],
      ['directory', { directory: '/synthetic/legacy-only' }],
      ['model and directory', { model: 'synthetic-legacy-model', directory: '/synthetic/legacy-only' }],
    ]) {
      const filteredQuery = new URLSearchParams(statsQuery);
      for (const [key, value] of Object.entries(filter)) filteredQuery.set(key, value);
      const filtered = await (await fetch(statsUrl(f.base, filteredQuery))).json();
      assert.equal(filtered.overview.unresolvedUsageObservationCount, 1, label);
      assert.equal(filtered.overview.recordedRequestCount, 0, label);
      assert.equal(filtered.overview.knownTokenCount, 9, label);
      assert.equal(filtered.sessions[0].unresolvedUsageObservationCount, 1, label);
    }

    const outsideDate = new URLSearchParams({ days: 'custom', from: '2026-09-30', to: '2026-09-30' });
    const outside = await (await fetch(statsUrl(f.base, outsideDate))).json();
    assert.equal(outside.overview.unresolvedUsageObservationCount, 0,
      'observations outside the selected UTC date range are excluded');

    const csvResponse = await fetch(exportUrl(f.base));
    assert.equal(csvResponse.status, 200);
    const [header, ...rows] = (await csvResponse.text()).trimEnd().split(/\r?\n/).map(parseCsvRow);
    const columns = Object.fromEntries(header.map((name, index) => [name, index]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0][columns.Coverage], report.coverage);
    assert.equal(rows[0][columns['Usage Coverage']], 'partial');
    assert.equal(rows[0][columns['Unresolved Usage Observation Count']], '1');
    assert.equal(rows[0][columns.Requests], '0');
    assert.equal(rows[0][columns['Total Tokens']], '9');
  });

test('Stats recaptures a version-5 cache row that counted anonymous legacy usage',
  { timeout: 30_000 }, async t => {
    const f = await serve(t, [legacyFixture]);
    const first = await fetch(statsUrl(f.base));
    assert.equal(first.status, 200, await first.clone().text());

    const cacheFile = (await readdir(path.join(f.work, 'cache')))
      .find(name => name.endsWith('.stats-v2.sqlite'));
    assert.ok(cacheFile, 'Codex Stats writes its source-scoped usage cache');
    const database = new DatabaseSync(path.join(f.work, 'cache', cacheFile));
    const cached = database.prepare(
      'SELECT session_id FROM stats_usage WHERE provider = ?').get('codex');
    assert.equal(cached?.session_id, legacySession);
    const oldLegacyRow = JSON.stringify([{
      session_ref: { provider: 'codex', sessionId: legacySession },
      timestamp: Date.parse('2026-09-29T12:00:03.000Z'),
      model: 'synthetic-legacy-model',
      model_provider: null,
      event_id: null,
      tokens: {
        input: 6, cache_read: 1, cache_write: 0, output: 2, reasoning: 0, total: 9,
      },
    }]);
    database.prepare('UPDATE stats_usage SET projection_version = 5, usage_json = ? ' +
      'WHERE provider = ? AND session_id = ?').run(oldLegacyRow, 'codex', legacySession);
    database.close();

    const response = await fetch(statsUrl(f.base));
    assert.equal(response.status, 200, await response.clone().text());
    const report = await response.json();
    assert.equal(report.overview.recordedRequestCount, 0,
      'an old Stats projection must not restore an unresolved legacy row as a request');
    assert.equal(report.overview.unresolvedUsageObservationCount, 1);
    assert.equal(report.overview.totalTokens, null);
    assert.equal(report.usageCoverage, 'partial');

    const refreshed = new DatabaseSync(path.join(f.work, 'cache', cacheFile));
    const current = refreshed.prepare('SELECT projection_version, usage_json FROM stats_usage ' +
      'WHERE provider = ? AND session_id = ?').get('codex', legacySession);
    assert.ok(current.projection_version > 5, 'the v5 row is replaced by the current projection');
    const projection = JSON.parse(current.usage_json);
    assert.equal(projection.requests.length, 1);
    assert.equal(projection.requests[0].recorded_request, false);
    assert.equal(projection.requests[0].tokens.total, 9);
    assert.equal(projection.observations.length, 1,
      'the upgraded projection retains the unresolved occurrence for filtered Stats reads');
    refreshed.close();
  });

test('Stats browser shows unresolved occurrences separately from proved requests',
  { skip: !agentBrowserBinary(), timeout: 60_000 }, async t => {
    const f = await serve(t, [mixedFixture], { dateOverride: '2026-09-27' });
    const browser = agentBrowserBinary();
    const session = `as-v3-usage-observations-${process.pid}-${Date.now()}`;
    const downloads = path.join(f.work, 'downloads');
    await mkdir(downloads);
    const report = await (await fetch(f.base + '/api/v3/stats/codex?days=30')).json();
    const model = report.availableModels.find(option => option.model === 'synthetic-model');
    assert.ok(model, 'mixed fixture exposes a proved request model for the filter check');
    const modelKey = JSON.stringify([model.modelProvider ?? null, model.model]);
    t.after(async () => {
      try { await browserCommand(browser, session, downloads, 'close'); }
      catch { /* Browser already closed. */ }
    });
    await browserCommand(browser, session, downloads, 'open', `${f.base}/codex/stats`);
    await browserCommand(browser, session, downloads, 'wait', '--load', 'networkidle');
    const pageText = async () => browserCommand(browser, session, downloads,
      'get', 'text', '.stats-page');
    assert.match(await pageText(), /4 usage observation\(s\).*no proved request identity|4.*用量记录.*请求身份/);
    await browserCommand(browser, session, downloads,
      'select', 'select[aria-label="Request model"]', modelKey);
    await browserCommand(browser, session, downloads, 'wait', '--load', 'networkidle');
    const filteredPage = await pageText();
    assert.match(filteredPage,
      /4 usage observation\(s\).*no proved request identity|4.*用量记录.*请求身份/);
    assert.match(filteredPage,
      /model filter narrows attributed requests and token consumption|模型筛选作用于有归属的请求和 Token 用量/);
    await browserCommand(browser, session, downloads,
      'click', '.statistics-details > summary');
    assert.match(await pageText(),
      /2 requests · 4 unresolved observations|2 个请求 · 4 个未解析观察/);
  });
