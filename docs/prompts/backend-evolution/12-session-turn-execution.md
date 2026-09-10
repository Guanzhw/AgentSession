# Session turn execution: evidence and implementation gates

Status: shared contract and Codex mapping implemented; shared contract
independently reviewed. Integrated suite passed 528/528 and real OpenCode E2E
passed on 2026-09-10. Run pagination reaches every run through the real API;
active-source pagination continuity and independent mapping review remain open.

## Consumer problem

Codex records session-owned `task_started`, `task_complete`, and
`turn_aborted` lifecycle observations. The existing adapter leaves them out of
Execution because `AgentRun.mode` requires a known execution mode. Recorded
`collaboration_mode_kind: default` does not establish foreground execution.

The shared `AgentRun` already represents one execution of a task or agent and
permits missing task and child-session identities. Its existing `attempt`
field is a positive ordinal, not a second kind of entity. Before introducing
another execution entity, evaluate extending this existing contract.

There is a second consumer boundary: `deriveConversationView()` creates an
agent card for every projected run. Session turns must remain visible in
Execution without becoming detached subagent cards or new ToC entries.

## Proposed contract

Read-only recheck on 2026-09-10 of canonical Codex session
`01a0576a-98e2-7c31-a265-6d98d5fbff12` (all JSONL rows parsed successfully):
55 `task_started`, 52 `task_complete`, one `turn_aborted`; no repeated start
turn ids, two starts without a terminal, no orphan terminals, and every
terminal's `started_at` matches its corresponding start. All starts record
collaboration mode `default`. Crucially, 25 `task_complete` payloads carry an
`error` object with `message` and `codex_error_info`; completion of execution
does not imply success. The abort reason is `interrupted`. These counts
supersede the older audit's counts for this growing session, not its historical
observations. No transcript text is copied into this specification.

1. Express an unrecorded execution mode explicitly. Do not interpret Codex
   collaboration mode, session origin, or a missing child as foreground mode.
2. Give session-turn executions a typed classification that consumers can
   distinguish from existing task/agent executions. Preserve the current
   behavior of unclassified historical runs; missing task/child ids alone must
   not remove existing cards.
3. Preserve canonical session ownership. A turn is not a new provider session,
   task, actor, or coordination edge. Link its existing actor only when the
   owning provider has exact evidence.
4. Carry the recorded turn identity and lifecycle anchors. Run identity must
   remain stable as an active transcript grows. Repeated starts, resumed turns,
   orphan terminals, and interrupted prefixes require source-backed rules;
   do not join them by timestamp proximity.
   Distinguish successful completion from a completed execution carrying an
   error. A missing terminal must not acquire a fabricated end time or success
   status; additional current-source evidence is needed before distinguishing
   actively running from an abandoned open prefix.
   The current `AgentRun.status` reuses `TaskStatus`, which has no unknown
   value. Resolve this execution-state gap explicitly before mapping open
   prefixes; assess a run-specific status extension without weakening Task's
   separate work-state contract.
5. Request usage remains the only additive token source. Turn/thread totals
   must not become additional usage records. Bind request usage to a run only
   when an exact recorded identity identifies one execution; ambiguous or
   missing anchors remain null.

## Delivery order

### A. Shared contract and consumers

Implementation contract for this stage:

- Extend `ExecutionMode` with `unknown`.
- Define `RunStatus = TaskStatus | "unknown"`; Task keeps its existing status
  contract. Unknown run status must not enter the list's active-status chips.
- Add optional `AgentRun.kind: "session-turn"` and `turnId: string | null`.
  Omitted classification preserves existing task/agent run behavior.
- Pass these fields through the bounded Execution projection. Show the turn
  identity, status, mode, recorded times and evidence using both locales.
- Skip explicitly classified session turns when deriving Conversation agent
  cards. Preserve unclassified unplaced runs, task cards, and child links.
- This shared implementation changes no provider mapping. The provider fold
  follows only after its identity and terminal-status evidence is settled.

Inspect the real Codex lifecycle shapes and the DSH turn/step/retry structures
before finalizing the classification and identity rules. Record the decision
against the previous explicitly deferred mapping in
[the Codex audit](../../../.agents/decisions/implemented/2026-09-02-codex-new-format-user-messages-and-v3-audit.md).

Update the shared factory, validator, bounded Execution projection, evidence
inspector, and localized Execution display together. Keep existing v2 facts
stable when adding provider-native v3 runs. Verify the shared v3 validator's
embedded v2 validation and canonical run/event references.

