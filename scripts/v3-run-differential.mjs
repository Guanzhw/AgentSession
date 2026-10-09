#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tmp');
const captureScript = path.join(root, 'scripts', 'v3-capture-contract.mjs');
const compareScript = path.join(root, 'scripts', 'v3-compare-snapshots.mjs');
const format = 'agentsession-v3-differential-plan/v1';
const processLimitMs = 30 * 60 * 1000;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const safe = (message) => Object.assign(new Error(message), { publicSafe: true });

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function privatePath(input, mustExist = false) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || !inside(tmp, input)) throw safe('Private paths must be absolute and under this checkout\'s tmp/');
  mkdirSync(path.dirname(input), { recursive: true });
  const physicalTmp = realpathSync(tmp);
  const parent = realpathSync(path.dirname(input));
  if (!inside(realpathSync(root), physicalTmp) || (parent !== physicalTmp && !inside(physicalTmp, parent))) throw safe('Private path resolves outside tmp/');
  if (existsSync(input)) {
    const stat = lstatSync(input);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw safe('Private path must be a regular unlinked file');
    if (!mustExist) throw safe('Private output already exists');
  } else if (mustExist) throw safe('Private input does not exist');
  return input;
}

function privateDirectory(input, physicalCorpus) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || !inside(tmp, input)) throw safe('State directories must be absolute and under tmp/');
  let ancestor = input;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const physicalAncestor = realpathSync(ancestor);
  const physicalTmp = realpathSync(tmp);
  if ((physicalAncestor !== physicalTmp && !inside(physicalTmp, physicalAncestor)) ||
      physicalAncestor === physicalCorpus || inside(physicalCorpus, physicalAncestor)) {
    throw safe('State directory resolves outside permitted private state');
  }
  mkdirSync(input, { recursive: true });
  const physical = realpathSync(input);
  if (!inside(physicalTmp, physical) || physical === physicalCorpus || inside(physicalCorpus, physical)) {
    throw safe('State directory resolves outside permitted private state');
  }
  return physical;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function commandSpec(value) {
  return plainObject(value) && typeof value.command === 'string' && value.command.length > 0 &&
    Array.isArray(value.args) && value.args.every((arg) => typeof arg === 'string') &&
    plainObject(value.env) && Object.values(value.env).every((entry) => typeof entry === 'string') &&
    typeof value.cwd === 'string' && path.isAbsolute(value.cwd);
}

function frozenSources(manifestPath, corpusRoot) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw safe('Frozen corpus manifest is invalid JSON');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw safe('Frozen corpus manifest has no source files');
  const entries = [...manifest.files, ...(manifest.database ? [manifest.database] : [])];
  return entries.map((entry) => {
    const file = entry?.snapshotPath;
    if (typeof file !== 'string' || !path.isAbsolute(file) || !existsSync(file) ||
        !inside(corpusRoot, realpathSync(file)) || !/^[0-9a-f]{64}$/.test(entry.snapshotSha256)) {
      throw safe('Frozen corpus source entry is invalid');
    }
    return { file, expectedSha256: entry.snapshotSha256 };
  });
}

function verifyFrozenSources(entries) {
  for (const entry of entries) {
    if (sha256(readFileSync(entry.file)) !== entry.expectedSha256) {
      throw safe('Frozen corpus source changed');
    }
  }
}

