import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenCodeSessionProtocol } from "../dist/src/providers/opencode/protocol.js";
import { buildOpenClawSessionProtocol } from "../dist/src/providers/openclaw/protocol.js";
import { buildCopilotSessionProtocol } from "../dist/src/providers/copilot/protocol.js";
import { buildGeminiSessionProtocol } from "../dist/src/providers/gemini/protocol.js";

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

test("Copilot inline agents do not become resumable child sessions", () => {
  const records = [
    { type: "session.start", id: "start" },
    { type: "subagent.started", id: "spawn", data: { agentId: "inline-1", agentName: "reviewer" } },
    { type: "subagent.completed", id: "done", agentId: "inline-1", data: {} }
  ];
  const protocol = buildCopilotSessionProtocol(session("cop", "copilot"), records, 1);
  assert.equal(protocol.validation.ok, true);
  assert.equal(protocol.relationships.length, 0);
  assert.equal(protocol.agentRuns[0].childSessionId, null);
  assert.equal(protocol.tasks[0].status, "completed");
});

test("Gemini protocol truthfully exposes only derived events", () => {
  const protocol = buildGeminiSessionProtocol(session("gem", "gemini"), {
    sessionId: "gem", messages: [{ id: "u", type: "user", text: "hi", timestamp: "2026-01-01T00:00:00Z" }]
  }, 1);
  assert.equal(protocol.validation.ok, true);
  assert.equal(protocol.events[1].provenance.fidelity, "derived");
  assert.deepEqual(protocol.relationships, []);
  assert.deepEqual(protocol.tasks, []);
  assert.deepEqual(protocol.agentRuns, []);
  assert.equal(protocol.completeness, "complete");
});
