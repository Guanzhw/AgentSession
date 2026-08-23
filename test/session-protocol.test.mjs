import assert from "node:assert/strict";
import test from "node:test";

import { getAllProviders } from "../dist/src/providers/index.js";
import {
  protocolCapability,
  protocolCapabilityDescriptors,
  supportsSessionProtocol
} from "../dist/src/providers/kinds.js";
import {
  agentRun,
  assignEventSequences,
  capabilityDescriptor,
  compactionEnvelope,
  compactionSummaryArtifact,
  contextArtifact,
  contextCompactionEvent,
  defaultCapabilityDescriptor,
  isContextLifecycleEventKind,
  messageSessionEvents,
  normalizeCompactionStrategy,
  normalizeCompactionTrigger,
  sequenceEventsBySource,
  sequenceSessionEvents,
  sessionEvent,
  sessionRelationship,
  sessionTask,
  sourceSequence
} from "../dist/src/providers/shared/session-protocol.js";
import { buildCodexSessionProtocol, codexCompactionRecord } from "../dist/src/providers/codex/protocol.js";
import { buildClaudeSessionProtocol, claudeCompactionRecord } from "../dist/src/providers/claude-code/protocol.js";
import { buildPiSessionProtocol, piCompactionEntry } from "../dist/src/providers/pi/protocol.js";
import { buildHermesSessionProtocol } from "../dist/src/providers/hermes/protocol.js";
import { buildDshSessionProtocol } from "../dist/src/providers/deepseek-harness/protocol.js";
import { buildLinkedMessageSessionViews } from "../dist/src/providers/shared/linked-message-session.js";

const recorded = (sourceType, sourceId = null) => ({ fidelity: "recorded", sourceType, sourceId });
const derived = (sourceType, sourceId = null) => ({ fidelity: "derived", sourceType, sourceId });

const session = (id, parentId = null, metadata = null, timeCreated = 1000) => ({
  id,
  provider: "fixture",
  parentId,
  title: id,
  directory: "D:\\WorkSpace",
  timeCreated,
  timeUpdated: timeCreated + 100,
  messageCount: 1,
  tokenCount: null,
  metadata
});

const message = (id, role = "assistant", timestamp = 1000) => ({
  id,
  sessionId: "s1",
  role,
  content: role === "assistant" ? `answer ${id}` : "",
  thinking: null,
  toolName: null,
  toolInput: null,
  toolOutput: null,
  timestamp,
  tokens: null,
  metadata: { turnId: "turn-1", callId: role === "tool" ? id : null }
});

// ---------------------------------------------------------------------------
// Type/runtime helpers
// ---------------------------------------------------------------------------

test("sequences follow canonical source order and never reorder by timestamps", () => {
  // Out-of-order, equal, and null timestamps must not influence the sequence:
  // input order IS the source order.
  const events = [
    { id: "a", timestamp: 300 },
    { id: "b", timestamp: 100 },
    { id: "c", timestamp: null },
    { id: "d", timestamp: 100 },
    { id: "e", timestamp: 200 }
  ];
  assert.deepEqual(assignEventSequences(events), [1, 2, 3, 4, 5]);
  // A different input order produces its own source order.
  const shuffled = [events[3], events[0], events[2], events[1], events[4]];
  assert.deepEqual(assignEventSequences(shuffled), [1, 2, 3, 4, 5]);
  const sequenced = sequenceSessionEvents(events);
  assert.deepEqual(sequenced.map((event) => event.sequence), [1, 2, 3, 4, 5]);
  assert.deepEqual(sequenced.map((event) => event.id), ["a", "b", "c", "d", "e"]);
  assert.equal(new Set(sequenced.map((event) => event.sequence)).size, 5);
});

test("sourceSequence anchors and sequenceEventsBySource produce dense source-ordered sequences", () => {
  const envelope = (id, anchor, timestamp) => sessionEvent({
    id,
    sessionId: "s1",
    sequence: 0,
    timestamp,
    kind: "message.user",
    provenance: recorded("fixture"),
    providerData: anchor == null ? null : { sourceSequence: anchor }
  });
  // Anchors are out of order; timestamps are deliberately contradictory.
  const events = [
    envelope("b", sourceSequence(2, 0), 100),
    envelope("a", sourceSequence(0, 0), 300),
    envelope("fallback-1", null, 50),
    envelope("c", sourceSequence(2, 1), 400),
    envelope("fallback-2", null, 60)
  ];
  const sequenced = sequenceEventsBySource(events);
  assert.deepEqual(
    sequenced.map((event) => event.id),
    ["a", "b", "c", "fallback-1", "fallback-2"],
    "anchored events follow source order; unanchored events keep input order, appended"
  );
  assert.deepEqual(sequenced.map((event) => event.sequence), [1, 2, 3, 4, 5], "gap-free dense 1..n");
  assert.equal(sourceSequence(0, 0), 0);
  assert.equal(sourceSequence(2, 1), 2001);
});

test("event and relationship factories validate enums and provenance", () => {
  assert.throws(() => sessionEvent({
    id: "x", sessionId: "s", sequence: 1, timestamp: 0, kind: "k",
    provenance: { fidelity: "guessed", sourceType: "t" }
  }), TypeError);
  assert.throws(() => sessionRelationship({
    type: "teleported", fromSessionId: "a", toSessionId: "b", provenance: recorded("t")
  }), TypeError);
  assert.throws(() => sessionTask({
    id: "x", sessionId: "s", kind: "k", status: "dunno",
    timeCreated: null, timeUpdated: null, timeCompleted: null, provenance: recorded("t")
  }), TypeError);
  assert.throws(() => agentRun({
    id: "x", sessionId: "s", taskId: null, status: "completed", mode: "night-shift",
    agent: null, model: null, childSessionId: null, timeStart: null, timeEnd: null,
    provenance: recorded("t")
  }), TypeError);
  assert.throws(() => contextArtifact({
    id: "x", sessionId: "s", kind: "summary", scope: "session", origin: "provider-generated",
    contentAccess: "partially", title: null, summary: null, sourcePath: null, producerRunId: null,
    sourceSessionIds: [], hash: null, redacted: false, provenance: recorded("t"), timeCreated: null
  }), TypeError);
  assert.throws(() => contextArtifact({
    id: "x", sessionId: "s", kind: "essay", scope: "session", origin: "provider-generated",
    contentAccess: "metadata-only", title: null, summary: null, sourcePath: null, producerRunId: null,
    sourceSessionIds: [], hash: null, redacted: false, provenance: recorded("t"), timeCreated: null
  }), TypeError);
  assert.throws(() => capabilityDescriptor("maybe", "recorded"), TypeError);
  assert.throws(() => capabilityDescriptor("full", "invented"), TypeError);
});

test("lifecycle observations are event kinds, never artifact fields or plain-compaction events", () => {
  assert.equal(isContextLifecycleEventKind("memory.generated"), true);
  assert.equal(isContextLifecycleEventKind("memory.consolidated"), true);
  assert.equal(isContextLifecycleEventKind("context.loaded"), true);
  assert.equal(isContextLifecycleEventKind("context.reinjected"), true);
  assert.equal(isContextLifecycleEventKind("context.cited"), true);
  assert.equal(isContextLifecycleEventKind("context.compaction"), false);
  assert.equal(isContextLifecycleEventKind("anything"), false);

  const compaction = contextCompactionEvent({
    trigger: "auto",
    strategy: "opaque",
    tokensBefore: 500,
    tokensAfter: "120",
    summary: "  ",
    retainedFromEventId: "evt-1",
    continuationSessionId: "s2"
  });
  assert.equal(compaction.trigger, "automatic");
  assert.equal(compaction.tokensBefore, 500);
  assert.equal(compaction.tokensAfter, null);
  assert.equal(compaction.summary, null);

  const envelope = compactionEnvelope({
    id: "e1",
    sessionId: "s1",
    timestamp: 100,
    correlationId: "c1",
    provenance: recorded("fixture")
  }, compaction);
  assert.equal(envelope.kind, "context.compaction");
  assert.equal(envelope.phase, "completed");
  assert.equal(envelope.compaction.strategy, "opaque");
  assert.equal(envelope.provenance.fidelity, "recorded");
  // Plain compaction never fabricates a memory/context lifecycle event.
  assert.equal(isContextLifecycleEventKind(envelope.kind), false);
});

