import { statSync } from "node:fs";
import path from "node:path";
import type { ProviderAdapter, DailyTokenStat, Message, SearchResult } from "../interface.js";
import { createSnippet, matchesSearchQuery } from "./parser.js";

export interface SessionFileDescriptor {
  sessionId: string;
  filePath: string;
}

export interface IndexedSessionFile<TSession, TRecords, TMessages> extends SessionFileDescriptor {
  session: TSession;
  records: TRecords;
  messages: TMessages;
}

export interface SessionFileSignature {
  filePath: string;
  signature: string;
}

interface SessionFileStoreOptions<TSession extends { id: string; parentId?: string | null }, TRecords, TMessages> {
  discoverFiles: () => SessionFileDescriptor[];
  readEntry: (descriptor: SessionFileDescriptor) => {
    session: TSession;
    records: TRecords;
    messages: TMessages;
  };
  refreshIntervalMs?: number;
  onError?: (filePath: string, error: unknown) => void;
}

/**
 * Maintain a provider-owned canonical session index for transcript files.
 * Directory refreshes only stat files; unchanged transcripts keep their parsed
 * records and normalized messages. A size or mtime change reparses that file.
 */
export function createSessionFileStore<
  TSession extends { id: string; parentId?: string | null },
  TRecords,
  TMessages
>(options: SessionFileStoreOptions<TSession, TRecords, TMessages>) {
  const refreshIntervalMs = Math.max(0, options.refreshIntervalMs ?? 1000);
  let lastRefresh = 0;
  let entriesByPath = new Map<string, IndexedSessionFile<TSession, TRecords, TMessages> & { signature: string }>();
  let entriesById = new Map<string, IndexedSessionFile<TSession, TRecords, TMessages> & { signature: string }>();
  let childrenByParent = new Map<string, Array<IndexedSessionFile<TSession, TRecords, TMessages> & { signature: string }>>();
  let revision = 0;

  const refresh = (force = false) => {
    const now = Date.now();
    if (!force && lastRefresh && now - lastRefresh < refreshIntervalMs) return;
    const nextByPath = new Map<string, IndexedSessionFile<TSession, TRecords, TMessages> & { signature: string }>();

    for (const descriptor of options.discoverFiles()) {
      const filePath = path.resolve(descriptor.filePath);
      try {
        const stat = statSync(filePath);
        const signature = `${stat.size}:${stat.mtimeMs}`;
        const cached = entriesByPath.get(filePath);
        if (cached?.signature === signature) {
          nextByPath.set(filePath, cached);
          continue;
        }
        const loaded = options.readEntry({ ...descriptor, filePath });
        nextByPath.set(filePath, { ...descriptor, filePath, ...loaded, signature });
      } catch (error) {
        options.onError?.(filePath, error);
        const cached = entriesByPath.get(filePath);
        if (cached) nextByPath.set(filePath, cached);
      }
    }

    const nextById = new Map<string, IndexedSessionFile<TSession, TRecords, TMessages> & { signature: string }>();
    const nextChildren = new Map<string, Array<IndexedSessionFile<TSession, TRecords, TMessages> & { signature: string }>>();
    for (const entry of nextByPath.values()) {
      nextById.set(String(entry.session.id), entry);
      if (entry.sessionId && !nextById.has(entry.sessionId)) nextById.set(entry.sessionId, entry);
    }
    for (const entry of nextByPath.values()) {
      const parentId = entry.session.parentId;
      if (parentId) {
        const parent = nextById.get(String(parentId));
        const key = String(parent?.session.id || parentId);
        const children = nextChildren.get(key) || [];
        children.push(entry);
        nextChildren.set(key, children);
      }
    }
    const changed = nextByPath.size !== entriesByPath.size
      || [...nextByPath].some(([filePath, entry]) => entriesByPath.get(filePath)?.signature !== entry.signature);
    entriesByPath = nextByPath;
    entriesById = nextById;
    childrenByParent = nextChildren;
    if (changed) revision++;
    lastRefresh = now;
  };

  const publicEntry = (entry: IndexedSessionFile<TSession, TRecords, TMessages> & { signature: string }) => entry as IndexedSessionFile<TSession, TRecords, TMessages>;

  return {
    refresh,
    list() {
      refresh();
      return [...entriesByPath.values()].map(publicEntry);
    },
    get(sessionId: string) {
      refresh();
      const entry = entriesById.get(sessionId);
      return entry ? publicEntry(entry) : null;
    },
    getByFilePath(filePath: string) {
      refresh();
      const entry = entriesByPath.get(path.resolve(filePath));
      return entry ? publicEntry(entry) : null;
    },
    getStatsRevision() {
      refresh();
      return revision;
    },
    getFileSignatures(): SessionFileSignature[] {
      refresh();
      return [...entriesByPath.values()].map(({ filePath, signature }) => ({ filePath, signature }));
    },
    getFamily(rootSessionId: string) {
      refresh();
      const family: IndexedSessionFile<TSession, TRecords, TMessages>[] = [];
      const seen = new Set<string>();
      const visit = (entry: IndexedSessionFile<TSession, TRecords, TMessages> & { signature: string }) => {
        const canonicalId = String(entry.session.id);
        if (seen.has(canonicalId)) return;
        seen.add(canonicalId);
        family.push(publicEntry(entry));
        for (const child of childrenByParent.get(canonicalId) || []) {
          visit(child);
        }
      };
      const root = entriesById.get(rootSessionId);
      if (root) visit(root);
      return family;
    }
  };
}

