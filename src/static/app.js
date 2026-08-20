import { initSessionWorkbench } from "./app/session-workbench.js";
import { initEnhancements } from "./app/enhancements.js";
import { initRuntimeWorkbench } from "./app/runtime-workbench.js";
import { ft, formatText } from "./app/i18n.js";
const PROVIDER = document.body.dataset.provider || "opencode";
const IS_MANAGEABLE_PROVIDER = document.body.dataset.manageable === "true";
import { initSettingsForm } from "./app/settings-form.js";
const themeToggle = document.getElementById('theme-toggle');
if (themeToggle) {
  function updateToggleIcon() {
    const isDark = document.documentElement.dataset.theme === 'dark';
    const label = isDark ? ft("theme_to_light") : ft("theme_to_dark");
    themeToggle.textContent = isDark ? '☀️' : '🌙';
    themeToggle.setAttribute("aria-label", label);
    themeToggle.setAttribute("title", label);
  }
  updateToggleIcon();
  themeToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.theme = next;
    updateToggleIcon();
  });
}

// Toast notifications
function showToast(message, type = "success") {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// Show pending toast from previous page (survives reload)
try {
  const pending = sessionStorage.getItem("pendingToast");
  if (pending) {
    sessionStorage.removeItem("pendingToast");
    const { message, type } = JSON.parse(pending);
    showToast(message, type);
  }
} catch {}

function queueToast(message, type = "success") {
  sessionStorage.setItem("pendingToast", JSON.stringify({ message, type }));
}

function focusableDialogElements(dialog) {
  return [...dialog.querySelectorAll("button, input, select, textarea, [href], [tabindex]:not([tabindex='-1'])")]
    .filter((element) => element instanceof HTMLElement && !element.disabled);
}

function trapDialogFocus(dialog, event) {
  if (event.key !== "Tab") {
    return;
  }
  const focusable = focusableDialogElements(dialog);
  if (!focusable.length) {
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!dialog.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
    return;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openRenameDialog(currentTitle = "", restoreFocusTarget = null) {
  return new Promise((resolve) => {
    const previousActive = restoreFocusTarget instanceof HTMLElement
      ? restoreFocusTarget
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const backdrop = document.createElement("div");
    backdrop.className = "rename-dialog-backdrop";

    const dialog = document.createElement("form");
    dialog.className = "rename-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "rename-dialog-title");

    const title = document.createElement("h2");
    title.id = "rename-dialog-title";
    title.textContent = ft("rename_title");

    const label = document.createElement("label");
    label.className = "rename-dialog-field";
    label.textContent = ft("rename_label");

    const input = document.createElement("input");
    input.type = "text";
    input.value = currentTitle || "";
    label.appendChild(input);

    const actions = document.createElement("div");
    actions.className = "rename-dialog-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-secondary";
    cancel.textContent = ft("rename_cancel");

    const save = document.createElement("button");
    save.type = "submit";
    save.className = "btn";
    save.textContent = ft("rename_save");

    actions.append(cancel, save);
    dialog.append(title, label, actions);
    backdrop.appendChild(dialog);

    const close = (value) => {
      document.removeEventListener("keydown", onKeydown, true);
      backdrop.remove();
      previousActive?.focus?.();
      resolve(value);
    };
    const onKeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(null);
        return;
      }
      trapDialogFocus(dialog, event);
    };

    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        close(null);
      }
    });
    cancel.addEventListener("click", () => close(null));
    dialog.addEventListener("submit", (event) => {
      event.preventDefault();
      close(input.value);
    });
    document.addEventListener("keydown", onKeydown, true);

    document.body.appendChild(backdrop);
    input.focus();
    input.select();
  });
}

