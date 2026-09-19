import { t } from "../i18n.js";
import { escapeHtml } from "../markdown.js";
import path from "node:path";
import type { ContextArtifact, ContextArtifactEvidenceActivity, ContextArtifactEvidenceCoverage, ContextArtifactSourceState } from "../providers/shared/session-protocol.js";

export type { ContextArtifactSourceState } from "../providers/shared/session-protocol.js";

function recordedTime(value: number | null | undefined) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return t("detail.not_recorded");
  return `<time datetime="${new Date(time).toISOString()}">${escapeHtml(new Date(time).toLocaleString())}</time>`;
}

function artifactLabel(artifact: ContextArtifact) {
  if (artifact.kind === "memory") return t("detail.reader_artifact_memory");
  if (artifact.kind === "summary") return t("detail.reader_artifact_summary");
  return artifact.title || artifact.kind;
}

function sourceLinks(artifact: ContextArtifact, provider: string, sessionId: string, sessionAnchor: string) {
  const sources = artifact.sourceSessionIds || [];
  if (!sources.length) return `<span class="reader-artifact-unavailable">${escapeHtml(t("detail.not_recorded"))}</span>`;
  return sources.map((sourceId) => {
    const current = String(sourceId) === String(sessionId);
    const href = current
      ? `#${sessionAnchor}`
      : `/${encodeURIComponent(provider)}/session/${encodeURIComponent(sourceId)}`;
    return `<a href="${escapeHtml(href)}"${current ? " data-reader-artifact-current-source" : ""}>${escapeHtml(current ? t("detail.reader_artifact_this_history") : sourceId)}</a>`;
  }).join(", ");
}

function renderEvidence(artifact: ContextArtifact) {
  const evidence = artifact.productionEvidence;
  const metadata = artifact.metadata && Object.keys(artifact.metadata).length
    ? `<dt>${escapeHtml(t("detail.reader_artifact_metadata"))}</dt><dd><code>${escapeHtml(JSON.stringify(artifact.metadata))}</code></dd>`
    : "";
  const identity = `${artifact.sourcePath ? `<dt>${escapeHtml(t("detail.reader_artifact_source_path"))}</dt><dd><code>${escapeHtml(artifact.sourcePath)}</code></dd>` : ""}${artifact.hash ? `<dt>${escapeHtml(t("detail.reader_artifact_hash"))}</dt><dd><code>${escapeHtml(artifact.hash)}</code></dd>` : ""}${metadata}`;
  const generation = evidence
    ? `<dt>${escapeHtml(t("detail.reader_artifact_evidence_provenance"))}</dt><dd>${escapeHtml(evidence.provenance.sourceType)}</dd>
       ${evidence.provenance.sourceId ? `<dt>${escapeHtml(t("detail.reader_artifact_evidence_key"))}</dt><dd><code>${escapeHtml(evidence.provenance.sourceId)}</code></dd>` : ""}
       <dt>${escapeHtml(t("detail.reader_artifact_started"))}</dt><dd>${recordedTime(evidence.startedAt)}</dd>
       <dt>${escapeHtml(t("detail.reader_artifact_completed"))}</dt><dd>${recordedTime(evidence.completedAt)}</dd>
       <dt>${escapeHtml(t("detail.reader_artifact_input_updated"))}</dt><dd>${recordedTime(evidence.inputUpdatedAt)}</dd>`
    : "";
  const history = !artifact.producerRunId && !artifact.producerEventId
    ? `<dt>${escapeHtml(t("detail.reader_artifact_generation"))}</dt><dd>${escapeHtml(t("detail.reader_artifact_generation_unavailable"))}</dd>`
    : "";
  return `<details class="reader-artifact-evidence" data-search-exclude><summary>${escapeHtml(t("detail.reader_artifact_evidence"))}</summary><dl>${generation}${history}${identity}</dl></details>`;
}

function contentControl(artifactId: string, recordId?: string) {
  const scope = recordId ? "artifact-evidence" : "context-artifact";
  const record = recordId ? ` data-artifact-evidence-record-id="${escapeHtml(recordId)}"` : "";
  return `<div class="progressive reader-artifact-content" data-context-artifact-id="${escapeHtml(artifactId)}" data-content-scope="${scope}" data-progressive-field="content" data-search-exclude>
    <button type="button" class="progressive-more" data-context-artifact-id="${escapeHtml(artifactId)}"${record} data-content-scope="${scope}" data-field="content" data-next-offset="0" data-load-initial data-load-error="${escapeHtml(t("progressive.load_failed"))}" data-more-label="${escapeHtml(t("progressive.show_more"))}" data-loading-label="${escapeHtml(t("progressive.loading"))}" data-retry-label="${escapeHtml(t("progressive.retry"))}" data-empty-label="${escapeHtml(t("detail.reader_artifact_empty"))}" data-stale-label="${escapeHtml(t(recordId ? "detail.artifact_followups_stale" : "detail.reader_artifact_stale"))}" data-refresh-label="${escapeHtml(t("detail.reader_artifact_refresh"))}">${escapeHtml(t("progressive.load_content"))}</button>
  </div>`;
}

