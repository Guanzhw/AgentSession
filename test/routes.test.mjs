import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-routes-"));
process.env.AGENTSESSION_META_PATH = path.join(temp, "meta.db");

const { initConfig } = await import("../dist/src/config.js");
initConfig([]);

const { Router } = await import("../dist/src/router.js");
const { getProvider } = await import("../dist/src/providers/index.js");
const { providerRenderContext } = await import("../dist/src/routes/provider-context.js");
const { registerSessionDetail } = await import("../dist/src/routes/session-detail.js");
const { getSessionDocument } = await import("../dist/src/session-queries.js");
const { registerSessions } = await import("../dist/src/routes/sessions.js");
const { renderSessionsPage } = await import("../dist/src/views/sessions.js");
const { registerSettingsStatsTrash } = await import("../dist/src/routes/settings-stats-trash.js");
const { closeIndexDb, getIndexDb } = await import("../dist/src/index-db.js");
const { closeDb } = await import("../dist/src/db.js");
const { closeMetaDb, renameSession } = await import("../dist/src/meta.js");

function captureGetRoutes(register, deps) {
  const routes = [];
  register({
    get(pattern, handler) {
      routes.push({ pattern, handler });
    }
  }, deps);
  return routes;
}

function createResponseCapture() {
  return {
    statusCode: 0,
    headers: {},
    headersSent: false,
    writableEnded: false,
    body: "",
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
      return this;
    },
    end(chunk = "") {
      this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
      this.writableEnded = true;
      return this;
    }
  };
}

