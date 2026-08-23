import type { Message, TokenUsage } from "../interface.js";
import { asNumber } from "./parser.js";
import { cloneTokenUsage, sumTokenUsage } from "./token-usage.js";

type Row = Record<string, any>;

export type AgentLoopEventKind = "reasoning" | "text" | "tool";

/**
 * Provider-neutral event in a coding-agent loop. Providers first normalize
 * their transcripts to Message; this layer then joins response fragments,
 * tool calls, and tool results without knowing the source schema.
 */
export interface AgentLoopEvent {
  id: string;
  sourceMessageId: string;
  kind: AgentLoopEventKind;
  tool: string | null;
  text: string;
  input: unknown;
  output: unknown;
  status: string | null;
  metadata: Row | null;
  timeStart: number;
  timeEnd: number;
}

/** A single normalized user or agent turn in the common coding-agent loop. */
export interface AgentLoopTurn {
  id: string;
  sessionId: string;
  role: string;
  timeCreated: number;
  data: Row;
  events: AgentLoopEvent[];
}

export interface AgentLoop {
  turns: AgentLoopTurn[];
}

function asRow(value: unknown): Row {
  return value && typeof value === "object" ? value as Row : {};
}

function messageData(message: Message): Row {
  const metadata = asRow(message.metadata);
  const model = metadata.model;
  const metadataRequests = Array.isArray(metadata.tokenRequests)
    ? metadata.tokenRequests
      .filter((tokens: unknown) => Boolean(tokens) && typeof tokens === "object")
      .map((tokens: TokenUsage) => cloneTokenUsage(tokens))
    : [];
  const tokenRequests = metadataRequests.length > 0
    ? metadataRequests
    : message.tokens
      ? [cloneTokenUsage(message.tokens)]
      : [];
  const tokens = tokenRequests.length ? sumTokenUsage(tokenRequests) : null;
  const {
    tokenRequests: _tokenRequests,
    tokenRequestCount: _tokenRequestCount,
    tokens: _metadataTokens,
    ...messageMetadata
  } = metadata;
  return {
    role: message.role,
    time: { created: message.timestamp },
    tokens,
    tokenRequestCount: tokenRequests.length,
    tokenRequests,
    ...messageMetadata,
    model: typeof model === "string"
      ? { modelID: model, providerID: metadata.provider || null }
      : model || null
  };
}

function messageEvents(message: Message, index: number): AgentLoopEvent[] {
  const events: AgentLoopEvent[] = [];
  const prefix = message.id || `${message.sessionId}:message:${index}`;
  const metadata = asRow(message.metadata);

  if (message.thinking) {
    events.push({
      id: `${prefix}:reasoning`,
      sourceMessageId: prefix,
      kind: "reasoning",
      tool: null,
      text: message.thinking,
      input: null,
      output: null,
      status: null,
      metadata: null,
      timeStart: message.timestamp,
      timeEnd: message.timestamp
    });
  }

  if (message.role === "tool" || message.toolName) {
    const isError = Boolean(metadata.isError) || metadata.status === "error";
    events.push({
      id: `${prefix}:tool`,
      sourceMessageId: prefix,
      kind: "tool",
      tool: message.toolName || "tool",
      text: "",
      input: message.toolInput,
      output: message.toolOutput ?? message.content ?? "",
      status: isError ? "error" : "completed",
      metadata: message.metadata ? asRow(message.metadata) : null,
      timeStart: message.timestamp,
      timeEnd: message.timestamp
    });
  } else if (message.content) {
    events.push({
      id: `${prefix}:text`,
      sourceMessageId: prefix,
      kind: "text",
      tool: null,
      text: message.content,
      input: null,
      output: null,
      status: null,
      metadata: null,
      timeStart: message.timestamp,
      timeEnd: message.timestamp
    });
  }

  return events;
}

function responseGroupId(message: Message) {
  const metadata = asRow(message.metadata);
  const value = metadata.turnId ?? metadata.responseGroupId;
  return typeof value === "string" && value ? value : null;
}

