import { DatabaseSync } from "node:sqlite";
import { getConfig } from "./config.js";
import { parseJson, createSnippet, mapDataRow } from "./providers/shared/parser.js";
import { analysisTitleSqlCondition, analysisTitleSqlParams, normalizeSessionKindFilter } from "./session-kind.js";
import { isEmptyProjectFilter } from "./project-filter.js";
import {
  getKindMatchingOverrideIds,
  getOverrideTitleIds,
  getSearchMatchingOverrideIds,
  normalizeSessionTitleOverrides,
  serializeSessionTitleOverrides,
  type SessionTitleOverrides
} from "./session-title-overrides.js";

let dbInstance: any;
let dbPath: string | undefined;
const dbInstances = new Map<string, any>();

function resolveDbPath(pathOverride: string | undefined = undefined) { return pathOverride || getConfig().dbPath; }

export function getDb(pathOverride: string | undefined = undefined) {
  const nextPath = resolveDbPath(pathOverride);

  if (dbInstances.has(nextPath)) {
    return dbInstances.get(nextPath);
  }

  const nextDb = new DatabaseSync(nextPath, { readOnly: true });
  nextDb.exec("PRAGMA busy_timeout = 5000;");
  dbInstances.set(nextPath, nextDb);
  dbInstance = nextDb;
  dbPath = nextPath;
  return nextDb;
}

export function closeDb(pathOverride = undefined) {
  const target = resolveDbPath(pathOverride);
  const instance = dbInstances.get(target);
  if (!instance) return;
  instance.close();
  dbInstances.delete(target);
  if (dbPath === target) {
    dbInstance = undefined;
    dbPath = undefined;
  }
}

function normalizeExcludedIds(excludedIds: Set<string> | undefined = undefined) {
  return excludedIds ? Array.from(excludedIds).filter(Boolean) : [];
}

function timeRangeCutoff(timeRange: any) {
  const now = Date.now();
  if (timeRange === "today") {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return startOfDay.getTime();
  }
  if (timeRange === "week") {
    return now - 7 * 86400000;
  }
  if (timeRange === "month") {
    return now - 30 * 86400000;
  }
  return null;
}

function normalizeIncludedIds(includedIds: string[] | undefined = undefined) {
  if (includedIds === undefined) {
    return undefined;
  }
  return Array.from(includedIds).filter(Boolean);
}

