---
status: implemented
date: 2026-09-27
decision: Render bounded, source-anchored execution landmarks in Reader and expose execution-only event pagination.
---

# Bounded execution presentation in Reader

## Context

WEB-13 needs the source-side yield to remain visible before interleaved
assistant work, returned results to be identified at the tool event that
recorded them, and yielded work without a recorded return to remain explicitly
unknown. Fetching all Runtime events for this view would also load unrelated
tool payloads.

## Decision

Add an `executionOnly` filter to the existing bounded Runtime events route and
include it in cursor identity. Reader requests an initial page of at most 200
execution events, renders each normalized phase at its exact `readerEvent`, and
offers continuation that appends into the same execution chain. It reports an
unreturned outcome as unknown only when all execution pages have been read.
Only recorded terminal phases establish completion or failure; interruption
requests remain requests. Full tool output continues to use the existing
loadable content path.

## Alternatives considered

- Load unfiltered Runtime pages and retain unrelated events and output in the
  Reader: this fetches data the execution view does not consume.
- Infer completion from a yield, process ID, or interruption request: none of
  these records establishes a returned result.
- Load every execution event before rendering: that delays the source-side
  landmark and removes bounded continuation.

## Consequences

The first source-side landmark appears with the first bounded page, while
continuation enriches the same source-identified execution without duplication.
Unknown remains provisional until pagination is exhausted. The Runtime events
route currently reconstructs the full Codex protocol stream for every page, so
the bounded response does not establish large-session performance.
The first recorded yield and terminal return now link to each other's exact
Reader event through the existing location endpoint; no return link appears
without a recorded terminal event.
Reader checks each execution page's session identity and source revision against
the open Reader bootstrap before adding landmarks. A mismatch stays visible as
a reload diagnostic instead of combining facts from two source revisions. An
initial failed fetch offers the same retry action as a later-page failure.

## Verification

At base revision `50a32e7c5b3fdaa1d335771da80d6c919d4ab536`,
`cargo test --workspace` passed 99 core and 2 app tests (11 opt-in/private tests ignored),
including execution filter pagination and cursor identity. `npm run review`,
`npm run build` in `v3/ui`, and `cargo build -p agentsession-v3` passed. The
real-browser acceptance `v3/test/ui-codex-execution-reader-real.test.mjs`
passed 1/1 against pinned binary SHA-256
`682e44cc4b990bb766b62d93f40e6e7b2cf8f2b5cd756b2ff9d4dafab1bac325`; the
Runtime events browser regression `v3/test/ui-runtime-events.test.mjs` passed
1/1 against the same binary. The three public acceptance fixtures remained
unchanged: `19ae8ff840ac48eec55a845a1984eb9a5a8c6be325c2a857a30a7848920e3036`,
`9abffd09d1de882fa7327dc2813a1d058bee5cef11aafcb8aab772297c6e45a9`, and
`fad56db8e4db3be870f40d85d1cb3dffefc44b3a321a32e3aef72c55050c05ca`.
The later reciprocal-link RED failed against the old shared debug binary;
the integrated binary SHA-256
`f47fd4786b75f74542614cb126bfdb9c84e35a691550e160ccc96277a4f6bd89`
passed the same real-browser test 1/1, including yield-to-return and return-to-yield
navigation through URL history.
The revision-mismatch browser regression was RED before the Reader check and
GREEN afterward; the initial-fetch retry regression and the full
`v3/test/ui-pane-search.test.mjs` suite passed (6/6) against the same UI source.
