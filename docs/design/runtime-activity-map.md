# Recorded activity in the collaboration sidebar

Status: implemented and locally verified, 2026-09-17; user visual acceptance open. Extends the selected option 3 in
[the visual direction](runtime-visual-direction.md) and P4/P5 of the
[presentation contract](runtime-presentation-contract.md).

## Reading task and current audit

1. Open a task from a recorded return in the prose. The sidebar selects the
   correct canonical task: healthy.
2. Compare it with other work at that moment. The current sidebar shows only
   three of nine tall task buttons at once. Dispatch/return clocks must be
   compared manually: needs a shared time axis.
3. Read the original request or returned work. Exact source and complete child
   history links are present: preserve them next to the visual overview.

Current-run evidence: `tmp/p4-overlap-01-before-20260917.png`, captured from the
live nine-task Codex Reader and visually inspected. A screenshot does not prove
keyboard navigation or complete accessible behavior; those need live checks.

## Content and interaction

- A ten-minute recorded-time window lives in the optional collaboration sidebar.
  Main-session prose and each canonical task occupy aligned horizontal lanes.
  Selecting a prose milestone opens its time window; the header opens the latest
  recorded window. Previous/next windows keep the same document owner.
- Show dispatch, follow-up, interruption/resumption, child completion and parent
  delivery as separately sourced records. A dotted connector joins observations
  on one lane; gaps may contain waiting or pauses. It is not a utilization bar.
- Main-session points use each owned text part's timestamp, not the start of a
  coalesced assistant turn. Child completion retains its child-owned source.
- Points too close to separate at the current width form a numbered cluster.
  Selecting it shows each exact record, timestamp and source link. Completion
  and receipt are never merged into one semantic event.
- Coverage and continuation are explicit. The bounded window reads complete
  normalized relations, not the older fifty-item card excerpts. Untimed,
  unassigned or unavailable sources remain distinguishable.
- The existing task selector, request/reply excerpts, exchange history and full
  child history remain accessible. The main reading column stays mounted.

## Visual plan and self-review

Reuse the current semantic palette: light canvas `#F6F7F9`, surface `#FFFFFF`,
ink `#202832`, muted `#586777`, divider `#D4DCE5`, relation `#245BCC`, with the
existing dark equivalents. Keep the system sans-serif stack; 13px task labels,
12px clocks and 14px selected-record text. Labels align left; the shared axis
occupies the full available sidebar width.

The visual emphasis is the alignment of actual recorded work, not additional
cards, decorative icons or a full-page graph. Grouped points solve the observed
one-second completion/receipt gap without inventing visible time separation.
The single-task detail stays below the overview; a compact task chooser replaces
the tall always-expanded list. This preserves the chosen prose-first layout.

## Acceptance

The real nine-task Codex session exposes 124 coordination records. Its
15:30–15:40 UTC window contains twenty points on seven lanes: main-session
continuation plus six tasks, including two review tasks dispatched eight seconds
apart. Child completion, parent receipt and another follow-up remain separately
sourced even when they share a three-record visual cluster.

Desktop and 390px light/dark checks verified the plotted records, no colliding
node buttons and no page-width overflow. Keyboard selection opens the exact
main text anchor. Child completion opens child-owned recorded event evidence
inline, retaining the root page; browser Back restores the parent. Window paging
retains keyboard focus; Escape returns to the opening milestone. The header
reopens the latest window. Removed the redundant sidebar introduction and fixed
plot buttons painting over the sticky heading after seeing both in screenshots.

Local evidence: `tmp/p4-activity-desktop-20260917.png`,
`tmp/p4-activity-390-light-20260917.png`, and
`tmp/p4-activity-final-dark-20260917.png`. Private history and images are not
committed.

`npm test`: 855 passed on Node 26.5.0; the same 855 passed on Node 22.15.0.
New tests cover projection/route ownership, 100-point/20-lane continuation,
anchor-to-page selection, source escaping, exact clustered captions, request
races, stale-page retry and Chinese labels. Independent review also checked
five pagination combinations and 23 anchor selections. The full browser suite,
including the new bounded activity/source assertions, passed with no browser
errors; results are in `tmp/p4-activity-e2e-final-20260917.log`.

An initial Node 22 run hit a metadata database lock. Three Reader route fixtures
were opening the default metadata database; they now use isolated temporary
databases and close/remove them after tests. Both complete suites passed after
isolation. The original lock's sole cause was not established.

Dense pagination and load failure are fixture-verified, not exercised on this
twenty-point real window. Chinese strings are rendering-test verified; this
slice's live checks used English UI. Full P11 and user visual acceptance remain
open.

## Shared endpoint

`GET /api/:provider/session/:id/reader/activity` reuses owned Reader sources and
complete normalized relations without rendering the full Reader. No provider
schema interpretation moves into the browser.

- No parameters: latest recorded ten-minute window.
- `anchor`: raw coordination observation ID; opens the canonical bounded page
  containing that record. Untimed and missing IDs are explicitly reported.
- `from`: Unix milliseconds within a chosen window, mutually exclusive with
  `anchor`. Windows are aligned and half-open.
- Continuation: `from`, `offset`, `revision`; changed window evidence yields
  HTTP 409. Retry refreshes the same window from its first page.

Each response includes coverage, source identities, at most twenty lanes and
one hundred points, optional continuation, and server-rendered HTML. Evidence
collection scans the prepared source; the bounds apply to returned points and
DOM, not to initial provider parsing or a hard end-to-end latency guarantee.
