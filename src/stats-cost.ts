// Opt-in cost estimation for Token Explorer.
// Does NOT embed any vendor price catalog.
// Reads user-supplied `tokenPricing` from config and estimates cost
// for the current single-model filtered view.

export interface TokenPricingEntry {
  /** ISO 4217 currency code, e.g. "USD", "CNY". Required. */
  currency: string;
  /** Price per million input tokens. Must be finite >= 0. Required. */
  inputPerMillion: number;
  /** Price per million output tokens. Must be finite >= 0. Required. */
  outputPerMillion: number;
  /** Price per million reasoning tokens (optional). */
  reasoningPerMillion?: number;
  /** Price per million cache-read tokens (optional). */
  cacheReadPerMillion?: number;
  /** Price per million cache-write tokens (optional). */
  cacheWritePerMillion?: number;
  /** Human-readable source label, e.g. "AWS Bedrock us-east-1" */
  sourceLabel?: string;
  /** URL to the published pricing page */
  sourceUrl?: string;
  /** ISO date when this pricing was last verified */
  asOf?: string;
}

export interface TokenPricingDocument {
  /** Map of "providerId/modelId" → pricing entry */
  [modelKey: string]: TokenPricingEntry;
}

export interface CostEstimate {
  /** Estimated total cost */
  totalCost: number;
  /** Currency from the matching pricing entry */
  currency: string;
  /** Source label from the matching pricing entry */
  sourceLabel: string;
  /** Source URL from the matching pricing entry */
  sourceUrl: string;
  /** As-of date from the matching pricing entry */
  asOf: string;
  /** Breakdown by dimension (only dimensions present in both pricing and token data) */
  breakdown: {
    input?: { tokens: number; cost: number };
    output?: { tokens: number; cost: number };
    reasoning?: { tokens: number; cost: number };
    cacheRead?: { tokens: number; cost: number };
    cacheWrite?: { tokens: number; cost: number };
  };
  /** Dimensions present in token data but not in pricing (no rate = can't estimate) */
  omittedDimensions: string[];
}

/**
 * Cost per token = perMillionRate / 1_000_000.
 * Returns 0 for negative or NaN rates (defensive).
 */
function ratePerToken(perMillion: number | undefined): number {
  if (perMillion === undefined || perMillion === null) return 0;
  if (!Number.isFinite(perMillion) || perMillion < 0) return 0;
  return perMillion / 1_000_000;
}

/**
 * Validate a single TokenPricingEntry.
 * Returns an array of error messages; empty array = valid.
 */
export function validatePricingEntry(entry: unknown, keyPath: string): string[] {
  const errors: string[] = [];
  if (!entry || typeof entry !== "object") {
    errors.push(`${keyPath}: must be an object`);
    return errors;
  }
  const e = entry as Record<string, unknown>;

  if (typeof e.currency !== "string" || !/^[A-Za-z]{3}$/.test(e.currency.trim())) {
    errors.push(`${keyPath}.currency: must be a three-letter ISO 4217 code`);
  }
  if (typeof e.inputPerMillion !== "number" || !Number.isFinite(e.inputPerMillion) || e.inputPerMillion < 0) {
    errors.push(`${keyPath}.inputPerMillion: must be a finite non‑negative number`);
  }
  if (typeof e.outputPerMillion !== "number" || !Number.isFinite(e.outputPerMillion) || e.outputPerMillion < 0) {
    errors.push(`${keyPath}.outputPerMillion: must be a finite non‑negative number`);
  }
  for (const field of ["reasoningPerMillion", "cacheReadPerMillion", "cacheWritePerMillion"] as const) {
    if (e[field] !== undefined && (typeof e[field] !== "number" || !Number.isFinite(e[field]) || (e[field] as number) < 0)) {
      errors.push(`${keyPath}.${field}: must be a finite non‑negative number when provided`);
    }
  }
  if (e.sourceLabel !== undefined && (typeof e.sourceLabel !== "string" || e.sourceLabel.length > 200)) {
    errors.push(`${keyPath}.sourceLabel: must be a string of at most 200 characters when provided`);
  }
  if (e.sourceUrl !== undefined) {
    if (typeof e.sourceUrl !== "string") {
      errors.push(`${keyPath}.sourceUrl: must be a string when provided`);
    } else {
      try {
        const parsed = new URL(e.sourceUrl);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("unsupported protocol");
      } catch {
        errors.push(`${keyPath}.sourceUrl: must be an absolute http or https URL when provided`);
      }
    }
  }
  if (e.asOf !== undefined && (typeof e.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.asOf))) {
    errors.push(`${keyPath}.asOf: must use YYYY-MM-DD when provided`);
  }
  return errors;
}

