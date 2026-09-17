import { readerPaneAnchor, scopeReaderPane, unscopeReaderPane } from "./reader-pane-dom.js";
import { createReaderLocation, parseReaderLocation, stripReaderLocation } from "./reader-location.js";
import { ensureReaderAnchor } from "./reader-process.js";

/* Unified session reader navigation.
 *
 * The server owns the document and its actions. Related panes stay inline;
 * canonical standalone links load a new document when its owner changes.
 */
export function initSessionReader({ ft, showToast } = {}) {
  const workbench = document.querySelector(".session-workbench[data-session-reader]")
    || document.querySelector(".session-workbench[data-reader-host]");
  if (!workbench) return null;

  const host = workbench.querySelector("[data-reader-host]");
  if (!host) return null;

  const backButton = workbench.querySelector("[data-reader-back]");
  const currentTitle = workbench.querySelector("[data-reader-current-title]");
  const status = workbench.querySelector("[data-reader-status]");
  const cache = new Map();
  const historyEntries = [];
  let historyIndex = -1;
  let swapRevision = 0;
  let eventSourceIntent = 0;
  const inlinePanes = new Map();
  let inlineRevision = 0;
  let inlineRootState = null;
  let inlineRootIdentity = null;
  let nextOriginId = 0;

  const providerOf = (pane) => pane?.dataset.readerProvider || workbench.dataset.provider || "";
  const sessionOf = (pane) => pane?.dataset.readerSession || workbench.dataset.sessionId || "";
  const canonicalKey = (provider, session) => `${String(provider)}\u0000${String(session)}`;
  const keyOf = (pane) => canonicalKey(providerOf(pane), sessionOf(pane));
  const paneFor = (key) => cache.get(key)?.pane || null;
  const activePane = () => host.querySelector("[data-reader-pane]");
  const inlineStackFrom = (state) => Array.isArray(state?.readerInline) ? state.readerInline : [];
  const inlineHref = () => location.pathname + location.search + location.hash;
  const sourceUrlFor = (link) => {
    const rawHref = link.getAttribute?.("href") || link.href || location.href;
    const url = new URL(link.href || rawHref || location.href, location.href);
    if (String(rawHref).startsWith("#")) {
      const owner = link.closest("[data-reader-pane]");
      const provider = link.dataset.readerProvider || providerOf(owner);
      const session = link.dataset.readerSession || sessionOf(owner);
      if (provider && session) url.pathname = `/${encodeURIComponent(provider)}/session/${encodeURIComponent(session)}`;
    }
    return stripReaderLocation(url);
  };
  const eventSourceUrlFor = (link) => {
    const url = sourceUrlFor(link);
    const current = new URL(location.href);
    for (const [name, value] of current.searchParams) {
      if (!["readerEvent", "readerSource", "readerAncestor"].includes(name) && !url.searchParams.has(name)) url.searchParams.append(name, value);
    }
    return url;
  };
  const paneStateForHistory = (state) => state && {
    scrollX: state.scrollX,
    scrollY: state.scrollY,
    focus: state.focus && { id: state.focus.id, anchor: state.focus.anchor }
  };
  const serializedInlineRoot = () => inlineRootIdentity && ({
    provider: inlineRootIdentity.provider,
    session: inlineRootIdentity.session,
    href: inlineRootIdentity.href,
    state: paneStateForHistory(inlineRootState)
  });
  const withInlineHistory = (baseState, stack) => {
    const next = { ...baseState };
    if (stack.length) {
      next.readerInline = stack;
      if (inlineRootIdentity) next.readerInlineRoot = serializedInlineRoot();
    } else {
      delete next.readerInline;
      delete next.readerInlineRoot;
    }
    return next;
  };

  const setStatus = (message = "", kind = "", href = "") => {
    if (!status) return;
    status.replaceChildren();
    if (message) {
      const label = document.createElement("span");
      label.textContent = message;
      status.append(label);
    }
    if (href) {
      const link = document.createElement("a");
      link.href = href;
      link.textContent = href;
      link.className = "reader-status-link";
      status.append(link);
    }
    status.dataset.readerStatus = kind;
    status.hidden = !message && !href;
  };

  const findFocusable = (pane, saved) => {
    if (!pane || !saved) return null;
    if (saved.element && pane.contains(saved.element)) return saved.element;
    if (saved.id) {
      const byId = pane.querySelector(`#${CSS.escape(saved.id)}`);
      if (byId) return byId;
    }
    if (saved.anchor) {
      const byAnchor = pane.querySelector(`[data-reader-focus="${CSS.escape(saved.anchor)}"]`);
      if (byAnchor) return byAnchor;
    }
    return null;
  };

  const focusIdentity = (element, pane) => {
    if (!(element instanceof HTMLElement) || !pane?.contains(element)) return null;
    return {
      id: element.id || "",
      anchor: element.dataset.readerFocus || "",
      element
    };
  };

  const savePaneState = (pane, { captureHref = true } = {}) => {
    if (!pane) return;
    const existing = cache.get(keyOf(pane)) || { pane };
    const entry = historyEntries[historyIndex];
    if (captureHref) entry.href = location.pathname + location.search + location.hash;
    existing.href = entry.href;
    existing.state = {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      focus: focusIdentity(document.activeElement, pane)
    };
    entry.state = existing.state;
    cache.set(keyOf(pane), existing);
    if (captureHref) history.replaceState({ ...history.state, readerPosition: paneStateForHistory(existing.state) }, "", entry.href);
  };

  const restorePaneState = (pane, savedState = null) => {
    const entry = historyEntries[historyIndex];
    const state = savedState || entry?.state;
    if (!state) {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      return;
    }
    requestAnimationFrame(() => {
      if (historyEntries[historyIndex] !== entry || host.querySelector("[data-reader-pane]") !== pane) return;
      window.scrollTo({ top: state.scrollY || 0, left: state.scrollX || 0, behavior: "auto" });
      const focusTarget = findFocusable(pane, state.focus);
      focusTarget?.focus?.({ preventScroll: true });
    });
  };

  const updateShell = (pane) => {
    const title = pane?.dataset.readerTitle || pane?.querySelector("[data-reader-pane-title]")?.textContent?.trim() || "";
    if (currentTitle) {
      if (title) currentTitle.textContent = title;
      // The document header belongs to the canonical page owner. Inline and
      // child panes identify themselves in this secondary shell label without
      // rewriting that owner title.
      const documentRootKey = canonicalKey(workbench.dataset.provider || "", workbench.dataset.sessionId || "");
      currentTitle.hidden = keyOf(pane) === documentRootKey;
    }
    workbench.dataset.readerCurrentProvider = providerOf(pane);
    workbench.dataset.readerCurrentSession = sessionOf(pane);
    if (backButton) {
      const canBack = historyIndex > 0 || inlinePanes.size > 0;
      backButton.disabled = !canBack;
      backButton.hidden = !canBack;
      backButton.setAttribute("aria-disabled", canBack ? "false" : "true");
    }
  };

  const dispatch = (name, detail) => workbench.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));

  const fetchPane = async (provider, session, href = "") => {
    const key = canonicalKey(provider, session);
    const existing = paneFor(key);
    if (existing) return existing;
    const endpoint = `/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(session)}/reader`;
    const response = await fetch(endpoint, { headers: { Accept: "application/json" } });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok || typeof data.html !== "string") {
      throw new Error(data?.error || `HTTP ${response.status}`);
    }
    // Another click may finish loading this same owner while the request waits.
    const loaded = paneFor(key);
    if (loaded) return loaded;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = data.html;
    const pane = wrapper.querySelector("[data-reader-pane]");
    if (!pane) throw new Error("Reader response did not contain a pane");
    pane.dataset.readerProvider = provider;
    pane.dataset.readerSession = session;
    if (data.title && !pane.dataset.readerTitle) pane.dataset.readerTitle = data.title;
    normalizeOwnedEvidenceLinks(pane, provider, session);
    cache.set(key, { pane, state: null, href });
    return pane;
  };

  const serializedInlineStack = () => [...inlinePanes.values()].map((record) => ({
    provider: record.provider,
    session: record.session,
    href: record.href,
    originHref: record.originHref,
    originAnchor: record.originAnchor || "",
    originReturnAnchor: record.originReturnAnchor || "",
    originState: paneStateForHistory(record.originState)
  }));

  const readerTranscriptEnd = (pane) => {
    const transcript = pane?.querySelector("[data-reader-transcript]");
    const conversationLayout = transcript?.querySelector("[data-conversation-layout]");
    return conversationLayout?.lastElementChild || conversationLayout || transcript?.lastElementChild || transcript || pane?.lastElementChild || pane;
  };

  const inlineOriginFor = (link) => {
    const pane = link.closest("[data-reader-pane]");
    const branchBody = link.closest(".reader-branch-body");
    if ((branchBody || link.closest(".session-toc")) && pane) {
      const provider = link.dataset.readerProvider || "";
      const session = link.dataset.readerSession || "";
      const milestone = [...pane.querySelectorAll("[data-reader-milestone]")]
        .filter((candidate) => candidate.closest("[data-reader-pane]") === pane)
        .find((candidate) => [...candidate.querySelectorAll("[data-reader-open]")]
        .some((candidateLink) => candidateLink.dataset.readerProvider === provider && candidateLink.dataset.readerSession === session));
      return milestone || readerTranscriptEnd(pane);
    }
    return link.closest("[data-reader-milestone], .reader-milestone, .reader-branch-body, .reader-branch, [data-reader-child-disclosure], .reader-child-disclosure-body, p")
      || link.parentElement || pane;
  };

  const inlineReturnOriginFor = (link) => link.closest(".reader-branch-body")?.querySelector("[data-reader-open]") || link;

  const recordedOpener = (pane, provider, session) => [...pane.querySelectorAll("[data-reader-open]")]
    .find((link) => link.closest("[data-reader-pane]") === pane
      && link.dataset.readerProvider === provider && link.dataset.readerSession === session);

  const inlineSourceHref = (sourceUrl, key) => {
    const records = [...inlinePanes.values()];
    const index = records.findIndex((record) => record.key === key);
    const ancestors = records.slice(0, index).map((record) => `/${encodeURIComponent(record.provider)}/session/${encodeURIComponent(record.session)}`);
    return createReaderLocation(location.href, sourceUrl.href, ancestors);
  };

  const preserveCanonicalSourceLinks = (pane) => {
    pane.querySelectorAll("[data-reader-source], .session-toc a[href^='#']").forEach((link) => {
      if (link.closest("[data-reader-pane]") !== pane) return;
      const canonicalHref = link.dataset.readerCanonicalHref || link.getAttribute("href") || "";
      if (!canonicalHref.startsWith("#")) return;
      const anchor = decodeURIComponent(canonicalHref.slice(1));
      link.dataset.readerSource = "true";
      link.dataset.readerAnchor = anchor;
      link.dataset.readerProvider = providerOf(pane);
      link.dataset.readerSession = sessionOf(pane);
      link.setAttribute("href", `/${encodeURIComponent(providerOf(pane))}/session/${encodeURIComponent(sessionOf(pane))}#${encodeURIComponent(anchor)}`);
    });
  };

  const closeReaderCollaboration = (link) => {
    const overview = link?.closest?.("[data-reader-collaboration-overview]");
    if (!overview) return;
    overview.open = false;
  };

  const originIdentity = (origin) => {
    if (!origin?.dataset) return "";
    const canonicalAnchor = origin.dataset.readerCanonicalAnchor || origin.id;
    if (canonicalAnchor) return `anchor:${canonicalAnchor}`;
    const branch = origin.closest?.(".reader-branch");
    const branchProvider = branch?.dataset.readerBranchProvider || "";
    const branchSession = branch?.dataset.readerBranchSession || "";
    if (branchProvider && branchSession) {
      return `branch:${encodeURIComponent(branchProvider)}:${encodeURIComponent(branchSession)}`;
    }
    if (!origin.dataset.readerInlineOrigin) origin.dataset.readerInlineOrigin = `origin-${++nextOriginId}`;
    return origin.dataset.readerInlineOrigin;
  };

  const originElementFor = (pane, identity) => {
    if (!pane || !identity) return null;
    if (identity.startsWith("anchor:")) return readerPaneAnchor(pane, identity.slice("anchor:".length));
    if (identity.startsWith("branch:")) {
      const encoded = identity.slice("branch:".length);
      const separator = encoded.indexOf(":");
      if (separator < 0) return null;
      const provider = decodeURIComponent(encoded.slice(0, separator));
      const session = decodeURIComponent(encoded.slice(separator + 1));
      const branch = [...pane.querySelectorAll(".reader-branch")]
        .filter((element) => element.closest?.("[data-reader-pane]") === pane)
        .find((element) => element.dataset.readerBranchProvider === provider && element.dataset.readerBranchSession === session);
      return branch ? [...branch.querySelectorAll("[data-reader-open]")]
        .find((element) => element.dataset.readerProvider === provider && element.dataset.readerSession === session) || null : null;
    }
    return [...pane.querySelectorAll("[data-reader-inline-origin]")]
      .filter((element) => element.closest?.("[data-reader-pane]") === pane)
      .find((element) => element.dataset.readerInlineOrigin === identity) || null;
  };

  const removeInlinePane = (key, { restore = false } = {}) => {
    const record = inlinePanes.get(key);
    if (!record) return;
    record.wrapper?.remove?.();
    unscopeReaderPane(record.pane);
    inlinePanes.delete(key);
    dispatch("session-reader:inline-closed", { provider: record.provider, session: record.session, key, pane: record.pane });
    if (restore && record.originState) {
      window.scrollTo({ top: record.originState.scrollY || 0, left: record.originState.scrollX || 0, behavior: "auto" });
      const target = findFocusable(record.returnOrigin || record.origin, record.originState.focus);
      if (target?.focus) target.focus({ preventScroll: true });
      else if (record.returnOrigin?.focus) record.returnOrigin.focus({ preventScroll: true });
      else if (record.origin?.focus) record.origin.focus({ preventScroll: true });
    }
  };

  const restoreInlineOrigin = (record) => {
    const opener = record.returnOrigin || record.origin;
    if (!record.originState) {
      revealAnchor(opener);
      return;
    }
    let openerDetails = opener?.closest?.("details");
    while (openerDetails) {
      openerDetails.open = true;
      openerDetails = openerDetails.parentElement?.closest("details");
    }
    window.scrollTo({ top: record.originState.scrollY || 0, left: record.originState.scrollX || 0, behavior: "auto" });
    const target = findFocusable(opener, record.originState.focus);
    if (target?.focus) target.focus({ preventScroll: true });
    else if (record.returnOrigin?.focus) record.returnOrigin.focus({ preventScroll: true });
    else if (record.origin?.focus) record.origin.focus({ preventScroll: true });
  };

  const closeInlinePane = async (key) => {
    eventSourceIntent += 1;
    swapRevision += 1;
    setStatus("");
    const records = [...inlinePanes.values()];
    const index = records.findIndex((record) => record.key === key);
    if (index < 0) return false;
    const selected = records[index];
    const desired = records.slice(0, index).map((record) => ({
      provider: record.provider, session: record.session, href: record.href,
      originHref: record.originHref, originAnchor: record.originAnchor || "",
      originReturnAnchor: record.originReturnAnchor || "",
      originState: record.originState && { scrollX: record.originState.scrollX, scrollY: record.originState.scrollY,
        focus: record.originState.focus && { id: record.originState.focus.id, anchor: record.originState.focus.anchor } }
    }));
    const href = selected.originHref || historyEntries[historyIndex]?.href || location.pathname + location.search + location.hash;
    savePaneState(activePane());
    recordHistory(keyOf(activePane()), href, { inlineStack: desired });
    await applyInlineStack(desired);
    restoreInlineOrigin(selected);
    return true;
  };

  const createInlinePane = async (entry, origin, parentPane, isCurrent = () => true, returnOrigin = origin) => {
    const key = canonicalKey(entry.provider, entry.session);
    const pane = await fetchPane(entry.provider, entry.session, entry.href);
    if (!isCurrent()) return null;
    const previous = inlinePanes.get(key);
    if (previous) removeInlinePane(key);
    if (pane === parentPane) return false;
    unscopeReaderPane(pane);
    scopeReaderPane(pane, key);
    preserveCanonicalSourceLinks(pane);
    const wrapper = document.createElement("section");
    wrapper.className = "reader-inline-pane";
    wrapper.dataset.readerInlinePane = "true";
    wrapper.dataset.readerInlineKey = key;
    const path = document.createElement("nav");
    path.className = "reader-ancestor-path";
    path.setAttribute("aria-label", ft?.("detail.reader_history_path") || "History path");
    const ancestors = [];
    for (let ancestor = parentPane, descendantKey = key; ancestor;) {
      ancestors.unshift({ pane: ancestor, closeKey: descendantKey });
      descendantKey = keyOf(ancestor);
      ancestor = inlinePanes.get(descendantKey)?.parentPane;
    }
    ancestors.forEach(({ pane: ancestor, closeKey }) => {
      const back = document.createElement("button");
      back.type = "button";
      back.dataset.readerAncestorReturn = closeKey;
      back.textContent = ancestor.dataset.readerTitle;
      back.title = ancestor.dataset.readerTitle;
      back.setAttribute("aria-label", (ft?.("detail.reader_return_to") || "Return to {title}")
        .replace("{title}", ancestor.dataset.readerTitle));
      back.addEventListener("click", () => closeInlinePane(closeKey));
      path.append(back);
    });
    const current = document.createElement("span");
    current.setAttribute("aria-current", "location");
    current.textContent = pane.dataset.readerTitle;
    current.title = pane.dataset.readerTitle;
    path.append(current);
    const controls = document.createElement("div");
    controls.className = "reader-inline-pane-controls";
    const title = document.createElement("h3");
    title.className = "reader-inline-pane-title";
    title.textContent = pane.dataset.readerTitle;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "reader-inline-pane-close";
    close.dataset.readerInlineClose = "true";
    close.textContent = ft?.("detail.reader_inline_close") || "Close child history";
    const standalone = document.createElement("a");
    standalone.className = "reader-inline-pane-standalone";
    standalone.href = entry.href || `/${encodeURIComponent(entry.provider)}/session/${encodeURIComponent(entry.session)}`;
    standalone.textContent = ft?.("detail.reader_inline_standalone") || ft?.("detail.reader_child_history") || "Open full child history";
    controls.append(title, standalone, close);
    if (!origin?.matches?.("[data-reader-milestone], .reader-milestone")
      && returnOrigin?.closest?.(".session-toc, .reader-branch-body")) {
      const placement = document.createElement("span");
      placement.className = "reader-inline-pane-placement";
      placement.textContent = ft?.("detail.reader_inline_unplaced") || "No recorded position";
      controls.append(placement);
    }
    wrapper.append(path, controls, pane);
    // Copied URLs carry the recorded path, not a previous reading position.
    const originState = entry.originState || null;
    if (origin?.after) origin.after(wrapper);
    else parentPane?.append?.(wrapper);
    bindContextResultDisclosures(pane);
    const record = {
      provider: entry.provider, session: entry.session, key, href: entry.href,
      originHref: entry.originHref, originAnchor: entry.originAnchor || originIdentity(origin),
      originReturnAnchor: entry.originReturnAnchor || originIdentity(returnOrigin),
      pane, parentPane, wrapper, origin, returnOrigin, originState
    };
    inlinePanes.set(key, record);
    dispatch("session-reader:inline-opened", { provider: entry.provider, session: entry.session, key, pane });
    close.addEventListener("click", (event) => {
      event.preventDefault();
      if (inlinePanes.has(key)) void closeInlinePane(key);
    });
    return true;
  };

  const applyInlineStack = async (stack, { origin = null, rootIdentity = null } = {}) => {
    const revision = ++inlineRevision;
    const root = activePane();
    if (!root || (rootIdentity && keyOf(root) !== canonicalKey(rootIdentity.provider, rootIdentity.session))) return false;
    const normalized = stack.filter((entry) => entry?.provider && entry?.session);
    if (rootIdentity?.provider && rootIdentity?.session) {
      inlineRootIdentity = {
        provider: rootIdentity.provider,
        session: rootIdentity.session,
        href: rootIdentity.href || `/${encodeURIComponent(rootIdentity.provider)}/session/${encodeURIComponent(rootIdentity.session)}`
      };
      if (rootIdentity.state) inlineRootState = rootIdentity.state;
    }
    if (!inlineRootState && normalized[0]?.originState) inlineRootState = normalized[0].originState;
    const common = normalized.findIndex((entry, index) => {
      const current = [...inlinePanes.values()][index];
      return !current || current.key !== canonicalKey(entry.provider, entry.session);
    });
    const keep = common < 0 ? normalized.length : common;
    [...inlinePanes.values()].slice(keep).reverse().forEach((record) => removeInlinePane(record.key, { restore: false }));
    for (let index = keep; index < normalized.length; index += 1) {
      if (revision !== inlineRevision) return false;
      const entry = normalized[index];
      const parent = index === 0 ? root : paneFor(canonicalKey(normalized[index - 1].provider, normalized[index - 1].session));
      const opener = recordedOpener(parent, entry.provider, entry.session);
      if (!opener) return false;
      const entryOrigin = index === normalized.length - 1 && origin
        ? origin
        : originElementFor(parent, entry.originAnchor) || inlineOriginFor(opener);
      const entryReturnOrigin = entry.originReturnAnchor
        ? originElementFor(parent, entry.originReturnAnchor) || inlineReturnOriginFor(opener)
        : inlineReturnOriginFor(opener);
      try {
        const mounted = await createInlinePane(entry, entryOrigin, parent, () => revision === inlineRevision, entryReturnOrigin);
        if (!mounted) return false;
      } catch (error) {
        if (revision === inlineRevision) {
          console.error("Unable to load reader child:", error);
          setStatus(ft?.("detail.reader_load_failed") || "Unable to load child history", "error", entry.href);
        }
        return false;
      }
    }
    updateShell(root);
    return true;
  };

  const openInlinePane = async (link, provider, session, { record: recordNavigation = true } = {}) => {
    eventSourceIntent += 1;
    setStatus("");
    const navigationRevision = ++swapRevision;
    const navigationInlineRevision = inlineRevision;
    const parent = link.closest("[data-reader-pane]");
    if (!parent || canonicalKey(provider, session) === keyOf(parent)) return false;
    const key = canonicalKey(provider, session);
    const existingPane = paneFor(key);
    if (existingPane?.isConnected && (existingPane === activePane() || existingPane.contains?.(parent))) {
      const href = link.href || link.getAttribute("href") || "";
      if (link.dataset.readerAnchor || new URL(href, location.href).hash) return revealSource(link);
      if (recordNavigation) {
        savePaneState(activePane());
        const url = eventSourceUrlFor(link);
        recordHistory(keyOf(activePane()), existingPane === activePane()
          ? url.pathname + url.search : inlineSourceHref(url, key));
      }
      closeReaderCollaboration(link);
      revealAnchor(existingPane);
      dispatch("session-reader:anchor-revealed", { pane: existingPane, target: existingPane });
      return true;
    }
    const origin = inlineOriginFor(link);
    if (!origin) return false;
    const returnOrigin = inlineReturnOriginFor(link);
    savePaneState(activePane());
    if (!inlinePanes.size) {
      inlineRootState = cache.get(keyOf(activePane()))?.state || null;
      const root = activePane();
      inlineRootIdentity = {
        provider: providerOf(root),
        session: sessionOf(root),
        href: cache.get(keyOf(root))?.href || inlineHref()
      };
    }
    const current = [...inlinePanes.values()];
    const existingIndex = current.findIndex((record) => record.key === key);
    if (existingIndex >= 0) {
      const existing = current[existingIndex];
      if (existing.origin === origin && existing.parentPane === parent) {
        if (link.dataset.readerAnchor || new URL(link.href, location.href).hash) return revealSource(link);
        if (recordNavigation) recordHistory(keyOf(activePane()), inlineSourceHref(sourceUrlFor(link), key));
        closeReaderCollaboration(link);
        revealAnchor(existing.pane);
        dispatch("session-reader:anchor-revealed", { pane: existing.pane, target: existing.pane });
        return true;
      }
      if (existing.origin !== origin || existing.parentPane !== parent) {
        current.slice(existingIndex).reverse().forEach((record) => removeInlinePane(record.key, { restore: false }));
      }
    }
    const activeInline = [...inlinePanes.values()];
    const parentIndex = activeInline.findIndex((record) => record.pane === parent);
    const parentState = {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      focus: focusIdentity(document.activeElement, parent)
    };
    const stack = (parentIndex < 0 ? [] : activeInline.slice(0, parentIndex + 1)).map((record) => ({
      provider: record.provider, session: record.session, href: record.href, originHref: record.originHref,
      originAnchor: record.originAnchor || "",
      originReturnAnchor: record.originReturnAnchor || "",
      originState: record.originState && {
        scrollX: record.originState.scrollX, scrollY: record.originState.scrollY,
        focus: record.originState.focus && { id: record.originState.focus.id, anchor: record.originState.focus.anchor }
      }
    }));
    stack.push({
      provider, session,
      href: link.href || link.getAttribute("href") || `/${encodeURIComponent(provider)}/session/${encodeURIComponent(session)}`,
      originHref: location.pathname + location.search + location.hash,
      originAnchor: originIdentity(origin),
      originReturnAnchor: originIdentity(returnOrigin),
      originState: { scrollX: parentState.scrollX, scrollY: parentState.scrollY,
        focus: parentState.focus && { id: parentState.focus.id, anchor: parentState.focus.anchor } }
    });
    if (navigationRevision !== swapRevision || navigationInlineRevision !== inlineRevision) return false;
    const href = createReaderLocation(location.href, stack.at(-1).href,
      stack.slice(0, -1).map((entry) => `/${encodeURIComponent(entry.provider)}/session/${encodeURIComponent(entry.session)}`));
    if (recordNavigation) recordHistory(keyOf(activePane()), href, { inlineStack: stack });
    const result = await applyInlineStack(stack, { origin });
    if (!result || navigationRevision !== swapRevision) return false;
    const record = inlinePanes.get(key);
    if (record) {
      record.origin = origin;
      record.returnOrigin = returnOrigin;
      record.originReturnAnchor = originIdentity(returnOrigin);
      record.originState = parentState;
    }
    if (result && record) {
      if (link.dataset.readerAnchor || new URL(link.href, location.href).hash) {
        await revealSource(link, { replay: true });
        return true;
      }
      closeReaderCollaboration(link);
      revealAnchor(record.pane);
      dispatch("session-reader:anchor-revealed", { pane: record.pane, target: record.pane });
    }
    return result;
  };

  const normalizeOwnedEvidenceLinks = (pane, provider, session) => {
    const href = `/${encodeURIComponent(provider)}/session/${encodeURIComponent(session)}#tab-work`;
    pane.querySelectorAll("[data-inspector-evidence-kind], [data-relationships-more]").forEach((link) => {
      if (link instanceof HTMLAnchorElement) link.href = href;
    });
  };

  const loadReaderMetrics = async (panel) => {
    if (!panel || panel.dataset.readerMetricsLoaded === "true" || panel.dataset.readerMetricsLoading === "true") return;
    const provider = panel.dataset.readerMetricsProvider;
    const session = panel.dataset.readerMetricsSession;
    const state = panel.querySelector("[data-reader-metrics-state]");
    panel.dataset.readerMetricsLoading = "true";
    if (state) state.textContent = ft?.("detail.reader_loading") || ft?.("detail.reader_open_child") || "Loading…";
    try {
      const response = await fetch(`/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(session)}/reader/work-metrics`, { headers: { Accept: "application/json" } });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok || typeof data.html !== "string") throw new Error(data?.error || `HTTP ${response.status}`);
      const wrapper = document.createElement("div");
      wrapper.innerHTML = data.html;
      const rendered = wrapper.firstElementChild;
      if (!rendered) throw new Error("Reader metrics response did not contain a panel");
      panel.replaceChildren(...rendered.childNodes);
      panel.dataset.readerMetricsLoaded = "true";
    } catch (error) {
      if (state) state.textContent = ft?.("detail.reader_load_failed") || "Unable to load metrics.";
      panel.dataset.readerMetricsLoaded = "error";
      console.error("Unable to load reader metrics:", error);
    } finally {
      delete panel.dataset.readerMetricsLoading;
    }
  };

  const loadChildDisclosure = async (disclosure) => {
    if (!disclosure || disclosure.dataset.readerChildLoaded === "true" || disclosure.dataset.readerChildLoading === "true") return;
    const provider = disclosure.dataset.readerChildProvider;
    const child = disclosure.dataset.readerChildSession;
    const pane = disclosure.closest("[data-reader-pane]");
    const parent = sessionOf(pane);
    const state = disclosure.querySelector("[data-reader-child-preview-state]");
    if (!provider || !child || !parent) return;
    disclosure.dataset.readerChildLoading = "true";
    if (state) state.textContent = ft?.("detail.reader_loading") || "Loading…";
    try {
      const response = await fetch(`/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(parent)}/reader/child/${encodeURIComponent(child)}`, { headers: { Accept: "application/json" } });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      const preview = data.preview;
      if (state) {
        state.textContent = preview?.text || (data.metrics ? `${Number(data.metrics.totals?.directTotalTokens || 0).toLocaleString()} tokens` : (ft?.("conversation.inspector_not_recorded") || "Not recorded"));
        if (preview?.partId) state.dataset.readerPreviewPartId = preview.partId;
      }
      const tokenState = disclosure.querySelector("[data-reader-child-token-state]");
      if (tokenState) {
        const childTotals = data.metrics?.totals;
        tokenState.textContent = childTotals
          ? `${(ft?.("detail.tokens_direct") || "Selected session: {count}").replaceAll("{count}", Number(childTotals.directTotalTokens || 0).toLocaleString())} · ${(ft?.("detail.tokens_inclusive") || "Including child sessions: {count}").replaceAll("{count}", Number(childTotals.totalTokens || 0).toLocaleString())}`
          : (ft?.("runtime.unavailable") || "Metrics unavailable");
      }
      disclosure.dataset.readerChildLoaded = "true";
    } catch (error) {
      if (state) state.textContent = ft?.("detail.reader_load_failed") || "Unable to load child details.";
      console.error("Unable to load reader child details:", error);
    } finally {
      delete disclosure.dataset.readerChildLoading;
    }
  };

  workbench.addEventListener("toggle", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLDetailsElement) || !target.open) return;
    if (target.matches("[data-reader-child-disclosure]")) void loadChildDisclosure(target);
    if (target.matches("#tab-work") || target.querySelector("[data-reader-metrics]")) void loadReaderMetrics(target.querySelector("[data-reader-metrics]"));
  }, true);

  const recordHistory = (key, href, { replace = false, state = null, inlineStack = serializedInlineStack() } = {}) => {
    if (replace) {
      historyEntries[historyIndex].href = href;
    } else {
      historyEntries.splice(historyIndex + 1);
      historyEntries.push({ key, href, state });
      historyIndex = historyEntries.length - 1;
    }
    const browserState = { ...history.state, readerEntry: historyIndex };
    if (!replace) delete browserState.readerPosition;
    delete browserState.readerInlineAnchorSession;
    delete browserState.readerEventSession;
    delete browserState.readerInline;
    delete browserState.readerInlineRoot;
    Object.assign(browserState, withInlineHistory(browserState, inlineStack));
    if (replace) history.replaceState(browserState, "", href);
    else history.pushState(browserState, "", href);
    cache.get(key).href = href;
  };

  const navigateCanonical = (href) => {
    eventSourceIntent += 1;
    swapRevision += 1;
    inlineRevision += 1;
    history.scrollRestoration = "auto";
    location.assign(href);
    return false;
  };

  const openPane = async (provider, session, { href = "", record = true } = {}) => {
    if (!provider || !session) return false;
    const key = canonicalKey(provider, session);
    if (paneFor(key)?.isConnected) return true;
    const parents = [activePane(), ...[...inlinePanes.values()].map((entry) => entry.pane)];
    const opener = parents.map((pane) => recordedOpener(pane, provider, session)).find(Boolean);
    return opener ? openInlinePane(opener, provider, session, { record })
      : navigateCanonical(href || `/${encodeURIComponent(provider)}/session/${encodeURIComponent(session)}`);
  };

  const revealAnchor = (target) => {
    let detail = target.closest("details");
    while (detail) {
      detail.open = true;
      detail = detail.parentElement?.closest("details") || null;
    }
    target.scrollIntoView({ block: "start", behavior: "auto" });
    target.classList.add("anchor-flash");
    if (target instanceof HTMLElement) {
      const hadTabIndex = target.hasAttribute("tabindex");
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
      if (!hadTabIndex) target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
    }
    window.setTimeout(() => target.classList.remove("anchor-flash"), 900);
  };

  const revealSource = async (link, { replay = false } = {}) => {
    eventSourceIntent += 1;
    swapRevision += 1;
    inlineRevision += 1;
    setStatus("");
    const ownerPane = link.closest("[data-reader-pane]") || activePane();
    const provider = link.dataset.readerProvider || providerOf(ownerPane);
    const session = link.dataset.readerSession || sessionOf(ownerPane);
    const sourceUrl = eventSourceUrlFor(link);
    const anchor = link.dataset.readerAnchor || decodeURIComponent(sourceUrl.hash.slice(1));
    sourceUrl.searchParams.delete("readerEvent");
    if (anchor && !sourceUrl.hash) sourceUrl.hash = anchor;
    const sourceHref = sourceUrl.pathname + sourceUrl.search + sourceUrl.hash;
    const key = canonicalKey(provider, session);
    if (!paneFor(key)?.isConnected && !await openPane(provider, session, { href: sourceHref, record: false })) return;
    const pane = paneFor(key);
    const intent = eventSourceIntent;
    let target;
    try {
      target = anchor ? await ensureReaderAnchor(pane, anchor) : null;
    } catch (error) {
      if (pane?.isConnected && intent === eventSourceIntent) {
        const key = error.code === "process_not_found" ? "detail.reader_source_missing" : "detail.reader_event_failed";
        setStatus(ft?.(key) || "", "error", sourceHref);
      }
      return false;
    }
    if (!pane?.isConnected || intent !== eventSourceIntent) return false;
    if (!target) {
      setStatus(ft?.("detail.reader_source_missing") || "Source unavailable", "error", sourceHref);
      return false;
    }
    const canonicalTargetAnchor = target.dataset.readerCanonicalAnchor || anchor;
    if (!replay) {
      sourceUrl.hash = canonicalTargetAnchor;
      savePaneState(activePane());
      recordHistory(keyOf(activePane()), inlinePanes.has(key) ? inlineSourceHref(sourceUrl, key) : sourceHref);
      updateShell(activePane());
    }
    closeReaderCollaboration(link);
    revealAnchor(target);
    dispatch("session-reader:anchor-revealed", { pane, target });
  };

  const nativeEventPartFor = (pane, target) => {
    const partId = String(target?.partId || "");
    const anchor = String(target?.anchor || "");
    if (!partId || !anchor) return null;
    const anchorElement = readerPaneAnchor(pane, anchor);
    if (!anchorElement) return null;
    if (anchorElement.dataset.partId === partId) return anchorElement;
    const part = anchorElement.querySelector(`[data-part-id="${CSS.escape(partId)}"]`);
    return part ? anchorElement : null;
  };

  const appendEventEvidence = (pane, data) => {
    const transcript = pane.querySelector("[data-reader-transcript]") || pane;
    const old = transcript.querySelector(`[data-reader-event-evidence][data-reader-event-id="${CSS.escape(data.evidence.eventId)}"]`);
    if (old) old.remove();
    const wrapper = document.createElement("div");
    wrapper.innerHTML = typeof data.html === "string" ? data.html : "";
    const evidence = wrapper.firstElementChild;
    if (!evidence) return null;
    const canonicalId = `reader-event-${String(data.evidence.eventId).replace(/[^A-Za-z0-9_-]/g, "-")}`;
    evidence.id = pane.dataset.readerDomScope ? `${pane.dataset.readerDomScope}--${canonicalId}` : canonicalId;
    if (pane.dataset.readerDomScope) evidence.dataset.readerCanonicalAnchor = canonicalId;
    const milestone = transcript.querySelector(`[data-reader-milestone][data-reader-event-id="${CSS.escape(data.evidence.eventId)}"]`);
    if (milestone) milestone.after(evidence);
    else transcript.append(evidence);
    return evidence;
  };

  const revealEventSource = async (link, { replay = false } = {}) => {
    const ownerPane = link.closest("[data-reader-pane]") || activePane();
    const provider = link.dataset.readerProvider || providerOf(ownerPane);
    const session = link.dataset.readerSession || sessionOf(ownerPane);
    const eventId = link.dataset.readerEventId || "";
    if (!provider || !session || !eventId) return false;
    const key = canonicalKey(provider, session);
    let intent = ++eventSourceIntent;
    swapRevision += 1;
    inlineRevision += 1;
    let pane = paneFor(key);
    const promise = (async () => {
      if (!pane?.isConnected) {
        const opened = await openPane(provider, session, { href: eventSourceUrlFor(link).href, record: false });
        if (!opened) return false;
        intent = ++eventSourceIntent;
        pane = paneFor(key);
      }
      if (!pane) return false;
      const isCurrent = () => pane?.isConnected && intent === eventSourceIntent;
      if (isCurrent()) setStatus(ft?.("detail.reader_event_loading") || "", "loading");
      const response = await fetch(`/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(session)}/reader/event/${encodeURIComponent(eventId)}`);
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok || !data.evidence) throw new Error(data?.error || `HTTP ${response.status}`);
      if (!isCurrent()) return false;
      if (data.nativeTarget) await ensureReaderAnchor(pane, data.nativeTarget.anchor);
      if (!isCurrent()) return false;
      const target = data.nativeTarget
        ? nativeEventPartFor(pane, data.nativeTarget)
        : null;
      if (data.nativeTarget && !target) {
        const error = new Error("The recorded source part is not present in this reader pane.");
        error.code = "source_missing";
        throw error;
      }
      if (isCurrent()) {
        const source = target || appendEventEvidence(pane, data);
        if (source) {
          const url = eventSourceUrlFor(link);
          if (target) url.searchParams.delete("readerEvent");
          else url.searchParams.set("readerEvent", eventId);
          url.hash = source.dataset.readerCanonicalAnchor || source.id;
          if (!replay) savePaneState(activePane());
          if (!replay || !inlinePanes.has(key)) {
            recordHistory(keyOf(activePane()), inlinePanes.has(key) ? inlineSourceHref(url, key) : url.pathname + url.search + url.hash, { replace: replay });
          }
          updateShell(activePane());
          closeReaderCollaboration(link);
          revealAnchor(source);
          dispatch("session-reader:anchor-revealed", { pane, target: source });
        }
      }
      if (isCurrent()) setStatus("");
      return true;
    })().catch((error) => {
      console.error("Unable to load reader event source:", error);
      if (pane?.isConnected && intent === eventSourceIntent) {
        const messageKey = ["source_missing", "process_not_found"].includes(error?.code) ? "detail.reader_source_missing" : "detail.reader_event_failed";
        setStatus(ft?.(messageKey) || "", "error", link.href || "");
      }
      return false;
    });
    return promise;
  };

  const loadMoreCoordination = async (button) => {
    const details = button.closest("[data-agent-channel]");
    const state = details?.querySelector("[data-reader-coordination-state]");
    const url = button.dataset.readerCoordinationUrl || button.getAttribute("href") || "";
    if (!details || !url) return false;
    button.disabled = true;
    state && (state.textContent = ft?.("detail.reader_coordination_loading") || "");
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      if (typeof data.html !== "string") throw new Error("Reader coordination response did not contain server-rendered HTML");
      const wrapper = document.createElement("div");
      wrapper.innerHTML = data.html;
      const serverList = wrapper.querySelector("ol");
      const list = details.querySelector("[data-reader-coordination-list]");
      if (!serverList || !list) throw new Error("Reader coordination response did not contain a list");
      [...serverList.children].forEach((item) => {
        const id = item.getAttribute("data-reader-observation-id");
        if (!id || !list.querySelector(`[data-reader-observation-id="${CSS.escape(id)}"]`)) list.append(item);
      });
      if (data.nextCursor) {
        const next = new URL(url, location.href);
        next.searchParams.set("cursor", data.nextCursor);
        button.dataset.readerCoordinationUrl = `${next.pathname}${next.search}`;
        button.disabled = false;
      } else {
        button.remove();
      }
      if (state) state.textContent = "";
      return true;
    } catch (error) {
      console.error("Unable to load reader coordination:", error);
      button.disabled = false;
      if (state) state.textContent = ft?.("detail.reader_coordination_failed") || "";
      return false;
    }
  };

  const contextResultLoads = new WeakMap();
  const contextResultMessage = (disclosure, message, failed = false) => {
    const panel = disclosure.querySelector("[data-context-result-panel]");
    if (!panel) return null;
    panel.replaceChildren();
    const text = document.createElement("span");
    text.className = "context-result-state";
    text.textContent = message;
    panel.append(text);
    if (failed) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "context-result-retry";
      retry.dataset.contextResultRetry = "true";
      retry.textContent = ft?.("detail.context_result_retry") || ft?.("progressive.show_more") || "";
      panel.append(retry);
    }
    return panel;
  };
  const loadContextResult = (disclosure, { retry = false } = {}) => {
    if (!disclosure) return Promise.resolve(false);
    if (!retry && disclosure.dataset.contextResultLoaded === "true") return Promise.resolve(true);
    const pending = contextResultLoads.get(disclosure);
    if (pending) return pending;
    const pane = disclosure.closest("[data-reader-pane]");
    const provider = disclosure.dataset.contextResultProvider || providerOf(pane);
    const session = disclosure.dataset.contextResultSession || sessionOf(pane);
    const checkpoint = disclosure.dataset.contextResultCheckpoint || "";
    const promise = (async () => {
      contextResultMessage(disclosure, ft?.("detail.context_result_loading") || ft?.("detail.reader_loading") || "");
      try {
        const query = new URLSearchParams({ checkpoint, offset: "0", limit: "20" });
        const response = await fetch(`/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(session)}/context-result?${query}`);
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.ok || typeof data.html !== "string") throw new Error(data?.error || `HTTP ${response.status}`);
        const panel = disclosure.querySelector("[data-context-result-panel]");
        if (!panel) return false;
        panel.innerHTML = data.html;
        disclosure.dataset.contextResultLoaded = "true";
        delete disclosure.dataset.contextResultFailed;
        return true;
      } catch (error) {
        console.error("Unable to load context result:", error);
        contextResultMessage(disclosure, ft?.("detail.context_result_failed") || ft?.("detail.reader_load_failed") || "", true);
        disclosure.dataset.contextResultFailed = "true";
        return false;
      }
    })();
    contextResultLoads.set(disclosure, promise);
    return promise.finally(() => contextResultLoads.delete(disclosure));
  };

  const bindContextResultDisclosures = (pane) => {
    pane?.querySelectorAll("details[data-context-result]").forEach((disclosure) => {
      if (disclosure.dataset.contextResultBound === "true") return;
      disclosure.dataset.contextResultBound = "true";
      disclosure.addEventListener("toggle", () => {
        if (disclosure.open) void loadContextResult(disclosure);
      });
    });
  };

  const loadMoreContextResult = async (button) => {
    const pane = button.closest("[data-reader-pane]");
    const provider = button.dataset.contextResultProvider || providerOf(pane);
    const session = button.dataset.contextResultSession || sessionOf(pane);
    const checkpoint = button.dataset.contextResultCheckpoint || "";
    const offset = button.dataset.contextResultOffset || "0";
    const limit = button.dataset.contextResultLimit || "20";
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      const query = new URLSearchParams({ checkpoint, offset, limit });
      const response = await fetch(`/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(session)}/context-result?${query}`);
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok || typeof data.html !== "string") throw new Error(data?.error || `HTTP ${response.status}`);
      const wrapper = document.createElement("div");
      wrapper.innerHTML = data.html;
      const page = wrapper.firstElementChild;
      if (!page) throw new Error("Context result response did not contain a page");
      const targetParent = button.parentElement;
      button.remove();
      [...page.childNodes].forEach((child) => targetParent?.append(child));
      return true;
    } catch (error) {
      console.error("Unable to load more context result:", error);
      button.disabled = false;
      button.removeAttribute("aria-busy");
      return false;
    }
  };

  const loadMoreInheritedContext = async (button) => {
    const pane = button.closest("[data-reader-pane]");
    const disclosure = button.closest("[data-inherited-context]");
    const messages = disclosure?.querySelector("[data-inherited-context-messages]");
    if (!pane || !messages) return false;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      const query = new URLSearchParams({ offset: button.dataset.nextOffset });
      const response = await fetch(`/api/${encodeURIComponent(providerOf(pane))}/session/${encodeURIComponent(sessionOf(pane))}/inherited-context?${query}`);
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok || typeof data.html !== "string") throw new Error(data?.error || `HTTP ${response.status}`);
      if (!button.isConnected || !pane.isConnected) return false;
      const wrapper = document.createElement("div");
      wrapper.innerHTML = data.html;
      [...wrapper.childNodes].forEach((message) => messages.append(message));
      messages.dataset.messageCount = String(data.shown);
      const count = disclosure.querySelector(".inherited-context-count");
      if (count) count.textContent = data.label;
      if (data.nextOffset === null) button.remove();
      else button.dataset.nextOffset = String(data.nextOffset);
      return true;
    } catch (error) {
      console.error("Unable to load inherited context:", error);
      if (pane.isConnected) showToast?.(ft?.("detail.inherited_context_failed") || "", "error");
      return false;
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  };

  workbench.addEventListener("click", async (event) => {
    const eventSource = event.target.closest("[data-reader-event-source], [data-reader-coordination-source]");
    if (eventSource && workbench.contains(eventSource) && eventSource.matches("a[href]")) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      await revealEventSource(eventSource);
      return;
    }
    const collaborationToggle = event.target.closest("[data-reader-collaboration-toggle]");
    if (collaborationToggle && workbench.contains(collaborationToggle)) {
      event.preventDefault();
      const pane = host.querySelector("[data-reader-pane]");
      const target = pane?.querySelector("[data-reader-collaboration]");
      if (target) {
        target.hidden = !target.hidden;
        target.dataset.readerCollaborationExpanded = target.hidden ? "false" : "true";
        collaborationToggle.setAttribute("aria-expanded", target.hidden ? "false" : "true");
      }
      return;
    }
    const contextRetry = event.target.closest("[data-context-result-retry]");
    if (contextRetry && workbench.contains(contextRetry)) {
      event.preventDefault();
      const disclosure = contextRetry.closest("[data-context-result]");
      if (disclosure) {
        delete disclosure.dataset.contextResultLoaded;
        void loadContextResult(disclosure, { retry: true });
      }
      return;
    }
    const contextMore = event.target.closest("[data-context-result-more]");
    if (contextMore && workbench.contains(contextMore)) {
      event.preventDefault();
      await loadMoreContextResult(contextMore);
      return;
    }
    const inheritedMore = event.target.closest("[data-inherited-context-more]");
    if (inheritedMore && workbench.contains(inheritedMore)) {
      event.preventDefault();
      await loadMoreInheritedContext(inheritedMore);
      return;
    }
    const coordinationMore = event.target.closest("[data-reader-coordination-more]");
    if (coordinationMore && workbench.contains(coordinationMore)) {
      event.preventDefault();
      await loadMoreCoordination(coordinationMore);
      return;
    }
    const source = event.target.closest("[data-reader-source], .session-toc a[href^='#']");
    if (source && workbench.contains(source) && source.matches("a[href]")) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      await revealSource(source);
      return;
    }
    const child = event.target.closest("[data-reader-open]");
    if (child && workbench.contains(child)) {
      const provider = child.dataset.readerProvider;
      const session = child.dataset.readerSession;
      if (!provider || !session) return;
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      const opened = child.closest("[data-reader-pane]") && inlineOriginFor(child)
        ? await openInlinePane(child, provider, session)
        : await openPane(provider, session, { href: child.href || child.getAttribute("href") || "" });
      if (!opened) return;
    }
  });

  const narrowLayout = window.matchMedia?.("(max-width: 820px)");
  const ensureCollaborationToggle = (pane) => {
    const target = pane?.querySelector("[data-reader-collaboration]");
    if (!target) return null;
    if (target.closest("[data-reader-collaboration-overview]")) return null;
    let toggle = pane.querySelector("[data-reader-collaboration-toggle]");
    if (!toggle) {
      toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "reader-collaboration-toggle";
      toggle.dataset.readerCollaborationToggle = "true";
      toggle.textContent = ft?.("detail.reader_collaboration") || "";
      target.before(toggle);
    }
    if (!target.id) target.id = `reader-collaboration-${Math.random().toString(36).slice(2)}`;
    toggle.setAttribute("aria-controls", target.id);
    return { target, toggle };
  };
  const syncCollaborationLayout = () => {
    const pane = host.querySelector("[data-reader-pane]");
    const collaboration = ensureCollaborationToggle(pane);
    if (!collaboration) return;
    const { target, toggle } = collaboration;
    const expanded = !narrowLayout?.matches || target.dataset.readerCollaborationExpanded === "true";
    target.hidden = !expanded;
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  };
  narrowLayout?.addEventListener?.("change", syncCollaborationLayout);
  workbench.addEventListener("session-reader:swapped", syncCollaborationLayout);

  backButton?.addEventListener("click", () => {
    if (historyIndex <= 0 && inlinePanes.size === 0) return;
    if (historyIndex <= 0) {
      void closeInlinePane(inlinePanes.keys().next().value);
      return;
    }
    history.back();
  });

  const replayLocation = async () => {
    const revision = swapRevision;
    const locator = parseReaderLocation(location.href, location.href);
    if (new URLSearchParams(location.search).has("readerSource") && !locator) {
      setStatus(ft?.("detail.reader_source_missing") || "Source unavailable", "error");
      return false;
    }
    const url = locator?.source || new URL(location.href);
    const [, encodedProvider, encodedSession] = url.pathname.match(/^\/([^/]+)\/session\/([^/]+)$/) || [];
    if (!encodedProvider || !encodedSession) return false;
    const provider = decodeURIComponent(encodedProvider);
    const session = decodeURIComponent(encodedSession);
    const key = canonicalKey(provider, session);
    if (locator && key !== keyOf(activePane()) && !paneFor(key)?.isConnected) {
      if (!inlineRootIdentity) {
        const rootUrl = stripReaderLocation(new URL(location.href));
        inlineRootIdentity = { provider: providerOf(activePane()), session: sessionOf(activePane()), href: rootUrl.pathname + rootUrl.search };
      }
      const path = [...locator.ancestors, { provider, session, href: url.href }];
      const stack = [];
      for (const entry of path) {
        if (revision !== swapRevision) return false;
        const parent = stack.length ? paneFor(canonicalKey(stack.at(-1).provider, stack.at(-1).session)) : activePane();
        const opener = recordedOpener(parent, entry.provider, entry.session);
        if (!opener) return navigateCanonical(url.href);
        const origin = inlineOriginFor(opener);
        const parentHref = stack.length
          ? createReaderLocation(location.href, stack.at(-1).href, stack.slice(0, -1).map((item) => item.href))
          : inlineRootIdentity.href;
        stack.push({ ...entry, originHref: parentHref, originAnchor: originIdentity(origin), originReturnAnchor: originIdentity(inlineReturnOriginFor(opener)) });
        if (!await applyInlineStack(stack)) return false;
      }
      if (revision !== swapRevision) return false;
      history.replaceState(withInlineHistory(history.state, serializedInlineStack()), "", inlineHref());
    }
    if (revision !== swapRevision) return false;
    const source = document.createElement("a");
    source.href = url.href;
    source.dataset.readerProvider = provider;
    source.dataset.readerSession = session;
    const eventId = url.searchParams.get("readerEvent");
    if (eventId) {
      const cachedSource = url.hash && readerPaneAnchor(paneFor(key), decodeURIComponent(url.hash.slice(1)));
      if (cachedSource?.dataset.readerEventId === eventId) {
        revealAnchor(cachedSource);
        dispatch("session-reader:anchor-revealed", { pane: paneFor(key), target: cachedSource });
        return true;
      }
      source.dataset.readerEventId = eventId;
      return revealEventSource(source, { replay: true });
    }
    if (url.hash) return revealSource(source, { replay: true });
    if (locator) {
      const pane = paneFor(key);
      if (pane?.isConnected) {
        revealAnchor(pane);
        dispatch("session-reader:anchor-revealed", { pane, target: pane });
      }
    }
    return true;
  };

  window.addEventListener("popstate", async (event) => {
    eventSourceIntent += 1;
    setStatus("");
    const revision = ++swapRevision;
    inlineRevision += 1;
    const root = activePane();
    const rootPath = `/${encodeURIComponent(providerOf(root))}/session/${encodeURIComponent(sessionOf(root))}`;
    if (location.pathname !== rootPath) {
      history.scrollRestoration = "auto";
      location.reload();
      return;
    }
    savePaneState(root, { captureHref: false });
    const savedIndex = event.state?.readerEntry;
    historyIndex = Number.isInteger(savedIndex) ? savedIndex : 0;
    if (!historyEntries[historyIndex]) historyEntries[historyIndex] = { key: keyOf(root), href: inlineHref(), state: event.state?.readerPosition || null };
    const entry = historyEntries[historyIndex];
    const targetStack = inlineStackFrom(event.state);
    const leaving = [...inlinePanes.values()][targetStack.length];
    await applyInlineStack(targetStack, { rootIdentity: event.state?.readerInlineRoot });
    if (revision !== swapRevision) return;
    await replayLocation();
    if (historyEntries[historyIndex] === entry) {
      if (entry.state) restorePaneState(root, entry.state);
      else if (leaving && !inlinePanes.has(leaving.key)) restoreInlineOrigin(leaving);
    }
    updateShell(root);
  });

  const initial = host.querySelector("[data-reader-pane]");
  if (initial) {
    const key = keyOf(initial);
    normalizeOwnedEvidenceLinks(initial, providerOf(initial), sessionOf(initial));
    cache.set(key, { pane: initial, state: null, href: location.pathname + location.search + location.hash });
    historyIndex = Number.isInteger(history.state?.readerEntry) ? history.state.readerEntry : 0;
    historyEntries[historyIndex] = { key, href: location.pathname + location.search + location.hash, state: history.state?.readerPosition || null };
    history.scrollRestoration = "auto";
    history.replaceState({ ...history.state, readerEntry: historyIndex }, "", historyEntries[historyIndex].href);
    updateShell(initial);
    setStatus("");
  }
  bindContextResultDisclosures(initial);
  syncCollaborationLayout();
  const initialRevision = swapRevision;
  if (initial && (inlineStackFrom(history.state).length || new URLSearchParams(location.search).has("readerSource")
    || new URLSearchParams(location.search).has("readerEvent")
    || location.hash && readerPaneAnchor(initial, decodeURIComponent(location.hash.slice(1))))) queueMicrotask(async () => {
    if (initialRevision !== swapRevision) return;
    await applyInlineStack(inlineStackFrom(history.state), { rootIdentity: history.state?.readerInlineRoot });
    if (initialRevision === swapRevision) await replayLocation();
  });

  return {
    openPane,
    getActivePane: () => host.querySelector("[data-reader-pane]"),
    getInlinePanes: () => [...inlinePanes.values()].map((record) => record.pane),
    cache
  };
}
