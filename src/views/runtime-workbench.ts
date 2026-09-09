import { t } from "../i18n.js";
import { escapeHtml } from "../markdown.js";
import { summarizeEvent } from "../event-summary.js";
import type { SessionProtocol } from "../providers/shared/session-protocol.js";
import { publicEvent } from "../protocol-runtime.js";
import type {
  ContextProjection,
  CoordinationProjection,
  ExecutionProjection,
  WorkProjection
} from "../protocol-runtime-v3.js";
import { deriveWorkOverview, type WorkOverviewTask } from "../work-view-model.js";
import type { SessionProtocolV3 } from "../providers/shared/session-protocol-v3.js";

type RuntimeData = {
  protocol: SessionProtocol | null;
  v3?: SessionProtocolV3 | null;
  projections?: {
    work: WorkProjection;
    execution: ExecutionProjection;
    coordination: CoordinationProjection;
    context: ContextProjection;
  } | null;
  summary: any;
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

function eventEvidenceButton(id: string) {
  return `<button type="button" class="runtime-evidence-trigger" data-runtime-event-evidence-id="${escapeHtml(id)}" aria-label="${escapeHtml(t("runtime.evidence_open"))}">${escapeHtml(t("runtime.evidence"))}</button>`;
}

function entityLabel(value: any, fallback: string) {
  // Goals record their objective in `description` (title is null); the
  // remaining fields are the entity-label chain for actors/runs/artifacts.
  return value?.title || value?.description || value?.agentPath || value?.agent || value?.model || fallback;
}

function statusLabel(value: unknown) {
  const status = String(value || "unknown");
  const key = `runtime.status_${status}`;
  return t(key) === key ? status : t(key);
}

function durationLabel(value: number | null) {
  if (value == null) return t("runtime.not_recorded");
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}${t("runtime.seconds_short")}`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}${t("runtime.minutes_short")} ${remainder}${t("runtime.seconds_short")}` : `${minutes}${t("runtime.minutes_short")}`;
}

const GOAL_TITLE_LIMIT = 180;
const GOAL_DESCRIPTION_LIMIT = 280;
const CONTEXT_SUMMARY_LIMIT = 280;
const EVENT_DENSITY_LIMIT = 1000;

function narrativeExcerpt(value: string, maxLength: number) {
  const text = value.trim();
  const characters = Array.from(text);
  if (characters.length <= maxLength) return { text, truncated: false };
  const candidate = characters.slice(0, maxLength + 1).join("");
  const breakpoints = ["\n", "。", ". ", "；", "; ", " "];
  const breakpoint = Math.max(...breakpoints.map((marker) => candidate.lastIndexOf(marker)));
  const end = breakpoint >= Math.floor(maxLength * 0.6) ? breakpoint + 1 : maxLength;
  return { text: `${Array.from(candidate).slice(0, end).join("").trimEnd()}…`, truncated: true };
}

function renderEvent(event: any) {
  const label = event.normalizedKind || event.kind || t("runtime.unknown");
  const fidelity = event.provenance?.fidelity === "recorded" || event.provenance?.fidelity === "derived" ? event.provenance.fidelity : "unknown";
  const facts = event.summary || summarizeEvent(event);
  const phaseKey = facts.phase ? `runtime.phase_${facts.phase}` : "";
  const phase = phaseKey && t(phaseKey) !== phaseKey ? t(phaseKey) : facts.phase || "";
  const summary = narrativeExcerpt([
    phase,
    facts.compactionSummary ? `${t("runtime.compaction_summary")}: ${facts.compactionSummary}` : "",
    facts.hasTask ? t("runtime.task_anchor_recorded") : "",
    facts.hasRun ? t("runtime.run_anchor_recorded") : "",
    facts.hasTurn ? t("runtime.turn_anchor_recorded") : ""
  ].filter(Boolean).join(" · "), 240).text || t("runtime.not_recorded");
  return `<tr data-runtime-event data-runtime-event-category="${escapeHtml(event.category || "unknown")}" data-runtime-event-kind="${escapeHtml(label)}" data-runtime-event-search="${escapeHtml(`${label} ${summary}`.toLocaleLowerCase())}"><td class="runtime-event-sequence" data-label="${escapeHtml(t("runtime.event_sequence"))}">${escapeHtml(String(event.sequence ?? ""))}</td><td data-label="${escapeHtml(t("runtime.event_time"))}"><time datetime="${escapeHtml(dateTime(event.timestamp))}">${escapeHtml(timeLabel(event.timestamp))}</time></td><th scope="row" data-label="${escapeHtml(t("runtime.event_type_summary"))}"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(summary)}</small></th><td data-label="${escapeHtml(t("runtime.event_origin"))}"><span class="runtime-event-fidelity runtime-event-fidelity-${escapeHtml(statusClass(fidelity))}">${escapeHtml(t(`runtime.event_${fidelity}`))}</span></td><td data-label="${escapeHtml(t("runtime.evidence"))}">${eventEvidenceButton(event.id)}</td></tr>`;
}

function renderEventDensity(events: any[], totalCount = events.length) {
  const boundedEvents = events.slice(0, EVENT_DENSITY_LIMIT);
  const limited = totalCount > boundedEvents.length;
  const counts = new Map<string, number>();
  boundedEvents.forEach((event) => counts.set(event.category || "unknown", (counts.get(event.category || "unknown") || 0) + 1));
  const rows = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  const max = Math.max(1, ...rows.map(([, value]) => value));
  return rows.length
    ? `<div class="runtime-event-density" aria-label="${escapeHtml(t("runtime.event_density"))}">${rows.map(([category, value]) => `<button type="button" class="runtime-event-density-row" data-runtime-density-category="${escapeHtml(category)}"><span>${escapeHtml(category)}</span><i><b style="width:${Math.max(4, (value / max) * 100)}%"></b></i><strong>${escapeHtml(count(value))}</strong></button>`).join("")}</div>${limited ? `<p class="runtime-notice">${escapeHtml(t("runtime.event_density_limited", { count: String(EVENT_DENSITY_LIMIT) }))}</p>` : ""}`
    : `<p class="runtime-notice">${escapeHtml(t("runtime.not_recorded"))}</p>`;
}

