import { initSessionWorkbench } from "./app/session-workbench.js";
import { initEnhancements } from "./app/enhancements.js";
import { ft, formatText } from "./app/i18n.js";
const PROVIDER = document.body.dataset.provider || "opencode";
const IS_MANAGEABLE_PROVIDER = document.body.dataset.manageable === "true";
import { initSettingsForm } from "./app/settings-form.js";
const themeToggle = document.getElementById('theme-toggle');
if (themeToggle) {
  function updateToggleIcon() {
    const isDark = document.documentElement.dataset.theme === 'dark';
    const label = isDark ? ft("theme_to_light") : ft("theme_to_dark");
    themeToggle.textContent = isDark ? '☀️' : '🌙';
    themeToggle.setAttribute("aria-label", label);
    themeToggle.setAttribute("title", label);
  }
  updateToggleIcon();
  themeToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.theme = next;
    updateToggleIcon();
  });
}

// Toast notifications
function showToast(message, type = "success") {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// Show pending toast from previous page (survives reload)
try {
  const pending = sessionStorage.getItem("pendingToast");
  if (pending) {
    sessionStorage.removeItem("pendingToast");
    const { message, type } = JSON.parse(pending);
    showToast(message, type);
  }
} catch {}

function queueToast(message, type = "success") {
  sessionStorage.setItem("pendingToast", JSON.stringify({ message, type }));
}

function focusableDialogElements(dialog) {
  return [...dialog.querySelectorAll("button, input, select, textarea, [href], [tabindex]:not([tabindex='-1'])")]
    .filter((element) => element instanceof HTMLElement && !element.disabled);
}

function trapDialogFocus(dialog, event) {
  if (event.key !== "Tab") {
    return;
  }
  const focusable = focusableDialogElements(dialog);
  if (!focusable.length) {
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!dialog.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
    return;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openRenameDialog(currentTitle = "", restoreFocusTarget = null) {
  return new Promise((resolve) => {
    const previousActive = restoreFocusTarget instanceof HTMLElement
      ? restoreFocusTarget
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const backdrop = document.createElement("div");
    backdrop.className = "rename-dialog-backdrop";

    const dialog = document.createElement("form");
    dialog.className = "rename-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "rename-dialog-title");

    const title = document.createElement("h2");
    title.id = "rename-dialog-title";
    title.textContent = ft("rename_title");

    const label = document.createElement("label");
    label.className = "rename-dialog-field";
    label.textContent = ft("rename_label");

    const input = document.createElement("input");
    input.type = "text";
    input.value = currentTitle || "";
    label.appendChild(input);

    const actions = document.createElement("div");
    actions.className = "rename-dialog-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-secondary";
    cancel.textContent = ft("rename_cancel");

    const save = document.createElement("button");
    save.type = "submit";
    save.className = "btn";
    save.textContent = ft("rename_save");

    actions.append(cancel, save);
    dialog.append(title, label, actions);
    backdrop.appendChild(dialog);

    const close = (value) => {
      document.removeEventListener("keydown", onKeydown, true);
      backdrop.remove();
      previousActive?.focus?.();
      resolve(value);
    };
    const onKeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(null);
        return;
      }
      trapDialogFocus(dialog, event);
    };

    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        close(null);
      }
    });
    cancel.addEventListener("click", () => close(null));
    dialog.addEventListener("submit", (event) => {
      event.preventDefault();
      close(input.value);
    });
    document.addEventListener("keydown", onKeydown, true);

    document.body.appendChild(backdrop);
    input.focus();
    input.select();
  });
}

function openConfirmDialog(message, {
  confirmLabel = ft("confirm_accept"),
  cancelLabel = ft("confirm_cancel"),
  title = ft("confirm_title"),
  danger = false,
  restoreFocusTarget = null
} = {}) {
  return new Promise((resolve) => {
    const previousActive = restoreFocusTarget instanceof HTMLElement
      ? restoreFocusTarget
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const backdrop = document.createElement("div");
    backdrop.className = "confirm-dialog-backdrop";

    const dialog = document.createElement("form");
    dialog.className = "confirm-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "confirm-dialog-title");
    dialog.setAttribute("aria-describedby", "confirm-dialog-message");

    const heading = document.createElement("h2");
    heading.id = "confirm-dialog-title";
    heading.textContent = title;

    const body = document.createElement("p");
    body.id = "confirm-dialog-message";
    body.className = "confirm-dialog-message";
    body.textContent = message || "";

    const actions = document.createElement("div");
    actions.className = "confirm-dialog-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-secondary";
    cancel.textContent = cancelLabel;

    const confirm = document.createElement("button");
    confirm.type = "submit";
    confirm.className = danger ? "btn btn-danger" : "btn";
    confirm.textContent = confirmLabel;

    actions.append(cancel, confirm);
    dialog.append(heading, body, actions);
    backdrop.appendChild(dialog);

    const close = (value) => {
      document.removeEventListener("keydown", onKeydown, true);
      backdrop.remove();
      previousActive?.focus?.();
      resolve(value);
    };
    const onKeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(false);
        return;
      }
      trapDialogFocus(dialog, event);
    };

    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        close(false);
      }
    });
    cancel.addEventListener("click", () => close(false));
    dialog.addEventListener("submit", (event) => {
      event.preventDefault();
      close(true);
    });
    document.addEventListener("keydown", onKeydown, true);

    document.body.appendChild(backdrop);
    cancel.focus();
  });
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

initSettingsForm({ ft, formatText, showToast });
const analysisStatusPanel = document.getElementById("analysis-status-panel");
let analysisStatusTimer = null;
let analysisRunsState = [];

function checkedAnalysisValues(root, selector) {
  const scope = root || document;
  return [...scope.querySelectorAll(selector)]
    .filter((input) => input.checked && !input.disabled)
    .map((input) => input.value)
    .filter(Boolean);
}

