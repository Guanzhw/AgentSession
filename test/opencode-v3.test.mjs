import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildOpenCodeSessionProtocol, buildOpenCodeSessionProtocolV3 } from "../dist/src/providers/opencode/protocol.js";
import { finalizeSessionProtocolV3 } from "../dist/src/providers/shared/session-protocol-v3.js";

const source = readFileSync(new URL("./fixtures/opencode-native-v3-synthetic.jsonl", import.meta.url), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line));

function treeFromSource({ includeChildren = true, compaction = false } = {}) {
  const session = source.find((row) => row.kind === "session");
  const todo = source.find((row) => row.kind === "todo");
  const messageRows = source.filter((row) => row.kind === "message");
  const partRows = source.filter((row) => row.kind === "part");
  const extraParts = compaction ? [{ id: "p-compaction", type: "compaction", auto: true, tail_start_id: "m-tail" }] : [];
  const child = (id) => ({
    session: { id, parent_id: session.id, title: id, model: "child-model", time_created: 350, time_updated: 400 },
    messages: [], detachedChildren: [], metrics: {}
  });
  const childByPart = new Map([
    ["p-exact", [child("oc-v3-child")]],
    ["p-result-ok", [child("oc-v3-child-result")]],
    ["p-result-error", [child("oc-v3-child-error")]]
  ]);
  const messageNodes = messageRows.map((row) => ({
    id: row.id, sessionId: session.id, role: row.role,
    data: { role: row.role, modelID: row.modelID, tokens: row.tokens }, timeCreated: row.time_created,
    parts: [...(row.parts || []), ...partRows.filter((part) => part.message_id === row.id), ...(row.id === "m-tools" ? extraParts : [])].map((data) => ({
      id: data.id, messageId: row.id, sessionId: session.id, type: data.type, tool: data.tool || null,
      data, timeStart: data.state?.time?.start || row.time_created, timeEnd: data.state?.time?.end || 0,
      childSessions: includeChildren ? (childByPart.get(data.id) || []) : []
    }))
  }));
  return {
    session: { ...session },
    todos: [todo], messages: messageNodes, detachedChildren: [], metrics: {}
  };
}

function finalizedPair(options) {
  const tree = treeFromSource(options);
  const base = buildOpenCodeSessionProtocol(tree, "fixture-revision");
  return { tree, base, v3: finalizeSessionProtocolV3(buildOpenCodeSessionProtocolV3(tree, base)) };
}

test("OpenCode native v3 preserves finalized v2 facts and has truthful empty domains", () => {
  const { base, v3 } = finalizedPair();
  for (const field of ["sessionId", "session", "events", "relationships", "tasks", "agentRuns", "contextArtifacts", "branches", "revision"]) {
    assert.deepEqual(v3[field], base[field], field);
  }
  assert.deepEqual(v3.goals, []);
  assert.deepEqual(v3.actors, []);
  assert.deepEqual(v3.contextVersions, []);
  assert.deepEqual(v3.contextTransformations, []);
  assert.equal(v3.validation?.ok, true);
  assert.equal(v3.coverage.work.state, "observed");
  assert.equal(v3.coverage.execution.state, "observed");
  assert.equal(v3.coverage.coordination.state, "observed");
  assert.equal(v3.coverage.context.state, "not-observed");
  assert.equal(v3.coverage.usage.state, "observed");
});

test("OpenCode v2 todo identity uses (session_id, position), and tool correlation uses callID", () => {
  const { base, tree } = finalizedPair();
  const todo = base.tasks.find((task) => task.kind === "todo");
  assert.equal(todo.id, "todo:oc-v3-root:0");
  assert.equal(todo.provenance.sourceId, "oc-v3-root:0");
  const task = base.tasks.find((candidate) => candidate.toolCallId === "call-exact");
  assert.equal(task.id, "task:p-exact");
  assert.equal(task.toolCallId, "call-exact");
  assert.equal(task.correlationId, "call-exact");
  assert.equal(base.events.find((event) => event.id === "part:p-exact").correlationId, "call-exact");
  assert.equal(base.relationships.find((relation) => relation.taskId === task.id).correlationId, "call-exact");
  const reordered = buildOpenCodeSessionProtocol({ ...tree, todos: [{ ...tree.todos[0], content: "edited", priority: "low", time_updated: 999 }] }, "fixture-revision");
  assert.equal(reordered.tasks.find((candidate) => candidate.kind === "todo").id, todo.id);
});

