---
status: implemented
date: 2026-09-04
decision: Implement the UI v2 P1 Library stage on the shared semantic visual
  system while keeping the existing cross-provider index, search, and viewer
  metadata boundaries unchanged.
---

# UI v2 P1 Library

- Status: implemented
- Date: 2026-09-04
- Scope: Library summary strip, primary search, filter chips, timeline/compact
  list, batch management, distinct empty states
- Blueprint: `docs/design/ui-v2.md` §4.1, P1 in
  `docs/prompts/frontend-implementation/02-p1-library.md`
- Visual contract: `docs/design/ui-v2-visual-system.md`

## Context

The P0 information skeleton left the Library on the old card-dashboard layout:
a filter grid with provider/project/time/sort controls, and a provider-summary
line that disappeared whenever a filter was active. P1 needs the Library to
follow the v2 information hierarchy (summary strip, primary search, removable
chips, day-bucketed timeline, distinct empty states) without inventing new
provider facts or a second search backend.

## Decision

Implement the Library stage entirely on existing evidence:

- **Summary strip** reads provider/session/message/token totals through the
  existing overview boundaries: the global Library and indexed file-provider
  views use the viewer-owned `session_index` table, while the provider-scoped
  OpenCode view keeps its existing SQLite overview query. That SQLite path
  sums recorded message token components with the same component semantics as
  the Token Explorer. Unknown or unrecorded totals are not fabricated; the
  recorded sum is shown.
- **Search** reuses the existing list search API (`/sessions?q=` cross-provider
  via `getCrossProviderSessions`, `/api/:provider/sessions` per provider).
  No content-search backend is added.
- **Filter chips** (today / this week / starred / has-subagent) are GET links
  that round-trip through the URL, so browser back/forward and refresh preserve
  state. `has-subagent` is derived from provider-recorded `parent_id` rows
  (indexed `EXISTS` on child rows); starred uses viewer metadata only. The
  existing provider multi-select, project, time range, sort, and list keyword
  stay available behind one Advanced disclosure.
- **Timeline** is the no-JS default and buckets by local calendar day with
  editorial headings; the compact-list toggle persists in `localStorage`
  (`as.library.view`) and only re-buckets the same server-rendered rows.
- **Batch star/delete** uses viewer metadata only through a new
  `POST /api/sessions/batch` endpoint (`{items: [{provider, id}], action}`),
  which skips providers that do not support local management. Per-card controls
  carry `data-provider` so the global library never assumes a single provider.
- **Empty states** are three distinct blocks (`empty` / `no-results` /
  `unavailable`) each with one clear next action; storage diagnostics stay a
  pinned non-blocking line. Structured provider diagnostics are not coerced to
  browser text or interpreted by the shared view.
- **Visual system**: `style.css` now declares the v2 semantic roles
  (`--v2-page/panel/raised/text/secondary/boundary/accent/accent-soft/warm`)
  as the source of truth and remaps the legacy aliases onto them in both
  themes; the desktop rail is 176 px with an accent-soft active state. Later
  detail surfaces inherit the shared tokens only; their markup is unchanged.
- **Infinite loading** is retained; appended rows are re-bucketed by the same
  client-side day grouping.

Provider data stays read-only: no adapter, database, or transcript change was
made. No new runtime dependency or search backend was added; the existing
`node:sqlite` viewer index remains the only cross-provider source.

## Alternatives considered

- Server-side re-render of the timeline day groups in compact mode: rejected
  because compact is a display preference owned by `localStorage`, and
  re-bucketing already-rendered SSR rows keeps the no-JS baseline intact.
- Filter chips as submit buttons with JS history pushState: rejected because
  plain GET links give back/forward and refresh semantics for free with no
  history bookkeeping.
- Cross-provider content search: rejected — the contract already keeps
  transcript search provider-owned and per-provider; P1's cross-provider
  search scope is the existing list index.
- A hard `has-subagent` protocol flag: rejected because the indexed
  `parent_id` rows are the only evidence available and are already recorded;
  no new protocol vocabulary was introduced.

## Consequences

The dashboard/provider-summary card is replaced by the summary strip and header
links; the old filter grid moves behind Advanced. `getCrossProviderOverview`,
`getIndexedOverview`, and `getOverviewStats` now also return recorded
`totalTokens`. The `/sessions` and `/api/:provider/sessions` queries accept
`has-subagent`; starred filtering in cross-provider lists now works through
viewer metadata. Browser JS gained `src/static/app/library.js` (bundled into
`dist/src/static/app.js`) and provider-aware star/menu/batch handling so the
global library never mixes provider identities.

## Verification

- Focused regressions: `test/library-v2.test.mjs` (indexed token totals,
  has-subagent index filter, global page summary/chips/day buckets/view
  toggle markup, distinct empty states, cross-provider batch route), plus
  updated `test/core.test.mjs` (rail width, empty-state coverage),
  `test/management.test.mjs` (overview token totals), and
  `test/session-list-stats.test.mjs` (chip label vs protocol chip scoping)
  assertions.
- `npm run check:governance`, `npm run typecheck`, and `npm run build` passed.
- `npm test`: 385 passed, 0 failed, including the focused Library regressions
  for token totals, the empty starred selection, URL-roundtripped chips,
  timeline buckets, empty states, API card capabilities, and cross-provider
  metadata-only batch actions. The final pass also covers starred child-session
  visibility, `has-subagent` project counts, and filtered OpenCode overview
  totals using the same session predicate as the list.
- `npm run qa:e2e` passed against the real local OpenCode database and session
  `ses_1ddf03616ffeTE5c6cbpUPMY3n`, including Library structure, canonical chip
  links, management confirmation, detail deep links, Runtime evidence, and an
  empty browser-error report.
- Manual real-browser checks covered 1280/768/320 px in both themes with zero
  horizontal overflow at 320 px; axe WCAG A/AA scans reported zero violations
  in light and dark. `/` focused Library search, Tab reached Search then Today,
  `j`/`k` moved between rows, compact mode survived reload, and a Today filter
  survived browser back/forward. A real cross-provider batch star/unstar cycle
  completed and restored the original viewer metadata state.
