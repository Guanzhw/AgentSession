---
status: implemented
date: 2026-08-25
decision: Keep session-card rendering server-owned and let paginated sessions APIs return an HTML fragment per JSON row for infinite scroll.
---

# Server-owned session card fragments

## Context

The initial sessions page rendered cards on the server, but infinite scroll
reconstructed a second copy of the card and statistic-chip renderer in browser
JavaScript. That duplicated formatting, localization, escaping, provider
management rules, and return navigation across two rendering boundaries.

## Decision

The sessions APIs retain their existing JSON fields and append `html` to each
row when the route has card context. The server calls the existing
`sessionCard` renderer with provider, global/provider-badge, management, and
return-to context. Infinite scroll inserts that trusted same-origin fragment
directly and no longer interprets session data or formats cards in the browser.
Unknown legacy `kind` query parameters are ignored as ordinary unused URL
parameters.

## Alternatives considered

- Keep the browser card renderer and manually synchronize it with the server
  renderer. Rejected because it preserves two owners for localization,
  escaping, provider controls, and card statistics.
- Add a separate HTML-only pagination endpoint. Rejected because the existing
  bounded sessions APIs already own pagination, and an additive `html` field
  preserves their established JSON fields without another route contract.

## Consequences

Card semantics, localization, escaping, and provider ownership have one source
of truth. API consumers that only read the established JSON fields remain
compatible; consumers that render rows can use `html`. A server restart/build
is required for changes to the card renderer, and the API must continue to
bound page size before rendering fragments.

## Verification

- `npm run typecheck`
- `npm run build`
- `node --test test/management.test.mjs test/session-list-stats.test.mjs test/core.test.mjs test/routes.test.mjs` (156 passed)
- `npm run review`
- `npm test` (281 passed)
- `npm run qa:e2e` against the restarted local server and a real OpenCode session
- Targeted live browser pagination on provider and global pages (30 to 60
  cards, correct management/provider-badge ownership and return links, no
  browser errors)
- `git diff --check`
