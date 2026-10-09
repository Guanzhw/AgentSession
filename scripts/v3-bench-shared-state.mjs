#!/usr/bin/env node

// Exact-package, five-repetition Web + two stdio MCP resource exercise.
// All provider roots are read-only; only the fresh ignored output tree is written.
import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { sourceStat } from './v3-bench-matched.mjs';
import { createCallEvidence, callMcpRaw, callHttpRaw, serializeError, settleCalls, classifyCallError, childExitSnapshot } from './v3-bench-call-evidence.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const providers = ['opencode', 'claude-code', 'codex', 'pi', 'deepseek-harness'];
const flags = ['--opencode-db', '--claude-dir', '--codex-dir', '--pi-dir', '--dsh-dir'];
const format = 'agentsession-v3-shared-state-exercise/v1';
const sha = value => createHash('sha256').update(value).digest('hex');
const kind = classifyCallError;
const inside = (root, file) => { const rel = path.relative(root, file); return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const timeout = async (promise, ms) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Timed out'), { code: 'BENCH_TIMEOUT' })), ms); })]); } finally { clearTimeout(timer); } };
const json = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

export function validateInputs({ manifest, exe, expectedSha256, outputDir, queryLabel }) {
  if (manifest?.format !== 'agentsession-v3-performance-input/v1' || manifest.repetitions !== 5 ||
      providers.some(name => typeof manifest.providerRoots?.[name]?.path !== 'string') ||
      Object.keys(manifest.providerRoots).length !== 5) throw new Error('Frozen five-provider manifest required');
  const query = manifest.queries?.find(item => item.label === queryLabel);
  if (!query || typeof query.query !== 'string' || sha(query.query) !== query.querySha256 || query.limit !== 20 ||
      !Array.isArray(query.providers) || ![1, 5].includes(query.providers.length) ||
      query.providers.some(name => !providers.includes(name)) ||
      (query.providers.length === 5 && JSON.stringify(query.providers) !== JSON.stringify(providers)) ||
      !Array.isArray(query.fields) || query.fields.length === 0 || query.fields.some(field => typeof field !== 'string')) {
    throw new Error('Frozen Web-compatible query mismatch');
  }
  if (!path.isAbsolute(exe) || !existsSync(exe) || !/^[0-9a-f]{64}$/.test(expectedSha256) ||
      sha(readFileSync(exe)) !== expectedSha256) throw new Error('Exact packaged executable hash mismatch');
  if (!path.isAbsolute(outputDir) || !inside(path.join(repo, 'tmp'), outputDir)) throw new Error('Output must be a fresh absolute checkout tmp/ descendant');
  if (existsSync(outputDir)) throw new Error('Output directory already exists');
  if (providers.some(name => !path.isAbsolute(manifest.providerRoots[name].path))) throw new Error('Provider roots must be absolute');
  const roots = providers.map(name => path.resolve(manifest.providerRoots[name].path));
  for (const root of roots) {
    if (!existsSync(root) || outputDir === root || inside(root, outputDir) || inside(outputDir, root)) throw new Error('Output and provider sources must be separate');
  }
  if (path.resolve(manifest.codexRoot) !== roots[2]) throw new Error('Codex roots disagree');
  return query;
}

export function createOutput(outputDir) {
  const tmp = path.join(repo, 'tmp');
  mkdirSync(tmp, { recursive: true });
  if (!inside(realpathSync(repo), realpathSync(tmp))) throw new Error('tmp resolves outside checkout');
  let part = tmp;
  for (const piece of path.relative(tmp, outputDir).split(path.sep)) {
    part = path.join(part, piece);
    if (existsSync(part) && lstatSync(part).isSymbolicLink()) throw new Error('Output path contains link');
  }
  if (existsSync(outputDir)) throw new Error('Output directory already exists');
  execFileSync('git', ['-C', repo, 'check-ignore', '--quiet', '--no-index', '--', outputDir]);
  mkdirSync(outputDir, { recursive: true });
}

function sourceSnapshot(manifest) {
  return Object.fromEntries(providers.map(name => [name, sourceStat(manifest.providerRoots[name].path, name === 'codex')]));
}

function files(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Derived state contains link');
    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
  });
}

