import assert from "node:assert/strict";
import test from "node:test";

const { buildReaderPreview, renderReaderPreviewHtml, READER_PREVIEW_CHARS } = await import("../dist/src/reader-preview.js");
const { registerReaderPreviewRoutes } = await import("../dist/src/routes/reader-preview.js");

function documentFor(messages) {
  const normalized = messages.map((message) => ({
    id: message.id,
    data: {
      role: message.role,
      presentationPhase: message.presentationPhase,
      contentScope: message.contentScope || "owned"
    }
  }));
  return {
    messages: normalized,
    partsByMessage: new Map(normalized.map((message, index) => [message.id, [{
      id: `${message.id}:text`,
      contentScope: messages[index].contentScope || "owned",
      data: { type: messages[index].partType || "text", text: messages[index].content, questionAnswers: messages[index].questionAnswers }
    }]]))
  };
}

function captureRoute(adapter) {
  const routes = [];
  registerReaderPreviewRoutes({ get(pattern, handler) { routes.push({ pattern, handler }); } }, {
    appConfig: { port: 0, metaDir: "." },
    providerMap: new Map([["fixture", adapter]]),
    providerInfo: []
  });
  const route = routes[0];
  return async (path) => {
    assert.ok(route.pattern.test(path));
    const response = {
      status: 0,
      body: "",
      writeHead(status) { this.status = status; },
      end(body) { this.body = String(body || ""); }
    };
    await route.handler({ url: path }, response, path.match(route.pattern));
    return { status: response.status, data: response.body ? JSON.parse(response.body) : null };
  };
}

test("reader preview selects the first owned request and latest final reply", () => {
  const preview = buildReaderPreview(documentFor([
    { id: "inherited", role: "user", content: "Copied parent request", contentScope: "inherited-context" },
    { id: "request", role: "user", content: "Inspect the selected task" },
    { id: "first-final", role: "assistant", content: "Old final", presentationPhase: "final" },
    { id: "latest-final", role: "assistant", content: "Latest final", presentationPhase: "final" },
    { id: "commentary", role: "assistant", content: "Later commentary", presentationPhase: "commentary" }
  ]), "fixture", "child");
  assert.equal(preview.request.text, "Inspect the selected task");
  assert.equal(preview.request.phase, "initial");
  assert.equal(preview.request.source.partId, "request:text");
  assert.equal(preview.reply.text, "Latest final");
  assert.equal(preview.reply.phase, "final");
  assert.equal(preview.reply.source.anchor, "part-latest-final-text");
  assert.equal(preview.reply.source.href, "/fixture/session/child#part-latest-final-text");
});

test("reader preview falls back to latest readable assistant and marks unavailable slots", () => {
  const preview = buildReaderPreview(documentFor([
    { id: "encrypted", role: "user", content: { type: "encrypted_content" } },
    { id: "reasoning", role: "assistant", content: "Reasoning must stay out", partType: "reasoning" },
    { id: "system", role: "system", content: "System text must stay out" },
    { id: "tool", role: "tool", content: "Tool output must stay out", partType: "tool" },
    { id: "assistant", role: "assistant", content: "Recorded progress" },
  ]), "fixture", "child");
  assert.equal(preview.request.available, false);
  assert.equal(preview.request.reason, "no-readable-content");
  assert.equal(preview.reply.text, "Recorded progress");
  assert.equal(preview.reply.phase, "latest");
  const empty = buildReaderPreview(documentFor([]), "fixture", "child");
  assert.deepEqual(empty.reply, {
    available: false,
    text: null,
    phase: null,
    source: null,
    reason: "no-readable-content"
  });
});

test("reader preview is bounded and HTML escaped", () => {
  const raw = `<script>alert("unsafe")</script>${" readable".repeat(100)}`;
  const preview = buildReaderPreview(documentFor([
    { id: "request", role: "user", content: raw },
    { id: "reply", role: "assistant", content: raw, presentationPhase: "final" }
  ]), "fixture", "child");
  assert.equal(preview.reply.text.length, READER_PREVIEW_CHARS);
  const html = renderReaderPreviewHtml(preview);
  assert.ok(!html.includes("<script>alert"));
  assert.match(html, /&lt;script&gt;alert/);
  assert.match(html, /data-reader-source[^>]*data-reader-source-id="reply:text"[^>]*data-reader-anchor="part-reply-text"/);
});

