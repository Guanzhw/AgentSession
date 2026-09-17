import assert from "node:assert/strict";
import test from "node:test";
import { createStructuredViewCache, createStructuredViewMethods } from "../dist/src/providers/shared/file-adapter-helpers.js";

test("structured views built slower than the TTL remain reusable after completion", (t) => {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  let builds = 0;
  const getViews = createStructuredViewCache((sessionId) => {
    builds += 1;
    now += 2_500;
    return { tree: { sessionId }, container: { sessionId }, metrics: { sessionId } };
  });
  const methods = createStructuredViewMethods(getViews);
  const first = getViews("slow-session");
  assert.equal(methods.getSessionTree("slow-session"), first.tree);
  assert.equal(methods.getSessionContainer("slow-session"), first.container);
  assert.equal(methods.getSessionMetrics("slow-session"), first.metrics);
  now += 999;
  assert.equal(getViews("slow-session"), first);
  assert.equal(builds, 1, "construction time does not consume the reuse window");
  now += 1;
  assert.notEqual(getViews("slow-session"), first);
  assert.equal(builds, 2);
});

test("structured view cache expires exactly one second after construction without sliding on hits", (t) => {
  let now = 20_000;
  t.mock.method(Date, "now", () => now);
  let builds = 0;
  const getViews = createStructuredViewCache((sessionId) => ({ sessionId, build: ++builds }));
  const first = getViews("session");
  now += 999;
  assert.equal(getViews("session"), first);
  now += 1;
  const second = getViews("session");
  assert.notEqual(second, first);
  assert.equal(builds, 2);
  assert.equal(getViews("session"), second);
});

test("structured view cache keeps its single-session ownership when the requested session changes", (t) => {
  t.mock.method(Date, "now", () => 30_000);
  const builtSessions = [];
  const getViews = createStructuredViewCache((sessionId) => {
    builtSessions.push(sessionId);
    return { sessionId };
  });
  const first = getViews("first");
  assert.equal(getViews("first"), first);
  const second = getViews("second");
  assert.equal(second.sessionId, "second");
  assert.equal(getViews("second"), second);
  assert.notEqual(getViews("first"), first, "switching sessions replaces the one cached entry");
  assert.deepEqual(builtSessions, ["first", "second", "first"]);
});

test("unavailable structured views remain cached only for the same completed-view window", (t) => {
  let now = 40_000;
  t.mock.method(Date, "now", () => now);
  let builds = 0;
  const getViews = createStructuredViewCache(() => {
    builds += 1;
    return null;
  });
  assert.equal(getViews("missing"), null);
  now += 999;
  assert.equal(getViews("missing"), null);
  assert.equal(builds, 1);
  now += 1;
  assert.equal(getViews("missing"), null);
  assert.equal(builds, 2);
});
