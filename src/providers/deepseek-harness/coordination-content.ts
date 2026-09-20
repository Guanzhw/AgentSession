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

/** Resolve the exact parent-owned mailbox enqueue; delivery rows carry no body. */
export function dshTeamCoordinationContent(
  records: DshRecord[],
  observation: CoordinationObservation
): ReaderCoordinationContent | null {
  if (observation.kind !== "message"
    || observation.provenance.sourceType !== "dsh.session-event:team/message/queued"
    || !observation.correlationId) return null;
  const event = dshOwnedEvents(records).find((candidate) => {
    if (candidate.type !== "team/message/queued") return false;
    const data = record(candidate.data);
    const message = record(data?.message);
    const sourceId = String(candidate.seq);
    return message?.id === observation.correlationId
      && sourceId === observation.provenance.sourceId
      && (!observation.eventId || observation.eventId === `event:dsh:${sourceId}`);
  });
  const message = record(record(event?.data)?.message);
  if (!Array.isArray(message?.content)) return null;
  const text = message.content.map(markdownBlock).filter((value): value is string => value !== null).join("\n\n");
  return text.trim() ? { text, format: "markdown" } : null;
}
