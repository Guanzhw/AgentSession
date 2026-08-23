import { existsSync, readdirSync, lstatSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfig } from "../../config.js";
import {
  parseTranscript,
  extractSessionMeta,
  recordsToMessages,
  claudeUsageToTokens,
  uniqueClaudeAssistantUsageRecords
} from "./parser.js";
import { icons } from "../../icons.js";
import type { ProviderAdapter } from "../interface.js";
import { buildClaudeCodeRuntimeEnvironment } from "./runtime-environment.js";
import {
  buildLinkedClaudeCodeSessionViews,
  buildClaudeCodeSystemPrompts
} from "./views.js";
import { buildClaudeSessionProtocol } from "./protocol.js";
import { finalizeSessionProtocol, protocolRevision } from "../shared/session-protocol.js";
import {
  createSessionFileStore,
  searchNormalizedMessages,
  createStructuredViewCache,
  createStructuredViewMethods,
  createIncrementalTokenStats,
  type TokenFieldMapping
} from "../shared/file-adapter-helpers.js";

function getClaudeDir() {
  return getConfig().claudeDir;
}

/**
 * Discover session files from both legacy and project-scoped layouts.
 * @returns {{ sessionId: string, filePath: string }[]}
 */
function discoverSessionFiles(): Array<{ sessionId: string; filePath: string }> {
  const claudeDir = getClaudeDir();
  const files: Array<{ sessionId: string; filePath: string }> = [];
  const seenSessionIds = new Set<string>();
  const addFile = (sessionId: string, filePath: string) => {
    if (seenSessionIds.has(sessionId)) return;
    seenSessionIds.add(sessionId);
    files.push({ sessionId, filePath });
  };

  // Legacy layout: ~/.claude/transcripts/{session-id}.jsonl
  const transcriptsDir = path.join(claudeDir, "transcripts");
  if (existsSync(transcriptsDir)) {
    try {
      for (const entry of readdirSync(transcriptsDir)) {
        if (entry.endsWith(".jsonl")) {
          const sessionId = entry.replace(".jsonl", "");
          addFile(sessionId, path.join(transcriptsDir, entry));
        }
      }
    } catch (err) { console.warn("Ignoring read error in transcripts dir:", transcriptsDir, err); /* ignore read errors */ }
  }

  // Project-scoped layout: ~/.claude/projects/{encoded-path}/{uuid}.jsonl
  const projectsDir = path.join(claudeDir, "projects");
  if (existsSync(projectsDir)) {
    try {
       for (const projectDir of readdirSync(projectsDir)) {
         const projectPath = path.join(projectsDir, projectDir);
         const stat = lstatSync(projectPath);
         if (stat.isSymbolicLink()) continue;
         if (!stat.isDirectory()) continue;
        for (const entry of readdirSync(projectPath)) {
          if (entry.endsWith(".jsonl")) {
            const sessionId = entry.replace(".jsonl", "");
            // Avoid duplicates (same session ID in transcripts/ and projects/)
            addFile(sessionId, path.join(projectPath, entry));
          }
        }

        const walkSubagents = (directory: string, insideSubagents = false, depth = 0) => {
          if (depth > 4) return;
          try {
            for (const entry of readdirSync(directory)) {
              const fullPath = path.join(directory, entry);
              const entryStat = lstatSync(fullPath);
              if (entryStat.isSymbolicLink()) continue;
              const nextInsideSubagents = insideSubagents || entry === "subagents";
              if (entryStat.isDirectory()) {
                walkSubagents(fullPath, nextInsideSubagents, depth + 1);
              } else if (nextInsideSubagents && entry.endsWith(".jsonl")) {
                const sessionId = entry.replace(/\.jsonl$/, "").replace(/^agent-/, "");
                addFile(sessionId, fullPath);
              }
            }
          } catch (err) { console.warn("Ignoring inaccessible subagent directory:", directory, err); /* ignore malformed or inaccessible subagent directories */ }
        };
        walkSubagents(projectPath);
      }
    } catch (err) { console.warn("Ignoring read error in projects dir:", projectsDir, err); /* ignore read errors */ }
  }

  return files;
}

const sessionFiles = createSessionFileStore({
  discoverFiles: discoverSessionFiles,
  readEntry: (entry) => {
    const records = parseTranscript(entry.filePath, { strict: true });
    if (records.length === 0) {
      throw new Error("Claude Code transcript has no parseable records");
    }
    const session = extractSessionMeta(records, entry.sessionId);
    return {
      records,
      session,
      messages: recordsToMessages(records, session.id)
    };
  },
  onError: (filePath, error) => {
    console.warn("Skipping unparseable Claude Code session file:", filePath, error);
  }
});

function buildRuntimeEnvironmentForSession(sessionId: string, directory: string | null | undefined) {
  return directory
    ? buildClaudeCodeRuntimeEnvironment(sessionId, directory, getClaudeDir())
    : null;
}

function generateClaudeViews(sessionId: string) {
  const entry = sessionFiles.get(sessionId);
  if (!entry) return null;
  const family = sessionFiles.getFamily(entry.session.id);
  const protocol = buildClaudeSessionProtocolFor(entry.session.id);
  return buildLinkedClaudeCodeSessionViews(
    entry.session.id,
    family,
    protocol ? {
      tasks: protocol.tasks,
      agentRuns: protocol.agentRuns,
      relationships: protocol.relationships
    } : undefined
  );
}

