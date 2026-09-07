import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderRuntimeEvents, renderRuntimeWorkbench } from "../dist/src/views/runtime-workbench.js";
import { renderSessionPage } from "../dist/src/views/session.js";
import { finalizeSessionProtocolV3, upgradeSessionProtocolV2 } from "../dist/src/providers/shared/session-protocol-v3.js";
import { projectContext, projectCoordination, projectExecution, projectWork } from "../dist/src/protocol-runtime-v3.js";
import { summarizeEvent } from "../dist/src/event-summary.js";

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

test("Work Graph renders four domains with Work selected and keeps event evidence separate", () => {
  const html = renderRuntimeWorkbench(fixtureRuntime(), "fixture", "runtime-1");
  for (const lens of ["work", "execution", "coordination", "context"]) {
    assert.match(html, new RegExp(`data-runtime-lens="${lens}"`));
    assert.match(html, new RegExp(`data-runtime-panel="${lens}"`));
  }
  assert.doesNotMatch(html, /data-runtime-lens="evidence"/);
  assert.doesNotMatch(html, /data-runtime-events-panel/);
  assert.match(html, /data-runtime-lens="work"[^>]*aria-selected="true"/);
  assert.doesNotMatch(html, /data-runtime-lens="summary"/);
  assert.match(html, /Build &lt;fixture&gt;/);
  assert.match(html, /\/fixture\/session\/child-1/);
  assert.match(html, /\/fixture\/session\/parent-1/);
  assert.match(html, /input · direct · 35 tokens/);
  assert.match(html, /input · inherited · 45 tokens/);
  assert.match(html, /input · shared · 20 tokens/);
  assert.doesNotMatch(html, /data-runtime-evidence-kind="event"/);
  assert.match(html, /data-runtime-evidence-kind="task"/);
  assert.match(html, /Evidence and provenance/);
  assert.match(html, /metadata-only/);
  assert.match(html, /Tokens before.*Not recorded/);
  assert.match(html, /Context after compaction/);
  assert.match(html, /Retain &lt;the result&gt; and discard copied history/);
  assert.doesNotMatch(html, /Retain <the result>/);
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
  assert.match(html, /data-runtime-graph-tabs/);
  assert.match(html, /data-runtime-graph-tab="goal"/);
  assert.match(html, /data-runtime-graph-tab="collaboration"/);
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
  assert.equal((goalPanel.match(/data-runtime-graph-node/g) || []).length, 9);
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
  assert.match(style, /\.runtime-graph-edge-list \{ display: none; \}/);
  assert.match(style, /\.runtime-graph-relationship-list \{ display: grid; margin-top: 12px; \}/);
  assert.match(enhancements, /data-runtime-graph-tabs/);
  assert.match(enhancements, /setAttribute\("role", "tablist"\)/);
  assert.match(enhancements, /setAttribute\("role", "tabpanel"\)/);
  assert.match(enhancements, /ArrowDown|ArrowRight/);
});

test("Work graph SSR keeps both named regions readable and JavaScript owns tab semantics", () => {
  const runtime = fixtureRuntime();
  const html = renderRuntimeWorkbench(runtime, "fixture", "runtime-1");
  const structure = html.match(/<section class="runtime-work-structure"[\s\S]*?<\/section>/)?.[0] || "";
  assert.match(structure, /class="runtime-graph-tabs" hidden/);
  assert.doesNotMatch(structure, /class="runtime-graph-tabs"[^>]*role="tablist"/);
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
  assert.match(goalPanel, /4 nodes recorded; 4 shown/);
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
  const style = readFileSync(path.join(process.cwd(), "src", "static", "style.css"), "utf8");
  assert.match(style, /@media \(max-width: 820px\) \{[\s\S]*?\.runtime-graph-canvas \{ display: grid; \}[\s\S]*?\.runtime-graph-edge-list \{ display: none; \}/);
});
