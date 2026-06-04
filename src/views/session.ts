import { escapeHtml } from "../markdown.js";
import { layout } from "./layout.js";
import { formatDuration, formatTime, messageBubble, reasoningBlock, todoList, toolCallBlock } from "./components.js";
import { t } from "../i18n.js";
import type { SessionPartNode, SessionTree } from "../providers/opencode/session-tree.js";
import { isOpenCodeLikeProvider } from "../providers/kinds.js";

function safeParse(value) {
  if (typeof value !== "string") {
    return value || {};
  }

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function modelLabel(model) {
  if (!model || typeof model !== "object") {
    return "";
  }

  if (model.providerID && model.modelID) {
    return `${model.providerID}/${model.modelID}`;
  }

  return model.modelID || model.providerID || "";
}

function messageModelLabel(messageData) {
  return modelLabel(messageData.model) || modelLabel(messageData);
}

function formatCount(value) {
  return (Number(value) || 0).toLocaleString();
}

function formatMilliseconds(ms) {
  const totalSeconds = Math.round((Number(ms) || 0) / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function anchorId(prefix, id) {
  return `${prefix}-${String(id || "").replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function stringifyCompact(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function compactText(value, limit = 72) {
  const text = stringifyCompact(value).replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function partStatus(partData) {
  return typeof partData?.state?.status === "string" ? partData.state.status : "";
}

function isErrorPart(partData) {
  return partStatus(partData) === "error" || Boolean(partData?.error);
}

function isTaskTool(tool) {
  return ["task", "subtask"].includes(String(tool || ""));
}

function formatPercent(value) {
  const amount = Number(value) || 0;
  return `${Math.round(amount * 100)}%`;
}

function isNavigableMessageRole(role) {
  return ["user", "assistant", "agent"].includes(String(role || "").toLowerCase());
}

function taskTitle(partData) {
  return partData?.state?.title
    || partData?.state?.input?.description
    || partData?.state?.input?.subagent_type
    || "";
}

function taskDisplayTitle(partData) {
  return taskTitle(partData) || "Task";
}

function childSessionCountLabel(count) {
  const amount = Number(count) || 0;
  return `${amount} ${amount === 1 ? "session" : "sessions"}`;
}

function toolTitle(partData) {
  if (partData?.type === "tool" && isTaskTool(partData?.tool)) {
    return taskTitle(partData);
  }

  const input = partData?.state?.input;
  const candidates = [
    partData?.state?.title,
    input?.filePath,
    input?.command,
    input?.pattern,
    input?.url,
    input?.description
  ];
  const detail = candidates.find((item) => typeof item === "string" && item.trim());
  return detail ? `${partData?.tool || partData?.type} · ${detail}` : (partData?.tool || partData?.type || "part");
}

function messageText(message) {
  const textPart = message.parts.find((part) => part.type === "text" && part.data?.text);
  return compactText(textPart?.data?.text || message.data?.summary || message.id, 86);
}

function hasVisibleMessagePart(message) {
  return message.parts.some((part) => {
    if (part.type === "reasoning") {
      return false;
    }

    if (part.type === "text" && part.data?.text) {
      return true;
    }

    if (part.type === "tool" && !["todoread", "todowrite"].includes(String(part.tool || ""))) {
      return true;
    }

    return part.childSessions.length > 0;
  });
}

function renderMetric(label, value) {
  return `<span class="session-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></span>`;
}

function renderSubsessionHeader(tree: SessionTree) {
  const session = tree.session || {};
  const title = session.title || session.slug || session.id;
  const metrics = tree.metrics;
  const pieces = [
    `${formatCount(metrics.totalMessages)} messages`,
    `${formatCount(metrics.totalToolCalls)} tools`
  ];

  if (metrics.descendantCount) {
    pieces.push(`${formatCount(metrics.descendantCount)} nested`);
  }
  if (metrics.runtimeMs) {
    pieces.push(formatDuration(metrics.timeStart, metrics.timeEnd));
  }

  return `<summary class="subsession-summary" aria-label="${escapeHtml(`Toggle subsession ${title}`)}">
    <span class="subsession-kicker">subsession</span>
    <span class="subsession-title">${escapeHtml(title)}</span>
    <span class="subsession-meta">${escapeHtml(pieces.join(" · "))}</span>
  </summary>`;
}

function renderSubagentExportActions(part: SessionPartNode, provider: string) {
  const childSession = part.childSessions[0]?.session;
  const childId = childSession?.id;
  if (!childId) {
    return "";
  }

  const encoded = encodeURIComponent(childId);
  const suffix = part.childSessions.length > 1 ? ` first session of ${part.childSessions.length}` : "";
  return `<span class="subagent-actions" aria-label="Subagent export actions">
    <a class="subagent-export-btn" href="/api/${escapeHtml(provider)}/session/${encoded}/export?format=md" title="${escapeHtml(`Export${suffix} as Markdown`)}">MD</a>
    <a class="subagent-export-btn" href="/api/${escapeHtml(provider)}/session/${encoded}/export?format=json" title="${escapeHtml(`Export${suffix} as JSON`)}">JSON</a>
  </span>`;
}

function renderSubagentBranch(part: SessionPartNode, childMarkup: string, provider: string, reasoningMarkup = "") {
  const data = part.data || {};
  const title = taskTitle(data);
  const status = partStatus(data);
  const duration = part.timeStart && part.timeEnd ? formatDuration(part.timeStart, part.timeEnd) : "";
  const meta = [
    childSessionCountLabel(part.childSessions.length),
    status,
    duration
  ].filter(Boolean).join(" · ");

  return `<details class="subagent-branch" data-subsession-container="task" data-parent-part-id="${escapeHtml(part.id)}" open>
    <summary class="subagent-summary" aria-label="${escapeHtml(`Toggle subagent ${title || "task"}`)}">
      <span class="subsession-kicker">subagent</span>
      ${title ? `<span class="subsession-title">${escapeHtml(title)}</span>` : ""}
      ${meta ? `<span class="subsession-meta">${escapeHtml(meta)}</span>` : ""}
      ${renderSubagentExportActions(part, provider)}
    </summary>
    <div class="subagent-body">
      ${reasoningMarkup ? `<div class="subagent-reasoning">${reasoningMarkup}</div>` : ""}
      ${childMarkup}
    </div>
  </details>`;
}

function renderMessageControls(message, provider: string) {
  const role = String(message.role || "").toLowerCase();
  if (role !== "user") {
    return "";
  }

  return `<div class="message-controls">
    <button type="button" class="flow-open-btn" data-flow-anchor="${escapeHtml(anchorId("msg", message.id))}" aria-expanded="false" aria-controls="session-flow-panel">Flow</button>
  </div>`;
}

function renderSubagentChildSession(tree: SessionTree, provider: string) {
  const messageBlocks = [];
  let pendingReasoning = [];

  for (const message of tree.messages) {
    const result = renderMessagePartsResult(message, 0, provider, pendingReasoning);
    pendingReasoning = result.pendingReasoning;
    const messageAnchor = escapeHtml(anchorId("msg", message.id));
    if (result.hasVisibleContent && result.markup) {
      messageBlocks.push(`<article id="${messageAnchor}" class="message-group" data-role="${escapeHtml(message.role)}">${renderMessageControls(message, provider)}${result.markup}</article>`);
    } else if (!pendingReasoning.length) {
      messageBlocks.push(`<span id="${messageAnchor}" class="session-event-anchor" aria-hidden="true"></span>`);
    }
  }

  attachPendingReasoning(messageBlocks, pendingReasoning);
  const messageMarkup = messageBlocks.filter(Boolean).join("\n");

  const detachedMarkup = tree.detachedChildren
    .map((child) => renderSubagentChildSession(child, provider))
    .filter(Boolean)
    .join("\n");
  return [messageMarkup, detachedMarkup].filter(Boolean).join("\n");
}

function makeTocNode(id, type, label, meta, depth, children = []) {
  return {
    id,
    type,
    label,
    meta,
    depth,
    children
  };
}

function collectMessageTaskTocNodes(message, parentAgentDepth) {
  const nodes = [];

  for (const part of message.parts) {
    if (part.type === "tool" && isTaskTool(part.tool)) {
      const children = part.childSessions.flatMap((child) => collectTocNodes(child, parentAgentDepth));
      nodes.push(makeTocNode(
        anchorId("part", part.id),
        "Task",
        taskDisplayTitle(part.data),
        part.childSessions.length ? childSessionCountLabel(part.childSessions.length) : partStatus(part.data) || part.tool || "task",
        parentAgentDepth + 1,
        children
      ));
    }

    for (const child of part.childSessions) {
      if (!(part.type === "tool" && isTaskTool(part.tool))) {
        nodes.push(...collectTocNodes(child, parentAgentDepth));
      }
    }
  }

  return nodes;
}

function collectTocNodes(tree: SessionTree, userDepth = 0) {
  const nodes = [];
  let currentUserNode = null;

  for (const message of tree.messages) {
    const role = String(message.role || "").toLowerCase();
    if (!isNavigableMessageRole(role) || !hasVisibleMessagePart(message)) {
      continue;
    }

    if (role === "user") {
      currentUserNode = makeTocNode(
        anchorId("msg", message.id),
        message.role,
        messageText(message) || "user message",
        "",
        userDepth
      );
      nodes.push(currentUserNode);
      continue;
    }

    const agentDepth = userDepth + 1;
    const node = makeTocNode(
      anchorId("msg", message.id),
      message.role,
      messageText(message) || `${message.role} message`,
      "",
      agentDepth
    );
    node.children.push(...collectMessageTaskTocNodes(message, agentDepth));

    if (currentUserNode) {
      currentUserNode.children.push(node);
    } else {
      nodes.push(node);
    }
  }

  for (const child of tree.detachedChildren) {
    nodes.push(...collectTocNodes(child, userDepth + 1));
  }
  return nodes;
}

function renderTocNode(node) {
  const children = Array.isArray(node.children) ? node.children : [];
  const typeLabel = String(node.type || "").toLowerCase() === "user"
    ? "U"
    : String(node.type || "").toLowerCase() === "assistant"
      ? "A"
      : String(node.type || "").slice(0, 1).toUpperCase();
  const link = `<a class="toc-link toc-${escapeHtml(node.type.toLowerCase())}" href="#${escapeHtml(node.id)}" style="--toc-depth:${Math.min(node.depth, 6)}">
      <span class="toc-type">${escapeHtml(typeLabel)}</span>
      <span class="toc-label">${escapeHtml(node.label)}</span>
      ${node.meta ? `<span class="toc-meta">${escapeHtml(node.meta)}</span>` : ""}
    </a>`;

  if (!children.length) {
    return link;
  }

  return `<details class="toc-group toc-group-${escapeHtml(node.type.toLowerCase())}" open>
    <summary class="toc-group-summary">${link}</summary>
    <div class="toc-children">
      ${children.map(renderTocNode).join("\n")}
    </div>
  </details>`;
}

function renderToc(tree: SessionTree | null) {
  if (!tree) {
    return `<aside class="session-toc"><h2>Navigate</h2><p class="toc-empty">No indexed messages.</p></aside>`;
  }

  const nodes = collectTocNodes(tree);
  const markup = nodes.map(renderTocNode).join("\n");

  return `<aside class="session-toc">
    <div class="toc-header">
      <h2>TOC</h2>
      <div class="toc-controls" aria-label="Navigate controls">
        <button type="button" class="toc-control" data-toc-action="collapse" title="Collapse all">-</button>
        <button type="button" class="toc-control" data-toc-action="expand" title="Expand all">+</button>
      </div>
    </div>
    <div class="toc-list">${markup || `<p class="toc-empty">No indexed messages.</p>`}</div>
  </aside>`;
}

function renderFlowPart(part: SessionPartNode, depth: number) {
  const data = part.data || {};
  const status = partStatus(data);
  const duration = part.timeStart && part.timeEnd ? formatDuration(part.timeStart, part.timeEnd) : "";
  const isTask = part.type === "tool" && isTaskTool(part.tool);
  const kind = isTask ? "subagent" : part.type === "tool" ? "tool" : part.type;
  const label = isTask ? taskTitle(data) : toolTitle(data);
  const classes = ["flow-row", `flow-${kind}`, isErrorPart(data) ? "flow-error" : ""].filter(Boolean).join(" ");
  const href = `#${anchorId("part", part.id)}`;
  const childMarkup = part.childSessions.map((child) => renderFlowSession(child, depth + 1)).join("\n");

  return `<li>
    <a class="${classes}" href="${escapeHtml(href)}" style="--flow-depth:${Math.min(depth, 8)}">
      <span class="flow-dot"></span>
      <span class="flow-kind">${escapeHtml(kind)}</span>
      <span class="flow-label">${escapeHtml(compactText(label, 90) || kind)}</span>
      ${status ? `<span class="flow-status">${escapeHtml(status)}</span>` : ""}
      ${duration ? `<span class="flow-duration">${escapeHtml(duration)}</span>` : ""}
    </a>
    ${childMarkup ? `<ul class="flow-children">${childMarkup}</ul>` : ""}
  </li>`;
}

function renderFlowSession(tree: SessionTree, depth = 0) {
  const session = tree.session || {};
  const title = session.title || session.slug || session.id;
  const metrics = tree.metrics;
  const rows = [];

  rows.push(`<li>
    <a class="flow-row flow-session" href="#${escapeHtml(anchorId("session", session.id))}" style="--flow-depth:${Math.min(depth, 8)}">
      <span class="flow-dot"></span>
      <span class="flow-kind">${depth ? "branch" : "root"}</span>
      <span class="flow-label">${escapeHtml(compactText(title, 92))}</span>
      <span class="flow-status">${escapeHtml(formatCount(metrics.totalMessages))} msg</span>
    </a>
  </li>`);

  for (const message of tree.messages) {
    rows.push(`<li>
      <a class="flow-row flow-message flow-role-${escapeHtml(message.role)}" href="#${escapeHtml(anchorId("msg", message.id))}" style="--flow-depth:${Math.min(depth + 1, 8)}">
        <span class="flow-dot"></span>
        <span class="flow-kind">${escapeHtml(message.role)}</span>
        <span class="flow-label">${escapeHtml(messageText(message) || message.id)}</span>
        ${message.timeCreated ? `<span class="flow-duration">${escapeHtml(formatTime(message.timeCreated))}</span>` : ""}
      </a>
      ${message.parts.length ? `<ul class="flow-children">${message.parts.map((part) => renderFlowPart(part, depth + 2)).join("\n")}</ul>` : ""}
    </li>`);
  }

  for (const child of tree.detachedChildren) {
    rows.push(renderFlowSession(child, depth + 1));
  }

  return rows.join("\n");
}

function renderFlowPanel(tree: SessionTree | null) {
  return `<section id="session-flow-panel" class="session-flow-panel hidden" tabindex="-1" aria-hidden="true">
    <div class="flow-panel-header">
      <h2>Flow Timeline</h2>
      <button type="button" class="flow-close-btn" data-flow-close aria-label="Close flow">x</button>
    </div>
    <p class="toc-empty">${tree ? "No timing data for this session." : "No flow data."}</p>
  </section>`;
}

function flowHref(node) {
  const [kind, ...rest] = String(node.id || "").split(":");
  const id = rest.join(":");
  if (kind === "session") return `#${anchorId("session", id)}`;
  if (kind === "msg") return `#${anchorId("msg", id)}`;
  if (kind === "part") return `#${anchorId("part", id)}`;
  return "#";
}

function flattenFlowTimeline(node, depth = 0, rows = []) {
  if (!node) {
    return rows;
  }

  if (node.kind !== "session" || depth > 0) {
    const start = Number(node.timeStart) || 0;
    const end = Number(node.timeEnd) || start + Number(node.duration || 0);
    if (start) {
      rows.push({
        node,
        depth,
        start,
        end: end > start ? end : start,
        duration: Math.max(0, Number(node.duration) || end - start)
      });
    }
  }

  for (const child of Array.isArray(node.children) ? node.children : []) {
    flattenFlowTimeline(child, depth + 1, rows);
  }

  return rows;
}

function renderFlowTimingDiagram(sessionFlow) {
  const root = sessionFlow?.root;
  if (!root?.timeStart || !root?.timeEnd || root.timeEnd <= root.timeStart) {
    return "";
  }

  const total = root.timeEnd - root.timeStart;
  const rows = flattenFlowTimeline(root)
    .sort((a, b) => a.start - b.start || a.depth - b.depth)
    .slice(0, 90);
  if (!rows.length) {
    return "";
  }

  const rowMarkup = rows.map(({ node, depth, start, end, duration }) => {
    const left = Math.max(0, Math.min(100, ((start - root.timeStart) / total) * 100));
    const rawWidth = Math.max(0, ((end - start) / total) * 100);
    const width = duration ? Math.max(0.8, rawWidth) : 0.8;
    const isPoint = !duration || rawWidth < 0.8;
    const classes = [
      "flow-timing-row",
      `flow-timing-${escapeHtml(node.kind || "node")}`,
      node.errors ? "flow-timing-error" : "",
      isPoint ? "flow-timing-point" : ""
    ].filter(Boolean).join(" ");
    const meta = [
      duration ? formatMilliseconds(duration) : "point",
      node.toolCalls ? `${formatCount(node.toolCalls)} tools` : "",
      node.errors ? `${formatCount(node.errors)} errors` : "",
      node.subagents ? `${formatCount(node.subagents)} subagents` : ""
    ].filter(Boolean).join(" · ");

    return `<a class="${classes}" href="${escapeHtml(flowHref(node))}" style="--flow-left:${left.toFixed(3)}%;--flow-width:${Math.min(width, 100 - left).toFixed(3)}%;--flow-depth:${Math.min(depth, 6)}">
      <span class="flow-timing-label">${escapeHtml(compactText(node.label, 42) || node.kind)}</span>
      <span class="flow-timing-track"><span class="flow-timing-bar"><span class="flow-timing-bar-label">${escapeHtml(duration ? formatMilliseconds(duration) : "")}</span></span></span>
      <span class="flow-timing-meta">${escapeHtml(meta)}</span>
    </a>`;
  }).join("\n");

  const omitted = flattenFlowTimeline(root).length - rows.length;
  const tickMarkup = [0, 25, 50, 75, 100].map((position) => {
    const label = position === 0 ? "start" : position === 100 ? formatMilliseconds(total) : formatMilliseconds(total * (position / 100));
    return `<span class="flow-timing-tick" style="--tick-left:${position}%">${escapeHtml(label)}</span>`;
  }).join("\n");
  return `<section class="flow-timing">
    <div class="flow-timing-head">
      <span>Timeline</span>
      <strong>${escapeHtml(formatTime(root.timeStart))} → ${escapeHtml(formatTime(root.timeEnd))}</strong>
    </div>
    <div class="flow-timing-scroll">
      <div class="flow-timing-grid">
        <div class="flow-timing-axis" aria-hidden="true">
          <span class="flow-timing-axis-spacer"></span>
          <div class="flow-timing-ruler">${tickMarkup}</div>
          <span class="flow-timing-axis-spacer"></span>
        </div>
        <div class="flow-timing-rows">${rowMarkup}</div>
      </div>
    </div>
    ${omitted > 0 ? `<p class="flow-timing-note">${escapeHtml(`${formatCount(omitted)} later timing rows omitted.`)}</p>` : ""}
  </section>`;
}

function renderCanonicalFlowNode(node, depth = 0) {
  const kind = node.kind || "part";
  const children = Array.isArray(node.children) ? node.children : [];
  const operationalMeta = [
    node.toolCalls ? `${formatCount(node.toolCalls)} tools` : "",
    node.errors ? `${formatCount(node.errors)} errors` : "",
    node.subagents ? `${formatCount(node.subagents)} subagents` : "",
    node.errorRate ? `${formatPercent(node.errorRate)} error rate` : ""
  ].filter(Boolean).join(" · ");
  const meta = [node.meta, operationalMeta, node.status].filter(Boolean).join(" · ");
  const duration = node.duration ? formatMilliseconds(node.duration) : "";
  const classes = ["flow-row", `flow-${kind}`].join(" ");

  return `<li>
    <a class="${classes}" href="${escapeHtml(flowHref(node))}" style="--flow-depth:${Math.min(depth, 8)}">
      <span class="flow-dot"></span>
      <span class="flow-kind">${escapeHtml(kind)}</span>
      <span class="flow-label">${escapeHtml(compactText(node.label, 92) || kind)}</span>
      ${meta ? `<span class="flow-status">${escapeHtml(meta)}</span>` : ""}
      ${duration ? `<span class="flow-duration">${escapeHtml(duration)}</span>` : ""}
    </a>
    ${children.length ? `<ul class="flow-children">${children.map((child) => renderCanonicalFlowNode(child, depth + 1)).join("\n")}</ul>` : ""}
  </li>`;
}

function renderCanonicalFlowPanel(sessionFlow) {
  if (!sessionFlow?.root) {
    return "";
  }

  const timingDiagram = renderFlowTimingDiagram(sessionFlow);
  return `<section id="session-flow-panel" class="session-flow-panel hidden" tabindex="-1" aria-hidden="true">
    <div class="flow-panel-header">
      <h2>Flow Timeline</h2>
      <button type="button" class="flow-close-btn" data-flow-close aria-label="Close flow">x</button>
    </div>
    ${timingDiagram || `<p class="toc-empty">No timing data for this session.</p>`}
  </section>`;
}

function renderSessionMetricsPanel(sessionMetrics) {
  if (!sessionMetrics?.totals) {
    return "";
  }

  const totals = sessionMetrics.totals;
  const topTools = Array.isArray(sessionMetrics.tools)
    ? sessionMetrics.tools.slice(0, 5).map((tool) => `${tool.name} ${tool.count}`).join(" · ")
    : "";
  const tokenPieces = [
    `${formatCount(totals.inputTokens)} in`,
    `${formatCount(totals.outputTokens)} out`,
    totals.reasoningTokens ? `${formatCount(totals.reasoningTokens)} reasoning` : "",
    totals.cacheReadTokens ? `${formatCount(totals.cacheReadTokens)} cache read` : "",
    totals.cacheWriteTokens ? `${formatCount(totals.cacheWriteTokens)} cache write` : ""
  ].filter(Boolean).join(" · ");

  return `<section class="session-metrics-panel">
    <div class="metrics-grid">
      ${renderMetric("messages", formatCount(totals.messages))}
      ${renderMetric("steps", formatCount(totals.steps))}
      ${renderMetric("tools", formatCount(totals.toolCalls))}
      ${renderMetric("branches", formatCount(totals.branches))}
      ${renderMetric("runtime", formatMilliseconds(totals.runtimeMs))}
      ${renderMetric("cost", totals.cost ? `$${Number(totals.cost).toFixed(4)}` : "$0")}
    </div>
    <p class="metrics-detail">${escapeHtml(tokenPieces || "No token totals available.")}</p>
    ${topTools ? `<p class="metrics-detail">${escapeHtml(`top tools: ${topTools}`)}</p>` : ""}
  </section>`;
}

function renderReasoningPart(partData) {
  return reasoningBlock(
    partData?.text || "",
    formatDuration(partData?.time?.start, partData?.time?.end)
  );
}

function renderPart(messageData, partData, partId, reasoningMarkup = "") {
  if (!partData || typeof partData !== "object") {
    return "";
  }

  if (partData.type === "text") {
    return messageBubble(messageData.role, partData.text || "", {
      model: messageModelLabel(messageData),
      tokens: messageData.tokens,
      time: messageData.time?.created,
      reasoning: reasoningMarkup
    });
  }

  if (partData.type === "reasoning") {
    return "";
  }

  if (partData.type === "tool") {
    if (["todoread", "todowrite"].includes(partData.tool)) {
      return "";
    }

    const state = partData.state && typeof partData.state === "object" ? partData.state : {};
    const timing = state.time && typeof state.time === "object" ? state.time : {};
    return toolCallBlock(
      partData.tool,
      state.input,
      state.output,
      state.status,
      formatDuration(timing.start, timing.end),
      partId,
      reasoningMarkup
    );
  }

  if (["step-start", "step-finish", "snapshot", "patch"].includes(partData.type)) {
    return "";
  }

  return "";
}

function renderPartNode(messageData, part: SessionPartNode, depth = 0, provider = "opencode", reasoningMarkup = "") {
  const isTaskWithSession = part.type === "tool" && isTaskTool(part.tool) && part.childSessions.length > 0;
  const renderedPart = isTaskWithSession ? "" : renderPart(messageData, part.data, part.id, reasoningMarkup);
  const childMarkup = part.childSessions
    .map((child) => renderSubagentChildSession(child, provider))
    .filter(Boolean)
    .join("\n");
  const partAnchor = escapeHtml(anchorId("part", part.id));
  const anchoredPart = renderedPart
    ? (part.type === "tool" ? renderedPart : `<div id="${partAnchor}" class="session-part-anchor">${renderedPart}</div>`)
    : `<span id="${partAnchor}" class="session-event-anchor" aria-hidden="true"></span>`;

  if (!childMarkup) {
    return anchoredPart;
  }

  const branch = isTaskWithSession
    ? renderSubagentBranch(part, childMarkup, provider, reasoningMarkup)
    : `<div class="subsession-branch" data-parent-part-id="${escapeHtml(part.id)}">${childMarkup}</div>`;

  return `<div id="${partAnchor}" class="session-part-anchor">${renderedPart}${branch}</div>`;
}

function attachReasoningToRenderedPart(renderedPart, reasoningMarkup) {
  if (!renderedPart || !reasoningMarkup) {
    return null;
  }

  if (renderedPart.includes('class="message message-')) {
    return renderedPart.replace("</header>", `</header><div class="message-reasoning">${reasoningMarkup}</div>`);
  }

  if (renderedPart.includes('class="tool-call ')) {
    return renderedPart.replace('<div class="tool-panels">', `<div class="tool-panels"><div class="tool-reasoning">${reasoningMarkup}</div>`);
  }

  if (renderedPart.includes('class="subagent-body"')) {
    return renderedPart.replace('<div class="subagent-body">', `<div class="subagent-body"><div class="subagent-reasoning">${reasoningMarkup}</div>`);
  }

  return null;
}

function attachPendingReasoning(renderedParts, pendingReasoning) {
  if (!pendingReasoning.length) {
    return;
  }

  const reasoningMarkup = pendingReasoning.join("\n");
  for (let index = renderedParts.length - 1; index >= 0; index -= 1) {
    const attached = attachReasoningToRenderedPart(renderedParts[index], reasoningMarkup);
    if (attached) {
      renderedParts[index] = attached;
      pendingReasoning.length = 0;
      return;
    }
  }

  renderedParts.push(`<div class="session-part-anchor">${reasoningMarkup}</div>`);
  pendingReasoning.length = 0;
}

function renderMessagePartsResult(message, depth = 0, provider = "opencode", initialReasoning = []) {
  const renderedParts = [];
  const pendingReasoning = [...initialReasoning];
  let visibleCount = 0;

  for (const part of message.parts) {
    if (part.type === "reasoning") {
      const reasoning = renderReasoningPart(part.data);
      if (reasoning) {
        pendingReasoning.push(reasoning);
      }
      continue;
    }

    const rendered = renderPartNode(message.data, part, depth, provider, pendingReasoning.join("\n"));
    if (rendered) {
      renderedParts.push(rendered);
      if (!rendered.includes("session-event-anchor")) {
        visibleCount += 1;
        pendingReasoning.length = 0;
      }
    }
  }

  return {
    markup: renderedParts.filter(Boolean).join("\n"),
    hasVisibleContent: visibleCount > 0,
    pendingReasoning
  };
}

function renderMessageParts(message, depth = 0, provider = "opencode") {
  const result = renderMessagePartsResult(message, depth, provider);
  const renderedParts = result.markup ? [result.markup] : [];
  attachPendingReasoning(renderedParts, result.pendingReasoning);
  return renderedParts.filter(Boolean).join("\n");
}

function renderSessionTree(tree: SessionTree, depth = 0, provider = "opencode") {
  const messageBlocks = [];
  let pendingReasoning = [];

  for (const message of tree.messages) {
    const result = renderMessagePartsResult(message, depth, provider, pendingReasoning);
    pendingReasoning = result.pendingReasoning;
    const messageAnchor = escapeHtml(anchorId("msg", message.id));
    if (result.hasVisibleContent && result.markup) {
      messageBlocks.push(`<article id="${messageAnchor}" class="message-group" data-role="${escapeHtml(message.role)}">${renderMessageControls(message, provider)}${result.markup}</article>`);
    } else if (!pendingReasoning.length) {
      messageBlocks.push(`<span id="${messageAnchor}" class="session-event-anchor" aria-hidden="true"></span>`);
    }
  }

  attachPendingReasoning(messageBlocks, pendingReasoning);
  const messageMarkup = messageBlocks.filter(Boolean).join("\n");

  const detachedMarkup = tree.detachedChildren
    .map((child) => renderSessionTree(child, depth + 1, provider))
    .filter(Boolean)
    .join("\n");
  const body = [messageMarkup, detachedMarkup].filter(Boolean).join("\n");

  if (depth === 0) {
    return body;
  }

  return `<details id="${escapeHtml(anchorId("session", tree.session.id || ""))}" class="subsession-container" data-session-id="${escapeHtml(tree.session.id || "")}" data-depth="${depth}">
    ${renderSubsessionHeader(tree)}
    <div class="subsession-body">
      ${body || `<p class="empty-state">${t("detail.no_messages")}</p>`}
    </div>
  </details>`;
}

function renderRawParts(messageData, parts = []) {
  const renderedParts = [];
  const pendingReasoning = [];

  for (const part of parts) {
    const partData = safeParse(part.data);
    if (partData?.type === "reasoning") {
      const reasoning = renderReasoningPart(partData);
      if (reasoning) {
        pendingReasoning.push(reasoning);
      }
      continue;
    }

    const rendered = renderPart(messageData, partData, part.id, pendingReasoning.join("\n"));
    if (rendered) {
      renderedParts.push(rendered);
      pendingReasoning.length = 0;
    }
  }

  attachPendingReasoning(renderedParts, pendingReasoning);

  return renderedParts.filter(Boolean).join("\n");
}

export function renderSessionPage({ session, sessionTree = null, sessionMetrics = null, sessionFlow = null, messages = [], partsByMessage = new Map(), todos = [], recentSessions = [], meta = null, provider = "opencode", providers = [] }) {
  const title = session.title || session.slug || session.id;
  const starred = meta?.starred ? 1 : 0;
  const actions = isOpenCodeLikeProvider(provider) ? `
      <div class="session-actions">
        <button class="star-btn action-btn ${starred ? "starred" : ""}" data-id="${escapeHtml(session.id)}">
          ${starred ? t("action.starred") : t("action.star")}
        </button>
        <button class="action-btn" data-action="rename" data-id="${escapeHtml(session.id)}">${t("action.rename")}</button>
        <a href="/api/${provider}/session/${encodeURIComponent(session.id)}/export?format=md" class="action-btn">${t("action.export_md")}</a>
        <a href="/api/${provider}/session/${encodeURIComponent(session.id)}/export?format=json" class="action-btn">${t("action.export_json")}</a>
        <button class="action-btn btn-danger" data-action="delete" data-id="${escapeHtml(session.id)}">${t("action.delete")}</button>
      </div>
  ` : "";
  const header = `
    <header class="session-header">
      <h1>${escapeHtml(title)}</h1>
      <div class="session-meta-row">
        <span class="session-directory">${escapeHtml(session.directory || "")}</span>
        <span class="session-meta-sep">·</span>
        <span>${escapeHtml(new Date(Number(session.time_created) || Date.now()).toLocaleString())}</span>
        <span class="session-meta-sep">·</span>
        <span>${escapeHtml(String(Number(session.summary_files) || 0))} ${t("detail.files")}</span>
        <span class="additions">+${escapeHtml(String(Number(session.summary_additions) || 0))}</span>
        <span class="deletions">-${escapeHtml(String(Number(session.summary_deletions) || 0))}</span>
      </div>
${actions}
    </header>
  `;

  const messageMarkup = sessionTree ? renderSessionTree(sessionTree, 0, provider) : messages.map((message) => {
    const messageData = safeParse(message.data);
    const parts = partsByMessage.get(message.id) || [];
    const renderedParts = renderRawParts(messageData, parts);
    return renderedParts ? `<article class="message-group">${renderedParts}</article>` : "";
  }).filter(Boolean).join("\n");

  const body = `
<div class="session-workbench" data-session-id="${escapeHtml(session.id)}" data-provider="${escapeHtml(provider)}">
  ${renderToc(sessionTree)}
  <main id="${escapeHtml(anchorId("session", session.id))}" class="main-content">
    ${header}
    ${renderSessionMetricsPanel(sessionMetrics)}
    ${todoList(todos)}
    <section class="messages">
      ${messageMarkup || `<p class="empty-state">${t("detail.no_messages")}</p>`}
    </section>
    ${sessionFlow ? renderCanonicalFlowPanel(sessionFlow) : renderFlowPanel(sessionTree)}
  </main>
</div>
  `;

  return layout(title, body, "home", { provider, providers });
}
