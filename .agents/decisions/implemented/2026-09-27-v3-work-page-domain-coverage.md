---
status: implemented
date: 2026-09-27
decision: Work pages carry same-revision domain coverage
---

## Context

The Runtime Work page is bounded, but the v3 protocol document contains the full
source event stream. DSH correctly reports work coverage as unknown while its
empty Work page says only `partial`. Fetching the full document on every Work
filter or page load transfers an unbounded event list and loads the provider a
second time just to explain the empty projection.

## Decision

The shared [protocol bundle](../../../v3/crates/core/src/protocol/observations.rs)
now derives one `work` domain coverage value for both the v3 document and each
bounded Work page. `domainCoverage` accompanies the Work page's session and
revision, so the [Viewer](../../../v3/ui/src/lib/RuntimeWork.svelte) can display
it without another request. Recorded Work observations mark this domain observed;
otherwise provider-owned coverage is retained, with unknown when undeclared.
The existing `coverage: partial` still describes the page's overall projection.

## Alternatives considered

The Viewer could request the full v3 document for every Work page, but that
duplicates provider work and transfers every source event. A separate coverage
route would avoid the transfer but still require another provider load and a
second revision check. Carrying domain coverage on the existing bounded page
uses the same validated bundle as its entries.

## Consequences

An empty page with unknown Work coverage explains that source events may still
contain unprojected work. Filters and pagination return the same domain state
at the same revision. The v3 protocol document remains available to clients
that explicitly request full facts, while ordinary Work browsing stays bounded.

## Verification

- The public DSH HTTP/browser test first failed because the Work page had no
  `domainCoverage`; it now matches the full document's `coverage.work` at the
  same revision and shows unknown without claiming absence.
- The browser test confirms Work browsing does not request the full protocol
  document. DSH and Codex Work/browser tests passed 6/6 with zero skips.
- Svelte build and Rust app build passed. Provider source fixtures remained
  unchanged. Final release and performance checks remain separate gates.
