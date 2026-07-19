import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { getConfig } from "../../config.js";
import { icons } from "../../icons.js";
import type { MessageRole, ProviderAdapter } from "../interface.js";
import { buildLinkedMessageSessionViews } from "../shared/linked-message-session.js";
import { createSnippet, matchesSearchQuery } from "../shared/parser.js";
import {
  createIncrementalTokenStats,
  createSessionFileStore,
  createStructuredViewCache,
  createStructuredViewMethods,
  type TokenFieldMapping
} from "../shared/file-adapter-helpers.js";
import {
  extractPiMeta,
  parsePiSession,
  piAssistantUsageRecords,
  piRecordsToMessages
} from "./parser.js";
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

function generatePiViews(sessionId: string) {
  const entry = sessionFiles.get(sessionId);
  if (!entry) return null;
  return buildLinkedMessageSessionViews(entry.session.id, sessionFiles.getFamily(entry.session.id));
}

const getPiViews = createStructuredViewCache(generatePiViews);

const piTokenMapping: TokenFieldMapping = {
  filterRecord: (entry) => entry.type === "message" && entry.message?.role === "assistant" && Boolean(entry.message?.usage),
  getTimestamp: (entry) => Number(entry.message?.timestamp) || (entry.timestamp ? new Date(entry.timestamp).getTime() : 0),
  inputTokens: (entry) => Number(entry.message?.usage?.input) || 0,
  outputTokens: (entry) => Number(entry.message?.usage?.output) || 0,
  totalTokens: (entry) => Number(entry.message?.usage?.totalTokens)
    || (Number(entry.message?.usage?.input) || 0)
      + (Number(entry.message?.usage?.output) || 0)
      + (Number(entry.message?.usage?.cacheRead) || 0)
      + (Number(entry.message?.usage?.cacheWrite) || 0),
  reasoningTokens: () => 0,
  cacheReadTokens: (entry) => Number(entry.message?.usage?.cacheRead) || 0,
  cacheWriteTokens: (entry) => Number(entry.message?.usage?.cacheWrite) || 0
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
    structuredSessionViews: true
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

  getRuntimeEnvironment(sessionId) {
    const session = sessionFiles.get(sessionId)?.session;
    return session?.directory
      ? buildPiRuntimeEnvironment(session.id, session.directory, getPiDir())
      : null;
  },

  ...createStructuredViewMethods(getPiViews),

  getTokenStats(days = 30) {
    return getPiTokenStats(days);
  },

  getStatsRevision() {
    return sessionFiles.getStatsRevision();
  },

  searchMessages(query, limit = 20) {
    if (!String(query || "").trim()) return [];
    const results = [];
    for (const entry of sessionFiles.list()) {
      if (results.length >= limit) break;
      for (const message of entry.messages) {
        if (results.length >= limit) break;
        if (!(["user", "assistant"] as MessageRole[]).includes(message.role)) continue;
        if (!matchesSearchQuery(message.content, query)) continue;
        results.push({
          sessionId: entry.session.id,
          messageId: message.id,
          role: message.role,
          snippet: createSnippet(message.content, query),
          timestamp: message.timestamp
        });
      }
    }
    return results;
  }
} satisfies ProviderAdapter;

export default pi;
