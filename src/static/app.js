const __LOCALE__ = window.__LOCALE__ || "en";
const PROVIDER = document.body.dataset.provider || "opencode";
const IS_MANAGEABLE_PROVIDER = document.body.dataset.manageable === "true";
const __I18N__ = {
  en: {
    rename_prompt: "Enter new title:",
    delete_confirm: "Delete this session? You can restore it from Trash.",
    permanent_delete_confirm: "Permanently delete? This cannot be undone.",
    batch_delete_confirm: "Delete {count} sessions?",
    select_first: "Please select sessions first",
    starred_label: "★ Starred",
    star_label: "☆ Star",
    star_check: "Star",
    manage: "Manage",
    cancel_manage: "Cancel",
    toast_starred: "Starred",
    toast_unstarred: "Unstarred",
    toast_renamed: "Renamed",
    toast_deleted: "Moved to trash",
    toast_restored: "Restored",
    toast_permanent_deleted: "Permanently deleted",
    toast_batch_done: "{count} sessions updated",
    toast_error: "Operation failed",
    time_just_now: "just now",
    time_minutes_ago: "{n}m ago",
    time_hours_ago: "{n}h ago",
    time_days_ago: "{n}d ago",
    card_files: "{count} files",
    menu_rename: "Rename",
    menu_export_md: "Export MD",
    menu_export_json: "Export JSON",
    menu_delete: "Delete",
    copy: "Copy",
    copied: "Copied",
    resume_opened: "Terminal opened",
    resume_disabled: "Terminal launch is unavailable",
    analysis_opened: "Analysis launched. Tracking status below.",
    analysis_opened_many: "Launched {count} analysis runs. Tracking status below.",
    analysis_disabled: "Session analysis is unavailable",
    analysis_select_target: "Select at least one analysis target",
    analysis_launch_summary: "Targets {targets} · Runtime {runtime}",
    analysis_status_prepared: "Preparing",
    analysis_status_launched: "Running",
    analysis_status_completed: "Completed",
    analysis_status_invalid: "Invalid",
    analysis_status_failed: "Failed",
    analysis_status_unknown: "Unknown",
    analysis_no_runs: "No analysis runs yet.",
    analysis_waiting: "Waiting for analyzer output and validation.",
    analysis_waiting_no_output: "No output files yet after {seconds}s. The analyzer may still be running or waiting in the terminal.",
    analysis_started_at: "Started {time}",
    analysis_finished_at: "Finished {time}",
    analysis_target: "Target: {target}",
    analysis_run_folder: "Run folder",
    analysis_exit_code: "Process exit code: {code}",
    analysis_counts: "{cases} evaluation cases · {proposals} artifact proposals",
    analysis_report_ready: "Report generated",
    analysis_outputs_title: "Final outputs",
    analysis_outputs_help: "These are the analysis products. Other run files are supporting evidence and diagnostics.",
    analysis_output_report: "Read analysis report",
    analysis_output_report_help: "Human-readable outcome, evidence, findings, and recommendations.",
    analysis_output_evaluation: "View evaluation plan",
    analysis_output_evaluation_help: "Replay, held-out, and regression cases used to validate proposed changes.",
    analysis_output_proposals: "View artifact proposals",
    analysis_output_proposals_help: "Suggested target changes. This file can contain an empty proposal list.",
    analysis_output_download: "Download",
    analysis_implementation_title: "Implementation",
    analysis_implementation_ready: "The validated proposal set is ready for a user-approved implementation run.",
    analysis_implementation_launch: "Implement accepted proposals",
    analysis_implementation_confirm: "Launch an agent to implement all validated proposals from this run?",
    analysis_implementation_opened: "Implementation launched. Review the terminal and resulting changes.",
    analysis_implementation_disabled: "Could not launch proposal implementation",
    analysis_implementation_launched: "Implementation launched {time}",
    analysis_implementation_prepared: "Implementation request prepared",
    analysis_validation_errors: "Validation errors",
    analysis_status_error: "Could not refresh analysis status",
    settings_saved: "Settings saved",
    settings_restart: "Restart required for: {keys}",
    settings_invalid_json: "Enter valid JSON before saving",
    settings_validation_error: "Configuration validation failed",
    settings_launch_ignored: "allowTerminalLaunch is startup-only and was not applied",
    settings_example_loaded: "Analysis example inserted",
    settings_json_applied: "Advanced JSON applied to the form",
    settings_target_builtin: "built-in",
    settings_prompt_preview_loading: "Building prompt preview...",
    settings_prompt_preview_error: "Could not load the analyzer prompt preview",
    settings_prompt_source_builtin: "built-in target guidance",
    settings_prompt_source_configured: "target configuration",
    settings_prompt_source_provider: "provider target configuration",
    settings_prompt_source_default: "default target guidance",
    settings_prompt_file_none: "no prompt file",
    settings_prompt_file_loaded: "prompt file loaded: {path}",
    settings_prompt_file_missing: "prompt file missing: {path}",
    settings_prompt_preview_meta: "Target guidance: {source}. {file}.",
    settings_select_target: "Select at least one analysis target",
    settings_reset_applied: "Reset to the inherited default",
    settings_artifact_none: "None",
    settings_all_saved: "All changes saved",
    settings_unsaved: "Unsaved changes",
    scroll_all_loaded: "All sessions loaded",
    scroll_loading: "Loading..."
  },
  zh: {
    rename_prompt: "输入新标题：",
    delete_confirm: "确定要删除此会话？可在回收站恢复。",
    permanent_delete_confirm: "永久删除后无法恢复，确定？",
    batch_delete_confirm: "确定删除 {count} 个会话？",
    select_first: "请先选择会话",
    starred_label: "★ 已收藏",
    star_label: "☆ 收藏",
    star_check: "收藏",
    manage: "管理",
    cancel_manage: "取消管理",
    toast_starred: "已收藏",
    toast_unstarred: "已取消收藏",
    toast_renamed: "已重命名",
    toast_deleted: "已移至回收站",
    toast_restored: "已恢复",
    toast_permanent_deleted: "已永久删除",
    toast_batch_done: "已批量操作 {count} 个会话",
    toast_error: "操作失败",
    time_just_now: "刚刚",
    time_minutes_ago: "{n}分钟前",
    time_hours_ago: "{n}小时前",
    time_days_ago: "{n}天前",
    card_files: "{count} 个文件",
    menu_rename: "重命名",
    menu_export_md: "导出 MD",
    menu_export_json: "导出 JSON",
    menu_delete: "删除",
    copy: "复制",
    copied: "已复制",
    resume_opened: "终端已打开",
    resume_disabled: "无法启动终端",
    analysis_opened: "已启动分析，可在下方跟踪状态。",
    analysis_opened_many: "已启动 {count} 个分析任务，可在下方跟踪状态。",
    analysis_disabled: "无法启动会话分析",
    analysis_select_target: "请至少选择一个分析目标",
    analysis_launch_summary: "目标 {targets} · 运行时 {runtime}",
    analysis_status_prepared: "准备中",
    analysis_status_launched: "运行中",
    analysis_status_completed: "已完成",
    analysis_status_invalid: "校验未通过",
    analysis_status_failed: "失败",
    analysis_status_unknown: "未知",
    analysis_no_runs: "暂无分析记录。",
    analysis_waiting: "正在等待 Analyzer 输出和校验结果。",
    analysis_waiting_no_output: "{seconds} 秒后仍未生成输出文件。Analyzer 可能仍在运行，或正在终端中等待。",
    analysis_started_at: "开始于 {time}",
    analysis_finished_at: "完成于 {time}",
    analysis_target: "目标：{target}",
    analysis_run_folder: "运行目录",
    analysis_exit_code: "进程退出码：{code}",
    analysis_counts: "{cases} 个评估用例 · {proposals} 个工件提案",
    analysis_report_ready: "已生成报告",
    analysis_outputs_title: "最终产物",
    analysis_outputs_help: "这些是分析产物；运行目录中的其他文件是支持证据和诊断数据。",
    analysis_output_report: "阅读分析报告",
    analysis_output_report_help: "面向人的分析结果、证据、发现和建议。",
    analysis_output_evaluation: "查看评估计划",
    analysis_output_evaluation_help: "用于验证提案的回放、留出和回归用例。",
    analysis_output_proposals: "查看工件提案",
    analysis_output_proposals_help: "建议的目标修改；该文件可能包含空的提案列表。",
    analysis_output_download: "下载",
    analysis_implementation_title: "实现",
    analysis_implementation_ready: "已校验的提案集可由用户确认后启动实现。",
    analysis_implementation_launch: "实现已接受的提案",
    analysis_implementation_confirm: "启动 Agent 实现此运行中的全部已校验提案？",
    analysis_implementation_opened: "已启动实现任务。请查看终端和后续变更。",
    analysis_implementation_disabled: "无法启动提案实现",
    analysis_implementation_launched: "实现已于 {time} 启动",
    analysis_implementation_prepared: "已准备实现请求",
    analysis_validation_errors: "校验错误",
    analysis_status_error: "无法刷新分析状态",
    settings_saved: "设置已保存",
    settings_restart: "以下配置需要重启后生效：{keys}",
    settings_invalid_json: "请先输入有效的 JSON",
    settings_validation_error: "配置校验失败",
    settings_launch_ignored: "allowTerminalLaunch 只能在启动时设置，本次未应用",
    settings_example_loaded: "已插入分析配置示例",
    settings_json_applied: "已将高级 JSON 应用到表单",
    settings_target_builtin: "内置",
    settings_prompt_preview_loading: "正在生成提示词预览...",
    settings_prompt_preview_error: "无法加载 Analyzer 提示词预览",
    settings_prompt_source_builtin: "内置目标指引",
    settings_prompt_source_configured: "目标配置",
    settings_prompt_source_provider: "Provider 目标配置",
    settings_prompt_source_default: "默认目标指引",
    settings_prompt_file_none: "未配置提示词文件",
    settings_prompt_file_loaded: "已加载提示词文件：{path}",
    settings_prompt_file_missing: "提示词文件不存在：{path}",
    settings_prompt_preview_meta: "目标指引来源：{source}。{file}。",
    settings_select_target: "请至少选择一个分析目标",
    settings_reset_applied: "已恢复为继承的默认值",
    settings_artifact_none: "无",
    settings_all_saved: "所有更改均已保存",
    settings_unsaved: "有未保存的更改",
    scroll_all_loaded: "已全部加载",
    scroll_loading: "加载中..."
  }
};

