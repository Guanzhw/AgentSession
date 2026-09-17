import { escapeHtml } from "../markdown.js";
import { t } from "../i18n.js";
import type { ReaderCoordinationPage, ReaderEventEvidence } from "../reader-coordination.js";

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

function coordinationKindLabel(kind: string): string {
  const normalized = String(kind).replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  const key = `conversation.channel_${normalized}`;
  const label = t(key);
  return label === key ? kind : label;
}

export function renderReaderCoordinationPage(page: ReaderCoordinationPage): string {
  const items = page.items.map((item) => {
    const owner = item.sourceEventRef?.session || page;
    const eventId = item.sourceEventRef?.eventId || item.eventId;
    const source = eventId
      ? renderReaderEventSourceLink(owner.provider, owner.sessionId, eventId)
      : `<span data-reader-source-state="unbound">${escapeHtml(t("detail.reader_observation_no_source"))}</span>`;
    const time = item.timestamp === null ? t("detail.reader_time_unknown") : new Date(item.timestamp).toISOString();
    return `<li class="agent-channel-item reader-coordination-item" data-reader-coordination-item data-reader-observation-id="${escapeHtml(item.id)}" data-reader-kind="${escapeHtml(item.kind)}" data-reader-state="${escapeHtml(item.state)}" data-channel-kind="${escapeHtml(item.kind)}" data-channel-id="${escapeHtml(item.id)}"><span class="agent-channel-kind reader-coordination-kind">${escapeHtml(coordinationKindLabel(item.kind))}</span><time class="agent-channel-time">${escapeHtml(time)}</time>${source}</li>`;
  }).join("");
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
