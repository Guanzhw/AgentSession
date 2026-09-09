import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenClawSessionProtocol,
  buildOpenClawSessionProtocolV3,
  buildOpenClawSqliteSessionProtocol,
  buildOpenClawSqliteSessionProtocolV3
} from "../dist/src/providers/openclaw/protocol.js";
import { finalizeSessionProtocolV3 } from "../dist/src/providers/shared/session-protocol-v3.js";

const session = (id, metadata = {}) => ({
  id, provider: "openclaw", parentId: null, title: id, directory: null,
  timeCreated: 100, timeUpdated: 200, messageCount: 0, tokenCount: null,
  metadata: { agentId: "main", ...metadata }
});
const records = [
  { type: "session", id: "window-1" },
  { type: "message", id: "u", parentId: null, timestamp: 101, message: { role: "user", content: "go" } },
  { type: "message", id: "abandoned", parentId: "u", timestamp: 102, message: { role: "assistant", content: "old" } },
  { type: "message", id: "a", parentId: "u", timestamp: 103, message: { role: "assistant", model: "model", responseId: "response-1", content: "answer", usage: { input: 10, output: 5, reasoningTokens: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 21 } } },
  { type: "compaction", id: "compact", parentId: "a", timestamp: 104, summary: "opaque summary", tokensBefore: 100, firstKeptEntryId: "a" },
  { type: "message", id: "next", parentId: "compact", timestamp: 105, message: { role: "assistant", model: "model", responseId: "response-2", content: "next", usage: { input: 1, output: 2, totalTokens: 3 } } }
];

function facts(overrides = {}) {
  return {
    agentId: "main", goal: { id: "goal-1", objective: "Inspect", status: "usage_limited", createdAt: 10, updatedAt: 20, tokenBudget: 50 },
    createdActor: { type: "human", id: "operator", label: "Operator" },
    owner: { actor: { type: "agent", id: "main", label: "Main" }, assignedBy: null, assignedAt: 11 },
    createdVia: "operator", spawnDepth: 0, subagentRole: null, startedAt: 12, endedAt: null, runtimeMs: null,
    status: "running", lastRunError: null, swarmGroupId: null, swarmCollector: null, completionOwnerSessionKey: null,
    usageFamilyKey: "agent:main:main", usageFamilySessionIds: ["window-1"], windowReason: null, ...overrides
  };
}

test("OpenClaw native v3 preserves canonical v2 facts and maps goal, actor, usage, and context", () => {
  const root = session("agent:main:main");
  const base = buildOpenClawSqliteSessionProtocol(root, records, [], "fixture", { facts: facts() });
  const v3 = finalizeSessionProtocolV3(buildOpenClawSqliteSessionProtocolV3({ session: root, records, children: [], facts: facts() }, base));
  for (const field of ["sessionId", "session", "events", "relationships", "tasks", "agentRuns", "contextArtifacts", "branches", "revision"]) assert.deepEqual(v3[field], base[field], field);
  assert.equal(v3.goals[0].status, "blocked");
  assert.equal(v3.goals[0].description, "Inspect");
  assert.match(v3.goals[0].provenance.sourceType, /goal\.status:usage_limited$/);
  assert.equal(v3.actors.some((value) => value.providerActorId === "operator"), true);
  assert.equal(v3.actors.filter((value) => value.providerActorId === "main").length, 1, "known actor identities merge canonically");
  assert.equal(v3.events.some((value) => value.id === "record:abandoned"), true);
  assert.equal(v3.events.some((value) => value.id === "session.started:agent:main:main"), true);
  assert.equal(v3.events.find((value) => value.id === "record:a")?.provenance.sourceType, "openclaw.sqlite.transcript_events.message");
  const compactEvent = v3.events.find((value) => value.id === "record:compact");
  assert.equal(compactEvent?.compaction?.retainedFromEventId, "record:a");
  const dangling = buildOpenClawSessionProtocol(root, [{ ...records[4], firstKeptEntryId: "missing" }], [], "fixture");
  assert.equal(dangling.events[1]?.compaction?.retainedFromEventId, null);
  assert.equal(v3.usageRecords.length, 2);
  assert.deepEqual(v3.usageRecords[0].contextOriginSlices, []);
  assert.equal(v3.usageRecords[0].tokens.reasoning, 2);
  assert.equal(v3.contextVersions.length, 1);
  assert.equal(v3.contextTransformations[0].eventId, "record:compact");
  assert.equal(v3.validation.ok, true);
});

test("OpenClaw v3 creates spawn-only runs, team mode, terminal status, and no delivery inference", () => {
  const child = session("agent:worker:child", { agentId: "worker" });
  const childFacts = facts({ goal: null, createdVia: "spawn", spawnDepth: 1, status: "killed", endedAt: 300, swarmGroupId: "swarm-1" });
  const root = session("root");
  const childWithLineage = { session: { ...child, metadata: { ...child.metadata, parentSessionKey: "root", spawnedBy: "root" } }, records: [], facts: childFacts };
  const base = buildOpenClawSqliteSessionProtocol(root, [], [childWithLineage], "fixture", { facts: facts() });
  const v3 = finalizeSessionProtocolV3(buildOpenClawSqliteSessionProtocolV3({ session: root, records: [], children: [childWithLineage], facts: facts() }, base));
  assert.equal(v3.agentRuns.length, 1);
  assert.equal(v3.agentRuns[0].mode, "team");
  assert.equal(v3.agentRuns[0].status, "cancelled");
  assert.equal(v3.agentRuns[0].childSessionAvailable, true);
  assert.equal(v3.coordination.length, 1);
  assert.equal(v3.coordination[0].kind, "spawn");
  assert.equal(v3.coordination[0].runId, v3.agentRuns[0].id);
  assert.equal(v3.coordination[0].toSessionRef.sessionId, "agent:worker:child");
  assert.equal(v3.coordination[0].eventId, null);
  assert.equal(v3.validation.ok, true);
});

