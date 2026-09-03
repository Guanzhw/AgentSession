import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import type { Message, RawSession } from "../interface.js";
import { asNumber } from "../shared/parser.js";

export const CODEX_MAX_DECOMPRESSED_ROLLOUT_BYTES = 64 * 1024 * 1024;

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

type CodexMessageProvenance = "session" | "inherited-parent-context";
type CodexRecordProvenance = "session" | "inherited-parent-context" | "duplicate-token-usage";

/**
 * New-format Codex transcripts (0.151+ with paginated history) record user
 * turns as `response_item` message/role=user rows. The recorded passthrough
 * `content_item_kinds` tag the genuine user text (`user.text`) separately
 * from system-injected context rows (plugin recommendations, AGENTS.md
 * instructions, environment context, internal goal context); only tagged
 * rows are user messages. Legacy-format `response_item` user rows carry no
 * passthrough at all, and in all observed rollouts they are injected context
 * or copied parent history, never real user text.
 */
export function codexUserTextRecord(record: any): string | null {
  if (record?.type !== "response_item") return null;
  if (record.payload?.type !== "message" || record.payload?.role !== "user") return null;
  const kinds = record.payload?.internal_chat_message_metadata_passthrough?.content_item_kinds;
  if (!Array.isArray(kinds) || !kinds.includes("user.text")) return null;
  return responseText(record.payload) || null;
}

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

export function codexUsagePayload(record: any) {
  if (record?.type === "event_msg" && record.payload?.type === "token_count") {
    return record.payload?.info?.last_token_usage || null;
  }
  if (record?.type === "token_usage_record") {
    // Current Codex rollouts persist one completed Responses API usage row.
    // `turn_token_usage` and `thread_token_usage` are cumulative views and are
    // intentionally not used as another request.
    return record.payload?.usage || null;
  }
  return null;
}

function isCodexTokenUsageRecord(record: any) {
  return Boolean(codexUsagePayload(record));
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

function codexTokenUsageResponseId(record: any) {
  return record?.type === "token_usage_record"
    ? record.payload?.response_id || null
    : record?.payload?.response_id || record?.payload?.info?.response_id || null;
}

function codexTokenUsageSnapshotFingerprint(record: any) {
  return JSON.stringify(tokenUsageFingerprint(codexUsagePayload(record)));
}

function codexTokenUsageRecordFingerprint(record: any) {
  if (!isCodexTokenUsageRecord(record)) return null;
  const last = tokenUsageFingerprint(codexUsagePayload(record));
  if (!last) return null;
  return JSON.stringify({
    last,
    total: tokenUsageFingerprint(record.type === "event_msg" ? record.payload?.info?.total_token_usage : null),
    responseId: record.type === "token_usage_record" ? record.payload?.response_id || null : null
  });
}

function stableCodexValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableCodexValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "timestamp")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableCodexValue(entry)])
  );
}

function codexRecordFingerprint(record: any) {
  if (!record || typeof record !== "object") return null;
  return JSON.stringify(stableCodexValue(record));
}

function codexCopyFingerprint(record: any) {
  const payload = record?.payload && typeof record.payload === "object" ? record.payload : {};
  if (record?.type === "event_msg" && payload.type === "user_message") {
    return JSON.stringify({ kind: "message", role: "user", content: payload.message || "" });
  }
  if (record?.type === "event_msg" && payload.type === "agent_message") {
    return JSON.stringify({ kind: "message", role: "assistant", content: payload.message || "" });
  }
  if (record?.type === "event_msg" && payload.type === "agent_reasoning") {
    return JSON.stringify({ kind: "reasoning", content: payload.text || "" });
  }
  if (record?.type === "response_item" && payload.type === "message") {
    return JSON.stringify({ kind: "message", role: payload.role || "", content: responseText(payload) });
  }
  if (record?.type === "response_item" && payload.type === "reasoning") {
    return JSON.stringify({
      kind: "reasoning",
      content: responseText({ content: payload.summary || payload.content || [] })
    });
  }
  return codexRecordFingerprint(record);
}

