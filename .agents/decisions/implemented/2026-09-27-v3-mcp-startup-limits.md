---
status: implemented
date: 2026-09-27
decision: Restore the four 2.0 MCP limits as validated, startup-only 3.0 configuration at the native stdio boundary.
---

# Native MCP startup limits

## Context

AgentSession 2.0 accepts `mcp.searchLimit`, `timelineLimit`, `eventMaxChars`,
and `contextWindow`. The first 3.0 binary rejected the `mcp` object and used
fixed defaults in its stdio handlers. These limits govern MCP response size,
not provider facts or the shared Reader projections.

## Decision

The selected 3.0 JSON config validates the four optional fields as positive
integers bounded by 100, 200, 20000, and 20, and fills omitted fields with
20, 50, 4000, and 5. The typed result is passed to the native MCP handler at
startup. Search, timeline, get-event, and each side of context use the
configured value as their default and cap valid explicit values to it. Browse
uses `searchLimit` only as its default; explicit browse requests cap at the
separate hard maximum of 100. The providers-level browse request remains
unpaged. Invalid numeric input returns `invalid_input`, and invalid selected
config prevents startup before protocol stdout is opened.
Extra keys inside `mcp` are ignored, matching the 2.0 validator's four-known-field
boundary; the top-level 3.0 config parser remains strict.

## Alternatives considered

- Putting these limits in the shared core would make the Web and Reader query
  contract depend on MCP process configuration.
- Exposing them through live Settings would imply a mutable MCP handler in
  another process; the existing config path already supports restart-based
  changes.

## Consequences

Existing 2.0 files with this `mcp` object load in the 3.0 native process, and
valid oversized MCP requests are capped as in 2.0. The schema still advertises
the absolute hard maxima. The Settings editor remains limited to its existing
three runtime fields and preserves the selected startup config on save.

## Verification

The public native stdio regression failed on both protocol eras because 3.0
rejected `mcp` at startup (0/3), then passed on the first app build (3/3).
The focused browse/search/timeline/get/context suite passed 33 tests with 3
private-data skips after updating prior hard-limit assertions to the 2.0 cap
semantics. CLI/settings/output regressions passed 14/14, `npm run review` and
targeted rustfmt passed. Once the parallel core source edit stabilized,
`cargo test -p agentsession-v3 --locked --offline` passed 2/2 app unit tests.
The tested Windows debug binary SHA-256 was
`47fc737da6cc8cbd07e153f183b0bbfc0e9ea09e8287c7a7ee2c283731b63fb0`
from HEAD `50a32e7c5b3f` plus the uncommitted 3.0 tree. The public DSH
root/alpha/beta source hashes stayed unchanged; exact values appear in the
delivery plan. An initial app test attempt saw an incomplete parallel edit in
`core/providers/codex.rs`; the stable-source rerun passed. The final integrated
binary and release remain for later validation.
