import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DailyTokenStat, Message, RawSession } from "../interface.js";
import {
  activeOpenClawRecords,
  openClawAssistantUsageRecords,
  openClawRecordTimestamp,
  openClawRecordsToMessages,
  openClawUsageToTokens,
  type OpenClawRecord
} from "./parser.js";

/**
 * OpenClaw current-format per-agent SQLite reader (read-only).
 *
 * Canonical storage (official agent schema 19, verified 2026-09-03 at HEAD
 * f92a12c5813fb880ed6a05c4a728fd5f4ccc5473, release v2026.8.2, newest main
 * 2d9796d66c4358d7175761b581077fbd8fe16116 — identical schema SQL, sha256
 * 54fa65dc23576fcb20bc77f714d10598a7240ad28b7edd4fe4c39995dc96f61e):
 *
 *   ~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite
 *
 * - session_nodes.session_key is the canonical logical session record
 *   (e.g. `agent:main:main`); current_session_id points at the live window.
 * - session_windows rows are transcript generations (previous_session_id +
 *   reason: initial/reset/rollover/fork/rewind/switch/recovery/compaction).
 *   The live history read uses the current window only: "Reset boundaries
 *   start a fresh history window ... ordinary entry and session lists show
 *   only the live mapping."
 * - transcript_events holds the window's event rows. event_json has the
 *   exact record shape of the legacy JSONL lines (type/id/parentId/
 *   timestamp/message), so the existing OpenClaw record parser is reused
 *   unchanged. session_transcript_active_events is a DERIVED projection
 *   (needs_rebuild), so the active path is computed from raw events.
 *
 * The viewer exposes one session per session_nodes row, canonical id =
 * session_key. Window generations are recorded lineage metadata, not
 * separate sessions. Legacy JSONL files remain readable when they are not
 * covered by SQLite (legacy-only agents, pre-flip installs, unimported
 * archives); the adapter deduplicates covered windows at discovery.
 *
 * Read-only contract: every database opens with `readOnly: true`. Nothing
 * here writes, migrates, checkpoints, vacuums, or creates provider sidecars.
 */

interface OpenClawAgentDatabaseSnapshotOptions {
  /** Maximum transcript events parsed per current window (tail kept). */
  maxEventsPerSession?: number;
}

export type OpenClawSqliteStorageState =
  | { status: "current"; agentId: string; dbPath: string; schemaVersion: number | null; sessionCount: number; windowCount: number }
  | { status: "legacy-only"; agentId: string; dbPath: string | null; detail: string }
  | { status: "unsupported"; agentId: string; dbPath: string; schemaVersion: number | null; detail: string }
  | { status: "unreadable"; agentId: string; dbPath: string; detail: string };

export interface OpenClawSqliteSessionEntry {
  /** Canonical provider session id (session_nodes.session_key). */
  id: string;
  agentId: string;
  dbPath: string;
  session: RawSession;
  records: OpenClawRecord[];
  messages: Message[];
  /** Current transcript window id (session_windows.session_id). */
  currentSessionId: string;
  truncated: boolean;
}

/**
 * Columns the reader actually consumes, per table. Reads are projected onto
 * `discovered schema columns ∩ consumed columns`, so additive columns on the
 * same schema version and the 14..18 generation ladder never break the read
 * and nothing outside the consumed shape is fetched.
 */
const NODE_COLUMNS = [
  "session_key", "current_session_id", "entry_json", "entry_valid", "updated_at",
  "status", "created_at", "created_via", "project_id", "parent_session_key",
  "spawned_by", "fork_source_session_key", "fork_source_session_id",
  "fork_source_entry_id", "label", "display_name", "pinned_at", "archived_at",
  "last_read_at", "last_interaction_at", "last_activity_at"
] as const;

const WINDOW_COLUMNS = [
  "session_id", "session_key", "previous_session_id", "reason", "created_at",
  "updated_at", "transcript_updated_at", "status", "chat_type", "channel",
  "account_id", "model_provider", "model", "session_scope"
] as const;

function projectColumns(discovered: Set<string>, consumed: readonly string[]): Set<string> {
  return new Set(consumed.filter(column => discovered.has(column)));
}

