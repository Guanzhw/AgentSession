import { readFileSync } from "node:fs";
import type { Message, RawSession, TokenUsage } from "../interface.js";

export type OpenClawRecord = Record<string, any>;

function timestamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = typeof value === "string" ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Event time in Unix milliseconds for one OpenClaw record (message or envelope timestamp). */
export function openClawRecordTimestamp(record: OpenClawRecord): number {
  return timestamp(record.message?.timestamp) || timestamp(record.timestamp);
}

function textContent(value: unknown) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

export function openClawUsageToTokens(value: unknown): TokenUsage | null {
  const usage = value && typeof value === "object" ? value as OpenClawRecord : null;
  if (!usage) return null;
  const sourceInput = Number(usage.input) || 0;
  const sourceOutput = Number(usage.output) || 0;
  const reasoning = Number(usage.reasoningTokens) || 0;
  const cacheRead = Number(usage.cacheRead) || 0;
  const cacheWrite = Number(usage.cacheWrite) || 0;
  return {
    // OpenClaw records uncached input and cache reads/writes as independent
    // components; provider totals equal input + output + cache components.
    input: sourceInput,
    output: Math.max(0, sourceOutput - reasoning),
    reasoning,
    total: Number(usage.totalTokens) || sourceInput + sourceOutput + cacheRead + cacheWrite,
    cache: { read: cacheRead, write: cacheWrite }
  };
}

export function parseOpenClawSession(filePath: string): OpenClawRecord[] {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .flatMap((line, index) => {
      if (!line.trim()) return [];
      try {
        const record = JSON.parse(line);
        return record && typeof record === "object" && !Array.isArray(record) ? [record] : [];
      } catch (error) {
        throw new Error(`Malformed OpenClaw session line ${index + 1} in ${filePath}`, { cause: error });
      }
    });
}

export function activeOpenClawRecords(records: OpenClawRecord[]) {
  const events = records.filter((record) => record.type !== "session" && typeof record.id === "string");
  if (!events.length || events.some((record) => !("parentId" in record))) return events;
  const byId = new Map(events.map((record) => [String(record.id), record]));
  const branch: OpenClawRecord[] = [];
  const seen = new Set<string>();
  let current: OpenClawRecord | undefined = events.at(-1);
  while (current && !seen.has(String(current.id))) {
    branch.push(current);
    seen.add(String(current.id));
    current = current.parentId == null ? undefined : byId.get(String(current.parentId));
  }
  return branch.reverse();
}

export function openClawRecordsToMessages(records: OpenClawRecord[], sessionId: string): Message[] {
  const messages: Message[] = [];
  const calls = new Map<string, Message>();
  for (const record of activeOpenClawRecords(records)) {
    if (record.type !== "message") continue;
    const source = record.message || {};
    const eventTime = timestamp(source.timestamp) || timestamp(record.timestamp);
    if (source.role === "user") {
      messages.push({
        id: String(record.id), sessionId, role: "user", content: textContent(source.content),
        thinking: null, toolName: null, toolInput: null, toolOutput: null,
        timestamp: eventTime, tokens: null, metadata: { provenance: "session" }
      });
      continue;
    }
    if (source.role === "assistant") {
      const turnId = String(record.id);
      const thinking = Array.isArray(source.content)
        ? source.content.filter((block: any) => block?.type === "thinking").map((block: any) => block.thinking || "").join("\n")
        : "";
      messages.push({
        id: turnId, sessionId, role: "assistant", content: textContent(source.content),
        thinking: thinking || null, toolName: null, toolInput: null, toolOutput: null,
        timestamp: eventTime, tokens: openClawUsageToTokens(source.usage),
        metadata: {
          model: source.model || null,
          provider: source.provider || null,
          api: source.api || null,
          stopReason: source.stopReason || null,
          responseId: source.responseId || null,
          turnId,
          provenance: "session"
        }
      });
      for (const [index, call] of (Array.isArray(source.content)
        ? source.content.filter((block: any) => block?.type === "toolCall")
        : []).entries()) {
        const callId = String(call.id || `${turnId}:tool:${index}`);
        const tool: Message = {
          id: callId, sessionId, role: "tool", content: "",
          thinking: null, toolName: String(call.name || "tool"),
          toolInput: call.arguments ?? null, toolOutput: null,
          timestamp: eventTime, tokens: null,
          metadata: { callId, turnId, status: "unknown", provenance: "session" }
        };
        messages.push(tool);
        calls.set(callId, tool);
      }
      continue;
    }
    if (source.role === "toolResult") {
      const callId = String(source.toolCallId || "");
      const output = textContent(source.content);
      const tool = calls.get(callId);
      if (tool) {
        tool.content = output;
        tool.toolOutput = output;
        tool.timestamp = eventTime;
        tool.metadata = {
          ...tool.metadata,
          status: source.isError ? "error" : "completed",
          isError: source.isError === true,
          details: source.details ?? null
        };
      } else {
        messages.push({
          id: String(record.id), sessionId, role: "tool", content: output,
          thinking: null, toolName: String(source.toolName || "tool"),
          toolInput: null, toolOutput: output, timestamp: eventTime, tokens: null,
          metadata: { callId, status: source.isError ? "error" : "completed", isError: source.isError === true, provenance: "session" }
        });
      }
    }
  }
  return messages;
}

export function extractOpenClawMeta(
  records: OpenClawRecord[],
  fallbackId: string,
  agentId: string,
  registry: Record<string, any> | null = null
): RawSession {
  const header = records.find((record) => record.type === "session") || {};
  const sessionId = String(header.id || fallbackId);
  const messages = openClawRecordsToMessages(records, sessionId);
  const times = messages.map((message) => message.timestamp).filter(Boolean);
  const firstUser = messages.find((message) => message.role === "user");
  return {
    id: sessionId,
    provider: "openclaw",
    parentId: typeof registry?.spawnedBy === "string" ? registry.spawnedBy : null,
    title: registry?.displayName || registry?.label || registry?.title || firstUser?.content.slice(0, 120) || null,
    directory: header.cwd || registry?.cwd || null,
    timeCreated: Number(registry?.sessionStartedAt) || timestamp(header.timestamp) || (times.length ? Math.min(...times) : 0),
    timeUpdated: Number(registry?.updatedAt) || (times.length ? Math.max(...times) : timestamp(header.timestamp)),
    messageCount: messages.length,
    tokenCount: messages.reduce((sum, message) => sum + Number(message.tokens?.total || 0), 0) || null,
    metadata: {
      agentId,
      sessionKey: registry?.sessionKey || null,
      model: registry?.model || null,
      modelProvider: registry?.modelProvider || null,
      contextTokens: Number(registry?.contextTokens) || null
    }
  };
}

export function openClawAssistantUsageRecords(records: OpenClawRecord[]) {
  return activeOpenClawRecords(records).filter(
    (record) => record.type === "message" && record.message?.role === "assistant" && record.message?.usage
  );
}
