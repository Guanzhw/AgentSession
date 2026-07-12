import { readFileSync, statSync } from "node:fs";
import type { Message, RawSession, RuntimeEnvironmentView, RuntimeExtensionReference, TokenUsage } from "../interface.js";
import { asNumber } from "../shared/parser.js";
import { buildFlowTreeFromContainer } from "../shared/flow-tree.js";
import { buildMessageSessionViews } from "../shared/message-session.js";
import {
  buildLinkedMessageSessionViews,
  type MessageSessionBundle
} from "../shared/linked-message-session.js";
import type { SessionMetricsView } from "../shared/session-metrics.js";
import type { SessionTree } from "../shared/session-tree.js";

type Row = Record<string, any>;

export interface SystemPromptItem {
  kind: string;
  title: string;
  preview: string;
  source: string;
  time: number;
}

export interface SystemPromptSection {
  title: string;
  note: string;
  items: SystemPromptItem[];
}

interface ClaudeCodeTraceSpan {
  id: string;
  name: string;
  category: string;
  mcpServer?: string;
  timeStart: number;
  timeEnd: number;
  duration: number;
  status: string | null;
  input: string | null;
  output: string | null;
  title: string | null;
}

export interface ClaudeCodeTraceStep {
  messageId: string;
  agent: string | null;
  model: string | null;
  cost: number;
  tokens: TokenUsage;
  reason: string | null;
  timeStart: number;
  timeEnd: number;
  duration: number;
  spans: ClaudeCodeTraceSpan[];
}

const MAX_TRACE_STEPS = 200;

function asTime(value: unknown, fallback = 0) {
  if (typeof value === "string" && value) {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : asNumber(fallback);
  }
  return asNumber(value) || asNumber(fallback);
}

