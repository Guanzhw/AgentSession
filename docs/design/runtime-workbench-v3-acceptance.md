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
`payload.phase: final_answer`. The source parser currently drops that field
when constructing normalized messages. Therefore final-response evidence is
available at the provider boundary even though the shared Message contract
does not expose it yet. The Conversation slice must preserve this evidence
instead of accepting tool-only folding as the full requested outcome.

## Production gates

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
