import { createHash } from "node:crypto";
import type { ToolExecutionObservation } from "./providers/shared/session-protocol.js";
import type { SessionProtocolV3 } from "./providers/shared/session-protocol-v3.js";
import { createReaderNativeSourceResolver, type ReaderRelationPosition } from "./reader-relations.js";

export interface ReaderExecutionStep {
  eventId: string;
  sequence: number;
  timestamp: number | null;
  observation: ToolExecutionObservation;
  position: ReaderRelationPosition | null;
}

export interface ReaderExecution {
  id: string;
  kind: ToolExecutionObservation["kind"];
  name: string;
  steps: ReaderExecutionStep[];
}

export interface ReaderExecutions {
  provider: string;
  sessionId: string;
  items: ReaderExecution[];
  prose: Array<{ eventId: string; timestamp: number; text: string }>;
}

export const executionReturned = (phase: ToolExecutionObservation["phase"]) => (
  phase === "completed" || phase === "failed"
);

/** The provider has already established lifecycle meaning and occurrence identity. */
export function deriveReaderExecutions(protocol: SessionProtocolV3, document: {
  messages: any[]; partsByMessage: Map<string, any[]>;
}, sharedResolver?: ReturnType<typeof createReaderNativeSourceResolver>): ReaderExecutions {
  if (!protocol.events.some((event) => event.execution)) return { ...protocol.session!.ref, items: [], prose: [] };
  const resolve = sharedResolver || createReaderNativeSourceResolver(document);
  const groups = new Map<string, ReaderExecution>();
  const prose: ReaderExecutions["prose"] = [];
  const proseParts = new Set<string>();
  for (const event of protocol.events) {
    if (event.execution) {
      const observation = event.execution;
      let group = groups.get(observation.id);
      if (!group) {
        group = { id: observation.id, kind: observation.kind, name: observation.toolName, steps: [] };
        groups.set(group.id, group);
      }
      const native = resolve(event);
      group.steps.push({ eventId: event.id, sequence: event.sequence, timestamp: event.timestamp, observation,
        position: native ? { ...native.position,
          side: observation.phase === "yielded" || executionReturned(observation.phase) ? "after" : "before" } : null });
    } else if (event.category === "message" && event.timestamp !== null) {
      const native = resolve(event);
      if (native?.text && native.position.partId && !proseParts.has(native.position.partId)) {
        proseParts.add(native.position.partId);
        prose.push({ eventId: event.id, timestamp: event.timestamp,
          text: native.text.slice(0, 360).replace(/\s+/g, " ").slice(0, 180) });
      }
    }
  }
  return { ...protocol.session!.ref, items: [...groups.values()], prose };
}

export class ReaderExecutionError extends Error {
  constructor(public code: "invalid_input" | "stale_page" | "execution_not_found", message: string) { super(message); }
}

const STEP_PAGE_SIZE = 50;
const prefix = (steps: ReaderExecutionStep[], count: number) => createHash("sha256")
  .update(JSON.stringify(steps.slice(0, count).map(({ eventId, timestamp, observation }) => [eventId, timestamp, observation])))
  .digest("hex");

export interface ReaderExecutionPage {
  view: ReaderExecutions;
  execution: ReaderExecution;
  steps: ReaderExecutionStep[];
  offset: number;
  nextCursor: string | null;
}

/** Cursor validation is the HTTP boundary; source suffix growth remains readable. */
export function readerExecutionPage(view: ReaderExecutions, id: string, cursor: string | null): ReaderExecutionPage {
  const execution = view.items.find((item) => item.id === id);
  if (!execution) throw new ReaderExecutionError(cursor ? "stale_page" : "execution_not_found", "Execution was not found.");
  let offset = 0;
  if (cursor) {
    let decoded: { id: string; offset: number; prefix: string };
    try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); }
    catch { throw new ReaderExecutionError("invalid_input", "Invalid execution cursor."); }
    if (!decoded || decoded.id !== id || !Number.isSafeInteger(decoded.offset) || decoded.offset <= 0 || typeof decoded.prefix !== "string") {
      throw new ReaderExecutionError("invalid_input", "Invalid execution cursor.");
    }
    offset = decoded.offset;
    if (offset > execution.steps.length || prefix(execution.steps, offset) !== decoded.prefix) {
      throw new ReaderExecutionError("stale_page", "Earlier execution steps have changed. Reopen this execution.");
    }
  }
  const steps = execution.steps.slice(offset, offset + STEP_PAGE_SIZE);
  const next = offset + steps.length;
  const nextCursor = next < execution.steps.length
    ? Buffer.from(JSON.stringify({ id, offset: next, prefix: prefix(execution.steps, next) })).toString("base64url") : null;
  return { view, execution, steps, offset, nextCursor };
}

export function executionTimeRange(execution: ReaderExecution): { start: number; end: number } | null {
  const first = execution.steps[0]?.timestamp;
  const split = execution.steps.find((step) => step.observation.phase === "yielded")?.timestamp;
  const last = execution.steps[execution.steps.length - 1]?.timestamp;
  return first != null && split != null && last != null && last > first && split >= first && split <= last
    ? { start: first, end: last } : null;
}
