---
status: implemented
date: 2026-09-28
decision: Keep the four documented 2.0 list paths in the 3.0 candidate as JSON-only migration adapters with stable filters and paging.
---

# JSON-only responses for legacy list paths

## Context

The 2.0 README documents `/api/sessions`, `/api/:provider/sessions`,
`/api/library/sessions`, and `/api/library/children`. The earlier [list-route
decision](2026-09-28-v3-documented-list-routes.md) retained these paths in the
3.0 candidate, whose family adapter then returned HTML used by the 2.0 browser
expansion flow. The 3.0 Svelte client already reads the versioned JSON Library
API at `/api/v3/library`; the candidate still needs the documented paths for
data clients and side-by-side migration.

## Decision

The 3.0 candidate keeps all four paths and returns JSON only. Flat list routes
return `{sessions,total,offset,hasMore}`; rows carry `href` and retain list
statistics, with `searchMatch` on matching content-search results. An
unavailable provider returns a JSON diagnostic. Family
pages return `{sessions,total,offset,hasMore,matchingSessions}`. Each family
row exposes `id`, `provider`, `title`, `directory`, `time_created`,
`time_updated`, `parent`, `href`, `matched`, `matchingCount`, `childCount`,
`totalChildCount`, `familyRootId`, `familyUpdated`, and `parentBoundary`.
Children pages return `{children,total,offset,shown,nextOffset}` with at most
20 rows. Existing query filters, ordering, and offset paging retain their
semantics. The [Svelte client](../../../v3/ui/src/lib/api.ts) continues to use the
versioned `/api/v3/library` contract. The fixed 2.0 implementation remains
separate and unchanged.

## Alternatives considered

Keeping rendered `html` fields would couple data clients to 2.0 presentation
markup. Redirecting these paths to the Svelte shell would make JSON callers
receive HTML. Removing the documented aliases in favor of versioned paths
would break their candidate-side route identity. The chosen migration keeps
the paths and list behavior while making their response contract data-only.

The user explicitly confirmed on 2026-09-29 that 3.0 should remove the old
`html` field and use JSON plus the new Reader as its Web/API contract.

## Consequences

Consumers of the 3.0 candidate must read the JSON wrappers and `href` values;
the old fragment hook is not part of these responses. The decision supersedes
the HTML-fragment assumption in the earlier list-route record while preserving
its path and identity choice. The migration is documented in the [3.0
README](../../../v3/README.md#legacy-list-route-migration). Broader HTTP-01/02
parity across providers and filters remains tracked in the [acceptance
contract](../../../docs/design/agentsession-v3-acceptance-contract.md).

## Verification

The [3.0 route implementation](../../../v3/crates/app/src/legacy_lists.rs)
defines these wrappers and row fields. The [focused HTTP test](../../../v3/test/legacy-list-routes.test.mjs)
asserts flat and family JSON shapes, `href`, the absence of HTML fields, query
filtering, and the 20-item child-page boundary. This documentation update was
checked with `npm run check:governance` and `npm run review`. Those checks do
not close full HTTP-01/02 parity; the remaining comparisons are listed in the
acceptance contract.
