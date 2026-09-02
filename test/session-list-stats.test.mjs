// Tests for the provider-neutral session list statistics (correction to the
// unified session protocol commit 02f2b38): base fallback derivation,
// protocol-aware counts, bounded revision cache, route integration on every
// list surface, and sessionCard rendering of the bounded chips.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-list-stats-"));
process.env.AGENTSESSION_META_PATH = path.join(temp, "meta.db");

const { initConfig } = await import("../dist/src/config.js");
initConfig([]);
const { registerSessions } = await import("../dist/src/routes/sessions.js");
const { sessionCard } = await import("../dist/src/views/components.js");
const { toApiSessionShape } = await import("../dist/src/session-queries.js");
const { getIndexDb, closeIndexDb } = await import("../dist/src/index-db.js");
const { closeMetaDb } = await import("../dist/src/meta.js");
const { closeDb } = await import("../dist/src/db.js");
const {
  baseSessionListStats,
  deriveSessionListStats,
  attachSessionListStats,
  boundedListStats,
  clearSessionListStatsCache,
  sessionListStatsCacheSize
} = await import("../dist/src/session-list-stats.js");

test.after(() => {
  try {
    closeIndexDb();
    closeMetaDb();
    closeDb();
  } catch { /* best effort */ }
  try { rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
});

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

function protocolEvent(id, kind, timestamp, extra = {}) {
  return {
    id,
    sessionId: "p-1",
    sequence: 1,
    timestamp,
    kind,
    provenance: { fidelity: "derived", sourceType: "fixture", sourceId: id },
    ...extra
  };
}

/** Protocol-capable adapter whose getSessionProtocol cost is observable. */
function protocolAdapter(id = "codex-fake", calls = []) {
  return {
    id,
    name: "Protocol fixture",
    icon: "",
    capabilities: { localManagement: true },
    protocolCapabilities: {
      sessionEvents: { support: "partial", provenance: "derived" },
      sessionRelationships: { support: "none", provenance: "derived" },
      tasks: { support: "full", provenance: "recorded" },
      agentRuns: { support: "partial", provenance: "derived" },
      contextArtifacts: { support: "full", provenance: "recorded" }
    },
    getSessionProtocol(sessionId) {
      calls.push(sessionId);
      if (sessionId === "nope") return null;
      return {
        sessionId,
        events: [
          protocolEvent("e1", "message.user", 1000),
          protocolEvent("e2", "message.assistant", 2000),
          protocolEvent("e3", "context.compaction", 1500, { compaction: { trigger: "automatic", strategy: "summary" } }),
          protocolEvent("e4", "context.compaction", 3000, { compaction: { trigger: "manual", strategy: "summary" } })
        ].map((event) => ({ ...event, sessionId })),
        relationships: [],
        tasks: [
          { id: "t1", sessionId, kind: "subagent-task", status: "running", title: null, timeCreated: 1000, timeUpdated: 3000, timeCompleted: null, provenance: { fidelity: "recorded", sourceType: "fixture" } },
          { id: "t2", sessionId, kind: "subagent-task", status: "completed", title: null, timeCreated: 1200, timeUpdated: 2000, timeCompleted: 2000, provenance: { fidelity: "recorded", sourceType: "fixture" } }
        ],
        agentRuns: [
          { id: "r1", sessionId, taskId: "t1", status: "running", mode: "subagent", agent: "a", model: null, childSessionId: null, timeStart: 1000, timeEnd: null, provenance: { fidelity: "derived", sourceType: "fixture" } },
          { id: "r2", sessionId, taskId: "t1", status: "blocked", mode: "background", agent: "b", model: null, childSessionId: null, timeStart: 1500, timeEnd: null, provenance: { fidelity: "derived", sourceType: "fixture" } },
          { id: "r3", sessionId, taskId: "t2", status: "completed", mode: "subagent", agent: "a", model: null, childSessionId: null, timeStart: 1200, timeEnd: 2000, provenance: { fidelity: "derived", sourceType: "fixture" } }
        ],
        contextArtifacts: [
          { id: "c1", sessionId, kind: "memory", scope: "session", origin: "agent-generated", contentAccess: "metadata-only", title: "note", summary: null, sourcePath: null, producerRunId: null, sourceSessionIds: [sessionId], hash: null, redacted: false, provenance: { fidelity: "recorded", sourceType: "fixture" }, timeCreated: 1000 },
          { id: "c2", sessionId, kind: "summary", scope: "session", origin: "provider-generated", contentAccess: "metadata-only", title: null, summary: null, sourcePath: null, producerRunId: null, sourceSessionIds: [sessionId], hash: null, redacted: true, provenance: { fidelity: "recorded", sourceType: "fixture" }, timeCreated: 1500 }
        ]
      };
    }
  };
}

function plainAdapter(id = "pi") {
  return { id, name: "Plain", icon: "", capabilities: {} };
}

// ── Base fallback derivation ────────────────────────────────────────────

test("base stats derive from snake_case and camelCase row fields", () => {
  const snake = baseSessionListStats({
    id: "s1", provider: "codex", time_created: 1000, time_updated: 5000,
    message_count: 12, token_count: 345
  });
  assert.equal(snake.messageCount, 12);
  assert.equal(snake.tokenCount, 345);
  assert.equal(snake.durationMs, 4000);
  assert.equal(snake.durationSource, "raw");
  assert.equal(snake.protocol, false);

  const camel = baseSessionListStats({
    id: "s1", provider: "pi", timeCreated: 2000, timeUpdated: 7000,
    messageCount: 4, tokenCount: 99
  });
  assert.equal(camel.messageCount, 4);
  assert.equal(camel.tokenCount, 99);
  assert.equal(camel.durationMs, 5000);
  assert.equal(camel.durationSource, "raw");
});

test("base stats treat 0 and unavailable truthfully and never fabricate tokens", () => {
  const known = baseSessionListStats({ id: "s1", provider: "pi", message_count: 0, token_count: 0, time_created: 1000, time_updated: 1000 });
  assert.equal(known.messageCount, 0, "recorded zero message count survives");
  assert.equal(known.tokenCount, 0, "recorded zero token count survives");
  assert.equal(known.durationMs, 0, "same-ms span is a truthful zero");

  const unknown = baseSessionListStats({ id: "s2", provider: "pi" });
  assert.equal(unknown.messageCount, null);
  assert.equal(unknown.tokenCount, null);
  assert.equal(unknown.durationMs, null);
  assert.equal(unknown.durationSource, null);
  assert.equal(unknown.memoryCount, null);

  const inverted = baseSessionListStats({ id: "s3", provider: "pi", time_created: 5000, time_updated: 1000 });
  assert.equal(inverted.durationMs, null, "updated < created is not a valid span");
  const zeroCreated = baseSessionListStats({ id: "s4", provider: "pi", time_created: 0, time_updated: 1000 });
  assert.equal(zeroCreated.durationMs, null, "unknown created time is not a valid span");
});

// ── Protocol-aware derivation ───────────────────────────────────────────

test("protocol stats merge compactions, statuses, runs, and artifacts", () => {
  const calls = [];
  const stats = deriveSessionListStats(protocolAdapter("codex-fake", calls), {
    id: "p-1", provider: "codex-fake", time_created: 500, time_updated: 9000,
    message_count: 8, token_count: 100
  });
  assert.equal(stats.protocol, true);
  assert.equal(stats.compactions, 2);
  assert.equal(stats.lastCompactionAt, 3000, "max non-null compaction timestamp");
  assert.equal(stats.durationMs, 2000, "first/last event span wins over raw span");
  assert.equal(stats.durationSource, "protocol");
  assert.equal(stats.taskCount, 2);
  assert.equal(stats.agentRunCount, 3, "runs are the execution count");
  assert.equal(stats.subagentRunCount, 2, "only subagent mode counts as subagent");
  assert.equal(stats.backgroundRunCount, 1, "background|scheduled|team modes");
  assert.deepEqual(stats.activeStatuses, ["running", "blocked"], "fixed order, deduped, active only");
  assert.equal(stats.contextArtifactCount, 2);
  assert.equal(stats.memoryCount, 1, "kind memory distinguishable when present");
  assert.equal(calls.length, 1);
});

test("protocol stats never double-count Task and AgentRun", () => {
  const adapter = protocolAdapter("codex-fake", []);
  const stats = deriveSessionListStats(adapter, { id: "p-1", provider: "codex-fake" });
  assert.equal(stats.taskCount, 2);
  assert.equal(stats.agentRunCount, 3);
  assert.equal(stats.taskCount + stats.agentRunCount, 5, "kept as separate dimensions");
});

test("unsupported adapters and unknown sessions degrade to base stats", () => {
  const base = deriveSessionListStats(plainAdapter("pi"), { id: "g1", provider: "pi", message_count: 3, token_count: 10, time_created: 1000, time_updated: 2000 });
  assert.equal(base.protocol, false);
  assert.equal(base.compactions, 0);
  assert.equal(base.activeStatuses.length, 0);
  assert.equal(base.memoryCount, null, "no protocol evidence -> memory unknown, not zero");
  assert.equal(base.messageCount, 3);
  assert.equal(base.durationSource, "raw");

  const nullAdapter = deriveSessionListStats(null, { id: "x1", provider: "x" });
  assert.equal(nullAdapter.protocol, false);

  // Supported adapter, unknown session: protocol-derived values remain unknown.
  const calls = [];
  const unknown = deriveSessionListStats(protocolAdapter("codex-fake", calls), { id: "nope", provider: "codex-fake" });
  assert.equal(unknown.protocol, false);
  assert.equal(unknown.compactions, 0);
  assert.equal(unknown.memoryCount, null, "missing protocol does not fabricate a recorded zero");
});

test("protocol construction failure falls back without caching", () => {
  clearSessionListStatsCache();
  const failing = {
    id: "broken", name: "Broken", icon: "", capabilities: {},
    getSessionProtocol() { throw new Error("boom"); }
  };
  const stats = deriveSessionListStats(failing, { id: "s1", provider: "broken", message_count: 2 });
  assert.equal(stats.protocol, false);
  assert.equal(stats.messageCount, 2);
  assert.equal(sessionListStatsCacheSize(), 0, "failed lookups are never cached");
});

// ── Bounded revision cache ──────────────────────────────────────────────

test("protocol results are cached by provider+id+revision and bounded", () => {
  clearSessionListStatsCache();
  const calls = [];
  const adapter = protocolAdapter("codex-fake", calls);

  deriveSessionListStats(adapter, { id: "p-1", provider: "codex-fake", time_updated: 9000, message_count: 8, token_count: 100 });
  deriveSessionListStats(adapter, { id: "p-1", provider: "codex-fake", time_updated: 9000, message_count: 8, token_count: 100 });
  assert.equal(calls.length, 1, "same revision reuses the cached protocol summary");

  let providerRevision = 1;
  adapter.getStatsRevision = () => providerRevision;
  deriveSessionListStats(adapter, { id: "p-1", provider: "codex-fake", time_updated: 9000, message_count: 8, token_count: 100 });
  providerRevision = 2;
  deriveSessionListStats(adapter, { id: "p-1", provider: "codex-fake", time_updated: 9000, message_count: 8, token_count: 100 });
  assert.equal(calls.length, 3, "provider stats revision invalidates otherwise unchanged list stats");

  deriveSessionListStats(adapter, { id: "p-1", provider: "codex-fake", time_updated: 9100, message_count: 8, token_count: 100 });
  assert.equal(calls.length, 4, "revision change (timeUpdated) invalidates the entry");

  deriveSessionListStats(adapter, { id: "p-1", provider: "codex-fake", time_updated: 9100, message_count: 9, token_count: 100 });
  assert.equal(calls.length, 5, "revision change (messageCount) invalidates the entry");

  const plain = plainAdapter("pi");
  deriveSessionListStats(plain, { id: "g1", provider: "pi", time_updated: 1 });
  assert.equal(sessionListStatsCacheSize(), 5, "one entry per distinct revision; unsupported providers never enter the cache");

  clearSessionListStatsCache();
  const otherCalls = [];
  const otherAdapter = protocolAdapter("codex-other", otherCalls);
  for (let index = 0; index < 300; index += 1) {
    deriveSessionListStats(otherAdapter, { id: `s-${index}`, provider: "codex-other", time_updated: index });
  }
  assert.equal(otherCalls.length, 300);
  assert.equal(sessionListStatsCacheSize(), 256, "cache stays bounded at 256 entries");
  clearSessionListStatsCache();
});

// ── Bounded API projection ──────────────────────────────────────────────

test("boundedListStats strips unknown fields and clamps values", () => {
  assert.equal(boundedListStats(null), null);
  assert.equal(boundedListStats("junk"), null);
  const bounded = boundedListStats({
    provider: "codex", sessionId: "p-1",
    messageCount: 4, tokenCount: "40", durationMs: 1000, durationSource: "protocol",
    protocol: true, compactions: 2, lastCompactionAt: 3000,
    taskCount: 2, agentRunCount: 3, subagentRunCount: 2, backgroundRunCount: 1,
    activeStatuses: ["running", "made-up", "blocked", "running"],
    contextArtifactCount: 2, memoryCount: 1,
    events: [{ id: "leak" }], relationships: "leak"
  });
  assert.deepEqual(bounded.activeStatuses, ["running", "blocked"], "unknown statuses dropped, duplicates removed");
  assert.equal(bounded.tokenCount, 40, "numeric strings normalized");
  assert.equal(bounded.events, undefined, "raw protocol is never exposed");
  assert.equal(bounded.relationships, undefined);

  const clamped = boundedListStats({ compactions: -3, taskCount: -1, memoryCount: -5, activeStatuses: [] });
  assert.equal(clamped.compactions, 0);
  assert.equal(clamped.taskCount, 0);
  assert.equal(clamped.memoryCount, 0);
  assert.equal(boundedListStats({ memoryCount: null }).memoryCount, null);
  assert.equal(boundedListStats({ durationSource: "invented" }).durationSource, null);
});

test("toApiSessionShape exposes only the bounded stats object", () => {
  const row = { id: "p-1", provider: "codex-fake", title: "T", directory: "D", time_updated: 9000, stats: { protocol: true, compactions: 2, events: [{ x: 1 }] } };
  const shape = toApiSessionShape(row);
  assert.equal(shape.stats.protocol, true);
  assert.equal(shape.stats.compactions, 2);
  assert.equal(shape.stats.events, undefined, "bounded projection strips protocol payloads");

  const plain = toApiSessionShape({ id: "g1", provider: "pi", title: "T", directory: "D", time_updated: 5000, message_count: 7, token_count: 21, time_created: 1000 });
  assert.equal(plain.stats.messageCount, 7);
  assert.equal(plain.stats.tokenCount, 21);
  assert.equal(plain.stats.durationMs, 4000);
  assert.equal(plain.stats.protocol, false, "fallback base summary for rows without attached stats");
});

// ── Route integration ───────────────────────────────────────────────────

function seedIndex(rows) {
  const db = getIndexDb();
  const insert = db.prepare(`INSERT OR REPLACE INTO session_index
    (id, provider, parent_id, title, directory, time_created, time_updated, message_count, token_count, last_indexed)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows) {
    insert.run(row.id, row.provider, row.title, row.directory, row.timeCreated, row.timeUpdated, row.messageCount, row.tokenCount, Date.now());
  }
}

function buildRoutes() {
  // Provider HTML routes require a registered provider id, so the protocol
  // fixture mounts under the real "codex" id; the providerMap still supplies
  // our own adapters, so no real provider code runs.
  const protocolProvider = protocolAdapter("codex");
  const plain = plainAdapter("pi");
  const providerInfo = [
    { id: "codex", name: "Codex Fixture", icon: "", available: true, manageable: true },
    { id: "pi", name: "Pi", icon: "", available: true, manageable: false }
  ];
  const routes = captureGetRoutes(registerSessions, {
    appConfig: {},
    providerMap: new Map([[protocolProvider.id, protocolProvider], [plain.id, plain]]),
    providerInfo
  });
  return routes;
}

test("list routes attach stats only for the current page on every surface", async () => {
  clearSessionListStatsCache();
  seedIndex([
    { id: "p-1", provider: "codex", title: "Protocol session", directory: "D:\\p", timeCreated: 1000, timeUpdated: 9000, messageCount: 8, tokenCount: 100 },
    { id: "p-2", provider: "codex", title: "Second session", directory: "D:\\p", timeCreated: 2000, timeUpdated: 8000, messageCount: 3, tokenCount: 40 },
    { id: "g-1", provider: "pi", title: "Plain session", directory: "D:\\g", timeCreated: 3000, timeUpdated: 7000, messageCount: 5, tokenCount: 60 },
    { id: "g-2", provider: "pi", title: "Plain two", directory: "D:\\g", timeCreated: 4000, timeUpdated: 6000, messageCount: 2, tokenCount: 20 }
  ]);
  const routes = buildRoutes();
  const pageRoute = routes.find(({ pattern }) => pattern === "/sessions");
  const apiRoute = routes.find(({ pattern }) => pattern === "/api/sessions");
  const providerPageRoute = routes.find(({ pattern }) => pattern === "/:provider");
  const providerApiRoute = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.includes("/sessions$"));
  assert.ok(pageRoute && apiRoute && providerPageRoute && providerApiRoute);

  // Global API: current page only (limit 2 -> exactly 2 cached derivations).
  const apiResponse = createResponseCapture();
  await apiRoute.handler({ url: "/api/sessions?provider=codex&provider=pi&limit=2&returnTo=%2Fsessions%3Fprovider%3Dcodex%26provider%3Dpi" }, apiResponse);
  const payload = JSON.parse(apiResponse.body);
  assert.equal(payload.sessions.length, 2);
  assert.equal(sessionListStatsCacheSize(), 2, "only the returned page enters the cache");
  assert.equal(payload.sessions[0].provider, "codex", "newest sessions are on the page");
  const protocolSession = payload.sessions[0];
  assert.equal(protocolSession.stats.protocol, true);
  assert.equal(protocolSession.stats.compactions, 2);
  assert.equal(protocolSession.stats.activeStatuses[0], "running");
  assert.equal(protocolSession.stats.memoryCount, 1);
  assert.match(protocolSession.html, /class="session-card"/);
  assert.match(protocolSession.html, /session-provider-badge/);
  assert.match(protocolSession.html, /from=%2Fsessions%3Fprovider%3Dcodex%26provider%3Dpi/);

  // Unsupported-provider fallback through its own provider API.
  const plainApiResponse = createResponseCapture();
  await providerApiRoute.handler({ url: "/api/pi/sessions?limit=30" }, plainApiResponse, ["", "pi", ""]);
  const plainPayload = JSON.parse(plainApiResponse.body);
  assert.equal(plainPayload.sessions.length, 2);
  const plainSession = plainPayload.sessions[0];
  assert.equal(plainSession.stats.protocol, false, "unsupported provider degrades to base stats");
  assert.equal(plainSession.stats.messageCount, 5);
  assert.equal(plainSession.stats.durationMs, 4000);
  assert.equal(plainSession.stats.events, undefined, "raw protocol never leaves the server");
  assert.match(plainSession.html, /class="session-card"/);

  // Provider API.
  const providerApiResponse = createResponseCapture();
  await providerApiRoute.handler({ url: "/api/codex/sessions?limit=30" }, providerApiResponse, ["", "codex", ""]);
  const providerPayload = JSON.parse(providerApiResponse.body);
  assert.equal(providerPayload.sessions.length, 2);
  assert.ok(providerPayload.sessions.every((s) => s.stats && s.stats.protocol === true));
  assert.equal(providerPayload.sessions[0].stats.compactions, 2);
  assert.doesNotMatch(providerPayload.sessions[0].html, /session-provider-badge/);
  assert.match(providerPayload.sessions[0].html, /class="card-checkbox"/);

  const unknownKindResponse = createResponseCapture();
  await providerApiRoute.handler({ url: "/api/codex/sessions?kind=unknown&limit=1" }, unknownKindResponse, ["", "codex", ""]);
  assert.equal(JSON.parse(unknownKindResponse.body).sessions.length, 1, "unknown legacy kind parameters are ignored");

  // Global HTML page renders the chips.
  const page = await pageRoute.handler({ url: "/sessions?provider=codex&provider=pi" }, createResponseCapture());
  assert.equal(page.status, 200);
  assert.match(page.body, /class="stat-chip"/);
  assert.match(page.body, /2× compacted/);
  assert.match(page.body, /8 messages/);
  assert.match(page.body, /100 tokens/);
  assert.match(page.body, /1 memory/);
  assert.match(page.body, /2 subagents/);
  assert.match(page.body, /1 background/);
  assert.match(page.body, /running/);
  assert.match(page.body, /blocked/);

  // Provider HTML page.
  const providerPage = await providerPageRoute.handler(
    { url: "/codex" },
    createResponseCapture(),
    { provider: "codex" }
  );
  assert.equal(providerPage.status, 200);
  assert.match(providerPage.body, /2× compacted/);
  assert.match(providerPage.body, /title="Observed session duration/);

  // Unsupported-provider HTML page has no protocol chips, only base stats.
  const plainPage = await providerPageRoute.handler(
    { url: "/pi" },
    createResponseCapture(),
    { provider: "pi" }
  );
  assert.equal(plainPage.status, 200);
  assert.doesNotMatch(plainPage.body, /compacted/, "no protocol compaction chips for unsupported providers");
  assert.doesNotMatch(plainPage.body, /subagents/, "no protocol run chips for unsupported providers");
  assert.doesNotMatch(plainPage.body, /stat-chip-running|stat-chip-blocked/, "no active-status chips for unsupported providers");
  assert.match(plainPage.body, /5 messages/);
  assert.match(plainPage.body, /60 tokens/);
  assert.match(plainPage.body, /4s\. Recorded session duration/, "base duration chip remains for every provider");
  clearSessionListStatsCache();
});

// ── sessionCard rendering ───────────────────────────────────────────────

test("sessionCard renders bounded statistic chips with titles and aria labels", () => {
  const stats = {
    provider: "codex-fake", sessionId: "p-1",
    messageCount: 8, tokenCount: 1200, durationMs: 3600000, durationSource: "protocol",
    protocol: true, compactions: 2, lastCompactionAt: 1700000000000,
    taskCount: 2, agentRunCount: 3, subagentRunCount: 2, backgroundRunCount: 1,
    activeStatuses: ["running", "blocked"],
    contextArtifactCount: 2, memoryCount: 1
  };
  const html = sessionCard({ id: "p-1", provider: "codex-fake", title: "Fixture", time_updated: Date.now(), stats });
  assert.match(html, /8 messages/);
  assert.match(html, /1\.2k tokens/);
  assert.match(html, /60m/);
  assert.match(html, /aria-label="60m\. Observed session duration/);
  assert.match(html, /2× compacted/);
  assert.match(html, /last at /);
  assert.match(html, /2 subagents/);
  assert.match(html, /1 background/);
  assert.match(html, /stat-chip-running/);
  assert.match(html, /stat-chip-blocked/);
  assert.match(html, /2 artifacts/);
  assert.match(html, /1 memory/);
  assert.match(html, /<footer class="session-card-stats">/);
});

test("sessionCard omits unknown and protocol-specific zero values", () => {
  const html = sessionCard({
    id: "s1", provider: "pi", title: "Plain", time_updated: Date.now(),
    stats: {
      provider: "pi", sessionId: "s1",
      messageCount: null, tokenCount: 0, durationMs: null, durationSource: null,
      protocol: false, compactions: 0, lastCompactionAt: null,
      taskCount: 0, agentRunCount: 0, subagentRunCount: 0, backgroundRunCount: 0,
      activeStatuses: [], contextArtifactCount: 0, memoryCount: null
    }
  });
  assert.doesNotMatch(html, /stat-chip/, "no chips when nothing is known");
  assert.doesNotMatch(html, /tokens/, "zero token count is not rendered");

  const protocolZeros = sessionCard({
    id: "p-1", provider: "codex-fake", title: "Zero", time_updated: Date.now(),
    stats: {
      provider: "codex-fake", sessionId: "p-1",
      messageCount: 0, tokenCount: 5, durationMs: 500, durationSource: "protocol",
      protocol: true, compactions: 0, lastCompactionAt: null,
      taskCount: 0, agentRunCount: 0, subagentRunCount: 0, backgroundRunCount: 0,
      activeStatuses: [], contextArtifactCount: 0, memoryCount: 0
    }
  });
  assert.match(protocolZeros, /0 messages/, "recorded zero message count is rendered");
  assert.doesNotMatch(protocolZeros, /compacted/, "zero compactions omitted");
  assert.doesNotMatch(protocolZeros, /subagents/, "zero runs omitted");
  assert.doesNotMatch(protocolZeros, /artifacts/, "zero artifacts omitted");
  assert.doesNotMatch(protocolZeros, /memory/, "zero memory omitted");
  assert.doesNotMatch(protocolZeros, /stat-chip-running/, "no active statuses");

  const noStats = sessionCard({ id: "s1", provider: "pi", title: "None", time_updated: Date.now() });
  assert.doesNotMatch(noStats, /stat-chip/);
});

test("sessionCard escapes session and chip title content", () => {
  const html = sessionCard({
    id: "p-1", provider: "codex-fake", title: "<script>alert(1)</script>", time_updated: Date.now(),
    stats: {
      provider: "codex-fake", sessionId: "p-1",
      messageCount: 1, tokenCount: 2, durationMs: 1000, durationSource: "protocol",
      protocol: true, compactions: 1, lastCompactionAt: 1700000000000,
      taskCount: 0, agentRunCount: 0, subagentRunCount: 0, backgroundRunCount: 0,
      activeStatuses: [], contextArtifactCount: 0, memoryCount: null
    }
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /title="Context compacted 1 times/);
});
