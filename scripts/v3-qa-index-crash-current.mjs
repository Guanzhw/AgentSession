import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { freeFetchSafePort } from '../v3/test/fetch-safe-port.mjs';
import { callHttpRaw, callMcpRaw, createCallEvidence, serializeError, settleCalls } from './v3-bench-call-evidence.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const owned = path.join(repo, 'tmp/v3-performance/formal-resume-20261001T1901/crash');
const fixturePath = 'v3/fixtures/codex/sessions/2026/09/26/rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl';
const firstId = '44444444-4444-4444-8444-444444444444';
const secondId = '55555555-5555-4555-8555-555555555555';
const marker = 'AGENTSESSION_V3_TEST_BEFORE_CATALOG_COMMIT provider=codex';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function bounded(promise, milliseconds, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

export function shadowInventory(run) {
  const root = path.join(run, 'shadow'), entries = [];
  function visit(file, relative) {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) entries.push({ path: relative, type: 'symlink', target: readlinkSync(file) });
    else if (stat.isDirectory()) {
      entries.push({ path: relative, type: 'directory' });
      for (const name of readdirSync(file).sort()) visit(path.join(file, name), relative === '.' ? name : relative + '/' + name);
    } else if (stat.isFile()) {
      const bytes = readFileSync(file); entries.push({ path: relative, type: 'file', bytes: bytes.length, sha256: sha(bytes) });
    } else throw new Error('Unexpected owned shadow entry type: ' + relative);
  }
  visit(root, '.'); return entries;
}

export function assertRecoveredMatches(matches) {
  assert.deepEqual(matches.map(row => [row.session?.provider, row.session?.sessionId,
    row.event?.provider, row.event?.sessionId, row.event?.messageId, row.event?.segment, row.matchField, row.matchRole]),
    [['codex', firstId, 'codex', firstId, 'assistant-1', 'message', 'message', 'assistant']],
    'recovered search matches the independent public fixture oracle');
}

export function webSearchUrl(origin, term, limit = 100, cursor) {
  const url = new URL('/api/v3/search', origin);
  url.search = new URLSearchParams({ q: term, provider: 'codex', fields: 'assistant', limit: String(limit), ...(cursor ? { cursor } : {}) }).toString();
  return url;
}

export function validatePublicFixtureOracle(fixture) {
  const fixtureRows = fixture.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(fixtureRows.find(row => row.type === 'session_meta').payload.id, firstId);
  const assistant = fixtureRows.find(row => row.type === 'response_item' && row.payload.id === 'assistant-1').payload;
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.content[0].text, 'Hello \u{1F642} from the Rust slice. Continue to the complete ending.');
}

async function closeOwnedService(service) {
  const errors = [];
  for (const owner of [service.client, service.transport]) {
    if (!owner) continue;
    try { await bounded(owner.close(), 10000, 'Owned MCP closure timeout'); }
    catch (error) { errors.push(error); }
  }
  try {
    if (service.child && !service.exit && service.child.exitCode === null && service.child.signalCode === null) service.child.kill('SIGKILL');
    if (service.closed) await bounded(service.closed, 10000, 'Owned process closure timeout');
  } catch (error) { errors.push(error); }
  if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Owned process cleanup failed');
}

export async function connectOwnedMcp(client, transport, observe, timeoutMs = 15000) {
  let result, service;
  const adopt = () => {
    if (!service && transport._process) { service = observe(transport._process); service.client = client; service.transport = transport; }
  };
  // Attach both outcomes before waiting for a PID, including spawn/handshake rejection.
  let connecting;
  try {
    connecting = Promise.resolve(client.connect(transport)).then(
      () => { result = { ok: true }; }, error => { result = { ok: false, error }; });
  } catch (error) { result = { ok: false, error }; connecting = Promise.resolve(); }
  try {
    adopt();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      adopt();
      if (result && !result.ok) throw result.error;
      if (result?.ok) {
        assert.ok(service && transport.pid, 'owned SDK child handle and PID are available for cleanup'); return service;
      }
      await delay(5);
    }
    throw new Error('MCP connection timeout');
  } catch (error) {
    adopt();
    const failures = [error];
    try { await closeOwnedService(service || { client, transport }); }
    catch (cleanupError) { failures.push(cleanupError); }
    try { await bounded(connecting, timeoutMs, 'MCP connection did not settle after cleanup'); }
    catch (terminalError) { failures.push(terminalError); }
    throw failures.length === 1 ? error : new AggregateError(failures, 'MCP connection and cleanup failed');
  }
}

