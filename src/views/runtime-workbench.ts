import { t } from "../i18n.js";
import { escapeHtml } from "../markdown.js";
import { summarizeEvent } from "../event-summary.js";
import type { SessionProtocol } from "../providers/shared/session-protocol.js";
import { publicEvent } from "../protocol-runtime.js";
import type {
  ContextProjection,
  CoordinationProjection,
  ExecutionProjection,
  RunActorBindings,
  RunPage,
  WorkProjection
} from "../protocol-runtime-v3.js";
import { DEFAULT_RUN_PAGE_SIZE } from "../protocol-runtime-v3.js";
import { deriveWorkOverview, type WorkOverviewTask } from "../work-view-model.js";
import type { SessionProtocolV3 } from "../providers/shared/session-protocol-v3.js";
import { formatLocalizedDurationMs } from "./components.js";

type RuntimeData = {
  protocol: SessionProtocol | null;
  v3?: SessionProtocolV3 | null;
  projections?: {
    work: WorkProjection;
    execution: ExecutionProjection;
    coordination: CoordinationProjection;
    context: ContextProjection;
  } | null;
  runPage?: RunPage | null;
  runPageError?: { code?: string; message: string } | null;
  runActorBindings?: RunActorBindings | null;
  summary: any;
  eventNextCursor?: string | null;
  runCursor?: string | null;
  storageDiagnostic?: any;
  runtimeError?: any;
};

type RuntimeLanePresentation = {
  taskLabels?: Map<string, string>;
  coordination?: SessionProtocolV3["coordination"];
  transformations?: SessionProtocolV3["contextTransformations"];
  artifacts?: SessionProtocolV3["contextArtifacts"];
  truncated?: boolean;
};

