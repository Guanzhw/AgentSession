---
status: implemented
date: 2026-09-29
decision: Merge an explicitly anchored two-file direct root Codex history prefix while preserving excluded source records as evidence.
---

# Codex direct history-base source set

## Context

The [seam audit](../../../docs/design/agentsession-v3-codex-usage-seam.md)
establishes a direct prefix boundary for one same-ID pair: 1,296 earlier
records precede the later segment; eight remaining earlier records form an
aborted turn and contain no usage. Its 147 earlier and 59 later canonical
response IDs are disjoint. The other audited groups either inherit an
unresolved ancestor prefix or have no history anchor.

## Decision

This narrowly supersedes the blanket collision behavior in the
[multiple-source decision](2026-09-29-v3-codex-multiple-source-diagnostic.md).
The provider-private [source-set module](../../../v3/crates/core/src/providers/codex_source_set.rs)
recognizes exactly two plain JSONL root sources with matching canonical IDs,
a direct same-thread `history_base`, exact byte/record-count agreement, complete
records, a usage-free aborted suffix, and consistent compaction links where
both sources record them. An earlier inherited base or parent/fork/subagent
identity remains unsupported. No filename, timestamp, payload equality, or
embedded snapshot identity supplies a missing anchor.

Reader, index/search, prompts, protocol, and Stats consume the declared prefix
plus the later segment through one stateful normalization pass. Excluded suffix
records remain protocol events with explicit exclusion diagnostics, original
record vocabulary, timestamps, and file/line/byte provenance; they produce no
Reader, task, run, relationship, execution, or usage facts. Event identity uses
a source-path digest and local line, while technical provenance resolves the
actual file and exact bytes. Bounded list/search/provider diagnostics expose
only codes and counts. Source-read failures remain distinct from unsupported
merges and do not expose paths in provider status.

Revisions cover both complete files, paths, prefix boundaries, source scope,
the parser version, and child dependencies. Stats source revision advances to
v9. Complete projections and Reader stamps recheck source-set membership and
the unknown-identity gate immediately before return, so a third member added
during normalization cannot publish a stitched snapshot. Targeted reads do
not parse unrelated multi-file root groups as potential children. Request
ownership and response-ID conflict rules stay unchanged; anonymous
legacy occurrences remain separate observations. A token-count record without
a usage payload remains a source event with an unavailable-payload diagnostic.
Unmerged groups continue to use explicit unavailable content; independent
[partial Stats coverage](2026-09-29-v3-stats-partial-source-coverage.md) allows
healthy sessions to contribute without claiming complete provider totals.

## Alternatives considered

Whole-file append includes the aborted turn outside the declared history.
Selecting the later file loses 147 proved requests. Parsing each file into
independent snapshots and concatenating those snapshots would lose cross-seam
state and source-qualified references. General ancestry resolution has no
complete selected-source witness in this slice.

## Consequences

One proved source shape becomes readable with its canonical identity. Other
groups and unreadable identities preserve their established diagnostics.
The two selected source files are read and validated at the provider boundary;
this bounded implementation does not establish corpus-wide request gold or
performance acceptance. Technical source positions are available only through
explicit protocol evidence, not catalog diagnostics.

## Verification

The public adapter fixture first failed with the existing multiple-source
diagnostic, then passed after implementation. Tests cover selected history,
request union, excluded evidence, source/Reader/protocol/Stats revision
agreement, suffix rewrites, invalid byte/ordinal/owner anchors, inherited
ancestry, third members, excluded usage, and unreadable identity.
`cargo test --manifest-path v3/Cargo.toml -p agentsession-core` passed 168 tests
with 14 intentional private-source skips. An explicitly selected retained
two-file witness passed: 206 exact canonical response IDs, 214 numeric legacy
observations, one raw legacy record with null usage information, and eight
excluded evidence events. Both input SHA-256 values remained unchanged
(`22df7d750f193647a7f21cdbe3e736c5cc9f1b892b5d598af3db27c9d13cf33a`
and `514b8a4405e9cf1848d878242caf864ca2d64425369240ead9b3a30f2389cb4f`).
An independent review exposed a membership race; a deterministic test first
failed, then passed with final-boundary checks for protocol bundle/stream,
observations, Reader capture/revision, parent facts, and unknown source identity.
The [HTTP/MCP test](../../../v3/test/codex-source-set.test.mjs) runs the public
fixture and an opt-in retained private witness through isolated Web and stdio
processes. With `AGENTSESSION_CODEX_SOURCE_SET_WITNESS_DIR` pointing at the
retained two-file copies, `node --test v3/test/codex-source-set.test.mjs`
passed 2/2 (0 skipped) on debug binary SHA-256
`07086b9ab94f54a7caf421a02edd5028eac65e5335ef01c15e47b5f470be23ee`.
The private transport witness completed in 52.38 seconds; all source hashes
were unchanged. UI build, app build, `npm run review`, and the scoped
`git diff --check` passed. Full corpus, whole Node suite, browser review, and
release packaging remain main-agent validation, not evidence from this slice.
