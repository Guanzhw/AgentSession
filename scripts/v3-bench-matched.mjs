#!/usr/bin/env node

// Matched MCP search measurement. Raw records remain in ignored tmp/; the public
// summary contains only fixed labels, counts, hashes, timings, and error kinds.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { callMcpRaw, createCallEvidence, serializeError } from './v3-bench-call-evidence.mjs';

const format = 'agentsession-v3-matched-performance/v1';
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const byteLength = (value) => Buffer.byteLength(JSON.stringify(value));
const canonicalJson = (value) => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
  : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const safeKind = (error) => error?.code === 'BENCH_TIMEOUT' ? 'timeout'
  : /^[A-Za-z][A-Za-z0-9]*$/.test(error?.name || '') ? error.name : 'Error';

function parseArgs(argv) {
  const options = { manifest: path.join(scriptRoot, 'tmp/v3-performance/manifest.private.json'), timeoutMs: 120000 };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (flag === '--help') return { help: true };
    if (!['--manifest', '--arms', '--golden', '--output-dir', '--timeout-ms'].includes(flag) || !argv[i + 1]) {
      throw new Error(`Invalid or incomplete option: ${flag}`);
    }
    options[{ '--manifest': 'manifest', '--arms': 'arms', '--golden': 'golden', '--output-dir': 'outputDir', '--timeout-ms': 'timeoutMs' }[flag]] = argv[i + 1];
  }
  if (!options.arms || !options.outputDir) throw new Error('--arms and --output-dir are required');
  options.timeoutMs = Number(options.timeoutMs);
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000) throw new Error('--timeout-ms must be >= 1000');
  return options;
}

export function privateDir(input) {
  const tmp = path.join(scriptRoot, 'tmp');
  const output = path.resolve(input);
  if (!inside(tmp, output)) throw new Error('Output must be inside this checkout tmp/');
  mkdirSync(tmp, { recursive: true });
  if (!inside(realpathSync(scriptRoot), realpathSync(tmp))) throw new Error('tmp/ resolves outside checkout');
  let current = tmp;
  for (const piece of path.relative(tmp, output).split(path.sep)) {
    current = path.join(current, piece);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Output path contains a link');
  }
  if (existsSync(output)) throw new Error('Output directory already exists; choose a fresh run ID');
  execFileSync('git', ['-c', `safe.directory=${scriptRoot}`, '-C', scriptRoot, 'check-ignore', '--quiet', '--no-index', '--', output]);
  mkdirSync(output, { recursive: true });
  return output;
}

export function sourceStat(root, codex = false) {
  const base = codex ? path.join(root, 'sessions') : root;
  const hash = createHash('sha256');
  const contentHash = codex ? null : createHash('sha256');
  let fileCount = 0, totalBytes = 0;
  function addFile(full, relative) {
    const stat = statSync(full);
    hash.update(JSON.stringify([relative, stat.size, stat.mtimeMs]));
    if (contentHash) contentHash.update(relative).update('\0').update(sha(readFileSync(full))).update('\0');
    fileCount++;
    totalBytes += stat.size;
  }
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && (!codex || /\.jsonl(?:\.zst)?$/i.test(entry.name))) {
        addFile(full, path.relative(base, full).replaceAll('\\', '/'));
      }
    }
  }
  if (statSync(base).isFile()) {
    for (const file of [base, `${base}-wal`, `${base}-shm`]) {
      if (existsSync(file)) addFile(file, path.basename(file));
    }
  } else walk(base);
  return { fileCount, totalBytes, statManifestSha256: hash.digest('hex'),
    ...(contentHash ? { contentManifestSha256: contentHash.digest('hex') } : {}) };
}