function checkedAnalysisEntries(root, selector) {
  const scope = root || document;
  return [...scope.querySelectorAll(selector)]
    .filter((input) => input.checked && !input.disabled)
    .map((input) => ({
      value: input.value,
      label: input.dataset.analysisLabel || input.value
    }))
    .filter((entry) => entry.value);
}

function analysisSelectionRoot(control) {
  const selectionId = control?.dataset.analysisSelectionId || "";
  return selectionId ? document.getElementById(selectionId) || control : control || document;
}

function activeAnalysisTargets() {
  return new Set(
    analysisRunsState
      .filter((run) => run?.active && run.target)
      .map((run) => String(run.target))
  );
}

function analysisLaunchLabel(targetCount, runningTargets) {
  if (targetCount <= 0) return ft("analysis_launch_select_target");
  if (runningTargets.length) return ft("analysis_launch_running");
  if (targetCount === 1) return ft("analysis_launch_one");
  return formatText(ft("analysis_launch_many"), { targets: targetCount });
}

function analysisLaunchAccessibleLabel(targetEntries, runtimeCount, runningTargets, summaryText) {
  if (runningTargets.length) {
    return `${formatText(ft("analysis_launch_running_title"), { targets: runningTargets.join(", ") })} ${summaryText}`;
  }
  if (!targetEntries.length) return ft("analysis_launch_select_target");
  return formatText(ft("analysis_launch_action"), {
    targets: targetEntries.map((entry) => entry.label).join(", "),
    runtime: runtimeCount
  });
}

function updateAnalysisLaunchControl(control) {
  if (!control) return;
  const selectionRoot = analysisSelectionRoot(control);
  const targetEntries = checkedAnalysisEntries(selectionRoot, ".analysis-target-checkbox");
  const runtimeEntries = checkedAnalysisEntries(selectionRoot, ".analysis-runtime-extension-checkbox");
  const selectedTargets = targetEntries.map((entry) => entry.value);
  const targetCount = selectedTargets.length;
  const runtimeCount = runtimeEntries.length;
  const targetCountNode = control.querySelector("[data-analysis-selected-count]");
  const runtimeCountNode = control.querySelector("[data-runtime-selected-count]");
  const summary = control.querySelector("[data-analysis-launch-summary]");
  const button = control.querySelector('[data-action="analyze-session"]');
  const activeTargets = activeAnalysisTargets();
  const runningTargets = selectedTargets.filter((target) => activeTargets.has(target));
  const summaryText = formatText(ft("analysis_launch_summary"), {
    targets: targetCount,
    runtime: runtimeCount
  });
  const titleText = analysisLaunchAccessibleLabel(
    targetEntries,
    runtimeCount,
    runningTargets,
    summaryText
  );
  if (targetCountNode) targetCountNode.textContent = String(targetCount);
  if (runtimeCountNode) runtimeCountNode.textContent = String(runtimeCount);
  if (summary) {
    summary.textContent = summaryText;
  }
  if (button) {
    button.disabled = button.dataset.unavailable === "true" || targetCount === 0 || runningTargets.length > 0;
    button.textContent = analysisLaunchLabel(targetCount, runningTargets);
    button.title = titleText;
    button.setAttribute("aria-label", titleText);
  }
}

document.querySelectorAll(".analysis-launch-control").forEach((control) => {
  updateAnalysisLaunchControl(control);
  analysisSelectionRoot(control).addEventListener("change", (event) => {
    if (event.target.matches(".analysis-target-checkbox, .analysis-runtime-extension-checkbox")) {
      updateAnalysisLaunchControl(control);
    }
  });
});

function selectAnalysisRuntimeTab(tabSet, tab, focus = false) {
  if (!tabSet || !tab) return;
  const selected = tab.dataset.runtimeTab;
  const tabs = [...tabSet.querySelectorAll("[data-runtime-tab]")];
  const panels = [...tabSet.querySelectorAll("[data-runtime-panel]")];
  for (const item of tabs) {
    const active = item === tab;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-selected", active ? "true" : "false");
    item.tabIndex = active ? 0 : -1;
  }
  for (const panel of panels) {
    const active = panel.dataset.runtimePanel === selected;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  }
  if (focus) tab.focus();
}

document.querySelectorAll("[data-analysis-runtime-tabs]").forEach((tabSet) => {
  const tabs = [...tabSet.querySelectorAll("[data-runtime-tab]")];
  selectAnalysisRuntimeTab(tabSet, tabs.find((tab) => tab.classList.contains("is-active")) || tabs[0]);
  tabSet.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-runtime-tab]");
    if (tab && tabSet.contains(tab)) {
      selectAnalysisRuntimeTab(tabSet, tab);
    }
  });
  tabSet.addEventListener("keydown", (event) => {
    const tab = event.target.closest("[data-runtime-tab]");
    if (!tab || !tabSet.contains(tab)) return;
    const index = tabs.indexOf(tab);
    if (index < 0) return;
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    selectAnalysisRuntimeTab(tabSet, tabs[nextIndex], true);
  });
});

function analysisStateLabel(state) {
  const known = ["prepared", "launched", "completed", "invalid", "failed"];
  return ft(`analysis_status_${known.includes(state) ? state : "unknown"}`);
}

function analysisTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function powerShellQuote(value) {
  return `'${String(value || "").replaceAll("'", "''")}'`;
}

function formatAnalysisCommand(command) {
  if (!command?.executable) return "";
  const invoke = `& ${[command.executable, ...(command.args || [])].map(powerShellQuote).join(" ")}`;
  const workingDirectory = command.cwd
    ? `Set-Location -LiteralPath ${powerShellQuote(command.cwd)}; `
    : "";
  if (command.stdin === "prompt" && command.promptPath) {
    return `${workingDirectory}Get-Content -LiteralPath ${powerShellQuote(command.promptPath)} -Raw | ${invoke}`;
  }
  return `${workingDirectory}${invoke}`;
}

