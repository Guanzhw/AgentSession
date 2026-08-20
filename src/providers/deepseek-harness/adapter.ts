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
  extractDshMeta,
  parseDshSession,
  dshRecordsToMessages,
  dshStoredSystemPrompt,
  type DshRecord
} from "./parser.js";
import { buildDshSessionProtocol, type DshProtocolChild } from "./protocol.js";
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
      message: `DeepSeek Harness SQLite persistence was detected at ${filePath}, but AgentSession does not inspect or migrate that database. The reader currently supports JSONL; the compatibility snapshot documents upstream SQLite schema 17.`
    };
  }
  return null;
}

function discoverSessionFiles() {
  const sessionsDir = path.join(getDshDir(), "sessions");
  if (!existsSync(sessionsDir)) return [];
  const candidates = new Map<string, { sessionId: string; filePath: string }>();
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
          if (entry !== "session.jsonl" && entry !== "session.jsonl.zstd") continue;
          const keyPath = path.dirname(fullPath);
          const existing = candidates.get(keyPath);
          // DSH owns one encoding for a root. Prefer the default compressed
          // artifact if a corrupted/mixed directory is encountered.
          if (!existing || entry.endsWith(".zstd")) {
            candidates.set(keyPath, {
              sessionId: path.basename(keyPath),
              filePath: fullPath
            });
          }
        } catch (error) {
          console.warn("Skipping unreadable DeepSeek Harness session entry:", fullPath, error);
        }
      }
    } catch (error) {
      console.warn("Skipping unreadable DeepSeek Harness session directory:", directory, error);
    }
  };

  walk(sessionsDir);
  return [...candidates.values()];
}

const sessionFiles = createSessionFileStore<RawSession, DshRecord[], Message[]>({
  discoverFiles: discoverSessionFiles,
  readEntry(entry) {
    const records = parseDshSession(entry.filePath);
    const session = extractDshMeta(records, entry.sessionId);
    if (!session.id) throw new Error("DeepSeek Harness session has no canonical session ID");
    return { records, session, messages: dshRecordsToMessages(records, session.id) };
  },
  onError(filePath, error) {
    console.warn("Skipping unparseable DeepSeek Harness session file:", filePath, error);
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
  filterRecord: (event) => event.type === "assistant/message" && dshUsageToTokens(event.data?.usage) !== null,
  getTimestamp: (event) => Number(event.time) || 0,
  inputTokens: (event) => dshUsageToTokens(event.data?.usage)?.input || 0,
  outputTokens: (event) => dshUsageToTokens(event.data?.usage)?.output || 0,
  totalTokens: (event) => dshUsageToTokens(event.data?.usage)?.total || 0,
  reasoningTokens: (event) => dshUsageToTokens(event.data?.usage)?.reasoning || 0,
  cacheReadTokens: (event) => dshUsageToTokens(event.data?.usage)?.cache?.read || 0,
  cacheWriteTokens: (event) => dshUsageToTokens(event.data?.usage)?.cache?.write || 0
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
    localManagement: true,
    structuredSessionViews: true
  },
  protocolCapabilities: {
    sessionEvents: { support: "full", provenance: "recorded", details: "DSH v0 append-only events, including expanded packed chunk storage rows" },
    sessionRelationships: { support: "partial", provenance: "derived", details: "recorded header lineage and descriptors, with cross-session child edges resolved locally" },
    tasks: { support: "partial", provenance: "derived", details: "subagent descriptor and tool-workflow child evidence" },
    agentRuns: { support: "partial", provenance: "derived", details: "session-backed subagent and workflow child lifecycles" },
    contextArtifacts: { support: "full", provenance: "recorded", details: "compaction summaries and prunes as metadata-only artifacts" }
  },

  detect() {
    // A current SQLite store is still a detected DSH installation even though
    // this adapter cannot read schema 17 yet. Keeping the provider visible is
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
