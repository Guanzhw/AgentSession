---
status: implemented
date: 2026-09-11
decision: Restore child-session navigation with a validated local parent Workbench URL
---

## Context

Runtime run rows expose recorded child session IDs, but their canonical links
lost the originating parent Workbench, selected run, and paged run position.

## Decision

Encode the viewer-owned parent detail URL in the child link's `from` query
parameter. The local detail URL carries `runtimeLens=execution`, the recorded
`runtimeRun` ID, the run page size, and the opaque `runCursor` when the page was
reached through paging. `parseSessionNavigationContext()` accepts only this
exact same-origin detail shape (alongside the existing library/statistics
shapes). The existing `queryRunPage()` boundary remains responsible for cursor
and page validation.

## Alternatives considered

- Browser history alone: rejected because it does not provide a visible return
  control or preserve the exact page in a new tab.
- A viewer-side session store: rejected because it adds state without a
  consumer and cannot survive a copied child URL.
- Arbitrary return URLs: rejected because return navigation must remain local
  and viewer-owned.

## Consequences

Child pages show a visible Workbench breadcrumb and action link. Parent pages
restore the exact run page and select only the recorded run named by the URL.
If the cursor or run is stale, existing run diagnostics or a localized stale
selection notice remains explicit; no neighboring run is substituted. Direct
child URLs and existing list/statistics breadcrumbs remain unchanged.

## Verification

- `npm run typecheck`
- focused navigation and Runtime Workbench tests
- full `npm test`
- real DSH return passed EN/ZH, both themes and 1280/768/320px with exact
  selection, visible inspector and Escape focus return after the narrow fix
- real later-page Codex return, new-tab return, stale-cursor recovery and
  off-page/back selection passed; see the design acceptance note
