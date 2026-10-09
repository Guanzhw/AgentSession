---
status: implemented
date: 2026-10-09
decision: Discover Codex transcripts only inside the configured home's sessions and archived_sessions roots, preserving canonical identity checks and the global malformed-transcript diagnostic.
---

# Codex transcript discovery roots

## Context

Real default-root validation of the consolidated native Viewer returned
`codex_source_inventory_incomplete` with 139 unresolved files and HTTP 503
for a known Codex Reader. The adapter recursively scanned the entire Codex
home, including unrelated JSONL files. A read-only metadata scan reproduced
the count: 136 visualization files, one plugin fixture, the session index,
and an empty transcription-history file. No directory or file read failed.
Five additional header-valid transcript copies existed under visualizations.
The provider-owned roots contained 1,418 active and 21 archived transcripts.

## Decision

The owning discovery boundary in
[`codex.rs`](../../../v3/crates/core/src/providers/codex.rs) enumerates only
`sessions` and `archived_sessions` beneath the configured Codex home. Missing
optional roots are allowed; read failures and existing roots of the wrong
type remain explicit. Either transcript root establishes provider availability.
The configured home remains unchanged for provider-owned memory and other
recorded metadata lookup. Compression preference, canonical IDs, source-set
merging, and the unknown-header gate remain in their existing owners.

Test fixtures that previously placed transcript files directly in temporary
homes now use the actual `sessions` layout. Discovery does not add a flat-root
fallback to accommodate those synthetic fixtures.

## Alternatives considered

Weakening the global unknown-header gate would conceal malformed real
transcripts and weaken the existing source-set identity contract. Selecting
the `sessions` directory as the Codex home would omit archived records and
misplace memory lookup. Filtering individual artifact filenames would keep
the broader discovery error and require rules for unrelated home content.

## Consequences

Unrelated home JSONL files and visualization transcript copies cannot poison
the session inventory or create false source collisions. Actual malformed
transcripts still report the explicit incomplete-inventory diagnostic and
block history until their canonical identity is resolved. Provider files are
read-only throughout this change.

## Verification

The new transcript-root regression failed against the old whole-home walk.
With the corrected discovery boundary it verifies active and archived reads,
exclusion of header-valid visualization copies and non-transcript JSONL,
unchanged source bytes, and the global diagnostic for a malformed archived
transcript. A separate regression checks archived-only availability.

`cargo test --manifest-path v3/Cargo.toml -p agentsession-core --locked`
passed 199 tests with 14 explicitly ignored private-source/probe tests after
both regressions and fixture layout updates. Rust formatting was applied.
The fresh native HTTP/MCP/browser validation is reported by the task handoff.
