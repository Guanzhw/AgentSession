import { createHash } from "node:crypto";
import {
  browseIndexedProjects,
  browseIndexedSessions,
  findIndexedSessionMetadata,
  getIndexedCatalogRevision,
  getIndexedSessionChildren,
  indexProvider as defaultIndexProvider
} from "./index-db.js";
import { normalizeCrossProviderProjectPath } from "./project-filter.js";
import { findSearchDocuments, getSearchIndexRevision, refreshSearchIndex, type SearchDocumentField } from "./search-index.js";
import { getAllProviders, getAvailableProviders } from "./providers/index.js";
import type { Message, MessageRole, ProviderAdapter, ProviderId, RawSession } from "./providers/interface.js";
import { createSnippet, matchesSearchQuery } from "./providers/shared/parser.js";
import { questionAnswersText } from "./providers/shared/question-answers.js";

function providerIds(): ProviderId[] {
  return getAllProviders().map(provider => provider.id);
}
const EVENT_SEGMENTS = ["message", "thinking", "tool"] as const;
const EVENT_STATUSES = ["error", "completed", "unknown"] as const;
const HARD_LIMITS = {
  searchLimit: 100,
  timelineLimit: 200,
  eventMaxChars: 20000,
  contextWindow: 20,
  queryChars: 500,
  previewChars: 240
};
const DEFAULT_CHILD_LIMIT = 50;
const MAX_CHILD_LIMIT = 100;
const SEARCH_FIELDS = ["title", "directory", "user", "assistant", "toolName"] as const;
const DEFAULT_SEARCH_FIELDS = ["title", "directory", "user", "assistant"] as const;
const MAX_TOOL_FACETS = 50;

export type EventSegment = typeof EVENT_SEGMENTS[number];
export type EventStatus = typeof EVENT_STATUSES[number];

export interface SessionRef {
  provider: ProviderId;
  sessionId: string;
}

export interface EventRef extends SessionRef {
  messageId: string;
  segment: EventSegment;
}

export interface SessionHistoryLimits {
  searchLimit: number;
  timelineLimit: number;
  eventMaxChars: number;
  contextWindow: number;
}

export const DEFAULT_SESSION_HISTORY_LIMITS: SessionHistoryLimits = {
  searchLimit: 20,
  timelineLimit: 50,
  eventMaxChars: 4000,
  contextWindow: 5
};

export class SessionHistoryError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SessionHistoryError";
    this.code = code;
  }
}

export interface ProviderDiagnostic {
  provider: ProviderId;
  status: "ok" | "unavailable" | "error";
  durationMs?: number;
  message?: string;
}

export interface ProjectedEvent {
  event: EventRef;
  timestamp: number;
  role: MessageRole;
  toolName: string | null;
  status: EventStatus | null;
  preview: string;
  untrustedContent: true;
}

export interface SessionHistoryDependencies {
  getAvailableProviders?: () => ProviderAdapter[];
  getAllProviders?: () => ProviderAdapter[];
  indexProvider?: (adapter: ProviderAdapter) => Promise<number>;
  findIndexedSessionMetadata?: typeof findIndexedSessionMetadata;
  getIndexedSessionChildren?: typeof getIndexedSessionChildren;
  browseIndexedProjects?: typeof browseIndexedProjects;
  browseIndexedSessions?: typeof browseIndexedSessions;
  getIndexedCatalogRevision?: typeof getIndexedCatalogRevision;
  refreshSearchIndex?: typeof refreshSearchIndex;
  findSearchDocuments?: typeof findSearchDocuments;
  getSearchIndexRevision?: typeof getSearchIndexRevision;
}

export interface SessionHistoryServiceOptions {
  limits?: Partial<SessionHistoryLimits>;
  dependencies?: SessionHistoryDependencies;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asTimestamp(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function boundedText(value: unknown, maxChars: number): string {
  const source = typeof value === "string" ? value : String(value ?? "");
  return source.length > maxChars ? `${source.slice(0, maxChars)}…` : source;
}

function stringifyContent(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolveLimits(input: Partial<SessionHistoryLimits> | undefined): SessionHistoryLimits {
  const result = {} as SessionHistoryLimits;
  for (const field of Object.keys(DEFAULT_SESSION_HISTORY_LIMITS) as (keyof SessionHistoryLimits)[]) {
    const fallback = DEFAULT_SESSION_HISTORY_LIMITS[field];
    const hardMax = HARD_LIMITS[field];
    const value = input?.[field];
    result[field] = Number.isInteger(value) && Number(value) > 0
      ? Math.min(Number(value), hardMax)
      : fallback;
  }
  return result;
}

function assertSessionRef(value: unknown): SessionRef {
  const candidate = asObject(value);
  const provider = candidate?.provider;
  const sessionId = asNonEmptyString(candidate?.sessionId);
  if (!providerIds().includes(provider as ProviderId) || !sessionId) {
    throw new SessionHistoryError("invalid_session_ref", "session must contain a registered provider and a non-empty canonical sessionId.");
  }
  return { provider: provider as ProviderId, sessionId };
}

function assertEventRef(value: unknown): EventRef {
  const ref = assertSessionRef(value);
  const candidate = asObject(value);
  const messageId = asNonEmptyString(candidate?.messageId);
  const segment = candidate?.segment;
  if (!messageId || !EVENT_SEGMENTS.includes(segment as EventSegment)) {
    throw new SessionHistoryError("invalid_event_ref", "event must contain a messageId and a supported segment.");
  }
  return { ...ref, messageId, segment: segment as EventSegment };
}

function assertStringArray(value: unknown, field: string, allowed: readonly string[] | undefined = undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new SessionHistoryError("invalid_input", `${field} must be an array of non-empty strings.`);
  }
  const unique = [...new Set(value)];
  if (allowed && unique.some((entry) => !allowed.includes(entry))) {
    throw new SessionHistoryError("invalid_input", `${field} contains an unsupported value.`);
  }
  return unique;
}

function resolveLimit(value: unknown, fallback: number, hardMax: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new SessionHistoryError("invalid_input", `${field} must be a positive integer.`);
  }
  return Math.min(Number(value), hardMax);
}

function resolveNonNegative(value: unknown, fallback: number, hardMax: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new SessionHistoryError("invalid_input", `${field} must be a non-negative integer.`);
  }
  return Math.min(Number(value), hardMax);
}

