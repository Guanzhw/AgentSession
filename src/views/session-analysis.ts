import { t } from "../i18n.js";
import { escapeHtml } from "../markdown.js";

function analysisItems(values: any) {
  return Array.isArray(values)
    ? values.filter((value) => typeof value === "string" && value.trim())
    : [];
}

function analysisList(values: any) {
  const items = analysisItems(values);
  return items.length ? items.join(", ") : t("analysis.none");
}

function renderAnalysisValuePills(values: any, limit = 4) {
  const items = analysisItems(values);
  if (!items.length) {
    return `<span class="analysis-target-pill analysis-target-pill-muted">${t("analysis.none")}</span>`;
  }
  const visible = items.slice(0, limit).map((item) => (
    `<span class="analysis-target-pill">${escapeHtml(item)}</span>`
  ));
  const overflow = items.length - visible.length;
  if (overflow > 0) {
    visible.push(`<span class="analysis-target-pill analysis-target-pill-more" title="${escapeHtml(analysisList(items))}">+${escapeHtml(String(overflow))}</span>`);
  }
  return visible.join("");
}

function renderAnalysisTargetMeta(label: any, values: any, limit = 4) {
  return `<span class="analysis-target-meta">
    <span class="analysis-target-meta-label">${escapeHtml(label)}</span>
    <span class="analysis-target-pills">${renderAnalysisValuePills(values, limit)}</span>
  </span>`;
}

const analysisMaterialKinds = ["skills", "prompts", "agents", "rules", "other"];
const runtimeInventoryKinds = ["skill", "agent", "plugin", "instruction", "command", "hook", "rule", "tool", "extension"];

function analysisMaterialKindLabel(kind: any) {
  if (kind === "skills") return t("analysis.inventory_skills");
  if (kind === "prompts") return t("analysis.inventory_prompts");
  if (kind === "agents") return t("analysis.inventory_agents");
  if (kind === "rules") return t("analysis.inventory_rules");
  return t("analysis.inventory_other");
}

function analysisMaterialKind(value: any) {
  const key = String(value || "").toLowerCase();
  if (key.includes("skill")) return "skills";
  if (key.includes("prompt")) return "prompts";
  if (key.includes("agent")) return "agents";
  if (key.includes("rule") || key.includes("instruction")) return "rules";
  return "other";
}

function runtimeInventoryKindLabel(kind: any) {
  if (kind === "skill") return t("analysis.inventory_skills");
  if (kind === "agent") return t("analysis.inventory_agents");
  if (kind === "plugin") return t("analysis.inventory_plugins");
  if (kind === "instruction") return t("analysis.inventory_instructions");
  if (kind === "command") return t("analysis.inventory_commands");
  if (kind === "hook") return t("analysis.inventory_hooks");
  if (kind === "rule") return t("analysis.inventory_rules");
  if (kind === "tool") return t("analysis.inventory_tools");
  return t("analysis.inventory_other");
}

function runtimeInventoryKind(value: any) {
  const kind = String(value || "").toLowerCase();
  return runtimeInventoryKinds.includes(kind) ? kind : "extension";
}

function renderAnalysisTargetChoice(target: any, selectedTargets: any) {
  const artifacts = target?.artifacts || {};
  const checked = selectedTargets.has(target.id) && target.available;
  const disabled = target.available ? "" : "disabled";
  const kind = analysisMaterialKind(target.id || target.label);
  return `<label class="analysis-target-choice analysis-target-choice-compact${target.available ? "" : " analysis-target-choice-disabled"}">
    <input
      type="checkbox"
      class="analysis-target-checkbox"
      value="${escapeHtml(target.id)}"
      data-analysis-label="${escapeHtml(target.label || target.id)}"
      ${checked ? "checked" : ""}
      ${disabled}
    >
    <span class="analysis-target-compact-title">
      <strong>${escapeHtml(target.label || target.id)}</strong>
      <span class="analysis-kind-pill">${escapeHtml(analysisMaterialKindLabel(kind))}</span>
    </span>
    <span class="analysis-target-detail-popover" role="tooltip">
      ${renderAnalysisTargetMeta(t("analysis.material_roots"), artifacts.roots, 3)}
      ${renderAnalysisTargetMeta(t("analysis.material_files"), artifacts.files, 2)}
      ${renderAnalysisTargetMeta(t("analysis.material_suffixes"), artifacts.fileExtensions, 5)}
    </span>
  </label>`;
}

function runtimeScopeLabel(scope: any) {
  return scope === "project"
    ? t("analysis.project_scope")
    : scope === "user"
      ? t("analysis.user_scope")
      : scope || "Runtime";
}

