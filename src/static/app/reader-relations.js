/*
 * Reader relations are local annotations, not a second graph view. The
 * server places each recorded milestone beside its owning message; this
 * controller only scopes focus, lane emphasis and responsive spacing to the
 * pane that owns the annotation.
 */
const LANE_COLORS = ["--accent-color", "--trace-lsp", "--warning-color", "--trace-reasoning", "--trace-agent", "--trace-tool"];
const MAX_VISIBLE_LANES = 3;

export function initReaderRelations() {
  const workbench = document.querySelector(".session-workbench[data-session-reader]");
  if (!workbench) return;

  const narrow = window.matchMedia("(max-width: 600px)");
  const contexts = new Map();
  const overviewOrigins = new WeakMap();
  let frame = null;
  const observer = new ResizeObserver(() => schedule());

  const schedule = () => {
    if (frame === null && contexts.size) frame = requestAnimationFrame(draw);
  };

  const ownedElements = (pane, selector) => [...pane.querySelectorAll(selector)]
    .filter((element) => element.closest("[data-reader-pane]") === pane);
  const overviewFor = (pane) => ownedElements(pane, "[data-reader-collaboration-overview]")[0];

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
    loadPreview(detail);
    schedule();
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
    for (const milestone of milestones) {
      const index = Math.max(0, lanes.indexOf(milestone.dataset.readerLane));
      milestone.style.setProperty("--reader-lane-color", `var(${LANE_COLORS[index % LANE_COLORS.length]})`);
      milestone.dataset.readerLaneIndex = String(index);
    }
    observer.observe(section);
    schedule();
  }

  function contextForNode(node) {
    const section = node?.closest?.("[data-reader-relations]");
    return section ? contexts.get(section) || null : null;
  }

  function openTask(context, lane, origin) {
    const overview = overviewFor(context.pane);
    if (!overview) return;
    overviewOrigins.set(overview, origin);
    openOverview(overview);
    const detail = [...overview.querySelectorAll("[data-reader-task-lane]")]
      .find((candidate) => candidate.dataset.readerTaskLane === lane);
    if (detail) {
      detail.open = true;
      selectTask(context.pane, detail);
    }
  }

  function openOverview(overview) {
    for (const other of workbench.querySelectorAll("[data-reader-collaboration-overview]")) {
      if (other !== overview) other.open = false;
    }
    overview.open = true;
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
    const pane = workbench.querySelector("[data-reader-pane]");
    const overview = pane && overviewFor(pane);
    if (!overview) return;
    overviewOrigins.set(overview, toggle);
    if (overview.open) closeOverview(overview);
    else {
      openOverview(overview);
      ensureSelectedTask(pane);
    }
    toggle.setAttribute("aria-expanded", String(overview.open));
  }, true);

  workbench.addEventListener("toggle", (event) => {
    const branch = event.target;
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
    const retry = event.target.closest?.("[data-reader-preview-retry]");
    if (retry && workbench.contains(retry)) {
      loadPreview(retry.closest("[data-reader-branch]"));
      return;
    }
    const task = event.target.closest?.("[data-reader-task-select]");
    if (task && workbench.contains(task)) {
      const pane = task.closest("[data-reader-pane]");
      const detail = ownedElements(pane, "[data-reader-branch]")
        .find((branch) => branch.dataset.readerBranchKey === task.dataset.readerTaskSelect);
      selectTask(pane, detail);
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
    const milestoneContext = milestone ? contextForNode(milestone) : null;
    if (!milestoneContext?.select || event.target.closest?.("a,button")) return;
    milestoneContext.select.value = milestone.dataset.readerLane || "";
    openTask(milestoneContext, milestone.dataset.readerLane || "", milestone.querySelector("[data-reader-lane-focus]"));
    schedule();
  });
  workbench.addEventListener("toggle", schedule, true);
  workbench.addEventListener("session-reader:content-updated", (event) => {
    const pane = event.detail?.pane;
    if (pane) attachPane(pane);
    schedule();
  });
  workbench.addEventListener("session-reader:process-loaded", schedule);
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

  attachAll();
}
