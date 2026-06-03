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
  nextDb.exec("PRAGMA journal_mode = WAL;");
  nextDb.exec("PRAGMA busy_timeout = 5000;");
  dbInstances.set(nextPath, nextDb);
  dbInstance = nextDb;
  dbPath = nextPath;
  return nextDb;
}

export function listSessions(limit = 50, offset = 0, search = "", timeRange = "", pathOverride = undefined) {
  const db = getDb(pathOverride);
  const searchTerm = search ? `%${search}%` : null;

  // Time range filter
  let timeFilter = "";
  const now = Date.now();
  if (timeRange === "today") {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    timeFilter = ` AND session.time_updated >= ${startOfDay.getTime()}`;
  } else if (timeRange === "week") {
    timeFilter = ` AND session.time_updated >= ${now - 7 * 86400000}`;
  } else if (timeRange === "month") {
    timeFilter = ` AND session.time_updated >= ${now - 30 * 86400000}`;
  }

  const whereClause = searchTerm
    ? `WHERE time_archived IS NULL AND parent_id IS NULL AND (COALESCE(title, '') LIKE ? OR COALESCE(slug, '') LIKE ? OR COALESCE(directory, '') LIKE ?)${timeFilter}`
    : `WHERE time_archived IS NULL AND parent_id IS NULL${timeFilter}`;
  const searchParams = searchTerm ? [searchTerm, searchTerm, searchTerm] : [];

  const sessions = db.prepare(`
    SELECT id, project_id, slug, title, directory, time_created, time_updated,
           summary_additions, summary_deletions, summary_files, time_archived
    FROM session
    ${whereClause}
    ORDER BY time_updated DESC, time_created DESC
    LIMIT ? OFFSET ?
  `).all(...searchParams, limit, offset);

  const totalRow = db.prepare(`
    SELECT COUNT(*) AS total
    FROM session
    ${whereClause}
  `).get(...searchParams);

  return { sessions, total: totalRow?.total ?? 0 };
}

export function getSession(id, pathOverride = undefined) {
  const db = getDb(pathOverride);
  return db.prepare(`
    SELECT id, project_id, parent_id, slug, title, directory, time_created, time_updated,
           summary_additions, summary_deletions, summary_files, time_archived,
           agent, model, cost, tokens_input, tokens_output, tokens_reasoning,
           tokens_cache_read, tokens_cache_write
    FROM session
    WHERE id = ?
  `).get(id) ?? null;
}

export function getChildSessions(parentId, pathOverride = undefined) {
  const db = getDb(pathOverride);
  return db.prepare(`
    SELECT id, project_id, parent_id, slug, title, directory, time_created, time_updated,
           summary_additions, summary_deletions, summary_files, time_archived,
           agent, model, cost, tokens_input, tokens_output, tokens_reasoning,
           tokens_cache_read, tokens_cache_write
    FROM session
    WHERE parent_id = ?
      AND time_archived IS NULL
    ORDER BY time_created ASC, id ASC
  `).all(parentId);
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
  const cutoff = Date.now() - days * 86400000;
  return d.prepare(`
    SELECT date(json_extract(message.data, '$.time.created') / 1000, 'unixepoch') as day,
           SUM(json_extract(message.data, '$.tokens.total')) as total_tokens,
           SUM(json_extract(message.data, '$.tokens.input')) as input_tokens,
           SUM(json_extract(message.data, '$.tokens.output')) as output_tokens,
           COUNT(*) as message_count
    FROM message
    JOIN session ON session.id = message.session_id
    WHERE json_extract(message.data, '$.role') = 'assistant'
      AND json_extract(message.data, '$.time.created') > ?
      AND json_extract(message.data, '$.tokens.total') > 0
      AND session.time_archived IS NULL
      AND session.parent_id IS NULL
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
      AND session.parent_id IS NULL
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
