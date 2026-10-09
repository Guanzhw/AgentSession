// Controlled copies only. This harness cannot attribute the historical default metadata writer.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { callHttpRaw, callMcpRaw, createCallEvidence, serializeError } from './v3-bench-call-evidence.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = path.join(repo, 'tmp/v3-performance/formal-resume-20261001T1901/metadata');
const providers = ['opencode', 'claude-code', 'codex', 'pi', 'deepseek-harness'];
const sourceFlags = ['--opencode-db', '--claude-dir', '--codex-dir', '--pi-dir', '--dsh-dir'];
const suffixes = ['', '-wal', '-shm', '-journal'];
const digest = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function withTimeout(work, ms, message) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
const key = row => JSON.stringify([row.provider, row.session_id]);
const orderedRows = rows => [...rows].sort((a, b) => key(a).localeCompare(key(b)));
const inside = (root, target) => {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
const samePath = (left, right) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);

export function observeOwnedChild(child, record) {
  // Spawn failures can occur before readiness. Observe them immediately and await actual closure.
  child.on('error', error => { record.spawnError = serializeError(error); });
  return new Promise(resolve => child.once('close', (exitCode, signal) => {
    Object.assign(record, { exitCode, signal, closed: true, completedAtUtc: new Date().toISOString() });
    resolve();
  }));
}

export function isolatedEnvironment(root, inherited = process.env) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([name]) => !/^AGENTSESSION_/i.test(name)
    && !/^(PORT|CODEX_HOME|CLAUDE_CONFIG_DIR|PI_CODING_AGENT_DIR|DSH_HOME|XDG_CONFIG_HOME|XDG_DATA_HOME)$/i.test(name)));
  return { ...env, APPDATA: path.resolve(root, 'shadow/roaming'),
    LOCALAPPDATA: path.resolve(root, 'shadow/local'), USERPROFILE: path.resolve(root, 'shadow/profile') };
}

function assertSchemaAndOtherTables(before, after) {
  assert.equal(after.quickCheck, 'ok', 'database quick_check');
  assert.deepEqual(after.schemaObjects, before.schemaObjects, 'database schema changed');
  assert.deepEqual(after.tables.filter(t => t.name !== 'session_meta'),
    before.tables.filter(t => t.name !== 'session_meta'), 'non-metadata table changed');
}

export function assertPreservedDatabase(before, after) {
  assertSchemaAndOtherTables(before, after);
  assert.deepEqual(after.tables, before.tables, 'table digests were not preserved');
  assert.deepEqual(orderedRows(after.metadataRows), orderedRows(before.metadataRows), 'metadata rows were not preserved');
}

export function assertMetadataTransition(before, after, operation) {
  assertSchemaAndOtherTables(before, after);
  const { provider, id, action, title, startedAtMs, completedAtMs } = operation;
  const targetKey = JSON.stringify([provider, id]);
  const prior = before.metadataRows.find(row => key(row) === targetKey);
  const actual = after.metadataRows.find(row => key(row) === targetKey);
  assert.ok(actual, 'target metadata row missing');
  assert.deepEqual(orderedRows(after.metadataRows.filter(row => key(row) !== targetKey)),
    orderedRows(before.metadataRows.filter(row => key(row) !== targetKey)), 'non-target metadata rows changed');
  const expected = prior ? { ...prior } : { provider, session_id: id, custom_title: null,
    starred: 0, deleted: 0, permanent: 0, time_starred: null, time_deleted: null, time_renamed: null };
  const timestamp = field => {
    const value = actual[field];
    assert.ok(Number.isSafeInteger(value) && value >= startedAtMs && value <= completedAtMs,
      `${field} timestamp outside request window`);
    expected[field] = value;
  };
  switch (action) {
    case 'rename': expected.custom_title = title.trim(); timestamp('time_renamed'); break;
    case 'star':
      expected.starred = 1;
      if (!prior?.starred || prior.time_starred === null) timestamp('time_starred');
      break;
    case 'unstar': expected.starred = 0; expected.time_starred = null; break;
    case 'delete': expected.deleted = 1; timestamp('time_deleted'); break;
    case 'restore': expected.deleted = 0; expected.time_deleted = null; break;
    case 'permanent-delete':
      expected.deleted = 1; expected.permanent = 1;
      if (expected.time_deleted === null) timestamp('time_deleted');
      break;
    default: throw new Error('Unknown metadata action');
  }
  assert.deepEqual(actual, expected, 'target fields differ from the expected metadata mutation');
  assert.equal(after.metadataRows.length, before.metadataRows.length + (prior ? 0 : 1), 'metadata row count');
}

