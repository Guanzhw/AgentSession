import { readFileSync } from "node:fs";
import type { Message, RawSession } from "../interface.js";
import { asNumber } from "../shared/parser.js";

export function codexUsageToTokens(usage: any) {
  if (!usage || typeof usage !== "object") return null;
  const cached = asNumber(usage.cached_input_tokens);
  const cacheWrite = asNumber(usage.cache_write_input_tokens);
  const input = Math.max(0, asNumber(usage.input_tokens) - cached - cacheWrite);
  const reasoning = asNumber(usage.reasoning_output_tokens);
  const output = Math.max(0, asNumber(usage.output_tokens) - reasoning);
  return {
    input,
    output,
    reasoning,
    cache: { read: cached, write: cacheWrite },
    total: asNumber(usage.total_tokens) || input + cached + cacheWrite + output + reasoning
  };
}

function responseText(payload: any) {
  const content = payload?.content ?? payload?.message;
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : [])
    .flatMap((item: any) => item?.content || [item])
    .filter((item: any) => ["text", "output_text", "input_text", "summary_text"].includes(item?.type))
    .map((item: any) => item.text || "")
    .join("");
}

type CodexMessageProvenance = "session" | "inherited-parent-context-candidate";
type CodexRecordProvenance = "session" | "inherited-parent-context" | "duplicate-token-usage";

function primarySessionMeta(records: any[]) {
  return records.find((record: any) => record.type === "session_meta")?.payload || {};
}

function codexParentSessionId(primaryMeta: any) {
  return primaryMeta.parent_thread_id
    || primaryMeta.forked_from_id
    || primaryMeta.source?.subagent?.thread_spawn?.parent_thread_id
    || null;
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

function agentMessageText(payload: any) {
  return responseText(payload).replace(/\s+/g, " ").trim();
}

function isSubagentTaskEnvelope(record: any, _primaryMeta: any) {
  if (record.type !== "response_item" || record.payload?.type !== "agent_message") return false;
  const text = agentMessageText(record.payload);
  return /^Message Type:\s*NEW_TASK\b/i.test(text);
}

function subagentTaskMessage(payload: any) {
  const text = agentMessageText(payload);
  const taskName = text.match(/(?:^|\s)Task name:\s*([^\s]+)/i)?.[1] || null;
  const hasEncryptedBody = (payload?.content || []).some((item: any) => (
    item?.type === "encrypted_content"
    || (Array.isArray(item?.content) && item.content.some((child: any) => child?.type === "encrypted_content"))
  ));
  const content = taskName
    ? `Subagent task: ${taskName}`
    : "Subagent task";
  return {
    content: hasEncryptedBody
      ? `${content}\n\nThe task body is encrypted in the Codex transcript and cannot be recovered locally.`
      : text,
    taskName,
    promptAvailable: !hasEncryptedBody
  };
}

function isCodexTokenUsageRecord(record: any) {
  return record.type === "event_msg" && record.payload?.type === "token_count";
}

const tokenUsageFingerprintFields = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens"
];

function tokenUsageFingerprint(usage: any) {
  if (!usage || typeof usage !== "object") return null;
  if (!tokenUsageFingerprintFields.some((field) => usage[field] !== undefined && usage[field] !== null)) {
    return null;
  }
  // Codex omits zero-valued fields in some replay records. Normalize those
  // omissions so they still compare as the same accounting snapshot.
  return tokenUsageFingerprintFields.map((field) => asNumber(usage[field]));
}

function codexTokenUsageRecordFingerprint(record: any) {
  if (!isCodexTokenUsageRecord(record)) return null;
  const info = record.payload?.info || {};
  const last = tokenUsageFingerprint(info.last_token_usage);
  if (!last) return null;
  return JSON.stringify({
    last,
    total: tokenUsageFingerprint(info.total_token_usage)
  });
}

/**
 * Some older Codex forks omit the NEW_TASK envelope but still begin with a
 * byte-for-byte replay of the parent request usage. Match only a leading run
 * of at least two complete usage snapshots against the declared parent; a
 * single matching request is too weak to prove inherited context.
 */
