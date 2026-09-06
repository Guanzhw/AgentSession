import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderRuntimeWorkbench } from "../dist/src/views/runtime-workbench.js";
import { renderSessionPage } from "../dist/src/views/session.js";
import { finalizeSessionProtocolV3, upgradeSessionProtocolV2 } from "../dist/src/providers/shared/session-protocol-v3.js";
import { projectContext, projectCoordination, projectExecution, projectWork } from "../dist/src/protocol-runtime-v3.js";

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
    tokens: { input: 100, output: 20, total: 120 },
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

test("Work Graph renders four domains plus Evidence with Work selected", () => {
  const html = renderRuntimeWorkbench(fixtureRuntime(), "fixture", "runtime-1");
  for (const lens of ["work", "execution", "coordination", "context", "evidence"]) {
    assert.match(html, new RegExp(`data-runtime-lens="${lens}"`));
    assert.match(html, new RegExp(`data-runtime-panel="${lens}"`));
  }
  assert.match(html, /data-runtime-lens="work"[^>]*aria-selected="true"/);
  assert.doesNotMatch(html, /data-runtime-lens="summary"/);
  assert.match(html, /Build &lt;fixture&gt;/);
  assert.match(html, /\/fixture\/session\/child-1/);
  assert.match(html, /\/fixture\/session\/parent-1/);
  assert.match(html, /input · direct · 35 tokens/);
  assert.match(html, /input · inherited · 45 tokens/);
  assert.match(html, /input · shared · 20 tokens/);
  assert.match(html, /data-runtime-evidence-kind="event"/);
  assert.match(html, /Evidence and provenance/);
  assert.match(html, /metadata-only/);
  assert.match(html, /Tokens before.*Not recorded/);
  assert.match(html, /Context after compaction/);
  assert.match(html, /Retain &lt;the result&gt; and discard copied history/);
  assert.doesNotMatch(html, /Retain <the result>/);
  assert.match(html, /data-runtime-next-cursor="cursor-next"/);
});

test("Context keeps the compacted result before lifecycle evidence and scoped artifacts", () => {
  const runtime = fixtureRuntime();
  runtime.protocol.contextArtifacts.push({ id: "memory-1", sessionId: "runtime-1", kind: "memory", scope: "user", origin: "agent-generated", contentAccess: "metadata-only", title: "User memory", summary: null, sourcePath: null, producerRunId: null, sourceSessionIds: [], hash: null, redacted: false, timeCreated: 12000, metadata: {}, provenance });
  refreshProjections(runtime);
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  const resultIndex = html.indexOf("Context after compaction");
  const evidenceIndex = html.indexOf("<details>", resultIndex);
  const artifactIndex = html.indexOf("User memory");
  assert.ok(resultIndex >= 0 && evidenceIndex > resultIndex);
  assert.ok(artifactIndex > resultIndex);
  assert.match(html, /memory · user/);
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
  const coordination = html.match(/data-runtime-panel="coordination"[\s\S]*?data-runtime-panel="context"/)?.[0] || "";
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
  assert.match(html, /id="tab-btn-events"[^>]*>Events<\/button>/);
  assert.doesNotMatch(html, /id="tab-btn-flow"/);
});

test("top-level session tabs do not hide nested Runtime lens panels", () => {
  const enhancements = readFileSync(path.join(process.cwd(), "src", "static", "app", "enhancements.js"), "utf8");
  assert.match(enhancements, /tabBar\.parentElement\?\.querySelectorAll\(":scope > \[role='tabpanel'\]"\)/);
  assert.doesNotMatch(enhancements, /document\.querySelectorAll\("\[role='tabpanel'\]"\)/);
  assert.match(enhancements, /targetPanelId === "tab-work"/);
  assert.match(enhancements, /data-runtime-root.*scrollIntoView|data-runtime-root\]\?\.scrollIntoView/);
  assert.match(enhancements, /data-detail-tab/);
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
  const overview = html.match(/data-runtime-work-overview[\s\S]*?<details class="runtime-legacy-work"/)?.[0] || "";
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
  const overview = html.match(/data-runtime-work-overview[\s\S]*?<details class="runtime-legacy-work"/)?.[0] || "";
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
  const overview = html.match(/data-runtime-work-overview[\s\S]*?<details class="runtime-legacy-work"/)?.[0] || "";
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
  const overview = html.match(/data-runtime-work-overview[\s\S]*?<details class="runtime-legacy-work"/)?.[0] || "";
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
  const overview = html.match(/data-runtime-work-overview[\s\S]*?<details class="runtime-legacy-work"/)?.[0] || "";
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