test("router accepts structured results without resending handler-owned responses", async (t) => {
  const router = new Router();
  router.get("/direct", (_req, res) => res.end("direct"));
  router.get("/structured", () => ({
    status: 201,
    body: "structured",
    contentType: "text/plain; charset=utf-8",
    headers: { "Content-Disposition": 'attachment; filename="fixture.txt"' }
  }));

  const server = createServer((req, res) => {
    void router.dispatch(req, res, new URL(req.url || "/", "http://127.0.0.1"))
      .then((handled) => {
        if (!handled && !res.headersSent) {
          res.writeHead(404).end();
        }
      })
      .catch((error) => {
        if (!res.headersSent) {
          res.writeHead(500).end(String(error));
        } else if (!res.writableEnded) {
          res.destroy(error);
        }
      });
  });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const direct = await fetch(`${baseUrl}/direct`);
  assert.equal(direct.status, 200);
  assert.equal(await direct.text(), "direct");

  const structured = await fetch(`${baseUrl}/structured`);
  assert.equal(structured.status, 201);
  assert.equal(structured.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(structured.headers.get("content-disposition"), 'attachment; filename="fixture.txt"');
  assert.equal(await structured.text(), "structured");
});

test("session exports stay complete and keep the HTTP server alive", async (t) => {
  const provider = {
    id: "codex",
    name: "Route fixture",
    icon: "",
    capabilities: {},
    getSession(sessionId) {
      return sessionId === "session-1"
        ? {
            id: sessionId,
            title: "Export fixture",
            directory: temp,
            timeCreated: 1000,
            timeUpdated: 2000
          }
        : null;
    },
    getMessages(sessionId) {
      return [{
        id: "message-1",
        sessionId,
        role: "assistant",
        content: "Export body",
        thinking: null,
        toolName: null,
        toolInput: null,
        toolOutput: null,
        timestamp: 1500,
        tokens: null,
        metadata: null
      }];
    }
  };
  const routes = captureGetRoutes(registerSessionDetail, {
    appConfig: {
      port: 0,
      metaDir: temp,
      resumeCommands: {},
      allowTerminalLaunch: false
    },
    providerMap: new Map([[provider.id, provider]]),
    providerInfo: []
  });

  renameSession("codex", "session-1", "Viewer export title");
  const document = getSessionDocument(provider, "codex", "session-1");
  assert.equal(document.session.title, "Viewer export title");
  assert.equal(document.apiSession.title, "Export fixture");
  assert.equal(document.exportSession.title, "Export fixture");
  assert.equal(document.messages[0].data.role, "assistant");
  assert.equal(document.partsByMessage.get("message-1")[0].data.text, "Export body");
  assert.equal(document.apiMessages[0].content, "Export body");
  assert.equal(document.exportMessages[0].parts[0].text, "Export body");

  const route = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.includes("export"));
  assert.ok(route);

  for (const format of ["json", "md"]) {
    const url = `/api/codex/session/session-1/export?format=${format}`;
    const match = new URL(url, "http://127.0.0.1").pathname.match(route.pattern);
    assert.ok(match);
    const response = createResponseCapture();
    const result = await route.handler({ url }, response, match);
    assert.equal(result, undefined);
    assert.equal(response.statusCode, 200);
    assert.equal(response.writableEnded, true);
    assert.match(response.headers["Content-Disposition"], new RegExp(`\\.${format === "json" ? "json" : "md"}\\"$`));
    if (format === "json") {
      const exported = JSON.parse(response.body);
      assert.equal(exported.session.id, "session-1");
      assert.equal(exported.messages[0].parts[0].text, "Export body");
    } else {
      assert.match(response.body, /^# Export fixture/m);
      assert.match(response.body, /Export body/);
    }
  }

  const interruptedResponse = createResponseCapture();
  let writeHeadCalls = 0;
  let destroyedWith = null;
  const captureWriteHead = interruptedResponse.writeHead;
  interruptedResponse.writeHead = function (...args) {
    writeHeadCalls += 1;
    return captureWriteHead.apply(this, args);
  };
  interruptedResponse.end = function () {
    throw new Error("simulated response interruption");
  };
  interruptedResponse.destroy = function (error) {
    destroyedWith = error;
  };
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const result = await route.handler(
      { url: "/api/codex/session/session-1/export?format=json" },
      interruptedResponse,
      ["", "codex", "session-1"]
    );
    assert.equal(result, undefined);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(writeHeadCalls, 1, "an interrupted response must not receive a second header write");
  assert.match(destroyedWith?.message || "", /simulated response interruption/);

  const router = new Router();
  registerSessionDetail(router, {
    appConfig: {
      port: 0,
      metaDir: temp,
      resumeCommands: {},
      allowTerminalLaunch: false
    },
    providerMap: new Map([[provider.id, provider]]),
    providerInfo: []
  });
  const requestErrors = [];
  const server = createServer((req, res) => {
    void router.dispatch(req, res, new URL(req.url || "/", "http://127.0.0.1"))
      .then((handled) => {
        if (!handled && !res.headersSent) {
          res.writeHead(404).end("not found");
        }
      })
      .catch((error) => {
        requestErrors.push(error);
        if (!res.headersSent) {
          res.writeHead(500).end("internal error");
        } else if (!res.writableEnded) {
          res.destroy(error);
        }
      });
  });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const exportedResponse = await fetch(`${baseUrl}/api/codex/session/session-1/export?format=json`);
  assert.equal(exportedResponse.status, 200);
  assert.equal(exportedResponse.headers.get("content-type"), "application/json; charset=utf-8");
  const exported = await exportedResponse.json();
  assert.equal(exported.session.id, "session-1");
  assert.equal(exported.messages[0].parts[0].text, "Export body");

  const followUp = await fetch(`${baseUrl}/still-alive`);
  assert.equal(followUp.status, 404);
  assert.equal(await followUp.text(), "not found");
  assert.deepEqual(requestErrors, []);
});

test("SQLite session documents preserve parsed parts, todos, and viewer metadata", () => {
  const documentTemp = mkdtempSync(path.join(os.tmpdir(), "agentsession-document-"));
  const dbPath = path.join(documentTemp, "sessions.db");
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, title TEXT,
        directory TEXT, time_created INTEGER, time_updated INTEGER,
        summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
        time_archived INTEGER
      );
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
      CREATE TABLE todo (
        session_id TEXT, content TEXT, status TEXT, priority TEXT,
        position INTEGER, time_created INTEGER
      );
    `);
    db.prepare("INSERT INTO session VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, 0, 0, 0, NULL)")
      .run("sqlite-document", "sqlite-document", "SQLite source title", documentTemp, 1000, 2000);
    db.prepare("INSERT INTO message VALUES (?, ?, ?)")
      .run("sqlite-message", "sqlite-document", JSON.stringify({ role: "assistant", time: { created: 1500 } }));
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)")
      .run("sqlite-part", "sqlite-message", "sqlite-document", JSON.stringify({ type: "text", text: "SQLite body" }));
    db.prepare("INSERT INTO todo VALUES (?, ?, ?, ?, ?, ?)")
      .run("sqlite-document", "Verify SQLite fidelity", "pending", "high", 0, 1600);
    db.close();

    renameSession("opencode", "sqlite-document", "Viewer SQLite title");
    const document = getSessionDocument({
      capabilities: { openCodeStatsStore: true },
      getDataPath() { return dbPath; }
    }, "opencode", "sqlite-document");

    assert.equal(document.session.title, "Viewer SQLite title");
    assert.equal(document.apiSession.title, "Viewer SQLite title");
    assert.equal(document.exportSession.title, "Viewer SQLite title");
    assert.equal(document.messages[0].data.role, "assistant");
    assert.equal(document.partsByMessage.get("sqlite-message")[0].data.text, "SQLite body");
    assert.equal(document.apiMessages[0].parts[0].text, "SQLite body");
    assert.equal(document.exportMessages[0].parts[0].text, "SQLite body");
    assert.equal(document.todos[0].content, "Verify SQLite fidelity");
  } finally {
    closeDb(dbPath);
    rmSync(documentTemp, { recursive: true, force: true });
  }
});

test("system prompt endpoint returns only adapter-resolved evidence", async () => {
  const provider = {
    id: "codex",
    capabilities: {},
    getSystemPrompts(sessionId) {
      return sessionId === "session-1" ? {
        sessionId,
        hiddenPromptStored: false,
        note: "Resolved local evidence only.",
        sections: [{
          title: "Instructions",
          note: "Fixture",
          items: [{
            kind: "instruction",
            title: "AGENTS.md",
            preview: "Use focused tests.",
            source: "D:\\fixture\\AGENTS.md",
            time: 1000
          }]
        }]
      } : null;
    }
  };
  const routes = captureGetRoutes(registerSessionDetail, {
    appConfig: { port: 0, metaDir: temp, projectPaths: {}, resumeCommands: {}, allowTerminalLaunch: false },
    providerMap: new Map([[provider.id, provider]]),
    providerInfo: []
  });
  const route = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.includes("system-prompts"));
  assert.ok(route);
  const response = createResponseCapture();
  await route.handler(
    { url: "/api/codex/session/session-1/system-prompts" },
    response,
    ["", "codex", "session-1"]
  );
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.hiddenPromptStored, false);
  assert.equal(body.sections[0].items[0].title, "AGENTS.md");
});

test("progressive content endpoint returns bounded continuation chunks", async () => {
  const output = `# Result\n\n${"line\n".repeat(1400)}`;
  const provider = {
    id: "codex",
    getSessionContainer(sessionId) {
      if (sessionId !== "session-1") return null;
      return {
        id: sessionId,
        messages: [{
          parts: [{
            id: "tool-1",
            data: {
              type: "tool",
              state: { status: "completed", input: { query: "x" }, output }
            },
            childSessions: []
          }]
        }],
        detachedChildren: []
      };
    },
    getMessages() { return []; }
  };
  const routes = captureGetRoutes(registerSessionDetail, {
    appConfig: { port: 0, metaDir: temp, projectPaths: {}, resumeCommands: {}, allowTerminalLaunch: false },
    providerMap: new Map([[provider.id, provider]]),
    providerInfo: []
  });
  const route = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.includes("/content$"));
  assert.ok(route);

  const firstResponse = createResponseCapture();
  const firstUrl = "/api/codex/session/session-1/content?part=tool-1&field=output&offset=0";
  await route.handler({ url: firstUrl }, firstResponse, ["", "codex", "session-1"]);
  assert.equal(firstResponse.statusCode, 200);
  const first = JSON.parse(firstResponse.body);
  assert.equal(first.ok, true);
  assert.match(first.html, /tool-output-body markdown/);
  assert.match(first.html, /<h1>Result<\/h1>/);
  assert.ok(first.nextOffset > 0 && first.nextOffset < output.length);
  assert.ok(first.html.length < output.length, "response contains one bounded chunk");

  const secondResponse = createResponseCapture();
  const secondUrl = `/api/codex/session/session-1/content?part=tool-1&field=output&offset=${first.nextOffset}`;
  await route.handler({ url: secondUrl }, secondResponse, ["", "codex", "session-1"]);
  const second = JSON.parse(secondResponse.body);
  assert.equal(second.ok, true);
  assert.ok(second.html.length > 0);

  const invalidResponse = createResponseCapture();
  await route.handler(
    { url: "/api/codex/session/session-1/content?part=tool-1&field=output&offset=-1" },
    invalidResponse,
    ["", "codex", "session-1"]
  );
  assert.equal(invalidResponse.statusCode, 400);
});

