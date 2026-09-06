---
status: implemented
date: 2026-09-06
decision: Implement the UI v2 P3a Work opening as a provider-neutral bounded
  narrative over finalized Session Protocol v3 and the existing Work,
  Execution, and Context projections, while retaining legacy Work Graph
  evidence below the opening for the P3b migration.
---

# UI v2 P3a: Work overview

- Status: implemented
- Date: 2026-09-06
- Scope: goal narrative, bounded task progress, current context result,
  aggregate context-asset counts, task table, responsive layout, and guarded
  browser assertions
- Blueprint: `docs/design/ui-v2.md` §4.4 and
  `docs/design/ui-v2-visual-system.md` §4.2

## Context

The Work tab opened directly on domain-first Work Graph records, which made
goals, tasks, and raw relations the primary reading surface. The finalized v3
snapshot and existing bounded projections already contain the facts needed for
a result-oriented opening, but no provider-neutral view model assembled them
into a narrative.

## Decision

- Derive the opening in `src/work-view-model.ts` from finalized v3 facts and
  the bounded Work/Execution/Context projections only. Preserve source order,
  use recorded goal text and exact task/run states, and keep missing evidence
  explicit.
- Render the primary recorded goal or a truthful no-recorded-goal state, then a
  bounded completed/total progress ratio and sentence. A completed sentence is
  emitted only when the goal status is recorded as completed and work evidence
  is complete and not truncated.
- Render one current context result from the latest bounded transformation or
  version, following recorded context-version parent ancestry before comparing
  sequence or timestamps, with causal result-version links included. If
  candidates cannot be ordered, keep the result conservative and say so.
  Resulting token size is shown only when recorded by context-
  compaction evidence; retained summaries are bounded in the opening and
  fully available through explicit details. Memory, experience, and user-info
  counts include only observed kinds and disclose lower-bound status when the
  context projection is partial or truncated.
- Render the first five task rows with human title/path fallback, owner,
  separate task/run states, elapsed or last activity, and Evidence actions.
  Additional rows use native disclosure; bounded projections carry an explicit
  omission notice.
- Keep all five existing Work Graph lenses available in a collapsed legacy
  evidence disclosure below the overview. P3b remains responsible for the
  bounded goal-to-task and collaboration graph switch and removal of old raw
  relation rows.

## Alternatives considered

- Rendering the new narrative in browser code: rejected; normalized facts and
  provenance must remain server-side and SSR must be complete.
- Treating every visible completed task as a completed goal: rejected; active,
  unknown, or truncated goal evidence must remain visible.
- Reusing the context checkpoint timeline as the Work result panel: rejected;
  checkpoint causality belongs to Conversation and Events, while Work shows
  only the latest recorded result.

## Consequences

- Work opens with a readable result summary while existing graph lenses remain
  reachable for evidence during P3a.
- A bounded projection can show a visible ratio without claiming a complete
  task set; missing token sizes, summaries, kinds, and scopes remain omitted.
- The Conversation inspector has a stable entry point from current context.

## Verification

- `npm test` (429 tests)
- `node --test test/runtime-workbench.test.mjs` (16 tests)
- `npm run qa:e2e` against real OpenCode session
  `ses_14dd3a011ffeW1Jlye0HNER7TG`
- Real Codex session `01a0576a-98e2-7c31-a265-6d98d5fbff12`: bounded
  long goal, latest compacted result selected through recorded ancestry, five
  visible tasks plus 13 disclosed tasks, no overflow at 1280px or 320px, and
  zero WCAG A/AA violations
- Real DSH session `session-a9f5b448-9851-4872-a266-fdc3381a5061`:
  explicit missing goal/context states, 2/3 progress, and no overflow at
  1280px or 320px
- `npm run review`
- `npm run pre-push`
- `git diff --check`

P3b remains: replace the legacy evidence disclosure with bounded goal-task and
agent-collaboration graph views and remove the old raw relation presentation.
