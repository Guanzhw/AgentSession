# Codex same-ID source seam evidence

Implementation follow-up (2026-09-29): the bounded
[direct history-base source-set decision](../../.agents/decisions/implemented/2026-09-29-v3-codex-direct-history-base-source-set.md)
now reads this declared prefix plus the later segment. The excluded eight
records remain source-qualified protocol evidence. The independent audit below
is retained as the evidence for this shape, not a general whole-file merge rule.

The two-file witness has a source-backed order, but straightforward whole-file
concatenation is not established as a safe Reader/history merge. The later
header explicitly declares a strict prefix of the earlier file as its history
base. The earlier file's remaining eight records describe an aborted turn;
they must remain preserved as evidence rather than silently merged into or
discarded from the later segment's declared history.

This is a bounded follow-up to the
[usage witness packs](agentsession-v3-codex-usage-witness-packs.md).
The [public seam result](agentsession-v3-codex-usage-seam.public.json) contains
counts and digests. Only the two retained runtime input copies were read;
their SHA-256 values remained unchanged. No provider files, production code,
services, or full-corpus scan were involved.

## Source order and boundary

The earlier file contains 1,304 complete records and the later file 536. Header
source timestamps increase, every earlier envelope timestamp precedes every
later one, and neither file has an internal timestamp reversal. The complete
record ranges are separated by 6,066 milliseconds; the `event_msg` ranges by
6,325 milliseconds. Exact timestamps remain private.

The later header's `history_base.thread_id` matches the canonical session ID.
Its `end_ordinal_exclusive` is 1,296, and its byte boundary exactly matches the
start of the next complete earlier-file record. This agreement proves the
recorded prefix boundary; ordinal overlap alone is not record identity.
The later compaction also names the earlier file's final compaction window
as its previous window and preserves the first-window ID.

The eight records after the declared base begin with `task_started` and end
with `turn_aborted`. Their turn ID differs from the later segment's first turn.
They contain zero usage occurrences. All 147 earlier canonical requests lie
inside the declared base, so the previously proved 147 + 59 = 206 request-ID
union remains supported even though general history concatenation is unsettled.

## Overlap

| Identity domain | Earlier unique | Later unique | Cross-file intersection |
|:---|---:|---:|---:|
| Top-level message and agent-message IDs | 80 | 35 | 0 |
| Top-level tool call IDs, including results | 133 | 53 | 0 |
| Canonical response IDs | 147 | 59 | 0 |
| All top-level response-item IDs | 471 | 195 | 0 |
| Completed-item IDs | 444 | 179 | 0 |
| Message IDs including compaction snapshots | 88 | 53 | 14 |

The 14 shared message identities are later compaction snapshot references to
earlier top-level messages; 12 also occur in earlier compaction snapshots.
They do not prove duplicate top-level events or additional requests. Call and
canonical response ID intersections remain zero when nested snapshots are
included.

There are zero equal complete raw-record hashes across the files. Ignoring the
envelope reveals three equal payload hashes across twelve later occurrences:
thread settings, world state, and inter-agent communication metadata. These
repeated state payloads are not a deduplication rule. Detailed matching row
locations and field pointers remain private.

Both files end with a newline and contain only complete, valid UTF-8 JSON rows.
No malformed record, torn tail, missing envelope timestamp, or reversed envelope
timestamp was found. The earlier aborted turn is a recorded semantic boundary,
not evidence of file corruption.

## Reproduction and implication

`tmp/v3-delivery/codex-usage-witness-packs/seam-check.mjs` reads only the retained
two-file runtime copies and verifies their hashes. Private exact timestamps,
identity sets, payload intersections, row offsets, and full seam records are in
`tmp/v3-delivery/codex-usage-witness-packs/seam/seam-v2.private.json`.
The original seam result is retained alongside the enriched result.

A future provider-owned merge needs to honor the explicit history-base prefix,
retain the excluded aborted turn with provenance, distinguish embedded snapshots
from top-level events, and keep file-qualified source positions. This evidence
does not authorize payload-based deduplication or a blind full-file append.
