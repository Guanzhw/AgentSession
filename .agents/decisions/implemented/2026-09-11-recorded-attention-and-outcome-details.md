---
status: implemented
date: 2026-09-11
decision: Render recorded attention by projection scope and expose normalized run outcomes in the inspector
---

## Context

The Runtime Workbench already normalizes `waiting_input` and `blocked`
session, goal, task, and run states, plus task/run outcome and reason fields.
Its orientation showed state badges but offered no destination, and the
selection inspector omitted the normalized outcome details. A whole-session
attention count would be misleading because work and run projections are
bounded and a run page is only one page of the source-ordered records.

## Decision

Keep the graph and execution lanes as the primary visualization. Add a compact
orientation signal for recorded session/work attention and a separate
run-page signal built only from the current `RunPage`. Show at most three
entity-labelled exact links per scope; an explicit truncation note directs
users to the highlighted bounded nodes/rows for the rest. Each goal, task, or
run signal reuses the existing exact entity-selection button and carries
bounded scope/kind/id data hooks. Only `waiting_input` and `blocked` are
attention states; failed and cancelled history remains visible as its recorded
status.
Render task/run `outcome`, `failureReason`, and `cancellationReason` in the
selection inspector when the normalized value is present.

## Alternatives considered

- A global incident count: rejected because projection bounds and run paging
  cannot support a whole-session count without inventing completeness.
- A new attention entity or provider-specific status logic: rejected because
  the existing normalized protocol facts and selection hooks are sufficient.
- Treating every failure or cancellation as pending action: rejected because a
  historical attempt does not establish unresolved work.

## Consequences

Users can discover recorded waits and blocks from the compact orientation and
select exact goal/task/run entries with readable labels. Scope labels make
session, bounded work, and current run-page evidence distinct. The visual graph
and lanes remain the source of relationships; attention markup does not create
a second entity inventory. Missing outcome/reason values remain missing, and
provider-owned approval lifecycle interpretation stays outside the shared
view.

## Verification

- `npm run typecheck`
- `npm run build`
- focused Runtime Workbench tests for session/work scope, current run-page
  scope, exclusion of failed/cancelled attention, and inspector field wiring
- Main-agent `npm test`: 553/553; `npm run pre-push` passed.
- Real OpenCode `npm run qa:e2e` passed after the final build/restart; browser
  errors and server error logs were empty.
- Illustrative positive cases passed EN/ZH, light/dark and 320/768/1280px
  selection/containment checks. Outcome/reason, Escape/focus and semantic
  color checks are recorded in the unified workbench acceptance document.
- Real Codex, OpenCode and DSH sampled pages preserved their recorded states
  without false waiting signals. Positive pending approval coverage remains
  source-backed fixtures because no real unmatched approval was available.
