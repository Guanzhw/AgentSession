import assert from "node:assert/strict";
import test from "node:test";

import { createReaderNativeSourceResolver, deriveReaderRelations } from "../dist/src/reader-relations.js";

const provenance = { fidelity: "recorded", sourceType: "fixture" };

function event(sequence, fields = {}) {
  return { id: `event:${sequence}`, sessionId: "root", sequence, timestamp: 1000 - sequence,
    kind: "control", normalizedKind: "control", provenance, ...fields };
}

function observation(sequence, kind, fields = {}) {
  return { id: `observation:${sequence}`, sessionId: "root", kind, timestamp: sequence % 2 ? 9999 : null,
    runId: "run-first", eventId: `event:${sequence}`, turnId: "not-a-message", provenance, ...fields };
}

function run(id, childSessionId = "child", fields = {}) {
  return { id, sessionId: "root", taskId: null, status: "completed", mode: "subagent", agent: "worker",
    model: null, childSessionId, timeStart: 1, timeEnd: 2, provenance, ...fields };
}

function protocol(fields = {}) {
  return { version: 3, sessionId: "root", session: { ref: { provider: "fixture", sessionId: "root" } },
    events: [], relationships: [], tasks: [], agentRuns: [run("run-first")], contextArtifacts: [], branches: [],
    goals: [], actors: [], coordination: [], contextVersions: [], contextTransformations: [], usageRecords: [],
    coverage: {}, ...fields };
}

function documentOf(groups) {
  return {
    messages: groups.map(([id]) => ({ id })),
    partsByMessage: new Map(groups.map(([id, parts]) => [id, parts.map(([partId, type = "tool"]) => ({
      id: partId, data: type === "tool" ? { type, tool: "fixture", state: {} } : { type, text: partId }
    }))]))
  };
}

function repeatedBranch() {
  const events = Array.from({ length: 146 }, (_, index) => event(index + 1));
  const at = (sequence, fields) => { events[sequence - 1] = event(sequence, fields); };
  at(45, { messageId: "dispatch", toolCallId: "spawn-part" });
  at(70, { messageId: "follow-a", toolCallId: "recorded-call-a" });
  at(134, { messageId: "shared-message", toolCallId: "before-return" });
  at(137, { messageId: "shared-message", toolCallId: "after-return" });
  at(140, { messageId: "shared-message", toolCallId: "follow-b" });
  at(143, { messageId: "shared-message", toolCallId: "before-return-b" });
  at(146, { messageId: "final-message", normalizedKind: "message.assistant" });
  return {
    protocol: protocol({ events, coordination: [
      observation(45, "spawn"), observation(70, "follow-up"), observation(140, "follow-up"),
      observation(136, "result-delivery"), observation(144, "result-delivery")
    ] }),
    document: documentOf([
      ["dispatch", [["spawn-part"]]],
      ["shared-message", [["follow-a"], ["before-return"], ["after-return"], ["follow-b"], ["before-return-b"]]],
      ["final-message", [["final-part", "text"]]]
    ])
  };
}

test("reader source navigation and inline positions share exact normalized part identities", () => {
  const resolve = createReaderNativeSourceResolver(documentOf([
    ["owner", [["text:with.punctuation", "text"], ["tool-one"], ["tool-two"]]],
    ["single-tool-message", [["opaque:tool"]]]
  ]));
  assert.deepEqual(resolve({ messageId: "text:with.punctuation", normalizedKind: "message.assistant" }).position,
    { messageId: "owner", partId: "text:with.punctuation", side: "before" });
  assert.equal(resolve({ messageId: "owner", toolCallId: "tool-two" }).position.partId, "tool-two");
  assert.equal(resolve({ toolCallId: "tool-one" }).position.partId, "tool-one");
  assert.equal(resolve({ messageId: "owner", toolCallId: "unknown-tool" }), null,
    "an ambiguous multi-tool message cannot select its first tool as the source");
  assert.equal(resolve({ messageId: "single-tool-message", toolCallId: "raw-call" }).position.partId, "opaque:tool");
  assert.equal(resolve({ messageId: "missing", toolCallId: "raw-call" }), null);
});