function renderAnalysisRuns(runs) {
  analysisRunsState = Array.isArray(runs) ? runs : [];
  document.querySelectorAll(".analysis-launch-control").forEach((control) => {
    updateAnalysisLaunchControl(control);
  });
  if (!analysisStatusPanel) return;
  const container = document.getElementById("analysis-runs");
  container.replaceChildren();
  if (!Array.isArray(runs) || !runs.length) {
    const empty = document.createElement("p");
    empty.className = "analysis-run-empty";
    empty.textContent = ft("analysis_no_runs");
    container.appendChild(empty);
    return;
  }

  for (const run of runs) {
    const card = document.createElement("article");
    card.className = `analysis-run analysis-run-${run.state || "unknown"}`;

    const header = document.createElement("div");
    header.className = "analysis-run-header";
    const title = document.createElement("div");
    title.className = "analysis-run-title";
    const badge = document.createElement("span");
    badge.className = `analysis-run-badge analysis-run-badge-${run.state || "unknown"}`;
    badge.textContent = analysisStateLabel(run.state);
    const target = document.createElement("strong");
    target.textContent = formatText(ft("analysis_target"), { target: run.target || "skills" });
    title.append(badge, target);
    const time = document.createElement("time");
    const displayTime = run.completedAt || run.launchedAt || run.createdAt;
    time.dateTime = displayTime || "";
    time.textContent = run.completedAt
      ? formatText(ft("analysis_finished_at"), { time: analysisTimestamp(run.completedAt) })
      : formatText(ft("analysis_started_at"), { time: analysisTimestamp(run.launchedAt || run.createdAt) });
    header.append(title, time);
    card.appendChild(header);

    const runId = document.createElement("code");
    runId.className = "analysis-run-id";
    runId.textContent = run.runId || "";
    card.appendChild(runId);

    if (run.active) {
      const waiting = document.createElement("p");
      waiting.className = `analysis-run-waiting${run.stalled ? " analysis-run-waiting-stalled" : ""}`;
      waiting.textContent = run.stalled
        ? formatText(ft("analysis_waiting_no_output"), { seconds: run.waitingSeconds || 0 })
        : ft("analysis_waiting");
      card.appendChild(waiting);
    }

    const details = document.createElement("div");
    details.className = "analysis-run-details";
    if (run.validation) {
      const counts = document.createElement("span");
      counts.textContent = formatText(ft("analysis_counts"), {
        cases: run.validation.evaluationCaseCount || 0,
        proposals: run.validation.artifactProposalCount || 0
      });
      details.appendChild(counts);
      const exitCode = document.createElement("span");
      exitCode.textContent = formatText(ft("analysis_exit_code"), {
        code: run.validation.processExitCode ?? 0
      });
      details.appendChild(exitCode);
    }
    if (run.hasReport) {
      const report = document.createElement("span");
      report.className = "analysis-report-ready";
      report.textContent = ft("analysis_report_ready");
      details.appendChild(report);
    }
    card.appendChild(details);

    const outputDefinitions = [
      {
        id: "report",
        label: ft("analysis_output_report"),
        help: ft("analysis_output_report_help"),
        primary: true
      },
      {
        id: "evaluation",
        label: ft("analysis_output_evaluation"),
        help: ft("analysis_output_evaluation_help")
      },
      {
        id: "proposals",
        label: ft("analysis_output_proposals"),
        help: ft("analysis_output_proposals_help")
      }
    ];
    const availableOutputs = outputDefinitions.filter(
      (definition) => run.outputs?.[definition.id]?.available
    );
    if (availableOutputs.length) {
      const outputs = document.createElement("section");
      outputs.className = "analysis-run-outputs";
      const outputsHeader = document.createElement("div");
      outputsHeader.className = "analysis-run-outputs-header";
      const outputsTitle = document.createElement("h3");
      outputsTitle.textContent = ft("analysis_outputs_title");
      const outputsHelp = document.createElement("p");
      outputsHelp.textContent = ft("analysis_outputs_help");
      outputsHeader.append(outputsTitle, outputsHelp);
      outputs.appendChild(outputsHeader);

      const outputList = document.createElement("div");
      outputList.className = "analysis-output-list";
      const outputBase = `/api/${analysisStatusPanel.dataset.provider}/session/${encodeURIComponent(analysisStatusPanel.dataset.sessionId)}/analyses/${encodeURIComponent(run.runId)}/outputs`;
      for (const definition of availableOutputs) {
        const item = document.createElement("div");
        item.className = `analysis-output-item${definition.primary ? " analysis-output-report" : ""}`;
        const description = document.createElement("div");
        description.className = "analysis-output-description";
        const viewLink = document.createElement("a");
        viewLink.className = "analysis-output-link";
        viewLink.href = `${outputBase}/${definition.id}`;
        viewLink.target = "_blank";
        viewLink.rel = "noopener";
        viewLink.textContent = definition.label;
        const help = document.createElement("p");
        help.textContent = definition.help;
        description.append(viewLink, help);

        const downloadLink = document.createElement("a");
        downloadLink.className = "analysis-output-download";
        downloadLink.href = `${outputBase}/${definition.id}?download=1`;
        downloadLink.textContent = ft("analysis_output_download");
        item.append(description, downloadLink);
        outputList.appendChild(item);
      }
      outputs.appendChild(outputList);
      card.appendChild(outputs);
    }

    const diagnosticDefinitions = [
      { id: "stdout", label: ft("analysis_diagnostics_stdout") },
      { id: "stderr", label: ft("analysis_diagnostics_stderr") }
    ];
    const availableDiagnostics = diagnosticDefinitions.filter(
      (definition) => run.diagnostics?.[definition.id]?.available
    );
    const canRecoverRun = run.active || run.state === "failed" || run.state === "invalid";
    if (canRecoverRun && (availableDiagnostics.length || run.command?.executable)) {
      const recovery = document.createElement("section");
      recovery.className = `analysis-run-recovery${run.stalled ? " analysis-run-recovery-stalled" : ""}`;
      const recoveryTitle = document.createElement("h3");
      recoveryTitle.textContent = ft("analysis_recovery_title");
      const recoveryActions = document.createElement("div");
      recoveryActions.className = "analysis-run-recovery-actions";
      const diagnosticBase = `/api/${analysisStatusPanel.dataset.provider}/session/${encodeURIComponent(analysisStatusPanel.dataset.sessionId)}/analyses/${encodeURIComponent(run.runId)}/diagnostics`;
      for (const definition of availableDiagnostics) {
        const link = document.createElement("a");
        link.className = "action-btn analysis-run-recovery-action";
        link.href = `${diagnosticBase}/${definition.id}`;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = definition.label;
        recoveryActions.appendChild(link);
      }
      const commandText = formatAnalysisCommand(run.command);
      if (commandText) {
        const copyCommand = document.createElement("button");
        copyCommand.type = "button";
        copyCommand.className = "action-btn analysis-run-recovery-action";
        copyCommand.dataset.action = "copy-analysis-command";
        copyCommand.dataset.id = analysisStatusPanel.dataset.sessionId;
        copyCommand.dataset.command = commandText;
        copyCommand.textContent = ft("analysis_copy_command");
        recoveryActions.appendChild(copyCommand);
      }
      recovery.append(recoveryTitle, recoveryActions);
      card.appendChild(recovery);
    }

    const terminalLaunchAllowed = analysisStatusPanel.dataset.terminalLaunch === "true";
    if (run.implementation || (terminalLaunchAllowed && run.implementationAvailable)) {
      const implementation = document.createElement("section");
      implementation.className = "analysis-implementation";
      const implementationCopy = document.createElement("div");
      implementationCopy.className = "analysis-implementation-copy";
      const implementationTitle = document.createElement("h3");
      implementationTitle.textContent = ft("analysis_implementation_title");
      const implementationHelp = document.createElement("p");
      if (run.implementation?.state === "launched") {
        implementationHelp.textContent = formatText(ft("analysis_implementation_launched"), {
          time: analysisTimestamp(run.implementation.launchedAt)
        });
      } else if (run.implementation?.state === "prepared") {
        implementationHelp.textContent = ft("analysis_implementation_prepared");
      } else {
        implementationHelp.textContent = ft("analysis_implementation_ready");
      }
      implementationCopy.append(implementationTitle, implementationHelp);
      implementation.appendChild(implementationCopy);
      if (terminalLaunchAllowed && run.implementationAvailable) {
        const launchButton = document.createElement("button");
        launchButton.type = "button";
        launchButton.className = "action-btn action-btn-primary analysis-implementation-launch";
        launchButton.dataset.action = "implement-analysis";
        launchButton.dataset.id = analysisStatusPanel.dataset.sessionId;
        launchButton.dataset.runId = run.runId || "";
        launchButton.textContent = ft("analysis_implementation_launch");
        implementation.appendChild(launchButton);
      }
      card.appendChild(implementation);
    }

    if (run.validation?.errors?.length) {
      const errorBlock = document.createElement("details");
      errorBlock.className = "analysis-run-errors";
      errorBlock.open = run.state === "failed" || run.state === "invalid";
      const summary = document.createElement("summary");
      summary.textContent = `${ft("analysis_validation_errors")} (${run.validation.errors.length})`;
      const list = document.createElement("ul");
      for (const error of run.validation.errors) {
        const item = document.createElement("li");
        item.textContent = error;
        list.appendChild(item);
      }
      errorBlock.append(summary, list);
      card.appendChild(errorBlock);
    }

    const folderLabel = document.createElement("span");
    folderLabel.className = "analysis-run-folder-label";
    folderLabel.textContent = ft("analysis_run_folder");
    const folder = document.createElement("code");
    folder.className = "analysis-run-folder";
    folder.textContent = run.runDir || "";
    card.append(folderLabel, folder);
    container.appendChild(card);
  }
}

