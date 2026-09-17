import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { deriveConversationView } from "../dist/src/conversation-view-model.js";
import {
  projectContext,
  projectCoordination,
  projectExecution,
  projectWork
} from "../dist/src/protocol-runtime-v3.js";
import { renderSessionPage } from "../dist/src/views/session.js";

const provenance = { fidelity: "recorded", sourceType: "fixture" };

// ── Minimal session-tree fixture (mirrors core.test flow helpers) ──────────

function flowMetrics(overrides = {}) {
  return {
    totalMessages: 0,
    totalToolCalls: 0,
    descendantCount: 0,
    directChildCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    runtimeMs: 0,
    ...overrides
  };
}

function flowMessage(id, role, timeCreated, parts = [], options = {}) {
  const textParts = options.text !== false
    ? [{
        id: `${id}-text`,
        messageId: id,
        sessionId: "root",
        type: "text",
        tool: null,
        timeStart: 0,
        timeEnd: 0,
        childSessions: [],
        data: { type: "text", text: `${role} ${id}` }
      }]
    : [];
  return {
    id,
    sessionId: "root",
    role,
    timeCreated,
    parts: [...textParts, ...parts],
    data: { role }
  };
}

function flowTool(id, options = {}) {
  const part = {
    kind: "part",
    id,
    messageId: options.messageId || "a1",
    sessionId: "root",
    partType: "tool",
    tool: options.tool || "task",
    title: options.title || "task",
    timeStart: options.timeStart || 0,
    timeEnd: options.timeEnd || 0,
    childSessions: options.childSessions || [],
    data: {
      type: "tool",
      tool: options.tool || "task",
      state: {
        status: options.status || "completed",
        title: options.title || null,
        input: options.input || null,
        time: { start: options.timeStart || 0, end: options.timeEnd || 0 }
      }
    }
  };
  part.type = "tool";
  return part;
}

function childSession(id, title) {
  return {
    session: { id, title },
    detachedChildren: [],
    metrics: flowMetrics({ totalMessages: 1 }),
    messages: [{
      id: `${id}-answer`,
      sessionId: id,
      role: "assistant",
      timeCreated: 1200,
      data: { role: "assistant" },
      parts: [{
        id: `${id}-text`,
        messageId: `${id}-answer`,
        sessionId: id,
        type: "text",
        tool: null,
        timeStart: 0,
        timeEnd: 0,
        childSessions: [],
        data: { type: "text", text: `${title} output` }
      }]
    }]
  };
}

function flowSession(id, messages, overrides = {}) {
  return {
    kind: "session",
    id,
    title: overrides.title || id,
    depth: overrides.depth || 0,
    attachMode: overrides.attachMode || "root",
    session: { id },
    messages,
    detachedChildren: overrides.detachedChildren || [],
    metrics: flowMetrics({ messageCount: messages.length, totalMessages: messages.length })
  };
}

// ── Session Protocol v3 fixture ────────────────────────────────────────────

function v3Fixture(overrides = {}) {
  const session = {
    ref: { provider: "fixture", sessionId: "root" },
    state: "running",
    origin: "fixture",
    timeCreated: 1,
    timeUpdated: 2,
    cwd: null,
    harness: "fixture",
    terminalOutcome: null,
    forkSeedBoundary: null,
    inheritedEventCount: null,
    provenance
  };
  return {
    version: 3,
    sessionId: "root",
    session,
    events: [],
    relationships: [],
    branches: [],
    tasks: [{
      id: "task-1", sessionId: "root", kind: "subagent-task", status: "running",
      title: "Review docs", agentPath: "/root/worker", toolCallId: "task-part",
      assignee: "worker", dependencies: [], timeCreated: 1000, timeUpdated: 1000,
      timeCompleted: null, provenance
    }],
    agentRuns: [{
      id: "run-1", sessionId: "root", taskId: "task-1", status: "running",
      mode: "subagent", agent: "worker", model: "model", childSessionId: "child-1",
      timeStart: 1000, timeEnd: null, provenance
    }],
    contextArtifacts: [],
    goals: [],
    actors: [
      { id: "actor:main", kind: "agent", name: "main", providerActorId: "/root", sessionRef: session.ref, runIds: [], provenance },
      { id: "actor:child-1", kind: "agent", name: "worker", providerActorId: "/root/worker", sessionRef: { provider: "fixture", sessionId: "child-1" }, runIds: ["run-1"], provenance }
    ],
    coordination: [],
    contextVersions: [],
    contextTransformations: [],
    usageRecords: [],
    coverage: {
      work: { state: "observed", details: null },
      execution: { state: "observed", details: null },
      coordination: { state: "observed", details: null },
      context: { state: "observed", details: null },
      usage: { state: "observed", details: null }
    },
    ...overrides
  };
}

function completionUsage(overrides = {}) {
  // Complete origin partition: every component's slices sum to the recorded
  // component total, so the execution origin aggregate is complete.
  return [{
    id: "request-1",
    scope: "request",
    sessionRef: { provider: "fixture", sessionId: "root" },
    timestamp: 1700,
    model: "model",
    runId: "run-1",
    turnId: "a3",
    tokens: { input: 100, cacheRead: 20, cacheWrite: 5, output: 10, reasoning: 5, total: 140 },
    contextOriginSlices: [
      { component: "input", origin: "direct", tokens: 40, sourceSessionRefs: [] },
      { component: "input", origin: "inherited", tokens: 60, sourceSessionRefs: [{ provider: "fixture", sessionId: "parent" }] },
      { component: "cacheRead", origin: "direct", tokens: 20, sourceSessionRefs: [] },
      { component: "cacheWrite", origin: "shared", tokens: 5, sourceSessionRefs: [] }
    ],
    provenance
  }, ...overrides];
}