export function qualifyWatcher(records, { roots, controls, windowStartSequence }) {
  const errors = records.filter(row => row.kind === 'error');
  assert.equal(errors.length, 0, 'watcher error/overflow invalidates the window');
  for (const root of roots) assert.ok(records.some(row => row.kind === 'ready' && samePath(row.root, root)),
    'watcher ready marker missing');
  const start = windowStartSequence ?? 0;
  assert.ok(Number.isInteger(start) && start >= 0 && start < records.length, 'watcher window boundary invalid');
  if (windowStartSequence !== undefined) {
    for (const root of roots) assert.ok(records.slice(0, start).some(row => row.kind === 'ready' && samePath(row.root, root)),
      'watcher ready marker must precede the window boundary');
    assert.equal(records.at(-1)?.kind, 'stopped', 'watcher stopped boundary missing');
    assert.ok(records.findIndex(row => row.kind === 'change' && samePath(row.path, controls[0])) >= start,
      'first positive control precedes the window boundary');
  }
  const window = records.slice(start);
  for (const control of controls) assert.ok(window.some(row => row.kind === 'change' && samePath(row.path, control)),
    'watcher positive control missing');
  const protectedChanges = window.filter(row => row.kind === 'change'
    && [row.path, row.oldPath].filter(Boolean).some(target =>
      roots.some(root => samePath(root, target) || inside(root, target))
      && !controls.some(control => samePath(control, target))));
  assert.equal(protectedChanges.length, 0, 'protected path changed during controlled window');
  return { status: 'passed', eventCount: records.length, errorCount: errors.length,
    windowStartSequence: start, windowEndSequence: records.length, windowEventCount: window.length,
    preWindowChanges: records.slice(0, start).filter(row => row.kind === 'change'),
    protectedChanges: [], positiveControls: controls, writerPidAvailable: false, continuousKernelWriteProof: false,
    scope: 'Owned metadata input and candidate shadow directories from the start-control request through watcher stop. Earlier notifications are separately retained. Directory notifications are not kernel write attribution.' };
}

function assertNoLinks(target) {
  let cursor = path.resolve(target);
  let resolved = false;
  while (true) {
    if (existsSync(cursor)) {
      assert.ok(!lstatSync(cursor).isSymbolicLink(), `link/reparse path rejected: ${cursor}`);
      if (!resolved) {
        assert.ok(samePath(cursor, realpathSync.native(cursor)), `resolved path differs: ${cursor}`);
        resolved = true;
      }
    }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}

async function hashFile(file) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function family(file) {
  const result = [];
  for (const suffix of suffixes) {
    const target = file + suffix;
    if (!existsSync(target)) result.push({ suffix, exists: false });
    else { assertNoLinks(target); result.push({ suffix, exists: true, bytes: (await stat(target)).size, sha256: await hashFile(target) }); }
  }
  return result;
}

export async function protectedTreeSnapshot(root) {
  const rows = [];
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      assert.ok(!entry.isSymbolicLink(), `source/tree link rejected: ${target}`);
      if (entry.isDirectory()) {
        rows.push({ path: path.relative(root, target).replaceAll('\\', '/'), type: 'directory' });
        await walk(target);
      } else if (entry.isFile()) rows.push({ path: path.relative(root, target).replaceAll('\\', '/'), type: 'file',
        bytes: (await stat(target)).size, sha256: await hashFile(target) });
      else throw new Error(`source/tree special entry rejected: ${target}`);
    }
  };
  if (existsSync(root)) { assertNoLinks(root); await walk(root); }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return { exists: existsSync(root), files: rows.filter(row => row.type === 'file').length,
    directories: rows.filter(row => row.type === 'directory').length,
    bytes: rows.reduce((sum, row) => sum + (row.bytes ?? 0), 0),
    sha256: digest(JSON.stringify(rows)) };
}

async function copyFamily(source, target) {
  const before = await family(source);
  assert.ok(before[0].exists, 'metadata input database missing');
  await mkdir(path.dirname(target), { recursive: true });
  for (const row of before) if (row.exists) await copyFile(source + row.suffix, target + row.suffix);
  assert.deepEqual(await family(source), before, 'database family changed during copy');
  assert.deepEqual(await family(target), before, 'database family copy differs');
  return before;
}

function jsonSafe(value) {
  if (typeof value === 'bigint') return { integer: value.toString() };
  if (value instanceof Uint8Array) return { bytesHex: Buffer.from(value).toString('hex') };
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, jsonSafe(value[k])]));
  return value;
}

export async function inspectDatabase(source, inspectionRoot, label) {
  const dir = path.join(inspectionRoot, label); await mkdir(dir);
  const copy = path.join(dir, 'meta.db');
  // The inspected SQLite connection never targets a protected input or live metadata database.
  const bytes = await copyFamily(source, copy);
  const db = new DatabaseSync(copy, { readOnly: true });
  try {
    const schemaObjects = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
    const tables = [];
    for (const row of schemaObjects.filter(row => row.type === 'table')) {
      const statement = db.prepare('SELECT * FROM "' + row.name.replaceAll('"', '""') + '"');
      statement.setReadBigInts(true);
      const ordered = statement.all().map(row => JSON.stringify(jsonSafe(row))).sort();
      tables.push({ name: row.name, rowCount: ordered.length, schemaSha256: digest(row.sql ?? ''), rowsSha256: digest(ordered.join('\n')) });
    }
    return { schemaObjects, tables, metadataRows: db.prepare('SELECT * FROM session_meta ORDER BY provider,session_id').all().map(row => ({ ...row })),
      quickCheck: db.prepare('PRAGMA quick_check').get().quick_check, bytes };
  } finally { db.close(); }
}

