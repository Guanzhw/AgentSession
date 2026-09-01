export function initRuntimeWorkbench({ ft, formatText }) {
  const root = document.querySelector("[data-runtime-root]");
  if (!root) return;

  const tabs = [...root.querySelectorAll("[data-runtime-lens]")];
  const panels = [...root.querySelectorAll("[data-runtime-panel]")];
  const provider = root.dataset.runtimeProvider || "";
  const sessionId = root.dataset.runtimeSessionId || "";
  const evidenceScript = root.querySelector("[data-runtime-evidence]");
  let evidence = {};
  try { evidence = JSON.parse(evidenceScript?.textContent || "{}"); } catch { evidence = {}; }

  const selectLens = (tab, focus = false) => {
    if (!tab) return;
    const selected = tab.dataset.runtimeLens;
    tabs.forEach((item) => {
      const active = item === tab;
      item.setAttribute("aria-selected", active ? "true" : "false");
      item.tabIndex = active ? 0 : -1;
      item.classList.toggle("is-active", active);
    });
    panels.forEach((panel) => {
      const active = panel.dataset.runtimePanel === selected;
      panel.hidden = !active;
      panel.classList.toggle("is-active", active);
    });
    if (focus) tab.focus();
  };

  selectLens(tabs.find((tab) => tab.getAttribute("aria-selected") === "true") || tabs[0]);
  root.querySelector("[role='tablist']")?.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-runtime-lens]");
    if (tab) selectLens(tab);
  });
  root.querySelector("[role='tablist']")?.addEventListener("keydown", (event) => {
    const tab = event.target.closest("[data-runtime-lens]");
    if (!tab) return;
    const index = tabs.indexOf(tab);
    if (index < 0) return;
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    selectLens(tabs[next], true);
  });

  const eventsPanel = root.querySelector("[data-runtime-events-panel]");
  const eventList = root.querySelector("[data-runtime-event-list]");
  const eventStatus = root.querySelector("[data-runtime-events-status]");
  const categoryInput = root.querySelector("[data-runtime-event-category]");
  const searchInput = root.querySelector("[data-runtime-event-search]");
  const previousButton = root.querySelector("[data-runtime-events-previous]");
  const nextButton = root.querySelector("[data-runtime-events-next]");
  const cursors = [];
  let currentCursor = null;
  let currentEvents = [];
  let activeTaskId = null;
  let activeRunId = null;

  const eventLabel = (event) => event.normalizedKind || event.kind || ft("runtime_unknown");
  const provenance = (value) => {
    if (!value || typeof value !== "object") return ft("runtime_provenance_unknown");
    return [value.fidelity, value.sourceType, value.sourceId].filter(Boolean).join(" · ") || ft("runtime_provenance_unknown");
  };
  const eventTime = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? new Date(number).toLocaleString() : ft("runtime_unknown_time");
  };

  const openEvidence = (kind, id) => {
    const drawer = root.querySelector("[data-runtime-drawer]");
    if (!drawer) return;
    const item = Array.isArray(evidence[kind + "s"])
      ? evidence[kind + "s"].find((entry) => String(entry.id) === String(id))
      : null;
    const title = drawer.querySelector("#runtime-drawer-title");
    const summary = drawer.querySelector("[data-runtime-drawer-summary]");
    const details = drawer.querySelector("[data-runtime-drawer-details]");
    title.textContent = ft("runtime_evidence_title");
    summary.textContent = item ? `${kind} · ${item.id || id} · ${provenance(item.provenance)}` : `${kind} · ${id}`;
    details.replaceChildren();
    if (!item) {
      const empty = document.createElement("dt");
      empty.textContent = ft("runtime_provenance_unknown");
      details.append(empty);
    } else {
      Object.entries(item).filter(([key]) => key !== "providerData" && item[key] !== null && item[key] !== undefined && typeof item[key] !== "object").slice(0, 30).forEach(([key, value]) => {
        const keyNode = document.createElement("dt");
        keyNode.textContent = key;
        const valueNode = document.createElement("dd");
        valueNode.textContent = String(value);
        details.append(keyNode, valueNode);
      });
      const provenanceNode = document.createElement("dt");
      provenanceNode.textContent = "provenance";
      const provenanceValue = document.createElement("dd");
      provenanceValue.textContent = provenance(item.provenance);
      details.append(provenanceNode, provenanceValue);
    }
    if (typeof drawer.showModal === "function") drawer.showModal();
    else drawer.setAttribute("open", "");
  };

  root.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-runtime-evidence-kind]");
    if (trigger) openEvidence(trigger.dataset.runtimeEvidenceKind, trigger.dataset.runtimeEvidenceId);
  });

  const renderEvents = (events) => {
    currentEvents = Array.isArray(events) ? events : [];
    eventList.replaceChildren();
    const query = (searchInput?.value || "").trim().toLocaleLowerCase();
    const visible = currentEvents.filter((event) => !query || `${eventLabel(event)} ${event.phase || ""} ${event.correlationId || ""}`.toLocaleLowerCase().includes(query));
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "runtime-empty";
      empty.textContent = ft("runtime_no_events");
      eventList.append(empty);
    } else {
      visible.forEach((event) => {
        const article = document.createElement("article");
        article.className = "runtime-event";
        article.dataset.runtimeEvent = "true";
        const sequence = document.createElement("div");
        sequence.className = "runtime-event-sequence";
        sequence.textContent = `#${event.sequence ?? ""}`;
        const body = document.createElement("div");
        body.className = "runtime-event-body";
        const heading = document.createElement("div");
        heading.className = "runtime-event-heading";
        const strong = document.createElement("strong");
        strong.textContent = eventLabel(event);
        const category = document.createElement("span");
        category.className = "runtime-event-category";
        category.textContent = event.category || "unknown";
        heading.append(strong, category);
        if (event.phase) { const phase = document.createElement("span"); phase.className = "runtime-event-phase"; phase.textContent = event.phase; heading.append(phase); }
        const meta = document.createElement("div");
        meta.className = "runtime-event-meta";
        const time = document.createElement("time");
        time.textContent = eventTime(event.timestamp);
        meta.append(time);
        if (event.correlationId) { const correlation = document.createElement("code"); correlation.textContent = event.correlationId; meta.append(correlation); }
        const source = document.createElement("span"); source.textContent = provenance(event.provenance); meta.append(source);
        body.append(heading, meta);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "runtime-evidence-trigger";
        button.dataset.runtimeEvidenceKind = "event";
        button.dataset.runtimeEvidenceId = event.id;
        button.setAttribute("aria-label", ft("runtime_evidence_open"));
        button.textContent = ft("runtime_evidence");
        article.append(sequence, body, button);
        eventList.append(article);
      });
    }
    if (eventStatus) eventStatus.textContent = formatText(ft("runtime_events_loaded"), { count: String(currentEvents.length) });
  };

  const loadEvents = async (cursor = null, pushCursor = false, popCursor = false) => {
    if (!eventsPanel || !eventList) return;
    const params = new URLSearchParams({ limit: "50" });
    const category = categoryInput?.value || "";
    if (category) params.set("category", category);
    if (activeTaskId) params.set("taskId", activeTaskId);
    if (activeRunId) params.set("runId", activeRunId);
    if (cursor) params.set("cursor", cursor);
    try {
      const response = await fetch(`/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}/runtime/events?${params}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (pushCursor) cursors.push(currentCursor);
      if (popCursor) cursors.pop();
      currentCursor = cursor;
      renderEvents(data.events || []);
      previousButton.disabled = cursors.length === 0;
      nextButton.disabled = !data.nextCursor;
      nextButton.dataset.runtimeNextCursor = data.nextCursor || "";
    } catch {
      if (eventStatus) eventStatus.textContent = ft("toast_error");
    }
  };

  currentEvents = Array.isArray(evidence.events) ? evidence.events.slice(0, 50) : [];
  if (nextButton) nextButton.disabled = !nextButton.dataset.runtimeNextCursor;
  eventsPanel?.querySelector("[data-runtime-event-filters]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    cursors.length = 0;
    currentCursor = null;
    activeTaskId = null;
    activeRunId = null;
    void loadEvents();
  });
  searchInput?.addEventListener("input", () => renderEvents(currentEvents));
  nextButton?.addEventListener("click", () => { if (nextButton.dataset.runtimeNextCursor) void loadEvents(nextButton.dataset.runtimeNextCursor, true); });
  previousButton?.addEventListener("click", () => { const cursor = cursors.at(-1) || null; void loadEvents(cursor, false, true); });
  root.addEventListener("click", (event) => {
    const density = event.target.closest("[data-runtime-density-category]");
    if (density) {
      const category = density.dataset.runtimeDensityCategory || "";
      if (categoryInput) categoryInput.value = category;
      cursors.length = 0;
      currentCursor = null;
      activeTaskId = null;
      activeRunId = null;
      selectLens(tabs.find((tab) => tab.dataset.runtimeLens === "events"));
      void loadEvents();
      return;
    }
    const taskTrigger = event.target.closest("[data-runtime-events-task]");
    const runTrigger = event.target.closest("[data-runtime-events-run]");
    if (!taskTrigger && !runTrigger) return;
    activeTaskId = taskTrigger?.dataset.runtimeEventsTask || null;
    activeRunId = runTrigger?.dataset.runtimeEventsRun || null;
    cursors.length = 0;
    currentCursor = null;
    selectLens(tabs.find((tab) => tab.dataset.runtimeLens === "events"));
    void loadEvents();
  });
}
