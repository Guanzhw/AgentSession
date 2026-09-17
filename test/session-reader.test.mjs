import assert from "node:assert/strict";
import test from "node:test";

const { renderSessionPage, renderSessionReaderPane } = await import("../dist/src/views/session.js");
const { registerSessionDetail } = await import("../dist/src/routes/session-detail.js");
const { reasoningBlock, toolCallBlock, renderProgressiveContent } = await import("../dist/src/views/components.js");
const { anchorId } = await import("../dist/src/views/anchors.js");
const { buildPartsFromProviderMessages } = await import("../dist/src/session-queries.js");
const { buildMessageSessionTree } = await import("../dist/src/providers/shared/message-session.js");

test("mapped document part identities stay aligned with the shared reader tree", () => {
  const messages = [
    {
      id: "assistant:0", sessionId: "session", role: "assistant", content: "answer",
      thinking: "reasoning", timestamp: 1, metadata: { turnId: "turn-1" }
    },
    {
      id: "assistant:1", sessionId: "session", role: "assistant", content: "continuation",
      thinking: null, timestamp: 2, metadata: { turnId: "turn-1" }
    },
    {
      id: "tool-call", sessionId: "session", role: "tool", content: "",
      toolName: "run", toolInput: { command: "echo" }, timestamp: 3, metadata: null
    }
  ];
  const mapped = buildPartsFromProviderMessages(messages);
  const tree = buildMessageSessionTree({ id: "session", title: "Session" }, messages);
  const documentPartIds = [...mapped.partsByMessage.values()].flat().map((part) => part.id);
  const readerPartIds = tree.messages.flatMap((message) => message.parts.map((part) => part.id));
  assert.deepEqual(documentPartIds, readerPartIds);
  assert.ok(documentPartIds.includes("assistant:0:text"));
  assert.ok(documentPartIds.includes("assistant:0:reasoning"));
  assert.ok(documentPartIds.includes("tool-call:tool"));
});

test("plain tool search fields exclude the display heading from occurrence order", () => {
  const html = toolCallBlock("run", {}, "output output", "completed", null, "tool-search");
  const outputField = html.match(/<div[^>]*data-content-field="output"[^>]*>[\s\S]*?<\/div>/)?.[0];
  assert.ok(outputField);
  assert.doesNotMatch(outputField, /<h4>/);
  assert.match(outputField, /data-progressive-field="output"/);
  assert.match(outputField, /data-next-offset="0"/);
  const loaded = renderProgressiveContent("output output", "auto");
  assert.doesNotMatch(loaded.html, /<h4>/);
  assert.equal((loaded.html.match(/output/g) || []).length, 2);
});

test("native part anchors normalize punctuation consistently across source renderers", () => {
  const toolPartId = "call_yF7NacFLdY8grlhmTTxruqIA:tool";
  const reasoningPartId = "call_yF7NacFLdY8grlhmTTxruqIA:reasoning";
  const expectedToolAnchor = anchorId("part", toolPartId);
  const expectedReasoningAnchor = anchorId("part", reasoningPartId);
  assert.match(toolCallBlock("run", {}, "output", "completed", null, toolPartId), new RegExp(`id="${expectedToolAnchor}"`));
  assert.match(reasoningBlock("thinking", "", reasoningPartId), new RegExp(`id="${expectedReasoningAnchor}"`));
  assert.equal(expectedToolAnchor, "part-call_yF7NacFLdY8grlhmTTxruqIA-tool");
  assert.equal(expectedReasoningAnchor, "part-call_yF7NacFLdY8grlhmTTxruqIA-reasoning");
});

