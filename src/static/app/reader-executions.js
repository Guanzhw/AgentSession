import { ft } from "./i18n.js";
import { scopeReaderFragment } from "./reader-pane-dom.js";

const pending = new WeakMap();

/** One local out-and-back bracket; its length follows reading positions, not duration. */
export function executionBracketPath(startX, endX, startY, endY, slot = 0) {
  const x = Math.min(startX, endX) - 12 - slot * 7;
  return `M${startX} ${startY} H${x} V${endY} H${endX} M${endX - 5} ${endY - 4} L${endX} ${endY} L${endX - 5} ${endY + 4}`;
}

export function executionBracketSlots(ids, previous = new Map()) {
  const visible = new Set(ids.slice(0, 4));
  const slots = new Map([...previous].filter(([id]) => visible.has(id)));
  const used = new Set(slots.values());
  for (const id of visible) {
    if (slots.has(id)) continue;
    const slot = [0, 1, 2, 3].find((value) => !used.has(value));
    slots.set(id, slot);
    used.add(slot);
  }
  return slots;
}

function initExecutionInlineLinks(workbench) {
  const contexts = new Map();
  const namespace = "http://www.w3.org/2000/svg";
  let frame = null;
  const schedule = () => { if (frame === null) frame = requestAnimationFrame(draw); };
  const invalidate = () => { for (const context of contexts.values()) context.pairs = null; schedule(); };
  const resize = new ResizeObserver(invalidate);
  const owned = (pane, selector) => [...pane.querySelectorAll(selector)].filter((node) => node.closest("[data-reader-pane]") === pane);

  function sync() {
    for (const [pane, context] of contexts) {
      if (pane.isConnected) continue;
      resize.unobserve(context.surface);
      context.svg.remove();
      contexts.delete(pane);
    }
    for (const pane of workbench.querySelectorAll("[data-reader-pane]")) {
      if (contexts.has(pane) || !owned(pane, "[data-reader-execution-marker]").length) continue;
      const surface = owned(pane, "[data-reader-transcript]")[0];
      if (!surface) continue;
      const svg = document.createElementNS(namespace, "svg");
      svg.classList.add("reader-execution-inline-links");
      svg.setAttribute("aria-hidden", "true");
      surface.append(svg);
      contexts.set(pane, { pane, surface, svg, pairs: null, selected: null, slots: new Map() });
      resize.observe(surface);
    }
    invalidate();
  }

  function measure(context) {
    const area = context.surface.getBoundingClientRect();
    const groups = new Map();
    for (const marker of owned(context.pane, "[data-reader-execution-marker]")) {
      if (!marker.getClientRects().length) continue;
      const id = marker.dataset.readerExecutionMarker;
      const group = groups.get(id) || { id };
      const box = marker.querySelector("header").getBoundingClientRect();
      const point = { x: marker.getBoundingClientRect().left - area.left + 40, y: box.top - area.top + box.height / 2 };
      const phase = marker.dataset.readerExecutionPhase;
      if (phase === "yielded") group.start = point;
      if (phase === "completed" || phase === "failed") group.end = point;
      groups.set(id, group);
    }
    context.pairs = [...groups.values()].filter((pair) => pair.start && pair.end);
  }

  function draw() {
    frame = null;
    for (const context of contexts.values()) {
      if (!context.pane.isConnected) continue;
      if (!context.pairs) measure(context);
      const area = context.surface.getBoundingClientRect();
      const top = Math.max(0, -area.top - window.innerHeight / 2);
      const bottom = Math.min(area.height, -area.top + window.innerHeight * 1.5);
      if (bottom <= top) { context.svg.replaceChildren(); continue; }
      const candidates = context.pairs.filter((pair) => Math.min(pair.start.y, pair.end.y) <= bottom && Math.max(pair.start.y, pair.end.y) >= top);
      const ordered = [...candidates].sort((a, b) => Number(b.id === context.selected) - Number(a.id === context.selected));
      context.slots = executionBracketSlots(ordered.map((pair) => pair.id), context.slots);
      context.svg.style.top = `${top}px`;
      context.svg.setAttribute("width", String(area.width + 40));
      context.svg.setAttribute("height", String(bottom - top));
      const paths = [];
      // Retained pairs keep their lane; newcomers use a free visible slot.
      for (const pair of context.pairs) {
        if (!context.slots.has(pair.id)) continue;
        const path = document.createElementNS(namespace, "path");
        path.setAttribute("d", executionBracketPath(pair.start.x, pair.end.x, pair.start.y - top, pair.end.y - top, context.slots.get(pair.id)));
        path.dataset.readerExecutionConnection = pair.id;
        if (pair.id === context.selected) path.classList.add("is-focused");
        paths.push(path);
      }
      context.svg.replaceChildren(...paths);
    }
  }

  const select = (event) => {
    const marker = event.target.closest?.("[data-reader-execution-marker]");
    const context = marker && contexts.get(marker.closest("[data-reader-pane]"));
    if (!context || event.target.closest("[data-reader-pane]") !== context.pane) return;
    context.selected = marker.dataset.readerExecutionMarker;
    for (const node of owned(context.pane, "[data-reader-execution-marker]")) {
      node.toggleAttribute("data-reader-execution-selected", node.dataset.readerExecutionMarker === context.selected);
    }
    schedule();
  };
  workbench.addEventListener("focusin", select);
  workbench.addEventListener("click", select);
  workbench.addEventListener("toggle", invalidate, true);
  for (const name of ["content-updated", "process-loaded", "inline-opened", "inline-closed", "swapped"]) {
    workbench.addEventListener(`session-reader:${name}`, sync);
  }
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", invalidate);
  document.fonts?.ready.then(invalidate);
  sync();
}

