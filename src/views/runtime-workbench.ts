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

function renderSummary(data: RuntimeData) {
  const summary = data.summary || {};
  const counts = summary.counts || {};
  const session = summary.session || data.protocol?.session || null;
  const diagnostics = [...(summary.validation?.errors || []), ...(summary.validation?.warnings || [])];
  const latest = summary.latestStructuralEvent;
  const capabilities = summary.capabilities || {};
  return `<section class="runtime-summary" aria-labelledby="runtime-summary-title">
    <div class="runtime-section-heading"><div><h2 id="runtime-summary-title">${t("runtime.summary_title")}</h2><p>${t("runtime.summary_description")}</p></div><span class="runtime-completeness runtime-completeness-${escapeHtml(summary.completeness || "partial")}">${escapeHtml(summary.completeness || t("runtime.unknown"))}</span></div>
    <div class="runtime-stat-grid" aria-label="${escapeHtml(t("runtime.counts_label"))}">
      ${[ [t("runtime.count_events"), counts.events], [t("runtime.count_relationships"), counts.relationships], [t("runtime.count_tasks"), counts.tasks], [t("runtime.count_runs"), counts.agentRuns], [t("runtime.count_context"), counts.contextArtifacts], [t("runtime.count_branches"), counts.branches] ].map(([label, value]) => `<div class="runtime-stat-card"><span>${escapeHtml(String(label))}</span><strong>${escapeHtml(count(value))}</strong></div>`).join("")}
    </div>
    <dl class="runtime-session-facts">
      <div><dt>${t("runtime.state")}</dt><dd><span class="runtime-status runtime-status-${escapeHtml(statusClass(session?.state))}">${escapeHtml(session?.state || t("runtime.unknown"))}</span></dd></div>
      <div><dt>${t("runtime.harness")}</dt><dd>${escapeHtml(session?.harness || t("runtime.not_recorded"))}</dd></div>
      <div><dt>${t("runtime.origin")}</dt><dd>${escapeHtml(session?.origin || t("runtime.not_recorded"))}</dd></div>
      <div><dt>${t("runtime.latest_activity")}</dt><dd>${latest ? `${escapeHtml(latest.normalizedKind || latest.kind || "")} · ${escapeHtml(timeLabel(latest.timestamp))}` : escapeHtml(t("runtime.not_recorded"))}</dd></div>
    </dl>
    <section class="runtime-capabilities" aria-labelledby="runtime-capabilities-title"><h3 id="runtime-capabilities-title">${t("runtime.capabilities_title")}</h3><ul>${renderCapability(t("runtime.domain_events"), capabilities.events)}${renderCapability(t("runtime.domain_relationships"), capabilities.relationships)}${renderCapability(t("runtime.domain_tasks"), capabilities.tasks)}${renderCapability(t("runtime.domain_runs"), capabilities.runs)}${renderCapability(t("runtime.domain_context"), capabilities.context)}${renderCapability(t("runtime.domain_branches"), capabilities.branches)}</ul></section>
    ${data.storageDiagnostic ? `<p class="runtime-notice runtime-notice-warning">${escapeHtml(String(data.storageDiagnostic.message || data.storageDiagnostic.code || data.storageDiagnostic))}</p>` : ""}
    ${data.runtimeError ? `<p class="runtime-notice runtime-notice-warning" data-runtime-error="${escapeHtml(String(data.runtimeError.code || "runtime_unavailable"))}">${escapeHtml(String(data.runtimeError.message || t("runtime.unavailable")))}</p>` : ""}
    ${diagnostics.length ? `<section class="runtime-diagnostics" aria-labelledby="runtime-diagnostics-title"><h3 id="runtime-diagnostics-title">${t("runtime.diagnostics_title")}</h3><ul>${diagnostics.slice(0, 20).map((item: any) => `<li><strong>${escapeHtml(item.code || t("runtime.diagnostic"))}</strong> ${escapeHtml(item.message || "")}${item.provenance ? ` <small>${escapeHtml(provenanceLabel(item.provenance))}</small>` : ""}</li>`).join("")}</ul></section>` : `<p class="runtime-notice">${escapeHtml(t("runtime.no_diagnostics"))}</p>`}
  </section>`;
}

