import assert from "node:assert/strict";
import test from "node:test";

import { icons } from "../dist/src/icons.js";

test("all supported providers have their own recognizable icon marks", () => {
  assert.deepEqual(Object.keys(icons), [
    "opensession",
    "opencode",
    "claude",
    "codex",
    "pi",
    "deepseekHarness"
  ]);

  assert.match(icons.opencode, /viewBox="0 0 240 300"/);
  assert.match(icons.opencode, /M180 60H60V240H180V60Z/);
  assert.match(icons.claude, /viewBox="0 0 24 24"/);
  assert.match(icons.claude, /m4\.714 15\.956/);
  assert.match(icons.codex, /M22\.282 9\.821/);
  assert.match(icons.pi, /<path d="M5 7h14"/);
  assert.match(icons.deepseekHarness, /<path d="M5 5\.5h10\.5/);
});
