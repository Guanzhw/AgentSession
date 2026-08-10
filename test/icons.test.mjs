import assert from "node:assert/strict";
import test from "node:test";

import { icons } from "../dist/src/icons.js";

test("OpenClaw and Hermes use recognizable upstream brand marks", () => {
  assert.match(icons.openclaw, /viewBox="0 0 120 120"/);
  assert.match(icons.openclaw, /fill-rule="evenodd"/);
  assert.match(icons.openclaw, /Q35 5 30 8/);
  assert.match(icons.hermes, /M10\.5 7C8 4 5\.5 4 4 5/);
  assert.match(icons.hermes, /M8 10c0 1\.2/);
});
