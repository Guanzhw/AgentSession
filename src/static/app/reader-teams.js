import { ft } from "./i18n.js";
import { scopeReaderFragment } from "./reader-pane-dom.js";

function mount(pane, host, html, append = false) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  if (append) host.append(wrapper);
  else host.replaceChildren(wrapper);
  scopeReaderFragment(pane, wrapper);
  wrapper.replaceWith(...wrapper.childNodes);
}

export function initReaderTeams() {
  const workbench = document.querySelector(".session-workbench[data-session-reader]");
  if (!workbench) return;
  const origins = new WeakMap();
  const pending = new WeakMap();

  const statusFor = (team) => team.querySelector("[data-reader-team-status]");
  const setStatus = (team, value) => { const status = statusFor(team); if (status) status.textContent = value || ""; };

  async function json(url, owner) {
    const previous = pending.get(owner);
    previous?.abort();
    const controller = new AbortController();
    pending.set(owner, controller);
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      return data;
    } finally {
      if (pending.get(owner) === controller) pending.delete(owner);
    }
  }

  async function select(control) {
    const pane = control.closest("[data-reader-pane]");
    const team = control.closest("[data-reader-teams]");
    const host = team?.querySelector("[data-reader-team-detail-host]");
    const browse = team?.querySelector("[data-reader-team-browse]");
    if (!pane || !team || !host || !browse || !control.dataset.readerTeamDetailUrl) return;
    origins.set(host, control);
    setStatus(team, ft("detail.reader_team_loading"));
    control.disabled = true;
    try {
      const data = await json(control.dataset.readerTeamDetailUrl, host);
      mount(pane, host, data.html);
      browse.hidden = true;
      host.hidden = false;
      for (const button of pane.querySelectorAll("[data-reader-team-select]")) {
        if (button.closest("[data-reader-pane]") === pane) {
          button.setAttribute("aria-pressed", String(button.dataset.readerTeamSelect === data.selection.key));
        }
      }
      host.querySelector("[data-reader-team-detail-title]")?.focus({ preventScroll: true });
      setStatus(team, "");
    } catch (error) {
      if (error.name !== "AbortError") setStatus(team, `${ft("progressive.load_failed")} (${error.message})`);
    } finally {
      control.disabled = false;
    }
  }

  async function loadDirectory(button, replace) {
    const pane = button.closest("[data-reader-pane]");
    const team = button.closest("[data-reader-teams]");
    const pages = team?.querySelector("[data-reader-team-directory-pages]");
    const graph = team?.querySelector("[data-reader-team-graph-host]");
    if (!pane || !team || !pages || !graph || !button.dataset.readerTeamDirectoryUrl) return;
    setStatus(team, ft("detail.reader_team_loading"));
    button.disabled = true;
    try {
      const data = await json(button.dataset.readerTeamDirectoryUrl, pages);
      if (replace) {
        mount(pane, pages, data.html);
      } else {
        pages.querySelector("[data-reader-team-directory-more]")?.remove();
        mount(pane, pages, data.html, true);
      }
      mount(pane, graph, data.graphHtml);
      setStatus(team, "");
    } catch (error) {
      if (error.name !== "AbortError") setStatus(team, `${ft("progressive.load_failed")} (${error.message})`);
    } finally {
      button.disabled = false;
    }
  }

  async function loadExchanges(button) {
    const pane = button.closest("[data-reader-pane]");
    const team = button.closest("[data-reader-teams]");
    const pages = button.closest("[data-reader-team-exchange-pages]");
    if (!pane || !team || !pages || !button.dataset.readerTeamExchangesUrl) return;
    setStatus(team, ft("detail.reader_team_loading"));
    button.disabled = true;
    try {
      const data = await json(button.dataset.readerTeamExchangesUrl, pages);
      button.remove();
      mount(pane, pages, data.html, true);
      setStatus(team, "");
    } catch (error) {
      if (error.name !== "AbortError") setStatus(team, `${ft("progressive.load_failed")} (${error.message})`);
      button.disabled = false;
    }
  }

  async function loadTasks(button) {
    const pane = button.closest("[data-reader-pane]");
    const team = button.closest("[data-reader-teams]");
    const pages = button.closest("[data-reader-team-task-pages]");
    if (!pane || !team || !pages || !button.dataset.readerTeamTasksUrl) return;
    setStatus(team, ft("detail.reader_team_loading"));
    button.disabled = true;
    try {
      const data = await json(button.dataset.readerTeamTasksUrl, pages);
      button.closest(".reader-team-task-more")?.remove();
      mount(pane, pages, data.html, true);
      setStatus(team, "");
    } catch (error) {
      if (error.name !== "AbortError") setStatus(team, `${ft("progressive.load_failed")} (${error.message})`);
      button.disabled = false;
    }
  }

  workbench.addEventListener("click", (event) => {
    const selectControl = event.target.closest?.("[data-reader-team-select]");
    if (selectControl && workbench.contains(selectControl)) {
      event.preventDefault();
      void select(selectControl);
      return;
    }
    const back = event.target.closest?.("[data-reader-team-back]");
    if (back && workbench.contains(back)) {
      const host = back.closest("[data-reader-team-detail-host]");
      const team = back.closest("[data-reader-teams]");
      const browse = team?.querySelector("[data-reader-team-browse]");
      if (host && browse) {
        host.hidden = true;
        browse.hidden = false;
        origins.get(host)?.focus?.({ preventScroll: true });
      }
      return;
    }
    const directoryMore = event.target.closest?.("[data-reader-team-directory-more]");
    if (directoryMore && workbench.contains(directoryMore)) {
      event.preventDefault();
      void loadDirectory(directoryMore, false);
      return;
    }
    const exchangesMore = event.target.closest?.("[data-reader-team-exchanges-more]");
    if (exchangesMore && workbench.contains(exchangesMore)) {
      event.preventDefault();
      void loadExchanges(exchangesMore);
      return;
    }
    const tasksMore = event.target.closest?.("[data-reader-team-tasks-more]");
    if (tasksMore && workbench.contains(tasksMore)) {
      event.preventDefault();
      void loadTasks(tasksMore);
    }
  });

  workbench.addEventListener("submit", (event) => {
    const form = event.target.closest?.("[data-reader-team-search]");
    if (!form || !workbench.contains(form)) return;
    event.preventDefault();
    const pane = form.closest("[data-reader-pane]");
    const provider = pane?.dataset.readerProvider;
    const sessionId = pane?.dataset.readerSession;
    if (!provider || !sessionId) return;
    const query = form.querySelector("[data-reader-team-search-input]")?.value?.trim() || "";
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    const submit = form.querySelector('button[type="submit"]');
    if (!submit) return;
    submit.dataset.readerTeamDirectoryUrl = `/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}/reader/teams?${params}`;
    void loadDirectory(submit, true).finally(() => { delete submit.dataset.readerTeamDirectoryUrl; });
  });

  workbench.addEventListener("session-reader:before-swap", () => {
    for (const team of workbench.querySelectorAll("[data-reader-teams]")) {
      const pages = team.querySelector("[data-reader-team-directory-pages]");
      const detail = team.querySelector("[data-reader-team-detail-host]");
      pending.get(pages)?.abort();
      pending.get(detail)?.abort();
    }
  });
}
