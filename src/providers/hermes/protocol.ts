import type { Message, RawSession } from "../interface.js";
import {
  agentRun,
  compactionEnvelope,
  compactionSummaryArtifact,
  contextCompactionEvent,
  messageSessionEvents,
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
}

export interface HermesProtocolInput {
  session: RawSession;
  messages: Message[];
  rawSession: Row;
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

/**
 * Normalized protocol for one Hermes session:
 * - events: derived message envelopes plus derived context.compaction events
 *   for outgoing compression continuations, sequenced by database row order
 *   (message row id, then per-row ordinal); compression boundary events are
 *   placed after the compacted session's last message row (the edge lives in
 *   the store, not in the session's message rows).
 * - relationships: validated compression lineage becomes compacted-into;
 *   _delegate_from lineage becomes spawned. Both carry derived provenance
 *   because they are reconstructed from the store's validated metadata.
 * - tasks/agentRuns: delegate children become subagent Tasks and AgentRuns;
 *   compression continuations never become tasks.
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
  for (const event of messageSessionEvents(input.messages, sessionId, "hermes.normalized-message")) {
    const messageId = event.provenance.sourceId || "";
    const rowId = Number(messageId);
    const anchor = Number.isFinite(rowId) && rowId > 0 ? rowId : null;
    if (anchor == null) {
      events.push(event); // documented fallback: normalized message order, appended
      continue;
    }
    maxRowId = Math.max(maxRowId, anchor);
    pushAnchored(event, anchor);
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
    const ended = asNumber(child.session.timeUpdated) ?? asNumber(child.session.timeCreated);
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
    runs.push(agentRun({
      id: childId,
      sessionId,
      taskId: childId,
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