test("OpenClaw v3 keeps spawn coordination when child status is missing or unknown", () => {
  const root = session("root");
  const child = session("child", { agentId: "worker" });
  const childWithLineage = { session: { ...child, metadata: { ...child.metadata, parentSessionKey: "root", spawnedBy: "root" } }, records: [], facts: facts({ goal: null, createdVia: "spawn", status: null }) };
  const invalidChild = { session: { ...session("invalid-child", { agentId: "worker-2" }), metadata: { parentSessionKey: "root", spawnedBy: "root" } }, records: [], facts: facts({ goal: null, createdVia: "spawn", status: "future-status" }) };
  const children = [childWithLineage, invalidChild];
  const base = buildOpenClawSqliteSessionProtocol(root, [], children, "fixture", { facts: facts() });
  const v3 = finalizeSessionProtocolV3(buildOpenClawSqliteSessionProtocolV3({ session: root, records: [], children, facts: facts() }, base));
  assert.deepEqual(v3.agentRuns, []);
  assert.equal(v3.coordination.length, 2);
  assert.equal(v3.coordination.every((value) => value.runId === null && value.relationshipType === null), true);
  assert.equal(v3.validation.ok, true);
});

test("OpenClaw v2 branches use canonical heads and common fork, while linear forks stay null", () => {
  const root = session("root");
  const branched = [
    { type: "message", id: "r", parentId: null, message: { role: "user", content: "r" } },
    { type: "message", id: "fork", parentId: "r", message: { role: "assistant", content: "fork" } },
    { type: "message", id: "leaf-a", parentId: "fork", message: { role: "assistant", content: "a" } },
    { type: "message", id: "leaf-b", parentId: "fork", message: { role: "assistant", content: "b" } }
  ];
  const value = buildOpenClawSessionProtocol(root, branched, [], "fixture");
  assert.deepEqual(value.branches.map((branch) => [branch.headEventId, branch.forkEventId]), [["record:leaf-a", "record:fork"], ["record:leaf-b", "record:fork"]]);
  assert.equal(value.validation.ok, true);
  const linear = buildOpenClawSessionProtocol(root, branched.slice(0, 3), [], "fixture");
  assert.equal(linear.branches[0].forkEventId, null);
});

test("OpenClaw legacy v3 uses only recorded directory identity and does not invent goals or runs", () => {
  const root = session("legacy", { agentId: "legacy-agent" });
  const base = buildOpenClawSessionProtocol(root, records, [], "fixture");
  const v3 = finalizeSessionProtocolV3(buildOpenClawSessionProtocolV3({ session: root, records, children: [], agentId: "legacy-agent" }, base));
  assert.deepEqual(v3.goals, []);
  assert.deepEqual(v3.agentRuns, []);
  assert.equal(v3.actors.length, 1);
  assert.equal(v3.actors[0].providerActorId, "legacy-agent");
  assert.equal(v3.validation.ok, true);
});

test("OpenClaw legacy builder restores registry spawnedBy lineage and started event", () => {
  const root = session("legacy-root");
  const child = session("legacy-child");
  const base = buildOpenClawSessionProtocol(root, [], [{ session: { ...child, parentId: "legacy-root" }, records: [] }], "fixture");
  assert.equal(base.events[0].id, "session.started:legacy-root");
  assert.deepEqual(base.relationships.map((value) => [value.type, value.fromSessionId, value.toSessionId, value.provenance.sourceType]), [
    ["spawned", "legacy-root", "legacy-child", "openclaw.registry.spawnedBy"]
  ]);
  const childBase = buildOpenClawSessionProtocol({ ...child, parentId: "legacy-root" }, [], [], "fixture");
  assert.equal(childBase.relationships[0].type, "parent");
  assert.equal(childBase.relationships[0].provenance.sourceType, "openclaw.registry.spawnedBy");
});

test("OpenClaw event parent cycles are explicit validation errors even with multiple roots", () => {
  const value = buildOpenClawSessionProtocol(session("cycle"), [
    { type: "message", id: "root-a", parentId: null, message: { role: "user", content: "a" } },
    { type: "message", id: "root-b", parentId: null, message: { role: "user", content: "b" } },
    { type: "message", id: "cycle-a", parentId: "cycle-b", message: { role: "assistant", content: "a" } },
    { type: "message", id: "cycle-b", parentId: "cycle-a", message: { role: "assistant", content: "b" } }
  ], [], "fixture");
  assert.equal(value.validation.ok, false);
  assert.equal(value.validation.errors.some((error) => error.code === "EVENT_PARENT_CYCLE"), true);
});
