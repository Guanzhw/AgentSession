---
status: rejected
date: 2026-09-29
decision: Do not promote Codex legacy-only cumulative token snapshots into request usage without recorded request identity or a verified provider contract.
---

# Codex legacy-only request promotion

## Context

The HTTP-01 source audit (`../../../tmp/v3-delivery/http01-codex-token-adjudication.public.md`, local evidence)
found 125 single-file legacy-only Codex roots among 295 shared list IDs.
They have 21,790 legacy `token_count` rows and no explicit per-row owner or
response ID. Their 2.0 list totals sum to 2,834,501,520 tokens; 3.0 leaves
`tokenCount` null. A first arithmetic pass selected 66 files whose complete
usage vectors form from-zero cumulative chains. Their last cumulative values
sum to 378,781,306 tokens. That number is a source-snapshot sum, not a
unique-request total.

Independent review confirmed the 66 source hashes, canonical metadata owners,
and arithmetic. It also found one `token_count` row with `info:null` that the
first script had skipped. Among 17 equal-vector pairs, 11 have intervening
events and five cross a task boundary. Equality or adjacency cannot establish
whether a second snapshot is the same request. A selected file alone also
cannot prove complete source membership for a canonical ID.

## Decision

Reject promotion of additive legacy rows into derived request records and
suppression of equal snapshots as proved replays. Preserve the provider's
existing explicit-owner-and-response request rule, raw usage observations,
unknown `tokenCount`, and partial Stats coverage. Do not enter the 66-file
arithmetic subtotal into request, daily, model, or CSV totals. HTTP-01 and
CORE-14 remain unaccepted.

## Alternatives considered

Copying 2.0 totals would carry known mixed-format mirror overcounts. Treating
every complete legacy row as a request would count repeated cumulative
snapshots. Treating equal vectors as replay would discard possible distinct
requests without identity evidence. A separately named cumulative source
snapshot may later expose recorded cumulative values, source revision/anchor,
and derived selection provenance if a concrete consumer requires it; that
would be a distinct public contract and would not change request totals.

## Consequences

Legacy-only sessions continue to show unknown request totals in 3.0, even
where the final cumulative value is recorded. This deliberately leaves the
2.0/3.0 list-stat difference visible until source semantics or a justified
aggregate contract resolves it. The 59 other legacy-only files and same-ID
multi-source sessions remain separate unresolved cases.

## Verification

The independent read-only audit (`../../../tmp/v3-delivery/http01-codex-token-adjudication.public.md`, local evidence)
recomputed the 66 last cumulative totals with BigInt and checked the frozen
source hashes and metadata. The review found `info:null` at line 7 of
`019edec5-e862-7f82-87cf-b8f8db2e7a42`, 17 equal-vector pairs, and
task-boundary crossings. No production request-ledger change was made.
Future promotion would require provider source/version evidence for response
identity, complete canonical source membership/revision checks, and RED/GREEN
tests for equal snapshots, rate-limit-only rows, late metadata, child and
multi-source cases, plus live Web/MCP/Stats/CSV reconciliation.
