import { readFileSync } from "node:fs";
import type { Message, RawSession } from "../interface.js";

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function usageToTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  const cached = asNumber(usage.cached_input_tokens);
  const input = Math.max(0, asNumber(usage.input_tokens) - cached);
  const output = asNumber(usage.output_tokens);
  const reasoning = asNumber(usage.reasoning_output_tokens);
  return {
    input,
    output,
    reasoning,
    cache: { read: cached, write: 0 },
    total: asNumber(usage.total_tokens) || input + cached + output
  };
}

function responseText(payload) {
  return (payload?.content || [])
    .flatMap((item) => item?.content || [item])
    .filter((item) => item?.type === "text" || item?.type === "output_text" || item?.type === "input_text")
    .map((item) => item.text || "")
    .join("");
}

/**
 * Parse a Codex CLI JSONL session file.
 * @param {string} filePath
 * @returns {object[]}
 */
export function parseSession(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const records = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch { /* skip */ }
  }
  return records;
}

/**
 * Extract session metadata from records.
 * @param {object[]} records
 * @param {string} fallbackId - Filename-derived session ID
 * @returns {import('../interface.js').RawSession}
 */
export function extractMeta(records, fallbackId): RawSession {
  let sessionId = fallbackId;
  let timeCreated = 0;
  let timeUpdated = 0;
  let messageCount = 0;
  let totalTokens = 0;
  let directory = null;
  let title = null;

  for (const r of records) {
    const ts = r.timestamp ? new Date(r.timestamp).getTime() : 0;
    if (ts && (!timeCreated || ts < timeCreated)) timeCreated = ts;
    if (ts > timeUpdated) timeUpdated = ts;

    if (r.type === "session_meta" && r.payload?.session_id) {
      sessionId = r.payload.session_id;
      directory = r.payload.cwd || r.payload.workdir || directory;
    }

    if (r.type === "event_msg" && r.payload?.type === "user_message") {
      messageCount++;
      if (!title && r.payload.message) {
        title = String(r.payload.message).replace(/\s+/g, " ").trim().slice(0, 120);
      }
    }
    if (r.type === "response_item" && r.payload?.role === "assistant") {
      messageCount++;
    }

    if (r.type === "event_msg" && r.payload?.type === "token_count") {
      const usage = r.payload.info?.total_token_usage;
      if (usage?.total_tokens) totalTokens = usage.total_tokens; // Use latest cumulative total
    }
  }

  return {
    id: sessionId,
    provider: "codex",
    parentId: null,
    title,
    directory,
    timeCreated,
    timeUpdated,
    messageCount,
    tokenCount: totalTokens || null
  };
}

/**
 * Convert records to unified Message[] format.
 * @param {object[]} records
 * @param {string} sessionId
 * @returns {import('../interface.js').Message[]}
 */
export function recordsToMessages(records, sessionId): Message[] {
  const messages = [];
  let idx = 0;
  let model = null;
  let pendingUsageTarget = null;
  const toolCalls = new Map();

  for (const r of records) {
    const ts = r.timestamp ? new Date(r.timestamp).getTime() : 0;

    if (r.type === "session_meta") {
      model = r.payload?.model || r.payload?.model_name || model;
    }
    if (r.type === "turn_context") {
      model = r.payload?.model || model;
    }

    // User message
    if (r.type === "event_msg" && r.payload?.type === "user_message") {
      messages.push({
        id: `msg-${idx++}`,
        sessionId,
        role: "user",
        content: r.payload.message || "",
        thinking: null,
        toolName: null,
        toolInput: null,
        toolOutput: null,
        timestamp: ts,
        tokens: null,
        metadata: { images: r.payload.images }
      });
    }

    // Assistant text response
    if (r.type === "response_item" && r.payload?.type === "message" && r.payload?.role === "assistant") {
      const text = responseText(r.payload);
      if (text) {
        const message = {
          id: r.payload.id || `msg-${idx++}`,
          sessionId,
          role: "assistant",
          content: text,
          thinking: null,
          toolName: null,
          toolInput: null,
          toolOutput: null,
          timestamp: ts,
          tokens: null,
          metadata: { model, provider: "openai" }
        };
        messages.push(message);
        pendingUsageTarget = message;
      }
    }

    if (r.type === "response_item" && r.payload?.type === "reasoning") {
      const thinking = responseText({ content: r.payload.summary || r.payload.content || [] });
      if (thinking) {
        const message = {
          id: r.payload.id || `reasoning-${idx++}`,
          sessionId,
          role: "assistant",
          content: "",
          thinking,
          toolName: null,
          toolInput: null,
          toolOutput: null,
          timestamp: ts,
          tokens: null,
          metadata: { model, provider: "openai" }
        };
        messages.push(message);
        pendingUsageTarget = message;
      }
    }

    // Tool call (function_call)
    if (r.type === "response_item" && r.payload?.type === "function_call") {
      let args = r.payload.arguments;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { /* keep string */ }
      }
      const message = {
        id: r.payload.call_id || `tool-${idx++}`,
        sessionId,
        role: "tool",
        content: "",
        thinking: null,
        toolName: r.payload.name || "unknown",
        toolInput: args,
        toolOutput: null,
        timestamp: ts,
        tokens: null,
        metadata: { model, provider: "openai", callId: r.payload.call_id || null }
      };
      messages.push(message);
      pendingUsageTarget = message;
      if (r.payload.call_id) toolCalls.set(r.payload.call_id, message);
    }

    if (r.type === "response_item" && r.payload?.type === "function_call_output") {
      const target = toolCalls.get(r.payload.call_id);
      if (target) {
        target.toolOutput = r.payload.output ?? "";
        target.content = typeof target.toolOutput === "string"
          ? target.toolOutput
          : JSON.stringify(target.toolOutput);
      }
    }

    if (r.type === "event_msg" && r.payload?.type === "token_count") {
      const tokens = usageToTokens(r.payload.info?.last_token_usage);
      if (tokens && pendingUsageTarget) {
        pendingUsageTarget.tokens = tokens;
        pendingUsageTarget = null;
      }
    }
  }

  return messages;
}