test("OpenCode native v3 distinguishes exact child launch, missing child, and result delivery", () => {
  const { v3 } = finalizedPair();
  const exact = v3.coordination.find((entry) => entry.taskId === "task:p-exact" && entry.kind === "spawn");
  assert.equal(exact.state, "started");
  assert.equal(exact.runId, "run:p-exact");
  assert.equal(exact.toSessionRef.sessionId, "oc-v3-child");
  assert.equal(exact.correlationId, "call-exact");
  for (const id of ["p-missing", "p-mismatch"]) {
    const delegate = v3.coordination.find((entry) => entry.taskId === `task:${id}` && entry.kind === "delegate");
    assert.equal(delegate.state, "requested");
    assert.equal(delegate.toSessionRef, null);
  }
  const deliveries = v3.coordination.filter((entry) => entry.kind === "result-delivery");
  assert.deepEqual(deliveries.map((entry) => [entry.runId, entry.state, entry.toSessionRef.sessionId]), [
    ["run:p-result-ok", "delivered", "oc-v3-root"],
    ["run:p-result-error", "failed", "oc-v3-root"]
  ]);
  const subtask = v3.coordination.find((entry) => entry.eventId === "part:p-subtask");
  assert.equal(subtask.kind, "delegate");
  assert.equal(subtask.state, "requested");
  assert.equal(subtask.taskId, null);
  assert.equal(subtask.correlationId, null);
});

test("OpenCode background mode needs explicit task result; foreground generic completion remains terminal", () => {
  const { base, v3 } = finalizedPair();
  assert.equal(base.agentRuns.find((run) => run.id === "run:p-bg").mode, "background");
  assert.equal(base.agentRuns.find((run) => run.id === "run:p-bg").status, "running");
  assert.equal(base.agentRuns.find((run) => run.id === "run:p-foreground").status, "completed");
  assert.equal(v3.coordination.some((entry) => entry.eventId === "part:p-bg" && entry.kind === "result-delivery"), false);
});

test("OpenCode usage is one record per nonzero assistant message with coherent totals only", () => {
  const { v3 } = finalizedPair();
  assert.equal(v3.usageRecords.length, 2);
  const coherent = v3.usageRecords.find((record) => record.eventId === "message:m-usage");
  assert.deepEqual(coherent.tokens, { input: 10, cacheRead: 8, cacheWrite: 3, output: 5, reasoning: 2, total: 28 });
  assert.equal(coherent.id, "usage:oc-v3-root:message:m-usage");
  assert.equal(coherent.runId, null);
  const mismatch = v3.usageRecords.find((record) => record.eventId === "message:m-mismatch");
  assert.equal(mismatch.tokens.total, null);
  assert.equal(v3.usageRecords.some((record) => record.eventId === "message:m-zero-error"), false);
  assert.equal(v3.validation?.ok, true);
});

test("OpenCode focused child exposes one incoming parent lineage", () => {
  const root = treeFromSource();
  const childTree = {
    ...root,
    session: { ...root.session, id: "oc-v3-child", parent_id: "oc-v3-root" },
    todos: [], messages: [], detachedChildren: []
  };
  const base = buildOpenCodeSessionProtocol(childTree, "fixture-revision");
  const v3 = finalizeSessionProtocolV3(buildOpenCodeSessionProtocolV3(childTree, base));
  assert.equal(v3.relationships.length, 1);
  assert.deepEqual(v3.relationships[0], {
    ...v3.relationships[0], fromSessionId: "oc-v3-child", toSessionId: "oc-v3-root", type: "parent"
  });
  assert.equal(v3.coordination.length, 0);
  assert.equal(v3.coverage.coordination.state, "not-observed");
  assert.equal(v3.validation?.ok, true);
});

test("OpenCode compaction without a result stays unknown context coverage", () => {
  const { v3 } = finalizedPair({ compaction: true });
  assert.equal(v3.contextTransformations.length, 0);
  assert.equal(v3.contextVersions.length, 0);
  assert.equal(v3.coverage.context.state, "unknown");
  assert.equal(v3.validation?.ok, true);
});
