---
status: implemented
date: 2026-10-01
decision: Use explicit versioned Reader, pane-search, Protocol and Runtime HTTP contracts
---

## Context

The fixed 2.0 README publishes Reader, pane-search, Protocol and Runtime JSON
routes. Independent source review found different native 3.0 schemas, cursor
identity, event selectors, graph traversal and bounded domain pages, including
pure-data endpoints. Some old Reader responses contain server-rendered HTML.
Exact Windows 91f2d58a currently returns 404 for the published old families.
The [inventory](../../../docs/design/agentsession-v3-interface-inventory.md)
records public promises separately from observed UI consumers; external clients
have not been established or ruled out.

## Decision

Adopt the native `/api/v3` schemas. Recognized retired GET endpoints return a
structured 410 migration diagnostic with the canonical reference, correctly
encoded replacement API and Reader URL. Unknown routes retain 404. Retain the
already decided legacy list JSON, current settings, management, prompt and resume
contracts. Preserve public HTML search entry points and query/provider scope.
Native search continuation replaces the old HTML offset page convention;
nonzero offsets show an explicit first-result notice, while malformed offsets
require a new submission. Source scopes are retained on every native cursor
request and in browser history.

The user authorized feature questions and proceeding with our recommendation
when no timely reply arrives. Questions were asked on 2026-10-01; the latest
question explicitly covered pure-JSON schema/filter changes. No answer had
arrived when implementation began. This is the recommended default, not an
explicit user selection; report it in the final handoff.

Document old event phase/task/run/correlation selectors, multi-value category
and kind filters, recursive graph depth and maxItems projection shapes as
changed capabilities. Their source-backed facts remain separately inspectable
where recorded; do not claim old query equivalence. Native query boundaries
reject unsupported selectors. Pane callers obtain a fresh revision and native
references/cursors; no old cursor or event-ID conversion is promised.

## Alternatives considered

Preserving old pure-data DTOs would require recorded bindings, separate cursor
identity, old graph traversal and complete legacy search/projection semantics.
It remains an option if a concrete consumer requires it. Preserving all old HTML
fragment contracts additionally retains the old rendering system. Returning a
new payload under an old URL or redirecting JSON callers to HTML misstates the
contract and was rejected.

## Consequences

This is a deliberate 3.0 API and capability change. Native endpoint success
does not itself establish source-fact or browser equivalence. The acceptance
contract keeps the remaining functional and real-source gaps open. MCP retains
its separately tested native contract. Provider files and metadata are unaffected
by routing changes.

## Verification

Independent primary-source judgment is retained in the ignored delivery report
`tmp/v3-delivery/http-migration-judgment/REPORT.md`. It identifies old TypeScript
and current Rust definitions and records the exact91 GET evidence reused.
`v3/crates/app/src/web.rs` owns retired-route recognition and encoded replacement
links; `v3/ui/src/App.svelte` and the Library own HTML query/scope/history.
The exact91 RED had two failures (404 rather than410/200). The new locked/offline
debug build passed both new HTTP cases, then 23 routing/protocol/list/search
regressions. The checks cover fourteen retired published routes, unknown404,
encoded IDs, unsupported native selectors, graph depth and maxItems rejection,
and provider source hashes. Four new source-UI browser cases recorded RED then
GREEN; the complete focused search/filter/focus run passed15/15. Independent
Reader concurrency review found a successful-discovery cache regression; its
separate RED→GREEN and the final3/3 source-UI cases preserve bootstrap overlap,
failure retry and source-navigation Back. These are compiled debug/source-UI
checks, not execution of a new release bundle. Exact package consolidation and
remaining real-source acceptance continue in the delivery plan.