test("message-derived envelopes carry derived provenance and correlation ids", () => {
  const events = messageSessionEvents(
    [message("m1", "user", 10), message("m2", "tool", 20), message("m3", "assistant", 30)],
    "s1",
    "fixture.normalized-message"
  );
  assert.deepEqual(events.map((event) => event.kind), ["message.user", "message.tool", "message.assistant"]);
  assert.ok(events.every((event) => event.provenance.fidelity === "derived"));
  assert.equal(events[1].correlationId, "m2");
  assert.equal(events[1].turnId, "turn-1");
  assert.equal(events[0].turnId, "turn-1");
});

test("context artifacts are metadata-first with the reviewed schema", () => {
  const artifact = compactionSummaryArtifact({
    id: "a1",
    sessionId: "s1",
    sourceSessionIds: ["s1"],
    provenance: recorded("fixture"),
    timeCreated: 100,
    metadata: { strategy: "opaque" }
  });
  assert.equal(artifact.kind, "summary");
  assert.equal(artifact.scope, "session");
  assert.equal(artifact.origin, "provider-generated");
  assert.equal(artifact.contentAccess, "metadata-only");
  assert.equal(artifact.summary, null, "no plaintext content");
  assert.deepEqual(artifact.sourceSessionIds, ["s1"]);
  assert.equal(artifact.redacted, true);
  assert.equal(artifact.hash, null);
  assert.equal(artifact.producerRunId, null);
  assert.equal(artifact.lifecycle, undefined, "lifecycle is not an artifact field");
  assert.equal(artifact.contentAvailable, undefined);
  assert.equal(artifact.contentRef, undefined);

  // The generic factory keeps explicit values but never invents content.
  const generic = contextArtifact({
    id: "a2",
    sessionId: "s1",
    kind: "memory",
    scope: "agent",
    origin: "agent-generated",
    contentAccess: "summary",
    title: "notable fact",
    summary: "short note",
    sourcePath: "/tmp/note.md",
    producerRunId: "run-1",
    sourceSessionIds: ["s1", "s2"],
    hash: "abc123",
    redacted: false,
    provenance: recorded("fixture"),
    timeCreated: 100
  });
  assert.equal(generic.summary, "short note");
  assert.equal(generic.sourcePath, "/tmp/note.md");
  assert.deepEqual(generic.sourceSessionIds, ["s1", "s2"]);
  assert.equal(generic.hash, "abc123");
  // Duplicate and empty source ids are normalized away.
  const normalized = contextArtifact({
    id: "a3",
    sessionId: "s1",
    kind: "summary",
    scope: "session",
    origin: "provider-generated",
    contentAccess: "metadata-only",
    title: null, summary: null, sourcePath: null, producerRunId: null,
    sourceSessionIds: ["s1", "s1", ""], hash: null, redacted: false,
    provenance: recorded("fixture"), timeCreated: null
  });
  assert.deepEqual(normalized.sourceSessionIds, ["s1"]);
});

// ---------------------------------------------------------------------------
// Capability truthfulness
// ---------------------------------------------------------------------------

test("capability descriptors stay truthful across every provider", () => {
  const domains = ["sessionEvents", "sessionRelationships", "tasks", "agentRuns", "contextArtifacts"];
  for (const provider of getAllProviders()) {
    for (const domain of domains) {
      const descriptor = protocolCapability(provider, domain);
      assert.ok(["full", "partial", "none"].includes(descriptor.support), provider.id);
      assert.ok(["recorded", "derived"].includes(descriptor.provenance), provider.id);
      // No domain may claim support without an accessor implementation.
      if (descriptor.support !== "none") {
        assert.equal(typeof provider.getSessionProtocol, "function", `${provider.id}:${domain}`);
      }
    }
    if (supportsSessionProtocol(provider)) {
      // A protocol accessor must always expose at least the event surface.
      assert.notEqual(protocolCapability(provider, "sessionEvents").support, "none", provider.id);
    }
  }
  for (const provider of getAllProviders()) {
    assert.equal(
      supportsSessionProtocol(provider),
      true,
      provider.id
    );
  }
  assert.equal(protocolCapability(null, "tasks").support, "none");
  assert.deepEqual(defaultCapabilityDescriptor(), { support: "none", provenance: "derived" });
});

test("provider protocol access remains adapter-owned for unknown sessions", () => {
  const provider = getAllProviders().find((candidate) => candidate.id === "pi");
  assert.equal(provider.getSessionProtocol("no-such-session"), null);
  const opencode = getAllProviders().find((candidate) => candidate.id === "opencode");
  assert.equal(opencode.getSessionProtocol("x"), null);
});

