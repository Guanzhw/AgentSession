import assert from "node:assert/strict";
import test from "node:test";

import { deriveReaderMemberRails } from "../dist/src/reader-member-rails.js";

const provenance = { fidelity: "recorded", sourceType: "fixture" };
const root = { provider: "fixture", sessionId: "root" };

function actor(id, name, sessionRef = null, extra = {}) {
  return { id, kind: "agent", name, providerActorId: id, sessionRef, runIds: [], provenance, ...extra };
}

function coordination(id, sequence, kind, fields = {}) {
  return {
    id, sessionId: "root", kind, state: "unknown", timestamp: sequence,
    senderActorId: null, recipientActorId: null, correlationId: null,
    provenance, ...fields
  };
}

function protocol(overrides = {}) {
  return {
    version: 3, sessionId: "root", session: { ref: root }, events: [], relationships: [],
    tasks: [], agentRuns: [], contextArtifacts: [], branches: [], goals: [], actors: [],
    coordination: [], contextVersions: [], contextTransformations: [], usageRecords: [],
    coverage: {}, ...overrides
  };
}

function milestone(id, sequence, kind = "message", extra = {}) {
  return { id, sequence, kind, ...extra };
}

function actorFixture() {
  return [
    actor("actor:main", "Main", root),
    actor("actor:writer", "Writer", { provider: "fixture", sessionId: "writer-child" }),
    actor("actor:writer-alias", "Writer alias", { provider: "fixture", sessionId: "writer-child" }),
    actor("actor:reviewer", "Reviewer", { provider: "fixture", sessionId: "reviewer-child" }),
    actor("actor:detached", "Detached")
  ];
}

function member(result, sessionId) {
  return result.members.find((item) => item.childSession?.sessionId === sessionId);
}

test("rails resolve exact recorded actor/session endpoints and pair only the exact writer-reviewer exchange", () => {
  const protocolValue = protocol({
    actors: actorFixture(),
    coordination: [
      coordination("spawn-writer", 1, "spawn", { senderActorId: "actor:main", recipientActorId: "actor:writer", state: "started" }),
      coordination("spawn-reviewer", 2, "spawn", { senderActorId: "actor:main", recipientActorId: "actor:reviewer", state: "started" }),
      coordination("send-writer-reviewer", 3, "message", {
        senderActorId: "actor:writer", recipientActorId: "actor:reviewer", state: "requested", correlationId: "corr-exact"
      }),
      coordination("deliver-writer-reviewer", 4, "mailbox-delivery", {
        senderActorId: "actor:writer-alias", recipientActorId: "actor:reviewer", state: "delivered", correlationId: "corr-exact"
      }),
      coordination("receipt-reviewer-root", 5, "result-delivery", {
        senderActorId: "actor:reviewer", recipientActorId: "actor:main", state: "delivered", correlationId: "corr-result"
      })
    ]
  });
  const result = deriveReaderMemberRails(protocolValue, protocolValue.coordination.map((item) => milestone(item.id, item.timestamp, item.kind)));

  assert.equal(result.members.length, 2, "main is prose, not a member lane; unused actors get no rail");
  const writer = member(result, "writer-child");
  const reviewer = member(result, "reviewer-child");
  assert.ok(writer && reviewer);
  assert.notEqual(writer.color, reviewer.color, "the first members use distinct palette slots");
  assert.notEqual(writer.id, "actor:writer");
  assert.equal(result.members.filter((item) => item.childSession?.sessionId === "writer-child").length, 1);
  assert.deepEqual(result.points.map(({ id, from, to, kind, state, sequence }) => ({ id, from, to, kind, state, sequence })), [
    { id: "spawn-writer", from: "main", to: writer.id, kind: "spawn", state: "started", sequence: 1 },
    { id: "spawn-reviewer", from: "main", to: reviewer.id, kind: "spawn", state: "started", sequence: 2 },
    { id: "send-writer-reviewer", from: writer.id, to: reviewer.id, kind: "message", state: "requested", sequence: 3 },
    { id: "deliver-writer-reviewer", from: writer.id, to: reviewer.id, kind: "mailbox-delivery", state: "delivered", sequence: 4 },
    { id: "receipt-reviewer-root", from: reviewer.id, to: "main", kind: "result-delivery", state: "delivered", sequence: 5 }
  ]);
  const paired = result.edges.find((edge) => edge.id === "send-writer-reviewer");
  assert.deepEqual(paired && { from: paired.from, to: paired.to, start: paired.start, end: paired.end, kind: paired.kind, received: paired.received }, {
    from: writer.id, to: reviewer.id, start: "send-writer-reviewer", end: "deliver-writer-reviewer", kind: "message", received: true
  });
});

