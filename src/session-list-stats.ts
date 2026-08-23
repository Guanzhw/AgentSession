import type { ProviderAdapter } from "./providers/interface.js";
import { supportsSessionProtocol } from "./providers/kinds.js";
import { type SessionProtocol, type TaskStatus } from "./providers/shared/session-protocol.js";
import { clearProtocolRuntimeCache, getRuntimeProtocol, ProtocolRuntimeError, sessionRevision } from "./protocol-runtime.js";

/**
 * Provider-neutral session-list statistics.
 *
 * `baseSessionListStats` derives the universal summary (message count, token
 * count, created→updated duration) from whatever the existing RawSession /
 * index row already carries, normalizing snake_case and camelCase fields and
 * keeping 0 distinct from unavailable (null). `deriveSessionListStats` then
 * merges bounded protocol evidence (compactions, tasks/agent runs, statuses,
 * context artifacts) through the shared validated Runtime Protocol cache —
 * never through provider-id branches.
 *
 * The derived list summary for the CURRENT page rows is cached in a bounded LRU
 * keyed by provider + canonical session id + revision
 * (timeUpdated/messageCount/tokenCount) because protocol construction is
 * file/material I/O for the file-backed providers. No provider data is ever
 * written here.
 */

export type DurationSource = "protocol" | "raw";

export interface SessionListStats {
  provider: string;
  sessionId: string;
  /** null = the list row carries no message count; 0 is a recorded zero. */
  messageCount: number | null;
  /** null = unknown/unrecorded; token totals are never fabricated. */
  tokenCount: number | null;
  /**
   * Observed duration in ms: the first/last meaningful event timestamp span
   * when protocol evidence exists, otherwise the raw created→updated span.
   * Never presented as active CPU time.
   */
  durationMs: number | null;
  durationSource: DurationSource | null;
  /** True when a getSessionProtocol result (possibly empty) was consumed. */
  protocol: boolean;
  /** Events with kind "context.compaction". */
  compactions: number;
  /** Max non-null compaction event timestamp. */
  lastCompactionAt: number | null;
  /** Task count, kept separate from executions so it is never double-counted. */
  taskCount: number;
  /** AgentRun executions, the authoritative execution count. */
  agentRunCount: number;
  /** AgentRuns with mode "subagent". */
  subagentRunCount: number;
  /** AgentRuns with mode background | scheduled | team. */
  backgroundRunCount: number;
  /** Active statuses observed on tasks/agent runs (deduped, fixed order). */
  activeStatuses: TaskStatus[];
  /** Metadata-only context artifact count. */
  contextArtifactCount: number;
  /** Kind "memory" artifact count; null when no protocol evidence exists. */
  memoryCount: number | null;
}

const ACTIVE_STATUSES: readonly TaskStatus[] = ["running", "blocked", "waiting_input", "queued"];
const BACKGROUND_MODES: ReadonlySet<string> = new Set(["background", "scheduled", "team"]);

const CACHE_LIMIT = 256;
const listStatsCache = new Map<string, SessionListStats>();

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Universal base summary derived from the existing list/index row fields. */
export function baseSessionListStats(session: any): SessionListStats {
  const messageCount = finiteNumber(session?.message_count ?? session?.messageCount);
  const tokenCount = finiteNumber(session?.token_count ?? session?.tokenCount);
  const timeCreated = finiteNumber(session?.time_created ?? session?.timeCreated);
  const timeUpdated = finiteNumber(session?.time_updated ?? session?.timeUpdated);
  let durationMs: number | null = null;
  if (
    timeCreated !== null && timeCreated > 0
    && timeUpdated !== null && timeUpdated > 0
    && timeUpdated >= timeCreated
  ) {
    durationMs = timeUpdated - timeCreated;
  }
  return {
    provider: String(session?.provider || ""),
    sessionId: String(session?.id || ""),
    messageCount,
    tokenCount,
    durationMs,
    durationSource: durationMs !== null ? "raw" : null,
    protocol: false,
    compactions: 0,
    lastCompactionAt: null,
    taskCount: 0,
    agentRunCount: 0,
    subagentRunCount: 0,
    backgroundRunCount: 0,
    activeStatuses: [],
    contextArtifactCount: 0,
    memoryCount: null
  };
}

function protocolDuration(protocol: SessionProtocol): { durationMs: number | null } {
  let first: number | null = null;
  let last: number | null = null;
  for (const event of protocol.events || []) {
    const ts = finiteNumber(event.timestamp);
    if (ts === null || ts <= 0) continue;
    if (first === null || ts < first) first = ts;
    if (last === null || ts > last) last = ts;
  }
  if (first !== null && last !== null && last > first) {
    return { durationMs: last - first };
  }
  return { durationMs: null };
}

function protocolSummary(protocol: SessionProtocol) {
  let compactions = 0;
  let lastCompactionAt: number | null = null;
  for (const event of protocol.events || []) {
    if (event.kind !== "context.compaction") continue;
    compactions += 1;
    const ts = finiteNumber(event.timestamp);
    if (ts !== null && (lastCompactionAt === null || ts > lastCompactionAt)) {
      lastCompactionAt = ts;
    }
  }

  const runs = protocol.agentRuns || [];
  let agentRunCount = 0;
  let subagentRunCount = 0;
  let backgroundRunCount = 0;
  const statuses = new Set<TaskStatus>();
  for (const run of runs) {
    agentRunCount += 1;
    if (run.mode === "subagent") subagentRunCount += 1;
    else if (BACKGROUND_MODES.has(run.mode)) backgroundRunCount += 1;
    statuses.add(run.status);
  }
  for (const task of protocol.tasks || []) {
    statuses.add(task.status);
  }

  const artifacts = protocol.contextArtifacts || [];
  let memoryCount = 0;
  for (const artifact of artifacts) {
    if (artifact.kind === "memory") memoryCount += 1;
  }

  return {
    compactions,
    lastCompactionAt,
    taskCount: (protocol.tasks || []).length,
    agentRunCount,
    subagentRunCount,
    backgroundRunCount,
    activeStatuses: ACTIVE_STATUSES.filter((status) => statuses.has(status)),
    contextArtifactCount: artifacts.length,
    memoryCount
  };
}

