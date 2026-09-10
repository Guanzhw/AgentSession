import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import path from "node:path";
import { getConfig } from "../../config.js";
import { icons } from "../../icons.js";
import type { Message, ProviderAdapter, RawSession } from "../interface.js";
import { buildLinkedMessageSessionViews } from "../shared/linked-message-session.js";
import { buildResolvedSystemPromptEvidence } from "../shared/system-prompt-evidence.js";
import {
  createIncrementalTokenStats,
  createSessionFileStore,
  createStructuredViewCache,
  createStructuredViewMethods,
  searchNormalizedMessages,
  type TokenFieldMapping
} from "../shared/file-adapter-helpers.js";
import {
  dshAssistantUsageRecords,
  dshUsageToTokens,
  dshUsageOf,
  extractDshMeta,
  parseDshSession,
  dshGenerationFromPath,
  dshRecordsToMessages,
  dshStoredSystemPrompt,
  type DshRecord
} from "./parser.js";
import { buildDshSessionProtocol, buildDshSessionProtocolV3, type DshProtocolChild } from "./protocol.js";
import { finalizeSessionProtocolV3 } from "../shared/session-protocol-v3.js";
import { buildDshRuntimeEnvironment } from "./runtime-environment.js";

function getDshDir() {
  return getConfig().dshDir;
}

export interface DshStorageDiagnostic {
  backend: "sqlite";
  status: "unsupported";
  path: string;
  detectedSchema: null;
  expectedSchema: 17;
  message: string;
}

/**
 * Detect the conventional DSH SQLite locations without opening or mutating
 * the database.  DSH's SQLite path is deployment-configured, so an arbitrary
 * external path cannot be discovered from AgentSession's read-only config.
 */
export function getDshStorageDiagnostic(root = getDshDir()): DshStorageDiagnostic | null {
  const candidates = ["sessions.sqlite", "sessions.sqlite3", "sessions.db", "dsh.sqlite", "dsh.sqlite3", "dsh.db"];
  for (const name of candidates) {
    const filePath = path.join(root, name);
    if (!existsSync(filePath)) continue;
    let handle: number | null = null;
    try {
      handle = openSync(filePath, "r");
      const header = Buffer.alloc(16);
      if (readSync(handle, header, 0, header.length, 0) !== header.length
        || header.toString("utf8") !== "SQLite format 3\u0000") continue;
    } catch {
      continue;
    } finally {
      if (handle !== null) closeSync(handle);
    }
    return {
      backend: "sqlite",
      status: "unsupported",
      path: filePath,
      detectedSchema: null,
      expectedSchema: 17,
      message: `Legacy DeepSeek Harness SQLite persistence was detected at ${filePath}, but AgentSession does not inspect or migrate that database. The current reader supports JSONL; schema 17 remains documented for existing stores.`
    };
  }
  return null;
}

export interface DshSessionFileDiagnostic {
  directory: string;
  status: "mixed-encoding" | "duplicate-generation" | "parse-error";
  generations: number[];
  message: string;
}

let dshSessionFileDiagnostics: DshSessionFileDiagnostic[] = [];

export function getDshSessionFileDiagnostics() {
  return dshSessionFileDiagnostics.slice();
}