test("reader preview uses bounded question answer presentation and retains the original source identity", () => {
  const questionAnswers = [{ id: "question-item", question: "Choose <script>safe</script>?", answer: "Yes, safely." }];
  const raw = `<send_user_message_question_reply>${JSON.stringify(questionAnswers)}</send_user_message_question_reply>`;
  const document = documentFor([{ id: "request", role: "user", content: raw, questionAnswers }]);
  const preview = buildReaderPreview(document, "fixture", "child");
  assert.equal(preview.request.text, "Choose <script>safe</script>?\n\nYes, safely.");
  assert.equal(preview.request.source.partId, "request:text");
  assert.equal(preview.request.source.href, "/fixture/session/child#part-request-text");
  assert.equal(document.partsByMessage.get("request")[0].data.text, raw);
  const html = renderReaderPreviewHtml(preview);
  assert.match(html, /Choose &lt;script&gt;safe&lt;\/script&gt;/);
  assert.match(html, /Yes, safely\./);
  assert.doesNotMatch(html, /send_user_message_question_reply|question-item|<script>/);
  questionAnswers[0].answer = "Long answer ".repeat(100);
  const bounded = buildReaderPreview(document, "fixture", "child");
  assert.equal(bounded.request.text.length, READER_PREVIEW_CHARS);
  assert.ok(bounded.request.text.endsWith("…"));
});

test("preview route preserves typed question answers through normalized document mapping", async () => {
  const questionAnswers = [{ id: "question-item", question: "Which option?", answer: "Recorded choice" }];
  const raw = `<send_user_message_question_reply>${JSON.stringify(questionAnswers.map(({ id, ...item }) => ({ questionItemId: id, ...item })))}</send_user_message_question_reply>`;
  const adapter = {
    id: "fixture",
    getSession(id) { return { id, title: "Child" }; },
    getMessages(id) { return [{ id: "request", sessionId: id, role: "user", content: raw, questionAnswers }]; }
  };
  const response = await captureRoute(adapter)("/api/fixture/session/child/reader/preview");
  assert.equal(response.status, 200);
  assert.equal(response.data.request.text, "Which option?\n\nRecorded choice");
  assert.equal(response.data.request.source.sourceId, "request:text");
  assert.doesNotMatch(response.data.html, /send_user_message_question_reply|questionItemId/);
});

test("preview route reads only the selected canonical session", async () => {
  let getSessionCalls = 0;
  let getMessagesCalls = 0;
  const adapter = {
    id: "fixture",
    getSession(id) {
      getSessionCalls += 1;
      if (id === "child") return { id: "child", parentId: "root", title: "Child" };
      return null;
    },
    getMessages(id) {
      getMessagesCalls += 1;
      assert.equal(id, "child");
      return [{ id: "reply", sessionId: "child", role: "assistant", content: "Child reply", presentationPhase: "final" }];
    }
  };
  const request = captureRoute(adapter);
  const response = await request("/api/fixture/session/child/reader/preview");
  assert.equal(response.status, 200);
  assert.equal(response.data.ok, true);
  assert.equal(response.data.request.reason, "no-readable-content");
  assert.equal(response.data.reply.text, "Child reply");
  assert.equal(response.data.reply.source.sourceId, "reply:text");
  assert.equal(getSessionCalls, 1);
  assert.equal(getMessagesCalls, 1);
  const callsBeforeMissing = getSessionCalls;
  const missing = await request("/api/fixture/session/wrong/reader/preview");
  assert.equal(missing.status, 404);
  assert.equal(getSessionCalls, callsBeforeMissing + 1);
  assert.equal(getMessagesCalls, 1);
});
