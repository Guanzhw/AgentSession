#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const MAX_REPEATS = 5;
const MAX_CODEX_REPEATS = 2;
const MAX_CODEX_PAGES = 10;
const DEFAULT_TIMEOUT_MS = 120_000;

function help() {
  console.log(`Usage: node scripts/bench-session-search.mjs [options]

Runs the compiled AgentSession MCP server over stdio. The default run measures
startup/index refresh and title-only search across registered providers. A full
Codex user/assistant search runs only when --codex-query is supplied.

Options:
  --repo-root <path>       Source checkout to identify (default: cwd)
  --cli <path>             Compiled MCP CLI (default: <repo-root>/packages/agentsession-mcp/dist/cli.js)
  --codex-dir <path>       Frozen Codex data directory passed to the MCP CLI
  --meta-path <path>       Reuse an AgentSession metadata DB under the checkout's ignored tmp/
  --output <path>          JSON output path (default: <repo-root>/tmp/bench-session-search/<run-id>/result.json)
  --title-query <query>    Metadata-only title query (default: session)
  --codex-query <query>    Opt into a full Codex user/assistant scan (requires --codex-dir)
  --codex-repeats <count>  Additional same-process full Codex scans (0-${MAX_CODEX_REPEATS}; default: 0)
  --codex-pages <count>    Traverse up to this many Codex result pages (1-${MAX_CODEX_PAGES}; default: 1)
  --title-repeats <count>  Same-process title-search repeats after the first (0-${MAX_REPEATS}; default: 2)
  --limit <count>          Result page size (1-100; default: 20)
  --updated-before <time>   Fixed result snapshot boundary (ISO-8601 or Unix ms)
  --timeout-ms <count>     Per tool-call timeout (1000-${DEFAULT_TIMEOUT_MS}; default: ${DEFAULT_TIMEOUT_MS})
  --file-cache-state <x>   Record unknown, likely-warm, or likely-cold (default: unknown)
  -h, --help               Show this help

The tool's result limit bounds returned rows, not the provider scan. Codex
message search is opt-in and requires --codex-dir. Each requested page is a
separate search call; extra full scans require --codex-repeats.`);
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    cliPath: undefined,
    codexDir: undefined,
    metaPath: undefined,
    outputPath: undefined,
    titleQuery: "session",
    codexQuery: undefined,
    codexRepeats: 0,
    codexPages: 1,
    titleRepeats: 2,
    limit: 20,
    updatedBefore: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    fileCacheState: "unknown"
  };
  const values = new Map([
    ["--repo-root", "repoRoot"], ["--cli", "cliPath"], ["--codex-dir", "codexDir"],
    ["--meta-path", "metaPath"], ["--output", "outputPath"],
    ["--title-query", "titleQuery"], ["--codex-query", "codexQuery"],
    ["--codex-repeats", "codexRepeats"], ["--codex-pages", "codexPages"],
    ["--title-repeats", "titleRepeats"], ["--limit", "limit"],
    ["--updated-before", "updatedBefore"], ["--timeout-ms", "timeoutMs"], ["--file-cache-state", "fileCacheState"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    const key = values.get(flag);
    if (!key || argv[index + 1] === undefined || argv[index + 1].startsWith("--")) {
      throw new Error(`Invalid or incomplete option: ${flag}`);
    }
    options[key] = argv[++index];
  }

  options.repoRoot = path.resolve(options.repoRoot);
  options.cliPath = path.resolve(options.repoRoot, options.cliPath || "packages/agentsession-mcp/dist/cli.js");
  if (options.codexDir !== undefined) {
    options.codexDir = path.resolve(options.codexDir);
    if (!existsSync(path.join(options.codexDir, "sessions"))) throw new Error("--codex-dir must contain a sessions directory.");
  }
  if (options.metaPath !== undefined) options.metaPath = path.resolve(options.metaPath);
  options.titleQuery = String(options.titleQuery).trim();
  if (!options.titleQuery) throw new Error("--title-query must not be empty.");
  if (options.codexQuery !== undefined) {
    options.codexQuery = String(options.codexQuery).trim();
    if (!options.codexQuery) throw new Error("--codex-query must not be empty.");
    if (options.codexDir === undefined) throw new Error("--codex-query requires an explicit frozen --codex-dir.");
  }
  for (const key of ["titleRepeats", "codexRepeats", "codexPages", "limit", "timeoutMs"]) {
    options[key] = Number(options[key]);
    if (!Number.isInteger(options[key])) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be an integer.`);
  }
  if (options.titleRepeats < 0 || options.titleRepeats > MAX_REPEATS) throw new Error(`--title-repeats must be between 0 and ${MAX_REPEATS}.`);
  if (options.codexRepeats < 0 || options.codexRepeats > MAX_CODEX_REPEATS) throw new Error(`--codex-repeats must be between 0 and ${MAX_CODEX_REPEATS}.`);
  if (options.codexPages < 1 || options.codexPages > MAX_CODEX_PAGES) throw new Error(`--codex-pages must be between 1 and ${MAX_CODEX_PAGES}.`);
  if (options.codexRepeats > 0 && options.codexQuery === undefined) throw new Error("--codex-repeats requires --codex-query.");
  if (options.codexPages > 1 && options.codexQuery === undefined) throw new Error("--codex-pages requires --codex-query.");
  if (options.limit < 1 || options.limit > 100) throw new Error("--limit must be between 1 and 100.");
  if (options.timeoutMs < 1000 || options.timeoutMs > DEFAULT_TIMEOUT_MS) throw new Error(`--timeout-ms must be between 1000 and ${DEFAULT_TIMEOUT_MS}.`);
  if (!["unknown", "likely-warm", "likely-cold"].includes(options.fileCacheState)) throw new Error("--file-cache-state must be unknown, likely-warm, or likely-cold.");
  if (options.updatedBefore !== undefined) {
    const numeric = Number(options.updatedBefore);
    const parsedTime = Number.isFinite(numeric) ? numeric : Date.parse(options.updatedBefore);
    if (!Number.isFinite(parsedTime)) throw new Error("--updated-before must be an ISO-8601 date or Unix milliseconds.");
    options.updatedBefore = parsedTime;
  }
  return options;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...options }).trim();
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isWithinDirectory(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function assertPhysicalTmpRoot(repoRoot, tmpRoot) {
  const repository = realpathSync(repoRoot);
  const rootStat = lstatSync(tmpRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("The checkout's tmp directory must be a real directory, not a symlink or junction.");
  }
  const physicalRoot = realpathSync(tmpRoot);
  if (!isWithinDirectory(repository, physicalRoot)) {
    throw new Error("The checkout's tmp directory resolves outside the selected checkout.");
  }
  return physicalRoot;
}

function assertSafeTmpPath(tmpRoot, physicalTmpRoot, targetPath, { databaseFile = false } = {}) {
  const absoluteTarget = path.resolve(targetPath);
  if (!isWithinDirectory(tmpRoot, absoluteTarget)) {
    throw new Error("Benchmark metadata and config paths must remain under the checkout's tmp directory.");
  }
  let current = tmpRoot;
  const relative = path.relative(tmpRoot, absoluteTarget);
  const components = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    current = path.join(current, component);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error("Benchmark metadata and config paths cannot contain symlinks or junctions.");
    }
    const physicalPath = realpathSync(current);
    if (!isWithinDirectory(physicalTmpRoot, physicalPath)) {
      throw new Error("Benchmark metadata and config paths must resolve under the checkout's physical tmp directory.");
    }
    if (databaseFile && index === components.length - 1) {
      if (!info.isFile()) throw new Error("Benchmark database and output targets must be regular files.");
      if (info.nlink > 1) throw new Error("Benchmark database and output targets cannot be hard-linked files.");
    }
  }
}

function pathsEqual(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function queryRecord(label, query) {
  return { label, sha256: digest(query), characterCount: query.length };
}

function errorKind(error) {
  if (error?.code === "BENCH_TIMEOUT") return "timeout";
  const name = typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name : "Error";
  return name;
}

function resultErrorKind(result) {
  if (!result?.isError) return null;
  const text = result.content?.find((item) => item.type === "text")?.text || "";
  return /^([a-z][a-z0-9_]*):/i.exec(text)?.[1] || "tool_error";
}

function normalizedDiagnostics(result) {
  const diagnostics = result?.structuredContent?.result?.diagnostics;
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.filter((item) => item && typeof item === "object").map((item) => ({
    provider: item.provider,
    status: item.status,
    ...(Number.isFinite(item.durationMs) ? { durationMs: item.durationMs } : {})
  }));
}

function summarizeSearch(result) {
  const search = result?.structuredContent?.result;
  if (!validSearchResult(result)) {
    return {
      resultCount: null,
      resultKeySha256: null,
      resultFingerprintSha256: null,
      resultMatchKeySha256: null,
      hasNextCursor: false,
      truncated: false
    };
  }
  const sessionKeys = search.matches
    .map((match) => `${match?.session?.provider || ""}\0${match?.session?.sessionId || ""}`)
    .sort();
  const matchKeys = search.matches.map((match) => ({
    provider: match?.session?.provider || null,
    sessionId: match?.session?.sessionId || null,
    event: match?.event ? {
      messageId: match.event.messageId || null,
      segment: match.event.segment || null
    } : null,
    matchField: match?.matchField || null,
    matchRole: match?.matchRole || null
  }));
  const sortedMatchKeys = [...matchKeys].sort((left, right) => compareCodeUnits(JSON.stringify(left), JSON.stringify(right)));
  return {
    resultCount: search.matches.length,
    resultKeySha256: digest(sessionKeys.join("\n")),
    resultFingerprintSha256: digest(JSON.stringify(matchKeys)),
    resultMatchKeySha256: digest(JSON.stringify(sortedMatchKeys)),
    hasNextCursor: typeof search.nextCursor === "string" && search.nextCursor.length > 0,
    truncated: search.truncated === true
  };
}

function artifactFingerprint(root, relativePath) {
  const directory = path.join(root, relativePath);
  const entries = [];
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => compareCodeUnits(left.name, right.name))) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) entries.push(fullPath);
    }
  }
  if (!existsSync(directory)) return { path: relativePath.replaceAll("\\", "/"), present: false };
  walk(directory);
  const hash = createHash("sha256");
  let byteCount = 0;
  for (const filePath of entries) {
    const relativeFile = path.relative(root, filePath).replaceAll("\\", "/");
    const contents = readFileSync(filePath);
    hash.update(relativeFile).update("\0").update(contents).update("\0");
    byteCount += contents.length;
  }
  return { path: relativePath.replaceAll("\\", "/"), sha256: hash.digest("hex"), fileCount: entries.length, byteCount };
}

function sourceIdentity(root) {
  const revision = run("git", ["-C", root, "rev-parse", "HEAD"]);
  const branch = run("git", ["-C", root, "branch", "--show-current"]);
  const status = run("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"]);
  return {
    revision,
    branch,
    trackedWorkingTreeClean: status.length === 0,
    buildArtifacts: [
      artifactFingerprint(root, "packages/agentsession/dist"),
      artifactFingerprint(root, "packages/agentsession-mcp/dist")
    ]
  };
}

function safeEnvironment(metaPath, configPath) {
  const environment = {
    ...getDefaultEnvironment(),
    AGENTSESSION_META_PATH: metaPath,
    AGENTSESSION_CONFIG: configPath
  };
  for (const name of [
    "AGENTSESSION_DB_PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR", "DSH_HOME",
    "XDG_DATA_HOME", "XDG_CONFIG_HOME", "LOCALAPPDATA", "APPDATA"
  ]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

function validSearchResult(result) {
  const search = result?.structuredContent?.result;
  return Boolean(search && typeof search === "object"
    && Array.isArray(search.matches)
    && search.matches.every((match) => match && typeof match === "object"
      && typeof match.session?.provider === "string"
      && typeof match.session?.sessionId === "string")
    && Array.isArray(search.diagnostics)
    && search.diagnostics.every((item) => item && typeof item.provider === "string"
      && ["ok", "unavailable", "error"].includes(item.status))
    && (search.nextCursor === null || (typeof search.nextCursor === "string" && search.nextCursor.length > 0))
    && typeof search.truncated === "boolean"
    && search.truncated === (search.nextCursor !== null));
}

async function serverRssBytes(pid) {
  if (!pid) return null;
  try {
    if (process.platform === "win32") {
      const value = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${Number(pid)}).WorkingSet64`]);
      const bytes = Number(value);
      return Number.isFinite(bytes) ? bytes : null;
    }
    const value = run("ps", ["-o", "rss=", "-p", String(Number(pid))]);
    const kibibytes = Number(value);
    return Number.isFinite(kibibytes) ? kibibytes * 1024 : null;
  } catch {
    return null;
  }
}

