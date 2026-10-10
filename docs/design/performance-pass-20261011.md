# Reader and MCP performance pass, 2026-10-11

## Scope and changes

Baseline source: `21d5e06a4d51887775b78d2ef53403cfd1542338`.
Measurements use local Windows release executables, read-only actual provider
data, and frozen task-owned source copies. They do not establish performance on
other hosts or providers.

- Complete Reader outline hydration requests bounded 512-entry batches. The
  default, bootstrap and exact-target pages remain 64. Source entries, ordering,
  canonical references and generation checks remain intact.
- Reader scroll and target expansion reuse event and turn indices. Collaboration
  geometry reuses a card index and exits before reading layout when no handoffs
  exist.
- MCP timeline projects only the requested filtered page; context projects only
  the selected visible window. Source loading and freshness validation remain
  unchanged.
- Removed the Codex header cache whose sole caller always forced rereading.
  Canonical-ID discovery still rereads headers, including same-stat rewrites.
- Reader content continuation counts UTF-16 units incrementally rather than
  rescanning all accumulated chunks.

## Correctness and result size

The frozen MCP corpus contains 14,015,495 bytes and 16,503 events, including
1,500 tools. Baseline and candidate complete pagination have identical ordered
structured results: previews, tool names and unknown statuses, canonical event
references, revisions, cursors and terminal empty-page behavior. The source
SHA-256 is unchanged. A separate genuine 168,074-byte original Codex source copy
also produces matching results for seven retrieval calls, including a positive
search derived from an actual owned user message. This small original-source
sample excludes the active long Reader's selected alternate and child sessions.

MCP responses retain one short text summary (at most 200 characters in the
output-contract tests) and one structured result. They do not duplicate the full
JSON in the text content. Timeline and context return bounded summaries; callers
use event retrieval for full content, with continuation and truncation exposed.
Missing tool status stays `unknown`; missing facts are not converted to zero.
Public output fields and default page limits are unchanged.

## Measurements

The baseline live Reader had 29,145 source entries. Its complete outline required
455 continuation requests and 12,920,872 JSON bytes. Three live bootstraps took
10.18, 8.92 and 8.86 seconds, with different revisions because the source was
being appended. These are observed opening times, not a frozen paired benchmark.

The final native service captured 29,221 entries in one Reader generation.
Complete 64-entry and 512-entry walks matched every entry and the same complete
JSON digest. Continuation requests fell from 456 to 57 (87.5%); sequential API
walk time was 1.654 versus 0.597 seconds. Response bytes were 12,953,985 versus
12,419,224; the small byte reduction is page-envelope overhead, with all source
facts retained. This comparison isolates page size in the same captured
generation; it is one local traversal, not an end-to-end opening benchmark.
That generation's bootstrap still took 10.02 seconds.

The actual embedded browser loaded the complete outline automatically with
57 requests using `limit=512`, 3,458 rendered links, no outline error and
`aria-busy=false`. Its bootstrap took 10.46 seconds. The complete transport
includes non-outline source records used by ordering/grouping; displayed link
count therefore differs from raw source entry count.

On a frozen copy of that complete outline, 100 final-turn expansion lookups
(median of seven trials) took 131.60 ms using repeated grouping and 0.0166 ms
using the turn index; building the index took 1.04 ms. Exact groups, keys and
expansion targets matched. This isolates lookup work and excludes browser paint,
network and DOM layout.

The initial full MCP candidate walk ran alongside builds/browser checks. Its
79.92 seconds versus the baseline's 72.75 seconds are retained as exploratory
observations, not evidence of a speedup or regression under matched conditions.

After the full regression suite ended, five alternating baseline/candidate
pairs used the same frozen 14 MB source, with no other task-owned heavy build
or browser workload. The 120 bounded calls matched structured gold exactly.
The measured candidate SHA-256 was
`417c145860d561ac7a802cf1c0497044b6b772d8b355df138bdbe6aa9c62ef8b`;
baseline was
`19dfcaa3d4edc37fc9f41333620525fcaf53b943ec0eb895f27cf8afef930f70`.

| Call | Baseline warm median | Candidate warm median | Reduction | Response bytes |
|:---|---:|---:|---:|---:|
| Timeline, 10 rows | 162.23 ms | 140.98 ms | 13.1% | 5,120 |
| Timeline, 50 rows | 161.38 ms | 143.49 ms | 11.1% | 26,760 |
| Query timeline, 10 rows | 205.67 ms | 145.09 ms | 29.5% | 5,198 |
| Context, 5 rows | 160.42 ms | 144.06 ms | 10.2% | 2,851 |

Candidate per-pair medians improved in all five pairs. Read-only Windows
process snapshots verified the actual child PID and executable. CPU time for
12 bounded calls per process fell from a median 2.016 to 1.688 seconds (16.3%).
Median peak working set was effectively unchanged, 101.64 versus 101.22 MiB.
The output byte counts are identical. A 50-row timeline is still about 27 KB;
callers needing a narrow answer can select filters/a smaller limit or retrieve
a specific context window and expand exact event content as needed.

## Remaining cost

The active long Reader source is approximately 889 MB. Opening still captures,
checks and normalizes source evidence when its generation changes. MCP retrieval
also retains complete provider loading and normalization. This pass reduces
projection, directory round trips and repeated UI work; it does not remove that
source-read cost or weaken freshness checks.

One final native Reader generation reached a 627.57 MiB peak working set and
returned to 19.89 MiB at the subsequent process snapshot. This is a measured
remaining source-loading cost, with no paired baseline memory comparison.

The next source-loading optimization needs a measured consumer and an explicit
correctness contract for query text, tool state, same-stat rewrites and active
append capture. Reusing a partial Reader projection as an MCP snapshot would
lose facts currently required by the MCP contract.

## Validation

Candidate native build and governance/type/format review pass. Independent source
review found no actionable contract or ordering issues. Bounded Reader HTTP tests
pass all three cases; the 1,300-event case compares complete default and batched
walks and checks invalid limits, cursor identity, stale generation, source hash,
target navigation and empty source. Focused MCP checks pass 18 cases, with one
private-manifest-dependent case skipped; public long-body and tool-payload
oracles pass under both supported protocol eras.

`npm test` completed on native release SHA-256
`3d01a7f1b0fd5b596a3d89665dee26fda60e5f3764a4c06f94db131b06230407`:
Rust passed 241 cases (15 ignored); Node/Web/MCP passed 714 cases, zero failures
and 46 conditional skips. The focused browser/UI gate passed 27/27 with zero
skips on measured candidate
`417c145860d561ac7a802cf1c0497044b6b772d8b355df138bdbe6aa9c62ef8b`.
The subsequent binary rebuild followed a test-only caller signature correction;
the embedded UI asset fingerprint remained unchanged.

The final service also passed a real embedded-browser check on the active long
Reader: complete automatic outline hydration finished, collapse-all left zero
expanded turns, expand-all opened all 94 turns, and collapsing again left no
outline error. The context checkpoint card remained present.

An initial browser check reproduced an automation click landing on the error
paragraph after automatic scrolling instead of the content Retry button. The
keyboard-demand test now focuses the button and presses Enter; its transient
error, pinned offset and full-body assertions remain intact and pass.
