import assert from "node:assert/strict";
import test from "node:test";
import { buildHermesSessionProtocol, buildHermesSessionProtocolV3 } from "../dist/src/providers/hermes/protocol.js";
import { finalizeSessionProtocol } from "../dist/src/providers/shared/session-protocol.js";
import { finalizeSessionProtocolV3 } from "../dist/src/providers/shared/session-protocol-v3.js";

function entry(id, options = {}) {
  const session = {
    id,
    provider: "hermes",
    parentId: options.parentId || null,
    title: id,
    directory: null,
    timeCreated: options.timeCreated ?? 1000000,
    timeUpdated: options.timeUpdated ?? 1001000,
    messageCount: options.messageCount ?? 0,
    tokenCount: options.tokenCount ?? null,
    metadata: {
      source: options.source || "cli",
      model: "fixture-model",
      endReason: options.endReason || "stop",
      compressionParentId: options.compressionParentId || null,
      billingProvider: null
    }
  };
  return {
    session,
    messages: options.messages || [],
    rawSession: {
      id,
      ended_at: options.endedAt ?? 1001,
      end_reason: options.endReason || "stop",
      ...(options.rawSession || {})
    },
    asyncDelegations: options.asyncDelegations || []
  };
}

function finalizedV3(root, family = [root]) {
  const base = finalizeSessionProtocol(buildHermesSessionProtocol({ ...root, family }), {
    provider: "hermes",
    session: root.session,
    capabilities: {}
  });
  return {
    base,
    protocol: finalizeSessionProtocolV3(buildHermesSessionProtocolV3({ ...root, family }, base))
  };
}

test("Hermes native v3 preserves v2 facts and separates async lifecycle and delivery", () => {
  const root = entry("hermes-v3-root", {
    rawSession: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 0, reasoning_tokens: 1 },
    asyncDelegations: [{
      delegation_id: "deleg-v3-complete",
      state: "completed",
      dispatched_at: 1000,
      completed_at: 1004,
      updated_at: 1004,
      delivery_state: "pending",
      delivery_attempts: 0
    }, {
      delegation_id: "deleg-v3-unknown",
      state: "provider-future",
      dispatched_at: 1005,
      updated_at: 1006
    }]
  });
  const child = entry("hermes-v3-child", { parentId: root.session.id, source: "delegate", endedAt: 1003 });
  child.rawSession.model_config = JSON.stringify({ _delegate_from: root.session.id });
  const { base, protocol } = finalizedV3(root, [root, child]);

  for (const field of ["sessionId", "session", "events", "relationships", "tasks", "agentRuns", "contextArtifacts", "branches", "revision"]) {
    assert.deepEqual(protocol[field], base[field], field);
  }
  assert.deepEqual(protocol.goals, []);
  assert.deepEqual(protocol.actors, []);
  assert.deepEqual(protocol.contextVersions, []);
  assert.deepEqual(protocol.contextTransformations, []);
  assert.deepEqual(protocol.usageRecords, []);

  const complete = protocol.coordination.filter((item) => item.correlationId === "deleg-v3-complete");
  assert.deepEqual(complete.map((item) => [item.kind, item.state]), [
    ["delegate", "requested"],
    ["delegate", "completed"],
    ["result-delivery", "requested"]
  ]);
  assert.equal(complete.every((item) => item.eventId === "event:async-delegation:deleg-v3-complete"), true);
  assert.equal(complete[0].timestamp, 1000000);
  assert.equal(complete[1].timestamp, 1004000);
  assert.equal(complete[2].timestamp, 1004000);

  const unknown = protocol.coordination.filter((item) => item.correlationId === "deleg-v3-unknown");
  assert.deepEqual(unknown.map((item) => [item.kind, item.state]), [["delegate", "requested"]]);
  assert.equal(unknown[0].taskId, null, "unknown v2 state remains event-only without a dangling Task anchor");
  assert.equal(protocol.agentRuns.find((run) => run.childSessionId === child.session.id)?.taskId, null);
  assert.equal(protocol.coverage.work.state, "observed");
  assert.equal(protocol.coverage.execution.state, "observed");
  assert.equal(protocol.coverage.coordination.state, "observed");
  assert.equal(protocol.coverage.context.state, "not-observed");
  assert.equal(protocol.coverage.usage.state, "unknown");
  assert.equal(protocol.validation.ok, true);
});

test("Hermes native v3 keeps compression as unknown context result and does not bind children by proximity", () => {
  const root = entry("hermes-v3-compression", {
    endReason: "compression",
    rawSession: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 },
    asyncDelegations: [{ delegation_id: "deleg-v3-unbound", state: "completed", dispatched_at: 1001, completed_at: 1002, updated_at: 1002, delivery_state: "pending" }]
  });
  const continuation = entry("hermes-v3-continuation", { compressionParentId: root.session.id, timeCreated: 1002000 });
  const child = entry("hermes-v3-unbound-child", { parentId: root.session.id, source: "delegate", timeCreated: 1003000 });
  child.rawSession.model_config = JSON.stringify({ _delegate_from: root.session.id });
  const { protocol } = finalizedV3(root, [root, continuation, child]);
  assert.equal(protocol.coverage.context.state, "unknown");
  assert.equal(protocol.contextTransformations.length, 0);
  assert.equal(protocol.coordination.some((item) => item.runId || (item.toSessionRef && item.toSessionRef.sessionId !== root.session.id)), false);
  assert.equal(protocol.agentRuns.find((run) => run.childSessionId === child.session.id)?.taskId, null);
  assert.equal(protocol.validation.ok, true);
});

test("Hermes native v3 does not turn aggregate tokens into request usage", () => {
  const root = entry("hermes-v3-aggregate", { rawSession: { input_tokens: 1, output_tokens: 2 } });
  const { protocol } = finalizedV3(root);
  assert.deepEqual(protocol.usageRecords, []);
  assert.equal(protocol.coverage.usage.state, "unknown");
  assert.equal(protocol.validation.ok, true);
});