function renderEvent(event: any) {
  const label = event.normalizedKind || event.kind || t("runtime.unknown");
  return `<article class="runtime-event" data-runtime-event data-runtime-event-category="${escapeHtml(event.category || "unknown")}" data-runtime-event-kind="${escapeHtml(label)}" data-runtime-event-search="${escapeHtml(`${label} ${event.phase || ""} ${event.correlationId || ""}`.toLocaleLowerCase())}">
    <div class="runtime-event-sequence">#${escapeHtml(String(event.sequence ?? ""))}</div><div class="runtime-event-body"><div class="runtime-event-heading"><strong>${escapeHtml(label)}</strong><span class="runtime-event-category">${escapeHtml(event.category || "unknown")}</span>${event.phase ? `<span class="runtime-event-phase">${escapeHtml(event.phase)}</span>` : ""}</div><div class="runtime-event-meta"><time datetime="${escapeHtml(dateTime(event.timestamp))}">${escapeHtml(timeLabel(event.timestamp))}</time>${event.correlationId ? `<code>${escapeHtml(event.correlationId)}</code>` : ""}<span>${escapeHtml(provenanceLabel(event.provenance))}</span></div></div>${evidenceButton("event", event.id)}</article>`;
}

function renderEvents(data: RuntimeData) {
  const protocol = data.protocol;
  const events = (protocol?.events || []).slice(0, 50).map(publicEvent);
  return `<section class="runtime-lens runtime-events-lens" aria-labelledby="runtime-events-title" data-runtime-events-panel>
    <div class="runtime-section-heading"><div><h2 id="runtime-events-title">${t("runtime.events_title")}</h2><p>${t("runtime.events_description")}</p></div><span class="runtime-bounded-label">${t("runtime.bounded_label")}</span></div>
    <form class="runtime-event-filters" data-runtime-event-filters><label>${t("runtime.filter_category")}<select data-runtime-event-category><option value="">${t("runtime.all_categories")}</option>${["session", "message", "model", "reasoning", "tool", "task", "run", "context", "control", "team", "unknown"].map((category) => `<option value="${category}">${category}</option>`).join("")}</select></label><label class="runtime-filter-search">${t("runtime.filter_text")}<input type="search" data-runtime-event-search placeholder="${escapeHtml(t("runtime.filter_text_placeholder"))}"></label><button type="submit" class="btn">${t("runtime.apply_filter")}</button></form>
    <p class="runtime-results-status" data-runtime-events-status aria-live="polite">${escapeHtml(t("runtime.events_loaded", { count: String(events.length) }))}</p>
    <div class="runtime-event-list" data-runtime-event-list>${events.length ? events.map(renderEvent).join("") : `<p class="runtime-empty">${t("runtime.no_events")}</p>`}</div>
    <div class="runtime-pagination"><button type="button" class="btn" data-runtime-events-previous disabled>${t("runtime.previous")}</button><button type="button" class="btn" data-runtime-events-next data-runtime-next-cursor="${escapeHtml(data.eventNextCursor || "")}" ${data.eventNextCursor ? "" : "disabled"}>${t("runtime.next")}</button></div>
  </section>`;
}

function renderRun(run: any, provider: string) {
  const childLink = run.childSessionId ? `<a href="/${encodeURIComponent(provider)}/session/${encodeURIComponent(run.childSessionId)}">${escapeHtml(run.childSessionId)}</a>` : "";
  return `<article class="runtime-run runtime-card runtime-status-border-${escapeHtml(statusClass(run.status))}"><div class="runtime-card-heading"><strong>${escapeHtml(run.agent || run.model || run.id)}</strong><span class="runtime-status runtime-status-${escapeHtml(statusClass(run.status))}">${escapeHtml(run.status || t("runtime.unknown"))}</span></div><p>${escapeHtml([run.mode, run.model, run.attempt ? `${t("runtime.attempt")} ${run.attempt}` : ""].filter(Boolean).join(" · "))}</p><div class="runtime-card-meta">${run.timeStart ? `<time datetime="${escapeHtml(dateTime(run.timeStart))}">${escapeHtml(timeLabel(run.timeStart))}</time>` : ""}${run.failureReason ? `<span>${escapeHtml(run.failureReason)}</span>` : ""}${run.childSessionId ? `<span>${escapeHtml(t("runtime.child_session"))}: ${childLink}</span>` : ""}<button type="button" class="btn runtime-work-events" data-runtime-events-run="${escapeHtml(run.id)}">${t("runtime.lens_events")}</button>${evidenceButton("run", run.id)}</div></article>`;
}

