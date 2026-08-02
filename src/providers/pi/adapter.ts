import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { getConfig } from "../../config.js";
import { icons } from "../../icons.js";
import type { ProviderAdapter } from "../interface.js";
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
  extractPiMeta,
  parsePiSession,
  piAssistantUsageRecords,
  piUsageToTokens,
  piRecordsToMessages
} from "./parser.js";
import { buildPiSessionProtocol } from "./protocol.js";import { buildPiRuntimeEnvironment } from "./runtime-environment.js";

function getPiDir() {
  return getConfig().piDir;
}

function discoverSessionFiles() {
  const sessionsDir = path.join(getPiDir(), "sessions");
  if (!existsSync(sessionsDir)) return [];
  const files: Array<{ sessionId: string; filePath: string }> = [];
  const visited = new Set<string>();

  const walk = (directory: string) => {
    try {
      const directoryStat = lstatSync(directory);
      if (directoryStat.isSymbolicLink()) return;
      const key = `${directoryStat.dev}:${directoryStat.ino}`;
      if (visited.has(key)) return;
      visited.add(key);
      for (const entry of readdirSync(directory)) {
        const fullPath = path.join(directory, entry);
        try {
          const stat = lstatSync(fullPath);
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) walk(fullPath);
          else if (entry.endsWith(".jsonl")) {
            const stem = entry.replace(/\.jsonl$/i, "");
            const uuid = stem.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
            files.push({ sessionId: uuid?.[0] || stem, filePath: fullPath });
          }
        } catch (error) {
          console.warn("Skipping unreadable Pi session entry:", fullPath, error);
        }
      }
    } catch (error) {
      console.warn("Skipping unreadable Pi session directory:", directory, error);
    }
  };

  walk(sessionsDir);
  return files;
}

const sessionFiles = createSessionFileStore({
  discoverFiles: discoverSessionFiles,
  readEntry(entry) {
    const records = parsePiSession(entry.filePath);
    const session = extractPiMeta(records, entry.sessionId);
    if (!session.id) throw new Error("Pi session file has no canonical session ID");
    return { records, session, messages: piRecordsToMessages(records, session.id) };
  },
  onError(filePath, error) {
    console.warn("Skipping unparseable Pi session file:", filePath, error);
  }
});

function generatePiViews(sessionId: string) {
  const entry = sessionFiles.get(sessionId);
  if (!entry) return null;
  // Pi records no tasks or agent runs; only relationships are passed. The
  // shared builder attaches children only for spawned evidence, so the
  // derived parent lineage can never fabricate a subagent branch.
  const protocol = buildPiSessionProtocol({
    session: entry.session,
    records: entry.records,
    messages: entry.messages
  });
  return buildLinkedMessageSessionViews(
    entry.session.id,
    sessionFiles.getFamily(entry.session.id),
    { relationships: protocol.relationships }
  );
}

const getPiViews = createStructuredViewCache(generatePiViews);

const piTokenMapping: TokenFieldMapping = {
  filterRecord: (entry) => entry.type === "message" && entry.message?.role === "assistant" && Boolean(entry.message?.usage),
  getTimestamp: (entry) => Number(entry.message?.timestamp) || (entry.timestamp ? new Date(entry.timestamp).getTime() : 0),
  inputTokens: (entry) => piUsageToTokens(entry.message?.usage)?.input || 0,
  outputTokens: (entry) => piUsageToTokens(entry.message?.usage)?.output || 0,
  totalTokens: (entry) => piUsageToTokens(entry.message?.usage)?.total || 0,
  reasoningTokens: (entry) => piUsageToTokens(entry.message?.usage)?.reasoning || 0,
  cacheReadTokens: (entry) => piUsageToTokens(entry.message?.usage)?.cache?.read || 0,
  cacheWriteTokens: (entry) => piUsageToTokens(entry.message?.usage)?.cache?.write || 0
};

const getPiTokenStats = createIncrementalTokenStats(
  () => sessionFiles.getFileSignatures(),
  (filePath) => piAssistantUsageRecords(sessionFiles.getByFilePath(filePath)?.records || []),
  piTokenMapping
);

const pi = {
  id: "pi",
  name: "Pi",
  icon: icons.pi,
  resumeCommand: {
    executable: "pi",
    args: ["--session", "{sessionId}"]
  },
  capabilities: {
    localManagement: true,
    sessionAnalysis: true,
    structuredSessionViews: true
  },
  protocolCapabilities: {
    sessionEvents: { support: "partial", provenance: "derived", details: "derived message envelopes plus recorded compaction/branch_summary events" },
    sessionRelationships: { support: "partial", provenance: "derived", details: "header parentSession lineage only" },
    tasks: { support: "none", provenance: "derived", details: "Pi session files record no task abstraction" },
    agentRuns: { support: "none", provenance: "derived", details: "Pi session files record no agent-run abstraction" },
    contextArtifacts: { support: "full", provenance: "recorded", details: "compaction entries, metadata-only summaries" }
  },

  detect() {
    return existsSync(path.join(getPiDir(), "sessions"));
  },

  getDataPath() {
    return path.join(getPiDir(), "sessions");
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
    const entry = sessionFiles.get(sessionId);
    return entry ? buildPiSessionProtocol({
      session: entry.session,
      records: entry.records,
      messages: entry.messages
    }) : null;
  },

  getRuntimeEnvironment(sessionId) {
    const session = sessionFiles.get(sessionId)?.session;
    return session?.directory
      ? buildPiRuntimeEnvironment(session.id, session.directory, getPiDir())
      : null;
  },

  getSystemPrompts(sessionId) {
    const entry = sessionFiles.get(sessionId);
    if (!entry) return null;
    const runtimeEnvironment = entry.session.directory
      ? buildPiRuntimeEnvironment(entry.session.id, entry.session.directory, getPiDir())
      : null;
    return buildResolvedSystemPromptEvidence({
      providerName: "Pi",
      mode: "pi-resolved",
      session: entry.session,
      messages: entry.messages,
      runtimeEnvironment
    });
  },

  ...createStructuredViewMethods(getPiViews),

  getTokenStats(days = 30) {
    return getPiTokenStats(days);
  },

  getStatsRevision() {
    return sessionFiles.getStatsRevision();
  },

  searchMessages(query, limit = 20) {
    return searchNormalizedMessages(sessionFiles.list(), query, limit);
  }
} satisfies ProviderAdapter;

export default pi;
