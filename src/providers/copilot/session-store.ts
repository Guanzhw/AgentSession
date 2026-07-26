import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DailyTokenStat } from "../interface.js";
import { asNumber } from "../shared/parser.js";
import { copilotUsageToTokens, type CopilotUsageRecord } from "./parser.js";

export interface CopilotCatalogEntry {
  id: string;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  summary: string | null;
  createdAt: number;
  updatedAt: number;
  tokenCount: number;
}

export interface CopilotSessionStoreSnapshot {
  signature: string;
  catalog: Map<string, CopilotCatalogEntry>;
  usagesBySession: Map<string, CopilotUsageRecord[]>;
}

let cached: { root: string; signature: string; snapshot: CopilotSessionStoreSnapshot } | null = null;

function safeTimestamp(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function fileSignature(filePath: string) {
  try {
    const stat = statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function snapshotSignature(storePath: string) {
  return [storePath, `${storePath}-wal`, `${storePath}-shm`]
    .map((filePath) => `${path.basename(filePath)}:${fileSignature(filePath)}`)
    .join("|");
}

function emptySnapshot(signature: string): CopilotSessionStoreSnapshot {
  return {
    signature,
    catalog: new Map(),
    usagesBySession: new Map()
  };
}

/**
 * The event log is canonical for transcript text. Copilot's companion SQLite
 * store supplies only catalog paths and token telemetry, and is always opened
 * read-only so the viewer never changes provider-owned state.
 */
export function readCopilotSessionStore(copilotDir: string): CopilotSessionStoreSnapshot {
  const storePath = path.join(copilotDir, "session-store.db");
  const signature = snapshotSignature(storePath);
  if (cached?.root === copilotDir && cached.signature === signature) return cached.snapshot;

  const snapshot = emptySnapshot(signature);
  if (!existsSync(storePath)) {
    cached = { root: copilotDir, signature, snapshot };
    return snapshot;
  }

  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(storePath, { readOnly: true });
    const sessions = database.prepare(`
      SELECT id, cwd, repository, branch, summary, created_at, updated_at
      FROM sessions
    `).all() as Array<Record<string, unknown>>;
    for (const source of sessions) {
      const id = safeText(source.id);
      if (!id) continue;
      snapshot.catalog.set(id, {
        id,
        cwd: safeText(source.cwd),
        repository: safeText(source.repository),
        branch: safeText(source.branch),
        summary: safeText(source.summary),
        createdAt: safeTimestamp(source.created_at),
        updatedAt: safeTimestamp(source.updated_at),
        tokenCount: 0
      });
    }

    const usageRows = database.prepare(`
      SELECT rowid AS sequence, session_id, turn_index, agent_id,
             input_tokens, output_tokens, cache_read_tokens,
             cache_write_tokens, reasoning_tokens, created_at
      FROM assistant_usage_events
      ORDER BY created_at ASC, sequence ASC
    `).all() as Array<Record<string, unknown>>;
    for (const source of usageRows) {
      const sessionId = safeText(source.session_id);
      if (!sessionId) continue;
      const usage: CopilotUsageRecord = {
        agentId: safeText(source.agent_id),
        turnIndex: typeof source.turn_index === "string" || typeof source.turn_index === "number"
          ? source.turn_index
          : null,
        inputTokens: asNumber(source.input_tokens),
        outputTokens: asNumber(source.output_tokens),
        cacheReadTokens: asNumber(source.cache_read_tokens),
        cacheWriteTokens: asNumber(source.cache_write_tokens),
        reasoningTokens: asNumber(source.reasoning_tokens),
        createdAt: safeTimestamp(source.created_at)
      };
      const usages = snapshot.usagesBySession.get(sessionId) || [];
      usages.push(usage);
      snapshot.usagesBySession.set(sessionId, usages);
      const catalog = snapshot.catalog.get(sessionId);
      const normalized = copilotUsageToTokens(usage);
      if (catalog && normalized) catalog.tokenCount += asNumber(normalized.total);
    }
  } catch (error) {
    console.warn("Unable to read Copilot CLI session store:", storePath, error);
  } finally {
    database?.close();
  }

  cached = { root: copilotDir, signature, snapshot };
  return snapshot;
}

export function copilotDailyTokenStats(copilotDir: string, days = 30): DailyTokenStat[] {
  const snapshot = readCopilotSessionStore(copilotDir);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const cutoff = today.getTime() - (Math.max(1, days) - 1) * 86_400_000;
  const byDay = new Map<string, DailyTokenStat>();

  for (const usages of snapshot.usagesBySession.values()) {
    for (const usage of usages) {
      if (!usage.createdAt || usage.createdAt < cutoff) continue;
      const day = new Date(usage.createdAt).toISOString().slice(0, 10);
      const current = byDay.get(day) || {
        day,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        messageCount: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      };
      const tokens = copilotUsageToTokens(usage);
      current.inputTokens += asNumber(tokens?.input);
      current.outputTokens += asNumber(tokens?.output);
      current.reasoningTokens = asNumber(current.reasoningTokens) + asNumber(tokens?.reasoning);
      current.cacheReadTokens = asNumber(current.cacheReadTokens) + asNumber(tokens?.cache?.read);
      current.cacheWriteTokens = asNumber(current.cacheWriteTokens) + asNumber(tokens?.cache?.write);
      current.totalTokens += asNumber(tokens?.total);
      current.messageCount += 1;
      byDay.set(day, current);
    }
  }
  return [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day));
}
