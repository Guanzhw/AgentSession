import { t } from "../i18n.js";
import { escapeHtml } from "../markdown.js";
import type { SessionPartNode, SessionTree } from "../providers/opencode/session-tree.js";
import { isSubagentToolName } from "../providers/shared/linked-message-session.js";
import { formatDuration, formatTime, formatTokens, messageBubble, messageHeader, reasoningBlock, todoList, toolCallBlock } from "./components.js";
import { layout } from "./layout.js";
import type { SessionNavigationContext } from "../navigation-context.js";

function safeParse(value: any) {
  if (typeof value !== "string") {
    return value || {};
  }

  try {
    return JSON.parse(value);
  } catch (err) {
    console.warn("Failed to parse JSON value:", err);
    return {};
  }
}

function modelLabel(model: any) {
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

function messageModelLabel(messageData: any) {
  return modelLabel(messageData.model) || modelLabel(messageData);
}

function cacheUsage(messageData: any) {
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
    rate: read / prompt,
    requestCount: Number(messageData?.tokenRequestCount) || 1
  };
}

function annotateCacheWarning(message: any, previousUsage: any) {
  const usage = cacheUsage(message.data);
  const sameModel = usage?.model && usage.model === previousUsage?.model;
  const unusualMiss = sameModel
    && usage.requestCount === 1
    && previousUsage?.requestCount === 1
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

function formatCount(value: any) {
  return (Number(value) || 0).toLocaleString();
}

function formatMilliseconds(ms: any) {
  const totalSeconds = Math.round((Number(ms) || 0) / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function anchorId(prefix: any, id: any) {
  const cleanId = String(id || "").replace(/[^A-Za-z0-9_-]/g, "-");
  const normalizedPrefix = prefix.endsWith("-") ? prefix.slice(0, -1) : prefix;
  const alreadyHasPrefix = cleanId.toLowerCase().startsWith(normalizedPrefix.toLowerCase() + "-") || cleanId.toLowerCase().startsWith(normalizedPrefix.toLowerCase() + "_");
  return alreadyHasPrefix ? cleanId : `${normalizedPrefix}-${cleanId}`;
}

function stringifyCompact(value: any) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch (err) {
    console.warn("Failed to stringify value:", err);
    return String(value);
  }
}

function compactText(value: any, limit = 72) {
  const text = stringifyCompact(value).replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function partStatus(partData: any) {
  return typeof partData?.state?.status === "string" ? partData.state.status : "";
}

function isErrorPart(partData: any) {
  return partStatus(partData) === "error" || Boolean(partData?.error);
}

function isTaskTool(tool: any) {
  return isSubagentToolName(tool);
}

function formatPercent(value: any) {
  const amount = Number(value) || 0;
  return `${Math.round(amount * 100)}%`;
}

function isNavigableMessageRole(role: any) {
  return ["user", "assistant", "agent"].includes(String(role || "").toLowerCase());
}

function taskTitle(partData: any) {
  return partData?.state?.title
    || partData?.state?.input?.description
    || partData?.state?.input?.subagent_type
    || partData?.state?.input?.task_name
    || partData?.state?.input?.agent_path
    || "";
}

function taskDisplayTitle(partData: any) {
  return taskTitle(partData) || "Task";
}

function childSessionCountLabel(count: any) {
  const amount = Number(count) || 0;
  return `${amount} ${amount === 1 ? "session" : "sessions"}`;
}

function toolTitle(partData: any) {
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

function messageToolName(message: any) {
  const toolPart = message.parts.find((part: any) => part.type === "tool");
  if (!toolPart) return "";
  const input = toolPart.data?.state?.input || {};
  return String(input.description || input.command || input.filePath || toolPart.tool || "");
}

function messageText(message: any) {
  const textPart = message.parts.find((part: any) => part.type === "text" && part.data?.text);
  return compactText(textPart?.data?.text || message.data?.summary || messageToolName(message) || message.id, 86);
}

function tocMessageText(message: any) {
  const textPart = message.parts.find((part: any) => part.type === "text" && compactText(part.data?.text));
  return compactText(textPart?.data?.text || "", 86);
}

function hasVisibleMessagePart(message: any) {
  return message.parts.some(isVisiblePartNode);
}

function isVisiblePartNode(part: any) {
  if (part.childSessions.length > 0) {
    return true;
  }
  if (part.type === "text") {
    return Boolean(part.data?.text);
  }
  return part.type === "tool";
}

function renderMetric(label: any, value: any) {
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
    <a class="subagent-export-btn" href="/${escapeHtml(provider)}/session/${encoded}" title="${escapeHtml(`Open${suffix}`)}">Open</a>
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

function renderMessageControls(message: any, provider: string) {
  const role = String(message.role || "").toLowerCase();
  if (role !== "user") {
    return "";
  }

  return `<div class="message-controls">
    <button type="button" class="flow-open-btn" data-flow-anchor="${escapeHtml(anchorId("msg", message.id))}" aria-expanded="false" aria-controls="session-flow-panel">Flow</button>
  </div>`;
}

function messageTurnRole(role: any) {
  const normalized = String(role || "assistant").toLowerCase();
  if (normalized === "agent") return "assistant";
  if (normalized === "tool") return "assistant";
  return normalized;
}

function hasOwnMessageBubble(message: any) {
  return Array.isArray(message.parts)
    && message.parts.some((part: any) => part.type === "text" && Boolean(part.data?.text));
}

function renderMessageGroup(message: any, markup: any, provider: string) {
  const role = messageTurnRole(message.role);
  const messageAnchor = escapeHtml(anchorId("msg", message.id));
  const data = message.data || {};
  const toolOnlyHeader = role === "assistant" && !hasOwnMessageBubble(message)
    ? messageHeader(role, {
      model: messageModelLabel(data),
      tokens: data.tokens,
      tokenRequestCount: data.tokenRequestCount,
      cacheWarning: data.cacheWarning,
      time: data.time?.created
    })
    : "";
  return `<article id="${messageAnchor}" class="message-group message-turn message-turn-${escapeHtml(role)}" data-role="${escapeHtml(role)}">${renderMessageControls(message, provider)}${toolOnlyHeader}${markup}</article>`;
}

function renderSubagentChildSession(tree: SessionTree, provider: string): string {
  const messageBlocks = [];
  let previousCacheUsage = null;

  for (const sourceMessage of tree.messages) {
    const annotated = annotateCacheWarning(sourceMessage, previousCacheUsage);
    const message = annotated.message;
    if (annotated.usage && messageTurnRole(message.role) === "assistant") {
      previousCacheUsage = annotated.usage;
    }
    const result: any = renderMessagePartsResult(message, 0, provider);
    if (result.hasVisibleContent && result.markup) {
      const group: any = [renderMessageGroup(message, result.markup, provider)];
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

  const messageMarkup: any = messageBlocks.filter(Boolean).join("\n");

  const detachedMarkup: any = tree.detachedChildren
    .map((child) => renderSubagentChildSession(child, provider))
    .filter(Boolean)
    .join("\n");
  return [messageMarkup, detachedMarkup].filter(Boolean).join("\n");
}

function makeTocNode(id: any, type: any, label: any, meta: any, depth: any, children: any[] = []) {
  return {
    id,
    type,
    label,
    meta,
    depth,
    children
  };
}

function collectMessageTaskTocNodes(message: any, parentAgentDepth: any): any[] {
  const nodes: any[] = [];

  for (const part of message.parts) {
    if (part.type === "tool" && isTaskTool(part.tool)) {
      const children = part.childSessions.flatMap((child: any) => collectTocNodes(child, parentAgentDepth));
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

function collectTocNodes(tree: SessionTree, userDepth = 0): any[] {
  const nodes: any[] = [];
  let currentUserNode = null;

  for (const message of tree.messages) {
    const role = String(message.role || "").toLowerCase();
    if (!isNavigableMessageRole(role)) {
      continue;
    }

    const label = tocMessageText(message);
    const agentDepth = userDepth + 1;
    const taskNodes: any = collectMessageTaskTocNodes(message, label ? agentDepth : userDepth);
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

function renderTocNode(node: any) {
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

function renderFlowPanel(_tree: SessionTree | null, lazyUrl = "") {
  const lazyAttrs = lazyUrl
    ? ` data-flow-lazy-url="${escapeHtml(lazyUrl)}" data-flow-state="idle"`
    : "";
  const body = lazyUrl
    ? `<p class="toc-empty" data-flow-lazy-status>Flow loads when opened.</p>`
    : `<p class="toc-empty">No flow data.</p>`;
  return `<section id="session-flow-panel" class="session-flow-panel hidden" tabindex="-1" aria-hidden="true"${lazyAttrs}>
    <div class="flow-panel-header">
      <h2>Conversation Flow</h2>
      <button type="button" class="flow-close-btn" data-flow-close aria-label="Close flow">x</button>
    </div>
    ${body}
  </section>`;
}

function flowHref(node: any) {
  const target = node?.target;
  if (!target?.kind || !target?.id) {
    return "#";
  }
  if (target.kind === "session") return `#${anchorId("session", target.id)}`;
  if (target.kind === "msg") return `#${anchorId("msg", target.id)}`;
  if (target.kind === "part") return `#${anchorId("part", target.id)}`;
  return "#";
}

function flowPreviewTarget(node: any) {
  const target = node?.target;
  if (target?.kind !== "msg" && target?.kind !== "part") {
    return "";
  }
  return flowHref(node);
}

function flowPreviewAttributes(node: any) {
  const target = flowPreviewTarget(node);
  if (!target) {
    return "";
  }
  return ` data-flow-preview-target="${escapeHtml(target)}" aria-controls="flow-inspector" aria-haspopup="dialog"`;
}

function flowNodeDetails(node: any) {
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

function renderFlowMapNode(node: any) {
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
    return `<a class="${agentClasses}" href="${escapeHtml(flowHref(node))}"${flowPreviewAttributes(node)} title="${escapeHtml(accessibleTitle)}" aria-label="${escapeHtml(accessibleTitle)}">
      <span class="flow-map-agent-label">${escapeHtml(label)}</span>
      ${details ? `<span class="flow-map-agent-meta">${escapeHtml(details)}</span>` : ""}
    </a>`;
  }

  if (kind === "return") {
    return `<a class="${classes}" href="${escapeHtml(flowHref(node))}"${flowPreviewAttributes(node)} title="${escapeHtml(accessibleTitle)}" aria-label="${escapeHtml(accessibleTitle)}">
      <span class="flow-map-return-mark"></span>
      <span class="flow-map-node-popover">Return</span>
    </a>`;
  }

  const typeLabel = kind === "user" ? "User" : "Subagent";
  return `<a class="${classes}" href="${escapeHtml(flowHref(node))}"${flowPreviewAttributes(node)} title="${escapeHtml(accessibleTitle)}">
    <span class="flow-map-node-kind">${escapeHtml(typeLabel)}</span>
    <span class="flow-map-node-label">${escapeHtml(label)}</span>
    ${details ? `<span class="flow-map-node-meta">${escapeHtml(details)}</span>` : ""}
  </a>`;
}

function flowBranchTemplateId(invocation: any, branch: any, index: any) {
  return anchorId("flow-branch", `${invocation.id}-${branch.id}-${index}`);
}

function renderFlowBranchSummary(invocation: any, branch: any, index: any) {
  const metrics = branch?.metrics || {};
  const line = Array.isArray(branch?.line) ? branch.line : [];
  const messageCount = line.filter((node: any) => node.kind === "user" || node.kind === "agent").length;
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

function renderFlowInvocationGroup(invocations: any, returnNodes: any) {
  const inferred = invocations.some((node: any) => node.inferred);
  const branchCount = invocations.reduce((sum: any, node: any) => sum + (Array.isArray(node.branches) ? node.branches.length : 0), 0);
  const summaries = invocations.flatMap((invocation: any) => {
    const branches = Array.isArray(invocation.branches) ? invocation.branches : [];
    if (!branches.length) {
      return [`<div class="flow-branch-summary flow-branch-summary-empty">
        <span class="flow-branch-summary-title">${escapeHtml(compactText(invocation.label, 52) || "Subagent")}</span>
        <span class="flow-branch-summary-meta">No child session data</span>
      </div>`];
    }
    return branches.map((branch: any, index: any) => renderFlowBranchSummary(invocation, branch, index));
  }).join("\n");
  const groupLabel = invocations.length === 1
    ? compactText(invocations[0].label, 44) || "Subagent"
    : `${formatCount(invocations.length)} parallel calls`;
  const returnNode = returnNodes.get(invocations[invocations.length - 1].id);

  return `<div class="flow-map-step flow-map-fork flow-map-fork-collapsed ${inferred ? "flow-map-fork-inferred" : ""}" data-invocation-group="${escapeHtml(invocations.map((node: any) => node.id).join(","))}" data-invocation-count="${invocations.length}">
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

function renderFlowMapSession(session: any, depth = 0) {
  const line = Array.isArray(session?.line) ? session.line : [];
  const returnNodes = new Map(
    line.filter((node: any) => node.kind === "return").map((node: any) => [node.invocationId, node])
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

function renderFlowMapSummary(summary: any) {
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

function renderFlowMapOverview(root: any) {
  const line = Array.isArray(root?.line) ? root.line : [];
  const marks = line
    .filter((node: any) => node.kind !== "return")
    .map((node: any) => `<span class="flow-map-overview-mark flow-map-overview-${escapeHtml(node.kind)} ${node.emphasis === "final" ? "flow-map-overview-final" : ""}"></span>`)
    .join("");
  return `<div class="flow-map-overview" data-flow-overview aria-label="Flow overview">
    <div class="flow-map-overview-track">${marks}<span class="flow-map-overview-window" data-flow-overview-window></span></div>
  </div>`;
}

export function renderCanonicalFlowPanelContent(sessionFlow: any) {
  if (!sessionFlow?.root) {
    return `<div class="flow-panel-header">
      <h2>Conversation Flow</h2>
      <button type="button" class="flow-close-btn" data-flow-close aria-label="Close flow">x</button>
    </div>
    <p class="toc-empty">No flow data.</p>`;
  }

  return `<div class="flow-panel-header">
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
    <aside id="flow-inspector" class="flow-inspector hidden" data-flow-inspector role="dialog" aria-modal="false" aria-hidden="true" aria-labelledby="flow-inspector-title">
      <div class="flow-inspector-header">
        <div>
          <h3 id="flow-inspector-title" data-flow-inspector-title>${t("detail.flow_subagent_detail")}</h3>
          <p data-flow-inspector-description>${t("detail.flow_subagent_detail_description")}</p>
        </div>
        <button type="button" class="flow-inspector-close" data-flow-inspector-close aria-label="${t("detail.flow_close_inspector")}">x</button>
      </div>
      <div class="flow-inspector-body" data-flow-inspector-body></div>
    </aside>
  `;
}

function renderCanonicalFlowPanel(sessionFlow: any) {
  if (!sessionFlow?.root) {
    return "";
  }

  return `<section id="session-flow-panel" class="session-flow-panel hidden" tabindex="-1" aria-hidden="true">
    ${renderCanonicalFlowPanelContent(sessionFlow)}
  </section>`;
}

function renderSessionMetricsPanel(sessionMetrics: any) {
  if (!sessionMetrics?.totals) {
    return "";
  }

  const totals = sessionMetrics.totals;
  const topTools = Array.isArray(sessionMetrics.tools)
    ? sessionMetrics.tools.slice(0, 5).map((tool: any) => `${tool.name} ${tool.count}`).join(" · ")
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

function renderReasoningPart(partData: any) {
  return reasoningBlock(
    partData?.text || "",
    formatDuration(partData?.time?.start, partData?.time?.end)
  );
}

function renderTurnReasoning(reasoningMarkup: any) {
  return reasoningMarkup ? `<div class="turn-reasoning">${reasoningMarkup}</div>` : "";
}

function renderPart(messageData: any, partData: any, partId: any, reasoningMarkup = "") {
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
      tokenRequestCount: messageData.tokenRequestCount,
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

function renderPartNode(messageData: any, part: SessionPartNode, depth = 0, provider = "opencode", reasoningMarkup = ""): string {
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
    const branches: any = part.childSessions.map((child, index) => (
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

function attachReasoningToRenderedPart(renderedPart: any, reasoningMarkup: any) {
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

function attachPendingReasoning(renderedParts: any, pendingReasoning: any) {
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

function renderMessagePartsResult(message: any, depth = 0, provider = "opencode", initialReasoning: any[] = []): any {
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
    let rendered: any = renderPartNode(message.data, part, depth, provider, isToolPart ? "" : reasoningMarkup);
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

function renderMessageParts(message: any, depth = 0, provider = "opencode") {
  const result = renderMessagePartsResult(message, depth, provider);
  const renderedParts = result.markup ? [result.markup] : [];
  attachPendingReasoning(renderedParts, result.pendingReasoning);
  return renderedParts.filter(Boolean).join("\n");
}

function renderSessionTree(tree: SessionTree, depth = 0, provider = "opencode"): string {
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

  const detachedMarkup: any = tree.detachedChildren
    .map((child) => renderSessionTree(child, depth + 1, provider))
    .filter(Boolean)
    .join("\n");
  const body: any = [messageMarkup, detachedMarkup].filter(Boolean).join("\n");

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

function renderRawParts(messageData: any, parts: any[] = []) {
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

function renderRawMessageGroups(messages: any, partsByMessage: any, provider: any) {
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
        parts: parts.map((part: any) => ({ id: part.id, data: safeParse(part.data), type: safeParse(part.data)?.type }))
      },
      markup: [renderedParts]
    });
  }

  return groups
    .map((group) => renderMessageGroup(group.message, group.markup.join("\n"), provider))
    .join("\n");
}

function analysisItems(values: any) {
  return Array.isArray(values)
    ? values.filter((value) => typeof value === "string" && value.trim())
    : [];
}

function analysisList(values: any) {
  const items = analysisItems(values);
  return items.length ? items.join(", ") : t("analysis.none");
}

function renderAnalysisValuePills(values: any, limit = 4) {
  const items = analysisItems(values);
  if (!items.length) {
    return `<span class="analysis-target-pill analysis-target-pill-muted">${t("analysis.none")}</span>`;
  }
  const visible = items.slice(0, limit).map((item) => (
    `<span class="analysis-target-pill">${escapeHtml(item)}</span>`
  ));
  const overflow = items.length - visible.length;
  if (overflow > 0) {
    visible.push(`<span class="analysis-target-pill analysis-target-pill-more" title="${escapeHtml(analysisList(items))}">+${escapeHtml(String(overflow))}</span>`);
  }
  return visible.join("");
}

function renderAnalysisTargetMeta(label: any, values: any, limit = 4) {
  return `<span class="analysis-target-meta">
    <span class="analysis-target-meta-label">${escapeHtml(label)}</span>
    <span class="analysis-target-pills">${renderAnalysisValuePills(values, limit)}</span>
  </span>`;
}

const analysisMaterialKinds = ["skills", "prompts", "agents", "rules", "other"];
const runtimeInventoryKinds = ["skill", "agent", "plugin", "instruction", "command", "hook", "rule", "tool", "extension"];

function analysisMaterialKindLabel(kind: any) {
  if (kind === "skills") return t("analysis.inventory_skills");
  if (kind === "prompts") return t("analysis.inventory_prompts");
  if (kind === "agents") return t("analysis.inventory_agents");
  if (kind === "rules") return t("analysis.inventory_rules");
  return t("analysis.inventory_other");
}

function analysisMaterialKind(value: any) {
  const key = String(value || "").toLowerCase();
  if (key.includes("skill")) return "skills";
  if (key.includes("prompt")) return "prompts";
  if (key.includes("agent")) return "agents";
  if (key.includes("rule") || key.includes("instruction")) return "rules";
  return "other";
}

function runtimeInventoryKindLabel(kind: any) {
  if (kind === "skill") return t("analysis.inventory_skills");
  if (kind === "agent") return t("analysis.inventory_agents");
  if (kind === "plugin") return t("analysis.inventory_plugins");
  if (kind === "instruction") return t("analysis.inventory_instructions");
  if (kind === "command") return t("analysis.inventory_commands");
  if (kind === "hook") return t("analysis.inventory_hooks");
  if (kind === "rule") return t("analysis.inventory_rules");
  if (kind === "tool") return t("analysis.inventory_tools");
  return t("analysis.inventory_other");
}

function runtimeInventoryKind(value: any) {
  const kind = String(value || "").toLowerCase();
  return runtimeInventoryKinds.includes(kind) ? kind : "extension";
}

function renderAnalysisTargetChoice(target: any, selectedTargets: any) {
  const artifacts = target?.artifacts || {};
  const checked = selectedTargets.has(target.id) && target.available;
  const disabled = target.available ? "" : "disabled";
  const kind = analysisMaterialKind(target.id || target.label);
  return `<label class="analysis-target-choice analysis-target-choice-compact${target.available ? "" : " analysis-target-choice-disabled"}">
    <input
      type="checkbox"
      class="analysis-target-checkbox"
      value="${escapeHtml(target.id)}"
      data-analysis-label="${escapeHtml(target.label || target.id)}"
      ${checked ? "checked" : ""}
      ${disabled}
    >
    <span class="analysis-target-compact-title">
      <strong>${escapeHtml(target.label || target.id)}</strong>
      <span class="analysis-kind-pill">${escapeHtml(analysisMaterialKindLabel(kind))}</span>
    </span>
    <span class="analysis-target-detail-popover" role="tooltip">
      ${renderAnalysisTargetMeta(t("analysis.material_roots"), artifacts.roots, 3)}
      ${renderAnalysisTargetMeta(t("analysis.material_files"), artifacts.files, 2)}
      ${renderAnalysisTargetMeta(t("analysis.material_suffixes"), artifacts.fileExtensions, 5)}
    </span>
  </label>`;
}

function runtimeScopeLabel(scope: any) {
  return scope === "project"
    ? t("analysis.project_scope")
    : scope === "user"
      ? t("analysis.user_scope")
      : scope || "Runtime";
}

function renderRuntimeExtensionChoice(extension: any, selectedRuntimeIds: any) {
  const checked = selectedRuntimeIds.has(extension.id) && extension.available;
  const source = extension.source || extension.sourcePath || extension.sourceType || "";
  const kind = runtimeInventoryKind(extension.kind);
  const scope = runtimeScopeLabel(extension.scope);
  return `<label class="analysis-runtime-choice${extension.available ? "" : " analysis-target-choice-disabled"}">
    <input
      type="checkbox"
      class="analysis-runtime-extension-checkbox"
      value="${escapeHtml(extension.id)}"
      data-analysis-label="${escapeHtml(extension.name || extension.id)}"
      ${checked ? "checked" : ""}
      ${extension.available ? "" : "disabled"}
    >
    <span class="analysis-target-copy">
      <span class="analysis-choice-heading analysis-runtime-title">
        <strong>${escapeHtml(extension.name || extension.id)}</strong>
        <span class="analysis-choice-tags">
          <span class="analysis-kind-pill">${escapeHtml(runtimeInventoryKindLabel(kind))}</span>
          <span class="analysis-scope-pill">${escapeHtml(scope)}</span>
        </span>
      </span>
      ${source ? `<small>${escapeHtml(source)}</small>` : ""}
      ${extension.note ? `<small>${escapeHtml(extension.note)}</small>` : ""}
    </span>
  </label>`;
}

function runtimeTabDomId(kind: any) {
  return `analysis-runtime-tab-${String(kind || "extension").replace(/[^a-z0-9_-]/gi, "-")}`;
}

function renderAnalysisInventory(targets: any, selectedTargets: any, runtimeExtensions: any, selectedRuntimeIds: any) {
  const targetChoices = targets
    .slice()
    .sort((a: any, b: any) => {
      const kindDelta = analysisMaterialKinds.indexOf(analysisMaterialKind(a.id || a.label))
        - analysisMaterialKinds.indexOf(analysisMaterialKind(b.id || b.label));
      return kindDelta || String(a.label || a.id).localeCompare(String(b.label || b.id));
    })
    .map((target: any) => renderAnalysisTargetChoice(target, selectedTargets));

  const runtimeGroups = new Map();
  for (const extension of runtimeExtensions) {
    const kind = runtimeInventoryKind(extension.kind);
    if (!runtimeGroups.has(kind)) {
      runtimeGroups.set(kind, []);
    }
    runtimeGroups.get(kind).push(renderRuntimeExtensionChoice(extension, selectedRuntimeIds));
  }

  const runtimeKinds = [...runtimeGroups.keys()].sort((a, b) => (
    runtimeInventoryKinds.indexOf(a) - runtimeInventoryKinds.indexOf(b)
  ));

  const runtimeMarkup = runtimeExtensions.length
    ? `<div class="analysis-runtime-tabs" data-analysis-runtime-tabs>
      <div class="analysis-runtime-tab-list" role="tablist">
      ${runtimeKinds.map((kind, index) => {
        const items = runtimeGroups.get(kind);
        const tabId = runtimeTabDomId(kind);
        return `<button
          type="button"
          class="analysis-runtime-tab${index === 0 ? " is-active" : ""}"
          role="tab"
          data-runtime-tab="${escapeHtml(kind)}"
          aria-selected="${index === 0 ? "true" : "false"}"
          aria-controls="${escapeHtml(`${tabId}-panel`)}"
          id="${escapeHtml(tabId)}"
          tabindex="${index === 0 ? "0" : "-1"}"
        >
          <span>${escapeHtml(runtimeInventoryKindLabel(kind))}</span>
          <strong>${escapeHtml(String(items.length))}</strong>
        </button>`;
      }).join("\n")}
      </div>
      <div class="analysis-runtime-tab-panels">
      ${runtimeKinds.map((kind, index) => {
        const items = runtimeGroups.get(kind);
        const tabId = runtimeTabDomId(kind);
        return `<section
          class="analysis-runtime-tab-panel${index === 0 ? " is-active" : ""}"
          role="tabpanel"
          data-runtime-panel="${escapeHtml(kind)}"
          aria-labelledby="${escapeHtml(tabId)}"
          id="${escapeHtml(`${tabId}-panel`)}"
          ${index === 0 ? "" : "hidden"}
        >
          <div class="analysis-runtime-panel-heading">
            <span>${escapeHtml(runtimeInventoryKindLabel(kind))}</span>
            <strong>${escapeHtml(String(items.length))}</strong>
          </div>
          <div class="analysis-runtime-list">${items.join("\n")}</div>
        </section>`;
      }).join("\n")}
      </div>
    </div>`
    : `<p class="analysis-runtime-empty">${t("analysis.no_runtime")}</p>`;

  return `<div class="analysis-material-sections">
    <section class="analysis-material-section">
      <div class="analysis-section-heading">
        <h4>${t("analysis.targets_title")}</h4>
        <p>${t("analysis.targets_description")}</p>
      </div>
      <div class="analysis-choice-grid">${targetChoices.join("\n")}</div>
    </section>
    <section class="analysis-material-section analysis-runtime-section">
      <div class="analysis-section-heading">
        <h4>${t("analysis.runtime_title")}</h4>
        <p>${t("analysis.runtime_description")}</p>
      </div>
      ${runtimeMarkup}
    </section>
  </div>`;
}

function resolveAnalysisLaunchState(analysisAction: any) {
  const targets = Array.isArray(analysisAction?.targets) ? analysisAction.targets : [];
  const selectedTargets = new Set(
    (Array.isArray(analysisAction?.selectedTargets) && analysisAction.selectedTargets.length
      ? analysisAction.selectedTargets
      : [analysisAction?.target || "skills"])
      .filter(Boolean)
  );
  const runtimeEnvironment = analysisAction?.runtimeEnvironment || null;
  const runtimeExtensions = Array.isArray(runtimeEnvironment?.extensions)
    ? runtimeEnvironment.extensions
    : [];
  const selectedRuntimeIds = new Set(
    Array.isArray(runtimeEnvironment?.selectedExtensionIds)
      ? runtimeEnvironment.selectedExtensionIds
      : runtimeExtensions
        .filter((extension: any) => extension.defaultSelected && extension.available)
        .map((extension: any) => extension.id)
  );
  const selectedTargetCount = targets.filter((target: any) => selectedTargets.has(target.id) && target.available).length;
  const selectedRuntimeCount = runtimeExtensions.filter((extension: any) => selectedRuntimeIds.has(extension.id) && extension.available).length;
  return {
    runtimeEnvironment,
    runtimeExtensions,
    selectedRuntimeCount,
    selectedRuntimeIds,
    selectedTargetCount,
    selectedTargets,
    targets
  };
}

function renderAnalysisLaunchButton(analysisAction: any, session: any) {
  const {
    runtimeExtensions,
    selectedRuntimeIds,
    selectedTargetCount,
    selectedTargets,
    targets
  } = resolveAnalysisLaunchState(analysisAction);
  const launchLabel = selectedTargetCount <= 0
    ? t("analysis.launch_select_target")
    : selectedTargetCount === 1
      ? t("analysis.launch_one")
      : t("analysis.launch_many").replace("{targets}", String(selectedTargetCount));
  const selectedTargetLabels = targets
    .filter((target: any) => selectedTargets.has(target.id) && target.available)
    .map((target: any) => target.label || target.id);
  const selectedRuntimeLabels = runtimeExtensions
    .filter((extension: any) => selectedRuntimeIds.has(extension.id) && extension.available)
    .map((extension: any) => extension.name || extension.id);
  const launchAccessibleLabel = selectedTargetCount <= 0
    ? launchLabel
    : t("analysis.launch_action")
      .replace("{targets}", analysisList(selectedTargetLabels))
      .replace("{runtime}", String(selectedRuntimeLabels.length));
  return `<button
    type="button"
    class="action-btn action-btn-primary analysis-launch-button"
    data-action="analyze-session"
    data-id="${escapeHtml(session.id)}"
    data-target="${escapeHtml(analysisAction.target || "skills")}"
    data-unavailable="${analysisAction.available ? "false" : "true"}"
    title="${escapeHtml(launchAccessibleLabel)}"
    aria-label="${escapeHtml(launchAccessibleLabel)}"
    ${analysisAction.available ? "" : "disabled"}
  >${escapeHtml(launchLabel)}</button>`;
}

function renderAnalysisLaunchControl(analysisAction: any, terminalLaunchAllowed: any) {
  if (!analysisAction || !terminalLaunchAllowed) {
    return "";
  }

  const {
    runtimeEnvironment,
    runtimeExtensions,
    selectedRuntimeCount,
    selectedRuntimeIds,
    selectedTargetCount,
    selectedTargets,
    targets
  } = resolveAnalysisLaunchState(analysisAction);

  return `<details class="analysis-materials-panel" id="analysis-materials-panel">
    <summary>
      <span>
        <strong>${t("analysis.materials_title")}</strong>
        <small data-analysis-launch-summary>${escapeHtml(t("analysis.launch_summary")
    .replace("{targets}", String(selectedTargetCount))
    .replace("{runtime}", String(selectedRuntimeCount)))}</small>
      </span>
      <span class="analysis-materials-counts">
        <span><span>${t("analysis.targets_title")}</span><strong data-analysis-selected-count>${escapeHtml(String(selectedTargetCount))}</strong></span>
        <span><span>${t("analysis.runtime_title")}</span><strong data-runtime-selected-count>${escapeHtml(String(selectedRuntimeCount))}</strong></span>
      </span>
    </summary>
    <div class="analysis-materials-body">
      <p class="analysis-runtime-note">${t("analysis.materials_description")}</p>
      ${renderAnalysisInventory(targets, selectedTargets, runtimeExtensions, selectedRuntimeIds)}
      ${runtimeEnvironment?.note ? `<p class="analysis-runtime-note">${escapeHtml(runtimeEnvironment.note)}</p>` : ""}
    </div>
  </details>`;
}

function renderExportMenu(provider: any, sessionId: any) {
  const encodedProvider = encodeURIComponent(provider);
  const encodedSessionId = encodeURIComponent(sessionId);
  return `<details class="action-menu">
    <summary class="action-btn">${t("action.export")}</summary>
    <div class="action-menu-list">
      <a href="/api/${encodedProvider}/session/${encodedSessionId}/export?format=md">${t("action.export_md")}</a>
      <a href="/api/${encodedProvider}/session/${encodedSessionId}/export?format=json">${t("action.export_json")}</a>
    </div>
  </details>`;
}

function renderTranscriptSearch() {
  return `<details class="session-search" data-session-search>
    <summary class="action-btn session-search-toggle" data-session-search-toggle>${t("detail.search_messages")}</summary>
    <div class="session-search-panel">
      <label class="session-search-field" for="session-transcript-search">
        <span class="visually-hidden">${t("detail.search_messages")}</span>
        <input id="session-transcript-search" type="search" autocomplete="off" data-session-search-input placeholder="${t("detail.search_placeholder")}" aria-describedby="session-transcript-search-status">
      </label>
      <div class="session-search-navigation">
        <output id="session-transcript-search-status" class="session-search-status" data-session-search-status aria-live="polite"></output>
        <button class="session-search-nav-btn" type="button" data-session-search-previous disabled title="${t("detail.search_previous")}" aria-label="${t("detail.search_previous")}">&#8593;</button>
        <button class="session-search-nav-btn" type="button" data-session-search-next disabled title="${t("detail.search_next")}" aria-label="${t("detail.search_next")}">&#8595;</button>
        <button class="session-search-nav-btn session-search-close" type="button" data-session-search-close title="${t("detail.search_close")}" aria-label="${t("detail.search_close")}">&#215;</button>
      </div>
    </div>
  </details>`;
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
  terminalLaunchAllowed = false,
  flowLazyUrl = "",
  navigationContext = null
}: { session: any; sessionTree?: any; sessionMetrics?: any; sessionFlow?: any; messages?: any[]; partsByMessage?: Map<any, any>; todos?: any[]; recentSessions?: any[]; meta?: any; provider?: string; providers?: any[]; manageable?: boolean; resumeCommand?: any; analysisAction?: any; analysisRuns?: any[]; terminalLaunchAllowed?: boolean; flowLazyUrl?: string; navigationContext?: SessionNavigationContext | null }) {
  const title = session.title || session.slug || session.id;
  const starred = meta?.starred ? 1 : 0;
  const encodedProvider = encodeURIComponent(provider);
  const encodedSessionId = encodeURIComponent(session.id);
  const providerName = providers.find((item: any) => item.id === provider)?.name || provider;
  const sourceLabel = navigationContext?.section === "stats" ? t("nav.stats") : t("nav.sessions");
  const breadcrumb = navigationContext ? `<nav class="session-breadcrumb" aria-label="${escapeHtml(t("detail.breadcrumb_label"))}">
    <a href="${escapeHtml(navigationContext.href)}">← ${escapeHtml(t("detail.back_to_source", { source: sourceLabel }))}</a>
    <span>${escapeHtml(providerName)}</span>
    ${navigationContext.day ? `<span>${escapeHtml(navigationContext.day)}</span>` : ""}
  </nav>` : "";

  // Action parity: visible actions + "More" dropdown
  const visibleStarAction = manageable ? `
        <button class="star-btn action-btn ${starred ? "starred" : ""}" type="button" data-star-format="label" data-id="${escapeHtml(session.id)}" title="${starred ? t("action.starred") : t("action.star")}" aria-label="${starred ? t("action.starred") : t("action.star")}">
          ${starred ? t("action.starred") : t("action.star")}
        </button>
  ` : "";
  const resumeActions = resumeCommand && terminalLaunchAllowed ? `
        <button class="action-btn" data-action="resume-session" data-id="${escapeHtml(session.id)}" ${resumeCommand.available ? "" : "disabled"}>${t("action.open_terminal")}</button>
  ` : "";
  const analysisButton = analysisAction && terminalLaunchAllowed
    ? renderAnalysisLaunchButton(analysisAction, session)
    : "";
  const moreActionsDropdown = manageable ? `
        <details class="more-actions">
          <summary class="action-btn">${t("action.more_actions")}</summary>
          <div class="more-actions-list">
            <button type="button" data-action="rename" data-id="${escapeHtml(session.id)}">${t("action.rename")}</button>
            <button type="button" data-action="copy-session-id" data-id="${escapeHtml(session.id)}">${t("action.copy_session_id_menu")}</button>
            <a href="/api/${encodedProvider}/session/${encodedSessionId}/export?format=md">${t("action.export_md")}</a>
            <a href="/api/${encodedProvider}/session/${encodedSessionId}/export?format=json">${t("action.export_json")}</a>
            <button type="button" data-action="delete" data-id="${escapeHtml(session.id)}" class="menu-danger">${t("action.delete")}</button>
          </div>
        </details>
  ` : "";

  const resumePreview = resumeCommand && terminalLaunchAllowed ? `
        <details class="resume-command-preview">
          <summary>${t("action.resume_preview")}</summary>
          <div class="resume-command-preview-body">
            <div class="resume-command-item">
              <span class="resume-command-label">${t("action.resume_command")}</span>
              <div class="resume-command-value">
                <code>${escapeHtml(resumeCommand.display || "")}</code>
                <button class="copy-btn" type="button" data-action="copy-resume-command" data-command="${escapeHtml(resumeCommand.display || "")}" title="${t("action.copy_resume_command")}" aria-label="${t("action.copy_resume_command")}">${t("action.copy")}</button>
              </div>
            </div>
            <div class="resume-command-item">
              <span class="resume-command-label">${t("action.resume_directory")}</span>
              <code>${escapeHtml(resumeCommand.cwd || "")}</code>
            </div>
          </div>
        </details>
  ` : "";

  const analysisMaterials = renderAnalysisLaunchControl(analysisAction, terminalLaunchAllowed);
  const actionShellClass = analysisMaterials
    ? "session-actions-shell analysis-launch-control"
    : "session-actions-shell";
  const actions = `
      <div class="${actionShellClass}"${analysisMaterials ? ' data-analysis-selection-id="analysis-materials-panel"' : ""}>
        <div class="session-actions">
          ${visibleStarAction}
          ${resumeActions}
          ${analysisButton}
          ${renderTranscriptSearch()}
          ${moreActionsDropdown}
        </div>
        ${resumePreview}
      </div>
  `;

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

  // Analysis collapse
  const showAnalysisStatus = Boolean(analysisAction) || analysisRuns.length > 0;
  const activeRunStates = new Set(["prepared", "launched", "running", "waiting", "analysis_waiting_no_output", "failed", "invalid", "needs_attention"]);
  const hasActiveRun = analysisRuns.some((run: any) => run?.active === true || activeRunStates.has(run?.state));
  const analysisActivityBadge = hasActiveRun
    ? `<span class="analysis-activity-badge">${t(analysisRuns.some((r: any) => r?.active === true || ["prepared", "launched", "running"].includes(r?.state)) ? "analysis.activity_badge_active" : analysisRuns.some((r: any) => ["failed", "invalid"].includes(r?.state)) ? "analysis.activity_badge_failed" : analysisRuns.some((r: any) => ["waiting", "analysis_waiting_no_output"].includes(r?.state)) ? "analysis.activity_badge_waiting" : "analysis.activity_badge_attention")}</span>`
    : "";
  const analysisStatus = showAnalysisStatus ? `
    <details class="analysis-activity-details" id="analysis-activity-details" ${hasActiveRun ? "open" : ""}>
      <summary>${t("analysis.activity_summary").replace("{count}", String(analysisRuns.length))}${analysisActivityBadge}</summary>
      <section class="analysis-status-panel" id="analysis-status-panel" data-provider="${escapeHtml(provider)}" data-session-id="${escapeHtml(session.id)}" data-terminal-launch="${terminalLaunchAllowed ? "true" : "false"}">
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
    </details>
  ` : "";

  const messageMarkup = sessionTree
    ? renderSessionTree(sessionTree, 0, provider)
    : renderRawMessageGroups(messages, partsByMessage, provider);

  // Raw data tab content
  const rawDataContent = `
    <div class="raw-data-section">
      <p><strong>${t("detail.created")}</strong> ${escapeHtml(new Date(Number(session.time_created) || Date.now()).toLocaleString())}</p>
      <p><strong>${t("detail.updated")}</strong> ${escapeHtml(new Date(Number(session.time_updated) || Date.now()).toLocaleString())}</p>
      <p><strong>${t("detail.files")}</strong> ${escapeHtml(String(Number(session.summary_files) || 0))} / ${t("detail.additions")} +${escapeHtml(String(Number(session.summary_additions) || 0))} / ${t("detail.deletions")} -${escapeHtml(String(Number(session.summary_deletions) || 0))}</p>
      ${session.directory ? `<p><strong>Directory</strong> ${escapeHtml(session.directory)}</p>` : ""}
      <p><strong>Session ID</strong> <code>${escapeHtml(session.id)}</code></p>
    </div>
    <div class="raw-data-export">
      <a href="/api/${encodedProvider}/session/${encodedSessionId}/export?format=md" class="btn">${t("action.export_md")}</a>
      <a href="/api/${encodedProvider}/session/${encodedSessionId}/export?format=json" class="btn">${t("action.export_json")}</a>
    </div>
  `;

  const body = `
<div class="session-workbench" data-session-id="${escapeHtml(session.id)}" data-provider="${escapeHtml(provider)}">
  ${renderToc(sessionTree)}
  <main id="${escapeHtml(anchorId("session", session.id))}" class="main-content">
    ${breadcrumb}
    ${header}
    <div class="tab-bar" role="tablist" aria-label="${escapeHtml(t("detail.tab_bar_label"))}" hidden>
      <button role="tab" aria-selected="false" aria-controls="tab-overview" id="tab-btn-overview" tabindex="-1">${t("detail.tab_overview")}</button>
      <button role="tab" aria-selected="true" aria-controls="tab-conversation" id="tab-btn-conversation" tabindex="0">${t("detail.tab_conversation")}</button>
      <button role="tab" aria-selected="false" aria-controls="tab-flow" id="tab-btn-flow" tabindex="-1">${t("detail.tab_flow")}</button>
      <button role="tab" aria-selected="false" aria-controls="tab-analysis" id="tab-btn-analysis" tabindex="-1">${t("detail.tab_analysis")}</button>
      <button role="tab" aria-selected="false" aria-controls="tab-raw" id="tab-btn-raw" tabindex="-1">${t("detail.tab_raw")}</button>
    </div>
    <div role="tabpanel" id="tab-conversation" aria-labelledby="tab-btn-conversation">
      <section id="session-messages" class="messages">
        ${messageMarkup || `<p class="empty-state">${t("detail.no_messages")}</p>`}
      </section>
    </div>
    <div role="tabpanel" id="tab-overview" aria-labelledby="tab-btn-overview">
      ${renderSessionMetricsPanel(sessionMetrics)}
      ${todoList(todos)}
    </div>
    <div role="tabpanel" id="tab-flow" aria-labelledby="tab-btn-flow" data-session-flow-tab>
      ${sessionFlow ? renderCanonicalFlowPanel(sessionFlow) : renderFlowPanel(sessionTree, flowLazyUrl)}
    </div>
    <div role="tabpanel" id="tab-analysis" aria-labelledby="tab-btn-analysis">
      ${analysisMaterials ? `<div class="analysis-tab-launch">${analysisMaterials}</div>` : `<p class="empty-state">${t("analysis.unavailable")}</p>`}
      ${analysisStatus}
    </div>
    <div role="tabpanel" id="tab-raw" aria-labelledby="tab-btn-raw">
      ${rawDataContent}
    </div>
  </main>
</div>
  `;

  return layout(title, body, navigationContext?.section === "stats" ? "stats" : "home", { provider, providers, manageable });
}
