import type { SessionContainer } from "./session-container.js";
import type { SessionContextView } from "./context.js";

export interface SessionMetricsView {
  sessionId: string;
  totals: {
    messages: number;
    toolCalls: number;
    branches: number;
    steps: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    cost: number;
    runtimeMs: number;
  };
  tools: Array<{ name: string; count: number }>;
  steps: Array<{
    index: number;
    messageId: string;
    snapshotId: string | null;
    reason: string | null;
    duration: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number;
    contextItems: number;
  }>;
}

function asNumber(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function collectTools(container: SessionContainer | null, counts = new Map<string, number>()) {
  if (!container) {
    return counts;
  }

  for (const message of container.messages) {
    for (const part of message.parts) {
      if (part.partType === "tool") {
        const name = part.tool || "unknown";
        counts.set(name, (counts.get(name) || 0) + 1);
      }
      for (const child of part.childSessions) {
        collectTools(child, counts);
      }
    }
  }

  for (const child of container.detachedChildren) {
    collectTools(child, counts);
  }

  return counts;
}

function stepMetrics(context: SessionContextView) {
  return context.steps.map((step) => {
    const tokens = step.tokens || {};
    const cache = tokens.cache || {};
    return {
      index: step.index,
      messageId: step.messageId,
      snapshotId: step.snapshotId,
      reason: step.reason,
      duration: step.duration,
      totalTokens: asNumber(tokens.total),
      inputTokens: asNumber(tokens.input),
      outputTokens: asNumber(tokens.output),
      reasoningTokens: asNumber(tokens.reasoning),
      cacheReadTokens: asNumber(cache.read),
      cacheWriteTokens: asNumber(cache.write),
      cost: asNumber(step.cost),
      contextItems: Array.isArray(step.items) ? step.items.length : 0
    };
  });
}

export function buildSessionMetrics(
  sessionId: string,
  dbPath: string | undefined,
  buildContainer: (sessionId: string, dbPath?: string) => SessionContainer | null,
  buildContext: (sessionId: string, dbPath?: string) => SessionContextView
): SessionMetricsView | null {
  const container = buildContainer(sessionId, dbPath);
  if (!container) {
    return null;
  }

  const context = buildContext(sessionId, dbPath);
  const steps = stepMetrics(context);
  const metrics = container.metrics;
  const toolCounts = [...collectTools(container).entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));

  return {
    sessionId,
    totals: {
      messages: metrics.totalMessages,
      toolCalls: metrics.totalToolCalls,
      branches: metrics.descendantCount,
      steps: steps.length,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      reasoningTokens: metrics.reasoningTokens,
      cacheReadTokens: metrics.cacheReadTokens,
      cacheWriteTokens: metrics.cacheWriteTokens,
      totalTokens: metrics.inputTokens + metrics.outputTokens + metrics.reasoningTokens + metrics.cacheReadTokens + metrics.cacheWriteTokens,
      cost: metrics.cost,
      runtimeMs: metrics.runtimeMs
    },
    tools: toolCounts,
    steps
  };
}
