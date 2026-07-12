// Conservative heuristic insights for Token Explorer (SQLite only).
// Pure logic, testable without database or server dependencies.
// All insights are descriptive usage patterns — not AI detection, not billing anomalies.

export interface HeuristicInsight {
  /** Unique insight key for dedup and UI references */
  key: string;
  /** Short label suitable for a card / list title */
  title: string;
  /** One-paragraph human-readable description with evidence inline */
  description: string;
  /** Severity: "high" for dramatic skews, "medium" for notable patterns, "low" for mild callouts */
  severity: "high" | "medium" | "low";
  /** Evidence numbers embedded in the description are repeated here as structured data */
  evidence: Record<string, number>;
}

export interface InsightInput {
  /** Array of daily total-token values in ASC date order */
  dailyTotals: number[];
  /** Top sessions with their token totals (first entry = #1) */
  topSessions: Array<{ sessionId: string; title: string; totalTokens: number }>;
  /** Total tokens in the selected period */
  totalTokens: number;
  /** Number of messages with non-null token data (null = coverage unavailable) */
  messagesWithTokens: number | null;
  /** Total assistant messages in the selected period (null = coverage unavailable) */
  totalAssistantMessages: number | null;
}

const MIN_DAILY_DAYS = 3;
const MIN_TOP_SESSIONS = 2;
const SPIKE_MULTIPLIER = 3.0;
const DOMINANT_SHARE_THRESHOLD = 0.4;
const LOW_COVERAGE_THRESHOLD = 0.5;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

/**
 * Detect a single-day spike where one day's total tokens exceed
 * `SPIKE_MULTIPLIER × median(non-zero days)`.
 * Requires at least MIN_DAILY_DAYS non-zero days.
 */
export function detectDailySpike(input: InsightInput): HeuristicInsight[] {
  const { dailyTotals } = input;
  const nonZero = dailyTotals.filter(v => v > 0);
  if (nonZero.length < MIN_DAILY_DAYS) return [];

  const med = median(nonZero);
  if (med <= 0) return [];

  const maxVal = Math.max(...dailyTotals);
  const threshold = med * SPIKE_MULTIPLIER;

  if (maxVal < threshold) return [];

  const maxIndex = dailyTotals.indexOf(maxVal);
  const ratio = Math.round((maxVal / med) * 10) / 10;

  return [{
    key: "daily_spike",
    title: "Unusual daily spike",
    description: `Peak day usage is ${ratio}x the median non-zero day (${maxVal.toLocaleString()} vs median ${Math.round(med).toLocaleString()} tokens). This may reflect a long-running session or batch work on that day.`,
    severity: ratio > 10 ? "high" : "medium",
    evidence: { peakTokens: maxVal, medianTokens: Math.round(med), ratio, peakIndex: maxIndex },
  }];
}

/**
 * Detect when the top session accounts for >= DOMINANT_SHARE_THRESHOLD of period total.
 * Requires at least MIN_TOP_SESSIONS sessions.
 */
export function detectDominantSession(input: InsightInput): HeuristicInsight[] {
  const { topSessions, totalTokens } = input;
  if (!topSessions || topSessions.length < MIN_TOP_SESSIONS || totalTokens <= 0) return [];
  const top = topSessions[0];
  if (!top || top.totalTokens <= 0) return [];

  const share = top.totalTokens / totalTokens;
  if (share < DOMINANT_SHARE_THRESHOLD) return [];

  const pct = Math.round(share * 100);

  return [{
    key: "dominant_session",
    title: "Dominant session",
    description: `One session accounts for ${pct}% of all tokens in this period (${top.totalTokens.toLocaleString()} tokens). Its activity may skew the overall picture.`,
    severity: share > 0.7 ? "high" : "medium",
    evidence: { topSessionTokens: top.totalTokens, totalTokens, share, topSessionIndex: 0 },
  }];
}

/**
 * Detect low token-data coverage: less than LOW_COVERAGE_THRESHOLD of assistant
 * messages have usable token data.
 */
export function detectLowCoverage(input: InsightInput): HeuristicInsight[] {
  const { messagesWithTokens, totalAssistantMessages } = input;
  // null values mean coverage is unavailable — no insight possible
  if (messagesWithTokens === null || totalAssistantMessages === null) return [];
  if (totalAssistantMessages <= 0) return [];

  const ratio = messagesWithTokens / totalAssistantMessages;
  if (ratio >= LOW_COVERAGE_THRESHOLD) return [];

  const pct = Math.round(ratio * 100);

  return [{
    key: "low_coverage",
    title: "Low token-data coverage",
    description: `Only ${pct}% of assistant messages (${messagesWithTokens} of ${totalAssistantMessages}) include usable token data. Trends may not represent full usage.`,
    severity: ratio < 0.2 ? "high" : ratio < 0.4 ? "medium" : "low",
    evidence: { messagesWithTokens, totalAssistantMessages, ratio },
  }];
}

/**
 * Run all detectors, returning a flat array of insights sorted by severity (high first).
 * Each detector independently decides whether to fire; no cross-detector dedup needed.
 */
export function computeHeuristicInsights(input: InsightInput): HeuristicInsight[] {
  const results = [
    ...detectDailySpike(input),
    ...detectDominantSession(input),
    ...detectLowCoverage(input),
  ];
  // Sort: high → medium → low
  const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
  results.sort((a, b) => order[a.severity] - order[b.severity]);
  return results;
}
