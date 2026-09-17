import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  READER_ACTIVITY_MAX_LANES,
  READER_ACTIVITY_MAX_POINTS,
  READER_ACTIVITY_WINDOW_MS,
  ReaderActivityError,
  parseReaderActivityQuery,
  projectReaderActivity,
} from "../dist/src/reader-activity.js";

const activityTemp = mkdtempSync(path.join(os.tmpdir(), "agentsession-reader-activity-"));
process.env.AGENTSESSION_META_PATH = path.join(activityTemp, "meta.db");
const { initConfig } = await import("../dist/src/config.js");
initConfig(["--config", path.join(activityTemp, "config.json")]);
const { closeMetaDb } = await import("../dist/src/meta.js");
const { registerSessionDetail } = await import("../dist/src/routes/session-detail.js");
const { buildMessageSessionTree } = await import("../dist/src/providers/shared/message-session.js");
test.after(() => {
  closeMetaDb();
  rmSync(activityTemp, { recursive: true, force: true });
});

const START = Date.UTC(2026, 8, 17, 0, 0);
const WINDOW = 10 * 60 * 1000;
const owner = { provider: "codex", sessionId: "root" };

function textPart(id, timeStart, text = id, fields = {}) {
  return {
    id, messageId: "message", sessionId: owner.sessionId, type: "text", tool: null,
    data: { type: "text", text }, timeStart, timeEnd: timeStart, childSessions: [], ...fields,
  };
}

function message(parts, fields = {}) {
  return { id: "message", sessionId: owner.sessionId, role: "assistant", data: {},
    timeCreated: START - WINDOW, parts, ...fields };
}

function tree(messages, fields = {}) {
  return {
    session: { id: owner.sessionId, provider: owner.provider }, messages, detachedChildren: [],
    metrics: {
      messageCount: messages.length, partCount: messages.reduce((sum, item) => sum + item.parts.length, 0),
      toolCallCount: 0, directChildCount: 0, descendantCount: 0, totalMessages: messages.length,
      totalToolCalls: 0, directInputTokens: 0, directOutputTokens: 0, directReasoningTokens: 0,
      directCacheReadTokens: 0, directCacheWriteTokens: 0, directCost: 0, inputTokens: 0,
      outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      cost: 0, timeStart: 0, timeEnd: 0, runtimeMs: 0,
    },
    ...fields,
  };
}

function lane(id = "lane", fields = {}) {
  return { id, name: id, childSession: { provider: owner.provider, sessionId: `child-${id}` },
    runIds: [`run-${id}`], ...fields };
}

function milestone(id, timestamp, fields = {}) {
  return {
    id, laneId: "lane", kind: "follow-up", eventId: `event:${id}`, sequence: 1, timestamp,
    runId: "run-lane", sourceEventRef: { session: owner, eventId: `event:${id}` },
    position: { messageId: "message", partId: "tool-part", side: "before" }, ...fields,
  };
}

function unplaced(id, timestamp, fields = {}) {
  return {
    id, laneId: "lane", kind: "wait", eventId: `event:${id}`, sequence: null, timestamp,
    runId: "run-lane", sourceEventRef: { session: owner, eventId: `event:${id}` },
    reason: "position_missing", ...fields,
  };
}

function input(fields = {}) {
  return { ...owner, tree: null, relations: null, ...fields };
}

function pagesFor(activity, query = {}) {
  const first = projectReaderActivity(activity, query);
  const pages = [first];
  while (pages.at(-1).nextOffset !== null) {
    const previous = pages.at(-1);
    assert.ok(previous.nextOffset > previous.offset, "continuation must advance");
    assert.ok(pages.length < 20, "the fixture must finish within its expected small page count");
    pages.push(projectReaderActivity(activity, {
      from: first.range.start, offset: previous.nextOffset, revision: first.revision,
    }));
  }
  return pages;
}

function pointsOf(projection) {
  return projection.lanes.flatMap((item) => item.points);
}

