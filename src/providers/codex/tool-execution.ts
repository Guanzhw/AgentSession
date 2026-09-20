import {
  sessionEvent,
  type SessionEventEnvelope,
  type ToolExecutionObservation
} from "../shared/session-protocol.js";

type Row = Record<string, any>;

interface CodexToolCall {
  callId: string;
  name: "exec" | "wait";
  recordIndex: number;
  timestamp: number | null;
  handle: string | null;
  interruptionRequested: boolean;
}

interface ActiveExecution {
  id: string;
  handle: string;
  lastEventId: string;
}

export interface CodexToolExecutionEvent {
  recordIndex: number;
  event: SessionEventEnvelope;
}

const RUNNING_HEADER = /^Script running with cell ID ([^\r\n]+)\r?\nWall time \d+(?:\.\d+)? seconds\r?\nOutput:\r?\n/;
const COMPLETED_HEADER = /^Script completed\r?\nWall time \d+(?:\.\d+)? seconds\r?\nOutput:\r?\n/;
const FAILED_HEADER = /^Script failed\r?\nWall time \d+(?:\.\d+)? seconds\r?\nOutput:\r?\n/;

function timestamp(record: Row): number | null {
  if (!record.timestamp) return null;
  const value = new Date(String(record.timestamp)).getTime();
  return Number.isFinite(value) ? value : null;
}

function callId(record: Row): string | null {
  const value = record.payload?.call_id ?? record.payload?.id;
  return typeof value === "string" && value ? value : null;
}

function nullNamespace(record: Row): boolean {
  return record.payload?.namespace === undefined || record.payload?.namespace === null || record.payload?.namespace === "";
}

