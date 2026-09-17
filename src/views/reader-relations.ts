import { t } from "../i18n.js";
import { escapeHtml } from "../markdown.js";
import type { ReaderRelations } from "../reader-relations.js";
import { anchorId } from "./anchors.js";
import { renderReaderEventSourceLink } from "./reader-coordination.js";

/** Prepared once per reader pane; positions are supplied by the source projection. */
export interface ReaderRelationMarkup {
  parts: Map<string, string>;
  messages: Map<string, string>;
  toolbar: string;
}

export function readerRelationPositionKey(id: string, side: "before" | "after") {
  return `${side}\u0000${id}`;
}

export function renderReaderRelations(relations: ReaderRelations | null): ReaderRelationMarkup | null {
  if (!relations || (!relations.milestones.length && !relations.unplaced.length)) return null;
  const lanes = new Map(relations.lanes.map((lane) => [lane.id, lane]));
  const visibleLaneIds = new Set(relations.milestones.map((item) => item.laneId));
  const visibleLanes = relations.lanes.filter((lane) => visibleLaneIds.has(lane.id));
  const parts = new Map<string, string>();
  const messages = new Map<string, string>();
  for (const item of relations.milestones) {
    const lane = lanes.get(item.laneId)!;
    const name = lane.name || lane.childSession?.sessionId || lane.id;
    const label = t(`conversation.channel_${item.kind.replace(/-/g, "_")}`);
    const source = item.sourceEventRef;
    const child = lane.childSession;
    const history = child
      ? `<a data-reader-open data-reader-provider="${escapeHtml(child.provider)}" data-reader-session="${escapeHtml(child.sessionId)}" href="/${encodeURIComponent(child.provider)}/session/${encodeURIComponent(child.sessionId)}">${escapeHtml(t("detail.reader_child_history"))}</a>`
      : "";
    const direction = item.kind === "result-delivery" || item.kind === "mailbox-delivery" ? "in" : "out";
    const timestamp = item.timestamp !== null
      ? `<time datetime="${new Date(item.timestamp).toISOString()}">${escapeHtml(new Date(item.timestamp).toISOString().replace("T", " ").replace("Z", " UTC"))}</time>`
      : "";
    const sourceLink = renderReaderEventSourceLink(source.session.provider, source.session.sessionId, source.eventId, t("detail.reader_observation_source"), "reader-milestone-source");
    const description = `${name} · ${label}`;
    const markup = `<aside id="${escapeHtml(anchorId("milestone", item.id))}" class="reader-milestone reader-collaboration-insert" data-reader-milestone data-reader-lane="${escapeHtml(item.laneId)}" data-reader-kind="${escapeHtml(item.kind)}" data-reader-sequence="${item.sequence}" data-reader-run="${escapeHtml(item.runId || "")}" data-reader-event-id="${escapeHtml(item.eventId)}" aria-label="${escapeHtml(description)}"><span class="reader-milestone-mark reader-milestone-mark-${direction}" aria-hidden="true"></span><div class="reader-milestone-body"><div class="reader-milestone-main"><button type="button" data-reader-lane-focus value="${escapeHtml(item.laneId)}" aria-pressed="false"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(label)}</span></button>${timestamp}</div><span class="reader-milestone-links">${sourceLink}${history}</span></div></aside>`;
    const index = item.position.partId ? parts : messages;
    const key = readerRelationPositionKey(item.position.partId || item.position.messageId, item.position.side);
    index.set(key, (index.get(key) || "") + markup);
  }
  const options = visibleLanes.map((lane, index) => `<option value="${escapeHtml(lane.id)}"${visibleLanes.length > 3 && index === 0 ? " selected" : ""}>${escapeHtml(lane.name || lane.childSession?.sessionId || lane.id)}</option>`).join("");
  const unplaced = relations.unplaced.length
    ? `<details class="reader-relations-unplaced"><summary>${escapeHtml(t("conversation.agent_channel_more"))}</summary><ol>${relations.unplaced.map((item) => {
      const lane = item.laneId ? lanes.get(item.laneId) : null;
      const name = lane?.name || lane?.childSession?.sessionId || null;
      const source = item.sourceEventRef?.eventId
        ? renderReaderEventSourceLink(item.sourceEventRef.session.provider, item.sourceEventRef.session.sessionId, item.sourceEventRef.eventId)
        : `<span data-reader-source-state="unbound">${escapeHtml(t("detail.reader_observation_no_source"))}</span>`;
      const time = item.timestamp === null ? t("detail.reader_time_unknown") : new Date(item.timestamp).toISOString();
      return `<li data-reader-relation-unplaced><span>${escapeHtml([name, t(`conversation.channel_${item.kind.replace(/-/g, "_")}`)].filter(Boolean).join(" · "))}</span><time>${escapeHtml(time)}</time>${source}</li>`;
    }).join("")}</ol></details>`
    : "";
  const focusMarkup = visibleLanes.length
    ? `<span class="reader-relations-label">${escapeHtml(t("detail.reader_relation_focus"))}</span><label class="reader-relations-select-label"><span class="sr-only">${escapeHtml(t("detail.reader_relation_focus"))}</span><select data-reader-lane-select>${visibleLanes.length <= 3 ? `<option value="">${escapeHtml(t("detail.reader_relation_all"))}</option>` : ""}${options}</select></label><small class="reader-relations-note">${escapeHtml(t("detail.reader_relation_axis"))}</small>`
    : "";
  const toolbar = `<div class="reader-relations-toolbar" data-reader-relations-controls>${focusMarkup}${unplaced}</div>`;
  return { parts, messages, toolbar };
}