function errorCode(code) {
  return (error) => error instanceof ReaderActivityError && error.code === code;
}

test("activity windows are aligned ten-minute half-open ranges and default to the latest record", () => {
  assert.equal(READER_ACTIVITY_WINDOW_MS, WINDOW);
  const activity = input({ tree: tree([message([
    textPart("before", START - 1), textPart("at-start", START),
    textPart("before-end", START + WINDOW - 1), textPart("at-end", START + WINDOW),
  ])]) });
  const selected = projectReaderActivity(activity, { from: START + 12345 });
  assert.deepEqual(selected.range, { start: START, end: START + WINDOW });
  assert.deepEqual(selected.extent, { start: START - 1, end: START + WINDOW });
  assert.deepEqual(pointsOf(selected).map((point) => point.id), ["at-start", "before-end"]);
  const latest = projectReaderActivity(activity);
  assert.deepEqual(latest.range, { start: START + WINDOW, end: START + 2 * WINDOW });
  assert.deepEqual(pointsOf(latest).map((point) => point.id), ["at-end"]);
  assert.deepEqual(pointsOf(projectReaderActivity(activity, { from: START - 1 })).map((point) => point.id), ["before"]);
});

test("parent activity uses each owned text part clock and never traverses inherited or child history", () => {
  const attached = tree([message([textPart("attached-text", START + 5 * WINDOW, "Attached child", { sessionId: "attached" })], { sessionId: "attached" })],
    { session: { id: "attached", provider: "codex" } });
  const detached = tree([message([textPart("detached-text", START + 6 * WINDOW, "Detached child", { sessionId: "detached" })], { sessionId: "detached" })],
    { session: { id: "detached", provider: "codex" } });
  const longText = `  First\n\tsecond ${"word ".repeat(40)}TAIL OUTSIDE EXCERPT`;
  const activity = input({ tree: tree([
    message([
      textPart("text:early", START + 100, "Earlier owned text"),
      textPart("text:later", START + 500, longText, { data: { type: "text", text: longText, contentScope: "owned" } }),
      textPart("part-inherited", START + 2 * WINDOW, "Inherited part", { data: { type: "text", text: "Inherited part", contentScope: "inherited" } }),
      textPart("foreign-part", START + 3 * WINDOW, "Foreign part", { sessionId: "child" }),
      textPart("reasoning", START + 4 * WINDOW, "Hidden reasoning", { type: "reasoning" }),
      textPart("empty", START + 4 * WINDOW, ""),
      textPart("tool", START + 4 * WINDOW, "Tool output", { type: "tool", tool: "spawn", childSessions: [attached] }),
    ], { timeCreated: START - WINDOW, data: { contentScope: "owned" } }),
    message([textPart("inherited-message-text", START + 7 * WINDOW)], { id: "inherited-message", data: { contentScope: "inherited" } }),
    message([textPart("foreign-message-text", START + 8 * WINDOW)], { id: "foreign-message", sessionId: "child" }),
  ], { detachedChildren: [detached] }) });
  const result = projectReaderActivity(activity);
  assert.deepEqual(result.extent, { start: START + 100, end: START + 500 });
  assert.deepEqual(result.range, { start: START, end: START + WINDOW });
  assert.equal(result.coverage.textParts, 2);
  assert.equal(result.coverage.totalLanes, 1);
  assert.deepEqual(pointsOf(result).map(({ id, timestamp }) => ({ id, timestamp })), [
    { id: "text:early", timestamp: START + 100 }, { id: "text:later", timestamp: START + 500 },
  ]);
  const point = pointsOf(result)[1];
  assert.deepEqual(point.source, { ...owner, anchor: "part-text-later" });
  assert.ok(point.excerpt.startsWith("First second "));
  assert.ok(point.excerpt.length <= 100);
  assert.doesNotMatch(point.excerpt, /\n|\t|TAIL OUTSIDE EXCERPT/);
});