function resolveTime(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SessionHistoryError("invalid_input", `${field} must be a finite Unix-millisecond timestamp.`);
  }
  return value;
}

function optionalQuery(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const query = asNonEmptyString(value)?.trim();
  if (!query || query.length > HARD_LIMITS.queryChars) {
    throw new SessionHistoryError("invalid_input", `${field} must contain between 1 and ${HARD_LIMITS.queryChars} characters.`);
  }
  return query;
}

function eventStatus(message: Message): EventStatus {
  const status = asObject(message.metadata)?.status;
  if (status === "error") return "error";
  if (status === "completed") return "completed";
  return "unknown";
}

function normalizedRole(value: unknown): MessageRole {
  return ["user", "assistant", "system", "tool"].includes(String(value))
    ? value as MessageRole
    : "assistant";
}

function isToolMessage(message: Message): boolean {
  return normalizedRole(message.role) === "tool" || Boolean(asNonEmptyString(message.toolName));
}

function projectEvents(ref: SessionRef, messages: Message[]): Array<ProjectedEvent & { sourceIndex: number }> {
  const events: Array<ProjectedEvent & { sourceIndex: number }> = [];
  for (let sourceIndex = 0; sourceIndex < messages.length; sourceIndex += 1) {
    const message = messages[sourceIndex];
    const messageId = asNonEmptyString(message?.id);
    if (!messageId) continue;
    const role = normalizedRole(message.role);
    const timestamp = asTimestamp(message.timestamp);
    if (!isToolMessage(message)) {
      const messagePreview = boundedText(message.content, HARD_LIMITS.previewChars);
      if (messagePreview.trim()) {
        events.push({
          event: { ...ref, messageId, segment: "message" },
          timestamp,
          role,
          toolName: null,
          status: null,
          preview: messagePreview,
          untrustedContent: true,
          sourceIndex
        });
      }
    }
    if (typeof message.thinking === "string" && message.thinking) {
      events.push({
        event: { ...ref, messageId, segment: "thinking" },
        timestamp,
        role,
        toolName: null,
        status: null,
        preview: boundedText(message.thinking, HARD_LIMITS.previewChars),
        untrustedContent: true,
        sourceIndex
      });
    }
    if (isToolMessage(message)) {
      const toolName = asNonEmptyString(message.toolName) || "tool";
      const status = eventStatus(message);
      events.push({
        event: { ...ref, messageId, segment: "tool" },
        timestamp,
        role,
        toolName,
        status,
        preview: `${toolName} (${status})`,
        untrustedContent: true,
        sourceIndex
      });
    }
  }
  return events.sort((left, right) => left.timestamp - right.timestamp || left.sourceIndex - right.sourceIndex || left.event.segment.localeCompare(right.event.segment));
}

function eventKey(event: EventRef): string {
  return `${event.provider}\u0000${event.sessionId}\u0000${event.messageId}\u0000${event.segment}`;
}

function cursorFingerprint(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function encodeCursor(offset: number, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ version: 1, offset, fingerprint }), "utf8").toString("base64url");
}

function decodeCursor(cursor: unknown, fingerprint: string): number {
  if (typeof cursor !== "string" || !cursor) {
    throw new SessionHistoryError("invalid_cursor", "cursor must be an opaque cursor returned by this request.");
  }
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (payload?.version !== 1 || !Number.isInteger(payload.offset) || payload.offset < 0 || payload.fingerprint !== fingerprint) {
      throw new Error("mismatch");
    }
    return payload.offset;
  } catch {
    throw new SessionHistoryError("invalid_cursor", "cursor is invalid for this request.");
  }
}

interface SearchPosition { rank: number; updatedAt: number; key: string }

