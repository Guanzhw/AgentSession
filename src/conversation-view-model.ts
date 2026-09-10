import type { SessionRef } from "./providers/shared/session-protocol.js";
import type { SessionProtocolV3 } from "./providers/shared/session-protocol-v3.js";
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
 * field on a card, channel item, reference row, or inspector section is either
 * recorded evidence or explicitly null/absent. The Conversation renderer
 * consumes this model only; runtime protocol facts stay authoritative in the
 * Session Protocol and the Work/Events surfaces.
 */

export const CONVERSATION_CHANNEL_KINDS = [
  "message",
  "mailbox-delivery",
  "interrupt",
  "handoff",
  "result-delivery",
  "result-acknowledgement"
] as const;

export type ConversationChannelKind = (typeof CONVERSATION_CHANNEL_KINDS)[number];

export const CONVERSATION_MAX_CARDS = 50;
export const CONVERSATION_MAX_CHANNEL_ITEMS = 50;
export const CONVERSATION_MAX_REFERENCES = 50;
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
}

export interface ConversationCardBinding {
  taskToolCallId: string | null;
  childSessionId: string | null;
  turnId: string | null;
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
  channel: ConversationChannelItem[];
  childSession: SessionRef | null;
  /** Explicit normalized availability; null remains unknown. */
  childSessionAvailable: boolean | null;
  bindings: ConversationCardBinding;
}

export type ConversationReferenceKind = "dispatched" | "message" | "mailbox" | "result" | "acknowledgement";

