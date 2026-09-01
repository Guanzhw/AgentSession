import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import type { Message, RawSession, TokenUsage } from "../interface.js";

export type DshRecord = Record<string, any>;

/**
 * DSH 0.x stores its append-only log as raw JSONL or a sequence of independently
 * compressed Zstandard frames.  This list is deliberately versioned with the
 * on-disk format: a required event outside it is unsafe to silently discard.
 */
export const DSH_SESSION_FORMAT_VERSION = 0;
export const DSH_KNOWN_EVENT_TYPES = new Set([
  "agent-preset/selected",
  "agent/inbox/spliced",
  "approval/asked",
  "approval/decided",
  "approval/policy",
  "assistant/chunk",
  "assistant/message",
  "command/done",
  "command/run",
  "compaction/end",
  "compaction/prune",
  "compaction/start",
  "compaction/summary",
  "feedback/record",
  "goal/change",
  "hook/invoked",
  "hook/result",
  "llm/retry",
  "llm/retry-started",
  "model/selection",
  "permission/preset",
  "plan/mode",
  "request/context",
  "request/header",
  "sandbox/mode",
  "schedule/change",
  "session/end-seed",
  "session/title",
  "session/title-llm-request",
  "session-log-deepseek/delivery-accepted",
  "step/end",
  "step/start",
  "subagent/descriptor",
  "subagent/model-selection-policy",
  "team/member",
  "team/message/delivered",
  "team/message/queued",
  "team/task",
  "todo/write",
  "tool-workflow/agent-end",
  "tool-workflow/agent-start",
  "tool-workflow/run-end",
  "tool-workflow/run-start",
  "tool/call",
  "tool/code-dispatch",
  "tool/code-dispatch-start",
  "tool/result",
  "turn/end",
  "turn/start",
  "user/message",
  "web/deepseek-search-llm-request"
]);

const ZSTD_MAGIC = 0xfd2fb528;

export class DshSessionParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DshSessionParseError";
  }
}

function isRecord(value: unknown): value is DshRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new DshSessionParseError(`Invalid ${label} in DeepSeek Harness session storage`);
  }
  return Number(value);
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new DshSessionParseError(`Invalid ${label} in DeepSeek Harness session storage`);
  }
  return Number(value);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DshSessionParseError(`Invalid ${label} in DeepSeek Harness session storage`);
  }
  return value;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

interface ZstdFrame {
  start: number;
  end: number;
}

/**
 * The DSH JSONL backend appends complete, separately-decodable Zstd frames.
 * Node's one-shot decoder stops after the first member, so scan frame
 * boundaries first and decode every committed frame independently.  EOF in a
 * final frame is a normal live-writer condition and deliberately omitted.
 */
