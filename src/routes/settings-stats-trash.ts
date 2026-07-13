import {
  getCompareModelStats,
  getFilteredSessionCount,
  getModelDistribution,
  getModelPairs,
  getPreviousPeriodAggregates,
  getSessionsByIds,
  getStatsProjects,
  getTokenCoverage,
  getTokenStats,
  getTopTokenSessions,
} from "../db.js";
import { statSync } from "node:fs";
import { getAllMeta, getDeletedIds } from "../meta.js";
import { getIndexedSessions } from "../index-db.js";
import {
  normalizeSessionRecord,
  enrichSession,
} from "../session-queries.js";
import { json, missingProviderResponse, send } from "../server-helpers.js";
import { usesSqliteSessionStore, supportsLocalManagement } from "../providers/kinds.js";
import { supportsSessionAnalysis } from "../providers/kinds.js";
import { OPENCODE_ANALYSIS_COMMAND } from "../analysis.js";
import { readUserConfigDocument } from "../config.js";
import { getProvider } from "../providers/index.js";
import { renderSettingsPage } from "../views/settings.js";
import { renderStatsDeferredSection, renderStatsPage } from "../views/stats.js";
import { renderTrashPage } from "../views/trash.js";
import { providerRenderContext } from "./provider-context.js";
import {
  parseStatsFilters,
  parseStatsDay,
  padTokenStats,
  normalizeProviderTokenStat,
  computeOverview,
} from "../stats-data.js";
import type { TokenExplorerData, TokenDayRow, ModelRankEntry, TopSessionEntry, CoverageInfo, StatsCapabilities } from "../stats-data.js";
import { computePreviousRange, buildComparison } from "../stats-comparison.js";
import type { ComparisonResult } from "../stats-comparison.js";
import { computeHeuristicInsights } from "../stats-insights.js";
import type { HeuristicInsight } from "../stats-insights.js";
import { computeCostEstimate } from "../stats-cost.js";
import type { CostEstimate, TokenPricingEntry } from "../stats-cost.js";
import { createStatsCache } from "../stats-cache.js";