const claudeProtocolCapabilities = {
  sessionEvents: { support: "partial" as const, provenance: "derived" as const, details: "derived message envelopes plus recorded compact boundary and task-notification events" },
  // Parent-side child pairing is reconstructed from sidechain/task evidence;
  // the child-side isSidechain edge is recorded, so the domain is mixed.
  sessionRelationships: { support: "partial" as const, provenance: "derived" as const, details: "recorded sidechain lineage plus derived parent-side child pairing" },
  tasks: { support: "full" as const, provenance: "recorded" as const, details: "<task-notification> records" },
  agentRuns: { support: "partial" as const, provenance: "derived" as const, details: "sidechain transcripts bound to task notifications" },
  contextArtifacts: { support: "full" as const, provenance: "recorded" as const, details: "compact/PreCompact/PostCompact records, metadata-only summaries" },
  branches: { support: "none" as const, provenance: "derived" as const, details: "Claude sidechains are session relationships, not in-file branches" }
};

function buildClaudeSessionProtocolFor(sessionId: string) {
  const entry = sessionFiles.get(sessionId);
  if (!entry) return null;
  const canonicalId = String(entry.session.id);
  const family = sessionFiles.getFamily(canonicalId);
  const children = family.filter((candidate) => (
    candidate.session.parentId && String(candidate.session.parentId) === canonicalId
  ));
  const protocol = buildClaudeSessionProtocol({
    session: entry.session,
    messages: entry.messages,
    records: entry.records,
    children: children.map((child) => ({
      session: child.session,
      messages: child.messages,
      records: child.records
    }))
  });
  return finalizeSessionProtocol(protocol, {
    provider: "claude-code",
    session: entry.session,
    capabilities: claudeProtocolCapabilities,
    revision: protocolRevision(sessionFiles.getStatsRevision())
  });
}

const getClaudeViews = createStructuredViewCache(generateClaudeViews);

const claudeTokenMapping: TokenFieldMapping = {
  filterRecord: (r) => r.type === "assistant" && !!(r.message?.usage ?? r.usage),
  getTimestamp: (r) => r.timestamp ? new Date(r.timestamp).getTime() : 0,
  inputTokens: (r) => claudeUsageToTokens(r.message?.usage ?? r.usage)?.input || 0,
  outputTokens: (r) => claudeUsageToTokens(r.message?.usage ?? r.usage)?.output || 0,
  totalTokens: (r) => claudeUsageToTokens(r.message?.usage ?? r.usage)?.total || 0,
  reasoningTokens: (r) => claudeUsageToTokens(r.message?.usage ?? r.usage)?.reasoning || 0,
  cacheReadTokens: (r) => claudeUsageToTokens(r.message?.usage ?? r.usage)?.cache.read || 0,
  cacheWriteTokens: (r) => claudeUsageToTokens(r.message?.usage ?? r.usage)?.cache.write || 0,
};

const getClaudeTokenStats = createIncrementalTokenStats(
  () => sessionFiles.getFileSignatures(),
  (filePath) => uniqueClaudeAssistantUsageRecords(sessionFiles.getByFilePath(filePath)?.records || []),
  claudeTokenMapping,
);

const claudeCode = {
  id: "claude-code",
  name: "Claude Code",
  icon: icons.claude,
  resumeCommand: {
    executable: "claude",
    args: ["--resume", "{sessionId}"]
  },
  capabilities: {
    localManagement: true
  },
  protocolCapabilities: {
    ...claudeProtocolCapabilities
  },

  detect() {
    return sessionFiles.list().length > 0;
  },

  getDataPath() {
    return getClaudeDir();
  },

  async *scan() {
    for (const entry of sessionFiles.list()) {
      if (entry.records.length === 0) continue;
      yield entry.session;
    }
  },

  getSession(sessionId) {
    return sessionFiles.get(sessionId)?.session || null;
  },

  getRuntimeEnvironment(sessionId) {
    const session = sessionFiles.get(sessionId)?.session;
    return session
      ? buildRuntimeEnvironmentForSession(session.id, session.directory)
      : null;
  },

  getMessages(sessionId) {
    return sessionFiles.get(sessionId)?.messages || [];
  },

  getSessionProtocol(sessionId) {
    return buildClaudeSessionProtocolFor(sessionId);
  },

  getTokenStats(days = 30) {
    return getClaudeTokenStats(days);
  },

  getStatsRevision() {
    return sessionFiles.getStatsRevision();
  },

  searchMessages(query, limit = 20) {
    return searchNormalizedMessages(sessionFiles.list(), query, limit);
  },

  ...createStructuredViewMethods(getClaudeViews),

  getSystemPrompts(sessionId) {
    const bundle = sessionFiles.get(sessionId);
    if (!bundle) return null;
    const runtimeEnvironment = buildRuntimeEnvironmentForSession(bundle.session.id, bundle.session.directory);
    return buildClaudeCodeSystemPrompts(bundle.session, bundle.records, runtimeEnvironment);
  },

  getUnavailableReason() {
    const metadataPath = path.join(os.homedir(), ".claude.json");
    if (!existsSync(metadataPath)) {
      return null;
    }
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
      const projectCount = metadata?.projects && typeof metadata.projects === "object"
        ? Object.keys(metadata.projects).length
        : 0;
      if (projectCount > 0) {
        return `Claude Code metadata lists ${projectCount} projects, but no transcript JSONL files were found in ${getClaudeDir()}. Claude Code removes old transcripts according to cleanupPeriodDays (30 days by default).`;
      }
    } catch (err) {
      console.warn("Failed to parse Claude metadata:", err);
      return null;
    }
    return null;
  }
} satisfies ProviderAdapter;

export default claudeCode;
