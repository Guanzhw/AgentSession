import type { RawSession } from "../interface.js";
import {
  agentRun,
  capabilityDescriptor,
  finalizeSessionProtocol,
  protocolRevision,
  sessionEvent,
  sessionRelationship,
  sessionTask,
  type SessionProtocol,
  type SessionRef
} from "../shared/session-protocol.js";
import {
  coordinationObservation,
  protocolCoverage,
  protocolDomainCoverage,
  usageRecord,
  type ContextTransformation,
  type CoordinationObservation,
  type SessionProtocolV3,
  type UsageRecord
} from "../shared/session-protocol-v3.js";
import { isSubagentTool, mergeToolMetadata } from "../shared/subagent-tools.js";
import type { OpenCodeSessionTree, OpenCodeTodoRow, SessionPartNode } from "./session-tree.js";

type Row = Record<string, any>;

export const openCodeProtocolCapabilities = {
  sessionEvents: capabilityDescriptor("partial", "derived", "Native messages and parts projected into protocol events"),
  sessionRelationships: capabilityDescriptor("full", "recorded", "Native session.parent_id relationships"),
  tasks: capabilityDescriptor("partial", "derived", "Native todo rows and subagent tool parts projected into task records"),
  agentRuns: capabilityDescriptor("partial", "derived", "Subagent tool parts and child sessions projected into runs"),
  contextArtifacts: capabilityDescriptor("none", "derived"),
  branches: capabilityDescriptor("none", "derived")
};

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metadata(part: SessionPartNode): Row {
  const merged = mergeToolMetadata(part.data.state?.metadata, part.data.metadata);
  if (typeof part.data.state?.title === "string") merged.title = part.data.state.title;
  return merged;
}