function copiedParentTokenPrefix(records: any[], parentRecords: any[], parentId: any, hasTaskEnvelope: boolean) {
  if (!parentId || hasTaskEnvelope || !parentRecords.length) return new Set<any>();

  const childTokens = records.filter(isCodexTokenUsageRecord);
  const parentTokens = parentRecords.filter(isCodexTokenUsageRecord);
  const childFingerprints = childTokens.map(codexTokenUsageRecordFingerprint);
  const parentFingerprints = parentTokens.map(codexTokenUsageRecordFingerprint);
  if (childFingerprints.length < 2 || childFingerprints.some((value) => value === null)) {
    return new Set<any>();
  }

  let longestMatch = 0;
  for (let parentStart = 0; parentStart < parentFingerprints.length; parentStart += 1) {
    let length = 0;
    while (
      length < childFingerprints.length
      && parentStart + length < parentFingerprints.length
      && childFingerprints[length] === parentFingerprints[parentStart + length]
    ) {
      length += 1;
    }
    longestMatch = Math.max(longestMatch, length);
  }

  return longestMatch >= 2
    ? new Set(childTokens.slice(0, longestMatch))
    : new Set<any>();
}

/** A repeated adjacent usage event with the same cumulative snapshot cannot
 * represent another model request. Codex occasionally persists this replay
 * while resuming a rollout, so retain the first event only. */
function duplicateCodexTokenUsageRecords(records: any[], provenance: Map<any, CodexRecordProvenance>) {
  const duplicates = new Set<any>();
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    if (
      !isCodexTokenUsageRecord(previous)
      || !isCodexTokenUsageRecord(current)
      || provenance.get(previous) !== "session"
      || provenance.get(current) !== "session"
    ) continue;
    const previousFingerprint = codexTokenUsageRecordFingerprint(previous);
    if (previousFingerprint && previousFingerprint === codexTokenUsageRecordFingerprint(current)) {
      duplicates.add(current);
    }
  }
  return duplicates;
}

/**
 * Codex subagent rollouts begin with a copied parent-thread segment. That
 * segment ends at the child-specific NEW_TASK envelope; everything before it
 * belongs to the parent even though it lives in the child JSONL file.
 */
export function classifyCodexRecordProvenance(records: any[], parentRecords: any[] = []) {
  const primaryMeta = primarySessionMeta(records);
  const parentId = codexParentSessionId(primaryMeta);
  const provenance = new Map<any, CodexRecordProvenance>();
  const hasTaskEnvelope = records.some((record) => isSubagentTaskEnvelope(record, primaryMeta));
  const inheritedTokenPrefix = copiedParentTokenPrefix(records, parentRecords, parentId, hasTaskEnvelope);
  let insideInheritedParentContext = Boolean(parentId && hasTaskEnvelope);

  for (const record of records) {
    if (insideInheritedParentContext && isSubagentTaskEnvelope(record, primaryMeta)) {
      insideInheritedParentContext = false;
      provenance.set(record, "session");
      continue;
    }
    provenance.set(record, insideInheritedParentContext ? "inherited-parent-context" : "session");
  }
  for (const record of inheritedTokenPrefix) {
    provenance.set(record, "inherited-parent-context");
  }
  for (const record of duplicateCodexTokenUsageRecords(records, provenance)) {
    provenance.set(record, "duplicate-token-usage");
  }
  return provenance;
}

/** Token events in a subagent transcript can begin with a copied parent
 * segment. Keep only requests that are owned by the transcript's session. */
export function codexOwnedTokenUsageRecords(records: any[], parentRecords: any[] = []) {
  const provenance = classifyCodexRecordProvenance(records, parentRecords);
  return records.filter((record) => (
    isCodexTokenUsageRecord(record)
    && provenance.get(record) === "session"
  ));
}