function openConfirmDialog(message, {
  confirmLabel = ft("confirm_accept"),
  cancelLabel = ft("confirm_cancel"),
  title = ft("confirm_title"),
  danger = false,
  restoreFocusTarget = null
} = {}) {
  return new Promise((resolve) => {
    const previousActive = restoreFocusTarget instanceof HTMLElement
      ? restoreFocusTarget
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const backdrop = document.createElement("div");
    backdrop.className = "confirm-dialog-backdrop";

    const dialog = document.createElement("form");
    dialog.className = "confirm-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "confirm-dialog-title");
    dialog.setAttribute("aria-describedby", "confirm-dialog-message");

    const heading = document.createElement("h2");
    heading.id = "confirm-dialog-title";
    heading.textContent = title;

    const body = document.createElement("p");
    body.id = "confirm-dialog-message";
    body.className = "confirm-dialog-message";
    body.textContent = message || "";

    const actions = document.createElement("div");
    actions.className = "confirm-dialog-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-secondary";
    cancel.textContent = cancelLabel;

    const confirm = document.createElement("button");
    confirm.type = "submit";
    confirm.className = danger ? "btn btn-danger" : "btn";
    confirm.textContent = confirmLabel;

    actions.append(cancel, confirm);
    dialog.append(heading, body, actions);
    backdrop.appendChild(dialog);

    const close = (value) => {
      document.removeEventListener("keydown", onKeydown, true);
      backdrop.remove();
      previousActive?.focus?.();
      resolve(value);
    };
    const onKeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(false);
        return;
      }
      trapDialogFocus(dialog, event);
    };

    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        close(false);
      }
    });
    cancel.addEventListener("click", () => close(false));
    dialog.addEventListener("submit", (event) => {
      event.preventDefault();
      close(true);
    });
    document.addEventListener("keydown", onKeydown, true);

    document.body.appendChild(backdrop);
    cancel.focus();
  });
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

initSettingsForm({ ft, formatText, showToast });
function isEditableShortcutTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName;
  return tagName === "INPUT"
    || tagName === "TEXTAREA"
    || tagName === "SELECT"
    || target.isContentEditable;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditableShortcutTarget(e.target)) {
    e.preventDefault();
    const transcriptSearch = document.querySelector("[data-session-search]");
    if (transcriptSearch) {
      transcriptSearch.open = true;
      transcriptSearch.querySelector("[data-session-search-input]")?.focus();
    } else {
      document.getElementById("search-input")?.focus();
    }
  }
  if (e.key === "Escape") {
    const transcriptSearch = document.querySelector("[data-session-search]");
    if (transcriptSearch?.open) transcriptSearch.open = false;
    document.activeElement.blur();
  }
});

if (typeof hljs !== "undefined") {
  hljs.highlightAll();
}

const activeSidebarCard = document.querySelector(".sidebar .session-card.active");
if (activeSidebarCard) {
  activeSidebarCard.scrollIntoView({ block: "center", behavior: "instant" });
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".star-btn");
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const id = btn.dataset.id;
  if (!id) return;
  try {
    const res = await fetch(`/api/${PROVIDER}/session/${encodeURIComponent(id)}/star`, { method: "POST" });
    const data = await res.json();
    btn.classList.toggle("starred", data.starred);
    const label = data.starred ? ft("starred_label") : ft("star_label");
    btn.textContent = btn.dataset.starFormat === "icon" ? (data.starred ? "★" : "☆") : label;
    btn.setAttribute("aria-label", label);
    btn.title = label;
    const card = btn.closest(".session-card");
    if (card) card.classList.toggle("starred", data.starred);
    showToast(data.starred ? ft("toast_starred") : ft("toast_unstarred"), data.starred ? "success" : "info");
  } catch (err) {
    showToast(ft("toast_error"), "error");
  }
});

// Progressive expansion: fetch one bounded, server-rendered continuation
// chunk at a time. The initial page never carries the hidden remainder.
document.addEventListener("click", async (e) => {
  const button = e.target.closest(".progressive-more");
  if (!button) return;
  e.preventDefault();
  const container = button.closest(".progressive");
  const workbench = button.closest(".session-workbench");
  if (!container || !workbench || button.disabled) return;
  const provider = workbench.dataset.provider;
  const sessionId = workbench.dataset.sessionId;
  const partId = button.dataset.partId;
  const field = button.dataset.field;
  const offset = button.dataset.nextOffset;
  if (!provider || !sessionId || !partId || !field || offset == null) return;

  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const query = new URLSearchParams({ part: partId, field, offset });
    const response = await fetch(`/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}/content?${query}`);
    const data = await response.json();
    if (!response.ok || !data?.ok || typeof data.html !== "string") {
      throw new Error(data?.error || `HTTP ${response.status}`);
    }
    const chunk = document.createElement("div");
    chunk.className = "progressive-chunk";
    chunk.innerHTML = data.html;
    container.insertBefore(chunk, button);
    if (data.nextOffset == null) {
      button.remove();
    } else {
      button.dataset.nextOffset = String(data.nextOffset);
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  } catch (error) {
    console.error("Unable to load progressive content:", error);
    button.disabled = false;
    button.removeAttribute("aria-busy");
    showToast(button.dataset.loadError || "Unable to load more content", "error");
  }
});

