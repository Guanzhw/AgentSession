---
status: implemented
date: 2026-09-28
decision: Exclude a legacy-only Codex context-size snapshot only when an explicit compaction and an unchanged complete cumulative vector prove it is not a request.
---

## Context

An independent read-only audit of 230 frozen legacy-only Codex sessions found 154 post-compaction `token_count` rows whose complete six-field cumulative vector did not advance. The request vector had five zero components and a positive total, and an explicit `compacted` record lay between the preceding usage row and each snapshot. The current 3.0 cache retained 151 of them as requests; three were already outside the selected owned history. The 151 retained rows represent 3,615,593 tokens across all dates, including 23 rows and 679,535 tokens in the measured 30-day window. Source hashes were unchanged. The audit report is in `tmp/v3-delivery/legacy-only-cumulative-audit.public.md`.

## Decision

The Codex adapter carries an explicit compaction marker from the latest complete legacy usage row through intervening non-usage records within the same metadata owner. It excludes the following legacy context-size snapshot only when the request vector has five zero components and a positive total, the complete cumulative vector equals the prior owned legacy cumulative, and the marker lies between those usage rows. Consecutive identical snapshots may use the same proof. An additive, changed, incomplete, or differently owned usage row clears the legacy baseline. Existing canonical compaction accounting remains separate.

Stats usage projection version 5 and stored catalog summary schema version 6 invalidate the older derived counts. Provider-owned source files remain read-only.

## Alternatives considered

Dropping every total-only legacy row would hide possible requests. Requiring compaction to be adjacent to a usage row would miss observed `event_msg`, `response_item`, `world_state`, and `turn_context` records between them. Matching token values without a recorded compaction or complete cumulative equality would invent a duplicate relationship.

## Consequences

Only source-proven context snapshots are removed from request usage. Other legacy rows, including those with unknown initial baselines or incomplete vectors, remain available until source evidence resolves them. Rebuilding derived Stats and catalog state is required once for the new projection versions.

## Verification

The focused Rust regression failed before the provider change and passed afterward. It covers intervening non-usage records, repeated snapshots, additive requests, absent compaction, changed and incomplete cumulative vectors, owner transitions, and owned-history boundaries. Rust workspace tests passed with 165 core and 2 app tests, with 14 conditional tests ignored; `cargo check --workspace`, formatting, and governance review passed. The exact packaged Windows executable was independently compared with the preceding package over all 837 selected sessions: 151 legacy-only and 18 additional mixed-format context snapshots were removed, every removed row has raw-source proof, no row was added or left unclassified, and the three previously excluded child snapshots remained excluded. The 30-day result changed by exactly 41 requests and 1,194,011 tokens to 48,591 requests and 6,218,369,992 known tokens. All 840 frozen source hashes matched before and after. See `tmp/v3-delivery/723f-compaction-delta-audit.public.md`; this validates the correction delta, not every remaining legacy row.
