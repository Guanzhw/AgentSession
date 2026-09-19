import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveConversationTaskGroupPage,
  deriveConversationTaskDirectoryPage,
  deriveConversationView
} from "../dist/src/conversation-view-model.js";
import { renderReaderTaskDetail, renderReaderTaskRuns } from "../dist/src/views/session.js";
import { registerReaderCoordinationRoutes } from "../dist/src/routes/reader-coordination.js";

const provenance = { fidelity: "recorded", sourceType: "fixture" };

function fixture(count = 120) {
  const tasks = Array.from({ length: count }, (_, index) => ({
    id: `task-${index}`, sessionId: "root", kind: "subagent-task", status: "completed",
    title: `Recorded task ${index}`, assignee: `worker-${index}`, agentPath: `/root/worker-${index}`,
    toolCallId: `call-${index}`, dependencies: [], runIds: [`run-${index}`],
    timeCreated: index, timeUpdated: index + 1, timeCompleted: index + 1, provenance
  }));
  const agentRuns = tasks.map((task, index) => ({
    id: `run-${index}`, sessionId: "root", taskId: task.id, status: "completed", mode: "subagent",
    agent: `worker-${index}`, model: null, childSessionId: `child-${index}`,
    childSessionAvailable: true, timeStart: index, timeEnd: index + 1, provenance
  }));
  const actors = agentRuns.map((run, index) => ({
    id: `actor-${index}`, kind: "agent", name: `Worker ${index}`, runIds: [run.id], provenance
  }));
  const coordination = agentRuns.flatMap((run, index) => ([
    { id: `spawn-${index}`, sessionId: "root", kind: "spawn", state: "started", timestamp: index * 2, taskId: run.taskId, runId: run.id, recipientActorId: `actor-${index}`, provenance },
    { id: `result-${index}`, sessionId: "root", kind: "result-delivery", state: "delivered", timestamp: index * 2 + 1, taskId: run.taskId, runId: run.id, senderActorId: `actor-${index}`, provenance }
  ]));
  return {
    version: 3, sessionId: "root", session: { ref: { provider: "fixture", sessionId: "root" } },
    events: [], relationships: [], tasks, agentRuns, contextArtifacts: [], branches: [], revision: null,
    goals: [], actors, coordination, contextVersions: [], contextTransformations: [], usageRecords: [],
    coverage: { work: { state: "observed" }, execution: { state: "observed" }, coordination: { state: "observed" }, context: { state: "unknown" }, usage: { state: "unknown" } }
  };
}

function request(protocol, overrides = {}) {
  return deriveConversationTaskDirectoryPage(protocol, {
    provider: "fixture", sessionId: "root", size: 50, ...overrides
  });
}

test("complete task directory pages 120 canonical tasks while the initial reader stays at 50", () => {
  const protocol = fixture();
  const first = request(protocol);
  assert.equal(first.ok, true);
  assert.equal(first.total, 120);
  assert.equal(first.items.length, 50);
  const second = request(protocol, { cursor: first.nextCursor });
  assert.equal(second.ok, true);
  assert.equal(second.items.length, 50);
  const third = request(protocol, { cursor: second.nextCursor });
  assert.equal(third.ok, true);
  assert.equal(third.items.length, 20);
  assert.equal(third.items[0].key, "run:run-100");
  assert.equal(third.nextCursor, null);

  const view = deriveConversationView({
    protocol,
    work: { tasks: [], truncated: true },
    execution: { focus: protocol.session.ref, actors: [], runs: [], actorRuns: [], usage: null, truncated: true },
    coordination: { focus: protocol.session.ref, observations: [], lineage: [], truncated: true },
    context: { artifacts: [], artifactSessions: [], artifactRuns: [], lineage: [], truncated: false }
  });
  assert.equal(view.taskCount, 120);
  assert.equal(view.taskDirectory.items.length, 50);
  assert.equal(view.cards.length, 50);
  assert.equal(view.cards[49].responsibility, "Recorded task 49");
});

