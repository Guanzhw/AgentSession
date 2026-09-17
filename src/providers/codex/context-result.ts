import type {
  ContextChangeAttachment,
  ContextChangeContentField,
  ContextChangeResult,
  ContextChangeRetainedEntry,
  ContextChangeRetainedGroup
} from "../interface.js";
import { codexCompactionEventId, codexCompactionEvents } from "./protocol.js";

type Row = Record<string, any>;

const HISTORY_GROUPS = [
  { field: "replacement_history", label: "replacement" },
  { field: "guardian_history", label: "guardian" }
] as const;

const DISPLAY_KEYS = new Set([
  "type", "kind", "role", "id", "call_id", "name", "tool_name",
  "message", "text", "summary", "reasoning", "reasoning_text",
  "content", "output", "tool_output", "toolOutput", "input", "arguments"
]);
const STRUCTURED_CONTENT_KEYS = new Set([
  "content", "output", "tool_output", "toolOutput", "input", "arguments"
]);
const TEXT_BLOCK_TYPES = new Set(["text", "input_text", "output_text", "summary_text"]);

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEncryptedKey(key: string) {
  return key === "encrypted_content";
}

function childPath(parent: string, key: string | number) {
  return typeof key === "number" ? `${parent}[${key}]` : parent ? `${parent}.${key}` : key;
}

function encryptedFieldPaths(value: unknown, path: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => encryptedFieldPaths(entry, childPath(path, index)));
  }
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => (
    isEncryptedKey(key)
      ? [childPath(path, key)]
      : encryptedFieldPaths(entry, childPath(path, key))
  ));
}

function isInputImageBlock(value: unknown): value is Row {
  return isObject(value) && value.type === "input_image" && typeof value.image_url === "string";
}

function imageAttachments(value: unknown, path: string, structured = true): ContextChangeAttachment[] {
  if (isInputImageBlock(value)) {
    if (!structured) return [];
    return [{ kind: "image", sourcePath: path, contentAccess: "metadata-only" }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => imageAttachments(entry, childPath(path, index), structured));
  }
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    if (isEncryptedKey(key)) return [];
    const nextPath = childPath(path, key);
    return imageAttachments(entry, nextPath, structured || STRUCTURED_CONTENT_KEYS.has(key));
  });
}

function appendReadableFields(value: unknown, path: string, fields: ContextChangeContentField[], structured = false) {
  if (structured && isInputImageBlock(value)) return;
  if (typeof value === "string") {
    if (path) fields.push({ label: path, value });
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    if (path) fields.push({ label: path, value: String(value) });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => appendReadableFields(entry, childPath(path, index), fields, structured));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (isEncryptedKey(key) || (!structured && !DISPLAY_KEYS.has(key))) continue;
    const nextPath = childPath(path, key);
    appendReadableFields(entry, nextPath, fields, structured || STRUCTURED_CONTENT_KEYS.has(key));
  }
}

function entryKind(value: Row, fields: ContextChangeContentField[]): ContextChangeRetainedEntry["kind"] {
  const type = String(value.type || value.kind || "").toLowerCase();
  if (["reasoning", "agent_reasoning"].includes(type)) {
    return "reasoning";
  }
  if (["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(type)) {
    return "tool";
  }
  if (["message", "user_message", "agent_message"].includes(type)) {
    return "message";
  }
  return fields.length ? "text" : "other";
}

function entryContent(fields: ContextChangeContentField[]) {
  const content = fields
    .filter((field) => {
      const rootMetadata = /^(?:id|type|kind|role|name|call_id|tool_name)$/;
      const contentItemMetadata = /^(?:content|summary)(?:\[\d+\])?\.(?:id|type|kind|role)$/;
      const typedOutputBlock = /^(?:content|output|tool_output|toolOutput|input|arguments)\[\d+\]\.type$/;
      const isTypedOutputBlock = typedOutputBlock.test(field.label) && TEXT_BLOCK_TYPES.has(field.value);
      return !rootMetadata.test(field.label)
        && !contentItemMetadata.test(field.label)
        && !isTypedOutputBlock;
    })
    .map((field) => field.value);
  return content.join("\n");
}

function normalizeEntry(value: unknown, path: string, sourceOrdinal: number): ContextChangeRetainedEntry {
  const fields: ContextChangeContentField[] = [];
  const attachments = imageAttachments(value, path, false);
  appendReadableFields(isObject(value) ? value : { content: value }, "", fields);
  const omittedEncryptedFieldPaths = encryptedFieldPaths(value, path);
  const objectValue = isObject(value) ? value : {};
  return {
    sourceOrdinal,
    sourceOrdinalProvenance: "source-order/derived",
    kind: entryKind(objectValue, fields),
    role: typeof objectValue.role === "string" ? objectValue.role : null,
    fields,
    content: entryContent(fields),
    attachments,
    omittedEncryptedFieldPaths,
    omittedEncryptedFieldCount: omittedEncryptedFieldPaths.length
  };
}

function sourceOf(record: Row) {
  return isObject(record.payload) ? record.payload : record;
}

function historyFor(compaction: { records?: Row[]; record: Row }, field: string) {
  let present = false;
  let fallback: unknown = null;
  for (const record of compaction.records || [compaction.record]) {
    const source = sourceOf(record);
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      present = true;
      fallback = fallback ?? source[field];
      if (Array.isArray(source[field]) && source[field].length) return { present: true, value: source[field] };
    }
    if (source !== record && Object.prototype.hasOwnProperty.call(record, field)) {
      present = true;
      fallback = fallback ?? record[field];
      if (Array.isArray(record[field]) && record[field].length) return { present: true, value: record[field] };
    }
  }
  return { present, value: fallback };
}

