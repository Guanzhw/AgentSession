---
status: implemented
date: 2026-09-27
decision: Pi publishes readable active compaction summaries as validated Context results
---

# Pi Context results

## Context

The Pi adapter retained compaction and branch-summary source events and Reader
text, while v3 Context versions and transformations were empty. An entry on an
inactive file branch, or an operation without readable summary text, does not
establish a result context.

## Decision

The [Pi adapter](../../../v3/crates/core/src/providers/pi.rs) emits one
ContextVersion and ContextTransformation for each active summary with
non-whitespace text and a Reader anchor. The version takes the finalized
protocol event sequence and recorded provenance. The transformation points to
that version and source event. `firstKeptEntryId` remains a source entry ID;
when its event exists, the result also carries that canonical event ID.
Recorded `retainedTail` contributes only its count. No parent version,
artifact, run, or turn is inferred, and summary text remains in Reader.
Pi only creates that Reader item when the active summary has non-whitespace
text. Raw compaction and branch-summary protocol events remain even when the
summary is missing, with an unknown Context result coverage diagnostic.

The shared [validator](../../../v3/crates/core/src/protocol/observations.rs)
requires unique identities, recorded provenance, a readable version anchor,
and a transformation result bound to that same event. Runtime Context joins
the two facts into one result card with a Reader link. Context coverage is
observed for a readable active result, unknown for an operation without one,
and not-observed when no operation is recorded.

## Alternatives considered

Making every source operation a result would claim missing or inactive
summaries as available. Treating `firstKeptEntryId` as a parent context version
would confuse a Pi source entry with a derived context identity. Copying the
summary into the Runtime card would repeat the Reader content.

## Consequences

Pi Context has a navigable recorded result while raw events still preserve all
file branches. v2 facts remain the same. Context cursor identity changes only
for the Context projection because its entry list changed.

## Verification

- A focused Rust test failed before implementation because ContextVersion and
  ContextTransformation were absent. The final focused validator tests pass,
  including a cross-event result reference rejection.
- [Pi HTTP tests](../../../v3/test/pi-protocol-foundation-http.test.mjs) pass
  alongside Pi event, request-usage, and browser tests, 16/16. They check both
  public Pi formats, source-ordered pagination, active summaries, retained
  source IDs, inactive operations, missing and whitespace-only compaction and
  branch summaries, v2/v3 fact parity, Reader/TOC, and both native MCP
  protocol versions. Reader and protocol-anchor assertions were RED against
  the earlier isolated binary and GREEN after the Pi Reader fix. The MCP
  timeline assertions passed before the fix because its projection already
  excludes blank message bodies, and remain a regression check.
- The public source SHA-256 values are `27c71761ba18139eb4327645e08015e7a3d20d264a5935f3768e45306eaa2607`
  (`pi-current.jsonl`) and `08fa72960ec5da8e3f699446e81d3b2e2928658274376c211039fc7a9827a0ae`
  (`pi-v3-current.jsonl`). The frozen real five-row source is
  `c6db5c9c105be0961721fef7f0f8f1b5d2458933bc48fc13302fd768e0c42c29`.
  Each original and isolated copy remained unchanged. The real source has no
  compaction result.
- The Svelte UI build and [Pi browser test](../../../v3/test/ui-pi-context-result.test.mjs)
  pass. The browser confirms one joined card, no duplicated summary body, and
  navigation back to the recorded Reader summary on the public Pi fixture.
  Verification on a current real 0.85.1 compaction transcript remains open;
  the local Pi install has no representative transcript.
