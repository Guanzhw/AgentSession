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
      data: { type: messages[index].partType || "text", text: messages[index].content }
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
