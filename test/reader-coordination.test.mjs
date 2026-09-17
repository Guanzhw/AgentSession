import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeReaderCoordinationCursor,
  deriveReaderCoordinationPage,
  readerEventEvidence,
  readerCoordinationAssignment
} from "../dist/src/reader-coordination.js";
import { deriveConversationView } from "../dist/src/conversation-view-model.js";
import { renderReaderCoordinationPage, renderReaderEventEvidence } from "../dist/src/views/reader-coordination.js";

function protocol() {
  const coordination = Array.from({ length: 53 }, (_, index) => ({
    id: `coord:${index}`,
    sessionId: "root",
    kind: index === 0 ? "follow-up" : "child-turn-completed",
    state: index === 0 ? "unknown" : "completed",
    timestamp: index,
    senderActorId: null,
    recipientActorId: null,
    taskId: "task-1",
    runId: "run-1",
    eventId: index === 0 ? "event:call-0" : null,
    turnId: index === 0 ? "turn-1" : null,
    sourceEventRef: index === 0 ? null : { session: { provider: "codex", sessionId: "child" }, eventId: `event:turn:task_complete:${index}` },
    provenance: { fidelity: "recorded", sourceType: "fixture", sourceId: String(index) }
  }));
  return {
    sessionId: "root", version: 3, session: { ref: { provider: "codex", sessionId: "root" } },
    events: [{ id: "event:source", sessionId: "root", sequence: 1, timestamp: 123, kind: "event_msg", normalizedKind: "event_msg", category: "control", phase: "completed", turnId: "turn-1", taskId: "task-1", runId: "run-1", correlationId: "call-0", messageId: "message-1", toolCallId: "call-0", providerData: { secret: "must-not-leak" }, provenance: { fidelity: "recorded", sourceType: "fixture", sourceId: "source" } }],
    relationships: [], tasks: [], agentRuns: [{ id: "run-1", sessionId: "root", taskId: "task-1", status: "completed", mode: "subagent", agent: "worker", model: null, childSessionId: null, timeStart: 1, timeEnd: 2, provenance: { fidelity: "recorded", sourceType: "fixture" } }], contextArtifacts: [], branches: [], revision: null,
    goals: [], actors: [], coordination, contextVersions: [], contextTransformations: [], usageRecords: [],
    coverage: { work: { state: "unknown" }, execution: { state: "unknown" }, coordination: { state: "observed" }, context: { state: "unknown" }, usage: { state: "unknown" } }
  };
}

test("reader coordination pages the complete assigned collection with canonical cursor identity", () => {
  const value = protocol();
  const first = deriveReaderCoordinationPage(value, { provider: "codex", sessionId: "root", taskId: "task-1", runId: "run-1", size: 50 });
  assert.equal(first.ok, true);
  assert.equal(first.total, 53);
  assert.equal(first.items.length, 50);
  assert.ok(first.nextCursor);
  const cursor = decodeReaderCoordinationCursor(first.nextCursor);
  assert.equal(cursor.lastId, "coord:49");

  const second = deriveReaderCoordinationPage(value, { provider: "codex", sessionId: "root", taskId: "task-1", runId: "run-1", size: 50, cursor: first.nextCursor });
  assert.equal(second.ok, true);
  assert.deepEqual(second.items.map((item) => item.id), ["coord:50", "coord:51", "coord:52"]);
  const stale = deriveReaderCoordinationPage(value, { provider: "codex", sessionId: "root", taskId: "task-1", runId: "run-1", size: 49, cursor: first.nextCursor });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "stale_cursor");
  const missingAnchor = deriveReaderCoordinationPage(value, { provider: "codex", sessionId: "root", taskId: "task-1", runId: "run-1", anchor: "coord:nope" });
  assert.equal(missingAnchor.code, "anchor_not_found");
  const anchored = deriveReaderCoordinationPage(value, { provider: "codex", sessionId: "root", taskId: "task-1", runId: "run-1", anchor: "coord:10", size: 2 });
  assert.deepEqual(anchored.items.map((item) => item.id), ["coord:10", "coord:11"]);
  value.coordination = value.coordination.filter((item) => item.id !== "coord:11");
  const staleAnchor = deriveReaderCoordinationPage(value, { provider: "codex", sessionId: "root", taskId: "task-1", runId: "run-1", anchor: "coord:10", size: 2, cursor: anchored.nextCursor });
  assert.equal(staleAnchor.code, "stale_cursor");
});

test("reader event source exposes bounded scalar evidence without provider data", () => {
  const value = protocol();
  value.events[0].partId = "exact:source.part";
  const evidence = readerEventEvidence(value, "event:source");
  assert.equal(evidence.messageId, "message-1");
  assert.equal(evidence.partId, "exact:source.part");
  assert.equal("providerData" in evidence, false);
  const html = renderReaderEventEvidence(evidence);
  assert.match(html, /data-reader-event-id="event:source"/);
  assert.doesNotMatch(html, /must-not-leak/);
  assert.equal(readerEventEvidence(value, "event:missing"), null);
});

