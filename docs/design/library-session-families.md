# Library session families

Status: implemented and verified, 2026-09-17; overall product visual acceptance remains open.

## Reading job and visual plan

Find an earlier piece of work, reveal its recorded background branches, and
open the exact history without losing the Library search or expansion.
Keep the selected product direction: system UI typography, left-aligned
17px titles, quiet 12–14px secondary text, and no new dashboard.

Use the existing visual tokens: canvas #F6F7F9 / #171B22, surface #FFFFFF /
#202630, ink #202832 / #E7EDF4, muted #586777 / #A6B2C2, divider #D4DCE5 /
#465262 and relation #245BCC / #99BAFF (light / dark). Connectors encode actual
parentage; color alone does not establish identity. Do not add animation.

```text
Main history title                         Recorded update
Project · Provider
▸ 3 related histories
  ├ Implementation                          Open history
  │ ▸ 2 related histories
  ├ Review                                  Open history
  └ Verification                            Open history
```

The branch outline is the one added visual element. Background entries use
compact linked rows, not nested copies of the full session card. On narrow
screens, bounded indentation and wrapping keep titles and controls readable.
Normal title links open the Reader; disclosure controls only expand branches.

## Query and interaction contract

- Families use provider plus canonical session ID and recorded parent ID.
  Missing/hidden parents create independent entries; never connect across a
  missing generation or merge sessions by title.
- Search, project, time, star and subagent filters match individual members
  conjunctively. A family appears when a member matches. Its filtered outline
  keeps the paths to matches and marks non-matching ancestors as context.
- Top-level pagination counts families. Each child disclosure independently
  loads at most 20 direct children; continuation does not flatten nested trees.
- Update sorting uses the latest visible family record without changing the
  main session's own timestamp. Title sorting uses the main effective title.
- A child retains its canonical standalone Reader link and Library return
  path. Returning restores open branches, loaded pages, position and focus;
  changing filters starts a distinct navigation state.
- Existing flat JSON/MCP consumers retain their current shape and semantics.
  Library-specific JSON includes server-rendered HTML and explicit counts.
- The index supplies metadata by default; a provider-owned live metadata
  snapshot keeps OpenCode refresh behavior current without reading messages,
  usage JSON or protocols. Live empty/archived results replace stale index
  entries for this request. Library omits runtime/usage chips; those remain
  available in the Reader and Usage page.
- Manage selects matched records with visible checkboxes, including expanded
  child rows. Ancestors shown only as search context are not batch targets;
  Select all does not newly select records inside collapsed branches.

## Acceptance

Verify a real multi-level Codex family, an OpenCode parent/child, and DSH
recorded-parent metadata. Find a child by title without matching its root;
test custom title, starred child, missing/hidden parent fixtures, filter
conjunctions and family pagination. Expand multiple pages, open a child and
return; switch Timeline/Compact without flattening branches. Check keyboard,
light/dark, 390px, no-match and unavailable providers. See the
[implemented decision](../../.agents/decisions/implemented/2026-09-17-library-session-families.md).

## Recorded verification

- `npm test`: 820/820; full browser E2E passed with no browser errors. Legacy
  list/API statistics remain covered independently of the Library view.
- Seven installed providers passed live Library API/page checks. OpenCode live
  metadata contains 58 roots and 73 descendants; Codex, Hermes and DSH returned
  direct-child pages. Providers without recorded children remain ordinary entries.
  Unavailable providers, custom/starred titles and missing parents use fixtures.
- Real Codex: 118-child family loads 20 then 40 entries; three-level child-only
  title search retains two labeled ancestors and one match. Manage selects only
  that leaf. Independent child reading and the explicit return link restore
  loaded branches, scroll and focus; a separate run restores 60 top-level entries.
  Collapsed branches keep their loaded count and nested state.
- Chromium cleared `activeElement` at pagehide; capturing the clicked departure
  link fixed the observed focus loss and now has an E2E regression check.
  Independent review also caught live OpenCode freshness, unnecessary usage
  aggregation, erased empty states and missing child batch controls; all corrected.
- Desktop and 390px light/dark checked with no page-wide overflow. Keyboard
  disclosure opening and Timeline/Compact preservation passed. Scoped light-theme
  axe reported zero violations, with two existing icon contrast checks incomplete;
  this is not a whole-product accessibility audit.
- Blocking a DSH child request produces a local error; unblocking and retrying
  loads the child and clears it. No-match content remains visible after startup.

Private evidence stays in `tmp/library-families-*` and
`tmp/library-family-*-20260917.*`; provider-owned data was not changed.
