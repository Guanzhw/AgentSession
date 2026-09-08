import type { Message, RawSession } from "../interface.js";
import {
  dshContentText,
  dshHeader,
  dshInheritedEventCount,
  dshNativeUsageRecords,
  dshOwnedEvents,
  dshUsageRecords,
  dshUsageOf,
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
import {
  actor,
  contextTransformation,
  contextVersion,
  coordinationObservation,
  goal,
  protocolCoverage,
  protocolDomainCoverage,
  usageRecord,
  type Actor,
  type CoordinationObservation,
  type Goal,
  type SessionProtocolV3,
  type UsageRecord
} from "../shared/session-protocol-v3.js";
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
    case "model/selection": return "model.selection";
    case "subagent/model-selection-policy": return "model.subagent-selection-policy";
    case "session-log-deepseek/delivery-accepted": return "control.delivery.accepted";
    case "user/message": return "message.user";
    case "assistant/message": return "message.assistant";
    case "assistant/attempt": return "assistant.attempt";
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
  if (event.type === "assistant/attempt") return "updated";
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
    sourceEventSeqs: Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs.slice() : null,
    ignorable: event.ignorable === true
  };
  if (event.type === "session/end-seed") {
    providerData.seedBoundary = true;
    providerData.inherited = data.inherited === true;
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
  } else if (event.type === "model/selection") {
    providerData.provider = firstString(data.provider);
    providerData.model = firstString(data.model);
    providerData.reasoningEffort = firstString(data.reasoningEffort);
  } else if (event.type === "subagent/model-selection-policy") {
    providerData.allowedModels = Array.isArray(data.allowedModels)
      ? data.allowedModels.flatMap((value) => {
        if (!isRecord(value)) return [];
        const provider = firstString(value.provider);
        const model = firstString(value.model);
        return provider && model ? [{ provider, model }] : [];
      })
      : [];
  } else if (event.type === "session-log-deepseek/delivery-accepted") {
    providerData.sessionId = firstString(data.sessionId);
    providerData.throughSeq = asNumber(data.throughSeq);
  } else if (event.type === "assistant/message") {
    providerData.usage = dshUsageToTokens(dshUsageOf(event));
  } else if (event.type === "assistant/attempt") {
    providerData.usage = dshUsageToTokens(dshUsageOf(event));
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
  } else if (event.type === "goal/change") {
    const operation = firstString(data.operation);
    const snapshot = data.goal && typeof data.goal === "object" && !Array.isArray(data.goal) ? data.goal as DshRecord : {};
    const cleared = data.cleared && typeof data.cleared === "object" && !Array.isArray(data.cleared) ? data.cleared as DshRecord : {};
    providerData.version = asNumber(data.version);
    providerData.operation = operation;
    providerData.goalId = firstString(snapshot.id, cleared.id);
    providerData.revision = asNumber(snapshot.revision ?? cleared.revision);
    providerData.objective = firstString(snapshot.objective);
    providerData.phase = firstString(snapshot.phase);
    providerData.blockedReason = snapshot.blockedReason ?? null;
    providerData.createdAt = asNumber(data.createdAt);
    providerData.updatedAt = asNumber(data.updatedAt);
    providerData.clearedAt = asNumber(data.clearedAt);
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
      childSessionAvailable,
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
      childSessionAvailable: child ? true : false,
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
    isSeeded: header.isSeeded === true,
    seedLength: header.version === 2 ? null : asNumber(header.seedLength),
    inheritedEventCount: dshInheritedEventCount(input.records),
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
      forkSeedBoundary: dshInheritedEventCount(input.records),
      inheritedEventCount: dshInheritedEventCount(input.records),
      harness: firstString(header.agentPreset),
      terminalOutcome: firstString(turnEnd ? eventData(turnEnd).reason?.kind : null)
    },
    revision: DSH_COMPATIBILITY_SNAPSHOT.tag,
    freeze: true
  });
}

type DshSessionRef = { provider: string; sessionId: string };

function dshV3Provenance(event: DshRecord, sourceType = `dsh.session-event:${String(event.type)}`) {
  return {
    fidelity: "recorded" as const,
    sourceType,
    sourceId: String(event.seq)
  };
}