function validate(config) {
  if (!plainObject(config) || config.format !== format || !plainObject(config.corpus) ||
      !plainObject(config.sides) || !plainObject(config.sides.v2) || !plainObject(config.sides.v3)) throw safe('Invalid differential plan format');
  const corpusRoot = config.corpus.root;
  const manifest = config.corpus.manifest;
  if (typeof corpusRoot !== 'string' || !path.isAbsolute(corpusRoot) || !existsSync(corpusRoot) ||
      typeof manifest !== 'string' || !path.isAbsolute(manifest) || !existsSync(manifest) ||
      !/^[0-9a-f]{64}$/.test(config.corpus.manifestSha256)) throw safe('Corpus needs an existing root and SHA-256 manifest');
  if (!inside(realpathSync(tmp), realpathSync(corpusRoot)) || !inside(realpathSync(tmp), realpathSync(manifest))) {
    throw safe('Frozen corpus root and manifest must be under tmp/');
  }
  const physicalCorpus = realpathSync(corpusRoot);
  if (sha256(readFileSync(manifest)) !== config.corpus.manifestSha256) throw safe('Corpus manifest SHA-256 mismatch');
  const sourceFiles = frozenSources(manifest, physicalCorpus);
  verifyFrozenSources(sourceFiles);
  const plan = privatePath(config.capturePlan, true);
  const cases = JSON.parse(readFileSync(plan, 'utf8')).cases;
  if (!Array.isArray(cases)) throw safe('Invalid capture plan');
  const needsMcp = cases.some((item) => typeof item.kind === 'string' && item.kind.startsWith('mcp-'));
  const statePaths = [];
  for (const sideName of ['v2', 'v3']) {
    const side = config.sides[sideName];
    if (!Number.isInteger(side.port) || side.port < 1 || side.port > 65535 || side.port === 3456 ||
        !commandSpec(side.web) || (needsMcp && !commandSpec(side.mcp))) throw safe(`Invalid ${sideName} process or port configuration`);
    if (side.mcp && !commandSpec(side.mcp)) throw safe(`Invalid ${sideName} MCP command`);
    if (!plainObject(side.state) || !['metaDir', 'indexDir', 'cacheDir'].every((key) => typeof side.state[key] === 'string')) throw safe(`Invalid ${sideName} state paths`);
    for (const key of ['metaDir', 'indexDir', 'cacheDir']) statePaths.push(side.state[key]);
    for (const spec of [side.web, ...(needsMcp ? [side.mcp] : [])]) {
      const serialized = JSON.stringify([spec.command, spec.args, spec.env]);
      for (const token of ['${CORPUS_ROOT}', '${META_DIR}', '${INDEX_DIR}', '${CACHE_DIR}']) {
        if (!serialized.includes(token)) throw safe(`${sideName} command must reference shared corpus and isolated state placeholders`);
      }
    }
    if (!JSON.stringify([side.web.command, side.web.args, side.web.env]).includes('${PORT}')) throw safe(`${sideName} Web command must reference its port placeholder`);
  }
  if (config.sides.v2.port === config.sides.v3.port) throw safe('2.0 and 3.0 ports must differ');
  if (statePaths.some((dir) => typeof dir !== 'string' || !path.isAbsolute(dir) || !inside(tmp, dir))) {
    throw safe('State directories must be absolute and under tmp/');
  }
  if (statePaths.some((dir) => dir === physicalCorpus || inside(dir, physicalCorpus) || inside(physicalCorpus, dir))) {
    throw safe('State directories must be outside the frozen corpus root');
  }
  const state = statePaths.map((dir) => privateDirectory(dir, physicalCorpus));
  if (new Set(state).size !== state.length || state.some((dir, index) => state.some((other, otherIndex) => index !== otherIndex && (inside(dir, other) || inside(other, dir))))) {
    throw safe('State directories must be separate');
  }
  if (state.some((dir) => dir === physicalCorpus || inside(dir, physicalCorpus) || inside(physicalCorpus, dir))) {
    throw safe('State directories must be outside the frozen corpus root');
  }
  if (typeof config.volatilePolicy !== 'string' || !path.isAbsolute(config.volatilePolicy) || !existsSync(config.volatilePolicy)) throw safe('An explicit volatile policy is required');
  if (config.mcpEra !== undefined && !['legacy', 'modern'].includes(config.mcpEra)) throw safe('MCP era must be legacy or modern');
  return { ...config, needsMcp, sourceFiles };
}

function expand(value, side, corpusRoot) {
  const values = {
    '${CORPUS_ROOT}': corpusRoot, '${PORT}': String(side.port),
    '${META_DIR}': side.state.metaDir, '${INDEX_DIR}': side.state.indexDir, '${CACHE_DIR}': side.state.cacheDir,
  };
  return value.replace(/\$\{(?:CORPUS_ROOT|PORT|META_DIR|INDEX_DIR|CACHE_DIR)\}/g, (token) => values[token]);
}

function materialize(spec, side, corpusRoot) {
  return {
    command: expand(spec.command, side, corpusRoot),
    args: spec.args.map((arg) => expand(arg, side, corpusRoot)),
    cwd: spec.cwd,
    env: Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, expand(value, side, corpusRoot)])),
  };
}

async function portOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function run(command, args, options, logPath) {
  return new Promise((resolve, reject) => {
    const log = openSync(logPath, 'wx', 0o600);
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['ignore', log, log] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, processLimitMs);
    child.once('error', (error) => { clearTimeout(timer); closeSync(log); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (child.pid) closeSync(log);
      if (timedOut) reject(safe('Capture or comparison process exceeded 30 minutes'));
      else resolve(code);
    });
  });
}