function codexSessionMetaIds(record: any) {
  if (record?.type !== "session_meta") return [];
  const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
  return [payload.id, payload.session_id]
    .filter((value) => value != null && String(value))
    .map((value) => String(value));
}

function copiedParentRecordPrefix(records: any[], parentRecords: any[], parentId: any, hasTaskEnvelope: boolean) {
  if (!parentId || hasTaskEnvelope || !parentRecords.length) return new Set<any>();

  const childStart = records.findIndex((record) => record.type === "session_meta");
  const parentStart = parentRecords.findIndex((record) => record.type === "session_meta");
  if (childStart < 0 || parentStart < 0) return new Set<any>();
  const parentIdText = String(parentId);
  const copiedParentHeader = records[childStart + 1];
  if (!copiedParentHeader
    || copiedParentHeader.type !== "session_meta"
    || !codexSessionMetaIds(copiedParentHeader).includes(parentIdText)) {
    return new Set<any>();
  }
  const child = records.slice(childStart + 2);
  const parent = parentRecords.slice(parentStart + 1);
  if (child.length < 2 || parent.length < 2) return new Set<any>();
  if (codexCopyFingerprint(child[0]) !== codexCopyFingerprint(parent[0])
    || codexCopyFingerprint(child[1]) !== codexCopyFingerprint(parent[1])) {
    return new Set<any>();
  }

  let matched = 0;
  let parentCursor = 0;
  while (matched < child.length && matched < parent.length) {
    const childFingerprint = codexCopyFingerprint(child[matched]);
    let parentMatch = -1;
    for (let index = parentCursor; index < parent.length; index += 1) {
      if (codexCopyFingerprint(parent[index]) === childFingerprint) {
        parentMatch = index;
        break;
      }
    }
    if (parentMatch < 0) break;
    parentCursor = parentMatch + 1;
    matched += 1;
  }
  if (matched < 2) return new Set<any>();

  // Include the copied parent header itself, so its source-owned metadata is
  // not treated as a child record by any downstream projection.
  return new Set(records.slice(childStart + 1, childStart + matched + 2));
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

/**
 * A repeated adjacent usage event with the same cumulative snapshot cannot
 * represent another model request. Codex occasionally persists this replay
 * while resuming a rollout, so retain the first event only. Current rollouts
 * can also contain both the legacy event and the canonical usage row for one
 * response: use a shared response id when both sides record it; otherwise
 * allow only an immediately adjacent, cross-format snapshot match.
 */
function duplicateCodexTokenUsageRecords(records: any[], provenance: Map<any, CodexRecordProvenance>) {
  const duplicates = new Set<any>();
  const usageRecords = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => isCodexTokenUsageRecord(record));
  const firstByResponseId = new Map<string, string>();
  for (let index = 0; index < usageRecords.length; index += 1) {
    const currentEntry = usageRecords[index];
    const current = currentEntry.record;
    if (provenance.get(current) !== "session") continue;
    const currentResponseId = codexTokenUsageResponseId(current);
    const currentSnapshot = codexTokenUsageSnapshotFingerprint(current);
    if (currentResponseId) {
      const previousSnapshot = firstByResponseId.get(String(currentResponseId));
      if (previousSnapshot === currentSnapshot) duplicates.add(current);
      else firstByResponseId.set(String(currentResponseId), currentSnapshot);
      if (duplicates.has(current)) continue;
    }

    const previous = records[currentEntry.index - 1];
    if (!isCodexTokenUsageRecord(previous)
      || provenance.get(previous) !== "session"
      || codexTokenUsageSnapshotFingerprint(previous) !== currentSnapshot) continue;
    const previousResponseId = codexTokenUsageResponseId(previous);
    if (currentResponseId && previousResponseId && currentResponseId !== previousResponseId) continue;
    duplicates.add(current);
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
  const inheritedRecordPrefix = copiedParentRecordPrefix(records, parentRecords, parentId, hasTaskEnvelope);
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
  for (const record of inheritedRecordPrefix) {
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

/** Expose the record-level ownership decision to message normalization. */
export function classifyCodexMessageProvenance(records: any[], parentRecords: any[] = []) {
  const recordProvenance = classifyCodexRecordProvenance(records, parentRecords);
  const provenance = new Map<any, CodexMessageProvenance>();
  for (const record of records) {
    const isUserRecord = (record.type === "event_msg" && record.payload?.type === "user_message")
      || (record.type === "response_item" && record.payload?.role === "user");
    if (isUserRecord) {
      provenance.set(record, recordProvenance.get(record) === "inherited-parent-context"
        ? "inherited-parent-context"
        : "session");
    }
  }
  return provenance;
}

/** Remove only messages already marked inherited by the Codex record boundary.
 * Parent message text is intentionally not used as a deduplication key. */
export function resolveCodexInheritedContext(messages: Message[], _parentMessages: Message[]) {
  let excludedUserMessages = 0;
  const resolved = messages.flatMap((message) => {
    if (message.metadata?.provenance === "inherited-parent-context") {
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
  const bytes = readFileSync(filePath);
  const content = /\.jsonl\.zst$/i.test(String(filePath))
    ? zstdDecompressSync(bytes, { maxOutputLength: CODEX_MAX_DECOMPRESSED_ROLLOUT_BYTES }).toString("utf-8")
    : bytes.toString("utf-8");
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
            .filter((value) => value === "inherited-parent-context").length
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
    if (!title && r.type === "response_item") {
      const responseUserText = codexUserTextRecord(r);
      if (responseUserText) {
        title = responseUserText.replace(/\s+/g, " ").trim().slice(0, 120);
      }
    }
    if (isCodexTokenUsageRecord(r)) {
      if (recordProvenance.get(r) !== "session") continue;
      totalTokens += codexUsageToTokens(codexUsagePayload(r))?.total || 0;
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

  // Hybrid rollouts (observed across a Codex version transition, e.g.
  // 01a04191-...) record the same turn BOTH as a response_item user.text row
  // and as a legacy event_msg/user_message row with the same text. The
  // response_item row carries the recorded kind and turn id, so the legacy
  // duplicate is skipped by exact normalized content comparison.
  const normalizeMessageText = (value: unknown) => String(value || "").replace(/\s+/g, " ").trim();
  const recordedUserTexts = new Set<string>();
  for (const record of records) {
    if (recordProvenance.get(record) !== "session") continue;
    const text = codexUserTextRecord(record);
    if (text) recordedUserTexts.add(normalizeMessageText(text));
  }

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
      // Hybrid rollout: the same turn is also recorded as a user.text
      // response_item row; that row is richer (kind + turn id) and has
      // already been emitted (or will be) — skip the legacy duplicate.
      if (recordedUserTexts.has(normalizeMessageText(r.payload.message))) continue;
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

    // New-format user turn (recorded "user.text" kind). Rows without the
    // recorded kind carry injected context, not the user's own words.
    const responseUserText = codexUserTextRecord(r);
    if (responseUserText) {
      responseGroup = null;
      const passthrough = r.payload?.internal_chat_message_metadata_passthrough;
      const message = {
        id: r.payload.id || `msg-${idx++}`,
        sessionId,
        role: "user",
        content: responseUserText,
        thinking: null,
        toolName: null,
        toolInput: null,
        toolOutput: null,
        timestamp: ts,
        tokens: null,
        metadata: {
          images: r.payload.images || null,
          turnId: typeof passthrough?.turn_id === "string" ? passthrough.turn_id : null,
          provenance: messageProvenance.get(r) || "session"
        }
      };
      messages.push(message);
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

    if (isCodexTokenUsageRecord(r)) {
      const tokens = codexUsageToTokens(codexUsagePayload(r));
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
