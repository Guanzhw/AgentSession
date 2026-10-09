---
status: implemented
date: 2026-10-04
decision: Restore bounded Reader search state per canonical pane from its owning browser history entry
---

# Reader search return state

## Context

After selecting a child source and returning to its parent, search terms,
results and selected content disappeared on a fresh Reader
mount. That interrupted returning to a complete search hit and lost the
reader's orientation. The
[presentation contract](../../../docs/design/runtime-presentation-contract.md)
and [Reader slice](../../../docs/design/runtime-reader-slice.md) require each
pane to retain its query and selection across return navigation. This supports
the orientation and complete-detail outcomes in the
[usability plan](../../../docs/design/agentsession-v3-usability-plan.md).

## Decision

Store a typed `agentSessionReaderSearch` namespace in the current browser
history entry, scoped to its canonical root provider/session. Key pane
snapshots by canonical provider/session and retain source revision, draft and
committed query, loaded result pages and cursor, selected hit, error, and pending
initial or continuation search. Reuse the existing history state when updating
this namespace.

On return, restore current-revision results and selected content within their
own panes, resume interrupted search work, and preserve parent insertion focus.
Wait for the existing layout owners before restoring root content; a late
reveal scrolls the nearest insertion control only if it was visible before the
content insertion and still owns focus. If the source revision changed, clear stale results
and selection, keep the draft query, and show the existing source diagnostic.
Do not persist unrelated read-more or detail-loading state.

## Alternatives considered

- Put search state in the URL: full bounded result pages and pending requests
  would make navigation URLs carry transient pane data.
- Keep state only in mounted components or browser cache: neither restores it
  after a fresh Reader mount.

## Consequences

Back and Forward can restore each pane's query, results, selected owner, and
pending feedback while preserving unrelated history state and parent reading
focus. Results follow the existing explicit search pagination; each request
keeps its existing bounds. Unrelated progressive details are not persisted.

## Verification

The observed native9 child-source return lost both pane searches. The
[focused regression](../../../v3/test/ui-pane-search.test.mjs) records RED/GREEN
for fresh-mount/reload Back/Forward, interrupted initial/continued searches,
changed revisions, actual layout-mount timing, late root/child reveals and a
user who has moved the reading position. Controlled browser plus real Axum
search/metadata checks passed 18/18, with no failures or skips. That run
preceded only trailing-slash and nullable syntax adjustments; the final seven
HTTP/browser suites cover the frozen source and native10 executable and pass
52/52 with no failures or skips.

Native10 d138e749, with embedded JavaScript 55fb7157 and CSS a9ac2507, was
checked in CUA at 1280 by 720. Real Codex child-source Enter → Back → Forward →
Back retains both terms, 25 root results plus cursor, 13 child results and both
selected highlights. The parent child-toggle remains focused and visible at
top 689.95/bottom 719.95; collapse/reexpand retains the child search. All 70
build inputs match the current source and served UI assets match the build.

Independent review of the frozen source found no actionable product defect.
`npm run review` passes governance and core TypeScript checks. Raw RED/GREEN
logs and the final run are under
`tmp/v3-usability-20261004/agent-browser-after10/`; source/served identities and
private interactions are under `native-after10/`. The frozen incremental diff
is reconstructed evidence, not an original source-byte snapshot. Current
native CUA capture fails; partial existing QA screenshots and outstanding
visual checks remain explicit in the
[usability ledger](../../../docs/design/agentsession-v3-usability-plan.md).
