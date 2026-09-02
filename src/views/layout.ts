import { escapeHtml } from "../markdown.js";
import { t, getLocale } from "../i18n.js";
import { icons } from "../icons.js";

export function layout(title: string, body: string, page = "home", { provider = null, providers = [], providerAvailable = true, manageable = false, searchQuery = "" }: { provider?: string | null; providers?: { id: string; name: string; icon: string; available: boolean }[]; providerAvailable?: boolean; manageable?: boolean; searchQuery?: string } = {}) {
  const providerPrefix = provider ? `/${encodeURIComponent(provider)}` : "";
  const settingsProvider = provider || providers.find((item) => item.available !== false)?.id || null;
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
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css">
</head>
<body data-page="${escapeHtml(page)}" data-provider="${escapeHtml(provider || "")}" data-manageable="${manageable ? "true" : "false"}">
  <nav class="topbar">
    <a href="/sessions" class="logo" title="AgentSession" aria-label="AgentSession">${icons.opensession}<span class="logo-text">AgentSession</span></a>
    <div class="topbar-tabs">
      <a href="/sessions" class="nav-link ${page === "home" || page === "search" ? "active" : ""}">${escapeHtml(t("nav.sessions"))}</a>
      <a href="/stats" class="nav-link nav-link-stats ${page === "stats" ? "active" : ""}">${escapeHtml(t("nav.stats"))}</a>
    </div>
    <div class="topbar-actions">
      ${providerContext}
      ${providerAvailable !== false && manageable ? `<a href="${providerPrefix}/trash" class="nav-link nav-link-trash ${page === "trash" ? "active" : ""}" title="${escapeHtml(t("nav.trash"))}" aria-label="${escapeHtml(t("nav.trash"))}">${t("nav.trash")}</a>` : ""}
      ${settingsProvider ? `<a href="/${encodeURIComponent(settingsProvider)}/settings" class="nav-link nav-link-settings ${page === "settings" ? "active" : ""}" title="${escapeHtml(t("nav.settings"))}" aria-label="${escapeHtml(t("nav.settings"))}">${t("nav.settings")}</a>` : ""}
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
  <script src="/static/app.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
</body>
</html>`;
}
