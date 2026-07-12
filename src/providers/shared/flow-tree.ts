import { asNumber } from "./parser.js";
import type { MessageContainer, PartContainer, SessionContainer } from "./session-container.js";
import type { SessionMetricsView } from "./session-metrics.js";

export interface FlowMetrics {
  duration: number;
  cost: number;
  tokens: number;
  toolCalls: number;
  errors: number;
  subagents: number;
  errorRate: number;
}

export interface FlowTarget {
  kind: "session" | "msg" | "part";
  id: string;
}

interface FlowNodeBase {
  id: string;
  kind: "session" | "user" | "agent" | "invocation" | "return";
  label: string;
  meta: string;
  status: string | null;
  timeStart: number;
  timeEnd: number;
  inferred: boolean;
  target: FlowTarget;
  metrics: FlowMetrics;
}

export interface FlowMessageNode extends FlowNodeBase {
  kind: "user" | "agent";
  role: string;
  emphasis: "standard" | "final";
}

export interface FlowInvocationNode extends FlowNodeBase {
  kind: "invocation";
  returnId: string;
  branches: FlowSessionNode[];
}

export interface FlowReturnNode extends FlowNodeBase {
  kind: "return";
  invocationId: string;
}

export interface FlowSessionNode extends FlowNodeBase {
  kind: "session";
  line: FlowLineNode[];
}

export type FlowLineNode = FlowMessageNode | FlowInvocationNode | FlowReturnNode;
export type FlowNode = FlowSessionNode | FlowLineNode;

