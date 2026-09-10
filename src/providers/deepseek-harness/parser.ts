import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { Message, RawSession, TokenUsage } from "../interface.js";

export type DshRecord = Record<string, any>;

/**
 * DSH 0.x stores its append-only log as raw JSONL or a sequence of independently
 * compressed Zstandard frames.  This list is deliberately versioned with the
 * on-disk format: a required event outside it is unsafe to silently discard.
 */
export const DSH_SESSION_FORMAT_VERSION = 3;
export const DSH_KNOWN_EVENT_TYPES = new Set([
  "agent-preset/selected",
  "agent/inbox/spliced",
  "approval/asked",
  "approval/decided",
  "approval/policy",
  "assistant/attempt",
  "assistant/message",
  "command/done",
  "command/run",
  "compaction/end",
  "compaction/prune",
  "compaction/start",
  "compaction/summary",
  "deliverables/presented",
  "feedback/record",
  "feedback/message-put",
  "feedback/message-delete",
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
  "subagent/catalog",
  "subagent/model-selection-policy",
  "system/message",
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
  "tool/ptc-dispatch",
  "tool/ptc-dispatch-start",
  "tool/result",
  "turn/end",
  "turn/start",
  "user/message",
  "web/deepseek-search-llm-request"
]);
const DSH_HISTORICAL_KNOWN_EVENT_TYPES = new Set([
  ...[...DSH_KNOWN_EVENT_TYPES].filter((type) => ![
    "deliverables/presented",
    "subagent/catalog",
    "system/message",
    "tool/ptc-dispatch",
    "tool/ptc-dispatch-start"
  ].includes(type)),
  "tool/code-dispatch",
  "tool/code-dispatch-start"
]);

/** Physical generation names accepted by the released alpha.2 reader. */
export type DshSessionGeneration = 0 | 1 | 2 | 3;

export function dshGenerationFromPath(filePath: string): DshSessionGeneration | null {
  const name = filePath.replaceAll("\\", "/").split("/").at(-1) || "";
  if (name === "session.jsonl" || name === "session.jsonl.zstd") return 0;
  if (name === "session.v1.jsonl" || name === "session.v1.jsonl.zstd") return 1;
  if (name === "session.v2.jsonl" || name === "session.v2.jsonl.zstd") return 2;
  if (name === "session.v3.jsonl" || name === "session.v3.jsonl.zstd") return 3;
  return null;
}

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

function isDeepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => isDeepEqualJson(value, b[index]));
  }
  if (typeof a !== "object" || typeof b !== "object") return false;
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  if (aKeys.length !== Object.keys(bRecord).length) return false;
  return aKeys.every((key) => Object.hasOwn(bRecord, key) && isDeepEqualJson(aRecord[key], bRecord[key]));
}

