import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { privateDir, sourceStat } from './v3-bench-matched.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const fileHash = file => hash(readFileSync(file));
const canon = value => Array.isArray(value) ? `[${value.map(canon).join(',')}]`
  : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const nearest = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null;
const kind = error => /^[A-Za-z][A-Za-z0-9]*$/.test(error?.name ?? '') ? error.name : 'Error';
const sourceStats = manifest => Object.fromEntries(Object.entries(manifest.providerRoots)
  .map(([name, item]) => [name, sourceStat(item.path, name === 'codex')]));
const directoryBytes = directory => readdirSync(directory, { withFileTypes: true }).reduce((sum, entry) => {
  const full = path.join(directory, entry.name);
  return sum + (entry.isDirectory() ? directoryBytes(full) : entry.isFile() ? statSync(full).size : 0);
}, 0);
const sampleProcess = pid => {
  try {
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$p=Get-Process -Id ${Number(pid)}; @{rssBytes=[long]$p.WorkingSet64;peakRssBytes=[long]$p.PeakWorkingSet64;cpuMs=$p.TotalProcessorTime.TotalMilliseconds}|ConvertTo-Json -Compress`],
    { encoding: 'utf8' }).trim());
  } catch { return null; }
};

export function compareSourceGoldRow(row, expected, query) {
  const sameInput = expected.label === query.label && expected.querySha256 === query.querySha256
    && hash(query.query) === query.querySha256;
  const sameCount = row.matches.length === expected.count;
  const diagnostics = [...row.diagnostics].sort();
  const sameDiagnostics = canon(diagnostics) === canon(expected.diagnostics.map(d => `${d.provider}:${d.status}`).sort());
  if (expected.coverage === 'partial-unresolved-metadata') {
    const unresolved = new Map(expected.unknownMatches.map(match =>
      [`${match.session.provider}\0${match.session.sessionId}`, match]));
    const known = row.matches.filter(match => !unresolved.has(`${match.session.provider}\0${match.session.sessionId}`));
    const unknown = row.matches.filter(match => unresolved.has(`${match.session.provider}\0${match.session.sessionId}`));
    const knownEqual = canon(known) === canon(expected.knownMatches);
    const unknownKeys = unknown.map(match => `${match.session.provider}\0${match.session.sessionId}`);
    const unknownFieldsEqual = unknown.length === expected.unknownMatches.length
      && new Set(unknownKeys).size === unresolved.size && unknown.every(match => {
      const source = unresolved.get(`${match.session.provider}\0${match.session.sessionId}`);
      return match.matchField === source.matchField && match.title === source.title
        && match.directory === source.directory && match.event === null && match.matchRole === null;
    });
    return { sameInput, sameCount, sameDiagnostics, knownEqual, unknownFieldsEqual,
      unknownTimestampUnverified: true, passed: sameInput && sameCount && sameDiagnostics && knownEqual && unknownFieldsEqual };
  }
  const orderedEqual = canon(row.matches) === canon(expected.matches);
  const firstPageEqual = row.pages[0]?.semanticHash === expected.firstPageSemanticSha256;
  return { sameInput, sameCount, sameDiagnostics, orderedEqual, firstPageEqual,
    passed: sameInput && sameCount && sameDiagnostics && orderedEqual && firstPageEqual };
}

function parseArgs(argv) {
  const options = { repetitions: 3, timeoutMs: 120000 };
  const names = { '--manifest': 'manifestPath', '--gold': 'goldPath', '--arms': 'armPath',
    '--output-dir': 'outputDir', '--manifest-sha': 'manifestSha', '--gold-sha': 'goldSha',
    '--binary-sha': 'binarySha', '--repetitions': 'repetitions', '--timeout-ms': 'timeoutMs' };
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--help') return { help: true };
    if (!names[argv[i]] || !argv[i + 1]) throw Error(`Invalid or incomplete option: ${argv[i]}`);
    options[names[argv[i]]] = argv[i + 1];
  }
  for (const key of ['manifestPath', 'goldPath', 'armPath', 'outputDir', 'manifestSha', 'goldSha', 'binarySha']) {
    if (!options[key]) throw Error(`Missing ${key}`);
  }
  options.repetitions = Number(options.repetitions);
  options.timeoutMs = Number(options.timeoutMs);
  if (!Number.isInteger(options.repetitions) || options.repetitions < 3 || options.repetitions > 5) {
    throw Error('Use 3-5 repetitions');
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000) throw Error('Invalid timeout');
  for (const key of ['manifestSha', 'goldSha', 'binarySha']) {
    if (!/^[0-9a-f]{64}$/i.test(options[key])) throw Error(`Invalid ${key}`);
    options[key] = options[key].toLowerCase();
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
const options = parseArgs(argv);
if (options.help) {
  console.log('Usage: node scripts/v3-bench-source-gold.mjs --manifest <private.json> --gold <independent-private.json> --arms <private.json> --output-dir <fresh-tmp-dir> --manifest-sha <sha256> --gold-sha <sha256> --binary-sha <sha256> [--repetitions 3] [--timeout-ms 120000]');
  return;
}
const { manifestPath, goldPath, armPath, repetitions, timeoutMs } = options;
const manifest = JSON.parse(readFileSync(manifestPath));
const gold = JSON.parse(readFileSync(goldPath));
const arm = JSON.parse(readFileSync(armPath)).v3;
const binary = arm.command;
const outputDir = privateDir(path.resolve(options.outputDir));
const inputsBefore = { manifest: fileHash(manifestPath), gold: fileHash(goldPath), binary: fileHash(binary), sources: sourceStats(manifest) };
const preflightChecks = {
  manifestHash: inputsBefore.manifest === options.manifestSha,
  goldHash: inputsBefore.gold === options.goldSha,
  binaryHash: inputsBefore.binary === options.binarySha,
  codexSourceStat: canon(inputsBefore.sources.codex) === canon(manifest.codexStat),
  goldFormat: gold.format === 'agentsession-v3-source-search-expected/v1' && gold.queries.length === 9,
  queryCount: manifest.queries.length === 9,
  coverage: gold.coverage?.status === 'partial',
};
const inputsMatch = Object.values(preflightChecks).every(Boolean);
writeFileSync(path.join(outputDir, 'preflight.private.json'), JSON.stringify({ inputsBefore, inputsMatch, preflightChecks,
  goldCoverage: gold.coverage, repetitions, timeoutMs }, null, 2));
if (!inputsMatch) {
  writeFileSync(path.join(outputDir, 'preflight.public.json'), JSON.stringify({ status: 'failed', preflightChecks }, null, 2));
  throw Object.assign(new Error('Frozen inputs failed preflight'), { name: 'PreflightFailed' });
}

const records = [];
for (let repetition = 1; repetition <= repetitions; repetition++) {
  const trialDir = path.join(outputDir, `rep-${repetition}`);
  mkdirSync(trialDir);
  const state = { configPath: path.join(trialDir, 'config.json'), metaDir: path.join(trialDir, 'meta'),
    indexDir: path.join(trialDir, 'index'), cacheDir: path.join(trialDir, 'cache') };
  writeFileSync(state.configPath, '{}');
  const replacements = Object.fromEntries(Object.entries(manifest.providerRoots).map(([name, value]) => [name, value.path]));
  Object.assign(replacements, state);
  const args = arm.args.map(arg => arg.replace(/\{(opencode|claude-code|codex|pi|deepseek-harness|configPath|metaDir|indexDir|cacheDir)\}/g,
    (_, key) => replacements[key]));
  const record = { repetition, status: 'failed', phases: [], queries: [], errors: [], retries: 0,
    startedAtUtc: new Date().toISOString(), invocation: { command: binary, args, cwd: arm.cwd } };
  const save = () => writeFileSync(path.join(trialDir, 'record.private.json'), JSON.stringify(record, null, 2));
  save();

  async function open(phase) {
    const transport = new StdioClientTransport({ command: binary, args, cwd: arm.cwd,
      env: { ...process.env, AGENTSESSION_CONFIG: state.configPath, AGENTSESSION_META_PATH: path.join(trialDir, 'meta.db') },
      stderr: 'pipe' });
    const stderr = [];
    transport.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
    const client = new Client({ name: 'agentsession-v3-source-gold-bench', version: '1.0.0' });
    const started = performance.now();
    try {
      await client.connect(transport);
      const handshakeMs = performance.now() - started;
      const child = transport._process;
      const exit = child && new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
      const first = await search(client, manifest.queries[0]);
      const entry = { phase, handshakeMs, firstAnswerMs: performance.now() - started,
        firstPageWallMs: first.wallMs, firstPageSemanticSha256: first.semanticHash,
        firstPageMatchesGold: first.semanticHash === gold.queries[0].firstPageSemanticSha256,
        processAtAnswer: sampleProcess(transport.pid) };
      record.phases.push(entry); save();
      return { client, transport, entry, exit, stderr, pid: transport.pid };
    } catch (error) {
      await client.close().catch(() => transport.close().catch(() => {}));
      writeFileSync(path.join(trialDir, `${phase}.stderr.private.log`), Buffer.concat(stderr));
      throw error;
    }
  }

  async function search(client, query, cursor) {
    const input = { query: query.query, providers: query.providers, fields: query.fields,
      limit: query.limit, updatedBefore: manifest.updatedBeforeUnixMs, ...(cursor ? { cursor } : {}) };
    const start = performance.now();
    const response = await client.callTool({ name: 'session_search', arguments: input }, { timeout: timeoutMs });
    const wallMs = performance.now() - start;
    const result = response.structuredContent?.result;
    if (response.isError || !Array.isArray(result?.matches) || !Array.isArray(result?.diagnostics)
      || !(result.nextCursor === null || (typeof result.nextCursor === 'string' && result.nextCursor.length))
      || result.truncated !== (result.nextCursor !== null)) throw Error('InvalidResult');
    const diagnostic = result.diagnostics.map(d => `${d.provider}:${d.status}`).sort();
    const expected = gold.queries[manifest.queries.indexOf(query)].diagnostics.map(d => `${d.provider}:${d.status}`).sort();
    if (canon(diagnostic) !== canon(expected)) throw Error('DiagnosticMismatch');
    return { matches: result.matches, cursor: result.nextCursor, wallMs, semanticHash: hash(canon(result.matches)),
      diagnostics: diagnostic, inputBytes: Buffer.byteLength(JSON.stringify(input)),
      outputBytes: Buffer.byteLength(JSON.stringify(response)) };
  }

  async function close(session) {
    if (!session) return;
    session.entry.processBeforeExit = sampleProcess(session.pid);
    await session.client.close().catch(error => record.errors.push({ phase: session.entry.phase, kind: kind(error) }));
    session.entry.exit = await Promise.race([session.exit ?? Promise.resolve(null),
      new Promise(resolve => setTimeout(() => resolve({ observation: 'timeout' }), 5000))]);
    session.entry.stderrBytes = Buffer.concat(session.stderr).length;
    writeFileSync(path.join(trialDir, `${session.entry.phase}.stderr.private.log`), Buffer.concat(session.stderr));
    save();
  }

  let session;
  try {
    session = await open('fresh-build');
    for (const [index, query] of manifest.queries.entries()) {
      const row = { label: query.label, pages: [], matches: [], diagnostics: [], repeatedFirstPage: null };
      record.queries.push(row); save();
      const seen = new Set();
      let cursor;
      do {
        const page = await search(session.client, query, cursor);
        if (page.matches.length === 0 && (cursor || page.cursor)) throw Error('EmptyCursorPage');
        row.pages.push({ wallMs: page.wallMs, count: page.matches.length, semanticHash: page.semanticHash,
          inputBytes: page.inputBytes, outputBytes: page.outputBytes });
        row.matches.push(...page.matches);
        row.diagnostics.push(...page.diagnostics);
        cursor = page.cursor;
        if (cursor && seen.has(cursor)) throw Error('RepeatedCursor');
        if (cursor) seen.add(cursor);
        if (row.pages.length > 10000) throw Error('PageCap');
        save();
      } while (cursor);
      const repeat = await search(session.client, query);
      row.repeatedFirstPage = { wallMs: repeat.wallMs, semanticHash: repeat.semanticHash,
        sameAsFirst: repeat.semanticHash === row.pages[0].semanticHash,
        inputBytes: repeat.inputBytes, outputBytes: repeat.outputBytes };
      row.diagnostics = [...new Set(row.diagnostics)].sort();
      row.compare = compareSourceGoldRow(row, gold.queries[index], query);
      row.fullPaginationWallMs = row.pages.reduce((sum, page) => sum + page.wallMs, 0);
      row.passed = row.compare.passed && row.repeatedFirstPage.sameAsFirst;
      save();
    }
    await close(session); session = null;
    session = await open('unchanged-restart');
    await close(session); session = null;
    record.status = record.queries.length === 9 && record.queries.every(row => row.passed)
      && record.phases.length === 2 && record.phases.every(phase => phase.firstPageMatchesGold)
      && !record.errors.length ? 'passed' : 'failed';
  } catch (error) {
    record.errors.push({ phase: record.queries.length < 9 ? 'search' : 'restart', kind: kind(error), message: error.message });
    await close(session); session = null;
  }
  record.completedAtUtc = new Date().toISOString(); save();
  console.log(JSON.stringify({ repetition, status: record.status, completedQueries: record.queries.filter(row => row.passed).length,
    errors: record.errors.map(error => error.kind) }));
  records.push(record);
}

const inputsAfter = { manifest: fileHash(manifestPath), gold: fileHash(goldPath), binary: fileHash(binary), sources: sourceStats(manifest) };
const inputsUnchanged = canon(inputsBefore) === canon(inputsAfter);
const allPassed = inputsUnchanged && records.length === repetitions && records.every(record => record.status === 'passed');
const repeated = records.flatMap(record => record.queries.map(row => row.repeatedFirstPage?.wallMs).filter(Number.isFinite));
const restart = records.map(record => record.phases.find(phase => phase.phase === 'unchanged-restart')?.firstAnswerMs).filter(Number.isFinite);
const publicRecords = records.map(record => ({ repetition: record.repetition, status: record.status,
  derivedIndexBytes: existsSync(path.join(outputDir, `rep-${record.repetition}`, 'index'))
    ? directoryBytes(path.join(outputDir, `rep-${record.repetition}`, 'index')) : null,
  phases: record.phases.map(phase => ({ phase: phase.phase, handshakeMs: phase.handshakeMs,
    firstAnswerMs: phase.firstAnswerMs, firstPageWallMs: phase.firstPageWallMs,
    firstPageMatchesGold: phase.firstPageMatchesGold, processAtAnswer: phase.processAtAnswer,
    processBeforeExit: phase.processBeforeExit, stderrBytes: phase.stderrBytes, exit: phase.exit })),
  queries: record.queries.map(row => ({ label: row.label, count: row.matches.length, pages: row.pages.length,
    firstPageWallMs: row.pages[0]?.wallMs ?? null, fullPaginationWallMs: row.fullPaginationWallMs ?? null,
    repeatWallMs: row.repeatedFirstPage?.wallMs ?? null, inputBytes: row.pages.reduce((s, p) => s + p.inputBytes, 0),
    outputBytes: row.pages.reduce((s, p) => s + p.outputBytes, 0), compare: row.compare ?? null, passed: row.passed ?? false })),
  errors: record.errors.map(error => ({ phase: error.phase, kind: error.kind })) }));
const summary = { format: 'agentsession-v3-source-gold-performance/v1', generatedAtUtc: new Date().toISOString(),
  status: allPassed ? 'passed' : 'failed', coverage: gold.coverage, trialOrder: publicRecords.map(record => record.repetition),
  inputHashesBefore: { manifest: inputsBefore.manifest, gold: inputsBefore.gold, binary: inputsBefore.binary },
  inputHashesAfter: { manifest: inputsAfter.manifest, gold: inputsAfter.gold, binary: inputsAfter.binary },
  sourceStatsBefore: inputsBefore.sources, sourceStatsAfter: inputsAfter.sources, inputsUnchanged,
  repetitions: publicRecords,
  aggregate: { repeatedCalls: repeated.length, repeatedMedianMs: nearest(repeated, 0.5), repeatedP95Ms: nearest(repeated, 0.95),
    freshBuildSamplesMs: records.map(record => record.phases.find(phase => phase.phase === 'fresh-build')?.firstAnswerMs),
    unchangedRestartSamplesMs: restart, unchangedRestartMedianMs: nearest(restart, 0.5), unchangedRestartP95Ms: nearest(restart, 0.95),
    queries: manifest.queries.map((query, index) => {
      const samples = publicRecords.map(record => record.queries[index]?.fullPaginationWallMs).filter(Number.isFinite);
      return { label: query.label, fullPaginationSamplesMs: samples,
        fullPaginationMedianMs: samples.length === repetitions ? nearest(samples, 0.5) : null,
        fullPaginationP95Ms: samples.length === repetitions ? nearest(samples, 0.95) : null };
    }) },
  limitations: ['Frozen Codex stat signature checked; the 3.4 GB Codex content was not reread.',
    'Two metadata matches have source-unresolved timestamps; only source-proven fields were compared for those rows.',
    'Windows OS file cache and background machine load were not controlled. MCP payload bytes exclude stdio framing; RSS and CPU sample only the MCP process.',
    'Index bytes are post-run derived-state directory sizes, not process disk reads.',
    'This is a 3.0-only absolute measurement, with no cross-version speedup claim.'] };
writeFileSync(path.join(outputDir, 'summary.public.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ status: summary.status, inputsUnchanged, repeatedP95Ms: summary.aggregate.repeatedP95Ms,
  unchangedRestartP95Ms: summary.aggregate.unchangedRestartP95Ms }));
if (!allPassed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Benchmark failed: ${kind(error)}`); process.exitCode = 1; });
}
