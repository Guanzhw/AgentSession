import { getOverviewStats, getSession, getMessages, getParts, getSessionsByIds, getTodos, listSessionProjects, listSessions, searchMessages } from "./db.js";
import { getIndexedOverview, getIndexedSessionProjects, getIndexedSessions } from "./index-db.js";
import { getAllMeta, getExcludedIds, getMeta } from "./meta.js";
import { usesOpenCodeStatsStore } from "./providers/kinds.js";
import { safeJsonParse } from "./server-helpers.js";
import { baseSessionListStats, boundedListStats } from "./session-list-stats.js";

export function enrichSession(session: any, metaMap: any): any {
  if (!session) {
    return session;
  }

  const meta = metaMap?.get(session.id);
  return {
    ...session,
    starred: Boolean(meta?.starred),
    title: meta?.custom_title || session.title
  };
}

const SESSION_SORTS = new Set(["updated-desc", "updated-asc", "title-asc", "title-desc"]);

export function resolveSessionSort(params: URLSearchParams): string {
  const sort = params.get("sort") || "updated-desc";
  return SESSION_SORTS.has(sort) ? sort : "updated-desc";
}

export function resolveStarredFilter(params: URLSearchParams): boolean {
  const value = params.get("starred") || "";
  return value === "1" || value === "true";
}

function getStarredIds(metaMap: Map<string, any>): string[] {
  return [...metaMap.entries()]
    .filter(([, meta]) => Boolean(meta?.starred))
    .map(([id]) => id);
}

export function getTitleOverrides(metaMap: Map<string, any>): Map<string, string> {
  return new Map(
    [...metaMap.entries()]
      .filter(([, meta]) => typeof meta?.custom_title === "string" && meta.custom_title.trim())
      .map(([id, meta]) => [id, meta.custom_title])
  );
}

export function resolveSessionSearchMode(params: URLSearchParams): string {
  return (params.get("mode") || params.get("searchMode")) === "content" ? "content" : "list";
}

export function getSearchResults(query: string, limit: number, offset: number, dbPath: any = undefined, excludedIds: Set<string> = new Set(), metaMap: any = undefined) {
  const term = (query || "").trim();
  if (!term) {
    return { sessions: [], total: 0, note: "Enter a search query to find sessions." };
  }

  const titleOverrides = getTitleOverrides(metaMap || new Map());
  const titleMatches = listSessions(1000, 0, term, "", dbPath, "", excludedIds, "updated-desc", undefined, titleOverrides).sessions;
  const contentMatches = searchMessages(term, 500, dbPath, excludedIds);
  const orderedIds: string[] = [];
  const sessionMap = new Map();

  for (const session of titleMatches) {
    const enriched = enrichSession(session, metaMap);
    if (!sessionMap.has(enriched.id)) {
      orderedIds.push(enriched.id);
      sessionMap.set(enriched.id, enriched);
    }
  }

  for (const match of contentMatches) {
    if (!sessionMap.has(match.sessionId)) {
      const session = getSession(match.sessionId, dbPath);
      const enriched = enrichSession(session, metaMap);
      if (enriched) {
        orderedIds.push(enriched.id);
        sessionMap.set(enriched.id, enriched);
      }
    }
  }

  const visibleIds = orderedIds.filter((id) => !excludedIds.has(id));
  return {
    sessions: visibleIds.slice(offset, offset + limit).map((id) => sessionMap.get(id)).filter(Boolean),
    total: visibleIds.length,
    note: `Showing title and message-content matches for "${term}".`
  };
}

export function loadPartsByMessage(messages: any[], dbPath: any = undefined): Map<string, any[]> {
  const map = new Map<string, any[]>();
  for (const message of messages) {
    map.set(
      message.id,
      getParts(message.id, dbPath).map((part: any) => ({
        ...part,
        data: safeJsonParse(part.data)
      }))
    );
  }
  return map;
}

export function normalizeSessionRecord(session: any): any {
  if (!session) {
    return null;
  }

  const normalizeRecordedCount = (key: string) => {
    if (!Object.prototype.hasOwnProperty.call(session, key)) return 0;
    if (session[key] == null) return null;
    const value = Number(session[key]);
    return Number.isFinite(value) ? value : null;
  };

  return {
    ...session,
    id: session.id,
    title: session.title || session.slug || session.id,
    directory: session.directory || "",
    time_created: Number(session.time_created ?? session.timeCreated) || 0,
    time_updated: Number(session.time_updated ?? session.timeUpdated) || 0,
    summary_files: normalizeRecordedCount("summary_files"),
    summary_additions: normalizeRecordedCount("summary_additions"),
    summary_deletions: normalizeRecordedCount("summary_deletions"),
    starred: Boolean(session.starred),
  };
}

