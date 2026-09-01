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
  type SessionProtocol
} from "../shared/session-protocol.js";
import { isSubagentToolName } from "../shared/subagent-tools.js";

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
    sourceId: firstString(source.id, source.compaction_id, record.id) ?? null
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
