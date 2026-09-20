import assert from "node:assert/strict";
import test from "node:test";
import { renderSessionReaderPane } from "../dist/src/views/session.js";

const metrics = {
  messageCount: 0, partCount: 0, toolCallCount: 0, directChildCount: 0, descendantCount: 0,
  totalMessages: 0, totalToolCalls: 0, directInputTokens: 0, directOutputTokens: 0,
  directReasoningTokens: 0, directCacheReadTokens: 0, directCacheWriteTokens: 0, directCost: 0,
  inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  cost: 0, timeStart: 0, timeEnd: 0, runtimeMs: 0
};

function textPart(messageId, text) {
  return {
    id: `${messageId}:text`, messageId, sessionId: "root", type: "text", tool: null,
    data: { type: "text", text }, timeStart: 1, timeEnd: 1, childSessions: []
  };
}

function toolPart(messageId, status = "completed") {
  return {
    id: `${messageId}:tool`, messageId, sessionId: "root", type: "tool", tool: "exec",
    data: { type: "tool", tool: "exec", state: { status, input: { command: messageId }, output: status === "error" ? "failed" : "ok" } },
    timeStart: 1, timeEnd: 2, childSessions: []
  };
}

function message(id, role, parts, data = {}) {
  return { id, sessionId: "root", role, timeCreated: 1, data: { role, ...data }, parts };
}

function tree(messages) {
  return { session: { id: "root", title: "Response units" }, messages, detachedChildren: [], metrics };
}

function render(messages, options = {}) {
  return renderSessionReaderPane({
    session: { id: "root", title: "Response units" },
    sessionTree: tree(messages),
    provider: "fixture",
    ...options
  });
}

function owner(html, id) {
  const end = html.indexOf(`id="msg-${id}"`);
  assert.ok(end >= 0, `${id} anchor exists`);
  const stack = [];
  for (const match of html.slice(0, end).matchAll(/<details\b[^>]*>|<\/details>/g)) {
    if (match[0] === "</details>") stack.pop();
    else stack.push(match[0]);
  }
  return stack;
}

test("adjacent pure-process assistant shells form one unit without a later final", () => {
  const messages = [
    message("request", "user", [textPart("request", "Run the task")]),
    ...Array.from({ length: 6 }, (_, index) => message(`process-${index}`, "assistant", [toolPart(`process-${index}`)], {
      model: { providerID: "fixture", modelID: "model-a" },
      tokens: { input: 10, output: 2, total: 12, cache: { read: 3, write: 0 } },
      tokenRequests: [{ input: 10, output: 2, total: 12, cache: { read: 3, write: 0 } }],
      tokenRequestCount: 1
    }))
  ];
  const html = render(messages);
  assert.equal((html.match(/data-conversation-process(?=[ =])/g) || []).length, 1);
  assert.match(html, /data-conversation-process-count="6"/);
  for (const id of ["process-0", "process-5"]) assert.equal(owner(html, id).filter((tag) => tag.includes("data-conversation-process")).length, 1);
  assert.match(html, /model-a/);
  assert.match(html, /message-context-length/);
});

test("unknown-phase text, attention, milestones, compact barriers, and user boundaries stay visible", () => {
  const messages = [
    message("request", "user", [textPart("request", "First request")]),
    message("process-before", "assistant", [toolPart("process-before")]),
    message("unknown", "assistant", [textPart("unknown", "Recorded but unclassified text")], { presentationPhase: "unclassified" }),
    message("failed", "assistant", [toolPart("failed", "error")]),
    message("process-after", "assistant", [toolPart("process-after")]),
    message("second-request", "user", [textPart("second-request", "Second request")]),
    message("second-process", "assistant", [toolPart("second-process")])
  ];
  const readerRelations = {
    lanes: [{ id: "worker", name: "Worker", childSession: null, runIds: ["run"] }],
    unplaced: [],
    milestones: [{
      id: "spawn", laneId: "worker", kind: "spawn", eventId: "event-spawn", sequence: 1,
      timestamp: 1000, runId: "run", sourceEventRef: { session: { provider: "fixture", sessionId: "root" }, eventId: "event-spawn" },
      position: { messageId: "process-after", partId: null, side: "before" }
    }]
  };
  const html = render(messages, {
    readerRelations,
    conversationCompactions: [{ id: "checkpoint", summary: null, anchorMessageId: "process-after", timestamp: 3, tokensBefore: null, tokensAfter: null, strategy: null, trigger: null, continuationSessionId: null, fidelity: "recorded" }]
  });
  assert.equal(owner(html, "unknown").filter((tag) => tag.includes("data-conversation-process")).length, 0);
  assert.equal(owner(html, "failed").filter((tag) => tag.includes("data-conversation-process")).length, 0);
  assert.equal(owner(html, "process-after").filter((tag) => tag.includes("data-conversation-process")).length, 0, "coordination milestone is a visible barrier");
  assert.ok((html.match(/data-conversation-process(?=[ =])/g) || []).length >= 2);
  assert.match(html, /data-compaction-checkpoint="checkpoint"/);
  assert.ok(html.indexOf("Second request") > html.indexOf("First request"));
});

test("response-unit usage sums owned requests, preserves models, and keeps the last context", () => {
  const messages = [
    message("request", "user", [textPart("request", "Measure")]),
    message("first", "assistant", [toolPart("first")], {
      model: { providerID: "fixture", modelID: "model-a" },
      tokenRequests: [{ input: 80, output: 10, total: 90, cache: { read: 20, write: 0 } }], tokenRequestCount: 1,
      tokens: { input: 80, output: 10, total: 90, cache: { read: 20, write: 0 } }
    }),
    message("second", "assistant", [toolPart("second")], {
      model: { providerID: "fixture", modelID: "model-b" },
      tokenRequests: [{ input: 160, output: 20, total: 180, cache: { read: 40, write: 0 } }], tokenRequestCount: 1,
      tokens: { input: 160, output: 20, total: 180, cache: { read: 40, write: 0 } }
    })
  ];
  const html = render(messages);
  assert.match(html, /fixture\/model-a · fixture\/model-b/);
  assert.match(html, /message-token-requests/);
  assert.match(html, /message-context-length[^>]*title="[^"]*200/);
  assert.doesNotMatch(html, /context[^>]*title="[^"]*300/);
  assert.match(html, /data-conversation-process-count="2"/);
});