export function buildPartsFromProviderMessages(providerMessages: any[] = []) {
  const messages: any[] = [];
  const partsByMessage = new Map<string, any[]>();

  for (let i = 0; i < providerMessages.length; i += 1) {
    const source = providerMessages[i] || {};
    const messageId = source.id || `${source.sessionId || "session"}:msg:${i}`;
    messages.push({
      id: messageId,
      data: {
        role: source.role || "assistant",
        time: { created: Number(source.timestamp) || 0 },
        tokens: source.tokens || null,
        model: source.metadata?.model || null
      }
    });

    const isTool = source.role === "tool" || source.toolName;
    const contentPart = isTool
      ? {
        type: "tool",
        tool: source.toolName || "tool",
        state: {
          input: source.toolInput || null,
          output: source.toolOutput ?? source.content ?? "",
          status: "completed"
        }
      }
      : {
        type: "text",
        text: source.content || ""
      };

    const parts = [];
    if (source.thinking) {
      parts.push({
        id: `${messageId}:reasoning`,
        data: { type: "reasoning", text: source.thinking }
      });
    }
    parts.push({ id: `${messageId}:part`, data: contentPart });
    partsByMessage.set(messageId, parts);
  }

  return { messages, partsByMessage };
}

/**
 * Read the source-owned pieces needed by the session detail surfaces once.
 * OpenCode keeps its raw message/part/todo records in SQLite; file providers
 * expose normalized messages through their adapter and need the small view
 * mapping used by HTML and export. The separate API fields preserve the
 * existing file-provider API shape and its intentional lack of viewer-meta
 * enrichment.
 */
export function getSessionDocument(adapter: any, providerId: string, sessionId: string): any | null {
  const sqlite = usesOpenCodeStatsStore(adapter);
  const dbPath = sqlite ? adapter.getDataPath() : undefined;
  const rawSession = sqlite ? getSession(sessionId, dbPath) : adapter.getSession(sessionId);
  if (!rawSession) return null;

  const metaMap = getAllMeta(providerId);
  const normalizedRawSession = normalizeSessionRecord(rawSession);
  const session = normalizeSessionRecord(enrichSession(rawSession, metaMap));
  const meta = getMeta(providerId, rawSession.id || sessionId);

  if (sqlite) {
    const messages = getMessages(sessionId, dbPath).map((message: any) => ({
      ...message,
      data: safeJsonParse(message.data)
    }));
    const partsByMessage = loadPartsByMessage(messages, dbPath);
    const apiMessages = messages.map((message: any) => ({
      ...message,
      parts: (partsByMessage.get(message.id) || []).map((part: any) => part.data)
    }));
    return {
      session,
      apiSession: session,
      exportSession: session,
      messages,
      apiMessages,
      exportMessages: apiMessages,
      partsByMessage,
      todos: getTodos(sessionId, dbPath),
      meta
    };
  }

  const providerMessages = adapter.getMessages(sessionId);
  const mapped = buildPartsFromProviderMessages(providerMessages);
  const exportMessages = mapped.messages.map((message: any) => ({
    ...message,
    parts: (mapped.partsByMessage.get(message.id) || []).map((part: any) => part.data)
  }));
  return {
    session,
    // File-provider JSON has historically returned adapter messages and the
    // source-normalized session, while HTML/export consume the mapped view.
    apiSession: normalizedRawSession,
    exportSession: normalizedRawSession,
    messages: mapped.messages,
    apiMessages: providerMessages,
    exportMessages,
    partsByMessage: mapped.partsByMessage,
    todos: [],
    meta
  };
}

function getProviderSearchResults(adapter: any, query: string, limit: number, offset: number, metaMap: any = undefined, excludedIds: Set<string> = new Set()) {
  const term = (query || "").trim();
  if (!term) {
    return { sessions: [], total: 0, note: "Enter a search query to find sessions." };
  }

  const matches = adapter.searchMessages(term, 500);
  const orderedIds: string[] = [];
  const sessionMap = new Map();

  for (const match of matches) {
    if (sessionMap.has(match.sessionId) || excludedIds.has(match.sessionId)) {
      continue;
    }
    const session = enrichSession(adapter.getSession(match.sessionId), metaMap);
    if (!session) {
      continue;
    }
    orderedIds.push(match.sessionId);
    sessionMap.set(match.sessionId, normalizeSessionRecord(session));
  }

  return {
    sessions: orderedIds.slice(offset, offset + limit).map((id: string) => sessionMap.get(id)).filter(Boolean),
    total: orderedIds.length,
    note: `Showing message-content matches for "${term}".`
  };
}

