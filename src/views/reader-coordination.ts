import { escapeHtml } from "../markdown.js";
import { t } from "../i18n.js";
import type { ReaderCoordinationPage, ReaderEventEvidence } from "../reader-coordination.js";
import type { ConversationChannelItem } from "../conversation-view-model.js";
import type { ReaderCoordinationContent } from "../providers/interface.js";
import { renderProgressiveContent } from "./components.js";

export function readerEventHref(provider: string, sessionId: string, eventId: string) {
  return `/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}?readerEvent=${encodeURIComponent(eventId)}`;
}

export function renderReaderEventSourceLink(provider: string, sessionId: string, eventId: string, label = t("detail.reader_observation_source"), className = "", extraAttributes = ""): string {
  return `<a data-reader-source data-reader-event-source data-reader-provider="${escapeHtml(provider)}" data-reader-session="${escapeHtml(sessionId)}" data-reader-event-id="${escapeHtml(eventId)}"${className ? ` class="${escapeHtml(className)}"` : ""}${extraAttributes} href="${escapeHtml(readerEventHref(provider, sessionId, eventId))}">${escapeHtml(label)}</a>`;
}

function nextPath(page: ReaderCoordinationPage, endpointPath: string): string | null {
  if (!page.nextCursor) return null;
  const params = new URLSearchParams();
  if (page.taskId) params.set("taskId", page.taskId);
  if (page.runId) params.set("runId", page.runId);
  if (page.anchor) params.set("anchor", page.anchor);
  params.set("size", String(page.size));
  params.set("cursor", page.nextCursor);
  return `${endpointPath}?${params.toString()}`;
}

export function readerCoordinationKindLabel(kind: string): string {
  const normalized = kind.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  const key = `conversation.channel_${normalized}`;
  const label = t(key);
  return label === key ? kind : label;
}

export function readerCoordinationContentPath(provider: string, sessionId: string, observationId: string): string {
  return `/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}/reader/coordination/${encodeURIComponent(observationId)}/content`;
}

/** SSR and continuation share one exchange shape; the body is read only when opened. */
export function renderReaderCoordinationItem(
  item: Omit<ConversationChannelItem, "kind"> & { kind: string },
  provider: string,
  sessionId: string,
  timing?: { timestampLabel: string; deliveredAt?: number | null }
): string {
  const owner = item.sourceEventRef?.session || { provider, sessionId };
  const eventId = item.sourceEventRef?.eventId || item.eventId;
  const source = eventId
    ? renderReaderEventSourceLink(owner.provider, owner.sessionId, eventId, t("detail.reader_coordination_content_source"))
    : "";
  const direction = [item.senderName, item.recipientName].filter(Boolean).join(" → ");
  const formatTime = (value: number | null) => value === null
    ? t("detail.reader_time_unknown")
    : new Date(value).toISOString().replace("T", " ").replace("Z", " UTC");
  const time = formatTime(item.timestamp);
  const timestampMarkup = timing
    ? `<span class="reader-coordination-time"><span>${escapeHtml(timing.timestampLabel)}</span><time class="agent-channel-time">${escapeHtml(time)}</time></span>`
    : `<time class="agent-channel-time">${escapeHtml(time)}</time>`;
  const deliveredMarkup = timing?.deliveredAt === undefined
    ? ""
    : `<span class="reader-coordination-delivered-at">${escapeHtml(t("detail.reader_team_delivered_at", { time: formatTime(timing.deliveredAt) }))}</span>`;
  const stateKey = `conversation.coordination_state_${item.state}`;
  const state = t(stateKey);
  const impliedState = { spawn: "started", "child-turn-completed": "completed", "result-delivery": "delivered" }[item.kind];
  const stateMarkup = item.state !== "unknown" && item.state !== impliedState
    ? ` <span class="agent-channel-state">${escapeHtml(state === stateKey ? item.state : state)}</span>` : "";
  return `<li class="agent-channel-item reader-coordination-item" data-reader-coordination-item data-reader-observation-id="${escapeHtml(item.id)}" data-reader-kind="${escapeHtml(item.kind)}" data-reader-state="${escapeHtml(item.state)}" data-channel-kind="${escapeHtml(item.kind)}" data-channel-id="${escapeHtml(item.id)}">
    <details class="reader-coordination-exchange" data-reader-coordination-content data-reader-coordination-content-url="${escapeHtml(readerCoordinationContentPath(provider, sessionId, item.id))}">
      <summary><span class="agent-channel-kind reader-coordination-kind">${escapeHtml(readerCoordinationKindLabel(item.kind))}</span>${stateMarkup}${timestampMarkup}${deliveredMarkup}${direction ? `<span class="agent-channel-direction">${escapeHtml(direction)}</span>` : ""}</summary>
      <div class="reader-coordination-content-panel" data-reader-coordination-content-panel aria-live="polite"></div>
      ${source ? `<div class="reader-coordination-content-actions">${source}</div>` : ""}
    </details>
  </li>`;
}

