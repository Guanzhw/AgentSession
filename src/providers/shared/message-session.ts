import type { Message, RawSession, TokenUsage } from "../interface.js";
import {
  buildAgentLoop,
  buildAgentLoopTrace,
  type AgentLoop,
  type AgentLoopEvent
} from "./agent-loop.js";
import { asNumber } from "./parser.js";
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

function addUsage(target: SessionTreeMetrics, tokens: TokenUsage | null) {
  if (!tokens) return;
  target.inputTokens += asNumber(tokens.input);
  target.outputTokens += asNumber(tokens.output);
  target.reasoningTokens += asNumber(tokens.reasoning);
  target.cacheReadTokens += asNumber(tokens.cache?.read);
  target.cacheWriteTokens += asNumber(tokens.cache?.write);
}

function loopEventToPart(event: AgentLoopEvent, turnId: string, sessionId: string): SessionPartNode {
  if (event.kind === "reasoning") {
    return {
      id: event.id,
      messageId: turnId,
      sessionId,
      type: "reasoning",
      tool: null,
      data: { type: "reasoning", text: event.text },
      timeStart: event.timeStart,
      timeEnd: event.timeEnd,
      childSessions: []
    };
  }
  if (event.kind === "text") {
    return {
      id: event.id,
      messageId: turnId,
      sessionId,
      type: "text",
      tool: null,
      data: { type: "text", text: event.text },
      timeStart: event.timeStart,
      timeEnd: event.timeEnd,
      childSessions: []
    };
  }
  return {
    id: event.id,
    messageId: turnId,
    sessionId,
    type: "tool",
    tool: event.tool || "tool",
    data: {
      type: "tool",
      tool: event.tool || "tool",
      metadata: event.metadata,
      state: {
        input: event.input,
        output: event.output,
        status: event.status,
        time: { start: event.timeStart, end: event.timeEnd }
      }
    },
    timeStart: event.timeStart,
    timeEnd: event.timeEnd,
    childSessions: []
  };
}

export function buildMessageSessionTree(
  session: RawSession | Row,
  messages: Message[],
  loop = buildAgentLoop(messages)
): SessionTree {
  const sessionRow = session as Row;
  const nodes: SessionMessageNode[] = loop.turns.map((turn) => ({
    id: turn.id,
    sessionId: turn.sessionId,
    role: turn.role,
    data: turn.data,
    timeCreated: turn.timeCreated,
    parts: turn.events.map((event) => loopEventToPart(event, turn.id, turn.sessionId))
  }));
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
  nodes.forEach((message) => addUsage(metrics, message.data?.tokens || null));

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

export function refreshMessageSessionTreeMetrics(tree: SessionTree): SessionTreeMetrics {
  const children = [
    ...tree.messages.flatMap((message) => message.parts.flatMap((part) => part.childSessions)),
    ...tree.detachedChildren
  ];
  children.forEach((child) => refreshMessageSessionTreeMetrics(child));

  const directToolCalls = tree.messages.reduce(
    (sum, message) => sum + message.parts.filter((part) => part.type === "tool").length,
    0
  );
  const directMetrics: SessionTreeMetrics = {
    messageCount: tree.messages.length,
    partCount: tree.messages.reduce((sum, message) => sum + message.parts.length, 0),
    toolCallCount: directToolCalls,
    directChildCount: children.length,
    descendantCount: children.length + children.reduce((sum, child) => sum + child.metrics.descendantCount, 0),
    totalMessages: tree.messages.length + children.reduce((sum, child) => sum + child.metrics.totalMessages, 0),
    totalToolCalls: directToolCalls + children.reduce((sum, child) => sum + child.metrics.totalToolCalls, 0),
    inputTokens: children.reduce((sum, child) => sum + child.metrics.inputTokens, 0),
    outputTokens: children.reduce((sum, child) => sum + child.metrics.outputTokens, 0),
    reasoningTokens: children.reduce((sum, child) => sum + child.metrics.reasoningTokens, 0),
    cacheReadTokens: children.reduce((sum, child) => sum + child.metrics.cacheReadTokens, 0),
    cacheWriteTokens: children.reduce((sum, child) => sum + child.metrics.cacheWriteTokens, 0),
    cost: children.reduce((sum, child) => sum + child.metrics.cost, 0),
    timeStart: 0,
    timeEnd: 0,
    runtimeMs: 0
  };
  for (const message of tree.messages) {
    addUsage(directMetrics, message.data?.tokens || null);
    directMetrics.cost += asNumber(message.data?.cost);
  }
  const session = tree.session || {};
  const times = [
    asNumber(session.timeCreated ?? session.time_created),
    asNumber(session.timeUpdated ?? session.time_updated),
    ...tree.messages.flatMap((message) => [
      message.timeCreated,
      ...message.parts.flatMap((part) => [part.timeStart, part.timeEnd])
    ]),
    ...children.flatMap((child) => [child.metrics.timeStart, child.metrics.timeEnd])
  ].filter(Boolean);
  directMetrics.timeStart = times.length ? Math.min(...times) : 0;
  directMetrics.timeEnd = times.length ? Math.max(...times) : 0;
  directMetrics.runtimeMs = directMetrics.timeStart && directMetrics.timeEnd
    ? Math.max(0, directMetrics.timeEnd - directMetrics.timeStart)
    : 0;
  tree.metrics = directMetrics;
  return directMetrics;
}

function collectToolCounts(tree: SessionTree, toolCounts = new Map<string, number>()) {
  for (const message of tree.messages) {
    for (const part of message.parts) {
      if (part.type === "tool") {
        const name = part.tool || "unknown";
        toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
      }
      part.childSessions.forEach((child) => collectToolCounts(child, toolCounts));
    }
  }
  tree.detachedChildren.forEach((child) => collectToolCounts(child, toolCounts));
  return toolCounts;
}

export function buildMessageSessionViewsFromTree(tree: SessionTree, loop: AgentLoop) {
  refreshMessageSessionTreeMetrics(tree);
  const container = treeToContainer(tree);
  const toolCounts = collectToolCounts(tree);
  const trace = buildAgentLoopTrace(String(tree.session.id), loop);
  const metrics: SessionMetricsView = {
    sessionId: String(tree.session.id),
    totals: {
      messages: tree.metrics.totalMessages,
      toolCalls: tree.metrics.totalToolCalls,
      branches: tree.metrics.descendantCount,
      steps: trace.steps.length,
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
    steps: trace.steps.map((step, index) => ({
      index: index + 1,
      messageId: step.messageId,
      snapshotId: null,
      reason: step.reason,
      duration: step.duration,
      totalTokens: step.tokens.total || 0,
      inputTokens: step.tokens.input || 0,
      outputTokens: step.tokens.output || 0,
      reasoningTokens: step.tokens.reasoning || 0,
      cacheReadTokens: step.tokens.cache?.read || 0,
      cacheWriteTokens: step.tokens.cache?.write || 0,
      cost: step.cost,
      contextItems: step.spans.length
    }))
  };

  return {
    tree,
    container,
    metrics,
    flow: buildFlowTreeFromContainer(container, metrics),
    trace
  };
}

export function buildMessageSessionViews(session: RawSession | Row, messages: Message[]) {
  const loop = buildAgentLoop(messages);
  return buildMessageSessionViewsFromTree(buildMessageSessionTree(session, messages, loop), loop);
}
