import { onCleanup, temporaryDirectory } from '../../test/helpers/fixture-cleanup.mjs';
import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { decodeSourceBytes } from '../../scripts/v3-source-ledger.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');

async function fixture(t) {
  const root = await temporaryDirectory(t, path.join(os.tmpdir(), 'as-v3-stats-'));
  const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']
    .map(name => [name, path.join(root, name)]));
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
  await mkdir(path.join(dirs.codex, 'sessions'));
  const file = path.join(root, 'opencode.db');
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT,
      fork_boundary TEXT, title TEXT, slug TEXT, directory TEXT, time_created INTEGER,
      time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
      tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT);
      INSERT INTO session_v2 VALUES
        ('root',NULL,NULL,NULL,'Root','root','/synthetic',1,3,NULL,5000,7000,0,0,0),
        ('child','root',NULL,NULL,'Child','child','/synthetic',2,3,NULL,9000,2000,0,0,0),
        ('archived',NULL,NULL,NULL,'Archived','archived','/synthetic',1,3,3,100,100,0,0,0);
      INSERT INTO session_message VALUES
        ('u','root','user',1,1789776000000,1789776000000,'{"text":"SECRET_PROMPT"}'),
        ('a','root','assistant',2,1789776001000,1789776001000,'{"content":[{"type":"text","text":"SECRET_ANSWER"}],"tokens":{"input":12,"output":4,"reasoning":3,"cache":{"read":5,"write":2},"total":26}}'),
        ('b','root','assistant',3,1789862401000,1789862401000,'{"content":[],"tokens":{"input":5,"output":1,"reasoning":1,"cache":{"read":2,"write":1},"total":50}}'),
        ('c','child','user',1,1789862400000,1789862400000,'{"text":"SECRET_CHILD"}'),
        ('d','child','assistant',2,1789862402000,1789862402000,'{"content":[],"tokens":{"input":3,"output":2,"reasoning":0,"cache":{"read":1,"write":0},"total":6}}'),
        ('x','archived','assistant',1,1789862403000,1789862403000,'{"text":"SECRET_ARCHIVED","tokens":{"input":100,"output":100,"reasoning":0,"cache":{"read":0,"write":0},"total":200}}');`);
  } finally {
    db.close();
  }
  const args = ['--opencode-db', file, '--codex-dir', dirs.codex,
    '--claude-dir', dirs.claude, '--pi-dir', dirs.pi, '--dsh-dir', dirs.dsh,
    '--meta-dir', dirs.meta, '--index-dir', dirs.index, '--cache-dir', dirs.cache];
  return { root, file, args, t };
}

function agentBrowserBinary() {
  const name = process.platform === 'win32' ? 'agent-browser-win32-x64.exe' :
    `agent-browser-${process.platform}-${process.arch}`;
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(entry, 'node_modules', 'agent-browser', 'bin', name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function browserCommand(binary, session, downloadDir, ...args) {
  const child = spawn(binary, ['--session', session, ...args],
    { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENT_BROWSER_DOWNLOAD_PATH: downloadDir } });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, output.slice(0, 1000));
  return output.trim();
}

async function serve(f, options = {}) {
  assert.ok(existsSync(binary), `missing v3 binary: ${binary}`);
  const port = await freeFetchSafePort();
  const child = spawn(binary, ['serve', '--port', String(port), ...f.args],
    { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env } });
  onCleanup(f.t, async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill(); await closed;
    }
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data.toString(); });
  f.stderr = () => stderr;
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(base + '/api/providers')).ok) return base; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`server did not start: ${stderr.slice(0, 500)}`);
}

test('multi-Harness stats preserve filtered totals, source coverage, day identities and exports',
  { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    await copyFile(path.join(repo, 'v3/fixtures/codex/sessions/2026/09/26/rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl'), path.join(f.root, 'codex/sessions/sample.jsonl'));
    const base = await serve(f);
    const range = 'days=custom&from=2026-09-01&to=2026-09-30';
    const [left, right, combined] = await Promise.all(['opencode', 'codex', 'all'].map(async provider => {
      const response = await fetch(`${base}/api/v3/stats/${provider}?${range}${provider === 'all' ? '&providers=opencode,codex' : ''}`);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    }));
    for (const field of ['totalSessions', 'recordedRequestCount', 'knownTokenCount', 'unknownTokenRequestCount', 'unresolvedUsageObservationCount']) {
      assert.equal(combined.overview[field], left.overview[field] + right.overview[field], field);
    }
    assert.equal(combined.overview.totalTokens, null);
    assert.deepEqual(combined.sources.map(row => row.provider), ['opencode', 'codex']);
    assert.ok(combined.sources.every(row => row.status === 'readable'));
    assert.equal(combined.insights.selectedDays, 30);
    assert.equal(combined.insights.recentWeekTo, '2026-09-30');
    const selected = await (await fetch(`${base}/api/v3/stats/all?${range}&providers=codex`)).json();
    assert.deepEqual(selected.overview, right.overview);
    const day = combined.dailyUsage.find(row => row.recordedRequestCount > 0).day;
    const drill = await (await fetch(`${base}/api/v3/stats/all?${range}&providers=opencode,codex&day=${day}`)).json();
    assert.equal(drill.revision, combined.revision);
    assert.ok(drill.dailyUsage[0].sessions.every(row => ['codex', 'opencode'].includes(row.session.provider)));
    const json = await (await fetch(`${base}/api/v3/stats/all/export.json?${range}&providers=codex`)).json();
    assert.deepEqual(json.overview, right.overview);
    const csv = await (await fetch(`${base}/api/v3/stats/all/export.csv?${range}&providers=codex`)).text();
    assert.match(csv.split('\n')[0], /Selected Harnesses,Source Status$/);
    assert.ok(csv.includes('"codex","codex: readable"'));
    assert.equal((await fetch(`${base}/api/v3/stats/all?providers=not-a-provider`)).status, 400);
    assert.equal((await fetch(`${base}/api/v3/stats/all?providers=`)).status, 400);
    assert.equal((await fetch(`${base}/api/v3/stats/all?providers=codex,opencode&project=abc`)).status, 400);
  });

test('stats API and daily export use owned request records, not summary totals or archived rows',
  { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    const before = sha(f.file);
    const base = await serve(f);
    const api = await fetch(`${base}/api/v3/stats/opencode`);
    assert.equal(api.status, 200, api.status === 200 ? undefined : await api.text());
    const report = await api.json();
    assert.equal(report.provider, 'opencode');
    assert.equal(report.scope, 'active_source_sessions');
    assert.equal(report.coverage, 'partial');
    assert.equal(report.overview.totalSessions, 2);
    assert.equal(report.overview.excludedSourceSessionCount, 0);
    assert.deepEqual(report.sourceDiagnostics, []);
    assert.equal(report.overview.totalMessages, 5);
    assert.equal(report.overview.totalTokens, null);
    assert.equal(report.overview.recordedRequestCount, 3);
    assert.equal(report.overview.knownTokenCount, 32);
    assert.equal(report.overview.unknownTokenRequestCount, 1);
    assert.equal(report.overview.unresolvedUsageObservationCount, 0);
    assert.equal(report.usageCoverage, 'partial');
    assert.deepEqual(report.sessions.map(row => [row.session.sessionId, row.messageCount,
      row.tokenCount, row.recordedRequestCount, row.knownTokenCount]).sort(),
    [['child', 2, null, 1, 6], ['root', 3, null, 2, 26]]);
    assert.equal(report.dailyUsage.length, 30);
    assert.deepEqual(report.dailyUsage.filter(day => day.recordedRequestCount).map(day =>
      [day.day, day.recordedRequestCount, day.knownTokenCount, day.unknownTokenRequestCount]),
    [['2026-09-19', 1, 26, 0], ['2026-09-20', 2, 6, 1]]);
    assert.equal(report.dailyUsage.find(day => day.day === '2026-09-20').totalTokens, null);
    assert.equal(report.dailyUsage.find(day => day.day === '2026-09-21').totalTokens, null);
    assert.equal(JSON.stringify(report).includes('SECRET_'), false);
    const json = await fetch(`${base}/api/v3/stats/opencode/export.json`);
    assert.equal(json.status, 200);
    assert.match(json.headers.get('content-type'), /^application\/json/);
    assert.match(json.headers.get('content-disposition'), /attachment; filename="token-explorer-opencode.json"/);
    assert.deepEqual(await json.json(), report);
    const csv = await fetch(`${base}/api/v3/stats/opencode/export.csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /^text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /attachment; filename="token-explorer-opencode.csv"/);
    const lines = (await csv.text()).trimEnd().split('\n');
    assert.equal(lines[0], 'Provider,Composition Mode,Day (UTC),Total Tokens,Input Tokens,Output Tokens,Reasoning Tokens,Cache Read Tokens,Cache Write Tokens,Requests,Usage Range Scope,Coverage,Usage Coverage,Known Token Count,Unknown Token Request Count,Unresolved Usage Observation Count,Excluded Source Session Count,Source Diagnostic Codes,Source Diagnostics Truncated,Working Directory Filter,Request Model Filter,Project ID Filter,Request Model Provider Filter,Request Model Provider Filter Mode');
    assert.equal(lines.length, 31);
    assert.ok(lines.some(line => line.includes('"2026-09-19"') && line.includes(',26,12,4,3,5,2,1')));
    assert.ok(lines.some(line => line.includes('"2026-09-20"') && line.includes(',,8,3,1,3,1,2')));
    assert.equal(lines.join('\n').includes('SECRET_'), false);
    assert.equal(sha(f.file), before);
  });

