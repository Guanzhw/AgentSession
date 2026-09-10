import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { projectRuntimeLanePresentation, renderRuntimeEvents, renderRuntimeWorkbench } from "../dist/src/views/runtime-workbench.js";
import { getLocale, setLocale } from "../dist/src/i18n.js";
import { renderSessionPage } from "../dist/src/views/session.js";
import { finalizeSessionProtocolV3, upgradeSessionProtocolV2 } from "../dist/src/providers/shared/session-protocol-v3.js";
import { projectContext, projectCoordination, projectExecution, projectRunActorBindings, projectWork, queryRunPage } from "../dist/src/protocol-runtime-v3.js";
import { summarizeEvent } from "../dist/src/event-summary.js";
import { formatLocalizedDurationMs } from "../dist/src/views/components.js";
import { deriveWorkOverview } from "../dist/src/work-view-model.js";

const provenance = { fidelity: "recorded", sourceType: "fixture.event", sourceId: "source-1" };

function fixtureRuntime() {
  const runtime = {
    eventNextCursor: "cursor-next",
    graph: { nodes: [{ id: "session:fixture:runtime-1", label: "runtime-1", resolution: "resolved" }, { id: "session:fixture:child-1", label: "child-1", resolution: "missing" }], edges: [{ from: "session:fixture:runtime-1", to: "session:fixture:child-1", type: "spawned", inferred: true }] },
    summary: {
      version: 2,
      completeness: "complete",
      session: { state: "completed", harness: "fixture", origin: "test", ref: { provider: "fixture", sessionId: "runtime-1" } },
      counts: { events: 1, relationships: 1, tasks: 1, agentRuns: 1, contextArtifacts: 1, branches: 0 },
      capabilities: {
        events: { support: "full", provenance: "recorded" },
        relationships: { support: "partial", provenance: "derived" },
        tasks: { support: "full", provenance: "recorded" },
        runs: { support: "full", provenance: "recorded" },
        context: { support: "none", provenance: "derived" },
        branches: { support: "none", provenance: "derived" }
      }
    },
    protocol: {
      version: 2,
      sessionId: "runtime-1",
      session: { state: "completed", harness: "fixture", origin: "test", ref: { provider: "fixture", sessionId: "runtime-1" } },
      events: [
        { id: "event-1", sessionId: "runtime-1", sequence: 1, timestamp: 1000, kind: "model.request", normalizedKind: "model.request", category: "model", taskId: "task-1", runId: "run-1", provenance },
        { id: "event-context-start", sessionId: "runtime-1", sequence: 2, timestamp: 2000, kind: "compaction/start", normalizedKind: "context.compaction.started", category: "context", correlationId: "compact-1", provenance },
        { id: "event-context", sessionId: "runtime-1", sequence: 3, timestamp: 11000, kind: "context.compaction", normalizedKind: "context.compaction", category: "context", correlationId: "compact-1", provenance, compaction: { trigger: "automatic", strategy: "summary", tokensBefore: null, tokensAfter: 42, summary: "Retain <the result> and discard copied history." } },
        { id: "event-context-end", sessionId: "runtime-1", sequence: 4, timestamp: 11001, kind: "compaction/end", normalizedKind: "context.compaction.completed", category: "context", correlationId: "compact-1", provenance }
      ],
      relationships: [{ type: "spawned", fromSessionId: "runtime-1", toSessionId: "child-1", fromRef: { provider: "fixture", sessionId: "runtime-1" }, toRef: { provider: "fixture", sessionId: "child-1" }, provenance }],
      tasks: [{ id: "task-1", sessionId: "runtime-1", kind: "task", status: "completed", title: "Build <fixture>", provenance, dependencies: [], timeCreated: 1000, timeUpdated: 3000, timeCompleted: 3000 }],
      agentRuns: [{ id: "run-1", sessionId: "runtime-1", taskId: "task-1", status: "completed", mode: "foreground", agent: "worker", model: "fixture-model", childSessionId: null, timeStart: 1200, timeEnd: 2800, provenance }],
      contextArtifacts: [{ id: "artifact-1", sessionId: "runtime-1", kind: "summary", scope: "session", origin: "provider-generated", contentAccess: "metadata-only", title: "Summary", summary: null, sourcePath: null, producerRunId: null, sourceSessionIds: [], hash: null, redacted: true, timeCreated: 11000, metadata: { compactionId: "compact-1" }, provenance }]
    }
  };
  return refreshProjections(runtime);
}

function refreshProjections(runtime) {
  const upgraded = upgradeSessionProtocolV2(runtime.protocol, { freeze: false });
  const { validation: _validation, completeness: _completeness, ...facts } = upgraded;
  const usageRecords = [{
    id: "usage-1",
    scope: "request",
    sessionRef: { provider: "fixture", sessionId: runtime.protocol.sessionId },
    timestamp: 1500,
    model: "fixture-model",
    runId: "run-1",
    eventId: "event-1",
    tokens: { input: 100, cacheRead: 0, cacheWrite: 0, output: 20, reasoning: 0, total: 120 },
    contextOriginSlices: [
      { component: "input", origin: "direct", tokens: 35 },
      { component: "input", origin: "inherited", tokens: 45, sourceSessionRefs: [{ provider: "fixture", sessionId: "parent-1" }] },
      { component: "input", origin: "shared", tokens: 20, sourceSessionRefs: [{ provider: "fixture", sessionId: "shared-1" }] }
    ],
    provenance
  }];
  const v3 = finalizeSessionProtocolV3({
    ...facts,
    usageRecords,
    coverage: { ...upgraded.coverage, usage: { state: "observed" } }
  }, { freeze: false });
  runtime.v3 = v3;
  runtime.projections = {
    work: projectWork(v3, { maxItems: 100 }),
    execution: projectExecution(v3, { maxItems: 100 }),
    coordination: projectCoordination(v3, { maxItems: 100 }),
    context: projectContext(v3, { maxItems: 100 })
  };
  return runtime;
}

test("Workbench combines recorded graph, lanes, context, and evidence without nested lenses", () => {
  const html = renderRuntimeWorkbench(fixtureRuntime(), "fixture", "runtime-1");
  assert.doesNotMatch(html, /data-runtime-lens=/);
  assert.match(html, /data-runtime-workbench-main/);
  assert.match(html, /data-runtime-section="runs"/);
  assert.match(html, /data-runtime-section="coordination"/);
  assert.match(html, /data-runtime-section="context"/);
  assert.doesNotMatch(html, /data-runtime-events-panel/);
  assert.match(html, /data-runtime-inspector/);
  assert.match(html, /Build &lt;fixture&gt;/);
  assert.match(html, /\/fixture\/session\/child-1/);
  assert.match(html, /\/fixture\/session\/parent-1/);
  assert.match(html, /input · direct · 35 tokens/);
  assert.match(html, /input · inherited · 45 tokens/);
  assert.match(html, /input · shared · 20 tokens/);
  assert.doesNotMatch(html, /data-runtime-evidence-kind="event"/);
  assert.match(html, /data-runtime-evidence-kind="task"/);
  assert.match(html, /Selected evidence/);
  assert.match(html, /metadata-only/);
  assert.match(html, /Tokens before.*Not recorded/);
  assert.match(html, /Context after compaction/);
  assert.match(html, /Retain &lt;the result&gt; and discard copied history/);
  assert.doesNotMatch(html, /Retain <the result>/);
});

test("Workbench lanes render localized session-turn identity without raw inventory", () => {
  const runtime = fixtureRuntime();
  runtime.v3.agentRuns.push({
    id: "turn-run", sessionId: "runtime-1", taskId: null, status: "unknown", mode: "unknown",
    kind: "session-turn", turnId: "turn-42", agent: null, model: null, childSessionId: null,
    timeStart: 4000, timeEnd: null, provenance
  });
  runtime.projections.execution = projectExecution(runtime.v3, { maxItems: 100 });
  let html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  assert.match(html, /data-runtime-run-kind="session-turn"/);
  assert.match(html, /data-runtime-turn-id="turn-42"/);
  assert.match(html, /Session turn/);
  assert.match(html, /Status: unknown/);
  assert.match(html, /Mode: unknown/);
  assert.doesNotMatch(html, /Turn: turn-42/);
  assert.doesNotMatch(html, /Start:<\/strong>/);
  assert.doesNotMatch(html, /data-runtime-run-evidence/);
  const previousLocale = getLocale();
  setLocale("zh");
  try {
    html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
    assert.match(html, /会话轮次/);
    assert.match(html, /状态: 未知/);
    assert.match(html, /模式: 未知/);
  } finally {
    setLocale(previousLocale);
  }
});

