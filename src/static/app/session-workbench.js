import { readerPaneAnchor } from "./reader-pane-dom.js";
import { ensureReaderAnchor, initReaderProcesses } from "./reader-process.js";
import { initArtifactEvidence } from "./artifact-evidence.js";

const progressiveContentLoads = new WeakMap();

/** Merge a server-rendered continuation into its existing field surface. */
export function mergeProgressiveSurface(surface, incoming, continuation) {
  if (continuation && !(surface?.classList?.contains("tool-output-body") && incoming?.classList?.contains("tool-output-body"))) {
    throw new Error("Progressive Markdown continuation is not a Markdown content surface");
  }
  if (surface?.tagName === "PRE" && incoming?.tagName === "PRE") {
    surface.append(...incoming.childNodes);
  } else if (surface?.classList?.contains("tool-output-body") && incoming?.classList?.contains("tool-output-body")) {
    if (continuation?.kind === "fence") {
      const existingCode = surface.lastElementChild?.matches("pre") && surface.lastElementChild.querySelector("code");
      const nextCode = incoming.firstElementChild?.matches("pre") && incoming.firstElementChild.querySelector("code");
      if (!existingCode || !nextCode) throw new Error("Progressive fence continuation does not match the loaded code block");
      existingCode.append(...nextCode.childNodes);
      incoming.firstElementChild.remove();
    } else if (continuation?.kind === "source") {
      const existingBlock = surface.lastElementChild?.classList?.contains("markdown-source-block") && surface.lastElementChild;
      const nextBlock = incoming.firstElementChild?.classList?.contains("markdown-source-block") && incoming.firstElementChild;
      const existingSource = existingBlock?.querySelector("pre");
      const nextSource = nextBlock?.querySelector("pre");
      if (!existingSource || !nextSource) throw new Error("Progressive source continuation does not match the loaded source block");
      existingSource.append(...nextSource.childNodes);
      nextBlock.remove();
    } else if (continuation?.kind === "paragraph") {
      const existingParagraph = surface.lastElementChild?.matches("p") && surface.lastElementChild;
      const nextParagraph = incoming.firstElementChild?.matches("p") && incoming.firstElementChild;
      if (!existingParagraph || !nextParagraph) throw new Error("Progressive paragraph continuation does not match the loaded paragraph");
      if (continuation.separator) existingParagraph.append(document.createTextNode(continuation.separator));
      existingParagraph.append(...nextParagraph.childNodes);
      nextParagraph.remove();
    } else if (continuation?.kind === "table") {
      const existingBody = surface.lastElementChild?.matches("table") && surface.lastElementChild.querySelector("tbody");
      const nextTable = incoming.firstElementChild?.matches("table") && incoming.firstElementChild;
      const nextBody = nextTable?.querySelector("tbody");
      if (!existingBody || !nextBody) throw new Error("Progressive table continuation does not match the loaded table");
      existingBody.append(...nextBody.childNodes);
      nextTable.remove();
    } else if (continuation?.kind === "list") {
      const lists = (node) => [...node.children].filter((child) => child.tagName === "UL" || child.tagName === "OL");
      let parent = surface;
      let target = lists(surface).at(-1) || null;
      for (let depth = 0; depth < continuation.depth; depth += 1) {
        const item = target?.lastElementChild?.matches("li") && target.lastElementChild;
        if (!item) throw new Error("Progressive list continuation does not match the loaded list depth");
        parent = item;
        target = lists(item).at(-1) || null;
      }
      const additions = lists(incoming);
      if (!additions.length) throw new Error("Progressive list continuation has no list items");
      for (const addition of additions) {
        if (target?.tagName === addition.tagName) {
          target.append(...addition.children);
          addition.remove();
        } else {
          parent.append(addition);
          target = addition;
        }
      }
    }
    surface.append(...incoming.childNodes);
  } else if (surface?.tagName === "DL" && incoming?.tagName === "DL") {
    if (incoming.firstElementChild?.matches("dd") && surface.lastElementChild?.matches("dd")) {
      surface.lastElementChild.append(...incoming.firstElementChild.childNodes);
      incoming.firstElementChild.remove();
    }
    surface.append(...incoming.childNodes);
  } else {
    return false;
  }
  return true;
}