test("session protocol route exposes descriptors and protocol with 404 semantics", async () => {
  const provider = {
    id: "codex",
    name: "Protocol fixture",
    icon: "",
    capabilities: {},
    protocolCapabilities: {
      sessionEvents: { support: "partial", provenance: "derived", details: "fixture" },
      sessionRelationships: { support: "none", provenance: "derived" },
      tasks: { support: "full", provenance: "recorded" },
      agentRuns: { support: "partial", provenance: "derived" },
      contextArtifacts: { support: "none", provenance: "derived" }
    },
    getSession(sessionId) {
      return sessionId === "session-1"
        ? { id: sessionId, provider: "codex", parentId: null, title: "Protocol fixture", directory: temp, timeCreated: 100, timeUpdated: 200, messageCount: 1, tokenCount: null }
        : null;
    },
    getSessionProtocol(sessionId) {
      if (sessionId !== "session-1") return null;
      return {
        sessionId,
        events: [{
          id: "e1", sessionId, sequence: 1, timestamp: 100, kind: "message.user",
          provenance: { fidelity: "derived", sourceType: "fixture" }
        }],
        relationships: [],
        tasks: [],
        agentRuns: [],
        contextArtifacts: []
      };
    }
  };
  const plain = { id: "pi", name: "Plain", icon: "", capabilities: {}, getSession() { return null; } };
  const routes = captureGetRoutes(registerSessionDetail, {
    appConfig: { port: 0, metaDir: temp, projectPaths: {}, resumeCommands: {}, allowTerminalLaunch: false },
    providerMap: new Map([[provider.id, provider], [plain.id, plain]]),
    providerInfo: []
  });
  assert.equal(
    routes.some(({ pattern }) => pattern instanceof RegExp && (/\/trace\$/.test(pattern.source) || /\/metrics\$/.test(pattern.source))),
    false,
    "retired trace and metrics endpoints stay unregistered"
  );
  const route = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.includes("/protocol$"));
  assert.ok(route, "protocol route is registered");

  // 200: capability descriptors plus the standardized protocol.
  const okResponse = createResponseCapture();
  await route.handler({ url: "/api/codex/session/session-1/protocol" }, okResponse, ["", "codex", "session-1"]);
  assert.equal(okResponse.statusCode, 200);
  const body = JSON.parse(okResponse.body);
  assert.equal(body.sessionId, "session-1");
  assert.equal(body.capabilities.sessionEvents.support, "partial");
  assert.equal(body.capabilities.sessionEvents.provenance, "derived");
  assert.equal(body.capabilities.tasks.support, "full");
  assert.equal(body.capabilities.sessionRelationships.support, "none");
  assert.equal(body.protocol.events[0].sequence, 1);
  assert.equal(body.protocol.version, 2);
  assert.equal(body.protocol.session.ref.provider, "codex");
  assert.equal(body.validation.ok, true);

  // Unknown session -> 404.
  const missingResponse = createResponseCapture();
  await route.handler({ url: "/api/codex/session/nope/protocol" }, missingResponse, ["", "codex", "nope"]);
  assert.equal(missingResponse.statusCode, 404);
  assert.equal(JSON.parse(missingResponse.body).code, "session_not_found");

  // Provider without a protocol accessor -> 404, never fabricated data.
  const unsupportedResponse = createResponseCapture();
  await route.handler({ url: "/api/pi/session/x/protocol" }, unsupportedResponse, ["", "pi", "x"]);
  assert.equal(unsupportedResponse.statusCode, 404);
  assert.equal(JSON.parse(unsupportedResponse.body).error, "Session protocol not supported");

  // Unknown provider -> 404.
  const unknownResponse = createResponseCapture();
  await route.handler({ url: "/api/nope/session/x/protocol" }, unknownResponse, ["", "nope", "x"]);
  assert.equal(unknownResponse.statusCode, 404);

  // Malformed encoded session id -> 404 without crashing.
  const badResponse = createResponseCapture();
  await route.handler({ url: "/api/codex/session/%ZZ/protocol" }, badResponse, ["", "codex", "%ZZ"]);
  assert.equal(badResponse.statusCode, 404);
  assert.equal(JSON.parse(badResponse.body).error, "Invalid session id");
});