test("reader transcript and ToC share normalized punctuation anchors", () => {
  const messageId = "turn:source/1";
  const partId = "call_yF7NacFLdY8grlhmTTxruqIA:tool";
  const tree = {
    session: { id: "anchor-session", title: "Anchor session" },
    messages: [{
      id: messageId, sessionId: "anchor-session", role: "user", timeCreated: 1,
      data: { role: "user" },
      parts: [
        { id: "text:source", messageId, sessionId: "anchor-session", type: "text", childSessions: [], data: { type: "text", text: "Open source" } },
        { id: partId, messageId, sessionId: "anchor-session", type: "tool", childSessions: [], data: { type: "tool", tool: "run", state: { status: "completed", output: "done" } } }
      ]
    }],
    detachedChildren: [],
    metrics: { totalMessages: 1, totalToolCalls: 1, descendantCount: 0, directChildCount: 0,
      inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, runtimeMs: 0 }
  };
  const pane = renderSessionReaderPane({ session: tree.session, sessionTree: tree, provider: "fixture" });
  assert.match(pane, /href="#msg-turn-source-1"/);
  assert.match(pane, /id="msg-turn-source-1"/);
  assert.match(pane, new RegExp(`id="${anchorId("part", partId)}" data-part-id="${partId}"`));
});

test("context result preserves provider source errors and unavailable diagnostics", async () => {
  const provider = {
    id: "reader-context-errors",
    getSession(id) { return { id, title: "Source failure" }; },
    getMessages() { return []; },
    getSessionProtocol() { throw new Error("Fixture source could not be read"); }
  };
  const routes = [];
  registerSessionDetail({ get(pattern, handler) { routes.push({ pattern, handler }); } }, {
    appConfig: { port: 0, metaDir: ".", resumeCommands: {}, allowTerminalLaunch: false },
    providerMap: new Map([[provider.id, provider]]), providerInfo: []
  });
  const route = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.endsWith("context-result$"));
  const path = `/api/${provider.id}/session/root/context-result`;
  const invoke = async () => {
    const response = { status: 0, body: "", writeHead(status) { this.status = status; }, end(body = "") { this.body += body; } };
    await route.handler({ url: `${path}?checkpoint=checkpoint-1` }, response, path.match(route.pattern));
    return { status: response.status, body: JSON.parse(response.body) };
  };
  const failed = await invoke();
  assert.equal(failed.status, 500, "source failure is not relabeled as a missing checkpoint");
  delete provider.getSessionProtocol;
  const unavailable = await invoke();
  assert.equal(unavailable.status, 404);
  assert.equal(unavailable.body.code, "protocol_unavailable");
  provider.getContextChangeResult = () => null;
  const unknown = await invoke();
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, "Context checkpoint not found");
});

function childTree(id, title, text) {
  return {
    session: { id, title },
    messages: [{
      id: `${id}-message`,
      sessionId: id,
      role: "assistant",
      timeCreated: 2,
      data: { role: "assistant" },
      parts: [{
        id: `${id}-text`, messageId: `${id}-message`, sessionId: id,
        type: "text", childSessions: [], data: { type: "text", text }
      }]
    }],
    detachedChildren: [],
    metrics: { totalMessages: 1, totalToolCalls: 0, descendantCount: 0, directChildCount: 0,
      inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, runtimeMs: 0 }
  };
}

function rootTree() {
  const child = childTree("child-1", "Child reader", "child-owned body");
  const task = {
    id: "task-part", messageId: "root-answer", sessionId: "root", type: "tool", childSessions: [child],
    data: { type: "tool", tool: "task", state: { status: "completed", input: { description: "Read child" }, output: "done" } }
  };
  return {
    session: { id: "root", title: "Root reader" },
    messages: [{
      id: "root-answer", sessionId: "root", role: "assistant", timeCreated: 1, data: { role: "assistant" },
      parts: [{ id: "root-text", messageId: "root-answer", sessionId: "root", type: "text", childSessions: [], data: { type: "text", text: "root-owned body" } }, task]
    }],
    detachedChildren: [],
    metrics: { totalMessages: 1, totalToolCalls: 1, descendantCount: 1, directChildCount: 1,
      inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, runtimeMs: 0 }
  };
}

