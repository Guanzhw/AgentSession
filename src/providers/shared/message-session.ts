import type { Message, RawSession, TokenUsage } from "../interface.js";
import { buildFlowTreeFromContainer } from "./flow-tree.js";
import { treeToContainer } from "./session-container.js";
import type { SessionMetricsView } from "./session-metrics.js";
import type {
  SessionMessageNode,
  SessionPartNode,
  SessionTree,
  SessionTreeMetrics
} from "./session-tree.js";

type Row = Record<string, any>;

function asNumber(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function messageData(message: Message): Row {
  const metadata = message.metadata && typeof message.metadata === "object"
    ? message.metadata
    : {};
  const model = metadata.model;
  return {
    role: message.role,
    time: { created: message.timestamp },
    tokens: message.tokens,
    ...metadata,
    model: typeof model === "string"
      ? { modelID: model, providerID: metadata.provider || null }
      : model || null
  };
}

function messageParts(message: Message, index: number): SessionPartNode[] {
  const parts: SessionPartNode[] = [];
  const prefix = message.id || `${message.sessionId}:message:${index}`;

  if (message.thinking) {
    parts.push({
      id: `${prefix}:reasoning`,
      messageId: prefix,
      sessionId: message.sessionId,
      type: "reasoning",
      tool: null,
      data: { type: "reasoning", text: message.thinking },
      timeStart: message.timestamp,
      timeEnd: message.timestamp,
      childSessions: []
    });
  }

  if (message.role === "tool" || message.toolName) {
    const isError = Boolean(message.metadata?.isError);
    parts.push({
      id: `${prefix}:tool`,
      messageId: prefix,
      sessionId: message.sessionId,
      type: "tool",
      tool: message.toolName || "tool",
      data: {
        type: "tool",
        tool: message.toolName || "tool",
        state: {
          input: message.toolInput,
          output: message.toolOutput ?? message.content ?? "",
          status: isError ? "error" : "completed",
          time: { start: message.timestamp, end: message.timestamp }
        }
      },
      timeStart: message.timestamp,
      timeEnd: message.timestamp,
      childSessions: []
    });
  } else if (message.content) {
    parts.push({
      id: `${prefix}:text`,
      messageId: prefix,
      sessionId: message.sessionId,
      type: "text",
      tool: null,
      data: { type: "text", text: message.content },
      timeStart: message.timestamp,
      timeEnd: message.timestamp,
      childSessions: []
    });
  }

  return parts;
}

function addUsage(target: SessionTreeMetrics, tokens: TokenUsage | null) {
  if (!tokens) return;
  target.inputTokens += asNumber(tokens.input);
  target.outputTokens += asNumber(tokens.output);
  target.reasoningTokens += asNumber(tokens.reasoning);
  target.cacheReadTokens += asNumber(tokens.cache?.read);
  target.cacheWriteTokens += asNumber(tokens.cache?.write);
}

export function buildMessageSessionTree(session: RawSession | Row, messages: Message[]): SessionTree {
  const sessionRow = session as Row;
  const nodes: SessionMessageNode[] = [];
  const toolPartsById = new Map<string, SessionPartNode>();
  messages.forEach((message, index) => {
    const toolUseId = message.metadata?.toolUseId;
    if (typeof toolUseId === "string" && toolUseId) {
      const call = toolPartsById.get(toolUseId);
      if (call) {
        call.data.state.output = message.toolOutput ?? message.content ?? "";
        call.data.state.status = message.metadata?.isError ? "error" : "completed";
        return;
      }
    }

    const id = message.id || `${message.sessionId}:message:${index}`;
    const parts = messageParts(message, index);
    const toolPart = parts.find((part) => part.type === "tool");
    if (toolPart) {
      toolPartsById.set(id, toolPart);
    }
    nodes.push({
      id,
      sessionId: message.sessionId,
      role: String(message.role || "unknown"),
      data: messageData(message),
      timeCreated: asNumber(message.timestamp),
      parts
    });
  });
  const times = [
    asNumber(sessionRow.timeCreated ?? sessionRow.time_created),
    asNumber(sessionRow.timeUpdated ?? sessionRow.time_updated),
    ...nodes.map((message) => message.timeCreated)
  ].filter(Boolean);
  const metrics: SessionTreeMetrics = {
    messageCount: nodes.length,
    partCount: nodes.reduce((sum, message) => sum + message.parts.length, 0),
    toolCallCount: nodes.reduce(
      (sum, message) => sum + message.parts.filter((part) => part.type === "tool").length,
      0
    ),
    directChildCount: 0,
    descendantCount: 0,
    totalMessages: nodes.length,
    totalToolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    timeStart: times.length ? Math.min(...times) : 0,
    timeEnd: times.length ? Math.max(...times) : 0,
    runtimeMs: 0
  };
  metrics.totalToolCalls = metrics.toolCallCount;
  metrics.runtimeMs = metrics.timeStart && metrics.timeEnd
    ? Math.max(0, metrics.timeEnd - metrics.timeStart)
    : 0;
  messages.forEach((message) => addUsage(metrics, message.tokens));

  return {
    session: {
      ...session,
      id: session.id,
      title: session.title,
      directory: session.directory,
      time_created: sessionRow.timeCreated ?? sessionRow.time_created,
      time_updated: sessionRow.timeUpdated ?? sessionRow.time_updated
    },
    messages: nodes,
    detachedChildren: [],
    metrics
  };
}

export function buildMessageSessionViews(session: RawSession | Row, messages: Message[]) {
  const tree = buildMessageSessionTree(session, messages);
  const container = treeToContainer(tree);
  const toolCounts = new Map<string, number>();
  for (const message of tree.messages) {
    for (const part of message.parts) {
      if (part.type === "tool") {
        const name = part.tool || "unknown";
        toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
      }
    }
  }
  const metrics: SessionMetricsView = {
    sessionId: String(session.id),
    totals: {
      messages: tree.metrics.totalMessages,
      toolCalls: tree.metrics.totalToolCalls,
      branches: 0,
      steps: 0,
      inputTokens: tree.metrics.inputTokens,
      outputTokens: tree.metrics.outputTokens,
      reasoningTokens: tree.metrics.reasoningTokens,
      cacheReadTokens: tree.metrics.cacheReadTokens,
      cacheWriteTokens: tree.metrics.cacheWriteTokens,
      totalTokens: tree.metrics.inputTokens
        + tree.metrics.outputTokens
        + tree.metrics.reasoningTokens
        + tree.metrics.cacheReadTokens
        + tree.metrics.cacheWriteTokens,
      cost: 0,
      runtimeMs: tree.metrics.runtimeMs
    },
    tools: [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count })),
    steps: []
  };

  return {
    tree,
    container,
    metrics,
    flow: buildFlowTreeFromContainer(container, metrics)
  };
}