function renderEvents(data: RuntimeData) {
  const protocol = data.protocol;
  const events = (protocol?.events || []).slice(0, 50).map(publicEvent);
  return `<section class="runtime-lens runtime-events-lens" aria-label="${escapeHtml(t("runtime.events_title"))}" data-runtime-events-panel>
    <div class="runtime-section-heading"><div><h2>${t("runtime.events_title")}</h2><p>${t("runtime.events_description")}</p></div><span class="runtime-bounded-label">${t("runtime.bounded_label")}</span></div>
    <div class="runtime-events-structure"><h3>${t("runtime.event_density")}</h3>${renderEventDensity((protocol?.events || []).slice(0, EVENT_DENSITY_LIMIT), protocol?.events?.length || 0)}<p>${t("runtime.events_structure_hint")}</p></div>
    <form class="runtime-event-filters" data-runtime-event-filters><label>${t("runtime.filter_category")}<select data-runtime-event-category><option value="">${t("runtime.all_categories")}</option>${["session", "message", "model", "reasoning", "tool", "task", "run", "context", "control", "team", "unknown"].map((category) => `<option value="${category}">${category}</option>`).join("")}</select></label><label class="runtime-filter-search">${t("runtime.filter_text")}<input type="search" data-runtime-event-search placeholder="${escapeHtml(t("runtime.filter_text_placeholder"))}"></label><button type="submit" class="btn">${t("runtime.apply_filter")}</button></form>
    <p class="runtime-results-status" data-runtime-events-status aria-live="polite">${escapeHtml(t("runtime.events_loaded", { count: String(events.length) }))}</p>
    <div class="runtime-event-table-wrap"><table class="runtime-events-table"><thead><tr><th scope="col">${t("runtime.event_sequence")}</th><th scope="col">${t("runtime.event_time")}</th><th scope="col">${t("runtime.event_type_summary")}</th><th scope="col">${t("runtime.event_origin")}</th><th scope="col">${t("runtime.evidence")}</th></tr></thead><tbody data-runtime-event-list>${events.length ? events.map(renderEvent).join("") : `<tr><td colspan="5" class="runtime-empty">${t("runtime.no_events")}</td></tr>`}</tbody></table></div>
    <div class="runtime-pagination"><button type="button" class="btn" data-runtime-events-previous disabled>${t("runtime.previous")}</button><button type="button" class="btn" data-runtime-events-next data-runtime-next-cursor="${escapeHtml(data.eventNextCursor || "")}" ${data.eventNextCursor ? "" : "disabled"}>${t("runtime.next")}</button></div>
  </section>`;
}

function sessionHref(ref: any) {
  if (!ref?.provider || !ref?.sessionId) return "";
  return `/${encodeURIComponent(ref.provider)}/session/${encodeURIComponent(ref.sessionId)}`;
}

function renderProjectionCoverage(projection: { coverage?: any; completeness?: string; truncated?: boolean; maxItems?: number } | null | undefined) {
  if (!projection) return `<span class="runtime-completeness runtime-completeness-unknown">${escapeHtml(t("runtime.not_recorded"))}</span>`;
  const coverage = projection.coverage?.state || "unknown";
  const coverageLabel = t(`runtime.coverage_${String(coverage).replace(/-/g, "_")}`);
  const completeness = projection.completeness === "complete" ? t("runtime.complete") : t("runtime.incomplete");
  const detail = [
    `${t("runtime.coverage_label")}: ${coverageLabel}`,
    `${t("runtime.snapshot_label")}: ${completeness}`,
    projection.truncated ? t("runtime.projection_truncated") : ""
  ].filter(Boolean).join(" · ");
  return `<span class="runtime-completeness runtime-completeness-${escapeHtml(statusClass(coverage))}">${escapeHtml(detail)}</span>`;
}

function projectionRefLabel(ref: any) {
  if (!ref) return t("runtime.not_recorded");
  return ref.kind === "session"
    ? ref.ref?.sessionId || t("runtime.not_recorded")
    : ref.id || t("runtime.not_recorded");
}

function taskTitle(task: any) {
  return task.title || task.agentPath || t("runtime.untitled_task");
}

function renderOverviewTask(task: WorkOverviewTask) {
  const runStates = task.runs.map((run) => statusLabel(run.status));
  const states = [statusLabel(task.task.status), ...runStates];
  const activity = task.latestActivity == null
    ? t("runtime.not_recorded")
    : `${t("runtime.last_activity")}: ${timeLabel(task.latestActivity)}`;
  const elapsed = task.elapsedMs == null ? "" : `${t("runtime.elapsed")}: ${durationLabel(task.elapsedMs)}`;
  return `<tr data-runtime-overview-task="${escapeHtml(task.id)}"><th scope="row">${escapeHtml(taskTitle(task.task))}${task.task.agentPath && task.task.title ? `<small>${escapeHtml(task.task.agentPath)}</small>` : ""}</th><td data-label="${escapeHtml(t("runtime.task_owner"))}">${escapeHtml(task.owner || t("runtime.not_recorded"))}</td><td data-label="${escapeHtml(t("runtime.task_state"))}"><span class="runtime-status runtime-status-${escapeHtml(statusClass(task.task.status))}">${escapeHtml(states.join(" · "))}</span></td><td data-label="${escapeHtml(t("runtime.task_activity"))}">${escapeHtml(elapsed || activity)}${elapsed ? `<small>${escapeHtml(activity)}</small>` : ""}</td><td data-label="${escapeHtml(t("runtime.evidence"))}">${evidenceButton("task", task.id, t("runtime.evidence"))}</td></tr>`;
}

function renderOverviewTaskHead() {
  return `<thead><tr><th scope="col">${t("runtime.task_title")}</th><th scope="col">${t("runtime.task_owner")}</th><th scope="col">${t("runtime.task_state")}</th><th scope="col">${t("runtime.task_activity")}</th><th scope="col">${t("runtime.evidence")}</th></tr></thead>`;
}

