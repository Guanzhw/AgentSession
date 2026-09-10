export function initRuntimeEvents({ ft, formatText }) {
  const boundedText = (value, limit = 180) => {
    if (typeof value !== "string") return null;
    const text = value.trim();
    const characters = Array.from(text);
    return characters.length <= limit ? text : `${characters.slice(0, limit - 1).join("").trimEnd()}…`;
  };
  document.querySelectorAll("[data-runtime-events-root]").forEach((root) => {
    const provider = root.dataset.runtimeEventsProvider || "";
    const sessionId = root.dataset.runtimeEventsSessionId || "";
    const eventsPanel = root.querySelector("[data-runtime-events-panel]");
    const eventList = root.querySelector("[data-runtime-event-list]");
    const eventStatus = root.querySelector("[data-runtime-events-status]");
    const categoryInput = root.querySelector("[data-runtime-event-category]");
    const searchInput = root.querySelector("[data-runtime-event-search]");
    const previousButton = root.querySelector("[data-runtime-events-previous]");
    const nextButton = root.querySelector("[data-runtime-events-next]");
    const focusFilter = root.querySelector("[data-runtime-events-focus-filter]");
    const focusFilterLabel = root.querySelector("[data-runtime-events-focus-filter-label]");
    const clearFilterButton = root.querySelector("[data-runtime-events-clear-filter]");
    const evidenceScript = root.querySelector("[data-runtime-events-evidence]");
    const drawer = root.querySelector("[data-runtime-events-drawer]");
    let evidence = {};
    try { evidence = JSON.parse(evidenceScript?.textContent || "{}"); } catch { evidence = {}; }
    let currentEvents = Array.isArray(evidence.events) ? evidence.events.slice(0, 50) : [];
    let currentPageEvidence = new Map(currentEvents.map((event) => [String(event.id), event]));
    let currentCursor = null;
    const cursors = [];
    let focusedFilters = {};

    const renderFocusedFilter = () => {
      const entries = Object.entries(focusedFilters).filter(([, value]) => value);
      if (!focusFilter || !focusFilterLabel) return;
      focusFilter.hidden = entries.length === 0;
      const labels = { taskId: ft("runtime_task"), runId: ft("runtime_run"), correlationId: ft("runtime_correlation") };
      focusFilterLabel.textContent = formatText(ft("runtime_events_linked_filter"), { filters: entries.map(([key, value]) => `${labels[key] || key}: ${value}`).join(" · ") });
      if (clearFilterButton) clearFilterButton.hidden = entries.length === 0;
    };

    const eventLabel = (event) => event.normalizedKind || event.kind || ft("runtime_unknown");
    const eventSummary = (event) => {
      const facts = event.summary || {
        phase: event.phase || null,
        compactionSummary: boundedText(event.compaction?.summary),
        hasTask: Boolean(event.taskId), hasRun: Boolean(event.runId), hasTurn: Boolean(event.turnId)
      };
      const phaseKey = facts.phase ? `runtime_phase_${facts.phase}` : "";
      const phase = phaseKey ? ft(phaseKey) : "";
      const parts = [
        phase === phaseKey ? facts.phase : phase,
        facts.compactionSummary ? `${ft("runtime_compaction_summary")}: ${facts.compactionSummary}` : "",
        facts.hasTask ? ft("runtime_task_anchor_recorded") : "",
        facts.hasRun ? ft("runtime_run_anchor_recorded") : "",
        facts.hasTurn ? ft("runtime_turn_anchor_recorded") : ""
      ].filter(Boolean).join(" · ");
      const characters = Array.from(parts);
      return (characters.length > 240 ? `${characters.slice(0, 239).join("").trimEnd()}…` : parts) || ft("runtime_not_recorded");
    };
    const eventTime = (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? new Date(number).toLocaleString() : ft("runtime_unknown_time");
    };
    const provenance = (value) => value && typeof value === "object"
      ? [value.fidelity, value.sourceType, value.sourceId].filter(Boolean).join(" · ") || ft("runtime_provenance_unknown")
      : ft("runtime_provenance_unknown");

    const openEvidence = (id) => {
      if (!drawer) return;
      const item = currentPageEvidence.get(String(id));
      const summary = drawer.querySelector("[data-runtime-events-drawer-summary]");
      const details = drawer.querySelector("[data-runtime-events-drawer-details]");
      summary.textContent = item ? `event · ${item.id || id} · ${provenance(item.provenance)}` : `event · ${id}`;
      details.replaceChildren();
      if (!item) {
        const missing = document.createElement("dt");
        missing.textContent = ft("runtime_provenance_unknown");
        details.append(missing);
      } else {
        Object.entries(item).filter(([key, value]) => key !== "providerData" && value !== null && value !== undefined && typeof value !== "object").slice(0, 30).forEach(([key, value]) => {
          const keyNode = document.createElement("dt");
          keyNode.textContent = key;
          const valueNode = document.createElement("dd");
          valueNode.textContent = String(value);
          details.append(keyNode, valueNode);
        });
        const compactionSummary = item.summary?.compactionSummary || boundedText(item.compaction?.summary);
        if (compactionSummary) {
          const summaryNode = document.createElement("dt");
          summaryNode.textContent = ft("runtime_compaction_summary");
          const summaryValue = document.createElement("dd");
          summaryValue.textContent = compactionSummary;
          details.append(summaryNode, summaryValue);
        }
        const provenanceNode = document.createElement("dt");
        provenanceNode.textContent = "provenance";
        const provenanceValue = document.createElement("dd");
        provenanceValue.textContent = provenance(item.provenance);
        details.append(provenanceNode, provenanceValue);
      }
      if (typeof drawer.showModal === "function") drawer.showModal();
      else drawer.setAttribute("open", "");
    };

    const renderEvents = () => {
      if (!eventList) return;
      const query = (searchInput?.value || "").trim().toLocaleLowerCase();
      const visible = currentEvents.filter((event) => !query || `${eventLabel(event)} ${eventSummary(event)}`.toLocaleLowerCase().includes(query));
      eventList.replaceChildren();
      if (!visible.length) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 5;
        cell.className = "runtime-empty";
        cell.textContent = ft("runtime_no_events");
        row.append(cell);
        eventList.append(row);
      } else {
        visible.forEach((event) => {
          const row = document.createElement("tr");
          row.dataset.runtimeEvent = "true";
          row.dataset.runtimeEventCategory = event.category || "unknown";
          const fidelity = event.provenance?.fidelity === "recorded" || event.provenance?.fidelity === "derived" ? event.provenance.fidelity : "unknown";
          const values = [String(event.sequence ?? ""), eventTime(event.timestamp), eventLabel(event), ft(`runtime_event_${fidelity}`)];
          const labels = [ft("runtime_event_sequence"), ft("runtime_event_time"), ft("runtime_event_type_summary"), ft("runtime_event_origin")];
          values.forEach((value, index) => {
            const cell = document.createElement(index === 2 ? "th" : "td");
            if (index === 2) cell.scope = "row";
            if (index === 0) cell.className = "runtime-event-sequence";
            cell.dataset.label = labels[index];
            if (index === 3) {
              const origin = document.createElement("span");
              origin.className = `runtime-event-fidelity runtime-event-fidelity-${fidelity}`;
              origin.textContent = value;
              cell.append(origin);
            } else {
              cell.textContent = value;
            }
            row.append(cell);
          });
          row.children[2].append(Object.assign(document.createElement("small"), { textContent: eventSummary(event) }));
          const evidenceCell = document.createElement("td");
          evidenceCell.dataset.label = ft("runtime_evidence");
          const button = document.createElement("button");
          button.type = "button";
          button.className = "runtime-evidence-trigger";
          button.dataset.runtimeEventEvidenceId = event.id;
          button.textContent = ft("runtime_evidence");
          evidenceCell.append(button);
          row.append(evidenceCell);
          eventList.append(row);
        });
      }
      if (eventStatus) eventStatus.textContent = formatText(ft("runtime_events_loaded"), { count: String(currentEvents.length) });
    };

    const loadEvents = async (cursor = null, pushCursor = false, popCursor = false) => {
      if (!eventsPanel || !eventList) return;
      const params = new URLSearchParams({ limit: "50" });
      if (categoryInput?.value) params.set("category", categoryInput.value);
      ["taskId", "runId", "correlationId"].forEach((key) => { if (focusedFilters[key]) params.set(key, focusedFilters[key]); });
      if (cursor) params.set("cursor", cursor);
      try {
        const response = await fetch(`/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}/runtime/events?${params}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (pushCursor) cursors.push(currentCursor);
        if (popCursor) cursors.pop();
        currentCursor = cursor;
        currentEvents = data.events || [];
        currentPageEvidence = new Map(currentEvents.map((event) => [String(event.id), event]));
        renderEvents();
        renderFocusedFilter();
        previousButton.disabled = cursors.length === 0;
        nextButton.disabled = !data.nextCursor;
        nextButton.dataset.runtimeNextCursor = data.nextCursor || "";
      } catch {
        if (eventStatus) eventStatus.textContent = ft("toast_error");
      }
    };

    renderEvents();
    renderFocusedFilter();
    if (previousButton) previousButton.disabled = true;
    if (nextButton) nextButton.disabled = !nextButton.dataset.runtimeNextCursor;
    root.addEventListener("click", (event) => {
      const evidence = event.target.closest("[data-runtime-event-evidence-id]");
      if (evidence) { openEvidence(evidence.dataset.runtimeEventEvidenceId); return; }
      const density = event.target.closest("[data-runtime-density-category]");
      if (density) {
        if (categoryInput) categoryInput.value = density.dataset.runtimeDensityCategory || "";
        cursors.length = 0;
        currentCursor = null;
        void loadEvents();
      }
    });
    root.querySelector("[data-runtime-event-filters]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      cursors.length = 0;
      currentCursor = null;
      void loadEvents();
    });
    searchInput?.addEventListener("input", renderEvents);
    nextButton?.addEventListener("click", () => { if (nextButton.dataset.runtimeNextCursor) void loadEvents(nextButton.dataset.runtimeNextCursor, true); });
    previousButton?.addEventListener("click", () => void loadEvents(cursors.at(-1) || null, false, true));
    clearFilterButton?.addEventListener("click", () => {
      focusedFilters = {};
      cursors.length = 0;
      currentCursor = null;
      renderFocusedFilter();
      void loadEvents();
    });
    window.addEventListener("runtime:filter-events", (event) => {
      focusedFilters = event.detail || {};
      cursors.length = 0;
      currentCursor = null;
      renderFocusedFilter();
      void loadEvents();
    });
  });
}