test('stats rank recorded request models and drill into day-owned session totals under selected filters',
  { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    const db = new DatabaseSync(f.file);
    try {
      db.exec(`ALTER TABLE session_v2 ADD COLUMN project_id TEXT;
        UPDATE session_v2 SET directory='/project/a', project_id='project-a' WHERE id='root';
        UPDATE session_v2 SET directory='/project/b', project_id='project-b' WHERE id='child';
        UPDATE session_message SET data=json_set(data, '$.modelID', 'model-a') WHERE id IN ('a','b');`);
    } finally {
      db.close();
    }
    const before = sha(f.file);
    const base = await serve(f);
    const query = new URLSearchParams({ days: 'custom', from: '2026-09-19', to: '2026-09-20' });
    const response = await fetch(`${base}/api/v3/stats/opencode?${query}`);
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.deepEqual(report.modelRanking, [
      { model: 'model-a', recordedRequestCount: 2, knownTokenCount: 26, unknownTokenRequestCount: 1 },
      { model: null, recordedRequestCount: 1, knownTokenCount: 6, unknownTokenRequestCount: 0 },
    ]);
    const defaultDay = report.dailyUsage.find(row => row.day === '2026-09-20');
    assert.deepEqual(defaultDay.sessions, [], 'day session rows load only when a day is selected');
    query.set('day', '2026-09-20');
    const dayReport = await (await fetch(`${base}/api/v3/stats/opencode?${query}`)).json();
    assert.equal(dayReport.usageRange.selectedDay, '2026-09-20');
    assert.deepEqual(dayReport.dailyUsage.map(row => row.day), ['2026-09-20']);
    const day = dayReport.dailyUsage[0];
    assert.deepEqual(day.sessions.map(row => [row.session.provider, row.session.sessionId,
      row.recordedRequestCount, row.knownTokenCount, row.unknownTokenRequestCount]), [
      ['opencode', 'child', 1, 6, 0],
      ['opencode', 'root', 1, 0, 1],
    ]);
    assert.ok(day.sessions.every(row => !('messageCount' in row)),
      'a day drill must not present whole-session message counts as day-specific');

    query.set('scope', 'root');
    query.set('directory', '/project/a');
    query.set('project', 'project-a');
    query.set('model', 'model-a');
    const filtered = await (await fetch(`${base}/api/v3/stats/opencode?${query}`)).json();
    assert.equal(filtered.usageRange.model, 'model-a');
    assert.deepEqual(filtered.sessions.map(row => row.session.sessionId), ['root']);
    assert.deepEqual(filtered.modelRanking, [
      { model: 'model-a', recordedRequestCount: 1, knownTokenCount: 0, unknownTokenRequestCount: 1 },
    ]);
    const filteredDay = filtered.dailyUsage.find(row => row.day === '2026-09-20');
    assert.deepEqual(filteredDay.sessions.map(row => [row.session.sessionId,
      row.recordedRequestCount, row.knownTokenCount, row.unknownTokenRequestCount]), [['root', 1, 0, 1]]);
    const outsideRange = new URLSearchParams(query);
    outsideRange.set('day', '2026-09-18');
    assert.equal((await fetch(`${base}/api/v3/stats/opencode?${outsideRange}`)).status, 400);
    assert.equal(sha(f.file), before);
  });

test('stats scope and unavailable filters have explicit HTTP errors', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const base = await serve(f);
  const unknown = await fetch(`${base}/api/v3/stats/not-a-provider`);
  assert.equal(unknown.status, 404);
  const missing = await fetch(`${base}/api/v3/stats/claude-code`);
  assert.equal(missing.status, 503);
  const filtered = await fetch(`${base}/api/v3/stats/opencode/export.csv?days=custom&from=2026-09-20&to=2026-09-20`);
  assert.equal(filtered.status, 200);
  assert.equal((await filtered.text()).trimEnd().split('\n').length, 2);
  const invalid = await fetch(`${base}/api/v3/stats/opencode?days=custom&from=2026-02-30&to=2026-03-01`);
  assert.equal(invalid.status, 400);
});

test('opt-in Stats phase probe reports aggregate timings without changing the response',
  { timeout: 30_000, skip: !process.env.AGENTSESSION_V3_EXPECT_STATS_PROBE }, async t => {
    const f = await fixture(t);
    const source = path.join(f.root, 'codex', 'sessions', 'probe.jsonl');
    await copyFile(path.join(repo, 'v3', 'fixtures', 'codex', 'sessions', '2026', '09', '26',
      'rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl'), source);
    const sourceBefore = sha(source);
    const base = await serve(f, { env: { AGENTSESSION_V3_STATS_PHASE_PROBE: '1' } });
    const first = await (await fetch(`${base}/api/v3/stats/codex`)).text();
    const second = await (await fetch(`${base}/api/v3/stats/codex`)).text();
    assert.equal(second, first);
    assert.equal(sha(source), sourceBefore);
    const lines = f.stderr().split(/\r?\n/).filter(Boolean);
    const phases = lines.filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line)).filter(line => line.kind === 'stats_phase_probe');
    const serialization = lines.filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line)).filter(line => line.kind === 'stats_serialization_probe');
    assert.equal(phases.length, 2, f.stderr());
    assert.equal(serialization.length, 2, f.stderr());
    assert.ok(phases.every(row => row.total_ms >= 0 && row.phases_ms.indexed_sessions >= 0
      && row.phases_ms.first_source_revision >= 0 && row.phases_ms.final_source_revision >= 0));
    assert.ok(phases[1].cached_sessions >= phases[0].cached_sessions);
    assert.doesNotMatch(lines.filter(line => line.startsWith('{')).join('\n'),
      /SECRET_PROMPT|SECRET_ANSWER|synthetic|opencode\.db|"session_id"/);
  });

test('OpenCode missing model provider filter is distinct from legacy wildcard and exact provider',
  { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    const db = new DatabaseSync(f.file);
    try {
      db.exec(`UPDATE session_message SET data=json_set(data, '$.modelID', 'shared-model')
        WHERE id IN ('a','b');
        UPDATE session_message SET data=json_set(data, '$.providerID', 'provider-b') WHERE id='b';
        UPDATE session_message SET data=json_set(data, '$.providerID', 'provider-only') WHERE id='d';`);
    } finally {
      db.close();
    }
    const before = sha(f.file);
    const base = await serve(f);
    const query = new URLSearchParams({ days: 'custom', from: '2026-09-19',
      to: '2026-09-20', model: 'shared-model' });
    const endpoint = `${base}/api/v3/stats/opencode?`;
    const unfiltered = new URLSearchParams(query);
    unfiltered.delete('model');
    const allModels = await (await fetch(endpoint + unfiltered)).json();
    assert.ok(allModels.modelRanking.some(row => row.modelProvider === 'provider-only'
      && row.model === null && row.recordedRequestCount === 1));
    const wildcard = await (await fetch(endpoint + query)).json();
    assert.equal(wildcard.overview.recordedRequestCount, 2);
    assert.equal('modelProvider' in wildcard.usageRange, false);
    assert.deepEqual(wildcard.availableModels.filter(option => option.model === 'shared-model'),
      [{ model: 'shared-model' }, { model: 'shared-model', modelProvider: 'provider-b' }]);
    assert.deepEqual(wildcard.modelRanking.map(row => [row.modelProvider, row.model, row.recordedRequestCount]),
      [[undefined, 'shared-model', 1], ['provider-b', 'shared-model', 1]]);
    query.set('modelProvider', '');
    const missing = await (await fetch(endpoint + query)).json();
    assert.equal(missing.usageRange.modelProvider, '');
    assert.equal(missing.overview.recordedRequestCount, 1);
    assert.deepEqual(missing.modelRanking.map(row => [row.modelProvider, row.model]),
      [[undefined, 'shared-model']]);
    query.set('day', '2026-09-19');
    const day = await (await fetch(endpoint + query)).json();
    assert.equal(day.usageRange.modelProvider, '');
    assert.equal(day.dailyUsage[0].recordedRequestCount, 1);
    query.delete('day');
    const csv = await (await fetch(`${base}/api/v3/stats/opencode/export.csv?${query}`)).text();
    assert.match(csv, /Request Model Provider Filter Mode/);
    assert.ok(csv.split('\n').some(row => row.endsWith('"","missing"')));
    query.delete('modelProvider');
    const anyCsv = await (await fetch(`${base}/api/v3/stats/opencode/export.csv?${query}`)).text();
    assert.ok(anyCsv.split('\n').some(row => row.endsWith('"","any"')));
    query.set('modelProvider', 'provider-b');
    const exact = await (await fetch(endpoint + query)).json();
    assert.equal(exact.overview.recordedRequestCount, 1);
    assert.deepEqual(exact.modelRanking.map(row => [row.modelProvider, row.model]),
      [['provider-b', 'shared-model']]);
    assert.equal(sha(f.file), before);
  });

