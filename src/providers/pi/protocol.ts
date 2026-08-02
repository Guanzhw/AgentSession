import type { Message, RawSession } from "../interface.js";
import {
  compactionEnvelope,
  compactionSummaryArtifact,
  contextCompactionEvent,
  messageSessionEvents,
  sequenceEventsBySource,
  sourceSequence,
  sessionRelationship,
  type SessionProtocol
} from "../shared/session-protocol.js";

type Row = Record<string, any>;

export interface PiProtocolInput {
  session: RawSession;
  records: Row[];
  messages: Message[];
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function entryTimestamp(entry: Row): number | null {
  const value = entry.message?.timestamp ?? entry.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = typeof value === "string" ? new Date(value).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Pi records compaction as in-file `compaction` entries (with or without a
 * plaintext summary) and `branch_summary` entries for abandoned branches.
 * Both are standardized context.compaction events; the entry's summary stays
 * in the compatibility Message view and is never duplicated into artifacts.
 */
export function piCompactionEntry(entry: Row) {
  if (entry?.type !== "compaction" && entry?.type !== "branch_summary") return null;
  const summary = typeof entry.summary === "string" && entry.summary ? entry.summary : null;
  return {
    entry,
    summary,
    trigger: "unknown" as const,
    strategy: summary ? "summary" as const : "opaque" as const,
    tokensBefore: asNumber(Number(entry.tokensBefore) || null),
    tokensAfter: asNumber(Number(entry.tokensAfter) || null),
    retainedFromEventId: typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : null,
    sourceId: typeof entry.id === "string" ? entry.id : null
  };
}

/**
 * Normalized protocol for one Pi session:
 * - events: derived message envelopes plus recorded context.compaction events
 *   for compaction/branch_summary entries, sequenced in entry order (entry
 *   index, then local ordinal: a compaction entry's system message event
 *   follows its context.compaction event). Messages that cannot map to an
 *   entry are appended in normalized message order with derived provenance.
 * - relationships: the header parentSession is a session rotation or an
 *   explicit fork; both are indistinguishable from the file metadata, so it
 *   normalizes to the generic parent relationship with derived provenance.
 * - tasks/agentRuns: Pi session files carry no task abstraction.
 * - contextArtifacts: metadata-only compaction entries.
 */
export function buildPiSessionProtocol(input: PiProtocolInput): SessionProtocol {
  const sessionId = String(input.session.id);
  const header = input.records.find((record) => record.type === "session") || null;
  const compactionEntries = input.records
    .map(piCompactionEntry)
    .filter((compaction): compaction is NonNullable<typeof compaction> => Boolean(compaction));

  // --- Source-order event assembly ---------------------------------------
  // Entries anchor the order. Compaction/branch_summary entries emit a
  // context.compaction event at their entry index; message events anchor at
  // the entry that produced them (entry id; tool messages resolve through
  // their assistant turn's entry id). Unmapped messages are appended in
  // normalized message order (documented fallback, derived provenance).
  const events: ReturnType<typeof compactionEnvelope>[] = [];
  const entryIndex = new Map<string, number>();
  input.records.forEach((record, index) => {
    if (typeof record.id === "string" && record.id && !entryIndex.has(record.id)) {
      entryIndex.set(record.id, index);
    }
  });
  const messageAnchors = new Map<string, number>();
  for (const message of input.messages) {
    let index = entryIndex.get(message.id) ?? null;
    if (index == null && message.role === "tool" && message.metadata?.turnId) {
      index = entryIndex.get(String(message.metadata.turnId)) ?? null;
    }
    if (index != null) messageAnchors.set(message.id, index);
  }

  const ordinalsAt = new Map<number, number>();
  const pushAnchored = (event: ReturnType<typeof compactionEnvelope>, recordIndex: number) => {
    const ordinal = ordinalsAt.get(recordIndex) ?? 0;
    ordinalsAt.set(recordIndex, ordinal + 1);
    events.push({
      ...event,
      providerData: {
        ...(event.providerData || {}),
        sourceSequence: sourceSequence(recordIndex, ordinal)
      }
    });
  };

  input.records.forEach((record, index) => {
    const compaction = piCompactionEntry(record);
    if (!compaction) return;
    pushAnchored(compactionEnvelope({
      id: `event:compaction:${compaction.sourceId || index}`,
      sessionId,
      timestamp: entryTimestamp(record),
      correlationId: compaction.sourceId,
      provenance: {
        fidelity: "recorded",
        sourceType: `pi.entry:${String(record.type)}`,
        sourceId: compaction.sourceId
      },
      providerData: {
        entryType: String(record.type),
        branch: typeof record.branch === "string" ? record.branch : null
      }
    }, contextCompactionEvent({
      trigger: compaction.trigger,
      strategy: compaction.strategy,
      tokensBefore: compaction.tokensBefore,
      tokensAfter: compaction.tokensAfter,
      summary: compaction.summary,
      retainedFromEventId: compaction.retainedFromEventId
    })), index);
  });

  // Derived message envelopes, interleaved at their producing entry.
  for (const event of messageSessionEvents(input.messages, sessionId, "pi.normalized-message")) {
    const recordIndex = event.provenance.sourceId ? messageAnchors.get(event.provenance.sourceId) : null;
    if (recordIndex == null) {
      events.push(event); // documented fallback: normalized message order, appended
      continue;
    }
    pushAnchored(event, recordIndex);
  }

  const relationships = [];
  const parentSessionPath = header?.parentSession;
  const parentId = input.session.parentId;
  if (typeof parentSessionPath === "string" && parentSessionPath && parentId) {
    relationships.push(sessionRelationship({
      type: "parent",
      fromSessionId: String(parentId),
      toSessionId: sessionId,
      timestamp: input.session.timeCreated,
      provenance: {
        fidelity: "derived",
        sourceType: "pi.session.parentSession",
        sourceId: String(parentId)
      },
      details: "Pi header parentSession (session rotation or explicit fork; indistinguishable from file metadata)"
    }));
  }

  const artifacts = compactionEntries.map((compaction) => {
    const entry = compaction.entry;
    return compactionSummaryArtifact({
      id: `artifact:${compaction.sourceId || input.records.indexOf(entry)}`,
      sessionId,
      sourceSessionIds: [sessionId],
      provenance: {
        fidelity: "recorded",
        sourceType: `pi.entry:${String(entry.type)}`,
        sourceId: compaction.sourceId
      },
      timeCreated: entryTimestamp(entry),
      metadata: {
        entryType: String(entry.type),
        retainedFromEventId: compaction.retainedFromEventId,
        tokensBefore: compaction.tokensBefore,
        tokensAfter: compaction.tokensAfter
      }
    });
  });

  return {
    sessionId,
    events: sequenceEventsBySource(events),
    relationships,
    tasks: [],
    agentRuns: [],
    contextArtifacts: artifacts
  };
}
