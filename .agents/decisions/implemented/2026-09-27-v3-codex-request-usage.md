---
status: implemented
date: 2026-09-27
decision: Codex v3 publishes only source-owned request usage after replay and copied-parent classification
---

# Codex request usage in Session Protocol v3

## Context

The Rust Codex adapter already preserved raw usage events, but its v3
`usageRecords` were empty. The 2.0 parser distinguishes completed request
usage from cumulative turn/thread snapshots, adjacent replay and copied parent
history in child rollouts. Relabeling a session total as request usage would
lose those ownership rules.

## Decision

The [Codex adapter](../../../v3/crates/core/src/providers/codex.rs) reads
`event_msg/token_count.info.last_token_usage` and
`token_usage_record.payload.usage` from the same streamed source as protocol
events. It excludes the parent-owned prefix before a recorded child `NEW_TASK`
boundary. For older children without that envelope, it excludes a leading run
of at least two complete usage fingerprints only when the declared parent
source proves the copy. A missing parent source supplies no proof.

Within owned rows, an equal snapshot with the same response ID or an
immediately adjacent compatible replay counts once. Later source evidence
proved nonadjacent legacy mirrors by pairing request and cumulative snapshots;
the [paired mirror decision](2026-09-28-v3-codex-paired-usage-mirrors.md)
extends this selection rule. Cumulative turn/thread
objects and all-zero window-reset rows do not become requests. Codex's raw
input includes cached and cache-write tokens, and raw output includes
reasoning; the adapter separates them into the protocol components once.
The recorded total remains the request total, including rows that record only
`total_tokens`; absent component fields remain unknown rather than zero. The
Library session total sums these selected owned request totals. A recorded
`thread_settings_applied` model adds derived model provenance to the row;
otherwise the request provenance stays recorded. A unique recorded turn run
may supply `runId`. Usage has no Reader event anchor in this source shape.

The shared protocol validator continues to enforce unique request IDs and
canonical session ownership. The usage domain is observed when request rows
exist and not-observed when the parsed source contains none. Aggregated daily
statistics remain outside this slice.

## Alternatives considered

Using `turn_token_usage`, `thread_token_usage` or the Viewer session total
would count cumulative snapshots as requests. Deduplicating every equal token
vector would merge distinct responses, so replay removal requires a shared
response identity or immediate adjacency.

## Consequences

HTTP protocol consumers receive source-owned Codex request components and
their model provenance. Legacy child ownership can require reading the
declared parent source; without that source, a copied prefix remains
unproven. Daily exports remain outside this slice.

## Verification

- [HTTP request tests](../../../v3/test/codex-request-usage-protocol.test.mjs)
  were RED 0/3 against the existing binary because every `usageRecords` array
  was empty. After implementation, the public v153, mixed legacy/current,
  recorded child boundary, and parent-matched legacy prefix cases passed 4/4.
- The opt-in frozen real Codex source check passed 1/1 through Axum. Its
  21,661,089-byte source SHA-256
  `09a4ffe7602a3bc28988aa862841948d8229b3b0c58698d1f74270b21547bbee`
  was unchanged. The selected response's six normalized components matched
  the independently captured raw request at source line 9126.
- `cargo test --manifest-path v3/Cargo.toml -p agentsession-core --locked
  --offline` passed 101 tests with 11 private cases ignored. The focused
  Codex protocol and two-generation MCP suite passed 16 tests with the private
  case skipped; the private case passed separately. The debug binary SHA-256
  was `0edbd196a732b23f9f45c3f3413ba124b5cada16f2959df307388f22aa91f84d`.
- A later frozen five-provider side-by-side comparison found 12 selected
  Codex requests containing only `total_tokens`. A public test first failed
  because 3.0 omitted them, then passed after retaining the total and unknown
  components. The two frozen root Library totals now equal 2.0 exactly:
  295,276,811 and 88,747,596; the eight frozen provider sources retained
  their SHA-256 hashes. An opt-in frozen Reader count test also confirmed the
  first root's 34 additional 3.0 rendered turns are recorded child-agent
  returns: 351 with them, 317 without them, matching the 2.0 count.

## Remaining scope

This request record projection does not implement daily usage aggregation or
the complete CORE-14 statistics and export contract. A legacy child whose
declared parent source is unavailable cannot prove a copied token prefix.
