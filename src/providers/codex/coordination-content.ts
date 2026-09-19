import type { ReaderCoordinationContent } from "../interface.js";
import type { CoordinationObservation } from "../shared/session-protocol-v3.js";
import { codexTurnEventId, codexTurnLifecycle } from "./protocol.js";

type Row = Record<string, any>;

function recordedString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function readableContent(value: unknown): ReaderCoordinationContent | null {
  return typeof value === "string" && value.trim()
    ? { text: value, format: "markdown" } : null;
}

function encryptedCollaborationMessage(value: unknown): boolean {
  if (typeof value !== "string" || !/^gAAAA[A-Za-z0-9_-]+={0,2}$/.test(value)) return false;
  // Real call messages also occur verbatim in child encrypted_content fields.
  // Their token envelope has 57 header/IV/MAC bytes and complete 16-byte blocks.
  const bytes = Buffer.from(value, "base64url");
  return bytes.length >= 73 && (bytes.length - 57) % 16 === 0;
}

function finalAnswerBody(payload: Row): string | null {
  const content = payload.content ?? payload.message;
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts = content.flatMap((part: Row) => part?.content || [part]);
    if (parts.some((part: Row) => part?.type === "encrypted_content")) return null;
    text = parts.filter((part: Row) => ["text", "output_text", "input_text", "summary_text"].includes(part?.type))
      .map((part: Row) => typeof part.text === "string" ? part.text : "").join("");
  } else {
    return null;
  }
  const payloadMarker = /^Message Type:[ \t]*FINAL_ANSWER[ \t]*\r?\n(?:Task name:[^\r\n]*\r?\n)?(?:Sender:[^\r\n]*\r?\n)?Payload:[ \t]*\r?\n/.exec(text);
  return payloadMarker ? text.slice(payloadMarker[0].length)
    : text.replace(/^Message Type:[ \t]*FINAL_ANSWER[ \t]*\r?\n/, "");
}

/** Records use the same ownership-filtered order as the observation's protocol input. */
export function codexCoordinationContentFromRecords(
  records: Row[],
  observation: CoordinationObservation
): ReaderCoordinationContent | null {
  const sourceType = observation.provenance.sourceType;
  for (const [index, record] of records.entries()) {
    const payload = record.payload;
    if (sourceType === "codex.child.event_msg:task_complete") {
      const lifecycle = codexTurnLifecycle(record, index);
      if (lifecycle?.type === "task_complete"
        && codexTurnEventId(lifecycle) === observation.sourceEventRef?.eventId
        && lifecycle.turnId === observation.turnId) {
        return readableContent(payload.last_agent_message);
      }
    } else if (sourceType === "codex.inter_agent_communication") {
      if (record.type === "inter_agent_communication"
        && (recordedString(payload?.id) ?? String(index)) === observation.provenance.sourceId) {
        return readableContent(payload.message ?? payload.content);
      }
    } else if (sourceType === "codex.response_item:agent_message:FINAL_ANSWER") {
      if (record.type === "response_item" && payload?.type === "agent_message"
        && `event:result:${recordedString(payload.id) ?? `envelope-${index}`}` === observation.eventId) {
        return readableContent(finalAnswerBody(payload));
      }
    } else if (record.type === "response_item"
      && ["function_call", "custom_tool_call"].includes(payload?.type)
      && ["spawn_agent", "followup_task", "send_message", "send_input"].includes(payload?.name)
      && `codex.response_item:${payload.type}:${payload.namespace}` === sourceType
      && (recordedString(payload.call_id) ?? recordedString(payload.id) ?? `collab-${index}`) === observation.correlationId) {
      let args = payload.arguments ?? payload.input;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { return null; }
      }
      if (encryptedCollaborationMessage(args?.message)) return null;
      return readableContent(args?.message);
    }
  }
  return null;
}