test("descriptor provenance never overclaims recorded for mixed-fidelity domains", () => {
  const domains = [
    ["sessionEvents", "events"],
    ["sessionRelationships", "relationships"],
    ["tasks", "tasks"],
    ["agentRuns", "agentRuns"],
    ["contextArtifacts", "contextArtifacts"]
  ];
  const protocols = [
    // Codex: recorded compaction/task events + derived message events.
    buildCodexSessionProtocol({
      session: session("root"),
      messages: [message("m1", "assistant", 500)],
      records: [
        { type: "session_meta", timestamp: "2026-07-19T00:00:00Z", payload: { id: "root" } },
        { type: "compacted", timestamp: "2026-07-19T00:05:00Z", payload: { tokens_before: 9000 } }
      ],
      children: []
    }),
    // Claude: recorded notifications + derived message events.
    buildClaudeSessionProtocol({
      session: session("parent-session"),
      messages: [message("m1", "tool", 600)],
      records: [{
        type: "user",
        uuid: "notif-1",
        timestamp: "2026-07-19T00:05:00Z",
        message: { content: [{ type: "text", text: "<task-notification><task-id>a1</task-id><tool-use-id>call-1</tool-use-id><status>completed</status></task-notification>" }] }
      }],
      children: []
    }),
    // Pi: recorded compaction entries + derived message events.
    buildPiSessionProtocol({
      session: session("pi-session", "019f7a00-0000-7000-8000-000000000000"),
      records: [
        { type: "session", version: 3, id: "pi-session", timestamp: "2026-07-19T01:00:00.000Z" },
        { type: "compaction", id: "compact1", timestamp: "2026-07-19T01:00:06.000Z", summary: "Compacted." }
      ],
      messages: [message("m1", "assistant", 700)]
    }),
    // Hermes: fully derived lineage.
    buildHermesSessionProtocol({
      ...hermesEntry("hermes-root"),
      family: [hermesEntry("hermes-root"), hermesEntry("hermes-continuation", null, "hermes-root")]
    }),
    // DSH: every retained source event is recorded rather than a
    // message-derived reconstruction; compaction remains metadata-only.
    buildDshSessionProtocol({
      session: session("dsh-root"),
      records: [
        { type: "session", version: 0, id: "dsh-root", createdAt: 1000 },
        { type: "compaction/prune", seq: 0, time: 1100, data: { shadowedTokenCount: 42, shadowedSeqs: [] } }
      ],
      messages: [],
      children: []
    })
  ];

  for (const provider of getAllProviders().filter((candidate) => supportsSessionProtocol(candidate))) {
    const descriptors = protocolCapabilityDescriptors(provider);
    const byId = {
      codex: protocols[0],
      "claude-code": protocols[1],
      pi: protocols[2],
      hermes: protocols[3],
      "deepseek-harness": protocols[4]
    }[provider.id];
    // The four newly-covered providers have provider-native protocol fixtures
    // in runtime-protocol-missing-providers.test.mjs. This block retains the
    // mixed-fidelity assertions for the original five builders.
    if (!byId) continue;
    for (const [domain, key] of domains) {
      const descriptor = descriptors[domain];
      if (descriptor.support === "none") continue;
      const values = byId[key] || [];
      const hasRecorded = values.some((value) => value.provenance?.fidelity === "recorded");
      const hasDerived = values.some((value) => value.provenance?.fidelity === "derived");
      if (descriptor.provenance === "recorded") {
        // A recorded claim must hold for every produced value.
        assert.equal(hasDerived, false, `${provider.id}:${domain} claims recorded but contains derived values`);
        assert.ok(values.length === 0 || hasRecorded, `${provider.id}:${domain} claims recorded but has none`);
      } else {
        assert.equal(descriptor.provenance, "derived", provider.id);
        assert.equal(hasRecorded || hasDerived, values.length > 0, provider.id);
      }
    }
    if (provider.id !== "deepseek-harness") {
      assert.equal(
        descriptors.sessionEvents.provenance,
        "derived",
        "normalized event domains never claim a single recorded fidelity"
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

test("Codex compaction variants normalize to context.compaction events", () => {
  const records = [
    { type: "session_meta", timestamp: "2026-07-19T00:00:00Z", payload: { id: "root" } },
    {
      type: "compacted",
      timestamp: "2026-07-19T00:05:00Z",
      payload: {
        summary: "Earlier steps were compacted.",
        tokens_before: 9000,
        tokens_after: 1200,
        first_kept_token_id: "tok-100"
      }
    },
    {
      type: "event_msg",
      timestamp: "2026-07-19T00:06:00Z",
      payload: { type: "context_compacted", tokens_before: 8000, id: "compact-2" }
    },
    {
      type: "contextCompaction",
      // Deliberately EARLIER than the other records: sequences must follow
      // record order, never timestamp chronology.
      timestamp: "2026-07-19T00:01:00Z",
      payload: { trigger: "limit-recovery", strategy: "hybrid", tokens_before: 7000 }
    }
  ];
  const protocol = buildCodexSessionProtocol({
    session: session("root"),
    messages: [],
    records,
    children: []
  });
  const compactionEvents = protocol.events.filter((event) => event.kind === "context.compaction");
  assert.equal(compactionEvents.length, 3);
  const [first, opaque, limit] = compactionEvents;
  assert.equal(first.compaction.strategy, "summary");
  assert.equal(first.compaction.tokensBefore, 9000);
  assert.equal(first.compaction.tokensAfter, 1200);
  assert.equal(first.compaction.retainedFromEventId, "tok-100");
  assert.equal(first.compaction.summary, "Earlier steps were compacted.");
  assert.equal(first.provenance.fidelity, "recorded");
  assert.equal(opaque.compaction.strategy, "opaque");
  assert.equal(opaque.compaction.summary, null);
  assert.equal(opaque.compaction.tokensBefore, 8000);
  assert.equal(limit.compaction.trigger, "limit-recovery");
  assert.equal(limit.compaction.strategy, "hybrid");
  // Source order wins over timestamps: the limit-recovery record has the
  // earliest timestamp but the latest sequence.
  assert.deepEqual(
    compactionEvents.map((event) => event.sequence),
    [1, 2, 3],
    "compaction events keep record order (monotonic gap-free sequences)"
  );
  assert.equal(limit.timestamp < first.timestamp, true, "timestamps are inverted on purpose");
  // Sequences cover all events contiguously.
  const sequences = protocol.events.map((event) => event.sequence).sort((a, b) => a - b);
  assert.deepEqual(sequences, protocol.events.map((_, index) => index + 1));
  // Metadata-only summary artifacts, one per compaction record, with no
  // plaintext and no lifecycle observation.
  assert.equal(protocol.contextArtifacts.length, 3);
  for (const artifact of protocol.contextArtifacts) {
    assert.equal(artifact.kind, "summary");
    assert.equal(artifact.scope, "session");
    assert.equal(artifact.origin, "provider-generated");
    assert.equal(artifact.contentAccess, "metadata-only");
    assert.equal(artifact.summary, null);
    assert.deepEqual(artifact.sourceSessionIds, ["root"]);
    assert.equal(artifact.redacted, true);
  }
  assert.equal(
    protocol.events.some((event) => isContextLifecycleEventKind(event.kind)),
    false,
    "plain compaction never emits memory/context lifecycle events"
  );
});

test("Codex NEW_TASK envelopes become Tasks and child rollouts become AgentRuns", () => {
  const envelope = (id) => ({
    type: "response_item",
    timestamp: "2026-07-19T00:01:00Z",
    payload: {
      type: "agent_message",
      id,
      content: [{ type: "text", text: "Message Type: NEW_TASK\n\nTask name: reviewer" }]
    }
  });
  const records = [
    { type: "session_meta", timestamp: "2026-07-19T00:00:00Z", payload: { id: "root", agent_path: "/root" } },
    envelope("task-1")
  ];
  const child = {
    session: session("child-1", "root", { agentPath: "/root/reviewer", agentNickname: "reviewer" }, 2000),
    messages: [message("child-msg", "assistant", 2100)],
    records: [
      { type: "session_meta", timestamp: "2026-07-19T00:00:30Z", payload: { id: "child-1", model: "gpt-5" } },
      { type: "response_item", timestamp: "2026-07-19T00:00:31Z", payload: { type: "message", role: "assistant" } }
    ]
  };
  const protocol = buildCodexSessionProtocol({
    session: session("root"),
    messages: [message("m1", "assistant", 500)],
    records,
    children: [child]
  });

  assert.equal(protocol.tasks.length, 1);
  const task = protocol.tasks[0];
  assert.equal(task.id, "task-1");
  assert.equal(task.status, "completed");
  assert.equal(task.mode, undefined, "execution mode belongs to AgentRun, not Task");
  assert.deepEqual(task.dependencies, []);
  assert.equal(task.assignee, null);
  assert.equal(task.toolCallId, "task-1");
  assert.equal(task.agentPath, "/root/reviewer", "task agent path resolves to the child rollout");
  assert.equal(task.provenance.fidelity, "recorded");

  assert.equal(protocol.agentRuns.length, 1);
  const run = protocol.agentRuns[0];
  assert.equal(run.taskId, "task-1");
  assert.equal(run.childSessionId, "child-1");
  assert.equal(run.status, "completed");
  assert.equal(run.model, "gpt-5");
  assert.equal(run.provenance.fidelity, "derived");

  const spawned = protocol.relationships.filter((relationship) => relationship.type === "spawned");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].fromSessionId, "root");
  assert.equal(spawned[0].toSessionId, "child-1");
  assert.equal(spawned[0].provenance.fidelity, "derived");

  // Task lifecycle events are recorded; message events are derived.
  const taskEvents = protocol.events.filter((event) => event.kind === "task");
  assert.equal(taskEvents.length, 1);
  assert.equal(taskEvents[0].phase, "started");
  assert.equal(taskEvents[0].provenance.fidelity, "recorded");
  assert.equal(
    protocol.events.find((event) => event.kind === "message.assistant").provenance.fidelity,
    "derived"
  );
});

test("Codex sub_agent_activity and call-output evidence bind spawn calls to child rollouts", () => {
  // Real-world record order: spawn function_call (132), sub_agent_activity
  // (133, event_id = call id, agent_thread_id = child session), then
  // function_call_output (134). The child must bind to the spawn call, not
  // stay running with a null task correlation.
  const callId = "call_g123";
  const records = [
    { type: "session_meta", timestamp: "2026-07-19T00:00:00Z", payload: { id: "root" } },
    { type: "response_item", timestamp: "2026-07-19T00:01:00Z", payload: { type: "function_call", call_id: callId, name: "task", arguments: "{}" } },
    {
      type: "event_msg",
      timestamp: "2026-07-19T00:01:01Z",
      payload: {
        type: "sub_agent_activity",
        event_id: callId,
        agent_thread_id: "child-1",
        agent_path: "/root/worker",
        kind: "started"
      }
    },
    {
      type: "response_item",
      timestamp: "2026-07-19T00:01:02Z",
      payload: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({ thread_id: "child-1", status: "completed" })
      }
    },
    {
      type: "response_item",
      timestamp: "2026-07-19T00:02:00Z",
      payload: {
        type: "agent_message",
        author: "/root/worker",
        content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nTask name: worker\nPayload:\ndone" }]
      }
    }
  ];
  const child = {
    session: session("child-1", "root", { agentPath: "/root/worker", agentNickname: "worker" }, 2000),
    messages: [message("child-msg", "assistant", 2100)],
    records: [
      { type: "session_meta", timestamp: "2026-07-19T00:00:30Z", payload: { id: "child-1", model: "gpt-5" } }
    ]
  };
  const protocol = buildCodexSessionProtocol({
    session: session("root"),
    messages: [message("m1", "assistant", 1500)],
    records,
    children: [child]
  });

  assert.equal(protocol.tasks.length, 1);
  const task = protocol.tasks[0];
  assert.equal(task.id, callId);
  assert.equal(task.status, "completed", "the child rollout proves completion");
  assert.equal(task.mode, undefined, "execution mode belongs to AgentRun, not Task");
  assert.equal(task.toolCallId, callId, "toolCallId is the spawn call id");
  assert.equal(task.correlationId, callId);
  assert.equal(task.agentPath, "/root/worker");
  assert.equal(task.provenance.fidelity, "recorded", "sub_agent_activity is recorded evidence");
  assert.equal(task.provenance.sourceType, "codex.sub_agent_activity");
  assert.equal(task.provenance.sourceId, callId);
  assert.deepEqual(task.metadata, { activityKind: "started" });

  assert.equal(protocol.agentRuns.length, 1);
  const run = protocol.agentRuns[0];
  assert.equal(run.taskId, callId, "run binds to the spawn task instead of staying null");
  assert.equal(run.childSessionId, "child-1");
  assert.equal(run.status, "completed");
  assert.equal(run.mode, "subagent", "mode is not invented when the source records none");
  assert.equal(run.model, "gpt-5");

  const spawned = protocol.relationships.filter((r) => r.type === "spawned");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].fromSessionId, "root");
  assert.equal(spawned[0].toSessionId, "child-1");
  assert.equal(spawned[0].correlationId, callId, "relationship correlation binds to the spawn call");
});

