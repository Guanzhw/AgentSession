import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const { buildOwnedReaderChildLinks } = await import("../dist/src/providers/shared/linked-message-session.js");
const { renderSessionReaderPane } = await import("../dist/src/views/session.js");
const { registerSessionDetail } = await import("../dist/src/routes/session-detail.js");
const { registerReaderCoordinationRoutes } = await import("../dist/src/routes/reader-coordination.js");
const { buildMessageSessionTree, buildMessageSessionViews } = await import("../dist/src/providers/shared/message-session.js");

const metricFixtureRoot = path.resolve("tmp", "history-stage-test", `owned-metrics-${process.pid}`);

function metricRecord(timestamp, type, payload) {
  return { type, timestamp: `2026-09-16T00:00:${String(timestamp).padStart(2, "0")}.000Z`, payload };
}

function metricRollout(id, parentId, offset, usage, toolName = null) {
  const records = [
    metricRecord(offset, "session_meta", { id, parent_thread_id: parentId }),
    metricRecord(offset + 1, "event_msg", { type: "user_message", message: `${id} request` }),
    metricRecord(offset + 2, "event_msg", { type: "agent_message", message: `${id} answer` }),
    metricRecord(offset + 3, "event_msg", { type: "token_count", info: { last_token_usage: usage } })
  ];
  if (toolName) {
    records.splice(2, 0,
      metricRecord(offset + 2, "response_item", { type: "function_call", call_id: `${id}-call`, name: toolName, arguments: "{}" }),
      metricRecord(offset + 2, "response_item", { type: "function_call_output", call_id: `${id}-call`, output: "ok" })
    );
  }
  return records;
}

function rootTree() {
  return {
    session: { id: "root", provider: "codex", title: "Root" },
    messages: [{
      id: "root-message", sessionId: "root", role: "assistant", data: {}, timeCreated: 100,
      parts: [{
        id: "spawn-part", messageId: "root-message", sessionId: "root", type: "tool", tool: "mystery-tool",
        data: { type: "tool", tool: "mystery-tool", state: { input: {}, output: "", status: "completed" } },
        timeStart: 100, timeEnd: 110, childSessions: []
      }]
    }],
    detachedChildren: [],
    metrics: {
      messageCount: 1, partCount: 1, toolCallCount: 1, directChildCount: 0, descendantCount: 0,
      totalMessages: 1, totalToolCalls: 1, directInputTokens: 0, directOutputTokens: 0,
      directReasoningTokens: 0, directCacheReadTokens: 0, directCacheWriteTokens: 0, directCost: 0,
      inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      cost: 0, timeStart: 100, timeEnd: 110, runtimeMs: 10
    }
  };
}

test("owned reader child links preserve evidence, inferred, and detached semantics", () => {
  const tree = rootTree();
  const children = [
    { session: { id: "explicit-child", title: "Explicit", parentId: "root", timeCreated: 120 } },
    { session: { id: "inferred-child", title: "Inferred", parentId: "root", timeCreated: 130 } },
    { session: { id: "detached-child", title: "Detached", parentId: "root", timeCreated: 140 } }
  ];
  const links = buildOwnedReaderChildLinks("root", tree, children, {
    agentRuns: [{ id: "run-1", childSessionId: "explicit-child", taskId: "task-1", provenance: {} }],
    tasks: [{ id: "task-1", toolCallId: "spawn-part", provenance: {} }],
    relationships: []
  });
  assert.deepEqual(links.map((link) => ({ id: link.session.id, part: link.parentPartId, link: link.link, detached: link.detached })), [
    { id: "explicit-child", part: "spawn-part", link: "explicit", detached: false },
    { id: "inferred-child", part: "spawn-part", link: "inferred", detached: false },
    { id: "detached-child", part: null, link: "inferred", detached: true }
  ]);
  assert.equal(tree.messages[0].parts[0].data.state.metadata.subagent, true);
});

test("owned reader renders descriptor targets without fake child trees", () => {
  const tree = rootTree();
  const child = {
    provider: "codex", sessionId: "child", title: "Child", available: true,
    link: "explicit", parentPartId: "spawn-part", detached: false
  };
  const html = renderSessionReaderPane({ session: tree.session, ownedReader: { rootTree: tree, children: [child] }, provider: "codex" });
  assert.match(html, /data-reader-child-disclosure/);
  assert.match(html, /data-reader-child-session="child"/);
  assert.match(html, /data-reader-child-preview-state/);
  assert.match(html, /data-reader-open[^>]+data-reader-session="child"/);
  assert.equal(tree.messages[0].parts[0].childSessions.length, 0);
  assert.doesNotMatch(html, /data-reader-child-session="child"[\s\S]*?message-turn/);
});

