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
  piRecordedUsage,
  piRecordedUsageRecord,
  piRecordedUsageRecords,
  piUsageToTokens,
  piRecordsToMessages
} from "./parser.js";
import { buildPiSessionProtocol } from "./protocol.js";
import { finalizeSessionProtocol, protocolRevision, type SessionBranch } from "../shared/session-protocol.js";
import { buildPiRuntimeEnvironment } from "./runtime-environment.js";

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

const piProtocolCapabilities = {
  sessionEvents: { support: "partial" as const, provenance: "derived" as const, details: "derived message envelopes plus recorded compaction/branch_summary events" },
  sessionRelationships: { support: "partial" as const, provenance: "derived" as const, details: "header parentSession lineage only" },
  tasks: { support: "none" as const, provenance: "derived" as const, details: "Pi session files record no task abstraction" },
  agentRuns: { support: "none" as const, provenance: "derived" as const, details: "Pi session files record no agent-run abstraction" },
  contextArtifacts: { support: "full" as const, provenance: "recorded" as const, details: "compaction/branch_summary entries, metadata-only summaries, recorded retainedTail/fromHook evidence" },
  branches: { support: "partial" as const, provenance: "derived" as const, details: "active in-file branch and optional parentSession lineage" }
};

function piBranchTopology(session: any, records: Array<Record<string, any>>): SessionBranch[] {
  const head = [...records].reverse().find((record) => typeof record.id === "string" && record.id)?.id || null;
  const parentId = typeof session.parentId === "string" && session.parentId ? session.parentId : null;
  return [{
    id: `branch:${String(session.id)}`,
    parentBranchId: parentId ? `branch:${parentId}` : null,
    forkEventId: null,
    headEventId: head,
    selected: true,
    provenance: {
      fidelity: "derived",
      sourceType: parentId ? "pi.session.parentSession" : "pi.session.active-file",
      sourceId: parentId || String(session.id)
    }
  }];
}

function buildPiSessionProtocolFor(sessionId: string) {
  const entry = sessionFiles.get(sessionId);
  if (!entry) return null;
  const protocol = buildPiSessionProtocol({
    session: entry.session,
    records: entry.records,
    messages: entry.messages
  });
  return finalizeSessionProtocol({
    ...protocol,
    branches: piBranchTopology(entry.session, entry.records)
  }, {
    provider: "pi",
    session: entry.session,
    capabilities: piProtocolCapabilities,
    revision: protocolRevision(sessionFiles.getStatsRevision())
  });
}

function generatePiViews(sessionId: string) {
  const entry = sessionFiles.get(sessionId);
  if (!entry) return null;
  // Pi records no tasks or agent runs; only relationships are passed. The
  // shared builder attaches children only for spawned evidence, so the
  // derived parent lineage can never fabricate a subagent branch.
  const protocol = buildPiSessionProtocolFor(sessionId);
  if (!protocol) return null;
  return buildLinkedMessageSessionViews(
    entry.session.id,
    sessionFiles.getFamily(entry.session.id),
    { relationships: protocol.relationships }
  );
}

const getPiViews = createStructuredViewCache(generatePiViews);

const piTokenMapping: TokenFieldMapping = {
  // Pi's own billed session total (agent-session.js getSessionStats and
  // usage-totals.js getUsageCostBreakdown) aggregates ALL recorded entries:
  // assistant usage, nested toolResult usage, and compaction/branch_summary
  // summary usage — including abandoned/history branches. The component
  // totals are recorded fields (totalTokens); no origin slices are inferred.
  filterRecord: (entry) => piRecordedUsageRecord(entry),
  getTimestamp: (entry) => Number(entry.message?.timestamp) || (entry.timestamp ? new Date(entry.timestamp).getTime() : 0),
  inputTokens: (entry) => piUsageToTokens(piRecordedUsage(entry))?.input || 0,
  outputTokens: (entry) => piUsageToTokens(piRecordedUsage(entry))?.output || 0,
  totalTokens: (entry) => piUsageToTokens(piRecordedUsage(entry))?.total || 0,
  reasoningTokens: (entry) => piUsageToTokens(piRecordedUsage(entry))?.reasoning || 0,
  cacheReadTokens: (entry) => piUsageToTokens(piRecordedUsage(entry))?.cache?.read || 0,
  cacheWriteTokens: (entry) => piUsageToTokens(piRecordedUsage(entry))?.cache?.write || 0
};

const getPiTokenStats = createIncrementalTokenStats(
  () => sessionFiles.getFileSignatures(),
  (filePath) => piRecordedUsageRecords(sessionFiles.getByFilePath(filePath)?.records || []),
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
    localManagement: true
  },
  protocolCapabilities: {
    ...piProtocolCapabilities
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
    return buildPiSessionProtocolFor(sessionId);
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
