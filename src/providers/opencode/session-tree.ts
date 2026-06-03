import { getChildSessions, getMessages, getParts, getSession } from "../../db.js";
import { parseJson } from "./parser.js";

type Row = Record<string, any>;

export interface SessionPartNode {
  id: string;
  messageId: string;
  sessionId: string;
  type: string;
  tool: string | null;
  data: Row;
  timeStart: number;
  timeEnd: number;
  childSessions: SessionTree[];
}

export interface SessionMessageNode {
  id: string;
  sessionId: string;
  role: string;
  data: Row;
  timeCreated: number;
  parts: SessionPartNode[];
}

export interface SessionTreeMetrics {
  messageCount: number;
  partCount: number;
  toolCallCount: number;
  directChildCount: number;
  descendantCount: number;
  totalMessages: number;
  totalToolCalls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  timeStart: number;
  timeEnd: number;
  runtimeMs: number;
}

export interface SessionTree {
  session: Row;
  messages: SessionMessageNode[];
  detachedChildren: SessionTree[];
  metrics: SessionTreeMetrics;
}

function asObject(value: unknown): Row {
  return value && typeof value === "object" ? value as Row : {};
}

function asNumber(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function readTimeStart(data: Row): number {
  return asNumber(data.state?.time?.start) || asNumber(data.time?.start);
}

function readTimeEnd(data: Row): number {
  return asNumber(data.state?.time?.end) || asNumber(data.time?.end);
}

function extractTaskSessionIds(data: Row): string[] {
  if (data.type !== "tool" || !["task", "subtask"].includes(data.tool)) {
    return [];
  }

  const ids = new Set<string>();
  const metadataSessionId = data.state?.metadata?.sessionId;
  if (typeof metadataSessionId === "string" && metadataSessionId) {
    ids.add(metadataSessionId);
  }

  const output = data.state?.output;
  const outputText = typeof output === "string" ? output : "";
  for (const match of outputText.matchAll(/\btask_id:\s*(ses_[A-Za-z0-9]+)/g)) {
    ids.add(match[1]);
  }

  return [...ids];
}

function calculateMetrics(session: Row, messages: SessionMessageNode[], detachedChildren: SessionTree[]): SessionTreeMetrics {
  const childSessions = [
    ...messages.flatMap((message) => message.parts.flatMap((part) => part.childSessions)),
    ...detachedChildren
  ];
  const directPartCount = messages.reduce((sum, message) => sum + message.parts.length, 0);
  const directToolCount = messages.reduce(
    (sum, message) => sum + message.parts.filter((part) => part.type === "tool").length,
    0
  );
  const childMetrics = childSessions.map((child) => child.metrics);
  const descendantCount = childSessions.length + childMetrics.reduce((sum, metrics) => sum + metrics.descendantCount, 0);
  const totalMessages = messages.length + childMetrics.reduce((sum, metrics) => sum + metrics.totalMessages, 0);
  const totalToolCalls = directToolCount + childMetrics.reduce((sum, metrics) => sum + metrics.totalToolCalls, 0);

  const times = [
    asNumber(session.time_created),
    asNumber(session.time_updated),
    ...messages.map((message) => message.timeCreated),
    ...messages.flatMap((message) => message.parts.flatMap((part) => [part.timeStart, part.timeEnd])),
    ...childMetrics.flatMap((metrics) => [metrics.timeStart, metrics.timeEnd])
  ].filter(Boolean);
  const timeStart = times.length ? Math.min(...times) : 0;
  const timeEnd = times.length ? Math.max(...times) : 0;

  return {
    messageCount: messages.length,
    partCount: directPartCount,
    toolCallCount: directToolCount,
    directChildCount: childSessions.length,
    descendantCount,
    totalMessages,
    totalToolCalls,
    inputTokens: asNumber(session.tokens_input) + childMetrics.reduce((sum, metrics) => sum + metrics.inputTokens, 0),
    outputTokens: asNumber(session.tokens_output) + childMetrics.reduce((sum, metrics) => sum + metrics.outputTokens, 0),
    reasoningTokens: asNumber(session.tokens_reasoning) + childMetrics.reduce((sum, metrics) => sum + metrics.reasoningTokens, 0),
    cacheReadTokens: asNumber(session.tokens_cache_read) + childMetrics.reduce((sum, metrics) => sum + metrics.cacheReadTokens, 0),
    cacheWriteTokens: asNumber(session.tokens_cache_write) + childMetrics.reduce((sum, metrics) => sum + metrics.cacheWriteTokens, 0),
    cost: asNumber(session.cost) + childMetrics.reduce((sum, metrics) => sum + metrics.cost, 0),
    timeStart,
    timeEnd,
    runtimeMs: timeStart && timeEnd ? Math.max(0, timeEnd - timeStart) : 0
  };
}

export function buildOpenCodeSessionTree(sessionId: string, dbPath = undefined, seen = new Set<string>()): SessionTree | null {
  if (seen.has(sessionId)) {
    return null;
  }

  const session = getSession(sessionId, dbPath);
  if (!session) {
    return null;
  }

  const nextSeen = new Set(seen);
  nextSeen.add(sessionId);

  const childRows = getChildSessions(sessionId, dbPath);
  const childrenById = new Map<string, SessionTree>();
  for (const child of childRows) {
    const childTree = buildOpenCodeSessionTree(child.id, dbPath, nextSeen);
    if (childTree) {
      childrenById.set(child.id, childTree);
    }
  }

  const attachedChildIds = new Set<string>();
  const messages: SessionMessageNode[] = getMessages(sessionId, dbPath).map((message) => {
    const messageData = asObject(typeof message.data === "string" ? parseJson(message.data) : message.data);
    const parts: SessionPartNode[] = getParts(message.id, dbPath).map((part) => {
      const partData = asObject(typeof part.data === "string" ? parseJson(part.data) : part.data);
      const childSessions = extractTaskSessionIds(partData)
        .map((id) => childrenById.get(id))
        .filter(Boolean) as SessionTree[];
      childSessions.forEach((child) => attachedChildIds.add(child.session.id));

      return {
        id: part.id,
        messageId: message.id,
        sessionId,
        type: String(partData.type || "unknown"),
        tool: typeof partData.tool === "string" ? partData.tool : null,
        data: partData,
        timeStart: readTimeStart(partData),
        timeEnd: readTimeEnd(partData),
        childSessions
      };
    });

    return {
      id: message.id,
      sessionId,
      role: String(messageData.role || "unknown"),
      data: messageData,
      timeCreated: asNumber(messageData.time?.created) || asNumber(message.time_created),
      parts
    };
  });

  const detachedChildren = [...childrenById.values()]
    .filter((child) => !attachedChildIds.has(child.session.id))
    .sort((a, b) => asNumber(a.session.time_created) - asNumber(b.session.time_created));

  return {
    session,
    messages,
    detachedChildren,
    metrics: calculateMetrics(session, messages, detachedChildren)
  };
}