test("untimed parent prose stays coverage-only even when the requested window starts at zero", () => {
  for (const parts of [[textPart("untimed", 0)], [textPart("untimed", 0), textPart("timed", 1)]]) {
    const result = projectReaderActivity(input({ tree: tree([message(parts, { timeCreated: START })]) }), { from: 0 });
    assert.equal(result.coverage.untimedTextParts, 1);
    assert.equal(result.coverage.textParts, parts.length);
    assert.deepEqual(pointsOf(result).map((point) => point.id), parts.length === 1 ? [] : ["timed"]);
  }
});

test("all-untimed or absent evidence keeps its missing range and exact coverage", () => {
  const empty = projectReaderActivity(input());
  assert.equal(empty.range, null);
  assert.equal(empty.extent, null);
  assert.deepEqual(empty.lanes, []);
  assert.equal(empty.nextOffset, null);
  assert.ok(Object.values(empty.coverage).every((count) => count === 0));
  const result = projectReaderActivity(input({
    tree: tree([message([textPart("untimed", 0)])]),
    relations: { lanes: [lane()], milestones: [], unplaced: [unplaced("untimed-observation", null)] },
  }));
  assert.equal(result.range, null);
  assert.equal(result.extent, null);
  assert.deepEqual(result.lanes, []);
  assert.equal(result.coverage.totalLanes, 2);
  assert.equal(result.coverage.untimedTextParts, 1);
  assert.equal(result.coverage.untimedObservations, 1);
});

test("located, untimed and absent observation anchors remain distinct", () => {
  const activity = input({ relations: {
    lanes: [lane()], milestones: [milestone("older-anchor", START + 10), milestone("latest", START + 2 * WINDOW + 10)],
    unplaced: [unplaced("untimed-anchor", null)],
  } });
  const located = projectReaderActivity(activity, { anchor: "older-anchor" });
  assert.deepEqual(located.anchor, { id: "older-anchor", timestamp: START + 10, state: "located" });
  assert.deepEqual(located.range, { start: START, end: START + WINDOW });
  assert.deepEqual(pointsOf(located).map((point) => point.id), ["older-anchor"]);
  const untimed = projectReaderActivity(activity, { anchor: "untimed-anchor" });
  assert.deepEqual(untimed.anchor, { id: "untimed-anchor", timestamp: null, state: "untimed" });
  const missing = projectReaderActivity(activity, { anchor: "not-recorded" });
  assert.deepEqual(missing.anchor, { id: "not-recorded", timestamp: null, state: "not-found" });
  assert.equal(projectReaderActivity(activity).anchor, null);
});

test("more than twenty lanes and one hundred points remain exactly reachable across bounded pages", () => {
  assert.equal(READER_ACTIVITY_MAX_LANES, 20);
  assert.equal(READER_ACTIVITY_MAX_POINTS, 100);
  const parts = Array.from({ length: 125 }, (_, index) => textPart(`parent-${index}`, START + 100 + index));
  const lanes = Array.from({ length: 25 }, (_, index) => lane(`lane-${index}`));
  const observations = lanes.map((item, index) => milestone(`dispatch-${index}`, START + 1000 + index, { laneId: item.id, kind: "spawn" }));
  const activity = input({ tree: tree([message(parts)]), relations: { lanes, milestones: observations, unplaced: [] } });
  const pages = pagesFor(activity);
  assert.deepEqual(pages.map((page) => page.lanes.length), [1, 20, 6]);
  assert.deepEqual(pages.map((page) => page.coverage.returnedPoints), [100, 44, 6]);
  assert.deepEqual(pages.map((page) => page.nextOffset), [100, 144, null]);
  assert.ok(pages.every((page) => page.coverage.windowLanes === 26 && page.coverage.windowPoints === 150));
  assert.ok(pages.every((page) => page.revision === pages[0].revision));
  assert.deepEqual(pages.flatMap(pointsOf).map((point) => point.id), [
    ...parts.map((part) => part.id), ...observations.map((item) => item.id),
  ]);
  assert.equal(new Set(pages.flatMap(pointsOf).map((point) => point.id)).size, 150);
  assert.equal(pages[0].lanes[0].id, pages[0].parentLaneId);
  assert.equal(pages[1].lanes[0].id, pages[0].parentLaneId, "a long parent lane resumes without dropping points");
  const selected = projectReaderActivity(activity, { anchor: "dispatch-20" });
  assert.equal(selected.offset, pages[2].offset, "an anchor opens the canonical bounded page that contains it");
  assert.ok(pointsOf(selected).some((point) => point.id === "dispatch-20"));
  assert.deepEqual(selected.lanes, pages[2].lanes);
});

