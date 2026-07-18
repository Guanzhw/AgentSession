import {
  findIndexedSessionMetadata,
  getIndexedSessionChildren,
  indexProvider as defaultIndexProvider
} from "./index-db.js";
import { getExcludedIds as defaultGetExcludedIds } from "./meta.js";
import { normalizeCrossProviderProjectPath } from "./project-filter.js";
import { getAllProviders, getAvailableProviders } from "./providers/index.js";
import type { Message, MessageRole, ProviderAdapter, ProviderId, RawSession } from "./providers/interface.js";
import { matchesSearchQuery } from "./providers/shared/parser.js";

const PROVIDER_IDS: ProviderId[] = ["opencode", "claude-code", "codex", "gemini"];
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
  getExcludedIds?: (provider: ProviderId) => Set<string>;
  indexProvider?: (adapter: ProviderAdapter) => Promise<number>;
  findIndexedSessionMetadata?: typeof findIndexedSessionMetadata;
  getIndexedSessionChildren?: typeof getIndexedSessionChildren;
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
  if (!PROVIDER_IDS.includes(provider as ProviderId) || !sessionId) {
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
      events.push({
        event: { ...ref, messageId, segment: "message" },
        timestamp,
        role,
        toolName: null,
        status: null,
        preview: boundedText(message.content, HARD_LIMITS.previewChars),
        untrustedContent: true,
        sourceIndex
      });
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

function encodeSearchCursor(offset: number, fingerprint: string, snapshotUpdatedBefore: number): string {
  return Buffer.from(JSON.stringify({ version: 1, offset, fingerprint, snapshotUpdatedBefore }), "utf8").toString("base64url");
}

function decodeSearchCursor(cursor: unknown, fingerprint: string): { offset: number; snapshotUpdatedBefore: number } {
  if (typeof cursor !== "string" || !cursor) {
    throw new SessionHistoryError("invalid_cursor", "cursor must be an opaque cursor returned by session_search.");
  }
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (payload?.version !== 1 || !Number.isInteger(payload.offset) || payload.offset < 0
      || typeof payload.snapshotUpdatedBefore !== "number" || !Number.isFinite(payload.snapshotUpdatedBefore)
      || payload.fingerprint !== fingerprint) {
      throw new Error("mismatch");
    }
    return { offset: payload.offset, snapshotUpdatedBefore: payload.snapshotUpdatedBefore };
  } catch {
    throw new SessionHistoryError("invalid_cursor", "cursor is invalid for this search request.");
  }
}

