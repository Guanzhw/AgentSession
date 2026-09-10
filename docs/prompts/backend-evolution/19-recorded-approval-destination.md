# Recorded approval question destination

Status: implemented and locally validated, 2026-09-11.

## Evidence

At official DSH source commit `b2e3b2a0125854567a4a5fcba75782e42fe84901`,
`packages/interaction/user-approval/src/types.ts` defines `approval/asked`
as a log-only audit event with `id`, `toolName`, optional `callId` and `reason`.
`approval/decided` supplies the same ID and an outcome. These are not surface
messages. The package invariant supports multiple unmatched asks in an open
turn. The existing provider-owned status fold already uses this lifecycle.

The current projection preserves event kind/correlation but drops the readable
approval facts. `publicEvent()` deliberately excludes providerData. Initial
event pages are bounded, so simply opening Events cannot reliably reach a
current ask near the end of a long session.

## Chosen boundary

Add a small typed optional approval detail on `SessionEventEnvelope`, and
optional current `pendingApprovalEventIds` on `SessionDescriptor`. Use canonical
event IDs, not another request/task identity. The event detail contains the
recorded asked/decided state, tool name, optional tool-call ID, reason and outcome;
keep recorded outcome vocabulary without guessing a permission decision.
Current refs are provider-derived snapshot facts. Omitted refs mean the provider
does not supply current approval evidence; an explicitly empty list means its
owned lifecycle currently has no unmatched ask.
Any non-empty current set must agree with `waiting_input`, and each referenced
asked event must retain a non-empty correlation ID for exact Events routing.

DSH owns the current open-turn ask-minus-decided fold. Reuse that single fold
for status and current refs; retain `dshSessionStatus` for existing consumers.
Use owned events, so inherited seed history does not become new approval work.
Keep event details in both readable protocol generations and explicitly expose
them in `publicEvent()`. Validate the new fields/references at the protocol
boundary, not repeatedly in downstream UI code. Preserve missing optional
fields. Do not synthesize conversation messages or parse providerData in shared
rendering/browser code.

## UI destination

From current waiting evidence, show bounded readable approval shortcuts and
their recorded tool/reason, with an exact event/correlation evidence destination.
Reuse Workbench attention and the existing Events detail/filter mechanisms;
do not add a page, permission action, polling loop or duplicate task inventory.
The selected current ask must remain reachable beyond the initial event page.
Clearly distinguish historical decisions from current requests. AgentSession
only displays source records; approvals are answered in the owning harness.

## Delivery split

The provider/protocol worker owns only the shared protocol contract/finalizer,
DSH parser/protocol builder, public event projection and associated tests/docs.
It must not edit Runtime Workbench, browser, locale or stylesheet files while
spec 18 is being implemented. Main agent integrates the UI destination after
that worker releases the affected files. Only one owner runs builds at a time.

## Acceptance

- Source-backed asked/decided payloads retain readable facts and correlation;
  current unmatched asks survive a prior completed turn, decided asks disappear
  from current refs, and terminal history remains terminal. Preserve existing
  inherited ownership coverage. Do not add impossible post-turn ask fixtures.
- Protocol validation and public event routes preserve exact references and
  truthful omission versus empty current evidence. No provider-name branches.
- More than 100 historical events before the current ask: its shortcut reaches
  the exact current question, not the initial page or a same-kind older request.
- Multiple pending requests remain distinguishable; historical failure,
  cancellation and resolved approvals are not promoted to pending questions.
- Real provider negative checks plus clearly labelled illustrative positive
  browser checks where no real current approval exists; keyboard, EN/ZH,
  themes/narrow layout, full test/E2E, independent review and scoped publishing.

This implements the design's question discoverability without presenting audit
events as chat messages. Overall completion still requires the full workbench
acceptance checklist.

## UI implementation delivered

The Workbench now reads only validated v3 `session.pendingApprovalEventIds`,
resolves those canonical event IDs, and shows at most three compact approval
shortcuts with the recorded tool, call ID and reason. Long reasons remain
available behind a disclosure. Each shortcut reuses the existing Events tab
and correlation filter, so current asks beyond the initial event page remain
reachable without creating messages or a new API. The Events drawer renders
typed approval state, tool, call, reason and outcome while historical decided
events remain ordinary audit evidence.

UI regression coverage includes more than 100 historical events before two
current asks, distinct shortcut IDs/correlation hooks, version-inspector
labels, and duplicate checkpoint retained-summary suppression. Protocol and
provider changes remain owned by the parallel worker; build and live browser
acceptance remain with the main agent.