test("same correlation with different endpoints, repeats, and ambiguous candidates never arbitrary-pair", () => {
  const actors = [actor("actor:main", "Main", root), actor("actor:a", "A", { provider: "fixture", sessionId: "a" }), actor("actor:b", "B", { provider: "fixture", sessionId: "b" })];
  const coordinationItems = [
    coordination("send-a-b", 1, "message", { senderActorId: "actor:a", recipientActorId: "actor:b", state: "requested", correlationId: "same" }),
    coordination("deliver-a-b", 2, "mailbox-delivery", { senderActorId: "actor:a", recipientActorId: "actor:b", state: "delivered", correlationId: "same" }),
    coordination("send-b-a", 3, "message", { senderActorId: "actor:b", recipientActorId: "actor:a", state: "requested", correlationId: "same" }),
    coordination("deliver-b-a", 4, "mailbox-delivery", { senderActorId: "actor:b", recipientActorId: "actor:a", state: "delivered", correlationId: "same" }),
    coordination("repeat-send", 5, "message", { senderActorId: "actor:a", recipientActorId: "actor:b", state: "requested", correlationId: "repeat" }),
    coordination("repeat-send-2", 6, "message", { senderActorId: "actor:a", recipientActorId: "actor:b", state: "requested", correlationId: "repeat" }),
    coordination("repeat-delivery", 7, "mailbox-delivery", { senderActorId: "actor:a", recipientActorId: "actor:b", state: "delivered", correlationId: "repeat" })
  ];
  const result = deriveReaderMemberRails(protocol({ actors, coordination: coordinationItems }), coordinationItems.map((item) => milestone(item.id, item.timestamp, item.kind)));
  assert.equal(result.edges.filter((edge) => edge.start === "send-a-b" && edge.end === "deliver-a-b").length, 1, "exact direction disambiguates a shared correlation ID");
  assert.equal(result.edges.filter((edge) => edge.start === "send-b-a" && edge.end === "deliver-b-a").length, 1);
  assert.equal(result.edges.some((edge) => edge.start === "send-a-b" && edge.end === "deliver-b-a"), false, "a matching correlation never overrides different endpoints");
  assert.equal(result.edges.filter((edge) => edge.start === "repeat-send" && edge.end === "repeat-delivery").length, 0, "repeated sends do not choose one candidate");
});