/**
 * Provider-neutral session catalog for list/search/overview surfaces.
 *
 * The catalog selects the source once. Callers should not need to know whether
 * the provider is backed by OpenCode's SQLite schema or the viewer index.
 */
export function createSessionCatalog(adapter: any, providerId: string, metadata: {
  metaMap?: Map<string, any>;
  excludedIds?: Set<string>;
} = {}) {
  const sqlite = usesOpenCodeStatsStore(adapter);
  const dbPath = sqlite ? adapter.getDataPath() : undefined;
  const metaMap = metadata.metaMap || getAllMeta(providerId);
  const excludedIds = metadata.excludedIds || getExcludedIds(providerId);
  const titleOverrides = getTitleOverrides(metaMap);

  function normalizeRows(rows: any[] = []) {
    return rows.map((session) => normalizeSessionRecord(enrichSession(session, metaMap)));
  }

  return {
    list({
      limit,
      offset,
      range = "",
      query = "",
      project = "",
      sort = "updated-desc",
      starredOnly = false,
    }: any) {
      const includedIds = starredOnly ? getStarredIds(metaMap) : undefined;
      const results = sqlite
        ? listSessions(limit, offset, query, range, dbPath, project, excludedIds, sort, includedIds, titleOverrides)
        : getIndexedSessions(providerId, limit, offset, range, query, project, sort, includedIds as any, excludedIds as any, titleOverrides);
      return { sessions: normalizeRows(results.sessions), total: results.total };
    },

    contentSearch({ query, limit, offset }: any) {
      const results = sqlite
        ? getSearchResults(query, limit, offset, dbPath, excludedIds, metaMap)
        : getProviderSearchResults(adapter, query, limit, offset, metaMap, excludedIds);
      return { ...results, sessions: normalizeRows(results.sessions) };
    },

    overview({ range = "", query = "", project = "", starredOnly = false }: any = {}) {
      const includedIds = starredOnly ? getStarredIds(metaMap) : undefined;
      return sqlite
        ? getOverviewStats(dbPath)
        : getIndexedOverview(providerId, range, query, project, excludedIds, includedIds, titleOverrides);
    },

    projects({ range = "", query = "", starredOnly = false }: any = {}) {
      const includedIds = starredOnly ? getStarredIds(metaMap) : undefined;
      return sqlite
        ? listSessionProjects(query, range, dbPath, excludedIds, includedIds, titleOverrides)
        : getIndexedSessionProjects(providerId, range, query, includedIds, excludedIds, titleOverrides);
    },

    byIds(ids: string[] = []) {
      if (!ids.length) return [];
      const sessions = sqlite
        ? getSessionsByIds(ids, dbPath)
        : getIndexedSessions(providerId, ids.length, 0, "", "", "", "updated-desc", ids as any).sessions;
      return normalizeRows(sessions);
    }
  };
}

export function toApiSessionShape(session: any, extras: { html?: string } = {}) {
  const apiRecordedCount = (key: string) => {
    if (!Object.prototype.hasOwnProperty.call(session, key)) return 0;
    if (session[key] == null) return null;
    const value = Number(session[key]);
    return Number.isFinite(value) ? value : null;
  };
  const shape = {
    id: session.id,
    provider: session.provider || "",
    title: session.title || session.slug || session.id,
    directory: session.directory || "",
    time_updated: Number(session.time_updated) || 0,
    summary_files: apiRecordedCount("summary_files"),
    summary_additions: apiRecordedCount("summary_additions"),
    summary_deletions: apiRecordedCount("summary_deletions"),
    starred: Boolean(session.starred),
    // Bounded list statistics: attached for the current page by the list
    // routes; a base summary is derived from the row fields otherwise. The
    // raw protocol is never exposed here.
    stats: boundedListStats(session.stats) ?? baseSessionListStats(session)
  };
  if (extras.html !== undefined) {
    (shape as any).html = extras.html;
  }
  return shape;
}
