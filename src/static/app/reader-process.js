import { readerPaneAnchor, scopeReaderFragment } from "./reader-pane-dom.js";

const pendingChunks = new WeakMap();

/** Manual expansion and source/search navigation share the same chunk load. */
export function loadReaderProcess(chunk) {
  if (chunk.dataset.readerProcessState === "loaded") return Promise.resolve(chunk);
  if (pendingChunks.has(chunk)) return pendingChunks.get(chunk);
  const pane = chunk.closest("[data-reader-pane]");
  const button = chunk.querySelector("[data-reader-process-load]");
  const status = chunk.querySelector("[data-reader-process-status]");
  const idleLabel = button.textContent;
  const promise = (async () => {
    chunk.dataset.readerProcessState = "loading";
    chunk.setAttribute("aria-busy", "true");
    button.setAttribute("aria-disabled", "true");
    button.textContent = button.dataset.loadingLabel;
    status.textContent = "";
    try {
      const response = await fetch(chunk.dataset.readerProcessUrl, { headers: { Accept: "application/json" } });
      const data = await response.json();
      if (!response.ok || !data?.ok || typeof data.html !== "string") {
        const error = new Error(data?.error || `HTTP ${response.status}`);
        error.code = data?.code;
        throw error;
      }
      if (!chunk.isConnected || !pane.isConnected) return null;
      const restoreFocus = document.activeElement === button;
      chunk.innerHTML = data.html;
      scopeReaderFragment(pane, chunk);
      chunk.dataset.readerProcessState = "loaded";
      if (restoreFocus) chunk.querySelector("summary")?.focus({ preventScroll: true });
      // Source content has not changed. Invalidate layout/anchor caches without
      // restarting a full-text search that is currently revealing this chunk.
      chunk.dispatchEvent(new CustomEvent("session-reader:process-loaded", { bubbles: true, detail: { pane } }));
      return chunk;
    } catch (error) {
      chunk.dataset.readerProcessState = "error";
      button.textContent = button.dataset.retryLabel;
      status.textContent = button.dataset.loadError;
      throw error;
    } finally {
      chunk.removeAttribute("aria-busy");
      button.removeAttribute("aria-disabled");
      if (chunk.dataset.readerProcessState === "loading") {
        chunk.dataset.readerProcessState = "unloaded";
        button.textContent = idleLabel;
      }
    }
  })();
  const tracked = promise.finally(() => pendingChunks.delete(chunk));
  pendingChunks.set(chunk, tracked);
  return tracked;
}

export async function ensureReaderAnchor(pane, canonicalAnchor) {
  const anchor = readerPaneAnchor(pane, canonicalAnchor);
  const chunk = anchor?.closest("[data-reader-process-chunk]");
  if (!chunk || chunk.dataset.readerProcessState === "loaded") return anchor;
  if (!await loadReaderProcess(chunk)) return null;
  return readerPaneAnchor(pane, canonicalAnchor);
}

export function initReaderProcesses(workbench) {
  workbench.addEventListener("toggle", (event) => {
    const group = event.target;
    if (!group.matches("details[data-reader-process-group]") || !group.open) return;
    const chunks = [...group.querySelectorAll("[data-reader-process-chunk]")];
    if (chunks.some((chunk) => ["loaded", "loading"].includes(chunk.dataset.readerProcessState))) return;
    if (chunks[0]) void loadReaderProcess(chunks[0]).catch(() => {});
  }, true);
  workbench.addEventListener("click", (event) => {
    const button = event.target.closest("[data-reader-process-load]");
    if (!button) return;
    const chunk = button.closest("[data-reader-process-chunk]");
    void loadReaderProcess(chunk).catch(() => {});
  });
}
