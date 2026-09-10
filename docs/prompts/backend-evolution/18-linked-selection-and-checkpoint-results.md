# Linked selection and checkpoint results

Status: implemented, 2026-09-11.

## Evidence and user outcome

The visual workbench design requires users to follow recorded work into its
runs, results and context changes without reading a transcript or switching
between inventories. The current client selects task/run/actor entities and
already highlights checkpoints nested under a task's run. Checkpoint inspectors
already link `resultArtifactIds`. Preserve those consumers.

The remaining source-backed gaps are goal-to-task selection, consistent reverse
and actor-scoped linkage, and direct checkpoint result evidence. The current
inspector does not expose a transformation's result version or its recorded
before/after context-size facts. Result content/access must be reachable from
the selected checkpoint rather than only through an unrelated scope inventory.

## Implementation

1. Use existing normalized goal membership, task/run and actor/run evidence to
   link selection on the currently rendered work graph and run page. Preserve
   exact kind/ID identity. Goal selection reaches its recorded tasks and their
   runs; actor selection reaches only its bound runs and their recorded work
   and evidence. Reverse checkpoint/artifact selection reaches its recorded
   run and owning task. Do not broaden a selected actor to other runs merely
   because they share a task, or manufacture links for unbound records.
2. Retain the existing nested checkpoint/artifact visual representation as the
   result destination. Extend the selected checkpoint inspector with recorded
   result version/artifact links, retained summary/content access, before/after
   token facts and provenance. Reuse existing content rendering/access paths.
   Keep unavailable or metadata-only content explicit; source paths alone are
   not readable content. No generic result protocol entity is needed.
3. Assemble any missing display facts in the owning shared server-side view
   projection. Current-page result evidence must remain available beyond the
   initial 100-item overview, including after page replacement. Reuse existing
   page evidence payloads and bounds rather than adding a parallel cache or
   browser-side provider parsing. Keep request usage separate from context size.
4. Keep Work/Conversation navigation, exact child return, completed disclosure,
   keyboard/Escape focus, localization and narrow layout intact. Bound visible
   related controls and explain omitted scope. No new page or default inventory.

## Files and verification

Expected scope: `src/views/runtime-workbench.ts`,
`src/static/app/runtime-workbench.js`, existing locale/style files as needed,
`test/runtime-workbench.test.mjs`, relevant E2E assertions, and the existing
visual-workbench decision/acceptance record. Add a decision only if the shared
view contract changes materially. No provider edits are required for this slice.

- Positive graph fixture: G has T1/T2, A owns R1(T1), an unrelated R2 has no
  task. Selecting G links only its recorded work; selecting A does not acquire
  unrelated tasks/runs. Exact reverse selection and missing bindings stay honest.
- Recorded checkpoint/result fixture: select the checkpoint and inspect its
  resulting version, artifact, summary/access, size and provenance. Distinguish
  full/summary content from metadata-only and unavailable content.
- More than 100 runs with evidence on a later page: selection and result data
  use that page, not an initial-overview record or stale data after replacement.
- Test actual client behavior, not only source-string assertions. Main-agent
  browser verification may use clearly labelled illustrative positive evidence
  when no real run-bound result exists; do not claim such a case is live.
- `npm test`, governance/typecheck, independent review, real Codex/OpenCode/DSH
  APIs/pages, complete E2E and EN/ZH/light/dark/320/768/1280 selection matrix.

The remaining pending-approval question destination is tracked separately;
this slice does not declare the overall redesign complete.

## Delivered implementation

The shared Runtime Workbench now links goal selection through explicit
`taskIds`, actor selection through explicit `runIds` and bound evidence, and
reverse checkpoint/artifact selection through the owning run and task. The
existing nested lane remains the primary visualization. Checkpoint evidence
now carries recorded result-version links plus event-backed before/after token
counts, retained summaries, artifact summaries and content-access facts in the
bounded inspector payload. Run-page responses replace page-scoped
transformations, versions and artifacts together, so later pages remain
inspectable without widening the global inventory.

Verification completed: focused tests (55 passing), combined `npm test`
(559 passing), review/pre-push, real Codex/OpenCode/DSH APIs and OpenCode E2E.
Main-agent illustrative 12-combination selection checks and actual third-page
result interaction passed; see the implemented decision and acceptance record.
