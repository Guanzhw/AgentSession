---
status: implemented
date: 2026-09-07
decision: Raise observed narrow-screen primary interaction targets to the UI v2 44px touch contract with shared CSS and an accessible card-checkbox hit-area label.
---

# UI v2 P4c mobile touch target finish

- Status: implemented
- Date: 2026-09-07
- Scope: shared mobile CSS plus the session-card checkbox hit-area markup; no
  protocol, provider, or data changes

## Context

The P4c finish audit reproduced narrow-screen interaction defects in the
existing UI v2 surfaces. The shared mobile rules had observed interactive
controls below the documented 44px touch target, and the transcript search
navigation could extend beyond its fixed panel at 320px.

## Decision

At viewports up to 380px, primary navigation, session actions, tabs, filters,
evidence controls, density controls, and library card actions use a minimum
44px block size. Icon-only controls and the batch-select label also use a 44px
inline target. Batch card checkboxes keep their native 18px visual size inside
an explicit 44px label hit area, and the library's real batch-mode selector
keeps content clear of that area. The transcript search panel uses a
single-column mobile layout so its input and navigation stay contained.

## Alternatives considered

- Add JavaScript hit-area wrappers: rejected because a semantic label around
  the existing checkbox gives the same keyboard and pointer target without
  changing browser checkbox rendering.
- Change desktop dimensions: rejected because the evidence was limited to the
  narrow mobile breakpoint and desktop composition already met its contract.

## Consequences

Narrow primary controls have a consistent 44px target while the existing 320px
single-column layout remains intact. The batch management bar wraps on narrow
screens so the larger controls do not create horizontal overflow.

## Evidence

Real agent-browser checks against the local server at 320px found visible
controls below the UI v2 touch contract and reproduced the fixed search-panel
overflow: rail links were 40px, theme 32px, session actions 34px, detail tabs
38px, library density buttons 28px, star buttons 32px, and menu triggers 26px.
After the change, the Library batch label measured 71.31x44px, the native
checkbox 18x18px, its hit area 44x44px, and the session title entry 154x44px;
each card checkbox also exposes a localized accessible name from its session title;
the transcript input and navigation measured 274x44px inside a 296px panel,
with all three 44px buttons contained. Statistics provider items measured at
least 44px high. Those checks had no document horizontal overflow, no browser
errors, and zero axe WCAG 2A/2AA violations.

## Verification

`npm run build` passed. `npm test` passed 444/444, including SSR and CSS
assertions for the checkbox structure, native size, batch selector, and
44px controls. `npm run qa:e2e` passed against the real OpenCode session
`ses_14dd3a011ffeW1Jlye0HNER7TG`, including its new 320px Library batch and
transcript-search containment checks. `npm run review` and `git diff --check`
passed.

The live matrix recorded here is the English UI at 320px with dark theme and
reduced-motion, covering Library, OpenCode detail Work/Conversation/Events,
Statistics provider filters, and Events evidence/pagination. Other locale,
theme, and viewport combinations are not claimed by this record.
