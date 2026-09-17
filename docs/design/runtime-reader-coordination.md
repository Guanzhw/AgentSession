# Reader coordination: Stage 3C

Status: implementation specification, updated 2026-09-17. Follows
[reader completeness](runtime-reader-completeness.md).
Current presentation choices follow the
[product presentation specification](runtime-presentation-contract.md).
This document retains the exact-source and coordination semantics.

## Concrete reading case

The real Codex case contains two recorded follow-up calls to the same child.
Each canonical tool call already owns a readable normalized tool message.
A reader must be able to select either observation and read that
exact tool body, while the child remains one navigable history.

The child also records two distinct terminal lifecycle events. They prove
child-turn completion, not delivery of a result to its parent. Their normalized
event IDs remain those of the child protocol. Their completion times are
14:43:53 and 14:47:55 UTC on 2026-09-10. The raw record arrival timestamps
include additional milliseconds. Display the normalized clock's meaning;
do not present arrival time as result-delivery time.

The exact child dispatch at 14:07:08.214 UTC precedes a later main-agent turn
starting at 14:21:49 UTC, while the child's first completion is at 14:43:53 UTC.
This establishes work continuing across a parent execution boundary. The later
parent turn has no corresponding owned user-input message; its start and end
are reached through their own normalized lifecycle events.

## Source-owned extension

Reuse the existing Session Protocol, coordination observations, conversation
cards and reader source controls. No additional transcript store or graph is
needed.

1. Give recorded collaboration tool events optional normalized `messageId`
   and `toolCallId` source bindings on `SessionEventEnvelope`. A coordination
   observation's local `eventId` references that real event. Providers own
   these bindings; shared rendering never parses native call IDs or tool names.
2. Represent an observed child-turn completion separately from result delivery.
   A typed cross-session source-event reference preserves the child owner.
   Use the child's existing lifecycle event builder and owned-record selection
   so its ID is identical when opened through the child protocol. Copied parent
   records must not become additional child completions.
3. Carry assigned observations, including dispatch and follow-up, into the
   reader channel with their original IDs and source references. Resolve
   readable anchors at the server using normalized message/part identities and
   the existing anchor helper. Reuse an existing exactly bound event before
   introducing another event for the same source. A lifecycle event without a
   readable message opens its recorded event evidence with an explicit label.
4. Main-agent runtime boundaries use normalized lifecycle events bound to
   this session's `session-turn` runs, with their own recorded times and exact
   source-event links. The real orchestration case crosses execution turns
   without another user input. A user message is a separate recorded source,
   not a prerequisite or inferred anchor for an automatic execution turn.

Keep session-local `eventId` validation. Validate a cross-session reference's
shape and canonical owner at the protocol boundary, without claiming that an
external source event was loaded or is available. Existing unknown and missing
source behavior remains visible.

The existing Events API is v2-only, while the demonstrated child lifecycle
events belong to v3; embedded Workbench evidence is also bounded. Add one narrow
reader event-source response that resolves an exact ID in the owning validated
v3 snapshot and returns a bounded, server-rendered scalar evidence fragment.
Use the canonical child reader and a stable event anchor. Do not send all events
or silently replace a missing event with a generic Work link. Readable tool and
message sources continue to use their existing native history anchors.

## Reading and density

The selected option-3 sidebar uses a compact canonical task map and an
expandable exchange sequence. The secondary recorded-time diagram retains
separately focusable observation marks alongside main-agent execution-turn
boundaries. Their source controls make continued child work across automatic
parent turns inspectable. Readable user inputs retain their own message
anchors; no synthetic request is introduced.
Child-history controls open full child content; observation controls open their
own sources. These actions have different labels and targets.

At narrow rail widths, provide an expandable larger timeline for dense tracks.
Accessible labels include observation kind, recorded time and source action.
Use a compact detail sequence when the marks cannot communicate individual
events; retain the diagram as the overview. Untimed observations have a
separate labeled group. Display-time ordering is a derived presentation order,
not a claim of cross-session source order or causality. Do not draw inferred
follow-up-to-completion pairing arrows.

The exchange sequence is sorted after canonical assignment: recorded time
ascending, equal times in stable source order, then untimed records in source
order. Its expanded body explains that ordering, and untimed records are
explicitly labeled. This derives a Reader display order only; protocol arrays
and their source identities remain unchanged. Ordinary-message folding cannot
cross the timed/untimed boundary. Card state and latest activity use the
complete assigned collection, not the first 50 displayed records.

Keep one child reader and ToC item even when several observations or runs
refer to it. Secondary metadata must not displace its body history.

## Bounds and continuation

The existing channel limit of 50 and upstream projection budget cannot define
the complete record. A reader continuation must select from the finalized
coordination collection using the same exact run/task assignment as the
initial channel, not only from an already truncated projection.