export function loadProgressiveContent(button, { dispatch = true } = {}) {
  if (!button || typeof button !== "object") return Promise.resolve(null);
  if (progressiveContentLoads.has(button)) return progressiveContentLoads.get(button);
  const promise = (async () => {
    const container = button?.closest(".progressive");
    const workbench = button?.closest(".session-workbench");
    if (!button || !container || !workbench || button.disabled) return null;
    const pane = button.closest("[data-reader-pane]");
    const provider = pane?.dataset.readerProvider || workbench.dataset.provider;
    const sessionId = pane?.dataset.readerSession || workbench.dataset.sessionId;
    const partId = button.dataset.partId;
    const field = button.dataset.field;
    const contentScope = button.dataset.contentScope || "owned";
    const contextTarget = button.dataset.contextResultTarget || "";
    const contextCheckpoint = button.dataset.contextResultCheckpoint || "";
    const artifactId = button.dataset.contextArtifactId || "";
    const evidenceRecordId = button.dataset.artifactEvidenceRecordId || "";
    const offset = button.dataset.nextOffset;
    const contextResult = contentScope === "context-result";
    const contextArtifact = contentScope === "context-artifact";
    const artifactEvidence = contentScope === "artifact-evidence";
    if (!provider || !sessionId || !field || offset == null || contextResult && (!contextTarget || !contextCheckpoint) || contextArtifact && !artifactId || artifactEvidence && (!artifactId || !evidenceRecordId) || !contextResult && !contextArtifact && !artifactEvidence && !partId) return null;
    container.querySelector("[data-progressive-status]")?.remove();
    const idleLabel = button.textContent;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    if (button.dataset.loadingLabel) button.textContent = button.dataset.loadingLabel;
    try {
      const query = new URLSearchParams({ field, offset, scope: contentScope });
      if (contextResult) {
        query.set("checkpoint", contextCheckpoint);
        query.set("target", contextTarget);
        query.set("group", button.dataset.contextResultGroup || "-1");
        query.set("entry", button.dataset.contextResultEntry || "-1");
      } else if (contextArtifact || artifactEvidence) {
        query.set("artifact", artifactId);
        if (artifactEvidence) query.set("record", evidenceRecordId);
      } else {
        query.set("part", partId);
      }
      const response = await fetch(`/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}/content?${query}`);
      const data = await response.json();
      if (!button.isConnected || pane && !pane.isConnected) return null;
      if (!response.ok || !data?.ok || typeof data.html !== "string") {
        if (response.status === 409 && data?.code === "artifact_stale") {
          const status = document.createElement("span");
          status.dataset.progressiveStatus = "";
          status.setAttribute("role", "status");
          status.setAttribute("aria-live", "polite");
          status.textContent = button.dataset.staleLabel || data.error;
          container.append(status);
          const refresh = document.createElement("a");
          refresh.href = `/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}`;
          refresh.textContent = button.dataset.refreshLabel || "Refresh";
          status.append(" ", refresh);
          button.remove();
          return null;
        }
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
      const fragment = document.createElement("div");
      fragment.innerHTML = data.html;
      const incoming = fragment.firstElementChild;
      const surface = container.firstElementChild === button ? null : container.firstElementChild;
      if (!mergeProgressiveSurface(surface, incoming, data.continuation) && incoming) {
        if (artifactEvidence) incoming.tabIndex = 0;
        container.insertBefore(incoming, button);
      }
      delete button.dataset.loadInitial;
      if (dispatch && button.dataset.searchRevealPending !== "true") {
        workbench.dispatchEvent(new CustomEvent("session-reader:content-updated", {
          bubbles: true,
          detail: { pane: pane || workbench, provider, session: sessionId, part: partId, field }
        }));
      }
      if (data.nextOffset == null) {
        if ((contextArtifact || artifactEvidence) && Number(data.totalLength) === 0) {
          const status = document.createElement("span");
          status.dataset.progressiveStatus = "";
          status.setAttribute("role", "status");
          status.textContent = button.dataset.emptyLabel || "";
          container.insertBefore(status, button);
        }
        button.remove();
      } else {
        button.dataset.nextOffset = String(data.nextOffset);
        button.textContent = button.dataset.moreLabel || idleLabel;
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
      return { data, button: data.nextOffset == null ? null : button, pane, provider, sessionId };
    } catch (error) {
      if (button.dataset.retryLabel) {
        const status = document.createElement("span");
        status.dataset.progressiveStatus = "";
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        status.textContent = button.dataset.loadError;
        container.append(status);
      }
      button.textContent = button.dataset.retryLabel || idleLabel;
      button.disabled = false;
      button.removeAttribute("aria-busy");
      throw error;
    } finally {
      // A pane swap can detach the button before the response arrives. Reset
      // the captured node so a cached pane can retry its continuation on Back.
      if (button?.disabled || button?.getAttribute("aria-busy") === "true") {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        button.textContent = idleLabel;
      }
    }
  })();
  const tracked = promise.finally(() => progressiveContentLoads.delete(button));
  progressiveContentLoads.set(button, tracked);
  return tracked;
}

export function loadFoldedContent(details) {
  if (!details.open || !details.matches("details.tool-call, details.reasoning-block, details.reader-artifact-output, details.reader-artifact-followup-record")) return Promise.resolve([]);
  const buttons = [...details.querySelectorAll(".progressive-more[data-load-initial]")]
    .filter((button) => button.closest("details") === details);
  // First pages preserve the existing anchors. Do not restart a search that
  // is simultaneously revealing another field in this same disclosure.
  return Promise.allSettled(buttons.map((button) => loadProgressiveContent(button, { dispatch: false })));
}

export function selectVisibleSearchHit(match, visibleHits) {
  if (!match || match.format !== "plain") return null;
  return visibleHits[Number(match.matchIndex) || 0] || null;
}

export function initSessionWorkbench({ ft, formatText, showToast }) {
const sessionWorkbench = document.querySelector(".session-workbench");
if (sessionWorkbench) {
  initArtifactEvidence(sessionWorkbench);
  initReaderProcesses(sessionWorkbench);
  sessionWorkbench.addEventListener("toggle", (event) => {
    void loadFoldedContent(event.target);
  }, true);
  const getReaderPane = () => sessionWorkbench.querySelector("[data-reader-pane]") || sessionWorkbench;
  const readerKey = (pane = getReaderPane()) => `${pane?.dataset.readerProvider || sessionWorkbench.dataset.provider || ""}\u0000${pane?.dataset.readerSession || sessionWorkbench.dataset.sessionId || ""}`;
  const transcriptSearch = sessionWorkbench.querySelector("[data-session-search]");
  const transcriptSearchInput = transcriptSearch?.querySelector("[data-session-search-input]");
  const transcriptSearchStatus = transcriptSearch?.querySelector("[data-session-search-status]");
  const transcriptSearchPrevious = transcriptSearch?.querySelector("[data-session-search-previous]");
  const transcriptSearchNext = transcriptSearch?.querySelector("[data-session-search-next]");
  const transcriptSearchClose = transcriptSearch?.querySelector("[data-session-search-close]");
  let transcriptMatches = [];
  let transcriptMatchIndex = -1;
  let transcriptOccurrenceCount = 0;
  let transcriptSearchTotal = 0;
  let transcriptSearchBaseOffset = 0;
  let transcriptSearchNextOffset = null;
  let transcriptSearchRevision = 0;
  let transcriptSearchTimer = null;
  let transcriptSearchRequest = null;
  let transcriptRevealRevision = 0;
  let transcriptNavigationIntent = 0;
  let transcriptCurrentTarget = null;
  const readerSearchStates = new Map();
  let selectedSearchPane = null;
  const searchScopeSelect = transcriptSearch?.querySelector("[data-session-search-scope]");

  const getSearchPane = () => selectedSearchPane?.isConnected ? selectedSearchPane : getReaderPane();
  const searchScopeValue = (pane) => `${encodeURIComponent(pane?.dataset.readerProvider || sessionWorkbench.dataset.provider || "")}::${encodeURIComponent(pane?.dataset.readerSession || sessionWorkbench.dataset.sessionId || "")}`;
  const mountedSearchPanes = () => [...sessionWorkbench.querySelectorAll("[data-reader-pane]")];
  const refreshSearchScopes = () => {
    if (!searchScopeSelect) return;
    const root = getReaderPane();
    const panes = mountedSearchPanes();
    const activeValue = searchScopeValue(getSearchPane());
    const known = new Set([searchScopeValue(root)]);
    [...searchScopeSelect.options].forEach((option) => {
      if (option.dataset.readerScopeRoot === "true") return;
      const pane = panes.find((candidate) => searchScopeValue(candidate) === option.value);
      if (!pane) option.remove();
      else known.add(option.value);
    });
    panes.forEach((pane) => {
      const value = searchScopeValue(pane);
      if (known.has(value)) return;
      const option = document.createElement("option");
      option.value = value;
      option.dataset.readerProvider = pane.dataset.readerProvider || "";
      option.dataset.readerSession = pane.dataset.readerSession || "";
      const title = pane.dataset.readerTitle || pane.querySelector("[data-reader-pane-title]")?.textContent?.trim() || pane.dataset.readerSession || value;
      option.textContent = `${title} · ${pane.dataset.readerProvider || ""}/${pane.dataset.readerSession || ""}`;
      searchScopeSelect.append(option);
      known.add(value);
    });
    const rootOption = [...searchScopeSelect.options].find((option) => option.dataset.readerScopeRoot === "true");
    if (rootOption) {
      rootOption.value = searchScopeValue(root);
      const title = root.dataset.readerTitle || root.querySelector("[data-reader-pane-title]")?.textContent?.trim() || root.dataset.readerSession || "";
      rootOption.textContent = `${formatText(ft("detail.search_scope_root"), { title })} · ${root.dataset.readerProvider || ""}/${root.dataset.readerSession || ""}`;
    }
    searchScopeSelect.value = activeValue;
    if (searchScopeSelect.value !== activeValue) searchScopeSelect.value = searchScopeValue(root);
  };

  const transcriptSearchSource = document.createElement("div");
  transcriptSearchSource.className = "session-search-source";
  transcriptSearchSource.hidden = true;
  transcriptSearchSource.dataset.sessionSearchSource = "true";
  transcriptSearch?.querySelector(".session-search-panel")?.append(transcriptSearchSource);

  const clearTranscriptHighlights = (targetPane = getSearchPane()) => {
    const parents = new Set();
    targetPane.querySelectorAll("mark[data-session-search-highlight]").forEach((mark) => {
      if (mark.closest("[data-reader-pane]") !== targetPane) return;
      const parent = mark.parentNode;
      parents.add(parent);
      mark.replaceWith(document.createTextNode(mark.textContent || ""));
    });
    parents.forEach((parent) => parent?.normalize());
  };

  const highlightTranscriptMatches = (query) => {
    let occurrences = 0;
    const turns = new Set(transcriptMatches.map((entry) => entry.turn).filter(Boolean));
    turns.forEach((turn) => {
      const nodes = [];
      const walker = document.createTreeWalker(turn, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const parent = node.parentElement;
        if (parent?.closest("[data-reader-pane]") === getSearchPane()
          && parent?.closest(".message-turn") === turn
          && !parent.closest("[data-inherited-context]")
          && !parent.closest("[data-search-exclude]")
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
    const disabled = transcriptMatches.length === 0 && transcriptSearchNextOffset == null;
    if (transcriptSearchPrevious) transcriptSearchPrevious.disabled = transcriptMatches.length === 0 || transcriptSearchBaseOffset === 0 && transcriptMatchIndex <= 0;
    if (transcriptSearchNext) transcriptSearchNext.disabled = disabled;
    if (!transcriptSearchStatus) return;
    if (!transcriptSearchInput?.value.trim()) {
      transcriptSearchStatus.textContent = "";
      return;
    }
    transcriptSearchStatus.textContent = disabled
      ? ft("detail.search_no_results")
      : formatText(ft("detail.search_results"), {
        current: transcriptSearchBaseOffset + transcriptMatchIndex + 1,
        total: transcriptSearchTotal || transcriptMatches.length,
        occurrences: transcriptOccurrenceCount
      });
  };

  const findMatchPart = (match) => {
    const pane = getSearchPane();
    return [...pane.querySelectorAll("[data-part-id]")]
      .filter((element) => element.closest("[data-reader-pane]") === pane)
      .find((element) => element.dataset.partId === match.partId) || null;
  };

  const findMatchProgressive = (match) => {
    const pane = getSearchPane();
    return [...pane.querySelectorAll("[data-progressive-part-id]")].find((element) => (
      element.closest("[data-reader-pane]") === pane
      && element.dataset.progressivePartId === match.partId
      && element.dataset.progressiveField === match.field
      && (element.dataset.contentScope || "owned") === (match.contentScope || "owned")
    )) || null;
  };

  const showSourceExcerpt = (match) => {
    if (!transcriptSearchSource) return;
    transcriptSearchSource.hidden = false;
    transcriptSearchSource.replaceChildren();
    const label = document.createElement("strong");
    label.textContent = `${ft("detail.search_source_excerpt")}: `;
    const excerpt = document.createElement("code");
    excerpt.textContent = match.excerpt || "";
    transcriptSearchSource.append(label, excerpt);
  };

  const revealSearchMatch = async (entry, query, scroll = true, revealRevision = transcriptRevealRevision) => {
    const match = entry.match;
    const pane = getSearchPane();
    const source = findMatchPart(match);
    if (source?.hasAttribute("data-reader-process-anchor")) {
      try {
        await ensureReaderAnchor(pane, source.dataset.readerCanonicalAnchor || source.id);
      } catch (error) {
        if (revealRevision === transcriptRevealRevision && pane === getSearchPane()) {
          transcriptSearchStatus.textContent = ft("detail.search_failed");
        }
        return;
      }
      if (revealRevision !== transcriptRevealRevision || pane !== getSearchPane() || !pane.isConnected) return;
    }
    const part = findMatchPart(match);
    entry.turn = part?.closest(".message-turn") || entry.turn;
    const target = part || entry.turn;
    if (!target) return;
    revealAncestorDetails(target);
    const progressive = findMatchProgressive(match);
    if (progressive) {
      let button = progressive.querySelector(`.progressive-more[data-field="${match.field}"]`);
      if (button && match.offset + (match.matchLength || query.length || 1) > Number(button.dataset.nextOffset)) {
        try {
          while (button && Number(button.dataset.nextOffset) < match.offset + (match.matchLength || query.length || 1)) {
            button.dataset.searchRevealPending = "true";
            let loaded;
            try {
              loaded = await loadProgressiveContent(button, { dispatch: false });
            } finally {
              delete button.dataset.searchRevealPending;
            }
            if (revealRevision !== transcriptRevealRevision || pane !== getSearchPane()) return;
            button = loaded?.button || null;
          }
        } catch (error) {
          console.error("Unable to reveal search match:", error);
          if (transcriptSearchStatus) transcriptSearchStatus.textContent = ft("detail.search_failed");
          return;
        }
      }
    }
    if (revealRevision !== transcriptRevealRevision || pane !== getSearchPane()) return;
    showSourceExcerpt(match);
    clearTranscriptHighlights();
    transcriptOccurrenceCount = highlightTranscriptMatches(query);
    transcriptCurrentTarget?.classList.remove("session-search-current");
    transcriptCurrentTarget = target;
    target.classList.add("session-search-current");
    const fieldRoot = progressive || [...target.querySelectorAll("[data-content-field]")]
      .find((element) => element.dataset.contentField === match.field) || target;
    const visibleHits = [...fieldRoot.querySelectorAll("mark[data-session-search-highlight]")];
    // Markdown/auto-rendered source can hide syntax (for example a link
    // destination), so a server source occurrence is not an ordinal promise
    // in the rendered DOM. Plain fields retain exact occurrence identity.
    const visibleHit = selectVisibleSearchHit(match, visibleHits);
    const focusTarget = visibleHit || target;
    if (scroll) {
      if (visibleHit) {
        visibleHit.tabIndex = -1;
        visibleHit.focus({ preventScroll: true });
      }
      focusTarget.scrollIntoView({ block: "center", behavior: "auto" });
    }
    updateTranscriptSearchControls();
  };

  const revealAncestorDetails = (target) => {
    let detail = target?.closest("details");
    while (detail) {
      detail.open = true;
      detail = detail.parentElement?.closest("details") || null;
    }
  };

  const selectTranscriptMatch = (index, scroll = true) => {
    if (!transcriptMatches.length) return;
    const navigationIntent = ++transcriptNavigationIntent;
    transcriptSearchRequest?.abort();
    if (index >= transcriptMatches.length && transcriptSearchNextOffset != null) {
      void loadTranscriptSearchPage(transcriptSearchNextOffset, true, navigationIntent).then((loaded) => {
        if (loaded && navigationIntent === transcriptNavigationIntent) selectTranscriptMatch(index, scroll);
      });
      return;
    }
    if (index < 0 && transcriptSearchBaseOffset > 0) {
      const targetOffset = transcriptSearchBaseOffset - 1;
      void loadTranscriptSearchPage(targetOffset, false, navigationIntent).then((loaded) => {
        if (loaded && navigationIntent === transcriptNavigationIntent) selectTranscriptMatch(0, scroll);
      });
      return;
    }
    transcriptMatchIndex = (index + transcriptMatches.length) % transcriptMatches.length;
    transcriptCurrentTarget?.classList.remove("session-search-current");
    transcriptCurrentTarget = null;
    transcriptMatches.forEach((entry) => entry.turn?.classList.remove("session-search-current"));
    const current = transcriptMatches[transcriptMatchIndex];
    readerSearchStates.set(readerKey(getSearchPane()), {
      query: transcriptSearchInput?.value.trim() || "",
      index: transcriptMatchIndex,
      offset: transcriptSearchBaseOffset + transcriptMatchIndex
    });
    void revealSearchMatch(current, transcriptSearchInput?.value.trim().toLocaleLowerCase() || "", scroll, ++transcriptRevealRevision);
    if (!scroll) updateTranscriptSearchControls();
    return current;
  };

  async function loadTranscriptSearchPage(offset, append = false, navigationIntent = null) {
    const pane = getSearchPane();
    const provider = pane.dataset.readerProvider || sessionWorkbench.dataset.provider;
    const sessionId = pane.dataset.readerSession || sessionWorkbench.dataset.sessionId;
    const query = transcriptSearchInput?.value.trim() || "";
    const revision = transcriptSearchRevision;
    const controller = new AbortController();
    transcriptSearchRequest?.abort();
    transcriptSearchRequest = controller;
    try {
      const params = new URLSearchParams({ q: query, offset: String(offset), limit: "50" });
      const response = await fetch(`/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}/search?${params}`, { signal: controller.signal });
      const data = await response.json();
      if (!response.ok || !data?.ok || !Array.isArray(data.matches)) throw new Error(data?.error || `HTTP ${response.status}`);
      if (revision !== transcriptSearchRevision || pane !== getSearchPane() || navigationIntent != null && navigationIntent !== transcriptNavigationIntent) return null;
      const newMatches = data.matches.map((match) => ({ match, turn: findMatchPart(match)?.closest(".message-turn") || null }));
      transcriptMatches = append ? transcriptMatches.concat(newMatches) : newMatches;
      if (!append) transcriptSearchBaseOffset = Number(data.offset) || 0;
      transcriptSearchTotal = Number(data.total) || 0;
      transcriptSearchNextOffset = data.nextOffset == null ? null : Number(data.nextOffset);
      transcriptOccurrenceCount = highlightTranscriptMatches(query.toLocaleLowerCase());
      updateTranscriptSearchControls();
      return data;
    } catch (error) {
      if (error?.name === "AbortError") return null;
      if (revision === transcriptSearchRevision && transcriptSearchStatus) transcriptSearchStatus.textContent = ft("detail.search_failed");
      return null;
    } finally {
      if (transcriptSearchRequest === controller) transcriptSearchRequest = null;
    }
  }

  const updateTranscriptMatches = async (scroll = false, preferredIndex = null, preferredOffset = 0) => {
    const revision = ++transcriptSearchRevision;
    transcriptNavigationIntent += 1;
    transcriptRevealRevision += 1;
    const query = transcriptSearchInput?.value.trim().toLocaleLowerCase() || "";
    transcriptSearchRequest?.abort();
    transcriptMatches.forEach((entry) => entry.turn?.classList.remove("session-search-match", "session-search-current"));
    clearTranscriptHighlights();
    transcriptCurrentTarget?.classList.remove("session-search-current");
    transcriptCurrentTarget = null;
    transcriptMatches = [];
    transcriptMatchIndex = -1;
    transcriptOccurrenceCount = 0;
    transcriptSearchTotal = 0;
    transcriptSearchBaseOffset = 0;
    transcriptSearchNextOffset = null;
    if (transcriptSearchSource) transcriptSearchSource.hidden = true;
    if (query) {
      if (transcriptSearchStatus) transcriptSearchStatus.textContent = ft("detail.search_loading");
      const data = await loadTranscriptSearchPage(preferredOffset || 0, false);
      if (revision !== transcriptSearchRevision || !data) return;
      transcriptMatches.forEach((entry) => entry.turn?.classList.add("session-search-match"));
      if (transcriptMatches.length) {
        const selectedIndex = preferredOffset > 0 ? 0 : (preferredIndex == null || preferredIndex < 0 ? 0 : preferredIndex);
        selectTranscriptMatch(Math.min(selectedIndex, transcriptMatches.length - 1), scroll);
      }
      return;
    }
    updateTranscriptSearchControls();
  };

  const saveSearchState = (pane = getSearchPane()) => {
    if (!pane) return;
    readerSearchStates.set(readerKey(pane), {
      query: transcriptSearchInput?.value.trim() || "",
      index: transcriptMatchIndex,
      offset: transcriptSearchBaseOffset + Math.max(0, transcriptMatchIndex)
    });
  };

  const selectSearchPane = (pane) => {
    const next = pane || getReaderPane();
    const previous = selectedSearchPane || getReaderPane();
    if (previous === next && selectedSearchPane === next) return;
    saveSearchState(previous);
    window.clearTimeout(transcriptSearchTimer);
    transcriptSearchTimer = null;
    transcriptSearchRequest?.abort();
    transcriptNavigationIntent += 1;
    transcriptRevealRevision += 1;
    transcriptSearchRevision += 1;
    transcriptMatches.forEach((entry) => entry.turn?.classList.remove("session-search-match", "session-search-current"));
    clearTranscriptHighlights(previous);
    transcriptCurrentTarget?.classList.remove("session-search-current");
    transcriptCurrentTarget = null;
    selectedSearchPane = next;
    refreshSearchScopes();
    const state = readerSearchStates.get(readerKey(next));
    if (transcriptSearchInput) transcriptSearchInput.value = state?.query || "";
    void updateTranscriptMatches(false, state?.index ?? 0, state?.offset ?? 0);
  };

  searchScopeSelect?.addEventListener("change", () => {
    const option = searchScopeSelect.selectedOptions[0];
    const panes = mountedSearchPanes();
    const pane = panes.find((candidate) => searchScopeValue(candidate) === option?.value) || getReaderPane();
    selectSearchPane(pane);
  });
  refreshSearchScopes();

  sessionWorkbench.addEventListener("session-reader:before-swap", (event) => {
    window.clearTimeout(transcriptSearchTimer);
    transcriptSearchTimer = null;
    saveSearchState(getSearchPane());
  });
  sessionWorkbench.addEventListener("session-reader:swapped", (event) => {
    selectedSearchPane = event.detail?.pane || getReaderPane();
    refreshSearchScopes();
    transcriptSearchRequest?.abort();
    transcriptNavigationIntent += 1;
    transcriptRevealRevision += 1;
    transcriptSearchRevision += 1;
    transcriptMatches.forEach((entry) => entry.turn?.classList.remove("session-search-match", "session-search-current"));
    transcriptMatches = [];
    transcriptMatchIndex = -1;
    transcriptOccurrenceCount = 0;
    transcriptSearchTotal = 0;
    transcriptSearchBaseOffset = 0;
    transcriptSearchNextOffset = null;
    clearTranscriptHighlights();
    transcriptCurrentTarget?.classList.remove("session-search-current");
    transcriptCurrentTarget = null;
    if (transcriptSearchSource) transcriptSearchSource.hidden = true;
    const state = readerSearchStates.get(event.detail?.key || readerKey(event.detail?.pane));
    if (transcriptSearchInput) transcriptSearchInput.value = state?.query || "";
    if (transcriptSearchInput?.value.trim()) {
      void updateTranscriptMatches(false, state?.index ?? 0, state?.offset ?? 0);
    } else {
      updateTranscriptSearchControls();
    }
  });
  sessionWorkbench.addEventListener("session-reader:content-updated", (event) => {
    if (event.detail?.pane) invalidateNavigationCache(event.detail.pane);
    if (event.detail?.pane && event.detail.pane !== getSearchPane()) return;
    const state = readerSearchStates.get(readerKey(getSearchPane()));
    transcriptSearchRequest?.abort();
    transcriptNavigationIntent += 1;
    transcriptRevealRevision += 1;
    transcriptSearchRevision += 1;
    transcriptMatches.forEach((entry) => entry.turn?.classList.remove("session-search-match", "session-search-current"));
    transcriptMatches = [];
    transcriptMatchIndex = -1;
    transcriptOccurrenceCount = 0;
    transcriptSearchTotal = 0;
    transcriptSearchBaseOffset = 0;
    transcriptSearchNextOffset = null;
    clearTranscriptHighlights();
    transcriptCurrentTarget?.classList.remove("session-search-current");
    transcriptCurrentTarget = null;
    if (transcriptSearchInput?.value.trim()) void updateTranscriptMatches(false, state?.index ?? 0, state?.offset ?? 0);
    else updateTranscriptSearchControls();
  });
  sessionWorkbench.addEventListener("session-reader:process-loaded", (event) => {
    invalidateNavigationCache(event.detail.pane);
  });
  sessionWorkbench.addEventListener("session-reader:inline-opened", (event) => {
    refreshSearchScopes();
  });
  sessionWorkbench.addEventListener("session-reader:inline-closed", (event) => {
    const closedPane = event.detail?.pane;
    const selectedClosed = selectedSearchPane && closedPane && (closedPane === selectedSearchPane || closedPane.contains?.(selectedSearchPane));
    if (selectedClosed) {
      saveSearchState(selectedSearchPane);
      clearTranscriptHighlights(selectedSearchPane);
    }
    refreshSearchScopes();
    if (selectedClosed) {
      selectSearchPane(getReaderPane());
    }
  });

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
      const target = findMatchPart(current.match) || current.turn;
      if (!target) return;
      const hadTabIndex = target.hasAttribute("tabindex");
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
      if (!hadTabIndex) {
        target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
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
  });

  // ── Conversation disclosures and inspector (UI v2 P2b) ───────────────────
  // Native <details> stays keyboard reachable; the sync below only reflects
  // the expanded state into aria-expanded on the summary and an is-open class
  // for styling, and keeps focus on the summary when the details toggles.
  const disclosures = sessionWorkbench.querySelectorAll("details[data-disclosure]");
  const syncDisclosure = (details) => {
    const summary = details.querySelector(":scope > summary");
    if (summary) {
      summary.setAttribute("aria-expanded", details.open ? "true" : "false");
    }
    details.classList.toggle("is-open", details.open);
  };
  disclosures.forEach(syncDisclosure);
  sessionWorkbench.addEventListener("toggle", (event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !details.matches("details[data-disclosure]")) return;
    syncDisclosure(details);
    details.querySelector(":scope > summary")?.focus({ preventScroll: true });
  }, true);

  // Inspector Work-tab links ("View all in Work / Coordination" and asset
  // run-evidence links) activate the Work tab from Conversation, then bounce
  // to the matching runtime evidence trigger when one exists.
  sessionWorkbench.addEventListener("click", (event) => {
    const evidenceLink = event.target.closest("[data-inspector-evidence-kind]");
    const moreLink = event.target.closest("[data-relationships-more]");
    if (!evidenceLink && !moreLink) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const pane = (evidenceLink || moreLink).closest("[data-reader-pane]");
    const paneProvider = pane?.dataset.readerProvider || "";
    const paneSession = pane?.dataset.readerSession || "";
    const rootProvider = sessionWorkbench.dataset.provider || "";
    const rootSession = sessionWorkbench.dataset.sessionId || "";
    const childOwned = Boolean(pane && paneProvider && paneSession
      && (paneProvider !== rootProvider || paneSession !== rootSession));
    if (childOwned) {
      // Child-owned evidence belongs to that canonical child route. The
      // reader controller has already normalized the href for modified/native
      // activation; preserve the same route for an ordinary click.
      const href = (evidenceLink || moreLink).getAttribute("href");
      if (href && !href.startsWith("#")) {
        event.preventDefault();
        location.assign(href);
      }
      return;
    }
    event.preventDefault();
    const workTab = document.getElementById("tab-work");
    if (workTab instanceof HTMLDetailsElement) {
      workTab.open = true;
      requestAnimationFrame(() => workTab.scrollIntoView({ block: "start", behavior: "instant" }));
    } else {
      document.querySelector("[data-runtime-root]")?.scrollIntoView({ block: "start", behavior: "instant" });
    }
    if (!evidenceLink) return;
    const kind = evidenceLink.getAttribute("data-inspector-evidence-kind");
    const id = evidenceLink.getAttribute("data-inspector-evidence-id");
    requestAnimationFrame(() => {
      const trigger = document.querySelector(`[data-runtime-evidence-kind="${CSS.escape(kind)}"][data-runtime-evidence-id="${CSS.escape(id)}"]`);
      trigger?.click();
    });
  });

  const getTocGroups = (pane = getReaderPane()) => [...pane.querySelectorAll(".session-toc .toc-group")]
    .filter((group) => group.closest("[data-reader-pane]") === pane);
  const tocResizeHandle = sessionWorkbench.querySelector(".toc-resize-handle");
  const mountedPanes = new Set([...sessionWorkbench.querySelectorAll("[data-reader-pane]")]
    .filter((pane) => pane.closest("[data-reader-pane]") === pane));
  const navigationStates = new WeakMap();
  const manualNavigationAt = new WeakMap();
  let scrollTicking = false;
  const navigationStateFor = (pane) => {
    if (!pane) return { links: [], targets: [] };
    let state = navigationStates.get(pane);
    if (!state || state.dirty) {
      const links = [...pane.querySelectorAll(".session-toc a[href^='#']")]
        .filter((link) => link.closest("[data-reader-pane]") === pane);
      // Resolve every target from one owned-element pass. Calling
      // readerPaneAnchor for every ToC link turns a long Reader into
      // links × pane-DOM selector work before its first scroll.
      const anchors = new Map();
      const candidates = [pane, ...pane.querySelectorAll("[id], [data-reader-canonical-anchor]")];
      for (const candidate of candidates) {
        if (candidate.closest?.("[data-reader-pane]") !== pane) continue;
        if (candidate.id) anchors.set(candidate.id, candidate);
        if (candidate.dataset.readerCanonicalAnchor) anchors.set(candidate.dataset.readerCanonicalAnchor, candidate);
      }
      const targetForLink = (link) => {
        const href = link.getAttribute("href") || "";
        if (!href.startsWith("#")) return null;
        try { return anchors.get(decodeURIComponent(href.slice(1))) || null; } catch { return null; }
      };
      state = { links, targets: [...new Set(links.map(targetForLink).filter(Boolean))], dirty: false };
      navigationStates.set(pane, state);
    }
    return state;
  };

  const getNavLinks = (pane = getReaderPane()) => navigationStateFor(pane).links;
  const getLinkedTargets = (pane = getReaderPane()) => navigationStateFor(pane).targets;
  const invalidateNavigationCache = (pane = null) => {
    if (pane) {
      const state = navigationStates.get(pane);
      if (state) state.dirty = true;
      return;
    }
    mountedPanes.forEach((mountedPane) => {
      const state = navigationStates.get(mountedPane);
      if (state) state.dirty = true;
    });
  };
  const setMountedPane = (pane, mounted) => {
    if (!pane) return;
    if (mounted) mountedPanes.add(pane);
    else {
      mountedPanes.delete(pane);
      navigationStates.delete(pane);
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

  const updateTocActivePath = (id, pane = getReaderPane()) => {
    const activeTocLink = [...pane.querySelectorAll(".session-toc .toc-link")]
      .filter((link) => link.closest("[data-reader-pane]") === pane)
      .find((link) => decodeURIComponent((link.getAttribute("href") || "").slice(1)) === id);
    pane.querySelectorAll(".session-toc .toc-link.active-parent").forEach((link) => {
      if (link.closest("[data-reader-pane]") === pane) {
        link.classList.remove("active-parent");
      }
    });
    if (!activeTocLink) return;

    let group = activeTocLink.closest(".toc-group");
    while (group) {
      const parentLink = [...group.querySelectorAll(":scope > .toc-group-summary > .toc-link")]
        .find((link) => link.closest("[data-reader-pane]") === pane);
      if (parentLink && parentLink !== activeTocLink) {
        parentLink.classList.add("active-parent");
        group.open = true;
      }
      group = group.parentElement?.closest(".toc-group");
    }
  };

  const setActiveTarget = (id, pane = getReaderPane()) => {
    const links = getNavLinks(pane);
    links.forEach((link) => {
      link.classList.toggle("active", decodeURIComponent((link.getAttribute("href") || "").slice(1)) === id);
    });
    updateTocActivePath(id, pane);
  };

  sessionWorkbench.addEventListener("session-reader:anchor-revealed", (event) => {
    const pane = event.detail?.pane;
    const target = event.detail?.target;
    if (pane && target?.id) setActiveTarget(target.id, pane);
  });

  const cssPixelValue = (name, fallback) => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const updateActiveFromScroll = () => {
    scrollTicking = false;
    const topbarHeight = cssPixelValue("--topbar-height", 48);
    const anchorOffset = cssPixelValue("--session-anchor-offset", 80);
    const now = Date.now();
    for (const pane of mountedPanes) {
      if (!pane.isConnected) {
        setMountedPane(pane, false);
        continue;
      }
      if (now - (manualNavigationAt.get(pane) || 0) < 1200) continue;
      let best = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      getLinkedTargets(pane).forEach((target) => {
        const rect = target.getBoundingClientRect();
        if (rect.bottom < topbarHeight || rect.top > window.innerHeight) return;
        const distance = Math.abs(rect.top - anchorOffset);
        if (distance < bestDistance) {
          best = target;
          bestDistance = distance;
        }
      });
      if (best?.id) setActiveTarget(best.id, pane);
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
      const pane = tocControl.closest("[data-reader-pane]") || getReaderPane();
      getTocGroups(pane).forEach((group) => {
        group.open = action === "expand";
      });
      return;
    }

    const link = event.target.closest(".session-toc a[href^='#']");
    if (!link) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const pane = link.closest("[data-reader-pane]") || getReaderPane();
    event.preventDefault();
    let target;
    try {
      target = await ensureReaderAnchor(pane, decodeURIComponent(link.getAttribute("href").slice(1)));
    } catch {
      showToast(ft("detail.reader_event_failed"), "error");
      return;
    }
    if (!target || !pane.isConnected) return;
    manualNavigationAt.set(pane, Date.now());
    history.pushState(null, "", link.getAttribute("href"));
    revealAncestorDetails(target);
    target.scrollIntoView({ block: "start", behavior: "auto" });
    target.classList.add("anchor-flash");
    setActiveTarget(target.id, pane);
    setTimeout(() => target.classList.remove("anchor-flash"), 900);
  });

  window.addEventListener("scroll", () => {
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(updateActiveFromScroll);
  }, { passive: true });

  // Canonical hash navigation is replayed by the reader controller, which
  // materializes folded process anchors before scrolling or taking focus.
  updateActiveFromScroll();

  sessionWorkbench.addEventListener("session-reader:inline-opened", (event) => {
    const pane = event.detail?.pane;
    if (!pane) return;
    setMountedPane(pane, true);
    invalidateNavigationCache(pane);
  });
  sessionWorkbench.addEventListener("session-reader:inline-closed", (event) => {
    const pane = event.detail?.pane;
    if (!pane) return;
    setMountedPane(pane, false);
    invalidateNavigationCache();
  });
  sessionWorkbench.addEventListener("session-reader:swapped", () => {
    mountedPanes.clear();
    setMountedPane(getReaderPane(), true);
    invalidateNavigationCache();
    const hash = location.hash ? location.hash.slice(1) : "";
    const pane = getReaderPane();
    const target = hash ? readerPaneAnchor(pane, decodeURIComponent(hash)) : null;
    if (target) {
      revealAncestorDetails(target);
      setActiveTarget(target.id, pane);
      requestAnimationFrame(() => target.scrollIntoView({ block: "start", behavior: "auto" }));
    } else {
      updateActiveFromScroll();
    }
  });
}


}
