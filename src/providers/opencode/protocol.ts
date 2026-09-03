import { createHash } from "node:crypto";
import type { RawSession } from "../interface.js";
import {
  agentRun,
  capabilityDescriptor,
  finalizeSessionProtocol,
  protocolRevision,
  sessionEvent,
  sessionRelationship,
  sessionTask,
  type SessionProtocol
} from "../shared/session-protocol.js";
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
  if (["error", "failed", "failure"].includes(raw)) return "failed" as const;
  if (["running", "pending", "started"].includes(raw)) return "running" as const;
  const taskState = taskOutputState(part);
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
  const stableFields = [
    sessionId,
    todo.content,
    todo.priority,
    number(todo.time_created) ?? ""
  ].join("\u0000");
  return `todo:${createHash("sha256").update(stableFields).digest("hex").slice(0, 16)}`;
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
  const messageIds = new Set(tree.messages.map((message) => message.id));
  const todoIdentityCounts = new Map<string, number>();

  for (const todo of tree.todos || []) {
    const position = number(todo.position);
    if (position === null || typeof todo.content !== "string") continue;
    const taskStatus = todoStatus(todo.status);
    if (!taskStatus) continue;
    const baseId = todoIdentity(sessionId, todo);
    const occurrence = todoIdentityCounts.get(baseId) || 0;
    todoIdentityCounts.set(baseId, occurrence + 1);
    // OpenCode's current todo primary key is session + position, so use the
    // stable source-order position only as a collision tiebreaker for rows
    // whose available fingerprint fields are identical.
    const taskId = occurrence === 0 ? baseId : `${baseId}:${position}:${occurrence}`;
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
      const partEvent = sessionEvent({
        id: `part:${part.id}`, sessionId, timestamp, kind, phase, turnId: message.id,
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
        title: typeof toolMetadata.title === "string" ? toolMetadata.title : data.tool || "subagent", toolCallId: part.id, correlationId: part.id,
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
        relationships.push(sessionRelationship({
          type: "spawned", fromSessionId: sessionId, toSessionId: String(childTree.session.id),
          correlationId: part.id, triggerEventId: `part:${part.id}`, taskId, runId,
          timestamp: partTimestamp(part),
          provenance: { fidelity: "recorded", sourceType: "opencode.session.parent_id", sourceId: String(childTree.session.id) }
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
  return finalizeSessionProtocol({ sessionId, events, relationships, tasks, agentRuns: runs, contextArtifacts: [] }, {
    provider: "opencode", session, capabilities: openCodeProtocolCapabilities, revision: protocolRevision(revision)
  });
}
