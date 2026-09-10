# Unified runtime workbench acceptance

Status: production acceptance open, 2026-09-10.

The [design](runtime-workbench-v3.md) defines the target. This checklist records
real local cases and remaining evidence; prototype screenshots do not prove
production behavior. Provider source data remains read-only.

## Real cases

| Provider/session | Verified source/API facts | Required UI behavior |
| --- | --- | --- |
| Codex `01a0576a-98e2-7c31-a265-6d98d5fbff12` | Long actively appended root; session-turn and child runs; canonical run-anchor continuation previously passed across revisions | Default unified Workbench; bounded run lanes and next/previous; exact selection survives where still present; distinguish latest run page from initial overview; no fabricated chronology from array order |
| OpenCode `ses_1ddf03616ffeTE5c6cbpUPMY3n` | Existing real E2E session includes tools/reasoning/subagent activity | Preserve Conversation, ToC, exports and search; validate new graph/run/inspector navigation and existing E2E interactions |
| DSH `session-a9f5b448-9851-4872-a266-fdc3381a5061` | Live v3 APIs: 1 goal, 3 tasks, 3 task-to-run relations, 3 runs, 1 actor; goal memberships and actor-to-run relations empty; 3 context artifacts and 3 transformations; coordination not observed | Show unlinked goal/tasks without invented membership edges; exact task/run selection works; do not assign runs to the sole actor; retain context results and provenance without invented run links |
| DSH `session-e675e172-a891-4e87-af33-6d75ea09aa94` | Live work projection has no goals/tasks; execution has no runs and 1 actor | Explicit missing work/execution evidence; no synthetic task, activity, or progress |
| DSH `session-9db4dc74-ede5-46bc-a977-e9bc093cce44` | Catalog reference exists; runtime routes return HTTP 404 `session_not_found` | Preserve unavailable stored-session diagnostics; a catalog reference does not prove readable child content |

Counts are observations at the time of this check, not fixed expectations for
growing sessions. Compare identities and relationships on the current snapshot.
The DSH observations were obtained from the existing local server before the
production UI change; rerun after rebuild/restart.

The same pre-change check returned OpenCode's 44 tasks and 34 task/run
relations, with no goal or actor bindings and 34 coordination observations.
Its execution projection is truncated. The growing Codex root returned one
goal and 70 tasks in a truncated work projection, 29 task/run relations, zero
goal memberships and zero actor/run bindings. Its bounded context projection
contained 41 artifacts and 17 transformations. These cases require useful
unlinked work and task/run visualization; an empty actor-binding graph must
not hide recorded runs.

### Conversation phase evidence

A bounded read of the first 400 assistant `response_item` message records in
the real Codex root found 385 with `payload.phase: commentary` and 15 with
`payload.phase: final_answer`. At the pre-change baseline the parser dropped
that field. The Conversation slice shipped in `9949426` preserves it as
`Message.presentationPhase` and folds process only behind a later recorded
final reply. Providers without this evidence retain their communication.

## Production gates

### Approval destination and combined validation, 2026-09-11

Spec 18/19 combined `npm test` passed 559/559 and `npm run review` passed.
Real Codex, OpenCode and DSH protocol/API checks validated; real OpenCode E2E
passed with empty browser errors. DSH's completed session has an empty pending
approval set; providers without that evidence omit the field.

The source-shaped, explicitly illustrative DSH approval page used the actual
provider builder, v3 finalizer, renderer and event query. Two current asks after
more than 100 events reached their distinct events (sequences 124 and 125),
including the complete escaped reason in the evidence drawer. All 12
EN/ZH × light/dark × 1280/768/320 combinations kept two distinct shortcuts,
folded long reasons and page containment. Keyboard disclosure/activation and
Escape focus return passed; attention axe audits passed in both themes.
Positive pending evidence is fixture-backed, not a live pending request.

The final combined build also confirmed a single retained summary and correctly
labelled result version/sequence/creation facts in the checkpoint inspector.
Actual browser Next/Previous interaction over 121 illustrative runs reached
checkpoints 101/102 on page three with distinct 42/43-token facts, summaries
and version links. Returning to page two removed old checkpoint nodes; browser
errors were empty. Scoped publication remains pending.

### Linked-selection positive slice, 2026-09-11