function mergeTurnData(target: Row, message: Message) {
  const incoming = messageData(message);
  const incomingRequests = Array.isArray(incoming.tokenRequests)
    ? incoming.tokenRequests.filter((tokens: any) => tokens && typeof tokens === "object")
    : incoming.tokens && typeof incoming.tokens === "object"
      ? [incoming.tokens]
      : [];
  if (incomingRequests.length > 0) {
    const existingRequests = Array.isArray(target.tokenRequests)
      ? target.tokenRequests.filter((tokens: any) => tokens && typeof tokens === "object")
      : target.tokens && typeof target.tokens === "object"
        ? [target.tokens]
        : [];
    const tokenRequests = [...existingRequests, ...incomingRequests] as TokenUsage[];
    target.tokenRequests = tokenRequests;
    target.tokenRequestCount = tokenRequests.length;
    target.tokens = sumTokenUsage(tokenRequests);
  }
  if (!target.model && incoming.model) target.model = incoming.model;
  for (const [key, value] of Object.entries(incoming)) {
    if (["tokens", "tokenRequestCount", "tokenRequests"].includes(key)) continue;
    if (target[key] == null && value != null) target[key] = value;
  }
}

/**
 * Build the common Agent Loop from normalized provider messages.
 *
 * A tool result is folded into its call, response fragments with a shared
 * response id form one turn, and a tool-only continuation remains attached to
 * the preceding agent turn. Those are the shared semantics behind the
 * conversation, Tree, Metrics, and Runtime views.
 */
export function buildAgentLoop(messages: Message[]): AgentLoop {
  const turns: AgentLoopTurn[] = [];
  const toolEventsById = new Map<string, AgentLoopEvent>();
  let previousGroupId: string | null = null;
  let previousGroupTurn: AgentLoopTurn | null = null;
  let activeAgentTurn: AgentLoopTurn | null = null;

  messages.forEach((message, index) => {
    const metadata = asRow(message.metadata);
    const role = String(message.role || "").toLowerCase();
    const toolUseId = metadata.toolUseId;
    if (role === "tool" && typeof toolUseId === "string" && toolUseId) {
      const call = toolEventsById.get(toolUseId);
      if (call) {
        call.output = message.toolOutput ?? message.content ?? "";
        call.status = metadata.isError ? "error" : "completed";
        call.timeEnd = Math.max(call.timeEnd, asNumber(message.timestamp));
        return;
      }
    }

    const id = message.id || `${message.sessionId}:message:${index}`;
    const events = messageEvents(message, index);
    const toolEvent = events.find((event) => event.kind === "tool");
    if (toolEvent) {
      toolEventsById.set(id, toolEvent);
      const callId = metadata.callId;
      if (typeof callId === "string" && callId) toolEventsById.set(callId, toolEvent);
    }

    const groupId = responseGroupId(message);
    const groupable = Boolean(groupId) && ["assistant", "tool"].includes(role);
    const groupedWithPrevious = groupable && previousGroupTurn && previousGroupId === groupId;
    const implicitContinuation = Boolean(activeAgentTurn) && role === "tool";
    const continuationTarget = groupedWithPrevious
      ? previousGroupTurn
      : implicitContinuation
        ? activeAgentTurn
        : null;

    if (continuationTarget) {
      continuationTarget.events.push(...events);
      continuationTarget.timeCreated = Math.min(
        continuationTarget.timeCreated || message.timestamp,
        message.timestamp || continuationTarget.timeCreated
      );
      mergeTurnData(continuationTarget.data, message);
      if (groupable) {
        previousGroupId = groupId;
        previousGroupTurn = continuationTarget;
      }
      return;
    }

    const turn: AgentLoopTurn = {
      id,
      sessionId: message.sessionId,
      role: groupable ? "assistant" : role || "unknown",
      data: messageData(message),
      timeCreated: asNumber(message.timestamp),
      events
    };
    turns.push(turn);
    activeAgentTurn = ["assistant", "tool"].includes(role) ? turn : null;
    previousGroupId = groupable ? groupId : null;
    previousGroupTurn = groupable ? turn : null;
  });

  return { turns };
}
