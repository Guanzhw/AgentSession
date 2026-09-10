import assert from "node:assert/strict";
import test from "node:test";
import { renderSessionPage } from "../dist/src/views/session.js";

function metrics(messageCount) {
  return {
    messageCount,
    partCount: messageCount,
    toolCallCount: 0,
    directChildCount: 0,
    descendantCount: 0,
    totalMessages: messageCount,
    totalToolCalls: 0,
    directInputTokens: 0,
    directOutputTokens: 0,
    directReasoningTokens: 0,
    directCacheReadTokens: 0,
    directCacheWriteTokens: 0,
    directCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    timeStart: 1000,
    timeEnd: 3000,
    runtimeMs: 2000
  };
}

function textPart(messageId, text) {
  return {
    kind: "part",
    id: `${messageId}-text-part`,
    messageId,
    sessionId: "root",
    type: "text",
    tool: null,
    title: text,
    timeStart: 0,
    timeEnd: 0,
    childSessions: [],
    data: { type: "text", text }
  };
}

function toolPart(messageId, output = "tool result") {
  return {
    kind: "part",
    id: `${messageId}-tool-part`,
    messageId,
    sessionId: "root",
    type: "tool",
    tool: "read",
    title: "read",
    timeStart: 0,
    timeEnd: 0,
    childSessions: [],
    data: {
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { filePath: "README.md" }, output }
    }
  };
}

function message(id, role, timeCreated, parts, presentationPhase) {
  return {
    kind: "message",
    id,
    sessionId: "root",
    role,
    title: id,
    timeCreated,
    parts,
    data: { role, presentationPhase }
  };
}

function tree(messages) {
  return {
    kind: "session",
    id: "root",
    title: "phase fixture",
    depth: 0,
    attachMode: "root",
    session: { id: "root", title: "phase fixture" },
    messages,
    detachedChildren: [],
    metrics: metrics(messages.length)
  };
}

function render(messages, conversationCompactions = []) {
  const sessionTree = tree(messages);
  return renderSessionPage({
    session: sessionTree.session,
    sessionTree,
    provider: "fixture",
    conversationCompactions
  });
}

function threadOf(html) {
  return html.slice(html.indexOf('<section id="session-messages"'));
}

function tocOf(html) {
  return html.match(/<div class="toc-list">([\s\S]*?)<\/div>\s*<button class="toc-resize-handle"/)?.[1] || "";
}

test("Conversation SSR folds process only before a later final and keeps the tail open", () => {
  const html = render([
    message("u1", "user", 1000, [textPart("u1", "user question")]),
    message("c1", "assistant", 1100, [textPart("c1", "commentary process")], "commentary"),
    message("tool1", "tool", 1200, [toolPart("tool1")]),
    message("f1", "assistant", 1300, [textPart("f1", "recorded final")], "final"),
    message("unknown1", "assistant", 1400, [textPart("unknown1", "unclassified communication")]),
    message("c2", "assistant", 1500, [textPart("c2", "later commentary")], "commentary")
  ]);
  const thread = threadOf(html);
  const disclosures = thread.match(/data-conversation-process(?:-count)?=/g) || [];
  assert.equal((thread.match(/data-conversation-process-count=/g) || []).length, 1);
  assert.match(thread, /data-conversation-process-count="2"/);
  assert.doesNotMatch(thread, /<details class="conversation-process-disclosure"[^>]* open/);
  assert.ok(disclosures.length >= 1);
  assert.match(thread, /commentary process/);
  assert.match(thread, /read/);
  assert.match(thread, /recorded final/);
  assert.match(thread, /unclassified communication/);
  assert.match(thread, /later commentary/);
  const firstDisclosure = thread.indexOf("data-conversation-process-count=\"2\"");
  const unknown = thread.indexOf("unclassified communication");
  assert.ok(firstDisclosure >= 0 && unknown > firstDisclosure, "unknown text remains after the process disclosure");
  const firstDisclosureEnd = thread.indexOf("</details>", firstDisclosure);
  assert.ok(firstDisclosureEnd >= 0 && unknown > firstDisclosureEnd, "unknown text is not swallowed into process");

  const toc = tocOf(html);
  assert.doesNotMatch(toc, /commentary process/);
  assert.match(toc, /later commentary/);
  assert.match(toc, /recorded final/);
  assert.match(toc, /unclassified communication/);
});

test("Conversation SSR keeps commentary and internal process visible when no final is recorded", () => {
  const html = render([
    message("u1", "user", 1000, [textPart("u1", "open question")]),
    message("c1", "assistant", 1100, [textPart("c1", "open commentary")], "commentary"),
    message("tool1", "tool", 1200, [toolPart("tool1", "open tool result")])
  ]);
  const thread = threadOf(html);
  assert.doesNotMatch(thread, /data-conversation-process-count=/);
  assert.match(thread, /open commentary/);
  assert.match(thread, /open tool result/);
  assert.doesNotMatch(thread, /<details class="conversation-process-disclosure"/);
});

test("Conversation SSR does not combine process disclosures across a checkpoint", () => {
  const html = render([
    message("u1", "user", 1000, [textPart("u1", "checkpoint question")]),
    message("c1", "assistant", 1100, [textPart("c1", "before checkpoint")], "commentary"),
    message("f1", "assistant", 1200, [textPart("f1", "final reply")], "final"),
    message("c2", "assistant", 1300, [textPart("c2", "before second final")], "commentary"),
    message("f2", "assistant", 1400, [textPart("f2", "second final")], "final"),
    message("c3", "assistant", 1500, [textPart("c3", "open tail")], "commentary")
  ], [{
    id: "cp-1",
    anchorMessageId: "f1",
    timestamp: 1200,
    tokensBefore: 10,
    tokensAfter: 5,
    summary: "checkpoint result",
    strategy: "summary",
    trigger: "automatic",
    continuationSessionId: null,
    fidelity: "recorded"
  }]);
  const thread = threadOf(html);
  assert.equal((thread.match(/data-conversation-process-count=/g) || []).length, 2);
  const first = thread.indexOf("before checkpoint");
  const checkpoint = thread.indexOf('data-compaction-checkpoint="cp-1"');
  const second = thread.indexOf("before second final");
  assert.ok(first < checkpoint && checkpoint < second, "checkpoint remains between causal process blocks");
  assert.match(thread, /open tail/);
});