const watcherScript = String.raw`param([string]$Settings)
$ErrorActionPreference='Stop'
$spec=Get-Content -Raw -LiteralPath $Settings|ConvertFrom-Json
$watchers=@()
$registrations=@()
function Emit($value){[Console]::WriteLine(($value|ConvertTo-Json -Compress -Depth 6));[Console]::Out.Flush()}
try{
  $index=0
  foreach($root in $spec.roots){
    $watcher=[IO.FileSystemWatcher]::new([string]$root)
    $watcher.Filter='*'
    $watcher.IncludeSubdirectories=$true
    $watcher.NotifyFilter=[IO.NotifyFilters]::FileName -bor [IO.NotifyFilters]::DirectoryName -bor [IO.NotifyFilters]::LastWrite -bor [IO.NotifyFilters]::Size -bor [IO.NotifyFilters]::Attributes
    $watcher.InternalBufferSize=65536
    foreach($kind in @('Changed','Created','Deleted','Renamed','Error')){
      $registrations+=Register-ObjectEvent -InputObject $watcher -EventName $kind -SourceIdentifier "state-$index-$kind"
    }
    $watcher.EnableRaisingEvents=$true
    $watchers+=$watcher
    Emit @{kind='ready';root=[string]$root;atUtc=[DateTime]::UtcNow.ToString('o');writerPid=$null;monitorProcessPid=$PID}
    $index++
  }
  while($true){
    $null=Wait-Event -Timeout 1
    foreach($notice in @(Get-Event)){
      $args=$notice.SourceEventArgs
      if($notice.SourceIdentifier.EndsWith('-Error')){Emit @{kind='error';message=$args.GetException().ToString();atUtc=[DateTime]::UtcNow.ToString('o');writerPid=$null}}
      else{Emit @{kind='change';path=$args.FullPath;oldPath=$args.OldFullPath;changeType=[string]$args.ChangeType;atUtc=[DateTime]::UtcNow.ToString('o');writerPid=$null}}
      Remove-Event -EventIdentifier $notice.EventIdentifier
    }
    if(Test-Path -LiteralPath $spec.stopFile){break}
  }
}catch{Emit @{kind='error';message=$_.Exception.ToString();atUtc=[DateTime]::UtcNow.ToString('o');writerPid=$null};exit 1}
finally{
  foreach($watcher in $watchers){$watcher.EnableRaisingEvents=$false;$watcher.Dispose()}
  foreach($registration in $registrations){Unregister-Event -SourceIdentifier $registration.SourceIdentifier -ErrorAction SilentlyContinue}
  Emit @{kind='stopped';atUtc=[DateTime]::UtcNow.ToString('o');writerPid=$null}
}
`;

