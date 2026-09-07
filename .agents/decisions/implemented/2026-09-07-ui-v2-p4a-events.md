---
status: implemented
date: 2026-09-07
decision: Make Events a direct provider-neutral Session Protocol diagnostic surface and keep Work focused on bounded entity evidence.
---

# UI v2 P4a Events diagnostic surface

## Context

The P0 Events tab was only a navigation shell that opened the Work Evidence
lens. That made the top-level tab an extra hop and coupled event inspection to
the Work projection. The finalized protocol already provides bounded events,
source sequence, provenance, and coverage facts needed for a truthful
diagnostic page.

## Decision

Render a separate SSR Events surface from the same typed runtime data used by
Work. It reports purpose, protocol version, completeness, per-domain coverage,
clickable category density, and a bounded source-ordered event table. Event
rows expose recorded/derived text and a bounded event-only Evidence drawer;
raw identifiers remain in Evidence details. Provider-neutral summary facts
(phase, bounded compaction text, and anchor presence) are normalized once for
both SSR and browser rendering. The client initializes each
`data-runtime-events-root` explicitly, keeps current-page evidence bounded
across cursor changes, and keeps filtering/pagination on the existing server
cursor boundary. Density is calculated from the first 1,000 source events and
labels the result as a lower bound when more exist.

Remove the Work Evidence lens and its duplicate event list. Work keeps its
task, goal, actor, run, coordination, relationship, and artifact evidence
actions, while Execution, Coordination, and Context remain Work lenses.

## Alternatives considered

- Keep the shell and jump to Work Evidence: rejected because it obscures the
  diagnostic purpose and creates an unnecessary navigation dependency.
- Keep a second event list inside Work: rejected because it duplicates the
  source and can drift from the direct Events surface.
- Re-sort events by timestamp: rejected because source sequence is the
  recorded ordering; missing or out-of-order timestamps are evidence states,
  not permission to infer chronology.

## Consequences

Events is readable with SSR/no-JS and remains usable at narrow widths through a
stacked table. Missing runtime controls leave the client initializer inert.
Work evidence payloads no longer contain event records, while the Events
payload is bounded to public event facts. Statistics and Settings remain
outside P4a.

## Verification

- `npm test` (442 tests passed)
- `node --test test/runtime-workbench.test.mjs` (29 tests passed)
- `npm run qa:e2e` against OpenCode
  `ses_14dd3a011ffeW1Jlye0HNER7TG` (passed with no browser errors)
- Real browser checks against Codex
  `01a0576a-98e2-7c31-a265-6d98d5fbff12`, DeepSeek Harness
  `session-a9f5b448-9851-4872-a266-fdc3381a5061`, and the OpenCode session
  above at 1280, 768, and 320 px: source-order pagination, category filtering,
  page-101 Evidence, translated domain coverage, light/dark palette, 44 px
  narrow controls, and zero horizontal overflow passed.
- Axe 4.12.1 WCAG A/AA checks reported zero violations for all three real
  Events pages.
- `npm run review`
- `git diff --check`
