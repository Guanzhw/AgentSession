---
status: implemented
date: 2026-09-27
decision: DSH v3 seeded sessions expose copied history as inherited context and count only owned records in child history
---

## Context

DeepSeek Harness v3 can store a copied prefix in a seeded child before its
`session/end-seed` marker. The 2.0 parser treats the last inherited marker's
sequence as the child ownership boundary. The initial 3.0 slice rejected these
sources, so a recorded child could disappear from the catalog.

## Decision

In the [DSH adapter](../../../v3/crates/core/src/providers/deepseek_harness.rs),
validate `isSeeded` against a recorded inherited end-seed marker. Preserve
pre-boundary Reader records in the inherited-context projection with the
recorded parent reference when present; report a null source session when the
prefix has no recorded parent ID. Build child Reader, search, timeline,
relations and request usage from records at or after that boundary. A tool
result recorded after the boundary belongs to child history even when its call
ID identifies a tool call in the copied prefix.

## Alternatives considered

Counting the copied prefix in the child would duplicate message and token
ownership. Rejecting seeded v3 would omit a current provider source shape.
Inferring the prefix from `parentSession` alone would treat an identity field
as content evidence.

## Consequences

The child can show inherited context separately while its own counts, ToC,
search and MCP history stay scoped to owned records. Reader discovery uses a
bounded inherited page request; an explicit no-prefix response omits the
disclosure, while source errors remain visible. This implements the v3 seeded
boundary only; historical DSH generations and broader context behavior remain
separate acceptance work.

## Verification

The [public seeded test](../../../v3/test/dsh-rust-slice.test.mjs) first failed
against the prior debug binary with HTTP 500 and `seeded DSH v3 source is
unsupported in this slice`. An isolated-target build passed that test 1/1,
the DSH slice 4/4, and nine Rust DSH unit tests (two private cases ignored).
The synthetic source hash remained unchanged; `npm run review` and rustfmt
check passed. Shared release and cross-platform binaries still require a
post-integration rebuild and replay.

The 2026-09-27 ownership review added public cases for a post-seed result that
uses an inherited call ID and a seeded prefix without parent identity. Against
the existing shared debug binary SHA-256
`D56096BC2B8C39B06DE892324B7619CDDE1B5766029370856584BED43760D86B`, both
failed as expected: the child count omitted its result (2 instead of 3), and
the parentless prefix endpoint returned 503. The fix passed
`node --test v3/test/dsh-rust-slice.test.mjs` 5/5 on isolated debug binary
SHA-256 `B0E086439E8E6B7BC7F43B879C5E6DC02F48F7A4C13CBA1C04A7E46D51CBF4C0`;
the Rust DSH suite passed 10 tests with two private-corpus tests ignored, and
the real Reader browser test passed 1/1. Public and synthetic DSH source hash
guards remained unchanged. `npm run typecheck`, Svelte build, and focused DSH
rustfmt passed. `npm run review` stopped at governance because the concurrent
`2026-09-27-v3-reader-process-disclosure.md` record lacked required sections;
the shared debug/release binaries were not built by this review.
