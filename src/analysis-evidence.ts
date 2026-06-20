import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Message, ProviderAdapter } from "./providers/interface.js";
import { buildMessageSessionViews } from "./providers/shared/message-session.js";

type Row = Record<string, any>;

export interface AnalysisEvidenceRecord {
  schemaVersion: 1;
  evidenceId: string;
  provider: string;
  kind: "session" | "system-prompt" | "message" | "tool" | "text" | "reasoning" | "patch" | "part";
  sessionId: string;
  parentSessionId: string | null;
  messageId: string | null;
  partId: string | null;
  role: string | null;
  toolName: string | null;
  status: string | null;
  timestamp: number;
  timeEnd: number;
  sequence: number;
  preview: string;
  errorReason: string | null;
  raw: unknown;
}

export interface AnalysisEvidenceIndexEntry extends Omit<AnalysisEvidenceRecord, "raw"> {
  offset: number;
  byteLength: number;
}

function asObject(value: unknown): Row {
  return value && typeof value === "object" ? value as Row : {};
}

function asNumber(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function compact(value: unknown, limit = 500) {
  if (value == null) {
    return "";
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function evidenceSegment(value: unknown) {
  return encodeURIComponent(String(value || "unknown"));
}

export function makeEvidenceId(
  providerId: string,
  sessionId: string,
  kind: string,
  sourceId: string
) {
  return [
    "ev",
    evidenceSegment(providerId),
    evidenceSegment(sessionId),
    evidenceSegment(kind),
    evidenceSegment(sourceId)
  ].join(":");
}

function messagePreview(message: Row) {
  const text = (message.parts || [])
    .filter((part) => part?.partType === "text" && part?.data?.text)
    .map((part) => part.data.text)
    .join("\n");
  return compact(text || message.title || message.data?.summary || `${message.role || "unknown"} message`);
}

function partPreview(part: Row) {
  const data = asObject(part.data);
  if (part.partType === "text" || part.partType === "reasoning") {
    return compact(data.text || part.title);
  }
  if (part.partType === "patch") {
    return compact(data);
  }
  if (part.partType === "tool") {
    return compact(
      data.state?.title
      || data.state?.error
      || data.error
      || data.state?.output
      || data.state?.input
      || part.title
      || part.tool
    );
  }
  return compact(part.title || data);
}

function partKind(part: Row): AnalysisEvidenceRecord["kind"] {
  if (part.partType === "tool") return "tool";
  if (part.partType === "text") return "text";
  if (part.partType === "reasoning") return "reasoning";
  if (part.partType === "patch") return "patch";
  return "part";
}

function partStatus(part: Row) {
  const data = asObject(part.data);
  if (typeof data.state?.status === "string") {
    return data.state.status;
  }
  return data.state?.error || data.error ? "error" : null;
}

function partErrorReason(part: Row) {
  const data = asObject(part.data);
  const status = partStatus(part);
  const reason = data.state?.error
    ?? data.error
    ?? (status === "error" ? data.state?.output : null);
  return reason == null ? null : compact(reason, 1000);
}

function resolveSessionContainer(
  provider: ProviderAdapter,
  session: Row,
  sessionId: string,
  messages: Message[]
) {
  const container = provider.getSessionContainer?.(sessionId);
  if (container && typeof container === "object") {
    return container as Row;
  }
  return buildMessageSessionViews(session, messages).container as Row;
}

function writeJson(filePath: string, value: unknown) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export function writeAnalysisEvidence({
  provider,
  session,
  sessionId,
  messages,
  runDir,
  files = null
}: {
  provider: ProviderAdapter;
  session: Row;
  sessionId: string;
  messages: Message[];
  runDir: string;
  files?: {
    evidencePath: string;
    evidenceIndexPath: string;
    sessionIndexPath: string;
  } | null;
}) {
  const container = resolveSessionContainer(provider, session, sessionId, messages);
  const records: AnalysisEvidenceRecord[] = [];
  const sessions: Row[] = [];
  const seenSessions = new Set<string>();
  let sequence = 0;

  const addRecord = (
    record: Omit<AnalysisEvidenceRecord, "schemaVersion" | "provider" | "sequence">
  ) => {
    const complete: AnalysisEvidenceRecord = {
      schemaVersion: 1,
      provider: provider.id,
      sequence: sequence++,
      ...record
    };
    records.push(complete);
    return complete.evidenceId;
  };

  const systemPrompts = provider.getSystemPrompts?.(sessionId);
  if (systemPrompts && typeof systemPrompts === "object") {
    const promptView = systemPrompts as Row;
    for (const [sectionIndex, section] of (promptView.sections || []).entries()) {
      for (const [itemIndex, promptItem] of (section.items || []).entries()) {
        const sourceId = `${sectionIndex}:${itemIndex}:${promptItem.source || promptItem.title || "prompt"}`;
        addRecord({
          evidenceId: makeEvidenceId(provider.id, sessionId, "system-prompt", sourceId),
          kind: "system-prompt",
          sessionId,
          parentSessionId: null,
          messageId: null,
          partId: null,
          role: "system",
          toolName: null,
          status: null,
          timestamp: asNumber(promptItem.time),
          timeEnd: asNumber(promptItem.time),
          preview: compact(promptItem.preview || promptItem.title),
          errorReason: null,
          raw: {
            section: section.title || "",
            sectionNote: section.note || "",
            ...promptItem
          }
        });
      }
    }
  }

  const visitSession = (
    current: Row,
    parentSessionId: string | null,
    attachedByEvidenceId: string | null,
    attachMode: string
  ): Row | null => {
    const currentId = String(current.id || current.session?.id || "");
    if (!currentId || seenSessions.has(currentId)) {
      return null;
    }
    seenSessions.add(currentId);

    const sessionEvidenceId = makeEvidenceId(provider.id, currentId, "session", currentId);
    addRecord({
      evidenceId: sessionEvidenceId,
      kind: "session",
      sessionId: currentId,
      parentSessionId,
      messageId: null,
      partId: null,
      role: null,
      toolName: null,
      status: null,
      timestamp: asNumber(current.metrics?.timeStart || current.session?.time_created),
      timeEnd: asNumber(current.metrics?.timeEnd || current.session?.time_updated),
      preview: compact(current.title || current.session?.title || currentId),
      errorReason: null,
      raw: current.session || current
    });

    const sessionSummary: Row = {
      sessionId: currentId,
      evidenceId: sessionEvidenceId,
      parentSessionId,
      attachedByEvidenceId,
      attachMode,
      depth: asNumber(current.depth),
      title: current.title || current.session?.title || currentId,
      metrics: current.metrics || null,
      direct: {
        messages: 0,
        toolCalls: 0,
        errors: 0,
        completedToolCalls: 0,
        errorRate: 0
      },
      children: []
    };
    sessions.push(sessionSummary);

    for (const message of current.messages || []) {
      const messageId = String(message.id || `${currentId}:message:${sessionSummary.direct.messages}`);
      const role = String(message.role || "unknown");
      const messageKind = role.toLowerCase() === "system" ? "system-prompt" : "message";
      const messageEvidenceId = makeEvidenceId(provider.id, currentId, messageKind, messageId);
      addRecord({
        evidenceId: messageEvidenceId,
        kind: messageKind,
        sessionId: currentId,
        parentSessionId,
        messageId,
        partId: null,
        role,
        toolName: null,
        status: null,
        timestamp: asNumber(message.timeCreated),
        timeEnd: asNumber(message.timeCreated),
        preview: messagePreview(message),
        errorReason: null,
        raw: message.data || message
      });
      sessionSummary.direct.messages += 1;

      for (const part of message.parts || []) {
        const partId = String(part.id || `${messageId}:part`);
        const kind = partKind(part);
        const status = partStatus(part);
        const partEvidenceId = makeEvidenceId(provider.id, currentId, kind, partId);
        addRecord({
          evidenceId: partEvidenceId,
          kind,
          sessionId: currentId,
          parentSessionId,
          messageId,
          partId,
          role,
          toolName: typeof part.tool === "string" ? part.tool : null,
          status,
          timestamp: asNumber(part.timeStart || message.timeCreated),
          timeEnd: asNumber(part.timeEnd || part.timeStart || message.timeCreated),
          preview: partPreview(part),
          errorReason: partErrorReason(part),
          raw: part.data || part
        });

        if (kind === "tool") {
          sessionSummary.direct.toolCalls += 1;
          if (status === "error") {
            sessionSummary.direct.errors += 1;
          } else if (status === "completed") {
            sessionSummary.direct.completedToolCalls += 1;
          }
        }

        for (const child of part.childSessions || []) {
          const childSummary = visitSession(child, currentId, partEvidenceId, "task");
          if (childSummary) {
            sessionSummary.children.push(childSummary);
          }
        }
      }
    }

    for (const child of current.detachedChildren || []) {
      const childSummary = visitSession(child, currentId, null, "detached");
      if (childSummary) {
        sessionSummary.children.push(childSummary);
      }
    }

    sessionSummary.direct.errorRate = sessionSummary.direct.toolCalls
      ? sessionSummary.direct.errors / sessionSummary.direct.toolCalls
      : 0;
    return sessionSummary;
  };

  const tree = visitSession(container, null, null, "root");
  const dataPath = files?.evidencePath || path.join(runDir, "evidence.jsonl");
  const indexPath = files?.evidenceIndexPath || path.join(runDir, "evidence-index.json");
  const sessionIndexPath = files?.sessionIndexPath || path.join(runDir, "session-index.json");
  mkdirSync(path.dirname(dataPath), { recursive: true });
  mkdirSync(path.dirname(indexPath), { recursive: true });
  mkdirSync(path.dirname(sessionIndexPath), { recursive: true });
  const chunks: Buffer[] = [];
  const entries: AnalysisEvidenceIndexEntry[] = [];
  let offset = 0;

  for (const record of records) {
    const content = Buffer.from(JSON.stringify(record), "utf-8");
    const newline = Buffer.from("\n");
    const { raw: _raw, ...metadata } = record;
    entries.push({
      ...metadata,
      offset,
      byteLength: content.length
    });
    chunks.push(content, newline);
    offset += content.length + newline.length;
  }
  writeFileSync(dataPath, Buffer.concat(chunks));

  const evidenceIndex = {
    schemaVersion: 1,
    provider: provider.id,
    rootSessionId: sessionId,
    dataFile: path.basename(dataPath),
    encoding: "utf-8",
    recordCount: entries.length,
    entries
  };
  const sessionIndex = {
    schemaVersion: 1,
    provider: provider.id,
    rootSessionId: sessionId,
    sessionCount: sessions.length,
    tree,
    sessions
  };
  writeJson(indexPath, evidenceIndex);
  writeJson(sessionIndexPath, sessionIndex);

  return {
    dataPath,
    indexPath,
    sessionIndexPath,
    evidenceIndex,
    sessionIndex,
    rootEvidenceId: tree?.evidenceId || makeEvidenceId(provider.id, sessionId, "session", sessionId)
  };
}
