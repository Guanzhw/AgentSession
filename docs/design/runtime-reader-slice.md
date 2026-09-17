# Unified reader: first production slice

Status: first prose-first production preview implemented and its inline
reading flow verified on real data; user visual acceptance and complete
site-wide regression remain open, updated 2026-09-17. This is the concrete interface
contract for Stage 2 of the [reading roadmap](runtime-reading-model.md).
The [product presentation specification](runtime-presentation-contract.md)
defines the current content and interaction target; this document owns the
technical slice and its verification, not final visual acceptance.

## Product behavior

The session route opens complete main-session reading. Recorded user inputs and
replies remain visible; intermediate commentary, tools and reasoning are
expandable. Unknown presentation phases stay visible. Recorded collaboration
milestones appear at source-ordered part positions with restrained branch
connections; the on-demand Tasks & collaboration panel follows the selected
visual direction. Work and
Events are secondary disclosures, not competing primary pages.

Selecting a child at a collaboration insert opens its complete owned history
at that reading position while the parent remains mounted. Closing returns to
the origin; canonical standalone links also remain available. Reader navigation
preserves expanded content, scroll, focus and search. Source data stays
provider-owned and read-only.

Contents follows the same inline path. If the related session has no recorded
milestone position, its history opens after the transcript with an explicit
unknown-position label. The root page is never partially replaced by a child.

## Server and rendering ownership

Reuse `getSessionDocument`, normalized session trees, existing content
continuation, compaction projection and inherited-context accessor. Render one
session's owned history per reader pane. Nested tasks expose canonical child
links and their own full tool disclosure; child bodies load on demand. A child
is never lost behind an agent metadata card, and its inherited context remains
a separate disclosure in its own reader.

Add the read-only endpoint `GET /api/:provider/session/:id/reader` for this
observed consumer. Its JSON result is:

```ts
{ ok: true, provider: string, sessionId: string, title: string, html: string }
```

`html` is the same server-rendered reader pane used by the normal detail route,
with full available message/tool/reasoning content reachable through existing
progressive-content controls. It contains no page shell or executable scripts.
Missing provider/session and rendering failures retain explicit HTTP errors.
Both routes share preparation and rendering. The observed full-family loading
failure requires an optional provider-owned reader projection: complete owned
root content plus canonical child entry descriptors, without retaining child
bodies. This is a reading projection of the existing source contract, not a
replacement protocol or a second transcript parser. Legacy structured exports
retain their full-family scope. See the [loading decision](../../.agents/decisions/implemented/2026-09-16-bounded-transcript-payload-cache.md).

Reader navigation uses finalized runtime facts already available to the route
and the conversation view model. Source anchors remain canonical message,
part, session and recorded milestone anchors. A graph span is the range of
recorded observations, not a live process-health claim. Missing time evidence
produces an untimed relation, not a fabricated duration. Bounded projections
must disclose omitted navigation records and retain access to their evidence.

### Selected-task excerpts

`GET /api/:provider/session/:id/reader/preview` reads one selected session's
normalized owned document, never its family. It returns `provider`, `sessionId`,
`request`, `reply` and an escaped, localized `html` fragment. Each slot contains
availability, text (at most 400 characters), phase, canonical source reference
and an explicit `no-readable-content` reason when absent. Only text parts are
eligible; tools, reasoning and inherited background are excluded. The request
is the first recorded owned user text, not an inferred task purpose. The reply
is the latest recorded final text, otherwise the latest assistant text, with
that distinction visible. An excerpt is not evidence of parent-side delivery.

The task map groups by canonical child identity and preserves separate run
states and source links. Selection loads only that task's excerpts and retains
them in its pane. A failed load exposes a retry; a late response updates its
own target without changing selection. Opening a nested task panel closes the
other panel. Recorded exchanges remain a secondary disclosure. Partial channel
counts say "at least" rather than implying all returns have been loaded.
Full history and exact dispatch/excerpt source links remain distinct actions.

Per-message usage and model metadata now use a native disclosure. User and
assistant prose share a left-aligned reading column; opening the desktop task
panel reserves a 360–430 px region at the right edge below the top navigation.
The reading column is bounded to 80ch with actual prose at 18px / 1.78.
Inline child history includes its own canonical title and close/standalone actions.

## Shared HTML contract

- The page `.session-workbench` keeps its root `data-provider` and
  `data-session-id`; management/export/resume retain their root ownership.
- Add `data-session-reader` to that page root, plus `data-reader-host` for the
  root pane and its lazily mounted child panes. Each pane has `data-reader-pane`,
  `data-reader-provider`, `data-reader-session`, and `data-reader-title`.
