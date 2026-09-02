import { t } from "../i18n.js";
import { escapeHtml } from "../markdown.js";
import type { SessionProtocol } from "../providers/shared/session-protocol.js";
import { publicEvent } from "../protocol-runtime.js";
import type {
  ContextProjection,
  CoordinationProjection,
  ExecutionProjection,
  WorkProjection
} from "../protocol-runtime-v3.js";

type RuntimeData = {
  protocol: SessionProtocol | null;
  v3?: { version: 3; completeness?: string; validation?: unknown } | null;
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

function entityLabel(value: any, fallback: string) {
  // Goals record their objective in `description` (title is null); the
  // remaining fields are the entity-label chain for actors/runs/artifacts.
  return value?.title || value?.description || value?.agentPath || value?.agent || value?.model || fallback;
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

function renderWorkProjection(data: RuntimeData) {
  const projection = data.projections?.work;
  if (!projection) return `<section class="runtime-lens"><p class="runtime-empty">${t("runtime.not_recorded")}</p></section>`;
  const goals = projection.goals || [];
  const tasks = projection.tasks || [];
  const relations = projection.dependencies || [];
  const memberships = projection.memberships || [];
  const taskRuns = projection.taskRuns || [];
  return `<section class="runtime-lens runtime-work-lens" aria-labelledby="runtime-work-title">
    <div class="runtime-section-heading"><div><h2 id="runtime-work-title">${t("runtime.work_title")}</h2><p>${t("runtime.work_description")}</p></div>${renderProjectionCoverage(projection)}</div>
    <div class="runtime-projection-overview"><span>${escapeHtml(`${count(goals.length)} ${t("runtime.goals")}`)}</span><span>${escapeHtml(`${count(tasks.length)} ${t("runtime.tasks")}`)}</span><span>${escapeHtml(`${count(relations.length + memberships.length + taskRuns.length)} ${t("runtime.relations")}`)}</span></div>
    <div class="runtime-work-list">
      ${goals.length ? `<section class="runtime-projection-group"><h3>${t("runtime.goals")}</h3><ul>${goals.map((entry) => `<li class="runtime-card runtime-goal"><strong>${escapeHtml(entityLabel(entry.goal, projectionRefLabel(entry.ref)))}</strong><span class="runtime-status">${escapeHtml(entry.goal.status || t("runtime.unknown"))}</span></li>`).join("")}</ul></section>` : ""}
      ${tasks.length ? `<section class="runtime-projection-group"><h3>${t("runtime.tasks")}</h3><ul>${tasks.map((entry) => `<li class="runtime-card runtime-task runtime-swimlane" data-runtime-task-id="${escapeHtml(entry.task.id)}"><strong>${escapeHtml(entityLabel(entry.task, entry.task.id))}</strong><span class="runtime-status">${escapeHtml(entry.task.status || t("runtime.unknown"))}</span>${evidenceButton("task", entry.task.id)}</li>`).join("")}</ul></section>` : ""}
      ${relations.length || memberships.length || taskRuns.length ? `<section class="runtime-projection-group"><h3>${t("runtime.relations")}</h3><ul class="runtime-relation-list">${relations.map((relation) => `<li>${escapeHtml(`${projectionRefLabel(relation.from)} → ${projectionRefLabel(relation.to)}`)} <small>${escapeHtml(provenanceLabel(relation.provenance))}</small></li>`).join("")}${memberships.map((relation) => `<li>${escapeHtml(`${projectionRefLabel(relation.goal)} → ${projectionRefLabel(relation.task)}`)} <small>${escapeHtml(t("runtime.membership"))}</small></li>`).join("")}${taskRuns.map((relation) => `<li>${escapeHtml(`${projectionRefLabel(relation.task)} → ${projectionRefLabel(relation.run)}`)} <small>${escapeHtml(t("runtime.run"))}</small></li>`).join("")}</ul></section>` : ""}
      ${!goals.length && !tasks.length && !relations.length && !memberships.length && !taskRuns.length ? `<p class="runtime-empty">${t("runtime.not_recorded")}</p>` : ""}
    </div>
  </section>`;
}

function renderExecutionProjection(data: RuntimeData) {
  const projection = data.projections?.execution;
  if (!projection) return `<section class="runtime-lens"><p class="runtime-empty">${t("runtime.not_recorded")}</p></section>`;
  const actors = projection.actors || [];
  const runs = projection.runs || [];
  const usage = projection.usage || { requestCount: 0, complete: false, input: null, output: null, total: null };
  const usageValue = (value: number | null) => value == null ? t("runtime.not_recorded") : count(value);
  return `<section class="runtime-lens runtime-execution-lens" aria-labelledby="runtime-execution-title">
    <div class="runtime-section-heading"><div><h2 id="runtime-execution-title">${t("runtime.execution_title")}</h2><p>${t("runtime.execution_description")}</p></div>${renderProjectionCoverage(projection)}</div>
    <div class="runtime-projection-overview"><span>${escapeHtml(`${count(actors.length)} ${t("runtime.actors")}`)}</span><span>${escapeHtml(`${count(runs.length)} ${t("runtime.runs")}`)}</span><span>${escapeHtml(`${count(usage.requestCount)} ${t("runtime.usage_records")}`)}</span></div>
    <section class="runtime-projection-group"><h3>${t("runtime.actors")}</h3>${actors.length ? `<ul>${actors.map((entry) => `<li class="runtime-card"><strong>${escapeHtml(entityLabel(entry.actor, entry.actor.id))}</strong><span>${escapeHtml(entry.actor.kind || t("runtime.unknown"))}</span></li>`).join("")}</ul>` : `<p class="runtime-empty">${t("runtime.not_recorded")}</p>`}</section>
    <section class="runtime-projection-group"><h3>${t("runtime.runs")}</h3>${runs.length ? `<ul>${runs.map((entry) => `<li class="runtime-card runtime-run"><strong>${escapeHtml(entityLabel(entry.run, entry.run.id))}</strong><span>${escapeHtml(entry.run.status || t("runtime.unknown"))}</span>${entry.childSession ? `<a href="${escapeHtml(sessionHref(entry.childSession))}">${escapeHtml(entry.childSession.sessionId)}</a>` : ""}${evidenceButton("run", entry.run.id)}</li>`).join("")}</ul>` : `<p class="runtime-empty">${t("runtime.not_recorded")}</p>`}</section>
    <section class="runtime-usage-summary"><h3>${t("runtime.usage")}</h3><p>${escapeHtml(`${t("runtime.requests")}: ${count(usage.requestCount)} · ${t("runtime.total_tokens")}: ${usageValue(usage.total)}`)}</p><small>${escapeHtml(`${t("runtime.input_tokens")}: ${usageValue(usage.input)} · ${t("runtime.output_tokens")}: ${usageValue(usage.output)} · ${usage.complete ? t("runtime.complete") : t("runtime.incomplete")}`)}</small></section>
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

function renderEvidence(data: RuntimeData) {
  const summary = data.summary || {};
  return `<section class="runtime-lens runtime-evidence-lens" aria-labelledby="runtime-evidence-lens-title"><div class="runtime-section-heading"><div><h2 id="runtime-evidence-lens-title">${t("runtime.evidence_lens_title")}</h2><p>${t("runtime.evidence_lens_description")}</p></div><span class="runtime-completeness">${escapeHtml(summary.completeness || t("runtime.unknown"))}</span></div><div class="runtime-evidence-status"><span>${escapeHtml(`${t("runtime.protocol_status")}: ${summary.completeness || t("runtime.unknown")}`)}</span><span>${escapeHtml(`${t("runtime.count_events")}: ${count(summary.counts?.events)}`)}</span></div>${renderEvents(data)}</section>`;
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
  const notices = [data.runtimeError, data.storageDiagnostic]
    .filter(Boolean)
    .map((notice) => `<p class="runtime-notice runtime-notice-warning"${notice?.code ? ` data-runtime-error="${escapeHtml(String(notice.code))}"` : ""}>${escapeHtml(String(notice?.message || notice?.code || notice))}</p>`)
    .join("");
  return `<section class="runtime-workbench" data-runtime-root data-runtime-provider="${escapeHtml(provider)}" data-runtime-session-id="${escapeHtml(sessionId)}" data-runtime-available="${protocol ? "true" : "false"}">
    <header class="runtime-header"><div><h2>${t("runtime.title")}</h2><p>${t("runtime.description")}</p></div><span class="runtime-version">v${escapeHtml(String(data.v3?.version || protocol?.version || summary.version || 2))}</span></header>
    ${notices}
    <div class="runtime-lens-tabs" role="tablist" aria-label="${escapeHtml(t("runtime.lenses_label"))}">${[ ["work", t("runtime.lens_work")], ["execution", t("runtime.lens_execution")], ["coordination", t("runtime.lens_coordination")], ["context", t("runtime.lens_context")], ["evidence", t("runtime.lens_evidence")] ].map(([id, label], index) => `<button id="runtime-lens-tab-${id}" type="button" role="tab" data-runtime-lens="${id}" aria-controls="runtime-lens-${id}" aria-selected="${index === 0 ? "true" : "false"}" tabindex="${index === 0 ? "0" : "-1"}">${label}</button>`).join("")}</div>
    <div id="runtime-lens-work" class="runtime-lens-panel" role="tabpanel" aria-labelledby="runtime-lens-tab-work" data-runtime-panel="work" tabindex="0">${renderWorkProjection(data)}</div>
    <div id="runtime-lens-execution" class="runtime-lens-panel" role="tabpanel" aria-labelledby="runtime-lens-tab-execution" data-runtime-panel="execution" tabindex="0" hidden>${renderExecutionProjection(data)}</div>
    <div id="runtime-lens-coordination" class="runtime-lens-panel" role="tabpanel" aria-labelledby="runtime-lens-tab-coordination" data-runtime-panel="coordination" tabindex="0" hidden>${renderCoordinationProjection(data)}</div>
    <div id="runtime-lens-context" class="runtime-lens-panel" role="tabpanel" aria-labelledby="runtime-lens-tab-context" data-runtime-panel="context" tabindex="0" hidden>${renderContextProjection(data)}</div>
    <div id="runtime-lens-evidence" class="runtime-lens-panel" role="tabpanel" aria-labelledby="runtime-lens-tab-evidence" data-runtime-panel="evidence" tabindex="0" hidden>${renderEvidence(data)}</div>
    <script type="application/json" data-runtime-evidence>${jsonScript(renderEvidenceData(protocol))}</script>
    <dialog class="runtime-evidence-drawer" data-runtime-drawer aria-labelledby="runtime-drawer-title"><form method="dialog"><button type="submit" class="runtime-drawer-close" aria-label="${escapeHtml(t("runtime.evidence_close"))}">×</button></form><h2 id="runtime-drawer-title">${t("runtime.evidence_title")}</h2><p data-runtime-drawer-summary></p><dl data-runtime-drawer-details></dl></dialog>
  </section>`;
}