Build the assignment universe once from all finalized non-session-turn runs,
tasks without runs, and recorded actor/run bindings. Both the visible cards and
their pages use its assignment keys. An explicit run selects that run; a
task-only record selects a task card; actor-only records select a card only
when the combined sender/recipient candidates are unique. Display truncation
must not change that decision, and HTTP input must not supply actor ownership.

Use a bounded reader page with canonical provider/session, run/task filter,
observation anchor and page size in cursor identity. Reuse the existing
run-page cursor convention where applicable; keep this a concrete reader
consumer rather than a general pagination framework. Return server-rendered
source controls and an explicit next-page path. Preserve existing runtime
coordination API response semantics.

The initial More control carries the same cursor as a fetched first page,
anchored after the last displayed observation. A 53-record channel therefore
returns records 51–53 on its first More request. A missing cursor anchor is a
refresh state rather than an offset into a changed collection. The cursor also
contains a fixed-size SHA-256 digest and count of the displayed cumulative
`(id, timestamp)` prefix from its anchor. If new source evidence inserts into
or changes that prefix, continuation returns `stale_cursor`; ordinary suffix
appends can continue. SSR and continuation use the same digest construction.

Appending a page must stay within the owning reader, preserve existing source
IDs and navigation, and never reset the reader's history position. Stale or
invalid continuation is an explicit refresh/retry state. A count of omitted
observations alone does not satisfy the bound.

## Acceptance

- Both real follow-up controls resolve to the exact existing readable tool
  bodies through the canonical anchor helper.
- Both child terminal events remain distinct, use the actual child event IDs,
  and are labeled completion rather than delivered results. Actual recorded
  result-delivery observations keep their separate meaning and have their own
  exact source control. A scalar envelope record does not stand in for the
  child's readable reply.
- One child history/ToC item remains; source jumps and Back preserve the
  previously read DOM, scroll, focus, search and expanded bodies.
- More than 50 assigned observations and an upstream-truncated projection
  retain usable reader continuation. Untimed and ambiguous-target cases do not
  gain invented sources or duration.
- Verify dense/wide/narrow layouts, both themes and keyboard source selection.
- Protocol, route, model and render tests pass; real API/browser reading and
  independent review precede product acceptance.

## Integration checkpoint

Direct built-handler checks of the real Codex case locate both follow-ups at
actual native tool anchors. Two child completions resolve to their canonical
child lifecycle events, and 20 parent result deliveries have exact recorded
event-evidence sources. The current parser does not expose those delivery
envelopes as message bodies; child history remains the route to its available
reply content. These checks do not claim browser interaction acceptance.

The native tool renderer previously retained punctuation while source lookup
and ToC normalized it. The shared `src/views/anchors.ts` policy now owns all
three consumers, with punctuation and duplicate-anchor regressions.

The main-agent execution lane is implemented using existing normalized
`session-turn` run and event bindings. A real-data check preserves all 11
boundaries from six parent runs even with one-item inspection projections,
and resolves both source controls for the exact later orchestration turn.
Its child-dispatch/parent-turn-start/child-completion ordering is independently
checked against the original normalized evidence. No user anchor is fabricated.

The option-3 integration passed governance/type checks and targeted independent
source review. Labels retain exact UTC source times.
The on-demand task sidebar groups consecutive ordinary messages while keeping
each dispatch, follow-up, return and child completion independently reachable.
Real desktop and 320/390px checks cover source jumps and same-pane child-history
return; reload-close restores the canonical sidebar opener and its ancestors.
The full site E2E suite passed with no browser errors. Compact task overview
and readable intent/result excerpts subsequently shipped in `7ceeafe`.

The current product-wide evidence and remaining gaps are tracked in
[the acceptance record](runtime-acceptance-evidence.md); these earlier checks
do not cover every navigation path or constitute overall product acceptance.

## Recorded-time ordering verification, 2026-09-17

The real selected task now reads: follow-up at 14:24:30.543, child completion
at 14:43:53.000, parent delivery at 14:43:57.012, follow-up at 14:44:37.045,
child completion at 14:47:55.000, parent delivery at 14:48:41.299 UTC.
Each of these six controls was activated in the browser and resolved to its
own source. Follow-ups focus their native tool bodies; completions and parent
deliveries focus separately owned event evidence. API pagination returned all
21 observations through 11 two-item pages without loss or duplication.

The expanded sequence was inspected at desktop and actual 390px widths;
keyboard source activation and focus worked, with no full-page horizontal
overflow. This check also identified the separate P10 source-navigation owner
mismatch. The subsequent root-owned inline navigation correction now verifies
an unmounted child completion, reload and Back to the exact parent delivery;
standalone navigation changes the entire page owner. See the
[navigation decision](../../.agents/decisions/implemented/2026-09-17-reader-page-owner-location.md).

Verification: 720/720 full tests, 35/35 focused tests, independent review,
governance/typecheck, the full live E2E suite without browser errors, and
Windows SEA build/smoke. Seven installed-provider Reader/API samples passed;
the OpenClaw sample is the installed smoke transcript, not production work
history. No provider-owned data was modified.