function jsonScript(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function count(value: unknown) {
  return (Number(value) || 0).toLocaleString();
}

function dateTime(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? new Date(number).toISOString() : "";
}

function timeLabel(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? new Date(number).toLocaleString() : t("runtime.unknown_time");
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

function runtimeEntityAttributes(kind: string, id: string, extra: Record<string, string | null | undefined> = {}) {
  const attributes = [`data-runtime-entity-kind="${escapeHtml(kind)}"`, `data-runtime-entity-id="${escapeHtml(id)}"`];
  for (const [name, value] of Object.entries(extra)) {
    if (value != null && value !== "") attributes.push(`${name}="${escapeHtml(value)}"`);
  }
  return attributes.join(" ");
}

function runtimeSelectButton(kind: string, id: string, label: string) {
  return `<button type="button" class="runtime-entity-select" data-runtime-select-kind="${escapeHtml(kind)}" data-runtime-select-id="${escapeHtml(id)}">${escapeHtml(label)}</button>`;
}

function eventEvidenceButton(id: string) {
  return `<button type="button" class="runtime-evidence-trigger" data-runtime-event-evidence-id="${escapeHtml(id)}" aria-label="${escapeHtml(t("runtime.evidence_open"))}">${escapeHtml(t("runtime.evidence"))}</button>`;
}

function entityLabel(value: any, fallback: string) {
  // Goals record their objective in `description` (title is null); the
  // remaining fields are the entity-label chain for actors/runs/artifacts.
  return value?.title || value?.name || value?.description || value?.agentPath || value?.agent || value?.model || fallback;
}

function statusLabel(value: unknown) {
  const status = String(value || "unknown");
  const key = `runtime.status_${status}`;
  return t(key) === key ? status : t(key);
}

function executionModeLabel(value: unknown) {
  const mode = String(value || "unknown");
  const key = `runtime.mode_${mode}`;
  return t(key) === key ? mode : t(key);
}

function runtimeRunLabel(run: any, taskLabel = "") {
  return run?.kind === "session-turn"
    ? t("runtime.session_turn")
    : (typeof run?.label === "string" && run.label.trim())
      ? narrativeExcerpt(run.label.trim(), GOAL_TITLE_LIMIT).text
      : (taskLabel ? narrativeExcerpt(taskLabel, GOAL_TITLE_LIMIT).text : t("runtime.recorded_run"));
}

function validRuntimeTime(value: number | null) {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

function renderRunTiming(run: any) {
  const start = validRuntimeTime(run?.timeStart);
  const end = validRuntimeTime(run?.timeEnd);
  if (start !== null && end !== null && end >= start) {
    return `<small class="runtime-run-time" data-runtime-run-time="complete"><time datetime="${escapeHtml(dateTime(start))}">${escapeHtml(`${t("runtime.start")}: ${timeLabel(start)}`)}</time><span> · </span><time datetime="${escapeHtml(dateTime(end))}">${escapeHtml(`${t("runtime.end")}: ${timeLabel(end)}`)}</time><span> · ${escapeHtml(`${t("runtime.elapsed")}: ${durationLabel(end - start)}`)}</span></small>`;
  }
  if (start !== null || end !== null) {
    const point = start !== null ? `${t("runtime.start")}: ${timeLabel(start)}` : `${t("runtime.end")}: ${timeLabel(end)}`;
    return `<small class="runtime-run-time" data-runtime-run-time="partial">${escapeHtml(point)} · ${escapeHtml(t("runtime.partial_time"))}</small>`;
  }
  return `<small class="runtime-run-order-note">${escapeHtml(t("runtime.run_display_order_unrecorded"))}</small>`;
}

function durationLabel(value: number | null) {
  if (value == null) return t("runtime.not_recorded");
  const duration = formatLocalizedDurationMs(value);
  if (!duration) return `0${t("runtime.seconds_short")}`;
  return duration;
}

const GOAL_TITLE_LIMIT = 96;
const GOAL_DESCRIPTION_LIMIT = 280;
const CONTEXT_SUMMARY_LIMIT = 280;
const EVENT_DENSITY_LIMIT = 1000;
const LONG_LIVED_CONTEXT_KINDS = new Set(["memory", "experience", "user-info"]);
const CONTEXT_ASSET_SCOPE_ORDER = ["session", "agent", "project", "user", "organization"];

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
    <details class="runtime-events-structure"><summary>${t("runtime.event_density")}</summary>${renderEventDensity((protocol?.events || []).slice(0, EVENT_DENSITY_LIMIT), protocol?.events?.length || 0)}<p>${t("runtime.events_structure_hint")}</p></details>
    <form class="runtime-event-filters" data-runtime-event-filters><label>${t("runtime.filter_category")}<select data-runtime-event-category><option value="">${t("runtime.all_categories")}</option>${["session", "message", "model", "reasoning", "tool", "task", "run", "context", "control", "team", "unknown"].map((category) => `<option value="${category}">${category}</option>`).join("")}</select></label><label class="runtime-filter-search">${t("runtime.filter_text")}<input type="search" data-runtime-event-search placeholder="${escapeHtml(t("runtime.filter_text_placeholder"))}"></label><button type="submit" class="btn">${t("runtime.apply_filter")}</button></form>
    <div class="runtime-events-focus-filter" data-runtime-events-focus-filter hidden><span data-runtime-events-focus-filter-label></span><button type="button" class="btn" data-runtime-events-clear-filter>${escapeHtml(t("runtime.clear_linked_filter"))}</button></div>
    <p class="runtime-results-status" data-runtime-events-status aria-live="polite">${escapeHtml(t("runtime.events_loaded", { count: String(events.length) }))}</p>
    <div class="runtime-event-table-wrap"><table class="runtime-events-table"><thead><tr><th scope="col">${t("runtime.event_sequence")}</th><th scope="col">${t("runtime.event_time")}</th><th scope="col">${t("runtime.event_type_summary")}</th><th scope="col">${t("runtime.event_origin")}</th><th scope="col">${t("runtime.evidence")}</th></tr></thead><tbody data-runtime-event-list>${events.length ? events.map(renderEvent).join("") : `<tr><td colspan="5" class="runtime-empty">${t("runtime.no_events")}</td></tr>`}</tbody></table></div>
    <div class="runtime-pagination"><button type="button" class="btn" data-runtime-events-previous disabled>${t("runtime.previous")}</button><button type="button" class="btn" data-runtime-events-next data-runtime-next-cursor="${escapeHtml(data.eventNextCursor || "")}" ${data.eventNextCursor ? "" : "disabled"}>${t("runtime.next")}</button></div>
  </section>`;
}

function sessionHref(ref: any, returnTo = "") {
  if (!ref?.provider || !ref?.sessionId) return "";
  const href = `/${encodeURIComponent(ref.provider)}/session/${encodeURIComponent(ref.sessionId)}`;
  return returnTo ? `${href}?from=${encodeURIComponent(returnTo)}` : href;
}

function runtimeParentHref(provider: string, sessionId: string, runId: string, runCursor: string | null, pageSize: number) {
  const query = new URLSearchParams({ runtimeLens: "execution", runtimeRun: runId, runLimit: String(pageSize) });
  if (runCursor) query.set("runCursor", runCursor);
  return `/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}?${query}`;
}

function localizedRuntimeValue(prefix: string, value: unknown) {
  const raw = String(value || "");
  const key = `${prefix}_${raw}`;
  return t(key) === key ? raw : t(key);
}

function renderContextAssetRelations(asset: any, id: string, projection: any) {
  const relations: string[] = [evidenceButton("artifact", id)];
  const sessions = (projection.artifactSessions || []).filter((entry: any) => projectionRefLabel(entry.artifact) === id);
  for (const relation of sessions) {
    const source = relation.sourceSession;
    const href = sessionHref(source);
    if (!href) continue;
    relations.push(`<span class="runtime-context-asset-relation"><span>${escapeHtml(t("runtime.context_asset_source_session"))}</span> <a href="${escapeHtml(href)}">${escapeHtml(`${source.provider}/${source.sessionId}`)}</a></span>`);
  }
  const runs = (projection.artifactRuns || []).filter((entry: any) => projectionRefLabel(entry.artifact) === id);
  const runIds = new Set<string>();
  if (asset.producerRunId) runIds.add(String(asset.producerRunId));
  for (const relation of runs) {
    const runId = projectionRefLabel(relation.run);
    if (!runId || runId === t("runtime.not_recorded")) continue;
    if (runIds.has(runId)) continue;
    runIds.add(runId);
  }
  for (const runId of runIds) {
    const relation = runs.find((entry: any) => projectionRefLabel(entry.run) === runId);
    const label = String(asset.producerRunId || "") === runId || relation?.role !== "consumer"
      ? t("runtime.context_asset_source_run")
      : t("runtime.context_asset_consumer_run");
    relations.push(`<span class="runtime-context-asset-relation">${evidenceButton("run", runId, label)}</span>`);
  }
  const events = (projection.artifactEvents || []).filter((entry: any) => projectionRefLabel(entry.artifact) === id);
  const eventIds = new Set<string>();
  if (asset.producerEventId) eventIds.add(String(asset.producerEventId));
  for (const relation of events) {
    const eventId = projectionRefLabel(relation.event);
    if (!eventId || eventId === t("runtime.not_recorded")) continue;
    if (eventIds.has(eventId)) continue;
    eventIds.add(eventId);
  }
  for (const eventId of eventIds) {
    const relation = events.find((entry: any) => projectionRefLabel(entry.event) === eventId);
    const label = String(asset.producerEventId || "") === eventId || relation?.role !== "citation"
      ? t("runtime.context_asset_source_event")
      : t("runtime.context_asset_citation_event");
    relations.push(`<span class="runtime-context-asset-relation">${evidenceButton("event", eventId, label)}</span>`);
  }
  const inherited = (projection.artifactInheritance || []).filter((entry: any) => projectionRefLabel(entry.artifact) === id);
  for (const relation of inherited) {
    const parentId = projectionRefLabel(relation.parentArtifact);
    if (!parentId || parentId === t("runtime.not_recorded")) continue;
    relations.push(`<span class="runtime-context-asset-relation">${evidenceButton("artifact", parentId, t("runtime.context_asset_inherited"))}</span>`);
  }
  return relations.length ? `<div class="runtime-context-asset-relations">${relations.join(" ")}</div>` : "";
}

function renderContextAssets(projection: any) {
  const entries = (projection.artifacts || []).filter((entry: any) => LONG_LIVED_CONTEXT_KINDS.has(entry.artifact?.kind));
  const groups = CONTEXT_ASSET_SCOPE_ORDER
    .map((scope) => ({ scope, items: entries.filter((entry: any) => entry.artifact.scope === scope) }))
    .filter((group) => group.items.length);
  const boundedNote = projection.truncated && entries.length
    ? t("runtime.context_assets_bounded", { count: count(entries.length) })
    : "";
  const empty = entries.length
    ? ""
    : `<p class="runtime-empty runtime-context-assets-empty" data-runtime-context-assets-empty>${escapeHtml(t(projection.truncated ? "runtime.context_assets_empty_bounded" : "runtime.context_assets_empty"))}</p>`;
  const groupsMarkup = groups.map((group) => `<section class="runtime-context-asset-scope" data-runtime-context-asset-scope="${escapeHtml(group.scope)}"><h4>${escapeHtml(localizedRuntimeValue("runtime.context_asset_scope", group.scope))}</h4><ul>${group.items.map((entry: any) => {
    const id = projectionRefLabel(entry.ref);
    const asset = entry.artifact || {};
    const kind = localizedRuntimeValue("runtime.context_asset_kind", asset.kind);
    const title = typeof asset.title === "string" && asset.title.trim() ? asset.title.trim() : kind;
    const origin = localizedRuntimeValue("runtime.context_asset_origin", asset.origin);
    const access = localizedRuntimeValue("runtime.context_asset_access", asset.contentAccess);
    const created = asset.timeCreated == null ? t("runtime.unknown_time") : timeLabel(asset.timeCreated);
    const summary = typeof asset.summary === "string" && asset.summary.trim() ? `<p class="runtime-context-asset-summary">${escapeHtml(asset.summary.trim())}</p>` : "";
    const time = asset.timeCreated == null ? escapeHtml(created) : `<time datetime="${escapeHtml(dateTime(asset.timeCreated))}">${escapeHtml(created)}</time>`;
    const sourcePath = typeof asset.sourcePath === "string" && asset.sourcePath.trim()
      ? `<span>${escapeHtml(`${t("runtime.context_asset_source_path")}: `)}${escapeHtml(asset.sourcePath.trim())}</span>`
      : "";
    return `<li class="runtime-card runtime-context-asset" data-runtime-context-asset data-asset-kind="${escapeHtml(asset.kind)}" data-asset-scope="${escapeHtml(asset.scope)}" data-asset-id="${escapeHtml(id)}"><div class="runtime-context-asset-heading"><strong>${escapeHtml(title)}</strong><span class="runtime-context-asset-kind">${escapeHtml(kind)}</span></div><div class="runtime-context-asset-meta"><span>${escapeHtml(origin)}</span><span>${escapeHtml(access)}</span><span>${escapeHtml(`${t("runtime.context_asset_created")}: `)}${time}</span>${sourcePath}</div>${summary}${renderContextAssetRelations(asset, id, projection)}</li>`;
  }).join("")}</ul></section>`).join("");
  return `<details class="runtime-context-assets" data-runtime-context-assets><summary><span>${escapeHtml(t("runtime.context_assets_title"))}</span><small>${escapeHtml(t("runtime.context_assets_description"))}</small></summary><div class="runtime-context-assets-body">${groupsMarkup}${empty}${boundedNote ? `<p class="runtime-notice runtime-context-assets-bounded" data-runtime-context-assets-bounded>${escapeHtml(boundedNote)}</p>` : ""}</div></details>`;
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
  // A task/run pair can repeat the same recorded state; keep the first
  // normalized label and retain every distinct state in recorded order.
  const states = [...new Set([task.task.status, ...task.runs.map((run) => run.status)].map(statusLabel))];
  const activity = task.latestActivity == null
    ? t("runtime.not_recorded")
    : `${t("runtime.last_activity")}: ${timeLabel(task.latestActivity)}`;
  const elapsed = task.elapsedMs == null ? "" : `${t("runtime.elapsed")}: ${durationLabel(task.elapsedMs)}`;
  const runLinks = task.runs.length
    ? `<span class="runtime-task-runs" data-runtime-linked-runs>${task.runs.map((run) => runtimeSelectButton("run", run.id, runtimeRunLabel(run))).join(" ")}</span>`
    : `<span class="runtime-unlinked" data-runtime-task-runs-unlinked>${escapeHtml(t("runtime.not_recorded"))}</span>`;
  return `<tr data-runtime-overview-task="${escapeHtml(task.id)}" ${runtimeEntityAttributes("task", task.id)}><th scope="row">${runtimeSelectButton("task", task.id, taskTitle(task.task))}${task.task.agentPath && task.task.title ? `<small>${escapeHtml(task.task.agentPath)}</small>` : ""}</th><td data-label="${escapeHtml(t("runtime.task_owner"))}">${escapeHtml(task.owner || t("runtime.not_recorded"))}</td><td data-label="${escapeHtml(t("runtime.task_state"))}"><span class="runtime-status runtime-status-${escapeHtml(statusClass(task.task.status))}">${escapeHtml(states.join(" · "))}</span></td><td data-label="${escapeHtml(t("runtime.task_activity"))}">${escapeHtml(elapsed || activity)}${elapsed ? `<small>${escapeHtml(activity)}</small>` : ""}</td><td data-label="${escapeHtml(t("runtime.runs"))}">${runLinks} ${evidenceButton("task", task.id, t("runtime.evidence"))}</td></tr>`;
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
  const inventory = model.taskTotal
    ? `<details class="runtime-task-inventory"><summary><strong>${escapeHtml(t("runtime.task_table_title"))}</strong><span>${escapeHtml(`${count(model.taskTotal)} ${t("runtime.tasks")}`)}</span></summary><p>${escapeHtml(t("runtime.task_table_description"))}</p><table class="runtime-overview-task-table">${renderOverviewTaskHead()}<tbody>${rows}</tbody></table>${hidden}</details>`
    : `<p class="runtime-empty">${t("runtime.no_tasks_recorded")}</p>`;
  return `<section class="runtime-work-tasks" aria-labelledby="runtime-work-tasks-title"><h3 id="runtime-work-tasks-title" class="runtime-visually-hidden">${t("runtime.task_table_title")}</h3>${inventory}</section>`;
}

function graphNodeLabel(node: { label: string | null; kind: string }, index: number) {
  if (node.label) return node.label;
  if (node.kind === "goal") return t("runtime.goal_not_recorded");
  return `${t("runtime.task")} ${index + 1}`;
}

function graphNodeDisplayLabel(node: { label: string | null; kind: string }, index: number) {
  const fullLabel = graphNodeLabel(node, index);
  // The orientation owns the full recorded goal narrative; keep its graph
  // node a compact anchor so the same long text is not repeated in the graph.
  const excerpt = narrativeExcerpt(fullLabel, node.kind === "goal" ? 48 : 140);
  return { fullLabel, excerpt };
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
  const tasksById = new Map(model.tasks.map((task) => [task.id, task]));
  const allNodes = [...graph.nodes, ...graph.completedNodes];
  const nodeIndex = new Map(allNodes.map((node, index) => [node.id, index]));
  const nodeFor = (id: string) => {
    const index = nodeIndex.get(id);
    return index === undefined ? null : { node: allNodes[index], index };
  };
  const renderNode = (node: (typeof allNodes)[number], index: number, completed = false) => {
    const { fullLabel, excerpt } = graphNodeDisplayLabel(node, index);
    const taskRuns = node.kind === "task" ? tasksById.get(node.id)?.runs || [] : [];
    const linkedRuns = taskRuns.length
      ? `<small class="runtime-graph-node-runs"><span>${escapeHtml(t("runtime.runs"))}:</span>${taskRuns.slice(0, 3).map((run) => runtimeSelectButton("run", run.id, runtimeRunLabel(run))).join(" ")}${taskRuns.length > 3 ? ` <span>+${count(taskRuns.length - 3)}</span>` : ""}</small>`
      : "";
    const completeGoal = !completed && node.kind === "goal" && excerpt.truncated
      ? `<details class="runtime-graph-node-details"><summary>${escapeHtml(t("runtime.show_complete_goal"))}</summary><p>${escapeHtml(fullLabel)}</p></details>`
      : "";
    const attrs = completed
      ? runtimeEntityAttributes(node.kind, node.id, { "data-runtime-completed-task": "true" })
      : runtimeEntityAttributes(node.kind, node.id);
    return `<article class="runtime-graph-node runtime-graph-node-${escapeHtml(node.kind)}${completed ? " runtime-completed-work-node" : ""}" data-runtime-graph-node data-runtime-node-kind="${escapeHtml(node.kind)}" data-runtime-node-id="${escapeHtml(node.id)}" ${attrs} aria-label="${escapeHtml(`${fullLabel} · ${statusLabel(node.state)}`)}"><strong>${runtimeSelectButton(node.kind, node.id, excerpt.text)}</strong>${completeGoal}<span class="runtime-status runtime-status-${escapeHtml(statusClass(node.state))}">${escapeHtml(statusLabel(node.state))}</span>${linkedRuns}${evidenceButton(node.kind, node.id, t("runtime.evidence"))}</article>`;
  };
  const nodeMarkup = graph.nodes.map((node) => renderNode(node, nodeIndex.get(node.id) || 0)).join("");
  const edgeMarkup = graph.edges.map((edge) => {
    const from = nodeFor(edge.from);
    const to = nodeFor(edge.to);
    if (!from || !to) return "";
    return `<li class="runtime-graph-edge" data-runtime-graph-edge data-runtime-edge-kind="${escapeHtml(edge.kind)}" data-runtime-edge-from-kind="${escapeHtml(from.node.kind)}" data-runtime-edge-to-kind="${escapeHtml(to.node.kind)}" data-runtime-edge-from="${escapeHtml(edge.from)}" data-runtime-edge-to="${escapeHtml(edge.to)}"><span>${escapeHtml(graphNodeLabel(from.node, from.index))}</span><span class="runtime-graph-connector" aria-hidden="true">→</span><span>${escapeHtml(graphNodeLabel(to.node, to.index))}</span><small>${escapeHtml(t(edge.kind === "membership" ? "runtime.graph_membership" : "runtime.graph_dependency"))}</small>${renderGraphEvidence(edge)}</li>`;
  }).join("");
  const completedEdgeMarkup = graph.completedEdges.map((edge) => {
    const from = nodeFor(edge.from);
    const to = nodeFor(edge.to);
    if (!from || !to) return "";
    return `<li class="runtime-graph-edge runtime-completed-work-edge" data-runtime-graph-edge data-runtime-edge-kind="${escapeHtml(edge.kind)}" data-runtime-edge-from-kind="${escapeHtml(from.node.kind)}" data-runtime-edge-to-kind="${escapeHtml(to.node.kind)}" data-runtime-edge-from="${escapeHtml(edge.from)}" data-runtime-edge-to="${escapeHtml(edge.to)}"><span>${escapeHtml(graphNodeLabel(from.node, from.index))}</span><span class="runtime-graph-connector" aria-hidden="true">→</span><span>${escapeHtml(graphNodeLabel(to.node, to.index))}</span><small>${escapeHtml(t(edge.kind === "membership" ? "runtime.graph_membership" : "runtime.graph_dependency"))}</small>${renderGraphEvidence(edge)}</li>`;
  }).join("");
  const completedDisclosure = graph.completedNodes.length
    ? `<details class="runtime-completed-work" data-runtime-completed-work><summary>${escapeHtml(t("runtime.graph_completed_summary", { shown: count(graph.completedNodes.length), total: count(graph.completedKnownTotal) }))}</summary><p class="runtime-graph-description">${escapeHtml(t("runtime.graph_completed_description"))}</p>${graph.completedOmitted ? `<p class="runtime-notice runtime-completed-work-omitted">${escapeHtml(t("runtime.graph_completed_omitted", { count: count(graph.completedOmitted) }))}</p>` : ""}<div class="runtime-completed-work-nodes">${graph.completedNodes.map((node) => renderNode(node, nodeIndex.get(node.id) || 0, true)).join("")}</div><details class="runtime-graph-edge-details runtime-completed-work-edges"><summary>${escapeHtml(t("runtime.graph_completed_edges", { count: count(graph.completedEdges.length) }))}</summary><ul class="runtime-graph-edge-list" data-runtime-completed-graph-relationships="goal">${completedEdgeMarkup || `<li class="runtime-empty">${escapeHtml(t("runtime.graph_no_edges"))}</li>`}</ul></details></details>`
    : "";
  const noGoal = !model.goal;
  const empty = !graph.nodes.length && !graph.completedNodes.length
    ? `<p class="runtime-empty">${escapeHtml(t(noGoal ? "runtime.graph_no_goal_or_tasks" : "runtime.graph_no_goal_tasks"))}</p>`
    : noGoal
      ? `<p class="runtime-notice">${escapeHtml(t("runtime.graph_tasks_without_goal"))}</p>`
      : graph.unlinkedTasks
        ? `<p class="runtime-notice">${escapeHtml(t("runtime.graph_unlinked_tasks", { count: count(graph.unlinkedTasks) }))}</p>`
        : "";
  const viewAll = graph.omitted > 0 || graph.completedOmitted > 0 || graph.incomplete
    ? `<button type="button" class="runtime-graph-view-all" data-runtime-goal-view-all>${escapeHtml(t("runtime.graph_view_all_tasks"))}</button>`
    : "";
  return `<div id="runtime-graph-panel-goal" class="runtime-graph-panel" role="region" aria-label="${escapeHtml(t("runtime.goal_task_graph_title"))}" data-runtime-graph-panel="goal"><h4>${t("runtime.goal_task_graph_title")}</h4>${empty}<div class="runtime-graph-canvas" role="group" data-runtime-graph-canvas="goal" aria-label="${escapeHtml(t("runtime.goal_task_graph_label"))}"><svg class="runtime-graph-links" data-runtime-graph-links aria-hidden="true"></svg><div class="runtime-graph-node-list">${nodeMarkup}</div><details class="runtime-graph-edge-details"><summary>${escapeHtml(t("runtime.graph_evidence_count", { count: count(graph.edges.length) }))}</summary><ul class="runtime-graph-edge-list" data-runtime-graph-relationships="goal">${edgeMarkup || `<li class="runtime-empty">${escapeHtml(t("runtime.graph_no_edges"))}</li>`}</ul></details>${completedDisclosure}</div>${renderGraphBoundNotice(graph, "goal")}${viewAll}</div>`;
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
  const nodeMarkup = graph.nodes.map((node, index) => { const teamGroup = node.kind === "team" ? node.id : node.teamId; return `<article class="runtime-graph-node runtime-graph-node-${escapeHtml(node.kind)}" data-runtime-graph-node data-runtime-node-kind="${escapeHtml(node.kind)}" data-runtime-node-id="${escapeHtml(node.id)}" ${runtimeEntityAttributes("actor", node.id)}${teamGroup ? ` data-runtime-team-group="${escapeHtml(teamGroup)}"` : ""} aria-label="${escapeHtml(collaborationNodeLabel(node, index))}"><strong>${runtimeSelectButton("actor", node.id, collaborationNodeLabel(node, index))}</strong><span>${escapeHtml(t(node.kind === "team" ? "runtime.team" : "runtime.agent"))}</span>${evidenceButton("actor", node.id, t("runtime.evidence"))}</article>`; }).join("");
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
    return `<li class="runtime-graph-edge${edge.async ? " runtime-graph-edge-async" : ""}" data-runtime-graph-edge data-runtime-edge-kind="${escapeHtml(edge.kind)}" data-runtime-edge-from-kind="actor" data-runtime-edge-to-kind="actor" data-runtime-edge-from="${escapeHtml(edge.from)}" data-runtime-edge-to="${escapeHtml(edge.to)}" data-runtime-edge-async="${edge.async ? "true" : "false"}"><span>${escapeHtml(collaborationNodeLabel(from.node, from.index))}</span><span class="runtime-graph-connector" aria-hidden="true">→</span><span>${escapeHtml(collaborationNodeLabel(to.node, to.index))}</span><small>${escapeHtml(edgeLabel(edge))}${edge.async ? ` · ${escapeHtml(t("runtime.graph_async_recorded"))}` : ""}</small>${renderGraphEvidence(edge)}</li>`;
  }).join("");
  const empty = !graph.nodes.length ? `<p class="runtime-empty">${escapeHtml(t("runtime.graph_no_actors"))}</p>` : !graph.edges.length ? `<p class="runtime-notice">${escapeHtml(t("runtime.graph_no_edges"))}</p>` : "";
  const unplaced = graph.unplacedObservations ? `<p class="runtime-notice" data-runtime-unplaced-observations>${escapeHtml(t("runtime.graph_unplaced_observations", { count: count(graph.unplacedObservations) }))}</p>` : "";
  const viewAll = graph.omitted ? `<a class="runtime-graph-view-all" data-runtime-agent-view-all data-detail-tab="tab-conversation" href="#tab-conversation">${escapeHtml(t("runtime.graph_view_all_agents"))}</a>` : "";
  return `<div id="runtime-graph-panel-collaboration" class="runtime-graph-panel" role="region" aria-label="${escapeHtml(t("runtime.collaboration_graph_title"))}" data-runtime-graph-panel="collaboration"><h4>${t("runtime.collaboration_graph_title")}</h4>${empty}${unplaced}<div class="runtime-graph-canvas" role="group" data-runtime-graph-canvas="collaboration" aria-label="${escapeHtml(t("runtime.collaboration_graph_label"))}"><svg class="runtime-graph-links" data-runtime-graph-links aria-hidden="true"></svg><div class="runtime-graph-node-list">${nodeMarkup}</div><details class="runtime-graph-edge-details"><summary>${escapeHtml(t("runtime.graph_evidence_count", { count: count(graph.edges.length) }))}</summary><ul class="runtime-graph-edge-list" data-runtime-graph-relationships="collaboration">${edgeMarkup || `<li class="runtime-empty">${escapeHtml(t("runtime.graph_no_edges"))}</li>`}</ul></details></div>${renderGraphBoundNotice(graph, "agent")}${viewAll}</div>`;
}

function renderWorkStructure(model: ReturnType<typeof deriveWorkOverview>) {
  return `<section class="runtime-work-structure" aria-labelledby="runtime-work-structure-title"><div class="runtime-overview-section-heading"><div><h3 id="runtime-work-structure-title">${t("runtime.work_structure_title")}</h3></div></div><div class="runtime-graph-panels">${renderGoalTaskGraph(model)}${renderCollaborationGraph(model)}</div></section>`;
}

function renderWorkOverview(data: RuntimeData, executionLanes: string) {
  const projections = data.projections;
  const protocol = data.v3;
  if (!protocol || !projections) return `<section class="runtime-work-overview" data-runtime-work-overview><p class="runtime-empty">${escapeHtml(t("runtime.work_overview_unavailable"))}</p>${executionLanes}</section>`;
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
  const goalState = goal ? statusLabel(goal.status) : statusLabel("unknown");
  const sessionState = statusLabel(model.sessionState);
  const orientationUpdated = model.sessionUpdatedAt == null ? t("runtime.unknown_time") : timeLabel(model.sessionUpdatedAt);
  const orientation = `<div class="runtime-orientation-strip" data-runtime-orientation><div class="runtime-orientation-goal"><span class="runtime-orientation-label">${escapeHtml(t("runtime.goal_title"))}</span><h4>${escapeHtml(goalTitle.text)}</h4>${goalDescription ? `<span class="runtime-orientation-goal-description">${escapeHtml(goalDescription.text)}</span>` : ""}${fullGoalNarrative}${!goal ? `<span class="runtime-notice">${escapeHtml(t("runtime.goal_not_recorded_detail"))}</span>` : ""}</div><div class="runtime-orientation-meta" aria-label="${escapeHtml(t("runtime.orientation_summary"))}"><span><b>${escapeHtml(t("runtime.goal_state"))}</b> <span class="runtime-status runtime-status-${escapeHtml(statusClass(goalStatus))}" data-runtime-goal-state>${escapeHtml(goalState)}</span></span><span><b>${escapeHtml(t("runtime.session_state"))}</b> <span class="runtime-status runtime-status-${escapeHtml(statusClass(model.sessionState))}" data-runtime-session-state>${escapeHtml(sessionState)}</span></span><span><b>${escapeHtml(t("detail.updated"))}</b> ${escapeHtml(orientationUpdated)}</span><span><b>${escapeHtml(t("runtime.tasks"))}</b> ${escapeHtml(`${count(model.completedTasks)} / ${count(model.taskTotal)}`)}</span><span class="runtime-orientation-progress"><b>${escapeHtml(t("runtime.progress_title"))}</b> ${escapeHtml(progressSentence)}</span></div></div>`;
  return `<section class="runtime-work-overview" data-runtime-work-overview aria-labelledby="runtime-work-overview-title"><h3 id="runtime-work-overview-title" class="visually-hidden">${escapeHtml(t("runtime.goal_title"))}</h3>${orientation}<div class="runtime-work-progress" data-runtime-progress><div class="runtime-progress-track" role="progressbar" aria-label="${escapeHtml(t("runtime.progress_title"))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${ratio}"><span style="width:${ratio}%"></span></div>${boundedNote}</div>${renderWorkStructure(model)}${executionLanes}<div class="runtime-work-overview-grid">${renderContextResult(data, model)}${renderOverviewTaskTable(model)}</div><span data-runtime-overview-end aria-hidden="true"></span></section>`;
}

/** Build the lane evidence from the requested page first, then apply bounds. */
export function projectRuntimeLanePresentation(protocol: SessionProtocolV3, runEntries: readonly RunPage["runs"][number][]): RuntimeLanePresentation {
  const runIds = new Set(runEntries.map((entry) => entry.run?.id).filter(Boolean));
  const taskIds = new Set(runEntries.map((entry) => entry.task?.kind === "task" ? entry.task.id : entry.run?.taskId).filter(Boolean));
  const taskLabels = new Map<string, string>();
  protocol.tasks.forEach((task) => {
    if (task.id && taskIds.has(task.id) && task.title) taskLabels.set(task.id, narrativeExcerpt(String(task.title), GOAL_TITLE_LIMIT).text);
  });
  const eligibleCoordination = protocol.coordination.filter((observation) => (
    (observation.runId && runIds.has(observation.runId))
    || (!observation.runId && observation.taskId && taskIds.has(observation.taskId))
  ));
  const eligibleTransformations = protocol.contextTransformations.filter((transformation) => transformation.runId && runIds.has(transformation.runId));
  const coordination = eligibleCoordination.slice(0, 100);
  const transformations = eligibleTransformations.slice(0, 100);
  const resultIds = new Set(transformations.flatMap((transformation) => transformation.resultArtifactIds || []));
  const eligibleArtifacts = protocol.contextArtifacts.filter((artifact) => resultIds.has(artifact.id));
  const artifacts = eligibleArtifacts.slice(0, 100);
  return {
    taskLabels,
    coordination,
    transformations,
    artifacts,
    truncated: coordination.length < eligibleCoordination.length
      || transformations.length < eligibleTransformations.length
      || artifacts.length < eligibleArtifacts.length
  };
}

function renderRuntimeLanes(data: RuntimeData, provider: string, sessionId: string) {
  const projection = data.projections?.execution;
  if (!projection) return `<section class="runtime-secondary-disclosure"><p class="runtime-empty">${escapeHtml(t("runtime.not_recorded"))}</p></section>`;
  const actorByRun = data.runPage && data.runActorBindings
    ? data.runActorBindings.actorByRun
    : new Map<string, string>();
  const actorLabels = data.runPage && data.runActorBindings
    ? new Map(data.runActorBindings.actors.map((entry) => [projectionRefLabel(entry.ref), entityLabel(entry.actor, t("runtime.unassigned_executor"))]))
    : new Map<string, string>();
  if (!data.runPage) {
    for (const relation of projection.actorRuns || []) {
      const actorId = projectionRefLabel(relation.actor);
      const runId = projectionRefLabel(relation.run);
      if (actorId && runId && actorId !== t("runtime.not_recorded") && runId !== t("runtime.not_recorded")) actorByRun.set(runId, actorId);
    }
    for (const entry of projection.actors || []) {
      const id = projectionRefLabel(entry.ref);
      if (id && id !== t("runtime.not_recorded")) actorLabels.set(id, entityLabel(entry.actor, t("runtime.unassigned_executor")));
    }
  }
  const usage = projection.usage;
  const usageComplete = usage.complete === true;
  const usageValue = (value: number | null) => value == null
    ? t("runtime.not_recorded")
    : usageComplete ? count(value) : t("runtime.at_least_value", { count: count(value) });
  const usageLabel = usageComplete ? t("runtime.requests") : t("runtime.visible_requests");
  const totalLabel = usageComplete ? t("runtime.total_tokens") : t("runtime.token_lower_bound");
  const componentValues = [[t("runtime.input_tokens"), usage.input], [t("runtime.output_tokens"), usage.output], [t("runtime.reasoning_tokens"), usage.reasoning], [t("runtime.cache_read_tokens"), usage.cacheRead], [t("runtime.cache_write_tokens"), usage.cacheWrite]];
  const usageNotice = usageComplete ? "" : `<p class="runtime-notice runtime-usage-bound-note" data-runtime-usage-note>${escapeHtml(projection.truncated ? t("runtime.usage_projection_bounded") : t("runtime.usage_evidence_incomplete"))}</p>`;
  const usageSummary = `<section class="runtime-usage-summary" data-runtime-usage-summary data-runtime-usage-complete="${usageComplete ? "true" : "false"}" data-runtime-usage-truncated="${projection.truncated ? "true" : "false"}"><h3>${t("runtime.usage")}</h3><p><span data-runtime-usage-request-count="${escapeHtml(String(usage.requestCount))}">${escapeHtml(`${usageLabel}: ${count(usage.requestCount)}`)}</span> · <span data-runtime-usage-total="${escapeHtml(usage.total == null ? "" : String(usage.total))}">${escapeHtml(`${totalLabel}: ${usageValue(usage.total)}`)}</span></p><small>${escapeHtml(componentValues.map(([label, value]) => `${label}: ${usageValue(value as number | null)}`).join(" · "))} · ${escapeHtml(usageComplete ? t("runtime.complete") : t("runtime.incomplete"))}</small>${usageNotice}</section>`;
  const lanePresentation: RuntimeLanePresentation = data.v3
    ? projectRuntimeLanePresentation(data.v3, data.runPage?.runs || projection.runs)
    : {};
  const page = data.runPage
    ? renderRuntimeRunPage(data.runPage, actorByRun, actorLabels, lanePresentation, { runCursor: data.runCursor })
    : data.runPageError
      ? renderRuntimeRunPageError(data.runPageError, provider, sessionId)
      : projection.runs.length
        ? `<section class="runtime-projection-group"><h3>${t("runtime.runs")}</h3><div class="runtime-run-lanes" data-runtime-run-lanes>${[...new Set(projection.runs.map((entry) => actorByRun.get(entry.run.id) || (entry.run.kind === "session-turn" ? "session" : "unassigned")))].map((laneId) => { const laneEntries = projection.runs.filter((entry) => (actorByRun.get(entry.run.id) || (entry.run.kind === "session-turn" ? "session" : "unassigned")) === laneId); const taskRunCounts = new Map<string, number>(); laneEntries.forEach((entry) => { const taskId = projectionRefLabel(entry.task) !== t("runtime.not_recorded") ? projectionRefLabel(entry.task) : entry.run.taskId; if (taskId) taskRunCounts.set(taskId, (taskRunCounts.get(taskId) || 0) + 1); }); return `<section class="runtime-run-lane" data-runtime-run-lane-section="${escapeHtml(laneId)}"><h4>${escapeHtml(laneId === "session" ? t("runtime.session_owned") : laneId === "unassigned" ? t("runtime.unassigned_executor") : actorLabels.get(laneId) || t("runtime.unassigned_executor"))}</h4><ul data-runtime-run-list>${laneEntries.map((entry) => renderExecutionRun(entry, actorByRun.get(entry.run.id) || null, lanePresentation, taskRunCounts)).join("")}</ul></section>`; }).join("")}</div></section>`
        : `<section class="runtime-projection-group"><h3>${t("runtime.runs")}</h3><p class="runtime-empty">${escapeHtml(t("runtime.not_recorded"))}</p></section>`;
  return `<section class="runtime-work-lanes" data-runtime-section="runs" aria-labelledby="runtime-work-lanes-title"><div class="runtime-section-heading"><div><h3 id="runtime-work-lanes-title">${t("runtime.runs")}</h3><p>${escapeHtml(t("runtime.run_lanes_description"))}</p></div>${renderProjectionCoverage(projection)}</div>${usageSummary}${page}</section>`;
}

function renderRuntimeSecondaryDisclosure(data: RuntimeData) {
  return `<details class="runtime-secondary-disclosure" data-runtime-section="coordination"><summary>${escapeHtml(t("runtime.coordination_title"))}</summary>${renderCoordinationProjection(data)}</details><details class="runtime-secondary-disclosure" data-runtime-section="context"><summary>${escapeHtml(t("runtime.context_title"))}</summary>${renderContextProjection(data)}</details>`;
}

function renderExecutionRun(entry: RunPage["runs"][number], actorId: string | null = null, presentation: RuntimeLanePresentation = {}, taskRunCounts = new Map<string, number>(), navigation: { provider: string; sessionId: string; runCursor: string | null; pageSize: number } | null = null) {
  const run = entry.run;
  const taskRefId = entry.task ? projectionRefLabel(entry.task) : "";
  const taskId = taskRefId !== t("runtime.not_recorded") ? taskRefId : run.taskId || null;
  const laneId = actorId || (run.kind === "session-turn" ? "session" : "unassigned");
  const taskLabel = taskId ? presentation.taskLabels?.get(taskId) || "" : "";
  const attributes = runtimeEntityAttributes("run", run.id, {
    "data-runtime-task-id": taskId,
    "data-runtime-actor-id": actorId,
    "data-runtime-run-lane": laneId
  });
  const coordination = (presentation.coordination || []).filter((observation) => (
    observation.runId === run.id
    || (!observation.runId && taskId && observation.taskId === taskId && taskRunCounts.get(taskId) === 1)
  ));
  const artifactsById = new Map((presentation.artifacts || []).map((artifact) => [artifact.id, artifact]));
  const checkpoints = (presentation.transformations || []).filter((transformation) => transformation.runId === run.id);
  const markerMarkup = coordination.map((observation) => {
    const binding = observation.runId === run.id ? "run" : "task";
    const label = `${observation.kind || t("runtime.coordination_marker")} · ${observation.state || t("runtime.unknown")}`;
    return `<span class="runtime-lane-marker runtime-lane-marker-${binding}" ${runtimeEntityAttributes("coordination", observation.id, {
      "data-runtime-coordination-run-id": observation.runId,
      "data-runtime-coordination-task-id": observation.taskId
    })}>${runtimeSelectButton("coordination", observation.id, label)}</span>`;
  }).join("");
  const checkpointMarkup = checkpoints.map((transformation) => {
    const resultArtifacts = (transformation.resultArtifactIds || []).filter((id: string) => artifactsById.has(id));
    const artifactMarkup = resultArtifacts.map((id: string) => {
      const artifact = artifactsById.get(id);
      const label = entityLabel(artifact, id);
      return `<span class="runtime-lane-checkpoint-artifact" ${runtimeEntityAttributes("artifact", id, {
        "data-runtime-artifact-context-transformation-id": transformation.id,
        "data-runtime-artifact-run-id": artifact?.producerRunId || transformation.runId
      })}>${runtimeSelectButton("artifact", id, label)}</span>`;
    }).join("");
    return `<span class="runtime-lane-checkpoint" ${runtimeEntityAttributes("context-transformation", transformation.id, {
      "data-runtime-context-run-id": transformation.runId
    })}><span>${runtimeSelectButton("context-transformation", transformation.id, `${t("runtime.context_checkpoint")}: ${transformation.kind || t("runtime.unknown")}`)}</span>${artifactMarkup ? `<span class="runtime-lane-checkpoint-artifacts">${artifactMarkup}</span>` : ""}</span>`;
  }).join("");
  const links = markerMarkup || checkpointMarkup
    ? `<span class="runtime-run-links" data-runtime-run-links>${markerMarkup}${checkpointMarkup}</span>`
    : "";
  const timing = renderRunTiming(run);
  const childHref = entry.childSession && navigation
    ? sessionHref(entry.childSession, runtimeParentHref(navigation.provider, navigation.sessionId, run.id, navigation.runCursor, navigation.pageSize))
    : entry.childSession ? sessionHref(entry.childSession) : "";
  if (run.kind !== "session-turn") {
    return `<li class="runtime-run-segment runtime-run" ${attributes}><strong>${runtimeSelectButton("run", run.id, runtimeRunLabel(run, taskLabel))}</strong><span>${escapeHtml(statusLabel(run.status))}</span>${childHref ? `<a class="runtime-child-session-link" href="${escapeHtml(childHref)}">${escapeHtml(t("runtime.child_session"))}</a>` : ""}${timing}${links}${evidenceButton("run", run.id)}</li>`;
  }
  return `<li class="runtime-run-segment runtime-run runtime-session-turn" ${attributes} data-runtime-run-kind="session-turn" data-runtime-turn-id="${escapeHtml(run.turnId || "")}"><strong>${runtimeSelectButton("run", run.id, t("runtime.session_turn"))}</strong><span data-runtime-run-status="${escapeHtml(String(run.status || "unknown"))}">${escapeHtml(`${t("runtime.execution_status")}: ${statusLabel(run.status)}`)}</span><span data-runtime-run-mode="${escapeHtml(String(run.mode || "unknown"))}">${escapeHtml(`${t("runtime.execution_mode")}: ${executionModeLabel(run.mode)}`)}</span>${timing}${links}${evidenceButton("run", run.id)}</li>`;
}

export function renderRuntimeRunPage(page: RunPage, actorByRun: Map<string, string> = new Map(), actorLabels: Map<string, string> = new Map(), presentation: RuntimeLanePresentation = {}, options: { runCursor?: string | null } = {}) {
  const revision = page.revision?.value || t("runtime.not_recorded");
  const range = page.total
    ? t("runtime.run_range", { start: count(page.range.start), end: count(page.range.end), total: count(page.total) })
    : t("runtime.no_runs");
  const refreshQuery = new URLSearchParams({ runtimeLens: "execution" });
  if (options.runCursor) refreshQuery.set("runCursor", options.runCursor);
  refreshQuery.set("runLimit", String(page.pageSize || DEFAULT_RUN_PAGE_SIZE));
  const refreshHref = `/${encodeURIComponent(page.focus.provider)}/session/${encodeURIComponent(page.focus.sessionId)}?${refreshQuery}`;
  const groups = new Map<string, any[]>();
  for (const entry of page.runs) {
    const laneId = actorByRun.get(entry.run.id) || (entry.run.kind === "session-turn" ? "session" : "unassigned");
    const entries = groups.get(laneId) || [];
    entries.push(entry);
    groups.set(laneId, entries);
  }
  const taskRunCounts = new Map<string, number>();
  page.runs.forEach((entry) => {
    const taskRefId = entry.task ? projectionRefLabel(entry.task) : "";
    const taskId = taskRefId !== t("runtime.not_recorded") ? taskRefId : entry.run.taskId;
    if (taskId) taskRunCounts.set(taskId, (taskRunCounts.get(taskId) || 0) + 1);
  });
  const laneLabel = (laneId: string) => laneId === "session"
    ? t("runtime.session_owned")
    : laneId === "unassigned"
      ? t("runtime.unassigned_executor")
      : actorLabels.get(laneId) || t("runtime.unassigned_executor");
  const navigation = { provider: page.focus.provider, sessionId: page.focus.sessionId, runCursor: options.runCursor || null, pageSize: page.pageSize || DEFAULT_RUN_PAGE_SIZE };
  const lanes = [...groups.entries()].map(([laneId, entries]) => `<section class="runtime-run-lane" data-runtime-run-lane-section="${escapeHtml(laneId)}"><h4>${escapeHtml(laneLabel(laneId))}</h4><ul data-runtime-run-list>${entries.map((entry) => renderExecutionRun(entry, actorByRun.get(entry.run.id) || null, presentation, taskRunCounts, navigation)).join("")}</ul></section>`).join("");
  const boundedLaneNote = presentation.truncated ? `<p class="runtime-run-page-note runtime-lane-evidence-bounded">${escapeHtml(t("runtime.projection_truncated"))}</p>` : "";
  return `<section class="runtime-projection-group runtime-run-page" data-runtime-run-page data-runtime-run-page-provider="${escapeHtml(page.focus.provider)}" data-runtime-run-page-session-id="${escapeHtml(page.focus.sessionId)}" data-runtime-run-page-revision="${escapeHtml(revision)}" data-runtime-run-page-limit="${page.pageSize || DEFAULT_RUN_PAGE_SIZE}"><div class="runtime-run-page-heading"><div><h3>${t("runtime.runs")}</h3><span class="runtime-run-page-range" data-runtime-run-range>${escapeHtml(range)}</span></div><a class="btn" data-runtime-runs-refresh href="${escapeHtml(refreshHref)}">${escapeHtml(t("runtime.refresh_runs"))}</a></div><p class="runtime-run-page-note" data-runtime-run-page-note>${escapeHtml(t("runtime.run_page_latest_note"))}</p>${boundedLaneNote}<small class="runtime-run-page-revision" data-runtime-run-revision>${escapeHtml(`${t("runtime.snapshot_label")}: ${revision}`)}</small>${page.runs.length ? `<div class="runtime-run-lanes" data-runtime-run-lanes>${lanes}</div>` : `<p class="runtime-empty">${escapeHtml(t("runtime.no_runs"))}</p>`}<nav class="runtime-pagination runtime-run-pagination" aria-label="${escapeHtml(t("runtime.run_pagination"))}"><button type="button" class="btn" data-runtime-runs-previous data-runtime-runs-cursor="${escapeHtml(page.previousCursor || "")}" ${page.previousCursor ? "" : "disabled"}>${t("runtime.previous")}</button><button type="button" class="btn" data-runtime-runs-next data-runtime-runs-cursor="${escapeHtml(page.nextCursor || "")}" ${page.nextCursor ? "" : "disabled"}>${t("runtime.next")}</button></nav></section>`;
}

function renderRuntimeRunPageError(error: { message: string }, provider: string, sessionId: string) {
  const refreshHref = `/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}?runtimeLens=execution`;
  return `<section class="runtime-projection-group runtime-run-page" data-runtime-run-page-error><div class="runtime-run-page-heading"><h3>${t("runtime.runs")}</h3></div><p class="runtime-notice" data-runtime-run-page-error-message>${escapeHtml(error.message)}</p><a class="btn" data-runtime-runs-refresh href="${escapeHtml(refreshHref)}">${escapeHtml(t("runtime.refresh_runs"))}</a></section>`;
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
  const generalArtifacts = artifacts.filter((entry) => !LONG_LIVED_CONTEXT_KINDS.has(entry.artifact?.kind));
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
    ${renderContextAssets(projection)}
    ${transformations.length ? `<section class="runtime-projection-group"><h3>${t("runtime.transformations")}</h3><ul>${transformations.map((entry) => { const event = entry.transformation.eventId ? data.protocol?.events.find((candidate) => candidate.id === entry.transformation.eventId) : null; const compaction = event?.compaction; return `<li class="runtime-card runtime-transformation"><strong>${escapeHtml(entry.transformation.kind || projectionRefLabel(entry.ref))}</strong><span>${escapeHtml(resultLabel(entry))}</span><details><summary>${t("runtime.evidence")}</summary><small>${escapeHtml([`${t("runtime.tokens_before")}: ${compaction?.tokensBefore == null ? t("runtime.not_recorded") : count(compaction.tokensBefore)}`, `${t("runtime.tokens_after")}: ${compaction?.tokensAfter == null ? t("runtime.not_recorded") : count(compaction.tokensAfter)}`, provenanceLabel(entry.transformation.provenance)].join(" · "))}</small></details></li>`; }).join("")}</ul></section>` : ""}
    ${legacyCompactions.length ? `<section class="runtime-projection-group runtime-result-context"><h3>${t("runtime.compacted_context")}</h3><ul>${legacyCompactions.map((event) => { const compaction = event.compaction!; return `<li class="runtime-card"><strong>${escapeHtml(t("runtime.compacted_context"))}</strong><span>${escapeHtml(compaction.summary || "")}</span><details><summary>${t("runtime.evidence")}</summary><small>${escapeHtml([`${t("runtime.tokens_before")}: ${compaction.tokensBefore == null ? t("runtime.not_recorded") : count(compaction.tokensBefore)}`, `${t("runtime.tokens_after")}: ${compaction.tokensAfter == null ? t("runtime.not_recorded") : count(compaction.tokensAfter)}`, provenanceLabel(event.provenance)].join(" · "))}</small></details></li>`; }).join("")}</ul>${legacyCompactionsTruncated ? `<p class="runtime-notice">${escapeHtml(t("runtime.compaction_results_bounded", { count: count(legacyCompactions.length) }))}</p>` : ""}</section>` : ""}
    ${generalArtifacts.length ? `<section class="runtime-projection-group"><h3>${t("runtime.artifacts")}</h3><ul>${generalArtifacts.map((entry) => { const id = projectionRefLabel(entry.ref); return `<li class="runtime-card"><strong>${escapeHtml(entityLabel(entry.artifact, id))}</strong><span>${escapeHtml([entry.artifact.kind, entry.artifact.scope].filter(Boolean).join(" · ") || t("runtime.not_recorded"))}</span>${evidenceButton("artifact", id)}</li>`; }).join("")}</ul></section>` : ""}
    <section class="runtime-projection-group"><h3>${t("runtime.origins")}</h3>${originCount ? `<ul class="runtime-origin-list">${origins.map(renderOrigin).join("")}</ul>` : `<p class="runtime-empty">${t("runtime.not_recorded")}</p>`}</section>
    ${!transformations.length && !versions.length && !artifacts.length ? `<p class="runtime-empty">${t("runtime.not_recorded")}</p>` : ""}
  </section>`;
}

