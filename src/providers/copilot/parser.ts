import { readFileSync } from "node:fs";
import type { Message, RawSession, TokenUsage } from "../interface.js";
import { asNumber } from "../shared/parser.js";

type Row = Record<string, any>;

export interface CopilotUsageRecord {
  agentId: string | null;
  turnIndex: string | number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  createdAt: number;
}

interface CopilotToolCall {
  id: string;
  name: string;
  input: unknown;
  parentAgentId: string | null;
  turnId: string | null;
  timestamp: number;
  subagentId: string | null;
  subagentName: string | null;
  subagentDisplayName: string | null;
}

interface CopilotAgent {
  id: string;
  parentAgentId: string | null;
  toolCallId: string | null;
  name: string | null;
  displayName: string | null;
  timeCreated: number;
  timeUpdated: number;
}

export interface CopilotMessageBundle {
  session: RawSession;
  messages: Message[];
}

function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Row
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function stringOrNull(value: unknown) {
  const normalized = text(value).trim();
  return normalized || null;
}

function eventTime(record: Row) {
  const value = record.timestamp ?? record.time ?? row(record.data).timestamp;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function eventId(record: Row, fallback: string) {
  return stringOrNull(record.id) || fallback;
}

function recordAgentId(record: Row) {
  return stringOrNull(record.agentId) || stringOrNull(row(record.data).agentId);
}

function usageKey(agentId: string | null, turnId: unknown) {
  return `${agentId || "root"}\u0000${String(turnId ?? "")}`;
}

/**
 * Copilot records cache and reasoning values as subsets of input/output.
 * Normalize them into mutually-exclusive components before shared metrics use
 * them, so every chart can safely stack the fields.
 */
export function copilotUsageToTokens(usage: Partial<CopilotUsageRecord> | null | undefined): TokenUsage | null {
  if (!usage) return null;
  const input = asNumber(usage.inputTokens);
  const output = asNumber(usage.outputTokens);
  const reasoning = asNumber(usage.reasoningTokens);
  const cacheRead = asNumber(usage.cacheReadTokens);
  const cacheWrite = asNumber(usage.cacheWriteTokens);
  const uncachedInput = Math.max(0, input - cacheRead - cacheWrite);
  const visibleOutput = Math.max(0, output - reasoning);
  const total = uncachedInput + visibleOutput + reasoning + cacheRead + cacheWrite;
  return total || input || output || reasoning || cacheRead || cacheWrite
    ? {
      input: uncachedInput,
      output: visibleOutput,
      reasoning,
      cache: { read: cacheRead, write: cacheWrite },
      total
    }
    : null;
}

function fallbackAssistantTokens(data: Row): TokenUsage | null {
  const output = asNumber(data.outputTokens);
  return output
    ? { input: 0, output, reasoning: 0, cache: { read: 0, write: 0 }, total: output }
    : null;
}

function collectToolCalls(records: Row[]) {
  const calls = new Map<string, CopilotToolCall>();
  for (const record of records) {
    if (record.type !== "tool.execution_start") continue;
    const data = row(record.data);
    const id = stringOrNull(data.toolCallId);
    if (!id) continue;
    calls.set(id, {
      id,
      name: stringOrNull(data.toolName) || "tool",
      input: data.arguments ?? null,
      parentAgentId: recordAgentId(record),
      turnId: stringOrNull(data.turnId),
      timestamp: eventTime(record),
      subagentId: null,
      subagentName: null,
      subagentDisplayName: null
    });
  }
  return calls;
}

function collectAgents(records: Row[], calls: Map<string, CopilotToolCall>) {
  const agents = new Map<string, CopilotAgent>();
  for (const record of records) {
    if (record.type !== "subagent.started") continue;
    const data = row(record.data);
    const toolCallId = stringOrNull(data.toolCallId);
    const id = recordAgentId(record) || toolCallId;
    if (!id) continue;
    const call = toolCallId ? calls.get(toolCallId) : null;
    const timestamp = eventTime(record);
    const agent: CopilotAgent = {
      id,
      parentAgentId: call?.parentAgentId || null,
      toolCallId,
      name: stringOrNull(data.agentName),
      displayName: stringOrNull(data.agentDisplayName),
      timeCreated: timestamp,
      timeUpdated: timestamp
    };
    agents.set(id, agent);
    if (call) {
      call.subagentId = id;
      call.subagentName = agent.name;
      call.subagentDisplayName = agent.displayName;
    }
  }

  for (const record of records) {
    const agentId = recordAgentId(record);
    if (!agentId || !agents.has(agentId)) continue;
    const agent = agents.get(agentId)!;
    const timestamp = eventTime(record);
    if (timestamp && (!agent.timeCreated || timestamp < agent.timeCreated)) agent.timeCreated = timestamp;
    if (timestamp > agent.timeUpdated) agent.timeUpdated = timestamp;
  }
  return agents;
}

function safeToolResult(value: unknown) {
  if (typeof value === "string") return value;
  const source = row(value);
  // detailedContent can carry provider-only diagnostics. The normal content
  // field is the visible tool result and is sufficient for the transcript.
  return text(source.content);
}

function usageQueues(usages: CopilotUsageRecord[]) {
  const queues = new Map<string, CopilotUsageRecord[]>();
  for (const usage of [...usages].sort((left, right) => left.createdAt - right.createdAt)) {
    const key = usageKey(usage.agentId, usage.turnIndex);
    const queue = queues.get(key) || [];
    queue.push(usage);
    queues.set(key, queue);
  }
  return queues;
}

function takeUsage(queues: Map<string, CopilotUsageRecord[]>, agentId: string | null, turnId: unknown) {
  const queue = queues.get(usageKey(agentId, turnId));
  return queue?.shift() || null;
}

/** Parse a Copilot CLI event log without retaining malformed individual lines. */
export function parseCopilotSession(filePath: string): Row[] {
  const records: Row[] = [];
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) records.push(parsed);
    } catch (error) {
      console.warn("Skipping malformed Copilot CLI event line:", filePath, error);
    }
  }
  return records;
}

