// Stats data contract and query helpers for Token Explorer.
// Separates filter parsing, aggregation, and query logic from routes and views
// so that both SQLite and file-backed providers can participate through a
// uniform interface.

import type { ComparisonResult } from "./stats-comparison.js";
import type { CostEstimate } from "./stats-cost.js";
import type { HeuristicInsight } from "./stats-insights.js";

// ── Filter types ────────────────────────────────────────────────────────────

export interface StatsFilters {
  /** Number of days to query (7, 30, 90, or custom via from/to) */
  days: number;
  /** ISO date string for custom range start (inclusive) */
  from: string | null;
  /** ISO date string for custom range end (inclusive) */
  to: string | null;
  /** Project filter (empty = all) */
  project: string;
  /** Model/provider filter as "providerID/modelID" */
  modelPair: string | null;
  /** "root" = parent_id IS NULL only, "all" = include children */
  scope: "root" | "all";
  /** Compare model A key "providerId/modelId" */
  compareA: string | null;
  /** Compare model B key "providerId/modelId" */
  compareB: string | null;
  /** Requested range control, retained even when custom input is invalid. */
  rangePreset: "7" | "30" | "90" | "custom";
  requestedFrom: string;
  requestedTo: string;
  validationError: "invalid_custom_range" | "custom_range_too_long" | null;
}

export interface TokenDayRow {
  day: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  message_count: number;
}

export interface ModelRankEntry {
  modelId: string;
  providerId: string;
  key: string; // "providerId/modelId"
  totalTokens: number;
  sessionCount: number;
  messageCount: number;
}

export interface TopSessionEntry {
  sessionId: string;
  title: string;
  directory: string;
  providerModel: string;
  modelCount?: number;
  totalTokens: number;
  messageCount: number;
  timeUpdated: number;
}

export interface CoverageInfo {
  /** Total assistant messages in range with non-null token total > 0. null means coverage unavailable for this provider. */
  messagesWithTokens: number | null;
  /** Total assistant messages in range. null means coverage unavailable for this provider. */
  totalAssistantMessages: number | null;
  /** Sessions that have token data */
  sessionsWithTokens: number | null;
  /** Total sessions in range */
  totalSessions: number | null;
  /** Set of token dimensions that are available (e.g. "reasoning", "cache") */
  availableDimensions: string[];
  /** Set of dimensions that are missing for all messages */
  missingDimensions: string[];
}

export interface TokenExplorerData {
  filters: StatsFilters;
  tokenStats: TokenDayRow[];
  modelRanking: ModelRankEntry[];
  topSessions: TopSessionEntry[];
  coverage: CoverageInfo | null;
  comparison: ComparisonResult | null;
  insights: HeuristicInsight[];
  costEstimate: CostEstimate | null;
  /** Two-model comparison result for model A */
  compareA: { key: string; model: string; provider: string; totalTokens: number; recordCount: number; tokensPerRecord: number | null; share: number } | null;
  /** Two-model comparison result for model B */
  compareB: { key: string; model: string; provider: string; totalTokens: number; recordCount: number; tokensPerRecord: number | null; share: number } | null;
  overview: {
    totalSessions: number;
    totalMessages: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    peakDay: string;
    peakDayTokens: number;
    avgTokensPerSession: number;
  };
  /** Provider info for the page chrome */
  provider: string;
  providers: any[];
  manageable: boolean;
  capabilities?: StatsCapabilities;
}

export interface StatsCapabilities {
  customRange: boolean;
  project: boolean;
  model: boolean;
  scope: boolean;
  dayDrill: boolean;
  composition: boolean;
  modelRanking: boolean;
  sessionBreakdown: boolean;
  coverage: boolean;
}

// ── Filter parsing from URLSearchParams ─────────────────────────────────────

const MAX_CUSTOM_RANGE_DAYS = 366;

export function parseStatsDay(value: unknown): string | null {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    ? text
    : null;
}

export function parseStatsFilters(params: URLSearchParams): StatsFilters {
  const daysParam = params.get("days");
  const fromParam = params.get("from");
  const toParam = params.get("to");

  let days = 30;
  let from: string | null = null;
  let to: string | null = null;
  let rangePreset: StatsFilters["rangePreset"] = "30";
  let validationError: StatsFilters["validationError"] = null;
  const requestedFrom = fromParam || "";
  const requestedTo = toParam || "";

  if (daysParam === "7") { days = 7; rangePreset = "7"; }
  else if (daysParam === "90") { days = 90; rangePreset = "90"; }
  else if (daysParam === "custom") {
    rangePreset = "custom";
    const validFrom = parseStatsDay(fromParam);
    const validTo = parseStatsDay(toParam);
    if (validFrom && validTo) {
      const fromMs = Date.parse(`${validFrom}T00:00:00Z`);
      const toMs = Date.parse(`${validTo}T00:00:00Z`);
      const rangeDays = Math.floor((toMs - fromMs) / 86400000) + 1;
      if (rangeDays >= 1 && rangeDays <= MAX_CUSTOM_RANGE_DAYS) {
        from = validFrom;
        to = validTo;
        days = rangeDays;
      } else {
        validationError = rangeDays > MAX_CUSTOM_RANGE_DAYS ? "custom_range_too_long" : "invalid_custom_range";
      }
    } else {
      validationError = "invalid_custom_range";
    }
  }

  const project = (params.get("project") || "").trim();
  const modelPair = (params.get("model") || "").trim() || null;
  const scope = params.get("scope") === "root" ? "root" : "all";
  const compareA = (params.get("comparea") || "").trim() || null;
  const compareB = (params.get("compareb") || "").trim() || null;

  return { days, from, to, project, modelPair, scope, compareA, compareB, rangePreset, requestedFrom, requestedTo, validationError };
}

