import { getOverviewStats, getSession, getMessages, getParts, getSessionsByIds, getTodos, listSessionProjects, listSessions, searchMessages } from "./db.js";
import { getIndexedOverview, getIndexedSessionProjects, getIndexedSessions } from "./index-db.js";
import { getAllMeta, getExcludedIds, getMeta } from "./meta.js";
import { usesOpenCodeStatsStore } from "./providers/kinds.js";
import { safeJsonParse } from "./server-helpers.js";
import { baseSessionListStats, boundedListStats } from "./session-list-stats.js";
import type { SessionReaderSnapshot } from "./providers/interface.js";

export function enrichSession(session: any, metaMap: any): any {
  if (!session) {
    return session;
  }

  const meta = metaMap?.get(session.id);
  return {
    ...session,
    starred: Boolean(meta?.starred),
    // Keep the viewer-owned origin available to presentation surfaces. This
    // matters when a user deliberately chooses an ID-shaped custom title.
    custom_title: typeof meta?.custom_title === "string" && meta.custom_title.trim()
      ? meta.custom_title
      : null,
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

export function getStarredIds(metaMap: Map<string, any>): string[] {
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
    return { sessions: [], total: 0, hasMore: false, note: "Enter a search query to find sessions." };
  }

  const titleOverrides = getTitleOverrides(metaMap || new Map());
  const titleQuery = (pageLimit: number, pageOffset: number) =>
    listSessions(pageLimit, pageOffset, term, "", dbPath, "", excludedIds, "updated-desc", undefined, titleOverrides);
  const titleTotal = titleQuery(0, 0).total;
  const titlePageLimit = Math.max(0, Math.min(limit, titleTotal - offset));
  const titlePage = titlePageLimit ? titleQuery(titlePageLimit, offset).sessions.map((session: any) => enrichSession(session, metaMap)) : [];
  if (offset + titlePage.length < titleTotal) {
    return {
      sessions: titlePage,
      total: null,
      hasMore: true,
      note: `Showing title and message-content matches for "${term}".`
    };
  }

  // Title hits precede content hits. Keep only their IDs while scanning the
  // content stream so duplicate messages never consume a session page slot.
  const titleIds = new Set<string>();
  for (let titleOffset = 0; titleOffset < titleTotal; titleOffset += SEARCH_BATCH_SIZE) {
    for (const session of titleQuery(SEARCH_BATCH_SIZE, titleOffset).sessions) titleIds.add(session.id);
  }
  const content = pageContentMatches({
    limit: limit - titlePage.length,
    offset: Math.max(0, offset - titleTotal),
    excludedIds,
    seenIds: titleIds,
    fetchMatches: (batchOffset) => searchMessages(term, SEARCH_BATCH_SIZE, dbPath, excludedIds, batchOffset, false, true),
    getMatchingSession: (id) => getSession(id, dbPath),
    metaMap
  });
  return {
    sessions: [...titlePage, ...content.sessions],
    total: content.total === null ? null : titleTotal + content.total,
    hasMore: content.hasMore,
    note: `Showing title and message-content matches for "${term}".`
  };
}

const SEARCH_BATCH_SIZE = 256;

function getOpenCodeMessageSearchResults(query: string, limit: number, offset: number, dbPath: any, excludedIds: Set<string>, metaMap: any) {
  const term = (query || "").trim();
  if (!term) return { sessions: [], total: 0, hasMore: false, note: "Enter a search query to find sessions." };
  const result = pageContentMatches({
    limit, offset, excludedIds, metaMap,
    fetchMatches: (batchOffset) => searchMessages(term, SEARCH_BATCH_SIZE, dbPath, excludedIds, batchOffset, false, true),
    getMatchingSession: (id) => getSession(id, dbPath)
  });
  return { ...result, note: `Showing message-content matches for "${term}".` };
}

/** Read a stable match stream in bounded batches; rank sessions by first hit. */
function pageContentMatches({ limit, offset, excludedIds, seenIds = new Set<string>(), fetchMatches, getMatchingSession, iterateMatches, metaMap }: {
  limit: number;
  offset: number;
  excludedIds: Set<string>;
  seenIds?: Set<string>;
  fetchMatches?: (offset: number) => any[];
  getMatchingSession?: (id: string) => any;
  iterateMatches?: Iterable<{ session: any; match: any }>;
  metaMap: any;
}) {
  const sessions: any[] = [];
  let uniqueCount = 0;
  let hasMore = false;
  function* matches(): IterableIterator<{ session?: any; match: any }> {
    if (iterateMatches) {
      yield* iterateMatches;
      return;
    }
    let matchOffset = 0;
    while (true) {
      const batch = fetchMatches!(matchOffset);
      for (const match of batch) yield { match };
      matchOffset += batch.length;
      if (batch.length < SEARCH_BATCH_SIZE) return;
    }
  }
  for (const { session: matchedSession, match } of matches()) {
      const id = match.sessionId;
      if (seenIds.has(id) || excludedIds.has(id)) continue;
      seenIds.add(id);
      const source = matchedSession || getMatchingSession!(id);
      if (!source) continue;
      const position = uniqueCount++;
      if (position >= offset + limit) {
        hasMore = true;
        break;
      }
      if (position < offset) continue;
      const session = enrichSession(source, metaMap);
      sessions.push({
        ...session,
        searchMatch: {
          messageId: match.messageId,
          role: match.role,
          snippet: match.snippet
        }
      });
  }
  return { sessions, total: hasMore ? null : uniqueCount, hasMore };
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

export function buildPartsFromProviderMessages(providerMessages: any[] = [], idPrefix = "", contentScope = "owned") {
  const messages: any[] = [];
  const partsByMessage = new Map<string, any[]>();

  for (let i = 0; i < providerMessages.length; i += 1) {
    const source = providerMessages[i] || {};
    const messageId = `${idPrefix}${source.id || `${source.sessionId || "session"}:msg:${i}`}`;
    messages.push({
      id: messageId,
      data: {
        role: source.role || "assistant",
        presentationPhase: source.presentationPhase,
        time: { created: Number(source.timestamp) || 0 },
        tokens: source.tokens || null,
        model: source.metadata?.model || null,
        contentScope
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
        text: source.content || "",
        ...(source.questionAnswers ? { questionAnswers: source.questionAnswers } : {})
      };

    const parts = [];
    if (source.thinking) {
      parts.push({
        id: `${messageId}:reasoning`,
        data: { type: "reasoning", text: source.thinking }
      });
    }
    // Match reader-tree event IDs so search and continuation reach the same part.
    const contentSuffix = contentPart.type === "tool" ? "tool" : "text";
    parts.push({ id: `${messageId}:${contentSuffix}`, data: contentPart });
    partsByMessage.set(messageId, parts.map((part) => ({
      ...part,
      messageRole: source.role || "assistant",
      contentScope
    })));
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
export function getSessionDocument(
  adapter: any,
  providerId: string,
  sessionId: string,
  captured?: Pick<SessionReaderSnapshot, "session" | "messages"> | null
): any | null {
  const sqlite = captured === undefined && usesOpenCodeStatsStore(adapter);
  const dbPath = sqlite ? adapter.getDataPath() : undefined;
  const rawSession = captured !== undefined ? captured?.session
    : sqlite ? getSession(sessionId, dbPath) : adapter.getSession(sessionId);
  if (!rawSession || (captured !== undefined && rawSession.id !== sessionId)) return null;

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

  const providerMessages = captured ? captured.messages : adapter.getMessages(sessionId);
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
    return { sessions: [], total: 0, hasMore: false, note: "Enter a search query to find sessions." };
  }

  const result = pageContentMatches({
    limit, offset, excludedIds, metaMap,
    iterateMatches: adapter.iterateSearchMessages?.(term),
    fetchMatches: (batchOffset) => adapter.searchMessages(term, SEARCH_BATCH_SIZE, batchOffset),
    getMatchingSession: (id) => adapter.getSession(id)
  });
  return {
    ...result,
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
      hasSubagent = false,
    }: any) {
      const includedIds = starredOnly ? getStarredIds(metaMap) : undefined;
      const results = sqlite
        ? listSessions(limit, offset, query, range, dbPath, project, excludedIds, sort, includedIds, titleOverrides, hasSubagent)
        : getIndexedSessions(providerId, limit, offset, range, query, project, sort, includedIds as any, excludedIds as any, titleOverrides, hasSubagent);
      return { sessions: normalizeRows(results.sessions), total: results.total };
    },

    contentSearch({ query, limit, offset }: any) {
      const results = sqlite
        ? getSearchResults(query, limit, offset, dbPath, excludedIds, metaMap)
        : getProviderSearchResults(adapter, query, limit, offset, metaMap, excludedIds);
      return { ...results, sessions: normalizeRows(results.sessions) };
    },

    messageSearch({ query, limit, offset }: any) {
      const results = sqlite
        ? getOpenCodeMessageSearchResults(query, limit, offset, dbPath, excludedIds, metaMap)
        : getProviderSearchResults(adapter, query, limit, offset, metaMap, excludedIds);
      return { ...results, sessions: normalizeRows(results.sessions) };
    },

    overview({ range = "", query = "", project = "", starredOnly = false, hasSubagent = false }: any = {}) {
      const includedIds = starredOnly ? getStarredIds(metaMap) : undefined;
      return sqlite
        ? getOverviewStats(dbPath, query, range, project, excludedIds, includedIds, titleOverrides, hasSubagent)
        : getIndexedOverview(providerId, range, query, project, excludedIds, includedIds, titleOverrides, hasSubagent);
    },

    projects({ range = "", query = "", starredOnly = false, hasSubagent = false }: any = {}) {
      const includedIds = starredOnly ? getStarredIds(metaMap) : undefined;
      return sqlite
        ? listSessionProjects(query, range, dbPath, excludedIds, includedIds, titleOverrides, hasSubagent)
        : getIndexedSessionProjects(providerId, range, query, includedIds, excludedIds, titleOverrides, hasSubagent);
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

/** Interleave provider-owned result order without conflating equal session IDs. */
export function searchAcrossProviderCatalogs(
  catalogs: { provider: string; messageSearch: (options: { query: string; limit: number; offset: number }) => any }[],
  query: string,
  limit: number,
  offset: number
) {
  if (!query.trim() || !catalogs.length) return { sessions: [], total: 0, hasMore: false };
  const needed = offset + limit + 1;
  const results = catalogs.map(({ provider, messageSearch }) => ({
    provider,
    ...messageSearch({ query, limit: needed, offset: 0 })
  }));
  const sessions: any[] = [];
  const seen = new Set<string>();
  const longest = Math.max(...results.map((result) => result.sessions.length));
  for (let rank = 0; rank < longest && sessions.length < needed; rank += 1) {
    for (const result of results) {
      const session = result.sessions[rank];
      if (!session) continue;
      const key = JSON.stringify([result.provider, session.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      sessions.push({ ...session, provider: result.provider });
    }
  }
  const hasMore = sessions.length > offset + limit || results.some((result) => result.hasMore);
  return {
    sessions: sessions.slice(offset, offset + limit),
    total: hasMore ? null : sessions.length,
    hasMore
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
  if (session.searchMatch) {
    (shape as any).searchMatch = session.searchMatch;
  }
  return shape;
}
