---
status: implemented
date: 2026-09-27
decision: Claude publishes one source-backed usage record per evidenced assistant request
---

# Claude request usage in Session Protocol v3

## Context

The Rust Claude adapter exposed assistant transcript events, while v3 usage
coverage remained unknown even when provider rows recorded request usage. Claude
may repeat the same `message.id` and usage object across response fragments;
all-zero usage rows also occur in the frozen transcript.

## Decision

The [Claude adapter](../../../v3/crates/core/src/providers/claude_code.rs)
projects request usage from the same captured transcript bytes as its event
stream. `message.id` is the canonical response identity and deduplicates
fragments. When that ID is absent, consecutive usage-bearing assistant records
with identical normalized token components are collapsed; a non-assistant row
ends that fallback evidence. All-zero rows without a nonzero explicit total
are treated as pending and omitted.

Input, cache-read, cache-write, non-reasoning output and recorded reasoning stay
separate. `total` is retained only when the source explicitly records a value
that matches those components; a missing or inconsistent total stays null.
Usage provenance uses the raw `uuid`/`id`, then a recorded response ID, and
only derives a row identity when both are absent. An event anchor is emitted
only when that exact event has the same source identity; otherwise it is null.
Usage coverage is observed when an assistant usage object parses, even when
its only rows are pending placeholders.

## Alternatives considered

Summing every assistant row would double count repeated response fragments.
Deduplicating equal token vectors across unrelated rows could merge distinct
requests; the legacy fallback therefore stops at every non-assistant record.
Replacing a missing or inconsistent explicit total with a component sum would
hide what the provider actually recorded.

## Consequences

Claude v3 exposes source-backed request usage with canonical session ownership,
separate cache/reasoning fields, and a validated source event anchor when one
exists. Usage aggregation and daily billing statistics remain separate work.
The earlier [protocol foundation decision](2026-09-27-v3-claude-protocol-foundation.md)
records that usage was initially unported.

## Verification

- The HTTP test was first run against the existing debug binary and failed
  because the API returned an empty `usageRecords` array for the public v259
  fixture. Its pinned source SHA-256 is
  `6d1beea9dc7eac022ff3aa50324ad8cd2251ec4230261496d70ffb4ba54d385e`.
- `cargo build --manifest-path v3/Cargo.toml -p agentsession-v3` passed.
- `node --test v3/test/claude-protocol-foundation-http.test.mjs
  v3/test/claude-rust-slice.test.mjs` passed 12 tests; one separately gated
  private manifest test was skipped. The frozen 26-row Claude source retained
  its SHA-256 `ee5e4cca0777b45ef7e97306139ad53022233a95e364ca314734890d14190734`;
  raw rows show one response ID repeated twice and three all-zero placeholders,
  matching one published request record.
- `cargo test --manifest-path v3/Cargo.toml -p agentsession-core --locked
  --offline` passed 100 tests; 11 manifest-gated tests were ignored.
