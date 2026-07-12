import { getSession, getMessages, getParts, listSessions, searchMessages } from "./db.js";
import { getIndexedSessions } from "./index-db.js";
import { isAnalysisTitledSession, matchesSessionKind, normalizeSessionKindFilter } from "./session-kind.js";
import { safeJsonParse } from "./server-helpers.js";

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

export function resolveSessionKindFilter(params: URLSearchParams): string {
  return normalizeSessionKindFilter(params.get("kind") || params.get("sessionKind"));
}

export function getVisibleListResults({
  dbPath,
  metaMap,
  excludedIds,
  limit,
  offset,
  query = "",
  range = "",
  project = "",
  sort = "updated-desc",
  starredOnly = false,
  sessionKind = "all"
}: any) {
  const includedIds = starredOnly ? getStarredIds(metaMap) : undefined;
  const kind = normalizeSessionKindFilter(sessionKind);
  const titleOverrides = getTitleOverrides(metaMap);
  const results = listSessions(limit, offset, query, range, dbPath, project, excludedIds, sort, includedIds, kind, titleOverrides);
  return {
    sessions: results.sessions.map((session: any) => enrichSession(session, metaMap)),
    total: results.total
  };
}

export function getIndexedListResults({
  providerId,
  metaMap,
  limit,
  offset,
  range = "",
  query = "",
  project = "",
  sort = "updated-desc",
  includedIds = undefined,
  excludedIds = undefined,
  sessionKind = "all"
}: any) {
  const kind = normalizeSessionKindFilter(sessionKind);
  const titleOverrides = getTitleOverrides(metaMap);
  const results = getIndexedSessions(providerId, limit, offset, range, query, project, sort, includedIds, kind, excludedIds, titleOverrides);
  return {
    sessions: results.sessions.map((session: any) => enrichSession(session, metaMap)),
    total: results.total
  };
}

export function getSearchResults(query: string, limit: number, offset: number, dbPath: any = undefined, excludedIds: Set<string> = new Set(), sessionKind = "all", metaMap: any = undefined) {
  const term = (query || "").trim();
  const kind = normalizeSessionKindFilter(sessionKind);
  if (!term) {
    return { sessions: [], total: 0, note: "Enter a search query to find sessions." };
  }

  const titleOverrides = getTitleOverrides(metaMap || new Map());
  const titleMatches = listSessions(1000, 0, term, "", dbPath, "", excludedIds, "updated-desc", undefined, kind, titleOverrides).sessions;
  const contentMatches = searchMessages(term, 500, dbPath, excludedIds);
  const orderedIds: string[] = [];
  const sessionMap = new Map();

  for (const session of titleMatches) {
    const enriched = enrichSession(session, metaMap);
    if (!sessionMap.has(enriched.id) && matchesSessionKind(enriched, kind)) {
      orderedIds.push(enriched.id);
      sessionMap.set(enriched.id, enriched);
    }
  }

  for (const match of contentMatches) {
    if (!sessionMap.has(match.sessionId)) {
      const session = getSession(match.sessionId, dbPath);
      const enriched = enrichSession(session, metaMap);
      if (enriched && matchesSessionKind(enriched, kind)) {
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

  return {
    ...session,
    id: session.id,
    title: session.title || session.slug || session.id,
    directory: session.directory || "",
    time_created: Number(session.time_created ?? session.timeCreated) || 0,
    time_updated: Number(session.time_updated ?? session.timeUpdated) || 0,
    summary_files: Number(session.summary_files) || 0,
    summary_additions: Number(session.summary_additions) || 0,
    summary_deletions: Number(session.summary_deletions) || 0,
    starred: Boolean(session.starred),
    analysisTitled: isAnalysisTitledSession(session)
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

export function getProviderSearchResults(adapter: any, query: string, limit: number, offset: number, sessionKind = "all", metaMap: any = undefined, excludedIds: Set<string> = new Set()) {
  const term = (query || "").trim();
  const kind = normalizeSessionKindFilter(sessionKind);
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
    if (!session || !matchesSessionKind(session, kind)) {
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

export function toApiSessionShape(session: any) {
  return {
    id: session.id,
    title: session.title || session.slug || session.id,
    directory: session.directory || "",
    time_updated: Number(session.time_updated) || 0,
    summary_files: Number(session.summary_files) || 0,
    summary_additions: Number(session.summary_additions) || 0,
    summary_deletions: Number(session.summary_deletions) || 0,
    starred: Boolean(session.starred),
    analysisTitled: Boolean(session.analysisTitled)
  };
}

export function completeTokenStats(rows: any[], days = 30): any[] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const completed: any[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getTime() - offset * 86400000);
    const day = date.toISOString().slice(0, 10);
    completed.push(byDay.get(day) || {
      day,
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 0,
      message_count: 0
    });
  }

  return completed;
}
