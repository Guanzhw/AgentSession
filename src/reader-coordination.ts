import { summarizeEvent } from "./event-summary.js";
import type { EventProvenance } from "./providers/shared/session-protocol.js";
import type {
  CoordinationKind,
  CoordinationState,
  SessionEventRef,
  SessionProtocolV3
} from "./providers/shared/session-protocol-v3.js";

export const READER_COORDINATION_DEFAULT_SIZE = 50;
export const READER_COORDINATION_MAX_SIZE = 50;
/** Observation kinds mirrored by the compact conversation channel and its reader continuation. */
export const READER_COORDINATION_CHANNEL_KINDS = [
  "spawn", "delegate", "follow-up", "message", "mailbox-delivery", "interrupt",
  "handoff", "result-delivery", "result-acknowledgement", "child-turn-completed"
] as const;

export interface ReaderCoordinationQuery {
  provider: string;
  sessionId: string;
  taskId?: string | null;
  runId?: string | null;
  anchor?: string | null;
  size?: number;
  cursor?: string | null;
}

export interface ReaderCoordinationIdentity {
  provider: string;
  sessionId: string;
  taskId: string | null;
  runId: string | null;
  anchor: string | null;
  size: number;
}

export interface ReaderCoordinationCursor {
  identity: ReaderCoordinationIdentity;
  lastId: string | null;
}

export interface ReaderCoordinationItem {
  id: string;
  kind: CoordinationKind;
  state: CoordinationState;
  timestamp: number | null;
  senderActorId: string | null;
  recipientActorId: string | null;
  taskId: string | null;
  runId: string | null;
  eventId: string | null;
  turnId: string | null;
  sourceEventRef: SessionEventRef | null;
  provenance: EventProvenance;
}

export interface ReaderCoordinationPage {
  ok: true;
  provider: string;
  sessionId: string;
  taskId: string | null;
  runId: string | null;
  anchor: string | null;
  size: number;
  offset: number;
  total: number;
  items: ReaderCoordinationItem[];
  nextCursor: string | null;
}

export type ReaderCoordinationErrorCode = "invalid_input" | "stale_cursor" | "anchor_not_found";

export interface ReaderCoordinationError {
  ok: false;
  code: ReaderCoordinationErrorCode;
  error: string;
}

export interface ReaderCoordinationCard {
  key: string;
  taskId: string | null;
  runId: string | null;
  actorIds: readonly string[];
}

export interface ReaderCoordinationAssignment {
  cards: ReaderCoordinationCard[];
  taskRunCounts: ReadonlyMap<string, number>;
  byObservation: Array<ReaderCoordinationCard | null>;
}

/** Build the finalized, unbounded card identity universe shared by SSR and continuation. */
export function readerCoordinationCards(protocol: SessionProtocolV3): ReaderCoordinationCard[] {
  const cards: ReaderCoordinationCard[] = [];
  const runIds = new Set<string>();
  const actorIdsByRun = new Map<string, string[]>();
  for (const actor of protocol.actors || []) {
    for (const runId of actor.runIds || []) {
      if (!actorIdsByRun.has(runId)) actorIdsByRun.set(runId, []);
      const ids = actorIdsByRun.get(runId)!;
      if (!ids.includes(actor.id)) ids.push(actor.id);
    }
  }
  for (const run of protocol.agentRuns || []) {
    if (run.kind === "session-turn") continue;
    runIds.add(run.id);
    cards.push({
      key: `run:${run.id}`,
      taskId: optionalId(run.taskId),
      runId: run.id,
      actorIds: actorIdsByRun.get(run.id) || []
    });
  }
  const taskIdsWithRuns = new Set(cards.map((card) => card.taskId).filter((taskId): taskId is string => Boolean(taskId)));
  for (const task of protocol.tasks || []) {
    const hasRun = taskIdsWithRuns.has(task.id)
      || (task.runIds || []).some((runId) => runIds.has(runId));
    if (hasRun) continue;
    cards.push({ key: `task:${task.id}`, taskId: task.id, runId: null, actorIds: [] });
  }
  return cards;
}

