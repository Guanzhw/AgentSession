// src/index-db.js
import { DatabaseSync } from "node:sqlite";
import { getConfig } from "./config.js";

let indexDb;

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
  }
  return indexDb;
}

/**
 * Upsert a batch of RawSession objects into session_index.
 * @param {string} provider
 * @param {import('./providers/interface.js').RawSession[]} sessions
 */
export function upsertIndex(provider, sessions) {
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
function indexedFilter(timeRange = "", search = "", project = "") {
  const where = ["provider = ?"];
  const params = [];
  const db = getIndexDb();
  const now = Date.now();

  if (search) {
    where.push("(COALESCE(title, '') LIKE ? OR COALESCE(directory, '') LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
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
    where.push("COALESCE(directory, '') = ?");
    params.push(project);
  }

  return { db, whereClause: `WHERE ${where.join(" AND ")}`, params };
}

export function getIndexedSessions(provider, limit = 50, offset = 0, timeRange = "", search = "", project = "") {
  const { db, whereClause, params } = indexedFilter(timeRange, search, project);
  const total = db.prepare(`SELECT COUNT(*) as c FROM session_index ${whereClause}`).get(provider, ...params).c;
  const sessions = db.prepare(`
    SELECT * FROM session_index ${whereClause}
    ORDER BY time_updated DESC LIMIT ? OFFSET ?
  `).all(provider, ...params, limit, offset);

  return { sessions, total };
}

export function getIndexedSessionProjects(provider, timeRange = "", search = "") {
  const { db, whereClause, params } = indexedFilter(timeRange, search, "");
  return db.prepare(`
    SELECT COALESCE(directory, '') AS id,
           COALESCE(NULLIF(directory, ''), 'Unknown project') AS label,
           COUNT(*) AS count
    FROM session_index
    ${whereClause}
    GROUP BY COALESCE(directory, '')
    ORDER BY count DESC, label COLLATE NOCASE ASC
  `).all(provider, ...params).map((row) => ({
    id: row.id,
    label: row.label,
    worktree: row.label,
    count: Number(row.count) || 0
  }));
}

/**
 * Run a full index for a provider using its scan() method.
 * @param {import('./providers/interface.js').ProviderAdapter} adapter
 */
export async function indexProvider(adapter) {
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
export function getLastIndexedTime(provider) {
  const db = getIndexDb();
  const row = db.prepare("SELECT MAX(last_indexed) as t FROM session_index WHERE provider = ?").get(provider);
  return row?.t || 0;
}

/**
 * Clear indexed sessions for a provider (or all providers).
 * @param {string} [provider]
 */
export function clearIndex(provider) {
  const db = getIndexDb();
  if (provider) {
    db.prepare("DELETE FROM session_index WHERE provider = ?").run(provider);
  } else {
    db.exec("DELETE FROM session_index");
  }
}
