import type { SessionRef } from "./providers/shared/session-protocol.js";
import type { SessionEventRef, SessionProtocolV3 } from "./providers/shared/session-protocol-v3.js";
import {
  READER_COORDINATION_CHANNEL_KINDS,
  READER_TASK_DIRECTORY_DEFAULT_SIZE,
  READER_TASK_DIRECTORY_MAX_SIZE,
  READER_TASK_RUNS_DEFAULT_SIZE,
  READER_TASK_RUNS_MAX_SIZE,
  decodeReaderTaskDirectoryCursor,
  decodeReaderTaskRunsCursor,
  encodeReaderCoordinationCursor,
  encodeReaderTaskDirectoryCursor,
  encodeReaderTaskRunsCursor,
  readerCoordinationAssignment,
  readerCoordinationCards,
  readerTaskDirectoryPrefixHash,
  sortReaderCoordinationByRecordedTime
} from "./reader-coordination.js";
import type { CoordinationObservation } from "./providers/shared/session-protocol-v3.js";
import type {
  ContextProjection,
  CoordinationProjection,
  ExecutionProjection,
  WorkProjection
} from "./protocol-runtime-v3.js";

/**
 * Provider-neutral Conversation view model (UI v2 P2b).
 *
 * This module derives one small, bounded presentation model for the
 * Conversation surface from the finalized Session Protocol v3 snapshot and its
 * execution/coordination/context projections. It never reads provider-owned
 * raw fields, never branches on provider id, and never invents facts: every
 * field on a card, channel item, or inspector section is either
 * recorded evidence or explicitly null/absent. The Conversation renderer
 * consumes this model only; runtime protocol facts stay authoritative in the
 * Session Protocol and the Work/Events surfaces.
 */

export const CONVERSATION_CHANNEL_KINDS = READER_COORDINATION_CHANNEL_KINDS;

export type ConversationChannelKind = (typeof CONVERSATION_CHANNEL_KINDS)[number];
type ConversationChannelObservation = CoordinationObservation & { kind: ConversationChannelKind };

export const CONVERSATION_MAX_CARDS = 50;
export const CONVERSATION_MAX_CHANNEL_ITEMS = 50;
export const CONVERSATION_MAX_RELATIONSHIPS = 5;

/** Kinds that begin a new card-owning dispatch when they are recorded. */
const DISPATCH_KINDS = new Set(["spawn", "delegate"]);

export interface ConversationChannelItem {
  id: string;
  kind: ConversationChannelKind;
  state: string;
  timestamp: number | null;
  senderActorId: string | null;
  recipientActorId: string | null;
  senderName: string | null;
  recipientName: string | null;
  eventId: string | null;
  turnId: string | null;
  sourceEventRef: SessionEventRef | null;
}

export interface ConversationCardBinding {
  taskId: string | null;
  runId: string | null;
  taskToolCallId: string | null;
  childSessionId: string | null;
  turnId: string | null;
  actorIds: string[];
}

export interface ConversationAgentCard {
  /** Stable presentation key: `run:<id>` or `task:<id>`. */
  id: string;
  /** Recorded display name (actor name, run agent, or task assignee). */
  name: string | null;
  /** Recorded actor kind (agent/team/human/system) when an actor links. */
  actorKind: string | null;
  /** Recorded responsibility: task title or agent path. */
  responsibility: string | null;
  /** Presentation state key: active/waiting/blocked/queued/completed/failed/cancelled/interrupted. */
  state: string | null;
  /** Raw recorded task/run status, kept for evidence (never displayed as primary copy). */
  rawStatus: string | null;
  interrupted: boolean;
  lastActivity: number | null;
  observationCount: number;
  channelTruncated: boolean;
  channelNextCursor: string | null;
  channel: ConversationChannelItem[];
  childSession: SessionRef | null;
  /** Explicit normalized availability; null remains unknown. */
  childSessionAvailable: boolean | null;
  bindings: ConversationCardBinding;
}

export interface ConversationAssetView {
  id: string;
  kind: string;
  scope: string;
  title: string | null;
  summary: string | null;
  origin: string | null;
  contentAccess: string | null;
  provenance: string | null;
  sourceSessions: SessionRef[];
  producerRunId: string | null;
  consumerRunIds: string[];
}

export interface ConversationAssetGroup {
  scope: string;
  items: ConversationAssetView[];
}

