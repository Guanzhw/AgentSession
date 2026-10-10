---
status: implemented
date: 2026-10-11
decision: Let full Reader outline hydration request bounded batches without changing source ordering or freshness semantics.
---

# Bounded Reader outline batches

## Context

The live long Codex Reader contained 29,145 source entries. Its complete outline
required 455 continuation requests and 12,920,872 JSON bytes at the existing
64-entry page size. The user wants the complete directory available automatically
and asks for page and MCP performance improvements.

## Decision

Allow optional `limit` on Reader TOC HTTP requests: 64 through 512, in multiples
of 64. Keep 64 as the default and for bootstrap and source-target lookup.
Only automatic full-outline hydration requests 512. Bound SQLite construction
as well as the returned page, and retain all source entries, ordinals, canonical
references, revision checks and cursor alignment.

## Alternatives considered

- Load the directory only when scrolling: repeats the interaction the user
  explicitly asked to remove.
- Omit tools or thinking from the transport: existing contiguous source ordinals
  distinguish partial-page gaps when grouping outline turns; omission changes
  that contract.
- Return the whole directory in one response: removes the construction bound.

## Consequences

Large outlines need fewer network round trips and frontend merge/recompute
cycles. Their complete JSON facts are retained; total source payload is not
claimed to shrink. Existing callers keep the same default page size.

MCP timeline and context construction can separately project only the requested
page/window. Their output contracts and provider freshness checks stay unchanged.

## Verification

- `npm run build` and `npm run review` passed.
- `npm test`: 241 Rust cases passed (15 ignored); 714 Node/Web/MCP cases passed,
  zero failed, 46 conditional cases skipped.
- `node --test v3/test/bounded-reader.test.mjs`: 3/3 passed. The 1,300-event
  source has exact default/batched full-walk equality; limits, scope, revision,
  alignment, source hash, terminal target and empty-source checks passed.
- Related browser and UI gates: 27/27 passed, including complete outline,
  folding, target navigation during delayed hydration, inline children and
  compaction content retry/pagination.
- MCP frozen-source complete pagination: all 16,503 events and 1,500 tool
  summaries match the baseline's structured results exactly; source hashes
  remain unchanged. Focused MCP tests passed 18 cases with one private-manifest
  case skipped. Genuine-source retrieval also matched the baseline.
- Measurement scope and remaining source-loading cost are recorded in
  [the performance pass](../../../docs/design/performance-pass-20261011.md).