test("reader pane owns one complete session history and links children on demand", () => {
  const tree = rootTree();
  const pane = renderSessionReaderPane({
    session: tree.session,
    sessionTree: tree,
    provider: "fixture",
    conversationView: {
      cards: [{
        id: "run:child-1", name: "/root/child-1", actorKind: "agent", responsibility: "Read child",
        state: "completed", rawStatus: "completed", interrupted: false, lastActivity: 20,
        observationCount: 1, channelTruncated: false, channel: [{ id: "coord-1", kind: "result-delivery", state: "delivered", timestamp: 10, senderName: null, recipientName: null, eventId: "event:coord-1", turnId: null, sourceEventRef: null }],
        childSession: { provider: "fixture", sessionId: "child-1" }, childSessionAvailable: true,
        bindings: { taskToolCallId: "task-part", childSessionId: "child-1", turnId: null }
      }],
      references: [], inspector: null
    }
  });
  assert.match(pane, /data-reader-pane/);
  assert.match(pane, /data-reader-provider="fixture" data-reader-session="root"/);
  assert.match(pane, /root-owned body/);
  assert.match(pane, /id="part-task-part" data-part-id="task-part"/, "native task evidence remains on the root reading spine");
  assert.match(pane, /data-progressive-part-id="task-part" data-progressive-field="output"/, "task output retains its canonical content endpoint identity");
  assert.doesNotMatch(pane.split('<aside class="reader-collaboration"')[0], /child-owned body/);
  assert.match(pane, /data-reader-task-preview data-reader-provider="fixture" data-reader-session="child-1"/);
  assert.doesNotMatch(pane, /child-owned body/, "child excerpts are loaded only on selection");
  assert.match(pane, /data-reader-open data-reader-provider="fixture" data-reader-session="child-1" href="\/fixture\/session\/child-1"/);
  assert.equal((pane.match(/data-reader-session="child-1"/g) || []).length >= 2, true, "body, action and ToC links share the canonical child target");
  assert.doesNotMatch(pane, /href="#session-child-1"/);
  assert.match(pane, /data-reader-collaboration/);
  assert.match(pane, /<details[^>]*class="reader-collaboration-overview"[^>]*data-reader-collaboration-overview>/);
  assert.ok(pane.indexOf('<div class="reader-pane-main"') < pane.indexOf('data-reader-collaboration-overview'), "overview stays inside the reader main column");
  assert.doesNotMatch(pane, /<\/div>\s*<aside class="reader-collaboration"/, "overview is not a permanent grid sibling");
  assert.match(pane, /data-reader-task-map/);
  assert.match(pane, /data-reader-task-select="run:child-1"/);
  assert.doesNotMatch(pane, /class="reader-time-lane"|data-reader-relation-canvas/);
  assert.match(pane, /data-reader-observation-id="coord-1"/);
  assert.match(pane, /data-reader-event-source/);
  assert.match(pane, /href="\/fixture\/session\/child-1" data-reader-open/);
  assert.doesNotMatch(pane, /<svg[\s\S]*<text/);

  const child = childTree("child-1", "Child reader", "child-owned body");
  const childPane = renderSessionReaderPane({ session: child.session, sessionTree: child, provider: "fixture" });
  assert.match(childPane, /child-owned body/);
  assert.match(childPane, /id="session-child-1"/);
});

test("session shell has one reader host and secondary evidence targets", () => {
  const tree = rootTree();
  const html = renderSessionPage({ session: tree.session, sessionTree: tree, provider: "fixture" });
  assert.match(html, /data-session-reader/);
  assert.equal((html.match(/data-reader-host/g) || []).length, 1);
  assert.equal((html.match(/data-reader-pane/g) || []).length, 1);
  assert.match(html, /id="tab-conversation"/);
  assert.match(html, /id="tab-work"/);
  assert.match(html, /id="tab-events"/);
  assert.doesNotMatch(html, /id="tab-btn-work"/);
  assert.doesNotMatch(html, /id="tab-btn-conversation"/);
  assert.doesNotMatch(html, /child-owned body/);
  assert.doesNotMatch(html, /data-reader-collaboration-toggle|data-reader-collaboration-overview/);
});

