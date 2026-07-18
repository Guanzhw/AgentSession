// src/index-db.js
import { DatabaseSync } from "node:sqlite";
import { getConfig } from "./config.js";
import { analysisTitleSqlCondition, analysisTitleSqlParams, normalizeSessionKindFilter } from "./session-kind.js";
import { isEmptyProjectFilter, normalizeCrossProviderProjectPath } from "./project-filter.js";
import { escapeSqlLikePattern, splitSearchTerms } from "./providers/shared/parser.js";
import {
  getKindMatchingOverrideIds,
  getOverrideTitleIds,
  getSearchMatchingOverrideIds,
  normalizeSessionTitleOverrides,
  serializeSessionTitleOverrides,
  type SessionTitleOverrides
} from "./session-title-overrides.js";

let indexDb: any;

export function closeIndexDb() {
  if (!indexDb) return;
  indexDb.close();
  indexDb = undefined;
}

export function getIndexDb() {
  if (!indexDb) {
    indexDb = new DatabaseSync(getConfig().metaPath);
    indexDb.exec(`
      CREATE TABLE IF NOT EXISTS session_index (
        id TEXT NOT NULL,
        provider TEXT NOT NULL,
        parent_id TEXT,
        title TEXT,
        directory TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        message_count INTEGER DEFAULT 0,
        token_count INTEGER,
        last_indexed INTEGER NOT NULL,
        PRIMARY KEY (provider, id)
      )
    `);
    indexDb.exec("CREATE INDEX IF NOT EXISTS idx_session_provider ON session_index(provider)");
    indexDb.exec("CREATE INDEX IF NOT EXISTS idx_session_updated ON session_index(time_updated DESC)");
    indexDb.function("normalize_cross_provider_project", { deterministic: true }, normalizeCrossProviderProjectPath);
  }
  return indexDb;
}

/**
 * Upsert a batch of RawSession objects into session_index.
 * @param {string} provider
 * @param {import('./providers/interface.js').RawSession[]} sessions
 */
export function upsertIndex(provider: any, sessions: any) {
  const db = getIndexDb();
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO session_index
      (id, provider, parent_id, title, directory, time_created, time_updated, message_count, token_count, last_indexed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const s of sessions) {
    stmt.run(s.id, provider, s.parentId, s.title, s.directory, s.timeCreated, s.timeUpdated, s.messageCount, s.tokenCount, now);
  }
}

/**
 * Get indexed sessions for a provider.
 * @param {string} provider
 * @param {number} limit
 * @param {number} offset
 * @param {string} timeRange - "today"|"week"|"month"|""
 * @returns {{ sessions: object[], total: number }}
 */
function normalizeIncludedIds(includedIds: string[] | undefined = undefined) {
  if (includedIds === undefined) {
    return undefined;
  }
  return Array.from(includedIds).filter(Boolean);
}

function indexedSortOrder(sort = "updated-desc", titleOverrides: SessionTitleOverrides = undefined) {
  if (sort === "updated-asc") {
    return { orderBy: "time_updated ASC, time_created ASC, id ASC", params: [] };
  }
  if (sort === "title-asc" || sort === "title-desc") {
    const hasOverrides = normalizeSessionTitleOverrides(titleOverrides).length > 0;
    const effectiveTitle = hasOverrides
      ? "COALESCE((SELECT value FROM json_each(?) AS title_override WHERE title_override.key = session_index.id), NULLIF(session_index.title, ''), session_index.id)"
      : "COALESCE(NULLIF(session_index.title, ''), session_index.id)";
    const direction = sort === "title-desc" ? "DESC" : "ASC";
    return {
      orderBy: `${effectiveTitle} COLLATE NOCASE ${direction}, session_index.time_updated DESC, session_index.id ASC`,
      params: hasOverrides ? [serializeSessionTitleOverrides(titleOverrides)] : []
    };
  }
  return { orderBy: "time_updated DESC, time_created DESC, id ASC", params: [] };
}

