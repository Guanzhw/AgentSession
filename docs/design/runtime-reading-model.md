# Agent work history reader: product presentation roadmap

Current scope, confirmed by the user on 2026-09-20: desktop use. Preserve the
responsive improvements recorded below, but do not add narrow-screen work or
acceptance checks. The [presentation contract](runtime-presentation-contract.md)
owns the current completion criteria; older narrow-screen evidence is historical.

Product clarification, 2026-09-20: the Web UI serves people revisiting complete
conversations. Keep requests, replies and meaningful turning points readable by
default; progressively reveal the full work behind them. Explain assignments,
team collaboration, repeated exchanges, and asynchronous/background work from
launch or separation through return and follow-up. Evidence is an engineering
quality requirement, not the product's primary navigation or vocabulary. The
MCP retains its separate machine-oriented interface. The
[product direction](runtime-presentation-contract.md#当前产品方向) owns the
requirements and P13/P14 acceptance scenarios. On 2026-09-20 the user removed
the automatic long-term goal. The [delivery plan](runtime-delivery-plan.md) now
owns the finite stages, current status, visible handoffs and next action.

Status: historical roadmap; current execution follows the delivery plan above.
The [product presentation contract](runtime-presentation-contract.md) is the
current specification for what to show and how to read it; the
[visual direction](runtime-visual-direction.md) records reference research and
the next design pass. This roadmap retains the delivery history.
The graph-first prototype was rejected for losing conversation history.
Presentation feedback updated 2026-09-16: the subsequent inline-lane design
also did not satisfy the user visually. Product acceptance remains open.
The user subsequently approved implementing the prose-first/local-insert
direction for a first real-page review ("先做出来我看看"). This authorizes that
implementation; final visual and reading acceptance still require the result.
On 2026-09-17 the user selected visual option 3: top navigation, continuous
history, and an on-demand Tasks & collaboration side panel. The selected
composition and its source image are recorded in the visual direction above;
implementation and real-page acceptance are now the next gate.

## Product outcome

AgentSession is an agent work history reader: complete recorded content is the
material, runtime relationships organize it, and continuous reading is the
default experience. A reader can follow the conversation, understand who did
which work and when, and trace the results without assembling the story from
raw logs. The user confirmed this positioning and delegated staged delivery.

The previous Work/Conversation implementation passed engineering checks but
did not meet that product outcome. A subsequent graph-first prototype improved
the execution overview while removing the complete conversation; the user
rejected it for that reason. See the
[previous acceptance record](runtime-workbench-v3-acceptance.md).

## Composition

The user's 2026-09-16 refinement asks for visible asynchronous relationships,
such as connecting dispatch and later delivery at their recorded positions.
The first [inline implementation](runtime-inline-relations.md) preserves those
anchors, but its presentation was rejected. Connecting existing event rows is
not sufficient product acceptance. The sidebar overview remains secondary.

The next candidate gives prose the primary visual hierarchy and uses local
collaboration inserts for dispatch, follow-up and return. Intermediate tool
activity is grouped behind an execution disclosure; branch records open near
their source without replacing the parent history. A small interactive sketch
uses illustrative records to compare local connections and lighter backlinks.
The illustrative sketch established the direction; the user has now requested
a working first version. Production implementation uses real normalized records,
keeps full history accessible and replaces the graph-dominant treatment with
these local inserts. Final acceptance will use the actual reading page.

One primary reading surface retains the full user/agent history. User inputs
and agent replies are readable by default; intermediate execution can be
collapsed without discarding its messages, tool inputs/outputs or reasoning.
Classification follows recorded/normalized provider evidence. When a provider
does not distinguish final replies from intermediate messages, preserve those
messages rather than guessing from their prose.

Runtime relationships appear alongside that history and at their recorded
anchors. Dispatches open adjacent branches, returns reconnect them, and later
follow-up continues the same recorded branch across parent turns. A compact
relationship view explains parallel and continuing work while the conversation
remains the main reading area. Text reading order and execution relationships
are two coordinated representations of the same evidence.

Each branch presents its recorded purpose, latest result and state. Selecting
it opens its own complete available conversation, including expandable
execution detail, with the main reading position preserved on return. Event
metadata is secondary to readable source content. A task and its child session
are one navigable work item, not two near-identical ToC nodes. Separate
executions remain distinct when recorded identity differs, even if names match.

Compact and memory changes appear where supported by recorded relations and
show resulting content. Inherited background remains separately collapsed.
The raw transcript and event browser are secondary evidence destinations.

## Evidence and ownership

- Reuse normalized provider/protocol facts and canonical references. Add a
  shared read projection only for an observed UI consumer, after the prototype
  is accepted. No new protocol version is implied by this design.
- Display the recorded user request as a request when no structured goal is
  present. Do not invent a goal or lead with an empty goal panel.
- Label editorial excerpts as excerpts; do not silently generate summaries or
  reconstruct opaque message payloads. Unknown relations remain unconnected.
- A last recorded run state is not a live process-health claim. Task counts
  are not objective-completion percentages.
- Keep raw identity, protocol version, token details and missing-field
  diagnostics out of the default narrative unless they change a user decision.
- ToC, branch selection and deep links must share the same canonical UI
  target. Preserve existing evidence anchors through an explicit mapping.
- Keep the work track's identity separate from an event's source identity:
  a root-owned return event and a child-local result message are different
  records. Their recorded relationship does not decrypt the return payload.
- Bounded rendering/loading must retain a route to every available record.
  A record limit needs continuation and visible coverage, not silent loss.

## Staged delivery

| Stage | Deliverable and exit evidence | State |
| --- | --- | --- |
| 1. Complete reading model | Real-history prototype; all available text in its declared case window is reachable; default replies, expandable execution, child reading and continuous branches work together | Reading checks passed 2026-09-14; subsequent inline presentation rejected 2026-09-16; revised design and real-history acceptance open |
| 2. Production vertical slice | One real session reads end to end in the official UI with unified navigation, search/anchors and child inspect/return; tests, API checks and browser reading pass | Prose-first production preview and desktop/narrow inline reading verified. Large-session page/source/child/metrics checks pass the 1 GiB gate. Scoped search and canonical reload/back checks pass; final integrated QA and the new visual redesign remain open. Detailed evidence belongs in the slice/completeness records |
| 3. Coverage and replacement | Long histories with continuation, asynchronous cross-turn work, context checkpoints and inherited-background isolation; current provider capabilities verified; superseded UI paths removed | Seven-provider source identity checks pass for 2,667 fields. Real browser checks reach late owned tool content, all 141 Codex retained entries, the complete DSH summary, inherited continuation and distinct repeated coordination sources. Codex grouped usage loading is verified locally; broader coverage remains open |
| 4. Delivery acceptance | Independent review, full affected-surface validation, current documentation, scoped commits/pushes and final successful CI with remote SHA alignment | Queued |

Each stage has its own acceptance gate. Independent source work may proceed
while an earlier live check awaits service reload; this does not pass that
gate or authorize publishing unverified behavior. The main agent owns
specifications, integration and real
reading checks; independent Luna workers implement bounded changes. Terra
reviews non-trivial stage changes. Small corrections join the next relevant
review rather than starting a separate review cycle.

The user has delegated organization and staged execution. Continue routine
engineering autonomously; surface changed product choices, unavailable source
evidence that changes the experience, or new authority requirements. Show
material milestones for product feedback. The previous prototype's browser
checks do not constitute approval of its presentation.

Use the existing provider/runtime boundary and introduce only projections with
a demonstrated reader consumer. Preserve unrelated dirty work. Publish each
verified coherent stage under the existing commit/push authorization; private
real-case artifacts stay ignored. Stop for a genuine blocking choice or unsafe
scope change, not merely because a worker takes time.

### Current implementation evidence

The [Stage 3 completeness specification](runtime-reader-completeness.md)
records the confirmed search, checkpoint-result and repeated-interaction gaps.
On 2026-09-14, targeted browser checks of the rebuilt static controller on the
previous SSR verified that returning restores the parent query, focus and
exact scroll position (1,300 px), and a canceled delayed child request neither
replaces the returned pane nor leaves a stale loading status. These checks
cover navigation state only; current SSR layout acceptance still needs reload.

The earlier direct-handler checks established complete source equality for
retained plaintext separately from encrypted fields and image attachment
metadata. A shared source-part identity mismatch discovered in the Claude
reader was corrected and the seven-provider, 2,667-field comparison passed.
The [completeness record](runtime-reader-completeness.md) now also records
real-browser continuation, search, inherited-background and context-result
checks on the restarted production preview. The
[coordination contract](runtime-reader-coordination.md) distinguishes readable
follow-ups, child completion and recorded result delivery; these source links
have been exercised individually in the browser.

The production reader now lazily opens one canonical child pane. The earlier
recursive child-body path has been removed; parent tool bodies remain readable.
An empty compact summary does not imply empty retained history: the real Codex
checkpoint separately exposes its replacement and guardian groups.

### Product acceptance tasks

Use the official reader with real records to demonstrate these complete paths:

1. Read a request and its reply, then expand any intervening recorded execution
   without losing their relationship or reading position.
2. Recognize concurrent work, open a child's full history, and return to the
   exact parent position with search and disclosures preserved.
3. Select two follow-ups to the same child and reach their different source
   bodies; inspect child completion separately from parent result delivery.
4. Open a compact checkpoint and read its available result through the end.
   Inherited background stays separately accessible.
5. Search content beyond the initial rendered excerpt and reach the exact
   owning field, including after a child switch and a narrow-screen return.

These paths, both locales/themes and the recorded provider capability gaps
define presentation acceptance. Test counts support that acceptance rather
than replacing it.

The next visual check must also demonstrate a quiet default reading state:
complete user inputs and replies remain visible, routine execution does not
become a stack of peer-level cards, and the relationship view helps identify a
branch and its returns without a competing permanent panel. Opening a branch
or execution disclosure must still reveal its complete available records.

### Long-history loading gate

The real long-session check on 2026-09-16 exposed full-family construction
 behind a visually collapsed reader. The [payload-loading decision](../../.agents/decisions/implemented/2026-09-16-bounded-transcript-payload-cache.md)
records the measured I/O and heap failures. This loading work is independent of
the currently open visual choice.

The reader's initial work must follow its reading scope. The selected session
retains complete owned messages and exact part IDs. Child entry points require
canonical identity and recorded relationships; child bodies can load when the
reader opens that branch. Existing child reply excerpts and token information
must remain obtainable through their disclosures, not become fabricated empty
values. Inclusive Work metrics must retain their family-wide meaning.

Three callers currently reach the legacy full-family tree and need coordinated
verification: reader preparation, the normal detail page's metrics panel, and
the source-event route's anchor-renderability check. Fixing only one caller
does not prove that opening the normal page is bounded. The legacy structured
tree/export interfaces keep their existing complete-family semantics.

Acceptance must use the real large parent and its child set: open the page,
follow an exact event source, open a child's complete history, then expand
inclusive metrics. Compare content and source identities, not only elapsed
time or reduced memory. Preserve a path to every available record.

### History prototype reading evidence

The ignored `tmp/runtime-reading-prototype/history-reader.html` replaces the
earlier graph-only experiment. It is a private, bounded fixture, not the
production rendering pipeline. The current main-agent reading checks establish:

- All 16 owned root dialog bodies and all 222 readable root tool details are
  present. The implementation child has 12 owned dialog bodies and 282 tool
  details, with none missing from the rendered detail bodies.
- The three children have 12 / 6 / 4 owned dialog bodies. Raw-record counts
  are 13 / 7 / 5 because each also contains one inherited user record. The
  default reader and its counts/search keep that inherited content separate.
- Markdown tables, lists, links and emphasis use the existing safe renderer.
  Searching a phrase in intermediate prose opens its disclosure. Searching
  actual tool-input text finds tool-body records, not merely tool names.
- Opening the implementation child, switching to another child, then returning
  restores the root scroll position, focused branch and original search.
- The compact checkpoint exposes 141 retained history entries, with readable
  fields available and omitted encryption identified. Its source time is
  22:28:11.974 Asia/Shanghai, between the neighboring execution groups.
- A shared time-axis diagram shows the three recorded branch spans, their
  overlap and the parent-turn boundary. Timed controls preserve distinct
  dispatch/follow-up/return records.
- Desktop light/dark and narrow reading checks cover 1280/768/320 widths,
  including expanded context content and narrow-to-wide navigation restoration.
  Initial folded-width checks alone had missed clipped context content; the
  corrected expanded content stays within its reading column.

These are engineering/reading checks, not a claim of user approval or whole-
session coverage. The full-session production experience and broader provider
acceptance remain the subsequent stages.

### First production slice

Use `getSessionDocument`, the existing progressive-content endpoint and
normalized runtime relationships. The observed full-family loading failure
requires a provider-owned owned-reader projection; its complete root and
lightweight child descriptors are documented in the
[production slice](runtime-reader-slice.md). No new protocol version is needed.

The default route opens the main reading history with local collaboration
inserts. The shared-time-axis overview is a secondary, initially collapsed
disclosure. Selecting a child inserts its complete owned history at that
reading position, preserving the mounted parent and its disclosure, search,
scroll and focused origin. Search explicitly selects the root or a mounted
child; merely opening a child does not change that selection. Inherited
background has its own disclosure. Every canonical child has one body/anchor
owner; later interactions reference that owner rather than cloning its DOM.

Retain existing source anchors and export/resume actions. Convert Work and
Events entry points into secondary inspection destinations while replacing
the two-primary-tab layout. Existing deep links must still resolve to the
corresponding reading or evidence target. Missing runtime evidence leaves
the available history readable rather than producing an empty dashboard.

Exit this slice only after a real main/child case can be read, searched,
expanded and returned from in the official app. Long-history pagination and
broader provider evidence are the next stage, not reasons to introduce a
second transcript store during this slice.

## Reading tests

Without coaching, the reader can:

1. Read earlier and later complete user/agent messages and find a known phrase
   from the middle of a long message, not just its preview.
2. Expand an intermediate execution and inspect its recorded tools/reasoning
   without losing the surrounding reply or moving to an unrelated page.
3. Identify parallel work and follow repeated interactions on the same branch
   across parent turns.
4. Open a child, read its own available history and return to the same parent
   position with one unambiguous navigation target.
5. Read a recorded context-change result, inspect its source and distinguish
   inherited background from work performed by the child.
6. Reach older records through continuation and understand the scope of search
   and any unavailable source content.

Missing context evidence is an explicit unavailable case, not a fabricated
demonstration. Complete reading and readable runtime relationships must pass
together; neither a linear dump nor an execution-only summary satisfies them.

Engineering checks verify escaping, identity, bounds, usage ownership,
keyboard/focus, narrow layouts and source read-only behavior. They do not
substitute for these reading tests or user product feedback.

## Historical first prototype

The bounded real case contains one implementation child, two follow-ups to
that same child, two returns, and overlapping teaching/technical reviews. A
recorded parent-turn boundary intersects the continuing implementation branch.
The request excerpt comes from the user's screenshot; its exact timestamp and
turn binding are unavailable. It provides orientation, not a fabricated edge
on the time axis. Child-local readable outputs retain their own provenance
instead of being presented as decrypted parent-return payloads.

The initial product check was deliberately small: could the reader see the three
branches together, notice the implementation branch continuing across the
parent turn, and find each readable result before opening event detail?
This left out complete conversation reading and failed the user's product
review. Its source evidence remains useful; the following checks describe that
historical prototype, not acceptance of the new reading model.

### Local prototype verification

The ignored artifact is `tmp/runtime-reading-prototype/index.html`, with its
bounded source notes and browser screenshots alongside it. It opens directly
from disk and does not read provider files or contact a server. At 1280×900,
all three work tracks, the two implementation follow-ups, three result excerpts
and the recorded parent reply fit in the initial view.

Luna implemented the prototype; an independent Terra review identified request
provenance, non-proportional axis labeling and child-result/parent-return
separation issues. Main-agent corrections preserve those distinctions. Browser
checks covered 1280/768/320 widths, light/dark themes, canonical branch/source
identity, keyboard follow-up navigation, modal focus, Escape and close-button
return. Narrow layouts use chart-local horizontal scrolling; prose remains
within the page. Governance and TypeScript checks pass via `npm run review`.

At this checkpoint production source remained unchanged. The replacement
prototype must include full available messages in an explicitly bounded case
window; it must not label excerpts or partial coverage as complete history.

## Deferred maintenance

[Issue #1](https://github.com/Guanzhw/AgentSession/issues/1) tracks OS temporary
fixture leaks in tests/SEA smoke. Its later repair includes the user-requested
cleanup of confirmed historical AgentSession leftovers; it does not authorize
deleting unrelated or active temporary files during this UI work.
