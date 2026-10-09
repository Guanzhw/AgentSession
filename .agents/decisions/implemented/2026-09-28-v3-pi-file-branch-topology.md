---
status: implemented
date: 2026-09-28
decision: Project Pi file-local active and abandoned paths from validated entry ancestry and branch summaries.
---

# Pi file branch topology in 3.0

## Context

The Pi Reader follows the final entry's `parentId` chain, while native protocol
events retain every physical row. A `branch_summary` records `parentId` for the
continuation point and `fromId` for the abandoned path's tip. Protocol `branches`
was empty, so Runtime could not distinguish these paths.

## Decision

The provider emits one derived active branch anchored to the file's selected
head. It emits an abandoned branch only when a recorded `branch_summary.fromId`
can be traced through file-local `parentId` links to its recorded fork point.
Both branches carry exact source-event anchors; a branch head without Reader
content has no invented Reader reference. Unexplained inactive entries keep
branch coverage unknown. The shared validator checks branch IDs and event
anchors. The bounded Runtime graph shows branches under the owning session.

## Alternatives considered

Treating every inactive entry as an abandoned branch would invent fork points
for files without `fromId` evidence. Treating `parentId` as cross-session
lineage would confuse in-file history with Pi's separate `parentSession` header.

## Consequences

Pi declares partial branch support. Protocol v2/v3 include the same branch
facts, and Runtime graph nodes mark active versus abandoned paths. Task,
AgentRun, and cross-session child projections remain separate. A legacy source
with unexplained inactive records reports unknown branch coverage.

## Verification

The public Pi v3 fixture HTTP test failed with empty branches before the
change, then passed with exact fork/head/source anchors and a bounded graph.
The older fixture retains unknown coverage for its unexplained inactive path.
The frozen real Pi source verifies its active head and remains read-only. A
scan of available WSL Pi JSONL files found no native `branch_summary` records;
real abandoned-path verification remains open.
