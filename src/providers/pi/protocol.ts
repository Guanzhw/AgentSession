import type { Message, RawSession } from "../interface.js";
import { activePiEntries } from "./parser.js";
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
import {
  contextTransformation,
  contextVersion,
  protocolCoverage,
  protocolDomainCoverage,
  usageRecord,
  type ContextTransformation,
  type ContextVersion,
  type SessionProtocolV3,
  type UsageRecord
} from "../shared/session-protocol-v3.js";

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

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonNegativeInteger(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function piRequestTokens(usage: unknown) {
  if (!usage || typeof usage !== "object") return null;
  const value = usage as Row;
  const input = nonNegativeInteger(value.input);
  const cacheRead = nonNegativeInteger(value.cacheRead);
  const cacheWrite = nonNegativeInteger(value.cacheWrite);
  const rawOutput = nonNegativeInteger(value.output);
  const reasoning = Math.min(rawOutput, nonNegativeInteger(value.reasoning));
  const output = rawOutput - reasoning;
  const normalizedTotal = input + cacheRead + cacheWrite + output + reasoning;
  const explicitTotal = optionalNonNegativeInteger(value.totalTokens);
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    reasoning,
    total: explicitTotal === null
      ? (value.totalTokens === undefined || value.totalTokens === null || value.totalTokens === ""
        ? normalizedTotal
        : null)
      : explicitTotal === normalizedTotal ? explicitTotal : null
  };
}

function isDeferredAssistant(source: Row): boolean {
  return source.stopReason === "deferred"
    || source.stopReason === "pending"
    || source.deferred === true
    || (source.deferred !== undefined && source.deferred !== null && source.deferred !== false);
}

