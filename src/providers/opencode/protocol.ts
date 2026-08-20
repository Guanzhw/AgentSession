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
import type { SessionTree, SessionPartNode } from "./session-tree.js";

type Row = Record<string, any>;

export const openCodeProtocolCapabilities = {
  sessionEvents: capabilityDescriptor("partial", "derived", "Native messages and parts projected into protocol events"),
  sessionRelationships: capabilityDescriptor("full", "recorded", "Native session.parent_id relationships"),
  tasks: capabilityDescriptor("partial", "derived", "Subagent tool parts projected into task records"),
  agentRuns: capabilityDescriptor("partial", "derived", "Subagent tool parts and child sessions projected into runs"),
  contextArtifacts: capabilityDescriptor("none", "derived"),
  branches: capabilityDescriptor("none", "derived")
};

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function status(part: SessionPartNode, hasChild: boolean) {
  const raw = String(part.data.state?.status || "").toLowerCase();
  if (["error", "failed", "failure"].includes(raw)) return "failed" as const;
  if (["running", "pending", "started"].includes(raw)) return "running" as const;
  return hasChild || number(part.timeEnd) ? "completed" as const : "running" as const;
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
export function buildOpenCodeSessionProtocol(tree: SessionTree, revision: string | number): SessionProtocol {
  const session = rawSession(tree.session);
  const sessionId = session.id;
  const events: ReturnType<typeof sessionEvent>[] = [sessionEvent({
    id: `session.started:${sessionId}`, sessionId, timestamp: session.timeCreated || null,
    kind: "session.started", phase: "started", provenance: { fidelity: "recorded", sourceType: "opencode.session", sourceId: sessionId }
  })];
  const tasks: ReturnType<typeof sessionTask>[] = [];
  const runs: ReturnType<typeof agentRun>[] = [];
  const relationships: ReturnType<typeof sessionRelationship>[] = [];

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
      else if (data.type === "tool") {
        const raw = String(data.state?.status || "").toLowerCase();
        kind = ["error", "failed"].includes(raw) ? "tool.failed" : ["completed", "success"].includes(raw) ? "tool.completed" : "tool.called";
        phase = kind === "tool.failed" ? "failed" : kind === "tool.completed" ? "completed" : "started";
      }
      events.push(sessionEvent({
        id: `part:${part.id}`, sessionId, timestamp, kind, phase, turnId: message.id,
        provenance: { fidelity: "recorded", sourceType: `opencode.part.${String(data.type || "unknown")}`, sourceId: part.id },
        providerData: { type: data.type || null, tool: data.tool || null, status: data.state?.status || null }
      }));

      if (data.type !== "tool" || !isSubagentTool(data.tool, mergeToolMetadata(data.state?.metadata, data.metadata))) continue;
      const children = part.childSessions || [];
      const taskId = `task:${part.id}`;
      const runId = `run:${part.id}`;
      const taskStatus = status(part, children.length > 0);
      const child = children[0];
      const completed = taskStatus === "completed" || taskStatus === "failed";
      tasks.push(sessionTask({
        id: taskId, sessionId, kind: "subagent-task", status: taskStatus,
        title: data.tool || "subagent", toolCallId: part.id, correlationId: part.id,
        requestEventId: `part:${part.id}`, triggerEventId: `part:${part.id}`,
        timeCreated: partTimestamp(part), timeUpdated: partTimestamp(part), timeCompleted: completed ? number(part.timeEnd) : null,
        provenance: { fidelity: "derived", sourceType: "opencode.part", sourceId: part.id }, metadata: { tool: data.tool || null }
      }));
      runs.push(agentRun({
        id: runId, sessionId, taskId, status: taskStatus, mode: "subagent",
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