function renderFollowups(artifact: ContextArtifact) {
  return `<details class="reader-artifact-followups" data-artifact-evidence data-context-artifact-id="${escapeHtml(artifact.id)}" data-search-exclude
      data-loading-label="${escapeHtml(t("detail.artifact_followups_loading"))}" data-load-label="${escapeHtml(t("detail.artifact_followups_load"))}" data-more-label="${escapeHtml(t("detail.artifact_followups_more"))}" data-retry-label="${escapeHtml(t("detail.artifact_followups_retry"))}" data-error-label="${escapeHtml(t("detail.artifact_followups_failed"))}" data-invalid-label="${escapeHtml(t("detail.artifact_followups_invalid"))}" data-empty-label="${escapeHtml(t("detail.artifact_followups_empty"))}" data-stale-label="${escapeHtml(t("detail.artifact_followups_stale"))}" data-refresh-label="${escapeHtml(t("detail.reader_artifact_refresh"))}">
    <summary>${escapeHtml(t("detail.artifact_followups"))}</summary>
    <div class="reader-artifact-followups-body">
      <details class="reader-artifact-followups-range"><summary>${escapeHtml(t("detail.artifact_followups_range"))}</summary>
        <form data-artifact-evidence-range>
          <label>${escapeHtml(t("detail.artifact_followups_from"))}<input type="datetime-local" step="1" required name="from"></label>
          <label>${escapeHtml(t("detail.artifact_followups_to"))}<input type="datetime-local" step="1" required name="to"></label>
          <button type="submit">${escapeHtml(t("detail.artifact_followups_check"))}</button>
        </form>
      </details>
      <div data-artifact-evidence-coverage></div>
      <div class="reader-artifact-followups-lineage" data-artifact-evidence-lineage hidden>
        <p class="reader-artifact-followups-source">${escapeHtml(t("detail.artifact_followups_source"))}</p>
        <div data-artifact-evidence-activities></div>
      </div>
      <p data-artifact-evidence-status role="status" aria-live="polite"></p>
      <button type="button" data-artifact-evidence-load>${escapeHtml(t("detail.artifact_followups_load"))}</button>
    </div>
  </details>`;
}

export function renderArtifactEvidenceCoverage(coverage: ContextArtifactEvidenceCoverage) {
  const issues = coverage.issues.map((issue) => {
    const key = `detail.artifact_followups_issue_${issue}`;
    const label = t(key);
    return `<li>${escapeHtml(label === key ? issue : label)}</li>`;
  }).join("");
  return `<p><strong>${escapeHtml(t("detail.artifact_followups_coverage"))}</strong>: ${recordedTime(coverage.from)} – ${recordedTime(coverage.to)}</p>
    <p>${escapeHtml(t(coverage.complete ? "detail.artifact_followups_complete" : "detail.artifact_followups_partial"))} ${escapeHtml(t("detail.artifact_followups_counts", { records: String(coverage.scannedRecords), bytes: String(coverage.readBytes) }))}</p>${issues ? `<ul>${issues}</ul>` : ""}`;
}

export function renderArtifactEvidenceActivity(activity: ContextArtifactEvidenceActivity, artifactId: string) {
  const binding = activity.binding;
  const records = activity.records.map((record) => `<details class="reader-artifact-followup-record" data-artifact-evidence-record data-artifact-record-id="${escapeHtml(record.id)}" data-search-exclude>
    <summary><span>${escapeHtml(t(record.kind === "read-request" ? "detail.artifact_followups_read" : "detail.artifact_followups_modify"))} <code title="${escapeHtml(record.targetPath)}">${escapeHtml(path.win32.basename(path.posix.basename(record.targetPath)))}</code></span><small title="${escapeHtml(t("detail.artifact_followups_record"))}">${recordedTime(record.timeCreated)}</small></summary>
    <div class="reader-artifact-followup-record-body">
      <p class="reader-artifact-followup-path"><code>${escapeHtml(record.targetPath)}</code></p>
      <p class="reader-artifact-date">${recordedTime(record.timeCreated)} · <code>${escapeHtml(record.provenance.sourceType)}${record.provenance.sourceId ? ` / ${escapeHtml(record.provenance.sourceId)}` : ""}</code></p>
      ${contentControl(artifactId, record.id)}
    </div>
  </details>`).join("");
  return `<section class="reader-artifact-followup-activity" data-artifact-activity-id="${escapeHtml(activity.id)}" data-search-exclude>
    <p class="reader-artifact-followup-title"><strong>${escapeHtml(t("detail.artifact_followups_activity"))}</strong> ${recordedTime(activity.timeCreated)}</p>
    <div class="reader-artifact-followup-records" data-artifact-evidence-records>${records}</div>
    <details class="reader-artifact-evidence"><summary>${escapeHtml(t("detail.artifact_followups_details"))}</summary>
      <p>${escapeHtml(t("detail.artifact_followups_binding"))}</p><p>${escapeHtml(t("detail.artifact_followups_history"))}</p>
      <dl><dt>${escapeHtml(t("detail.artifact_followups_session"))}</dt><dd><code>${escapeHtml(activity.sessionId)}</code></dd>
        <dt>${escapeHtml(t("detail.artifact_followups_turn"))}</dt><dd><code>${escapeHtml(activity.turnId)}</code></dd>
        <dt>${escapeHtml(t("detail.reader_artifact_evidence_provenance"))}</dt><dd><code>${escapeHtml(activity.provenance.sourceType)}${activity.provenance.sourceId ? ` / ${escapeHtml(activity.provenance.sourceId)}` : ""}</code></dd>
        <dt>${escapeHtml(t("detail.reader_artifact_source_path"))}</dt><dd><code>${escapeHtml(binding.sourcePath)}</code></dd>
        <dt>${escapeHtml(t("detail.reader_artifact_hash"))}</dt><dd><code>${escapeHtml(binding.fileHash)}</code></dd>
        <dt>${escapeHtml(t("detail.artifact_followups_checked"))}</dt><dd>${recordedTime(binding.checkedAt)}</dd>
        <dt>${escapeHtml(t("detail.reader_artifact_source"))}</dt><dd><code>${escapeHtml(binding.sourceSessionId)}</code></dd>
        <dt>${escapeHtml(t("detail.reader_artifact_input_updated"))}</dt><dd>${recordedTime(binding.sourceUpdatedAt)}</dd>
        <dt>${escapeHtml(t("detail.reader_artifact_evidence_provenance"))}</dt><dd><code>${escapeHtml(binding.provenance.fidelity)} / ${escapeHtml(binding.provenance.sourceType)}</code></dd>
      </dl>
    </details>
  </section>`;
}

