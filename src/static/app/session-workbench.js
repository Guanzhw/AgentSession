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

  // ── Conversation Thread / Linear toggle (UI v2 P2a) ──────────────────
  // The server renders the default mode (Thread above 20 normalized messages,
  // Linear otherwise). An explicit user choice overrides the default and is
  // stored under a scoped key; both modes present the same canonical content.
  const conversationView = sessionWorkbench.querySelector("[data-conversation-view]");
  const conversationMessages = sessionWorkbench.querySelector("#session-messages.conversation-thread, #session-messages.conversation-linear");
  if (conversationView && conversationMessages) {
    const CONVERSATION_VIEW_KEY = "agentsession.conversationView";
    const applyConversationMode = (mode) => {
      conversationMessages.classList.toggle("conversation-thread", mode === "thread");
      conversationMessages.classList.toggle("conversation-linear", mode === "linear");
      conversationView.querySelectorAll("[data-conversation-view-mode]").forEach((button) => {
        button.setAttribute("aria-pressed", button.dataset.conversationViewMode === mode ? "true" : "false");
      });
    };

    let storedConversationMode = null;
    try {
      storedConversationMode = localStorage.getItem(CONVERSATION_VIEW_KEY);
    } catch {}
    if (storedConversationMode === "thread" || storedConversationMode === "linear") {
      applyConversationMode(storedConversationMode);
    }

    conversationView.addEventListener("click", (event) => {
      const button = event.target.closest("[data-conversation-view-mode]");
      if (!button) return;
      const mode = button.dataset.conversationViewMode;
      if (mode !== "thread" && mode !== "linear") return;
      applyConversationMode(mode);
      try {
        localStorage.setItem(CONVERSATION_VIEW_KEY, mode);
      } catch {}
    });
  }

  const tocGroups = [...document.querySelectorAll(".session-toc .toc-group")];
  const tocResizeHandle = document.querySelector(".toc-resize-handle");
  let lastManualNav = 0;
  let scrollTicking = false;
  let navLinksCache = [];
  let linkedTargetsCache = [];
  let navigationCacheDirty = true;

  const getNavLinks = () => {
    if (navigationCacheDirty) {
      navLinksCache = [...document.querySelectorAll(".session-toc a[href^='#']")];
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

    const tocControl = event.target.closest("[data-toc-action]");
    if (tocControl) {
      const action = tocControl.getAttribute("data-toc-action");
      tocGroups.forEach((group) => {
        group.open = action === "expand";
      });
      return;
    }

    const link = event.target.closest(".session-toc a[href^='#']");
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
