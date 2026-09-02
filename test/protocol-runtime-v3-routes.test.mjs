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