function isZeroRequest(tokens: ReturnType<typeof piRequestTokens>): boolean {
  return Boolean(tokens
    && tokens.input === 0
    && tokens.cacheRead === 0
    && tokens.cacheWrite === 0
    && tokens.output === 0
    && tokens.reasoning === 0);
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
    retainedTailCount: Array.isArray(entry.retainedTail) ? entry.retainedTail.length : null,
    fromHook: typeof entry.fromHook === "boolean" ? entry.fromHook : null,
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
        branch: typeof record.branch === "string" ? record.branch : null,
        // Recorded v3 evidence: materialized retained tail (harness-generated
        // compactions embed it instead of firstKeptEntryId) and extension-vs-
        // pi-owner origin. Both are recorded entry fields; never invented.
        retainedTailCount: compaction.retainedTailCount,
        fromHook: compaction.fromHook
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
        retainedTailCount: compaction.retainedTailCount,
        fromHook: compaction.fromHook,
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

/** Build Pi-native v3 facts over the same finalized v2 snapshot. */
export function buildPiSessionProtocolV3(
  input: PiProtocolInput,
  base: SessionProtocol
): SessionProtocolV3 {
  const sessionId = String(input.session.id);
  const ownRef = { provider: "pi" as const, sessionId };
  const eventsBySourceId = new Map(
    base.events
      .filter((event) => event.kind === "message.assistant")
      .map((event) => [event.provenance.sourceId, event])
  );
  const usageRecords: UsageRecord[] = [];
  const requestIndexByIdentity = new Map<string, number>();

  // Pi stores one assistant message entry per provider request, including
  // entries on abandoned/history branches. Embedded retainedTail messages are
  // not session entries and therefore never reach this loop.
  for (const entry of input.records) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const source = entry.message as Row;
    const tokens = piRequestTokens(source.usage);
    if (!tokens) continue;
    if (isZeroRequest(tokens) && isDeferredAssistant(source)) continue;

    const responseId = nonEmptyString(source.responseId);
    const entryId = nonEmptyString(entry.id);
    const requestIdentity = responseId ? `response:${responseId}` : entryId ? `entry:${entryId}` : null;
    if (!requestIdentity) continue;
    const event = eventsBySourceId.get(String(entry.id)) || null;
    const record = usageRecord({
      id: `usage:${sessionId}:request:${requestIdentity}`,
      scope: "request",
      sessionRef: ownRef,
      timestamp: entryTimestamp(entry),
      model: nonEmptyString(source.responseModel) || nonEmptyString(source.model),
      runId: null,
      eventId: event?.id || null,
      turnId: event?.turnId || null,
      tokens: {
        input: tokens.input,
        cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite,
        output: tokens.output,
        reasoning: tokens.reasoning,
        total: tokens.total
      },
      contextOriginSlices: [],
      provenance: {
        fidelity: "recorded",
        sourceType: "pi.entry:message.assistant.usage",
        sourceId: String(entry.id)
      }
    });
    const existingIndex = requestIndexByIdentity.get(requestIdentity);
    if (existingIndex !== undefined) {
      // A response may appear on more than one stored branch. Prefer the
      // occurrence that belongs to the finalized active conversation, since
      // only that occurrence has a canonical event/turn anchor.
      if (!usageRecords[existingIndex].eventId && record.eventId) usageRecords[existingIndex] = record;
      continue;
    }
    requestIndexByIdentity.set(requestIdentity, usageRecords.length);
    usageRecords.push(record);
  }

  // Only active-branch summaries with readable text prove a result context.
  // The v2 artifacts remain the metadata-only source of the result; no entry
  // id is treated as a parent context version and retainedTail is count-only.
  const activeSummaryEntries = activePiEntries(input.records)
    .filter((entry) => (entry.type === "compaction" || entry.type === "branch_summary")
      && typeof entry.summary === "string" && entry.summary.trim());
  const artifactBySourceId = new Map(
    base.contextArtifacts
      .map((artifact) => [artifact.provenance.sourceId, artifact])
  );
  const contextVersions: ContextVersion[] = [];
  const contextTransformations: ContextTransformation[] = [];
  for (const entry of activeSummaryEntries) {
    const sourceId = String(entry.id);
    const artifact = artifactBySourceId.get(sourceId) || null;
    const event = base.events.find((candidate) => (
      candidate.kind === "context.compaction" && candidate.provenance.sourceId === sourceId
    )) || null;
    if (!artifact || !event) continue;
    const versionId = `context-version:pi:${sourceId}`;
    contextVersions.push(contextVersion({
      id: versionId,
      sessionId,
      sequence: event.sequence,
      parentVersionIds: [],
      artifactIds: [artifact.id],
      createdAt: entryTimestamp(entry),
      provenance: {
        fidelity: "recorded",
        sourceType: `pi.entry:${String(entry.type)}`,
        sourceId
      }
    }));
    contextTransformations.push(contextTransformation({
      id: `context-transformation:pi:${sourceId}`,
      sessionId,
      kind: "compaction",
      sourceVersionIds: [],
      resultVersionId: versionId,
      sourceArtifactIds: [],
      resultArtifactIds: [artifact.id],
      eventId: event.id,
      runId: null,
      turnId: null,
      timestamp: entryTimestamp(entry),
      provenance: {
        fidelity: "recorded",
        sourceType: `pi.entry:${String(entry.type)}`,
        sourceId
      }
    }));
  }

  const hasCompactionOperation = input.records.some((entry) => (
    entry.type === "compaction" || entry.type === "branch_summary"
  ));
  const contextState = contextVersions.length > 0
    ? "observed" as const
    : hasCompactionOperation
      ? "unknown" as const
      : "not-observed" as const;

  return {
    sessionId,
    version: 3,
    session: base.session,
    events: base.events,
    relationships: base.relationships,
    tasks: base.tasks,
    agentRuns: base.agentRuns,
    contextArtifacts: base.contextArtifacts,
    branches: base.branches,
    revision: base.revision,
    goals: [],
    actors: [],
    coordination: [],
    contextVersions,
    contextTransformations,
    usageRecords,
    coverage: protocolCoverage({
      work: protocolDomainCoverage("not-observed", "Pi session entries do not record goals or tasks"),
      execution: protocolDomainCoverage("not-observed", "Pi session entries do not record agent runs"),
      coordination: protocolDomainCoverage("not-observed", "Pi session entries do not record coordination"),
      context: protocolDomainCoverage(contextState, contextState === "observed"
        ? "active Pi compaction and branch_summary summaries produce context results"
        : hasCompactionOperation
          ? "Pi compaction operation exists without an active readable summary result"
          : "no Pi compaction or branch_summary evidence"),
      usage: protocolDomainCoverage(usageRecords.length > 0 ? "observed" : "not-observed", "one request record per distinct Pi assistant response")
    })
  };
}
