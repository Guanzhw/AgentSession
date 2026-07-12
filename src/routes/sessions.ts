import { getOverviewStats, listSessionProjects } from "../db.js";
import { getAllMeta, getDeletedIds, getExcludedIds } from "../meta.js";
import { getIndexedOverview, getIndexedSessionProjects } from "../index-db.js";
import {
  getVisibleListResults,
  getIndexedListResults,
  getSearchResults,
  getProviderSearchResults,
  getStarredIds,
  getTitleOverrides,
  resolveSessionSearchMode,
  resolveSessionSort,
  resolveStarredFilter,
  resolveSessionKindFilter,
  toApiSessionShape,
  normalizeSessionRecord,
  enrichSession
} from "../session-queries.js";
import { json, missingProviderResponse } from "../server-helpers.js";
import { usesSqliteSessionStore } from "../providers/kinds.js";
import { getProvider } from "../providers/index.js";
import { renderSessionsPage } from "../views/sessions.js";
import { providerRenderContext } from "./provider-context.js";

export function registerSessions(
  app: any,
  deps: {
    appConfig: any;
    providerMap: Map<string, any>;
    providerInfo: any[];
  }
) {
  const { providerMap, providerInfo } = deps;

  // API: list sessions
  app.get(/^\/api\/([a-z][a-z0-9-]*)\/sessions$/, async (req: any, res: any, match: RegExpMatchArray) => {
    const providerId = match[1];
    const adapter = providerMap.get(providerId);
    if (!adapter) {
      const missing = missingProviderResponse(providerId);
      return json(res, missing.body, missing.status);
    }

    try {
      const url = new URL(req.url || "/", "http://localhost");
      const apiLimit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 30), 100);
      const apiOffset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const range = url.searchParams.get("range") || "";
      const query = url.searchParams.get("q") || "";
      const project = url.searchParams.get("project") || "";
      const searchMode = resolveSessionSearchMode(url.searchParams);
      const sort = resolveSessionSort(url.searchParams);
      const starredOnly = resolveStarredFilter(url.searchParams);
      const sessionKind = resolveSessionKindFilter(url.searchParams);

      if (usesSqliteSessionStore(adapter)) {
        const dbPath = adapter.getDataPath();
        const metaMap = getAllMeta(providerId);
        const excludedIds = getExcludedIds(providerId) as Set<string>;

        let sessions;
        let total;
        if (query && searchMode === "content") {
          const results = getSearchResults(query, apiLimit, apiOffset, dbPath, excludedIds, sessionKind, metaMap);
          sessions = results.sessions.map((session: any) => enrichSession(session, metaMap));
          total = results.total;
        } else {
          const results = getVisibleListResults({
            dbPath,
            metaMap,
            excludedIds,
            limit: apiLimit,
            offset: apiOffset,
            query,
            range,
            project,
            sort,
            starredOnly,
            sessionKind
          });
          sessions = results.sessions;
          total = results.total;
        }

        return json(res, {
          sessions: sessions.map((session: any) => toApiSessionShape(normalizeSessionRecord(session))),
          total,
          offset: apiOffset,
          hasMore: apiOffset + sessions.length < total
        });
      }

      const metaMap = getAllMeta(providerId);
      const includedIds = starredOnly ? getStarredIds(metaMap) : undefined;
      const excludedIds = getExcludedIds(providerId) as Set<string>;
      let sessions;
      let total;
      if (query && searchMode === "content") {
        const results = getProviderSearchResults(adapter, query, apiLimit, apiOffset, sessionKind, metaMap, excludedIds);
        sessions = results.sessions;
        total = results.total;
      } else {
        const results = getIndexedListResults({
          providerId,
          metaMap,
          limit: apiLimit,
          offset: apiOffset,
          range,
          query,
          project,
          sort,
          includedIds,
          excludedIds,
          sessionKind
        });
        sessions = results.sessions.map((session: any) => normalizeSessionRecord(session));
        total = results.total;
      }

      return json(res, {
        sessions: sessions.map((session: any) => toApiSessionShape(session)),
        total,
        offset: apiOffset,
        hasMore: apiOffset + sessions.length < total
      });
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return json(res, { error: "Internal server error" }, 500);
    }
  });

  // Provider main page
  app.get("/:provider", async (req: any, res: any, params: any) => {
    const providerSegment = params.provider;
    const adapter = providerMap.get(providerSegment);
    const currentProvider = getProvider(providerSegment);

    if (!currentProvider) {
      return { status: 404, body: "<h1>Provider not found</h1>", contentType: "text/html; charset=utf-8" };
    }

    if (!adapter) {
      const dataPath = currentProvider.getDataPath?.() || "";
      const unavailableReason = currentProvider.getUnavailableReason?.();
      return {
        status: 200,
        body: renderSessionsPage({
          sessions: [],
          total: 0,
          note: unavailableReason || `${currentProvider.name} data was not detected at ${dataPath}.`,
          providerAvailable: false,
          ...providerRenderContext(providerSegment, providerInfo, adapter)
        }),
        contentType: "text/html; charset=utf-8"
      };
    }

    const url = new URL(req.url || "/", "http://localhost");
    const limit = 30;
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const range = url.searchParams.get("range") || "";
    const query = url.searchParams.get("q") || "";
    const project = url.searchParams.get("project") || "";
    const sort = resolveSessionSort(url.searchParams);
    const starredOnly = resolveStarredFilter(url.searchParams);
    const sessionKind = resolveSessionKindFilter(url.searchParams);

    const renderContext = providerRenderContext(providerSegment, providerInfo, adapter);

    try {
      if (usesSqliteSessionStore(adapter)) {
        const dbPath = adapter.getDataPath();
        const metaMap = getAllMeta(providerSegment);
        const excludedIds = getExcludedIds(providerSegment);
        const { sessions, total } = getVisibleListResults({
          dbPath,
          metaMap,
          excludedIds,
          limit,
          offset,
          query,
          range,
          project,
          sort,
          starredOnly,
          sessionKind
        });
        const enrichedSessions = sessions.map((session: any) => normalizeSessionRecord(session));
        const overviewStats = getOverviewStats(dbPath);
        const deletedCount = getDeletedIds(providerSegment).length;
        const includedIds = starredOnly ? getStarredIds(metaMap) : undefined;
        const projectOptions = listSessionProjects(
          query,
          range,
          dbPath,
          excludedIds,
          includedIds,
          sessionKind,
          getTitleOverrides(metaMap)
        );
        return {
          status: 200,
          body: renderSessionsPage({
            sessions: enrichedSessions,
            total,
            limit,
            offset,
            query,
            range,
            project,
            sort,
            starredOnly,
            sessionKind,
            projectOptions,
            searchMode: "list",
            totalMessages: overviewStats.totalMessages,
            deletedCount,
            ...renderContext
          }),
          contentType: "text/html; charset=utf-8"
        };
      }

      const metaMap = getAllMeta(providerSegment);
      const includedIds = starredOnly ? getStarredIds(metaMap) : undefined;
      const excludedIds = getExcludedIds(providerSegment);
      const indexed = getIndexedListResults({
        providerId: providerSegment,
        metaMap,
        limit,
        offset,
        range,
        query,
        project,
        sort,
        includedIds,
        excludedIds,
        sessionKind
      });
      const titleOverrides = getTitleOverrides(metaMap);
      const overviewStats = getIndexedOverview(
        providerSegment,
        range,
        query,
        project,
        sessionKind,
        excludedIds,
        includedIds,
        titleOverrides
      );
      const projectOptions = getIndexedSessionProjects(
        providerSegment,
        range,
        query,
        includedIds,
        sessionKind,
        excludedIds,
        titleOverrides
      );
      return {
        status: 200,
        body: renderSessionsPage({
          sessions: indexed.sessions.map((session: any) => normalizeSessionRecord(session)),
          total: indexed.total,
          limit,
          offset,
          query,
          range,
          project,
          sort,
          starredOnly,
          sessionKind,
          projectOptions,
          searchMode: "list",
          totalMessages: overviewStats.totalMessages,
          deletedCount: getDeletedIds(providerSegment).length,
          ...renderContext
        }),
        contentType: "text/html; charset=utf-8"
      };
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return { status: 500, body: JSON.stringify({ error: "Internal server error" }), contentType: "application/json; charset=utf-8" };
    }
  });

  // Provider search page
  app.get("/:provider/search", async (req: any, res: any, params: any) => {
    const providerSegment = params.provider;
    const adapter = providerMap.get(providerSegment);

    if (!adapter) {
      return { status: 404, body: "<h1>Not found</h1>", contentType: "text/html; charset=utf-8" };
    }

    const url = new URL(req.url || "/", "http://localhost");
    const limit = 30;
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const query = url.searchParams.get("q") || "";

    const renderContext = providerRenderContext(providerSegment, providerInfo, adapter);

    try {
      if (usesSqliteSessionStore(adapter)) {
        const dbPath = adapter.getDataPath();
        const metaMap = getAllMeta(providerSegment);
        const excludedIds = getExcludedIds(providerSegment);
        const results = getSearchResults(query, limit, offset, dbPath, excludedIds, "all", metaMap);
        const enrichedSessions = results.sessions.map((session: any) => normalizeSessionRecord(enrichSession(session, metaMap)));
        return {
          status: 200,
          body: renderSessionsPage({ ...results, sessions: enrichedSessions, limit, offset, query, searchMode: "content", ...renderContext }),
          contentType: "text/html; charset=utf-8"
        };
      }

      const metaMap = getAllMeta(providerSegment);
      const excludedIds = getExcludedIds(providerSegment);
      const results = getProviderSearchResults(adapter, query, limit, offset, "all", metaMap, excludedIds);
      return {
        status: 200,
        body: renderSessionsPage({ ...results, limit, offset, query, searchMode: "content", ...renderContext }),
        contentType: "text/html; charset=utf-8"
      };
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return { status: 500, body: JSON.stringify({ error: "Internal server error" }), contentType: "application/json; charset=utf-8" };
    }
  });
}
