import { getMessages, getParts, getSession, getTodos } from "../../db.js";
import { asNumber, parseJson } from "./parser.js";

type Row = Record<string, any>;

export interface ContextItem {
  kind: "session" | "todo" | "message" | "tool" | "patch" | "reasoning";
  id: string;
  title: string;
  preview: string;
  source: string;
  time: number;
}

export interface ContextStep {
  index: number;
  messageId: string;
  startPartId: string;
  finishPartId: string | null;
  snapshotId: string | null;
  previousSnapshotId: string | null;
  checkpoint: "session-start" | "snapshot-change" | "step";
  checkpointLabel: string;
  reason: string | null;
  timeStart: number;
  timeEnd: number;
  duration: number;
  tokens: Row | null;
  cost: number;
  confidence: "reconstructed";
  items: ContextItem[];
  itemCounts: Record<string, number>;
  diff: ContextDiff | null;
}

export interface SessionContextView {
  sessionId: string;
  mode: "reconstructed";
  note: string;
  steps: ContextStep[];
}

export interface ContextDiff {
  baseStepIndex: number | null;
  added: ContextItem[];
  removed: ContextItem[];
  retained: number;
  addedCounts: Record<string, number>;
  removedCounts: Record<string, number>;
}

function asObject(value: unknown): Row {
  return value && typeof value === "object" ? value as Row : {};
}

