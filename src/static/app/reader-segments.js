import { readerPaneAnchor, scopeReaderFragment } from "./reader-pane-dom.js";

const pending = new WeakMap();

const ownedSegments = (pane) => [...pane.querySelectorAll("[data-reader-conversation-segment]")]
  .filter((segment) => segment.closest("[data-reader-pane]") === pane);

const containsAnchor = (segment, anchor) => segment.dataset.readerSegmentAnchors?.split(" ").includes(anchor);

export function loadReaderSegment(segment) {
  if (segment.dataset.readerSegmentState === "loaded") return Promise.resolve(segment);
  if (pending.has(segment)) return pending.get(segment);
  const pane = segment.closest("[data-reader-pane]");
  const button = segment.querySelector("[data-reader-segment-load]");
  const status = segment.querySelector("[data-reader-segment-status]");
  const promise = (async () => {
    segment.dataset.readerSegmentState = "loading";
    segment.setAttribute("aria-busy", "true");
    button.setAttribute("aria-disabled", "true");
    status.textContent = segment.dataset.readerSegmentLoading;
    try {
      const response = await fetch(segment.dataset.readerSegmentUrl, { headers: { Accept: "application/json" } });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok || typeof data.html !== "string"
        || data.index !== Number(segment.dataset.readerSegmentIndex)) {
        const error = new Error(data?.error || `HTTP ${response.status}`);
        error.code = data?.code;
        throw error;
      }
      if (!segment.isConnected || !pane.isConnected) {
        segment.dataset.readerSegmentState = "unloaded";
        status.textContent = "";
        return null;
      }
      const restoreFocus = document.activeElement === button;
      segment.innerHTML = data.html;
      scopeReaderFragment(pane, segment);
      segment.dataset.readerSegmentState = "loaded";
      segment.classList.remove("reader-conversation-segment-placeholder");
      if (restoreFocus) {
        const firstTurn = segment.querySelector(".thread-turn");
        if (firstTurn) {
          firstTurn.tabIndex = -1;
          firstTurn.focus({ preventScroll: true });
          firstTurn.addEventListener("blur", () => firstTurn.removeAttribute("tabindex"), { once: true });
        }
      }
      segment.dispatchEvent(new CustomEvent("session-reader:segment-loaded", { bubbles: true, detail: { pane } }));
      return segment;
    } catch (error) {
      segment.dataset.readerSegmentState = "error";
      button.disabled = error.code === "stale_segment";
      status.textContent = error.code === "stale_segment" ? segment.dataset.readerSegmentChanged : segment.dataset.readerSegmentFailed;
      throw error;
    } finally {
      segment.removeAttribute("aria-busy");
      button.removeAttribute("aria-disabled");
    }
  })();
  const tracked = promise.finally(() => pending.delete(segment));
  pending.set(segment, tracked);
  return tracked;
}

export async function ensureReaderSegmentAnchor(pane, canonicalAnchor) {
  const present = readerPaneAnchor(pane, canonicalAnchor);
  if (present) return present;
  const segments = ownedSegments(pane);
  let segment = segments.find((item) => containsAnchor(item, canonicalAnchor));
  if (!segment && segments.some((item) => item.dataset.readerSegmentState !== "loaded")) {
    const provider = pane.dataset.readerProvider;
    const session = pane.dataset.readerSession;
    const url = `/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(session)}/reader/segment-location?anchor=${encodeURIComponent(canonicalAnchor)}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await response.json().catch(() => null);
    if (response.status === 404) return null;
    if (!response.ok || !data?.ok || !Number.isInteger(data.index)) throw new Error(data?.error || `HTTP ${response.status}`);
    segment = segments.find((item) => Number(item.dataset.readerSegmentIndex) === data.index);
  }
  if (!segment || !await loadReaderSegment(segment)) return null;
  return readerPaneAnchor(pane, canonicalAnchor);
}

export function initReaderSegments(workbench) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      void loadReaderSegment(entry.target).catch(() => {});
    }
  }, { rootMargin: "400px" });
  const observeNext = (pane) => {
    if (!pane) return;
    const next = ownedSegments(pane).find((segment) => segment.dataset.readerSegmentState === "unloaded");
    if (next) observer.observe(next);
  };
  for (const pane of workbench.querySelectorAll("[data-reader-pane]")) observeNext(pane);
  workbench.addEventListener("session-reader:segment-loaded", (event) => observeNext(event.detail?.pane));
  workbench.addEventListener("session-reader:inline-opened", (event) => observeNext(event.detail?.pane));
  workbench.addEventListener("session-reader:swapped", (event) => observeNext(event.detail?.pane || workbench.querySelector("[data-reader-pane]")));
  workbench.addEventListener("session-reader:inline-closed", (event) => {
    for (const segment of ownedSegments(event.detail?.pane)) observer.unobserve(segment);
  });
  workbench.addEventListener("click", (event) => {
    const button = event.target.closest("[data-reader-segment-load]");
    if (!button) return;
    const segment = button.closest("[data-reader-conversation-segment]");
    if (segment) void loadReaderSegment(segment).catch(() => {});
  });
}
