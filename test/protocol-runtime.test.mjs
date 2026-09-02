import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRuntimeGraph,
  clearProtocolRuntimeCache,
  getRuntimeProtocol,
  getRuntimeProtocolV3,
  ProtocolRuntimeError,
  queryRuntimeEvents,
  summarizeRuntimeProtocol
} from "../dist/src/protocol-runtime.js";
import { capabilityDescriptor } from "../dist/src/providers/shared/session-protocol.js";
import { finalizeSessionProtocolV3, upgradeSessionProtocolV2 } from "../dist/src/providers/shared/session-protocol-v3.js";

const provenance = { fidelity: "recorded", sourceType: "fixture" };

function adapterFixture() {
  let builds = 0;
  const sessions = new Map([
    ["root", { id: "root", provider: "fixture", parentId: null, title: "Root", directory: "/repo", timeCreated: 1, timeUpdated: 2, messageCount: 2, tokenCount: 3 }],
    ["child", { id: "child", provider: "fixture", parentId: "root", title: "Child", directory: "/repo", timeCreated: 2, timeUpdated: 3, messageCount: 1, tokenCount: 1 }]
  ]);
  const protocol = (id) => ({
    sessionId: id,
    events: id === "root" ? [
      { id: "e1", sessionId: id, sequence: 1, timestamp: 1, kind: "message.user", provenance },
      { id: "e2", sessionId: id, sequence: 2, timestamp: 2, kind: "tool.call", phase: "started", correlationId: "call-1", provenance },
      { id: "e3", sessionId: id, sequence: 3, timestamp: 3, kind: "context.compaction", provenance }
    ] : [],
    relationships: id === "root" ? [{ type: "spawned", fromSessionId: "root", toSessionId: "child", provenance }] : [],
    tasks: id === "root" ? [{ id: "task-1", sessionId: id, kind: "task", status: "completed", title: "Inspect", dependencies: [], triggerEventId: "e2", timeCreated: 1, timeUpdated: 2, timeCompleted: 2, provenance }] : [],
    agentRuns: id === "root" ? [{ id: "run-1", sessionId: id, taskId: "task-1", status: "completed", mode: "subagent", agent: "worker", model: null, childSessionId: "child", triggerEventId: "e2", timeStart: 1, timeEnd: 2, provenance }] : [],
    contextArtifacts: id === "root" ? [{ id: "artifact-1", sessionId: id, kind: "summary", scope: "session", origin: "provider-generated", contentAccess: "metadata-only", title: "Summary", summary: null, sourcePath: null, producerRunId: "run-1", sourceSessionIds: [id], hash: null, redacted: false, timeCreated: 3, provenance }] : []
  });
  const adapter = {
    id: "fixture",
    name: "Fixture",
    icon: "",
    protocolCapabilities: {
      sessionEvents: capabilityDescriptor("full", "recorded"),
      sessionRelationships: capabilityDescriptor("full", "recorded"),
      tasks: capabilityDescriptor("full", "recorded"),
      agentRuns: capabilityDescriptor("full", "recorded"),
      contextArtifacts: capabilityDescriptor("full", "recorded")
    },
    detect: () => true,
    getDataPath: () => null,
    scan: async function* () { yield* sessions.values(); },
    getSession: (id) => sessions.get(id) || null,
    getMessages: () => [],
    getTokenStats: () => [],
    searchMessages: () => [],
    getStatsRevision: () => "revision-1",
    getSessionProtocol(id) { builds += 1; return sessions.has(id) ? protocol(id) : null; }
  };
  return { adapter, getBuilds: () => builds };
}

test("runtime protocol finalizes and caches provider snapshots by revision", () => {
  clearProtocolRuntimeCache();
  const { adapter, getBuilds } = adapterFixture();
  const first = getRuntimeProtocol(adapter, "root");
  const second = getRuntimeProtocol(adapter, "root");
  assert.equal(first, second);
  assert.equal(getBuilds(), 1);
  assert.equal(first.version, 2);
  assert.equal(first.session.ref.provider, "fixture");
  assert.equal(first.validation.ok, true);
  assert.throws(() => getRuntimeProtocol(adapter, "missing"), (error) => error instanceof ProtocolRuntimeError && error.code === "session_not_found");
});