export function registerSettingsStatsTrash(
  app: any,
  deps: {
    appConfig: any;
    providerMap: Map<string, any>;
    providerInfo: any[];
  }
) {
  const { appConfig, providerMap, providerInfo } = deps;
  const statsCache = createStatsCache();

  function statsSourceFingerprint(adapter: any) {
    const revision = adapter.getStatsRevision?.();
    if (revision !== undefined && revision !== null) return `revision:${revision}`;
    const dataPath = adapter.getDataPath?.();
    try {
      const stat = dataPath ? statSync(dataPath) : null;
      return stat ? `${dataPath}:${stat.size}:${stat.mtimeMs}` : `missing:${dataPath || ""}`;
    } catch {
      return `missing:${dataPath || ""}`;
    }
  }

  function statsQueryKey(providerId: string, searchParams: URLSearchParams, detail: "initial" | "full") {
    const pairs = [...searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    );
    return `${detail}:${providerId}:${new URLSearchParams(pairs).toString()}`;
  }

  // Settings page
  app.get("/:provider/settings", async (_req: any, _res: any, params: any) => {
    const providerSegment = params.provider;
    const currentProvider = getProvider(providerSegment);
    const adapter = providerMap.get(providerSegment);

    if (!currentProvider) {
      return { status: 404, body: "<h1>Provider not found</h1>", contentType: "text/html; charset=utf-8" };
    }

    const configDocument = readUserConfigDocument(appConfig.configPath);
    return {
      status: 200,
      body: renderSettingsPage({
        configPath: appConfig.configPath,
        configDocument,
        terminalLaunchAllowed: Boolean(appConfig.allowTerminalLaunch),
        providerName: currentProvider.name,
        resumeDefault: currentProvider.resumeCommand || null,
        analysisDefaultCommand: supportsSessionAnalysis(currentProvider) ? OPENCODE_ANALYSIS_COMMAND : null,
        providerAvailable: Boolean(adapter),
        ...providerRenderContext(providerSegment, providerInfo, adapter)
      }),
      contentType: "text/html; charset=utf-8"
    };
  });

  // ── Helper: build Token Explorer data for SQLite providers ────────────────

  function buildSqliteTokenExplorer(adapter: any, providerSegment: string, searchParams: URLSearchParams, detail: "initial" | "full" = "full"): Omit<TokenExplorerData, 'provider' | 'providers' | 'manageable'> & { dayDrill: string | null; modelPairs: any[]; projects: Array<{ projectId: string; label: string; count: number }> } {
    const dbPath = adapter.getDataPath();
    const filters = parseStatsFilters(searchParams);
    const dayDrill = parseStatsDay(searchParams.get("day"));
    const capabilities: StatsCapabilities = { customRange: true, project: true, model: true, scope: true, dayDrill: true, composition: true, modelRanking: true, sessionBreakdown: true, coverage: true };

    if (filters.validationError) {
      const coverage: CoverageInfo = {
        messagesWithTokens: 0,
        totalAssistantMessages: 0,
        sessionsWithTokens: 0,
        totalSessions: 0,
        availableDimensions: [],
        missingDimensions: [],
      };
      return {
        filters,
        tokenStats: [],
        modelRanking: [],
        topSessions: [],
        coverage,
        overview: computeOverview([], 0),
        comparison: null,
        insights: [],
        costEstimate: null,
        compareA: null,
        compareB: null,
        dayDrill: null,
        modelPairs: [],
        projects: [],
        capabilities,
      };
    }

    const tokenStatRows = getTokenStats(filters.days, dbPath, {
      project: filters.project || undefined,
      modelPair: filters.modelPair || undefined,
      scope: filters.scope,
      fromDate: filters.from || undefined,
      toDate: filters.to || undefined,
    });

    const tokenStats: TokenDayRow[] = (Array.isArray(tokenStatRows) ? tokenStatRows : []).map((row: any) => ({
      day: String(row.day || ""),
      input_tokens: Number(row.input_tokens) || 0,
      output_tokens: Number(row.output_tokens) || 0,
      reasoning_tokens: Number(row.reasoning_tokens) || 0,
      cache_read_tokens: Number(row.cache_read_tokens) || 0,
      cache_write_tokens: Number(row.cache_write_tokens) || 0,
      total_tokens: Number(row.total_tokens) || 0,
      message_count: Number(row.message_count) || 0,
    }));

    const padded = padTokenStats(tokenStats, filters.days, undefined, filters.from || undefined, filters.to || undefined);

    // Model distribution ranked by tokens
    const distRows = getModelDistribution(dbPath, {
      days: filters.days,
      fromDate: filters.from || undefined,
      toDate: filters.to || undefined,
      project: filters.project || undefined,
      modelPair: filters.modelPair || undefined,
      scope: filters.scope,
    });
    const modelRanking: ModelRankEntry[] = (distRows as any[]).map((row: any) => ({
      modelId: String(row.model || "unknown"),
      providerId: String(row.provider || "unknown"),
      key: `${row.provider || "unknown"}/${row.model || "unknown"}`,
      totalTokens: Number(row.total_tokens) || 0,
      sessionCount: 0,
      messageCount: Number(row.count) || 0,
    }));

    // With no active model filter, the ranking and selector have exactly the
    // same dataset. Reuse it rather than scanning messages twice.
    const modelPairs = filters.modelPair
      ? (getModelPairs(dbPath, {
          days: filters.days,
          fromDate: filters.from || undefined,
          toDate: filters.to || undefined,
          project: filters.project || undefined,
          scope: filters.scope,
        }) as any[]).map((row: any) => ({
          key: String(row.key || ""),
          model: String(row.model || "unknown"),
          provider: String(row.provider || "unknown"),
          totalTokens: Number(row.total_tokens) || 0,
        }))
      : modelRanking.map((row) => ({
          key: row.key,
          model: row.modelId,
          provider: row.providerId,
          totalTokens: row.totalTokens,
        }));

    // Session count for overview (from message table)
    const totalSessions = getFilteredSessionCount(dbPath, {
      days: filters.days,
      fromDate: filters.from || undefined,
      toDate: filters.to || undefined,
      project: filters.project || undefined,
      modelPair: filters.modelPair || undefined,
      scope: filters.scope,
    });
    const overview = computeOverview(padded, totalSessions);

    if (detail === "initial") {
      const projects = getStatsProjects(dbPath, {
        days: filters.days,
        fromDate: filters.from || undefined,
        toDate: filters.to || undefined,
        scope: filters.scope,
      });
      return {
        filters, tokenStats: padded, modelRanking, topSessions: [], coverage: null,
        overview, comparison: null, insights: [], costEstimate: null, compareA: null, compareB: null,
        dayDrill, modelPairs, projects, capabilities,
      };
    }

    // Top sessions and coverage are deferred from the initial page render.
    const topRows = getTopTokenSessions(dbPath, {
      days: filters.days,
      fromDate: filters.from || undefined,
      toDate: filters.to || undefined,
      project: filters.project || undefined,
      modelPair: filters.modelPair || undefined,
      scope: filters.scope,
      day: dayDrill || undefined,
      limit: 20,
    });
    const topSessions: TopSessionEntry[] = (topRows as any[]).map((row: any) => ({
      sessionId: String(row.session_id || ""),
      title: String(row.title || ""),
      directory: String(row.directory || ""),
      providerModel: String(row.provider_model || ""),
      modelCount: Number(row.model_count) || 0,
      totalTokens: Number(row.total_tokens) || 0,
      messageCount: Number(row.message_count) || 0,
      timeUpdated: Number(row.time_updated) || 0,
    }));

    const covRaw = getTokenCoverage(dbPath, {
      days: filters.days,
      fromDate: filters.from || undefined,
      toDate: filters.to || undefined,
      project: filters.project || undefined,
      modelPair: filters.modelPair || undefined,
      scope: filters.scope,
    });
    const dimensionEntries = [
      ["input", covRaw.dimensions.input],
      ["output", covRaw.dimensions.output],
      ["reasoning", covRaw.dimensions.reasoning],
      ["cache-read", covRaw.dimensions.cacheRead],
      ["cache-write", covRaw.dimensions.cacheWrite],
    ] as const;
    const coverage: CoverageInfo = {
      messagesWithTokens: covRaw.messagesWithTokens,
      totalAssistantMessages: covRaw.totalAssistantMessages,
      availableDimensions: dimensionEntries.filter(([, present]) => present).map(([name]) => name),
      missingDimensions: dimensionEntries.filter(([, present]) => !present).map(([name]) => name),
      sessionsWithTokens: covRaw.sessionsWithTokens,
      totalSessions: covRaw.totalSessions,
    };

    // ── Comparison (same-period) ────────────────────────────────────────
    let comparison: ComparisonResult | null = null;
    if (filters.from && filters.to && filters.validationError === null) {
      const prev = computePreviousRange(filters.from, filters.to);
      const prevAgg = getPreviousPeriodAggregates(dbPath, {
        fromDate: prev.from,
        toDate: prev.to,
        project: filters.project || undefined,
        modelPair: filters.modelPair || undefined,
        scope: filters.scope,
      });
      const curAgg = { tokens: overview.totalTokens, sessions: totalSessions, records: overview.totalMessages };
      comparison = buildComparison(curAgg, prevAgg, prev.from, prev.to, prev.days);
    } else if (!filters.from && !filters.to && filters.validationError === null) {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const currentTo = today.toISOString().slice(0, 10);
      const currentFrom = new Date(today.getTime() - (filters.days - 1) * 86400000).toISOString().slice(0, 10);
      const prev = computePreviousRange(currentFrom, currentTo);
      const prevAgg = getPreviousPeriodAggregates(dbPath, {
        fromDate: prev.from,
        toDate: prev.to,
        project: filters.project || undefined,
        modelPair: filters.modelPair || undefined,
        scope: filters.scope,
      });
      const curAgg = { tokens: overview.totalTokens, sessions: totalSessions, records: overview.totalMessages };
      comparison = buildComparison(curAgg, prevAgg, prev.from, prev.to, prev.days);
    }

    // ── Heuristic insights ──────────────────────────────────────────────
    const insightInput = {
      dailyTotals: padded.map((r: TokenDayRow) => r.total_tokens),
      topSessions: topSessions.map((s: any) => ({ sessionId: s.sessionId, title: s.title, totalTokens: s.totalTokens })),
      totalTokens: overview.totalTokens,
      messagesWithTokens: coverage.messagesWithTokens,
      totalAssistantMessages: coverage.totalAssistantMessages,
    };
    const insights: HeuristicInsight[] = computeHeuristicInsights(insightInput);

    // ── Two-model comparison ────────────────────────────────────────────
    let compareA: any = null;
    let compareB: any = null;
    const modelPairsMap = new Map(modelPairs.map((m: any) => [m.key, m]));
    if (
      filters.compareA
      && filters.compareB
      && filters.compareA !== filters.compareB
      && modelPairsMap.has(filters.compareA)
      && modelPairsMap.has(filters.compareB)
    ) {
      const compareOpts = {
        days: filters.days,
        fromDate: filters.from || undefined,
        toDate: filters.to || undefined,
        project: filters.project || undefined,
        scope: filters.scope,
      };
      const statsA = getCompareModelStats(dbPath, { ...compareOpts, modelKey: filters.compareA });
      const statsB = getCompareModelStats(dbPath, { ...compareOpts, modelKey: filters.compareB });
      const pairA = modelPairsMap.get(filters.compareA);
      const pairB = modelPairsMap.get(filters.compareB);
      compareA = { key: filters.compareA, model: pairA.model, provider: pairA.provider, ...statsA };
      compareB = { key: filters.compareB, model: pairB.model, provider: pairB.provider, ...statsB };
    }

    // ── Cost estimate ───────────────────────────────────────────────────
    let costEstimate: CostEstimate | null = null;
    if (filters.modelPair) {
      const pricingDoc = (deps.appConfig && deps.appConfig.tokenPricing) || {};
      if (pricingDoc && typeof pricingDoc === "object" && pricingDoc[filters.modelPair]) {
        const entry = pricingDoc[filters.modelPair];
        costEstimate = computeCostEstimate(entry as TokenPricingEntry, {
          inputTokens: overview.inputTokens,
          outputTokens: overview.outputTokens,
          reasoningTokens: overview.reasoningTokens,
          cacheReadTokens: overview.cacheReadTokens,
          cacheWriteTokens: overview.cacheWriteTokens,
        });
      }
    }

    // Projects for filter dropdown
    const projects = getStatsProjects(dbPath, {
      days: filters.days,
      fromDate: filters.from || undefined,
      toDate: filters.to || undefined,
      scope: filters.scope,
    });

    return { filters, tokenStats: padded, modelRanking, topSessions, coverage, overview, comparison, insights, costEstimate, compareA, compareB, dayDrill, modelPairs, projects, capabilities };
  }

  // ── Helper: build Token Explorer data for file-based providers ───────────

  function buildFileBasedTokenExplorer(adapter: any, providerSegment: string, searchParams: URLSearchParams): Omit<TokenExplorerData, 'provider' | 'providers' | 'manageable'> & { dayDrill: string | null; modelPairs: any[]; projects: null } {
    const requestedFilters = parseStatsFilters(searchParams);
    const filters = {
      ...requestedFilters,
      days: requestedFilters.from || requestedFilters.to ? 30 : requestedFilters.days,
      from: null,
      to: null,
      project: "",
      modelPair: null,
      scope: "all" as const,
      rangePreset: ([7, 90].includes(requestedFilters.days) ? String(requestedFilters.days) : "30") as "7" | "30" | "90",
      requestedFrom: "",
      requestedTo: "",
      validationError: null,
    };
    const dayDrill = null;
    const capabilities: StatsCapabilities = { customRange: false, project: false, model: false, scope: false, dayDrill: false, composition: false, modelRanking: false, sessionBreakdown: false, coverage: false };

    // Token stats from adapter
    const rawStats = adapter.getTokenStats(filters.days);
    const tokenStats = (Array.isArray(rawStats) ? rawStats : []).map(normalizeProviderTokenStat);
    const padded = padTokenStats(tokenStats, filters.days, undefined, filters.from || undefined, filters.to || undefined);

    // Model ranking: not available for most file-based providers
    const modelRanking: ModelRankEntry[] = [];
    const modelPairs: any[] = [];

    // The adapter exposes aggregate daily usage only. Session-level rankings
    // would mix different timestamp and child-session semantics, so omit them.
    const topSessions: TopSessionEntry[] = [];

    const totalTokens = padded.reduce((sum: number, r: TokenDayRow) => sum + r.total_tokens, 0);
    const totalMessages = padded.reduce((sum: number, r: TokenDayRow) => sum + r.message_count, 0);

    // File-based providers: coverage is null (no database to query)
    const coverage: CoverageInfo | null = null;

    const overview = {
      totalSessions: 0,
      totalMessages,
      totalTokens,
      inputTokens: padded.reduce((s, r) => s + r.input_tokens, 0),
      outputTokens: padded.reduce((s, r) => s + r.output_tokens, 0),
      reasoningTokens: padded.reduce((s, r) => s + r.reasoning_tokens, 0),
      cacheReadTokens: padded.reduce((s, r) => s + r.cache_read_tokens, 0),
      cacheWriteTokens: padded.reduce((s, r) => s + r.cache_write_tokens, 0),
      peakDay: padded.reduce((best, r) => r.total_tokens > (best.total_tokens || 0) ? r : best, { day: "", total_tokens: 0 } as any).day,
      peakDayTokens: Math.max(...padded.map(r => r.total_tokens), 0),
      avgTokensPerSession: 0,
    };

    // Projects: null means unavailable (file-based providers)
    return { filters, tokenStats: padded, modelRanking, topSessions, coverage, overview, comparison: null, insights: [] as any[], costEstimate: null, compareA: null, compareB: null, dayDrill, modelPairs, projects: null, capabilities };
  }

  function buildTokenExplorer(adapter: any, providerId: string, searchParams: URLSearchParams, detail: "initial" | "full" = "full") {
    return usesSqliteSessionStore(adapter)
      ? buildSqliteTokenExplorer(adapter, providerId, searchParams, detail)
      : buildFileBasedTokenExplorer(adapter, providerId, searchParams);
  }

  function buildCachedTokenExplorer(adapter: any, providerId: string, searchParams: URLSearchParams, detail: "initial" | "full" = "full") {
    const fingerprint = `${statsSourceFingerprint(adapter)}:${JSON.stringify(appConfig.tokenPricing || {})}`;
    const key = statsQueryKey(providerId, searchParams, detail);
    return statsCache.getOrBuild(key, fingerprint, () => buildTokenExplorer(adapter, providerId, searchParams, detail));
  }

  // ── Stats / Token Explorer page ───────────────────────────────────────────

  app.get("/:provider/stats", async (req: any, _res: any, params: any) => {
    const providerSegment = params.provider;
    const adapter = providerMap.get(providerSegment);

    if (!adapter) {
      return { status: 404, body: "<h1>Not found</h1>", contentType: "text/html; charset=utf-8" };
    }

    const renderContext = providerRenderContext(providerSegment, providerInfo, adapter);
    const searchParams = new URL(req.url || "/", "http://localhost").searchParams;

    try {
      const tokenExplorer = buildCachedTokenExplorer(adapter, providerSegment, searchParams, "initial");
      const deferredUrl = `/api/${encodeURIComponent(providerSegment)}/stats/deferred?${searchParams.toString()}`;

      return {
        status: 200,
        body: renderStatsPage({ ...tokenExplorer, ...renderContext, deferredUrl }),
        contentType: "text/html; charset=utf-8"
      };
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return { status: 500, body: JSON.stringify({ error: "Internal server error" }), contentType: "application/json; charset=utf-8" };
    }
  });

  // Deferred Token Explorer sections. This keeps the initial response focused
  // on filters, KPIs, trend data, and the model ranking.
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/stats\/deferred$/, async (req: any, _res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const adapter = providerMap.get(providerId);
    if (!adapter) return { status: 404, body: "", contentType: "text/html; charset=utf-8" };

    const section = new URL(req.url || "/", "http://localhost").searchParams.get("section");
    if (section !== "secondary" && section !== "advanced") {
      return { status: 400, body: "", contentType: "text/html; charset=utf-8" };
    }

    try {
      const searchParams = new URL(req.url || "/", "http://localhost").searchParams;
      searchParams.delete("section");
      const data = buildCachedTokenExplorer(adapter, providerId, searchParams, "full");
      return {
        status: 200,
        body: renderStatsDeferredSection({ ...data, provider: providerId }, section),
        contentType: "text/html; charset=utf-8"
      };
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return { status: 500, body: "", contentType: "text/html; charset=utf-8" };
    }
  });

  // Trash page
  app.get("/:provider/trash", async (_req: any, _res: any, params: any) => {
    const providerSegment = params.provider;
    const adapter = providerMap.get(providerSegment);

    if (!supportsLocalManagement(adapter)) {
      return { status: 404, body: "<h1>Not found</h1>", contentType: "text/html; charset=utf-8" };
    }

    const renderContext = providerRenderContext(providerSegment, providerInfo, adapter);

    try {
      const deletedIds = getDeletedIds(providerSegment);
      const sessions = usesSqliteSessionStore(adapter)
        ? getSessionsByIds(deletedIds, adapter.getDataPath())
        : getIndexedSessions(providerSegment, Math.max(1, deletedIds.length), 0, "", "", "", "updated-desc", deletedIds).sessions;
      const metaMap = getAllMeta(providerSegment);
      const enriched = sessions.map((session: any) => normalizeSessionRecord(enrichSession(session, metaMap)));
      return {
        status: 200,
        body: renderTrashPage({ sessions: enriched, ...renderContext }),
        contentType: "text/html; charset=utf-8"
      };
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return { status: 500, body: JSON.stringify({ error: "Internal server error" }), contentType: "application/json; charset=utf-8" };
    }
  });

  // API: stats JSON export
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/stats\/export\.json$/, async (_req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const adapter = providerMap.get(providerId);
    if (!adapter) return json(res, { error: "Provider not found" }, 404);

    try {
      const searchParams = new URL(_req.url || "/", "http://localhost").searchParams;
      const data = buildCachedTokenExplorer(adapter, providerId, searchParams);
      return {
        status: data.filters.validationError ? 400 : 200,
        body: JSON.stringify({
          filters: data.filters,
          capabilities: data.capabilities,
          overview: data.overview,
          comparison: data.comparison,
          insights: data.insights,
          tokenStats: data.tokenStats,
          modelRanking: data.modelRanking,
          topSessions: data.topSessions,
          coverage: data.coverage,
          costEstimate: data.costEstimate,
          compareA: data.compareA,
          compareB: data.compareB,
        }, null, 2),
        contentType: "application/json; charset=utf-8",
        headers: { "Content-Disposition": `attachment; filename="token-explorer-${providerId}.json"` },
      };
    } catch (err: any) {
      return json(res, { error: "Internal server error" }, 500);
    }
  });

  // API: stats CSV export (daily series)
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/stats\/export\.csv$/, async (_req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const adapter = providerMap.get(providerId);
    if (!adapter) return json(res, { error: "Provider not found" }, 404);

    try {
      const searchParams = new URL(_req.url || "/", "http://localhost").searchParams;
      const data = buildCachedTokenExplorer(adapter, providerId, searchParams);
      if (data.filters.validationError) {
        return {
          status: 400,
          body: JSON.stringify({ error: data.filters.validationError, filters: data.filters }),
          contentType: "application/json; charset=utf-8",
        };
      }
      const rows: TokenDayRow[] = data.tokenStats;
      const compositionMode = data.capabilities?.composition ? "exclusive" : "aggregate-total-only";

      const escape = (v: any) => `"${String(v).replace(/"/g, '""')}"`;
      const header = "Provider,Composition Mode,Day (UTC),Total Tokens,Input Tokens,Output Tokens,Reasoning Tokens,Cache Read Tokens,Cache Write Tokens,Messages\n";
      const csvRows = rows.map((r: TokenDayRow) =>
        `${escape(providerId)},${escape(compositionMode)},${escape(r.day)},${r.total_tokens},${r.input_tokens},${r.output_tokens},${r.reasoning_tokens},${r.cache_read_tokens},${r.cache_write_tokens},${r.message_count}`
      ).join("\n");

      const csv = header + csvRows + "\n";
      return {
        status: 200,
        body: csv,
        contentType: "text/csv; charset=utf-8",
        headers: { "Content-Disposition": `attachment; filename="token-explorer-${providerId}.csv"` },
      };
    } catch (err: any) {
      return json(res, { error: "Internal server error" }, 500);
    }
  });

  // API: stats (downgraded to minimal; full explorer is HTML-only for now)
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/stats$/, async (_req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const adapter = providerMap.get(providerId);
    if (!adapter) {
      const missing = missingProviderResponse(providerId);
      return json(res, missing.body, missing.status);
    }

    try {
      const searchParams = new URL(_req.url || "/", "http://localhost").searchParams;
      const cached = buildCachedTokenExplorer(adapter, providerId, searchParams, "initial");
      const filters = cached.filters;

      if (usesSqliteSessionStore(adapter)) {
        return json(res, { filters, tokenStats: cached.tokenStats, totalTokens: cached.overview.totalTokens });
      }

      return json(res, { filters, tokenStats: cached.tokenStats, totalTokens: cached.overview.totalTokens });
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return json(res, { error: "Internal server error" }, 500);
    }
  });
}
