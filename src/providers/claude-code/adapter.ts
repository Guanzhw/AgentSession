import { existsSync, readdirSync, lstatSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfig } from "../../config.js";
import { parseTranscript, extractSessionMeta, recordsToMessages } from "./parser.js";
import { icons } from "../../icons.js";
import type { ProviderAdapter } from "../interface.js";
import { buildMessageSessionViews } from "../shared/message-session.js";
import { buildClaudeCodeRuntimeEnvironment } from "./runtime-environment.js";

function getClaudeDir() {
  return getConfig().claudeDir;
}

/**
 * Discover session files from both legacy and project-scoped layouts.
 * @returns {{ sessionId: string, filePath: string }[]}
 */
function discoverSessionFiles() {
  const claudeDir = getClaudeDir();
  const files = [];

  // Legacy layout: ~/.claude/transcripts/{session-id}.jsonl
  const transcriptsDir = path.join(claudeDir, "transcripts");
  if (existsSync(transcriptsDir)) {
    try {
      for (const entry of readdirSync(transcriptsDir)) {
        if (entry.endsWith(".jsonl")) {
          const sessionId = entry.replace(".jsonl", "");
          files.push({ sessionId, filePath: path.join(transcriptsDir, entry) });
        }
      }
    } catch { /* ignore read errors */ }
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
            if (!files.some((f) => f.sessionId === sessionId)) {
              files.push({ sessionId, filePath: path.join(projectPath, entry) });
            }
          }
        }
      }
    } catch { /* ignore read errors */ }
  }

  return files;
}

const claudeCode = {
  id: "claude-code",
  name: "Claude Code",
  icon: icons.claude,
  resumeCommand: {
    executable: "claude",
    args: ["--resume", "{sessionId}"]
  },
  capabilities: {
    structuredSessionViews: true
  },

  detect() {
    return discoverSessionFiles().length > 0;
  },

  getDataPath() {
    return getClaudeDir();
  },

  async *scan() {
    const files = discoverSessionFiles();
    for (const { sessionId, filePath } of files) {
      try {
        const records = parseTranscript(filePath);
        if (records.length === 0) continue;
        const meta = extractSessionMeta(records, sessionId);
        yield meta;
      } catch {
      }
    }
  },

  getSession(sessionId) {
    const files = discoverSessionFiles();
    const entry = files.find((f) => f.sessionId === sessionId);
    if (!entry) return null;
    try {
      const records = parseTranscript(entry.filePath);
      return extractSessionMeta(records, sessionId);
    } catch {
      return null;
    }
  },

  getRuntimeEnvironment(sessionId) {
    const session = this.getSession(sessionId);
    return session?.directory
      ? buildClaudeCodeRuntimeEnvironment(sessionId, session.directory, getClaudeDir())
      : null;
  },

  getMessages(sessionId) {
    const files = discoverSessionFiles();
    const entry = files.find((f) => f.sessionId === sessionId);
    if (!entry) return [];
    try {
      const records = parseTranscript(entry.filePath);
      return recordsToMessages(records, sessionId);
    } catch {
      return [];
    }
  },

  getTokenStats(days = 30) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const cutoff = today.getTime() - (Math.max(1, days) - 1) * 86400000;
    const files = discoverSessionFiles();
    const dailyMap = new Map();

    for (const { sessionId, filePath } of files) {
      try {
        const records = parseTranscript(filePath);
        for (const r of records) {
          if (r.type !== "assistant" || !(r.message?.usage ?? r.usage)) continue;
          const ts = r.timestamp ? new Date(r.timestamp).getTime() : 0;
          if (ts < cutoff) continue;
          const day = new Date(ts).toISOString().slice(0, 10);
          const usage = r.message?.usage ?? r.usage;
          const input = Number(usage.input_tokens) || 0;
          const output = Number(usage.output_tokens) || 0;
          const reasoning = Number(usage.reasoning_tokens) || 0;
          const cacheRead = Number(usage.cache_read_input_tokens) || 0;
          const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
          const existing = dailyMap.get(day) || {
            day, inputTokens: 0, outputTokens: 0, totalTokens: 0, messageCount: 0,
            reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0
          };
          existing.inputTokens += input;
          existing.outputTokens += output;
          existing.reasoningTokens += reasoning;
          existing.cacheReadTokens += cacheRead;
          existing.cacheWriteTokens += cacheWrite;
          existing.totalTokens += Number(usage.total_tokens) || input + output + reasoning + cacheRead + cacheWrite;
          existing.messageCount += 1;
          dailyMap.set(day, existing);
        }
      } catch { /* skip */ }
    }

    return [...dailyMap.values()].sort((a, b) => a.day.localeCompare(b.day));
  },

  searchMessages(query, limit = 20) {
    const term = (query || "").toLowerCase();
    if (!term) return [];
    const files = discoverSessionFiles();
    const results = [];

    for (const { sessionId, filePath } of files) {
      if (results.length >= limit) break;
      try {
        const records = parseTranscript(filePath);
        for (const r of records) {
          if (results.length >= limit) break;
          let text = "";
          if (r.type === "user") text = extractTextFromRecord(r);
          if (r.type === "assistant") text = extractTextFromRecord(r);
          if (text.toLowerCase().includes(term)) {
            const idx = text.toLowerCase().indexOf(term);
            const start = Math.max(0, idx - 40);
            const end = Math.min(text.length, idx + term.length + 80);
            results.push({
              sessionId,
              messageId: r.uuid || "",
              role: r.type === "user" ? "user" : "assistant",
              snippet: text.slice(start, end),
              timestamp: r.timestamp ? new Date(r.timestamp).getTime() : 0
            });
          }
        }
      } catch { /* skip */ }
    }

    return results;
  },

  exportSession(_sessionId) {
    return null;
  },

  getSessionTree(sessionId) {
    return getStructuredViews(sessionId)?.tree || null;
  },

  getSessionContainer(sessionId) {
    return getStructuredViews(sessionId)?.container || null;
  },

  getSessionMetrics(sessionId) {
    return getStructuredViews(sessionId)?.metrics || null;
  },

  getSessionFlow(sessionId) {
    return getStructuredViews(sessionId)?.flow || null;
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
    } catch {
      return null;
    }
    return null;
  }
} satisfies ProviderAdapter;

function getStructuredViews(sessionId) {
  const session = claudeCode.getSession(sessionId);
  if (!session) return null;
  return buildMessageSessionViews(session, claudeCode.getMessages(sessionId));
}

function extractTextFromRecord(r) {
  if (r.type === "user") {
    const content = r.message?.content ?? r.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  if (r.type === "assistant") {
    const content = r.message?.content ?? r.content ?? [];
    if (typeof content === "string") return content;
    return content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  return "";
}

export default claudeCode;