/** Enforce the released v2 tool/result rewrite contract at the provider boundary. */
function assertV2ToolResultContentOnly(original: DshRecord, replacement: DshRecord, filePath: string): void {
  const originalData = isRecord(original.data) ? original.data : null;
  const replacementData = isRecord(replacement.data) ? replacement.data : null;
  const originalMessage = originalData && isRecord(originalData.message) ? originalData.message : null;
  const replacementMessage = replacementData && isRecord(replacementData.message) ? replacementData.message : null;
  const originalContent = originalMessage && Array.isArray(originalMessage.content) ? originalMessage.content : null;
  const replacementContent = replacementMessage && Array.isArray(replacementMessage.content) ? replacementMessage.content : null;
  const originalResult = originalContent?.[0];
  const replacementResult = replacementContent?.[0];
  if (!originalData || !replacementData || !originalMessage || !replacementMessage
    || !isRecord(originalResult) || !isRecord(replacementResult)) {
    throw new DshSessionParseError(`Invalid tool/result replacement content in ${filePath}`);
  }
  const originalRest = {
    ...originalData,
    message: { ...originalMessage, content: [{ ...originalResult, content: null }] }
  };
  const replacementRest = {
    ...replacementData,
    message: { ...replacementMessage, content: [{ ...replacementResult, content: null }] }
  };
  if (!isDeepEqualJson(originalRest, replacementRest)) {
    throw new DshSessionParseError(`Invalid tool/result replacement: only message.content may change in ${filePath}`);
  }
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
export function decodeDshStorageRecord(value: unknown, generation: DshSessionGeneration = 0): DshRecord[] {
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
  if (generation >= 2) {
    throw new DshSessionParseError(`Packed ${String(tag)} row is not valid in DeepSeek Harness format v${generation}`);
  }
  return expandPackedChunkRow(value, tag);
}

function validateDshHeader(header: DshRecord, filePath: string, generation: DshSessionGeneration) {
  if (header.type !== "session") {
    throw new DshSessionParseError(`DeepSeek Harness session is missing its header: ${filePath}`);
  }
  if (header.version !== generation) {
    throw new DshSessionParseError(`DeepSeek Harness session filename generation ${generation} disagrees with header version ${String(header.version)} in ${filePath}`);
  }
  const allowed = new Set(generation >= 2
    ? ["type", "version", "id", "createdAt", "cwd", "parentSession", "isSeeded", "origin", "delegationDepth", "agentPreset"]
    : ["type", "version", "id", "createdAt", "cwd", "parentSession", "seedLength", "origin", "delegationDepth", "agentPreset"]);
  const unexpected = Object.keys(header).find((key) => !allowed.has(key));
  if (unexpected) throw new DshSessionParseError(`Invalid DeepSeek Harness session header field ${unexpected} in ${filePath}`);
  nonEmptyString(header.id, "session.id");
  nonNegativeSafeInteger(header.createdAt, "session.createdAt");
  if (header.delegationDepth !== undefined) {
    nonNegativeSafeInteger(header.delegationDepth, "session.delegationDepth");
  }
  // Recorded paths belong to the source host, which may differ from the viewer.
  if (header.cwd !== undefined && (typeof header.cwd !== "string" || !(posix.isAbsolute(header.cwd) || win32.isAbsolute(header.cwd)))) {
    throw new DshSessionParseError("Invalid session.cwd in DeepSeek Harness session storage");
  }
  if (header.parentSession !== undefined && typeof header.parentSession !== "string") {
    throw new DshSessionParseError("Invalid session.parentSession in DeepSeek Harness session storage");
  }
  if (generation > 0 && (!Number.isSafeInteger(header.delegationDepth) || Number(header.delegationDepth) < 0)) {
    throw new DshSessionParseError(`Invalid session.delegationDepth in DeepSeek Harness format v${generation} storage`);
  }
  if (generation > 0 && header.origin !== undefined && header.origin !== "subagent") {
    throw new DshSessionParseError(`Invalid session.origin in DeepSeek Harness format v${generation} storage`);
  }
  if (generation < 2 && header.seedLength !== undefined) nonNegativeSafeInteger(header.seedLength, "session.seedLength");
  if (generation >= 2) {
    if (typeof header.isSeeded !== "boolean") throw new DshSessionParseError("Invalid session.isSeeded in DeepSeek Harness session storage");
    if (!Number.isSafeInteger(header.delegationDepth) || Number(header.delegationDepth) < 0) throw new DshSessionParseError("Invalid session.delegationDepth in DeepSeek Harness session storage");
    if (Object.hasOwn(header, "seedLength")) throw new DshSessionParseError(`DeepSeek Harness format v${generation} header cannot carry seedLength`);
  } else if (Object.hasOwn(header, "isSeeded")) {
    throw new DshSessionParseError(`DeepSeek Harness format v${generation} header cannot carry isSeeded`);
  }
  if (header.agentPreset !== undefined && typeof header.agentPreset !== "string") {
    throw new DshSessionParseError("Invalid session.agentPreset in DeepSeek Harness session storage");
  }
}

function validateDshV3SystemEvent(event: DshRecord, filePath: string): void {
  const data = event.data as DshRecord;
  const message = isRecord(data.message) ? data.message : null;
  if (!hasExactKeys(data, ["turn", "step", "message"])
    || !Number.isSafeInteger(data.turn) || Number(data.turn) <= 0
    || !Number.isSafeInteger(data.step) || Number(data.step) <= 0
    || !message || !hasExactKeys(message, ["id", "role", "source", "content"]) || message.role !== "system"
    || typeof message.id !== "string" || !message.id
    || !isRecord(message.source) || message.source.kind !== "plugin"
    || typeof message.source.plugin !== "string" || !message.source.plugin
    || !Array.isArray(message.content)) {
    throw new DshSessionParseError(`Invalid system/message payload in ${filePath}`);
  }
}

function validateDshV3ConsumedEvent(event: DshRecord, filePath: string): void {
  const data = event.data as DshRecord;
  if (event.type === "subagent/catalog") {
    const continuable = data.mode === "continuable";
    const allowed = continuable
      ? ["version", "childId", "childCreatedAt", "mode", "label"]
      : ["version", "childId", "childCreatedAt", "mode", ...(Object.hasOwn(data, "label") ? ["label"] : [])];
    if (!hasExactKeys(data, allowed) || data.version !== 0
      || typeof data.childId !== "string" || !data.childId
      || !Number.isSafeInteger(data.childCreatedAt) || Number(data.childCreatedAt) < 0
      || (data.mode !== "one-shot" && data.mode !== "continuable")
      || (continuable && (typeof data.label !== "string" || !data.label))
      || (Object.hasOwn(data, "label") && typeof data.label !== "string")) {
      throw new DshSessionParseError(`Invalid subagent/catalog payload in ${filePath}`);
    }
    return;
  }
  if (event.type !== "deliverables/presented") return;
  if (!hasExactKeys(data, ["turn", "callId", "files"])
    || !Number.isSafeInteger(data.turn) || Number(data.turn) < 1
    || typeof data.callId !== "string" || !data.callId
    || !Array.isArray(data.files)
    || data.files.some((file) => !isRecord(file)
      || !hasExactKeys(file, Object.hasOwn(file, "description") ? ["path", "description"] : ["path"])
      || typeof file.path !== "string" || !file.path.trim()
      || (Object.hasOwn(file, "description") && typeof file.description !== "string"))) {
    throw new DshSessionParseError(`Invalid deliverables/presented payload in ${filePath}`);
  }
}

function validateDshV3Events(records: DshRecord[], filePath: string): void {
  const surfaceTypes = new Set(["system/message", "user/message", "assistant/message", "tool/result"]);
  const surfaceNodes: number[] = [];
  const surfaceNodeTypes = new Map<number, string>();
  let openStep: { turn: number; step: number } | null = null;
  let systemHead: number | undefined;
  let hasSurface = false;
  let expectedSeq = 0;
  for (const event of records) {
    const type = nonEmptyString(event.type, "event.type");
    const known = DSH_KNOWN_EVENT_TYPES.has(type);
    const obsolete = type === "tool/code-dispatch" || type === "tool/code-dispatch-start";
    if ((!known || obsolete) && event.ignorable !== true) {
      throw new DshSessionParseError(`Unsupported required DeepSeek Harness event ${JSON.stringify(type)} in ${filePath}`);
    }
    const allowed = new Set(["type", "seq", "time", "data", "ignorable", "sourceEventSeqs", "surfaceOp"]);
    const unexpected = Object.keys(event).find((key) => !allowed.has(key));
    if (unexpected) throw new DshSessionParseError(`DeepSeek Harness format v3 event has unexpected field ${unexpected} in ${filePath}`);
    if (event.ignorable !== undefined && event.ignorable !== true) {
      throw new DshSessionParseError(`Invalid ${type}.ignorable in ${filePath}`);
    }
    const seq = nonNegativeSafeInteger(event.seq, `${type}.seq`);
    if (seq !== expectedSeq) {
      throw new DshSessionParseError(`Non-contiguous DeepSeek Harness event sequence in ${filePath}: expected ${expectedSeq}, got ${seq}`);
    }
    nonNegativeSafeInteger(event.time, `${type}.time`);
    if (!isRecord(event.data)) throw new DshSessionParseError(`Invalid DeepSeek Harness ${type}.data in ${filePath}`);
    validateDshV3ConsumedEvent(event, filePath);

    if (type === "step/start" && Number.isSafeInteger(event.data.turn) && Number.isSafeInteger(event.data.step)) {
      openStep = { turn: Number(event.data.turn), step: Number(event.data.step) };
    } else if (type === "step/end" || type === "turn/end") {
      openStep = null;
    }

    if (surfaceTypes.has(type)) {
      if (event.surfaceOp === undefined) throw new DshSessionParseError(`DeepSeek Harness v3 ${type} event requires surfaceOp in ${filePath}`);
      if (type === "system/message") {
        validateDshV3SystemEvent(event, filePath);
        if (!openStep || openStep.turn !== Number(event.data.turn) || openStep.step !== Number(event.data.step)) {
          throw new DshSessionParseError(`system/message does not match an open step in ${filePath}`);
        }
        if (hasSurface && systemHead === undefined) {
          throw new DshSessionParseError(`DeepSeek Harness v3 system/message requires a protected first surface head in ${filePath}`);
        }
      }
      if (event.surfaceOp !== "append") {
        const op = event.surfaceOp;
        if (!isRecord(op) || !hasExactKeys(op, ["op", "startSeq", "endSeq"])
          || op.op !== "replace" || !Number.isSafeInteger(op.startSeq) || Number(op.startSeq) < 0
          || !Number.isSafeInteger(op.endSeq) || Number(op.endSeq) < 0) {
          throw new DshSessionParseError(`Invalid ${type}.surfaceOp in ${filePath}`);
        }
        const startIndex = surfaceNodes.indexOf(Number(op.startSeq));
        const endIndex = surfaceNodes.indexOf(Number(op.endSeq));
        if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) {
          throw new DshSessionParseError(`Invalid ${type}.surfaceOp range in ${filePath}`);
        }
        const sources = event.sourceEventSeqs;
        if (!Array.isArray(sources) || sources.length === 0
          || surfaceNodes.slice(startIndex, endIndex + 1).some((source) => !sources.includes(source))) {
          throw new DshSessionParseError(`Invalid ${type}.sourceEventSeqs replacement coverage in ${filePath}`);
        }
        const shadowed = surfaceNodes.slice(startIndex, endIndex + 1);
        if (type === "tool/result" && (shadowed.length !== 1 || surfaceNodeTypes.get(shadowed[0]) !== "tool/result")) {
          throw new DshSessionParseError(`Invalid tool/result replacement target in ${filePath}`);
        }
        if (type === "tool/result") {
          const original = records.find((candidate) => candidate.seq === shadowed[0]);
          if (!original) throw new DshSessionParseError(`Invalid tool/result replacement target in ${filePath}`);
          assertV2ToolResultContentOnly(original, event, filePath);
        }
        if (systemHead !== undefined && type !== "system/message" && shadowed.includes(systemHead)) {
          throw new DshSessionParseError(`DeepSeek Harness v3 surface replacement cannot shadow the protected system head in ${filePath}`);
        }
        if (type === "system/message" && systemHead !== undefined && shadowed.includes(systemHead)
          && (shadowed.length !== 1 || shadowed[0] !== systemHead)) {
          throw new DshSessionParseError(`DeepSeek Harness v3 system/message must replace exactly the protected system head in ${filePath}`);
        }
        surfaceNodes.splice(startIndex, endIndex - startIndex + 1, seq);
        for (const source of shadowed) surfaceNodeTypes.delete(source);
        surfaceNodeTypes.set(seq, type);
        if (type === "system/message" && systemHead !== undefined && shadowed.includes(systemHead)) systemHead = seq;
      } else {
        if (type === "system/message") {
          if (systemHead === undefined) systemHead = seq;
        }
        surfaceNodes.push(seq);
        surfaceNodeTypes.set(seq, type);
      }
      if (type === "assistant/message" && event.sourceEventSeqs !== undefined) {
        throw new DshSessionParseError(`DeepSeek Harness v3 assistant/message embeds its source stream and cannot carry sourceEventSeqs in ${filePath}`);
      }
      hasSurface = true;
      if (type !== "assistant/message" && event.sourceEventSeqs !== undefined) {
        if (!Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length === 0) {
          throw new DshSessionParseError(`Invalid ${type}.sourceEventSeqs in ${filePath}`);
        }
      }
      if (Array.isArray(event.sourceEventSeqs)) {
        const sources = event.sourceEventSeqs.map((source) => nonNegativeSafeInteger(source, `${type}.sourceEventSeqs entry`));
        if (new Set(sources).size !== sources.length || sources.some((source) => source >= seq)) {
          throw new DshSessionParseError(`Invalid ${type}.sourceEventSeqs provenance in ${filePath}`);
        }
      }
    } else if (DSH_KNOWN_EVENT_TYPES.has(type)
      && (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined)) {
      throw new DshSessionParseError(`DeepSeek Harness v3 ${type} event cannot carry surface metadata in ${filePath}`);
    }
    if ((type === "compaction/prune" || type === "compaction/summary")
      && systemHead !== undefined && Array.isArray(event.data.shadowedSeqs)
      && event.data.shadowedSeqs.includes(systemHead)) {
      throw new DshSessionParseError(`DeepSeek Harness v3 ${type} cannot shadow the protected system head in ${filePath}`);
    }
    if (type === "request/header" && isRecord(event.data.header) && Object.hasOwn(event.data.header, "system")) {
      throw new DshSessionParseError(`DeepSeek Harness v3 request/header rejects retired header.system in ${filePath}`);
    }
    expectedSeq += 1;
  }
}

