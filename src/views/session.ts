import { t } from "../i18n.js";
import { escapeHtml } from "../markdown.js";
import { buildPartsFromProviderMessages } from "../session-queries.js";
import { questionAnswersText } from "../providers/shared/question-answers.js";
import type { SessionMessageNode, SessionPartNode, SessionTree } from "../providers/opencode/session-tree.js";
import { isSubagentTool, mergeToolMetadata } from "../providers/shared/subagent-tools.js";
import { formatDuration, formatLocalizedDurationMs, formatTime, formatTokens, messageBubble, messageHeader, reasoningBlock, todoList, toolCallBlock } from "./components.js";
import { anchorId } from "./anchors.js";
import { layout } from "./layout.js";
import { readerEventHref, renderReaderEventSourceLink, renderReaderCoordinationItem } from "./reader-coordination.js";
import { readerRelationPositionKey, renderReaderRelations } from "./reader-relations.js";
import { renderReaderTaskGraph } from "./reader-task-graph.js";
import { appendReaderExecutionMarkers } from "./reader-executions.js";
import type { ReaderExecutions } from "../reader-executions.js";
import type { ReaderTeamDirectoryPage } from "../reader-teams.js";
import { uiIcon } from "../ui-icons.js";
import { renderReaderArtifacts, type ContextArtifactSourceState } from "./reader-artifacts.js";
import type { ContextArtifact } from "../providers/shared/session-protocol.js";
import type { ReaderRelationMarkup } from "./reader-relations.js";
import type { ReaderRelations } from "../reader-relations.js";
import { renderReaderTeams } from "./reader-teams.js";
import type { SessionNavigationContext } from "../navigation-context.js";
import type { ConversationCompaction } from "../protocol-runtime.js";
import type { InheritedContextView, MessagePresentationPhase, OwnedReaderChildDescriptor, OwnedReaderProjection } from "../providers/interface.js";
import type {
  ConversationAgentCard,
  ConversationChannelItem,
  ConversationInspectorView,
  ConversationTaskDirectoryPage,
  ConversationTaskGroup,
  ConversationTurnBoundary,
  ConversationViewModel
} from "../conversation-view-model.js";
import { groupConversationCards } from "../conversation-view-model.js";

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
  return compactText((textPart?.data?.questionAnswers ? questionAnswersText(textPart.data.questionAnswers) : textPart?.data?.text) || message.data?.summary || messageToolName(message) || message.id, 86);
}

function tocMessageText(message: any) {
  const textPart = message.parts.find((part: any) => part.type === "text" && compactText(part.data?.text));
  return compactText(textPart?.data?.questionAnswers ? questionAnswersText(textPart.data.questionAnswers) : textPart?.data?.text || "", 86);
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
  return `<span class="session-stat"><span class="session-stat-label">${escapeHtml(label)}</span><strong class="session-stat-value">${escapeHtml(String(value))}</strong></span>`;
}