export function discoverSessionFiles(root = getDshDir()) {
  const sessionsDir = path.join(root, "sessions");
  if (!existsSync(sessionsDir)) { dshSessionFileDiagnostics = []; return []; }
  const candidates = new Map<string, Map<number, string[]>>();
  const visited = new Set<string>();

  const walk = (directory: string) => {
    try {
      const directoryStat = lstatSync(directory);
      if (directoryStat.isSymbolicLink()) return;
      const key = `${directoryStat.dev}:${directoryStat.ino}`;
      if (visited.has(key)) return;
      visited.add(key);
      for (const entry of readdirSync(directory).sort((left, right) => left.localeCompare(right))) {
        const fullPath = path.join(directory, entry);
        try {
          const stat = lstatSync(fullPath);
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) {
            walk(fullPath);
            continue;
          }
          const generation = dshGenerationFromPath(entry);
          if (generation === null) continue;
          const keyPath = path.dirname(fullPath);
          const byGeneration = candidates.get(keyPath) || new Map<number, string[]>();
          const paths = byGeneration.get(generation) || [];
          paths.push(fullPath);
          byGeneration.set(generation, paths);
          candidates.set(keyPath, byGeneration);
        } catch (error) {
          console.warn("Skipping unreadable DeepSeek Harness session entry:", fullPath, error);
        }
      }
    } catch (error) {
      console.warn("Skipping unreadable DeepSeek Harness session directory:", directory, error);
    }
  };

  walk(sessionsDir);
  const diagnostics: DshSessionFileDiagnostic[] = [];
  const selected: Array<{ sessionId: string; filePath: string }> = [];
  for (const [directory, byGeneration] of candidates) {
    const generations = [...byGeneration.keys()].sort((a, b) => a - b);
    const allPaths = [...byGeneration.values()].flat();
    const encodings = new Set(allPaths.map((value) => value.endsWith(".zstd") ? "zstd" : "raw"));
    if (encodings.size > 1) {
      diagnostics.push({ directory, status: "mixed-encoding", generations,
        message: `DeepSeek Harness session root has mixed raw/Zstandard generations; no older generation fallback is allowed: ${directory}` });
      continue;
    }
    const generation = generations.at(-1)!;
    const paths = byGeneration.get(generation)!;
    if (paths.length !== 1) {
      diagnostics.push({ directory, status: "duplicate-generation", generations,
        message: `DeepSeek Harness session root has duplicate generation v${generation}; no file was selected: ${directory}` });
      continue;
    }
    selected.push({ sessionId: path.basename(directory), filePath: paths[0] });
  }
  dshSessionFileDiagnostics = diagnostics;
  for (const diagnostic of diagnostics) console.warn(diagnostic.message);
  return selected;
}

const sessionFiles = createSessionFileStore<RawSession, DshRecord[], Message[]>({
  discoverFiles: discoverSessionFiles,
  retainCachedOnError: false,
  readEntry(entry) {
    const records = parseDshSession(entry.filePath);
    const session = extractDshMeta(records, entry.sessionId);
    if (!session.id) throw new Error("DeepSeek Harness session has no canonical session ID");
    return { records, session, messages: dshRecordsToMessages(records, session.id) };
  },
  onError(filePath, error) {
    console.warn("Skipping unparseable DeepSeek Harness session file:", filePath, error);
    const generation = dshGenerationFromPath(path.basename(filePath));
    dshSessionFileDiagnostics = [...dshSessionFileDiagnostics, {
      directory: path.dirname(filePath),
      status: "parse-error",
      generations: generation === null ? [] : [generation],
      message: `DeepSeek Harness canonical session generation is unreadable; no older generation fallback: ${filePath}`
    }];
  }
});

function familyFor(sessionId: string) {
  const root = sessionFiles.get(sessionId);
  if (!root) return null;
  const canonicalId = String(root.session.id);
  return sessionFiles.getFamily(canonicalId);
}

function buildProtocolFor(sessionId: string) {
  const root = sessionFiles.get(sessionId);
  if (!root) return null;
  const canonicalId = String(root.session.id);
  const family = familyFor(canonicalId);
  if (!family) return null;
  const children: DshProtocolChild[] = family
    .filter((entry) => String(entry.session.parentId || "") === canonicalId)
    .map((entry) => ({ session: entry.session, records: entry.records, messages: entry.messages }));
  return buildDshSessionProtocol({
    session: root.session,
    records: root.records,
    messages: root.messages,
    children
  });
}

function buildProtocolV3For(sessionId: string) {
  const root = sessionFiles.get(sessionId);
  if (!root) return null;
  const canonicalId = String(root.session.id);
  const family = familyFor(canonicalId);
  if (!family) return null;
  const children: DshProtocolChild[] = family
    .filter((entry) => String(entry.session.parentId || "") === canonicalId)
    .map((entry) => ({ session: entry.session, records: entry.records, messages: entry.messages }));
  const base = buildDshSessionProtocol({
    session: root.session,
    records: root.records,
    messages: root.messages,
    children
  });
  return finalizeSessionProtocolV3(buildDshSessionProtocolV3({
    session: root.session,
    records: root.records,
    messages: root.messages,
    children
  }, base));
}

function generateDshViews(sessionId: string) {
  const root = sessionFiles.get(sessionId);
  if (!root) return null;
  const canonicalId = String(root.session.id);
  const family = familyFor(canonicalId);
  if (!family) return null;
  const protocol = buildProtocolFor(canonicalId);
  return buildLinkedMessageSessionViews(
    canonicalId,
    family.map((entry) => ({ session: entry.session, messages: entry.messages })),
    protocol ? {
      relationships: protocol.relationships,
      tasks: protocol.tasks,
      agentRuns: protocol.agentRuns
    } : undefined
  );
}

const getDshViews = createStructuredViewCache(generateDshViews);

