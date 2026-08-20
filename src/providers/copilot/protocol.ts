import type { RawSession } from "../interface.js";
import {
  agentRun,
  capabilityDescriptor,
  finalizeSessionProtocol,
  protocolRevision,
  sessionEvent,
  sessionTask,
  type SessionProtocol
} from "../shared/session-protocol.js";

type Row = Record<string, any>;

export const copilotProtocolCapabilities = {
  sessionEvents: capabilityDescriptor("full", "recorded", "Copilot events.jsonl records"),
  sessionRelationships: capabilityDescriptor("none", "derived", "Inline agents are not independent sessions"),
  tasks: capabilityDescriptor("partial", "derived", "subagent.started records projected as inline tasks"),
  agentRuns: capabilityDescriptor("partial", "derived", "Inline agent executions have no resumable child session"),
  contextArtifacts: capabilityDescriptor("none", "derived"),
  branches: capabilityDescriptor("none", "derived")
};

function data(record: Row): Row {
  return record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data : {};
}
function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function timestamp(record: Row): number | null {
  const value = record.timestamp ?? record.time ?? data(record).timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}
function agentId(record: Row): string | null { return string(record.agentId) || string(data(record).agentId); }
function eventId(record: Row, index: number) { return string(record.id) || `record:${index}`; }

function eventKind(record: Row) {
  switch (record.type) {
    case "session.start": return { kind: "session.started", phase: "started" as const };
    case "user.message": return { kind: "message.user", phase: "updated" as const };
    case "assistant.message": return { kind: "message.assistant", phase: "updated" as const };
    case "tool.execution_start": return { kind: "tool.called", phase: "started" as const };
    case "tool.execution_complete": return {
      kind: data(record).success === false || data(record).isError === true ? "tool.failed" : "tool.completed",
      phase: data(record).success === false || data(record).isError === true ? "failed" as const : "completed" as const
    };
    case "subagent.started": return { kind: "run.started", phase: "started" as const };
    case "subagent.completed": return { kind: "run.completed", phase: "completed" as const };
    case "subagent.failed": return { kind: "run.failed", phase: "failed" as const };
    default: return { kind: `control.${String(record.type || "record")}`, phase: "updated" as const };
  }
}

/** Copilot inline agents remain task/run entities only; no child session is invented. */
export function buildCopilotSessionProtocol(session: RawSession, records: Row[], revision: string | number): SessionProtocol {
  const sessionId = String(session.id);
  const events: ReturnType<typeof sessionEvent>[] = [];
  const tasks: ReturnType<typeof sessionTask>[] = [];
  const runs: ReturnType<typeof agentRun>[] = [];
  const agents = new Map<string, { started: Row; last: Row; completed: boolean; failed: boolean }>();

  records.forEach((record, index) => {
    const id = eventId(record, index);
    const mapped = eventKind(record);
    const agent = agentId(record);
    events.push(sessionEvent({
      id: `copilot:${id}`, sessionId, timestamp: timestamp(record), kind: mapped.kind, phase: mapped.phase,
      turnId: string(data(record).turnId), correlationId: string(data(record).toolCallId),
      provenance: { fidelity: "recorded", sourceType: `copilot.${String(record.type || "record")}`, sourceId: id },
      providerData: { agentId: agent, toolCallId: string(data(record).toolCallId) }
    }));
    if (record.type === "subagent.started") {
      const idValue = agent || string(data(record).toolCallId);
      if (idValue) agents.set(idValue, { started: record, last: record, completed: false, failed: false });
    } else if (agent && agents.has(agent)) {
      const state = agents.get(agent)!;
      state.last = record;
      if (record.type === "subagent.completed") state.completed = true;
      if (record.type === "subagent.failed") state.failed = true;
    }
  });

  for (const [id, state] of agents) {
    const taskId = `task:${id}`;
    const runId = `run:${id}`;
    const taskStatus = state.failed ? "failed" : state.completed ? "completed" : "running";
    const start = timestamp(state.started);
    const end = state.completed || state.failed ? timestamp(state.last) : null;
    tasks.push(sessionTask({
      id: taskId, sessionId, kind: "inline-agent", status: taskStatus,
      title: string(data(state.started).agentDisplayName) || string(data(state.started).agentName) || id,
      toolCallId: string(data(state.started).toolCallId), correlationId: id,
      requestEventId: `copilot:${eventId(state.started, 0)}`, triggerEventId: `copilot:${eventId(state.started, 0)}`,
      timeCreated: start, timeUpdated: timestamp(state.last), timeCompleted: end,
      provenance: { fidelity: "derived", sourceType: "copilot.subagent.started", sourceId: id }
    }));
    runs.push(agentRun({
      id: runId, sessionId, taskId, status: taskStatus, mode: "subagent",
      agent: string(data(state.started).agentDisplayName) || string(data(state.started).agentName) || id,
      model: string(data(state.started).model), childSessionId: null,
      triggerEventId: `copilot:${eventId(state.started, 0)}`,
      timeStart: start, timeEnd: end,
      provenance: { fidelity: "derived", sourceType: "copilot.subagent.started", sourceId: id },
      metadata: { inline: true }
    }));
  }
  return finalizeSessionProtocol({ sessionId, events, relationships: [], tasks, agentRuns: runs, contextArtifacts: [] }, {
    provider: "copilot", session, capabilities: copilotProtocolCapabilities, revision: protocolRevision(revision)
  });
}
