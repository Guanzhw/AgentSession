# Reader completeness: Stage 3

Status: implementation and real-browser acceptance in progress, updated
2026-09-17. Follows the
[product roadmap](runtime-reading-model.md) and the
[unified reader contract](runtime-reader-slice.md).

## Evidence and acceptance

The first production slice made one session's owned history readable and
opened canonical children in the same reading area. Source and the real Codex
case identified three gaps that drove this implementation:

- Search indexes rendered message-turn text. A recorded tool output has
  27,929 characters, while its initial chunk contains only a prefix. A phrase
  from a later chunk cannot be found before manually loading that chunk.
- Checkpoints render at most 160 summary characters. The examined Codex
  compaction has an empty summary but retains 141 history entries: 102 have
  no encrypted field, while 39 contain an encrypted field omitted by the
  private reader. Those retained records are available
  in the private evidence prototype, not the official reader.
- The same implementation child receives two later messages and has two
  recorded turn completions across parent turns. Completion is separate from
  a recorded delivery to the parent. A single activity span and child link
  do not communicate that sequence.

Inherited background already has separate rendering and continuation scope;
it must remain excluded from the child's owned history and owned search.

The 2026-09-16 acceptance audit found that this previously covered long fields
only within the first 40 inherited messages. The reader now pages the complete
recorded background in batches of 40, including when the parent file is absent.
Late-page field continuation and owned-scope exclusion have focused regression
coverage. The real browser case has four inherited messages: its long-field
continuation and owned-scope exclusion pass, while multi-page inherited
acceptance relies on the 51-message fixture rather than a real local sample.

## A. Search complete owned content

Search the active canonical session's available message, reasoning and tool
content at the server's existing normalized-content boundary. Keep the
current reader and its search controls; do not introduce another transcript
store. Search does not fetch every continuation chunk into the initial DOM.

Provide a bounded read-only search response with the owning message/part,
field and character offset for each match, a short source excerpt, and an
explicit way to continue to later matches. Reuse the same value formatting
and identity as the content endpoint. Inspect only this session's own parts,
not recursive child containers or inherited disclosures. Validate query and
pagination parameters at the HTTP boundary.

Selecting a match reveals its owning recorded content, loading the required
continuation through the existing content route. Preserve already loaded
content. If a query matches source syntax that is absent from rendered
Markdown, retain the source excerpt rather than claiming a visible highlight.
Search status identifies the active history and loading/error/coverage state.
Switching readers invalidates pending search work; returning restores that
reader's query, selected match, disclosure, scroll and focus.

Acceptance: find a phrase beyond the first chunk without manually expanding
the content first; reveal it in a real parent and child; exclude inherited
matches; retain the selected match and reading position after Back.

## B. Read the recorded context-change result

Preserve complete recorded plaintext summaries, with bounded continuation
when needed. At the provider boundary, expose demonstrated readable retained
history for the Codex replacement/guardian record shape and its recorded
source identity. Keep encrypted fields explicitly unavailable. Two real retained
tool outputs also contain image data URLs; preserve their presence and source
paths as metadata-only attachments rather than including their encodings in
plaintext. The shared
reader consumes normalized result content and availability; it must not
interpret Codex raw fields or infer that retained history is the exact next
model request.

Use one checkpoint in its source position. Its disclosure leads with the
available result, followed by source/availability details. Reuse the existing
content renderer and continuation where their contract applies. Keep newly
exposed retained-history bodies out of protocol summary/graph payloads; the
existing normalized `ContextCompactionEvent.summary` contract stays intact.
Any required provider accessor or content-scope extension must have this
reader as its concrete consumer and be recorded in the decision lifecycle.

Acceptance: inspect the real empty-summary checkpoint's readable retained
entries; distinguish omitted encrypted fields from readable fields in the
same entry; preserve position; verify
that expansion neither duplicates owned turns nor pollutes the ToC/search.
Also check a provider that records an ordinary plaintext summary and an
explicit unavailable-result case.

## C. Follow repeated collaboration

Keep one cached reader per canonical child and one navigable child ToC item.
Each recorded dispatch, follow-up and return retains its own event/call/turn
identity. Show these observations on the child's shared-time-axis track,
alongside parent-turn boundaries when the normalized evidence supplies them.
Do not collapse separate interactions into one latest status or infer a
pairing from timestamps alone.

Observation controls reveal the exact existing source anchor; child controls
open the child's full history. Label unknown times explicitly. Every bounded
projection must offer a working path to omitted observations, not a count
without a destination. The default remains continuous history reading with
the compact collaboration view beside it.

Acceptance: in the real case, distinguish both follow-ups and both child-turn
completions on the same child across a parent turn; show result delivery only
where it is separately recorded. Read each available source and return without
losing position. Check dense and untimed tracks, both themes and narrow layouts.
The [coordination reading contract](runtime-reader-coordination.md) specifies
source ownership and bounded continuation.

## Delivery order

1. Fix observed navigation-state regressions and remove unreachable eager
   child rendering. Complete source/tests while service restart is pending.
2. Implement complete owned search with its content identity tests.
3. Implement result-first checkpoint disclosure at the evidence owner.
4. Add repeated-observation navigation and remove superseded UI paths.
5. Run all-provider real-data checks, full tests, browser reading acceptance
   and the combined independent review. Update provider documentation only
   from current evidence. Publish the verified slice with final CI and SHA.

The production preview was rebuilt and restarted on 2026-09-17. Browser checks
below identify the paths actually exercised; they do not imply coverage of
every provider's current schema or user approval of the composition.

