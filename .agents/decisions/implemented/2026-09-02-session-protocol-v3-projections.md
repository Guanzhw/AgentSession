---
status: implemented
date: 2026-09-02
decision: Expose four bounded, typed Session Protocol v3 runtime projections through explicit domain routes while preserving the v2 Runtime API.
---

# Session Protocol v3 runtime projections

## Context

The v3 foundation defines typed goals, actors, coordination observations,
context versions and transformations, and request usage. The existing Runtime
routes still expose the v2 summary, event, and generic compatibility graph.
The Work Graph stage needs stable domain contracts without moving provider
interpretation into routes or introducing arbitrary graph storage.

## Decision

Add provider-neutral Work, Execution, Coordination, and Context projections
over a finalized v3 snapshot. Each projection carries the canonical focus
session, its domain coverage, bounded diagnostics, typed entity arrays and
typed relations, plus `maxItems` and truncation metadata. V2 snapshots are
explicitly upgraded at the route boundary; the upgrade preserves v2 facts and
leaves new domains unknown rather than synthesizing coordination,
transformations, or usage. Execution owns additive request usage records and a
direct selected-session aggregate. Context may expose origin slices by usage
reference without duplicating usage records.

Routes are `/runtime/work`, `/runtime/execution`, `/runtime/coordination`, and
`/runtime/context`. The established `/runtime/summary`, `/runtime/events`, and
`/runtime/graph` routes remain unchanged.

## Alternatives considered

- Replace the v2 generic graph route with a v3 graph bag. Rejected because it
  would erase the compatibility contract and make provider semantics opaque.
- Treat v2 session relationships as v3 coordination observations. Rejected
  because lineage is not continuing coordination without provider evidence.
- Add pagination immediately to all domains. Rejected because current domain
  snapshots can be bounded by a strict item/construction limit; pagination can
  be added later only with a filter-bound cursor contract.

## Consequences

Consumers can select one domain and receive render-ready typed facts with
truthful coverage and provenance. A v2 provider can participate without
invented v3 facts. Large arrays cannot cause unbounded projection work, though
the current no-provider-mapping stage may report truncated output at the
configured bound.

## Verification

- `npm run build` passed (core TypeScript build plus MCP workspace build).
- `npm test` passed: 310 tests, including the pre-existing v2 Runtime routes.
- Focused projection and route tests passed: 9 tests covering v2 upgrade,
  canonical refs, coverage, truncation, provider-data omission, missing totals,
  actor/run-caused usage omission, invalid bounds, invalid-protocol HTTP 422,
  and bounded flattened relations.
- `npm run check:governance` and `git diff --check` passed.
