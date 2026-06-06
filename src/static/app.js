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
    scroll_all_loaded: "已全部加载",
    scroll_loading: "加载中..."
  }
};

function ft(key) {
  return __I18N__[__LOCALE__]?.[key] ?? __I18N__.en[key] ?? key;
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

  if (action === "copy-resume-command") {
    try {
      await copyText(btn.dataset.command || "");
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