export async function cleanupCrashServices(services, requests) {
  const errors = [];
  for (const service of services) {
    try { await closeOwnedService(service); }
    catch (error) { errors.push({ service: service.name, error: serializeError(error) }); }
  }
  // callHttpRaw has its own 25-second bound. Join it after terminating the victim,
  // before auditing the raw call journal, even when an earlier assertion failed.
  const requestTerminals = await Promise.all(requests);
  return { errors, requestTerminals };
}

export function controlledEnvironment(env, run) {
  return { ...Object.fromEntries(Object.entries(env).filter(([name]) => !/^AGENTSESSION_/i.test(name) && !/^PORT$/i.test(name))),
    APPDATA: path.join(run, 'shadow/Roaming'), LOCALAPPDATA: path.join(run, 'shadow/Local'),
    USERPROFILE: path.join(run, 'shadow/Home') };
}

export function validateInputLedger(original, copied, entries) {
  return entries.map(entry => {
    const left = readFileSync(path.join(original, entry.path)), right = readFileSync(path.join(copied, entry.path));
    const originalSha256 = sha(left), copySha256 = sha(right);
    if (left.length !== entry.sizeBytes || right.length !== entry.sizeBytes || originalSha256 !== entry.sha256 || copySha256 !== entry.sha256)
      throw new Error('Production input drift: ' + entry.path);
    return { ...entry, originalSha256, copySha256 };
  });
}

export function snapshotCatalog(indexDir) {
  const files = readdirSync(indexDir).filter(name => name.endsWith('.sqlite'));
  assert.equal(files.length, 1, 'one owned source-scope index database');
  const db = new DatabaseSync(path.join(indexDir, files[0]), { readOnly: true });
  try {
    const fts = term => db.prepare(`SELECT count(*) AS n FROM search_doc_fts
      JOIN search_doc d ON d.rowid=search_doc_fts.rowid WHERE d.provider='codex' AND search_doc_fts MATCH ?`).get(term).n;
    return { revision: db.prepare("SELECT revision FROM catalog_state WHERE provider='codex'").get().revision,
      entries: db.prepare("SELECT session_id, signature, summary_json FROM catalog_entry WHERE provider='codex' ORDER BY session_id").all(),
      docs: db.prepare("SELECT session_id, field, position, text FROM search_doc WHERE provider='codex' ORDER BY session_id, field, position").all(),
      oldFts: fts('hello'), newFts: fts('howdy'), quickCheck: db.prepare('PRAGMA quick_check').get().quick_check };
  } finally { db.close(); }
}

export function preflight() {
  const binding = JSON.parse(readFileSync(path.join(owned, 'source-binding.public.json')));
  const build = JSON.parse(readFileSync(path.join(owned, 'build.public.json')));
  assert.equal(binding.productionInputCount, 70);
  const inputs = validateInputLedger(repo, binding.source, binding.productionInputs);
  assert.equal(sha(readFileSync(binding.candidateBinary)), binding.candidateSha256, '83 candidate stays unchanged');
  assert.equal(path.resolve(build.binary), path.resolve(path.join(owned, 'target/debug/agentsession-v3.exe')));
  assert.equal(sha(readFileSync(build.binary)), build.binarySha256, 'the exercised hook matches its own build ledger');
  assert.equal(build.exitCode, 0);
  assert.equal(build.feature, 'crash-test-hook');
  const fixture = readFileSync(path.join(owned, 'frozen-fixture', fixturePath));
  assert.equal(sha(fixture), binding.originalFixture.sha256);
  assert.equal(sha(readFileSync(path.join(repo, fixturePath))), binding.originalFixture.sha256);
  validatePublicFixtureOracle(fixture);
  return { binding, build, inputs, fixture };
}