function encodeSearchCursor(after: SearchPosition, fingerprint: string, snapshotUpdatedBefore: number): string {
  return Buffer.from(JSON.stringify({
    version: 3,
    after: { rank: after.rank, updatedAt: after.updatedAt, key: after.key },
    fingerprint,
    snapshotUpdatedBefore
  }), "utf8").toString("base64url");
}

function decodeSearchCursor(cursor: unknown, fingerprint: string): { after: SearchPosition; snapshotUpdatedBefore: number } {
  if (typeof cursor !== "string" || !cursor) {
    throw new SessionHistoryError("invalid_cursor", "cursor must be an opaque cursor returned by session_search.");
  }
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (payload?.version !== 3 || !Number.isInteger(payload.after?.rank) || payload.after.rank < 0 || payload.after.rank > 3
      || typeof payload.after?.updatedAt !== "number" || !Number.isFinite(payload.after.updatedAt)
      || typeof payload.after?.key !== "string" || !payload.after.key
      || typeof payload.snapshotUpdatedBefore !== "number" || !Number.isFinite(payload.snapshotUpdatedBefore)
      || payload.fingerprint !== fingerprint) {
      throw new Error("mismatch");
    }
    return { after: payload.after, snapshotUpdatedBefore: payload.snapshotUpdatedBefore };
  } catch {
    throw new SessionHistoryError("invalid_cursor", "cursor is invalid for this search request.");
  }
}

interface SearchCandidate extends SearchPosition { value: Record<string, unknown> }

function compareSearchCandidates(left: SearchPosition, right: SearchPosition): number {
  return left.rank - right.rank || right.updatedAt - left.updatedAt || left.key.localeCompare(right.key);
}

function pageText(value: unknown, offset: number, maxChars: number) {
  const text = stringifyContent(value);
  const safeOffset = Math.min(offset, text.length);
  const end = Math.min(text.length, safeOffset + maxChars);
  return {
    text: text.slice(safeOffset, end),
    offset: safeOffset,
    nextOffset: end < text.length ? end : null,
    totalChars: text.length,
    truncated: end < text.length,
    untrustedContent: true as const
  };
}

function eventContinuation(
  event: EventRef,
  page: ReturnType<typeof pageText>,
  maxChars: number,
  optIn: Record<string, boolean> = {}
) {
  return page.nextOffset === null
    ? null
    : {
        event,
        ...optIn,
        offset: page.nextOffset,
        maxChars
      };
}

function sessionSummary(provider: ProviderId, session: RawSession | Record<string, unknown>) {
  const raw = session as Record<string, unknown>;
  const sessionId = asNonEmptyString(raw.id) || "";
  return {
    session: { provider, sessionId },
    title: asNonEmptyString(raw.title) || sessionId,
    directory: asNonEmptyString(raw.directory),
    createdAt: asTimestamp(raw.timeCreated ?? raw.time_created),
    updatedAt: asTimestamp(raw.timeUpdated ?? raw.time_updated),
    messageCount: asTimestamp(raw.messageCount ?? raw.message_count),
    tokenCount: raw.tokenCount ?? raw.token_count ?? null,
    parent: asNonEmptyString(raw.parentId ?? raw.parent_id)
      ? { provider, sessionId: String(raw.parentId ?? raw.parent_id) }
      : null
  };
}

function isWithinRange(updatedAt: number, updatedAfter: number | undefined, updatedBefore: number | undefined) {
  return (updatedAfter === undefined || updatedAt >= updatedAfter)
    && (updatedBefore === undefined || updatedAt <= updatedBefore);
}

