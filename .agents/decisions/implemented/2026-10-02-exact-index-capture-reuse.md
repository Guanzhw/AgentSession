---
status: implemented
date: 2026-10-02
decision: Reuse captured catalog summaries and search documents during forced publication only when the owning adapter freshly verifies the same exact capture revision and the inventory signature and stored schemas still match.
---

## Context

Forced reindex captured every incoming source, including unchanged ordinary Codex
JSONLs. The retained 2026-10-02 diagnosis identifies 816 Codex sources among 971
entries and approximately 3.047 GB of Codex bytes. Repeated normalization and two
complete capture reads contributed unnecessary work to forced publication.
Fresh canonical inventory, exact-byte change detection, generation advancement,
and atomic complete publication remain required.

## Decision

[ProviderAdapter](../../../v3/crates/core/src/providers/mod.rs) exposes optional
`index_capture_revision(entry)`: a fresh exact revision equal to
`capture(entry).revision`. [Codex](../../../v3/crates/core/src/providers/codex.rs)
implements it only for ordinary singleton uncompressed `.jsonl` inventory entries,
using the existing capture hash namespace, scope, path, and bytes. Unresolved,
collision, source-set, and compressed entries keep mandatory capture.

[Catalog publication](../../../v3/crates/core/src/index.rs) stores the captured
revision in private `_indexCaptureRevision` JSON. Forced reuse requires equal stat
signature, current summary schema, no search backfill, and fresh exact equality.
Missing historical metadata recaptures. Changed signatures recapture even with
identical bytes because summary timestamps may derive from file metadata.
The exact probe supplies the same byte-verification point as capture's final hash;
retained entries then receive the source-signature check and full inventory
validation. Successful forced publication always advances the generation.
Summary/search facts remain intact for retained entries; captured changes and
deletions publish through the existing transaction.

## Alternatives considered

Stat-only skipping and ordinary non-forced refresh cannot detect same-stat
rewrites or preserve forced generation semantics. Reader revisions include
dependencies outside ordinary index capture, so they are not the equality
contract. A provider-ID branch in catalog code would move provider ownership
into a shared projection. Parser buffering and MCP/Reader caching are separate
changes without evidence in this slice.

## Consequences

Unchanged supported Codex sources require one fresh full hash but no normalization
or search-document rewrite. Historical derived rows require a first recapture.
Other providers and unsupported Codex forms preserve capture behavior. Normal
non-forced refresh is unchanged. Any probe/capture/inventory error preserves the
previous complete catalog and search generation. This establishes deterministic
work avoidance; live timing and the retained ten-second acceptance deadline
require separate source-bound packaging and real Web/MCP measurement.

## Verification

Recorded evidence: `tmp/v3-delivery/exact-capture-reuse-20261002/`, including three
exact source backups/hashes, source diffs, raw command/log/exit files, and report.
The failing capture-count test recorded RED exit 101 (two captures instead of
one after warm catalog and a fresh adapter). Focused GREEN passed 4/4.
`cargo test --offline --locked --workspace` passed 192 core tests and 5 app tests;
14 preexisting private benchmarks remained ignored. Tests used
`CARGO_INCREMENTAL=0`, the existing target directory, and no optional features.
Controls cover retained search documents, same-stat body/header rewrites,
append/shorten/delete, missing capture metadata, old summary/search schemas,
identical bytes with changed metadata, unavailable probes, probe errors, removal,
post-probe signature changes, and final inventory failure. Existing provider
source-set, compression, stream-rewrite, and transaction behavior tests passed.
`npm run review` passed governance and Viewer typechecking. Owned-file rustfmt
checks passed; source diff checks reported no whitespace errors.

Subsequent normal local packaging binds Windows `caffb72b` and Linux `d22c4989`
to the same 73 production/source-asset inputs; the current candidate report is
`tmp/v3-delivery/CURRENT-CANDIDATE-20261002.md`. The unchanged full native C
workload passes initial/append/rewrite/delete source gold and the original
10-second gate on the same normal Windows PE. Complete transitions are
4711.599/4566.222/4340.114 ms, with an independent 64-call raw replay and source,
artifact, protected-state and owned cleanup checks. These are one descriptive
freshness run, not five-pair source-change speed statistics. The independently
reviewed shared run completes its gold but retains a default-metadata physical
protection failure and unknown writer. Neither result changes that gate or
closes whole DEL-01/DEL-03.
