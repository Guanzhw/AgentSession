import type { RawSession } from "../interface.js";
import {
  capabilityDescriptor,
  finalizeSessionProtocol,
  protocolRevision,
  sessionEvent,
  type SessionProtocol
} from "../shared/session-protocol.js";

type Row = Record<string, any>;

export const geminiProtocolCapabilities = {
  sessionEvents: capabilityDescriptor("partial", "derived", "Gemini JSON session records projected into events"),
  sessionRelationships: capabilityDescriptor("none", "derived"),
  tasks: capabilityDescriptor("none", "derived"),
  agentRuns: capabilityDescriptor("none", "derived"),
  contextArtifacts: capabilityDescriptor("none", "derived"),
  branches: capabilityDescriptor("none", "derived")
};

function time(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}
function messageId(message: Row, index: number, sessionId: string) { return typeof message.id === "string" && message.id ? message.id : `${sessionId}:message:${index}`; }

/** Gemini has no native relationship/task/run protocol; only derived events are exposed. */
export function buildGeminiSessionProtocol(session: RawSession, data: Row, revision: string | number): SessionProtocol {
  const sessionId = String(session.id);
  const events: ReturnType<typeof sessionEvent>[] = [sessionEvent({
    id: `session.started:${sessionId}`, sessionId, timestamp: session.timeCreated || null,
    kind: "session.started", phase: "started",
    provenance: { fidelity: "derived", sourceType: "gemini.session", sourceId: sessionId }
  })];
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  messages.forEach((message: Row, index: number) => {
    const id = messageId(message, index, sessionId);
    let kind = "control.record";
    if (message.type === "user") kind = "message.user";
    else if (message.type === "gemini") kind = "model.response";
    else if (message.type === "error") kind = "control.error";
    else if (message.type === "warning") kind = "control.warning";
    else if (message.type === "info") kind = "control.info";
    events.push(sessionEvent({
      id: `message:${id}`, sessionId, timestamp: time(message.timestamp), kind, phase: "updated",
      turnId: id,
      provenance: { fidelity: "derived", sourceType: `gemini.message.${String(message.type || "record")}`, sourceId: id },
      providerData: { type: message.type || null, projectHash: data.projectHash || null }
    }));
    if (message.type !== "gemini" || !Array.isArray(message.toolCalls)) return;
    for (const [toolIndex, call] of message.toolCalls.entries()) {
      const callId = typeof call?.id === "string" && call.id ? call.id : `${id}:tool:${toolIndex}`;
      const failed = call?.status === "error" || call?.isError === true;
      events.push(sessionEvent({
        id: `tool:${callId}`, sessionId, timestamp: time(message.timestamp),
        kind: failed ? "tool.failed" : "tool.completed", phase: failed ? "failed" : "completed",
        turnId: id, correlationId: callId,
        provenance: { fidelity: "derived", sourceType: "gemini.message.toolCall", sourceId: callId },
        providerData: { name: call?.name || "unknown", status: call?.status || null }
      }));
    }
  });
  return finalizeSessionProtocol({ sessionId, events, relationships: [], tasks: [], agentRuns: [], contextArtifacts: [] }, {
    provider: "gemini", session, capabilities: geminiProtocolCapabilities, revision: protocolRevision(revision)
  });
}
