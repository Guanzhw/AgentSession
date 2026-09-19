import type { ConversationTaskGroup } from "../conversation-view-model.js";
import { t } from "../i18n.js";
import { escapeHtml } from "../markdown.js";

const CONNECTIONS_PER_GRAPH = 4;

/** A small relationship map of recorded assignments and received results. */
export function renderReaderTaskGraph(
  groups: ConversationTaskGroup[], provider: string, sessionId: string, selectedKey?: string
): string {
  const connections = groups.flatMap((group) => {
    const card = group.cards[0];
    return group.graphOrigins.map((origin) => ({
      key: group.key,
      label: card.responsibility || card.name || t("conversation.agent_unknown"),
      state: card.state,
      origin
    }));
  });
  if (!connections.length) return "";
  const pageCount = Math.ceil(connections.length / CONNECTIONS_PER_GRAPH);
  const selectedIndex = connections.findIndex((task) => task.key === selectedKey);
  const activePage = selectedIndex < 0 ? 0 : Math.floor(selectedIndex / CONNECTIONS_PER_GRAPH);
  const pages: string[] = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const window = connections.slice(pageIndex * CONNECTIONS_PER_GRAPH, (pageIndex + 1) * CONNECTIONS_PER_GRAPH);
    const page = [...new Set(window.map((item) => item.key))].map((key) => {
      const related = window.filter((item) => item.key === key);
      return { ...related[0], origins: new Map(related.map((item) => [item.origin.key, item.origin])),
        outgoing: related.some((item) => item.origin.outgoing), incoming: related.some((item) => item.origin.incoming) };
    });
    const origins = new Map(page.flatMap((task) => [...task.origins].map(([key, origin]) => [key, origin.name] as const)));
    const height = Math.max(page.length * 104, origins.size * 80);
    const rowHeight = height / page.length;
    const originY = new Map([...origins.keys()].map((key, index) => [key, (index + 0.5) * height / origins.size]));
    const sources = [...origins].map(([key, name]) => `<div class="reader-task-graph-origin" style="top:${originY.get(key)! - 32}px" data-reader-graph-origin="${escapeHtml(key)}"><span>${escapeHtml(name || t("detail.reader_graph_participant"))}</span></div>`).join("");
    const edges = page.map((task, index) => {
      const targetY = (index + 0.5) * rowHeight;
      const paths = [...task.origins].map(([key, origin]) => {
        const sourceY = originY.get(key)!;
        const outgoing = origin.outgoing ? `<path class="reader-task-graph-assignment" d="M118 ${sourceY - 9} H196 V${targetY - 9} H287 M281 ${targetY - 13} L287 ${targetY - 9} L281 ${targetY - 5}"/>` : "";
        const incoming = origin.incoming ? `<path class="reader-task-graph-return" d="M292 ${targetY + 9} H216 V${sourceY + 9} H123 M129 ${sourceY + 5} L123 ${sourceY + 9} L129 ${sourceY + 13}"/>` : "";
        return outgoing + incoming;
      }).join("");
      return `<g data-reader-graph-edge="${escapeHtml(task.key)}">${paths}</g>`;
    }).join("");
    const nodes = page.map((task, index) => {
      const state = task.state ? t(`conversation.state_${task.state}`) : "";
      const relationLabel = [task.outgoing ? t("detail.reader_graph_assignment") : "", task.incoming ? t("detail.reader_graph_return") : ""].filter(Boolean).join(" / ");
      const centerY = (index + 0.5) * rowHeight;
      return `<button type="button" class="reader-task-graph-edge-label" data-reader-task-select="${escapeHtml(task.key)}" style="top:${centerY - 50}px" aria-pressed="${task.key === selectedKey}" aria-label="${escapeHtml(task.label + ": " + relationLabel)}">${escapeHtml(relationLabel)}</button><button type="button" class="reader-task-graph-node" data-reader-task-select="${escapeHtml(task.key)}" style="top:${centerY - 32}px" aria-pressed="${task.key === selectedKey}" title="${escapeHtml(task.label)}"><strong>${escapeHtml(task.label)}</strong>${state ? `<span>${escapeHtml(state)}</span>` : ""}</button>`;
    }).join("");
    pages.push(`<div class="reader-task-graph-canvas" data-reader-task-graph-page="${pageIndex}" style="height:${height}px"${pageIndex === activePage ? "" : " hidden"}><svg viewBox="0 0 480 ${height}" preserveAspectRatio="none" aria-hidden="true">${edges}</svg>${sources}${nodes}</div>`);
  }
  return `<section class="reader-task-graph" data-reader-task-graph data-reader-graph-provider="${escapeHtml(provider)}" data-reader-graph-session="${escapeHtml(sessionId)}" data-reader-graph-page="${activePage}" aria-label="${escapeHtml(t("detail.reader_graph_title"))}"><div class="reader-task-graph-heading"><h3>${escapeHtml(t("detail.reader_graph_title"))}</h3>${pageCount > 1 ? `<span class="reader-task-graph-paging"><button type="button" data-reader-graph-previous aria-label="${escapeHtml(t("detail.reader_graph_previous"))}"${activePage === 0 ? " disabled" : ""}>‹</button><span data-reader-graph-page-label>${activePage + 1} / ${pageCount}</span><button type="button" data-reader-graph-next aria-label="${escapeHtml(t("detail.reader_graph_next"))}"${activePage + 1 === pageCount ? " disabled" : ""}>›</button></span>` : ""}</div><p class="reader-task-graph-legend"><span class="reader-task-graph-assignment-legend">${escapeHtml(t("detail.reader_graph_assignment"))}</span><span class="reader-task-graph-return-legend">${escapeHtml(t("detail.reader_graph_return"))}</span></p>${pages.join("")}</section>`;
}