test("runtime protocol routes return bounded summary, event pages, and graph projections", async () => {
  const provider = {
    id: "codex",
    name: "Runtime fixture",
    icon: "",
    capabilities: {},
    protocolCapabilities: {
      sessionEvents: { support: "partial", provenance: "derived" },
      sessionRelationships: { support: "none", provenance: "derived" },
      tasks: { support: "partial", provenance: "derived" },
      agentRuns: { support: "partial", provenance: "derived" },
      contextArtifacts: { support: "none", provenance: "derived" }
    },
    getSession(sessionId) {
      return sessionId === "session-1"
        ? { id: sessionId, provider: "codex", parentId: null, title: "Runtime fixture", directory: temp, timeCreated: 100, timeUpdated: 200, messageCount: 2, tokenCount: null }
        : null;
    },
    getSessionProtocol(sessionId) {
      return sessionId === "session-1" ? {
        sessionId,
        events: [
          { id: "e1", sessionId, sequence: 1, timestamp: 100, kind: "message.user", provenance: { fidelity: "derived", sourceType: "fixture" } },
          { id: "e2", sessionId, sequence: 2, timestamp: 200, kind: "tool.call", phase: "started", provenance: { fidelity: "derived", sourceType: "fixture" }, providerData: { secret: "not-public" } }
        ],
        relationships: [],
        tasks: [{ id: "task-1", sessionId, kind: "task", status: "completed", title: "Inspect", triggerEventId: "e2", dependencies: [], timeCreated: 100, timeUpdated: 200, timeCompleted: 200, provenance: { fidelity: "derived", sourceType: "fixture" } }],
        agentRuns: [{ id: "run-1", sessionId, taskId: "task-1", status: "completed", mode: "subagent", agent: "worker", model: null, childSessionId: null, triggerEventId: "e2", timeStart: 100, timeEnd: 200, provenance: { fidelity: "derived", sourceType: "fixture" } }],
        contextArtifacts: []
      } : null;
    }
  };
  const routes = captureGetRoutes(registerSessionDetail, {
    appConfig: { port: 0, metaDir: temp, projectPaths: {}, resumeCommands: {}, allowTerminalLaunch: false },
    providerMap: new Map([[provider.id, provider]]),
    providerInfo: []
  });
  const routeFor = (suffix) => routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.includes(suffix));

  const summaryResponse = createResponseCapture();
  await routeFor("runtime\\/summary$").handler({ url: "/api/codex/session/session-1/runtime/summary" }, summaryResponse, ["", "codex", "session-1"]);
  assert.equal(summaryResponse.statusCode, 200);
  assert.equal(JSON.parse(summaryResponse.body).summary.counts.events, 2);

  const eventsResponse = createResponseCapture();
  await routeFor("runtime\\/events$").handler({ url: "/api/codex/session/session-1/runtime/events?limit=1&category=tool" }, eventsResponse, ["", "codex", "session-1"]);
  assert.equal(eventsResponse.statusCode, 200);
  const events = JSON.parse(eventsResponse.body);
  assert.equal(events.events.length, 1);
  assert.equal(events.events[0].category, "tool");
  assert.equal("providerData" in events.events[0], false);

  const workEventsResponse = createResponseCapture();
  await routeFor("runtime\\/events$").handler({ url: "/api/codex/session/session-1/runtime/events?taskId=task-1&runId=run-1" }, workEventsResponse, ["", "codex", "session-1"]);
  const workEvents = JSON.parse(workEventsResponse.body);
  assert.equal(workEvents.events.length, 1);
  assert.equal(workEvents.events[0].taskId, "task-1");
  assert.equal(workEvents.events[0].runId, "run-1");

  const graphResponse = createResponseCapture();
  await routeFor("runtime\\/graph$").handler({ url: "/api/codex/session/session-1/runtime/graph?depth=1&maxNodes=20" }, graphResponse, ["", "codex", "session-1"]);
  assert.equal(graphResponse.statusCode, 200);
  const graph = JSON.parse(graphResponse.body);
  assert.equal(graph.focus.sessionId, "session-1");
  assert.equal(graph.nodes[0].focus, true);

  const invalidResponse = createResponseCapture();
  await routeFor("runtime\\/events$").handler({ url: "/api/codex/session/session-1/runtime/events?limit=999" }, invalidResponse, ["", "codex", "session-1"]);
  assert.equal(invalidResponse.statusCode, 400);
  assert.equal(JSON.parse(invalidResponse.body).code, "invalid_input");
});