/**
 * Create a 1-second cache for a single-session view builder.
 * Prevents redundant rebuilds when a detail page requests multiple
 * view facets (tree, container, metrics, flow) for the same session
 * within a single render cycle.
 */
export function createStructuredViewCache<T>(
  builder: (sessionId: string) => T | null
): (sessionId: string) => T | null {
  let cache: { sessionId: string; expires: number; views: T | null } | null = null;
  return (sessionId: string) => {
    const now = Date.now();
    if (cache?.sessionId === sessionId && cache.expires > now) {
      return cache.views;
    }
    const views = builder(sessionId);
    cache = { sessionId, expires: now + 1000, views };
    return views;
  };
}

/**
 * Create the structured Agent Loop view delegate methods from a pre-cached
 * view getter. Callers use {@link createStructuredViewCache} to wrap
 * their provider-specific builder, then pass the cached getter here.
 *
 * Providers can override a generated trace when their source stores a richer,
 * provider-native step model (for example OpenCode and Claude Code).
 */
export function createStructuredViewMethods(
  getViews: (sessionId: string) => Record<string, any> | null
): Pick<ProviderAdapter, "getSessionTree" | "getSessionContainer" | "getSessionMetrics" | "getSessionFlow" | "getTrace"> {
  return {
    getSessionTree(sessionId: string) { return getViews(sessionId)?.tree || null; },
    getSessionContainer(sessionId: string) { return getViews(sessionId)?.container || null; },
    getSessionMetrics(sessionId: string) { return getViews(sessionId)?.metrics || null; },
    getSessionFlow(sessionId: string) { return getViews(sessionId)?.flow || null; },
    getTrace(sessionId: string) { return getViews(sessionId)?.trace || null; },
  };
}

/**
 * Search the normalized conversational surface shared by file-backed
 * providers. Tool and system records stay available in the session detail
 * view, but do not leak provider-specific diagnostic text into global search.
 */
export function searchNormalizedMessages(
  entries: Iterable<{ session: { id: string }; messages: Message[] }>,
  query: string,
  limit = 20
): SearchResult[] {
  if (!String(query || "").trim()) return [];
  const results: SearchResult[] = [];
  for (const entry of entries) {
    if (results.length >= limit) break;
    for (const message of entry.messages) {
      if (results.length >= limit) break;
      if (message.role !== "user" && message.role !== "assistant") continue;
      if (!matchesSearchQuery(message.content, query)) continue;
      results.push({
        sessionId: entry.session.id,
        messageId: message.id,
        role: message.role,
        snippet: createSnippet(message.content, query),
        timestamp: message.timestamp
      });
    }
  }
  return results;
}

/**
 * Per-provider mapping from a raw transcript record to token fields.
 * Each file-based provider expresses the same aggregation differently.
 */
export interface TokenFieldMapping {
  inputTokens: (record: any) => number;
  outputTokens: (record: any) => number;
  totalTokens: (record: any) => number;
  reasoningTokens: (record: any) => number;
  cacheReadTokens: (record: any) => number;
  cacheWriteTokens: (record: any) => number;
  filterRecord: (record: any) => boolean;
  getTimestamp: (record: any) => number;
}

/**
 * Generic daily token-stats aggregator for file-based providers.
 *
 * @param discoverFiles  Returns session-file entries (must include `filePath`).
 * @param parseFile      Parses a single session file; returns an array of
 *                       records or an object with a `messages`/`records` array.
 * @param fieldMapping   Provider-specific field accessors.
 * @param days           Number of days to include (default 30).
 */