function dshEventId(event: DshRecord): string {
  return `event:dsh:${event.seq}`;
}

function dshGoalStatus(phase: unknown): Goal["status"] {
  switch (phase) {
    case "active": return "active";
    case "paused": return "paused";
    case "blocked": return "blocked";
    case "complete": return "completed";
    default: return "unknown";
  }
}

function dshWorkflowCoordinationState(outcome: unknown): CoordinationObservation["state"] {
  switch (outcome) {
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    default: return "unknown";
  }
}

function dshMessageSource(event: DshRecord): DshRecord | null {
  const data = eventData(event);
  const message = isRecord(data.message) ? data.message : null;
  return message && isRecord(message.source) ? message.source : null;
}

type DshGoalPhase = "active" | "paused" | "blocked" | "complete";
type DshGoalSnapshot = {
  id: string;
  revision: number;
  objective: string;
  phase: DshGoalPhase;
  maxGoalRounds: number;
  blockedReason?: { code: string; message: string };
};
type DshGoalChange =
  | { operation: "clear"; cleared: { id: string; revision: number }; clearedAt: number }
  | { operation: Exclude<GoalChangeOperation, "clear">; goal: DshGoalSnapshot; roundsStarted: number; createdAt: number; updatedAt: number };
type GoalChangeOperation = "create" | "edit" | "pause" | "resume" | "complete" | "block" | "clear";