test("provider page keeps unavailable paths and management capability provider-owned", async () => {
  const providers = ["pi"].map((providerId) => getProvider(providerId));
  assert.ok(providers.every(Boolean));
  const providerInfo = providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    icon: provider.icon,
    available: false,
    manageable: true
  }));
  const routes = captureGetRoutes(registerSessions, {
    appConfig: {},
    providerMap: new Map(),
    providerInfo
  });
  const route = routes.find(({ pattern }) => pattern === "/:provider");
  assert.ok(route);
  for (const provider of providers) {
    const result = await route.handler(
      { url: `/${provider.id}` },
      createResponseCapture(),
      { provider: provider.id }
    );
    assert.equal(result.status, 200);
    assert.ok(result.body.includes(provider.getDataPath()), `${provider.id} should render its complete data path`);
    assert.doesNotMatch(result.body, /data was not detected at \.<\/p>/);
    assert.match(result.body, /data-manageable="false"/);
    assert.doesNotMatch(result.body, /nav-link-trash/);
  }

  assert.deepEqual(
    providerRenderContext("codex", providerInfo, { capabilities: {} }),
    { provider: "codex", providers: providerInfo, manageable: false, storageDiagnostic: null }
  );
  assert.equal(
    providerRenderContext("codex", providerInfo, { capabilities: { localManagement: true } }).manageable,
    true
  );

  const diagnosticPage = renderSessionsPage({
    provider: "deepseek-harness",
    sessions: [],
    storageDiagnostic: { code: "DSH_SQLITE_UNSUPPORTED", message: "SQLite schema 17 was detected but is not readable yet." }
  });
  assert.match(diagnosticPage, /data-storage-diagnostic="DSH_SQLITE_UNSUPPORTED"/);
  assert.match(diagnosticPage, /SQLite schema 17 was detected but is not readable yet\./);
});