async function save(file, value) { await writeFile(file, JSON.stringify(value, null, 2) + '\n'); }
export async function startWatcher(out, roots, env, options = {}) {
  const script = path.join(out, 'watcher.ps1'), settings = path.join(out, 'watcher-settings.json'), stopFile = path.join(out, 'watcher-stop');
  await writeFile(script, watcherScript); await save(settings, { roots, stopFile });
  // PowerShell writes startup/module caches. The observer must not share the protected candidate profile.
  const monitorEnv = isolatedEnvironment(path.join(out, 'monitor'), env);
  for (const name of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE']) await mkdir(monitorEnv[name], { recursive: true });
  const records = [], child = spawn(options.command ?? 'pwsh', options.args ?? ['-NoProfile', '-File', script, '-Settings', settings],
    { cwd: out, env: monitorEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const lifecycle = { pid: child.pid, role: 'watcher', startedAtUtc: new Date().toISOString(),
    environmentPaths: Object.fromEntries(['APPDATA', 'LOCALAPPDATA', 'USERPROFILE'].map(name => [name, monitorEnv[name]])) };
  const closed = observeOwnedChild(child, lifecycle); let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { try { records.push(JSON.parse(line)); } catch { records.push({ kind: 'error', message: 'watcher emitted invalid JSON' }); } });
  const started = Date.now();
  try {
    while (roots.some(root => !records.some(row => row.kind === 'ready' && samePath(row.root, root)))) {
      assert.ok(!lifecycle.spawnError, `watcher spawn failed: ${lifecycle.spawnError?.message}`);
      assert.ok(!lifecycle.closed, `watcher exited: ${stderr}`);
      assert.ok(Date.now() - started < 15000, 'watcher readiness timeout');
      assert.ok(!records.some(row => row.kind === 'error'), 'watcher startup error'); await delay(50);
    }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await withTimeout(closed, 10000, 'failed watcher cleanup timeout'); lines.close();
    await save(path.join(out, 'watcher-events.private.json'), records);
    await save(path.join(out, 'watcher-lifecycle.public.json'), lifecycle); throw error;
  }
  let stopPromise;
  const stop = async () => {
    let failure; const cleanupErrors = [];
    try {
      await writeFile(stopFile, 'stop');
      await withTimeout(closed, options.stopTimeoutMs ?? 10000, 'watcher close timeout');
    } catch (error) {
      failure = error; lifecycle.stopFailure = serializeError(error);
      records.push({ kind: 'error', message: error.message, stage: 'stop', atUtc: new Date().toISOString() });
      try {
        if (!lifecycle.closed && child.exitCode === null && child.signalCode === null) {
          lifecycle.terminationRequestedAtUtc = new Date().toISOString(); child.kill();
        }
      } catch (error) { cleanupErrors.push(error); }
      try { await withTimeout(closed, options.cleanupTimeoutMs ?? 10000, 'watcher forced close timeout'); }
      catch (error) { cleanupErrors.push(error); }
    } finally {
      lines.close();
      if (child.exitCode !== 0) records.push({ kind: 'error', message: `watcher exit ${child.exitCode}: ${stderr}` });
      try { await save(path.join(out, 'watcher-events.private.json'), records); }
      catch (error) { cleanupErrors.push(error); }
      if (cleanupErrors.length) lifecycle.cleanupErrors = cleanupErrors.map(error => serializeError(error));
      try { await save(path.join(out, 'watcher-lifecycle.public.json'), lifecycle); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors],
      failure?.message ?? 'watcher evidence cleanup failed', { cause: failure ?? cleanupErrors[0] });
    if (failure) throw failure;
  };
  return { child, records, stop() { return stopPromise ??= stop(); } };
}

async function positiveControl(watcher, file) {
  const startSequence = watcher.records.length;
  const startedAtUtc = new Date().toISOString();
  await writeFile(file, 'controlled watcher positive control\n');
  const started = Date.now();
  while (!watcher.records.slice(startSequence).some(row => row.kind === 'change' && samePath(row.path, file))) {
    assert.ok(Date.now() - started < 10000, 'watcher positive control timeout'); await delay(50);
  }
  return { path: file, startedAtUtc, startSequence, observedSequence: watcher.records.findIndex((row, index) => index >= startSequence
    && row.kind === 'change' && samePath(row.path, file)), completedAtUtc: new Date().toISOString() };
}

function parseArgs(argv) {
  const result = { prepareOnly: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--prepare-only') result.prepareOnly = true;
    else if (['--exe', '--expected-exe-sha256', '--manifest', '--metadata-copy', '--out'].includes(flag)) {
      assert.ok(argv[index + 1], `missing ${flag}`); result[flag.slice(2)] = argv[++index];
    } else throw new Error(`unknown flag: ${flag}`);
  }
  for (const flag of ['exe', 'expected-exe-sha256', 'manifest', 'metadata-copy', 'out']) assert.ok(result[flag], `--${flag} required`);
  return result;
}

async function prepare(options) {
  const out = path.resolve(options.out), input = path.resolve(options['metadata-copy']), exe = path.resolve(options.exe);
  assert.ok(inside(evidenceRoot, out), 'output must be a new directory inside the authorized metadata evidence root');
  assert.ok(!existsSync(out), 'output already exists'); assertNoLinks(out);
  for (const file of [input, path.resolve(options.manifest)]) {
    assert.ok(inside(path.join(repo, 'tmp'), file), 'inputs must be retained tmp copies'); assertNoLinks(file);
    assert.ok(!inside(out, file) && !inside(path.dirname(file), out), 'input and output must be separate');
  }
  assertNoLinks(exe); assert.equal(await hashFile(exe), options['expected-exe-sha256'].toLowerCase(), 'candidate hash mismatch');
  const manifest = JSON.parse(await readFile(options.manifest, 'utf8'));
  assert.equal(manifest.format, 'agentsession-v3-performance-input/v1', 'frozen manifest format');
  assert.deepEqual(Object.keys(manifest.providerRoots).sort(), [...providers].sort(), 'five provider roots required');
  const sources = providers.flatMap((provider, index) => {
    const root = path.resolve(manifest.providerRoots[provider].path);
    assert.ok(inside(path.join(repo, 'tmp'), root), 'source must be an existing frozen tmp copy');
    assert.ok(!inside(root, out) && !inside(out, root), 'source and output must be separate');
    assertNoLinks(root); assert.ok(existsSync(root), 'frozen provider root missing'); return [sourceFlags[index], root];
  });
  const state = { meta: path.join(out, 'state/meta'), index: path.join(out, 'state/index'), cache: path.join(out, 'state/cache') };
  for (const dir of [out, path.join(out, 'input'), path.join(out, 'inspection'), path.join(out, 'phases'),
    ...Object.values(state), path.join(out, 'shadow/roaming/agentsession'), path.join(out, 'shadow/roaming/agentsession-v3'),
    path.join(out, 'shadow/local'), path.join(out, 'shadow/profile')]) await mkdir(dir, { recursive: true });
  const inputCopy = path.join(out, 'input/old.db'); await copyFamily(input, inputCopy);
  const config = path.join(out, 'config.json'); await save(config, {});
  const shadowDb = path.join(out, 'shadow/roaming/agentsession/meta.db');
  const db = new DatabaseSync(shadowDb);
  db.exec(`CREATE TABLE session_meta(provider TEXT NOT NULL,session_id TEXT NOT NULL,custom_title TEXT,
    starred INTEGER DEFAULT 0,deleted INTEGER DEFAULT 0,permanent INTEGER DEFAULT 0,time_starred INTEGER,
    time_deleted INTEGER,time_renamed INTEGER,PRIMARY KEY(provider,session_id));
    CREATE TABLE shadow_sentinel(marker TEXT NOT NULL); INSERT INTO shadow_sentinel VALUES ('controlled-default-sentinel');`);
  db.close();
  await save(path.join(out, 'shadow/roaming/agentsession/config.json'), { sentinel: 'not selected by any candidate command' });
  await save(path.join(out, 'shadow/roaming/agentsession-v3/config.json'), { sentinel: 'not selected by any candidate command' });
  for (const name of ['begin', 'end']) await writeFile(path.join(out, `shadow/control-${name}.txt`), 'controlled watcher positive control\n');
  const env = isolatedEnvironment(out);
  const stateArgs = ['--meta-dir', state.meta, '--index-dir', state.index, '--cache-dir', state.cache];
  const plan = { format: 'agentsession-controlled-state/v1', preparedAtUtc: new Date().toISOString(), exe,
    exeSha256: options['expected-exe-sha256'].toLowerCase(), retainedMetadata: input, inputCopy, config,
    providerRoots: manifest.providerRoots, sources, stateArgs, out, environmentPaths: {
      APPDATA: env.APPDATA, LOCALAPPDATA: env.LOCALAPPDATA, USERPROFILE: env.USERPROFILE },
    environmentPolicy: 'Remove AGENTSESSION_*, PORT and provider home overrides. Never assign HOME or CODEX_HOME.',
    historicalSTATE01: 'F; historical default writer unknown; this controlled window does not replace it',
    originalDefaultDatabaseAccessedByHarness: false, continuousKernelWriteProof: false, writerPidAvailable: false };
  await save(path.join(out, 'plan.public.json'), plan);
  return { ...plan, env, state, manifest };
}

async function freePort() {
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

async function processRun(plan, args, report) {
  const child = spawn(plan.exe, args, { cwd: plan.out, env: plan.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const row = { pid: child.pid, role: 'cli', args, startedAtUtc: new Date().toISOString() }; report.processes.push(row);
  const closed = observeOwnedChild(child, row);
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  try { await withTimeout(closed, 180000, 'CLI timeout'); }
  finally { if (child.exitCode === null && child.signalCode === null) { child.kill(); await withTimeout(closed, 10000, 'CLI cleanup timeout'); } }
  assert.ok(!row.spawnError, `CLI spawn failed: ${row.spawnError?.message}`);
  return { status: child.exitCode, stdout: stdout.trim(), stderr };
}

async function startWeb(plan, report) {
  const port = await freePort(), args = ['--config', plan.config, 'serve', '--port', String(port), '--disable-terminal-launch', ...plan.sources, ...plan.stateArgs];
  const child = spawn(plan.exe, args, { cwd: plan.out, env: plan.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  const row = { pid: child.pid, role: 'web', args, port, startedAtUtc: new Date().toISOString() }; report.processes.push(row);
  const closed = observeOwnedChild(child, row);
  child.stderr.on('data', chunk => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}`, started = Date.now();
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(); await withTimeout(closed, 10000, 'Web cleanup timeout');
    row.exitCode = child.exitCode; row.signal = child.signalCode; row.completedAtUtc = new Date().toISOString();
    await assert.rejects(fetch(base + '/api/providers', { signal: AbortSignal.timeout(1000) }), 'owned Web listener still open');
    row.listenerClosed = true;
  };
  try {
    while (true) {
      assert.ok(!row.spawnError, `candidate Web spawn failed: ${row.spawnError?.message}`);
      assert.ok(!row.closed, `candidate Web exited: ${stderr}`);
      assert.ok(Date.now() - started < 180000, 'Web readiness timeout');
      try { if ((await fetch(base + '/api/providers', { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* readiness */ }
      await delay(100);
    }
    return { base, stop };
  } catch (error) { await stop(); throw error; }
}

export async function requestRecorded(base, route, body, phaseDir, sequence, options = {}) {
  const startedAtMs = Date.now();
  const response = await callHttpRaw(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { origin: base, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) },
    { ...options, timeoutMs: 180000, phase: path.basename(phaseDir) });
  const text = response.text, completedAtMs = Date.now();
  await save(path.join(phaseDir, `http-${sequence}.private.json`), { route, body, status: response.status, text, startedAtMs, completedAtMs });
  assert.equal(response.status, 200, `HTTP ${route}: ${text.slice(0, 300)}`);
  return { body: JSON.parse(text), startedAtMs, completedAtMs };
}

export async function exerciseMcp(plan, phaseDir, report, evidence) {
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const client = new Client({ name: 'agentsession-controlled-state', version: '1.0.0' });
  const args = ['--config', plan.config, 'mcp', ...plan.sources, ...plan.stateArgs];
  const transport = new StdioClientTransport({ command: plan.exe, args, cwd: plan.out, env: plan.env, stderr: 'pipe' });
  const record = { role: 'mcp', args, startedAtUtc: new Date().toISOString() }; report.processes.push(record);
  const connectionId = evidence.begin({ transport: 'lifecycle', service: 'mcp', phase: path.basename(phaseDir), args });
  let child, closed, stderr = '', connectionFinished = false;
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  try {
    const connecting = client.connect(transport); connecting.catch(() => {});
    child = transport._process;
    assert.ok(child, 'SDK primary child process unavailable for closure observation');
    record.pid = child.pid; closed = observeOwnedChild(child, record);
    await withTimeout(connecting, 180000, 'MCP connect timeout');
    evidence.finish(connectionId, { outcome: 'response', response: { connected: true, pid: record.pid } });
    connectionFinished = true;
    let sequence = 0;
    for (const [name, first] of [['session_browse', { level: 'sessions', providers, parent: null, limit: 100 }],
      ['session_search', { query: 'OpenSession', providers, fields: ['title', 'directory'], limit: 20 }]]) {
      let cursor;
      const seen = new Set();
      do {
        const arguments_ = { ...first, ...(cursor ? { cursor } : {}) };
        const response = await callMcpRaw({ client, child, evidence, phase: path.basename(phaseDir) }, name, arguments_, 180000);
        await save(path.join(phaseDir, `mcp-${++sequence}.private.json`), { name, arguments: arguments_, response });
        assert.notEqual(response.isError, true, `${name} isError`); assert.ok(response.structuredContent?.result, `${name} result missing`);
        const result = response.structuredContent.result;
        assert.ok(providers.every(provider => result.diagnostics?.some(row => row.provider === provider && row.status === 'ok')), 'MCP provider unavailable');
        cursor = result.nextCursor; if (cursor) { assert.ok(!seen.has(cursor), 'MCP repeated cursor'); seen.add(cursor); }
        assert.ok(sequence < 10000, 'MCP traversal exceeds bounded corpus');
      } while (cursor);
    }
  } catch (error) {
    if (!connectionFinished) {
      try { evidence.finish(connectionId, { outcome: 'error', error: serializeError(error) }); }
      catch (captureError) { throw new AggregateError([error, captureError], error.message, { cause: error }); }
    }
    throw error;
  } finally {
    try { await withTimeout(client.close(), 10000, 'MCP close timeout'); }
    finally {
      if (child && !record.closed && child.exitCode === null && child.signalCode === null) child.kill();
      if (closed) await withTimeout(closed, 10000, 'MCP actual child close timeout');
      await writeFile(path.join(phaseDir, 'mcp-stderr.private.log'), stderr);
      record.stderr = { file: path.relative(plan.out, path.join(phaseDir, 'mcp-stderr.private.log')),
        bytes: Buffer.byteLength(stderr), sha256: digest(stderr) };
    }
  }
}

async function protectedSnapshot(plan) {
  const sourceCopies = {};
  for (const provider of providers) {
    const root = plan.manifest.providerRoots[provider].path;
    sourceCopies[provider] = provider === 'opencode' ? await family(root) : await protectedTreeSnapshot(root);
  }
  return { retainedMetadata: await family(plan.retainedMetadata), inputMetadata: await family(plan.inputCopy),
    sourceCopies, shadow: await protectedTreeSnapshot(path.join(plan.out, 'shadow')), configSha256: await hashFile(plan.config) };
}

async function execute(plan) {
  const report = { controlledStateValidation: 'failed', startedAtUtc: new Date().toISOString(), phases: [], processes: [],
    historicalSTATE01: plan.historicalSTATE01, originalDefaultDatabaseAccessedByHarness: false, writerPidAvailable: false,
    continuousKernelWriteProof: false, limitations: ['FileSystemWatcher has no writer PID and is not exhaustive kernel write tracing.',
      'Real default user DB was excluded; historical default byte preservation remains F. Source hashing warms caches; no performance claim.'] };
  const capabilityFile = path.resolve(evidenceRoot, '../trace-capability/capability.public.json');
  if (existsSync(capabilityFile)) report.kernelTraceCapability = JSON.parse(await readFile(capabilityFile, 'utf8'));
  const roots = [path.join(plan.out, 'input'), path.join(plan.out, 'shadow')];
  const controls = ['begin', 'end'].map(name => path.join(plan.out, `shadow/control-${name}.txt`));
  let watcher, target, last;
  const inspection = path.join(plan.out, 'inspection'); let phaseNo = 0;
  const phase = async (name, work) => {
    const label = `${String(++phaseNo).padStart(2, '0')}-${name}`, dir = path.join(plan.out, 'phases', label); await mkdir(dir);
    const row = { name, startedAtUtc: new Date().toISOString(), status: 'failed' }; report.phases.push(row);
    const evidence = createCallEvidence({ directory: path.join(dir, 'calls') });
    try { await work(dir, row, evidence); row.status = 'passed'; }
    catch (error) { row.error = serializeError(error); throw error; }
    finally {
      row.completedAtUtc = new Date().toISOString(); row.callEvidence = evidence.audit();
      await save(path.join(dir, 'summary.public.json'), row);
      assert.ok(row.callEvidence.ok, 'phase call evidence is incomplete');
    }
    return row;
  };
  try {
    watcher = await startWatcher(plan.out, roots, plan.env);
    report.before = await protectedSnapshot(plan); await save(path.join(plan.out, 'protected-before.public.json'), report.before);
    const original = await inspectDatabase(plan.inputCopy, inspection, 'input-before');
    await save(path.join(plan.out, 'input-before.private.json'), original);
    report.baselineCompletedAtUtc = new Date().toISOString();
    report.positiveControls = [await positiveControl(watcher, controls[0])];
    report.controlWindowOpenedAtUtc = report.positiveControls[0].completedAtUtc;
    await phase('import', async (dir, row) => {
      const args = ['--config', plan.config, 'migrate-meta', '--from', plan.inputCopy, ...plan.sources, ...plan.stateArgs];
      const result = await processRun(plan, args, report); await save(path.join(dir, 'cli.private.json'), result);
      assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /^[a-f0-9]{64}$/);
      target = path.join(plan.state.meta, 'scopes', result.stdout, 'meta.db'); row.scope = result.stdout;
      last = await inspectDatabase(target, inspection, 'after-import'); assertPreservedDatabase(original, last);
      await save(path.join(dir, 'snapshot.private.json'), last);
      const repeated = await processRun(plan, args, report); await save(path.join(dir, 'repeat.private.json'), repeated);
      assert.notEqual(repeated.status, 0); assert.match(repeated.stderr, /already exists/i);
      const repeatedSnapshot = await inspectDatabase(target, inspection, 'after-repeat');
      assertPreservedDatabase(last, repeatedSnapshot); assert.deepEqual(repeatedSnapshot.bytes, last.bytes, 'repeat import changed target bytes');
      await save(path.join(dir, 'repeat-snapshot.private.json'), repeatedSnapshot);
      row.completeSchemaAndAllTablesPreserved = true; row.repeatImportRefused = true;
    });
    const selected = [];
    const metadataApiCheck = async (web, dir, sequence, evidence) => {
      for (const provider of providers) {
        const actual = (await requestRecorded(web.base, '/api/v3/meta?provider=' + encodeURIComponent(provider), undefined, dir, sequence++, { evidence })).body;
        const expected = last.metadataRows.filter(row => row.provider === provider).map(row => ({ provider, sessionId: row.session_id,
          customTitle: row.custom_title, starred: !!row.starred, deleted: !!row.deleted, permanent: !!row.permanent,
          timeStarred: row.time_starred, timeDeleted: row.time_deleted, timeRenamed: row.time_renamed }));
        assert.deepEqual(actual, expected, 'metadata API differs from complete stored rows');
      }
    };
    for (const name of ['read', 'reindex', 'restart']) await phase(name, async (dir, row, evidence) => {
      const web = await startWeb(plan, report);
      try {
        await metadataApiCheck(web, dir, 1, evidence);
        const settings = (await requestRecorded(web.base, '/api/settings', undefined, dir, 6, { evidence })).body;
        assert.deepEqual(settings.startup.state, { metaDir: plan.state.meta, indexDir: plan.state.index, cacheDir: plan.state.cache });
        assert.deepEqual(settings.startup.sources, { dbPath: plan.sources[1], claudeDir: plan.sources[3],
          codexDir: plan.sources[5], piDir: plan.sources[7], dshDir: plan.sources[9] }, 'actual Web source paths differ from the frozen copies');
        if (name === 'read') {
          for (const provider of providers) {
            const sessions = (await requestRecorded(web.base, '/api/v3/sessions?provider=' + encodeURIComponent(provider), undefined, dir, `list-${provider}`, { evidence })).body;
            assert.ok(Array.isArray(sessions) && sessions.length > 0, 'frozen provider has no readable sessions');
            if (!selected.length) selected.push(...sessions.slice(0, 2).map(row => row.session));
          }
          assert.equal(selected.length, 2, 'two distinct sessions required for mutation verification');
          for (const [index, session] of selected.entries()) await requestRecorded(web.base,
            `/api/v3/reader/${encodeURIComponent(session.provider)}/${encodeURIComponent(session.sessionId)}/bootstrap`, undefined, dir, `reader-${index}`, { evidence });
          await exerciseMcp(plan, dir, report, evidence);
        } else if (name === 'reindex') await requestRecorded(web.base, '/api/reindex', {}, dir, 7, { evidence });
      } finally { await web.stop(); }
      const next = await inspectDatabase(target, inspection, `after-${name}`);
      assertPreservedDatabase(last, next); assert.deepEqual(next.bytes, last.bytes, `${name} changed metadata bytes`);
      last = next; await save(path.join(dir, 'snapshot.private.json'), next); row.metadataRowsAndBytesPreserved = true;
    });
    const first = selected[0], second = selected[1];
    for (const [index, operation] of [
      { ...first, action: 'rename', title: 'Controlled STATE-01 title' }, { ...first, action: 'star' },
      { ...first, action: 'star' }, { ...first, action: 'unstar' }, { ...first, action: 'delete' },
      { ...first, action: 'restore' }, { ...second, action: 'permanent-delete' },
    ].entries()) await phase(`mutation-${index + 1}-${operation.action}`, async (dir, row, evidence) => {
      const web = await startWeb(plan, report); let result;
      try {
        const encoded = [operation.provider, operation.sessionId].map(encodeURIComponent);
        const batch = ['star', 'unstar'].includes(operation.action);
        const route = batch ? `/api/${encoded[0]}/batch` : `/api/${encoded[0]}/session/${encoded[1]}/${operation.action}`;
        const body = batch ? { ids: [operation.sessionId], action: operation.action }
          : operation.action === 'rename' ? { title: operation.title } : {};
        result = await requestRecorded(web.base, route, body, dir, 1, { evidence });
        if (batch) assert.deepEqual(result.body, { ok: true, affected: 1 });
      } finally { await web.stop(); }
      const next = await inspectDatabase(target, inspection, `after-mutation-${index + 1}`);
      assertMetadataTransition(last, next, { ...operation, id: operation.sessionId,
        startedAtMs: result.startedAtMs, completedAtMs: result.completedAtMs });
      last = next; await save(path.join(dir, 'snapshot.private.json'), next);
      row.target = { provider: operation.provider, sessionIdSha256: digest(operation.sessionId) };
      row.onlyExpectedTargetFieldsChanged = true; row.otherTablesAndRetiredRowsPreserved = true;
    });
    report.positiveControls.push(await positiveControl(watcher, controls[1]));
    report.after = await protectedSnapshot(plan); await save(path.join(plan.out, 'protected-after.public.json'), report.after);
    assert.deepEqual(report.after, report.before, 'retained input/source/shadow/config endpoint bytes changed');
    const inputAfter = await inspectDatabase(plan.inputCopy, inspection, 'input-after');
    assertPreservedDatabase(original, inputAfter); await save(path.join(plan.out, 'input-after.private.json'), inputAfter);
    await watcher.stop(); assert.ok(watcher.records.some(row => row.kind === 'stopped'), 'watcher stopped marker missing');
    report.watcher = qualifyWatcher(watcher.records, { roots, controls,
      windowStartSequence: report.positiveControls[0].startSequence }); watcher = null;
    report.controlledStateValidation = 'passed';
  } catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
  finally {
    if (watcher) { try { await watcher.stop(); } catch (error) { report.monitorCleanupError = error.message; } }
    if (report.before && !report.after) {
      try {
        report.after = await protectedSnapshot(plan);
        await save(path.join(plan.out, 'protected-after.public.json'), report.after);
      } catch (error) { report.protectedEndpointCaptureError = serializeError(error); }
    }
    if (report.before && report.after) report.protectedEndpointEquality = JSON.stringify(report.before) === JSON.stringify(report.after);
    report.completedAtUtc = new Date().toISOString();
    await save(path.join(plan.out, 'report.private.json'), report);
    const { before, after, error, ...publicReport } = report;
    await save(path.join(plan.out, 'report.public.json'), { ...publicReport, inputDigests: { before, after },
      error: error ? { name: error.name, message: error.message } : undefined,
      minimumAdditionalPrivilege: 'Admin-controlled independent FileIO trace with lost=0 and thread/file-name/PID association. No UAC or installation performed.' });
  }
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv), plan = await prepare(options);
  if (options.prepareOnly) return { controlledStateValidation: 'prepared; no services started', out: plan.out, historicalSTATE01: plan.historicalSTATE01 };
  return execute(plan);
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  main().then(report => console.log(JSON.stringify({ controlledStateValidation: report.controlledStateValidation,
    historicalSTATE01: report.historicalSTATE01, out: report.out ?? process.argv[process.argv.indexOf('--out') + 1] })))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