export function extractCopilotSessionId(records: Row[], fallbackId: string) {
  const start = records.find((record) => record.type === "session.start");
  return stringOrNull(row(start?.data).sessionId) || fallbackId;
}

export function extractCopilotMeta(records: Row[], fallbackId: string): RawSession {
  const id = extractCopilotSessionId(records, fallbackId);
  const rootUser = records.find((record) => record.type === "user.message" && !recordAgentId(record));
  const rootAssistant = records.find((record) => record.type === "assistant.message" && !recordAgentId(record));
  const start = records.find((record) => record.type === "session.start");
  const startData = row(start?.data);
  const times = records.map(eventTime).filter(Boolean);
  const messageCount = records.filter((record) => (
    (record.type === "user.message" || record.type === "assistant.message")
    && record.type !== "system.message"
  )).length;
  const outputTokens = records
    .filter((record) => record.type === "assistant.message")
    .reduce((total, record) => total + asNumber(row(record.data).outputTokens), 0);
  const model = stringOrNull(row(rootAssistant?.data).model);
  const metadata: Record<string, unknown> = {};
  if (model) metadata.model = model;
  if (stringOrNull(startData.copilotVersion)) metadata.copilotVersion = stringOrNull(startData.copilotVersion);
  if (stringOrNull(startData.contextTier)) metadata.contextTier = stringOrNull(startData.contextTier);

  return {
    id,
    provider: "copilot",
    parentId: null,
    title: stringOrNull(row(rootUser?.data).content),
    directory: null,
    timeCreated: times.length ? Math.min(...times) : 0,
    timeUpdated: times.length ? Math.max(...times) : 0,
    messageCount,
    tokenCount: outputTokens || null,
    metadata: Object.keys(metadata).length ? metadata : null
  };
}

/**
 * Convert persisted Copilot events into normalized messages. Provider-managed
 * system, transformed, encrypted, and opaque reasoning fields are excluded:
 * they are not a trustworthy, user-visible session transcript surface.
 */
