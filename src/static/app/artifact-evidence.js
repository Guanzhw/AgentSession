const evidenceLoads = new WeakMap();

function localInputTime(time) {
  const date = new Date(time);
  return new Date(time - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}

/** Merge server-rendered evidence without replacing already expanded source text. */
export function mergeArtifactEvidence(container, html, reset = false) {
  const incoming = document.createElement("template");
  incoming.innerHTML = html;
  if (reset) container.replaceChildren();
  const existing = new Map([...container.querySelectorAll("[data-artifact-activity-id]")]
    .map((activity) => [activity.dataset.artifactActivityId, activity]));
  for (const activity of incoming.content.querySelectorAll("[data-artifact-activity-id]")) {
    const current = existing.get(activity.dataset.artifactActivityId);
    if (!current) {
      container.append(activity);
      existing.set(activity.dataset.artifactActivityId, activity);
      continue;
    }
    const records = current.querySelector("[data-artifact-evidence-records]");
    const recordIds = new Set([...records.querySelectorAll("[data-artifact-record-id]")].map((record) => record.dataset.artifactRecordId));
    for (const record of activity.querySelectorAll("[data-artifact-record-id]")) {
      if (!recordIds.has(record.dataset.artifactRecordId)) {
        records.append(record);
        recordIds.add(record.dataset.artifactRecordId);
      }
    }
  }
}

export function loadArtifactEvidence(details, requested) {
  let state = evidenceLoads.get(details);
  if (!state) {
    state = { loaded: false, cursor: null, pending: null, retry: null, stale: false, range: null };
    evidenceLoads.set(details, state);
  }
  if (state.pending) return state.pending;
  if (state.stale || !requested && state.loaded && !state.cursor && !state.retry) return Promise.resolve(null);
  const request = requested || state.retry || (state.cursor ? { cursor: state.cursor } : {});
  const reset = !request.cursor;
  const pane = details.closest("[data-reader-pane]");
  const workbench = details.closest(".session-workbench");
  const provider = pane?.dataset.readerProvider || workbench.dataset.provider;
  const sessionId = pane?.dataset.readerSession || workbench.dataset.sessionId;
  const button = details.querySelector("[data-artifact-evidence-load]");
  const status = details.querySelector("[data-artifact-evidence-status]");
  const diagnostic = details.querySelector("[data-artifact-evidence-diagnostic]");
  const form = details.querySelector("[data-artifact-evidence-range]");
  const activities = details.querySelector("[data-artifact-evidence-activities]");
  const controls = [button, ...form.querySelectorAll("input, button")];
  const promise = (async () => {
    controls.forEach((control) => { control.disabled = true; });
    button.hidden = false;
    button.textContent = details.dataset.loadingLabel;
    details.setAttribute("aria-busy", "true");
    status.textContent = details.dataset.loadingLabel;
    diagnostic.textContent = "";
    diagnostic.hidden = true;
    try {
      const query = new URLSearchParams({ artifact: details.dataset.contextArtifactId });
      for (const [key, value] of Object.entries(request)) query.set(key, String(value));
      const response = await fetch(`/api/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}/artifact-evidence?${query}`);
      const data = await response.json();
      if (!details.isConnected || pane && !pane.isConnected) return null;
      if (!response.ok || !data.ok) {
        if (response.status === 409 && data.code === "artifact_stale") {
          state.stale = true;
          button.hidden = true;
          status.textContent = details.dataset.staleLabel;
          const refresh = document.createElement("a");
          refresh.href = `/${encodeURIComponent(provider)}/session/${encodeURIComponent(sessionId)}`;
          refresh.textContent = details.dataset.refreshLabel;
          status.append(" ", refresh);
          return null;
        }
        state.retry = data.code === "evidence_invalid" ? state.range || {} : request;
        status.textContent = data.code === "evidence_invalid" ? details.dataset.invalidLabel : details.dataset.errorLabel;
        if (data.sourceState?.code) {
          diagnostic.textContent = data.sourceState.code;
          diagnostic.hidden = false;
        }
        return null;
      }
      mergeArtifactEvidence(activities, data.html, reset);
      details.querySelector("[data-artifact-evidence-coverage]").innerHTML = data.coverageHtml;
      const notice = details.querySelector("[data-artifact-evidence-notice]");
      notice.textContent = data.coverage.complete ? "" : details.dataset.incompleteLabel;
      notice.hidden = data.coverage.complete;
      details.querySelector("[data-artifact-evidence-lineage]").hidden = !activities.childElementCount;
      form.elements.namedItem("from").value = localInputTime(data.coverage.from);
      form.elements.namedItem("to").value = localInputTime(data.coverage.to);
      status.textContent = activities.childElementCount ? "" : details.dataset.emptyLabel;
      state.loaded = true;
      state.retry = null;
      state.cursor = data.nextCursor;
      state.range = { from: data.coverage.from, to: data.coverage.to };
      button.hidden = !state.cursor;
      return data;
    } catch {
      state.retry = request;
      if (details.isConnected) status.textContent = details.dataset.errorLabel;
      return null;
    } finally {
      state.pending = null;
      details.removeAttribute("aria-busy");
      controls.forEach((control) => { control.disabled = state.stale; });
      button.textContent = state.retry ? details.dataset.retryLabel : state.cursor ? details.dataset.moreLabel : details.dataset.loadLabel;
      if (!details.isConnected || pane && !pane.isConnected) status.textContent = "";
    }
  })();
  state.pending = promise;
  return promise;
}

export function initArtifactEvidence(workbench) {
  workbench.addEventListener("toggle", (event) => {
    const details = event.target;
    if (details.matches("[data-artifact-evidence]") && details.open && !evidenceLoads.get(details)?.loaded) {
      void loadArtifactEvidence(details);
    }
  }, true);
  workbench.addEventListener("click", (event) => {
    const button = event.target.closest("[data-artifact-evidence-load]");
    if (button) void loadArtifactEvidence(button.closest("[data-artifact-evidence]"));
  });
  workbench.addEventListener("submit", (event) => {
    const form = event.target;
    if (!form.matches("[data-artifact-evidence-range]")) return;
    event.preventDefault();
    const details = form.closest("[data-artifact-evidence]");
    const from = new Date(form.elements.namedItem("from").value).getTime();
    const to = new Date(form.elements.namedItem("to").value).getTime();
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from >= to) {
      details.querySelector("[data-artifact-evidence-status]").textContent = details.dataset.invalidLabel;
      return;
    }
    void loadArtifactEvidence(details, { from, to });
  });
}