test("Execution run browsing renders a complete page range, stable cursor hooks, and current-page evidence", () => {
  const runtime = fixtureRuntime();
  runtime.v3.agentRuns = Array.from({ length: 53 }, (_, index) => ({
    ...runtime.v3.agentRuns[0], id: `run-${index + 1}`, timeStart: index + 1, timeEnd: index + 2
  }));
  runtime.projections.execution = projectExecution(runtime.v3, { maxItems: 100 });
  runtime.runPage = queryRunPage(runtime.v3);
  let html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  assert.match(html, /Runs 1–50 of 53/);
  assert.match(html, /data-runtime-run-page-limit="50"/);
  assert.match(html, /data-runtime-runs-next data-runtime-runs-cursor="[^"]+"/);
  assert.match(html, /data-runtime-runs-previous[^>]*disabled/);
  assert.match(html, /data-runtime-run-page-revision/);
  assert.match(html, /"runPageRuns":\[/);
  const pageCursor = runtime.runPage.nextCursor;
  runtime.v3.agentRuns[50].childSessionId = "child/2";
  const third = queryRunPage(runtime.v3, { cursor: pageCursor });
  runtime.runPage = third;
  runtime.runCursor = pageCursor;
  html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  assert.match(html, /Runs 51–53 of 53/);
  assert.match(html, /data-runtime-runs-next[^>]*disabled/);
  assert.match(html, /data-runtime-runs-previous data-runtime-runs-cursor="[^"]+"/);
  assert.match(html, /runtime-child-session-link[^>]+href="\/fixture\/session\/child%2F2\?from=%2Ffixture%2Fsession%2Fruntime-1%3FruntimeLens%3Dexecution%26runtimeRun%3Drun-51%26runLimit%3D50%26runCursor%3D/);

  const source = readFileSync(path.join(process.cwd(), "src", "static", "app", "runtime-workbench.js"), "utf8");
  assert.match(source, /runtime\/execution\/runs/);
  assert.match(source, /runtimeRunPageBusy/);
  assert.match(source, /replaceWith\(replacement\)/);
  assert.match(source, /runPageRuns/);
  const lookupSource = source.slice(source.indexOf("  const evidenceCollections ="), source.indexOf("  const setSelected ="));
  const lookup = new Function("evidence", `${lookupSource}\nreturn evidenceForKind;`)({
    runPageRuns: [{ id: "run-1", status: "completed" }],
    runs: [{ id: "run-1", status: "running" }],
    pageArtifacts: [{ id: "page-result" }],
    artifacts: [{ id: "scope-result" }]
  });
  assert.equal(lookup("run").find((item) => item.id === "run-1").status, "completed");
  assert.deepEqual(lookup("artifact").map((item) => item.id), ["page-result", "scope-result"]);
  assert.match(source, /new URLSearchParams\(\{ runtimeLens: "execution" \}\)/);
  assert.match(source, /data-runtime-task-id/);
  assert.match(source, /data-runtime-actor-id/);
  assert.match(source, /runtime-graph-arrow/);
  const style = readFileSync(path.join(process.cwd(), "src", "static", "style.css"), "utf8");
  assert.match(style, /\.runtime-run-page-heading/);
  assert.match(style, /\.runtime-run-pagination/);
});

test("Initial SSR run page keeps a recorded actor binding omitted from the bounded overview", () => {
  const runtime = fixtureRuntime();
  runtime.v3.agentRuns = Array.from({ length: 123 }, (_, index) => ({
    ...runtime.v3.agentRuns[0], id: `run-${index + 1}`, timeStart: index + 1, timeEnd: index + 2
  }));
  runtime.v3.actors = [{
    id: "actor-first-page", sessionId: "runtime-1", kind: "agent", name: "First-page actor",
    providerActorId: null, teamId: null, memberActorIds: [], runIds: ["run-1"], sessionRef: null, provenance
  }];
  runtime.projections.execution = projectExecution(runtime.v3, { maxItems: 100 });
  runtime.runPage = queryRunPage(runtime.v3);
  runtime.runActorBindings = projectRunActorBindings(runtime.v3, runtime.runPage.runs.map(({ run }) => run.id));
  assert.equal(runtime.projections.execution.actorRuns.length, 0, "overview budget must omit the actor relation");
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  assert.match(html, /Runs 1–50 of 123/);
  assert.match(html, /data-runtime-entity-id="run-1"[^>]*data-runtime-actor-id="actor-first-page"/);
  assert.match(html, /<h4>First-page actor<\/h4>/);
});

test("Execution lanes preserve exact run/task evidence with bounded labels and recorded intervals", () => {
  const runtime = fixtureRuntime();
  runtime.v3.agentRuns[0].label = "Recorded worker label";
  runtime.v3.coordination = [
    { id: "marker-run", sessionId: "runtime-1", kind: "message", state: "delivered", timestamp: 1800, runId: "run-1", taskId: "task-1", provenance },
    { id: "marker-task", sessionId: "runtime-1", kind: "handoff", state: "started", timestamp: 1900, runId: null, taskId: "task-1", provenance },
    { id: "marker-unbound", sessionId: "runtime-1", kind: "wait", state: "started", timestamp: 2000, runId: null, taskId: null, provenance }
  ];
  runtime.v3.contextArtifacts = [{
    id: "artifact-result", sessionId: "runtime-1", kind: "summary", scope: "session", origin: "provider-generated", contentAccess: "summary", title: "Result <summary>", summary: "Recorded result", sourcePath: null, producerRunId: "run-1", sourceSessionIds: [], hash: null, redacted: false, timeCreated: 2700, metadata: {}, provenance
  }];
  runtime.v3.contextTransformations = [{
    id: "checkpoint-run", sessionId: "runtime-1", kind: "compaction", sourceVersionIds: [], resultVersionId: null, sourceArtifactIds: [], resultArtifactIds: ["artifact-result"], runId: "run-1", turnId: null, eventId: null, timestamp: 2600, provenance
  }, {
    id: "checkpoint-unbound", sessionId: "runtime-1", kind: "merge", sourceVersionIds: [], resultVersionId: null, sourceArtifactIds: [], resultArtifactIds: [], runId: null, turnId: null, eventId: null, timestamp: 2601, provenance
  }];
  runtime.projections.execution = projectExecution(runtime.v3, { maxItems: 100 });
  runtime.projections.coordination = projectCoordination(runtime.v3, { maxItems: 100 });
  runtime.projections.context = projectContext(runtime.v3, { maxItems: 100 });
  runtime.runPage = queryRunPage(runtime.v3);
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  const lane = html.match(/data-runtime-run-lanes[\s\S]*?<\/div><nav class="runtime-pagination/)?.[0] || "";
  const links = [...html.matchAll(/data-runtime-run-links[\s\S]*?<\/span><\/li>/g)].map((match) => match[0]).join(" ");
  assert.match(lane, /Recorded worker label/);
  assert.match(lane, /data-runtime-run-time="complete"/);
  assert.match(links, /data-runtime-coordination-run-id="run-1"/);
  assert.match(links, /data-runtime-coordination-task-id="task-1"/);
  assert.match(links, /data-runtime-entity-id="marker-task"/);
  assert.match(links, /data-runtime-entity-kind="context-transformation" data-runtime-entity-id="checkpoint-run"/);
  assert.match(links, /data-runtime-entity-kind="artifact" data-runtime-entity-id="artifact-result"/);
  assert.doesNotMatch(links, /data-runtime-entity-id="marker-unbound"/);
  assert.doesNotMatch(links, /data-runtime-entity-id="checkpoint-unbound"/);
  assert.match(html, /"transformations":\[/);
});

test("Lane evidence filters exact page bindings before applying the bound", () => {
  const runtime = fixtureRuntime();
  runtime.v3.coordination = Array.from({ length: 100 }, (_, index) => ({
    id: `unbound-marker-${index}`, sessionId: "runtime-1", kind: "wait", state: "started", timestamp: index, runId: null, taskId: "other-task", provenance
  }));
  runtime.v3.coordination.push({ id: "late-bound-marker", sessionId: "runtime-1", kind: "message", state: "delivered", timestamp: 101, runId: "run-1", taskId: "task-1", provenance });
  runtime.v3.contextTransformations = Array.from({ length: 100 }, (_, index) => ({
    id: `unbound-checkpoint-${index}`, sessionId: "runtime-1", kind: "merge", sourceVersionIds: [], resultVersionId: null, sourceArtifactIds: [], resultArtifactIds: [], runId: null, turnId: null, eventId: null, timestamp: index, provenance
  }));
  runtime.v3.contextTransformations.push({ id: "late-bound-checkpoint", sessionId: "runtime-1", kind: "compaction", sourceVersionIds: [], resultVersionId: null, sourceArtifactIds: ["artifact-1"], resultArtifactIds: ["artifact-1"], runId: "run-1", turnId: null, eventId: null, timestamp: 101, provenance });
  const pageEntry = { run: runtime.v3.agentRuns[0], task: { kind: "task", id: "task-1" } };
  const presentation = projectRuntimeLanePresentation(runtime.v3, [pageEntry]);
  assert.deepEqual(presentation.coordination.map((entry) => entry.id), ["late-bound-marker"]);
  assert.deepEqual(presentation.transformations.map((entry) => entry.id), ["late-bound-checkpoint"]);
  assert.deepEqual(presentation.artifacts.map((entry) => entry.id), ["artifact-1"]);
  runtime.projections.execution = projectExecution(runtime.v3, { maxItems: 100 });
  runtime.projections.coordination = projectCoordination(runtime.v3, { maxItems: 100 });
  runtime.projections.context = projectContext(runtime.v3, { maxItems: 100 });
  runtime.runPage = queryRunPage(runtime.v3);
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  assert.match(html, /"pageCoordination":\[\{[^\]]*late-bound-marker/);
  assert.match(html, /"pageTransformations":\[\{[^\]]*late-bound-checkpoint/);
});

test("stale run-page rendering preserves the other Runtime lenses and offers an Execution refresh", () => {
  const runtime = fixtureRuntime();
  runtime.runPageError = { code: "invalid_input", message: "run cursor is stale; refresh to browse the current runs." };
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  assert.match(html, /data-runtime-work-overview/);
  assert.match(html, /data-runtime-run-page-error-message/);
  assert.match(html, /href="\/fixture\/session\/runtime-1\?runtimeLens=execution"/);
});

test("P7 renders long-lived context assets once in recorded scope order", () => {
  const runtime = fixtureRuntime();
  const assets = [
    { id: "asset-org", sessionId: "runtime-1", kind: "memory", scope: "organization", origin: "provider-generated", contentAccess: "unavailable", title: "Org memory", summary: "Org <note>", sourcePath: "C:/context/<org>.md", producerRunId: "run-1", producerEventId: "event-1", sourceSessionIds: ["source-org"], consumerRunIds: ["run-1"], citationEventIds: ["event-1"], inheritedFromArtifactIds: ["artifact-parent"], hash: null, redacted: false, timeCreated: 1000, provenance },
    { id: "asset-session", sessionId: "runtime-1", kind: "experience", scope: "session", origin: "agent-generated", contentAccess: "summary", title: "Session experience", summary: "Recorded experience", sourcePath: null, producerRunId: null, sourceSessionIds: [], hash: null, redacted: false, timeCreated: 2000, provenance },
    { id: "asset-user", sessionId: "runtime-1", kind: "user-info", scope: "user", origin: "user-authored", contentAccess: "full", title: null, summary: "User & preference", sourcePath: null, producerRunId: null, sourceSessionIds: [], hash: null, redacted: false, timeCreated: 3000, provenance },
    { id: "asset-agent", sessionId: "runtime-1", kind: "memory", scope: "agent", origin: "agent-generated", contentAccess: "metadata-only", title: "Agent memory", summary: null, sourcePath: null, producerRunId: null, sourceSessionIds: [], hash: null, redacted: false, timeCreated: 4000, provenance },
    { id: "asset-project", sessionId: "runtime-1", kind: "experience", scope: "project", origin: "provider-generated", contentAccess: "metadata-only", title: "Project experience", summary: null, sourcePath: null, producerRunId: null, sourceSessionIds: [], hash: null, redacted: false, timeCreated: 5000, provenance },
    { id: "asset-instruction", sessionId: "runtime-1", kind: "instruction", scope: "project", origin: "provider-generated", contentAccess: "summary", title: "Keep instruction general", summary: null, sourcePath: null, producerRunId: null, sourceSessionIds: [], hash: null, redacted: false, timeCreated: 6000, provenance }
  ];
  runtime.protocol.contextArtifacts = [...runtime.protocol.contextArtifacts, ...assets];
  runtime.v3.contextArtifacts = runtime.protocol.contextArtifacts;
  runtime.projections.context = projectContext(runtime.v3, { maxItems: 100 });
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  const inspector = html.match(/<details class="runtime-context-assets"[\s\S]*?<\/details>/)?.[0] || "";
  assert.match(inspector, /<details class="runtime-context-assets" data-runtime-context-assets>/);
  assert.doesNotMatch(inspector, /data-runtime-context-assets" open/);
  const scopes = [...inspector.matchAll(/data-runtime-context-asset-scope="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(scopes, ["session", "agent", "project", "user", "organization"]);
  assert.equal((inspector.match(/data-runtime-context-asset data-asset-kind=/g) || []).length, 5);
  assert.match(inspector, /Org &lt;note&gt;/);
  assert.doesNotMatch(inspector, /Org <note>/);
  assert.match(inspector, /Source path: C:\/context\/&lt;org&gt;\.md/);
  assert.doesNotMatch(inspector, /Source path: C:\/context\/<org>\.md/);
  assert.match(inspector, /<strong>User info<\/strong>/); // fallback title is localized kind
  assert.match(inspector, /Source session:.*href="\/fixture\/session\/source-org"/);
  assert.match(inspector, /data-runtime-evidence-kind="run" data-runtime-evidence-id="run-1"/);
  assert.match(inspector, />Producer run<\/button>/);
  assert.match(inspector, /data-runtime-evidence-kind="event" data-runtime-evidence-id="event-1"/);
  assert.match(inspector, />Producer event<\/button>/);
  assert.match(inspector, /data-runtime-evidence-kind="artifact" data-runtime-evidence-id="artifact-parent"/);
  assert.match(inspector, /data-runtime-evidence-kind="artifact" data-runtime-evidence-id="asset-user"/);
  assert.match(html, /Keep instruction general/);
  assert.equal((html.match(/data-asset-id="asset-org"/g) || []).length, 1);
  assert.equal((html.match(/data-asset-id="asset-session"/g) || []).length, 1);
  const style = readFileSync(path.join(process.cwd(), "src", "static", "style.css"), "utf8");
  assert.match(style, /\.runtime-context-assets > summary \{[\s\S]*?flex-wrap: wrap/);
  assert.match(style, /\.runtime-context-asset-kind \{[\s\S]*?white-space: nowrap/);
  assert.match(style, /\.runtime-context-asset-summary \{[\s\S]*?overflow-wrap: anywhere/);
});

test("P7 empty and truncated context assets stay honest and localized", () => {
  const runtime = fixtureRuntime();
  runtime.projections.context.truncated = true;
  let html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  const inspector = html.match(/<details class="runtime-context-assets"[\s\S]*?<\/details>/)?.[0] || "";
  assert.equal((inspector.match(/No long-lived context assets are recorded/g) || []).length, 1);
  assert.match(inspector, /No long-lived context assets are recorded in this bounded view; additional assets may be omitted\./);

  const previousLocale = getLocale();
  setLocale("zh");
  try {
    html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
    assert.match(html, /当前有界视图未记录长期上下文资产；可能还有资产未显示。/);
  } finally {
    setLocale(previousLocale);
  }
});

test("P6 keeps rail search and Work overview readable at desktop and medium widths", () => {
  const style = readFileSync(path.join(process.cwd(), "src", "static", "style.css"), "utf8");
  assert.match(style, /\.app-rail \.search-form \{[\s\S]*?width: 100%;[\s\S]*?min-width: 0;/);
  assert.match(style, /\.app-rail \.search-input \{[\s\S]*?width: 100%;[\s\S]*?max-width: 100%;/);
  assert.match(style, /\.app-rail \.search-visible-label \{[\s\S]*?white-space: normal;/);
  assert.match(style, /\.app-rail \.search-input:focus-visible \{[\s\S]*?outline: 2px solid var\(--accent-color\);/);
  assert.match(style, /\.runtime-work-overview-grid \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 280px\), 1fr\)\);/);
  assert.match(style, /\.runtime-work-overview \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(style, /@media \(max-width: 1240px\) \{[\s\S]*?\.runtime-work-overview-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(style, /\.runtime-overview-task-table th:nth-child\(3\),[\s\S]*?\.runtime-overview-task-table td:nth-child\(5\) \{ white-space: nowrap;/);
  assert.match(style, /@media \(max-width: 768px\) \{[\s\S]*?\.rail-utility \.search-form \{\s*display: none;/);
});

test("P6 session metrics use localized hierarchy, recorded span, and token details", () => {
  const previousLocale = getLocale();
  const metrics = {
    totals: {
      messages: 2155, steps: 200, toolCalls: 18, branches: 13, runtimeMs: 6 * 3_600_000 + 35 * 60_000,
      cost: 1.25, directInputTokens: 100, directOutputTokens: 20, directReasoningTokens: 3,
      directCacheReadTokens: 4, directCacheWriteTokens: 2, directTotalTokens: 129, totalTokens: 129
    },
    tools: [{ name: "apply_patch", count: 4 }]
  };
  try {
    setLocale("en");
    const en = renderSessionPage({ session: { id: "metrics", title: "Metrics" }, provider: "fixture", sessionMetrics: metrics });
    assert.match(en, /class="session-stat-label">Messages/);
    assert.match(en, /class="session-stat-value">2,155/);
    assert.match(en, /Recorded span/);
    assert.match(en, /6h 35m/);
    assert.match(en, /Top tools:/);
    assert.match(en, /cache read/);
    assert.doesNotMatch(en, />runtime</);

    setLocale("zh");
    assert.equal(formatLocalizedDurationMs(9 * 86_400_000 + 5 * 3_600_000), "9天 5时");
    const zh = renderSessionPage({ session: { id: "metrics", title: "Metrics" }, provider: "fixture", sessionMetrics: metrics });
    assert.match(zh, /class="session-stat-label">消息/);
    assert.match(zh, /记录跨度/);
    assert.match(zh, /6时 35分/);
    assert.match(zh, /常用工具：/);
    assert.match(zh, /缓存读取/);
    assert.match(renderRuntimeWorkbench(fixtureRuntime(), "fixture", "runtime-1"), /耗时: 2秒/);
  } finally {
    setLocale(previousLocale);
  }
});

test("Work Graph omits healthy structured storage diagnostics instead of stringifying them", () => {
  const runtime = fixtureRuntime();
  runtime.storageDiagnostic = { currentSqliteAgents: 1, states: [] };
  assert.doesNotMatch(renderRuntimeWorkbench(runtime, "fixture", "runtime-1"), /\[object Object\]/);

  runtime.storageDiagnostic = { note: "One provider store is unreadable." };
  assert.match(renderRuntimeWorkbench(runtime, "fixture", "runtime-1"), /One provider store is unreadable\./);
});

test("Execution usage keeps complete values authoritative and exposes stable hooks", () => {
  const html = renderRuntimeWorkbench(fixtureRuntime(), "fixture", "runtime-1");
  const usage = html.match(/<section class="runtime-usage-summary"[\s\S]*?<\/section>/)?.[0] || "";
  assert.match(usage, /data-runtime-usage-summary/);
  assert.match(usage, /data-runtime-usage-complete="true"/);
  assert.match(usage, /data-runtime-usage-truncated="false"/);
  assert.match(usage, /data-runtime-usage-request-count="1"/);
  assert.match(usage, /data-runtime-usage-total="120"/);
  assert.match(usage, /Requests: 1/);
  assert.match(usage, /Total tokens: 120/);
  assert.match(usage, /Input: 100 · Output: 20 · Reasoning: 0 · Cache read: 0 · Cache write: 0 · complete/);
  assert.doesNotMatch(usage, /≥/);
});

test("Execution usage labels bounded values as visible lower bounds", () => {
  const runtime = fixtureRuntime();
  runtime.projections.execution = {
    ...runtime.projections.execution,
    truncated: true,
    usage: {
      ...runtime.projections.execution.usage,
      requestCount: 96,
      complete: false,
      input: 9000000,
      cacheRead: 1000000,
      cacheWrite: 0,
      output: 500000,
      reasoning: 134337,
      total: 10634337
    }
  };
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  const usage = html.match(/<section class="runtime-usage-summary"[\s\S]*?<\/section>/)?.[0] || "";
  assert.match(usage, /data-runtime-usage-complete="false"/);
  assert.match(usage, /data-runtime-usage-truncated="true"/);
  assert.match(usage, /data-runtime-usage-request-count="96"/);
  assert.match(usage, /data-runtime-usage-total="10634337"/);
  assert.match(usage, /Visible requests: 96/);
  assert.match(usage, /Token lower bound: ≥ 10,634,337/);
  assert.match(usage, /Input: ≥ 9,000,000 · Output: ≥ 500,000 · Reasoning: ≥ 134,337 · Cache read: ≥ 1,000,000 · Cache write: ≥ 0 · incomplete/);
  assert.match(usage, /Only the visible requests in this bounded projection are shown; token values are lower bounds\./);
  assert.doesNotMatch(usage, /Requests: 96 · Total tokens:/);
});

test("Execution usage keeps incomplete evidence explicit without bounded projection claim", () => {
  const runtime = fixtureRuntime();
  runtime.projections.execution = {
    ...runtime.projections.execution,
    usage: { ...runtime.projections.execution.usage, complete: false, total: 120 }
  };
  const previousLocale = getLocale();
  setLocale("zh");
  try {
    const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
    const usage = html.match(/<section class="runtime-usage-summary"[\s\S]*?<\/section>/)?.[0] || "";
    assert.match(usage, /可见请求: 1/);
    assert.match(usage, /Token 下限: ≥ 120/);
    assert.match(usage, /请求用量证据不完整；Token 数值为下限。/);
    assert.match(usage, /data-runtime-usage-complete="false"/);
    assert.match(usage, /data-runtime-usage-truncated="false"/);
  } finally {
    setLocale(previousLocale);
  }
});

test("Work goal status renders the paused localization and neutral static state", () => {
  const runtime = fixtureRuntime();
  runtime.v3.goals = [{
    id: "goal-paused", sessionId: "runtime-1", title: null, description: "Paused goal", status: "paused", taskIds: [],
    parentGoalId: null, ownerActorId: null, timeCreated: 1000, timeUpdated: 1100, timeCompleted: null, provenance
  }];
  runtime.projections.work = projectWork(runtime.v3, { maxItems: 100 });
  const previousLocale = getLocale();
  try {
    setLocale("en");
    assert.match(renderRuntimeWorkbench(runtime, "fixture", "runtime-1"), /runtime-status-paused[^>]*>paused</);
    setLocale("zh");
    assert.match(renderRuntimeWorkbench(runtime, "fixture", "runtime-1"), /runtime-status-paused[^>]*>已暂停</);
  } finally {
    setLocale(previousLocale);
  }
  const style = readFileSync(path.join(process.cwd(), "src", "static", "style.css"), "utf8");
  assert.match(style, /\.runtime-status-paused \{ color: var\(--text-muted\); \}/);
  assert.match(style, /\.runtime-status-border-paused \{ border-left-color: var\(--text-muted\); \}/);
});

test("Events surface renders diagnostics and source-order table without the Work evidence lens", () => {
  const runtime = fixtureRuntime();
  runtime.protocol.events = [
    { ...runtime.protocol.events[0], id: "event-source-first", sequence: 1, timestamp: 9000, normalizedKind: "model.response", category: "model", compaction: { summary: "Recorded compaction " + "detail ".repeat(60) } },
    { ...runtime.protocol.events[1], id: "event-source-second", sequence: 2, timestamp: 1000, normalizedKind: "context.started", category: "context", provenance: { ...provenance, fidelity: "derived" } }
  ];
  const html = renderRuntimeEvents(runtime, "fixture", "runtime-1");
  assert.match(html, /data-runtime-events-root/);
  assert.match(html, /Each recorded event is shown in source order/);
  assert.match(html, /Protocol diagnostics/);
  assert.match(html, /Protocol version/);
  assert.match(html, /Work/);
  assert.match(html, /Execution/);
  assert.match(html, /Coordination/);
  assert.doesNotMatch(html, /runtime\.domain_(work|execution|coordination)/);
  assert.match(html, /data-runtime-density-category="model"/);
  assert.match(html, /data-runtime-density-category="context"/);
  assert.match(html, /<td[^>]*>1<\/td>[\s\S]*<td[^>]*>2<\/td>/);
  assert.match(html, /Recorded/);
  assert.match(html, /Derived/);
  const table = html.match(/<tbody data-runtime-event-list>[\s\S]*?<\/tbody>/)?.[0] || "";
  assert.match(table, /task recorded/);
  assert.match(table, /…/);
  assert.doesNotMatch(table, /task-1|run-1|compact-1|fixture\.event|source-1/);
  assert.match(html, /data-runtime-events-evidence/);
  assert.doesNotMatch(html, /detail-events-shell/);
  assert.doesNotMatch(html, /providerData/);
});

test("Events density is explicitly bounded and reports a lower bound", () => {
  const runtime = fixtureRuntime();
  runtime.protocol.events = Array.from({ length: 1005 }, (_, index) => ({
    ...runtime.protocol.events[0], id: `event-${index + 1}`, sequence: index + 1, timestamp: index + 1,
    category: index % 2 ? "model" : "tool"
  }));
  const html = renderRuntimeEvents(runtime, "fixture", "runtime-1");
  assert.match(html, /<details class="runtime-events-structure"><summary>[^<]+<\/summary>/);
  assert.match(html, /Density is calculated from the first 1000 source events/);
  assert.match(html, /data-runtime-density-category="model"[\s\S]*<strong>500<\/strong>/);
  assert.match(html, /data-runtime-density-category="tool"[\s\S]*<strong>500<\/strong>/);
});

test("Unavailable Events SSR and client initialization keep missing controls inert", () => {
  const html = renderRuntimeEvents({ protocol: null, summary: { completeness: "unknown" } }, "fixture", "missing");
  assert.match(html, /data-runtime-events-root/);
  assert.doesNotMatch(html, /data-runtime-event-list/);
  const source = readFileSync(path.join(process.cwd(), "src", "static", "app", "runtime-events.js"), "utf8");
  assert.match(source, /if \(!eventList\) return/);
  assert.match(source, /if \(previousButton\)/);
  assert.match(source, /if \(nextButton\)/);
});

test("Events pagination replaces the bounded current-page evidence map", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "static", "app", "runtime-events.js"), "utf8");
  assert.match(source, /currentPageEvidence\.get\(String\(id\)\)/);
  assert.match(source, /currentPageEvidence = new Map\(currentEvents\.map/);
  assert.match(source, /item\.summary\?\.compactionSummary/);
  assert.match(source, /key !== "providerData"/);
});

test("Events client hook initializes each explicit root and preserves bounded cursor API", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "static", "app", "runtime-events.js"), "utf8");
  assert.match(source, /querySelectorAll\("\[data-runtime-events-root\]"\)/);
  assert.match(source, /runtime\/events\?\$\{params\}/);
  assert.match(source, /data-runtime-event-evidence-id/);
  assert.match(source, /runtime_event_sequence/);
  assert.match(source, /runtime-event-sequence/);
  assert.match(source, /runtime-event-fidelity-/);
  assert.match(source, /runtime:filter-events/);
  assert.match(source, /data-runtime-events-clear-filter/);
  const html = renderRuntimeEvents(fixtureRuntime(), "fixture", "runtime-1");
  assert.match(html, /data-runtime-events-focus-filter/);
});

test("Provider-neutral event summary facts are bounded and ID-free", () => {
  const facts = summarizeEvent({ phase: "completed", taskId: "task-1", runId: "run-1", turnId: "turn-1", compaction: { summary: "x".repeat(300) } });
  assert.equal(facts.phase, "completed");
  assert.equal(facts.hasTask, true);
  assert.equal(facts.hasRun, true);
  assert.equal(facts.hasTurn, true);
  assert.ok(facts.compactionSummary.length <= 180);
  assert.match(facts.compactionSummary, /…$/);
  assert.doesNotMatch(JSON.stringify(facts), /task-1|run-1|turn-1/);
});

test("Context keeps the scoped asset inspector before compacted results and general artifacts", () => {
  const runtime = fixtureRuntime();
  runtime.protocol.contextArtifacts.push({ id: "memory-1", sessionId: "runtime-1", kind: "memory", scope: "user", origin: "agent-generated", contentAccess: "metadata-only", title: "User memory", summary: null, sourcePath: null, producerRunId: null, sourceSessionIds: [], hash: null, redacted: false, timeCreated: 12000, metadata: {}, provenance });
  refreshProjections(runtime);
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  const resultIndex = html.indexOf("Context after compaction");
  const evidenceIndex = html.indexOf("<details>", resultIndex);
  const artifactIndex = html.indexOf("User memory");
  assert.ok(resultIndex >= 0 && evidenceIndex > resultIndex);
  assert.ok(artifactIndex >= 0 && artifactIndex < resultIndex);
  assert.match(html, /data-runtime-context-asset data-asset-kind="memory"/);
  assert.match(html, /data-runtime-context-asset-scope="user"/);
});

test("Context bounds legacy compaction result fallback", () => {
  const runtime = fixtureRuntime();
  const template = runtime.protocol.events.find((event) => event.compaction);
  runtime.protocol.events = Array.from({ length: 55 }, (_, index) => ({
    ...template,
    id: `event-context-${index}`,
    sequence: index + 1,
    compaction: { ...template.compaction, summary: `compact-result-${index}` }
  }));
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  assert.match(html, /compact-result-49/);
  assert.doesNotMatch(html, /compact-result-50/);
  assert.match(html, /Showing the first 50 recorded compaction results/);
});

test("child session lineage renders the focused session once under its recorded parent", () => {
  const runtime = fixtureRuntime();
  runtime.protocol.sessionId = "child-1";
  runtime.protocol.session.ref = { provider: "fixture", sessionId: "child-1" };
  runtime.protocol.relationships = [{
    type: "spawned",
    fromSessionId: "parent-1",
    toSessionId: "child-1",
    fromRef: { provider: "fixture", sessionId: "parent-1" },
    toRef: { provider: "fixture", sessionId: "child-1" },
    provenance
  }];
  refreshProjections(runtime);
  const html = renderRuntimeWorkbench(runtime, "fixture", "child-1");
  const coordination = html.match(/data-runtime-section="coordination"[\s\S]*?data-runtime-section="context"/)?.[0] || "";
  assert.equal((coordination.match(/href="\/fixture\/session\/child-1"/g) || []).length, 1);
  assert.equal((coordination.match(/href="\/fixture\/session\/parent-1"/g) || []).length, 1);
});

test("Work is the unconditional default top-level tab", () => {
  const html = renderSessionPage({
    session: { id: "linear", title: "Linear", time_created: 1 },
    provider: "fixture",
    runtimeWorkbench: renderRuntimeWorkbench(fixtureRuntime(), "fixture", "linear")
  });
  assert.match(html, /id="tab-btn-work"/);
  assert.match(html, /id="tab-work"/);
  assert.match(html, /aria-selected="true" aria-controls="tab-work"/);
  assert.match(html, /id="tab-btn-work"[^>]*>Work<\/button>/);
  assert.match(html, /id="tab-btn-conversation"[^>]*>Conversation<\/button>/);
  assert.match(html, /id="tab-btn-events"[^>]*>Events<\/a>/);
  assert.doesNotMatch(html, /id="tab-btn-flow"/);
});

test("session tabpanels stay balanced when reasoning contains replacement tokens", () => {
  const tree = {
    session: { id: "balanced", title: "Balanced" },
    messages: [{
      id: "message-1",
      role: "assistant",
      data: { role: "assistant", time: { created: 1 } },
      parts: [
        {
          id: "reasoning-1",
          type: "reasoning",
          data: { type: "reasoning", text: `${"context ".repeat(730)}$\` ${"tail ".repeat(100)}` },
          childSessions: []
        },
        {
          id: "text-1",
          type: "text",
          data: { type: "text", text: "done" },
          childSessions: []
        }
      ]
    }],
    detachedChildren: []
  };
  const html = renderSessionPage({
    session: { id: "balanced", title: "Balanced", time_created: 1 },
    sessionTree: tree,
    provider: "fixture"
  });
  const mainStart = html.indexOf('<section id="session-balanced" class="main-content">');
  const mainEnd = html.lastIndexOf("\n  </section>\n</div>");
  assert.ok(mainStart >= 0 && mainEnd > mainStart, "main content must have a closing section");
  const main = html.slice(mainStart, mainEnd);
  const panelIds = [...main.matchAll(/<div role="tabpanel" id="(tab-(?:work|conversation|events))"/g)].map((match) => match[1]);
  assert.deepEqual(panelIds, ["tab-work", "tab-conversation", "tab-events"]);
  assert.equal((main.match(/<div role="tabpanel"/g) || []).length, 3);
  const reasoningStart = main.indexOf('<div class="reasoning-body markdown">');
  const reasoningEnd = main.indexOf("</details>", reasoningStart);
  const messageBody = main.indexOf('<div class="message-body', reasoningStart);
  assert.ok(reasoningStart >= 0 && reasoningEnd > reasoningStart && messageBody > reasoningEnd, "reasoning must close before the message body");
  assert.match(main, /context context/);
  assert.match(main, /id="tab-events"[\s\S]*\n    <\/div>$/);
  assert.match(html.slice(mainEnd), /^\n  <\/section>\n<\/div>/);
});

test("top-level session tabs manage only the two primary modes", () => {
  const enhancements = readFileSync(path.join(process.cwd(), "src", "static", "app", "enhancements.js"), "utf8");
  assert.match(enhancements, /tabBar\.parentElement\?\.querySelectorAll\(":scope > \[role='tabpanel'\]"\)/);
  assert.doesNotMatch(enhancements, /document\.querySelectorAll\("\[role='tabpanel'\]"\)/);
  assert.match(enhancements, /targetPanelId === "tab-work"/);
  assert.match(enhancements, /data-runtime-root.*scrollIntoView|data-runtime-root\]\?\.scrollIntoView/);
  assert.match(enhancements, /data-detail-tab/);
  assert.match(enhancements, /hashEvents && tab === tabButtons\[0\]/);
  assert.match(enhancements, /tab === tabButtons\[0\] \? "0" : "-1"/);
});

test("top-level detail tab switches preserve Workbench as one surface", () => {
  const enhancements = readFileSync(path.join(process.cwd(), "src", "static", "app", "enhancements.js"), "utf8");
  const switchTab = enhancements.match(/function switchTab\(tabButton\) \{([\s\S]*?)\n  \}/)?.[1] || "";
  assert.match(switchTab, /history\.replaceState\(null, "", `#\$\{encodeURIComponent\(targetPanelId\)\}`\)/);
  assert.doesNotMatch(switchTab, /location\.(assign|reload|replace)\s*\(/);
  assert.doesNotMatch(switchTab, /data-runtime-lens/);
});

test("Runtime work cards allow long canonical task and agent ids to wrap on narrow screens", () => {
  const style = readFileSync(path.join(process.cwd(), "src", "static", "style.css"), "utf8");
  assert.match(style, /\.runtime-card-heading > strong \{[\s\S]*?min-width: 0;[\s\S]*?overflow-wrap: anywhere;/);
  assert.match(style, /\.runtime-card-heading > \.runtime-status \{ flex: 0 0 auto; \}/);
});

test("Work opening is a bounded narrative over finalized v3 projections", () => {
  const runtime = fixtureRuntime();
  const recordedGoal = {
    id: "goal-1", sessionId: "runtime-1", title: "Ship <fixture>", description: "Keep the recorded result", status: "active", taskIds: ["task-1"],
    parentGoalId: null, ownerActorId: null, timeCreated: 900, timeUpdated: 3000, timeCompleted: null, provenance
  };
  refreshProjections(runtime);
  runtime.v3.goals = [recordedGoal];
  runtime.v3.contextVersions = [{ id: "version-1", sessionId: "runtime-1", sequence: 1, parentVersionIds: [], artifactIds: ["artifact-1"], createdAt: 11000, provenance }];
  runtime.v3.contextTransformations = [{ id: "transformation-1", sessionId: "runtime-1", kind: "compaction", sourceVersionIds: [], resultVersionId: "version-1", sourceArtifactIds: [], resultArtifactIds: ["artifact-1"], eventId: "event-context", runId: null, turnId: null, timestamp: 11000, provenance }];
  runtime.projections.work = projectWork(runtime.v3, { maxItems: 100 });
  runtime.projections.context = projectContext(runtime.v3, { maxItems: 100 });
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  const overview = html.match(/data-runtime-work-overview[\s\S]*?data-runtime-overview-end/)?.[0] || "";
  assert.match(overview, /Ship &lt;fixture&gt;/);
  assert.match(overview, /Keep the recorded result/);
  assert.match(overview, /All 1 visible tasks are completed; the recorded goal is active/);
  assert.match(overview, /1 \/ 1/);
  assert.match(overview, /height:5px|runtime-progress-track/);
  assert.match(overview, /42 tokens after/);
  assert.match(overview, /Retain &lt;the result&gt; and discard copied history/);
  assert.match(overview, /data-runtime-context-result/);
  assert.match(overview, /Open the Conversation inspector/);
  assert.doesNotMatch(overview, /runtime-relation-list/);
});

test("Work opening keeps missing goal and context evidence explicit", () => {
  const runtime = fixtureRuntime();
  runtime.protocol.events = runtime.protocol.events.filter((event) => !event.compaction);
  runtime.protocol.contextArtifacts = [];
  refreshProjections(runtime);
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  assert.match(html, /No recorded goal/);
  assert.match(html, /No current context result is recorded/);
  assert.doesNotMatch(html, /Retained content:/);
  assert.doesNotMatch(html, /memory/);
});

test("Work opening bounds long goal narratives while keeping the complete record reachable", () => {
  const runtime = fixtureRuntime();
  const longGoal = `Recorded goal ${"with bounded primary text ".repeat(20)}`;
  refreshProjections(runtime);
  runtime.v3.goals = [{
    id: "goal-long", sessionId: "runtime-1", title: null, description: longGoal, status: "active", taskIds: [],
    parentGoalId: null, ownerActorId: null, timeCreated: 900, timeUpdated: 3000, timeCompleted: null, provenance
  }];
  runtime.projections.work = projectWork(runtime.v3, { maxItems: 100 });
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  const heading = html.match(/<h4>(.*?)<\/h4>/)?.[1] || "";
  assert.ok(heading.endsWith("…"));
  assert.ok(heading.length < longGoal.length);
  assert.match(html, /Show complete recorded goal/);
  assert.match(html, new RegExp(longGoal));
});

test("Work opening chooses a newer recorded context version over an older transformation", () => {
  const runtime = fixtureRuntime();
  runtime.v3.contextVersions = [
    { id: "version-old", sessionId: "runtime-1", sequence: 1, parentVersionIds: [], artifactIds: [], createdAt: 1000, provenance },
    { id: "version-new", sessionId: "runtime-1", sequence: 2, parentVersionIds: ["version-old"], artifactIds: [], createdAt: 12000, provenance }
  ];
  runtime.v3.contextTransformations = [{
    id: "transformation-old", sessionId: "runtime-1", kind: "compaction", sourceVersionIds: [], resultVersionId: "version-old",
    sourceArtifactIds: [], resultArtifactIds: [], eventId: "event-context", runId: null, turnId: null, timestamp: 11000, provenance
  }];
  runtime.projections.context = projectContext(runtime.v3, { maxItems: 100 });
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  const overview = html.match(/data-runtime-work-overview[\s\S]*?data-runtime-overview-end/)?.[0] || "";
  assert.match(overview, /context version · result version recorded/);
  assert.doesNotMatch(overview, /compaction · result version recorded/);
  assert.doesNotMatch(overview, /42 tokens after/);
});

test("Work opening uses recorded context ancestry before missing ordering fields", () => {
  const runtime = fixtureRuntime();
  runtime.v3.contextVersions = [
    { id: "version-root", sessionId: "runtime-1", sequence: null, parentVersionIds: [], artifactIds: [], createdAt: null, provenance },
    { id: "version-result", sessionId: "runtime-1", sequence: 1, parentVersionIds: ["version-root"], artifactIds: [], createdAt: null, provenance }
  ];
  runtime.v3.contextTransformations = [{
    id: "transformation-result", sessionId: "runtime-1", kind: "compaction", sourceVersionIds: ["version-root"], resultVersionId: "version-result",
    sourceArtifactIds: [], resultArtifactIds: [], eventId: null, runId: null, turnId: null, timestamp: 5000, provenance
  }];
  runtime.projections.context = projectContext(runtime.v3, { maxItems: 100 });
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  const overview = html.match(/data-runtime-work-overview[\s\S]*?data-runtime-overview-end/)?.[0] || "";
  assert.match(overview, /compaction · result version recorded/);
  assert.doesNotMatch(overview, /The current context result cannot be ordered from recorded timestamps or sequence/);
});

test("Work opening bounds retained context summaries and exposes complete evidence", () => {
  const runtime = fixtureRuntime();
  const longSummary = `Retained context ${"with important recorded detail ".repeat(20)}`;
  runtime.v3.contextArtifacts[0].summary = longSummary;
  runtime.v3.contextVersions = [{ id: "version-summary", sessionId: "runtime-1", sequence: 1, parentVersionIds: [], artifactIds: ["artifact-1"], createdAt: 12000, provenance }];
  runtime.v3.contextTransformations = [{
    id: "transformation-summary", sessionId: "runtime-1", kind: "compaction", sourceVersionIds: [], resultVersionId: "version-summary",
    sourceArtifactIds: [], resultArtifactIds: ["artifact-1"], eventId: null, runId: null, turnId: null, timestamp: 12000, provenance
  }];
  runtime.projections.context = projectContext(runtime.v3, { maxItems: 100 });
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  const overview = html.match(/data-runtime-work-overview[\s\S]*?data-runtime-overview-end/)?.[0] || "";
  assert.match(overview, /Retained context with important recorded detail/);
  assert.match(overview, /Show complete recorded context summary/);
  assert.match(overview, new RegExp(longSummary));
});

test("Work opening labels context asset counts as a lower bound when bounded", () => {
  const runtime = fixtureRuntime();
  runtime.v3.contextArtifacts.push(
    { id: "memory-asset", sessionId: "runtime-1", kind: "memory", scope: "user", origin: "agent-generated", contentAccess: "metadata-only", title: "Memory", summary: null, sourcePath: null, producerRunId: null, sourceSessionIds: [], hash: null, redacted: false, timeCreated: 12000, provenance },
    { id: "experience-asset", sessionId: "runtime-1", kind: "experience", scope: "session", origin: "agent-generated", contentAccess: "metadata-only", title: "Experience", summary: null, sourcePath: null, producerRunId: null, sourceSessionIds: [], hash: null, redacted: false, timeCreated: 12001, provenance },
    { id: "user-info-asset", sessionId: "runtime-1", kind: "user-info", scope: "user", origin: "user-authored", contentAccess: "metadata-only", title: "User info", summary: null, sourcePath: null, producerRunId: null, sourceSessionIds: [], hash: null, redacted: false, timeCreated: 12002, provenance }
  );
  runtime.projections.context = projectContext(runtime.v3, { maxItems: 100 });
  runtime.projections.context.truncated = true;
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  assert.match(html, /Memory/);
  assert.match(html, /Experience/);
  assert.match(html, /User info/);
  assert.match(html, /Observed counts are a lower bound; more context assets may be omitted/);
});

test("Work opening keeps context ordering uncertainty explicit", () => {
  const runtime = fixtureRuntime();
  runtime.v3.contextVersions = [{ id: "version-unordered", sessionId: "runtime-1", sequence: null, parentVersionIds: [], artifactIds: [], createdAt: null, provenance }];
  runtime.v3.contextTransformations = [{
    id: "transformation-unordered", sessionId: "runtime-1", kind: "compaction", sourceVersionIds: [], resultVersionId: null,
    sourceArtifactIds: [], resultArtifactIds: [], eventId: null, runId: null, turnId: null, timestamp: null, provenance
  }];
  runtime.projections.context = projectContext(runtime.v3, { maxItems: 100 });
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  const overview = html.match(/data-runtime-work-overview[\s\S]*?data-runtime-overview-end/)?.[0] || "";
  assert.match(overview, /The current context result cannot be ordered from recorded timestamps or sequence/);
  assert.doesNotMatch(overview, /Retain &lt;the result&gt; and discard copied history/);
});

test("Work overflow task table repeats header and scope semantics", () => {
  const runtime = fixtureRuntime();
  runtime.v3.tasks = Array.from({ length: 7 }, (_, index) => ({
    id: `task-${index + 1}`, sessionId: "runtime-1", kind: "task", status: index === 6 ? "running" : "completed", title: `Task ${index + 1}`,
    parentTaskId: null, toolCallId: null, agentPath: null, correlationId: null, dependencies: [], assignee: null, owner: null,
    requestEventId: null, triggerEventId: null, scheduleId: null, deadline: null, runIds: [], revision: null, outcome: null,
    failureReason: null, cancellationReason: null, timeCreated: 1000, timeUpdated: 2000, timeCompleted: index === 6 ? null : 2000, provenance
  }));
  runtime.projections.work = projectWork(runtime.v3, { maxItems: 100 });
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  const overflow = html.match(/<details class="runtime-task-overflow">[\s\S]*?<\/details>/)?.[0] || "";
  assert.match(overflow, /<thead>[\s\S]*?<th scope="col">Task<\/th>/);
  assert.match(overflow, /data-label="Owner"/);
});

test("Work task rows deduplicate repeated task/run states while retaining distinct states", () => {
  const runtime = fixtureRuntime();
  runtime.v3.agentRuns.push({
    ...runtime.v3.agentRuns[0], id: "run-2", status: "completed", timeStart: 1300, timeEnd: 2600
  });
  runtime.v3.tasks[0].runIds = ["run-1", "run-2"];
  runtime.projections.work = projectWork(runtime.v3, { maxItems: 100 });
  runtime.projections.execution = projectExecution(runtime.v3, { maxItems: 100 });
  let html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  let row = html.match(/data-runtime-overview-task="task-1"[\s\S]*?<\/tr>/)?.[0] || "";
  assert.doesNotMatch(row, /completed · completed/);
  assert.match(row, />completed<\/span>/);

  runtime.v3.agentRuns[1].status = "running";
  runtime.projections.execution = projectExecution(runtime.v3, { maxItems: 100 });
  html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  row = html.match(/data-runtime-overview-task="task-1"[\s\S]*?<\/tr>/)?.[0] || "";
  assert.match(row, /completed · running/);
  assert.equal(row.match(/runtime-status[^>]*>([^<]*)<\/span>/)?.[1], "completed · running");
});

test("Work opening renders separate goal-task and collaboration views", () => {
  const runtime = fixtureRuntime();
  const task2 = { ...runtime.v3.tasks[0], id: "task-2", title: "Review fixture", dependencies: ["task-1"], status: "running", timeCompleted: null };
  runtime.v3.tasks = [runtime.v3.tasks[0], task2];
  runtime.v3.goals = [{
    id: "goal-graph", sessionId: "runtime-1", title: "Ship fixture", description: null, status: "active", taskIds: ["task-1", "task-2"],
    parentGoalId: null, ownerActorId: null, timeCreated: 900, timeUpdated: 3000, timeCompleted: null, provenance
  }];
  runtime.v3.actors = [
    { id: "team-build", sessionId: "runtime-1", kind: "team", name: "Build team", providerActorId: null, teamId: null, memberActorIds: ["agent-a"], runIds: [], sessionRef: null, provenance },
    { id: "agent-a", sessionId: "runtime-1", kind: "agent", name: "Alice", providerActorId: null, teamId: "team-build", memberActorIds: [], runIds: [], sessionRef: null, provenance },
    { id: "agent-b", sessionId: "runtime-1", kind: "agent", name: "Bob", providerActorId: null, teamId: null, memberActorIds: [], runIds: [], sessionRef: null, provenance }
  ];
  runtime.v3.coordination = [
    { id: "observation-message-1", sessionId: "runtime-1", kind: "message", state: "delivered", timestamp: 4000, senderActorId: "agent-a", recipientActorId: "agent-b", runId: "run-1", eventId: null, turnId: null, correlationId: null, provenance },
    { id: "observation-message-2", sessionId: "runtime-1", kind: "message", state: "delivered", timestamp: 4001, senderActorId: "agent-a", recipientActorId: "agent-b", runId: "run-1", eventId: null, turnId: null, correlationId: null, provenance }
  ];
  runtime.projections.work = projectWork(runtime.v3, { maxItems: 100 });
  runtime.projections.execution = projectExecution(runtime.v3, { maxItems: 100 });
  runtime.projections.coordination = projectCoordination(runtime.v3, { maxItems: 100 });
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  assert.doesNotMatch(html, /data-runtime-graph-tabs/);
  assert.doesNotMatch(html, /data-runtime-graph-tab=/);
  assert.match(html, /data-runtime-graph-panel="goal"/);
  assert.match(html, /recorded membership/);
  assert.match(html, /recorded dependency/);
  assert.match(html, /data-runtime-graph-panel="collaboration"/);
  assert.match(html, /message ×2/);
  assert.match(html, /recorded team member/);
  assert.doesNotMatch(html, /runtime-legacy-work|runtime-relation-list/);
});

test("Work graphs state missing goal, actors, and unplaced observations without inventing nodes", () => {
  const runtime = fixtureRuntime();
  runtime.v3.goals = [];
  runtime.v3.actors = [];
  runtime.v3.coordination = [{
    id: "observation-unplaced", sessionId: "runtime-1", kind: "wait", state: "started", timestamp: 4000,
    senderActorId: null, recipientActorId: null, runId: null, eventId: null, turnId: null, correlationId: null, provenance
  }];
  runtime.projections.work = projectWork(runtime.v3, { maxItems: 100 });
  runtime.projections.execution = projectExecution(runtime.v3, { maxItems: 100 });
  runtime.projections.coordination = projectCoordination(runtime.v3, { maxItems: 100 });
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  assert.match(html, /No recorded goal; the recorded tasks are not associated with a goal/);
  assert.match(html, /No recorded actors or teams are available/);
  assert.match(html, /1 recorded observations have no resolvable actor on both ends/);
  assert.match(html, /No recorded relationships connect the visible nodes/);
});

test("Collaboration graph aggregates kinds and gates async edges on recorded run mode", () => {
  const runtime = fixtureRuntime();
  runtime.v3.actors = [
    { id: "team-build", sessionId: "runtime-1", kind: "team", name: "Build team", providerActorId: null, teamId: null, memberActorIds: ["agent-a"], runIds: [], sessionRef: null, provenance },
    { id: "agent-a", sessionId: "runtime-1", kind: "agent", name: "Alice", providerActorId: null, teamId: "team-build", memberActorIds: [], runIds: [], sessionRef: null, provenance },
    { id: "agent-b", sessionId: "runtime-1", kind: "agent", name: "Bob", providerActorId: null, teamId: null, memberActorIds: [], runIds: [], sessionRef: null, provenance }
  ];
  runtime.v3.agentRuns.push({ ...runtime.v3.agentRuns[0], id: "run-background", mode: "background", agent: "Alice", taskId: null, timeStart: 3500, timeEnd: null });
  runtime.v3.coordination = [
    { id: "observation-async-1", sessionId: "runtime-1", kind: "message", state: "delivered", timestamp: 4000, senderActorId: "agent-a", recipientActorId: "agent-b", runId: "run-background", eventId: null, turnId: null, correlationId: null, provenance },
    { id: "observation-async-2", sessionId: "runtime-1", kind: "message", state: "delivered", timestamp: 4001, senderActorId: "agent-a", recipientActorId: "agent-b", runId: "run-background", eventId: null, turnId: null, correlationId: null, provenance },
    { id: "observation-sync", sessionId: "runtime-1", kind: "handoff", state: "delivered", timestamp: 4002, senderActorId: "agent-b", recipientActorId: "agent-a", runId: "run-1", eventId: null, turnId: null, correlationId: null, provenance },
    { id: "observation-unplaced", sessionId: "runtime-1", kind: "wait", state: "started", timestamp: 4003, senderActorId: "agent-a", recipientActorId: null, runId: null, eventId: null, turnId: null, correlationId: null, provenance }
  ];
  runtime.projections.execution = projectExecution(runtime.v3, { maxItems: 100 });
  runtime.projections.coordination = projectCoordination(runtime.v3, { maxItems: 100 });
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  assert.match(html, /message ×2 · async by recorded run mode/);
  assert.match(html, /data-runtime-edge-async="true"/);
  assert.match(html, /handoff ×1/);
  assert.match(html, /data-runtime-edge-async="false"/);
  assert.match(html, /recorded team member/);
  assert.match(html, /1 recorded observations have no resolvable actor on both ends/);
  assert.match(html, /data-runtime-evidence-kind="coordination"/);
  assert.match(html, /"coordinations"/);
});

test("Workbench links only exact task/run/actor bindings and keeps unbound runs explicit", () => {
  const runtime = fixtureRuntime();
  runtime.v3.goals = [{
    id: "goal-exact", sessionId: "runtime-1", title: "Exact links", description: null, status: "active", taskIds: ["task-1"],
    parentGoalId: null, ownerActorId: null, timeCreated: 900, timeUpdated: 3000, timeCompleted: null, provenance
  }];
  runtime.v3.agentRuns.push({
    ...runtime.v3.agentRuns[0], id: "child-run", taskId: "task-1", childSessionId: "child-1", timeStart: null, timeEnd: null
  });
  runtime.v3.actors = [{
    id: "agent-unbound", sessionId: "runtime-1", kind: "agent", name: "Unbound", providerActorId: null, teamId: null, memberActorIds: [], runIds: [], sessionRef: null, provenance
  }];
  runtime.projections = {
    work: projectWork(runtime.v3, { maxItems: 100 }),
    execution: projectExecution(runtime.v3, { maxItems: 100 }),
    coordination: projectCoordination(runtime.v3, { maxItems: 100 }),
    context: projectContext(runtime.v3, { maxItems: 100 })
  };
  runtime.runPage = queryRunPage(runtime.v3);
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  assert.match(html, /data-runtime-edge-kind="membership"/);
  assert.match(html, /data-runtime-entity-kind="run" data-runtime-entity-id="child-run" data-runtime-task-id="task-1"/);
  assert.match(html, /runtime-child-session-link[^>]+href="\/fixture\/session\/child-1\?from=%2Ffixture%2Fsession%2Fruntime-1%3FruntimeLens%3Dexecution%26runtimeRun%3Dchild-run%26runLimit%3D50"/);
  assert.match(html, /data-runtime-run-lane-section="unassigned"/);
  assert.doesNotMatch(html, /data-runtime-run-lane-section="session"/);
  assert.match(html, /Executor not recorded/);
});

test("Work graph views bound nodes and expose incomplete projection plus narrow-screen hooks", () => {
  const runtime = fixtureRuntime();
  runtime.v3.tasks = Array.from({ length: 12 }, (_, index) => ({
    ...runtime.v3.tasks[0], id: `task-${index + 1}`, title: `Task ${index + 1}`, status: index === 11 ? "running" : "completed", timeCompleted: index === 11 ? null : 2000
  }));
  runtime.v3.goals = [{
    id: "goal-bound", sessionId: "runtime-1", title: "Bounded goal", description: null, status: "active", taskIds: runtime.v3.tasks.map((task) => task.id),
    parentGoalId: null, ownerActorId: null, timeCreated: 900, timeUpdated: 3000, timeCompleted: null, provenance
  }];
  runtime.v3.actors = Array.from({ length: 12 }, (_, index) => ({
    id: `agent-${index + 1}`, sessionId: "runtime-1", kind: "agent", name: `Agent ${index + 1}`, providerActorId: null, teamId: null, memberActorIds: [], runIds: [], sessionRef: null, provenance
  }));
  runtime.v3.coordination = [];
  runtime.projections.work = projectWork(runtime.v3, { maxItems: 100 });
  runtime.projections.execution = projectExecution(runtime.v3, { maxItems: 100 });
  runtime.projections.coordination = projectCoordination(runtime.v3, { maxItems: 100 });
  runtime.projections.work.truncated = true;
  runtime.projections.coordination.truncated = true;
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  const goalPanel = html.match(/data-runtime-graph-panel="goal"[\s\S]*?data-runtime-graph-panel="collaboration"/)?.[0] || "";
  const collaborationPanel = html.match(/data-runtime-graph-panel="collaboration"[\s\S]*?data-runtime-overview-end/)?.[0] || "";
  const goalPrimaryCanvas = goalPanel.match(/data-runtime-graph-canvas="goal"[\s\S]*?<details class="runtime-completed-work"/)?.[0] || "";
  assert.equal((goalPrimaryCanvas.match(/data-runtime-graph-node/g) || []).length, 2);
  assert.match(goalPrimaryCanvas, /Task 12/);
  assert.match(goalPanel, /Completed work \(9 of 11\)/);
  assert.match(goalPanel, /2 additional completed tasks remain/);
  assert.equal((collaborationPanel.match(/data-runtime-graph-node/g) || []).length, 9);
  assert.match(html, /more nodes omitted by the nine-node bound/);
  assert.match(html, /Projection is incomplete or truncated/);
  assert.match(html, /data-runtime-graph-evidence/);
  assert.match(html, /data-runtime-evidence-kind="goal"/);
  assert.match(html, /data-runtime-evidence-kind="actor"/);
  assert.match(html, /"goals"/);
  assert.match(html, /"actors"/);
  const style = readFileSync(path.join(process.cwd(), "src", "static", "style.css"), "utf8");
  const enhancements = readFileSync(path.join(process.cwd(), "src", "static", "app", "enhancements.js"), "utf8");
  assert.match(style, /\.runtime-graph-canvas \{ display: grid; \}/);
  assert.match(style, /\.runtime-graph-links \{ position: absolute;/);
  assert.match(style, /\.runtime-graph-node-list \{ display: grid;[\s\S]*?align-items: start;/);
  assert.match(style, /\.runtime-graph-edge-details > summary \{ cursor: pointer;/);
  assert.match(style, /\.runtime-workbench-body:has\(\[data-runtime-inspector\]:not\(\[hidden\]\)\) \{ display: grid;[\s\S]*?grid-template-columns: minmax\(0, 1fr\) minmax\(260px, 320px\)/);
  assert.match(style, /\.runtime-selection-inspector \{ position: sticky;[\s\S]*?grid-column: 2;/);
  assert.match(style, /@media \(max-width: 820px\) \{[\s\S]*?\.runtime-selection-inspector \{ position: static;[\s\S]*?grid-column: 1;[\s\S]*?grid-row: 2;/);
  assert.doesNotMatch(style, /runtime-graph-relationship-list|runtime-graph-tabs|runtime-lens-tabs/);
  assert.doesNotMatch(enhancements, /data-runtime-graph-tabs/);
  const runtimeJs = readFileSync(path.join(process.cwd(), "src", "static", "app", "runtime-workbench.js"), "utf8");
  assert.match(runtimeJs, /let inspectorTrigger = null/);
  assert.match(runtimeJs, /const closeInspector = \(\) =>/);
  assert.match(runtimeJs, /event\.key === "Escape"/);
  assert.match(runtimeJs, /inspectorTrigger\.focus\(\)/);
});

test("Work graph leads with current states and discloses bounded completed identities and edges", () => {
  const runtime = fixtureRuntime();
  const statuses = [
    ...Array.from({ length: 10 }, () => "completed"),
    "running",
    "failed",
    "cancelled",
    "unknown"
  ];
  runtime.v3.tasks = statuses.map((status, index) => ({
    ...runtime.v3.tasks[0],
    id: `task-${index + 1}`,
    title: `Task ${index + 1}`,
    status,
    timeCompleted: status === "completed" ? 2000 : null,
    dependencies: index === 10 ? ["task-1"] : []
  }));
  runtime.v3.goals = [{
    id: "goal-orientation", sessionId: "runtime-1", title: "Orientation goal", description: null, status: "active",
    taskIds: runtime.v3.tasks.map((task) => task.id), parentGoalId: null, ownerActorId: null,
    timeCreated: 900, timeUpdated: 3100, timeCompleted: null, provenance
  }];
  runtime.v3.session = { ...runtime.v3.session, state: "waiting_input", timeUpdated: 7777 };
  runtime.projections.work = projectWork(runtime.v3, { maxItems: 100 });
  const model = deriveWorkOverview({
    protocol: runtime.v3,
    work: runtime.projections.work,
    execution: runtime.projections.execution,
    coordination: runtime.projections.coordination,
    context: runtime.projections.context
  });
  assert.deepEqual(model.goalTaskGraph.nodes.map((node) => node.id), [
    "goal-orientation", "task-11", "task-12", "task-13", "task-14"
  ]);
  assert.deepEqual(model.goalTaskGraph.completedNodes.map((node) => node.id), Array.from({ length: 9 }, (_, index) => `task-${index + 1}`));
  assert.equal(model.goalTaskGraph.completedKnownTotal, 10);
  assert.equal(model.goalTaskGraph.completedOmitted, 1);
  assert.equal(model.goalTaskGraph.completedEdges.length, 10);
  assert.equal(model.goalTaskGraph.omittedEdges, 1);
  assert.equal(model.sessionState, "waiting_input");
  assert.equal(model.sessionUpdatedAt, 7777);
  assert.ok(model.goalTaskGraph.completedEdges.some((edge) => edge.from === "goal-orientation" && edge.to === "task-1" && edge.kind === "membership"));
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  const goalPrimary = html.match(/data-runtime-graph-canvas="goal"[\s\S]*?<details class="runtime-completed-work"/)?.[0] || "";
  assert.match(html, /data-runtime-completed-work/);
  assert.match(html, /data-runtime-session-state>waiting for input/);
  assert.match(html, /Completed work \(9 of 10\)/);
  assert.match(html, /1 additional completed tasks remain/);
  assert.match(html, /data-runtime-completed-graph-relationships="goal"/);
  assert.match(html, /data-runtime-edge-from="goal-orientation" data-runtime-edge-to="task-1"/);
  assert.match(goalPrimary, /Task 11/);
  assert.match(goalPrimary, /Task 12/);
  assert.match(goalPrimary, /Task 13/);
  assert.match(goalPrimary, /Task 14/);
  assert.doesNotMatch(goalPrimary, /Task 1<\/button>/);
  const structurePosition = html.indexOf('class="runtime-work-structure"');
  const runsPosition = html.indexOf('data-runtime-section="runs"');
  const scopePosition = html.indexOf('class="runtime-work-overview-grid"');
  assert.ok(structurePosition >= 0 && runsPosition > structurePosition && scopePosition > runsPosition);
});

test("Work graph SSR keeps both named regions readable and JavaScript owns tab semantics", () => {
  const runtime = fixtureRuntime();
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  const structure = html.match(/<section class="runtime-work-structure"[\s\S]*?<\/section>/)?.[0] || "";
  assert.doesNotMatch(structure, /class="runtime-graph-tabs"/);
  assert.doesNotMatch(structure, /data-runtime-graph-panel="goal"[^>]*role="tabpanel"/);
  assert.doesNotMatch(structure, /data-runtime-graph-panel="collaboration"[^>]*role="tabpanel"/);
  assert.match(structure, /role="region"[^>]*data-runtime-graph-panel="goal"/);
  assert.match(structure, /role="region"[^>]*data-runtime-graph-panel="collaboration"/);
  assert.match(structure, /aria-label="Goal to tasks"/);
  assert.match(structure, /aria-label="Agent collaboration"/);
});

test("Goal graph includes multiple recorded goals and applies membership across roots", () => {
  const runtime = fixtureRuntime();
  runtime.v3.tasks = [
    { ...runtime.v3.tasks[0], id: "task-root", title: "Root task" },
    { ...runtime.v3.tasks[0], id: "task-unlinked", title: "Unlinked task", status: "running", timeCompleted: null }
  ];
  runtime.v3.goals = [
    { id: "goal-root", sessionId: "runtime-1", title: "Root goal", description: null, status: "active", taskIds: ["task-root"], parentGoalId: null, ownerActorId: null, timeCreated: 900, timeUpdated: 3000, timeCompleted: null, provenance },
    { id: "goal-child", sessionId: "runtime-1", title: "Child goal", description: null, status: "active", taskIds: ["task-root"], parentGoalId: "goal-root", ownerActorId: null, timeCreated: 1000, timeUpdated: 3000, timeCompleted: null, provenance }
  ];
  runtime.projections.work = projectWork(runtime.v3, { maxItems: 100 });
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  const goalPanel = html.match(/data-runtime-graph-panel="goal"[\s\S]*?data-runtime-graph-panel="collaboration"/)?.[0] || "";
  assert.match(goalPanel, /Root goal/);
  assert.match(goalPanel, /Child goal/);
  assert.match(goalPanel, /3 nodes recorded; 3 shown/);
  assert.match(goalPanel, /Completed work \(1 of 1\)/);
  assert.equal((goalPanel.match(/data-runtime-graph-edge data-runtime-edge-kind="membership"/g) || []).length, 2);
  assert.match(goalPanel, /1 recorded tasks have no recorded membership/);
});

test("Narrow graph rendering retains task nodes when there are no relationships", () => {
  const runtime = fixtureRuntime();
  runtime.v3.goals = [];
  runtime.v3.actors = [];
  runtime.v3.coordination = [];
  runtime.projections.work = projectWork(runtime.v3, { maxItems: 100 });
  runtime.projections.execution = projectExecution(runtime.v3, { maxItems: 100 });
  runtime.projections.coordination = projectCoordination(runtime.v3, { maxItems: 100 });
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  const goalPanel = html.match(/data-runtime-graph-panel="goal"[\s\S]*?data-runtime-graph-panel="collaboration"/)?.[0] || "";
  assert.match(goalPanel, /data-runtime-node-kind="task"/);
  assert.match(goalPanel, /No recorded relationships connect the visible nodes/);
  assert.match(goalPanel, /data-runtime-graph-relationships="goal"/);
  assert.match(goalPanel, /data-runtime-graph-links/);
  assert.match(goalPanel, /<details class="runtime-graph-edge-details"><summary>Evidence \(0\)<\/summary>/);
  const style = readFileSync(path.join(process.cwd(), "src", "static", "style.css"), "utf8");
  assert.match(style, /@media \(max-width: 520px\) \{[\s\S]*?\.runtime-graph-node-list \{ grid-template-columns: 1fr; \}/);
  assert.doesNotMatch(style, /runtime-graph-relationship-list/);
});

test("Long recorded goal stays compact in the graph with an explicit expansion", () => {
  const runtime = fixtureRuntime();
  const longGoal = `Recorded graph goal ${"with bounded node text ".repeat(18)}`;
  runtime.v3.goals = [{
    id: "goal-long-graph", sessionId: "runtime-1", title: null, description: longGoal, status: "active", taskIds: [],
    parentGoalId: null, ownerActorId: null, timeCreated: 900, timeUpdated: 3000, timeCompleted: null, provenance
  }];
  runtime.projections.work = projectWork(runtime.v3, { maxItems: 100 });
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  const graphGoal = html.match(/class="runtime-graph-node runtime-graph-node-goal"[\s\S]*?<\/article>/)?.[0] || "";
  assert.match(graphGoal, /runtime-graph-node-details/);
  assert.match(graphGoal, /Show complete recorded goal/);
  assert.match(graphGoal, new RegExp(longGoal));
  assert.match(html, /<details class="runtime-graph-edge-details"><summary>Evidence \(/);
});
