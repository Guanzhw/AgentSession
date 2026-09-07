---
status: implemented
date: 2026-09-07
decision: Align Statistics and Settings with the shared UI v2 visual hierarchy while preserving their existing data and interaction contracts.
---

# UI v2 P4b: Statistics and Settings alignment

## Context

The P4b visual pass covers the existing Statistics and Settings surfaces. Both
pages already have working provider capability gates, filters, exports,
lazy-loaded sections, settings persistence, and browser hooks. Their markup and
CSS still presented Statistics as a card-heavy dashboard and Settings as a
two-column form with repeated project-path help, which diverged from the Work
surface's section rhythm and made narrow layouts harder to scan.

## Decision

Keep the existing data, route, capability, export, lazy-loading, and
`settings-form.js` contracts. Update only the server-rendered composition and
source CSS: Statistics now reads as header/purpose → filters/actions → summary
→ primary trend → supporting views, with explicit chart units and textual
summaries. Settings keeps configuration/launch facts compact and renders its
editable groups in one labeled column, associates help with controls, and
retains progressive disclosure for advanced JSON. Reuse the existing UI v2
tokens, rail, header, and focus rules.

## Alternatives considered

- Rework Statistics aggregation or Settings persistence to make the visual
  hierarchy easier to express; rejected because those are established
  provider/config ownership boundaries with existing consumers.
- Add a new component stylesheet or dependency; rejected because the repository
  already has shared UI v2 tokens and server-rendered CSS.
- Hide advanced Statistics or Settings controls on narrow screens; rejected
  because existing capability and progressive-loading behavior must remain
  reachable.

## Consequences

The pages share Work's quieter surfaces, spacing, typography, and responsive
behavior without changing their URLs or data semantics. Statistics remains
fully drillable and exportable, and Settings retains immediate-save behavior,
startup-only facts, and advanced JSON. The added section wrappers and
accessibility descriptions are stable SSR hooks for browser QA; the old local
class hooks remain available to existing browser code.

## Verification

- `npm run build` (passed).
- Focused SSR tests in `test/core.test.mjs` for Statistics reading order/chart
  explanation and Settings single-column/help association (18/18 passed).
- `npm test` (444/444 passed).
- `npm run qa:e2e` against the real OpenCode store (passed, including section
  order, chart unit and summary, single-column Settings, and zero browser
  errors).
- Real-browser screenshots at 1280, 768, and 320 px covered dark and light
  themes, long Windows paths, 44 px mobile actions, and zero horizontal page
  overflow. The independent review found the appended desktop save-bar rule
  overriding the existing mobile flow; the final `max-width: 760px` rule keeps
  the save bar static and the 320 px re-check confirmed that it no longer
  obscures Resume controls.
- axe-core 4.12.1 WCAG A/AA audits on Statistics and Settings (zero
  violations).
- `npm run review` (governance and TypeScript passed).
- `git diff --check` (passed).
