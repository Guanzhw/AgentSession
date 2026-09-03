---
status: implemented
date: 2026-09-03
decision: Implement the UI v2 P0 information skeleton with a primary rail and
three session-detail projections while preserving the existing provider and
Session Protocol boundaries.
---

# UI v2 P0 information skeleton

- Status: implemented
- Date: 2026-09-03
- Scope: primary navigation and session-detail information hierarchy
- Blueprint: `docs/design/ui-v2.md`, P0 in
  `docs/prompts/frontend-implementation/01-p0-information-skeleton.md`

## Context

The prior layout used a topbar with provider utility links and four detail
projections (Work Graph, Conversation, Overview, Raw). The UI v2 P0 brief calls
for a three-item information hierarchy while preserving the existing routes,
SSR output, and provider-neutral runtime projections.

## Decision

Use a server-rendered primary rail with Library, Statistics, and Settings links and
keyboard shortcuts `1`–`3`. Keep the existing route and provider adapter
boundaries unchanged. Session details expose exactly three top-level tabs:
Work (default), Conversation, and Events. Work contains the existing five-lens
Work Graph surface; Events is a truthful shell that focuses the recorded
Evidence lens instead of manufacturing a second event projection.

The detail header keeps provider, project, start time, file changes, resume,
star, export, search, back, and neighbor actions in one shared hierarchy. A
missing project or resume command is rendered as an explicit empty state. List
cards always show the provider and keep protocol signals (compaction,
subagents, artifacts) in one bounded signal row; unknown evidence is omitted,
not rendered as zero.

## Alternatives considered

- Keep the four old top-level tabs: rejected because it exposes implementation
  projections rather than the P0 Work / Conversation / Events hierarchy.
- Build a second event renderer: rejected because the current Runtime Evidence
  projection is the only evidenced event surface and duplicating it would drift.
- Load highlight.js from a CDN: rejected because the P0 offline requirement
  needs a repository-local, license-tracked asset.

Browser code highlighting is loaded from the repository-vendored
`@highlightjs/cdn-assets` 11.12.0 bundle. `README.md` beside the bundle records
the package tarball integrity, upstream URL, and BSD 3-Clause license.

## Evidence and boundaries

The current Work Graph renderer and normalized Session Protocol remain the only
sources for Work and Evidence content. The Events shell uses the typed
`runtimeAvailable` route evidence and existing runtime evidence control; it has
no provider-specific interpretation. SSR contains all content and browser
JavaScript only handles tab/shortcut interaction. Provider databases and
transcripts remain read-only. OpenCode's real local schema marks
`summary_additions`, `summary_deletions`, and `summary_files` nullable with no
default, so an explicit NULL is preserved as missing evidence while an
explicit zero remains a recorded zero.

## Consequences

The old Overview and Raw tabs no longer appear as top-level navigation; their
useful metrics remain in the Work surface and exports remain visible in the
header. JavaScript owns only tab, focus, and keyboard interactions. Deep links
select the containing top-level tab before interaction. Work and Events reclaim
the conversation-only ToC grid column. The current Events shell intentionally
has no independent event pagination until a later UI stage proves a separate
event consumer.

## Verification

- Focused regressions: primary rail, three-tab default, typed Events
  availability, deep-link/tab source checks, detail evidence boundaries, local
  vendor paths, nullable OpenCode file counts, and editable-target shortcut
  guards in `test/core.test.mjs` and `test/runtime-workbench.test.mjs`.
- `npm test`: 377 passed, 0 failed; `npm run review` (governance and
  typecheck): passed; `git diff --check`: passed.
- `npm run qa:e2e` passed against the real local server and OpenCode session
  `ses_1ddf03616ffeTE5c6cbpUPMY3n`; it covered rail links, editable shortcut
  protection, Work-to-Conversation search, Conversation/Events deep links,
  ToC boundaries, Runtime Evidence, and browser errors (none), using the
  existing three viewport and light/dark matrix.
- Node v26.5.1 SEA build and `node scripts/smoke-sea.mjs` passed with embedded
  Highlight.js assets and the five MCP tools (`embeddedAssets: true`); the
  smoke harness reserves an OS-selected loopback port to avoid collisions with
  unrelated local services.
- Manual browser checks against the real local server and OpenCode session
  containing tool calls, with no browser errors, additionally
  covered 320/768/1280px layouts, light/dark themes, English UI, rail keyboard
  shortcuts, editable search input protection, and Events-to-Evidence focus.
- A WCAG A/AA browser audit at 320px confirmed the new rail, detail metadata,
  file-change values, and top-level tabs no longer appear in the contrast
  violation set. The remaining reported contrast nodes belong to the existing
  nested Runtime Workbench and are input to the visual-design stage.
- The vendored Highlight.js bundle is version 11.12.0 with integrity and BSD
  3-Clause provenance recorded in its adjacent README and license file.