function stateSizes(state) {
  return Object.fromEntries(Object.entries(state).map(([name, root]) => [name, {
    bytes: files(root).reduce((n, file) => n + statSync(file).size, 0),
    fileCount: files(root).length,
  }]));
}

function sqliteEvidence(indexDir) {
  const dbs = files(indexDir).filter(file => /\.sqlite$/i.test(file));
  return { databaseCount: dbs.length, databases: dbs.map(file => {
    const python = ['import json,sqlite3,sys', 'c=sqlite3.connect("file:"+sys.argv[1].replace("\\\\","/")+"?mode=ro",uri=True)',
      'print(json.dumps({"quickCheck":c.execute("PRAGMA quick_check").fetchone()[0],"catalogRevisions":c.execute("SELECT provider,revision FROM catalog_state ORDER BY provider").fetchall(),"searchVersions":c.execute("SELECT provider,version FROM search_doc_state ORDER BY provider").fetchall()}))'].join('\n');
    return JSON.parse(execFileSync('python', ['-c', python, file], { encoding: 'utf8', timeout: 10000 }));
  }) };
}

async function samplePids(pids) {
  if (process.platform === 'win32') {
    const command = `$ids=@(${pids.join(',')}); @((Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { @{pid=$_.Id;rssBytes=[long]$_.WorkingSet64;peakRssBytes=[long]$_.PeakWorkingSet64;cpuMs=$_.TotalProcessorTime.TotalMilliseconds} })) | ConvertTo-Json -Compress`;
    return await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 }, (error, stdout) => error ? reject(error) : resolve([].concat(JSON.parse(stdout || '[]')))));
  }
  if (process.platform === 'linux') {
    const ticks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }));
    return pids.flatMap(pid => {
      try {
        const status = readFileSync(`/proc/${pid}/status`, 'utf8');
        const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const stat = raw.slice(raw.lastIndexOf(')') + 2).trim().split(' ');
        return [{ pid, rssBytes: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]) * 1024,
          peakRssBytes: Number(/^VmHWM:\s+(\d+)/m.exec(status)?.[1]) * 1024,
          cpuMs: (Number(stat[11]) + Number(stat[12])) * 1000 / ticks }];
      } catch { return []; }
    });
  }
  throw new Error('Resource sampling supports Windows and Linux');
}

export function summarizeSamples(samples, expectedPids) {
  const ordered = [...expectedPids].sort((a, b) => a - b).join(',');
  const complete = samples.filter(item => item.processes.length === 3 &&
    item.processes.map(p => p.pid).sort((a, b) => a - b).join(',') === ordered &&
    item.processes.every(p => Number.isFinite(p.rssBytes) && p.rssBytes > 0 && Number.isFinite(p.cpuMs)));
  const peak = complete.reduce((n, item) => Math.max(n, item.processes.reduce((sum, p) => sum + p.rssBytes, 0)), 0);
  return { sampleCount: samples.length, completeThreePidSamples: complete.length,
    peakSameTimeRssBytes: complete.length ? peak : null,
    perProcess: Object.fromEntries(expectedPids.map(pid => [pid, {
      peakRssBytes: Math.max(0, ...samples.flatMap(s => s.processes.filter(p => p.pid === pid).map(p => p.peakRssBytes))),
      lastCpuMs: samples.flatMap(s => s.processes.filter(p => p.pid === pid).map(p => p.cpuMs)).at(-1) ?? null,
    }])) };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitWeb(origin, item, ms) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    if (item.spawnError) throw item.spawnError;
    if (item.child.exitCode !== null) throw new Error('Web exited before readiness');
    try { const r = await fetch(`${origin}/api/providers`, { signal: AbortSignal.timeout(1000) }); await r.body?.cancel(); if (r.ok) return; } catch {}
    await delay(100);
  }
  throw Object.assign(new Error('Web readiness timeout'), { code: 'BENCH_TIMEOUT' });
}

