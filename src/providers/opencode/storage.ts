import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type OpenCodeStorage = { schema: "v1" | "v2" | "missing" | "unsupported" | "unreadable"; path: string; note: string | null };

/** Inspect the file, never the installed CLI version. v2 wins during migrations. */
export function inspectOpenCodeStorage(path: string): OpenCodeStorage {
  if (!existsSync(path)) return { schema: "missing", path, note: `OpenCode database not found: ${path}` };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    const required: Record<string, string[]> = tables.has("session_v2") ? {
      session_v2: ["id", "parent_id", "fork_session_id", "fork_boundary", "title", "directory", "time_created", "time_updated", "time_archived", "tokens_input", "tokens_output", "tokens_reasoning", "tokens_cache_read", "tokens_cache_write"],
      session_message: ["id", "session_id", "type", "seq", "time_created", "time_updated", "data"]
    } : {
      session: ["id", "parent_id", "title", "directory", "time_created", "time_updated", "time_archived"],
      message: ["id", "session_id", "data", "time_created"],
      part: ["id", "message_id", "session_id", "data", "time_created"]
    };
    for (const [table, fields] of Object.entries(required)) {
      const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      const missing = fields.filter(field => !columns.has(field));
      if (missing.length) return { schema: "unsupported", path, note: `Unsupported OpenCode schema: ${table} missing ${missing.join(", ")}` };
    }
    return { schema: tables.has("session_v2") ? "v2" : "v1", path, note: null };
  } catch (error) {
    return { schema: "unreadable", path, note: `Cannot read OpenCode database: ${(error as Error).message}` };
  } finally { db?.close(); }
}

/** WAL changes must invalidate protocol/stat caches before a checkpoint. */
export function openCodeStorageRevision(path: string): string {
  return [path, `${path}-wal`].map(file => {
    try { const s = statSync(file); return `${file}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
    catch { return `${file}:missing`; }
  }).join("|");
}