function normalizeGroups(compaction: { records?: Row[]; record: Row }) {
  const omittedEncryptedFieldPaths: string[] = [];
  const groups: ContextChangeRetainedGroup[] = [];
  for (const groupSpec of HISTORY_GROUPS) {
    const history = historyFor(compaction, groupSpec.field);
    if (!history.present) continue;
    const entries = Array.isArray(history.value) ? history.value : [];
    const normalizedEntries = entries.map((entry, index) => {
      const normalized = normalizeEntry(entry, `${groupSpec.field}[${index}]`, index);
      omittedEncryptedFieldPaths.push(...normalized.omittedEncryptedFieldPaths);
      return normalized;
    });
    groups.push({ label: groupSpec.label, entries: normalizedEntries });
  }
  return { groups, omittedEncryptedFieldPaths };
}

function summaryFor(compaction: { records?: Row[]; record: Row }) {
  let recorded = false;
  let empty = false;
  for (const record of compaction.records || [compaction.record]) {
    const source = sourceOf(record);
    for (const key of ["summary", "message", "summary_text"]) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      recorded = true;
      const value = source[key];
      if (typeof value === "string" && value.length > 0) return { value, availability: "readable" as const };
      if (value === "") empty = true;
    }
  }
  return recorded && empty
    ? { value: "", availability: "recorded-empty" as const }
    : { value: null, availability: "not-recorded" as const };
}

function sourceEvidence(compaction: { records?: Row[]; record: Row; sourceId?: string | null; recordIndices?: number[] }) {
  const records = compaction.records || [compaction.record];
  const sourceTypes = [...new Set(records.map((record) => `codex.${String(record.type || "record")}`))];
  const sourceIds = records
    .map((record) => sourceOf(record))
    .map((source) => source.id || source.compaction_id || null)
    .filter((value): value is string | number => value != null && String(value) !== "")
    .map(String);
  return {
    fidelity: "recorded" as const,
    sourceType: sourceTypes.join("+") || "codex.record",
    sourceId: sourceIds[0] || compaction.sourceId || null,
    sourceOrdinal: compaction.recordIndices?.[0] ?? null,
    sourceOrdinalProvenance: "source-order/derived" as const
  };
}

/** Normalize one owned Codex compaction into the on-demand reader contract. */
export function normalizeCodexContextChangeResult(records: Row[], checkpointId: string): ContextChangeResult | null {
  const compaction = codexCompactionEvents(records).find((candidate) => codexCompactionEventId(candidate) === checkpointId);
  if (!compaction) return null;
  const { groups, omittedEncryptedFieldPaths } = normalizeGroups(compaction);
  return {
    checkpointId,
    source: sourceEvidence(compaction),
    summary: summaryFor(compaction),
    groups,
    omitted: {
      encryptedFieldPaths: omittedEncryptedFieldPaths,
      encryptedFieldCount: omittedEncryptedFieldPaths.length
    }
  };
}