function renderChildSessionExportActions(child: { provider?: string; sessionId: string } | null | undefined, provider: string, suffix = "", available: boolean | null = null) {
  if (!child?.sessionId || available === false) {
    return "";
  }
  const childProvider = child.provider || provider;
  const encoded = encodeURIComponent(child.sessionId);
  return `<span class="subagent-actions" aria-label="Subagent export actions">
    <a class="subagent-export-btn" data-reader-open data-reader-provider="${escapeHtml(childProvider)}" data-reader-session="${escapeHtml(child.sessionId)}" href="/${escapeHtml(childProvider)}/session/${encoded}" title="${escapeHtml(`Open${suffix}`)}">Open</a>
    <a class="subagent-export-btn" href="/api/${escapeHtml(childProvider)}/session/${encoded}/export?format=md" title="${escapeHtml(`Export${suffix} as Markdown`)}">MD</a>
    <a class="subagent-export-btn" href="/api/${escapeHtml(childProvider)}/session/${encoded}/export?format=json" title="${escapeHtml(`Export${suffix} as JSON`)}">JSON</a>
  </span>`;
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

  const suffix = part.childSessions.length > 1 ? ` first session of ${part.childSessions.length}` : "";
  return renderChildSessionExportActions({ provider, sessionId: childId }, provider, suffix);
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
  return `<details class="subagent-branch${inferred ? " subagent-branch-inferred" : ""}" data-subsession-container="task" data-subagent-relationship="${inferred ? "inferred" : "explicit"}" data-parent-part-id="${escapeHtml(part.id)}">
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

type ReaderChildTarget = SessionTree | OwnedReaderChildDescriptor;

function isOwnedReaderChild(child: ReaderChildTarget): child is OwnedReaderChildDescriptor {
  return !("session" in child);
}

function renderChildReaderLink(child: ReaderChildTarget, provider = "opencode", inferred = false) {
  const childId = isOwnedReaderChild(child) ? child.sessionId : child.session.id;
  const title = isOwnedReaderChild(child) ? (child.title || childId) : (child.session.title || child.session.slug || childId);
  const childProvider = isOwnedReaderChild(child) ? child.provider : (child.session.provider || provider);
  const childInferred = isOwnedReaderChild(child) ? child.link === "inferred" : inferred;
  const href = `/${escapeHtml(childProvider)}/session/${encodeURIComponent(childId)}`;
  if (isOwnedReaderChild(child)) {
    return `<details class="subagent-reader-link subagent-reader-link-disclosure${childInferred ? " subagent-reader-link-inferred" : ""}" data-reader-child-disclosure data-reader-child-provider="${escapeHtml(childProvider)}" data-reader-child-session="${escapeHtml(childId)}" data-reader-child-state="${child.available ? "recorded" : "unavailable"}">
      <summary class="subagent-existing-link"><span class="subsession-kicker">${escapeHtml(childInferred ? t("detail.related_history") : t("detail.subsession"))}</span><span class="subsession-title">${escapeHtml(title)}</span><span class="subsession-meta">${escapeHtml(t("detail.reader_open_child"))}</span></summary>
      <div class="reader-child-disclosure-body"><div data-reader-child-preview-state>${escapeHtml(child.available ? t("detail.reader_open_child") : t("conversation.inspector_session_unavailable"))}</div><div data-reader-child-token-state></div><a class="reader-child-history-link" data-reader-open data-reader-provider="${escapeHtml(childProvider)}" data-reader-session="${escapeHtml(childId)}" href="${href}">${escapeHtml(t("detail.reader_child_history"))}</a></div>
    </details>`;
  }
  return `<p class="subagent-reader-link${inferred ? " subagent-reader-link-inferred" : ""}" data-session-id="${escapeHtml(childId)}" data-reader-child-state="${child.session.available === false ? "unavailable" : "recorded"}">
    <a class="subagent-existing-link" data-reader-open data-reader-provider="${escapeHtml(childProvider)}" data-reader-session="${escapeHtml(childId)}" href="${href}">
      <span class="subsession-kicker">${escapeHtml(inferred ? t("detail.related_history") : t("detail.subsession"))}</span>
      <span class="subsession-title">${escapeHtml(title)}</span>
      <span class="subsession-meta">${escapeHtml(t("detail.reader_open_child"))}</span>
    </a>
  </p>`;
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

function renderMessageGroup(message: any, markup: any, provider: string, anchorPrefix = "msg") {
  const role = messageTurnRole(message.role);
  const messageAnchor = escapeHtml(anchorId(anchorPrefix, message.id));
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

function collectMessageTaskTocNodes(message: any, parentAgentDepth: any, seenChildSessionIds = new Set<string>(), provider = "opencode", ownedChildrenByPart: Map<string, OwnedReaderChildDescriptor[]> | null = null): any[] {
  const nodes: any[] = [];
  const childNode = (child: ReaderChildTarget, labelOverride = "", metaOverride = "") => {
    const childSessionId = isOwnedReaderChild(child) ? child.sessionId : child.session?.id || "";
    const childSession = isOwnedReaderChild(child) ? child : child.session;
    const childLabel = isOwnedReaderChild(child) ? child.title : child.session.title || child.session.slug;
    return {
      ...makeTocNode(
        anchorId("session", childSessionId),
        "Task",
        labelOverride || childLabel || childSessionId || t("detail.subsession"),
        metaOverride || t("detail.subsession"),
        parentAgentDepth + 1
      ),
      readerProvider: isOwnedReaderChild(child) ? child.provider : child.session?.provider || provider,
      readerSession: childSessionId
    };
  };

  for (const part of message.parts) {
    const childTargets: ReaderChildTarget[] = [
      ...part.childSessions,
      ...(ownedChildrenByPart?.get(String(part.id)) || [])
    ];
    if (part.type === "tool" && isTaskTool(part.data)) {
      const children = childTargets
        .filter((child: any) => {
          const childId = isOwnedReaderChild(child) ? child.sessionId : child.session.id;
          if (seenChildSessionIds.has(childId)) {
            return false;
          }
          seenChildSessionIds.add(childId);
          return true;
        })
        .map((child) => childNode(child));
      if (children.length === 1) {
        // A task and its single canonical child are one navigable work item;
        // the native part anchor remains in the transcript for evidence.
        nodes.push(childNode(
          childTargets.find((child: ReaderChildTarget) => (isOwnedReaderChild(child) ? child.sessionId : child.session?.id) === children[0].readerSession) || childTargets[0],
          taskDisplayTitle(part.data),
          t("detail.subsession")
        ));
      } else {
        nodes.push(makeTocNode(
          anchorId("part", part.id),
          "Task",
          taskDisplayTitle(part.data),
          childTargets.length ? childSessionCountLabel(childTargets.length) : partStatus(part.data) || part.tool || "task",
          parentAgentDepth + 1,
          children
        ));
      }
    }

    for (const child of childTargets) {
      if (!(part.type === "tool" && isTaskTool(part.data))) {
        const childId = isOwnedReaderChild(child) ? child.sessionId : child.session.id;
        if (!seenChildSessionIds.has(childId)) {
          seenChildSessionIds.add(childId);
          nodes.push(childNode(child));
        }
      }
    }
  }

  return nodes;
}

function isRecordedFinalMessage(message: any) {
  return messageTurnRole(message.role) === "assistant"
    && hasOwnMessageBubble(message)
    && message.data?.presentationPhase === "final";
}

function foldedCommentaryMessageIds(messages: any[]) {
  const folded = new Set<string>();
  let hasLaterFinal = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const role = String(message.role || "").toLowerCase();
    if (role === "user") {
      hasLaterFinal = false;
    } else {
      if (message.data?.presentationPhase === "commentary" && hasLaterFinal) {
        folded.add(String(message.id || ""));
      }
      if (isRecordedFinalMessage(message)) {
        hasLaterFinal = true;
      }
    }
  }
  return folded;
}

function collectTocNodes(tree: SessionTree, userDepth = 0, provider = "opencode", ownedChildrenByPart: Map<string, OwnedReaderChildDescriptor[]> | null = null, ownedDetachedChildren: OwnedReaderChildDescriptor[] = []): any[] {
  const nodes: any[] = [];
  let currentUserNode: any = null;
  const foldedCommentary = foldedCommentaryMessageIds(tree.messages);
  const seenChildSessionIds = new Set<string>();

  tree.messages.forEach((message) => {
    const role = String(message.role || "").toLowerCase();
    if (!isNavigableMessageRole(role)) {
      return;
    }

    const label = foldedCommentary.has(String(message.id || "")) ? "" : tocMessageText(message);
    const agentDepth = userDepth + 1;
    const taskNodes: any = collectMessageTaskTocNodes(message, label ? agentDepth : userDepth, seenChildSessionIds, provider, ownedChildrenByPart);
    if (!label) {
      if (taskNodes.length) {
        if (currentUserNode) {
          currentUserNode.children.push(...taskNodes);
        } else {
          nodes.push(...taskNodes);
        }
      }
      return;
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
      return;
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
  });

  for (const child of [...tree.detachedChildren, ...ownedDetachedChildren]) {
    const childId = isOwnedReaderChild(child) ? child.sessionId : child.session.id;
    if (seenChildSessionIds.has(childId)) {
      continue;
    }
    seenChildSessionIds.add(childId);
    nodes.push({
      ...makeTocNode(
        anchorId("session", childId || ""),
        "Task",
        (isOwnedReaderChild(child) ? child.title : child.session.title || child.session.slug || child.session.id) || t("detail.subsession"),
        t("detail.subsession"),
        userDepth + 1
      ),
      readerProvider: isOwnedReaderChild(child) ? child.provider : child.session.provider || provider,
      readerSession: childId || ""
    });
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
  const readerAttributes = node.readerSession
    ? ` data-reader-open data-reader-provider="${escapeHtml(node.readerProvider || "opencode")}" data-reader-session="${escapeHtml(node.readerSession)}"`
    : "";
  const readerHref = node.readerSession
    ? `/${escapeHtml(node.readerProvider || "opencode")}/session/${encodeURIComponent(node.readerSession)}`
    : `#${escapeHtml(node.id)}`;
  const link = `<a class="toc-link toc-${escapeHtml(node.type.toLowerCase())}" href="${escapeHtml(readerHref)}"${readerAttributes} title="${escapeHtml(linkTitle)}" style="--toc-depth:${Math.min(node.depth, 6)}">
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

function renderToc(tree: SessionTree | null, provider = "opencode", ownedReader: OwnedReaderProjection | null = null) {
  if (!tree) {
    return `<aside class="session-toc"><h2>${escapeHtml(t("detail.toc_navigate"))}</h2><p class="toc-empty">${escapeHtml(t("detail.toc_no_indexed_messages"))}</p><button class="toc-resize-handle" type="button" aria-label="${escapeHtml(t("detail.toc_resize"))}"></button></aside>`;
  }

  const ownedChildrenByPart = new Map<string, OwnedReaderChildDescriptor[]>();
  for (const child of ownedReader?.children || []) {
    if (child.parentPartId) {
      const entries = ownedChildrenByPart.get(child.parentPartId) || [];
      entries.push(child);
      ownedChildrenByPart.set(child.parentPartId, entries);
    }
  }
  const nodes = collectTocNodes(tree, 0, provider, ownedChildrenByPart, (ownedReader?.children || []).filter((child) => child.detached));
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

export function renderSessionMetricsPanel(sessionMetrics: any, lazy: { provider: string; sessionId: string } | null = null) {
  if (!sessionMetrics?.totals) {
    return lazy
      ? `<section class="session-metrics-panel" data-reader-metrics data-reader-metrics-provider="${escapeHtml(lazy.provider)}" data-reader-metrics-session="${escapeHtml(lazy.sessionId)}"><p class="metrics-detail" data-reader-metrics-state>${escapeHtml(t("runtime.unavailable"))}</p></section>`
      : "";
  }

  const totals = sessionMetrics.totals;
  const topTools = Array.isArray(sessionMetrics.tools)
    ? sessionMetrics.tools.slice(0, 5).map((tool: any) => `${tool.name} ${tool.count}`).join(" · ")
    : "";
  const directTokenPieces = [
    `${formatCount(totals.directInputTokens)} ${t("detail.metric_input")}`,
    `${formatCount((Number(totals.directOutputTokens) || 0) + (Number(totals.directReasoningTokens) || 0))} ${t("detail.metric_output")}`,
    totals.directCacheReadTokens ? `${formatCount(totals.directCacheReadTokens)} ${t("detail.metric_cache_read")}` : "",
    totals.directCacheWriteTokens ? `${formatCount(totals.directCacheWriteTokens)} ${t("detail.metric_cache_write")}` : ""
  ].filter(Boolean).join(" · ");
  const hasFamilyUsage = Number(totals.totalTokens) !== Number(totals.directTotalTokens);
  const tokenPieces = `${t("detail.tokens_direct", { count: formatCount(totals.directTotalTokens) })}${directTokenPieces ? ` · ${directTokenPieces}` : ""}${hasFamilyUsage ? ` · ${t("detail.tokens_inclusive", { count: formatCount(totals.totalTokens) })}` : ""}`;

  return `<section class="session-metrics-panel">
    <div class="metrics-grid">
      ${renderMetric(t("detail.metric_messages"), formatCount(totals.messages))}
      ${renderMetric(t("detail.metric_steps"), formatCount(totals.steps))}
      ${renderMetric(t("detail.metric_tools"), formatCount(totals.toolCalls))}
      ${renderMetric(t("detail.metric_branches"), formatCount(totals.branches))}
      ${renderMetric(t("detail.metric_recorded_span"), formatLocalizedDurationMs(totals.runtimeMs) || `0${t("runtime.seconds_short")}`)}
      ${renderMetric(t("detail.metric_cost"), totals.cost ? `$${Number(totals.cost).toFixed(4)}` : "$0")}
    </div>
    <p class="metrics-detail">${escapeHtml(tokenPieces)}</p>
    ${topTools ? `<p class="metrics-detail"><span class="metrics-detail-label">${escapeHtml(t("detail.metric_top_tools"))}</span> ${escapeHtml(topTools)}</p>` : ""}
  </section>`;
}

function renderReasoningPart(partData: any, partId = "", contentScope = "") {
  return reasoningBlock(
    partData?.text || "",
    formatDuration(partData?.time?.start, partData?.time?.end),
    partId,
    contentScope
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
      questionAnswers: partData.questionAnswers,
      model: messageModelLabel(messageData),
      tokens: messageData.tokens,
      tokenRequests: messageData.tokenRequests,
      tokenRequestCount: messageData.tokenRequestCount,
      cacheWarning: messageData.cacheWarning,
      time: messageData.time?.created,
      contentScope: messageData.contentScope
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
      partId,
      messageData.contentScope
    );
  }

  if (["step-start", "step-finish", "snapshot", "patch"].includes(partData.type)) {
    return "";
  }

  return "";
}

function renderPartNode(messageData: any, part: SessionPartNode, depth = 0, provider = "opencode", reasoningMarkup = "", view: ConversationViewModel | null = null, placedCardIds: Set<string> | null = null, ownedChildren: OwnedReaderChildDescriptor[] = []): string {
  const isTaskPart = part.type === "tool" && isTaskTool(part.data);
  const childTargets: ReaderChildTarget[] = [...part.childSessions, ...ownedChildren];
  const isTaskWithSession = isTaskPart && childTargets.length > 0;
  // P2b: a compact agent card decorates the existing task/child content on the
  // main reading spine only when real Task/AgentRun/Actor evidence binds it.
  // Without a binding, the existing nested-session rendering remains intact.
  const boundCard = isTaskPart && depth === 0
    ? conversationCardForPart(view, part, String(messageData?.id || ""), placedCardIds, ownedChildren)
    : null;
  if (boundCard) {
    placedCardIds?.add(boundCard.id);
    const taskMarkup = renderPart(messageData, part.data, part.id, "");
    const childMarkup = childTargets
      .map((child) => renderChildReaderLink(child, provider, false))
      .filter(Boolean)
      .join("\n");
    // Keep the tool's canonical part id on its native disclosure. The card's
    // wrapper therefore does not emit a second `part-*` id.
    const retainedMarkup = [taskMarkup, childMarkup].filter(Boolean).join("\n");
    return renderAgentCard(boundCard, part, provider, retainedMarkup, String(part.sessionId || ""));
  }
  const renderedPart = isTaskPart
    ? renderPart(messageData, part.data, part.id, "")
    : renderPart(messageData, part.data, part.id, reasoningMarkup);
  const partAnchor = escapeHtml(anchorId("part", part.id));
  const renderedPartOwnsAnchor = part.type === "tool" && Boolean(renderedPart);

  // A task can produce more than one child session. Give each child its own
  // branch container so navigation, export actions, and QA identify every
  // session instead of collapsing several IDs into one visual branch.
  if (isTaskWithSession) {
    const branches: any = childTargets.map((child, index) => {
      const childMarkup = renderChildReaderLink(child, provider, false);
      if (isOwnedReaderChild(child)) {
        return `<div class="subsession-branch" data-parent-part-id="${escapeHtml(part.id)}">${childMarkup}</div>`;
      }
      return renderSubagentBranch(
        { ...part, childSessions: [child] },
        childMarkup,
        provider,
        index === 0 ? reasoningMarkup : ""
      );
    }).join("\n");
    const anchorAttribute = renderedPartOwnsAnchor ? "" : ` id="${partAnchor}"`;
    return `<div class="session-part-anchor"${anchorAttribute}>${renderedPart}${branches}</div>`;
  }

  const childMarkup = childTargets
    .map((child) => renderChildReaderLink(child, provider, false))
    .filter(Boolean)
    .join("\n");
  if (!childMarkup && !renderedPart) {
    return "";
  }

  const branch = `<div class="subsession-branch" data-parent-part-id="${escapeHtml(part.id)}">${childMarkup}</div>`;

  const anchorAttribute = renderedPartOwnsAnchor ? "" : ` id="${partAnchor}"`;
  return `<div class="session-part-anchor"${anchorAttribute}>${renderedPart}${branch}</div>`;
}

function attachReasoningToRenderedPart(renderedPart: any, reasoningMarkup: any) {
  if (!renderedPart || !reasoningMarkup) {
    return null;
  }

  if (renderedPart.includes('class="message-group message-turn ')) {
    return renderedPart.replace("</article>", () => `${renderTurnReasoning(reasoningMarkup)}</article>`);
  }

  if (renderedPart.includes('class="message message-')) {
    return renderedPart.replace("</header>", () => `</header><div class="message-reasoning">${reasoningMarkup}</div>`);
  }

  if (renderedPart.includes('class="tool-call ')) {
    return `${renderedPart}${renderTurnReasoning(reasoningMarkup)}`;
  }

  if (renderedPart.includes('class="subagent-body"')) {
    return renderedPart.replace('<div class="subagent-body">', () => `<div class="subagent-body"><div class="subagent-reasoning">${reasoningMarkup}</div>`);
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

interface ReaderProcessTool {
  part: SessionPartNode;
  reasoning: SessionPartNode[];
}

interface ReaderProcessChunk {
  messageId: string;
  tools: ReaderProcessTool[];
  parts: SessionPartNode[];
}

const READER_PROCESS_CHUNK_SIZE = 20;

function processAttentionCount(parts: SessionPartNode[]): number {
  return parts.filter((part) => part.type === "tool"
    && ["error", "failed", "interrupted", "cancelled"].includes(part.data.state?.status)).length;
}

/** Same source boundaries as execution disclosures, before any tool HTML is built. */
function readerProcessChunks(message: SessionMessageNode, relations: ReaderRelationMarkup | null, ownedChildParts: Set<string>): ReaderProcessChunk[] {
  const chunks: ReaderProcessChunk[] = [];
  const partIndexes = new Map(message.parts.map((part, index) => [part, index]));
  let tools: ReaderProcessTool[] = [];
  let reasoning: SessionPartNode[] = [];
  const flush = () => {
    if (tools.length) {
      const first = tools[0].reasoning[0] || tools[0].part;
      const last = tools[tools.length - 1].part;
      chunks.push({ messageId: message.id, tools, parts: message.parts.slice(partIndexes.get(first), partIndexes.get(last)! + 1) });
    }
    tools = [];
  };
  const boundary = (part: SessionPartNode, side: "before" | "after") => {
    const key = readerRelationPositionKey(part.id, side);
    if (!relations?.parts.has(key) || relations.processPositions.has(key)) return;
    flush();
    reasoning = [];
  };
  for (const part of message.parts) {
    boundary(part, "before");
    if (part.type === "reasoning") {
      if (part.data.text) reasoning.push(part);
    } else if (part.type === "tool" && !part.childSessions.length && !ownedChildParts.has(part.id) && !isTaskTool(part.data)) {
      tools.push({ part, reasoning });
      reasoning = [];
      if (tools.length === READER_PROCESS_CHUNK_SIZE) flush();
    } else if (isVisiblePartNode(part) || ownedChildParts.has(part.id)) {
      flush();
      reasoning = [];
    }
    boundary(part, "after");
  }
  flush();
  return chunks;
}

function processPartRelation(relations: ReaderRelationMarkup | null, partId: string, side: "before" | "after") {
  const key = readerRelationPositionKey(partId, side);
  return relations?.processPositions.has(key) ? relations.parts.get(key) || "" : "";
}

function renderReaderProcessPlaceholder(chunk: ReaderProcessChunk, provider: string, sessionId: string, relations: ReaderRelationMarkup | null): string {
  const firstPartId = chunk.tools[0].part.id;
  const lastPartId = chunk.tools[chunk.tools.length - 1].part.id;
  const count = String(chunk.tools.length);
  const query = new URLSearchParams({ messageId: chunk.messageId, firstPartId, lastPartId });
  const url = `/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}/reader/process?${query}`;
  const anchoredParts = new Set(chunk.tools.flatMap(({ part, reasoning }) => [...reasoning, part]));
  const anchors = chunk.parts.map((part) => {
    const anchor = anchoredParts.has(part)
      ? `<span id="${escapeHtml(anchorId("part", part.id))}" data-part-id="${escapeHtml(part.id)}" data-reader-process-anchor aria-hidden="true"></span>` : "";
    return processPartRelation(relations, part.id, "before") + anchor + processPartRelation(relations, part.id, "after");
  }).join("");
  return `<div data-reader-process-chunk class="reader-process-chunk" data-reader-process-state="unloaded" data-reader-message-id="${escapeHtml(chunk.messageId)}" data-reader-first-part-id="${escapeHtml(firstPartId)}" data-reader-last-part-id="${escapeHtml(lastPartId)}" data-reader-process-count="${count}" data-reader-process-url="${escapeHtml(url)}">${anchors}<button type="button" class="reader-process-load" data-reader-process-load data-loading-label="${escapeHtml(t("progressive.loading"))}" data-retry-label="${escapeHtml(t("progressive.retry"))}" data-load-error="${escapeHtml(t("progressive.load_failed"))}">${escapeHtml(t("conversation.process_load", { count }))}</button><span class="reader-process-status" data-reader-process-status role="status" aria-live="polite"></span></div>`;
}

export function renderReaderProcessChunk(input: {
  sessionTree?: SessionTree | null;
  ownedReader?: OwnedReaderProjection | null;
  readerRelations?: ReaderRelations | null;
  readerExecutions?: ReaderExecutions | null;
  messageId: string;
  firstPartId: string;
  lastPartId: string;
}): { count: number; html: string } | null {
  const tree = input.ownedReader?.rootTree || input.sessionTree;
  const message = tree?.messages.find((candidate) => candidate.id === input.messageId);
  if (!message) return null;
  const children = new Set((input.ownedReader?.children || []).flatMap((child) => child.parentPartId ? [child.parentPartId] : []));
  const relations = appendReaderExecutionMarkers(renderReaderRelations(input.readerRelations || null), input.readerExecutions || null);
  const chunks = readerProcessChunks(message, relations, children);
  const chunk = chunks.find(({ tools }) => tools[0].part.id === input.firstPartId);
  if (!chunk) return null;
  const lastIndex = chunk.tools.findIndex(({ part }) => part.id === input.lastPartId);
  if (lastIndex < 0) return null;
  // A partially filled chunk can grow while the reader remains open. Honor
  // the recorded endpoint in its existing URL instead of including new tools.
  const tools = chunk.tools.slice(0, lastIndex + 1);
  const parts = chunk.parts.slice(0, chunk.parts.indexOf(tools[tools.length - 1].part) + 1);
  const reasoning = new Set(tools.flatMap((tool) => tool.reasoning));
  const toolParts = new Set(tools.map((tool) => tool.part));
  return {
    count: tools.length,
    html: parts.map((part) => {
      const rendered = reasoning.has(part) ? renderTurnReasoning(renderReasoningPart(part.data, part.id))
        : toolParts.has(part) ? renderPartNode(message.data, part) : "";
      return processPartRelation(relations, part.id, "before") + rendered + processPartRelation(relations, part.id, "after");
    }).join("\n")
  };
}

function renderMessagePartsResult(message: any, depth = 0, provider = "opencode", initialReasoning: any[] = [], view: ConversationViewModel | null = null, placedCardIds: Set<string> | null = null, relations: ReaderRelationMarkup | null = null, ownedChildrenByPart: Map<string, OwnedReaderChildDescriptor[]> | null = null, deferExecution = true): any {
  const renderedParts: string[] = [];
  let executionParts: ConversationItem[] = [];
  const pendingReasoning = [...initialReasoning];
  let visibleCount = 0;
  let hasMilestones = false;
  const chunks = deferExecution ? readerProcessChunks(message, relations, new Set(ownedChildrenByPart?.keys() || [])) : [];
  const chunksByTool = new Map(chunks.flatMap((chunk) => chunk.tools.map(({ part }) => [part.id, chunk] as const)));
  const deferredReasoning = new Set(chunks.flatMap((chunk) => chunk.tools.flatMap(({ reasoning }) => reasoning.map((part) => part.id))));
  const deferredParts = new Set(chunks.flatMap((chunk) => chunk.parts.map((part) => part.id)));
  const flushExecution = () => {
    if (!executionParts.length) return;
    renderedParts.push(renderConversationProcessDisclosure(executionParts, "data-reader-execution"));
    executionParts = [];
  };
  const milestone = (partId: string, side: "before" | "after", messagePosition = false) => {
    const key = readerRelationPositionKey(partId, side);
    const markup = (messagePosition ? relations?.messages : relations?.parts)?.get(key);
    if (!markup) return;
    if (relations?.processPositions.has(key)) {
      if (!messagePosition && deferredParts.has(partId)) return;
      if (pendingReasoning.length) {
        executionParts.push({ kind: "block", role: "assistant", processOnly: true,
          html: renderTurnReasoning(pendingReasoning.join("\n")), itemCount: 0 });
        pendingReasoning.length = 0;
      }
      executionParts.push({ kind: "block", role: "assistant", processOnly: true, html: markup, itemCount: 0 });
      visibleCount += 1;
      return;
    }
    if (messagePosition) return;
    flushExecution();
    attachPendingReasoning(renderedParts, pendingReasoning);
    renderedParts.push(markup);
    visibleCount += 1;
    hasMilestones = true;
  };

  milestone(message.id, "before", true);
  for (const part of message.parts) {
    milestone(part.id, "before");
    if (part.type === "reasoning") {
      const reasoning = deferredReasoning.has(part.id) ? "" : renderReasoningPart(part.data, part.id);
      if (reasoning) {
        pendingReasoning.push(reasoning);
      }
      milestone(part.id, "after");
      continue;
    }

    const chunk = chunksByTool.get(part.id);
    if (chunk) {
      if (chunk.tools[0].part.id === part.id) {
        executionParts.push({
          kind: "block", role: "assistant", processOnly: true,
          html: renderReaderProcessPlaceholder(chunk, provider, message.sessionId, relations),
          itemCount: chunk.tools.length,
          attentionCount: processAttentionCount(chunk.tools.map(({ part }) => part)),
          deferredProcess: true
        });
      }
      visibleCount += 1;
      pendingReasoning.length = 0;
      milestone(part.id, "after");
      continue;
    }

    const reasoningMarkup = pendingReasoning.join("\n");
    const isToolPart = part.type === "tool";
    let rendered: any = renderPartNode(message.data, part, depth, provider, isToolPart ? "" : reasoningMarkup, view, placedCardIds, ownedChildrenByPart?.get(String(part.id)) || []);
    if (rendered && reasoningMarkup && isToolPart) {
      rendered = `${renderTurnReasoning(reasoningMarkup)}\n${rendered}`;
    } else if (rendered && reasoningMarkup && !rendered.includes(reasoningMarkup) && !(part.type === "text" && !part.data?.text)) {
      rendered = attachReasoningToRenderedPart(rendered, reasoningMarkup) || rendered;
    }
    if (rendered) {
      const children = ownedChildrenByPart?.get(String(part.id)) || [];
      const hasChild = part.childSessions.length > 0 || children.length > 0;
      const hasLocalRelation = relations?.parts.has(readerRelationPositionKey(part.id, "before"))
        || relations?.parts.has(readerRelationPositionKey(part.id, "after"));
      if (isToolPart && (!hasChild || hasLocalRelation)) {
        executionParts.push({ kind: "block", role: "assistant", html: rendered, processOnly: true, attentionCount: processAttentionCount([part]) });
      } else {
        flushExecution();
        renderedParts.push(rendered);
      }
      // Child markup can contain hidden event anchors even when the task branch
      // itself is visible. Classify the source part, not its generated HTML.
      if (isVisiblePartNode(part)) {
        visibleCount += 1;
        pendingReasoning.length = 0;
      }
    }
    milestone(part.id, "after");
  }
  milestone(message.id, "after", true);
  flushExecution();

  return {
    markup: renderedParts.filter(Boolean).join("\n"),
    hasVisibleContent: visibleCount > 0,
    hasMilestones,
    pendingReasoning
  };
}

interface ConversationEntry {
  messageId: string;
  role: string;
  markup: string;
  timeCreated: number;
  presentationPhase?: MessagePresentationPhase;
  processOnly: boolean;
  hasMilestones?: boolean;
  attentionCount?: number;
}

/**
 * Render each top-level message into one entry (markup may be empty for
 * messages that produce no visible content). The conversation thread groups
 * these entries by user turn; nested session rendering keeps its existing
 * linear behavior inside subagent branches.
 */
function renderSessionMessageEntries(tree: SessionTree, depth = 0, provider = "opencode", view: ConversationViewModel | null = null, placedCardIds: Set<string> | null = null, relations: ReaderRelationMarkup | null = null, ownedChildrenByPart: Map<string, OwnedReaderChildDescriptor[]> | null = null, deferExecution = true): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  let previousCacheUsage = null;

  for (const sourceMessage of tree.messages) {
    const annotated = annotateCacheWarning(sourceMessage, previousCacheUsage);
    const message = annotated.message;
    if (annotated.usage && messageTurnRole(message.role) === "assistant") {
      previousCacheUsage = annotated.usage;
    }
    let markup = "";
    const result = renderMessagePartsResult(message, depth, provider, [], view, placedCardIds, relations, ownedChildrenByPart, deferExecution);
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
    const beforeKey = readerRelationPositionKey(message.id, "before");
    const afterKey = readerRelationPositionKey(message.id, "after");
    const before = relations?.processPositions.has(beforeKey) ? "" : relations?.messages.get(beforeKey) || "";
    const after = relations?.processPositions.has(afterKey) ? "" : relations?.messages.get(afterKey) || "";
    entries.push({
      messageId: String(message.id || ""),
      role: messageTurnRole(message.role),
      markup: before + markup + after,
      hasMilestones: result.hasMilestones || Boolean(before || after),
      attentionCount: processAttentionCount(message.parts),
      timeCreated: Number(message.timeCreated) || 0,
      presentationPhase: message.data?.presentationPhase,
      processOnly: messageTurnRole(message.role) === "assistant" && !hasOwnMessageBubble(message)
    });
  }

  return entries;
}

function renderRawParts(messageData: any, parts: any[] = [], relations: ReaderRelationMarkup | null = null, messageId = "") {
  const renderedParts: string[] = [];
  const pendingReasoning: string[] = [];
  let executionParts: ConversationItem[] = [];
  const flushExecution = () => {
    if (!executionParts.length) return;
    renderedParts.push(renderConversationProcessDisclosure(executionParts, "data-reader-execution"));
    executionParts = [];
  };
  const milestone = (id: string, side: "before" | "after", messagePosition = false) => {
    const key = readerRelationPositionKey(id, side);
    const markup = (messagePosition ? relations?.messages : relations?.parts)?.get(key);
    if (!markup) return;
    if (relations?.processPositions.has(key)) {
      if (pendingReasoning.length) {
        executionParts.push({ kind: "block", role: "assistant", processOnly: true,
          html: renderTurnReasoning(pendingReasoning.join("\n")), itemCount: 0 });
        pendingReasoning.length = 0;
      }
      executionParts.push({ kind: "block", role: "assistant", processOnly: true, html: markup, itemCount: 0 });
      return;
    }
    if (messagePosition) return;
    flushExecution();
    attachPendingReasoning(renderedParts, pendingReasoning);
    renderedParts.push(markup);
  };

  milestone(messageId, "before", true);
  for (const part of parts) {
    milestone(part.id, "before");
    const partData = safeParse(part.data);
    if (partData?.type === "reasoning") {
      const reasoning = renderReasoningPart(partData, part.id, messageData.contentScope);
      if (reasoning) {
        pendingReasoning.push(reasoning);
      }
      milestone(part.id, "after");
      continue;
    }

    const reasoningMarkup = pendingReasoning.join("\n");
    const renderedPart = renderPart(messageData, partData, part.id, partData?.type === "tool" ? "" : reasoningMarkup);
    const rendered = renderedPart && reasoningMarkup && partData?.type === "tool"
      ? `${renderTurnReasoning(reasoningMarkup)}\n${renderedPart}`
      : renderedPart;
    if (rendered) {
      if (partData.type === "tool" && relations?.processPositions.size) {
        executionParts.push({ kind: "block", role: "assistant", html: rendered, processOnly: true,
          attentionCount: processAttentionCount([{ ...part, type: partData.type, data: partData }]) });
      } else {
        flushExecution();
        renderedParts.push(rendered);
      }
      pendingReasoning.length = 0;
    }
    milestone(part.id, "after");
  }

  milestone(messageId, "after", true);
  flushExecution();
  attachPendingReasoning(renderedParts, pendingReasoning);

  return renderedParts.filter(Boolean).join("\n");
}

function renderRawMessageEntries(messages: any, partsByMessage: any, provider: any, anchorPrefix = "msg", relations: ReaderRelationMarkup | null = null): ConversationEntry[] {
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
    const beforeKey = readerRelationPositionKey(message.id, "before");
    const afterKey = readerRelationPositionKey(message.id, "after");
    const before = relations?.processPositions.has(beforeKey) ? "" : relations?.messages.get(beforeKey) || "";
    const after = relations?.processPositions.has(afterKey) ? "" : relations?.messages.get(afterKey) || "";
    const renderedParts = before + renderRawParts(messageData, parts, relations, message.id) + after;
    const hasMilestones = Boolean(before || after) || parts.some((part: any) => (["before", "after"] as const).some((side) => {
      const key = readerRelationPositionKey(part.id, side);
      return relations?.parts.has(key) && !relations.processPositions.has(key);
    }));
    if (!renderedParts) {
      continue;
    }

    const role = messageTurnRole(messageData.role);
    const previous = entries[entries.length - 1];
    if (String(messageData.role || "").toLowerCase() === "tool" && previous?.role === "assistant") {
      previous.markup += `\n${renderedParts}`;
      previous.hasMilestones ||= hasMilestones;
      continue;
    }

    entries.push({
      messageId: String(message.id || ""),
      role,
      hasMilestones,
      markup: renderMessageGroup({
        id: message.id,
        role,
        data: messageData,
        parts: parts.map((part: any) => ({ id: part.id, data: safeParse(part.data), type: safeParse(part.data)?.type }))
      }, renderedParts, provider, anchorPrefix),
      timeCreated: Number(parsedData.time?.created) || Number(message.time_created) || 0,
      processOnly: role === "assistant" && !parts.some((part: any) => safeParse(part.data)?.type === "text" && Boolean(safeParse(part.data)?.text))
    });
  }

  return entries;
}

export function renderInheritedContextPage(view: InheritedContextView, provider: string, offset = 0) {
  const mapped = buildPartsFromProviderMessages(view.messages, `inherited-${view.sourceSession?.sessionId ?? ""}-`, "inherited-context");
  const end = Math.min(offset + 40, mapped.messages.length);
  const entries = renderRawMessageEntries(mapped.messages.slice(offset, end), mapped.partsByMessage, provider, "inherited-msg");
  const label = end < view.total
    ? t("detail.inherited_context_truncated", { shown: String(end), total: String(view.total) })
    : t("detail.inherited_context_count", { count: String(view.total) });
  return {
    html: entries.map((entry) => entry.markup).filter(Boolean).join("\n"),
    nextOffset: end < mapped.messages.length ? end : null,
    shown: end,
    total: view.total,
    label
  };
}

function renderInheritedContext(view: InheritedContextView | null, provider: string) {
  if (!view || !view.messages.length) {
    return "";
  }
  const page = renderInheritedContextPage(view, provider);
  const sourceHref = conversationSessionHref(view.sourceSession);
  if (!page.html) return "";
  const source = view.sourceSession;
  const sourceLink = source
    ? `<a data-reader-open data-reader-provider="${escapeHtml(source.provider)}" data-reader-session="${escapeHtml(source.sessionId)}" data-reader-anchor="${escapeHtml(anchorId("session", source.sessionId))}" href="${escapeHtml(sourceHref)}">${escapeHtml(t("detail.inherited_context_source"))}</a>`
    : escapeHtml(t("detail.inherited_context_source_unknown"));
  return `<details class="inherited-context-disclosure" data-disclosure data-inherited-context>
    <summary class="inherited-context-summary">${escapeHtml(t("detail.inherited_context_title"))}<span class="inherited-context-count">${escapeHtml(page.label)}</span></summary>
    <div class="inherited-context-body">
      <p class="inherited-context-note">${escapeHtml(t("detail.inherited_context_note"))} ${sourceLink}</p>
      <div class="messages inherited-context-messages" data-inherited-context-messages data-message-count="${page.shown}">
        ${page.html}
      </div>
      ${page.nextOffset === null ? "" : `<button type="button" class="progressive-more" data-inherited-context-more data-next-offset="${page.nextOffset}">${escapeHtml(t("detail.inherited_context_more"))}</button>`}
    </div>
  </details>`;
}

// ── Conversation agent cards, channels, inspector ──

// One stable anchor per card; sanitized through the same helper as spine
// anchors so deep links, ToC jumps, and the browser navigation remain stable.
function agentCardAnchorId(cardId: string) {
  return anchorId("agent-card", cardId);
}

function conversationSessionHref(ref: { provider: string; sessionId: string } | null | undefined) {
  if (!ref?.provider || !ref?.sessionId) {
    return "";
  }
  return `/${encodeURIComponent(ref.provider)}/session/${encodeURIComponent(ref.sessionId)}`;
}

function conversationStateLabel(state: string | null) {
  if (!state) {
    return null;
  }
  const label = t(`conversation.state_${state}`);
  // Unknown presentation keys fall back to the recorded raw state; the status
  // itself is never rewritten into a friendlier word.
  return label === `conversation.state_${state}` ? state : label;
}

function coordinationKindLabel(kind: string) {
  const normalized = kind.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  const label = t(`conversation.channel_${normalized}`);
  return label === `conversation.channel_${normalized}` ? kind : label;
}

function channelTimeLabel(timestamp: number | null) {
  return Number.isFinite(timestamp)
    ? new Date(timestamp!).toISOString().replace("T", " ").replace("Z", " UTC")
    : null;
}

function readerEventSource(item: ConversationChannelItem, provider: string, sessionId: string) {
  const source = item.sourceEventRef;
  const eventId = source?.eventId || item.eventId;
  if (!eventId) return null;
  const owner = source?.session || { provider, sessionId };
  if (!owner.provider || !owner.sessionId) return null;
  return {
    provider: owner.provider,
    sessionId: owner.sessionId,
    eventId,
    href: readerEventHref(owner.provider, owner.sessionId, eventId)
  };
}

function readerCoordinationUrl(provider: string, sessionId: string, card: ConversationAgentCard) {
  const params = new URLSearchParams({ size: "50" });
  if (card.id.startsWith("task:") && card.id.slice(5)) params.set("taskId", card.id.slice(5));
  if (card.id.startsWith("run:") && card.id.slice(4)) params.set("runId", card.id.slice(4));
  if (card.channelNextCursor) params.set("cursor", card.channelNextCursor);
  return `/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}/reader/coordination?${params}`;
}

function renderAgentChannel(channel: ConversationChannelItem[], truncated: boolean, card: ConversationAgentCard, provider: string, sessionId: string, disclosure = true) {
  const itemMarkup = channel.map((item) => renderReaderCoordinationItem(item, provider, sessionId));
  const groups: string[] = [];
  for (let index = 0; index < channel.length;) {
    let end = index + 1;
    if (channel[index].kind === "message") {
      const hasRecordedTime = channel[index].timestamp !== null;
      while (end < channel.length
        && channel[end].kind === "message"
        && (channel[end].timestamp !== null) === hasRecordedTime) end += 1;
    }
    const group = itemMarkup.slice(index, end).join("\n");
    groups.push(end - index > 1
      ? `<li class="reader-channel-group"><details><summary>${escapeHtml(t("detail.reader_channel_messages", { count: String(end - index) }))}</summary><ol>${group}</ol></details></li>`
      : group);
    index = end;
  }
  const items = groups.join("\n");
  const countLabel = channel.length
    ? escapeHtml(t("conversation.agent_channel_items", { count: String(channel.length) }))
    : "";
  const wrapper = disclosure ? "details" : "section";
  const heading = disclosure ? 'summary class="agent-channel-summary" aria-expanded="false"' : 'h3 class="agent-channel-summary"';
  return `<${wrapper} class="agent-channel" data-agent-channel data-reader-coordination-provider="${escapeHtml(provider)}" data-reader-coordination-session="${escapeHtml(sessionId)}"${disclosure ? " data-disclosure" : ""}>
    <${heading}><span>${escapeHtml(t("conversation.agent_channel"))}</span>${countLabel ? `<span class="agent-channel-count">${countLabel}</span>` : ""}</${disclosure ? "summary" : "h3"}>
    ${items ? `<p class="agent-channel-order-note">${escapeHtml(t("detail.reader_channel_order_note"))}</p>` : ""}
    ${items
      ? `<ol class="agent-channel-list" data-reader-coordination-list>${items}</ol>${truncated ? `<button class="agent-channel-more" type="button" data-reader-coordination-more data-reader-coordination-url="${escapeHtml(readerCoordinationUrl(provider, sessionId, card))}">${escapeHtml(t("conversation.agent_channel_load_more"))}</button><span class="agent-channel-load-state" data-reader-coordination-state aria-live="polite"></span>` : ""}`
      : `<p class="agent-channel-empty">${escapeHtml(t("conversation.agent_no_channel"))}</p>`}
  </${wrapper}>`;
}

function renderAgentCard(card: ConversationAgentCard, part: SessionPartNode | null, provider: string, retainedMarkup = "", sessionId = "") {
  const displayName = card.name || card.responsibility || t("conversation.agent_unknown");
  const stateLabel = conversationStateLabel(card.state);
  const meta = [];
  if (card.responsibility && card.responsibility !== card.name) {
    meta.push(`${t("conversation.agent_responsibility")}: ${card.responsibility}`);
  }
  if (card.observationCount > 0 && !card.channelTruncated) {
    meta.push(t("conversation.agent_recorded", { count: String(card.observationCount) }));
  }
  const lastActivity = channelTimeLabel(card.lastActivity);
  if (lastActivity) {
    meta.push(t("conversation.agent_last_activity", { time: lastActivity }));
  }
  const resultArrival = card.channel
    .filter((item) => item.kind === "result-delivery")
    .map((item) => item.timestamp)
    .filter((value): value is number => Boolean(value))
    .sort((left, right) => right - left)[0];
  const resultLabel = resultArrival ? channelTimeLabel(resultArrival)! : null;
  const childSession = card.childSession;
  const cardAnchor = agentCardAnchorId(card.id);
  const actions = childSession
    ? renderChildSessionExportActions(
        childSession,
        provider,
        part && part.childSessions.length > 1 ? ` session of ${part.childSessions.length}` : "",
        card.childSessionAvailable
      )
    : "";
  const cardBody = `
    <div class="agent-card-body">
      ${retainedMarkup}
      ${renderAgentChannel(card.channel, card.channelTruncated, card, provider, sessionId)}
    </div>`;
  const details = `<details class="agent-card" id="${escapeHtml(cardAnchor)}" data-agent-card data-agent-card-id="${escapeHtml(card.id)}" data-agent-name="${escapeHtml(card.name || "")}" data-agent-state="${escapeHtml(card.state || "")}" data-agent-child-session="${escapeHtml(childSession?.sessionId || "")}" data-disclosure>
      <summary class="agent-card-summary" aria-expanded="false">
        <span class="agent-card-kicker">${escapeHtml(t("conversation.agent_kicker"))}</span>
        <span class="agent-card-name">${escapeHtml(displayName)}</span>
        ${stateLabel ? `<span class="agent-card-state agent-card-state-${escapeHtml(card.state || "")}">${escapeHtml(stateLabel)}</span>` : ""}
        ${card.childSessionAvailable === false ? `<span class="agent-card-unavailable" data-agent-child-unavailable>${escapeHtml(t("conversation.agent_child_unavailable"))}</span>` : ""}
        ${meta.length ? `<span class="agent-card-meta">${escapeHtml(meta.join(" · "))}</span>` : ""}
        ${resultLabel ? `<span class="agent-card-result" data-agent-result-arrival="${escapeHtml(resultLabel)}">${escapeHtml(t("conversation.agent_result_arrived", { time: resultLabel }))}</span>` : ""}
        ${actions}
      </summary>
      ${cardBody}
    </details>`;
  if (!part) {
    return details;
  }
  return `<div class="session-part-anchor">
    ${details}
  </div>`;
}

function renderUnplacedAgentSection(cards: ConversationAgentCard[], provider: string, sessionId: string) {
  if (!cards.length) {
    return "";
  }
  const items = cards.map((card) => renderAgentCard(card, null, provider, "", sessionId)).join("\n");
  return `<section class="agent-cards-unplaced" data-agent-cards-unplaced>
    <h2 class="agent-cards-unplaced-title">${escapeHtml(t("conversation.agent_unplaced_title"))}</h2>
    <p class="agent-cards-unplaced-note">${escapeHtml(t("conversation.agent_unplaced_note"))}</p>
    <div class="agent-cards-unplaced-list">${items}</div>
  </section>`;
}

function renderInspectorCoverage(inspector: ConversationInspectorView) {
  const completeness = t(`conversation.inspector_completeness_${inspector.completeness}`);
  const domains = inspector.coverage.map((entry) => (
    `<span class="inspector-coverage-domain" data-inspector-coverage-domain="${escapeHtml(entry.domain)}" data-coverage-state="${escapeHtml(entry.state)}"${entry.details ? ` title="${escapeHtml(entry.details)}"` : ""}>${escapeHtml(t(`conversation.inspector_domain_${entry.domain}`))}: ${escapeHtml(t(`conversation.inspector_coverage_${entry.state}`))}</span>`
  )).join(" ");
  return `<dd data-inspector-coverage data-coverage-completeness="${escapeHtml(inspector.completeness)}">${escapeHtml(completeness)}${inspector.truncated ? ` · ${escapeHtml(t("conversation.inspector_truncated"))}` : ""}${domains ? `<div class="inspector-coverage-domains">${domains}</div>` : ""}</dd>`;
}

function renderInspectorUsage(inspector: ConversationInspectorView) {
  const usage = inspector.usage;
  const pieces = [];
  pieces.push(t("conversation.inspector_usage_requests", { count: String(usage.requestCount) }));
  if (usage.total != null) {
    pieces.push(t("conversation.inspector_usage_total", { count: formatCount(usage.total) }));
  }
  if (usage.input != null) {
    pieces.push(t("conversation.inspector_usage_input", { count: formatCount(usage.input) }));
  }
  if (usage.output != null) {
    pieces.push(t("conversation.inspector_usage_output", { count: formatCount(usage.output) }));
  }
  if (usage.cacheRead != null) {
    pieces.push(t("conversation.inspector_usage_cache_read", { count: formatCount(usage.cacheRead) }));
  }
  if (usage.cacheWrite != null) {
    pieces.push(t("conversation.inspector_usage_cache_write", { count: formatCount(usage.cacheWrite) }));
  }
  if (usage.reasoning != null) {
    pieces.push(t("conversation.inspector_usage_reasoning", { count: formatCount(usage.reasoning) }));
  }
  const summary = pieces.length
    ? pieces.join(" · ")
    : t("conversation.inspector_not_recorded");
  let originMarkup = "";
  if (usage.originsComplete && usage.origins) {
    const rows = (["input", "cacheRead", "cacheWrite"] as const).map((component) => {
      const value = usage.origins![component];
      return `<li class="inspector-origin-row" data-inspector-origin="${component}">
        <span class="inspector-origin-component">${escapeHtml(t(`conversation.inspector_origin_component_${component}`))}</span>
        <span data-origin-direct="${value.direct}">${escapeHtml(t("conversation.inspector_origin_direct", { count: formatCount(value.direct) }))}</span>
        <span data-origin-inherited="${value.inherited}">${escapeHtml(t("conversation.inspector_origin_inherited", { count: formatCount(value.inherited) }))}</span>
        <span data-origin-shared="${value.shared}">${escapeHtml(t("conversation.inspector_origin_shared", { count: formatCount(value.shared) }))}</span>
      </li>`;
    }).join("");
    originMarkup = `<ul class="inspector-origin-list" data-inspector-origins>${rows}</ul>`;
  }
  const incomplete = usage.originsComplete
    ? ""
    : `<p class="inspector-usage-note" data-usage-incomplete>${escapeHtml(t("conversation.inspector_usage_incomplete"))}</p>`;
  return `<section class="inspector-section" data-inspector-section="usage">
    <h2>${escapeHtml(t("conversation.inspector_usage"))}</h2>
    <p class="inspector-usage-summary" data-inspector-usage data-usage-complete="${usage.complete ? "true" : "false"}">${escapeHtml(summary)}</p>
    ${originMarkup}
    ${incomplete}
  </section>`;
}

function renderInspectorRelationships(inspector: ConversationInspectorView) {
  const rows = inspector.relationships.map((relationship) => {
    const href = conversationSessionHref(relationship.otherSession);
    const other = relationship.otherSession;
    const sourceAttributes = other
      ? ` data-reader-source data-reader-provider="${escapeHtml(other.provider)}" data-reader-session="${escapeHtml(other.sessionId)}" data-reader-anchor="${escapeHtml(anchorId("session", other.sessionId))}"`
      : "";
    return `<li class="inspector-relationship" data-relationship-type="${escapeHtml(relationship.type)}" data-relationship-direction="${relationship.outgoing ? "outgoing" : "incoming"}">
      <span class="inspector-relationship-type">${escapeHtml(t(`conversation.relationship_${relationship.type}`))}</span>
      ${href && relationship.otherSession && relationship.otherSessionAvailable !== false
        ? `<a class="inspector-relationship-link"${sourceAttributes} href="${escapeHtml(href)}">${escapeHtml(relationship.otherSession.sessionId)}</a>`
        : `<span class="inspector-relationship-link"${sourceAttributes}${relationship.otherSessionAvailable === false ? " data-relationship-unavailable" : ""}>${escapeHtml(relationship.otherSessionAvailable === false ? t("conversation.inspector_session_unavailable") : t("conversation.inspector_not_recorded"))}</span>`}
    </li>`;
  }).join("\n");
  const overflow = inspector.relationshipCount > inspector.relationships.length
    ? `<a class="inspector-more-link" data-relationships-more href="#tab-work">${escapeHtml(t("conversation.inspector_relationships_more"))}</a>`
    : "";
  return `<section class="inspector-section" data-inspector-section="relationships">
    <h2>${escapeHtml(t("conversation.inspector_relationships"))}</h2>
    ${rows ? `<ul class="inspector-relationship-list" data-inspector-relationships>${rows}</ul>` : `<p class="inspector-empty" data-inspector-relationships-empty>${escapeHtml(t("conversation.inspector_relationships_empty"))}</p>`}
    ${overflow}
  </section>`;
}

function renderInspectorAssetGroup(group: { scope: string; items: any[] }) {
  const items = group.items.map((asset) => {
    const kindLabel = t(`conversation.asset_kind_${asset.kind}`);
    const title = asset.title || (kindLabel === `conversation.asset_kind_${asset.kind}` ? asset.kind : kindLabel);
    const meta = [
      kindLabel === `conversation.asset_kind_${asset.kind}` ? asset.kind : kindLabel,
      asset.origin ? t(`conversation.asset_origin_${asset.origin}`) : "",
      asset.contentAccess ? t(`conversation.asset_content_${asset.contentAccess}`) : ""
    ].filter(Boolean);
    const sources = [];
    for (const source of asset.sourceSessions || []) {
      const href = conversationSessionHref(source);
      if (href) {
        sources.push(`<a class="inspector-asset-source" data-reader-source data-reader-provider="${escapeHtml(source.provider)}" data-reader-session="${escapeHtml(source.sessionId)}" data-reader-anchor="${escapeHtml(anchorId("session", source.sessionId))}" href="${escapeHtml(href)}">${escapeHtml(t("conversation.asset_source"))}</a>`);
      }
    }
    if (asset.producerRunId) {
      sources.push(`<a class="inspector-asset-source" href="#tab-work" data-inspector-evidence-kind="run" data-inspector-evidence-id="${escapeHtml(asset.producerRunId)}">${escapeHtml(t("conversation.asset_run_evidence"))}</a>`);
    }
    for (const runId of asset.consumerRunIds || []) {
      sources.push(`<a class="inspector-asset-source" href="#tab-work" data-inspector-evidence-kind="run" data-inspector-evidence-id="${escapeHtml(runId)}">${escapeHtml(t("conversation.asset_run_evidence"))}</a>`);
    }
    return `<li class="inspector-asset" data-asset-kind="${escapeHtml(asset.kind)}" data-asset-id="${escapeHtml(asset.id)}">
      <strong class="inspector-asset-title">${escapeHtml(title)}</strong>
      ${meta.length ? `<span class="inspector-asset-meta">${escapeHtml(meta.join(" · "))}</span>` : ""}
      ${asset.summary ? `<p class="inspector-asset-summary">${escapeHtml(asset.summary)}</p>` : ""}
      ${asset.provenance ? `<span class="inspector-asset-provenance">${escapeHtml(asset.provenance)}</span>` : ""}
      ${sources.length ? `<span class="inspector-asset-sources">${sources.join(" ")}</span>` : ""}
    </li>`;
  }).join("\n");
  return `<section class="inspector-asset-group" data-asset-scope="${escapeHtml(group.scope)}">
    <h3>${escapeHtml(t(`conversation.asset_scope_${group.scope}`))}</h3>
    <ul class="inspector-asset-list">${items}</ul>
  </section>`;
}

function renderConversationInspector(inspector: ConversationInspectorView | null, provider: string, sessionId: string) {
  if (!inspector) {
    return `<aside class="conversation-inspector" data-conversation-inspector aria-label="${escapeHtml(t("conversation.inspector_title"))}">
      <p class="inspector-empty" data-inspector-unavailable>${escapeHtml(t("conversation.inspector_not_recorded"))}</p>
    </aside>`;
  }
  const assetGroups = inspector.assets.map(renderInspectorAssetGroup).join("\n");
  const providerName = provider || inspector.provider;
  return `<aside class="conversation-inspector" data-conversation-inspector aria-label="${escapeHtml(t("conversation.inspector_title"))}">
    <div class="inspector-header"><h2>${escapeHtml(t("conversation.inspector_title"))}</h2></div>
    <section class="inspector-section" data-inspector-section="session">
      <dl class="inspector-session-dl">
        <div class="inspector-row"><dt>${escapeHtml(t("conversation.inspector_provider"))}</dt><dd>${escapeHtml(providerName || t("conversation.inspector_not_recorded"))}</dd></div>
        <div class="inspector-row"><dt>${escapeHtml(t("conversation.inspector_id"))}</dt><dd><code data-inspector-session-id>${escapeHtml(inspector.sessionId || sessionId)}</code></dd></div>
        <div class="inspector-row"><dt>${escapeHtml(t("conversation.inspector_recorded"))}</dt>${renderInspectorCoverage(inspector)}</div>
      </dl>
    </section>
    ${renderInspectorUsage(inspector)}
    ${renderInspectorRelationships(inspector)}
    ${assetGroups
      ? `<section class="inspector-section" data-inspector-section="assets"><h2>${escapeHtml(t("conversation.inspector_assets"))}</h2>${assetGroups}</section>`
      : `<section class="inspector-section" data-inspector-section="assets"><h2>${escapeHtml(t("conversation.inspector_assets"))}</h2><p class="inspector-empty" data-inspector-assets-empty>${escapeHtml(t("conversation.inspector_assets_empty"))}</p></section>`}
  </aside>`;
}

function conversationCardForPart(view: ConversationViewModel | null, part: SessionPartNode, messageId: string, placedCardIds: Set<string> | null = null, ownedChildren: OwnedReaderChildDescriptor[] = []) {
  if (!view?.cards.length || !part) {
    return null;
  }
  // A card already placed at another spine position must not be re-bound
  // (exactly-once); the part keeps the nested-session fallback instead.
  const available = (card: ConversationAgentCard) => !placedCardIds?.has(card.id);
  const childIds = new Set([
    ...(part.childSessions || []).map((child: any) => String(child.session?.id || "")),
    ...ownedChildren.map((child) => child.sessionId)
  ]);
  for (const card of view.cards) {
    if (available(card) && card.bindings.taskToolCallId && card.bindings.taskToolCallId === part.id) {
      return card;
    }
  }
  for (const card of view.cards) {
    if (available(card) && card.bindings.childSessionId && childIds.has(card.bindings.childSessionId)) {
      return card;
    }
  }
  for (const card of view.cards) {
    if (available(card) && card.bindings.turnId && card.bindings.turnId === messageId) {
      return card;
    }
  }
  return null;
}

// ── Conversation thread (UI v2 P2a) ────────────────────────────────────

function renderCompactionCheckpoint(compaction: any, provider: string, sessionId: string, placement: "anchored" | "timestamp" | "end") {
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
  const facts = [];
  if (compaction.trigger) {
    facts.push(`<dt>${escapeHtml(t("conversation.checkpoint_trigger"))}</dt><dd>${escapeHtml(compaction.trigger === "unknown" ? t("conversation.checkpoint_unknown") : compaction.trigger)}</dd>`);
  }
  if (compaction.strategy) {
    facts.push(`<dt>${escapeHtml(t("conversation.checkpoint_strategy"))}</dt><dd>${escapeHtml(compaction.strategy === "unknown" ? t("conversation.checkpoint_unknown") : compaction.strategy)}</dd>`);
  }
  if (compaction.continuationSessionId) {
    const encoded = encodeURIComponent(compaction.continuationSessionId);
    facts.push(`<dt>${escapeHtml(t("conversation.checkpoint_continuation"))}</dt><dd><a data-reader-open data-reader-provider="${escapeHtml(provider)}" data-reader-session="${escapeHtml(compaction.continuationSessionId)}" href="/${escapeHtml(provider)}/session/${encoded}">${escapeHtml(compaction.continuationSessionId)}</a></dd>`);
  }
  const result = `<div class="compaction-checkpoint-result"><details class="context-result-disclosure" data-context-result data-context-result-provider="${escapeHtml(provider)}" data-context-result-session="${escapeHtml(sessionId)}" data-context-result-checkpoint="${escapeHtml(compaction.id)}"><summary>${escapeHtml(t("conversation.context_result_disclosure"))}</summary><div class="context-result-panel" data-context-result-panel><span class="context-result-state">${escapeHtml(t("conversation.context_result_load_prompt"))}</span></div></details></div>`;
  const evidence = facts.length || meta
    ? `<details class="compaction-checkpoint-details"><summary>${escapeHtml(t("conversation.checkpoint_details"))}</summary>${meta ? `<p class="compaction-checkpoint-meta">${escapeHtml(meta)}</p>` : ""}${facts.length ? `<dl class="compaction-checkpoint-facts">${facts.join("")}</dl>` : ""}</details>`
    : "";
  return `<section id="${escapeHtml(anchorId("checkpoint", compaction.id))}" class="compaction-checkpoint" data-compaction-checkpoint="${escapeHtml(compaction.id)}" data-compaction-placement="${placement}" data-compaction-fidelity="${escapeHtml(compaction.fidelity || "")}">
    <span class="compaction-checkpoint-kicker">${escapeHtml(t("conversation.checkpoint_kicker"))}</span>
    ${result}
    ${evidence}
  </section>`;
}

function renderConversationProcessDisclosure(items: ConversationItem[], attribute = "data-conversation-process") {
  const count = String(Math.max(1, items.reduce((sum, item) => sum + (item.itemCount ?? 1), 0)));
  const attentionCount = items.reduce((sum, item) => sum + (item.attentionCount || 0), 0);
  return `<details class="conversation-process-disclosure" ${attribute} ${attribute}-count="${escapeHtml(count)}"${items.some((item) => item.deferredProcess) ? " data-reader-process-group" : ""}>
    <summary class="conversation-process-summary"><span class="conversation-process-kicker">${escapeHtml(t("conversation.process_kicker"))}</span><span class="conversation-process-count">${escapeHtml(t("conversation.process_items", { count }))}</span>${attentionCount ? `<span class="conversation-process-attention">${escapeHtml(t("conversation.process_attention", { count: String(attentionCount) }))}</span>` : ""}</summary>
    <div class="conversation-process-body">${items.map((item) => item.html).join("\n")}</div>
  </details>`;
}

interface ConversationItem {
  kind: "block" | "checkpoint";
  role?: string;
  html: string;
  presentationPhase?: MessagePresentationPhase;
  processOnly?: boolean;
  hasMilestones?: boolean;
  itemCount?: number;
  attentionCount?: number;
  deferredProcess?: boolean;
}

function isRecordedFinalItem(item: ConversationItem) {
  return item.kind === "block"
    && item.role === "assistant"
    && item.processOnly !== true
    && item.presentationPhase === "final";
}

function renderConversationSegmentItems(items: ConversationItem[]) {
  const rendered: string[] = [];
  let processItems: ConversationItem[] = [];
  const hasLaterFinal = new Array<boolean>(items.length).fill(false);
  let foundFinal = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    hasLaterFinal[index] = foundFinal;
    if (isRecordedFinalItem(items[index])) {
      foundFinal = true;
    }
  }
  const flushProcessItems = () => {
    if (!processItems.length) {
      return;
    }
    rendered.push(renderConversationProcessDisclosure(processItems));
    processItems = [];
  };

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const foldable = hasLaterFinal[index]
      && item.kind === "block"
      && item.role === "assistant"
      && !item.hasMilestones
      && (item.processOnly === true || item.presentationPhase === "commentary");
    if (foldable) {
      processItems.push(item);
      continue;
    }
    flushProcessItems();
    rendered.push(item.html);
  }
  flushProcessItems();
  return rendered.join("\n");
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
function renderConversationThread(entries: ConversationEntry[], compactions: any[], provider: string, sessionId: string, view: ConversationViewModel | null = null) {
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
  const items: ConversationItem[] = [];
  const pushCheckpoints = (position: number) => {
    for (const placed of byEntryIndex.get(position) || []) {
      items.push({ kind: "checkpoint", html: renderCompactionCheckpoint(placed.compaction, provider, sessionId, placed.placement) });
    }
  };
  pushCheckpoints(-1);
  entries.forEach((entry, index) => {
    if (entry.markup) {
      items.push({
        kind: "block",
        role: entry.role,
        html: entry.markup,
        presentationPhase: entry.presentationPhase,
        processOnly: entry.processOnly,
        hasMilestones: entry.hasMilestones,
        attentionCount: entry.attentionCount
      });
    }
    if (byEntryIndex.has(index)) {
      pushCheckpoints(index);
    }
  });

  const segments: Array<{ userTurn: boolean; userTurnIndex: number; items: ConversationItem[] }> = [];
  let current = null as { userTurn: boolean; userTurnIndex: number; items: ConversationItem[] } | null;
  let userTurnIndex = 0;
  for (const item of items) {
    if (item.kind === "block" && item.role === "user") {
      userTurnIndex += 1;
      current = { userTurn: true, userTurnIndex, items: [] };
      segments.push(current);
    } else if (!current) {
      current = { userTurn: false, userTurnIndex: 0, items: [] };
      segments.push(current);
    }
    current.items.push(item);
  }

  const thread = segments.map((segment) => {
    const header = segment.userTurn
      ? `<header class="thread-turn-header"><span class="thread-turn-kicker">${escapeHtml(t("conversation.thread_turn"))} ${segment.userTurnIndex}</span></header>`
      : "";
    const turnClass = segment.userTurn ? " thread-turn-user" : " thread-turn-prelude";
    return `<section class="thread-turn${turnClass}">${header}<div class="thread-turn-content">${renderConversationSegmentItems(segment.items)}</div></section>`;
  }).join("\n");

  const trailing = byEntryIndex.get(entries.length) || [];
  return trailing.length
    ? `${thread}${thread ? "\n" : ""}${trailing.map((placed) => renderCompactionCheckpoint(placed.compaction, provider, sessionId, placed.placement)).join("\n")}`
    : thread;
}

function renderConversationPanel(entries: ConversationEntry[], compactions: any[], provider: string, sessionId: string, detachedMarkup = "", normalizedMessageCount = entries.length, view: ConversationViewModel | null = null, placedCardIds: Set<string> | null = null, relations: ReaderRelationMarkup | null = null) {
  const threadMarkup = renderConversationThread(entries, compactions, provider, sessionId, view);
  // P2b truthful fallback: view-model cards without a real transcript/part
  // binding (e.g. run/task records whose ids name no tree part) render
  // exactly once in an explicitly unplaced section, never at an invented
  // causal position. Cards placed on the spine are excluded here.
  const unplacedCards = view
    ? view.cards.filter((card) => !placedCardIds?.has(card.id))
    : [];
  const unplacedMarkup = renderUnplacedAgentSection(unplacedCards, provider, sessionId);
  if (!threadMarkup && !detachedMarkup && !unplacedMarkup) {
    return `<div class="conversation-layout" data-conversation-layout>
      <section id="session-messages" class="messages"><p class="empty-state">${escapeHtml(t("detail.no_messages"))}</p></section>
    </div>`;
  }

  return `<div class="conversation-layout" data-conversation-layout>
      <div class="conversation-thread-col">
        <section id="session-messages" class="messages conversation-thread" data-conversation-default="thread" data-conversation-message-count="${normalizedMessageCount}"${relations ? " data-reader-relations" : ""}>
          ${relations?.toolbar || ""}
          ${threadMarkup}
          ${detachedMarkup}
          ${unplacedMarkup}
        </section>
      </div>
    </div>`;
}

function readerChildTargets(tree: SessionTree | null, provider: string, ownedReader: OwnedReaderProjection | null) {
  const children = new Map<string, ReaderChildTarget>();
  if (tree) {
    for (const child of [
      ...tree.messages.flatMap((message) => message.parts.flatMap((part) => part.childSessions)),
      ...tree.detachedChildren
    ]) {
      children.set(conversationSessionHref({ provider: child.session.provider || provider, sessionId: child.session.id }), child);
    }
  }
  for (const child of ownedReader?.children || []) {
    children.set(conversationSessionHref({ provider: child.provider, sessionId: child.sessionId }), child);
  }
  return children;
}

function readerTaskDirectoryUrl(provider: string, sessionId: string, query = "", cursor: string | null = null, size = 50) {
  const params = new URLSearchParams({ size: String(size) });
  if (query) params.set("q", query);
  if (cursor) params.set("cursor", cursor);
  return `/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}/reader/tasks?${params}`;
}

function renderReaderTaskNode(group: ConversationTaskGroup, provider: string, sessionId: string, relations: ReaderRelations | null = null) {
  const runs = group.cards;
  const first = runs[0];
  const child = group.childSession;
  const lane = relations?.lanes.find((candidate) => candidate.id === group.laneId);
  const name = first.responsibility || first.name || lane?.name || child?.sessionId || t("conversation.agent_unknown");
  const states = [...new Set(runs.map((run) => conversationStateLabel(run.state)).filter(Boolean))];
  const responsibility = runs.find((run) => run.responsibility && run.responsibility !== name)?.responsibility;
  const detailId = anchorId("reader-task", group.key);
  const detailUrl = `/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}/reader/task?key=${encodeURIComponent(group.key)}`;
  return `<button type="button" class="reader-task-node" data-reader-task-select="${escapeHtml(group.key)}" data-reader-task-lane="${escapeHtml(group.laneId)}" data-reader-task-detail-url="${escapeHtml(detailUrl)}" aria-controls="${escapeHtml(detailId)}" aria-pressed="false">
    ${uiIcon("network")}<span class="reader-task-node-copy"><strong>${escapeHtml(name)}</strong>
    <span class="reader-task-node-state">${escapeHtml(states.join(" · "))}</span>
    ${responsibility ? `<span class="reader-task-node-purpose">${escapeHtml(responsibility)}</span>` : ""}</span>
  </button>`;
}

export function renderReaderTaskDetail(
  group: ConversationTaskGroup,
  provider: string,
  sessionId: string,
  options: {
    tree?: SessionTree | null;
    ownedReader?: OwnedReaderProjection | null;
    readerRelations?: ReaderRelations | null;
  } = {}
) {
    const { tree = null, ownedReader = null, readerRelations = null } = options;
    const children = readerChildTargets(tree, provider, ownedReader);
    const runs = group.cards;
    const first = runs[0];
    const child = group.childSession;
    const href = child ? conversationSessionHref(child) : "";
    const available = child && runs.some((run) => run.childSessionAvailable !== false);
    const childTarget = available ? children.get(href) : null;
    const name = first.responsibility || first.name || (childTarget ? (isOwnedReaderChild(childTarget) ? childTarget.title : childTarget.session.title) : null) || t("conversation.agent_unknown");
    const states = [...new Set(runs.map((run) => conversationStateLabel(run.state)).filter(Boolean))];
    const lane = readerRelations?.lanes.find((candidate) => child
      ? candidate.childSession?.provider === child.provider && candidate.childSession.sessionId === child.sessionId
      : candidate.id === group.laneId);
    const taskKey = group.key;
    const detailId = anchorId("reader-task", group.key);
    const events = runs.flatMap((run) => run.channel);
    const dispatch = events.find((item) => item.kind === "spawn" || item.kind === "delegate");
    const dispatchSource = dispatch && readerEventSource(dispatch, provider, sessionId);
    return `<details id="${escapeHtml(detailId)}" class="reader-branch" data-reader-branch data-reader-branch-key="${escapeHtml(taskKey)}" data-reader-task-lane="${escapeHtml(lane?.id || group.laneId)}"${child ? ` data-reader-branch-provider="${escapeHtml(child.provider)}" data-reader-branch-session="${escapeHtml(child.sessionId)}"` : ""}>
      <summary><span class="reader-branch-name">${escapeHtml(name)}</span>${states.length ? `<span class="reader-branch-state" title="${escapeHtml(t("detail.reader_branch_state"))}">${escapeHtml(states.join(" · "))}</span>` : ""}</summary>
      <div class="reader-branch-body">
        ${child && !available ? `<p class="reader-relationship-empty">${escapeHtml(t("conversation.agent_child_unavailable"))}</p>` : ""}
        ${available ? `<a class="reader-child-history-link" data-reader-open data-reader-provider="${escapeHtml(child!.provider)}" data-reader-session="${escapeHtml(child!.sessionId)}" href="${escapeHtml(href)}">${escapeHtml(t("detail.reader_child_history"))}</a>${childTarget && isOwnedReaderChild(childTarget) && childTarget.link === "inferred" ? `<small>${escapeHtml(t("detail.related_history"))}</small>` : ""}` : ""}
        <div data-reader-task-runs>${renderReaderTaskRuns(group, provider, sessionId)}</div>
        ${available ? `<details class="reader-task-overview"><summary>${escapeHtml(t("detail.reader_task_overview"))}</summary><section class="reader-task-preview" data-reader-task-preview data-reader-provider="${escapeHtml(child!.provider)}" data-reader-session="${escapeHtml(child!.sessionId)}" data-loading-label="${escapeHtml(t("detail.reader_preview_loading"))}" data-error-label="${escapeHtml(t("detail.reader_preview_error"))}"><p data-reader-preview-status role="status">${escapeHtml(t("detail.reader_preview_loading"))}</p><div data-reader-preview-content></div><button type="button" data-reader-preview-retry hidden>${escapeHtml(t("detail.reader_preview_retry"))}</button></section>${dispatchSource ? `<div class="reader-task-dispatch-source">${renderReaderEventSourceLink(dispatchSource.provider, dispatchSource.sessionId, dispatchSource.eventId, t("detail.reader_dispatch_source"))}</div>` : ""}</details>` : ""}
      </div>
    </details>`;
}

export function renderReaderTaskRuns(group: ConversationTaskGroup, provider: string, sessionId: string) {
  const multipleRuns = group.runCount > 1;
  const runMarkup = group.cards.map((run) => `<div class="reader-branch-run" data-reader-branch-run="${escapeHtml(run.bindings.runId || run.id.replace(/^run:/, ""))}">
      ${multipleRuns && run.name ? `<strong>${escapeHtml(run.name)}</strong>` : ""}
      ${run.responsibility && run.responsibility !== run.name ? `<p class="reader-branch-purpose">${escapeHtml(run.responsibility)}</p>` : ""}
      ${multipleRuns && conversationStateLabel(run.state) ? `<p class="reader-branch-state">${escapeHtml(t("detail.reader_branch_state"))}: ${escapeHtml(conversationStateLabel(run.state)!)}</p>` : ""}
      ${renderAgentChannel(run.channel, run.channelTruncated, run, provider, sessionId, false)}
    </div>`).join("");
  const params = new URLSearchParams({ key: group.key, runsSize: String(group.runsPageSize) });
  if (group.runsNextCursor) params.set("runsCursor", group.runsNextCursor);
  const moreUrl = group.runsNextCursor
    ? `/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}/reader/task?${params}`
    : "";
  return `<div data-reader-task-runs-page data-reader-task-runs-offset="${group.runsOffset}">${runMarkup}</div>${moreUrl ? `<button type="button" class="agent-channel-more" data-reader-task-runs-more data-reader-task-runs-url="${escapeHtml(moreUrl)}">${escapeHtml(t("progressive.show_more"))}</button><span data-reader-task-runs-status role="status"></span>` : ""}`;
}

export function renderReaderTaskDirectoryPage(page: ConversationTaskDirectoryPage, readerRelations: ReaderRelations | null = null) {
  const nodes = page.items.map((group) => renderReaderTaskNode(group, page.provider, page.sessionId, readerRelations)).join("");
  const moreUrl = page.nextCursor
    ? readerTaskDirectoryUrl(page.provider, page.sessionId, page.query, page.nextCursor, page.size)
    : "";
  return `<div data-reader-task-directory-page data-reader-task-directory-offset="${page.offset}"><div class="reader-task-nodes">${nodes || `<p data-reader-task-directory-empty>${escapeHtml(t("detail.reader_tasks_empty"))}</p>`}</div>${moreUrl ? `<button type="button" class="agent-channel-more" data-reader-task-directory-more data-reader-task-directory-url="${escapeHtml(moreUrl)}">${escapeHtml(t("progressive.show_more"))}</button>` : ""}</div>`;
}

function renderReaderBranches(initialPage: ConversationTaskDirectoryPage, tree: SessionTree | null, provider: string, sessionId: string, ownedReader: OwnedReaderProjection | null, readerRelations: ReaderRelations | null) {
  const groups = initialPage.items;
  const directoryPage = renderReaderTaskDirectoryPage(initialPage, readerRelations);
  const taskDetails = groups.map((group) => renderReaderTaskDetail(group, provider, sessionId, { tree, ownedReader, readerRelations })).join("");
  const graph = renderReaderTaskGraph(groups, provider, sessionId);
  return `<div data-reader-task-graph-host>${graph}</div><div data-reader-task-status role="status"></div><details class="reader-task-map" data-reader-task-map${graph ? "" : " open"}><summary>${escapeHtml(t("detail.activity_all_tasks", { count: String(initialPage.total) }))}</summary><section data-reader-task-directory data-reader-task-directory-url="${escapeHtml(readerTaskDirectoryUrl(provider, sessionId))}"><form data-reader-task-directory-search><input type="search" data-reader-task-directory-query aria-label="${escapeHtml(t("detail.reader_tasks_search"))}" placeholder="${escapeHtml(t("detail.reader_tasks_search"))}"><button type="submit">${escapeHtml(t("library.search_action"))}</button><span data-reader-task-directory-status role="status"></span></form><div data-reader-task-directory-pages>${directoryPage}</div></section></details><div class="reader-branches" data-reader-task-details>${taskDetails}</div>`;
}

function renderReaderRelationshipRail(view: ConversationViewModel | null, provider: string, sessionId: string, tree: SessionTree | null, ownedReader: OwnedReaderProjection | null = null, readerRelations: ReaderRelations | null = null, readerTeams: ReaderTeamDirectoryPage | null = null) {
  const cards = view?.cards || [];
  const observations = cards.flatMap((card) => (card.channel || []).map((item) => ({ card, item })));
  const turnBoundaries = view?.turnBoundaries || [];
  const sourceMarkup = (item: ConversationChannelItem) => {
    const source = readerEventSource(item, provider, sessionId);
    if (!source) return `<span class="reader-observation-source reader-observation-source-missing">${escapeHtml(t("detail.reader_observation_no_source"))}</span>`;
    return renderReaderEventSourceLink(source.provider, source.sessionId, source.eventId);
  };
  const observationLabel = (card: ConversationAgentCard, item: ConversationChannelItem) => {
    const agent = card.name || card.responsibility || t("conversation.agent_unknown");
    return `${coordinationKindLabel(item.kind)} · ${agent}`;
  };
  const turnLabel = (boundary: ConversationTurnBoundary) => {
    const phase = boundary.normalizedKind.slice("run.".length);
    return `${t("detail.reader_main_agent_turn", { count: String(boundary.displayNumber) })} · ${t(`detail.reader_turn_${phase}`)}`;
  };
  const detailSequence = observations.map(({ card, item }) => `<li class="reader-observation-sequence-item" data-reader-observation-id="${escapeHtml(item.id)}"><span class="reader-observation-sequence-label">${escapeHtml(observationLabel(card, item))}</span>${channelTimeLabel(item.timestamp) ? `<time>${escapeHtml(channelTimeLabel(item.timestamp)!)}</time>` : `<small>${escapeHtml(t("detail.reader_time_unknown"))}</small>`}${sourceMarkup(item)}</li>`).join("");
  const turnSequence = turnBoundaries.map((boundary) => `<li class="reader-observation-sequence-item reader-main-turn-sequence-item" data-reader-turn-boundary data-reader-turn-number="${boundary.displayNumber}"><span class="reader-observation-sequence-label">${escapeHtml(turnLabel(boundary))}</span>${channelTimeLabel(boundary.timestamp) ? `<time>${escapeHtml(channelTimeLabel(boundary.timestamp)!)}</time>` : `<small>${escapeHtml(t("detail.reader_time_unknown"))}</small>`}${renderReaderEventSourceLink(provider, sessionId, boundary.eventId)}</li>`).join("");
  const initialDirectory = view?.taskDirectory || {
    ok: true as const, provider, sessionId, query: "", size: 50, offset: 0,
    total: cards.length, items: groupConversationCards(cards, provider, sessionId), nextCursor: null
  };
  const branches = cards.length ? renderReaderBranches(initialDirectory, tree, provider, sessionId, ownedReader, readerRelations) : "";
  const relationshipRecords = (view?.inspector?.relationships || []).filter((relationship) => relationship.otherSession);
  const relationships = relationshipRecords.map((relationship) => {
    const target = relationship.otherSession;
    if (!target) return "";
    const href = conversationSessionHref(target);
    const targetAnchor = anchorId("session", target.sessionId);
    const link = href && relationship.otherSessionAvailable !== false
      ? `<a href="${escapeHtml(href)}" data-reader-source data-reader-provider="${escapeHtml(target.provider)}" data-reader-session="${escapeHtml(target.sessionId)}" data-reader-anchor="${escapeHtml(targetAnchor)}">${escapeHtml(target.sessionId)}</a>`
      : `<span data-reader-source data-reader-provider="${escapeHtml(target.provider)}" data-reader-session="${escapeHtml(target.sessionId)}" data-reader-anchor="${escapeHtml(targetAnchor)}">${escapeHtml(relationship.otherSessionAvailable === false ? t("conversation.inspector_session_unavailable") : t("conversation.inspector_not_recorded"))}</span>`;
    return `<li data-reader-relationship data-reader-time-known="${relationship.timestamp !== null ? "true" : "false"}"><span>${escapeHtml(t(`conversation.relationship_${relationship.type}`))}</span> ${link}${relationship.timestamp !== null ? `<time>${escapeHtml(formatTime(relationship.timestamp))}</time>` : `<small>${escapeHtml(t("detail.reader_time_unknown"))}</small>`}</li>`;
  }).join("\n");
  const hasFacts = cards.length > 0 || relationshipRecords.length > 0 || Boolean(readerTeams?.total);
  if (!hasFacts) return "";
  const recorded = observations.length + turnBoundaries.length;
  const evidenceMarkup = recorded
    ? `<details class="reader-observations-expanded" data-reader-observations-expanded><summary>${escapeHtml(t("detail.reader_timeline_expand"))}</summary><ol class="reader-observation-sequence" data-reader-observation-sequence>${turnSequence}${detailSequence}</ol></details>`
    : "";
  const overview = `<aside class="reader-collaboration" data-reader-collaboration data-reader-task-error-label="${escapeHtml(t("progressive.load_failed"))}" data-reader-task-retry-label="${escapeHtml(t("progressive.retry"))}" aria-label="${escapeHtml(t("detail.reader_collaboration"))}">
    <div class="reader-collaboration-heading"><h2>${escapeHtml(t("detail.reader_collaboration_title"))}</h2><button type="button" class="reader-collaboration-close" data-reader-collaboration-close aria-label="${escapeHtml(t("detail.reader_collaboration_close"))}">${uiIcon("x")}</button></div>
    ${readerTeams ? renderReaderTeams(readerTeams) : ""}
    ${branches}
    <details class="reader-activity-disclosure" data-reader-activity-disclosure><summary>${escapeHtml(t("detail.activity_disclosure"))}</summary><section class="reader-activity-host" data-reader-activity-host="/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}/reader/activity" data-loading-label="${escapeHtml(t("detail.activity_loading"))}" data-error-label="${escapeHtml(t("detail.activity_error"))}" aria-label="${escapeHtml(t("detail.activity_title"))}"><p data-reader-activity-status role="status">${escapeHtml(t("detail.activity_loading"))}</p><button type="button" data-reader-activity-retry hidden>${escapeHtml(t("progressive.retry"))}</button><div data-reader-activity-view></div></section></details>
    <details class="reader-inspector-disclosure" data-reader-inspector>
      <summary>${escapeHtml(t("conversation.inspector_title"))}</summary>
      ${evidenceMarkup}
      ${relationships ? `<ul class="reader-relationship-list">${relationships}</ul>` : ""}
      ${renderConversationInspector(view?.inspector ?? null, provider, sessionId)}
    </details>
  </aside>`;
  return `<details id="${escapeHtml(anchorId("collaboration", sessionId))}" class="reader-collaboration-overview" data-reader-collaboration-overview>
    <summary class="reader-collaboration-overview-summary">${uiIcon("chevron-down")}<span>${escapeHtml(t("detail.reader_collaboration_title"))}</span><small>${escapeHtml(t("detail.reader_collaboration_note"))}</small></summary>
    ${overview}
  </details>`;
}

/** Render the reusable, page-shell-free reader fragment for one canonical session. */
export function renderSessionReaderPane({
  session,
  sessionTree = null,
  ownedReader = null,
  messages = [],
  partsByMessage = new Map(),
  provider = "opencode",
  conversationCompactions = [],
  conversationView = null,
  readerTeams = null,
  readerRelations = null,
  readerExecutions = null,
  inheritedContext = null,
  contextArtifacts = [],
  contextArtifactSourceState = null,
  canReadContextArtifacts = false,
  canReadContextArtifactEvidence = false,
  deferExecution = true
}: { session: any; sessionTree?: SessionTree | null; ownedReader?: OwnedReaderProjection | null; messages?: any[]; partsByMessage?: Map<any, any>; provider?: string; conversationCompactions?: ConversationCompaction[]; conversationView?: ConversationViewModel | null; readerTeams?: ReaderTeamDirectoryPage | null; readerRelations?: ReaderRelations | null; readerExecutions?: ReaderExecutions | null; inheritedContext?: InheritedContextView | null; contextArtifacts?: ContextArtifact[]; contextArtifactSourceState?: ContextArtifactSourceState | null; canReadContextArtifacts?: boolean; canReadContextArtifactEvidence?: boolean; deferExecution?: boolean }) {
  const title = session.title || session.slug || session.id;
  const placedCardIds = new Set<string>();
  const relationMarkup = appendReaderExecutionMarkers(renderReaderRelations(readerRelations), readerExecutions);
  const effectiveTree = ownedReader?.rootTree || sessionTree;
  const ownedChildrenByPart = new Map<string, OwnedReaderChildDescriptor[]>();
  for (const child of ownedReader?.children || []) {
    if (child.parentPartId) {
      const entries = ownedChildrenByPart.get(child.parentPartId) || [];
      entries.push(child);
      ownedChildrenByPart.set(child.parentPartId, entries);
    }
  }
  const conversationEntries = effectiveTree
    ? renderSessionMessageEntries(effectiveTree, 0, provider, conversationView, placedCardIds, relationMarkup, ownedChildrenByPart, deferExecution)
    : renderRawMessageEntries(messages, partsByMessage, provider, "msg", relationMarkup);
  const renderedEntryCount = conversationEntries.filter((entry) => entry.markup).length;
  const detachedMarkup = effectiveTree
    ? [
      ...(effectiveTree.detachedChildren || []).map((child: SessionTree) => renderChildReaderLink(child, provider, true)),
      ...(ownedReader?.children || []).filter((child) => child.detached).map((child) => renderChildReaderLink(child, provider, true))
    ]
      .filter(Boolean)
      .join("\n")
    : "";
  const conversationMarkup = renderConversationPanel(conversationEntries, conversationCompactions, provider, String(session.id), detachedMarkup, renderedEntryCount, conversationView, placedCardIds, relationMarkup);
  const inheritedContextMarkup = renderInheritedContext(inheritedContext, provider);
  const sessionAnchor = anchorId("session", session.id);
  const artifactMarkup = renderReaderArtifacts({ artifacts: contextArtifacts, sourceState: contextArtifactSourceState, canRead: canReadContextArtifacts, canReadEvidence: canReadContextArtifactEvidence, provider, sessionId: String(session.id), sessionAnchor });
  return `<div id="${escapeHtml(sessionAnchor)}" class="reader-pane" data-reader-pane data-reader-provider="${escapeHtml(provider)}" data-reader-session="${escapeHtml(session.id)}" data-reader-title="${escapeHtml(title)}">
    <div class="reader-pane-grid">
      <details class="reader-toc-disclosure" data-reader-toc>
        <summary>${uiIcon("chevron-down")}<span>${escapeHtml(t("detail.reader_toc_toggle"))}</span></summary>
        ${renderToc(effectiveTree, provider, ownedReader)}
      </details>
      <div class="reader-pane-main" data-reader-transcript>
        ${artifactMarkup}
        ${conversationMarkup}
        ${inheritedContextMarkup}
        ${renderReaderRelationshipRail(conversationView, provider, String(session.id), effectiveTree, ownedReader, readerRelations, readerTeams)}
      </div>
    </div>
  </div>`;
}

function renderTranscriptSearch(provider: string, sessionId: string, title: string) {
  const scopeValue = `${encodeURIComponent(provider)}::${encodeURIComponent(sessionId)}`;
  return `<details class="session-search" data-session-search>
    <summary class="action-btn session-search-toggle" data-session-search-toggle>${uiIcon("search")}<span>${escapeHtml(t("detail.search_messages"))}</span></summary>
    <div class="session-search-panel">
      <label class="session-search-scope" for="session-transcript-search-scope">
        <span>${escapeHtml(t("detail.search_scope"))}</span>
        <select id="session-transcript-search-scope" data-session-search-scope aria-label="${escapeHtml(t("detail.search_scope"))}">
          <option data-reader-scope-root="true" data-reader-provider="${escapeHtml(provider)}" data-reader-session="${escapeHtml(sessionId)}" value="${escapeHtml(scopeValue)}">${escapeHtml(t("detail.search_scope_root", { title }))} · ${escapeHtml(provider)}/${escapeHtml(sessionId)}</option>
        </select>
      </label>
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
  lazySessionMetrics = null,
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
  runtimeEvents = "",
  navigationContext = null,
  conversationCompactions = [],
  conversationView = null,
  inheritedContext = null,
  readerPane = ""
}: { session: any; sessionTree?: any; sessionMetrics?: any; lazySessionMetrics?: { provider: string; sessionId: string } | null; messages?: any[]; partsByMessage?: Map<any, any>; todos?: any[]; recentSessions?: any[]; meta?: any; provider?: string; providers?: any[]; manageable?: boolean; resumeCommand?: any; terminalLaunchAllowed?: boolean; runtimeWorkbench?: string; runtimeEvents?: string; navigationContext?: SessionNavigationContext | null; conversationCompactions?: ConversationCompaction[]; conversationView?: ConversationViewModel | null; inheritedContext?: InheritedContextView | null; readerPane?: string }) {
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
  const sourceLabel = navigationContext?.section === "stats"
    ? t("nav.stats")
    : navigationContext?.section === "detail"
      ? t("runtime.title")
      : t("nav.sessions");
  const backHref = navigationContext?.href || "/sessions";
  const currentRecentIndex = recentSessions.findIndex((item: any) => String(item.id) === String(session.id));
  const previousSession = currentRecentIndex > 0 ? recentSessions[currentRecentIndex - 1] : null;
  const nextSession = currentRecentIndex >= 0 && currentRecentIndex < recentSessions.length - 1 ? recentSessions[currentRecentIndex + 1] : null;
  const sessionHref = (item: any) => `/${encodeURIComponent(item.provider || provider)}/session/${encodeURIComponent(item.id)}`;
  const breadcrumb = navigationContext ? `<nav class="session-breadcrumb" aria-label="${escapeHtml(t("detail.breadcrumb_label"))}">
    <a href="${escapeHtml(navigationContext.href)}">← ${escapeHtml(navigationContext.section === "detail" ? t("detail.back_to_workbench") : t("detail.back_to_source", { source: sourceLabel }))}</a>
    <span>${escapeHtml(providerName)}</span>
    ${navigationContext.day ? `<span>${escapeHtml(navigationContext.day)}</span>` : ""}
  </nav>` : "";

  const rootCollaborationId = anchorId("collaboration", session.id);
  const hasCollaboration = Boolean(
    conversationView?.cards?.length
      || conversationView?.inspector?.relationships?.some((relationship) => relationship.otherSession)
      || readerPane.includes("data-reader-collaboration-overview")
  );
  const collaborationToggle = hasCollaboration
    ? `<button type="button" class="reader-header-collaboration" data-reader-collaboration-toggle aria-controls="${escapeHtml(rootCollaborationId)}" aria-expanded="false">${uiIcon("network")}<span>${escapeHtml(t("detail.reader_collaboration_title"))}</span></button>`
    : "";

  // Action parity: visible actions + "More" dropdown
  const visibleStarAction = manageable ? `
        <button class="star-btn action-btn ${starred ? "starred" : ""}" type="button" data-star-format="icon" data-id="${escapeHtml(session.id)}" title="${starred ? t("action.starred") : t("action.star")}" aria-label="${starred ? t("action.starred") : t("action.star")}">
          ${uiIcon("star")}
        </button>
  ` : "";
  const renderMoreActions = (resumePreview: string) => `
        <details class="more-actions">
          <summary class="action-btn">${uiIcon("ellipsis")}<span>${escapeHtml(t("action.more_actions"))}</span></summary>
          <div class="more-actions-list">
            <a href="${escapeHtml(backHref)}">${escapeHtml(t("detail.back"))}</a>
            ${previousSession ? `<a href="${sessionHref(previousSession)}" aria-label="${escapeHtml(t("detail.previous"))}">${escapeHtml(t("detail.previous"))}</a>` : ""}
            ${nextSession ? `<a href="${sessionHref(nextSession)}" aria-label="${escapeHtml(t("detail.next"))}">${escapeHtml(t("detail.next"))}</a>` : ""}
            ${resumeCommand && terminalLaunchAllowed ? `<button type="button" data-action="resume-session" data-id="${escapeHtml(session.id)}" ${resumeCommand.available ? "" : "disabled"}>${escapeHtml(t("action.open_terminal"))}</button>` : `<span class="action-unavailable" aria-disabled="true">${escapeHtml(t("detail.resume_unavailable"))}</span>`}
            <a href="/api/${encodedProvider}/session/${encodedSessionId}/export?format=md">${escapeHtml(t("action.export_md"))}</a>
            <a href="/api/${encodedProvider}/session/${encodedSessionId}/export?format=json">${escapeHtml(t("action.export_json"))}</a>
            ${resumePreview}
            ${manageable ? `<button type="button" data-action="rename" data-id="${escapeHtml(session.id)}">${escapeHtml(t("action.rename"))}</button>` : ""}
            ${manageable ? `<button type="button" data-action="copy-session-id" data-id="${escapeHtml(session.id)}">${escapeHtml(t("action.copy_session_id_menu"))}</button>` : ""}
            ${manageable ? `<button type="button" data-action="delete" data-id="${escapeHtml(session.id)}" class="menu-danger">${escapeHtml(t("action.delete"))}</button>` : ""}
          </div>
        </details>
  `;

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
          ${collaborationToggle}
          ${renderTranscriptSearch(provider, String(session.id), title)}
          ${renderMoreActions(resumePreview)}
        </div>
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

  const renderedReaderPane = readerPane || renderSessionReaderPane({
    session,
    sessionTree,
    messages,
    partsByMessage,
    provider,
    conversationCompactions,
    conversationView,
    inheritedContext
  });

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
<div class="session-workbench" data-session-id="${escapeHtml(session.id)}" data-provider="${escapeHtml(provider)}" data-session-reader data-reader-current-provider="${escapeHtml(provider)}" data-reader-current-session="${escapeHtml(session.id)}">
  <section class="main-content">
    ${breadcrumb}
    ${header}
    <span id="tab-conversation" class="reader-entry-anchor" data-reader-entry-anchor aria-hidden="true"></span>
    <div class="reader-shell" data-reader-shell>
      <div class="reader-shell-bar">
        <button type="button" class="reader-back" data-reader-back hidden>${escapeHtml(t("detail.reader_back"))}</button>
        <span class="reader-current-title" data-reader-current-title hidden aria-live="polite"></span>
        <output class="reader-status" data-reader-status aria-live="polite"></output>
      </div>
      <div data-reader-host>
        ${renderedReaderPane}
      </div>
    </div>
    <details id="tab-work" class="reader-secondary-disclosure" data-detail-tab-panel>
      <summary>${escapeHtml(t("detail.tab_work"))}</summary>
      <div class="reader-secondary-content">
        ${runtimeWorkbench || `<p class="empty-state">${t("runtime.unavailable")}</p>`}
      </div>
      ${projectEvidence}
      ${renderSessionMetricsPanel(sessionMetrics, lazySessionMetrics)}
      ${todoList(todos)}
    </details>
    <details id="tab-events" class="reader-secondary-disclosure" data-detail-tab-panel>
      <summary>${escapeHtml(t("detail.tab_events"))}</summary>
      <div class="reader-secondary-content">${runtimeEvents || `<p class="empty-state">${t("runtime.unavailable")}</p>`}</div>
    </details>
  </section>
</div>
  `;

  return layout(title, body, navigationContext?.section === "stats" ? "stats" : "home", { provider, providers, manageable, reader: true });
}