## Local provider evidence, 2026-09-14

The existing service returned valid reader fragments for one selected session
from each of the seven installed providers. A bounded follow-up queried 34
catalog session summaries across the five smaller non-OpenCode/non-Codex
catalogs, using at most four concurrent requests. This verifies local evidence
availability, not current-version compatibility or the new SSR layout.

| Provider | Available local runtime-reading evidence | Remaining real-data check |
| --- | --- | --- |
| OpenCode | Owned history, reasoning/tools and a canonical child | Protocol context capability is unsupported; do not infer a context result |
| Claude Code | Eleven readable histories; three stale catalog entries returned explicit missing-session errors | No local sidechain/compaction sample found |
| Codex | Nine task/run branches, repeated coordination, two compactions and child inherited disclosures | Complete retained-result reading and dense/continued coordination navigation |
| OpenClaw | Legacy JSONL history with branch topology | Current SQLite context/goal/spawn sample unavailable locally |
| Hermes | A recorded child/task/run with three async coordination observations | No local compaction sample found |
| Pi | Readable history and recorded branch topology | No local compaction/branch-summary sample found |
| DeepSeek Harness | Multiple child/run cases; recorded compaction and context-version lineage; a direct reader-handler check reads an 8,673-character checkpoint summary through continuation | Artifact records are metadata-only, while normalized compaction events can preserve readable summaries; team coordination remains unverified |

Four DSH catalog entries also returned missing-session errors. These are
catalog/source discrepancies, not proof that the provider is unavailable.
Missing local samples must stay separate from declared adapter support and
fixture coverage in the final acceptance report.

### Earlier source and handler validation

- `npm test`: 585 passed, 0 failed for the integrated Stage 3A/B snapshot.
- A subsequent real-source identity check covers one available history from
  each of the seven providers: all 2,667 nonempty readable fields in those
  samples agree between the selected document and direct reader-tree parts.
  The check also exercises owned search/content handlers and confirms the
  selected source part is present in each reader fragment. A shared `:part`
  versus `:text`/`:tool` mismatch found by this check was corrected before the
  successful rerun.
- Direct built-handler checks find late tool-output text in the real Codex
  parent and child, outside their initial chunks, and exclude inherited-only
  text from the child's owned search.
- All 141 entries at the real Codex checkpoint match their recorded readable
  plaintext: 577,748 characters. The response omits 39 encrypted fields and
  describes two image attachments separately. Eight bounded entry pages reach
  all entries without duplicate identities; long-entry continuation works.
- The DSH summary fallback reads a real 8,673-character summary without a new
  provider accessor. Earlier artifact-only inspection missed this existing
  compaction-event summary; artifact availability is not the result's full
  availability contract.
- Main-agent integration fixes preserve protocol/source failures, scope owned
  continuation to the selected document, and exclude UI headings from selected
  plain-tool occurrence order. Independent review findings were checked against
  source and regression tests. Live acceptance is recorded separately below.

The integrated Stage 3C build passes 599 tests with no failures, plus governance
and type checks. Direct built-handler checks resolve two follow-ups to actual
native tool anchors, two child completions to their own v3 event IDs and clocks,
and 20 result deliveries to distinct recorded scalar event sources. Targeted
independent review found no remaining concrete source blocker. Main-agent
execution boundaries now preserve all 11 events from six real parent runs and
show the child spanning a later parent execution turn without inventing a user
input. Those counts describe their earlier integrated snapshots.

### Production browser acceptance, 2026-09-17

- A real 27,929-character Codex tool output was searched before manually
  loading its continuation. The phrase at offset 3,180 was absent from the
  initial DOM; server search found it and the reader loaded through offset
  6,000, opened the owning field and highlighted the exact match.
- The empty-summary Codex checkpoint exposes all 141 unique retained entries
  through eight pages. Long-entry continuation adds readable content without
  changing owned-message or ToC counts. Encrypted fields remain explicitly
  unavailable and the two image attachments remain metadata-only. Expanded
  content fits a 390 px viewport.
- A real child starts with its inherited background closed. Expanding a long
  inherited field added 11,302 rendered characters without changing the child's
  owned-message or ToC counts. An inherited-only phrase returned zero owned
  search matches. This sample contains four inherited messages; the 40-message
  page boundary is covered by fixtures, not this browser case.
- Both recorded follow-ups reach different exact native tool anchors. Both
  child completions reach their separate scalar event sources in the same
  mounted child while preserving the root. Copying a child source URL exposed
  an owner-route bug; canonical source URL/reload restoration is now covered
  by the corrected navigation path and regression tests.
- The DSH checkpoint's complete 8,673-character source summary is available
  through continuation. At 390 px in the light theme, its plain-text summary
  and continuation wrap within the reading column with unchanged content.
- Inline child search requires an explicit session scope now that parent and
  child stay mounted together. Scope switching, stale-request cancellation and
  close-to-root restoration are covered by the navigation checks.

The option-3 integrated suite passes 704 tests. Complete site-wide E2E passes,
including Usage, Reader search and inline-child navigation, narrow Work
restoration and browser-error checks. The Usage timeout was resolved at its
owner: Codex token aggregation now groups repeated large-parent reads. Seven
installed provider samples pass the real API checks without protocol errors or
warnings. Desktop and narrow-screen child open/reload/close restore the original
canonical opener. These checks establish engineering completeness for this
slice; overall visual/product acceptance remains open.
