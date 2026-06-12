import { t } from "../i18n.js";
import { escapeHtml } from "../markdown.js";
import type { SessionPartNode, SessionTree } from "../providers/opencode/session-tree.js";
import { formatDuration, formatTime, formatTokens, messageBubble, messageHeader, reasoningBlock, todoList, toolCallBlock } from "./components.js";
import { layout } from "./layout.js";

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
  if (typeof model === "string") {
    return model;
  }
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

function cacheUsage(messageData) {
  const tokens = messageData?.tokens;
  if (!tokens || typeof tokens !== "object") {
    return null;
  }

  const uncached = Number(tokens.input) || 0;
  const read = Number(tokens.cache?.read) || 0;
  const write = Number(tokens.cache?.write) || 0;
  const prompt = uncached + read + write;
  if (!prompt) {
    return null;
  }

  return {
    model: messageModelLabel(messageData),
    prompt,
    rate: read / prompt
  };
}

function annotateCacheWarning(message, previousUsage) {
  const usage = cacheUsage(message.data);
  const sameModel = usage?.model && usage.model === previousUsage?.model;
  const unusualMiss = sameModel
    && usage.prompt >= 8192
    && previousUsage.prompt >= 8192
    && usage.rate < 0.01
    && previousUsage.rate >= 0.5;
  if (!unusualMiss) {
    return { message, usage };
  }

  return {
    message: {
      ...message,
      data: {
        ...message.data,
        cacheWarning: {
          previousRate: `${(previousUsage.rate * 100).toFixed(1)}%`
        }
      }
    },
    usage
  };
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
  const cleanId = String(id || "").replace(/[^A-Za-z0-9_-]/g, "-");
  const normalizedPrefix = prefix.endsWith("-") ? prefix.slice(0, -1) : prefix;
  const alreadyHasPrefix = cleanId.toLowerCase().startsWith(normalizedPrefix.toLowerCase() + "-") || cleanId.toLowerCase().startsWith(normalizedPrefix.toLowerCase() + "_");
  return alreadyHasPrefix ? cleanId : `${normalizedPrefix}-${cleanId}`;
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

function messageToolName(message) {
  const toolPart = message.parts.find((part) => part.type === "tool");
  if (!toolPart) return "";
  const input = toolPart.data?.state?.input || {};
  return String(input.description || input.command || input.filePath || toolPart.tool || "");
}

function messageText(message) {
  const textPart = message.parts.find((part) => part.type === "text" && part.data?.text);
  return compactText(textPart?.data?.text || message.data?.summary || messageToolName(message) || message.id, 86);
}

function tocMessageText(message) {
  const textPart = message.parts.find((part) => part.type === "text" && compactText(part.data?.text));
  return compactText(textPart?.data?.text || "", 86);
}

function hasVisibleMessagePart(message) {
  return message.parts.some(isVisiblePartNode);
}

function isVisiblePartNode(part) {
  if (part.childSessions.length > 0) {
    return true;
  }
  if (part.type === "text") {
    return Boolean(part.data?.text);
  }
  return part.type === "tool";
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
  const childMetrics = part.childSessions[0]?.metrics;
  const childTokens = childMetrics ? {
    input: childMetrics.inputTokens,
    output: childMetrics.outputTokens,
    reasoning: childMetrics.reasoningTokens,
    cache: {
      read: childMetrics.cacheReadTokens,
      write: childMetrics.cacheWriteTokens
    },
    total: childMetrics.inputTokens
      + childMetrics.outputTokens
      + childMetrics.reasoningTokens
      + childMetrics.cacheReadTokens
      + childMetrics.cacheWriteTokens
  } : null;
  const tokenMarkup = formatTokens(childTokens);
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
      ${tokenMarkup ? `<span class="message-tokens subagent-tokens" title="Subagent session token usage">${tokenMarkup}</span>` : ""}
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

function messageTurnRole(role) {
  const normalized = String(role || "assistant").toLowerCase();
  if (normalized === "agent") return "assistant";
  if (normalized === "tool") return "assistant";
  return normalized;
}

function hasOwnMessageBubble(message) {
  return Array.isArray(message.parts)
    && message.parts.some((part) => part.type === "text" && Boolean(part.data?.text));
}

function renderMessageGroup(message, markup, provider: string) {
  const role = messageTurnRole(message.role);
  const messageAnchor = escapeHtml(anchorId("msg", message.id));
  const data = message.data || {};
  const toolOnlyHeader = role === "assistant" && !hasOwnMessageBubble(message)
    ? messageHeader(role, {
      model: messageModelLabel(data),
      tokens: data.tokens,
      cacheWarning: data.cacheWarning,
      time: data.time?.created
    })
    : "";
  return `<article id="${messageAnchor}" class="message-group message-turn message-turn-${escapeHtml(role)}" data-role="${escapeHtml(role)}">${renderMessageControls(message, provider)}${toolOnlyHeader}${markup}</article>`;
}

function renderSubagentChildSession(tree: SessionTree, provider: string) {
  const messageBlocks = [];
  let previousCacheUsage = null;

  for (const sourceMessage of tree.messages) {
    const annotated = annotateCacheWarning(sourceMessage, previousCacheUsage);
    const message = annotated.message;
    if (annotated.usage && messageTurnRole(message.role) === "assistant") {
      previousCacheUsage = annotated.usage;
    }
    const result = renderMessagePartsResult(message, 0, provider);
    if (result.hasVisibleContent && result.markup) {
      const group = [renderMessageGroup(message, result.markup, provider)];
      attachPendingReasoning(group, result.pendingReasoning);
      messageBlocks.push(group[0]);
    } else if (result.pendingReasoning.length && messageTurnRole(message.role) === "assistant") {
      messageBlocks.push(renderMessageGroup(
        message,
        renderTurnReasoning(result.pendingReasoning.join("\n")),
        provider
      ));
    } else if (!result.pendingReasoning.length && hasVisibleMessagePart(message)) {
      const messageAnchor = escapeHtml(anchorId("msg", message.id));
      messageBlocks.push(`<span id="${messageAnchor}" class="session-event-anchor" aria-hidden="true"></span>`);
    }
  }

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
    if (!isNavigableMessageRole(role)) {
      continue;
    }

    const label = tocMessageText(message);
    const agentDepth = userDepth + 1;
    const taskNodes = collectMessageTaskTocNodes(message, label ? agentDepth : userDepth);
    if (!label) {
      if (taskNodes.length) {
        if (currentUserNode) {
          currentUserNode.children.push(...taskNodes);
        } else {
          nodes.push(...taskNodes);
        }
      }
      continue;
    }

    if (role === "user") {
      currentUserNode = makeTocNode(
        anchorId("msg", message.id),
        message.role,
        label,
        "",
        userDepth
      );
      nodes.push(currentUserNode);
      continue;
    }

    const node = makeTocNode(
      anchorId("msg", message.id),
      message.role,
      label,
      "",
      agentDepth
    );
    node.children.push(...taskNodes);

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
  const normalizedType = String(node.type || "").toLowerCase();
  const typeName = normalizedType === "user"
    ? "User"
    : normalizedType === "assistant" || normalizedType === "agent"
      ? "Agent"
      : normalizedType === "task"
        ? "Task"
        : normalizedType;
  const typeLabel = typeName.slice(0, 1).toUpperCase();
  const linkTitle = [typeName, node.label, node.meta].filter(Boolean).join(" - ");
  const link = `<a class="toc-link toc-${escapeHtml(node.type.toLowerCase())}" href="#${escapeHtml(node.id)}" title="${escapeHtml(linkTitle)}" style="--toc-depth:${Math.min(node.depth, 6)}">
      <span class="toc-type" title="${escapeHtml(typeName)}" aria-label="${escapeHtml(typeName)}">${escapeHtml(typeLabel)}</span>
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
    return `<aside class="session-toc"><h2>Navigate</h2><p class="toc-empty">No indexed messages.</p><button class="toc-resize-handle" type="button" aria-label="Resize table of contents"></button></aside>`;
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
    <button class="toc-resize-handle" type="button" aria-label="Resize table of contents"></button>
  </aside>`;
}

function renderFlowPanel(_tree: SessionTree | null) {
  return `<section id="session-flow-panel" class="session-flow-panel hidden" tabindex="-1" aria-hidden="true">
    <div class="flow-panel-header">
      <h2>Conversation Flow</h2>
      <button type="button" class="flow-close-btn" data-flow-close aria-label="Close flow">x</button>
    </div>
    <p class="toc-empty">No flow data.</p>
  </section>`;
}

function flowHref(node) {
  const target = node?.target;
  if (!target?.kind || !target?.id) {
    return "#";
  }
  if (target.kind === "session") return `#${anchorId("session", target.id)}`;
  if (target.kind === "msg") return `#${anchorId("msg", target.id)}`;
  if (target.kind === "part") return `#${anchorId("part", target.id)}`;
  return "#";
}

function flowNodeDetails(node) {
  const metrics = node?.metrics || {};
  const operationalMeta = [
    metrics.duration ? formatMilliseconds(metrics.duration) : "",
    metrics.errors ? `${formatCount(metrics.errors)} errors` : "",
    metrics.tokens ? `${formatCount(metrics.tokens)} tokens` : "",
    node.inferred ? "inferred attachment" : ""
  ].filter(Boolean).join(" · ");
  const isMessage = node.kind === "user" || node.kind === "agent";
  const status = node.status === "tool calls" || node.status === "stop" ? "" : node.status;
  return [isMessage ? "" : node.meta, operationalMeta, status].filter(Boolean).join(" · ");
}

function renderFlowMapNode(node) {
  const kind = node.kind || "agent";
  const label = compactText(node.label, kind === "user" ? 64 : 48) || kind;
  const details = flowNodeDetails(node);
  const classes = [
    "flow-map-node",
    `flow-map-node-${kind}`,
    node.inferred ? "flow-map-node-inferred" : "",
    node?.metrics?.errors ? "flow-map-node-error" : ""
  ].filter(Boolean).join(" ");
  const accessibleTitle = [label, details].filter(Boolean).join(" — ");

  if (kind === "agent") {
    const agentClasses = `${classes} ${node.emphasis === "final" ? "flow-map-node-agent-final" : ""}`.trim();
    return `<a class="${agentClasses}" href="${escapeHtml(flowHref(node))}" title="${escapeHtml(accessibleTitle)}" aria-label="${escapeHtml(accessibleTitle)}">
      <span class="flow-map-agent-label">${escapeHtml(label)}</span>
      ${details ? `<span class="flow-map-agent-meta">${escapeHtml(details)}</span>` : ""}
    </a>`;
  }

  if (kind === "return") {
    return `<a class="${classes}" href="${escapeHtml(flowHref(node))}" title="${escapeHtml(accessibleTitle)}" aria-label="${escapeHtml(accessibleTitle)}">
      <span class="flow-map-return-mark"></span>
      <span class="flow-map-node-popover">Return</span>
    </a>`;
  }

  const typeLabel = kind === "user" ? "User" : "Subagent";
  return `<a class="${classes}" href="${escapeHtml(flowHref(node))}" title="${escapeHtml(accessibleTitle)}">
    <span class="flow-map-node-kind">${escapeHtml(typeLabel)}</span>
    <span class="flow-map-node-label">${escapeHtml(label)}</span>
    ${details ? `<span class="flow-map-node-meta">${escapeHtml(details)}</span>` : ""}
  </a>`;
}

function flowBranchTemplateId(invocation, branch, index) {
  return anchorId("flow-branch", `${invocation.id}-${branch.id}-${index}`);
}

function renderFlowBranchSummary(invocation, branch, index) {
  const metrics = branch?.metrics || {};
  const line = Array.isArray(branch?.line) ? branch.line : [];
  const messageCount = line.filter((node) => node.kind === "user" || node.kind === "agent").length;
  const templateId = flowBranchTemplateId(invocation, branch, index);
  const meta = [
    messageCount ? `${formatCount(messageCount)} messages` : "",
    metrics.duration ? formatMilliseconds(metrics.duration) : "",
    metrics.tokens ? `${formatCount(metrics.tokens)} tokens` : "",
    metrics.errors ? `${formatCount(metrics.errors)} errors` : ""
  ].filter(Boolean).join(" · ");
  return `<button type="button" class="flow-branch-summary ${metrics.errors ? "flow-branch-summary-error" : ""}" data-flow-branch-open="${escapeHtml(templateId)}">
    <span class="flow-branch-summary-title">${escapeHtml(compactText(branch.label, 52) || "Subagent")}</span>
    <span class="flow-branch-summary-meta">${escapeHtml(meta || "No message data")}</span>
    <span class="flow-branch-summary-action">Inspect</span>
  </button>
  <template id="${escapeHtml(templateId)}" data-flow-branch-template>
    <div class="flow-branch-detail-content">
      <div class="flow-branch-detail-heading">
        <strong>${escapeHtml(compactText(branch.label, 96) || "Subagent")}</strong>
        <span>${escapeHtml(meta)}</span>
      </div>
      ${renderFlowMapSession(branch, 1)}
    </div>
  </template>`;
}

function renderFlowInvocationGroup(invocations, returnNodes) {
  const inferred = invocations.some((node) => node.inferred);
  const branchCount = invocations.reduce((sum, node) => sum + (Array.isArray(node.branches) ? node.branches.length : 0), 0);
  const summaries = invocations.flatMap((invocation) => {
    const branches = Array.isArray(invocation.branches) ? invocation.branches : [];
    if (!branches.length) {
      return [`<div class="flow-branch-summary flow-branch-summary-empty">
        <span class="flow-branch-summary-title">${escapeHtml(compactText(invocation.label, 52) || "Subagent")}</span>
        <span class="flow-branch-summary-meta">No child session data</span>
      </div>`];
    }
    return branches.map((branch, index) => renderFlowBranchSummary(invocation, branch, index));
  }).join("\n");
  const groupLabel = invocations.length === 1
    ? compactText(invocations[0].label, 44) || "Subagent"
    : `${formatCount(invocations.length)} parallel calls`;
  const returnNode = returnNodes.get(invocations[invocations.length - 1].id);

  return `<div class="flow-map-step flow-map-fork flow-map-fork-collapsed ${inferred ? "flow-map-fork-inferred" : ""}" data-invocation-group="${escapeHtml(invocations.map((node) => node.id).join(","))}" data-invocation-count="${invocations.length}">
    <div class="flow-fanout-main">
      <div class="flow-fanout-node flow-map-node-invocation">
        <span class="flow-map-node-kind">Subagent</span>
        <span class="flow-map-node-label">${escapeHtml(groupLabel)}</span>
        <span class="flow-map-node-meta">${formatCount(branchCount)} ${branchCount === 1 ? "branch" : "branches"}</span>
      </div>
      <span class="flow-fanout-span" aria-hidden="true"></span>
      ${returnNode ? renderFlowMapNode(returnNode) : ""}
    </div>
    <div class="flow-branch-summaries">${summaries}</div>
  </div>`;
}

function renderFlowMapSession(session, depth = 0) {
  const line = Array.isArray(session?.line) ? session.line : [];
  const returnNodes = new Map(
    line.filter((node) => node.kind === "return").map((node) => [node.invocationId, node])
  );
  const rendered = [];

  for (let index = 0; index < line.length; index += 1) {
    const node = line[index];
    if (node.kind === "return") {
      continue;
    }
    if (node.kind !== "invocation") {
      rendered.push(`<div class="flow-map-step">${renderFlowMapNode(node)}</div>`);
      continue;
    }

    const invocations = [node];
    let cursor = index + 2;
    while (line[cursor]?.kind === "invocation") {
      invocations.push(line[cursor]);
      cursor += 2;
    }
    index = cursor - 1;
    rendered.push(renderFlowInvocationGroup(invocations, returnNodes));
  }

  const sessionClasses = [
    "flow-map-session",
    depth ? "flow-map-branch-session" : "flow-map-root-session",
    session.inferred ? "flow-map-session-inferred" : ""
  ].filter(Boolean).join(" ");
  return `<section class="${sessionClasses}" data-flow-session-id="${escapeHtml(session.id)}" data-flow-depth="${depth}">
    ${depth ? `<a class="flow-map-branch-title" href="${escapeHtml(flowHref(session))}">${escapeHtml(compactText(session.label, 72) || "Subagent")}</a>` : ""}
    <div class="flow-map-line">${rendered.join("\n") || `<span class="flow-map-empty-branch">No user or agent messages</span>`}</div>
  </section>`;
}

function renderFlowMapSummary(summary) {
  const stats = [
    ["Duration", formatMilliseconds(summary.totalDuration)],
    ["Tools", formatCount(summary.toolCalls)],
    ["Errors", summary.errors ? `${formatCount(summary.errors)} · ${formatPercent(summary.errorRate)}` : "0"],
    ["Tokens", formatCount(summary.totalTokens)],
    ["Cost", `$${Number(summary.totalCost || 0).toFixed(4)}`],
    ["Subagents", formatCount(summary.subagents)]
  ];
  return `<div class="flow-map-stats" aria-label="Flow summary">
    ${stats.map(([label, value]) => `<span class="flow-map-stat"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></span>`).join("\n")}
  </div>`;
}

function renderFlowMapOverview(root) {
  const line = Array.isArray(root?.line) ? root.line : [];
  const marks = line
    .filter((node) => node.kind !== "return")
    .map((node) => `<span class="flow-map-overview-mark flow-map-overview-${escapeHtml(node.kind)} ${node.emphasis === "final" ? "flow-map-overview-final" : ""}"></span>`)
    .join("");
  return `<div class="flow-map-overview" data-flow-overview aria-label="Flow overview">
    <div class="flow-map-overview-track">${marks}<span class="flow-map-overview-window" data-flow-overview-window></span></div>
  </div>`;
}

function renderCanonicalFlowPanel(sessionFlow) {
  if (!sessionFlow?.root) {
    return "";
  }

  return `<section id="session-flow-panel" class="session-flow-panel hidden" tabindex="-1" aria-hidden="true">
    <div class="flow-panel-header">
      <div>
        <h2>Conversation Flow</h2>
        <p>Conversation order with subagent forks and returns</p>
      </div>
      <button type="button" class="flow-close-btn" data-flow-close aria-label="Close flow">x</button>
    </div>
    ${renderFlowMapSummary(sessionFlow.summary || {})}
    ${renderFlowMapOverview(sessionFlow.root)}
    <div class="flow-map-scroll">
      <div class="flow-map">${renderFlowMapSession(sessionFlow.root)}</div>
    </div>
    <aside class="flow-branch-drawer hidden" data-flow-branch-drawer aria-hidden="true">
      <div class="flow-branch-drawer-header">
        <div>
          <h3>Subagent Detail</h3>
          <p>Focused child-session flow</p>
        </div>
        <button type="button" class="flow-branch-drawer-close" data-flow-branch-close aria-label="Close subagent detail">x</button>
      </div>
      <div class="flow-branch-drawer-body" data-flow-branch-body></div>
    </aside>
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
    `${formatCount((Number(totals.outputTokens) || 0) + (Number(totals.reasoningTokens) || 0))} out`,
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

function renderTurnReasoning(reasoningMarkup) {
  return reasoningMarkup ? `<div class="turn-reasoning">${reasoningMarkup}</div>` : "";
}

function renderPart(messageData, partData, partId, reasoningMarkup = "") {
  if (!partData || typeof partData !== "object") {
    return "";
  }

  if (partData.type === "text") {
    if (!partData.text) {
      return "";
    }
    return messageBubble(messageData.role, partData.text, {
      model: messageModelLabel(messageData),
      tokens: messageData.tokens,
      cacheWarning: messageData.cacheWarning,
      time: messageData.time?.created
    });
  }

  if (partData.type === "reasoning") {
    return "";
  }

  if (partData.type === "tool") {
    const state = partData.state && typeof partData.state === "object" ? partData.state : {};
    const timing = state.time && typeof state.time === "object" ? state.time : {};
    const output = state.status === "error" ? (state.error ?? state.output) : state.output;
    return toolCallBlock(
      partData.tool,
      state.input,
      output,
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

function renderPartNode(messageData, part: SessionPartNode, depth = 0, provider = "opencode", reasoningMarkup = "") {
  const isTaskWithSession = part.type === "tool" && isTaskTool(part.tool) && part.childSessions.length > 0;
  const renderedPart = isTaskWithSession ? "" : renderPart(messageData, part.data, part.id, reasoningMarkup);
  const partAnchor = escapeHtml(anchorId("part", part.id));
  const anchoredPart = renderedPart
    ? (part.type === "tool" ? renderedPart : `<div id="${partAnchor}" class="session-part-anchor">${renderedPart}</div>`)
    : `<span id="${partAnchor}" class="session-event-anchor" aria-hidden="true"></span>`;

  // A task can produce more than one child session. Give each child its own
  // branch container so navigation, export actions, and QA identify every
  // session instead of collapsing several IDs into one visual branch.
  if (isTaskWithSession) {
    const branches = part.childSessions.map((child, index) => (
      renderSubagentBranch(
        { ...part, childSessions: [child] },
        renderSubagentChildSession(child, provider),
        provider,
        index === 0 ? reasoningMarkup : ""
      )
    )).join("\n");
    return `<div id="${partAnchor}" class="session-part-anchor">${branches}</div>`;
  }

  const childMarkup = part.childSessions
    .map((child) => renderSubagentChildSession(child, provider))
    .filter(Boolean)
    .join("\n");
  if (!childMarkup && !renderedPart) {
    return "";
  }

  const branch = `<div class="subsession-branch" data-parent-part-id="${escapeHtml(part.id)}">${childMarkup}</div>`;

  return `<div id="${partAnchor}" class="session-part-anchor">${renderedPart}${branch}</div>`;
}

function attachReasoningToRenderedPart(renderedPart, reasoningMarkup) {
  if (!renderedPart || !reasoningMarkup) {
    return null;
  }

  if (renderedPart.includes('class="message-group message-turn ')) {
    return renderedPart.replace("</article>", `${renderTurnReasoning(reasoningMarkup)}</article>`);
  }

  if (renderedPart.includes('class="message message-')) {
    return renderedPart.replace("</header>", `</header><div class="message-reasoning">${reasoningMarkup}</div>`);
  }

  if (renderedPart.includes('class="tool-call ')) {
    return `${renderedPart}${renderTurnReasoning(reasoningMarkup)}`;
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

    const reasoningMarkup = pendingReasoning.join("\n");
    const isToolPart = part.type === "tool";
    let rendered = renderPartNode(message.data, part, depth, provider, isToolPart ? "" : reasoningMarkup);
    if (rendered && reasoningMarkup && isToolPart) {
      rendered = `${renderTurnReasoning(reasoningMarkup)}\n${rendered}`;
    } else if (rendered && reasoningMarkup && !rendered.includes(reasoningMarkup) && !(part.type === "text" && !part.data?.text)) {
      rendered = attachReasoningToRenderedPart(rendered, reasoningMarkup) || rendered;
    }
    if (rendered) {
      renderedParts.push(rendered);
      // Child markup can contain hidden event anchors even when the task branch
      // itself is visible. Classify the source part, not its generated HTML.
      if (isVisiblePartNode(part)) {
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
  let previousCacheUsage = null;

  for (const sourceMessage of tree.messages) {
    const annotated = annotateCacheWarning(sourceMessage, previousCacheUsage);
    const message = annotated.message;
    if (annotated.usage && messageTurnRole(message.role) === "assistant") {
      previousCacheUsage = annotated.usage;
    }
    const result = renderMessagePartsResult(message, depth, provider);
    if (result.hasVisibleContent && result.markup) {
      const group = [renderMessageGroup(message, result.markup, provider)];
      attachPendingReasoning(group, result.pendingReasoning);
      messageBlocks.push(group[0]);
    } else if (result.pendingReasoning.length && messageTurnRole(message.role) === "assistant") {
      messageBlocks.push(renderMessageGroup(
        message,
        renderTurnReasoning(result.pendingReasoning.join("\n")),
        provider
      ));
    } else if (!result.pendingReasoning.length && hasVisibleMessagePart(message)) {
      const messageAnchor = escapeHtml(anchorId("msg", message.id));
      messageBlocks.push(`<span id="${messageAnchor}" class="session-event-anchor" aria-hidden="true"></span>`);
    }
  }

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

    const reasoningMarkup = pendingReasoning.join("\n");
    const renderedPart = renderPart(messageData, partData, part.id, partData?.type === "tool" ? "" : reasoningMarkup);
    const rendered = renderedPart && reasoningMarkup && partData?.type === "tool"
      ? `${renderTurnReasoning(reasoningMarkup)}\n${renderedPart}`
      : renderedPart;
    if (rendered) {
      renderedParts.push(rendered);
      pendingReasoning.length = 0;
    }
  }

  attachPendingReasoning(renderedParts, pendingReasoning);

  return renderedParts.filter(Boolean).join("\n");
}

function renderRawMessageGroups(messages, partsByMessage, provider) {
  const groups = [];
  let previousCacheUsage = null;

  for (const message of messages) {
    const parsedData = safeParse(message.data);
    const annotated = annotateCacheWarning(
      { id: message.id, role: parsedData.role, data: parsedData, parts: [] },
      previousCacheUsage
    );
    const messageData = annotated.message.data;
    if (annotated.usage && messageTurnRole(messageData.role) === "assistant") {
      previousCacheUsage = annotated.usage;
    }
    const parts = partsByMessage.get(message.id) || [];
    const renderedParts = renderRawParts(messageData, parts);
    if (!renderedParts) {
      continue;
    }

    const role = messageTurnRole(messageData.role);
    const previous = groups[groups.length - 1];
    if (String(messageData.role || "").toLowerCase() === "tool" && previous?.role === "assistant") {
      previous.markup.push(renderedParts);
      continue;
    }

    groups.push({
      role,
      message: {
        id: message.id,
        role,
        data: messageData,
        parts: parts.map((part) => ({ id: part.id, data: safeParse(part.data), type: safeParse(part.data)?.type }))
      },
      markup: [renderedParts]
    });
  }

  return groups
    .map((group) => renderMessageGroup(group.message, group.markup.join("\n"), provider))
    .join("\n");
}

export function renderSessionPage({
  session,
  sessionTree = null,
  sessionMetrics = null,
  sessionFlow = null,
  messages = [],
  partsByMessage = new Map(),
  todos = [],
  recentSessions = [],
  meta = null,
  provider = "opencode",
  providers = [],
  manageable = false,
  resumeCommand = null,
  analysisAction = null,
  analysisRuns = [],
  terminalLaunchAllowed = false
}) {
  const title = session.title || session.slug || session.id;
  const starred = meta?.starred ? 1 : 0;
  const managementActions = manageable ? `
        <button class="star-btn action-btn ${starred ? "starred" : ""}" data-id="${escapeHtml(session.id)}">
          ${starred ? t("action.starred") : t("action.star")}
        </button>
        <button class="action-btn" data-action="rename" data-id="${escapeHtml(session.id)}">${t("action.rename")}</button>
        <a href="/api/${provider}/session/${encodeURIComponent(session.id)}/export?format=md" class="action-btn">${t("action.export_md")}</a>
        <a href="/api/${provider}/session/${encodeURIComponent(session.id)}/export?format=json" class="action-btn">${t("action.export_json")}</a>
        <button class="action-btn btn-danger" data-action="delete" data-id="${escapeHtml(session.id)}">${t("action.delete")}</button>
  ` : "";
  const resumeActions = resumeCommand && terminalLaunchAllowed ? `
        <button class="action-btn" data-action="resume-session" data-id="${escapeHtml(session.id)}" ${resumeCommand.available ? "" : "disabled"}>${t("action.open_terminal")}</button>
  ` : "";
  const analysisTargets = Array.isArray(analysisAction?.targets) ? analysisAction.targets : [];
  const selectedAnalysisTargets = new Set(
    Array.isArray(analysisAction?.selectedTargets)
      ? analysisAction.selectedTargets
      : analysisAction?.target
        ? [analysisAction.target]
        : []
  );
  const analysisActions = analysisAction && terminalLaunchAllowed ? `
        <div class="analysis-launch-control">
          <details class="analysis-target-picker">
            <summary>
              <span>${t("analysis.targets_label")}</span>
              <strong data-analysis-selected-count>${escapeHtml(String(selectedAnalysisTargets.size))}</strong>
            </summary>
            <div class="analysis-target-choices">
              ${analysisTargets.map((target) => `
                <label class="analysis-target-choice">
                  <input
                    type="checkbox"
                    class="analysis-target-checkbox"
                    value="${escapeHtml(target.id)}"
                    ${selectedAnalysisTargets.has(target.id) ? "checked" : ""}
                    ${target.available ? "" : "disabled"}
                  >
                  <span>${escapeHtml(target.label || target.id)}</span>
                </label>
              `).join("")}
            </div>
          </details>
          <button class="action-btn action-btn-primary" data-action="analyze-session" data-id="${escapeHtml(session.id)}" ${analysisAction.available ? "" : "disabled"}>${t("action.analyze_selected")}</button>
        </div>
  ` : "";
  const actions = managementActions || resumeActions || analysisActions ? `
      <div class="session-actions">
        ${managementActions}
        ${resumeActions}
        ${analysisActions}
      </div>
  ` : "";
  const header = `
    <header class="session-header">
      <h1>${escapeHtml(title)}</h1>
      <div class="session-id-row session-detail-id">
        <code class="session-id">${escapeHtml(session.id)}</code>
        <button class="copy-btn" type="button" data-action="copy-session-id" data-id="${escapeHtml(session.id)}" title="${t("action.copy_session_id")}">${t("action.copy")}</button>
      </div>
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
  const showAnalysisStatus = Boolean(analysisAction) || analysisRuns.length > 0;
  const analysisStatus = showAnalysisStatus ? `
    <section class="analysis-status-panel" id="analysis-status-panel" data-provider="${escapeHtml(provider)}" data-session-id="${escapeHtml(session.id)}">
      <div class="analysis-status-header">
        <div>
          <h2>${t("analysis.status_title")}</h2>
          <p>${t("analysis.status_description")}</p>
        </div>
        <button type="button" class="btn" id="analysis-status-refresh">${t("analysis.refresh")}</button>
      </div>
      <div id="analysis-runs" class="analysis-runs" aria-live="polite"></div>
      <script type="application/json" id="analysis-runs-initial">${JSON.stringify(analysisRuns).replace(/</g, "\\u003c")}</script>
    </section>
  ` : "";

  const messageMarkup = sessionTree
    ? renderSessionTree(sessionTree, 0, provider)
    : renderRawMessageGroups(messages, partsByMessage, provider);

  const body = `
<div class="session-workbench" data-session-id="${escapeHtml(session.id)}" data-provider="${escapeHtml(provider)}">
  ${renderToc(sessionTree)}
  <main id="${escapeHtml(anchorId("session", session.id))}" class="main-content">
    ${header}
    ${analysisStatus}
    ${renderSessionMetricsPanel(sessionMetrics)}
    ${todoList(todos)}
    <section class="messages">
      ${messageMarkup || `<p class="empty-state">${t("detail.no_messages")}</p>`}
    </section>
    ${sessionFlow ? renderCanonicalFlowPanel(sessionFlow) : renderFlowPanel(sessionTree)}
  </main>
</div>
  `;

  return layout(title, body, "home", { provider, providers, manageable });
}