function renderTask(task: any, runsByTask: Map<string, any[]>, childrenByTask: Map<string | null, any[]>, provider: string, seen = new Set<string>()): string {
  if (!task?.id || seen.has(task.id)) return "";
  const nextSeen = new Set(seen).add(task.id);
  const children = childrenByTask.get(task.id) || [];
  return `<article class="runtime-task runtime-card runtime-status-border-${escapeHtml(statusClass(task.status))}" data-runtime-task-id="${escapeHtml(task.id)}"><div class="runtime-card-heading"><strong>${escapeHtml(task.title || task.id)}</strong><span class="runtime-status runtime-status-${escapeHtml(statusClass(task.status))}">${escapeHtml(task.status || t("runtime.unknown"))}</span></div><p class="runtime-task-meta">${escapeHtml([task.kind, task.owner || task.assignee, task.dependencies?.length ? `${task.dependencies.length} ${t("runtime.dependencies")}` : ""].filter(Boolean).join(" · "))}</p><div class="runtime-card-actions"><button type="button" class="btn runtime-work-events" data-runtime-events-task="${escapeHtml(task.id)}">${t("runtime.lens_events")}</button>${evidenceButton("task", task.id)}${task.requestEventId ? `<span>${escapeHtml(t("runtime.request_event"))}: ${escapeHtml(task.requestEventId)}</span>` : ""}</div>${(runsByTask.get(task.id) || []).map((run) => renderRun(run, provider)).join("")}${children.length ? `<div class="runtime-task-children">${children.map((child) => renderTask(child, runsByTask, childrenByTask, provider, nextSeen)).join("")}</div>` : ""}</article>`;
}

function renderWork(protocol: SessionProtocol | null) {
  const tasks = (protocol?.tasks || []).slice(0, 100);
  const runs = (protocol?.agentRuns || []).slice(0, 100);
  const roots = tasks.filter((task) => !task.parentTaskId);
  const childrenByTask = new Map<string | null, any[]>();
  tasks.forEach((task) => {
    const key = task.parentTaskId || null;
    const list = childrenByTask.get(key) || [];
    list.push(task);
    childrenByTask.set(key, list);
  });
  const runsByTask = new Map<string, any[]>();
  runs.forEach((run) => {
    if (!run.taskId) return;
    const list = runsByTask.get(run.taskId) || [];
    list.push(run);
    runsByTask.set(run.taskId, list);
  });
  const provider = protocol?.session?.ref?.provider || "";
  return `<section class="runtime-lens runtime-work-lens" aria-labelledby="runtime-work-title"><div class="runtime-section-heading"><div><h2 id="runtime-work-title">${t("runtime.work_title")}</h2><p>${t("runtime.work_description")}</p></div><span class="runtime-bounded-label">${escapeHtml(`${count(tasks.length)} ${t("runtime.tasks")} · ${count(runs.length)} ${t("runtime.runs")}`)}</span></div><div class="runtime-work-list">${roots.length ? roots.map((task) => renderTask(task, runsByTask, childrenByTask, provider)).join("") : `<p class="runtime-empty">${t("runtime.no_work")}</p>`}${tasks.filter((task) => task.parentTaskId && !tasks.some((candidate) => candidate.id === task.parentTaskId)).map((task) => renderTask(task, runsByTask, childrenByTask, provider)).join("")}</div></section>`;
}

function sessionHref(ref: any) {
  if (!ref?.provider || !ref?.sessionId) return "";
  return `/${encodeURIComponent(ref.provider)}/session/${encodeURIComponent(ref.sessionId)}`;
}

