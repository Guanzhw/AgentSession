// Same-period comparison logic for Token Explorer (SQLite only).
// Computes the immediately preceding period with the same number of UTC days
// and the same project/model/scope filters.

export interface ComparisonResult {
  /** Current period total tokens */
  currentTotalTokens: number;
  /** Previous period total tokens */
  previousTotalTokens: number;
  /** Current period usage sessions (distinct sessions with token data) */
  currentUsageSessions: number;
  /** Previous period usage sessions */
  previousUsageSessions: number;
  /** Current period usage records (assistant messages with token data) */
  currentUsageRecords: number;
  /** Previous period usage records */
  previousUsageRecords: number;
  /** Current tokens per usage session (null if no sessions) */
  currentTokensPerSession: number | null;
  /** Previous tokens per usage session (null if no sessions) */
  previousTokensPerSession: number | null;
  /** Current tokens per usage record (null if no records) */
  currentTokensPerRecord: number | null;
  /** Previous tokens per usage record (null if no records) */
  previousTokensPerRecord: number | null;
  /** Absolute delta: currentTotal - previousTotal */
  totalDelta: number;
  /** Percent delta: (totalDelta / previousTotal) * 100, or null if previous is zero */
  totalDeltaPercent: number | null;
  /** ISO start date of the previous period */
  previousFrom: string;
  /** ISO end date of the previous period */
  previousTo: string;
  /** The number of UTC days in each period (they match) */
  periodDays: number;
}

/**
 * Given a current date range (inclusive ISO dates) and UTC day count, compute the
 * immediately preceding period of the same length.
 *
 * Example: current 2025-03-08 to 2025-03-14 (7 days) → previous 2025-03-01 to 2025-03-07.
 */
export function computePreviousRange(
  currentFrom: string,
  currentTo: string,
): { from: string; to: string; days: number } {
  const fromMs = Date.parse(currentFrom + "T00:00:00Z");
  const toMs = Date.parse(currentTo + "T00:00:00Z");
  const days = Math.floor((toMs - fromMs) / 86400000) + 1;

  const previousToMs = fromMs - 86400000;
  const previousFromMs = previousToMs - (days - 1) * 86400000;

  return {
    from: new Date(previousFromMs).toISOString().slice(0, 10),
    to: new Date(previousToMs).toISOString().slice(0, 10),
    days,
  };
}

/**
 * Build a ComparisonResult from two sets of aggregate numbers.
 *
 * @param current  tokens, sessions, records for the current period
 * @param previous tokens, sessions, records for the previous period
 * @param previousFrom ISO date string (start)
 * @param previousTo   ISO date string (end)
 * @param periodDays   number of days in each period
 */
export function buildComparison(
  current: { tokens: number; sessions: number; records: number },
  previous: { tokens: number; sessions: number; records: number },
  previousFrom: string,
  previousTo: string,
  periodDays: number,
): ComparisonResult {
  const currentTokensPerSession = current.sessions > 0 ? current.tokens / current.sessions : null;
  const previousTokensPerSession = previous.sessions > 0 ? previous.tokens / previous.sessions : null;
  const currentTokensPerRecord = current.records > 0 ? current.tokens / current.records : null;
  const previousTokensPerRecord = previous.records > 0 ? previous.tokens / previous.records : null;

  const totalDelta = current.tokens - previous.tokens;
  const totalDeltaPercent = previous.tokens > 0
    ? Number((((current.tokens - previous.tokens) / previous.tokens) * 100).toFixed(1))
    : null;

  return {
    currentTotalTokens: current.tokens,
    previousTotalTokens: previous.tokens,
    currentUsageSessions: current.sessions,
    previousUsageSessions: previous.sessions,
    currentUsageRecords: current.records,
    previousUsageRecords: previous.records,
    currentTokensPerSession: currentTokensPerSession !== null ? Math.round(currentTokensPerSession) : null,
    previousTokensPerSession: previousTokensPerSession !== null ? Math.round(previousTokensPerSession) : null,
    currentTokensPerRecord: currentTokensPerRecord !== null ? Math.round(currentTokensPerRecord) : null,
    previousTokensPerRecord: previousTokensPerRecord !== null ? Math.round(previousTokensPerRecord) : null,
    totalDelta,
    totalDeltaPercent,
    previousFrom,
    previousTo,
    periodDays,
  };
}
