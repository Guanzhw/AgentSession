import { readerPaneAnchor } from "./reader-pane-dom.js";
import { ft, formatText } from "./i18n.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_LANES = 4;
const MAX_EDGES = 80;
const RAIL_WIDTH = 216;
const LANE_X = [30, 82, 134, 186];

export function readerRailIntersectsBand(start, end, top, bottom) {
  return Math.min(start, end) <= bottom && Math.max(start, end) >= top;
}

export function readerRailTrackSegments(first, last, top, bottom) {
  if (first > bottom || last < top) return null;
  return [Math.max(first, top), Math.min(last, bottom)];
}

export function readerRailEdgePriority(start, end, top, bottom) {
  const endpoints = [start, end].filter((value) => value !== undefined);
  if (!endpoints.length) return Infinity;
  if (endpoints.some((value) => value >= top && value <= bottom)) return 0;
  if (endpoints.length === 2 && readerRailIntersectsBand(start, end, top, bottom)) return 1;
  return 2 + Math.min(...endpoints.map((value) => Math.abs(value - (top + bottom) / 2)));
}

/** Existing members keep physical slots; only newcomers take a vacated slot. */
export function readerRailSlots(candidates, previous = new Map()) {
  const chosen = new Set(candidates.slice(0, MAX_LANES));
  const slots = new Map([...previous].filter(([id]) => chosen.has(id)));
  const occupied = new Set(slots.values());
  for (const id of chosen) {
    if (slots.has(id)) continue;
    const slot = LANE_X.findIndex((_, index) => !occupied.has(index));
    slots.set(id, slot);
    occupied.add(slot);
  }
  return slots;
}

const owned = (pane, selector) => [...pane.querySelectorAll(selector)]
  .filter((element) => element.closest("[data-reader-pane]") === pane);