test("optimized HTML and reader routes do not call legacy family tree or metrics", async () => {
  let treeCalls = 0;
  let metricsCalls = 0;
  const tree = buildMessageSessionTree({ id: "root", provider: "codex", title: "Root" }, [
    { id: "root-message", sessionId: "root", role: "assistant", content: "Root", timestamp: 1 }
  ]);
  const provider = {
    id: "codex", name: "Codex", icon: "", capabilities: {},
    getSession(id) { return id === "root" ? { id, provider: "codex", parentId: null, title: "Root", directory: null, timeCreated: 1, timeUpdated: 2 } : null; },
    getMessages() { return [{ id: "root-message", sessionId: "root", role: "assistant", content: "Root", timestamp: 1 }]; },
    getSessionProtocol() { return null; },
    getOwnedReaderProjection() { return { rootTree: tree, children: [] }; },
    getSessionTree() { treeCalls += 1; throw new Error("legacy tree must not load"); },
    getSessionMetrics() { metricsCalls += 1; throw new Error("legacy metrics must not load"); },
    searchMessages() { return []; }
  };
  const routes = [];
  registerSessionDetail({ get(pattern, handler) { routes.push({ pattern, handler }); } }, {
    appConfig: { port: 0, metaDir: ".", projectPaths: {}, resumeCommands: {}, allowTerminalLaunch: false },
    providerMap: new Map([["codex", provider]]), providerInfo: []
  });
  const htmlRoute = routes.find((route) => route.pattern === "/:provider/session/:id");
  const readerRoute = routes.find((route) => route.pattern instanceof RegExp && route.pattern.test("/api/codex/session/root/reader"));
  assert.ok(htmlRoute);
  assert.ok(readerRoute);
  const html = await htmlRoute.handler({ url: "/codex/session/root" }, null, { provider: "codex", id: "root" });
  assert.equal(html.status, 200);
  const response = { statusCode: 0, headers: {}, body: "", writeHead(status, headers) { this.statusCode = status; this.headers = headers; }, end(body = "") { this.body += String(body); } };
  await readerRoute.handler({ url: "/api/codex/session/root/reader" }, response, ["", "codex", "root"]);
  assert.equal(response.statusCode, 200);
  assert.equal(treeCalls, 0);
  assert.equal(metricsCalls, 0);
});

