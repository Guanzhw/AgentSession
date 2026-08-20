import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderRuntimeWorkbench } from "../dist/src/views/runtime-workbench.js";
import { renderSessionPage } from "../dist/src/views/session.js";

const provenance = { fidelity: "recorded", sourceType: "fixture.event", sourceId: "source-1" };

function fixtureRuntime() {
  return {
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
      events: [{ id: "event-1", sessionId: "runtime-1", sequence: 1, timestamp: 1, kind: "model.request", normalizedKind: "model.request", category: "model", taskId: "task-1", runId: "run-1", provenance }],
      relationships: [{ type: "spawned", fromSessionId: "runtime-1", toSessionId: "child-1", fromRef: { provider: "fixture", sessionId: "runtime-1" }, toRef: { provider: "fixture", sessionId: "child-1" }, provenance }],
      tasks: [{ id: "task-1", sessionId: "runtime-1", kind: "task", status: "completed", title: "Build <fixture>", provenance, dependencies: [] }],
      agentRuns: [{ id: "run-1", sessionId: "runtime-1", taskId: "task-1", status: "completed", mode: "foreground", agent: "worker", model: "fixture-model", childSessionId: null, provenance }],
      contextArtifacts: [{ id: "artifact-1", sessionId: "runtime-1", kind: "summary", scope: "session", origin: "provider-generated", contentAccess: "metadata-only", title: "Summary", summary: null, sourcePath: null, producerRunId: null, sourceSessionIds: [], hash: null, redacted: true, provenance }]
    }
  };
}

test("Runtime Workbench renders every lens, bounded evidence, and canonical session links", () => {
  const html = renderRuntimeWorkbench(fixtureRuntime(), "fixture", "runtime-1");
  for (const lens of ["summary", "events", "work", "sessions", "context"]) {
    assert.match(html, new RegExp(`data-runtime-lens="${lens}"`));
    assert.match(html, new RegExp(`data-runtime-panel="${lens}"`));
  }
  assert.match(html, /Build &lt;fixture&gt;/);
  assert.match(html, /\/fixture\/session\/child-1/);
  assert.match(html, /data-runtime-evidence-kind="event"/);
  assert.match(html, /data-runtime-events-task="task-1"/);
  assert.match(html, /data-runtime-events-run="run-1"/);
  assert.match(html, /Evidence and provenance/);
  assert.match(html, /metadata-only/);
  assert.match(html, /runtime-session-graph/);
  assert.match(html, /data-runtime-next-cursor="cursor-next"/);
});

test("Runtime tab is unconditional and the retired topology tab is not rendered", () => {
  const html = renderSessionPage({
    session: { id: "linear", title: "Linear", time_created: 1 },
    provider: "fixture",
    runtimeWorkbench: renderRuntimeWorkbench(fixtureRuntime(), "fixture", "linear")
  });
  assert.match(html, /id="tab-btn-runtime"/);
  assert.match(html, /id="tab-runtime"/);
  assert.doesNotMatch(html, /id="tab-btn-flow"/);
});

test("top-level session tabs do not hide nested Runtime lens panels", () => {
  const enhancements = readFileSync(path.join(process.cwd(), "src", "static", "app", "enhancements.js"), "utf8");
  assert.match(enhancements, /tabBar\.parentElement\?\.querySelectorAll\(":scope > \[role='tabpanel'\]"\)/);
  assert.doesNotMatch(enhancements, /document\.querySelectorAll\("\[role='tabpanel'\]"\)/);
});

test("Runtime work cards allow long canonical task and agent ids to wrap on narrow screens", () => {
  const style = readFileSync(path.join(process.cwd(), "src", "static", "style.css"), "utf8");
  assert.match(style, /\.runtime-card-heading > strong \{[\s\S]*?min-width: 0;[\s\S]*?overflow-wrap: anywhere;/);
  assert.match(style, /\.runtime-card-heading > \.runtime-status \{ flex: 0 0 auto; \}/);
});
