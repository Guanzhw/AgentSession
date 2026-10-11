---
status: implemented
date: 2026-10-11
decision: Reuse captured exact revisions for recorded Codex catalog publication
---

## Context

A frozen 917,848,369-byte recorded Codex parent required six complete reads for
cold or changed catalog publication. Exact unchanged index and Reader reuse
already existed. The user requested measured incremental-read and index-reuse
improvements, retaining only clear benefits.

## Decision

For native-authority-selected plain JSONL, bind the parser's verified file
revision to the incoming catalog signature, including recorded authority,
candidate membership and the same native-title read used for the summary.
Compare before publication, then retain the mandatory final complete inventory
validation. Four complete reads replace six. Default adapters, compressed
sources and direct pairs retain their original post-capture check.

The internal recorded catalog signature uses a v2 digest composition so the
parser's existing scoped hash can establish the capture witness without another
file read or a second simultaneous SHA. Existing affected catalog entries
rebuild once. Public session identity, API revisions and Reader caches retain
their existing semantics.

## Alternatives considered

A negative Reader stat hint skipped a redundant initial exact probe but required
persisted nullable hints and a cache migration. Three paired trials showed only
5.4% cold and 9.0% append gains; remove the candidate and its migration.
Larger Reader content chunks reduced physical rows but one adjacent control
pair showed only about 6% gains; remove that candidate too.

Suffix-only hashing misses modified prefix bytes. Resuming normalization requires
pre-finalization tool pairing, deduplication, compaction and ownership state;
final normalized rows cannot reconstruct it. This change preserves full parsing.

## Consequences

Exact captured bytes must match incoming evidence, even when a source changes
from A to B during capture and returns to A before final validation. Capture's
scoped hash is bound before child revision decoration. Catalog and search rows
still publish atomically. The internal capture hook requires final inventory
validation before publication. Provider records remain read-only.

## Verification

The restoration regression failed before the witness fix and passed afterward,
with and without native titles. Focused tests cover exact read counts, unchanged
normalization reuse, same-size/same-mtime rewriting and authority changes.
Independent review closed the capture-generation finding.

Three alternating paired trials exceeded the predeclared 15% cold-path gate:
catalog cold median 5,774 to 4,713 ms; append refresh 7,339 to 6,131 ms. Warm
median remained about 581 ms. Complete public output, TOC, normalized content
and search digests matched; only the documented internal catalog signature
changed. See [measurement details](../../../docs/design/performance-incremental-20261011.md).
Final-artifact ablation, full affected checks and live validation are recorded
there separately.