function cursorInfo(token) {
  if (!token) return null;
  const parsed = JSON.parse(token);
  if (typeof parsed.scope !== 'string' || typeof parsed.revision !== 'string') throw new Error('Cursor lacks scope or revision');
  return { scopeSha256: sha(parsed.scope), revisionSha256: sha(parsed.revision), cursorSha256: sha(token) };
}

function resultSummary(result, type, expectedProviders = providers) {
  const rows = type === 'search' ? result.matches : result.sessions;
  if (!Array.isArray(rows) || !Array.isArray(result.diagnostics) ||
      !expectedProviders.every(name => result.diagnostics.some(d => d.provider === name && d.status === 'ok'))) throw new Error('Incomplete provider result');
  const keys = rows.map(row => { const ref = row.session; if (!providers.includes(ref?.provider) || typeof ref.sessionId !== 'string') throw new Error('Invalid canonical reference');
    return type === 'search' ? [ref.provider, ref.sessionId, row.event?.messageId ?? null, row.event?.segment ?? null, row.matchField ?? null] : [ref.provider, ref.sessionId]; });
  return { count: keys.length, orderedKeySha256: sha(JSON.stringify(keys)), nextCursor: result.nextCursor ?? null,
    cursor: cursorInfo(result.nextCursor), diagnostics: result.diagnostics.map(d => ({ provider: d.provider, status: d.status })) };
}

export async function mcpCall(session, tool, args, ms) {
  const started = performance.now();
  let response;
  try {
    response = await callMcpRaw(session, tool, args, ms);
  } catch (error) {
    try {
      session.capture?.({ tool, args, error: { name: error.name, message: error.message, code: error.code, data: error.data },
        wallMs: performance.now() - started });
    } catch (captureError) {
      throw new AggregateError([error, captureError], error.message, { cause: error });
    }
    throw error;
  }
  session.capture?.({ tool, args, response, wallMs: performance.now() - started });
  if (response.isError || !response.structuredContent?.result) throw new Error(`${tool} failed`);
  return response.structuredContent.result;
}

async function webSearch(origin, query, cursor, ms, context) {
  const params = new URLSearchParams({ q: query.query, fields: query.fields.join(','), limit: String(query.limit) });
  if (query.providers.length === 1) params.set('provider', query.providers[0]);
  if (cursor) params.set('cursor', cursor);
  const response = await callHttpRaw(`${origin}/api/v3/search?${params}`, {}, { ...context, timeoutMs: ms });
  if (!response.ok) throw new Error(`Web search HTTP ${response.status}`);
  return JSON.parse(response.text);
}

export async function connectOwnedMcp(item, timeoutMs) {
  // Observe rejection before PID polling; a timeout must also consume a later rejection.
  let outcome;
  const connecting = Promise.resolve(item.client.connect(item.transport)).then(
    value => { outcome = { value }; }, error => { outcome = { error }; });
  const started = performance.now();
  const pidTimeoutMs = Math.min(15000, timeoutMs);
  while (!item.transport.pid && performance.now() - started < pidTimeoutMs) {
    if (outcome && 'error' in outcome) throw outcome.error;
    await delay(5);
  }
  if (!item.transport.pid) {
    if (outcome && 'error' in outcome) throw outcome.error;
    throw Object.assign(new Error('MCP PID timeout'), { code: 'BENCH_TIMEOUT' });
  }
  item.child = item.transport._process;
  if (!item.child) throw new Error('MCP child handle unavailable');
  item.closed = item.child.exitCode !== null || item.child.signalCode !== null
    ? Promise.resolve({ code: item.child.exitCode, signal: item.child.signalCode })
    : new Promise(resolve => item.child.once('close', (code, signal) => resolve({ code, signal })));
  await timeout(connecting, Math.max(1, timeoutMs - (performance.now() - started)));
  if (outcome && 'error' in outcome) throw outcome.error;
}

