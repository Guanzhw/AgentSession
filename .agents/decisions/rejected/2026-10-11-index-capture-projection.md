---
status: rejected
date: 2026-10-11
decision: Reject an index-only capture projection without a stable opening latency benefit
---

## Context

The first Library request refreshes the complete source catalog before paging.
Codex capture currently constructs full Reader items and retains tool input and
output until search publication, although the index only consumes summaries,
message bodies, tool names and canonical references. A live approximately 985 MB
recorded rollout took seconds to refresh; an append-related failure omitted its
provider from that response, so this incomplete response is diagnostic evidence,
not a valid speed comparison.

## Decision

Reject the tested separate internal index capture. Its summary, source revision
and searchable documents retained original event identity, role and ordinal;
Codex used its existing full parser and source checks. Exact output was preserved,
but three paired runs did not improve opening latency. The implementation and
its tests were restored to the pre-experiment source.

Retain the independent initial Library request prefetch: it overlaps discovery
and publishes through the existing route-owned lifecycle.

## Alternatives considered

Parser modes, selective JSON decoding, append checkpoints and fewer source
checks have larger semantic scope. Serving an old catalog while refreshing
would require an explicit freshness contract. These are deferred; this candidate
removes work with an identified index consumer without changing those contracts.

## Consequences

The shipped index, Reader, Protocol and MCP contracts remain unchanged. Parsing
and exact source verification remain expensive for long changed transcripts.
Active-source refresh failures retain their explicit diagnostics and are excluded
from successful performance comparisons. Future indexing changes need evidence
that they improve the measured source-reading or parsing cost.

## Verification

The candidate's focused capture oracle passed three tests; a prior full core run
passed 239 tests with 16 explicit ignores. Independent source review found no
implementation findings. The frozen 917,848,369-byte recorded-rollout experiment
preserved the complete Library response, catalog and all 26,224 search rows.
Three alternating pairs measured cold-request medians of 5.686 seconds before
and 6.274 seconds after, while peak working set fell from about 504 to 471 MiB.
That memory saving did not justify retaining the extra projection for this
opening-speed task. See the [opening evidence](../../../docs/design/performance-opening-20261011.md)
for the retained change, exact comparison scope and final checks.
