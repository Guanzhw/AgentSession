import { statSync } from "node:fs";
import path from "node:path";
import type { ProviderAdapter, DailyTokenStat, Message, SearchResult } from "../interface.js";
import { createSnippet, matchesSearchQuery } from "./parser.js";
import { questionAnswersText } from "./question-answers.js";

export interface SessionFileDescriptor {
  sessionId: string;
  filePath: string;
  /** Supplementary provider-owned files whose changes invalidate this parsed entry. */
  dependencyPaths?: string[];
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

export function sessionFileSignature(filePath: string, stat: { size: number; mtimeMs: number }): string {
  return `${path.resolve(filePath)}:${stat.size}:${stat.mtimeMs}`;
}

interface SessionFilePayload<TRecords, TMessages> {
  records: TRecords;
  messages: TMessages;
}

/** A provider-owned immutable read extent, including how to reread that extent. */
interface SessionFilePayloadSnapshot<TRecords, TMessages> {
  signature: string;
  sourceBytes: number;
  read: () => SessionFilePayload<TRecords, TMessages>;
}

interface SessionFileStoreOptions<TSession extends { id: string; parentId?: string | null }, TRecords, TMessages> {
  discoverFiles: () => SessionFileDescriptor[];
  readEntry: (descriptor: SessionFileDescriptor) => {
    session: TSession;
    records: TRecords;
    messages: TMessages;
    payloadSnapshot?: SessionFilePayloadSnapshot<TRecords, TMessages>;
  };
  refreshIntervalMs?: number;
  onError?: (filePath: string, error: unknown) => void;
  /** Whether a failed refresh may retain a previously cached entry. */
  retainCachedOnError?: boolean;
  /** Optional LRU payload budget measured by source file bytes; metadata stays indexed.
   * One oversized active payload is retained whole. */
  maxCachedSourceBytes?: number;
}

/**
 * Maintain a provider-owned canonical session index for transcript files.
 * Directory refreshes only stat files; unchanged transcripts keep their parsed
 * records and normalized messages. A size or mtime change reparses that file.
 * A configured payload budget evicts only records/messages, which reload on
 * demand; canonical metadata, aliases, and relationships remain indexed.
 */
export function createSessionFileStore<
  TSession extends { id: string; parentId?: string | null },
  TRecords,
  TMessages
>(options: SessionFileStoreOptions<TSession, TRecords, TMessages>) {
  const refreshIntervalMs = Math.max(0, options.refreshIntervalMs ?? 1000);
  let lastRefresh = 0;
  type Entry = IndexedSessionFile<TSession, TRecords, TMessages> & {
    signature: string;
    sourceBytes: number;
    payloadSnapshot?: SessionFilePayloadSnapshot<TRecords, TMessages>;
  };
  type Payload = { records: TRecords; messages: TMessages; signature: string; sourceBytes: number };
  type Capture = { sessionId: string; entry?: Entry; payload?: SessionFilePayload<TRecords, TMessages> };
  let entriesByPath = new Map<string, Entry>();
  let entriesById = new Map<string, Entry>();
  let childrenByParent = new Map<string, Entry[]>();
  let revision = 0;
  const payloads = new Map<string, Payload>();
  let cachedSourceBytes = 0;
  const bounded = options.maxCachedSourceBytes !== undefined;

  const sourceState = (descriptor: SessionFileDescriptor) => {
    let sourceBytes = 0;
    const signature = [descriptor.filePath, ...(descriptor.dependencyPaths || [])]
      .map(signaturePath => {
        const resolved = path.resolve(signaturePath);
        try {
          const stat = statSync(resolved);
          sourceBytes += stat.size;
          return sessionFileSignature(resolved, stat);
        } catch {
          return `${resolved}:missing`;
        }
      })
      .join("|");
    return { signature, sourceBytes };
  };
  const changedSource = (filePath: string) => new Error(`Session transcript changed; reload the session: ${filePath}`);
  const requireSignature = (descriptor: SessionFileDescriptor, signature: string) => {
    if (sourceState(descriptor).signature !== signature) throw changedSource(descriptor.filePath);
  };

  const removePayload = (filePath: string) => {
    const cached = payloads.get(filePath);
    if (!cached) return;
    cachedSourceBytes -= cached.sourceBytes;
    payloads.delete(filePath);
  };
  const cachePayload = (entry: Entry, loaded: { records: TRecords; messages: TMessages }) => {
    removePayload(entry.filePath);
    const payload = { records: loaded.records, messages: loaded.messages, signature: entry.signature, sourceBytes: entry.sourceBytes };
    payloads.set(entry.filePath, payload);
    cachedSourceBytes += entry.sourceBytes;
    while (cachedSourceBytes > options.maxCachedSourceBytes! && payloads.size > 1) {
      removePayload(payloads.keys().next().value!);
    }
    return payload;
  };
  const readPayload = (entry: Entry) => {
    if (entriesByPath.get(entry.filePath) !== entry) {
      // A scan may still hold an older immutable snapshot after another
      // lookup refreshes the index. Read its own extent without replacing
      // the current entry's path-keyed payload.
      if (entry.payloadSnapshot) return entry.payloadSnapshot.read();
      throw changedSource(entry.filePath);
    }
    const cached = payloads.get(entry.filePath);
    if (cached) {
      if (cached.signature !== entry.signature) throw changedSource(entry.filePath);
      payloads.delete(entry.filePath);
      payloads.set(entry.filePath, cached);
      return cached;
    }
    // An evicted body has no stale copy to fall back to. Preserve read errors
    // instead of making a previously indexed session appear empty.
    let loaded: SessionFilePayload<TRecords, TMessages>;
    if (entry.payloadSnapshot) {
      loaded = entry.payloadSnapshot.read();
    } else {
      requireSignature(entry, entry.signature);
      loaded = options.readEntry(entry);
      requireSignature(entry, entry.signature);
    }
    return cachePayload(entry, loaded);
  };
  const indexedEntry = (
    descriptor: SessionFileDescriptor,
    signature: string,
    sourceBytes: number,
    loaded: ReturnType<typeof options.readEntry>
  ): Entry => {
    if (!bounded) return { ...descriptor, ...loaded, signature, sourceBytes };
    const entry: Entry = {
      ...descriptor,
      session: loaded.session,
      signature,
      sourceBytes,
      payloadSnapshot: loaded.payloadSnapshot,
      get records() { return readPayload(entry).records; },
      get messages() { return readPayload(entry).messages; }
    };
    cachePayload(entry, loaded);
    return entry;
  };

  const refresh = (force = false, capture?: Capture) => {
    const now = Date.now();
    if (!force && lastRefresh && now - lastRefresh < refreshIntervalMs) return;
    const nextByPath = new Map<string, Entry>();

    for (const descriptor of options.discoverFiles()) {
      const filePath = path.resolve(descriptor.filePath);
      try {
        const { signature, sourceBytes } = sourceState(descriptor);
        const cached = entriesByPath.get(filePath);
        if (cached?.signature === signature) {
          nextByPath.set(filePath, cached);
          if (capture && (String(cached.session.id) === capture.sessionId || cached.sessionId === capture.sessionId)) {
            capture.entry = cached;
            capture.payload = bounded ? payloads.get(filePath) : cached;
          }
          continue;
        }
        const loaded = options.readEntry({ ...descriptor, filePath });
        if (bounded && !loaded.payloadSnapshot) requireSignature(descriptor, signature);
        const entry = indexedEntry(
          { ...descriptor, filePath },
          loaded.payloadSnapshot?.signature ?? signature,
          loaded.payloadSnapshot?.sourceBytes ?? sourceBytes,
          loaded
        );
        nextByPath.set(filePath, entry);
        // Retain only this request's target while later changed files may
        // evict its body from the provider's normal bounded cache.
        if (capture && (String(entry.session.id) === capture.sessionId || entry.sessionId === capture.sessionId)) {
          capture.entry = entry;
          capture.payload = loaded;
        }
      } catch (error) {
        options.onError?.(filePath, error);
        const cached = entriesByPath.get(filePath);
        if (cached && options.retainCachedOnError !== false && (!bounded || payloads.has(filePath))) {
          nextByPath.set(filePath, cached);
        }
      }
    }

    const nextById = new Map<string, Entry>();
    const nextChildren = new Map<string, Entry[]>();
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
    for (const filePath of payloads.keys()) {
      if (!entriesByPath.has(filePath)) removePayload(filePath);
    }
    if (changed) revision++;
    lastRefresh = now;
  };

  const publicEntry = (entry: Entry) => entry as IndexedSessionFile<TSession, TRecords, TMessages>;
  const refreshEvictedEntry = (entry: Entry | undefined) => {
    if (bounded && entry && !payloads.has(entry.filePath)
      && sourceState(entry).signature !== entry.signature) refresh(true);
  };

  return {
    refresh,
    captureSession(sessionId: string) {
      const capture: Capture = { sessionId };
      refresh(true, capture);
      const entry = entriesById.get(sessionId);
      if (!entry) return null;
      const payload = capture.entry === entry && capture.payload
        ? capture.payload : bounded ? readPayload(entry) : entry;
      const canonicalId = String(entry.session.id);
      const parent = entry.session.parentId ? entriesById.get(String(entry.session.parentId)) : undefined;
      return {
        revision,
        entry: publicEntry(entry),
        records: payload.records,
        messages: payload.messages,
        parent: parent && String(parent.session.id) !== canonicalId ? publicEntry(parent) : null,
        children: (childrenByParent.get(canonicalId) || []).map(publicEntry),
        // A held entry can become obsolete after this capture. Read records
        // and messages together from its immutable extent without refreshing.
        readPayload(held: IndexedSessionFile<TSession, TRecords, TMessages>) {
          return bounded ? readPayload(held as Entry) : { records: held.records, messages: held.messages };
        }
      };
    },
    list() {
      refresh();
      return [...entriesByPath.values()].map(publicEntry);
    },
    get(sessionId: string) {
      refresh();
      refreshEvictedEntry(entriesById.get(sessionId));
      const entry = entriesById.get(sessionId);
      return entry ? publicEntry(entry) : null;
    },
    getByFilePath(filePath: string) {
      refresh();
      const resolved = path.resolve(filePath);
      refreshEvictedEntry(entriesByPath.get(resolved));
      const entry = entriesByPath.get(resolved);
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
      const visit = (entry: Entry) => {
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
 * view facets (tree, container, metrics) for the same session
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
    // Construction time must not consume the completed view's reuse window.
    cache = { sessionId, expires: Date.now() + 1000, views };
    return views;
  };
}

/**
 * Create the structured Agent Loop view delegate methods from a pre-cached
 * view getter. Callers use {@link createStructuredViewCache} to wrap
 * their provider-specific builder, then pass the cached getter here.
 *
 */
export function createStructuredViewMethods(
  getViews: (sessionId: string) => Record<string, any> | null
): Pick<ProviderAdapter, "getSessionTree" | "getSessionContainer" | "getSessionMetrics"> {
  return {
    getSessionTree(sessionId: string) { return getViews(sessionId)?.tree || null; },
    getSessionContainer(sessionId: string) { return getViews(sessionId)?.container || null; },
    getSessionMetrics(sessionId: string) { return getViews(sessionId)?.metrics || null; }
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
  limit = 20,
  offset = 0
): SearchResult[] {
  const results: SearchResult[] = [];
  let skipped = 0;
  for (const { match } of iterateNormalizedMessageSearch(entries, query)) {
    if (skipped < offset) { skipped += 1; continue; }
    results.push(match);
    if (results.length >= limit) break;
  }
  return results;
}

export function* iterateNormalizedMessageSearch<TSession extends { id: string }>(
  entries: Iterable<{ session: TSession; messages: Message[] }>,
  query: string
): IterableIterator<{ session: TSession; match: SearchResult }> {
  if (!String(query || "").trim()) return;
  for (const entry of entries) {
    for (const message of entry.messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const content = message.questionAnswers ? questionAnswersText(message.questionAnswers) : message.content;
      if (!matchesSearchQuery(content, query)) continue;
      yield { session: entry.session, match: {
        sessionId: entry.session.id,
        messageId: message.id,
        role: message.role,
        snippet: createSnippet(content, query),
        timestamp: message.timestamp
      } };
    }
  }
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
