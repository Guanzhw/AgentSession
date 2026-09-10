import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-inherited-context-"));
const codexHome = path.join(temp, "codex");
const sessions = path.join(codexHome, "sessions");
mkdirSync(sessions, { recursive: true });
process.env.AGENTSESSION_META_PATH = path.join(temp, "meta.db");

const { initConfig } = await import("../dist/src/config.js");
initConfig(["--codex-dir", codexHome]);
const { default: codex } = await import("../dist/src/providers/codex/adapter.js?inherited-context-test");
const { registerSessionDetail } = await import("../dist/src/routes/session-detail.js?inherited-context-test");
const { renderSessionPage } = await import("../dist/src/views/session.js?inherited-context-test");
const { closeMetaDb } = await import("../dist/src/meta.js");
const { closeIndexDb } = await import("../dist/src/index-db.js");

function record(timestamp, type, payload) {
  return { timestamp, type, payload };
}

function writeRollout(id, records) {
  writeFileSync(
    path.join(sessions, `rollout-${id}.jsonl`),
    `${records.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8"
  );
}

const parentRecords = [
  record("2026-09-11T00:00:00.000Z", "session_meta", { id: "parent", session_id: "parent" }),
  record("2026-09-11T00:00:01.000Z", "event_msg", { type: "user_message", message: "Parent request" })
];
const inheritedRecords = Array.from({ length: 45 }, (_, index) => record(
  `2026-09-10T23:${String(10 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
  "response_item",
  {
    id: `dev-${index}`,
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: index === 0 ? `Inherited long background ${"x".repeat(13000)}` : `Inherited developer context ${index}` }]
  }
));
const childRecords = [
  record("2026-09-11T00:00:00.000Z", "session_meta", { id: "child", session_id: "child", parent_thread_id: "parent" }),
  record("2026-09-10T23:09:00.000Z", "response_item", {
    id: "reason-1",
    type: "reasoning",
    summary: [{ type: "summary_text", text: `Inherited reasoning ${"r".repeat(7000)}` }]
  }),
  record("2026-09-10T23:09:01.000Z", "response_item", {
    id: "tool-call-inherited",
    type: "function_call",
    name: "read_file",
    call_id: "tool-call-inherited",
    arguments: JSON.stringify({ path: "x".repeat(3500) })
  }),
  record("2026-09-10T23:09:02.000Z", "response_item", {
    type: "function_call_output",
    call_id: "tool-call-inherited",
    output: `Inherited tool output ${"o".repeat(3500)}`
  }),
  ...inheritedRecords,
  ...["Injected environment context", "Injected project context", "Injected instruction context"].map((text, index) => record(
    `2026-09-10T23:58:0${index}.000Z`,
    "response_item",
    { id: `injected-${index}`, type: "message", role: "user", content: [{ type: "input_text", text }] }
  )),
  record("2026-09-10T23:59:59.000Z", "event_msg", { type: "user_message", message: "Inherited user request" }),
  record("2026-09-11T00:01:00.000Z", "response_item", { id: "task-1", type: "agent_message", content: [{ type: "output_text", text: "Message Type: NEW_TASK\nTask name: worker" }] }),
  record("2026-09-11T00:01:01.000Z", "event_msg", { type: "agent_message", message: "Owned result" }),
  record("2026-09-11T00:01:02.000Z", "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } })
];
writeRollout("parent", parentRecords);
writeRollout("child", childRecords);
writeRollout("orphan-child", [
  record("2026-09-11T01:00:00.000Z", "session_meta", { id: "orphan-child", session_id: "orphan-child", parent_thread_id: "missing-parent" }),
  record("2026-09-11T00:59:59.000Z", "event_msg", { type: "user_message", message: "Recorded orphan context" }),
  record("2026-09-11T01:00:01.000Z", "response_item", { id: "orphan-task", type: "agent_message", content: [{ type: "output_text", text: "Message Type: NEW_TASK\nTask name: orphan" }] })
]);

function captureRoutes(deps) {
  const routes = [];
  registerSessionDetail({
    get(pattern, handler) {
      routes.push({ pattern, handler });
    }
  }, deps);
  return routes;
}

function responseCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writableEnded: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body = "") {
      this.body += String(body);
      this.writableEnded = true;
    }
  };
}

test.after(() => {
  closeMetaDb();
  closeIndexDb();
  rmSync(temp, { recursive: true, force: true });
});

test("real Codex adapter bounds inherited context while preserving owned projections", async () => {
  const scanned = [];
  for await (const session of codex.scan()) scanned.push(session);
  assert.ok(scanned.some((session) => session.id === "child"));

  const inherited = codex.getInheritedContext("child");
  assert.equal(inherited.sourceSession.sessionId, "parent");
  assert.equal(inherited.total, 51);
  assert.equal(inherited.messages.length, 40);
  assert.equal(inherited.truncated, true);
  assert.equal(inherited.messages[0].role, "assistant");
  assert.equal(inherited.messages[1].role, "tool");
  assert.equal(inherited.messages.at(-1).metadata.provenance, "inherited-parent-context");

  const owned = codex.getMessages("child");
  assert.equal(owned.some((message) => message.content.startsWith("Inherited")), false);
  assert.equal(owned.find((message) => message.content === "Owned result")?.tokens.total, 12);
  assert.equal(codex.getSession("child").messageCount, 2);
  assert.equal(codex.getSession("child").tokenCount, 12);
  const protocol = codex.getSessionProtocol("child");
  assert.ok(protocol);
  assert.doesNotMatch(JSON.stringify(protocol), /Inherited developer context|Inherited long background/);
});