function renderEvidenceData(protocol: SessionProtocol | null, v3: SessionProtocolV3 | null = null, runPage: RunPage | null = null) {
  const pagePresentation = v3 && runPage ? projectRuntimeLanePresentation(v3, runPage.runs) : {};
  return {
    goals: (v3?.goals || []).slice(0, 100),
    tasks: (protocol?.tasks || []).slice(0, 100),
    actors: (v3?.actors || []).slice(0, 100),
    runs: (protocol?.agentRuns || []).slice(0, 100),
    runPageRuns: runPage ? runPage.runs.map((entry) => entry.run) : [],
    coordinations: (v3?.coordination || []).slice(0, 100),
    transformations: (v3?.contextTransformations || []).slice(0, 100),
    artifacts: (protocol?.contextArtifacts || []).slice(0, 100),
    relationships: (protocol?.relationships || []).slice(0, 100),
    pageCoordination: pagePresentation.coordination || [],
    pageTransformations: pagePresentation.transformations || [],
    pageArtifacts: pagePresentation.artifacts || []
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
    <div class="runtime-workbench-body"><div class="runtime-workbench-main" data-runtime-workbench-main>${renderWorkOverview(data, renderRuntimeLanes(data, provider, sessionId))}${renderRuntimeSecondaryDisclosure(data)}</div><aside class="runtime-selection-inspector" data-runtime-inspector hidden aria-live="polite"><button type="button" class="runtime-inspector-close" data-runtime-inspector-close aria-label="${escapeHtml(t("runtime.evidence_close"))}">×</button><h3>${escapeHtml(t("runtime.inspector_title"))}</h3><div data-runtime-inspector-content></div></aside></div>
    <script type="application/json" data-runtime-evidence>${jsonScript(renderEvidenceData(protocol, data.v3 || null, data.runPage || null))}</script>
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
