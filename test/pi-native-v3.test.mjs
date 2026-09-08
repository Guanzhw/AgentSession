import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPiSessionProtocol,
  buildPiSessionProtocolV3
} from "../dist/src/providers/pi/protocol.js";
import { extractPiMeta, piRecordsToMessages } from "../dist/src/providers/pi/parser.js";
import { finalizeSessionProtocol } from "../dist/src/providers/shared/session-protocol.js";
import { finalizeSessionProtocolV3 } from "../dist/src/providers/shared/session-protocol-v3.js";

const session = {
  id: "pi-native-v3",
  provider: "pi",
  parentId: null,
  title: "Pi native v3",
  directory: "D:\\WorkSpace",
  timeCreated: 1000,
  timeUpdated: 2000,
  messageCount: 0,
  tokenCount: null,
  metadata: null
};

const assistant = (id, usage, extra = {}) => ({
  type: "message",
  id,
  parentId: extra.parentId ?? null,
  timestamp: new Date(1000 + Number(id.replace(/\\D/g, "")) || 1000).toISOString(),
  message: {
    role: "assistant",
    content: [{ type: "text", text: id }],
    model: "fallback-model",
    ...extra,
    usage
  }
});

function finalized(records) {
  const current = extractPiMeta(records, session.id);
  const messages = piRecordsToMessages(records, session.id);
  const input = { session: current, records, messages };
  const base = finalizeSessionProtocol(buildPiSessionProtocol(input), {
    provider: "pi",
    session: current,
    revision: "fixture"
  });
  return { base, v3: finalizeSessionProtocolV3(buildPiSessionProtocolV3(input, base)) };
}

