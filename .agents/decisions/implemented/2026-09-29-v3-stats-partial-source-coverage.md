---
status: implemented
date: 2026-09-29
decision: Report healthy Stats usage with explicit excluded-session coverage when canonical source rows have unavailable history.
---

# Stats partial source coverage

## Context

The [Codex multiple-source decision](2026-09-29-v3-codex-multiple-source-diagnostic.md)
made provider-wide Stats unavailable when a same-ID source collision was in
scope. Two such groups in a much larger source inventory made the readable
sessions' request statistics inaccessible. A diagnostic catalog row cannot
establish that session's requests, model, date, or message count.

## Decision

Stats returns a partial report for known diagnostic rows. It counts each
excluded canonical session separately, gives a bounded list of diagnostic
codes and affected counts, and aggregates requests, tokens, messages, daily
usage, and model ranking only from readable sessions. The source-level
exclusion count remains under model and date filters because those attributes
are unknown. A recorded directory or project that proves the diagnostic row
outside the selected scope can exclude it from the count; an unknown attribute
cannot. JSON, CSV, and the Web UI use the same report. CSV repeats the
source-level exclusion count on daily rows without assigning exclusions to a
day; when no day exists, CSV has one undated coverage row. An unreadable source
with no established canonical ID still makes Codex
Stats unavailable globally because it could belong to any session.

This replaces only the provider-wide Stats refusal in the linked Codex
decision. Reader, Protocol, and per-session retrieval keep their diagnostic
failure for the affected ID.

## Alternatives considered

Keeping provider-wide refusal hides healthy usage. Treating diagnostic rows
as zero-usage sessions or filtering them by an unproved model or date would
make totals appear complete. Merging source files belongs to a separate
provider-owned evidence decision.

## Consequences

The report's session count means included readable sessions after filters. The excluded-session
count and diagnostic codes make the missing coverage visible. Known token
totals remain subtotals; an exclusion does not turn unknown tokens into zero.
Source paths and fragment usage stay private. A report can contain no readable
sessions and still report exclusions with partial usage coverage.

## Verification

Core regression tests cover healthy usage beside a collision, exclusions
under model/date filters, and a collision with an unknown directory under a
directory filter. HTTP tests cover JSON and CSV exports, directory
scope, reassigned collision identity, and global unavailable behavior for
unknown source identity. The implementation and verification live in
`v3/crates/core/src/stats.rs`, `v3/test/codex-source-selection.test.mjs`, and
`v3/test/stats-slice.test.mjs`.
