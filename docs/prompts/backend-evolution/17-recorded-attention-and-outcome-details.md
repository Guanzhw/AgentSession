# Recorded attention and outcome details

Status: implemented, 2026-09-11; scoped browser and real-provider acceptance
is recorded in the unified workbench acceptance document. No live unmatched
DSH approval was available; the overall approval-content destination remains open.

## Evidence

The visual design requires attention signals and pending input to remain visible.
The current orientation shows state badges but no attention destination; the
selection inspector omits normalized task/run failure and cancellation reasons.
The shared protocol already records session/task/run `waiting_input` and
`blocked`, goal `blocked`, and task/run `failureReason`, `cancellationReason`
and `outcome`. Use these current entity facts before extending any contract.

Positive fixtures exist in `test/runtime-workbench.test.mjs` (waiting session),
`test/session-list-stats.test.mjs` (blocked run), and `test/codex-v3.test.mjs`
(failed turn with `usage_limit_exceeded`, separately cancelled turn).
The DSH goal fixture in `test/deepseek-harness-protocol-v3.test.mjs` has a
blocked goal, but its reason remains provider-private event data.

On 2026-09-11, the real Codex acceptance root had unknown session state,
an active goal and running tasks; the real DSH case had a cancelled task.
Neither establishes a positive pending-input or unresolved-failure case.

## Outcome

- Make recorded waiting/blocked state discoverable in the compact orientation
  and on the exact work node/run. Link to existing selection and evidence,
  preserving the graph/lanes as the primary surface rather than adding another
  default inventory or page.
- Keep signal scope honest: session state, current work projection and current
  run page represent different scopes and may be incomplete. Reuse existing
  projection bounds and scope labels; do not report a whole-session zero from
  one page or count related task/run records as separate incidents.
- Show normalized outcome/failure/cancellation reasons in selected details.
  A failed historical attempt does not itself prove that the session still
  needs action. Cancellation remains distinct and is not automatically an alert.
- Preserve genuine pending questions/approvals in Conversation. Inspect the
  owning provider lifecycle before claiming a generic outstanding approval:
  historical requested/started observations and an approval policy do not prove
  current pending state. If current normalized evidence cannot express it,
  record the specific missing lifecycle and address it at that owning boundary;
  do not parse provider fields in the browser or quietly declare full acceptance.
- No synthetic retry-resolution rules, text keyword guessing, provider-ID
  branches in the shared view, or new entities solely for display.

The implementation keeps the existing work visualization primary. A compact
orientation attention strip exposes only normalized session/work
`waiting_input` and `blocked` records and offers at most three exact,
entity-labelled goal/task selection links; the remaining bounded work stays
available through highlighted nodes and an explicit truncation note. A
run-page attention strip follows the same small limit using only the current
bounded run page and exact run selections; it does not reuse the whole-session
run projection. Each attention signal has one
`data-runtime-attention-state` hook, while graph nodes and run rows retain the
same state as visual emphasis through their own bounded hooks.

The selection inspector now renders recorded task/run `outcome`,
`failureReason`, and `cancellationReason` values. Missing values stay absent;
failed or cancelled history is not promoted to a pending attention signal.

## Verification

Use the existing positive fixtures for exact waiting/blocked selection and
recorded reason rendering. Include successful retry/history and cancellation
cases to verify they do not imply unresolved action. Check that changing a run
page changes only the page-scoped attention signals, while session/work
signals retain their own scope. Check unknown state and incomplete projections,
EN/ZH, keyboard and narrow layouts. The local regression tests cover scoped
selection and inspector field wiring; the parent acceptance audit owns the
real-provider and browser checks. Use a clearly identified illustrative
browser fixture if real positive evidence is unavailable; retain that real-case
limitation in the final acceptance audit. Run the affected view/runtime
validation matrix and independent review.