test('OpenCode empty recorded model and provider IDs normalize to missing usage identity',
  { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    const db = new DatabaseSync(f.file);
    try {
      db.exec(`UPDATE session_message SET data=json_set(data, '$.modelID', '', '$.providerID', '')
        WHERE id='a';`);
    } finally {
      db.close();
    }
    const before = sha(f.file);
    const base = await serve(f);
    const response = await fetch(`${base}/api/v3/protocol/opencode/root`);
    assert.equal(response.status, 200);
    const document = await response.json();
    const usage = document.usageRecords.find(row => row.turnId === 'a');
    assert.ok(usage);
    assert.equal(usage.model, null);
    assert.equal('modelProvider' in usage, false);
    const stats = await (await fetch(`${base}/api/v3/stats/opencode`)).json();
    assert.ok(stats.modelRanking.some(row => row.model === null
      && row.modelProvider === undefined));
    assert.ok(stats.availableModels.every(row => row.model !== ''));
    assert.equal(sha(f.file), before);
  });

test('OpenCode root scope excludes child request usage from JSON and CSV',
  { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    const base = await serve(f);
    const url = `${base}/api/v3/stats/opencode?days=custom&from=2026-09-19&to=2026-09-20&scope=root`;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.usageRange.scope, 'root');
    assert.deepEqual(report.sessions.map(row => row.session.sessionId), ['root']);
    assert.equal(report.overview.totalSessions, 1);
    assert.equal(report.overview.totalMessages, 3);
    assert.equal(report.overview.recordedRequestCount, 2);
    assert.equal(report.overview.knownTokenCount, 26);
    assert.deepEqual(report.dailyUsage.map(row => row.recordedRequestCount), [1, 1]);
    const csv = await fetch(url.replace('/opencode?', '/opencode/export.csv?'));
    assert.equal(csv.status, 200);
    assert.ok((await csv.text()).split('\n').includes(
      '"opencode","exclusive-partial","2026-09-20",,5,1,1,2,1,1,"root","partial","partial",0,1,0,0,"",false,"","","","","any"'));
    const invalid = await fetch(`${base}/api/v3/stats/opencode?scope=child`);
    assert.equal(invalid.status, 400);
  });

test('working directory and model select the same owned requests across JSON, CSV, and sessions',
  { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    const db = new DatabaseSync(f.file);
    try {
      db.exec(`UPDATE session_v2 SET directory='/project/a' WHERE id='root';
        UPDATE session_v2 SET directory='/project/b' WHERE id='child';
        UPDATE session_message SET data=json_set(data, '$.modelID', 'model-one') WHERE id='a';
        UPDATE session_message SET data=json_set(data, '$.modelID', 'model-two') WHERE id='b';
        UPDATE session_message SET data=json_set(data, '$.modelID', 'model-one') WHERE id='d';
        INSERT INTO session_v2 VALUES
          ('other',NULL,NULL,NULL,'Other','other','/project/a',1,3,NULL,0,0,0,0,0);
        INSERT INTO session_message VALUES
          ('other-a','other','assistant',1,1789862404000,1789862404000,
            '{"content":[],"modelID":"model-two","tokens":{"input":2,"output":1,"total":3}}');`);
    } finally {
      db.close();
    }
    const before = sha(f.file);
    const base = await serve(f);
    const query = new URLSearchParams({ days: 'custom', from: '2026-09-19',
      to: '2026-09-20', directory: '/project/a', model: 'model-two', scope: 'root' });
    const response = await fetch(`${base}/api/v3/stats/opencode?${query}`);
    assert.equal(response.status, 200, await response.text().then(body => response.status === 200 ? undefined : body));
    const reportResponse = await fetch(`${base}/api/v3/stats/opencode?${query}`);
    assert.equal(reportResponse.status, 200, await reportResponse.clone().text());
    const report = await reportResponse.json();
    assert.equal(report.usageRange.directory, '/project/a');
    assert.equal(report.usageRange.model, 'model-two');
    assert.deepEqual(report.sessions.map(row => row.session.sessionId).sort(), ['other', 'root']);
    assert.equal(report.overview.totalSessions, 2);
    assert.equal(report.overview.recordedRequestCount, 2);
    assert.equal(report.overview.knownTokenCount, 3);
    assert.equal(report.overview.unknownTokenRequestCount, 1);
    assert.deepEqual(report.sessions.map(row => [row.session.sessionId,
      row.recordedRequestCount, row.knownTokenCount, row.unknownTokenRequestCount]).sort(),
    [['other', 1, 3, 0], ['root', 1, 0, 1]]);
    const day = report.dailyUsage.find(row => row.day === '2026-09-20');
    assert.equal(day.recordedRequestCount, 2);
    assert.equal(day.knownTokenCount, 3);
    assert.equal(day.totalTokens, null);
    const exported = await (await fetch(`${base}/api/v3/stats/opencode/export.json?${query}`)).json();
    assert.deepEqual(exported, report);
    const csv = await (await fetch(`${base}/api/v3/stats/opencode/export.csv?${query}`)).text();
    // other-a records no reasoning field, so the aggregated reasoning column is unknown.
    assert.ok(csv.split('\n').includes(
      '"opencode","exclusive-partial","2026-09-20",,7,2,,,,2,"root","partial","partial",3,1,0,0,"",false,"/project/a","model-two","","","any"'));
    const emptyRange = new URLSearchParams(query);
    emptyRange.set('from', '2026-09-21');
    emptyRange.set('to', '2026-09-21');
    const empty = await (await fetch(`${base}/api/v3/stats/opencode?${emptyRange}`)).json();
    assert.equal(empty.usageCoverage, 'not-observed');
    assert.equal(empty.overview.recordedRequestCount, 0);
    assert.deepEqual(empty.sessions, []);
    assert.equal(sha(f.file), before);
  });

test('OpenCode project ID is distinct from working directory and composes with model',
  { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    const db = new DatabaseSync(f.file);
    try {
      db.exec(`ALTER TABLE session_v2 ADD COLUMN project_id TEXT;
        UPDATE session_v2 SET project_id='project-a', directory='/shared' WHERE id='root';
        UPDATE session_v2 SET project_id='project-b', directory='/shared' WHERE id='child';
        UPDATE session_message SET data=json_set(data, '$.modelID', 'model-one') WHERE id IN ('a','d');
        UPDATE session_message SET data=json_set(data, '$.modelID', 'model-two') WHERE id='b';
        INSERT INTO session_v2 (id,parent_id,title,slug,directory,time_created,time_updated,
          project_id) VALUES ('other',NULL,'Other','other','/shared',1,3,'project-b'),
            ('unassigned',NULL,'Unassigned','unassigned','/shared',1,3,NULL);
        INSERT INTO session_message VALUES
          ('other-a','other','assistant',1,1789862404000,1789862404000,
            '{"content":[],"modelID":"model-two","tokens":{"input":2,"output":1,"total":3}}'),
          ('unassigned-a','unassigned','assistant',1,1789862405000,1789862405000,
            '{"content":[],"modelID":"model-two","tokens":{"input":1,"output":1,"total":2}}');`);
    } finally {
      db.close();
    }
    const base = await serve(f);
    const query = new URLSearchParams({ days: 'custom', from: '2026-09-19', to: '2026-09-20',
      scope: 'root', directory: '/shared', model: 'model-two', project: 'project-a' });
    const response = await fetch(`${base}/api/v3/stats/opencode?${query}`);
    assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
    const report = await response.json();
    assert.equal(report.usageRange.project, 'project-a');
    assert.deepEqual(report.availableProjects,
      ['__opensession_empty_project__', 'project-a', 'project-b']);
    assert.deepEqual(report.sessions.map(row => row.session.sessionId), ['root']);
    assert.equal(report.overview.recordedRequestCount, 1);
    assert.equal(report.overview.unknownTokenRequestCount, 1);
    const csv = await (await fetch(`${base}/api/v3/stats/opencode/export.csv?${query}`)).text();
    assert.ok(csv.includes('"/shared","model-two","project-a"'));
    const exported = await (await fetch(`${base}/api/v3/stats/opencode/export.json?${query}`)).json();
    assert.deepEqual(exported, report);
    query.set('project', 'project-b');
    const other = await (await fetch(`${base}/api/v3/stats/opencode?${query}`)).json();
    assert.deepEqual(other.sessions.map(row => row.session.sessionId), ['other']);
    assert.equal(other.overview.knownTokenCount, 3);
    query.set('project', '__opensession_empty_project__');
    const unassigned = await (await fetch(`${base}/api/v3/stats/opencode?${query}`)).json();
    assert.deepEqual(unassigned.sessions.map(row => row.session.sessionId), ['unassigned']);
    assert.equal(unassigned.overview.knownTokenCount, 2);
    const unsupported = await fetch(`${base}/api/v3/stats/codex?${query}`);
    assert.equal(unsupported.status, 400);
    assert.equal((await fetch(`${base}/api/v3/stats/opencode?modelProvider=provider-a`)).status, 400);
  });