function idMembership(column: any, ids: any, params: any, negate = false) {
  if (ids.length === 0) return negate ? "1 = 1" : "0 = 1";
  params.push(JSON.stringify(ids));
  return `${column} ${negate ? "NOT " : ""}IN (SELECT value FROM json_each(?))`;
}

function indexedFilter(
  timeRange = "",
  search = "",
  project = "",
  includedIds: string[] | undefined = undefined,
  sessionKind = "all",
  excludedIds: Set<string> | undefined = undefined,
  titleOverrides: SessionTitleOverrides = undefined
) {
  const where = ["provider = ?"];
  const params = [];
  const db = getIndexDb();
  const now = Date.now();
  const included = normalizeIncludedIds(includedIds);
  const excluded = (normalizeIncludedIds as any)(excludedIds) || [];

  // Normal provider lists mirror SQLite providers by showing root sessions.
  // Explicit ID lookups (search, trash, or starred filters) may still surface
  // an independently addressable child session.
  if (included === undefined) {
    where.push("parent_id IS NULL");
  }

  if (search) {
    const searchConditions = ["COALESCE(title, '') LIKE ?", "COALESCE(directory, '') LIKE ?"];
    params.push(`%${search}%`, `%${search}%`);
    const overrideMatches = getSearchMatchingOverrideIds(titleOverrides, search);
    if (overrideMatches.length > 0) {
      searchConditions.push(idMembership("id", overrideMatches, params));
    }
    where.push(`(${searchConditions.join(" OR ")})`);
  }

  if (timeRange === "today") {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    where.push("time_updated >= ?");
    params.push(startOfDay.getTime());
  } else if (timeRange === "week") {
    where.push("time_updated >= ?");
    params.push(now - 7 * 86400000);
  } else if (timeRange === "month") {
    where.push("time_updated >= ?");
    params.push(now - 30 * 86400000);
  }

  if (project) {
    if (isEmptyProjectFilter(project)) {
      where.push("COALESCE(directory, '') = ''");
    } else {
      where.push("COALESCE(directory, '') = ?");
      params.push(project);
    }
  }

  if (excluded.length > 0) {
    where.push(idMembership("id", excluded, params, true));
  }

  if (included !== undefined) {
    if (included.length === 0) {
      where.push("0 = 1");
    } else {
      where.push(idMembership("id", included, params));
    }
  }

  const kind = normalizeSessionKindFilter(sessionKind);
  if (kind !== "all") {
    const titleCondition = analysisTitleSqlCondition("LOWER(COALESCE(NULLIF(title, ''), id))");
    const sourceKindCondition = kind === "analysis" ? `(${titleCondition})` : `NOT (${titleCondition})`;
    const overrideIds = getOverrideTitleIds(titleOverrides);
    const matchingOverrideIds = getKindMatchingOverrideIds(titleOverrides, kind);
    if (overrideIds.length > 0) {
      const sourceIdsCondition = idMembership("id", overrideIds, params, true);
      params.push(...analysisTitleSqlParams());
      if (matchingOverrideIds.length > 0) {
        const overrideIdsCondition = idMembership("id", matchingOverrideIds, params);
        where.push(`((${sourceIdsCondition} AND ${sourceKindCondition}) OR ${overrideIdsCondition})`);
      } else {
        where.push(`(${sourceIdsCondition} AND ${sourceKindCondition})`);
      }
    } else {
      where.push(sourceKindCondition);
      params.push(...analysisTitleSqlParams());
    }
  }

  return { db, whereClause: `WHERE ${where.join(" AND ")}`, params };
}