test("Codex execution mode comes only from recorded source evidence", () => {
  const callId = "call_g456";
  const records = [
    { type: "session_meta", timestamp: "2026-07-19T00:00:00Z", payload: { id: "root" } },
    { type: "response_item", timestamp: "2026-07-19T00:01:00Z", payload: { type: "function_call", call_id: callId, name: "agent", arguments: "{}" } },
    {
      type: "event_msg",
      timestamp: "2026-07-19T00:01:01Z",
      payload: {
        type: "sub_agent_activity",
        event_id: callId,
        agent_thread_id: "child-1",
        agent_path: "/root/worker",
        kind: "completed",
        mode: "background"
      }
    },
    { type: "response_item", timestamp: "2026-07-19T00:01:02Z", payload: { type: "function_call_output", call_id: callId, output: "done" } }
  ];
  const child = {
    session: session("child-1", "root", { agentPath: "/root/worker" }, 2000),
    messages: [],
    records: [{ type: "session_meta", timestamp: "2026-07-19T00:00:30Z", payload: { id: "child-1" } }]
  };
  const protocol = buildCodexSessionProtocol({
    session: session("root"),
    messages: [],
    records,
    children: [child]
  });
  assert.equal(protocol.agentRuns.length, 1);
  assert.equal(protocol.agentRuns[0].mode, "background", "recorded background mode is honored");
  assert.equal(protocol.agentRuns[0].taskId, callId);
});

test("Codex call-output alone binds a child without claiming completion", () => {
  const callId = "call_g789";
  const records = [
    { type: "session_meta", timestamp: "2026-07-19T00:00:00Z", payload: { id: "root" } },
    { type: "response_item", timestamp: "2026-07-19T00:01:00Z", payload: { type: "function_call", call_id: callId, name: "task", arguments: "{}" } },
    {
      type: "response_item",
      timestamp: "2026-07-19T00:01:02Z",
      payload: { type: "function_call_output", call_id: callId, output: JSON.stringify({ session_id: "rollout-child-1" }) }
    }
  ];
  const child = {
    session: session("child-1", "root", { agentPath: "/root/worker" }, 2000),
    messages: [],
    records: [{ type: "session_meta", timestamp: "2026-07-19T00:00:30Z", payload: { id: "child-1" } }]
  };
  const protocol = buildCodexSessionProtocol({
    session: session("root"),
    messages: [],
    records,
    children: [child]
  });
  assert.equal(protocol.tasks.length, 1);
  assert.equal(protocol.tasks[0].status, "running");
  assert.equal(protocol.tasks[0].provenance.fidelity, "derived");
  assert.equal(protocol.tasks[0].provenance.sourceType, "codex.response_item:function_call:spawn");
  assert.equal(protocol.agentRuns[0].taskId, callId);
  assert.equal(protocol.agentRuns[0].childSessionId, "child-1");
  assert.equal(protocol.agentRuns[0].status, "running");
  assert.equal(protocol.agentRuns[0].timeEnd, null);
});

test("Codex child-local FINAL_ANSWER completes a spawn-bound run", () => {
  const callId = "call_child_final";
  const records = [
    { type: "session_meta", timestamp: "2026-07-19T00:00:00Z", payload: { id: "root" } },
    { type: "response_item", timestamp: "2026-07-19T00:01:00Z", payload: { type: "function_call", call_id: callId, name: "task", arguments: "{}" } },
    { type: "response_item", timestamp: "2026-07-19T00:01:02Z", payload: { type: "function_call_output", call_id: callId, output: "{\"session_id\":\"child-1\"}" } }
  ];
  const child = {
    session: session("child-1", "root", { agentPath: "/root/worker" }, 2000),
    messages: [],
    records: [
      { type: "session_meta", timestamp: "2026-07-19T00:00:30Z", payload: { id: "child-1" } },
      {
        type: "response_item",
        timestamp: "2026-07-19T00:02:00Z",
        payload: {
          type: "agent_message",
          message: "Message Type: FINAL_ANSWER\nTask name: worker\nPayload:\ndone"
        }
      }
    ]
  };

  const protocol = buildCodexSessionProtocol({
    session: session("root"),
    messages: [],
    records,
    children: [child]
  });

  assert.equal(protocol.tasks[0].status, "completed");
  assert.equal(protocol.agentRuns[0].status, "completed");
  assert.equal(protocol.agentRuns[0].timeEnd, Date.parse("2026-07-19T00:02:00Z"));
});

test("Codex spawn calls without any completion evidence stay running", () => {
  const callId = "call_g000";
  const records = [
    { type: "session_meta", timestamp: "2026-07-19T00:00:00Z", payload: { id: "root" } },
    { type: "response_item", timestamp: "2026-07-19T00:01:00Z", payload: { type: "function_call", call_id: callId, name: "task", arguments: "{}" } }
  ];
  const protocol = buildCodexSessionProtocol({
    session: session("root"),
    messages: [],
    records,
    children: []
  });
  assert.equal(protocol.tasks.length, 1);
  assert.equal(protocol.tasks[0].status, "running", "no evidence, no invented completion");
  assert.equal(protocol.tasks[0].provenance.fidelity, "derived");
  assert.equal(protocol.agentRuns.length, 0);
});

test("Codex envelopes and spawn evidence coexist without duplicate runs", () => {
  const envelope = (id) => ({
    type: "response_item",
    timestamp: "2026-07-19T00:01:00Z",
    payload: {
      type: "agent_message",
      id,
      content: [{ type: "text", text: "Message Type: NEW_TASK\n\nTask name: reviewer" }]
    }
  });
  const callId = "call_g999";
  const records = [
    { type: "session_meta", timestamp: "2026-07-19T00:00:00Z", payload: { id: "root" } },
    envelope("task-1"),
    { type: "response_item", timestamp: "2026-07-19T00:02:00Z", payload: { type: "function_call", call_id: callId, name: "task", arguments: "{}" } },
    {
      type: "event_msg",
      timestamp: "2026-07-19T00:02:01Z",
      payload: {
        type: "sub_agent_activity",
        event_id: callId,
        agent_thread_id: "child-2",
        agent_path: "/root/coder",
        kind: "started"
      }
    },
    { type: "response_item", timestamp: "2026-07-19T00:02:02Z", payload: { type: "function_call_output", call_id: callId, output: "done" } }
  ];
  const childOne = {
    session: session("child-1", "root", { agentPath: "/root/reviewer", agentNickname: "reviewer" }, 2000),
    messages: [],
    records: [
      { type: "session_meta", timestamp: "2026-07-19T00:00:30Z", payload: { id: "child-1" } },
      { type: "response_item", timestamp: "2026-07-19T00:00:31Z", payload: { type: "agent_message", id: "task-1", content: [{ type: "text", text: "Message Type: NEW_TASK\n\nTask name: reviewer" }] } }
    ]
  };
  const childTwo = {
    session: session("child-2", "root", { agentPath: "/root/coder" }, 3000),
    messages: [],
    records: [{ type: "session_meta", timestamp: "2026-07-19T00:00:40Z", payload: { id: "child-2" } }]
  };
  const protocol = buildCodexSessionProtocol({
    session: session("root"),
    messages: [],
    records,
    children: [childOne, childTwo]
  });
  assert.equal(protocol.tasks.length, 2, "envelope task and spawn task both represented");
  assert.equal(protocol.agentRuns.length, 2);
  assert.equal(new Set(protocol.agentRuns.map((run) => run.childSessionId)).size, 2, "no duplicate runs per child");
  assert.ok(protocol.agentRuns.every((run) => run.taskId), "every run binds to a task");
  const byChild = new Map(protocol.agentRuns.map((run) => [run.childSessionId, run]));
  assert.equal(byChild.get("child-1").taskId, "task-1");
  assert.equal(byChild.get("child-2").taskId, callId);
});