test("complete milestones and unplaced child completions preserve their separate canonical sources", () => {
  const childSession = { provider: "codex", sessionId: "child/canonical:review" };
  const milestones = Array.from({ length: 55 }, (_, index) => milestone(`receipt-${index}`, START + 100 + index, { kind: "result-delivery" }));
  const completions = Array.from({ length: 55 }, (_, index) => unplaced(`completion-${index}`, START + 1000 + index, {
    kind: "child-turn-completed", reason: "external_source", eventId: `child:event:${index}`,
    sourceEventRef: { session: childSession, eventId: `child:event:${index}` },
  }));
  const activity = input({ relations: { lanes: [lane("lane", { childSession })], milestones, unplaced: completions } });
  const pages = pagesFor(activity);
  const points = pages.flatMap(pointsOf);
  assert.deepEqual(pages.map((page) => page.coverage.returnedPoints), [100, 10]);
  assert.equal(pages[0].coverage.observations, 110);
  assert.deepEqual(points.map((point) => point.id), [...milestones, ...completions].map((item) => item.id));
  assert.deepEqual(points.find((point) => point.id === "receipt-54").source, {
    ...owner, eventId: "event:receipt-54", anchor: "milestone-receipt-54",
  });
  const completion = points.find((point) => point.id === "completion-54");
  assert.equal(completion.kind, "child-turn-completed");
  assert.deepEqual(completion.source, { ...childSession, eventId: "child:event:54" });
  assert.deepEqual(pages[0].lanes[0].childSession, childSession);
  const selected = projectReaderActivity(activity, { anchor: "completion-54" });
  assert.equal(selected.offset, 100);
  assert.ok(pointsOf(selected).some((point) => point.id === "completion-54"));
});

test("ordinary messages are counted without activity points; missing time, assignment and source stay explicit", () => {
  const result = projectReaderActivity(input({ relations: {
    lanes: [lane()],
    milestones: [milestone("dispatch", START + 100, { kind: "spawn" }), milestone("ordinary", START + 9 * WINDOW, { kind: "message" })],
    unplaced: [
      unplaced("untimed", null),
      unplaced("unassigned", START + 200, { laneId: null, reason: "unassigned" }),
      unplaced("no-source", START + 300, { eventId: null, sourceEventRef: null, reason: "source_missing" }),
      unplaced("absent-local-event", START + 400, { reason: "source_missing" }),
      unplaced("known-source-without-position", START + 500),
      unplaced("all-missing", null, { laneId: null, eventId: null, sourceEventRef: null, reason: "unassigned" }),
      unplaced("ordinary-untimed", null, { kind: "message" }),
    ],
  } }));
  assert.deepEqual(result.coverage, {
    textParts: 0, observations: 9, ordinaryMessages: 2, untimedTextParts: 0, untimedObservations: 3,
    unassignedObservations: 2, missingSourceObservations: 3, totalLanes: 1,
    windowLanes: 1, windowPoints: 2, returnedLanes: 1, returnedPoints: 2,
  });
  assert.deepEqual(result.extent, { start: START + 100, end: START + 500 });
  assert.deepEqual(pointsOf(result).map((point) => point.id), ["dispatch", "known-source-without-position"]);
  assert.deepEqual(pointsOf(result)[1].source, { ...owner, eventId: "event:known-source-without-position" });
});