function defaultInventory(run) {
  return ['agentsession', 'agentsession-v3'].map(name => {
    const file = path.join(run, 'shadow/Roaming', name, 'meta.db');
    const bytes = readFileSync(file);
    const db = new DatabaseSync(file, { readOnly: true });
    try { return { name, bytes: bytes.length, sha256: sha(bytes), schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
      rows: db.prepare('SELECT * FROM isolation_sentinel ORDER BY id').all(), quickCheck: db.prepare('PRAGMA quick_check').get().quick_check }; }
    finally { db.close(); }
  });
}

export async function runCrashValidation() {
  const frozen = preflight();
  const run = path.join(owned, 'run-' + new Date().toISOString().replaceAll(/[:.]/g, '-'));
  if (existsSync(run)) throw new Error('Existing crash evidence must be preserved');
  mkdirSync(run);
  const evidence = createCallEvidence({ directory: path.join(run, 'raw-calls') });
  const record = { startedAt: new Date().toISOString(), status: 'running', phase: 'prepare', run,
    candidateSha256: frozen.binding.candidateSha256, hookBinarySha256: frozen.build.binarySha256,
    productionInputCount: frozen.inputs.length, processes: [], errors: [], expectedCrashRequest: null,
    limitations: ['Debug hook build, not forced termination of ordinary release 83/70.',
      'Public controlled Codex source copies; not real five-provider workload or power-loss/filesystem-failure coverage.',
      'Shadow default endpoint preservation; no original user databases opened and no writer attribution claimed.',
      'Historical formal restart browse failure remains unclassified.'] };
  const services = [];
  const pendingRequests = [];
  const env = controlledEnvironment(process.env, run);
  for (const name of ['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache', 'shadow/Roaming', 'shadow/Local', 'shadow/Home']) mkdirSync(path.join(run, name), { recursive: true });
  for (const name of ['agentsession', 'agentsession-v3']) {
    const file = path.join(run, 'shadow/Roaming', name, 'meta.db'); mkdirSync(path.dirname(file));
    const db = new DatabaseSync(file);
    try { db.exec("CREATE TABLE isolation_sentinel(id TEXT PRIMARY KEY,value TEXT); INSERT INTO isolation_sentinel VALUES('user-state','unchanged');"); }
    finally { db.close(); }
  }
  json(path.join(run, 'config.json'), { open: false });
  const copied = path.join(run, 'codex/sessions/2026/09/26', path.basename(fixturePath)); mkdirSync(path.dirname(copied), { recursive: true });
  const original = frozen.fixture.toString('utf8'); writeFileSync(copied, original);
  const second = copied.replaceAll(firstId, secondId); writeFileSync(second, original.replaceAll(firstId, secondId));
  const secondHash = sha(readFileSync(second));
  const defaultBefore = defaultInventory(run);
  const shadowBefore = shadowInventory(run);
  json(path.join(run, 'default-before.public.json'), defaultBefore);
  json(path.join(run, 'shadow-before.public.json'), shadowBefore);
  const common = ['--config', path.join(run, 'config.json')];
  const paths = ['--codex-dir', path.join(run, 'codex'), '--opencode-db', path.join(run, 'opencode.db'),
    '--claude-dir', path.join(run, 'claude'), '--pi-dir', path.join(run, 'pi'), '--dsh-dir', path.join(run, 'dsh'),
    '--meta-dir', path.join(run, 'meta'), '--index-dir', path.join(run, 'index'), '--cache-dir', path.join(run, 'cache')];
  const binary = frozen.build.binary;

  function observeChild(name, child, args) {
    const service = { name, child, args, stdout: '', stderr: '', closed: null, exit: null };
    service.closed = new Promise(resolve => child.once('close', (code, signal) => { service.exit = { code, signal, atUtc: new Date().toISOString() }; resolve(service.exit); }));
    child.on('error', error => { record.errors.push({ phase: record.phase, service: name, error: serializeError(error) }); });
    for (const stream of ['stdout', 'stderr']) child[stream]?.on('data', bytes => {
      service[stream] += bytes.toString(); appendFileSync(path.join(run, name + '.' + stream + '.private.log'), bytes);
    });
    services.push(service);
    record.processes.push({ name, pid: child.pid, executable: binary, args, isolatedEnvironment: {
      APPDATA: env.APPDATA, LOCALAPPDATA: env.LOCALAPPDATA, USERPROFILE: env.USERPROFILE }, startedAt: new Date().toISOString() });
    return service;
  }
  async function http(service, url, options = {}) {
    return callHttpRaw(url, options, { evidence, phase: () => record.phase, service: service.name, pid: service.child.pid, timeoutMs: 25000 });
  }
  async function startWeb(name, extra = {}) {
    const port = await freeFetchSafePort(), args = [...common, 'serve', '--port', String(port), '--disable-terminal-launch', ...paths];
    const service = observeChild(name, spawn(binary, args, { cwd: repo, env: { ...env, ...extra }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), args);
    service.origin = 'http://127.0.0.1:' + port;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      assert.equal(service.child.exitCode, null, 'owned Web survives startup');
      try { const ready = await http(service, service.origin + '/api/providers'); if (ready.ok) return service; }
      catch (error) { if (!['TypeError', 'TimeoutError'].includes(error.name)) throw error; }
      await delay(50);
    }
    throw new Error('Owned Web startup timeout');
  }
  async function connectMcp(name) {
    const args = [...common, 'mcp', ...paths];
    const transport = new StdioClientTransport({ command: binary, args, cwd: repo, env, stderr: 'pipe' });
    const client = new Client({ name, version: '1.0.0' });
    const id = evidence.begin({ transport: 'mcp-lifecycle', service: name, phase: record.phase, operation: 'connect', executable: binary, args });
    try {
      transport.stderr?.on('data', bytes => appendFileSync(path.join(run, name + '.mcp-stderr.private.log'), bytes));
      const service = await connectOwnedMcp(client, transport, child => observeChild(name, child, args));
      evidence.finish(id, { outcome: 'response', response: { connected: true, pid: transport.pid } });
      return service;
    } catch (error) { evidence.finish(id, { outcome: 'error', error: serializeError(error) }); throw error; }
  }
  async function rawMcp(service, tool, args) { return callMcpRaw(service, tool, args, 25000, { evidence, phase: () => record.phase }); }
  async function mcpSearch(service, term) {
    const response = await rawMcp(service, 'session_search', { query: term, providers: ['codex'], fields: ['assistant'] });
    assert.notEqual(response.isError, true); return response.structuredContent.result.matches;
  }
  async function webSearch(service, term, limit, cursor) {
    const url = webSearchUrl(service.origin, term, limit, cursor);
    const response = await http(service, url); return { response, body: JSON.parse(response.text) };
  }

  try {
    record.phase = 'initial';
    const web = await startWeb('web');
    const mcpA = await connectMcp('mcp-a'), mcpB = await connectMcp('mcp-b');
    const browseArgs = { level: 'sessions', providers: ['codex'], limit: 1 };
    const firstBrowse = await rawMcp(mcpA, 'session_browse', browseArgs);
    assert.notEqual(firstBrowse.isError, true);
    const oldBrowseCursor = firstBrowse.structuredContent.result.nextCursor; assert.ok(oldBrowseCursor);
    const firstSearch = await webSearch(web, 'hello', 1);
    assert.equal(firstSearch.response.status, 200); assert.equal(firstSearch.body.matches.length, 1);
    const oldSearchCursor = firstSearch.body.nextCursor; assert.ok(oldSearchCursor);
    assert.equal((await mcpSearch(mcpB, 'hello')).length, 2);
    const before = snapshotCatalog(path.join(run, 'index'));
    assert.equal(before.entries.length, 2); assert.equal(before.oldFts, 2); assert.equal(before.newFts, 0); assert.equal(before.quickCheck, 'ok');
    json(path.join(run, 'catalog-before.private.json'), before);
    const changed = original.replace('Hello \u{1F642} from the Rust slice.', 'Howdy \u{1F642} from the Rust slice.');
    assert.notEqual(changed, original, 'public fixture contains the independent term oracle'); writeFileSync(copied, changed);
    const changedHash = sha(readFileSync(copied));
    record.phase = 'crash-precommit';
    const victim = await startWeb('victim-web', { AGENTSESSION_V3_TEST_PAUSE_BEFORE_CATALOG_COMMIT: 'codex' });
    let pendingDone = false;
    const pending = webSearch(victim, 'howdy').then(value => { pendingDone = true; return { outcome: 'response', value }; },
      error => { pendingDone = true; return { outcome: 'error', error: serializeError(error) }; });
    pendingRequests.push(pending);
    const deadline = Date.now() + 15000;
    while (!victim.stderr.includes(marker) && Date.now() < deadline) {
      assert.equal(victim.child.exitCode, null, 'victim stays alive before hook'); assert.equal(pendingDone, false, 'refresh stays pending until precommit hook'); await delay(25);
    }
    assert.ok(victim.stderr.includes(marker), 'deterministic marker locates the transaction before commit');
    const hot = snapshotCatalog(path.join(run, 'index')); assert.deepEqual(hot, before);
    json(path.join(run, 'catalog-hot.private.json'), hot);
    assert.equal(victim.child.kill('SIGKILL'), true, 'terminate only the owned paused victim');
    await victim.closed;
    record.expectedCrashRequest = await pending; assert.equal(record.expectedCrashRequest.outcome, 'error');
    record.phase = 'rollback';
    const rolledBack = snapshotCatalog(path.join(run, 'index')); assert.deepEqual(rolledBack, before);
    json(path.join(run, 'catalog-rollback.private.json'), rolledBack);
    record.phase = 'recover';
    const result = await settleCalls([webSearch(web, 'howdy'), mcpSearch(mcpA, 'howdy'), mcpSearch(mcpB, 'howdy')]);
    assert.equal(result[0].response.status, 200);
    const keys = matches => matches.map(row => [row.session.provider, row.session.sessionId, row.event?.messageId, row.matchField]);
    for (const matches of [result[0].body.matches, result[1], result[2]]) assertRecoveredMatches(matches);
    assert.equal(result[0].body.matches.length, 1); assert.deepEqual(keys(result[0].body.matches), keys(result[1])); assert.deepEqual(keys(result[1]), keys(result[2]));
    const staleBrowse = await rawMcp(mcpA, 'session_browse', { ...browseArgs, cursor: oldBrowseCursor });
    const staleWeb = await webSearch(web, 'hello', 1, oldSearchCursor);
    assert.equal(staleBrowse.isError, true); assert.match(staleBrowse.content[0].text, /^source_changed: /);
    assert.equal(staleWeb.response.ok, false); assert.equal(staleWeb.body.error.code, 'source_changed');
    const retained = await webSearch(web, 'hello'); assert.equal(retained.response.status, 200);
    assert.deepEqual(retained.body.matches.map(row => row.session.sessionId), [secondId]);
    const after = snapshotCatalog(path.join(run, 'index'));
    assert.equal(after.revision, before.revision + 1); assert.equal(after.oldFts, 1); assert.equal(after.newFts, 1); assert.equal(after.quickCheck, 'ok');
    json(path.join(run, 'catalog-after.private.json'), after);
    record.phase = 'restart';
    const restarted = await startWeb('web-restarted');
    const restartSearch = await webSearch(restarted, 'howdy'); assert.equal(restartSearch.response.status, 200);
    assertRecoveredMatches(restartSearch.body.matches);
    assert.deepEqual(keys(restartSearch.body.matches), keys(result[1])); assert.deepEqual(snapshotCatalog(path.join(run, 'index')), after);
    assert.equal(sha(readFileSync(copied)), changedHash); assert.equal(sha(readFileSync(second)), secondHash);
    record.recovery = { beforeRevision: before.revision, afterRevision: after.revision, marker, oldSnapshotPreservedWhilePaused: true,
      oldSnapshotPreservedAfterKill: true, threeServicesAgree: true, staleWebRejected: true, staleMcpBrowseRejected: true,
      restartRevisionPreserved: true, quickChecks: [before.quickCheck, hot.quickCheck, rolledBack.quickCheck, after.quickCheck],
      independentRecoveredOracle: { provider: 'codex', sessionId: firstId, messageId: 'assistant-1', segment: 'message', matchField: 'message', matchRole: 'assistant' },
      workingSourceHashAfterIntentionalEdit: changedHash, unchangedSecondSourceSha256: secondHash };
    record.status = 'passed';
  } catch (error) { record.status = 'failed'; record.errors.push({ phase: record.phase, error: serializeError(error) }); }
  finally {
    record.phase = 'cleanup';
    const cleanup = await cleanupCrashServices(services, pendingRequests);
    if (cleanup.errors.length) { record.status = 'failed'; record.errors.push(...cleanup.errors.map(error => ({ phase: 'cleanup', ...error }))); }
    record.pendingRequestTerminals = cleanup.requestTerminals;
    record.processesClosed = services.every(service => service.exit !== null);
    record.processExits = services.map(service => ({ name: service.name, pid: service.child.pid, ...service.exit }));
    try {
      record.rawEvidence = evidence.audit(); assert.equal(record.rawEvidence.ok, true); assert.equal(record.rawEvidence.pending, 0);
      record.defaultAfter = defaultInventory(run); assert.deepEqual(record.defaultAfter, defaultBefore);
      record.shadowAfter = shadowInventory(run); assert.deepEqual(record.shadowAfter, shadowBefore);
      json(path.join(run, 'shadow-after.public.json'), record.shadowAfter);
      record.shadowDefaultsPreserved = true;
      validateInputLedger(repo, frozen.binding.source, frozen.binding.productionInputs);
      assert.equal(sha(readFileSync(frozen.binding.candidateBinary)), frozen.binding.candidateSha256);
      assert.equal(sha(readFileSync(path.join(repo, fixturePath))), frozen.binding.originalFixture.sha256);
      assert.equal(sha(readFileSync(path.join(owned, 'frozen-fixture', fixturePath))), frozen.binding.originalFixture.sha256);
      record.productionAndFrozenFixturePreserved = true;
    } catch (error) { record.status = 'failed'; record.errors.push({ phase: 'final-guard', error: serializeError(error) }); }
    record.completedAt = new Date().toISOString();
    json(path.join(run, 'record.private.json'), record);
    const summary = { startedAt: record.startedAt, completedAt: record.completedAt, status: record.status, run,
      candidateSha256: record.candidateSha256, hookBinarySha256: record.hookBinarySha256, productionInputCount: record.productionInputCount,
      recovery: record.recovery, rawEvidence: record.rawEvidence, processesClosed: record.processesClosed,
      shadowDefaultsPreserved: record.shadowDefaultsPreserved, productionAndFrozenFixturePreserved: record.productionAndFrozenFixturePreserved,
      errors: record.errors, limitations: record.limitations };
    json(path.join(run, 'summary.public.json'), summary); console.log(JSON.stringify(summary));
  }
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--prepare') {
    const value = preflight(); console.log(JSON.stringify({ status: 'ready', productionInputs: value.inputs.length,
      hookBinary: value.build.binary, hookSha256: value.build.binarySha256, noServicesStarted: true }));
  } else if (process.argv[2] === '--run') {
    const record = await runCrashValidation(); process.exitCode = record.status === 'passed' ? 0 : 1;
  } else throw new Error('Use --prepare for a non-runtime preflight, or --run for the isolated fault-injection validation');
}