function renderRuntimeExtensionChoice(extension: any, selectedRuntimeIds: any) {
  const checked = selectedRuntimeIds.has(extension.id) && extension.available;
  const source = extension.source || extension.sourcePath || extension.sourceType || "";
  const kind = runtimeInventoryKind(extension.kind);
  const scope = runtimeScopeLabel(extension.scope);
  return `<label class="analysis-runtime-choice${extension.available ? "" : " analysis-target-choice-disabled"}">
    <input
      type="checkbox"
      class="analysis-runtime-extension-checkbox"
      value="${escapeHtml(extension.id)}"
      data-analysis-label="${escapeHtml(extension.name || extension.id)}"
      ${checked ? "checked" : ""}
      ${extension.available ? "" : "disabled"}
    >
    <span class="analysis-target-copy">
      <span class="analysis-choice-heading analysis-runtime-title">
        <strong>${escapeHtml(extension.name || extension.id)}</strong>
        <span class="analysis-choice-tags">
          <span class="analysis-kind-pill">${escapeHtml(runtimeInventoryKindLabel(kind))}</span>
          <span class="analysis-scope-pill">${escapeHtml(scope)}</span>
        </span>
      </span>
      ${source ? `<small>${escapeHtml(source)}</small>` : ""}
      ${extension.note ? `<small>${escapeHtml(extension.note)}</small>` : ""}
    </span>
  </label>`;
}

function runtimeTabDomId(kind: any) {
  return `analysis-runtime-tab-${String(kind || "extension").replace(/[^a-z0-9_-]/gi, "-")}`;
}

function renderAnalysisInventory(targets: any, selectedTargets: any, runtimeExtensions: any, selectedRuntimeIds: any) {
  const targetChoices = targets
    .slice()
    .sort((a: any, b: any) => {
      const kindDelta = analysisMaterialKinds.indexOf(analysisMaterialKind(a.id || a.label))
        - analysisMaterialKinds.indexOf(analysisMaterialKind(b.id || b.label));
      return kindDelta || String(a.label || a.id).localeCompare(String(b.label || b.id));
    })
    .map((target: any) => renderAnalysisTargetChoice(target, selectedTargets));

  const runtimeGroups = new Map();
  for (const extension of runtimeExtensions) {
    const kind = runtimeInventoryKind(extension.kind);
    if (!runtimeGroups.has(kind)) {
      runtimeGroups.set(kind, []);
    }
    runtimeGroups.get(kind).push(renderRuntimeExtensionChoice(extension, selectedRuntimeIds));
  }

  const runtimeKinds = [...runtimeGroups.keys()].sort((a, b) => (
    runtimeInventoryKinds.indexOf(a) - runtimeInventoryKinds.indexOf(b)
  ));

  const runtimeMarkup = runtimeExtensions.length
    ? `<div class="analysis-runtime-tabs" data-analysis-runtime-tabs>
      <div class="analysis-runtime-tab-list" role="tablist">
      ${runtimeKinds.map((kind, index) => {
        const items = runtimeGroups.get(kind);
        const tabId = runtimeTabDomId(kind);
        return `<button
          type="button"
          class="analysis-runtime-tab${index === 0 ? " is-active" : ""}"
          role="tab"
          data-runtime-tab="${escapeHtml(kind)}"
          aria-selected="${index === 0 ? "true" : "false"}"
          aria-controls="${escapeHtml(`${tabId}-panel`)}"
          id="${escapeHtml(tabId)}"
          tabindex="${index === 0 ? "0" : "-1"}"
        >
          <span>${escapeHtml(runtimeInventoryKindLabel(kind))}</span>
          <strong>${escapeHtml(String(items.length))}</strong>
        </button>`;
      }).join("\n")}
      </div>
      <div class="analysis-runtime-tab-panels">
      ${runtimeKinds.map((kind, index) => {
        const items = runtimeGroups.get(kind);
        const tabId = runtimeTabDomId(kind);
        return `<section
          class="analysis-runtime-tab-panel${index === 0 ? " is-active" : ""}"
          role="tabpanel"
          data-runtime-panel="${escapeHtml(kind)}"
          aria-labelledby="${escapeHtml(tabId)}"
          id="${escapeHtml(`${tabId}-panel`)}"
          ${index === 0 ? "" : "hidden"}
        >
          <div class="analysis-runtime-panel-heading">
            <span>${escapeHtml(runtimeInventoryKindLabel(kind))}</span>
            <strong>${escapeHtml(String(items.length))}</strong>
          </div>
          <div class="analysis-runtime-list">${items.join("\n")}</div>
        </section>`;
      }).join("\n")}
      </div>
    </div>`
    : `<p class="analysis-runtime-empty">${t("analysis.no_runtime")}</p>`;

  return `<div class="analysis-material-sections">
    <section class="analysis-material-section">
      <div class="analysis-section-heading">
        <h4>${t("analysis.targets_title")}</h4>
        <p>${t("analysis.targets_description")}</p>
      </div>
      <div class="analysis-choice-grid">${targetChoices.join("\n")}</div>
    </section>
    <section class="analysis-material-section analysis-runtime-section">
      <div class="analysis-section-heading">
        <h4>${t("analysis.runtime_title")}</h4>
        <p>${t("analysis.runtime_description")}</p>
      </div>
      ${runtimeMarkup}
    </section>
  </div>`;
}