/** Assign every coordination observation to one canonical card or preserve it as unassigned. */
export function readerCoordinationAssignment(protocol: SessionProtocolV3): ReaderCoordinationAssignment {
  const cards = readerCoordinationCards(protocol);
  const byRun = new Map(cards.filter((card) => card.runId).map((card) => [card.runId!, card]));
  const byTask = new Map(cards.filter((card) => !card.runId && card.taskId).map((card) => [card.taskId!, card]));
  const taskRunCounts = new Map<string, number>();
  for (const run of protocol.agentRuns || []) {
    if (run.kind === "session-turn" || !run.taskId) continue;
    taskRunCounts.set(run.taskId, (taskRunCounts.get(run.taskId) || 0) + 1);
  }
  const actorToCards = new Map<string, ReaderCoordinationCard[]>();
  for (const card of cards) {
    for (const actorId of card.actorIds) {
      if (!actorToCards.has(actorId)) actorToCards.set(actorId, []);
      actorToCards.get(actorId)!.push(card);
    }
  }
  const byObservation = (protocol.coordination || []).map((observation) => {
    const runId = optionalId(observation.runId);
    const taskId = optionalId(observation.taskId);
    if (runId) {
      const card = byRun.get(runId);
      return card && (!taskId || card.taskId === taskId) ? card : null;
    }
    if (taskId) return (taskRunCounts.get(taskId) || 0) === 0 ? byTask.get(taskId) || null : null;
    const candidates = new Set<ReaderCoordinationCard>();
    for (const actorId of [optionalId(observation.senderActorId), optionalId(observation.recipientActorId)]) {
      if (!actorId) continue;
      for (const card of actorToCards.get(actorId) || []) candidates.add(card);
    }
    return candidates.size === 1 ? [...candidates][0] : null;
  });
  return { cards, taskRunCounts, byObservation };
}

function optionalId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function identityOf(query: ReaderCoordinationQuery, card: ReaderCoordinationCard, size: number): ReaderCoordinationIdentity {
  return {
    provider: query.provider,
    sessionId: query.sessionId,
    taskId: card.taskId,
    runId: card.runId,
    anchor: optionalId(query.anchor),
    size
  };
}

function sameIdentity(left: ReaderCoordinationIdentity, right: ReaderCoordinationIdentity): boolean {
  return left.provider === right.provider
    && left.sessionId === right.sessionId
    && left.taskId === right.taskId
    && left.runId === right.runId
    && left.anchor === right.anchor
    && left.size === right.size;
}

export function encodeReaderCoordinationCursor(identity: ReaderCoordinationIdentity, lastId: string | null): string {
  return Buffer.from(JSON.stringify({ identity, lastId }), "utf8").toString("base64url");
}

export function decodeReaderCoordinationCursor(value: string | null | undefined): ReaderCoordinationCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const identity = parsed?.identity;
    const size = identity?.size;
    if (!identity
      || typeof identity.provider !== "string"
      || typeof identity.sessionId !== "string"
      || ![null, undefined].includes(identity.taskId) && typeof identity.taskId !== "string"
      || ![null, undefined].includes(identity.runId) && typeof identity.runId !== "string"
      || ![null, undefined].includes(identity.anchor) && typeof identity.anchor !== "string"
      || !Number.isSafeInteger(size) || size < 1 || size > READER_COORDINATION_MAX_SIZE
      || (parsed.lastId !== null && typeof parsed.lastId !== "string")) return null;
    return {
      identity: {
        provider: identity.provider,
        sessionId: identity.sessionId,
        taskId: identity.taskId ?? null,
        runId: identity.runId ?? null,
        anchor: identity.anchor ?? null,
        size
      },
      lastId: parsed.lastId ?? null
    };
  } catch {
    return null;
  }
}

function itemOf(observation: any): ReaderCoordinationItem {
  return {
    id: String(observation.id),
    kind: observation.kind,
    state: observation.state || "unknown",
    timestamp: typeof observation.timestamp === "number" && Number.isFinite(observation.timestamp) ? observation.timestamp : null,
    senderActorId: optionalId(observation.senderActorId),
    recipientActorId: optionalId(observation.recipientActorId),
    taskId: optionalId(observation.taskId),
    runId: optionalId(observation.runId),
    eventId: optionalId(observation.eventId),
    turnId: optionalId(observation.turnId),
    sourceEventRef: observation.sourceEventRef || null,
    provenance: observation.provenance
  };
}

/**
 * Page one reader card's complete coordination collection. This deliberately
 * reads protocol.coordination directly rather than the bounded workbench
 * projection, while keeping the query identity concrete to one reader card.
 */
