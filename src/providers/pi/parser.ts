import { readFileSync } from "node:fs";
import path from "node:path";
import type { Message, RawSession, TokenUsage } from "../interface.js";

type Row = Record<string, any>;

export function parsePiSession(filePath: string): Row[] {
  const records: Row[] = [];
  const lines = readFileSync(filePath, "utf-8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && !Array.isArray(record)) {
        records.push(record);
      }
    } catch (error) {
      throw new Error(`Malformed Pi session line ${index + 1} in ${filePath}`, { cause: error });
    }
  }
  return records;
}

function timestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = typeof value === "string" ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function thinkingContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((block) => block?.type === "thinking" && typeof block.thinking === "string")
    .map((block) => block.thinking)
    .join("\n");
}

function imageCount(value: unknown): number {
  return Array.isArray(value)
    ? value.filter((block) => block?.type === "image").length
    : 0;
}

function toolCalls(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((block) => block?.type === "toolCall" && typeof block.id === "string")
    : [];
}

export function piUsageToTokens(usage: unknown): TokenUsage | null {
  const value = usage && typeof usage === "object" ? usage as Row : null;
  if (!value) return null;
  const input = Number(value.input) || 0;
  const output = Number(value.output) || 0;
  const reasoning = Number(value.reasoning) || 0;
  const cacheRead = Number(value.cacheRead) || 0;
  const cacheWrite = Number(value.cacheWrite) || 0;
  const total = Number(value.totalTokens) || input + output + cacheRead + cacheWrite;
  return {
    input,
    // Pi reports reasoning as a subset of output. Keep components exclusive
    // so shared metrics and stacked charts retain the source total.
    output: Math.max(0, output - reasoning),
    reasoning,
    total,
    cache: { read: cacheRead, write: cacheWrite }
  };
}

function entryTimestamp(entry: Row) {
  return timestamp(entry.message?.timestamp) || timestamp(entry.timestamp);
}

function sessionHeader(records: Row[]): Row | null {
  return records.find((record) => record.type === "session") || null;
}

export function activePiEntries(records: Row[]): Row[] {
  const header = sessionHeader(records);
  const entries = records.filter((record) => record.type !== "session" && typeof record.id === "string");
  if (!entries.length || Number(header?.version || 1) < 2 || entries.some((entry) => !("parentId" in entry))) {
    return entries;
  }

  const byId = new Map(entries.map((entry) => [String(entry.id), entry]));
  const branch: Row[] = [];
  const seen = new Set<string>();
  let current: Row | undefined = entries.at(-1);
  while (current && !seen.has(String(current.id))) {
    branch.push(current);
    seen.add(String(current.id));
    current = current.parentId === null ? undefined : byId.get(String(current.parentId));
  }
  return branch.reverse();
}

function parentSessionId(parentSession: unknown): string | null {
  if (typeof parentSession !== "string" || !parentSession.trim()) return null;
  const stem = path.basename(parentSession).replace(/\.jsonl$/i, "");
  const uuid = stem.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return uuid?.[0] || null;
}

