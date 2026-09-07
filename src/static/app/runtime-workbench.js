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

  const provenance = (value) => {
    if (!value || typeof value !== "object") return ft("runtime_provenance_unknown");
    return [value.fidelity, value.sourceType, value.sourceId].filter(Boolean).join(" · ") || ft("runtime_provenance_unknown");
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

}
