---
status: implemented
date: 2026-09-10
decision: Render optional long-lived context artifacts in a bounded metadata-first Context inspector grouped by protocol scope, without changing protocol or provider mappings.
---

# UI v2 P7: scoped long-lived context assets

## Context

Session Protocol v3 already distinguishes `memory`, `experience`, and
`user-info` artifacts from `summary`, `instruction`, `skill`, and `rule`, and
records five explicit scopes plus provenance, access state, metadata summaries,
and source relationships. The Context projection already exposes those facts
under one global bound. The current UI flattens every artifact into one short
row, so users cannot inspect long-lived assets by scope.

The 2026-09-10 live API sample does not justify new provider mappings: the
long Codex session `01a0576a-98e2-7c31-a265-6d98d5fbff12` exposes bounded
session-scoped compaction summaries, two sampled DSH sessions expose the same
summary shape, and sampled Claude Code, Pi, and OpenCode sessions expose no
artifacts. OpenClaw is frozen by user direction and is outside this change.

## Decision

Add one collapsed “Memory & experience” inspector within the shared Context
lens. It consumes only projected artifacts whose recorded kind is `memory`,
`experience`, or `user-info`, groups them in protocol scope order, and renders
recorded metadata and relationships. Other artifact kinds remain in the
general Context artifact list, so each artifact appears once and compact
summaries never become memory by presentation.

“Appears once” applies within the Runtime Context lens. The existing
Conversation inspector remains a separate top-level inspection surface and
continues to expose its scoped context evidence.

An empty inspector reports only that the current bounded view contains no such
artifacts. It does not claim provider support or absence outside a truncated
projection. The protocol, projection, provider adapters, token accounting, and
canonical identities remain unchanged.

## Alternatives considered

- Group every artifact under “Memory & experience.” Rejected because compact
  summaries and instructions are different context facts.
- Hide the inspector when empty. Rejected because optional provider support
  would be undiscoverable and an empty array would remain ambiguous.
- Add provider-specific memory parsing now. Rejected because current real
  samples provide no evidence for a common mapping and the protocol already
  supplies the generic optional boundary.

## Consequences

Providers that eventually record long-lived artifacts gain the UI without a
central provider branch. Current providers degrade honestly. The section stays
bounded, metadata-first, localized, and responsive; evidence drawers retain
the detailed protocol facts.

## Verification

- Implemented in `src/views/runtime-workbench.ts`, `src/static/style.css`,
  `src/locales/en.ts`, `src/locales/zh.ts`, and
  `test/runtime-workbench.test.mjs`.
- `npm run typecheck` and the final `npm test` pass (506/506). The complete
  Runtime Workbench suite passes 41/41 and the post-review focused P7/Context
  check passes 3/3.
- The inspector consumes only projected long-lived kinds and recorded
  artifact relations; no provider, protocol, projection, fixture, token, or
  OpenClaw files were changed.
- Independent review found that relation-less long-lived assets initially lost
  direct access to their own evidence. Every card now retains an artifact
  evidence trigger, covered by the focused regression test. The separate
  Conversation inspector is intentionally outside the Runtime Context
  one-time-rendering boundary.
- Live Context API checks recorded 36 bounded `summary/session` artifacts for
  Codex and 3 for DSH, with no long-lived artifact inferred from either.
  Browser checks covered Codex at 1280/768/320 pixels in dark and light themes,
  DSH at 1280 pixels, and Chinese at 1280 pixels. The inspector remained
  collapsed by default, its expanded bounded-empty message appeared once, and
  the tested pages had no horizontal document overflow.
- `npm run qa:e2e` completed with `ok: true` and no browser errors on an
  unchanged retry after the first run reached the existing narrow-Library
  initialization race before batch mode was active. `npm run pre-push` and
  `git diff --check` pass.
- Independent Luna review has no remaining actionable findings after the
  direct artifact-evidence fix and scope clarification.
