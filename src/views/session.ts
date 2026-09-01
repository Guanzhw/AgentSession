import { t } from "../i18n.js";
import { escapeHtml } from "../markdown.js";
import type { SessionPartNode, SessionTree } from "../providers/opencode/session-tree.js";
import { isSubagentTool, mergeToolMetadata } from "../providers/shared/subagent-tools.js";
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

function isTaskTool(partData: any) {
  return isSubagentTool(
    partData?.tool,
    mergeToolMetadata(partData?.state?.metadata, partData?.metadata)
  );
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
  if (partData?.type === "tool" && isTaskTool(partData)) {
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

function renderSubsessionHeader(tree: SessionTree, inferred = false) {
  const session = tree.session || {};
  const title = session.title || session.slug || session.id;
  const metrics = tree.metrics;
  const pieces = [
    inferred ? t("detail.inferred_link") : "",
    `${formatCount(metrics.totalMessages)} messages`,
    `${formatCount(metrics.totalToolCalls)} tools`
  ];

  if (metrics.descendantCount) {
    pieces.push(`${formatCount(metrics.descendantCount)} nested`);
  }
  if (metrics.runtimeMs) {
    pieces.push(formatDuration(metrics.timeStart, metrics.timeEnd));
  }

  const kind = inferred ? t("detail.linked_session") : t("detail.subsession");
  return `<summary class="subsession-summary" aria-label="${escapeHtml(`Toggle ${kind} ${title}`)}">
    <span class="subsession-kicker">${escapeHtml(kind)}</span>
    <span class="subsession-title">${escapeHtml(title)}</span>
    <span class="subsession-meta">${escapeHtml(pieces.filter(Boolean).join(" · "))}</span>
  </summary>`;
}

function renderSubagentExportActions(part: SessionPartNode, provider: string) {
  const childSession = part.childSessions[0]?.session;
  if (childSession?.metadata?.embedded === true) {
    return "";
  }
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
  const childSessionTree = part.childSessions[0];
  const inferred = Boolean(childSessionTree && part.inferredChildSessionIds?.has(String(childSessionTree.session?.id)));
  const childMetrics = childSessionTree?.metrics;
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
    inferred ? t("detail.inferred_link") : "",
    childSessionCountLabel(part.childSessions.length),
    status,
    duration
  ].filter(Boolean).join(" · ");

  const kind = inferred ? t("detail.linked_session") : "subagent";
  return `<details class="subagent-branch${inferred ? " subagent-branch-inferred" : ""}" data-subsession-container="task" data-subagent-relationship="${inferred ? "inferred" : "explicit"}" data-parent-part-id="${escapeHtml(part.id)}" open>
    <summary class="subagent-summary" aria-label="${escapeHtml(`Toggle ${kind} ${title || "task"}`)}">
      <span class="subsession-kicker">${escapeHtml(kind)}</span>
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
      tokenRequests: data.tokenRequests,
      tokenRequestCount: data.tokenRequestCount,
      cacheWarning: data.cacheWarning,
      time: data.time?.created
    })
    : "";
  return `<article id="${messageAnchor}" class="message-group message-turn message-turn-${escapeHtml(role)}" data-role="${escapeHtml(role)}">${toolOnlyHeader}${markup}</article>`;
}

function renderSubagentChildSession(tree: SessionTree, provider: string, depth = 1): string {
  const messageBlocks = [];
  let previousCacheUsage = null;

  for (const sourceMessage of tree.messages) {
    const annotated = annotateCacheWarning(sourceMessage, previousCacheUsage);
    const message = annotated.message;
    if (annotated.usage && messageTurnRole(message.role) === "assistant") {
      previousCacheUsage = annotated.usage;
    }
    const result: any = renderMessagePartsResult(message, depth, provider);
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
    .map((child) => renderSessionTree(child, depth + 1, provider, true))
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
    if (part.type === "tool" && isTaskTool(part.data)) {
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
      if (!(part.type === "tool" && isTaskTool(part.data))) {
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
    nodes.push(makeTocNode(
      anchorId("session", child.session.id || ""),
      "Task",
      child.session.title || child.session.slug || child.session.id || t("detail.subsession"),
      t("detail.subsession"),
      userDepth + 1
    ));
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

function renderSessionMetricsPanel(sessionMetrics: any) {
  if (!sessionMetrics?.totals) {
    return "";
  }

  const totals = sessionMetrics.totals;
  const topTools = Array.isArray(sessionMetrics.tools)
    ? sessionMetrics.tools.slice(0, 5).map((tool: any) => `${tool.name} ${tool.count}`).join(" · ")
    : "";
  const directTokenPieces = [
    `${formatCount(totals.directInputTokens)} in`,
    `${formatCount((Number(totals.directOutputTokens) || 0) + (Number(totals.directReasoningTokens) || 0))} out`,
    totals.directCacheReadTokens ? `${formatCount(totals.directCacheReadTokens)} cache read` : "",
    totals.directCacheWriteTokens ? `${formatCount(totals.directCacheWriteTokens)} cache write` : ""
  ].filter(Boolean).join(" · ");
  const hasFamilyUsage = Number(totals.totalTokens) !== Number(totals.directTotalTokens);
  const tokenPieces = `${t("detail.tokens_direct", { count: formatCount(totals.directTotalTokens) })}${directTokenPieces ? ` · ${directTokenPieces}` : ""}${hasFamilyUsage ? ` · ${t("detail.tokens_inclusive", { count: formatCount(totals.totalTokens) })}` : ""}`;

  return `<section class="session-metrics-panel">
    <div class="metrics-grid">
      ${renderMetric("messages", formatCount(totals.messages))}
      ${renderMetric("steps", formatCount(totals.steps))}
      ${renderMetric("tools", formatCount(totals.toolCalls))}
      ${renderMetric("branches", formatCount(totals.branches))}
      ${renderMetric("runtime", formatMilliseconds(totals.runtimeMs))}
      ${renderMetric("cost", totals.cost ? `$${Number(totals.cost).toFixed(4)}` : "$0")}
    </div>
    <p class="metrics-detail">${escapeHtml(tokenPieces)}</p>
    ${topTools ? `<p class="metrics-detail">${escapeHtml(`top tools: ${topTools}`)}</p>` : ""}
  </section>`;
}

function renderReasoningPart(partData: any, partId = "") {
  return reasoningBlock(
    partData?.text || "",
    formatDuration(partData?.time?.start, partData?.time?.end),
    partId
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
      partId,
      model: messageModelLabel(messageData),
      tokens: messageData.tokens,
      tokenRequests: messageData.tokenRequests,
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
  const isTaskWithSession = part.type === "tool" && isTaskTool(part.data) && part.childSessions.length > 0;
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
        renderSubagentChildSession(child, provider, depth + 1),
        provider,
        index === 0 ? reasoningMarkup : ""
      )
    )).join("\n");
    return `<div id="${partAnchor}" class="session-part-anchor">${branches}</div>`;
  }

  const childMarkup = part.childSessions
    .map((child) => renderSubagentChildSession(child, provider, depth + 1))
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
      const reasoning = renderReasoningPart(part.data, part.id);
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

function renderSessionTree(tree: SessionTree, depth = 0, provider = "opencode", inferred = false): string {
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
    .map((child) => renderSessionTree(child, depth + 1, provider, true))
    .filter(Boolean)
    .join("\n");
  const body: any = [messageMarkup, detachedMarkup].filter(Boolean).join("\n");

  if (depth === 0) {
    return body;
  }

  return `<details id="${escapeHtml(anchorId("session", tree.session.id || ""))}" class="subsession-container${inferred ? " subsession-container-inferred" : ""}" data-session-id="${escapeHtml(tree.session.id || "")}" data-session-relationship="${inferred ? "inferred" : "nested"}" data-depth="${depth}">
    ${renderSubsessionHeader(tree, inferred)}
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
      const reasoning = renderReasoningPart(partData, part.id);
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
  messages = [],
  partsByMessage = new Map(),
  todos = [],
  recentSessions = [],
  meta = null,
  provider = "opencode",
  providers = [],
  manageable = false,
  resumeCommand = null,
  terminalLaunchAllowed = false,
  runtimeWorkbench = "",
  navigationContext = null
}: { session: any; sessionTree?: any; sessionMetrics?: any; messages?: any[]; partsByMessage?: Map<any, any>; todos?: any[]; recentSessions?: any[]; meta?: any; provider?: string; providers?: any[]; manageable?: boolean; resumeCommand?: any; terminalLaunchAllowed?: boolean; runtimeWorkbench?: string; navigationContext?: SessionNavigationContext | null }) {
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

  const actions = `
      <div class="session-actions-shell">
        <div class="session-actions">
          ${visibleStarAction}
          ${resumeActions}
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

  const messageMarkup = sessionTree
    ? renderSessionTree(sessionTree, 0, provider)
    : renderRawMessageGroups(messages, partsByMessage, provider);

  const sessionMetadata = session.metadata && typeof session.metadata === "object"
    ? session.metadata as Record<string, unknown>
    : {};
  const projectKey = typeof sessionMetadata.projectKey === "string" && sessionMetadata.projectKey.trim()
    ? sessionMetadata.projectKey.trim()
    : null;
  const projectKeyDetails = projectKey ? `
    <p><strong>${t("detail.project_key")}</strong> <code>${escapeHtml(projectKey)}</code>${sessionMetadata.projectDirectorySource === "configured" ? ` · ${t("detail.project_directory_configured")}` : ""}</p>
  ` : "";

  // Raw data tab content
  const rawDataContent = `
    <div class="raw-data-section">
      <p><strong>${t("detail.created")}</strong> ${escapeHtml(new Date(Number(session.time_created) || Date.now()).toLocaleString())}</p>
      <p><strong>${t("detail.updated")}</strong> ${escapeHtml(new Date(Number(session.time_updated) || Date.now()).toLocaleString())}</p>
      <p><strong>${t("detail.files")}</strong> ${escapeHtml(String(Number(session.summary_files) || 0))} / ${t("detail.additions")} +${escapeHtml(String(Number(session.summary_additions) || 0))} / ${t("detail.deletions")} -${escapeHtml(String(Number(session.summary_deletions) || 0))}</p>
      ${session.directory ? `<p><strong>Directory</strong> ${escapeHtml(session.directory)}</p>` : ""}
      ${projectKeyDetails}
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
      <button role="tab" aria-selected="false" aria-controls="tab-runtime" id="tab-btn-runtime" tabindex="-1">${t("detail.tab_runtime")}</button>
      <button role="tab" aria-selected="false" aria-controls="tab-raw" id="tab-btn-raw" tabindex="-1">${t("detail.tab_raw")}</button>
    </div>
    <div role="tabpanel" id="tab-conversation" aria-labelledby="tab-btn-conversation">
      <section id="session-messages" class="messages">
        ${messageMarkup || `<p class="empty-state">${t("detail.no_messages")}</p>`}
      </section>
    </div>
    <div role="tabpanel" id="tab-runtime" aria-labelledby="tab-btn-runtime">
      ${runtimeWorkbench || `<p class="empty-state">${t("runtime.unavailable")}</p>`}
    </div>
    <div role="tabpanel" id="tab-overview" aria-labelledby="tab-btn-overview">
      ${renderSessionMetricsPanel(sessionMetrics)}
      ${todoList(todos)}
    </div>
    <div role="tabpanel" id="tab-raw" aria-labelledby="tab-btn-raw">
      ${rawDataContent}
    </div>
  </main>
</div>
  `;

  return layout(title, body, navigationContext?.section === "stats" ? "stats" : "home", { provider, providers, manageable });
}
