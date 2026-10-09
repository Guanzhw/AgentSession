---
status: implemented
date: 2026-09-28
decision: Preserve the established list-stat scopes while keeping richer native observations and correcting unproved activity.
---

# List statistics across 2.0 and 3.0

## Context

The fixed 2.0 list counts a Codex parent's conversation groups, recorded spawn
tasks, and child agent runs; its duration spans projected conversation events.
The 3.0 Reader also shows returned agent envelopes, and its native protocol
records session-turn lifecycles and raw provider events. Applying those richer
facts directly to the old list fields changes their meanings. A synthetic
two-process HTTP oracle found `messageCount` 3 versus 4, `taskCount` 1 versus
unavailable, `subagentRunCount` 1 versus 0, and Pi duration 5,000 versus
120,000 ms. Frozen real Codex and Pi samples show the same classes of drift.

## Decision

The existing list fields retain their 2.0 parent-conversation, delegated-run,
and meaningful-event scopes. Native Reader and Runtime continue to expose
recorded agent returns and session-turn runs. Codex owns the parsing and
verification of spawn calls, child identity, and terminal evidence; Core
projects validated facts into both surfaces. A missing terminal result has
unknown status, not an assertion that work is currently running. Unknown work
coverage remains unavailable in the list.

## Alternatives considered

Counting every native event or run in legacy fields would silently change
their meaning. Replaying the 2.0 parser in Axum would duplicate provider
semantics outside its adapter. Keeping unsupported fields empty would discard
recorded assignments and child activity.

## Consequences

The Codex summary retains a separately named conversation message count
alongside the full native message count. Stored summaries need a schema marker
so unchanged indexed sources recapture this new fact once. A verified child
run can have a child session reference without inventing a turn ID. Browser
labels and documented comparisons must state which scope a count uses.

## Verification

The public synthetic 2.0/v3 HTTP test was run RED before production edits;
its four original deltas and immutable fixture source hashes are checked in
`v3/test/legacy-list-stats-http01.test.mjs`. Six direct HTTP assertions now
pass, including a single canonical Codex message with an earlier native mirror.
Focused Rust tests cover delegated-run counts, meaningful-event duration,
unknown activity coverage, child revision invalidation, and old-summary
recapture. On selected frozen real sessions, Codex's legacy message/task/run
counts are 317/31/0 in both versions and duration is 70,780,605 ms in both;
Pi's message count is 2 and duration 74 ms in both. The old Codex
`activeStatuses: ["running"]` lacked terminal-source proof, so 3.0 reports an
empty known-active set. All checked provider-source hashes remained unchanged.
Rust workspace tests passed (144 core and 2 app, with 13 private tests ignored);
the full Node/browser suite must be repeated on the next exact package after
the remaining HTTP-01 changes.