test('stats CSV retains selected scope and daily request coverage from JSON',
  { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    const base = await serve(f);
    const expectedColumns = [
      'Provider', 'Composition Mode', 'Day (UTC)', 'Total Tokens', 'Input Tokens',
      'Output Tokens', 'Reasoning Tokens', 'Cache Read Tokens', 'Cache Write Tokens', 'Requests',
      'Usage Range Scope', 'Coverage', 'Usage Coverage', 'Known Token Count',
      'Unknown Token Request Count', 'Unresolved Usage Observation Count',
      'Excluded Source Session Count', 'Source Diagnostic Codes', 'Source Diagnostics Truncated',
      'Working Directory Filter', 'Request Model Filter',
      'Project ID Filter', 'Request Model Provider Filter', 'Request Model Provider Filter Mode',
    ];
    const parseRow = line => line.split(',').map(cell =>
      cell.startsWith('"') && cell.endsWith('"')
        ? cell.slice(1, -1).replaceAll('""', '"')
        : cell);

    for (const scope of ['all', 'root']) {
      const query = new URLSearchParams({
        days: 'custom', from: '2026-09-19', to: '2026-09-20', scope,
      });
      const jsonResponse = await fetch(`${base}/api/v3/stats/opencode/export.json?${query}`);
      assert.equal(jsonResponse.status, 200);
      const report = await jsonResponse.json();
      const csvResponse = await fetch(`${base}/api/v3/stats/opencode/export.csv?${query}`);
      assert.equal(csvResponse.status, 200);
      const [header, ...rows] = (await csvResponse.text()).trimEnd().split(/\r?\n/).map(parseRow);
      assert.deepEqual(header, expectedColumns);

      const column = Object.fromEntries(header.map((name, index) => [name, index]));
      assert.equal(rows.length, report.dailyUsage.length);
      for (const day of report.dailyUsage) {
        const row = rows.find(values => values[column['Day (UTC)']] === day.day);
        assert.ok(row, `CSV day ${day.day}`);
        assert.equal(row[column['Usage Range Scope']], report.usageRange.scope);
        assert.equal(row[column.Coverage], report.coverage);
        assert.equal(row[column['Usage Coverage']], report.usageCoverage);
        assert.equal(row[column.Requests], String(day.recordedRequestCount));
        assert.equal(row[column['Known Token Count']], String(day.knownTokenCount));
        assert.equal(row[column['Unknown Token Request Count']], String(day.unknownTokenRequestCount));
        assert.equal(row[column['Unresolved Usage Observation Count']],
          String(day.unresolvedUsageObservationCount));
        assert.equal(row[column['Excluded Source Session Count']],
          String(report.overview.excludedSourceSessionCount));
        assert.equal(row[column['Source Diagnostic Codes']],
          report.sourceDiagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.affectedSessions}`).join('; '));
        assert.equal(row[column['Source Diagnostics Truncated']],
          String(report.sourceDiagnosticsTruncated));
        assert.equal(row[column['Working Directory Filter']], report.usageRange.directory ?? '');
        assert.equal(row[column['Request Model Filter']], report.usageRange.model ?? '');
        assert.equal(row[column['Project ID Filter']], report.usageRange.project ?? '');
        assert.equal(row[column['Request Model Provider Filter']], report.usageRange.modelProvider ?? '');
        assert.equal(row[column['Request Model Provider Filter Mode']],
          report.usageRange.modelProvider === undefined ? 'any'
            : report.usageRange.modelProvider === '' ? 'missing' : 'exact');
        assert.equal(row[column['Total Tokens']], day.totalTokens === null ? '' : String(day.totalTokens));
      }
      assert.equal(report.usageRange.scope, scope);
      if (scope === 'all') {
        const mixedDay = report.dailyUsage.find(day => day.day === '2026-09-20');
        assert.equal(mixedDay.totalTokens, null);
        assert.equal(mixedDay.knownTokenCount, 6);
        assert.equal(mixedDay.unknownTokenRequestCount, 1);
      }
    }
  });

test('statistics page can cold-start at global and five-provider routes',
  { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    const base = await serve(f);
    for (const page of ['/stats', '/codex/stats', '/claude-code/stats', '/opencode/stats',
      '/deepseek-harness/stats', '/pi/stats']) {
      const response = await fetch(base + page);
      assert.equal(response.status, 200, page);
      assert.match(response.headers.get('content-type'), /^text\/html/, page);
    }
    assert.equal((await fetch(base + '/retired-provider/stats')).status, 404);
  });

test('statistics browser downloads the displayed CSV and JSON reports',
  { timeout: 60_000, skip: !agentBrowserBinary() }, async t => {
    const f = await fixture(t);
    const before = sha(f.file);
    const base = await serve(f);
    const browser = agentBrowserBinary();
    const session = `as-v3-stats-${process.pid}-${Date.now()}`;
    const downloads = path.join(f.root, 'downloads');
    await mkdir(downloads);
    onCleanup(t, async () => { try { await browserCommand(browser, session, downloads, 'close'); } catch { /* cleanup */ } });
    await browserCommand(browser, session, downloads, 'open', `${base}/opencode/stats`);
    await browserCommand(browser, session, downloads, 'wait', '--text', 'Download CSV');
    const snapshot = await browserCommand(browser, session, downloads, 'snapshot', '-i');
    assert.match(snapshot, /Download CSV/);
    assert.match(snapshot, /Download JSON/);
    const displayedExports = JSON.parse(await browserCommand(browser, session, downloads, 'eval',
      `Array.from(document.querySelectorAll('.stats-downloads a')).map(link => link.getAttribute('href'))`));
    for (const href of displayedExports) {
      assert.equal(new URL(href, base).searchParams.get('providers'), 'opencode');
    }
    await browserCommand(browser, session, downloads, 'click', 'a[href*="export.csv"]');
    await browserCommand(browser, session, downloads, 'click', 'a[href*="export.json"]');
    let names = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      names = await readdir(downloads);
      if (names.some(name => name.endsWith('.csv')) && names.some(name => name.endsWith('.json'))) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const csvPath = path.join(downloads, names.find(name => name.endsWith('.csv')) ?? 'missing.csv');
    const jsonPath = path.join(downloads, names.find(name => name.endsWith('.json')) ?? 'missing.json');
    assert.ok(existsSync(csvPath) && existsSync(jsonPath),
      `browser downloads: ${names.join(', ')}`);
    const displayedJson = displayedExports.find(href => href.includes('/export.json'));
    assert.ok(displayedJson, 'the displayed JSON export URL is present');
    const report = await (await fetch(new URL(displayedJson, base))).json();
    assert.deepEqual(JSON.parse(readFileSync(jsonPath, 'utf8')), report);
    const providerReport = await (await fetch(`${base}/api/v3/stats/opencode?days=30`)).json();
    assert.deepEqual(report.overview, providerReport.overview,
      'the selected aggregate export keeps the provider-owned request accounting');
    const csv = readFileSync(csvPath, 'utf8');
    assert.equal(csv.trimEnd().split(/\r?\n/).length, report.dailyUsage.length + 1);
    assert.match(csv.split(/\r?\n/, 1)[0], /Known Token Count,Unknown Token Request Count/);
    assert.match(csv.split(/\r?\n/, 1)[0], /Selected Harnesses,Source Status$/);
    assert.equal(sha(f.file), before);
  });

test('active sessions with no owned usage report not-observed coverage and unknown totals',
  { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    const db = new DatabaseSync(f.file);
    try {
      db.exec(`UPDATE session_message SET data='{"content":[]}' WHERE type='assistant'`);
    } finally {
      db.close();
    }
    const base = await serve(f);
    const response = await fetch(`${base}/api/v3/stats/opencode`);
    const report = await response.json();
    assert.equal(response.status, 200);
    assert.equal(report.usageCoverage, 'not-observed');
    assert.equal(report.overview.recordedRequestCount, 0);
    assert.equal(report.overview.totalTokens, null);
    assert.ok(report.sessions.every(row => row.recordedRequestCount === 0));
    assert.ok(report.dailyUsage.every(row => row.totalTokens === null));
  });

test('frozen OpenCode statistics export all active sessions and preserve DB/WAL bytes',
  { timeout: 60_000, skip: !process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST }, async t => {
    const manifest = JSON.parse(readFileSync(process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST));
    const database = manifest.database.snapshotPath;
    const sourceFiles = [database, `${database}-wal`];
    const hashOrNull = file => existsSync(file) ? sha(file) : null;
    const before = sourceFiles.map(hashOrNull);
    assert.equal(before[0], manifest.database.snapshotSha256);
    const db = new DatabaseSync(database, { readOnly: true });
    let expectedSessions, expectedMessages;
    try {
      expectedSessions = db.prepare(
        'SELECT COUNT(*) AS n FROM session_v2 WHERE time_archived IS NULL').get().n;
      expectedMessages = db.prepare(`SELECT COUNT(*) AS n FROM session_message m
        JOIN session_v2 s ON s.id=m.session_id WHERE s.time_archived IS NULL
        AND m.type IN ('user','assistant')
        AND (s.fork_session_id IS NULL OR
          substr(m.id,-length(CAST(m.seq AS TEXT))-1) != '_' || m.seq)`).get().n;
    } finally {
      db.close();
    }
    const f = await fixture(t);
    f.args[f.args.indexOf('--opencode-db') + 1] = database;
    const base = await serve(f);
    const response = await fetch(`${base}/api/v3/stats/opencode/export.json`);
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.overview.totalSessions, expectedSessions);
    assert.equal(report.overview.totalMessages, expectedMessages);
    assert.equal(report.sessions.length, expectedSessions);
    assert.equal(report.overview.totalTokens, null);
    assert.ok(report.revision.length > 0);
    console.log(`frozen opencode stats revision ${report.revision}; sessions ${expectedSessions}; messages ${expectedMessages}`);
    const csv = await (await fetch(`${base}/api/v3/stats/opencode/export.csv`)).text();
    assert.equal(csv.trimEnd().split('\n').length, report.dailyUsage.length + 1);
    assert.deepEqual(sourceFiles.map(hashOrNull), before);
  });

test('frozen OpenCode root scope matches source parent ownership',
  { timeout: 60_000, skip: !process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST }, async t => {
    const manifest = JSON.parse(readFileSync(process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST));
    const database = manifest.database.snapshotPath;
    const sourceFiles = [database, `${database}-wal`];
    const hashOrNull = file => existsSync(file) ? sha(file) : null;
    const before = sourceFiles.map(hashOrNull);
    assert.equal(before[0], manifest.database.snapshotSha256);
    const db = new DatabaseSync(database, { readOnly: true });
    let expected, expectedMessages;
    try {
      expected = db.prepare(`SELECT id FROM session_v2
        WHERE time_archived IS NULL AND parent_id IS NULL ORDER BY id`).all().map(row => row.id);
      expectedMessages = db.prepare(`SELECT COUNT(*) AS n FROM session_message m
        JOIN session_v2 s ON s.id=m.session_id WHERE s.time_archived IS NULL
        AND s.parent_id IS NULL AND m.type IN ('user','assistant')
        AND (s.fork_session_id IS NULL OR
          substr(m.id,-length(CAST(m.seq AS TEXT))-1) != '_' || m.seq)`).get().n;
    } finally {
      db.close();
    }
    const f = await fixture(t);
    f.args[f.args.indexOf('--opencode-db') + 1] = database;
    const base = await serve(f);
    const response = await fetch(`${base}/api/v3/stats/opencode/export.json?scope=root&days=custom&from=2026-07-01&to=2026-09-27`);
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.usageRange.scope, 'root');
    assert.deepEqual(report.sessions.map(row => row.session.sessionId).sort(), expected);
    assert.equal(report.overview.totalSessions, expected.length);
    assert.equal(report.overview.totalMessages, expectedMessages);
    assert.equal(report.overview.recordedRequestCount,
      report.sessions.reduce((sum, row) => sum + row.recordedRequestCount, 0));
    const csv = await fetch(`${base}/api/v3/stats/opencode/export.csv?scope=root&days=custom&from=2026-07-01&to=2026-09-27`);
    assert.equal(csv.status, 200);
    assert.equal((await csv.text()).trimEnd().split('\n').length, report.dailyUsage.length + 1);
    assert.deepEqual(sourceFiles.map(hashOrNull), before);
    console.log(`frozen OpenCode root scope: ${expected.length} sessions, ${expectedMessages} messages`);
  });

test('frozen OpenCode directory and model selection agrees with independent SQLite request rows',
  { timeout: 60_000, skip: !process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST }, async t => {
    const manifest = JSON.parse(readFileSync(process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST));
    const database = manifest.database.snapshotPath;
    const sourceFiles = [database, `${database}-wal`];
    const hashOrNull = file => existsSync(file) ? sha(file) : null;
    const before = sourceFiles.map(hashOrNull);
    const db = new DatabaseSync(database, { readOnly: true });
    let raw;
    try {
      raw = db.prepare(`SELECT s.id AS session_id, s.directory, s.project_id,
          m.time_created AS timestamp, m.data
        FROM session_message m JOIN session_v2 s ON s.id=m.session_id
        WHERE s.time_archived IS NULL AND s.parent_id IS NULL AND m.type='assistant'
          AND m.time_created >= ? AND m.time_created < ?
          AND (s.fork_session_id IS NULL OR
            substr(m.id,-length(CAST(m.seq AS TEXT))-1) != '_' || m.seq)`)
        .all(Date.parse('2026-07-01T00:00:00Z'), Date.parse('2026-09-28T00:00:00Z'));
    } finally {
      db.close();
    }
    const owned = raw.flatMap(row => {
      const message = JSON.parse(row.data);
      if (!message.tokens || typeof message.tokens !== 'object') return [];
      const token = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
      const tokens = message.tokens;
      const sum = token(tokens.input) + token(tokens.output) + token(tokens.reasoning)
        + token(tokens.cache?.read) + token(tokens.cache?.write);
      if (sum === 0) return [];
      return [{ sessionId: row.session_id, directory: row.directory,
        projectId: row.project_id ?? '',
        model: message.modelID ?? message.model?.id ?? null,
        modelProvider: message.providerID ?? message.model?.providerID ?? null,
        timestamp: row.timestamp,
        total: tokens.total === sum ? sum : null }];
});

    const pairs = new Map();
    for (const row of owned) {
      if (!row.directory || !row.model) continue;
      const key = JSON.stringify([row.directory, row.model]);
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
    const [[key]] = [...pairs].sort((a, b) => b[1] - a[1]);
    const [directory, model] = JSON.parse(key);
    const selected = owned.filter(row => row.directory === directory && row.model === model);
    const expectedIds = [...new Set(selected.map(row => row.sessionId))].sort();
    const f = await fixture(t);
    f.args[f.args.indexOf('--opencode-db') + 1] = database;
    const base = await serve(f);
    const query = new URLSearchParams({ days: 'custom', from: '2026-07-01', to: '2026-09-27',
      scope: 'root', directory, model });
    const response = await fetch(`${base}/api/v3/stats/opencode?${query}`);
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.deepEqual(report.sessions.map(row => row.session.sessionId).sort(), expectedIds);
    assert.equal(report.overview.recordedRequestCount, selected.length);
    assert.equal(report.overview.knownTokenCount,
      selected.reduce((sum, row) => sum + (row.total ?? 0), 0));
    assert.equal(report.overview.unknownTokenRequestCount,
      selected.filter(row => row.total === null).length);
    const projectCounts = new Map();
    for (const row of selected) projectCounts.set(row.projectId,
      (projectCounts.get(row.projectId) ?? 0) + 1);
    const [[projectId]] = [...projectCounts].sort((a, b) => b[1] - a[1]);
    const projectSelected = selected.filter(row => row.projectId === projectId);
    query.set('project', projectId || '__opensession_empty_project__');
    const projectResponse = await fetch(`${base}/api/v3/stats/opencode?${query}`);
    assert.equal(projectResponse.status, 200);
    const projectReport = await projectResponse.json();
    assert.deepEqual(projectReport.sessions.map(row => row.session.sessionId).sort(),
      [...new Set(projectSelected.map(row => row.sessionId))].sort());
    assert.equal(projectReport.overview.recordedRequestCount, projectSelected.length);
    assert.equal(projectReport.overview.knownTokenCount,
      projectSelected.reduce((sum, row) => sum + (row.total ?? 0), 0));
    assert.equal(projectReport.overview.unknownTokenRequestCount,
      projectSelected.filter(row => row.total === null).length);
    assert.deepEqual(projectReport.modelRanking, [{
      model,
      modelProvider: projectSelected[0].modelProvider,
      recordedRequestCount: projectSelected.length,
      knownTokenCount: projectSelected.reduce((sum, row) => sum + (row.total ?? 0), 0),
      unknownTokenRequestCount: projectSelected.filter(row => row.total === null).length,
    }]);
    const selectedDay = new Date(projectSelected[0].timestamp).toISOString().slice(0, 10);
    query.set('day', selectedDay);
    const drillResponse = await fetch(`${base}/api/v3/stats/opencode?${query}`);
    assert.equal(drillResponse.status, 200);
    const drillReport = await drillResponse.json();
    const dayRequests = projectSelected.filter(row =>
      new Date(row.timestamp).toISOString().slice(0, 10) === selectedDay);
    const day = drillReport.dailyUsage.find(row => row.day === selectedDay);
    assert.ok(day, `selected request day ${selectedDay} is present`);
    const expectedDaySessions = new Map();
    for (const request of dayRequests) {
      const session = expectedDaySessions.get(request.sessionId) || {
        requestCount: 0, known: 0, unknown: 0,
      };
      session.requestCount += 1;
      if (request.total === null) session.unknown += 1;
      else session.known += request.total;
      expectedDaySessions.set(request.sessionId, session);
    }
    const expectedDrill = [...expectedDaySessions].map(([sessionId, values]) =>
      [sessionId, values.requestCount, values.known, values.unknown])
      .sort(([left], [right]) => left.localeCompare(right));
    const actualDrill = day.sessions.map(row => [row.session.sessionId,
      row.recordedRequestCount, row.knownTokenCount, row.unknownTokenRequestCount])
      .sort(([left], [right]) => left.localeCompare(right));
    assert.deepEqual(actualDrill, expectedDrill);
    assert.equal(day.recordedRequestCount, dayRequests.length);
    assert.ok(day.sessions.every(row => !('messageCount' in row)));
    const after = sourceFiles.map(hashOrNull);
    assert.deepEqual(after, before);
    console.log(`frozen OpenCode request/day DB-WAL SHA-256 unchanged: db=${after[0]}; wal=${after[1] ?? 'absent'}`);
    console.log(`frozen OpenCode directory/model: ${expectedIds.length} canonical sessions, ${selected.length} raw request rows; project ID: ${projectReport.sessions.length} sessions, ${projectSelected.length} rows`);
  });

test('frozen OpenCode statistics keep source provider and model identities separate',
  { timeout: 90_000, skip: !process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST }, async t => {
    const manifest = JSON.parse(readFileSync(process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST));
    const source = manifest.database.snapshotPath;
    const sourceFiles = [source, `${source}-wal`];
    const hashOrNull = file => existsSync(file) ? sha(file) : null;
    const sourceHashes = sourceFiles.map(hashOrNull);
    const f = await fixture(t);
    await copyFile(source, f.file);
    if (existsSync(`${source}-wal`)) await copyFile(`${source}-wal`, `${f.file}-wal`);
    const copyHashes = [f.file, `${f.file}-wal`].map(hashOrNull);
    const db = new DatabaseSync(f.file, { readOnly: true });
    let pairs;
    try {
      pairs = db.prepare(`SELECT
          COALESCE(json_extract(m.data, '$.providerID'), json_extract(m.data, '$.model.providerID')) AS model_provider,
          COALESCE(json_extract(m.data, '$.modelID'), json_extract(m.data, '$.model.id')) AS model,
          count(*) AS requests
        FROM session_message m JOIN session_v2 s ON s.id=m.session_id
        WHERE s.time_archived IS NULL AND m.type='assistant'
          AND m.time_created >= ? AND m.time_created < ?
          AND COALESCE(json_extract(m.data, '$.modelID'), json_extract(m.data, '$.model.id'))='deepseek-v4-flash'
          AND (COALESCE(json_extract(m.data, '$.tokens.input'),0)
            + COALESCE(json_extract(m.data, '$.tokens.output'),0)
            + COALESCE(json_extract(m.data, '$.tokens.reasoning'),0)
            + COALESCE(json_extract(m.data, '$.tokens.cache.read'),0)
            + COALESCE(json_extract(m.data, '$.tokens.cache.write'),0))>0
        GROUP BY 1,2 ORDER BY 1`)
        .all(Date.parse('2026-05-01T00:00:00Z'), Date.parse('2026-08-01T00:00:00Z'));
    } finally {
      db.close();
    }
    assert.deepEqual(pairs.map(row => row.model_provider), ['deepseek', 'opencode-go']);
    const base = await serve(f);
    const query = new URLSearchParams({ days: 'custom', from: '2026-05-01', to: '2026-07-31' });
    const reportResponse = await fetch(`${base}/api/v3/stats/opencode?${query}`);
    assert.equal(reportResponse.status, 200, await reportResponse.clone().text());
    const report = await reportResponse.json();
    assert.deepEqual(report.modelRanking.filter(row => row.model === 'deepseek-v4-flash')
      .map(row => [row.modelProvider, row.model, row.recordedRequestCount])
      .sort(([left], [right]) => left.localeCompare(right)),
    pairs.map(row => [row.model_provider, row.model, row.requests]));
    for (const pair of pairs) {
      query.set('model', pair.model);
      query.set('modelProvider', pair.model_provider);
      const selectedResponse = await fetch(`${base}/api/v3/stats/opencode?${query}`);
      assert.equal(selectedResponse.status, 200, await selectedResponse.clone().text());
      const selected = await selectedResponse.json();
      assert.equal(selected.usageRange.modelProvider, pair.model_provider);
      assert.equal(selected.overview.recordedRequestCount, pair.requests);
      const csv = await (await fetch(`${base}/api/v3/stats/opencode/export.csv?${query}`)).text();
      assert.match(csv.split('\n')[0], /Request Model Provider Filter/);
      assert.ok(csv.split('\n').slice(1).filter(Boolean).every(row =>
        row.endsWith(`"${pair.model_provider}","exact"`)), 'CSV retains the selected model provider');
    }
    assert.deepEqual([f.file, `${f.file}-wal`].map(hashOrNull), copyHashes);
    assert.deepEqual(sourceFiles.map(hashOrNull), sourceHashes);
  });
test('frozen five-provider daily reports agree with each selected request protocol',
  { timeout: 90_000, skip: !process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST }, async t => {
    const manifest = JSON.parse(readFileSync(process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST));
    const corpus = path.dirname(process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST);
    const f = await fixture(t);
    for (const [flag, source] of [
      ['--opencode-db', manifest.database.snapshotPath],
      ['--codex-dir', path.join(corpus, 'codex')],
      ['--claude-dir', path.join(corpus, 'claude-code')],
      ['--pi-dir', path.join(corpus, 'pi')],
      ['--dsh-dir', path.join(corpus, 'deepseek-harness')],
    ]) f.args[f.args.indexOf(flag) + 1] = source;
    const sourceFiles = manifest.files.map(file => file.snapshotPath);
    const before = sourceFiles.map(sha);
    const base = await serve(f);
    const from = '2026-07-01';
    const to = '2026-09-27';
    for (const provider of ['codex', 'claude-code', 'opencode', 'deepseek-harness', 'pi']) {
      const response = await fetch(`${base}/api/v3/stats/${provider}?days=custom&from=${from}&to=${to}`);
      const report = await response.json();
      assert.equal(response.status, 200, JSON.stringify(report.error));
      assert.equal(report.overview.totalSessions, report.sessions.length);
      assert.equal(report.overview.recordedRequestCount,
        report.sessions.reduce((sum, session) => sum + session.recordedRequestCount, 0));
      assert.equal(report.overview.recordedRequestCount,
        report.dailyUsage.reduce((sum, day) => sum + day.recordedRequestCount, 0));
      const selected = report.sessions.find(session => session.recordedRequestCount > 0);
      assert.ok(selected, `${provider} needs a recorded frozen request`);
      const protocolResponse = await fetch(`${base}/api/v3/protocol/${provider}/${encodeURIComponent(selected.session.sessionId)}?version=3`);
      const document = await protocolResponse.json();
      assert.equal(protocolResponse.status, 200, JSON.stringify(document.error));
      const records = document.usageRecords.filter(record => {
        const day = record.timestamp === null ? null : new Date(record.timestamp).toISOString().slice(0, 10);
        return day !== null && day >= from && day <= to;
      });
      assert.equal(selected.recordedRequestCount, records.length, provider);
      assert.equal(selected.knownTokenCount,
        records.reduce((sum, record) => sum + (record.tokens.total ?? 0), 0), provider);
    }
    const codexBase = await (await fetch(`${base}/api/v3/stats/codex?days=custom&from=${from}&to=${to}`)).json();
    const model = codexBase.availableModels.find(value => value.model.length > 0)?.model;
    assert.ok(model, 'frozen Codex source needs a recorded model');
    const modelReport = await (await fetch(`${base}/api/v3/stats/codex?days=custom&from=${from}&to=${to}&model=${encodeURIComponent(model)}`)).json();
    assert.equal(modelReport.usageRange.model, model);
    assert.ok(modelReport.overview.recordedRequestCount > 0);
    const codexSelected = modelReport.sessions.find(session => session.recordedRequestCount > 0);
    const modelProtocol = await (await fetch(`${base}/api/v3/protocol/codex/${encodeURIComponent(codexSelected.session.sessionId)}?version=3`)).json();
    assert.equal(codexSelected.recordedRequestCount, modelProtocol.usageRecords.filter(record =>
      record.model === model && record.timestamp !== null
      && new Date(record.timestamp).toISOString().slice(0, 10) >= from
      && new Date(record.timestamp).toISOString().slice(0, 10) <= to).length);
    assert.deepEqual(sourceFiles.map(sha), before);
  });

test('frozen Claude and Pi statistics exports preserve raw known and missing request usage',
  { timeout: 90_000, skip: !process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST }, async t => {
    const manifest = JSON.parse(readFileSync(process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST));
    const corpus = path.dirname(process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST);
    const sources = ['claude-code', 'pi'].map(provider => {
      const file = manifest.files.find(item => item.provider === provider && item.role === 'available-live');
      assert.ok(file, `frozen ${provider} source is required`);
      assert.equal(sha(file.snapshotPath), file.snapshotSha256);
      const rows = readFileSync(file.snapshotPath, 'utf8').trimEnd().split(/\r?\n/).map(JSON.parse);
      let request;
      if (provider === 'claude-code') {
        const usageRows = rows.filter(row => row.type === 'assistant' && row.message?.usage);
        assert.equal(usageRows.length, 5, 'frozen Claude sample has two response rows and three pending rows');
        const settled = usageRows.filter(row => row.message.usage.input_tokens > 0
          || row.message.usage.output_tokens > 0);
        assert.equal(settled.length, 2);
        assert.equal(new Set(settled.map(row => row.message.id)).size, 1,
          'two source rows belong to one response');
        assert.deepEqual(settled[0].message.usage, settled[1].message.usage);
        assert.ok(usageRows.filter(row => !settled.includes(row)).every(row =>
          row.message.usage.input_tokens === 0 && row.message.usage.output_tokens === 0));
        const raw = settled[0].message.usage;
        assert.equal(raw.total_tokens, undefined, 'the source does not record a request total');
        assert.equal(raw.output_tokens, 13, 'the source records inclusive output');
        assert.equal(raw.reasoning_tokens, undefined, 'the source does not record its reasoning subset');
        assert.equal(raw.reasoning_output_tokens, undefined);
        request = {
          day: settled[0].timestamp.slice(0, 10),
          // Inclusive output cannot establish disjoint output without its subset.
          tokens: { input: raw.input_tokens, output: null,
            reasoning: null, cacheRead: raw.cache_read_input_tokens,
            cacheWrite: raw.cache_creation_input_tokens, total: null },
        };
      } else {
        const settled = rows.filter(row => row.type === 'message'
          && row.message?.role === 'assistant' && row.message.usage);
        assert.equal(settled.length, 1);
        const raw = settled[0].message.usage;
        assert.equal(raw.totalTokens, raw.input + raw.output + raw.cacheRead + raw.cacheWrite);
        request = {
          day: settled[0].timestamp.slice(0, 10),
          tokens: { input: raw.input, output: raw.output - raw.reasoning,
            reasoning: raw.reasoning, cacheRead: raw.cacheRead,
            cacheWrite: raw.cacheWrite, total: raw.totalTokens },
        };
      }
      return { provider, file, request };
    });
    onCleanup(t, () => {
      for (const { provider, file } of sources) {
        assert.equal(sha(file.snapshotPath), file.snapshotSha256,
          `${provider} frozen source bytes remain unchanged`);
      }
    });
    const f = await fixture(t);
    for (const [flag, provider] of [['--claude-dir', 'claude-code'], ['--pi-dir', 'pi']]) {
      f.args[f.args.indexOf(flag) + 1] = path.join(corpus, provider);
    }
    const base = await serve(f);
    const csvColumns = { total: 'Total Tokens', input: 'Input Tokens',
      output: 'Output Tokens', reasoning: 'Reasoning Tokens',
      cacheRead: 'Cache Read Tokens', cacheWrite: 'Cache Write Tokens' };
    for (const { provider, file, request } of sources) {
      const query = new URLSearchParams({ days: 'custom', from: request.day, to: request.day });
      const endpoint = `${base}/api/v3/stats/${provider}`;
      const response = await fetch(`${endpoint}?${query}`);
      assert.equal(response.status, 200, provider);
      const report = await response.json();
      const known = request.tokens.total ?? 0;
      const unknown = request.tokens.total === null ? 1 : 0;
      assert.equal(report.overview.totalSessions, 1, provider);
      assert.equal(report.overview.recordedRequestCount, 1, provider);
      assert.equal(report.overview.knownTokenCount, known, provider);
      assert.equal(report.overview.unknownTokenRequestCount, unknown, provider);
      assert.equal(report.overview.totalTokens, null, provider);
      assert.equal(report.usageCoverage, 'partial', provider);
      assert.deepEqual(report.sessions.map(row => [row.session.sessionId,
        row.recordedRequestCount, row.knownTokenCount, row.unknownTokenRequestCount]),
      [[file.sessionId, 1, known, unknown]], provider);
      assert.equal(report.dailyUsage.length, 1, provider);
      const day = report.dailyUsage[0];
      assert.equal(day.day, request.day, provider);
      assert.equal(day.recordedRequestCount, 1, provider);
      assert.equal(day.knownTokenCount, known, provider);
      assert.equal(day.unknownTokenRequestCount, unknown, provider);
      for (const [key, value] of Object.entries(request.tokens)) {
        assert.equal(day[key === 'total' ? 'totalTokens' : `${key}Tokens`], value,
          `${provider} ${key}`);
      }
      const exported = await fetch(`${endpoint}/export.json?${query}`);
      assert.equal(exported.status, 200, provider);
      assert.deepEqual(await exported.json(), report, provider);
      const csv = await fetch(`${endpoint}/export.csv?${query}`);
      assert.equal(csv.status, 200, provider);
      assert.match(csv.headers.get('content-disposition'), /attachment;/);
      const lines = (await csv.text()).trimEnd().split(/\r?\n/);
      assert.equal(lines.length, 2, `${provider} exports one selected UTC day`);
      const [header, line] = lines
        .map(row => row.split(',').map(cell => cell.startsWith('"')
          ? cell.slice(1, -1).replaceAll('""', '"') : cell));
      const columns = Object.fromEntries(header.map((name, index) => [name, index]));
      assert.equal(line[columns['Day (UTC)']], request.day, provider);
      assert.equal(line[columns.Requests], '1', provider);
      assert.equal(line[columns['Known Token Count']], String(known), provider);
      assert.equal(line[columns['Unknown Token Request Count']], String(unknown), provider);
      assert.equal(line[columns['Unresolved Usage Observation Count']], '0', provider);
      for (const [key, name] of Object.entries(csvColumns)) {
        assert.equal(line[columns[name]], request.tokens[key] === null
          ? '' : String(request.tokens[key]), `${provider} CSV ${key}`);
      }
    }
  });

test('frozen Codex, OpenCode and DSH statistics match raw request ownership and missing fields',
  { timeout: 120_000, skip: !process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST }, async t => {
    const manifest = JSON.parse(readFileSync(process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST));
    const corpus = path.dirname(process.env.AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST);
    const codexFile = manifest.files.find(file => file.provider === 'codex'
      && file.role === 'long-team-compaction');
    const dshFile = manifest.files.find(file => file.provider === 'deepseek-harness'
      && file.role === 'native-v3-packed-compaction');
    assert.ok(codexFile && dshFile, 'frozen source roles are required');
    const sourceFiles = [manifest.database.snapshotPath, `${manifest.database.snapshotPath}-wal`,
      ...manifest.files.map(file => file.snapshotPath)];
    const hashOrNull = file => existsSync(file) ? sha(file) : null;
    const before = sourceFiles.map(hashOrNull);
    assert.equal(sha(codexFile.snapshotPath), codexFile.snapshotSha256);
    assert.equal(sha(dshFile.snapshotPath), dshFile.snapshotSha256);
    assert.equal(sha(manifest.database.snapshotPath), manifest.database.snapshotSha256);
    onCleanup(t, () => assert.deepEqual(sourceFiles.map(hashOrNull), before,
      'frozen provider source and OpenCode DB/WAL bytes remain unchanged'));

    const day = '2026-09-25';
    const codexRows = decodeSourceBytes(readFileSync(codexFile.snapshotPath)).records
      .map(record => record.value);
    assert.equal(codexRows[0].type, 'session_meta');
    assert.equal(codexRows[0].payload.id, codexFile.sessionId);
    const codexIndexed = codexRows.map((row, index) => ({ row, index }));
    const codexRequests = codexIndexed.filter(({ row }) => row.type === 'token_usage_record'
      && row.timestamp?.slice(0, 10) === day && row.payload?.usage?.total_tokens > 0);
    const legacySnapshots = codexIndexed.filter(({ row }) => row.type === 'event_msg'
      && row.payload?.type === 'token_count' && row.timestamp?.slice(0, 10) === day
      && row.payload.info?.last_token_usage?.total_tokens > 0);
    assert.equal(codexRequests.length, 38, 'bounded canonical Codex requests are present');
    assert.equal(new Set(codexRequests.map(({ row }) => row.payload.response_id)).size,
      codexRequests.length, 'one response ID owns each canonical request');
    assert.equal(legacySnapshots.length, 50, 'legacy token snapshots coexist with canonical records');
    const codexTotals = codexRequests.map(({ row }) => row.payload.usage);
    assert.ok(legacySnapshots.every(({ row, index }) => codexRequests.some(canonical =>
      canonical.index < index
      && JSON.stringify(canonical.row.payload.usage)
        === JSON.stringify(row.payload.info.last_token_usage)
      && JSON.stringify(canonical.row.payload.thread_token_usage)
        === JSON.stringify(row.payload.info.total_token_usage))),
    'later legacy rows repeat both request and cumulative canonical records');
    assert.ok(codexTotals.every(raw => raw.total_tokens === raw.input_tokens + raw.output_tokens));
    const codexExpected = {
      provider: 'codex', day, sessionId: codexFile.sessionId,
      count: codexTotals.length,
      known: codexTotals.reduce((sum, raw) => sum + raw.total_tokens, 0),
      unknown: 0,
      components: {
        inputTokens: codexTotals.reduce((sum, raw) => sum + raw.input_tokens
          - raw.cached_input_tokens - raw.cache_write_input_tokens, 0),
        outputTokens: codexTotals.reduce((sum, raw) => sum + raw.output_tokens
          - raw.reasoning_output_tokens, 0),
        reasoningTokens: codexTotals.reduce((sum, raw) => sum + raw.reasoning_output_tokens, 0),
        cacheReadTokens: codexTotals.reduce((sum, raw) => sum + raw.cached_input_tokens, 0),
        cacheWriteTokens: codexTotals.reduce((sum, raw) => sum + raw.cache_write_input_tokens, 0),
        totalTokens: codexTotals.reduce((sum, raw) => sum + raw.total_tokens, 0),
      },
    };

    const db = new DatabaseSync(manifest.database.snapshotPath, { readOnly: true });
    let openRows;
    try {
      openRows = db.prepare(`SELECT s.id AS session_id, m.data FROM session_message m
        JOIN session_v2 s ON s.id=m.session_id
        WHERE s.time_archived IS NULL AND m.type='assistant'
          AND m.time_created >= ? AND m.time_created < ?
          AND (s.fork_session_id IS NULL OR
            substr(m.id,-length(CAST(m.seq AS TEXT))-1) != '_' || m.seq)`)
        .all(Date.parse(`${day}T00:00:00Z`), Date.parse('2026-09-26T00:00:00Z'));
    } finally {
      db.close();
    }
    const openRequests = openRows.flatMap(row => {
      const raw = JSON.parse(row.data).tokens;
      if (!raw) return [];
      const fields = [raw.input, raw.output, raw.reasoning, raw.cache?.read, raw.cache?.write];
      const sum = fields.reduce((total, value) => total + (Number.isSafeInteger(value) && value >= 0 ? value : 0), 0);
      return sum > 0 ? [{ sessionId: row.session_id, total: raw.total === sum ? sum : null }] : [];
    });
    assert.ok(openRequests.length > 0, 'frozen OpenCode day has raw assistant requests');
    const openExpected = {
      provider: 'opencode', day, count: openRequests.length,
      known: openRequests.reduce((sum, request) => sum + (request.total ?? 0), 0),
      unknown: openRequests.filter(request => request.total === null).length,
      sessions: new Set(openRequests.map(request => request.sessionId)),
    };
    assert.ok(openExpected.unknown > 0, 'raw OpenCode requests retain missing totals');

    const dshRows = decodeSourceBytes(readFileSync(dshFile.snapshotPath)).records
      .map(record => record.value);
    assert.equal(dshRows[0].type, 'session');
    assert.equal(dshRows[0].version, 3);
    assert.equal(dshRows[0].id, dshFile.sessionId);
    assert.equal(dshRows[0].isSeeded, false);
    const dshDay = '2026-09-02';
    const settlements = dshRows.filter(row => row.type === 'assistant/message'
      && row.data?.usage && new Date(row.time).toISOString().slice(0, 10) === dshDay);
    assert.equal(settlements.length, 508, 'frozen DSH v3 has one settlement per recorded step');
    assert.equal(new Set(settlements.map(row => `${row.data.turn}:${row.data.step}`)).size,
      settlements.length, 'every DSH request owns a distinct turn/step slot');
    const dshTotals = settlements.map(row => row.data.usage);
    assert.ok(dshTotals.every(raw => raw.totalTokens === raw.inputTokens
      + raw.cacheReadTokens + raw.outputTokens));
    assert.ok(dshTotals.every(raw => raw.cacheWriteTokens === undefined),
      'cache writes are missing in the raw source');
    const dshExpected = {
      provider: 'deepseek-harness', day: dshDay, sessionId: dshFile.sessionId,
      count: dshTotals.length,
      known: dshTotals.reduce((sum, raw) => sum + raw.totalTokens, 0),
      unknown: 0,
      components: {
        inputTokens: dshTotals.reduce((sum, raw) => sum + raw.inputTokens, 0),
        outputTokens: dshTotals.reduce((sum, raw) => sum + raw.outputTokens - raw.reasoningTokens, 0),
        reasoningTokens: dshTotals.reduce((sum, raw) => sum + raw.reasoningTokens, 0),
        cacheReadTokens: dshTotals.reduce((sum, raw) => sum + raw.cacheReadTokens, 0),
        cacheWriteTokens: null,
        totalTokens: dshTotals.reduce((sum, raw) => sum + raw.totalTokens, 0),
      },
    };
    assert.equal(dshExpected.known, 102_197_093);

    const f = await fixture(t);
    for (const [flag, source] of [
      ['--opencode-db', manifest.database.snapshotPath],
      ['--codex-dir', path.join(corpus, 'codex')],
      ['--dsh-dir', path.join(corpus, 'deepseek-harness')],
    ]) f.args[f.args.indexOf(flag) + 1] = source;
    const base = await serve(f);
    for (const expected of [codexExpected, openExpected, dshExpected]) {
      await t.test(expected.provider, async () => {
        const query = new URLSearchParams({ days: 'custom', from: expected.day,
          to: expected.day, day: expected.day });
        const endpoint = `${base}/api/v3/stats/${expected.provider}`;
        const response = await fetch(`${endpoint}?${query}`);
        assert.equal(response.status, 200, expected.provider);
        const report = await response.json();
        assert.equal(report.overview.recordedRequestCount, expected.count, expected.provider);
        assert.equal(report.overview.knownTokenCount, expected.known, expected.provider);
        assert.equal(report.overview.unknownTokenRequestCount, expected.unknown, expected.provider);
        assert.equal(report.overview.totalTokens, null, expected.provider);
        const selected = report.dailyUsage.find(row => row.day === expected.day);
        assert.ok(selected, `${expected.provider} raw UTC day is present`);
        assert.equal(selected.recordedRequestCount, expected.count, expected.provider);
        assert.equal(selected.knownTokenCount, expected.known, expected.provider);
        assert.equal(selected.unknownTokenRequestCount, expected.unknown, expected.provider);
        assert.equal(selected.totalTokens, expected.components?.totalTokens ?? null,
          `${expected.provider} full-day total availability`);
        for (const [field, value] of Object.entries(expected.components ?? {})) {
          assert.equal(selected[field], value, `${expected.provider} ${field}`);
        }
        const used = report.sessions.filter(row => row.recordedRequestCount > 0);
        if (expected.sessionId) {
          assert.deepEqual(used.map(row => row.session.sessionId), [expected.sessionId],
            `${expected.provider} canonical source session ID`);
        } else {
          assert.deepEqual(new Set(used.map(row => row.session.sessionId)), expected.sessions,
            'OpenCode canonical source session IDs');
        }
        assert.equal(used.reduce((sum, row) => sum + row.recordedRequestCount, 0), expected.count);
        const jsonResponse = await fetch(`${endpoint}/export.json?${query}`);
        assert.equal(jsonResponse.status, 200, expected.provider);
        assert.match(jsonResponse.headers.get('content-disposition'), /attachment;/);
        assert.deepEqual(await jsonResponse.json(), report, expected.provider);
        const csvResponse = await fetch(`${endpoint}/export.csv?${query}`);
        assert.equal(csvResponse.status, 200, expected.provider);
        assert.match(csvResponse.headers.get('content-disposition'), /attachment;/);
        const [header, values] = (await csvResponse.text()).trimEnd().split(/\r?\n/)
          .map(line => line.split(',').map(cell => cell.startsWith('"')
            ? cell.slice(1, -1).replaceAll('""', '"') : cell));
        const csv = Object.fromEntries(header.map((name, index) => [name, values[index]]));
        assert.equal(csv['Day (UTC)'], expected.day, expected.provider);
        assert.equal(csv.Requests, String(expected.count), expected.provider);
        assert.equal(csv['Known Token Count'], String(expected.known), expected.provider);
        assert.equal(csv['Unknown Token Request Count'], String(expected.unknown), expected.provider);
        if (!expected.components) assert.equal(csv['Total Tokens'], '',
          'OpenCode missing request totals remain blank in CSV');
        for (const [field, label] of Object.entries({ totalTokens: 'Total Tokens',
          inputTokens: 'Input Tokens', outputTokens: 'Output Tokens',
          reasoningTokens: 'Reasoning Tokens', cacheReadTokens: 'Cache Read Tokens',
          cacheWriteTokens: 'Cache Write Tokens' })) {
          if (expected.components) assert.equal(csv[label], expected.components[field] === null
            ? '' : String(expected.components[field]), `${expected.provider} CSV ${field}`);
        }
      });
    }
  });
