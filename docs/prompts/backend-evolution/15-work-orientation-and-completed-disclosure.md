# Work orientation and completed-work disclosure

Status: implementation pending; follows the linked-lane acceptance in spec 14.

## Evidence and outcome

The current `goalTaskGraph()` takes the first nine goal/task nodes in source
order. Completed work can therefore occupy the entire default graph while
ongoing work remains in the inventory. The design calls for current work to
lead and completed branches to remain explicitly expandable.

Use the existing bounded Work projection and normalized states/edges. Keep
source order within state groups. Successful completion may be disclosed;
failure, cancellation and unknown state must remain distinct and visible.

## Scope

- Condense the orientation region around recorded goal/title, session state
  and update time. Preserve the recorded goal versus session distinction and
  existing honest task counts. A request/run count is not goal progress.
- Prioritize non-completed work within the existing graph bound. Provide a
  labelled completed-work disclosure with its recorded count and explicit
  expansion. Do not call unlinked tasks a branch or invent a summary task ID.
- Preserve recorded membership/dependency edges when their endpoints are
  visible. Expanding completed work restores its original identities and
  relationships; hiding it must not imply those edges never existed.
- Keep selected entities reachable: linked selection reveals the relevant
  completed disclosure and restores focus correctly when closed. Redraw
  connectors after disclosure without building an unbounded graph.
- Keep the existing inventory access and omitted-scope notices for work
  outside the graph bound. Expansion is not permission to render all provider
  history or to add protocol fields, provider branches or new dependencies.
- Use existing EN/ZH and light/dark styles. On narrow screens the graph and
  selected-work inspector must remain readable without horizontal scrolling.

## Acceptance

Exercise a bounded graph whose early records are completed and later records
are ongoing, mixed cancellation/failure/unknown states, explicit dependencies,
and missing memberships. Assert visible identities and edges rather than CSS
class names alone. Test expansion, linked selection and keyboard focus in the
browser; inspect real Codex, DSH and OpenCode pages. Run the normal view/runtime
validation matrix and independent review before publishing.

This is the next implementation slice, not a claim that the full design or
provider evidence coverage has already been accepted.
