import type { Message, RawSession, TokenUsage } from "../interface.js";

export type HermesRow = Record<string, any>;

export function decodeHermesValue(value: unknown) {
  if (typeof value !== "string") return value;
  const encoded = value.startsWith("\0json:") ? value.slice(6) : value;
  try {
    return JSON.parse(encoded);
  } catch {
    return value;
  }
}

function contentText(value: unknown) {
  const decoded = decodeHermesValue(value);
  if (typeof decoded === "string") return decoded;
  if (Array.isArray(decoded)) {
    return decoded
      .filter(block => block && typeof block === "object")
      .map(block => typeof block.text === "string" ? block.text : "")
      .join("");
  }
  if (decoded == null) return "";
  try { return JSON.stringify(decoded); } catch { return String(decoded); }
}

export function hermesSessionUsage(session: HermesRow): TokenUsage {
  const sourceInput = Number(session.input_tokens) || 0;
  const sourceOutput = Number(session.output_tokens) || 0;
  const reasoning = Number(session.reasoning_tokens) || 0;
  const cacheRead = Number(session.cache_read_tokens) || 0;
  const cacheWrite = Number(session.cache_write_tokens) || 0;
  return {
    // Hermes persists cache reads/writes separately from uncached input.
    input: sourceInput,
    output: Math.max(0, sourceOutput - reasoning),
    reasoning,
    total: Number(session.total_tokens) || sourceInput + sourceOutput + cacheRead + cacheWrite,
    cache: { read: cacheRead, write: cacheWrite }
  };
}

function toolCalls(value: unknown) {
  const decoded = decodeHermesValue(value);
  return Array.isArray(decoded) ? decoded : [];
}

export function hermesRowsToMessages(session: HermesRow, rows: HermesRow[]): Message[] {
  const messages: Message[] = [];
  const calls = new Map<string, Message>();
  for (const row of rows) {
    const eventTime = Number(row.timestamp || 0) * 1000;
    if (row.role === "user") {
      messages.push({
        id: String(row.id), sessionId: String(session.id), role: "user",
        content: contentText(row.content), thinking: null, toolName: null,
        toolInput: null, toolOutput: null, timestamp: eventTime, tokens: null,
        metadata: { platformMessageId: row.platform_message_id || null, provenance: "session" }
      });
      continue;
    }
    if (row.role === "assistant") {
      const turnId = String(row.id);
      // Hermes persists reasoning_content as a single whitespace character for
      // some tool-call turns that carried no visible reasoning. Treat
      // whitespace-only reasoning as absent, but keep real reasoning text
      // byte-for-byte (including any surrounding whitespace) untouched.
      const reasoningText = contentText(row.reasoning || row.reasoning_content);
      messages.push({
        id: turnId, sessionId: String(session.id), role: "assistant",
        content: contentText(row.content),
        thinking: reasoningText.trim() ? reasoningText : null,
        toolName: null, toolInput: null, toolOutput: null,
        timestamp: eventTime, tokens: null,
        metadata: {
          model: session.model || null,
          finishReason: row.finish_reason || null,
          reasoningDetails: decodeHermesValue(row.reasoning_details) || null,
          turnId,
          provenance: "session"
        }
      });
      for (const [index, call] of toolCalls(row.tool_calls).entries()) {
        const callId = String(call.id || `${turnId}:tool:${index}`);
        const tool: Message = {
          id: callId, sessionId: String(session.id), role: "tool", content: "",
          thinking: null, toolName: String(call.function?.name || call.name || "tool"),
          toolInput: decodeHermesValue(call.function?.arguments ?? call.arguments) ?? null,
          toolOutput: null, timestamp: eventTime, tokens: null,
          metadata: { callId, turnId, status: "unknown", provenance: "session" }
        };
        messages.push(tool);
        calls.set(callId, tool);
      }
      continue;
    }
    if (row.role === "tool") {
      const callId = String(row.tool_call_id || "");
      const output = contentText(row.content);
      const tool = calls.get(callId);
      if (tool) {
        tool.content = output;
        tool.toolOutput = output;
        tool.timestamp = eventTime;
        tool.metadata = {
          ...tool.metadata,
          status: row.effect_disposition === "denied" ? "error" : "completed",
          effectDisposition: row.effect_disposition || null
        };
      } else {
        messages.push({
          id: String(row.id), sessionId: String(session.id), role: "tool",
          content: output, thinking: null, toolName: String(row.tool_name || "tool"),
          toolInput: null, toolOutput: output, timestamp: eventTime, tokens: null,
          metadata: { callId, status: "completed", provenance: "session" }
        });
      }
    }
  }
  const usageTarget = [...messages].reverse().find(message => message.role === "assistant");
  if (usageTarget) {
    usageTarget.tokens = hermesSessionUsage(session);
    usageTarget.metadata = { ...usageTarget.metadata, usageScope: "session" };
  }
  return messages;
}

export function extractHermesMeta(session: HermesRow, messages: Message[]): RawSession {
  const modelConfig = decodeHermesValue(session.model_config);
  const delegateFrom = modelConfig && typeof modelConfig === "object"
    ? (modelConfig as HermesRow)._delegate_from
    : null;
  // Rule (a) of the authoritative compression classification: a raw
  // parent_session_id is a compression continuation candidate only when it
  // differs from _delegate_from (the canonical parent-agent session). The
  // store validates rule (b) — the referenced parent row must exist and end
  // with end_reason 'compression' — against the full entry map before any
  // public surface exposes the metadata.
  const compressionCandidate = session.parent_session_id ? String(session.parent_session_id) : null;
  const delegateParent = delegateFrom ? String(delegateFrom) : null;
  return {
    id: String(session.id),
    provider: "hermes",
    // _delegate_from is the canonical parent-agent session. A delegate can
    // also rotate through compression children whose parent_session_id points
    // at the previous compressed segment, so never substitute that lineage ID.
    parentId: delegateParent,
    title: session.title || messages.find(message => message.role === "user")?.content.slice(0, 120) || null,
    directory: session.cwd || null,
    timeCreated: Number(session.started_at || 0) * 1000,
    timeUpdated: Number(session.ended_at || session.started_at || 0) * 1000,
    messageCount: messages.length,
    tokenCount: hermesSessionUsage(session).total || null,
    metadata: {
      source: session.source || null,
      model: session.model || null,
      endReason: session.end_reason || null,
      compressionParentId: compressionCandidate && compressionCandidate !== delegateParent
        ? compressionCandidate
        : null,
      billingProvider: session.billing_provider || null
    }
  };
}