export interface FlowTree {
  sessionId: string;
  root: FlowSessionNode;
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

function emptyMetrics(overrides: Partial<FlowMetrics> = {}): FlowMetrics {
  const metrics = {
    duration: 0,
    cost: 0,
    tokens: 0,
    toolCalls: 0,
    errors: 0,
    subagents: 0,
    errorRate: 0,
    ...overrides
  };
  metrics.errorRate = metrics.toolCalls ? metrics.errors / metrics.toolCalls : 0;
  return metrics;
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

function messageKind(role: string): FlowMessageNode["kind"] | null {
  const normalized = String(role || "").toLowerCase();
  if (normalized === "user") return "user";
  if (normalized === "assistant" || normalized === "agent") return "agent";
  return null;
}

function messageTextPart(message: MessageContainer) {
  return message.parts.find((part) => (
    part.partType === "text"
    && typeof part.data?.text === "string"
    && part.data.text.trim()
  ));
}

function messageNode(
  message: MessageContainer,
  steps: SessionMetricsView["steps"][number][] = [],
  emphasis: FlowMessageNode["emphasis"] = "standard"
): FlowMessageNode | null {
  const kind = messageKind(message.role);
  if (!kind || (kind === "agent" && !messageTextPart(message))) {
    return null;
  }

  const tools = toolParts(message);
  const errors = tools.filter(isErrorPart).length;
  const duration = steps.reduce((sum, step) => sum + asNumber(step.duration), 0);
  const metrics = emptyMetrics({
    duration,
    cost: steps.reduce((sum, step) => sum + asNumber(step.cost), 0),
    tokens: steps.reduce((sum, step) => sum + asNumber(step.totalTokens), 0),
    toolCalls: tools.length,
    errors
  });
  const status = errors
    ? "has errors"
    : steps.some((step) => step.reason === "tool-calls")
      ? "tool calls"
      : steps[steps.length - 1]?.reason || null;

  return {
    id: `msg:${message.id}`,
    kind,
    role: message.role,
    emphasis,
    label: message.title || `${message.role} message`,
    meta: [
      tools.length ? `${tools.length} tools` : "",
      errors ? `${errors} errors` : ""
    ].filter(Boolean).join(" · ") || message.role,
    status,
    timeStart: message.timeCreated,
    timeEnd: message.timeCreated + duration,
    inferred: false,
    target: { kind: "msg", id: message.id },
    metrics
  };
}

function invocationPair(
  id: string,
  label: string,
  target: FlowTarget,
  branches: FlowSessionNode[],
  options: {
    inferred?: boolean;
    status?: string | null;
    timeStart?: number;
    timeEnd?: number;
    toolCalls?: number;
    errors?: number;
    meta?: string;
  } = {}
): [FlowInvocationNode, FlowReturnNode] {
  const inferred = Boolean(options.inferred);
  const invocationId = `invoke:${id}`;
  const returnId = `return:${id}`;
  const branchMetrics = branches.reduce((totals, branch) => {
    totals.duration = Math.max(totals.duration, branch.metrics.duration);
    totals.cost += branch.metrics.cost;
    totals.tokens += branch.metrics.tokens;
    totals.toolCalls += branch.metrics.toolCalls;
    totals.errors += branch.metrics.errors;
    totals.subagents += 1 + branch.metrics.subagents;
    return totals;
  }, emptyMetrics());
  branchMetrics.toolCalls += options.toolCalls || 0;
  branchMetrics.errors += options.errors || 0;
  branchMetrics.errorRate = branchMetrics.toolCalls ? branchMetrics.errors / branchMetrics.toolCalls : 0;

  const invocation: FlowInvocationNode = {
    id: invocationId,
    kind: "invocation",
    label,
    meta: options.meta || (branches.length
      ? `${branches.length} ${branches.length === 1 ? "subagent" : "subagents"}`
      : "subagent"),
    status: options.status || null,
    timeStart: options.timeStart || 0,
    timeEnd: options.timeEnd || 0,
    inferred,
    target,
    metrics: branchMetrics,
    returnId,
    branches
  };

  const returned: FlowReturnNode = {
    id: returnId,
    kind: "return",
    label: "Return",
    meta: branches.length
      ? `${branches.length} ${branches.length === 1 ? "result" : "results"}`
      : "result unavailable",
    status: options.status || null,
    timeStart: options.timeEnd || options.timeStart || 0,
    timeEnd: options.timeEnd || options.timeStart || 0,
    inferred,
    target,
    metrics: emptyMetrics(),
    invocationId
  };

  return [invocation, returned];
}

function taskPair(part: PartContainer): [FlowInvocationNode, FlowReturnNode] {
  const branches = part.childSessions.map((child) => sessionNode(child));
  const errors = isErrorPart(part) ? 1 : 0;
  return invocationPair(
    part.id,
    part.title || part.tool || "Subagent",
    { kind: "part", id: part.id },
    branches,
    {
      status: partStatus(part),
      timeStart: part.timeStart,
      timeEnd: part.timeEnd,
      toolCalls: 1,
      errors,
      meta: [
        branches.length ? `${branches.length} ${branches.length === 1 ? "subagent" : "subagents"}` : "",
        part.tool || "task",
        errors ? "error" : ""
      ].filter(Boolean).join(" · ")
    }
  );
}

function detachedPair(child: SessionContainer): [FlowInvocationNode, FlowReturnNode] {
  const branch = sessionNode(child, null, true);
  return invocationPair(
    `detached:${child.id}`,
    child.title || "Detached subagent",
    { kind: "session", id: child.id },
    [branch],
    {
      inferred: true,
      timeStart: child.metrics.timeStart,
      timeEnd: child.metrics.timeEnd,
      meta: "inferred subagent"
    }
  );
}

function insertDetachedPair(line: FlowLineNode[], pair: [FlowInvocationNode, FlowReturnNode]) {
  const start = pair[0].timeStart;
  const nextMessageIndex = start
    ? line.findIndex((node) => (node.kind === "user" || node.kind === "agent") && node.timeStart >= start)
    : -1;
  const index = nextMessageIndex >= 0 ? nextMessageIndex : line.length;
  line.splice(index, 0, ...pair);
}

function aggregateSessionMetrics(container: SessionContainer): FlowMetrics {
  const toolCalls = container.metrics.totalToolCalls;
  const errors = countContainerErrors(container);
  return emptyMetrics({
    duration: container.metrics.runtimeMs,
    cost: container.metrics.cost,
    tokens: container.metrics.inputTokens + container.metrics.outputTokens + container.metrics.reasoningTokens,
    toolCalls,
    errors,
    subagents: container.metrics.descendantCount
  });
}

function countContainerErrors(container: SessionContainer): number {
  const direct = container.messages.reduce(
    (sum, message) => sum + toolParts(message).filter(isErrorPart).length,
    0
  );
  const attached = container.messages
    .flatMap((message) => message.parts)
    .flatMap((part) => part.childSessions)
    .reduce((sum, child) => sum + countContainerErrors(child), 0);
  const detached = container.detachedChildren.reduce((sum, child) => sum + countContainerErrors(child), 0);
  return direct + attached + detached;
}

function sessionNode(
  container: SessionContainer,
  metrics: SessionMetricsView | null = null,
  inferred = false
): FlowSessionNode {
  const stepsByMessage = stepByMessage(metrics);
  const line: FlowLineNode[] = [];

  for (let index = 0; index < container.messages.length; index += 1) {
    const message = container.messages[index];
    const kind = messageKind(message.role);
    const nextConversationMessage = container.messages
      .slice(index + 1)
      .find((candidate) => messageKind(candidate.role));
    const emphasis = kind === "agent" && (!nextConversationMessage || messageKind(nextConversationMessage.role) === "user")
      ? "final"
      : "standard";
    const flowMessage = messageNode(message, stepsByMessage.get(message.id) || [], emphasis);
    if (flowMessage) {
      line.push(flowMessage);
    }
    for (const task of message.parts.filter(isTaskPart)) {
      line.push(...taskPair(task));
    }
  }

  for (const child of [...container.detachedChildren].sort(
    (a, b) => asNumber(a.metrics.timeStart) - asNumber(b.metrics.timeStart)
  )) {
    insertDetachedPair(line, detachedPair(child));
  }

  return {
    id: `session:${container.id}`,
    kind: "session",
    label: container.title,
    meta: inferred ? "inferred branch" : container.attachMode,
    status: null,
    timeStart: container.metrics.timeStart,
    timeEnd: container.metrics.timeEnd,
    inferred,
    target: { kind: "session", id: container.id },
    metrics: aggregateSessionMetrics(container),
    line
  };
}

function countNodes(node: FlowSessionNode, acc = {
  totalNodes: 0,
  sessions: 0,
  messages: 0
}) {
  acc.totalNodes += 1;
  acc.sessions += 1;
  for (const item of node.line) {
    acc.totalNodes += 1;
    if (item.kind === "user" || item.kind === "agent") {
      acc.messages += 1;
    }
    if (item.kind === "invocation") {
      for (const branch of item.branches) {
        countNodes(branch, acc);
      }
    }
  }
  return acc;
}

export function buildFlowTreeFromContainer(
  container: SessionContainer,
  metrics: SessionMetricsView | null = null
): FlowTree {
  const root = sessionNode(container, metrics);
  const counts = countNodes(root);
  return {
    sessionId: container.id,
    root,
    summary: {
      ...counts,
      toolCalls: root.metrics.toolCalls,
      subagents: root.metrics.subagents,
      errors: root.metrics.errors,
      errorRate: root.metrics.errorRate,
      totalDuration: root.metrics.duration,
      totalCost: root.metrics.cost,
      totalTokens: root.metrics.tokens
    }
  };
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
  return buildFlowTreeFromContainer(container, buildMetrics(sessionId, dbPath));
}