test("Codex spawn-bound children render under the launch tool call in source order", () => {
  const callId = "call_g456";
  const parentMessages = [
    { ...message("m0", "user", 1000), content: "Do it" },
    { ...message("m1", "assistant", 1100), content: "Launching worker", metadata: { turnId: "r1" } },
    {
      ...message(callId, "tool", 1200),
      toolName: "task",
      toolInput: { description: "review" },
      toolOutput: JSON.stringify({ thread_id: "child-1" }),
      metadata: { turnId: "r1", callId }
    },
    { ...message("m3", "assistant", 5000), content: "Worker returned", metadata: { turnId: "r2" } }
  ];
  const childMessages = [
    { ...message("c0", "user", 1300), content: "child task" },
    { ...message("c1", "assistant", 1400), content: "child answer", metadata: { turnId: "cr1" } }
  ];
  const records = [
    { type: "session_meta", timestamp: "2026-07-19T00:00:00Z", payload: { id: "root" } },
    { type: "response_item", timestamp: "2026-07-19T00:01:00Z", payload: { type: "function_call", call_id: callId, name: "task", arguments: "{}" } },
    {
      type: "event_msg",
      timestamp: "2026-07-19T00:01:01Z",
      payload: {
        type: "sub_agent_activity",
        event_id: callId,
        agent_thread_id: "child-1",
        agent_path: "/root/worker",
        kind: "started"
      }
    },
    { type: "response_item", timestamp: "2026-07-19T00:01:02Z", payload: { type: "function_call_output", call_id: callId, output: "done" } }
  ];
  const child = {
    session: session("child-1", "root", { agentPath: "/root/worker" }, 1300),
    messages: childMessages,
    records: [{ type: "session_meta", timestamp: "2026-07-19T00:00:30Z", payload: { id: "child-1" } }]
  };
  const protocol = buildCodexSessionProtocol({
    session: session("root"),
    messages: parentMessages,
    records,
    children: [child]
  });

  const views = buildLinkedMessageSessionViews("root", [
    { session: session("root"), messages: parentMessages },
    { session: child.session, messages: childMessages }
  ], {
    tasks: protocol.tasks,
    agentRuns: protocol.agentRuns,
    relationships: protocol.relationships
  });
  const tree = views.tree;
  assert.equal(tree.detachedChildren.length, 0, "child is not detached at the end");
  // Launch turn (assistant + spawn tool part) carries the child.
  const launchTurn = tree.messages[1];
  const toolPart = launchTurn.parts.find((part) => part.type === "tool");
  assert.ok(toolPart, "spawn tool part exists on the launch turn");
  assert.equal(toolPart.childSessions.length, 1);
  assert.equal(toolPart.childSessions[0].session.id, "child-1");
  // The completion turn never absorbs the child: it stays at launch position.
  const completionTurn = tree.messages[2];
  assert.ok(completionTurn.parts.every((part) => part.childSessions.length === 0));
  // Child internal messages keep their own source order.
  assert.deepEqual(
    toolPart.childSessions[0].messages.map((m) => m.id),
    ["c0", "c1"]
  );
  assert.equal(views.metrics.totals.branches, 1);
});

test("Codex compaction helper recognizes every variant including opaque payload types", () => {
  const variant = (record) => Boolean(codexCompactionRecord(record));
  assert.equal(variant({ type: "compacted", payload: {} }), true);
  assert.equal(variant({ type: "context_compacted", payload: {} }), true);
  assert.equal(variant({ type: "contextCompaction", payload: {} }), true);
  assert.equal(variant({ type: "event_msg", payload: { type: "compacted" } }), true);
  assert.equal(variant({ type: "event_msg", payload: { type: "token_count" } }), false);
  assert.equal(variant({ type: "response_item" }), false);
  const opaque = codexCompactionRecord({ type: "compacted", payload: { tokens_before: 42 } });
  assert.equal(opaque.strategy, "opaque");
  assert.equal(opaque.summary, null);
  assert.equal(opaque.tokensBefore, 42);
});