document.addEventListener("click", (e) => {
  const trigger = e.target.closest(".card-menu-trigger");
  if (trigger) {
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll(".card-menu:not(.hidden)").forEach((menu) => {
      if (menu.dataset.id !== trigger.dataset.id) menu.classList.add("hidden");
    });
    const menu = trigger.nextElementSibling;
    if (menu) menu.classList.toggle("hidden");
    return;
  }
  if (!e.target.closest(".card-menu")) {
    document.querySelectorAll(".card-menu:not(.hidden)").forEach((menu) => {
      menu.classList.add("hidden");
    });
  }
});

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  if (!action) return;

  if (action === "copy-resume-command") {
    const command = btn.dataset.command || "";
    if (!command) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      await copyText(command);
      showToast(ft("copied"), "success");
    } catch {
      showToast(ft("toast_error"), "error");
    }
    return;
  }

  const id = btn.dataset.id;
  if (!id) return;

  if (btn.classList.contains("batch-action")) return;

  e.preventDefault();
  e.stopPropagation();

  if (action === "copy-session-id") {
    try {
      await copyText(id);
      showToast(ft("copied"), "success");
    } catch {
      showToast(ft("toast_error"), "error");
    }
    return;
  }

  if (action === "resume-session") {
    try {
      const res = await fetch(`/api/${PROVIDER}/session/${encodeURIComponent(id)}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      showToast(ft("resume_opened"), "success");
    } catch {
      showToast(ft("resume_disabled"), "error");
    }
    return;
  }

  if (action === "rename") {
    const card = btn.closest(".session-card");
    const restoreFocusTarget = card?.querySelector(".card-menu-trigger") || btn;
    document.querySelectorAll(".card-menu:not(.hidden)").forEach((menu) => {
      menu.classList.add("hidden");
    });
    const current = card
      ? card.querySelector(".session-card-title")?.textContent || ""
      : document.querySelector(".session-header h1")?.textContent || "";
    const newTitle = await openRenameDialog(current, restoreFocusTarget);
    if (newTitle === null) return;
    try {
      await fetch(`/api/${PROVIDER}/session/${encodeURIComponent(id)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle })
      });
      queueToast(ft("toast_renamed"), "success");
      location.reload();
    } catch {
      showToast(ft("toast_error"), "error");
    }
    return;
  }

  if (action === "delete") {
    const card = btn.closest(".session-card");
    const restoreFocusTarget = card?.querySelector(".card-menu-trigger") || btn;
    document.querySelectorAll(".card-menu:not(.hidden)").forEach((menu) => {
      menu.classList.add("hidden");
    });
    const confirmed = await openConfirmDialog(ft("delete_confirm"), {
      confirmLabel: ft("confirm_delete"),
      danger: true,
      restoreFocusTarget
    });
    if (!confirmed) return;
    try {
      await fetch(`/api/${PROVIDER}/session/${encodeURIComponent(id)}/delete`, { method: "POST" });
      queueToast(ft("toast_deleted"), "success");
      if (document.querySelector(".session-actions")) {
        location.href = `/${PROVIDER}`;
      } else {
        location.reload();
      }
    } catch {
      showToast(ft("toast_error"), "error");
    }
    return;
  }

  if (action === "restore") {
    try {
      await fetch(`/api/${PROVIDER}/session/${encodeURIComponent(id)}/restore`, { method: "POST" });
      queueToast(ft("toast_restored"), "success");
      location.reload();
    } catch {
      showToast(ft("toast_error"), "error");
    }
    return;
  }

  if (action === "permanent-delete") {
    const confirmed = await openConfirmDialog(ft("permanent_delete_confirm"), {
      confirmLabel: ft("confirm_permanent_delete"),
      danger: true,
      restoreFocusTarget: btn
    });
    if (!confirmed) return;
    try {
      await fetch(`/api/${PROVIDER}/session/${encodeURIComponent(id)}/permanent-delete`, { method: "POST" });
      queueToast(ft("toast_permanent_deleted"), "success");
      location.reload();
    } catch {
      showToast(ft("toast_error"), "error");
    }
    return;
  }

});