test("centralized sessions page queries multiple providers and keeps canonical provider identity", async () => {
  const db = getIndexDb();
  const insert = db.prepare(`INSERT OR REPLACE INTO session_index
    (id, provider, parent_id, title, directory, time_created, time_updated, message_count, token_count, last_indexed)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run("shared-id", "codex", "Codex session", "D:\\codex", 1000, 3000, 3, 30, Date.now());
  insert.run("shared-id", "pi", "Pi session", "D:\\pi", 1000, 2000, 2, 20, Date.now());
  const providerInfo = [
    { id: "codex", name: "Codex", icon: "", available: true, manageable: false },
    { id: "pi", name: "Pi", icon: "", available: true, manageable: false },
  ];
  const routes = captureGetRoutes(registerSessions, {
    appConfig: {},
    providerMap: new Map(providerInfo.map((provider) => [provider.id, { ...provider, capabilities: {} }])),
    providerInfo,
  });
  const pageRoute = routes.find(({ pattern }) => pattern === "/sessions");
  const apiRoute = routes.find(({ pattern }) => pattern === "/api/sessions");
  assert.ok(pageRoute);
  assert.ok(apiRoute);

  const page = await pageRoute.handler({ url: "/sessions?provider=codex&provider=pi" }, createResponseCapture());
  assert.equal(page.status, 200);
  assert.match(page.body, /href="\/codex\/session\/shared-id\?from=/);
  assert.match(page.body, /href="\/pi\/session\/shared-id\?from=/);
  assert.match(page.body, /class="session-provider-badge" title="codex">Codex</);
  assert.match(page.body, /class="session-provider-badge" title="pi">Pi</);
  assert.match(page.body, /href="\/stats\?provider=codex&amp;provider=pi"/);

  renameSession("pi", "shared-id", "Renamed global fixture");
  const renamed = await pageRoute.handler({ url: "/sessions?provider=pi&q=Renamed" }, createResponseCapture());
  assert.equal(renamed.status, 200);
  assert.match(renamed.body, /Renamed global fixture/);
  assert.doesNotMatch(renamed.body, /Codex session/);

  const response = createResponseCapture();
  await apiRoute.handler({ url: "/api/sessions?provider=pi" }, response);
  const payload = JSON.parse(response.body);
  assert.equal(payload.total, 1);
  assert.equal(payload.sessions[0].provider, "pi");
});

test("centralized project filters merge equivalent Windows and WSL paths", async () => {
  const db = getIndexDb();
  const insert = db.prepare(`INSERT OR REPLACE INTO session_index
    (id, provider, parent_id, title, directory, time_created, time_updated, message_count, token_count, last_indexed)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run("project-alias-win", "codex", "Project alias fixture", "D:\\WorkSpace\\ProjectAliases", 1000, 4000, 1, 10, Date.now());
  insert.run("project-alias-slash", "codex", "Project alias fixture", "D:/WorkSpace/ProjectAliases", 1000, 3000, 1, 10, Date.now());
  insert.run("project-alias-wsl", "pi", "Project alias fixture", "/mnt/d/WorkSpace/ProjectAliases", 1000, 2000, 1, 10, Date.now());

  const providerInfo = [
    { id: "codex", name: "Codex", icon: "", available: true, manageable: false },
    { id: "pi", name: "Pi", icon: "", available: true, manageable: false },
  ];
  const routes = captureGetRoutes(registerSessions, {
    appConfig: {},
    providerMap: new Map(providerInfo.map((provider) => [provider.id, { ...provider, capabilities: {} }])),
    providerInfo,
  });
  const pageRoute = routes.find(({ pattern }) => pattern === "/sessions");
  const apiRoute = routes.find(({ pattern }) => pattern === "/api/sessions");

  const page = await pageRoute.handler({ url: "/sessions?provider=codex&provider=pi&q=Project%20alias%20fixture" }, createResponseCapture());
  assert.equal(page.status, 200);
  assert.equal((page.body.match(/ProjectAliases \(3\)/g) || []).length, 1);

  const response = createResponseCapture();
  await apiRoute.handler({
    url: "/api/sessions?provider=codex&provider=pi&q=Project%20alias%20fixture&project=D%3A%5CWorkSpace%5CProjectAliases"
  }, response);
  const payload = JSON.parse(response.body);
  assert.equal(payload.total, 3);
  assert.deepEqual(new Set(payload.sessions.map((session) => session.id)), new Set([
    "project-alias-win",
    "project-alias-slash",
    "project-alias-wsl"
  ]));
});

test("stats route reads filters from the request URL and degrades file-provider controls honestly", async () => {
  let requestedDays = null;
  const adapter = {
    id: "codex",
    name: "Route fixture",
    icon: "",
    capabilities: {},
    getTokenStats(days) {
      requestedDays = days;
      return [];
    }
  };
  const providerInfo = [{ id: "codex", name: "Route fixture", icon: "", available: true, manageable: false }];
  const routes = captureGetRoutes(registerSettingsStatsTrash, {
    appConfig: { configPath: path.join(temp, "config.json") },
    providerMap: new Map([["codex", adapter]]),
    providerInfo
  });
  const route = routes.find(({ pattern }) => pattern === "/:provider/stats");
  assert.ok(route);

  const result = await route.handler({ url: "/codex/stats?days=7&scope=root&model=x/y" }, createResponseCapture(), { provider: "codex" });
  assert.equal(result.status, 200);
  assert.equal(requestedDays, 7);
  assert.match(result.body, /value="7" checked/);
  assert.match(result.body, /aggregate token data only/);
  assert.doesNotMatch(result.body, /name="model"/);
  assert.doesNotMatch(result.body, /name="scope" value="root" checked/);

  requestedDays = null;
  const historical = await route.handler({ url: "/codex/stats?days=custom&from=2025-07-01&to=2025-07-07" }, createResponseCapture(), { provider: "codex" });
  assert.equal(historical.status, 200);
  assert.ok(requestedDays > 7, "historical custom ranges must collect far enough back before filtering daily aggregates");

  const jsonExportRoute = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.includes("stats\\/export\\.json"));
  const csvExportRoute = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.includes("stats\\/export\\.csv"));
  assert.ok(jsonExportRoute);
  assert.ok(csvExportRoute);

  requestedDays = null;
  const jsonUrl = "/api/codex/stats/export.json?days=7";
  const jsonMatch = new URL(jsonUrl, "http://127.0.0.1").pathname.match(jsonExportRoute.pattern);
  const jsonResult = await jsonExportRoute.handler({ url: jsonUrl }, createResponseCapture(), jsonMatch);
  assert.equal(jsonResult.status, 200);
  assert.equal(requestedDays, 7, "JSON export must parse filters from req.url");
  assert.equal(jsonResult.headers["Content-Disposition"], 'attachment; filename="token-explorer-codex.json"');
  assert.equal(JSON.parse(jsonResult.body).filters.days, 7);

  requestedDays = null;
  const csvUrl = "/api/codex/stats/export.csv?days=90";
  const csvMatch = new URL(csvUrl, "http://127.0.0.1").pathname.match(csvExportRoute.pattern);
  const csvResult = await csvExportRoute.handler({ url: csvUrl }, createResponseCapture(), csvMatch);
  assert.equal(csvResult.status, 200);
  assert.equal(requestedDays, 90, "CSV export must parse filters from req.url");
  assert.match(csvResult.body, /^Provider,Composition Mode,Day \(UTC\),/);
  assert.equal(csvResult.headers["Content-Disposition"], 'attachment; filename="token-explorer-codex.csv"');
});