function renderContextResult(data: RuntimeData, model: ReturnType<typeof deriveWorkOverview>) {
  const context = model.context;
  const coverage = data.projections?.context;
  const contextEvidenceIncomplete = Boolean(coverage && (coverage.truncated || coverage.completeness !== "complete"));
  const counts = [
    ["memory", context.memoryCount],
    ["experience", context.experienceCount],
    ["user-info", context.userInfoCount]
  ].filter(([, value]) => Number(value) > 0);
  const contextLabel = context.transformationKind
    ? t(`runtime.context_kind_${context.transformationKind}`) === `runtime.context_kind_${context.transformationKind}`
      ? context.transformationKind
      : t(`runtime.context_kind_${context.transformationKind}`)
    : null;
  const resultDetails = [
    contextLabel,
    context.resultVersionRecorded ? t("runtime.result_version_recorded") : "",
    context.resultArtifactRecorded ? t("runtime.result_artifact_recorded") : "",
    context.tokensAfter == null ? "" : `${count(context.tokensAfter)} ${t("runtime.tokens_unit")} ${t("runtime.after")}`
  ].filter(Boolean).join(" · ");
  const retained = context.retainedSummary ? narrativeExcerpt(context.retainedSummary, CONTEXT_SUMMARY_LIMIT) : null;
  const retainedEvidence = retained?.truncated
    ? `<details class="runtime-context-evidence"><summary>${escapeHtml(t("runtime.show_complete_context_summary"))}</summary><p>${escapeHtml(context.retainedSummary || "")}</p></details>`
    : "";
  const resultMarkup = context.resultOrderUncertain
    ? `<p class="runtime-empty runtime-context-result-uncertain" data-runtime-context-result>${escapeHtml(t("runtime.context_result_order_uncertain"))}</p>`
    : context.hasResult
      ? `<p class="runtime-context-result" data-runtime-context-result>${escapeHtml(resultDetails || t("runtime.context_result_recorded"))}</p>${retained ? `<p class="runtime-context-retained"><strong>${escapeHtml(t("runtime.retained_content"))}</strong> ${escapeHtml(retained.text)}</p>${retainedEvidence}` : ""}`
      : `<p class="runtime-empty">${t("runtime.no_context_result")}</p>`;
  const countBoundNote = counts.length && contextEvidenceIncomplete ? `<p class="runtime-notice runtime-context-counts-note">${escapeHtml(t("runtime.context_counts_lower_bound"))}</p>` : "";
  return `<section class="runtime-work-context" aria-labelledby="runtime-work-context-title"><div class="runtime-overview-section-heading" data-runtime-context-heading><div><h3 id="runtime-work-context-title">${t("runtime.current_context_title")}</h3><p>${t("runtime.current_context_description")}</p></div>${coverage ? renderProjectionCoverage(coverage) : ""}</div>${resultMarkup}${counts.length ? `<ul class="runtime-context-counts">${counts.map(([kind, value]) => `<li><span>${escapeHtml(t(`runtime.context_count_${kind}`))}</span><strong>${escapeHtml(count(value))}</strong></li>`).join("")}</ul>${countBoundNote}` : ""}<a class="runtime-context-inspector-link" href="#tab-conversation" data-detail-tab="tab-conversation">${escapeHtml(t("runtime.open_conversation_inspector"))}</a></section>`;
}

function renderOverviewTaskTable(model: ReturnType<typeof deriveWorkOverview>) {
  const rows = model.visibleTasks.map(renderOverviewTask).join("");
  const remaining = model.remainingTasks.length;
  const hidden = remaining ? `<details class="runtime-task-overflow"><summary>${escapeHtml(t("runtime.more_tasks", { count: count(remaining) }))}</summary><table class="runtime-overview-task-table">${renderOverviewTaskHead()}<tbody>${model.remainingTasks.map(renderOverviewTask).join("")}</tbody></table>${model.evidenceIncomplete ? `<p class="runtime-notice">${escapeHtml(t("runtime.task_overflow_bounded"))}</p>` : ""}</details>` : "";
  return `<section class="runtime-work-tasks" aria-labelledby="runtime-work-tasks-title"><div class="runtime-overview-section-heading"><div><h3 id="runtime-work-tasks-title">${t("runtime.task_table_title")}</h3><p>${t("runtime.task_table_description")}</p></div></div>${model.taskTotal ? `<table class="runtime-overview-task-table">${renderOverviewTaskHead()}<tbody>${rows}</tbody></table>${hidden}` : `<p class="runtime-empty">${t("runtime.no_tasks_recorded")}</p>`}</section>`;
}

function graphNodeLabel(node: { label: string | null; kind: string }, index: number) {
  if (node.label) return node.label;
  if (node.kind === "goal") return t("runtime.goal_not_recorded");
  return `${t("runtime.task")} ${index + 1}`;
}

function renderGraphBoundNotice(graph: { knownTotal: number; nodes: unknown[]; omitted: number; omittedEdges: number; incomplete: boolean }, type: "goal" | "agent") {
  const parts = [t("runtime.graph_nodes_known", { known: count(graph.knownTotal), visible: count(graph.nodes.length) })];
  if (graph.omitted) parts.push(t("runtime.graph_nodes_omitted", { count: count(graph.omitted) }));
  if (graph.omittedEdges) parts.push(t("runtime.graph_edges_omitted", { count: count(graph.omittedEdges) }));
  if (graph.incomplete) parts.push(t("runtime.graph_projection_incomplete"));
  return `<p class="runtime-notice runtime-graph-bound" data-runtime-${type}-graph-bound>${escapeHtml(parts.join(" · "))}</p>`;
}

function renderGraphEvidence(edge: { evidence: { kind: string; id: string }[] }) {
  const evidence = [...new Map(edge.evidence.map((item) => [`${item.kind}:${item.id}`, item])).values()];
  if (!evidence.length) return "";
  return `<details class="runtime-graph-evidence" data-runtime-graph-evidence><summary>${escapeHtml(t("runtime.graph_evidence_count", { count: count(evidence.length) }))}</summary><div>${evidence.map((item) => evidenceButton(item.kind, item.id)).join("")}</div></details>`;
}

