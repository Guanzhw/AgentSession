import { t } from "../i18n.js";
import { escapeHtml } from "../markdown.js";
import type { SessionProtocol } from "../providers/shared/session-protocol.js";
import { publicEvent } from "../protocol-runtime.js";

type RuntimeData = {
  protocol: SessionProtocol | null;
  summary: any;
  graph?: any;
  eventNextCursor?: string | null;
  storageDiagnostic?: any;
  runtimeError?: any;
};

function jsonScript(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function count(value: unknown) {
  return (Number(value) || 0).toLocaleString();
}

function dateTime(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? new Date(number).toISOString() : "";
}

function timeLabel(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? new Date(number).toLocaleString() : t("runtime.unknown_time");
}

function statusClass(value: unknown) {
  return String(value || "unknown").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
}

function provenanceLabel(provenance: any) {
  if (!provenance || typeof provenance !== "object") return t("runtime.provenance_unknown");
  const source = [provenance.fidelity, provenance.sourceType, provenance.sourceId].filter(Boolean).join(" · ");
  return source || t("runtime.provenance_unknown");
}

function evidenceButton(kind: string, id: string, label = "") {
  return `<button type="button" class="runtime-evidence-trigger" data-runtime-evidence-kind="${escapeHtml(kind)}" data-runtime-evidence-id="${escapeHtml(id)}" aria-label="${escapeHtml(label || t("runtime.evidence_open"))}">${escapeHtml(label || t("runtime.evidence"))}</button>`;
}

function renderCapability(name: string, descriptor: any) {
  const support = descriptor?.support || "none";
  const fidelity = descriptor?.provenance || "derived";
  return `<li class="runtime-capability runtime-capability-${escapeHtml(support)}"><span>${escapeHtml(name)}</span><strong>${escapeHtml(support)}</strong><small>${escapeHtml(fidelity)}</small></li>`;
}

function finiteTime(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function entityLabel(value: any, fallback: string) {
  return value?.title || value?.agentPath || value?.agent || value?.model || fallback;
}

function contextCheckpointGroups(events: any[], artifacts: any[]) {
  const exactGroups = new Map<string, { timestamp: number | null; events: any[]; artifacts: any[] }>();
  const resultTimestamp = (group: { timestamp: number | null; events: any[]; artifacts: any[] }) => {
    const compactedAt = group.events
      .filter((event) => event.compaction)
      .map((event) => finiteTime(event.timestamp))
      .find((timestamp) => timestamp !== null);
    const observedTimes = [
      ...group.events.map((event) => finiteTime(event.timestamp)),
      ...group.artifacts.map((artifact) => finiteTime(artifact.timeCreated))
    ].filter((timestamp): timestamp is number => timestamp !== null);
    return compactedAt ?? (observedTimes.length ? Math.max(...observedTimes) : null);
  };
  const operationIdentity = (value: any) => {
    const candidates = [
      value?.correlationId,
      value?.metadata?.compactionId,
      value?.lineageId,
      value?.provenance?.sourceId
    ];
    const identity = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
    return identity ? `operation:${identity}` : null;
  };
  const groupFor = (timestamp: unknown, fallbackIdentity: string, operation: string | null) => {
    const value = finiteTime(timestamp);
    const key = operation || (value === null ? `unknown:${fallbackIdentity}` : `time:${value}`);
    const group = exactGroups.get(key) || { timestamp: value, events: [], artifacts: [] };
    if (group.timestamp === null || (value !== null && value < group.timestamp)) group.timestamp = value;
    exactGroups.set(key, group);
    return group;
  };
  events.forEach((event) => groupFor(event.timestamp, `event:${event.id}`, operationIdentity(event)).events.push(event));
  artifacts.forEach((artifact) => groupFor(artifact.timeCreated, `artifact:${artifact.id}`, operationIdentity(artifact)).artifacts.push(artifact));
  for (const group of exactGroups.values()) {
    group.timestamp = resultTimestamp(group);
  }
  const ordered = [...exactGroups.values()].sort((left, right) => (left.timestamp ?? Number.MAX_SAFE_INTEGER) - (right.timestamp ?? Number.MAX_SAFE_INTEGER));
  const checkpoints: typeof ordered = [];
  for (const group of ordered) {
    const previous = checkpoints.at(-1);
    const kinds = new Set(group.events.map((event) => event.normalizedKind || event.kind));
    const previousKinds = new Set(previous?.events.map((event) => event.normalizedKind || event.kind) || []);
    const joinsCompactionArtifact = previous !== undefined && (
      (previous.artifacts.length > 0 && previous.events.length === 0 && group.events.some((event) => event.compaction))
      || (group.artifacts.length > 0 && group.events.length === 0 && previous.events.some((event) => event.compaction))
    );
    const sameObservedMoment = previous !== undefined && previous.timestamp !== null && group.timestamp !== null
      && group.timestamp - previous.timestamp <= 250
      && ([...kinds].some((kind) => previousKinds.has(kind)) || joinsCompactionArtifact);
    if (previous && sameObservedMoment) {
      previous.events.push(...group.events);
      previous.artifacts.push(...group.artifacts);
      previous.timestamp = resultTimestamp(previous);
    } else {
      checkpoints.push(group);
    }
  }
  return checkpoints;
}

function renderRuntimeMap(data: RuntimeData) {
  const protocol = data.protocol;
  if (!protocol) return `<p class="runtime-empty">${escapeHtml(t("runtime.unavailable"))}</p>`;
  const events = (protocol.events || [])
    .filter((event) => event.category !== "message" && event.category !== "reasoning" && event.category !== "context")
    .slice(-32);
  const tasks = (protocol.tasks || []).slice(-40);
  const runs = (protocol.agentRuns || []).slice(-40);
  const relationships = (protocol.relationships || []).slice(-32);
  const contextEvents = (protocol.events || []).filter((event) => event.category === "context").slice(-32);
  const artifacts = (protocol.contextArtifacts || []).slice(-32);
  const checkpoints = contextCheckpointGroups(contextEvents, artifacts);
  const allTimes = [
    ...events.map((event) => event.timestamp), ...tasks.flatMap((task) => [task.timeCreated, task.timeCompleted]),
    ...runs.flatMap((run) => [run.timeStart, run.timeEnd]), ...relationships.map((relationship) => relationship.timestamp),
    ...contextEvents.map((event) => event.timestamp), ...artifacts.map((artifact) => artifact.timeCreated)
  ].map(finiteTime).filter((value): value is number => value !== null);
  const bounds = allTimes.length ? { start: Math.min(...allTimes), end: Math.max(...allTimes) } : null;
  const span = bounds ? bounds.end - bounds.start : 0;
  const marker = (kind: string, label: string, timestamp: unknown, status: string | null, detail: string) => {
    const time = finiteTime(timestamp);
    const positioned = time !== null && bounds && span > 0;
    const left = positioned ? ((time - bounds.start) / span) * 100 : time !== null && bounds ? 50 : null;
    const shift = left === null ? null : left < 15 ? "0%" : left > 85 ? "-100%" : "-50%";
    const statusMarkup = status ? `<span class="runtime-map-status runtime-status-${escapeHtml(statusClass(status))}">${escapeHtml(status)}</span>` : "";
    return `<span class="runtime-map-marker runtime-map-marker-${escapeHtml(kind)}${left === null ? " runtime-map-marker-unpositioned" : ""}"${left === null ? "" : ` style="left:${Math.max(0, Math.min(100, left))}%;--marker-shift:${shift}"` } title="${escapeHtml(`${label} · ${timeLabel(time)}`)}"><b>${escapeHtml(label)}</b>${statusMarkup}<small>${escapeHtml(detail)}</small></span>`;
  };
  const lane = (kind: string, label: string, items: string, empty: string) => `<div class="runtime-map-lane runtime-map-lane-${escapeHtml(kind)}"><strong>${escapeHtml(label)}</strong><div class="runtime-map-track">${items || `<span class="runtime-map-lane-empty">${escapeHtml(empty)}</span>`}</div></div>`;
  const structuralLane = events.map((event) => marker("event", event.normalizedKind || event.kind, event.timestamp, event.phase || null, event.category || "unknown")).join("");
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const taskIdsWithRuns = new Set(runs.map((run) => run.taskId).filter(Boolean));
  const workLane = [
    ...runs.map((run) => {
      const task = run.taskId ? taskById.get(run.taskId) : null;
      return marker("run", task ? entityLabel(task, task.id) : entityLabel(run, run.id), run.timeStart, run.status || null, [run.mode, run.model].filter(Boolean).join(" · "));
    }),
    ...tasks.filter((task) => !taskIdsWithRuns.has(task.id)).map((task) => marker("task", entityLabel(task, task.id), task.timeCreated ?? task.timeUpdated, task.status || null, task.kind))
  ].join("");
  const timedRelationships = relationships.filter((relationship) => finiteTime(relationship.timestamp) !== null);
  const untimedRelationshipCounts = new Map<string, number>();
  relationships.filter((relationship) => finiteTime(relationship.timestamp) === null).forEach((relationship) => {
    untimedRelationshipCounts.set(relationship.type, (untimedRelationshipCounts.get(relationship.type) || 0) + 1);
  });
  const relationLane = [
    ...timedRelationships.map((relationship) => marker("relationship", relationship.type, relationship.timestamp, null, t("runtime.relationship_observation"))),
    ...[...untimedRelationshipCounts].map(([type, total]) => marker("relationship", type, null, null, `${count(total)} ${t("runtime.relationships")}`))
  ].join("");
  const contextLane = checkpoints.map((checkpoint) => {
    const records = checkpoint.events.length + checkpoint.artifacts.length;
    return marker("context", t("runtime.context_checkpoint"), checkpoint.timestamp, null, `${count(records)} ${t("runtime.evidence_records")}`);
  }).join("");
  const categoryCounts = Object.entries(data.summary?.categories || {})
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .slice(0, 8);
  const maxCategoryCount = Math.max(1, ...categoryCounts.map(([, value]) => Number(value) || 0));
  const density = categoryCounts.length
    ? `<div class="runtime-map-density" aria-label="${escapeHtml(t("runtime.activity_density"))}">${categoryCounts.map(([category, value]) => `<div class="runtime-density-row"><span>${escapeHtml(category)}</span><span class="runtime-density-bar"><i style="width:${Math.max(4, ((Number(value) || 0) / maxCategoryCount) * 100)}%"></i></span><strong>${escapeHtml(count(value))}</strong></div>`).join("")}</div>`
    : `<p class="runtime-notice">${escapeHtml(t("runtime.not_recorded"))}</p>`;
  const checkpointRecords = contextEvents.length + artifacts.length;
  const activeTasks = Number(data.summary?.counts?.activeTasks) || 0;
  const activeRuns = Number(data.summary?.counts?.activeRuns) || 0;
  return `<section class="runtime-map" aria-labelledby="runtime-map-title">
    <div class="runtime-section-heading"><div><h2 id="runtime-map-title">${t("runtime.map_title")}</h2><p>${t("runtime.map_description")}</p></div><span class="runtime-bounded-label">${escapeHtml(t("runtime.bounded_label"))}</span></div>
    <div class="runtime-map-overview"><div><span>${escapeHtml(t("runtime.map_structural_events"))}</span><strong>${escapeHtml(count(events.length))}</strong></div><div><span>${escapeHtml(t("runtime.map_active_work"))}</span><strong>${escapeHtml(`${count(activeTasks)} / ${count(activeRuns)}`)}<small>${escapeHtml(t("runtime.map_active_work_detail"))}</small></strong></div><div><span>${escapeHtml(t("runtime.map_checkpoints"))}</span><strong>${escapeHtml(count(checkpoints.length))}<small>${escapeHtml(`${count(checkpointRecords)} ${t("runtime.evidence_records")}`)}</small></strong></div></div>
    <div class="runtime-map-columns"><div><h3>${t("runtime.shared_timeline")}</h3><div class="runtime-map-axis">${bounds ? `<span>${escapeHtml(timeLabel(bounds.start))}</span><span>${escapeHtml(timeLabel(bounds.end))}</span>` : `<span>${escapeHtml(t("runtime.unknown_time"))}</span>`}</div><div class="runtime-map-lanes">${lane("event", t("runtime.structure_lane"), structuralLane, t("runtime.not_recorded"))}${lane("work", t("runtime.work_lane"), workLane, t("runtime.no_work"))}${lane("relationship", t("runtime.relationship_lane"), relationLane, t("runtime.no_relationships"))}${lane("context", t("runtime.context_lane"), contextLane, t("runtime.no_context_events"))}</div></div><div><h3>${t("runtime.activity_density")}</h3>${density}<p class="runtime-map-legend">${escapeHtml(t("runtime.map_legend"))}</p><p class="runtime-map-legend">${escapeHtml(t("runtime.checkpoint_grouping_note"))}</p></div></div>
  </section>`;
}

function renderSummary(data: RuntimeData) {
  const summary = data.summary || {};
  const counts = summary.counts || {};
  const session = summary.session || data.protocol?.session || null;
  const diagnostics = [...(summary.validation?.errors || []), ...(summary.validation?.warnings || [])];
  const latest = summary.latestStructuralEvent;
  const capabilities = summary.capabilities || {};
  return `<section class="runtime-summary" aria-labelledby="runtime-summary-title">
    <div class="runtime-section-heading"><div><h2 id="runtime-summary-title">${t("runtime.summary_title")}</h2><p>${t("runtime.summary_description")}</p></div><span class="runtime-completeness runtime-completeness-${escapeHtml(summary.completeness || "partial")}">${escapeHtml(summary.completeness || t("runtime.unknown"))}</span></div>
    ${renderRuntimeMap(data)}
    <div class="runtime-stat-grid" aria-label="${escapeHtml(t("runtime.counts_label"))}">
      ${[ [t("runtime.count_events"), counts.events], [t("runtime.count_relationships"), counts.relationships], [t("runtime.count_tasks"), counts.tasks], [t("runtime.count_runs"), counts.agentRuns], [t("runtime.count_context"), counts.contextArtifacts], [t("runtime.count_branches"), counts.branches] ].map(([label, value]) => `<div class="runtime-stat-card"><span>${escapeHtml(String(label))}</span><strong>${escapeHtml(count(value))}</strong></div>`).join("")}
    </div>
    <dl class="runtime-session-facts">
      <div><dt>${t("runtime.state")}</dt><dd><span class="runtime-status runtime-status-${escapeHtml(statusClass(session?.state))}">${escapeHtml(session?.state || t("runtime.unknown"))}</span></dd></div>
      <div><dt>${t("runtime.harness")}</dt><dd>${escapeHtml(session?.harness || t("runtime.not_recorded"))}</dd></div>
      <div><dt>${t("runtime.origin")}</dt><dd>${escapeHtml(session?.origin || t("runtime.not_recorded"))}</dd></div>
      <div><dt>${t("runtime.latest_activity")}</dt><dd>${latest ? `${escapeHtml(latest.normalizedKind || latest.kind || "")} · ${escapeHtml(timeLabel(latest.timestamp))}` : escapeHtml(t("runtime.not_recorded"))}</dd></div>
    </dl>
    <details class="runtime-trust-panel"><summary>${t("runtime.trust_panel_title")}</summary><p>${t("runtime.trust_panel_description")}</p><section class="runtime-capabilities" aria-labelledby="runtime-capabilities-title"><h3 id="runtime-capabilities-title">${t("runtime.capabilities_title")}</h3><ul>${renderCapability(t("runtime.domain_events"), capabilities.events)}${renderCapability(t("runtime.domain_relationships"), capabilities.relationships)}${renderCapability(t("runtime.domain_tasks"), capabilities.tasks)}${renderCapability(t("runtime.domain_runs"), capabilities.runs)}${renderCapability(t("runtime.domain_context"), capabilities.context)}${renderCapability(t("runtime.domain_branches"), capabilities.branches)}</ul></section>
    ${data.storageDiagnostic ? `<p class="runtime-notice runtime-notice-warning">${escapeHtml(String(data.storageDiagnostic.message || data.storageDiagnostic.code || data.storageDiagnostic))}</p>` : ""}
    ${data.runtimeError ? `<p class="runtime-notice runtime-notice-warning" data-runtime-error="${escapeHtml(String(data.runtimeError.code || "runtime_unavailable"))}">${escapeHtml(String(data.runtimeError.message || t("runtime.unavailable")))}</p>` : ""}
    ${diagnostics.length ? `<section class="runtime-diagnostics" aria-labelledby="runtime-diagnostics-title"><h3 id="runtime-diagnostics-title">${t("runtime.diagnostics_title")}</h3><ul>${diagnostics.slice(0, 20).map((item: any) => `<li><strong>${escapeHtml(item.code || t("runtime.diagnostic"))}</strong> ${escapeHtml(item.message || "")}${item.provenance ? ` <small>${escapeHtml(provenanceLabel(item.provenance))}</small>` : ""}</li>`).join("")}</ul></section>` : `<p class="runtime-notice">${escapeHtml(t("runtime.no_diagnostics"))}</p>`}</details>
  </section>`;
}

function renderEvent(event: any) {
  const label = event.normalizedKind || event.kind || t("runtime.unknown");
  return `<article class="runtime-event" data-runtime-event data-runtime-event-category="${escapeHtml(event.category || "unknown")}" data-runtime-event-kind="${escapeHtml(label)}" data-runtime-event-search="${escapeHtml(`${label} ${event.phase || ""} ${event.correlationId || ""}`.toLocaleLowerCase())}">
    <div class="runtime-event-sequence">#${escapeHtml(String(event.sequence ?? ""))}</div><div class="runtime-event-body"><div class="runtime-event-heading"><strong>${escapeHtml(label)}</strong><span class="runtime-event-category">${escapeHtml(event.category || "unknown")}</span>${event.phase ? `<span class="runtime-event-phase">${escapeHtml(event.phase)}</span>` : ""}</div><div class="runtime-event-meta"><time datetime="${escapeHtml(dateTime(event.timestamp))}">${escapeHtml(timeLabel(event.timestamp))}</time>${event.correlationId ? `<code>${escapeHtml(event.correlationId)}</code>` : ""}<span>${escapeHtml(provenanceLabel(event.provenance))}</span></div></div>${evidenceButton("event", event.id)}</article>`;
}

function renderEventDensity(events: any[]) {
  const counts = new Map<string, number>();
  events.forEach((event) => counts.set(event.category || "unknown", (counts.get(event.category || "unknown") || 0) + 1));
  const rows = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  const max = Math.max(1, ...rows.map(([, value]) => value));
  return rows.length
    ? `<div class="runtime-event-density" aria-label="${escapeHtml(t("runtime.event_density"))}">${rows.map(([category, value]) => `<button type="button" class="runtime-event-density-row" data-runtime-density-category="${escapeHtml(category)}"><span>${escapeHtml(category)}</span><i><b style="width:${Math.max(4, (value / max) * 100)}%"></b></i><strong>${escapeHtml(count(value))}</strong></button>`).join("")}</div>`
    : `<p class="runtime-notice">${escapeHtml(t("runtime.not_recorded"))}</p>`;
}

function renderEvents(data: RuntimeData) {
  const protocol = data.protocol;
  const events = (protocol?.events || []).slice(0, 50).map(publicEvent);
  return `<section class="runtime-lens runtime-events-lens" aria-labelledby="runtime-events-title" data-runtime-events-panel>
    <div class="runtime-section-heading"><div><h2 id="runtime-events-title">${t("runtime.events_title")}</h2><p>${t("runtime.events_description")}</p></div><span class="runtime-bounded-label">${t("runtime.bounded_label")}</span></div>
    <div class="runtime-events-structure"><h3>${t("runtime.event_density")}</h3>${renderEventDensity((protocol?.events || []).map(publicEvent))}<p>${t("runtime.events_structure_hint")}</p></div>
    <form class="runtime-event-filters" data-runtime-event-filters><label>${t("runtime.filter_category")}<select data-runtime-event-category><option value="">${t("runtime.all_categories")}</option>${["session", "message", "model", "reasoning", "tool", "task", "run", "context", "control", "team", "unknown"].map((category) => `<option value="${category}">${category}</option>`).join("")}</select></label><label class="runtime-filter-search">${t("runtime.filter_text")}<input type="search" data-runtime-event-search placeholder="${escapeHtml(t("runtime.filter_text_placeholder"))}"></label><button type="submit" class="btn">${t("runtime.apply_filter")}</button></form>
    <p class="runtime-results-status" data-runtime-events-status aria-live="polite">${escapeHtml(t("runtime.events_loaded", { count: String(events.length) }))}</p>
    <div class="runtime-event-list" data-runtime-event-list>${events.length ? events.map(renderEvent).join("") : `<p class="runtime-empty">${t("runtime.no_events")}</p>`}</div>
    <div class="runtime-pagination"><button type="button" class="btn" data-runtime-events-previous disabled>${t("runtime.previous")}</button><button type="button" class="btn" data-runtime-events-next data-runtime-next-cursor="${escapeHtml(data.eventNextCursor || "")}" ${data.eventNextCursor ? "" : "disabled"}>${t("runtime.next")}</button></div>
  </section>`;
}

function workBounds(tasks: any[], runs: any[]) {
  const times = [
    ...tasks.flatMap((task) => [task.timeCreated, task.timeUpdated, task.timeCompleted]),
    ...runs.flatMap((run) => [run.timeStart, run.timeEnd])
  ].map(finiteTime).filter((value): value is number => value !== null);
  if (!times.length) return null;
  const start = Math.min(...times);
  const end = Math.max(...times);
  return { start, end, span: Math.max(0, end - start) };
}

function lanePosition(start: unknown, end: unknown, bounds: { start: number; span: number } | null) {
  const left = finiteTime(start);
  const right = finiteTime(end);
  if (!bounds || left === null || right === null || right < left || bounds.span <= 0) return "";
  return ` style="--lane-start:${Math.max(0, Math.min(100, ((left - bounds.start) / bounds.span) * 100))}%;--lane-width:${Math.max(1, Math.min(100, ((right - left) / bounds.span) * 100))}%"`;
}

function renderRun(run: any, provider: string, bounds: { start: number; span: number } | null) {
  const childLink = run.childSessionId ? `<a href="/${encodeURIComponent(provider)}/session/${encodeURIComponent(run.childSessionId)}">${escapeHtml(run.childSessionId)}</a>` : "";
  const label = run.agentPath || run.agent || run.model || run.id;
  const position = lanePosition(run.timeStart, run.timeEnd, bounds);
  const marker = !position && finiteTime(run.timeStart) !== null && bounds && bounds.span > 0
    ? `<i class="runtime-lane-point" style="--lane-start:${Math.max(0, Math.min(100, ((finiteTime(run.timeStart)! - bounds.start) / bounds.span) * 100))}%" aria-hidden="true"></i>`
    : "";
  return `<article class="runtime-run runtime-lane-run runtime-status-border-${escapeHtml(statusClass(run.status))}"><div class="runtime-lane-track">${position ? `<span class="runtime-lane-bar"${position}></span>` : marker}</div><div class="runtime-card-heading"><strong>${escapeHtml(label)}</strong><span class="runtime-status runtime-status-${escapeHtml(statusClass(run.status))}">${escapeHtml(run.status || t("runtime.unknown"))}</span></div><p>${escapeHtml([run.mode, run.model, run.attempt ? `${t("runtime.attempt")} ${run.attempt}` : ""].filter(Boolean).join(" · "))}</p><div class="runtime-card-meta">${run.timeStart ? `<time datetime="${escapeHtml(dateTime(run.timeStart))}">${escapeHtml(timeLabel(run.timeStart))}</time>` : `<span>${escapeHtml(t("runtime.not_recorded"))}</span>`}${run.timeEnd ? `<time datetime="${escapeHtml(dateTime(run.timeEnd))}">${escapeHtml(timeLabel(run.timeEnd))}</time>` : `<span>${escapeHtml(t("runtime.end_not_recorded"))}</span>`}${run.failureReason ? `<span>${escapeHtml(run.failureReason)}</span>` : ""}${run.childSessionId ? `<span>${escapeHtml(t("runtime.child_session"))}: ${childLink}</span>` : ""}<button type="button" class="btn runtime-work-events" data-runtime-events-run="${escapeHtml(run.id)}">${t("runtime.lens_events")}</button>${evidenceButton("run", run.id)}</div></article>`;
}

function renderTaskLane(task: any, runsByTask: Map<string, any[]>, provider: string, bounds: { start: number; span: number } | null, depth = 0): string {
  if (!task?.id) return "";
  const runs = runsByTask.get(task.id) || [];
  const label = task.title || task.agentPath || task.id;
  return `<article class="runtime-task runtime-swimlane runtime-card runtime-status-border-${escapeHtml(statusClass(task.status))}" style="--task-depth:${Math.min(depth, 6)}" data-runtime-task-id="${escapeHtml(task.id)}"><div class="runtime-swimlane-header"><div class="runtime-card-heading"><strong>${escapeHtml(label)}</strong><span class="runtime-status runtime-status-${escapeHtml(statusClass(task.status))}">${escapeHtml(task.status || t("runtime.unknown"))}</span></div><p class="runtime-task-meta">${escapeHtml([task.kind, task.owner || task.assignee, task.parentTaskId ? `${t("runtime.parent_task")}: ${task.parentTaskId}` : "", task.dependencies?.length ? `${task.dependencies.length} ${t("runtime.dependencies")}` : ""].filter(Boolean).join(" · "))}</p><div class="runtime-card-actions"><button type="button" class="btn runtime-work-events" data-runtime-events-task="${escapeHtml(task.id)}">${t("runtime.lens_events")}</button>${evidenceButton("task", task.id)}${task.requestEventId ? `<span>${escapeHtml(t("runtime.request_event"))}: ${escapeHtml(task.requestEventId)}</span>` : ""}</div></div><div class="runtime-swimlane-runs">${runs.length ? runs.map((run) => renderRun(run, provider, bounds)).join("") : `<p class="runtime-notice">${escapeHtml(t("runtime.no_runs_for_task"))}</p>`}</div></article>`;
}

function renderWork(protocol: SessionProtocol | null) {
  const tasks = (protocol?.tasks || []).slice(0, 100);
  const runs = (protocol?.agentRuns || []).slice(0, 100);
  const runsByTask = new Map<string, any[]>();
  runs.forEach((run) => {
    if (!run.taskId) return;
    const list = runsByTask.get(run.taskId) || [];
    list.push(run);
    runsByTask.set(run.taskId, list);
  });
  const provider = protocol?.session?.ref?.provider || "";
  const bounds = workBounds(tasks, runs);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const depthFor = (task: any) => {
    let depth = 0;
    const seen = new Set<string>();
    let parentId = task.parentTaskId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      depth += 1;
      parentId = taskById.get(parentId)?.parentTaskId;
    }
    return depth;
  };
  const laneScale = bounds?.span ? `<div class="runtime-swimlane-scale"><span>${escapeHtml(timeLabel(bounds.start))}</span><span>${escapeHtml(timeLabel(bounds.start + bounds.span / 2))}</span><span>${escapeHtml(timeLabel(bounds.start + bounds.span))}</span></div>` : "";
  const unassigned = runs.filter((run) => !run.taskId);
  return `<section class="runtime-lens runtime-work-lens" aria-labelledby="runtime-work-title"><div class="runtime-section-heading"><div><h2 id="runtime-work-title">${t("runtime.work_title")}</h2><p>${t("runtime.work_description")}</p></div><span class="runtime-bounded-label">${escapeHtml(`${count(tasks.length)} ${t("runtime.tasks")} · ${count(runs.length)} ${t("runtime.runs")}`)}</span></div><div class="runtime-swimlane-legend"><span><i class="runtime-legend-swatch runtime-legend-task"></i>${t("runtime.task_lane")}</span><span><i class="runtime-legend-swatch runtime-legend-run"></i>${t("runtime.run_lane")}</span><span>${t("runtime.time_recorded_note")}</span></div>${laneScale}<div class="runtime-work-list">${tasks.length ? tasks.map((task) => renderTaskLane(task, runsByTask, provider, bounds, depthFor(task))).join("") : ""}${unassigned.length ? `<article class="runtime-task runtime-swimlane runtime-card"><div class="runtime-card-heading"><strong>${escapeHtml(t("runtime.unassigned_runs"))}</strong></div><div class="runtime-swimlane-runs">${unassigned.map((run) => renderRun(run, provider, bounds)).join("")}</div></article>` : ""}${!tasks.length && !unassigned.length ? `<p class="runtime-empty">${t("runtime.no_work")}</p>` : ""}</div></section>`;
}

function sessionHref(ref: any) {
  if (!ref?.provider || !ref?.sessionId) return "";
  return `/${encodeURIComponent(ref.provider)}/session/${encodeURIComponent(ref.sessionId)}`;
}

function renderSessions(protocol: SessionProtocol | null, graph: any = null) {
  const relationships = (protocol?.relationships || []).slice(0, 100);
  const rootProvider = protocol?.session?.ref?.provider || "";
  const taskById = new Map((protocol?.tasks || []).map((task) => [task.id, task]));
  const runByChildSession = new Map((protocol?.agentRuns || []).filter((run) => run.childSessionId).map((run) => [run.childSessionId, run]));
  const relationshipRef = (relationship: any, side: "from" | "to") => relationship[`${side}Ref`] || {
    provider: rootProvider,
    sessionId: relationship[`${side}SessionId`]
  };
  const refKey = (ref: any) => `${ref?.provider || "?"}\u0000${ref?.sessionId || "?"}`;
  const rows = relationships.map((relationship: any) => {
    const from = relationshipRef(relationship, "from");
    const to = relationshipRef(relationship, "to");
    const link = (ref: any) => sessionHref(ref) ? `<a href="${escapeHtml(sessionHref(ref))}">${escapeHtml(`${ref.provider}/${ref.sessionId}`)}</a>` : escapeHtml(`${ref.provider || "?"}/${ref.sessionId || "?"}`);
    return `<li class="runtime-session-edge"><span class="runtime-relationship-type">${escapeHtml(relationship.type || t("runtime.unknown"))}</span><span>${link(from)}</span><span aria-hidden="true">→</span><span>${link(to)}</span><small>${escapeHtml(provenanceLabel(relationship.provenance))}</small>${relationship.details ? `<p>${escapeHtml(relationship.details)}</p>` : ""}</li>`;
  });
  const sessionNodes = new Map<string, any>((graph?.nodes || []).filter((node: any) => node.kind === "session" && node.session).map((node: any) => [refKey(node.session), node]));
  const children = new Map<string, Array<{ ref: any; relationship: any }>>();
  const incoming = new Set<string>();
  relationships.forEach((relationship: any) => {
    const from = relationshipRef(relationship, "from");
    const to = relationshipRef(relationship, "to");
    const list = children.get(refKey(from)) || [];
    list.push({ ref: to, relationship });
    children.set(refKey(from), list);
    incoming.add(refKey(to));
  });
  const focusRef = protocol?.session?.ref || (protocol ? { provider: rootProvider, sessionId: protocol.sessionId } : null);
  const allRefs = new Map<string, any>();
  if (focusRef) allRefs.set(refKey(focusRef), focusRef);
  relationships.forEach((relationship: any) => {
    const from = relationshipRef(relationship, "from");
    const to = relationshipRef(relationship, "to");
    allRefs.set(refKey(from), from);
    allRefs.set(refKey(to), to);
  });
  const topLevelRefs = [...allRefs.values()].filter((ref) => !incoming.has(refKey(ref)));
  const roots = topLevelRefs.length ? topLevelRefs : focusRef ? [focusRef] : [];
  const renderNode = (ref: any, seen = new Set<string>()): string => {
    const key = refKey(ref);
    if (!ref || seen.has(key)) return "";
    const nextSeen = new Set(seen).add(key);
    const graphNode = sessionNodes.get(key);
    const childRun = ref?.sessionId ? runByChildSession.get(ref.sessionId) : null;
    const childTask = childRun?.taskId ? taskById.get(childRun.taskId) : null;
    const label = childTask?.title || childTask?.agentPath || graphNode?.label || ref.sessionId;
    const nodeLabel = ref && sessionHref(ref)
      ? `<a href="${escapeHtml(sessionHref(ref))}">${escapeHtml(label)}</a>`
      : escapeHtml(label);
    const nodeStatus = graphNode?.status || childRun?.status || null;
    const status = nodeStatus ? `<span class="runtime-status runtime-status-${escapeHtml(statusClass(nodeStatus))}">${escapeHtml(nodeStatus)}</span>` : `<span class="runtime-not-recorded">${escapeHtml(t("runtime.not_recorded"))}</span>`;
    const model = childRun?.model ? `<small class="runtime-tree-node-model">${escapeHtml(childRun.model)}</small>` : "";
    const canonicalId = childTask && ref?.sessionId ? `<small class="runtime-tree-node-id">${escapeHtml(ref.sessionId)}</small>` : "";
    const descendants = (children.get(key) || []).map(({ ref: child, relationship }) => `<li><div class="runtime-tree-connector"><span class="runtime-tree-edge-label">${escapeHtml(relationship.type || t("runtime.unknown"))}${relationship.provenance?.fidelity === "derived" ? ` · ${escapeHtml(t("runtime.inferred"))}` : ""}</span>${renderNode(child, nextSeen)}</div></li>`).join("");
    return `<div class="runtime-tree-node runtime-graph-node-${escapeHtml(graphNode?.resolution || "missing")}" data-runtime-node-kind="session"><span class="runtime-tree-node-kind">session</span><span class="runtime-tree-node-label">${nodeLabel}</span>${canonicalId}${model}${status}</div>${descendants ? `<ul>${descendants}</ul>` : ""}`;
  };
  const treeMarkup = roots.length ? roots.map((ref) => `<li>${renderNode(ref)}</li>`).join("") : `<li class="runtime-empty">${t("runtime.no_relationships")}</li>`;
  return `<section class="runtime-lens runtime-sessions-lens" aria-labelledby="runtime-sessions-title"><div class="runtime-section-heading"><div><h2 id="runtime-sessions-title">${t("runtime.sessions_title")}</h2><p>${t("runtime.sessions_description")}</p></div><span class="runtime-bounded-label">${escapeHtml(`${count(relationships.length)} ${t("runtime.relationships")}`)}</span></div><div class="runtime-session-graph"><ul class="runtime-session-tree" aria-label="${escapeHtml(t("runtime.sessions_tree_label"))}">${treeMarkup}</ul></div><p class="runtime-notice">${t("runtime.sessions_accessible_list")}</p><ul class="runtime-session-edge-list">${rows.length ? rows.join("") : `<li class="runtime-empty">${t("runtime.no_relationships")}</li>`}</ul></section>`;
}

function renderContext(protocol: SessionProtocol | null) {
  const artifacts = (protocol?.contextArtifacts || []).slice(0, 100);
  const events = (protocol?.events || []).filter((event) => event.category === "context" || String(event.normalizedKind || event.kind).startsWith("context.") || String(event.normalizedKind || event.kind).startsWith("memory.")).slice(0, 50);
  const checkpoints = contextCheckpointGroups(events, artifacts);
  const renderCheckpoint = (checkpoint: { timestamp: number | null; events: any[]; artifacts: any[] }) => {
    const compactions = checkpoint.events.filter((event) => event.compaction);
    const resultingSummary = compactions.map((event) => event.compaction?.summary).find((summary) => typeof summary === "string" && summary.trim());
    const records = [
      ...compactions.map((event) => {
        const compaction = event.compaction || {};
        const tokenDetails = `${t("runtime.tokens_before")}: ${compaction.tokensBefore == null ? t("runtime.not_recorded") : count(compaction.tokensBefore)} · ${t("runtime.tokens_after")}: ${compaction.tokensAfter == null ? t("runtime.not_recorded") : count(compaction.tokensAfter)}`;
        return `<li class="runtime-checkpoint-record"><strong>${escapeHtml(event.normalizedKind || event.kind)}</strong><span>${escapeHtml([compaction.trigger, compaction.strategy].filter(Boolean).join(" · ") || t("runtime.not_recorded"))}</span><small>${escapeHtml(tokenDetails)}</small>${evidenceButton("event", event.id)}</li>`;
      }),
      ...checkpoint.events.filter((event) => !event.compaction).map((event) => `<li class="runtime-checkpoint-record"><strong>${escapeHtml(event.normalizedKind || event.kind)}</strong><span>${escapeHtml(t("runtime.context_observation"))}</span>${evidenceButton("event", event.id)}</li>`),
      ...checkpoint.artifacts.map((artifact) => `<li class="runtime-checkpoint-record"><strong>${escapeHtml(artifact.title || artifact.kind || artifact.id)}</strong><span>${escapeHtml([artifact.kind, artifact.contentAccess].filter(Boolean).join(" · ") || t("runtime.not_recorded"))}</span>${artifact.redacted ? `<small>${escapeHtml(t("runtime.redacted"))}</small>` : ""}${evidenceButton("artifact", artifact.id)}</li>`)
    ];
    const result = resultingSummary
      ? `<div class="runtime-compacted-context"><strong>${escapeHtml(t("runtime.compacted_context"))}</strong><div>${escapeHtml(resultingSummary)}</div></div>`
      : "";
    const evidence = `<details class="runtime-checkpoint-evidence"${resultingSummary ? "" : " open"}><summary>${escapeHtml(t("runtime.compaction_evidence"))} · ${escapeHtml(count(records.length))}</summary><ul>${records.join("")}</ul></details>`;
    return `<article class="runtime-checkpoint"><header><span class="runtime-checkpoint-marker" aria-hidden="true"></span><div><h3>${escapeHtml(t("runtime.context_checkpoint"))}</h3><time datetime="${escapeHtml(dateTime(checkpoint.timestamp))}">${escapeHtml(timeLabel(checkpoint.timestamp))}</time></div></header>${result}${evidence}</article>`;
  };
  return `<section class="runtime-lens runtime-context-lens" aria-labelledby="runtime-context-title"><div class="runtime-section-heading"><div><h2 id="runtime-context-title">${t("runtime.context_title")}</h2><p>${t("runtime.context_description")}</p></div><span class="runtime-bounded-label">${escapeHtml(`${count(artifacts.length)} ${t("runtime.artifacts")}`)}</span></div><div class="runtime-context-history"><h3>${t("runtime.context_history_title")}</h3>${checkpoints.length ? checkpoints.map(renderCheckpoint).join("") : `<p class="runtime-empty">${t("runtime.no_context_events")}</p>`}</div></section>`;
}

function renderEvidenceData(protocol: SessionProtocol | null) {
  const initialEvents = (protocol?.events || []).slice(0, 50).map(publicEvent);
  const contextEvents = (protocol?.events || [])
    .filter((event) => event.category === "context" || String(event.normalizedKind || event.kind).startsWith("context.") || String(event.normalizedKind || event.kind).startsWith("memory."))
    .slice(0, 50)
    .map(publicEvent);
  const events = [...new Map([...initialEvents, ...contextEvents].map((event) => [event.id, event])).values()].slice(0, 100);
  return {
    events,
    tasks: (protocol?.tasks || []).slice(0, 100),
    runs: (protocol?.agentRuns || []).slice(0, 100),
    artifacts: (protocol?.contextArtifacts || []).slice(0, 100),
    relationships: (protocol?.relationships || []).slice(0, 100)
  };
}

export function renderRuntimeWorkbench(data: RuntimeData, provider: string, sessionId: string) {
  const protocol = data.protocol;
  const summary = data.summary || { counts: {}, completeness: "partial", capabilities: {} };
  return `<section class="runtime-workbench" data-runtime-root data-runtime-provider="${escapeHtml(provider)}" data-runtime-session-id="${escapeHtml(sessionId)}" data-runtime-available="${protocol ? "true" : "false"}">
    <header class="runtime-header"><div><h2>${t("runtime.title")}</h2><p>${t("runtime.description")}</p></div><span class="runtime-version">v${escapeHtml(String(protocol?.version || summary.version || 2))}</span></header>
    <div class="runtime-lens-tabs" role="tablist" aria-label="${escapeHtml(t("runtime.lenses_label"))}">${[ ["summary", t("runtime.lens_summary")], ["events", t("runtime.lens_events")], ["work", t("runtime.lens_work")], ["sessions", t("runtime.lens_sessions")], ["context", t("runtime.lens_context")] ].map(([id, label], index) => `<button id="runtime-lens-tab-${id}" type="button" role="tab" data-runtime-lens="${id}" aria-controls="runtime-lens-${id}" aria-selected="${index === 0 ? "true" : "false"}" tabindex="${index === 0 ? "0" : "-1"}">${label}</button>`).join("")}</div>
    <div id="runtime-lens-summary" class="runtime-lens-panel" role="tabpanel" aria-labelledby="runtime-lens-tab-summary" data-runtime-panel="summary" tabindex="0">${renderSummary(data)}</div>
    <div id="runtime-lens-events" class="runtime-lens-panel" role="tabpanel" aria-labelledby="runtime-lens-tab-events" data-runtime-panel="events" tabindex="0" hidden>${renderEvents(data)}</div>
    <div id="runtime-lens-work" class="runtime-lens-panel" role="tabpanel" aria-labelledby="runtime-lens-tab-work" data-runtime-panel="work" tabindex="0" hidden>${renderWork(protocol)}</div>
    <div id="runtime-lens-sessions" class="runtime-lens-panel" role="tabpanel" aria-labelledby="runtime-lens-tab-sessions" data-runtime-panel="sessions" tabindex="0" hidden>${renderSessions(protocol, data.graph)}</div>
    <div id="runtime-lens-context" class="runtime-lens-panel" role="tabpanel" aria-labelledby="runtime-lens-tab-context" data-runtime-panel="context" tabindex="0" hidden>${renderContext(protocol)}</div>
    <script type="application/json" data-runtime-evidence>${jsonScript(renderEvidenceData(protocol))}</script>
    <dialog class="runtime-evidence-drawer" data-runtime-drawer aria-labelledby="runtime-drawer-title"><form method="dialog"><button type="submit" class="runtime-drawer-close" aria-label="${escapeHtml(t("runtime.evidence_close"))}">×</button></form><h2 id="runtime-drawer-title">${t("runtime.evidence_title")}</h2><p data-runtime-drawer-summary></p><dl data-runtime-drawer-details></dl></dialog>
  </section>`;
}