function svgNode(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function pointLabel(edge, memberById, received) {
  const actor = (id) => id === "main" ? ft("reader_rails_main") : memberById.get(id)?.name || id;
  const from = actor(edge.from);
  const to = actor(edge.to);
  const key = received ? "reader_rails_received" : edge.kind === "create" ? "reader_rails_created" : "reader_rails_sent";
  return formatText(ft(key), { from, to });
}

/** A pane owns its own rail, including when that pane is opened inline. */
export function initReaderMemberRails() {
  const workbench = document.querySelector(".session-workbench[data-session-reader]");
  if (!workbench) return;

  const contexts = new Map();
  let nextRailId = 0;
  const wide = window.matchMedia("(min-width: 1100px)");
  let frame = null;
  const resizeObserver = new ResizeObserver(() => invalidateAll());

  function schedule() {
    if (frame === null && contexts.size) frame = requestAnimationFrame(draw);
  }

  function invalidate(context) {
    context.geometry = null;
    schedule();
  }

  function invalidateAll() {
    for (const context of contexts.values()) context.geometry = null;
    schedule();
  }

  function attachPane(pane) {
    if (!pane || contexts.has(pane)) return;
    const script = owned(pane, "script[data-reader-member-rails-data]")[0];
    const controls = owned(pane, "[data-reader-member-rails-controls]")[0];
    const surface = owned(pane, "[data-reader-transcript]")[0];
    if (!script || !controls || !surface) return;
    let data;
    try { data = JSON.parse(script.textContent); }
    catch (error) { console.error("Unable to read member rails:", error); return; }
    if (!data?.members?.length || !data.owner || !Array.isArray(data.points) || !Array.isArray(data.edges)) return;
    const toggle = controls.querySelector("[data-reader-member-rails-toggle]");
    const select = controls.querySelector("[data-reader-member-rails-select]");
    if (!toggle || !select) return;
    const layer = document.createElement("div");
    layer.className = "reader-member-rails-layer";
    layer.dataset.readerMemberRailsLayer = "";
    layer.setAttribute("aria-label", ft("reader_rails_navigation"));
    const svg = svgNode("svg", { role: "group", "aria-label": ft("reader_rails_navigation") });
    const hitLayer = document.createElement("div");
    hitLayer.className = "reader-member-rails-hit-layer";
    const labelLayer = document.createElement("div");
    labelLayer.className = "reader-member-rails-label-layer";
    layer.append(svg, hitLayer, labelLayer);
    surface.append(layer);
    const memberById = new Map(data.members.map((member) => [member.id, member]));
    const points = new Map(data.points.map((point) => [point.id, point]));
    const edgeById = new Map(data.edges.map((edge) => [edge.id, edge]));
    const context = { pane, surface, controls, toggle, select, layer, svg, hitLayer, labelLayer, data, points, memberById, edgeById,
      uid: ++nextRailId, geometry: null, intent: null, decorated: new Set(), focusButtons: new Map(), slots: new Map(), linkNodes: new Map() };
    contexts.set(pane, context);
    decorate(context);
    controls.hidden = false;
    surface.dataset.readerMemberRailsActive = String(toggle.checked && wide.matches);
    resizeObserver.observe(surface);
    resizeObserver.observe(controls);
    schedule();
  }

  function detachPane(pane) {
    const context = contexts.get(pane);
    if (!context) return;
    resizeObserver.unobserve(context.surface);
    resizeObserver.unobserve(context.controls);
    for (const element of context.decorated) {
      delete element.dataset.readerMemberRailsEvent;
      delete element.dataset.readerMemberRailsShown;
      element.style.removeProperty("--member-rail-event-color");
    }
    for (const button of context.focusButtons.values()) button.remove();
    context.layer.remove();
    delete context.surface.dataset.readerMemberRailsActive;
    contexts.delete(pane);
    if (!contexts.size && frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
  }

  function detachAll() {
    for (const pane of contexts.keys()) detachPane(pane);
  }

  function attachAll() {
    for (const pane of workbench.querySelectorAll("[data-reader-pane]")) attachPane(pane);
  }

  function decorate(context) {
    const milestones = new Map(owned(context.pane, "[data-reader-milestone][data-reader-observation-id]")
      .filter((element) => context.surface.contains(element))
      .map((element) => [element.dataset.readerObservationId, element]));
    for (const [pointId, button] of context.focusButtons) {
      if (milestones.get(pointId)?.contains(button)) continue;
      button.remove();
      context.focusButtons.delete(pointId);
    }
    const memberForPoint = new Map();
    const edgeForPoint = new Map();
    for (const edge of context.data.edges) {
      memberForPoint.set(edge.start, edge.from === "main" ? edge.to : edge.from);
      memberForPoint.set(edge.end, edge.to === "main" ? edge.from : edge.to);
      edgeForPoint.set(edge.start, edge);
      edgeForPoint.set(edge.end, edge);
    }
    for (const [pointId, memberId] of memberForPoint) {
      const milestone = milestones.get(pointId);
      const member = context.memberById.get(memberId);
      if (!milestone || !member) continue;
      milestone.dataset.readerMemberRailsEvent = "";
      if (context.toggle.checked && wide.matches) milestone.dataset.readerMemberRailsShown = "";
      else delete milestone.dataset.readerMemberRailsShown;
      milestone.style.setProperty("--member-rail-event-color", `var(--reader-member-color-${member.color})`);
      context.decorated.add(milestone);
      if (context.focusButtons.has(pointId)) continue;
      const body = milestone.querySelector(":scope > .reader-milestone-body");
      if (!body) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "reader-member-rails-focus";
      button.dataset.readerMemberRailFocus = memberId;
      button.dataset.readerMemberRailEdge = edgeForPoint.get(pointId).id;
      button.textContent = ft("reader_rails_focus");
      button.setAttribute("aria-label", formatText(ft("reader_rails_focus_member"), { member: member.name }));
      button.hidden = true;
      body.append(button);
      context.focusButtons.set(pointId, button);
    }
    for (const milestone of context.decorated) {
      if (context.surface.contains(milestone)) continue;
      context.decorated.delete(milestone);
    }
  }

  // Only mounted milestone nodes are measured. The process placeholder owns
  // milestone anchors while its detail is still lazy, so absent anchors stay absent.
  function measure(context) {
    decorate(context);
    const { pane, surface } = context;
    const surfaceRect = surface.getBoundingClientRect();
    const milestoneById = new Map(owned(pane, "[data-reader-milestone][data-reader-observation-id]")
      .filter((element) => surface.contains(element))
      .map((element) => [element.dataset.readerObservationId, element]));
    const positions = new Map();
    for (const point of context.data.points) {
      const milestone = milestoneById.get(point.id);
      const element = milestone?.dataset.readerCanonicalAnchor === point.anchor || milestone?.id === point.anchor
        ? milestone : readerPaneAnchor(pane, point.anchor);
      if (!element || !surface.contains(element)) continue;
      let visible = element;
      for (let parent = element.parentElement; parent && parent !== surface; parent = parent.parentElement) {
        if (parent.matches("details:not([open])")) visible = parent.querySelector(":scope > summary") || visible;
      }
      if (visible.closest("[data-reader-pane]") !== pane) continue;
      const rect = visible.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      positions.set(point.id, { y: rect.top - surfaceRect.top + Math.min(rect.height / 2, 18), element });
    }
    const memberSpan = new Map();
    for (const point of context.data.points) {
      const y = positions.get(point.id)?.y;
      if (y === undefined) continue;
      for (const id of [point.from, point.to]) {
        if (!context.memberById.has(id)) continue;
        const span = memberSpan.get(id);
        if (span) { span.first = Math.min(span.first, y); span.last = Math.max(span.last, y); }
        else memberSpan.set(id, { first: y, last: y });
      }
    }
    context.geometry = { positions, memberSpan, height: surface.offsetHeight };
  }

  function makeLink(context, key, point, label, x, y, received, color) {
    const { owner } = context.data;
    const href = `/${encodeURIComponent(owner.provider)}/session/${encodeURIComponent(owner.sessionId)}#${encodeURIComponent(point.anchor)}`;
    const link = context.linkNodes.get(key) || document.createElement("a");
    link.href = href;
    link.dataset.readerSource = "";
    link.dataset.readerProvider = owner.provider;
    link.dataset.readerSession = owner.sessionId;
    link.dataset.readerAnchor = point.anchor;
    link.dataset.readerMemberRailPoint = point.id;
    link.className = `reader-member-rails-hit${received ? " is-received" : ""}`;
    link.setAttribute("aria-label", label);
    link.title = label;
    link.style.left = `${x}px`;
    link.style.top = `${y}px`;
    link.style.setProperty("--member-rail-color", color);
    return link;
  }

  function drawPane(context) {
    const { surface, layer, data, select, toggle, memberById, points } = context;
    const active = String(toggle.checked && wide.matches);
    if (surface.dataset.readerMemberRailsActive !== active) {
      surface.dataset.readerMemberRailsActive = active;
      for (const milestone of context.decorated) {
        if (active === "true") milestone.dataset.readerMemberRailsShown = "";
        else delete milestone.dataset.readerMemberRailsShown;
      }
      context.geometry = null;
    }
    if (!toggle.checked || !wide.matches) {
      for (const button of context.focusButtons.values()) button.hidden = true;
      return;
    }
    if (!context.geometry) measure(context);
    let { positions, memberSpan, height } = context.geometry;
    let surfaceTop = surface.getBoundingClientRect().top;
    let bandTop = Math.max(0, -surfaceTop - window.innerHeight * .65);
    let bandBottom = Math.min(height, -surfaceTop + window.innerHeight * 1.65);
    if (bandBottom <= bandTop) return;
    const selected = select.value;
    const focusedEdge = context.edgeById.get(context.focusEdge);
    const pinned = focusedEdge ? [focusedEdge.from, focusedEdge.to].filter((id) => id !== "main") : selected ? [selected] : [];
    const scores = new Map();
    const edgeScores = new Map();
    const viewportTop = Math.max(0, -surfaceTop);
    const viewportBottom = Math.min(height, viewportTop + window.innerHeight);
    for (const edge of data.edges) {
      const start = positions.get(edge.start)?.y;
      const end = positions.get(edge.end)?.y;
      if (start === undefined && end === undefined) continue;
      const nearest = readerRailEdgePriority(start, end, viewportTop, viewportBottom);
      edgeScores.set(edge.id, nearest);
      for (const id of [edge.from, edge.to]) {
        if (id !== "main" && memberById.has(id) && (!scores.has(id) || nearest < scores.get(id))) scores.set(id, nearest);
      }
    }
    const nearby = [...scores].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    context.slots = readerRailSlots([...pinned, ...nearby.filter((id) => !pinned.includes(id))], context.slots);
    const visible = new Set(context.slots.keys());
    const lanes = data.members.filter((member) => visible.has(member.id));
    const laneX = new Map([...context.slots].map(([id, slot]) => [id, LANE_X[slot]]));
    const svg = context.svg;
    svg.setAttribute("viewBox", `0 0 ${RAIL_WIDTH} ${bandBottom - bandTop}`);
    const defs = svgNode("defs");
    for (const color of new Set(lanes.map((member) => member.color))) {
      const marker = svgNode("marker", { id: `reader-member-arrow-${context.uid}-${color}`,
        viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto", markerUnits: "strokeWidth" });
      marker.append(svgNode("path", { d: "M 1 1 L 9 5 L 1 9", fill: "none", stroke: "currentColor", "stroke-width": 1.6 }));
      marker.style.color = `var(--reader-member-color-${color})`;
      defs.append(marker);
    }
    const paths = [defs];
    const labels = [];
    for (const member of lanes) {
      const span = memberSpan.get(member.id);
      if (!span) continue;
      const segments = readerRailTrackSegments(span.first, span.last, bandTop, bandBottom);
      if (!segments) continue;
      const x = laneX.get(member.id);
      const group = svgNode("g", { class: "reader-member-rails-lane" });
      group.style.color = `var(--reader-member-color-${member.color})`;
      group.append(svgNode("path", {
        d: `M ${x} ${segments[0] - bandTop} V ${segments[1] - bandTop}`,
        class: "reader-member-rails-track" }));
      paths.push(group);
      const label = document.createElement("div");
      label.className = "reader-member-rails-label";
      label.style.setProperty("--member-rail-color", `var(--reader-member-color-${member.color})`);
      label.style.left = `${x}px`;
      label.style.top = `${Math.max(0, Math.max(span.first - bandTop - 42, -surfaceTop + 72 - bandTop) + (context.slots.get(member.id) % 2 * 24))}px`;
      label.textContent = member.name.startsWith("/") ? member.name.split("/").filter(Boolean).at(-1) : member.name;
      label.title = member.purpose ? `${member.name}: ${member.purpose}` : member.name;
      labels.push(label);
    }
    let drawn = 0;
    const drawnEdges = new Set();
    const hits = new Map();
    const prioritizedEdges = [...data.edges].sort((left, right) =>
      (left.id === context.focusEdge ? -1 : edgeScores.get(left.id) ?? Infinity) -
      (right.id === context.focusEdge ? -1 : edgeScores.get(right.id) ?? Infinity));
    for (const edge of prioritizedEdges) {
      if (drawn >= MAX_EDGES) break;
      if ((edge.from !== "main" && !visible.has(edge.from)) || (edge.to !== "main" && !visible.has(edge.to))) continue;
      const start = positions.get(edge.start), end = positions.get(edge.end);
      if (!start || !end || !readerRailIntersectsBand(start.y, end.y, bandTop, bandBottom)) continue;
      const fromX = edge.from === "main" ? 0 : laneX.get(edge.from);
      const toX = edge.to === "main" ? 0 : laneX.get(edge.to);
      if (fromX === undefined || toX === undefined) continue;
      const startPoint = points.get(edge.start), endPoint = points.get(edge.end);
      if (!startPoint || !endPoint) continue;
      const owner = memberById.get(edge.from === "main" ? edge.to : edge.from);
      const color = `var(--reader-member-color-${owner.color})`;
      const group = svgNode("g", { class: "reader-member-rails-edge" });
      group.style.color = color;
      const a = start.y - bandTop, b = end.y - bandTop;
      const mid = (fromX + toX) / 2;
      const path = edge.start === edge.end
        ? `M ${fromX} ${a} H ${toX}`
        : `M ${fromX} ${a} C ${mid} ${a}, ${mid} ${b}, ${toX} ${b}`;
      group.append(svgNode("path", { d: path, class: "reader-member-rails-connector",
        "marker-end": `url(#reader-member-arrow-${context.uid}-${owner.color})` }));
      if ((!edge.received || edge.start !== edge.end) && start.y >= bandTop && start.y <= bandBottom) {
        const key = `${edge.id}:from`;
        hits.set(key, makeLink(context, key, startPoint, pointLabel(edge, memberById, false), fromX, a, false, color));
      }
      const receivingMember = memberById.get(edge.to);
      const receiptColor = receivingMember ? `var(--reader-member-color-${receivingMember.color})` : color;
      if (end.y >= bandTop && end.y <= bandBottom) {
        if (edge.received) {
          const key = `${edge.id}:to`;
          hits.set(key, makeLink(context, key, endPoint, pointLabel(edge, memberById, true), toX, b, true, receiptColor));
        } else if (edge.kind === "create" && toX !== fromX) {
          const key = `${edge.id}:to`;
          hits.set(key, makeLink(context, key, endPoint, pointLabel(edge, memberById, false), toX, b, false, color));
        }
      }
      paths.push(group);
      drawnEdges.add(edge.id);
      drawn++;
    }
    for (const button of context.focusButtons.values()) {
      const edge = context.edgeById.get(button.dataset.readerMemberRailEdge);
      button.hidden = !edge || (drawnEdges.has(edge.id) && document.activeElement !== button);
    }
    layer.style.top = `${bandTop}px`;
    layer.style.height = `${bandBottom - bandTop}px`;
    svg.replaceChildren(...paths);
    for (const [key, link] of context.linkNodes) {
      if (hits.has(key)) continue;
      if (document.activeElement === link) {
        // Keep the focused source link mounted while it scrolls out of the drawn band.
        const y = positions.get(link.dataset.readerMemberRailPoint)?.y;
        if (y !== undefined) link.style.top = `${y - bandTop}px`;
        hits.set(key, link);
      } else link.remove();
    }
    for (const link of hits.values()) if (!link.isConnected) context.hitLayer.append(link);
    context.linkNodes = hits;
    context.labelLayer.replaceChildren(...labels);
  }

  function draw() {
    frame = null;
    for (const context of contexts.values()) {
      if (!context.pane.isConnected) { detachPane(context.pane); continue; }
      drawPane(context);
    }
  }

  function navigatePoint(context, point) {
    context.intent = point.id;
    const link = context.layer.querySelector(`[data-reader-member-rail-point="${CSS.escape(point.id)}"]`);
    if (link) { link.click(); return; }
    const { owner } = context.data;
    const temporary = document.createElement("a");
    temporary.href = `/${encodeURIComponent(owner.provider)}/session/${encodeURIComponent(owner.sessionId)}#${encodeURIComponent(point.anchor)}`;
    temporary.dataset.readerSource = "";
    temporary.dataset.readerProvider = owner.provider;
    temporary.dataset.readerSession = owner.sessionId;
    temporary.dataset.readerAnchor = point.anchor;
    // A source link must have an owning pane even when its rail node is outside the local viewport.
    context.controls.append(temporary);
    temporary.click();
    temporary.remove();
  }

  workbench.addEventListener("click", (event) => {
    const focus = event.target.closest?.("[data-reader-member-rail-focus]");
    if (focus) {
      const context = contexts.get(focus.closest("[data-reader-pane]"));
      if (context) {
        context.select.value = focus.dataset.readerMemberRailFocus;
        context.focusEdge = focus.dataset.readerMemberRailEdge;
        schedule();
      }
      return;
    }
    const link = event.target.closest?.("[data-reader-member-rail-point]");
    if (!link) return;
    const context = contexts.get(link.closest("[data-reader-pane]"));
    if (context && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) context.intent = link.dataset.readerMemberRailPoint;
  }, true);
  workbench.addEventListener("change", (event) => {
    const controls = event.target.closest?.("[data-reader-member-rails-controls]");
    const context = contexts.get(controls?.closest("[data-reader-pane]"));
    if (!context) return;
    if (event.target === context.select) context.focusEdge = null;
    if (event.target === context.select && context.select.value) {
      const first = context.data.points.find((point) => point.from === context.select.value || point.to === context.select.value);
      if (first) navigatePoint(context, first);
    }
    if (event.target === context.toggle) invalidate(context);
    else schedule();
  });
  workbench.addEventListener("focusout", (event) => {
    if (event.target.matches?.("[data-reader-member-rail-focus]")) schedule();
  });
  workbench.addEventListener("session-reader:anchor-revealed", (event) => {
    const context = contexts.get(event.detail?.pane);
    if (!context?.intent) return;
    const point = context.points.get(context.intent);
    context.intent = null;
    if (!point || !event.detail.target || !context.surface.contains(event.detail.target)) return;
    const target = readerPaneAnchor(context.pane, point.anchor);
    if (!target || target !== event.detail.target) return;
    target.querySelector(".reader-coordination-exchange")?.setAttribute("open", "");
    target.classList.add("reader-member-rails-focused");
    window.setTimeout(() => target.classList.remove("reader-member-rails-focused"), 1400);
    invalidate(context);
  });
  workbench.addEventListener("toggle", (event) => {
    const context = contexts.get(event.target.closest?.("[data-reader-pane]"));
    if (context) invalidate(context);
  }, true);
  for (const name of ["content-updated", "process-loaded"]) {
    workbench.addEventListener(`session-reader:${name}`, (event) => {
      const pane = event.detail?.pane;
      if (pane) { attachPane(pane); const context = contexts.get(pane); if (context) invalidate(context); }
    });
  }
  workbench.addEventListener("session-reader:inline-opened", (event) => attachPane(event.detail?.pane));
  workbench.addEventListener("session-reader:inline-closed", (event) => detachPane(event.detail?.pane));
  workbench.addEventListener("session-reader:before-swap", detachAll);
  workbench.addEventListener("session-reader:swapped", attachAll);
  window.addEventListener("resize", invalidateAll);
  wide.addEventListener("change", invalidateAll);
  window.addEventListener("scroll", schedule, { passive: true });
  document.fonts?.ready.then(invalidateAll);
  attachAll();
}