function dshExactKeys(value: DshRecord, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key))
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function dshPositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} must be a positive safe integer`);
  return value as number;
}

function dshNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return value as number;
}

function dshGoalSnapshot(value: unknown): DshGoalSnapshot {
  if (!isRecord(value)) throw new Error("goal must be a record");
  const phase = value.phase;
  if (typeof value.id !== "string" || value.id.length === 0) throw new Error("goal.id must be non-empty");
  if (typeof value.objective !== "string" || value.objective.length === 0 || value.objective !== value.objective.trim()) {
    throw new Error("goal.objective must be non-empty and normalized");
  }
  if (phase !== "active" && phase !== "paused" && phase !== "blocked" && phase !== "complete") throw new Error("goal.phase is invalid");
  const keys = phase === "blocked"
    ? ["blockedReason", "id", "maxGoalRounds", "objective", "phase", "revision"]
    : ["id", "maxGoalRounds", "objective", "phase", "revision"];
  if (!dshExactKeys(value, keys)) throw new Error(`goal fields are invalid for phase ${phase}`);
  const snapshot: DshGoalSnapshot = {
    id: value.id,
    revision: dshPositiveInteger(value.revision, "goal.revision"),
    objective: value.objective,
    phase,
    maxGoalRounds: dshPositiveInteger(value.maxGoalRounds, "goal.maxGoalRounds")
  };
  if (phase === "blocked") {
    const reason = value.blockedReason;
    if (!isRecord(reason) || !dshExactKeys(reason, ["code", "message"])
      || typeof reason.code !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(reason.code)
      || typeof reason.message !== "string" || reason.message.length === 0 || reason.message !== reason.message.trim()) {
      throw new Error("goal.blockedReason is invalid");
    }
    snapshot.blockedReason = { code: reason.code, message: reason.message };
  }
  return snapshot;
}

function dshDecodeGoalChange(value: unknown): DshGoalChange {
  if (!isRecord(value) || value.kind !== "goal/change") throw new Error("goal change kind is invalid");
  if (value.version !== 1) throw new Error(`goal change version ${String(value.version)} is unsupported`);
  if (value.operation === "clear") {
    if (!dshExactKeys(value, ["cleared", "clearedAt", "kind", "operation", "version"])) throw new Error("goal clear fields are invalid");
    const cleared = value.cleared;
    if (!isRecord(cleared) || !dshExactKeys(cleared, ["id", "revision"])
      || typeof cleared.id !== "string" || cleared.id.length === 0) throw new Error("goal clear ref is invalid");
    return { operation: "clear", cleared: { id: cleared.id, revision: dshPositiveInteger(cleared.revision, "cleared.revision") }, clearedAt: dshNonNegativeInteger(value.clearedAt, "clearedAt") };
  }
  const operations = new Set<Exclude<GoalChangeOperation, "clear">>(["create", "edit", "pause", "resume", "complete", "block"]);
  if (typeof value.operation !== "string" || !operations.has(value.operation as Exclude<GoalChangeOperation, "clear">)) throw new Error("goal change operation is invalid");
  if (!dshExactKeys(value, ["createdAt", "goal", "kind", "operation", "roundsStarted", "updatedAt", "version"])) throw new Error("goal snapshot fields are invalid");
  const createdAt = dshNonNegativeInteger(value.createdAt, "createdAt");
  const updatedAt = dshNonNegativeInteger(value.updatedAt, "updatedAt");
  if (updatedAt < createdAt) throw new Error("updatedAt cannot precede createdAt");
  return {
    operation: value.operation as Exclude<GoalChangeOperation, "clear">,
    goal: dshGoalSnapshot(value.goal),
    roundsStarted: dshNonNegativeInteger(value.roundsStarted, "roundsStarted"),
    createdAt,
    updatedAt
  };
}

function dshSameGoalDefinition(left: DshGoalSnapshot, right: DshGoalSnapshot): boolean {
  return left.objective === right.objective && left.maxGoalRounds === right.maxGoalRounds;
}

function dshSameBlockedReason(left: DshGoalSnapshot, right: DshGoalSnapshot): boolean {
  return JSON.stringify(left.blockedReason) === JSON.stringify(right.blockedReason);
}

function dshApplyGoalChange(state: {
  goal: DshGoalSnapshot | null;
  roundsStarted: number;
  createdAt: number | null;
  updatedAt: number | null;
  seenGoalIds: Set<string>;
}, change: DshGoalChange): void {
  if (change.operation === "clear") {
    if (!state.goal || change.cleared.id !== state.goal.id || change.cleared.revision !== state.goal.revision + 1) throw new Error("goal clear does not match the current next revision");
    if (state.updatedAt === null || change.clearedAt < state.updatedAt) throw new Error("goal clear timestamp precedes the current update");
    state.goal = null;
    state.roundsStarted = 0;
    state.createdAt = null;
    state.updatedAt = null;
    return;
  }
  if (change.operation === "create") {
    if (change.goal.revision !== 1 || change.goal.phase !== "active" || change.roundsStarted !== 0
      || (state.goal !== null && state.goal.phase !== "complete") || state.seenGoalIds.has(change.goal.id)) {
      throw new Error("goal create requires a fresh active revision-one goal with zero rounds");
    }
    state.seenGoalIds.add(change.goal.id);
  } else {
    const current = state.goal;
    if (!current) throw new Error(`goal ${change.operation} requires a current goal`);
    if (change.goal.id !== current.id || change.goal.revision !== current.revision + 1) throw new Error(`goal ${change.operation} must advance the current goal by one revision`);
    if (state.createdAt === null || state.updatedAt === null || change.createdAt !== state.createdAt || change.updatedAt < state.updatedAt || change.roundsStarted !== state.roundsStarted) {
      throw new Error(`goal ${change.operation} does not preserve counters and timestamps`);
    }
    switch (change.operation) {
      case "edit":
        if (change.goal.phase !== current.phase || !dshSameBlockedReason(change.goal, current)) throw new Error("goal edit has an invalid phase or blocked reason");
        break;
      case "pause":
        if (!dshSameGoalDefinition(current, change.goal) || current.phase !== "active" || change.goal.phase !== "paused") throw new Error("goal pause transition is invalid");
        break;
      case "resume":
        if (!dshSameGoalDefinition(current, change.goal) || !new Set<DshGoalPhase>(["active", "paused", "blocked"]).has(current.phase) || change.goal.phase !== "active" || state.roundsStarted >= change.goal.maxGoalRounds) throw new Error("goal resume transition is invalid");
        break;
      case "complete":
        if (!dshSameGoalDefinition(current, change.goal) || current.phase === "complete" || change.goal.phase !== "complete") throw new Error("goal complete transition is invalid");
        break;
      case "block":
        if (!dshSameGoalDefinition(current, change.goal) || current.phase !== "active" || change.goal.phase !== "blocked") throw new Error("goal block transition is invalid");
        break;
    }
  }
  state.goal = change.goal;
  state.roundsStarted = change.roundsStarted;
  state.createdAt = change.createdAt;
  state.updatedAt = change.updatedAt;
}

function dshReplayGoals(records: DshRecord[]): { goal: DshGoalSnapshot | null; event: DshRecord | null; createdAt: number | null; updatedAt: number | null; error: string | null } {
  const state = { goal: null as DshGoalSnapshot | null, event: null as DshRecord | null, roundsStarted: 0, createdAt: null as number | null, updatedAt: null as number | null, seenGoalIds: new Set<string>() };
  for (const event of dshOwnedEvents(records)) {
    try {
      if (event.type === "goal/change") {
        dshApplyGoalChange(state, dshDecodeGoalChange(event.data));
        state.event = state.goal ? event : null;
      } else if (event.type === "user/message") {
        const data = eventData(event);
        const source = isRecord(data.source) ? data.source : null;
        if (!source || source.kind !== "goal") continue;
        if (!dshExactKeys(source, ["kind", "goalId", "revision", "round"]) || typeof source.goalId !== "string" || source.goalId.length === 0) throw new Error("goal message source is invalid");
        const current = state.goal;
        const revision = dshPositiveInteger(source.revision, "goal source revision");
        const round = dshPositiveInteger(source.round, "goal source round");
        if (!current || current.phase !== "active" || source.goalId !== current.id || revision !== current.revision || round !== state.roundsStarted + 1 || round > current.maxGoalRounds) throw new Error("goal message source is not the next admitted round");
        state.roundsStarted = round;
      }
    } catch (error) {
      return { goal: null, event: null, createdAt: null, updatedAt: null, error: `goal replay invalid at source seq ${String(event.seq)}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { goal: state.goal, event: state.event, createdAt: state.createdAt, updatedAt: state.updatedAt, error: null };
}