function validateDshEvents(records: DshRecord[], filePath: string, generation: DshSessionGeneration) {
  let expectedSeq = 0;
  const surfaceNodes: number[] = [];
  const surfaceTypes = new Map<number, string>();
  for (const event of records) {
    if (!isRecord(event)) throw new DshSessionParseError(`Invalid DeepSeek Harness event in ${filePath}`);
    const type = nonEmptyString(event.type, "event.type");
    const known = DSH_HISTORICAL_KNOWN_EVENT_TYPES.has(type)
      || (generation < 2 && type === "assistant/chunk");
    if (!known && (generation === 0 || event.ignorable !== true)) {
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
    if (generation === 3) continue;
    const surfaceEligible = type === "user/message" || type === "assistant/message" || type === "tool/result";
    if (generation < 2) {
      const allowed = new Set(surfaceEligible
        ? ["type", "seq", "time", "data", "ignorable", "sourceEventSeqs", "surfaceOp"]
        : ["type", "seq", "time", "data", "ignorable"]);
      const unexpected = Object.keys(event).find((key) => !allowed.has(key));
      if (unexpected) throw new DshSessionParseError(`DeepSeek Harness format v${generation} event has unexpected field ${unexpected} in ${filePath}`);
      if (event.ignorable !== undefined && event.ignorable !== true) throw new DshSessionParseError(`Invalid ${type}.ignorable in ${filePath}`);
      if (!surfaceEligible && (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined)) {
        throw new DshSessionParseError(`DeepSeek Harness format v${generation} ${type} event cannot carry surface metadata in ${filePath}`);
      }
      if (event.surfaceOp !== undefined && event.surfaceOp !== "append") {
        const op = event.surfaceOp;
        if (!isRecord(op) || op.op !== "replace" || !Number.isSafeInteger(op.start) || op.start < 0
          || !Number.isSafeInteger(op.end) || op.end < op.start) {
          throw new DshSessionParseError(`Invalid ${type}.surfaceOp in ${filePath}`);
        }
      }
      if (event.sourceEventSeqs !== undefined) {
        if (!Array.isArray(event.sourceEventSeqs)
          || (event.sourceEventSeqs.length === 0 && type !== "assistant/message")) {
          throw new DshSessionParseError(`Invalid ${type}.sourceEventSeqs in ${filePath}`);
        }
        const sources = event.sourceEventSeqs.map((source) => nonNegativeSafeInteger(source, `${type}.sourceEventSeqs entry`));
        if (new Set(sources).size !== sources.length || sources.some((source) => source >= seq)) {
          throw new DshSessionParseError(`Invalid ${type}.sourceEventSeqs provenance in ${filePath}`);
        }
      }
    }
    if (generation === 2) {
      const allowed = new Set(["type", "seq", "time", "data", "ignorable", "sourceEventSeqs", "surfaceOp"]);
      const unexpected = Object.keys(event).find((key) => !allowed.has(key));
      if (unexpected) throw new DshSessionParseError(`DeepSeek Harness format v2 event has unexpected field ${unexpected} in ${filePath}`);
      if (event.ignorable !== undefined && event.ignorable !== true) throw new DshSessionParseError(`Invalid ${type}.ignorable in ${filePath}`);
      if (surfaceEligible && event.surfaceOp === undefined) {
        throw new DshSessionParseError(`DeepSeek Harness v2 ${type} event requires surfaceOp in ${filePath}`);
      }
      if (!surfaceEligible && (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined)) {
        throw new DshSessionParseError(`DeepSeek Harness v2 ${type} event cannot carry surface metadata in ${filePath}`);
      }
      if (event.surfaceOp !== undefined && event.surfaceOp !== "append") {
        const op = event.surfaceOp;
        if (!isRecord(op) || op.op !== "replace"
          || !Number.isSafeInteger(op.start) || op.start < 0
          || !Number.isSafeInteger(op.end) || op.end < op.start) {
          throw new DshSessionParseError(`Invalid ${type}.surfaceOp in ${filePath}`);
        }
      }
      if (type === "assistant/message" && event.sourceEventSeqs !== undefined) {
        throw new DshSessionParseError(`DeepSeek Harness v2 assistant/message embeds its source stream and cannot carry sourceEventSeqs in ${filePath}`);
      }
      if (event.sourceEventSeqs !== undefined) {
        if (!Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length === 0) {
          throw new DshSessionParseError(`Invalid ${type}.sourceEventSeqs in ${filePath}`);
        }
        const sources = event.sourceEventSeqs.map((source) => nonNegativeSafeInteger(source, `${type}.sourceEventSeqs entry`));
        if (new Set(sources).size !== sources.length || sources.some((source) => source >= seq)) {
          throw new DshSessionParseError(`Invalid ${type}.sourceEventSeqs provenance in ${filePath}`);
        }
      }
      if (surfaceEligible) {
        const sources = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : [];
        if (event.surfaceOp === "append") {
          surfaceNodes.push(seq);
          surfaceTypes.set(seq, type);
        } else {
          const op = event.surfaceOp as DshRecord;
          const startIndex = surfaceNodes.indexOf(Number(op.start));
          const endIndex = surfaceNodes.indexOf(Number(op.end));
          if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) {
            throw new DshSessionParseError(`Invalid ${type}.surfaceOp range in ${filePath}`);
          }
          const shadowed = surfaceNodes.slice(startIndex, endIndex + 1);
          if (shadowed.some((source) => !sources.includes(source))) {
            throw new DshSessionParseError(`Invalid ${type}.sourceEventSeqs replacement coverage in ${filePath}`);
          }
          if (type === "tool/result" && (shadowed.length !== 1 || surfaceTypes.get(shadowed[0]) !== "tool/result")) {
            throw new DshSessionParseError(`Invalid tool/result replacement target in ${filePath}`);
          }
          if (type === "tool/result") {
            const original = records.find((candidate) => candidate.seq === shadowed[0]);
            if (!original) throw new DshSessionParseError(`Invalid tool/result replacement target in ${filePath}`);
            assertV2ToolResultContentOnly(original, event, filePath);
          }
          surfaceNodes.splice(startIndex, shadowed.length, seq);
          surfaceTypes.set(seq, type);
        }
      }
      if (type === "session/end-seed" && Object.hasOwn(event.data, "inherited") && event.data.inherited !== true) {
        throw new DshSessionParseError(`Invalid session/end-seed.inherited in ${filePath}`);
      }
    }
    expectedSeq += 1;
  }
}

