import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { getConfig } from "../../config.js";
import { icons } from "../../icons.js";
import type { Message, ProviderAdapter, RawSession } from "../interface.js";
import { buildLinkedMessageSessionViews } from "../shared/linked-message-session.js";
import { buildResolvedSystemPromptEvidence } from "../shared/system-prompt-evidence.js";
import {
  createIncrementalTokenStats,
  createSessionFileStore,
  createStructuredViewCache,
  createStructuredViewMethods,
  searchNormalizedMessages,
  type SessionFileDescriptor,
  type TokenFieldMapping
} from "../shared/file-adapter-helpers.js";
import {
  extractOpenClawMeta,
  openClawAssistantUsageRecords,
  openClawRecordsToMessages,
  openClawUsageToTokens,
  parseOpenClawSession
} from "./parser.js";
import {
  buildOpenClawSessionProtocol,
  buildOpenClawSqliteSessionProtocol,
  openClawProtocolCapabilities,
  type OpenClawSqliteLineageFacts
} from "./protocol.js";
import { buildOpenClawRuntimeEnvironment } from "./runtime-environment.js";
import {
  createOpenClawSqliteSessionStore,
  openClawSqliteDailyTokenStats,
  type OpenClawSqliteSessionEntry
} from "./sqlite-store.js";

interface OpenClawDescriptor extends SessionFileDescriptor {
  agentId: string;
  registry: Record<string, any> | null;
}

function getOpenClawDir() {
  return getConfig().openclawDir;
}

function readRegistryDocument(sessionsDir: string) {
  const registryPath = path.join(sessionsDir, "sessions.json");
  if (!existsSync(registryPath)) return {} as Record<string, Record<string, any>>;
  try {
    const document = JSON.parse(readFileSync(registryPath, "utf8"));
    return document && typeof document === "object" && !Array.isArray(document)
      ? document as Record<string, Record<string, any>>
      : {};
  } catch (error) {
    console.warn("Ignoring unreadable OpenClaw session registry:", registryPath, error);
    return {};
  }
}

const sqliteStore = createOpenClawSqliteSessionStore(getOpenClawDir);

/**
 * Session keys claimed by more than one DIFFERENT legacy file id across
 * agents, from the most recent legacy discovery run. Referenced-parent
 * resolution refuses these (never silently picks one) and surfaces them here.
 */
let lastFileKeyAmbiguities: string[] = [];

/**
 * De-duplication between current SQLite and legacy JSONL: the same canonical
 * session must appear exactly once, preferring the current SQLite record.
 *
 * A legacy JSONL file is covered when its window/session id (the file name)
 * is a recorded window in the SAME agent's current SQLite, OR its registry
 * sessionKey is a recorded session_nodes key in the same agent. Coverage is
 * scoped by agent: an identical id recorded by another agent can never hide
 * this agent's legacy sessions, and legacy files for sessions that were never
 * migrated (or whose agent SQLite is unavailable) stay readable.
 */
function isCoveredBySqlite(agentId: string, sessionId: string, registry: Record<string, any> | null) {
  // Same canonical session (session_nodes key or any recorded window
  // generation) already exposed by this agent's current SQLite => prefer
  // SQLite exactly once and never list the legacy copy.
  if (sqliteStore.coveredWindowIds(agentId).has(sessionId)) return true;
  const sessionKey = String(registry?.sessionKey || "");
  return Boolean(sessionKey) && sqliteStore.coveredKeys(agentId).has(sessionKey);
}

