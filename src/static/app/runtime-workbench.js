export function initRuntimeWorkbench({ ft, formatText }) {
  const root = document.querySelector("[data-runtime-root]");
  if (!root) return;

  const evidenceScript = root.querySelector("[data-runtime-evidence]");
  let evidence = {};
  try { evidence = JSON.parse(evidenceScript?.textContent || "{}"); } catch { evidence = {}; }
  const requestedLens = new URLSearchParams(window.location.search).get("runtimeLens");
  const legacySection = ({ execution: "runs", coordination: "coordination", context: "context" })[requestedLens];
  if (legacySection) {
    const target = root.querySelector(`[data-runtime-section="${CSS.escape(legacySection)}"]`);
    if (target instanceof HTMLDetailsElement) target.open = true;
    requestAnimationFrame(() => target?.scrollIntoView({ block: "start", behavior: "instant" }));
  }

  let selectedKey = null;
  let inspectorTrigger = null;
  const entityKey = (kind, id) => `${kind}:${id}`;
  const setSelected = (kind, id, focus = false) => {
    if (!kind || !id) return;
    selectedKey = entityKey(kind, id);
    const selectedRun = kind === "run"
      ? root.querySelector(`[data-runtime-entity-kind="run"][data-runtime-entity-id="${CSS.escape(id)}"]`)
      : null;
    const linkedTaskId = selectedRun?.dataset.runtimeTaskId || "";
    const linkedActorId = selectedRun?.dataset.runtimeActorId || "";
    root.querySelectorAll("[data-runtime-entity-kind][data-runtime-entity-id]").forEach((item) => {
      const itemKey = entityKey(item.dataset.runtimeEntityKind, item.dataset.runtimeEntityId);
      const isExact = itemKey === selectedKey;
      const isLinked = kind === "task"
        ? item.dataset.runtimeTaskId === id
        : kind === "actor"
          ? item.dataset.runtimeActorId === id
          : kind === "run" && ((item.dataset.runtimeEntityKind === "task" && item.dataset.runtimeEntityId === linkedTaskId)
            || (item.dataset.runtimeEntityKind === "actor" && item.dataset.runtimeEntityId === linkedActorId));
      item.classList.toggle("runtime-selected", isExact);
      item.classList.toggle("runtime-linked", !isExact && isLinked);
    });
    root.querySelectorAll("[data-runtime-edge-from][data-runtime-edge-to]").forEach((item) => {
      const from = entityKey(item.dataset.runtimeEdgeFromKind || "unknown", item.dataset.runtimeEdgeFrom);
      const to = entityKey(item.dataset.runtimeEdgeToKind || "unknown", item.dataset.runtimeEdgeTo);
      item.classList.toggle("runtime-selected", from === selectedKey || to === selectedKey);
    });
    root.querySelectorAll("[data-runtime-select-kind][data-runtime-select-id]").forEach((item) => {
      item.setAttribute("aria-pressed", entityKey(item.dataset.runtimeSelectKind, item.dataset.runtimeSelectId) === selectedKey ? "true" : "false");
    });
    const inspector = root.querySelector("[data-runtime-inspector]");
    const content = root.querySelector("[data-runtime-inspector-content]");
    if (inspector && content) {
      const candidates = [
        ...(kind === "run" && Array.isArray(evidence.runPageRuns) ? evidence.runPageRuns : []),
        ...(Array.isArray(evidence[`${kind}s`]) ? evidence[`${kind}s`] : [])
      ];
      const item = candidates.find((entry) => String(entry.id) === String(id));
      content.replaceChildren();
      const labels = { goal: ft("runtime_goal_title"), task: ft("runtime_task"), actor: ft("runtime_agent"), run: ft("runtime_run") };
      const name = item?.title || item?.name || item?.label || item?.agentPath || item?.agent || item?.model
        || (kind === "run" && item?.kind === "session-turn" ? ft("runtime_session_turn") : ft("runtime_recorded_run"));
      const heading = document.createElement("p");
      heading.className = "runtime-inspector-selection";
      heading.textContent = `${labels[kind] || kind} · ${name}`;
      content.append(heading);
      const fact = (label, value) => {
        if (value === null || value === undefined || value === "") return;
        const row = document.createElement("p");
        row.className = "runtime-inspector-fact";
        row.textContent = `${label}: ${value}`;
        content.append(row);
      };
      fact(ft("runtime_inspector_id"), id);
      if (item?.status) fact(ft("runtime_state"), ft(`runtime_status_${item.status}`));
      if (item?.mode) fact(ft("runtime_execution_mode"), ft(`runtime_mode_${item.mode}`));
      if (item?.ownerActorId) fact(ft("runtime_task_owner"), item.ownerActorId);
      const relatedButton = (relatedKind, relatedId) => {
        if (!relatedId) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "runtime-inspector-related";
        button.dataset.runtimeSelectKind = relatedKind;
        button.dataset.runtimeSelectId = relatedId;
        button.textContent = `${labels[relatedKind] || relatedKind}: ${relatedId}`;
        content.append(button);
      };
      const relatedTaskId = selectedRun?.dataset.runtimeTaskId || item?.taskId || "";
      const relatedActorId = selectedRun?.dataset.runtimeActorId || item?.actorId || "";
      if (kind === "run") {
        relatedButton("task", relatedTaskId);
        relatedButton("actor", relatedActorId);
      } else if (kind === "task") {
        [...root.querySelectorAll(`[data-runtime-entity-kind="run"][data-runtime-task-id="${CSS.escape(id)}"]`)]
          .slice(0, 20).forEach((run) => relatedButton("run", run.dataset.runtimeEntityId));
      } else if (kind === "actor") {
        [...root.querySelectorAll(`[data-runtime-entity-kind="run"][data-runtime-actor-id="${CSS.escape(id)}"]`)]
          .slice(0, 20).forEach((run) => relatedButton("run", run.dataset.runtimeEntityId));
      }
      const events = document.createElement("a");
      events.href = "#tab-events";
      events.className = "runtime-inspector-events-link";
      events.dataset.runtimeOpenEvents = "true";
      if (kind === "task" || kind === "run") events.dataset.runtimeEventTaskId = kind === "task" ? id : (item?.taskId || "");
      if (kind === "run") events.dataset.runtimeEventRunId = id;
      if (item?.correlationId) events.dataset.runtimeEventCorrelationId = item.correlationId;
      events.textContent = ft("runtime_open_events");
      content.append(events);
      inspector.hidden = false;
      if (window.matchMedia("(max-width: 820px)").matches) {
        inspector.scrollIntoView({ block: "start", behavior: "auto" });
        inspector.querySelector("[data-runtime-inspector-close]")?.focus({ preventScroll: true });
      }
    }
    if (focus) root.querySelector(`[data-runtime-select-kind="${CSS.escape(kind)}"][data-runtime-select-id="${CSS.escape(id)}"]`)?.focus();
  };
  const closeInspector = () => {
    const inspector = root.querySelector("[data-runtime-inspector]");
    if (!inspector || inspector.hidden) return false;
    inspector.hidden = true;
    if (inspectorTrigger?.isConnected && !inspectorTrigger.closest("[hidden]") && inspectorTrigger.getClientRects().length) inspectorTrigger.focus();
    inspectorTrigger = null;
    return true;
  };
  const drawGraphLinks = () => {
    root.querySelectorAll("[data-runtime-graph-links]").forEach((svg, graphIndex) => {
      const canvas = svg.closest("[data-runtime-graph-canvas]");
      if (!canvas) return;
      const canvasRect = canvas.getBoundingClientRect();
      const width = Math.max(1, canvasRect.width);
      const height = Math.max(1, canvasRect.height);
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      svg.setAttribute("width", String(width));
      svg.setAttribute("height", String(height));
      svg.replaceChildren();
      const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
      const markerId = `runtime-graph-arrow-${graphIndex}`;
      marker.id = markerId;
      marker.setAttribute("markerWidth", "7");
      marker.setAttribute("markerHeight", "7");
      marker.setAttribute("refX", "6");
      marker.setAttribute("refY", "3.5");
      marker.setAttribute("orient", "auto");
      marker.setAttribute("markerUnits", "strokeWidth");
      const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
      arrow.setAttribute("d", "M0,0 L7,3.5 L0,7 Z");
      arrow.setAttribute("fill", "currentColor");
      marker.append(arrow);
      defs.append(marker);
      svg.append(defs);
      canvas.querySelectorAll("[data-runtime-graph-edge]").forEach((edge) => {
        const from = canvas.querySelector(`[data-runtime-entity-kind="${CSS.escape(edge.dataset.runtimeEdgeFromKind || "")}"][data-runtime-entity-id="${CSS.escape(edge.dataset.runtimeEdgeFrom || "")}"]`);
        const to = canvas.querySelector(`[data-runtime-entity-kind="${CSS.escape(edge.dataset.runtimeEdgeToKind || "")}"][data-runtime-entity-id="${CSS.escape(edge.dataset.runtimeEdgeTo || "")}"]`);
        if (!from || !to) return;
        const fromRect = from.getBoundingClientRect();
        const toRect = to.getBoundingClientRect();
        const fromCenter = { x: fromRect.left + fromRect.width / 2, y: fromRect.top + fromRect.height / 2 };
        const toCenter = { x: toRect.left + toRect.width / 2, y: toRect.top + toRect.height / 2 };
        const dx = toCenter.x - fromCenter.x;
        const dy = toCenter.y - fromCenter.y;
        const boundaryScale = (rect) => dx || dy
          ? Math.min(dx ? rect.width / (2 * Math.abs(dx)) : Number.POSITIVE_INFINITY, dy ? rect.height / (2 * Math.abs(dy)) : Number.POSITIVE_INFINITY)
          : 0;
        const fromPoint = { x: fromCenter.x + dx * boundaryScale(fromRect), y: fromCenter.y + dy * boundaryScale(fromRect) };
        const toPoint = { x: toCenter.x - dx * boundaryScale(toRect), y: toCenter.y - dy * boundaryScale(toRect) };
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", String(fromPoint.x - canvasRect.left));
        line.setAttribute("y1", String(fromPoint.y - canvasRect.top));
        line.setAttribute("x2", String(toPoint.x - canvasRect.left));
        line.setAttribute("y2", String(toPoint.y - canvasRect.top));
        const edgeSelected = selectedKey && (entityKey(edge.dataset.runtimeEdgeFromKind, edge.dataset.runtimeEdgeFrom) === selectedKey || entityKey(edge.dataset.runtimeEdgeToKind, edge.dataset.runtimeEdgeTo) === selectedKey);
        line.setAttribute("class", `runtime-graph-link${edge.dataset.runtimeEdgeAsync === "true" ? " runtime-graph-link-async" : ""}${edgeSelected ? " runtime-selected" : ""}`);
        line.setAttribute("marker-end", `url(#${markerId})`);
        line.dataset.runtimeEdgeFrom = edge.dataset.runtimeEdgeFrom;
        line.dataset.runtimeEdgeTo = edge.dataset.runtimeEdgeTo;
        line.dataset.runtimeEdgeFromKind = edge.dataset.runtimeEdgeFromKind;
        line.dataset.runtimeEdgeToKind = edge.dataset.runtimeEdgeToKind;
        svg.append(line);
      });
    });
  };
  drawGraphLinks();
  window.addEventListener("resize", () => requestAnimationFrame(drawGraphLinks));
  if (typeof ResizeObserver === "function") {
    const graphObserver = new ResizeObserver(() => drawGraphLinks());
    root.querySelectorAll("[data-runtime-graph-canvas]").forEach((canvas) => graphObserver.observe(canvas));
  }
  root.querySelectorAll("[data-runtime-select-kind][data-runtime-select-id]").forEach((button) => button.setAttribute("aria-pressed", "false"));
  root.addEventListener("click", (event) => {
    const button = event.target.closest("[data-runtime-select-kind][data-runtime-select-id]");
    if (button) {
      const kind = button.dataset.runtimeSelectKind;
      const id = button.dataset.runtimeSelectId;
      if (button.closest("[data-runtime-inspector]")) {
        inspectorTrigger = [...root.querySelectorAll("[data-runtime-select-kind][data-runtime-select-id]")]
          .find((candidate) => !candidate.closest("[data-runtime-inspector]")
            && candidate.dataset.runtimeSelectKind === kind
            && candidate.dataset.runtimeSelectId === id) || null;
      } else {
        inspectorTrigger = button;
      }
      setSelected(kind, id);
    }
    if (event.target.closest("[data-runtime-inspector-close]")) closeInspector();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && closeInspector()) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  const provenance = (value) => {
    if (!value || typeof value !== "object") return ft("runtime_provenance_unknown");
    return [value.fidelity, value.sourceType, value.sourceId].filter(Boolean).join(" · ") || ft("runtime_provenance_unknown");
  };

  const showRunPageError = (page, message) => {
    page.replaceChildren();
    const heading = document.createElement("div");
    heading.className = "runtime-run-page-heading";
    const title = document.createElement("h3");
    title.textContent = ft("runtime_runs");
    heading.append(title);
    const notice = document.createElement("p");
    notice.className = "runtime-notice";
    notice.dataset.runtimeRunPageErrorMessage = "true";
    notice.textContent = message || ft("runtime_run_page_stale");
    const refresh = document.createElement("a");
    refresh.className = "btn";
    refresh.href = `/${encodeURIComponent(page.dataset.runtimeRunPageProvider || "")}/session/${encodeURIComponent(page.dataset.runtimeRunPageSessionId || "")}?runtimeLens=execution`;
    refresh.textContent = ft("runtime_refresh_runs");
    page.append(heading, notice, refresh);
  };

  root.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-runtime-runs-previous],[data-runtime-runs-next]");
    if (!button || button.disabled) return;
    const page = button.closest("[data-runtime-run-page]");
    if (!page) return;
    const cursor = button.dataset.runtimeRunsCursor || "";
    const provider = page.dataset.runtimeRunPageProvider || root.dataset.runtimeProvider || "";
    const sessionId = page.dataset.runtimeRunPageSessionId || root.dataset.runtimeSessionId || "";
    const limit = page.dataset.runtimeRunPageLimit || "50";
    if (!provider || !sessionId || !cursor || page.dataset.runtimeRunPageBusy === "true") return;
    page.dataset.runtimeRunPageBusy = "true";
    page.querySelectorAll("[data-runtime-runs-previous],[data-runtime-runs-next]").forEach((item) => { item.disabled = true; });
    try {
      const params = new URLSearchParams({ cursor, limit });
      const response = await fetch(`/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}/runtime/execution/runs?${params}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok !== true || typeof data.html !== "string") {
        showRunPageError(page, data?.error || ft("runtime_run_page_stale"));
        return;
      }
      const holder = document.createElement("div");
      holder.innerHTML = data.html;
      const replacement = holder.firstElementChild;
      if (!replacement) throw new Error("run page response is empty");
      page.replaceWith(replacement);
      if (Array.isArray(data.evidenceRuns)) evidence.runPageRuns = data.evidenceRuns;
      if (selectedKey) {
        const separator = selectedKey.indexOf(":");
        setSelected(selectedKey.slice(0, separator), selectedKey.slice(separator + 1));
      }
    } catch (error) {
      console.error("Unable to load recorded run page:", error);
      showRunPageError(page, ft("runtime_run_page_stale"));
    }
  });

  const openEvidence = (kind, id) => {
    const drawer = root.querySelector("[data-runtime-drawer]");
    if (!drawer) return;
    const candidates = [
      ...(kind === "run" && Array.isArray(evidence.runPageRuns) ? evidence.runPageRuns : []),
      ...(Array.isArray(evidence[kind + "s"]) ? evidence[kind + "s"] : [])
    ];
    const item = candidates.length
      ? candidates.find((entry) => String(entry.id) === String(id))
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

}