function renderGoalTaskGraph(model: ReturnType<typeof deriveWorkOverview>) {
  const graph = model.goalTaskGraph;
  const nodeIndex = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const nodeFor = (id: string) => {
    const index = nodeIndex.get(id);
    return { node: index === undefined ? { label: null, kind: "task" } : graph.nodes[index], index: index ?? 0 };
  };
  const nodeMarkup = graph.nodes.map((node, index) => `<article class="runtime-graph-node runtime-graph-node-${escapeHtml(node.kind)}" data-runtime-graph-node data-runtime-node-kind="${escapeHtml(node.kind)}" data-runtime-node-id="${escapeHtml(node.id)}" aria-label="${escapeHtml(`${graphNodeLabel(node, index)} · ${statusLabel(node.state)}`)}"><strong>${escapeHtml(graphNodeLabel(node, index))}</strong><span class="runtime-status runtime-status-${escapeHtml(statusClass(node.state))}">${escapeHtml(statusLabel(node.state))}</span>${evidenceButton(node.kind, node.id, t("runtime.evidence"))}</article>`).join("");
  const edgeMarkup = graph.edges.map((edge) => {
    const from = nodeFor(edge.from);
    const to = nodeFor(edge.to);
    return `<li class="runtime-graph-edge" data-runtime-graph-edge data-runtime-edge-kind="${escapeHtml(edge.kind)}"><span>${escapeHtml(graphNodeLabel(from.node, from.index))}</span><span aria-hidden="true">→</span><span>${escapeHtml(graphNodeLabel(to.node, to.index))}</span><small>${escapeHtml(t(edge.kind === "membership" ? "runtime.graph_membership" : "runtime.graph_dependency"))}</small>${renderGraphEvidence(edge)}</li>`;
  }).join("");
  const relationshipMarkup = graph.edges.map((edge) => {
    const from = nodeFor(edge.from);
    const to = nodeFor(edge.to);
    return `<li data-runtime-relationship data-runtime-edge-kind="${escapeHtml(edge.kind)}"><strong>${escapeHtml(graphNodeLabel(from.node, from.index))}</strong><span aria-hidden="true">→</span><strong>${escapeHtml(graphNodeLabel(to.node, to.index))}</strong><small>${escapeHtml(t(edge.kind === "membership" ? "runtime.graph_membership" : "runtime.graph_dependency"))}</small>${renderGraphEvidence(edge)}</li>`;
  }).join("");
  const noGoal = !model.goal;
  const empty = !graph.nodes.length
    ? `<p class="runtime-empty">${escapeHtml(t(noGoal ? "runtime.graph_no_goal_or_tasks" : "runtime.graph_no_goal_tasks"))}</p>`
    : noGoal
      ? `<p class="runtime-notice">${escapeHtml(t("runtime.graph_tasks_without_goal"))}</p>`
      : graph.unlinkedTasks
        ? `<p class="runtime-notice">${escapeHtml(t("runtime.graph_unlinked_tasks", { count: count(graph.unlinkedTasks) }))}</p>`
        : "";
  const viewAll = graph.omitted
    ? `<button type="button" class="runtime-graph-view-all" data-runtime-goal-view-all>${escapeHtml(t("runtime.graph_view_all_tasks"))}</button>`
    : "";
  return `<div id="runtime-graph-panel-goal" class="runtime-graph-panel" role="region" aria-label="${escapeHtml(t("runtime.goal_task_graph_title"))}" data-runtime-graph-panel="goal"><h4>${t("runtime.goal_task_graph_title")}</h4><p class="runtime-graph-description">${t("runtime.goal_task_graph_description")}</p>${empty}<div class="runtime-graph-canvas" role="group" data-runtime-graph-canvas="goal" aria-label="${escapeHtml(t("runtime.goal_task_graph_label"))}"><div class="runtime-graph-node-list">${nodeMarkup}</div><ul class="runtime-graph-edge-list">${edgeMarkup || `<li class="runtime-empty">${escapeHtml(t("runtime.graph_no_edges"))}</li>`}</ul></div><ul class="runtime-graph-relationship-list" data-runtime-graph-relationships="goal">${relationshipMarkup || `<li class="runtime-empty">${escapeHtml(t("runtime.graph_no_edges"))}</li>`}</ul>${renderGraphBoundNotice(graph, "goal")}${viewAll}</div>`;
}

function collaborationNodeLabel(node: { label: string | null; kind: string }, index: number) {
  if (node.label) return node.label;
  return `${t(node.kind === "team" ? "runtime.team" : "runtime.agent")} ${index + 1}`;
}

function renderCollaborationGraph(model: ReturnType<typeof deriveWorkOverview>) {
  const graph = model.collaborationGraph;
  const nodeIndex = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const nodeFor = (id: string) => {
    const index = nodeIndex.get(id);
    return { node: index === undefined ? { label: null, kind: "actor" } : graph.nodes[index], index: index ?? 0 };
  };
  const nodeMarkup = graph.nodes.map((node, index) => { const teamGroup = node.kind === "team" ? node.id : node.teamId; return `<article class="runtime-graph-node runtime-graph-node-${escapeHtml(node.kind)}" data-runtime-graph-node data-runtime-node-kind="${escapeHtml(node.kind)}" data-runtime-node-id="${escapeHtml(node.id)}"${teamGroup ? ` data-runtime-team-group="${escapeHtml(teamGroup)}"` : ""} aria-label="${escapeHtml(collaborationNodeLabel(node, index))}"><strong>${escapeHtml(collaborationNodeLabel(node, index))}</strong><span>${escapeHtml(t(node.kind === "team" ? "runtime.team" : "runtime.agent"))}</span>${evidenceButton("actor", node.id, t("runtime.evidence"))}</article>`; }).join("");
  const edgeLabel = (edge: (typeof graph.edges)[number]) => edge.kind === "member"
    ? t("runtime.graph_member")
    : edge.kinds.map(({ kind, count: value }) => `${kind} ×${count(value)}`).join(" · ");
  const renderNode = (id: string) => {
    const index = nodeIndex.get(id);
    return index === undefined ? null : { node: graph.nodes[index], index };
  };
  const edgeMarkup = graph.edges.map((edge) => {
    const from = renderNode(edge.from);
    const to = renderNode(edge.to);
    if (!from || !to) return "";
    return `<li class="runtime-graph-edge${edge.async ? " runtime-graph-edge-async" : ""}" data-runtime-graph-edge data-runtime-edge-kind="${escapeHtml(edge.kind)}" data-runtime-edge-async="${edge.async ? "true" : "false"}"><span>${escapeHtml(collaborationNodeLabel(from.node, from.index))}</span><span aria-hidden="true">→</span><span>${escapeHtml(collaborationNodeLabel(to.node, to.index))}</span><small>${escapeHtml(edgeLabel(edge))}${edge.async ? ` · ${escapeHtml(t("runtime.graph_async_recorded"))}` : ""}</small>${renderGraphEvidence(edge)}</li>`;
  }).join("");
  const relationshipMarkup = graph.edges.map((edge) => {
    const from = renderNode(edge.from);
    const to = renderNode(edge.to);
    if (!from || !to) return "";
    return `<li data-runtime-relationship data-runtime-edge-kind="${escapeHtml(edge.kind)}" data-runtime-edge-async="${edge.async ? "true" : "false"}"><strong>${escapeHtml(collaborationNodeLabel(from.node, from.index))}</strong><span aria-hidden="true">→</span><strong>${escapeHtml(collaborationNodeLabel(to.node, to.index))}</strong><small>${escapeHtml(edgeLabel(edge))}${edge.async ? ` · ${escapeHtml(t("runtime.graph_async_recorded"))}` : ""}</small>${renderGraphEvidence(edge)}</li>`;
  }).join("");
  const empty = !graph.nodes.length ? `<p class="runtime-empty">${escapeHtml(t("runtime.graph_no_actors"))}</p>` : !graph.edges.length ? `<p class="runtime-notice">${escapeHtml(t("runtime.graph_no_edges"))}</p>` : "";
  const unplaced = graph.unplacedObservations ? `<p class="runtime-notice" data-runtime-unplaced-observations>${escapeHtml(t("runtime.graph_unplaced_observations", { count: count(graph.unplacedObservations) }))}</p>` : "";
  const viewAll = graph.omitted ? `<a class="runtime-graph-view-all" data-runtime-agent-view-all data-detail-tab="tab-conversation" href="#tab-conversation">${escapeHtml(t("runtime.graph_view_all_agents"))}</a>` : "";
  return `<div id="runtime-graph-panel-collaboration" class="runtime-graph-panel" role="region" aria-label="${escapeHtml(t("runtime.collaboration_graph_title"))}" data-runtime-graph-panel="collaboration"><h4>${t("runtime.collaboration_graph_title")}</h4><p class="runtime-graph-description">${t("runtime.collaboration_graph_description")}</p>${empty}${unplaced}<div class="runtime-graph-canvas" role="group" data-runtime-graph-canvas="collaboration" aria-label="${escapeHtml(t("runtime.collaboration_graph_label"))}"><div class="runtime-graph-node-list">${nodeMarkup}</div><ul class="runtime-graph-edge-list">${edgeMarkup || `<li class="runtime-empty">${escapeHtml(t("runtime.graph_no_edges"))}</li>`}</ul></div><ul class="runtime-graph-relationship-list" data-runtime-graph-relationships="collaboration">${relationshipMarkup || `<li class="runtime-empty">${escapeHtml(t("runtime.graph_no_edges"))}</li>`}</ul>${renderGraphBoundNotice(graph, "agent")}${viewAll}</div>`;
}

