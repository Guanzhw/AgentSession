import { escapeHtml } from "../markdown.js";
import { layout } from "./layout.js";
import { formatCompactCount, sessionCard, sessionDayLabel } from "./components.js";
import { t } from "../i18n.js";
import { projectFilterValue } from "../project-filter.js";

function dayKey(ts: any) {
  const value = Number(ts) || 0;
  if (!value) return "";
  const date = new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

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
  hasSubagent = false,
  projectOptions = [],
  searchMode = "list",
  totalMessages = 0,
  totalTokens = 0,
  deletedCount = 0,
  provider = "opencode",
  providerAvailable = true,
  manageable = false,
  providers = [],
  selectedProviders = [],
  global = false,
  storageDiagnostic = null
}: { sessions?: any[]; total?: number; limit?: number; offset?: number; query?: string; note?: string; range?: string; project?: string; sort?: string; starredOnly?: boolean; hasSubagent?: boolean; projectOptions?: { id: string; label: string; count?: number; worktree?: string }[]; searchMode?: string; totalMessages?: number; totalTokens?: number; deletedCount?: number; provider?: string | null; providerAvailable?: boolean; manageable?: boolean; providers?: any[]; selectedProviders?: string[]; global?: boolean; storageDiagnostic?: any } = {}) {
  const isAvailable = global
    ? providers.some((item: any) => item.available !== false)
    : providerAvailable !== false;
  const isManageableProvider = isAvailable && manageable;
  const hasVisibleSessions = sessions.length > 0;
  const hasActiveFilters = Boolean(query || range || project || starredOnly || hasSubagent || sort !== "updated-desc");
  const activeProviders = selectedProviders.length ? selectedProviders : (global ? providers.filter((item: any) => item.available !== false).map((item: any) => item.id) : [provider || "opencode"]);
  const providerCount = activeProviders.length;

  const rawParams = new URLSearchParams();
  if (query) rawParams.set("q", query);
  if (range) rawParams.set("range", range);
  if (project) rawParams.set("project", project);
  if (sort !== "updated-desc") rawParams.set("sort", sort);
  if (starredOnly) rawParams.set("starred", "1");
  if (hasSubagent) rawParams.set("has-subagent", "1");
  if (global) selectedProviders.forEach((id) => rawParams.append("provider", id));

  const listBasePath = global
    ? "/sessions"
    : searchMode === "content"
      ? `/${encodeURIComponent(provider || "opencode")}/search`
      : `/${encodeURIComponent(provider || "opencode")}`;
  const listPath = `${listBasePath}${rawParams.size ? `?${rawParams.toString()}` : ""}`;

  const settingsProvider = provider || providers.find((item: any) => item.available !== false)?.id || "opencode";
  const settingsHref = `/${encodeURIComponent(settingsProvider)}/settings`;
  const providerNames = new Map(providers.map((item: any) => [item.id, item.name || item.id]));
  const providerManageable = new Map(providers.map((item: any) => [item.id, Boolean(item.manageable)]));

  // ── Filter URL helpers (chips round-trip through GET URLs) ────────────────
  function withParam(params: URLSearchParams, key: string, value: string) {
    const next = new URLSearchParams(params);
    next.delete(key);
    next.delete("offset");
    if (value) next.set(key, value);
    return `${listBasePath}${next.size ? `?${next.toString()}` : ""}`;
  }

  function hiddenParams(params: URLSearchParams, include: string[]) {
    const parts: string[] = [];
    for (const name of include) {
      for (const value of params.getAll(name)) {
        if (name === "provider" && value === "") continue;
        parts.push(`<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`);
      }
    }
    return parts.join("");
  }

  // ── Summary strip: provider · session · message · token totals ───────────
  const summaryParts = [
    { count: providerCount, value: formatCompactCount(providerCount), label: t(providerCount === 1 ? "library.summary_providers_one" : "library.summary_providers") },
    { count: Number(total) || 0, value: formatCompactCount(total), label: t(Number(total) === 1 ? "library.summary_sessions_one" : "library.summary_sessions") },
    { count: Number(totalMessages) || 0, value: formatCompactCount(totalMessages), label: t(Number(totalMessages) === 1 ? "library.summary_messages_one" : "library.summary_messages") },
    { count: Number(totalTokens) || 0, value: formatCompactCount(totalTokens), label: t(Number(totalTokens) === 1 ? "library.summary_tokens_one" : "library.summary_tokens") }
  ];
  const summaryStrip = `
    <p class="library-summary">
      ${summaryParts.map((part) => `<span class="library-summary-part"><strong>${escapeHtml(part.value)}</strong> ${escapeHtml(part.label)}</span>`).join('<span class="library-summary-sep" aria-hidden="true">·</span>')}
    </p>`;

  // ── Primary search across providers ───────────────────────────────────────
  const searchBar = `
    <form class="library-search" action="${listBasePath}" method="GET" role="search" aria-label="${escapeHtml(t("library.search_label"))}">
      ${hiddenParams(rawParams, global ? ["provider", "range", "project", "sort", "starred", "has-subagent"] : ["range", "project", "sort", "starred", "has-subagent"])}
      <input type="search" id="library-search-input" name="q" class="library-search-input" value="${escapeHtml(query)}" placeholder="${escapeHtml(t("library.search_placeholder"))}" aria-label="${escapeHtml(t("library.search_label"))}">
      <button type="submit" class="btn library-search-submit">${escapeHtml(t("library.search_action"))}</button>
    </form>`;

  // ── Quick filter chips: today / this week / starred / has-subagent ────────
  const chipDefs = [
    { key: "range", value: "today", active: range === "today", label: t("range.today") },
    { key: "range", value: "week", active: range === "week", label: t("range.week") },
    { key: "starred", value: "1", active: starredOnly, label: t("library.chip_starred") },
    { key: "has-subagent", value: "1", active: hasSubagent, label: t("library.chip_has_subagent") }
  ];
  const chips = chipDefs.map((chip) => `
    <a class="filter-chip${chip.active ? " is-active" : ""}" href="${escapeHtml(withParam(rawParams, chip.key, chip.active ? "" : chip.value))}" aria-current="${chip.active ? "true" : "false"}" data-chip="${escapeHtml(chip.key)}">
      ${escapeHtml(chip.label)}
    </a>`).join("");
  const chipsBar = `
    <nav class="library-chips" aria-label="${escapeHtml(t("library.chips_label"))}">
      ${chips}
    </nav>`;

  // ── View toggle (timeline by default; compact persisted in localStorage) ──
  const viewToggle = `
    <div class="library-view-toggle" role="group" aria-label="${escapeHtml(t("library.view_label"))}">
      <button type="button" data-view="timeline" aria-pressed="true">${escapeHtml(t("library.view_timeline"))}</button>
      <button type="button" data-view="compact" aria-pressed="false">${escapeHtml(t("library.view_compact"))}</button>
    </div>`;

  // ── Advanced filters (provider multi-select, project, range, sort) ────────
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
      <input type="checkbox" name="provider" value="${escapeHtml(item.id)}" data-session-filter-auto ${selectedProviders.includes(item.id) ? "checked" : ""} ${item.available === false ? "disabled" : ""}>
      <span>${item.icon || ""} ${escapeHtml(item.name || item.id)}</span>
    </label>`).join("")}
  </fieldset>` : "";
  const advancedFilters = isAvailable ? `<details class="library-advanced" id="advanced-filters">
    <summary>${escapeHtml(t("library.advanced_label"))}</summary>
    <form class="session-filter" data-session-filter action="${filterAction}" method="GET">
      ${providerSelector}
      ${starredOnly ? '<input type="hidden" name="starred" value="1">' : ""}
      ${hasSubagent ? '<input type="hidden" name="has-subagent" value="1">' : ""}
      <label class="filter-field">
        <span>${t("filter.project")}</span>
        <select name="project" data-session-filter-auto>${projectSelectOptions}</select>
      </label>
      <label class="filter-field">
        <span>${t("filter.time")}</span>
        <select name="range" data-session-filter-auto>${rangeOptions}</select>
      </label>
      <label class="filter-field">
        <span>${t("filter.sort")}</span>
        <select name="sort" data-session-filter-auto>${sortOptions}</select>
      </label>
      <div class="filter-actions">
        <label class="filter-field filter-keyword">
          <span>${t("filter.keyword")}</span>
          <input type="search" name="q" value="${escapeHtml(query)}" placeholder="${t("filter.keyword_placeholder")}">
        </label>
        <button class="btn" type="submit">${t("filter.apply")}</button>
        ${hasActiveFilters || (global && selectedProviders.length !== providers.filter((item: any) => item.available !== false).length) ? `<a class="btn btn-secondary" href="${filterAction}">${t("filter.clear")}</a>` : ""}
      </div>
    </form>
  </details>` : "";

  // ── Storage diagnostics and search notes (pinned, non-blocking) ───────────
  const storageDiagnosticText = (diagnostic: any) => {
    if (typeof diagnostic === "string") return diagnostic;
    if (!diagnostic || typeof diagnostic !== "object") return "";
    if (typeof diagnostic.message === "string") return diagnostic.message;
    if (typeof diagnostic.code === "string") return diagnostic.code;
    return "";
  };
  const storageNotices = global
    ? providers
      .filter((item: any) => item.storageDiagnostic)
      .map((item: any) => {
        const detail = storageDiagnosticText(item.storageDiagnostic);
        return `<p class="search-note settings-status-warn" data-storage-diagnostic="${escapeHtml(String(item.storageDiagnostic?.code || "storage"))}"><strong>${escapeHtml(item.name || item.id)} · ${escapeHtml(t("sessions.storage_diagnostic"))}</strong>${detail ? `: ${escapeHtml(detail)}` : ""}</p>`;
      })
      .join("")
    : storageDiagnostic
      ? (() => {
        const detail = storageDiagnosticText(storageDiagnostic);
        return `<p class="search-note settings-status-warn" data-storage-diagnostic="${escapeHtml(String(storageDiagnostic?.code || "storage"))}"><strong>${escapeHtml(t("sessions.storage_diagnostic"))}</strong>${detail ? `: ${escapeHtml(detail)}` : ""}</p>`;
      })()
      : "";
  const searchNote = note ? `<p class="search-note">${escapeHtml(note)}</p>` : "";

  // ── Distinct empty states ─────────────────────────────────────────────────
  function emptyStateBlock(kind: string, title: string, body: string, actionHref: string, actionLabel: string) {
    return `<section class="library-empty" data-empty="${escapeHtml(kind)}" role="status">
      <h2>${escapeHtml(title)}</h2>
      <p>${body}</p>
      <a class="btn" href="${escapeHtml(actionHref)}">${escapeHtml(actionLabel)}</a>
    </section>`;
  }

  const anyAvailable = providers.some((item: any) => item.available !== false);
  const emptyState = !isAvailable || (global && !anyAvailable)
    ? emptyStateBlock(
      "unavailable",
      t("library.unavailable_title"),
      note ? escapeHtml(note) : escapeHtml(t("library.unavailable_body")),
      settingsHref,
      t("library.unavailable_action")
    )
    : hasVisibleSessions
      ? ""
      : hasActiveFilters
        ? emptyStateBlock(
          "no-results",
          t("library.no_results_title"),
          query ? t("library.no_results_query").replace("{query}", escapeHtml(query)) : escapeHtml(t("library.no_results_body")),
          filterAction,
          t("library.no_results_action")
        )
        : emptyStateBlock(
          "empty",
          t("library.empty_title"),
          escapeHtml(t("library.empty_body")),
          settingsHref,
          t("library.empty_action")
        );

  // ── Timeline: sessions grouped by local day (default) ─────────────────────
  const cards = sessions.map((session) => sessionCard(session, false, {
    showCheckbox: global ? providerManageable.get(session.provider || "") === true : isManageableProvider,
    provider: provider || session.provider,
    manageable: global ? providerManageable.get(session.provider || "") === true : isManageableProvider,
    showProvider: true,
    providerName: providerNames.get(session.provider || provider) || "",
    returnTo: listPath
  }));
  const dayGroups: { key: string; label: string; items: string[] }[] = [];
  const dayIndex = new Map<string, number>();
  const cardIterator = cards[Symbol.iterator]();
  for (const session of sessions) {
    const key = dayKey(session.time_updated) || "unknown";
    const index = dayIndex.get(key);
    const label = key === "unknown"
      ? t("timeline.unknown")
      : sessionDayLabel(key);
    if (index === undefined) {
      dayIndex.set(key, dayGroups.length);
      dayGroups.push({ key, label, items: [] });
    }
    dayGroups[dayIndex.get(key) as number].items.push(cardIterator.next().value || "");
  }
  const timelineHtml = dayGroups.map((group) => `
    <section class="library-day" data-day="${escapeHtml(group.key)}">
      <header class="library-day-heading">
        <h2>${escapeHtml(group.label)}</h2>
        <span>${escapeHtml(t(group.items.length === 1 ? "timeline.count_one" : "timeline.count").replace("{count}", String(group.items.length)))}</span>
      </header>
      ${group.items.join("\n")}
    </section>`).join("\n");

  const listMarkup = hasVisibleSessions ? timelineHtml : emptyState;

  const providerStatsPath = global
    ? `/stats${activeProviders.length ? `?${activeProviders.map((id) => `provider=${encodeURIComponent(id)}`).join("&")}` : ""}`
    : `/${encodeURIComponent(provider || "opencode")}/stats`;
  const headerLinks = `
      <div class="page-header-actions">
        <a class="page-header-link" href="${escapeHtml(providerStatsPath)}" title="${escapeHtml(t("nav.stats"))}">${escapeHtml(t("nav.stats"))} →</a>
        ${isManageableProvider && !global ? `<a class="page-header-link" href="/${encodeURIComponent(provider || "opencode")}/trash" title="${escapeHtml(t("nav.trash"))}">${escapeHtml(t("nav.trash"))} →</a>` : ""}
        ${searchMode !== "content" && showBatchControls() && hasVisibleSessions ? `<button class="btn btn-manage" id="toggle-batch">${t("sessions.manage")}</button>` : ""}
      </div>`;

  const body = `
    ${searchMode === "content" && query ? `<a class="back-to-filter" href="${filterAction}">${t("sessions.back_to_filter")}</a>` : ""}
    <section class="page-header">
      <div class="page-header-row">
        <div>
          <h1>${searchMode === "content" && query ? t("sessions.search_title").replace("{query}", escapeHtml(query)) : t("sessions.title")}</h1>
          <p>${t("sessions.count").replace("{count}", String(total))}</p>
        </div>
        ${headerLinks}
      </div>
      ${searchNote}${storageNotices}
    </section>
    ${searchMode !== "content" ? `${summaryStrip}${searchBar}
    <div class="library-toolbar">
      ${chipsBar}
      ${viewToggle}
    </div>
    ${advancedFilters}` : searchBar}
    ${showBatchBar() ? `
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
    <section class="session-list session-list-library" id="session-list" data-view="timeline">
      ${listMarkup}
    </section>
    ${total > offset + sessions.length ? `<button id="scroll-sentinel" class="scroll-load-more" type="button" data-offset="${offset + sessions.length}" data-total="${total}" data-range="${escapeHtml(range)}" data-project="${escapeHtml(project)}" data-query="${escapeHtml(query)}" data-mode="${escapeHtml(searchMode)}" data-sort="${escapeHtml(sort)}" data-starred="${starredOnly ? "1" : ""}" data-has-subagent="${hasSubagent ? "1" : ""}" data-provider="${escapeHtml(provider || "")}" data-providers="${escapeHtml(selectedProviders.join(","))}" data-provider-names="${escapeHtml(JSON.stringify(Object.fromEntries(providerNames)))}" data-return-to="${escapeHtml(listPath)}" data-global="${global ? "true" : "false"}">${t("sessions.load_more")}</button>` : ""}
  `;

  function showBatchControls() {
    return isAvailable && (global ? providers.some((item: any) => item.available !== false && item.manageable) : isManageableProvider);
  }
  function showBatchBar() {
    return showBatchControls() && hasVisibleSessions;
  }

  const isContentSearch = searchMode === "content" && query;
  return layout(isContentSearch ? t("sessions.search_title").replace("{query}", query) : t("sessions.title"), body, isContentSearch ? "search" : "home", {
    provider,
    providers,
    providerAvailable: isAvailable,
    manageable: isManageableProvider,
    searchQuery: isContentSearch ? query : ""
  });
}
