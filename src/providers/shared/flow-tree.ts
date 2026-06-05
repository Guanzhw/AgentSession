import type { MessageContainer, PartContainer, SessionContainer } from "./session-container.js";
import type { SessionMetricsView } from "./session-metrics.js";

export interface FlowNode {
  id: string;
  kind: "session" | "message" | "subagent";
  label: string;
  meta: string;
  status: string | null;
  timeStart: number;
  timeEnd: number;
  duration: number;
  cost: number;
  tokens: number;
  toolCalls: number;
  errors: number;
  subagents: number;
  errorRate: number;
  children: FlowNode[];
}

export interface FlowTree {
  sessionId: string;
  root: FlowNode;
  summary: {
    totalNodes: number;
    sessions: number;
    messages: number;
    toolCalls: number;
    subagents: number;
    errors: number;
    errorRate: number;
    totalDuration: number;
    totalCost: number;
    totalTokens: number;
  };
}

function asNumber(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
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

function partStatus(part: PartContainer) {
  return typeof part.data?.state?.status === "string" ? part.data.state.status : null;
}

function isErrorPart(part: PartContainer) {
  return partStatus(part) === "error" || Boolean(part.data?.error);
}

function isTaskPart(part: PartContainer) {
  return part.partType === "tool" && ["task", "subtask"].includes(String(part.tool || ""));
}

function toolParts(message: MessageContainer) {
  return message.parts.filter((part) => part.partType === "tool");
}

function aggregate(node: FlowNode) {
  for (const child of node.children) {
    node.toolCalls += child.toolCalls;
    node.errors += child.errors;
    node.subagents += child.kind === "subagent" ? 1 + child.subagents : child.subagents;
  }
  node.errorRate = node.toolCalls ? node.errors / node.toolCalls : 0;
  return node;
}

function messageNode(message: MessageContainer, children: FlowNode[], steps: SessionMetricsView["steps"][number][] = []): FlowNode | null {
  const tools = toolParts(message);
  if (!steps.length && !tools.length && !children.length) {
    return null;
  }

  const stepTokens = steps.reduce((sum, step) => sum + asNumber(step.totalTokens), 0);
  const stepCost = steps.reduce((sum, step) => sum + asNumber(step.cost), 0);
  const stepDuration = steps.reduce((sum, step) => sum + asNumber(step.duration), 0);
  const errors = tools.filter(isErrorPart).length;
  const status = errors ? "has errors" : steps.some((step) => step.reason === "tool-calls") ? "tool calls" : steps[steps.length - 1]?.reason || null;

  return aggregate({
    id: `msg:${message.id}`,
    kind: "message",
    label: message.title || `${message.role} message`,
    meta: [
      steps.length ? `${steps.length} model ${steps.length === 1 ? "pass" : "passes"}` : "",
      tools.length ? `${tools.length} tools` : "",
      children.length ? `${children.length} subagents` : "",
      errors ? `${errors} errors` : ""
    ].filter(Boolean).join(" · ") || message.role,
    status,
    timeStart: message.timeCreated,
    timeEnd: message.timeCreated + stepDuration,
    duration: stepDuration,
    cost: stepCost,
    tokens: stepTokens,
    toolCalls: tools.length,
    errors,
    subagents: 0,
    errorRate: tools.length ? errors / tools.length : 0,
    children
  });
}

function subagentNode(part: PartContainer): FlowNode {
  const childSessions = part.childSessions.map((child) => sessionNode(child));
  const status = partStatus(part);
  const errors = isErrorPart(part) ? 1 : 0;
  return {
    id: `part:${part.id}`,
    kind: "subagent",
    label: part.title || part.tool || part.partType,
    meta: [
      childSessions.length ? `${childSessions.length} ${childSessions.length === 1 ? "branch" : "branches"}` : "",
      part.tool || "task"
    ].filter(Boolean).join(" · "),
    status,
    timeStart: part.timeStart,
    timeEnd: part.timeEnd,
    duration: part.timeStart && part.timeEnd ? Math.max(0, part.timeEnd - part.timeStart) : 0,
    cost: 0,
    tokens: 0,
    toolCalls: 1,
    errors,
    subagents: 0,
    errorRate: errors,
    children: childSessions
  };
}

function sessionNode(container: SessionContainer, metrics: SessionMetricsView | null = null): FlowNode {
  const stepsByMessage = stepByMessage(metrics);
  const children: FlowNode[] = [];

  for (const message of container.messages) {
    const partChildren = message.parts
      .filter(isTaskPart)
      .map(subagentNode);
    const flowMessage = messageNode(message, partChildren, stepsByMessage.get(message.id) || []);
    if (flowMessage) {
      children.push(flowMessage);
    }
  }

  for (const child of container.detachedChildren) {
    children.push(sessionNode(child));
  }

  return aggregate({
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
    toolCalls: 0,
    errors: 0,
    subagents: 0,
    errorRate: 0,
    children
  });
}

function countNodes(node: FlowNode, acc = {
  totalNodes: 0,
  sessions: 0,
  messages: 0,
  subagents: 0
}) {
  acc.totalNodes += 1;
  if (node.kind === "session") acc.sessions += 1;
  if (node.kind === "message") {
    acc.messages += 1;
  }
  if (node.kind === "subagent") acc.subagents += 1;
  for (const child of node.children) countNodes(child, acc);
  return acc;
}

export function buildFlowTree(
  sessionId: string,
  dbPath: string | undefined,
  buildContainer: (sessionId: string, dbPath?: string) => SessionContainer | null,
  buildMetrics: (sessionId: string, dbPath?: string) => SessionMetricsView | null
): FlowTree | null {
  const container = buildContainer(sessionId, dbPath);
  if (!container) {
    return null;
  }

  const metrics = buildMetrics(sessionId, dbPath);
  const root = sessionNode(container, metrics);
  const counts = countNodes(root);
  return {
    sessionId,
    root,
    summary: {
      ...counts,
      toolCalls: root.toolCalls,
      errors: root.errors,
      errorRate: root.errorRate,
      totalDuration: root.duration,
      totalCost: root.cost,
      totalTokens: root.tokens
    }
  };
}
