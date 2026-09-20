import { t } from "../i18n.js";
import { escapeHtml } from "../markdown.js";
import type { ReaderTeamDetailPage, ReaderTeamDirectoryItem, ReaderTeamDirectoryPage, ReaderTeamTaskPage } from "../reader-teams.js";
import { anchorId } from "./anchors.js";
import { renderReaderCoordinationItem } from "./reader-coordination.js";

function teamDirectoryPath(page: ReaderTeamDirectoryPage): string | null {
  if (!page.nextCursor) return null;
  const params = new URLSearchParams({ size: String(page.size), cursor: page.nextCursor });
  if (page.query) params.set("q", page.query);
  return `/api/${encodeURIComponent(page.provider)}/session/${encodeURIComponent(page.sessionId)}/reader/teams?${params}`;
}

function teamDetailPath(provider: string, sessionId: string, key: string, cursor: string | null = null, size = 50): string {
  const params = new URLSearchParams({ key, size: String(size) });
  if (cursor) params.set("cursor", cursor);
  return `/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}/reader/team?${params}`;
}

function teamTaskPath(provider: string, sessionId: string, key: string, cursor: string, size: number): string {
  const params = new URLSearchParams({ key, cursor, size: String(size) });
  return `/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}/reader/team/tasks?${params}`;
}

function teamTaskContentPath(provider: string, sessionId: string, taskId: string): string {
  return `/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}/reader/team/task/${encodeURIComponent(taskId)}/content`;
}

function teamMemberContentPath(provider: string, sessionId: string, actorId: string): string {
  return `/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}/reader/team/member/${encodeURIComponent(actorId)}/content`;
}

function selectionLabel(item: ReaderTeamDirectoryItem): string {
  return item.kind === "member"
    ? item.member.name
    : `${item.communication.senderName} → ${item.communication.recipientName}`;
}

function renderDirectoryItem(item: ReaderTeamDirectoryItem, provider: string, sessionId: string): string {
  const detailUrl = teamDetailPath(provider, sessionId, item.key);
  if (item.kind === "member") {
    const summary = item.member.responsibility || t("detail.reader_team_no_assignment");
    return `<li><button type="button" data-reader-team-select="${escapeHtml(item.key)}" data-reader-team-detail-url="${escapeHtml(detailUrl)}" aria-pressed="false"><strong>${escapeHtml(item.member.name)}</strong><span>${escapeHtml(summary)}</span><small>${escapeHtml(t("detail.reader_team_member_counts", { tasks: String(item.member.assignmentCount), messages: String(item.member.messageCount) }))}</small></button></li>`;
  }
  return `<li><button type="button" data-reader-team-select="${escapeHtml(item.key)}" data-reader-team-detail-url="${escapeHtml(detailUrl)}" aria-pressed="false"><strong>${escapeHtml(selectionLabel(item))}</strong><span>${escapeHtml(t("detail.reader_team_messages", { count: String(item.communication.messageCount) }))}</span></button></li>`;
}

export function renderReaderTeamDirectoryPage(page: ReaderTeamDirectoryPage): string {
  const items = page.items.map((item) => renderDirectoryItem(item, page.provider, page.sessionId)).join("");
  const more = teamDirectoryPath(page);
  return `<div class="reader-team-directory-page" data-reader-team-directory-page data-reader-team-directory-offset="${page.offset}"><ul>${items || `<li class="reader-team-empty">${escapeHtml(t("detail.reader_team_empty"))}</li>`}</ul>${more ? `<button type="button" data-reader-team-directory-more data-reader-team-directory-url="${escapeHtml(more)}">${escapeHtml(t("progressive.show_more"))}</button>` : ""}</div>`;
}

function teamMembershipTopology(page: ReaderTeamDirectoryPage): string {
  const byTeam = new Map<string, Extract<ReaderTeamDirectoryItem, { kind: "member" }>[]>();
  for (const item of page.items) {
    if (item.kind !== "member") continue;
    const members = byTeam.get(item.teamId) || [];
    members.push(item);
    byTeam.set(item.teamId, members);
  }
  return [...byTeam.values()].map((members) => {
    const branches = members.map((item) => {
      const assignment = item.member.assignmentCount
        ? `<span>${escapeHtml(t("detail.reader_team_assignments", { count: String(item.member.assignmentCount) }))}</span>` : "";
      return `<div class="reader-team-topology-branch"><span class="reader-team-graph-edge"><span>${escapeHtml(t("detail.reader_team_membership"))}</span>${assignment}</span><button type="button" class="reader-team-graph-node" data-reader-team-select="${escapeHtml(item.key)}" data-reader-team-detail-url="${escapeHtml(teamDetailPath(page.provider, page.sessionId, item.key))}" aria-pressed="false">${escapeHtml(item.member.name)}</button></div>`;
    }).join("");
    return `<div class="reader-team-topology"><span class="reader-team-graph-node reader-team-graph-team">${escapeHtml(members[0].teamName)}</span><div class="reader-team-topology-branches">${branches}</div></div>`;
  }).join("");
}