test("task directory search reaches late canonical tasks and materializes their recorded actors and channels", () => {
  const protocol = fixture();
  const page = request(protocol, { query: "Recorded task 119" });
  assert.equal(page.ok, true);
  assert.equal(page.total, 1);
  const group = page.items[0];
  assert.equal(group.key, "run:run-119");
  assert.equal(group.cards[0].name, "Worker 119");
  assert.deepEqual(group.cards[0].channel.map((item) => item.kind), ["spawn", "result-delivery"]);
  assert.equal(deriveConversationTaskGroupPage(protocol, { provider: "fixture", sessionId: "root", key: group.key }).group.key, group.key);
  assert.equal(deriveConversationTaskGroupPage(protocol, { provider: "fixture", sessionId: "root", key: "run:missing" }), null);
});

test("task directory cursor rejects changed prefixes and accepts suffix appends", () => {
  const base = fixture(51);
  const first = request(base);
  assert.equal(first.ok, true);

  const prefixed = fixture(51);
  prefixed.tasks.unshift({ ...prefixed.tasks[0], id: "task-before", title: "Before", runIds: ["run-before"] });
  prefixed.agentRuns.unshift({ ...prefixed.agentRuns[0], id: "run-before", taskId: "task-before", childSessionId: "child-before" });
  const stale = request(prefixed, { cursor: first.nextCursor });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "stale_cursor");

  const appended = fixture(52);
  const continued = request(appended, { cursor: first.nextCursor });
  assert.equal(continued.ok, true);
  assert.deepEqual(continued.items.map((item) => item.key), ["run:run-50", "run:run-51"]);
});

test("repeated runs sharing one child produce one task group while retaining raw run ids", () => {
  const protocol = fixture(2);
  protocol.agentRuns[1] = { ...protocol.agentRuns[1], childSessionId: "child-0" };
  const page = request(protocol);
  assert.equal(page.total, 1);
  assert.equal(page.items[0].runCount, 2);
  assert.equal(page.items[0].cards.length, 1);
  const html = renderReaderTaskDetail(page.items[0], "fixture", "root");
  assert.match(html, /data-reader-branch-key="run:run-0"/);
  assert.match(html, /data-reader-branch-run="run-0"/);
  assert.doesNotMatch(html, /data-reader-branch-run="run-1"/);
  assert.match(html, /data-reader-task-runs-more/);
  assert.equal((html.match(/reader-child-history-link/g) || []).length, 1);

  const first = deriveConversationTaskGroupPage(protocol, {
    provider: "fixture", sessionId: "root", key: page.items[0].key, size: 1
  });
  const second = deriveConversationTaskGroupPage(protocol, {
    provider: "fixture", sessionId: "root", key: page.items[0].key, size: 1, cursor: first.nextCursor
  });
  assert.equal(first.group.cards[0].bindings.runId, "run-0");
  assert.equal(second.group.cards[0].bindings.runId, "run-1");
  assert.match(renderReaderTaskRuns(second.group, "fixture", "root"), /data-reader-branch-run="run-1"/);
  assert.equal(second.nextCursor, null);
});

