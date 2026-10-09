import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sourceStat } from '../../scripts/v3-bench-matched.mjs';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

// Opt-in, source-read-only acceptance for the frozen 840-file corpus.
// Required: AGENTSESSION_V3_RUN_PRIVATE_STATS840=1 and AGENTSESSION_V3_BIN.
// Optional: AGENTSESSION_V3_STATS_MANIFEST, AGENTSESSION_V3_BIN_SHA256,
// AGENTSESSION_V3_STATS_SOURCE_WITNESS. The performance manifest owns codexRoot
// and codexStat. Its optional anchoredSourcePair.sources, or the witness pack's
// sources, supplies exactly two {path, sha256} entries relative to codexRoot.
// This measures first/repeat Stats after a Library read. It is neither a cold
// disk benchmark nor a comparison with 2.0. No latency acceptance threshold.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const enabled = process.env.AGENTSESSION_V3_RUN_PRIVATE_STATS840 === '1';
const binary = process.env.AGENTSESSION_V3_BIN;
const manifestFile = process.env.AGENTSESSION_V3_STATS_MANIFEST ||
  path.join(repo, 'tmp/v3-performance/manifest.private.json');
const witnessFile = process.env.AGENTSESSION_V3_STATS_SOURCE_WITNESS ||
  path.join(repo, 'tmp/v3-delivery/codex-usage-witness-packs/04-same-id-multi-file.private.json');
const collision = 'codex_multiple_source_files_unmerged';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fileHash(file) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}
async function sourceIdentity(file) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const row = JSON.parse(line);
      assert.equal(row.type, 'session_meta', 'source begins with canonical metadata');
      assert.ok(typeof row.payload?.id === 'string' && row.payload.id.length > 0);
      return row.payload.id;
    }
    throw new Error('empty_source');
  } finally { lines.close(); stream.destroy(); }
}
function code(value) {
  return typeof value === 'string' && /^[a-z0-9_]{1,96}$/.test(value) ? value : 'unrecognized_code';
}
function diagnostics(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(row => ({ code: code(row.code),
    ...(Number.isSafeInteger(row.affectedSessions) ? { affectedSessions: row.affectedSessions } : {}),
    ...(Number.isSafeInteger(row.affectedSources) ? { affectedSources: row.affectedSources } : {}),
  }));
}

