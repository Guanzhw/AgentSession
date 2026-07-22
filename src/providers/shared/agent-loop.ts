import type { Message, TokenUsage } from "../interface.js";
import { asNumber } from "./parser.js";

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

export interface AgentLoopTraceSpan {
  id: string;
  name: string;
  category: "reasoning" | "text" | "tool" | "mcp" | "agent" | "skill" | "lsp";
  mcpServer?: string;
  timeStart: number;
  timeEnd: number;
  duration: number;
  status: string | null;
  input: string | null;
  output: string | null;
  title: string | null;
}

export interface AgentLoopTraceStep {
  messageId: string;
  agent: string | null;
  model: string | null;
  cost: number;
  tokens: TokenUsage;
  reason: string | null;
  timeStart: number;
  timeEnd: number;
  duration: number;
  spans: AgentLoopTraceSpan[];
}

export interface AgentLoopTrace {
  sessionId: string;
  steps: AgentLoopTraceStep[];
  summary: {
    totalSteps: number;
    totalSpans: number;
    totalDuration: number;
    totalCost: number;
    totalTokens: number;
  };
  truncated: boolean;
}

const MAX_TRACE_STEPS = 200;
const SUBAGENT_TOOLS = new Set(["task", "subtask", "spawn_agent", "delegate_task"]);

function asRow(value: unknown): Row {
  return value && typeof value === "object" ? value as Row : {};
}

function cloneTokenUsage(tokens: TokenUsage): TokenUsage {
  return {
    input: asNumber(tokens.input),
    output: asNumber(tokens.output),
    reasoning: asNumber(tokens.reasoning),
    total: asNumber(tokens.total),
    cache: {
      read: asNumber(tokens.cache?.read),
      write: asNumber(tokens.cache?.write)
    }
  };
}

function tokenUsageTotal(tokens: TokenUsage) {
  const total = asNumber(tokens.total);
  return total || (
    asNumber(tokens.input)
    + asNumber(tokens.output)
    + asNumber(tokens.reasoning)
    + asNumber(tokens.cache?.read)
    + asNumber(tokens.cache?.write)
  );
}

