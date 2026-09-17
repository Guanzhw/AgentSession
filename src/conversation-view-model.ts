import type { SessionRef } from "./providers/shared/session-protocol.js";
import type { SessionEventRef, SessionProtocolV3 } from "./providers/shared/session-protocol-v3.js";
import { READER_COORDINATION_CHANNEL_KINDS, encodeReaderCoordinationCursor, readerCoordinationAssignment, sortReaderCoordinationByRecordedTime } from "./reader-coordination.js";
import type { ReaderCoordinationCursorItem } from "./reader-coordination.js";
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
  senderName: string | null;
  recipientName: string | null;
  eventId: string | null;
  turnId: string | null;
  sourceEventRef: SessionEventRef | null;
}

export interface ConversationCardBinding {
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
  turnBoundaries: ConversationTurnBoundary[];
  inspector: ConversationInspectorView | null;
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

/** Bound one card's channel after applying its recorded-time display order. */
function channelOf(card: CardState, observations: CoordinationObservation[], assignments: Array<CardState | null>, nameFor: (actorId: string) => string | null): { channel: ConversationChannelItem[]; count: number; truncated: boolean; cursorPrefix: ReaderCoordinationCursorItem[]; interrupted: boolean; lastActivity: number | null } {
  const matching = sortReaderCoordinationByRecordedTime(observations.filter((observation, index): observation is ConversationChannelObservation => (
    observation.kind
    && (CONVERSATION_CHANNEL_KINDS as readonly string[]).includes(observation.kind)
    && assignments[index] === card
  )));
  const count = matching.length;
  const truncated = count > CONVERSATION_MAX_CHANNEL_ITEMS;
  const channel = matching.slice(0, CONVERSATION_MAX_CHANNEL_ITEMS).map((observation) => ({
    id: String(observation.id || ""),
    kind: observation.kind,
    state: observation.state || "unknown",
    timestamp: finiteTime(observation.timestamp),
    senderName: observation.senderActorId ? nameFor(observation.senderActorId) ?? null : null,
    recipientName: observation.recipientActorId ? nameFor(observation.recipientActorId) ?? null : null,
    eventId: observation.eventId ?? null,
    turnId: observation.turnId ?? null,
    sourceEventRef: observation.sourceEventRef ?? null
  }));
  return {
    channel,
    count,
    truncated,
    cursorPrefix: channel.map((observation) => ({ id: observation.id, timestamp: observation.timestamp })),
    interrupted: matching.some((observation) => observation.kind === "interrupt"),
    lastActivity: matching.reduce<number | null>((latest, observation) => maxTime(latest, observation.timestamp), null)
  };
}

export function deriveConversationView(input: ConversationViewInput): ConversationViewModel {
  const { protocol, work, execution, coordination, context } = input;
  const focus = execution.focus || (protocol.session?.ref ?? null);
  const provider = focus.provider;
  const sessionId = focus.sessionId;

  const actorsById = new Map<string, { id: string; name: string | null; kind: string }>();
  for (const entry of execution.actors || []) {
    actorsById.set(entry.actor.id, {
      id: entry.actor.id,
      name: entry.actor.name,
      kind: entry.actor.kind || "unknown"
    });
  }
  const nameFor = (actorId: string) => {
    const actor = actorsById.get(actorId);
    return actor?.name ?? null;
  };

  const tasksById = new Map<string, any>();
  for (const entry of work.tasks || []) tasksById.set(entry.task.id, entry.task);
  const readerAssignment = readerCoordinationAssignment(protocol);
  const readerCardsByKey = new Map(readerAssignment.cards.map((card) => [card.key, card]));
  const runIdsWithTask = new Set<string>();
  for (const card of readerAssignment.cards) {
    if (card.runId && card.taskId) runIdsWithTask.add(card.taskId);
  }
  // One card per run, plus one per task that has no run, in deterministic
  // source order. Cards are bounded: beyond the limit the remaining evidence
  // stays in Work/Coordination and is not mirrored into the conversation.
  const cards: CardState[] = [];
  const addCard = (state: CardState) => {
    if (cards.length >= CONVERSATION_MAX_CARDS) return;
    cards.push(state);
  };
  for (const entry of execution.runs || []) {
    const run = entry.run;
    if (run.kind === "session-turn") continue;
    const task = run.taskId ? tasksById.get(run.taskId) : null;
    const readerCard = readerCardsByKey.get(`run:${run.id}`);
    if (!readerCard) continue;
    const linkedActorIds = new Set(readerCard?.actorIds || []);
    const linkedActors = [...linkedActorIds].map((actorId) => actorsById.get(actorId)).filter(Boolean);
    const name = linkedActors[0]?.name ?? run.agent ?? (task ? assigneeOf(task) || null : null) ?? null;
    addCard({
      view: {
        id: `run:${run.id}`,
        name,
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
        childSession: refOf(
          run.childSessionId ? { provider, sessionId: run.childSessionId } : null,
          provider,
          sessionId
        ),
        childSessionAvailable: typeof run.childSessionAvailable === "boolean" ? run.childSessionAvailable : null,
        bindings: {
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
  for (const entry of work.tasks || []) {
    if (runIdsWithTask.has(entry.task.id)) continue;
    if (!readerCardsByKey.has(`task:${entry.task.id}`)) continue;
    addCard({
      view: {
        id: `task:${entry.task.id}`,
        name: assigneeOf(entry.task),
        actorKind: null,
        responsibility: taskTitleOf(entry.task) ?? taskAgentPathOf(entry.task),
        state: null,
        rawStatus: entry.task.status || null,
        interrupted: false,
        lastActivity: maxTime(entry.task.timeCreated, entry.task.timeUpdated),
        observationCount: 0,
        channelTruncated: false,
        channelNextCursor: null,
        channel: [],
        childSession: null,
        childSessionAvailable: null,
        bindings: {
          taskToolCallId: entry.task.toolCallId ?? null,
          childSessionId: null,
          turnId: null,
          actorIds: []
        }
      },
      runId: null,
      taskId: entry.task.id,
      linkedActorIds: new Set(),
      dispatchTurnId: null,
      sortIndex: cards.length
    });
  }

  // Dispatch turn anchors come from recorded spawn/delegate observations.
  // The embedded coordination projection is intentionally bounded for the
  // workbench. Conversation cards use the finalized collection so a reader
  // continuation can reach every assigned observation without losing source
  // identity to that overview bound.
  const observations = protocol.coordination || [];
  const cardStatesByKey = new Map(cards.map((card) => [card.view.id, card]));
  const assignments = readerAssignment.byObservation.map((card) => card ? cardStatesByKey.get(card.key) || null : null);
  for (let observationIndex = 0; observationIndex < observations.length; observationIndex += 1) {
    const observation = observations[observationIndex];
    if (!DISPATCH_KINDS.has(observation.kind)) continue;
    const card = assignments[observationIndex] || null;
    if (!card || !observation.turnId || card.dispatchTurnId) continue;
    card.dispatchTurnId = observation.turnId;
    card.view.bindings.turnId = observation.turnId;
  }

  // Channels and observation counts. `interrupted` is a recorded-fact
  // presentation: only an interrupt observation for this card may set it.
  for (const card of cards) {
    const channelResult = channelOf(card, observations, assignments, nameFor);
    card.view.channel = channelResult.channel;
    card.view.observationCount = channelResult.count;
    card.view.channelTruncated = channelResult.truncated;
    const canonicalCard = readerCardsByKey.get(card.view.id)!;
    card.view.channelNextCursor = channelResult.truncated
      ? encodeReaderCoordinationCursor({
          provider, sessionId, taskId: canonicalCard.taskId, runId: canonicalCard.runId,
          anchor: null, size: CONVERSATION_MAX_CHANNEL_ITEMS
        }, channelResult.channel.at(-1)!.id, channelResult.cursorPrefix)
      : null;
    card.view.interrupted = channelResult.interrupted;
    card.view.state = conversationCardState(card.view.rawStatus, channelResult.interrupted);
    card.view.lastActivity = maxTime(card.view.lastActivity, channelResult.lastActivity);
  }

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
    cards: cards.map((card) => card.view),
    turnBoundaries: deriveTurnBoundaries(protocol),
    inspector
  };
}