test("reader native sources prefer explicit part identity and scope real call IDs to their message", () => {
  const document = documentOf([
    ["first-message", [["first-text", "text"], ["first-tool"], ["second-tool"], ["later-text", "text"]]],
    ["other-message", [["other-tool"]]]
  ]);
  document.partsByMessage.get("first-message")[1].data.callID = "first-call";
  document.partsByMessage.get("first-message")[2].data.callID = "repeated-call";
  document.partsByMessage.get("other-message")[0].data.callID = "repeated-call";
  const resolve = createReaderNativeSourceResolver(document);
  assert.deepEqual(resolve({ partId: "later-text", messageId: "first-message", normalizedKind: "message.assistant" }).position,
    { messageId: "first-message", partId: "later-text", side: "before" });
  assert.equal(resolve({ partId: "second-tool", messageId: "first-message", toolCallId: "repeated-call" }).position.partId, "second-tool");
  assert.equal(resolve({ messageId: "first-message", toolCallId: "repeated-call" }).position.partId, "second-tool");
  assert.equal(resolve({ messageId: "other-message", toolCallId: "repeated-call" }).position.partId, "other-tool");
  assert.equal(resolve({ toolCallId: "repeated-call" }), null, "call IDs are not global native part identities");
  assert.equal(resolve({ messageId: "other-message", toolCallId: "missing-call" }), null);
  assert.equal(resolve({ partId: "missing-part", messageId: "first-message", toolCallId: "first-call" }), null);

  const value = protocol({ events: [
    event(1, { messageId: "first-message", partId: "first-text" }),
    event(2, { messageId: "first-message", partId: "missing-part" }),
    event(3, { messageId: "first-message", partId: "second-tool", toolCallId: "repeated-call" }),
    event(4, { messageId: "first-message", partId: "later-text" })
  ], coordination: [observation(2, "follow-up"), observation(3, "spawn")] });
  const result = deriveReaderRelations(value, document);
  assert.equal(result.milestones.length, 1);
  assert.equal(result.milestones[0].position.partId, "second-tool");
  assert.equal(result.unplaced[0].reason, "position_missing", "a missing explicit part is not replaced by a sequence gap");
});

test("reader relations order repeated dispatch, follow-ups and returns by exact local source sequence", () => {
  const fixture = repeatedBranch();
  const original = JSON.stringify(fixture.protocol);
  const result = deriveReaderRelations(fixture.protocol, fixture.document);
  assert.deepEqual(result.milestones.map((item) => item.sequence), [45, 70, 136, 140, 144]);
  assert.equal(result.unplaced.length, 0);
  assert.equal(result.lanes.length, 1);
  assert.deepEqual(result.lanes[0].childSession, { provider: "fixture", sessionId: "child" });
  assert.deepEqual(result.lanes[0].runIds, ["run-first"]);
  assert.deepEqual(result.milestones[1].position, { messageId: "shared-message", partId: "follow-a", side: "before" });
  assert.deepEqual(result.milestones[2].position, { messageId: "shared-message", partId: "after-return", side: "before" });
  assert.deepEqual(result.milestones[4].position, { messageId: "final-message", partId: "final-part", side: "before" });
  assert.equal(result.milestones[2].timestamp, 864, "the exact source event owns the displayed clock");
  assert.deepEqual(result.milestones[2].sourceEventRef, {
    session: { provider: "fixture", sessionId: "root" }, eventId: "event:136"
  });
  assert.ok(result.milestones.every((item) => item.position.messageId !== "not-a-message"));
  assert.equal(JSON.stringify(fixture.protocol), original, "the finalized evidence is not mutated");
});

test("multiple source-only observations in the same gap retain their separate sequence and identity", () => {
  const fixture = repeatedBranch();
  fixture.protocol.coordination.unshift(observation(135, "message"));
  const result = deriveReaderRelations(fixture.protocol, fixture.document);
  const gap = result.milestones.filter((item) => [135, 136].includes(item.sequence));
  assert.deepEqual(gap.map((item) => item.id), ["observation:135", "observation:136"]);
  assert.deepEqual(gap[0].position, gap[1].position);
  assert.equal(gap[0].position.partId, "after-return");
});

