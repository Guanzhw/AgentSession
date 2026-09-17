import { t } from "../i18n.js";
import { escapeHtml } from "../markdown.js";
import { uiIcon } from "../ui-icons.js";
import type { ReaderActivityProjection, ReaderActivityPoint } from "../reader-activity.js";
import { renderReaderEventSourceLink } from "./reader-coordination.js";

function sourceLink(point: ReaderActivityPoint): string {
  const source = point.source;
  if (!source.anchor) return renderReaderEventSourceLink(source.provider, source.sessionId, source.eventId!);
  const href = `/${encodeURIComponent(source.provider)}/session/${encodeURIComponent(source.sessionId)}#${encodeURIComponent(source.anchor!)}`;
  return `<a data-reader-source data-reader-provider="${escapeHtml(source.provider)}" data-reader-session="${escapeHtml(source.sessionId)}" data-reader-anchor="${escapeHtml(source.anchor!)}" href="${escapeHtml(href)}">${escapeHtml(t("detail.reader_observation_source"))}</a>`;
}

export function renderReaderActivity(view: ReaderActivityProjection): string {
  const c = view.coverage;
  const coverage = `<details class="reader-activity-coverage"><summary>${escapeHtml(t("detail.activity_coverage"))}</summary><p>${escapeHtml(t("detail.activity_counts", {
    points: String(c.returnedPoints), total: String(c.windowPoints), lanes: String(c.returnedLanes), totalLanes: String(c.windowLanes)
  }))}</p><p>${escapeHtml(t("detail.activity_missing", {
    untimed: String(c.untimedTextParts + c.untimedObservations), unassigned: String(c.unassignedObservations), source: String(c.missingSourceObservations), ordinary: String(c.ordinaryMessages)
  }))}</p></details>`;
  if (!view.range || !view.extent) return `<p>${escapeHtml(t("detail.activity_empty"))}</p>${coverage}`;
  const { start, end } = view.range;
  const clock = (time: number) => new Date(time).toISOString().slice(11, 16);
  const relative = (time: number) => Math.max(0, Math.min(100, (time - start) / (end - start) * 100));
  const lanes = view.lanes.map((lane) => {
    const name = lane.id === view.parentLaneId ? t("detail.activity_main") : lane.name || lane.childSession?.sessionId || t("conversation.agent_unknown");
    const points = lane.points.map((point) => {
      const kind = point.kind === "parent-text" ? t("detail.activity_prose") : t(`conversation.channel_${point.kind.replace(/-/g, "_")}`);
      const time = new Date(point.timestamp).toISOString().replace("T", " ").replace("Z", " UTC");
      return `<li data-reader-activity-point data-point-id="${escapeHtml(point.id)}" data-point-x="${relative(point.timestamp)}" data-point-kind="${escapeHtml(point.kind)}" data-point-label="${escapeHtml(`${name} · ${kind} · ${time}`)}"><strong>${escapeHtml(kind)}</strong><time datetime="${new Date(point.timestamp).toISOString()}">${escapeHtml(time)}</time>${point.excerpt ? `<p>${escapeHtml(point.excerpt)}</p>` : ""}${sourceLink(point)}</li>`;
    }).join("");
    const span = lane.span ? `<span class="reader-activity-span" aria-hidden="true" style="left:${relative(lane.span.start)}%;width:${relative(lane.span.end) - relative(lane.span.start)}%"></span>` : "";
    return `<div class="reader-activity-lane" data-reader-activity-lane="${escapeHtml(lane.id)}"><strong class="reader-activity-lane-name">${escapeHtml(name)}</strong><div class="reader-activity-track" data-reader-activity-track aria-label="${escapeHtml(name)}">${span}</div><ol class="reader-activity-records" data-reader-activity-records>${points}</ol></div>`;
  }).join("");
  const page = view.nextOffset !== null ? `<button type="button" data-reader-activity-page="${view.nextOffset}" data-reader-activity-from="${start}" data-reader-activity-revision="${escapeHtml(view.revision)}">${escapeHtml(t("detail.activity_more"))}</button>` : "";
  const previousPage = view.offset > 0 ? `<button type="button" data-reader-activity-from="${start}">${escapeHtml(t("detail.activity_first_page"))}</button>` : "";
  const note = view.anchor?.state === "untimed" ? `<p role="status">${escapeHtml(t("detail.activity_untimed_anchor"))}</p>`
    : view.anchor?.state === "not-found" ? `<p role="status">${escapeHtml(t("detail.activity_missing_anchor"))}</p>` : "";
  return `<section class="reader-activity-window" data-reader-activity-window data-reader-activity-selected="${escapeHtml(view.anchor?.id || "")}" data-reader-activity-cluster-label="${escapeHtml(t("detail.activity_cluster", { count: "{count}" }))}">
    <header class="reader-activity-header"><h3>${escapeHtml(t("detail.activity_title"))}</h3><div class="reader-activity-window-nav" tabindex="-1"><button type="button" data-reader-activity-from="${start - view.windowMs}" aria-label="${escapeHtml(t("detail.activity_previous"))}"${start <= view.extent.start ? " disabled" : ""}>${uiIcon("chevron-down")}</button><span>${new Date(start).toISOString().slice(0, 10)}<br>${clock(start)}–${clock(end)} UTC</span><button type="button" data-reader-activity-from="${end}" aria-label="${escapeHtml(t("detail.activity_next"))}"${end > view.extent.end ? " disabled" : ""}>${uiIcon("chevron-down")}</button></div></header>
    ${note}<p class="reader-activity-note">${escapeHtml(t("detail.activity_note"))}</p>
    <div class="reader-activity-axis" aria-hidden="true"><span>${clock(start)}</span><span>${clock(start + view.windowMs / 2)}</span><span>${clock(end)}</span></div>
    <div class="reader-activity-lanes">${lanes || `<p>${escapeHtml(t("detail.activity_window_empty"))}</p>`}</div>
    <div class="reader-activity-selection" data-reader-activity-selection aria-live="polite"><p>${escapeHtml(t("detail.activity_choose"))}</p></div>
    <div class="reader-activity-pages">${previousPage}${page}</div>${coverage}
  </section>`;
}
