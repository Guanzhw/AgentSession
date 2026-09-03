import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildOpenCodeSessionProtocol } from "../dist/src/providers/opencode/protocol.js";
import { buildOpenClawSessionProtocol } from "../dist/src/providers/openclaw/protocol.js";

function session(id, provider, parentId = null) {
  return { id, provider, parentId, title: null, directory: null, timeCreated: 1, timeUpdated: 2, messageCount: 0, tokenCount: null, metadata: null };
}

test("OpenCode protocol projects native parts and child sessions", () => {
  const tree = {
    session: { id: "oc", parent_id: null, title: "root", slug: null, directory: null, time_created: 1, time_updated: 2, message_count: 1, token_count: null, agent: "build", model: "m" },
    messages: [{ id: "m1", sessionId: "oc", role: "assistant", data: { role: "assistant", modelID: "m" }, timeCreated: 1, parts: [{ id: "p1", messageId: "m1", sessionId: "oc", type: "tool", tool: "task", data: { type: "tool", tool: "task", state: { status: "completed", time: { start: 1, end: 2 } } }, timeStart: 1, timeEnd: 2, childSessions: [{ session: { id: "child", title: "worker", model: "m2", time_created: 2 }, messages: [], detachedChildren: [], metrics: {} }] }] }],
    detachedChildren: [], metrics: {}
  };
  const protocol = buildOpenCodeSessionProtocol(tree, 1);
  assert.equal(protocol.validation.ok, true);
  assert.equal(protocol.relationships[0].toSessionId, "child");
  assert.equal(protocol.agentRuns[0].childSessionId, "child");
});

test("OpenCode current task output, todos, and compaction parts retain provider evidence", () => {
  const fixtureParts = readFileSync(new URL("./fixtures/opencode-current-v1.18.27-synthetic.jsonl", import.meta.url), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const tree = {
    session: { id: "oc-current", parent_id: null, title: "root", slug: null, directory: null, time_created: 1, time_updated: 8, message_count: 2, token_count: null, agent: "build", model: "m" },
    todos: [
      { content: "Bounded task", status: "in_progress", priority: "high", position: 0, time_created: 2, time_updated: 3 },
      { content: "Finished task", status: "completed", priority: "low", position: 1, time_created: 2, time_updated: 4 }
    ],
    messages: [
      { id: "m-user", sessionId: "oc-current", role: "user", data: { role: "user", parentID: null }, timeCreated: 2, parts: fixtureParts.slice(0, 2).map((data) => ({ id: data.id, messageId: "m-user", sessionId: "oc-current", type: data.type, tool: data.tool || null, data, timeStart: 2, timeEnd: 0, childSessions: [] })) },
      { id: "m-assistant", sessionId: "oc-current", role: "assistant", data: { role: "assistant", parentID: "m-user", modelID: "m" }, timeCreated: 4, parts: fixtureParts.slice(2).map((data) => ({ id: data.id, messageId: "m-assistant", sessionId: "oc-current", role: "tool", type: data.type, tool: data.tool || null, data, timeStart: 4, timeEnd: 0, childSessions: [] })) }
    ],
    detachedChildren: [], metrics: {}
  };
  const protocol = buildOpenCodeSessionProtocol(tree, 1);
  assert.equal(protocol.validation.ok, true);
  assert.deepEqual(protocol.tasks.map((task) => [task.kind, task.status]), [
    ["todo", "running"], ["todo", "completed"], ["subagent-task", "running"],
    ["subagent-task", "completed"], ["subagent-task", "failed"], ["subagent-task", "failed"]
  ]);
  assert.equal(protocol.tasks[2].requestEventId, "part:p-task-running");
  assert.equal(protocol.tasks[2].title, "running task");
  assert.equal(protocol.tasks[2].metadata.background, true);
  assert.equal(protocol.agentRuns[0].mode, "background");
  assert.equal(protocol.agentRuns[0].status, "running");
  assert.equal(protocol.agentRuns[1].status, "completed");
  assert.equal(protocol.agentRuns[2].status, "failed");
  assert.equal(protocol.agentRuns[3].status, "failed");
  const compaction = protocol.events.find((event) => event.kind === "context.compaction");
  assert.equal(compaction.compaction.trigger, "automatic");
  assert.equal(compaction.compaction.strategy, "unknown");
  assert.equal(compaction.providerData.tailStartId, "m-tail");
  assert.equal(compaction.compaction.retainedFromEventId, null);
  const anchored = buildOpenCodeSessionProtocol({
    ...tree,
    messages: [...tree.messages, { id: "m-tail", sessionId: "oc-current", role: "assistant", data: { role: "assistant" }, timeCreated: 5, parts: [] }]
  }, 1);
  assert.equal(anchored.events.find((event) => event.kind === "context.compaction").compaction.retainedFromEventId, "message:m-tail");
  const missingCompactionEvidence = buildOpenCodeSessionProtocol({
    ...tree,
    messages: [{
      ...tree.messages[0],
      parts: [{ id: "p-legacy-compaction", messageId: "m-user", sessionId: "oc-current", type: "compaction", data: { type: "compaction" }, timeStart: 2, timeEnd: 0, childSessions: [] }]
    }]
  }, 1);
  const legacyCompaction = missingCompactionEvidence.events.find((event) => event.kind === "context.compaction");
  assert.equal(legacyCompaction.compaction.trigger, "unknown");
  assert.equal(legacyCompaction.providerData.auto, null);
  assert.equal(legacyCompaction.providerData.overflow, null);
  const reordered = buildOpenCodeSessionProtocol({ ...tree, todos: [...tree.todos].reverse() }, 1);
  assert.deepEqual(reordered.tasks.slice(0, 2).map((task) => task.id), protocol.tasks.slice(0, 2).map((task) => task.id).reverse());
  const duplicateTodos = buildOpenCodeSessionProtocol({ ...tree, todos: [tree.todos[0], { ...tree.todos[0], position: 9 }] }, 1);
  assert.equal(duplicateTodos.validation.ok, true);
  assert.equal(new Set(duplicateTodos.tasks.slice(0, 2).map((task) => task.id)).size, 2);
});

test("OpenClaw protocol keeps active path and recorded branch heads", () => {
  const records = [
    { type: "session", id: "oclaw" },
    { type: "message", id: "a", parentId: null, message: { role: "user", content: "hi" } },
    { type: "message", id: "b", parentId: "a", message: { role: "assistant", content: "ok" } },
    { type: "message", id: "branch", parentId: "a", message: { role: "assistant", content: "other" } },
    { type: "message", id: "c", parentId: "b", message: { role: "assistant", content: "final" } }
  ];
  const protocol = buildOpenClawSessionProtocol(session("oclaw", "openclaw"), records, [], 1);
  assert.equal(protocol.validation.ok, true);
  assert.equal(protocol.events.some((event) => event.id === "record:c"), true);
  assert.equal(protocol.events.some((event) => event.id === "record:branch"), false);
  assert.equal(protocol.branches.length, 2);
});