export function deriveReaderCoordinationPage(
  protocol: SessionProtocolV3,
  query: ReaderCoordinationQuery
): ReaderCoordinationPage | ReaderCoordinationError {
  const size = query.size ?? READER_COORDINATION_DEFAULT_SIZE;
  if (!Number.isSafeInteger(size) || size < 1 || size > READER_COORDINATION_MAX_SIZE) {
    return { ok: false, code: "invalid_input", error: `size must be an integer between 1 and ${READER_COORDINATION_MAX_SIZE}.` };
  }
  const canonical = protocol.session?.ref;
  if (!query.provider || !query.sessionId || protocol.sessionId !== query.sessionId
    || (canonical && (canonical.provider !== query.provider || canonical.sessionId !== query.sessionId))) {
    return { ok: false, code: "invalid_input", error: "Reader coordination identity does not match the canonical session." };
  }
  const assignment = readerCoordinationAssignment(protocol);
  const requestedTaskId = optionalId(query.taskId);
  const requestedRunId = optionalId(query.runId);
  if (!requestedTaskId && !requestedRunId) {
    return { ok: false, code: "invalid_input", error: "Reader coordination requires a canonical task or run identity." };
  }
  const card = requestedRunId
    ? assignment.cards.find((candidate) => candidate.runId === requestedRunId
      && (!requestedTaskId || candidate.taskId === requestedTaskId)) || null
    : assignment.cards.find((candidate) => candidate.runId === null && candidate.taskId === requestedTaskId) || null;
  if (!card) {
    return { ok: false, code: "invalid_input", error: "The requested coordination card identity is unavailable or ambiguous." };
  }
  const identity = identityOf(query, card, size);
  const observations = (protocol.coordination || []).filter((observation, index) => (
    assignment.byObservation[index]?.key === card.key
    && (READER_COORDINATION_CHANNEL_KINDS as readonly string[]).includes(observation.kind)
  ));
  const anchorIndex = identity.anchor === null ? 0 : observations.findIndex((observation) => observation.id === identity.anchor);
  if (anchorIndex < 0) {
    return query.cursor
      ? { ok: false, code: "stale_cursor", error: "The coordination continuation is stale; refresh this reader card." }
      : { ok: false, code: "anchor_not_found", error: "The requested coordination anchor is not assigned to this reader card." };
  }

  let offset = anchorIndex;
  if (query.cursor) {
    const cursor = decodeReaderCoordinationCursor(query.cursor);
    if (!cursor) return { ok: false, code: "invalid_input", error: "The coordination cursor is invalid." };
    if (!sameIdentity(cursor.identity, identity)) {
      return { ok: false, code: "stale_cursor", error: "The coordination continuation is stale; refresh this reader card." };
    }
    if (cursor.lastId === null) offset = 0;
    else {
      const lastIndex = observations.findIndex((observation) => observation.id === cursor.lastId);
      if (lastIndex < 0) return { ok: false, code: "stale_cursor", error: "The coordination continuation is stale; refresh this reader card." };
      offset = lastIndex + 1;
    }
  }
  const items = observations.slice(offset, offset + size).map(itemOf);
  const nextOffset = offset + items.length;
  return {
    ok: true,
    provider: query.provider,
    sessionId: query.sessionId,
    taskId: identity.taskId,
    runId: identity.runId,
    anchor: identity.anchor,
    size,
    offset,
    total: observations.length,
    items,
    nextCursor: nextOffset < observations.length ? encodeReaderCoordinationCursor(identity, items.at(-1)?.id || null) : null
  };
}

export interface ReaderEventEvidence {
  eventId: string;
  provider: string;
  sessionId: string;
  sequence: number;
  timestamp: number | null;
  kind: string;
  normalizedKind: string;
  category: string;
  phase: string | null;
  turnId: string | null;
  taskId: string | null;
  runId: string | null;
  parentEventId: string | null;
  correlationId: string | null;
  messageId: string | null;
  partId: string | null;
  toolCallId: string | null;
  summary: ReturnType<typeof summarizeEvent>;
  provenance: EventProvenance;
}

export function readerEventEvidence(protocol: SessionProtocolV3, eventId: string): ReaderEventEvidence | null {
  const event = (protocol.events || []).find((candidate) => candidate.id === eventId);
  if (!event) return null;
  return {
    eventId: event.id,
    provider: protocol.session?.ref.provider || "",
    sessionId: protocol.sessionId,
    sequence: event.sequence,
    timestamp: event.timestamp ?? null,
    kind: event.kind,
    normalizedKind: event.normalizedKind || event.kind,
    category: event.category || "unknown",
    phase: event.phase || null,
    turnId: event.turnId || null,
    taskId: event.taskId || null,
    runId: event.runId || null,
    parentEventId: event.parentEventId || null,
    correlationId: event.correlationId || null,
    messageId: event.messageId || null,
    partId: event.partId || null,
    toolCallId: event.toolCallId || null,
    summary: summarizeEvent(event),
    provenance: event.provenance
  };
}