test("reader endpoint returns the same fragment contract and explicit missing errors", async () => {
  const routes = [];
  const provider = {
    id: "fixture",
    name: "Fixture",
    icon: "",
    getSession(id) { return id === "root" ? { id, title: "Endpoint reader", timeCreated: 1, timeUpdated: 2 } : null; },
    getMessages(id) { return id === "root" ? [{ id: "answer", sessionId: id, role: "assistant", content: "endpoint body", thinking: null, toolName: null, toolInput: null, toolOutput: null, timestamp: 2, tokens: null, metadata: null }] : []; }
  };
  registerSessionDetail({ get(pattern, handler) { routes.push({ pattern, handler }); } }, {
    appConfig: { port: 0, metaDir: ".", resumeCommands: {}, allowTerminalLaunch: false },
    providerMap: new Map([["fixture", provider]]), providerInfo: []
  });
  const route = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.test("/api/fixture/session/root/reader"));
  assert.ok(route);
  const response = { statusCode: 0, body: "", writeHead(status) { this.statusCode = status; }, end(body = "") { this.body += body; } };
  const match = "/api/fixture/session/root/reader".match(route.pattern);
  await route.handler({ url: "/api/fixture/session/root/reader" }, response, match);
  const payload = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(payload).sort(), ["html", "ok", "provider", "sessionId", "title"]);
  assert.equal(payload.ok, true);
  assert.match(payload.html, /data-reader-pane/);
  assert.doesNotMatch(payload.html, /<!DOCTYPE html>|<script/);

  const missingResponse = { statusCode: 0, body: "", writeHead(status) { this.statusCode = status; }, end(body = "") { this.body += body; } };
  const missingMatch = "/api/fixture/session/missing/reader".match(route.pattern);
  await route.handler({ url: "/api/fixture/session/missing/reader" }, missingResponse, missingMatch);
  assert.equal(missingResponse.statusCode, 404);
  assert.equal(JSON.parse(missingResponse.body).ok, false);
});