test("Codex owned metrics preserve inclusive family parity and root direct totals", async (t) => {
  rmSync(metricFixtureRoot, { recursive: true, force: true });
  t.after(() => rmSync(metricFixtureRoot, { recursive: true, force: true }));
  const sessionsDir = path.join(metricFixtureRoot, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const rollouts = [
    ["root", null, 1, { input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 1, output_tokens: 5, reasoning_output_tokens: 1, total_tokens: 99 }, "exec"],
    ["child", "root", 10, { input_tokens: 20, cached_input_tokens: 3, output_tokens: 4, total_tokens: 27 }, "read"],
    ["grandchild", "child", 20, { input_tokens: 30, output_tokens: 6, total_tokens: 36 }, null],
    ["detached", "root", 30, { input_tokens: 40, output_tokens: 8, total_tokens: 48 }, "write"]
  ];
  for (const [id, parentId, offset, usage, tool] of rollouts) {
    writeFileSync(path.join(sessionsDir, `${id}.jsonl`), metricRollout(id, parentId, offset, usage, tool).map(JSON.stringify).join("\n") + "\n");
  }

  const { initConfig } = await import("../dist/src/config.js");
  initConfig(["--codex-dir", metricFixtureRoot]);
  const { default: codex } = await import(`../dist/src/providers/codex/adapter.js?owned-metrics-${process.pid}`);
  const ids = rollouts.map(([id]) => id);
  const directViews = ids.map((id) => buildMessageSessionViews(codex.getSession(id), codex.getMessages(id)));
  const rootView = directViews[0];
  const totals = {
    messages: directViews.reduce((sum, view) => sum + view.metrics.totals.messages, 0),
    toolCalls: directViews.reduce((sum, view) => sum + view.metrics.totals.toolCalls, 0),
    branches: ids.length - 1,
    steps: rootView.metrics.totals.steps,
    inputTokens: directViews.reduce((sum, view) => sum + view.metrics.totals.directInputTokens, 0),
    outputTokens: directViews.reduce((sum, view) => sum + view.metrics.totals.directOutputTokens, 0),
    reasoningTokens: directViews.reduce((sum, view) => sum + view.metrics.totals.directReasoningTokens, 0),
    cacheReadTokens: directViews.reduce((sum, view) => sum + view.metrics.totals.directCacheReadTokens, 0),
    cacheWriteTokens: directViews.reduce((sum, view) => sum + view.metrics.totals.directCacheWriteTokens, 0),
    totalTokens: directViews.reduce((sum, view) => sum + view.metrics.totals.directTotalTokens, 0),
    directInputTokens: rootView.metrics.totals.directInputTokens,
    directOutputTokens: rootView.metrics.totals.directOutputTokens,
    directReasoningTokens: rootView.metrics.totals.directReasoningTokens,
    directCacheReadTokens: rootView.metrics.totals.directCacheReadTokens,
    directCacheWriteTokens: rootView.metrics.totals.directCacheWriteTokens,
    directTotalTokens: rootView.metrics.totals.directTotalTokens,
    cost: 0,
    runtimeMs: Math.max(...directViews.map((view) => view.tree.metrics.timeEnd || 0)) - Math.min(...directViews.map((view) => view.tree.metrics.timeStart || 0).filter(Boolean))
  };
  const expectedTools = new Map();
  for (const view of directViews) for (const tool of view.metrics.tools) expectedTools.set(tool.name, (expectedTools.get(tool.name) || 0) + tool.count);
  const actual = codex.getSessionMetrics("root");
  assert.deepEqual(actual.totals, totals);
  assert.deepEqual(actual.tools, [...expectedTools.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count })));
  assert.deepEqual(actual.steps, rootView.metrics.steps);
});

test("reader event source guard uses the owned root boundary", async () => {
  let treeCalls = 0;
  let ownedCalls = 0;
  const message = { id: "m", sessionId: "root", role: "assistant", content: "Answer", timestamp: 1 };
  const tree = buildMessageSessionTree({ id: "root", provider: "codex", title: "Root" }, [message]);
  const protocol = {
    version: 3,
    sessionId: "root",
    session: { ref: { provider: "codex", sessionId: "root" } },
    events: [{
      id: "event:answer", sessionId: "root", sequence: 1, timestamp: 1,
      kind: "message.assistant", normalizedKind: "message.assistant", category: "conversation", phase: "completed",
      messageId: "m", partId: "m:text", toolCallId: null,
      provenance: { fidelity: "recorded", sourceType: "fixture", sourceId: "m" }
    }],
    tasks: [], agentRuns: [], relationships: [], contextArtifacts: [], branches: [], revision: null,
    goals: [], actors: [], coordination: [], contextVersions: [], contextTransformations: [], usageRecords: [],
    coverage: { work: { state: "unknown" }, execution: { state: "unknown" }, coordination: { state: "unknown" }, context: { state: "unknown" }, usage: { state: "unknown" } }
  };
  const provider = {
    id: "codex", name: "Codex", icon: "", capabilities: {},
    getSession(id) { return id === "root" ? { ...tree.session, parentId: null } : null; },
    getMessages() { return [message]; },
    getSessionProtocolV3() { return protocol; },
    getOwnedReaderProjection() { ownedCalls += 1; return { rootTree: tree, children: [] }; },
    getSessionTree() { treeCalls += 1; throw new Error("legacy tree must not load"); }
  };
  const routes = [];
  registerReaderCoordinationRoutes({ get(pattern, handler) { routes.push({ pattern, handler }); } }, { providerMap: new Map([["codex", provider]]) });
  const route = routes.find((item) => item.pattern instanceof RegExp && item.pattern.test("/api/codex/session/root/reader/event/event%3Aanswer"));
  assert.ok(route);
  const response = { statusCode: 0, headers: {}, body: "", writeHead(status, headers) { this.statusCode = status; this.headers = headers; }, end(body = "") { this.body += String(body); } };
  await route.handler({ url: "/api/codex/session/root/reader/event/event%3Aanswer" }, response, ["", "codex", "root", "event%3Aanswer"]);
  assert.equal(response.statusCode, 200);
  assert.equal(ownedCalls, 1);
  assert.equal(treeCalls, 0);
  assert.match(response.body, /"partId":"m:text"/);
});