function taskOutputState(part: SessionPartNode): "running" | "completed" | "error" | null {
  const output = part.data.state?.output;
  if (typeof output !== "string") return null;
  const match = output.match(/<task\b[^>]*\bstate=["'](running|completed|error)["']/i);
  return match ? match[1].toLowerCase() as "running" | "completed" | "error" : null;
}

function status(part: SessionPartNode, hasChild: boolean) {
  const raw = String(part.data.state?.status || "").toLowerCase();
  const isBackground = metadata(part).background === true;
  const taskState = taskOutputState(part);
  // background=true records execution mode, not completion. A terminal
  // background state is proven only by the task result envelope.
  if (isBackground) {
    if (taskState === "error") return "failed" as const;
    if (taskState === "completed") return "completed" as const;
    return "running" as const;
  }
  if (["error", "failed", "failure"].includes(raw)) return "failed" as const;
  if (["running", "pending", "started"].includes(raw)) return "running" as const;
  if (taskState === "error") return "failed" as const;
  if (taskState === "running") return "running" as const;
  if (taskState === "completed") return "completed" as const;
  return hasChild || number(part.timeEnd) ? "completed" as const : "running" as const;
}

function executionMode(part: SessionPartNode) {
  return metadata(part).background === true ? "background" as const : "subagent" as const;
}

function todoStatus(value: unknown) {
  const raw = String(value || "").toLowerCase();
  if (raw === "pending") return "queued" as const;
  if (raw === "completed") return "completed" as const;
  if (raw === "cancelled" || raw === "canceled") return "cancelled" as const;
  if (raw === "in_progress" || raw === "running") return "running" as const;
  return null;
}

function todoIdentity(sessionId: string, todo: OpenCodeTodoRow) {
  // OpenCode's provider key is (session_id, position). Mutable content,
  // priority, and timestamps are not identity evidence.
  return `todo:${sessionId}:${number(todo.position)}`;
}

function rawSession(session: Row): RawSession {
  return {
    id: String(session.id), provider: "opencode", parentId: session.parent_id || null,
    title: session.title || session.slug || null, directory: session.directory || null,
    timeCreated: number(session.time_created) || 0, timeUpdated: number(session.time_updated) || 0,
    messageCount: number(session.message_count) || 0, tokenCount: number(session.token_count),
    metadata: { agent: session.agent || null, model: session.model || null }
  };
}

function partTimestamp(part: SessionPartNode): number | null {
  return number(part.timeStart) || number(part.timeEnd);
}

/** Build the protocol directly from OpenCode's native message/part/session tree. */
export function buildOpenCodeSessionProtocol(tree: OpenCodeSessionTree, revision: string | number): SessionProtocol {
  const session = rawSession(tree.session);
  const sessionId = session.id;
  const events: ReturnType<typeof sessionEvent>[] = [sessionEvent({
    id: `session.started:${sessionId}`, sessionId, timestamp: session.timeCreated || null,
    kind: "session.started", phase: "started", provenance: { fidelity: "recorded", sourceType: "opencode.session", sourceId: sessionId }
  })];
  const tasks: ReturnType<typeof sessionTask>[] = [];
  const runs: ReturnType<typeof agentRun>[] = [];
  const relationships: ReturnType<typeof sessionRelationship>[] = [];
  const spawnedChildIds = new Set<string>();
  const messageIds = new Set(tree.messages.map((message) => message.id));

  for (const todo of tree.todos || []) {
    const position = number(todo.position);
    if (position === null || typeof todo.content !== "string") continue;
    const taskStatus = todoStatus(todo.status);
    if (!taskStatus) continue;
    const taskId = todoIdentity(sessionId, todo);
    tasks.push(sessionTask({
      id: taskId, sessionId, kind: "todo", status: taskStatus,
      title: todo.content, timeCreated: number(todo.time_created), timeUpdated: number(todo.time_updated),
      timeCompleted: taskStatus === "completed" || taskStatus === "cancelled" ? number(todo.time_updated) : null,
      provenance: { fidelity: "recorded", sourceType: "opencode.todo", sourceId: `${sessionId}:${position}` },
      metadata: { priority: typeof todo.priority === "string" ? todo.priority : null }
    }));
  }

  for (const message of tree.messages) {
    const role = String(message.role || "unknown").toLowerCase();
    const messageKind = role === "user" ? "message.user" : role === "assistant" ? "message.assistant" : `message.${role}`;
    events.push(sessionEvent({
      id: `message:${message.id}`, sessionId, timestamp: message.timeCreated || null,
      kind: messageKind, turnId: message.id,
      provenance: { fidelity: "recorded", sourceType: "opencode.message", sourceId: message.id },
      providerData: { model: message.data.modelID || null, provider: message.data.providerID || null }
    }));
    for (const part of message.parts) {
      const data = part.data;
      const timestamp = partTimestamp(part);
      let kind = "part.updated";
      let phase: "started" | "updated" | "completed" | "failed" | undefined = "updated";
      if (data.type === "text") kind = "message.text";
      else if (data.type === "reasoning") kind = "reasoning.delta";
      else if (data.type === "subtask") {
        kind = "task.requested";
        phase = "started";
      } else if (data.type === "compaction") {
        kind = "context.compaction";
      }
      else if (data.type === "tool") {
        const raw = String(data.state?.status || "").toLowerCase();
        kind = ["error", "failed"].includes(raw) ? "tool.failed" : ["completed", "success"].includes(raw) ? "tool.completed" : "tool.called";
        phase = kind === "tool.failed" ? "failed" : kind === "tool.completed" ? "completed" : "started";
      }
      const callId = typeof data.callID === "string" && data.callID ? data.callID : null;
      const partEvent = sessionEvent({
        id: `part:${part.id}`, sessionId, timestamp, kind, phase, turnId: message.id,
        correlationId: callId,
        provenance: { fidelity: "recorded", sourceType: `opencode.part.${String(data.type || "unknown")}`, sourceId: part.id },
        providerData: {
          type: data.type || null,
          tool: data.tool || null,
          status: data.state?.status || null,
          ...(data.type === "subtask" ? {
            agent: data.agent || null,
            description: data.description || null,
            command: data.command || null,
            model: data.model || null
          } : {}),
          ...(data.type === "compaction" ? {
            auto: typeof data.auto === "boolean" ? data.auto : null,
            overflow: typeof data.overflow === "boolean" ? data.overflow : null,
            tailStartId: data.tail_start_id || null
          } : {})
        }
      });
      if (data.type === "compaction") {
        partEvent.compaction = {
          trigger: data.auto === true ? "automatic" : data.auto === false ? "manual" : "unknown",
          strategy: "unknown",
          tokensBefore: null,
          tokensAfter: null,
          summary: null,
          retainedFromEventId: typeof data.tail_start_id === "string" && messageIds.has(data.tail_start_id)
            ? `message:${data.tail_start_id}`
            : null
        };
      }
      events.push(partEvent);

      if (data.type !== "tool" || !isSubagentTool(data.tool, mergeToolMetadata(data.state?.metadata, data.metadata))) continue;
      const children = part.childSessions || [];
      const toolMetadata = metadata(part);
      const taskId = `task:${part.id}`;
      const runId = `run:${part.id}`;
      const taskStatus = status(part, children.length > 0);
      const child = children[0];
      const completed = taskStatus === "completed" || taskStatus === "failed";
      tasks.push(sessionTask({
        id: taskId, sessionId, kind: "subagent-task", status: taskStatus,
        title: typeof toolMetadata.title === "string" ? toolMetadata.title : data.tool || "subagent", toolCallId: callId, correlationId: callId,
        requestEventId: `part:${part.id}`, triggerEventId: `part:${part.id}`,
        timeCreated: partTimestamp(part), timeUpdated: partTimestamp(part), timeCompleted: completed ? number(part.timeEnd) : null,
        provenance: { fidelity: "derived", sourceType: "opencode.part", sourceId: part.id }, metadata: {
          tool: data.tool || null,
          background: toolMetadata.background === true,
          jobId: typeof toolMetadata.jobId === "string" ? toolMetadata.jobId : null
        }
      }));
      runs.push(agentRun({
        id: runId, sessionId, taskId, status: taskStatus, mode: executionMode(part),
        agent: child?.session.title || data.tool || null, model: child?.session.model || null,
        childSessionId: child ? String(child.session.id) : null, triggerEventId: `part:${part.id}`,
        timeStart: number(part.timeStart), timeEnd: completed ? number(part.timeEnd) : null,
        provenance: { fidelity: "derived", sourceType: "opencode.part", sourceId: part.id }
      }));
      for (const childTree of children) {
        const childSessionId = String(childTree.session.id);
        if (spawnedChildIds.has(childSessionId)) continue;
        spawnedChildIds.add(childSessionId);
        relationships.push(sessionRelationship({
          type: "spawned", fromSessionId: sessionId, toSessionId: childSessionId,
          correlationId: callId, triggerEventId: `part:${part.id}`, taskId, runId,
          timestamp: partTimestamp(part),
          provenance: { fidelity: "recorded", sourceType: "opencode.session.parent_id", sourceId: childSessionId }
        }));
      }
    }
  }

  for (const child of tree.detachedChildren || []) {
    relationships.push(sessionRelationship({
      type: "parent", fromSessionId: String(child.session.id), toSessionId: sessionId,
      timestamp: number(child.session.time_created),
      provenance: { fidelity: "recorded", sourceType: "opencode.session.parent_id", sourceId: String(child.session.id) }
    }));
  }
  // A focused child exposes its own recorded parent lineage. Root construction
  // already binds launcher-matched children as spawned relationships, so this
  // incoming edge is not duplicated there.
  if (typeof session.parentId === "string" && session.parentId) {
    relationships.push(sessionRelationship({
      type: "parent", fromSessionId: sessionId, toSessionId: session.parentId,
      timestamp: session.timeCreated,
      provenance: { fidelity: "recorded", sourceType: "opencode.session.parent_id", sourceId: sessionId }
    }));
  }
  return finalizeSessionProtocol({ sessionId, events, relationships, tasks, agentRuns: runs, contextArtifacts: [] }, {
    provider: "opencode", session, capabilities: openCodeProtocolCapabilities, revision: protocolRevision(revision)
  });
}

function messageTokens(message: OpenCodeSessionTree["messages"][number]): Row | null {
  const tokens = message.data?.tokens;
  return tokens && typeof tokens === "object" && !Array.isArray(tokens) ? tokens as Row : null;
}

function tokenNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

function taskStateForResult(part: SessionPartNode): "completed" | "error" | null {
  const state = taskOutputState(part);
  return state === "completed" || state === "error" ? state : null;
}

/** Build OpenCode's native v3 additive facts over the finalized v2 snapshot. */
export function buildOpenCodeSessionProtocolV3(
  tree: OpenCodeSessionTree,
  base: SessionProtocol
): SessionProtocolV3 {
  const sessionId = String(tree.session.id);
  const ownRef: SessionRef = { provider: "opencode", sessionId };
  const subagentTasks = base.tasks.filter((task) => task.kind === "subagent-task");
  const runByTask = new Map(base.agentRuns.filter((run) => run.taskId).map((run) => [run.taskId!, run]));
  const relationshipsByTask = new Map(base.relationships.filter((relation) => relation.type === "spawned" && relation.taskId)
    .map((relation) => [relation.taskId!, relation]));
  const childIds = new Set(tree.messages.flatMap((message) => message.parts.flatMap((part) => part.childSessions.map((child) => String(child.session.id)))));
  const coordination: CoordinationObservation[] = [];

  // Each normalized subagent Task/Run gets one launch observation. Only a
  // matching spawned edge proves a child launch; otherwise it remains a
  // requested delegation with its known task/run and no guessed session.
  for (const task of subagentTasks) {
    const run = runByTask.get(task.id) || null;
    const relation = relationshipsByTask.get(task.id) || null;
    const exactChild = run?.childSessionId && relation?.toSessionId === run.childSessionId && childIds.has(run.childSessionId)
      ? run.childSessionId
      : null;
    const isSpawn = Boolean(run && relation && exactChild);
    coordination.push(coordinationObservation({
      id: `coord:opencode:launch:${task.id}`,
      sessionId,
      kind: isSpawn ? "spawn" : "delegate",
      state: isSpawn ? "started" : "requested",
      timestamp: task.timeCreated,
      fromSessionRef: ownRef,
      toSessionRef: exactChild ? { provider: "opencode", sessionId: exactChild } : null,
      relationshipType: isSpawn ? "spawned" : null,
      taskId: task.id,
      runId: run?.id || null,
      eventId: relation?.triggerEventId || task.requestEventId || null,
      turnId: relation?.triggerEventId ? base.events.find((event) => event.id === relation.triggerEventId)?.turnId || null : null,
      correlationId: task.correlationId || null,
      provenance: { fidelity: "derived", sourceType: "opencode.task.launch", sourceId: task.id }
    }));
  }

  // A structured subtask request is an independent provider event, not a
  // second v2 Task/Run. Its optional callID remains the only correlation key.
  for (const message of tree.messages) {
    for (const part of message.parts) {
      const data = part.data;
      const callId = typeof data.callID === "string" && data.callID ? data.callID : null;
      if (data.type === "subtask") {
        coordination.push(coordinationObservation({
          id: `coord:opencode:subtask:${part.id}`,
          sessionId,
          kind: "delegate",
          state: "requested",
          timestamp: partTimestamp(part),
          fromSessionRef: ownRef,
          toSessionRef: null,
          eventId: `part:${part.id}`,
          turnId: message.id,
          correlationId: callId,
          provenance: { fidelity: "recorded", sourceType: "opencode.part.subtask", sourceId: part.id }
        }));
      }
    }
  }

  // Generic tool completion/timeEnd and child presence do not deliver a
  // background result. Only the explicit <task state="completed|error">
  // result envelope creates this independent observation.
  for (const message of tree.messages) {
    for (const part of message.parts) {
      if (part.data.type !== "tool" || !isSubagentTool(part.data.tool, mergeToolMetadata(part.data.state?.metadata, part.data.metadata))) continue;
      const resultState = taskStateForResult(part);
      if (!resultState) continue;
      const task = base.tasks.find((candidate) => candidate.id === `task:${part.id}`) || null;
      const run = task ? runByTask.get(task.id) || null : null;
      const child = run?.childSessionId || null;
      const callId = typeof part.data.callID === "string" && part.data.callID ? part.data.callID : null;
      coordination.push(coordinationObservation({
        id: `coord:opencode:result:${part.id}`,
        sessionId,
        kind: "result-delivery",
        state: resultState === "completed" ? "delivered" : "failed",
        timestamp: partTimestamp(part),
        fromSessionRef: child ? { provider: "opencode", sessionId: child } : null,
        toSessionRef: ownRef,
        taskId: task?.id || null,
        runId: run?.id || null,
        eventId: `part:${part.id}`,
        turnId: message.id,
        correlationId: callId,
        provenance: { fidelity: "recorded", sourceType: "opencode.task.result", sourceId: part.id }
      }));
    }
  }

  const usageRecords: UsageRecord[] = [];
  for (const message of tree.messages) {
    if (String(message.role).toLowerCase() !== "assistant") continue;
    const tokens = messageTokens(message);
    if (!tokens) continue;
    const input = tokenNumber(tokens.input) ?? 0;
    const cacheRead = tokenNumber(tokens.cache?.read);
    const cacheWrite = tokenNumber(tokens.cache?.write);
    const output = tokenNumber(tokens.output) ?? 0;
    const reasoning = tokenNumber(tokens.reasoning) ?? 0;
    if (input === 0 && (cacheRead ?? 0) === 0 && (cacheWrite ?? 0) === 0 && output === 0 && reasoning === 0) continue;
    const sum = input + (cacheRead ?? 0) + (cacheWrite ?? 0) + output + reasoning;
    const rawTotal = tokenNumber(tokens.total);
    usageRecords.push(usageRecord({
      id: `usage:${sessionId}:message:${message.id}`,
      scope: "request",
      sessionRef: ownRef,
      timestamp: message.timeCreated,
      model: typeof message.data.modelID === "string" ? message.data.modelID : null,
      runId: null,
      eventId: `message:${message.id}`,
      turnId: message.id,
      tokens: { input, cacheRead, cacheWrite, output, reasoning, total: rawTotal === sum ? rawTotal : null },
      contextOriginSlices: [],
      provenance: { fidelity: "recorded", sourceType: "opencode.message.tokens", sourceId: message.id }
    }));
  }

  const hasCompaction = base.events.some((event) => event.kind === "context.compaction");
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
    coordination,
    contextVersions: [],
    contextTransformations: [] as ContextTransformation[],
    usageRecords,
    coverage: protocolCoverage({
      work: protocolDomainCoverage(base.tasks.length > 0 ? "observed" : "not-observed", "normalized OpenCode todo and subagent tasks"),
      execution: protocolDomainCoverage(base.agentRuns.length > 0 ? "observed" : "not-observed", "normalized OpenCode agent runs"),
      coordination: protocolDomainCoverage(coordination.length > 0 ? "observed" : "not-observed", "recorded task launch, subtask, and explicit result envelopes"),
      context: protocolDomainCoverage(hasCompaction ? "unknown" : "not-observed", hasCompaction ? "compaction operation is recorded without a result context version" : "no OpenCode context version/result records"),
      usage: protocolDomainCoverage(usageRecords.length > 0 ? "observed" : "not-observed", "one request record per canonical assistant message with nonzero tokens")
    })
  };
}