function parseArguments(record: Row): Row | null {
  const value = record.payload?.arguments;
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function textBlock(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const block = item as Row;
  return ["input_text", "output_text", "text"].includes(String(block.type || ""))
    && typeof block.text === "string"
    ? block.text
    : null;
}

function firstStringifiedArrayBlock(value: string): string | null {
  let index = 0;
  while (/\s/.test(value[index] || "")) index += 1;
  if (value[index] !== "[") return null;
  index += 1;
  while (/\s/.test(value[index] || "")) index += 1;
  if (value[index] !== "{") return null;
  const start = index;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      try {
        return textBlock(JSON.parse(value.slice(start, index + 1)));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function firstHeader(record: Row): string | null {
  const value = record.payload?.output;
  if (Array.isArray(value)) return textBlock(value[0]);
  if (typeof value !== "string") return null;
  return firstStringifiedArrayBlock(value) ?? value;
}

function runningHandle(header: string | null): string | null {
  const value = header?.match(RUNNING_HEADER)?.[1]?.trim();
  return value || null;
}

function eventPhase(phase: ToolExecutionObservation["phase"]): SessionEventEnvelope["phase"] {
  if (phase === "started") return "started";
  if (phase === "completed") return "completed";
  if (phase === "failed") return "failed";
  return "updated";
}

function executionEvent(fields: {
  sessionId: string;
  recordIndex: number;
  sourceType: string;
  sourceId: string;
  toolCallId: string;
  executionId: string;
  executionPhase: ToolExecutionObservation["phase"];
  kind: ToolExecutionObservation["kind"];
  handle: string;
  toolName: string;
  label?: string;
  parentEventId: string | null;
}): CodexToolExecutionEvent {
  const id = `event:tool-execution:${fields.executionId}:${fields.executionPhase}:${fields.toolCallId}`;
  return {
    recordIndex: fields.recordIndex,
    event: sessionEvent({
      id,
      sessionId: fields.sessionId,
      sequence: 0,
      timestamp: null,
      kind: `tool.execution.${fields.executionPhase}`,
      phase: eventPhase(fields.executionPhase),
      parentEventId: fields.parentEventId,
      correlationId: fields.executionId,
      messageId: fields.toolCallId,
      toolCallId: fields.toolCallId,
      provenance: {
        fidelity: "recorded",
        sourceType: fields.sourceType,
        sourceId: fields.sourceId
      },
      execution: {
        id: fields.executionId,
        kind: fields.kind,
        phase: fields.executionPhase,
        handle: fields.handle,
        toolName: fields.toolName,
        ...(fields.label ? { label: fields.label } : {})
      }
    })
  };
}

/**
 * Recover Codex's recorded outer async-tool and direct terminal lifecycles. The wrapper's
 * JavaScript input is intentionally opaque: nested exec_command results are
 * not assigned to inner calls by array position or source inspection.
 */
export function codexToolExecutionEvents(records: Row[], sessionId: string): CodexToolExecutionEvent[] {
  const calls = new Map<string, CodexToolCall>();
  const activeByHandle = new Map<string, ActiveExecution>();
  const waitExecutionByCallId = new Map<string, ActiveExecution>();
  const events: CodexToolExecutionEvent[] = [];

  const push = (event: CodexToolExecutionEvent, record: Row) => {
    event.event.timestamp = timestamp(record);
    events.push(event);
    return event.event.id;
  };

  for (const [recordIndex, record] of records.entries()) {
    const payloadType = String(record.payload?.type || "");
    if (record.type === "response_item" && ["function_call", "custom_tool_call"].includes(payloadType)) {
      const id = callId(record);
      const name = String(record.payload?.name || "");
      if (!id || !nullNamespace(record)) continue;
      if (payloadType === "custom_tool_call" && name === "exec") {
        calls.set(id, { callId: id, name: "exec", recordIndex, timestamp: timestamp(record), handle: null, interruptionRequested: false });
      } else if (payloadType === "function_call" && name === "wait") {
        const args = parseArguments(record);
        const rawHandle = args?.cell_id;
        const handle = (typeof rawHandle === "string" || typeof rawHandle === "number") ? String(rawHandle).trim() : "";
        if (!handle) continue;
        const call: CodexToolCall = {
          callId: id,
          name: "wait",
          recordIndex,
          timestamp: timestamp(record),
          handle,
          interruptionRequested: args?.terminate === true
        };
        calls.set(id, call);
        const execution = activeByHandle.get(handle);
        if (!execution) continue;
        waitExecutionByCallId.set(id, execution);
        const phase = call.interruptionRequested ? "interruption-requested" : "polled";
        const event = executionEvent({
          kind: "async-tool",
          sessionId,
          recordIndex,
          sourceType: "codex.response_item:function_call:wait",
          sourceId: id,
          toolCallId: id,
          executionId: execution.id,
          executionPhase: phase,
          handle,
          toolName: "wait",
          parentEventId: execution.lastEventId
        });
        execution.lastEventId = push(event, record);
      }
      continue;
    }

    if (record.type !== "response_item" || !["function_call_output", "custom_tool_call_output"].includes(payloadType)) continue;
    const id = callId(record);
    if (!id) continue;
    const call = calls.get(id);
    if (!call) continue;
    const header = firstHeader(record);

    if (call.name === "exec" && payloadType === "custom_tool_call_output") {
      const handle = runningHandle(header);
      if (!handle || activeByHandle.has(handle)) continue;
      const execution: ActiveExecution = { id, handle, lastEventId: "" };
      const started = executionEvent({
        kind: "async-tool",
        sessionId,
        recordIndex: call.recordIndex,
        sourceType: "codex.response_item:custom_tool_call:exec",
        sourceId: id,
        toolCallId: id,
        executionId: id,
        executionPhase: "started",
        handle,
        toolName: "exec",
        parentEventId: null
      });
      started.event.timestamp = call.timestamp;
      events.push(started);
      execution.lastEventId = started.event.id;
      const yielded = executionEvent({
        kind: "async-tool",
        sessionId,
        recordIndex,
        sourceType: "codex.response_item:custom_tool_call_output:exec",
        sourceId: id,
        toolCallId: id,
        executionId: id,
        executionPhase: "yielded",
        handle,
        toolName: "exec",
        parentEventId: execution.lastEventId
      });
      execution.lastEventId = push(yielded, record);
      activeByHandle.set(handle, execution);
      continue;
    }

    if (call.name !== "wait" || payloadType !== "function_call_output") continue;
    const execution = waitExecutionByCallId.get(id);
    if (!execution || activeByHandle.get(execution.handle) !== execution) continue;
    let phase: ToolExecutionObservation["phase"] | null = null;
    const returnedHandle = runningHandle(header);
    if (returnedHandle === execution.handle) phase = "yielded";
    else if (header && COMPLETED_HEADER.test(header)) phase = "completed";
    else if (header && FAILED_HEADER.test(header)) phase = "failed";
    if (!phase) continue;
    const result = executionEvent({
      kind: "async-tool",
      sessionId,
      recordIndex,
      sourceType: "codex.response_item:function_call_output:wait",
      sourceId: id,
      toolCallId: id,
      executionId: execution.id,
      executionPhase: phase,
      handle: execution.handle,
      toolName: "wait",
      parentEventId: execution.lastEventId
    });
    execution.lastEventId = push(result, record);
    if (phase === "completed" || phase === "failed") activeByHandle.delete(execution.handle);
  }

  return [...events, ...codexProcessExecutionEvents(records, sessionId)];
}

const PROCESS_RUNNING = /^Chunk ID: [^\r\n]+\r?\nWall time: \d+(?:\.\d+)? seconds\r?\nProcess running with session ID (\d+)\r?\n/;
const PROCESS_EXITED = /^Chunk ID: [^\r\n]+\r?\nWall time: \d+(?:\.\d+)? seconds\r?\nProcess exited with code (-?\d+)\r?\n/;

/** Direct terminal calls carry their own identity; nested JavaScript stays opaque. */
function codexProcessExecutionEvents(records: Row[], sessionId: string): CodexToolExecutionEvent[] {
  const starts = new Map<string, { index: number; record: Row; label?: string }>();
  const active = new Map<string, ActiveExecution>();
  const continuations = new Map<string, ActiveExecution>();
  const events: CodexToolExecutionEvent[] = [];
  const append = (execution: ActiveExecution, record: Row, index: number, phase: ToolExecutionObservation["phase"], name: string, label?: string) => {
    const id = callId(record)!;
    const event = executionEvent({ sessionId, recordIndex: index, sourceType: `codex.response_item:${record.payload.type}:${name}`,
      sourceId: id, toolCallId: id, executionId: execution.id, executionPhase: phase, kind: "process",
      handle: execution.handle, toolName: name, label, parentEventId: execution.lastEventId || null });
    event.event.timestamp = timestamp(record);
    events.push(event);
    execution.lastEventId = event.event.id;
  };
  for (const [index, record] of records.entries()) {
    if (record.type !== "response_item") continue;
    const payload = record.payload;
    const id = callId(record);
    if (!id) continue;
    if (payload.type === "function_call" && nullNamespace(record)) {
      if (payload.name !== "exec_command" && payload.name !== "write_stdin") continue;
      const args = parseArguments(record);
      if (!args) continue;
      if (payload.name === "exec_command") {
        const label = typeof args.cmd === "string" ? args.cmd.replace(/\s+/g, " ").trim().slice(0, 120) : "";
        starts.set(id, { index, record, ...(label ? { label } : {}) });
      } else {
        const handle = typeof args.session_id === "number" || typeof args.session_id === "string" ? String(args.session_id) : "";
        const execution = active.get(handle);
        if (!execution) continue;
        const chars = args.chars;
        if (chars !== undefined && typeof chars !== "string") continue;
        continuations.set(id, execution);
        append(execution, record, index, chars?.includes("\u0003") ? "interruption-requested" : chars ? "input" : "polled", "write_stdin");
      }
    } else if (payload.type === "function_call_output") {
      const header = firstHeader(record);
      const handle = header?.match(PROCESS_RUNNING)?.[1];
      const start = starts.get(id);
      if (start && handle) {
        if (active.has(handle)) continue;
        const execution = { id, handle, lastEventId: "" };
        append(execution, start.record, start.index, "started", "exec_command", start.label);
        append(execution, record, index, "yielded", "exec_command");
        active.set(handle, execution);
      } else {
        const execution = continuations.get(id);
        if (!execution || active.get(execution.handle) !== execution) continue;
        const exit = header?.match(PROCESS_EXITED);
        if (handle === execution.handle) append(execution, record, index, "yielded", "write_stdin");
        else if (exit) {
          append(execution, record, index, Number(exit[1]) === 0 ? "completed" : "failed", "write_stdin");
          active.delete(execution.handle);
        }
      }
    }
  }
  return events;
}
