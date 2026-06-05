import { DatabaseSync } from "node:sqlite";
import { getConfig } from "./config.js";
import { parseJson, createSnippet, mapDataRow } from "./providers/opencode/parser.js";

let dbInstance;
let dbPath;
const dbInstances = new Map();

function resolveDbPath(pathOverride = undefined) { return pathOverride || getConfig().dbPath; }

export function getDb(pathOverride = undefined) {
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

function timeRangeCutoff(timeRange) {
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

function sessionFilter(search = "", timeRange = "", project = "") {
  const where = ["time_archived IS NULL", "parent_id IS NULL"];
  const params = [];
  const searchTerm = search ? `%${search}%` : null;
  const cutoff = timeRangeCutoff(timeRange);

  if (searchTerm) {
    where.push("(COALESCE(title, '') LIKE ? OR COALESCE(slug, '') LIKE ? OR COALESCE(directory, '') LIKE ?)");
    params.push(searchTerm, searchTerm, searchTerm);
  }

  if (cutoff != null) {
    where.push("session.time_updated >= ?");
    params.push(cutoff);
  }

  if (project) {
    where.push("COALESCE(project_id, '') = ?");
    params.push(project);
  }

  return { whereClause: `WHERE ${where.join(" AND ")}`, params };
}

export function listSessions(limit = 50, offset = 0, search = "", timeRange = "", pathOverride = undefined, project = "") {
  const db = getDb(pathOverride);
  const { whereClause, params } = sessionFilter(search, timeRange, project);

  const sessions = db.prepare(`
    SELECT id, project_id, slug, title, directory, time_created, time_updated,
           summary_additions, summary_deletions, summary_files, time_archived
    FROM session
    ${whereClause}
    ORDER BY time_updated DESC, time_created DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const totalRow = db.prepare(`
    SELECT COUNT(*) AS total
    FROM session
    ${whereClause}
  `).get(...params);

  return { sessions, total: totalRow?.total ?? 0 };
}

export function listSessionProjects(search = "", timeRange = "", pathOverride = undefined) {
  const db = getDb(pathOverride);
  const { whereClause, params } = sessionFilter(search, timeRange, "");
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

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    worktree: row.worktree || row.label,
    count: Number(row.count) || 0
  }));
}

export function getSession(id, pathOverride = undefined) {
  return getSessionSafe(id, pathOverride);
}

export function getSessionSafe(id, pathOverride = undefined) {
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

export function getChildSessions(parentId, pathOverride = undefined) {
  return getChildSessionsSafe(parentId, pathOverride);
}

export function getChildSessionsSafe(parentId, pathOverride = undefined) {
  const db = getDb(pathOverride);
  const rows = db.prepare(`
    SELECT *
    FROM session
    WHERE parent_id = ?
      AND time_archived IS NULL
    ORDER BY time_created ASC, id ASC
  `).all(parentId);
  return rows.map(row => ({
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

export function getMessages(sessionId, pathOverride = undefined) {
  const db = getDb(pathOverride);
  const rows = db.prepare(`
    SELECT id, session_id, data
    FROM message
    WHERE session_id = ?
    ORDER BY COALESCE(CAST(json_extract(data, '$.time.created') AS INTEGER), 0), id
  `).all(sessionId);

  return rows.map(mapDataRow);
}

export function getParts(messageId, pathOverride = undefined) {
  const db = getDb(pathOverride);
  const rows = db.prepare(`
    SELECT id, message_id, session_id, data
    FROM part
    WHERE message_id = ?
    ORDER BY rowid ASC, id ASC
  `).all(messageId);

  return rows.map(mapDataRow);
}

export function getTodos(sessionId, pathOverride = undefined) {
  const db = getDb(pathOverride);
  return db.prepare(`
    SELECT session_id, content, status, priority, position, time_created
    FROM todo
    WHERE session_id = ?
    ORDER BY position ASC, time_created ASC
  `).all(sessionId);
}

export function searchMessages(query, limit = 20, pathOverride = undefined) {
  const db = getDb(pathOverride);
  const term = query?.trim();

  if (!term) {
    return [];
  }

  const searchTerm = `%${term}%`;
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
    ORDER BY session.time_updated DESC,
             COALESCE(CAST(json_extract(message.data, '$.time.created') AS INTEGER), 0) DESC,
             part.id DESC
    LIMIT ?
  `).all(searchTerm, limit);

  return rows.map((row) => {
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

export function getStats(pathOverride = undefined) {
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
  `).all().map((row) => ({
    model: row.model,
    count: row.count
  }));

  return {
    totalSessions,
    totalMessages,
    modelDistribution
  };
}

export function getTokenStats(days = 30, pathOverride = undefined) {
  const d = getDb(pathOverride);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const cutoff = today.getTime() - (Math.max(1, days) - 1) * 86400000;
  // Token consumption happens inside child/subagent sessions as well as roots.
  // Filtering to parent_id IS NULL makes the dashboard materially under-report
  // provider usage, so this query intentionally includes the full active tree.
  return d.prepare(`
    SELECT date(json_extract(message.data, '$.time.created') / 1000, 'unixepoch') as day,
           SUM(
             CASE
               WHEN COALESCE(json_extract(message.data, '$.tokens.input'), 0)
                  + COALESCE(json_extract(message.data, '$.tokens.output'), 0)
                  + COALESCE(json_extract(message.data, '$.tokens.reasoning'), 0)
                  + COALESCE(json_extract(message.data, '$.tokens.cache.read'), 0)
                  + COALESCE(json_extract(message.data, '$.tokens.cache.write'), 0) > 0
               THEN COALESCE(json_extract(message.data, '$.tokens.input'), 0)
                  + COALESCE(json_extract(message.data, '$.tokens.output'), 0)
                  + COALESCE(json_extract(message.data, '$.tokens.reasoning'), 0)
                  + COALESCE(json_extract(message.data, '$.tokens.cache.read'), 0)
                  + COALESCE(json_extract(message.data, '$.tokens.cache.write'), 0)
               ELSE COALESCE(json_extract(message.data, '$.tokens.total'), 0)
             END
           ) as total_tokens,
           SUM(COALESCE(json_extract(message.data, '$.tokens.input'), 0)) as input_tokens,
           SUM(COALESCE(json_extract(message.data, '$.tokens.output'), 0)) as output_tokens,
           SUM(COALESCE(json_extract(message.data, '$.tokens.reasoning'), 0)) as reasoning_tokens,
           SUM(COALESCE(json_extract(message.data, '$.tokens.cache.read'), 0)) as cache_read_tokens,
           SUM(COALESCE(json_extract(message.data, '$.tokens.cache.write'), 0)) as cache_write_tokens,
           COUNT(*) as message_count
    FROM message
    JOIN session ON session.id = message.session_id
    WHERE json_extract(message.data, '$.role') = 'assistant'
      AND json_extract(message.data, '$.time.created') > ?
      AND json_extract(message.data, '$.tokens.total') > 0
      AND session.time_archived IS NULL
    GROUP BY day ORDER BY day ASC
  `).all(cutoff);
}

export function getModelDistribution(pathOverride = undefined) {
  const d = getDb(pathOverride);
  return d.prepare(`
    SELECT json_extract(message.data, '$.modelID') as model,
           json_extract(message.data, '$.providerID') as provider,
           COUNT(*) as count,
           SUM(json_extract(message.data, '$.tokens.total')) as total_tokens
    FROM message
    JOIN session ON session.id = message.session_id
    WHERE json_extract(message.data, '$.role') = 'assistant'
      AND json_extract(message.data, '$.modelID') IS NOT NULL
      AND session.time_archived IS NULL
    GROUP BY model, provider
    ORDER BY count DESC
  `).all();
}

export function getDailySessionCounts(days = 30, pathOverride = undefined) {
  const d = getDb(pathOverride);
  const cutoff = Date.now() - days * 86400000;
  return d.prepare(`
    SELECT date(time_created / 1000, 'unixepoch') as day,
           COUNT(*) as count
    FROM session
     WHERE time_created > ?
     GROUP BY day ORDER BY day ASC
  `).all(cutoff);
}

export function getSessionsByIds(ids, pathOverride = undefined) {
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