export function getIndexedSessions(provider: any, limit = 50, offset = 0, timeRange = "", search = "", project = "", sort = "updated-desc", includedIds = undefined, sessionKind = "all", excludedIds = undefined, titleOverrides: SessionTitleOverrides = undefined) {
  const { db, whereClause, params } = indexedFilter(timeRange, search, project, includedIds, sessionKind, excludedIds, titleOverrides);
  const { orderBy, params: sortParams } = indexedSortOrder(sort, titleOverrides);
  const total = db.prepare(`SELECT COUNT(*) as c FROM session_index ${whereClause}`).get(provider, ...params).c;
  const sessions = db.prepare(`
    SELECT * FROM session_index ${whereClause}
    ORDER BY ${orderBy} LIMIT ? OFFSET ?
  `).all(provider, ...params, ...sortParams, limit, offset);

  return { sessions, total };
}

export function getIndexedSessionProjects(provider: any, timeRange = "", search = "", includedIds: string[] | undefined = undefined, sessionKind = "all", excludedIds: Set<string> | undefined = undefined, titleOverrides: SessionTitleOverrides = undefined) {
  const { db, whereClause, params } = indexedFilter(timeRange, search, "", includedIds, sessionKind, excludedIds, titleOverrides);
  return db.prepare(`
    SELECT COALESCE(directory, '') AS id,
           COALESCE(NULLIF(directory, ''), 'Unknown project') AS label,
           COUNT(*) AS count
    FROM session_index
    ${whereClause}
    GROUP BY COALESCE(directory, '')
    ORDER BY count DESC, label COLLATE NOCASE ASC
  `).all(provider, ...params).map((row: any) => ({
    id: row.id,
    label: row.label,
    worktree: row.label,
    count: Number(row.count) || 0
  }));
}

export function getIndexedOverview(provider: any, timeRange = "", search = "", project = "", sessionKind = "all", excludedIds: Set<string> | undefined = undefined, includedIds: string[] | undefined = undefined, titleOverrides: SessionTitleOverrides = undefined) {
  const { db, whereClause, params } = indexedFilter(timeRange, search, project, includedIds, sessionKind, excludedIds, titleOverrides);
  const row = db.prepare(`
    SELECT COUNT(*) AS totalSessions,
           COALESCE(SUM(COALESCE(message_count, 0)), 0) AS totalMessages
    FROM session_index
    ${whereClause}
  `).get(provider, ...params);

  return {
    totalSessions: Number(row?.totalSessions) || 0,
    totalMessages: Number(row?.totalMessages) || 0
  };
}

export interface CrossProviderSessionQuery {
  providers: string[];
  limit?: number;
  offset?: number;
  timeRange?: string;
  search?: string;
  project?: string;
  sort?: string;
  sessionKind?: string;
  excluded?: Array<{ provider: string; id: string }>;
  titleOverrides?: Array<{ provider: string; id: string; title: string }>;
}

function crossProviderTitleExpression(params: any[], overrides: CrossProviderSessionQuery["titleOverrides"]) {
  if (!overrides?.length) return "COALESCE(NULLIF(session_index.title, ''), session_index.id)";
  params.push(JSON.stringify(overrides));
  return `COALESCE((
    SELECT json_extract(item.value, '$.title') FROM json_each(?) AS item
    WHERE json_extract(item.value, '$.provider') = session_index.provider
      AND json_extract(item.value, '$.id') = session_index.id
  ), NULLIF(session_index.title, ''), session_index.id)`;
}

