import { getDb } from "./db.js";
import { getIndexDb } from "./index-db.js";
import { isEmptyProjectFilter } from "./project-filter.js";

const STATS_INDEX_VERSION = 4;
const FULL_RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

function ensureSchema(db: any) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_stats_session_revision (
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      revision TEXT NOT NULL,
      PRIMARY KEY (provider, session_id)
    );
    CREATE TABLE IF NOT EXISTS token_stats_provider_state (
      provider TEXT PRIMARY KEY,
      source_path TEXT NOT NULL DEFAULT '',
      last_source_updated INTEGER NOT NULL,
      refreshed_day TEXT NOT NULL,
      session_count INTEGER NOT NULL,
      last_full_reconcile INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS token_stats_bucket (
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      day TEXT NOT NULL,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      model_key TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      PRIMARY KEY (provider, session_id, day, model_key)
    );
    CREATE INDEX IF NOT EXISTS idx_token_stats_bucket_query
      ON token_stats_bucket(provider, day, project_id, model_key);
  `);
  const stateColumns = new Set(
    (db.prepare("PRAGMA table_info(token_stats_provider_state)").all() as Array<{ name: string }>).map(row => row.name),
  );
  if (!stateColumns.has("source_path")) {
    db.exec("ALTER TABLE token_stats_provider_state ADD COLUMN source_path TEXT NOT NULL DEFAULT ''");
  }
}

function tokenComponentSql(dataColumn = "message.data") {
  return `COALESCE(json_extract(${dataColumn}, '$.tokens.input'), 0)
    + COALESCE(json_extract(${dataColumn}, '$.tokens.output'), 0)
    + COALESCE(json_extract(${dataColumn}, '$.tokens.reasoning'), 0)
    + COALESCE(json_extract(${dataColumn}, '$.tokens.cache.read'), 0)
    + COALESCE(json_extract(${dataColumn}, '$.tokens.cache.write'), 0)`;
}

function tokenTotalSql(dataColumn = "message.data") {
  return `CASE WHEN COALESCE(json_extract(${dataColumn}, '$.tokens.total'), 0) > 0
    THEN COALESCE(json_extract(${dataColumn}, '$.tokens.total'), 0)
    ELSE (${tokenComponentSql(dataColumn)}) END`;
}

export function refreshSqliteTokenStatsIndex(
  provider: string,
  sourcePath: string,
  cacheDb: any = getIndexDb(),
) {
  ensureSchema(cacheDb);
  const sourceDb = getDb(sourcePath);
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const sourceSummary = sourceDb.prepare(`
    SELECT
      SUM(CASE WHEN time_archived IS NULL THEN 1 ELSE 0 END) AS session_count,
      COALESCE(MAX(MAX(COALESCE(time_updated, 0), COALESCE(time_archived, 0))), 0) AS last_source_updated
    FROM session
  `).get() as { session_count: number; last_source_updated: number };
  const state = cacheDb.prepare(`
    SELECT source_path, last_source_updated, refreshed_day, session_count, last_full_reconcile
    FROM token_stats_provider_state WHERE provider = ?
  `).get(provider) as { source_path: string; last_source_updated: number; refreshed_day: string; session_count: number; last_full_reconcile: number } | undefined;
  const sourceCount = Number(sourceSummary.session_count) || 0;
  const sourceUpdated = Number(sourceSummary.last_source_updated) || 0;
  const sourcePathChanged = Boolean(state && state.source_path !== sourcePath);
  const hasStaleRevision = Boolean(cacheDb.prepare(`
    SELECT 1 FROM token_stats_session_revision
    WHERE provider = ? AND revision NOT LIKE ? LIMIT 1
  `).get(provider, `${STATS_INDEX_VERSION}:%`));
  const fullReconcile = !state
    || sourcePathChanged
    || hasStaleRevision
    || state.session_count !== sourceCount
    || now - state.last_full_reconcile >= FULL_RECONCILE_INTERVAL_MS;
  const sourceSessions = (fullReconcile
    ? sourceDb.prepare(`SELECT id, COALESCE(time_updated, 0) AS time_updated, time_archived FROM session WHERE time_archived IS NULL`).all()
    : sourceDb.prepare(`
        SELECT id, COALESCE(time_updated, 0) AS time_updated, time_archived
        FROM session
        WHERE MAX(COALESCE(time_updated, 0), COALESCE(time_archived, 0)) >= ?
      `).all(state.last_source_updated)) as Array<{ id: string; time_updated: number; time_archived: number | null }>;
  const candidateIds = sourceSessions.map((row: any) => String(row.id));
  const cachedRows = (fullReconcile
    ? cacheDb.prepare(`SELECT session_id, revision FROM token_stats_session_revision WHERE provider = ?`).all(provider)
    : candidateIds.length > 0
      ? cacheDb.prepare(`SELECT session_id, revision FROM token_stats_session_revision WHERE provider = ? AND session_id IN (SELECT value FROM json_each(?))`).all(provider, JSON.stringify(candidateIds))
      : []) as Array<{ session_id: string; revision: string }>;
  const cached = new Map<string, string>(cachedRows.map(row => [row.session_id, row.revision]));
  const activeSessions = sourceSessions.filter(row => row.time_archived === null || row.time_archived === undefined);
  const activeIds = new Set(activeSessions.map(row => String(row.id)));
  const changed = activeSessions.filter((row: any) =>
    sourcePathChanged || cached.get(String(row.id)) !== `${STATS_INDEX_VERSION}:${Number(row.time_updated) || 0}`
  );
  const removed = cachedRows.filter(row => !activeIds.has(row.session_id)).map(row => row.session_id);
  const mutableFromDay = state?.refreshed_day || today;
  const fullHistoryChanged = changed.filter((row: any) => {
    const revision = cached.get(String(row.id));
    return sourcePathChanged || !revision || !revision.startsWith(`${STATS_INDEX_VERSION}:`);
  });
  const mutableChanged = changed.filter((row: any) => !fullHistoryChanged.includes(row));

  const deleteBuckets = cacheDb.prepare("DELETE FROM token_stats_bucket WHERE provider = ? AND session_id = ?");
  const deleteMutableBuckets = cacheDb.prepare("DELETE FROM token_stats_bucket WHERE provider = ? AND session_id = ? AND day >= ?");
  const deleteRevision = cacheDb.prepare("DELETE FROM token_stats_session_revision WHERE provider = ? AND session_id = ?");
  const insertBucket = cacheDb.prepare(`
    INSERT INTO token_stats_bucket (
      provider, session_id, day, project_id, parent_id, model_key, model_id, model_provider,
      input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
      total_tokens, message_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertRevision = cacheDb.prepare(`
    INSERT OR REPLACE INTO token_stats_session_revision (provider, session_id, revision) VALUES (?, ?, ?)
  `);
  const aggregateSql = (mutableOnly: boolean) => `
    SELECT
      session.id AS session_id,
      date(json_extract(message.data, '$.time.created') / 1000, 'unixepoch') AS day,
      COALESCE(session.project_id, '') AS project_id,
      session.parent_id AS parent_id,
      COALESCE(json_extract(message.data, '$.modelID'), 'unknown') AS model_id,
      COALESCE(json_extract(message.data, '$.providerID'), 'unknown') AS model_provider,
      COALESCE(json_extract(message.data, '$.providerID'), 'unknown') || '/' || COALESCE(json_extract(message.data, '$.modelID'), 'unknown') AS model_key,
      SUM(COALESCE(json_extract(message.data, '$.tokens.input'), 0)) AS input_tokens,
      SUM(COALESCE(json_extract(message.data, '$.tokens.output'), 0)) AS output_tokens,
      SUM(COALESCE(json_extract(message.data, '$.tokens.reasoning'), 0)) AS reasoning_tokens,
      SUM(COALESCE(json_extract(message.data, '$.tokens.cache.read'), 0)) AS cache_read_tokens,
      SUM(COALESCE(json_extract(message.data, '$.tokens.cache.write'), 0)) AS cache_write_tokens,
      SUM(${tokenTotalSql()}) AS total_tokens,
      COUNT(*) AS message_count
    FROM message
    JOIN session ON session.id = message.session_id
    WHERE session.id IN (SELECT value FROM json_each(?))
      AND json_extract(message.data, '$.role') = 'assistant'
      AND ${tokenTotalSql()} > 0
      AND date(json_extract(message.data, '$.time.created') / 1000, 'unixepoch') IS NOT NULL
      ${mutableOnly ? "AND date(json_extract(message.data, '$.time.created') / 1000, 'unixepoch') >= ?" : ""}
    GROUP BY session.id, day, model_key
  `;
  const aggregateAll = sourceDb.prepare(aggregateSql(false));
  const aggregateMutable = sourceDb.prepare(aggregateSql(true));
  const upsertState = cacheDb.prepare(`
    INSERT OR REPLACE INTO token_stats_provider_state
      (provider, source_path, last_source_updated, refreshed_day, session_count, last_full_reconcile)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertAggregates = (sessions: any[], aggregate: any, mutableFrom?: string) => {
    for (let offset = 0; offset < sessions.length; offset += 250) {
      const batch = sessions.slice(offset, offset + 250);
      const ids = batch.map(session => String(session.id));
      const rows = mutableFrom
        ? aggregate.all(JSON.stringify(ids), mutableFrom)
        : aggregate.all(JSON.stringify(ids));
      for (const row of rows as any[]) {
        insertBucket.run(
          provider, row.session_id, row.day, row.project_id, row.parent_id, row.model_key,
          row.model_id, row.model_provider, Number(row.input_tokens) || 0, Number(row.output_tokens) || 0,
          Number(row.reasoning_tokens) || 0, Number(row.cache_read_tokens) || 0,
          Number(row.cache_write_tokens) || 0, Number(row.total_tokens) || 0, Number(row.message_count) || 0,
        );
      }
      for (const session of batch) {
        upsertRevision.run(provider, session.id, `${STATS_INDEX_VERSION}:${Number(session.time_updated) || 0}`);
      }
    }
  };

  cacheDb.exec("BEGIN");
  try {
    for (const sessionId of [...removed, ...fullHistoryChanged.map((row: any) => String(row.id))]) {
      deleteBuckets.run(provider, sessionId);
      deleteRevision.run(provider, sessionId);
    }
    for (const session of mutableChanged as any[]) {
      deleteMutableBuckets.run(provider, String(session.id), mutableFromDay);
      deleteRevision.run(provider, String(session.id));
    }
    insertAggregates(fullHistoryChanged, aggregateAll);
    insertAggregates(mutableChanged, aggregateMutable, mutableFromDay);
    upsertState.run(provider, sourcePath, sourceUpdated, today, sourceCount, fullReconcile ? now : state.last_full_reconcile);
    cacheDb.exec("COMMIT");
  } catch (error) {
    cacheDb.exec("ROLLBACK");
    throw error;
  }

  return { changed: changed.length, removed: removed.length, total: sourceCount };
}

function dateBounds(options: { days?: number; fromDate?: string; toDate?: string }) {
  if (options.fromDate && options.toDate) return { from: options.fromDate, to: options.toDate };
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const days = Math.max(1, Number(options.days) || 30);
  return {
    from: new Date(today.getTime() - (days - 1) * 86400000).toISOString().slice(0, 10),
    to: today.toISOString().slice(0, 10),
  };
}

function indexedWhere(provider: string, options: any) {
  const bounds = dateBounds(options);
  const where = ["provider = ?", "day >= ?", "day <= ?"];
  const params: any[] = [provider, bounds.from, bounds.to];
  if (isEmptyProjectFilter(options.project)) where.push("project_id = ''");
  else if (options.project) { where.push("project_id = ?"); params.push(options.project); }
  if (options.modelPair) { where.push("model_key = ?"); params.push(options.modelPair); }
  if (options.scope === "root") where.push("parent_id IS NULL");
  return { where: where.join(" AND "), params };
}

export function getIndexedTokenStats(provider: string, options: any, cacheDb: any = getIndexDb()) {
  ensureSchema(cacheDb);
  const { where, params } = indexedWhere(provider, options);
  return cacheDb.prepare(`
    SELECT day, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
      SUM(reasoning_tokens) AS reasoning_tokens, SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(cache_write_tokens) AS cache_write_tokens, SUM(total_tokens) AS total_tokens,
      SUM(message_count) AS message_count
    FROM token_stats_bucket WHERE ${where} GROUP BY day ORDER BY day ASC
  `).all(...params);
}

export function getIndexedModelDistribution(provider: string, options: any, cacheDb: any = getIndexDb()) {
  ensureSchema(cacheDb);
  const { where, params } = indexedWhere(provider, options);
  return cacheDb.prepare(`
    SELECT model_id AS model, model_provider AS provider, SUM(message_count) AS count,
      SUM(total_tokens) AS total_tokens
    FROM token_stats_bucket WHERE ${where} AND model_key <> 'unknown/unknown'
    GROUP BY model_key ORDER BY total_tokens DESC
  `).all(...params);
}

export function getIndexedTokenSessionCount(provider: string, options: any, cacheDb: any = getIndexDb()) {
  ensureSchema(cacheDb);
  const { where, params } = indexedWhere(provider, options);
  return Number(cacheDb.prepare(`SELECT COUNT(DISTINCT session_id) AS count FROM token_stats_bucket WHERE ${where}`).get(...params)?.count) || 0;
}