// List controls apply immediately, while the keyword field remains explicit:
// Enter or Apply commits it. This keeps an unfinished search out of an
// automatic provider/project/sort update.
(function initSessionFilterAutoApply() {
  const filter = document.querySelector("[data-session-filter]");
  if (!filter) return;

  const keyword = filter.querySelector("input[name='q']");
  filter.addEventListener("change", (event) => {
    const control = event.target;
    if (!control?.matches?.("[data-session-filter-auto]")) return;

    const params = new URLSearchParams();
    for (const [name, value] of new FormData(filter).entries()) {
      if (name !== "q") params.append(name, String(value));
    }

    const appliedKeyword = keyword?.defaultValue || "";
    if (appliedKeyword) params.set("q", appliedKeyword);

    const destination = new URL(filter.action, window.location.origin);
    destination.search = params.toString();
    window.location.assign(`${destination.pathname}${destination.search}${destination.hash}`);
  });
})();

const toggleBatchBtn = document.getElementById("toggle-batch");
const batchBar = document.getElementById("batch-bar");
const sessionList = document.getElementById("session-list");
const batchCountNum = document.getElementById("batch-count-num");
const selectAllCheckbox = document.getElementById("select-all");
const batchCancelBtn = document.getElementById("batch-cancel");

let batchMode = false;

function updateBatchCount() {
  const checkboxes = [...document.querySelectorAll(".card-checkbox")];
  const checked = document.querySelectorAll(".card-checkbox:checked").length;
  if (batchCountNum) batchCountNum.textContent = checked;
  if (selectAllCheckbox) {
    selectAllCheckbox.checked = checkboxes.length > 0 && checked === checkboxes.length;
    selectAllCheckbox.indeterminate = checked > 0 && checked < checkboxes.length;
  }
  document.querySelectorAll(".batch-action[data-action]").forEach((btn) => {
    btn.disabled = checked === 0;
  });
}

function setBatchMode(on) {
  batchMode = on;
  if (batchBar) batchBar.classList.toggle("hidden", !on);
  if (sessionList) sessionList.classList.toggle("batch-mode", on);
  if (toggleBatchBtn) toggleBatchBtn.textContent = on ? ft("cancel_manage") : ft("manage");
  if (!on) {
    document.querySelectorAll(".card-checkbox:checked").forEach((cb) => {
      cb.checked = false;
    });
  }
  updateBatchCount();
}

if (toggleBatchBtn) {
  toggleBatchBtn.addEventListener("click", () => setBatchMode(!batchMode));
}

if (batchCancelBtn) {
  batchCancelBtn.addEventListener("click", () => setBatchMode(false));
}

if (selectAllCheckbox) {
  selectAllCheckbox.addEventListener("change", () => {
    document.querySelectorAll(".card-checkbox").forEach((cb) => {
      cb.checked = selectAllCheckbox.checked;
    });
    updateBatchCount();
  });
}

document.addEventListener("change", (e) => {
  if (e.target.classList.contains("card-checkbox")) updateBatchCount();
});

