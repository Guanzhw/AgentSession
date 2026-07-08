import path from "node:path";

import { escapeHtml } from "../markdown.js";
import { t } from "../i18n.js";
import {
  BUILTIN_ANALYSIS_TARGETS,
  getProviderAnalysisTarget
} from "../analysis-targets.js";
import { layout } from "./layout.js";

const builtinTargets = BUILTIN_ANALYSIS_TARGETS;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringList(value, fallback = []) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : fallback;
}

function checked(value) {
  return value ? "checked" : "";
}

function extractModel(args) {
  const index = args.indexOf("--model");
  return index >= 0 && typeof args[index + 1] === "string" ? args[index + 1] : "";
}

function withoutModelArgs(args) {
  const index = args.indexOf("--model");
  if (index < 0) return args;
  return [...args.slice(0, index), ...args.slice(index + 2)];
}

function resetButton(reset) {
  return reset
    ? `<button type="button" class="settings-reset-btn" data-reset-setting="${escapeHtml(reset)}">${t("settings.reset_default")}</button>`
    : "";
}

function field({ id, label, value = "", help = "", type = "text", placeholder = "", reset = "" }) {
  return `
    <div class="settings-field">
      <div class="settings-field-heading">
        <label for="${id}">${escapeHtml(label)}</label>
        ${resetButton(reset)}
      </div>
      <input id="${id}" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">
      ${help ? `<small>${escapeHtml(help)}</small>` : ""}
    </div>
  `;
}

function selectField({ id, label, options = [], help = "", reset = "" }) {
  return `
    <div class="settings-field">
      <div class="settings-field-heading">
        <label for="${id}">${escapeHtml(label)}</label>
        ${resetButton(reset)}
      </div>
      <select id="${id}">
        ${options.map((option) => `
          <option value="${escapeHtml(option.value)}" ${option.selected ? "selected" : ""}>
            ${escapeHtml(option.label)}
          </option>
        `).join("")}
      </select>
      ${help ? `<small>${escapeHtml(help)}</small>` : ""}
    </div>
  `;
}

function textareaField({ id, label, values = [], help = "", placeholder = "", reset = "" }) {
  return `
    <div class="settings-field">
      <div class="settings-field-heading">
        <label for="${id}">${escapeHtml(label)}</label>
        ${resetButton(reset)}
      </div>
      <textarea id="${id}" rows="5" placeholder="${escapeHtml(placeholder)}">${escapeHtml(values.join("\n"))}</textarea>
      ${help ? `<small>${escapeHtml(help)}</small>` : ""}
    </div>
  `;
}

function switchField({ id, label, description, enabled, reset = "" }) {
  return `
    <div class="settings-switch-row">
      <label class="settings-switch" for="${id}">
        <span class="settings-switch-copy">
          <strong>${escapeHtml(label)}</strong>
          <small>${escapeHtml(description)}</small>
        </span>
        <input id="${id}" type="checkbox" ${checked(enabled)}>
        <span class="settings-switch-track" aria-hidden="true"></span>
      </label>
      ${resetButton(reset)}
    </div>
  `;
}

function artifactValues(values) {
  const entries = stringList(values);
  return entries.length
    ? entries.map((value) => `<code>${escapeHtml(value)}</code>`).join("")
    : `<span>${t("settings.artifact_none")}</span>`;
}

