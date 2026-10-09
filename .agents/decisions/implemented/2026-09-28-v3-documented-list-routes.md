---
status: implemented
date: 2026-09-28
decision: Preserve the documented 2.0 session-list paths as thin 3.0 transport adapters while keeping the structured v3 Library API as the primary Web data contract.
---

# Documented list routes in 3.0

## Context

The 2.0 README documents `/api/sessions`, `/api/:provider/sessions`,
`/api/library/sessions`, and `/api/library/children`. The first 3.0 candidate
returned 404 for these paths even though its new `/api/v3/library` pages worked.
The 2.0 family response also contained HTML consumed by its
`library-families.js` expansion flow. The later
[JSON-only response decision](2026-09-28-v3-json-only-list-responses.md)
resolves that presentation field separately from route identity.

## Decision

[The Axum list adapter](../../../v3/crates/app/src/legacy_lists.rs) retains the
four documented paths, their canonical provider/session identities, offset
pages, and structured family/child rows. It calls the shared Rust Core for
session and family facts. The Svelte Library continues to use the structured,
revision-bound `/api/v3/library` contract; its filtering and navigation are
validated separately. Provider sources remain read-only.

## Alternatives considered

Redirecting old paths to the Svelte shell would make JSON callers receive
HTML. Dropping the paths based only on the new Svelte consumer would ignore
the published README's route identities. Recreating a second
provider parser in Axum would split canonical identity and source semantics.

## Consequences

There are two transport shapes over the same source facts. The legacy bridge
requires explicit differential tests for filters, ordering, list statistics,
content-search ranking, and the new JSON row fields. The later JSON-only
decision explicitly removes the 2.0 HTML fragment from 3.0 responses. Exact HTTP-01/02 parity remains
open where the 2.0 and 3.0 projections differ; a matching JSON key set alone
is not acceptance.

## Verification

[The focused route test](../../../v3/test/legacy-list-routes.test.mjs) first
failed with 404 and now exercises flat/provider lists, family/child pages,
query boundaries, structured `href` fields, and absence of `html`. An isolated direct comparison
against fixed 2.0 `50a32e7` found equal five-provider family identities and
unchanged source hashes; its detailed values are recorded in ignored
`tmp/v3-legacy-qa/evidence.jsonl`. It also found different Pi/Codex list
statistics, so HTTP-01/02 remain unaccepted. The final integrated binary and
browser consumer must be retested after this worktree's concurrent slices
settle.

A later fixed 2.0/current 3.0 comparison found two offset boundary errors:
ordinary list offset 100001 wrongly returned 400 instead of an empty 200 page,
while requested `mode=content&q=&offset=-1` wrongly returned 200 instead of
400. The controlled HTTP test reproduced both RED; the adapter now applies
the 100000 ceiling only to content search and validates the requested content
mode before empty-query fallback. The focused legacy, family, partial-source,
and title-sort suite passed 6/6 on the rebuilt debug binary. Selected Codex and
Pi list-stat differences were subsequently resolved through provider-owned
source evidence; broader HTTP-01/02 parity remains open.
