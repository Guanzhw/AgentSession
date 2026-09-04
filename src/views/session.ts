import { t } from "../i18n.js";
import { escapeHtml } from "../markdown.js";
import type { SessionPartNode, SessionTree } from "../providers/opencode/session-tree.js";
import { isSubagentTool, mergeToolMetadata } from "../providers/shared/subagent-tools.js";
import { formatDuration, formatTime, formatTokens, messageBubble, messageHeader, reasoningBlock, todoList, toolCallBlock } from "./components.js";
import { layout } from "./layout.js";
import type { SessionNavigationContext } from "../navigation-context.js";
import type { ConversationCompaction } from "../protocol-runtime.js";

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
  const childNode = (child: any) => makeTocNode(
    anchorId("session", child.session?.id || ""),
    "Task",
    child.session?.title || child.session?.slug || child.session?.id || t("detail.subsession"),
    t("detail.subsession"),
    parentAgentDepth + 1
  );

  for (const part of message.parts) {
    if (part.type === "tool" && isTaskTool(part.data)) {
      const children = part.childSessions.map(childNode);
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
        nodes.push(childNode(child));
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
    return `<aside class="session-toc"><h2>${escapeHtml(t("detail.toc_navigate"))}</h2><p class="toc-empty">${escapeHtml(t("detail.toc_no_indexed_messages"))}</p><button class="toc-resize-handle" type="button" aria-label="${escapeHtml(t("detail.toc_resize"))}"></button></aside>`;
  }

  const nodes = collectTocNodes(tree);
  const markup = nodes.map(renderTocNode).join("\n");

  return `<aside class="session-toc">
    <div class="toc-header">
      <h2>${escapeHtml(t("detail.toc_title"))}</h2>
      <div class="toc-controls" aria-label="${escapeHtml(t("detail.toc_controls"))}">
        <button type="button" class="toc-control" data-toc-action="collapse" title="${escapeHtml(t("detail.toc_collapse_all"))}">-</button>
        <button type="button" class="toc-control" data-toc-action="expand" title="${escapeHtml(t("detail.toc_expand_all"))}">+</button>
      </div>
    </div>
    <div class="toc-list">${markup || `<p class="toc-empty">${escapeHtml(t("detail.toc_no_indexed_messages"))}</p>`}</div>
    <button class="toc-resize-handle" type="button" aria-label="${escapeHtml(t("detail.toc_resize"))}"></button>
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

interface ConversationEntry {
  messageId: string;
  role: string;
  markup: string;
  timeCreated: number;
}

/**
 * Render each top-level message into one entry (markup may be empty for
 * messages that produce no visible content). The conversation thread groups
 * these entries by user turn; nested session rendering keeps its existing
 * linear behavior inside subagent branches.
 */
function renderSessionMessageEntries(tree: SessionTree, depth = 0, provider = "opencode"): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  let previousCacheUsage = null;

  for (const sourceMessage of tree.messages) {
    const annotated = annotateCacheWarning(sourceMessage, previousCacheUsage);
    const message = annotated.message;
    if (annotated.usage && messageTurnRole(message.role) === "assistant") {
      previousCacheUsage = annotated.usage;
    }
    let markup = "";
    const result = renderMessagePartsResult(message, depth, provider);
    if (result.hasVisibleContent && result.markup) {
      const group = [renderMessageGroup(message, result.markup, provider)];
      attachPendingReasoning(group, result.pendingReasoning);
      markup = group[0];
    } else if (result.pendingReasoning.length && messageTurnRole(message.role) === "assistant") {
      markup = renderMessageGroup(
        message,
        renderTurnReasoning(result.pendingReasoning.join("\n")),
        provider
      );
    } else if (!result.pendingReasoning.length && hasVisibleMessagePart(message)) {
      const messageAnchor = escapeHtml(anchorId("msg", message.id));
      markup = `<span id="${messageAnchor}" class="session-event-anchor" aria-hidden="true"></span>`;
    }
    entries.push({
      messageId: String(message.id || ""),
      role: messageTurnRole(message.role),
      markup,
      timeCreated: Number(message.timeCreated) || 0
    });
  }

  return entries;
}

function renderSessionTree(tree: SessionTree, depth = 0, provider = "opencode", inferred = false): string {
  const messageMarkup = renderSessionMessageEntries(tree, depth, provider)
    .map((entry) => entry.markup)
    .filter(Boolean)
    .join("\n");

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

function renderRawMessageEntries(messages: any, partsByMessage: any, provider: any): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
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
    const previous = entries[entries.length - 1];
    if (String(messageData.role || "").toLowerCase() === "tool" && previous?.role === "assistant") {
      previous.markup += `\n${renderedParts}`;
      continue;
    }

    entries.push({
      messageId: String(message.id || ""),
      role,
      markup: renderMessageGroup({
        id: message.id,
        role,
        data: messageData,
        parts: parts.map((part: any) => ({ id: part.id, data: safeParse(part.data), type: safeParse(part.data)?.type }))
      }, renderedParts, provider),
      timeCreated: Number(parsedData.time?.created) || Number(message.time_created) || 0
    });
  }

  return entries;
}

// ── Conversation thread (UI v2 P2a) ────────────────────────────────────

const CONVERSATION_THREAD_THRESHOLD = 20;

function conversationDefaultMode(messageCount: number) {
  return Number(messageCount) > CONVERSATION_THREAD_THRESHOLD ? "thread" : "linear";
}

function renderCompactionCheckpoint(compaction: any, provider: string, placement: "anchored" | "timestamp" | "end") {
  const tokenParts = [];
  if (compaction.tokensBefore != null) {
    tokenParts.push(`${t("conversation.checkpoint_before")} ${formatCount(compaction.tokensBefore)}`);
  }
  if (compaction.tokensAfter != null) {
    tokenParts.push(`${t("conversation.checkpoint_after")} ${formatCount(compaction.tokensAfter)}`);
  }
  const meta = [
    tokenParts.length ? tokenParts.join(" · ") : "",
    compaction.timestamp ? formatTime(compaction.timestamp) : "",
    // The recorded marker is about the *placed position* (derived from a
    // timestamp or the thread end), never about the event's fidelity; the
    // event provenance stays available on the element as a data attribute.
    placement !== "anchored" ? t("conversation.checkpoint_position_derived") : ""
  ].filter(Boolean).join(" · ");
  const summary = compactText(compaction.summary, 160);
  const facts = [];
  if (compaction.trigger) {
    facts.push(`<dt>${escapeHtml(t("conversation.checkpoint_trigger"))}</dt><dd>${escapeHtml(compaction.trigger === "unknown" ? t("conversation.checkpoint_unknown") : compaction.trigger)}</dd>`);
  }
  if (compaction.strategy) {
    facts.push(`<dt>${escapeHtml(t("conversation.checkpoint_strategy"))}</dt><dd>${escapeHtml(compaction.strategy === "unknown" ? t("conversation.checkpoint_unknown") : compaction.strategy)}</dd>`);
  }
  if (compaction.continuationSessionId) {
    const encoded = encodeURIComponent(compaction.continuationSessionId);
    facts.push(`<dt>${escapeHtml(t("conversation.checkpoint_continuation"))}</dt><dd><a href="/${escapeHtml(provider)}/session/${encoded}">${escapeHtml(compaction.continuationSessionId)}</a></dd>`);
  }
  const result = summary
    ? `<div class="compaction-checkpoint-result"><span class="compaction-checkpoint-result-label">${escapeHtml(t("conversation.checkpoint_result_label"))}</span><span class="compaction-checkpoint-summary">${escapeHtml(summary)}</span></div>`
    : `<div class="compaction-checkpoint-result compaction-checkpoint-result-missing">${escapeHtml(t("conversation.checkpoint_result_missing"))}</div>`;
  const evidence = facts.length
    ? `<details class="compaction-checkpoint-details"><summary>${escapeHtml(t("conversation.checkpoint_details"))}</summary><dl class="compaction-checkpoint-facts">${facts.join("")}</dl></details>`
    : "";
  return `<section id="${escapeHtml(anchorId("checkpoint", compaction.id))}" class="compaction-checkpoint" data-compaction-checkpoint="${escapeHtml(compaction.id)}" data-compaction-placement="${placement}" data-compaction-fidelity="${escapeHtml(compaction.fidelity || "")}">
    <span class="compaction-checkpoint-kicker">${escapeHtml(t("conversation.checkpoint_kicker"))}</span>
    ${meta ? `<span class="compaction-checkpoint-meta">${escapeHtml(meta)}</span>` : ""}
    ${result}
    ${evidence}
  </section>`;
}

/**
 * Group the canonical message spine by user turn and interleave compaction
 * checkpoints at their causal position. Checkpoints are placed after the
 * message whose id their protocol anchor names; when the anchor names no
 * spine message (e.g. DSH sequence ids), the recorded timestamp is used as a
 * derived fallback, and a checkpoint with neither renders after all segments.
 * Thread and Linear are presentation modes over the same SSR content;
 * checkpoints render exactly once, in both modes, and never as a message
 * group or ToC entry.
 */
function renderConversationThread(entries: ConversationEntry[], compactions: any[], provider: string) {
  // Resolve each checkpoint to the entry index it follows and to one of the
  // explicit placement kinds: -1 means before the first entry; entries.length
  // means after the last (explicit end placement). The placement kind is
  // derived exactly once here and never recomputed downstream.
  const byEntryIndex = new Map<number, Array<{ compaction: any; placement: "anchored" | "timestamp" | "end" }>>();
  const indexOf = (messageId: string) => entries.findIndex((entry) => entry.messageId === messageId);
  const place = (compaction: any) => {
    const anchored = compaction.anchorMessageId ? indexOf(compaction.anchorMessageId) : -2;
    let position: number;
    let placement: "anchored" | "timestamp" | "end";
    if (anchored >= 0) {
      position = anchored;
      placement = "anchored";
    } else {
      const timestamp = Number(compaction.timestamp);
      const hasTimestamp = Number.isFinite(timestamp) && timestamp > 0;
      position = hasTimestamp
        ? entries.reduce((found, entry, index) => (entry.timeCreated && entry.timeCreated <= timestamp ? index : found), -1)
        : entries.length;
      placement = hasTimestamp ? "timestamp" : "end";
    }
    const list = byEntryIndex.get(position) || [];
    list.push({ compaction, placement });
    byEntryIndex.set(position, list);
  };
  for (const compaction of compactions) {
    place(compaction);
  }

  const items: Array<{ kind: "block" | "checkpoint"; role?: string; html: string }> = [];
  const pushCheckpoints = (position: number) => {
    for (const placed of byEntryIndex.get(position) || []) {
      items.push({ kind: "checkpoint", html: renderCompactionCheckpoint(placed.compaction, provider, placed.placement) });
    }
  };
  pushCheckpoints(-1);
  entries.forEach((entry, index) => {
    if (entry.markup) {
      items.push({ kind: "block", role: entry.role, html: entry.markup });
    }
    if (byEntryIndex.has(index)) {
      pushCheckpoints(index);
    }
  });

  const segments: Array<{ userTurn: boolean; userTurnIndex: number; blocks: string[] }> = [];
  let current = null as { userTurn: boolean; userTurnIndex: number; blocks: string[] } | null;
  let userTurnIndex = 0;
  for (const item of items) {
    if (item.kind === "block" && item.role === "user") {
      userTurnIndex += 1;
      current = { userTurn: true, userTurnIndex, blocks: [] };
      segments.push(current);
    } else if (!current) {
      current = { userTurn: false, userTurnIndex: 0, blocks: [] };
      segments.push(current);
    }
    current.blocks.push(item.html);
  }

  const thread = segments.map((segment) => {
    const header = segment.userTurn
      ? `<header class="thread-turn-header"><span class="thread-turn-kicker">${escapeHtml(t("conversation.thread_turn"))} ${segment.userTurnIndex}</span></header>`
      : "";
    const turnClass = segment.userTurn ? " thread-turn-user" : " thread-turn-prelude";
    return `<section class="thread-turn${turnClass}">${header}<div class="thread-turn-content">${segment.blocks.join("\n")}</div></section>`;
  }).join("\n");

  const trailing = byEntryIndex.get(entries.length) || [];
  return trailing.length
    ? `${thread}${thread ? "\n" : ""}${trailing.map((placed) => renderCompactionCheckpoint(placed.compaction, provider, placed.placement)).join("\n")}`
    : thread;
}

function renderConversationPanel(entries: ConversationEntry[], compactions: any[], provider: string, defaultMode: string, detachedMarkup = "", normalizedMessageCount = entries.length) {
  const threadMarkup = renderConversationThread(entries, compactions, provider);
  if (!threadMarkup && !detachedMarkup) {
    return `<section id="session-messages" class="messages"><p class="empty-state">${escapeHtml(t("detail.no_messages"))}</p></section>`;
  }

  const toggle = `
    <div class="conversation-view-bar" data-conversation-view>
      <div class="conversation-view-toggle" role="group" aria-label="${escapeHtml(t("conversation.view_label"))}">
        <button type="button" class="conversation-view-btn" data-conversation-view-mode="thread" aria-pressed="${defaultMode === "thread" ? "true" : "false"}">${escapeHtml(t("conversation.view_thread"))}</button>
        <button type="button" class="conversation-view-btn" data-conversation-view-mode="linear" aria-pressed="${defaultMode === "linear" ? "true" : "false"}">${escapeHtml(t("conversation.view_linear"))}</button>
      </div>
    </div>`;
  return `${toggle}
    <section id="session-messages" class="messages conversation-${escapeHtml(defaultMode)}" data-conversation-default="${escapeHtml(defaultMode)}" data-conversation-message-count="${normalizedMessageCount}">
      ${threadMarkup}
      ${detachedMarkup}
    </section>`;
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
  runtimeAvailable = false,
  navigationContext = null,
  conversationCompactions = []
}: { session: any; sessionTree?: any; sessionMetrics?: any; messages?: any[]; partsByMessage?: Map<any, any>; todos?: any[]; recentSessions?: any[]; meta?: any; provider?: string; providers?: any[]; manageable?: boolean; resumeCommand?: any; terminalLaunchAllowed?: boolean; runtimeWorkbench?: string; runtimeAvailable?: boolean; navigationContext?: SessionNavigationContext | null; conversationCompactions?: ConversationCompaction[] }) {
  const title = session.title || session.slug || session.id;
  const starred = meta?.starred ? 1 : 0;
  const encodedProvider = encodeURIComponent(provider);
  const encodedSessionId = encodeURIComponent(session.id);
  const providerName = providers.find((item: any) => item.id === provider)?.name || provider;
  const recordedFiles = session.summary_files != null ? String(Number(session.summary_files) || 0) : null;
  const recordedAdditions = session.summary_additions != null ? String(Number(session.summary_additions) || 0) : null;
  const recordedDeletions = session.summary_deletions != null ? String(Number(session.summary_deletions) || 0) : null;
  const startTime = Number(session.time_created);
  const recordedStart = Number.isFinite(startTime) && startTime > 0
    ? new Date(startTime).toLocaleString()
    : t("detail.not_recorded");
  const sourceLabel = navigationContext?.section === "stats" ? t("nav.stats") : t("nav.sessions");
  const backHref = navigationContext?.href || "/sessions";
  const currentRecentIndex = recentSessions.findIndex((item: any) => String(item.id) === String(session.id));
  const previousSession = currentRecentIndex > 0 ? recentSessions[currentRecentIndex - 1] : null;
  const nextSession = currentRecentIndex >= 0 && currentRecentIndex < recentSessions.length - 1 ? recentSessions[currentRecentIndex + 1] : null;
  const sessionHref = (item: any) => `/${encodeURIComponent(item.provider || provider)}/session/${encodeURIComponent(item.id)}`;
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
  ` : `<span class="action-btn action-unavailable" aria-disabled="true">${escapeHtml(t("detail.resume_unavailable"))}</span>`;
  const exportActions = `
        <a class="action-btn" href="/api/${encodedProvider}/session/${encodedSessionId}/export?format=md">${t("action.export_md")}</a>
        <a class="action-btn" href="/api/${encodedProvider}/session/${encodedSessionId}/export?format=json">${t("action.export_json")}</a>
  `;
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
          <a class="action-btn session-back-link" href="${escapeHtml(backHref)}">← ${escapeHtml(t("detail.back"))}</a>
          ${previousSession ? `<a class="action-btn session-neighbor" href="${sessionHref(previousSession)}" aria-label="${escapeHtml(t("detail.previous"))}">← ${escapeHtml(t("detail.previous"))}</a>` : ""}
          ${nextSession ? `<a class="action-btn session-neighbor" href="${sessionHref(nextSession)}" aria-label="${escapeHtml(t("detail.next"))}">${escapeHtml(t("detail.next"))} →</a>` : ""}
          ${resumeActions}
          ${exportActions}
          ${renderTranscriptSearch()}
          ${moreActionsDropdown}
        </div>
        ${resumePreview}
      </div>
  `;

  const header = `
    <header class="session-header">
      <div class="session-title-row">
        <h1>${escapeHtml(title)}</h1>
        <span class="session-provider-badge" title="${escapeHtml(providerName || t("detail.no_provider"))}">${escapeHtml(providerName || t("detail.no_provider"))}</span>
      </div>
      <div class="session-meta-row">
        <span class="session-directory"><span class="session-meta-label">${escapeHtml(t("detail.project"))}</span> ${escapeHtml(session.directory || t("detail.no_project"))}</span>
        <span class="session-meta-sep">·</span>
        <span><span class="session-meta-label">${escapeHtml(t("detail.started"))}</span> ${escapeHtml(recordedStart)}</span>
        <span class="session-meta-sep">·</span>
        <span>${escapeHtml(recordedFiles ?? t("detail.not_recorded"))} ${t("detail.files")}</span>
        ${recordedAdditions == null ? `<span class="session-meta-empty">${escapeHtml(t("detail.not_recorded"))} ${t("detail.additions")}</span>` : `<span class="additions">+${escapeHtml(recordedAdditions)}</span>`}
        ${recordedDeletions == null ? `<span class="session-meta-empty">${escapeHtml(t("detail.not_recorded"))} ${t("detail.deletions")}</span>` : `<span class="deletions">-${escapeHtml(recordedDeletions)}</span>`}
      </div>
${actions}
    </header>
  `;

  const conversationEntries = sessionTree
    ? renderSessionMessageEntries(sessionTree, 0, provider)
    : renderRawMessageEntries(messages, partsByMessage, provider);
  // Canonical rendered top-level conversation entries: raw tool rows are
  // merged into their assistant entry, messages that render no visible
  // content produce no block, and tree rows without markup contribute
  // nothing — so the count reflects the actual thread spine, not the raw
  // tool/compact/inherited row totals.
  const renderedEntryCount = conversationEntries.filter((entry) => entry.markup).length;
  const conversationDefault = conversationDefaultMode(renderedEntryCount);
  const detachedMarkup = sessionTree
    ? (sessionTree.detachedChildren || []).map((child: SessionTree) => renderSessionTree(child, 1, provider, true)).filter(Boolean).join("\n")
    : "";
  const conversationMarkup = renderConversationPanel(conversationEntries, conversationCompactions, provider, conversationDefault, detachedMarkup, renderedEntryCount);

  const sessionMetadata = session.metadata && typeof session.metadata === "object"
    ? session.metadata as Record<string, unknown>
    : {};
  const projectKey = typeof sessionMetadata.projectKey === "string" && sessionMetadata.projectKey.trim()
    ? sessionMetadata.projectKey.trim()
    : null;
  const projectEvidence = projectKey
    ? `<p class="session-project-evidence"><strong>${escapeHtml(t("detail.project_key"))}</strong> <code>${escapeHtml(projectKey)}</code>${sessionMetadata.projectDirectorySource === "configured" ? ` · ${escapeHtml(t("detail.project_directory_configured"))}` : ""}</p>`
    : "";

  const body = `
<div class="session-workbench" data-session-id="${escapeHtml(session.id)}" data-provider="${escapeHtml(provider)}">
  ${renderToc(sessionTree)}
  <section id="${escapeHtml(anchorId("session", session.id))}" class="main-content">
    ${breadcrumb}
    ${header}
    <div class="tab-bar" role="tablist" aria-label="${escapeHtml(t("detail.tab_bar_label"))}" hidden>
      <button role="tab" aria-selected="true" aria-controls="tab-work" id="tab-btn-work" tabindex="0">${t("detail.tab_work")}</button>
      <button role="tab" aria-selected="false" aria-controls="tab-conversation" id="tab-btn-conversation" tabindex="-1">${t("detail.tab_conversation")}</button>
      <button role="tab" aria-selected="false" aria-controls="tab-events" id="tab-btn-events" tabindex="-1">${t("detail.tab_events")}</button>
    </div>
    <div role="tabpanel" id="tab-work" aria-labelledby="tab-btn-work">
      ${runtimeWorkbench || `<p class="empty-state">${t("runtime.unavailable")}</p>`}
      ${projectEvidence}
      ${renderSessionMetricsPanel(sessionMetrics)}
      ${todoList(todos)}
    </div>
    <div role="tabpanel" id="tab-conversation" aria-labelledby="tab-btn-conversation">
      ${conversationMarkup}
    </div>
    <div role="tabpanel" id="tab-events" aria-labelledby="tab-btn-events">
      <section id="detail-events-shell" class="detail-events-shell">
        <h2>${escapeHtml(t("detail.events_shell_title"))}</h2>
        <p>${escapeHtml(t("detail.events_shell_description"))}</p>
        ${runtimeAvailable ? `<button type="button" class="action-btn" data-detail-focus="runtime-evidence">${escapeHtml(t("detail.events_shell_open"))}</button>` : `<p class="empty-state">${escapeHtml(t("runtime.unavailable"))}</p>`}
      </section>
    </div>
  </section>
</div>
  `;

  return layout(title, body, navigationContext?.section === "stats" ? "stats" : "home", { provider, providers, manageable });
}