test('opt-in frozen 840-file Codex Library and Stats retain the anchored pair with two unresolved groups',
  { skip: !enabled && 'Set AGENTSESSION_V3_RUN_PRIVATE_STATS840=1 and AGENTSESSION_V3_BIN to opt in',
    timeout: 1_200_000 }, async t => {
    let phase = 'input';
    let scratch;
    let server;
    let closed;
    let sourceRoot;
    let pairFiles;
    let failure;
    const report = { schemaVersion: 1, kind: 'frozen-codex-840-stats-source-coverage',
      measuredAtUtc: new Date().toISOString(), passed: false,
      cacheCondition: 'fresh-isolated-state; provider-and-library-reads-before-stats; OS-cache-uncontrolled',
      requests: [], limits: ['No 2.0 comparison', 'No latency threshold',
        '840-file stat signature; content SHA only for the two anchored source files',
        'Inclusion and remaining-source coverage do not prove full-corpus request uniqueness'] };
    try {
      assert.ok(binary && existsSync(binary), 'explicit exact binary required');
      const manifestBytes = await readFile(manifestFile);
      const manifest = JSON.parse(manifestBytes);
      report.manifestSha256 = hash(manifestBytes);
      report.binarySha256 = await fileHash(binary);
      if (process.env.AGENTSESSION_V3_BIN_SHA256)
        assert.equal(report.binarySha256, process.env.AGENTSESSION_V3_BIN_SHA256);
      sourceRoot = await realpath(manifest.codexRoot);
      assert.equal(manifest.codexStat.fileCount, 840, 'frozen inventory size');
      report.statBefore = sourceStat(sourceRoot, true);
      assert.deepEqual(report.statBefore, manifest.codexStat, 'frozen inventory signature');

      let pair = manifest.anchoredSourcePair;
      if (!pair) {
        const witnessBytes = await readFile(witnessFile);
        pair = JSON.parse(witnessBytes);
        report.witnessSha256 = hash(witnessBytes);
      }
      assert.equal(pair.sources.length, 2, 'two source witnesses required');
      pairFiles = await Promise.all(pair.sources.map(async entry => {
        assert.ok(typeof entry.path === 'string' && !path.isAbsolute(entry.path), 'relative witness path');
        assert.match(entry.sha256, /^[0-9a-f]{64}$/);
        const file = await realpath(path.resolve(sourceRoot, entry.path));
        const relative = path.relative(sourceRoot, file);
        assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) &&
          !path.isAbsolute(relative), 'witness belongs to frozen source root');
        return file;
      }));
      assert.equal(new Set(pairFiles).size, 2, 'distinct witnessed sources');
      report.pairBefore = await Promise.all(pairFiles.map(fileHash));
      assert.deepEqual(report.pairBefore, pair.sources.map(entry => entry.sha256), 'witness content hashes');
      const identities = await Promise.all(pairFiles.map(sourceIdentity));
      assert.equal(identities[0], identities[1], 'anchored sources share canonical identity');
      const anchoredId = identities[0];
      report.anchoredSessionIdSha256 = hash(anchoredId);

      await mkdir(path.join(repo, 'tmp'), { recursive: true });
      scratch = await mkdtemp(path.join(repo, 'tmp', 'v3-stats-840-real-'));
      const state = Object.fromEntries(['meta', 'index', 'cache', 'claude', 'pi', 'dsh']
        .map(name => [name, path.join(scratch, name)]));
      await Promise.all(Object.values(state).map(dir => mkdir(dir)));
      const config = path.join(scratch, 'config.json');
      await writeFile(config, '{}\n');
      const port = await freeFetchSafePort();
      const origin = `http://127.0.0.1:${port}`;
      server = spawn(binary, ['--config', config, 'serve', '--port', String(port),
        '--codex-dir', sourceRoot, '--opencode-db', path.join(scratch, 'absent.db'),
        '--claude-dir', state.claude, '--pi-dir', state.pi, '--dsh-dir', state.dsh,
        '--meta-dir', state.meta, '--index-dir', state.index, '--cache-dir', state.cache,
        '--disable-terminal-launch'], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let spawnFailed = false;
      closed = new Promise(resolve => {
        server.once('error', () => { spawnFailed = true; resolve(); });
        server.once('close', resolve);
      });
      server.stdout.resume(); server.stderr.resume();
      report.ownedProcess = { pid: server.pid, port };
      phase = 'startup';
      // Readiness uses the static root, so measured /api/providers is not warmed
      // by repeated expensive source inventory probes.
      let ready = false;
      for (let attempt = 0; attempt < 1200; attempt++) {
        assert.ok(!spawnFailed && server.exitCode === null, 'owned process remains running');
        try {
          const response = await fetch(origin + '/', { signal: AbortSignal.timeout(1000) });
          ready = response.ok;
          await response.arrayBuffer();
        } catch { /* Startup has not completed. */ }
        if (ready) break;
        await sleep(100);
      }
      assert.ok(ready, 'isolated service is ready');
      async function request(label, route) {
        const started = performance.now();
        const entry = { label };
        report.requests.push(entry);
        try {
          const response = await fetch(origin + route, { signal: AbortSignal.timeout(300_000) });
          const bytes = Buffer.from(await response.arrayBuffer());
          Object.assign(entry, { status: response.status, bytes: bytes.length, sha256: hash(bytes),
            wallMs: Math.round((performance.now() - started) * 1000) / 1000 });
          const body = JSON.parse(bytes.toString('utf8'));
          if (body?.error?.code) entry.errorCode = code(body.error.code);
          assert.equal(response.status, 200, 'read-only response status');
          return body;
        } catch {
          entry.wallMs ??= Math.round((performance.now() - started) * 1000) / 1000;
          entry.failed = true;
          throw new Error('request_failed');
        }
      }
      phase = 'providers';
      const providers = await request('providers', '/api/providers');
      const provider = providers.find(row => row.id === 'codex');
      assert.equal(provider?.available, true);
      report.provider = { available: provider.available,
        sourceDiagnostics: diagnostics(provider.storageDiagnostic?.sourceDiagnostics) };
      assert.deepEqual(report.provider.sourceDiagnostics,
        [{ code: collision, affectedSessions: 2 }], 'provider reports two remaining unresolved groups');

      phase = 'library';
      const sessions = await request('codex-library-identities', '/api/v3/sessions?provider=codex');
      assert.ok(Array.isArray(sessions));
      const ids = sessions.map(row => row.session.sessionId);
      assert.equal(ids.length, new Set(ids).size, 'one Library row per canonical ID');
      const unresolved = sessions.filter(row => row.diagnostic === collision);
      const anchored = sessions.filter(row => row.session.sessionId === anchoredId);
      assert.equal(unresolved.length, 2, 'remaining unmerged Library groups');
      assert.equal(anchored.length, 1, 'anchored pair has one canonical Library row');
      assert.ok(!anchored[0].diagnostic, 'anchored pair is readable');
      report.library = { canonicalSessions: sessions.length, remainingUnmergedGroups: unresolved.length,
        anchoredPairIncluded: true, canonicalIdsSha256: hash(JSON.stringify([...ids].sort())),
        diagnosticCounts: [...new Set(sessions.map(row => row.diagnostic).filter(Boolean))]
          .map(value => ({ code: code(value), count: sessions.filter(row => row.diagnostic === value).length })) };

      phase = 'stats-first-repeat';
      report.stats = [];
      for (const label of ['stats-first-after-library', 'stats-repeat']) {
        const body = await request(label, '/api/v3/stats/codex?days=30&scope=all');
        const sourceDiagnostics = diagnostics(body.sourceDiagnostics);
        const included = body.sessions.filter(row => row.session.sessionId === anchoredId);
        assert.equal(included.length, 1, 'anchored pair included in Stats scope');
        assert.equal(body.overview.excludedSourceSessionCount, 2, 'two uncovered source sessions');
        assert.deepEqual(sourceDiagnostics, [{ code: collision, affectedSessions: 2 }]);
        assert.equal(body.sourceDiagnosticsTruncated, false);
        assert.equal(body.coverage, 'partial');
        assert.equal(body.usageCoverage, 'partial');
        assert.equal(body.overview.totalSessions, body.sessions.length);
        assert.equal(body.overview.totalSessions + body.overview.excludedSourceSessionCount, sessions.length);
        assert.ok(unresolved.every(row => !body.sessions.some(item => item.session.sessionId === row.session.sessionId)),
          'unmerged groups are excluded rather than silently counted');
        report.stats.push({ label, includedSourceSessions: body.overview.totalSessions,
          excludedSourceSessions: body.overview.excludedSourceSessionCount,
          recordedRequestCount: body.overview.recordedRequestCount,
          knownTokenCount: body.overview.knownTokenCount,
          unknownTokenRequestCount: body.overview.unknownTokenRequestCount,
          unresolvedUsageObservationCount: body.overview.unresolvedUsageObservationCount,
          coverage: body.coverage, usageCoverage: body.usageCoverage, sourceDiagnostics,
          sourceDiagnosticsTruncated: body.sourceDiagnosticsTruncated,
          anchoredPairIncluded: true,
          anchoredPairRecordedRequestCount: included[0].recordedRequestCount,
          anchoredPairUnresolvedUsageObservationCount: included[0].unresolvedUsageObservationCount });
      }
      const statsResponses = report.requests.filter(row => row.label.startsWith('stats-'));
      assert.equal(statsResponses[0].sha256, statsResponses[1].sha256, 'first and repeated response hashes agree');
      assert.equal(statsResponses[0].bytes, statsResponses[1].bytes);
      report.passed = true;
    } catch {
      failure = `frozen_stats840_failed_at_${phase}`;
      report.failureCode = failure;
    } finally {
      if (server && server.exitCode === null && server.signalCode === null) server.kill();
      if (closed) await closed;
      report.ownedProcessClosed = !server || server.exitCode !== null || server.signalCode !== null;
      try {
        if (sourceRoot && report.statBefore) {
          report.statAfter = sourceStat(sourceRoot, true);
          report.statUnchanged = JSON.stringify(report.statBefore) === JSON.stringify(report.statAfter);
        }
        if (pairFiles && report.pairBefore) {
          report.pairAfter = await Promise.all(pairFiles.map(fileHash));
          report.pairUnchanged = JSON.stringify(report.pairBefore) === JSON.stringify(report.pairAfter);
        }
        if (report.binarySha256) report.binaryUnchanged = report.binarySha256 === await fileHash(binary);
      } catch { report.integrityCheckFailed = true; }
      const integrity = report.statUnchanged === true && report.pairUnchanged === true &&
        report.binaryUnchanged === true && !report.integrityCheckFailed;
      report.passed = report.passed && integrity && report.ownedProcessClosed;
      if (scratch) {
        await writeFile(path.join(scratch, 'evidence.public.json'), JSON.stringify(report, null, 2) + '\n');
        t.diagnostic(`Redacted evidence: tmp/${path.basename(scratch)}/evidence.public.json`);
      }
      if (!integrity && !failure) failure = 'frozen_stats840_integrity_failed';
      if (!report.ownedProcessClosed && !failure) failure = 'frozen_stats840_process_cleanup_failed';
    }
    assert.ok(!failure, failure);
  });
