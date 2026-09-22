import { loadReaderActivity } from "./reader-activity.js";
import { focusReaderTaskGraph, initReaderTaskGraphs, replaceReaderTaskGraph } from "./reader-task-graph.js";
import { ft } from "./i18n.js";
import { scopeReaderFragment } from "./reader-pane-dom.js";

/*
 * The server owns relationship meaning and places every recorded milestone.
 * This controller synchronizes task graph, directory, detail and lane focus
 * inside the pane that owns them.
 */
const LANE_COLORS = ["--accent-color", "--trace-lsp", "--warning-color", "--trace-reasoning", "--trace-agent", "--trace-tool"];
const MAX_VISIBLE_LANES = 3;

export function initReaderRelations() {
  const workbench = document.querySelector(".session-workbench[data-session-reader]");
  if (!workbench) return;

  const narrow = window.matchMedia("(max-width: 600px)");
  const contexts = new Map();
  const overviewOrigins = new WeakMap();
  const activityQueries = new WeakMap();
  const taskDetailLoads = new Map();
  const taskSelectionTokens = new WeakMap();
  const taskDirectoryRequests = new WeakMap();
  let frame = null;
  const observer = new ResizeObserver(() => schedule());

  const schedule = () => {
    if (frame === null && contexts.size) frame = requestAnimationFrame(draw);
  };

  const ownedElements = (pane, selector) => [...pane.querySelectorAll(selector)]
    .filter((element) => element.closest("[data-reader-pane]") === pane);
  const overviewFor = (pane) => ownedElements(pane, "[data-reader-collaboration-overview]")[0];
  const activeOverview = () => [...workbench.querySelectorAll("[data-reader-collaboration-overview]")]
    .find((overview) => overview.dataset.readerPanelActive !== undefined);

  function mountReaderFragment(pane, host, html, append = true) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    if (append) host.append(wrapper);
    else host.replaceChildren(wrapper);
    scopeReaderFragment(pane, wrapper);
    wrapper.replaceWith(...wrapper.childNodes);
  }

  async function loadPreview(detail) {
    const preview = detail.querySelector("[data-reader-task-preview]");
    if (!preview || preview.dataset.readerPreviewLoaded || preview.dataset.readerPreviewLoading) return;
    const status = preview.querySelector("[data-reader-preview-status]");
    const retry = preview.querySelector("[data-reader-preview-retry]");
    preview.dataset.readerPreviewLoading = "true";
    status.hidden = false;
    status.textContent = preview.dataset.loadingLabel;
    retry.hidden = true;
    try {
      const response = await fetch(`/api/${encodeURIComponent(preview.dataset.readerProvider)}/session/${encodeURIComponent(preview.dataset.readerSession)}/reader/preview`, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      preview.querySelector("[data-reader-preview-content]").innerHTML = result.html;
      preview.dataset.readerPreviewLoaded = "true";
      status.hidden = true;
    } catch (error) {
      status.textContent = `${preview.dataset.errorLabel} (${error.message})`;
      retry.hidden = false;
    } finally {
      delete preview.dataset.readerPreviewLoading;
    }
  }

  function selectTask(pane, detail) {
    if (!detail) return;
    const overview = overviewFor(pane);
    overview.dataset.readerTaskEnhanced = "true";
    for (const branch of ownedElements(pane, "[data-reader-branch]")) branch.open = branch === detail;
    for (const button of ownedElements(pane, "[data-reader-task-select]")) {
      button.setAttribute("aria-pressed", String(button.dataset.readerTaskSelect === detail.dataset.readerBranchKey));
    }
    const section = paneRelationSection(pane);
    const context = section && contexts.get(section);
    if (context?.select && detail.dataset.readerTaskLane) context.select.value = detail.dataset.readerTaskLane;
    focusReaderTaskGraph(overview, detail.dataset.readerBranchKey);
    loadPreview(detail);
    schedule();
  }

  async function loadTaskDetail(pane, selection) {
    const overview = overviewFor(pane);
    if (!overview) return null;
    const existing = selection.key
      ? ownedElements(pane, "[data-reader-branch]").find((branch) => branch.dataset.readerBranchKey === selection.key)
      : ownedElements(pane, "[data-reader-branch]").find((branch) => branch.dataset.readerTaskLane === selection.lane);
    if (existing) return { detail: existing, graphHtml: null };
    const provider = pane.dataset.readerProvider;
    const session = pane.dataset.readerSession;
    if (!provider || !session) return null;
    const identity = selection.key ? `key:${selection.key}` : `lane:${selection.lane}`;
    const loadKey = `${provider}\u0000${session}\u0000${identity}`;
    if (!taskDetailLoads.has(loadKey)) {
      const params = new URLSearchParams(selection.key ? { key: selection.key } : { lane: selection.lane });
      taskDetailLoads.set(loadKey, fetch(`/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(session)}/reader/task?${params}`, {
        headers: { Accept: "application/json" }
      }).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        const host = ownedElements(pane, "[data-reader-task-details]")[0];
        if (!host) return { detail: null, graphHtml: null };
        const duplicate = ownedElements(pane, "[data-reader-branch]").find((branch) => branch.dataset.readerBranchKey === result.key);
        if (!duplicate) mountReaderFragment(pane, host, result.html);
        return {
          detail: ownedElements(pane, "[data-reader-branch]").find((branch) => branch.dataset.readerBranchKey === result.key) || null,
          graphHtml: result.graphHtml || null
        };
      }).finally(() => taskDetailLoads.delete(loadKey)));
    }
    return taskDetailLoads.get(loadKey);
  }

  async function selectTaskControl(pane, control) {
    const token = (taskSelectionTokens.get(pane) || 0) + 1;
    taskSelectionTokens.set(pane, token);
    const existing = ownedElements(pane, "[data-reader-branch]")
      .find((branch) => branch.dataset.readerBranchKey === control.dataset.readerTaskSelect);
    if (existing) {
      taskSelectionError(pane, null);
      selectTask(pane, existing);
      const milestone = ownedElements(pane, "[data-reader-milestone]")
        .find((item) => item.dataset.readerLane === existing.dataset.readerTaskLane);
      if (milestone?.dataset.readerObservationId) loadOverviewActivity(overviewFor(pane), { anchor: milestone.dataset.readerObservationId });
      return;
    }
    taskSelectionStatus(pane, ft("detail.reader_task_loading"));
    try {
      const loaded = await loadTaskDetail(pane, { key: control.dataset.readerTaskSelect });
      if (!loaded?.detail || taskSelectionTokens.get(pane) !== token) return;
      const { detail, graphHtml } = loaded;
      if (graphHtml) {
        const graphHost = ownedElements(pane, "[data-reader-task-graph-host]")[0];
        if (graphHost) replaceReaderTaskGraph(graphHost, graphHtml);
      }
      taskSelectionError(pane, null);
      selectTask(pane, detail);
      const milestone = ownedElements(pane, "[data-reader-milestone]")
        .find((item) => item.dataset.readerLane === detail.dataset.readerTaskLane);
      if (milestone?.dataset.readerObservationId) loadOverviewActivity(overviewFor(pane), { anchor: milestone.dataset.readerObservationId });
    } catch (error) {
      if (taskSelectionTokens.get(pane) === token) taskSelectionError(pane, { key: control.dataset.readerTaskSelect }, error);
    }
  }

  function taskSelectionStatus(pane, message) {
    const status = ownedElements(pane, "[data-reader-task-status]")[0];
    if (status) status.textContent = message || "";
    return status;
  }

  function taskSelectionError(pane, selection, error = null) {
    const status = taskSelectionStatus(pane, "");
    if (!status) return;
    if (!selection) {
      status.textContent = "";
      return;
    }
    const overview = overviewFor(pane);
    const label = ft("detail.reader_task_failed");
    const retry = overview?.querySelector("[data-reader-collaboration]")?.dataset.readerTaskRetryLabel || "Retry";
    status.textContent = `${label} `;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = retry;
    button.dataset.readerTaskDetailRetry = "";
    if (selection.key) button.dataset.readerTaskKey = selection.key;
    if (selection.lane) button.dataset.readerTaskLane = selection.lane;
    status.append(button);
  }

  async function loadTaskDirectory(directory, url, append) {
    const pages = directory.querySelector("[data-reader-task-directory-pages]");
    const status = directory.querySelector("[data-reader-task-directory-status]");
    if (!pages) return;
    const previous = taskDirectoryRequests.get(directory);
    previous?.controller.abort();
    const token = (previous?.token || 0) + 1;
    const controller = new AbortController();
    taskDirectoryRequests.set(directory, { token, controller });
    directory.dataset.readerTaskDirectoryLoading = "true";
    if (status) status.textContent = ft("detail.reader_tasks_loading");
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
      if (taskDirectoryRequests.get(directory)?.token !== token) return;
      if (!response.ok) {
        const error = new Error(response.status === 409 ? ft("detail.reader_tasks_changed") : ft("detail.reader_tasks_failed"));
        error.status = response.status;
        throw error;
      }
      const result = await response.json();
      if (taskDirectoryRequests.get(directory)?.token !== token) return;
      const pane = directory.closest("[data-reader-pane]");
      if (!pane) return;
      if (append) {
        pages.querySelector("[data-reader-task-directory-more]")?.remove();
        mountReaderFragment(pane, pages, result.html);
      } else {
        mountReaderFragment(pane, pages, result.html, false);
      }
      if (status) status.textContent = "";
    } catch (error) {
      if (error.name !== "AbortError" && taskDirectoryRequests.get(directory)?.token === token && status) {
        status.textContent = error.message || ft("detail.reader_tasks_failed");
      }
    } finally {
      if (taskDirectoryRequests.get(directory)?.token === token) {
        taskDirectoryRequests.delete(directory);
        delete directory.dataset.readerTaskDirectoryLoading;
      }
    }
  }

  async function loadTaskRuns(button) {
    if (button.dataset.readerTaskRunsLoading) return;
    const pane = button.closest("[data-reader-pane]");
    const runs = button.closest("[data-reader-task-runs]");
    const status = runs?.querySelector("[data-reader-task-runs-status]");
    if (!pane || !runs) return;
    button.dataset.readerTaskRunsLoading = "true";
    button.disabled = true;
    if (status) status.textContent = ft("detail.reader_task_loading");
    try {
      const response = await fetch(button.dataset.readerTaskRunsUrl, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(response.status === 409 ? ft("detail.reader_tasks_changed") : ft("detail.reader_task_failed"));
      const result = await response.json();
      if (!button.isConnected) return;
      button.remove();
      status?.remove();
      mountReaderFragment(pane, runs, result.runsHtml);
    } catch (error) {
      if (status) status.textContent = error.message || ft("detail.reader_task_failed");
      button.disabled = false;
      delete button.dataset.readerTaskRunsLoading;
    }
  }

  function ensureSelectedTask(pane) {
    const branches = ownedElements(pane, "[data-reader-branch]");
    selectTask(pane, branches.find((branch) => branch.open) || branches[0]);
  }

  function paneRelationSection(pane) {
    return [...pane.querySelectorAll("[data-reader-relations]")]
      .find((section) => section.closest("[data-reader-pane]") === pane) || null;
  }

  function drawPane(context) {
    const { section, select, milestones, lanes } = context;
    const allOption = select?.querySelector('option[value=""]');
    if (allOption) allOption.disabled = narrow.matches;
    if (narrow.matches && select && !select.value && lanes.length) select.value = lanes[0];
    const selected = select?.value || "";
    const visibleLanes = selected ? [selected] : lanes.slice(0, MAX_VISIBLE_LANES);
    const gutter = narrow.matches ? 18 : 22 + Math.max(0, visibleLanes.length - 1) * 8;
    section.style.setProperty("--reader-relation-gutter", `${gutter}px`);
    section.dataset.readerRelationActive = visibleLanes.length ? "true" : "unplaced";
    section.dataset.readerRelationVisibleLanes = visibleLanes.join(",");

    const taskDetails = ownedElements(context.pane, "[data-reader-task-lane]");
    for (const detail of taskDetails) {
      const selectedTask = Boolean(selected) && detail.dataset.readerTaskLane === selected;
      detail.dataset.readerTaskSelected = String(selectedTask);
    }

    for (const milestone of milestones) {
      const focused = selected === milestone.dataset.readerLane;
      milestone.classList.toggle("reader-milestone-focused", focused);
      milestone.classList.toggle("reader-milestone-muted", Boolean(selected) && !focused);
      milestone.querySelector("[data-reader-lane-focus]")?.setAttribute("aria-pressed", String(focused));
    }
  }

  function draw() {
    frame = null;
    for (const [section, context] of contexts) {
      if (!workbench.contains(context.pane)) {
        observer.unobserve?.(section);
        contexts.delete(section);
        continue;
      }
      drawPane(context);
    }
  }

  function detachAll() {
    observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    contexts.clear();
  }

  function detachPane(pane) {
    for (const [section, context] of contexts) {
      if (context.pane !== pane) continue;
      observer.unobserve?.(section);
      contexts.delete(section);
    }
    schedule();
  }

  function refreshMilestones(context) {
    const { pane, section, lanes } = context;
    context.milestones = [...section.querySelectorAll("[data-reader-milestone]")]
      .filter((milestone) => milestone.closest("[data-reader-pane]") === pane);
    for (const milestone of context.milestones) {
      const index = Math.max(0, lanes.indexOf(milestone.dataset.readerLane));
      milestone.style.setProperty("--reader-lane-color", `var(${LANE_COLORS[index % LANE_COLORS.length]})`);
      milestone.dataset.readerLaneIndex = String(index);
    }
  }

  function attachPane(pane) {
    if (!pane) return;
    const section = paneRelationSection(pane);
    if (!section || contexts.has(section)) return;
    const milestones = [...section.querySelectorAll("[data-reader-milestone]")];
    const select = section.querySelector("[data-reader-lane-select]");
    const lanes = select
      ? [...select.options].map((option) => option.value).filter(Boolean)
      : [...new Set(milestones.map((milestone) => milestone.dataset.readerLane).filter(Boolean))];
    const context = { pane, section, milestones, select, lanes };
    contexts.set(section, context);
    refreshMilestones(context);
    observer.observe(section);
    schedule();
  }

  function contextForNode(node) {
    const section = node?.closest?.("[data-reader-relations]");
    return section ? contexts.get(section) || null : null;
  }

  async function openTask(context, lane, origin) {
    const overview = overviewFor(context.pane);
    if (!overview) return;
    overviewOrigins.set(overview, origin);
    const observationId = origin.closest('[data-reader-milestone]')?.dataset.readerObservationId;
    openOverview(overview, observationId ? { anchor: observationId } : null);
    const token = (taskSelectionTokens.get(context.pane) || 0) + 1;
    taskSelectionTokens.set(context.pane, token);
    taskSelectionStatus(context.pane, ft("detail.reader_task_loading"));
    try {
      let detail = [...overview.querySelectorAll("[data-reader-task-lane]")]
        .find((candidate) => candidate.dataset.readerTaskLane === lane);
      let graphHtml = null;
      if (!detail) {
        const loaded = await loadTaskDetail(context.pane, { lane });
        detail = loaded?.detail || null;
        graphHtml = loaded?.graphHtml || null;
      }
      if (detail && taskSelectionTokens.get(context.pane) === token) {
        if (graphHtml) {
          const graphHost = ownedElements(context.pane, "[data-reader-task-graph-host]")[0];
          if (graphHost) replaceReaderTaskGraph(graphHost, graphHtml);
        }
        taskSelectionError(context.pane, null);
        detail.open = true;
        selectTask(context.pane, detail);
      }
    } catch (error) {
      if (taskSelectionTokens.get(context.pane) === token) taskSelectionError(context.pane, { lane }, error);
    }
    overview.querySelector("[data-reader-collaboration-close]")?.focus({ preventScroll: true });
  }

  function loadOverviewActivity(overview, activityQuery = null) {
    if (activityQuery !== null) activityQueries.set(overview, activityQuery);
    if (!overview.querySelector('[data-reader-activity-disclosure]').open) return;
    const query = activityQueries.get(overview) ?? null;
    activityQueries.delete(overview);
    loadReaderActivity(overview, query);
  }

  function openOverview(overview, activityQuery = null) {
    for (const other of workbench.querySelectorAll("[data-reader-collaboration-overview]")) {
      if (other !== overview) other.open = false;
    }
    overview.open = true;
    loadOverviewActivity(overview, activityQuery);
  }

  function closeOverview(overview) {
    overview.open = false;
    overviewOrigins.get(overview)?.focus?.({ preventScroll: true });
  }

  // Header triggers live outside the pane. Capture the click so the generic
  // legacy collaboration handler cannot turn the native details body into a
  // hidden region or lose the trigger focus.
  workbench.addEventListener("click", (event) => {
    const toggle = event.target.closest?.("[data-reader-collaboration-toggle]");
    if (!toggle || !workbench.contains(toggle)) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    const localPane = toggle.closest?.("[data-reader-pane]");
    const overview = localPane ? overviewFor(localPane) : activeOverview() || overviewFor(workbench.querySelector("[data-reader-pane]"));
    if (!overview) return;
    const pane = overview.closest("[data-reader-pane]");
    overviewOrigins.set(overview, toggle);
    if (overview.open) closeOverview(overview);
    else {
      openOverview(overview, {});
      ensureSelectedTask(pane);
      overview.querySelector("[data-reader-collaboration-close]")?.focus({ preventScroll: true });
    }
    toggle.setAttribute("aria-expanded", String(overview.open));
  }, true);

  workbench.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const overview = event.target.closest?.("[data-reader-collaboration-overview]");
    if (!overview?.open) return;
    event.preventDefault();
    event.stopPropagation();
    closeOverview(overview);
  });

  workbench.addEventListener("toggle", (event) => {
    const branch = event.target;
    if (branch?.dataset?.readerActivityDisclosure !== undefined) {
      if (branch.open) loadOverviewActivity(branch.closest('[data-reader-collaboration-overview]'));
      return;
    }
    if (branch?.dataset?.readerBranch !== undefined) {
      const pane = branch.closest("[data-reader-pane]");
      if (branch.open) selectTask(pane, branch);
      else {
        for (const button of ownedElements(pane, "[data-reader-task-select]")) {
          if (button.dataset.readerTaskSelect === branch.dataset.readerBranchKey) button.setAttribute("aria-pressed", "false");
        }
      }
      return;
    }
    const overview = event.target?.closest?.("[data-reader-collaboration-overview]");
    if (!overview) return;
    if (event.target === overview && overview.open) {
      openOverview(overview);
      ensureSelectedTask(overview.closest("[data-reader-pane]"));
    }
    if (overview.closest("[data-reader-pane]") !== workbench.querySelector("[data-reader-pane]")) return;
    const expanded = Boolean(overview.open);
    workbench.querySelectorAll("[data-reader-collaboration-toggle]").forEach((toggle) => {
      toggle.setAttribute("aria-expanded", String(expanded));
    });
    schedule();
  }, true);

  workbench.addEventListener("change", (event) => {
    const context = contextForNode(event.target);
    if (context?.select === event.target) schedule();
  });
  workbench.addEventListener("click", (event) => {
    const summary = event.target.closest?.(".reader-collaboration-overview-summary");
    if (summary && workbench.contains(summary)) {
      event.preventDefault();
      const overview = summary.closest("[data-reader-collaboration-overview]");
      overviewOrigins.set(overview, summary);
      openOverview(overview, {});
      ensureSelectedTask(overview.closest("[data-reader-pane]"));
      overview.querySelector("[data-reader-collaboration-close]")?.focus({ preventScroll: true });
      return;
    }
    const retry = event.target.closest?.("[data-reader-preview-retry]");
    if (retry && workbench.contains(retry)) {
      loadPreview(retry.closest("[data-reader-branch]"));
      return;
    }
    const task = event.target.closest?.("[data-reader-task-select]");
    if (task && workbench.contains(task)) {
      const pane = task.closest("[data-reader-pane]");
      void selectTaskControl(pane, task);
      return;
    }
    const taskRetry = event.target.closest?.("[data-reader-task-detail-retry]");
    if (taskRetry && workbench.contains(taskRetry)) {
      const pane = taskRetry.closest("[data-reader-pane]");
      if (taskRetry.dataset.readerTaskKey) {
        void selectTaskControl(pane, { dataset: { readerTaskSelect: taskRetry.dataset.readerTaskKey } });
      } else if (taskRetry.dataset.readerTaskLane) {
        const context = contexts.get(paneRelationSection(pane));
        if (context) void openTask(context, taskRetry.dataset.readerTaskLane, taskRetry);
      }
      return;
    }
    const taskRunsMore = event.target.closest?.("[data-reader-task-runs-more]");
    if (taskRunsMore && workbench.contains(taskRunsMore)) {
      void loadTaskRuns(taskRunsMore);
      return;
    }
    const directoryMore = event.target.closest?.("[data-reader-task-directory-more]");
    if (directoryMore && workbench.contains(directoryMore)) {
      const directory = directoryMore.closest("[data-reader-task-directory]");
      void loadTaskDirectory(directory, directoryMore.dataset.readerTaskDirectoryUrl, true);
      return;
    }
    const close = event.target.closest?.("[data-reader-collaboration-close]");
    if (close && workbench.contains(close)) {
      const overview = close.closest("[data-reader-collaboration-overview]");
      if (overview) closeOverview(overview);
      return;
    }
    const button = event.target.closest?.("[data-reader-lane-focus]");
    const context = button ? contextForNode(button) : null;
    if (button && context?.select) {
      context.select.value = button.value;
      openTask(context, button.value, button);
      schedule();
      return;
    }
    const milestone = event.target.closest?.("[data-reader-milestone]");
    if (milestone?.closest("[data-reader-pane]") !== event.target.closest?.("[data-reader-pane]")) return;
    const milestoneContext = milestone ? contextForNode(milestone) : null;
    if (!milestoneContext?.select || event.target.closest?.("a,button")) return;
    milestoneContext.select.value = milestone.dataset.readerLane || "";
    schedule();
  });
  workbench.addEventListener("submit", (event) => {
    const form = event.target.closest?.("[data-reader-task-directory-search]");
    if (!form || !workbench.contains(form)) return;
    event.preventDefault();
    const directory = form.closest("[data-reader-task-directory]");
    const url = new URL(directory.dataset.readerTaskDirectoryUrl, window.location.href);
    const query = form.querySelector("[data-reader-task-directory-query]")?.value?.trim() || "";
    if (query) url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    url.searchParams.delete("cursor");
    void loadTaskDirectory(directory, `${url.pathname}${url.search}`, false);
  });
  workbench.addEventListener("toggle", schedule, true);
  workbench.addEventListener("session-reader:content-updated", (event) => {
    const pane = event.detail?.pane;
    if (pane) attachPane(pane);
    schedule();
  });
  workbench.addEventListener("session-reader:process-loaded", (event) => {
    const section = paneRelationSection(event.detail.pane);
    const context = contexts.get(section);
    if (context) refreshMilestones(context);
    schedule();
  });
  workbench.addEventListener("session-reader:inline-opened", (event) => attachPane(event.detail?.pane));
  workbench.addEventListener("session-reader:inline-closed", (event) => detachPane(event.detail?.pane));
  workbench.addEventListener("session-reader:before-swap", detachAll);
  workbench.addEventListener("session-reader:swapped", attachAll);
  narrow.addEventListener("change", schedule);
  window.addEventListener("resize", schedule);

  function attachAll() {
    for (const pane of workbench.querySelectorAll("[data-reader-pane]")) attachPane(pane);
    schedule();
  }

  initReaderTaskGraphs(workbench);
  attachAll();
}
