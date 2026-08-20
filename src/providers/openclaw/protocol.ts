import type { RawSession } from "../interface.js";
import {
  capabilityDescriptor,
  finalizeSessionProtocol,
  protocolRevision,
  sessionEvent,
  sessionRelationship,
  type SessionBranch,
  type SessionProtocol
} from "../shared/session-protocol.js";
import { activeOpenClawRecords, type OpenClawRecord } from "./parser.js";

type Child = { session: RawSession; records: OpenClawRecord[] };

export const openClawProtocolCapabilities = {
  sessionEvents: capabilityDescriptor("full", "recorded", "Active path is read from the provider JSONL"),
  sessionRelationships: capabilityDescriptor("full", "recorded", "Registry spawnedBy and in-file parentId"),
  tasks: capabilityDescriptor("partial", "derived", "Delegation records are projected when present"),
  agentRuns: capabilityDescriptor("partial", "derived", "Registry/in-file delegation is projected when present"),
  contextArtifacts: capabilityDescriptor("none", "derived"),
  branches: capabilityDescriptor("full", "recorded", "In-file parentId branch topology")
};

function eventTime(record: OpenClawRecord): number | null {
  const value = record.message?.timestamp ?? record.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function branchProjection(records: OpenClawRecord[], active: OpenClawRecord[]): SessionBranch[] {
  const events = records.filter((record) => record.type !== "session" && typeof record.id === "string");
  if (!events.length) return [];
  const ids = new Set(events.map((record) => String(record.id)));
  const parents = new Set(events.map((record) => record.parentId).filter((id): id is string => typeof id === "string"));
  const leaves = events.filter((record) => !parents.has(String(record.id)));
  const activeLast = active.at(-1);
  const activeHead = activeLast?.id ? String(activeLast.id) : null;
  return leaves.map((head) => ({
    id: `branch:${String(head.id)}`,
    parentBranchId: null,
    forkEventId: typeof head.parentId === "string" && ids.has(head.parentId) ? head.parentId : null,
    headEventId: String(head.id),
    selected: String(head.id) === activeHead,
    provenance: { fidelity: "recorded", sourceType: "openclaw.record.parentId", sourceId: String(head.id) }
  }));
}

function eventKind(record: OpenClawRecord) {
  const message = record.message || {};
  if (record.type === "message") {
    if (message.role === "user") return "message.user";
    if (message.role === "assistant") return "message.assistant";
    if (message.role === "toolResult") return message.isError ? "tool.failed" : "tool.completed";
  }
  if (record.type === "toolCall" || record.type === "tool_call") return "tool.called";
  return `control.${String(record.type || "record")}`;
}

/** Protocol projection that keeps OpenClaw's selected active path separate from all branches. */
export function buildOpenClawSessionProtocol(
  session: RawSession,
  records: OpenClawRecord[],
  children: Child[],
  revision: string | number
): SessionProtocol {
  const sessionId = String(session.id);
  const active = activeOpenClawRecords(records);
  const events: ReturnType<typeof sessionEvent>[] = [sessionEvent({
    id: `session.started:${sessionId}`, sessionId, timestamp: session.timeCreated || null,
    kind: "session.started", phase: "started",
    provenance: { fidelity: "recorded", sourceType: "openclaw.session", sourceId: sessionId }
  })];
  for (const record of active) {
    const id = String(record.id);
    const message = record.message || {};
    events.push(sessionEvent({
      id: `record:${id}`, sessionId, timestamp: eventTime(record), kind: eventKind(record),
      phase: eventKind(record).endsWith("called") ? "started" : eventKind(record).endsWith("failed") ? "failed" : "updated",
      turnId: message.role ? id : null,
      provenance: { fidelity: "recorded", sourceType: `openclaw.${String(record.type || "record")}`, sourceId: id },
      providerData: { parentId: record.parentId || null, role: message.role || null }
    }));
  }
  const relationships: ReturnType<typeof sessionRelationship>[] = [];
  for (const child of children) {
    const childId = String(child.session.id);
    if (!child.session.parentId || String(child.session.parentId) !== sessionId) continue;
    relationships.push(sessionRelationship({
      type: "spawned", fromSessionId: sessionId, toSessionId: childId,
      timestamp: child.session.timeCreated || null,
      provenance: { fidelity: "recorded", sourceType: "openclaw.registry.spawnedBy", sourceId: childId }
    }));
  }
  if (session.parentId) {
    relationships.push(sessionRelationship({
      type: "parent", fromSessionId: sessionId, toSessionId: String(session.parentId),
      timestamp: session.timeCreated || null,
      provenance: { fidelity: "recorded", sourceType: "openclaw.registry.spawnedBy", sourceId: sessionId }
    }));
  }
  return finalizeSessionProtocol({
    sessionId, events, relationships, tasks: [], agentRuns: [], contextArtifacts: [],
    branches: branchProjection(records, active)
  }, { provider: "openclaw", session, capabilities: openClawProtocolCapabilities, revision: protocolRevision(revision) });
}
