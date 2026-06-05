import { escapeHtml } from "../markdown.js";
import { layout } from "./layout.js";
import { formatTime } from "./components.js";
import { t } from "../i18n.js";

export function renderTrashPage({ sessions = [], provider = "opencode", providers = [], manageable = false }) {
  const cards = sessions.length
    ? sessions.map(s => {
        const title = s.title || s.slug || s.id;
        return `<article class="session-card trash-card">
          <div class="trash-card-content">
            <header class="session-card-header">
              <h2 class="session-card-title">${escapeHtml(title)}</h2>
              <time class="session-card-time">${escapeHtml(formatTime(s.time_updated))}</time>
            </header>
            <p class="session-card-directory">${escapeHtml(s.directory || "")}</p>
          </div>
          <div class="trash-card-actions">
            <button class="btn btn-restore" data-id="${escapeHtml(s.id)}" data-action="restore">${t("trash.restore")}</button>
            <button class="btn btn-danger" data-id="${escapeHtml(s.id)}" data-action="permanent-delete">${t("trash.permanent_delete")}</button>
          </div>
        </article>`;
      }).join("\n")
    : `<p class="empty-state">${t("trash.empty")}</p>`;

  const body = `
    <section class="page-header">
      <h1>${t("trash.title")}</h1>
      <p>${t("trash.count").replace("{count}", sessions.length)}</p>
    </section>
    <section class="session-list">
      ${cards}
    </section>
  `;

  return layout(t("trash.title"), body, "trash", { provider, providers, manageable });
}
