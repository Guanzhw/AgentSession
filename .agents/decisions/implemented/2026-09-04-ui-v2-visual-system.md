---
status: implemented
date: 2026-09-04
decision: Adopt a calm, evidence-dense visual system and screenshot-based gates
  for the UI v2 P1-P4 implementation, proven by the P1 Library stage.
---

# UI v2 visual system

- Status: implemented
- Date: 2026-09-04
- Scope: shared visual language and responsive acceptance for UI v2 P1-P4
- Design: `docs/design/ui-v2-visual-system.md`

## Context

The P0 information skeleton established Library / Statistics / Settings and
Work / Conversation / Events, but intentionally retained most existing visual
rules. The remaining stages need one shared visual contract before page-level
implementation; otherwise Library, threaded Conversation, Work graphs, and
Events can each accumulate a different hierarchy and another set of local CSS
values.

## Decision

Adopt the semantic palette, restrained type scale, spacing rhythm, responsive
shell, component hierarchy, and screenshot gates in
`docs/design/ui-v2-visual-system.md`. Treat AgentSession as a calm,
evidence-dense work viewer: narrative and structure lead, while protocol detail
is reached through explicit evidence controls.

The contract is provider-neutral. It changes neither provider-owned evidence nor
Session Protocol projections. Context assets remain optional and scope-aware.
Work shows only the current context result and aggregate asset entry point;
compact checkpoints remain causal Conversation entries and complete Events
evidence. Repeated inherited/shared context is excluded from the Conversation
ToC.

## Alternatives considered

- Retain the P0 styling and redesign each page independently: rejected because
  it would preserve the current contrast debt and create page-local tokens and
  hierarchy rules.
- Make the graph the dominant visual metaphor everywhere: rejected because
  Library, Conversation, Events, and narrow screens need different reading
  structures; graphs are used only when relationships materially help.
- Adopt a branded provider palette for each session: rejected because provider
  identity is metadata and should not destabilize status meaning or contrast.

## Evidence

- The current UI v2 information design identifies equal-weight cards, linear
  conversation, repeated compact evidence, and raw relationship rows as the
  primary comprehension problems.
- The P0 browser matrix demonstrated that 320 px can remain overflow-free, while
  the dense metadata, lens controls, and nested Runtime Workbench still need a
  unified hierarchy and contrast pass.
- The tracked exploratory Work composition validates a 176 px rail, editorial
  goal and progress hierarchy, bounded graph/context pairing, and a stacked
  narrow-screen fallback without adding new data semantics.

## Consequences

P1 through P4 are reviewed against rendered 1280, 768, and 320 px screenshots in
both themes as well as behavioral E2E checks. Semantic tokens replace ad hoc
component colors as each surface is touched. P1 Library implemented the shared
palette, type hierarchy, rail, responsive rhythm, and focus/contrast rules
without changing provider evidence or later detail-page markup.

## Verification

- Governance and Markdown link validation passed through `npm run review`.
- The tracked reference composition is rendered and visually inspected at
  desktop and 320 px. Its mobile layout must have zero horizontal overflow and
  render the collaboration graph as a readable relationship list.
- A read-only Pi review checked consistency with `docs/design/ui-v2.md`,
  provider/protocol boundaries, accessibility, and P1-P4 browser gates; its two
  high-priority contradictions and four implementation gaps were resolved before
  P1 began.
- P1 was rendered against the real seven-provider local index at 1280, 768, and
  320 px in both themes. The 320 px page had equal `scrollWidth` and
  `clientWidth`; axe WCAG A/AA scans reported zero violations in light and dark.
- Keyboard and state checks covered `/` search focus, Tab order through search
  and chips, `j`/`k` row navigation, compact-view reload persistence, and filter
  URL back/forward behavior.