function renderWorkStructure(model: ReturnType<typeof deriveWorkOverview>) {
  return `<section class="runtime-work-structure" aria-labelledby="runtime-work-structure-title"><div class="runtime-overview-section-heading"><div><h3 id="runtime-work-structure-title">${t("runtime.work_structure_title")}</h3><p>${t("runtime.work_structure_description")}</p></div></div><div class="runtime-graph-tabs" hidden data-runtime-graph-tabs data-runtime-graph-label="${escapeHtml(t("runtime.graph_views_label"))}"><button id="runtime-graph-tab-goal" type="button" data-runtime-graph-tab="goal" data-runtime-graph-panel-id="runtime-graph-panel-goal">${t("runtime.goal_task_graph_tab")}</button><button id="runtime-graph-tab-collaboration" type="button" data-runtime-graph-tab="collaboration" data-runtime-graph-panel-id="runtime-graph-panel-collaboration">${t("runtime.collaboration_graph_tab")}</button></div><div class="runtime-graph-panels">${renderGoalTaskGraph(model)}${renderCollaborationGraph(model)}</div></section>`;
}

function renderWorkOverview(data: RuntimeData) {
  const projections = data.projections;
  const protocol = data.v3;
  if (!protocol || !projections) return `<section class="runtime-work-overview" data-runtime-work-overview><p class="runtime-empty">${escapeHtml(t("runtime.work_overview_unavailable"))}</p></section>`;
  const model = deriveWorkOverview({ protocol, work: projections.work, execution: projections.execution, coordination: projections.coordination, context: projections.context });
  const goal = model.goal;
  const recordedGoalTitle = goal?.title || goal?.description || t("runtime.goal_not_recorded");
  const recordedGoalDescription = goal?.title && goal.description ? goal.description : "";
  const goalTitle = narrativeExcerpt(recordedGoalTitle, GOAL_TITLE_LIMIT);
  const goalDescription = recordedGoalDescription ? narrativeExcerpt(recordedGoalDescription, GOAL_DESCRIPTION_LIMIT) : null;
  const goalNarrativeTruncated = goalTitle.truncated || Boolean(goalDescription?.truncated);
  const fullGoalNarrative = goalNarrativeTruncated
    ? `<details class="runtime-goal-evidence"><summary>${escapeHtml(t("runtime.show_complete_goal"))}</summary><p>${escapeHtml(recordedGoalTitle)}</p>${recordedGoalDescription ? `<p>${escapeHtml(recordedGoalDescription)}</p>` : ""}</details>`
    : "";
  const ratio = model.taskTotal ? Math.round((model.completedTasks / model.taskTotal) * 100) : 0;
  const goalStatus = goal?.status || null;
  const allVisibleCompleted = model.taskTotal > 0 && model.completedTasks === model.taskTotal;
  const progressSentence = model.taskTotal === 0
    ? t("runtime.progress_no_tasks")
    : allVisibleCompleted && goalStatus === "completed" && !model.evidenceIncomplete
      ? t("runtime.progress_goal_completed", { total: count(model.taskTotal) })
      : allVisibleCompleted
        ? goalStatus
          ? t("runtime.progress_all_visible", { total: count(model.taskTotal), status: statusLabel(goalStatus) })
          : t("runtime.progress_all_visible_no_goal", { total: count(model.taskTotal) })
        : t("runtime.progress_incomplete", { completed: count(model.completedTasks), total: count(model.taskTotal) });
  const boundedNote = model.evidenceIncomplete ? `<p class="runtime-notice runtime-progress-note">${escapeHtml(t("runtime.progress_evidence_incomplete"))}</p>` : "";
  return `<section class="runtime-work-overview" data-runtime-work-overview aria-labelledby="runtime-work-overview-title"><div class="runtime-work-goal"><div class="runtime-overview-section-heading"><div><h3 id="runtime-work-overview-title">${t("runtime.goal_title")}</h3><p>${t("runtime.goal_description")}</p></div>${goal ? `<span class="runtime-status runtime-status-${escapeHtml(statusClass(goal.status))}">${escapeHtml(statusLabel(goal.status))}</span>` : ""}</div><h4>${escapeHtml(goalTitle.text)}</h4>${goalDescription ? `<p>${escapeHtml(goalDescription.text)}</p>` : ""}${fullGoalNarrative}${!goal ? `<p class="runtime-notice">${escapeHtml(t("runtime.goal_not_recorded_detail"))}</p>` : ""}</div><div class="runtime-work-progress"><div class="runtime-overview-section-heading"><div><h3>${t("runtime.progress_title")}</h3><p>${escapeHtml(progressSentence)}</p></div><strong class="runtime-progress-ratio">${escapeHtml(`${count(model.completedTasks)} / ${count(model.taskTotal)}`)}</strong></div><div class="runtime-progress-track" role="progressbar" aria-label="${escapeHtml(t("runtime.progress_title"))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${ratio}"><span style="width:${ratio}%"></span></div>${boundedNote}</div>${renderWorkStructure(model)}<div class="runtime-work-overview-grid">${renderContextResult(data, model)}${renderOverviewTaskTable(model)}</div><span data-runtime-overview-end aria-hidden="true"></span></section>`;
}