export async function stopChildren(children) {
  for (const item of [...children].reverse()) {
    const child = item.child ?? item.transport?._process;
    const closed = item.closed ?? (child && child.exitCode === null && child.signalCode === null
      ? new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))) : null);
    try { await timeout(item.client?.close() ?? Promise.resolve(), 2000); } catch {}
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (closed) {
      try { await timeout(closed, 3000); } catch {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        try { await timeout(closed, 3000); } catch {}
      }
    }
  }
  return children.every(item => {
    const child = item.child ?? item.transport?._process;
    return !child || child.exitCode !== null || child.signalCode !== null;
  });
}

export async function runRepetition(number, options, manifest, query, output) {
  const dir = path.join(output, `rep-${number}`);
  mkdirSync(dir);
  const state = Object.fromEntries(['meta', 'index', 'cache'].map(name => [name, path.join(dir, 'state', name)]));
  Object.values(state).forEach(folder => mkdirSync(folder, { recursive: true }));
  const config = path.join(dir, 'config.json');
  json(config, { mcp: { searchLimit: 20 } });
  const sourceArgs = providers.flatMap((name, i) => [flags[i], manifest.providerRoots[name].path]);
  const stateArgs = ['--meta-dir', state.meta, '--index-dir', state.index, '--cache-dir', state.cache];
  const common = ['--config', config];
  const shadow = Object.fromEntries(['APPDATA', 'LOCALAPPDATA', 'USERPROFILE'].map(name =>
    [name, path.join(dir, 'shadow-environment', name.toLowerCase())]));
  Object.values(shadow).forEach(folder => mkdirSync(folder, { recursive: true }));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^AGENTSESSION_/i.test(name))), ...shadow };
  const record = { repetition: number, status: 'failed', phases: [], errors: [], startedAtUtc: new Date().toISOString(),
    statePaths: state, processIds: [], samples: [], stateSizes: [] };
  record.rawCallDir = path.join(dir, 'raw-calls');
  const evidence = createCallEvidence({ directory: record.rawCallDir });
  const callContext = { evidence, phase: () => record.activePhase ?? 'startup' };
  const httpContext = () => ({ ...callContext, pid: record.currentWebPid });
  const children = [];
  let sampler;
  try {
    const port = await freePort();
    record.port = port;
    const origin = `http://127.0.0.1:${port}`;
    const web = spawn(options.exe, [...common, 'serve', '--port', String(port), '--disable-terminal-launch', ...sourceArgs, ...stateArgs],
      { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const webItem = { name: 'web', child: web, closed: new Promise(resolve => web.once('close', (code, signal) => resolve({ code, signal }))) };
    web.once('error', error => { webItem.spawnError = error; });
    children.push(webItem);
    record.currentWebPid = web.pid;
    web.stderr.on('data', chunk => writeFileSync(path.join(dir, 'web.stderr.private.log'), chunk, { flag: 'a' }));
    let mcp = ['mcp-a', 'mcp-b'].map(name => {
      const transport = new StdioClientTransport({ command: options.exe, args: [...common, 'mcp', ...sourceArgs, ...stateArgs], cwd: repo, env, stderr: 'pipe' });
      const client = new Client({ name: 'agentsession-v3-shared-state-exercise', version: '1.0.0' });
      const item = { name, transport, client, child: null, closed: null, ...callContext };
      children.push(item);
      transport.stderr?.on('data', chunk => writeFileSync(path.join(dir, `${name}.stderr.private.log`), chunk, { flag: 'a' }));
      return item;
    });
    const connects = mcp.map(item => connectOwnedMcp(item, options.timeoutMs));
    await timeout(settleCalls([waitWeb(origin, webItem, options.timeoutMs), ...connects]), options.timeoutMs);
    record.processIds = children.map(item => item.child.pid);
    let currentPids = record.processIds;
    const sample = async () => {
      try { record.samples.push({ atMs: performance.now(), processes: await samplePids(currentPids) }); }
      catch (error) { record.errors.push({ phase: 'sampling', kind: kind(error) }); }
    };
    await sample();
    sampler = setInterval(() => { if (!sampler.running) { sampler.running = true; sample().finally(() => { sampler.running = false; }); } }, options.sampleMs);
    const browseArgs = { level: 'sessions', providers, limit: 1 };
    const searchArgs = { query: query.query, providers: query.providers, fields: query.fields, limit: query.limit };
    const phase = async name => {
      record.activePhase = name;
      const started = performance.now();
      const first = await settleCalls([
        webSearch(origin, query, null, options.timeoutMs, httpContext()),
        ...mcp.map(item => mcpCall(item, 'session_search', searchArgs, options.timeoutMs)),
        ...mcp.map(item => mcpCall(item, 'session_browse', browseArgs, options.timeoutMs)),
      ]);
      const search = first.slice(0, 3).map(result => resultSummary(result, 'search', query.providers));
      const browse = first.slice(3).map(result => resultSummary(result, 'browse'));
      record.pendingPhase = { name, search: search.map(({ nextCursor, ...safe }) => safe),
        browse: browse.map(({ nextCursor, ...safe }) => safe) };
      for (const [i, result] of first.slice(0, 3).entries()) {
        if (!result.nextCursor) throw new Error(`Search continuation missing for service ${i}`);
      }
      for (const [i, result] of first.slice(3).entries()) {
        if (!result.nextCursor) throw new Error(`Browse continuation missing for MCP ${i}`);
      }
      const continuedSearch = await settleCalls(first.slice(0, 3).map((result, i) => {
        return i === 0 ? webSearch(origin, query, result.nextCursor, options.timeoutMs, httpContext()) :
          mcpCall(mcp[i - 1], 'session_search', { ...searchArgs, cursor: result.nextCursor }, options.timeoutMs);
      }));
      const continuedBrowse = await settleCalls(first.slice(3).map((result, i) => {
        return mcpCall(mcp[i], 'session_browse', { ...browseArgs, cursor: result.nextCursor }, options.timeoutMs);
      }));
      const searchNext = continuedSearch.map(result => resultSummary(result, 'search', query.providers));
      const browseNext = continuedBrowse.map(result => resultSummary(result, 'browse'));
      record.pendingPhase.searchNext = searchNext.map(({ nextCursor, ...safe }) => safe);
      record.pendingPhase.browseNext = browseNext.map(({ nextCursor, ...safe }) => safe);
      if (new Set(search.map(row => row.orderedKeySha256)).size !== 1 || new Set(searchNext.map(row => row.orderedKeySha256)).size !== 1 ||
          new Set(browse.map(row => row.orderedKeySha256)).size !== 1 || new Set(browseNext.map(row => row.orderedKeySha256)).size !== 1) throw new Error('Cross-process result mismatch');
      if (new Set(search.map(row => row.cursor.scopeSha256)).size !== 1 ||
          search[1].cursor.revisionSha256 !== search[2].cursor.revisionSha256 ||
          browse[0].cursor.revisionSha256 !== browse[1].cursor.revisionSha256) throw new Error('Cross-process cursor mismatch');
      const result = { name, wallMs: performance.now() - started,
        search: search.map(({ nextCursor, ...safe }) => safe), searchNext: searchNext.map(({ nextCursor, ...safe }) => safe),
        browse: browse.map(({ nextCursor, ...safe }) => safe), browseNext: browseNext.map(({ nextCursor, ...safe }) => safe) };
      record.phases.push(result);
      delete record.pendingPhase;
      record.stateSizes.push({ phase: name, ...stateSizes(state) });
      await sample();
      return { webSearchCursor: first[0].nextCursor, mcpSearchCursor: first[1].nextCursor,
        mcpBrowseCursor: first[3].nextCursor };
    };
    const oldCursors = await phase('initial');
    record.activePhase = 'reindex';
    const refresh = await callHttpRaw(`${origin}/api/reindex`, { method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: '{}' }, { ...httpContext(), timeoutMs: options.timeoutMs });
    if (!refresh.ok || !JSON.parse(refresh.text).ok) throw new Error('Web refresh failed');
    await phase('refresh');
    record.activePhase = 'stale-cursors';
    const staleSearch = await callMcpRaw(mcp[0], 'session_search', { ...searchArgs, cursor: oldCursors.mcpSearchCursor }, options.timeoutMs);
    const staleBrowse = await callMcpRaw(mcp[0], 'session_browse', { ...browseArgs, cursor: oldCursors.mcpBrowseCursor }, options.timeoutMs);
    const staleWebParams = new URLSearchParams({ q: query.query, fields: query.fields.join(','), limit: String(query.limit), cursor: oldCursors.webSearchCursor });
    if (query.providers.length === 1) staleWebParams.set('provider', query.providers[0]);
    const staleWeb = await callHttpRaw(`${origin}/api/v3/search?${staleWebParams}`, {}, { ...httpContext(), timeoutMs: options.timeoutMs });
    const staleWebBody = JSON.parse(staleWeb.text);
    record.staleCursorChecks = { web: !staleWeb.ok && staleWebBody?.error?.code === 'source_changed',
      mcpSearch: staleSearch.isError === true && /^source_changed:/.test(staleSearch.content?.[0]?.text ?? ''),
      mcpBrowse: staleBrowse.isError === true && /^source_changed:/.test(staleBrowse.content?.[0]?.text ?? '') };
    if (!Object.values(record.staleCursorChecks).every(Boolean)) throw new Error('Old cursor survived refresh');
    const stopped = await stopChildren(children);
    if (!stopped) throw new Error('Process closure incomplete');
    children.length = 0;
    record.activePhase = 'restart-startup';
    const restarted = spawn(options.exe, [...common, 'serve', '--port', String(port), '--disable-terminal-launch', ...sourceArgs, ...stateArgs],
      { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const item = { name: 'web-restart', child: restarted, closed: new Promise(resolve => restarted.once('close', (code, signal) => resolve({ code, signal }))) };
    restarted.once('error', error => { item.spawnError = error; });
    children.push(item);
    record.currentWebPid = restarted.pid;
    restarted.stderr.on('data', chunk => writeFileSync(path.join(dir, 'web-restart.stderr.private.log'), chunk, { flag: 'a' }));
    mcp = ['mcp-a-restart', 'mcp-b-restart'].map(name => {
      const transport = new StdioClientTransport({ command: options.exe, args: [...common, 'mcp', ...sourceArgs, ...stateArgs], cwd: repo, env, stderr: 'pipe' });
      const client = new Client({ name: 'agentsession-v3-shared-state-exercise', version: '1.0.0' });
      const service = { name, transport, client, child: null, closed: null, ...callContext };
      children.push(service);
      transport.stderr?.on('data', chunk => writeFileSync(path.join(dir, `${name}.stderr.private.log`), chunk, { flag: 'a' }));
      return service;
    });
    const restartConnections = mcp.map(service => connectOwnedMcp(service, options.timeoutMs));
    await timeout(settleCalls([waitWeb(origin, item, options.timeoutMs), ...restartConnections]), options.timeoutMs);
    record.restartProcessIds = children.map(service => service.child.pid);
    currentPids = record.restartProcessIds;
    await phase('restart');
    record.revisionConsistency = { webRestartMatchesRefresh: record.phases[2].search[0].cursor.revisionSha256 === record.phases[1].search[0].cursor.revisionSha256,
      resultStableAcrossRefresh: record.phases[0].search[0].orderedKeySha256 === record.phases[1].search[0].orderedKeySha256,
      browseStableAcrossRefresh: record.phases[0].browse[0].orderedKeySha256 === record.phases[1].browse[0].orderedKeySha256,
      searchStableAcrossRestart: record.phases[1].search[0].orderedKeySha256 === record.phases[2].search[0].orderedKeySha256,
      browseStableAcrossRestart: record.phases[1].browse[0].orderedKeySha256 === record.phases[2].browse[0].orderedKeySha256,
      mcpRestartMatchesRefresh: record.phases[1].search[1].cursor.revisionSha256 === record.phases[2].search[1].cursor.revisionSha256 };
    if (!Object.values(record.revisionConsistency).every(Boolean)) throw new Error('Refresh or restart consistency mismatch');
    await sample();
    record.status = 'ok';
  } catch (error) {
    record.errors.push({ phase: record.activePhase ?? 'startup', kind: kind(error), message: String(error.message ?? error), error: serializeError(error) });
  } finally {
    if (sampler) clearInterval(sampler);
    try { record.processesClosed = await stopChildren(children); } catch { record.processesClosed = false; }
    try { record.finalProcessMetrics = await samplePids([...new Set([...record.processIds, ...(record.restartProcessIds ?? [])])]); } catch { record.finalProcessMetrics = []; }
    record.resources = summarizeSamples(record.samples, [...new Set(record.processIds)].slice(0, 3));
    record.restartResources = record.restartProcessIds ? summarizeSamples(record.samples, record.restartProcessIds) : null;
    record.finalStateSizes = stateSizes(state);
    record.finalExits = children.map(childExitSnapshot);
    try { record.sqlite = sqliteEvidence(state.index); } catch (error) { record.sqlite = { errorKind: kind(error) }; }
    try { record.evidenceAudit = evidence.audit(); }
    catch (error) { record.evidenceAudit = { ok: false, error: serializeError(error) }; }
    if (!record.evidenceAudit.ok) record.errors.push({ phase: 'evidence-audit', kind: 'EvidenceError', audit: record.evidenceAudit });
    json(path.join(dir, 'call-evidence-audit.private.json'), record.evidenceAudit);
    record.completedAtUtc = new Date().toISOString();
    if (record.errors.length || !record.processesClosed || record.resources.completeThreePidSamples === 0 ||
        record.restartResources?.completeThreePidSamples === 0 || record.sqlite.databaseCount !== 1 ||
        record.sqlite.databases[0]?.quickCheck !== 'ok') record.status = 'failed';
    json(path.join(dir, 'record.private.json'), record);
  }
  return record;
}

export async function main(argv = process.argv.slice(2)) {
  const options = { manifest: path.join(repo, 'tmp/v3-performance/manifest.private.json'), queryLabel: 'metadata-title-directory', sampleMs: 500, timeoutMs: 120000 };
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--help') { console.log('Usage: node scripts/v3-bench-shared-state.mjs --exe <packaged-exe> --sha256 <sha256> --output-dir <fresh-repo-tmp-dir> [--manifest <private-json>] [--timeout-ms 120000] [--sample-ms 500]'); return; }
    const key = { '--exe': 'exe', '--sha256': 'expectedSha256', '--output-dir': 'outputDir', '--manifest': 'manifest', '--query-label': 'queryLabel', '--timeout-ms': 'timeoutMs', '--sample-ms': 'sampleMs' }[argv[i]];
    if (!key || !argv[i + 1]) throw new Error('Invalid or incomplete option');
    options[key] = argv[i + 1];
  }
  if (!options.exe || !options.expectedSha256 || !options.outputDir) throw new Error('--exe, --sha256 and --output-dir required');
  options.timeoutMs = Number(options.timeoutMs); options.sampleMs = Number(options.sampleMs);
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || !Number.isInteger(options.sampleMs) || options.sampleMs < 100) throw new Error('Invalid timeout or sample interval');
  if (!path.isAbsolute(options.exe) || !path.isAbsolute(options.outputDir)) throw new Error('Executable and output paths must be absolute');
  options.exe = path.resolve(options.exe); options.outputDir = path.resolve(options.outputDir);
  const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
  const query = validateInputs({ ...options, manifest });
  createOutput(options.outputDir);
  const ledger = { format, status: 'running', manifestPath: options.manifest, binaryPath: options.exe, binarySha256: options.expectedSha256,
    sourceBefore: sourceSnapshot(manifest), repetitions: [] };
  json(path.join(options.outputDir, 'ledger.private.json'), ledger);
  if (JSON.stringify(ledger.sourceBefore.codex) !== JSON.stringify(manifest.codexStat)) throw new Error('Frozen Codex stat manifest changed');
  for (let i = 1; i <= 5; i++) {
    const record = await runRepetition(i, options, manifest, query, options.outputDir);
    ledger.repetitions.push({ number: i, status: record.status, recordPath: path.join(options.outputDir, `rep-${i}/record.private.json`) });
    json(path.join(options.outputDir, 'ledger.private.json'), ledger);
    console.log(JSON.stringify({ repetition: i, status: record.status }));
  }
  ledger.sourceAfter = sourceSnapshot(manifest);
  ledger.binarySha256After = sha(readFileSync(options.exe));
  ledger.sourcesUnchanged = JSON.stringify(ledger.sourceBefore) === JSON.stringify(ledger.sourceAfter);
  const records = ledger.repetitions.map(item => JSON.parse(readFileSync(item.recordPath, 'utf8')));
  const fingerprints = records.map(r => JSON.stringify(r.phases[0] ? {
    search: r.phases[0].search.map(s => s.orderedKeySha256), searchNext: r.phases[0].searchNext.map(s => s.orderedKeySha256),
    browse: r.phases[0].browse.map(s => s.orderedKeySha256), browseNext: r.phases[0].browseNext.map(s => s.orderedKeySha256),
  } : null));
  const crossRepetitionResultParity = new Set(fingerprints).size === 1 && fingerprints[0] !== 'null';
  ledger.status = records.every(r => r.status === 'ok') && crossRepetitionResultParity && ledger.sourcesUnchanged &&
    ledger.binarySha256After === options.expectedSha256 ? 'observed' : 'failed';
  json(path.join(options.outputDir, 'ledger.private.json'), ledger);
  const summary = { format, status: ledger.status, qualification: 'resource-observation-only', repetitions: 5,
    binarySha256: options.expectedSha256, binaryUnchanged: ledger.binarySha256After === options.expectedSha256,
    sourceStatSha256: Object.fromEntries(providers.map(name => [name, ledger.sourceBefore[name].statManifestSha256])),
    sourceContentSha256: Object.fromEntries(providers.filter(name => name !== 'codex').map(name => [name, ledger.sourceBefore[name].contentManifestSha256])),
    sourcesUnchanged: ledger.sourcesUnchanged, crossRepetitionResultParity, queryLabel: query.label, querySha256: query.querySha256,
    attempts: records.map(r => ({ repetition: r.repetition, status: r.status, phaseWallMs: r.phases.map(p => ({ name: p.name, wallMs: p.wallMs })),
      peakSameTimeRssBytes: Math.max(r.resources.peakSameTimeRssBytes ?? 0, r.restartResources?.peakSameTimeRssBytes ?? 0),
      completeThreePidSamples: r.resources.completeThreePidSamples + (r.restartResources?.completeThreePidSamples ?? 0),
      processResources: Object.fromEntries(['web', 'mcp-a', 'mcp-b'].map((name, i) => [name,
        r.resources.perProcess[r.processIds[i]] ?? null])),
      restartProcessResources: r.restartResources ? Object.fromEntries(['web', 'mcp-a', 'mcp-b'].map((name, i) => [name,
        r.restartResources.perProcess[r.restartProcessIds[i]] ?? null])) : null,
      stateSizes: r.stateSizes.map(({ phase, meta, index, cache }) => ({ phase, meta, index, cache })),
      finalStateSizes: r.finalStateSizes,
      indexDatabaseCount: r.sqlite.databaseCount ?? null, sqliteQuickCheck: r.sqlite.databases?.[0]?.quickCheck ?? null,
      revisionEvidence: r.phases.map(p => ({ name: p.name, search: p.search.map(s => s.cursor), browse: p.browse.map(b => b.cursor) })),
      staleCursorChecks: r.staleCursorChecks ?? null, revisionConsistency: r.revisionConsistency ?? null,
      processesClosed: r.processesClosed, errors: r.errors.map(e => e.kind) })),
    limitations: ['OS file cache and background load are uncontrolled.', 'Codex source preservation uses a stat manifest; smaller provider roots use content manifests.',
      'Sampling observes direct service PIDs and excludes the controller, PowerShell sampler, and any descendants.', 'No release RSS or storage threshold is defined.'] };
  json(path.join(options.outputDir, 'summary.public.json'), summary);
  console.log(JSON.stringify({ status: summary.status, summary: path.join(options.outputDir, 'summary.public.json') }));
  if (summary.status !== 'observed') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Shared-state exercise failed: ${kind(error)}`); process.exitCode = 1; });
}
