import type { Message, RawSession } from "../interface.js";
import {
  agentRun,
  compactionEnvelope,
  compactionSummaryArtifact,
  contextCompactionEvent,
  messageSessionEvents,
  sequenceEventsBySource,
  sourceSequence,
  sessionEvent,
  sessionRelationship,
  sessionTask,
  type SessionProtocol
} from "../shared/session-protocol.js";

type Row = Record<string, any>;

export interface ClaudeProtocolChild {
  session: RawSession;
  messages: Message[];
  records: Row[];
}

export interface ClaudeProtocolInput {
  session: RawSession;
  messages: Message[];
  records: Row[];
  /** Direct child sessions (sidechain agent transcripts). */
  children: ClaudeProtocolChild[];
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

function recordTimestamp(record: Row): number | null {
  return record.timestamp ? new Date(String(record.timestamp)).getTime() : null;
}

function contentBlocksOf(value: unknown): Row[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return Array.isArray(value) ? value.filter((block) => block && typeof block === "object") as Row[] : [];
}

function sidechainOf(record: Row) {
  return record?.isSidechain === true ? record : null;
}

/**
 * Claude Code persists compaction with several record shapes across
 * versions: `compact`/`compaction` records with a plaintext summary, and
 * `PreCompact`/`PostCompact` boundary records wrapping opaque payloads.
 * Opaque records (no readable summary) are still valid compaction evidence.
 */
export function claudeCompactionRecord(record: Row) {
  const type = String(record?.type || "");
  const normalized = type.toLowerCase();
  const subtype = String(record?.subtype || "").toLowerCase();
  const compactMetadata = record?.compactMetadata && typeof record.compactMetadata === "object"
    ? record.compactMetadata
    : null;
  const isBoundary = normalized === "precompact"
    || normalized === "postcompact"
    || subtype === "compact_boundary";
  const isCompaction = isBoundary || normalized.includes("compact") || subtype.includes("compact");
  if (!isCompaction) return null;

  let summary: string | null = null;
  if (!isBoundary) {
    const candidate = firstString(record.summary, record.message, record.context_summary);
    // Modern transcripts may persist an encoded payload instead of a readable
    // summary. Treat data: URIs and long base64-ish blobs as opaque.
    if (candidate && !/^data:/i.test(candidate) && candidate.length <= 4000) {
      summary = candidate;
    }
  }
  return {
    record,
    summary,
    trigger: compactMetadata?.trigger ?? "unknown",
    strategy: summary ? "summary" as const : "opaque" as const,
    tokensBefore: (() => {
      const value = compactMetadata?.preTokens
        ?? record.tokens_before
        ?? record.tokensBefore
        ?? record.input_tokens;
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    })(),
    tokensAfter: (() => {
      const value = record.tokens_after ?? record.tokensAfter;
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    })(),
    sourceId: firstString(record.compactUuid, record.compactionUuid, record.uuid) ?? null
  };
}

function taskNotificationOf(record: Row) {
  if (record.type !== "user") return null;
  const raw = record.message?.content ?? record.content;
  const blocks = typeof raw === "string"
    ? [{ type: "text", text: raw }]
    : Array.isArray(raw)
      ? raw
      : [];
  const text = blocks
    .filter((block: any) => block?.type === "text")
    .map((block: any) => block.text || "")
    .join("")
    .trim();
  if (!text.startsWith("<task-notification>") || !text.endsWith("</task-notification>")) return null;
  const field = (name: string) => {
    const match = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    return match?.[1]?.trim() || null;
  };
  const taskId = field("task-id");
  const toolUseId = field("tool-use-id");
  if (!taskId || !toolUseId) return null;
  return {
    taskId,
    toolUseId,
    status: field("status"),
    summary: field("summary")
  };
}

function taskStatusFromNotification(status: string | null): {
  status: "running" | "completed" | "failed" | "cancelled";
  phase: "started" | "completed" | "failed";
} {
  const normalized = String(status || "").toLowerCase();
  if (["completed", "done", "success"].includes(normalized)) {
    return { status: "completed", phase: "completed" };
  }
  if (["failed", "error"].includes(normalized)) {
    return { status: "failed", phase: "failed" };
  }
  if (["cancelled", "canceled", "aborted"].includes(normalized)) {
    return { status: "cancelled", phase: "failed" };
  }
  return { status: "running", phase: "started" };
}

function resolveChildByTaskId(children: ClaudeProtocolChild[], taskId: string | null): ClaudeProtocolChild | null {
  if (!taskId) return null;
  for (const child of children) {
    const metadata = child.session.metadata || {};
    const candidates = [
      metadata.agentId,
      child.session.id.replace(/^agent-/, ""),
      metadata.agentPath
    ].filter((value) => typeof value === "string" && value);
    if (candidates.some((candidate) => candidate === taskId || candidate === `agent-${taskId}`)) {
      return child;
    }
  }
  return null;
}

/**
 * Normalized protocol for one Claude Code session:
 * - events: derived message envelopes, recorded context.compaction events
 *   (compact/PreCompact/PostCompact records), and task lifecycle events from
 *   <task-notification> user records, sequenced in raw record order (record
 *   index, then local ordinal within the record). Messages that cannot map
 *   to a raw record are appended in normalized message order with derived
 *   provenance.
 * - relationships: sidechain records become spawned relationships; the
 *   sidechain parent lineage stays a parent relationship.
 * - tasks/agentRuns: task notifications become subagent Tasks; matching
 *   sidechain transcripts become AgentRuns bound to the task.
 * - contextArtifacts: metadata-only compaction records.
 */
export function buildClaudeSessionProtocol(input: ClaudeProtocolInput): SessionProtocol {
  const sessionId = String(input.session.id);
  const sidechain = input.records.map(sidechainOf).filter(Boolean) as Row[];

  // --- Source-order event assembly ---------------------------------------
  // Records anchor the order: compaction and task-notification records emit
  // lifecycle events at their record index; message events anchor at the
  // record that produced them (exact uuid/block/tool-use ids first, then the
  // `${uuid}:` prefix of generated assistant block ids); unmapped messages
  // fall back to normalized message order, appended, with derived provenance.
  const events: ReturnType<typeof sessionEvent>[] = [];

  const exactIndex = new Map<string, number>();
  const prefixIndex = new Map<string, number>();
  input.records.forEach((record, index) => {
    for (const id of [record.uuid, record.message?.id, record.id]) {
      if (typeof id === "string" && id && !exactIndex.has(id)) exactIndex.set(id, index);
    }
    if (typeof record.uuid === "string" && record.uuid) {
      const key = `${record.uuid}:`;
      if (!prefixIndex.has(key)) prefixIndex.set(key, index);
    }
    if (record.tool_use_id && !exactIndex.has(String(record.tool_use_id))) {
      exactIndex.set(String(record.tool_use_id), index);
    }
    for (const block of contentBlocksOf(record.message?.content ?? record.content)) {
      for (const id of [block.id, block.tool_use_id]) {
        if (typeof id === "string" && id && !exactIndex.has(id)) exactIndex.set(id, index);
      }
    }
  });
  const messageAnchors = new Map<string, number>();
  for (const message of input.messages) {
    let recordIndex = exactIndex.get(message.id) ?? null;
    if (recordIndex == null) {
      const colon = message.id.lastIndexOf(":");
      if (colon > 0) recordIndex = prefixIndex.get(message.id.slice(0, colon + 1)) ?? null;
    }
    if (recordIndex == null && message.metadata?.toolUseId) {
      recordIndex = exactIndex.get(String(message.metadata.toolUseId)) ?? null;
    }
    if (recordIndex != null) messageAnchors.set(message.id, recordIndex);
  }

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

  // Recorded compaction events (compact boundary / PreCompact / PostCompact)
  // and task notifications, each anchored at its record's position.
  const taskNotifications: Array<NonNullable<ReturnType<typeof taskNotificationOf>>> = [];
  input.records.forEach((record, index) => {
    const compaction = claudeCompactionRecord(record);
    if (compaction) {
      pushAnchored(compactionEnvelope({
        id: `event:compaction:${compaction.sourceId || "record"}:${index}`,
        sessionId,
        timestamp: recordTimestamp(record),
        correlationId: compaction.sourceId,
        provenance: {
          fidelity: "recorded",
          sourceType: `claude.transcript:${String(record.type || "compact")}`,
          sourceId: compaction.sourceId
        },
        providerData: {
          recordType: String(record.type || "")
        }
      }, contextCompactionEvent({
        trigger: compaction.trigger,
        strategy: compaction.strategy,
        tokensBefore: compaction.tokensBefore,
        tokensAfter: compaction.tokensAfter,
        summary: compaction.summary,
        retainedFromEventId: compaction.sourceId
      })), index);
    }

    const notification = taskNotificationOf(record);
    if (notification) {
      taskNotifications.push(notification);
      const mapping = taskStatusFromNotification(notification.status);
      pushAnchored(sessionEvent({
        id: `event:task:${notification.taskId}:${notification.toolUseId}`,
        sessionId,
        sequence: 0,
        timestamp: recordTimestamp(record),
        kind: "task",
        phase: mapping.phase,
        correlationId: notification.toolUseId,
        provenance: {
          fidelity: "recorded",
          sourceType: "claude.transcript:user:task-notification",
          sourceId: notification.taskId
        },
        providerData: {
          taskId: notification.taskId,
          status: notification.status,
          summary: notification.summary
        }
      }), index);
    }
  });

  // Derived message envelopes, interleaved at their producing record.
  for (const event of messageSessionEvents(input.messages, sessionId, "claude.normalized-message")) {
    const recordIndex = event.provenance.sourceId ? messageAnchors.get(event.provenance.sourceId) : null;
    if (recordIndex == null) {
      events.push(event); // documented fallback: normalized message order, appended
      continue;
    }
    pushAnchored(event, recordIndex);
  }

  const relationships: ReturnType<typeof sessionRelationship>[] = [];
  if (sidechain.length > 0) {
    const parentSessionId = sidechain[0].sessionId;
    if (parentSessionId && String(parentSessionId) !== sessionId) {
      relationships.push(sessionRelationship({
        type: "spawned",
        fromSessionId: String(parentSessionId),
        toSessionId: sessionId,
        timestamp: input.session.timeCreated,
        provenance: {
          fidelity: "recorded",
          sourceType: "claude.transcript:isSidechain",
          sourceId: String(sidechain[0].agentId || parentSessionId)
        },
        details: "Claude Code sidechain agent transcript"
      }));
    }
  }

  const tasks: ReturnType<typeof sessionTask>[] = [];
  const runs: ReturnType<typeof agentRun>[] = [];
  const seenTaskIds = new Set<string>();
  for (const notification of taskNotifications) {
    const mapping = taskStatusFromNotification(notification.status);
    const child = resolveChildByTaskId(input.children, notification.taskId);
    const timestamp = recordTimestamp(input.records.find((record) => taskNotificationOf(record) === notification) || {});
    if (!seenTaskIds.has(notification.taskId)) {
      seenTaskIds.add(notification.taskId);
      tasks.push(sessionTask({
        id: notification.taskId,
        sessionId,
        kind: "subagent-task",
        status: mapping.status,
        title: notification.summary || null,
        toolCallId: notification.toolUseId,
        correlationId: notification.toolUseId,
        timeCreated: timestamp,
        timeUpdated: timestamp,
        timeCompleted: mapping.status === "completed" || mapping.status === "failed" || mapping.status === "cancelled"
          ? timestamp
          : null,
        provenance: {
          fidelity: "recorded",
          sourceType: "claude.transcript:user:task-notification",
          sourceId: notification.taskId
        }
      }));
    } else if (mapping.status !== "running") {
      // Later notifications update the task; keep the last non-starting state.
      const task = tasks.find((candidate) => candidate.id === notification.taskId);
      if (task) {
        task.status = mapping.status;
        task.timeUpdated = timestamp;
        task.timeCompleted = timestamp;
        task.title = notification.summary || task.title;
      }
    }
    if (child) {
      runs.push(agentRun({
        id: String(child.session.id),
        sessionId,
        taskId: notification.taskId,
        status: mapping.status,
        mode: "subagent",
        agent: firstString(child.session.metadata?.agentId, child.session.title),
        model: null,
        childSessionId: String(child.session.id),
        timeStart: asNumber(child.session.timeCreated),
        timeEnd: asNumber(child.session.timeUpdated),
        provenance: {
          fidelity: "derived",
          sourceType: "claude.sidechain-session",
          sourceId: String(child.session.id)
        },
        metadata: {
          taskId: notification.taskId,
          toolUseId: notification.toolUseId
        }
      }));
    }
  }

  // Sidechain transcripts without a matching notification still represent
  // agent runs, but never plain tasks.
  for (const child of input.children) {
    const childId = String(child.session.id);
    if (runs.some((run) => run.childSessionId === childId)) continue;
    const childSidechain = child.records.map(sidechainOf).filter(Boolean) as Row[];
    if (childSidechain.length === 0) continue;
    runs.push(agentRun({
      id: childId,
      sessionId,
      taskId: null,
      status: "completed",
      mode: "subagent",
      agent: firstString(child.session.metadata?.agentId, child.session.title),
      model: null,
      childSessionId: childId,
      timeStart: asNumber(child.session.timeCreated),
      timeEnd: asNumber(child.session.timeUpdated),
      provenance: {
        fidelity: "derived",
        sourceType: "claude.sidechain-session",
        sourceId: childId
      }
    }));
  }

  // Outgoing spawned edges: this session spawned the sidechain transcripts.
  // The notification (or the sidechain record alone) is the evidence; the
  // pairing with the child session is derived.
  for (const child of input.children) {
    const childSidechain = child.records.map(sidechainOf).filter(Boolean) as Row[];
    if (childSidechain.length === 0) continue;
    const childId = String(child.session.id);
    const childAgentId = firstString(childSidechain[0].agentId, child.session.metadata?.agentId);
    const notification = taskNotifications.find((candidate) => (
      childAgentId && (candidate.taskId === childAgentId || candidate.taskId === `agent-${childAgentId}`)
    ));
    relationships.push(sessionRelationship({
      type: "spawned",
      fromSessionId: sessionId,
      toSessionId: childId,
      timestamp: asNumber(child.session.timeCreated),
      correlationId: notification?.toolUseId ?? null,
      provenance: {
        fidelity: "derived",
        sourceType: "claude.sidechain-pairing",
        sourceId: childId
      },
      details: "Claude Code sidechain agent transcript"
    }));
  }

  const artifacts = input.records.flatMap((record, index) => {
    const compaction = claudeCompactionRecord(record);
    if (!compaction) return [];
    return [compactionSummaryArtifact({
      id: `artifact:${compaction.sourceId || "record"}:${index}`,
      sessionId,
      sourceSessionIds: [sessionId],
      provenance: {
        fidelity: "recorded",
        sourceType: `claude.transcript:${String(record.type || "compact")}`,
        sourceId: compaction.sourceId
      },
      timeCreated: recordTimestamp(record),
      metadata: {
        compactUuid: compaction.sourceId,
        recordType: String(record.type || ""),
        trigger: compaction.trigger,
        strategy: compaction.strategy
      }
    })];
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