function teamCommunicationRows(page: ReaderTeamDirectoryPage): string {
  return page.items.filter((item) => item.kind === "communication").map((item) => {
    if (item.kind !== "communication") return "";
    return `<div class="reader-team-graph-row reader-team-communication-row"><span class="reader-team-graph-node">${escapeHtml(item.communication.senderName)}</span><button type="button" class="reader-team-graph-edge" data-reader-team-select="${escapeHtml(item.key)}" data-reader-team-detail-url="${escapeHtml(teamDetailPath(page.provider, page.sessionId, item.key))}" aria-pressed="false"><span>${escapeHtml(t("detail.reader_team_messages", { count: String(item.communication.messageCount) }))}</span></button><span class="reader-team-graph-node">${escapeHtml(item.communication.recipientName)}</span></div>`;
  }).join("");
}

export function renderReaderTeamGraph(page: ReaderTeamDirectoryPage): string {
  if (!page.items.length) return "";
  const membership = teamMembershipTopology(page);
  const communication = teamCommunicationRows(page);
  const scope = page.total > page.items.length
    ? `<small>${escapeHtml(t("detail.reader_team_graph_scope", { start: String(page.offset + 1), end: String(page.offset + page.items.length), total: String(page.total) }))}</small>` : "";
  return `<figure class="reader-team-graph" data-reader-team-graph data-reader-team-graph-offset="${page.offset}"><figcaption>${escapeHtml(t("detail.reader_team_graph"))}${scope}</figcaption>${membership ? `<div class="reader-team-graph-group"><h3>${escapeHtml(t("detail.reader_team_members_and_assignments"))}</h3>${membership}</div>` : ""}${communication ? `<div class="reader-team-graph-group"><h3>${escapeHtml(t("detail.reader_team_communication"))}</h3>${communication}</div>` : ""}</figure>`;
}

function renderMemberSession(page: ReaderTeamDetailPage): string {
  if (page.selection.kind !== "member") return "";
  const member = page.selection.member;
  if (!member.sessionRef) {
    return `<p class="reader-team-history-note">${escapeHtml(t("detail.reader_team_history_unavailable"))}</p>`;
  }
  const href = `/${encodeURIComponent(member.sessionRef.provider)}/session/${encodeURIComponent(member.sessionRef.sessionId)}`;
  return `<a id="${escapeHtml(anchorId("team-history", page.selection.key))}" class="reader-team-history-link" data-reader-source data-reader-provider="${escapeHtml(member.sessionRef.provider)}" data-reader-session="${escapeHtml(member.sessionRef.sessionId)}" data-reader-anchor="${escapeHtml(anchorId("session", member.sessionRef.sessionId))}" href="${escapeHtml(href)}">${escapeHtml(t("detail.reader_team_open_history"))}</a>`;
}

function renderMemberDescription(page: ReaderTeamDetailPage): string {
  if (page.selection.kind !== "member" || !page.selection.member.hasDescription) return "";
  const member = page.selection.member;
  return `<details class="reader-team-member-description" data-reader-coordination-content data-reader-coordination-content-url="${escapeHtml(teamMemberContentPath(page.provider, page.sessionId, member.actorId))}"><summary>${escapeHtml(t("detail.reader_team_member_description"))}</summary><div class="reader-coordination-content-panel" data-reader-coordination-content-panel aria-live="polite"></div></details>`;
}

function renderTaskItems(tasks: ReaderTeamTaskPage["tasks"], provider: string, sessionId: string): string {
  return tasks.map((task) => {
    const stateKey = `detail.reader_team_task_${task.status}`;
    const state = t(stateKey);
    const label = `<span class="reader-team-task-row"><strong>${escapeHtml(task.title || t("runtime.untitled_task"))}</strong><span>${escapeHtml(state === stateKey ? task.status : state)}</span></span>`;
    if (!task.hasDescription) return `<li>${label}</li>`;
    return `<li><details class="reader-team-task-description" data-reader-coordination-content data-reader-coordination-content-url="${escapeHtml(teamTaskContentPath(provider, sessionId, task.id))}"><summary>${label}<small>${escapeHtml(t("detail.reader_team_task_description"))}</small></summary><div class="reader-coordination-content-panel" data-reader-coordination-content-panel aria-live="polite"></div></details></li>`;
  }).join("");
}