const dshTokenMapping: TokenFieldMapping = {
  filterRecord: (event) => dshUsageToTokens(dshUsageOf(event)) !== null,
  getTimestamp: (event) => Number(event.time) || 0,
  inputTokens: (event) => dshUsageToTokens(dshUsageOf(event))?.input || 0,
  outputTokens: (event) => dshUsageToTokens(dshUsageOf(event))?.output || 0,
  totalTokens: (event) => dshUsageToTokens(dshUsageOf(event))?.total || 0,
  reasoningTokens: (event) => dshUsageToTokens(dshUsageOf(event))?.reasoning || 0,
  cacheReadTokens: (event) => dshUsageToTokens(dshUsageOf(event))?.cache?.read || 0,
  cacheWriteTokens: (event) => dshUsageToTokens(dshUsageOf(event))?.cache?.write || 0
};

const getDshTokenStats = createIncrementalTokenStats(
  () => sessionFiles.getFileSignatures(),
  (filePath) => dshAssistantUsageRecords(sessionFiles.getByFilePath(filePath)?.records || []),
  dshTokenMapping
);

const deepseekHarness = {
  id: "deepseek-harness",
  name: "DeepSeek Harness",
  icon: icons.deepseekHarness,
  capabilities: {
    // This only enables AgentSession-owned stars, titles, and exclusions; it
    // never mutates DSH's append-only source records.
    localManagement: true
  },
  protocolCapabilities: {
    sessionEvents: { support: "full", provenance: "recorded", details: "DSH alpha.2 v0/v1 frozen events, v2 compatibility, and native v3 one-event-per-row logs; v0/v1 packed rows are expanded at the read boundary" },
    sessionRelationships: { support: "partial", provenance: "derived", details: "recorded header lineage and descriptors, with cross-session child edges resolved locally; native v3 keeps unbound children explicit" },
    tasks: { support: "partial", provenance: "derived", details: "native v3 goal/team task facts plus subagent descriptor and tool-workflow child evidence" },
    agentRuns: { support: "partial", provenance: "derived", details: "session-backed subagent and native v3 workflow child lifecycles when exact ids are available" },
    contextArtifacts: { support: "full", provenance: "recorded", details: "compaction summaries and prunes as metadata-only artifacts; native v3 transforms only readable summaries and v2 replacement provenance remains available in recorded events" }
  },

  detect() {
    // A legacy SQLite store is still a detected DSH installation even though
    // this adapter cannot read schema 17. Keeping the provider visible is
    // what makes the unsupported-backend diagnostic inspectable instead of
    // silently treating durable sessions as absent.
    return existsSync(path.join(getDshDir(), "sessions")) || getDshStorageDiagnostic() !== null;
  },

  getDataPath() {
    return path.join(getDshDir(), "sessions");
  },

  getStorageDiagnostic() {
    return getDshStorageDiagnostic();
  },

  async *scan() {
    for (const entry of sessionFiles.list()) yield entry.session;
  },

  getSession(sessionId) {
    return sessionFiles.get(sessionId)?.session || null;
  },

  getMessages(sessionId) {
    return sessionFiles.get(sessionId)?.messages || [];
  },

  getSessionProtocol(sessionId) {
    return buildProtocolFor(sessionId);
  },

  getSessionProtocolV3(sessionId) {
    return buildProtocolV3For(sessionId);
  },

  getRuntimeEnvironment(sessionId) {
    const session = sessionFiles.get(sessionId)?.session;
    return session?.directory
      ? buildDshRuntimeEnvironment(session.id, session.directory, getDshDir())
      : null;
  },

  getSystemPrompts(sessionId) {
    const entry = sessionFiles.get(sessionId);
    if (!entry) return null;
    const runtimeEnvironment = entry.session.directory
      ? buildDshRuntimeEnvironment(entry.session.id, entry.session.directory, getDshDir())
      : null;
    return buildResolvedSystemPromptEvidence({
      providerName: "DeepSeek Harness",
      mode: "deepseek-harness-recorded",
      session: entry.session,
      messages: entry.messages,
      runtimeEnvironment,
      storedSystemPrompt: dshStoredSystemPrompt(entry.records)
    });
  },

  ...createStructuredViewMethods(getDshViews),

  getTokenStats(days = 30) {
    return getDshTokenStats(days);
  },

  getStatsRevision() {
    return sessionFiles.getStatsRevision();
  },

  searchMessages(query, limit = 20) {
    return searchNormalizedMessages(sessionFiles.list(), query, limit);
  }
} satisfies ProviderAdapter;

export default deepseekHarness;
