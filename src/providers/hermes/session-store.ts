import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { DailyTokenStat, Message, RawSession } from "../interface.js";
import { extractHermesMeta, hermesRowsToMessages, hermesSessionUsage, type HermesRow } from "./parser.js";

export interface HermesSessionEntry {
  session: RawSession;
  messages: Message[];
  rawSession: HermesRow;
  rawMessages: HermesRow[];
}

function fileSignature(filePath: string) {
  // Hermes uses WAL mode. The main database mtime can remain unchanged while
  // committed sessions accumulate in the WAL, so all three files participate
  // in snapshot invalidation.
  return [filePath, `${filePath}-wal`, `${filePath}-shm`]
    .map(candidate => {
      try {
        if (!existsSync(candidate)) return `${candidate}:missing`;
        const stat = statSync(candidate);
        return `${candidate}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return `${candidate}:changing`;
      }
    })
    .join("|");
}

function columns(db: DatabaseSync, table: string) {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)
  );
}

export function createHermesSessionStore(getDbPath: () => string, refreshIntervalMs = 1000) {
  let cache: {
    signature: string;
    refreshedAt: number;
    entries: HermesSessionEntry[];
    byId: Map<string, HermesSessionEntry>;
    revision: number;
  } | null = null;

  const refresh = (force = false) => {
    const dbPath = getDbPath();
    if (!existsSync(dbPath)) {
      if (cache?.entries.length) {
        cache = { signature: "", refreshedAt: Date.now(), entries: [], byId: new Map(), revision: cache.revision + 1 };
      }
      return;
    }
    const now = Date.now();
    if (!force && cache && now - cache.refreshedAt < refreshIntervalMs) return;
    const signature = fileSignature(dbPath);
    if (cache?.signature === signature) {
      cache.refreshedAt = now;
      return;
    }

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const sessionColumns = columns(db, "sessions");
      const messageColumns = columns(db, "messages");
      if (!sessionColumns.has("id") || !messageColumns.has("session_id")) {
        throw new Error("Hermes state database is missing required session tables");
      }
      const sessionWhere = sessionColumns.has("archived") ? "WHERE COALESCE(archived, 0) = 0" : "";
      const messageWhere = messageColumns.has("active") ? "WHERE COALESCE(active, 1) = 1" : "";
      const sessions = db.prepare(`SELECT * FROM sessions ${sessionWhere} ORDER BY started_at`).all() as HermesRow[];
      const messages = db.prepare(`SELECT * FROM messages ${messageWhere} ORDER BY session_id, id`).all() as HermesRow[];
      const messagesBySession = new Map<string, HermesRow[]>();
      for (const message of messages) {
        const sessionId = String(message.session_id);
        const rows = messagesBySession.get(sessionId) || [];
        rows.push(message);
        messagesBySession.set(sessionId, rows);
      }
      const entries = sessions.map(rawSession => {
        const rawMessages = messagesBySession.get(String(rawSession.id)) || [];
        const normalizedMessages = hermesRowsToMessages(rawSession, rawMessages);
        return {
          session: extractHermesMeta(rawSession, normalizedMessages),
          messages: normalizedMessages,
          rawSession,
          rawMessages
        };
      });
      const byId = new Map(entries.map(entry => [entry.session.id, entry]));
      // Authoritative Hermes classification: a raw parent_session_id is a
      // compression edge only when (a) it differs from _delegate_from — the
      // parser keeps that string candidate — and (b) the referenced parent
      // row exists and ends with end_reason 'compression'. The full entry
      // map is available here, so validate once when the snapshot is built:
      // missing and non-compression parents are normalized to null before the
      // cache is published, so scan(), getSession(), getFamily(), and the
      // structured views all consume only validated lineage. Invalidated
      // sessions stay standalone and canonical; their messages are never
      // silently dropped. Valid chains and cycles (e.g. a self-reference)
      // keep their edges; traversal guards in getFamily and the view builder
      // handle malformed lineage without manufacturing a wrong base.
      for (const entry of entries) {
        const metadata = entry.session.metadata;
        if (!metadata?.compressionParentId) continue;
        const parent = byId.get(String(metadata.compressionParentId));
        if (!parent || parent.rawSession.end_reason !== "compression") {
          metadata.compressionParentId = null;
        }
      }
      cache = {
        signature,
        refreshedAt: now,
        entries,
        byId,
        revision: (cache?.revision || 0) + 1
      };
    } catch (error) {
      if (!cache) throw error;
      cache.refreshedAt = now;
      console.warn("Keeping the last readable Hermes session snapshot:", dbPath, error);
    } finally {
      db.close();
    }
  };

  return {
    refresh,
    list() {
      refresh();
      return cache?.entries || [];
    },
    get(sessionId: string) {
      refresh();
      return cache?.byId.get(sessionId) || null;
    },
    getFamily(sessionId: string) {
      refresh();
      const entries = cache?.entries || [];
      const byId = new Map(entries.map(entry => [entry.session.id, entry]));
      // Structured views need the whole logical lineage: real delegates
      // spawned from a session (parentId, the canonical _delegate_from) and
      // compression continuations (metadata.compressionParentId) both belong
      // to it, including chains of consecutive compression segments.
      const delegateChildren = new Map<string, HermesSessionEntry[]>();
      const compressionChildren = new Map<string, HermesSessionEntry[]>();
      for (const entry of entries) {
        if (entry.session.parentId) {
          const children = delegateChildren.get(entry.session.parentId) || [];
          children.push(entry);
          delegateChildren.set(entry.session.parentId, children);
        }
        const compressionParentId = entry.session.metadata?.compressionParentId;
        if (compressionParentId) {
          const key = String(compressionParentId);
          const children = compressionChildren.get(key) || [];
          children.push(entry);
          compressionChildren.set(key, children);
        }
      }
      // A compression segment is a continuation of its logical base session,
      // so asking for the segment must produce the base's lineage view.
      // Resolve backward through compression parents first; a malformed chain
      // (missing parent or a cycle) keeps the requested segment as the
      // traversal root so its messages stay reachable.
      let root = byId.get(sessionId);
      if (root?.session.metadata?.compressionParentId) {
        const seen = new Set<string>([root.session.id]);
        let current = String(root.session.metadata.compressionParentId);
        while (current) {
          const parent = byId.get(current);
          if (!parent || seen.has(current)) break;
          root = parent;
          seen.add(current);
          if (!parent.session.metadata?.compressionParentId) break;
          current = String(parent.session.metadata.compressionParentId);
        }
      }
      if (!root) return [];
      const family: HermesSessionEntry[] = [];
      const seen = new Set<string>();
      const visit = (entry: HermesSessionEntry) => {
        if (seen.has(entry.session.id)) return;
        seen.add(entry.session.id);
        family.push(entry);
        for (const child of [
          ...(delegateChildren.get(entry.session.id) || []),
          ...(compressionChildren.get(entry.session.id) || [])
        ]) {
          visit(child);
        }
      };
      visit(root);
      return family;
    },
    getRevision() {
      refresh();
      return cache?.revision || 0;
    },
    getSignature() {
      refresh();
      return cache?.signature || "";
    }
  };
}

export function hermesDailyTokenStats(entries: HermesSessionEntry[], days = 30): DailyTokenStat[] {
  const cutoff = Date.now() - Math.max(1, days) * 86400000;
  const buckets = new Map<string, DailyTokenStat>();
  for (const entry of entries) {
    const timestamp = entry.session.timeUpdated || entry.session.timeCreated;
    if (!timestamp || timestamp < cutoff) continue;
    const day = new Date(timestamp).toISOString().slice(0, 10);
    const bucket = buckets.get(day) || {
      day, inputTokens: 0, outputTokens: 0, totalTokens: 0, messageCount: 0,
      reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0
    };
    const usage = hermesSessionUsage(entry.rawSession);
    bucket.inputTokens += usage.input || 0;
    bucket.outputTokens += usage.output || 0;
    bucket.totalTokens += usage.total || 0;
    bucket.reasoningTokens! += usage.reasoning || 0;
    bucket.cacheReadTokens! += usage.cache?.read || 0;
    bucket.cacheWriteTokens! += usage.cache?.write || 0;
    // File-provider token stats count usage-bearing assistant responses rather
    // than normalized tool/result records; Hermes only has session aggregates,
    // so assistant turns are the closest equivalent.
    bucket.messageCount += entry.messages.filter(message => message.role === "assistant").length;
    buckets.set(day, bucket);
  }
  return [...buckets.values()].sort((left, right) => left.day.localeCompare(right.day));
}