function fullViewFixture(usageOverrides = []) {
  const protocol = v3Fixture({
    coordination: [
      {
        id: "coord:spawn:1", sessionId: "root", kind: "spawn", state: "started", timestamp: 900,
        senderActorId: "actor:main", recipientActorId: "actor:child-1",
        taskId: "task-1", runId: "run-1", turnId: "a1", provenance
      },
      {
        id: "coord:message:1", sessionId: "root", kind: "message", state: "unknown", timestamp: 1750,
        senderActorId: "actor:child-1", recipientActorId: "actor:main", turnId: "a2", provenance
      },
      {
        id: "coord:interrupt:1", sessionId: "root", kind: "interrupt", state: "unknown", timestamp: 1600,
        runId: "run-1", taskId: "task-1", provenance
      },
      {
        id: "coord:result:1", sessionId: "root", kind: "result-delivery", state: "delivered", timestamp: 1700,
        senderActorId: "actor:child-1", recipientActorId: "actor:main",
        taskId: "task-1", runId: "run-1", turnId: "a3", provenance
      },
      {
        id: "coord:ack:1", sessionId: "root", kind: "result-acknowledgement", state: "acknowledged", timestamp: 1800,
        runId: "run-1", taskId: "task-1", turnId: "a3", provenance
      }
    ],
    usageRecords: completionUsage(usageOverrides),
    contextArtifacts: [
      {
        id: "artifact:memory", sessionId: "root", kind: "memory", scope: "project", origin: "agent-generated",
        contentAccess: "metadata-only", title: "Project memory", summary: "Remembered convention",
        sourcePath: null, producerRunId: "run-1", sourceSessionIds: ["child-1"], hash: null, redacted: false,
        timeCreated: 1900, provenance
      },
      {
        id: "artifact:skill", sessionId: "root", kind: "skill", scope: "agent", origin: "provider-generated",
        contentAccess: "summary", title: "Review skill", summary: null, sourcePath: null,
        producerRunId: null, sourceSessionIds: [], hash: null, redacted: false, timeCreated: 1900, provenance
      },
      {
        id: "artifact:experience", sessionId: "root", kind: "experience", scope: "user", origin: "user-authored",
        contentAccess: "full", title: "User experience", summary: "Long-standing preference",
        sourcePath: null, producerRunId: null, sourceSessionIds: [], hash: null, redacted: false,
        timeCreated: 1900, provenance
      },
      {
        id: "artifact:summary", sessionId: "root", kind: "summary", scope: "session", origin: "provider-generated",
        contentAccess: "metadata-only", title: null, summary: "Kept the goal", sourcePath: null,
        producerRunId: null, sourceSessionIds: ["root"], hash: null, redacted: false, timeCreated: 1900, provenance
      }
    ],
    relationships: [...Array.from({ length: 7 }, (_, index) => ({
      type: "spawned",
      fromSessionId: "root",
      toSessionId: `child-${index}`,
      provenance
    }))]
  });
  return {
    protocol,
    work: projectWork(protocol),
    execution: projectExecution(protocol),
    coordination: projectCoordination(protocol),
    context: projectContext(protocol)
  };
}

function deriveFixture(fixture = fullViewFixture()) {
  return deriveConversationView({
    protocol: fixture.protocol,
    work: fixture.work,
    execution: fixture.execution,
    coordination: fixture.coordination,
    context: fixture.context
  });
}

