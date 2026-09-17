import { t } from "../i18n.js";
import { escapeHtml } from "../markdown.js";
import type { ReaderRelationMilestone, ReaderRelations } from "../reader-relations.js";
import { anchorId } from "./anchors.js";
import { renderReaderEventSourceLink } from "./reader-coordination.js";

/** Prepared once per reader pane; positions are supplied by the source projection. */
export interface ReaderRelationMarkup {
  parts: Map<string, string>;
  messages: Map<string, string>;
  processPositions: Set<string>;
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
  const processPositions = new Set<string>();
  const visiblePositions = new Set<string>();
  const stepsByLane = new Map<string, ReaderRelationMilestone[]>();
  for (const item of relations.milestones) {
    const key = readerRelationPositionKey(item.position.partId || item.position.messageId, item.position.side);
    (item.kind === "message" ? processPositions : visiblePositions).add(key);
    if (item.kind === "message") continue;
    const steps = stepsByLane.get(item.laneId) || [];
    steps.push(item);
    stepsByLane.set(item.laneId, steps);
  }
  for (const key of visiblePositions) processPositions.delete(key);
  const neighbours = new Map<string, { previous?: ReaderRelationMilestone; next?: ReaderRelationMilestone }>();
  for (const steps of stepsByLane.values()) {
    steps.forEach((item, index) => neighbours.set(item.id, { previous: steps[index - 1], next: steps[index + 1] }));
  }
  const stepLink = (item: ReaderRelationMilestone | undefined, direction: "previous" | "next") => {
    if (!item) return "";
    const owner = item.sourceEventRef.session;
    const anchor = anchorId("milestone", item.id);
    const label = t(`conversation.channel_${item.kind.replace(/-/g, "_")}`);
    const position = t(`detail.reader_step_${direction}`);
    const time = item.timestamp === null ? "" : new Date(item.timestamp).toISOString().slice(11, 16) + " UTC";
    const href = `/${encodeURIComponent(owner.provider)}/session/${encodeURIComponent(owner.sessionId)}#${encodeURIComponent(anchor)}`;
    return `<a class="reader-step-link reader-step-${direction}" data-reader-source data-reader-provider="${escapeHtml(owner.provider)}" data-reader-session="${escapeHtml(owner.sessionId)}" data-reader-anchor="${escapeHtml(anchor)}" href="${escapeHtml(href)}" aria-label="${escapeHtml([position, label, time].filter(Boolean).join(" · "))}"><small>${escapeHtml(position)}</small><span>${escapeHtml(label)}${time ? ` <time>${escapeHtml(time)}</time>` : ""}</span></a>`;
  };
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
    const adjacent = neighbours.get(item.id);
    const trace = adjacent && (adjacent.previous || adjacent.next)
      ? `<div class="reader-milestone-trace" role="group" aria-label="${escapeHtml(t("detail.reader_step_sequence"))}">${stepLink(adjacent.previous, "previous")}<span class="reader-step-current">${escapeHtml(t("detail.reader_step_current"))}</span>${stepLink(adjacent.next, "next")}</div>`
      : "";
    const description = `${name} · ${label}`;
    const markup = `<aside id="${escapeHtml(anchorId("milestone", item.id))}" class="reader-milestone reader-collaboration-insert" data-reader-milestone data-reader-observation-id="${escapeHtml(item.id)}" data-reader-lane="${escapeHtml(item.laneId)}" data-reader-kind="${escapeHtml(item.kind)}" data-reader-sequence="${item.sequence}" data-reader-run="${escapeHtml(item.runId || "")}" data-reader-event-id="${escapeHtml(item.eventId)}" aria-label="${escapeHtml(description)}"><span class="reader-milestone-mark reader-milestone-mark-${direction}" aria-hidden="true"></span><div class="reader-milestone-body"><div class="reader-milestone-main"><button type="button" data-reader-lane-focus value="${escapeHtml(item.laneId)}" aria-pressed="false"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(label)}</span></button>${timestamp}</div><span class="reader-milestone-links">${sourceLink}${history}</span>${trace}</div></aside>`;
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
  const toolbar = `<details class="reader-relations-toolbar" data-reader-relations-controls><summary>${escapeHtml(t("detail.reader_relation_navigation"))}</summary><div class="reader-relations-options">${focusMarkup}${unplaced}</div></details>`;
  return { parts, messages, processPositions, toolbar };
}