test("centralized Usage page aggregates selected providers and preserves component totals", async () => {
  const currentDay = new Date().toISOString().slice(0, 10);
  const providers = [
    {
      id: "codex", name: "Codex", icon: "", capabilities: {},
      getTokenStats() { return [{ day: currentDay, inputTokens: 10, outputTokens: 4, reasoningTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 0, totalTokens: 21, messageCount: 2 }]; }
    },
    {
      id: "pi", name: "Pi", icon: "", capabilities: {},
      getTokenStats() { return [{ day: currentDay, inputTokens: 7, outputTokens: 3, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1, totalTokens: 11, messageCount: 1 }]; }
    }
  ];
  const providerInfo = providers.map((provider) => ({ id: provider.id, name: provider.name, icon: "", available: true, manageable: false }));
  const routes = captureGetRoutes(registerSettingsStatsTrash, {
    appConfig: { configPath: path.join(temp, "config.json") },
    providerMap: new Map(providers.map((provider) => [provider.id, provider])),
    providerInfo,
  });
  const route = routes.find(({ pattern }) => pattern === "/stats");
  assert.ok(route);
  const result = await route.handler({ url: "/stats?provider=codex&provider=pi&days=7" }, createResponseCapture());
  assert.equal(result.status, 200);
  assert.match(result.body, /Usage by provider/);
  assert.match(result.body, /Codex/);
  assert.match(result.body, /Pi/);
  assert.match(result.body, /data-token-total="32"/);
  assert.match(result.body, /name="provider" value="codex" checked/);
  assert.match(result.body, /name="provider" value="pi" checked/);
  assert.match(result.body, /href="\/stats\?provider=codex&amp;days=7"/);
  assert.match(result.body, /href="\/stats\?provider=pi&amp;days=7"/);
  assert.match(result.body, /href="\/codex\/stats\?days=7"/);
  assert.match(result.body, /href="\/pi\/stats\?days=7"/);
  assert.match(result.body, /data-provider-token-total="32">32<\/strong>/);
  assert.match(result.body, /Selected providers total/);
  assert.match(result.body, /Total Token Trend/);
  assert.match(result.body, /Providers shown/);
  assert.ok(result.body.indexOf("Total Token Trend") < result.body.indexOf("Usage by provider"));
  assert.match(result.body, /Show only Codex/);
  assert.match(result.body, /Show only Pi/);
  assert.equal((result.body.match(/Provider details/g) || []).length, 2);

  const focused = await route.handler({ url: "/stats?provider=codex&days=7" }, createResponseCapture());
  assert.equal(focused.status, 200);
  assert.match(focused.body, /class="stats-provider-breakdown-card is-selected"/);
  assert.match(focused.body, /class="stats-provider-filter-link stats-provider-open"[^>]*href="\/stats\?days=7"[^>]*aria-label="Codex: Show all providers"/);
  assert.doesNotMatch(focused.body, /aria-current="true"/);
  assert.match(focused.body, /<span class="stats-provider-capability selected">Selected<\/span>/);
  assert.match(focused.body, /href="\/stats\?days=7"/);
  assert.match(focused.body, /Show all providers/);
  assert.doesNotMatch(focused.body, /Show only Codex/);
});