export function artifactStat(paths) {
  const hash = createHash('sha256');
  let fileCount = 0;
  for (const [index, root] of paths.entries()) {
    const visit = (full, relative) => {
      const type = lstatSync(full);
      if (type.isSymbolicLink()) throw new Error('Artifact path contains a link');
      if (type.isDirectory()) {
        for (const entry of readdirSync(full).sort()) visit(path.join(full, entry), `${relative}/${entry}`);
      } else if (type.isFile()) {
        hash.update(relative).update('\0').update(sha(readFileSync(full))).update('\0');
        fileCount++;
      } else throw new Error('Artifact path is not a file or directory');
    };
    visit(root, String(index));
  }
  return { fileCount, sha256: hash.digest('hex') };
}

function readInput(manifestPath, armsPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const arms = JSON.parse(readFileSync(armsPath, 'utf8'));
  if (manifest.format !== 'agentsession-v3-performance-input/v1' || manifest.repetitions !== 5 ||
      manifest.pairedOrder?.join(',') !== 'v2,v3,v3,v2,v2,v3,v3,v2,v2,v3' ||
      manifest.queries?.length !== 9 || !['v2', 'v3'].every((key) => arms[key])) {
    throw new Error('Frozen manifest or arm configuration is incomplete');
  }
  if (path.resolve(manifest.codexRoot) !== path.resolve(manifest.providerRoots.codex?.path || '')) {
    throw new Error('Codex source root differs between manifest fields');
  }
  for (const query of manifest.queries) {
    if (sha(query.query) !== query.querySha256 || query.limit !== 20) throw new Error(`Query hash or limit changed: ${query.label}`);
  }
  for (const [name, root] of Object.entries(manifest.providerRoots)) {
    if (!existsSync(root.path)) throw new Error(`Provider source missing: ${name}`);
  }
  const codexStat = sourceStat(manifest.codexRoot, true);
  if (JSON.stringify(codexStat) !== JSON.stringify(manifest.codexStat)) throw new Error('Frozen Codex stat manifest changed');
  for (const [name, arm] of Object.entries(arms)) {
    if (!['v2', 'v3'].includes(name) || !path.isAbsolute(arm.command) || !path.isAbsolute(arm.cwd) ||
        !path.isAbsolute(arm.artifactPath) || !Array.isArray(arm.artifactPaths) || !arm.artifactPaths.length ||
        arm.artifactPaths.some((file) => typeof file !== 'string' || !path.isAbsolute(file)) ||
        !/^[0-9a-f]{64}$/.test(arm.artifactSha256 || '') ||
        !Array.isArray(arm.args) || arm.args.some((x) => typeof x !== 'string')) {
      throw new Error(`Invalid arm configuration: ${name}`);
    }
    if (name === 'v2' && arm.revision !== manifest.baselineSha) throw new Error('2.0 revision differs from frozen baseline');
    const actualRevision = execFileSync('git', ['-c', `safe.directory=${arm.cwd}`, '-C', arm.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (actualRevision !== arm.revision) throw new Error(`Arm revision differs from checkout: ${name}`);
    if (!arm.artifactPaths.includes(arm.artifactPath)) {
      throw new Error(`Arm artifact identity differs from hashed runtime paths: ${name}`);
    }
    if (!existsSync(arm.artifactPath)) throw new Error(`Arm artifact missing: ${name}`);
    for (const file of arm.artifactPaths) if (!existsSync(file)) throw new Error(`Arm runtime artifact missing: ${name}`);
  }
  return { manifest, arms, codexStat };
}

function expandArm(arm, manifest, state) {
  const roots = Object.fromEntries(Object.entries(manifest.providerRoots).map(([key, value]) => [key, value.path]));
  const replacements = { ...roots, metaPath: state.metaPath, configPath: state.configPath };
  const usedRoots = new Set();
  Object.assign(replacements, { metaDir: state.metaDir, indexDir: state.indexDir, cacheDir: state.cacheDir });
  const replace = (value) => value.replace(/\{(opencode|claude-code|codex|pi|deepseek-harness|metaPath|metaDir|indexDir|cacheDir|configPath)\}/g, (_, key) => {
    if (Object.hasOwn(roots, key)) usedRoots.add(key);
    return replacements[key];
  });
  const args = arm.args.map(replace);
  if (usedRoots.size !== 5) throw new Error('Each arm must receive all five frozen provider roots');
  return { command: arm.command, args, cwd: arm.cwd };
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Timed out'), { code: 'BENCH_TIMEOUT' })), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

function processMetrics(pid) {
  if (!pid) return null;
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$p=Get-Process -Id ${Number(pid)}; @{rssBytes=[long]$p.WorkingSet64;peakRssBytes=[long]$p.PeakWorkingSet64;cpuMs=$p.TotalProcessorTime.TotalMilliseconds}|ConvertTo-Json -Compress`], { encoding: 'utf8' }).trim();
      return JSON.parse(output);
    }
    if (process.platform === 'linux') {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const rssBytes = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]) * 1024;
      const peakRssBytes = Number(/^VmHWM:\s+(\d+)/m.exec(status)?.[1]) * 1024;
      const processStat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = processStat.slice(processStat.lastIndexOf(')') + 2).trim().split(' ');
      const ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }));
      const cpuMs = (Number(fields[11]) + Number(fields[12])) * 1000 / ticksPerSecond;
      return { rssBytes, peakRssBytes, cpuMs };
    }
  } catch { /* Process may already have exited. */ }
  return null;
}

function resultKey(match) {
  const session = match?.session;
  if (typeof session?.provider !== 'string' || typeof session?.sessionId !== 'string') throw new Error('Invalid canonical session reference');
  return [session.provider, session.sessionId, match?.event?.messageId ?? null,
    match?.event?.segment ?? null, match?.matchField ?? null, match?.matchRole ?? null];
}

export async function runTrial({ armName, repetition, manifest, arm, outputDir, timeoutMs }) {
  if (!path.isAbsolute(outputDir)) throw new Error('runTrial outputDir must be absolute');
  const queries = manifest.queries.map(query => ({ ...query,
    updatedBeforeUnixMs: manifest.updatedBeforeUnixMs }));
  const trialDir = path.join(outputDir, `rep-${repetition}-${armName}`);
  mkdirSync(trialDir);
  const state = { metaPath: path.join(trialDir, 'state/meta.db'), metaDir: path.join(trialDir, 'state/meta'),
    indexDir: path.join(trialDir, 'state/index'), cacheDir: path.join(trialDir, 'state/cache'),
    configPath: path.join(trialDir, 'config.json') };
  mkdirSync(path.dirname(state.metaPath), { recursive: true });
  writeFileSync(state.configPath, JSON.stringify(armName === 'v2' ? { mcp: { searchLimit: 20 } } : {}));
  const invocation = expandArm(arm, manifest, state);
  const profile = Object.fromEntries([['APPDATA', 'Roaming'], ['LOCALAPPDATA', 'Local'], ['USERPROFILE', 'Home']]
    .map(([key, folder]) => [key, path.join(trialDir, 'profile', folder)]));
  for (const directory of Object.values(profile)) mkdirSync(directory, { recursive: true });
  const childEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^AGENTSESSION_/i.test(key) && !/^PORT$/i.test(key))),
    ...profile, AGENTSESSION_META_PATH: state.metaPath, AGENTSESSION_CONFIG: state.configPath,
  };
  const evidence = createCallEvidence({ directory: path.join(trialDir, 'raw-calls') });
  const record = { arm: armName, repetition, status: 'failed', phases: [], queries: [], errors: [], retries: 0,
    statePath: trialDir, command: invocation, startedAtUtc: new Date().toISOString(),
    isolatedEnvironment: { ...profile, AGENTSESSION_META_PATH: state.metaPath, AGENTSESSION_CONFIG: state.configPath },
    stderrArtifacts: [],
    measurementBoundary: { searchWallMs: 'SDK dispatch to response or error, excluding synchronous request/terminal evidence writes',
      observerOverheadMs: 'Additional wall time around the SDK call, including synchronous evidence writes',
      answerReadyMs: 'Process connection to first response, including observer writes; OS cache is uncontrolled' } };
  const runProcess = async (phase) => {
    const transport = new StdioClientTransport({ ...invocation, env: childEnv, stderr: 'pipe' });
    let stderrBytes = 0;
    const stderrPath = path.join(trialDir, 'stderr', phase + '.private.log');
    mkdirSync(path.dirname(stderrPath), { recursive: true });
    writeFileSync(stderrPath, '', { flag: 'wx' });
    const stderrArtifact = { phase, relativePath: path.relative(trialDir, stderrPath).replaceAll('\\', '/'), bytes: 0 };
    record.stderrArtifacts.push(stderrArtifact);
    transport.stderr?.on('data', chunk => {
      appendFileSync(stderrPath, chunk);
      stderrBytes += chunk.length;
      stderrArtifact.bytes = stderrBytes;
    });
    const client = new Client({ name: 'agentsession-v3-matched-bench', version: '1.0.0' });
    const started = performance.now();
    const connectId = evidence.begin({ transport: 'mcp-lifecycle', service: armName, phase,
      tool: 'connect', command: invocation, timeoutMs });
    let connected = false, pid, exit, phaseRecord;
    const observeExit = () => {
      const child = transport._process;
      if (!child) return;
      pid = child.pid;
      // The pinned SDK owns this child; observe its exit before requesting close.
      exit ??= child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
        : new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    };
    try {
      await withTimeout(client.connect(transport), timeoutMs);
      const handshakeMs = performance.now() - started;
      observeExit();
      if (!exit) throw new Error('MCP child process handle unavailable');
      connected = true;
      evidence.finish(connectId, { outcome: 'response', response: { connected: true, pid }, wallMs: handshakeMs });
      const first = await search(client, queries[0], timeoutMs, undefined,
        { evidence, phase, service: armName, pid });
      phaseRecord = { pid, phase, handshakeMs, answerReadyMs: performance.now() - started,
        firstQuery: first, process: processMetrics(pid), stderrBytes, stderrRelativePath: stderrArtifact.relativePath };
      record.phases.push(phaseRecord);
      if (first.errorKind) throw Object.assign(new Error('First query failed'), { name: first.errorKind });
      return { client, transport, pid, exit, evidence, name: armName };
    } catch (error) {
      if (!connected) {
        try { evidence.finish(connectId, { outcome: 'error', error: serializeError(error), wallMs: performance.now() - started }); }
        catch (captureError) { error = new AggregateError([error, captureError], error.message, { cause: error }); }
      }
      record.errors.push({ phase, kind: safeKind(error), error: serializeError(error) });
      observeExit();
      await client.close().catch(() => transport.close().catch(() => {}));
      if (exit) {
        const observation = await withTimeout(exit, 5000).catch(() => ({ code: null, signal: null, observation: 'timeout' }));
        if (phaseRecord) phaseRecord.exit = observation;
        else (record.failedProcesses ??= []).push({ phase, pid, exit: observation });
      }
      return null;
    }
  };
  let session = await runProcess('fresh-build');
  if (session) {
    try {
      for (const query of queries) {
        const pages = [];
        const keys = [];
        const matches = [];
        const seen = new Set();
        const seenSessions = new Set();
        let cursor;
        do {
          const page = await search(session.client, query, timeoutMs, cursor,
            { evidence, phase: 'full-search', service: armName, pid: session.pid });
          pages.push(page.public);
          if (page.errorKind) throw Object.assign(new Error('Search failed'), { name: page.errorKind });
          if (page.keys.length === 0 && (cursor || page.nextCursor)) {
            throw Object.assign(new Error('Empty page with cursor'), { name: 'EmptyCursorPage' });
          }
          for (const key of page.keys) {
            const sessionKey = JSON.stringify(key.slice(0, 2));
            if (seenSessions.has(sessionKey)) throw Object.assign(new Error('Duplicate session'), { name: 'DuplicateResult' });
            seenSessions.add(sessionKey);
          }
          keys.push(...page.keys);
          matches.push(...page.matches);
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor)) throw Object.assign(new Error('Repeated cursor'), { name: 'RepeatedCursor' });
          if (cursor) seen.add(cursor);
          if (pages.length > 10000) throw Object.assign(new Error('Page cap reached'), { name: 'PageCap' });
        } while (cursor);
        const repeated = await search(session.client, query, timeoutMs, undefined,
          { evidence, phase: 'repeat-search', service: armName, pid: session.pid });
        if (repeated.errorKind || repeated.public.semanticHash !== pages[0].semanticHash) {
          throw Object.assign(new Error('Repeated first page changed'), { name: 'UnstableResult' });
        }
        record.queries.push({ label: query.label, querySha256: query.querySha256, count: keys.length,
          orderedKeySha256: sha(JSON.stringify(keys)), orderedSemanticSha256: sha(canonicalJson(matches)),
          pageCount: pages.length, pages, matches,
          repeat: repeated.public, complete: true });
      }
    } catch (error) { record.errors.push({ phase: 'search', kind: safeKind(error), error: serializeError(error) }); }
    record.phases.at(-1).processBeforeExit = processMetrics(session.pid);
    record.phases.at(-1).processCountObserved = 1;
    await session.client.close().catch(() => {});
    record.phases.at(-1).exit = await withTimeout(session.exit, 5000).catch(() => ({ code: null, signal: null, observation: 'timeout' }));
  }
  if (!record.errors.length) {
    session = await runProcess('unchanged-restart');
    if (session) {
      record.phases.at(-1).processBeforeExit = processMetrics(session.pid);
      record.phases.at(-1).processCountObserved = 1;
      await session.client.close().catch(() => {});
      record.phases.at(-1).exit = await withTimeout(session.exit, 5000).catch(() => ({ code: null, signal: null, observation: 'timeout' }));
    }
  }
  for (const phase of record.phases) {
    phase.readinessMatchesLater = phase.firstQuery?.public?.semanticHash === record.queries[0]?.pages[0]?.semanticHash;
    if (!phase.readinessMatchesLater) record.errors.push({ phase: phase.phase, kind: 'ReadinessResultMismatch' });
  }
  for (const artifact of record.stderrArtifacts) {
    const bytes = readFileSync(path.join(trialDir, artifact.relativePath));
    artifact.bytes = bytes.length;
    artifact.sha256 = sha(bytes);
  }
  record.rawEvidence = evidence.audit();
  if (!record.rawEvidence.ok) record.errors.push({ phase: 'evidence-audit', kind: 'IncompleteEvidence',
    issues: record.rawEvidence.issues });
  record.status = record.errors.length ? 'failed' : 'ok';
  record.completedAtUtc = new Date().toISOString();
  record.stateBytes = directoryBytes(path.dirname(state.metaPath));
  writeFileSync(path.join(trialDir, 'record.private.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function search(client, query, timeoutMs, cursor, context = {}) {
  const args = { query: query.query, providers: query.providers, fields: query.fields,
    limit: query.limit, updatedBefore: query.updatedBeforeUnixMs,
    ...(cursor ? { cursor } : {}) };
  const started = performance.now();
  let callWallMs;
  const measuredEvidence = context.evidence && {
    begin: request => context.evidence.begin(request),
    finish(id, terminal) {
      callWallMs = terminal.wallMs;
      return context.evidence.finish(id, terminal);
    },
  };
  try {
    const response = await callMcpRaw({ client, name: context.service, pid: context.pid, phase: context.phase },
      'session_search', args, timeoutMs, { evidence: measuredEvidence });
    const observedMs = performance.now() - started;
    const wallMs = callWallMs ?? observedMs;
    const observerOverheadMs = Math.max(0, observedMs - wallMs);
    const result = response.structuredContent?.result;
    if (response.isError || !Array.isArray(result?.matches) || !Array.isArray(result?.diagnostics) ||
        !(result.nextCursor === null || (typeof result.nextCursor === 'string' && result.nextCursor.length > 0)) ||
        result.truncated !== (result.nextCursor !== null) ||
        !query.providers.every((name) => result.diagnostics.some((d) => d.provider === name && d.status === 'ok'))) {
      throw Object.assign(new Error('Incomplete or invalid result'), { name: 'InvalidResult' });
    }
    const keys = result.matches.map(resultKey);
    return { keys, matches: result.matches, nextCursor: result.nextCursor, public: {
      wallMs, observerOverheadMs, inputPayloadBytes: byteLength(args), outputPayloadBytes: byteLength(response),
      count: keys.length, keyHash: sha(JSON.stringify(keys)), semanticHash: sha(canonicalJson(result.matches)),
      diagnostics: result.diagnostics.map((d) => ({ provider: d.provider, status: d.status })),
    } };
  } catch (error) {
    const observedMs = performance.now() - started;
    const wallMs = callWallMs ?? observedMs;
    return { errorKind: safeKind(error), error: serializeError(error), nextCursor: null, keys: [], public: {
      wallMs, observerOverheadMs: Math.max(0, observedMs - wallMs), errorKind: safeKind(error) } };
  }
}

function directoryBytes(root) {
  let total = 0;
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) total += statSync(file).size;
    }
  }
  walk(root);
  return total;
}

const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
const p95 = (values) => values.slice().sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

function publicSummary(records, manifest, corpusBefore, corpusAfter, arms, golden, artifactsBefore, artifactsAfter) {
  const byArm = Object.fromEntries(['v2', 'v3'].map((name) => [name, records.filter((r) => r.arm === name)]));
  const inputUnchanged = JSON.stringify(corpusBefore) === JSON.stringify(corpusAfter);
  const artifactsUnchanged = canonicalJson(artifactsBefore) === canonicalJson(artifactsAfter);
  const allOk = records.length === 10 && records.every((r) => r.status === 'ok');
  const matches = allOk && manifest.queries.every((query, index) => {
    const hashes = records.map((r) => r.queries[index]?.orderedSemanticSha256);
    return hashes.every((value) => value === hashes[0]);
  });
  const searchParityPassed = inputUnchanged && artifactsUnchanged && matches;
  const searchGoldenPassed = Boolean(artifactsUnchanged && golden?.verification?.status === 'source-verified'
    && canonicalJson(golden.providerStats) === canonicalJson(corpusBefore)
    && golden.queries.length === manifest.queries.length && manifest.queries.every((query, index) => {
      const expected = golden.queries[index];
      return expected.label === query.label && expected.querySha256 === query.querySha256 &&
        records.every((record) => record.queries[index]?.count === expected.count &&
          record.queries[index]?.orderedSemanticSha256 === expected.orderedSemanticSha256);
    }) && records.every((record) => record.phases.every((phase) =>
      phase.readinessMatchesLater && phase.firstQuery?.public?.semanticHash === golden.queries[0].firstPageSemanticSha256)));
  const verifiedReadiness = (record, phaseName) => {
    const phase = record.phases.find((item) => item.phase === phaseName);
    return phase?.readinessMatchesLater && golden &&
      phase.firstQuery.public.semanticHash === golden.queries[0]?.firstPageSemanticSha256
      ? phase.answerReadyMs : null;
  };
  const metrics = Object.fromEntries(['v2', 'v3'].map((name) => [name, {
    attempts: byArm[name].map((r) => ({ repetition: r.repetition, status: r.status,
      freshObservedFirstAnswerMs: r.phases.find((p) => p.phase === 'fresh-build')?.answerReadyMs ?? null,
      restartObservedFirstAnswerMs: r.phases.find((p) => p.phase === 'unchanged-restart')?.answerReadyMs ?? null,
      freshAnswerReadyMs: verifiedReadiness(r, 'fresh-build'),
      restartAnswerReadyMs: verifiedReadiness(r, 'unchanged-restart'),
      freshHandshakeMs: r.phases.find((p) => p.phase === 'fresh-build')?.handshakeMs ?? null,
      restartHandshakeMs: r.phases.find((p) => p.phase === 'unchanged-restart')?.handshakeMs ?? null,
      peakRssBytes: (() => {
        const samples = r.phases.flatMap((p) => [p.process?.peakRssBytes, p.processBeforeExit?.peakRssBytes].filter(Number.isFinite));
        return samples.length ? Math.max(...samples) : null;
      })(),
      cpuMs: r.phases.every((p) => Number.isFinite(p.processBeforeExit?.cpuMs))
        ? r.phases.reduce((sum, p) => sum + p.processBeforeExit.cpuMs, 0) : null,
      processCountObserved: r.phases.length,
      processExits: r.phases.map((p) => p.exit ?? null),
      stateBytes: r.stateBytes,
      mcpInputPayloadBytes: r.phases.reduce((sum, p) => sum + (p.firstQuery?.public?.inputPayloadBytes ?? 0), 0)
        + r.queries.reduce((sum, q) => sum + q.pages.reduce((n, p) => n + (p.inputPayloadBytes ?? 0), 0) + (q.repeat?.inputPayloadBytes ?? 0), 0),
      mcpOutputPayloadBytes: r.phases.reduce((sum, p) => sum + (p.firstQuery?.public?.outputPayloadBytes ?? 0), 0)
        + r.queries.reduce((sum, q) => sum + q.pages.reduce((n, p) => n + (p.outputPayloadBytes ?? 0), 0) + (q.repeat?.outputPayloadBytes ?? 0), 0),
      retries: r.retries,
      stderrArtifacts: r.stderrArtifacts,
      rawEvidence: { ok: r.rawEvidence.ok, calls: r.rawEvidence.calls, pending: r.rawEvidence.pending,
        counts: r.rawEvidence.counts, journalSha256: r.rawEvidence.journalSha256 },
      errors: r.errors.map((e) => e.kind) })),
    startup: Object.fromEntries(['fresh-build', 'unchanged-restart'].map((phase) => {
      const samples = byArm[name].map((r) => verifiedReadiness(r, phase)).filter(Number.isFinite);
      return [phase, { samples, medianMs: samples.length === 5 ? median(samples) : null,
        p95Ms: samples.length === 5 ? p95(samples) : null }];
    })),
    queries: manifest.queries.map((query, index) => {
      const samples = byArm[name].map((r) => r.queries[index]?.repeat?.wallMs).filter(Number.isFinite);
      return { label: query.label, samples, medianMs: samples.length === 5 ? median(samples) : null,
        p95Ms: samples.length === 5 ? p95(samples) : null,
        count: byArm[name][0]?.queries[index]?.count ?? null,
        orderedKeySha256: byArm[name][0]?.queries[index]?.orderedKeySha256 ?? null,
        orderedSemanticSha256: byArm[name][0]?.queries[index]?.orderedSemanticSha256 ?? null };
    })
  }]));
  return { format, generatedAtUtc: new Date().toISOString(), searchParityPassed, searchGoldenPassed,
    searchSpeedupEligible: searchParityPassed && searchGoldenPassed,
    input: { codexStat: corpusBefore.codex, providerStatSha256: Object.fromEntries(Object.entries(corpusBefore).map(([key, value]) => [key, value.statManifestSha256])),
      providerContentSha256: Object.fromEntries(Object.entries(corpusBefore).filter(([key]) => key !== 'codex').map(([key, value]) => [key, value.contentManifestSha256])),
      unchanged: inputUnchanged, queryLabels: manifest.queries.map((q) => ({ label: q.label, querySha256: q.querySha256 })),
      cacheLabel: manifest.cacheLabel, repetitions: manifest.repetitions, pairedOrder: manifest.pairedOrder,
      goldenSha256: golden ? sha(canonicalJson(golden)) : null },
    artifacts: Object.fromEntries(Object.entries(arms).map(([key, value]) => [key, {
      revision: value.revision, ...artifactsBefore[key] }])),
    artifactsUnchanged,
    metrics, measurementBoundary: {
      searchWallMs: 'SDK dispatch to response or error, excluding synchronous evidence writes; both arms use the same capture',
      observerOverheadMs: 'Additional per-call observer wall time is recorded on every raw page/repeat record',
      answerReadyMs: 'Observed connection to first response includes evidence writes; not directly equivalent to historical uninstrumented readiness',
    }, limitations: ['OS file cache was not controlled; source preflight reads non-Codex content and may warm file data and metadata.',
      'This runner measures stdio MCP search and process readiness. Browser, source changes, and parallel Web/MCP workloads need separate measurements.',
      'Process resource counters cover the MCP process; child processes and physical disk reads are not measured. Exit codes and signals come from the pinned MCP SDK child handle.'] };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('Usage: node scripts/v3-bench-matched.mjs --arms <private-json> --golden <private-json> --output-dir <fresh-tmp-dir> [--manifest <private-json>] [--timeout-ms 120000]');
    return;
  }
  const { manifest, arms } = readInput(options.manifest, options.arms);
  const golden = options.golden ? JSON.parse(readFileSync(options.golden, 'utf8')) : null;
  if (golden && (golden.format !== 'agentsession-v3-search-golden/v1' || !Array.isArray(golden.queries))) {
    throw new Error('Invalid independent search golden');
  }
  const resolvedOutput = path.resolve(options.outputDir);
  for (const root of Object.values(manifest.providerRoots)) {
    if (resolvedOutput === path.resolve(root.path) || inside(path.resolve(root.path), resolvedOutput)) {
      throw new Error('Output directory must be outside frozen provider sources');
    }
  }
  const outputDir = privateDir(options.outputDir);
  const corpus = () => Object.fromEntries(Object.entries(manifest.providerRoots).map(([name, root]) => [name, sourceStat(root.path, name === 'codex')]));
  const artifacts = () => Object.fromEntries(Object.entries(arms).map(([name, arm]) => [name, artifactStat(arm.artifactPaths)]));
  const before = corpus();
  const artifactsBefore = artifacts();
  for (const [name, arm] of Object.entries(arms)) {
    if (artifactsBefore[name].sha256 !== arm.artifactSha256) throw new Error(`Arm runtime artifact changed before run: ${name}`);
  }
  const records = [];
  for (let i = 0; i < manifest.pairedOrder.length; i++) {
    const armName = manifest.pairedOrder[i];
    const repetition = Math.floor(i / 2) + 1;
    records.push(await runTrial({ armName, repetition, manifest, arm: arms[armName], outputDir, timeoutMs: options.timeoutMs }));
    console.log(JSON.stringify({ attempt: i + 1, arm: armName, status: records.at(-1).status }));
  }
  const after = corpus();
  const artifactsAfter = artifacts();
  const summary = publicSummary(records, manifest, before, after, arms, golden, artifactsBefore, artifactsAfter);
  writeFileSync(path.join(outputDir, 'summary.public.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(path.join(outputDir, 'ledger.private.json'), `${JSON.stringify({ format, inputManifest: options.manifest,
    armConfig: options.arms, records: records.map((r) => ({ arm: r.arm, repetition: r.repetition,
      record: path.join(r.statePath, 'record.private.json') })) }, null, 2)}\n`);
  console.log(JSON.stringify({ searchParityPassed: summary.searchParityPassed,
    searchGoldenPassed: summary.searchGoldenPassed, searchSpeedupEligible: summary.searchSpeedupEligible }));
  if (!summary.searchSpeedupEligible) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Benchmark failed: ${safeKind(error)}`); process.exitCode = 1; });
}
