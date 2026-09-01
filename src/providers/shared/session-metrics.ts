import { asNumber } from "./parser.js";
import type { AgentLoop } from "./agent-loop.js";
import { classifySharedTool } from "./subagent-tools.js";
import type { SessionContainer } from "./session-container.js";
import type { SessionContextView } from "./context.js";
import { aggregateSessionContainerDirectTokenUsage, aggregateSessionContainerTokenUsage } from "./session-usage.js";

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
    directInputTokens: number;
    directOutputTokens: number;
    directReasoningTokens: number;
    directCacheReadTokens: number;
    directCacheWriteTokens: number;
    directTotalTokens: number;
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

export const MAX_SESSION_METRIC_STEPS = 200;

/** Build the bounded metric steps shared by normalized message providers. */
export function buildSessionMetricSteps(loop: AgentLoop): SessionMetricsView["steps"] {
  return loop.turns
    .filter((turn) => turn.role === "assistant" || turn.role === "agent")
    .slice(0, MAX_SESSION_METRIC_STEPS)
    .map((turn, index) => {
      const times = [
        turn.timeCreated,
        ...turn.events.flatMap((event) => {
          const timeStart = asNumber(event.timeStart) || turn.timeCreated;
          const timeEnd = asNumber(event.timeEnd) || timeStart;
          return [timeStart, timeEnd];
        })
      ].filter((time) => Number.isFinite(time) && time > 0);
      const timeStart = times.length ? Math.min(...times) : 0;
      const timeEnd = times.length ? Math.max(...times) : timeStart;
      const tokens = turn.data.tokens && typeof turn.data.tokens === "object"
        ? turn.data.tokens
        : {};
      const cache = tokens.cache || {};
      const reason = turn.events.some((event) => event.kind === "tool" && ["tool", "mcp", "agent", "skill", "lsp"].includes(
        classifySharedTool(event.tool || "tool", event.metadata).category
      ))
        ? "tool-calls"
        : turn.events.some((event) => event.kind === "text")
          ? "message"
          : turn.events.some((event) => event.kind === "reasoning")
            ? "reasoning"
            : null;
      return {
        index: index + 1,
        messageId: turn.id,
        snapshotId: null,
        reason,
        duration: timeStart && timeEnd ? Math.max(0, timeEnd - timeStart) : 0,
        totalTokens: asNumber(tokens.total),
        inputTokens: asNumber(tokens.input),
        outputTokens: asNumber(tokens.output),
        reasoningTokens: asNumber(tokens.reasoning),
        cacheReadTokens: asNumber(cache.read),
        cacheWriteTokens: asNumber(cache.write),
        cost: asNumber(turn.data.cost),
        contextItems: turn.events.length
      };
    });
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
      // A provider-reported total remains authoritative if an older record
      // cannot expose every component needed for the stacked breakdown.
      totalTokens: aggregateSessionContainerTokenUsage(container).total || 0,
      directInputTokens: metrics.directInputTokens,
      directOutputTokens: metrics.directOutputTokens,
      directReasoningTokens: metrics.directReasoningTokens,
      directCacheReadTokens: metrics.directCacheReadTokens,
      directCacheWriteTokens: metrics.directCacheWriteTokens,
      directTotalTokens: aggregateSessionContainerDirectTokenUsage(container).total || 0,
      cost: metrics.cost,
      runtimeMs: metrics.runtimeMs
    },
    tools: toolCounts,
    steps
  };
}