function databaseFileSignature(dbPath: string) {
  // The provider runs SQLite in WAL mode. The main database mtime can stay
  // unchanged while committed sessions accumulate in the -wal file, so all
  // three files participate in snapshot invalidation.
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
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

function tableColumns(db: DatabaseSync, table: string) {
  try {
    return new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)
    );
  } catch {
    return new Set<string>();
  }
}

/** Tables/columns the current-format reader depends on. */
const REQUIRED_TABLES = ["schema_meta", "session_nodes", "session_windows", "transcript_events"] as const;
const REQUIRED_COLUMNS: Record<string, string[]> = {
  session_nodes: ["session_key", "current_session_id", "entry_json", "entry_valid", "updated_at"],
  session_windows: ["session_id", "session_key", "previous_session_id", "reason", "created_at", "updated_at", "transcript_updated_at"],
  transcript_events: ["session_id", "seq", "event_json", "created_at"]
};

/** Verified upstream agent schema versions. Older/later shapes are diagnosed, not guessed. */
const SUPPORTED_SCHEMA_MIN = 14;
const SUPPORTED_SCHEMA_MAX = 19;

function readSchemaVersion(db: DatabaseSync, tables: Set<string>): number | null {
  if (tables.has("schema_meta")) {
    try {
      const row = db
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary' AND role = 'agent'")
        .get() as { schema_version?: number } | undefined;
      if (row && typeof row.schema_version === "number" && Number.isFinite(row.schema_version)) {
        return row.schema_version;
      }
    } catch {
      // fall through to PRAGMA user_version
    }
  }
  try {
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    return row && typeof row.user_version === "number" ? row.user_version : null;
  } catch {
    return null;
  }
}

function columnsMatch(db: DatabaseSync): string | null {
  for (const table of REQUIRED_TABLES) {
    const columns = tableColumns(db, table);
    if (columns.size === 0) return `missing table ${table}`;
    for (const column of REQUIRED_COLUMNS[table] || []) {
      if (!columns.has(column)) return `table ${table} is missing column ${column}`;
    }
  }
  return null;
}

