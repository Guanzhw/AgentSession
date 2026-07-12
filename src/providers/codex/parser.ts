import { readFileSync } from "node:fs";
import type { Message, RawSession } from "../interface.js";
import { asNumber } from "../shared/parser.js";

function usageToTokens(usage: any) {
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

function responseText(payload: any) {
  return (payload?.content || [])
    .flatMap((item: any) => item?.content || [item])
    .filter((item: any) => ["text", "output_text", "input_text", "summary_text"].includes(item?.type))
    .map((item: any) => item.text || "")
    .join("");
}

type CodexMessageProvenance = "session" | "inherited-parent-context-candidate";

function primarySessionMeta(records: any[]) {
  return records.find((record: any) => record.type === "session_meta")?.payload || {};
}

export function extractCodexSessionId(records: any[], fallbackId: string) {
  const primaryMeta = primarySessionMeta(records);
  return String(primaryMeta.id || primaryMeta.session_id || fallbackId);
}

function isChildOwnedOutput(record: any) {
  if (record.type === "event_msg") {
    return ["agent_message", "agent_reasoning"].includes(record.payload?.type);
  }
  if (record.type !== "response_item") return false;
  return record.payload?.role === "assistant"
    || ["reasoning", "function_call", "custom_tool_call"].includes(record.payload?.type);
}

/** Mark pre-output user records as candidates. The parent transcript must
 * confirm an exact duplicate before an adapter may hide one. */
export function classifyCodexMessageProvenance(records: any[]) {
  const primaryMeta = primarySessionMeta(records);
  const parentId = primaryMeta.parent_thread_id
    || primaryMeta.forked_from_id
    || primaryMeta.source?.subagent?.thread_spawn?.parent_thread_id
    || null;
  const provenance = new Map<any, CodexMessageProvenance>();
  let childOwnedOutputSeen = false;
  for (const record of records) {
    if (isChildOwnedOutput(record)) childOwnedOutputSeen = true;
    const isUserRecord = (record.type === "event_msg" && record.payload?.type === "user_message")
      || (record.type === "response_item" && record.payload?.role === "user");
    if (isUserRecord) {
      provenance.set(
        record,
        parentId && !childOwnedOutputSeen ? "inherited-parent-context-candidate" : "session"
      );
    }
  }
  return provenance;
}

function normalizedUserContent(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/** Hide only candidate user messages that are proven duplicates of the parent.
 * A genuine child prompt remains visible even when it occurs before output. */
export function resolveCodexInheritedContext(messages: Message[], parentMessages: Message[]) {
  const parentUserContent = new Set(
    parentMessages
      .filter((message) => message.role === "user")
      .map((message) => normalizedUserContent(message.content))
      .filter(Boolean)
  );
  let excludedUserMessages = 0;
  const resolved = messages.flatMap((message) => {
    if (message.metadata?.provenance !== "inherited-parent-context-candidate") {
      return [message];
    }
    const content = normalizedUserContent(message.content);
    if (content && parentUserContent.has(content)) {
      excludedUserMessages += 1;
      return [];
    }
    return [{
      ...message,
      metadata: { ...message.metadata, provenance: "session" }
    }];
  });
  return { messages: resolved, excludedUserMessages };
}

/**
 * Parse a Codex CLI JSONL session file.
 * @param {string} filePath
 * @returns {object[]}
 */
export function parseSession(filePath: any) {
  const content = readFileSync(filePath, "utf-8");
  const records = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch (err) { console.warn("Skipping malformed JSON line in:", filePath, err); /* skip */ }
  }
  return records;
}

/**
 * Extract session metadata from records.
 * @param {object[]} records
 * @param {string} fallbackId - Filename-derived session ID
 * @returns {import('../interface.js').RawSession}
 */
export function extractMeta(records: any, fallbackId: any, normalizedMessages?: Message[]): RawSession {
  let sessionId = fallbackId;
  let timeCreated = 0;
  let timeUpdated = 0;
  let totalTokens = 0;
  let directory = null;
  let title = null;
  let parentId = null;
  let metadata = null;
  let sessionMetaSeen = false;
  const messageProvenance = classifyCodexMessageProvenance(records);

  for (const r of records) {
    const ts = r.timestamp ? new Date(r.timestamp).getTime() : 0;
    if (ts && (!timeCreated || ts < timeCreated)) timeCreated = ts;
    if (ts > timeUpdated) timeUpdated = ts;

    if (r.type === "session_meta" && r.payload && !sessionMetaSeen) {
      sessionMetaSeen = true;
      sessionId = r.payload.id || r.payload.session_id || sessionId;
      directory = r.payload.cwd || r.payload.workdir || directory;
      const spawn = r.payload.source?.subagent?.thread_spawn || {};
      parentId = r.payload.parent_thread_id
        || r.payload.forked_from_id
        || spawn.parent_thread_id
        || (r.payload.thread_source === "subagent" && r.payload.session_id !== sessionId ? r.payload.session_id : null)
        || parentId;
      const agentPath = r.payload.agent_path || spawn.agent_path || null;
      const agentNickname = r.payload.agent_nickname || spawn.agent_nickname || null;
      metadata = {
        threadSource: r.payload.thread_source || null,
        agentPath,
        agentNickname,
        inheritedContext: parentId ? {
          parentSessionId: String(parentId),
          candidateUserRecords: [...messageProvenance.values()]
            .filter((value) => value === "inherited-parent-context-candidate").length
        } : null,
        aliases: [agentPath, agentNickname].filter(Boolean)
      };
    }

    if (
      r.type === "event_msg"
      && r.payload?.type === "user_message"
    ) {
      if (!title && r.payload.message) {
        title = String(r.payload.message).replace(/\s+/g, " ").trim().slice(0, 120);
      }
    }
    if (r.type === "event_msg" && r.payload?.type === "token_count") {
      const usage = r.payload.info?.total_token_usage;
      if (usage?.total_tokens) totalTokens = usage.total_tokens; // Use latest cumulative total
    }
  }

  return {
    id: sessionId,
    provider: "codex",
    parentId,
    title: parentId ? metadata?.agentPath || metadata?.agentNickname || title : title,
    directory,
    timeCreated,
    timeUpdated,
    messageCount: countCodexRenderedMessages(normalizedMessages || recordsToMessages(records, sessionId)),
    tokenCount: totalTokens || null,
    metadata
  };
}

export function countCodexRenderedMessages(messages: Message[]) {
  let count = 0;
  let previousGroup = null;
  for (const message of messages) {
    const group = message.metadata?.turnId ?? message.metadata?.responseGroupId;
    const groupable = typeof group === "string"
      && ["assistant", "tool"].includes(String(message.role || "").toLowerCase());
    if (!groupable || group !== previousGroup) count++;
    previousGroup = groupable ? group : null;
  }
  return count;
}

/**
 * Convert records to unified Message[] format.
 * @param {object[]} records
 * @param {string} sessionId
 * @returns {import('../interface.js').Message[]}
 */
export function recordsToMessages(records: any, sessionId: any): Message[] {
  const messages = [];
  let idx = 0;
  let model = null;
  let pendingUsageTarget: any = null;
  let responseIndex = 0;
  let responseGroup: any = null;
  const toolCalls = new Map();
  const primaryMeta = primarySessionMeta(records);
  const subagentStart = primaryMeta.parent_thread_id || primaryMeta.forked_from_id
    ? new Date(records.find((record: any) => record.type === "session_meta")?.timestamp || 0).getTime()
    : 0;
  const messageProvenance = classifyCodexMessageProvenance(records);

  const currentResponseGroup = () => {
    if (!responseGroup) responseGroup = `${sessionId}:response:${responseIndex++}`;
    return responseGroup;
  };

  for (const r of records) {
    const ts = r.timestamp ? new Date(r.timestamp).getTime() : 0;
    if (subagentStart && ts && ts < subagentStart) continue;

    if (r.type === "session_meta") {
      model = r.payload?.model || r.payload?.model_name || model;
    }
    if (r.type === "turn_context") {
      model = r.payload?.model || model;
    }

    // User message
    if (r.type === "event_msg" && r.payload?.type === "user_message") {
      responseGroup = null;
      const provenance = messageProvenance.get(r) || "session";
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
        metadata: { images: r.payload.images, provenance }
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
          metadata: { model, provider: "openai", provenance: "session", turnId: currentResponseGroup() }
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
          metadata: { model, provider: "openai", provenance: "session", turnId: currentResponseGroup() }
        };
        messages.push(message);
        pendingUsageTarget = message;
      }
    }

    // Tool call (function_call)
    if (r.type === "response_item" && ["function_call", "custom_tool_call"].includes(r.payload?.type)) {
      let args = r.payload.arguments ?? r.payload.input;
      if (typeof args === "string") {
        const trimmedArgs = args.trim();
        if (
          (trimmedArgs.startsWith("{") && trimmedArgs.endsWith("}"))
          || (trimmedArgs.startsWith("[") && trimmedArgs.endsWith("]"))
        ) {
          try {
            args = JSON.parse(trimmedArgs);
          } catch (err) {
            console.warn("Failed to parse JSON-shaped tool args, keeping string:", err);
          }
        }
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
        metadata: {
          model,
          provider: "openai",
          callId: r.payload.call_id || null,
          namespace: r.payload.namespace || null,
          provenance: "session",
          turnId: currentResponseGroup()
        }
      };
      messages.push(message);
      pendingUsageTarget = message;
      if (r.payload.call_id) toolCalls.set(r.payload.call_id, message);
    }

    if (r.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(r.payload?.type)) {
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
      responseGroup = null;
    }
  }

  return messages as Message[];
}