async function refreshAnalysisRuns(scheduleNext = true) {
  if (!analysisStatusPanel) return;
  const refreshButton = document.getElementById("analysis-status-refresh");
  refreshButton?.setAttribute("disabled", "");
  try {
    const provider = analysisStatusPanel.dataset.provider;
    const sessionId = analysisStatusPanel.dataset.sessionId;
    const response = await fetch(`/api/${provider}/session/${encodeURIComponent(sessionId)}/analyses`);
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }
    renderAnalysisRuns(result.runs);
    if (analysisStatusTimer) clearTimeout(analysisStatusTimer);
    if (scheduleNext && result.runs?.some((run) => run.active)) {
      analysisStatusTimer = setTimeout(() => refreshAnalysisRuns(true), 2000);
    }
  } catch {
    showToast(ft("analysis_status_error"), "error");
  } finally {
    refreshButton?.removeAttribute("disabled");
  }
}

if (analysisStatusPanel) {
  try {
    const initial = JSON.parse(document.getElementById("analysis-runs-initial")?.textContent || "[]");
    renderAnalysisRuns(initial);
    if (initial.some((run) => run.active)) {
      analysisStatusTimer = setTimeout(() => refreshAnalysisRuns(true), 2000);
    }
  } catch {
    renderAnalysisRuns([]);
  }
  document.getElementById("analysis-status-refresh")?.addEventListener("click", () => {
    refreshAnalysisRuns(true);
  });
}

function isEditableShortcutTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName;
  return tagName === "INPUT"
    || tagName === "TEXTAREA"
    || tagName === "SELECT"
    || target.isContentEditable;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditableShortcutTarget(e.target)) {
    e.preventDefault();
    const transcriptSearch = document.querySelector("[data-session-search]");
    if (transcriptSearch) {
      transcriptSearch.open = true;
      transcriptSearch.querySelector("[data-session-search-input]")?.focus();
    } else {
      document.getElementById("search-input")?.focus();
    }
  }
  if (e.key === "Escape") {
    const flowPanel = document.getElementById("session-flow-panel");
    const flowInspector = flowPanel?.querySelector("[data-flow-inspector]");
    if (flowInspector && !flowInspector.classList.contains("hidden")) {
      e.preventDefault();
      flowInspector.querySelector("[data-flow-inspector-close]")?.click();
      return;
    }
    if (flowPanel && !flowPanel.classList.contains("hidden")) {
      flowPanel.classList.add("hidden");
      flowPanel.setAttribute("aria-hidden", "true");
      document.querySelectorAll(".flow-open-btn[aria-expanded='true']").forEach((btn) => {
        btn.setAttribute("aria-expanded", "false");
      });
    }
    const transcriptSearch = document.querySelector("[data-session-search]");
    if (transcriptSearch?.open) transcriptSearch.open = false;
    document.activeElement.blur();
  }
});

if (typeof hljs !== "undefined") {
  hljs.highlightAll();
}

const activeSidebarCard = document.querySelector(".sidebar .session-card.active");
if (activeSidebarCard) {
  activeSidebarCard.scrollIntoView({ block: "center", behavior: "instant" });
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".star-btn");
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const id = btn.dataset.id;
  if (!id) return;
  try {
    const res = await fetch(`/api/${PROVIDER}/session/${encodeURIComponent(id)}/star`, { method: "POST" });
    const data = await res.json();
    btn.classList.toggle("starred", data.starred);
    const label = data.starred ? ft("starred_label") : ft("star_label");
    btn.textContent = btn.dataset.starFormat === "icon" ? (data.starred ? "★" : "☆") : label;
    btn.setAttribute("aria-label", label);
    btn.title = label;
    const card = btn.closest(".session-card");
    if (card) card.classList.toggle("starred", data.starred);
    showToast(data.starred ? ft("toast_starred") : ft("toast_unstarred"), data.starred ? "success" : "info");
  } catch (err) {
    showToast(ft("toast_error"), "error");
  }
});