function compact(value: unknown, limit = 260) {
  if (value == null) {
    return "";
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function item(kind: ContextItem["kind"], id: string, title: string, preview: unknown, source: string, time = 0): ContextItem {
  return {
    kind,
    id,
    title,
    preview: compact(preview),
    source,
    time: asNumber(time)
  };
}

function partTime(data: Row, fallback = 0) {
  return asNumber(data.state?.time?.start)
    || asNumber(data.time?.start)
    || asNumber(data.time?.created)
    || fallback;
}

function buildPartContext(part: Row, messageData: Row): ContextItem | null {
  const data = asObject(typeof part.data === "string" ? parseJson(part.data) : part.data);
  const partType = String(data.type || "unknown");
  const time = partTime(data, asNumber(part.time_created));

  if (partType === "text" && data.text) {
    return item("message", part.id, `${messageData.role || "unknown"} message`, data.text, "part.text", time);
  }

  if (partType === "tool") {
    const input = data.state?.input;
    const output = data.state?.output;
    return item("tool", part.id, data.tool || "tool", { input, output }, "part.tool", time);
  }

  if (partType === "patch") {
    return item("patch", part.id, "patch", data, "part.patch", time);
  }

  if (partType === "reasoning" && data.text) {
    return item("reasoning", part.id, "reasoning", data.text, "part.reasoning", time);
  }

  return null;
}

function countItems(items: ContextItem[]) {
  return items.reduce((counts, contextItem) => {
    counts[contextItem.kind] = (counts[contextItem.kind] || 0) + 1;
    return counts;
  }, {} as Record<string, number>);
}

function contextItemKey(contextItem: ContextItem) {
  return `${contextItem.kind}:${contextItem.id}`;
}

function diffItems(current: ContextItem[], previous: ContextItem[] = [], baseStepIndex: number | null = null): ContextDiff {
  const previousKeys = new Set(previous.map(contextItemKey));
  const currentKeys = new Set(current.map(contextItemKey));
  const added = current.filter((contextItem) => !previousKeys.has(contextItemKey(contextItem)));
  const removed = previous.filter((contextItem) => !currentKeys.has(contextItemKey(contextItem)));

  return {
    baseStepIndex,
    added,
    removed,
    retained: current.length - added.length,
    addedCounts: countItems(added),
    removedCounts: countItems(removed)
  };
}

function classifyCheckpoint(index: number, snapshotId: string | null, previousSnapshotId: string | null) {
  if (index === 1) {
    return {
      checkpoint: "session-start" as const,
      checkpointLabel: "Session start"
    };
  }

  if (snapshotId && previousSnapshotId && snapshotId !== previousSnapshotId) {
    return {
      checkpoint: "snapshot-change" as const,
      checkpointLabel: "Snapshot change / compaction candidate"
    };
  }

  return {
    checkpoint: "step" as const,
    checkpointLabel: "Step"
  };
}

export function buildSessionContext(
  sessionId: string,
  dbPath: string | undefined = undefined,
  providerName = "session provider"
): SessionContextView {
  const session = getSession(sessionId, dbPath);
  const todos = getTodos(sessionId, dbPath);
  const history: ContextItem[] = [];
  const steps: ContextStep[] = [];

  if (session) {
    history.push(item("session", session.id, session.title || session.slug || session.id, {
      directory: session.directory,
      agent: session.agent,
      model: session.model
    }, "session", session.time_created));
  }

  for (const todo of todos) {
    history.push(item("todo", `${sessionId}:todo:${todo.position}`, todo.content || "todo", {
      status: todo.status,
      priority: todo.priority
    }, "todo", todo.time_created));
  }

  const openSteps = new Map<string, ContextStep>();
  let previousStepSnapshotId: string | null = null;
  let previousCheckpoint: ContextStep | null = null;
  const messages = getMessages(sessionId, dbPath);
  for (const message of messages) {
    const messageData = asObject(typeof message.data === "string" ? parseJson(message.data) : message.data);
    const parts = getParts(message.id, dbPath);

    for (const rawPart of parts) {
      const data = asObject(typeof rawPart.data === "string" ? parseJson(rawPart.data) : rawPart.data);
      const partType = String(data.type || "unknown");

      if (partType === "step-start") {
        const snapshotId = typeof data.snapshot === "string" ? data.snapshot : null;
        const checkpoint = classifyCheckpoint(steps.length + 1, snapshotId, previousStepSnapshotId);
        const step: ContextStep = {
          index: steps.length + 1,
          messageId: message.id,
          startPartId: rawPart.id,
          finishPartId: null,
          snapshotId,
          previousSnapshotId: previousStepSnapshotId,
          ...checkpoint,
          reason: null,
          timeStart: partTime(data, asNumber(rawPart.time_created)),
          timeEnd: 0,
          duration: 0,
          tokens: null,
          cost: 0,
          confidence: "reconstructed",
          items: history.slice(),
          itemCounts: countItems(history),
          diff: null
        };
        if (step.checkpoint !== "step") {
          step.diff = diffItems(step.items, previousCheckpoint?.items || [], previousCheckpoint?.index || null);
          previousCheckpoint = step;
        }
        steps.push(step);
        openSteps.set(message.id, step);
        continue;
      }

      if (partType === "step-finish") {
        const step = openSteps.get(message.id) || steps[steps.length - 1];
        if (step) {
          step.finishPartId = rawPart.id;
          step.reason = typeof data.reason === "string" ? data.reason : null;
          step.timeEnd = asNumber(data.time?.end) || partTime(data, asNumber(rawPart.time_updated));
          step.duration = step.timeStart && step.timeEnd ? Math.max(0, step.timeEnd - step.timeStart) : 0;
          step.tokens = asObject(data.tokens);
          step.cost = asNumber(data.cost);
          if (!step.snapshotId && typeof data.snapshot === "string") {
            step.snapshotId = data.snapshot;
          }
          previousStepSnapshotId = step.snapshotId || previousStepSnapshotId;
          openSteps.delete(message.id);
        }
        continue;
      }

      const contextItem = buildPartContext(rawPart, messageData);
      if (contextItem) {
        history.push(contextItem);
      }
    }
  }

  return {
    sessionId,
    mode: "reconstructed",
    note: `This view reconstructs available context from stored local session rows. Exact hidden model prompt assembly is not stored in the ${providerName} database.`,
    steps
  };
}
