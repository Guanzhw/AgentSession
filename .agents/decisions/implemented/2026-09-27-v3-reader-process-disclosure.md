---
status: implemented
date: 2026-09-27
decision: Preserve recorded message phase in the 3.0 Reader model and derive bounded execution-process disclosures without losing source anchors.
---

# AgentSession 3.0 Reader process disclosure

## Context

The accepted [presentation contract](../../../docs/design/runtime-presentation-contract.md)
requires readable requests and replies by default while grouping known intermediate
commentary and tool loops into an expandable execution process (WEB-03 and F08).
The 2.0 Codex adapter recognizes recorded `commentary` and `final_answer`
phases, but the 3.0 Codex normalization currently drops them. The 3.0 Reader
groups tools under their owner but renders every intermediate item as a full
card. The Reader is paged and its Codex projection may be served from a
derived SQLite cache, so a browser-only phase guess would disagree with the
TOC and with already published pages.

## Decision

Normalize only provider-recorded presentation phases at the adapter boundary.
Keep unknown or absent phase unknown. Derive foldability from the complete
owned message sequence in the shared Reader projection: commentary may fold
only when a later recorded final exists in the same user turn; unfinished
commentary stays visible. An assistant message with no body and recorded owned
reasoning or tools can also fold as work, without assigning it a presentation
phase or hiding any readable unknown-phase reply. Preserve canonical event refs, owner relationships,
reasoning, tool content, usage, and source order. Known process items may share
one disclosure only across continuous ordinals without a user request, readable
reply, context checkpoint, error, recorded spawn/result, execution yield, or
execution return.
The TOC and source-location path must use the same classification; a link to
folded content opens its disclosure before focusing the original anchor.
Expose the normalized role and full process count in each bounded TOC entry.
The Reader groups visible TOC entries under recorded user requests, keeps
readable replies as direct child links, and shows each contiguous process as
one collapsed outline entry with its recorded source links inside. A TOC page
that cuts through a process shows its visible step count against the full
count; it does not invent a request at the page boundary.

Changing the serialized Reader item requires a projection-version change so
old derived rows are rebuilt. Provider source revisions must continue to
describe source changes rather than display-only revisions.
For providers using the direct Reader path, use the same presentation projection
and recorded coordination boundaries. If the opening bounded page contains only
folded assistant work, the browser loads one adjacent page without scrolling so
the first readable reply can appear in the initial reading view.

## Alternatives considered

- Fold based on tool presence or text wording: this would hide unknown-phase
  replies and invent provider semantics.
- Infer final from the last loaded page: paging can put a final on the next
  page, changing the meaning of previously displayed commentary.
- Copy items into a separate process list: duplicated source anchors and
  content would break location, search, and usage ownership.

## Consequences

The provider normalization, shared Reader/TOC projection, persisted Reader
item, and Svelte grouping must change together. A known phase can improve the
default reading path without hiding unknown or unfinished text. Source
references remain stable, while old derived Reader rows are rebuilt.

## Verification

[Public API and browser tests](../../../v3/test/reader-process-disclosure.test.mjs)
first failed because recorded phases were absent, then passed 2/2 with a
32-item cross-page process, the F08 trailing-tool plus five-process-message
run, unknown/unfinished text, reasoning and tool ownership, exact source
anchors, TOC, direct location, and search reveal. An old-cache Rust test
confirmed projection version 3 rebuilds prior rows without changing the source
revision. A frozen real Codex long session browser check opened a process from
page one, and its source hash remained unchanged. A real unknown-phase sample
was unavailable; the public fixture covers it.

Integrated browser tests on shared debug SHA-256
`f3330f026ccb7b95cfab51ae3c49d164f48b63c66be03739e5ad01e506b25615`
passed 5/5 across the process fixture, three-level child insertion, and
execution handoff/return after two interaction regressions were repaired.
The recorded spawn and yielded execution events now remain visible boundaries,
so their child control and handoff/unknown-return landmarks are accessible.
The frozen DSH native v3 test was RED with nine empty assistant cards in the
first 32 items. After the direct Reader path reused the projection, the first
45 work items formed one collapsed disclosure. The browser loaded the adjacent
page and showed the first readable reply at ordinal 46 within a 1440x900 viewport;
the source hash remained unchanged. The focused API/browser test passed 2/2.
The follow-up outline test first failed because the TOC lacked role. The
frozen DSH browser then confirmed the opening 45 recorded steps under one
collapsed outline entry and the first readable reply under its request; two
later, distinct processes remain separate. The public Codex process fixture
confirmed that TOC entries carry the full count across Reader segment pages.
The frozen DSH outline also shows a 64/73 continuation on its next bounded
page without adding a synthetic request. A real 1440×900 Chinese browser
check found that helper-generated Assistant/Reasoning headings did not update
when language changed in the mounted Reader. The new browser assertion was
RED on release `d09468dd…`; passing the language as a reactive template
argument made it GREEN on release `01ddb14a…`, with the source hash unchanged.

The 2026-09-29 WEB-03 first-reply regression exposed a transcript whose first
Reader item is readable Codex commentary, followed by its owned tools and a
recorded final beyond the first 32-item page. The source-first message remains
one card ahead of the closed process; its reasoning and tools stay inside that
same turn block's disclosure. The outline lists the message directly and the
remaining process separately. Rust process IDs, source anchors, and complete
counts stay unchanged. The frozen source SHA-256 is
`371da27459fe8ca90ee879ca61f57196edbcd51105dcd2d80ee2d1d0a62a5df1`.
The [real-browser regression](../../../v3/test/ui-first-readable-reply-real.test.mjs)
first failed on the hidden message, then passed against an isolated rebuilt
debug binary: first body visible at 1440×900, one message card, 84 closed
steps with 31 loaded, original tool owner/order and deep links, keyboard
disclosure, next-page continuation, and a later-only deep link that keeps the
84-step total with 21 loaded. Focused process tests passed 7/7;
`npm run review` passed. The browser and server used copied source and isolated
state; the frozen original hash did not change.