test("native source bindings accept document message IDs, exact part IDs and opaque tool part IDs", () => {
  const document = documentOf([
    ["native-message", [["opaque-native-part"]]],
    ["tool-call-message", [["not-a-derived-suffix"]]],
    ["reasoned-message", [["thought-part", "reasoning"], ["answer-part", "text"]]]
  ]);
  const value = protocol({
    events: [
      event(1, { messageId: "opaque-native-part", toolCallId: "different-call-id" }),
      event(2, { messageId: "tool-call-message", toolCallId: "tool-call-message" }),
      event(3, { messageId: "reasoned-message", normalizedKind: "reasoning.output" }),
      event(4, { messageId: "reasoned-message", normalizedKind: "message.assistant" })
    ],
    coordination: [observation(1, "spawn"), observation(2, "follow-up"), observation(3, "message"), observation(4, "result-delivery")]
  });
  const result = deriveReaderRelations(value, document);
  assert.deepEqual(result.milestones.map((item) => item.position.partId), [
    "opaque-native-part", "not-a-derived-suffix", "thought-part", "answer-part"
  ]);
  assert.deepEqual(result.milestones.map((item) => item.position.messageId), [
    "native-message", "tool-call-message", "reasoned-message", "reasoned-message"
  ]);
});

test("shared canonical children have one lane while distinct children and detached runs keep identity", () => {
  const value = protocol({
    events: [1, 2, 3, 4].map((sequence) => event(sequence, { messageId: `message-${sequence}` })),
    agentRuns: [run("run-first"), run("run-second"), run("run-other", "other-child"), run("run-local", null)],
    coordination: [
      observation(1, "spawn"), observation(2, "follow-up", { runId: "run-second" }),
      observation(3, "spawn", { runId: "run-other" }), observation(4, "spawn", { runId: "run-local" })
    ]
  });
  const document = documentOf([1, 2, 3, 4].map((n) => [`message-${n}`, [[`part-${n}`, "text"]]]));
  const result = deriveReaderRelations(value, document);
  assert.equal(result.lanes.length, 3);
  assert.deepEqual(result.lanes[0].runIds, ["run-first", "run-second"]);
  assert.equal(result.milestones[0].laneId, result.milestones[1].laneId);
  assert.notEqual(result.milestones[0].laneId, result.milestones[2].laneId);
  assert.equal(result.lanes[2].childSession, null);
  assert.ok(result.lanes.every((lane) => lane.name === "worker"), "names do not determine identity");
  const otherProvider = deriveReaderRelations({ ...value, session: { ref: { provider: "different", sessionId: "root" } } }, document);
  assert.notEqual(result.lanes[0].id, otherProvider.lanes[0].id, "canonical identity includes the provider");
});

test("child-local source events stay unplaced unless a root-owned event explicitly anchors the observation", () => {
  const childSource = { session: { provider: "fixture", sessionId: "child" }, eventId: "event:child-completed" };
  const value = protocol({
    events: [event(1, { messageId: "message" })],
    coordination: [
      observation(1, "child-turn-completed", { id: "child-only", eventId: null, sourceEventRef: childSource }),
      observation(1, "child-turn-completed", { id: "parent-observed", sourceEventRef: childSource }),
      observation(1, "message", { id: "other-provider", eventId: null, sourceEventRef: {
        session: { provider: "other", sessionId: "root" }, eventId: "event:1"
      } })
    ]
  });
  const result = deriveReaderRelations(value, documentOf([["message", [["part", "text"]]]]));
  assert.deepEqual(result.milestones.map((item) => item.id), ["parent-observed"]);
  assert.deepEqual(result.milestones[0].sourceEventRef, {
    session: { provider: "fixture", sessionId: "root" }, eventId: "event:1"
  });
  assert.deepEqual(result.unplaced.map((item) => [item.id, item.reason]), [
    ["child-only", "external_source"], ["other-provider", "external_source"]
  ]);
  assert.equal(result.unplaced[0].sourceEventRef, childSource);
});

