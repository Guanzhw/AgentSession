import type { Message, RawSession } from "../interface.js";
import {
  agentRun,
  compactionEnvelope,
  compactionSummaryArtifact,
  contextCompactionEvent,
  messageSessionEvents,
  normalizeCompactionStrategy,
  normalizeCompactionTrigger,
  sequenceEventsBySource,
  sessionEvent,
  sessionRelationship,
  sessionTask,
  sourceSequence,
  type ExecutionMode,
  type SessionProtocol,
  type SessionRef
} from "../shared/session-protocol.js";
import {
  actor,
  coordinationObservation,
  contextTransformation,
  contextVersion,
  goal,
  protocolCoverage,
  protocolDomainCoverage,
  usageRecord,
  type Actor,
  type ContextTransformation,
  type ContextVersion,
  type CoordinationKind,
  type CoordinationObservation,
  type CoordinationState,
  type Goal,
  type GoalStatus,
  type ProtocolCoverage,
  type SessionProtocolV3,
  type UsageRecord
} from "../shared/session-protocol-v3.js";
import { isSubagentToolName } from "../shared/subagent-tools.js";
import { codexOwnedTokenUsageRecords, codexUsagePayload } from "./parser.js";

type Row = Record<string, any>;

export interface CodexProtocolChild {
  session: RawSession;
  messages: Message[];
  records: Row[];
}

