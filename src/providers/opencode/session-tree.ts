import { getTodos } from "../../db.js";
import { asNumber } from "../shared/parser.js";
import {
  buildSessionTree,
  type SessionMessageNode,
  type SessionPartNode,
  type SessionTree,
  type SessionUsage
} from "../shared/session-tree.js";

type Row = Record<string, any>;

export interface OpenCodeTodoRow {
  session_id?: string | null;
  content?: string;
  status?: string;
  priority?: string;
  position?: number | null;
  time_created?: number | null;
  time_updated?: number | null;
}
export type OpenCodeSessionTree = SessionTree & { todos?: OpenCodeTodoRow[] };

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

export function buildOpenCodeSessionTree(sessionId: string, dbPath: string | undefined = undefined): OpenCodeSessionTree | null {
  const tree = buildSessionTree(sessionId, dbPath, readOpenCodeUsage);
  if (!tree) return null;
  return { ...tree, todos: getTodos(sessionId, dbPath) };
}