export function createSessionHistoryService(options: SessionHistoryServiceOptions = {}) {
  const dependencies = options.dependencies || {};
  const limits = resolveLimits(options.limits);
  const providers = dependencies.getAvailableProviders || getAvailableProviders;
  const allProviders = dependencies.getAllProviders || getAllProviders;
  const refreshProviderIndex = dependencies.indexProvider || defaultIndexProvider;
  const findIndexed = dependencies.findIndexedSessionMetadata || findIndexedSessionMetadata;
  const indexedChildren = dependencies.getIndexedSessionChildren || getIndexedSessionChildren;
  const browseSessions = dependencies.browseIndexedSessions || browseIndexedSessions;
  const browseProjects = dependencies.browseIndexedProjects || browseIndexedProjects;
  const catalogRevision = dependencies.getIndexedCatalogRevision || getIndexedCatalogRevision;
  const updateSearchIndex = dependencies.refreshSearchIndex || refreshSearchIndex;
  const searchDocuments = dependencies.findSearchDocuments || findSearchDocuments;
  const contentIndexRevision = dependencies.getSearchIndexRevision || getSearchIndexRevision;

  function availableProviderMap() {
    return new Map(providers().map((provider) => [provider.id, provider]));
  }

  function resolveProvider(ref: SessionRef): ProviderAdapter {
    const all = new Map(allProviders().map((provider) => [provider.id, provider]));
    if (!all.has(ref.provider)) {
      throw new SessionHistoryError("provider_unavailable", `Provider ${ref.provider} is not registered.`);
    }
    const available = availableProviderMap().get(ref.provider);
    if (!available) {
      throw new SessionHistoryError("provider_unavailable", `Provider ${ref.provider} is not available on this machine.`);
    }
    return available;
  }

  function getProviderSession(ref: SessionRef) {
    // Provider local storage is authoritative: Viewer hidden/excluded metadata
    // is never an access filter for session history.
    const provider = resolveProvider(ref);
    let session: RawSession | Record<string, unknown> | null;
    try {
      session = provider.getSession(ref.sessionId);
    } catch (error: any) {
      throw new SessionHistoryError("provider_error", `Could not read ${ref.provider} session: ${error?.message || String(error)}`);
    }
    if (!session || asNonEmptyString((session as Record<string, unknown>).id) !== ref.sessionId) {
      throw new SessionHistoryError("session_not_found", "No provider-stored session matches this reference.");
    }
    return { provider, session };
  }

  function getProviderMessages(ref: SessionRef) {
    const { provider } = getProviderSession(ref);
    try {
      return provider.getMessages(ref.sessionId) || [];
    } catch (error: any) {
      throw new SessionHistoryError("provider_error", `Could not read ${ref.provider} messages: ${error?.message || String(error)}`);
    }
  }

  return {
    limits,

    async refreshIndex() {
      const diagnostics: ProviderDiagnostic[] = [];
      for (const provider of providers()) {
        const startedAt = Date.now();
        try {
          await refreshProviderIndex(provider);
          diagnostics.push({ provider: provider.id, status: "ok", durationMs: Date.now() - startedAt });
        } catch (error: any) {
          diagnostics.push({
            provider: provider.id,
            status: "error",
            durationMs: Date.now() - startedAt,
            message: error?.message || String(error)
          });
        }
      }
      return diagnostics;
    },

    browse(input: Record<string, unknown>) {
      const level = input?.level;
      if (level !== "providers" && level !== "projects" && level !== "sessions") {
        throw new SessionHistoryError("invalid_input", "level must be providers, projects, or sessions.");
      }
      const unsupportedFields = level === "providers"
        ? ["directory", "title", "updatedAfter", "updatedBefore", "parent", "cursor", "limit"]
        : level === "projects" ? ["title", "parent"] : [];
      for (const field of unsupportedFields) {
        if (input[field] !== undefined) {
          throw new SessionHistoryError("invalid_input", `${field} is not supported at the ${level} level.`);
        }
      }
      const selectedIds = assertStringArray(input?.providers, "providers", providerIds()) as ProviderId[] | undefined
        || [...new Set(allProviders().map((provider) => provider.id))];
      const available = availableProviderMap();
      const diagnostics: ProviderDiagnostic[] = selectedIds.map((provider) => ({
        provider, status: available.has(provider) ? "ok" : "unavailable"
      }));
      const availableIds = selectedIds.filter((provider) => available.has(provider));
      const updatedAfter = resolveTime(input?.updatedAfter, "updatedAfter");
      const updatedBefore = resolveTime(input?.updatedBefore, "updatedBefore");
      if (updatedAfter !== undefined && updatedBefore !== undefined && updatedAfter > updatedBefore) {
        throw new SessionHistoryError("invalid_input", "updatedAfter must not be later than updatedBefore.");
      }
      const requestedDirectory = input?.directory;
      if (requestedDirectory !== undefined && (typeof requestedDirectory !== "string"
        || requestedDirectory !== "" && !requestedDirectory.trim())) {
        throw new SessionHistoryError("invalid_input", "directory must be a recorded project path or an empty string for an unrecorded directory.");
      }
      const directory = requestedDirectory === undefined ? undefined : normalizeCrossProviderProjectPath(requestedDirectory);
      const title = optionalQuery(input?.title, "title");
      const parent = input?.parent === undefined ? undefined : input.parent === null ? null : assertSessionRef(input.parent);
      const limit = resolveLimit(input?.limit, limits.searchLimit, HARD_LIMITS.searchLimit, "limit");
      const indexRevision = level === "providers" ? undefined : catalogRevision();
      const fingerprint = createHash("sha256").update(cursorFingerprint({
        level, providers: selectedIds, availableProviders: availableIds, directory, title, updatedAfter, updatedBefore, parent,
        ...(indexRevision === undefined ? {} : { indexRevision })
      })).digest("base64url");
      const offset = input?.cursor === undefined ? 0 : decodeCursor(input.cursor, fingerprint);
      if (level === "providers") {
        return {
          level,
          providers: selectedIds.map((provider) => ({ provider, available: available.has(provider) })),
          diagnostics, nextCursor: null, truncated: false, untrustedContent: true
        };
      }
      if (level === "projects") {
        const projects = browseProjects({ providers: availableIds, directory, updatedAfter, updatedBefore, limit: limit + 1, offset });
        if (catalogRevision() !== indexRevision) throw new SessionHistoryError("index_changed", "The session index changed; restart this browse.");
        const page = projects.slice(0, limit);
        const truncated = projects.length > limit;
        return {
          level, projects: page, diagnostics,
          nextCursor: truncated ? encodeCursor(offset + limit, fingerprint) : null,
          truncated, untrustedContent: true
        };
      }
      const candidates = browseSessions({ providers: availableIds, directory, title, updatedAfter, updatedBefore, parent, limit: limit + 1, offset });
      if (catalogRevision() !== indexRevision) throw new SessionHistoryError("index_changed", "The session index changed; restart this browse.");
      const sessions = candidates.slice(0, limit).flatMap((row) => {
        const provider = available.get(row.provider as ProviderId)!;
        let source: RawSession | Record<string, unknown> | null;
        try {
          source = provider.getSession(row.id);
        } catch (error: any) {
          const diagnostic = diagnostics.find((entry) => entry.provider === provider.id)!;
          diagnostic.status = "error";
          diagnostic.message = error?.message || String(error);
          return [];
        }
        if (!source || source.id !== row.id) return [];
        const summary = sessionSummary(provider.id, source);
        if (!isWithinRange(summary.updatedAt, updatedAfter, updatedBefore)) return [];
        if (directory !== undefined && normalizeCrossProviderProjectPath(summary.directory) !== directory) return [];
        if (title !== undefined && !matchesSearchQuery(summary.title, title)) return [];
        if (parent === null && summary.parent !== null) return [];
        if (parent && (provider.id !== parent.provider || summary.parent?.sessionId !== parent.sessionId)) return [];
        return [summary];
      });
      const truncated = candidates.length > limit;
      return {
        level, sessions, diagnostics,
        nextCursor: truncated ? encodeCursor(offset + limit, fingerprint) : null,
        truncated, untrustedContent: true
      };
    },

    search(input: Record<string, unknown>) {
      const query = asNonEmptyString(input?.query)?.trim();
      if (!query || query.length > HARD_LIMITS.queryChars) {
        throw new SessionHistoryError("invalid_input", `query must contain between 1 and ${HARD_LIMITS.queryChars} characters.`);
      }
      const requestedProviders = assertStringArray(input?.providers, "providers", providerIds()) as ProviderId[] | undefined;
      const requestedFields = assertStringArray(input?.fields, "fields", SEARCH_FIELDS);
      const fields = requestedFields || [...DEFAULT_SEARCH_FIELDS];
      const lineage = input?.lineage ?? "all";
      if (lineage !== "all" && lineage !== "roots" && lineage !== "children") {
        throw new SessionHistoryError("invalid_input", "lineage must be all, roots, or children.");
      }
      const updatedAfter = resolveTime(input?.updatedAfter, "updatedAfter");
      const requestedUpdatedBefore = resolveTime(input?.updatedBefore, "updatedBefore");
      const requestedDirectory = input?.directory === undefined ? undefined : asNonEmptyString(input.directory)?.trim();
      if (input?.directory !== undefined && !requestedDirectory) {
        throw new SessionHistoryError("invalid_input", "directory must be a non-empty recorded project path.");
      }
      const directory = requestedDirectory ? normalizeCrossProviderProjectPath(requestedDirectory) : undefined;
      if (updatedAfter !== undefined && requestedUpdatedBefore !== undefined && updatedAfter > requestedUpdatedBefore) {
        throw new SessionHistoryError("invalid_input", "updatedAfter must not be later than updatedBefore.");
      }
      const limit = resolveLimit(input?.limit, limits.searchLimit, limits.searchLimit, "limit");
      const available = availableProviderMap();
      const selectedIds = requestedProviders
        || [...new Set(allProviders().map((provider) => provider.id))];
      const contentFields = fields.filter((field): field is SearchDocumentField => (
        field === "user" || field === "assistant" || field === "toolName"
      ));
      const preparationErrors = new Map<ProviderId, string>();
      const preparationDurations = new Map<ProviderId, number>();
      const indexedProviders = new Set<ProviderId>();
      if (contentFields.length) {
        for (const providerId of selectedIds) {
          const provider = available.get(providerId);
          if (!provider) continue;
          if (!provider.getSearchIndexSources) {
            if (contentFields.includes("toolName")) preparationErrors.set(providerId, "Tool-name search is unavailable for this provider.");
            continue;
          }
          const startedAt = Date.now();
          try {
            updateSearchIndex(provider);
            indexedProviders.add(providerId);
          } catch (error: any) {
            preparationErrors.set(providerId, error?.message || String(error));
          } finally {
            preparationDurations.set(providerId, Date.now() - startedAt);
          }
        }
      }
      const revision = () => `${catalogRevision()}${indexedProviders.size ? `:${contentIndexRevision()}` : ""}`;
      const indexRevision = revision();
      const fingerprint = createHash("sha256").update(cursorFingerprint({
        query, providers: selectedIds, availableProviders: selectedIds.filter((id) => available.has(id)),
        updatedAfter, updatedBefore: requestedUpdatedBefore, directory,
        indexRevision,
        ...(requestedFields !== undefined ? { fields } : {}),
        ...(input?.lineage !== undefined ? { lineage } : {})
      })).digest("base64url");
      const cursorPage = input?.cursor === undefined ? null : decodeSearchCursor(input.cursor, fingerprint);
      const updatedBefore = cursorPage?.snapshotUpdatedBefore ?? requestedUpdatedBefore ?? Date.now();
      const diagnostics: ProviderDiagnostic[] = [];
      const pageCapacity = limit + 1;
      const results = new Map<string, SearchCandidate>();

      const retain = (pool: Map<string, SearchCandidate>, candidate: SearchCandidate) => {
        if (cursorPage && compareSearchCandidates(candidate, cursorPage.after) <= 0) return;
        const existing = pool.get(candidate.key);
        if (existing && compareSearchCandidates(existing, candidate) <= 0) return;
        pool.set(candidate.key, candidate);
        if (pool.size > pageCapacity) {
          const worst = [...pool.values()].sort(compareSearchCandidates).at(-1);
          if (worst) pool.delete(worst.key);
        }
      };

      for (const providerId of selectedIds) {
        const provider = available.get(providerId);
        if (!provider) {
          diagnostics.push({ provider: providerId, status: "unavailable" });
          continue;
        }
        if (preparationErrors.has(providerId)) {
          diagnostics.push({ provider: providerId, status: "error", durationMs: preparationDurations.get(providerId),
            message: preparationErrors.get(providerId) });
          continue;
        }
        const startedAt = Date.now();
        const perProviderLimit = HARD_LIMITS.searchLimit;
        const providerResults = new Map<string, SearchCandidate>();
        const sessionCache = new Map<string, RawSession | Record<string, unknown> | null>();
        const cachedSession = (sessionId: string) => {
          if (sessionCache.has(sessionId)) return sessionCache.get(sessionId);
          const session = provider.getSession(sessionId);
          sessionCache.set(sessionId, session);
          if (sessionCache.size > 256) sessionCache.delete(sessionCache.keys().next().value!);
          return session;
        };
        try {
          const add = (session: RawSession | Record<string, unknown>, field: "title" | "directory" | "message" | "toolName", snippet: string,
            messageId: string | null = null, matchRole: MessageRole | null = null) => {
            const summary = sessionSummary(providerId, session);
            if (!summary.session.sessionId || !isWithinRange(summary.updatedAt, updatedAfter, updatedBefore)) return;
            if (directory && normalizeCrossProviderProjectPath(summary.directory) !== directory) return;
            if (lineage === "roots" && summary.parent || lineage === "children" && !summary.parent) return;
            const bestField = (field === "message" || field === "toolName") && fields.includes("title") && matchesSearchQuery(summary.title, query) ? "title"
              : (field === "message" || field === "toolName") && fields.includes("directory") && matchesSearchQuery(summary.directory, query) ? "directory" : field;
            if (bestField !== field) {
              snippet = bestField === "title" ? summary.title : summary.directory || "";
              messageId = null;
              matchRole = null;
            }
            const rank = bestField === "title" ? 0 : bestField === "directory" ? 1 : bestField === "message" ? 2 : 3;
            const key = `${providerId}\u0000${summary.session.sessionId}`;
            const value = {
              session: summary.session,
              event: messageId ? { ...summary.session, messageId, segment: bestField === "toolName" ? "tool" : "message" } : null,
              matchField: bestField,
              matchRole,
              snippet: boundedText(snippet, HARD_LIMITS.previewChars),
              title: summary.title,
              directory: summary.directory,
              updatedAt: summary.updatedAt,
              untrustedContent: true
            };
            retain(providerResults, { key, rank, updatedAt: summary.updatedAt, value });
          };

          for (let metadataOffset = 0; fields.includes("title") || fields.includes("directory"); metadataOffset += perProviderLimit) {
            const metadataMatches = findIndexed(providerId, query, perProviderLimit, updatedAfter, updatedBefore, metadataOffset,
              fields.filter((field): field is "title" | "directory" => field === "title" || field === "directory"));
            for (const indexed of metadataMatches) {
              const row = indexed as Record<string, unknown>;
              const sessionId = asNonEmptyString(row.id);
              const session = sessionId ? cachedSession(sessionId) : null;
              if (!session) continue;
              const title = String(session.title || "");
              const recordedDirectory = String(session.directory || "");
              if (fields.includes("title") && matchesSearchQuery(title, query)) add(session, "title", title);
              else if (fields.includes("directory") && matchesSearchQuery(recordedDirectory, query)) add(session, "directory", recordedDirectory);
            }
            if (metadataMatches.length < perProviderLimit) break;
          }

          const searchMessages = fields.includes("user") || fields.includes("assistant");
          if (contentFields.length && provider.getSearchIndexSources) {
            for (const match of searchDocuments(providerId, query, contentFields)) {
              add({
                id: match.sessionId, provider: providerId, parentId: match.parentId,
                title: match.title, directory: match.directory,
                timeCreated: match.createdAt, timeUpdated: match.updatedAt,
                messageCount: match.messageCount, tokenCount: match.tokenCount
              }, match.field === "toolName" ? "toolName" : "message", createSnippet(match.text, query),
              match.messageId, normalizedRole(match.role));
            }
          } else if (searchMessages && provider.iterateSearchMessages) {
            for (const { session, match } of provider.iterateSearchMessages(query)) {
              if (!fields.includes(match.role)) continue;
              add(session, "message", String(match.snippet || ""), asNonEmptyString(match.messageId), match.role);
            }
          } else if (searchMessages) {
            for (let messageOffset = 0;; messageOffset += perProviderLimit) {
              const messageMatches = provider.searchMessages(query, perProviderLimit, messageOffset);
              for (const match of messageMatches) {
                if (!match?.sessionId) continue;
                if (!fields.includes(match.role)) continue;
                const session = cachedSession(match.sessionId);
                if (session) add(session, "message", String(match.snippet || ""), asNonEmptyString(match.messageId), match.role);
              }
              if (messageMatches.length < perProviderLimit) break;
            }
          }
          for (const candidate of providerResults.values()) retain(results, candidate);
          diagnostics.push({ provider: providerId, status: "ok", durationMs: Date.now() - startedAt + (preparationDurations.get(providerId) || 0) });
        } catch (error: any) {
          diagnostics.push({
            provider: providerId,
            status: "error",
            durationMs: Date.now() - startedAt + (preparationDurations.get(providerId) || 0),
            message: error?.message || String(error)
          });
        }
      }

      if (revision() !== indexRevision) {
        throw new SessionHistoryError("index_changed", "The session index changed; restart this search.");
      }
      const sortedMatches = [...results.values()]
        .sort(compareSearchCandidates);
      const page = sortedMatches.slice(0, limit);
      const matches = page.map((entry) => entry.value);
      const nextCursor = sortedMatches.length > limit && page.length
        ? encodeSearchCursor(page.at(-1)!, fingerprint, updatedBefore)
        : null;
      return {
        matches,
        diagnostics,
        nextCursor,
        snapshotUpdatedBefore: updatedBefore,
        truncated: nextCursor !== null,
        untrustedContent: true
      };
    },

    get(input: Record<string, unknown>) {
      const ref = assertSessionRef(input?.session);
      const childLimit = resolveLimit(input?.childLimit, DEFAULT_CHILD_LIMIT, MAX_CHILD_LIMIT, "childLimit");
      const childFingerprint = cursorFingerprint({ session: ref });
      const childOffset = input?.childCursor === undefined ? 0 : decodeCursor(input.childCursor, childFingerprint);
      const { provider, session } = getProviderSession(ref);
      const messages = getProviderMessages(ref);
      const indexedPage = indexedChildren(ref.provider, ref.sessionId, childLimit + 1, childOffset);
      const children = indexedPage.slice(0, childLimit)
        .flatMap((row: any) => {
          let child: RawSession | Record<string, unknown> | null;
          try {
            child = provider.getSession(row.id);
          } catch (error: any) {
            throw new SessionHistoryError("provider_error", `Could not read ${ref.provider} child session: ${error?.message || String(error)}`);
          }
          if (!child) return [];
          const source = child as Record<string, unknown>;
          if (source.id !== row.id || (source.parentId ?? source.parent_id) !== ref.sessionId) return [];
          return [sessionSummary(ref.provider, child)];
        });
      const childrenNextCursor = indexedPage.length > childLimit
        ? encodeCursor(childOffset + childLimit, childFingerprint)
        : null;
      const messageEvents = projectEvents(ref, messages)
        .filter((event) => event.event.segment === "message" && event.preview.trim())
        .map(({ sourceIndex: _sourceIndex, ...event }) => event);
      const roleCounts: Record<MessageRole, number> = { user: 0, assistant: 0, system: 0, tool: 0 };
      const toolCounts = new Map<string, number>();
      for (const message of messages) {
        roleCounts[normalizedRole(message.role)] += 1;
        if (isToolMessage(message)) {
          const toolName = asNonEmptyString(message.toolName) || "tool";
          toolCounts.set(toolName, (toolCounts.get(toolName) || 0) + 1);
        }
      }
      const toolNames = [...toolCounts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, MAX_TOOL_FACETS).map(([toolName, count]) => ({ toolName, count }));
      return {
        ...sessionSummary(ref.provider, session),
        messageCount: messages.length,
        firstMessage: messageEvents[0] || null,
        lastMessage: messageEvents.at(-1) || null,
        roleCounts,
        toolNames,
        toolNamesTruncated: toolCounts.size > MAX_TOOL_FACETS,
        children,
        childrenNextCursor,
        childrenTruncated: childrenNextCursor !== null,
        untrustedContent: true
      };
    },

    timeline(input: Record<string, unknown>) {
      const ref = assertSessionRef(input?.session);
      const requestedSegments = assertStringArray(input?.segments, "segments", EVENT_SEGMENTS) as EventSegment[] | undefined;
      const requestedRoles = assertStringArray(input?.roles, "roles", ["user", "assistant", "system", "tool"]) as MessageRole[] | undefined;
      const toolNames = assertStringArray(input?.toolNames, "toolNames");
      const statuses = assertStringArray(input?.statuses, "statuses", EVENT_STATUSES) as EventStatus[] | undefined;
      const query = optionalQuery(input?.query, "query");
      const limit = resolveLimit(input?.limit, limits.timelineLimit, limits.timelineLimit, "limit");
      const segments = requestedSegments || ["message", "tool"];
      const messages = getProviderMessages(ref);
      const filters = { session: ref, segments, roles: requestedRoles || [], toolNames: toolNames || [], statuses: statuses || [], query };
      const fingerprint = cursorFingerprint(filters as unknown as Record<string, unknown>);
      const offset = input?.cursor === undefined ? 0 : decodeCursor(input.cursor, fingerprint);
      const events = projectEvents(ref, messages)
        .filter((event) => segments.includes(event.event.segment))
        .filter((event) => !requestedRoles || requestedRoles.includes(event.role))
        .filter((event) => !toolNames || (event.toolName !== null && toolNames.includes(event.toolName)))
        .filter((event) => !statuses || (event.status !== null && statuses.includes(event.status)))
        .flatMap((event) => {
          if (query === undefined) return [event];
          const message = messages[event.sourceIndex];
          const text = event.event.segment === "tool" ? event.toolName
            : event.event.segment === "thinking" ? message.thinking
            : message.questionAnswers ? questionAnswersText(message.questionAnswers) : message.content;
          if (!matchesSearchQuery(text, query)) return [];
          return [{ ...event, preview: event.event.segment === "tool" ? event.preview : createSnippet(text, query) }];
        });
      const page = events.slice(offset, offset + limit).map(({ sourceIndex: _sourceIndex, ...event }) => event);
      const nextOffset = offset + page.length;
      return {
        events: page,
        nextCursor: nextOffset < events.length ? encodeCursor(nextOffset, fingerprint) : null,
        truncated: nextOffset < events.length,
        untrustedContent: true
      };
    },

    getContext(input: Record<string, unknown>) {
      const target = assertEventRef(input?.event);
      const includeThinking = input?.includeThinking === true;
      if (target.segment === "thinking" && !includeThinking) {
        throw new SessionHistoryError("thinking_opt_in_required", "Set includeThinking to true before reading a thinking event.");
      }
      const before = resolveNonNegative(input?.before, limits.contextWindow, limits.contextWindow, "before");
      const after = resolveNonNegative(input?.after, limits.contextWindow, limits.contextWindow, "after");
      const messages = getProviderMessages(target);
      const events = projectEvents(target, messages)
        .filter((event) => includeThinking || event.event.segment !== "thinking");
      const targetIndex = events.findIndex((event) => eventKey(event.event) === eventKey(target));
      if (targetIndex < 0) {
        throw new SessionHistoryError("event_not_found", "No session event matches this reference.");
      }
      return {
        target,
        events: events.slice(Math.max(0, targetIndex - before), targetIndex + after + 1)
          .map(({ sourceIndex: _sourceIndex, ...event }) => event),
        untrustedContent: true
      };
    },

    getEvent(input: Record<string, unknown>) {
      const target = assertEventRef(input?.event);
      const includeThinking = input?.includeThinking === true;
      const includeToolInput = input?.includeToolInput === true;
      const includeToolOutput = input?.includeToolOutput === true;
      const offset = resolveNonNegative(input?.offset, 0, Number.MAX_SAFE_INTEGER, "offset");
      const maxChars = resolveLimit(input?.maxChars, limits.eventMaxChars, limits.eventMaxChars, "maxChars");
      const messages = getProviderMessages(target);
      const message = messages.find((candidate) => candidate.id === target.messageId);
      if (!message || !projectEvents(target, [message]).some((event) => eventKey(event.event) === eventKey(target))) {
        throw new SessionHistoryError("event_not_found", "No session event matches this reference.");
      }
      const base = {
        event: target,
        role: normalizedRole(message.role),
        timestamp: asTimestamp(message.timestamp),
        untrustedContent: true as const
      };
      if (target.segment === "message") {
        const content = pageText(message.content, offset, maxChars);
        return {
          ...base,
          content,
          continuation: eventContinuation(target, content, maxChars)
        };
      }
      if (target.segment === "thinking") {
        if (!includeThinking) {
          throw new SessionHistoryError("thinking_opt_in_required", "Set includeThinking to true before reading a thinking event.");
        }
        const content = pageText(message.thinking, offset, maxChars);
        return {
          ...base,
          content,
          continuation: eventContinuation(target, content, maxChars, { includeThinking: true })
        };
      }
      const toolInput = includeToolInput ? pageText(message.toolInput, offset, maxChars) : null;
      const toolOutput = includeToolOutput ? pageText(message.toolOutput, offset, maxChars) : null;
      return {
        ...base,
        toolName: asNonEmptyString(message.toolName) || "tool",
        status: eventStatus(message),
        toolInput,
        toolOutput,
        continuations: {
          toolInput: toolInput
            ? eventContinuation(target, toolInput, maxChars, { includeToolInput: true })
            : null,
          toolOutput: toolOutput
            ? eventContinuation(target, toolOutput, maxChars, { includeToolOutput: true })
            : null
        }
      };
    }
  };
}

export type SessionHistoryService = ReturnType<typeof createSessionHistoryService>;