function renderExecutionProjection(data: RuntimeData) {
  const projection = data.projections?.execution;
  if (!projection) return `<section class="runtime-lens"><p class="runtime-empty">${t("runtime.not_recorded")}</p></section>`;
  const actors = projection.actors || [];
  const runs = projection.runs || [];
  const usage = projection.usage || { requestCount: 0, complete: false, input: null, output: null, total: null };
  const usageComplete = usage.complete === true;
  const usageValue = (value: number | null) => value == null
    ? t("runtime.not_recorded")
    : usageComplete ? count(value) : t("runtime.at_least_value", { count: count(value) });
  const requestLabel = usageComplete ? t("runtime.requests") : t("runtime.visible_requests");
  const totalLabel = usageComplete ? t("runtime.total_tokens") : t("runtime.token_lower_bound");
  const componentValues = [
    [t("runtime.input_tokens"), usage.input],
    [t("runtime.output_tokens"), usage.output],
    [t("runtime.reasoning_tokens"), usage.reasoning],
    [t("runtime.cache_read_tokens"), usage.cacheRead],
    [t("runtime.cache_write_tokens"), usage.cacheWrite]
  ];
  const usageNotice = usageComplete
    ? ""
    : `<p class="runtime-notice runtime-usage-bound-note" data-runtime-usage-note>${escapeHtml(projection.truncated ? t("runtime.usage_projection_bounded") : t("runtime.usage_evidence_incomplete"))}</p>`;
  return `<section class="runtime-lens runtime-execution-lens" aria-labelledby="runtime-execution-title">
    <div class="runtime-section-heading"><div><h2 id="runtime-execution-title">${t("runtime.execution_title")}</h2><p>${t("runtime.execution_description")}</p></div>${renderProjectionCoverage(projection)}</div>
    <div class="runtime-projection-overview"><span>${escapeHtml(`${count(actors.length)} ${t("runtime.actors")}`)}</span><span>${escapeHtml(`${count(runs.length)} ${t("runtime.runs")}`)}</span><span>${escapeHtml(`${count(usage.requestCount)} ${t("runtime.usage_records")}`)}</span></div>
    <section class="runtime-projection-group"><h3>${t("runtime.actors")}</h3>${actors.length ? `<ul>${actors.map((entry) => `<li class="runtime-card"><strong>${escapeHtml(entityLabel(entry.actor, entry.actor.id))}</strong><span>${escapeHtml(entry.actor.kind || t("runtime.unknown"))}</span></li>`).join("")}</ul>` : `<p class="runtime-empty">${t("runtime.not_recorded")}</p>`}</section>
    <section class="runtime-projection-group"><h3>${t("runtime.runs")}</h3>${runs.length ? `<ul>${runs.map((entry) => `<li class="runtime-card runtime-run"><strong>${escapeHtml(entityLabel(entry.run, entry.run.id))}</strong><span>${escapeHtml(entry.run.status || t("runtime.unknown"))}</span>${entry.childSession ? `<a href="${escapeHtml(sessionHref(entry.childSession))}">${escapeHtml(entry.childSession.sessionId)}</a>` : ""}${evidenceButton("run", entry.run.id)}</li>`).join("")}</ul>` : `<p class="runtime-empty">${t("runtime.not_recorded")}</p>`}</section>
    <section class="runtime-usage-summary" data-runtime-usage-summary data-runtime-usage-complete="${usageComplete ? "true" : "false"}" data-runtime-usage-truncated="${projection.truncated ? "true" : "false"}"><h3>${t("runtime.usage")}</h3><p><span data-runtime-usage-request-count="${escapeHtml(String(usage.requestCount))}">${escapeHtml(`${requestLabel}: ${count(usage.requestCount)}`)}</span> · <span data-runtime-usage-total="${escapeHtml(usage.total == null ? "" : String(usage.total))}">${escapeHtml(`${totalLabel}: ${usageValue(usage.total)}`)}</span></p><small>${escapeHtml(componentValues.map(([label, value]) => `${label}: ${usageValue(value as number | null)}`).join(" · "))} · ${escapeHtml(usageComplete ? t("runtime.complete") : t("runtime.incomplete"))}</small>${usageNotice}</section>
  </section>`;
}

function renderCoordinationProjection(data: RuntimeData) {
  const projection = data.projections?.coordination;
  if (!projection) return `<section class="runtime-lens"><p class="runtime-empty">${t("runtime.not_recorded")}</p></section>`;
  const observations = projection.observations || [];
  const lineage = projection.lineage || [];
  const link = (ref: any) => sessionHref(ref) ? `<a href="${escapeHtml(sessionHref(ref))}">${escapeHtml(`${ref.provider}/${ref.sessionId}`)}</a>` : escapeHtml(`${ref?.provider || "?"}/${ref?.sessionId || "?"}`);
  return `<section class="runtime-lens runtime-coordination-lens" aria-labelledby="runtime-coordination-title">
    <div class="runtime-section-heading"><div><h2 id="runtime-coordination-title">${t("runtime.coordination_title")}</h2><p>${t("runtime.coordination_description")}</p></div>${renderProjectionCoverage(projection)}</div>
    <section class="runtime-projection-group"><h3>${t("runtime.observations")}</h3>${observations.length ? `<ul>${observations.map((entry) => `<li class="runtime-card"><strong>${escapeHtml(entry.observation.kind || entry.observation.id)}</strong><span>${escapeHtml(entry.observation.state || t("runtime.unknown"))}</span><small>${escapeHtml(provenanceLabel(entry.observation.provenance))}</small></li>`).join("")}</ul>` : `<p class="runtime-empty">${t("runtime.not_recorded")}</p>`}</section>
    <section class="runtime-projection-group"><h3>${t("runtime.lineage")}</h3>${lineage.length ? `<ul class="runtime-session-edge-list">${lineage.map((edge) => `<li class="runtime-session-edge"><span>${escapeHtml(edge.type || t("runtime.unknown"))}</span><span>${link(edge.from)}</span><span aria-hidden="true">→</span><span>${link(edge.to)}</span><small>${escapeHtml(provenanceLabel(edge.provenance))}</small></li>`).join("")}</ul>` : `<p class="runtime-empty">${t("runtime.not_recorded")}</p>`}</section>
  </section>`;
}

