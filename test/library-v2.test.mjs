import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";

const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-library-v2-"));
process.env.AGENTSESSION_META_PATH = path.join(temp, "meta.db");
const { initConfig } = await import("../dist/src/config.js");
initConfig([]);

const { closeIndexDb, getCrossProviderOverview, getCrossProviderSessions, getIndexedSessionProjects, getIndexedSessions, upsertIndex } = await import("../dist/src/index-db.js");
const { closeMetaDb, getMeta } = await import("../dist/src/meta.js");
const { renderSessionsPage } = await import("../dist/src/views/sessions.js");
const { registerMutations } = await import("../dist/src/routes/mutations.js");
const { registerSessions } = await import("../dist/src/routes/sessions.js");

test.after(() => {
  closeIndexDb();
  closeMetaDb();
  rmSync(temp, { recursive: true, force: true });
});

function jsonRequest(body) {
  const req = new EventEmitter();
  req.headers = {
    host: "127.0.0.1:3456",
    "content-type": "application/json",
    origin: "http://127.0.0.1:3456"
  };
  req.socket = { remoteAddress: "127.0.0.1" };
  setImmediate(() => {
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function mutationResponse() {
  return {
    statusCode: 0,
    body: "",
    writeHead(status) { this.statusCode = status; return this; },
    end(chunk = "") { this.body += String(chunk); return this; }
  };
}

function captureGetRoutes(register, deps) {
  const routes = [];
  register({ get(pattern, handler) { routes.push({ pattern, handler }); } }, deps);
  return routes;
}

const NOW = Date.now();
const DAY = 86_400_000;

test("indexed overview reports recorded token totals and has-subagent filters", () => {
  upsertIndex("pi", [
    { id: "root-a", provider: "pi", parentId: null, title: "Root A", directory: "D:\\a", timeCreated: NOW - 50_000, timeUpdated: NOW - 5_000, messageCount: 10, tokenCount: 100 },
    { id: "root-b", provider: "pi", parentId: null, title: "Root B", directory: "D:\\b", timeCreated: NOW - 40_000, timeUpdated: NOW - 4_000, messageCount: 20, tokenCount: 200 },
    { id: "child-a", provider: "pi", parentId: "root-a", title: "Child of A", directory: "D:\\a", timeCreated: NOW - 30_000, timeUpdated: NOW - 3_000, messageCount: 1, tokenCount: 5 }
  ]);

  const overview = getCrossProviderOverview({ providers: ["pi"] });
  assert.equal(overview.totalSessions, 2, "root sessions only");
  assert.equal(overview.totalMessages, 30, "root message totals");
  assert.equal(overview.totalTokens, 300, "recorded token totals summed");

  const withSubagents = getIndexedSessions("pi", 10, 0, "", "", "", "updated-desc", undefined, undefined, undefined, true);
  assert.deepEqual(withSubagents.sessions.map((session) => session.id), ["root-a"]);

  const todayOnly = getIndexedSessions("pi", 10, 0, "today", "", "", "updated-desc", undefined, undefined, undefined, false);
  assert.deepEqual(todayOnly.sessions.map((session) => session.id), ["root-b", "root-a"]);
});

test("empty starred selection returns no cross-provider sessions", () => {
  const empty = getCrossProviderOverview({ providers: ["pi"], included: [] });
  assert.deepEqual(empty, { totalSessions: 0, totalMessages: 0, totalTokens: 0 });
});

test("starred child sessions and has-subagent project counts stay consistent", () => {
  const starredChild = getCrossProviderSessions({
    providers: ["pi"],
    included: [{ provider: "pi", id: "child-a" }]
  });
  assert.deepEqual(starredChild.sessions.map((session) => session.id), ["child-a"]);

  const projects = getIndexedSessionProjects("pi", "", "", undefined, undefined, undefined, true);
  assert.deepEqual(projects.map((project) => ({ id: project.id, count: project.count })), [
    { id: "D:\\a", count: 1 }
  ]);
});

test("global library page renders summary, round-trips filter chips, and buckets by day", () => {
  const providers = [
    { id: "pi", name: "Pi", icon: "", available: true, manageable: true },
    { id: "codex", name: "Codex", icon: "", available: true, manageable: true }
  ];
  const html = renderSessionsPage({
    sessions: [
      { id: "today-1", provider: "pi", title: "Today work", directory: "D:\\a", time_updated: NOW, summary_files: 0, summary_additions: 0, summary_deletions: 0 },
      { id: "yesterday-1", provider: "codex", title: "Yesterday work", directory: "D:\\b", time_updated: NOW - DAY, summary_files: 0, summary_additions: 0, summary_deletions: 0 }
    ],
    total: 3,
    totalMessages: 30,
    totalTokens: 300,
    range: "today",
    starredOnly: true,
    hasSubagent: true,
    providers,
    selectedProviders: ["pi", "codex"],
    global: true,
    manageable: false
  });

  // One horizontal sentence with provider/session/message/token totals.
  assert.match(html, /class="library-summary"/);
  assert.match(html, /<strong>2<\/strong> providers/);
  assert.match(html, /<strong>30<\/strong> messages/);
  assert.match(html, /<strong>300<\/strong> tokens/);

  // Chips round-trip the current filter state through the URL.
  assert.match(html, /href="[^"]*has-subagent=1[^"]*"[\s\S]*?data-chip="has-subagent"/);
  const activeToday = html.match(/<a class="filter-chip[^"]*is-active[^"]*" href="([^"]+)" aria-current="true" data-chip="range">/);
  assert.ok(activeToday, "today chip is active");
  const todayUrl = new URL(activeToday[1].replaceAll("&amp;", "&"), "http://localhost");
  assert.equal(todayUrl.searchParams.get("range"), null, "active chip toggles off its own param");
  assert.equal(todayUrl.searchParams.get("starred"), "1");
  assert.equal(todayUrl.searchParams.get("has-subagent"), "1");
  assert.deepEqual(todayUrl.searchParams.getAll("provider"), ["pi", "codex"]);

  // Timeline buckets by local day; both entries stay reachable.
  assert.match(html, /class="library-day" data-day="\d{4}-\d{2}-\d{2}">/);
  assert.match(html, /<h2>Today<\/h2>/);
  assert.match(html, /<h2>Yesterday<\/h2>/);
  assert.match(html, /<section class="session-list session-list-library" id="session-list" data-view="timeline">/);

  // View toggle carries a localStorage-persisted compact option.
  assert.match(html, /data-view="timeline" aria-pressed="true"/);
  assert.match(html, /data-view="compact" aria-pressed="false"/);
  const bundled = readFileSync(path.join(process.cwd(), "dist", "src", "static", "app.js"), "utf8");
  assert.match(bundled, /as\.library\.view/);

  // Infinite loading keeps the new has-subagent state.
  assert.match(html, /id="scroll-sentinel"[\s\S]*data-has-subagent="1"/);
});

test("library empty states stay distinct with one clear next action", () => {
  const providers = [{ id: "pi", name: "Pi", icon: "", available: true, manageable: true }];

  const empty = renderSessionsPage({ sessions: [], total: 0, providers, global: true, selectedProviders: ["pi"], provider: null });
  assert.match(empty, /data-empty="empty"/);
  assert.match(empty, /href="\/pi\/settings"/);

  const noResults = renderSessionsPage({
    sessions: [],
    total: 0,
    query: "missing",
    providers,
    global: true,
    selectedProviders: ["pi"],
    provider: null
  });
  assert.match(noResults, /data-empty="no-results"/);
  assert.match(noResults, /No sessions found for keyword: <strong>missing<\/strong>/);
  assert.match(noResults, /href="\/sessions"[\s\S]*?Clear all filters/);

  const unavailable = renderSessionsPage({
    sessions: [],
    total: 0,
    provider: "pi",
    providerAvailable: false,
    note: "Pi data was not detected at /nonexistent.",
    providers
  });
  assert.match(unavailable, /data-empty="unavailable"/);
  assert.match(unavailable, /Pi data was not detected at \/nonexistent\./);
  assert.match(unavailable, /href="\/pi\/settings"/);
});

test("structured storage diagnostics stay bounded instead of leaking object coercion", () => {
  const html = renderSessionsPage({
    sessions: [],
    total: 0,
    global: true,
    selectedProviders: ["openclaw"],
    providers: [{
      id: "openclaw",
      name: "OpenClaw",
      available: true,
      manageable: true,
      storageDiagnostic: { states: [{ status: "legacy-only", detail: "Provider-owned detail" }] }
    }]
  });
  assert.match(html, /OpenClaw · Storage diagnostic/);
  assert.doesNotMatch(html, /\[object Object\]/);
  assert.doesNotMatch(html, /Provider-owned detail/, "the shared view does not interpret provider diagnostic fields");
});

test("global sessions API cards carry per-provider batch controls", async () => {
  const providerInfo = [
    { id: "pi", name: "Pi", icon: "", available: true, manageable: true },
    { id: "readonly", name: "Read Only", icon: "", available: true, manageable: false }
  ];
  upsertIndex("pi", [
    { id: "api-1", provider: "pi", parentId: null, title: "API card", directory: "D:\\a", timeCreated: NOW - 20_000, timeUpdated: NOW - 2_000, messageCount: 3, tokenCount: 30 }
  ]);
  upsertIndex("readonly", [
    { id: "api-2", provider: "readonly", parentId: null, title: "Readonly card", directory: "D:\\b", timeCreated: NOW - 10_000, timeUpdated: NOW - 1_000, messageCount: 1, tokenCount: 10 }
  ]);
  const routes = captureGetRoutes(registerSessions, {
    appConfig: {},
    providerMap: new Map([
      ["pi", { id: "pi", capabilities: { localManagement: true } }],
      ["readonly", { id: "readonly", capabilities: {} }]
    ]),
    providerInfo,
  });
  const apiRoute = routes.find(({ pattern }) => pattern === "/api/sessions");
  assert.ok(apiRoute);
  const response = mutationResponse();
  await apiRoute.handler({ url: "/api/sessions?limit=30&offset=0&returnTo=%2Fsessions" }, response, []);
  const payload = JSON.parse(response.body);
  const piCard = payload.sessions.find((session) => session.provider === "pi");
  const readonlyCard = payload.sessions.find((session) => session.provider === "readonly");
  assert.ok(piCard);
  assert.ok(readonlyCard);
  assert.match(piCard.html, /class="card-checkbox" data-id="api-1" data-provider="pi"/);
  assert.match(piCard.html, /class="star-btn /);
  assert.match(piCard.html, /data-day="/);
  assert.match(piCard.html, /href="\/pi\/session\/api-1\?from=%2Fsessions"/);
  assert.doesNotMatch(readonlyCard.html, /card-checkbox/);
  assert.doesNotMatch(readonlyCard.html, /star-btn/);
});

test("cross-provider batch mutates viewer metadata per provider and skips unsupported sources", async () => {
  const posts = [];
  registerMutations({ post(pattern, handler) { posts.push({ pattern, handler }); }, get() {} }, {
    appConfig: { metaDir: temp, allowTerminalLaunch: false },
    providerMap: new Map([
      ["pi", { capabilities: { localManagement: true } }],
      ["codex", { capabilities: { localManagement: true } }],
      ["readonly", { capabilities: {} }]
    ]),
    availableProviders: []
  });
  const route = posts.find((entry) => entry.pattern === "/api/sessions/batch");
  assert.ok(route, "cross-provider batch route registered");

  const response = mutationResponse();
  await route.handler(jsonRequest({
    action: "star",
    items: [
      { provider: "pi", id: "p-1" },
      { provider: "codex", id: "c-1" },
      { provider: "readonly", id: "r-1" }
    ]
  }), response, []);
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.affected, 2);
  assert.equal(payload.skipped, 1);
  assert.equal(getMeta("pi", "p-1").starred, 1);
  assert.equal(getMeta("codex", "c-1").starred, 1);
  assert.equal(getMeta("readonly", "r-1"), null, "unsupported provider is never touched");

  const deleteResponse = mutationResponse();
  await route.handler(jsonRequest({
    action: "delete",
    items: [{ provider: "pi", id: "p-1" }]
  }), deleteResponse, []);
  const deletePayload = JSON.parse(deleteResponse.body);
  assert.equal(deletePayload.ok, true);
  assert.equal(deletePayload.affected, 1);
  assert.equal(getMeta("pi", "p-1").deleted, 1);
});