export function piRecordsToMessages(records: Row[], sessionId: string): Message[] {
  const messages: Message[] = [];
  const calls = new Map<string, Message>();

  for (const entry of activePiEntries(records)) {
    const eventTime = entryTimestamp(entry);
    if (entry.type === "message") {
      const source = entry.message || {};
      if (source.role === "user") {
        messages.push({
          id: String(entry.id), sessionId, role: "user", content: textContent(source.content),
          thinking: null, toolName: null, toolInput: null, toolOutput: null,
          timestamp: eventTime, tokens: null,
          metadata: { imageCount: imageCount(source.content), provenance: "session" }
        });
        continue;
      }

      if (source.role === "assistant") {
        const turnId = String(entry.id);
        const assistant: Message = {
          id: turnId,
          sessionId,
          role: "assistant",
          content: textContent(source.content),
          thinking: thinkingContent(source.content) || null,
          toolName: null,
          toolInput: null,
          toolOutput: null,
          timestamp: eventTime,
          tokens: piUsageToTokens(source.usage),
          metadata: {
            model: source.model || null,
            provider: source.provider || null,
            api: source.api || null,
            stopReason: source.stopReason || null,
            errorMessage: source.errorMessage || null,
            turnId,
            provenance: "session"
          }
        };
        messages.push(assistant);
        for (const [index, call] of toolCalls(source.content).entries()) {
          const callId = String(call.id);
          const tool: Message = {
            id: callId || `${turnId}:tool:${index}`,
            sessionId,
            role: "tool",
            content: "",
            thinking: null,
            toolName: String(call.name || "tool"),
            toolInput: call.arguments ?? null,
            toolOutput: null,
            timestamp: eventTime,
            tokens: null,
            metadata: { callId, status: "unknown", turnId, provenance: "session" }
          };
          messages.push(tool);
          calls.set(callId, tool);
        }
        continue;
      }

      if (source.role === "toolResult") {
        const callId = String(source.toolCallId || "");
        const output = textContent(source.content);
        const existing = calls.get(callId);
        if (existing) {
          existing.content = output;
          existing.toolOutput = output;
          existing.timestamp = eventTime;
          existing.metadata = {
            ...existing.metadata,
            status: source.isError ? "error" : "completed",
            isError: source.isError === true,
            resultTimestamp: eventTime,
            details: source.details ?? null
          };
        } else {
          messages.push({
            id: String(entry.id), sessionId, role: "tool", content: output,
            thinking: null, toolName: String(source.toolName || "tool"),
            toolInput: null, toolOutput: output, timestamp: eventTime, tokens: null,
            metadata: { callId, status: source.isError ? "error" : "completed", isError: source.isError === true, provenance: "session" }
          });
        }
        continue;
      }

      if (source.role === "bashExecution") {
        messages.push({
          id: String(entry.id), sessionId, role: "tool", content: String(source.output || ""),
          thinking: null, toolName: "bash", toolInput: { command: source.command || "" },
          toolOutput: String(source.output || ""), timestamp: eventTime, tokens: null,
          metadata: {
            status: source.exitCode === 0 && !source.cancelled ? "completed" : "error",
            isError: source.exitCode !== 0 || source.cancelled === true,
            exitCode: source.exitCode ?? null,
            cancelled: source.cancelled === true,
            truncated: source.truncated === true,
            fullOutputPath: source.fullOutputPath || null,
            provenance: "session"
          }
        });
      }

      // v3 format: extensions inject context as `message` entries with role
      // "custom" (v2 called it "hookMessage"; current Pi renamed the role on
      // migration). The official AgentMessage union includes CustomMessage, so
      // both spellings are valid session records. Mirror the custom_message
      // entry rule: `display` is a boolean gate and only the recorded
      // `display === true` value joins the conversation view; any other value
      // (false, missing, or a truthy non-boolean) stays out of the read view.
      // The rendered role is "system", the established viewer convention for
      // custom context, not a provider-recorded role.
      if (source.role === "custom" || source.role === "hookMessage") {
        if (source.display !== true) continue;
        messages.push({
          id: String(entry.id), sessionId, role: "system", content: textContent(source.content),
          thinking: null, toolName: null, toolInput: null, toolOutput: null,
          timestamp: eventTime, tokens: null,
          metadata: {
            customType: source.customType || null,
            display: source.display ?? null,
            details: source.details ?? null,
            legacyRole: source.role === "hookMessage" ? "hookMessage" : null,
            provenance: "session"
          }
        });
        continue;
      }
      continue;
    }

    if (entry.type === "custom_message" && entry.display === true) {
      messages.push({
        id: String(entry.id), sessionId, role: "system", content: textContent(entry.content),
        thinking: null, toolName: null, toolInput: null, toolOutput: null,
        timestamp: eventTime, tokens: null,
        metadata: { customType: entry.customType || null, details: entry.details ?? null, provenance: "session" }
      });
      continue;
    }

    if (entry.type === "compaction" || entry.type === "branch_summary") {
      messages.push({
        id: String(entry.id), sessionId, role: "system", content: String(entry.summary || ""),
        thinking: null, toolName: null, toolInput: null, toolOutput: null,
        timestamp: eventTime, tokens: null,
        metadata: {
          type: entry.type,
          fromId: entry.fromId || null,
          firstKeptEntryId: entry.firstKeptEntryId || null,
          tokensBefore: Number(entry.tokensBefore) || null,
          retainedTailCount: Array.isArray(entry.retainedTail) ? entry.retainedTail.length : null,
          fromHook: typeof entry.fromHook === "boolean" ? entry.fromHook : null,
          // The protocol surface (context.compaction events + metadata-only
          // artifacts) is the canonical representation of compaction; this
          // system message remains as a read/compatibility view.
          provenance: "session",
          compatibility: true,
          protocolKind: "context.compaction"
        }
      });
    }
  }

  return messages;
}