function cardTree() {
  const child = childSession("child-1", "Worker session");
  const task = flowTool("task-part", { tool: "task", status: "running", title: "Review docs", childSessions: [child] });
  return flowSession("root", [
    flowMessage("u1", "user", 1000, [], { text: true }),
    flowMessage("a1", "assistant", 1100, [task]),
    flowMessage("a2", "assistant", 1500, [], { text: true }),
    flowMessage("a3", "assistant", 1700, [], { text: true })
  ]);
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("P2b view model derives a recorded-time-ordered agent channel", () => {
  const view = deriveFixture();
  assert.equal(view.cards.length, 1);
  const card = view.cards[0];
  assert.equal(card.id, "run:run-1");
  assert.equal(card.name, "worker");
  assert.equal(card.actorKind, "agent");
  assert.equal(card.responsibility, "Review docs");
  assert.equal(card.state, "interrupted", "a recorded interrupt with a non-terminal run presents interrupted");
  assert.equal(card.rawStatus, "running");
  assert.deepEqual(card.childSession, { provider: "fixture", sessionId: "child-1" });
  assert.equal(card.bindings.taskToolCallId, "task-part");
  assert.equal(card.bindings.childSessionId, "child-1");
  assert.equal(card.observationCount, 5);
  assert.deepEqual(card.channel.map((item) => item.kind), ["spawn", "interrupt", "result-delivery", "message", "result-acknowledgement"]);
  assert.deepEqual(card.channel.map((item) => item.timestamp), [900, 1600, 1700, 1750, 1800], "display order follows recorded time while protocol source order remains unchanged");
  assert.equal(card.channel[0].senderName, "main");
  assert.equal(card.channel[0].recipientName, "worker");
  assert.equal(card.channel[3].senderName, "worker");
  assert.equal(card.channel[3].recipientName, "main");
  assert.equal(card.lastActivity, 1800);
});

test("reader view exposes source-ordered main-agent turn boundaries only for root session runs", () => {
  const protocol = v3Fixture({
    tasks: [],
    actors: [],
    agentRuns: [
      { id: "run:turn-1", sessionId: "root", taskId: null, status: "completed", mode: "unknown", kind: "session-turn", turnId: "turn-1", agent: null, model: null, childSessionId: null, timeStart: 300, timeEnd: 100, provenance },
      { id: "run:child-turn", sessionId: "child-1", taskId: null, status: "completed", mode: "unknown", kind: "session-turn", turnId: "child-turn", agent: null, model: null, childSessionId: null, timeStart: 250, timeEnd: 260, provenance },
      { id: "run:turn-2", sessionId: "root", taskId: null, status: "completed", mode: "unknown", kind: "session-turn", turnId: "turn-2", agent: null, model: null, childSessionId: null, timeStart: 50, timeEnd: 400, provenance },
      { id: "run:turn-3", sessionId: "root", taskId: null, status: "running", mode: "unknown", kind: "session-turn", turnId: "turn-3", agent: null, model: null, childSessionId: null, timeStart: null, timeEnd: null, provenance }
    ],
    events: [
      { id: "event:turn-1-start", sessionId: "root", sequence: 1, timestamp: 300, kind: "task_started", normalizedKind: "run.started", turnId: "turn-1", runId: "run:turn-1", provenance },
      { id: "event:turn-1-end", sessionId: "root", sequence: 2, timestamp: 100, kind: "task_complete", normalizedKind: "run.completed", turnId: "turn-1", runId: "run:turn-1", provenance },
      { id: "event:child-start", sessionId: "root", sequence: 3, timestamp: 250, kind: "task_started", normalizedKind: "run.started", turnId: "child-turn", runId: "run:child-turn", provenance },
      { id: "event:turn-2-start", sessionId: "root", sequence: 4, timestamp: 50, kind: "task_started", normalizedKind: "run.started", turnId: "turn-2", runId: "run:turn-2", provenance },
      { id: "event:turn-2-end", sessionId: "root", sequence: 5, timestamp: 400, kind: "task_complete", normalizedKind: "run.completed", turnId: "turn-2", runId: "run:turn-2", provenance },
      { id: "event:turn-3-start", sessionId: "root", sequence: 6, timestamp: null, kind: "task_started", normalizedKind: "run.started", turnId: "turn-3", runId: "run:turn-3", provenance },
      { id: "event:unrelated", sessionId: "root", sequence: 7, timestamp: 500, kind: "message", normalizedKind: "message", runId: "run:turn-1", provenance }
    ]
  });
  const view = deriveConversationView({
    protocol,
    work: projectWork(protocol),
    execution: projectExecution(protocol),
    coordination: projectCoordination(protocol),
    context: projectContext(protocol)
  });
  assert.deepEqual(view.turnBoundaries.map((boundary) => boundary.eventId), [
    "event:turn-1-start", "event:turn-1-end", "event:turn-2-start", "event:turn-2-end", "event:turn-3-start"
  ]);
  assert.deepEqual(view.turnBoundaries.map((boundary) => boundary.displayNumber), [1, 1, 2, 2, 3]);
  assert.deepEqual(view.turnBoundaries.map((boundary) => boundary.timestamp), [300, 100, 50, 400, null], "source order is retained despite clock disagreement");
  assert.equal(view.turnBoundaries.some((boundary) => boundary.runId === "run:child-turn"), false);
  const html = renderSessionPage({
    session: cardTree().session,
    sessionTree: cardTree(),
    provider: "fixture",
    conversationView: view
  });
  assert.doesNotMatch(html, /data-reader-collaboration-toggle|data-reader-collaboration-overview/, "turn boundaries alone do not create a tasks drawer");
  assert.doesNotMatch(html, /data-reader-lane="main-agent-turns"/);
  assert.doesNotMatch(html, /data-reader-event-id="event:child-start"/);
  assert.doesNotMatch(html, /data-reader-turn-boundary[^>]*data-reader-anchor/);
});

test("conversation channels retain source evidence without treating execution turn IDs as text anchors", () => {
  const view = deriveFixture();
  assert.equal("references" in view, false, "reader-relations owns main-history source placement");
  const channel = view.cards.flatMap((card) => card.channel);
  assert.equal(channel.filter((item) => item.kind === "result-delivery").length, 1);
  assert.equal(channel.filter((item) => item.kind === "result-acknowledgement").length, 1);
  assert.equal(channel.find((item) => item.kind === "message").turnId, "a2");
});

test("P2b SSR retains the task disclosure and opens child history through its canonical reader", () => {
  const view = deriveFixture();
  const html = renderSessionPage({
    session: cardTree().session,
    sessionTree: cardTree(),
    provider: "fixture",
    conversationView: view
  });
  const thread = messagesSection(html);
  assert.equal((thread.match(/data-agent-card/g) || []).length >= 1, true);
  assert.match(thread, /data-agent-card-id="run:run-1"/);
  assert.match(thread, /data-agent-name="worker"/);
  assert.match(thread, /data-agent-state="interrupted"/);
  assert.match(thread, /data-agent-child-session="child-1"/);
  assert.doesNotMatch(thread, /Worker session output/, "the parent does not eagerly duplicate child bodies");
  assert.match(thread, /data-reader-open[^>]*data-reader-session="child-1"/, "bound child history stays reachable");
  assert.match(thread, /class="tool-call tool-status-running"/, "the task tool disclosure remains reachable");
  assert.equal((thread.match(/id="part-task-part"/g) || []).length, 1, "the task part keeps one canonical anchor");
  assert.equal((thread.match(/id="session-child-1"/g) || []).length, 0, "the child pane owns its own anchors");
  assert.match(thread, /id="part-task-part"/, "dispatch part anchor is preserved");
  assert.match(thread, /href="\/fixture\/session\/child-1"/);
  assert.equal((thread.match(/class="subagent-export-btn"[^>]*href="\/fixture\/session\/child-1"/g) || []).length, 1, "child session Open action renders once");
  // Card starts collapsed; the channel is a nested disclosure.
  assert.match(thread, /<details class="agent-card"/);
  assert.doesNotMatch(thread, /<details class="agent-card[^>]*open/);
  assert.match(thread, /<details class="agent-channel" data-agent-channel[^>]*data-disclosure>/);
  assert.match(thread, /aria-expanded="false"/);
  // Channel items and their recorded fields only.
  assert.equal((thread.match(/data-channel-kind=/g) || []).length, 5);
  assert.match(thread, /data-channel-kind="spawn"/);
  assert.match(thread, /data-channel-kind="message"/);
  assert.match(thread, /data-channel-kind="result-delivery"/);
  assert.match(thread, /agent-channel-direction[^>]*>worker → main</);
  assert.doesNotMatch(thread, /No recorded channel activity\./, "channel is not empty");
  // Result arrival on the card.
  assert.match(thread, /data-agent-result-arrival="[^"]+"/);
});

test("P2b channel marks unknown times and does not fold across the known-time boundary", () => {
  const protocol = v3Fixture({
    coordination: [
      { id: "coord:known", sessionId: "root", kind: "message", state: "delivered", timestamp: 100,
        taskId: "task-1", runId: "run-1", provenance },
      { id: "coord:unknown", sessionId: "root", kind: "message", state: "delivered", timestamp: null,
        taskId: "task-1", runId: "run-1", provenance }
    ]
  });
  const view = deriveFixture({
    protocol,
    work: projectWork(protocol),
    execution: projectExecution(protocol),
    coordination: projectCoordination(protocol),
    context: projectContext(protocol)
  });
  const html = renderSessionPage({
    session: cardTree().session,
    sessionTree: cardTree(),
    provider: "fixture",
    conversationView: view
  });
  const thread = messagesSection(html);
  assert.deepEqual([...thread.matchAll(/data-channel-id="([^"]+)"/g)].map((match) => match[1]), ["coord:known", "coord:unknown"]);
  assert.match(thread, /detail.reader_channel_order_note|Sorted by recorded time/);
  assert.match(thread, /Time not recorded/);
  assert.equal((thread.match(/class="reader-channel-group"/g) || []).length, 0, "known and unknown messages stay separate");
});

test("P2b bound card keeps distinct canonical child readers and dedupes their ToC entries", () => {
  const view = deriveFixture();
  const worker = childSession("child-1", "Worker session");
  const sibling = childSession("child-2", "Sibling session");
  const task = flowTool("task-part", {
    tool: "task",
    status: "running",
    title: "Review docs",
    childSessions: [worker, worker, sibling]
  });
  const tree = flowSession("root", [flowMessage("a1", "assistant", 1100, [task])]);
  const html = renderSessionPage({ session: tree.session, sessionTree: tree, provider: "fixture", conversationView: view });
  const messages = messagesSection(html);
  const toc = tocSection(html);

  assert.equal((messages.match(/data-agent-card-id="run:run-1"/g) || []).length, 1);
  assert.doesNotMatch(messages, /Worker session output|Sibling session output/);
  assert.doesNotMatch(messages, /id="session-child-[12]"/);
  assert.match(messages, /data-reader-open[^>]*data-reader-session="child-1"/);
  assert.match(messages, /data-reader-open[^>]*data-reader-session="child-2"/);
  for (const child of [worker, sibling]) {
    const childHtml = renderSessionPage({ session: child.session, sessionTree: child, provider: "fixture" });
    assert.equal((childHtml.match(new RegExp(`id="session-${child.session.id}"`, "g")) || []).length, 1);
    assert.match(childHtml, new RegExp(`${child.session.title} output`));
  }
  assert.equal((messages.match(/id="part-task-part"/g) || []).length, 1);
  assert.equal((toc.match(/data-reader-session="child-1"/g) || []).length, 1);
  assert.equal((toc.match(/data-reader-session="child-2"/g) || []).length, 1);
});

test("conversation channels do not create legacy main-thread references or duplicate ToC entries", () => {
  const view = deriveFixture();
  const html = renderSessionPage({
    session: cardTree().session,
    sessionTree: cardTree(),
    provider: "fixture",
    conversationView: view
  });
  const thread = messagesSection(html);
  assert.doesNotMatch(thread, /data-agent-reference|data-reference-kind/);
  assert.match(thread, /data-channel-kind="result-delivery"/);
  const toc = html.match(/<div class="toc-list">([\s\S]*?)<\/div>\s*<button class="toc-resize-handle"/)?.[1] || "";
  assert.doesNotMatch(toc, /data-agent-reference|agent-card|agent-channel|agent-reference|data-channel-kind/);
  assert.doesNotMatch(toc, /href="#part-task-part"/, "a resolved single-child task has no duplicate task node");
  assert.match(toc, /href="\/fixture\/session\/child-1"/, "the combined task/child entry resolves canonically");
});

test("P2b nested-session fallback stays when no protocol binding exists", () => {
  const tree = cardTree();
  const html = renderSessionPage({ session: tree.session, sessionTree: tree, provider: "fixture" });
  assert.match(html, /class="subagent-branch"/);
  assert.match(html, /class="subagent-summary"/);
  assert.doesNotMatch(html, /data-agent-card/);
});

test("P2b inspector splits usage origins only when the origin aggregate is complete", () => {
  const complete = deriveFixture();
  const completeHtml = renderSessionPage({
    session: cardTree().session,
    sessionTree: cardTree(),
    provider: "fixture",
    conversationView: complete
  });
  assert.match(completeHtml, /data-inspector-usage[^>]*data-usage-complete="true"/);
  assert.match(completeHtml, /data-inspector-origins/);
  assert.doesNotMatch(completeHtml, /data-usage-incomplete/);
  assert.match(completeHtml, /data-origin-direct="40"/);
  assert.match(completeHtml, /data-origin-inherited="60"/);
  assert.match(completeHtml, /data-origin-shared="5"/);

  // Incomplete partition: part of input stays unclassified.
  const incomplete = fullViewFixture([{
    id: "request-2",
    scope: "request",
    sessionRef: { provider: "fixture", sessionId: "root" },
    timestamp: 1800,
    model: "model",
    runId: "run-1",
    tokens: { input: 100, cacheRead: 20, cacheWrite: 5, output: 10, reasoning: 5, total: 140 },
    contextOriginSlices: [
      { component: "input", origin: "direct", tokens: 40, sourceSessionRefs: [] }
    ],
    provenance
  }]);
  const incompleteView = deriveFixture(incomplete);
  assert.equal(incompleteView.inspector.usage.originsComplete, false);
  const incompleteHtml = renderSessionPage({
    session: cardTree().session,
    sessionTree: cardTree(),
    provider: "fixture",
    conversationView: incompleteView
  });
  assert.doesNotMatch(incompleteHtml, /data-inspector-origins/);
  assert.match(incompleteHtml, /data-usage-incomplete/);
});

test("P2b inspector caps relationships at five with a Work overflow link", () => {
  const view = deriveFixture();
  assert.equal(view.inspector.relationships.length, 5);
  assert.equal(view.inspector.relationshipCount, 7);
  const html = renderSessionPage({
    session: cardTree().session,
    sessionTree: cardTree(),
    provider: "fixture",
    conversationView: view
  });
  assert.equal((html.match(/data-relationship-type=/g) || []).length, 5);
  assert.match(html, /data-relationships-more/);
  assert.match(html, /href="\/fixture\/session\/child-0"/);
});

test("P2b inspector groups scoped assets and hides empty scopes", () => {
  const view = deriveFixture();
  const html = renderSessionPage({
    session: cardTree().session,
    sessionTree: cardTree(),
    provider: "fixture",
    conversationView: view
  });
  const scopes = [...html.matchAll(/data-asset-scope="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(scopes, ["session", "agent", "project", "user"], "empty scopes (organization) stay absent");
  assert.match(html, /data-asset-kind="memory"/);
  assert.match(html, /data-asset-kind="skill"/);
  assert.match(html, /data-asset-kind="experience"/);
  assert.match(html, /data-asset-kind="summary"/);
  // Metadata-first: title, short summary, origin, content access, provenance.
  assert.match(html, /<strong class="inspector-asset-title">Project memory<\/strong>/);
  assert.match(html, />Remembered convention</);
  assert.match(html, /agent generated · metadata only/);
  assert.match(html, />recorded · fixture</);
  // Title falls back to the localized kind, never the raw entity id.
  assert.match(html, /<strong class="inspector-asset-title">Summary<\/strong>/);
  assert.doesNotMatch(html, /<strong class="inspector-asset-title">artifact:summary<\/strong>/);
  assert.match(html, /data-asset-id="artifact:memory"/);
  // Source links when recorded: source session + producer-run evidence link.
  assert.match(html, /href="\/fixture\/session\/child-1"/);
  assert.match(html, /data-inspector-evidence-kind="run" data-inspector-evidence-id="run-1"/);
  // Session id is presented as canonical copy, not primary entity ids.
  assert.match(html, /<code data-inspector-session-id>root<\/code>/);
});

test("P2b inspector degradation: no protocol evidence keeps truthful not-recorded states", () => {
  const html = renderSessionPage({
    session: cardTree().session,
    sessionTree: cardTree(),
    provider: "fixture"
  });
  assert.match(html, /data-conversation-layout/);
  // Without a view model there is no collaboration drawer; missing evidence
  // remains an ordinary readable page rather than an invented inspector.
  assert.doesNotMatch(html, /data-inspector-unavailable|data-reader-collaboration-overview/);
});

test("P2b disclosure and responsive hooks are present in markup and styles", () => {
  const view = deriveFixture();
  const html = renderSessionPage({
    session: cardTree().session,
    sessionTree: cardTree(),
    provider: "fixture",
    conversationView: view
  });
  assert.match(html, /<aside class="conversation-inspector" data-conversation-inspector/);
  assert.match(html, /summary class="agent-card-summary" aria-expanded="false"/);
  assert.match(html, /summary class="agent-channel-summary" aria-expanded="false"/);
  assert.match(html, /data-disclosure/);
  const style = readFileSync(path.join(process.cwd(), "dist", "src", "static", "style.css"), "utf-8");
  const script = readFileSync(path.join(process.cwd(), "dist", "src", "static", "app.js"), "utf-8");
  assert.match(style, /\.conversation-layout \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) minmax\(280px, 320px\)/);
  assert.match(style, /\.conversation-inspector \{[\s\S]*?position: sticky/);
  assert.match(style, /@media \(max-width: 1100px\) \{[\s\S]*?\.conversation-layout \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(style, /@media \(max-width: 768px\) \{[\s\S]*?\.conversation-inspector \{/);
  assert.match(script, /addEventListener\("toggle",[\s\S]*?focus\(\{ preventScroll: true \}\);[\s\S]*?\}, true\);/);
});

test("P2b channel bound truncation keeps the page bounded", () => {
  const protocol = v3Fixture({
    coordination: Array.from({ length: 60 }, (_, index) => ({
      id: `coord:message:${index}`,
      sessionId: "root",
      kind: "message",
      state: "unknown",
      timestamp: 1000 + index,
      senderActorId: "actor:child-1",
      recipientActorId: "actor:main",
      runId: "run-1",
      taskId: "task-1",
      turnId: "a2",
      provenance
    }))
  });
  const fixture = {
    protocol,
    work: projectWork(protocol),
    execution: projectExecution(protocol),
    coordination: projectCoordination(protocol),
    context: projectContext(protocol)
  };
  const view = deriveFixture(fixture);
  assert.equal(view.cards[0].channel.length, 50);
  assert.equal(view.cards[0].channelTruncated, true);
  assert.equal(view.cards[0].observationCount, 60);
});

test("P2b channel summaries use the complete assigned collection beyond the display bound", () => {
  const protocol = v3Fixture({
    agentRuns: [{ ...v3Fixture().agentRuns[0], timeStart: null, timeEnd: null }],
    coordination: [
      { id: "coord:interrupt", sessionId: "root", kind: "interrupt", state: "unknown", timestamp: 1000,
        taskId: "task-1", runId: "run-1", provenance },
      ...Array.from({ length: 50 }, (_, index) => ({
        id: `coord:message:${index}`, sessionId: "root", kind: "message", state: "unknown", timestamp: index,
        taskId: "task-1", runId: "run-1", turnId: `turn-${index}`, provenance
      }))
    ]
  });
  const view = deriveFixture({
    protocol,
    work: projectWork(protocol),
    execution: projectExecution(protocol),
    coordination: projectCoordination(protocol),
    context: projectContext(protocol)
  });
  assert.equal(view.cards[0].channel.length, 50);
  assert.equal(view.cards[0].channelTruncated, true);
  assert.equal(view.cards[0].interrupted, true);
  assert.equal(view.cards[0].state, "interrupted");
  assert.equal(view.cards[0].lastActivity, 1000);
});

// ── P2b truthful unplaced fallback (DSH evidence: run/task records without a
// transcript-part binding rendered 0 cards because the renderer only consumed
// spine-bound cards) ────────────────────────────────────────────────────────

function unplacedProtocol() {
  // run-1/task-1 stay bound to the tree's task part; run-2/task-2 name no
  // transcript part, child session, or turn (DSH-style records).
  return v3Fixture({
    tasks: [
      {
        id: "task-1", sessionId: "root", kind: "subagent-task", status: "completed",
        title: "Review docs", agentPath: "/root/worker", toolCallId: "task-part",
        assignee: "worker", dependencies: [], timeCreated: 1000, timeUpdated: 1000,
        timeCompleted: 1200, provenance
      },
      {
        id: "task-2", sessionId: "root", kind: "subagent-task", status: "completed",
        title: "Grep symbols", agentPath: "/root/worker2", toolCallId: "unbound-task-part",
        assignee: "worker2", dependencies: [], timeCreated: 1400, timeUpdated: 1400,
        timeCompleted: 1500, provenance
      }
    ],
    agentRuns: [
      {
        id: "run-1", sessionId: "root", taskId: "task-1", status: "completed",
        mode: "subagent", agent: "worker", model: "model", childSessionId: "child-1",
        timeStart: 1000, timeEnd: 1200, provenance
      },
      {
        id: "run-2", sessionId: "root", taskId: "task-2", status: "completed",
        mode: "subagent", agent: "worker2", model: "model", childSessionId: "child-9",
        timeStart: 1400, timeEnd: 1500, provenance
      }
    ],
    actors: [
      { id: "actor:main", kind: "agent", name: "main", providerActorId: "/root", sessionRef: { provider: "fixture", sessionId: "root" }, runIds: [], provenance },
      { id: "actor:child-1", kind: "agent", name: "worker", providerActorId: "/root/worker", sessionRef: { provider: "fixture", sessionId: "child-1" }, runIds: ["run-1"], provenance },
      { id: "actor:child-2", kind: "agent", name: "worker2", providerActorId: "/root/worker2", sessionRef: { provider: "fixture", sessionId: "child-9" }, runIds: ["run-2"], provenance }
    ],
    coordination: [
      {
        id: "coord:spawn:1", sessionId: "root", kind: "spawn", state: "started", timestamp: 900,
        senderActorId: "actor:main", recipientActorId: "actor:child-1",
        taskId: "task-1", runId: "run-1", turnId: "a1", provenance
      }
    ]
  });
}

function unplacedFixture() {
  const protocol = unplacedProtocol();
  return {
    protocol,
    work: projectWork(protocol),
    execution: projectExecution(protocol),
    coordination: projectCoordination(protocol),
    context: projectContext(protocol)
  };
}

function messagesSection(html) {
  const start = html.indexOf('<section id="session-messages"');
  const end = html.indexOf('<aside class="reader-collaboration', start);
  return html.slice(start, end < 0 ? undefined : end);
}

function tocSection(html) {
  return html.match(/<div class="toc-list">([\s\S]*?)<\/div>\s*<button class="toc-resize-handle"/)?.[1] || "";
}

test("P2b unbound run/task cards render exactly once in the explicit unplaced section", () => {
  const tree = cardTree();
  // Only run-2/task-2 is unbound in this fixture; the renderer must not invent
  // a causal position for it, and it must not disappear.
  const view = deriveFixture(unplacedFixture());
  assert.equal(view.cards.length, 2, "one bound and one unbound card");
  const html = renderSessionPage({
    session: tree.session,
    sessionTree: tree,
    provider: "fixture",
    conversationView: view
  });
  const messages = messagesSection(html);
  const unplaced = messages.match(/<section class="agent-cards-unplaced" data-agent-cards-unplaced>([\s\S]*?)<\/section>/)?.[1] || "";
  assert.match(messages, /data-agent-cards-unplaced/);
  // Bound run-1 stays on the spine and replaces the nested block exactly once.
  assert.match(unplaced, /data-agent-card-id="run:run-2"/);
  assert.match(messages, /data-agent-card-id="run:run-1"/);
  assert.equal((messages.match(/data-agent-card-id=/g) || []).length, 2, "both cards render exactly once");
  assert.equal((unplaced.match(/data-agent-card-id=/g) || []).length, 1, "unplaced card renders once");
  // No invented part/session anchor for the unplaced card; the card anchor is
  // the only target.
  assert.doesNotMatch(unplaced, /id="part-[^"]+"/);
  assert.doesNotMatch(unplaced, /id="session-child-9"/);
  assert.match(unplaced, /id="agent-card-run-run-2"/);
  // The unplaced card keeps its channel inside the card.
  assert.match(unplaced, /data-agent-channel/);
});

test("P2b unplaced section is empty and absent when every card binds a spine part", () => {
  const view = deriveFixture();
  const html = renderSessionPage({
    session: cardTree().session,
    sessionTree: cardTree(),
    provider: "fixture",
    conversationView: view
  });
  const messages = messagesSection(html);
  assert.doesNotMatch(messages, /data-agent-cards-unplaced/);
  assert.match(messages, /data-agent-card-id="run:run-1"/);
  assert.equal((messages.match(/data-agent-card-id=/g) || []).length, 1);
});

test("P2b raw-path sessions (no session tree) place every card once in the section", () => {
  // DSH evidence: the adapter has no session tree, so no transcript part can
  // bind a card. All three records must still render once, unanchored.
  const protocol = unplacedProtocol();
  const view = deriveFixture({ protocol, work: projectWork(protocol), execution: projectExecution(protocol), coordination: projectCoordination(protocol), context: projectContext(protocol) });
  assert.equal(view.cards.length, 2);
  const html = renderSessionPage({
    session: { id: "root", title: "root" },
    provider: "fixture",
    messages: [],
    partsByMessage: new Map(),
    conversationView: view
  });
  const messages = messagesSection(html);
  const unplaced = messages.match(/<section class="agent-cards-unplaced" data-agent-cards-unplaced>([\s\S]*?)<\/section>/)?.[1] || "";
  assert.match(messages, /data-agent-cards-unplaced/);
  assert.equal((unplaced.match(/data-agent-card-id=/g) || []).length, 2, "raw path renders every card once");
  assert.equal((messages.match(/data-agent-card-id=/g) || []).length, 2, "exactly once across the page");
  // No invented anchors, and the section is not hidden behind the empty state.
  assert.doesNotMatch(unplaced, /id="part-[^"]+"/);
  assert.match(messages, /data-agent-cards-unplaced/);
});

test("P2b unplaced cards keep canonical child-session Open/MD/JSON actions", () => {
  const view = deriveFixture(unplacedFixture());
  const html = renderSessionPage({
    session: cardTree().session,
    sessionTree: cardTree(),
    provider: "fixture",
    conversationView: view
  });
  const unplaced = messagesSection(html).match(/<section class="agent-cards-unplaced" data-agent-cards-unplaced>([\s\S]*?)<\/section>/)?.[1] || "";
  assert.match(unplaced, /data-agent-child-session="child-9"/);
  assert.match(unplaced, /href="\/fixture\/session\/child-9"/);
  assert.match(unplaced, /href="\/api\/fixture\/session\/child-9\/export\?format=md"/);
  assert.match(unplaced, /href="\/api\/fixture\/session\/child-9\/export\?format=json"/);
  assert.match(unplaced, /class="subagent-export-btn"/);
});

test("P2b unplaced section stays out of the ToC and adds no agent entries", () => {
  const view = deriveFixture(unplacedFixture());
  const html = renderSessionPage({
    session: cardTree().session,
    sessionTree: cardTree(),
    provider: "fixture",
    conversationView: view
  });
  const toc = tocSection(html);
  assert.doesNotMatch(toc, /data-agent-card|data-agent-cards-unplaced|data-agent-channel|data-channel-kind|data-agent-reference/);
  assert.doesNotMatch(toc, /href="#agent-card-/);
  assert.doesNotMatch(toc, /href="#part-task-part"/, "resolved single-child task is not duplicated");
  assert.match(toc, /href="\/fixture\/session\/child-1"/, "combined task/child reader entry remains");
  // The unplaced section lives inside the messages surface, not in the ToC.
  const messages = messagesSection(html);
  assert.match(messages, /data-agent-cards-unplaced/);
  assert.ok(toc.indexOf("data-agent-cards-unplaced") === -1);
});

test("P2b already-placed cards are never rebound to a second spine part", () => {
  const view = deriveFixture(unplacedFixture());
  // Two task parts referencing the same child session: the first consumes the
  // bound card; the second keeps the nested fallback instead of duplicating it.
  const child = childSession("child-1", "Worker session");
  const task1 = flowTool("task-part", { tool: "task", status: "completed", title: "Review docs", childSessions: [child] });
  const task2 = flowTool("other-part", { tool: "task", status: "completed", title: "Review docs", childSessions: [child], messageId: "a2" });
  const tree = flowSession("root", [
    flowMessage("u1", "user", 1000, [], { text: true }),
    flowMessage("a1", "assistant", 1100, [task1]),
    flowMessage("a2", "assistant", 1500, [task2])
  ]);
  const html = renderSessionPage({ session: tree.session, sessionTree: tree, provider: "fixture", conversationView: view });
  const messages = messagesSection(html);
  assert.equal((messages.match(/data-agent-card-id="run:run-1"/g) || []).length, 1, "bound card renders exactly once");
  assert.equal((messages.match(/class="subagent-branch"/g) || []).length, 1, "second task part keeps the nested fallback");
  assert.equal((messages.match(/data-agent-card-id=/g) || []).length, 2, "bound card plus one unplaced card");
  assert.doesNotMatch(messages, /Worker session output|id="session-child-1"|id="msg-child-1-answer"/, "child body and anchors belong to its own pane");
  assert.equal((messages.match(/id="part-other-part"/g) || []).length, 1, "the later task keeps its own tool part anchor");
  assert.match(messages, /class="subagent-existing-link"[^>]*data-reader-session="child-1"[^>]*href="\/fixture\/session\/child-1"/, "the later task links to the same canonical child");
});

test("P2b bound card actions follow the recorded child ref rather than the part's first child", () => {
  const view = deriveFixture();
  const unrelated = childSession("child-other", "Other session");
  const matching = childSession("child-1", "Worker session");
  const task = flowTool("task-part", {
    tool: "task",
    status: "running",
    title: "Review docs",
    childSessions: [unrelated, matching]
  });
  const tree = flowSession("root", [flowMessage("a1", "assistant", 1100, [task])]);
  const html = renderSessionPage({ session: tree.session, sessionTree: tree, provider: "fixture", conversationView: view });
  const messages = messagesSection(html);
  const card = messages.match(/<details class="agent-card"[\s\S]*?<\/details>/)?.[0] || "";
  assert.match(card, /href="\/fixture\/session\/child-1"/);
  assert.doesNotMatch(card, /href="\/fixture\/session\/child-other"/);
  assert.match(messages, /data-reader-session="child-other"/, "the first child remains reachable");
  assert.match(messages, /data-reader-session="child-1"/, "the recorded child remains reachable");
  const toc = tocSection(html);
  assert.match(toc, /href="\/fixture\/session\/child-other"/, "every child keeps its canonical ToC target");
  assert.match(toc, /href="\/fixture\/session\/child-1"/, "the recorded child keeps its canonical ToC target");
  assert.equal((card.match(/href="\/fixture\/session\/child-1"/g) || []).length, 1, "actions use the recorded card child exactly once");
});

test("P2b excludes only explicitly classified session turns from agent cards", () => {
  const protocol = v3Fixture({
    agentRuns: [
      { id: "turn-run", sessionId: "root", taskId: null, status: "unknown", mode: "unknown", kind: "session-turn", turnId: "turn-42", agent: null, model: null, childSessionId: null, timeStart: 1100, timeEnd: null, provenance },
      ...v3Fixture().agentRuns
    ]
  });
  const view = deriveFixture({ protocol, work: projectWork(protocol), execution: projectExecution(protocol), coordination: projectCoordination(protocol), context: projectContext(protocol) });
  assert.deepEqual(view.cards.map((card) => card.id), ["run:run-1"]);
  assert.equal(view.cards.some((card) => card.id === "run:turn-run"), false);

  const taskOnlyProtocol = v3Fixture({
    agentRuns: [{ ...protocol.agentRuns[0], id: "turn-task-run", taskId: "task-1", kind: "session-turn", turnId: "turn-43", status: "unknown", mode: "unknown" }]
  });
  const taskOnly = deriveFixture({ protocol: taskOnlyProtocol, work: projectWork(taskOnlyProtocol), execution: projectExecution(taskOnlyProtocol), coordination: projectCoordination(taskOnlyProtocol), context: projectContext(taskOnlyProtocol) });
  assert.deepEqual(taskOnly.cards.map((card) => card.id), ["task:task-1"], "a task card remains when its only run is a session turn");
});

test("P2b coordination assignment honors explicit identity and rejects ambiguous actor fallback", () => {
  const protocol = v3Fixture({
    tasks: [
      { id: "task-1", sessionId: "root", kind: "subagent-task", status: "running", title: "One", agentPath: null, toolCallId: "part-1", assignee: "worker", dependencies: [], timeCreated: 1, timeUpdated: 1, timeCompleted: null, provenance },
      { id: "task-2", sessionId: "root", kind: "subagent-task", status: "running", title: "Two", agentPath: null, toolCallId: "part-2", assignee: "worker", dependencies: [], timeCreated: 2, timeUpdated: 2, timeCompleted: null, provenance }
    ],
    agentRuns: [
      { id: "run-1", sessionId: "root", taskId: "task-1", status: "running", mode: "subagent", agent: "one", model: null, childSessionId: "child-1", timeStart: 1, timeEnd: null, provenance },
      { id: "run-2", sessionId: "root", taskId: "task-2", status: "running", mode: "subagent", agent: "two", model: null, childSessionId: "child-2", timeStart: 2, timeEnd: null, provenance }
    ],
    actors: [
      { id: "actor:main", kind: "agent", name: "main", providerActorId: "/root", sessionRef: { provider: "fixture", sessionId: "root" }, runIds: [], provenance },
      { id: "actor:one", kind: "agent", name: "one", providerActorId: "/one", sessionRef: null, runIds: ["run-1"], provenance },
      { id: "actor:shared", kind: "agent", name: "shared", providerActorId: "/shared", sessionRef: null, runIds: ["run-1", "run-2"], provenance }
    ],
    coordination: [
      { id: "coord:unknown-explicit", sessionId: "root", kind: "message", state: "delivered", timestamp: 1, senderActorId: "actor:one", recipientActorId: "actor:main", runId: "missing-run", turnId: "a1", provenance },
      { id: "coord:ambiguous-actor", sessionId: "root", kind: "message", state: "delivered", timestamp: 2, senderActorId: "actor:shared", recipientActorId: "actor:main", turnId: "a2", provenance },
      { id: "coord:unique-actor", sessionId: "root", kind: "message", state: "delivered", timestamp: 3, senderActorId: "actor:one", recipientActorId: "actor:main", turnId: "a3", taskId: null, runId: null, provenance },
      { id: "coord:explicit-task", sessionId: "root", kind: "message", state: "delivered", timestamp: 4, senderActorId: "actor:one", recipientActorId: "actor:main", taskId: "task-2", turnId: "a4", provenance },
      { id: "coord:explicit-run", sessionId: "root", kind: "message", state: "delivered", timestamp: 5, senderActorId: "actor:one", recipientActorId: "actor:main", taskId: "task-2", runId: "run-2", turnId: "a4", provenance }
    ]
  });
  const fixture = { protocol, work: projectWork(protocol), execution: projectExecution(protocol), coordination: projectCoordination(protocol), context: projectContext(protocol) };
  const view = deriveConversationView(fixture);
  assert.equal(view.cards.find((card) => card.id === "run:run-1").channel.filter((item) => item.id === "coord:unique-actor").length, 1);
  assert.equal(view.cards.find((card) => card.id === "run:run-2").channel.filter((item) => item.id === "coord:explicit-run").length, 1);
  assert.equal(view.cards.every((card) => !card.channel.some((item) => item.id === "coord:explicit-task")), true, "a task-only observation does not claim a particular run");
  assert.equal(view.cards.every((card) => !card.channel.some((item) => item.id === "coord:ambiguous-actor")), true);
  assert.equal(new Set(view.cards.flatMap((card) => card.channel.map((item) => item.id))).size, 2, "one observation cannot appear in two card channels");
});

test("P2b valid task binding keeps the task disclosure even when it has no child sessions", () => {
  const task = flowTool("task-part", { tool: "task", status: "running", title: "Review docs", childSessions: [] });
  const tree = flowSession("root", [flowMessage("a1", "assistant", 1100, [task])]);
  const html = renderSessionPage({ session: tree.session, sessionTree: tree, provider: "fixture", conversationView: deriveFixture() });
  const messages = messagesSection(html);
  assert.match(messages, /data-agent-card-id="run:run-1"/);
  assert.match(messages, /class="tool-call/);
  assert.doesNotMatch(messages, /class="subagent-branch/);
});

test("P2b explicit unavailable child evidence removes child links and gates inspector relationships", () => {
  const protocol = unplacedProtocol();
  protocol.agentRuns = protocol.agentRuns.map((run) => run.id === "run-2" ? { ...run, childSessionAvailable: false } : run);
  protocol.relationships = [{ type: "spawned", fromSessionId: "root", toSessionId: "child-9", provenance }];
  const fixture = { protocol, work: projectWork(protocol), execution: projectExecution(protocol), coordination: projectCoordination(protocol), context: projectContext(protocol) };
  const view = deriveFixture(fixture);
  const html = renderSessionPage({ session: cardTree().session, sessionTree: cardTree(), provider: "fixture", conversationView: view });
  const messages = messagesSection(html);
  const unavailable = messages.match(/data-agent-card-id="run:run-2"[\s\S]*?<\/details>/)?.[0] || "";
  assert.match(unavailable, /data-agent-child-unavailable/);
  assert.doesNotMatch(unavailable, /subagent-export-btn/);
  const relationship = html.match(/data-relationship-type="spawned"[\s\S]*?<\/li>/)?.[0] || "";
  assert.match(relationship, /data-relationship-unavailable/);
  assert.doesNotMatch(relationship, /href="\/fixture\/session\/child-9"/);
});
