import type { ReaderCoordinationContent } from "../interface.js";
import type { CoordinationObservation } from "../shared/session-protocol-v3.js";
import { dshOwnedEvents, type DshRecord } from "./parser.js";

function record(value: unknown): DshRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as DshRecord : null;
}

function markdownBlock(value: unknown): string | null {
  const block = record(value);
  if (!block) return JSON.stringify(value, null, 2) ?? null;
  if (block.type === "text" && typeof block.text === "string") return block.text;
  const json = JSON.stringify(block, null, 2);
  return json ? `\`\`\`json\n${json}\n\`\`\`` : null;
}

function queuedMessageEvent(records: DshRecord[], correlationId: string, sourceId?: string): DshRecord | null {
  const matches = dshOwnedEvents(records).filter((candidate) => {
    if (candidate.type !== "team/message/queued") return false;
    const message = record(record(candidate.data)?.message);
    return message?.id === correlationId && (sourceId === undefined || String(candidate.seq) === sourceId);
  });
  return matches.length === 1 ? matches[0] : null;
}

function deliveryMatches(records: DshRecord[], observation: CoordinationObservation): boolean {
  const sourceId = observation.provenance.sourceId;
  if (!sourceId || (observation.eventId && observation.eventId !== `event:dsh:${sourceId}`)) return false;
  return dshOwnedEvents(records).some((candidate) => (
    candidate.type === "team/message/delivered"
    && String(candidate.seq) === sourceId
    && record(candidate.data)?.messageId === observation.correlationId
  ));
}

/** Resolve an exact owned enqueue; a delivery may read that same recorded message body. */
export function dshTeamCoordinationContent(
  records: DshRecord[],
  observation: CoordinationObservation
): ReaderCoordinationContent | null {
  if (!observation.correlationId) return null;
  const queued = observation.kind === "message"
    && observation.provenance.sourceType === "dsh.session-event:team/message/queued"
    && observation.provenance.sourceId
    ? queuedMessageEvent(records, observation.correlationId, observation.provenance.sourceId)
    : observation.kind === "mailbox-delivery"
      && observation.provenance.sourceType === "dsh.session-event:team/message/delivered"
      && deliveryMatches(records, observation)
      ? queuedMessageEvent(records, observation.correlationId)
      : null;
  const event = queued && (observation.kind !== "message" || !observation.eventId || observation.eventId === `event:dsh:${queued.seq}`)
    ? queued : null;
  const message = record(record(event?.data)?.message);
  if (!Array.isArray(message?.content)) return null;
  const text = message.content.map(markdownBlock).filter((value): value is string => value !== null).join("\n\n");
  return text.trim() ? { text, format: "markdown" } : null;
}
