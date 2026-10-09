---
status: implemented
date: 2026-09-28
decision: Exclude a Codex legacy token-count row when its request and cumulative snapshots both match a source-owned canonical response.
---

# Codex paired usage mirrors

## Context

The frozen Codex long-session source has 38 distinct `token_usage_record`
response IDs on 2026-09-25. It also has 50 later `event_msg/token_count` rows
whose `last_token_usage` and `total_token_usage` both exactly match a preceding
canonical row's `usage` and `thread_token_usage`. The prior adjacent replay rule
counted 86 requests in that day's Stats report. The independent raw-source
oracle expects 38. These paired cumulative values prove that the legacy rows
are mirrors; equal request token vectors alone do not prove that two responses
are the same.

## Decision

The [Codex adapter](../../../v3/crates/core/src/providers/codex.rs) now compares
the two six-component snapshots within the source-owned usage span. When a
legacy row matches a canonical response with a recorded response ID, it does
not become another request. This extends the earlier
[request usage decision](2026-09-27-v3-codex-request-usage.md); it does not
change child ownership or count cumulative thread totals as requests. The
adjacent replay check still uses the immediate raw predecessor, except when
that predecessor is itself a proven mirror. This preserves chains of repeated
legacy rows and lets a distinct canonical response with the same request token
vector survive. Response IDs are remembered only after a request is selected.

If the cumulative pair or canonical response ID is missing, the adapter keeps
the existing ownership and adjacent replay rules. It does not deduplicate
arbitrary equal token vectors.

The later [complete legacy replay decision](2026-09-28-v3-codex-complete-legacy-replay.md)
extends the legacy-only case with complete request and cumulative snapshots
across intervening non-usage records. Its owner boundary and cache revision
supersede the adjacent-only mechanism described above.

## Alternatives considered

Keeping only adjacent replay removal preserves the 86-request overcount.
Removing every equal request vector would merge distinct responses that happen
to use the same number of tokens; the paired cumulative source evidence is the
required discriminator.

## Consequences

The persisted Stats usage projection version advances from 2 to 3, so a
process upgrading over an unchanged source recaptures the corrected request
rows instead of reusing a previously cached overcount. A focused cache test
relabels a valid row as version 2 with an empty payload, restarts Core, and
proves a fresh protocol capture restores the original report.

## Verification

The [public protocol tests](../../../v3/test/codex-request-usage-protocol.test.mjs)
first failed on the exact Windows package `2d9f6d33…`: a nonadjacent mirror
case returned fallback legacy IDs and lost a distinct canonical response.
After the first fix, an independent reviewer found that three adjacent legacy
replays selected the first and third; a new test failed 2 versus 1 before the
raw-predecessor repair. The rebuilt debug binary passed both and the focused
Codex/legacy HTTP suite: 11 passed, 1 private opt-in skipped. Rust Codex core
tests passed 48 with 9 ignored. Independent re-review found no remaining
P1/P2 issue in the revised selector.

The frozen [raw statistics oracle](../../../v3/test/stats-slice.test.mjs) was
RED on the `2d9f6d33…` package (86 requests versus 38 canonical IDs) and GREEN
on the rebuilt debug binary for Codex, OpenCode, and DeepSeek Harness (4/4).
The test checked JSON and CSV values, canonical session identity, missing
fields, and unchanged source/DB/WAL hashes. Exact release-package and broader
system revalidation remain separate acceptance steps.