function sumTokenUsage(values: TokenUsage[]): TokenUsage | null {
  if (!values.length) return null;
  return values.reduce<TokenUsage>((total, tokens) => ({
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

function messageData(message: Message): Row {
  const metadata = asRow(message.metadata);
  const model = metadata.model;
  const tokens = message.tokens ? cloneTokenUsage(message.tokens) : null;
  return {
    role: message.role,
    time: { created: message.timestamp },
    tokens,
    tokenRequestCount: tokens ? 1 : 0,
    tokenRequests: tokens ? [tokens] : [],
    ...metadata,
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
  if (incoming.tokens) {
    const existingRequests = Array.isArray(target.tokenRequests)
      ? target.tokenRequests.filter((tokens: any) => tokens && typeof tokens === "object")
      : target.tokens && typeof target.tokens === "object"
        ? [target.tokens]
        : [];
    const tokenRequests = [...existingRequests, incoming.tokens as TokenUsage];
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
 * conversation, Trace, Tree, Metrics, and Flow views.
 */
export function buildAgentLoop(messages: Message[]): AgentLoop {
  const turns: AgentLoopTurn[] = [];
  const toolEventsById = new Map<string, AgentLoopEvent>();
  let previousGroupId: string | null = null;
  let previousGroupTurn: AgentLoopTurn | null = null;
  let activeAgentTurn: AgentLoopTurn | null = null;

  messages.forEach((message, index) => {
    const metadata = asRow(message.metadata);
    const toolUseId = metadata.toolUseId;
    if (typeof toolUseId === "string" && toolUseId) {
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
    const role = String(message.role || "").toLowerCase();
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

function compact(value: unknown, limit = 500) {
  if (value == null || value === "") return null;
  let text = "";
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function modelLabel(data: Row) {
  const model = data.model;
  if (typeof model === "string") return model;
  if (model && typeof model === "object") {
    return typeof model.modelID === "string"
      ? model.modelID
      : typeof model.providerID === "string"
        ? model.providerID
        : null;
  }
  return typeof data.modelID === "string" ? data.modelID : null;
}

function classifyTool(tool: string) {
  const normalized = tool.toLowerCase();
  if (SUBAGENT_TOOLS.has(normalized)) return { category: "agent" as const, mcpServer: null };
  if (normalized === "skill") return { category: "skill" as const, mcpServer: null };
  if (normalized.startsWith("lsp_")) return { category: "lsp" as const, mcpServer: null };
  if (normalized.startsWith("mcp__")) {
    const [, server] = tool.split("__");
    return { category: "mcp" as const, mcpServer: server || null };
  }
  if (normalized.includes("__")) {
    const [server] = tool.split("__");
    return { category: "mcp" as const, mcpServer: server || null };
  }
  return { category: "tool" as const, mcpServer: null };
}

function traceSpan(event: AgentLoopEvent, fallbackTime: number): AgentLoopTraceSpan {
  const timeStart = asNumber(event.timeStart) || fallbackTime;
  const timeEnd = asNumber(event.timeEnd) || timeStart;
  const time = {
    timeStart,
    timeEnd,
    duration: timeStart && timeEnd ? Math.max(0, timeEnd - timeStart) : 0
  };
  if (event.kind === "reasoning") {
    return {
      id: event.id,
      name: "reasoning",
      category: "reasoning",
      ...time,
      status: null,
      input: null,
      output: compact(event.text),
      title: "reasoning"
    };
  }
  if (event.kind === "text") {
    return {
      id: event.id,
      name: "text",
      category: "text",
      ...time,
      status: null,
      input: null,
      output: compact(event.text),
      title: "assistant text"
    };
  }

  const tool = event.tool || "tool";
  const classification = classifyTool(tool);
  const metadata = event.metadata || {};
  return {
    id: event.id,
    name: tool,
    category: classification.category,
    ...(classification.mcpServer ? { mcpServer: classification.mcpServer } : {}),
    ...time,
    status: event.status,
    input: compact(event.input),
    output: compact(event.output),
    title: compact(
      metadata.title
        || asRow(event.input).description
        || asRow(event.input).command
        || asRow(event.input).file_path
        || asRow(event.input).filePath,
      180
    )
  };
}

function traceReason(spans: AgentLoopTraceSpan[]) {
  if (spans.some((span) => ["tool", "mcp", "agent", "skill", "lsp"].includes(span.category))) {
    return "tool-calls";
  }
  if (spans.some((span) => span.category === "text")) return "message";
  if (spans.some((span) => span.category === "reasoning")) return "reasoning";
  return null;
}

/** Build a bounded Trace view directly from the common Agent Loop. */
export function buildAgentLoopTrace(sessionId: string, loop: AgentLoop): AgentLoopTrace {
  const allSteps = loop.turns
    .filter((turn) => turn.role === "assistant" || turn.role === "agent")
    .map((turn) => {
      const spans = turn.events.map((event) => traceSpan(event, turn.timeCreated));
      const times = [turn.timeCreated, ...spans.flatMap((span) => [span.timeStart, span.timeEnd])]
        .filter((time) => Number.isFinite(time) && time > 0);
      const timeStart = times.length ? Math.min(...times) : 0;
      const timeEnd = times.length ? Math.max(...times) : timeStart;
      const tokens = turn.data.tokens && typeof turn.data.tokens === "object"
        ? cloneTokenUsage(turn.data.tokens as TokenUsage)
        : { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } };
      return {
        messageId: turn.id,
        agent: typeof turn.data.agent === "string" ? turn.data.agent : null,
        model: modelLabel(turn.data),
        cost: asNumber(turn.data.cost),
        tokens,
        reason: traceReason(spans),
        timeStart,
        timeEnd,
        duration: timeStart && timeEnd ? Math.max(0, timeEnd - timeStart) : 0,
        spans
      } satisfies AgentLoopTraceStep;
    });
  const truncated = allSteps.length > MAX_TRACE_STEPS;
  const steps = allSteps.slice(0, MAX_TRACE_STEPS);
  const summary = steps.reduce((totals, step) => {
    totals.totalSteps += 1;
    totals.totalSpans += step.spans.length;
    totals.totalDuration += asNumber(step.duration);
    totals.totalCost += asNumber(step.cost);
    totals.totalTokens += tokenUsageTotal(step.tokens);
    return totals;
  }, {
    totalSteps: 0,
    totalSpans: 0,
    totalDuration: 0,
    totalCost: 0,
    totalTokens: 0
  });

  return { sessionId, steps, summary, truncated };
}
