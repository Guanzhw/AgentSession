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
  providers = [],
  selectedProviders = [],
  global = false
}: { sessions?: any[]; total?: number; limit?: number; offset?: number; query?: string; note?: string; range?: string; project?: string; sort?: string; starredOnly?: boolean; sessionKind?: string; projectOptions?: { id: string; label: string; count?: number; worktree?: string }[]; searchMode?: string; totalMessages?: number; deletedCount?: number; provider?: string | null; providerAvailable?: boolean; manageable?: boolean; providers?: any[]; selectedProviders?: string[]; global?: boolean } = {}) {
  const isAvailable = providerAvailable !== false;
  const isManageableProvider = isAvailable && manageable;
  const hasVisibleSessions = sessions.length > 0;
  const hasActiveFilters = Boolean(query || range || project || starredOnly || sort !== "updated-desc" || sessionKind !== "all");
  const listParams = new URLSearchParams();
  if (query) listParams.set("q", query);
  if (range) listParams.set("range", range);
  if (project) listParams.set("project", project);
  if (sort !== "updated-desc") listParams.set("sort", sort);
  if (sessionKind !== "all") listParams.set("kind", sessionKind);
  if (starredOnly) listParams.set("starred", "1");
  if (global) selectedProviders.forEach((id) => listParams.append("provider", id));
  const listBasePath = global
    ? "/sessions"
    : searchMode === "content"
      ? `/${encodeURIComponent(provider || "opencode")}/search`
      : `/${encodeURIComponent(provider || "opencode")}`;
  const listPath = `${listBasePath}${listParams.size ? `?${listParams.toString()}` : ""}`;
  const providerNames = new Map(providers.map((item: any) => [item.id, item.name || item.id]));
  const cards = !isAvailable
    ? `<p class="empty-state">${t("provider.not_detected")}</p>`
  : sessions.length
    ? sessions.map((session) => sessionCard(session, false, { showCheckbox: !global, provider: provider || session.provider, manageable: isManageableProvider, showProvider: global, providerName: providerNames.get(session.provider || provider) || "", returnTo: listPath })).join("\n")
    : hasActiveFilters
      ? `<p class="empty-state">${query ? t("sessions.empty_search").replace("{query}", escapeHtml(query)) : t("sessions.empty_filter")}</p>`
      : `<p class="empty-state">${t("sessions.empty")}</p>`;

  const searchNote = note ? `<p class="search-note">${escapeHtml(note)}</p>` : "";

  const shortProjectLabel = (value: any, id: any = "") => {
    if (String(id) === "global") return t("filter.global_project");
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
      const label = `${shortProjectLabel(item.label, item.id)} (${Number(item.count) || 0})`;
      return `<option value="${escapeHtml(optionValue)}" ${optionValue === String(project) ? "selected" : ""} title="${escapeHtml(item.worktree || item.label || "")}">${escapeHtml(label)}</option>`;
    })
  ].join("");
  const filterAction = global ? "/sessions" : `/${provider}`;
  const providerSelector = global ? `<fieldset class="provider-filter" aria-label="${escapeHtml(t("filter.providers"))}">
    <legend>${escapeHtml(t("filter.providers"))}</legend>
    ${providers.map((item: any) => `<label class="provider-filter-option${item.available === false ? " disabled" : ""}">
      <input type="checkbox" name="provider" value="${escapeHtml(item.id)}" ${selectedProviders.includes(item.id) ? "checked" : ""} ${item.available === false ? "disabled" : ""}>
      <span>${item.icon || ""} ${escapeHtml(item.name || item.id)}</span>
    </label>`).join("")}
  </fieldset>` : "";
  const filterBar = isAvailable ? `<form class="session-filter" action="${filterAction}" method="GET">
    ${providerSelector}
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
      ${hasActiveFilters || (global && selectedProviders.length !== providers.filter((item: any) => item.available !== false).length) ? `<a class="btn btn-secondary" href="${filterAction}">${t("filter.clear")}</a>` : ""}
    </div>
  </form>` : "";
  const dashboard = `
    <section class="provider-summary">
      <span>${t("sessions.provider_summary").replace("{total}", String(total)).replace("{messages}", String(totalMessages))}</span>
      ${isManageableProvider ? `<span>${t("sessions.provider_summary_trash").replace("{count}", String(deletedCount))}</span>` : ""}
      <a href="${escapeHtml(global ? `/stats${selectedProviders.length ? `?${selectedProviders.map((id) => `provider=${encodeURIComponent(id)}`).join("&")}` : ""}` : `/${provider}/stats`)}">${t("nav.stats")} →</a>
      ${isManageableProvider ? `<a href="/${provider}/trash">${t("nav.trash")} →</a>` : ""}
    </section>
  `;

  const body = `
    ${!hasActiveFilters && isAvailable ? dashboard : ""}
    <section class="page-header">
      <div class="page-header-row">
        <div>
          ${searchMode === "content" && query ? `<a class="back-to-filter" href="${filterAction}">${t("sessions.back_to_filter")}</a>` : ""}
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
    ${total > offset + sessions.length ? `<button id="scroll-sentinel" class="scroll-load-more" type="button" data-offset="${offset + sessions.length}" data-total="${total}" data-range="${escapeHtml(range)}" data-project="${escapeHtml(project)}" data-query="${escapeHtml(query)}" data-mode="${escapeHtml(searchMode)}" data-sort="${escapeHtml(sort)}" data-kind="${escapeHtml(sessionKind)}" data-starred="${starredOnly ? "1" : ""}" data-provider="${escapeHtml(provider || "")}" data-providers="${escapeHtml(selectedProviders.join(","))}" data-provider-names="${escapeHtml(JSON.stringify(Object.fromEntries(providerNames)))}" data-return-to="${escapeHtml(listPath)}" data-global="${global ? "true" : "false"}">${t("sessions.load_more")}</button>` : ""}
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