function sessionSortOrder(sort = "updated-desc", titleOverrides: SessionTitleOverrides = undefined) {
  if (sort === "updated-asc") {
    return { orderBy: "time_updated ASC, time_created ASC, id ASC", params: [] };
  }
  if (sort === "title-asc" || sort === "title-desc") {
    const hasOverrides = normalizeSessionTitleOverrides(titleOverrides).length > 0;
    const effectiveTitle = hasOverrides
      ? "COALESCE((SELECT value FROM json_each(?) AS title_override WHERE title_override.key = session.id), NULLIF(session.title, ''), NULLIF(session.slug, ''), session.id)"
      : "COALESCE(NULLIF(session.title, ''), NULLIF(session.slug, ''), session.id)";
    const direction = sort === "title-desc" ? "DESC" : "ASC";
    return {
      orderBy: `${effectiveTitle} COLLATE NOCASE ${direction}, session.time_updated DESC, session.id ASC`,
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

function sessionFilter(
  search = "",
  timeRange = "",
  project = "",
  excludedIds: Set<string> | undefined = undefined,
  includedIds: string[] | undefined = undefined,
  sessionKind = "all",
  titleOverrides: SessionTitleOverrides = undefined
) {
  const where = ["time_archived IS NULL", "parent_id IS NULL"];
  const params = [];
  const searchTerm = search ? `%${search}%` : null;
  const cutoff = timeRangeCutoff(timeRange);
  const excluded = normalizeExcludedIds(excludedIds);
  const included = normalizeIncludedIds(includedIds);

  if (searchTerm) {
    const searchConditions = [
      "COALESCE(title, '') LIKE ?",
      "COALESCE(slug, '') LIKE ?",
      "COALESCE(directory, '') LIKE ?"
    ];
    params.push(searchTerm, searchTerm, searchTerm);
    const overrideMatches = getSearchMatchingOverrideIds(titleOverrides, search);
    if (overrideMatches.length > 0) {
      searchConditions.push(idMembership("session.id", overrideMatches, params));
    }
    where.push(`(${searchConditions.join(" OR ")})`);
  }

  if (cutoff != null) {
    where.push("session.time_updated >= ?");
    params.push(cutoff);
  }

  if (project) {
    if (isEmptyProjectFilter(project)) {
      where.push("COALESCE(project_id, '') = ''");
    } else {
      where.push("COALESCE(project_id, '') = ?");
      params.push(project);
    }
  }

  if (excluded.length > 0) {
    where.push(idMembership("session.id", excluded, params, true));
  }

  if (included !== undefined) {
    if (included.length === 0) {
      where.push("0 = 1");
    } else {
      where.push(idMembership("session.id", included, params));
    }
  }

  const kind = normalizeSessionKindFilter(sessionKind);
  if (kind !== "all") {
    const titleCondition = analysisTitleSqlCondition("LOWER(COALESCE(NULLIF(session.title, ''), NULLIF(session.slug, ''), session.id))");
    const sourceKindCondition = kind === "analysis" ? `(${titleCondition})` : `NOT (${titleCondition})`;
    const overrideIds = getOverrideTitleIds(titleOverrides);
    const matchingOverrideIds = getKindMatchingOverrideIds(titleOverrides, kind);
    if (overrideIds.length > 0) {
      const sourceIdsCondition = idMembership("session.id", overrideIds, params, true);
      params.push(...analysisTitleSqlParams());
      if (matchingOverrideIds.length > 0) {
        const overrideIdsCondition = idMembership("session.id", matchingOverrideIds, params);
        where.push(`((${sourceIdsCondition} AND ${sourceKindCondition}) OR ${overrideIdsCondition})`);
      } else {
        where.push(`(${sourceIdsCondition} AND ${sourceKindCondition})`);
      }
    } else {
      where.push(sourceKindCondition);
      params.push(...analysisTitleSqlParams());
    }
  }

  return { whereClause: `WHERE ${where.join(" AND ")}`, params };
}

export function listSessions(limit = 50, offset = 0, search = "", timeRange = "", pathOverride: string | undefined = undefined, project = "", excludedIds: Set<string> | undefined = undefined, sort = "updated-desc", includedIds: string[] | undefined = undefined, sessionKind = "all", titleOverrides: SessionTitleOverrides = undefined) {
  const db = getDb(pathOverride);
  const { whereClause, params } = sessionFilter(search, timeRange, project, excludedIds, includedIds, sessionKind, titleOverrides);
  const { orderBy, params: sortParams } = sessionSortOrder(sort, titleOverrides);

  const sessions = db.prepare(`
    SELECT id, project_id, slug, title, directory, time_created, time_updated,
           summary_additions, summary_deletions, summary_files, time_archived
    FROM session
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, ...sortParams, limit, offset);

  const totalRow = db.prepare(`
    SELECT COUNT(*) AS total
    FROM session
    ${whereClause}
  `).get(...params);

  return { sessions, total: totalRow?.total ?? 0 };
}

export function listSessionProjects(search = "", timeRange = "", pathOverride: string | undefined = undefined, excludedIds: Set<string> | undefined = undefined, includedIds: string[] | undefined = undefined, sessionKind = "all", titleOverrides: SessionTitleOverrides = undefined) {
  const db = getDb(pathOverride);
  const { whereClause, params } = sessionFilter(search, timeRange, "", excludedIds, includedIds, sessionKind, titleOverrides);
  const rows = db.prepare(`
    SELECT
      COALESCE(session.project_id, '') AS id,
      COALESCE(NULLIF(project.name, ''), NULLIF(project.worktree, ''), NULLIF(session.directory, ''), 'Unknown project') AS label,
      project.worktree AS worktree,
      COUNT(*) AS count
    FROM session
    LEFT JOIN project ON project.id = session.project_id
    ${whereClause}
    GROUP BY COALESCE(session.project_id, '')
    ORDER BY count DESC, label COLLATE NOCASE ASC
  `).all(...params);

  return rows.map((row: any) => ({
    id: row.id,
    label: row.label,
    worktree: row.worktree || row.label,
    count: Number(row.count) || 0
  }));
}

export function getSession(id: any, pathOverride: string | undefined = undefined) {
  return getSessionSafe(id, pathOverride);
}

export function getSessionSafe(id: any, pathOverride: string | undefined = undefined) {
  const db = getDb(pathOverride);
  const row = db.prepare(`SELECT * FROM session WHERE id = ?`).get(id);
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    parent_id: row.parent_id,
    slug: row.slug,
    title: row.title,
    directory: row.directory,
    time_created: row.time_created,
    time_updated: row.time_updated,
    summary_additions: row.summary_additions ?? 0,
    summary_deletions: row.summary_deletions ?? 0,
    summary_files: row.summary_files ?? 0,
    time_archived: row.time_archived,
    agent: row.agent ?? null,
    model: row.model ?? null,
    cost: row.cost ?? 0,
    tokens_input: row.tokens_input ?? 0,
    tokens_output: row.tokens_output ?? 0,
    tokens_reasoning: row.tokens_reasoning ?? 0,
    tokens_cache_read: row.tokens_cache_read ?? 0,
    tokens_cache_write: row.tokens_cache_write ?? 0,
  };
}

export function getChildSessions(parentId: any, pathOverride = undefined) {
  return getChildSessionsSafe(parentId, pathOverride);
}

export function getChildSessionsSafe(parentId: any, pathOverride: string | undefined = undefined) {
  const db = getDb(pathOverride);
  const rows = db.prepare(`
    SELECT *
    FROM session
    WHERE parent_id = ?
      AND time_archived IS NULL
    ORDER BY time_created ASC, id ASC
  `).all(parentId);
  return rows.map((row: any) => ({
    id: row.id,
    project_id: row.project_id,
    parent_id: row.parent_id,
    slug: row.slug,
    title: row.title,
    directory: row.directory,
    time_created: row.time_created,
    time_updated: row.time_updated,
    summary_additions: row.summary_additions ?? 0,
    summary_deletions: row.summary_deletions ?? 0,
    summary_files: row.summary_files ?? 0,
    time_archived: row.time_archived,
    agent: row.agent ?? null,
    model: row.model ?? null,
    cost: row.cost ?? 0,
    tokens_input: row.tokens_input ?? 0,
    tokens_output: row.tokens_output ?? 0,
    tokens_reasoning: row.tokens_reasoning ?? 0,
    tokens_cache_read: row.tokens_cache_read ?? 0,
    tokens_cache_write: row.tokens_cache_write ?? 0,
  }));
}

export function getMessages(sessionId: any, pathOverride: string | undefined = undefined) {
  const db = getDb(pathOverride);
  const rows = db.prepare(`
    SELECT id, session_id, data
    FROM message
    WHERE session_id = ?
    ORDER BY COALESCE(CAST(json_extract(data, '$.time.created') AS INTEGER), 0), id
  `).all(sessionId);

  return rows.map(mapDataRow);
}

export function getParts(messageId: any, pathOverride: string | undefined = undefined) {
  const db = getDb(pathOverride);
  const rows = db.prepare(`
    SELECT id, message_id, session_id, data
    FROM part
    WHERE message_id = ?
    ORDER BY rowid ASC, id ASC
  `).all(messageId);

  return rows.map(mapDataRow);
}

export function getTodos(sessionId: any, pathOverride: string | undefined = undefined) {
  const db = getDb(pathOverride);
  return db.prepare(`
    SELECT session_id, content, status, priority, position, time_created
    FROM todo
    WHERE session_id = ?
    ORDER BY position ASC, time_created ASC
  `).all(sessionId);
}

export function searchMessages(query: any, limit = 20, pathOverride: string | undefined = undefined, excludedIds: Set<string> | undefined = undefined) {
  const db = getDb(pathOverride);
  const term = query?.trim();

  if (!term) {
    return [];
  }

  const searchTerm = `%${term}%`;
  const excluded = normalizeExcludedIds(excludedIds);
  const excludedClause = excluded.length
    ? `AND session.id NOT IN (${excluded.map(() => "?").join(", ")})`
    : "";
  const rows = db.prepare(`
    SELECT part.id AS part_id,
           part.message_id,
           part.session_id,
           part.data AS part_data,
           message.data AS message_data,
           session.title AS session_title,
           session.slug AS session_slug,
           session.time_updated
    FROM part
    JOIN message ON message.id = part.message_id
    JOIN session ON session.id = part.session_id
    WHERE session.time_archived IS NULL
      AND session.parent_id IS NULL
      AND COALESCE(json_extract(part.data, '$.text'), '') LIKE ?
      ${excludedClause}
    ORDER BY session.time_updated DESC,
             COALESCE(CAST(json_extract(message.data, '$.time.created') AS INTEGER), 0) DESC,
             part.id DESC
    LIMIT ?
  `).all(searchTerm, ...excluded, limit);

  return rows.map((row: any) => {
    const partData = parseJson(row.part_data) || {};
    const messageData = parseJson(row.message_data) || {};
    const text = partData.text || "";

    return {
      partId: row.part_id,
      messageId: row.message_id,
      sessionId: row.session_id,
      sessionTitle: row.session_title,
      sessionSlug: row.session_slug,
      timeUpdated: row.time_updated,
      role: messageData.role,
      text,
      snippet: createSnippet(text, term)
    };
  });
}

export function getStats(pathOverride: string | undefined = undefined) {
  const db = getDb(pathOverride);
  const overview = getOverviewStats(pathOverride);

  const modelDistribution = db.prepare(`
    SELECT
      CASE
        WHEN json_extract(message.data, '$.providerID') IS NOT NULL
          AND json_extract(message.data, '$.modelID') IS NOT NULL
          THEN json_extract(message.data, '$.providerID') || '/' || json_extract(message.data, '$.modelID')
        WHEN json_extract(message.data, '$.modelID') IS NOT NULL
          THEN json_extract(message.data, '$.modelID')
        ELSE 'unknown'
      END AS model,
      COUNT(*) AS count
    FROM message
    JOIN session ON session.id = message.session_id
    WHERE session.time_archived IS NULL
      AND session.parent_id IS NULL
    GROUP BY model
    ORDER BY count DESC, model ASC
  `).all().map((row: any) => ({
    model: row.model,
    count: row.count
  }));

  return {
    ...overview,
    modelDistribution
  };
}

export function getOverviewStats(pathOverride: string | undefined = undefined) {
  const db = getDb(pathOverride);
  const totalSessions = db.prepare(`
    SELECT COUNT(*) AS count
    FROM session
    WHERE time_archived IS NULL
      AND parent_id IS NULL
  `).get()?.count ?? 0;

  const totalMessages = db.prepare(`
    SELECT COUNT(*) AS count
    FROM message
    JOIN session ON session.id = message.session_id
    WHERE session.time_archived IS NULL
      AND session.parent_id IS NULL
  `).get()?.count ?? 0;

  return {
    totalSessions,
    totalMessages
  };
}

function statsTokenComponentSql(dataColumn = "message.data") {
  return `COALESCE(json_extract(${dataColumn}, '$.tokens.input'), 0)
    + COALESCE(json_extract(${dataColumn}, '$.tokens.output'), 0)
    + COALESCE(json_extract(${dataColumn}, '$.tokens.reasoning'), 0)
    + COALESCE(json_extract(${dataColumn}, '$.tokens.cache.read'), 0)
    + COALESCE(json_extract(${dataColumn}, '$.tokens.cache.write'), 0)`;
}

function statsUsableTokenSql(dataColumn = "message.data") {
  return `(COALESCE(json_extract(${dataColumn}, '$.tokens.total'), 0) > 0 OR (${statsTokenComponentSql(dataColumn)}) > 0)`;
}

function statsTokenValueSql(dataColumn = "message.data") {
  return `CASE WHEN COALESCE(json_extract(${dataColumn}, '$.tokens.total'), 0) > 0
    THEN COALESCE(json_extract(${dataColumn}, '$.tokens.total'), 0)
    ELSE (${statsTokenComponentSql(dataColumn)}) END`;
}

function appendStatsProjectFilter(conds: string[], params: any[], project: string | undefined) {
  if (isEmptyProjectFilter(project)) {
    conds.push("COALESCE(session.project_id, '') = ''");
  } else if (project) {
    conds.push("COALESCE(session.project_id, '') = ?");
    params.push(project);
  }
}

function statsDayStartMs(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return null;
  }
  return parsed.getTime();
}

export function getTokenStats(days = 30, pathOverride = undefined, opts: { project?: string; modelPair?: string; scope?: "root" | "all"; fromDate?: string; toDate?: string } = {}) {
  const d = getDb(pathOverride);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const cutoffMs = today.getTime() - (Math.max(1, days) - 1) * 86400000;

  const conds: string[] = [
    "json_extract(message.data, '$.role') = 'assistant'",
    statsUsableTokenSql(),
    "session.time_archived IS NULL",
  ];
  const params: any[] = [];

  // Date range
  if (opts.fromDate && opts.toDate) {
    const fromMs = new Date(opts.fromDate + "T00:00:00Z").getTime();
    const toMs = new Date(opts.toDate + "T23:59:59.999Z").getTime();
    conds.push("json_extract(message.data, '$.time.created') >= ?");
    conds.push("json_extract(message.data, '$.time.created') <= ?");
    params.push(fromMs, toMs);
  } else {
    conds.push("json_extract(message.data, '$.time.created') >= ?");
    params.push(cutoffMs);
  }

  // Scope
  if (opts.scope === "root") {
    conds.push("session.parent_id IS NULL");
  }

  // Project
  appendStatsProjectFilter(conds, params, opts.project);

  // Model/provider pair
  if (opts.modelPair) {
    conds.push("(json_extract(message.data, '$.providerID') || '/' || json_extract(message.data, '$.modelID')) = ?");
    params.push(opts.modelPair);
  }

  const where = conds.join(" AND ");

  return d.prepare(`
    SELECT date(json_extract(message.data, '$.time.created') / 1000, 'unixepoch') as day,
           SUM(${statsTokenValueSql()}) as total_tokens,
           SUM(COALESCE(json_extract(message.data, '$.tokens.input'), 0)) as input_tokens,
           SUM(COALESCE(json_extract(message.data, '$.tokens.output'), 0)) as output_tokens,
           SUM(COALESCE(json_extract(message.data, '$.tokens.reasoning'), 0)) as reasoning_tokens,
           SUM(COALESCE(json_extract(message.data, '$.tokens.cache.read'), 0)) as cache_read_tokens,
           SUM(COALESCE(json_extract(message.data, '$.tokens.cache.write'), 0)) as cache_write_tokens,
           COUNT(*) as message_count
    FROM message
    JOIN session ON session.id = message.session_id
    WHERE ${where}
    GROUP BY day ORDER BY day ASC
  `).all(...params);
}

export function getModelDistribution(pathOverride = undefined, opts: { days?: number; fromDate?: string; toDate?: string; project?: string; modelPair?: string; scope?: "root" | "all" } = {}) {
  const d = getDb(pathOverride);
  const conds: string[] = [
    "json_extract(message.data, '$.role') = 'assistant'",
    "json_extract(message.data, '$.modelID') IS NOT NULL",
    statsUsableTokenSql(),
    "session.time_archived IS NULL",
  ];
  const params: any[] = [];

  // Only apply date filter when explicitly requested
  if (opts.fromDate && opts.toDate) {
    const fromMs = new Date(opts.fromDate + "T00:00:00Z").getTime();
    const toMs = new Date(opts.toDate + "T23:59:59.999Z").getTime();
    conds.push("json_extract(message.data, '$.time.created') >= ?");
    conds.push("json_extract(message.data, '$.time.created') <= ?");
    params.push(fromMs, toMs);
  } else if (opts.days) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const cutoffMs = today.getTime() - (Math.max(1, opts.days) - 1) * 86400000;
    conds.push("json_extract(message.data, '$.time.created') >= ?");
    params.push(cutoffMs);
  }

  if (opts.scope === "root") {
    conds.push("session.parent_id IS NULL");
  }
  appendStatsProjectFilter(conds, params, opts.project);
  if (opts.modelPair) {
    conds.push("(json_extract(message.data, '$.providerID') || '/' || json_extract(message.data, '$.modelID')) = ?");
    params.push(opts.modelPair);
  }

  const where = conds.join(" AND ");

  return d.prepare(`
    SELECT json_extract(message.data, '$.modelID') as model,
           json_extract(message.data, '$.providerID') as provider,
           COUNT(*) as count,
           SUM(${statsTokenValueSql()}) as total_tokens
    FROM message
    JOIN session ON session.id = message.session_id
    WHERE ${where}
    GROUP BY 1, 2
    ORDER BY total_tokens DESC
  `).all(...params);
}

export function getDailySessionCounts(days = 30, pathOverride = undefined, opts: { fromDate?: string; toDate?: string; project?: string; scope?: "root" | "all" } = {}) {
  const d = getDb(pathOverride);
  const conds: string[] = ["time_archived IS NULL"];
  const params: any[] = [];

  if (opts.fromDate && opts.toDate) {
    const fromMs = new Date(opts.fromDate + "T00:00:00Z").getTime();
    const toMs = new Date(opts.toDate + "T23:59:59.999Z").getTime();
    conds.push("time_created >= ?");
    conds.push("time_created <= ?");
    params.push(fromMs, toMs);
  } else {
    const cutoff = Date.now() - days * 86400000;
    conds.push("time_created >= ?");
    params.push(cutoff);
  }

  if (opts.scope === "root") {
    conds.push("parent_id IS NULL");
  }
  if (opts.project) {
    conds.push("COALESCE(project_id, '') = ?");
    params.push(opts.project);
  }

  const where = conds.join(" AND ");

  return d.prepare(`
    SELECT date(time_created / 1000, 'unixepoch') as day,
           COUNT(*) as count
    FROM session
     WHERE ${where}
     GROUP BY day ORDER BY day ASC
  `).all(...params);
}

export function getSessionsByIds(ids: any, pathOverride = undefined) {
  if (!ids.length) return [];
  const db = getDb(pathOverride);
  const placeholders = ids.map(() => "?").join(",");
  return db.prepare(`
    SELECT id, project_id, slug, title, directory, time_created, time_updated,
           summary_additions, summary_deletions, summary_files
    FROM session
    WHERE id IN (${placeholders})
    ORDER BY time_updated DESC
  `).all(...ids);
}

/**
 * Get top token-consuming sessions for the Token Explorer table.
 * Aggregates tokens across all messages in each session.
 */
export function getTopTokenSessions(pathOverride = undefined, opts: {
  days?: number; fromDate?: string; toDate?: string;
  project?: string; modelPair?: string; scope?: "root" | "all";
  day?: string; limit?: number;
} = {}): any[] {
  const d = getDb(pathOverride);
  const conds: string[] = [
    "json_extract(message.data, '$.role') = 'assistant'",
    statsUsableTokenSql(),
    "session.time_archived IS NULL",
  ];
  const params: any[] = [];
  const days = opts.days || 30;

  // Day drill-down takes priority over all other date filters
  if (opts.day) {
    const dayMs = statsDayStartMs(opts.day);
    if (dayMs === null) {
      // Invalid day; fall through to default behavior
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const cutoffMs = today.getTime() - (Math.max(1, days) - 1) * 86400000;
      conds.push("json_extract(message.data, '$.time.created') >= ?");
      params.push(cutoffMs);
    } else {
      const dayStart = dayMs;
      const dayEnd = dayMs + 86400000 - 1;
      conds.push("json_extract(message.data, '$.time.created') >= ?");
      conds.push("json_extract(message.data, '$.time.created') <= ?");
      params.push(dayStart, dayEnd);
    }
  } else if (opts.fromDate && opts.toDate) {
    const fromMs = new Date(opts.fromDate + "T00:00:00Z").getTime();
    const toMs = new Date(opts.toDate + "T23:59:59.999Z").getTime();
    conds.push("json_extract(message.data, '$.time.created') >= ?");
    conds.push("json_extract(message.data, '$.time.created') <= ?");
    params.push(fromMs, toMs);
  } else {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const cutoffMs = today.getTime() - (Math.max(1, days) - 1) * 86400000;
    conds.push("json_extract(message.data, '$.time.created') >= ?");
    params.push(cutoffMs);
  }

  if (opts.scope === "root") {
    conds.push("session.parent_id IS NULL");
  }
  appendStatsProjectFilter(conds, params, opts.project);
  if (opts.modelPair) {
    conds.push("(json_extract(message.data, '$.providerID') || '/' || json_extract(message.data, '$.modelID')) = ?");
    params.push(opts.modelPair);
  }

  const where = conds.join(" AND ");
  const limit = Math.min(opts.limit || 20, 100);

  return d.prepare(`
    SELECT session.id as session_id,
           COALESCE(NULLIF(session.title, ''), NULLIF(session.slug, ''), session.id) as title,
           COALESCE(session.directory, '') as directory,
           COALESCE(session.project_id, '') as project_id,
           session.time_updated,
           CASE
             WHEN COUNT(DISTINCT CASE
               WHEN json_extract(message.data, '$.modelID') IS NOT NULL
               THEN COALESCE(json_extract(message.data, '$.providerID'), 'unknown') || '/' || json_extract(message.data, '$.modelID')
             END) > 1 THEN '__multiple__'
             WHEN COUNT(DISTINCT CASE
               WHEN json_extract(message.data, '$.modelID') IS NOT NULL
               THEN COALESCE(json_extract(message.data, '$.providerID'), 'unknown') || '/' || json_extract(message.data, '$.modelID')
             END) = 1 THEN MIN(CASE
               WHEN json_extract(message.data, '$.modelID') IS NOT NULL
               THEN COALESCE(json_extract(message.data, '$.providerID'), 'unknown') || '/' || json_extract(message.data, '$.modelID')
             END)
             ELSE '__unknown__'
           END as provider_model,
           COUNT(DISTINCT CASE
             WHEN json_extract(message.data, '$.modelID') IS NOT NULL
             THEN COALESCE(json_extract(message.data, '$.providerID'), 'unknown') || '/' || json_extract(message.data, '$.modelID')
           END) as model_count,
           SUM(${statsTokenValueSql()}) as total_tokens,
           COUNT(DISTINCT message.id) as message_count
    FROM message
    JOIN session ON session.id = message.session_id
    WHERE ${where}
    GROUP BY session.id
    ORDER BY total_tokens DESC
    LIMIT ?
  `).all(...params, limit);
}

/**
 * Get coverage information: how many messages/sessions have usable token data
 * and which token dimensions are available.
 */
export function getTokenCoverage(pathOverride = undefined, opts: {
  days?: number; fromDate?: string; toDate?: string;
  project?: string; modelPair?: string; scope?: "root" | "all";
} = {}): { messagesWithTokens: number; totalAssistantMessages: number; sessionsWithTokens: number; totalSessions: number; dimensions: { input: boolean; output: boolean; reasoning: boolean; cacheRead: boolean; cacheWrite: boolean } } {
  const d = getDb(pathOverride);
  const conds: string[] = [
    "json_extract(message.data, '$.role') = 'assistant'",
    "session.time_archived IS NULL",
  ];
  const params: any[] = [];
  const days = opts.days || 30;

  if (opts.fromDate && opts.toDate) {
    const fromMs = new Date(opts.fromDate + "T00:00:00Z").getTime();
    const toMs = new Date(opts.toDate + "T23:59:59.999Z").getTime();
    conds.push("json_extract(message.data, '$.time.created') >= ?");
    conds.push("json_extract(message.data, '$.time.created') <= ?");
    params.push(fromMs, toMs);
  } else {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const cutoffMs = today.getTime() - (Math.max(1, days) - 1) * 86400000;
    conds.push("json_extract(message.data, '$.time.created') >= ?");
    params.push(cutoffMs);
  }

  if (opts.scope === "root") {
    conds.push("session.parent_id IS NULL");
  }
  appendStatsProjectFilter(conds, params, opts.project);
  if (opts.modelPair) {
    conds.push("(json_extract(message.data, '$.providerID') || '/' || json_extract(message.data, '$.modelID')) = ?");
    params.push(opts.modelPair);
  }

  const where = conds.join(" AND ");

  // Keep coverage to one scan of the same filtered assistant-message set.
  // A dimension counts as available even when every observed value is zero.
  const usable = statsUsableTokenSql();
  const summary = d.prepare(`
    SELECT
      COUNT(*) as total_assistant_messages,
      COUNT(DISTINCT session.id) as total_sessions,
      SUM(CASE WHEN ${usable} THEN 1 ELSE 0 END) as messages_with_tokens,
      COUNT(DISTINCT CASE WHEN ${usable} THEN session.id END) as sessions_with_tokens,
      MAX(CASE WHEN json_type(message.data, '$.tokens.input') IS NOT NULL THEN 1 ELSE 0 END) as has_input,
      MAX(CASE WHEN json_type(message.data, '$.tokens.output') IS NOT NULL THEN 1 ELSE 0 END) as has_output,
      MAX(CASE WHEN json_type(message.data, '$.tokens.reasoning') IS NOT NULL THEN 1 ELSE 0 END) as has_reasoning,
      MAX(CASE WHEN json_type(message.data, '$.tokens.cache.read') IS NOT NULL THEN 1 ELSE 0 END) as has_cache_read,
      MAX(CASE WHEN json_type(message.data, '$.tokens.cache.write') IS NOT NULL THEN 1 ELSE 0 END) as has_cache_write
    FROM message
    JOIN session ON session.id = message.session_id
    WHERE ${where}
  `).get(...params);

  return {
    messagesWithTokens: Number(summary?.messages_with_tokens) || 0,
    totalAssistantMessages: Number(summary?.total_assistant_messages) || 0,
    sessionsWithTokens: Number(summary?.sessions_with_tokens) || 0,
    totalSessions: Number(summary?.total_sessions) || 0,
    dimensions: {
      input: Boolean(summary?.has_input),
      output: Boolean(summary?.has_output),
      reasoning: Boolean(summary?.has_reasoning),
      cacheRead: Boolean(summary?.has_cache_read),
      cacheWrite: Boolean(summary?.has_cache_write),
    },
  };
}

/**
 * Get distinct model/provider pairs that appear in the data.
 */
export function getModelPairs(pathOverride = undefined, opts: {
  days?: number; fromDate?: string; toDate?: string;
  project?: string; scope?: "root" | "all";
} = {}): Array<{ key: string; model: string; provider: string; totalTokens: number }> {
  const d = getDb(pathOverride);
  const conds: string[] = [
    "json_extract(message.data, '$.role') = 'assistant'",
    "json_extract(message.data, '$.modelID') IS NOT NULL",
    statsUsableTokenSql(),
    "session.time_archived IS NULL",
  ];
  const params: any[] = [];
  const days = opts.days || 30;

  if (opts.fromDate && opts.toDate) {
    const fromMs = new Date(opts.fromDate + "T00:00:00Z").getTime();
    const toMs = new Date(opts.toDate + "T23:59:59.999Z").getTime();
    conds.push("json_extract(message.data, '$.time.created') >= ?");
    conds.push("json_extract(message.data, '$.time.created') <= ?");
    params.push(fromMs, toMs);
  } else {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const cutoffMs = today.getTime() - (Math.max(1, days) - 1) * 86400000;
    conds.push("json_extract(message.data, '$.time.created') >= ?");
    params.push(cutoffMs);
  }

  if (opts.scope === "root") {
    conds.push("session.parent_id IS NULL");
  }
  appendStatsProjectFilter(conds, params, opts.project);

  const where = conds.join(" AND ");

  return d.prepare(`
    SELECT
      (json_extract(message.data, '$.providerID') || '/' || json_extract(message.data, '$.modelID')) as key,
      json_extract(message.data, '$.modelID') as model,
      json_extract(message.data, '$.providerID') as provider,
      SUM(${statsTokenValueSql()}) as total_tokens
    FROM message
    JOIN session ON session.id = message.session_id
    WHERE ${where}
    GROUP BY 1
    ORDER BY total_tokens DESC
  `).all(...params);
}

/**
 * Get distinct project_id values from sessions that have messages for stats filtering.
 */
export function getStatsProjects(pathOverride = undefined, opts: {
  days?: number; fromDate?: string; toDate?: string;
  scope?: "root" | "all";
} = {}): Array<{ projectId: string; label: string; count: number }> {
  const d = getDb(pathOverride);
  const conds: string[] = [
    "json_extract(message.data, '$.role') = 'assistant'",
    statsUsableTokenSql(),
    "session.time_archived IS NULL",
  ];
  const params: any[] = [];
  const days = opts.days || 30;

  if (opts.fromDate && opts.toDate) {
    const fromMs = new Date(opts.fromDate + "T00:00:00Z").getTime();
    const toMs = new Date(opts.toDate + "T23:59:59.999Z").getTime();
    conds.push("json_extract(message.data, '$.time.created') >= ?");
    conds.push("json_extract(message.data, '$.time.created') <= ?");
    params.push(fromMs, toMs);
  } else {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const cutoffMs = today.getTime() - (Math.max(1, days) - 1) * 86400000;
    conds.push("json_extract(message.data, '$.time.created') >= ?");
    params.push(cutoffMs);
  }

  if (opts.scope === "root") {
    conds.push("session.parent_id IS NULL");
  }

  const where = conds.join(" AND ");

  return d.prepare(`
    SELECT COALESCE(session.project_id, '') as project_id,
           COALESCE(NULLIF(project.name, ''), NULLIF(project.worktree, ''), NULLIF(session.directory, ''), NULLIF(session.project_id, ''), '') as label,
           COUNT(DISTINCT session.id) as count
    FROM message
    JOIN session ON session.id = message.session_id
    LEFT JOIN project ON project.id = session.project_id
    WHERE ${where}
    GROUP BY COALESCE(session.project_id, ''), label
    ORDER BY count DESC, project_id ASC
  `).all(...params).map((row: any) => ({
    projectId: String(row.project_id || ""),
    label: String(row.label || row.project_id || ""),
    count: Number(row.count) || 0,
  }));
}

/**
 * Get filtered session count for overview using message timestamps.
 */
export function getFilteredSessionCount(pathOverride = undefined, opts: {
  days?: number; fromDate?: string; toDate?: string;
  project?: string; modelPair?: string; scope?: "root" | "all";
} = {}): number {
  const d = getDb(pathOverride);
  const conds: string[] = [
    "json_extract(message.data, '$.role') = 'assistant'",
    statsUsableTokenSql(),
    "session.time_archived IS NULL",
  ];
  const params: any[] = [];
  const days = opts.days || 30;

  if (opts.fromDate && opts.toDate) {
    const fromMs = new Date(opts.fromDate + "T00:00:00Z").getTime();
    const toMs = new Date(opts.toDate + "T23:59:59.999Z").getTime();
    conds.push("json_extract(message.data, '$.time.created') >= ?");
    conds.push("json_extract(message.data, '$.time.created') <= ?");
    params.push(fromMs, toMs);
  } else {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const cutoffMs = today.getTime() - (Math.max(1, days) - 1) * 86400000;
    conds.push("json_extract(message.data, '$.time.created') >= ?");
    params.push(cutoffMs);
  }

  if (opts.scope === "root") {
    conds.push("session.parent_id IS NULL");
  }
  appendStatsProjectFilter(conds, params, opts.project);
  if (opts.modelPair) {
    conds.push("(json_extract(message.data, '$.providerID') || '/' || json_extract(message.data, '$.modelID')) = ?");
    params.push(opts.modelPair);
  }

  const where = conds.join(" AND ");
  return d.prepare(`SELECT COUNT(DISTINCT session.id) as cnt FROM message JOIN session ON session.id = message.session_id WHERE ${where}`).get(...params)?.cnt ?? 0;
}

/**
 * Get aggregate tokens, sessions, and message records for an exact date range.
 * Used by the period comparison feature.
 */
export function getPreviousPeriodAggregates(pathOverride = undefined, opts: {
  fromDate: string; toDate: string;
  project?: string; modelPair?: string; scope?: "root" | "all";
}) {
  const d = getDb(pathOverride);
  const conds: string[] = [
    "json_extract(message.data, '$.role') = 'assistant'",
    statsUsableTokenSql(),
    "session.time_archived IS NULL",
  ];
  const params: any[] = [];
  const fromMs = new Date(opts.fromDate + "T00:00:00Z").getTime();
  const toMs = new Date(opts.toDate + "T23:59:59.999Z").getTime();
  conds.push("json_extract(message.data, '$.time.created') >= ?");
  conds.push("json_extract(message.data, '$.time.created') <= ?");
  params.push(fromMs, toMs);

  if (opts.scope === "root") conds.push("session.parent_id IS NULL");
  appendStatsProjectFilter(conds, params, opts.project);
  if (opts.modelPair) {
    conds.push("(json_extract(message.data, '$.providerID') || '/' || json_extract(message.data, '$.modelID')) = ?");
    params.push(opts.modelPair);
  }
  const where = conds.join(" AND ");

  const row = d.prepare(`SELECT COUNT(DISTINCT session.id) as sessions, COUNT(*) as records, SUM(${statsTokenValueSql()}) as tokens FROM message JOIN session ON session.id = message.session_id WHERE ${where}`).get(...params);
  return { tokens: Number(row?.tokens) || 0, sessions: Number(row?.sessions) || 0, records: Number(row?.records) || 0 };
}

/**
 * Get stats for a specific model within the current filter context,
 * including share of total tokens.
 */
export function getCompareModelStats(pathOverride = undefined, opts: {
  days?: number; fromDate?: string; toDate?: string;
  project?: string; scope?: "root" | "all";
  modelKey: string;
}) {
  const d = getDb(pathOverride);

  // Build date conditions once, shared by both total and model-specific queries
  const dateConds: string[] = [];
  const dateParams: any[] = [];
  if (opts.fromDate && opts.toDate) {
    const fromMs = new Date(opts.fromDate + "T00:00:00Z").getTime();
    const toMs = new Date(opts.toDate + "T23:59:59.999Z").getTime();
    dateConds.push("json_extract(message.data, '$.time.created') >= ?");
    dateConds.push("json_extract(message.data, '$.time.created') <= ?");
    dateParams.push(fromMs, toMs);
  } else {
    const days = opts.days || 30;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const cutoffMs = today.getTime() - (Math.max(1, days) - 1) * 86400000;
    dateConds.push("json_extract(message.data, '$.time.created') >= ?");
    dateParams.push(cutoffMs);
  }

  // Base conditions (no model filter) for total aggregation
  const baseConds = [
    "json_extract(message.data, '$.role') = 'assistant'",
    statsUsableTokenSql(),
    "session.time_archived IS NULL",
    ...dateConds,
  ];
  const baseParams = [...dateParams];
  if (opts.scope === "root") baseConds.push("session.parent_id IS NULL");
  appendStatsProjectFilter(baseConds, baseParams, opts.project);
  const baseWhere = baseConds.join(" AND ");
  const totalRow = d.prepare(`SELECT SUM(${statsTokenValueSql()}) as total FROM message JOIN session ON session.id = message.session_id WHERE ${baseWhere}`).get(...baseParams);

  // Model-specific conditions
  const modelConds = [
    "json_extract(message.data, '$.role') = 'assistant'",
    statsUsableTokenSql(),
    "session.time_archived IS NULL",
    ...dateConds,
    "(json_extract(message.data, '$.providerID') || '/' || json_extract(message.data, '$.modelID')) = ?",
  ];
  const modelParams = [...dateParams, opts.modelKey];
  if (opts.scope === "root") modelConds.push("session.parent_id IS NULL");
  appendStatsProjectFilter(modelConds, modelParams, opts.project);
  const modelWhere = modelConds.join(" AND ");
  const row = d.prepare(`SELECT SUM(${statsTokenValueSql()}) as total_tokens, COUNT(*) as record_count FROM message JOIN session ON session.id = message.session_id WHERE ${modelWhere}`).get(...modelParams);

  const totalTokens = Number(row?.total_tokens) || 0;
  const recordCount = Number(row?.record_count) || 0;
  const allTokens = Number(totalRow?.total) || 0;
  return {
    totalTokens,
    recordCount,
    tokensPerRecord: recordCount > 0 ? Math.round(totalTokens / recordCount) : null,
    share: allTokens > 0 ? totalTokens / allTokens : 0,
  };
}