Conversation must suppress only explicitly classified session-turn cards;
task/run cards, unavailable children, and existing unplaced cards keep their
current behavior. Work task progress and subagent/background counts must not
count session turns as tasks or delegated work. All arrays and relations share
the current projection construction budget and retain truncation notices.

### B. Codex provider mapping

Implement the evidence-backed lifecycle fold at the Codex boundary after A.
Preserve original source order and exclude inherited parent records using the
existing provenance boundary. Closed turns retain recorded terminal status;
missing completion is not success. Preserve unknown cancellation reasons and
conflicting evidence explicitly. Avoid pairing a terminal to another attempt
solely because their turn ids repeat.

Implementation boundaries confirmed in the independent source audit:

- `loadCodexProtocolInput()` already filters inherited parent records before
  calling both protocol builders. Reuse that boundary rather than classifying
  inheritance again inside the lifecycle fold.
- Add native turns in `buildCodexSessionProtocolV3()` while preserving the
  finalized v2 facts. Existing task/child runs retain their identities.
- Pair a terminal only with an unambiguous recorded `turn_id` and
  `started_at` match. Use that recorded pair for stable run identity. Leave
  duplicate or conflicting evidence explicit rather than assigning a terminal
  by temporal proximity or inventing an attempt ordinal.
- A matched completion without an error is completed; a recorded error object
  establishes failure. Expose a normalized error category, not its message
  body. A recorded abort is cancelled; retain an unknown reason as unknown.
  An unclosed start has unknown status and no end time.
- Existing request usage carries a turn id but no execution start identity.
  Bind its run reference only when that id identifies exactly one owned run;
  preserve null for ambiguity. Request record identities, cardinality and
  component totals must remain unchanged.
- DSH turn/step/assistant-attempt observations are separate levels. This Codex
  stage must not turn DSH steps or model retries into additional AgentRuns.

### C. Verification and handoff

- Add meaningful regressions for observed complete, interrupted, repeated,
  incomplete, inherited, and unbound lifecycle shapes.
- Test shared upgrade/finalization, run anchors, bounded projections, request
  usage totals, Conversation card preservation, and unchanged ToC entries.
- Run full tests and the repository review/pre-push gates.
- Compare real provider lifecycle counts to the final API on the same source
  revision; record unavailable cases instead of synthesizing live evidence.
- Exercise Execution, Conversation, evidence inspection, and narrow layouts
  through the live browser. Obtain independent review and resolve findings.
- Commit and push a verified implementation with its completed decision.

The existing freeze on OpenClaw and removal of Gemini/Copilot remain in force.

## Runtime-oriented acceptance audit

### Bounded run browsing requirements

Keep the existing Execution overview and shared projection budget. Add a
run-only browsing path rather than making its actors and usage summaries
compete with the complete run list:

- Page the finalized protocol's `agentRuns` in its existing deterministic
  order, 50 per page by default, capped at 100. Do not claim chronological
  sorting or sort the entire session for each request.
- A run page carries canonical session identity, revision, its visible range,
  total run count, previous/next cursors, and public runs with evidence needed
  by the existing drawer. Bind each cursor to canonical session identity,
  direction, exact boundary run ID, and page size; ordinary source revision
  changes read the latest page rather than mixing retained snapshots.
- Use direct array slicing for page construction. Reuse existing cursor and
  HTTP boundary conventions where they fit; introduce no generic query engine.
- Execution offers accessible previous/next controls and a visible range.
  Every recorded run must be reachable, including session turns after many
  child runs. Reuse server-owned run rendering and existing evidence behavior.
  Avoid growing the browser DOM by endlessly appending pages.
- Keep overview request usage, its incomplete/lower-bound labels, Conversation
  cards and ToC unaffected by run pagination. A page total counts runs, not
  tokens or tasks. Keep EN/ZH and narrow-screen controls aligned.
- Verify the real long Codex root can reach all recorded session turns via
  these controls without raising the overview budget; test page traversal,
  stale/cross-session cursors, empty/end pages, escaping and evidence actions.

#### Bounded run browsing implementation

The shared implementation uses this deliberately narrow surface:

- `queryRunPage(protocol, { cursor, limit })` reads the finalized `agentRuns`
  array in its existing deterministic order with direct slicing. Pages default
  to 50 runs and are capped at 100. Each page reports canonical focus,
  protocol revision, one-based visible range, total, page size, and explicit
  previous/next cursors.
- Opaque cursors bind canonical provider/session identity, direction, the
  exact visible-boundary run ID, and page size. Pages read the latest finalized
  snapshot; ordinary revision changes do not invalidate an anchor. A missing
  anchor, malformed cursor, cross-session cursor, or conflicting supplied
  limit returns an explicit `400 invalid_input`; no nearby offset fallback is
  allowed.
