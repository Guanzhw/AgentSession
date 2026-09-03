import type { Message, RawSession } from "../interface.js";
import {
  agentRun,
  compactionEnvelope,
  compactionSummaryArtifact,
  contextCompactionEvent,
  messageSessionEvents,
  sessionEvent,
  sequenceEventsBySource,
  sourceSequence,
  sessionRelationship,
  sessionTask,
  type SessionProtocol
} from "../shared/session-protocol.js";

type Row = Record<string, any>;

export interface HermesProtocolEntry {
  session: RawSession;
  messages: Message[];
  rawSession: Row;
  asyncDelegations?: Row[];
}

export interface HermesProtocolInput {
  session: RawSession;
  messages: Message[];
  rawSession: Row;
  asyncDelegations?: Row[];
  /** Validated family: delegates and compression continuations. */
  family: HermesProtocolEntry[];
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compressionParentOf(entry: HermesProtocolEntry): string | null {
  const value = entry.session.metadata?.compressionParentId;
  return value ? String(value) : null;
}

function delegateParentOf(entry: HermesProtocolEntry): string | null {
  const value = entry.session.parentId;
  return value ? String(value) : null;
}

type DelegationStatus = "running" | "completed" | "failed" | "cancelled";

function asyncDelegationStatus(value: unknown): DelegationStatus | null {
  const state = String(value || "").toLowerCase();
  if (state === "running" || state === "finalizing") return "running";
  if (state === "completed" || state === "success") return "completed";
  if (state === "failed" || state === "error" || state === "timeout" || state === "stalled") return "failed";
  if (state === "interrupted") return "cancelled";
  return null;
}

function epochMilliseconds(value: unknown): number | null {
  const number = asNumber(value);
  if (number == null) return null;
  return Math.abs(number) < 1e12 ? number * 1000 : number;
}

function delegationGoal(row: Row): string | null {
  if (typeof row.task_json !== "string") return null;
  try {
    const task = JSON.parse(row.task_json);
    const goal = typeof task?.goal === "string" ? task.goal.trim() : "";
    return goal ? goal.slice(0, 240) : null;
  } catch {
    return null;
  }
}

/**
 * Normalized protocol for one Hermes session:
 * - events: derived message envelopes plus derived context.compaction events
 *   for outgoing compression continuations, anchored by message row order
 *   (message row id, then per-row ordinal). Async registry events retain only
 *   their table-local order; their source table is different, so no cross-table
 *   sourceSequence or timestamp order is claimed.
 * - relationships: validated compression lineage becomes compacted-into;
 *   _delegate_from lineage becomes spawned. Both carry derived provenance
 *   because they are reconstructed from the store's validated metadata.
 * - tasks/agentRuns: a recorded async handle is the Task and a persisted
 *   delegate child is a separate unbound AgentRun; legacy delegate children
 *   without async registry evidence remain Task/AgentRun pairs. Compression
 *   continuations never become tasks.
 * - contextArtifacts: metadata-only compaction artifacts referencing the
 *   continuation session.
 */
export function buildHermesSessionProtocol(input: HermesProtocolInput): SessionProtocol {
  const sessionId = String(input.session.id);
  const family = input.family || [];
  const children = family.filter((entry) => String(entry.session.id) !== sessionId);
  const compressedInto = children.filter((entry) => compressionParentOf(entry) === sessionId);
  const delegates = children.filter((entry) => delegateParentOf(entry) === sessionId);
  const ownCompressionParent = compressionParentOf(input);
  const ownDelegateParent = delegateParentOf(input);

  // --- Source-order event assembly ---------------------------------------
  // Message rows anchor the order: user/assistant messages carry their row id
  // as message id, and tool-call messages resolve through their assistant
  // turn's row id; ordinals within a row follow message order. Compression
  // boundary edges live in the store rather than the session's message rows,
  // so their context.compaction events are placed deterministically AFTER
  // the compacted session's last message row (the boundary ends its life);
  // that derived placement is unavoidable and documented.
  const events: ReturnType<typeof compactionEnvelope>[] = [];
  const rowOrdinals = new Map<number, number>();
  let maxRowId = 0;
  const pushAnchored = (event: ReturnType<typeof compactionEnvelope>, anchor: number) => {
    const ordinal = rowOrdinals.get(anchor) ?? 0;
    rowOrdinals.set(anchor, ordinal + 1);
    events.push({
      ...event,
      providerData: {
        ...(event.providerData || {}),
        sourceSequence: sourceSequence(anchor, ordinal)
      }
    });
  };
  const messageEvents = messageSessionEvents(input.messages, sessionId, "hermes.normalized-message");
  for (const [messageIndex, message] of input.messages.entries()) {
    const event = messageEvents[messageIndex];
    const messageId = event.provenance.sourceId || "";
    // Tool messages are normalized from a separate row but are produced by
    // the recorded assistant turn. Use that turn row as the source anchor so
    // tool events stay in the assistant turn's within-row order.
    const sourceId = message.role === "tool" && typeof message.metadata?.turnId === "string"
      ? message.metadata.turnId
      : messageId;
    const rowId = Number(sourceId);
    const anchor = Number.isFinite(rowId) && rowId > 0 ? rowId : null;
    if (anchor == null) {
      events.push(message.role === "tool" && sourceId !== messageId
        ? { ...event, provenance: { ...event.provenance, sourceId } }
        : event); // documented fallback: normalized message order, appended
      continue;
    }
    maxRowId = Math.max(maxRowId, anchor);
    pushAnchored(message.role === "tool" && sourceId !== messageId
      ? { ...event, provenance: { ...event.provenance, sourceId } }
      : event, anchor);
  }
  compressedInto.forEach((child, index) => {
    pushAnchored(compactionEnvelope({
      id: `event:compaction:${String(child.session.id)}`,
      sessionId,
      timestamp: asNumber(child.session.timeCreated),
      correlationId: String(child.session.id),
      provenance: {
        fidelity: "derived",
        sourceType: "hermes.sessions.parent_session_id",
        sourceId: String(child.session.id)
      },
      providerData: {
        compressionEdge: true
      }
    }, contextCompactionEvent({
      trigger: "automatic",
      strategy: "opaque",
      summary: null,
      continuationSessionId: String(child.session.id)
    })), maxRowId + 1 + index);
  });

  const asyncDelegations = (input.asyncDelegations || []).filter((row) => row && row.delegation_id);
  asyncDelegations.forEach((row, index) => {
    const delegationId = String(row.delegation_id);
    const status = asyncDelegationStatus(row.state);
    events.push(sessionEvent({
      id: `event:async-delegation:${delegationId}`,
      sessionId,
      timestamp: epochMilliseconds(row.dispatched_at),
      kind: "delegation.async",
      normalizedKind: "task.requested",
      category: "task",
      phase: status === "completed" ? "completed" : status === "failed" || status === "cancelled" ? "failed" : status === "running" ? "started" : undefined,
      taskId: status ? delegationId : null,
      runId: null,
      correlationId: delegationId,
      provenance: { fidelity: "recorded", sourceType: "hermes.async_delegations", sourceId: delegationId },
      providerData: {
        sourceTable: "async_delegations",
        sourceOrdinal: index,
        state: String(row.state || ""),
        deliveryState: row.delivery_state == null ? null : String(row.delivery_state),
        deliveryAttempts: asNumber(row.delivery_attempts)
      }
    }));
  });

  const relationships = [];
  if (ownCompressionParent) {
    relationships.push(sessionRelationship({
      type: "compacted-into",
      fromSessionId: ownCompressionParent,
      toSessionId: sessionId,
      timestamp: asNumber(input.session.timeCreated),
      provenance: {
        fidelity: "derived",
        sourceType: "hermes.sessions.parent_session_id",
        sourceId: ownCompressionParent
      },
      details: "Hermes compression continuation (validated lineage)"
    }));
  }
  for (const child of compressedInto) {
    relationships.push(sessionRelationship({
      type: "compacted-into",
      fromSessionId: sessionId,
      toSessionId: String(child.session.id),
      timestamp: asNumber(child.session.timeCreated),
      correlationId: String(child.session.id),
      provenance: {
        fidelity: "derived",
        sourceType: "hermes.sessions.parent_session_id",
        sourceId: String(child.session.id)
      },
      details: "Hermes compression continuation (validated lineage)"
    }));
  }
  if (ownDelegateParent) {
    relationships.push(sessionRelationship({
      type: "spawned",
      fromSessionId: ownDelegateParent,
      toSessionId: sessionId,
      timestamp: asNumber(input.session.timeCreated),
      provenance: {
        fidelity: "derived",
        sourceType: "hermes.model_config._delegate_from",
        sourceId: ownDelegateParent
      },
      details: "Hermes delegated agent session"
    }));
  }
  const hasAsyncRegistryEvidence = asyncDelegations.length > 0;
  for (const child of delegates) {
    relationships.push(sessionRelationship({
      type: "spawned",
      fromSessionId: sessionId,
      toSessionId: String(child.session.id),
      timestamp: asNumber(child.session.timeCreated),
      correlationId: String(child.session.id),
      provenance: {
        fidelity: "derived",
        sourceType: "hermes.model_config._delegate_from",
        sourceId: String(child.session.id)
      },
      details: "Hermes delegated agent session"
    }));
  }

  const tasks = [];
  const runs = [];
  for (const child of delegates) {
    const childId = String(child.session.id);
    // extractHermesMeta falls back timeUpdated to started_at for open rows;
    // completion must use the recorded raw ended_at column instead.
    const ended = child.rawSession.ended_at == null ? null : asNumber(child.session.timeUpdated);
    // A current async registry row is the recorded delegation Task. A
    // persisted delegate child is the separate session-backed AgentRun. The
    // source has no correlation key between those tables, so do not create a
    // second derived Task or claim which async handle launched this child.
    if (!hasAsyncRegistryEvidence) {
      tasks.push(sessionTask({
        id: childId,
        sessionId,
        kind: "delegate",
        status: ended ? "completed" : "running",
        title: child.session.title || null,
        correlationId: childId,
        timeCreated: asNumber(child.session.timeCreated),
        timeUpdated: ended,
        timeCompleted: ended,
        provenance: {
          fidelity: "derived",
          sourceType: "hermes.sessions.source:delegate",
          sourceId: childId
        }
      }));
    }
    runs.push(agentRun({
      id: childId,
      sessionId,
      taskId: hasAsyncRegistryEvidence ? null : childId,
      status: ended ? "completed" : "running",
      mode: "subagent",
      agent: child.session.title || null,
      model: child.session.metadata?.model ? String(child.session.metadata.model) : null,
      childSessionId: childId,
      timeStart: asNumber(child.session.timeCreated),
      timeEnd: ended,
      provenance: {
        fidelity: "derived",
        sourceType: "hermes.sessions.source:delegate",
        sourceId: childId
      }
    }));
  }

  for (const row of asyncDelegations) {
    const delegationId = String(row.delegation_id);
    const status = asyncDelegationStatus(row.state);
    // Unknown provider states remain an evidence event only. TaskStatus is a
    // closed enum, so mapping an unrecognized state would invent lifecycle.
    if (!status) continue;
    const eventId = `event:async-delegation:${delegationId}`;
    const created = epochMilliseconds(row.dispatched_at);
    const updated = epochMilliseconds(row.updated_at);
    const completed = status === "completed" || status === "failed" || status === "cancelled"
      ? epochMilliseconds(row.completed_at) ?? updated
      : null;
    const metadata = {
      sourceState: String(row.state || ""),
      deliveryState: row.delivery_state == null ? null : String(row.delivery_state),
      deliveryAttempts: asNumber(row.delivery_attempts),
      childSessionLinkRecorded: false
    };
    tasks.push(sessionTask({
      id: delegationId,
      sessionId,
      kind: "async-delegation",
      status,
      title: delegationGoal(row),
      correlationId: delegationId,
      requestEventId: eventId,
      triggerEventId: eventId,
      timeCreated: created,
      timeUpdated: updated,
      timeCompleted: completed,
      provenance: { fidelity: "recorded", sourceType: "hermes.async_delegations", sourceId: delegationId },
      metadata
    }));
  }

  const artifacts = compressedInto.map((child) => compactionSummaryArtifact({
    id: `artifact:${String(child.session.id)}`,
    sessionId,
    sourceSessionIds: [sessionId],
    provenance: {
      fidelity: "derived",
      sourceType: "hermes.sessions.parent_session_id",
      sourceId: String(child.session.id)
    },
    timeCreated: asNumber(child.session.timeCreated),
    metadata: {
      continuationSessionId: String(child.session.id),
      strategy: "opaque"
    }
  }));

  return {
    sessionId,
    events: sequenceEventsBySource(events),
    relationships,
    tasks,
    agentRuns: runs,
    contextArtifacts: artifacts
  };
}