test("Codex interleaves a compaction record between messages in source order", () => {
  const records = [
    { type: "event_msg", timestamp: "2026-07-19T00:10:00Z", payload: { type: "user_message", message: "Build the thing" } },
    { type: "response_item", timestamp: "2026-07-19T00:10:01Z", payload: { type: "message", id: "m1", role: "assistant", content: [{ type: "text", text: "Starting" }] } },
    // Compaction record sits BETWEEN the two assistant responses but its
    // timestamp is EARLIER than both: sequence must still follow record order.
    { type: "compacted", timestamp: "2026-07-19T00:09:00Z", payload: { tokens_before: 500 } },
    { type: "response_item", timestamp: "2026-07-19T00:10:02Z", payload: { type: "message", id: "m2", role: "assistant", content: [{ type: "text", text: "Done" }] } }
  ];
  const protocol = buildCodexSessionProtocol({
    session: session("root"),
    messages: [
      { ...message("msg-0", "user", Date.parse("2026-07-19T00:10:00Z")), content: "Build the thing" },
      { ...message("m1", "assistant", Date.parse("2026-07-19T00:10:01Z")), content: "Starting" },
      { ...message("m2", "assistant", Date.parse("2026-07-19T00:10:02Z")), content: "Done" }
    ],
    records,
    children: []
  });
  const byKind = new Map(protocol.events.map((event) => [event.kind, event]));
  const userEvent = byKind.get("message.user");
  const [m1Event, m2Event] = protocol.events.filter((event) => event.kind === "message.assistant");
  const compactionEvent = byKind.get("context.compaction");
  assert.ok(userEvent && m1Event && m2Event && compactionEvent);
  // Source order: user record (0), m1 record (1), compaction record (2), m2 record (3).
  assert.deepEqual(
    protocol.events.map((event) => event.id),
    [userEvent.id, m1Event.id, compactionEvent.id, m2Event.id]
  );
  assert.deepEqual(protocol.events.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.equal(compactionEvent.sequence, 3);
  assert.equal(compactionEvent.providerData.sourceSequence, 2000, "record index 2, ordinal 0");
  // Timestamps are carried as-is and are inverted relative to sequences.
  assert.equal(compactionEvent.timestamp, Date.parse("2026-07-19T00:09:00Z"));
  assert.equal(m1Event.timestamp, Date.parse("2026-07-19T00:10:01Z"));
  assert.equal(compactionEvent.timestamp < m1Event.timestamp, true, "earlier timestamp, later sequence");
  // The normalized user message content-matched its event_msg record.
  assert.equal(userEvent.providerData.sourceSequence, 0);
});

test("Codex forked lineage yields a forked relationship with derived provenance", () => {
  const records = [
    { type: "session_meta", timestamp: "2026-07-19T00:00:00Z", payload: { id: "fork-child", forked_from_id: "origin" } }
  ];
  const protocol = buildCodexSessionProtocol({
    session: session("fork-child", "origin"),
    messages: [],
    records,
    children: []
  });
  assert.equal(protocol.relationships.length, 1);
  assert.equal(protocol.relationships[0].type, "forked");
  assert.equal(protocol.relationships[0].fromSessionId, "origin");
  assert.equal(protocol.relationships[0].toSessionId, "fork-child");
  assert.equal(protocol.relationships[0].provenance.fidelity, "derived");
});

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

test("Claude task notifications become Tasks and AgentRuns while keeping Message compatibility", () => {
  const notificationRecord = {
    type: "user",
    uuid: "notif-1",
    timestamp: "2026-07-19T00:05:00Z",
    message: {
      content: [{
        type: "text",
        text: "<task-notification><task-id>claude-agent-1</task-id><tool-use-id>agent-call</tool-use-id><status>completed</status><summary>Review complete</summary></task-notification>"
      }]
    }
  };
  const records = [notificationRecord];
  const child = {
    session: session("child-sidechain", null, { agentId: "claude-agent-1" }, 2000),
    messages: [message("child-msg", "assistant", 2100)],
    records: [{ isSidechain: true, agentId: "claude-agent-1", sessionId: "parent-session" }]
  };
  const protocol = buildClaudeSessionProtocol({
    session: session("parent-session", null, null, 1000),
    messages: [message("m1", "tool", 600)],
    records,
    children: [child]
  });

  assert.equal(protocol.tasks.length, 1);
  const task = protocol.tasks[0];
  assert.equal(task.id, "claude-agent-1");
  assert.equal(task.status, "completed");
  assert.equal(task.mode, undefined, "execution mode belongs to AgentRun, not Task");
  assert.equal(task.toolCallId, "agent-call");
  assert.equal(task.provenance.fidelity, "recorded");

  assert.equal(protocol.agentRuns.length, 1);
  const run = protocol.agentRuns[0];
  assert.equal(run.taskId, "claude-agent-1");
  assert.equal(run.childSessionId, "child-sidechain");
  assert.equal(run.status, "completed");

  const taskEvent = protocol.events.find((event) => event.kind === "task");
  assert.equal(taskEvent.phase, "completed");
  assert.equal(taskEvent.correlationId, "agent-call");
  assert.equal(taskEvent.provenance.fidelity, "recorded");
  // The tool message remains the read view.
  assert.equal(protocol.events.some((event) => event.kind === "message.tool"), true);
});

test("Claude compact, PreCompact, and PostCompact records become compaction events", () => {
  const records = [
    {
      type: "compact",
      compactUuid: "compact-1",
      timestamp: "2026-07-19T00:05:00Z",
      summary: "Conversation was compacted manually."
    },
    {
      type: "PreCompact",
      compactUuid: "compact-2",
      timestamp: "2026-07-19T00:06:00Z"
    },
    {
      type: "PostCompact",
      compactUuid: "compact-2",
      timestamp: "2026-07-19T00:06:01Z",
      summary: "data:application/octet-stream;base64,AAAA"
    },
    { type: "auto_compact", compactUuid: "compact-3", timestamp: "2026-07-19T00:07:00Z" }
  ];
  const protocol = buildClaudeSessionProtocol({
    session: session("s1"),
    messages: [],
    records,
    children: []
  });
  const compactionEvents = protocol.events.filter((event) => event.kind === "context.compaction");
  assert.equal(compactionEvents.length, 4);
  const [summary, pre, post, auto] = compactionEvents;
  assert.equal(summary.compaction.strategy, "summary");
  assert.equal(summary.compaction.summary, "Conversation was compacted manually.");
  assert.equal(summary.compaction.trigger, "manual");
  assert.equal(pre.compaction.strategy, "opaque");
  assert.equal(pre.compaction.summary, null);
  assert.equal(post.compaction.strategy, "opaque", "encoded payload is not a readable summary");
  assert.equal(auto.compaction.trigger, "automatic");
  assert.equal(protocol.contextArtifacts.length, 4);
  assert.ok(protocol.contextArtifacts.every((artifact) => (
    artifact.contentAccess === "metadata-only"
    && artifact.summary === null
    && artifact.kind === "summary"
    && artifact.origin === "provider-generated"
  )));
  assert.equal(
    protocol.contextArtifacts.find((artifact) => artifact.metadata.compactUuid === "compact-2").metadata.recordType,
    "PreCompact"
  );
  assert.equal(
    protocol.events.some((event) => isContextLifecycleEventKind(event.kind)),
    false
  );
});

test("Claude sidechain records yield spawned relationships with recorded provenance", () => {
  const records = [
    { isSidechain: true, agentId: "agent-abc", sessionId: "parent-session" },
    { type: "user", uuid: "u1", timestamp: "2026-07-19T00:01:00Z", message: { content: [{ type: "text", text: "hi" }] } }
  ];
  const protocol = buildClaudeSessionProtocol({
    session: session("agent-abc", "parent-session", { agentId: "agent-abc" }, 1000),
    messages: [message("m1", "user", 1100)],
    records,
    children: []
  });
  assert.equal(protocol.relationships.length, 1);
  assert.equal(protocol.relationships[0].type, "spawned");
  assert.equal(protocol.relationships[0].fromSessionId, "parent-session");
  assert.equal(protocol.relationships[0].toSessionId, "agent-abc");
  assert.equal(protocol.relationships[0].provenance.fidelity, "recorded");
});

// ---------------------------------------------------------------------------
// Pi
// ---------------------------------------------------------------------------

test("Pi compaction and branch_summary become context.compaction events with metadata-only artifacts", () => {
  const records = [
    { type: "session", version: 3, id: "pi-session", timestamp: "2026-07-19T01:00:00.000Z", cwd: "D:\\WorkSpace" },
    {
      type: "compaction",
      id: "compact1",
      parentId: "asst0002",
      timestamp: "2026-07-19T01:00:06.000Z",
      summary: "Earlier Pi work was compacted.",
      firstKeptEntryId: "user0002",
      tokensBefore: 2000
    },
    {
      type: "branch_summary",
      id: "branch1",
      parentId: "user0001",
      timestamp: "2026-07-19T01:00:07.000Z"
    }
  ];
  const protocol = buildPiSessionProtocol({
    session: session("pi-session", "019f7a00-0000-7000-8000-000000000000"),
    records,
    messages: []
  });
  const compactionEvents = protocol.events.filter((event) => event.kind === "context.compaction");
  assert.equal(compactionEvents.length, 2);
  const [compaction, branch] = compactionEvents;
  assert.equal(compaction.compaction.strategy, "summary");
  assert.equal(compaction.compaction.tokensBefore, 2000);
  assert.equal(compaction.compaction.retainedFromEventId, "user0002");
  assert.equal(compaction.compaction.trigger, "unknown");
  assert.equal(compaction.provenance.fidelity, "recorded");
  assert.equal(branch.compaction.strategy, "opaque");
  assert.equal(branch.provenance.sourceType, "pi.entry:branch_summary");

  assert.equal(protocol.tasks.length, 0);
  assert.equal(protocol.agentRuns.length, 0);
  assert.equal(protocol.contextArtifacts.length, 2);
  for (const artifact of protocol.contextArtifacts) {
    assert.equal(artifact.kind, "summary");
    assert.equal(artifact.scope, "session");
    assert.equal(artifact.origin, "provider-generated");
    assert.equal(artifact.contentAccess, "metadata-only");
    assert.equal(artifact.summary, null, "artifact never duplicates transcript text");
    assert.equal(artifact.redacted, true);
    assert.deepEqual(artifact.sourceSessionIds, ["pi-session"]);
  }
  assert.equal(
    protocol.events.some((event) => isContextLifecycleEventKind(event.kind)),
    false,
    "branch summaries and compaction never fabricate lifecycle events"
  );
  assert.equal(piCompactionEntry({ type: "message" }), null);
  assert.equal(piCompactionEntry({ type: "compaction" }).strategy, "opaque");
});

test("Pi parentSession yields a derived parent relationship, never a subagent claim", () => {
  const records = [
    { type: "session", version: 3, id: "pi-session", parentSession: "D:\\Sessions\\old.jsonl", timestamp: "2026-07-19T01:00:00.000Z" }
  ];
  const protocol = buildPiSessionProtocol({
    session: session("pi-session", "019f7a00-0000-7000-8000-000000000000"),
    records,
    messages: []
  });
  assert.equal(protocol.relationships.length, 1);
  const relationship = protocol.relationships[0];
  assert.equal(relationship.type, "parent");
  assert.equal(relationship.provenance.fidelity, "derived");
  assert.equal(relationship.fromSessionId, "019f7a00-0000-7000-8000-000000000000");
  assert.match(relationship.details, /rotation or explicit fork/);
  assert.ok(!relationship.type.includes("spawn"), "not a subagent claim");
});

// ---------------------------------------------------------------------------
// Hermes
// ---------------------------------------------------------------------------

function hermesEntry(id, parentId = null, compressionParentId = null, source = "cli", title = id) {
  return {
    session: {
      id,
      provider: "hermes",
      parentId,
      title,
      directory: null,
      timeCreated: 1000,
      timeUpdated: 1100,
      messageCount: 1,
      tokenCount: null,
      metadata: {
        source,
        model: "deepseek-v4-flash",
        endReason: compressionParentId ? "compression" : "stop",
        compressionParentId,
        billingProvider: null
      }
    },
    messages: [message(`${id}-msg`, "assistant", 1050)],
    rawSession: { id, end_reason: compressionParentId ? "compression" : "stop" }
  };
}

test("Hermes compression lineage becomes compacted-into relationships and compaction events", () => {
  const root = hermesEntry("hermes-root");
  const continuation = hermesEntry("hermes-continuation", null, "hermes-root");
  const protocol = buildHermesSessionProtocol({
    ...root,
    family: [root, continuation]
  });

  const relationships = protocol.relationships.filter((relationship) => relationship.type === "compacted-into");
  assert.equal(relationships.length, 1);
  assert.equal(relationships[0].fromSessionId, "hermes-root");
  assert.equal(relationships[0].toSessionId, "hermes-continuation");
  assert.equal(relationships[0].provenance.fidelity, "derived");
  assert.equal(relationships[0].correlationId, "hermes-continuation");

  const compactionEvents = protocol.events.filter((event) => event.kind === "context.compaction");
  assert.equal(compactionEvents.length, 1);
  assert.equal(compactionEvents[0].compaction.strategy, "opaque");
  assert.equal(compactionEvents[0].compaction.trigger, "automatic");
  assert.equal(compactionEvents[0].compaction.continuationSessionId, "hermes-continuation");
  assert.equal(compactionEvents[0].provenance.fidelity, "derived");

  assert.equal(protocol.tasks.length, 0, "compression continuations are never tasks");
  assert.equal(protocol.contextArtifacts.length, 1);
  const artifact = protocol.contextArtifacts[0];
  assert.equal(artifact.kind, "summary");
  assert.equal(artifact.scope, "session");
  assert.equal(artifact.origin, "provider-generated");
  assert.equal(artifact.contentAccess, "metadata-only");
  assert.equal(artifact.summary, null);
  assert.deepEqual(artifact.sourceSessionIds, ["hermes-root"]);
  assert.equal(artifact.lifecycle, undefined, "lifecycle is not an artifact field");
  assert.equal(artifact.contentRef, undefined);
  assert.equal(artifact.metadata.continuationSessionId, "hermes-continuation");
  assert.equal(
    protocol.events.some((event) => isContextLifecycleEventKind(event.kind)),
    false,
    "compression is context.compaction, not a memory lifecycle observation"
  );

  // The continuation's own protocol names the edge too.
  const continuationProtocol = buildHermesSessionProtocol({
    ...continuation,
    family: [root, continuation]
  });
  assert.equal(continuationProtocol.relationships.some((relationship) => (
    relationship.type === "compacted-into"
    && relationship.fromSessionId === "hermes-root"
    && relationship.toSessionId === "hermes-continuation"
  )), true);
  // No outgoing edge: no compaction event on the continuation.
  assert.equal(
    continuationProtocol.events.filter((event) => event.kind === "context.compaction").length,
    0
  );
});

test("Hermes delegates yield spawned relationships plus Task and AgentRun pairs", () => {
  const root = hermesEntry("hermes-root");
  const delegate = hermesEntry("hermes-delegate", "hermes-root", null, "delegate", "Review delegate");
  const protocol = buildHermesSessionProtocol({
    ...root,
    family: [root, delegate]
  });

  const spawned = protocol.relationships.filter((relationship) => relationship.type === "spawned");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].fromSessionId, "hermes-root");
  assert.equal(spawned[0].toSessionId, "hermes-delegate");
  assert.equal(spawned[0].provenance.sourceType, "hermes.model_config._delegate_from");

  assert.equal(protocol.tasks.length, 1);
  assert.equal(protocol.tasks[0].kind, "delegate");
  assert.equal(protocol.tasks[0].status, "completed");
  assert.equal(protocol.tasks[0].mode, undefined, "execution mode belongs to AgentRun, not Task");
  assert.equal(protocol.tasks[0].dependencies.length, 0);
  assert.equal(protocol.tasks[0].assignee, null);
  assert.equal(protocol.agentRuns.length, 1);
  assert.equal(protocol.agentRuns[0].childSessionId, "hermes-delegate");
  assert.equal(protocol.agentRuns[0].taskId, "hermes-delegate");
  assert.equal(protocol.agentRuns[0].model, "deepseek-v4-flash");
  // Delegates are not compaction: no artifacts, no compaction events.
  assert.equal(protocol.contextArtifacts.length, 0);
  assert.equal(protocol.events.some((event) => event.kind === "context.compaction"), false);
});