async function serverPeakRssBytes(pid) {
  if (!pid) return null;
  try {
    if (process.platform === "win32") {
      const value = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${Number(pid)}).PeakWorkingSet64`]);
      const bytes = Number(value);
      return Number.isFinite(bytes) ? bytes : null;
    }
    if (process.platform === "linux") {
      const match = /^VmHWM:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${Number(pid)}/status`, "utf8"));
      return match ? Number(match[1]) * 1024 : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function serverCpuMs(pid) {
  if (!pid || process.platform !== "win32") return null;
  try {
    const value = run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${Number(pid)}).TotalProcessorTime.TotalMilliseconds`
    ]);
    const milliseconds = Number(value);
    return Number.isFinite(milliseconds) ? milliseconds : null;
  } catch {
    return null;
  }
}

function fileBytes(filePath) {
  try {
    return statSync(filePath).size;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function databaseFootprint(metaPath, repoRoot) {
  const files = [
    { kind: "main", path: metaPath },
    { kind: "wal", path: `${metaPath}-wal` },
    { kind: "shm", path: `${metaPath}-shm` },
    { kind: "search", path: `${metaPath}.search.db` },
    { kind: "search-wal", path: `${metaPath}.search.db-wal` },
    { kind: "search-shm", path: `${metaPath}.search.db-shm` }
  ].map(({ kind, path: filePath }) => ({
    kind,
    pathRelativeToRepo: path.relative(repoRoot, filePath).replaceAll("\\", "/"),
    bytes: fileBytes(filePath)
  }));
  return {
    measuredAfterServerProcessExit: true,
    files,
    totalBytes: files.reduce((sum, file) => sum + (file.bytes || 0), 0)
  };
}

function codexCorpusFingerprint(codexDir) {
  if (!codexDir) return null;
  const root = path.join(codexDir, "sessions");
  const hash = createHash("sha256");
  let fileCount = 0;
  let totalBytes = 0;
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareCodeUnits(a.name, b.name))) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && /\.jsonl(?:\.zst)?$/i.test(entry.name)) {
        const relative = path.relative(root, fullPath).replaceAll("\\", "/");
        const stat = statSync(fullPath);
        hash.update(JSON.stringify([relative, stat.size, stat.mtimeMs]));
        fileCount += 1;
        totalBytes += stat.size;
      }
    }
  }
  visit(root);
  return { fileCount, totalBytes, statManifestSha256: hash.digest("hex"), directoryPathSha256: digest(codexDir) };
}

function withTimeout(promise, timeoutMs) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "BENCH_TIMEOUT" })), timeoutMs);
      timeout.unref?.();
    })
  ]).finally(() => clearTimeout(timeout));
}

function providerMachine() {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    architecture: process.arch,
    operatingSystem: os.type(),
    release: os.release(),
    cpuModel: cpus[0]?.model || null,
    logicalCpuCount: cpus.length,
    totalMemoryBytes: os.totalmem()
  };
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.help) {
  help();
  process.exit(0);
}

if (!existsSync(parsed.cliPath)) throw new Error(`Compiled MCP CLI not found: ${parsed.cliPath}`);
const cliStat = statSync(parsed.cliPath);
const cliSha256 = digest(readFileSync(parsed.cliPath));
const source = sourceIdentity(parsed.repoRoot);
const startedAt = new Date();
const runId = `${startedAt.toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${process.pid}`;
const snapshotUpdatedBefore = parsed.updatedBefore ?? startedAt.getTime();
const tmpRoot = path.join(parsed.repoRoot, "tmp");
const tempDir = path.join(parsed.repoRoot, "tmp", "bench-session-search", runId);
const outputPath = path.resolve(parsed.outputPath || path.join(tempDir, "result.json"));
const relativeTempDir = path.relative(parsed.repoRoot, tempDir).replaceAll("\\", "/");
run("git", ["-C", parsed.repoRoot, "check-ignore", "--quiet", "--no-index", "--", relativeTempDir]);

// Protect the user's AgentSession metadata by requiring benchmark state under ignored tmp/.
try {
  lstatSync(tmpRoot);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  mkdirSync(tmpRoot);
}
const physicalTmpRoot = assertPhysicalTmpRoot(parsed.repoRoot, tmpRoot);
assertSafeTmpPath(tmpRoot, physicalTmpRoot, tempDir);
mkdirSync(tempDir, { recursive: true });
assertSafeTmpPath(tmpRoot, physicalTmpRoot, tempDir);
const metaPath = parsed.metaPath || path.join(tempDir, "state", "agentsession-meta.db");
const relativeMetaPath = path.relative(parsed.repoRoot, metaPath).replaceAll("\\", "/");
if (!isWithinDirectory(tmpRoot, metaPath) || pathsEqual(tmpRoot, metaPath)) {
  throw new Error("--meta-path must remain under the selected checkout's ignored tmp/ directory.");
}
run("git", ["-C", parsed.repoRoot, "check-ignore", "--quiet", "--no-index", "--", relativeMetaPath]);
const configPath = path.join(tempDir, "config.json");
const metaDbFiles = [
  metaPath,
  `${metaPath}-wal`,
  `${metaPath}-shm`,
  `${metaPath}.search.db`,
  `${metaPath}.search.db-wal`,
  `${metaPath}.search.db-shm`
];
if (metaDbFiles.some((filePath) => pathsEqual(filePath, configPath))) {
  throw new Error("--meta-path must be separate from the benchmark config file.");
}
for (const databasePath of metaDbFiles) assertSafeTmpPath(tmpRoot, physicalTmpRoot, databasePath, { databaseFile: true });
assertSafeTmpPath(tmpRoot, physicalTmpRoot, configPath);
if (isWithinDirectory(tmpRoot, outputPath)) {
  assertSafeTmpPath(tmpRoot, physicalTmpRoot, outputPath, { databaseFile: true });
}
if ([...metaDbFiles, configPath].some((filePath) => pathsEqual(filePath, outputPath))) {
  throw new Error("--output must be separate from benchmark config and metadata database files.");
}
const metaDbExistedAtStart = existsSync(metaPath);
mkdirSync(path.dirname(metaPath), { recursive: true });
for (const databasePath of metaDbFiles) assertSafeTmpPath(tmpRoot, physicalTmpRoot, databasePath, { databaseFile: true });
assertSafeTmpPath(tmpRoot, physicalTmpRoot, configPath);
writeFileSync(configPath, JSON.stringify({ mcp: { searchLimit: parsed.limit } }, null, 2));

const runResult = {
  schemaVersion: 1,
  runId,
  startedAtUtc: startedAt.toISOString(),
  completedAtUtc: null,
  status: "failed",
  source: {
    ...source,
    cliArtifact: {
      sha256: cliSha256,
      byteCount: cliStat.size,
      modifiedAtUtc: cliStat.mtime.toISOString()
    }
  },
  runtime: {
    nodeVersion: process.version,
    serverCpuMetric: process.platform === "win32" ? "Windows Process.TotalProcessorTime milliseconds" : null,
    machine: providerMachine()
  },
  cacheCaveats: {
    process: "Each run starts one new MCP process; startup includes the server's initial provider index refresh.",
    operatingSystem: "Filesystem cache is not controlled or flushed; the recorded state is an operator estimate.",
    recordedFilesystemCacheState: parsed.fileCacheState,
    corpusStatPreflight: "The before-run stat manifest walks session directories and stats transcript files, which may warm filesystem metadata caches before timed startup.",
    filesystemCacheStateNote: parsed.fileCacheState === "likely-warm"
      ? "A prior run read the same provider corpus before this measurement; the OS cache was not flushed."
      : null,
    providerData: "The initial index refresh can populate provider-owned in-process session caches before measured searches.",
    repeatedSearch: "Title repeats run in the same MCP process and reuse its provider and operating-system caches."
  },
  isolation: {
    providerDataMode: "read-only",
    metaPathRelativeToRepo: path.relative(parsed.repoRoot, metaPath).replaceAll("\\", "/"),
    metaDbExistedAtStart,
    tempStateUnderIgnoredTmp: true,
    configPathRelativeToRepo: path.relative(parsed.repoRoot, configPath).replaceAll("\\", "/")
  },
  parameters: {
    codexCorpus: codexCorpusFingerprint(parsed.codexDir),
    codexCorpusAfterServerExit: null,
    codexCorpusStatManifestUnchanged: null,
    titleQuery: queryRecord("metadata-title", parsed.titleQuery),
    codexQuery: parsed.codexQuery === undefined ? null : queryRecord("codex-user-assistant", parsed.codexQuery),
    titleRepeats: parsed.titleRepeats,
    codexRepeats: parsed.codexRepeats,
    codexPages: parsed.codexPages,
    resultLimit: parsed.limit,
    toolCallTimeoutMs: parsed.timeoutMs,
    snapshotUpdatedBeforeUnixMs: snapshotUpdatedBefore,
    snapshotUpdatedBeforeSource: parsed.updatedBefore === undefined ? "run-start" : "argument",
    codexSearchCallsPlanned: parsed.codexQuery === undefined ? 0 : parsed.codexPages + parsed.codexRepeats,
    codexSearchCallsAttempted: 0,
    metadataTitleSearchCallsAttempted: 0
  },
  toolList: null,
  phases: {
    coldProcessAndIndexRefresh: null,
    metadataTitleSearch: null,
    sameProcessTitleRepeats: [],
    codexUserAssistantSearch: null,
    codexAdditionalPages: [],
    codexPageSequence: null,
    sameProcessCodexRepeats: []
  },
  providerDiagnostics: [],
  providerDiagnosticStatusCounts: null,
  metadataDbAfterServerExit: null,
  serverCpuMsBeforeExit: null,
  errors: [],
  stderr: { byteCount: 0 }
};

let transport;
let client;
let processPid = null;
let timedOut = false;
let stderrByteCount = 0;
let codexSearchCallsAttempted = 0;
let metadataTitleSearchCallsAttempted = 0;

async function stopClient() {
  if (client) {
    await client.close().catch(() => {});
    client = null;
  } else if (transport) {
    await transport.close().catch(() => {});
  }
}

async function runSearch(label, query, fields, providers, saveAs, cursor = undefined) {
  if (providers?.includes("codex")) codexSearchCallsAttempted += 1;
  else if (fields.length === 1 && fields[0] === "title") metadataTitleSearchCallsAttempted += 1;
  const rssBeforeBytes = await serverRssBytes(processPid);
  const cpuBeforeMs = await serverCpuMs(processPid);
  const started = performance.now();
  try {
    const result = await withTimeout(client.callTool({
      name: "session_search",
      arguments: {
        query,
        fields,
        ...(providers ? { providers } : {}),
        ...(cursor ? { cursor } : {}),
        limit: parsed.limit,
        updatedBefore: snapshotUpdatedBefore
      }
    }), parsed.timeoutMs);
    const wallMs = performance.now() - started;
    const rssAfterBytes = await serverRssBytes(processPid);
    const cpuAfterMs = await serverCpuMs(processPid);
    const resultShapeValid = validSearchResult(result);
    const error = resultErrorKind(result) || (resultShapeValid ? null : "invalid_result_shape");
    const diagnostics = normalizedDiagnostics(result);
    const providerDiagnosticsComplete = (providers || []).every((provider) => diagnostics.some((item) => item.provider === provider && item.status === "ok"));
    const searchComplete = resultShapeValid && !error
      && !diagnostics.some((item) => item.status === "error")
      && providerDiagnosticsComplete;
    const phase = {
      label,
      wallMs,
      serverRssBeforeBytes: rssBeforeBytes,
      serverRssAfterBytes: rssAfterBytes,
      serverPeakRssAfterBytes: await serverPeakRssBytes(processPid),
      serverCpuBeforeMs: cpuBeforeMs,
      serverCpuAfterMs: cpuAfterMs,
      serverCpuDeltaMs: cpuBeforeMs === null || cpuAfterMs === null ? null : cpuAfterMs - cpuBeforeMs,
      diagnostics,
      providerDiagnosticCount: diagnostics.length,
      resultShapeValid,
      searchComplete,
      providerStatusCounts: diagnostics.reduce((counts, item) => {
        counts[item.status] = (counts[item.status] || 0) + 1;
        return counts;
      }, {}),
      ...summarizeSearch(result),
      ...(error ? { errorKind: error } : {})
    };
    if (error) runResult.errors.push({ phase: label, kind: error });
    for (const item of diagnostics.filter((entry) => entry.status === "error")) {
      runResult.errors.push({ phase: label, kind: "provider_index_or_search_error", provider: item.provider, status: item.status });
    }
    if (!error) {
      for (const provider of providers || []) {
        const diagnostic = diagnostics.find((item) => item.provider === provider);
        if (diagnostic?.status !== "ok" && diagnostic?.status !== "error") {
          runResult.errors.push({
            phase: label,
            kind: diagnostic?.status === "unavailable" ? "provider_unavailable" : "provider_diagnostic_missing",
            provider
          });
        }
      }
    }
    if (saveAs) runResult.phases[saveAs] = phase;
    Object.defineProperty(phase, "continuationCursor", {
      value: searchComplete ? result.structuredContent.result.nextCursor : null,
      enumerable: false
    });
    return phase;
  } catch (error) {
    const wallMs = performance.now() - started;
    const phase = {
      label,
      wallMs,
      serverRssBeforeBytes: rssBeforeBytes,
      serverRssAfterBytes: await serverRssBytes(processPid),
      serverPeakRssAfterBytes: await serverPeakRssBytes(processPid),
      serverCpuBeforeMs: cpuBeforeMs,
      serverCpuAfterMs: await serverCpuMs(processPid),
      resultCount: null,
      resultKeySha256: null,
      resultFingerprintSha256: null,
      resultMatchKeySha256: null,
      hasNextCursor: false,
      truncated: false,
      resultShapeValid: false,
      searchComplete: false,
      errorKind: errorKind(error)
    };
    runResult.errors.push({ phase: label, kind: phase.errorKind });
    if (saveAs) runResult.phases[saveAs] = phase;
    if (phase.errorKind === "timeout") {
      timedOut = true;
      await stopClient();
    }
    Object.defineProperty(phase, "continuationCursor", { value: null, enumerable: false });
    return phase;
  }
}

try {
  const environment = safeEnvironment(metaPath, configPath);
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [parsed.cliPath, ...(parsed.codexDir ? ["--codex-dir", parsed.codexDir] : [])],
    env: environment,
    cwd: parsed.repoRoot,
    stderr: "pipe"
  });
  transport.stderr?.on("data", (chunk) => { stderrByteCount += chunk.length; });
  // Legacy initialize starts the actual server once; modern stdio discovery
  // launches a disposable sibling that would refresh the index a second time.
  client = new Client({ name: "agentsession-search-benchmark", version: "1.0.0" });

  const startupStarted = performance.now();
  await withTimeout(client.connect(transport), parsed.timeoutMs);
  processPid = transport.pid;
  runResult.phases.coldProcessAndIndexRefresh = {
    wallMs: performance.now() - startupStarted,
    serverPid: processPid,
    serverRssAfterReadyBytes: await serverRssBytes(processPid),
    serverPeakRssAfterReadyBytes: await serverPeakRssBytes(processPid),
    serverCpuAtReadyMs: await serverCpuMs(processPid),
    protocolEra: client.getProtocolEra(),
    protocolVersion: client.getNegotiatedProtocolVersion(),
    timingIncludes: ["process launch", "configuration initialization", "initial provider index refresh", "MCP initialization"]
  };

  const toolStarted = performance.now();
  const tools = await withTimeout(client.listTools(), parsed.timeoutMs);
  runResult.toolList = {
    wallMs: performance.now() - toolStarted,
    available: true,
    count: tools.tools.length,
    names: tools.tools.map((tool) => tool.name).sort()
  };

  const titleSearch = await runSearch("metadata-title", parsed.titleQuery, ["title"], undefined, "metadataTitleSearch");
  runResult.providerDiagnostics = titleSearch.diagnostics || [];
  runResult.providerDiagnosticStatusCounts = runResult.providerDiagnostics.reduce((counts, item) => {
    counts[item.status] = (counts[item.status] || 0) + 1;
    return counts;
  }, {});
  for (let index = 0; index < parsed.titleRepeats && !timedOut; index += 1) {
    const repeat = await runSearch(`metadata-title-repeat-${index + 1}`, parsed.titleQuery, ["title"], undefined);
    runResult.phases.sameProcessTitleRepeats.push(repeat);
  }

  if (parsed.codexQuery !== undefined && !timedOut) {
    const pages = [await runSearch("codex-user-assistant", parsed.codexQuery,
      ["user", "assistant"], ["codex"], "codexUserAssistantSearch")];
    for (let page = 2; page <= parsed.codexPages && pages.at(-1).searchComplete && pages.at(-1).continuationCursor && !timedOut; page += 1) {
      const next = await runSearch(`codex-user-assistant-page-${page}`, parsed.codexQuery,
        ["user", "assistant"], ["codex"], undefined, pages.at(-1).continuationCursor);
      pages.push(next);
      runResult.phases.codexAdditionalPages.push(next);
    }
    const lastPage = pages.at(-1);
    const reachedEnd = lastPage.searchComplete && lastPage.continuationCursor === null;
    runResult.phases.codexPageSequence = {
      pageCount: pages.length,
      pagesRequested: parsed.codexPages,
      pagesAttempted: pages.length,
      totalResultCount: pages.every((page) => Number.isInteger(page.resultCount))
        ? pages.reduce((sum, page) => sum + page.resultCount, 0)
        : null,
      fingerprintSha256: digest(JSON.stringify(pages.map((page) => page.resultFingerprintSha256))),
      complete: reachedEnd,
      reachedEnd,
      terminationReason: !lastPage.searchComplete
        ? lastPage.errorKind || "incomplete_search_result"
        : lastPage.continuationCursor ? "page_limit" : "end"
    };
    for (let index = 0; index < parsed.codexRepeats && !timedOut; index += 1) {
      const repeat = await runSearch(`codex-user-assistant-repeat-${index + 1}`, parsed.codexQuery, ["user", "assistant"], ["codex"]);
      runResult.phases.sameProcessCodexRepeats.push(repeat);
    }
  }
} catch (error) {
  runResult.errors.push({ phase: "startup", kind: errorKind(error) });
} finally {
  runResult.serverCpuMsBeforeExit = await serverCpuMs(processPid);
  if (client) await stopClient();
  runResult.parameters.codexSearchCallsAttempted = codexSearchCallsAttempted;
  runResult.parameters.metadataTitleSearchCallsAttempted = metadataTitleSearchCallsAttempted;
  if (parsed.codexDir) {
    try {
      const corpusAfter = codexCorpusFingerprint(parsed.codexDir);
      const corpusBefore = runResult.parameters.codexCorpus;
      const unchanged = corpusBefore.statManifestSha256 === corpusAfter.statManifestSha256
        && corpusBefore.fileCount === corpusAfter.fileCount
        && corpusBefore.totalBytes === corpusAfter.totalBytes;
      runResult.parameters.codexCorpusAfterServerExit = corpusAfter;
      runResult.parameters.codexCorpusStatManifestUnchanged = unchanged;
      if (!unchanged) runResult.errors.push({ phase: "provider-corpus", kind: "stat_manifest_changed" });
    } catch (error) {
      runResult.parameters.codexCorpusAfterServerExit = null;
      runResult.parameters.codexCorpusStatManifestUnchanged = false;
      runResult.errors.push({ phase: "provider-corpus", kind: errorKind(error) });
    }
  }
  runResult.metadataDbAfterServerExit = databaseFootprint(metaPath, parsed.repoRoot);
  runResult.stderr.byteCount = stderrByteCount;
  runResult.completedAtUtc = new Date().toISOString();
  runResult.status = runResult.errors.length === 0
    ? "ok"
    : runResult.phases.coldProcessAndIndexRefresh ? "partial" : "failed";
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(runResult, null, 2)}\n`);
  const title = runResult.phases.metadataTitleSearch;
  const codex = runResult.phases.codexUserAssistantSearch;
  console.log(JSON.stringify({
    status: runResult.status,
    outputPath,
    sourceRevision: source.revision,
    nodeVersion: process.version,
    coldProcessAndIndexRefreshMs: runResult.phases.coldProcessAndIndexRefresh?.wallMs ?? null,
    titleSearchMs: title?.wallMs ?? null,
    titleResultCount: title?.resultCount ?? null,
    titleRepeatCount: runResult.phases.sameProcessTitleRepeats.length,
    codexSearchMs: codex?.wallMs ?? null,
    codexResultCount: codex?.resultCount ?? null,
    codexRepeatCount: runResult.phases.sameProcessCodexRepeats.length,
    codexSearchCallsAttempted,
    codexPagesAttempted: runResult.phases.codexPageSequence?.pagesAttempted ?? 0,
    codexRepeatMs: runResult.phases.sameProcessCodexRepeats.map((phase) => phase.wallMs),
    errorCount: runResult.errors.length
  }));
}
