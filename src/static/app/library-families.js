// Expand recorded branches without opening transcripts. Keep only navigation
// coordinates in tab storage; rendered provider content stays on the server.
export function initLibraryFamilies(list, { ft, loadMoreSessions, updateBatchCount }) {
  const pending = new WeakMap();
  const stateKey = "as.library.navigation";
  const returnTo = list.dataset.libraryReturn;
  let departureHref = null;

  async function fetchChildren(details) {
    const items = details.querySelector(":scope > [data-family-items]");
    const status = details.querySelector(":scope > [data-family-status]");
    const more = details.querySelector(":scope > [data-family-load]");
    const url = new URL(details.dataset.url, location.origin);
    url.searchParams.set("offset", details.dataset.nextOffset);
    details.setAttribute("aria-busy", "true");
    more.disabled = true;
    status.hidden = false;
    status.textContent = ft("scroll_loading");
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const page = await response.json();
      items.insertAdjacentHTML("beforeend", page.html);
      details.dataset.loadedCount = String(items.children.length);
      details.dataset.nextOffset = page.nextOffset === null ? "" : String(page.nextOffset);
      more.hidden = page.nextOffset === null;
      status.hidden = true;
      updateBatchCount();
      return true;
    } catch {
      status.textContent = ft("library_children_error");
      more.hidden = false;
      return false;
    } finally {
      details.removeAttribute("aria-busy");
      more.disabled = false;
    }
  }

  function loadChildren(details) {
    if (pending.has(details)) return pending.get(details);
    if (details.dataset.nextOffset === "") return Promise.resolve(true);
    const request = fetchChildren(details).finally(() => pending.delete(details));
    pending.set(details, request);
    return request;
  }

  list.addEventListener("toggle", (event) => {
    const details = event.target;
    if (details.matches("[data-library-children]") && details.open && !details.dataset.loadedCount) {
      void loadChildren(details);
    }
    updateBatchCount();
  }, true);
  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-family-load]");
    if (button) void loadChildren(button.closest("[data-library-children]"));
    const link = event.target.closest(".session-card-title-link, .library-family-title");
    if (link && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      // Chromium may clear activeElement before pagehide during navigation.
      departureHref = link.getAttribute("href");
      saveNavigation();
    }
  });

  function saveNavigation() {
    const active = document.activeElement;
    const state = {
      url: returnTo,
      rootCount: list.querySelectorAll("[data-library-family]").length,
      branches: [...list.querySelectorAll("[data-library-children]")]
        .filter((details) => details.open || details.dataset.loadedCount)
        .map((details) => ({ provider: details.dataset.provider, id: details.dataset.sessionId, count: Number(details.dataset.loadedCount) || 0, open: details.open })),
      scrollY: window.scrollY,
      focus: departureHref || (list.contains(active) && active instanceof HTMLAnchorElement ? active.getAttribute("href") : null)
    };
    try { sessionStorage.setItem(stateKey, JSON.stringify(state)); } catch { /* Navigation still works without storage. */ }
  }
  window.addEventListener("pagehide", saveNavigation);

  async function restoreNavigation() {
    let state;
    try { state = JSON.parse(sessionStorage.getItem(stateKey)); } catch { return; }
    if (!state || state.url !== returnTo || !Number.isInteger(state.rootCount)
      || !Number.isFinite(state.scrollY) || !Array.isArray(state.branches)) return;
    if (!state.branches.every((branch) => branch && typeof branch.open === "boolean" && typeof branch.provider === "string" && typeof branch.id === "string"
      && Number.isInteger(branch.count) && branch.count >= 0)) return;
    let roots = list.querySelectorAll("[data-library-family]").length;
    while (loadMoreSessions && roots < state.rootCount) {
      await loadMoreSessions();
      const next = list.querySelectorAll("[data-library-family]").length;
      if (next <= roots) break;
      roots = next;
    }
    // DOM order is parent-first, so each restored page exposes the next branch.
    for (const branch of state.branches) {
      const details = [...list.querySelectorAll("[data-library-children]")]
        .find((entry) => entry.dataset.provider === branch.provider && entry.dataset.sessionId === branch.id);
      if (!details) continue;
      while (Number(details.dataset.loadedCount || 0) < Math.max(1, branch.count) && details.dataset.nextOffset !== "") {
        if (!await loadChildren(details)) break;
      }
      details.open = branch.open;
    }
    const link = [...list.querySelectorAll("a[href]")].find((entry) => entry.getAttribute("href") === state.focus);
    link?.focus({ preventScroll: true });
    window.scrollTo({ top: state.scrollY, behavior: "instant" });
  }
  void restoreNavigation();
}