test("context result disclosure is lazy, normalized, paged, and progressively readable", async () => {
  const checkpointId = "checkpoint-1";
  const longSummary = `summary ${"line ".repeat(1600)}`;
  let accessorCalls = 0;
  const provider = {
    id: "fixture",
    name: "Fixture",
    icon: "",
    getSession(id) { return id === "root" ? { id, title: "Context result", timeCreated: 1, timeUpdated: 2 } : null; },
    getMessages(id) { return id === "root" ? [{ id: "answer", sessionId: id, role: "assistant", content: "body", timestamp: 2 }] : []; },
    getContextChangeResult(sessionId, requestedCheckpoint) {
      accessorCalls += 1;
      if (sessionId !== "root" || requestedCheckpoint !== checkpointId) return null;
      return {
        checkpointId,
        source: { fidelity: "recorded", sourceType: "fixture.context", sourceId: null, sourceOrdinal: 7, sourceOrdinalProvenance: "source-order/derived" },
        summary: { value: longSummary, availability: "readable" },
        groups: [{ label: "retained", entries: Array.from({ length: 22 }, (_, index) => ({
          sourceOrdinal: index,
          sourceOrdinalProvenance: "source-order/derived",
          kind: "message",
          role: index % 2 ? "assistant" : "user",
          fields: [{ label: "text", value: `entry-${index}` }],
          content: `entry-${index}`,
          attachments: index === 0 ? [{ kind: "image", sourcePath: "guardian_history[0].output[1]", contentAccess: "metadata-only" }] : [],
          omittedEncryptedFieldPaths: index === 0 ? ["retained[0].encrypted_content"] : [],
          omittedEncryptedFieldCount: index === 0 ? 1 : 0
        })) }],
        omitted: { encryptedFieldPaths: ["retained[0].encrypted_content"], encryptedFieldCount: 1 }
      };
    }
  };
  const pane = renderSessionReaderPane({
    session: { id: "root", title: "Context result" },
    messages: provider.getMessages("root"),
    provider: "fixture",
    conversationCompactions: [{ id: checkpointId, summary: null, anchorMessageId: "answer", timestamp: 3, tokensBefore: null, tokensAfter: null, strategy: null, trigger: null, continuationSessionId: null, fidelity: "recorded" }]
  });
  assert.match(pane, /data-context-result-session="root"/);
  assert.match(pane, /data-context-result-checkpoint="checkpoint-1"/);
  assert.equal(accessorCalls, 0, "reader rendering does not eagerly resolve recorded context");

  const routes = [];
  registerSessionDetail({ get(pattern, handler) { routes.push({ pattern, handler }); } }, {
    appConfig: { port: 0, metaDir: ".", resumeCommands: {}, allowTerminalLaunch: false },
    providerMap: new Map([["fixture", provider]]), providerInfo: []
  });
  const route = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.endsWith("context-result$"));
  assert.ok(route);
  const response = () => ({ statusCode: 0, body: "", writeHead(status) { this.statusCode = status; }, end(body = "") { this.body += body; } });
  const first = response();
  await route.handler({ url: `/api/fixture/session/root/context-result?checkpoint=${checkpointId}&offset=0&limit=20` }, first, `/api/fixture/session/root/context-result`.match(route.pattern));
  const firstPayload = JSON.parse(first.body);
  assert.equal(first.statusCode, 200);
  assert.equal(accessorCalls, 1);
  assert.equal(firstPayload.availability, "readable");
  assert.match(firstPayload.html, /summary/);
  assert.equal((firstPayload.html.match(/data-context-result-entry-index=/g) || []).length, 20);
  assert.match(firstPayload.html, /encrypted_content/);
  assert.match(firstPayload.html, /Recorded image \(not rendered\)/);
  assert.match(firstPayload.html, /guardian_history\[0\]\.output\[1\]/);
  assert.equal(firstPayload.nextOffset, 20);
  const second = response();
  await route.handler({ url: `/api/fixture/session/root/context-result?checkpoint=${checkpointId}&offset=20&limit=20` }, second, `/api/fixture/session/root/context-result`.match(route.pattern));
  const secondPayload = JSON.parse(second.body);
  assert.equal((secondPayload.html.match(/data-context-result-entry-index=/g) || []).length, 2);
  assert.doesNotMatch(secondPayload.html, /Recorded summary/);

  const contentRoute = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.endsWith("content$"));
  assert.ok(contentRoute);
  const content = response();
  await contentRoute.handler({ url: `/api/fixture/session/root/content?scope=context-result&checkpoint=${checkpointId}&target=summary&field=summary&offset=6000` }, content, `/api/fixture/session/root/content`.match(contentRoute.pattern));
  const contentPayload = JSON.parse(content.body);
  assert.equal(content.statusCode, 200);
  assert.equal(contentPayload.scope, "context-result");
  assert.ok(contentPayload.html.length > 0);
  assert.equal(contentPayload.nextOffset, null);
  assert.equal(contentPayload.totalLength, longSummary.length);
});