function discoverSessionFiles(): OpenClawDescriptor[] {
  const agentsDir = path.join(getOpenClawDir(), "agents");
  if (!existsSync(agentsDir)) return [];
  const files: OpenClawDescriptor[] = [];
  const agents = readdirSync(agentsDir).flatMap(agentId => {
    const sessionsDir = path.join(agentsDir, agentId, "sessions");
    return existsSync(sessionsDir)
      ? [{ agentId, sessionsDir, registry: readRegistryDocument(sessionsDir) }]
      : [];
  });
  const registryPaths = agents.map(agent => path.join(agent.sessionsDir, "sessions.json"));
  // Cross-store lineage resolution is agent-first, then global:
  // 1. a canonical session key of THIS agent's current SQLite,
  // 2. a legacy file id of THIS agent's registry,
  // 3. a single unambiguous claim for the key in any agent (cross-agent
  //    legacy lineage, e.g. a worker child referencing a main session),
  // 4. otherwise unresolved (null) with an explicit ambiguity diagnostic.
  // Coverage itself stays strictly agent-scoped (see isCoveredBySqlite); only
  // referenced-parent resolution may cross agents, and only when it cannot be
  // misrouted by a collision. Canonical SQLite session keys are global by
  // construction; their pathological cross-agent collisions are already
  // reported by sqliteStore.getAmbiguities().
  const sqliteKeyClaims = new Map<string, Set<string>>();
  for (const agent of agents) {
    for (const key of sqliteStore.coveredKeys(agent.agentId)) {
      const claims = sqliteKeyClaims.get(key) || new Set<string>();
      claims.add(agent.agentId);
      sqliteKeyClaims.set(key, claims);
    }
  }
  const fileKeyClaims = new Map<string, Set<string>>();
  for (const agent of agents) {
    for (const [sessionKey, row] of Object.entries(agent.registry)) {
      const sessionId = String(row?.sessionId || "");
      if (!sessionId) continue;
      const claims = fileKeyClaims.get(sessionKey) || new Set<string>();
      claims.add(sessionId);
      fileKeyClaims.set(sessionKey, claims);
    }
  }
  lastFileKeyAmbiguities = [...fileKeyClaims.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([sessionKey]) => sessionKey)
    .sort();
  for (const { agentId, sessionsDir, registry } of agents) {
    const registryById = new Map<string, Record<string, any>>();
    const sessionIdByKey = new Map<string, string>();
    for (const [sessionKey, row] of Object.entries(registry)) {
      const sessionId = String(row?.sessionId || "");
      if (sessionId) sessionIdByKey.set(sessionKey, sessionId);
    }
    const ownSqliteKeys = sqliteStore.coveredKeys(agentId);
    const resolveParent = (sessionKey: string): string | null => {
      if (ownSqliteKeys.has(sessionKey)) return sessionKey;
      const ownFileId = sessionIdByKey.get(sessionKey);
      if (ownFileId) return ownFileId;
      if (sqliteKeyClaims.has(sessionKey)) return sessionKey;
      const fileIds = fileKeyClaims.get(sessionKey);
      if (fileIds && fileIds.size === 1) return [...fileIds][0];
      return null;
    };
    for (const [sessionKey, row] of Object.entries(registry)) {
      const sessionId = String(row?.sessionId || "");
      if (!sessionId) continue;
      const parentRef = typeof row.spawnedBy === "string" ? resolveParent(row.spawnedBy) : null;
      registryById.set(sessionId, { ...row, sessionKey, spawnedBy: parentRef });
    }
    for (const name of readdirSync(sessionsDir)) {
      if (!name.endsWith(".jsonl") || name.endsWith(".trajectory.jsonl")) continue;
      const descriptorSessionId = name.slice(0, -6);
      const descriptorRegistry = registryById.get(descriptorSessionId) || null;
      // Same canonical session already exposed by current SQLite => skip
      // exactly once, SQLite wins.
      if (isCoveredBySqlite(agentId, descriptorSessionId, descriptorRegistry)) continue;
      const filePath = path.join(sessionsDir, name);
      try {
        const stat = lstatSync(filePath);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          files.push({
            // OpenClaw names transcript files <canonical session ID>.jsonl;
            // the parser still treats the header ID as authoritative.
            sessionId: descriptorSessionId,
            filePath,
            agentId,
            registry: descriptorRegistry,
            dependencyPaths: registryPaths
          });
        }
      } catch (error) {
        console.warn("Skipping unreadable OpenClaw session entry:", filePath, error);
      }
    }
  }
  return files;
}

const sessionFiles = createSessionFileStore({
  discoverFiles: discoverSessionFiles,
  readEntry(descriptor) {
    const entry = descriptor as OpenClawDescriptor;
    const records = parseOpenClawSession(entry.filePath);
    const session = extractOpenClawMeta(records, entry.sessionId, entry.agentId, entry.registry);
    return { records, session, messages: openClawRecordsToMessages(records, session.id) };
  },
  onError(filePath, error) {
    console.warn("Skipping unparseable OpenClaw session:", filePath, error);
  }
});

