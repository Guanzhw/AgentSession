import assert from "node:assert/strict";
import test from "node:test";
import { renderSessionPage, renderSessionReaderPane, renderReaderProcessChunk } from "../dist/src/views/session.js";
import { renderProgressiveContent, resolveProgressiveField } from "../dist/src/views/components.js";

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

function reasoningPart(messageId, text) {
  return {
    kind: "part", id: `${messageId}-reasoning-part`, messageId, sessionId: "root",
    type: "reasoning", tool: null, title: "reasoning", timeStart: 0, timeEnd: 0,
    childSessions: [], data: { type: "reasoning", text }
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

function render(messages, conversationCompactions = [], readerRelations = null) {
  const sessionTree = tree(messages);
  const readerPane = readerRelations ? renderSessionReaderPane({
    session: sessionTree.session,
    sessionTree,
    provider: "fixture",
    conversationCompactions,
    readerRelations
  }) : "";
  return renderSessionPage({
    session: sessionTree.session,
    sessionTree,
    provider: "fixture",
    conversationCompactions,
    readerPane
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

test("Conversation SSR keeps unfinished commentary visible and tool detail expandable", () => {
  const tool = toolPart("tool1", "open tool result");
  const html = render([
    message("u1", "user", 1000, [textPart("u1", "open question")]),
    message("c1", "assistant", 1100, [textPart("c1", "open commentary")], "commentary"),
    message("tool1", "tool", 1200, [tool])
  ]);
  const thread = threadOf(html);
  assert.match(thread, /data-conversation-process-count="1"/);
  assert.ok(thread.indexOf("open commentary") < thread.indexOf("data-conversation-process-count"), "unfinished prose stays outside the tool-only unit");
  assert.match(thread, /open commentary/);
  assert.match(thread, /id="msg-tool1"[\s\S]*id="part-tool1-tool-part"[^>]*data-reader-process-anchor/);
  assert.doesNotMatch(thread, /open tool result/);
  const field = resolveProgressiveField(tool.data, "output");
  const page = renderProgressiveContent(field.value, field.format, 0, field.limit);
  assert.match(page.html, /open tool result/);
  assert.equal(page.nextOffset, null);
  assert.match(thread, /data-reader-execution-count="1"/);
  assert.ok(thread.indexOf("open commentary") < thread.indexOf("data-reader-execution"));
  assert.doesNotMatch(thread, /<details[^>]*data-reader-execution[^>]*\sopen(?:\s|>)/);
});

test("Conversation SSR combines a message's trailing tool with five adjacent process messages", () => {
  const first = message("answer", "assistant", 1100, [textPart("answer", "Readable progress"), reasoningPart("answer", "First reasoning"), toolPart("answer")], "commentary");
  first.data.tokens = { input: 101, output: 3, total: 104 };
  const later = Array.from({ length: 5 }, (_, index) => {
    const id = `step-${index}`;
    const item = message(id, "assistant", 1200 + index, index === 0
      ? [reasoningPart(id, "Later reasoning"), toolPart(id)] : [toolPart(id)]);
    item.data.tokens = { input: 10 + index, output: 1, total: 11 + index };
    return item;
  });
  const messages = [
    message("u1", "user", 1000, [textPart("u1", "Question")]), first, ...later,
    message("done", "assistant", 1300, [textPart("done", "Final answer")], "final")
  ];
  const thread = threadOf(render(messages));
  assert.deepEqual([...thread.matchAll(/data-conversation-process-count="(\d+)"/g)].map((match) => match[1]), ["6"]);
  assert.equal((thread.match(/data-reader-execution-count=/g) || []).length, 0, "no nested process doorways");
  assert.ok(thread.indexOf("Readable progress") < thread.indexOf('data-conversation-process-count="6"'));
  const process = thread.slice(thread.indexOf('data-conversation-process-count="6"'), thread.indexOf("Final answer"));
  const anchors = ["answer", ...later.map((item) => item.id)].map((id) => `id="part-${id}-tool-part"`);
  for (let index = 0; index < anchors.length; index += 1) {
    assert.equal((process.match(new RegExp(anchors[index], "g")) || []).length, 1, `${anchors[index]} appears once`);
    if (index) assert.ok(process.indexOf(anchors[index - 1]) < process.indexOf(anchors[index]));
  }
  for (const id of ["answer", ...later.map((item) => item.id)]) {
    assert.equal((thread.match(new RegExp(`id="msg-${id}"`, "g")) || []).length, 1, `canonical message ${id} retained`);
  }
  assert.ok(thread.indexOf('id="msg-answer"') < thread.indexOf('data-conversation-process-count="6"'));
  assert.equal((process.match(/id="msg-answer"/g) || []).length, 0, "the first message stays outside the merged doorway");
  assert.equal((process.match(/data-reader-process-chunk/g) || []).length, 6);
  const summary = process.slice(0, process.indexOf("</summary>"));
  assert.match(summary, /Total tokens across 5 model requests: 65/);
  assert.match(summary, /message-context-length[^>]*title="[^"]*14/);
  assert.doesNotMatch(summary, /101|104/, "prior message's token usage is not added to the merged summary");
  assert.match(process, /data-reader-process-origin-message="answer"/);
  assert.match(process, /id="part-answer-reasoning-part"/);
  assert.match(process, /id="part-step-0-reasoning-part"/);
  const sessionTree = tree(messages);
  const firstChunk = renderReaderProcessChunk({ sessionTree, messageId: "answer", firstPartId: "answer-tool-part", lastPartId: "answer-tool-part" });
  const laterChunk = renderReaderProcessChunk({ sessionTree, messageId: "step-0", firstPartId: "step-0-tool-part", lastPartId: "step-0-tool-part" });
  assert.match(firstChunk.html, /data-progressive-part-id="answer-reasoning-part" data-progressive-field="reasoning"/);
  assert.doesNotMatch(firstChunk.html, /step-0-reasoning-part/);
  assert.match(laterChunk.html, /data-progressive-part-id="step-0-reasoning-part" data-progressive-field="reasoning"/);
  assert.doesNotMatch(laterChunk.html, /answer-reasoning-part/);
  for (const [part, expected] of [[first.parts[1], "First reasoning"], [later[0].parts[0], "Later reasoning"]]) {
    const field = resolveProgressiveField(part.data, "reasoning");
    assert.match(renderProgressiveContent(field.value, field.format, 0, field.limit).html, new RegExp(expected));
  }
});

test("Conversation SSR combines trailing process after a visible result milestone with five adjacent process messages", () => {
  const first = message("teaching-review", "assistant", 1100, [
    textPart("teaching-review", "Review result received"),
    toolPart("teaching-review")
  ], "commentary");
  const later = Array.from({ length: 5 }, (_, index) => {
    const id = `devils-advocate-${index}`;
    return message(id, "assistant", 1200 + index, [toolPart(id)]);
  });
  const lane = { id: "teaching-review", name: "teaching_review", childSession: null, runIds: ["review-run"] };
  const readerRelations = {
    lanes: [lane],
    unplaced: [],
    milestones: [{
      id: "review-result",
      laneId: lane.id,
      kind: "result-delivery",
      eventId: "review-result-event",
      sequence: 1,
      timestamp: 1100,
      runId: "review-run",
      sourceEventRef: { session: { provider: "fixture", sessionId: "root" }, eventId: "review-result-event" },
      position: { messageId: first.id, partId: first.parts[0].id, side: "after" }
    }]
  };
  const thread = threadOf(render([
    message("u1", "user", 1000, [textPart("u1", "Question")]),
    first,
    ...later,
    message("done", "assistant", 1300, [textPart("done", "Final answer")], "final")
  ], [], readerRelations));

  assert.deepEqual([...thread.matchAll(/data-conversation-process-count="(\d+)"/g)].map((match) => match[1]), ["6"]);
  const milestone = thread.indexOf('id="milestone-review-result"');
  const process = thread.indexOf('data-conversation-process-count="6"');
  assert.ok(milestone >= 0 && milestone < process, "the result card stays before the combined process doorway");
  assert.equal((thread.match(/id="milestone-review-result"/g) || []).length, 1);
  assert.equal((thread.slice(process).match(/data-reader-process-chunk/g) || []).length, 6);
});

test("Conversation SSR retains trailing reasoning in its original message instead of combining it", () => {
  const thread = threadOf(render([
    message("u1", "user", 1000, [textPart("u1", "Question")]),
    message("answer", "assistant", 1100, [textPart("answer", "Progress"), toolPart("answer"), reasoningPart("answer", "Unfinished thought")]),
    message("next", "assistant", 1200, [toolPart("next")])
  ]));
  assert.doesNotMatch(thread, /data-conversation-process-count="2"/);
  assert.match(thread, /data-progressive-part-id="answer-reasoning-part" data-progressive-field="reasoning"/);
  assert.equal((thread.match(/id="msg-answer"/g) || []).length, 1);
});

test("Conversation SSR keeps a final reply, error, and checkpoint between process runs", () => {
  const first = message("answer", "assistant", 1100, [textPart("answer", "Readable progress"), toolPart("answer")]);
  const second = message("next", "assistant", 1200, [toolPart("next")]);
  const final = message("final", "assistant", 1150, [textPart("final", "Recorded result")], "final");
  const failed = toolPart("failed");
  failed.data.state.status = "failed";
  const cases = [
    { messages: [first, final, second], compactions: [] },
    { messages: [message("failed", "assistant", 1100, [textPart("failed", "Warning"), failed]), second], compactions: [] },
    { messages: [first, second], compactions: [{ id: "cp-1", anchorMessageId: "answer", timestamp: 1100 }] }
  ];
  for (const { messages, compactions } of cases) {
    const thread = threadOf(render([message("u1", "user", 1000, [textPart("u1", "Question")]), ...messages], compactions));
    assert.doesNotMatch(thread, /data-conversation-process-count="2"/, "boundary separates adjacent executions");
    assert.equal((thread.match(/data-reader-execution-count="1"/g) || []).length, 2);
  }
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
