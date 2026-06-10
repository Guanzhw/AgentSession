import { existsSync, readdirSync, lstatSync } from "node:fs";
import path from "node:path";
import { getConfig } from "../../config.js";
import { parseSession, extractMeta, recordsToMessages } from "./parser.js";
import { icons } from "../../icons.js";
import type { ProviderAdapter } from "../interface.js";
import { buildMessageSessionViews } from "../shared/message-session.js";

function getCodexDir() {
  return getConfig().codexDir;
}

function discoverSessionFiles() {
  const sessionsDir = path.join(getCodexDir(), "sessions");
  if (!existsSync(sessionsDir)) return [];
  const files = [];
  const visited = new Set();

  function walk(dir) {
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
            const sessionId = entry.replace(/\.jsonl$/, "").replace(/^rollout-/, "");
            files.push({ sessionId, filePath: full });
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  walk(sessionsDir);
  return files;
}

const codex = {
  id: "codex",
  name: "Codex CLI",
  icon: icons.codex,
  resumeCommand: {
    executable: "codex",
    args: ["resume", "{sessionId}"]
  },
  capabilities: {
    structuredSessionViews: true
  },

  detect() {
    return existsSync(path.join(getCodexDir(), "sessions"));
  },

  getDataPath() {
    return path.join(getCodexDir(), "sessions");
  },

  async *scan() {
    for (const { sessionId, filePath } of discoverSessionFiles()) {
      try {
        const records = parseSession(filePath);
        if (records.length === 0) continue;
        yield extractMeta(records, sessionId);
      } catch { /* skip */ }
    }
  },

  getSession(sessionId) {
    for (const entry of discoverSessionFiles()) {
      try {
        const session = extractMeta(parseSession(entry.filePath), entry.sessionId);
        if (session.id === sessionId || entry.sessionId === sessionId) {
          return session;
        }
      } catch { /* skip */ }
    }
    return null;
  },

  getMessages(sessionId) {
    for (const entry of discoverSessionFiles()) {
      try {
        const records = parseSession(entry.filePath);
        const session = extractMeta(records, entry.sessionId);
        if (session.id === sessionId || entry.sessionId === sessionId) {
          return recordsToMessages(records, session.id);
        }
      } catch { /* skip */ }
    }
    return [];
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

  getTokenStats(days = 30) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const cutoff = today.getTime() - (Math.max(1, days) - 1) * 86400000;
    const dailyMap = new Map();
    for (const { filePath } of discoverSessionFiles()) {
      try {
        for (const r of parseSession(filePath)) {
          if (r.type !== "event_msg" || r.payload?.type !== "token_count") continue;
          const ts = r.timestamp ? new Date(r.timestamp).getTime() : 0;
          if (ts < cutoff) continue;
          const day = new Date(ts).toISOString().slice(0, 10);
          const usage = r.payload.info?.last_token_usage || {};
          const existing = dailyMap.get(day) || {
            day, inputTokens: 0, outputTokens: 0, totalTokens: 0, messageCount: 0,
            reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0
          };
          existing.inputTokens += usage.input_tokens || 0;
          existing.outputTokens += usage.output_tokens || 0;
          existing.totalTokens += usage.total_tokens || 0;
          existing.reasoningTokens += usage.reasoning_output_tokens || 0;
          existing.cacheReadTokens += usage.cached_input_tokens || 0;
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
    const results = [];
    for (const { sessionId: fallbackId, filePath } of discoverSessionFiles()) {
      if (results.length >= limit) break;
      try {
        const records = parseSession(filePath);
        const sessionId = extractMeta(records, fallbackId).id;
        for (const r of records) {
          if (results.length >= limit) break;
          let text = "";
          if (r.type === "event_msg" && r.payload?.type === "user_message") text = r.payload.message || "";
          if (r.type === "response_item" && r.payload?.role === "assistant") {
            text = (r.payload.content || []).flatMap((c) => c.content || [c]).filter((c) => c.type === "text").map((c) => c.text).join("");
          }
          if (text.toLowerCase().includes(term)) {
            const idx = text.toLowerCase().indexOf(term);
            results.push({
              sessionId,
              messageId: "",
              role: r.type === "event_msg" ? "user" : "assistant",
              snippet: text.slice(Math.max(0, idx - 40), idx + term.length + 80),
              timestamp: r.timestamp ? new Date(r.timestamp).getTime() : 0
            });
          }
        }
      } catch { /* skip */ }
    }
    return results;
  },

  exportSession(_sessionId) { return null; }
} satisfies ProviderAdapter;

function getStructuredViews(sessionId) {
  const session = codex.getSession(sessionId);
  if (!session) return null;
  return buildMessageSessionViews(session, codex.getMessages(sessionId));
}

export default codex;
