import {
  getDailySessionCounts,
  getModelDistribution,
  getOverviewStats,
  getSessionsByIds,
  getStats,
  getTokenStats
} from "../db.js";
import { getAllMeta, getDeletedIds } from "../meta.js";
import { getIndexedSessions } from "../index-db.js";
import {
  normalizeSessionRecord,
  enrichSession,
  completeTokenStats
} from "../session-queries.js";
import { json, missingProviderResponse, send } from "../server-helpers.js";
import { usesSqliteSessionStore, supportsLocalManagement } from "../providers/kinds.js";
import { supportsSessionAnalysis } from "../providers/kinds.js";
import { OPENCODE_ANALYSIS_COMMAND } from "../analysis.js";
import { readUserConfigDocument } from "../config.js";
import { getProvider } from "../providers/index.js";
import { renderSettingsPage } from "../views/settings.js";
import { renderStatsPage } from "../views/stats.js";
import { renderTrashPage } from "../views/trash.js";
import { providerRenderContext } from "./provider-context.js";

export function registerSettingsStatsTrash(
  app: any,
  deps: {
    appConfig: any;
    providerMap: Map<string, any>;
    providerInfo: any[];
  }
) {
  const { appConfig, providerMap, providerInfo } = deps;

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

  // Stats page
  app.get("/:provider/stats", async (req: any, _res: any, params: any) => {
    const providerSegment = params.provider;
    const adapter = providerMap.get(providerSegment);

    if (!adapter) {
      return { status: 404, body: "<h1>Not found</h1>", contentType: "text/html; charset=utf-8" };
    }

    const renderContext = providerRenderContext(providerSegment, providerInfo, adapter);

    try {
      if (usesSqliteSessionStore(adapter)) {
        const dbPath = adapter.getDataPath();
        const tokenStats = completeTokenStats(getTokenStats(30, dbPath), 30);
        const modelDistribution = getModelDistribution(dbPath);
        const dailySessions = getDailySessionCounts(30, dbPath);
        const overview = getStats(dbPath);
        return {
          status: 200,
          body: renderStatsPage({ tokenStats, modelDistribution, dailySessions, overview, ...renderContext }),
          contentType: "text/html; charset=utf-8"
        };
      }

      const indexed = getIndexedSessions(providerSegment, 100000, 0, "").sessions;
      const tokenStats = adapter.getTokenStats(30).map((row: any) => ({
        day: row.day,
        input_tokens: Number(row.inputTokens) || 0,
        output_tokens: Number(row.outputTokens) || 0,
        reasoning_tokens: Number(row.reasoningTokens) || 0,
        cache_read_tokens: Number(row.cacheReadTokens) || 0,
        cache_write_tokens: Number(row.cacheWriteTokens) || 0,
        total_tokens: Number(row.totalTokens) || 0,
        message_count: Number(row.messageCount) || 0
      }));
      const dailyMap = new Map<string, number>();
      for (const session of indexed) {
        const day = new Date(Number(session.time_created) || 0).toISOString().slice(0, 10);
        dailyMap.set(day, (dailyMap.get(day) || 0) + 1);
      }
      const dailySessions = [...dailyMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([day, count]) => ({ day, count }));
      const overview = {
        totalSessions: indexed.length,
        totalMessages: indexed.reduce((sum: number, session: any) => sum + (Number(session.message_count) || 0), 0)
      };
      return {
        status: 200,
        body: renderStatsPage({ tokenStats: completeTokenStats(tokenStats, 30), modelDistribution: [], dailySessions, overview, ...renderContext }),
        contentType: "text/html; charset=utf-8"
      };
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return { status: 500, body: JSON.stringify({ error: "Internal server error" }), contentType: "application/json; charset=utf-8" };
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

  // API: stats
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/stats$/, async (_req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const adapter = providerMap.get(providerId);
    if (!adapter) {
      const missing = missingProviderResponse(providerId);
      return json(res, missing.body, missing.status);
    }

    try {
      if (usesSqliteSessionStore(adapter)) {
        const dbPath = adapter.getDataPath();
        const tokenStats = completeTokenStats(getTokenStats(30, dbPath), 30);
        return json(res, {
          ...getStats(dbPath),
          tokenStats,
          tokenTotal: tokenStats.reduce((sum: number, row: any) => sum + (Number(row.total_tokens) || 0), 0)
        });
      }

      const indexed = getIndexedSessions(providerId, 100000, 0, "").sessions;
      const totalMessages = indexed.reduce((sum: number, session: any) => sum + (Number(session.message_count) || 0), 0);
      const tokenStats = completeTokenStats(adapter.getTokenStats(30).map((row: any) => ({
        day: row.day,
        input_tokens: Number(row.inputTokens) || 0,
        output_tokens: Number(row.outputTokens) || 0,
        reasoning_tokens: Number(row.reasoningTokens) || 0,
        cache_read_tokens: Number(row.cacheReadTokens) || 0,
        cache_write_tokens: Number(row.cacheWriteTokens) || 0,
        total_tokens: Number(row.totalTokens) || 0,
        message_count: Number(row.messageCount) || 0
      })), 30);
      return json(res, {
        totalSessions: indexed.length,
        totalMessages,
        modelDistribution: [],
        tokenStats,
        tokenTotal: tokenStats.reduce((sum: number, row: any) => sum + (Number(row.total_tokens) || 0), 0)
      });
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return json(res, { error: "Internal server error" }, 500);
    }
  });
}