test("one child with 120 runs stays bounded and pages every raw run with prefix validation", () => {
  const shared = (count) => {
    const protocol = fixture(count);
    protocol.agentRuns = protocol.agentRuns.map((run) => ({ ...run, childSessionId: "child-shared" }));
    return protocol;
  };
  const protocol = shared(120);
  const directory = request(protocol);
  assert.equal(directory.total, 1);
  assert.equal(directory.items[0].cards.length, 1);
  assert.equal(directory.items[0].runCount, 120);
  const key = directory.items[0].key;
  const first = deriveConversationTaskGroupPage(protocol, { provider: "fixture", sessionId: "root", key });
  const second = deriveConversationTaskGroupPage(protocol, { provider: "fixture", sessionId: "root", key, cursor: first.nextCursor });
  const third = deriveConversationTaskGroupPage(protocol, { provider: "fixture", sessionId: "root", key, cursor: second.nextCursor });
  assert.deepEqual([first.group.cards.length, second.group.cards.length, third.group.cards.length], [50, 50, 20]);
  assert.equal(first.group.cards[0].bindings.runId, "run-0");
  assert.equal(third.group.cards.at(-1).bindings.runId, "run-119");
  assert.equal(third.nextCursor, null);

  const changed = shared(120);
  changed.agentRuns[1] = { ...changed.agentRuns[1], id: "run-changed" };
  const stale = deriveConversationTaskGroupPage(changed, {
    provider: "fixture", sessionId: "root", key, cursor: first.nextCursor
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "stale_cursor");

  const appended = shared(121);
  const continued = deriveConversationTaskGroupPage(appended, {
    provider: "fixture", sessionId: "root", key, cursor: second.nextCursor
  });
  assert.equal(continued.ok, true);
  assert.equal(continued.total, 121);
  assert.equal(continued.group.cards.at(-1).bindings.runId, "run-120");
});

test("a continuation reports stale when a prefix insert changes the canonical group key", () => {
  const protocol = fixture(3);
  protocol.agentRuns = protocol.agentRuns.map((run) => ({ ...run, childSessionId: "child-shared" }));
  const key = request(protocol).items[0].key;
  const first = deriveConversationTaskGroupPage(protocol, {
    provider: "fixture", sessionId: "root", key, size: 1
  });

  const changed = structuredClone(protocol);
  changed.tasks.unshift({
    ...changed.tasks[0], id: "task-before", title: "Before", runIds: ["run-before"]
  });
  changed.agentRuns.unshift({
    ...changed.agentRuns[0], id: "run-before", taskId: "task-before", childSessionId: "child-shared"
  });
  const stale = deriveConversationTaskGroupPage(changed, {
    provider: "fixture", sessionId: "root", key, size: 1, cursor: first.nextCursor
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "stale_cursor");
  assert.equal(deriveConversationTaskGroupPage(changed, {
    provider: "fixture", sessionId: "root", key, size: 1
  }), null);
});

test("relationship summaries include later runs while their channels remain unloaded", () => {
  const protocol = fixture(3);
  protocol.agentRuns.forEach(run => { run.childSessionId = "shared"; });
  for (let index = 0; index < 3; index++) {
    protocol.actors.push({ id: `coordinator-${index}`, kind: "agent", name: "Coordinator", runIds: [], provenance });
    protocol.coordination[index * 2].senderActorId = `coordinator-${index}`;
    protocol.coordination[index * 2 + 1].recipientActorId = `coordinator-${index}`;
  }
  const group = request(protocol).items[0];
  assert.equal(group.cards.length, 1);
  assert.equal(group.runCount, 3);
  assert.deepEqual(group.graphOrigins.map(origin => [origin.key, origin.outgoing, origin.incoming]), [
    ['coordinator-0', true, true], ['coordinator-1', true, true], ['coordinator-2', true, true]
  ]);
});

test("task directory routes return late selected detail and 404 an unknown canonical task", async () => {
  const protocol = fixture();
  const adapter = {
    id: "fixture",
    getSession(id) { return id === "root" ? { id: "root", timeUpdated: 1, messageCount: 1, tokenCount: 1 } : null; },
    getProtocolRevision() { return "directory-route"; },
    getSessionProtocolV3(id) { return id === "root" ? protocol : null; }
  };
  const routes = [];
  registerReaderCoordinationRoutes({ get(pattern, handler) { routes.push({ pattern, handler }); } }, {
    providerMap: new Map([["fixture", adapter]])
  });
  const request = async (path) => {
    const pathname = new URL(path, "http://localhost").pathname;
    const route = routes.find((item) => item.pattern.test(pathname));
    assert.ok(route, `route exists for ${pathname}`);
    const response = {
      status: 0, body: "",
      writeHead(status) { this.status = status; },
      end(body) { this.body = body; }
    };
    await route.handler({ url: path }, response, pathname.match(route.pattern));
    return { status: response.status, data: JSON.parse(response.body) };
  };
  const late = await request("/api/fixture/session/root/reader/task?key=run%3Arun-119");
  assert.equal(late.status, 200);
  assert.equal(late.data.key, "run:run-119");
  assert.equal(late.data.cards[0].bindings.runId, "run-119");
  assert.match(late.data.html, /data-reader-branch-run="run-119"/);
  assert.match(late.data.graphHtml, /data-reader-task-select="run:run-119"/);

  const missing = await request("/api/fixture/session/root/reader/task?key=run%3Amissing");
  assert.equal(missing.status, 404);
  assert.equal(missing.data.code, "task_not_found");
});
