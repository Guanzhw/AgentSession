import { t } from "../i18n.js";
import { escapeHtml } from "../markdown.js";
import type { ReaderRelations } from "../reader-relations.js";
import { anchorId } from "./anchors.js";

/** Geometry-free data and controls, colocated with the owning Reader document. */
export function renderReaderMemberRails(relations: ReaderRelations): string {
  const rails = relations.memberRails;
  if (!rails?.edges.length) return "";
  const owner = relations.milestones[0].sourceEventRef.session;
  const data = JSON.stringify({
    ...rails, owner,
    points: rails.points.map((point) => ({ ...point, anchor: anchorId("milestone", point.id) }))
  }).replace(/</g, "\\u003c");
  const options = rails.members.map((member) => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.name)}</option>`).join("");
  return `<div class="reader-member-rails-controls" data-reader-member-rails-controls hidden>
    <label><input type="checkbox" data-reader-member-rails-toggle checked>${escapeHtml(t("detail.reader_member_rails_show"))}</label>
    <label><span class="sr-only">${escapeHtml(t("detail.reader_member_rails_focus"))}</span><select data-reader-member-rails-select><option value="">${escapeHtml(t("detail.reader_member_rails_local"))}</option>${options}</select></label>
    <small>${escapeHtml(t("detail.reader_member_rails_legend"))}</small>
  </div><script type="application/json" data-reader-member-rails-data>${data}</script>`;
}
