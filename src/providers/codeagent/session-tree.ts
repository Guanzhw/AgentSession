import {
  buildSessionTree,
  type SessionMessageNode,
  type SessionTree,
  type SessionUsage
} from "../shared/session-tree.js";

function asNumber(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

export function readCodeAgentUsage(_session: Record<string, any>, messages: SessionMessageNode[]): SessionUsage {
  return messages.reduce((usage, message) => {
    if (message.role !== "assistant") {
      return usage;
    }
    const tokens = message.data?.tokens || {};
    const cache = tokens.cache || {};
    usage.inputTokens += asNumber(tokens.input);
    usage.outputTokens += asNumber(tokens.output);
    usage.reasoningTokens += asNumber(tokens.reasoning);
    usage.cacheReadTokens += asNumber(cache.read);
    usage.cacheWriteTokens += asNumber(cache.write);
    usage.cost += asNumber(message.data?.cost);
    return usage;
  }, {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0
  });
}

export function buildCodeAgentSessionTree(sessionId: string, dbPath = undefined): SessionTree | null {
  return buildSessionTree(sessionId, dbPath, readCodeAgentUsage);
}
