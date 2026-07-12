import { existsSync, readdirSync, lstatSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfig } from "../../config.js";
import type { MessageRole } from "../interface.js";
import { parseTranscript, extractSessionMeta, recordsToMessages } from "./parser.js";
import { icons } from "../../icons.js";
import type { ProviderAdapter } from "../interface.js";
import { buildClaudeCodeRuntimeEnvironment } from "./runtime-environment.js";
import {
  buildLinkedClaudeCodeSessionViews,
  buildClaudeCodeSystemPrompts
} from "./views.js";
import {
  createSessionFileStore,
  createStructuredViewCache,
  createStructuredViewMethods,
  buildTokenStats,
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
  return buildLinkedClaudeCodeSessionViews(
    entry.session.id,
    sessionFiles.getFamily(entry.session.id)
  );
}

const getClaudeViews = createStructuredViewCache(generateClaudeViews);

const claudeTokenMapping: TokenFieldMapping = {
  filterRecord: (r) => r.type === "assistant" && !!(r.message?.usage ?? r.usage),
  getTimestamp: (r) => r.timestamp ? new Date(r.timestamp).getTime() : 0,
  inputTokens: (r) => Number((r.message?.usage ?? r.usage).input_tokens) || 0,
  outputTokens: (r) => Number((r.message?.usage ?? r.usage).output_tokens) || 0,
  totalTokens: (r) => {
    const usage = r.message?.usage ?? r.usage;
    return Number(usage.total_tokens)
      || Number(usage.input_tokens)
      + Number(usage.output_tokens)
      + Number(usage.reasoning_tokens)
      + Number(usage.cache_read_input_tokens)
      + Number(usage.cache_creation_input_tokens);
  },
  reasoningTokens: (r) => Number((r.message?.usage ?? r.usage).reasoning_tokens) || 0,
  cacheReadTokens: (r) => Number((r.message?.usage ?? r.usage).cache_read_input_tokens) || 0,
  cacheWriteTokens: (r) => Number((r.message?.usage ?? r.usage).cache_creation_input_tokens) || 0,
};

const claudeCode = {
  id: "claude-code",
  name: "Claude Code",
  icon: icons.claude,
  resumeCommand: {
    executable: "claude",
    args: ["--resume", "{sessionId}"]
  },
  capabilities: {
    localManagement: true,
    sessionAnalysis: true,
    structuredSessionViews: true
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

  getTokenStats(days = 30) {
    return buildTokenStats(
      () => sessionFiles.list(),
      (filePath) => sessionFiles.getByFilePath(filePath)?.records || [],
      claudeTokenMapping,
      days
    );
  },

  searchMessages(query, limit = 20) {
    const term = (query || "").toLowerCase();
    if (!term) return [];
    const results = [];

    for (const entry of sessionFiles.list()) {
      if (results.length >= limit) break;
      for (const r of entry.records) {
        if (results.length >= limit) break;
        let text = "";
        if (r.type === "user") text = extractTextFromRecord(r);
        if (r.type === "assistant") text = extractTextFromRecord(r);
        if (text.toLowerCase().includes(term)) {
          const idx = text.toLowerCase().indexOf(term);
          const start = Math.max(0, idx - 40);
          const end = Math.min(text.length, idx + term.length + 80);
          results.push({
            sessionId: entry.session.id,
            messageId: r.uuid || "",
            role: (r.type === "user" ? "user" : "assistant") as MessageRole,
            snippet: text.slice(start, end),
            timestamp: r.timestamp ? new Date(r.timestamp).getTime() : 0
          });
        }
      }
    }

    return results;
  },

  ...createStructuredViewMethods(getClaudeViews),

  getSystemPrompts(sessionId) {
    const bundle = sessionFiles.get(sessionId);
    if (!bundle) return null;
    const runtimeEnvironment = buildRuntimeEnvironmentForSession(bundle.session.id, bundle.session.directory);
    return buildClaudeCodeSystemPrompts(bundle.session, bundle.records, runtimeEnvironment);
  },

  getTrace(sessionId) {
    return getClaudeViews(sessionId)?.trace || null;
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

function extractTextFromRecord(r: any) {
  if (r.type === "user") {
    const content = r.message?.content ?? r.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  if (r.type === "assistant") {
    const content = r.message?.content ?? r.content ?? [];
    if (typeof content === "string") return content;
    return content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  }
  return "";
}

export default claudeCode;