/**
 * Validate the entire tokenPricing document.
 */
export function validateTokenPricing(doc: unknown): string[] {
  const errors: string[] = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    errors.push("tokenPricing: must be an object mapping model keys to pricing entries");
    return errors;
  }
  for (const [key, entry] of Object.entries(doc as Record<string, unknown>)) {
    if (!key.includes("/") || key.startsWith("/") || key.endsWith("/")) {
      errors.push(`tokenPricing.${key}: key must use provider/model format`);
    }
    errors.push(...validatePricingEntry(entry, `tokenPricing.${key}`));
  }
  return errors;
}

/**
 * Compute cost estimate when the current view is filtered to one model and a
 * matching pricing entry exists.
 *
 * @param pricing  the pricing entry matching the current model filter
 * @param tokens   the token dimension totals from the current overview
 */
export function computeCostEstimate(
  pricing: TokenPricingEntry,
  tokens: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  },
): CostEstimate {
  const breakdown: CostEstimate["breakdown"] = {};
  let totalCost = 0;
  const omittedDimensions: string[] = [];

  // Input (always required in pricing)
  if (tokens.inputTokens > 0) {
    const cost = tokens.inputTokens * ratePerToken(pricing.inputPerMillion);
    breakdown.input = { tokens: tokens.inputTokens, cost };
    totalCost += cost;
  }

  // Output (always required in pricing)
  if (tokens.outputTokens > 0) {
    const cost = tokens.outputTokens * ratePerToken(pricing.outputPerMillion);
    breakdown.output = { tokens: tokens.outputTokens, cost };
    totalCost += cost;
  }

  // Reasoning
  if (tokens.reasoningTokens > 0) {
    if (pricing.reasoningPerMillion !== undefined) {
      const cost = tokens.reasoningTokens * ratePerToken(pricing.reasoningPerMillion);
      breakdown.reasoning = { tokens: tokens.reasoningTokens, cost };
      totalCost += cost;
    } else {
      omittedDimensions.push("reasoning");
    }
  }

  // Cache read
  if (tokens.cacheReadTokens > 0) {
    if (pricing.cacheReadPerMillion !== undefined) {
      const cost = tokens.cacheReadTokens * ratePerToken(pricing.cacheReadPerMillion);
      breakdown.cacheRead = { tokens: tokens.cacheReadTokens, cost };
      totalCost += cost;
    } else {
      omittedDimensions.push("cache-read");
    }
  }

  // Cache write
  if (tokens.cacheWriteTokens > 0) {
    if (pricing.cacheWritePerMillion !== undefined) {
      const cost = tokens.cacheWriteTokens * ratePerToken(pricing.cacheWritePerMillion);
      breakdown.cacheWrite = { tokens: tokens.cacheWriteTokens, cost };
      totalCost += cost;
    } else {
      omittedDimensions.push("cache-write");
    }
  }

  return {
    totalCost,
    currency: pricing.currency.trim().toUpperCase(),
    sourceLabel: pricing.sourceLabel || "",
    sourceUrl: pricing.sourceUrl || "",
    asOf: pricing.asOf || "",
    breakdown,
    omittedDimensions,
  };
}