export function copilotRecordsToMessages(
  records: Row[],
  rootSessionId: string,
  usages: CopilotUsageRecord[] = []
): Message[] {
  const calls = collectToolCalls(records);
  const agents = collectAgents(records, calls);
  const queues = usageQueues(usages);
  const messages: Message[] = [];
  const sessionFor = (agentId: string | null) => agentId && agents.has(agentId) ? agentId : rootSessionId;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const data = row(record.data);
    const agentId = recordAgentId(record);
    const sessionId = sessionFor(agentId);
    const timestamp = eventTime(record);
    const id = eventId(record, `${sessionId}:event:${index}`);
    const agent = agentId ? agents.get(agentId) : null;

    if (record.type === "user.message") {
      messages.push({
        id,
        sessionId,
        role: "user",
        content: text(data.content),
        thinking: null,
        toolName: null,
        toolInput: null,
        toolOutput: null,
        timestamp,
        tokens: null,
        metadata: agent ? { agentId: agent.id, agent: agent.displayName || agent.name } : null
      });
      continue;
    }

    if (record.type === "assistant.message") {
      const turnId = stringOrNull(data.turnId);
      const usage = takeUsage(queues, agentId, turnId);
      messages.push({
        id,
        sessionId,
        role: "assistant",
        content: text(data.content),
        thinking: null,
        toolName: null,
        toolInput: null,
        toolOutput: null,
        timestamp,
        tokens: copilotUsageToTokens(usage) || fallbackAssistantTokens(data),
        metadata: {
          ...(stringOrNull(data.model) ? { model: stringOrNull(data.model), provider: "github-copilot" } : {}),
          ...(turnId ? { turnId } : {}),
          ...(agent ? {
            agentId: agent.id,
            agent: agent.displayName || agent.name,
            parentToolCallId: stringOrNull(data.parentToolCallId)
          } : {})
        }
      });
      continue;
    }

    if (record.type === "tool.execution_start") {
      const callId = stringOrNull(data.toolCallId);
      const call = callId ? calls.get(callId) : null;
      const ownerId = call?.parentAgentId || agentId;
      const ownerSessionId = sessionFor(ownerId);
      messages.push({
        id: callId || id,
        sessionId: ownerSessionId,
        role: "tool",
        content: "",
        thinking: null,
        toolName: call?.name || stringOrNull(data.toolName) || "tool",
        toolInput: call?.input ?? data.arguments ?? null,
        toolOutput: null,
        timestamp,
        tokens: null,
        metadata: {
          ...(callId ? { callId } : {}),
          ...(call?.turnId ? { turnId: call.turnId } : {}),
          ...(call?.subagentId ? {
            subagent: true,
            agentId: call.subagentId,
            agent: call.subagentDisplayName || call.subagentName,
            title: call.subagentDisplayName || call.subagentName
          } : {})
        }
      });
      continue;
    }

    if (record.type === "tool.execution_complete") {
      const callId = stringOrNull(data.toolCallId);
      const call = callId ? calls.get(callId) : null;
      const ownerId = call?.parentAgentId || agentId;
      messages.push({
        id,
        sessionId: sessionFor(ownerId),
        role: "tool",
        content: safeToolResult(data.result),
        thinking: null,
        toolName: null,
        toolInput: null,
        toolOutput: safeToolResult(data.result),
        timestamp,
        tokens: null,
        metadata: {
          ...(callId ? { toolUseId: callId } : {}),
          ...(call?.turnId ? { turnId: call.turnId } : {}),
          ...(data.success === false ? { isError: true, status: "error" } : {})
        }
      });
      continue;
    }
  }
  return messages;
}

/**
 * Copilot stores child-agent events inline. Represent those provider-owned
 * agent IDs as view-only bundles so the shared linked-session renderer can
 * place each branch at the originating task tool without inventing a resume
 * target or a second provider session.
 */
export function buildCopilotMessageBundles(
  rootSession: RawSession,
  records: Row[],
  usages: CopilotUsageRecord[] = []
): CopilotMessageBundle[] {
  const calls = collectToolCalls(records);
  const agents = collectAgents(records, calls);
  const messages = copilotRecordsToMessages(records, rootSession.id, usages);
  const bySession = new Map<string, Message[]>();
  for (const message of messages) {
    const bucket = bySession.get(message.sessionId) || [];
    bucket.push(message);
    bySession.set(message.sessionId, bucket);
  }
  const bundles: CopilotMessageBundle[] = [{
    session: rootSession,
    messages: bySession.get(rootSession.id) || []
  }];

  for (const agent of [...agents.values()].sort((left, right) => left.timeCreated - right.timeCreated || left.id.localeCompare(right.id))) {
    const title = agent.displayName || agent.name || "Copilot subagent";
    bundles.push({
      session: {
        id: agent.id,
        provider: "copilot",
        parentId: agent.parentAgentId || rootSession.id,
        title,
        directory: rootSession.directory,
        timeCreated: agent.timeCreated || rootSession.timeCreated,
        timeUpdated: agent.timeUpdated || agent.timeCreated || rootSession.timeUpdated,
        messageCount: (bySession.get(agent.id) || []).filter((message) => (
          message.role === "user" || message.role === "assistant"
        )).length,
        tokenCount: null,
        metadata: {
          embedded: true,
          agentId: agent.id,
          agentName: agent.name,
          agentDisplayName: agent.displayName,
          aliases: [agent.toolCallId].filter(Boolean)
        }
      },
      messages: bySession.get(agent.id) || []
    });
  }
  return bundles;
}
