import { escapeHtml } from "../markdown.js";
import { layout } from "./layout.js";
import { sessionCard } from "./components.js";
import { t } from "../i18n.js";
import { projectFilterValue } from "../project-filter.js";

export function renderSessionsPage({
  sessions = [],
  total = 0,
  limit = 30,
  offset = 0,
  query = "",
  note = "",
  range = "",
  project = "",
  sort = "updated-desc",
  starredOnly = false,
  sessionKind = "all",
  projectOptions = [],
  searchMode = "list",
  totalMessages = 0,
  deletedCount = 0,
  provider = "opencode",
  providerAvailable = true,
  manageable = false,
  providers = []
}: { sessions?: any[]; total?: number; limit?: number; offset?: number; query?: string; note?: string; range?: string; project?: string; sort?: string; starredOnly?: boolean; sessionKind?: string; projectOptions?: { id: string; label: string; count?: number; worktree?: string }[]; searchMode?: string; totalMessages?: number; deletedCount?: number; provider?: string; providerAvailable?: boolean; manageable?: boolean; providers?: any[] } = {}) {
  const isAvailable = providerAvailable !== false;
  const isManageableProvider = isAvailable && manageable;
  const hasVisibleSessions = sessions.length > 0;
  const hasActiveFilters = Boolean(query || range || project || starredOnly || sort !== "updated-desc" || sessionKind !== "all");
  const cards = !isAvailable
    ? `<p class="empty-state">${t("provider.not_detected")}</p>`
  : sessions.length
    ? sessions.map((session) => sessionCard(session, false, { showCheckbox: true, provider, manageable: isManageableProvider })).join("\n")
    : hasActiveFilters
      ? `<p class="empty-state">${query ? t("sessions.empty_search").replace("{query}", escapeHtml(query)) : t("sessions.empty_filter")}</p>`
      : `<p class="empty-state">${t("sessions.empty")}</p>`;

  const searchNote = note ? `<p class="search-note">${escapeHtml(note)}</p>` : "";

  const shortProjectLabel = (value: any) => {
    const text = String(value || "");
    const parts = text.split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || text || t("filter.unknown_project");
  };

  const ranges = [
    { key: "", label: t("range.all") },
    { key: "today", label: t("range.today") },
    { key: "week", label: t("range.week") },
    { key: "month", label: t("range.month") }
  ];
  const rangeOptions = ranges.map((item) => (
    `<option value="${escapeHtml(item.key)}" ${item.key === range ? "selected" : ""}>${escapeHtml(item.label)}</option>`
  )).join("");
  const sortOptions = [
    { key: "updated-desc", label: t("sort.updated_desc") },
    { key: "updated-asc", label: t("sort.updated_asc") },
    { key: "title-asc", label: t("sort.title_asc") },
    { key: "title-desc", label: t("sort.title_desc") }
  ].map((item) => (
    `<option value="${escapeHtml(item.key)}" ${item.key === sort ? "selected" : ""}>${escapeHtml(item.label)}</option>`
  )).join("");
  const sessionKindOptions = [
    { key: "all", label: t("filter.title_all") },
    { key: "work", label: t("filter.title_work") },
    { key: "analysis", label: t("filter.title_analysis") }
  ].map((item) => (
    `<option value="${escapeHtml(item.key)}" ${item.key === sessionKind ? "selected" : ""}>${escapeHtml(item.label)}</option>`
  )).join("");
  const projectSelectOptions = [
    `<option value="">${t("filter.all_projects")}</option>`,
    ...projectOptions.map((item) => {
      const optionValue = projectFilterValue(item.id);
      const label = `${shortProjectLabel(item.label)} (${Number(item.count) || 0})`;
      return `<option value="${escapeHtml(optionValue)}" ${optionValue === String(project) ? "selected" : ""} title="${escapeHtml(item.worktree || item.label || "")}">${escapeHtml(label)}</option>`;
    })
  ].join("");
  const filterBar = isAvailable ? `<form class="session-filter" action="/${provider}" method="GET">
    <label class="filter-field filter-keyword">
      <span>${t("filter.keyword")}</span>
      <input type="search" name="q" value="${escapeHtml(query)}" placeholder="${t("filter.keyword_placeholder")}">
    </label>
    <label class="filter-field">
      <span>${t("filter.project")}</span>
      <select name="project">${projectSelectOptions}</select>
    </label>
    <label class="filter-field">
      <span>${t("filter.time")}</span>
      <select name="range">${rangeOptions}</select>
    </label>
    <label class="filter-field">
      <span>${t("filter.sort")}</span>
      <select name="sort">${sortOptions}</select>
    </label>
    <label class="filter-field">
      <span>${t("filter.title_type")}</span>
      <select name="kind">${sessionKindOptions}</select>
    </label>
    ${isManageableProvider ? `<div class="filter-field filter-check">
      <span>${t("filter.view")}</span>
      <label class="filter-checkbox">
        <input type="checkbox" name="starred" value="1" ${starredOnly ? "checked" : ""}>
        <span>${t("filter.starred_only")}</span>
      </label>
    </div>` : ""}
    <div class="filter-actions">
      <button class="btn" type="submit">${t("filter.apply")}</button>
      ${hasActiveFilters ? `<a class="btn btn-secondary" href="/${provider}">${t("filter.clear")}</a>` : ""}
    </div>
  </form>` : "";
  const dashboard = `
    <section class="dashboard-grid">
      <a href="#session-list" class="dash-card">
        <div class="dash-card-header">
          <span class="dash-file">sessions/</span>
          <span class="dash-badge">db</span>
        </div>
        <div class="dash-card-body">
          <div class="dash-line"><span class="ck">"name"</span>: <span class="cs">"${t("sessions.title")}"</span>,</div>
          <div class="dash-line"><span class="ck">"count"</span>: <span class="cn">${total}</span><span class="cc"> // ${t("sessions.count").replace("{count}", total)}</span></div>
        </div>
        <div class="dash-card-footer">
          <span class="dash-cmd">$ ls sessions</span>
          <span class="dash-arrow">\u2192</span>
        </div>
      </a>
      <a href="/${provider}/stats" class="dash-card">
        <div class="dash-card-header">
          <span class="dash-file">stats.json</span>
          <span class="dash-badge">api</span>
        </div>
        <div class="dash-card-body">
          <div class="dash-line"><span class="ck">"name"</span>: <span class="cs">"${t("nav.stats")}"</span>,</div>
          <div class="dash-line"><span class="ck">"messages"</span>: <span class="cn">${totalMessages}</span><span class="cc"> // ${t("stats.total_messages")}</span></div>
        </div>
        <div class="dash-card-footer">
          <span class="dash-cmd">$ watch stats</span>
          <span class="dash-arrow">\u2192</span>
        </div>
      </a>
      ${isManageableProvider ? `
      <a href="/${provider}/trash" class="dash-card">
        <div class="dash-card-header">
          <span class="dash-file">trash/</span>
          <span class="dash-badge">sys</span>
        </div>
        <div class="dash-card-body">
          <div class="dash-line"><span class="ck">"name"</span>: <span class="cs">"${t("nav.trash")}"</span>,</div>
          <div class="dash-line"><span class="ck">"count"</span>: <span class="cn">${deletedCount}</span><span class="cc"> // ${t("trash.count").replace("{count}", deletedCount)}</span></div>
        </div>
        <div class="dash-card-footer">
          <span class="dash-cmd">$ ls trash</span>
          <span class="dash-arrow">\u2192</span>
        </div>
      </a>` : ""}
    </section>
  `;

  const body = `
    ${!hasActiveFilters && isAvailable ? dashboard : ""}
    <section class="page-header">
      <div class="page-header-row">
        <div>
          <h1>${searchMode === "content" && query ? t("sessions.search_title").replace("{query}", escapeHtml(query)) : t("sessions.title")}</h1>
          <p>${t("sessions.count").replace("{count}", total)}</p>
        </div>
        ${searchMode !== "content" && isManageableProvider && hasVisibleSessions ? `<button class="btn btn-manage" id="toggle-batch">${t("sessions.manage")}</button>` : ""}
      </div>
      ${searchNote}
      ${searchMode !== "content" ? filterBar : ""}
    </section>
    ${isManageableProvider && hasVisibleSessions ? `
    <div class="batch-bar hidden" id="batch-bar">
      <label class="batch-select-all">
        <input type="checkbox" id="select-all"> ${t("batch.select_all")}
      </label>
      <span class="batch-count">${t("batch.selected").replace("<strong>{count}</strong>", '<strong id="batch-count-num">0</strong>')}</span>
      <button class="btn batch-action" data-action="star" disabled>${t("batch.star")}</button>
      <button class="btn batch-action" data-action="unstar" disabled>${t("batch.unstar")}</button>
      <button class="btn batch-action btn-danger" data-action="delete" disabled>${t("batch.delete")}</button>
      <button class="btn batch-action" id="batch-cancel">${t("batch.cancel")}</button>
    </div>` : ""}
    <section class="session-list" id="session-list">
      ${cards}
    </section>
    ${total > offset + sessions.length ? `<button id="scroll-sentinel" class="scroll-load-more" type="button" data-offset="${offset + sessions.length}" data-total="${total}" data-range="${escapeHtml(range)}" data-project="${escapeHtml(project)}" data-query="${escapeHtml(query)}" data-mode="${escapeHtml(searchMode)}" data-sort="${escapeHtml(sort)}" data-kind="${escapeHtml(sessionKind)}" data-starred="${starredOnly ? "1" : ""}" data-provider="${provider}">${t("sessions.load_more")}</button>` : ""}
  `;

  const isContentSearch = searchMode === "content" && query;
  return layout(isContentSearch ? t("sessions.search_title").replace("{query}", query) : t("sessions.title"), body, isContentSearch ? "search" : "home", {
    provider,
    providers,
    providerAvailable: isAvailable,
    manageable: isManageableProvider,
    searchQuery: isContentSearch ? query : ""
  });
}
