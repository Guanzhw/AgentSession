---
status: implemented
date: 2026-09-29
decision: Carry provider source uncertainty from the same fresh catalog inventory observation into search.
---

# Search inventory observation

## Context

On the frozen 816-file Codex cohort, a healthy search spent about 42 ms reading
the fresh inventory and another 41 ms scanning the same source files for
uncertainty. The second scan also ran for empty catalogs, where no summary row
could communicate an unresolved header.

## Decision

Provider adapters may return inventory entries and source uncertainty as one
observation. Codex derives both from its single fresh source scan. Catalog
publication carries that observation to search; other catalog consumers retain
their existing rows and revision interface. Rebuild uses the same observation
contract. Search uses the published uncertainty when no summary row already
supplies a source diagnostic.

## Alternatives considered

- Cache source uncertainty across requests: a time window could conceal a
  changed or newly unreadable source.
- Infer uncertainty from catalog rows: an unresolved file may have no canonical
  session ID and therefore produce no row.

## Consequences

Each unchanged Codex search keeps a fresh per-request header read while avoiding
the immediate duplicate source walk. Inventory signatures, capture validation,
and catalog revisions continue to own source-change detection. The observation
is request-local and does not add a TTL or provider-specific branch to shared
search or catalog code.

## Verification

The focused Rust search test was RED at two walks for an empty catalog and GREEN
at one walk for valid, empty, and unresolved Codex sources. The unresolved case
retains its partial diagnostic. Existing source-set and same-stat header rewrite
tests cover the provider's inventory and revision behavior.
`cargo test --workspace` and `cargo test --workspace --features search-phase-probe`
each passed 169 core and 2 app tests, with 14 intentionally ignored core tests.
The rebuilt stdio MCP search suite passed 9 tests with 1 frozen-corpus test
skipped. `npm run review` and `git diff --check` passed. The exact release
candidate `4313bfe5` then matched the independent source golden for all nine
queries, including every ordered result and first page; source stats and binary
SHA were unchanged. Three diagnostic runs per implementation measured 30 warm
requests each: median core search time changed from 123.480 to 81.257 ms, and
the second uncertainty scan from 41.326 to 0 ms. This probe result is not a
substitute for the paired end-to-end product benchmark.
The redacted records are source-golden comparison (`../../../tmp/v3-performance/single-inventory-gold-4313bfe5-20260929-a/summary.public.json`, local evidence)
and phase comparison (`../../../tmp/v3-performance/search-probe-single-inventory-summary-20260929.public.json`, local evidence).