interface AgentDbState {
  agentId: string;
  dbPath: string | null;
  schemaVersion: number | null;
  storage: OpenClawSqliteStorageState;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseEntryJson(entryJson: unknown): Record<string, unknown> | null {
  if (typeof entryJson !== "string" || !entryJson || entryJson === "{}") return null;
  // SessionEntry blobs can carry plugin state; only parse bounded shapes and
  // never fail a session because its metadata blob is unusual.
  if (entryJson.length > 512 * 1024) return null;
  try {
    const parsed = JSON.parse(entryJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function firstUserPreview(messages: Message[]): string | null {
  for (const message of messages) {
    if (message.role === "user" && message.content.trim()) {
      return message.content.slice(0, 120) || null;
    }
  }
  return null;
}

function readWindowHeaderCwd(records: OpenClawRecord[]): string | null {
  const header = records.find(record => record.type === "session");
  return stringValue(header?.cwd);
}

interface WindowRow {
  session_id: string;
  session_key: string;
  previous_session_id: string | null;
  reason: string | null;
  created_at: number | null;
  updated_at: number | null;
  transcript_updated_at: number | null;
  status: string | null;
  chat_type: string | null;
  channel: string | null;
  account_id: string | null;
  model_provider: string | null;
  model: string | null;
  session_scope: string | null;
}

interface NodeRow {
  session_key: string;
  current_session_id: string;
  entry_json: string;
  entry_valid: number;
  updated_at: number | null;
  status: string | null;
  created_at: number | null;
  created_via: string | null;
  project_id: string | null;
  parent_session_key: string | null;
  spawned_by: string | null;
  fork_source_session_key: string | null;
  fork_source_session_id: string | null;
  fork_source_entry_id: string | null;
  label: string | null;
  display_name: string | null;
  pinned_at: number | null;
  archived_at: number | null;
  last_read_at: number | null;
  last_interaction_at: number | null;
  last_activity_at: number | null;
}

function openReadOnly(dbPath: string): DatabaseSync {
  // Provider data is strictly read-only: no migration, no WAL recovery
  // writes, no side effects.
  return new DatabaseSync(dbPath, { readOnly: true });
}

/**
 * Read only the columns present on the row: the columns passed in are already
 * the intersection of consumed columns and the discovered schema, so
 * same-version additive columns and the 14..18 generation ladder never break
 * a reader that projects what the store actually has. Missing optional
 * columns stay undefined/null.
 */
function readSqliteRows(db: DatabaseSync, table: string, columns: Set<string>): unknown[] {
  const names = [...columns];
  if (!names.length) return [];
  const statement = db.prepare(`SELECT ${names.map(name => `"${name}"`).join(", ")} FROM "${table}"`);
  return statement.all() as unknown[];
}

function readAgentDatabase(
  agentId: string,
  dbPath: string,
  maxEventsPerSession: number
): { storage: OpenClawSqliteStorageState; nodes: NodeRow[]; windowsByKey: Map<string, WindowRow[]>; recordsByWindow: Map<string, OpenClawRecord[]>; truncatedWindows: Set<string> } {
  let db: DatabaseSync;
  try {
    db = openReadOnly(dbPath);
  } catch (error) {
    return {
      storage: {
        status: "unreadable",
        agentId,
        dbPath,
        detail: `Could not open read-only: ${error instanceof Error ? error.message : String(error)}`
      },
      nodes: [],
      windowsByKey: new Map(),
      recordsByWindow: new Map(),
      truncatedWindows: new Set()
    };
  }
  try {
    return readAgentDatabaseContents(agentId, dbPath, maxEventsPerSession, db);
  } catch (error) {
    // A corrupt or permission-locked vendor file must never crash the viewer:
    // report an explicit unreadable state and keep legacy sessions readable.
    return {
      storage: {
        status: "unreadable",
        agentId,
        dbPath,
        detail: `Agent SQLite could not be read: ${error instanceof Error ? error.message : String(error)}`
      },
      nodes: [],
      windowsByKey: new Map(),
      recordsByWindow: new Map(),
      truncatedWindows: new Set()
    };
  } finally {
    db.close();
  }
}

function readAgentDatabaseContents(
  agentId: string,
  dbPath: string,
  maxEventsPerSession: number,
  db: DatabaseSync
): { storage: OpenClawSqliteStorageState; nodes: NodeRow[]; windowsByKey: Map<string, WindowRow[]>; recordsByWindow: Map<string, OpenClawRecord[]>; truncatedWindows: Set<string> } {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name)
    );
    const schemaVersion = readSchemaVersion(db, tables);
    if (schemaVersion !== null && schemaVersion > SUPPORTED_SCHEMA_MAX) {
      return {
        storage: {
          status: "unsupported",
          agentId,
          dbPath,
          schemaVersion,
          detail: `Agent SQLite uses schema version ${schemaVersion}; this adapter verifies ${SUPPORTED_SCHEMA_MIN}..${SUPPORTED_SCHEMA_MAX} (current 19). Newer-format support pending; legacy JSONL reader remains for this agent.`
        },
        nodes: [],
        windowsByKey: new Map(),
        recordsByWindow: new Map(),
        truncatedWindows: new Set()
      };
    }
    const shapeIssue = columnsMatch(db);
    if (shapeIssue) {
      const supportedRange =
        schemaVersion !== null && schemaVersion >= SUPPORTED_SCHEMA_MIN && schemaVersion <= SUPPORTED_SCHEMA_MAX;
      return {
        storage: {
          status: supportedRange ? "unsupported" : "legacy-only",
          agentId,
          dbPath: supportedRange ? dbPath : null,
          schemaVersion,
          ...(supportedRange
            ? { detail: `Session tables are present but the required shape is missing (${shapeIssue}); current-format reading disabled for this agent, legacy JSONL fallback stays available.` }
            : { detail: `Agent SQLite has no current session tables (schema ${schemaVersion ?? "unknown"}, pre-SQLite-session flip or memory-only store); sessions are legacy JSONL.` })
        } as OpenClawSqliteStorageState,
        nodes: [],
        windowsByKey: new Map(),
        recordsByWindow: new Map(),
        truncatedWindows: new Set()
      };
    }
    const nodes = readSqliteRows(db, "session_nodes", projectColumns(tableColumns(db, "session_nodes"), NODE_COLUMNS)) as NodeRow[];
    const windows = readSqliteRows(db, "session_windows", projectColumns(tableColumns(db, "session_windows"), WINDOW_COLUMNS)) as WindowRow[];
    const windowsByKey = new Map<string, WindowRow[]>();
    for (const window of windows) {
      const rows = windowsByKey.get(window.session_key) || [];
      rows.push(window);
      windowsByKey.set(window.session_key, rows);
    }
    const recordsByWindow = new Map<string, OpenClawRecord[]>();
    const truncatedWindows = new Set<string>();
    const readWindowEvents = (sessionId: string): OpenClawRecord[] => {
      const cached = recordsByWindow.get(sessionId);
      if (cached) return cached;
      const rows = db
        .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq DESC LIMIT ?")
        .all(sessionId, maxEventsPerSession + 1) as Array<{ event_json: string }>;
      const truncated = rows.length > maxEventsPerSession;
      if (truncated) truncatedWindows.add(sessionId);
      const selected = truncated ? rows.slice(0, maxEventsPerSession) : rows;
      const records: OpenClawRecord[] = [];
      for (let index = selected.length - 1; index >= 0; index--) {
        try {
          const parsed = JSON.parse(selected[index].event_json) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            records.push(parsed as OpenClawRecord);
          }
        } catch {
          // One unparseable event must not lose the rest of the window.
          // json1-validated writes normally make this impossible; keep the
          // boundary loud enough to diagnose without killing the session.
          console.warn("Skipping unparseable OpenClaw transcript event row", dbPath, sessionId);
        }
      }
      recordsByWindow.set(sessionId, records);
      return records;
    };
    // Parse current-window events eagerly so scan()/getSession()/getMessages()
    // share exact counts without a second read pass.
    for (const node of nodes) {
      readWindowEvents(node.current_session_id);
    }
    return {
      storage: {
        status: "current",
        agentId,
        dbPath,
        schemaVersion: schemaVersion ?? null,
        sessionCount: nodes.length,
        windowCount: windows.length
      },
      nodes,
      windowsByKey,
      recordsByWindow,
      truncatedWindows
    };
}

export function createOpenClawSqliteSessionStore(
  getOpenClawDir: () => string,
  options: OpenClawAgentDatabaseSnapshotOptions = {}
) {
  const maxEventsPerSession = Math.max(1, options.maxEventsPerSession ?? 100_000);
  let signature = "";
  let states: OpenClawSqliteStorageState[] = [];
  let entries: OpenClawSqliteSessionEntry[] = [];
  // Canonical and alias lookups are claimed by agent so a collision between
  // two agents (identical session_key/window id) stays deterministic: the
  // first claim in sorted agent order wins, every other claimant is recorded
  // in `ambiguities` and surfaced as an explicit diagnostic instead of a
  // silent last-write-wins overwrite.
  let byKey = new Map<string, OpenClawSqliteSessionEntry>();
  let byWindowId = new Map<string, OpenClawSqliteSessionEntry>();
  let ambiguities = new Map<string, Set<string>>();
  // Per-agent coverage: dedup and alias lookups are scoped by agent so one
  // agent's recorded window ids/session keys can never hide or misroute
  // another agent's legacy JSONL sessions.
  let coveredKeysByAgent = new Map<string, Set<string>>();
  let coveredWindowIdsByAgent = new Map<string, Set<string>>();
  let revision = 0;

  const claimEntry = (
    map: Map<string, OpenClawSqliteSessionEntry>,
    ambiguityMap: Map<string, Set<string>>,
    id: string,
    entry: OpenClawSqliteSessionEntry
  ) => {
    const existing = map.get(id);
    if (!existing) {
      map.set(id, entry);
      return;
    }
    if (existing.agentId === entry.agentId) return;
    const claimants = ambiguityMap.get(id) || new Set<string>([existing.agentId]);
    claimants.add(entry.agentId);
    ambiguityMap.set(id, claimants);
  };

  const buildEntry = (
    node: NodeRow,
    agentId: string,
    dbPath: string,
    windows: WindowRow[],
    records: OpenClawRecord[],
    truncated: boolean,
    schemaVersion: number | null
  ): OpenClawSqliteSessionEntry => {
    const messages = openClawRecordsToMessages(records, node.session_key);
    const active = activeOpenClawRecords(records);
    const window = windows.find(row => row.session_id === node.current_session_id) || null;
    const entryJson = parseEntryJson(node.entry_json);
    const directory =
      readWindowHeaderCwd(records) ||
      stringValue(entryJson?.sessionRoot) ||
      stringValue(entryJson?.spawnedCwd) ||
      null;
    const title =
      stringValue(node.display_name) ||
      stringValue(node.label) ||
      stringValue(entryJson?.displayName) ||
      stringValue(entryJson?.label) ||
      stringValue(entryJson?.subject) ||
      stringValue(entryJson?.groupId) ||
      firstUserPreview(messages);
    const timeCreated =
      numberValue(node.created_at) ||
      numberValue(window?.created_at) ||
      (records.length ? openClawRecordTimestamp(records[0]) : 0) ||
      0;
    const windowUpdated =
      numberValue(window?.transcript_updated_at) ||
      numberValue(window?.updated_at) ||
      0;
    const timeUpdated = Math.max(
      windowUpdated,
      numberValue(node.updated_at) || 0,
      records.length ? openClawRecordTimestamp(records[records.length - 1]) : 0
    ) || 0;
    const tokenCount = active.reduce<number>(
      (sum, record) => sum + Number(openClawUsageToTokens(record.message?.usage)?.total || 0),
      0
    ) || null;
    // Recorded window generations, newest first, bounded to the last 20.
    const windowLineage = [...windows]
      .sort((left, right) => (numberValue(right.updated_at) || 0) - (numberValue(left.updated_at) || 0))
      .slice(0, 20)
      .map(windowRow => ({
        sessionId: windowRow.session_id,
        previousSessionId: stringValue(windowRow.previous_session_id),
        reason: stringValue(windowRow.reason),
        createdAt: numberValue(windowRow.created_at),
        updatedAt: numberValue(windowRow.updated_at),
        transcriptUpdatedAt: numberValue(windowRow.transcript_updated_at),
        status: stringValue(windowRow.status),
        model: stringValue(windowRow.model),
        modelProvider: stringValue(windowRow.model_provider)
      }));
    const session: RawSession = {
      id: node.session_key,
      provider: "openclaw",
      // Structural-parent precedence for tree/family views: parent_session_key
      // is the explicit structural parent; spawned_by stands in only when no
      // parent_session_key is recorded. Session Protocol relationships are
      // built from the two fields separately (see protocol.ts) — this
      // single parentId is a view convenience, not protocol evidence.
      parentId: stringValue(node.parent_session_key) || stringValue(node.spawned_by) || null,
      title,
      directory,
      timeCreated: timeCreated || 0,
      timeUpdated: timeUpdated || 0,
      messageCount: messages.length,
      tokenCount,
      metadata: {
        agentId,
        sessionKey: node.session_key,
        storage: "sqlite",
        currentSessionId: node.current_session_id,
        entryValid: node.entry_valid,
        status: stringValue(node.status) || stringValue(window?.status),
        model: stringValue(window?.model) || stringValue(entryJson?.model),
        modelProvider: stringValue(window?.model_provider) || stringValue(entryJson?.modelProvider),
        chatType: stringValue(window?.chat_type),
        channel: stringValue(window?.channel),
        accountId: stringValue(window?.account_id),
        sessionScope: stringValue(window?.session_scope),
        projectId: stringValue(node.project_id),
        createdVia: stringValue(node.created_via),
        createdAt: numberValue(node.created_at),
        pinnedAt: numberValue(node.pinned_at),
        archivedAt: numberValue(node.archived_at),
        lastReadAt: numberValue(node.last_read_at),
        lastInteractionAt: numberValue(node.last_interaction_at),
        lastActivityAt: numberValue(node.last_activity_at),
        parentSessionKey: stringValue(node.parent_session_key),
        spawnedBy: stringValue(node.spawned_by),
        forkSource: node.fork_source_session_key || node.fork_source_session_id
          ? {
              sessionKey: stringValue(node.fork_source_session_key),
              sessionId: stringValue(node.fork_source_session_id),
              entryId: stringValue(node.fork_source_entry_id)
            }
          : null,
        windowLineage,
        truncated: truncated || undefined,
        schemaVersion
      }
    };
    return {
      id: node.session_key,
      agentId,
      dbPath,
      session,
      records,
      messages,
      currentSessionId: node.current_session_id,
      truncated
    };
  };

  const refresh = (force = false) => {
    const agentsDir = path.join(getOpenClawDir(), "agents");
    const candidates: AgentDbState[] = [];
    if (existsSync(agentsDir)) {
      for (const entry of readdirSync(agentsDir).sort()) {
        const agentId = entry;
        const dbPath = path.join(agentsDir, agentId, "agent", "openclaw-agent.sqlite");
        candidates.push({
          agentId,
          dbPath: existsSync(dbPath) ? dbPath : null,
          schemaVersion: null,
          storage: null as unknown as OpenClawSqliteStorageState
        });
      }
    }
    // The signature covers every agent directory (not only those with a
    // SQLite file), so adding/removing a legacy-only agent still refreshes
    // diagnostics; file signatures are WAL-aware (main db + -wal + -shm).
    const nextSignature = candidates
      .map(candidate => candidate.dbPath
        ? databaseFileSignature(candidate.dbPath)
        : `${candidate.agentId}:no-agent-db`)
      .join("|");
    // Signature reflects the CURRENT config dir, so a config change (e.g. a
    // different --openclaw-dir in the next test) cannot serve stale entries;
    // unchanged signatures skip parse work. There is no time-window refresh:
    // every public accessor re-checks the signature (cheap stat compares)
    // and no cached result is ever older than the last filesystem check.
    if (!force && nextSignature === signature) return;
    const nextStates: OpenClawSqliteStorageState[] = [];
    const nextEntries: OpenClawSqliteSessionEntry[] = [];
    const nextByKey = new Map<string, OpenClawSqliteSessionEntry>();
    const nextByWindowId = new Map<string, OpenClawSqliteSessionEntry>();
    const nextAmbiguities = new Map<string, Set<string>>();
    const nextCoveredKeysByAgent = new Map<string, Set<string>>();
    const nextCoveredWindowIdsByAgent = new Map<string, Set<string>>();
    for (const candidate of candidates) {
      const dbPath = candidate.dbPath;
      if (!dbPath) {
        nextStates.push({
          status: "legacy-only",
          agentId: candidate.agentId,
          dbPath: null,
          detail: "No agent/openclaw-agent.sqlite for this agent; sessions are legacy JSONL."
        });
        continue;
      }
      const read = readAgentDatabase(candidate.agentId, dbPath, maxEventsPerSession);
      nextStates.push(read.storage);
      if (read.storage.status !== "current") continue;
      const schemaVersion = read.storage.schemaVersion;
      // Every recorded session_nodes key is covered (canonical session exists
      // in SQLite even when its transcript is empty), and every recorded
      // window generation is covered: legacy JSONL files for older generations
      // (reset/rollover history) belong to the same canonical session and are
      // never listed separately. Coverage is per agent, so an identical id in
      // another agent can never hide that agent's legacy sessions.
      const agentKeys = new Set<string>();
      const agentWindowIds = new Set<string>();
      for (const node of read.nodes) agentKeys.add(node.session_key);
      for (const windows of read.windowsByKey.values()) {
        for (const window of windows) agentWindowIds.add(window.session_id);
      }
      nextCoveredKeysByAgent.set(candidate.agentId, agentKeys);
      nextCoveredWindowIdsByAgent.set(candidate.agentId, agentWindowIds);
      for (const node of read.nodes) {
        const records = read.recordsByWindow.get(node.current_session_id) || [];
        const windows = read.windowsByKey.get(node.session_key) || [];
        // Every session_nodes row is a viewer session, even when its current
        // window has no records yet: an empty SQLite session is still the
        // canonical representation that must resolve (and deduplicate its
        // legacy JSONL) exactly once.
        const entry = buildEntry(node, candidate.agentId, dbPath, windows, records, read.truncatedWindows.has(node.current_session_id), schemaVersion);
        nextEntries.push(entry);
        claimEntry(nextByKey, nextAmbiguities, entry.id, entry);
        claimEntry(nextByWindowId, nextAmbiguities, node.current_session_id, entry);
        // Every recorded window generation resolves to its canonical session
        // key: old-generation legacy URLs (and files deduplicated by a window
        // id) stay resolvable by that window id exactly once.
        for (const window of windows) claimEntry(nextByWindowId, nextAmbiguities, window.session_id, entry);
      }
    }
    const changed =
      nextEntries.length !== entries.length ||
      nextSignature !== signature ||
      states.some((state, index) => JSON.stringify(state) !== JSON.stringify(nextStates[index]));
    states = nextStates;
    entries = nextEntries;
    byKey = nextByKey;
    byWindowId = nextByWindowId;
    ambiguities = nextAmbiguities;
    coveredKeysByAgent = nextCoveredKeysByAgent;
    coveredWindowIdsByAgent = nextCoveredWindowIdsByAgent;
    signature = nextSignature;
    if (changed) revision++;
  };

  return {
    refresh,
    list() {
      refresh();
      return [...entries];
    },
    get(sessionId: string) {
      refresh();
      const exact = byKey.get(sessionId);
      if (exact) return exact;
      // Old legacy URLs used the window/session id; resolve recorded window
      // ids (all generations) to their canonical session_key exactly once.
      // Cross-agent collisions keep the first claim in sorted agent order
      // and are reported via getAmbiguities() instead of last-write-wins.
      return byWindowId.get(sessionId) || null;
    },
    /** Session keys exposed by one agent's current SQLite (for JSONL dedup). */
    coveredKeys(agentId: string) {
      refresh();
      return coveredKeysByAgent.get(agentId) || new Set<string>();
    },
    /** Window ids exposed by one agent's current SQLite (for JSONL dedup), all generations. */
    coveredWindowIds(agentId: string) {
      refresh();
      return coveredWindowIdsByAgent.get(agentId) || new Set<string>();
    },
    /**
     * Ids claimed by more than one agent (canonical key or window id).
     * Deterministic first-write-wins resolution is kept for bare public
     * lookups; these records make the collision explicit instead of silent.
     */
    getAmbiguities() {
      refresh();
      return [...ambiguities.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([id, agentIds]) => ({ id, agents: [...agentIds].sort() }));
    },
    getStorageStates() {
      refresh();
      return [...states];
    },
    getRevision() {
      refresh();
      return revision;
    },
    getSignature() {
      refresh();
      return signature;
    }
  };
}

export function openClawSqliteDailyTokenStats(entries: OpenClawSqliteSessionEntry[], days = 30): DailyTokenStat[] {
  const cutoff = Date.now() - Math.max(1, days) * 86400000;
  const buckets = new Map<string, DailyTokenStat>();
  for (const entry of entries) {
    const records = openClawAssistantUsageRecords(entry.records);
    for (const record of records) {
      const usage = openClawUsageToTokens(record.message?.usage);
      if (!usage) continue;
      const timestamp = openClawRecordTimestamp(record);
      if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp < cutoff) continue;
      const day = new Date(timestamp).toISOString().slice(0, 10);
      const bucket = buckets.get(day) || {
        day,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        messageCount: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      };
      bucket.inputTokens += usage.input || 0;
      bucket.outputTokens += usage.output || 0;
      bucket.totalTokens += usage.total || 0;
      bucket.reasoningTokens = (bucket.reasoningTokens ?? 0) + (usage.reasoning || 0);
      bucket.cacheReadTokens = (bucket.cacheReadTokens ?? 0) + Number(usage.cache?.read || 0);
      bucket.cacheWriteTokens = (bucket.cacheWriteTokens ?? 0) + Number(usage.cache?.write || 0);
      bucket.messageCount += 1;
      buckets.set(day, bucket);
    }
  }
  return [...buckets.values()].sort((left, right) => left.day.localeCompare(right.day));
}