export interface ConversationRelationshipView {
  type: string;
  /** True when this session is the `from` end of the recorded relationship. */
  outgoing: boolean;
  otherSession: SessionRef | null;
  /** Explicit normalized availability; null remains unknown. */
  otherSessionAvailable: boolean | null;
  timestamp: number | null;
}

export interface ConversationCoverageView {
  domain: string;
  state: string;
  details: string | null;
}

export interface ConversationOriginBreakdown {
  direct: number;
  inherited: number;
  shared: number;
}

export interface ConversationUsageView {
  requestCount: number;
  complete: boolean;
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
  total: number | null;
  /** True only when the execution origin aggregate partitions every component exactly. */
  originsComplete: boolean;
  origins: {
    input: ConversationOriginBreakdown;
    cacheRead: ConversationOriginBreakdown;
    cacheWrite: ConversationOriginBreakdown;
  } | null;
}

export interface ConversationInspectorView {
  sessionId: string;
  provider: string;
  completeness: string;
  coverage: ConversationCoverageView[];
  truncated: boolean;
  usage: ConversationUsageView;
  relationships: ConversationRelationshipView[];
  relationshipCount: number;
  assets: ConversationAssetGroup[];
}

export type ConversationTurnBoundaryKind = "run.started" | "run.completed" | "run.failed" | "run.cancelled";

/** One recorded lifecycle edge of a root session-owned execution turn. */
export interface ConversationTurnBoundary {
  eventId: string;
  runId: string;
  turnId: string | null;
  timestamp: number | null;
  normalizedKind: ConversationTurnBoundaryKind;
  displayNumber: number;
}

export interface ConversationViewModel {
  cards: ConversationAgentCard[];
  taskCount: number;
  taskDirectory: ConversationTaskDirectoryPage;
  turnBoundaries: ConversationTurnBoundary[];
  inspector: ConversationInspectorView | null;
}

export interface ConversationGraphOrigin {
  key: string;
  name: string | null;
  outgoing: boolean;
  incoming: boolean;
}

export interface ConversationTaskGroup {
  /** Stable presentation key already used by existing task selection controls. */
  key: string;
  cards: ConversationAgentCard[];
  childSession: SessionRef | null;
  laneId: string;
  runCount: number;
  runsPageSize: number;
  runsOffset: number;
  runsNextCursor: string | null;
  graphOrigins: ConversationGraphOrigin[];
}

export interface ConversationTaskDirectoryQuery {
  provider: string;
  sessionId: string;
  query?: string | null;
  size?: number;
  cursor?: string | null;
}

export interface ConversationTaskDirectoryPage {
  ok: true;
  provider: string;
  sessionId: string;
  query: string;
  size: number;
  offset: number;
  total: number;
  items: ConversationTaskGroup[];
  nextCursor: string | null;
}

export interface ConversationTaskDirectoryError {
  ok: false;
  code: "invalid_input" | "stale_cursor";
  error: string;
}

export interface ConversationTaskGroupQuery {
  provider: string;
  sessionId: string;
  key?: string | null;
  lane?: string | null;
  size?: number;
  cursor?: string | null;
}

export interface ConversationTaskGroupPage {
  ok: true;
  provider: string;
  sessionId: string;
  key: string;
  lane: string;
  size: number;
  offset: number;
  total: number;
  group: ConversationTaskGroup;
  nextCursor: string | null;
}

export interface ConversationViewInput {
  protocol: SessionProtocolV3;
  work: WorkProjection;
  execution: ExecutionProjection;
  coordination: CoordinationProjection;
  context: ContextProjection;
}

interface CardState {
  view: ConversationAgentCard;
  runId: string | null;
  taskId: string | null;
  linkedActorIds: Set<string>;
  dispatchTurnId: string | null;
  sortIndex: number;
}

interface MutableCard {
  state: CardState;
}

const MAIN_TURN_BOUNDARY_KINDS = new Set<ConversationTurnBoundaryKind>([
  "run.started", "run.completed", "run.failed", "run.cancelled"
]);