test("owned continuation resolves only the active document while child content remains addressable", async () => {
  const provider = {
    id: "fixture",
    name: "Fixture",
    icon: "",
    getSession(id) { return ["root", "child"].includes(id) ? { id, title: id, timeCreated: 1, timeUpdated: 2 } : null; },
    getMessages(id) {
      const output = id === "child" ? "child-owned-value" : "root-owned-value";
      return [{ id: `${id}-message`, sessionId: id, role: "tool", content: output, toolName: "run", toolOutput: output, timestamp: 2 }];
    },
    getSessionContainer(id) {
      if (id !== "root") return null;
      return { id, messages: [{ parts: [{
        id: "root-message:tool",
        data: { type: "tool", state: { status: "completed", output: "root-owned-value" } },
        childSessions: [{
          session: { id: "child" },
          messages: [{ parts: [{
            id: "child-message:tool",
            data: { type: "tool", state: { status: "completed", output: "child-only-container-value" } },
            childSessions: []
          }] }],
          detachedChildren: []
        }]
      }] }], detachedChildren: [] };
    }
  };
  const routes = [];
  registerSessionDetail({ get(pattern, handler) { routes.push({ pattern, handler }); } }, {
    appConfig: { port: 0, metaDir: ".", resumeCommands: {}, allowTerminalLaunch: false },
    providerMap: new Map([["fixture", provider]]), providerInfo: []
  });
  const route = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.endsWith("content$"));
  assert.ok(route);
  const response = (url) => ({ statusCode: 0, body: "", writeHead(status) { this.statusCode = status; }, end(body = "") { this.body += body; }, url });
  const rootResponse = response("/api/fixture/session/root/content?part=root-message:tool&field=output&offset=0");
  await route.handler({ url: rootResponse.url }, rootResponse, "/api/fixture/session/root/content".match(route.pattern));
  const rootPayload = JSON.parse(rootResponse.body);
  assert.equal(rootPayload.ok, true);
  assert.match(rootPayload.html, /root-owned-value/);
  assert.doesNotMatch(rootPayload.html, /child-only-container-value/);
  const wrongOwner = response("/api/fixture/session/root/content?part=child-message:tool&field=output&offset=0");
  await route.handler({ url: wrongOwner.url }, wrongOwner, "/api/fixture/session/root/content".match(route.pattern));
  assert.equal(wrongOwner.statusCode, 404, "a child part is not owned by the parent URL");
  assert.doesNotMatch(wrongOwner.body, /child-only-container-value|child-owned-value/);
  const childResponse = response("/api/fixture/session/child/content?part=child-message:tool&field=output&offset=0");
  await route.handler({ url: childResponse.url }, childResponse, "/api/fixture/session/child/content".match(route.pattern));
  const childPayload = JSON.parse(childResponse.body);
  assert.equal(childPayload.ok, true);
  assert.match(childPayload.html, /child-owned-value/);
});