document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".batch-action");
  if (!btn || btn.id === "batch-cancel") return;
  const action = btn.dataset.action;
  if (!action) return;
  const ids = [...document.querySelectorAll(".card-checkbox:checked")].map((cb) => cb.dataset.id);
  if (!ids.length) {
    showToast(ft("select_first"), "error");
    return;
  }
  if (action === "delete") {
    const confirmed = await openConfirmDialog(ft("batch_delete_confirm").replace("{count}", ids.length), {
      confirmLabel: ft("confirm_delete"),
      danger: true,
      restoreFocusTarget: btn
    });
    if (!confirmed) return;
  }

  try {
    await fetch(`/api/${PROVIDER}/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ids })
    });
    queueToast(ft("toast_batch_done").replace("{count}", ids.length), "success");
    location.reload();
  } catch {
    showToast(ft("toast_error"), "error");
  }
});

function formatTimeClient(ts) {
  const value = Number(ts);
  if (!value) {
    return "";
  }

  const diff = Date.now() - value;
  if (diff < 60_000) return ft("time_just_now");
  if (diff < 3_600_000) return ft("time_minutes_ago").replace("{n}", Math.floor(diff / 60_000));
  if (diff < 86_400_000) return ft("time_hours_ago").replace("{n}", Math.floor(diff / 3_600_000));
  if (diff < 7 * 86_400_000) return ft("time_days_ago").replace("{n}", Math.floor(diff / 86_400_000));
  return new Date(value).toLocaleDateString();
}

function escapeHtmlClient(str) {
  const el = document.createElement("div");
  el.textContent = str == null ? "" : String(str);
  return el.innerHTML;
}

function formatCompactCountClient(value) {
  const amount = Number(value) || 0;
  if (Math.abs(amount) >= 1_000_000) {
    return `${(amount / 1_000_000).toFixed(amount >= 10_000_000 ? 0 : 1)}m`;
  }
  if (Math.abs(amount) >= 1_000) {
    return `${(amount / 1_000).toFixed(amount >= 10_000 ? 0 : 1)}k`;
  }
  return String(amount);
}

function formatDurationClient(ms) {
  const totalSeconds = Math.round(Number(ms) / 1000);
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return "";
  }
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

const CLIENT_STATUS_KEYS = {
  running: "card_status_running",
  blocked: "card_status_blocked",
  waiting_input: "card_status_waiting_input",
  queued: "card_status_queued"
};

function renderListStatChipsClient(s) {
  const listStats = s && s.stats;
  if (!listStats || typeof listStats !== "object") {
    return "";
  }
  const chips = [];
  const chip = (label, title, className = "") => {
    const cls = ["stat-chip", className].filter(Boolean).join(" ");
    return `<span class="${cls}" title="${escapeHtmlClient(title)}">${escapeHtmlClient(label)}</span>`;
  };
  if (listStats.messageCount != null) {
    chips.push(chip(
      ft("card_messages").replace("{count}", formatCompactCountClient(listStats.messageCount)),
      ft("card_messages_help")
    ));
  }
  if (listStats.tokenCount != null && Number(listStats.tokenCount) > 0) {
    chips.push(chip(
      ft("card_tokens").replace("{count}", formatCompactCountClient(listStats.tokenCount)),
      ft("card_tokens_help")
    ));
  }
  if (listStats.durationMs != null && Number(listStats.durationMs) >= 1000) {
    const duration = formatDurationClient(listStats.durationMs);
    const help = listStats.durationSource === "protocol"
      ? ft("card_observed_duration_help")
      : ft("card_recorded_duration_help");
    chips.push(`<span class="stat-chip" title="${escapeHtmlClient(help)}" aria-label="${escapeHtmlClient(`${duration}. ${help}`)}">${escapeHtmlClient(duration)}</span>`);
  }
  if (listStats.protocol && Number(listStats.compactions) > 0) {
    const count = formatCompactCountClient(listStats.compactions);
    const label = ft("card_compactions").replace("{count}", count);
    const title = listStats.lastCompactionAt != null
      ? ft("card_compactions_help_last").replace("{count}", count).replace("{time}", formatTimeClient(listStats.lastCompactionAt))
      : ft("card_compactions_help").replace("{count}", count);
    chips.push(chip(label, title));
  }
  if (listStats.protocol && Number(listStats.subagentRunCount) > 0) {
    chips.push(chip(
      ft("card_subagents").replace("{count}", formatCompactCountClient(listStats.subagentRunCount)),
      ft("card_subagents_help")
    ));
  }
  if (listStats.protocol && Number(listStats.backgroundRunCount) > 0) {
    chips.push(chip(
      ft("card_background_runs").replace("{count}", formatCompactCountClient(listStats.backgroundRunCount)),
      ft("card_background_runs_help")
    ));
  }
  for (const status of listStats.activeStatuses || []) {
    const key = CLIENT_STATUS_KEYS[status];
    if (!key) continue;
    const label = ft(key);
    chips.push(chip(label, ft("card_status_help").replace("{status}", label), `stat-chip-${status}`));
  }
  if (listStats.protocol && Number(listStats.contextArtifactCount) > 0) {
    chips.push(chip(
      ft("card_artifacts").replace("{count}", formatCompactCountClient(listStats.contextArtifactCount)),
      ft("card_artifacts_help")
    ));
  }
  if (listStats.protocol && listStats.memoryCount != null && Number(listStats.memoryCount) > 0) {
    chips.push(chip(
      ft("card_memory").replace("{count}", formatCompactCountClient(listStats.memoryCount)),
      ft("card_memory_help")
    ));
  }
  return chips.join("");
}

function renderSessionCard(s) {
  const sessionProvider = s.provider || PROVIDER;
  const id = escapeHtmlClient(s.id);
  const encodedProvider = encodeURIComponent(sessionProvider);
  const encodedSessionId = encodeURIComponent(s.id || "");
  const exportFilePrefix = escapeHtmlClient(`session-${String(s.id || "").slice(0, 8)}`);
  const title = escapeHtmlClient(s.title || s.id);
  const directory = escapeHtmlClient(s.directory || "");
  const timeUpdated = Number(s.time_updated) || Date.now();
  const classes = ["session-card"];
  if (s.starred) classes.push("starred");
  const changedFiles = Number(s.summary_files) || 0;
  const additions = Number(s.summary_additions) || 0;
  const deletions = Number(s.summary_deletions) || 0;
  const stats = [
    changedFiles > 0 ? `<span>${ft("card_files").replace("{count}", String(changedFiles))}</span>` : "",
    additions > 0 ? `<span class="additions">+${additions}</span>` : "",
    deletions > 0 ? `<span class="deletions">-${deletions}</span>` : ""
  ].filter(Boolean).join("");
  const protocolStats = renderListStatChipsClient(s);
  let providerNames = {};
  try { providerNames = JSON.parse(scrollSentinel?.dataset.providerNames || "{}"); } catch {}
  const providerBadge = scrollSentinel?.dataset.global === "true" ? `<span class="session-provider-badge" title="${escapeHtmlClient(sessionProvider)}">${escapeHtmlClient(providerNames[sessionProvider] || sessionProvider)}</span>` : "";
  const returnTo = scrollSentinel?.dataset.returnTo || "";
  const detailHref = `/${encodedProvider}/session/${encodeURIComponent(s.id)}${returnTo ? `?from=${encodeURIComponent(returnTo)}` : ""}`;

  const actionsHtml = IS_MANAGEABLE_PROVIDER ? `
    <div class="card-actions">
      <button class="star-btn ${s.starred ? "starred" : ""}" type="button" data-star-format="icon" data-id="${id}" title="${escapeHtmlClient(s.starred ? ft("starred_label") : ft("star_label"))}" aria-label="${escapeHtmlClient(s.starred ? ft("starred_label") : ft("star_label"))}">
        ${s.starred ? "★" : "☆"}
      </button>
      <button class="card-menu-trigger" type="button" data-id="${id}" title="${escapeHtmlClient(ft("menu_more"))}" aria-label="${escapeHtmlClient(ft("menu_more"))}">⋮</button>
      <div class="card-menu hidden" data-id="${id}">
        <button type="button" data-action="rename" data-id="${id}">${ft("menu_rename")}</button>
        <button type="button" data-action="copy-session-id" data-id="${id}" title="${escapeHtmlClient(ft("copy_session_id"))}" aria-label="${escapeHtmlClient(ft("copy_session_id"))}">${ft("menu_copy_session_id")}</button>
        <a href="/api/${encodedProvider}/session/${encodedSessionId}/export?format=md" download="${exportFilePrefix}.md">${ft("menu_export_md")}</a>
        <a href="/api/${encodedProvider}/session/${encodedSessionId}/export?format=json" download="${exportFilePrefix}.json">${ft("menu_export_json")}</a>
        <button type="button" data-action="delete" data-id="${id}" class="menu-danger">${ft("menu_delete")}</button>
      </div>
    </div>
  ` : "";

  return `<article class="${classes.join(" ")}" data-session-id="${id}">
    ${IS_MANAGEABLE_PROVIDER ? `<input type="checkbox" class="card-checkbox" data-id="${id}">` : ""}
    <div class="session-card-content">
      <header class="session-card-header">
        <div class="session-card-title-stack">
          <a href="${detailHref}" class="session-card-title-link">
            <h2 class="session-card-title">${title}</h2>
          </a>
          ${providerBadge}
        </div>
        <time class="session-card-time" datetime="${new Date(timeUpdated).toISOString()}">${escapeHtmlClient(formatTimeClient(timeUpdated))}</time>
      </header>
      <p class="session-card-directory">${directory}</p>
      ${stats || protocolStats ? `<footer class="session-card-stats">${stats}${protocolStats}</footer>` : ""}
    </div>
    ${actionsHtml}
  </article>`;
}

const scrollSentinel = document.getElementById("scroll-sentinel");
if (scrollSentinel && sessionList) {
  let scrollOffset = Number(scrollSentinel.dataset.offset) || 0;
  const scrollTotal = Number(scrollSentinel.dataset.total) || 0;
  const scrollRange = scrollSentinel.dataset.range || "";
  const scrollQuery = scrollSentinel.dataset.query || "";
  const scrollProject = scrollSentinel.dataset.project || "";
  const scrollMode = scrollSentinel.dataset.mode || "list";
  const scrollSort = scrollSentinel.dataset.sort || "";
  const scrollKind = scrollSentinel.dataset.kind || "";
  const scrollStarred = scrollSentinel.dataset.starred || "";
  const scrollProviders = scrollSentinel.dataset.providers || "";
  const isGlobalSessions = scrollSentinel.dataset.global === "true";
  let isLoading = false;
  let observer = null;

  const setSentinelState = (className, text, disabled = false) => {
    scrollSentinel.className = className;
    scrollSentinel.textContent = text;
    scrollSentinel.disabled = disabled;
  };

  const loadMoreSessions = async () => {
    if (isLoading || scrollOffset >= scrollTotal) {
      return;
    }

    isLoading = true;
    setSentinelState("scroll-loading", ft("scroll_loading"), true);

    try {
      const params = new URLSearchParams({
        offset: String(scrollOffset),
        limit: "30"
      });
      if (scrollRange) params.set("range", scrollRange);
      if (scrollQuery) params.set("q", scrollQuery);
      if (scrollProject) params.set("project", scrollProject);
      if (scrollMode) params.set("mode", scrollMode);
      if (scrollSort) params.set("sort", scrollSort);
      if (scrollKind) params.set("kind", scrollKind);
      if (scrollStarred) params.set("starred", scrollStarred);
      if (scrollProviders) scrollProviders.split(",").filter(Boolean).forEach((provider) => params.append("provider", provider));

      const res = await fetch(`${isGlobalSessions ? "/api/sessions" : `/api/${PROVIDER}/sessions`}?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      const markup = Array.isArray(data.sessions) ? data.sessions.map(renderSessionCard).join("") : "";
      sessionList.insertAdjacentHTML("beforeend", markup);
      updateBatchCount();
      scrollOffset = (Number(data.offset) || 0) + (Array.isArray(data.sessions) ? data.sessions.length : 0);

      if (!data.hasMore || scrollOffset >= scrollTotal) {
        observer?.disconnect();
        setSentinelState("scroll-done", ft("scroll_all_loaded"), true);
      } else {
        setSentinelState("scroll-load-more", ft("scroll_load_more"));
      }
    } catch {
      setSentinelState("scroll-load-more", ft("scroll_load_more"));
      showToast(ft("toast_error"), "error");
    } finally {
      isLoading = false;
    }
  };

  scrollSentinel.addEventListener("click", loadMoreSessions);

  if (scrollOffset < scrollTotal) {
    setSentinelState("scroll-load-more", ft("scroll_load_more"));
    if ("IntersectionObserver" in window) {
      observer = new IntersectionObserver(async (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          await loadMoreSessions();
        }
      }, { rootMargin: "200px" });
      observer.observe(scrollSentinel);
    }
  } else {
    setSentinelState("scroll-done", ft("scroll_all_loaded"), true);
  }
}


initSessionWorkbench({ ft, formatText, showToast });
initEnhancements({ ft, formatText, showToast, escapeHtmlClient });
initRuntimeWorkbench({ ft, formatText });
