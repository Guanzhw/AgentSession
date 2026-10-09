---
status: implemented
date: 2026-09-27
decision: Pi publishes one source-backed request usage record per distinct assistant response
---

# Pi request usage in Session Protocol v3

## Context

Pi's v3 protocol exposed raw assistant source events but left `usageRecords`
empty even when those records carried provider request usage. The Viewer total
also includes tool-result and summary-generation usage, so a session total
cannot be relabeled as a request record.

## Decision

The [Pi adapter](../../../v3/crates/core/src/providers/pi.rs) projects usage
only from JSONL `message` entries whose role is `assistant` and whose usage is
recorded. It uses `responseId` when present and otherwise the entry ID as the
stable request identity, retaining one occurrence per identity and preferring
the occurrence on the active branch for a Reader anchor. Embedded `retainedTail`
messages, tool-result usage, compaction and branch-summary usage stay outside
this request domain. A pending/deferred assistant with all-zero usage is not a
completed request. Pi's raw output includes reasoning; the request record
separates those components once and retains an inconsistent explicit total as
unknown rather than inventing an arithmetic replacement.

The shared [protocol validator](../../../v3/crates/core/src/protocol/observations.rs)
checks unique request IDs, canonical session ownership and any linked source
event. The v3 document reports `usage` as observed when request records exist
and not-observed otherwise. Other providers remain unchanged. Daily billing
statistics and provider-specific context-origin attribution are separate
follow-on slices.

## Alternatives considered

Using the Pi session token total would mix assistant requests with tool-result
and summary-generation usage. Reconstructing request usage from rendered
Reader turns would drop source entries on inactive branches and records with
no visible turn anchor. Neither preserves Pi's recorded request identity.

## Consequences

The protocol can now answer Pi request-level usage queries with recorded
provenance. A missing or inconsistent total remains `null` even when its
individual components are known. Statistics exports still report unavailable
request totals until their aggregation and daily-series contract is
implemented.

## Verification

- [Public Pi request tests](../../../v3/test/pi-request-usage-protocol.test.mjs)
  were RED 0/1 against a binary that returned no `usageRecords`, then GREEN
  3/3 after implementation. They check exact recorded token components,
  request IDs, exclusion of embedded/summary usage, repeated response
  ownership, pending zero usage and inconsistent totals through the real HTTP process.
- The existing [Pi foundation HTTP tests](../../../v3/test/pi-protocol-foundation-http.test.mjs)
  now assert source-backed usage coverage. One frozen real five-row Pi source
  independently matches its raw assistant request count and recorded total;
  its SHA-256 `c6db5c9c105be0961721fef7f0f8f1b5d2458933bc48fc13302fd768e0c42c29`
  and the isolated copy were unchanged.
- Pi HTTP/Reader/MCP focused tests passed 12/12. The shared validator has a
  focused duplicate-ID and wrong-source-anchor test. A complete repository
  regression and final release binary validation remain part of S4.