test("Claude interleaves a compact record between messages in source order", () => {
  const records = [
    { type: "user", uuid: "u1", timestamp: "2026-07-19T00:10:00Z", message: { content: [{ type: "text", text: "hello" }] } },
    // Compact record between the user and assistant records, with an EARLIER
    // timestamp: sequence must still follow record order.
    { type: "compact", compactUuid: "c1", timestamp: "2026-07-19T00:09:00Z", summary: "Squashed." },
    { type: "assistant", uuid: "a1", timestamp: "2026-07-19T00:10:01Z", message: { content: [{ type: "text", text: "hi back" }] } }
  ];
  const protocol = buildClaudeSessionProtocol({
    session: session("s1"),
    messages: [
      message("u1", "user", Date.parse("2026-07-19T00:10:00Z")),
      message("a1:0", "assistant", Date.parse("2026-07-19T00:10:01Z"))
    ],
    records,
    children: []
  });
  const compactionEvent = protocol.events.find((event) => event.kind === "context.compaction");
  const userEvent = protocol.events.find((event) => event.kind === "message.user");
  const assistantEvent = protocol.events.find((event) => event.kind === "message.assistant");
  assert.ok(compactionEvent && userEvent && assistantEvent);
  assert.deepEqual(
    protocol.events.map((event) => event.id),
    [userEvent.id, compactionEvent.id, assistantEvent.id]
  );
  assert.deepEqual(protocol.events.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(compactionEvent.providerData.sourceSequence, 1000, "record index 1");
  assert.equal(compactionEvent.timestamp, Date.parse("2026-07-19T00:09:00Z"));
  assert.equal(userEvent.timestamp, Date.parse("2026-07-19T00:10:00Z"));
  assert.equal(compactionEvent.timestamp < userEvent.timestamp, true, "earlier timestamp, later sequence");
  assert.equal(assistantEvent.providerData.sourceSequence, 2000, "assistant text block resolved via uuid prefix");
});

test("Pi interleaves a compaction entry between messages in source order", () => {
  const records = [
    { type: "session", version: 3, id: "pi-session", timestamp: "2026-07-19T01:00:00.000Z" },
    { type: "message", id: "user0001", parentId: null, timestamp: "2026-07-19T01:00:04.000Z", message: { role: "user", content: [{ type: "text", text: "Go" }], timestamp: 400 } },
    // Compaction entry between the user and assistant entries, with an
    // EARLIER timestamp: sequence must still follow entry order.
    { type: "compaction", id: "compact1", parentId: "user0001", timestamp: "2026-07-19T01:00:01.000Z", summary: "Squashed.", firstKeptEntryId: "user0001", tokensBefore: 500 },
    { type: "message", id: "asst0001", parentId: "compact1", timestamp: "2026-07-19T01:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 500 } }
  ];
  const protocol = buildPiSessionProtocol({
    session: session("pi-session"),
    records,
    messages: [
      message("user0001", "user", Date.parse("2026-07-19T01:00:04.000Z")),
      message("compact1", "system", Date.parse("2026-07-19T01:00:01.000Z")),
      message("asst0001", "assistant", Date.parse("2026-07-19T01:00:05.000Z"))
    ]
  });
  const compactionEvent = protocol.events.find((event) => event.kind === "context.compaction");
  const userEvent = protocol.events.find((event) => event.kind === "message.user");
  const systemEvent = protocol.events.find((event) => event.kind === "message.system");
  const assistantEvent = protocol.events.find((event) => event.kind === "message.assistant");
  assert.ok(compactionEvent && userEvent && systemEvent && assistantEvent);
  assert.deepEqual(
    protocol.events.map((event) => event.id),
    [userEvent.id, compactionEvent.id, systemEvent.id, assistantEvent.id],
    "entry order with the compaction's system message after its compaction event"
  );
  assert.deepEqual(protocol.events.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.equal(compactionEvent.providerData.sourceSequence, 2000, "entry index 2, ordinal 0");
  assert.equal(systemEvent.providerData.sourceSequence, 2001, "same entry, ordinal 1");
  assert.equal(compactionEvent.timestamp, Date.parse("2026-07-19T01:00:01.000Z"));
  assert.equal(userEvent.timestamp, Date.parse("2026-07-19T01:00:04.000Z"));
  assert.equal(compactionEvent.timestamp < userEvent.timestamp, true, "earlier timestamp, later sequence");
});

test("Hermes places compression boundary events after the compacted session's message rows", () => {
  const rootMessages = [
    { ...message("5", "user", 1000), id: "5" },
    // Row id 7 with an EARLIER timestamp: row order still wins.
    { ...message("7", "assistant", 900), id: "7" }
  ];
  const root = { ...hermesEntry("hermes-root"), messages: rootMessages };
  const continuation = hermesEntry("hermes-continuation", null, "hermes-root");
  const protocol = buildHermesSessionProtocol({
    ...root,
    family: [root, continuation]
  });
  const compactionEvent = protocol.events.find((event) => event.kind === "context.compaction");
  const messageEvents = protocol.events.filter((event) => event.kind.startsWith("message."));
  assert.equal(messageEvents.length, 2);
  assert.ok(compactionEvent);
  assert.deepEqual(
    protocol.events.map((event) => event.id),
    [...messageEvents.map((event) => event.id), compactionEvent.id],
    "compaction boundary follows the last message row"
  );
  assert.deepEqual(protocol.events.map((event) => event.sequence), [1, 2, 3], "gap-free 1..n");
  assert.equal(compactionEvent.providerData.sourceSequence, 8000, "row 7 + 1, ordinal 0");
  assert.equal(compactionEvent.compaction.continuationSessionId, "hermes-continuation");
  assert.equal(messageEvents[1].timestamp < messageEvents[0].timestamp, true, "row order wins over timestamps");
});

// ---------------------------------------------------------------------------
// Task vs AgentRun separation and shared flow consumption
// ---------------------------------------------------------------------------

test("Task and AgentRun stay separated: tasks carry no run state, runs own execution mode", () => {
  const task = sessionTask({
    id: "t1",
    sessionId: "s1",
    kind: "subagent-task",
    status: "completed",
    title: null,
    toolCallId: "call-1",
    dependencies: ["t0", "t0"],
    assignee: "reviewer",
    timeCreated: 100,
    timeUpdated: 200,
    timeCompleted: 200,
    provenance: recorded("fixture")
  });
  const run = agentRun({
    id: "run-1",
    sessionId: "s1",
    taskId: "t1",
    status: "completed",
    mode: "subagent",
    agent: "reviewer",
    model: "gpt-5",
    childSessionId: "child-1",
    timeStart: 100,
    timeEnd: 200,
    provenance: derived("fixture")
  });
  assert.equal(task.childSessionId, undefined, "tasks must not reference a session");
  assert.equal(task.agent, undefined, "tasks must not carry run identity");
  assert.equal(task.mode, undefined, "execution mode is not a Task field");
  assert.deepEqual(task.dependencies, ["t0"], "duplicate dependencies are normalized");
  assert.equal(task.assignee, "reviewer");
  assert.equal(run.taskId, "t1");
  assert.equal(run.childSessionId, "child-1");
  assert.equal(run.mode, "subagent", "execution mode belongs to AgentRun");
  // One task, two runs: runs carry the per-execution facts.
  const secondRun = { ...run, id: "run-2", childSessionId: "child-2", status: "failed", mode: "background" };
  assert.equal(secondRun.taskId, task.id);
  assert.equal(secondRun.mode, "background");
  assert.equal(task.status, "completed", "task status survives independent runs");
});

test("shared subagent attachment consumes Task and AgentRun evidence without provider branching", () => {
  const parentBundle = {
    session: session("parent", null, null, 1000),
    messages: [{
      id: "spawn-tool",
      sessionId: "parent",
      role: "tool",
      content: "",
      thinking: null,
      toolName: "custom_launcher",
      toolInput: { task_name: "/root/reviewer" },
      toolOutput: null,
      timestamp: 1500,
      tokens: null,
      metadata: { turnId: "parent:turn", callId: "spawn-tool" }
    }]
  };
  const childBundle = {
    session: session("child", "parent", { agentPath: "/root/reviewer" }, 2000),
    messages: [message("child-answer", "assistant", 2100)]
  };
  const task = sessionTask({
    id: "task-1",
    sessionId: "parent",
    kind: "subagent-task",
    status: "completed",
    title: null,
    toolCallId: "spawn-tool",
    timeCreated: 1500,
    timeUpdated: 2100,
    timeCompleted: 2100,
    provenance: recorded("fixture")
  });
  const run = agentRun({
    id: "child",
    sessionId: "parent",
    taskId: "task-1",
    status: "completed",
    mode: "subagent",
    agent: "reviewer",
    model: null,
    childSessionId: "child",
    timeStart: 2000,
    timeEnd: 2100,
    provenance: derived("fixture")
  });
  const relationship = sessionRelationship({
    type: "spawned",
    fromSessionId: "parent",
    toSessionId: "child",
    correlationId: "spawn-tool",
    provenance: recorded("fixture")
  });

  const views = buildLinkedMessageSessionViews("parent", [parentBundle, childBundle], {
    tasks: [task],
    agentRuns: [run],
    relationships: [relationship]
  });
  const part = views.tree.messages[0].parts[0];
  assert.equal(part.childSessions[0].session.id, "child");
  assert.equal(views.tree.detachedChildren.length, 0);
  assert.equal(views.metrics.totals.branches, 1);
  assert.equal(part.inferredChildSessionIds, undefined, "evidence attach is not inferred");
  // The custom launcher part is now classified as a subagent from protocol
  // evidence, without any provider-id branch.
  assert.equal(part.data.state.metadata.subagent, true);
});

test("non-spawned relationships never attach children and never fabricate tasks", () => {
  const parentBundle = {
    session: session("parent", null, null, 1000),
    messages: [message("m1", "assistant", 1100)]
  };
  const childBundle = {
    session: session("child", "parent", null, 2000),
    messages: [message("child-answer", "assistant", 2100)]
  };
  // A continued lineage is NOT a subagent claim: with no task part, the child
  // stays detached and no task/run is fabricated.
  const relationship = sessionRelationship({
    type: "continued",
    fromSessionId: "parent",
    toSessionId: "child",
    provenance: derived("fixture")
  });
  const views = buildLinkedMessageSessionViews("parent", [parentBundle, childBundle], {
    relationships: [relationship]
  });
  assert.equal(views.tree.detachedChildren.length, 1);
  assert.equal(views.tree.messages[0].parts[0].childSessions.length, 0);
  assert.equal(relationship.type, "continued");
  // The protocol surface itself never claims a subagent either.
  const protocol = buildPiSessionProtocol({
    session: session("pi-session", "019f7a00-0000-7000-8000-000000000000"),
    records: [{ type: "session", version: 3, id: "pi-session", parentSession: "D:\\Sessions\\old.jsonl", timestamp: "2026-07-19T01:00:00.000Z" }],
    messages: []
  });
  assert.equal(protocol.tasks.length, 0);
  assert.equal(protocol.agentRuns.length, 0);
  assert.equal(protocol.relationships[0].type, "parent");
});