test("runtime protocol reuses immutable finalized provider snapshots and finalizes mutable v2 sources", () => {
  clearProtocolRuntimeCache();
  const { adapter } = adapterFixture();
  const finalized = getRuntimeProtocol(adapter, "root");

  clearProtocolRuntimeCache();
  adapter.getSessionProtocol = () => finalized;
  assert.equal(getRuntimeProtocol(adapter, "root"), finalized, "already-finalized snapshots retain source identity");

  clearProtocolRuntimeCache();
  const mutableV2 = { ...finalized };
  adapter.getSessionProtocol = () => mutableV2;
  const fallback = getRuntimeProtocol(adapter, "root");
  assert.notEqual(fallback, mutableV2, "mutable v2 sources still use the finalizer");
  assert.equal(fallback.validation.ok, true);
  assert.equal(Object.isFrozen(fallback), true);
});

test("runtime v3 projections reuse one explicit upgrade of the cached v2 snapshot", () => {
  clearProtocolRuntimeCache();
  const { adapter, getBuilds } = adapterFixture();
  const first = getRuntimeProtocolV3(adapter, "root");
  const second = getRuntimeProtocolV3(adapter, "root");
  assert.equal(first, second);
  assert.equal(first.version, 3);
  assert.equal(first.coverage.work.state, "unknown");
  assert.equal(getBuilds(), 1);

  clearProtocolRuntimeCache();
  assert.notEqual(getRuntimeProtocolV3(adapter, "root"), first);
  assert.equal(getBuilds(), 2);
});

test("native v3 cache falls back to the canonical session revision when getStatsRevision is absent", () => {
  clearProtocolRuntimeCache();
  const { adapter: v2Adapter } = adapterFixture();
  const native = finalizeSessionProtocolV3(upgradeSessionProtocolV2(getRuntimeProtocol(v2Adapter, "root")));
  assert.equal(native.sessionId, "root");
  let session = { id: "root", timeUpdated: 2, messageCount: 2, tokenCount: 3 };
  let builds = 0;
  const adapter = {
    id: "fixture",
    getSessionProtocolV3: (id) => { builds += 1; return id === "root" ? native : null; },
    getSessionProtocol: () => null,
    getSession: (id) => (id === "root" ? session : null)
  };
  assert.equal(getRuntimeProtocolV3(adapter, "root"), native);
  assert.equal(builds, 1);
  getRuntimeProtocolV3(adapter, "root");
  assert.equal(builds, 1, "an unchanged session revision must keep serving the cached snapshot");
  session = { ...session, timeUpdated: 3 };
  getRuntimeProtocolV3(adapter, "root");
  assert.equal(builds, 2, "a changed timeUpdated must rebuild the snapshot");
  session = { ...session, messageCount: 3 };
  getRuntimeProtocolV3(adapter, "root");
  assert.equal(builds, 3, "a changed messageCount must rebuild the snapshot");
  session = { ...session, tokenCount: 4 };
  getRuntimeProtocolV3(adapter, "root");
  assert.equal(builds, 4, "a changed tokenCount must rebuild the snapshot");
  clearProtocolRuntimeCache();
});

