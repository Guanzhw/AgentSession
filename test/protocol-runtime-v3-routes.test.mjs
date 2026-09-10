import assert from "node:assert/strict";
import test from "node:test";

import { registerSessionDetail } from "../dist/src/routes/session-detail.js";
import { clearProtocolRuntimeCache } from "../dist/src/protocol-runtime.js";

function captureGetRoutes(deps) {
  const routes = [];
  registerSessionDetail({ get(pattern, handler) { routes.push({ pattern, handler }); } }, deps);
  return routes;
}

function response() {
  return {
    statusCode: 0, headersSent: false, writableEnded: false, body: "",
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    end(value = "") { this.body += String(value); this.writableEnded = true; }
  };
}

function fixtureProvider() {
  return {
    id: "fixture", name: "Fixture", icon: "", protocolCapabilities: {}, capabilities: {},
    getSession(id) {
      return id === "root" ? { id, provider: "fixture", timeCreated: 1, timeUpdated: 2, messageCount: 0, tokenCount: 0 } : null;
    },
    getSessionProtocol(id) {
      return id === "root" ? { sessionId: id, events: [], relationships: [], tasks: [], agentRuns: [], contextArtifacts: [] } : null;
    }
  };
}

test("v3 runtime routes expose each domain and preserve explicit unknown coverage", async () => {
  const provider = fixtureProvider();
  const routes = captureGetRoutes({
    appConfig: { port: 3456 }, providerMap: new Map([["fixture", provider]]), providerInfo: []
  });
  for (const domain of ["work", "execution", "coordination", "context"]) {
    const route = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.includes(`/runtime\\/${domain}$`));
    assert.ok(route, `route for ${domain}`);
    const res = response();
    await route.handler({ url: `/api/fixture/session/root/runtime/${domain}?maxItems=1` }, res, ["", "fixture", "root"]);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.version, 3);
    assert.equal(body.domain, domain);
    assert.equal(body.coverage.state, "unknown");
    assert.deepEqual(body.focus, { provider: "fixture", sessionId: "root" });
  }
});

test("v3 runtime routes reject an out-of-range bound", async () => {
  const provider = fixtureProvider();
  const routes = captureGetRoutes({
    appConfig: { port: 3456 }, providerMap: new Map([["fixture", provider]]), providerInfo: []
  });
  const route = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.includes("/runtime\\/work$"));
  const res = response();
  await route.handler({ url: "/api/fixture/session/root/runtime/work?maxItems=301" }, res, ["", "fixture", "root"]);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).code, "invalid_input");
});

test("run-only route continues from a live anchor after the session revision changes", async () => {
  clearProtocolRuntimeCache();
  let updated = 2;
  let prepend = false;
  const provider = {
    ...fixtureProvider(),
    getSession(id) {
      return id === "root" ? { id, provider: "fixture", timeCreated: 1, timeUpdated: updated, messageCount: 0, tokenCount: 0 } : null;
    },
    getSessionProtocol(id) {
      const runs = Array.from({ length: 7 }, (_, index) => ({
          id: `run-${index + 1}`, sessionId: id, taskId: null, status: "completed", mode: "unknown",
          agent: null, model: null, childSessionId: null, timeStart: index, timeEnd: index + 1,
          provenance: { fidelity: "recorded", sourceType: "fixture" }
      }));
      if (prepend) runs.unshift({
        id: "new-child", sessionId: id, taskId: null, status: "completed", mode: "unknown",
        agent: null, model: null, childSessionId: null, timeStart: 0, timeEnd: 1,
        provenance: { fidelity: "recorded", sourceType: "fixture" }
      });
      return id === "root" ? {
        sessionId: id, events: [], relationships: [], tasks: [], contextArtifacts: [], branches: [], agentRuns: runs
      } : null;
    }
  };
  const routes = captureGetRoutes({
    appConfig: { port: 3456 }, providerMap: new Map([["fixture", provider]]), providerInfo: []
  });
  const route = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.includes("/runtime\\/execution\\/runs$"));
  assert.ok(route);
  const firstResponse = response();
  await route.handler({ url: "/api/fixture/session/root/runtime/execution/runs?limit=3" }, firstResponse, ["", "fixture", "root"]);
  assert.equal(firstResponse.statusCode, 200);
  const first = JSON.parse(firstResponse.body);
  assert.equal(first.ok, true);
  assert.deepEqual(first.focus, { provider: "fixture", sessionId: "root" });
  assert.deepEqual(first.range, { start: 1, end: 3 });
  assert.equal(first.total, 7);
  assert.equal(first.pageSize, 3);
  assert.equal(first.runs.length, 3);
  assert.equal(first.evidenceRuns.length, 3);
  assert.match(first.html, /data-runtime-run-page/);
  assert.ok(first.nextCursor);

  updated = 3;
  prepend = true;
  const continuedResponse = response();
  await route.handler({ url: `/api/fixture/session/root/runtime/execution/runs?cursor=${encodeURIComponent(first.nextCursor)}` }, continuedResponse, ["", "fixture", "root"]);
  assert.equal(continuedResponse.statusCode, 200);
  const continued = JSON.parse(continuedResponse.body);
  assert.deepEqual(continued.runs.map(({ run }) => run.id), ["run-4", "run-5", "run-6"]);
  assert.equal(continued.revision.source, "provider");
  assert.equal(continued.revision.value, "|3|0|0");
  assert.match(continued.html, /latest recorded run state/i);

  const conflict = response();
  await route.handler({ url: `/api/fixture/session/root/runtime/execution/runs?cursor=${encodeURIComponent(first.nextCursor)}&limit=2` }, conflict, ["", "fixture", "root"]);
  assert.equal(conflict.statusCode, 400);
  assert.match(JSON.parse(conflict.body).error, /conflicts with the cursor page size/);
});

test("v3 runtime routes expose a stable protocol-invalid response for invalid v2 snapshots", async () => {
  clearProtocolRuntimeCache();
  const invalidSource = Object.freeze({
    version: 2, sessionId: "root",
    session: {
      ref: { provider: "fixture", sessionId: "root" }, state: "unknown", origin: "fixture",
      timeCreated: null, timeUpdated: null, cwd: null, harness: "fixture", terminalOutcome: null,
      forkSeedBoundary: null, inheritedEventCount: null,
      provenance: { fidelity: "derived", sourceType: "fixture" }
    }, events: [], relationships: [], tasks: [], agentRuns: [], contextArtifacts: [], branches: [],
    validation: { ok: false, completeness: "invalid", errors: [{ code: "SOURCE_INVALID", severity: "error", message: "bad source" }], warnings: [] },
    completeness: "invalid"
  });
  const provider = { ...fixtureProvider(), getSessionProtocol() { return invalidSource; } };
  const routes = captureGetRoutes({
    appConfig: { port: 3456 }, providerMap: new Map([["fixture", provider]]), providerInfo: []
  });
  const route = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.includes("/runtime\\/work$"));
  const res = response();
  await route.handler({ url: "/api/fixture/session/root/runtime/work" }, res, ["", "fixture", "root"]);
  assert.equal(res.statusCode, 422);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: "Session protocol is invalid and cannot be projected.", code: "protocol_invalid" });
});