/** Mark copied parent user records as candidates. The adapter confirms the
 * exact duplicate against the parent before it hides it. */
export function classifyCodexMessageProvenance(records: any[], parentRecords: any[] = []) {
  const primaryMeta = primarySessionMeta(records);
  const parentId = codexParentSessionId(primaryMeta);
  const hasTaskEnvelope = records.some((record) => isSubagentTaskEnvelope(record, primaryMeta));
  const recordProvenance = classifyCodexRecordProvenance(records, parentRecords);
  const provenance = new Map<any, CodexMessageProvenance>();
  let childOwnedOutputSeen = false;
  for (const record of records) {
    if (isChildOwnedOutput(record)) childOwnedOutputSeen = true;
    const isUserRecord = (record.type === "event_msg" && record.payload?.type === "user_message")
      || (record.type === "response_item" && record.payload?.role === "user");
    if (isUserRecord) {
      provenance.set(
        record,
        recordProvenance.get(record) === "inherited-parent-context"
          || (!hasTaskEnvelope && parentId && !childOwnedOutputSeen)
          ? "inherited-parent-context-candidate"
          : "session"
      );
    }
  }
  return provenance;
}

function normalizedUserContent(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/** Hide any user message that is proven to be copied from the parent. The
 * direct record provenance makes the usual case precise; exact matching keeps
 * older rollouts from leaking copied messages after a parent output. */
export function resolveCodexInheritedContext(messages: Message[], parentMessages: Message[]) {
  const parentUserContent = new Set(
    parentMessages
      .filter((message) => message.role === "user")
      .map((message) => normalizedUserContent(message.content))
      .filter(Boolean)
  );
  let excludedUserMessages = 0;
  const resolved = messages.flatMap((message) => {
    const content = normalizedUserContent(message.content);
    if (message.role === "user" && content && parentUserContent.has(content)) {
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
export function extractMeta(records: any, fallbackId: any, normalizedMessages?: Message[], parentRecords: any[] = []): RawSession {
  let sessionId = fallbackId;
  let timeCreated = 0;
  let timeUpdated = 0;
  let totalTokens = 0;
  let directory = null;
  let title = null;
  let parentId = null;
  let metadata = null;
  let sessionMetaSeen = false;
  const messageProvenance = classifyCodexMessageProvenance(records, parentRecords);
  const recordProvenance = classifyCodexRecordProvenance(records, parentRecords);

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
      if (recordProvenance.get(r) !== "session") continue;
      totalTokens += codexUsageToTokens(r.payload.info?.last_token_usage)?.total || 0;
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
  let activeAssistant = false;
  for (const message of messages) {
    const role = String(message.role || "").toLowerCase();
    const group = message.metadata?.turnId ?? message.metadata?.responseGroupId;
    const groupable = typeof group === "string"
      && ["assistant", "tool"].includes(role);
    const groupedWithPrevious = groupable && group === previousGroup;
    const implicitContinuation = activeAssistant && role === "tool";
    if (!groupedWithPrevious && !implicitContinuation) count++;
    activeAssistant = ["assistant", "tool"].includes(role);
    previousGroup = groupable ? group : null;
  }
  return count;
}

function tokenUsageTotal(tokens: any) {
  return asNumber(tokens?.total) || (
    asNumber(tokens?.input)
    + asNumber(tokens?.output)
    + asNumber(tokens?.reasoning)
    + asNumber(tokens?.cache?.read)
    + asNumber(tokens?.cache?.write)
  );
}

function mergeTokenUsage(values: any[]) {
  return values.reduce((total, tokens) => ({
    input: asNumber(total.input) + asNumber(tokens.input),
    output: asNumber(total.output) + asNumber(tokens.output),
    reasoning: asNumber(total.reasoning) + asNumber(tokens.reasoning),
    total: tokenUsageTotal(total) + tokenUsageTotal(tokens),
    cache: {
      read: asNumber(total.cache?.read) + asNumber(tokens.cache?.read),
      write: asNumber(total.cache?.write) + asNumber(tokens.cache?.write)
    }
  }), {
    input: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    cache: { read: 0, write: 0 }
  });
}

/** A token event is a model request, not necessarily a visible transcript
 * record. Preserve every adjacent request on its closest rendered target. */
function appendTokenUsage(target: any, tokens: any, attribution = "direct") {
  const existing = Array.isArray(target.metadata?.tokenRequests)
    ? target.metadata.tokenRequests.filter((value: unknown) => value && typeof value === "object")
    : target.tokens
      ? [target.tokens]
      : [];
  const tokenRequests = [...existing, tokens];
  target.tokens = mergeTokenUsage(tokenRequests);
  target.metadata = {
    ...(target.metadata || {}),
    tokenRequests,
    tokenAttribution: existing.length > 0 ? "adjacent" : target.metadata?.tokenAttribution || attribution
  };
}

/**
 * Convert records to unified Message[] format.
 * @param {object[]} records
 * @param {string} sessionId
 * @returns {import('../interface.js').Message[]}
 */
export function recordsToMessages(records: any, sessionId: any, parentRecords: any[] = []): Message[] {
  const messages: any[] = [];
  let idx = 0;
  let model = null;
  let pendingUsageTarget: any = null;
  let lastUsageTarget: any = null;
  let lastUserTarget: any = null;
  let responseIndex = 0;
  let responseGroup: any = null;
  const toolCalls = new Map();
  const seenSubagentTaskEnvelopes = new Set<string>();
  const primaryMeta = primarySessionMeta(records);
  const subagentStart = primaryMeta.parent_thread_id || primaryMeta.forked_from_id
    ? new Date(records.find((record: any) => record.type === "session_meta")?.timestamp || 0).getTime()
    : 0;
  const messageProvenance = classifyCodexMessageProvenance(records, parentRecords);
  const recordProvenance = classifyCodexRecordProvenance(records, parentRecords);

  const currentResponseGroup = () => {
    if (!responseGroup) responseGroup = `${sessionId}:response:${responseIndex++}`;
    return responseGroup;
  };

  for (const r of records) {
    const ts = r.timestamp ? new Date(r.timestamp).getTime() : 0;
    if (subagentStart && ts && ts < subagentStart) continue;
    if (recordProvenance.get(r) !== "session") continue;

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
      const message = {
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
      };
      messages.push(message);
      // A token_count can arrive after an interrupted request, before Codex
      // emits any assistant item. It belongs to this new user request, never
      // to the preceding assistant turn.
      pendingUsageTarget = null;
      lastUsageTarget = null;
      lastUserTarget = message;
    }

    // Older Codex transcripts persist visible agent output as event messages
    // rather than response_item records. They are still the nearest durable
    // anchor for the following model-usage events.
    if (r.type === "event_msg" && r.payload?.type === "agent_message") {
      const content = String(r.payload.message || "");
      if (content) {
        const previous: any = messages.at(-1);
        const duplicate = previous?.role === "assistant"
          && previous.metadata?.source === "codex_agent_message"
          && previous.content === content;
        const message = duplicate ? previous : {
          id: `agent-message-${idx++}`,
          sessionId,
          role: "assistant",
          content,
          thinking: null,
          toolName: null,
          toolInput: null,
          toolOutput: null,
          timestamp: ts,
          tokens: null,
          metadata: {
            model,
            provider: "openai",
            provenance: "session",
            source: "codex_agent_message",
            turnId: currentResponseGroup()
          }
        };
        if (!duplicate) messages.push(message);
        pendingUsageTarget = message;
        lastUsageTarget = message;
      }
    }

    if (r.type === "event_msg" && r.payload?.type === "agent_reasoning") {
      const thinking = String(r.payload.text || "");
      if (thinking) {
        const previous: any = messages.at(-1);
        const isProgressiveSnapshot = previous?.role === "assistant"
          && previous.metadata?.source === "codex_agent_reasoning"
          && (thinking.startsWith(previous.thinking || "") || (previous.thinking || "").startsWith(thinking));
        const message = isProgressiveSnapshot ? previous : {
          id: `agent-reasoning-${idx++}`,
          sessionId,
          role: "assistant",
          content: "",
          thinking,
          toolName: null,
          toolInput: null,
          toolOutput: null,
          timestamp: ts,
          tokens: null,
          metadata: {
            model,
            provider: "openai",
            provenance: "session",
            source: "codex_agent_reasoning",
            turnId: currentResponseGroup()
          }
        };
        if (isProgressiveSnapshot && thinking.length > String(previous.thinking || "").length) {
          previous.thinking = thinking;
        } else if (!isProgressiveSnapshot) {
          messages.push(message);
        }
        pendingUsageTarget = message;
        lastUsageTarget = message;
      }
    }

    if (isSubagentTaskEnvelope(r, primaryMeta)) {
      responseGroup = null;
      const task = subagentTaskMessage(r.payload);
      const taskKey = `${task.taskName || ""}\u0000${task.content}`;
      if (seenSubagentTaskEnvelopes.has(taskKey)) continue;
      seenSubagentTaskEnvelopes.add(taskKey);
      const message = {
        id: r.payload.id || `subagent-task-${idx++}`,
        sessionId,
        role: "user",
        content: task.content,
        thinking: null,
        toolName: null,
        toolInput: null,
        toolOutput: null,
        timestamp: ts,
        tokens: null,
        metadata: {
          provenance: "session",
          source: "subagent_task",
          taskName: task.taskName,
          promptAvailable: task.promptAvailable
        }
      };
      messages.push(message);
      pendingUsageTarget = null;
      lastUsageTarget = null;
      lastUserTarget = message;
    }

    // Assistant text response
    if (r.type === "response_item" && r.payload?.type === "message" && r.payload?.role === "assistant") {
      const text = responseText(r.payload);
      if (text) {
        const previous: any = messages.at(-1);
        const duplicate = previous?.role === "assistant"
          && previous.metadata?.source === "codex_agent_message"
          && previous.content === text;
        const message = duplicate ? previous : {
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
        if (!duplicate) messages.push(message);
        pendingUsageTarget = message;
        lastUsageTarget = message;
      }
    }

    if (r.type === "response_item" && r.payload?.type === "reasoning") {
      const thinking = responseText({ content: r.payload.summary || r.payload.content || [] });
      if (thinking) {
        const turnId = currentResponseGroup();
        const previous: any = messages.at(-1);
        // Codex streams cumulative reasoning snapshots for one request. Each
        // later snapshot contains the earlier summary plus more detail, so
        // rendering all of them produces a column of duplicate Reasoning
        // blocks. Keep the newest snapshot in that response group.
        const previousThinking: string = typeof previous?.thinking === "string" ? previous.thinking : "";
        const replacesProgressiveSnapshot = Boolean(previous?.role === "assistant"
          && !previous.content
          && !previous.toolName
          && previous.metadata?.turnId === turnId
          && previousThinking
          && (thinking.startsWith(previousThinking) || previousThinking.startsWith(thinking)));
        if (replacesProgressiveSnapshot) {
          if (thinking.length > previousThinking.length) previous.thinking = thinking;
          pendingUsageTarget = previous;
          lastUsageTarget = previous;
          continue;
        }
        const message: any = {
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
          metadata: { model, provider: "openai", provenance: "session", turnId }
        };
        messages.push(message);
        pendingUsageTarget = message;
        lastUsageTarget = message;
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
      lastUsageTarget = message;
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
      const tokens = codexUsageToTokens(r.payload.info?.last_token_usage);
      const target = pendingUsageTarget || lastUsageTarget || lastUserTarget;
      if (tokens && target) {
        appendTokenUsage(target, tokens, target === lastUserTarget ? "request-start" : "direct");
        lastUsageTarget = target;
      }
      pendingUsageTarget = null;
      responseGroup = null;
    }
  }

  return messages as Message[];
}
