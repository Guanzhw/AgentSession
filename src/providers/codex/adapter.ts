import { existsSync, readdirSync, lstatSync } from "node:fs";
import path from "node:path";
import { getConfig } from "../../config.js";
import {
  parseSession,
  extractCodexSessionId,
  extractMeta,
  recordsToMessages,
  resolveCodexInheritedContext,
  countCodexRenderedMessages
} from "./parser.js";
import { icons } from "../../icons.js";
import type { Message, ProviderAdapter, RawSession } from "../interface.js";
import { buildLinkedMessageSessionViews } from "../shared/linked-message-session.js";
import { buildCodexRuntimeEnvironment } from "./runtime-environment.js";
import { createSnippet, matchesSearchQuery } from "../shared/parser.js";
import {
  createStructuredViewCache,
  createStructuredViewMethods,
  createSessionFileStore,
  createIncrementalTokenStats,
  type TokenFieldMapping
} from "../shared/file-adapter-helpers.js";

function getCodexDir() {
  return getConfig().codexDir;
}

function discoverSessionFiles() {
  const sessionsDir = path.join(getCodexDir(), "sessions");
  if (!existsSync(sessionsDir)) return [];
  const files: any[] = [];
  const visited = new Set();

  function walk(dir: any) {
    try {
      const dirStat = lstatSync(dir);
      if (dirStat.isSymbolicLink()) return;
      const key = `${dirStat.dev}:${dirStat.ino}`;
      if (visited.has(key)) return;
      visited.add(key);

      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        try {
          const stat = lstatSync(full);
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) walk(full);
          else if (entry.endsWith(".jsonl")) {
            const stem = entry.replace(/\.jsonl$/, "").replace(/^rollout-/, "");
            const canonicalSuffix = stem.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
            const sessionId = canonicalSuffix?.[0] || stem;
            files.push({ sessionId, filePath: full });
          }
        } catch (err) { console.warn("Skipping unreadable directory entry:", full, err); /* skip */ }
      }
    } catch (err) { console.warn("Skipping unreadable directory:", dir, err); /* skip */ }
  }

  walk(sessionsDir);
  return files;
}

const sessionFiles = createSessionFileStore({
  discoverFiles: discoverSessionFiles,
  readEntry(entry) {
    const records = parseSession(entry.filePath);
    const canonicalId = extractCodexSessionId(records, entry.sessionId);
    const messages = recordsToMessages(records, canonicalId);
    const session = extractMeta(records, entry.sessionId, messages);
    return {
      records,
      session,
      messages
    };
  },
  onError(filePath, err) {
    console.warn("Skipping unparseable Codex session file:", filePath, err);
  }
});

function resolveEntry(entry: { session: RawSession; messages: Message[] }) {
  const parent = entry.session.parentId
    ? sessionFiles.get(String(entry.session.parentId))
    : null;
  const resolved = resolveCodexInheritedContext(entry.messages, parent?.messages || []);
  const inheritedContext = entry.session.metadata?.inheritedContext;
  const session = {
    ...entry.session,
    messageCount: countCodexRenderedMessages(resolved.messages),
    metadata: inheritedContext ? {
      ...entry.session.metadata,
      inheritedContext: {
        ...inheritedContext,
        excludedUserMessages: resolved.excludedUserMessages
      }
    } : entry.session.metadata
  };
  return { session, messages: resolved.messages };
}

function generateCodexViews(sessionId: string) {
  const root = sessionFiles.get(sessionId);
  if (!root) return null;
  const canonicalId = String(root.session.id);
  const bundles = sessionFiles.getFamily(canonicalId).map(resolveEntry);
  return buildLinkedMessageSessionViews(canonicalId, bundles);
}

const getCodexViews = createStructuredViewCache(generateCodexViews);

export function codexDailyTokenComponents(usage: any) {
  const input = Number(usage?.input_tokens) || 0;
  const output = Number(usage?.output_tokens) || 0;
  const reasoning = Number(usage?.reasoning_output_tokens) || 0;
  const cacheRead = Number(usage?.cached_input_tokens) || 0;
  const uncachedInput = Math.max(0, input - cacheRead);
  const visibleOutput = Math.max(0, output - reasoning);
  return {
    input: uncachedInput,
    output: visibleOutput,
    reasoning,
    cacheRead,
    total: Number(usage?.total_tokens) || uncachedInput + visibleOutput + reasoning + cacheRead,
  };
}

const codexTokenMapping: TokenFieldMapping = {
  filterRecord: (r) => r.type === "event_msg" && r.payload?.type === "token_count",
  getTimestamp: (r) => r.timestamp ? new Date(r.timestamp).getTime() : 0,
  inputTokens: (r) => {
    return codexDailyTokenComponents(r.payload.info?.last_token_usage).input;
  },
  outputTokens: (r) => {
    return codexDailyTokenComponents(r.payload.info?.last_token_usage).output;
  },
  totalTokens: (r) => (r.payload.info?.last_token_usage || {}).total_tokens || 0,
  reasoningTokens: (r) => (r.payload.info?.last_token_usage || {}).reasoning_output_tokens || 0,
  cacheReadTokens: (r) => (r.payload.info?.last_token_usage || {}).cached_input_tokens || 0,
  cacheWriteTokens: () => 0,
};

const getCodexTokenStats = createIncrementalTokenStats(
  () => sessionFiles.getFileSignatures(),
  (filePath) => sessionFiles.getByFilePath(filePath)?.records || [],
  codexTokenMapping,
);

const codex = {
  id: "codex",
  name: "Codex CLI",
  icon: icons.codex,
  resumeCommand: {
    executable: "codex",
    args: ["resume", "{sessionId}"]
  },
  capabilities: {
    localManagement: true,
    sessionAnalysis: true,
    structuredSessionViews: true
  },

  detect() {
    return existsSync(path.join(getCodexDir(), "sessions"));
  },

  getDataPath() {
    return path.join(getCodexDir(), "sessions");
  },

  async *scan() {
    for (const entry of sessionFiles.list()) {
      if (entry.records.length) yield resolveEntry(entry).session;
    }
  },

  getSession(sessionId) {
    const entry = sessionFiles.get(sessionId);
    return entry ? resolveEntry(entry).session : null;
  },

  getRuntimeEnvironment(sessionId) {
    const session = this.getSession(sessionId);
    return session?.directory
      ? buildCodexRuntimeEnvironment(sessionId, session.directory as string, getCodexDir())
      : null;
  },

  getMessages(sessionId) {
    const entry = sessionFiles.get(sessionId);
    return entry ? resolveEntry(entry).messages : [];
  },

  ...createStructuredViewMethods(getCodexViews),

  getTokenStats(days = 30) {
    return getCodexTokenStats(days);
  },

  getStatsRevision() {
    return sessionFiles.getStatsRevision();
  },

  searchMessages(query, limit = 20) {
    if (!String(query || "").trim()) return [];
    const results = [];
    for (const entry of sessionFiles.list()) {
      if (results.length >= limit) break;
      const { session, messages } = resolveEntry(entry);
      for (const message of messages) {
        if (results.length >= limit) break;
        if (!["user", "assistant"].includes(message.role)) continue;
        const text = message.content || "";
        if (matchesSearchQuery(text, query)) {
          results.push({
            sessionId: session.id,
            messageId: message.id,
            role: message.role,
            snippet: createSnippet(text, query),
            timestamp: message.timestamp
          });
        }
      }
    }
    return results;
  },

} satisfies ProviderAdapter;

export default codex;