export interface CodexProtocolInput {
  session: RawSession;
  messages: Message[];
  records: Row[];
  /** Resolved direct child sessions (subagent rollouts/forked threads). */
  children: CodexProtocolChild[];
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Codex persists compaction with several top-level shapes across versions:
 * `compacted`, `context_compacted`, and `contextCompaction` records (some
 * under `event_msg.payload`). Summary is NOT mandatory: older/opaque records
 * carry only token boundaries, so those normalize to the opaque strategy.
 */
export function codexCompactionRecord(record: Row) {
  const recordType = String(record?.type || "");
  const payload = record?.payload && typeof record.payload === "object" ? record.payload : null;
  const payloadType = String(payload?.type || "");
  const normalized = recordType.toLowerCase();
  const payloadNormalized = payloadType.toLowerCase();
  const isCompaction = [
    "compacted", "context_compacted", "contextcompaction", "compact"
  ].includes(normalized) || [
    "compacted", "context_compacted", "contextcompaction", "compact"
  ].includes(payloadNormalized);
  if (!isCompaction) return null;

  const source = payload ?? record;
  const summary = firstString(source.summary, source.message, source.summary_text);
  const strategy = normalizeCompactionStrategy(source.strategy);
  return {
    record,
    summary,
    trigger: normalizeCompactionTrigger(firstString(source.trigger, source.reason) ?? "unknown"),
    strategy: summary
      ? (strategy === "unknown" ? "summary" : strategy)
      : (strategy === "unknown" ? "opaque" : strategy),
    tokensBefore: firstNumber(
      source.tokens_before, source.tokensBefore, source.tokens_before_total, source.tokens_before_context
    ),
    tokensAfter: firstNumber(
      source.tokens_after, source.tokensAfter, source.tokens_after_total, source.tokens_after_context
    ),
    retainedFromEventId: firstString(
      source.first_kept_token_id, source.first_kept_id, source.retained_from_event_id, source.first_kept_entry_id
    ),
    sourceId: firstString(source.id, source.compaction_id, record.id) ?? null,
    windowNumber: firstNumber(source.window_number, source.windowNumber),
    windowId: firstString(source.window_id, source.windowId),
    previousWindowId: firstString(source.previous_window_id, source.previousWindowId),
    firstWindowId: firstString(source.first_window_id, source.firstWindowId)
  };
}

type CodexCompaction = NonNullable<ReturnType<typeof codexCompactionRecord>>;

function codexCompactionShape(record: Row) {
  const recordType = String(record?.type || "").toLowerCase();
  const payloadType = String(record?.payload?.type || "").toLowerCase();
  if (recordType === "compacted") return "top-level-compacted";
  if (recordType === "event_msg" && payloadType === "context_compacted") {
    return "event-context-compacted";
  }
  return null;
}

function codexCompactionExplicitId(record: Row) {
  const payload = record?.payload && typeof record.payload === "object" ? record.payload : null;
  return firstString(payload?.id, payload?.compaction_id, record?.id);
}

function compactionTimestamp(compaction: CodexCompaction) {
  const value = compaction.record?.timestamp;
  if (!value) return null;
  const timestamp = new Date(String(value)).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function mergedCompactionTimestamp(compaction: CodexCompaction & { records?: Row[] }) {
  for (const record of compaction.records || [compaction.record]) {
    const timestamp = record.timestamp ? new Date(String(record.timestamp)).getTime() : NaN;
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

function sameCodexCompaction(left: CodexCompaction, right: CodexCompaction) {
  const leftShape = codexCompactionShape(left.record);
  const rightShape = codexCompactionShape(right.record);
  if (!leftShape || !rightShape || leftShape === rightShape) return false;
  const leftId = codexCompactionExplicitId(left.record);
  const rightId = codexCompactionExplicitId(right.record);
  if (leftId && rightId && leftId === rightId) return true;
  if (leftId && rightId) return false;

  // Codex emits these two records for one operation at the same source
  // position. Without a shared id, the paired native shapes and timestamp
  // are the recorded evidence needed to join them; distant operations stay
  // separate.
  const leftTimestamp = compactionTimestamp(left);
  const rightTimestamp = compactionTimestamp(right);
  if (leftTimestamp == null || rightTimestamp == null || Math.abs(leftTimestamp - rightTimestamp) > 1000) {
    return false;
  }
  return true;
}

function mergeCodexCompactions(group: CodexCompaction[]) {
  const first = group[0];
  const summary = group.map((item) => item.summary).find((value) => value) ?? null;
  const trigger = group.map((item) => item.trigger).find((value) => value !== "unknown") || first.trigger;
  const strategy = summary
    ? (group.some((item) => item.strategy === "summary") ? "summary" : first.strategy)
    : first.strategy;
  return {
    ...first,
    summary,
    trigger,
    strategy,
    tokensBefore: group.map((item) => item.tokensBefore).find((value) => value != null) ?? null,
    tokensAfter: group.map((item) => item.tokensAfter).find((value) => value != null) ?? null,
    retainedFromEventId: group.map((item) => item.retainedFromEventId).find((value) => value) ?? null,
    sourceId: group.map((item) => item.sourceId).find((value) => value) ?? null,
    windowNumber: group.map((item) => item.windowNumber).find((value) => value != null) ?? null,
    windowId: group.map((item) => item.windowId).find((value) => value) ?? null,
    previousWindowId: group.map((item) => item.previousWindowId).find((value) => value) ?? null,
    firstWindowId: group.map((item) => item.firstWindowId).find((value) => value) ?? null,
    records: group.map((item) => item.record)
  };
}

/** Normalize Codex's paired `compacted` and `event_msg.context_compacted`
 * observations into one logical operation while retaining both sources. */
export function codexCompactionEvents(records: Row[]) {
  const candidates = records
    .map((record, index) => ({ compaction: codexCompactionRecord(record), index }))
    .filter((entry): entry is { compaction: CodexCompaction; index: number } => Boolean(entry.compaction));
  const result: Array<CodexCompaction & { records: Row[]; recordIndices: number[] }> = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const current = candidates[index];
    const next = candidates[index + 1];
    const group = next && sameCodexCompaction(current.compaction, next.compaction)
      ? [current.compaction, next.compaction]
      : [current.compaction];
    result.push({
      ...mergeCodexCompactions(group),
      recordIndices: (next && group.length > 1) ? [current.index, next.index] : [current.index]
    });
    if (group.length > 1) index += 1;
  }
  return result;
}

function codexCompactionProvenance(compaction: CodexCompaction & { records?: Row[] }) {
  const records = compaction.records || [compaction.record];
  const sourceTypes = [...new Set(records.map((record) => `codex.${String(record.type || "record")}`))];
  const sourceIds = [...new Set(records.map((record) => codexCompactionRecord(record)?.sourceId).filter(Boolean))];
  return {
    fidelity: "recorded" as const,
    sourceType: sourceTypes.join("+") || "codex.record",
    sourceId: sourceIds[0] || compaction.sourceId || null
  };
}

function codexCompactionSourceEvidence(compaction: CodexCompaction & { records?: Row[] }) {
  return (compaction.records || [compaction.record]).map((record) => ({
    sourceType: `codex.${String(record.type || "record")}`,
    sourceId: codexCompactionRecord(record)?.sourceId || null
  }));
}

function envelopeText(payload: Row): string {
  const content = payload.content ?? payload.message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item: any) => item?.content || [item])
    .filter((item: any) => ["text", "output_text", "input_text", "summary_text"].includes(item?.type))
    .map((item: any) => item.text || "")
    .join("");
}

function isSubagentTaskEnvelopeRecord(record: Row) {
  if (record.type !== "response_item" || record.payload?.type !== "agent_message") return false;
  return /^Message Type:\s*NEW_TASK\b/i.test(envelopeText(record.payload).replace(/\s+/g, " ").trim());
}

function primarySessionMeta(records: Row[]) {
  return records.find((record) => record.type === "session_meta")?.payload || {};
}

function childModel(child: CodexProtocolChild): string | null {
  for (const record of child.records) {
    const payload = record.payload;
    if (record.type === "session_meta" && payload) {
      const model = firstString(payload.model, payload.model_name);
      if (model) return model;
    }
    if (record.type === "turn_context" && payload) {
      const model = firstString(payload.model);
      if (model) return model;
    }
  }
  return null;
}

/**
 * Normalized protocol for one Codex session:
 * - events: one envelope per normalized message (derived) plus recorded
 *   context.compaction and task lifecycle events, sequenced in raw record
 *   order (record index, then local ordinal within the record). Messages
 *   that cannot map to a raw record are appended in normalized message
 *   order with derived provenance.
 * - relationships: spawned (subagent threads) and forked (forked_from_id),
 *   with recorded provenance when a native spawn record exists.
 * - tasks/agentRuns: NEW_TASK envelopes become subagent Tasks; each direct
 *   child session becomes an AgentRun bound to its task when possible.
 * - contextArtifacts: metadata-only compaction records.
 */
export function buildCodexSessionProtocol(input: CodexProtocolInput): SessionProtocol {
  const sessionId = String(input.session.id);
  const primaryMeta = primarySessionMeta(input.records);
  const agentPath = firstString(
    primaryMeta.agent_path,
    primaryMeta.source?.subagent?.thread_spawn?.agent_path,
    input.session.metadata?.agentPath
  );
  const childrenById = new Map(input.children.map((child) => [String(child.session.id), child]));

  // --- Source-order event assembly ---------------------------------------
  // Sequences reflect raw record order. Recorded events (compaction, task
  // lifecycle) anchor at their record index; message events anchor at the
  // record that produced them (exact payload/call ids first, then a content
  // cursor for legacy event_msg records); unmapped messages are appended in
  // normalized message order (documented fallback, derived provenance).
  const events: ReturnType<typeof sessionEvent>[] = [];

  const isUserMessageRecord = (record: Row) => (
    record.type === "event_msg" && record.payload?.type === "user_message"
  );
  const isAgentMessageRecord = (record: Row) => (
    record.type === "event_msg" && record.payload?.type === "agent_message"
  );
  const isAgentReasoningRecord = (record: Row) => (
    record.type === "event_msg" && record.payload?.type === "agent_reasoning"
  );

  // Exact source-id anchors: payload.id / call_id / record.id.
  const idIndex = new Map<string, number>();
  input.records.forEach((record, index) => {
    for (const id of [record.payload?.id, record.payload?.call_id, record.id]) {
      if (typeof id === "string" && id && !idIndex.has(id)) idIndex.set(id, index);
    }
  });

  // Legacy event_msg records produce generated message ids, so claim them
  // with a content cursor: search forward from the last claimed record and
  // match the record text against the normalized message text. This skips
  // records that produced no message (deduplicated or parent-copied ones).
  const normalized = (value: unknown) => String(value || "").replace(/\s+/g, " ").trim();
  const claimByContent = (
    records: Row[],
    cursor: { value: number },
    messageText: string,
    recordText: (record: Row) => unknown
  ): number | null => {
    for (let index = cursor.value; index < records.length; index += 1) {
      if (normalized(recordText(records[index])) !== messageText) continue;
      cursor.value = index + 1;
      return input.records.indexOf(records[index]);
    }
    return null;
  };
  const userCursor = { value: 0 };
  const agentCursor = { value: 0 };
  const reasoningCursor = { value: 0 };
  const userRecords = input.records.filter(isUserMessageRecord);
  const agentRecords = input.records.filter(isAgentMessageRecord);
  const reasoningRecords = input.records.filter(isAgentReasoningRecord);
  const messageAnchors = new Map<string, number>();
  for (const message of input.messages) {
    let recordIndex = idIndex.get(message.id) ?? null;
    if (recordIndex == null && message.role === "user") {
      recordIndex = claimByContent(userRecords, userCursor, normalized(message.content), (record) => record.payload?.message);
    } else if (recordIndex == null && message.metadata?.source === "codex_agent_message") {
      recordIndex = claimByContent(agentRecords, agentCursor, normalized(message.content), (record) => record.payload?.message);
    } else if (recordIndex == null && message.metadata?.source === "codex_agent_reasoning") {
      for (let index = reasoningCursor.value; index < reasoningRecords.length; index += 1) {
        reasoningCursor.value = index + 1;
        recordIndex = input.records.indexOf(reasoningRecords[index]);
        break;
      }
    }
    if (recordIndex != null) messageAnchors.set(message.id, recordIndex);
  }

  // Recorded events keep their record position; message events interleave at
  // the record that produced them, after the record's own lifecycle events.
  const ordinalsAt = new Map<number, number>();
  const pushAnchored = (event: ReturnType<typeof sessionEvent>, recordIndex: number) => {
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

  // Recorded compaction events. Codex may persist one operation twice under
  // two native record shapes; the provider helper joins those observations.
  const envelopeByTaskId = new Map<string, Row>();
  for (const compaction of codexCompactionEvents(input.records)) {
    const recordIndex = Math.min(...compaction.recordIndices);
    const record = compaction.record;
    const ts = mergedCompactionTimestamp(compaction);
    const provenance = codexCompactionProvenance(compaction);
    const sourceEvidence = codexCompactionSourceEvidence(compaction);
    pushAnchored(compactionEnvelope({
      id: `event:compaction:${compaction.sourceId || recordIndex}`,
      sessionId,
      timestamp: asNumber(ts),
      correlationId: compaction.sourceId,
      provenance,
      providerData: {
        tokensBefore: compaction.tokensBefore,
        tokensAfter: compaction.tokensAfter,
        sourceRecordCount: compaction.records?.length || 1,
        sourceEvidence
      }
    }, contextCompactionEvent({
      trigger: compaction.trigger,
      strategy: compaction.strategy,
      tokensBefore: compaction.tokensBefore,
      tokensAfter: compaction.tokensAfter,
      summary: compaction.summary,
      retainedFromEventId: compaction.retainedFromEventId
    })), recordIndex);
  }

  input.records.forEach((record, index) => {
    // Recorded task lifecycle events from NEW_TASK envelopes.
    if (isSubagentTaskEnvelopeRecord(record)) {
      const taskId = firstString(record.payload.id, record.payload.call_id);
      if (taskId) {
        envelopeByTaskId.set(taskId, record);
        const ts = record.timestamp ? new Date(String(record.timestamp)).getTime() : null;
        pushAnchored(sessionEvent({
          id: `event:task:${taskId}`,
          sessionId,
          sequence: 0,
          timestamp: asNumber(ts),
          kind: "task",
          phase: "started",
          correlationId: taskId,
          provenance: {
            fidelity: "recorded",
            sourceType: "codex.response_item:agent_message:NEW_TASK",
            sourceId: taskId
          }
        }), index);
      }
    }
  });

  // Derived message envelopes, interleaved at their producing record.
  for (const event of messageSessionEvents(input.messages, sessionId, "codex.normalized-message")) {
    const recordIndex = event.provenance.sourceId ? messageAnchors.get(event.provenance.sourceId) : null;
    if (recordIndex == null) {
      events.push(event); // documented fallback: normalized message order, appended
      continue;
    }
    pushAnchored(event, recordIndex);
  }

  const relationships: ReturnType<typeof sessionRelationship>[] = [];
  const tasks: ReturnType<typeof sessionTask>[] = [];
  const runs: ReturnType<typeof agentRun>[] = [];

  const parentId = input.session.parentId;
  const forkSource = firstString(primaryMeta.forked_from_id);
  if (forkSource && parentId && String(forkSource) === String(parentId)) {
    relationships.push(sessionRelationship({
      type: "forked",
      fromSessionId: String(forkSource),
      toSessionId: sessionId,
      timestamp: input.session.timeCreated,
      provenance: {
        fidelity: "derived",
        sourceType: "codex.session_meta.forked_from_id",
        sourceId: String(forkSource)
      },
      details: "Codex session_meta forked_from_id"
    }));
  } else if (parentId) {
    const spawn = primaryMeta.source?.subagent?.thread_spawn || {};
    const isSubagentThread = String(primaryMeta.thread_source || "") === "subagent"
      || Boolean(spawn.parent_thread_id);
    relationships.push(sessionRelationship({
      type: isSubagentThread ? "spawned" : "parent",
      fromSessionId: String(parentId),
      toSessionId: sessionId,
      timestamp: input.session.timeCreated,
      correlationId: firstString(spawn.call_id, spawn.parent_response_id) ?? null,
      provenance: {
        fidelity: isSubagentThread ? "recorded" : "derived",
        sourceType: isSubagentThread
          ? "codex.session_meta.source.subagent.thread_spawn"
          : "codex.session_meta.parent_thread_id",
        sourceId: String(parentId)
      },
      details: isSubagentThread ? "Codex subagent thread" : "Codex parent_thread_id"
    }));
  }

  // NEW_TASK envelopes -> Tasks; child rollouts -> AgentRuns.
  const envelopeTextOf = (record: Row) => envelopeText(record.payload).replace(/\s+/g, " ").trim();
  for (const [taskId, record] of envelopeByTaskId) {
    const ts = record.timestamp ? new Date(String(record.timestamp)).getTime() : null;
    const text = envelopeTextOf(record);
    const run = input.children.find((child) => {
      const childEnvelope = (child.records || []).find(isSubagentTaskEnvelopeRecord);
      const childTaskId = childEnvelope?.payload ? firstString(childEnvelope.payload.id, childEnvelope.payload.call_id) : null;
      if (childTaskId === taskId) return true;
      const nickname = child.session.metadata?.agentNickname;
      const path = child.session.metadata?.agentPath;
      return Boolean(
        (nickname && text.includes(String(nickname)))
        || (path && text.includes(String(path)))
      );
    });
    const runAgentPath = run
      ? firstString(run.session.metadata?.agentPath, run.session.metadata?.agentNickname)
      : null;
    tasks.push(sessionTask({
      id: taskId,
      sessionId,
      kind: "subagent-task",
      status: run ? "completed" : "running",
      title: null,
      toolCallId: taskId,
      correlationId: taskId,
      agentPath: runAgentPath || agentPath,
      timeCreated: asNumber(ts),
      timeUpdated: run ? asNumber(run.session.timeUpdated) : asNumber(ts),
      timeCompleted: run ? asNumber(run.session.timeUpdated) : null,
      provenance: {
        fidelity: "recorded",
        sourceType: "codex.response_item:agent_message:NEW_TASK",
        sourceId: taskId
      }
    }));
    if (run) {
      runs.push(agentRun({
        id: String(run.session.id),
        sessionId,
        taskId,
        status: "completed",
        mode: "subagent",
        agent: runAgentPath || firstString(run.session.metadata?.agentPath, run.session.metadata?.agentNickname),
        model: childModel(run),
        childSessionId: String(run.session.id),
        timeStart: asNumber(run.session.timeCreated),
        timeEnd: asNumber(run.session.timeUpdated),
        provenance: {
          fidelity: "derived",
          sourceType: "codex.child-session",
          sourceId: String(run.session.id)
        },
        metadata: {
          agentNickname: run.session.metadata?.agentNickname || null,
          threadSource: run.session.metadata?.threadSource || null
        }
      }));
    }
  }

  // --- Spawn tool-call evidence -------------------------------------------
  // Parent transcripts record the spawn as a tool call rather than an
  // envelope. Codex binds a spawn function_call to its child thread through
  // recorded sub_agent_activity events (event_id = call id, agent_thread_id
  // = child session id, agent_path) and the matching function_call_output
  // record. Tasks/AgentRuns/relationships are derived from that evidence
  // first; the call's own input/output is the fallback for older transcripts.
  // Execution mode is only ever taken from source evidence (a recorded mode
  // field); background is never invented.
  const subagentActivityByEventId = new Map<string, {
    eventId: string;
    agentThreadId: string | null;
    agentPath: string | null;
    agentLabel: string | null;
    kind: string | null;
    mode: ExecutionMode | null;
    timestamp: number | null;
    terminalTimestamp: number | null;
  }>();
  const executionModes = new Set<ExecutionMode>([
    "foreground", "background", "subagent", "scheduled", "team"
  ]);
  const terminalActivityKinds = new Set([
    "completed", "failed", "cancelled", "canceled", "shutdown", "stopped"
  ]);
  for (const record of input.records) {
    const payload = record.payload && typeof record.payload === "object" ? record.payload : null;
    const isActivityRecord = record.type === "sub_agent_activity"
      || (record.type === "event_msg" && payload?.type === "sub_agent_activity");
    if (!isActivityRecord) continue;
    const source = payload && Object.keys(payload).length > 1 ? payload : record;
    const eventId = firstString(source.event_id, source.id);
    if (!eventId) continue;
    const rawMode = firstString(source.mode, source.execution_mode);
    const normalizedMode = rawMode ? String(rawMode).toLowerCase() : null;
    const mode = normalizedMode && executionModes.has(normalizedMode as ExecutionMode)
      ? normalizedMode as ExecutionMode
      : null;
    const ts = typeof source.occurred_at_ms === "number"
      ? source.occurred_at_ms
      : (record.timestamp ? new Date(String(record.timestamp)).getTime() : null);
    const kind = firstString(source.kind, source.activity_type, source.status);
    const previous = subagentActivityByEventId.get(eventId);
    subagentActivityByEventId.set(eventId, {
      eventId,
      agentThreadId: previous?.agentThreadId || firstString(source.agent_thread_id, source.thread_id),
      agentPath: previous?.agentPath || firstString(source.agent_path),
      agentLabel: previous?.agentLabel || firstString(source.agent_label),
      kind: kind || previous?.kind || null,
      mode: previous?.mode || mode,
      timestamp: previous?.timestamp || asNumber(ts),
      terminalTimestamp: kind && terminalActivityKinds.has(kind.toLowerCase())
        ? asNumber(ts)
        : previous?.terminalTimestamp || null
    });
  }

  const callOutputByCallId = new Map<string, string>();
  for (const record of input.records) {
    if (record.type !== "response_item") continue;
    if (!["function_call_output", "custom_tool_call_output"].includes(record.payload?.type)) continue;
    const callId = firstString(record.payload.call_id, record.payload.id);
    if (!callId || record.payload.output == null) continue;
    callOutputByCallId.set(
      callId,
      typeof record.payload.output === "string"
        ? record.payload.output
        : JSON.stringify(record.payload.output)
    );
  }

  const childIdentityParts = (child: CodexProtocolChild) => {
    const meta = child.session.metadata || {};
    return [String(child.session.id), meta.agentPath, meta.agentNickname]
      .filter((value): value is string => typeof value === "string" && Boolean(value));
  };

  const findChildForSpawn = (callId: string | null, record: Row): CodexProtocolChild | null => {
    const activity = callId ? subagentActivityByEventId.get(callId) : null;
    const callOutput = callId ? callOutputByCallId.get(callId) : null;
    let referenceText = "";
    try {
      referenceText = JSON.stringify([record.payload?.arguments ?? record.payload?.input, record.payload?.output]);
    } catch {
      referenceText = String(record.payload?.arguments ?? record.payload?.input ?? "");
    }
    return input.children.find((child) => {
      const identities = childIdentityParts(child);
      if (activity) {
        // The activity record names the child thread directly.
        if (activity.agentThreadId && identities.includes(activity.agentThreadId)) return true;
        const activityIdentity = firstString(activity.agentPath, activity.agentLabel);
        if (activityIdentity && identities.some((identity) => (
          identity.includes(activityIdentity) || activityIdentity.includes(identity)
        ))) return true;
      }
      // The call-output record carries the returned child identity.
      if (callOutput && identities.some((identity) => callOutput.includes(identity))) return true;
      // Fallback: the call's own arguments/output text mentions the child.
      return identities.some((identity) => referenceText.includes(identity));
    }) ?? null;
  };

  const terminalAgentMessageTime = (child: CodexProtocolChild): number | null => {
    const identities = childIdentityParts(child);
    const findTerminal = (records: Row[], requireAuthorMatch: boolean): number | null => {
      for (const record of records) {
        if (record.type !== "response_item" || record.payload?.type !== "agent_message") continue;
        const author = firstString(record.payload.author, record.payload.sender);
        if (requireAuthorMatch && (!author || !identities.some((identity) => (
          identity === author || identity.endsWith(`/${author}`) || author.endsWith(`/${identity}`)
        )))) continue;
        if (!/^Message Type:\s*FINAL_ANSWER\b/m.test(envelopeText(record.payload))) continue;
        return record.timestamp ? asNumber(new Date(String(record.timestamp)).getTime()) : null;
      }
      return null;
    };
    const parentTime = findTerminal(input.records, true);
    if (parentTime != null) return parentTime;
    // Some Codex versions persist FINAL_ANSWER only inside the child rollout.
    // Its transcript identity already scopes the evidence, so no author field
    // is required for this fallback.
    return findTerminal(child.records || [], false);
  };

  const spawnCalls = input.records.filter((record) => (
    record.type === "response_item"
    && (record.payload?.type === "function_call" || record.payload?.type === "custom_tool_call")
    && isSubagentToolName(record.payload?.name)
  ));
  for (const [index, record] of spawnCalls.entries()) {
    const callId = firstString(record.payload.call_id, record.payload.id);
    const taskId = callId || `spawn-${index}`;
    // A recorded NEW_TASK envelope is the canonical task for this call; do
    // not double-represent it.
    if (tasks.some((task) => task.id === taskId || task.toolCallId === taskId)) continue;
    const ts = record.timestamp ? new Date(String(record.timestamp)).getTime() : null;
    const activity = callId ? subagentActivityByEventId.get(callId) : null;
    const run = findChildForSpawn(callId, record);
    if (run && runs.some((candidate) => candidate.childSessionId === String(run.session.id))) continue;
    const terminalMessageTime = run ? terminalAgentMessageTime(run) : null;
    const completionTime = activity?.terminalTimestamp || terminalMessageTime;
    // A spawn call's immediate function_call_output only proves that launch
    // returned. Completion requires a terminal activity or FINAL_ANSWER.
    const completed = Boolean(completionTime);
    tasks.push(sessionTask({
      id: taskId,
      sessionId,
      kind: "subagent-task",
      status: completed ? "completed" : "running",
      title: null,
      toolCallId: callId,
      correlationId: callId,
      agentPath: run
        ? firstString(run.session.metadata?.agentPath, run.session.metadata?.agentNickname)
        : firstString(activity?.agentPath, activity?.agentLabel, record.payload.name),
      timeCreated: asNumber(activity?.timestamp ?? ts),
      timeUpdated: completionTime || (run ? asNumber(run.session.timeUpdated) : asNumber(activity?.timestamp ?? ts)),
      timeCompleted: completionTime,
      provenance: {
        fidelity: activity ? "recorded" : "derived",
        sourceType: activity
          ? "codex.sub_agent_activity"
          : "codex.response_item:function_call:spawn",
        sourceId: activity?.eventId ?? callId
      },
      metadata: activity ? { activityKind: activity.kind } : null
    }));
    if (run) {
      runs.push(agentRun({
        id: String(run.session.id),
        sessionId,
        taskId,
        status: completed ? "completed" : "running",
        mode: activity?.mode ?? "subagent",
        agent: firstString(run.session.metadata?.agentPath, run.session.metadata?.agentNickname),
        model: childModel(run),
        childSessionId: String(run.session.id),
        timeStart: asNumber(run.session.timeCreated),
        timeEnd: completionTime,
        provenance: {
          fidelity: "derived",
          sourceType: "codex.child-session",
          sourceId: String(run.session.id)
        },
        metadata: {
          agentNickname: run.session.metadata?.agentNickname || null,
          threadSource: run.session.metadata?.threadSource || null
        }
      }));
    }
  }

  // Child sessions without a task bound by envelope or spawn evidence still
  // represent agent runs (older rollouts) or forks. Subagent threads yield a
  // run; forks do not.
  for (const child of input.children) {
    const childId = String(child.session.id);
    const childMeta = child.session.metadata || {};
    const isFork = childMeta.inheritedContext
      && !childMeta.agentPath
      && !childMeta.agentNickname
      && !(child.records || []).some(isSubagentTaskEnvelopeRecord);
    if (isFork) continue;
    if (runs.some((run) => run.childSessionId === childId)) continue;
    if (childrenById.has(childId) && !runs.some((run) => run.childSessionId === childId)) {
      // No task bound by envelope or spawn evidence: derive the run from the
      // child rollout itself (older transcripts).
      runs.push(agentRun({
        id: childId,
        sessionId,
        taskId: null,
        status: "completed",
        mode: "subagent",
        agent: firstString(childMeta.agentPath, childMeta.agentNickname),
        model: childModel(child),
        childSessionId: childId,
        timeStart: asNumber(child.session.timeCreated),
        timeEnd: asNumber(child.session.timeUpdated),
        provenance: {
          fidelity: "derived",
          sourceType: "codex.child-session",
          sourceId: childId
        }
      }));
    }
  }

  // Outgoing edges: the session itself spawned these rollouts or forked from
  // them. The relationship's correlationId binds to the derived task when one
  // exists.
  for (const child of input.children) {
    const childParentId = child.session.parentId;
    if (!childParentId || String(childParentId) !== sessionId) continue;
    const childId = String(child.session.id);
    const childMeta = child.session.metadata || {};
    const isFork = childMeta.inheritedContext
      && !childMeta.agentPath
      && !childMeta.agentNickname
      && !(child.records || []).some(isSubagentTaskEnvelopeRecord);
    const task = tasks.find((candidate) => (
      runs.some((run) => run.childSessionId === childId && run.taskId === candidate.id)
    ));
    relationships.push(sessionRelationship({
      type: isFork ? "forked" : "spawned",
      fromSessionId: sessionId,
      toSessionId: childId,
      timestamp: asNumber(child.session.timeCreated),
      correlationId: isFork ? null : (task?.toolCallId || task?.id || null),
      provenance: {
        fidelity: "derived",
        sourceType: isFork
          ? "codex.session_meta.forked_from_id"
          : "codex.session_meta.parent_thread_id",
        sourceId: childId
      },
      details: isFork ? "Codex forked session" : "Codex subagent rollout"
    }));
  }

  const artifacts = codexCompactionEvents(input.records).map((compaction) => {
    const record = compaction.record;
    const ts = mergedCompactionTimestamp(compaction);
    const provenance = codexCompactionProvenance(compaction);
    const sourceEvidence = codexCompactionSourceEvidence(compaction);
    return compactionSummaryArtifact({
      id: `artifact:${compaction.sourceId || compaction.recordIndices[0]}`,
      sessionId,
      sourceSessionIds: [sessionId],
      provenance,
      timeCreated: asNumber(ts),
      metadata: {
        retainedFromEventId: compaction.retainedFromEventId,
        trigger: compaction.trigger,
        strategy: compaction.strategy,
        tokensBefore: compaction.tokensBefore,
        tokensAfter: compaction.tokensAfter,
        sourceRecordCount: compaction.records?.length || 1,
        sourceEvidence
      }
    });
  });

  return {
    sessionId,
    events: sequenceEventsBySource(events),
    relationships,
    tasks,
    agentRuns: runs,
    contextArtifacts: artifacts
  };
}

// ---------------------------------------------------------------------------
// Native Session Protocol v3 facts.
//
// The recorded Codex shapes mapped below were verified against real
// `0.151.0-alpha.7.2` rollouts: `event_msg/thread_goal_updated` (goal
// lifecycle), the `collaboration` subagent tool family (`spawn_agent`,
// `followup_task`, `send_message`, `wait_agent`/`wait`, `interrupt_agent`),
// `response_item/agent_message` FINAL_ANSWER envelopes (result delivery), the
// `compacted` window chain (`window_id`/`previous_window_id`), and
// `event_msg/token_count` request usage. Unknown or absent evidence stays
// explicit; nothing is synthesized from entity counts.
// ---------------------------------------------------------------------------

const CODEX_COORDINATION_KINDS: Record<string, CoordinationKind> = {
  spawn_agent: "spawn",
  followup_task: "follow-up",
  send_message: "message",
  send_input: "message",
  resume_agent: "follow-up",
  wait_agent: "wait",
  wait: "wait",
  interrupt_agent: "interrupt",
  // The legacy v1 `multi_agent_v1/close_agent` operation has no distinct v3
  // kind; retain its lifecycle as the closest interrupt observation.
  close_agent: "interrupt"
};

const CODEX_COORDINATION_NAMESPACES = new Set(["collaboration", "multi_agent", "multi_agents", "multi_agent_v1"]);

/** Only four recorded statuses map onto the protocol vocabulary; Codex's
 * `paused` is a user suspension, not the protocol `blocked` semantics, so it
 * stays `unknown` rather than inventing a meaning. */
const CODEX_GOAL_STATUSES: Record<string, GoalStatus> = {
  active: "active",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled"
};

function callArgumentsOf(record: Row): Row {
  const raw = record.payload?.arguments ?? record.payload?.input;
  if (typeof raw === "string") {
    try { return JSON.parse(raw) || {}; } catch { return {}; }
  }
  return raw && typeof raw === "object" ? raw : {};
}

function closeAgentOutputState(records: Row[], callId: string): CoordinationState | null {
  const outputRecord = records.find((candidate) => (
    candidate.type === "response_item"
      && (candidate.payload?.type === "function_call_output" || candidate.payload?.type === "custom_tool_call_output")
      && firstString(candidate.payload?.call_id, candidate.payload?.id) === callId
  ));
  if (!outputRecord) return null;
  let output = outputRecord.payload?.output;
  if (typeof output === "string") {
    const trimmed = output.trim();
    if (!trimmed) return "unknown";
    try { output = JSON.parse(trimmed); } catch { return "unknown"; }
  }
  if (!output || typeof output !== "object") return "unknown";
  if (output.success === true) return "completed";
  if (output.success === false) return "failed";
  const status = firstString(output.status, output.state, output.result, output.error)?.toLowerCase();
  if (["completed", "complete", "success", "succeeded", "closed", "done", "ok"].includes(status || "")) return "completed";
  if (["failed", "failure", "error", "errored"].includes(status || "")) return "failed";
  return "unknown";
}

function passthroughTurnId(record: Row): string | null {
  return firstString(record.payload?.internal_chat_message_metadata_passthrough?.turn_id);
}

function isAgentEnvelope(record: Row): record is Row & { payload: { id?: unknown; author?: unknown; recipient?: unknown } } {
  return record.type === "response_item" && record.payload?.type === "agent_message";
}

function isFinalAnswerEnvelope(record: Row): boolean {
  return isAgentEnvelope(record) && /^Message Type:\s*FINAL_ANSWER\b/m.test(envelopeText(record.payload).replace(/\s+/g, " ").trim());
}

function recordTimestamp(record: Row): number | null {
  const ts = record.timestamp ? new Date(String(record.timestamp)).getTime() : NaN;
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Build native Session Protocol v3 facts over a finalized v2 snapshot for one
 * Codex session. `base` must be the finalized v2 snapshot built from the same
 * input; every v2 fact is preserved verbatim, and v3 facts come only from
 * recorded evidence present in `input.records`.
 */
export function buildCodexSessionProtocolV3(input: CodexProtocolInput, base: SessionProtocol): SessionProtocolV3 {
  const sessionId = String(input.session.id);
  const ownRef = { provider: "codex", sessionId };
  const primaryMeta = primarySessionMeta(input.records);
  const childById = new Map(input.children.map((child) => [String(child.session.id), child]));
  const runByChildId = new Map(base.agentRuns.map((run) => [String(run.childSessionId), run]));

  // --- Actors --------------------------------------------------------------
  // Parent identity: `session_meta.agent_path` when recorded, otherwise the
  // recipient of child FINAL_ANSWER envelopes (the recorded "/root" path).
  const parentMetaPath = firstString(primaryMeta.agent_path);
  let parentPath: string | null = parentMetaPath;
  if (!parentPath) {
    for (const record of input.records) {
      if (!isFinalAnswerEnvelope(record)) continue;
      const author = firstString(record.payload.author);
      const recipient = firstString(record.payload.recipient);
      if (!author || !recipient) continue;
      const childMatches = input.children.some((child) => (
        firstString(child.session.metadata?.agentPath, child.session.metadata?.agentNickname) === author
      ));
      if (childMatches) { parentPath = recipient; break; }
    }
  }

  const actors: Actor[] = [];
  const actorIdByPath = new Map<string, string>();
  const parentActorId = `actor:${sessionId}`;
  actors.push(actor({
    id: parentActorId,
    kind: "agent",
    name: parentPath,
    providerActorId: parentPath,
    sessionRef: ownRef,
    runIds: [],
    provenance: parentMetaPath
      ? { fidelity: "recorded", sourceType: "codex.session_meta.agent_path", sourceId: parentMetaPath }
      : parentPath
        ? { fidelity: "recorded", sourceType: "codex.response_item:agent_message:recipient", sourceId: parentPath }
        : { fidelity: "derived", sourceType: "codex.session", sourceId: sessionId }
  }));
  if (parentPath) actorIdByPath.set(parentPath, parentActorId);

  for (const child of input.children) {
    const childId = String(child.session.id);
    const childPath = firstString(child.session.metadata?.agentPath, child.session.metadata?.agentNickname);
    const run = runByChildId.get(childId);
    if (childPath) actorIdByPath.set(childPath, `actor:${childId}`);
    actors.push(actor({
      id: `actor:${childId}`,
      kind: "agent",
      name: childPath,
      providerActorId: childPath,
      sessionRef: { provider: "codex", sessionId: childId },
      runIds: run ? [childId] : [],
      provenance: { fidelity: "recorded", sourceType: "codex.session_meta", sourceId: childId }
    }));
  }

  // Paths that appear only as agent-message senders/recipients still identify
  // recorded agents (grandchildren, reviews); they carry no session ref.
  for (const record of input.records) {
    if (!isAgentEnvelope(record)) continue;
    for (const path of [record.payload.author, record.payload.recipient]) {
      const value = firstString(path);
      if (!value || actorIdByPath.has(value)) continue;
      const id = `actor:path:${value}`;
      actorIdByPath.set(value, id);
      actors.push(actor({
        id,
        kind: "agent",
        name: value,
        providerActorId: value,
        sessionRef: null,
        runIds: [],
        provenance: { fidelity: "recorded", sourceType: "codex.response_item:agent_message", sourceId: firstString(record.payload.id) ?? value }
      }));
    }
  }

  // Current Codex v2 persists communication between agents as a first-class
  // rollout item rather than a model-visible agent_message envelope.
  for (const record of input.records) {
    if (record.type !== "inter_agent_communication") continue;
    const paths = [
      record.payload?.author,
      record.payload?.recipient,
      ...(Array.isArray(record.payload?.other_recipients) ? record.payload.other_recipients : [])
    ];
    for (const path of paths) {
      const value = firstString(path);
      if (!value || actorIdByPath.has(value)) continue;
      const id = `actor:path:${value}`;
      actorIdByPath.set(value, id);
      actors.push(actor({
        id,
        kind: "agent",
        name: value,
        providerActorId: value,
        sessionRef: null,
        runIds: [],
        provenance: { fidelity: "recorded", sourceType: "codex.inter_agent_communication", sourceId: firstString(record.payload?.id) ?? value }
      }));
    }
  }

  // --- Goals ---------------------------------------------------------------
  const goalUpdates = new Map<string, { objective: string | null; status: string; createdAtMs: number | null; updatedAtMs: number | null }>();
  for (const record of input.records) {
    if (record.type !== "event_msg" || record.payload?.type !== "thread_goal_updated") continue;
    const goalPayload = record.payload?.goal;
    const threadId = firstString(record.payload?.threadId, goalPayload?.threadId);
    if (!threadId) continue;
    const status = String(goalPayload?.status || "unknown");
    const createdAtMs = typeof goalPayload?.createdAt === "number" ? goalPayload.createdAt * 1000 : null;
    const updatedAtMs = typeof goalPayload?.updatedAt === "number" ? goalPayload.updatedAt * 1000 : null;
    const previous = goalUpdates.get(threadId);
    goalUpdates.set(threadId, {
      objective: firstString(goalPayload?.objective) ?? previous?.objective ?? null,
      status,
      createdAtMs: previous?.createdAtMs ?? createdAtMs,
      updatedAtMs: updatedAtMs ?? previous?.updatedAtMs ?? null
    });
  }
  const goals: Goal[] = [...goalUpdates].map(([threadId, update]) => goal({
    id: `goal:${threadId}`,
    sessionId,
    title: null,
    description: update.objective,
    status: CODEX_GOAL_STATUSES[update.status] ?? "unknown",
    taskIds: [],
    timeCreated: update.createdAtMs,
    timeUpdated: update.updatedAtMs,
    timeCompleted: update.status === "completed" ? update.updatedAtMs : null,
    provenance: { fidelity: "recorded", sourceType: "codex.event_msg:thread_goal_updated", sourceId: threadId }
  }));

  // --- Coordination ---------------------------------------------------------
  const observations: CoordinationObservation[] = [];
  const bindTarget = (target: string | null, callId: string): { taskId: string | null; runId: string | null; recipientActorId: string | null; toSessionRef: SessionRef | null } => {
    // Exact recorded identity first: the call's own id binds its v2 task.
    let task = base.tasks.find((candidate) => candidate.toolCallId === callId || candidate.correlationId === callId) ?? null;
    if (!task && target) {
      // Recorded task-name evidence: exact agent path, then the path's
      // task-name suffix. Ambiguous matches stay unbound rather than guessed.
      const exact = base.tasks.filter((candidate) => candidate.agentPath === target);
      const suffix = base.tasks.filter((candidate) => {
        const agentPath = candidate.agentPath || "";
        return Boolean(agentPath && agentPath.endsWith(`/${target}`));
      });
      const candidates = exact.length > 0 ? exact : suffix;
      task = candidates.length === 1 ? candidates[0] : null;
    }
    const run = task ? base.agentRuns.find((candidate) => candidate.taskId === task?.id) ?? null : null;
    const child = run ? childById.get(String(run.childSessionId)) : undefined;
    const recipientPath = run?.agent ?? child?.session.metadata?.agentPath ?? child?.session.metadata?.agentNickname ?? null;
    return {
      taskId: task?.id ?? null,
      runId: run?.id ?? null,
      recipientActorId: recipientPath ? actorIdByPath.get(String(recipientPath)) ?? null : null,
      toSessionRef: run ? { provider: "codex", sessionId: String(run.childSessionId) } : null
    };
  };

  for (const [index, record] of input.records.entries()) {
    if (record.type !== "response_item") continue;
    if (record.payload?.type !== "function_call" && record.payload?.type !== "custom_tool_call") continue;
    // Only the recorded collaboration namespaces are the subagent tool
    // families; same-named tools elsewhere (e.g. cell `wait`) are not
    // coordination.
    if (!CODEX_COORDINATION_NAMESPACES.has(String(record.payload?.namespace || ""))) continue;
    const name = String(record.payload?.name ?? "");
    const kind = CODEX_COORDINATION_KINDS[name];
    if (!kind) continue;
    const callId = firstString(record.payload?.call_id, record.payload?.id) ?? `collab-${index}`;
    const argumentsValue = callArgumentsOf(record);
    const target = firstString(argumentsValue.target, argumentsValue.task_name, argumentsValue.taskName);
    const bound = bindTarget(target, callId);
    const hasOutput = input.records.some((candidate) => (
      candidate.type === "response_item"
      && (candidate.payload?.type === "function_call_output" || candidate.payload?.type === "custom_tool_call_output")
      && firstString(candidate.payload?.call_id, candidate.payload?.id) === callId
    ));
    const closeState = name === "close_agent" ? closeAgentOutputState(input.records, callId) : null;
    observations.push(coordinationObservation({
      id: `coord:${kind}:${callId}`,
      sessionId,
      kind,
      state: kind === "spawn"
        ? (bound.toSessionRef || hasOutput ? "started" : "requested")
        : name === "close_agent"
          ? (closeState ?? "requested")
          : "unknown",
      timestamp: recordTimestamp(record),
      senderActorId: parentActorId,
      recipientActorId: bound.recipientActorId,
      fromSessionRef: null,
      toSessionRef: bound.toSessionRef,
      relationshipType: kind === "spawn" && bound.toSessionRef ? "spawned" : null,
      taskId: bound.taskId,
      runId: bound.runId,
      eventId: null,
      turnId: passthroughTurnId(record),
      correlationId: callId,
      provenance: {
        fidelity: "recorded",
        sourceType: `codex.response_item:${String(record.payload?.type)}:${String(record.payload?.namespace)}`,
        sourceId: callId
      }
    }));
  }

  // Current Codex v2 persists inter-agent communication as a first-class
  // item. The item identifies the sender and recipient, but does not carry an
  // acknowledgement, so delivery remains unknown at this boundary.
  for (const [index, record] of input.records.entries()) {
    if (record.type !== "inter_agent_communication") continue;
    const author = firstString(record.payload?.author);
    const recipient = firstString(record.payload?.recipient);
    observations.push(coordinationObservation({
      id: `coord:message:${firstString(record.payload?.id) ?? index}`,
      sessionId,
      kind: "message",
      state: "unknown",
      timestamp: recordTimestamp(record),
      senderActorId: author ? actorIdByPath.get(author) ?? null : null,
      recipientActorId: recipient ? actorIdByPath.get(recipient) ?? null : null,
      fromSessionRef: null,
      toSessionRef: null,
      relationshipType: null,
      taskId: null,
      runId: null,
      eventId: null,
      turnId: passthroughTurnId(record),
      correlationId: firstString(record.payload?.id),
      provenance: {
        fidelity: "recorded",
        sourceType: "codex.inter_agent_communication",
        sourceId: firstString(record.payload?.id) ?? String(index)
      }
    }));
  }

  for (const [index, record] of input.records.entries()) {
    if (!isFinalAnswerEnvelope(record)) continue;
    const author = firstString(record.payload.author);
    const recipient = firstString(record.payload.recipient);
    const senderActorId = author ? actorIdByPath.get(author) ?? null : null;
    if (!author || !senderActorId) continue;
    // Self-authored FINAL_ANSWER envelopes (author == recipient) are summary
    // bodies, not delivery from another agent, regardless of the resolved
    // parent path (parentPath may be unresolvable or differ).
    if (author === recipient) continue;
    const child = input.children.find((candidate) => (
      firstString(candidate.session.metadata?.agentPath, candidate.session.metadata?.agentNickname) === author
    )) ?? null;
    const run = child ? runByChildId.get(String(child.session.id)) ?? null : null;
    const taskId = run?.taskId ?? null;
    observations.push(coordinationObservation({
      id: `coord:result-delivery:${firstString(record.payload.id) ?? `envelope-${index}`}`,
      sessionId,
      kind: "result-delivery",
      state: "delivered",
      timestamp: recordTimestamp(record),
      senderActorId,
      recipientActorId: recipient ? actorIdByPath.get(recipient) ?? parentActorId : parentActorId,
      fromSessionRef: child ? { provider: "codex", sessionId: String(child.session.id) } : null,
      toSessionRef: ownRef,
      relationshipType: null,
      taskId,
      runId: run?.id ?? null,
      eventId: null,
      turnId: passthroughTurnId(record),
      correlationId: firstString(record.payload.id) ?? null,
      provenance: { fidelity: "recorded", sourceType: "codex.response_item:agent_message:FINAL_ANSWER", sourceId: firstString(record.payload.id) ?? author }
    }));
  }

  // --- Context versions and transformations ---------------------------------
  const versionMeta = new Map<string, { sequence: number | null; parent: string | null; createdAt: number | null }>();
  const touchVersion = (id: string, sequence: number | null, createdAt: number | null) => {
    const entry = versionMeta.get(id) ?? { sequence: null, parent: null, createdAt: null };
    if (sequence != null) entry.sequence = sequence;
    if (createdAt != null && (entry.createdAt == null || createdAt < entry.createdAt)) entry.createdAt = createdAt;
    versionMeta.set(id, entry);
  };
  const compactions = codexCompactionEvents(input.records);
  for (const compaction of compactions) {
    const timestamp = mergedCompactionTimestamp(compaction);
    const previousId = compaction.previousWindowId ?? null;
    const windowId = compaction.windowId ?? null;
    if (previousId) touchVersion(previousId, null, null);
    if (windowId) {
      touchVersion(windowId, compaction.windowNumber ?? null, timestamp);
      if (previousId && windowId !== previousId) {
        const entry = versionMeta.get(windowId);
        if (entry) entry.parent = previousId;
      }
    }
  }
  const contextVersions: ContextVersion[] = [...versionMeta].map(([id, meta]) => contextVersion({
    id,
    sessionId,
    sequence: meta.sequence,
    parentVersionIds: meta.parent ? [meta.parent] : [],
    artifactIds: [],
    createdAt: meta.createdAt,
    provenance: { fidelity: "recorded", sourceType: "codex.compacted.window_id", sourceId: id }
  }));
  const contextTransformations: ContextTransformation[] = compactions.map((compaction) => {
    const recordIndex = Math.min(...compaction.recordIndices);
    return contextTransformation({
      id: `ctx-transform:compaction:${compaction.sourceId || recordIndex}`,
      sessionId,
      kind: "compaction",
      sourceVersionIds: compaction.previousWindowId ? [compaction.previousWindowId] : [],
      resultVersionId: compaction.windowId ?? null,
      sourceArtifactIds: [],
      resultArtifactIds: [`artifact:${compaction.sourceId || recordIndex}`],
      eventId: `event:compaction:${compaction.sourceId || recordIndex}`,
      runId: null,
      turnId: null,
      timestamp: asNumber(mergedCompactionTimestamp(compaction)),
      provenance: codexCompactionProvenance(compaction)
    });
  });

  // --- Request usage --------------------------------------------------------
  const usageRecords: UsageRecord[] = [];
  const ownedUsageRecords = new Set(codexOwnedTokenUsageRecords(input.records));
  let activeModel: string | null = null;
  input.records.forEach((record, index) => {
    if (record.type === "event_msg" && record.payload?.type === "thread_settings_applied") {
      activeModel = firstString(record.payload?.thread_settings?.model) ?? activeModel;
      return;
    }
    if (!ownedUsageRecords.has(record)) return;
    const usage = codexUsagePayload(record);
    if (!usage || typeof usage !== "object") return;
    const inputRaw = firstNumber(usage.input_tokens, usage.input) ?? 0;
    const cacheRead = firstNumber(usage.cached_input_tokens, usage.cache_read) ?? null;
    const cacheWrite = firstNumber(usage.cache_write_input_tokens, usage.cache_write) ?? null;
    const outputRaw = firstNumber(usage.output_tokens, usage.output) ?? 0;
    const reasoningRaw = firstNumber(usage.reasoning_output_tokens, usage.reasoning) ?? null;
    // Window-reset markers (same ms as a compaction) report the context size
    // in total_tokens with every component zero: they are not model requests.
    if (inputRaw === 0 && outputRaw === 0 && (cacheRead ?? 0) === 0 && (cacheWrite ?? 0) === 0 && (reasoningRaw ?? 0) === 0) return;
    // Codex `input_tokens` includes cached/cache-write tokens and
    // `output_tokens` includes reasoning. Normalize to the v3 component
    // contract so components sum exactly to the recorded total.
    const input = Math.max(0, inputRaw - (cacheRead ?? 0) - (cacheWrite ?? 0));
    const reasoning = Math.min(reasoningRaw ?? 0, outputRaw);
    const output = Math.max(0, outputRaw - reasoning);
    const total = firstNumber(usage.total_tokens, usage.total) ?? input + (cacheRead ?? 0) + (cacheWrite ?? 0) + output + reasoning;
    const sourceId = firstString(record.payload?.response_id, record.payload?.turn_id)
      ?? String(record.ordinal ?? index);
    usageRecords.push(usageRecord({
      id: `usage:${sessionId}:${sourceId}`,
      scope: "request",
      sessionRef: ownRef,
      timestamp: recordTimestamp(record),
      model: activeModel,
      runId: null,
      eventId: null,
      turnId: firstString(record.payload?.turn_id),
      tokens: { input, cacheRead, cacheWrite, output, reasoning, total },
      contextOriginSlices: [],
      provenance: {
        fidelity: activeModel ? "derived" : "recorded",
        sourceType: record.type === "token_usage_record"
          ? (activeModel ? "codex.token_usage_record+thread_settings_applied" : "codex.token_usage_record")
          : (activeModel ? "codex.event_msg:token_count+thread_settings_applied" : "codex.event_msg:token_count"),
        sourceId
      }
    }));
  });

  // --- Coverage -------------------------------------------------------------
  const coverage: ProtocolCoverage = protocolCoverage({
    work: protocolDomainCoverage(goals.length + base.tasks.length > 0 ? "observed" : "not-observed", "recorded thread_goal_updated goals plus normalized subagent tasks"),
    execution: protocolDomainCoverage(actors.length + base.agentRuns.length > 0 ? "observed" : "not-observed", "recorded agent-path actors plus normalized child agent runs"),
    coordination: protocolDomainCoverage(observations.length > 0 ? "observed" : "not-observed", "recorded collaboration calls and FINAL_ANSWER envelopes"),
    context: protocolDomainCoverage(base.contextArtifacts.length + contextVersions.length + contextTransformations.length > 0 ? "observed" : "not-observed", "recorded compacted window lineage plus summary artifacts"),
    usage: protocolDomainCoverage(usageRecords.length > 0 ? "observed" : "not-observed", "recorded Codex request usage records")
  });

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
    goals,
    actors,
    coordination: observations,
    contextVersions,
    contextTransformations,
    usageRecords,
    coverage
  };
}