export interface ConversationReference {
  /** Observation id: each observation produces at most one main-thread row. */
  id: string;
  kind: ConversationReferenceKind;
  name: string | null;
  cardId: string;
  anchorMessageId: string | null;
  timestamp: number | null;
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

export interface ConversationViewModel {
  cards: ConversationAgentCard[];
  references: ConversationReference[];
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

/**
 * Bound the channel without reordering the Coordination projection. Provider
 * normalization owns source order; timestamps are display evidence and may be
 * absent or disagree with the recorded sequence. Observations whose kind is
 * outside the channel set stay off the card; they are Work/Coordination facts,
 * not conversation facts.
 */
function channelOf(card: CardState, observations: any[], assignments: Array<CardState | null>, nameFor: (actorId: string) => string | null): { channel: ConversationChannelItem[]; count: number; truncated: boolean } {
  const matching = observations.filter((observation, index) => (
    observation.kind
    && (CONVERSATION_CHANNEL_KINDS as readonly string[]).includes(observation.kind)
    && assignments[index] === card
  ));
  const count = matching.length;
  const truncated = count > CONVERSATION_MAX_CHANNEL_ITEMS;
  return {
    channel: matching.slice(0, CONVERSATION_MAX_CHANNEL_ITEMS).map((observation) => ({
      id: String(observation.id || ""),
      kind: observation.kind,
      state: observation.state || "unknown",
      timestamp: finiteTime(observation.timestamp),
      senderName: observation.senderActorId ? nameFor(observation.senderActorId) ?? null : null,
      recipientName: observation.recipientActorId ? nameFor(observation.recipientActorId) ?? null : null
    })),
    count,
    truncated
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

  const actorRunsByRun = new Map<string, Set<string>>();
  for (const link of execution.actorRuns || []) {
    const runId = entityRefId(link.run);
    const actorId = entityRefId(link.actor);
    if (!runId || !actorId) continue;
    if (!actorRunsByRun.has(runId)) actorRunsByRun.set(runId, new Set());
    actorRunsByRun.get(runId)!.add(actorId);
  }

  const tasksById = new Map<string, any>();
  for (const entry of work.tasks || []) tasksById.set(entry.task.id, entry.task);
  const runsById = new Map<string, any>();
  const runIdsWithTask = new Set<string>();
  for (const entry of execution.runs || []) {
    runsById.set(entry.run.id, entry.run);
    if (entry.run.kind !== "session-turn" && entry.run.taskId) runIdsWithTask.add(entry.run.taskId);
  }

  // One card per run, plus one per task that has no run, in deterministic
  // source order. Cards are bounded: beyond the limit the remaining evidence
  // stays in Work/Coordination and is not mirrored into the conversation.
  const cards: CardState[] = [];
  const cardsByRun = new Map<string, CardState>();
  const cardsByTask = new Map<string, CardState>();
  const addCard = (state: CardState) => {
    if (cards.length >= CONVERSATION_MAX_CARDS) return;
    cards.push(state);
    if (state.runId) cardsByRun.set(state.runId, state);
    if (state.taskId) cardsByTask.set(state.taskId, state);
  };
  for (const entry of execution.runs || []) {
    const run = entry.run;
    if (run.kind === "session-turn") continue;
    const task = run.taskId ? tasksById.get(run.taskId) : null;
    const linkedActors = [...(actorRunsByRun.get(run.id) || [])].map((actorId) => actorsById.get(actorId)).filter(Boolean);
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
          turnId: null
        }
      },
      runId: run.id,
      taskId: run.taskId,
      linkedActorIds: new Set(actorRunsByRun.get(run.id) || []),
      dispatchTurnId: null,
      sortIndex: cards.length
    });
  }
  for (const entry of work.tasks || []) {
    if (runIdsWithTask.has(entry.task.id)) continue;
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
        channel: [],
        childSession: null,
        childSessionAvailable: null,
        bindings: {
          taskToolCallId: entry.task.toolCallId ?? null,
          childSessionId: null,
          turnId: null
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
  const observations = (coordination.observations || []).map((entry) => entry.observation);
  const assignments = observations.map((observation) => cardForObservation(observation, cardsByRun, cardsByTask));
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
    const interrupted = channelResult.channel.some((item) => item.kind === "interrupt");
    card.view.channel = channelResult.channel;
    card.view.observationCount = channelResult.count;
    card.view.channelTruncated = channelResult.truncated;
    card.view.interrupted = interrupted;
    card.view.state = conversationCardState(card.view.rawStatus, interrupted);
    for (const item of channelResult.channel) {
      card.view.lastActivity = maxTime(card.view.lastActivity, item.timestamp);
    }
  }

  // Main-thread references: recorded message/mailbox traffic from or to a
  // card, plus result delivery/acknowledgement anchors. Each observation
  // contributes at most one row and only when its recorded turnId names a
  // spine position; otherwise the fact stays in the channel/card.
  const references: ConversationReference[] = [];
  for (let observationIndex = 0; observationIndex < observations.length; observationIndex += 1) {
    const observation = observations[observationIndex];
    if (references.length >= CONVERSATION_MAX_REFERENCES) break;
    if (!observation.turnId) continue;
    const card = assignments[observationIndex] || null;
    if (!card) continue;
    let kind: ConversationReferenceKind | null = null;
    if (observation.kind === "message") kind = "message";
    if (observation.kind === "mailbox-delivery") kind = "mailbox";
    if (observation.kind === "result-delivery") kind = "result";
    if (observation.kind === "result-acknowledgement") kind = "acknowledgement";
    if (!kind) continue;
    references.push({
      id: String(observation.id || ""),
      kind,
      name: card.view.name,
      cardId: card.view.id,
      anchorMessageId: observation.turnId,
      timestamp: finiteTime(observation.timestamp)
    });
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
    references,
    inspector
  };
}

function cardForObservation(
  observation: any,
  cardsByRun: Map<string, CardState>,
  cardsByTask: Map<string, CardState>
): CardState | null {
  // Explicit protocol identity is authoritative. If it cannot resolve, the
  // observation remains unassigned rather than being reassigned by actor.
  if (observation.runId || observation.taskId) {
    if (observation.runId && cardsByRun.has(observation.runId)) return cardsByRun.get(observation.runId)!;
    if (observation.taskId && cardsByTask.has(observation.taskId)) return cardsByTask.get(observation.taskId)!;
    return null;
  }
  const candidates = new Set<CardState>();
  for (const card of [...cardsByRun.values(), ...cardsByTask.values()]) {
    if ((observation.senderActorId && card.linkedActorIds.has(observation.senderActorId))
      || (observation.recipientActorId && card.linkedActorIds.has(observation.recipientActorId))) {
      candidates.add(card);
    }
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}
