---
status: implemented
date: 2026-09-28
decision: Preserve OpenCode model provider identity in request statistics
---

## Context

The frozen OpenCode v2 source records `model.providerID` and `model.id` on
assistant requests. Two recorded providers use the same `deepseek-v4-flash`
model ID. The 3.0 request parser retained only the model ID, so the Statistics
ranking merged their requests and a model filter could not select either
provider separately. This replaces the model-only limitation documented in
`2026-09-28-v3-stats-model-ranking-day-drill.md`.

## Decision

The OpenCode adapter normalizes the recorded model provider into an optional
`UsageRecord.modelProvider` alongside `model`. Other providers leave the field
absent when their source does not record an equivalent identity. Empty OpenCode
model/provider strings normalize to missing at that source boundary; they
cannot name a selectable model or provider. Statistics
rank and offer model options by the two distinct fields; a `modelProvider`
query narrows a selected model without parsing display text. JSON and CSV
exports use the same filter, and CSV names the model provider in a separate
filter column. An omitted `modelProvider` remains a wildcard for existing
model-only links; `modelProvider=` selects requests with missing provider
attribution; a nonempty value selects the exact recorded provider. CSV adds a
filter-mode column (`any`, `missing`, or `exact`) so the first two cases cannot
be confused. The UI displays `provider · model` when the provider is known
and the model alone otherwise. A provider-only record displays its recorded
provider beside “Model not recorded” without assigning it a model ID.

## Alternatives considered

Combining the provider and model into one slash-delimited value would be
ambiguous for recorded model IDs that already contain slashes. Keeping the
model-only ranking would continue to merge distinct recorded request sources.

## Consequences

OpenCode requests under distinct provider IDs no longer share a ranking row.
The field is optional in protocol output for other sources, so missing
provider attribution stays missing. Provider files and databases remain
read-only. HTTP-06 and CORE-14 remain open for their other acceptance cases.

## Verification

`v3/test/stats-slice.test.mjs` first failed against the `ec320284` packaged
binary: its model ranking returned one 1,137-request row for the two recorded
`deepseek-v4-flash` providers. The copied frozen SQLite oracle independently
counted 1,018 `deepseek` requests and 119 `opencode-go` requests; the updated
debug binary passed separate ranking, filter, CSV and source/copy DB/WAL hash
checks. `v3/test/ui-regressions.test.mjs` checks distinct options, selected
filter and download URLs, day drill and Chinese text. The affected Rust
workspace tests, UI build and governance checks are recorded in the handoff.
An isolated OpenCode fixture with the same model under providerless and
provider-qualified requests first exposed the empty-filter wildcard bug, then
passed wildcard, missing, exact, CSV, day drill, and source hash assertions.
A separate fixture with empty recorded strings checks protocol usage and Stats
rank/option normalization.
