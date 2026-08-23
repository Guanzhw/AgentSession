import { existsSync } from "node:fs";
import { getConfig } from "../../config.js";
import { icons } from "../../icons.js";
import {
  listSessions,
  getSession as dbGetSession,
  getMessages as dbGetMessages,
  getParts,
  searchMessages as dbSearchMessages,
  getTokenStats as dbGetTokenStats,
} from "../../db.js";
import { parseJson } from "../shared/parser.js";
import type { ProviderAdapter, ProviderId } from "../interface.js";

function stringifyMessageContent(value: any) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch (err) {
    console.warn("Failed to stringify message content:", err);
    return String(value);
  }
}

export function createOpenCodeSqliteAdapter({
  id,
  name,
  icon = icons.opencode,
  defaultDataPath,
  useConfiguredDbPath = false,
  resumeCommand,
  capabilities = {},
  protocolCapabilities
}: {
  id: ProviderId;
  name: string;
  icon?: string;
  defaultDataPath: () => string;
  useConfiguredDbPath?: boolean;
  resumeCommand?: ProviderAdapter["resumeCommand"];
  capabilities?: ProviderAdapter["capabilities"];
  protocolCapabilities?: ProviderAdapter["protocolCapabilities"];
}): ProviderAdapter {
  function getAdapterDataPath() {
    return useConfiguredDbPath ? (getConfig().dbPath || defaultDataPath()) : defaultDataPath();
  }

  return {
    id,
    name,
    icon,
    resumeCommand,
    capabilities,
    protocolCapabilities,

  detect() {
    const dbPath = getAdapterDataPath();
    return existsSync(dbPath);
  },

  getDataPath() {
    return getAdapterDataPath();
  },

  async *scan() {
    const dbPath = getAdapterDataPath();
    const { sessions } = listSessions(100000, 0, "", "", dbPath);
    for (const s of sessions) {
      yield {
        id: s.id,
        provider: id,
        parentId: null,
        title: s.title || s.slug || null,
        directory: s.directory || null,
        timeCreated: Number(s.time_created) || 0,
        timeUpdated: Number(s.time_updated) || 0,
        messageCount: Number(s.message_count) || 0,
        tokenCount: s.token_count == null ? null : Number(s.token_count)
      };
    }
  },

  getSession(sessionId) {
    return dbGetSession(sessionId, getAdapterDataPath());
  },

  getMessages(sessionId) {
    const dbPath = getAdapterDataPath();
    const messages = dbGetMessages(sessionId, dbPath);
    const results: any[] = [];
    for (const msg of messages) {
      const data = typeof msg.data === "string" ? parseJson(msg.data) : msg.data;
      const parts = getParts(msg.id, dbPath).map((p: any) => ({
        ...p,
        data: typeof p.data === "string" ? parseJson(p.data) : p.data
      }));

      for (const part of parts) {
        const pd = part.data;
        if (!pd) continue;

        if (pd.type === "text" && pd.text) {
          results.push({
            id: `${msg.id}:${part.id}`,
            sessionId,
            role: data?.role || "unknown",
            content: pd.text,
            thinking: null,
            toolName: null,
            toolInput: null,
            toolOutput: null,
            timestamp: Number(data?.time?.created) || 0,
            tokens: data?.tokens ? { input: data.tokens.input || 0, output: data.tokens.output || 0 } : null,
            metadata: { model: data?.modelID, provider: data?.providerID }
          });
        } else if (pd.type === "tool") {
          const toolError = pd.state?.error;
          const toolOutput = pd.state?.output;
          const toolContentValue = pd.state?.status === "error" ? (toolError ?? toolOutput) : (toolOutput ?? toolError);
          const toolContent = stringifyMessageContent(toolContentValue);
          results.push({
            id: `${msg.id}:${part.id}`,
            sessionId,
            role: "tool",
            content: toolContent,
            thinking: null,
            toolName: pd.tool || "unknown",
            toolInput: pd.state?.input || null,
            toolOutput: toolOutput ?? toolError ?? null,
            timestamp: Number(pd.time?.start) || Number(data?.time?.created) || 0,
            tokens: null,
            metadata: {
              duration: pd.time ? (Number(pd.time.end) - Number(pd.time.start)) : null,
              status: typeof pd.state?.status === "string" ? pd.state.status : null
            }
          });
        }
      }
    }
    return results;
  },

  getTokenStats(days = 30) {
    return dbGetTokenStats(days, getAdapterDataPath()).map((row: any) => ({
      day: row.day,
      inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      totalTokens: Number(row.total_tokens) || 0,
      messageCount: Number(row.message_count) || 0,
      reasoningTokens: Number(row.reasoning_tokens) || 0,
      cacheReadTokens: Number(row.cache_read_tokens) || 0,
      cacheWriteTokens: Number(row.cache_write_tokens) || 0
    }));
  },

  searchMessages(query, limit = 20) {
    return dbSearchMessages(query, limit, getAdapterDataPath()).map((r: any) => ({
      sessionId: r.sessionId,
      messageId: r.messageId && r.partId ? `${r.messageId}:${r.partId}` : r.messageId || r.partId,
      role: r.role || "unknown",
      snippet: r.snippet,
      timestamp: Number(r.timeUpdated) || 0
    }));
  },

  exportSession(_sessionId) {
    return null;
  }
  } satisfies ProviderAdapter;
}