The illustrative spec 18 browser fixture established the pre-change failures:
goal selection had no linked entities, and the checkpoint inspector had only
identity/time/provenance and run/artifact links. With the implementation build,
all 12 EN/ZH × light/dark × 1280/768/320 combinations passed exact goal and
actor linkage, unrelated-run exclusion, checkpoint result-version/42-token
visibility and page containment. Reverse checkpoint and version selection
reached the recorded run/task. Main-agent desktop and narrow screenshot review
confirmed readable details; browser errors were empty. Duplicate retained text
and a version title incorrectly called a run were identified for correction.

This is a positive fixture-backed interaction slice. Final combined tests,
later-page result/API checks, real-provider regression checks, approval UI and
independent review still remain before the next publication.

### Recorded attention and outcome details, 2026-09-11

Spec 17 adds scoped session/work/current-page waiting and blocked signals,
limited to three labelled work or run shortcuts. Identical run labels retain
their recorded page position. Historical failures and cancellations do not
become unresolved alerts; their normalized outcomes and reasons are visible
in selected task/run details. DSH folds current owned turn/approval events,
so a newer open turn no longer inherits an older completed turn's status.

Main-agent tests passed 553/553. Independent review findings on duplicate
attributes, indistinguishable shortcuts and an unbounded attention inventory
were corrected. Browser axe checks of the attention strip pass both themes
after using the existing semantic text colors. The illustrative positive
fixture passed selection, reason display, Escape/focus and containment at
1280/768/320px in EN/ZH and light/dark. Screenshot inspection caught a missing
locale injection in the temporary QA server; using the production response
helper and rerunning Chinese checks verified translated inspector labels.
This was a fixture harness issue, not a production localization change.

After restart, real DSH/Codex/OpenCode work and run APIs had no diagnostics.
Their sampled work projections had no waiting/blocked tasks; their rendered
pages had no attention signals or narrow overflow. DSH retained its completed
and cancelled runs, and OpenCode retained failed history without inventing
pending work. No real current unmatched DSH approval was available: positive
approval semantics are source-backed fixtures, not a claimed live approval.

The final OpenCode E2E rerun passed after the final build/restart, with no browser
errors; server error logs were empty. `npm run pre-push` passed. A temporary
PowerShell browser-launch pipeline stalled despite its launcher having exited;
the existing responsive browser was retained and the last 12-combination check
completed using direct commands.

The full-goal source audit still identifies required work: complete recorded
goal-to-task selection and verify result/context linkage, expose a selected
checkpoint's resulting content/access, and provide a recorded pending approval
question destination. Task selection already highlights checkpoints nested in
its run, and checkpoint inspectors already link recorded result artifacts;
those mechanisms should be extended only for proven gaps. Connected result
presentation and the full cross-view checklist require verification before
closing the overall goal.

### Child return and recorded run restoration, 2026-09-11

Spec 16 adds viewer-owned parent/run/page return links without changing child
identity. The DSH child round trip passed EN/ZH × light/dark × 1280/768/320px:
exact lane selection, completed-task expansion, narrow inspector visibility,
Escape focus return and page containment. The main agent inspected the narrow
screenshot. Codex child `01a086ca-43f4-7af2-b03c-49a19c4758c0` returned to
runs 51–100, including when opened in a new tab. A deliberately invalid viewer
cursor retained that run ID on recovery; paging to its recorded page restored
selection, paging away closed the inspector with an explicit notice, and paging
back restored the same identity. Provider records were not modified.

Independent review identified stale-refresh identity loss and silent off-page
selection; both corrections were verified. Main-agent live testing corrected
mobile focus moving away from the inspector. New OpenCode narrow E2E exposed
unbreakable revision/coverage labels; allowing those labels to wrap restored
320px containment. Main-agent `npm test` passed 549/549 and `npm run pre-push`
passed. Final OpenCode `npm run qa:e2e` passed with no browser errors, including
the new narrow refresh/selection/containment regression. Both server error logs
were empty. SSR invalid-page recovery
deliberately resets invalid paging parameters to defaults while retaining the
requested run; a valid page return retains its cursor and size.

Recorded attention/outcome details remain a separate pending slice in
[spec 17](../prompts/backend-evolution/17-recorded-attention-and-outcome-details.md).
Positive waiting/blocked fixtures exist, but the sampled real sessions do not
establish outstanding input or approval. Full design acceptance remains open.

### Orientation and completed-work disclosure, 2026-09-11

The primary graph now prioritizes goals and non-completed tasks (up to nine
nodes); a separate closed disclosure exposes up to nine completed tasks with
shown/total and omitted counts. Rendered edges retain their original endpoints
and are excluded from omitted-edge counts. The orientation distinguishes goal
state from recorded session state and session update time.

