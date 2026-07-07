import { escapeHtml } from "../markdown.js";
import { t, getLocale } from "../i18n.js";
import { icons } from "../icons.js";

export function layout(title, body, page = "home", { provider = null, providers = [], providerAvailable = true, manageable = false } = {}) {
  const providerPrefix = provider ? `/${encodeURIComponent(provider)}` : "";

  const providerTabs = providers.map((p) => {
    const isActive = p.id === provider;
    const isDisabled = p.available === false;
    const providerName = escapeHtml(p.name);
    if (isDisabled) {
      const disabledLabel = escapeHtml(`${p.name} - ${t("provider.not_detected")}`);
      return `<span class="provider-tab disabled" title="${disabledLabel}" aria-label="${disabledLabel}" aria-disabled="true">
        <span class="provider-icon">${p.icon}</span>
        <span class="provider-name">${providerName}</span>
      </span>`;
    }
    return `<a href="/${encodeURIComponent(p.id)}" class="provider-tab ${isActive ? "active" : ""}" data-provider="${escapeHtml(p.id)}" title="${providerName}" aria-label="${providerName}"${isActive ? ` aria-current="page"` : ""}>
      <span class="provider-icon">${p.icon}</span>
      <span class="provider-name">${providerName}</span>
    </a>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="${getLocale() === 'zh' ? 'zh-CN' : 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — OpenSessionViewer</title>
  <script>document.documentElement.dataset.theme=localStorage.theme||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light')</script>
  <link rel="stylesheet" href="/static/style.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css">
</head>
<body data-page="${escapeHtml(page)}" data-provider="${escapeHtml(provider || "")}" data-manageable="${manageable ? "true" : "false"}">
  <nav class="topbar">
    <a href="${providerPrefix || "/"}" class="logo" title="OpenSessionViewer" aria-label="OpenSessionViewer">${icons.opensession}<span class="logo-text">OpenSessionViewer</span></a>
    <div class="topbar-tabs">${providerTabs}</div>
    <div class="topbar-actions">
      <a href="${providerPrefix}/stats" class="nav-link ${page === "stats" ? "active" : ""}">${t("nav.stats")}</a>
      ${providerAvailable !== false && manageable ? `<a href="${providerPrefix}/trash" class="nav-link ${page === "trash" ? "active" : ""}">${t("nav.trash")}</a>` : ""}
      <a href="${providerPrefix}/settings" class="nav-link ${page === "settings" ? "active" : ""}">${t("nav.settings")}</a>
      <form class="search-form" action="${providerPrefix}/search" method="GET">
        <input type="text" name="q" placeholder="${t("nav.search_placeholder")}" class="search-input" id="search-input">
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