// The shared file store refreshes on a fixed interval; a config change
// (--openclaw-dir in tests, or an env override before first use) must
// re-discover immediately instead of serving the previous root's cache.
let lastDiscoveryDir: string | null = null;
function ensureDiscoveryDir() {
  const current = getOpenClawDir();
  if (lastDiscoveryDir !== current) {
    lastDiscoveryDir = current;
    sessionFiles.refresh(true);
  }
}

function getViewsFor(sessionId: string) {
  return getViews(`${getOpenClawDir()}\u0000${sessionId}`);
}

function runtimeFor(sessionId: string) {
  ensureDiscoveryDir();
  const entry = sqliteStore.get(sessionId) || sessionFiles.get(sessionId);
  const agentId = String(entry?.session.metadata?.agentId || "main");
  return entry?.session.directory
    ? buildOpenClawRuntimeEnvironment(entry.session.id, entry.session.directory, getOpenClawDir(), agentId)
    : null;
}

function allEntries(): Array<{ session: RawSession; messages: Message[]; records: unknown[]; key: string }> {
  return [
    ...sqliteStore.list().map(entry => ({
      session: entry.session,
      messages: entry.messages,
      records: entry.records,
      key: `sqlite:${entry.id}`
    })),
    ...sessionFiles.list().map(entry => ({
      session: entry.session,
      messages: entry.messages,
      records: entry.records,
      key: `file:${entry.session.id}`
    }))
  ];
}

const getViews = createStructuredViewCache((cacheKey: string) => {
  ensureDiscoveryDir();
  // The shared cache is keyed by session id; namespace it on the current
  // OpenClaw dir so re-pointing at another state root never serves another
  // installation's views for the same canonical key.
  const sessionId = cacheKey.slice(cacheKey.indexOf("\u0000") + 1);
  const entry = sqliteStore.get(sessionId) || sessionFiles.get(sessionId);
  if (!entry) return null;
  return buildLinkedMessageSessionViews(entry.session.id, getFamily(entry.session.id));
});

/**
 * Combined lineage across the current SQLite store and uncovered legacy JSONL
 * sessions. Children resolve by canonical id; legacy parent ids (registry
 * resolved file session ids) and sqlite window ids both map back to their
 * owning session so a mixed install still produces one coherent family.
 */
function getFamily(rootSessionId: string): Array<{ session: RawSession; messages: Message[]; records: unknown[] }> {
  const entries = allEntries();
  const byId = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    byId.set(String(entry.session.id), entry);
    const sqlite = sqliteStore.get(String(entry.session.id));
    if (sqlite && sqlite.currentSessionId) byId.set(sqlite.currentSessionId, entry);
  }
  const childrenByParent = new Map<string, (typeof entries)[number][]>();
  for (const entry of entries) {
    const parentId = entry.session.parentId;
    if (!parentId) continue;
    const parent = byId.get(String(parentId));
    const key = String(parent?.session.id || parentId);
    const children = childrenByParent.get(key) || [];
    children.push(entry);
    childrenByParent.set(key, children);
  }
  const family: (typeof entries)[number][] = [];
  const seen = new Set<string>();
  const visit = (entry: (typeof entries)[number]) => {
    const canonical = String(entry.session.id);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    family.push(entry);
    for (const child of childrenByParent.get(canonical) || []) visit(child);
  };
  const root = byId.get(rootSessionId);
  if (root) visit(root);
  return family.map(entry => ({ session: entry.session, messages: entry.messages, records: entry.records }));
}

const tokenMapping: TokenFieldMapping = {
  filterRecord: record => record.type === "message" && record.message?.role === "assistant" && Boolean(record.message?.usage),
  getTimestamp: record => Number(record.message?.timestamp) || (record.timestamp ? Date.parse(record.timestamp) : 0),
  inputTokens: record => openClawUsageToTokens(record.message?.usage)?.input || 0,
  outputTokens: record => openClawUsageToTokens(record.message?.usage)?.output || 0,
  totalTokens: record => openClawUsageToTokens(record.message?.usage)?.total || 0,
  reasoningTokens: record => openClawUsageToTokens(record.message?.usage)?.reasoning || 0,
  cacheReadTokens: record => openClawUsageToTokens(record.message?.usage)?.cache?.read || 0,
  cacheWriteTokens: record => openClawUsageToTokens(record.message?.usage)?.cache?.write || 0
};