test("sqlite stats defer supporting sections to a fragment endpoint", async () => {
  const statsTemp = mkdtempSync(path.join(os.tmpdir(), "agentsession-deferred-stats-"));
  const dbPath = path.join(statsTemp, "sessions.db");
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT);
      CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT, title TEXT, slug TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    `);
    const now = Date.now();
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)").run("session-1", null, null, "Deferred fixture", "deferred", statsTemp, now, now);
    db.prepare("INSERT INTO message VALUES (?, ?, ?)").run("message-1", "session-1", JSON.stringify({
      role: "assistant", providerID: "openai", modelID: "gpt-5", time: { created: now }, tokens: { input: 4, output: 2, total: 6 }
    }));
    db.close();

    const adapter = {
      id: "opencode", name: "Route fixture", icon: "", capabilities: { openCodeStatsStore: true },
      getDataPath() { return dbPath; },
      getTokenStats() { return []; },
    };
    const routes = captureGetRoutes(registerSettingsStatsTrash, {
      appConfig: { configPath: path.join(statsTemp, "config.json"), tokenPricing: {} },
      providerMap: new Map([["opencode", adapter]]),
      providerInfo: [{ id: "opencode", name: "Route fixture", icon: "", available: true, manageable: false }]
    });
    const pageRoute = routes.find(({ pattern }) => pattern === "/:provider/stats");
    const deferredRoute = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.includes("stats\\/deferred"));
    assert.ok(pageRoute);
    assert.ok(deferredRoute);

    const page = await pageRoute.handler({ url: "/opencode/stats?days=30" }, createResponseCapture(), { provider: "opencode" });
    assert.equal(page.status, 200);
    assert.match(page.body, /data-stats-deferred-section="secondary"/);
    assert.doesNotMatch(page.body, /top-sessions-table/);

    const day = new Date(now).toISOString().slice(0, 10);
    const drilled = await pageRoute.handler({ url: `/opencode/stats?days=30&day=${day}` }, createResponseCapture(), { provider: "opencode" });
    assert.equal(drilled.status, 200);
    assert.doesNotMatch(drilled.body, /data-stats-deferred-section="secondary"/);
    assert.match(drilled.body, /id="stats-session-results"/);
    assert.match(drilled.body, /top-sessions-table/);
    assert.match(drilled.body, /Filtered to/);

    const url = "/api/opencode/stats/deferred?days=30&section=secondary";
    const match = new URL(url, "http://127.0.0.1").pathname.match(deferredRoute.pattern);
    assert.ok(match);
    const deferred = await deferredRoute.handler({ url }, createResponseCapture(), match);
    assert.equal(deferred.status, 200);
    assert.match(deferred.body, /top-sessions-table/);
    assert.match(deferred.body, /stats-coverage/);
  } finally {
    closeDb(dbPath);
    rmSync(statsTemp, { recursive: true, force: true });
  }
});

test.after(() => {
  closeMetaDb();
  closeIndexDb();
  rmSync(temp, { recursive: true, force: true });
});
