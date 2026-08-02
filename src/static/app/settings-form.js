export function initSettingsForm({ ft, formatText, showToast }) {

const settingsForm = document.getElementById("settings-form");
if (settingsForm) {
  const editor = document.getElementById("settings-json");
  const feedback = document.getElementById("settings-feedback");
  const jsonFeedback = document.getElementById("settings-json-feedback");
  const formatButton = document.getElementById("settings-format");
  const applyJsonButton = document.getElementById("settings-apply-json");
  const advancedDetails = document.getElementById("settings-advanced");
  const advancedNavLink = document.querySelector("[data-open-settings-advanced]");
  const presetButton = document.getElementById("settings-analysis-preset");
  const promptPreviewButton = document.getElementById("settings-prompt-preview-button");
  const promptPreviewPanel = document.getElementById("settings-prompt-preview-panel");
  const promptPreviewMeta = document.getElementById("settings-prompt-preview-meta");
  const promptPreviewContent = document.getElementById("settings-prompt-preview-content");
  const defaultTargetSelect = document.getElementById("settings-default-target");
  const targetSelect = document.getElementById("settings-target-id");
  const targetLabelInput = document.getElementById("settings-target-label");
  const targetContextLabel = document.getElementById("settings-target-context-label");
  const targetContextId = document.getElementById("settings-target-context-id");
  const artifactSummaryRoots = document.getElementById("settings-artifact-summary-roots");
  const artifactSummaryFiles = document.getElementById("settings-artifact-summary-files");
  const artifactSummaryExtensions = document.getElementById("settings-artifact-summary-extensions");
  const shellMode = document.getElementById("settings-shell-mode");
  const shellCustomField = document.getElementById("settings-shell-custom-field");
  const initialNode = document.getElementById("settings-initial-data");
  const initialData = JSON.parse(initialNode?.textContent || "{}");
  const providerId = settingsForm.dataset.provider;
  const submitButton = settingsForm.querySelector("button[type='submit']");
  const dirtyState = document.getElementById("settings-dirty-state");
  let settingsDirty = false;
  let settingsJsonValid = true;

  const setSettingsFeedback = (message, type = "") => {
    feedback.textContent = message;
    feedback.className = `settings-feedback ${type ? `settings-feedback-${type}` : ""}`;
  };

  const setJsonFeedback = (message, type = "") => {
    if (!jsonFeedback) return;
    jsonFeedback.textContent = message;
    jsonFeedback.className = `settings-json-feedback ${type ? `settings-json-feedback-${type}` : ""}`;
  };

  const updateSubmitState = () => {
    if (submitButton) {
      submitButton.disabled = !settingsDirty || !settingsJsonValid;
    }
  };

  const value = (id) => document.getElementById(id)?.value?.trim() || "";
  const isChecked = (id) => Boolean(document.getElementById(id)?.checked);
  const setValue = (id, next) => {
    const element = document.getElementById(id);
    if (element) element.value = next ?? "";
  };
  const setChecked = (id, next) => {
    const element = document.getElementById(id);
    if (element) element.checked = Boolean(next);
  };
  const readLines = (id) => (document.getElementById(id)?.value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const setLines = (id, values) => setValue(id, Array.isArray(values) ? values.join("\n") : "");
  const asObject = (next) => next && typeof next === "object" && !Array.isArray(next) ? next : {};
  const defaultAnalysisCommand = asObject(initialData.analysisDefaultCommand);
  const usesOpenCodeAnalyzerPreset = defaultAnalysisCommand.executable === "opencode";
  const clone = (next) => JSON.parse(JSON.stringify(next || {}));
  const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  let sharedTargetConfigs = {};
  let targetDrafts = {};
  let currentTargetId = "skills";
  let inheritedDefaultTargetId = "skills";

  const parseEditor = () => {
    const parsed = JSON.parse(editor.value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Configuration root must be a JSON object.");
    }
    return parsed;
  };
  const invalidJsonMessage = (error) => `${ft("settings_invalid_json")}: ${error.message}`;
  const setSettingsDirty = (dirty) => {
    settingsDirty = Boolean(dirty);
    if (dirtyState) {
      dirtyState.dataset.dirty = String(settingsDirty);
      dirtyState.textContent = ft(settingsDirty ? "settings_unsaved" : "settings_all_saved");
    }
    updateSubmitState();
  };
  const updateEditorJsonState = ({ showMessage = false } = {}) => {
    try {
      parseEditor();
      settingsJsonValid = true;
      updateSubmitState();
      if (showMessage) {
        setSettingsFeedback("");
        setJsonFeedback("");
      }
      return true;
    } catch (error) {
      settingsJsonValid = false;
      updateSubmitState();
      if (showMessage) {
        const message = invalidJsonMessage(error);
        setSettingsFeedback(message, "error");
        setJsonFeedback(message, "error");
      }
      return false;
    }
  };

  const extractModel = (args) => {
    const index = args.indexOf("--model");
    return index >= 0 ? args[index + 1] || "" : "";
  };

  const withoutModel = (args) => {
    const index = args.indexOf("--model");
    return index < 0 ? args : [...args.slice(0, index), ...args.slice(index + 2)];
  };

  const targetDefaults = (targetId) => asObject(asObject(initialData.targetDefaults)[targetId]);
  const mergeTarget = (base, override) => {
    const left = asObject(base);
    const right = asObject(override);
    return {
      ...left,
      ...right,
      artifactRoots: Array.isArray(right.artifactRoots)
        ? right.artifactRoots
        : Array.isArray(left.artifactRoots) ? left.artifactRoots : [],
      artifactFiles: Array.isArray(right.artifactFiles)
        ? right.artifactFiles
        : Array.isArray(left.artifactFiles) ? left.artifactFiles : [],
      fileExtensions: Array.isArray(right.fileExtensions)
        ? right.fileExtensions
        : Array.isArray(left.fileExtensions) ? left.fileExtensions : []
    };
  };
  const builtinTargetDefaults = (targetId) => {
    const builtin = targetDefaults(targetId);
    return Object.keys(builtin).length ? builtin : {
      label: `Analyze ${targetId}`,
      artifactRoots: [],
      fileExtensions: targetDefaults("skills").fileExtensions || [],
      promptFile: ""
    };
  };
  const inheritedTargetDefaults = (targetId) => mergeTarget(
    builtinTargetDefaults(targetId),
    sharedTargetConfigs[targetId]
  );
  const resolvedTargetDefaults = (targetId) => mergeTarget(
    inheritedTargetDefaults(targetId),
    targetDrafts[targetId]
  );
  const configDefaultTargetId = (analysis) => (
    Array.isArray(analysis.defaultTargets) && analysis.defaultTargets.length
      ? analysis.defaultTargets.find((targetId) => typeof targetId === "string" && targetId) || "skills"
      : typeof analysis.defaultTarget === "string" && analysis.defaultTarget
        ? analysis.defaultTarget
        : "skills"
  );

  const setArtifactSummary = (node, values) => {
    if (!node) return;
    const entries = Array.isArray(values) ? values : [];
    if (!entries.length) {
      const empty = document.createElement("span");
      empty.textContent = ft("settings_artifact_none");
      node.replaceChildren(empty);
      return;
    }
    node.replaceChildren(...entries.map((entry) => {
      const code = document.createElement("code");
      code.textContent = entry;
      return code;
    }));
  };

  const updateArtifactSummary = () => {
    setArtifactSummary(artifactSummaryRoots, readLines("settings-artifact-roots"));
    setArtifactSummary(artifactSummaryFiles, readLines("settings-artifact-files"));
    setArtifactSummary(artifactSummaryExtensions, readLines("settings-file-extensions"));
  };

  const captureTargetDraft = (targetId) => {
    if (!targetId) return;
    const inherited = inheritedTargetDefaults(targetId);
    const target = { ...asObject(targetDrafts[targetId]) };
    const label = value("settings-target-label") || `Analyze ${targetId}`;
    if (label === inherited.label) delete target.label;
    else target.label = label;
    for (const [field, control] of [
      ["artifactRoots", "settings-artifact-roots"],
      ["artifactFiles", "settings-artifact-files"],
      ["fileExtensions", "settings-file-extensions"]
    ]) {
      const entries = readLines(control);
      if (sameValue(entries, inherited[field] || [])) delete target[field];
      else target[field] = entries;
    }
    delete target.extensions;
    const prompt = document.getElementById("settings-target-prompt")?.value?.trim() || "";
    if (prompt && prompt !== inherited.prompt) target.prompt = prompt;
    else delete target.prompt;
    const promptFile = value("settings-prompt-file");
    if (promptFile && promptFile !== inherited.promptFile) target.promptFile = promptFile;
    else delete target.promptFile;
    if (Object.keys(target).length) targetDrafts[targetId] = target;
    else delete targetDrafts[targetId];
  };

  const readProjectPaths = () => {
    const projectPaths = {};
    for (const line of readLines("settings-project-paths")) {
      const separator = line.indexOf("=");
      const key = separator > 0 ? line.slice(0, separator).trim() : "";
      const directory = separator > 0 ? line.slice(separator + 1).trim() : "";
      if (!key || !directory) throw new Error(ft("settings_project_paths_invalid"));
      projectPaths[key] = directory;
    }
    return projectPaths;
  };

  const loadTargetDraft = (targetId) => {
    const target = resolvedTargetDefaults(targetId);
    setValue("settings-target-label", target.label || `Analyze ${targetId}`);
    setValue("settings-target-prompt", target.prompt || "");
    setValue("settings-prompt-file", target.promptFile || "");
    setLines("settings-artifact-roots", target.artifactRoots);
    setLines("settings-artifact-files", target.artifactFiles);
    setLines("settings-file-extensions", target.fileExtensions);
    if (targetContextLabel) targetContextLabel.textContent = target.label || targetId;
    if (targetContextId) targetContextId.textContent = targetId;
    promptPreviewPanel?.classList.add("hidden");
    updateArtifactSummary();
  };

  const promptSourceLabel = (source) => {
    const keyBySource = {
      "built-in": "settings_prompt_source_builtin",
      configured: "settings_prompt_source_configured",
      provider: "settings_prompt_source_provider",
      default: "settings_prompt_source_default"
    };
    return ft(keyBySource[source] || keyBySource.default);
  };

  const loadPromptPreview = async () => {
    if (!promptPreviewButton || !promptPreviewPanel || !promptPreviewMeta || !promptPreviewContent) return;
    promptPreviewButton.disabled = true;
    promptPreviewPanel.classList.remove("hidden");
    promptPreviewMeta.textContent = ft("settings_prompt_preview_loading");
    promptPreviewContent.textContent = "";
    try {
      const targetId = value("settings-target-id") || "skills";
      const config = collectStructuredSettings(parseEditor());
      const response = await fetch(`/api/${providerId}/analysis/prompt-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: targetId, config })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }
      const preview = result.preview;
      const promptFile = preview.promptFile || {};
      const fileStatus = !promptFile.configuredPath
        ? ft("settings_prompt_file_none")
        : formatText(
          ft(promptFile.available ? "settings_prompt_file_loaded" : "settings_prompt_file_missing"),
          { path: promptFile.resolvedPath || promptFile.configuredPath }
        );
      promptPreviewMeta.textContent = formatText(ft("settings_prompt_preview_meta"), {
        source: promptSourceLabel(preview.targetInstructionSource),
        file: fileStatus
      });
      promptPreviewContent.textContent = preview.prompt || "";
    } catch (error) {
      promptPreviewMeta.textContent = `${ft("settings_prompt_preview_error")}: ${error.message}`;
    } finally {
      promptPreviewButton.disabled = false;
    }
  };

  const populateTargetOptions = (analysis, providerSettings, selectedTargetId) => {
    if (!targetSelect && !defaultTargetSelect) return;
    const targets = asObject(analysis.targets);
    const providerTargets = asObject(providerSettings.targets);
    const builtins = asObject(initialData.targetDefaults);
    const defaultTargetId = Array.isArray(providerSettings.defaultTargets) && providerSettings.defaultTargets.length
      ? providerSettings.defaultTargets.find((targetId) => typeof targetId === "string" && targetId) || inheritedDefaultTargetId
      : typeof providerSettings.defaultTarget === "string" && providerSettings.defaultTarget
        ? providerSettings.defaultTarget
        : inheritedDefaultTargetId;
    const targetIds = [...new Set([
      ...Object.keys(builtins),
      ...Object.keys(targets),
      ...Object.keys(providerTargets),
      defaultTargetId,
      selectedTargetId
    ])];
    const options = targetIds.map((targetId) => {
      const fallback = resolvedTargetDefaults(targetId);
      const option = document.createElement("option");
      option.value = targetId;
      const label = fallback.label;
      option.textContent = builtins[targetId]
        ? `${label} (${ft("settings_target_builtin")})`
        : `${label} (${targetId})`;
      return option;
    });
    targetSelect?.replaceChildren(...options.map((option) => option.cloneNode(true)));
    defaultTargetSelect?.replaceChildren(...options.map((option) => option.cloneNode(true)));
    if (targetSelect) targetSelect.value = selectedTargetId;
    if (defaultTargetSelect) defaultTargetSelect.value = defaultTargetId;
  };

  const populateSettingsForm = (config) => {
    const analysis = asObject(config.analysis);
    const providerSettings = asObject(asObject(analysis.providers)[providerId]);
    inheritedDefaultTargetId = configDefaultTargetId(analysis);
    const providerDefaultTargetId = Array.isArray(providerSettings.defaultTargets)
      && providerSettings.defaultTargets.length
      ? providerSettings.defaultTargets.find((targetId) => typeof targetId === "string" && targetId) || inheritedDefaultTargetId
      : typeof providerSettings.defaultTarget === "string" && providerSettings.defaultTarget
        ? providerSettings.defaultTarget
        : inheritedDefaultTargetId;
    const targetId = providerDefaultTargetId || "skills";
    sharedTargetConfigs = clone(asObject(analysis.targets));
    targetDrafts = clone(asObject(providerSettings.targets));
    currentTargetId = targetId;
    const command = {
      ...asObject(initialData.analysisDefaultCommand),
      ...asObject(providerSettings.command)
    };
    const commandArgs = Array.isArray(command.args) ? command.args : [];

    setChecked("settings-analysis-enabled", analysis.enabled);
    setValue("settings-analysis-output", analysis.outputDir || ".agentsession/analysis");
    setChecked("settings-raw-snapshots", analysis.includeRawSnapshots);
    populateTargetOptions(analysis, providerSettings, targetId);
    loadTargetDraft(targetId);
    setChecked("settings-analyzer-enabled", Boolean(providerSettings.command) || Boolean(defaultAnalysisCommand.executable));
    setValue("settings-analyzer-executable", command.executable || "");
    if (usesOpenCodeAnalyzerPreset) {
      setValue("settings-analyzer-model", extractModel(commandArgs));
      setLines("settings-analyzer-args", withoutModel(commandArgs));
    } else {
      setLines("settings-analyzer-args", commandArgs);
    }
    setLines(
      "settings-project-paths",
      Object.entries(asObject(providerSettings.projectPaths))
        .filter(([key, directory]) => typeof key === "string" && key && typeof directory === "string" && directory)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, directory]) => `${key}=${directory}`)
    );

    const resumeCommands = asObject(config.resumeCommands);
    const configuredResume = resumeCommands[providerId];
    const resumeEnabled = configuredResume !== false;
    const resume = configuredResume && configuredResume !== false
      ? configuredResume
      : asObject(initialData.resumeDefault);
    setChecked("settings-resume-enabled", resumeEnabled);
    setValue("settings-resume-executable", resume.executable || "");
    setValue("settings-resume-cwd", resume.cwd || "");
    setLines("settings-resume-args", resume.args);

    const resumeShell = asObject(config.resumeShell);
    const executable = resumeShell.executable || "";
    const mode = ["", "pwsh.exe", "powershell.exe"].includes(executable) ? executable : "custom";
    setValue("settings-shell-mode", mode);
    setValue("settings-shell-custom", mode === "custom" ? executable : "");
    setLines("settings-shell-args", resumeShell.args);
    shellCustomField?.classList.toggle("hidden", mode !== "custom");
  };

  const collectStructuredSettings = (baseConfig) => {
    const config = clone(baseConfig);
    const analysis = asObject(config.analysis);
    if (isChecked("settings-analysis-enabled")) analysis.enabled = true;
    else delete analysis.enabled;
    const outputDir = value("settings-analysis-output") || ".agentsession/analysis";
    if (outputDir === ".agentsession/analysis") delete analysis.outputDir;
    else analysis.outputDir = outputDir;
    if (isChecked("settings-raw-snapshots")) analysis.includeRawSnapshots = true;
    else delete analysis.includeRawSnapshots;

    const targetId = value("settings-target-id") || "skills";
    captureTargetDraft(targetId);
    const defaultTarget = value("settings-default-target") || targetId;
    if (!defaultTarget) {
      throw new Error(ft("settings_select_target"));
    }

    const analysisProviders = { ...asObject(analysis.providers) };
    const providerSettings = { ...asObject(analysisProviders[providerId]) };
    if (defaultTarget === inheritedDefaultTargetId) {
      delete providerSettings.defaultTargets;
      delete providerSettings.defaultTarget;
    } else {
      delete providerSettings.defaultTargets;
      providerSettings.defaultTarget = defaultTarget;
    }
    if (Object.keys(targetDrafts).length) providerSettings.targets = targetDrafts;
    else delete providerSettings.targets;
    if (isChecked("settings-analyzer-enabled")) {
      const executable = value("settings-analyzer-executable");
      if (!executable) {
        throw new Error("Analyzer executable is required when provider analysis is enabled.");
      }
      let args = readLines("settings-analyzer-args");
      if (usesOpenCodeAnalyzerPreset) {
        const model = value("settings-analyzer-model");
        if (model) {
          const insertAt = args[0] === "run" ? 1 : 0;
          args = [...args.slice(0, insertAt), "--model", model, ...args.slice(insertAt)];
        }
      }
      const command = { ...asObject(providerSettings.command), executable, args };
      providerSettings.command = command;
    } else {
      delete providerSettings.command;
    }
    const projectPaths = readProjectPaths();
    if (Object.keys(projectPaths).length) providerSettings.projectPaths = projectPaths;
    else delete providerSettings.projectPaths;
    if (Object.keys(providerSettings).length) analysisProviders[providerId] = providerSettings;
    else delete analysisProviders[providerId];
    if (Object.keys(analysisProviders).length) analysis.providers = analysisProviders;
    else delete analysis.providers;
    config.analysis = analysis;

    const resumeCommands = { ...asObject(config.resumeCommands) };
    if (!isChecked("settings-resume-enabled")) {
      resumeCommands[providerId] = false;
    } else {
      const executable = value("settings-resume-executable");
      if (!executable) {
        throw new Error("Resume executable is required when resume is enabled.");
      }
      const resume = {
        executable,
        args: readLines("settings-resume-args")
      };
      const cwd = value("settings-resume-cwd");
      if (cwd) resume.cwd = cwd;
      const resumeDefault = asObject(initialData.resumeDefault);
      if (resumeDefault.executable && sameValue(resume, resumeDefault)) {
        delete resumeCommands[providerId];
      } else {
        resumeCommands[providerId] = resume;
      }
    }
    if (Object.keys(resumeCommands).length) config.resumeCommands = resumeCommands;
    else delete config.resumeCommands;

    const selectedShell = value("settings-shell-mode");
    if (!selectedShell) {
      delete config.resumeShell;
    } else {
      const executable = selectedShell === "custom" ? value("settings-shell-custom") : selectedShell;
      if (!executable) {
        throw new Error("Custom shell executable is required.");
      }
      config.resumeShell = {
        executable,
        args: readLines("settings-shell-args")
      };
    }
    return config;
  };

  try {
    populateSettingsForm(parseEditor());
  } catch {}

  advancedNavLink?.addEventListener("click", () => {
    if (advancedDetails) {
      advancedDetails.open = true;
    }
  });

  formatButton?.addEventListener("click", () => {
    try {
      editor.value = `${JSON.stringify(parseEditor(), null, 2)}\n`;
      settingsJsonValid = true;
      updateSubmitState();
      setSettingsFeedback("");
      setJsonFeedback("");
    } catch (error) {
      settingsJsonValid = false;
      updateSubmitState();
      const message = invalidJsonMessage(error);
      setSettingsFeedback(message, "error");
      setJsonFeedback(message, "error");
    }
  });

  applyJsonButton?.addEventListener("click", () => {
    try {
      populateSettingsForm(parseEditor());
      settingsJsonValid = true;
      setSettingsDirty(true);
      setSettingsFeedback(ft("settings_json_applied"), "success");
      setJsonFeedback(ft("settings_json_applied"), "success");
    } catch (error) {
      settingsJsonValid = false;
      updateSubmitState();
      const message = invalidJsonMessage(error);
      setSettingsFeedback(message, "error");
      setJsonFeedback(message, "error");
    }
  });

  presetButton?.addEventListener("click", () => {
    const preset = asObject(initialData.analysisDefaultCommand);
    const args = Array.isArray(preset.args) ? preset.args : [];
    setChecked("settings-analyzer-enabled", true);
    setValue("settings-analyzer-executable", preset.executable || "opencode");
    setValue("settings-analyzer-model", extractModel(args));
    setLines("settings-analyzer-args", withoutModel(args));
    setSettingsDirty(true);
    setSettingsFeedback(ft("settings_example_loaded"), "success");
  });

  settingsForm.addEventListener("click", (event) => {
    const reset = event.target.closest?.("[data-reset-setting]");
    if (!reset) return;
    const key = reset.dataset.resetSetting;
    const inheritedTarget = inheritedTargetDefaults(currentTargetId);
    const analysisDefaultArgs = Array.isArray(defaultAnalysisCommand.args)
      ? defaultAnalysisCommand.args
      : [];
    const resumeDefault = asObject(initialData.resumeDefault);

    if (key === "analysis-enabled") setChecked("settings-analysis-enabled", false);
    if (key === "analysis-output") setValue("settings-analysis-output", ".agentsession/analysis");
    if (key === "raw-snapshots") setChecked("settings-raw-snapshots", false);
    if (key === "default-target") setValue("settings-default-target", inheritedDefaultTargetId);
    if (key === "target-label") {
      setValue("settings-target-label", inheritedTarget.label || `Analyze ${currentTargetId}`);
      if (targetContextLabel) {
        targetContextLabel.textContent = inheritedTarget.label || currentTargetId;
      }
    }
    if (key === "target-prompt") setValue("settings-target-prompt", inheritedTarget.prompt || "");
    if (key === "prompt-file") setValue("settings-prompt-file", inheritedTarget.promptFile || "");
    if (key === "artifact-roots") setLines("settings-artifact-roots", inheritedTarget.artifactRoots);
    if (key === "artifact-files") setLines("settings-artifact-files", inheritedTarget.artifactFiles);
    if (key === "file-extensions") {
      setLines("settings-file-extensions", inheritedTarget.fileExtensions);
    }
    if (key === "analyzer-enabled") {
      setChecked("settings-analyzer-enabled", Boolean(defaultAnalysisCommand.executable));
    }
    if (key === "analyzer-executable") {
      setValue("settings-analyzer-executable", defaultAnalysisCommand.executable || "");
      if (!defaultAnalysisCommand.executable) {
        setChecked("settings-analyzer-enabled", false);
      }
    }
    if (key === "analyzer-model") {
      setValue("settings-analyzer-model", extractModel(analysisDefaultArgs));
    }
    if (key === "analyzer-args") {
      setLines(
        "settings-analyzer-args",
        usesOpenCodeAnalyzerPreset ? withoutModel(analysisDefaultArgs) : analysisDefaultArgs
      );
    }
    if (key === "project-paths") setLines("settings-project-paths", []);
    if (key === "resume-enabled") {
      setChecked("settings-resume-enabled", Boolean(resumeDefault.executable));
    }
    if (key === "resume-executable") {
      setValue("settings-resume-executable", resumeDefault.executable || "");
    }
    if (key === "resume-cwd") setValue("settings-resume-cwd", resumeDefault.cwd || "");
    if (key === "resume-args") setLines("settings-resume-args", resumeDefault.args);
    if (key === "shell-mode") {
      setValue("settings-shell-mode", "");
      shellCustomField?.classList.add("hidden");
    }
    if (key === "shell-custom") {
      setValue("settings-shell-custom", "");
      setValue("settings-shell-mode", "");
      shellCustomField?.classList.add("hidden");
    }
    if (key === "shell-args") setLines("settings-shell-args", []);

    updateArtifactSummary();
    setSettingsDirty(true);
    setSettingsFeedback(ft("settings_reset_applied"), "success");
  });

  promptPreviewButton?.addEventListener("click", loadPromptPreview);

  targetSelect?.addEventListener("change", () => {
    captureTargetDraft(currentTargetId);
    currentTargetId = targetSelect.value || "skills";
    loadTargetDraft(currentTargetId);
  });

  defaultTargetSelect?.addEventListener("change", () => {
    if (!targetSelect) return;
    captureTargetDraft(currentTargetId);
    targetSelect.value = defaultTargetSelect.value || "skills";
    currentTargetId = targetSelect.value || "skills";
    loadTargetDraft(currentTargetId);
  });

  targetLabelInput?.addEventListener("input", () => {
    if (targetContextLabel) {
      targetContextLabel.textContent = targetLabelInput.value.trim() || currentTargetId;
    }
  });

  for (const id of ["settings-artifact-roots", "settings-artifact-files", "settings-file-extensions"]) {
    document.getElementById(id)?.addEventListener("input", updateArtifactSummary);
  }

  shellMode?.addEventListener("change", () => {
    shellCustomField?.classList.toggle("hidden", shellMode.value !== "custom");
  });

  settingsForm.addEventListener("input", (event) => {
    setSettingsDirty(true);
    if (event.target === editor) {
      updateEditorJsonState({ showMessage: true });
    } else {
      setSettingsFeedback("");
      if (settingsJsonValid) {
        setJsonFeedback("");
      }
    }
  });

  settingsForm.addEventListener("change", (event) => {
    if (event.target !== targetSelect) {
      setSettingsDirty(true);
      setSettingsFeedback("");
      if (settingsJsonValid) {
        setJsonFeedback("");
      }
    }
  });

  settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const parsedEditor = parseEditor();
      settingsJsonValid = true;
      const config = collectStructuredSettings(parsedEditor);
      submitButton.disabled = true;
      setSettingsFeedback("");
      setJsonFeedback("");
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        const details = Array.isArray(result.validationErrors) && result.validationErrors.length
          ? `: ${result.validationErrors.join(" ")}`
          : result.error
            ? `: ${result.error}`
            : "";
        throw new Error(`${ft("settings_validation_error")}${details}`);
      }

      editor.value = `${JSON.stringify(config, null, 2)}\n`;
      setJsonFeedback("");
      const messages = [ft("settings_saved")];
      if (result.restartRequiredKeys?.length) {
        messages.push(formatText(ft("settings_restart"), { keys: result.restartRequiredKeys.join(", ") }));
      }
      if (result.ignoredKeys?.includes("allowTerminalLaunch")) {
        messages.push(ft("settings_launch_ignored"));
      }
      setSettingsFeedback(messages.join(" "), "success");
      setSettingsDirty(false);
      showToast(ft("settings_saved"), "success");
    } catch (error) {
      try {
        parseEditor();
        settingsJsonValid = true;
        setSettingsFeedback(error.message || ft("settings_validation_error"), "error");
      } catch (jsonError) {
        settingsJsonValid = false;
        const message = invalidJsonMessage(jsonError);
        setSettingsFeedback(message, "error");
        setJsonFeedback(message, "error");
      }
      showToast(ft("toast_error"), "error");
    } finally {
      updateSubmitState();
    }
  });
}

}