function renderArtifact(artifact: ContextArtifact, canReadEvidence: boolean) {
  return `<details class="reader-artifact-output" data-reader-artifact data-search-exclude>
    <summary><span>${escapeHtml(artifactLabel(artifact))}</span><small>${escapeHtml(t("detail.reader_artifact_read"))}</small></summary>
    <div class="reader-artifact-output-body">
      <p class="reader-artifact-date">${escapeHtml(t("detail.reader_artifact_generated"))}: ${recordedTime(artifact.timeCreated)}</p>
      ${contentControl(artifact.id)}
      ${renderEvidence(artifact)}
      ${canReadEvidence && artifact.evidenceAccess === "on-demand" ? renderFollowups(artifact) : ""}
    </div>
  </details>`;
}

export function renderReaderArtifacts({
  artifacts = [], sourceState, canRead = false, canReadEvidence = false, provider, sessionId, sessionAnchor
}: {
  artifacts?: ContextArtifact[];
  sourceState?: ContextArtifactSourceState | null;
  canRead?: boolean;
  canReadEvidence?: boolean;
  provider: string;
  sessionId: string;
  sessionAnchor: string;
}) {
  const readable = canRead
    ? artifacts.filter((artifact) => artifact.contentAccess === "full" && (artifact.kind === "memory" || artifact.kind === "summary"))
    : [];
  if (!readable.length && (!sourceState || sourceState.state === "available")) return "";
  const unavailable = !readable.length
    ? `<p class="reader-artifact-unavailable">${escapeHtml(t("detail.reader_artifact_source_unavailable"))}</p>
       <details class="reader-artifact-evidence" data-search-exclude><summary>${escapeHtml(t("detail.reader_artifact_evidence"))}</summary><dl>
         <dt>${escapeHtml(t("detail.reader_artifact_source_state"))}</dt><dd>${escapeHtml(sourceState?.state || "")}</dd>
         ${sourceState?.code ? `<dt>${escapeHtml(t("detail.reader_artifact_source_code"))}</dt><dd><code>${escapeHtml(sourceState.code)}</code></dd>` : ""}
         ${sourceState?.sourcePath ? `<dt>${escapeHtml(t("detail.reader_artifact_source_path"))}</dt><dd><code>${escapeHtml(sourceState.sourcePath)}</code></dd>` : ""}
         ${sourceState?.provenance ? `<dt>${escapeHtml(t("detail.reader_artifact_evidence_provenance"))}</dt><dd>${escapeHtml(sourceState.provenance.sourceType)}</dd>` : ""}
       </dl></details>`
    : `<div class="reader-artifact-lineage"><div class="reader-artifact-source"><strong>${escapeHtml(t("detail.reader_artifact_source"))}</strong><span>${sourceLinks(readable[0], provider, sessionId, sessionAnchor)}</span><small>${escapeHtml(t("detail.reader_artifact_captured"))}: ${recordedTime(readable[0].contentSourceTime)}</small></div><div class="reader-artifact-branches">${readable.map((artifact) => renderArtifact(artifact, canReadEvidence)).join("")}</div></div>`;
  return `<details class="reader-artifacts-disclosure" data-reader-artifacts data-search-exclude>
    <summary><span>${escapeHtml(t("detail.reader_artifacts_title"))}</span>${readable.length ? `<small>${escapeHtml(readable.map(artifactLabel).join(", "))}</small>` : ""}</summary>
    <div class="reader-artifacts-body">${unavailable}</div>
  </details>`;
}
