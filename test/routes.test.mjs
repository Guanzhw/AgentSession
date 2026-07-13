import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-routes-"));
process.env.OPENSESSIONVIEWER_META_PATH = path.join(temp, "meta.db");

const { initConfig } = await import("../dist/src/config.js");
initConfig([]);

const { Router } = await import("../dist/src/router.js");
const { getProvider } = await import("../dist/src/providers/index.js");
const { providerRenderContext } = await import("../dist/src/routes/provider-context.js");
const { registerSessionDetail } = await import("../dist/src/routes/session-detail.js");
const { registerSessions } = await import("../dist/src/routes/sessions.js");
const { registerSettingsStatsTrash } = await import("../dist/src/routes/settings-stats-trash.js");
const { closeIndexDb } = await import("../dist/src/index-db.js");
const { closeDb } = await import("../dist/src/db.js");

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
      analysis: {},
      resumeCommands: {},
      allowTerminalLaunch: false
    },
    providerMap: new Map([[provider.id, provider]]),
    providerInfo: []
  });
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
      analysis: {},
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

test("provider page keeps unavailable paths and management capability provider-owned", async () => {
  const providers = ["gemini"].map((providerId) => getProvider(providerId));
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
    { provider: "codex", providers: providerInfo, manageable: false }
  );
  assert.equal(
    providerRenderContext("codex", providerInfo, { capabilities: { localManagement: true } }).manageable,
    true
  );
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

test("sqlite stats defer supporting sections to a fragment endpoint", async () => {
  const statsTemp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-deferred-stats-"));
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
      id: "opencode", name: "Route fixture", icon: "", capabilities: { sqliteSessionStore: true },
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
  closeIndexDb();
  rmSync(temp, { recursive: true, force: true });
});