/** Read one DSH raw JSONL or multi-frame Zstd session without mutating it. */
export function parseDshSession(filePath: string, requestedGeneration?: DshSessionGeneration): DshRecord[] {
  const source = readFileSync(filePath);
  const compressed = /\.zstd$/i.test(filePath);
  const content = compressed ? readDshZstdJsonl(source, filePath) : source.toString("utf8");
  const storageRows = parseJsonl(content, filePath, !compressed);
  const headerCandidate = storageRows.find((value) => isRecord(value));
  const headerVersion = isRecord(headerCandidate) && Number.isSafeInteger(headerCandidate.version)
    ? headerCandidate.version : null;
  const pathGeneration = dshGenerationFromPath(filePath);
  if (requestedGeneration !== undefined && pathGeneration !== null && requestedGeneration !== pathGeneration) {
    throw new DshSessionParseError(`Requested DeepSeek Harness generation ${requestedGeneration} disagrees with canonical filename generation ${pathGeneration} in ${filePath}`);
  }
  const generation = requestedGeneration ?? pathGeneration ?? 0;
  if (pathGeneration === null && requestedGeneration === undefined && headerVersion !== null && headerVersion !== 0) {
    throw new DshSessionParseError(`Unsupported DeepSeek Harness session version ${String(headerVersion)} in ${filePath}`);
  }
  if (generation !== 0 && generation !== 1 && generation !== 2 && generation !== 3) {
    throw new DshSessionParseError(`Unsupported DeepSeek Harness session version ${String(headerVersion)} in ${filePath}`);
  }
  const records = storageRows.flatMap((value) => decodeDshStorageRecord(value, generation));
  if (!records.length) throw new DshSessionParseError(`Empty DeepSeek Harness session: ${filePath}`);
  validateDshHeader(records[0], filePath, generation);
  const seedLength = dshHeader(records)?.seedLength;
  if (generation < 2 && seedLength !== undefined && seedLength > records.length - 1) {
    throw new DshSessionParseError(`Invalid session.seedLength ${String(seedLength)} in ${filePath}; exceeds stored event count`);
  }
  if (generation === 3) validateDshV3Events(records.slice(1), filePath);
  else validateDshEvents(records.slice(1), filePath, generation);
  const inheritedMarkers = records.slice(1).filter((candidate) => candidate.type === "session/end-seed" && candidate.data?.inherited === true);
  if (generation >= 2) {
    const seeded = dshHeader(records)?.isSeeded === true;
    if (seeded && inheritedMarkers.length === 0) throw new DshSessionParseError(`Seeded DeepSeek Harness format v${generation} session lacks inherited end-seed marker in ${filePath}`);
    if (!seeded && inheritedMarkers.length > 0) throw new DshSessionParseError(`Unseeded DeepSeek Harness format v${generation} session contains inherited end-seed marker in ${filePath}`);
  }
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

export function dshInheritedEventCount(records: DshRecord[]): number {
  const header = dshHeader(records) || {};
  if (header.version >= 2 || typeof header.isSeeded === "boolean") {
    if (header.isSeeded !== true) return 0;
    const marker = [...records].reverse().find((event) => event.type === "session/end-seed" && event.data?.inherited === true);
    return marker ? nonNegativeSafeInteger(marker.seq, "session/end-seed.seq") : 0;
  }
  return numberOrZero(header.seedLength);
}

/**
 * Omit durable fork history copied into a child session's log.  DSH's
 * `session/end-seed` records an in-process construction/resume boundary and
 * can appear after a session's own older work, so it is deliberately not a
 * durable viewer lineage cutoff.
 */
export function dshOwnedEvents(records: DshRecord[]): DshRecord[] {
  const seedLength = dshInheritedEventCount(records);
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
  const count = (candidate: unknown) => candidate === undefined
    ? undefined
    : Number.isSafeInteger(candidate) && Number(candidate) >= 0 ? Number(candidate) : null;
  const input = count(value.inputTokens);
  const output = count(value.outputTokens);
  const reasoning = count(value.reasoningTokens);
  const cacheRead = count(value.cacheReadTokens);
  const cacheWrite = count(value.cacheWriteTokens);
  if (input === null || output === null || reasoning === null || cacheRead === null || cacheWrite === null
    || input === undefined || output === undefined || (reasoning !== undefined && reasoning > output)) return null;
  const knownPrompt = input + (cacheRead || 0) + (cacheWrite || 0);
  const knownTotal = knownPrompt + output;
  if (!Number.isSafeInteger(knownPrompt) || !Number.isSafeInteger(knownTotal)) return null;
  const reportedTotal = count(value.totalTokens);
  if (reportedTotal === null) return null;
  if (reportedTotal !== undefined) {
    if (reportedTotal < knownTotal
      || (cacheRead !== undefined && cacheWrite !== undefined && reportedTotal !== knownTotal)) return null;
  }
  const total = reportedTotal === undefined ? knownTotal : reportedTotal;
  return {
    input,
    // Upstream packages/llm/llm-deepseek/src/translate.ts maps
    // completion_tokens to outputTokens and keeps reasoningTokens as a
    // reported subset. Shared charts require exclusive components, so retain
    // visible output here and reasoning separately.
    output: Math.max(0, output - (reasoning || 0)),
    reasoning: reasoning || 0,
    total,
    cache: { read: cacheRead || 0, write: cacheWrite || 0 }
  };
}

/** Locate the official usage sample for one assistant settlement or attempt. */
export function dshUsageOf(event: DshRecord): unknown {
  if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return undefined;
  if (event.type === "assistant/message" && event.data?.usage !== undefined) return event.data.usage;
  const stream = Array.isArray(event.data?.stream) ? event.data.stream : [];
  return [...stream].reverse().find((item) => isRecord(item) && item.type === "usage")?.usage;
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
function dshRecordsToMessagesLegacy(records: DshRecord[], sessionId: string): Message[] {
  const messages: Message[] = [];
  const calls = new Map<string, Message>();
  const chunks = new Map<number, DshRecord>();
  for (const event of records) if (event.type === "assistant/chunk") chunks.set(Number(event.seq), event);

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
      let content = source.content;
      if (!Array.isArray(content) && Array.isArray(event.sourceEventSeqs)) {
        let text = ""; let reasoning = "";
        for (const sourceSeq of event.sourceEventSeqs) {
          const chunk = chunks.get(Number(sourceSeq));
          const payload = chunk?.data?.chunk;
          if (payload?.type === "text-delta" && typeof payload.text === "string") text += payload.text;
          if (payload?.type === "reasoning-delta" && typeof payload.text === "string") reasoning += payload.text;
        }
        content = [...(reasoning ? [{ type: "reasoning", text: reasoning }] : []), ...(text ? [{ type: "text", text }] : [])];
      }
      const id = typeof source.id === "string" && source.id ? source.id : `assistant:${event.seq}`;
      const assistant: Message = {
        id,
        sessionId,
        role: "assistant",
        content: dshContentText(content),
        thinking: dshContentThinking(content) || null,
        toolName: null,
        toolInput: null,
        toolOutput: null,
        timestamp: numberOrZero(event.time),
        tokens: dshUsageToTokens(dshUsageOf(event)),
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
      for (const [index, call] of dshToolCallBlocks(content).entries()) {
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

function assistantMessageContent(source: DshRecord): DshRecord[] {
  // The durable assistant message is authoritative. Its embedded stream is
  // replay/usage evidence only and must not fabricate a transcript message.
  return Array.isArray(source.content) ? source.content.filter(isRecord) : [];
}

/** Human transcript projection: replacement copies stay model-only. */
function dshRecordsToMessagesV2AppendOrigin(records: DshRecord[], sessionId: string): Message[] {
  const messages: Message[] = [];
  const calls = new Map<string, Message>();
  const rememberTool = (callId: string, tool: Message, append: boolean) => {
    const existing = calls.get(callId);
    if (existing) {
      if (append && !messages.includes(existing)) messages.push(existing);
      return existing;
    }
    calls.set(callId, tool);
    if (append) messages.push(tool);
    return tool;
  };
  for (const event of dshOwnedEvents(records)) {
    const data = isRecord(event.data) ? event.data : {};
    if (event.type === "user/message" && event.surfaceOp === "append") {
      const source = isRecord(data.source) ? data.source : {};
      const content = dshContentText(data.content);
      if (source.kind !== "user" || !content) continue;
      messages.push({ id: typeof data.id === "string" && data.id ? data.id : `user:${event.seq}`, sessionId, role: "user", content,
        thinking: null, toolName: null, toolInput: null, toolOutput: null, timestamp: numberOrZero(event.time), tokens: null,
        metadata: { sourceSequence: event.seq, provenance: "session" } });
      continue;
    }
    if (event.type === "assistant/message" && event.surfaceOp === "append") {
      const source = isRecord(data.message) ? data.message : {};
      const content = assistantMessageContent(source);
      const text = dshContentText(content);
      const thinking = dshContentThinking(content);
      const toolCalls = dshToolCallBlocks(content);
      if (!text && !thinking && !toolCalls.length) continue;
      const id = typeof source.id === "string" && source.id ? source.id : `assistant:${event.seq}`;
      messages.push({ id, sessionId, role: "assistant", content: text, thinking: thinking || null, toolName: null, toolInput: null, toolOutput: null,
        timestamp: numberOrZero(event.time), tokens: dshUsageToTokens(dshUsageOf(event)), metadata: {
          provider: source.source?.provider || null, model: source.source?.model || null, sourceSequence: event.seq, provenance: "session"
        } });
      for (const [index, call] of toolCalls.entries()) {
        const callId = String(call.id);
        const parsed = dshToolInput(call.arguments);
        rememberTool(callId, createToolMessage({ id: callId || `${id}:tool:${index}`, sessionId, callId, name: String(call.name || "tool"), input: parsed.input,
          rawInput: parsed.raw, timestamp: numberOrZero(event.time), turn: data.turn, step: data.step, sourceSeq: event.seq }), true);
      }
      continue;
    }
    if (event.type === "tool/call") {
      const callId = typeof data.callId === "string" ? data.callId : "";
      const parsed = dshToolInput(data.arguments);
      rememberTool(callId, createToolMessage({ id: callId || `tool-call:${event.seq}`, sessionId, callId, name: typeof data.name === "string" ? data.name : "tool",
        input: parsed.input, rawInput: parsed.raw, timestamp: numberOrZero(event.time), turn: data.turn, step: data.step, sourceSeq: event.seq }), false);
      continue;
    }
    if (event.type === "tool/result" && event.surfaceOp === "append") {
      const source = isRecord(data.message) ? data.message : {};
      const blocks = dshToolResultBlocks(source.content);
      for (const [index, block] of (blocks.length ? blocks : [null]).entries()) {
        const callId = typeof block?.toolCallId === "string" ? block.toolCallId : (typeof source.source?.callId === "string" ? source.source.callId : "");
        const tool = rememberTool(callId, createToolMessage({ id: `tool-result:${event.seq}:${index}`, sessionId, callId, name: "tool", input: null, rawInput: null,
          timestamp: numberOrZero(event.time), turn: data.turn, step: data.step, sourceSeq: event.seq }), true);
        const output = dshContentText(block?.content);
        tool.content = output; tool.toolOutput = output; tool.timestamp = numberOrZero(event.time);
        tool.metadata = { ...tool.metadata, sourceSequence: event.seq, status: block?.isError === true || Boolean(data.error) ? "error" : "completed",
          isError: block?.isError === true || Boolean(data.error), error: data.error || null, resultMeta: data.meta || null };
      }
    }
  }
  return messages;
}

export function dshRecordsToMessages(records: DshRecord[], sessionId: string): Message[] {
  return (dshHeader(records)?.version || 0) >= 2 ? dshRecordsToMessagesV2AppendOrigin(records, sessionId) : dshRecordsToMessagesLegacy(records, sessionId);
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
  const tokenCount = dshUsageRecords(records).reduce((total, event) => total + (dshUsageToTokens(dshUsageOf(event))?.total || 0), 0);
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
      isSeeded: header.isSeeded === true,
      seedLength: Number(header.version) >= 2 ? null : numberOrZero(header.seedLength),
      inheritedEventCount: dshInheritedEventCount(records),
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

export function dshUsageRecords(records: DshRecord[]) {
  const version = Number(dshHeader(records)?.version);
  if (version !== 2 && version !== 3) {
    return dshOwnedEvents(records).filter((event) => event.type === "assistant/message" && (dshUsageToTokens(dshUsageOf(event))?.total || 0) > 0);
  }
  const selected: DshRecord[] = [];
  const slots = new Map<string, number>();
  for (const event of dshOwnedEvents(records)) {
    if (event.type === "llm/retry-started") {
      const key = `${String(event.data?.turn)}:${String(event.data?.step)}`;
      slots.delete(key);
      continue;
    }
    if (event.type !== "assistant/message" && event.type !== "assistant/attempt") continue;
    if (dshUsageToTokens(dshUsageOf(event)) === null) continue;
    const key = `${String(event.data?.turn)}:${String(event.data?.step)}`;
    const previous = slots.get(key);
    if (previous === undefined) {
      slots.set(key, selected.length);
      selected.push(event);
    } else {
      selected[previous] = event;
    }
  }
  return selected;
}

/** Native v3 keeps zero-token legacy assistant settlements as recorded requests. */
export function dshNativeUsageRecords(records: DshRecord[]) {
  const version = Number(dshHeader(records)?.version);
  if (version === 2 || version === 3) return dshUsageRecords(records);
  return dshOwnedEvents(records).filter((event) => event.type === "assistant/message" && dshUsageToTokens(dshUsageOf(event)) !== null);
}

/** Backward-compatible name for callers that consume the unified usage fold. */
export function dshAssistantUsageRecords(records: DshRecord[]) {
  return dshUsageRecords(records);
}

export function dshStoredSystemPrompt(records: DshRecord[]): { content: string; source: string; title: string } | null {
  const header = dshHeader(records);
  if (header?.version === 3) {
    const surface: DshRecord[] = [];
    const surfaceTypes = new Set(["system/message", "user/message", "assistant/message", "tool/result"]);
    for (const event of records.slice(1)) {
      if (!surfaceTypes.has(event.type) || event.surfaceOp === undefined) continue;
      if (event.surfaceOp === "append") {
        surface.push(event);
        continue;
      }
      const op = event.surfaceOp;
      if (!isRecord(op)) continue;
      const start = surface.findIndex((candidate) => candidate.seq === op.startSeq);
      const end = surface.findIndex((candidate) => candidate.seq === op.endSeq);
      if (start >= 0 && end >= start) surface.splice(start, end - start + 1, event);
    }
    const heads = surface.filter((event) => event.type === "system/message" && isRecord(event.data?.message));
    const parts = heads.map((event) => dshContentText(event.data.message.content)).filter((content) => content.length > 0);
    if (parts.length === 0) return null;
    return {
      content: parts.join("\n\n"),
      source: `dsh.system/message:${heads.map((event) => String(event.seq)).join(",")}`,
      title: "Persisted DSH system prompt"
    };
  }
  const requestHeader = latestEvent(records, "request/header");
  const content = requestHeader?.data?.header?.system;
  if (typeof content !== "string" || !content.trim()) return null;
  return {
    content,
    source: `dsh.request/header:${String(requestHeader?.seq)}`,
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