- Each pane contains its own transcript, inherited-context disclosure and ToC.
  Message/part identities and continuation hooks remain canonical. Inline panes
  namespace their DOM IDs while retaining canonical anchor metadata; lookup is
  scoped to the owning pane rather than the whole document.
- Child links use their normal canonical `href`, with `data-reader-open`,
  `data-reader-provider` and `data-reader-session` on the link. Unavailable
  children keep an explicit recorded/unavailable state.
- The document H1 retains the canonical page owner. The shell supplies
  `data-reader-back`, a child-only `data-reader-current-title` label and
  `data-reader-status` (live status for loading/error), plus transcript-search
  controls with an explicit root/inline-child scope selector.
- The collaboration panel groups each canonical child once, retaining its
  separate run states and channel records inside the same branch. The connected
  session-to-task outline opens exact source links and existing channel paging;
  it does not duplicate a second flat task list. Main turns alone create no panel.
- Runtime source links use `data-reader-source`, `data-reader-provider`,
  `data-reader-session` and `data-reader-anchor` (DOM id without `#`). These
  reveal the exact recorded anchor in the owning pane. An unmounted related
  owner is opened through its recorded reader control; otherwise the link
  performs a full canonical navigation. Source/Contents hrefs remain canonical
  even when inline DOM IDs are scoped.
- Keep `#tab-conversation` as a reading-entry anchor and `#tab-work` /
  `#tab-events` as secondary disclosure targets for existing deep links. Remove
  the two-primary-tab controls and their obsolete client behavior.

## Browser ownership

Cache visited panes as DOM nodes keyed by provider plus canonical
session ID, preserving their loaded continuation and disclosure state. Fetch
unvisited panes from the reader endpoint. Track navigation history explicitly,
including direct sibling switches and nested child selection. Do not clone
active DOM IDs or manufacture session relationships from message text.

The pathname always identifies the root page and its global title, export,
management and resume actions. Inline locations use `readerSource` for a
same-origin canonical child/source URL and repeated `readerAncestor` values
for the recorded nested path. Native message anchors and `readerEvent` remain
inside that source URL. Existing root query parameters, including the Library
return context, remain intact. A copied URL restores each level only through
an existing normalized child control. Standalone links retain their own
canonical pathname and load the complete owning page.

Search queries the server's complete selected owned content, excluding inherited
context and retained checkpoint results. Loaded DOM content does not define
search coverage. Opening an inline child keeps the current search scope;
selecting its scope searches that child's owned history. Keep each pane's
query/result selection when returning and invalidate pending requests on
scope changes. Progressive content
requests resolve the nearest pane's provider/session before the page root.
Deep-link reveal, keyboard handling and ToC must work after inline mounting.

Use a readable prose column and local collaboration inserts. The selected
option-3 presentation moves the auxiliary overview to an on-demand right
Tasks & collaboration panel: opening a passage's task selects its actual
dispatch, exchanges and returns. The panel closes back to the same reading
position. Contents navigation also opens on demand. Expanded
code/tables/context stay within their reading region in both locales and themes.

## Verification

Add focused SSR/route tests for default history, no competing tab bar, identical
root/fragment rendering, canonical child navigation, complete tool disclosure,
separate inherited content and explicit missing-session responses. Browser
tests cover main-to-child-to-parent, sibling/nested navigation, full-body search,
continued content owned by the selected session, source-anchor jumps, and
expanded narrow content. Run the full test/review suite, real provider/API and
browser acceptance before publishing the production slice. The private
prototype is evidence for composition, not a substitute for these checks.

### Page-owner navigation checkpoint, 2026-09-17

- `npm test` passes 745/745; focused navigation/location tests pass 58/58.
  Independent review and main-agent diff inspection found no blocking issue.
- Full live `qa:e2e` passes with no browser errors. Seven installed-provider
  Reader/API samples pass, including four expected missing-resource 404s;
  Pi and OpenClaw are installation smoke records. One initial API connection
  reset was followed by a complete successful retry; the server stayed online.
- Real parent search (196 matches), tool disclosures, exact scroll position and
  opener focus survive related-child opening/closing and Back. Three-level
  native source links reconstruct in a new tab and on reload without duplicate
  IDs. A child scalar completion survives reload, then Back restores the parent
  delivery. Global title/export/management/resume attributes match the root
  pathname; standalone navigation changes all of them to the child.
- Actual 390px checks pass containment and sequential close/focus restoration,
  but the innermost prose is only 270px wide. Ancestor navigation/full-width
  nested reading remain an explicit P6 product gap rather than a passed visual
  criterion. The [page-owner decision](../../.agents/decisions/implemented/2026-09-17-reader-page-owner-location.md)
  records the chosen navigation boundary and native-navigation counterexample.