function crossProviderFilter(query: CrossProviderSessionQuery, includeProject = true) {
  const db = getIndexDb();
  const providers = [...new Set(query.providers.filter(Boolean))];
  const where = ["provider IN (SELECT value FROM json_each(?))", "parent_id IS NULL"];
  const params: any[] = [JSON.stringify(providers)];
  const now = Date.now();

  if (providers.length === 0) where.push("0 = 1");
  if (query.search) {
    const effectiveTitle = crossProviderTitleExpression(params, query.titleOverrides);
    where.push(`(${effectiveTitle} LIKE ? OR COALESCE(directory, '') LIKE ?)`);
    params.push(`%${query.search}%`, `%${query.search}%`);
  }
  if (query.timeRange === "today") {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    where.push("time_updated >= ?");
    params.push(startOfDay.getTime());
  } else if (query.timeRange === "week") {
    where.push("time_updated >= ?");
    params.push(now - 7 * 86400000);
  } else if (query.timeRange === "month") {
    where.push("time_updated >= ?");
    params.push(now - 30 * 86400000);
  }
  if (includeProject && query.project) {
    if (isEmptyProjectFilter(query.project)) where.push("COALESCE(directory, '') = ''");
    else {
      where.push("normalize_cross_provider_project(COALESCE(directory, '')) = ?");
      params.push(normalizeCrossProviderProjectPath(query.project));
    }
  }
  const excluded = query.excluded || [];
  if (excluded.length > 0) {
    where.push("NOT EXISTS (SELECT 1 FROM json_each(?) AS hidden WHERE json_extract(hidden.value, '$.provider') = session_index.provider AND json_extract(hidden.value, '$.id') = session_index.id)");
    params.push(JSON.stringify(excluded));
  }
  const kind = normalizeSessionKindFilter(query.sessionKind);
  if (kind !== "all") {
    const effectiveTitle = crossProviderTitleExpression(params, query.titleOverrides);
    const titleCondition = analysisTitleSqlCondition(`LOWER(${effectiveTitle})`);
    where.push(kind === "analysis" ? titleCondition : `NOT (${titleCondition})`);
    params.push(...analysisTitleSqlParams());
  }
  return { db, whereClause: `WHERE ${where.join(" AND ")}`, params };
}

/** Query the viewer-owned index across providers while preserving (provider,id) identity. */
export function getCrossProviderSessions(query: CrossProviderSessionQuery) {
  const { db, whereClause, params } = crossProviderFilter(query);
  const limit = Math.max(1, Math.min(Number(query.limit) || 30, 100));
  const offset = Math.max(0, Number(query.offset) || 0);
  const sortParams: any[] = [];
  const effectiveTitle = query.sort === "title-asc" || query.sort === "title-desc"
    ? crossProviderTitleExpression(sortParams, query.titleOverrides)
    : "";
  const orderBy = query.sort === "updated-asc"
    ? "time_updated ASC, time_created ASC, provider ASC, id ASC"
    : query.sort === "title-asc"
      ? `${effectiveTitle} COLLATE NOCASE ASC, time_updated DESC, provider ASC, id ASC`
      : query.sort === "title-desc"
        ? `${effectiveTitle} COLLATE NOCASE DESC, time_updated DESC, provider ASC, id ASC`
        : "time_updated DESC, time_created DESC, provider ASC, id ASC";
  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM session_index ${whereClause}`).get(...params)?.c) || 0;
  const sessions = db.prepare(`SELECT * FROM session_index ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, ...sortParams, limit, offset);
  return { sessions, total };
}

export function getCrossProviderSessionProjects(query: CrossProviderSessionQuery) {
  const { db, whereClause, params } = crossProviderFilter(query, false);
  const rows = db.prepare(`
    SELECT COALESCE(directory, '') AS id,
           COALESCE(NULLIF(directory, ''), 'Unknown project') AS label,
           COUNT(*) AS count
    FROM session_index ${whereClause}
    GROUP BY COALESCE(directory, '')
    ORDER BY count DESC, label COLLATE NOCASE ASC
  `).all(...params);
  const grouped = new Map<string, { id: string; label: string; worktree: string; count: number }>();
  for (const row of rows) {
    const key = normalizeCrossProviderProjectPath(row.id);
    const count = Number(row.count) || 0;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += count;
    } else {
      grouped.set(key, { id: row.id, label: row.label, worktree: row.label, count });
    }
  }
  return [...grouped.values()].sort((left, right) => (
    right.count - left.count || left.label.localeCompare(right.label, undefined, { sensitivity: "base" })
  ));
}