function ft(key) {
  return __I18N__[__LOCALE__]?.[key] ?? __I18N__.en[key] ?? key;
}

function formatText(template, values = {}) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template
  );
}

const themeToggle = document.getElementById('theme-toggle');
if (themeToggle) {
  function updateToggleIcon() {
    themeToggle.textContent = document.documentElement.dataset.theme === 'dark' ? '☀️' : '🌙';
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

const settingsForm = document.getElementById("settings-form");
if (settingsForm) {
  const editor = document.getElementById("settings-json");
  const feedback = document.getElementById("settings-feedback");
  const formatButton = document.getElementById("settings-format");
  const applyJsonButton = document.getElementById("settings-apply-json");
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

  const setSettingsFeedback = (message, type = "") => {
    feedback.textContent = message;
    feedback.className = `settings-feedback ${type ? `settings-feedback-${type}` : ""}`;
  };

  const setSettingsDirty = (dirty) => {
    settingsDirty = Boolean(dirty);
    if (dirtyState) {
      dirtyState.dataset.dirty = String(settingsDirty);
      dirtyState.textContent = ft(settingsDirty ? "settings_unsaved" : "settings_all_saved");
    }
    if (submitButton) {
      submitButton.disabled = !settingsDirty;
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
        : Array.isArray(right.extensions)
          ? right.extensions
          : Array.isArray(left.fileExtensions)
            ? left.fileExtensions
            : Array.isArray(left.extensions) ? left.extensions : []
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

  const loadTargetDraft = (targetId) => {
    const target = resolvedTargetDefaults(targetId);
    setValue("settings-target-label", target.label || `Analyze ${targetId}`);
    setValue("settings-target-prompt", target.prompt || "");
    setValue("settings-prompt-file", target.promptFile || "");
    setLines("settings-artifact-roots", target.artifactRoots);
    setLines("settings-artifact-files", target.artifactFiles);
    setLines("settings-file-extensions", target.fileExtensions || target.extensions);
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
    setValue("settings-analysis-output", analysis.outputDir || ".codeagentsession/analysis");
    setChecked("settings-raw-snapshots", analysis.includeRawSnapshots);
    populateTargetOptions(analysis, providerSettings, targetId);
    loadTargetDraft(targetId);
    setChecked("settings-analyzer-enabled", Boolean(providerSettings.command) || providerId === "opencode");
    setValue("settings-analyzer-executable", command.executable || "");
    if (providerId === "opencode") {
      setValue("settings-analyzer-model", extractModel(commandArgs));
      setLines("settings-analyzer-args", withoutModel(commandArgs));
    } else {
      setLines("settings-analyzer-args", commandArgs);
    }

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
    const outputDir = value("settings-analysis-output") || ".codeagentsession/analysis";
    if (outputDir === ".codeagentsession/analysis") delete analysis.outputDir;
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
      if (providerId === "opencode") {
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

  formatButton?.addEventListener("click", () => {
    try {
      editor.value = `${JSON.stringify(parseEditor(), null, 2)}\n`;
      setSettingsFeedback("");
    } catch (error) {
      setSettingsFeedback(`${ft("settings_invalid_json")}: ${error.message}`, "error");
    }
  });

  applyJsonButton?.addEventListener("click", () => {
    try {
      populateSettingsForm(parseEditor());
      setSettingsDirty(true);
      setSettingsFeedback(ft("settings_json_applied"), "success");
    } catch (error) {
      setSettingsFeedback(`${ft("settings_invalid_json")}: ${error.message}`, "error");
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
    const analysisDefaultCommand = asObject(initialData.analysisDefaultCommand);
    const analysisDefaultArgs = Array.isArray(analysisDefaultCommand.args)
      ? analysisDefaultCommand.args
      : [];
    const resumeDefault = asObject(initialData.resumeDefault);

    if (key === "analysis-enabled") setChecked("settings-analysis-enabled", false);
    if (key === "analysis-output") setValue("settings-analysis-output", ".codeagentsession/analysis");
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
      setLines("settings-file-extensions", inheritedTarget.fileExtensions || inheritedTarget.extensions);
    }
    if (key === "analyzer-enabled") {
      setChecked("settings-analyzer-enabled", Boolean(analysisDefaultCommand.executable));
    }
    if (key === "analyzer-executable") {
      setValue("settings-analyzer-executable", analysisDefaultCommand.executable || "");
      if (!analysisDefaultCommand.executable) {
        setChecked("settings-analyzer-enabled", false);
      }
    }
    if (key === "analyzer-model") {
      setValue("settings-analyzer-model", extractModel(analysisDefaultArgs));
    }
    if (key === "analyzer-args") {
      setLines(
        "settings-analyzer-args",
        providerId === "opencode" ? withoutModel(analysisDefaultArgs) : analysisDefaultArgs
      );
    }
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

  settingsForm.addEventListener("input", () => {
    setSettingsDirty(true);
    setSettingsFeedback("");
  });

  settingsForm.addEventListener("change", (event) => {
    if (event.target !== targetSelect) {
      setSettingsDirty(true);
      setSettingsFeedback("");
    }
  });

  settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const config = collectStructuredSettings(parseEditor());
      submitButton.disabled = true;
      setSettingsFeedback("");
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
      setSettingsFeedback(error.message || ft("settings_validation_error"), "error");
      showToast(ft("toast_error"), "error");
    } finally {
      submitButton.disabled = !settingsDirty;
    }
  });
}

const analysisStatusPanel = document.getElementById("analysis-status-panel");
let analysisStatusTimer = null;

function checkedAnalysisValues(root, selector) {
  const scope = root || document;
  return [...scope.querySelectorAll(selector)]
    .filter((input) => input.checked && !input.disabled)
    .map((input) => input.value)
    .filter(Boolean);
}

function updateAnalysisLaunchControl(control) {
  if (!control) return;
  const targetCount = checkedAnalysisValues(control, ".analysis-target-checkbox").length;
  const runtimeCount = checkedAnalysisValues(control, ".analysis-runtime-extension-checkbox").length;
  const targetCountNode = control.querySelector("[data-analysis-selected-count]");
  const runtimeCountNode = control.querySelector("[data-runtime-selected-count]");
  const summary = control.querySelector("[data-analysis-launch-summary]");
  const button = control.querySelector('[data-action="analyze-session"]');
  if (targetCountNode) targetCountNode.textContent = String(targetCount);
  if (runtimeCountNode) runtimeCountNode.textContent = String(runtimeCount);
  if (summary) {
    summary.textContent = formatText(ft("analysis_launch_summary"), {
      targets: targetCount,
      runtime: runtimeCount
    });
  }
  if (button) {
    button.disabled = button.dataset.unavailable === "true" || targetCount === 0;
  }
}

document.querySelectorAll(".analysis-launch-control").forEach((control) => {
  updateAnalysisLaunchControl(control);
  control.addEventListener("change", (event) => {
    if (event.target.matches(".analysis-target-checkbox, .analysis-runtime-extension-checkbox")) {
      updateAnalysisLaunchControl(control);
    }
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

function renderAnalysisRuns(runs) {
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

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement.tagName !== "INPUT") {
    e.preventDefault();
    document.getElementById("search-input").focus();
  }
  if (e.key === "Escape") {
    const flowPanel = document.getElementById("session-flow-panel");
    if (flowPanel && !flowPanel.classList.contains("hidden")) {
      flowPanel.classList.add("hidden");
      flowPanel.setAttribute("aria-hidden", "true");
      document.body.classList.remove("flow-panel-open");
      document.querySelectorAll(".flow-open-btn[aria-expanded='true']").forEach((btn) => {
        btn.setAttribute("aria-expanded", "false");
      });
    }
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
    if (!btn.textContent.includes(ft("star_check"))) {
      btn.textContent = data.starred ? "★" : "☆";
    }
    if (btn.textContent.includes(ft("star_check"))) {
      btn.innerHTML = data.starred ? ft("starred_label") : ft("star_label");
    }
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
  const id = btn.dataset.id;
  if (!id || !action) return;

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
    const targets = checkedAnalysisValues(control, ".analysis-target-checkbox");
    if (!targets.length) {
      const fallbackTarget = btn.dataset.target || "";
      if (fallbackTarget) targets.push(fallbackTarget);
    }
    if (!targets.length) {
      showToast(ft("analysis_select_target"), "error");
      return;
    }
    const hasRuntimePicker = Boolean(control?.querySelector(".analysis-runtime-extension-checkbox"));
    const runtimeExtensionIds = hasRuntimePicker
      ? checkedAnalysisValues(control, ".analysis-runtime-extension-checkbox")
      : null;
    const wasDisabled = btn.disabled;
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
          throw new Error(result.error || `HTTP ${res.status}`);
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
    } catch {
      showToast(ft("analysis_disabled"), "error");
    } finally {
      btn.disabled = wasDisabled;
      updateAnalysisLaunchControl(control);
    }
    return;
  }

  if (action === "implement-analysis") {
    const runId = btn.dataset.runId || "";
    if (!runId || !confirm(ft("analysis_implementation_confirm"))) {
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
    const current = card
      ? card.querySelector(".session-card-title")?.textContent || ""
      : document.querySelector(".session-header h1")?.textContent || "";
    const newTitle = prompt(ft("rename_prompt"), current);
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
    if (!confirm(ft("delete_confirm"))) return;
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
    if (!confirm(ft("permanent_delete_confirm"))) return;
    try {
      await fetch(`/api/${PROVIDER}/session/${encodeURIComponent(id)}/permanent-delete`, { method: "POST" });
      queueToast(ft("toast_permanent_deleted"), "success");
      location.reload();
    } catch {
      showToast(ft("toast_error"), "error");
    }
    return;
  }

  if (action === "export-md") {
    window.open(`/api/${PROVIDER}/session/${encodeURIComponent(id)}/export?format=md`, "_blank");
    return;
  }

  if (action === "export-json") {
    window.open(`/api/${PROVIDER}/session/${encodeURIComponent(id)}/export?format=json`, "_blank");
  }
});

const toggleBatchBtn = document.getElementById("toggle-batch");
const batchBar = document.getElementById("batch-bar");
const sessionList = document.getElementById("session-list");
const batchCountNum = document.getElementById("batch-count-num");
const selectAllCheckbox = document.getElementById("select-all");
const batchCancelBtn = document.getElementById("batch-cancel");

let batchMode = false;

function updateBatchCount() {
  if (!batchCountNum) return;
  const checked = document.querySelectorAll(".card-checkbox:checked").length;
  batchCountNum.textContent = checked;
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
    if (selectAllCheckbox) selectAllCheckbox.checked = false;
    updateBatchCount();
  }
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
    alert(ft("select_first"));
    return;
  }
  if (action === "delete" && !confirm(ft("batch_delete_confirm").replace("{count}", ids.length))) return;

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
  const id = escapeHtmlClient(s.id);
  const title = escapeHtmlClient(s.title || s.id);
  const directory = escapeHtmlClient(s.directory || "");
  const timeUpdated = Number(s.time_updated) || Date.now();
  const classes = ["session-card"];
  if (s.starred) classes.push("starred");

  const actionsHtml = IS_MANAGEABLE_PROVIDER ? `
    <div class="card-actions">
      <button class="star-btn ${s.starred ? "starred" : ""}" data-id="${id}" title="${ft("star_check")}">
        ${s.starred ? "★" : "☆"}
      </button>
      <button class="card-menu-trigger" data-id="${id}" title="More">⋮</button>
      <div class="card-menu hidden" data-id="${id}">
        <button data-action="rename" data-id="${id}">${ft("menu_rename")}</button>
        <button data-action="export-md" data-id="${id}">${ft("menu_export_md")}</button>
        <button data-action="export-json" data-id="${id}">${ft("menu_export_json")}</button>
        <button data-action="delete" data-id="${id}" class="menu-danger">${ft("menu_delete")}</button>
      </div>
    </div>
  ` : "";

  return `<article class="${classes.join(" ")}" data-session-id="${id}">
    <input type="checkbox" class="card-checkbox" data-id="${id}">
    <div class="session-card-content">
      <header class="session-card-header">
        <a href="/${PROVIDER}/session/${encodeURIComponent(s.id)}" class="session-card-title-link">
          <h2 class="session-card-title">${title}</h2>
        </a>
        <time class="session-card-time" datetime="${new Date(timeUpdated).toISOString()}">${escapeHtmlClient(formatTimeClient(timeUpdated))}</time>
      </header>
      <div class="session-id-row">
        <code class="session-id">${id}</code>
        <button class="copy-btn" type="button" data-action="copy-session-id" data-id="${id}" title="${ft("copy")}">${ft("copy")}</button>
      </div>
      <p class="session-card-directory">${directory}</p>
      <footer class="session-card-stats">
        <span>${ft("card_files").replace("{count}", String(Number(s.summary_files) || 0))}</span>
        <span class="additions">+${Number(s.summary_additions) || 0}</span>
        <span class="deletions">-${Number(s.summary_deletions) || 0}</span>
      </footer>
    </div>
    ${actionsHtml}
  </article>`;
}

const scrollSentinel = document.getElementById("scroll-sentinel");
if (scrollSentinel && sessionList && "IntersectionObserver" in window) {
  let scrollOffset = Number(scrollSentinel.dataset.offset) || 0;
  const scrollTotal = Number(scrollSentinel.dataset.total) || 0;
  const scrollRange = scrollSentinel.dataset.range || "";
  const scrollQuery = scrollSentinel.dataset.query || "";
  const scrollProject = scrollSentinel.dataset.project || "";
  const scrollMode = scrollSentinel.dataset.mode || "list";
  let isLoading = false;

  const setSentinelState = (className, text) => {
    scrollSentinel.className = className;
    scrollSentinel.textContent = text;
  };

  const observer = new IntersectionObserver(async (entries) => {
    const entry = entries[0];
    if (!entry?.isIntersecting || isLoading) {
      return;
    }

    isLoading = true;
    setSentinelState("scroll-loading", ft("scroll_loading"));

    try {
      const params = new URLSearchParams({
        offset: String(scrollOffset),
        limit: "30"
      });
      if (scrollRange) params.set("range", scrollRange);
      if (scrollQuery) params.set("q", scrollQuery);
      if (scrollProject) params.set("project", scrollProject);
      if (scrollMode) params.set("mode", scrollMode);

      const res = await fetch(`/api/${PROVIDER}/sessions?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      const markup = Array.isArray(data.sessions) ? data.sessions.map(renderSessionCard).join("") : "";
      sessionList.insertAdjacentHTML("beforeend", markup);
      scrollOffset = (Number(data.offset) || 0) + (Array.isArray(data.sessions) ? data.sessions.length : 0);

      if (!data.hasMore || scrollOffset >= scrollTotal) {
        observer.disconnect();
        setSentinelState("scroll-done", ft("scroll_all_loaded"));
      } else {
        setSentinelState("", "");
      }
    } catch {
      setSentinelState("", "");
      showToast(ft("toast_error"), "error");
    } finally {
      isLoading = false;
    }
  }, { rootMargin: "200px" });

  if (scrollOffset < scrollTotal) {
    observer.observe(scrollSentinel);
  } else {
    setSentinelState("scroll-done", ft("scroll_all_loaded"));
  }
}

const sessionWorkbench = document.querySelector(".session-workbench");
if (sessionWorkbench) {
  const navLinks = [...document.querySelectorAll(".session-toc a[href^='#'], .session-flow-panel a[href^='#']")];
  const tocGroups = [...document.querySelectorAll(".session-toc .toc-group")];
  const flowPanel = document.getElementById("session-flow-panel");
  const tocResizeHandle = document.querySelector(".toc-resize-handle");
  const flowScroll = flowPanel?.querySelector(".flow-map-scroll");
  const flowOverview = flowPanel?.querySelector("[data-flow-overview]");
  const flowOverviewWindow = flowPanel?.querySelector("[data-flow-overview-window]");
  const flowRootLine = flowPanel?.querySelector(".flow-map-root-session > .flow-map-line");
  const flowMap = flowPanel?.querySelector(".flow-map");
  const flowBranchDrawer = flowPanel?.querySelector("[data-flow-branch-drawer]");
  const flowBranchBody = flowPanel?.querySelector("[data-flow-branch-body]");
  const targets = [...new Set(navLinks
    .map((link) => document.getElementById(decodeURIComponent(link.getAttribute("href").slice(1))))
    .filter(Boolean))];
  let lastManualNav = 0;
  let scrollTicking = false;

  try {
    const storedTocWidth = Number(localStorage.getItem("opensessionviewer.tocWidth"));
    if (storedTocWidth) {
      sessionWorkbench.style.setProperty("--toc-width", `${storedTocWidth}px`);
    }
  } catch {}

  if (tocResizeHandle) {
    const setTocWidth = (clientX) => {
      const workbenchLeft = sessionWorkbench.getBoundingClientRect().left;
      const maxWidth = Math.min(520, window.innerWidth * 0.45);
      const width = Math.max(144, Math.min(maxWidth, clientX - workbenchLeft));
      sessionWorkbench.style.setProperty("--toc-width", `${Math.round(width)}px`);
      return Math.round(width);
    };

    tocResizeHandle.addEventListener("pointerdown", (event) => {
      if (window.innerWidth <= 820) return;
      event.preventDefault();
      sessionWorkbench.classList.add("toc-resizing");
      tocResizeHandle.setPointerCapture?.(event.pointerId);
      let width = setTocWidth(event.clientX);

      const onMove = (moveEvent) => {
        width = setTocWidth(moveEvent.clientX);
      };
      const onUp = () => {
        sessionWorkbench.classList.remove("toc-resizing");
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        try {
          localStorage.setItem("opensessionviewer.tocWidth", String(width));
        } catch {}
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp, { once: true });
    });
  }

  const updateFlowOverview = () => {
    if (!flowScroll || !flowOverviewWindow) return;
    const wrapped = flowRootLine?.classList.contains("flow-map-line-wrapped");
    const viewport = wrapped ? flowScroll.clientHeight : flowScroll.clientWidth;
    const content = wrapped ? flowScroll.scrollHeight : flowScroll.scrollWidth;
    const offset = wrapped ? flowScroll.scrollTop : flowScroll.scrollLeft;
    const scrollable = Math.max(0, content - viewport);
    const widthRatio = Math.min(1, viewport / Math.max(content, 1));
    const leftRatio = scrollable ? offset / scrollable : 0;
    flowOverviewWindow.style.width = `${widthRatio * 100}%`;
    flowOverviewWindow.style.left = `${leftRatio * (1 - widthRatio) * 100}%`;
  };

  const seekFlowOverview = (clientX) => {
    if (!flowScroll || !flowOverview) return;
    const rect = flowOverview.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(rect.width, 1)));
    if (flowRootLine?.classList.contains("flow-map-line-wrapped")) {
      flowScroll.scrollTop = Math.max(0, ratio * flowScroll.scrollHeight - flowScroll.clientHeight / 2);
    } else {
      flowScroll.scrollLeft = Math.max(0, ratio * flowScroll.scrollWidth - flowScroll.clientWidth / 2);
    }
  };

  const unwrapFlowRows = () => {
    if (!flowRootLine) return [];
    const rows = [...flowRootLine.querySelectorAll(":scope > .flow-map-row")];
    if (!rows.length) {
      return [...flowRootLine.querySelectorAll(":scope > .flow-map-step")];
    }
    const steps = rows.flatMap((row) => [...row.children].filter((child) => child.classList.contains("flow-map-step")));
    flowRootLine.replaceChildren(...steps);
    flowRootLine.classList.remove("flow-map-line-wrapped");
    return steps;
  };

  const updateFlowTurnAnchors = () => {
    if (!flowRootLine) return;
    const rows = [...flowRootLine.querySelectorAll(":scope > .flow-map-row-continues")];
    rows.forEach((row) => {
      const steps = [...row.children].filter((child) => child.classList.contains("flow-map-step"));
      const terminalStep = steps[steps.length - 1];
      if (!terminalStep) return;

      const rowRect = row.getBoundingClientRect();
      const returnNode = terminalStep.querySelector(".flow-map-node-return");
      const terminalRect = (returnNode || terminalStep).getBoundingClientRect();
      const anchor = returnNode
        ? terminalRect.left + terminalRect.width / 2 - rowRect.left
        : row.classList.contains("flow-map-row-reverse")
          ? terminalRect.left - rowRect.left
          : terminalRect.right - rowRect.left;
      row.style.setProperty("--flow-turn-anchor", `${Math.max(0, anchor)}px`);
    });
  };

  const layoutFlowRows = () => {
    if (!flowRootLine || !flowScroll || flowPanel?.classList.contains("hidden")) return;
    const steps = unwrapFlowRows();
    if (steps.length < 2) {
      updateFlowOverview();
      return;
    }

    const availableWidth = Math.max(320, flowScroll.clientWidth - 20);
    const totalWidth = steps.reduce((sum, step, index) => (
      sum + step.getBoundingClientRect().width + (index ? 34 : 0)
    ), 0);
    if (totalWidth <= availableWidth * 1.08) {
      updateFlowOverview();
      return;
    }

    const rows = [];
    let row = [];
    let rowWidth = 0;
    for (const step of steps) {
      const stepWidth = step.getBoundingClientRect().width;
      const nextWidth = rowWidth + (row.length ? 34 : 0) + stepWidth;
      if (row.length && nextWidth > availableWidth) {
        rows.push(row);
        row = [];
        rowWidth = 0;
      }
      row.push(step);
      rowWidth += (row.length > 1 ? 34 : 0) + stepWidth;
    }
    if (row.length) rows.push(row);

    const fragment = document.createDocumentFragment();
    rows.forEach((items, index) => {
      const rowElement = document.createElement("div");
      rowElement.className = `flow-map-row ${index % 2 ? "flow-map-row-reverse" : ""} ${index < rows.length - 1 ? "flow-map-row-continues" : ""}`.trim();
      rowElement.dataset.flowRow = String(index);
      rowElement.append(...items);
      fragment.appendChild(rowElement);
    });
    flowRootLine.replaceChildren(fragment);
    flowRootLine.classList.add("flow-map-line-wrapped");
    updateFlowTurnAnchors();
    flowScroll.scrollLeft = 0;
    const activeFlowLink = flowRootLine.querySelector(".flow-map-node.active");
    if (activeFlowLink) {
      activeFlowLink.scrollIntoView({ block: "center", inline: "center" });
    }
    updateFlowOverview();
  };

  const clearFlowFocus = () => {
    flowMap?.classList.remove("flow-focus-active");
    flowPanel?.classList.remove("flow-branch-detail-open");
    flowPanel?.querySelectorAll(".flow-focused, .flow-focus-context").forEach((node) => {
      node.classList.remove("flow-focused", "flow-focus-context");
    });
  };

  const closeFlowBranch = () => {
    if (!flowBranchDrawer || !flowBranchBody) return;
    flowBranchDrawer.classList.add("hidden");
    flowBranchDrawer.setAttribute("aria-hidden", "true");
    flowBranchBody.replaceChildren();
    clearFlowFocus();
    requestAnimationFrame(layoutFlowRows);
  };

  const openFlowBranch = (button) => {
    if (!flowBranchDrawer || !flowBranchBody) return;
    const templateId = button.dataset.flowBranchOpen;
    const template = templateId ? document.getElementById(templateId) : null;
    if (!(template instanceof HTMLTemplateElement)) return;

    clearFlowFocus();
    flowBranchBody.replaceChildren(template.content.cloneNode(true));
    flowBranchDrawer.classList.remove("hidden");
    flowBranchDrawer.setAttribute("aria-hidden", "false");
    flowPanel?.classList.add("flow-branch-detail-open");
    flowMap?.classList.add("flow-focus-active");

    const focusedStep = button.closest(".flow-map-step");
    focusedStep?.classList.add("flow-focused");
    const rootSteps = flowRootLine
      ? [...flowRootLine.querySelectorAll(".flow-map-step")].filter((step) => step.closest(".flow-map-root-session") === flowRootLine.closest(".flow-map-root-session"))
      : [];
    const focusedIndex = rootSteps.indexOf(focusedStep);
    if (focusedIndex >= 0 && rootSteps[focusedIndex + 1]) {
      rootSteps[focusedIndex + 1].classList.add("flow-focus-context");
    }
    requestAnimationFrame(layoutFlowRows);
  };

  if (flowScroll && flowOverview) {
    flowScroll.addEventListener("scroll", updateFlowOverview, { passive: true });
    let flowResizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(flowResizeTimer);
      flowResizeTimer = setTimeout(layoutFlowRows, 120);
    });
    flowOverview.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      seekFlowOverview(event.clientX);
      flowOverview.setPointerCapture?.(event.pointerId);
      const onMove = (moveEvent) => seekFlowOverview(moveEvent.clientX);
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp, { once: true });
    });
  }

  const updateTocActivePath = (id) => {
    const activeTocLink = document.querySelector(`.session-toc .toc-link[href="#${CSS.escape(id)}"]`);
    document.querySelectorAll(".session-toc .toc-link.active-parent").forEach((link) => {
      link.classList.remove("active-parent");
    });
    if (!activeTocLink) return;

    let group = activeTocLink.closest(".toc-group");
    while (group) {
      const parentLink = group.querySelector(":scope > .toc-group-summary > .toc-link");
      if (parentLink && parentLink !== activeTocLink) {
        parentLink.classList.add("active-parent");
        group.open = true;
      }
      group = group.parentElement?.closest(".toc-group");
    }
  };

  const setActiveTarget = (id) => {
    navLinks.forEach((link) => {
      link.classList.toggle("active", link.getAttribute("href") === `#${id}`);
    });
    updateTocActivePath(id);
  };

  const updateActiveFromScroll = () => {
    scrollTicking = false;
    if (Date.now() - lastManualNav < 1200) {
      return;
    }

    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    targets.forEach((target) => {
      const rect = target.getBoundingClientRect();
      if (rect.bottom < 48 || rect.top > window.innerHeight) {
        return;
      }
      const distance = Math.abs(rect.top - 64);
      if (distance < bestDistance) {
        best = target;
        bestDistance = distance;
      }
    });

    if (best?.id) {
      setActiveTarget(best.id);
    }
  };

  document.addEventListener("click", (event) => {
    const exportLink = event.target.closest(".subagent-export-btn");
    if (exportLink) {
      event.stopPropagation();
      return;
    }

    const flowClose = event.target.closest("[data-flow-close]");
    if (flowClose && flowPanel) {
      closeFlowBranch();
      flowPanel.classList.add("hidden");
      flowPanel.setAttribute("aria-hidden", "true");
      document.body.classList.remove("flow-panel-open");
      document.querySelectorAll(".flow-open-btn[aria-expanded='true']").forEach((btn) => {
        btn.setAttribute("aria-expanded", "false");
      });
      return;
    }

    const flowBranchClose = event.target.closest("[data-flow-branch-close]");
    if (flowBranchClose) {
      closeFlowBranch();
      return;
    }

    const flowBranchOpen = event.target.closest("[data-flow-branch-open]");
    if (flowBranchOpen) {
      event.preventDefault();
      openFlowBranch(flowBranchOpen);
      return;
    }

    const flowButton = event.target.closest(".flow-open-btn");
    if (flowButton && flowPanel) {
      event.preventDefault();
      const wasHidden = flowPanel.classList.contains("hidden");
      const wasThisButtonOpen = flowButton.getAttribute("aria-expanded") === "true";
      const shouldOpen = wasHidden || !wasThisButtonOpen;
      document.querySelectorAll(".flow-open-btn").forEach((btn) => {
        btn.setAttribute("aria-expanded", btn === flowButton && shouldOpen ? "true" : "false");
      });
      if (shouldOpen) {
        flowPanel.classList.remove("hidden");
        flowPanel.setAttribute("aria-hidden", "false");
        document.body.classList.add("flow-panel-open");
        const anchor = flowButton.dataset.flowAnchor;
        const flowLink = anchor ? flowPanel.querySelector(`a[href="#${CSS.escape(anchor)}"]`) : null;
        if (flowLink) {
          navLinks.forEach((link) => link.classList.remove("active"));
          flowLink.classList.add("active");
          flowLink.scrollIntoView({ block: "nearest", inline: "center" });
        }
        flowPanel.focus({ preventScroll: true });
        requestAnimationFrame(layoutFlowRows);
      } else {
        closeFlowBranch();
        flowPanel.classList.add("hidden");
        flowPanel.setAttribute("aria-hidden", "true");
        document.body.classList.remove("flow-panel-open");
      }
      return;
    }

    const tocControl = event.target.closest("[data-toc-action]");
    if (tocControl) {
      const action = tocControl.getAttribute("data-toc-action");
      tocGroups.forEach((group) => {
        group.open = action === "expand";
      });
      return;
    }

    const link = event.target.closest(".session-toc a[href^='#'], .session-flow-panel a[href^='#']");
    if (!link) return;
    const target = document.getElementById(decodeURIComponent(link.getAttribute("href").slice(1)));
    if (!target) return;
    event.preventDefault();
    lastManualNav = Date.now();
    history.pushState(null, "", link.getAttribute("href"));
    target.scrollIntoView({ block: "start", behavior: "smooth" });
    target.classList.add("anchor-flash");
    setActiveTarget(target.id);
    setTimeout(() => target.classList.remove("anchor-flash"), 900);
  });

  if (targets.length) {
    window.addEventListener("scroll", () => {
      if (scrollTicking) {
        return;
      }
      scrollTicking = true;
      requestAnimationFrame(updateActiveFromScroll);
    }, { passive: true });

    if (location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)))) {
      setActiveTarget(decodeURIComponent(location.hash.slice(1)));
    } else {
      updateActiveFromScroll();
    }
  }
}