- The session page renders the first run page server-side. The run-only route
  `GET /api/:provider/session/:id/runtime/execution/runs?limit=50&cursor=...`
  returns the same server-rendered run section and current-page evidence.
  Browser navigation replaces that section, leaving actors, usage, Work,
  Conversation, and ToC on their existing overview paths.
- Keyboard-accessible previous/next controls show the visible range and
  current snapshot revision, with a permanent Execution refresh link and a
  note that pages show the latest recorded state. A page-level busy state
  prevents concurrent requests.
- Evidence lookup retains overview run evidence and overlays only the visible
  run-page records, so the current page wins when an ID is present in both and
  context and relationship evidence remains intact. English/Chinese labels
  and narrow-screen controls use existing Runtime localization and styles.

Focused verification covers 123 runs across 50/50/23 pages and reverse
traversal, insertion before an anchor, append after an anchor, status changes,
missing-anchor/cross-session/malformed/conflicting-limit rejection, route
payload and HTML parity, current-page evidence, and the unchanged bounded
execution projection. Full suite and live long-session/browser verification
remain the main-agent gate.

The larger refactor is accepted by its user-facing runtime answers, not by
the number of protocol entities or green tests. After this mapping, trace
real multi-agent sessions through their provider facts, projections and UI:

- Can a user identify the work, its executing actors and runs, current or
  last-recorded progress, waiting dependencies, and recorded outputs without
  reconstructing the whole transcript?
- Can asynchronous and repeated child interactions be followed across
  canonical sessions without conflating a session, task, turn and request?
- Do context transformations and scoped assets explain the execution they
  affect, and do usage ownership totals exclude copied inherited history?
- For each missing answer, distinguish absent provider evidence from a
  projection or UI gap. Record a reproducible example and the owning layer.
- Review defensive branches by their actual input boundary and consumers.
  Propose removal only when evidence establishes duplicate normalization,
  unused abstraction, unsupported compatibility, or hidden diagnostics.
  Preserve necessary provider input validation and explicit uncertainty.

Review output should prioritize the few changes that make runtime work
understandable; it must not grow a second speculative architecture. Use Luna
as the default implementation worker and DSH on Windows with `deepseek-flash`
for independent review when available. The main agent owns specifications,
integration and live acceptance. Do not mechanically duplicate a review with
another model.

## Stage A validation snapshot (2026-09-10)

- `npm test`: 517/517 passed, including shared factory/validator, projection,
  Conversation, list statistics and localized SSR regressions.
- `npm run review`: governance and TypeScript checks passed.
- Independent Terra review completed. Its proposed restriction forbidding a
  turn reference on an unclassified run was not adopted: a recorded turn
  anchor does not establish execution kind. Consumers continue to classify
  only by explicit `kind`; the contract adds no turn-reference exclusivity
  without provider evidence requiring it. No other findings were reported.
- `npm run qa:e2e` against rebuilt server on port 3456 and real OpenCode
  session `ses_1ddf03616ffeTE5c6cbpUPMY3n`: passed, browser errors empty.
  Coverage included Conversation/ToC, Work, evidence drawers and narrow layouts.
- This existing-provider check establishes regression coverage, not live
  evidence for the new turn mapping. Codex source/API parity and real turn
  card inspection remain required after Stage B.

## Stage B adapter verification snapshot (2026-09-10)

- Latest compiled Codex v3 focused tests: 23/23 passed.
- Strictly parsed one immutable in-memory read of real canonical session
  `01a0576a-98e2-7c31-a265-6d98d5fbff12`: 175087635 bytes, SHA-256
  `e0cec9862a4c7592b5b4c97e8f0edbed5f30dd422c05f438c0c3eac13c648f74`.
  Its 71 recorded starts produced 71 session-turn runs: 42 completed,
  26 failed, one cancelled and two unknown. V3 validation passed, and
  recorded start times matched the source event timestamps within two seconds.
- Compared the same source read with lifecycle observations disabled in place
  (record positions preserved): all 7362 request usage records were identical
  except `runId`; 2771 requests gained a run binding. No additional usage was
  generated. This directly exercises the compiled provider builder without
  resolved child sessions; it does not substitute for family/API/browser QA.