document.addEventListener("click", (e) => {
  const trigger = e.target.closest(".card-menu-trigger");
  if (trigger) {
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll(".card-menu:not(.hidden)").forEach((menu) => {
      if (menu.dataset.id !== trigger.dataset.id) menu.classList.add("hidden");
    });
    const menu = trigger.nextElementSibling;
    if (menu) menu.classList.toggle("hidden");
    return;
  }
  if (!e.target.closest(".card-menu")) {
    document.querySelectorAll(".card-menu:not(.hidden)").forEach((menu) => {
      menu.classList.add("hidden");
    });
  }
});

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  if (!action) return;

  if (action === "copy-analysis-command") {
    const command = btn.dataset.command || "";
    if (!command) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      await copyText(command);
      showToast(ft("copied"), "success");
    } catch {
      showToast(ft("toast_error"), "error");
    }
    return;
  }

  if (action === "copy-resume-command") {
    const command = btn.dataset.command || "";
    if (!command) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      await copyText(command);
      showToast(ft("copied"), "success");
    } catch {
      showToast(ft("toast_error"), "error");
    }
    return;
  }

  const id = btn.dataset.id;
  if (!id) return;

  if (btn.classList.contains("batch-action")) return;

  e.preventDefault();
  e.stopPropagation();

  if (action === "copy-session-id") {
    try {
      await copyText(id);
      showToast(ft("copied"), "success");
    } catch {
      showToast(ft("toast_error"), "error");
    }
    return;
  }

  if (action === "resume-session") {
    try {
      const res = await fetch(`/api/${PROVIDER}/session/${encodeURIComponent(id)}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      showToast(ft("resume_opened"), "success");
    } catch {
      showToast(ft("resume_disabled"), "error");
    }
    return;
  }

  if (action === "analyze-session") {
    const control = btn.closest(".analysis-launch-control");
    const selectionRoot = analysisSelectionRoot(control);
    const targetEntries = checkedAnalysisEntries(selectionRoot, ".analysis-target-checkbox");
    const targets = targetEntries.map((entry) => entry.value);
    if (!targets.length) {
      const fallbackTarget = btn.dataset.target || "";
      if (fallbackTarget) targets.push(fallbackTarget);
    }
    if (!targets.length) {
      showToast(ft("analysis_select_target"), "error");
      return;
    }
    const runningTargets = targets.filter((target) => activeAnalysisTargets().has(target));
    if (runningTargets.length) {
      showToast(formatText(ft("analysis_launch_running_title"), { targets: runningTargets.join(", ") }), "error");
      updateAnalysisLaunchControl(control);
      return;
    }
    const hasRuntimePicker = Boolean(selectionRoot?.querySelector(".analysis-runtime-extension-checkbox"));
    const runtimeEntries = checkedAnalysisEntries(selectionRoot, ".analysis-runtime-extension-checkbox");
    const runtimeExtensionIds = hasRuntimePicker
      ? runtimeEntries.map((entry) => entry.value)
      : null;
    const targetLabels = targetEntries.length
      ? targetEntries.map((entry) => entry.label)
      : targets;
    const runtimeLabels = runtimeEntries.length
      ? runtimeEntries.map((entry) => entry.label)
      : [ft("analysis_none")];
    const confirmed = await openConfirmDialog(formatText(ft("analysis_launch_confirm"), {
      count: targets.length,
      targets: targetLabels.join(", "),
      runtime: runtimeLabels.join(", ")
    }), {
      confirmLabel: ft("analysis_launch_confirm_button"),
      title: ft("analysis_launch_confirm_title"),
      restoreFocusTarget: btn
    });
    if (!confirmed) return;
    btn.disabled = true;
    try {
      for (const target of targets) {
        const body = { target };
        if (runtimeExtensionIds) {
          body.runtimeExtensionIds = runtimeExtensionIds;
        }
        const res = await fetch(`/api/${PROVIDER}/session/${encodeURIComponent(id)}/analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const result = await res.json();
        if (!res.ok || !result.ok) {
          const requestError = new Error(result.error || `HTTP ${res.status}`);
          requestError.status = res.status;
          throw requestError;
        }
      }
      showToast(
        targets.length > 1
          ? formatText(ft("analysis_opened_many"), { count: targets.length })
          : ft("analysis_opened"),
        "success"
      );
      await refreshAnalysisRuns(true);
      analysisStatusPanel?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } catch (error) {
      if (error?.status === 409) {
        await refreshAnalysisRuns(true);
      }
      const message = error?.status >= 400 && error.status < 500 && error.message
        ? error.message
        : ft("analysis_disabled");
      showToast(message, "error");
    } finally {
      updateAnalysisLaunchControl(control);
    }
    return;
  }

  if (action === "implement-analysis") {
    const runId = btn.dataset.runId || "";
    if (!runId) {
      return;
    }
    const confirmed = await openConfirmDialog(ft("analysis_implementation_confirm"), {
      confirmLabel: ft("analysis_implementation_launch"),
      restoreFocusTarget: btn
    });
    if (!confirmed) {
      return;
    }
    const wasDisabled = btn.disabled;
    btn.disabled = true;
    try {
      const res = await fetch(`/api/${PROVIDER}/session/${encodeURIComponent(id)}/analyses/${encodeURIComponent(runId)}/implement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      const result = await res.json();
      if (!res.ok || !result.ok) {
        throw new Error(result.error || `HTTP ${res.status}`);
      }
      showToast(ft("analysis_implementation_opened"), "success");
      await refreshAnalysisRuns(true);
    } catch {
      showToast(ft("analysis_implementation_disabled"), "error");
    } finally {
      btn.disabled = wasDisabled;
    }
    return;
  }

  if (action === "rename") {
    const card = btn.closest(".session-card");
    const restoreFocusTarget = card?.querySelector(".card-menu-trigger") || btn;
    document.querySelectorAll(".card-menu:not(.hidden)").forEach((menu) => {
      menu.classList.add("hidden");
    });
    const current = card
      ? card.querySelector(".session-card-title")?.textContent || ""
      : document.querySelector(".session-header h1")?.textContent || "";
    const newTitle = await openRenameDialog(current, restoreFocusTarget);
    if (newTitle === null) return;
    try {
      await fetch(`/api/${PROVIDER}/session/${encodeURIComponent(id)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle })
      });
      queueToast(ft("toast_renamed"), "success");
      location.reload();
    } catch {
      showToast(ft("toast_error"), "error");
    }
    return;
  }

  if (action === "delete") {
    const card = btn.closest(".session-card");
    const restoreFocusTarget = card?.querySelector(".card-menu-trigger") || btn;
    document.querySelectorAll(".card-menu:not(.hidden)").forEach((menu) => {
      menu.classList.add("hidden");
    });
    const confirmed = await openConfirmDialog(ft("delete_confirm"), {
      confirmLabel: ft("confirm_delete"),
      danger: true,
      restoreFocusTarget
    });
    if (!confirmed) return;
    try {
      await fetch(`/api/${PROVIDER}/session/${encodeURIComponent(id)}/delete`, { method: "POST" });
      queueToast(ft("toast_deleted"), "success");
      if (document.querySelector(".session-actions")) {
        location.href = `/${PROVIDER}`;
      } else {
        location.reload();
      }
    } catch {
      showToast(ft("toast_error"), "error");
    }
    return;
  }

  if (action === "restore") {
    try {
      await fetch(`/api/${PROVIDER}/session/${encodeURIComponent(id)}/restore`, { method: "POST" });
      queueToast(ft("toast_restored"), "success");
      location.reload();
    } catch {
      showToast(ft("toast_error"), "error");
    }
    return;
  }

  if (action === "permanent-delete") {
    const confirmed = await openConfirmDialog(ft("permanent_delete_confirm"), {
      confirmLabel: ft("confirm_permanent_delete"),
      danger: true,
      restoreFocusTarget: btn
    });
    if (!confirmed) return;
    try {
      await fetch(`/api/${PROVIDER}/session/${encodeURIComponent(id)}/permanent-delete`, { method: "POST" });
      queueToast(ft("toast_permanent_deleted"), "success");
      location.reload();
    } catch {
      showToast(ft("toast_error"), "error");
    }
    return;
  }

});

// List controls apply immediately, while the keyword field remains explicit:
// Enter or Apply commits it. This keeps an unfinished search out of an
// automatic provider/project/sort update.
(function initSessionFilterAutoApply() {
  const filter = document.querySelector("[data-session-filter]");
  if (!filter) return;

  const keyword = filter.querySelector("input[name='q']");
  filter.addEventListener("change", (event) => {
    const control = event.target;
    if (!control?.matches?.("[data-session-filter-auto]")) return;

    const params = new URLSearchParams();
    for (const [name, value] of new FormData(filter).entries()) {
      if (name !== "q") params.append(name, String(value));
    }

    const appliedKeyword = keyword?.defaultValue || "";
    if (appliedKeyword) params.set("q", appliedKeyword);

    const destination = new URL(filter.action, window.location.origin);
    destination.search = params.toString();
    window.location.assign(`${destination.pathname}${destination.search}${destination.hash}`);
  });
})();

