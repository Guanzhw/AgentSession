# Remaining Codex same-ID source pairs

The two remaining ledger-selected pairs do not establish a general same-ID
merge rule. One records a local prefix continuation whose ordinal includes an
inherited ancestor prefix. The other has chronological order but no recorded
cross-file history link. This extends the
[first two-segment audit](agentsession-v3-codex-usage-seam.md); it does not change
the production selector or the existing request dispositions.

Four frozen-manifest source files totaling 48,710,590 bytes were read and checked
against their manifest SHA-256 values. Byte-identical private copies and detailed
evidence remain under ignored
`tmp/v3-delivery/codex-usage-witness-packs/seam-other/`.
The [public result](agentsession-v3-codex-other-usage-seams.public.json) contains
only redacted counts, relations, and digests. No other provider transcripts or
services were accessed.

## Pair with an inherited prefix

The files contain 13 and 718 complete records. Their first canonical metadata
IDs match, header source timestamps increase, and all earlier envelope times
precede the later file by a 7,588 millisecond gap. The later `history_base`
names the earlier canonical session and its byte cutoff exactly matches the
start of local record four. Three local records are included.

The later global ordinal equals the earlier header's inherited base ordinal
plus those three local records. Comparing the later ordinal directly with the
earlier file's local record count would therefore be wrong. The earlier base
names the recorded fork ancestor, outside these selected files. Its contents
were not read, so complete ancestor-lineage resolution remains open.

The ten earlier records outside the local prefix begin with `task_started`
and end with `turn_aborted`; they contain no usage. Neither file has canonical
usage. The later file contains 100 legacy usage occurrences without explicit
response identity, whose occurrence-to-request mapping remains unresolved.
Neither file has a compaction window. The explicit header and byte/ordinal
agreement support the local prefix link without relying on window evidence.

## Pair without a history anchor

The files contain 12 and 14,921 complete records. Their first canonical IDs
match, header source timestamps increase, and all earlier envelope timestamps
precede the later file by 1,753 milliseconds. Neither header has `history_base`.
The earlier file has no compaction window; the later has twelve, so there is
no earlier recorded window available for a cross-file link.

The earlier file contains no usage. The later file has 1,839 distinct canonical
response IDs, all with explicit thread owner equal to the shared canonical ID,
and 1,965 legacy usage occurrences without explicit response IDs. These facts
show no omitted canonical usage in the earlier file; they do not establish a
history prefix or prove that the earlier conversation may be discarded.
Prefix extent and excluded earlier records remain unknown.

## Overlap, integrity, and merge implications

Both pairs have zero cross-file intersections in top-level message IDs, tool
call IDs, canonical response IDs, and exact complete-record hashes. All four
files have valid UTF-8 JSON records, terminate with a newline, and have no
missing/invalid envelope timestamps or timestamp reversals. Distinct IDs and
chronological order do not supply the missing continuation link.

Across the three audited same-ID groups, the observed shapes are:

| Shape | Evidence | Supported conclusion |
|:---|:---|:---|
| Direct prefix | Matching history-base byte boundary and local ordinal; linked compaction windows | A recorded prefix followed by the later segment; retain excluded aborted-turn evidence. |
| Inherited prefix | Matching byte boundary; ordinal equals inherited ancestor count plus local prefix | Local continuation is supported; full ancestor history remains unresolved. |
| No anchor | Same canonical ID and ordered, disjoint recorded events | Continuation extent remains unresolved. |

Whole-file concatenation is not justified for any pair by this audit. A future
provider-owned source-set design can recognize explicit prefix evidence, while
preserving unknown cases as diagnostics. It must retain source-qualified record
identity, inherited ordinal offsets, and the excluded aborted-turn evidence.
No merge or deduplication was performed.

The private runner is
`tmp/v3-delivery/codex-usage-witness-packs/seam-other-groups.mjs`; detailed results
are `fork-prefix.private.json` and `unanchored-same-id.private.json` in the private
directory. `summary-v2.public.json` explicitly uses null for unavailable prefix
boundaries. The initial summary and all copied sources are retained.