export function buildTokenStats(
  discoverFiles: () => Array<{ filePath: string }>,
  parseFile: (filePath: string) => any,
  fieldMapping: TokenFieldMapping,
  days = 30
): DailyTokenStat[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const cutoff = today.getTime() - (Math.max(1, days) - 1) * 86400000;
  const dailyMap = new Map<string, DailyTokenStat>();

  for (const { filePath } of discoverFiles()) {
    try {
      const data = parseFile(filePath);
      if (!data) continue;
      const records = Array.isArray(data) ? data : (data.records || data.messages || []);
      for (const r of records) {
        if (!fieldMapping.filterRecord(r)) continue;
        const ts = fieldMapping.getTimestamp(r);
        if (ts < cutoff) continue;
        const day = new Date(ts).toISOString().slice(0, 10);
        const existing = dailyMap.get(day) || {
          day, inputTokens: 0, outputTokens: 0, totalTokens: 0, messageCount: 0,
          reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0
        };
        existing.inputTokens += fieldMapping.inputTokens(r);
        existing.outputTokens += fieldMapping.outputTokens(r);
        existing.totalTokens += fieldMapping.totalTokens(r);
        existing.reasoningTokens = (existing.reasoningTokens ?? 0) + fieldMapping.reasoningTokens(r);
        existing.cacheReadTokens = (existing.cacheReadTokens ?? 0) + fieldMapping.cacheReadTokens(r);
        existing.cacheWriteTokens = (existing.cacheWriteTokens ?? 0) + fieldMapping.cacheWriteTokens(r);
        existing.messageCount += 1;
        dailyMap.set(day, existing);
      }
    } catch (err) {
      console.warn("Skipping unparseable session file for token stats:", filePath, err);
    }
  }

  return [...dailyMap.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Keep per-transcript daily aggregates while transcript signatures are stable.
 * A changed transcript is the only one reparsed into aggregate buckets; range
 * changes merely combine the already computed daily buckets.
 */
export function createIncrementalTokenStats(
  discoverFiles: () => SessionFileSignature[],
  parseFile: (filePath: string) => any,
  fieldMapping: TokenFieldMapping,
): (days?: number) => DailyTokenStat[] {
  const byFile = new Map<string, { signature: string; days: Map<string, DailyTokenStat> }>();

  const buildFileDays = (filePath: string) => {
    const dailyMap = new Map<string, DailyTokenStat>();
    const data = parseFile(filePath);
    const records = Array.isArray(data) ? data : (data?.records || data?.messages || []);
    for (const record of records) {
      if (!fieldMapping.filterRecord(record)) continue;
      const timestamp = fieldMapping.getTimestamp(record);
      if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
      const day = new Date(timestamp).toISOString().slice(0, 10);
      const existing = dailyMap.get(day) || {
        day, inputTokens: 0, outputTokens: 0, totalTokens: 0, messageCount: 0,
        reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0
      };
      existing.inputTokens += fieldMapping.inputTokens(record);
      existing.outputTokens += fieldMapping.outputTokens(record);
      existing.totalTokens += fieldMapping.totalTokens(record);
      existing.reasoningTokens = (existing.reasoningTokens ?? 0) + fieldMapping.reasoningTokens(record);
      existing.cacheReadTokens = (existing.cacheReadTokens ?? 0) + fieldMapping.cacheReadTokens(record);
      existing.cacheWriteTokens = (existing.cacheWriteTokens ?? 0) + fieldMapping.cacheWriteTokens(record);
      existing.messageCount += 1;
      dailyMap.set(day, existing);
    }
    return dailyMap;
  };

  return (days = 30) => {
    const files = discoverFiles();
    const activePaths = new Set(files.map(({ filePath }) => filePath));
    for (const filePath of byFile.keys()) {
      if (!activePaths.has(filePath)) byFile.delete(filePath);
    }

    for (const { filePath, signature } of files) {
      const cached = byFile.get(filePath);
      if (cached?.signature === signature) continue;
      try {
        byFile.set(filePath, { signature, days: buildFileDays(filePath) });
      } catch (error) {
        console.warn("Skipping unparseable session file for token stats:", filePath, error);
        byFile.delete(filePath);
      }
    }

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const cutoff = today.getTime() - (Math.max(1, days) - 1) * 86400000;
    const totals = new Map<string, DailyTokenStat>();
    for (const cached of byFile.values()) {
      for (const stat of cached.days.values()) {
        if (new Date(`${stat.day}T00:00:00.000Z`).getTime() < cutoff) continue;
        const existing = totals.get(stat.day) || {
          day: stat.day, inputTokens: 0, outputTokens: 0, totalTokens: 0, messageCount: 0,
          reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0
        };
        existing.inputTokens += stat.inputTokens;
        existing.outputTokens += stat.outputTokens;
        existing.totalTokens += stat.totalTokens;
        existing.reasoningTokens = (existing.reasoningTokens ?? 0) + (stat.reasoningTokens ?? 0);
        existing.cacheReadTokens = (existing.cacheReadTokens ?? 0) + (stat.cacheReadTokens ?? 0);
        existing.cacheWriteTokens = (existing.cacheWriteTokens ?? 0) + (stat.cacheWriteTokens ?? 0);
        existing.messageCount += stat.messageCount;
        totals.set(stat.day, existing);
      }
    }
    return [...totals.values()].sort((a, b) => a.day.localeCompare(b.day));
  };
}