export function renderReaderCoordinationContentPage(content: ReaderCoordinationContent | null, offset: number) {
  if (!content) return {
    available: false, nextOffset: null, totalLength: null,
    html: `<p class="reader-coordination-content-state" data-reader-coordination-content-unavailable>${escapeHtml(t("detail.reader_coordination_content_unavailable"))}</p>`
  };
  const page = renderProgressiveContent(content.text, content.format, offset, 6000);
  const more = page.nextOffset === null ? "" : `<button type="button" class="reader-coordination-content-more" data-reader-coordination-content-more data-next-offset="${page.nextOffset}">${escapeHtml(t("detail.reader_coordination_content_more"))}</button>`;
  return {
    available: true, nextOffset: page.nextOffset, totalLength: page.totalLength,
    html: `<div class="reader-coordination-content" data-reader-coordination-content-chunk data-reader-coordination-content-offset="${offset}">${page.html}</div>${more}`
  };
}

export function renderReaderCoordinationPage(page: ReaderCoordinationPage): string {
  const items = page.items.map((item) => renderReaderCoordinationItem(item, page.provider, page.sessionId)).join("");
  const endpointPath = `/api/${encodeURIComponent(page.provider)}/session/${encodeURIComponent(page.sessionId)}/reader/coordination`;
  const more = nextPath(page, endpointPath);
  return `<section class="reader-coordination-page" data-reader-coordination-page data-reader-coordination-total="${page.total}" data-reader-coordination-offset="${page.offset}"><ol>${items || `<li>${escapeHtml(t("detail.reader_observation_no_source"))}</li>`}</ol>${more ? `<a data-reader-coordination-more href="${escapeHtml(more)}">${escapeHtml(t("conversation.agent_channel_load_more"))}</a>` : ""}</section>`;
}

/** Small source evidence fragment; providerData and transcript bodies never cross this boundary. */
export function renderReaderEventEvidence(evidence: ReaderEventEvidence): string {
  const scalar = [
    ["detail.reader_event_kind", evidence.normalizedKind],
    ["detail.reader_event_phase", evidence.phase],
    ["detail.reader_event_time", evidence.timestamp === null ? t("detail.reader_time_unknown") : new Date(evidence.timestamp).toISOString()],
    ["detail.reader_event_sequence", String(evidence.sequence)],
    ["detail.reader_event_turn", evidence.turnId],
    ["detail.reader_event_task", evidence.taskId],
    ["detail.reader_event_run", evidence.runId],
    ["detail.reader_event_message", evidence.messageId],
    ["detail.reader_event_tool_call", evidence.toolCallId],
    ["detail.reader_event_source", evidence.provenance.sourceId || evidence.provenance.sourceType]
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  const details = scalar.map(([label, value]) => `<dt>${escapeHtml(t(label))}</dt><dd>${escapeHtml(value)}</dd>`).join("");
  const summary = evidence.summary.compactionSummary
    ? `<p class="reader-event-evidence-summary">${escapeHtml(evidence.summary.compactionSummary)}</p>`
    : "";
  return `<article class="reader-event-evidence" data-reader-event-evidence data-reader-event-id="${escapeHtml(evidence.eventId)}"><h3>${escapeHtml(t("detail.reader_event_evidence"))}</h3>${summary}<dl>${details}</dl></article>`;
}