test("missing event, missing native anchors and ambiguous assignment remain explicit without guessed offsets", () => {
  const value = protocol({
    events: [event(1)],
    coordination: [
      observation(1, "result-delivery"), observation(2, "follow-up"),
      observation(1, "message", { id: "ambiguous", runId: null, senderActorId: "shared-actor" })
    ],
    agentRuns: [run("run-first"), run("run-second")],
    actors: [{ id: "shared-actor", name: "same actor", runIds: ["run-first", "run-second"] }]
  });
  const result = deriveReaderRelations(value, documentOf([["not-a-message", [["unbound-part", "text"]]]]));
  assert.equal(result.milestones.length, 0);
  assert.deepEqual(result.unplaced.map((item) => [item.id, item.reason]), [
    ["observation:1", "position_missing"], ["observation:2", "source_missing"], ["ambiguous", "unassigned"]
  ]);
  assert.ok(result.unplaced.every((item) => !("position" in item)));
  assert.equal(result.unplaced[2].laneId, null);
});

test("a source event inside one coalesced native part has no invented between-parts position", () => {
  const value = protocol({
    events: [event(1, { messageId: "part" }), event(2), event(3, { messageId: "part" })],
    coordination: [observation(2, "result-delivery")]
  });
  const result = deriveReaderRelations(value, documentOf([["message", [["part", "text"]]]]));
  assert.equal(result.milestones.length, 0);
  assert.equal(result.unplaced[0].reason, "position_missing");
});

test("source-only events before or after all bound content use the correct boundary side", () => {
  const value = protocol({
    events: [event(1), event(2, { messageId: "message" }), event(3)],
    coordination: [observation(3, "result-delivery"), observation(1, "spawn")]
  });
  const result = deriveReaderRelations(value, documentOf([["message", [["part", "text"]]]]));
  assert.deepEqual(result.milestones.map((item) => item.position), [
    { messageId: "message", partId: "part", side: "before" },
    { messageId: "message", partId: "part", side: "after" }
  ]);
});

test("the complete finalized collection remains available beyond existing overview card and channel limits", () => {
  const count = 60;
  const value = protocol({
    events: Array.from({ length: count }, (_, index) => event(index + 1, { messageId: "message" })),
    agentRuns: Array.from({ length: count }, (_, index) => run(`run-${index}`, `child-${index}`)),
    coordination: Array.from({ length: count }, (_, index) => observation(index + 1, "spawn", { runId: `run-${index}` }))
  });
  const document = documentOf([["message", [["part", "text"]]]]);
  const result = deriveReaderRelations(value, document);
  assert.equal(result.lanes.length, count);
  assert.equal(result.milestones.length, count);
  assert.equal(result.unplaced.length, 0);
  value.coordination = value.coordination.map((item) => ({ ...item, runId: "run-0" }));
  const oneChannel = deriveReaderRelations(value, document);
  assert.equal(oneChannel.milestones.length, count);
  assert.equal(new Set(oneChannel.milestones.map((item) => item.laneId)).size, 1);
});

test("task-only work without a child uses exact task identity instead of a display-name lane", () => {
  const value = protocol({
    events: [event(1, { messageId: "message" }), event(2, { messageId: "message" })],
    agentRuns: [],
    tasks: [{ id: "task-a", title: "same task" }, { id: "task-b", title: "same task" }],
    coordination: [
      observation(1, "delegate", { runId: null, taskId: "task-a" }),
      observation(2, "delegate", { runId: null, taskId: "task-b" })
    ]
  });
  const result = deriveReaderRelations(value, documentOf([["message", [["part", "text"]]]]));
  assert.equal(result.lanes.length, 2);
  assert.notEqual(result.lanes[0].id, result.lanes[1].id);
  assert.deepEqual(result.lanes.map((lane) => lane.runIds), [[], []]);
  assert.ok(result.milestones.every((item) => item.runId === null));
});
