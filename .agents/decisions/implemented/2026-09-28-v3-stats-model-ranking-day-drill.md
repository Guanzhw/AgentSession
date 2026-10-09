---
status: implemented
date: 2026-09-28
decision: Rank recorded request model IDs and load selected-day session totals on demand
---

## Context

The v3 statistics slice needs model-level request usage and a way to inspect
which canonical sessions contributed to a daily total. Usage records preserve
an optional model identifier and distinguish known token totals from requests
whose totals are unknown. The feature scope was selected as the bounded
recommendation after no timely answer to the scope question; it was not an
explicit user approval.
The model-only ranking mechanism below was superseded by
`2026-09-28-v3-opencode-model-provider-statistics.md` after frozen source
evidence showed two OpenCode provider IDs sharing one model ID.

## Decision

Rank the recorded `UsageRecord.model` value within the selected provider route
using known token subtotal, request count, and unknown-token request count.
Keep absent model attribution in its own visible row, and never add unknown
token totals into the known subtotal. An optional UTC `day` query selects a
date within the requested range and returns that day's canonical session
request, known-token, and unknown-request totals under the active provider,
scope, directory, project, and model filters. The default daily report remains
compact and loads session rows only for an on-demand day selection.

## Alternatives considered

Provider/model-pair ranking is unsupported because the OpenCode usage parser
does not preserve `providerID`; the ranking therefore describes recorded
model IDs within the selected provider, not a globally unique backend key.
Price estimates, model comparisons, and heuristic token totals have no
supporting source contract for this slice and were not selected.

## Consequences

The statistics API and UI add model ranking plus a selected-day drill without
changing provider sources or canonical session ownership. Day rows link to
their canonical sessions and contain only day-specific request and token
coverage totals; whole-session message counts are not presented as daily data.
Known-token subtotals remain explicitly incomplete whenever unknown requests
are present.

## Verification

`v3/test/stats-slice.test.mjs` covers model attribution, unknown totals,
preserved filters, canonical per-day sessions, and out-of-range day rejection.
Its opt-in frozen OpenCode SQLite oracle independently checks request/model
ranking and the selected-day session totals for 6 canonical sessions and 71
request rows; the database and WAL SHA-256 values were unchanged. The relevant
browser command `node --test --test-name-pattern='Stats' v3/test/ui-regressions.test.mjs`
passes 6/6, including rejection of day totals from a different source
revision, explicit base-report refresh with filters/day preserved, and an
older in-flight day response being ignored. `npm run build` in `v3/ui` passes.
See the v3 delivery evidence for the broader suite results.
