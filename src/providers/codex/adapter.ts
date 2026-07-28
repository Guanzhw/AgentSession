import { existsSync, readdirSync, lstatSync } from "node:fs";
import path from "node:path";
import { getConfig } from "../../config.js";
import {
  parseSession,
  extractCodexSessionId,
  extractMeta,
  recordsToMessages,
  codexOwnedTokenUsageRecords,
  codexUsageToTokens,
  resolveCodexInheritedContext,
  countCodexRenderedMessages
} from "./parser.js";
import { icons } from "../../icons.js";
import type { Message, ProviderAdapter, RawSession } from "../interface.js";
import { buildLinkedMessageSessionViews } from "../shared/linked-message-session.js";
import { buildResolvedSystemPromptEvidence } from "../shared/system-prompt-evidence.js";
import { buildCodexRuntimeEnvironment } from "./runtime-environment.js";
import {
  createStructuredViewCache,
  createStructuredViewMethods,
  createSessionFileStore,
  createIncrementalTokenStats,
  searchNormalizedMessages,
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

function parentEntryFor(entry: { session: RawSession }) {
  const parent = entry.session.parentId
    ? sessionFiles.get(String(entry.session.parentId))
    : null;
  return parent && String(parent.session.id) !== String(entry.session.id)
    ? parent
    : null;
}

function ownedTokenCount(records: any[], parentRecords: any[] = []) {
  return codexOwnedTokenUsageRecords(records, parentRecords).reduce(
    (total, record) => total + (codexUsageToTokens(record.payload?.info?.last_token_usage)?.total || 0),
    0
  );
}

function resolveEntry(entry: { session: RawSession; messages: Message[]; records: any[] }) {
  const parent = parentEntryFor(entry);
  const parentRecords = parent?.records || [];
  const sourceMessages = parent
    ? recordsToMessages(entry.records, entry.session.id, parentRecords)
    : entry.messages;
  const sourceSession = parent
    ? extractMeta(entry.records, entry.session.id, sourceMessages, parentRecords)
    : entry.session;
  const resolved = resolveCodexInheritedContext(sourceMessages, parent?.messages || []);
  const inheritedContext = sourceSession.metadata?.inheritedContext;
  const session = {
    ...sourceSession,
    tokenCount: ownedTokenCount(entry.records, parentRecords) || null,
    messageCount: countCodexRenderedMessages(resolved.messages),
    metadata: inheritedContext ? {
      ...sourceSession.metadata,
      inheritedContext: {
        ...inheritedContext,
        excludedUserMessages: resolved.excludedUserMessages
      }
    } : sourceSession.metadata
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
  const cacheWrite = Number(usage?.cache_write_input_tokens) || 0;
  const uncachedInput = Math.max(0, input - cacheRead - cacheWrite);
  const visibleOutput = Math.max(0, output - reasoning);
  return {
    input: uncachedInput,
    output: visibleOutput,
    reasoning,
    cacheRead,
    cacheWrite,
    total: Number(usage?.total_tokens) || uncachedInput + visibleOutput + reasoning + cacheRead + cacheWrite,
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
  totalTokens: (r) => codexDailyTokenComponents(r.payload.info?.last_token_usage).total,
  reasoningTokens: (r) => codexDailyTokenComponents(r.payload.info?.last_token_usage).reasoning,
  cacheReadTokens: (r) => codexDailyTokenComponents(r.payload.info?.last_token_usage).cacheRead,
  cacheWriteTokens: (r) => codexDailyTokenComponents(r.payload.info?.last_token_usage).cacheWrite,
};

const getCodexTokenStats = createIncrementalTokenStats(
  () => {
    const signatures = sessionFiles.getFileSignatures();
    const signatureByPath = new Map(signatures.map(({ filePath, signature }) => [filePath, signature]));
    return signatures.map((file) => {
      const entry = sessionFiles.getByFilePath(file.filePath);
      const parent = entry ? parentEntryFor(entry) : null;
      return {
        ...file,
        // A child token prefix depends on its declared parent's records too.
        signature: `${file.signature}|parent:${parent ? signatureByPath.get(parent.filePath) || "missing" : "none"}`
      };
    });
  },
  (filePath) => {
    const entry = sessionFiles.getByFilePath(filePath);
    const parent = entry ? parentEntryFor(entry) : null;
    return codexOwnedTokenUsageRecords(entry?.records || [], parent?.records || []);
  },
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

  getSystemPrompts(sessionId) {
    const entry = sessionFiles.get(sessionId);
    if (!entry) return null;
    const resolved = resolveEntry(entry);
    const runtimeEnvironment = resolved.session.directory
      ? buildCodexRuntimeEnvironment(resolved.session.id, resolved.session.directory as string, getCodexDir())
      : null;
    return buildResolvedSystemPromptEvidence({
      providerName: "Codex CLI",
      mode: "codex-resolved",
      session: resolved.session,
      messages: resolved.messages,
      runtimeEnvironment
    });
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
    return searchNormalizedMessages(
      sessionFiles.list().map((entry) => resolveEntry(entry)),
      query,
      limit
    );
  },

} satisfies ProviderAdapter;

export default codex;