test("reader search finds complete owned content with continuation identity and pagination", async () => {
  const routes = [];
  const lateMarker = `${"prefix ".repeat(1900)}needle-late`;
  const provider = {
    id: "fixture",
    name: "Fixture",
    icon: "",
    getSession(id) { return id === "root" ? { id, title: "Search endpoint", timeCreated: 1, timeUpdated: 2 } : null; },
    getMessages(id) {
      return id === "root" ? [{
        id: "answer", sessionId: id, role: "assistant", content: lateMarker,
        thinking: null, toolName: null, toolInput: null,
        toolOutput: null, timestamp: 2, tokens: null, metadata: null
      }, {
        id: "tool", sessionId: id, role: "tool", content: "needle-output",
        thinking: null, toolName: "run", toolInput: { command: "needle-input" },
        toolOutput: "needle-output needle-output", timestamp: 3, tokens: null, metadata: null
      }] : [];
    },
    getInheritedContext() {
      return {
        sourceSession: { provider: "fixture", sessionId: "parent" },
        messages: [{ id: "inherited", role: "system", content: "needle-inherited", timestamp: 1 }]
      };
    }
  };
  registerSessionDetail({ get(pattern, handler) { routes.push({ pattern, handler }); } }, {
    appConfig: { port: 0, metaDir: ".", resumeCommands: {}, allowTerminalLaunch: false },
    providerMap: new Map([["fixture", provider]]), providerInfo: []
  });
  const route = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.endsWith("search$"));
  assert.ok(route);
  const response = { statusCode: 0, body: "", writeHead(status) { this.statusCode = status; }, end(body = "") { this.body += body; } };
  await route.handler({ url: "/api/fixture/session/root/search?q=needle-late&limit=1" }, response, "/api/fixture/session/root/search".match(route.pattern));
  const payload = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(payload.coverage, "complete-owned-content");
  assert.equal(payload.scope, "owned");
  assert.equal(payload.total, 1);
  assert.equal(payload.matches[0].field, "text");
  assert.equal(payload.matches[0].partId, "answer:text");
  assert.equal(payload.matches[0].messageId, "answer");
  assert.equal(payload.matches[0].format, "markdown");
  assert.ok(payload.matches[0].offset > 12000);
  assert.match(payload.matches[0].excerpt, /needle-late/);
  assert.equal(payload.nextOffset, null);

  const inheritedResponse = { statusCode: 0, body: "", writeHead(status) { this.statusCode = status; }, end(body = "") { this.body += body; } };
  await route.handler({ url: "/api/fixture/session/root/search?q=needle-inherited" }, inheritedResponse, "/api/fixture/session/root/search".match(route.pattern));
  assert.equal(JSON.parse(inheritedResponse.body).total, 0, "inherited context is outside owned search");

  const toolResponse = { statusCode: 0, body: "", writeHead(status) { this.statusCode = status; }, end(body = "") { this.body += body; } };
  await route.handler({ url: "/api/fixture/session/root/search?q=needle-output" }, toolResponse, "/api/fixture/session/root/search".match(route.pattern));
  const toolPayload = JSON.parse(toolResponse.body);
  assert.equal(toolPayload.matches[0].field, "output");
  assert.equal(toolPayload.matches[0].format, "plain");
  assert.equal(toolPayload.matches[0].partId, "tool:tool");
  const repeatedTextResponse = { statusCode: 0, body: "", writeHead(status) { this.statusCode = status; }, end(body = "") { this.body += body; } };
  await route.handler({ url: "/api/fixture/session/root/search?q=prefix&limit=3" }, repeatedTextResponse, "/api/fixture/session/root/search".match(route.pattern));
  const repeatedTextPayload = JSON.parse(repeatedTextResponse.body);
  assert.equal(repeatedTextPayload.matches.map((match) => match.matchIndex).join(","), "0,1,2");
  const repeatedOutputResponse = { statusCode: 0, body: "", writeHead(status) { this.statusCode = status; }, end(body = "") { this.body += body; } };
  await route.handler({ url: "/api/fixture/session/root/search?q=needle-output" }, repeatedOutputResponse, "/api/fixture/session/root/search".match(route.pattern));
  const repeatedOutputPayload = JSON.parse(repeatedOutputResponse.body);
  assert.equal(repeatedOutputPayload.matches.map((match) => match.matchIndex).join(","), "0,1");

  const pageResponse = { statusCode: 0, body: "", writeHead(status) { this.statusCode = status; }, end(body = "") { this.body += body; } };
  const repeatedProvider = {
    ...provider,
    getMessages(id) { return id === "root" ? [{ id: "repeated", sessionId: id, role: "assistant", content: "needle ".repeat(4), timestamp: 2 }] : []; }
  };
  // The route resolves the current provider map at request time, so replace the
  // fixture adapter only for this bounded pagination assertion.
  routes.length = 0;
  registerSessionDetail({ get(pattern, handler) { routes.push({ pattern, handler }); } }, {
    appConfig: { port: 0, metaDir: ".", resumeCommands: {}, allowTerminalLaunch: false },
    providerMap: new Map([["fixture", repeatedProvider]]), providerInfo: []
  });
  const paginationRoute = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.endsWith("search$"));
  await paginationRoute.handler({ url: "/api/fixture/session/root/search?q=needle&limit=2" }, pageResponse, "/api/fixture/session/root/search".match(paginationRoute.pattern));
  const pagePayload = JSON.parse(pageResponse.body);
  assert.equal(pagePayload.total, 4);
  assert.equal(pagePayload.matches.length, 2);
  assert.equal(pagePayload.nextOffset, 2);
});
