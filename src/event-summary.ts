import type { SessionEventEnvelope } from "./providers/shared/session-protocol.js";

const COMPACTION_SUMMARY_LIMIT = 180;

function boundedText(value: unknown, limit: number) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const characters = Array.from(text);
  return characters.length <= limit ? text : `${characters.slice(0, Math.max(1, limit - 1)).join("").trimEnd()}…`;
}

/** Provider-neutral, ID-free facts used by both SSR and browser summaries. */
export function summarizeEvent(event: Pick<SessionEventEnvelope, "phase" | "taskId" | "runId" | "turnId" | "compaction">) {
  return {
    phase: event.phase || null,
    compactionSummary: boundedText(event.compaction?.summary, COMPACTION_SUMMARY_LIMIT),
    hasTask: Boolean(event.taskId),
    hasRun: Boolean(event.runId),
    hasTurn: Boolean(event.turnId)
  };
}
