export function initSessionWorkbench({ ft, formatText, showToast }) {
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
    const storedTocWidth = Number(localStorage.getItem("agentsession.tocWidth"));
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


}