test("sequence order and state remain evidence-bounded for receipts and termination-like observations", () => {
  const items = [
    coordination("receive-first", 1, "mailbox-delivery", { senderActorId: "actor:a", recipientActorId: "actor:b", state: "delivered", correlationId: "ordered" }),
    coordination("send-later", 2, "message", { senderActorId: "actor:a", recipientActorId: "actor:b", state: "requested", correlationId: "ordered" }),
    coordination("unknown-receipt", 3, "mailbox-delivery", { senderActorId: "actor:a", recipientActorId: "actor:b", state: "unknown", correlationId: "unknown" }),
    coordination("turn-complete", 4, "child-turn-completed", { senderActorId: "actor:b", recipientActorId: "actor:main", state: "completed" }),
    coordination("idle", 5, "wait", { senderActorId: "actor:b", recipientActorId: "actor:main", state: "unknown" }),
    coordination("interrupt", 6, "interrupt", { senderActorId: "actor:main", recipientActorId: "actor:b", state: "requested" })
  ];
  const result = deriveReaderMemberRails(protocol({ actors: [actor("actor:main", "Main", root), actor("actor:a", "A", { provider: "fixture", sessionId: "a" }), actor("actor:b", "B", { provider: "fixture", sessionId: "b" })], coordination: items }), items.map((item) => milestone(item.id, item.timestamp, item.kind)));
  assert.equal(result.edges.some((edge) => edge.start === "send-later" && edge.end === "receive-first"), false, "a receive preceding its send is not a pair");
  const unknown = result.edges.find((edge) => edge.id === "unknown-receipt");
  assert.equal(unknown, undefined, "an unknown receipt retains ordinary markup without a sent/received rail node");
  assert.ok(!result.points.some((point) => point.id === "turn-complete"));
  assert.ok(!result.points.some((point) => point.id === "idle"));
  assert.ok(!result.points.some((point) => point.id === "interrupt"), "interrupt requests remain ordinary records, not member lifetime endpoints");
  assert.equal(result.edges.some((edge) => edge.kind === "return" && ["turn-complete", "idle", "interrupt"].includes(edge.start)), false);
});

test("all discovered members and points are retained, with stable colors and no task-label actor invention", () => {
  const actors = [actor("actor:main", "Main", root)];
  const coordinationItems = [];
  for (let index = 0; index < 60; index += 1) {
    const actorId = `actor:worker-${index}`;
    actors.push(actor(actorId, `Worker ${index}`, { provider: "fixture", sessionId: `child-${index}` }));
    const id = `spawn-${index}`;
    coordinationItems.push(coordination(id, index + 1, "spawn", { senderActorId: "actor:main", recipientActorId: actorId, state: "started" }));
  }
  const result = deriveReaderMemberRails(protocol({ actors, tasks: [{ id: "task-only", title: "Imaginary actor", owner: "not-an-actor" }], coordination: coordinationItems }), coordinationItems.map((item) => milestone(item.id, item.timestamp, item.kind)));
  assert.equal(result.members.length, 60);
  assert.equal(result.points.length, 60);
  assert.equal(new Set(result.members.map((item) => item.color)).size, 6);
  assert.deepEqual(result.members.slice(0, 6).map((item) => item.color), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(result.members.map((item) => item.id), deriveReaderMemberRails(protocol({ actors, tasks: [{ id: "task-only", title: "Imaginary actor", owner: "not-an-actor" }], coordination: coordinationItems }), coordinationItems.map((item) => milestone(item.id, item.timestamp, item.kind))).members.map((item) => item.id));
  assert.equal(result.members.some((item) => item.name === "Imaginary actor"), false);
});

test("recorded session references work without actor aliases while unknown endpoints and failed creation stay ordinary", () => {
  const items = [
    coordination("refs", 1, "message", { fromSessionRef: root, toSessionRef: {provider:"fixture", sessionId:"child"}, state:"requested" }),
    coordination("unknown", 2, "message", { senderActorId:"actor:main", recipientActorId:"not-recorded", state:"requested" }),
    coordination("failed", 3, "spawn", { senderActorId:"actor:main", recipientActorId:"actor:failed", state:"failed" })
  ];
  const result = deriveReaderMemberRails(protocol({ actors:[actor("actor:main", "Main", root), actor("actor:failed", "Failed member")], coordination:items }), items.map(item=>milestone(item.id,item.timestamp)));
  assert.deepEqual(result.points.map(point=>point.id), ["refs"]);
  assert.deepEqual(result.members.map(member=>member.childSession), [{provider:"fixture",sessionId:"child"}]);
});