test("Pi native v3 preserves v2 facts and emits distinct assistant request usage", () => {
  const records = [
    { type: "session", version: 3, id: session.id, timestamp: "1970-01-01T00:00:01.000Z" },
    assistant("a1", { input: 2, output: 8, reasoning: 3, cacheRead: 1, cacheWrite: 4, cacheWrite1h: 4, totalTokens: 15 }, { responseId: "response-1", responseModel: "preferred-model", providerThinkingLevel: "high" }),
    assistant("a2", { input: 2, output: 8, reasoning: 3, cacheRead: 1, cacheWrite: 4, totalTokens: 15 }, { parentId: "a1", responseId: "response-1" }),
    assistant("a3", { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 3 }, { parentId: "a2" }),
    assistant("a4", { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, { parentId: "a3", stopReason: "deferred", deferred: true }),
    { type: "message", id: "tool", parentId: "a3", timestamp: "1970-01-01T00:00:02.000Z", message: { role: "toolResult", toolCallId: "call", usage: { input: 20, output: 20, totalTokens: 40 }, content: "tool" } },
    { type: "compaction", id: "compact", parentId: "a4", timestamp: "1970-01-01T00:00:03.000Z", summary: "compact result", firstKeptEntryId: "a3", usage: { input: 10, output: 2, totalTokens: 12 } }
  ];
  const { base, v3 } = finalized(records);
  assert.deepEqual(v3.events, base.events);
  assert.deepEqual(v3.relationships, base.relationships);
  assert.deepEqual(v3.tasks, base.tasks);
  assert.deepEqual(v3.agentRuns, base.agentRuns);
  assert.deepEqual(v3.contextArtifacts, base.contextArtifacts);
  assert.deepEqual(v3.branches, base.branches);
  assert.equal(v3.usageRecords.length, 2);
  assert.deepEqual(v3.usageRecords[0].tokens, {
    input: 2, cacheRead: 1, cacheWrite: 4, output: 5, reasoning: 3, total: 15
  });
  assert.equal(v3.usageRecords[0].model, "preferred-model");
  assert.equal(v3.usageRecords[0].eventId, "event:a1");
  assert.equal(v3.usageRecords[1].id.endsWith(":a3"), true);
  assert.equal(v3.contextVersions.length, 1);
  assert.equal(v3.contextTransformations[0].resultVersionId, v3.contextVersions[0].id);
  assert.equal(v3.contextTransformations[0].eventId, "event:compaction:compact");
  assert.equal(v3.coverage.context.state, "observed");
  assert.equal(v3.coverage.usage.state, "observed");
  assert.equal(v3.validation.ok, true);
});

test("Pi native v3 keeps contradictory totals null and does not promote aggregates", () => {
  const records = [
    { type: "session", version: 3, id: session.id, timestamp: "1970-01-01T00:00:01.000Z" },
    assistant("a1", { input: 1, output: 2, reasoning: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 99 }),
    { type: "message", id: "tool", parentId: "a1", message: { role: "toolResult", usage: { input: 10, output: 10, totalTokens: 20 } } },
    { type: "branch_summary", id: "branch", parentId: "a1", summary: "branch summary", usage: { input: 1, output: 1, totalTokens: 2 } }
  ];
  const { v3 } = finalized(records);
  assert.equal(v3.usageRecords.length, 1);
  assert.equal(v3.usageRecords[0].tokens.total, null);
  assert.equal(v3.contextVersions.length, 1);
  assert.equal(v3.usageRecords[0].runId, null);
  assert.deepEqual(v3.usageRecords[0].contextOriginSlices, []);
  assert.equal(v3.validation.ok, true);
});

test("Pi native v3 reports unknown context when operations have no readable active result", () => {
  const records = [
    { type: "session", version: 3, id: session.id, timestamp: "1970-01-01T00:00:01.000Z" },
    { type: "compaction", id: "compact", parentId: null, timestamp: "1970-01-01T00:00:02.000Z" }
  ];
  const { v3 } = finalized(records);
  assert.deepEqual(v3.contextVersions, []);
  assert.deepEqual(v3.contextTransformations, []);
  assert.equal(v3.coverage.context.state, "unknown");
  assert.equal(v3.validation.ok, true);
});

test("Pi native v3 does not present an abandoned compaction as active context", () => {
  const records = [
    { type: "session", version: 3, id: session.id, timestamp: "1970-01-01T00:00:01.000Z" },
    { type: "message", id: "root", parentId: null, message: { role: "user", content: "go" } },
    { type: "compaction", id: "abandoned-compact", parentId: "root", summary: "abandoned result", firstKeptEntryId: "root" },
    assistant("active", { input: 1, output: 1, totalTokens: 2 }, { parentId: "root" })
  ];
  const { v3 } = finalized(records);
  assert.deepEqual(v3.contextVersions, []);
  assert.deepEqual(v3.contextTransformations, []);
  assert.equal(v3.coverage.context.state, "unknown");
  assert.equal(v3.validation.ok, true);
});

test("Pi native v3 counts abandoned assistant requests but never retainedTail copies", () => {
  const records = [
    { type: "session", version: 3, id: session.id, timestamp: "1970-01-01T00:00:01.000Z" },
    { type: "message", id: "root", parentId: null, message: { role: "user", content: "go" } },
    assistant("abandoned", { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5 }, { parentId: "root", responseId: "abandoned-response" }),
    { type: "branch_summary", id: "branch", parentId: "root", summary: "active path" },
    { type: "message", id: "active-user", parentId: "branch", message: { role: "user", content: "continue" } },
    assistant("active", { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4 }, { parentId: "active-user" }),
    { type: "compaction", id: "compact", parentId: "active", summary: "active compact", retainedTail: [{ role: "assistant", usage: { input: 90, output: 90, totalTokens: 180 } }] }
  ];
  const { v3 } = finalized(records);
  assert.deepEqual(v3.usageRecords.map((record) => record.provenance.sourceId), ["abandoned", "active"]);
  assert.equal(v3.usageRecords.some((record) => record.tokens.total === 180), false);
  assert.equal(v3.validation.ok, true);
});

test("Pi request identity namespaces fallbacks and prefer the active response occurrence", () => {
  const records = [
    { type: "session", version: 3, id: session.id, timestamp: "1970-01-01T00:00:01.000Z" },
    { type: "message", id: "root", parentId: null, message: { role: "user", content: "go" } },
    assistant("abandoned", { input: 4, output: 1, totalTokens: 5 }, { parentId: "root", responseId: "shared" }),
    assistant("active", { input: 2, output: 2, totalTokens: 4 }, { parentId: "root", responseId: "shared" }),
    assistant("shared", { input: 1, output: 1, totalTokens: 2 }, { parentId: "active" })
  ];
  const { v3 } = finalized(records);
  assert.deepEqual(v3.usageRecords.map((record) => record.id), [
    `usage:${session.id}:request:response:shared`,
    `usage:${session.id}:request:entry:shared`
  ]);
  assert.equal(v3.usageRecords[0].provenance.sourceId, "active");
  assert.equal(v3.usageRecords[0].eventId, "event:active");
  assert.equal(v3.usageRecords[0].turnId, "active");
});

test("Pi parser does not treat pending as a terminal deferred response", () => {
  const records = [
    { type: "session", version: 3, id: session.id, timestamp: "1970-01-01T00:00:01.000Z" },
    assistant("pending", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, { stopReason: "pending" })
  ];
  const messages = piRecordsToMessages(records, session.id);
  assert.equal(messages[0].metadata.stopReason, "pending");
  assert.equal(messages[0].metadata.deferred, null);
  assert.equal(messages[0].metadata.deferredTerminal, null);
});
