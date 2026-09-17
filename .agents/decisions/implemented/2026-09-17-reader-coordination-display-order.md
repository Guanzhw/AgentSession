---
status: implemented
date: 2026-09-17
decision: order Reader task exchanges by recorded time while preserving protocol source order
---

## Context

Real task-channel inspection places a 14:44 follow-up before a 14:43 parent
result delivery, and both child completions after all parent deliveries.
The normalized coordination array groups observations from different source
passes. Preserving that array order as the Reader's visible sequence obscures
the asynchronous exchange the product is meant to explain.

## Decision

Keep protocol facts and source order unchanged. Derive one Reader display
order after canonical card assignment: known timestamps ascending, ties stable
in source order, then untimed records in source order. Label this as recorded
time order and make absent time explicit. Use the same ordering in the initial
bounded channel and its continuation before slicing pages.

Compute task interruption and latest activity from the complete assigned
collection. Bind continuation to the displayed cumulative `(id, timestamp)`
prefix using a fixed-size SHA-256 digest and count. A changed prefix is an
explicit stale cursor; appending later records does not invalidate it.

## Alternatives considered

Reordering provider facts changes a broader contract unnecessarily. Sorting
only browser rows or only one fetched page would make initial and later pages
disagree. Pairing follow-ups and completions would infer causality not recorded
in these sources.

## Consequences

Readers can follow the recorded sequence of exchanges without treating time
order as causality. Canonical observation/source identities, exact owner links,
per-run grouping and page bounds remain intact. Existing source-order Reader
assertions must be updated; protocol-order assertions remain valid.

## Verification

`npm test` passed 720/720; focused coordination/card tests passed 35/35.
Regressions cover ties, untimed records, protocol immutability, full-collection
state, 120 records across three pages, changed prefixes, suffix appends and
SSR cursor agreement. Independent review found no remaining blocking issue.
The formal service returned all 21 real task records across 11 API pages;
browser keyboard checks opened both follow-ups, both child completions and
both parent deliveries at their exact sources, including 390px checks.
`npm run review`, full `npm run qa:e2e`, seven installed-provider samples,
`npm run build:binary` and `npm run smoke:binary` passed. Detailed scope and
the separate unresolved navigation-owner issue are recorded in
[Reader coordination](../../../docs/design/runtime-reader-coordination.md)
and [acceptance evidence](../../../docs/design/runtime-acceptance-evidence.md).