Main-agent `npm test` passed 548/548. The real DSH page retained its cancelled
task while folding two completed tasks. Selecting a run expanded its exact
completed task; on 320px the inspector remained visible below the fixed header
and Escape restored run focus. A controlled, synthetic browser edge verified
that expansion/collapse redraws the existing SVG as 1/0/1 lines; DSH's absent
goal memberships were not fabricated as live evidence.

The MCP stdio test initially failed during the modern negotiation probe because
it scanned ambient real provider directories before serving MCP. A read-only
diagnostic measured roughly 6.5 seconds of real startup indexing; an isolated
empty-provider probe negotiated in 182ms. The test now explicitly isolates all
provider paths without changing its protocol assertions or timeout. Production
startup still indexes before serving: latency under large real histories remains
a separate recorded follow-up, not a claim that this UI change fixed it.

The final layout passed the DSH EN/ZH × light/dark × 1280/768/320px
matrix: default disclosure, keyboard run selection, automatic expansion,
inspector visibility, Escape focus return and no horizontal overflow. One
browser-session interruption was retried successfully after the parallel E2E
finished. Representative desktop and narrow screenshots were inspected.
The real Codex page showed one goal and five running tasks before the closed
completed group (9 shown of 70), without overflow at 1280px or 320px.
Execution precedes context/inventory in both the source-order regression and
the live DOM. Final OpenCode `npm run qa:e2e` passed with no browser errors;
both server error logs were empty. `npm run pre-push` passed governance and
typechecking. Child-return navigation remains the next slice in spec 16.

### Linked execution evidence, 2026-09-11

The lane slice adds bounded recorded/task labels, recorded intervals, exact
coordination markers and run-bound context/result selection. Initial SSR and
replacement pages keep separate page evidence, ahead of preserved scope
evidence. Metadata-only artifacts explicitly distinguish metadata from content.

Main-agent validation: `npm test` passed 547/547; real OpenCode E2E passed with
empty browser errors; independent review and governance/typecheck passed.
The real Codex root's spawn marker selected its exact child run and reverse
selection highlighted five correctly bound markers. Next-page browsing reached
ranges 51–100 and 101–150 of the then-recorded 183 runs. These counts are a
snapshot, not fixed provider expectations.

The real DSH three-run page passed all 12 EN/ZH, dark/light, 1280/768/320px
combinations for run selection, complete recorded times, no overflow and Escape
focus return. Representative desktop and narrow screenshots were inspected;
narrow inspector scroll clearance was corrected from the observed fixed-header
overlap. Its three compactions have no recorded run binding and correctly stay
outside the lanes. Positive run-bound checkpoint/result rendering is covered
by fixtures; this real DSH case does not establish that positive provider case.

Completed-work disclosure and compact orientation remain the next slice in
[spec 15](../prompts/backend-evolution/15-work-orientation-and-completed-disclosure.md).
This lane delivery does not mark the overall visual redesign complete.

### First production pass, 2026-09-11

The integrated Workbench plus phase-boundary preparation passed `npm test`
(539/539) before the Conversation disclosure consumer. The rebuilt local server
was restarted and the real DSH three-task case opened in a named browser.
Selecting a task highlighted its exact recorded run and did not link the sole
unbound actor. Browser errors were empty and desktop page overflow was absent.

Visual acceptance remains open: the first screen is dominated by repeated goal
text; graph labels are clipped; task inventories duplicate the work surface.
Opening the inspector also exposed a real stacking failure: graph nodes cover
its matching-events link and prevent a normal pointer click. These observations
were returned to the UI worker; passing render assertions does not close them.

### Conversation and interaction follow-up, 2026-09-11

The complete compiled test suite passed 542/542 after correcting the new SSR
fixture to use the real part `type` contract. Independent review identified
and the implementation corrected two defects: a final response must not fold
later unfinished communication, and anchors/search must open ancestor process
disclosures. The initial hash path also scrolls after disclosure expansion.

On the real long Codex root, the browser found 90 process disclosures, all
closed by default. Opening a recorded message hash inside one disclosure opened
that disclosure and located the message at approximately 80px from the viewport
top, with Conversation visible and no page overflow. This verifies initial-hash
reveal on real data; the full language/theme/narrow matrix remains open.

A real DSH task selection highlighted its bound run; its matching-events link
opened Events with a visible clearable linked filter. The earlier Events drawer
failure was a viewport-edge click miss, not a broken event handler. QA now
scrolls the evidence button into view before clicking. Workbench layout remains
open: long goal text still stretches node cards and the inspector overlaps the
graph area in the current build.