const getFileTokenStats = createIncrementalTokenStats(
  () => sessionFiles.getFileSignatures(),
  filePath => openClawAssistantUsageRecords(sessionFiles.getByFilePath(filePath)?.records || []),
  tokenMapping
);

function sqliteLineageFacts(entry: OpenClawSqliteSessionEntry | null): OpenClawSqliteLineageFacts {
  if (!entry) return {};
  const metadata = entry.session.metadata || {};
  return {
    forkedFromSessionKey: metadata.forkSource && typeof metadata.forkSource === "object"
      ? String((metadata.forkSource as any).sessionKey || "")
      : null
  };
}

function sessionProtocolFor(sessionId: string) {
  const entry = sqliteStore.get(sessionId);
  if (entry) {
    // Pass every recorded sibling/child whose recorded parent_session_key or
    // spawned_by names this session; the protocol projection decides which
    // relationship type each field yields (never from the conflated
    // structural parentId).
    const children = sqliteStore.list().filter(child => {
      if (child.id === entry.id) return false;
      return (
        child.session.metadata?.parentSessionKey === entry.session.id ||
        child.session.metadata?.spawnedBy === entry.session.id
      );
    });
    return buildOpenClawSqliteSessionProtocol(
      entry.session,
      entry.records,
      children,
      sqliteStore.getRevision(),
      sqliteLineageFacts(entry)
    );
  }
  ensureDiscoveryDir();
  const fileEntry = sessionFiles.get(sessionId);
  if (!fileEntry) return null;
  const family = sessionFiles.getFamily(sessionId);
  return buildOpenClawSessionProtocol(
    fileEntry.session,
    fileEntry.records,
    family.filter((child: any) => String(child.session.id) !== String(fileEntry.session.id)),
    sessionFiles.getStatsRevision()
  );
}

