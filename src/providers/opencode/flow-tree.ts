import { buildOpenCodeSessionContainer, type MessageContainer, type PartContainer, type SessionContainer } from "./session-container.js";
import { buildOpenCodeSessionMetrics, type SessionMetricsView } from "./session-metrics.js";

export interface FlowNode {
  id: string;
  kind: "session" | "message" | "tool" | "subagent" | "part";
  label: string;
  meta: string;
  status: string | null;
  timeStart: number;
  timeEnd: number;
  duration: number;
  cost: number;
  tokens: number;
  children: FlowNode[];
}

export interface FlowTree {
  sessionId: string;
  root: FlowNode;
  summary: {
    totalNodes: number;
    sessions: number;
    messages: number;
    tools: number;
    subagents: number;
    totalDuration: number;
    totalCost: number;
    totalTokens: number;
  };
}

function asNumber(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function compact(value: unknown, fallback = "") {
  if (typeof value === "string" && value.trim()) {
    const text = value.trim().replace(/\s+/g, " ");
    return text.length > 96 ? `${text.slice(0, 95)}…` : text;
  }
  return fallback;
}

function stepByMessage(metrics: SessionMetricsView | null) {
  const map = new Map<string, SessionMetricsView["steps"][number][]>();
  for (const step of metrics?.steps || []) {
    const items = map.get(step.messageId) || [];
    items.push(step);
    map.set(step.messageId, items);
  }
  return map;
}

function messageNode(message: MessageContainer, children: FlowNode[], steps: SessionMetricsView["steps"][number][] = []): FlowNode {
  const stepTokens = steps.reduce((sum, step) => sum + asNumber(step.totalTokens), 0);
  const stepCost = steps.reduce((sum, step) => sum + asNumber(step.cost), 0);
  const stepDuration = steps.reduce((sum, step) => sum + asNumber(step.duration), 0);

  return {
    id: `msg:${message.id}`,
    kind: "message",
    label: message.title || `${message.role} message`,
    meta: steps.length ? `${steps.length} steps` : message.role,
    status: message.role,
    timeStart: message.timeCreated,
    timeEnd: message.timeCreated + stepDuration,
    duration: stepDuration,
    cost: stepCost,
    tokens: stepTokens,
    children
  };
}

function partNode(part: PartContainer): FlowNode {
  const isSubagent = part.partType === "tool" && ["task", "subtask"].includes(String(part.tool || ""));
  const childSessions = part.childSessions.map((child) => sessionNode(child));
  return {
    id: `part:${part.id}`,
    kind: isSubagent ? "subagent" : part.partType === "tool" ? "tool" : "part",
    label: part.title || part.tool || part.partType,
    meta: childSessions.length ? `${childSessions.length} branches` : (part.tool || part.partType),
    status: typeof part.data?.state?.status === "string" ? part.data.state.status : null,
    timeStart: part.timeStart,
    timeEnd: part.timeEnd,
    duration: part.timeStart && part.timeEnd ? Math.max(0, part.timeEnd - part.timeStart) : 0,
    cost: 0,
    tokens: 0,
    children: childSessions
  };
}

function sessionNode(container: SessionContainer, metrics: SessionMetricsView | null = null): FlowNode {
  const stepsByMessage = stepByMessage(metrics);
  const children: FlowNode[] = [];

  for (const message of container.messages) {
    const partChildren = message.parts.map(partNode);
    children.push(messageNode(message, partChildren, stepsByMessage.get(message.id) || []));
  }

  for (const child of container.detachedChildren) {
    children.push(sessionNode(child));
  }

  return {
    id: `session:${container.id}`,
    kind: "session",
    label: container.title,
    meta: container.attachMode === "root" ? "root" : container.attachMode,
    status: null,
    timeStart: container.metrics.timeStart,
    timeEnd: container.metrics.timeEnd,
    duration: container.metrics.runtimeMs,
    cost: container.metrics.cost,
    tokens: container.metrics.inputTokens + container.metrics.outputTokens + container.metrics.reasoningTokens,
    children
  };
}

function summarize(node: FlowNode, acc = {
  totalNodes: 0,
  sessions: 0,
  messages: 0,
  tools: 0,
  subagents: 0,
  totalDuration: 0,
  totalCost: 0,
  totalTokens: 0
}) {
  acc.totalNodes += 1;
  if (node.kind === "session") acc.sessions += 1;
  if (node.kind === "message") acc.messages += 1;
  if (node.kind === "tool") acc.tools += 1;
  if (node.kind === "subagent") acc.subagents += 1;
  acc.totalDuration += asNumber(node.duration);
  acc.totalCost += asNumber(node.cost);
  acc.totalTokens += asNumber(node.tokens);
  for (const child of node.children) summarize(child, acc);
  return acc;
}

export function buildOpenCodeFlowTree(sessionId: string, dbPath = undefined): FlowTree | null {
  const container = buildOpenCodeSessionContainer(sessionId, dbPath);
  if (!container) {
    return null;
  }

  const metrics = buildOpenCodeSessionMetrics(sessionId, dbPath);
  const root = sessionNode(container, metrics);
  return {
    sessionId,
    root,
    summary: summarize(root)
  };
}