function renderContextProjection(data: RuntimeData) {
  const projection = data.projections?.context;
  if (!projection) return `<section class="runtime-lens"><p class="runtime-empty">${t("runtime.not_recorded")}</p></section>`;
  const transformations = projection.transformations || [];
  const versions = projection.versions || [];
  const artifacts = projection.artifacts || [];
  const legacyCompactionEvents = (data.protocol?.events || []).filter((event) => event.compaction?.summary);
  const legacyCompactions = legacyCompactionEvents.slice(0, 50);
  const legacyCompactionsTruncated = legacyCompactionEvents.length > legacyCompactions.length;
  const origins = projection.origins || [];
  const originSources = projection.originSources || [];
  const originCount = origins.length;
  const versionById = new Map(versions.map((entry) => [projectionRefLabel(entry.ref), entry.version]));
  const artifactById = new Map(artifacts.map((entry) => [projectionRefLabel(entry.ref), entry.artifact]));
  const resultLabel = (entry: any) => {
    const id = entry.transformation.resultVersionId;
    if (id && versionById.has(id)) return `${t("runtime.result_version")}: ${entityLabel(versionById.get(id), id)}`;
    const transformationId = projectionRefLabel(entry.ref);
    const artifactRef = (projection.transformationArtifacts || []).find((relation) => projectionRefLabel(relation.transformation) === transformationId && relation.role === "result")?.artifact;
    const artifactId = artifactRef ? projectionRefLabel(artifactRef) : null;
    return artifactId && artifactById.has(artifactId) ? `${t("runtime.result_artifact")}: ${entityLabel(artifactById.get(artifactId), artifactId)}` : t("runtime.not_recorded");
  };
  const renderOrigin = (entry: any) => {
    const usageId = projectionRefLabel(entry.usage);
    const sources = originSources.filter((source) => (
      projectionRefLabel(source.usage) === usageId
      && source.component === entry.component
      && source.origin === entry.origin
      && source.tokens === entry.tokens
    ));
    const sourceLinks = sources.map((source) => `<a href="${escapeHtml(sessionHref(source.sourceSession))}">${escapeHtml(`${source.sourceSession.provider}/${source.sourceSession.sessionId}`)}</a>`).join(" ");
    const component = t(`runtime.origin_component_${entry.component}`);
    const origin = t(`runtime.origin_${entry.origin}`);
    return `<li>${escapeHtml(`${component} · ${origin} · ${count(entry.tokens)} ${t("runtime.tokens_unit")}`)}${sourceLinks ? ` <span>${sourceLinks}</span>` : ""}</li>`;
  };
  return `<section class="runtime-lens runtime-context-lens" aria-labelledby="runtime-context-title">
    <div class="runtime-section-heading"><div><h2 id="runtime-context-title">${t("runtime.context_title")}</h2><p>${t("runtime.context_description")}</p></div>${renderProjectionCoverage(projection)}</div>
    <div class="runtime-projection-overview"><span>${escapeHtml(`${count(transformations.length)} ${t("runtime.transformations")}`)}</span><span>${escapeHtml(`${count(versions.length)} ${t("runtime.versions")}`)}</span><span>${escapeHtml(`${count(artifacts.length)} ${t("runtime.artifacts")}`)}</span><span>${escapeHtml(`${count(originCount)} ${t("runtime.origins")}`)}</span></div>
    ${transformations.length ? `<section class="runtime-projection-group"><h3>${t("runtime.transformations")}</h3><ul>${transformations.map((entry) => { const event = entry.transformation.eventId ? data.protocol?.events.find((candidate) => candidate.id === entry.transformation.eventId) : null; const compaction = event?.compaction; return `<li class="runtime-card runtime-transformation"><strong>${escapeHtml(entry.transformation.kind || projectionRefLabel(entry.ref))}</strong><span>${escapeHtml(resultLabel(entry))}</span><details><summary>${t("runtime.evidence")}</summary><small>${escapeHtml([`${t("runtime.tokens_before")}: ${compaction?.tokensBefore == null ? t("runtime.not_recorded") : count(compaction.tokensBefore)}`, `${t("runtime.tokens_after")}: ${compaction?.tokensAfter == null ? t("runtime.not_recorded") : count(compaction.tokensAfter)}`, provenanceLabel(entry.transformation.provenance)].join(" · "))}</small></details></li>`; }).join("")}</ul></section>` : ""}
    ${legacyCompactions.length ? `<section class="runtime-projection-group runtime-result-context"><h3>${t("runtime.compacted_context")}</h3><ul>${legacyCompactions.map((event) => { const compaction = event.compaction!; return `<li class="runtime-card"><strong>${escapeHtml(t("runtime.compacted_context"))}</strong><span>${escapeHtml(compaction.summary || "")}</span><details><summary>${t("runtime.evidence")}</summary><small>${escapeHtml([`${t("runtime.tokens_before")}: ${compaction.tokensBefore == null ? t("runtime.not_recorded") : count(compaction.tokensBefore)}`, `${t("runtime.tokens_after")}: ${compaction.tokensAfter == null ? t("runtime.not_recorded") : count(compaction.tokensAfter)}`, provenanceLabel(event.provenance)].join(" · "))}</small></details></li>`; }).join("")}</ul>${legacyCompactionsTruncated ? `<p class="runtime-notice">${escapeHtml(t("runtime.compaction_results_bounded", { count: count(legacyCompactions.length) }))}</p>` : ""}</section>` : ""}
    ${artifacts.length ? `<section class="runtime-projection-group"><h3>${t("runtime.artifacts")}</h3><ul>${artifacts.map((entry) => { const id = projectionRefLabel(entry.ref); return `<li class="runtime-card"><strong>${escapeHtml(entityLabel(entry.artifact, id))}</strong><span>${escapeHtml([entry.artifact.kind, entry.artifact.scope].filter(Boolean).join(" · ") || t("runtime.not_recorded"))}</span>${evidenceButton("artifact", id)}</li>`; }).join("")}</ul></section>` : ""}
    <section class="runtime-projection-group"><h3>${t("runtime.origins")}</h3>${originCount ? `<ul class="runtime-origin-list">${origins.map(renderOrigin).join("")}</ul>` : `<p class="runtime-empty">${t("runtime.not_recorded")}</p>`}</section>
    ${!transformations.length && !versions.length && !artifacts.length ? `<p class="runtime-empty">${t("runtime.not_recorded")}</p>` : ""}
  </section>`;
}

