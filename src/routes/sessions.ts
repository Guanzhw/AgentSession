import { getAllMeta, getDeletedIds, getExcludedIds } from "../meta.js";
import { getCrossProviderSessions } from "../index-db.js";
import {
  getTitleOverrides,
  getStarredIds,
  resolveSessionSearchMode,
  resolveSessionSort,
  resolveStarredFilter,
  toApiSessionShape,
  normalizeSessionRecord,
  enrichSession,
  createSessionCatalog
} from "../session-queries.js";
import { json, missingProviderResponse } from "../server-helpers.js";
import { attachSessionListStats } from "../session-list-stats.js";
import { getProvider } from "../providers/index.js";
import { supportsLocalManagement } from "../providers/kinds.js";
import { renderSessionsPage } from "../views/sessions.js";
import { sessionCard } from "../views/components.js";
import { providerRenderContext } from "./provider-context.js";
import { queryLibraryFamilies, queryLibraryFamilyChildren, queryLibraryFamilyProjects, type LibraryFamilyQuery } from "../library-families.js";
import { libraryFamilyEntry, libraryFamilyChild } from "../views/library-family.js";
import { buildLibraryDiscriminators, libraryIdentityKey } from "../views/library-disambiguation.js";

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

  function sessionListQuery(searchParams: URLSearchParams, limit = 30, offset = 0, providerOnly = "") {
    const providers = providerOnly ? [providerOnly] : selectedProviderIds(searchParams);
    const range = searchParams.get("range") || "";
    const query = searchParams.get("q") || "";
    const project = searchParams.get("project") || "";
    const sort = resolveSessionSort(searchParams);
    const starredOnly = resolveStarredFilter(searchParams);
    const hasSubagent = searchParams.has("has-subagent");
    const excluded = providers.flatMap((provider) => [...getExcludedIds(provider)].map((id) => ({ provider, id })));
    const metaByProvider = new Map(providers.map((provider) => [provider, getAllMeta(provider)]));
    const included = starredOnly
      ? providers.flatMap((provider) => getStarredIds(metaByProvider.get(provider) || new Map()).map((id) => ({ provider, id })))
      : undefined;
    const titleOverrides = providers.flatMap((provider) => [...getTitleOverrides(metaByProvider.get(provider) || new Map())]
      .map(([id, title]) => ({ provider, id, title })));
    const queryOptions = { providers, limit, offset, timeRange: range, search: query, project, sort, excluded, included, hasSubagent, titleOverrides };
    return { queryOptions, metaByProvider, range, query, project, sort, starredOnly, hasSubagent, providers, excluded, included, titleOverrides };
  }

  function buildCrossProviderList(searchParams: URLSearchParams, limit = 30, offset = 0) {
    const { queryOptions, metaByProvider, ...filters } = sessionListQuery(searchParams, limit, offset);
    const results = getCrossProviderSessions(queryOptions);
    const sessions = results.sessions.map((session: any) => normalizeSessionRecord(enrichSession(session, metaByProvider.get(session.provider))));
    attachSessionListStats(sessions, (provider) => providerMap.get(provider));
    return {
      ...results,
      sessions,
      ...filters,
    };
  }

  function withLiveLibrarySessions(query: LibraryFamilyQuery): LibraryFamilyQuery {
    const liveSessions: NonNullable<LibraryFamilyQuery["liveSessions"]> = new Map();
    for (const provider of query.providers) {
      const adapter = providerMap.get(provider);
      if (adapter.getLibrarySessions) liveSessions.set(provider, adapter.getLibrarySessions());
    }
    return { ...query, liveSessions };
  }

  function buildLibraryList(searchParams: URLSearchParams, limit = 30, offset = 0, providerOnly = "") {
    const { queryOptions: indexedQuery, metaByProvider, ...filters } = sessionListQuery(searchParams, limit, offset, providerOnly);
    const queryOptions = withLiveLibrarySessions(indexedQuery);
    const result = queryLibraryFamilies(queryOptions);
    const sessions = result.families.map((node) => ({
      ...normalizeSessionRecord(enrichSession(node.session, metaByProvider.get(node.session.provider))),
      family: node
    }));
    return { ...result, ...filters, sessions, queryOptions };
  }

  function familyRenderOptions(provider: string, searchParams: URLSearchParams) {
    const info = providerInfo.find((item: any) => item.id === provider);
    return {
      filters: searchParams.toString(),
      returnTo: searchParams.get("returnTo") || "/sessions",
      providerName: info?.name || provider,
      manageable: Boolean(info?.manageable)
    };
  }

  app.get("/api/library/sessions", async (req: any, res: any) => {
    const params = new URL(req.url, "http://localhost").searchParams;
    const limit = Math.min(Math.max(1, Number(params.get("limit")) || 30), 100);
    const offset = Math.max(0, Number(params.get("offset")) || 0);
    const result = buildLibraryList(params, limit, offset);
    const discriminators = buildLibraryDiscriminators(result.sessions);
    return json(res, {
      sessions: result.sessions.map((session) => ({
        id: session.id,
        provider: session.provider,
        title: session.title,
        directory: session.directory,
        time_updated: session.time_updated,
        html: libraryFamilyEntry({ ...session.family, session }, {
          ...familyRenderOptions(session.provider, params),
          discriminator: discriminators.get(libraryIdentityKey(session)) || null
        })
      })),
      total: result.total, offset, hasMore: result.hasMore,
      matchingSessions: result.overview.totalSessions
    });
  });

  app.get("/api/library/children", async (req: any, res: any) => {
    const params = new URL(req.url, "http://localhost").searchParams;
    const provider = params.get("parentProvider") || "";
    if (!providerMap.has(provider)) return json(res, { error: "Provider unavailable" }, 404);
    const { queryOptions, metaByProvider } = sessionListQuery(params);
    const result = queryLibraryFamilyChildren({
      ...withLiveLibrarySessions(queryOptions), provider, parentId: params.get("parentId") || "",
      limit: 20, offset: Math.max(0, Number(params.get("offset")) || 0)
    });
    if (!result.parent) return json(res, { error: "History unavailable in this library" }, 404);
    const children = result.children.map((node) => ({
      ...node,
      session: enrichSession(node.session, metaByProvider.get(provider))
    }));
    const discriminators = buildLibraryDiscriminators(children.map((node) => node.session));
    return json(res, {
      html: children.map((node) => libraryFamilyChild(node, {
        ...familyRenderOptions(provider, params),
        discriminator: discriminators.get(libraryIdentityKey(node.session)) || null
      })).join(""),
      total: result.total, offset: result.offset, shown: result.children.length,
      nextOffset: result.hasMore ? result.offset + result.children.length : null
    });
  });

  app.get("/api/sessions", async (req: any, res: any) => {
    try {
      const searchParams = new URL(req.url || "/", "http://localhost").searchParams;
      const limit = Math.min(Math.max(1, Number(searchParams.get("limit")) || 30), 100);
      const offset = Math.max(0, Number(searchParams.get("offset")) || 0);
      const result = buildCrossProviderList(searchParams, limit, offset);
      const returnTo = searchParams.get("returnTo") || "";
      const providerNames = new Map(providerInfo.map((item: any) => [item.id, item.name || item.id]));
      const manageableByProvider = new Map(providerInfo.map((item: any) => [item.id, Boolean(item.manageable)]));
      return json(res, {
        sessions: result.sessions.map((session: any) => {
          const providerId = session.provider || "";
          const cardManageable = manageableByProvider.get(providerId) === true;
          return toApiSessionShape(session, {
            html: sessionCard(session, false, {
              provider: providerId,
              manageable: cardManageable,
              showCheckbox: cardManageable,
              showProvider: true,
              providerName: providerNames.get(providerId) || providerId || "",
              returnTo
            })
          });
        }),
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
      const result = buildLibraryList(searchParams, 30, offset);
      const overview = result.overview;
      const projectOptions = queryLibraryFamilyProjects(result.queryOptions);
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
          starredOnly: result.starredOnly,
          hasSubagent: result.hasSubagent,
          projectOptions,
          provider: null,
          providers: providerInfo,
          selectedProviders: result.providers,
          global: true,
          familyMode: true,
          matchingSessions: overview.totalSessions,
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
      const hasSubagent = url.searchParams.has("has-subagent");
      const catalog = createSessionCatalog(adapter, providerId);
      const results = query && searchMode === "content"
        ? catalog.contentSearch({ query, limit: apiLimit, offset: apiOffset })
        : catalog.list({ limit: apiLimit, offset: apiOffset, query, range, project, sort, starredOnly, hasSubagent });
      const sessions = results.sessions;
      const total = results.total;
      attachSessionListStats(sessions, () => adapter, providerId);
      const returnTo = url.searchParams.get("returnTo") || "";
      const manageable = supportsLocalManagement(adapter);

      return json(res, {
        sessions: sessions.map((session: any) => toApiSessionShape(session, {
          html: sessionCard(session, false, {
            provider: providerId,
            manageable,
            showCheckbox: manageable,
            showProvider: false,
            returnTo
          })
        })),
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
    const hasSubagent = url.searchParams.has("has-subagent");

    const renderContext = providerRenderContext(providerSegment, providerInfo, adapter);

    try {
      const indexed = buildLibraryList(url.searchParams, limit, offset, providerSegment);
      const sessions = indexed.sessions;
      const overviewStats = indexed.overview;
      const projectOptions = queryLibraryFamilyProjects(indexed.queryOptions);
      return {
        status: 200,
        body: renderSessionsPage({
          sessions,
          total: indexed.total,
          limit,
          offset,
          query,
          range,
          project,
          sort,
          starredOnly,
          hasSubagent,
          projectOptions,
          searchMode: "list",
          familyMode: true,
          matchingSessions: overviewStats.totalSessions,
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
      const catalog = createSessionCatalog(adapter, providerSegment);
      const results = catalog.contentSearch({ query, limit, offset });
      attachSessionListStats(results.sessions, () => adapter, providerSegment);
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