function deriveTurnBoundaries(protocol: SessionProtocolV3): ConversationTurnBoundary[] {
  const sessionTurnRuns = new Map(
    (protocol.agentRuns || [])
      .filter((run) => run.kind === "session-turn" && run.sessionId === protocol.sessionId)
      .map((run) => [run.id, run])
  );
  const displayNumbers = new Map<string, number>();
  let nextDisplayNumber = 1;
  const boundaries: ConversationTurnBoundary[] = [];
  for (const event of protocol.events || []) {
    const runId = event.runId || "";
    const normalizedKind = event.normalizedKind as ConversationTurnBoundaryKind | undefined;
    if (event.sessionId !== protocol.sessionId || !runId || !sessionTurnRuns.has(runId)
      || !normalizedKind || !MAIN_TURN_BOUNDARY_KINDS.has(normalizedKind)) continue;
    let displayNumber = displayNumbers.get(runId);
    if (displayNumber === undefined) {
      displayNumber = nextDisplayNumber;
      nextDisplayNumber += 1;
      displayNumbers.set(runId, displayNumber);
    }
    boundaries.push({
      eventId: String(event.id),
      runId,
      turnId: event.turnId ?? sessionTurnRuns.get(runId)?.turnId ?? null,
      timestamp: event.timestamp ?? null,
      normalizedKind,
      displayNumber
    });
  }
  return boundaries;
}

function refOf(value: SessionRef | null | undefined, fallbackProvider: string, fallbackSessionId: string): SessionRef | null {
  if (!value) return null;
  return { provider: value.provider || fallbackProvider, sessionId: value.sessionId || fallbackSessionId };
}

/** Projection relation refs are protocol entity refs; only non-session kinds carry an id. */
function entityRefId(ref: any): string | null {
  if (!ref || ref.kind === "session") {
    return null;
  }
  return typeof ref.id === "string" ? ref.id : null;
}

function taskTitleOf(task: any): string | null {
  return typeof task?.title === "string" && task.title.trim() ? task.title.trim() : null;
}

function taskAgentPathOf(task: any): string | null {
  return typeof task?.agentPath === "string" && task.agentPath.trim() ? task.agentPath.trim() : null;
}

function assigneeOf(task: any): string | null {
  return typeof task?.assignee === "string" && task.assignee.trim() ? task.assignee.trim() : null;
}