function renderSessions(protocol: SessionProtocol | null, graph: any = null) {
  const relationships = (protocol?.relationships || []).slice(0, 100);
  const rootProvider = protocol?.session?.ref?.provider || "";
  const rows = relationships.map((relationship: any) => {
    const from = relationship.fromRef || { provider: rootProvider, sessionId: relationship.fromSessionId };
    const to = relationship.toRef || { provider: rootProvider, sessionId: relationship.toSessionId };
    const link = (ref: any) => sessionHref(ref) ? `<a href="${escapeHtml(sessionHref(ref))}">${escapeHtml(`${ref.provider}/${ref.sessionId}`)}</a>` : escapeHtml(`${ref.provider || "?"}/${ref.sessionId || "?"}`);
    return `<li class="runtime-session-edge"><span class="runtime-relationship-type">${escapeHtml(relationship.type || t("runtime.unknown"))}</span><span>${link(from)}</span><span aria-hidden="true">→</span><span>${link(to)}</span><small>${escapeHtml(provenanceLabel(relationship.provenance))}</small>${relationship.details ? `<p>${escapeHtml(relationship.details)}</p>` : ""}</li>`;
  });
  const graphNodes = new Map<string, any>((graph?.nodes || []).map((node: any) => [String(node.id), node]));
  const graphMarkup = (graph?.edges || []).slice(0, 100).map((edge: any) => {
    const from = graphNodes.get(String(edge.from));
    const to = graphNodes.get(String(edge.to));
    return `<div class="runtime-graph-edge"><span class="runtime-graph-node runtime-graph-node-${escapeHtml(from?.resolution || "missing")}">${escapeHtml(from?.label || edge.from)}</span><span aria-hidden="true">→</span><span class="runtime-graph-node runtime-graph-node-${escapeHtml(to?.resolution || "missing")}">${escapeHtml(to?.label || edge.to)}</span><small>${escapeHtml(edge.type || t("runtime.unknown"))}${edge.inferred ? ` · ${escapeHtml(t("runtime.inferred"))}` : ""}</small></div>`;
  }).join("") || `<p class="runtime-empty">${t("runtime.no_relationships")}</p>`;
  return `<section class="runtime-lens runtime-sessions-lens" aria-labelledby="runtime-sessions-title"><div class="runtime-section-heading"><div><h2 id="runtime-sessions-title">${t("runtime.sessions_title")}</h2><p>${t("runtime.sessions_description")}</p></div><span class="runtime-bounded-label">${escapeHtml(`${count(relationships.length)} ${t("runtime.relationships")}`)}</span></div><div class="runtime-session-graph" aria-hidden="true">${graphMarkup}</div><p class="runtime-notice">${t("runtime.sessions_accessible_list")}</p><ul class="runtime-session-edge-list">${rows.length ? rows.join("") : `<li class="runtime-empty">${t("runtime.no_relationships")}</li>`}</ul></section>`;
}

function renderContext(protocol: SessionProtocol | null) {
  const artifacts = (protocol?.contextArtifacts || []).slice(0, 100);
  const events = (protocol?.events || []).filter((event) => event.category === "context" || String(event.normalizedKind || event.kind).startsWith("context.") || String(event.normalizedKind || event.kind).startsWith("memory.")).slice(0, 50);
  return `<section class="runtime-lens runtime-context-lens" aria-labelledby="runtime-context-title"><div class="runtime-section-heading"><div><h2 id="runtime-context-title">${t("runtime.context_title")}</h2><p>${t("runtime.context_description")}</p></div><span class="runtime-bounded-label">${escapeHtml(`${count(artifacts.length)} ${t("runtime.artifacts")}`)}</span></div><div class="runtime-context-grid">${artifacts.length ? artifacts.map((artifact: any) => `<article class="runtime-artifact runtime-card"><div class="runtime-card-heading"><strong>${escapeHtml(artifact.title || artifact.kind || artifact.id)}</strong><span>${escapeHtml(artifact.contentAccess || t("runtime.unknown"))}</span></div><p>${escapeHtml([artifact.kind, artifact.scope, artifact.origin].filter(Boolean).join(" · "))}</p>${artifact.summary ? `<p>${escapeHtml(artifact.summary)}</p>` : ""}<div class="runtime-card-meta">${artifact.redacted ? `<span>${escapeHtml(t("runtime.redacted"))}</span>` : ""}${artifact.sourcePath ? `<code>${escapeHtml(artifact.sourcePath)}</code>` : ""}${evidenceButton("artifact", artifact.id)}</div></article>`).join("") : `<p class="runtime-empty">${t("runtime.no_artifacts")}</p>`}</div><h3>${t("runtime.context_events_title")}</h3><div class="runtime-context-events">${events.length ? events.slice(0, 50).map(renderEvent).join("") : `<p class="runtime-empty">${t("runtime.no_context_events")}</p>`}</div></section>`;
}

function renderEvidenceData(protocol: SessionProtocol | null) {
  return {
    events: (protocol?.events || []).slice(0, 50).map(publicEvent),
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