test("real adapter SSR and content route disclose inherited context, including missing parent files", async () => {
  const routes = captureRoutes({
    appConfig: { port: 0, metaDir: temp, resumeCommands: {}, allowTerminalLaunch: false },
    providerMap: new Map([["codex", codex]]),
    providerInfo: []
  });
  const pageRoute = routes.find(({ pattern }) => pattern === "/:provider/session/:id");
  assert.ok(pageRoute);
  const page = await pageRoute.handler({ url: "/codex/session/child" }, null, { provider: "codex", id: "child" });
  assert.equal(page.status, 200);
  assert.match(page.body, /class="inherited-context-disclosure"/);
  assert.match(page.body, /Showing 40 of 51 recorded messages/);
  assert.match(page.body, /href="\/codex\/session\/parent"/);
  assert.match(page.body, /inherited-parent-dev-0:part/);
  for (const [part, field] of [
    ["inherited-parent-reason-1:reasoning", "reasoning"],
    ["inherited-parent-tool-call-inherited:part", "input"],
    ["inherited-parent-tool-call-inherited:part", "output"]
  ]) {
    assert.match(
      page.body,
      new RegExp(`data-part-id="${part.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}" data-content-scope="inherited-context" data-field="${field}"`)
    );
  }
  assert.doesNotMatch(page.body.match(/<div class="toc-list">([\s\S]*?)<\/div>/)?.[1] || "", /Inherited/);

  const contentRoute = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.includes("content"));
  assert.ok(contentRoute);
  const contentResponse = responseCapture();
  const contentUrl = "/api/codex/session/child/content?part=inherited-parent-dev-0%3Apart&field=text&offset=12000&scope=inherited-context";
  const contentMatch = new URL(contentUrl, "http://127.0.0.1").pathname.match(contentRoute.pattern);
  assert.ok(contentMatch);
  await contentRoute.handler({ url: contentUrl }, contentResponse, contentMatch);
  assert.equal(contentResponse.statusCode, 200);
  assert.equal(contentResponse.writableEnded, true);
  assert.match(contentResponse.body, /"ok":true/);

  const ownedScopeResponse = responseCapture();
  await contentRoute.handler(
    { url: "/api/codex/session/child/content?part=inherited-parent-dev-0%3Apart&field=text&offset=12000&scope=owned" },
    ownedScopeResponse,
    contentMatch
  );
  assert.equal(ownedScopeResponse.statusCode, 404);

  for (const [part, field, offset] of [
    ["inherited-parent-reason-1:reasoning", "reasoning", "6000"],
    ["inherited-parent-tool-call-inherited:part", "input", "3000"],
    ["inherited-parent-tool-call-inherited:part", "output", "3000"]
  ]) {
    const response = responseCapture();
    const url = `/api/codex/session/child/content?part=${encodeURIComponent(part)}&field=${field}&offset=${offset}&scope=inherited-context`;
    const match = new URL(url, "http://127.0.0.1").pathname.match(contentRoute.pattern);
    assert.ok(match);
    await contentRoute.handler({ url }, response, match);
    assert.equal(response.statusCode, 200);
    const continuation = JSON.parse(response.body);
    assert.equal(continuation.ok, true);
    assert.equal(typeof continuation.html, "string");
    assert.match(continuation.html, field === "reasoning" ? /rrrr/ : field === "input" ? /xxx/ : /ooo/);
  }

  const orphan = codex.getInheritedContext("orphan-child");
  assert.equal(orphan.sourceSession.sessionId, "missing-parent");
  assert.equal(orphan.total, 1);
  assert.equal(orphan.messages[0].content, "Recorded orphan context");
  const orphanPage = await pageRoute.handler({ url: "/codex/session/orphan-child" }, null, { provider: "codex", id: "orphan-child" });
  assert.match(orphanPage.body, /Recorded inherited context/);
  assert.match(orphanPage.body, /href="\/codex\/session\/missing-parent"/);
});

test("inherited renderer remains usable directly with the real adapter projection", () => {
  const view = codex.getInheritedContext("child");
  const html = renderSessionPage({ session: codex.getSession("child"), provider: "codex", inheritedContext: view });
  assert.match(html, /data-inherited-context-messages/);
  assert.match(html, /data-part-id="inherited-parent-dev-0:part"/);
});

test("inherited anchors and scoped continuation stay separate from a colliding owned id", () => {
  const view = codex.getInheritedContext("child");
  const ownedId = "inherited-parent-dev-0";
  const html = renderSessionPage({
    session: codex.getSession("child"),
    provider: "codex",
    messages: [{ id: ownedId, data: { role: "assistant", time: { created: 1 } } }],
    partsByMessage: new Map([[ownedId, [{ id: `${ownedId}:part`, data: { type: "text", text: "Owned collision" } }]]]),
    inheritedContext: view
  });
  assert.match(html, /id="msg-inherited-parent-dev-0"/);
  assert.match(html, /id="inherited-msg-inherited-parent-dev-0"/);
});