function finiteTime(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function maxTime(...values: Array<number | null | undefined>): number | null {
  let result: number | null = null;
  for (const value of values) {
    const number = finiteTime(value);
    if (number !== null && (result === null || number > result)) result = number;
  }
  return result;
}

/**
 * Presentation mapping for recorded task/run statuses (visual-system §5).
 * Interruption is only presented when an `interrupt` observation is recorded
 * for that card and the status is not terminal; cancellation is never renamed.
 */
export function conversationCardState(rawStatus: string | null, interrupted: boolean): string | null {
  if (!rawStatus) return null;
  if (interrupted && rawStatus !== "completed" && rawStatus !== "failed" && rawStatus !== "cancelled") {
    return "interrupted";
  }
  switch (rawStatus) {
    case "running": return "active";
    case "waiting_input": return "waiting";
    case "queued": return "queued";
    case "blocked": return "blocked";
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    default: return rawStatus;
  }
}

function compareReference(a: SessionRef | null, provider: string, sessionId: string): boolean {
  return Boolean(a && a.provider === provider && a.sessionId === sessionId);
}

/** Build the cheap canonical card universe; channels are materialized only after paging or selection. */
function conversationCardStates(protocol: SessionProtocolV3): CardState[] {
  const focus = protocol.session!.ref;
  const provider = focus.provider;
  const sessionId = focus.sessionId;
  const actorsById = new Map((protocol.actors || []).map((actor) => [actor.id, actor]));
  const tasksById = new Map((protocol.tasks || []).map((task) => [task.id, task]));
  const readerCards = readerCoordinationCards(protocol);
  const readerCardsByKey = new Map(readerCards.map((card) => [card.key, card]));
  const taskIdsWithRuns = new Set(readerCards
    .filter((card) => card.runId && card.taskId)
    .map((card) => card.taskId!));
  const cards: CardState[] = [];

  for (const run of protocol.agentRuns || []) {
    if (run.kind === "session-turn") continue;
    const task = run.taskId ? tasksById.get(run.taskId) : null;
    const readerCard = readerCardsByKey.get(`run:${run.id}`);
    if (!readerCard) continue;
    const linkedActorIds = new Set(readerCard.actorIds || []);
    const linkedActors = [...linkedActorIds].map((actorId) => actorsById.get(actorId)).filter(Boolean);
    cards.push({
      view: {
        id: `run:${run.id}`,
        name: linkedActors[0]?.name ?? run.agent ?? (task ? assigneeOf(task) : null) ?? null,
        actorKind: linkedActors[0]?.kind ?? null,
        responsibility: task ? taskTitleOf(task) ?? taskAgentPathOf(task) : null,
        state: null,
        rawStatus: run.status || null,
        interrupted: false,
        lastActivity: maxTime(run.timeStart, run.timeEnd),
        observationCount: 0,
        channelTruncated: false,
        channelNextCursor: null,
        channel: [],
        childSession: refOf(run.childSessionId ? { provider, sessionId: run.childSessionId } : null, provider, sessionId),
        childSessionAvailable: typeof run.childSessionAvailable === "boolean" ? run.childSessionAvailable : null,
        bindings: {
          taskId: run.taskId ?? null,
          runId: run.id,
          taskToolCallId: task?.toolCallId ?? null,
          childSessionId: run.childSessionId ?? null,
          turnId: null,
          actorIds: [...linkedActorIds]
        }
      },
      runId: run.id,
      taskId: run.taskId,
      linkedActorIds,
      dispatchTurnId: null,
      sortIndex: cards.length
    });
  }
  for (const task of protocol.tasks || []) {
    if (taskIdsWithRuns.has(task.id) || !readerCardsByKey.has(`task:${task.id}`)) continue;
    cards.push({
      view: {
        id: `task:${task.id}`,
        name: assigneeOf(task),
        actorKind: null,
        responsibility: taskTitleOf(task) ?? taskAgentPathOf(task),
        state: null,
        rawStatus: task.status || null,
        interrupted: false,
        lastActivity: maxTime(task.timeCreated, task.timeUpdated),
        observationCount: 0,
        channelTruncated: false,
        channelNextCursor: null,
        channel: [],
        childSession: null,
        childSessionAvailable: null,
        bindings: {
          taskId: task.id,
          runId: null,
          taskToolCallId: task.toolCallId ?? null,
          childSessionId: null,
          turnId: null,
          actorIds: []
        }
      },
      runId: null,
      taskId: task.id,
      linkedActorIds: new Set(),
      dispatchTurnId: null,
      sortIndex: cards.length
    });
  }

  return cards;
}

function materializeConversationCardStates(protocol: SessionProtocolV3, cards: CardState[]): ConversationAgentCard[] {
  if (!cards.length) return [];
  const focus = protocol.session!.ref;
  const actorNames = new Map((protocol.actors || []).map((actor) => [actor.id, actor.name]));
  const readerAssignment = readerCoordinationAssignment(protocol);
  const readerCardsByKey = new Map(readerAssignment.cards.map((card) => [card.key, card]));
  const selectedByKey = new Map(cards.map((card) => [card.view.id, card]));
  const buckets = new Map<CardState, ConversationChannelObservation[]>();
  for (const card of cards) buckets.set(card, []);
  for (let index = 0; index < (protocol.coordination || []).length; index += 1) {
    const observation = protocol.coordination[index];
    const assigned = readerAssignment.byObservation[index];
    const card = assigned ? selectedByKey.get(assigned.key) : undefined;
    if (!card || !(CONVERSATION_CHANNEL_KINDS as readonly string[]).includes(observation.kind)) continue;
    buckets.get(card)!.push(observation as ConversationChannelObservation);
    if (DISPATCH_KINDS.has(observation.kind) && observation.turnId && !card.dispatchTurnId) {
      card.dispatchTurnId = observation.turnId;
      card.view.bindings.turnId = observation.turnId;
    }
  }
  for (const card of cards) {
    const matching = sortReaderCoordinationByRecordedTime(buckets.get(card) || []);
    const channel = matching.slice(0, CONVERSATION_MAX_CHANNEL_ITEMS).map((observation) => ({
      id: String(observation.id || ""),
      kind: observation.kind,
      state: observation.state || "unknown",
      timestamp: finiteTime(observation.timestamp),
      senderActorId: observation.senderActorId ?? null,
      recipientActorId: observation.recipientActorId ?? null,
      senderName: observation.senderActorId ? actorNames.get(observation.senderActorId) ?? null : null,
      recipientName: observation.recipientActorId ? actorNames.get(observation.recipientActorId) ?? null : null,
      eventId: observation.eventId ?? null,
      turnId: observation.turnId ?? null,
      sourceEventRef: observation.sourceEventRef ?? null
    }));
    const channelResult = {
      channel,
      count: matching.length,
      truncated: matching.length > CONVERSATION_MAX_CHANNEL_ITEMS,
      cursorPrefix: channel.map((observation) => ({ id: observation.id, timestamp: observation.timestamp })),
      interrupted: matching.some((observation) => observation.kind === "interrupt"),
      lastActivity: matching.reduce<number | null>((latest, observation) => maxTime(latest, observation.timestamp), null)
    };
    card.view.channel = channelResult.channel;
    card.view.observationCount = channelResult.count;
    card.view.channelTruncated = channelResult.truncated;
    const canonicalCard = readerCardsByKey.get(card.view.id)!;
    card.view.channelNextCursor = channelResult.truncated
      ? encodeReaderCoordinationCursor({
          provider: focus.provider, sessionId: focus.sessionId, taskId: canonicalCard.taskId, runId: canonicalCard.runId,
          anchor: null, size: CONVERSATION_MAX_CHANNEL_ITEMS
        }, channelResult.channel.at(-1)!.id, channelResult.cursorPrefix)
      : null;
    card.view.interrupted = channelResult.interrupted;
    card.view.state = conversationCardState(card.view.rawStatus, channelResult.interrupted);
    card.view.lastActivity = maxTime(card.view.lastActivity, channelResult.lastActivity);
  }
  return cards.map((card) => card.view);
}

function childGroupIdentity(card: ConversationAgentCard): string | null {
  return card.childSession
    ? `child:${encodeURIComponent(card.childSession.provider)}:${encodeURIComponent(card.childSession.sessionId)}`
    : null;
}

/** Match the grouping already used by the Reader: one child history, otherwise one canonical card. */
export function groupConversationCards(cards: readonly ConversationAgentCard[], provider: string, sessionId: string): ConversationTaskGroup[] {
  const groups = new Map<string, ConversationTaskGroup>();
  for (const card of cards) {
    const childIdentity = childGroupIdentity(card);
    const taskIdentity = !childIdentity && card.bindings.taskId ? `task:${card.bindings.taskId}` : null;
    const identity = childIdentity || taskIdentity || card.id;
    let group = groups.get(identity);
    if (!group) {
      group = {
        key: card.id,
        cards: [],
        childSession: card.childSession,
        laneId: childIdentity || `${encodeURIComponent(provider)}:${encodeURIComponent(sessionId)}:${card.id}`,
        runCount: 0,
        runsPageSize: READER_TASK_RUNS_DEFAULT_SIZE,
        runsOffset: 0,
        runsNextCursor: null,
        graphOrigins: []
      };
      groups.set(identity, group);
    }
    group.cards.push(card);
    group.runCount += 1;
    for (const item of card.channel) addGraphOrigin(group, item);
  }
  return [...groups.values()];
}

function addGraphOrigin(group: ConversationTaskGroup, item: Pick<ConversationChannelItem,
  "id" | "kind" | "senderActorId" | "recipientActorId" | "senderName" | "recipientName">) {
  const outgoing = item.kind === "spawn" || item.kind === "delegate";
  const incoming = item.kind === "result-delivery";
  if (!outgoing && !incoming) return;
  const key = (outgoing ? item.senderActorId : item.recipientActorId) || `unknown:${item.id}`;
  const existing = group.graphOrigins.find((origin) => origin.key === key);
  if (existing) {
    existing.outgoing ||= outgoing;
    existing.incoming ||= incoming;
  } else group.graphOrigins.push({ key, name: outgoing ? item.senderName : item.recipientName, outgoing, incoming });
}

/** Relationship summaries do not depend on which run/channel body page is loaded. */
function populateTaskGraphOrigins(protocol: SessionProtocolV3, groups: ConversationTaskGroup[]) {
  if (!groups.length) return;
  const byCard = new Map(groups.flatMap((group) => group.cards.map((card) => [card.id, group] as const)));
  const assignment = readerCoordinationAssignment(protocol);
  const names = new Map(protocol.actors.map((actor) => [actor.id, actor.name]));
  for (let index = 0; index < protocol.coordination.length; index++) {
    const owner = assignment.byObservation[index];
    const group = owner && byCard.get(owner.key);
    if (!group) continue;
    const item = protocol.coordination[index];
    if (item.kind !== "spawn" && item.kind !== "delegate" && item.kind !== "result-delivery") continue;
    addGraphOrigin(group, {
      id: item.id, kind: item.kind,
      senderActorId: item.senderActorId ?? null, recipientActorId: item.recipientActorId ?? null,
      senderName: item.senderActorId ? names.get(item.senderActorId) ?? null : null,
      recipientName: item.recipientActorId ? names.get(item.recipientActorId) ?? null : null
    });
  }
}

function taskGroupSearchText(group: ConversationTaskGroup): string {
  return group.cards.flatMap((card) => [
    card.id,
    card.name,
    card.responsibility,
    card.bindings.taskId,
    card.bindings.runId,
    card.childSession?.sessionId
  ]).filter(Boolean).join("\n").toLocaleLowerCase();
}

function conversationTaskGroupStates(protocol: SessionProtocolV3) {
  const focus = protocol.session!.ref;
  const states = conversationCardStates(protocol);
  const groups = groupConversationCards(states.map((state) => state.view), focus.provider, focus.sessionId);
  return { states, groups };
}

function materializeTaskGroups(protocol: SessionProtocolV3, states: CardState[], groups: ConversationTaskGroup[]) {
  const selectedIds = new Set(groups.flatMap((group) => group.cards.map((card) => card.id)));
  materializeConversationCardStates(protocol, states.filter((state) => selectedIds.has(state.view.id)));
  return groups;
}

function materializeTaskGroupHeads(
  protocol: SessionProtocolV3,
  states: CardState[],
  groups: ConversationTaskGroup[]
): ConversationTaskGroup[] {
  const provider = protocol.session!.ref.provider;
  const sessionId = protocol.sessionId;
  populateTaskGraphOrigins(protocol, groups);
  const heads = groups.map((group) => {
    const cards = group.cards.slice(0, 1);
    const identity = { provider, sessionId, taskKey: group.key, size: READER_TASK_RUNS_DEFAULT_SIZE };
    return {
      ...group,
      cards,
      runCount: group.cards.length,
      runsPageSize: identity.size,
      runsOffset: 0,
      runsNextCursor: group.cards.length > cards.length
        ? encodeReaderTaskRunsCursor(identity, cards.map((card) => card.id))
        : null
    };
  });
  return materializeTaskGroups(protocol, states, heads);
}

export function deriveConversationTaskDirectoryPage(
  protocol: SessionProtocolV3,
  request: ConversationTaskDirectoryQuery
): ConversationTaskDirectoryPage | ConversationTaskDirectoryError {
  const size = request.size ?? READER_TASK_DIRECTORY_DEFAULT_SIZE;
  const query = (request.query || "").trim().toLocaleLowerCase();
  const canonical = protocol.session?.ref;
  if (!canonical || canonical.provider !== request.provider || canonical.sessionId !== request.sessionId
    || !Number.isSafeInteger(size) || size < 1 || size > READER_TASK_DIRECTORY_MAX_SIZE) {
    return { ok: false, code: "invalid_input", error: `Task directory size must be between 1 and ${READER_TASK_DIRECTORY_MAX_SIZE}.` };
  }
  const universe = conversationTaskGroupStates(protocol);
  const groups = universe.groups
    .filter((group) => !query || taskGroupSearchText(group).includes(query));
  const identity = { provider: request.provider, sessionId: request.sessionId, query, size };
  let offset = 0;
  if (request.cursor) {
    const cursor = decodeReaderTaskDirectoryCursor(request.cursor);
    if (!cursor) return { ok: false, code: "invalid_input", error: "The task directory cursor is invalid." };
    if (cursor.identity.provider !== identity.provider || cursor.identity.sessionId !== identity.sessionId
      || cursor.identity.query !== identity.query || cursor.identity.size !== identity.size) {
      return { ok: false, code: "stale_cursor", error: "The task directory changed; refresh the directory." };
    }
    const prefixKeys = groups.slice(0, cursor.prefixCount).map((group) => group.key);
    if (prefixKeys.length !== cursor.prefixCount || prefixKeys.at(-1) !== cursor.lastKey
      || readerTaskDirectoryPrefixHash(prefixKeys) !== cursor.prefixHash) {
      return { ok: false, code: "stale_cursor", error: "The task directory changed; refresh the directory." };
    }
    offset = cursor.prefixCount;
  }
  const items = materializeTaskGroupHeads(protocol, universe.states, groups.slice(offset, offset + size));
  const nextOffset = offset + items.length;
  return {
    ok: true,
    provider: request.provider,
    sessionId: request.sessionId,
    query,
    size,
    offset,
    total: groups.length,
    items,
    nextCursor: nextOffset < groups.length
      ? encodeReaderTaskDirectoryCursor(identity, groups.slice(0, nextOffset).map((group) => group.key))
      : null
  };
}

export function deriveConversationTaskGroupPage(
  protocol: SessionProtocolV3,
  selection: ConversationTaskGroupQuery
): ConversationTaskGroupPage | ConversationTaskDirectoryError | null {
  const canonical = protocol.session?.ref;
  const size = selection.size ?? READER_TASK_RUNS_DEFAULT_SIZE;
  if (!canonical || canonical.provider !== selection.provider || canonical.sessionId !== selection.sessionId
    || !Number.isSafeInteger(size) || size < 1 || size > READER_TASK_RUNS_MAX_SIZE
    || (!selection.key && !selection.lane) || Boolean(selection.key && selection.lane)) {
    return { ok: false, code: "invalid_input", error: `Task run size must be between 1 and ${READER_TASK_RUNS_MAX_SIZE}.` };
  }
  const universe = conversationTaskGroupStates(protocol);
  const group = selection.key
    ? universe.groups.find((candidate) => candidate.key === selection.key)
    : selection.lane
      ? universe.groups.find((candidate) => candidate.laneId === selection.lane)
      : null;
  if (!group) {
    return selection.cursor
      ? { ok: false, code: "stale_cursor", error: "The task run continuation is stale; reload this task." }
      : null;
  }
  const identity = { provider: selection.provider, sessionId: selection.sessionId, taskKey: group.key, size };
  let offset = 0;
  if (selection.cursor) {
    const cursor = decodeReaderTaskRunsCursor(selection.cursor);
    if (!cursor) return { ok: false, code: "invalid_input", error: "The task run cursor is invalid." };
    if (cursor.identity.provider !== identity.provider || cursor.identity.sessionId !== identity.sessionId
      || cursor.identity.taskKey !== identity.taskKey || cursor.identity.size !== identity.size) {
      return { ok: false, code: "stale_cursor", error: "The task runs changed; reload this task." };
    }
    const prefixKeys = group.cards.slice(0, cursor.prefixCount).map((card) => card.id);
    if (prefixKeys.length !== cursor.prefixCount || prefixKeys.at(-1) !== cursor.lastKey
      || readerTaskDirectoryPrefixHash(prefixKeys) !== cursor.prefixHash) {
      return { ok: false, code: "stale_cursor", error: "The task runs changed; reload this task." };
    }
    offset = cursor.prefixCount;
  }
  const cards = group.cards.slice(offset, offset + size);
  populateTaskGraphOrigins(protocol, [group]);
  const nextOffset = offset + cards.length;
  const nextCursor = nextOffset < group.cards.length
    ? encodeReaderTaskRunsCursor(identity, group.cards.slice(0, nextOffset).map((card) => card.id))
    : null;
  const pagedGroup = materializeTaskGroups(protocol, universe.states, [{
    ...group,
    cards,
    runCount: group.cards.length,
    runsPageSize: size,
    runsOffset: offset,
    runsNextCursor: nextCursor
  }])[0];
  return {
    ok: true,
    provider: selection.provider,
    sessionId: selection.sessionId,
    key: group.key,
    lane: group.laneId,
    size,
    offset,
    total: group.cards.length,
    group: pagedGroup,
    nextCursor
  };
}

export function deriveConversationView(input: ConversationViewInput): ConversationViewModel {
  const { protocol, work, execution, coordination, context } = input;
  const focus = execution.focus || (protocol.session?.ref ?? null);
  const provider = focus.provider;
  const sessionId = focus.sessionId;

  const taskDirectory = deriveConversationTaskDirectoryPage(protocol, {
    provider,
    sessionId,
    size: CONVERSATION_MAX_CARDS
  });
  if (!taskDirectory.ok) throw new TypeError(taskDirectory.error);
  const cards = taskDirectory.items.flatMap((group) => group.cards);

  // ── Inspector ────────────────────────────────────────────────────────────
  const coverageDomains = ["work", "execution", "coordination", "context", "usage"] as const;
  const usageAggregate = execution.usage || {
    requestCount: 0,
    complete: false,
    input: null,
    cacheRead: null,
    cacheWrite: null,
    output: null,
    reasoning: null,
    total: null,
    origins: { complete: false, input: null, cacheRead: null, cacheWrite: null }
  };
  const usage: ConversationUsageView = {
    requestCount: usageAggregate.requestCount,
    complete: Boolean(usageAggregate.complete),
    input: usageAggregate.input ?? null,
    cacheRead: usageAggregate.cacheRead ?? null,
    cacheWrite: usageAggregate.cacheWrite ?? null,
    output: usageAggregate.output ?? null,
    reasoning: usageAggregate.reasoning ?? null,
    total: usageAggregate.total ?? null,
    originsComplete: Boolean(usageAggregate.origins?.complete),
    origins: usageAggregate.origins && usageAggregate.origins.input && usageAggregate.origins.cacheRead && usageAggregate.origins.cacheWrite ? {
      input: {
        direct: usageAggregate.origins.input.classified.direct,
        inherited: usageAggregate.origins.input.classified.inherited,
        shared: usageAggregate.origins.input.classified.shared
      },
      cacheRead: {
        direct: usageAggregate.origins.cacheRead.classified.direct,
        inherited: usageAggregate.origins.cacheRead.classified.inherited,
        shared: usageAggregate.origins.cacheRead.classified.shared
      },
      cacheWrite: {
        direct: usageAggregate.origins.cacheWrite.classified.direct,
        inherited: usageAggregate.origins.cacheWrite.classified.inherited,
        shared: usageAggregate.origins.cacheWrite.classified.shared
      }
    } : null
  };

  const relationships: ConversationRelationshipView[] = [];
  const seenOthers = new Set<string>();
  let relationshipCount = 0;
  for (const edge of coordination.lineage || []) {
    const outgoingEdge = compareReference(edge.from, provider, sessionId);
    const incomingEdge = compareReference(edge.to, provider, sessionId);
    if (!outgoingEdge && !incomingEdge) continue;
    const other = outgoingEdge ? edge.to : edge.from;
    if (!other) continue;
    const key = `${other.provider}\u0000${other.sessionId}`;
    if (seenOthers.has(key)) continue;
    seenOthers.add(key);
    relationshipCount += 1;
    const childRun = (execution.runs || []).find((entry) => (
      entry.run.childSessionId === other.sessionId
      && other.provider === provider
      && typeof entry.run.childSessionAvailable === "boolean"
    ));
    if (relationships.length < CONVERSATION_MAX_RELATIONSHIPS) {
      relationships.push({
        type: edge.type,
        outgoing: outgoingEdge,
        otherSession: { provider: other.provider, sessionId: other.sessionId },
        otherSessionAvailable: childRun ? childRun.run.childSessionAvailable! : null,
        timestamp: edge.timestamp ?? null
      });
    }
  }

  const scopeOrder = ["session", "agent", "project", "user", "organization"] as const;
  const assetGroups: ConversationAssetGroup[] = [];
  for (const scope of scopeOrder) {
    const items = (context.artifacts || [])
      .filter((entry) => entry.artifact.scope === scope)
      .map((entry) => {
        const artifact = entry.artifact;
        const sourceSessions = (context.artifactSessions || [])
          .filter((relation) => entityRefId(relation.artifact) === entityRefId(entry.ref))
          .map((relation) => relation.sourceSession)
          .filter((value): value is SessionRef => Boolean(value && value.provider && value.sessionId));
        const consumerRunIds = (context.artifactRuns || [])
          .filter((relation) => entityRefId(relation.artifact) === entityRefId(entry.ref) && relation.role === "consumer")
          .map((relation) => entityRefId(relation.run))
          .filter((value): value is string => Boolean(value));
        return {
          id: String(entityRefId(entry.ref) || ""),
          kind: artifact.kind,
          scope: artifact.scope,
          title: artifact.title,
          summary: artifact.summary,
          origin: artifact.origin,
          contentAccess: artifact.contentAccess,
          provenance: artifact.provenance && typeof artifact.provenance === "object"
            ? [artifact.provenance.fidelity, artifact.provenance.sourceType].filter(Boolean).join(" · ") || null
            : null,
          sourceSessions,
          producerRunId: artifact.producerRunId ?? null,
          consumerRunIds
        };
      });
    if (items.length) {
      assetGroups.push({ scope, items });
    }
  }

  const inspector: ConversationInspectorView | null = protocol.session?.ref
    ? {
        sessionId: protocol.sessionId,
        provider: protocol.session.ref.provider,
        completeness: protocol.completeness || "partial",
        coverage: coverageDomains.map((domain) => {
          const value = protocol.coverage?.[domain];
          return {
            domain,
            state: value?.state || "unknown",
            details: value?.details ?? null
          };
        }),
        truncated: Boolean(work.truncated || execution.truncated || coordination.truncated || context.truncated),
        usage,
        relationships,
        relationshipCount,
        assets: assetGroups
      }
    : null;

  return {
    cards,
    taskCount: taskDirectory.total,
    taskDirectory,
    turnBoundaries: deriveTurnBoundaries(protocol),
    inspector
  };
}