export function renderSettingsPage({
  configPath,
  configDocument,
  terminalLaunchAllowed = false,
  provider = "opencode",
  providerName = provider,
  resumeDefault = null,
  analysisDefaultCommand = null,
  providers = [],
  providerAvailable = true,
  manageable = false
}) {
  const config = asObject(configDocument.config);
  const analysis = asObject(config.analysis);
  const sharedDefaultTargetId = Array.isArray(analysis.defaultTargets) && analysis.defaultTargets.length
    ? analysis.defaultTargets.find((id) => typeof id === "string" && id)
    : typeof analysis.defaultTarget === "string" && analysis.defaultTarget
      ? analysis.defaultTarget
      : "skills";
  const analysisProviders = asObject(analysis.providers);
  const analysisProvider = asObject(analysisProviders[provider]);
  const defaultTargetId = Array.isArray(analysisProvider.defaultTargets) && analysisProvider.defaultTargets.length
    ? analysisProvider.defaultTargets.find((id) => typeof id === "string" && id)
    : typeof analysisProvider.defaultTarget === "string" && analysisProvider.defaultTarget
      ? analysisProvider.defaultTarget
      : sharedDefaultTargetId;
  const targetId = defaultTargetId || "skills";
  const targets = asObject(analysis.targets);
  const providerTargets = asObject(analysisProvider.targets);
  const target = getProviderAnalysisTarget(analysis, provider, targetId);
  const targetIds = [...new Set([
    ...Object.keys(builtinTargets),
    ...Object.keys(targets),
    ...Object.keys(providerTargets),
    targetId
  ])];
  const targetOptions = targetIds.map((id) => {
    const builtin = builtinTargets[id];
    const effective = getProviderAnalysisTarget(analysis, provider, id);
    const label = typeof effective.label === "string" && effective.label
      ? effective.label
      : `Analyze ${id}`;
    return {
      value: id,
      label: builtin
        ? `${label} (${t("settings.target_builtin")})`
        : `${label} (${id})`,
      selected: id === targetId
    };
  });
  const defaultAnalysisCommand = {
    executable: typeof analysisDefaultCommand?.executable === "string" ? analysisDefaultCommand.executable : "",
    args: stringList(analysisDefaultCommand?.args)
  };
  const hasDefaultAnalysisCommand = Boolean(defaultAnalysisCommand.executable);
  const usesOpenCodeAnalyzerPreset = defaultAnalysisCommand.executable === "opencode";
  const analysisCommand = {
    ...defaultAnalysisCommand,
    ...asObject(analysisProvider.command)
  };
  const analysisArgs = stringList(analysisCommand.args, defaultAnalysisCommand.args);
  const configuredResume = asObject(config.resumeCommands)[provider];
  const resumeEnabled = configuredResume !== false;
  const resumeCommand = configuredResume && configuredResume !== false
    ? configuredResume
    : resumeDefault || { executable: "", args: [] };
  const resumeShell = asObject(config.resumeShell);
  const shellExecutable = typeof resumeShell.executable === "string" ? resumeShell.executable : "";
  const knownShell = ["", "pwsh.exe", "powershell.exe"].includes(shellExecutable);
  const shellMode = knownShell ? shellExecutable : "custom";
  const editorValue = configDocument.error
    ? configDocument.raw
    : `${JSON.stringify(config, null, 2)}\n`;
  const statusClass = terminalLaunchAllowed ? "settings-status-ok" : "settings-status-warn";
  const statusText = terminalLaunchAllowed ? t("settings.launch_enabled") : t("settings.launch_disabled");
  const initialData = JSON.stringify({
    provider,
    resumeDefault: resumeDefault || { executable: "", args: [] },
    analysisDefaultCommand: defaultAnalysisCommand,
    targetDefaults: builtinTargets
  }).replace(/</g, "\\u003c");

  const body = `
    <section class="settings-page">
      <header class="page-header settings-page-header">
        <div>
          <h1>${t("settings.title")}</h1>
          <p>${t("settings.description")}</p>
        </div>
        <div class="settings-provider-pill">${escapeHtml(providerName)}</div>
      </header>

      <div class="settings-status-grid">
        <section class="settings-card">
          <span class="settings-label">${t("settings.config_file")}</span>
          <code class="settings-path">${escapeHtml(configPath)}</code>
        </section>
        <section class="settings-card">
          <span class="settings-label">${t("settings.launch_permission")}</span>
          <strong class="${statusClass}">${escapeHtml(statusText)}</strong>
          <p>${t("settings.launch_help")}</p>
        </section>
      </div>

      ${configDocument.error ? `
        <div class="settings-alert settings-alert-error">
          <strong>${t("settings.invalid_file")}</strong>
          <span>${escapeHtml(configDocument.error)}</span>
        </div>
      ` : ""}

      <nav class="settings-section-nav" aria-label="${escapeHtml(t("settings.sections_nav"))}">
        <a href="#settings-analysis">${t("settings.analysis_title")}</a>
        <a href="#settings-target">${t("settings.target_title")}</a>
        <a href="#settings-analyzer">${t("settings.analyzer_title")}</a>
        <a href="#settings-resume">${t("settings.resume_title")}</a>
        <a href="#settings-advanced" data-open-settings-advanced>${t("settings.advanced_title")}</a>
      </nav>

      <form id="settings-form" class="settings-form" data-provider="${escapeHtml(provider)}">
        <section class="settings-section" id="settings-analysis">
          <div class="settings-section-header">
            <div>
              <h2>${t("settings.analysis_title")}</h2>
              <p>${t("settings.analysis_description")}</p>
            </div>
            ${switchField({
              id: "settings-analysis-enabled",
              label: t("settings.analysis_enabled"),
              description: t("settings.analysis_enabled_help"),
              enabled: Boolean(analysis.enabled),
              reset: "analysis-enabled"
            })}
          </div>
          <div class="settings-fields-grid">
            ${field({
              id: "settings-analysis-output",
              label: t("settings.output_dir"),
              value: typeof analysis.outputDir === "string" ? analysis.outputDir : ".codeagentsession/analysis",
              help: t("settings.output_dir_help"),
              reset: "analysis-output"
            })}
          </div>
          ${selectField({
            id: "settings-default-target",
            label: t("settings.target_id"),
            options: targetOptions,
            help: t("settings.target_id_help"),
            reset: "default-target"
          })}
          ${switchField({
            id: "settings-raw-snapshots",
            label: t("settings.raw_snapshots"),
            description: t("settings.raw_snapshots_help"),
            enabled: Boolean(analysis.includeRawSnapshots),
            reset: "raw-snapshots"
          })}
        </section>

        <section class="settings-section" id="settings-target">
          <div class="settings-section-header">
            <div>
              <h2>${t("settings.target_title")}</h2>
              <p>${t("settings.target_description")}</p>
            </div>
          </div>
          <div class="settings-target-toolbar">
            ${selectField({
              id: "settings-target-id",
              label: t("settings.edit_target"),
              options: targetOptions,
              help: t("settings.edit_target_help")
            })}
            <div class="settings-target-context" aria-live="polite">
              <span>${t("settings.editing_target")}</span>
              <strong id="settings-target-context-label">${escapeHtml(target.label || targetId)}</strong>
              <code id="settings-target-context-id">${escapeHtml(targetId)}</code>
            </div>
          </div>
          <div class="settings-fields-grid">
            ${field({
              id: "settings-target-label",
              label: t("settings.target_label"),
              value: typeof target.label === "string" ? target.label : targetId,
              help: t("settings.target_label_help"),
              reset: "target-label"
            })}
            ${field({
              id: "settings-prompt-file",
              label: t("settings.prompt_file"),
              value: typeof target.promptFile === "string" ? target.promptFile : "",
              help: `${t("settings.prompt_file_help")} ${configPath ? `${t("settings.prompt_file_base")} ${path.dirname(configPath)}` : ""}`.trim(),
              reset: "prompt-file"
            })}
            ${textareaField({
              id: "settings-target-prompt",
              label: t("settings.target_prompt"),
              values: [typeof target.prompt === "string" ? target.prompt : ""],
              help: t("settings.target_prompt_help"),
              placeholder: t("settings.target_prompt_placeholder"),
              reset: "target-prompt"
            })}
            ${textareaField({
              id: "settings-artifact-roots",
              label: t("settings.artifact_roots"),
              values: stringList(target.artifactRoots),
              help: t("settings.one_per_line"),
              reset: "artifact-roots"
            })}
            ${textareaField({
              id: "settings-artifact-files",
              label: t("settings.artifact_files"),
              values: stringList(target.artifactFiles),
              help: t("settings.artifact_files_help"),
              reset: "artifact-files"
            })}
            ${textareaField({
              id: "settings-file-extensions",
              label: t("settings.file_extensions"),
              values: stringList(
                target.fileExtensions || (target as any).extensions,
                builtinTargets.skills.fileExtensions
              ),
              help: t("settings.one_per_line"),
              reset: "file-extensions"
            })}
          </div>
          <section class="settings-artifact-summary" aria-live="polite">
            <div>
              <h3>${t("settings.artifact_summary_title")}</h3>
              <p>${t("settings.artifact_summary_help")}</p>
            </div>
            <dl>
              <div>
                <dt>${t("settings.artifact_roots")}</dt>
                <dd id="settings-artifact-summary-roots">${artifactValues(target.artifactRoots)}</dd>
              </div>
              <div>
                <dt>${t("settings.artifact_files")}</dt>
                <dd id="settings-artifact-summary-files">${artifactValues(target.artifactFiles)}</dd>
              </div>
              <div>
                <dt>${t("settings.file_extensions")}</dt>
                <dd id="settings-artifact-summary-extensions">${artifactValues(target.fileExtensions)}</dd>
              </div>
            </dl>
          </section>
          <div class="settings-prompt-preview">
            <div class="settings-prompt-preview-header">
              <div>
                <h3>${t("settings.prompt_preview_title")}</h3>
                <p>${t("settings.prompt_preview_description")}</p>
              </div>
              <button type="button" class="btn" id="settings-prompt-preview-button">${t("settings.prompt_preview_button")}</button>
            </div>
            <div id="settings-prompt-preview-panel" class="settings-prompt-preview-panel hidden">
              <p id="settings-prompt-preview-meta" class="settings-prompt-preview-meta"></p>
              <pre id="settings-prompt-preview-content" class="settings-prompt-preview-content"></pre>
            </div>
          </div>
        </section>

        <section class="settings-section" id="settings-analyzer">
          <div class="settings-section-header">
            <div>
              <h2>${t("settings.analyzer_title")}</h2>
              <p>${t("settings.analyzer_description")}</p>
            </div>
            ${switchField({
              id: "settings-analyzer-enabled",
              label: t("settings.provider_enabled"),
              description: t("settings.provider_enabled_help"),
              enabled: Boolean(analysisProvider.command) || hasDefaultAnalysisCommand,
              reset: "analyzer-enabled"
            })}
          </div>
          <div class="settings-fields-grid">
            ${field({
              id: "settings-analyzer-executable",
              label: t("settings.executable"),
              value: typeof analysisCommand.executable === "string" ? analysisCommand.executable : "",
              placeholder: defaultAnalysisCommand.executable,
              reset: "analyzer-executable"
            })}
            ${usesOpenCodeAnalyzerPreset ? field({
              id: "settings-analyzer-model",
              label: t("settings.model"),
              value: extractModel(analysisArgs),
              help: t("settings.model_help"),
              reset: "analyzer-model"
            }) : ""}
            ${textareaField({
              id: "settings-analyzer-args",
              label: t("settings.arguments"),
              values: usesOpenCodeAnalyzerPreset ? withoutModelArgs(analysisArgs) : analysisArgs,
              help: t("settings.arguments_help"),
              reset: "analyzer-args"
            })}
          </div>
          ${usesOpenCodeAnalyzerPreset ? `
            <button type="button" class="btn settings-preset-btn" id="settings-analysis-preset">${t("settings.use_opencode_preset")}</button>
          ` : ""}
        </section>

        <section class="settings-section" id="settings-resume">
          <div class="settings-section-header">
            <div>
              <h2>${t("settings.resume_title")}</h2>
              <p>${t("settings.resume_description")}</p>
            </div>
            ${switchField({
              id: "settings-resume-enabled",
              label: t("settings.resume_enabled"),
              description: t("settings.resume_enabled_help"),
              enabled: resumeEnabled,
              reset: "resume-enabled"
            })}
          </div>
          <div class="settings-fields-grid">
            ${field({
              id: "settings-resume-executable",
              label: t("settings.executable"),
              value: typeof resumeCommand.executable === "string" ? resumeCommand.executable : "",
              reset: "resume-executable"
            })}
            ${field({
              id: "settings-resume-cwd",
              label: t("settings.working_directory"),
              value: typeof resumeCommand.cwd === "string" ? resumeCommand.cwd : "",
              help: t("settings.working_directory_help"),
              reset: "resume-cwd"
            })}
            ${textareaField({
              id: "settings-resume-args",
              label: t("settings.arguments"),
              values: stringList(resumeCommand.args),
              help: t("settings.arguments_help"),
              reset: "resume-args"
            })}
            <div class="settings-field">
              <div class="settings-field-heading">
                <label for="settings-shell-mode">${t("settings.shell")}</label>
                ${resetButton("shell-mode")}
              </div>
              <select id="settings-shell-mode">
                <option value="" ${shellMode === "" ? "selected" : ""}>${t("settings.shell_auto")}</option>
                <option value="pwsh.exe" ${shellMode === "pwsh.exe" ? "selected" : ""}>PowerShell 7 (pwsh.exe)</option>
                <option value="powershell.exe" ${shellMode === "powershell.exe" ? "selected" : ""}>Windows PowerShell</option>
                <option value="custom" ${shellMode === "custom" ? "selected" : ""}>${t("settings.shell_custom")}</option>
              </select>
              <small>${t("settings.shell_help")}</small>
            </div>
            <div class="settings-field ${shellMode === "custom" ? "" : "hidden"}" id="settings-shell-custom-field">
              <div class="settings-field-heading">
                <label for="settings-shell-custom">${t("settings.custom_executable")}</label>
                ${resetButton("shell-custom")}
              </div>
              <input id="settings-shell-custom" type="text" value="${escapeHtml(shellMode === "custom" ? shellExecutable : "")}">
            </div>
            ${textareaField({
              id: "settings-shell-args",
              label: t("settings.shell_arguments"),
              values: stringList(resumeShell.args),
              help: t("settings.one_per_line"),
              reset: "shell-args"
            })}
          </div>
        </section>

        <details class="settings-advanced" id="settings-advanced">
          <summary>${t("settings.advanced_title")}</summary>
          <p>${t("settings.advanced_help")}</p>
          <div class="settings-actions">
            <button type="button" class="btn" id="settings-format">${t("settings.format")}</button>
            <button type="button" class="btn" id="settings-apply-json">${t("settings.apply_json")}</button>
          </div>
          <p id="settings-json-feedback" class="settings-json-feedback" role="status" aria-live="polite"></p>
          <textarea id="settings-json" class="settings-json-editor" spellcheck="false" aria-label="${escapeHtml(t("settings.json_title"))}" aria-describedby="settings-json-feedback">${escapeHtml(editorValue)}</textarea>
        </details>

        <div class="settings-save-bar">
          <div>
            <p id="settings-feedback" class="settings-feedback" role="status"></p>
            <span id="settings-dirty-state" class="settings-dirty-state" data-dirty="false">${t("settings.all_saved")}</span>
            <span class="settings-runtime-note-inline">${t("settings.runtime_note")}</span>
          </div>
          <button type="submit" class="btn settings-save" disabled>${t("settings.save")}</button>
        </div>
      </form>
      <script type="application/json" id="settings-initial-data">${initialData}</script>
    </section>
  `;

  return layout(t("settings.title"), body, "settings", {
    provider,
    providers,
    providerAvailable,
    manageable
  });
}