function cloneStats(stats: SessionListStats): SessionListStats {
  return { ...stats, activeStatuses: [...stats.activeStatuses] };
}

/**
 * Base stats plus protocol evidence for one session row. The protocol lookup
 * result is cached per provider+id+revision in a bounded LRU.
 */
export function deriveSessionListStats(
  adapter: ProviderAdapter | null | undefined,
  session: any
): SessionListStats {
  const base = baseSessionListStats(session);
  if (!adapter || !session?.id || !supportsSessionProtocol(adapter)) {
    return base;
  }

  const revision = sessionRevision(adapter, session);
  const key = `${adapter.id}\u0000${session.id}\u0000${revision}`;

  const cached = listStatsCache.get(key);
  if (cached) {
    // Refresh recency so the LRU evicts least-recently-used entries.
    listStatsCache.delete(key);
    listStatsCache.set(key, cached);
    return cloneStats(cached);
  }

  let protocol: SessionProtocol | null;
  try {
    protocol = getRuntimeProtocol(adapter, session.id, session);
  } catch (err: any) {
    if (err instanceof ProtocolRuntimeError && err.code === "session_not_found") {
      return base;
    } else {
    // Never cache a failed lookup: a transient protocol error must not stick.
      console.error(`Session list stats: protocol failed for ${adapter.id}/${session.id}: ${err?.message || String(err)}`);
      return base;
    }
  }

  if (!protocol) return base;
  base.protocol = true;
  {
    const summary = protocolSummary(protocol);
    const duration = protocolDuration(protocol);
    base.compactions = summary.compactions;
    base.lastCompactionAt = summary.lastCompactionAt;
    base.taskCount = summary.taskCount;
    base.agentRunCount = summary.agentRunCount;
    base.subagentRunCount = summary.subagentRunCount;
    base.backgroundRunCount = summary.backgroundRunCount;
    base.activeStatuses = summary.activeStatuses;
    base.contextArtifactCount = summary.contextArtifactCount;
    base.memoryCount = summary.memoryCount;
    if (duration.durationMs !== null) {
      base.durationMs = duration.durationMs;
      base.durationSource = "protocol";
    }
  }

  if (listStatsCache.size >= CACHE_LIMIT) {
    const oldest = listStatsCache.keys().next().value;
    if (oldest !== undefined) listStatsCache.delete(oldest);
  }
  listStatsCache.set(key, base);
  return cloneStats(base);
}

/**
 * Attach a bounded stats summary to each session of the CURRENT page result
 * only. `adapterFor` resolves a provider id to its adapter; `fallbackProvider`
 * covers rows that do not carry their own provider field (SQLite lists).
 * Returns the same array for chaining.
 */
export function attachSessionListStats(
  sessions: any[],
  adapterFor: (provider: string) => ProviderAdapter | null | undefined,
  fallbackProvider = ""
): any[] {
  for (const session of sessions) {
    if (!session || typeof session !== "object") continue;
    const provider = String(session.provider || fallbackProvider || "");
    session.stats = deriveSessionListStats(adapterFor(provider), session);
  }
  return sessions;
}

/**
 * Bounded API projection: only known fields survive, statuses are validated
 * against the protocol vocabulary, counts are clamped non-negative. Returns
 * null for non-object input so callers can fall back to base stats.
 */
export function boundedListStats(value: unknown): SessionListStats | null {
  if (!value || typeof value !== "object") return null;
  const stats = value as Record<string, unknown>;
  const activeStatuses = Array.isArray(stats.activeStatuses)
    ? [...new Set((stats.activeStatuses as unknown[]).filter((status): status is TaskStatus =>
        (ACTIVE_STATUSES as readonly string[]).includes(String(status))))]
    : [];
  const memoryValue = stats.memoryCount;
  return {
    provider: String(stats.provider || ""),
    sessionId: String(stats.sessionId || ""),
    messageCount: finiteNumber(stats.messageCount),
    tokenCount: finiteNumber(stats.tokenCount),
    durationMs: finiteNumber(stats.durationMs),
    durationSource: stats.durationSource === "protocol" || stats.durationSource === "raw"
      ? stats.durationSource
      : null,
    protocol: stats.protocol === true,
    compactions: Math.max(0, Number(stats.compactions) || 0),
    lastCompactionAt: finiteNumber(stats.lastCompactionAt),
    taskCount: Math.max(0, Number(stats.taskCount) || 0),
    agentRunCount: Math.max(0, Number(stats.agentRunCount) || 0),
    subagentRunCount: Math.max(0, Number(stats.subagentRunCount) || 0),
    backgroundRunCount: Math.max(0, Number(stats.backgroundRunCount) || 0),
    activeStatuses,
    contextArtifactCount: Math.max(0, Number(stats.contextArtifactCount) || 0),
    memoryCount: memoryValue == null ? null : Math.max(0, Number(memoryValue) || 0)
  };
}

/** Test hook: reset the bounded protocol-result cache. */
export function clearSessionListStatsCache(): void {
  listStatsCache.clear();
  clearProtocolRuntimeCache();
}

/** Test hook: current cache size (bounded by CACHE_LIMIT). */
export function sessionListStatsCacheSize(): number {
  return listStatsCache.size;
}
