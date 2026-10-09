---
status: implemented
date: 2026-09-27
decision: Project recorded DSH compaction summaries as one source-positioned Reader context checkpoint and expose context references through native MCP.
---

# DSH compaction checkpoint

## Context

DSH records `compaction/start`, `compaction/summary`, and `compaction/end` separately. The 3.0 protocol retained these source events, but the Reader omitted the recorded summary. A runtime event could not link to its content, and native MCP rejected `context` Reader references.

## Decision

The DSH adapter creates one `context` Reader item at a `compaction/summary` row when recorded text blocks contain readable text. The item keeps the row's sequence, timestamp, exact concatenated text, and recorded provenance. The summary protocol event is the canonical `context.compaction` event and carries the same Reader reference; start/end remain raw context events without Reader items. Empty or missing summary text creates no Reader content. A summary row still records a context observation with `summaryAvailable: false` when its text is absent.

Native MCP accepts an explicitly selected `context` timeline segment and its event reference through `session_get_event`; the shared bounded content path supplies continuation. This also makes recorded Codex context checkpoints accessible through the same MCP contract.

The Context observation carries the same optional Reader reference as its source protocol event. The shared validator requires any such reference to match that event; the Runtime Context card can open the exact summary without copying its text.

## Alternatives considered

- Copy the summary into protocol metadata: it would bypass the bounded content path and duplicate source text.
- Create checkpoints for start/end or reconstruct a context window: neither carries a recorded summary result.

## Consequences

The Reader outline and Runtime navigation point to one summary at its physical source position. Session message counts exclude the checkpoint. MCP tool input schemas now include `context`; callers must select that segment explicitly for timeline results. Provider sources remain read-only.

## Verification

The [public DSH fixture](../../../v3/fixtures/deepseek-harness-compaction/sessions/public/dsh-v3-compact/session.v3.jsonl) and [focused test](../../../v3/test/dsh-compaction-slice.test.mjs) cover Reader placement, TOC link, exact long content continuation, native MCP identity, and missing summary behavior. Rust tests cover multiple text blocks and an empty summary row. A read-only frozen v3 DSH check found three recorded summary rows and matched their full content and Reader references while preserving source bytes. Commands, binary identity, and broader release checks are recorded in the delivery plan.

Independent review found that a checkpoint in a seeded child's inherited prefix was visible as a preview but `context/body` continuation returned `unsupported inherited content field`. A seeded public child with a long emoji summary reproduced HTTP 400 before the shared inherited-content boundary accepted `context/body`; the same test then passed with exact UTF-16 pagination and owned/inherited separation. The full DSH slice passed 4/4, including the read-only frozen Web check.

A second review found that the Context card reported the summary but offered only raw event JSON. The focused HTTP test first failed because `readerEvent` was absent; after the observation projection was linked and validated, the HTTP/MCP test and browser navigation from Runtime Context to the summary passed 2/2 on the shared debug binary. Final release verification remains part of S4.