export function renderReaderTeamTaskPage(page: ReaderTeamTaskPage): string {
  const more = page.nextCursor ? teamTaskPath(page.provider, page.sessionId, page.selection.key, page.nextCursor, page.size) : null;
  return `${renderTaskItems(page.tasks, page.provider, page.sessionId)}${more ? `<li class="reader-team-task-more"><button type="button" data-reader-team-tasks-more data-reader-team-tasks-url="${escapeHtml(more)}">${escapeHtml(t("detail.reader_team_more_assignments", { count: String(page.total - page.offset - page.tasks.length) }))}</button></li>` : ""}`;
}

function renderTasks(page: ReaderTeamDetailPage): string {
  if (page.selection.kind !== "member" || !page.taskTotal) return "";
  const taskPage: ReaderTeamTaskPage = {
    ok: true, provider: page.provider, sessionId: page.sessionId, selection: page.selection,
    tasks: page.tasks, offset: page.taskOffset, total: page.taskTotal, size: page.taskSize,
    nextCursor: page.taskNextCursor
  };
  return `<section class="reader-team-assignments"><h4>${escapeHtml(t("detail.reader_team_assignments_title"))}</h4><ul data-reader-team-task-pages>${renderReaderTeamTaskPage(taskPage)}</ul></section>`;
}

function renderExchangePage(page: ReaderTeamDetailPage): string {
  const items = page.exchanges.map((exchange) => {
    const item = {
      id: exchange.observation.id,
      kind: exchange.observation.kind,
      timestamp: exchange.observation.timestamp,
      senderActorId: exchange.observation.senderActorId || null,
      recipientActorId: exchange.observation.recipientActorId || null,
      senderName: exchange.senderName,
      recipientName: exchange.recipientName,
      eventId: exchange.observation.eventId || null,
      turnId: exchange.observation.turnId || null,
      sourceEventRef: exchange.observation.sourceEventRef || null,
      state: exchange.delivered ? "delivered" : exchange.observation.state || "unknown"
    };
    return renderReaderCoordinationItem(item, page.provider, page.sessionId, {
      timestampLabel: t("detail.reader_team_queued_at"),
      deliveredAt: exchange.delivered ? exchange.deliveredAt : undefined
    });
  }).join("");
  const more = page.nextCursor ? teamDetailPath(page.provider, page.sessionId, page.selection.key, page.nextCursor, page.size) : null;
  return `<div class="reader-team-exchange-page" data-reader-team-exchange-page data-reader-team-exchange-offset="${page.offset}"><ol>${items || `<li class="reader-team-empty">${escapeHtml(t("detail.reader_team_no_messages"))}</li>`}</ol>${more ? `<button type="button" data-reader-team-exchanges-more data-reader-team-exchanges-url="${escapeHtml(more)}">${escapeHtml(t("detail.reader_team_more_messages"))}</button>` : ""}</div>`;
}

export function renderReaderTeamDetail(page: ReaderTeamDetailPage, continuation = false): string {
  if (continuation) return renderExchangePage(page);
  const label = selectionLabel(page.selection);
  return `<article id="${escapeHtml(anchorId("team-selection", page.selection.key))}" class="reader-team-detail" data-reader-team-detail data-reader-team-key="${escapeHtml(page.selection.key)}"><header><button type="button" data-reader-team-back>← ${escapeHtml(t("detail.reader_team_back"))}</button><div><p>${escapeHtml(page.selection.teamName)}</p><h3 tabindex="-1" data-reader-team-detail-title>${escapeHtml(label)}</h3></div></header>${renderMemberSession(page)}${renderMemberDescription(page)}${renderTasks(page)}<section class="reader-team-exchanges"><h4>${escapeHtml(t("detail.reader_team_exchanges"))}</h4><div data-reader-team-exchange-pages>${renderExchangePage(page)}</div></section></article>`;
}

export function renderReaderTeams(page: ReaderTeamDirectoryPage): string {
  if (!page.total) return "";
  return `<details class="reader-teams" data-reader-teams><summary><span>${escapeHtml(t("detail.reader_teams_title"))}</span><small>${escapeHtml(t("detail.reader_teams_note", { count: String(page.total) }))}</small></summary><div class="reader-teams-body"><div data-reader-team-browse><div data-reader-team-graph-host>${renderReaderTeamGraph(page)}</div><details class="reader-team-directory"><summary>${escapeHtml(t("detail.reader_team_directory"))}</summary><form data-reader-team-search><input type="search" data-reader-team-search-input aria-label="${escapeHtml(t("detail.reader_team_search"))}" placeholder="${escapeHtml(t("detail.reader_team_search"))}"><button type="submit">${escapeHtml(t("library.search_action"))}</button><span data-reader-team-search-status role="status"></span></form><div data-reader-team-directory-pages>${renderReaderTeamDirectoryPage(page)}</div></details></div><div data-reader-team-detail-host hidden></div><p data-reader-team-status role="status"></p></div></details>`;
}