export function scanDshZstdFrames(buffer: Buffer): { frames: ZstdFrame[]; tornStart?: number } {
  const frames: ZstdFrame[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new DshSessionParseError(`Corrupt DeepSeek Harness Zstandard log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset++);
    // Bit 3 is reserved and bit 4 is unused/reserved in this DSH writer.
    if ((descriptor & 0x18) !== 0) {
      throw new DshSessionParseError(`Corrupt DeepSeek Harness Zstandard log: reserved frame header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new DshSessionParseError(`Corrupt DeepSeek Harness Zstandard log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

function readDshZstdJsonl(source: Buffer, filePath: string): string {
  const { frames } = scanDshZstdFrames(source);
  if (!frames.length) {
    throw new DshSessionParseError(`DeepSeek Harness Zstandard session has no complete header frame: ${filePath}`);
  }
  const plaintexts: Buffer[] = [];
  for (const frame of frames) {
    try {
      plaintexts.push(zstdDecompressSync(source.subarray(frame.start, frame.end)));
    } catch (error) {
      throw new DshSessionParseError(`Unable to decompress DeepSeek Harness session frame in ${filePath}`, { cause: error });
    }
  }
  const content = Buffer.concat(plaintexts).toString("utf8");
  // A complete frame may never contain an uncommitted JSONL record.  A torn
  // physical final frame was already excluded above.
  if (content && !content.endsWith("\n")) {
    throw new DshSessionParseError(`Corrupt DeepSeek Harness Zstandard log: complete frame contains a torn JSONL record in ${filePath}`);
  }
  return content;
}

function parseJsonl(content: string, filePath: string, allowTornFinalLine: boolean): unknown[] {
  const lines = content.split("\n");
  const values: unknown[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, "");
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      const isLast = index === lines.length - 1;
      if (allowTornFinalLine && isLast && !content.endsWith("\n")) break;
      throw new DshSessionParseError(`Malformed DeepSeek Harness JSONL record ${index + 1} in ${filePath}`, { cause: error });
    }
  }
  return values;
}

function expandPackedChunkRow(value: DshRecord, tag: string): DshRecord[] {
  if (!hasExactKeys(value, ["type", "seq0", "time0", "data"])) {
    throw new DshSessionParseError(`Malformed DeepSeek Harness ${tag} storage row: unexpected envelope fields`);
  }
  const seq0 = nonNegativeSafeInteger(value.seq0, `${tag}.seq0`);
  const time0 = safeInteger(value.time0, `${tag}.time0`);
  const data = isRecord(value.data) ? value.data : null;
  if (!data) throw new DshSessionParseError(`Malformed DeepSeek Harness ${tag} storage row`);
  const turn = nonNegativeSafeInteger(data.turn, `${tag}.data.turn`);
  const step = nonNegativeSafeInteger(data.step, `${tag}.data.step`);
  const index = nonNegativeSafeInteger(data.index, `${tag}.data.index`);
  const members = tag === "tool-call-chunks" ? data.args : data.texts;
  if (!Array.isArray(members) || members.length === 0 || members.some((member) => typeof member !== "string")) {
    throw new DshSessionParseError(`Malformed DeepSeek Harness ${tag} storage row members`);
  }
  if (!Array.isArray(data.dt) || data.dt.length !== members.length - 1 || data.dt.some((gap) => !Number.isSafeInteger(gap))) {
    throw new DshSessionParseError(`Malformed DeepSeek Harness ${tag} storage row timing gaps`);
  }
  if (!Number.isSafeInteger(seq0 + members.length - 1)) {
    throw new DshSessionParseError(`Malformed DeepSeek Harness ${tag} storage row member sequence`);
  }
  if (tag === "tool-call-chunks") {
    const hasName = Object.hasOwn(data, "name");
    if (!hasExactKeys(data, hasName
      ? ["turn", "step", "index", "dt", "id", "name", "args"]
      : ["turn", "step", "index", "dt", "id", "args"])) {
      throw new DshSessionParseError(`Malformed DeepSeek Harness ${tag} storage row: unexpected data fields`);
    }
    nonEmptyString(data.id, `${tag}.data.id`);
    if (hasName && typeof data.name !== "string") {
      throw new DshSessionParseError(`Malformed DeepSeek Harness ${tag} storage row name`);
    }
  } else if (!hasExactKeys(data, ["turn", "step", "index", "dt", "texts"])) {
    throw new DshSessionParseError(`Malformed DeepSeek Harness ${tag} storage row: unexpected data fields`);
  }

  const events: DshRecord[] = [];
  let time = time0;
  for (let memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
    if (memberIndex > 0) time += Number(data.dt[memberIndex - 1]);
    const chunk = tag === "text-chunks"
      ? { type: "text-delta", index, text: members[memberIndex] }
      : tag === "reasoning-chunks"
        ? { type: "reasoning-delta", index, text: members[memberIndex] }
        : {
          type: "tool-call-delta",
          index,
          id: data.id,
          ...(Object.hasOwn(data, "name") ? { name: data.name } : {}),
          argumentsDelta: members[memberIndex]
        };
    if (!Number.isSafeInteger(time)) {
      throw new DshSessionParseError(`Malformed DeepSeek Harness ${tag} member time`);
    }
    events.push({
      type: "assistant/chunk",
      seq: seq0 + memberIndex,
      time,
      data: { turn, step, chunk }
    });
  }
  return events;
}

/** Expand DSH's non-event packed chunk rows into lossless assistant/chunk events. */
export function decodeDshStorageRecord(value: unknown): DshRecord[] {
  if (!isRecord(value)) return [value as DshRecord];
  const tag = value.type;
  if (tag !== "text-chunks" && tag !== "reasoning-chunks" && tag !== "tool-call-chunks") {
    if (!Object.hasOwn(value, "sourceEventSeqs")) return [value];
    const eventType = typeof value.type === "string" ? value.type : "event";
    const eventSeq = nonNegativeSafeInteger(value.seq, `${eventType}.seq`);
    const encoded = value.sourceEventSeqs;
    if (!Array.isArray(encoded)) {
      throw new DshSessionParseError(`Invalid ${eventType}.sourceEventSeqs in DeepSeek Harness session storage`);
    }
    const decoded: number[] = [];
    let containsRange = false;
    for (const entry of encoded) {
      if (!Array.isArray(entry)) {
        if (decoded.length >= eventSeq) {
          throw new DshSessionParseError(`Too many ${eventType}.sourceEventSeqs entries in DeepSeek Harness session storage`);
        }
        decoded.push(nonNegativeSafeInteger(entry, `${eventType}.sourceEventSeqs entry`));
        continue;
      }
      if (entry.length !== 2) {
        throw new DshSessionParseError(`Invalid ${eventType}.sourceEventSeqs range in DeepSeek Harness session storage`);
      }
      const start = nonNegativeSafeInteger(entry[0], `${eventType}.sourceEventSeqs range start`);
      const end = nonNegativeSafeInteger(entry[1], `${eventType}.sourceEventSeqs range end`);
      if (start > end) {
        throw new DshSessionParseError(`Invalid ${eventType}.sourceEventSeqs range in DeepSeek Harness session storage`);
      }
      const width = end - start + 1;
      if (width > eventSeq - decoded.length) {
        throw new DshSessionParseError(`Too many ${eventType}.sourceEventSeqs entries in DeepSeek Harness session storage`);
      }
      for (let sourceSeq = start; sourceSeq <= end; sourceSeq += 1) decoded.push(sourceSeq);
      containsRange = true;
    }
    if (containsRange && decoded.some((sourceSeq, index) => index > 0 && sourceSeq <= decoded[index - 1])) {
      throw new DshSessionParseError(`Non-increasing ${eventType}.sourceEventSeqs in DeepSeek Harness session storage`);
    }
    return [{ ...value, sourceEventSeqs: decoded }];
  }
  return expandPackedChunkRow(value, tag);
}

function validateDshHeader(header: DshRecord, filePath: string) {
  if (header.type !== "session") {
    throw new DshSessionParseError(`DeepSeek Harness session is missing its header: ${filePath}`);
  }
  if (header.version !== DSH_SESSION_FORMAT_VERSION) {
    throw new DshSessionParseError(`Unsupported DeepSeek Harness session version ${String(header.version)} in ${filePath}; expected ${DSH_SESSION_FORMAT_VERSION}`);
  }
  nonEmptyString(header.id, "session.id");
  nonNegativeSafeInteger(header.createdAt, "session.createdAt");
  if (header.delegationDepth !== undefined) {
    nonNegativeSafeInteger(header.delegationDepth, "session.delegationDepth");
  }
  if (header.cwd !== undefined && typeof header.cwd !== "string") {
    throw new DshSessionParseError("Invalid session.cwd in DeepSeek Harness session storage");
  }
  if (header.parentSession !== undefined && typeof header.parentSession !== "string") {
    throw new DshSessionParseError("Invalid session.parentSession in DeepSeek Harness session storage");
  }
  if (header.seedLength !== undefined) nonNegativeSafeInteger(header.seedLength, "session.seedLength");
  if (header.agentPreset !== undefined && typeof header.agentPreset !== "string") {
    throw new DshSessionParseError("Invalid session.agentPreset in DeepSeek Harness session storage");
  }
}

function validateDshEvents(records: DshRecord[], filePath: string) {
  let expectedSeq = 0;
  for (const event of records) {
    if (!isRecord(event)) throw new DshSessionParseError(`Invalid DeepSeek Harness event in ${filePath}`);
    const type = nonEmptyString(event.type, "event.type");
    if (!DSH_KNOWN_EVENT_TYPES.has(type) && event.ignorable !== true) {
      throw new DshSessionParseError(`Unsupported required DeepSeek Harness event ${JSON.stringify(type)} in ${filePath}`);
    }
    const seq = nonNegativeSafeInteger(event.seq, `${type}.seq`);
    if (seq !== expectedSeq) {
      throw new DshSessionParseError(`Non-contiguous DeepSeek Harness event sequence in ${filePath}: expected ${expectedSeq}, got ${seq}`);
    }
    nonNegativeSafeInteger(event.time, `${type}.time`);
    if (!isRecord(event.data)) {
      throw new DshSessionParseError(`Invalid DeepSeek Harness ${type}.data in ${filePath}`);
    }
    expectedSeq += 1;
  }
}

/** Read one DSH raw JSONL or multi-frame Zstd session without mutating it. */
export function parseDshSession(filePath: string): DshRecord[] {
  const source = readFileSync(filePath);
  const compressed = /\.zstd$/i.test(filePath);
  const content = compressed ? readDshZstdJsonl(source, filePath) : source.toString("utf8");
  const storageRows = parseJsonl(content, filePath, !compressed);
  const records = storageRows.flatMap(decodeDshStorageRecord);
  if (!records.length) throw new DshSessionParseError(`Empty DeepSeek Harness session: ${filePath}`);
  validateDshHeader(records[0], filePath);
  const seedLength = dshHeader(records)?.seedLength;
  if (seedLength !== undefined && seedLength > records.length - 1) {
    throw new DshSessionParseError(`Invalid session.seedLength ${String(seedLength)} in ${filePath}; exceeds stored event count`);
  }
  validateDshEvents(records.slice(1), filePath);
  for (const event of records.slice(1).filter((candidate) => candidate.type === "session/end-seed")) {
    if (seedLength !== undefined && event.seq < seedLength) {
      throw new DshSessionParseError(`Invalid session/end-seed boundary at sequence ${String(event.seq)} in ${filePath}`);
    }
  }
  return records;
}

export function dshHeader(records: DshRecord[]): DshRecord | null {
  const header = records[0];
  return header?.type === "session" ? header : null;
}

/**
 * Omit durable fork history copied into a child session's log.  DSH's
 * `session/end-seed` records an in-process construction/resume boundary and
 * can appear after a session's own older work, so it is deliberately not a
 * durable viewer lineage cutoff.
 */
export function dshOwnedEvents(records: DshRecord[]): DshRecord[] {
  const seedLength = numberOrZero(dshHeader(records)?.seedLength);
  return records.slice(1).filter((event) => numberOrZero(event.seq) >= seedLength);
}

function isReplacementSurfaceEvent(event: DshRecord) {
  const op = event.surfaceOp;
  return isRecord(op) && op.op === "replace";
}

export function dshContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

export function dshContentThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => isRecord(block) && block.type === "reasoning" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function dshToolCallBlocks(content: unknown): DshRecord[] {
  return Array.isArray(content)
    ? content.filter((block): block is DshRecord => isRecord(block) && block.type === "tool-call" && typeof block.id === "string")
    : [];
}

function dshToolResultBlocks(content: unknown): DshRecord[] {
  return Array.isArray(content)
    ? content.filter((block): block is DshRecord => isRecord(block) && block.type === "tool-result" && typeof block.toolCallId === "string")
    : [];
}

function dshToolInput(argumentsText: unknown): { input: unknown; raw: string | null } {
  if (typeof argumentsText !== "string") return { input: null, raw: null };
  try {
    return { input: JSON.parse(argumentsText), raw: null };
  } catch {
    return { input: argumentsText, raw: argumentsText };
  }
}

/** Normalize the DSH provider's explicit token accounting into exclusive UI components. */
export function dshUsageToTokens(usage: unknown): TokenUsage | null {
  const value = isRecord(usage) ? usage : null;
  if (!value) return null;
  const input = numberOrZero(value.inputTokens);
  const output = numberOrZero(value.outputTokens);
  const reasoning = numberOrZero(value.reasoningTokens);
  const cacheRead = numberOrZero(value.cacheReadTokens);
  const cacheWrite = numberOrZero(value.cacheWriteTokens);
  if (!input && !output && !reasoning && !cacheRead && !cacheWrite) return null;
  return {
    input,
    // Upstream packages/llm/llm-deepseek/src/translate.ts maps
    // completion_tokens to outputTokens and keeps reasoningTokens as a
    // reported subset. Shared charts require exclusive components, so retain
    // visible output here and reasoning separately.
    output: Math.max(0, output - reasoning),
    reasoning,
    total: input + output + cacheRead + cacheWrite,
    cache: { read: cacheRead, write: cacheWrite }
  };
}

function createToolMessage({
  id,
  sessionId,
  callId,
  name,
  input,
  rawInput,
  timestamp,
  turn,
  step,
  sourceSeq
}: {
  id: string;
  sessionId: string;
  callId: string;
  name: string;
  input: unknown;
  rawInput: string | null;
  timestamp: number;
  turn: unknown;
  step: unknown;
  sourceSeq: unknown;
}): Message {
  return {
    id,
    sessionId,
    role: "tool",
    content: "",
    thinking: null,
    toolName: name,
    toolInput: input,
    toolOutput: null,
    timestamp,
    tokens: null,
    metadata: {
      callId,
      turnId: Number.isSafeInteger(turn) ? String(turn) : null,
      step: Number.isSafeInteger(step) ? step : null,
      sourceSequence: sourceSeq,
      status: "running",
      ...(rawInput ? { rawArguments: rawInput } : {}),
      provenance: "session"
    }
  };
}

/**
 * Human-facing DSH transcript projection.  Plugin-injected context is kept
 * out of the user chat surface; it remains available as recorded protocol and
 * stored system-prompt evidence instead.
 */
export function dshRecordsToMessages(records: DshRecord[], sessionId: string): Message[] {
  const messages: Message[] = [];
  const calls = new Map<string, Message>();

  const ensureTool = (callId: string, fallbackId: string, name: string, input: unknown, rawInput: string | null, event: DshRecord) => {
    const existing = calls.get(callId);
    if (existing) {
      if (name && name !== "tool") existing.toolName = name;
      if (input != null) existing.toolInput = input;
      existing.metadata = {
        ...existing.metadata,
        sourceSequence: event.seq,
        ...(rawInput ? { rawArguments: rawInput } : {})
      };
      return existing;
    }
    const tool = createToolMessage({
      id: callId || fallbackId,
      sessionId,
      callId,
      name: name || "tool",
      input,
      rawInput,
      timestamp: numberOrZero(event.time),
      turn: event.data?.turn,
      step: event.data?.step,
      sourceSeq: event.seq
    });
    messages.push(tool);
    if (callId) calls.set(callId, tool);
    return tool;
  };

  for (const event of dshOwnedEvents(records)) {
    const data = isRecord(event.data) ? event.data : {};
    if (event.type === "user/message" && !isReplacementSurfaceEvent(event)) {
      const source = isRecord(data.source) ? data.source : {};
      if (source.kind !== "user") continue;
      const id = typeof data.id === "string" && data.id ? data.id : `user:${event.seq}`;
      messages.push({
        id,
        sessionId,
        role: "user",
        content: dshContentText(data.content),
        thinking: null,
        toolName: null,
        toolInput: null,
        toolOutput: null,
        timestamp: numberOrZero(event.time),
        tokens: null,
        metadata: {
          sourceSequence: event.seq,
          turnId: Number.isSafeInteger(data.turn) ? String(data.turn) : null,
          provenance: "session"
        }
      });
      continue;
    }

    if (event.type === "assistant/message" && !isReplacementSurfaceEvent(event)) {
      const source = isRecord(data.message) ? data.message : {};
      const id = typeof source.id === "string" && source.id ? source.id : `assistant:${event.seq}`;
      const assistant: Message = {
        id,
        sessionId,
        role: "assistant",
        content: dshContentText(source.content),
        thinking: dshContentThinking(source.content) || null,
        toolName: null,
        toolInput: null,
        toolOutput: null,
        timestamp: numberOrZero(event.time),
        tokens: dshUsageToTokens(data.usage),
        metadata: {
          provider: source.source?.provider || null,
          model: source.source?.model || null,
          turnId: Number.isSafeInteger(data.turn) ? String(data.turn) : null,
          step: Number.isSafeInteger(data.step) ? data.step : null,
          sourceSequence: event.seq,
          provenance: "session"
        }
      };
      messages.push(assistant);
      for (const [index, call] of dshToolCallBlocks(source.content).entries()) {
        const callId = String(call.id);
        const parsed = dshToolInput(call.arguments);
        ensureTool(callId, `${id}:tool:${index}`, String(call.name || "tool"), parsed.input, parsed.raw, event);
      }
      continue;
    }

    if (event.type === "tool/call") {
      const callId = typeof data.callId === "string" ? data.callId : "";
      const parsed = dshToolInput(data.arguments);
      ensureTool(
        callId,
        `tool-call:${event.seq}`,
        typeof data.name === "string" ? data.name : "tool",
        parsed.input,
        parsed.raw,
        event
      );
      continue;
    }

    if (event.type === "tool/result" && !isReplacementSurfaceEvent(event)) {
      const message = isRecord(data.message) ? data.message : {};
      const resultBlocks = dshToolResultBlocks(message.content);
      const blocks: Array<DshRecord | null> = resultBlocks.length ? resultBlocks : [null];
      const sourceCallId = typeof message.source?.callId === "string" ? message.source.callId : "";
      for (const [index, block] of blocks.entries()) {
        const callId = typeof block?.toolCallId === "string" ? block.toolCallId : sourceCallId;
        const output = dshContentText(block?.content);
        const failed = block?.isError === true || Boolean(data.error);
        const messageId = typeof message.id === "string" && message.id
          ? index === 0 ? message.id : `${message.id}:${index}`
          : `tool-result:${event.seq}:${index}`;
        const tool = ensureTool(callId, messageId, "tool", null, null, event);
        tool.content = output;
        tool.toolOutput = output;
        tool.timestamp = numberOrZero(event.time);
        tool.metadata = {
          ...tool.metadata,
          sourceSequence: event.seq,
          resultMessageId: typeof message.id === "string" ? message.id : null,
          status: failed ? "error" : "completed",
          isError: failed,
          error: data.error || null,
          resultMeta: data.meta || null
        };
      }
    }
  }
  return messages;
}

function latestEvent(records: DshRecord[], type: string): DshRecord | null {
  return [...dshOwnedEvents(records)].reverse().find((event) => event.type === type) || null;
}

function descriptorLabel(records: DshRecord[]): string | null {
  const descriptor = latestEvent(records, "subagent/descriptor");
  const label = descriptor?.data?.label;
  return typeof label === "string" && label.trim() ? label.trim() : null;
}

export function extractDshMeta(records: DshRecord[], fallbackId = ""): RawSession {
  const header = dshHeader(records) || {};
  const sessionId = typeof header.id === "string" && header.id ? header.id : fallbackId;
  const messages = dshRecordsToMessages(records, sessionId);
  const owned = dshOwnedEvents(records);
  const titleEvent = latestEvent(records, "session/title");
  const storedTitle = typeof titleEvent?.data?.title === "string" ? titleEvent.data.title.trim() : "";
  const firstUser = messages.find((message) => message.role === "user" && message.content.trim());
  const headerCreatedAt = numberOrZero(header.createdAt);
  let fallbackCreatedAt = headerCreatedAt;
  let timeUpdated = headerCreatedAt;
  for (const event of owned) {
    const time = numberOrZero(event.time);
    if (!time) continue;
    if (!fallbackCreatedAt || time < fallbackCreatedAt) fallbackCreatedAt = time;
    if (time > timeUpdated) timeUpdated = time;
  }
  const tokenCount = messages.reduce((total, message) => total + (Number(message.tokens?.total) || 0), 0);
  const latestContext = latestEvent(records, "request/context");
  return {
    id: sessionId,
    provider: "deepseek-harness",
    parentId: typeof header.parentSession === "string" && header.parentSession ? header.parentSession : null,
    title: storedTitle || descriptorLabel(records) || firstUser?.content.replace(/\s+/g, " ").trim().slice(0, 120) || null,
    directory: typeof header.cwd === "string" && header.cwd ? header.cwd : null,
    timeCreated: headerCreatedAt || fallbackCreatedAt,
    timeUpdated,
    messageCount: messages.length,
    tokenCount: tokenCount || null,
    metadata: {
      version: header.version,
      seedLength: numberOrZero(header.seedLength),
      inheritedEventCount: numberOrZero(header.seedLength),
      origin: header.origin || null,
      delegationDepth: numberOrZero(header.delegationDepth),
      agentPreset: header.agentPreset || null,
      parentSession: header.parentSession || null,
      provider: latestContext?.data?.provider || null,
      model: latestContext?.data?.model || null,
      aliases: storedTitle ? [storedTitle] : []
    }
  };
}

export function dshAssistantUsageRecords(records: DshRecord[]) {
  return dshOwnedEvents(records).filter((event) => (
    event.type === "assistant/message" && dshUsageToTokens(event.data?.usage) !== null
  ));
}

export function dshStoredSystemPrompt(records: DshRecord[]): { content: string; source: string; title: string } | null {
  const header = latestEvent(records, "request/header");
  const content = header?.data?.header?.system;
  if (typeof content !== "string" || !content.trim()) return null;
  return {
    content,
    source: `dsh.request/header:${String(header?.seq)}`,
    title: "Persisted DSH request system prompt"
  };
}

/** Map a child session's durable final turn reason to the shared task status vocabulary. */
export function dshSessionStatus(records: DshRecord[]): "running" | "completed" | "failed" | "blocked" | "cancelled" {
  const end = latestEvent(records, "turn/end");
  const kind = end?.data?.reason?.kind;
  if (kind === "completed") return "completed";
  if (kind === "error") return "failed";
  if (kind === "blocked") return "blocked";
  if (kind === "aborted" || kind === "interrupted") return "cancelled";
  return "running";
}
