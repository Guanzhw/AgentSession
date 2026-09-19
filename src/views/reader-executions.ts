import { t } from "../i18n.js";
import { escapeHtml } from "../markdown.js";
import { executionReturned, executionTimeRange, type ReaderExecution, type ReaderExecutionStep, type ReaderExecutions, type ReaderExecutionPage } from "../reader-executions.js";
import { anchorId } from "./anchors.js";
import { renderReaderEventSourceLink } from "./reader-coordination.js";
import { readerRelationPositionKey, type ReaderRelationMarkup } from "./reader-relations.js";

const phaseLabel = (step: ReaderExecutionStep) => t(`detail.execution_${step.observation.phase.replace(/-/g, "_")}`);
const clock = (timestamp: number | null) => timestamp === null ? t("detail.reader_time_unknown") : new Date(timestamp).toISOString().slice(11, 19) + " UTC";
const kindLabel = (item: ReaderExecution) => t(`detail.execution_kind_${item.kind.replace(/-/g, "_")}`);
const source = (view: ReaderExecutions, step: ReaderExecutionStep, label = t("detail.execution_read_step"), attrs = "") => (
  renderReaderEventSourceLink(view.provider, view.sessionId, step.eventId, label, "", attrs)
);

/** Add human-facing execution landmarks to the same source-position rendering path. */
export function appendReaderExecutionMarkers(base: ReaderRelationMarkup | null, view: ReaderExecutions | null): ReaderRelationMarkup | null {
  if (!view?.items.length) return base;
  const markup = base || { parts: new Map(), messages: new Map(), processPositions: new Set(), toolbar: "" };
  for (const item of view.items) {
    const firstYield = item.steps.find((step) => step.observation.phase === "yielded");
    const last = item.steps[item.steps.length - 1];
    for (const step of item.steps) {
      if (!step.position || (step !== firstYield && !executionReturned(step.observation.phase) && step.observation.phase !== "interruption-requested")) continue;
      const query = new URLSearchParams({ id: item.id });
      const url = `/api/${encodeURIComponent(view.provider)}/session/${encodeURIComponent(view.sessionId)}/reader/execution?${query}`;
      const counterpart = step === firstYield ? (executionReturned(last.observation.phase) ? last : null) : firstYield;
      const counterpartLink = counterpart?.position ? (() => {
        const anchor = anchorId("execution", counterpart.eventId);
        const href = `/${encodeURIComponent(view.provider)}/session/${encodeURIComponent(view.sessionId)}#${anchor}`;
        return `<a data-reader-source data-reader-provider="${escapeHtml(view.provider)}" data-reader-session="${escapeHtml(view.sessionId)}" data-reader-anchor="${escapeHtml(anchor)}" href="${escapeHtml(href)}">${escapeHtml(t(step === firstYield ? "detail.execution_to_result" : "detail.execution_to_start"))}</a>`;
      })() : "";
      const html = `<aside class="reader-execution-insert" id="${escapeHtml(anchorId("execution", step.eventId))}" data-reader-execution-marker="${escapeHtml(item.id)}" data-reader-execution-phase="${step.observation.phase}"><header><strong>${escapeHtml(kindLabel(item))}</strong><span>${escapeHtml(phaseLabel(step))}</span><time>${escapeHtml(clock(step.timestamp))}</time></header><div class="reader-execution-actions">${source(view, step)}${counterpartLink}</div><details data-reader-execution-detail data-reader-execution-url="${escapeHtml(url)}"><summary>${escapeHtml(t("detail.execution_view"))}</summary><div data-reader-execution-panel></div><div data-reader-execution-status role="status" aria-live="polite"></div></details></aside>`;
      const key = readerRelationPositionKey(step.position.partId || step.position.messageId, step.position.side);
      const index = step.position.partId ? markup.parts : markup.messages;
      index.set(key, (index.get(key) || "") + html);
      markup.processPositions.delete(key);
    }
  }
  return markup;
}

