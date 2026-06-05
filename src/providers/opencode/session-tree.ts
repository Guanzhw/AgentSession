import {
  buildSessionTree,
  type SessionMessageNode,
  type SessionPartNode,
  type SessionTree,
  type SessionUsage
} from "../shared/session-tree.js";

type Row = Record<string, any>;

function asNumber(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function readOpenCodeUsage(session: Row): SessionUsage {
  return {
    inputTokens: asNumber(session.tokens_input),
    outputTokens: asNumber(session.tokens_output),
    reasoningTokens: asNumber(session.tokens_reasoning),
    cacheReadTokens: asNumber(session.tokens_cache_read),
    cacheWriteTokens: asNumber(session.tokens_cache_write),
    cost: asNumber(session.cost)
  };
}

export type { SessionMessageNode, SessionPartNode, SessionTree };

export function buildOpenCodeSessionTree(sessionId: string, dbPath = undefined): SessionTree | null {
  return buildSessionTree(sessionId, dbPath, readOpenCodeUsage);
}
