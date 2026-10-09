---
status: implemented
date: 2026-10-01
decision: Restore native DSH alpha.2 team source semantics at the provider boundary
---

## Context

The retained September 20 native DSH 0.1.6-alpha.2 team witness contains three generation-3 JSONL sessions. The packaged d86 adapter rejects known required delivery-acceptance and subagent-catalog records. After admitting those records, the same source exposes pending tasks without owners and received team-message sources. Pinned producer schema/projection code and the existing fixed2 owning parser establish these shapes; the private byte-preserved source and producer hash ledgers are retained under ignored validation artifacts.

## Decision

Restore these existing source shapes in [the DSH adapter](../../../v3/crates/core/src/providers/deepseek_harness.rs). Keep delivery-acceptance watermarks as protocol source evidence, separate from queued mail and delivery receipts. Map catalog discovery to the established spawn-started child relation with the exact catalog source and selected header parent, retaining Reader child-header verification. Validate version-0 catalog fields, including a producer-valid empty optional one-shot label; continuable labels remain required and nonempty. Represent an absent pending task owner as null and let recorded claim/completion revisions establish later ownership. Validate received team-message identity/content and retain the canonical source event; the established conversation projection excludes this injected mailbox text from human requests.

## Alternatives considered

Skipping unknown required events would hide invalid source data. Rewriting the witness would invalidate the compatibility claim. Adding shared/UI interpretation would duplicate provider semantics. These alternatives were rejected in favor of the owning parser repair.

## Consequences

Canonical event order, timestamps and provenance remain source faithful. Catalog discovery establishes no task completion, terminal run, or present running state. Future unknown required event types still fail explicitly. The supported real witness is dated alpha.2; no latest-alpha claim follows. The DSH revision namespace remains unchanged: failed catalog capture publishes no successful Reader snapshot, and previously successful projections remain unchanged. A repaired process reading the exact old diagnostic meta/index/cache succeeds without a manual reset or reindex.

## Verification

Public synthetic fixtures reproduce the consumed shapes. Focused TDD records the packaged HTTP and Rust failures before repair, including a producer-confirmed empty one-shot label regression. Final focused DSH Rust tests pass (18 passed; 3 pre-existing private-data tests ignored); six focused native HTTP/MCP suites pass (30 tests). The real three-file replay checks all 247 canonical source rows, four member revisions, six task revisions, two catalog children, and two queued bodies against raw bytes: 63 HTTP requests and 64 native seven-tool MCP calls pass, including UTF-16 pagination and final message bodies. Reusing the exact old diagnostic state yields 14 successful HTTP probes. Private native-browser geometry, full short mailbox bodies and canonical child evidence are retained in the final ignored report directory. Release artifact acceptance remains a separate final-package check.
