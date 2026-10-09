---
status: implemented
date: 2026-10-10
decision: Present collaboration and reading position directly while folding continuous execution
---

# Reader presentation and navigation

## Context

Actual desktop screenshots showed adjacent agent markers sharing a lane, repeated
execution disclosures without intervening replies, manual transcript continuation,
and raw encrypted spawn input. The collaboration panel listed handoffs without a
visual relationship. Tool and reasoning entries also crowded the Contents pane.
Real Codex sessions contained 14 and 1 recorded compact checkpoints respectively;
initial pagination and folded request replies obscured their directory entries.

## Decision

- Recorded participants, actor paths and canonical child references determine
  agent names and stable colors/icons across dispatch, return and relationship
  graph. Unloaded or absent returns reserve separate lanes and short open-ended
  markers; they never acquire a fabricated return endpoint.
- A compact relationship graph selects one handoff's details while keeping
  canonical dispatch, child and return navigation available.
- Adjacent already-hidden execution and standalone reasoning share a disclosure.
  Readable replies, checkpoints and gaps remain boundaries; source ownership,
  order and complete process counts are preserved.
- Transcript continuation observes the bottom boundary. Automatic pages preserve
  scroll position and stop on explicit source errors; the button retries manually.
- Contents includes messages and standalone context checkpoints. Recorded tools
  and reasoning remain accessible through transcript disclosures, source links
  and search, without creating Contents entries.
- Contents follows the visible root message and reading progress uses its source
  ordinal. User message bubbles align right; reply text retains left alignment.
- The Library uses available width and reports known tokens and recorded
  conversation span. Unpriced costs and absent source facts remain unknown.

## Alternatives considered

Keeping a flat collaboration list and manual page controls leaves the reported
reading problems. Connecting dispatch-only markers to arbitrary later positions
would fabricate relationships. Hiding raw input entirely would remove inspection
of recorded source; the explicit technical disclosure preserves that access.

## Consequences

These changes simplify the human reading surface while preserving normalized API
facts and canonical anchors. Existing provider, performance and platform release
gates keep their independently recorded status.

## Verification

Focused collaboration, layout, graph, tool-header and process-grouping tests pass.
The real compact counts and targeted checkpoint rendering were checked against
provider-owned JSONL and the native HTTP/browser surface without editing sources.
The root governance, Rust formatting and locked compilation gate passes.
The complete Rust suite passed 218 tests with 15 explicit ignores. After fixing
the duplicate-provider diagnostic key and updating the changed browser flows,
the complete root and native Node suite passed 697 tests with 46 explicit skips
and no failures against the final release binary. Its browser checks cover
automatic continuation without moving the visible message, outline following,
standalone checkpoints, agent graph navigation, folded raw input, and preserved
provider bytes. The in-app browser checked a real six-agent graph and the exact
`compaction-763` checkpoint; a quiet native Library request read 1,623 sessions.
The staged clean checkout also passed governance. Results are recorded in
`tmp/v3-consolidation-20261009/reader-final-node-test.log`, the Rust portion of
`reader-final-test.log`, and the local handoff report. These local artifacts are
outside the Git deliverable.
