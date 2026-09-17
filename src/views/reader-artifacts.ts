import { t } from "../i18n.js";
import { escapeHtml } from "../markdown.js";
import type { ContextArtifact, ContextArtifactSourceState } from "../providers/shared/session-protocol.js";

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

function renderArtifact(artifact: ContextArtifact) {
  const load = `<div class="progressive reader-artifact-content" data-context-artifact-id="${escapeHtml(artifact.id)}" data-content-scope="context-artifact" data-progressive-field="content" data-search-exclude>
        <button type="button" class="progressive-more" data-context-artifact-id="${escapeHtml(artifact.id)}" data-content-scope="context-artifact" data-field="content" data-next-offset="0" data-load-initial data-load-error="${escapeHtml(t("progressive.load_failed"))}" data-more-label="${escapeHtml(t("progressive.show_more"))}" data-loading-label="${escapeHtml(t("progressive.loading"))}" data-retry-label="${escapeHtml(t("progressive.retry"))}" data-empty-label="${escapeHtml(t("detail.reader_artifact_empty"))}" data-stale-label="${escapeHtml(t("detail.reader_artifact_stale"))}" data-refresh-label="${escapeHtml(t("detail.reader_artifact_refresh"))}">${escapeHtml(t("progressive.load_content"))}</button>
      </div>`;
  return `<details class="reader-artifact-output" data-reader-artifact data-search-exclude>
    <summary><span>${escapeHtml(artifactLabel(artifact))}</span><small>${escapeHtml(t("detail.reader_artifact_read"))}</small></summary>
    <div class="reader-artifact-output-body">
      <p class="reader-artifact-date">${escapeHtml(t("detail.reader_artifact_generated"))}: ${recordedTime(artifact.timeCreated)}</p>
      ${load}
      ${renderEvidence(artifact)}
    </div>
  </details>`;
}

export function renderReaderArtifacts({
  artifacts = [], sourceState, canRead = false, provider, sessionId, sessionAnchor
}: {
  artifacts?: ContextArtifact[];
  sourceState?: ContextArtifactSourceState | null;
  canRead?: boolean;
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
    : `<div class="reader-artifact-lineage"><div class="reader-artifact-source"><strong>${escapeHtml(t("detail.reader_artifact_source"))}</strong><span>${sourceLinks(readable[0], provider, sessionId, sessionAnchor)}</span><small>${escapeHtml(t("detail.reader_artifact_captured"))}: ${recordedTime(readable[0].contentSourceTime)}</small></div><div class="reader-artifact-branches">${readable.map(renderArtifact).join("")}</div></div>`;
  return `<details class="reader-artifacts-disclosure" data-reader-artifacts data-search-exclude>
    <summary><span>${escapeHtml(t("detail.reader_artifacts_title"))}</span>${readable.length ? `<small>${escapeHtml(readable.map(artifactLabel).join(", "))}</small>` : ""}</summary>
    <div class="reader-artifacts-body">${unavailable}</div>
  </details>`;
}