/**
 * Build DSH's native v3 additive facts over the provider's finalized v2
 * snapshot. This function deliberately never turns a count or a relationship
 * into a stronger provider claim: every new entity below is anchored to one
 * released alpha.2 event or an exact child session identity.
 */
export function buildDshSessionProtocolV3(
  input: DshProtocolInput,
  base: SessionProtocol = buildDshSessionProtocol(input)
): SessionProtocolV3 {
  const sessionId = String(input.session.id);
  const ownRef: DshSessionRef = { provider: "deepseek-harness", sessionId };
  const owned = dshOwnedEvents(input.records);
  const childById = new Map(input.children.map((child) => [String(child.session.id), child]));
  const baseRunByChildId = new Map(base.agentRuns
    .filter((run) => run.childSessionId)
    .map((run) => [String(run.childSessionId), run]));
  const baseEventBySourceSeq = new Map(base.events.map((event) => [event.providerData?.sourceSequence, event]));
  const eventFor = (event: DshRecord) => baseEventBySourceSeq.get(sourceSequence(Number(event.seq) || 0)) || null;

  // --- Explicit actors ----------------------------------------------------
  const actors: Actor[] = [];
  const actorByProviderId = new Map<string, Actor>();
  const addActor = (value: Actor) => {
    if (!actorByProviderId.has(value.providerActorId || value.id)) {
      actorByProviderId.set(value.providerActorId || value.id, value);
      actors.push(value);
    }
    return actorByProviderId.get(value.providerActorId || value.id)!;
  };
  const ensureActor = ({
    providerActorId,
    kind,
    name,
    sessionRef,
    event,
    sourceType
  }: {
    providerActorId: string;
    kind: Actor["kind"];
    name?: string | null;
    sessionRef?: DshSessionRef | null;
    event: DshRecord;
    sourceType?: string;
  }) => {
    const existing = actorByProviderId.get(providerActorId);
    if (existing) return existing;
    return addActor(actor({
      id: `actor:dsh:${providerActorId}`,
      kind,
      name: name || providerActorId,
      providerActorId,
      sessionRef: sessionRef || null,
      runIds: sessionRef?.sessionId ? (baseRunByChildId.get(sessionRef.sessionId)?.id ? [baseRunByChildId.get(sessionRef.sessionId)!.id] : []) : [],
      provenance: dshV3Provenance(event, sourceType || `dsh.session-event:${String(event.type)}`)
    }));
  };
  const parentHeader = dshHeader(input.records) || {};
  const parent = addActor(actor({
    id: `actor:dsh:session:${sessionId}`,
    kind: "agent",
    name: firstString(parentHeader.agentPreset, sessionId),
    providerActorId: sessionId,
    sessionRef: ownRef,
    runIds: [],
    provenance: {
      fidelity: "recorded",
      sourceType: "dsh.session.header",
      sourceId: sessionId
    }
  }));
  const actorForId = (providerActorId: unknown, event: DshRecord, kind: Actor["kind"] = "unknown") => {
    const id = firstString(providerActorId);
    if (!id) return null;
    if (id === sessionId) return parent;
    const team = teamActorById.get(id);
    if (team) return team;
    const child = childById.get(id);
    return ensureActor({
      providerActorId: id,
      kind: child ? "agent" : kind,
      name: child ? firstString(child.session.metadata?.agentPreset, id) : id,
      sessionRef: child ? { provider: "deepseek-harness", sessionId: id } : null,
      event
    });
  };

  const teamActorById = new Map<string, Actor>();
  for (const event of owned) {
    if (event.type !== "team/member" && event.type !== "team/task" && event.type !== "team/message/queued" && event.type !== "team/message/delivered") continue;
    const data = eventData(event);
    const teamId = firstString(data.teamId);
    if (!teamId || teamActorById.has(teamId)) continue;
    // A team may use the root session id as its provider id. Keep the
    // explicit team actor distinct from the root agent actor in that case.
    const team = actor({
      id: `actor:dsh:team:${teamId}`,
      kind: "team",
      name: teamId,
      providerActorId: teamId,
      sessionRef: null,
      runIds: [],
      memberActorIds: [],
      provenance: dshV3Provenance(event, "dsh.session-event:team")
    });
    actors.push(team);
    teamActorById.set(teamId, team);
  }
  for (const member of teamMembers(input.records)) {
    const memberId = member.id;
    const teamId = member.teamId;
    const memberActor = actorForId(memberId, member.event, "agent") || ensureActor({ providerActorId: memberId, kind: "agent", event: member.event });
    const existingTeam = teamId ? teamActorById.get(teamId) : null;
    if (existingTeam && !existingTeam.memberActorIds?.includes(memberActor.id)) {
      existingTeam.memberActorIds = [...(existingTeam.memberActorIds || []), memberActor.id];
      memberActor.teamId = existingTeam.id;
    }
    memberActor.name = firstString(member.name, memberId);
  }

  // --- Durable goals ------------------------------------------------------
  const goalReplay = dshReplayGoals(input.records);
  const currentGoal = goalReplay.goal;
  const goals: Goal[] = currentGoal && goalReplay.event ? [goal({
    id: `goal:${currentGoal.id}`,
    sessionId,
    title: null,
    description: currentGoal.objective,
    status: dshGoalStatus(currentGoal.phase),
    taskIds: [],
    parentGoalId: null,
    ownerActorId: null,
    timeCreated: goalReplay.createdAt,
    timeUpdated: goalReplay.updatedAt,
    timeCompleted: currentGoal.phase === "complete" ? goalReplay.updatedAt : null,
    provenance: dshV3Provenance(goalReplay.event)
  })] : [];

  // --- Coordination: team mailbox and workflow lifecycle -----------------
  const coordination: CoordinationObservation[] = [];
  const teamMessageSender = new Map<string, Actor>();
  for (const event of owned) {
    if (event.type !== "team/message/queued") continue;
    const data = eventData(event);
    const message = isRecord(data.message) ? data.message : {};
    const messageId = firstString(message.id);
    if (!messageId) continue;
    const sender = actorForId(message.senderId, event);
    const recipient = actorForId(message.targetId, event);
    if (sender) teamMessageSender.set(messageId, sender);
    coordination.push(coordinationObservation({
      id: `coord:dsh:team-message:${messageId}:queued`,
      sessionId,
      kind: "message",
      state: "requested",
      timestamp: asNumber(event.time),
      senderActorId: sender?.id || null,
      recipientActorId: recipient?.id || null,
      fromSessionRef: sender?.sessionRef || null,
      toSessionRef: recipient?.sessionRef || null,
      taskId: null,
      runId: null,
      eventId: eventFor(event)?.id || dshEventId(event),
      turnId: asNumber(data.turn) == null ? null : String(data.turn),
      correlationId: messageId,
      provenance: dshV3Provenance(event)
    }));
  }
  for (const event of owned) {
    if (event.type !== "team/message/delivered") continue;
    const data = eventData(event);
    const messageId = firstString(data.messageId);
    if (!messageId) continue;
    const sender = teamMessageSender.get(messageId) || null;
    const recipient = actorForId(data.targetId, event);
    coordination.push(coordinationObservation({
      id: `coord:dsh:team-message:${messageId}:delivered`,
      sessionId,
      kind: "mailbox-delivery",
      state: "delivered",
      timestamp: asNumber(event.time),
      senderActorId: sender?.id || null,
      recipientActorId: recipient?.id || null,
      fromSessionRef: sender?.sessionRef || null,
      toSessionRef: recipient?.sessionRef || null,
      taskId: null,
      runId: null,
      eventId: eventFor(event)?.id || dshEventId(event),
      turnId: asNumber(data.turn) == null ? null : String(data.turn),
      correlationId: messageId,
      provenance: dshV3Provenance(event)
    }));
  }

  const workflowStarts = new Map<string, DshRecord>();
  const workflowTaskByCorrelation = new Map(base.tasks
    .filter((task) => task.correlationId)
    .map((task) => [String(task.correlationId), task]));
  for (const event of owned) {
    if (event.type === "tool-workflow/agent-start") {
      const data = eventData(event);
      const runId = firstString(data.runId);
      const sequence = asNumber(data.seq);
      if (runId && sequence != null) workflowStarts.set(`${runId}:${sequence}`, event);
    }
  }
  for (const event of owned) {
    if (event.type !== "tool-workflow/agent-start" && event.type !== "tool-workflow/agent-end") continue;
    const data = eventData(event);
    const runId = firstString(data.runId);
    const sequence = asNumber(data.seq);
    if (!runId || sequence == null) continue;
    const start = event.type === "tool-workflow/agent-start" ? event : workflowStarts.get(`${runId}:${sequence}`);
    const childId = firstString((start && eventData(start).childId) || data.childId);
    const child = childId ? childById.get(childId) : null;
    const workflowCorrelationId = `${runId}:${sequence}`;
    const workflowTask = workflowTaskByCorrelation.get(workflowCorrelationId) || null;
    const run = child && workflowTask
      ? base.agentRuns.find((candidate) => candidate.taskId === workflowTask.id && candidate.childSessionId === childId) || null
      : null;
    const recipient = childId
      ? actorForId(childId, start || event, "agent")
      : null;
    const isWorkflowStart = event.type === "tool-workflow/agent-start";
    const endState = isWorkflowStart ? "started" as const : dshWorkflowCoordinationState(data.outcome);
    coordination.push(coordinationObservation({
      id: `coord:dsh:workflow:${runId}:${sequence}:${event.type.endsWith("start") ? "start" : "end"}`,
      sessionId,
      kind: "spawn",
      state: endState,
      timestamp: asNumber(event.time),
      senderActorId: parent.id,
      recipientActorId: recipient?.id || null,
      fromSessionRef: ownRef,
      toSessionRef: child ? { provider: "deepseek-harness", sessionId: childId! } : null,
      taskId: workflowTask?.id || null,
      runId: child ? (run?.id || null) : null,
      eventId: eventFor(event)?.id || dshEventId(event),
      turnId: asNumber(data.turn) == null ? null : String(data.turn),
      correlationId: workflowCorrelationId,
      provenance: dshV3Provenance(event)
    }));
  }

  // --- Context transformations -------------------------------------------
  const contextVersions = [] as ReturnType<typeof contextVersion>[];
  const contextTransformations = [] as ReturnType<typeof contextTransformation>[];
  const summaryArtifacts = new Map<string, string>();
  for (const artifact of base.contextArtifacts) {
    const sourceId = artifact.provenance?.sourceId;
    if (sourceId) summaryArtifacts.set(sourceId, artifact.id);
  }
  for (const event of owned) {
    if (event.type !== "compaction/summary") continue;
    const data = eventData(event);
    const summary = dshContentText(data.summary).trim();
    if (!summary) continue;
    const artifactId = summaryArtifacts.get(String(event.seq)) || `artifact:dsh:${event.seq}`;
    const versionId = `context-version:dsh:${event.seq}`;
    const provenance = dshV3Provenance(event);
    contextVersions.push(contextVersion({
      id: versionId,
      sessionId,
      sequence: Number(event.seq),
      parentVersionIds: [],
      artifactIds: [artifactId],
      createdAt: asNumber(event.time),
      provenance
    }));
    contextTransformations.push(contextTransformation({
      id: `context-transformation:dsh:${event.seq}`,
      sessionId,
      kind: "compaction",
      sourceVersionIds: [],
      resultVersionId: versionId,
      sourceArtifactIds: [],
      resultArtifactIds: [artifactId],
      eventId: eventFor(event)?.id || dshEventId(event),
      runId: null,
      turnId: asNumber(data.turn) == null ? null : String(data.turn),
      timestamp: asNumber(event.time),
      provenance
    }));
  }

  // --- Exactly-once provider request usage --------------------------------
  const usageRecords: UsageRecord[] = dshNativeUsageRecords(input.records).flatMap((event) => {
    const tokens = dshUsageToTokens(dshUsageOf(event));
    if (!tokens) return [];
    const source = dshMessageSource(event);
    const data = eventData(event);
    return [usageRecord({
      id: `usage:dsh:${sessionId}:${event.seq}`,
      scope: "request",
      sessionRef: ownRef,
      timestamp: asNumber(event.time),
      model: firstString(source?.model),
      runId: null,
      eventId: eventFor(event)?.id || dshEventId(event),
      turnId: asNumber(data.turn) == null ? null : String(data.turn),
      tokens: {
        input: tokens.input,
        cacheRead: tokens.cache?.read,
        cacheWrite: tokens.cache?.write,
        output: tokens.output,
        reasoning: tokens.reasoning,
        total: tokens.total
      },
      contextOriginSlices: [],
      provenance: dshV3Provenance(event, `dsh.session-event:${String(event.type)}:usage`)
    })];
  });

  const nativeWorkflow = owned.some((event) => event.type === "tool-workflow/agent-start" || event.type === "tool-workflow/agent-end");
  const nativeMailbox = coordination.some((entry) => entry.kind === "message" || entry.kind === "mailbox-delivery");
  const hasTaskEvidence = base.tasks.length > 0;
  const workDetails = goalReplay.error
    ? `${goalReplay.error}; ${hasTaskEvidence ? "task evidence remains observed" : "no valid task evidence"}`
    : "strict goal replay and recorded task evidence";
  const revision = DSH_COMPATIBILITY_SNAPSHOT.tag;
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
    revision: base.revision || { value: revision, source: "provider" },
    goals,
    actors,
    coordination,
    contextVersions,
    contextTransformations,
    usageRecords,
    coverage: protocolCoverage({
      work: protocolDomainCoverage(goalReplay.error ? (hasTaskEvidence ? "observed" : "unknown") : (goals.length > 0 || hasTaskEvidence ? "observed" : "not-observed"), workDetails),
      execution: protocolDomainCoverage(actors.length > 0 || nativeWorkflow ? "observed" : "not-observed", "recorded actors plus explicit workflow lifecycle or session-backed child runs"),
      coordination: protocolDomainCoverage(nativeMailbox || nativeWorkflow ? "observed" : "not-observed", "team mailbox and workflow lifecycle records only"),
      context: protocolDomainCoverage(contextTransformations.length > 0 || base.contextArtifacts.length > 0 ? "observed" : "not-observed", "recorded context artifacts and readable compaction summaries"),
      usage: protocolDomainCoverage(usageRecords.length > 0 ? "observed" : "not-observed", "assistant settlement usage folded once per turn/step slot")
    })
  };
}