test("cross-window spans retain empty intersecting lanes and paginate them without invented points", () => {
  const lanes = Array.from({ length: 25 }, (_, index) => lane(`spanning-${index}`));
  const milestones = lanes.flatMap((item, index) => [
    milestone(`before-${index}`, START - 1, { laneId: item.id, kind: "spawn" }),
    milestone(`after-${index}`, START + WINDOW, { laneId: item.id, kind: "result-delivery" }),
  ]);
  const activity = input({ relations: { lanes, milestones, unplaced: [] } });
  const pages = pagesFor(activity, { from: START });
  assert.deepEqual(pages.map((page) => page.lanes.length), [20, 5]);
  assert.deepEqual(pages.map((page) => page.nextOffset), [20, null]);
  assert.deepEqual(pages.flatMap((page) => page.lanes.map((item) => item.id)), lanes.map((item) => item.id));
  assert.ok(pages.every((page) => page.coverage.windowLanes === 25 && page.coverage.windowPoints === 0));
  assert.ok(pages.flatMap((page) => page.lanes).every((item) => item.points.length === 0));
  assert.deepEqual(pages[0].lanes[0].span, { start: START - 1, end: START + WINDOW });
  assert.deepEqual(projectReaderActivity(activity, { from: START + 2 * WINDOW }).lanes, []);
});

test("continuations bind the recorded window revision and reject stale or out-of-range pages", () => {
  const activity = input({ tree: tree([message(Array.from({ length: 101 }, (_, index) => textPart(`part-${index}`, START + index + 1)))]) });
  const first = projectReaderActivity(activity);
  const query = { from: first.range.start, offset: first.nextOffset, revision: first.revision };
  assert.deepEqual(pointsOf(projectReaderActivity(activity, query)).map((point) => point.id), ["part-100"]);
  const changed = structuredClone(activity);
  changed.tree.messages[0].parts[0].data.text = "Updated recorded prose";
  assert.throws(() => projectReaderActivity(changed, query), errorCode("stale_page"));
  assert.throws(() => projectReaderActivity(activity, { ...query, from: START + WINDOW }), errorCode("stale_page"));
  assert.throws(() => projectReaderActivity(activity, { from: START, offset: 102, revision: first.revision }), errorCode("invalid_input"));
  const end = projectReaderActivity(activity, { from: START, offset: 101, revision: first.revision });
  assert.deepEqual(end.lanes, []);
  assert.equal(end.nextOffset, null);
});

test("HTTP activity queries preserve valid windows, exact anchor identities and continuation fields", () => {
  assert.deepEqual(parseReaderActivityQuery(new URLSearchParams()), { from: undefined, anchor: undefined, offset: 0, revision: undefined });
  assert.deepEqual(parseReaderActivityQuery(new URLSearchParams("from=0")), { from: 0, anchor: undefined, offset: 0, revision: undefined });
  assert.deepEqual(parseReaderActivityQuery(new URLSearchParams({ anchor: "observation:返回/child" })), {
    from: undefined, anchor: "observation:返回/child", offset: 0, revision: undefined,
  });
  assert.deepEqual(parseReaderActivityQuery(new URLSearchParams({ from: String(START + 1), offset: "100", revision: "recorded-revision" })), {
    from: START + 1, anchor: undefined, offset: 100, revision: "recorded-revision",
  });
  assert.equal(parseReaderActivityQuery(new URLSearchParams({ from: String(8640000000000000 - WINDOW) })).from,
    8640000000000000 - WINDOW);
});

