import { getOverviewStats, listSessionProjects } from "../db.js";
import { getAllMeta, getDeletedIds, getExcludedIds } from "../meta.js";
import { getCrossProviderOverview, getCrossProviderSessionProjects, getCrossProviderSessions, getIndexedOverview, getIndexedSessionProjects } from "../index-db.js";
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

  function selectedProviderIds(searchParams: URLSearchParams) {
    const requested = searchParams.getAll("provider").flatMap((value) => value.split(",")).filter(Boolean);
    const available = [...providerMap.keys()];
    return requested.length ? [...new Set(requested)].filter((id) => providerMap.has(id)) : available;
  }

  function buildCrossProviderList(searchParams: URLSearchParams, limit = 30, offset = 0) {
    const providers = selectedProviderIds(searchParams);
    const range = searchParams.get("range") || "";
    const query = searchParams.get("q") || "";
    const project = searchParams.get("project") || "";
    const sort = resolveSessionSort(searchParams);
    const sessionKind = resolveSessionKindFilter(searchParams);
    const excluded = providers.flatMap((provider) => [...getExcludedIds(provider)].map((id) => ({ provider, id })));
    const metaByProvider = new Map(providers.map((provider) => [provider, getAllMeta(provider)]));
    const titleOverrides = providers.flatMap((provider) => [...getTitleOverrides(metaByProvider.get(provider) || new Map())]
      .map(([id, title]) => ({ provider, id, title })));
    const queryOptions = { providers, limit, offset, timeRange: range, search: query, project, sort, sessionKind, excluded, titleOverrides };
    const results = getCrossProviderSessions(queryOptions);
    return {
      ...results,
      sessions: results.sessions.map((session: any) => normalizeSessionRecord(enrichSession(session, metaByProvider.get(session.provider)))),
      providers,
      range,
      query,
      project,
      sort,
      sessionKind,
      excluded,
      titleOverrides,
    };
  }

  app.get("/api/sessions", async (req: any, res: any) => {
    try {
      const searchParams = new URL(req.url || "/", "http://localhost").searchParams;
      const limit = Math.min(Math.max(1, Number(searchParams.get("limit")) || 30), 100);
      const offset = Math.max(0, Number(searchParams.get("offset")) || 0);
      const result = buildCrossProviderList(searchParams, limit, offset);
      return json(res, {
        sessions: result.sessions.map(toApiSessionShape),
        total: result.total,
        offset,
        hasMore: offset + result.sessions.length < result.total,
      });
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return json(res, { error: "Internal server error" }, 500);
    }
  });

  app.get("/sessions", async (req: any) => {
    try {
      const searchParams = new URL(req.url || "/", "http://localhost").searchParams;
      const offset = Math.max(0, Number(searchParams.get("offset")) || 0);
      const result = buildCrossProviderList(searchParams, 30, offset);
      const overview = getCrossProviderOverview({
        providers: result.providers,
        timeRange: result.range,
        search: result.query,
        project: result.project,
        sessionKind: result.sessionKind,
        excluded: result.excluded,
        titleOverrides: result.titleOverrides,
      });
      const projectOptions = getCrossProviderSessionProjects({
        providers: result.providers,
        timeRange: result.range,
        search: result.query,
        sessionKind: result.sessionKind,
        excluded: result.excluded,
        titleOverrides: result.titleOverrides,
      });
      return {
        status: 200,
        body: renderSessionsPage({
          sessions: result.sessions,
          total: result.total,
          limit: 30,
          offset,
          query: result.query,
          range: result.range,
          project: result.project,
          sort: result.sort,
          sessionKind: result.sessionKind,
          projectOptions,
          totalMessages: overview.totalMessages,
          provider: null,
          providers: providerInfo,
          selectedProviders: result.providers,
          global: true,
          manageable: false,
        }),
        contentType: "text/html; charset=utf-8",
      };
    } catch (err: any) {
      console.error(`Route error: ${err.message}`);
      return { status: 500, body: JSON.stringify({ error: "Internal server error" }), contentType: "application/json; charset=utf-8" };
    }
  });

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