test("native v3 snapshot with a mismatched sessionId is rejected and never cached", () => {
  clearProtocolRuntimeCache();
  const { adapter: v2Adapter } = adapterFixture();
  const native = finalizeSessionProtocolV3(upgradeSessionProtocolV2(getRuntimeProtocol(v2Adapter, "root")));
  assert.equal(native.sessionId, "root");
  let calls = 0;
  const adapter = {
    id: "fixture",
    getStatsRevision: () => "stats-1",
    getSessionProtocolV3: () => { calls += 1; return native; },
    getSessionProtocol: () => null,
    getSession: () => ({ id: "root" })
  };
  for (let i = 0; i < 2; i += 1) {
    assert.throws(() => getRuntimeProtocolV3(adapter, "other"), (error) => (
      error instanceof ProtocolRuntimeError && error.code === "protocol_invalid"
    ));
    assert.equal(calls, i + 1, "a rejected snapshot must not enter the cache");
  }
  // The correct id still resolves and is cached independently.
  assert.equal(getRuntimeProtocolV3(adapter, "root"), native);
  assert.equal(calls, 3);
  getRuntimeProtocolV3(adapter, "root");
  assert.equal(calls, 3, "the accepted snapshot is served from the cache");
  clearProtocolRuntimeCache();
});

test("runtime event queries are bounded, filterable, cursor-bound, and omit provider data", () => {
  clearProtocolRuntimeCache();
  const { adapter } = adapterFixture();
  const protocol = structuredClone(getRuntimeProtocol(adapter, "root"));
  const first = queryRuntimeEvents(protocol, { limit: 1, categories: ["message", "tool"] });
  assert.equal(first.events.length, 1);
  assert.equal(first.truncated, true);
  assert.equal("providerData" in first.events[0], false);
  const second = queryRuntimeEvents(protocol, { limit: 1, categories: ["message", "tool"], cursor: first.nextCursor });
  assert.equal(second.events[0].category, "tool");
  assert.equal(queryRuntimeEvents(protocol, { taskId: "task-1" }).events[0].id, "e2");
  assert.equal(queryRuntimeEvents(protocol, { runId: "run-1" }).events[0].id, "e2");
  assert.throws(() => queryRuntimeEvents(protocol, { limit: 1, categories: ["context"], cursor: first.nextCursor }), /cursor/);
  assert.throws(() => queryRuntimeEvents(protocol, { taskId: "task-1", cursor: first.nextCursor }), /cursor/);
});

test("runtime summary and graph expose protocol facts without inventing missing sessions", () => {
  clearProtocolRuntimeCache();
  const { adapter } = adapterFixture();
  const protocol = getRuntimeProtocol(adapter, "root");
  const summary = summarizeRuntimeProtocol(protocol, adapter.protocolCapabilities);
  assert.deepEqual(summary.counts, {
    events: 3, relationships: 1, tasks: 1, agentRuns: 1,
    contextArtifacts: 1, branches: 0, compactions: 1, activeTasks: 0, activeRuns: 0
  });
  const graph = buildRuntimeGraph(adapter, protocol, { depth: 1, maxNodes: 20 });
  assert.ok(graph.nodes.some((node) => node.kind === "session" && node.session?.sessionId === "child" && node.resolution === "resolved"));
  assert.ok(graph.nodes.some((node) => node.kind === "task" && node.id.endsWith(":task-1")));
  assert.ok(graph.edges.some((edge) => edge.type === "spawned"));
  assert.ok(graph.edges.some((edge) => edge.type === "child-session"));
  assert.equal(graph.truncated, false);
});

test("runtime graph stops entity projection at maxNodes", () => {
  clearProtocolRuntimeCache();
  const { adapter } = adapterFixture();
  const protocol = structuredClone(getRuntimeProtocol(adapter, "root"));
  protocol.tasks = Array.from({ length: 1000 }, (_, index) => ({
    id: `task-${index}`,
    sessionId: "root",
    kind: "task",
    status: "completed",
    title: `Task ${index}`,
    dependencies: index ? [`task-${index - 1}`] : [],
    timeCreated: 1,
    timeUpdated: 2,
    timeCompleted: 2,
    provenance
  }));
  const graph = buildRuntimeGraph(adapter, protocol, { depth: 0, maxNodes: 10 });
  assert.equal(graph.nodes.length, 10);
  assert.equal(graph.truncated, true);
});
