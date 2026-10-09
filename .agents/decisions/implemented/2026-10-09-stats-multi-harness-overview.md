---
status: implemented
date: 2026-10-09
decision: Compose selected Harness statistics in Rust and default Stats to all registered Harnesses.
---

## Context

The Stats landing page selected the first available provider and rendered known-token bars alone. A source containing requests with unknown token totals appeared empty, and cross-Harness usage required separate pages.

## Decision

`/stats` selects all five registered Harnesses. A single Harness checkbox filter supports multiple selections; `/stats?providers=codex,pi` retains a selection, and legacy `/<provider>/stats` initializes one Harness. `/api/v3/stats/all?providers=codex,pi` composes the existing provider-owned projections with the same date, directory, request-model, scope, day-drill and pricing rules. The same selection is applied to JSON/CSV exports. Empty or unknown selections fail validation; unreadable selected sources remain explicit `sources` rows with no overview rather than contributing fabricated zeros. Project filtering requires one Harness.

Rust owns aggregate counts, complete token dimensions, model buckets and usage insights. Canonical provider/session references remain intact. Recorded requests drive daily activity, Harness share and model distribution; known-token subtotal and unknown totals remain separate. Recent activity compares the final two seven-day windows of complete UTC days inside the selected range. High-activity days mean request counts above twice the selected-range daily mean, including zero-activity days, with at least seven selected days. This describes volume, not errors or personal preference. UI labels disclose the basis and source gaps.

Charts provide the single range-level presentation. Selecting a chart day opens one canonical session drill; cost estimates, source diagnostics and the per-session evidence list share one native Statistics details disclosure. The insights response includes only consumed facts; `selectedDays` describes the padded selected range.

## Alternatives considered

Provider tabs preserve fragmented usage. Summing independently in Svelte would duplicate the statistics ownership boundary and could misrepresent missing totals. Treating unknown tokens as zero would erase recorded request activity.

## Consequences

All-Harness responses add per-source coverage and insights. CSV appends selected-Harness and source-status columns only for aggregate responses; existing single-provider exports retain their columns. Cross-provider complete dimensions remain unknown if any request-bearing source lacks the dimension. A failed source can change comparisons, and the UI states that limitation. Selecting a different Harness set resets provider-specific filters while retaining the date range.

## Verification

The failing `all_harness_stats_preserve_usage_and_unavailable_sources` test recorded RED (`Unavailable("all")`) before implementation. `cargo test -p agentsession-core stats --target-dir target/stats-feedback` passes 32 tests, including mixed known/unknown dimensions, canonical cross-provider same-ID day drill, unavailable sources and bounded request-volume insight windows. The final full core suite passes 197 tests with 14 explicitly ignored. Svelte component compilation reports no warnings.

Current Stats browser cases pass 8/8. The native API, frozen-source and actual download suite passes 23 tests with one explicit opt-in phase-probe skip. Final native pricing verification passes 18 checks, including eight Stats/Settings, language and theme accessibility audits with zero violations. Served assets match the build; provider source hashes stay unchanged. Exact build identities, reused evidence and the disclosure-state limitation are documented in the [Reader and Stats feedback record](../../../docs/design/agentsession-v3-reader-feedback-20261009.md) and `tmp/v3-reader-feedback-20261009/resume/stats/RESULTS.md`.
