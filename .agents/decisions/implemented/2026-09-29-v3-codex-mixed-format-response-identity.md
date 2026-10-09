---
status: implemented
date: 2026-09-29
decision: Suppress Codex mixed-format usage only when an explicitly recorded owner, response identity, and complete request/cumulative evidence prove a replay; stop inference after an unexplained cumulative drop.
---

# Codex mixed-format replay identity and boundaries

## Context

Some Codex JSONL sources record the same usage through canonical
`token_usage_record` and legacy `event_msg/token_count` records. A read-only
audit of selected mixed-format sources proved 294 duplicate or context rows,
totaling 36,761,347 tokens, including 271 canonical mirrors and 23 compact
context snapshots. The report also found cumulative sequences where the prior
baseline could not be established, so equal vectors alone cannot justify
removing later rows. Public evidence is retained at
`tmp/v3-delivery/mixed-legacy-audit.public.md` and
`tmp/v3-delivery/mixed-legacy-audit.public.json`.

Final-source review also found a no-metadata boundary: two absent owner values
are both `None`, but that equality does not establish shared ownership and
cannot authorize suppressing a legacy row.

## Decision

The Codex usage projector scopes evidence to an explicitly recorded metadata
owner. A canonical owner must match the recorded `session_meta` owner; absent
owner values remain unknown, and `None == None` is not proof that two rows share
an owner. It recognizes a mixed-format replay only from complete six-component
request and cumulative records connected by an exact additive chain, with the
canonical response identity preserved through any already-proven legacy
replay. A different explicit response cannot inherit an anonymous mirror's
offset.

A compact context snapshot is not a request when the source has an explicit
compaction marker, the owner matches, the complete cumulative vector is
unchanged from the preceding legacy usage, and the request vector has five zero
components with only the recorded total positive. After an unexplained
cumulative decrease, the projector stops deriving replay relationships and
preserves later rows unless independent recorded evidence establishes a new
baseline.

The Stats source revision advances from v3 to v7 and the stored catalog summary
schema from 6 to 10. Both changes invalidate derived values produced by earlier
rules. The implementation and regression cases are in the
[Codex adapter](../../../v3/crates/core/src/providers/codex.rs); the summary
version is owned by [index storage](../../../v3/crates/core/src/index.rs).

## Alternatives considered

Matching request vectors without owner, response, and cumulative proof could
merge distinct responses. Treating two absent owners as equal could suppress
usage without an ownership fact. Carrying a constant offset across an
unexplained drop would invent a missing baseline. Counting a marked compact
snapshot as a request would add context cost to request totals.

## Consequences

Only rows supported by the complete evidence chain are suppressed; unresolved
rows remain visible to Stats. The selected-source audit is a bounded proof of
the measured removals, not a full-corpus unique-request gold total. Provider
JSONL remains read-only.

## Verification

The selected-source mapping and replay evidence are in ignored reports
`tmp/v3-delivery/mixed-legacy-audit.public.md` and
`tmp/v3-delivery/756-b386-cache-delta.public.json`. The Codex adapter tests
include `mixed_explicit_response_after_anonymous_mirror_breaks_transition_offset`
and `mixed_transition_without_any_recorded_owner_keeps_legacy_usage`; the latter
was RED before the no-metadata owner check and GREEN afterward. The currently
tested, supersedable `68f60ac2` package has Stats source salt v7 and catalog
summary schema 10. Its exact packaged binary produced four identical fresh
30-day Stats responses (SHA-256
`325bd09f4896884fc1b6f5943e0b38b0b69fa0f445f07a88aeceed348bf87127`). Against
the older 756 cache, all 837 per-session rows match the independent comparison:
294 rows and 36,761,347 tokens were removed exactly, with no additional changes.
The full workspace passed 177 core tests and 2 app tests (14 ignored), including
12/12 mixed-usage tests. Evidence is in
`tmp/v3-delivery/stats-fresh-68f60ac2/results.public.json` and
`tmp/v3-delivery/mixed-legacy-postfix-68f60ac2.private.json`.

The same candidate's full serial Windows Node run passed 346/369 tests with no
failures and 23 skips; the Linux package passed its locked/offline and unpacked
checks, 177 core plus 2 app tests (14 ignored), standalone 3/3, Reader 5/5,
native MCP 6/6, and DSH team 3/3. Its five-round native MCP search matched all
45/45 ordered source-golden results with 840 Codex source hashes unchanged.
These results and the exact artifact digests are tracked in the
[delivery plan](../../../docs/design/agentsession-v3-delivery-plan.md). The real
three-level Reader trace exposed a 26-second warm restoration and placement
lookup is under diagnosis; this candidate may be superseded after that fix, and
the related WEB-04/08 coverage remains open. Overall 3.0 delivery acceptance is
not complete.
