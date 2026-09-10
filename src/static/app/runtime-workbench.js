export function initRuntimeWorkbench({ ft, formatText }) {
  const root = document.querySelector("[data-runtime-root]");
  if (!root) return;

  const tabs = [...root.querySelectorAll("[data-runtime-lens]")];
  const panels = [...root.querySelectorAll("[data-runtime-panel]")];
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

  const requestedLens = new URLSearchParams(window.location.search).get("runtimeLens");
  selectLens(tabs.find((tab) => tab.dataset.runtimeLens === requestedLens)
    || tabs.find((tab) => tab.getAttribute("aria-selected") === "true")
    || tabs[0]);
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