test("HTTP activity queries reject invalid numeric inputs and incomplete continuations", () => {
  const invalid = [
    "from=", "from=-1", "from=1.5", "from=NaN", "from=Infinity", "from=1e3", "from=%201",
    "offset=-1", "offset=1.5", "offset=", "offset=9007199254740992", "from=9007199254740992",
    `from=${8640000000000000 - WINDOW + 1}`, "from=0&anchor=observation",
    "offset=1", "offset=1&from=0", "offset=1&revision=revision", "offset=1&anchor=observation&revision=revision",
  ];
  for (const query of invalid) {
    assert.throws(() => parseReaderActivityQuery(new URLSearchParams(query)), errorCode("invalid_input"), query);
  }
});

function activityRoute(provider) {
  const routes = [];
  registerSessionDetail({ get(pattern, handler) { routes.push({ pattern, handler }); } }, {
    appConfig: { port: 0, projectPaths: {}, resumeCommands: {}, allowTerminalLaunch: false },
    providerMap: new Map([[provider.id, provider]]), providerInfo: [],
  });
  return async (query = {}, sessionId = "root/canonical:activity", providerId = provider.id, encoded = false) => {
    const pathname = `/api/${providerId}/session/${encoded ? sessionId : encodeURIComponent(sessionId)}/reader/activity`;
    const route = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.test(pathname));
    assert.ok(route, "activity has its own API route");
    const response = { statusCode: 0, body: "", writeHead(status) { this.statusCode = status; }, end(body = "") { this.body += body; } };
    await route.handler({ url: `${pathname}?${new URLSearchParams(query)}` }, response, route.pattern.exec(pathname));
    return { status: response.statusCode, data: JSON.parse(response.body) };
  };
}

test("activity route reuses the owned reader source with bounded pages and explicit HTTP failures", async () => {
  const session = { id: "root/canonical:activity", provider: "activity-fixture", title: "Activity route", timeCreated: START, timeUpdated: START + 1000 };
  const messages = Array.from({ length: 102 }, (_, index) => ({
    id: `reply-${index}`, sessionId: session.id, role: "assistant", content: `Owned reply ${index}`, timestamp: START + index + 1,
  }));
  let ownedTree = buildMessageSessionTree(session, messages);
  let ownedReads = 0;
  let sessionReads = 0;
  const provider = {
    id: session.provider,
    getSession(id) { sessionReads += 1; return id === session.id ? session : null; },
    getMessages: () => messages,
    getOwnedReaderProjection() { ownedReads += 1; return { rootTree: ownedTree, children: [] }; },
    getSessionTree() { throw new Error("legacy family tree must not be loaded"); },
    getSessionMetrics() { throw new Error("metrics must not be loaded"); },
    getInheritedContext() { throw new Error("inherited context must not be loaded"); },
  };
  const request = activityRoute(provider);
  const invalid = await request({ from: "NaN" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.code, "invalid_input");
  assert.equal(sessionReads, 0, "invalid queries fail before reading provider content");
  const first = await request();
  assert.equal(first.status, 200);
  assert.equal(first.data.ok, true);
  assert.equal(first.data.provider, session.provider);
  assert.equal(first.data.sessionId, session.id);
  assert.equal(first.data.coverage.windowPoints, 102);
  assert.equal(first.data.coverage.returnedPoints, 100);
  assert.equal(first.data.nextOffset, 100);
  assert.equal(ownedReads, 1);
  assert.match(first.data.html, /data-reader-activity-window/);
  const query = { from: first.data.range.start, offset: first.data.nextOffset, revision: first.data.revision };
  const second = await request(query);
  assert.equal(second.status, 200);
  assert.deepEqual(pointsOf(second.data).map((point) => point.id), ["reply-100:text", "reply-101:text"]);
  assert.equal(second.data.nextOffset, null);
  assert.equal((await request({ ...query, offset: 103 })).status, 400);
  messages[0].content = "Updated recorded reply";
  ownedTree = buildMessageSessionTree(session, messages);
  const stale = await request(query);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, "stale_page");
  assert.equal((await request({}, "missing")).data.code, "session_not_found");
  assert.equal((await request({}, "%invalid", provider.id, true)).status, 400);
  assert.equal((await request({}, session.id, "missing-provider")).status, 404);
});

