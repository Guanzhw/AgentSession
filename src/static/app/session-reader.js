import { readerPaneAnchor, scopeReaderPane, unscopeReaderPane } from "./reader-pane-dom.js";

/* Unified session reader navigation.
 *
 * The server owns pane markup and canonical links. This controller only swaps
 * those server-rendered panes, keeping detached DOM nodes as the local cache.
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
  let pendingFocus = null;
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
    return url;
  };
  const eventSourceUrlFor = (link) => {
    const url = sourceUrlFor(link);
    const current = new URL(location.href);
    for (const [name, value] of current.searchParams) {
      if (name !== "readerEvent" && !url.searchParams.has(name)) url.searchParams.append(name, value);
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
  };

  const restorePaneState = (pane, savedState = null) => {
    const entry = historyEntries[historyIndex];
    const state = savedState || entry?.state;
    if (!state) {
      pendingFocus = null;
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      return;
    }
    requestAnimationFrame(() => {
      if (historyEntries[historyIndex] !== entry || host.querySelector("[data-reader-pane]") !== pane) return;
      window.scrollTo({ top: state.scrollY || 0, left: state.scrollX || 0, behavior: "auto" });
      const focusTarget = findFocusable(pane, pendingFocus || state.focus);
      pendingFocus = null;
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

  const attachPane = (pane, key, { restore = true } = {}) => {
    if (!pane) return false;
    bindContextResultDisclosures(pane);
    swapRevision += 1;
    // Attaching a cached or newly fetched pane cancels any in-flight reader
    // navigation state. A stale fetch may still settle later, but it must not
    // leave the shell reporting that an obsolete pane is loading.
    setStatus("");
    const previous = host.querySelector("[data-reader-pane]");
    if (previous !== pane) {
      if (previous) {
        dispatch("session-reader:before-swap", {
          provider: providerOf(previous), session: sessionOf(previous), key: keyOf(previous), pane: previous
        });
      }
      host.replaceChildren(pane);
    }
    updateShell(pane);
    if (previous !== pane) {
      dispatch("session-reader:swapped", {
        provider: providerOf(pane), session: sessionOf(pane), key, pane
      });
    }
    if (restore) restorePaneState(pane);
    return true;
  };

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
    return conversationLayout?.lastElementChild || conversationLayout || transcript?.lastElementChild || transcript || pane;
  };

  const inlineOriginFor = (link) => {
    const pane = link.closest("[data-reader-pane]");
    if (link.closest(".session-toc")) return null;
    const branchBody = link.closest(".reader-branch-body");
    if (branchBody && pane) {
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
    if (!record?.originState) return;
    const opener = record.returnOrigin || record.origin;
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
    const state = withInlineHistory(history.state, desired);
    delete state.readerEventSession;
    delete state.readerInlineAnchorSession;
    history.pushState(state, "", href);
    await applyInlineStack(desired, { restore: false });
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
    const wrapper = document.createElement("section");
    wrapper.className = "reader-inline-pane";
    wrapper.dataset.readerInlinePane = "true";
    wrapper.dataset.readerInlineKey = key;
    const controls = document.createElement("div");
    controls.className = "reader-inline-pane-controls";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "reader-inline-pane-close";
    close.dataset.readerInlineClose = "true";
    close.textContent = ft?.("detail.reader_inline_close") || "Close child history";
    const standalone = document.createElement("a");
    standalone.className = "reader-inline-pane-standalone";
    standalone.href = entry.href || `/${encodeURIComponent(entry.provider)}/session/${encodeURIComponent(entry.session)}`;
    standalone.textContent = ft?.("detail.reader_inline_standalone") || ft?.("detail.reader_child_history") || "Open full child history";
    controls.append(close, standalone);
    wrapper.append(controls, pane);
    const originState = entry.originState || {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      focus: focusIdentity(document.activeElement, parentPane)
    };
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

  const ensureRootPane = async (identity, expectedRevision = swapRevision) => {
    const current = activePane();
    if (!identity?.provider || !identity?.session) return current;
    const key = canonicalKey(identity.provider, identity.session);
    if (current && keyOf(current) === key) return expectedRevision === swapRevision ? current : null;
    const pane = paneFor(key);
    if (!pane) return null;
    if (expectedRevision !== swapRevision) return null;
    unscopeReaderPane(pane);
    attachPane(pane, key, { restore: false });
    return pane;
  };

  const applyInlineStack = async (stack, { restore = true, origin = null, rootIdentity = null } = {}) => {
    const revision = ++inlineRevision;
    const navigationRevision = swapRevision;
    const root = await ensureRootPane(rootIdentity, navigationRevision);
    if (!root || revision !== inlineRevision) return false;
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
      const entryOrigin = index === normalized.length - 1 && origin
        ? origin
        : entry.originAnchor ? originElementFor(parent, entry.originAnchor) || parent : parent;
      const entryReturnOrigin = entry.originReturnAnchor
        ? originElementFor(parent, entry.originReturnAnchor) || entryOrigin
        : entryOrigin;
      const mounted = await createInlinePane(entry, entryOrigin, parent, () => revision === inlineRevision, entryReturnOrigin);
      if (mounted == null || !mounted) return false;
    }
    updateShell(root);
    if (!normalized.length && restore) {
      const rootState = historyEntries[historyIndex]?.state;
      if (rootState || inlineRootState) restorePaneState(root, inlineRootState || rootState);
      inlineRootState = null;
      inlineRootIdentity = null;
    }
    return true;
  };

  const openInlinePane = async (link, provider, session) => {
    const navigationRevision = ++swapRevision;
    const navigationInlineRevision = inlineRevision;
    const parent = link.closest("[data-reader-pane]");
    if (!parent || canonicalKey(provider, session) === keyOf(parent)) return false;
    const key = canonicalKey(provider, session);
    const existingPane = paneFor(key);
    if (existingPane?.isConnected && (existingPane === activePane() || existingPane.contains?.(parent))) {
      const href = link.href || link.getAttribute("href") || "";
      if (link.dataset.readerAnchor || new URL(href, location.href).hash) return revealSource(link);
      closeReaderCollaboration(link);
      revealAnchor(existingPane);
      dispatch("session-reader:anchor-revealed", { pane: existingPane, target: existingPane });
      return true;
    }
    const origin = inlineOriginFor(link);
    if (!origin) return false;
    const returnOrigin = inlineReturnOriginFor(link);
    if (!inlinePanes.size) {
      savePaneState(activePane());
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
    const href = inlineHref(stack);
    const browserState = withInlineHistory(history.state, stack);
    delete browserState.readerEventSession;
    delete browserState.readerInlineAnchorSession;
    history.pushState(browserState, "", href);
    const result = await applyInlineStack(stack, { restore: false, origin });
    const record = inlinePanes.get(key);
    if (record) {
      record.origin = origin;
      record.returnOrigin = returnOrigin;
      record.originReturnAnchor = originIdentity(returnOrigin);
      record.originState = parentState;
    }
    if (result && record && link.closest("[data-reader-collaboration-overview]")) {
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

  const recordHistory = (key, href, { replace = false, state = null } = {}) => {
    if (replace) {
      historyEntries[historyIndex].href = href;
    } else {
      historyEntries.splice(historyIndex + 1);
      historyEntries.push({ key, href, state });
      historyIndex = historyEntries.length - 1;
    }
    const browserState = { ...history.state, readerEntry: historyIndex };
    delete browserState.readerInlineAnchorSession;
    delete browserState.readerEventSession;
    delete browserState.readerInline;
    delete browserState.readerInlineRoot;
    if (inlinePanes.size) {
      Object.assign(browserState, withInlineHistory(browserState, serializedInlineStack()));
      browserState.readerInlineAnchorSession = key;
      if (new URL(href, location.href).searchParams.has("readerEvent")) browserState.readerEventSession = key;
    }
    if (replace) history.replaceState(browserState, "", href);
    else history.pushState(browserState, "", href);
    cache.get(key).href = href;
  };

  const openPane = async (provider, session, { href = "", focus = null, restore = true, invalidateSources = true } = {}) => {
    if (!provider || !session) return false;
    const key = canonicalKey(provider, session);
    if (key === keyOf(host.querySelector("[data-reader-pane]"))) {
      updateShell(host.querySelector("[data-reader-pane]"));
      return true;
    }
    if (invalidateSources) eventSourceIntent += 1;
    const revision = ++swapRevision;
    inlineRevision += 1;
    [...inlinePanes.values()].reverse().forEach((record) => removeInlinePane(record.key, { restore: false }));
    inlineRootState = null;
    inlineRootIdentity = null;
    setStatus(ft?.("detail.reader_loading") || "", "loading");
    try {
      const pane = await fetchPane(provider, session, href);
      if (revision !== swapRevision) return false;
      unscopeReaderPane(pane);
      savePaneState(host.querySelector("[data-reader-pane]"));
      pendingFocus = focus;
      recordHistory(key, href || `/${encodeURIComponent(provider)}/session/${encodeURIComponent(session)}`, {
        state: restore ? cache.get(key)?.state : null
      });
      attachPane(pane, key, { restore });
      updateShell(pane);
      setStatus("");
      return true;
    } catch (error) {
      if (revision === swapRevision) {
        const message = ft?.("detail.reader_load_failed") || "";
        setStatus(message, "error", href || `/${encodeURIComponent(provider)}/session/${encodeURIComponent(session)}`);
        showToast?.(message, "error");
      }
      return false;
    }
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

  const revealSource = async (link) => {
    eventSourceIntent += 1;
    swapRevision += 1;
    inlineRevision += 1;
    setStatus("");
    const ownerPane = link.closest("[data-reader-pane]") || activePane();
    const provider = link.dataset.readerProvider || providerOf(ownerPane);
    const session = link.dataset.readerSession || sessionOf(ownerPane);
    const sourceUrl = sourceUrlFor(link);
    const anchor = link.dataset.readerAnchor || decodeURIComponent(sourceUrl.hash.slice(1));
    sourceUrl.searchParams.delete("readerEvent");
    if (anchor && !sourceUrl.hash) sourceUrl.hash = anchor;
    const sourceHref = sourceUrl.pathname + sourceUrl.search + sourceUrl.hash;
    const currentPane = ownerPane || activePane();
    const targetPane = paneFor(canonicalKey(provider, session));
    const samePane = targetPane === currentPane;
    if (!samePane) {
      if (targetPane?.isConnected) {
        // A source link inside an inline child remains in that child; the
        // parent reader must not be replaced to reveal its native anchor.
      } else {
        const opened = await openPane(provider, session, { href: sourceHref, restore: false });
        if (!opened) return;
      }
    }
    const pane = targetPane || (samePane ? currentPane : activePane());
    const target = anchor ? readerPaneAnchor(pane, anchor) : null;
    if (!target) return;
    const canonicalTargetAnchor = target.dataset.readerCanonicalAnchor || anchor;
    if (samePane || targetPane) {
      const inlineOwned = inlinePanes.has(canonicalKey(provider, session));
      if (samePane && !inlineOwned) {
        savePaneState(pane);
        recordHistory(keyOf(pane), sourceHref);
      } else {
        const record = inlinePanes.get(canonicalKey(provider, session));
        if (record) {
          const inlineUrl = new URL(sourceUrl.href);
          inlineUrl.hash = canonicalTargetAnchor ? `#${canonicalTargetAnchor}` : "";
          const browserState = withInlineHistory(history.state, serializedInlineStack());
          browserState.readerInlineAnchorSession = canonicalKey(provider, session);
          delete browserState.readerEventSession;
          history.pushState(browserState, "", inlineUrl.pathname + inlineUrl.search + inlineUrl.hash);
        }
      }
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
    const targetPane = paneFor(key);
    const intent = { id: ++eventSourceIntent };
    swapRevision += 1;
    inlineRevision += 1;
    let pane = targetPane;
    const promise = (async () => {
      let openedPane = false;
      if (!pane?.isConnected) {
        const opened = await openPane(provider, session, { href: `/${encodeURIComponent(provider)}/session/${encodeURIComponent(session)}`, restore: false, invalidateSources: false });
        if (!opened) return false;
        openedPane = true;
        pane = host.querySelector("[data-reader-pane]");
      }
      if (!pane) return false;
      const isCurrent = () => pane?.isConnected && intent.id === eventSourceIntent;
      if (isCurrent()) setStatus(ft?.("detail.reader_event_loading") || "", "loading");
      const response = await fetch(`/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(session)}/reader/event/${encodeURIComponent(eventId)}`);
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok || !data.evidence) throw new Error(data?.error || `HTTP ${response.status}`);
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
          if (!openedPane && !replay && !inlinePanes.has(key)) savePaneState(pane);
          if (inlinePanes.has(key)) {
            const browserState = withInlineHistory(history.state, serializedInlineStack());
            browserState.readerEventSession = key;
            delete browserState.readerInlineAnchorSession;
            history.pushState(browserState, "", url.pathname + url.search + url.hash);
          } else {
            recordHistory(key, url.pathname + url.search + url.hash, { replace: openedPane || replay });
          }
          updateShell(pane);
          closeReaderCollaboration(link);
          revealAnchor(source);
          dispatch("session-reader:anchor-revealed", { pane, target: source });
        }
      }
      if (isCurrent()) setStatus("");
      return true;
    })().catch((error) => {
      console.error("Unable to load reader event source:", error);
      if (pane?.isConnected && intent.id === eventSourceIntent) {
        const messageKey = error?.code === "source_missing" ? "detail.reader_source_missing" : "detail.reader_event_failed";
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
    history.back();
  });

  window.addEventListener("popstate", async (event) => {
    inlineRevision += 1;
    const inlineState = inlineStackFrom(event.state);
    const current = activePane();
    const hadInline = inlinePanes.size > 0;
    if (inlineState.length || hadInline) {
      const currentPath = location.pathname;
      const rootHref = historyEntries[historyIndex]?.href || "";
      const rootPath = rootHref ? new URL(rootHref, location.href).pathname : currentPath;
      if (inlineState.length || currentPath === rootPath) {
        const savedIndex = event.state?.readerEntry;
        const rootIdentity = event.state?.readerInlineRoot;
        const rootKey = rootIdentity?.provider && rootIdentity?.session
          ? canonicalKey(rootIdentity.provider, rootIdentity.session)
          : "";
        if (inlineState.length && rootKey && keyOf(current) !== rootKey && !paneFor(rootKey)) {
          if (typeof location.reload === "function") location.reload();
          return;
        }
        if (Number.isInteger(savedIndex)) {
          if (!historyEntries[savedIndex]) {
            historyEntries[savedIndex] = {
              key: rootIdentity?.provider && rootIdentity?.session
                ? canonicalKey(rootIdentity.provider, rootIdentity.session)
                : keyOf(current),
              href: inlineHref(),
              state: rootIdentity?.state || null
            };
          }
          historyIndex = savedIndex;
        }
        await applyInlineStack(inlineState, { rootIdentity: rootIdentity || null });
        if (activePane()) {
          updateShell(activePane());
          const eventId = new URLSearchParams(location.search).get("readerEvent");
          const eventKey = event.state?.readerEventSession || "";
          if (eventId && eventKey) {
            const [eventProvider, ...eventSessionParts] = String(eventKey).split("\u0000");
            const source = document.createElement("a");
            source.href = `/${encodeURIComponent(eventProvider)}/session/${encodeURIComponent(eventSessionParts.join("\u0000"))}?readerEvent=${encodeURIComponent(eventId)}`;
            source.dataset.readerProvider = eventProvider;
            source.dataset.readerSession = eventSessionParts.join("\u0000");
            source.dataset.readerEventId = eventId;
            await revealEventSource(source, { replay: true });
          } else if (inlineState.length && location.hash) {
            const hash = decodeURIComponent(location.hash.slice(1));
            const pane = event.state?.readerInlineAnchorSession
              ? paneFor(event.state.readerInlineAnchorSession)
              : [...inlinePanes.values()].map((record) => record.pane).reverse().concat(current)
                .find((candidate) => readerPaneAnchor(candidate, hash));
            const target = readerPaneAnchor(pane, hash);
            if (target) requestAnimationFrame(() => {
              revealAnchor(target);
              dispatch("session-reader:anchor-revealed", { pane, target });
            });
          }
        }
        return;
      }
    }
    const match = location.pathname.match(/^\/([^/]+)\/session\/(.+)$/);
    if (!match) return;
    const provider = decodeURIComponent(match[1]);
    const session = decodeURIComponent(match[2]);
    const key = canonicalKey(provider, session);
    const href = location.pathname + location.search + location.hash;
    eventSourceIntent += 1;
    const revision = ++swapRevision;
    [...inlinePanes.values()].reverse().forEach((record) => removeInlinePane(record.key, { restore: false }));
    savePaneState(activePane(), { captureHref: false });
    try {
      const pane = await fetchPane(provider, session, href);
      if (revision !== swapRevision) return;
      const savedIndex = event.state?.readerEntry;
      if (Number.isInteger(savedIndex) && historyEntries[savedIndex]?.key === key) {
        historyIndex = savedIndex;
        historyEntries[historyIndex].href = href;
      } else {
        historyEntries[historyIndex] = { key, href, state: cache.get(key)?.state };
        history.replaceState({ ...history.state, readerEntry: historyIndex }, "", href);
      }
      cache.get(key).href = href;
      const entry = historyEntries[historyIndex];
      attachPane(pane, key);
      const eventId = new URLSearchParams(location.search).get("readerEvent");
      const hash = location.hash ? decodeURIComponent(location.hash.slice(1)) : "";
      if (eventId && (!hash || !document.getElementById(hash))) {
        const source = document.createElement("a");
        source.href = href;
        source.dataset.readerProvider = provider;
        source.dataset.readerSession = session;
        source.dataset.readerEventId = eventId;
        await revealEventSource(source, { replay: true });
        if (historyEntries[historyIndex] === entry && entry.state) restorePaneState(pane);
      } else if (hash && !historyEntries[historyIndex]?.state) {
        requestAnimationFrame(() => {
          const target = readerPaneAnchor(pane, hash);
          if (target) revealAnchor(target);
        });
      }
    } catch (error) {
      if (revision === swapRevision) {
        setStatus(ft?.("detail.reader_load_failed") || "", "error", href);
      }
    }
  });

  const initial = host.querySelector("[data-reader-pane]");
  if (initial) {
    const key = keyOf(initial);
    normalizeOwnedEvidenceLinks(initial, providerOf(initial), sessionOf(initial));
    cache.set(key, { pane: initial, state: null, href: location.pathname + location.search + location.hash });
    historyEntries.push({ key, href: location.pathname + location.search + location.hash, state: null });
    historyIndex = 0;
    history.scrollRestoration = "manual";
    history.replaceState({ ...history.state, readerEntry: historyIndex }, "", historyEntries[historyIndex].href);
    updateShell(initial);
    setStatus("");
  }
  bindContextResultDisclosures(initial);
  syncCollaborationLayout();
  const initialInlineState = inlineStackFrom(history.state);
  const initialInlineRoot = history.state?.readerInlineRoot || null;
  if (initial && initialInlineState.length && initialInlineRoot?.provider && initialInlineRoot?.session
    && keyOf(initial) === canonicalKey(initialInlineRoot.provider, initialInlineRoot.session)) {
    queueMicrotask(() => void applyInlineStack(initialInlineState, { rootIdentity: initialInlineRoot }));
  }
  const initialEventId = new URLSearchParams(location.search).get("readerEvent");
  if (initialEventId && initial) {
    const sourceLocator = document.createElement("a");
    sourceLocator.href = location.href;
    sourceLocator.dataset.readerProvider = providerOf(initial);
    sourceLocator.dataset.readerSession = sessionOf(initial);
    sourceLocator.dataset.readerEventId = initialEventId;
    queueMicrotask(() => void revealEventSource(sourceLocator, { replay: true }));
  }

  return {
    openPane,
    getActivePane: () => host.querySelector("[data-reader-pane]"),
    getInlinePanes: () => [...inlinePanes.values()].map((record) => record.pane),
    cache
  };
}
