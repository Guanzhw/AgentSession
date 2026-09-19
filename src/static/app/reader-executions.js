import { ft } from "./i18n.js";
import { scopeReaderFragment } from "./reader-pane-dom.js";

const pending = new WeakMap();

export function loadReaderExecution(detail, cursor = null) {
  if (pending.has(detail)) return pending.get(detail);
  if (!cursor && detail.dataset.readerExecutionLoaded) return Promise.resolve(true);
  const panel = detail.querySelector("[data-reader-execution-panel]");
  const status = detail.querySelector("[data-reader-execution-status]");
  const more = panel.querySelector("[data-reader-execution-more]");
  const task = (async () => {
    detail.setAttribute("aria-busy", "true");
    if (more) more.disabled = true;
    status.textContent = ft("detail.execution_loading");
    try {
      const url = new URL(detail.dataset.readerExecutionUrl, location.href);
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      const data = await response.json();
      if (!response.ok || !data.ok || typeof data.html !== "string") throw new Error(data.code || `HTTP ${response.status}`);
      const wrapper = document.createElement("div");
      wrapper.innerHTML = data.html;
      const host = cursor ? panel.querySelector("[data-reader-execution-steps]") : panel;
      if (cursor) more?.closest("li")?.remove();
      else host.replaceChildren();
      host.append(wrapper);
      scopeReaderFragment(detail.closest("[data-reader-pane]"), wrapper);
      wrapper.replaceWith(...wrapper.childNodes);
      detail.dataset.readerExecutionLoaded = "true";
      status.textContent = "";
      return true;
    } catch (error) {
      status.textContent = ft(error.message === "stale_page" ? "detail.execution_changed" : "detail.execution_load_failed");
      const retry = document.createElement("button");
      retry.type = "button";
      retry.dataset.readerExecutionRetry = error.message === "stale_page" ? "" : cursor || "";
      retry.textContent = ft("detail.reader_coordination_content_retry");
      status.append(retry);
      return false;
    } finally {
      detail.removeAttribute("aria-busy");
      if (more) more.disabled = false;
    }
  })().finally(() => pending.delete(detail));
  pending.set(detail, task);
  return task;
}

export function initReaderExecutions() {
  const workbench = document.querySelector(".session-workbench[data-session-reader]");
  if (!workbench) return;
  workbench.addEventListener("toggle", (event) => {
    if (event.target.matches("[data-reader-execution-detail]") && event.target.open) loadReaderExecution(event.target);
  }, true);
  workbench.addEventListener("click", (event) => {
    const button = event.target.closest("[data-reader-execution-more],[data-reader-execution-retry]");
    if (!button) return;
    const detail = button.closest("[data-reader-execution-detail]");
    const cursor = button.hasAttribute("data-reader-execution-more") ? button.dataset.readerExecutionCursor : button.dataset.readerExecutionRetry;
    if (!cursor) delete detail.dataset.readerExecutionLoaded;
    loadReaderExecution(detail, cursor || null);
  });
}