async function ready(port, child, launchFailed) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (launchFailed() || child.exitCode !== null) throw safe('Web process exited before readiness');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/providers`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch { /* Startup may still be indexing. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw safe('Web process did not become ready within 120 seconds');
}

async function capture(sideName, config, reportDir) {
  const side = config.sides[sideName];
  if (await portOpen(side.port)) throw safe(`${sideName} port is already occupied`);
  const web = materialize(side.web, side, config.corpus.root);
  const webLog = openSync(path.join(reportDir, `${sideName}-web.private.log`), 'wx', 0o600);
  const child = spawn(web.command, web.args, { cwd: web.cwd, env: { ...process.env, ...web.env }, windowsHide: true, stdio: ['ignore', webLog, webLog] });
  let launchFailed = false;
  child.once('error', () => { launchFailed = true; });
  try {
    await ready(side.port, child, () => launchFailed);
    const snapshot = path.join(reportDir, `${sideName}-snapshot.private.json`);
    const args = [captureScript, '--plan', config.capturePlan, '--output', snapshot, '--base-url', `http://127.0.0.1:${side.port}`];
    let env = { ...process.env, ...web.env };
    if (config.needsMcp) {
      const mcp = materialize(side.mcp, side, config.corpus.root);
      args.push('--mcp-command', mcp.command, '--mcp-cwd', mcp.cwd,
        ...mcp.args.flatMap((arg) => ['--mcp-arg', arg]));
      env = { ...env, ...mcp.env };
    }
    if (config.mcpEra) args.push('--mcp-era', config.mcpEra);
    const code = await run(process.execPath, args, { cwd: root, env }, path.join(reportDir, `${sideName}-capture.private.log`));
    if (code !== 0) throw safe(`${sideName} capture failed; inspect private log`);
    return { sha256: sha256(readFileSync(snapshot)), bytes: lstatSync(snapshot).size, snapshot };
  } finally {
    if (child.pid && child.exitCode === null) child.kill('SIGKILL');
    await new Promise((resolve) => { if (!child.pid || child.exitCode !== null) resolve(); else child.once('close', resolve); });
    closeSync(webLog);
  }
}

async function main() {
  let reportPath;
  let report;
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--report') throw safe('Usage: node scripts/v3-run-differential.mjs --config <private-plan> --report <ignored-tmp-report>');
    const configPath = privatePath(args[1], true);
    reportPath = privatePath(args[3]);
    const config = validate(JSON.parse(readFileSync(configPath, 'utf8')));
    const reportDir = path.dirname(reportPath);
    const v2 = await capture('v2', config, reportDir);
    verifyFrozenSources(config.sourceFiles);
    const v3 = await capture('v3', config, reportDir);
    verifyFrozenSources(config.sourceFiles);
    const comparisonPath = path.join(reportDir, 'comparison.private.txt');
    const code = await run(process.execPath, [compareScript, '--expected', v2.snapshot, '--actual', v3.snapshot,
      '--volatile-policy', config.volatilePolicy, '--output', comparisonPath], { cwd: root, env: process.env }, path.join(reportDir, 'compare.private.log'));
    const comparison = readFileSync(comparisonPath, 'utf8');
    report = {
      format: 'agentsession-v3-differential-result/v1', status: code === 0 ? 'match' : code === 1 ? 'different' : 'error',
      corpusManifestSha256: config.corpus.manifestSha256, capturePlanSha256: sha256(readFileSync(config.capturePlan)),
      frozenSourceFileCount: config.sourceFiles.length,
      configSha256: sha256(readFileSync(configPath)),
      volatilePolicySha256: sha256(readFileSync(config.volatilePolicy)),
      snapshots: { v2: { sha256: v2.sha256, bytes: v2.bytes }, v3: { sha256: v3.sha256, bytes: v3.bytes } },
      comparison: { exitCode: code, sha256: sha256(comparison), differenceCount: Number(comparison.match(/^Snapshots differ \((\d+) differences/)?.[1] ?? 0),
        ignoredDifferenceCount: Number(comparison.match(/(\d+) ignored differences/)?.[1] ?? 0) },
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`Differential ${report.status}; ${report.comparison.differenceCount} differences.\n`);
    process.exitCode = code;
  } catch (error) {
    const detail = error?.publicSafe ? error.message : error instanceof SyntaxError ? 'Invalid private JSON' : error?.name ?? 'unknown error';
    if (reportPath && !existsSync(reportPath)) {
      report = { format: 'agentsession-v3-differential-result/v1', status: 'error', reason: detail };
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
    process.stderr.write(`Differential failed: ${detail}\n`);
    process.exitCode = 2;
  }
}

await main();
