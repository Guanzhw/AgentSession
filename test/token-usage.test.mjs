import assert from "node:assert/strict";
import test from "node:test";

import { sumTokenUsage } from "../dist/src/providers/shared/token-usage.js";
import {
  aggregateSessionContainerTokenUsage,
  aggregateSessionTreeTokenUsage
} from "../dist/src/providers/shared/session-usage.js";

function nestedSessionShape() {
  const child = {
    messages: [{ data: { tokens: { input: 10, output: 5, total: 42 } }, parts: [] }],
    detachedChildren: []
  };
  return {
    messages: [{
      data: { tokens: { input: 5, output: 2 } },
      parts: [{ childSessions: [child] }]
    }],
    detachedChildren: []
  };
}

test("shared token aggregation keeps provider-reported totals over partial components", () => {
  const usage = sumTokenUsage([
    { input: 5, output: 2 },
    { input: 10, output: 5, total: 42 }
  ]);

  assert.deepEqual(usage, {
    input: 15,
    output: 7,
    reasoning: 0,
    total: 49,
    cache: { read: 0, write: 0 }
  });
});

test("tree and container views use the same nested source-total aggregation", () => {
  const expected = {
    input: 15,
    output: 7,
    reasoning: 0,
    total: 49,
    cache: { read: 0, write: 0 }
  };

  assert.deepEqual(aggregateSessionTreeTokenUsage(nestedSessionShape()), expected);
  assert.deepEqual(aggregateSessionContainerTokenUsage(nestedSessionShape()), expected);
});