export function statsFiltersToParams(filters: StatsFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (filters.rangePreset === "custom" || Boolean(filters.from && filters.to)) {
    p.set("days", "custom");
    p.set("from", filters.from || filters.requestedFrom || "");
    p.set("to", filters.to || filters.requestedTo || "");
  } else if (filters.days !== 30) {
    p.set("days", String(filters.days));
  }
  if (filters.project) p.set("project", filters.project);
  if (filters.modelPair) p.set("model", filters.modelPair);
  if (filters.scope === "root") p.set("scope", "root");
  if (filters.compareA) p.set("comparea", filters.compareA);
  if (filters.compareB) p.set("compareb", filters.compareB);
  return p;
}

// ── Uniform data contract helpers ───────────────────────────────────────────

/** Parse a DailyTokenStat from the provider interface into a TokenDayRow. */
export function normalizeProviderTokenStat(stat: any): TokenDayRow {
  return {
    day: String(stat.day || ""),
    input_tokens: Number(stat.inputTokens) || 0,
    output_tokens: Number(stat.outputTokens) || 0,
    reasoning_tokens: Number(stat.reasoningTokens) || 0,
    cache_read_tokens: Number(stat.cacheReadTokens) || 0,
    cache_write_tokens: Number(stat.cacheWriteTokens) || 0,
    total_tokens: Number(stat.totalTokens) || 0,
    message_count: Number(stat.messageCount) || 0,
  };
}

/**
 * Fill missing days with zero rows so the trend chart has a continuous
 * x-axis. Expects rows sorted by day ASC.
 */
export function padTokenStats(rows: TokenDayRow[], days: number, todayOverride?: Date, fromDate?: string, toDate?: string): TokenDayRow[] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const completed: TokenDayRow[] = [];

  // Custom range: use toDate as the end date and compute correct day count
  const validFrom = parseStatsDay(fromDate);
  const validTo = parseStatsDay(toDate);
  if (validFrom && validTo) {
    const fromMs = new Date(validFrom + "T00:00:00Z").getTime();
    const toMs = new Date(validTo + "T00:00:00Z").getTime();
    const rangeDays = Math.floor((toMs - fromMs) / 86400000) + 1;
    if (rangeDays >= 1 && rangeDays <= MAX_CUSTOM_RANGE_DAYS) {
      days = rangeDays;
    }
  }

  // Use the toDate (or todayOverride) as the end of the range, then go backwards
  const baseDate = validTo
    ? new Date(validTo + "T00:00:00Z")
    : (todayOverride || new Date());
  baseDate.setUTCHours(0, 0, 0, 0);

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(baseDate.getTime() - offset * 86400000);
    const day = date.toISOString().slice(0, 10);
    completed.push(byDay.get(day) || {
      day,
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 0,
      message_count: 0,
    });
  }

  return completed;
}

/**
 * Detect which token dimensions have any non-zero values across the dataset.
 */
export function detectAvailableDimensions(rows: TokenDayRow[]): { available: string[]; missing: string[] } {
  const dims = [
    { key: "input_tokens", label: "input" },
    { key: "output_tokens", label: "output" },
    { key: "reasoning_tokens", label: "reasoning" },
    { key: "cache_read_tokens", label: "cache-read" },
    { key: "cache_write_tokens", label: "cache-write" },
  ];
  const availableSet = new Set<string>();
  const missingSet = new Set<string>();

  for (const dim of dims) {
    const hasData = rows.some((row: any) => (Number(row[dim.key]) || 0) > 0);
    if (hasData) {
      availableSet.add(dim.label);
    } else {
      missingSet.add(dim.label);
    }
  }

  return { available: [...availableSet], missing: [...missingSet] };
}

/** Aggregate overview numbers from token rows. */
export function computeOverview(rows: TokenDayRow[], totalSessions: number): TokenExplorerData["overview"] {
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalMessages = 0;
  let peakDay = "";
  let peakDayTokens = 0;

  for (const row of rows) {
    totalTokens += row.total_tokens;
    inputTokens += row.input_tokens;
    outputTokens += row.output_tokens;
    reasoningTokens += row.reasoning_tokens;
    cacheReadTokens += row.cache_read_tokens;
    cacheWriteTokens += row.cache_write_tokens;
    totalMessages += row.message_count;
    if (row.total_tokens > peakDayTokens) {
      peakDayTokens = row.total_tokens;
      peakDay = row.day;
    }
  }

  return {
    totalSessions,
    totalMessages,
    totalTokens,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    peakDay,
    peakDayTokens,
    avgTokensPerSession: totalSessions > 0 ? Math.round(totalTokens / totalSessions) : 0,
  };
}