const toggleBatchBtn = document.getElementById("toggle-batch");
const batchBar = document.getElementById("batch-bar");
const sessionList = document.getElementById("session-list");
const batchCountNum = document.getElementById("batch-count-num");
const selectAllCheckbox = document.getElementById("select-all");
const batchCancelBtn = document.getElementById("batch-cancel");

let batchMode = false;

function updateBatchCount() {
  const checkboxes = [...document.querySelectorAll(".card-checkbox")];
  const checked = document.querySelectorAll(".card-checkbox:checked").length;
  if (batchCountNum) batchCountNum.textContent = checked;
  if (selectAllCheckbox) {
    selectAllCheckbox.checked = checkboxes.length > 0 && checked === checkboxes.length;
    selectAllCheckbox.indeterminate = checked > 0 && checked < checkboxes.length;
  }
  document.querySelectorAll(".batch-action[data-action]").forEach((btn) => {
    btn.disabled = checked === 0;
  });
}

function setBatchMode(on) {
  batchMode = on;
  if (batchBar) batchBar.classList.toggle("hidden", !on);
  if (sessionList) sessionList.classList.toggle("batch-mode", on);
  if (toggleBatchBtn) toggleBatchBtn.textContent = on ? ft("cancel_manage") : ft("manage");
  if (!on) {
    document.querySelectorAll(".card-checkbox:checked").forEach((cb) => {
      cb.checked = false;
    });
  }
  updateBatchCount();
}

if (toggleBatchBtn) {
  toggleBatchBtn.addEventListener("click", () => setBatchMode(!batchMode));
}

if (batchCancelBtn) {
  batchCancelBtn.addEventListener("click", () => setBatchMode(false));
}

if (selectAllCheckbox) {
  selectAllCheckbox.addEventListener("change", () => {
    document.querySelectorAll(".card-checkbox").forEach((cb) => {
      cb.checked = selectAllCheckbox.checked;
    });
    updateBatchCount();
  });
}

document.addEventListener("change", (e) => {
  if (e.target.classList.contains("card-checkbox")) updateBatchCount();
});