export function getCrossProviderOverview(query: CrossProviderSessionQuery) {
  const { db, whereClause, params } = crossProviderFilter(query);
  const row = db.prepare(`SELECT COUNT(*) AS totalSessions, COALESCE(SUM(message_count), 0) AS totalMessages FROM session_index ${whereClause}`).get(...params);
  return { totalSessions: Number(row?.totalSessions) || 0, totalMessages: Number(row?.totalMessages) || 0 };
}

/**
 * Read a single indexed session without exposing the database to callers.
 */
export function getIndexedSession(provider: string, sessionId: string) {
  return getIndexDb().prepare(`
    SELECT id, provider, parent_id, title, directory, time_created, time_updated, message_count, token_count
    FROM session_index
    WHERE provider = ? AND id = ?
  `).get(provider, sessionId) || null;
}

/**
 * Search only the viewer-owned session metadata index. This is intentionally
 * narrower than the transcript search contract and accepts no SQL fragments.
 */
export function findIndexedSessionMetadata(
  provider: string,
  query: string,
  limit = 20,
  excludedIds: Set<string> = new Set(),
  updatedAfter: number | undefined = undefined,
  updatedBefore: number | undefined = undefined
) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  const terms = splitSearchTerms(query).map(escapeSqlLikePattern);
  if (!terms.length) return [];
  const where = ["provider = ?"];
  const params: any[] = [provider];
  for (const term of terms) {
    where.push("(COALESCE(title, '') LIKE ? ESCAPE '\\' OR COALESCE(directory, '') LIKE ? ESCAPE '\\')");
    params.push(`%${term}%`, `%${term}%`);
  }
  if (Number.isFinite(updatedAfter)) {
    where.push("time_updated >= ?");
    params.push(updatedAfter);
  }
  if (Number.isFinite(updatedBefore)) {
    where.push("time_updated <= ?");
    params.push(updatedBefore);
  }
  if (excludedIds.size > 0) {
    where.push(idMembership("id", [...excludedIds], params, true));
  }
  return getIndexDb().prepare(`
    SELECT id, provider, parent_id, title, directory, time_created, time_updated, message_count, token_count
    FROM session_index
    WHERE ${where.join(" AND ")}
    ORDER BY time_updated DESC, time_created DESC, id ASC
    LIMIT ?
  `).all(...params, safeLimit);
}

/**
 * Return direct children only; callers retain provider and metadata filtering.
 */
export function getIndexedSessionChildren(
  provider: string,
  parentId: string,
  limit = 20,
  excludedIds: Set<string> = new Set()
) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  const where = ["provider = ?", "parent_id = ?"];
  const params: any[] = [provider, parentId];
  if (excludedIds.size > 0) {
    where.push(idMembership("id", [...excludedIds], params, true));
  }
  return getIndexDb().prepare(`
    SELECT id, provider, parent_id, title, directory, time_created, time_updated, message_count, token_count
    FROM session_index
    WHERE ${where.join(" AND ")}
    ORDER BY time_updated DESC, time_created DESC, id ASC
    LIMIT ?
  `).all(...params, safeLimit);
}

/**
 * Run a full index for a provider using its scan() method.
 * @param {import('./providers/interface.js').ProviderAdapter} adapter
 */
export async function indexProvider(adapter: any) {
  const batch = [];
  for await (const session of adapter.scan()) {
    batch.push(session);
  }
  if (batch.length > 0) {
    upsertIndex(adapter.id, batch);
  }
  return batch.length;
}

/**
 * Get the latest time_updated for a provider in the index.
 * @param {string} provider
 * @returns {number}
 */
export function getLastIndexedTime(provider: any) {
  const db = getIndexDb();
  const row = db.prepare("SELECT MAX(last_indexed) as t FROM session_index WHERE provider = ?").get(provider);
  return row?.t || 0;
}

/**
 * Clear indexed sessions for a provider (or all providers).
 * @param {string} [provider]
 */
export function clearIndex(provider: any) {
  const db = getIndexDb();
  if (provider) {
    db.prepare("DELETE FROM session_index WHERE provider = ?").run(provider);
  } else {
    db.exec("DELETE FROM session_index");
  }
}
