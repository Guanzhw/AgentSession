---
status: implemented
date: 2026-09-27
decision: Search complete owned Reader content per pane with source-bound continuation.
---

# Pane-scoped Reader search

## Context

The 2.0 session detail search checks each owned content field for every
non-overlapping, case-insensitive literal occurrence. The 3.0 indexed session
search uses whitespace-separated AND terms and intentionally excludes tool
payloads, so it cannot satisfy Reader content search or find a hit beyond a
preview. Parent and child Readers have separate source ownership.

## Decision

`GET /api/v3/reader/{provider}/{session_id}/search` accepts `q`, `revision`,
optional `limit` (1–100, default 50), and an opaque `cursor`. After trimming,
`q` must contain 1–500 UTF-16 units. The endpoint searches the normalized
session's complete owned fields: `body` for message, thinking, and context;
`toolInput` and `toolOutput` for tools. Each match carries canonical event and
owner references, Reader ordinal, field, original UTF-16 offset and length,
and a bounded excerpt with its original start and total field length. The
response declares `scope: owned` and `coverage: complete-owned-content`.

Continuation binds source scope, canonical session, revision, and trimmed
query. Source changes fail with `source_changed`; invalid or foreign cursors
fail with `invalid_cursor`. A page gathers at most `limit` matches and probes
one more for continuation, without counting or returning every match at once.
Only an explicit pane search accesses tool payloads; indexed session search
keeps its separate default content policy.

For Codex, the persistent Reader projection now serves search from indexed
item ordinals and SQLite content chunks. It scans one bounded text window at a
time, including chunk-spanning matches and excerpt context, after the exact
source/dependency probe. Its cursor also binds the Reader dependency stamp, so
a verified child-header or task-boundary change invalidates continuation even
when the parent's own source revision is unchanged. Other providers retain the
adapter-backed search path until their Reader projections are implemented.

## Alternatives considered

- Reuse indexed session search: its AND terms, payload policy, and session-level
  result model cannot represent literal field occurrences inside a Reader pane.
- Search loaded previews in the browser: late content and unopened child panes
  would be silently missed.

## Consequences

The UI searches the root or child by that pane's canonical session ID and can
load a match through the existing Reader content API using its UTF-16 offset.
An inline child selection adds its event owner, field, offset, and match length
to the `#child` history entry. The owner is checked against the recorded child
path separately from the path's leaf, so a selected parent-child pane hit is
restored even while a grandchild remains expanded.
There is no total match count, because computing it would require exhaustive
matching for each page. The endpoint does not search copied parent history
excluded by provider ownership normalization.

## Verification

[`v3/test/reader-search-slice.test.mjs`](../../../v3/test/reader-search-slice.test.mjs)
first failed against the missing route, then passed for late and repeated hits,
literal semantics, tool fields, Unicode offsets, parent/child isolation,
copied parent exclusion, query bounds, foreign cursors, and stale revisions.
`cargo test --workspace --locked --offline` passed (70 core tests, 7
explicitly ignored; 2 app tests). Real Axum browser tests cover a late Codex
body, tool output, root/child source isolation, and an old result whose
`/locate` response arrives after the query changes; the latter failed before
the navigation cancellation fix. A frozen-source smoke opened one selected
session in each of the five providers, found a literal from Reader `/content`,
and checked the returned event, field, and offset against `/content`. All ten
frozen source files, including OpenCode DB/WAL/SHM, kept their hashes. Private
evidence and a sanitized aggregate are in ignored
`tmp/v3-pane-search-five-20260927/`. This smoke does not exhaust match
pagination or establish a repeatable latency result.

The Codex cached-search follow-up first made the cross-process parser-count
test fail at two normalizations instead of one in the first process. It then
passed with one first-process normalization and zero on a new process, with the
same canonical hit and complete content. A public 4,094-character prefix tests
chunk-spanning UTF-16 offsets, case expansion, an astral character, excerpt,
and continuation; a child-header rewrite invalidates a parent search cursor.
The focused HTTP pane-search test passes. Large frozen-source no-hit latency
and total resource use remain to be measured with the final build.
The late child selection browser regression was RED on refresh before the URL
carried the selected event and is now GREEN, including a parent-pane hit with
the grandchild expanded. The three-level browser test passes 3/3; the full
pane-search browser suite passes 6/6.
