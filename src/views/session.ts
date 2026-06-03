import { escapeHtml } from "../markdown.js";
import { layout } from "./layout.js";
import { formatDuration, formatTime, messageBubble, todoList, toolCallBlock } from "./components.js";
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

function taskTitle(partData) {
  return partData?.state?.title
    || partData?.state?.input?.description
    || partData?.state?.input?.subagent_type
    || "Subagent task";
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

function renderSubagentBranch(part: SessionPartNode, childMarkup: string) {
  const data = part.data || {};
  const status = partStatus(data);
  const duration = part.timeStart && part.timeEnd ? formatDuration(part.timeStart, part.timeEnd) : "";
  const meta = [
    `${part.childSessions.length} ${part.childSessions.length === 1 ? "branch" : "branches"}`,
    status,
    duration
  ].filter(Boolean).join(" · ");

  return `<details class="subagent-branch" data-parent-part-id="${escapeHtml(part.id)}" open>
    <summary class="subagent-summary" aria-label="${escapeHtml(`Toggle subagent ${taskTitle(data)}`)}">
      <span class="subsession-kicker">subagent</span>
      <span class="subsession-title">${escapeHtml(taskTitle(data))}</span>
      ${meta ? `<span class="subsession-meta">${escapeHtml(meta)}</span>` : ""}
    </summary>
    <div class="subagent-body">
      ${childMarkup}
    </div>
  </details>`;
}

function collectTocItems(tree: SessionTree, depth = 0) {
  const items = [];
  const session = tree.session || {};
  items.push({
    id: anchorId("session", session.id || "root"),
    type: depth ? "Branch" : "Session",
    label: session.title || session.slug || session.id || "Session",
    meta: depth ? `${formatCount(tree.metrics.totalMessages)} msg` : "root",
    depth
  });

  for (const message of tree.messages) {
    if (message.role) {
      items.push({
        id: anchorId("msg", message.id),
        type: message.role,
        label: messageText(message) || `${message.role} message`,
        meta: formatTime(message.timeCreated),
        depth
      });
    }

    for (const part of message.parts) {
      if (part.type === "tool") {
        const isTask = isTaskTool(part.tool);
        items.push({
          id: anchorId("part", part.id),
          type: isTask ? "Task" : "Tool",
          label: isTask ? taskTitle(part.data) : toolTitle(part.data),
          meta: part.childSessions.length ? `${part.childSessions.length} branch` : partStatus(part.data) || part.tool || "tool",
          depth
        });
      }
      for (const child of part.childSessions) {
        items.push(...collectTocItems(child, depth + 1));
      }
    }
  }

  for (const child of tree.detachedChildren) {
    items.push(...collectTocItems(child, depth + 1));
  }
  return items;
}

function collectContextTocItems(sessionContext) {
  const steps = Array.isArray(sessionContext?.steps) ? sessionContext.steps : [];
  return steps.map((step) => ({
    id: anchorId("context-step", step.index),
    type: "Context",
    label: `Step ${step.index}`,
    meta: step.snapshotId ? `snapshot ${String(step.snapshotId).slice(0, 8)}` : "reconstructed",
    depth: 0
  }));
}

function renderToc(tree: SessionTree | null, sessionContext = null) {
  if (!tree && !sessionContext) {
    return `<aside class="session-toc"><h2>Navigate</h2><p class="toc-empty">No indexed prompts.</p></aside>`;
  }

  const items = [
    ...(tree ? collectTocItems(tree) : []),
    ...collectContextTocItems(sessionContext)
  ];
  const markup = items.map((item) => `
    <a class="toc-link toc-${escapeHtml(item.type.toLowerCase())}" href="#${escapeHtml(item.id)}" style="--toc-depth:${Math.min(item.depth, 6)}">
      <span class="toc-type">${escapeHtml(item.type)}</span>
      <span class="toc-label">${escapeHtml(item.label)}</span>
      ${item.meta ? `<span class="toc-meta">${escapeHtml(item.meta)}</span>` : ""}
    </a>
  `).join("\n");

  return `<aside class="session-toc">
    <h2>Navigate</h2>
    <div class="toc-list">${markup || `<p class="toc-empty">No indexed prompts.</p>`}</div>
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
  if (!tree) {
    return `<aside class="session-flow"><h2>Flow</h2><p class="toc-empty">No flow data.</p></aside>`;
  }

  const metrics = tree.metrics;
  return `<aside class="session-flow">
    <h2>Flow</h2>
    <div class="flow-summary">
      ${renderMetric("messages", formatCount(metrics.totalMessages))}
      ${renderMetric("tools", formatCount(metrics.totalToolCalls))}
      ${renderMetric("branches", formatCount(metrics.descendantCount))}
      ${metrics.cost ? renderMetric("cost", `$${metrics.cost.toFixed(3)}`) : ""}
    </div>
    <ul class="flow-tree">${renderFlowSession(tree)}</ul>
  </aside>`;
}

function flowHref(node) {
  const [kind, ...rest] = String(node.id || "").split(":");
  const id = rest.join(":");
  if (kind === "session") return `#${anchorId("session", id)}`;
  if (kind === "msg") return `#${anchorId("msg", id)}`;
  if (kind === "part") return `#${anchorId("part", id)}`;
  return "#";
}

function renderCanonicalFlowNode(node, depth = 0) {
  const kind = node.kind || "part";
  const children = Array.isArray(node.children) ? node.children : [];
  const meta = [node.meta, node.status].filter(Boolean).join(" · ");
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

  const summary = sessionFlow.summary || {};
  return `<aside class="session-flow">
    <h2>Flow</h2>
    <div class="flow-summary">
      ${renderMetric("nodes", formatCount(summary.totalNodes))}
      ${renderMetric("tools", formatCount(summary.tools))}
      ${renderMetric("subagents", formatCount(summary.subagents))}
      ${summary.totalCost ? renderMetric("cost", `$${Number(summary.totalCost).toFixed(3)}`) : ""}
    </div>
    <ul class="flow-tree">${renderCanonicalFlowNode(sessionFlow.root)}</ul>
  </aside>`;
}

function renderContextItem(item) {
  return `<li class="context-item context-${escapeHtml(item.kind || "unknown")}">
    <span class="context-kind">${escapeHtml(item.kind || "item")}</span>
    <span class="context-title">${escapeHtml(item.title || item.id || "")}</span>
    ${item.preview ? `<span class="context-preview">${escapeHtml(item.preview)}</span>` : ""}
  </li>`;
}

function renderContextPanel(sessionContext) {
  if (!sessionContext) {
    return "";
  }

  const steps = Array.isArray(sessionContext.steps) ? sessionContext.steps : [];
  const rows = steps.map((step) => {
    const tokens = step.tokens && typeof step.tokens === "object"
      ? [
        step.tokens.total != null ? `${Number(step.tokens.total).toLocaleString()} tokens` : "",
        step.tokens.input != null ? `${Number(step.tokens.input).toLocaleString()} in` : "",
        step.tokens.output != null ? `${Number(step.tokens.output).toLocaleString()} out` : ""
      ].filter(Boolean).join(" · ")
      : "";
    const meta = [
      step.snapshotId ? `snapshot ${step.snapshotId.slice(0, 8)}` : "no snapshot",
      step.reason,
      tokens,
      step.cost ? `$${Number(step.cost).toFixed(4)}` : ""
    ].filter(Boolean).join(" · ");
    const items = (step.items || []).slice(-12);

    return `<details id="${escapeHtml(anchorId("context-step", step.index))}" class="context-step">
      <summary class="context-summary" aria-label="${escapeHtml(`Toggle context step ${step.index}`)}">
        <span class="context-step-index">step ${escapeHtml(String(step.index))}</span>
        <span class="context-step-title">${escapeHtml(`${items.length} reconstructed context items`)}</span>
        <span class="context-step-meta">${escapeHtml(meta)}</span>
      </summary>
      <ul class="context-list">
        ${items.map(renderContextItem).join("\n") || `<li class="context-item"><span class="context-preview">No reconstructable context items.</span></li>`}
      </ul>
    </details>`;
  }).join("\n");

  return `<section class="context-panel" id="context-view">
    <header class="context-panel-header">
      <h2>Context</h2>
      <p>${escapeHtml(sessionContext.note || "Reconstructed context view.")}</p>
    </header>
    ${rows || `<p class="empty-state">No step context found.</p>`}
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

function renderPart(messageData, partData, partId) {
  if (!partData || typeof partData !== "object") {
    return "";
  }

  if (partData.type === "text") {
    return messageBubble(messageData.role, partData.text || "", {
      model: messageModelLabel(messageData),
      tokens: messageData.tokens,
      time: messageData.time?.created
    });
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
      partId
    );
  }

  if (["step-start", "step-finish", "snapshot", "patch"].includes(partData.type)) {
    return "";
  }

  return "";
}

function renderPartNode(messageData, part: SessionPartNode, depth = 0) {
  const isTaskWithSession = part.type === "tool" && isTaskTool(part.tool) && part.childSessions.length > 0;
  const renderedPart = isTaskWithSession ? "" : renderPart(messageData, part.data, part.id);
  const childMarkup = part.childSessions
    .map((child) => renderSessionTree(child, depth + 1))
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
    ? renderSubagentBranch(part, childMarkup)
    : `<div class="subsession-branch" data-parent-part-id="${escapeHtml(part.id)}">${childMarkup}</div>`;

  return `<div id="${partAnchor}" class="session-part-anchor">${renderedPart}${branch}</div>`;
}

function renderSessionTree(tree: SessionTree, depth = 0) {
  const messageMarkup = tree.messages.map((message) => {
    const renderedParts = message.parts
      .map((part) => renderPartNode(message.data, part, depth))
      .filter(Boolean)
      .join("\n");
    const messageAnchor = escapeHtml(anchorId("msg", message.id));
    return renderedParts
      ? `<article id="${messageAnchor}" class="message-group" data-role="${escapeHtml(message.role)}">${renderedParts}</article>`
      : `<span id="${messageAnchor}" class="session-event-anchor" aria-hidden="true"></span>`;
  }).filter(Boolean).join("\n");

  const detachedMarkup = tree.detachedChildren
    .map((child) => renderSessionTree(child, depth + 1))
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

export function renderSessionPage({ session, sessionTree = null, sessionContext = null, sessionMetrics = null, sessionFlow = null, messages = [], partsByMessage = new Map(), todos = [], recentSessions = [], meta = null, provider = "opencode", providers = [] }) {
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

  const messageMarkup = sessionTree ? renderSessionTree(sessionTree) : messages.map((message) => {
    const messageData = safeParse(message.data);
    const parts = partsByMessage.get(message.id) || [];
    const renderedParts = parts.map((part) => renderPart(messageData, safeParse(part.data), part.id)).filter(Boolean).join("\n");
    return renderedParts ? `<article class="message-group">${renderedParts}</article>` : "";
  }).filter(Boolean).join("\n");

  const body = `
<div class="session-workbench" data-session-id="${escapeHtml(session.id)}" data-provider="${escapeHtml(provider)}">
  ${renderToc(sessionTree, sessionContext)}
  <main id="${escapeHtml(anchorId("session", session.id))}" class="main-content">
    ${header}
    ${renderSessionMetricsPanel(sessionMetrics)}
    ${todoList(todos)}
    ${renderContextPanel(sessionContext)}
    <section class="messages">
      ${messageMarkup || `<p class="empty-state">${t("detail.no_messages")}</p>`}
    </section>
  </main>
  ${sessionFlow ? renderCanonicalFlowPanel(sessionFlow) : renderFlowPanel(sessionTree)}
</div>
  `;

  return layout(title, body, "home", { provider, providers });
}