- Full post-mapping suite: `npm test` passed 523/523.
- Rebuilt live server Execution API for the same canonical session exposed a
  runtime visibility gap: default `maxItems=100` returned 34 actors, 33 runs,
  zero session-turn runs and `truncated=true`; `maxItems=300` returned 68
  actors, 116 runs and 49 session-turn runs, also truncated. Usage was correctly
  marked incomplete in both cases, with no protocol diagnostics. Existing
  child runs precede new turns and consume the default run budget. API
  availability therefore does not yet prove a usable turn inspection path.
  Resolve a bounded browsing/selection path and validate it on the real page;
  merely increasing the default bound is not acceptance.
- The follow-up below resolves the browsing gap; final acceptance is recorded
  in the implemented session-turn decision.

## Active-source browsing acceptance follow-up

The real root API returned 153 unique runs over 50/50/50/3 pages, including
86 session turns. Browser inspection reached page two and opened recorded
turn evidence. Normal full tests passed 528/528 and real OpenCode E2E passed
without browser errors. A 390px visual check found adjacent start/end times;
the small grid layout correction was rebuilt and visually verified.

Continued writes to the same Codex transcript repeatedly invalidated a page
cursor before the next click completed. The explicit refresh is truthful but
does not satisfy active-runtime browsing. The earlier exact-revision cursor
choice therefore needs a bounded follow-up before final acceptance. Assess
continuation across message/usage writes and run status changes; do not assume
all new runs append at the array tail, because child runs precede turn runs.
Preserve canonical identity, bounded construction/memory, visible revision
semantics, and explicit handling when a continuation anchor truly disappears.
Do not retain large historical protocol snapshots merely to mask this problem.

### Implementation contract: live run anchors

Replace the provisional revision/offset cursor with a canonical run anchor:
provider/session, direction (`after` or `before`), exact run ID, and page size.
Each page reads the latest finalized snapshot. Next starts after the last
visible run; previous ends before the first visible run. Locate exact IDs;
never fall back to a nearby offset when an anchor disappears. Missing anchors
require explicit refresh; ordinary revision changes do not.

Return the current revision, current range and total, and visibly explain
that pages reflect latest recorded state. New runs inserted before an anchor
are available through previous/refresh; do not claim a fixed historical
snapshot or exhaustive forward traversal during concurrent mutations.
Keep page size bound to the cursor and reject a conflicting supplied limit.
Use a weakly held ID index per immutable finalized snapshot to avoid a full
run scan on every page request. Do not retain historical protocol snapshots.
Page rendering and evidence remain bounded; when a run is also present in the
older overview, current-page evidence must win for its current-page button.

Regression coverage must include insertion before an anchor, append after an
anchor, status changes, missing anchors, backwards short pages, cross-session
and malformed cursors, conflicting limits, and latest-page evidence. Preserve
the existing Conversation/ToC and overview usage semantics.

Luna completed the read-only investigation and implemented this contract.
DSH independent review remains unavailable: session creation returned HTTP 401
and produced no task handle. An independent Terra review subsequently found
no source defects. Main acceptance passed 530/530 tests, live revision 3-to-4
cursor continuation, four-page browser navigation, 390px visual inspection,
and the real OpenCode E2E suite. See the
[implemented decision](../../../.agents/decisions/implemented/2026-09-10-session-turn-execution.md).

## Remaining runtime acceptance findings

Read-only acceptance review after the 530-test run and live-anchor browser
check identified these remaining boundaries; they are not implementation
completion claims:

- **Execution information hierarchy:** `renderExecutionProjection()` renders
  the actor collection before the run browser. The real 390px Codex page
  exposes many raw `actor:<id>` cards above the run controls. This conflicts
  with UI v2 section 8's instruction to move raw IDs into evidence/details.
  The next UI spec should put executing/recent work ahead of the identity
  inventory and reuse recorded labels when available, without inventing
  actor names or turning unknown status into running.
- **Live inspection scope:** run pagination now reads current records across
  source writes, while Work, actors and request-usage overview still belong to
  the original page load. A subsequent refresh design must make this freshness
  boundary understandable and preserve the selected work/run. Automatic
  polling has not been implemented or accepted by this change.
- **Ownership acceptance:** distinguish removal of duplicated inherited
  request history from exact input/cache origin attribution. The latter still
  lacks provider evidence in the checked snapshots; bounded origin fields and
  null/unknown display do not establish actual direct/inherited/shared values.
  Verify the former independently on real parent/child families rather than
  delaying all deduplication acceptance until origin slices exist.
- **Visual coverage:** this stage's real Codex 390px check and OpenCode E2E
  do not prove the complete UI v2 matrix (320/768/1280, both themes, density,
  keyboard flow and eight scenarios). Preserve that full completion gate.