function renderEvidenceData(protocol: SessionProtocol | null, v3: SessionProtocolV3 | null = null) {
  return {
    goals: (v3?.goals || []).slice(0, 100),
    tasks: (protocol?.tasks || []).slice(0, 100),
    actors: (v3?.actors || []).slice(0, 100),
    runs: (protocol?.agentRuns || []).slice(0, 100),
    coordinations: (v3?.coordination || []).slice(0, 100),
    artifacts: (protocol?.contextArtifacts || []).slice(0, 100),
    relationships: (protocol?.relationships || []).slice(0, 100)
  };
}

function renderEventEvidenceData(protocol: SessionProtocol | null) {
  return { events: (protocol?.events || []).slice(0, 100).map(publicEvent) };
}

export function renderRuntimeWorkbench(data: RuntimeData, provider: string, sessionId: string) {
  const protocol = data.protocol;
  const summary = data.summary || { counts: {}, completeness: "partial", capabilities: {} };
  const notices = [data.runtimeError, data.storageDiagnostic]
    .filter(Boolean)
    .map((notice) => ({
      code: typeof notice === "object" ? notice?.code : null,
      message: typeof notice === "string"
        ? notice
        : notice?.message || notice?.note || notice?.code || null
    }))
    .filter((notice) => notice.message)
    .map((notice) => `<p class="runtime-notice runtime-notice-warning"${notice.code ? ` data-runtime-error="${escapeHtml(String(notice.code))}"` : ""}>${escapeHtml(String(notice.message))}</p>`)
    .join("");
  return `<section class="runtime-workbench" data-runtime-root data-runtime-provider="${escapeHtml(provider)}" data-runtime-session-id="${escapeHtml(sessionId)}" data-runtime-available="${protocol ? "true" : "false"}">
    <header class="runtime-header"><div><h2>${t("runtime.title")}</h2><p>${t("runtime.description")}</p></div><span class="runtime-version">v${escapeHtml(String(data.v3?.version || protocol?.version || summary.version || 2))}</span></header>
    ${notices}
    <div class="runtime-lens-tabs" role="tablist" aria-label="${escapeHtml(t("runtime.lenses_label"))}">${[ ["work", t("runtime.lens_work")], ["execution", t("runtime.lens_execution")], ["coordination", t("runtime.lens_coordination")], ["context", t("runtime.lens_context")] ].map(([id, label], index) => `<button id="runtime-lens-tab-${id}" type="button" role="tab" data-runtime-lens="${id}" aria-controls="runtime-lens-${id}" aria-selected="${index === 0 ? "true" : "false"}" tabindex="${index === 0 ? "0" : "-1"}">${label}</button>`).join("")}</div>
    <div id="runtime-lens-work" class="runtime-lens-panel" role="tabpanel" aria-labelledby="runtime-lens-tab-work" data-runtime-panel="work" tabindex="0">${renderWorkOverview(data)}</div>
    <div id="runtime-lens-execution" class="runtime-lens-panel" role="tabpanel" aria-labelledby="runtime-lens-tab-execution" data-runtime-panel="execution" tabindex="0" hidden>${renderExecutionProjection(data)}</div>
    <div id="runtime-lens-coordination" class="runtime-lens-panel" role="tabpanel" aria-labelledby="runtime-lens-tab-coordination" data-runtime-panel="coordination" tabindex="0" hidden>${renderCoordinationProjection(data)}</div>
    <div id="runtime-lens-context" class="runtime-lens-panel" role="tabpanel" aria-labelledby="runtime-lens-tab-context" data-runtime-panel="context" tabindex="0" hidden>${renderContextProjection(data)}</div>
    <script type="application/json" data-runtime-evidence>${jsonScript(renderEvidenceData(protocol, data.v3 || null))}</script>
    <dialog class="runtime-evidence-drawer" data-runtime-drawer aria-labelledby="runtime-drawer-title"><form method="dialog"><button type="submit" class="runtime-drawer-close" aria-label="${escapeHtml(t("runtime.evidence_close"))}">×</button></form><h2 id="runtime-drawer-title">${t("runtime.evidence_title")}</h2><p data-runtime-drawer-summary></p><dl data-runtime-drawer-details></dl></dialog>
  </section>`;
}

export function renderRuntimeEvents(data: RuntimeData, provider: string, sessionId: string) {
  const protocol = data.protocol;
  const v3 = data.v3;
  const summary = data.summary || {};
  const domains: (keyof SessionProtocolV3["coverage"])[] = ["work", "execution", "coordination", "context", "usage"];
  const completenessKey = `runtime.completeness_${String(summary.completeness || "unknown")}`;
  const completeness = t(completenessKey) === completenessKey ? t("runtime.unknown") : t(completenessKey);
  const coverage = domains.map((domain) => {
    const state = v3?.coverage?.[domain]?.state || "unknown";
    return `<li><span>${escapeHtml(t(`runtime.domain_${domain}`))}</span><strong>${escapeHtml(t(`runtime.coverage_${String(state).replace(/-/g, "_")}`))}</strong></li>`;
  }).join("");
  return `<section class="runtime-events-surface" data-runtime-events-root data-runtime-events-provider="${escapeHtml(provider)}" data-runtime-events-session-id="${escapeHtml(sessionId)}" data-runtime-events-available="${protocol ? "true" : "false"}"><header class="runtime-events-header"><h2>${t("runtime.events_title")}</h2><p>${t("runtime.events_usage")}</p></header><section class="runtime-events-diagnostics" aria-label="${escapeHtml(t("runtime.events_diagnostics_title"))}"><h3>${t("runtime.events_diagnostics_title")}</h3><div class="runtime-events-diagnostic-summary"><span>${escapeHtml(`${t("runtime.protocol_version")}: ${v3?.version || protocol?.version || t("runtime.not_recorded")}`)}</span><span>${escapeHtml(`${t("runtime.completeness")}: ${completeness}`)}</span></div><ul>${coverage}</ul></section>${protocol ? renderEvents(data) : `<p class="runtime-empty">${escapeHtml(t("runtime.unavailable"))}</p>`}<script type="application/json" data-runtime-events-evidence>${jsonScript(renderEventEvidenceData(protocol))}</script><dialog class="runtime-evidence-drawer" data-runtime-events-drawer aria-label="${escapeHtml(t("runtime.evidence_title"))}"><form method="dialog"><button type="submit" class="runtime-drawer-close" aria-label="${escapeHtml(t("runtime.evidence_close"))}">×</button></form><h2>${t("runtime.evidence_title")}</h2><p data-runtime-events-drawer-summary></p><dl data-runtime-events-drawer-details></dl></dialog></section>`;
}
