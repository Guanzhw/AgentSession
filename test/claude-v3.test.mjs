import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClaudeSessionProtocol,
  buildClaudeSessionProtocolV3
} from "../dist/src/providers/claude-code/protocol.js";
import {
  recordsToMessages
} from "../dist/src/providers/claude-code/parser.js";
import { finalizeSessionProtocol } from "../dist/src/providers/shared/session-protocol.js";
import { finalizeSessionProtocolV3 } from "../dist/src/providers/shared/session-protocol-v3.js";

const makeSession = (id = "claude-v3") => ({
  id,
  provider: "claude-code",
  parentId: null,
  title: id,
  directory: "D:\\WorkSpace",
  timeCreated: 1000,
  timeUpdated: 2000,
  messageCount: 0,
  tokenCount: null,
  metadata: null
});

const assistant = (id, usage, text = "answer", timestamp = 1100) => ({
  type: "assistant",
  uuid: id ? `${id}-uuid` : undefined,
  timestamp: new Date(timestamp).toISOString(),
  message: {
    ...(id ? { id } : {}),
    model: "claude-sonnet",
    usage,
    content: [{ type: "text", text }]
  }
});

const user = { type: "user", uuid: "u1", timestamp: new Date(1000).toISOString(), message: { content: [{ type: "text", text: "go" }] } };

function finalized(records, session = makeSession()) {
  const messages = recordsToMessages(records, session.id);
  const input = { session, messages, records, children: [] };
  const base = finalizeSessionProtocol(buildClaudeSessionProtocol(input), {
    provider: "claude-code",
    session,
    capabilities: {
      sessionEvents: { support: "partial", provenance: "derived" },
      sessionRelationships: { support: "partial", provenance: "derived" },
      tasks: { support: "full", provenance: "recorded" },
      agentRuns: { support: "partial", provenance: "derived" },
      contextArtifacts: { support: "full", provenance: "recorded" },
      branches: { support: "none", provenance: "derived" }
    },
    revision: "fixture"
  });
  return { input, base, v3: finalizeSessionProtocolV3(buildClaudeSessionProtocolV3(input, base)) };
}

test("Claude native v3 preserves finalized v2 facts and deduplicates canonical responses", () => {
  const usage = { input_tokens: 10, output_tokens: 30, cache_read_input_tokens: 20, cache_creation_input_tokens: 7, reasoning_tokens: 10, total_tokens: 67 };
  const records = [
    user,
    assistant("response-1", usage, "thinking/tool fragment"),
    assistant("response-1", usage, "text fragment", 1110),
    assistant("response-2", { ...usage, total_tokens: 999 }, "next response", 1200),
    assistant(null, usage, "fallback response", 1300),
    assistant(null, usage, "duplicate fallback", 1310),
    assistant(null, { ...usage, input_tokens: 11, total_tokens: 78 }, "different fallback", 1320)
  ];
  const { base, v3 } = finalized(records);
  assert.deepEqual(v3.events, base.events);
  assert.deepEqual(v3.relationships, base.relationships);
  assert.deepEqual(v3.tasks, base.tasks);
  assert.deepEqual(v3.agentRuns, base.agentRuns);
  assert.deepEqual(v3.contextArtifacts, base.contextArtifacts);
  assert.deepEqual(v3.branches, base.branches);
  assert.equal(v3.usageRecords.length, 4);
  assert.deepEqual(v3.usageRecords[0].tokens, {
    input: 10, cacheRead: 20, cacheWrite: 7, output: 20, reasoning: 10, total: 67
  });
  assert.equal(v3.usageRecords[1].tokens.total, null, "contradictory explicit total is not replaced");
  assert.equal(v3.usageRecords[0].eventId?.startsWith("event:"), true);
  assert.equal(v3.usageRecords[0].turnId, "response-1");
  assert.equal(v3.usageRecords.every((record) => record.runId === null && record.contextOriginSlices.length === 0), true);
  assert.equal(new Set(v3.usageRecords.map((record) => record.id)).size, 4);
  assert.equal(v3.coverage.usage.state, "observed");
  assert.equal(v3.validation.ok, true);
});

test("Claude native v3 normalizes scalar and nested cache and suppresses zero responses", () => {
  const records = [
    assistant("scalar", { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }),
    assistant("nested", { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 5 } }),
    assistant("zero", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  ];
  const { v3 } = finalized(records);
  assert.equal(v3.usageRecords.length, 2);
  assert.equal(v3.usageRecords[0].tokens.cacheWrite, 4);
  assert.equal(v3.usageRecords[1].tokens.cacheWrite, 9);
});

test("Claude task notifications retain missing tool-use-id and map stopped to cancelled", () => {
  const statuses = ["completed", "failed", "stopped", "done", "error", "aborted", null];
  const records = statuses.map((status, index) => ({
    type: "user",
    uuid: `notification-${index}`,
    timestamp: new Date(1000 + index).toISOString(),
    message: { content: [{ type: "text", text: `<task-notification><task-id>task-${index}</task-id>${index === 0 ? "<tool-use-id>tool-0</tool-use-id>" : ""}${status === null ? "" : `<status>${status}</status>`}</task-notification>` }] }
  }));
  const { base, v3 } = finalized(records);
  assert.deepEqual(base.tasks.map((task) => task.status), ["completed", "failed", "cancelled", "running", "running", "running", "running"]);
  assert.deepEqual(base.tasks.map((task) => task.timeCreated), statuses.map((_, index) => 1000 + index));
  assert.deepEqual(base.tasks.map((task) => task.timeUpdated), statuses.map((_, index) => 1000 + index));
  assert.deepEqual(base.tasks.map((task) => task.timeCompleted), [1000, 1001, 1002, null, null, null, null]);
  assert.equal(base.tasks[0].toolCallId, "tool-0");
  assert.equal(base.tasks[1].toolCallId, null);
  assert.equal(base.events.filter((event) => event.kind === "task").length, statuses.length);
  assert.equal(v3.coordination.length, 0);
  assert.equal(v3.coverage.coordination.state, "not-observed");
  assert.equal(v3.validation.ok, true);
});

test("Claude sidechain lineage and compaction stay out of v3 coordination and context results", () => {
  const records = [
    { type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 123 }, uuid: "compact-1", timestamp: new Date(1000).toISOString() },
    user
  ];
  const session = makeSession();
  const child = {
    session: { ...makeSession("child"), parentId: session.id, metadata: { agentId: "child-agent" } },
    messages: [],
    records: [{ isSidechain: true, agentId: "child-agent", sessionId: session.id }]
  };
  const messages = recordsToMessages(records, session.id);
  const input = { session, messages, records, children: [child] };
  const base = finalizeSessionProtocol(buildClaudeSessionProtocol(input), { provider: "claude-code", session, revision: "fixture" });
  const v3 = finalizeSessionProtocolV3(buildClaudeSessionProtocolV3(input, base));
  assert.equal(base.relationships.some((relationship) => relationship.type === "spawned"), true);
  assert.equal(v3.coordination.length, 0);
  assert.equal(v3.contextVersions.length, 0);
  assert.equal(v3.contextTransformations.length, 0);
  assert.equal(v3.coverage.context.state, "unknown");
  assert.equal(v3.validation.ok, true);
});
