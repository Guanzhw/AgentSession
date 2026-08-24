import { DatabaseSync } from "node:sqlite";
import { getConfig } from "./config.js";

function getMetaDbPath() { return getConfig().metaPath; }

let metaDb: any;

export function closeMetaDb() {
  if (!metaDb) return;
  metaDb.close();
  metaDb = undefined;
}

export function getMetaDb() {
  if (!metaDb) {
    metaDb = new DatabaseSync(getMetaDbPath());
    // Migration: add provider column if not present
    const tableInfo = metaDb.prepare("PRAGMA table_info(session_meta)").all();
    const hasProvider = tableInfo.some((col: any) => col.name === "provider");

    if (!hasProvider && tableInfo.length > 0) {
      metaDb.exec("BEGIN TRANSACTION");
      try {
        metaDb.exec(`
          CREATE TABLE session_meta_v2 (
            provider TEXT NOT NULL DEFAULT 'opencode',
            session_id TEXT NOT NULL,
            custom_title TEXT,
            starred INTEGER DEFAULT 0,
            deleted INTEGER DEFAULT 0,
            permanent INTEGER DEFAULT 0,
            time_starred INTEGER,
            time_deleted INTEGER,
            time_renamed INTEGER,
            PRIMARY KEY (provider, session_id)
          )
        `);
        metaDb.exec(`
          INSERT INTO session_meta_v2 (provider, session_id, custom_title, starred, deleted, permanent, time_starred, time_deleted, time_renamed)
          SELECT 'opencode', session_id, custom_title, starred, deleted, permanent, time_starred, time_deleted, time_renamed
          FROM session_meta
        `);
        metaDb.exec("DROP TABLE session_meta");
        metaDb.exec("ALTER TABLE session_meta_v2 RENAME TO session_meta");
        metaDb.exec("COMMIT");
      } catch (err) {
        metaDb.exec("ROLLBACK");
        throw err;
      }
    } else if (tableInfo.length === 0) {
      // Fresh install
      metaDb.exec(`
        CREATE TABLE IF NOT EXISTS session_meta (
          provider TEXT NOT NULL DEFAULT 'opencode',
          session_id TEXT NOT NULL,
          custom_title TEXT,
          starred INTEGER DEFAULT 0,
          deleted INTEGER DEFAULT 0,
          permanent INTEGER DEFAULT 0,
          time_starred INTEGER,
          time_deleted INTEGER,
          time_renamed INTEGER,
          PRIMARY KEY (provider, session_id)
        )
      `);
    }
  }
  return metaDb;
}

/** 确保 session_id 在 session_meta 中有记录（upsert 辅助） */
function ensureMeta(provider: string, sid: string) {
  const db = getMetaDb();
  const existing = db.prepare("SELECT 1 FROM session_meta WHERE provider = ? AND session_id = ?").get(provider, sid);
  if (!existing) {
    db.prepare("INSERT INTO session_meta (provider, session_id) VALUES (?, ?)").run(provider, sid);
  }
}

export function getMeta(provider: string, sid: string) {
  const db = getMetaDb();
  return db.prepare("SELECT * FROM session_meta WHERE provider = ? AND session_id = ?").get(provider, sid) || null;
}

export function getAllMeta(provider: string) {
  const db = getMetaDb();
  const rows = db.prepare("SELECT * FROM session_meta WHERE provider = ?").all(provider);
  const map = new Map();
  for (const row of rows) map.set(row.session_id, row);
  return map;
}

/** 返回所有 deleted=1 且 permanent=0 的 session_id 列表 */
export function getDeletedIds(provider: string) {
  const db = getMetaDb();
  return db.prepare("SELECT session_id FROM session_meta WHERE provider = ? AND deleted = 1 AND permanent = 0").all(provider)
    .map((r: any) => r.session_id);
}

/** 返回所有 deleted=1 或 permanent=1 的 session_id 集合（用于列表排除） */
export function getExcludedIds(provider: string): Set<string> {
  const db = getMetaDb();
  return new Set(
    db.prepare("SELECT session_id FROM session_meta WHERE provider = ? AND (deleted = 1 OR permanent = 1)").all(provider)
      .map((r: any) => r.session_id)
  );
}

export function toggleStar(provider: string, sid: string) {
  const db = getMetaDb();
  ensureMeta(provider, sid);
  const row = db.prepare("SELECT starred FROM session_meta WHERE provider = ? AND session_id = ?").get(provider, sid);
  const newStarred = row.starred ? 0 : 1;
  db.prepare("UPDATE session_meta SET starred = ?, time_starred = ? WHERE provider = ? AND session_id = ?")
    .run(newStarred, newStarred ? Date.now() : null, provider, sid);
  return newStarred === 1;
}

export function renameSession(provider: string, sid: string, title: string) {
  const db = getMetaDb();
  ensureMeta(provider, sid);
  db.prepare("UPDATE session_meta SET custom_title = ?, time_renamed = ? WHERE provider = ? AND session_id = ?")
    .run(title || null, Date.now(), provider, sid);
}

export function softDelete(provider: string, sid: string) {
  const db = getMetaDb();
  ensureMeta(provider, sid);
  db.prepare("UPDATE session_meta SET deleted = 1, time_deleted = ? WHERE provider = ? AND session_id = ?")
    .run(Date.now(), provider, sid);
}

export function restoreSession(provider: string, sid: string) {
  const db = getMetaDb();
  db.prepare("UPDATE session_meta SET deleted = 0, time_deleted = NULL WHERE provider = ? AND session_id = ?")
    .run(provider, sid);
}

export function permanentDelete(provider: string, sid: string) {
  const db = getMetaDb();
  ensureMeta(provider, sid);
  db.prepare("UPDATE session_meta SET deleted = 1, permanent = 1 WHERE provider = ? AND session_id = ?")
    .run(provider, sid);
}

export function batchAction(provider: string, ids: string[], action: string) {
  for (const id of ids) {
    if (action === "delete") softDelete(provider, id);
    else if (action === "restore") restoreSession(provider, id);
    else if (action === "permanent-delete") permanentDelete(provider, id);
    else if (action === "star") {
      const m = getMeta(provider, id);
      if (!m || !m.starred) toggleStar(provider, id);
    }
    else if (action === "unstar") {
      const m = getMeta(provider, id);
      if (m && m.starred) toggleStar(provider, id);
    }
  }
  return ids.length;
}