- A missing browser translation was corrected in both client catalogs and
  tested. Local evidence is in ignored `tmp/reader-owner-*-20260917.log` and
  `tmp/runtime-acceptance-20260917/`; private history is not committed.

### Current validation checkpoint

- The compact-task integrated suite passed 715 tests on 2026-09-17. This count is
  engineering verification, not final acceptance of the selected visual option. Governance/typechecking and
  `git diff --check` pass. Independent navigation review was followed by
  main-agent source inspection and real browser corrections.
- A restarted production build returns matching page/reader fragments and
  valid protocols for an installed sample from each of the seven providers.
  Rechecked on the option-3 production build on 2026-09-17: all seven selected
  samples have no validation errors or warnings. Unknown provider and session requests return 404. This is installed-sample
  coverage, not a claim of current-version feature coverage for each provider.
- The stable Codex case preserves the previous owned-history/attachment hash
  and exact direct/inclusive metrics. The active long-history route and
  selected child complete under a 1 GiB V8 heap limit; see the loading decision.
- Real desktop and 390 px browser checks cover the local child-history link,
  complete child pane, parent DOM preservation, child ToC source selection,
  close after selection, and reopening. There are no duplicate DOM IDs,
  horizontal overflow or browser errors. Close restores the exact original
  3,201 px reading position. The auxiliary overview starts closed.
- Real clicks exposed an encoded-fragment bug in scoped child ToC links;
  IDs now round-trip through URL fragment encoding. Regressions also cover
  stale loads, nested close, ancestor links, no-ID insertion origins,
  Back/Forward, and explicit unavailable-source errors.
- Additional real reading checks reach late owned tool content, all 141 Codex
  retained entries, inherited long-field continuation, the complete DSH
  summary, and distinct repeated follow-up/completion sources. See the
  [completeness evidence](runtime-reader-completeness.md). Copy/reload ownership
  and explicit inline-child search scope have focused regression and real
  navigation checks; the new presentation must preserve them.
- The first `qa:e2e` attempt timed out while opening the all-provider Usage page. An isolated
  measurement attributed about 160 seconds to Codex token aggregation versus
  3 milliseconds to SQLite refresh: oversized parent payloads were repeatedly
  read across children. The grouping correction has passed focused tests and
  independent source review. A subsequent live E2E run passed the all-provider
  Usage, filtering, Reader search and inline-child stages, then failed narrow
  run restoration because the containing Work disclosure stayed closed.
  The final integrated rerun passes, including all-provider Usage and narrow
  Work restoration, with no browser errors. Windows binary build/smoke also
  verifies the embedded Reader styles and local icons.
- The on-demand sidebar opens the canonical child in the main reading column.
  After browser reload, closing it restores both sidebar disclosures, the
  original child link, focus and parent scroll. Desktop light/dark and 320/390px
  checks confirm source jumps, close behavior and no horizontal overflow.
- The real implementation and selected image were compared together at
  1487 × 1058 with both selected-task sidebar and full inline child open.
  The resulting slice includes a compact task map, owned request/reply excerpts,
  folded per-message metadata, 18px prose, explicit inline-child titles and
  readable Library titles. Nine actual tasks, encrypted request text and long
  source paths account for content-dependent differences from the two-task mock.
  The private `design-qa.md` records the comparison iterations and screenshots.
- The selected preview endpoint was checked against each of seven installed
  provider samples: both excerpts are bounded and their source anchors exist in
  the actual Reader. Missing provider/session paths return 404. Lazy loading,
  selection preservation, retry and out-of-order responses have focused tests;
  only selected tasks load excerpts in the real browser. Markdown stays readable.
- English desktop light/dark, English 320px and Chinese 390px light/dark checks
  cover this slice. Chinese validation used a temporary isolated viewer-metadata
  service and real OpenCode data; it did not modify provider files. The 390px
  inline-child title/control check has no full-page horizontal overflow.
  Source jumps, reload/close selection and trigger focus remain correct.
- Independent review found and verified corrections for native nested-panel
  mutual exclusion and per-run recorded states; known unavailable children now
  state that locally. Full-product P1–P12 coverage and user visual acceptance
  remain open in the presentation contract.
- Final publish validation after the child-title and marker-size corrections:
  `npm test` passes 715/715, `npm run pre-push` passes, full live `qa:e2e`
  returns `ok:true` with no browser errors, and Windows `build:binary` plus
  `smoke:binary` passes with embedded assets and five MCP tools verified.
  Local evidence uses the ignored `tmp/reader-compact-publish-*-20260917.log`
  files; the seven-provider check is `tmp/reader-compact-final-api-20260917.log`.
