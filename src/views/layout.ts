import { escapeHtml } from "../markdown.js";
import { t, getLocale } from "../i18n.js";
import { icons } from "../icons.js";

export function layout(title: string, body: string, page = "home", { provider = null, providers = [], providerAvailable = true, manageable = false, searchQuery = "" }: { provider?: string | null; providers?: { id: string; name: string; icon: string; available: boolean }[]; providerAvailable?: boolean; manageable?: boolean; searchQuery?: string } = {}) {
  const providerPrefix = provider ? `/${encodeURIComponent(provider)}` : "";
  const settingsProvider = provider || providers.find((item) => item.available !== false)?.id || "opencode";
  const currentProvider = provider ? providers.find((item) => item.id === provider) : null;
  const providerContext = currentProvider
    ? `<span class="provider-context" title="${escapeHtml(currentProvider.name)}"><span>${currentProvider.icon}</span>${escapeHtml(currentProvider.name)}</span>`
    : "";

  return `<!DOCTYPE html>
<html lang="${getLocale() === 'zh' ? 'zh-CN' : 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — AgentSession</title>
  <script>document.documentElement.dataset.theme=localStorage.theme||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light')</script>
  <link rel="stylesheet" href="/static/style.css">
  <link rel="stylesheet" href="/static/vendor/highlight.js/github.min.css">
</head>
<body data-page="${escapeHtml(page)}" data-provider="${escapeHtml(provider || "")}" data-manageable="${manageable ? "true" : "false"}">
  <nav class="topbar app-rail" aria-label="${escapeHtml(t("nav.primary_label"))}">
    <a href="/sessions" class="logo" title="AgentSession" aria-label="AgentSession">${icons.opensession}<span class="logo-text">AgentSession</span></a>
    <div class="rail-navigation">
      <a href="/sessions" class="nav-link rail-link rail-link-library ${page === "home" || page === "search" ? "active" : ""}" aria-current="${page === "home" || page === "search" ? "page" : "false"}" data-nav-shortcut="1"><span class="rail-link-icon" aria-hidden="true">▦</span><span>${escapeHtml(t("nav.library"))}</span></a>
      <a href="/stats" class="nav-link nav-link-stats ${page === "stats" ? "active" : ""} rail-link rail-link-stats" aria-current="${page === "stats" ? "page" : "false"}" data-nav-shortcut="2"><span class="rail-link-icon" aria-hidden="true">◒</span><span>${escapeHtml(t("nav.stats_rail"))}</span></a>
      <a href="/${encodeURIComponent(settingsProvider)}/settings" class="nav-link nav-link-settings rail-link rail-link-settings ${page === "settings" ? "active" : ""}" aria-current="${page === "settings" ? "page" : "false"}" title="${escapeHtml(t("nav.settings"))}" aria-label="${escapeHtml(t("nav.settings"))}" data-nav-shortcut="3"><span class="rail-link-icon" aria-hidden="true">⚙</span><span>${escapeHtml(t("nav.settings"))}</span></a>
    </div>
    <div class="rail-utility topbar-actions">
      ${providerContext}
      ${providerAvailable !== false && manageable ? `<a href="${providerPrefix}/trash" class="nav-link nav-link-trash ${page === "trash" ? "active" : ""}" title="${escapeHtml(t("nav.trash"))}" aria-label="${escapeHtml(t("nav.trash"))}">${t("nav.trash")}</a>` : ""}
      <form class="search-form" action="/sessions" method="GET" role="search" aria-label="${escapeHtml(t("nav.search_sessions_label"))}">
        <label class="search-visible-label" for="search-input">${escapeHtml(t("nav.search_all_providers_label"))}</label>
        <input type="search" name="q" value="${escapeHtml(searchQuery)}" placeholder="${t("nav.search_sessions_placeholder")}" class="search-input" id="search-input" aria-label="${escapeHtml(t("nav.search_sessions_label"))}">
      </form>
      <button id="theme-toggle" class="theme-toggle" title="Toggle theme" aria-label="Toggle theme">🌙</button>
    </div>
  </nav>
  <main class="content">
    ${body}
  </main>
  <div id="toast-container"></div>
  <script src="/static/vendor/highlight.js/highlight.min.js"></script>
  <script src="/static/app.js"></script>
</body>
</html>`;
}
