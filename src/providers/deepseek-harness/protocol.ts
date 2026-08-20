import type { Message, RawSession } from "../interface.js";
import {
  dshContentText,
  dshHeader,
  dshOwnedEvents,
  dshSessionStatus,
  dshUsageToTokens,
  type DshRecord
} from "./parser.js";
import {
  agentRun,
  compactionEnvelope,
  compactionSummaryArtifact,
  contextCompactionEvent,
  finalizeSessionProtocol,
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
import { DSH_COMPATIBILITY_SNAPSHOT } from "./compatibility.js";

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

function isRecord(value: unknown): value is DshRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toolResultHasError(event: DshRecord): boolean {
  const message = eventData(event).message;
  if (!isRecord(message) || !Array.isArray(message.content)) return false;
  return message.content.some((item) => isRecord(item) && item.type === "tool-result" && item.isError === true);
}

function descriptorOf(records: DshRecord[]): DshRecord | null {
  return [...dshOwnedEvents(records)].reverse().find((event) => event.type === "subagent/descriptor") || null;
}

function eventKind(event: DshRecord): string {
  switch (event.type) {
    case "session/end-seed": return "session.end-seed";
    case "request/header": return "request.header";
    case "request/context": return "request.context";
    case "user/message": return "message.user";
    case "assistant/message": return "message.assistant";
    case "tool/call": return "tool.call";
    case "tool/result": return "tool.result";
    case "turn/start": return "turn.started";
    case "turn/end": return "turn.completed";
    case "step/start": return "step.started";
    case "step/end": return "step.completed";
    case "assistant/chunk": return "assistant.chunk";
    case "compaction/start": return "context.compaction.started";
    case "compaction/end": return "context.compaction.completed";
    case "agent/inbox/spliced": return "control.inbox.spliced";
    case "team/member": return "team.member";
    case "team/task": return "team.task";
    case "team/message/queued": return "team.message.queued";
    case "team/message/delivered": return "team.message.delivered";
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
  const providerData: Record<string, unknown> = {
    sourceSequence: sourceSequence(Number(event.seq) || 0),
    eventType: String(event.type),
    turn: asNumber(data.turn),
    step: asNumber(data.step),
    surfaceOp: event.surfaceOp || null,
    ignorable: event.ignorable === true
  };
  if (event.type === "session/end-seed") {
    providerData.seedBoundary = true;
    providerData.seedLength = asNumber(data.seedLength);
  } else if (event.type === "request/header") {
    const requestHeader = data.header && typeof data.header === "object" && !Array.isArray(data.header)
      ? data.header as DshRecord
      : {};
    const config = requestHeader.config && typeof requestHeader.config === "object" && !Array.isArray(requestHeader.config)
      ? requestHeader.config as DshRecord
      : {};
    providerData.reason = firstString(data.reason);
    providerData.hasSystemPrompt = typeof requestHeader.system === "string" && requestHeader.system.length > 0;
    providerData.provider = firstString(config.provider);
    providerData.model = firstString(config.model);
  } else if (event.type === "request/context") {
    providerData.provider = firstString(data.provider);
    providerData.model = firstString(data.model);
    providerData.contextWindow = asNumber(data.contextWindow);
  } else if (event.type === "assistant/message") {
    providerData.usage = dshUsageToTokens(data.usage);
  } else if (event.type === "turn/end") {
    const reason = data.reason && typeof data.reason === "object" && !Array.isArray(data.reason) ? data.reason as DshRecord : {};
    providerData.reasonKind = firstString(reason.kind);
  } else if (event.type === "tool/call") {
    providerData.callId = firstString(data.callId);
    providerData.name = firstString(data.name);
  } else if (event.type === "tool/result") {
    providerData.callId = eventCorrelation(event);
    providerData.isError = toolResultHasError(event);
  } else if (event.type === "agent/inbox/spliced") {
    providerData.operation = firstString(data.operation);
    providerData.messageIds = Array.isArray(data.messageIds) ? data.messageIds.filter((value): value is string => typeof value === "string") : [];
  } else if (event.type === "team/member") {
    const member = data.member && typeof data.member === "object" && !Array.isArray(data.member) ? data.member as DshRecord : {};
    providerData.version = asNumber(data.version);
    providerData.teamId = firstString(data.teamId);
    providerData.memberId = firstString(member.id);
    providerData.memberName = firstString(member.name);
    providerData.memberProvider = firstString(member.provider);
    providerData.memberContext = firstString(member.context);
    providerData.memberPhase = firstString(member.phase);
  } else if (event.type === "team/task") {
    const task = data.task && typeof data.task === "object" && !Array.isArray(data.task) ? data.task as DshRecord : {};
    providerData.version = asNumber(data.version);
    providerData.teamId = firstString(data.teamId);
    providerData.taskId = firstString(task.id);
    providerData.revision = asNumber(task.revision);
    providerData.ownerId = firstString(task.ownerId);
    providerData.blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy.filter((value): value is string => typeof value === "string") : [];
  } else if (event.type === "team/message/queued") {
    const message = data.message && typeof data.message === "object" && !Array.isArray(data.message) ? data.message as DshRecord : {};
    providerData.version = asNumber(data.version);
    providerData.teamId = firstString(data.teamId);
    providerData.messageId = firstString(message.id);
    providerData.senderId = firstString(message.senderId);
    providerData.targetId = firstString(message.targetId);
    providerData.delivery = firstString(message.delivery);
  } else if (event.type === "team/message/delivered") {
    providerData.version = asNumber(data.version);
    providerData.teamId = firstString(data.teamId);
    providerData.messageId = firstString(data.messageId);
    providerData.targetId = firstString(data.targetId);
  }
  return providerData;
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

function recordedEvent(
  sessionId: string,
  event: DshRecord,
  sessionMetadata: { delegationDepth: number | null; agentPreset: string | null }
): SessionEventEnvelope {
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
    providerData: {
      ...commonProviderData(event),
      delegationDepth: sessionMetadata.delegationDepth,
      agentPreset: sessionMetadata.agentPreset
    }
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

function teamTaskStatus(value: unknown): TaskStatus {
  switch (String(value || "").toLowerCase()) {
    case "pending": return "queued";
    case "in_progress":
    case "in-progress":
    case "running": return "running";
    case "completed":
    case "complete": return "completed";
    case "deleted": return "cancelled";
    default: return "queued";
  }
}

interface DshTeamTask {
  event: DshRecord;
  id: string;
  teamId: string | null;
  revision: number | null;
  subject: string | null;
  description: string | null;
  status: TaskStatus;
  rawStatus: string | null;
  ownerId: string | null;
  blockedBy: string[];
  writeScopes: string[];
}

function teamTasks(records: DshRecord[]): DshTeamTask[] {
  const latest = new Map<string, DshTeamTask>();
  for (const event of dshOwnedEvents(records)) {
    if (event.type !== "team/task") continue;
    const data = eventData(event);
    const task = isRecord(data.task) ? data.task : {};
    const id = firstString(task.id);
    if (!id) continue;
    const candidate: DshTeamTask = {
      event,
      id,
      teamId: firstString(data.teamId),
      revision: asNumber(task.revision),
      subject: firstString(task.subject),
      description: firstString(task.description),
      status: teamTaskStatus(task.status),
      rawStatus: firstString(task.status),
      ownerId: firstString(task.ownerId),
      blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.filter((value): value is string => typeof value === "string" && Boolean(value)) : [],
      writeScopes: Array.isArray(task.writeScopes) ? task.writeScopes.filter((value): value is string => typeof value === "string" && Boolean(value)) : []
    };
    const previous = latest.get(id);
    if (!previous || (candidate.revision ?? -1) >= (previous.revision ?? -1)) latest.set(id, candidate);
  }
  return [...latest.values()];
}

interface DshTeamMember {
  event: DshRecord;
  id: string;
  teamId: string | null;
  name: string | null;
  description: string | null;
  provider: string | null;
  context: string | null;
  phase: string | null;
  error: string | null;
}

function teamMembers(records: DshRecord[]): DshTeamMember[] {
  const latest = new Map<string, DshTeamMember>();
  for (const event of dshOwnedEvents(records)) {
    if (event.type !== "team/member") continue;
    const data = eventData(event);
    const member = isRecord(data.member) ? data.member : {};
    const id = firstString(member.id);
    if (!id) continue;
    latest.set(id, {
      event,
      id,
      teamId: firstString(data.teamId),
      name: firstString(member.name),
      description: firstString(member.description),
      provider: firstString(member.provider),
      context: firstString(member.context),
      phase: firstString(member.phase),
      error: firstString(member.error)
    });
  }
  return [...latest.values()];
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
  const childSessionAvailable = Boolean(child);
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
      metadata: { ...(metadata || {}), childSessionAvailable, ...(child ? {} : { danglingChildSessionId: childId }) }
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
      metadata: { ...(metadata || {}), childSessionAvailable, ...(child ? {} : { danglingChildSessionId: childId }) }
    }));
  }
  if (!relationships.some((relationship) => relationship.type === "spawned" && relationship.toSessionId === childId)) {
    relationships.push(sessionRelationship({
      type: "spawned",
      fromSessionId: sessionId,
      toSessionId: childId,
      correlationId,
      timestamp: timeCreated,
      details: child
        ? (mode === "team" ? "DeepSeek Harness workflow member" : "DeepSeek Harness subagent child")
        : `${mode === "team" ? "DeepSeek Harness workflow member" : "DeepSeek Harness subagent child"}; child session is not present in this snapshot`,
      taskId,
      runId: `run:${childId}`,
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
  const events = owned.map((event) => recordedEvent(sessionId, event, {
    delegationDepth: asNumber((dshHeader(input.records) || {}).delegationDepth),
    agentPreset: firstString((dshHeader(input.records) || {}).agentPreset)
  }));
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
  const nativeTasks = teamTasks(input.records);
  const taskIdsByOwner = new Map<string, string>();
  for (const native of nativeTasks) {
    const taskId = `team:${native.id}`;
    if (native.ownerId) taskIdsByOwner.set(native.ownerId, taskId);
  }
  for (const member of teamMembers(input.records)) {
    const child = childrenById.get(member.id) || null;
    const taskId = taskIdsByOwner.get(member.id) || null;
    const childStatus = child ? dshSessionStatus(child.records) : null;
    const phaseStatus: TaskStatus = member.phase === "failed"
      ? "failed"
      : member.phase === "active"
        ? "running"
        : "queued";
    const status = childStatus && childStatus !== "running" ? childStatus : phaseStatus;
    const runId = `team-member:${member.id}`;
    runs.push(agentRun({
      id: runId,
      sessionId,
      taskId,
      status,
      mode: "team",
      agent: member.name || member.id,
      model: child ? childModel(child, descriptorOf(child.records)) : member.provider,
      childSessionId: child ? member.id : null,
      timeStart: asNumber(member.event.time),
      timeEnd: status === "running" || status === "queued" ? null : asNumber(child?.session.timeUpdated || member.event.time),
      provenance: {
        fidelity: "recorded",
        sourceType: "dsh.session-event:team/member",
        sourceId: String(member.event.seq)
      },
      metadata: {
        teamId: member.teamId,
        memberId: member.id,
        description: member.description,
        provider: member.provider,
        context: member.context,
        phase: member.phase,
        error: member.error,
        childSessionAvailable: Boolean(child),
        ...(child ? {} : { danglingChildSessionId: member.id })
      }
    }));
    if (child && !relationships.some((relationship) => relationship.type === "spawned" && relationship.toSessionId === member.id)) {
      relationships.push(sessionRelationship({
        type: "spawned",
        fromSessionId: sessionId,
        toSessionId: member.id,
        timestamp: asNumber(member.event.time),
        correlationId: member.id,
        taskId,
        runId,
        details: "DeepSeek Harness team member session",
        provenance: {
          fidelity: "recorded",
          sourceType: "dsh.session-event:team/member",
          sourceId: String(member.event.seq)
        }
      }));
    }
  }

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

  // Keep the existing workflow/subagent task ordering stable; native Team
  // tasks are appended after recorded workflow tasks in this snapshot.
  for (const native of nativeTasks) {
    const taskId = `team:${native.id}`;
    const terminal = ["completed", "failed", "cancelled"].includes(native.status);
    tasks.push(sessionTask({
      id: taskId,
      sessionId,
      kind: "team-task",
      status: native.status,
      title: native.subject,
      assignee: native.ownerId,
      owner: native.ownerId,
      correlationId: native.id,
      dependencies: native.blockedBy.map((dependency) => `team:${dependency}`),
      revision: native.revision,
      timeCreated: asNumber(native.event.time),
      timeUpdated: asNumber(native.event.time),
      timeCompleted: terminal ? asNumber(native.event.time) : null,
      outcome: terminal ? native.rawStatus : null,
      provenance: {
        fidelity: "recorded",
        sourceType: "dsh.session-event:team/task",
        sourceId: String(native.event.seq)
      },
      metadata: {
        teamId: native.teamId,
        description: native.description,
        rawStatus: native.rawStatus,
        ownerId: native.ownerId,
        blockedBy: native.blockedBy,
        writeScopes: native.writeScopes
      }
    }));
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

  const turnEnd = [...owned].reverse().find((event) => event.type === "turn/end");
  const headerMetadata = {
    ...(input.session.metadata || {}),
    seedLength: asNumber(header.seedLength),
    inheritedEventCount: asNumber(header.seedLength),
    delegationDepth: asNumber(header.delegationDepth),
    agentPreset: firstString(header.agentPreset)
  };
  const sourceProtocol: SessionProtocol = {
    sessionId,
    events: sequenceEventsBySource(events),
    relationships,
    tasks,
    agentRuns: runs,
    contextArtifacts: artifacts
  };
  return finalizeSessionProtocol(sourceProtocol, {
    provider: "deepseek-harness",
    session: { ...input.session, metadata: headerMetadata },
    descriptor: {
      state: dshSessionStatus(input.records),
      origin: firstString(header.origin),
      forkSeedBoundary: asNumber(header.seedLength),
      inheritedEventCount: asNumber(header.seedLength),
      harness: firstString(header.agentPreset),
      terminalOutcome: firstString(turnEnd ? eventData(turnEnd).reason?.kind : null)
    },
    revision: DSH_COMPATIBILITY_SNAPSHOT.tag,
    freeze: true
  });
}
