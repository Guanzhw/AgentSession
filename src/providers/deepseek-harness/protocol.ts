import type { Message, RawSession } from "../interface.js";
import {
  dshContentText,
  dshHeader,
  dshOwnedEvents,
  dshSessionStatus,
  type DshRecord
} from "./parser.js";
import {
  agentRun,
  compactionEnvelope,
  compactionSummaryArtifact,
  contextCompactionEvent,
  sequenceEventsBySource,
  sessionEvent,
  sessionRelationship,
  sessionTask,
  sourceSequence,
  type AgentRun,
  type SessionEventEnvelope,
  type SessionProtocol,
  type Task,
  type TaskStatus
} from "../shared/session-protocol.js";

export interface DshProtocolChild {
  session: RawSession;
  records: DshRecord[];
  messages: Message[];
}

export interface DshProtocolInput {
  session: RawSession;
  records: DshRecord[];
  messages: Message[];
  children: DshProtocolChild[];
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

function eventData(event: DshRecord): DshRecord {
  return event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? event.data
    : {};
}

function descriptorOf(records: DshRecord[]): DshRecord | null {
  return [...dshOwnedEvents(records)].reverse().find((event) => event.type === "subagent/descriptor") || null;
}

function eventKind(event: DshRecord): string {
  switch (event.type) {
    case "user/message": return "message.user";
    case "assistant/message": return "message.assistant";
    case "tool/call": return "tool.call";
    case "tool/result": return "tool.result";
    case "turn/start": return "turn.started";
    case "turn/end": return "turn.completed";
    case "step/start": return "step.started";
    case "step/end": return "step.completed";
    case "assistant/chunk": return "assistant.chunk";
    case "approval/asked": return "approval.requested";
    case "approval/decided": return "approval.decided";
    case "subagent/descriptor": return "subagent.descriptor";
    default: return `dsh.${String(event.type || "event").replace(/\//g, ".")}`;
  }
}

function eventPhase(event: DshRecord): SessionEventEnvelope["phase"] | undefined {
  if (["turn/start", "step/start", "tool/call", "compaction/start", "tool-workflow/run-start", "tool-workflow/agent-start"].includes(event.type)) {
    return "started";
  }
  if (event.type === "assistant/chunk") return "updated";
  if (event.type === "turn/end") {
    const reason = eventData(event).reason?.kind;
    return reason === "error" || reason === "blocked" || reason === "aborted" || reason === "interrupted"
      ? "failed"
      : "completed";
  }
  if (["step/end", "tool/result", "compaction/end", "tool-workflow/run-end", "tool-workflow/agent-end", "command/done"].includes(event.type)) {
    return "completed";
  }
  return undefined;
}

function eventCorrelation(event: DshRecord): string | null {
  const data = eventData(event);
  if (event.type === "tool/call") return firstString(data.callId);
  if (event.type === "tool/result") {
    const message = eventData({ data: data.message });
    const block = Array.isArray(message.content)
      ? message.content.find((item: unknown) => item && typeof item === "object" && (item as DshRecord).type === "tool-result") as DshRecord | undefined
      : undefined;
    return firstString(message.source?.callId, block?.toolCallId);
  }
  if (event.type.startsWith("tool-workflow/")) {
    const runId = firstString(data.runId);
    const member = asNumber(data.seq);
    return runId && member != null ? `${runId}:${member}` : runId;
  }
  if (event.type.startsWith("compaction/")) return firstString(data.compactionId);
  if (event.type.startsWith("approval/")) return firstString(data.id);
  if (event.type.startsWith("command/")) return firstString(data.commandId);
  return null;
}

function commonProviderData(event: DshRecord) {
  const data = eventData(event);
  return {
    sourceSequence: sourceSequence(Number(event.seq) || 0),
    eventType: String(event.type),
    turn: asNumber(data.turn),
    step: asNumber(data.step),
    surfaceOp: event.surfaceOp || null,
    ignorable: event.ignorable === true
  };
}

export function dshCompactionRecord(event: DshRecord) {
  const data = eventData(event);
  if (event.type === "compaction/summary") {
    return {
      summary: dshContentText(data.summary),
      trigger: data.sourceCommandId ? "manual" as const : "automatic" as const,
      strategy: "summary" as const,
      tokensBefore: asNumber(data.shadowedTokenCount),
      tokensAfter: null,
      sourceId: firstString(data.compactionId) || `seq:${event.seq}`,
      metadata: {
        compactionId: data.compactionId || null,
        sourceCommandId: data.sourceCommandId || null,
        shadowedRange: data.shadowedRange || null,
        shadowedSeqs: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : [],
        provider: data.provider || null,
        model: data.model || null,
        usage: data.usage || null
      }
    };
  }
  if (event.type === "compaction/prune") {
    return {
      summary: null,
      trigger: "automatic" as const,
      strategy: "opaque" as const,
      tokensBefore: asNumber(data.shadowedTokenCount),
      tokensAfter: null,
      sourceId: `seq:${event.seq}`,
      metadata: {
        shadowedRange: data.shadowedRange || null,
        shadowedSeqs: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : []
      }
    };
  }
  return null;
}

function recordedEvent(sessionId: string, event: DshRecord): SessionEventEnvelope {
  const compaction = dshCompactionRecord(event);
  const fields = {
    id: `event:dsh:${event.seq}`,
    sessionId,
    timestamp: asNumber(event.time),
    phase: eventPhase(event),
    turnId: asNumber(eventData(event).turn) != null ? String(eventData(event).turn) : null,
    correlationId: eventCorrelation(event),
    provenance: {
      fidelity: "recorded" as const,
      sourceType: `dsh.session-event:${String(event.type)}`,
      sourceId: String(event.seq)
    },
    providerData: commonProviderData(event)
  };
  if (compaction) {
    return compactionEnvelope(fields, contextCompactionEvent({
      trigger: compaction.trigger,
      strategy: compaction.strategy,
      tokensBefore: compaction.tokensBefore,
      tokensAfter: compaction.tokensAfter,
      summary: compaction.summary,
      retainedFromEventId: null
    }));
  }
  return sessionEvent({ ...fields, kind: eventKind(event) });
}

function workflowStatus(outcome: unknown, fallback: TaskStatus): TaskStatus {
  const value = typeof outcome === "string"
    ? outcome
    : outcome && typeof outcome === "object"
      ? firstString((outcome as DshRecord).kind, (outcome as DshRecord).status, (outcome as DshRecord).state)
      : null;
  switch (String(value || "").toLowerCase()) {
    case "completed":
    case "complete":
    case "success":
    case "succeeded": return "completed";
    case "failed":
    case "error": return "failed";
    case "blocked": return "blocked";
    case "cancelled":
    case "canceled":
    case "aborted":
    case "interrupted": return "cancelled";
    case "running":
    case "pending": return "running";
    default: return fallback;
  }
}

interface WorkflowMember {
  event: DshRecord;
  runId: string;
  sequence: number;
  label: string | null;
  childId: string;
  outcome: unknown;
  endTime: number | null;
}

function workflowMembers(records: DshRecord[]): WorkflowMember[] {
  const ends = new Map<string, DshRecord>();
  for (const event of dshOwnedEvents(records)) {
    if (event.type !== "tool-workflow/agent-end") continue;
    const data = eventData(event);
    const runId = firstString(data.runId);
    const sequence = asNumber(data.seq);
    if (runId && sequence != null) ends.set(`${runId}:${sequence}`, event);
  }
  return dshOwnedEvents(records).flatMap((event) => {
    if (event.type !== "tool-workflow/agent-start") return [];
    const data = eventData(event);
    const runId = firstString(data.runId);
    const sequence = asNumber(data.seq);
    const childId = firstString(data.childId);
    if (!runId || sequence == null || !childId) return [];
    const end = ends.get(`${runId}:${sequence}`);
    return [{
      event,
      runId,
      sequence,
      label: firstString(data.label),
      childId,
      outcome: end ? eventData(end).outcome : null,
      endTime: end ? asNumber(end.time) : null
    }];
  });
}

function childTitle(child: DshProtocolChild, descriptor: DshRecord | null) {
  return firstString(descriptor?.data?.label, child.session.title, child.session.metadata?.agentPreset);
}

function childModel(child: DshProtocolChild, descriptor: DshRecord | null) {
  return firstString(descriptor?.data?.agentModel, child.session.metadata?.model);
}

function addTaskAndRun({
  tasks,
  runs,
  relationships,
  sessionId,
  child,
  childSessionId,
  taskId,
  title,
  status,
  mode,
  timeCreated,
  timeCompleted,
  correlationId,
  sourceType,
  sourceId,
  fidelity,
  metadata
}: {
  tasks: Task[];
  runs: AgentRun[];
  relationships: ReturnType<typeof sessionRelationship>[];
  sessionId: string;
  child: DshProtocolChild | null;
  childSessionId?: string;
  taskId: string;
  title: string | null;
  status: TaskStatus;
  mode: "subagent" | "team";
  timeCreated: number | null;
  timeCompleted: number | null;
  correlationId: string | null;
  sourceType: string;
  sourceId: string;
  fidelity: "recorded" | "derived";
  metadata?: Record<string, unknown> | null;
}) {
  const childId = child ? String(child.session.id) : (childSessionId || sourceId);
  if (!tasks.some((task) => task.id === taskId)) {
    tasks.push(sessionTask({
      id: taskId,
      sessionId,
      kind: mode === "team" ? "workflow-agent" : "subagent-task",
      status,
      title,
      correlationId,
      toolCallId: null,
      agentPath: title,
      timeCreated,
      timeUpdated: timeCompleted || timeCreated,
      timeCompleted,
      provenance: { fidelity, sourceType, sourceId },
      metadata: metadata || null
    }));
  }
  if (!runs.some((run) => run.childSessionId === childId)) {
    runs.push(agentRun({
      id: `run:${childId}`,
      sessionId,
      taskId,
      status,
      mode,
      agent: title,
      model: child ? childModel(child, descriptorOf(child.records)) : null,
      childSessionId: childId,
      timeStart: timeCreated,
      timeEnd: timeCompleted,
      provenance: { fidelity, sourceType, sourceId },
      metadata: metadata || null
    }));
  }
  if (!relationships.some((relationship) => relationship.type === "spawned" && relationship.toSessionId === childId)) {
    relationships.push(sessionRelationship({
      type: "spawned",
      fromSessionId: sessionId,
      toSessionId: childId,
      correlationId,
      timestamp: timeCreated,
      details: mode === "team" ? "DeepSeek Harness workflow member" : "DeepSeek Harness subagent child",
      provenance: { fidelity, sourceType, sourceId }
    }));
  }
}

/**
 * Build a provider-native protocol from DSH's append-only source event log.
 * Every retained event remains recorded in source order; message cards are a
 * separate compatibility projection in parser.ts.
 */
export function buildDshSessionProtocol(input: DshProtocolInput): SessionProtocol {
  const sessionId = String(input.session.id);
  const owned = dshOwnedEvents(input.records);
  const events = owned.map((event) => recordedEvent(sessionId, event));
  const relationships: ReturnType<typeof sessionRelationship>[] = [];
  const tasks: Task[] = [];
  const runs: AgentRun[] = [];
  const artifacts = owned.flatMap((event) => {
    const compaction = dshCompactionRecord(event);
    if (!compaction) return [];
    return [compactionSummaryArtifact({
      id: `artifact:dsh:${event.seq}`,
      sessionId,
      sourceSessionIds: [sessionId],
      provenance: {
        fidelity: "recorded",
        sourceType: `dsh.session-event:${String(event.type)}`,
        sourceId: String(event.seq)
      },
      timeCreated: asNumber(event.time),
      metadata: {
        eventType: event.type,
        tokensBefore: compaction.tokensBefore,
        tokensAfter: compaction.tokensAfter,
        ...compaction.metadata
      }
    })];
  });

  const header = dshHeader(input.records) || {};
  const descriptor = descriptorOf(input.records);
  if (input.session.parentId) {
    const spawned = header.origin === "subagent" || Boolean(descriptor);
    relationships.push(sessionRelationship({
      type: spawned ? "spawned" : "forked",
      fromSessionId: String(input.session.parentId),
      toSessionId: sessionId,
      timestamp: asNumber(input.session.timeCreated),
      correlationId: null,
      details: spawned
        ? "DeepSeek Harness subagent header and descriptor"
        : "DeepSeek Harness header parentSession seed lineage",
      provenance: {
        fidelity: "recorded",
        sourceType: spawned && descriptor
          ? "dsh.session-event:subagent/descriptor"
          : "dsh.session.header.parentSession",
        sourceId: spawned && descriptor ? String(descriptor.seq) : String(input.session.parentId)
      }
    }));
  }

  const childrenById = new Map(input.children.map((child) => [String(child.session.id), child]));
  for (const member of workflowMembers(input.records)) {
    const child = childrenById.get(member.childId) || null;
    const fallbackStatus = child ? dshSessionStatus(child.records) : "running";
    const status = workflowStatus(member.outcome, fallbackStatus);
    const title = member.label || (child ? childTitle(child, descriptorOf(child.records)) : null);
    const correlationId = `${member.runId}:${member.sequence}`;
    addTaskAndRun({
      tasks,
      runs,
      relationships,
      sessionId,
      child,
      childSessionId: member.childId,
      taskId: `workflow:${correlationId}`,
      title,
      status,
      mode: "team",
      timeCreated: asNumber(member.event.time),
      timeCompleted: member.endTime || (status === "completed" || status === "failed" || status === "blocked" || status === "cancelled"
        ? child ? asNumber(child.session.timeUpdated) : asNumber(member.event.time)
        : null),
      correlationId,
      sourceType: "dsh.session-event:tool-workflow/agent-start",
      sourceId: String(member.event.seq),
      fidelity: "recorded",
      metadata: { runId: member.runId, workflowSequence: member.sequence, outcome: member.outcome || null }
    });
  }

  for (const child of input.children) {
    const childId = String(child.session.id);
    const childHeader = dshHeader(child.records) || {};
    const childDescriptor = descriptorOf(child.records);
    const isSubagent = childHeader.origin === "subagent" || Boolean(childDescriptor);
    if (!isSubagent || runs.some((run) => run.childSessionId === childId)) continue;
    const status = dshSessionStatus(child.records);
    addTaskAndRun({
      tasks,
      runs,
      relationships,
      sessionId,
      child,
      taskId: `subagent:${childId}`,
      title: childTitle(child, childDescriptor),
      status,
      mode: "subagent",
      timeCreated: asNumber(child.session.timeCreated),
      timeCompleted: status === "running" ? null : asNumber(child.session.timeUpdated),
      correlationId: null,
      sourceType: childDescriptor
        ? "dsh.child-session:subagent/descriptor"
        : "dsh.child-session:header.origin",
      sourceId: childDescriptor ? String(childDescriptor.seq) : childId,
      fidelity: "derived",
      metadata: {
        descriptorMode: childDescriptor?.data?.mode || null,
        descriptorProvider: childDescriptor?.data?.provider || null,
        delegationDepth: child.session.metadata?.delegationDepth || null
      }
    });
  }

  return {
    sessionId,
    events: sequenceEventsBySource(events),
    relationships,
    tasks,
    agentRuns: runs,
    contextArtifacts: artifacts
  };
}