function compact(value: unknown, limit = 420) {
  if (value == null || value === "") {
    return "";
  }

  const text = typeof value === "string" ? value : JSON.stringify(value);
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 3)}...` : clean;
}

function stringify(value: unknown, limit = 500) {
  if (value == null) return null;
  return compact(value, limit);
}

function contentBlocks(content: unknown): Row[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return Array.isArray(content) ? content.filter((block) => block && typeof block === "object") as Row[] : [];
}

function textFromContent(content: unknown) {
  return contentBlocks(content)
    .filter((block) => block.type === "text")
    .map((block) => String(block.text || ""))
    .join("");
}

function item(kind: string, title: string, preview: unknown, source: string, time = 0): SystemPromptItem {
  return {
    kind,
    title,
    preview: compact(preview),
    source,
    time: asNumber(time)
  };
}

function section(title: string, note: string, items: SystemPromptItem[]): SystemPromptSection {
  return { title, note, items };
}

function readText(filePath: string | null, fallback: unknown = "") {
  if (!filePath) {
    return compact(fallback);
  }
  try {
    return readFileSync(filePath, "utf-8");
  } catch (err) {
    console.warn("Failed to read file:", filePath, err);
    return compact(fallback);
  }
}

function sourceTime(sourcePath: string | null, fallback = 0) {
  if (!sourcePath) {
    return asNumber(fallback);
  }
  try {
    return statSync(sourcePath).mtimeMs;
  } catch (err) {
    console.warn("Failed to stat file:", sourcePath, err);
    return asNumber(fallback);
  }
}

function runtimeItem(entry: RuntimeExtensionReference, fallbackTime = 0): SystemPromptItem {
  const preview = entry.capturable && entry.sourceType === "file"
    ? readText(entry.sourcePath, entry.note)
    : {
      note: entry.note,
      sourceType: entry.sourceType,
      available: entry.available,
      capturable: entry.capturable
    };
  return item(entry.kind, entry.name, preview, entry.source, sourceTime(entry.sourcePath, fallbackTime));
}

function firstUserRecord(records: Row[]) {
  return records.find((record) => record.type === "user") || null;
}

function systemRecordItems(records: Row[], sessionTime = 0) {
  return records
    .filter((record) => record.type === "system")
    .map((record, index) => item("session", `System record ${index + 1}`, {
      cwd: record.cwd,
      version: record.version,
      model: record.model || record.message?.model,
      tools: record.tools,
      mcpServers: record.mcp_servers || record.mcpServers,
      permissionMode: record.permissionMode || record.permission_mode
    }, record.uuid || `transcript.system.${index + 1}`, asTime(record.timestamp, sessionTime)));
}

export function buildClaudeCodeSystemPrompts(
  session: RawSession | Row,
  records: Row[],
  runtimeEnvironment: RuntimeEnvironmentView | null
) {
  const firstUser = firstUserRecord(records);
  const sessionTime = asTime(session.timeCreated ?? (session as Row).time_created);
  const firstUserTime = firstUser ? asTime(firstUser.timestamp, sessionTime) : sessionTime;
  const firstUserPreview = firstUser
    ? textFromContent(firstUser.message?.content ?? firstUser.content)
    : "";
  const extensions = runtimeEnvironment?.extensions || [];
  const promptLikeKinds = new Set(["instruction", "rule"]);
  const promptLike = extensions.filter((entry) => promptLikeKinds.has(entry.kind));
  const runtimeSources = extensions.filter((entry) => !promptLikeKinds.has(entry.kind));

  return {
    sessionId: String(session.id),
    mode: "claude-code-resolved",
    hiddenPromptStored: false,
    selectedAgent: null,
    note: "Claude Code transcript files do not store the hidden provider prompt. This view resolves currently available local instruction, rule, and runtime extension sources for the recorded working directory.",
    firstUserMessage: firstUser ? {
      id: String(firstUser.uuid || "first-user"),
      time: firstUserTime,
      preview: compact(firstUserPreview)
    } : null,
    sections: [
      section(
        "Claude Instruction Files",
        "User and project CLAUDE.md files plus Claude Code rule files that are currently resolvable for this session directory.",
        promptLike.map((entry) => runtimeItem(entry, firstUserTime))
      ),
      section(
        "Claude Runtime Extensions",
        "Skills, agents, commands, plugins, hooks, and settings that can affect Claude Code behavior. Directory and package entries are listed as sources; file entries include a preview when readable.",
        runtimeSources.map((entry) => runtimeItem(entry, firstUserTime))
      ),
      section(
        "Stored Transcript Envelope",
        "Transcript metadata recorded locally with the session; useful evidence but not the hidden prompt body.",
        [
          item("session", "Directory", session.directory, "session.directory", sessionTime),
          item("session", "Title", session.title, "session.title", sessionTime),
          ...systemRecordItems(records, sessionTime)
        ].filter((entry) => entry.preview)
      ),
      section(
        "First User Boundary",
        "Everything above is resolved before or around this first user message. The user text is shown only as the boundary.",
        firstUser ? [
          item("first-user", String(firstUser.uuid || "first-user"), firstUserPreview, "message.first-user", firstUserTime)
        ] : []
      )
    ]
  };
}

function emptyTokens(): TokenUsage {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
    total: 0
  };
}

function addTokens(target: TokenUsage, source: TokenUsage | null | undefined) {
  if (!source) return;
  target.input = asNumber(target.input) + asNumber(source.input);
  target.output = asNumber(target.output) + asNumber(source.output);
  target.reasoning = asNumber(target.reasoning) + asNumber(source.reasoning);
  target.cache = {
    read: asNumber(target.cache?.read) + asNumber(source.cache?.read),
    write: asNumber(target.cache?.write) + asNumber(source.cache?.write)
  };
  target.total = asNumber(target.total) + (
    asNumber(source.total)
    || asNumber(source.input)
    + asNumber(source.output)
    + asNumber(source.reasoning)
    + asNumber(source.cache?.read)
    + asNumber(source.cache?.write)
  );
}

function modelLabel(data: Row) {
  const model = data.model;
  if (typeof model === "string") return model;
  if (model && typeof model === "object") {
    return model.modelID || model.providerID || null;
  }
  return data.modelID || null;
}

function classifyTool(tool: string) {
  const normalized = tool.toLowerCase();
  if (normalized === "task") return { category: "agent", mcpServer: null };
  if (normalized.startsWith("mcp__")) {
    const [, server] = tool.split("__");
    return { category: "mcp", mcpServer: server || null };
  }
  if (normalized.includes("__")) {
    const [server] = tool.split("__");
    return { category: "mcp", mcpServer: server || null };
  }
  return { category: "tool", mcpServer: null };
}

function spanTime(part: Row, fallback = 0) {
  const timeStart = asNumber(part.timeStart) || asNumber(part.data?.state?.time?.start) || fallback;
  const timeEnd = asNumber(part.timeEnd) || asNumber(part.data?.state?.time?.end) || timeStart;
  return {
    timeStart,
    timeEnd,
    duration: timeStart && timeEnd ? Math.max(0, timeEnd - timeStart) : 0
  };
}

function traceSpan(part: Row, fallbackTime = 0): ClaudeCodeTraceSpan {
  const data = part.data || {};
  const partType = String(part.type || data.type || "unknown");
  const time = spanTime(part, fallbackTime);
  if (partType === "reasoning") {
    return {
      id: String(part.id),
      name: "reasoning",
      category: "reasoning",
      ...time,
      status: null,
      input: null,
      output: stringify(data.text),
      title: "reasoning"
    };
  }
  if (partType === "text") {
    return {
      id: String(part.id),
      name: "text",
      category: "text",
      ...time,
      status: null,
      input: null,
      output: stringify(data.text),
      title: "assistant text"
    };
  }

  const tool = String(part.tool || data.tool || partType);
  const classification = classifyTool(tool);
  const state = data.state || {};
  return {
    id: String(part.id),
    name: tool,
    category: classification.category,
    ...(classification.mcpServer ? { mcpServer: classification.mcpServer } : {}),
    ...time,
    status: state.status || null,
    input: stringify(state.input),
    output: stringify(state.output ?? state.error),
    title: state.title || state.input?.description || state.input?.command || state.input?.file_path || state.input?.filePath || null
  };
}

function startStep(message: SessionTree["messages"][number]): ClaudeCodeTraceStep {
  const data = message.data || {};
  const tokens = emptyTokens();
  addTokens(tokens, data.tokens || null);
  return {
    messageId: message.id,
    agent: typeof data.agent === "string" ? data.agent : null,
    model: modelLabel(data),
    cost: asNumber(data.cost),
    tokens,
    reason: null,
    timeStart: asNumber(message.timeCreated),
    timeEnd: asNumber(message.timeCreated),
    duration: 0,
    spans: []
  };
}

function finalizeStep(step: ClaudeCodeTraceStep) {
  const spanTimes = step.spans.flatMap((span) => [span.timeStart, span.timeEnd]).filter(Boolean);
  if (spanTimes.length) {
    step.timeStart = Math.min(step.timeStart || spanTimes[0], ...spanTimes);
    step.timeEnd = Math.max(step.timeEnd || spanTimes[0], ...spanTimes);
  }
  step.duration = step.timeStart && step.timeEnd
    ? Math.max(0, step.timeEnd - step.timeStart)
    : step.spans.reduce((sum, span) => sum + asNumber(span.duration), 0);
  if (!step.reason) {
    if (step.spans.some((span) => ["tool", "mcp", "agent"].includes(span.category))) {
      step.reason = "tool-calls";
    } else if (step.spans.some((span) => span.category === "text")) {
      step.reason = "message";
    } else if (step.spans.some((span) => span.category === "reasoning")) {
      step.reason = "reasoning";
    }
  }
  return step;
}

function buildClaudeCodeTraceFromTree(sessionId: string, tree: SessionTree) {
  let current: ClaudeCodeTraceStep | null = null;
  const steps: ClaudeCodeTraceStep[] = [];

  const flush = () => {
    if (!current) return;
    steps.push(finalizeStep(current));
    current = null;
  };

  for (const message of tree.messages) {
    const role = String(message.role || "").toLowerCase();
    if (role === "user") {
      flush();
      continue;
    }
    if (!current) {
      current = startStep(message);
    } else {
      addTokens(current.tokens, message.data?.tokens || null);
      if (!current.model) current.model = modelLabel(message.data || {});
    }

    for (const part of message.parts || []) {
      current.spans.push(traceSpan(part as Row, asNumber(message.timeCreated)));
    }
  }
  flush();

  const truncated = steps.length > MAX_TRACE_STEPS;
  const visibleSteps = steps.slice(0, MAX_TRACE_STEPS);
  const summary = visibleSteps.reduce(
    (acc, step) => {
      acc.totalSteps += 1;
      acc.totalSpans += step.spans.length;
      acc.totalDuration += asNumber(step.duration);
      acc.totalCost += asNumber(step.cost);
      acc.totalTokens += asNumber(step.tokens.total);
      return acc;
    },
    { totalSteps: 0, totalSpans: 0, totalDuration: 0, totalCost: 0, totalTokens: 0 }
  );

  return {
    sessionId,
    steps: visibleSteps,
    summary,
    truncated
  };
}

function stepsToMetrics(steps: ClaudeCodeTraceStep[]): SessionMetricsView["steps"] {
  return steps.map((step, index) => {
    const cache = step.tokens.cache || {};
    return {
      index: index + 1,
      messageId: step.messageId,
      snapshotId: null,
      reason: step.reason,
      duration: asNumber(step.duration),
      totalTokens: asNumber(step.tokens.total),
      inputTokens: asNumber(step.tokens.input),
      outputTokens: asNumber(step.tokens.output),
      reasoningTokens: asNumber(step.tokens.reasoning),
      cacheReadTokens: asNumber(cache.read),
      cacheWriteTokens: asNumber(cache.write),
      cost: asNumber(step.cost),
      contextItems: step.spans.length
    };
  });
}

function enrichClaudeCodeSessionViews(base: any) {
  const trace = buildClaudeCodeTraceFromTree(String(base.tree.session.id), base.tree);
  const metrics: SessionMetricsView = {
    ...base.metrics,
    totals: {
      ...base.metrics.totals,
      steps: trace.steps.length,
      cost: trace.summary.totalCost
    },
    steps: stepsToMetrics(trace.steps)
  };
  return {
    ...base,
    metrics,
    flow: buildFlowTreeFromContainer(base.container, metrics),
    trace
  };
}

export function buildClaudeCodeSessionViews(session: RawSession | Row, messages: Message[]) {
  return enrichClaudeCodeSessionViews(buildMessageSessionViews(session, messages));
}

export function buildLinkedClaudeCodeSessionViews(sessionId: string, bundles: MessageSessionBundle[]) {
  const base = buildLinkedMessageSessionViews(sessionId, bundles);
  return base ? enrichClaudeCodeSessionViews(base) : null;
}