test("coordination source links keep event ID and owner paired in the rendered page", () => {
  const page = deriveReaderCoordinationPage(protocol(), { provider: "codex", sessionId: "root", runId: "run-1", size: 2 });
  assert.equal(page.ok, true);
  const html = renderReaderCoordinationPage(page);
  assert.match(html, /data-reader-session="root" data-reader-event-id="event:call-0"[^>]*href="\/codex\/session\/root\?readerEvent=event%3Acall-0"/);
  assert.match(html, /data-reader-session="child" data-reader-event-id="event:turn:task_complete:1"[^>]*href="\/codex\/session\/child\?readerEvent=event%3Aturn%3Atask_complete%3A1"/);
  assert.doesNotMatch(html, /\/reader\/coordination\/event\//);
});

test("the first reader More request starts after the 50 observations already rendered", async () => {
  const { renderSessionReaderPane } = await import("../dist/src/views/session.js");
  const value = protocol();
  const view = deriveConversationView({
    protocol: value,
    work: { tasks: [], truncated: false },
    execution: { focus: value.session.ref, runs: value.agentRuns.map((run) => ({ run })), actors: [], actorRuns: [], usage: null, truncated: false },
    coordination: { lineage: [], observations: [], truncated: true, focus: value.session.ref },
    context: { artifacts: [], artifactSessions: [], artifactRuns: [], lineage: [], truncated: false }
  });
  const card = view.cards[0];
  assert.equal(card.channel.length, 50);
  assert.equal(decodeReaderCoordinationCursor(card.channelNextCursor).lastId, "coord:49");
  const html = renderSessionReaderPane({ session: { id: "root", title: "Reader" }, provider: "codex", conversationView: view });
  const url = html.match(/data-reader-coordination-url="([^"]+)"/)?.[1].replaceAll("&amp;", "&");
  assert.ok(url, "SSR exposes the seeded continuation URL");
  const params = new URL(url, "http://localhost").searchParams;
  const more = deriveReaderCoordinationPage(value, {
    provider: "codex", sessionId: "root", runId: params.get("runId"), taskId: params.get("taskId"),
    cursor: params.get("cursor"), size: Number(params.get("size"))
  });
  assert.equal(more.ok, true);
  assert.deepEqual(more.items.map((item) => item.id), ["coord:50", "coord:51", "coord:52"]);
  assert.equal(more.nextCursor, null);
});

test("conversation cards keep repeated task assignments explicit", () => {
  const value = protocol();
  value.coordination = [
    { ...value.coordination[0], id: "coord:run-2", runId: "run-2" },
    { ...value.coordination[0], id: "coord:run-missing", runId: "run-missing" },
    { ...value.coordination[0], id: "coord:task-only", runId: null }
  ];
  value.tasks = [{ id: "task-1", sessionId: "root", kind: "subagent-task", status: "completed", title: "worker", toolCallId: null, correlationId: null, agentPath: null, timeCreated: 1, timeUpdated: 2, timeCompleted: 2, provenance: { fidelity: "recorded", sourceType: "fixture" } }];
  const run = (id) => ({ id, sessionId: "root", taskId: "task-1", status: "completed", kind: "subagent", childSessionId: id, childSessionAvailable: true, agent: id, timeStart: 1, timeEnd: 2, provenance: { fidelity: "recorded", sourceType: "fixture" } });
  value.agentRuns = [run("run-1"), run("run-2")];
  const view = deriveConversationView({
    protocol: value,
    work: { tasks: value.tasks.map((task) => ({ task, ref: { kind: "task", id: task.id } })), truncated: false },
    execution: { focus: { provider: "codex", sessionId: "root" }, runs: value.agentRuns.map((item) => ({ run: item, ref: { kind: "run", id: item.id } })), actors: [], actorRuns: [], usage: null, truncated: false },
    coordination: { lineage: [], observations: [], truncated: false, focus: { provider: "codex", sessionId: "root" } },
    context: { artifacts: [], artifactSessions: [], artifactRuns: [], lineage: [], truncated: false }
  });
  assert.equal(view.cards.length, 2);
  assert.equal(view.cards.find((card) => card.id === "run:run-1").observationCount, 0);
  assert.equal(view.cards.find((card) => card.id === "run:run-2").observationCount, 1);
});

test("coordination actor fallback assigns only a globally unique card", () => {
  const value = protocol();
  value.actors = [{
    id: "actor:worker", kind: "agent", name: "worker", runIds: ["run-1"],
    provenance: { fidelity: "recorded", sourceType: "fixture" }
  }];
  value.coordination = [{
    id: "coord:actor-only", sessionId: "root", kind: "message", state: "delivered", timestamp: 1,
    senderActorId: "actor:worker", recipientActorId: null, taskId: null, runId: null,
    eventId: null, turnId: null, sourceEventRef: null,
    provenance: { fidelity: "recorded", sourceType: "fixture" }
  }];
  assert.equal(readerCoordinationAssignment(value).byObservation[0].key, "run:run-1");
  value.agentRuns.push({ ...value.agentRuns[0], id: "run-2" });
  value.actors[0].runIds = ["run-1", "run-2"];
  assert.equal(readerCoordinationAssignment(value).byObservation[0], null);
});