document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".batch-action");
  if (!btn || btn.id === "batch-cancel") return;
  const action = btn.dataset.action;
  if (!action) return;
  const ids = [...document.querySelectorAll(".card-checkbox:checked")].map((cb) => cb.dataset.id);
  if (!ids.length) {
    showToast(ft("select_first"), "error");
    return;
  }
  if (action === "delete") {
    const confirmed = await openConfirmDialog(ft("batch_delete_confirm").replace("{count}", ids.length), {
      confirmLabel: ft("confirm_delete"),
      danger: true,
      restoreFocusTarget: btn
    });
    if (!confirmed) return;
  }

  try {
    await fetch(`/api/${PROVIDER}/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ids })
    });
    queueToast(ft("toast_batch_done").replace("{count}", ids.length), "success");
    location.reload();
  } catch {
    showToast(ft("toast_error"), "error");
  }
});

function formatTimeClient(ts) {
  const value = Number(ts);
  if (!value) {
    return "";
  }

  const diff = Date.now() - value;
  if (diff < 60_000) return ft("time_just_now");
  if (diff < 3_600_000) return ft("time_minutes_ago").replace("{n}", Math.floor(diff / 60_000));
  if (diff < 86_400_000) return ft("time_hours_ago").replace("{n}", Math.floor(diff / 3_600_000));
  if (diff < 7 * 86_400_000) return ft("time_days_ago").replace("{n}", Math.floor(diff / 86_400_000));
  return new Date(value).toLocaleDateString();
}

function escapeHtmlClient(str) {
  const el = document.createElement("div");
  el.textContent = str == null ? "" : String(str);
  return el.innerHTML;
}

function renderSessionCard(s) {
  const sessionProvider = s.provider || PROVIDER;
  const id = escapeHtmlClient(s.id);
  const encodedProvider = encodeURIComponent(sessionProvider);
  const encodedSessionId = encodeURIComponent(s.id || "");
  const exportFilePrefix = escapeHtmlClient(`session-${String(s.id || "").slice(0, 8)}`);
  const title = escapeHtmlClient(s.title || s.id);
  const directory = escapeHtmlClient(s.directory || "");
  const timeUpdated = Number(s.time_updated) || Date.now();
  const classes = ["session-card"];
  if (s.starred) classes.push("starred");
  const changedFiles = Number(s.summary_files) || 0;
  const additions = Number(s.summary_additions) || 0;
  const deletions = Number(s.summary_deletions) || 0;
  const stats = [
    changedFiles > 0 ? `<span>${ft("card_files").replace("{count}", String(changedFiles))}</span>` : "",
    additions > 0 ? `<span class="additions">+${additions}</span>` : "",
    deletions > 0 ? `<span class="deletions">-${deletions}</span>` : ""
  ].filter(Boolean).join("");
  const analysisBadge = s.analysisTitled ? `<span class="session-kind-badge">${escapeHtmlClient(ft("session_analysis_badge"))}</span>` : "";
  let providerNames = {};
  try { providerNames = JSON.parse(scrollSentinel?.dataset.providerNames || "{}"); } catch {}
  const providerBadge = scrollSentinel?.dataset.global === "true" ? `<span class="session-provider-badge" title="${escapeHtmlClient(sessionProvider)}">${escapeHtmlClient(providerNames[sessionProvider] || sessionProvider)}</span>` : "";
  const returnTo = scrollSentinel?.dataset.returnTo || "";
  const detailHref = `/${encodedProvider}/session/${encodeURIComponent(s.id)}${returnTo ? `?from=${encodeURIComponent(returnTo)}` : ""}`;

  const actionsHtml = IS_MANAGEABLE_PROVIDER ? `
    <div class="card-actions">
      <button class="star-btn ${s.starred ? "starred" : ""}" type="button" data-star-format="icon" data-id="${id}" title="${escapeHtmlClient(s.starred ? ft("starred_label") : ft("star_label"))}" aria-label="${escapeHtmlClient(s.starred ? ft("starred_label") : ft("star_label"))}">
        ${s.starred ? "★" : "☆"}
      </button>
      <button class="card-menu-trigger" type="button" data-id="${id}" title="${escapeHtmlClient(ft("menu_more"))}" aria-label="${escapeHtmlClient(ft("menu_more"))}">⋮</button>
      <div class="card-menu hidden" data-id="${id}">
        <button type="button" data-action="rename" data-id="${id}">${ft("menu_rename")}</button>
        <button type="button" data-action="copy-session-id" data-id="${id}" title="${escapeHtmlClient(ft("copy_session_id"))}" aria-label="${escapeHtmlClient(ft("copy_session_id"))}">${ft("menu_copy_session_id")}</button>
        <a href="/api/${encodedProvider}/session/${encodedSessionId}/export?format=md" download="${exportFilePrefix}.md">${ft("menu_export_md")}</a>
        <a href="/api/${encodedProvider}/session/${encodedSessionId}/export?format=json" download="${exportFilePrefix}.json">${ft("menu_export_json")}</a>
        <button type="button" data-action="delete" data-id="${id}" class="menu-danger">${ft("menu_delete")}</button>
      </div>
    </div>
  ` : "";

  return `<article class="${classes.join(" ")}" data-session-id="${id}">
    ${IS_MANAGEABLE_PROVIDER ? `<input type="checkbox" class="card-checkbox" data-id="${id}">` : ""}
    <div class="session-card-content">
      <header class="session-card-header">
        <div class="session-card-title-stack">
          <a href="${detailHref}" class="session-card-title-link">
            <h2 class="session-card-title">${title}</h2>
          </a>
          ${analysisBadge}
          ${providerBadge}
        </div>
        <time class="session-card-time" datetime="${new Date(timeUpdated).toISOString()}">${escapeHtmlClient(formatTimeClient(timeUpdated))}</time>
      </header>
      <p class="session-card-directory">${directory}</p>
      ${stats ? `<footer class="session-card-stats">${stats}</footer>` : ""}
    </div>
    ${actionsHtml}
  </article>`;
}

const scrollSentinel = document.getElementById("scroll-sentinel");
if (scrollSentinel && sessionList) {
  let scrollOffset = Number(scrollSentinel.dataset.offset) || 0;
  const scrollTotal = Number(scrollSentinel.dataset.total) || 0;
  const scrollRange = scrollSentinel.dataset.range || "";
  const scrollQuery = scrollSentinel.dataset.query || "";
  const scrollProject = scrollSentinel.dataset.project || "";
  const scrollMode = scrollSentinel.dataset.mode || "list";
  const scrollSort = scrollSentinel.dataset.sort || "";
  const scrollKind = scrollSentinel.dataset.kind || "";
  const scrollStarred = scrollSentinel.dataset.starred || "";
  const scrollProviders = scrollSentinel.dataset.providers || "";
  const isGlobalSessions = scrollSentinel.dataset.global === "true";
  let isLoading = false;
  let observer = null;

  const setSentinelState = (className, text, disabled = false) => {
    scrollSentinel.className = className;
    scrollSentinel.textContent = text;
    scrollSentinel.disabled = disabled;
  };

  const loadMoreSessions = async () => {
    if (isLoading || scrollOffset >= scrollTotal) {
      return;
    }

    isLoading = true;
    setSentinelState("scroll-loading", ft("scroll_loading"), true);

    try {
      const params = new URLSearchParams({
        offset: String(scrollOffset),
        limit: "30"
      });
      if (scrollRange) params.set("range", scrollRange);
      if (scrollQuery) params.set("q", scrollQuery);
      if (scrollProject) params.set("project", scrollProject);
      if (scrollMode) params.set("mode", scrollMode);
      if (scrollSort) params.set("sort", scrollSort);
      if (scrollKind) params.set("kind", scrollKind);
      if (scrollStarred) params.set("starred", scrollStarred);
      if (scrollProviders) scrollProviders.split(",").filter(Boolean).forEach((provider) => params.append("provider", provider));

      const res = await fetch(`${isGlobalSessions ? "/api/sessions" : `/api/${PROVIDER}/sessions`}?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      const markup = Array.isArray(data.sessions) ? data.sessions.map(renderSessionCard).join("") : "";
      sessionList.insertAdjacentHTML("beforeend", markup);
      updateBatchCount();
      scrollOffset = (Number(data.offset) || 0) + (Array.isArray(data.sessions) ? data.sessions.length : 0);

      if (!data.hasMore || scrollOffset >= scrollTotal) {
        observer?.disconnect();
        setSentinelState("scroll-done", ft("scroll_all_loaded"), true);
      } else {
        setSentinelState("scroll-load-more", ft("scroll_load_more"));
      }
    } catch {
      setSentinelState("scroll-load-more", ft("scroll_load_more"));
      showToast(ft("toast_error"), "error");
    } finally {
      isLoading = false;
    }
  };

  scrollSentinel.addEventListener("click", loadMoreSessions);

  if (scrollOffset < scrollTotal) {
    setSentinelState("scroll-load-more", ft("scroll_load_more"));
    if ("IntersectionObserver" in window) {
      observer = new IntersectionObserver(async (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          await loadMoreSessions();
        }
      }, { rootMargin: "200px" });
      observer.observe(scrollSentinel);
    }
  } else {
    setSentinelState("scroll-done", ft("scroll_all_loaded"), true);
  }
}


initSessionWorkbench({ ft, formatText, showToast });
initEnhancements({ ft, formatText, showToast, escapeHtmlClient });