function renderTimeLanes(view: ReaderExecutions, selected: ReaderExecution): string {
  const range = executionTimeRange(selected);
  if (!range) return `<p>${escapeHtml(t("detail.execution_time_missing"))}</p>`;
  const selectedSplit = selected.steps.find((step) => step.observation.phase === "yielded")!.timestamp!;
  const peers = view.items.filter((item) => {
    if (item === selected) return false;
    const span = executionTimeRange(item);
    const split = item.steps.find((step) => step.observation.phase === "yielded")?.timestamp;
    return span && split != null && split < range.end && span.end > selectedSplit;
  });
  const items = [selected, ...peers.slice(0, 3)];
  const percent = (value: number) => Math.max(2, Math.min(98, (value - range.start) / (range.end - range.start) * 96 + 2));
  const main = view.prose.filter((point) => point.timestamp >= range.start && point.timestamp <= range.end);
  const excerpts = main.length > 3 ? [main[0], main[Math.floor(main.length / 2)], main[main.length - 1]] : main;
  const prose = excerpts.map((point) => `<li>${renderReaderEventSourceLink(view.provider, view.sessionId, point.eventId, point.text)}<time>${escapeHtml(clock(point.timestamp))}</time></li>`).join("");
  const mainDots = source(view, selected.steps[0], t("detail.execution_started"), ` class="reader-execution-dot" style="left:2%" title="${escapeHtml(t("detail.execution_started"))}"`)
    + excerpts.map((point) => renderReaderEventSourceLink(view.provider, view.sessionId, point.eventId,
      t("detail.execution_main"), "reader-execution-dot", ` style="left:${percent(point.timestamp)}%" title="${escapeHtml(point.text)}"`)).join("");
  const rows = items.map((item, index) => {
    const span = executionTimeRange(item)!;
    const first = item.steps.find((step) => step.observation.phase === "yielded")!;
    const last = item.steps[item.steps.length - 1];
    const ended = executionReturned(last.observation.phase);
    const start = percent(first.timestamp!), end = percent(span.end);
    const point = (step: ReaderExecutionStep, time: number, label: string) => time >= range.start && time <= range.end
      ? source(view, step, label, ` class="reader-execution-dot" style="left:${percent(time)}%" title="${escapeHtml(label)}"`) : "";
    const clipped = first.timestamp! < range.start || span.end > range.end;
    return `<div class="reader-execution-time-row${index === 0 ? " is-selected" : ""}${ended ? "" : " is-open"}"><div class="reader-execution-lane-label"><strong>${escapeHtml(kindLabel(item))}</strong><span>${source(view, first, item.name)}${ended ? "" : ` · ${escapeHtml(t("detail.execution_no_return"))}`}${clipped ? ` · ${escapeHtml(t("detail.execution_clipped"))}` : ""}</span></div><div class="reader-execution-time-track"><span class="reader-execution-time-span" style="left:${start}%;width:${Math.max(0, end - start)}%" aria-hidden="true"></span>${point(first, first.timestamp!, phaseLabel(first))}${point(last, span.end, ended ? phaseLabel(last) : t("detail.execution_no_return"))}</div></div>`;
  }).join("");
  // The connectors cross the same time coordinate on the main and selected lane.
  const last = selected.steps[selected.steps.length - 1];
  const split = percent(selected.steps.find((step) => step.observation.phase === "yielded")!.timestamp!);
  const connector = `<div class="reader-execution-boundary-labels" aria-hidden="true"><span style="left:${split}%;top:42px">${escapeHtml(t("detail.execution_split"))}</span>${executionReturned(last.observation.phase) ? `<span style="left:98%;top:8px">${escapeHtml(t("detail.execution_return"))}</span>` : ""}</div><svg class="reader-execution-connectors" viewBox="0 0 100 120" preserveAspectRatio="none" aria-hidden="true"><path d="M${split} 30 V88 L${split - 1} 83 M${split} 88 L${split + 1} 83"/>${executionReturned(last.observation.phase) ? '<path d="M98 90 V32 L97 37 M98 32 L99 37"/>' : ""}</svg>`;
  return `<figure class="reader-execution-time-view"><figcaption>${escapeHtml(t("detail.execution_timeline"))}</figcaption><div class="reader-execution-time-axis"><time>${escapeHtml(clock(range.start))}</time><time>${escapeHtml(clock(range.end))}</time></div><div class="reader-execution-time-lanes">${connector}<div class="reader-execution-time-row"><strong class="reader-execution-lane-label">${escapeHtml(t("detail.execution_main"))}</strong><div class="reader-execution-time-track">${mainDots}</div></div>${rows}</div><p class="reader-execution-time-note">${escapeHtml(t("detail.execution_time_note"))}</p>${peers.length > 3 ? `<p>${escapeHtml(t("detail.execution_more_peers", { count: String(peers.length - 3) }))}</p>` : ""}${prose ? `<details class="reader-execution-main-excerpts"><summary>${escapeHtml(t("detail.execution_main_excerpts"))}</summary><ol>${prose}</ol></details>` : ""}</figure>`;
}

export function renderReaderExecutionPage(page: ReaderExecutionPage): string {
  const { view, execution, steps, offset, nextCursor } = page;
  const entries = steps.map((step) => `<li data-reader-execution-step="${escapeHtml(step.eventId)}"><span>${escapeHtml(phaseLabel(step))}</span><time>${escapeHtml(clock(step.timestamp))}</time>${source(view, step)}</li>`).join("");
  const more = nextCursor ? `<li class="reader-execution-more-row"><button type="button" data-reader-execution-more data-reader-execution-cursor="${escapeHtml(nextCursor)}">${escapeHtml(t("detail.execution_more_steps"))}</button></li>` : "";
  const body = `${entries}${more}`;
  if (offset) return body;
  const last = execution.steps[execution.steps.length - 1];
  return `${renderTimeLanes(view, execution)}${executionReturned(last.observation.phase) ? "" : `<p>${escapeHtml(t("detail.execution_no_return_note"))}</p>`}<details class="reader-execution-step-details"><summary>${escapeHtml(t("detail.execution_steps", { count: String(execution.steps.length) }))}</summary><ol data-reader-execution-steps>${body}</ol></details>`;
}