export function extractPiMeta(records: Row[], fallbackId = ""): RawSession {
  const header = sessionHeader(records) || {};
  const sessionId = String(header.id || fallbackId);
  const active = activePiEntries(records);
  const messages = piRecordsToMessages(records, sessionId);
  const latestInfo = [...records].reverse().find((entry) => entry.type === "session_info");
  const sessionName = typeof latestInfo?.name === "string" ? latestInfo.name.trim() : "";
  const firstUser = messages.find((message) => message.role === "user" && message.content.trim());
  const times = [timestamp(header.timestamp), ...records.map((record) => entryTimestamp(record))].filter(Boolean);
  // Authoritative session token total: sum of every recorded component total
  // (totalTokens field) across ALL file entries, matching Pi's own billed
  // session total (agent-session.js getSessionStats / usage-totals.js
  // getUsageCostBreakdown): assistant usage + nested toolResult usage +
  // compaction/branch_summary summary usage, including abandoned/history
  // branches. retainedTail copies are never counted (they are embedded
  // message copies, not recorded entries).
  const tokenCount = piRecordedUsageRecords(records).reduce(
    (sum, entry) => sum + (piUsageToTokens(piRecordedUsage(entry))?.total || 0), 0
  );
  return {
    id: sessionId,
    provider: "pi",
    parentId: parentSessionId(header.parentSession),
    title: sessionName || firstUser?.content.replace(/\s+/g, " ").trim().slice(0, 120) || null,
    directory: typeof header.cwd === "string" && header.cwd ? header.cwd : null,
    timeCreated: timestamp(header.timestamp) || (times.length ? Math.min(...times) : 0),
    timeUpdated: times.length ? Math.max(...times) : 0,
    messageCount: messages.length,
    tokenCount: tokenCount || null,
    metadata: {
      version: Number(header.version) || 1,
      parentSessionPath: typeof header.parentSession === "string" ? header.parentSession : null,
      activeLeafId: active.at(-1)?.id || null,
      aliases: sessionName ? [sessionName] : []
    }
  };
}

/**
 * Narrow view kept for compatibility: assistant-only usage records on the
 * active branch. Not Pi's billed session total — use
 * piRecordedUsageRecords for that.
 */
export function piAssistantUsageRecords(records: Row[]) {
  return activePiEntries(records).filter(
    (entry) => entry.type === "message" && entry.message?.role === "assistant" && entry.message?.usage
  );
}

/**
 * True when a Pi record carries usage in Pi's billed session-total scope
 * (agent-session.js getSessionStats / usage-totals.js getUsageCostBreakdown):
 * assistant messages, toolResult messages with nested-LLM usage, and
 * compaction/branch_summary entries (summary-generation usage).
 */
export function piRecordedUsageRecord(entry: Row): boolean {
  if (entry?.type === "message") {
    const role = entry.message?.role;
    return (role === "assistant" || role === "toolResult") && Boolean(entry.message?.usage);
  }
  return (entry?.type === "compaction" || entry?.type === "branch_summary") && Boolean(entry?.usage);
}

/**
 * All recorded usage-bearing records in the file, matching Pi's own billed
 * session total. Pi's getSessionStats aggregates over ALL session entries
 * (including history that was compacted away and abandoned/history branches),
 * not just the active branch. Only recorded component totals (the
 * totalTokens field) are surfaced; no origin slices are inferred, and
 * retainedTail embedded message copies are never counted as separate entries.
 */
export function piRecordedUsageRecords(records: Row[]) {
  return records.filter(piRecordedUsageRecord);
}

/** Recorded usage of one Pi record: message usage or entry-level summary usage. */
export function piRecordedUsage(entry: Row): unknown {
  return entry?.type === "message" ? entry.message?.usage : entry?.usage;
}
