const __LOCALE__ = window.__LOCALE__ || "en";
const PROVIDER = document.body.dataset.provider || "opencode";
const IS_MANAGEABLE_PROVIDER = document.body.dataset.manageable === "true";
const __I18N__ = {
  en: {
    rename_title: "Rename session",
    rename_label: "Session title",
    rename_save: "Save",
    rename_cancel: "Cancel",
    confirm_title: "Confirm action",
    confirm_accept: "Confirm",
    confirm_cancel: "Cancel",
    confirm_delete: "Delete",
    confirm_permanent_delete: "Permanently delete",
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
    session_analysis_badge: "Analysis title",
    menu_rename: "Rename",
    menu_copy_session_id: "Copy session ID",
    menu_export_md: "Export MD",
    menu_export_json: "Export JSON",
    menu_delete: "Delete",
    menu_more: "More actions",
    copy: "Copy",
    copy_session_id: "Copy session ID",
    copied: "Copied",
    more_actions: "More",
    detail_tab_conversation: "Conversation",
    detail_tab_overview: "Overview",
    detail_tab_flow: "Flow",
    detail_tab_analysis: "Analysis",
    detail_tab_raw: "Raw data",
    flow_subagent_detail: "Subagent Detail",
    flow_subagent_detail_description: "Focused child-session flow",
    flow_message_detail: "Message Detail",
    flow_message_detail_description: "Source conversation message",
    flow_open_conversation: "Open in Conversation",
    flow_close_inspector: "Close flow inspector",
    flow_message_unavailable: "The source message is unavailable.",
    resume_opened: "Terminal opened",
    resume_disabled: "Terminal launch is unavailable",
    analysis_opened: "Analysis launched. Tracking status below.",
    analysis_opened_many: "Launched {count} analysis runs. Tracking status below.",
    analysis_disabled: "Session analysis is unavailable",
    analysis_select_target: "Select at least one analysis target",
    analysis_launch_select_target: "Select a target",
    analysis_launch_one: "Analyze 1 target",
    analysis_launch_many: "Analyze {targets} targets",
    analysis_launch_running: "Analysis running",
    analysis_launch_running_title: "Running analyses: {targets}. Unselect those targets or wait for completion.",
    analysis_launch_summary: "Targets {targets} · Runtime {runtime}",
    analysis_launch_action: "Launch analysis for {targets}; runtime extensions: {runtime}",
    analysis_launch_confirm_title: "Launch session analysis?",
    analysis_launch_confirm: "Launch the external analyzer once per selected target ({count} total): {targets}. Runtime extensions: {runtime}. Each run snapshots the selected materials and session evidence, then writes proposal-only outputs.",
    analysis_launch_confirm_button: "Launch analyzer",
    analysis_none: "None",
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
    analysis_recovery_title: "Run recovery",
    analysis_diagnostics_stdout: "Open stdout",
    analysis_diagnostics_stderr: "Open stderr",
    analysis_copy_command: "Copy analyzer command",
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
    settings_project_paths_invalid: "Each project path mapping must use project-key=absolute-path.",
    settings_select_target: "Select at least one analysis target",
    settings_reset_applied: "Reset to the inherited default",
    settings_artifact_none: "None",
    settings_all_saved: "All changes saved",
    settings_unsaved: "Unsaved changes",
    theme_to_light: "Switch to light theme",
    theme_to_dark: "Switch to dark theme",
    scroll_load_more: "Load more sessions",
    scroll_all_loaded: "All sessions loaded",
    scroll_loading: "Loading...",
    "detail.search_results": "{current} / {total} turns · {occurrences} hits",
    "detail.search_no_results": "No matching turns",
    "detail.search_indexing": "Indexing conversation…",
    "stats.legend_total": "Total",
    "stats.legend_output": "Output",
    "stats.legend_input": "Input",
    "stats.legend_reasoning": "Reasoning",
    "stats.legend_cache_read": "Cache Read",
    "stats.legend_cache_write": "Cache Write",
    "stats.legend_other": "Other",
    "stats.tooltip_series": "{series}: {val}",
    "stats.tooltip_total": "Total: {total}",
    saved_views_name_prompt: "Saved view name",
    saved_views_max: "Maximum saved views reached (20).",
    saved_views_save: "Save",
    saved_views_cancel: "Cancel"
  },
  zh: {
    rename_title: "重命名会话",
    rename_label: "会话标题",
    rename_save: "保存",
    rename_cancel: "取消",
    confirm_title: "确认操作",
    confirm_accept: "确认",
    confirm_cancel: "取消",
    confirm_delete: "删除",
    confirm_permanent_delete: "永久删除",
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
    session_analysis_badge: "分析标题",
    menu_rename: "重命名",
    menu_copy_session_id: "复制会话 ID",
    menu_export_md: "导出 MD",
    menu_export_json: "导出 JSON",
    menu_delete: "删除",
    menu_more: "更多操作",
    copy: "复制",
    copy_session_id: "复制会话 ID",
    copied: "已复制",
    more_actions: "更多",
    detail_tab_conversation: "对话",
    detail_tab_overview: "概览",
    detail_tab_flow: "流程",
    detail_tab_analysis: "分析",
    detail_tab_raw: "原始数据",
    flow_subagent_detail: "子代理详情",
    flow_subagent_detail_description: "聚焦子会话流程",
    flow_message_detail: "消息详情",
    flow_message_detail_description: "来源会话消息",
    flow_open_conversation: "在对话中打开",
    flow_close_inspector: "关闭流程检查器",
    flow_message_unavailable: "源消息不可用。",
    resume_opened: "终端已打开",
    resume_disabled: "无法启动终端",
    analysis_opened: "已启动分析，可在下方跟踪状态。",
    analysis_opened_many: "已启动 {count} 个分析任务，可在下方跟踪状态。",
    analysis_disabled: "无法启动会话分析",
    analysis_select_target: "请至少选择一个分析目标",
    analysis_launch_select_target: "选择分析目标",
    analysis_launch_one: "分析 1 个目标",
    analysis_launch_many: "分析 {targets} 个目标",
    analysis_launch_running: "分析运行中",
    analysis_launch_running_title: "正在运行的分析：{targets}。请取消选择这些目标，或等待完成。",
    analysis_launch_summary: "目标 {targets} · 运行时 {runtime}",
    analysis_launch_action: "为 {targets} 启动分析；运行时扩展：{runtime} 个",
    analysis_launch_confirm_title: "启动会话分析？",
    analysis_launch_confirm: "将为每个所选目标各启动一次外部 Analyzer（共 {count} 次）：{targets}。运行时扩展：{runtime}。每个运行会快照所选材料和会话证据，然后写入仅供提案的输出。",
    analysis_launch_confirm_button: "启动 Analyzer",
    analysis_none: "无",
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
    analysis_recovery_title: "运行恢复",
    analysis_diagnostics_stdout: "打开标准输出",
    analysis_diagnostics_stderr: "打开标准错误",
    analysis_copy_command: "复制 Analyzer 命令",
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
    settings_project_paths_invalid: "每个项目路径映射必须使用 项目键=绝对路径。",
    settings_select_target: "请至少选择一个分析目标",
    settings_reset_applied: "已恢复为继承的默认值",
    settings_artifact_none: "无",
    settings_all_saved: "所有更改均已保存",
    settings_unsaved: "有未保存的更改",
    theme_to_light: "切换到浅色主题",
    theme_to_dark: "切换到深色主题",
    scroll_load_more: "加载更多会话",
    scroll_all_loaded: "已全部加载",
    scroll_loading: "加载中...",
    "detail.search_results": "第 {current} / {total} 个回合 · {occurrences} 处命中",
    "detail.search_no_results": "没有匹配的会话回合",
    "detail.search_indexing": "正在索引会话…",
    "stats.legend_total": "总量",
    "stats.legend_output": "输出",
    "stats.legend_input": "输入",
    "stats.legend_reasoning": "推理",
    "stats.legend_cache_read": "缓存读取",
    "stats.legend_cache_write": "缓存写入",
    "stats.legend_other": "其他",
    "stats.tooltip_series": "{series}：{val}",
    "stats.tooltip_total": "总计：{total}",
    saved_views_name_prompt: "已保存视图名称",
    saved_views_max: "已保存视图达到上限（20 个）。",
    saved_views_save: "保存",
    saved_views_cancel: "取消"
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
      setLines("settings-file-extensions", inheritedTarget.fileExtensions || inheritedTarget.extensions);
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

const sessionWorkbench = document.querySelector(".session-workbench");
if (sessionWorkbench) {
  const transcriptSearch = sessionWorkbench.querySelector("[data-session-search]");
  const transcriptSearchInput = transcriptSearch?.querySelector("[data-session-search-input]");
  const transcriptSearchStatus = transcriptSearch?.querySelector("[data-session-search-status]");
  const transcriptSearchPrevious = transcriptSearch?.querySelector("[data-session-search-previous]");
  const transcriptSearchNext = transcriptSearch?.querySelector("[data-session-search-next]");
  const transcriptSearchClose = transcriptSearch?.querySelector("[data-session-search-close]");
  let transcriptEntries = [];
  let transcriptIndexPromise = null;
  let transcriptMatches = [];
  let transcriptMatchIndex = -1;
  let transcriptOccurrenceCount = 0;
  let transcriptSearchRevision = 0;
  let transcriptSearchTimer = null;

  const scheduleTranscriptIndexStep = (callback) => {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(callback, { timeout: 100 });
      return;
    }
    window.setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 0 }), 0);
  };

  const getTranscriptEntries = () => {
    if (transcriptIndexPromise) return transcriptIndexPromise;
    const turns = [...sessionWorkbench.querySelectorAll(".messages .message-turn")];
    transcriptIndexPromise = new Promise((resolve) => {
      let index = 0;
      const appendEntries = (deadline) => {
        let processed = 0;
        while (index < turns.length && (processed < 12 || (!deadline.didTimeout && deadline.timeRemaining() > 2))) {
          const turn = turns[index];
          const text = [];
          const walker = document.createTreeWalker(turn, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node) {
            if (node.parentElement?.closest(".message-turn") === turn) {
              text.push(node.nodeValue || "");
            }
            node = walker.nextNode();
          }
          transcriptEntries.push({ turn, text: text.join(" ").toLocaleLowerCase() });
          index += 1;
          processed += 1;
        }
        if (index < turns.length) {
          scheduleTranscriptIndexStep(appendEntries);
          return;
        }
        resolve(transcriptEntries);
      };
      scheduleTranscriptIndexStep(appendEntries);
    });
    return transcriptIndexPromise;
  };

  const clearTranscriptHighlights = () => {
    const parents = new Set();
    sessionWorkbench.querySelectorAll("mark[data-session-search-highlight]").forEach((mark) => {
      const parent = mark.parentNode;
      parents.add(parent);
      mark.replaceWith(document.createTextNode(mark.textContent || ""));
    });
    parents.forEach((parent) => parent?.normalize());
  };

  const highlightTranscriptMatches = (query) => {
    let occurrences = 0;
    transcriptMatches.forEach((turn) => {
      const nodes = [];
      const walker = document.createTreeWalker(turn, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const parent = node.parentElement;
        if (parent?.closest(".message-turn") === turn
          && !parent.closest("mark[data-session-search-highlight]")
          && !["SCRIPT", "STYLE"].includes(parent.tagName)) {
          nodes.push(node);
        }
        node = walker.nextNode();
      }
      nodes.forEach((textNode) => {
        const value = textNode.nodeValue || "";
        const lowerValue = value.toLocaleLowerCase();
        let matchIndex = lowerValue.indexOf(query);
        if (matchIndex < 0) return;
        const fragment = document.createDocumentFragment();
        let offset = 0;
        while (matchIndex >= 0) {
          fragment.append(document.createTextNode(value.slice(offset, matchIndex)));
          const mark = document.createElement("mark");
          mark.className = "session-search-highlight";
          mark.dataset.sessionSearchHighlight = "true";
          mark.textContent = value.slice(matchIndex, matchIndex + query.length);
          fragment.append(mark);
          occurrences += 1;
          offset = matchIndex + query.length;
          matchIndex = lowerValue.indexOf(query, offset);
        }
        fragment.append(document.createTextNode(value.slice(offset)));
        textNode.replaceWith(fragment);
      });
    });
    return occurrences;
  };

  const updateTranscriptSearchControls = () => {
    const disabled = transcriptMatches.length === 0;
    if (transcriptSearchPrevious) transcriptSearchPrevious.disabled = disabled;
    if (transcriptSearchNext) transcriptSearchNext.disabled = disabled;
    if (!transcriptSearchStatus) return;
    if (!transcriptSearchInput?.value.trim()) {
      transcriptSearchStatus.textContent = "";
      return;
    }
    transcriptSearchStatus.textContent = disabled
      ? ft("detail.search_no_results")
      : formatText(ft("detail.search_results"), {
        current: transcriptMatchIndex + 1,
        total: transcriptMatches.length,
        occurrences: transcriptOccurrenceCount
      });
  };

  const revealTranscriptMatch = (turn, query) => {
    turn.querySelectorAll("details:not([open])").forEach((detail) => {
      if (detail.textContent.toLocaleLowerCase().includes(query)) {
        detail.open = true;
      }
    });
  };

  const selectTranscriptMatch = (index, scroll = true) => {
    if (!transcriptMatches.length) return;
    transcriptMatchIndex = (index + transcriptMatches.length) % transcriptMatches.length;
    transcriptMatches.forEach((entry, entryIndex) => {
      entry.classList.toggle("session-search-current", entryIndex === transcriptMatchIndex);
    });
    const current = transcriptMatches[transcriptMatchIndex];
    revealTranscriptMatch(current, transcriptSearchInput?.value.trim().toLocaleLowerCase() || "");
    if (scroll) {
      current.scrollIntoView({ block: "center", behavior: "auto" });
    }
    updateTranscriptSearchControls();
  };

  const updateTranscriptMatches = async (scroll = false) => {
    const revision = ++transcriptSearchRevision;
    const query = transcriptSearchInput?.value.trim().toLocaleLowerCase() || "";
    transcriptMatches.forEach((entry) => entry.classList.remove("session-search-match", "session-search-current"));
    clearTranscriptHighlights();
    transcriptMatches = [];
    transcriptMatchIndex = -1;
    transcriptOccurrenceCount = 0;
    if (query) {
      if (transcriptSearchStatus) transcriptSearchStatus.textContent = ft("detail.search_indexing");
      const entries = await getTranscriptEntries();
      if (revision !== transcriptSearchRevision) return;
      transcriptMatches = entries
        .filter((entry) => entry.text.includes(query))
        .map((entry) => entry.turn);
      transcriptMatches.forEach((entry) => entry.classList.add("session-search-match"));
      if (transcriptMatches.length) {
        transcriptOccurrenceCount = highlightTranscriptMatches(query);
        selectTranscriptMatch(0, scroll);
        return;
      }
    }
    updateTranscriptSearchControls();
  };

  transcriptSearchInput?.addEventListener("input", () => {
    window.clearTimeout(transcriptSearchTimer);
    transcriptSearchTimer = window.setTimeout(() => void updateTranscriptMatches(true), 80);
  });
  transcriptSearchInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !transcriptMatches.length) return;
    event.preventDefault();
    selectTranscriptMatch(transcriptMatchIndex + (event.shiftKey ? -1 : 1));
  });
  transcriptSearchPrevious?.addEventListener("click", () => selectTranscriptMatch(transcriptMatchIndex - 1));
  transcriptSearchNext?.addEventListener("click", () => selectTranscriptMatch(transcriptMatchIndex + 1));
  transcriptSearchClose?.addEventListener("click", () => {
    const current = transcriptMatches[transcriptMatchIndex] || null;
    transcriptSearch.open = false;
    if (current) {
      const hadTabIndex = current.hasAttribute("tabindex");
      current.tabIndex = -1;
      current.focus({ preventScroll: true });
      if (!hadTabIndex) {
        current.addEventListener("blur", () => current.removeAttribute("tabindex"), { once: true });
      }
      return;
    }
    const toggle = transcriptSearch.querySelector("[data-session-search-toggle]");
    const toggleRect = toggle?.getBoundingClientRect();
    if (toggleRect && toggleRect.bottom > 0 && toggleRect.top < window.innerHeight) {
      toggle.focus({ preventScroll: true });
    } else {
      transcriptSearchClose.blur();
    }
  });
  transcriptSearch?.addEventListener("toggle", () => {
    if (!transcriptSearch.open) return;
    transcriptSearchInput?.focus();
    void getTranscriptEntries();
  });

  const tocGroups = [...document.querySelectorAll(".session-toc .toc-group")];
  const tocResizeHandle = document.querySelector(".toc-resize-handle");
  let lastManualNav = 0;
  let scrollTicking = false;
  let flowLoadPromise = null;
  let flowResizeTimer = null;
  let flowInspectorOpener = null;
  let navLinksCache = [];
  let linkedTargetsCache = [];
  let navigationCacheDirty = true;

  const getFlowPanel = () => document.getElementById("session-flow-panel");
  const getFlowScroll = () => getFlowPanel()?.querySelector(".flow-map-scroll");
  const getFlowOverview = () => getFlowPanel()?.querySelector("[data-flow-overview]");
  const getFlowOverviewWindow = () => getFlowPanel()?.querySelector("[data-flow-overview-window]");
  const getFlowRootLine = () => getFlowPanel()?.querySelector(".flow-map-root-session > .flow-map-line");
  const getFlowMap = () => getFlowPanel()?.querySelector(".flow-map");
  const getFlowInspector = () => getFlowPanel()?.querySelector("[data-flow-inspector]");
  const getFlowInspectorTitle = () => getFlowPanel()?.querySelector("[data-flow-inspector-title]");
  const getFlowInspectorDescription = () => getFlowPanel()?.querySelector("[data-flow-inspector-description]");
  const getFlowInspectorBody = () => getFlowPanel()?.querySelector("[data-flow-inspector-body]");
  const getNavLinks = () => {
    if (navigationCacheDirty) {
      navLinksCache = [...document.querySelectorAll(".session-toc a[href^='#'], .session-flow-panel a[href^='#']")];
      linkedTargetsCache = [...new Set(navLinksCache.map(targetFromLink).filter(Boolean))];
      navigationCacheDirty = false;
    }
    return navLinksCache;
  };
  const getLinkedTargets = () => {
    getNavLinks();
    return linkedTargetsCache;
  };
  const invalidateNavigationCache = () => {
    navigationCacheDirty = true;
  };
  const targetFromLink = (link) => {
    const href = link.getAttribute("href") || "";
    if (!href.startsWith("#")) return null;
    try {
      return document.getElementById(decodeURIComponent(href.slice(1)));
    } catch {
      return null;
    }
  };

  try {
    const storedTocWidth = Number(localStorage.getItem("agentsession.tocWidth") || localStorage.getItem("opensessionviewer.tocWidth"));
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
          localStorage.setItem("agentsession.tocWidth", String(width));
        } catch {}
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp, { once: true });
    });
  }

  const updateFlowOverview = () => {
    const flowScroll = getFlowScroll();
    const flowOverviewWindow = getFlowOverviewWindow();
    const flowRootLine = getFlowRootLine();
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
    const flowScroll = getFlowScroll();
    const flowOverview = getFlowOverview();
    const flowRootLine = getFlowRootLine();
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
    const flowRootLine = getFlowRootLine();
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
    const flowRootLine = getFlowRootLine();
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
    const flowPanel = getFlowPanel();
    const flowScroll = getFlowScroll();
    const flowRootLine = getFlowRootLine();
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
    const flowPanel = getFlowPanel();
    const flowMap = getFlowMap();
    flowMap?.classList.remove("flow-focus-active");
    flowPanel?.classList.remove("flow-inspector-open");
    flowPanel?.querySelectorAll(".flow-focused, .flow-focus-context").forEach((node) => {
      node.classList.remove("flow-focused", "flow-focus-context");
    });
  };

  const closeFlowInspector = ({ restoreFocus = true } = {}) => {
    const flowInspector = getFlowInspector();
    const flowInspectorBody = getFlowInspectorBody();
    const opener = flowInspectorOpener;
    flowInspectorOpener = null;
    if (flowInspector && flowInspectorBody) {
      flowInspector.classList.add("hidden");
      flowInspector.setAttribute("aria-hidden", "true");
      flowInspectorBody.replaceChildren();
    }
    clearFlowFocus();
    requestAnimationFrame(() => {
      layoutFlowRows();
      if (restoreFocus && opener?.isConnected) {
        opener.focus({ preventScroll: true });
      }
    });
  };

  const openFlowInspector = ({ title, description, content, source }) => {
    const flowPanel = getFlowPanel();
    const flowMap = getFlowMap();
    const flowRootLine = getFlowRootLine();
    const flowInspector = getFlowInspector();
    const flowInspectorTitle = getFlowInspectorTitle();
    const flowInspectorDescription = getFlowInspectorDescription();
    const flowInspectorBody = getFlowInspectorBody();
    if (!flowInspector || !flowInspectorTitle || !flowInspectorDescription || !flowInspectorBody) return;

    clearFlowFocus();
    flowInspectorOpener = source instanceof HTMLElement ? source : null;
    flowInspectorTitle.textContent = title;
    flowInspectorDescription.textContent = description;
    flowInspectorBody.replaceChildren(content);
    flowInspector.classList.remove("hidden");
    flowInspector.setAttribute("aria-hidden", "false");
    flowPanel?.classList.add("flow-inspector-open");
    flowMap?.classList.add("flow-focus-active");

    const focusedStep = source?.closest(".flow-map-step");
    focusedStep?.classList.add("flow-focused");
    const rootSteps = flowRootLine
      ? [...flowRootLine.querySelectorAll(".flow-map-step")].filter((step) => step.closest(".flow-map-root-session") === flowRootLine.closest(".flow-map-root-session"))
      : [];
    const focusedIndex = rootSteps.indexOf(focusedStep);
    if (focusedIndex >= 0 && rootSteps[focusedIndex + 1]) {
      rootSteps[focusedIndex + 1].classList.add("flow-focus-context");
    }
    requestAnimationFrame(() => {
      layoutFlowRows();
      if (flowInspector.classList.contains("hidden")) return;
      const focusTarget = flowInspector.querySelector("[data-flow-open-conversation]")
        || flowInspector.querySelector("[data-flow-inspector-close]");
      focusTarget?.focus({ preventScroll: true });
    });
  };

  const openFlowBranch = (button) => {
    const templateId = button.dataset.flowBranchOpen;
    const template = templateId ? document.getElementById(templateId) : null;
    if (!(template instanceof HTMLTemplateElement)) return;
    openFlowInspector({
      title: ft("flow_subagent_detail"),
      description: ft("flow_subagent_detail_description"),
      content: template.content.cloneNode(true),
      source: button
    });
  };

  const openFlowMessagePreview = (link) => {
    const targetId = String(link.dataset.flowPreviewTarget || "").replace(/^#/, "");
    const target = targetId ? document.getElementById(targetId) : null;
    const sourceMessage = target?.matches(".message-turn") ? target : target?.closest(".message-turn");
    const content = document.createElement("div");
    content.className = "flow-message-preview";

    if (!sourceMessage) {
      const unavailable = document.createElement("p");
      unavailable.className = "toc-empty";
      unavailable.setAttribute("role", "status");
      unavailable.textContent = ft("flow_message_unavailable");
      content.append(unavailable);
    } else {
      const actions = document.createElement("div");
      actions.className = "flow-inspector-actions";
      const openConversation = document.createElement("button");
      openConversation.type = "button";
      openConversation.className = "flow-inspector-open-conversation";
      openConversation.dataset.flowOpenConversation = target?.id || sourceMessage.id;
      openConversation.textContent = ft("flow_open_conversation");
      actions.append(openConversation);

      const preview = sourceMessage.cloneNode(true);
      if (preview instanceof HTMLElement) {
        preview.removeAttribute("id");
        preview.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
        preview.querySelectorAll(".message-controls, .subagent-actions").forEach((node) => node.remove());
        preview.classList.add("flow-message-preview-turn");
      }
      content.append(actions, preview);
    }

    openFlowInspector({
      title: ft("flow_message_detail"),
      description: ft("flow_message_detail_description"),
      content,
      source: link
    });
  };

  const hideFlowPanel = () => {
    const flowPanel = getFlowPanel();
    if (!flowPanel) return;
    closeFlowInspector({ restoreFocus: false });
    flowPanel.classList.add("hidden");
    flowPanel.setAttribute("aria-hidden", "true");
    document.querySelectorAll(".flow-open-btn[aria-expanded='true']").forEach((btn) => {
      btn.setAttribute("aria-expanded", "false");
    });
  };

  const openFlowTargetInConversation = (targetId) => {
    const target = targetId ? document.getElementById(targetId) : null;
    hideFlowPanel();
    document.getElementById("tab-btn-conversation")?.click();
    if (!target) return;
    requestAnimationFrame(() => {
      lastManualNav = Date.now();
      history.pushState(null, "", `#${target.id}`);
      target.scrollIntoView({ block: "start", behavior: "auto" });
      target.classList.add("anchor-flash");
      setActiveTarget(target.id);
      setTimeout(() => target.classList.remove("anchor-flash"), 900);
    });
  };

  const bindFlowPanelControls = () => {
    const flowScroll = getFlowScroll();
    const flowOverview = getFlowOverview();
    if (!flowScroll || !flowOverview) return;
    if (!flowScroll.dataset.flowScrollBound) {
      flowScroll.addEventListener("scroll", updateFlowOverview, { passive: true });
      flowScroll.dataset.flowScrollBound = "true";
    }
    if (flowOverview.dataset.flowOverviewBound) return;
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
    flowOverview.dataset.flowOverviewBound = "true";
  };

  const setFlowLazyStatus = (text) => {
    const status = getFlowPanel()?.querySelector("[data-flow-lazy-status]");
    if (status) status.textContent = text;
  };

  const ensureFlowLoaded = async () => {
    const flowPanel = getFlowPanel();
    if (!flowPanel) return false;
    const lazyUrl = flowPanel.dataset.flowLazyUrl;
    if (!lazyUrl) {
      bindFlowPanelControls();
      return true;
    }
    if (flowLoadPromise) return flowLoadPromise;

    flowPanel.dataset.flowState = "loading";
    setFlowLazyStatus("Loading flow...");
    flowLoadPromise = (async () => {
      const response = await fetch(lazyUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const html = await response.text();
      flowPanel.innerHTML = html;
      delete flowPanel.dataset.flowLazyUrl;
      flowPanel.dataset.flowState = "loaded";
      invalidateNavigationCache();
      bindFlowPanelControls();
      return true;
    })().catch(() => {
      flowLoadPromise = null;
      flowPanel.dataset.flowState = "error";
      setFlowLazyStatus("Flow could not be loaded.");
      showToast(ft("toast_error"), "error");
      return false;
    });
    return flowLoadPromise;
  };

  document.addEventListener("session-flow-tab-open", async () => {
    const flowPanel = getFlowPanel();
    if (!flowPanel) return;
    flowPanel.classList.remove("hidden");
    flowPanel.setAttribute("aria-hidden", "false");
    const loaded = await ensureFlowLoaded();
    if (!loaded) return;
    requestAnimationFrame(() => {
      layoutFlowRows();
      updateFlowOverview();
    });
  });

  window.addEventListener("resize", () => {
    clearTimeout(flowResizeTimer);
    flowResizeTimer = setTimeout(layoutFlowRows, 120);
  });
  bindFlowPanelControls();

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
    getNavLinks().forEach((link) => {
      link.classList.toggle("active", link.getAttribute("href") === `#${id}`);
    });
    updateTocActivePath(id);
  };

  const cssPixelValue = (name, fallback) => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const updateActiveFromScroll = () => {
    scrollTicking = false;
    if (Date.now() - lastManualNav < 1200) {
      return;
    }

    const topbarHeight = cssPixelValue("--topbar-height", 48);
    const anchorOffset = cssPixelValue("--session-anchor-offset", 80);
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    getLinkedTargets().forEach((target) => {
      const rect = target.getBoundingClientRect();
      if (rect.bottom < topbarHeight || rect.top > window.innerHeight) {
        return;
      }
      const distance = Math.abs(rect.top - anchorOffset);
      if (distance < bestDistance) {
        best = target;
        bestDistance = distance;
      }
    });

    if (best?.id) {
      setActiveTarget(best.id);
    }
  };

  document.addEventListener("click", async (event) => {
    const exportLink = event.target.closest(".subagent-export-btn");
    if (exportLink) {
      event.stopPropagation();
      return;
    }

    const flowClose = event.target.closest("[data-flow-close]");
    const flowPanel = getFlowPanel();
    if (flowClose && flowPanel) {
      hideFlowPanel();
      return;
    }

    const flowInspectorClose = event.target.closest("[data-flow-inspector-close]");
    if (flowInspectorClose) {
      closeFlowInspector();
      return;
    }

    const flowBranchOpen = event.target.closest("[data-flow-branch-open]");
    if (flowBranchOpen) {
      event.preventDefault();
      const loaded = await ensureFlowLoaded();
      if (!loaded) return;
      openFlowBranch(flowBranchOpen);
      return;
    }

    const flowPreview = event.target.closest("[data-flow-preview-target]");
    if (flowPreview) {
      event.preventDefault();
      const loaded = await ensureFlowLoaded();
      if (!loaded) return;
      openFlowMessagePreview(flowPreview);
      return;
    }

    const flowOpenConversation = event.target.closest("[data-flow-open-conversation]");
    if (flowOpenConversation) {
      event.preventDefault();
      openFlowTargetInConversation(flowOpenConversation.dataset.flowOpenConversation);
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
        document.getElementById("tab-btn-flow")?.click();
        flowPanel.classList.remove("hidden");
        flowPanel.setAttribute("aria-hidden", "false");
        const loaded = await ensureFlowLoaded();
        if (!loaded) return;
        const anchor = flowButton.dataset.flowAnchor;
        const flowLink = anchor ? flowPanel.querySelector(`a[href="#${CSS.escape(anchor)}"]`) : null;
        if (flowLink) {
          getNavLinks().forEach((link) => link.classList.remove("active"));
          flowLink.classList.add("active");
          flowLink.scrollIntoView({ block: "nearest", inline: "center" });
        }
        flowPanel.focus({ preventScroll: true });
        requestAnimationFrame(layoutFlowRows);
      } else {
        hideFlowPanel();
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
    target.scrollIntoView({ block: "start", behavior: "auto" });
    target.classList.add("anchor-flash");
    setActiveTarget(target.id);
    setTimeout(() => target.classList.remove("anchor-flash"), 900);
  });

  if (getLinkedTargets().length) {
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

// ── Tab bar navigation ──────────────────────────────────────────────

(function initTabBar() {
  const tabBar = document.querySelector(".tab-bar");
  if (!tabBar) return;

  // Enable tabs: show tab bar, hide inactive panels
  tabBar.removeAttribute("hidden");
  const tabButtons = tabBar.querySelectorAll("[role='tab']");
  const tabPanels = document.querySelectorAll("[role='tabpanel']");

  const initiallySelected = tabBar.querySelector("[role='tab'][aria-selected='true']") || tabButtons[0];

  // JavaScript progressively enhances the no-JS stacked content into tabs.
  tabPanels.forEach(function (panel) {
    if (panel.id === initiallySelected?.getAttribute("aria-controls")) {
      panel.removeAttribute("hidden");
    } else {
      panel.setAttribute("hidden", "");
    }
  });

  function switchTab(tabButton) {
    // Deactivate all tabs
    tabButtons.forEach(function (btn) {
      btn.setAttribute("aria-selected", "false");
      btn.setAttribute("tabindex", "-1");
    });
    // Activate selected tab
    tabButton.setAttribute("aria-selected", "true");
    tabButton.setAttribute("tabindex", "0");
    tabButton.focus();
    const targetPanelId = tabButton.getAttribute("aria-controls");
    document.querySelector(".session-workbench")?.classList.toggle("session-conversation-tab-active", targetPanelId === "tab-conversation");
    // Show/hide panels
    tabPanels.forEach(function (panel) {
      if (panel.id === targetPanelId) {
        panel.removeAttribute("hidden");
        // Auto-open analysis details if switching to analysis tab
        if (panel.id === "tab-analysis") {
          var details = panel.querySelector(".analysis-activity-details");
          if (details && !details.open) {
            var hasActive = details.querySelector(".analysis-activity-badge");
            if (hasActive) details.open = true;
          }
        }
        if (panel.id === "tab-flow") {
          document.dispatchEvent(new CustomEvent("session-flow-tab-open"));
        }
      } else {
        panel.setAttribute("hidden", "");
      }
    });
  }

  // Click handler
  tabBar.addEventListener("click", function (e) {
    var tab = e.target.closest("[role='tab']");
    if (!tab) return;
    e.preventDefault();
    switchTab(tab);
  });

  // Keyboard navigation: roving tabindex
  tabBar.addEventListener("keydown", function (e) {
    var tabs = Array.from(tabBar.querySelectorAll("[role='tab']"));
    var current = document.activeElement;
    var currentIndex = tabs.indexOf(current);
    if (currentIndex === -1) return;

    var nextIndex = currentIndex;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (e.key === "Home") {
      e.preventDefault();
      nextIndex = 0;
    } else if (e.key === "End") {
      e.preventDefault();
      nextIndex = tabs.length - 1;
    } else {
      return;
    }

    tabs[nextIndex].focus();
    switchTab(tabs[nextIndex]);
  });

  document.querySelector(".session-workbench")?.classList.add("session-conversation-tab-active");
  document.addEventListener("click", function (e) {
    if (!e.target.closest("#tab-flow [data-flow-close]")) return;
    const conversationTab = document.getElementById("tab-btn-conversation");
    if (conversationTab) switchTab(conversationTab);
  }, true);
})();

// ── Analysis activity collapse ─────────────────────────────────────────

(function initAnalysisActivity() {
  var details = document.getElementById("analysis-activity-details");
  if (!details) return;

  // Server may have already added "open" for active runs; JS handles refresh
  // Listen for analysis status panel refreshes to auto-open if needed
  var panel = document.getElementById("analysis-status-panel");
  if (!panel) return;

  var observer = new MutationObserver(function () {
    // If any analysis run is active/waiting/failed/needs_attention, open the details
    var badge = details.querySelector(".analysis-activity-badge");
    if (badge && !details.open) {
      details.open = true;
    }
  });
  observer.observe(panel, { childList: true, subtree: true, characterData: true });
})();

// ── Token Explorer interactivity ───────────────────────────────────────

(function initTokenExplorer() {
  if (document.body.dataset.page !== "stats") return;

  const statsForm = document.querySelector(".stats-filter-bar");
  const customDates = document.querySelector(".stats-filter-custom-dates");
  const customRadio = document.querySelector(".stats-preset-radio[value='custom']");

  if (statsForm) {
    document.querySelectorAll(".stats-preset-radio").forEach((radio) => {
      radio.addEventListener("change", function () {
        if (this.value === "custom") {
          if (customDates) customDates.classList.remove("hidden");
        } else {
          if (customDates) customDates.classList.add("hidden");
          statsForm.submit();
        }
      });
    });

    if (customRadio?.checked && customDates) {
      customDates.classList.remove("hidden");
    } else if (customDates) {
      customDates.classList.add("hidden");
    }
  }

  const chartSvg = document.querySelector(".trend-chart");
  const trendToggles = Array.from(document.querySelectorAll(".trend-legend-toggle"));
  const enabledTrendSeries = () => new Set(
    trendToggles.filter((toggle) => toggle.checked && !toggle.disabled).map((toggle) => toggle.dataset.series)
  );
  const compactTrendNumber = (value) => {
    const number = Number(value) || 0;
    if (number >= 1_000_000_000) return (number / 1_000_000_000).toFixed(2) + "B";
    if (number >= 1_000_000) return (number / 1_000_000).toFixed(2) + "M";
    if (number >= 1_000) return (number / 1_000).toFixed(1) + "K";
    return number.toLocaleString();
  };

  function reflowTrendChart() {
    if (!chartSvg) return;
    const enabled = enabledTrendSeries();
    const plotTop = Number(chartSvg.dataset.plotTop) || 0;
    const plotHeight = Number(chartSvg.dataset.plotHeight) || 1;
    const hits = Array.from(chartSvg.querySelectorAll(".trend-day-hit"));
    const barsByDay = hits.map(() => []);
    chartSvg.querySelectorAll(".trend-bar").forEach((bar) => {
      const dayIndex = Number(bar.dataset.dayIndex);
      if (barsByDay[dayIndex]) barsByDay[dayIndex].push(bar);
    });
    const visibleTotals = barsByDay.map((bars) => bars.reduce((sum, bar) =>
      enabled.has(bar.dataset.series) ? sum + (Number(bar.dataset.value) || 0) : sum, 0));
    const positiveTotals = visibleTotals.filter(Boolean).sort((a, b) => b - a);
    const maxTotal = Math.max(...visibleTotals, 1);
    const secondTotal = positiveTotals[1] || 0;
    const clippedScale = secondTotal > 0 && maxTotal > secondTotal * 4;
    const chartMax = clippedScale ? Math.max(1, secondTotal * 1.25) : maxTotal;
    const yValue = (value) => plotTop + plotHeight - (Math.min(value, chartMax) / chartMax) * plotHeight;

    chartSvg.querySelectorAll(".trend-y-label").forEach((label) => {
      const index = Number(label.dataset.gridIndex) || 0;
      label.textContent = compactTrendNumber(chartMax - (index / 4) * chartMax);
    });

    barsByDay.forEach((bars, dayIndex) => {
      let cumulative = 0;
      bars.forEach((bar) => {
        const visible = enabled.has(bar.dataset.series);
        bar.classList.toggle("hidden", !visible);
        if (!visible) return;
        const value = Number(bar.dataset.value) || 0;
        const baseY = yValue(cumulative);
        cumulative += value;
        const topY = yValue(cumulative);
        bar.setAttribute("y", String(topY));
        bar.setAttribute("height", String(Math.max(0, baseY - topY)));
      });

      const isClipped = clippedScale && visibleTotals[dayIndex] > chartMax;
      const marker = chartSvg.querySelector(`.trend-clipped-marker[data-day-index="${dayIndex}"]`);
      const label = chartSvg.querySelector(`.trend-clipped-label[data-day-index="${dayIndex}"]`);
      marker?.classList.toggle("hidden", !isClipped);
      label?.classList.toggle("hidden", !isClipped);
      if (label) label.textContent = compactTrendNumber(visibleTotals[dayIndex]);
      if (hits[dayIndex]) hits[dayIndex].dataset.visibleTotal = String(visibleTotals[dayIndex]);
    });
    document.querySelector(".trend-scale-note")?.classList.toggle("hidden", !clippedScale);
  }

  trendToggles.forEach((toggle) => {
    toggle.addEventListener("change", function () {
      reflowTrendChart();
    });
  });
  reflowTrendChart();

  const tooltip = document.getElementById("trend-tooltip");
  const chartBody = chartSvg?.closest(".stats-chart-body");
  if (chartBody) chartBody.style.position = "relative";
  if (tooltip && chartSvg && chartBody) {
      const seriesLabels = {
        total: ft("stats.legend_total"),
        output: ft("stats.legend_output"),
        input: ft("stats.legend_input"),
        reasoning: ft("stats.legend_reasoning"),
        cacheRead: ft("stats.legend_cache_read"),
        cacheWrite: ft("stats.legend_cache_write"),
        other: ft("stats.legend_other"),
      };
      const showTrendTooltip = function (hit, clientX, clientY) {
        if (!hit) {
          tooltip.hidden = true;
          return;
        }
        const day = hit.dataset.day;
        const visibleSeries = enabledTrendSeries();
        const total = Number(hit.dataset.visibleTotal) || 0;
        const values = [
          ["input", hit.dataset.input],
          ["cacheRead", hit.dataset.cacheRead],
          ["cacheWrite", hit.dataset.cacheWrite],
          ["output", hit.dataset.output],
          ["reasoning", hit.dataset.reasoning],
          ["other", hit.dataset.other],
        ].map(([series, raw]) => [series, Number(raw) || 0])
          .filter(([series, value]) => visibleSeries.has(series) && value > 0);
        tooltip.innerHTML = "<strong>" + day + "</strong>" +
          values.map(([series, value]) => "<span><i style=\"background:" + ({ input: "#60a5fa", cacheRead: "#34d399", cacheWrite: "#14b8a6", output: "#a78bfa", reasoning: "#fbbf24", other: "#64748b" }[series] || "#64748b") + "\"></i>" +
            formatText(ft("stats.tooltip_series"), { series: seriesLabels[series] || series, val: value.toLocaleString() }) + "</span>").join("") +
          "<b>" + formatText(ft("stats.tooltip_total"), { total: total.toLocaleString() }) + "</b>";
        tooltip.hidden = false;

        const chartBodyRect = chartBody.getBoundingClientRect();
        const hitRect = hit.getBoundingClientRect();
        const anchorX = Number.isFinite(clientX) ? clientX : hitRect.left + hitRect.width / 2;
        const anchorY = Number.isFinite(clientY) ? clientY : hitRect.top + hitRect.height / 2;
        const rawLeft = anchorX - chartBodyRect.left + chartBody.scrollLeft + 12;
        const rawTop = anchorY - chartBodyRect.top + chartBody.scrollTop - tooltip.offsetHeight - 12;
        const minLeft = chartBody.scrollLeft;
        const maxLeft = Math.max(minLeft, chartBody.scrollLeft + chartBody.clientWidth - tooltip.offsetWidth);
        const minTop = chartBody.scrollTop;
        const maxTop = Math.max(minTop, chartBody.scrollTop + chartBody.clientHeight - tooltip.offsetHeight);
        tooltip.style.left = Math.min(maxLeft, Math.max(minLeft, rawLeft)) + "px";
        tooltip.style.top = Math.min(maxTop, Math.max(minTop, rawTop)) + "px";
      };

      chartSvg.addEventListener("mousemove", function (e) {
        showTrendTooltip(e.target.closest(".trend-hit"), e.clientX, e.clientY);
      });
      chartSvg.addEventListener("click", function (e) {
        const hit = e.target.closest(".trend-hit");
        const href = hit?.getAttribute("href");
        if (href) {
          e.preventDefault();
          window.location.assign(href);
        }
      });
      chartSvg.addEventListener("focusin", function (e) {
        showTrendTooltip(e.target.closest(".trend-hit"));
      });
      chartSvg.addEventListener("focusout", function (e) {
        if (!e.relatedTarget || !chartSvg.contains(e.relatedTarget)) tooltip.hidden = true;
      });
      chartSvg.addEventListener("mouseleave", function () {
        tooltip.hidden = true;
      });
  }

  document.querySelectorAll(".stats-filter-scope-label input[type='radio']").forEach((radio) => {
    radio.addEventListener("change", function () {
      document.querySelectorAll(".stats-filter-scope-label").forEach(l => l.classList.remove("active"));
      if (this.checked && this.closest(".stats-filter-scope-label")) {
        this.closest(".stats-filter-scope-label").classList.add("active");
      }
    });
  });

  // ── Token Explorer: Saved Views ──────────────────────────────────────────
  function initSavedViews() {
    const container = document.querySelector(".stats-saved-views");
    if (!container) return;
    const provider = container.dataset.provider;
    const storageKey = `osv-saved-views-${provider}`;
    const listEl = document.getElementById("saved-views-list");
    const template = document.getElementById("saved-view-template");
    const maxViews = 20;
    const expectedPath = `/${encodeURIComponent(provider)}/stats`;

    function normalizeViews(raw) {
      if (!Array.isArray(raw)) return [];
      return raw.flatMap((view) => {
        if (!view || typeof view !== "object") return [];
        const name = typeof view.name === "string" ? view.name.trim().slice(0, 80) : "";
        const url = typeof view.url === "string" ? view.url : "";
        if (!name || !url) return [];
        try {
          const parsed = new URL(url, window.location.origin);
          if (parsed.origin !== window.location.origin || parsed.pathname !== expectedPath) return [];
          return [{ name, url: parsed.pathname + parsed.search }];
        } catch {
          return [];
        }
      }).slice(0, maxViews);
    }

    function loadViews() {
      try {
        return normalizeViews(JSON.parse(localStorage.getItem(storageKey) || "[]"));
      } catch { return []; }
    }

    function saveViews(views) {
      localStorage.setItem(storageKey, JSON.stringify(views));
    }

    function render() {
      if (!listEl) return;
      const views = loadViews();
      listEl.innerHTML = "";
      views.forEach((v, i) => {
        const clone = template.content.cloneNode(true);
        const link = clone.querySelector(".saved-view-link");
        const delBtn = clone.querySelector(".saved-view-delete");
        link.href = v.url;
        link.textContent = v.name;
        delBtn.addEventListener("click", () => {
          const current = loadViews();
          current.splice(i, 1);
          saveViews(current);
          render();
        });
        listEl.appendChild(clone);
      });
    }

    const saveBtn = document.getElementById("save-view-btn");
    if (saveBtn) {
      saveBtn.addEventListener("click", () => {
        const views = loadViews();
        if (views.length >= maxViews) {
          showToast(__I18N__[__LOCALE__]?.saved_views_max || "Maximum saved views reached (20).");
          return;
        }
        const dialog = document.createElement("dialog");
        dialog.className = "saved-view-dialog";
        dialog.setAttribute("aria-labelledby", "saved-view-dialog-title");
        const label = ft("saved_views_name_prompt");
        dialog.innerHTML = `<form method="dialog">
          <label id="saved-view-dialog-title" for="saved-view-name">${escapeHtmlClient(label)}</label>
          <input id="saved-view-name" type="text" class="saved-view-input" maxlength="80" autocomplete="off">
          <div class="saved-view-dialog-actions">
            <button type="button" class="saved-view-dialog-save">${escapeHtmlClient(ft("saved_views_save"))}</button>
            <button type="button" class="saved-view-dialog-cancel">${escapeHtmlClient(ft("saved_views_cancel"))}</button>
          </div>
        </form>`;
        document.body.appendChild(dialog);
        const input = dialog.querySelector(".saved-view-input");
        const closeDialog = () => {
          if (dialog.open) dialog.close();
          dialog.remove();
        };
        dialog.addEventListener("close", () => dialog.remove(), { once: true });
        dialog.querySelector(".saved-view-dialog-cancel").addEventListener("click", closeDialog);
        dialog.querySelector(".saved-view-dialog-save").addEventListener("click", () => {
          const name = input.value.trim();
          closeDialog();
          if (!name) return;
          const url = window.location.pathname + window.location.search;
          views.push({ name, url });
          saveViews(views);
          render();
        });
        dialog.querySelector("form").addEventListener("submit", (event) => {
          event.preventDefault();
          dialog.querySelector(".saved-view-dialog-save").click();
        });
        dialog.showModal();
        input.focus();
      });
    }

    render();
  }

  // ── Token Explorer: Compare Selectors ────────────────────────────────────
  function initCompareSelectors() {
    const form = document.querySelector(".stats-filter-bar");
    if (!form) return;
    const selectA = form.querySelector("select[name='comparea']");
    const selectB = form.querySelector("select[name='compareb']");
    if (!selectA || !selectB) return;

    function update() {
      const valA = selectA.value;
      const valB = selectB.value;
      Array.from(selectA.options).forEach(opt => {
        opt.disabled = opt.value !== "" && opt.value === valB && valB !== "";
      });
      Array.from(selectB.options).forEach(opt => {
        opt.disabled = opt.value !== "" && opt.value === valA && valA !== "";
      });
    }

    selectA.addEventListener("change", update);
    selectB.addEventListener("change", update);
    update();
  }

  // ── Token Explorer: Deferred Sections ─────────────────────────────────────
  function initDeferredStats() {
    const sections = Array.from(document.querySelectorAll("[data-stats-deferred-url]"));
    if (!sections.length) return;

    const load = async (section) => {
      if (section.dataset.statsDeferredState === "loading" || section.dataset.statsDeferredState === "loaded") return;
      section.dataset.statsDeferredState = "loading";
      try {
        const url = new URL(section.dataset.statsDeferredUrl, window.location.origin);
        url.searchParams.set("section", section.dataset.statsDeferredSection);
        const response = await fetch(url, { headers: { Accept: "text/html" } });
        if (!response.ok) throw new Error(`Deferred stats request failed: ${response.status}`);
        section.innerHTML = await response.text();
        section.dataset.statsDeferredState = "loaded";
        section.removeAttribute("aria-busy");
      } catch (error) {
        console.error(error);
        section.innerHTML = `<p class="stats-empty">${escapeHtmlClient(ft("stats.load_failed"))}</p>`;
        section.dataset.statsDeferredState = "failed";
        section.removeAttribute("aria-busy");
      }
    };

    const secondary = sections.filter((section) => section.dataset.statsDeferredSection === "secondary");
    if (secondary.length) {
      if ("IntersectionObserver" in window) {
        const observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            observer.unobserve(entry.target);
            void load(entry.target);
          }
        }, { rootMargin: "320px 0px" });
        secondary.forEach((section) => observer.observe(section));
      } else {
        secondary.forEach((section) => { void load(section); });
      }
    }

    sections
      .filter((section) => section.dataset.statsDeferredSection === "advanced")
      .forEach((section) => {
        const details = section.closest("details");
        if (!details) return;
        if (details.open) void load(section);
        details.addEventListener("toggle", () => {
          if (details.open) void load(section);
        });
      });
  }

  initSavedViews();

  initCompareSelectors();

  initDeferredStats();
})();