export function loadReaderExecution(detail, cursor = null) {
  if (pending.has(detail)) return pending.get(detail);
  if (!cursor && detail.dataset.readerExecutionLoaded) return Promise.resolve(true);
  const panel = detail.querySelector("[data-reader-execution-panel]");
  const status = detail.querySelector("[data-reader-execution-status]");
  const more = panel.querySelector("[data-reader-execution-more]");
  const task = (async () => {
    detail.setAttribute("aria-busy", "true");
    if (more) more.disabled = true;
    status.textContent = ft("detail.execution_loading");
    try {
      const url = new URL(detail.dataset.readerExecutionUrl, location.href);
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      const data = await response.json();
      if (!response.ok || !data.ok || typeof data.html !== "string") throw new Error(data.code || `HTTP ${response.status}`);
      const wrapper = document.createElement("div");
      wrapper.innerHTML = data.html;
      const host = cursor ? panel.querySelector("[data-reader-execution-steps]") : panel;
      if (cursor) more?.closest("li")?.remove();
      else host.replaceChildren();
      host.append(wrapper);
      scopeReaderFragment(detail.closest("[data-reader-pane]"), wrapper);
      wrapper.replaceWith(...wrapper.childNodes);
      detail.dataset.readerExecutionLoaded = "true";
      status.textContent = "";
      return true;
    } catch (error) {
      status.textContent = ft(error.message === "stale_page" ? "detail.execution_changed" : "detail.execution_load_failed");
      const retry = document.createElement("button");
      retry.type = "button";
      retry.dataset.readerExecutionRetry = error.message === "stale_page" ? "" : cursor || "";
      retry.textContent = ft("detail.reader_coordination_content_retry");
      status.append(retry);
      return false;
    } finally {
      detail.removeAttribute("aria-busy");
      if (more) more.disabled = false;
    }
  })().finally(() => pending.delete(detail));
  pending.set(detail, task);
  return task;
}

export function initReaderExecutions() {
  const workbench = document.querySelector(".session-workbench[data-session-reader]");
  if (!workbench) return;
  initExecutionInlineLinks(workbench);
  workbench.addEventListener("toggle", (event) => {
    if (event.target.matches("[data-reader-execution-detail]") && event.target.open) loadReaderExecution(event.target);
  }, true);
  workbench.addEventListener("click", (event) => {
    const button = event.target.closest("[data-reader-execution-more],[data-reader-execution-retry]");
    if (!button) return;
    const detail = button.closest("[data-reader-execution-detail]");
    const cursor = button.hasAttribute("data-reader-execution-more") ? button.dataset.readerExecutionCursor : button.dataset.readerExecutionRetry;
    if (!cursor) delete detail.dataset.readerExecutionLoaded;
    loadReaderExecution(detail, cursor || null);
  });
}