const openclaw = {
  id: "openclaw",
  name: "OpenClaw",
  icon: icons.openclaw,
  resumeCommand: { executable: "openclaw", args: ["tui", "--local", "--session", "{sessionId}"] },
  getResumeCommandSpec(sessionId) {
    ensureDiscoveryDir();
    const sessionKey =
      sqliteStore.get(sessionId)?.session.metadata?.sessionKey ||
      sessionFiles.get(sessionId)?.session.metadata?.sessionKey;
    return typeof sessionKey === "string" && sessionKey
      ? { executable: "openclaw", args: ["tui", "--local", "--session", sessionKey] }
      : null;
  },
  capabilities: { localManagement: true },
  protocolCapabilities: openClawProtocolCapabilities,
  detect() { return existsSync(path.join(getOpenClawDir(), "agents")); },
  getUnavailableReason() {
    const agentsDir = path.join(getOpenClawDir(), "agents");
    return existsSync(agentsDir)
      ? null
      : `OpenClaw agents directory was not found at ${agentsDir}. Set OPENCLAW_STATE_DIR or --openclaw-dir.`;
  },
  getDataPath() { return getOpenClawDir(); },
  getStorageDiagnostic() {
    const states = sqliteStore.getStorageStates();
    const current = states.filter(state => state.status === "current");
    const legacy = states.filter(state => state.status === "legacy-only");
    const unsupported = states.filter(state => state.status === "unsupported");
    const unreadable = states.filter(state => state.status === "unreadable");
    const ambiguities = sqliteStore.getAmbiguities();
    ensureDiscoveryDir();
    const legacySessionCount = sessionFiles.list().length;
    const lineageAmbiguities = lastFileKeyAmbiguities;
    return {
      currentSqliteAgents: current.length,
      legacyOnlyAgents: legacy.length,
      unsupportedAgents: unsupported.length,
      unreadableAgents: unreadable.length,
      currentSqliteSessions: current.reduce((sum, state) => sum + (state.sessionCount || 0), 0),
      legacyJsonlSessions: legacySessionCount,
      states,
      // Ids claimed by more than one agent (identical session_key or window
      // id). Bare public lookups resolve deterministically (sorted agent
      // order, first claim wins) but the collision is made explicit here.
      aliasAmbiguities: ambiguities,
      // Registry session keys that map to different legacy file ids in
      // different agents: referenced-parent resolution stays unresolved for
      // them instead of silently picking one.
      lineageAmbiguities,
      note: unreadable.length || unsupported.length || ambiguities.length || lineageAmbiguities.length
        ? (unreadable.length || unsupported.length
            ? "One or more agents have an unreadable or unsupported SQLite store; the legacy JSONL reader stays active for every readable legacy session. "
            : "") +
          (ambiguities.length
            ? `${ambiguities.length} session id(s) are recorded by more than one agent; lookups resolve deterministically to the first agent in sorted order. `
            : "") +
          (lineageAmbiguities.length
            ? `${lineageAmbiguities.length} registry session key(s) map to different legacy file ids across agents; referenced parents stay unresolved for them.`
            : "")
        : null
    };
  },
  async *scan() {
    // Current SQLite sessions first (canonical), then uncovered legacy JSONL.
    for (const entry of sqliteStore.list()) yield entry.session;
    ensureDiscoveryDir();
    for (const entry of sessionFiles.list()) yield entry.session;
  },
  getSession(sessionId) {
    ensureDiscoveryDir();
    return sqliteStore.get(sessionId)?.session || sessionFiles.get(sessionId)?.session || null;
  },
  getMessages(sessionId) {
    ensureDiscoveryDir();
    return sqliteStore.get(sessionId)?.messages || sessionFiles.get(sessionId)?.messages || [];
  },
  getRuntimeEnvironment: runtimeFor,
  getSystemPrompts(sessionId) {
    ensureDiscoveryDir();
    const entry = sqliteStore.get(sessionId) || sessionFiles.get(sessionId);
    if (!entry) return null;
    return buildResolvedSystemPromptEvidence({
      providerName: "OpenClaw",
      mode: "openclaw-resolved",
      session: entry.session,
      messages: entry.messages,
      runtimeEnvironment: runtimeFor(sessionId)
    });
  },
  ...createStructuredViewMethods(getSessionId => getViewsFor(getSessionId)),
  getTokenStats(days = 30) {
    ensureDiscoveryDir();
    const sqliteStats = openClawSqliteDailyTokenStats(sqliteStore.list(), days);
    const fileStats = getFileTokenStats(days);
    const merged = new Map<string, any>();
    for (const stat of [...sqliteStats, ...fileStats]) {
      const existing = merged.get(stat.day) || { day: stat.day, inputTokens: 0, outputTokens: 0, totalTokens: 0, messageCount: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      existing.inputTokens += stat.inputTokens;
      existing.outputTokens += stat.outputTokens;
      existing.totalTokens += stat.totalTokens;
      existing.messageCount += stat.messageCount;
      existing.reasoningTokens = (existing.reasoningTokens ?? 0) + (stat.reasoningTokens ?? 0);
      existing.cacheReadTokens = (existing.cacheReadTokens ?? 0) + (stat.cacheReadTokens ?? 0);
      existing.cacheWriteTokens = (existing.cacheWriteTokens ?? 0) + (stat.cacheWriteTokens ?? 0);
      merged.set(stat.day, existing);
    }
    return [...merged.values()].sort((left, right) => left.day.localeCompare(right.day));
  },
  getStatsRevision() {
    ensureDiscoveryDir();
    return `${sqliteStore.getRevision()}|${sessionFiles.getStatsRevision()}`;
  },
  getSessionProtocol: sessionProtocolFor,
  searchMessages(query, limit = 20) {
    ensureDiscoveryDir();
    return searchNormalizedMessages(allEntries(), query, limit);
  },
  exportSession(sessionId) {
    const sqliteEntry = sqliteStore.get(sessionId);
    ensureDiscoveryDir();
    const entry = sqliteEntry || sessionFiles.get(sessionId);
    return entry
      ? { session: entry.session, messages: entry.messages, records: entry.records }
      : null;
  }
} satisfies ProviderAdapter;

export default openclaw;