function pageText(value: unknown, offset: number, maxChars: number) {
  const text = stringifyContent(value);
  const safeOffset = Math.min(offset, text.length);
  const end = Math.min(text.length, safeOffset + maxChars);
  return {
    text: text.slice(safeOffset, end),
    offset: safeOffset,
    nextOffset: end < text.length ? end : null,
    truncated: end < text.length,
    untrustedContent: true as const
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

function indexedSessionSummary(provider: ProviderId, session: Record<string, unknown>) {
  return sessionSummary(provider, session);
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
  const excludedIds = dependencies.getExcludedIds || defaultGetExcludedIds;
  const refreshProviderIndex = dependencies.indexProvider || defaultIndexProvider;
  const findIndexed = dependencies.findIndexedSessionMetadata || findIndexedSessionMetadata;
  const indexedChildren = dependencies.getIndexedSessionChildren || getIndexedSessionChildren;

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

  function getVisibleSession(ref: SessionRef) {
    const provider = resolveProvider(ref);
    if (excludedIds(ref.provider).has(ref.sessionId)) {
      throw new SessionHistoryError("session_not_found", "No visible session matches this reference.");
    }
    let session: RawSession | Record<string, unknown> | null;
    try {
      session = provider.getSession(ref.sessionId);
    } catch (error: any) {
      throw new SessionHistoryError("provider_error", `Could not read ${ref.provider} session: ${error?.message || String(error)}`);
    }
    if (!session || asNonEmptyString((session as Record<string, unknown>).id) !== ref.sessionId) {
      throw new SessionHistoryError("session_not_found", "No visible session matches this reference.");
    }
    return { provider, session };
  }

  function getVisibleMessages(ref: SessionRef) {
    const { provider } = getVisibleSession(ref);
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

    search(input: Record<string, unknown>) {
      const query = asNonEmptyString(input?.query)?.trim();
      if (!query || query.length > HARD_LIMITS.queryChars) {
        throw new SessionHistoryError("invalid_input", `query must contain between 1 and ${HARD_LIMITS.queryChars} characters.`);
      }
      const requestedProviders = assertStringArray(input?.providers, "providers", PROVIDER_IDS) as ProviderId[] | undefined;
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
      const selectedIds = requestedProviders || [...available.keys()];
      const fingerprint = cursorFingerprint({ query, providers: selectedIds, updatedAfter, updatedBefore: requestedUpdatedBefore, directory });
      const cursorPage = input?.cursor === undefined ? null : decodeSearchCursor(input.cursor, fingerprint);
      const offset = cursorPage?.offset || 0;
      const updatedBefore = cursorPage?.snapshotUpdatedBefore ?? requestedUpdatedBefore ?? Date.now();
      const diagnostics: ProviderDiagnostic[] = [];
      const results = new Map<string, { key: string; rank: number; value: Record<string, unknown> }>();

      for (const providerId of selectedIds) {
        const provider = available.get(providerId);
        if (!provider) {
          diagnostics.push({ provider: providerId, status: "unavailable" });
          continue;
        }
        const startedAt = Date.now();
        const perProviderLimit = HARD_LIMITS.searchLimit;
        const excluded = excludedIds(providerId);
        try {
          const add = (session: RawSession | Record<string, unknown>, field: "title" | "directory" | "message", snippet: string, messageId: string | null = null) => {
            const summary = sessionSummary(providerId, session);
            if (!summary.session.sessionId || excluded.has(summary.session.sessionId) || !isWithinRange(summary.updatedAt, updatedAfter, updatedBefore)) return;
            if (directory && normalizeCrossProviderProjectPath(summary.directory) !== directory) return;
            const rank = field === "title" ? 0 : field === "directory" ? 1 : 2;
            const key = `${providerId}\u0000${summary.session.sessionId}`;
            const value = {
              session: summary.session,
              event: messageId ? { ...summary.session, messageId, segment: "message" } : null,
              matchField: field,
              snippet: boundedText(snippet, HARD_LIMITS.previewChars),
              title: summary.title,
              directory: summary.directory,
              updatedAt: summary.updatedAt,
              untrustedContent: true
            };
            const existing = results.get(key);
            if (!existing || rank < existing.rank || (rank === existing.rank && Number(value.updatedAt) > Number(existing.value.updatedAt))) {
              results.set(key, { key, rank, value });
            }
          };

          const metadataMatches = findIndexed(providerId, query, perProviderLimit, excluded, updatedAfter, updatedBefore);
          for (const indexed of metadataMatches) {
            const row = indexed as Record<string, unknown>;
            const title = String(row.title || "");
            const directory = String(row.directory || "");
            if (matchesSearchQuery(title, query)) add(row, "title", title);
            else if (matchesSearchQuery(directory, query)) add(row, "directory", directory);
          }

          const messageMatches = provider.searchMessages(query, perProviderLimit);
          for (const match of messageMatches) {
            if (!match?.sessionId || excluded.has(match.sessionId)) continue;
            const session = provider.getSession(match.sessionId);
            if (session) add(session, "message", String(match.snippet || ""), asNonEmptyString(match.messageId));
          }
          diagnostics.push({ provider: providerId, status: "ok", durationMs: Date.now() - startedAt });
        } catch (error: any) {
          diagnostics.push({
            provider: providerId,
            status: "error",
            durationMs: Date.now() - startedAt,
            message: error?.message || String(error)
          });
        }
      }

      const sortedMatches = [...results.values()]
        .sort((left, right) => left.rank - right.rank
          || Number(right.value.updatedAt) - Number(left.value.updatedAt)
          || left.key.localeCompare(right.key))
        .map((entry) => entry.value);
      const matches = sortedMatches.slice(offset, offset + limit);
      const nextOffset = offset + matches.length;
      const nextCursor = nextOffset < sortedMatches.length
        ? encodeSearchCursor(nextOffset, fingerprint, updatedBefore)
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
      const { session } = getVisibleSession(ref);
      const messages = getVisibleMessages(ref);
      const excluded = excludedIds(ref.provider);
      const children = indexedChildren(ref.provider, ref.sessionId, 50, excluded)
        .map((row: any) => indexedSessionSummary(ref.provider, row));
      return {
        ...sessionSummary(ref.provider, session),
        messageCount: messages.length,
        children,
        untrustedContent: true
      };
    },

    timeline(input: Record<string, unknown>) {
      const ref = assertSessionRef(input?.session);
      const requestedSegments = assertStringArray(input?.segments, "segments", EVENT_SEGMENTS) as EventSegment[] | undefined;
      const requestedRoles = assertStringArray(input?.roles, "roles", ["user", "assistant", "system", "tool"]) as MessageRole[] | undefined;
      const toolNames = assertStringArray(input?.toolNames, "toolNames");
      const statuses = assertStringArray(input?.statuses, "statuses", EVENT_STATUSES) as EventStatus[] | undefined;
      const limit = resolveLimit(input?.limit, limits.timelineLimit, limits.timelineLimit, "limit");
      const segments = requestedSegments || ["message", "tool"];
      const messages = getVisibleMessages(ref);
      const filters = { session: ref, segments, roles: requestedRoles || [], toolNames: toolNames || [], statuses: statuses || [] };
      const fingerprint = cursorFingerprint(filters as unknown as Record<string, unknown>);
      const offset = input?.cursor === undefined ? 0 : decodeCursor(input.cursor, fingerprint);
      const events = projectEvents(ref, messages)
        .filter((event) => segments.includes(event.event.segment))
        .filter((event) => !requestedRoles || requestedRoles.includes(event.role))
        .filter((event) => !toolNames || (event.toolName !== null && toolNames.includes(event.toolName)))
        .filter((event) => !statuses || (event.status !== null && statuses.includes(event.status)));
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
      const before = resolveNonNegative(input?.before, limits.contextWindow, limits.contextWindow, "before");
      const after = resolveNonNegative(input?.after, limits.contextWindow, limits.contextWindow, "after");
      const messages = getVisibleMessages(target);
      const events = projectEvents(target, messages);
      const targetIndex = events.findIndex((event) => eventKey(event.event) === eventKey(target));
      if (targetIndex < 0) {
        throw new SessionHistoryError("event_not_found", "No visible event matches this reference.");
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
      const messages = getVisibleMessages(target);
      const message = messages.find((candidate) => candidate.id === target.messageId);
      if (!message || !projectEvents(target, [message]).some((event) => eventKey(event.event) === eventKey(target))) {
        throw new SessionHistoryError("event_not_found", "No visible event matches this reference.");
      }
      const base = {
        event: target,
        role: normalizedRole(message.role),
        timestamp: asTimestamp(message.timestamp),
        untrustedContent: true as const
      };
      if (target.segment === "message") {
        return { ...base, content: pageText(message.content, offset, maxChars) };
      }
      if (target.segment === "thinking") {
        if (!includeThinking) {
          throw new SessionHistoryError("thinking_opt_in_required", "Set includeThinking to true before reading a thinking event.");
        }
        return { ...base, content: pageText(message.thinking, offset, maxChars) };
      }
      return {
        ...base,
        toolName: asNonEmptyString(message.toolName) || "tool",
        status: eventStatus(message),
        toolInput: includeToolInput ? pageText(message.toolInput, offset, maxChars) : null,
        toolOutput: includeToolOutput ? pageText(message.toolOutput, offset, maxChars) : null
      };
    }
  };
}

export type SessionHistoryService = ReturnType<typeof createSessionHistoryService>;