test("activity route derives full recorded task lanes and keeps child completion ownership", async () => {
  const session = { id: "root/canonical:activity", provider: "activity-protocol-fixture", title: "Recorded lane", timeCreated: START, timeUpdated: START + 2000 };
  const sessionRef = { provider: session.provider, sessionId: session.id };
  const child = { provider: session.provider, sessionId: "child/canonical:activity" };
  const messages = [{ id: "root-prose", sessionId: session.id, role: "assistant", content: "Main continues while tasks report", timestamp: START + 500 }];
  const ownedTree = buildMessageSessionTree(session, messages);
  const provenance = { fidelity: "recorded", sourceType: "fixture" };
  const sourceEvent = { id: "event:spawn", sessionId: session.id, sequence: 1, timestamp: START + 100,
    kind: "control", normalizedKind: "control", messageId: "root-prose", provenance };
  const run = { id: "run:child", sessionId: session.id, taskId: null, status: "completed", mode: "subagent", agent: "review",
    model: null, childSessionId: child.sessionId, timeStart: START + 100, timeEnd: START + 1500, provenance };
  const protocol = {
    version: 3, sessionId: session.id, session: { ref: sessionRef }, events: [sourceEvent], relationships: [], tasks: [], agentRuns: [run],
    contextArtifacts: [], branches: [], goals: [], actors: [], contextVersions: [], contextTransformations: [], usageRecords: [], coverage: {},
    coordination: [
      { id: "recorded:spawn", sessionId: session.id, kind: "spawn", timestamp: START + 100, runId: run.id, eventId: sourceEvent.id, provenance },
      { id: "recorded:completion", sessionId: session.id, kind: "child-turn-completed", timestamp: START + 1500, runId: run.id,
        eventId: null, sourceEventRef: { session: child, eventId: "event:child-complete" }, provenance },
    ],
  };
  let sessionReads = 0;
  let sourceEvidence;
  const provider = {
    id: session.provider,
    getSession(id) { sessionReads += 1; return id === session.id ? session : null; },
    getMessages: () => messages,
    getSessionProtocol() { throw new Error("native v3 supplies activity source facts"); },
    getSessionProtocolV3: () => protocol,
    getOwnedReaderProjection(id, evidence) { assert.equal(id, session.id); sourceEvidence = evidence; return { rootTree: ownedTree, children: [] }; },
    getSessionTree() { throw new Error("legacy family tree must not be loaded"); },
    getSessionMetrics() { throw new Error("metrics must not be loaded"); },
    getInheritedContext() { throw new Error("inherited context must not be loaded"); },
  };
  const request = activityRoute(provider);
  const response = await request({ anchor: "recorded:spawn" });
  assert.equal(response.status, 200);
  assert.equal(sessionReads, 1, "the runtime reuses the already-established canonical session");
  assert.deepEqual(sourceEvidence, { tasks: protocol.tasks, agentRuns: protocol.agentRuns, relationships: protocol.relationships });
  assert.deepEqual(response.data.anchor, { id: "recorded:spawn", timestamp: START + 100, state: "located" });
  assert.equal(response.data.coverage.observations, 2);
  assert.equal(response.data.coverage.windowPoints, 3);
  const lane = response.data.lanes.find((item) => item.childSession?.sessionId === child.sessionId);
  assert.ok(lane);
  assert.deepEqual(lane.points.map((point) => point.kind), ["spawn", "child-turn-completed"]);
  assert.deepEqual(lane.points[0].source, { ...sessionRef, eventId: sourceEvent.id, anchor: "milestone-recorded-spawn" });
  assert.deepEqual(lane.points[1].source, { ...child, eventId: "event:child-complete" });
  const missing = await request({ anchor: "not-recorded" });
  assert.equal(missing.status, 200);
  assert.equal(missing.data.anchor.state, "not-found");
});
