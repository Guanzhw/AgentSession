---
status: implemented
date: 2026-09-28
decision: Treat a repeated complete Codex legacy request and cumulative snapshot as one request within a recorded metadata owner, even when non-usage records intervene.
---

# Complete Codex legacy usage replays

## Context

The earlier [paired mirror decision](2026-09-28-v3-codex-paired-usage-mirrors.md)
removed legacy rows that repeat an identified canonical response, but its
remaining legacy-only replay rule required adjacent raw lines and compared only
the request vector. An independent read-only census selected two legacy-only
roots with exactly repeated six-field request and cumulative snapshots separated
by five and six non-usage lines, including `task_complete` and `task_started`.
Counting both observations gives 195,877 and 343,280 tokens; excluding one
replay gives 180,035 and 326,783, equal to each file's final cumulative total.

## Decision

The Codex provider compares consecutive owned legacy usage observations within
the same `session_meta` owner. It suppresses the later observation only when
both complete six-field request and cumulative vectors match. Intervening
non-usage records and turn markers do not change that comparison. A changed
cumulative vector, incomplete fields, different explicit response IDs, an
owned child boundary, or a changed metadata owner keeps the request distinct.
Repeated metadata for the same owner preserves the comparison. Canonical/legacy
mirror matching is also scoped to that owner. No separate cumulative
reset event was established in the selected evidence; a changed cumulative
vector remains distinct.

## Alternatives considered

Removing the raw-line adjacency check from the old request-only rule would
merge distinct requests with equal token counts. Treating a new turn as a reset
would retain the observed replays. Applying a global pair set across metadata
owners would discard a new owner's independent request.

## Consequences

The Codex Stats source-revision salt advances from `v1` to `v2`, causing an
unchanged source to recapture the corrected request projection. The derived
catalog summary schema advances from 2 to 3 so persisted `token_count` values
also recapture. Provider source files remain read-only.

## Verification

Public Rust tests in [the Codex adapter](../../../v3/crates/core/src/providers/codex.rs)
went RED on the replay, cumulative, missing-field, and owner-boundary cases
before the implementation and pass after it. The catalog test in
[index.rs](../../../v3/crates/core/src/index.rs) went RED when a version-2
summary was reused for unchanged source and GREEN after the schema bump.
The Rust workspace passes 152 core and 2 app tests; 14 private opt-in cases are
ignored in the ordinary run. A separate read-only opt-in check on the two
frozen roots verifies both catalog and protocol request totals of 180,035 and
326,783, with source SHA-256 unchanged. Full exact-package Web/MCP and
3.4 GB corpus reconciliation remain delivery gates.