The real OpenCode `npm run qa:e2e` pass subsequently completed with `ok: true`
and an empty browser-error report, including Events evidence opening after
scrolling its trigger into view. Independent Workbench review still found an
uncovered paging defect: actor bindings for arbitrary pages were taken from a
100-item overview. It also found missing inspector Escape/focus restoration.
These are open requirements despite the E2E pass and are being corrected with
targeted coverage.

### Verified integration slice

The latest full suite passed 545/545, including both beyond-overview API and
initial SSR actor-binding regressions. A failing actor-name assertion revealed
and fixed the missing normalized `Actor.name` label consumer. After the final
CSS and Escape propagation corrections, 52 Workbench/route tests and the real
OpenCode E2E suite passed with no browser errors.

Browser geometry identified the remaining overlap as an intrinsic-width grid
inside the main column; container-sized tracks now keep the graph separate
from the inspector. Desktop 1280px and narrow 320px DSH selection were inspected.
On 320px, selection reveals the independent inspector panel; Escape closes it
and restores focus to the task trigger without page overflow. Chinese 768px
dark and 320px light inspector screenshots were inspected. These observations
are a tested integration slice, not completion of the full matrix below.

The integration slice was pushed as `9949426`. Linux Quality run
[34508799824](https://github.com/Guanzhw/AgentSession/actions/runs/34508799824)
passed on both Node 22.15.0 and 26.5.0. The remaining visual work includes
recorded run-time segments, linked coordination/context checkpoints, and
completed-branch disclosure; actor-grouped generic rows alone do not close
those requirements.

For `9949426`, the real three-task DSH page passed all 12 combinations of
EN/ZH, dark/light, and 1280/768/320px. Each combination used pointer selection
and Escape, checked exact linked-run highlighting, inspector visibility,
focus return, page overflow, and desktop graph/inspector geometry. Browser
errors were empty. Screenshots were saved for all combinations; representative
desktop, medium and narrow screenshots in both languages/themes were inspected.
This validates the integration slice's layout/selection matrix, not the still
pending time-segment/checkpoint visualization.

The pre-UI Quality run for `f985f4a`
([34494488516](https://github.com/Guanzhw/AgentSession/actions/runs/34494488516))
failed on Linux: DSH rejected Windows source-host cwd paths, and the minimum
Node 22.15 runtime could not create the OpenClaw fixture's FTS5 tables.
These are separate from the local 530-test pass. Repair and rerun the real CI
gate; neither local success nor a fixture-only workaround proves remote success.
The user authorized necessary OpenClaw maintenance on 2026-09-10; the current
repair is limited to fixture dependencies, not provider feature expansion.

The scoped fix shipped in `67d0949`; the subsequent Linux Quality run
[34496587172](https://github.com/Guanzhw/AgentSession/actions/runs/34496587172)
passed on Node 22.15.0 and 26.5.0. This restores the baseline gate; production
UI and Conversation changes still require their own acceptance below.

- [ ] Workbench and Conversation are the only primary reading modes; History
      remains secondary and existing `#tab-events` access works.
- [ ] Workbench has linked readable work nodes and execution lanes, not four
      nested lenses or repeated raw entity inventories.
- [ ] Task/run/actor selection uses exact normalized IDs in both directions;
      missing bindings remain unlinked. Selection details occupy space only
      when open.
- [ ] Current run page remains bounded (default 50, maximum 100); replacement
      uses current-page evidence and preserves truthful snapshot/range labels.
- [ ] Existing `runtimeLens=execution|coordination|context|work` links reach the
      corresponding content without introducing a new public query contract.
- [ ] Context checkpoints show recorded resulting content/size; scope assets
      retain explicit content access and provenance. Unknown token origin does
      not become zero usage or a fabricated allocation.
- [ ] Conversation highlights real user input and agent communication; internal
      calls disclose under evidence-backed exchanges. Questions, results,
      inherited-context boundaries and ToC/search anchors remain reachable.
- [ ] 320/768/1280px, EN/ZH, light/dark: readable connected branches and lanes,
      no page overflow, no compressed graph labels. Keyboard selection,
      inspector close/focus return, paging and cross-view navigation work.
- [ ] Full tests, governance/typecheck, real provider/API checks, browser E2E,
      server/browser error inspection and independent review pass.
- [ ] Scoped commits pushed; remote SHA verified. Overall goal is not complete
      until the full design, including Conversation disclosure, is accepted.