function resolveAnalysisLaunchState(analysisAction: any) {
  const targets = Array.isArray(analysisAction?.targets) ? analysisAction.targets : [];
  const selectedTargets = new Set(
    (Array.isArray(analysisAction?.selectedTargets) && analysisAction.selectedTargets.length
      ? analysisAction.selectedTargets
      : [analysisAction?.target || "skills"])
      .filter(Boolean)
  );
  const runtimeEnvironment = analysisAction?.runtimeEnvironment || null;
  const runtimeExtensions = Array.isArray(runtimeEnvironment?.extensions)
    ? runtimeEnvironment.extensions
    : [];
  const selectedRuntimeIds = new Set(
    Array.isArray(runtimeEnvironment?.selectedExtensionIds)
      ? runtimeEnvironment.selectedExtensionIds
      : runtimeExtensions
        .filter((extension: any) => extension.defaultSelected && extension.available)
        .map((extension: any) => extension.id)
  );
  const selectedTargetCount = targets.filter((target: any) => selectedTargets.has(target.id) && target.available).length;
  const selectedRuntimeCount = runtimeExtensions.filter((extension: any) => selectedRuntimeIds.has(extension.id) && extension.available).length;
  return {
    runtimeEnvironment,
    runtimeExtensions,
    selectedRuntimeCount,
    selectedRuntimeIds,
    selectedTargetCount,
    selectedTargets,
    targets
  };
}

export function renderAnalysisLaunchButton(analysisAction: any, session: any) {
  const {
    runtimeExtensions,
    selectedRuntimeIds,
    selectedTargetCount,
    selectedTargets,
    targets
  } = resolveAnalysisLaunchState(analysisAction);
  const launchLabel = selectedTargetCount <= 0
    ? t("analysis.launch_select_target")
    : selectedTargetCount === 1
      ? t("analysis.launch_one")
      : t("analysis.launch_many").replace("{targets}", String(selectedTargetCount));
  const selectedTargetLabels = targets
    .filter((target: any) => selectedTargets.has(target.id) && target.available)
    .map((target: any) => target.label || target.id);
  const selectedRuntimeLabels = runtimeExtensions
    .filter((extension: any) => selectedRuntimeIds.has(extension.id) && extension.available)
    .map((extension: any) => extension.name || extension.id);
  const launchAccessibleLabel = selectedTargetCount <= 0
    ? launchLabel
    : t("analysis.launch_action")
      .replace("{targets}", analysisList(selectedTargetLabels))
      .replace("{runtime}", String(selectedRuntimeLabels.length));
  return `<button
    type="button"
    class="action-btn action-btn-primary analysis-launch-button"
    data-action="analyze-session"
    data-id="${escapeHtml(session.id)}"
    data-target="${escapeHtml(analysisAction.target || "skills")}"
    data-unavailable="${analysisAction.available ? "false" : "true"}"
    title="${escapeHtml(launchAccessibleLabel)}"
    aria-label="${escapeHtml(launchAccessibleLabel)}"
    ${analysisAction.available ? "" : "disabled"}
  >${escapeHtml(launchLabel)}</button>`;
}

export function renderAnalysisLaunchControl(analysisAction: any, terminalLaunchAllowed: any) {
  if (!analysisAction || !terminalLaunchAllowed) {
    return "";
  }

  const {
    runtimeEnvironment,
    runtimeExtensions,
    selectedRuntimeCount,
    selectedRuntimeIds,
    selectedTargetCount,
    selectedTargets,
    targets
  } = resolveAnalysisLaunchState(analysisAction);

  return `<details class="analysis-materials-panel" id="analysis-materials-panel">
    <summary>
      <span>
        <strong>${t("analysis.materials_title")}</strong>
        <small data-analysis-launch-summary>${escapeHtml(t("analysis.launch_summary")
    .replace("{targets}", String(selectedTargetCount))
    .replace("{runtime}", String(selectedRuntimeCount)))}</small>
      </span>
      <span class="analysis-materials-counts">
        <span><span>${t("analysis.targets_title")}</span><strong data-analysis-selected-count>${escapeHtml(String(selectedTargetCount))}</strong></span>
        <span><span>${t("analysis.runtime_title")}</span><strong data-runtime-selected-count>${escapeHtml(String(selectedRuntimeCount))}</strong></span>
      </span>
    </summary>
    <div class="analysis-materials-body">
      <p class="analysis-runtime-note">${t("analysis.materials_description")}</p>
      ${renderAnalysisInventory(targets, selectedTargets, runtimeExtensions, selectedRuntimeIds)}
      ${runtimeEnvironment?.note ? `<p class="analysis-runtime-note">${escapeHtml(runtimeEnvironment.note)}</p>` : ""}
    </div>
  </details>`;
}
